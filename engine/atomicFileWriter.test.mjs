import * as fileOperations from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeTextAtomically } from './atomicFileWriter.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('writeTextAtomically', () => {
  it('replaces a file only after the temporary contents are flushed', async () => {
    const directory = await createTemporaryDirectory();
    const targetPath = join(directory, 'project.json');
    await writeFile(targetPath, 'old contents', 'utf8');

    const result = await writeTextAtomically(targetPath, 'new contents\n');

    await expect(readFile(targetPath, 'utf8')).resolves.toBe('new contents\n');
    expect(result.bytesWritten).toBe(Buffer.byteLength('new contents\n'));
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves the previous file and removes its temporary file when replacement fails', async () => {
    const directory = await createTemporaryDirectory();
    const targetPath = join(directory, 'project.json');
    await writeFile(targetPath, 'preserved contents', 'utf8');

    await expect(
      writeTextAtomically(targetPath, 'incomplete replacement', {
        fileOperations: {
          mkdir: fileOperations.mkdir,
          open: fileOperations.open,
          rename: async () => {
            throw new Error('Injected replacement failure.');
          },
          rm: fileOperations.rm,
        },
      }),
    ).rejects.toThrow('Injected replacement failure');

    await expect(readFile(targetPath, 'utf8')).resolves.toBe('preserved contents');
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-atomic-write-'));
  temporaryDirectories.add(directory);
  return directory;
}
