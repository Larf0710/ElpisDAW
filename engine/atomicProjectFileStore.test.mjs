import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AtomicProjectFileStore,
  MAX_PROJECT_FILE_BYTES,
  ProjectFileNotFoundError,
  ProjectFileTooLargeError,
  ProjectFileValidationError,
  ProjectRootRequiredError,
} from './atomicProjectFileStore.mjs';
import { ProjectRootAuthority } from './projectRootAuthority.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('AtomicProjectFileStore', () => {
  it('writes a validated HumSTUDIO Project file inside the configured Root', async () => {
    const rootPath = await createTemporaryDirectory();
    const authority = new ProjectRootAuthority();
    const projectRoot = await authority.configure(rootPath);
    const store = new AtomicProjectFileStore({ projectRootAuthority: authority });
    const projectFile = createProjectFile();

    const result = await store.save(projectFile);

    expect(result).toMatchObject({
      projectFileName: projectRoot.projectFileName,
      savedAt: projectFile.savedAt,
      status: 'SAVED',
    });
    await expect(readFile(result.projectFilePath, 'utf8')).resolves.toBe(
      `${JSON.stringify(projectFile, null, 2)}\n`,
    );

    await expect(store.load()).resolves.toMatchObject({
      bytesRead: Buffer.byteLength(`${JSON.stringify(projectFile, null, 2)}\n`, 'utf8'),
      projectFile,
      projectFileName: projectRoot.projectFileName,
      projectFilePath: result.projectFilePath,
      savedAt: projectFile.savedAt,
      status: 'LOADED',
    });
  });

  it('requires a configured Root and rejects malformed Project data before writing', async () => {
    const authority = new ProjectRootAuthority();
    const store = new AtomicProjectFileStore({ projectRootAuthority: authority });

    await expect(store.save(createProjectFile())).rejects.toBeInstanceOf(ProjectRootRequiredError);
    await expect(store.save({ app: 'AnotherApp' })).rejects.toBeInstanceOf(
      ProjectFileValidationError,
    );
    await expect(store.load()).rejects.toBeInstanceOf(ProjectRootRequiredError);
  });

  it('rejects missing, malformed, and unsupported Project JSON before returning data', async () => {
    const rootPath = await createTemporaryDirectory();
    const authority = new ProjectRootAuthority();
    const projectRoot = await authority.configure(rootPath);
    const store = new AtomicProjectFileStore({ projectRootAuthority: authority });

    await expect(store.load()).rejects.toBeInstanceOf(ProjectFileNotFoundError);

    await writeFile(
      join(projectRoot.rootPath, projectRoot.projectFileName),
      '{broken',
      'utf8',
    );
    await expect(store.load()).rejects.toBeInstanceOf(ProjectFileValidationError);

    await writeFile(
      join(projectRoot.rootPath, projectRoot.projectFileName),
      JSON.stringify({ app: 'AnotherApp' }),
      'utf8',
    );
    await expect(store.load()).rejects.toBeInstanceOf(ProjectFileValidationError);

    await writeFile(
      join(projectRoot.rootPath, projectRoot.projectFileName),
      Buffer.alloc(MAX_PROJECT_FILE_BYTES + 1),
    );
    await expect(store.load()).rejects.toBeInstanceOf(ProjectFileTooLargeError);
  });
});

function createProjectFile() {
  return {
    app: 'HumSTUDIO',
    savedAt: '2026-07-23T00:00:00.000Z',
    version: '0.1.0',
    workspace: { project: { name: 'Atomic Song' } },
  };
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-project-file-store-'));
  temporaryDirectories.add(directory);
  return directory;
}
