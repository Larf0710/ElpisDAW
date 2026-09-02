import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GENERATED_AUDIO_PROJECT_DIRECTORIES,
  GeneratedAudioReader,
  MAX_GENERATED_AUDIO_AVAILABILITY_SOURCES,
} from './generatedAudioReader.mjs';
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

describe('GeneratedAudioReader', () => {
  it('returns validated generated WAV bytes without exposing the resolved path', async () => {
    const { rootPath, reader } = await createReadyReader();
    const wav = createPcmWav();
    const wavPath = join(
      rootPath,
      'renders',
      'instruments',
      'artifact-instrument-a.wav',
    );
    await writeFile(wavPath, wav);

    const result = await reader.readWav(
      createDescriptor({
        sizeBytes: wav.length,
      }),
    );

    expect(result).toMatchObject({
      contentLength: wav.length,
      contentType: 'audio/wav',
    });
    expect(result.bytes).toEqual(wav);
    expect('resolvedPath' in result).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('allows generated WAVs in each explicitly approved audio Project directory', async () => {
    const { rootPath, reader } = await createReadyReader();
    const wav = createPcmWav();

    for (const [index, directory] of GENERATED_AUDIO_PROJECT_DIRECTORIES.entries()) {
      const sourceId = `artifact-generated-${index}`;
      const name = `${sourceId}.wav`;
      const relativePath = `${directory}/${name}`;
      await writeFile(join(rootPath, ...relativePath.split('/')), wav);

      await expect(
        reader.readWav(
          createDescriptor({
            name,
            relativePath,
            sizeBytes: wav.length,
            sourceId,
          }),
        ),
      ).resolves.toMatchObject({
        contentLength: wav.length,
        contentType: 'audio/wav',
      });
    }
  });

  it('rejects a source ID that does not own the requested WAV before file access', async () => {
    const { rootPath, reader } = await createReadyReader();
    const wav = createPcmWav();
    const descriptor = createDescriptor({
      name: 'artifact-victim.wav',
      relativePath: 'renders/instruments/artifact-victim.wav',
      sizeBytes: wav.length,
      sourceId: 'artifact-decoy',
    });
    const wavPath = join(rootPath, ...descriptor.relativePath.split('/'));
    await writeFile(wavPath, wav);

    await expect(reader.readWav(descriptor)).rejects.toMatchObject({
      code: 'GENERATED_AUDIO_REQUEST_INVALID',
    });
    await expect(
      reader.findAvailableWavSourceIds([descriptor]),
    ).rejects.toMatchObject({ code: 'GENERATED_AUDIO_REQUEST_INVALID' });
    await expect(access(wavPath)).resolves.toBeUndefined();
  });

  it('requires a ready Project Root before resolving generated files', async () => {
    const reader = new GeneratedAudioReader({
      projectRootAuthority: new ProjectRootAuthority(),
    });

    await expect(reader.readWav(createDescriptor())).rejects.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });
  });

  it('rejects external, non-normalized, unsupported, staging, and non-WAV descriptors', async () => {
    const { reader } = await createReadyReader();
    const invalidDescriptors = [
      { ...createDescriptor(), kind: 'external', path: 'C:\\outside.wav' },
      createDescriptor({ relativePath: 'renders/instruments/../outside.wav' }),
      createDescriptor({ relativePath: 'renders\\instruments\\instrument-a.wav' }),
      createDescriptor({ relativePath: 'assets/instrument-a.wav' }),
      createDescriptor({
        name: 'instrument-a.wav.partial',
        relativePath: 'renders/instruments/instrument-a.wav.partial',
      }),
      createDescriptor({
        name: 'instrument-a.mp3',
        relativePath: 'renders/instruments/instrument-a.mp3',
      }),
    ];

    for (const descriptor of invalidDescriptors) {
      await expect(reader.readWav(descriptor)).rejects.toMatchObject({
        code: 'GENERATED_AUDIO_REQUEST_INVALID',
      });
    }
  });

  it('distinguishes missing, unopenable, metadata-mismatched, and invalid WAV files', async () => {
    const { rootPath, reader } = await createReadyReader();
    const wav = createPcmWav();
    const mismatchPath = join(
      rootPath,
      'renders',
      'instruments',
      'artifact-mismatch.wav',
    );
    const invalidPath = join(
      rootPath,
      'renders',
      'instruments',
      'artifact-invalid.wav',
    );
    const directoryPath = join(
      rootPath,
      'renders',
      'instruments',
      'artifact-directory.wav',
    );
    await writeFile(mismatchPath, wav);
    await writeFile(invalidPath, Buffer.alloc(wav.length));
    await mkdir(directoryPath);

    const cases = [
      [
        createDescriptor({
          sizeBytes: wav.length,
          sourceId: 'artifact-missing',
        }),
        'GENERATED_AUDIO_NOT_FOUND',
      ],
      [
        createDescriptor({
          sizeBytes: wav.length,
          sourceId: 'artifact-directory',
        }),
        'GENERATED_AUDIO_UNOPENABLE',
      ],
      [
        createDescriptor({
          sizeBytes: wav.length + 1,
          sourceId: 'artifact-mismatch',
        }),
        'GENERATED_AUDIO_METADATA_MISMATCH',
      ],
      [
        createDescriptor({
          sizeBytes: wav.length,
          sourceId: 'artifact-invalid',
        }),
        'GENERATED_AUDIO_WAV_INVALID',
      ],
    ];

    for (const [descriptor, code] of cases) {
      await expect(reader.readWav(descriptor)).rejects.toMatchObject({
        code,
      });
    }
  });

  it('rejects a generated path whose canonical target escapes Project Root', async () => {
    const { rootPath, reader } = await createReadyReader();
    const outsideDirectory = await createTemporaryDirectory(
      'humstudio-generated-audio-outside-',
    );
    const wav = createPcmWav();
    await writeFile(join(outsideDirectory, 'artifact-escaped.wav'), wav);
    await symlink(
      outsideDirectory,
      join(rootPath, 'renders', 'instruments', 'linked'),
      'junction',
    );

    await expect(
      reader.readWav(
        createDescriptor({
          name: 'artifact-escaped.wav',
          relativePath: 'renders/instruments/linked/artifact-escaped.wav',
          sizeBytes: wav.length,
          sourceId: 'artifact-escaped',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'GENERATED_AUDIO_OUTSIDE_PROJECT_ROOT',
    });
  });

  it('returns only available generated WAV source IDs from a batch', async () => {
    const { rootPath, reader } = await createReadyReader();
    const wav = createPcmWav();
    await writeFile(
      join(rootPath, 'renders', 'instruments', 'artifact-available.wav'),
      wav,
    );
    await writeFile(
      join(rootPath, 'renders', 'instruments', 'artifact-invalid.wav'),
      Buffer.alloc(wav.length),
    );

    const sourceIds = await reader.findAvailableWavSourceIds([
      createDescriptor({
        sourceId: 'artifact-missing',
      }),
      createDescriptor({
        sourceId: 'artifact-available',
      }),
      createDescriptor({
        sourceId: 'artifact-invalid',
      }),
    ]);

    expect(sourceIds).toEqual(['artifact-available']);
    expect(Object.isFrozen(sourceIds)).toBe(true);
  });

  it('rejects invalid, duplicate, oversized, and rootless availability batches', async () => {
    const { reader } = await createReadyReader();
    const duplicate = createDescriptor({ sourceId: 'artifact-duplicate' });

    await expect(
      reader.findAvailableWavSourceIds([duplicate, { ...duplicate }]),
    ).rejects.toMatchObject({
      code: 'GENERATED_AUDIO_REQUEST_INVALID',
    });
    await expect(
      reader.findAvailableWavSourceIds(
        Array.from(
          { length: MAX_GENERATED_AUDIO_AVAILABILITY_SOURCES + 1 },
          (_, index) => createDescriptor({ sourceId: `artifact-${index}` }),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'GENERATED_AUDIO_REQUEST_INVALID',
    });
    await expect(
      reader.findAvailableWavSourceIds([
        createDescriptor({ relativePath: '../outside.wav' }),
      ]),
    ).rejects.toMatchObject({
      code: 'GENERATED_AUDIO_REQUEST_INVALID',
    });

    const rootlessReader = new GeneratedAudioReader({
      projectRootAuthority: new ProjectRootAuthority(),
    });

    await expect(
      rootlessReader.findAvailableWavSourceIds([]),
    ).rejects.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });
  });
});

async function createReadyReader() {
  const rootPath = await createTemporaryDirectory('humstudio-generated-audio-root-');
  const projectRootAuthority = new ProjectRootAuthority();
  const projectRoot = await projectRootAuthority.configure(rootPath);

  return {
    reader: new GeneratedAudioReader({ projectRootAuthority }),
    rootPath: projectRoot.rootPath,
  };
}

function createDescriptor(overrides = {}) {
  const sourceId = overrides.sourceId ?? 'artifact-instrument-a';
  const name = overrides.name ?? `${sourceId}.wav`;

  return {
    kind: 'generated',
    name,
    relativePath:
      overrides.relativePath ?? `renders/instruments/${name}`,
    sizeBytes: createPcmWav().length,
    sourceId,
    ...overrides,
  };
}

function createPcmWav() {
  const wav = Buffer.alloc(48);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24);
  wav.writeUInt32LE(16_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(4, 40);

  return wav;
}

async function createTemporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}
