import { afterEach, describe, expect, it } from 'vitest';
import {
  access,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AUDIO_FILE_DELETE_PROJECT_DIRECTORIES,
  AudioArtifactFileDeleter,
} from './audioArtifactFileDeleter.mjs';
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

describe('AudioArtifactFileDeleter', () => {
  it('deletes one validated generated WAV without exposing an absolute path', async () => {
    const fixture = await createReadyFixture();
    const descriptor = await writeArtifact(
      fixture.rootPath,
      'renders/instruments',
      'artifact-instrument-take',
      'generated',
    );

    const result = await fixture.deleter.deleteWav(descriptor);

    expect(result).toEqual({
      ...descriptor,
      status: 'DELETED',
    });
    expect(JSON.stringify(result)).not.toContain(fixture.rootPath);
    await expect(access(join(fixture.rootPath, ...descriptor.relativePath.split('/'))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts each explicit Project audio directory with matching storageKind', async () => {
    for (const directory of AUDIO_FILE_DELETE_PROJECT_DIRECTORIES) {
      const fixture = await createReadyFixture();
      const storageKind = directory === 'recordings' ? 'recording' : 'generated';
      const descriptor = await writeArtifact(
        fixture.rootPath,
        directory,
        `artifact-${directory.replaceAll('/', '-')}`,
        storageKind,
      );

      await expect(fixture.deleter.deleteWav(descriptor)).resolves.toMatchObject({
        relativePath: descriptor.relativePath,
        status: 'DELETED',
        storageKind,
      });
    }
  });

  it('rejects an Artifact ID that does not own the requested WAV and preserves the file', async () => {
    const fixture = await createReadyFixture();
    const descriptor = await writeArtifact(
      fixture.rootPath,
      'renders/instruments',
      'artifact-victim',
      'generated',
    );

    await expect(
      fixture.deleter.deleteWav({
        ...descriptor,
        artifactId: 'artifact-decoy',
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_FILE_DELETE_REQUEST_INVALID' });
    await expect(
      access(join(fixture.rootPath, ...descriptor.relativePath.split('/'))),
    ).resolves.toBeUndefined();
  });

  it('requires a ready Project Root', async () => {
    const deleter = new AudioArtifactFileDeleter({
      projectRootAuthority: new ProjectRootAuthority(),
    });

    await expect(deleter.deleteWav(createDescriptor())).rejects.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });
  });

  it('rejects malformed paths, unsupported directories, and storage mismatches', async () => {
    const fixture = await createReadyFixture();
    const descriptor = createDescriptor();

    await expect(
      fixture.deleter.deleteWav({
        ...descriptor,
        relativePath: 'renders/instruments/../take.wav',
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_FILE_DELETE_REQUEST_INVALID' });
    await expect(
      fixture.deleter.deleteWav({
        ...descriptor,
        relativePath: 'models/take.wav',
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_FILE_DELETE_REQUEST_INVALID' });
    await expect(
      fixture.deleter.deleteWav({
        ...descriptor,
        relativePath: 'recordings/take.wav',
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_FILE_DELETE_REQUEST_INVALID' });
  });

  it('preserves files when metadata or RIFF/WAVE validation fails', async () => {
    const fixture = await createReadyFixture();
    const descriptor = await writeArtifact(
      fixture.rootPath,
      'renders/instruments',
      'artifact-changed',
      'generated',
    );
    const invalidPath = join(
      fixture.rootPath,
      'renders',
      'instruments',
      'artifact-invalid.wav',
    );
    const invalidBytes = Buffer.alloc(64);
    await writeFile(invalidPath, invalidBytes);

    await expect(
      fixture.deleter.deleteWav({
        ...descriptor,
        sizeBytes: descriptor.sizeBytes + 1,
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_FILE_DELETE_METADATA_MISMATCH' });
    await expect(
      fixture.deleter.deleteWav({
        ...descriptor,
        artifactId: 'artifact-invalid',
        name: 'artifact-invalid.wav',
        relativePath: 'renders/instruments/artifact-invalid.wav',
        sizeBytes: invalidBytes.length,
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_FILE_DELETE_WAV_INVALID' });

    await expect(access(join(fixture.rootPath, ...descriptor.relativePath.split('/'))))
      .resolves.toBeUndefined();
    await expect(access(invalidPath)).resolves.toBeUndefined();
  });

  it('rejects symbolic-link targets even when they remain inside Project Root', async () => {
    const fixture = await createReadyFixture();
    const descriptor = await writeArtifact(
      fixture.rootPath,
      'renders/instruments',
      'artifact-target',
      'generated',
    );
    const linkPath = join(
      fixture.rootPath,
      'renders',
      'instruments',
      'artifact-linked.wav',
    );

    try {
      await symlink(
        join(fixture.rootPath, ...descriptor.relativePath.split('/')),
        linkPath,
        'file',
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        return;
      }

      throw error;
    }

    await expect(
      fixture.deleter.deleteWav({
        ...descriptor,
        artifactId: 'artifact-linked',
        name: 'artifact-linked.wav',
        relativePath: 'renders/instruments/artifact-linked.wav',
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_FILE_DELETE_UNOPENABLE' });
    await expect(access(linkPath)).resolves.toBeUndefined();
  });
});

async function createReadyFixture() {
  const rootPath = await mkdtemp(join(tmpdir(), 'humstudio-audio-delete-root-'));
  temporaryDirectories.add(rootPath);
  const projectRootAuthority = new ProjectRootAuthority();
  await projectRootAuthority.configure(rootPath);

  return {
    deleter: new AudioArtifactFileDeleter({ projectRootAuthority }),
    rootPath,
  };
}

async function writeArtifact(rootPath, relativeDirectory, artifactId, storageKind) {
  const bytes = createPcmWav();
  const relativePath = `${relativeDirectory}/${artifactId}.wav`;
  const absolutePath = join(rootPath, ...relativePath.split('/'));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);

  return createDescriptor({
    artifactId,
    name: `${artifactId}.wav`,
    relativePath,
    sizeBytes: bytes.length,
    storageKind,
  });
}

function createDescriptor(overrides = {}) {
  return {
    artifactId: 'artifact-generated',
    extension: '.wav',
    name: 'artifact-generated.wav',
    relativePath: 'renders/instruments/artifact-generated.wav',
    sizeBytes: createPcmWav().length,
    storageKind: 'generated',
    ...overrides,
  };
}

function createPcmWav() {
  const wav = Buffer.alloc(64);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  return wav;
}
