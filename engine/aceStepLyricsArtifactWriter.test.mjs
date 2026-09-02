import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AceStepLyricsArtifactWriter,
  AceStepLyricsValidationError,
  MAX_ACE_STEP_LYRICS_CHARACTERS,
  validateAceStepLyrics,
} from './aceStepLyricsArtifactWriter.mjs';
import { GeneratedArtifactFinalizer } from './generatedArtifactFinalizer.mjs';
import { ProjectRootAuthority } from './projectRootAuthority.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('AceStepLyricsArtifactWriter', () => {
  it('atomically finalizes one exact BOM-less UTF-8 Lyrics snapshot', async () => {
    const rootPath = await createTemporaryDirectory();
    const projectRootAuthority = new ProjectRootAuthority();
    await projectRootAuthority.configure(rootPath);
    const generatedArtifactFinalizer = new GeneratedArtifactFinalizer({
      projectRootAuthority,
    });
    const writer = new AceStepLyricsArtifactWriter({
      generatedArtifactFinalizer,
    });
    const lyrics = '[Verse]\n春の光が窓を照らす\nA quiet pulse becomes a tune\n';
    const bytes = Buffer.from(lyrics, 'utf8');

    const artifact = await writer.saveLyrics(lyrics);

    expect(artifact).toMatchObject({
      destination: 'ace-step-lyrics',
      file: {
        extension: '.txt',
        relativePath: expect.stringMatching(
          /^renders\/ace-step\/lyrics\/artifact-[0-9a-f-]+\.txt$/,
        ),
        sizeBytes: bytes.length,
      },
      kind: 'lyrics',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      status: 'FINALIZED',
    });
    await expect(
      readFile(join(rootPath, ...artifact.file.relativePath.split('/'))),
    ).resolves.toEqual(bytes);
    await expect(
      readdir(join(rootPath, 'renders', 'ace-step', 'lyrics')),
    ).resolves.toEqual([artifact.file.name]);
    expect(generatedArtifactFinalizer.getActiveReservationCount()).toBe(0);
  });

  it('requires a configured Project Root before reserving a snapshot', async () => {
    const projectRootAuthority = new ProjectRootAuthority();
    const generatedArtifactFinalizer = new GeneratedArtifactFinalizer({
      projectRootAuthority,
    });
    const writer = new AceStepLyricsArtifactWriter({
      generatedArtifactFinalizer,
    });

    await expect(writer.saveLyrics('[Verse]\nHello')).rejects.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });
    expect(generatedArtifactFinalizer.getActiveReservationCount()).toBe(0);
  });

  it('rejects empty, BOM-prefixed, NUL-containing, and oversized Lyrics', () => {
    for (const invalid of [
      '',
      '   \n',
      '\ufeff[Verse]\nHello',
      '[Verse]\0Hello',
      'a'.repeat(MAX_ACE_STEP_LYRICS_CHARACTERS + 1),
    ]) {
      expect(() => validateAceStepLyrics(invalid)).toThrow(
        AceStepLyricsValidationError,
      );
    }
  });

  it('rejects text that cannot round-trip through UTF-8', () => {
    expect(() => validateAceStepLyrics('\ud800')).toThrow('valid UTF-8');
  });
});

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-ace-step-lyrics-'));
  temporaryDirectories.add(directory);
  return directory;
}
