import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectRootAuthority } from './projectRootAuthority.mjs';
import {
  SourceRestorationService,
  SourceRestorationValidationError,
} from './sourceRestorationService.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('SourceRestorationService', () => {
  it('opens generated Project-relative files and returns an immutable availability snapshot', async () => {
    const { rootPath, service } = await createReadyService();
    const generatedPath = join(rootPath, 'recordings', 'source-generated-a.wav');
    await writeFile(generatedPath, 'generated audio', 'utf8');
    const generatedStat = await stat(generatedPath);

    const restored = await service.restore([
      {
        kind: 'generated',
        lastModified: Math.round(generatedStat.mtimeMs),
        name: 'source-generated-a.wav',
        relativePath: 'recordings/source-generated-a.wav',
        sizeBytes: generatedStat.size,
        sourceId: 'source-generated-a',
      },
    ]);

    expect(restored).toMatchObject({
      availability: { 'source-generated-a': 'available' },
      sources: [
        {
          actual: {
            lastModified: Math.round(generatedStat.mtimeMs),
            name: 'source-generated-a.wav',
            sizeBytes: generatedStat.size,
          },
          kind: 'generated',
          reason: 'available',
          relativePath: 'recordings/source-generated-a.wav',
          resolvedPath: generatedPath,
          sourceId: 'source-generated-a',
          state: 'available',
        },
      ],
    });
    expect(Number.isNaN(Date.parse(restored.checkedAt))).toBe(false);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.availability)).toBe(true);
    expect(Object.isFrozen(restored.sources)).toBe(true);
  });

  it('restores external absolute files without copying them into Project Root', async () => {
    const { rootPath, service } = await createReadyService();
    const externalDirectory = await createTemporaryDirectory('humstudio-external-source-');
    const externalPath = join(externalDirectory, 'outside.wav');
    await writeFile(externalPath, 'external audio', 'utf8');

    const restored = await service.restore([
      { kind: 'external', path: externalPath, sourceId: 'source-external-a' },
    ]);

    expect(restored.sources[0]).toMatchObject({
      kind: 'external',
      path: externalPath,
      reason: 'available',
      resolvedPath: await realpath(externalPath),
      state: 'available',
    });
    expect(restored.sources[0].resolvedPath.startsWith(rootPath)).toBe(false);
  });

  it('distinguishes missing files from metadata mismatches', async () => {
    const { rootPath, service } = await createReadyService();
    const changedPath = join(rootPath, 'renders', 'instruments', 'source-mismatch.wav');
    await writeFile(changedPath, 'changed audio', 'utf8');

    const restored = await service.restore([
      {
        kind: 'generated',
        name: 'source-missing.wav',
        relativePath: 'recordings/source-missing.wav',
        sourceId: 'source-missing',
      },
      {
        kind: 'generated',
        name: 'source-mismatch.wav',
        relativePath: 'renders/instruments/source-mismatch.wav',
        sizeBytes: 1,
        sourceId: 'source-mismatch',
      },
    ]);

    expect(restored.availability).toEqual({
      'source-mismatch': 'unresolved',
      'source-missing': 'missing',
    });
    expect(restored.sources).toEqual([
      expect.objectContaining({ reason: 'missing', state: 'missing' }),
      expect.objectContaining({
        actual: expect.objectContaining({ name: 'source-mismatch.wav' }),
        reason: 'metadata-mismatch',
        state: 'unresolved',
      }),
    ]);
  });

  it('keeps generated files unresolved until Project Root is ready while checking external files', async () => {
    const authority = new ProjectRootAuthority();
    const service = new SourceRestorationService({ projectRootAuthority: authority });
    const externalDirectory = await createTemporaryDirectory('humstudio-external-source-');
    const externalPath = join(externalDirectory, 'outside.wav');
    await writeFile(externalPath, 'external audio', 'utf8');

    const restored = await service.restore([
      {
        kind: 'generated',
        name: 'source-generated.wav',
        relativePath: 'exports/source-generated.wav',
        sourceId: 'source-generated',
      },
      { kind: 'external', path: externalPath, sourceId: 'source-external' },
    ]);

    expect(restored.availability).toEqual({
      'source-external': 'available',
      'source-generated': 'unresolved',
    });
    expect(restored.sources[0]).toMatchObject({
      reason: 'project-root-required',
      state: 'unresolved',
    });
  });

  it('reports directories and other non-regular paths as unopenable', async () => {
    const { service } = await createReadyService();
    const externalDirectory = await createTemporaryDirectory('humstudio-non-file-source-');

    const restored = await service.restore([
      { kind: 'external', path: externalDirectory, sourceId: 'source-directory' },
    ]);

    expect(restored.sources[0]).toMatchObject({
      reason: 'unopenable',
      state: 'unopenable',
    });
  });

  it('rejects duplicate source IDs before touching the filesystem', async () => {
    const { service } = await createReadyService();

    await expect(
      service.restore([
        {
          kind: 'generated',
          name: 'source-duplicate.wav',
          relativePath: 'recordings/source-duplicate.wav',
          sourceId: 'source-duplicate',
        },
        {
          kind: 'generated',
          name: 'source-duplicate.wav',
          relativePath: 'recordings/source-duplicate.wav',
          sourceId: 'source-duplicate',
        },
      ]),
    ).rejects.toBeInstanceOf(SourceRestorationValidationError);
  });

  it('rejects a generated source ID that targets another Artifact canonical WAV', async () => {
    const { rootPath, service } = await createReadyService();
    const canonicalPath = join(rootPath, 'renders', 'instruments', 'artifact-real.wav');
    await writeFile(canonicalPath, 'generated audio', 'utf8');
    const canonicalStat = await stat(canonicalPath);

    await expect(
      service.restore([
        {
          kind: 'generated',
          name: 'artifact-real.wav',
          relativePath: 'renders/instruments/artifact-real.wav',
          sizeBytes: canonicalStat.size,
          sourceId: 'artifact-decoy',
        },
      ]),
    ).rejects.toBeInstanceOf(SourceRestorationValidationError);
  });

  it('rejects traversal, unsupported destinations, staging files, and relative external paths', async () => {
    const { service } = await createReadyService();
    const invalidDescriptors = [
      { kind: 'generated', relativePath: 'recordings/../outside.wav', sourceId: 'traversal' },
      { kind: 'generated', relativePath: 'assets/source.wav', sourceId: 'unsupported' },
      { kind: 'generated', relativePath: 'soundfonts/instrument.sf2', sourceId: 'soundfont' },
      { kind: 'generated', relativePath: 'exports/.output.wav.partial', sourceId: 'staging' },
      { kind: 'external', path: 'relative.wav', sourceId: 'relative-external' },
    ];

    for (const descriptor of invalidDescriptors) {
      await expect(service.restore([descriptor])).rejects.toBeInstanceOf(
        SourceRestorationValidationError,
      );
    }
  });
});

async function createReadyService() {
  const rootPath = await createTemporaryDirectory('humstudio-source-root-');
  const authority = new ProjectRootAuthority();
  const projectRoot = await authority.configure(rootPath);
  return {
    rootPath: projectRoot.rootPath,
    service: new SourceRestorationService({ projectRootAuthority: authority }),
  };
}

async function createTemporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}
