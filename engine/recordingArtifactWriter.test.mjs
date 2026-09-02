import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GeneratedArtifactFinalizer } from './generatedArtifactFinalizer.mjs';
import { ProjectRootAuthority } from './projectRootAuthority.mjs';
import {
  inspectRecordingWav,
  RecordingArtifactWriter,
  RecordingWavValidationError,
} from './recordingArtifactWriter.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('RecordingArtifactWriter', () => {
  it('validates and atomically finalizes one mono 16-bit PCM recording', async () => {
    const rootPath = await createTemporaryDirectory();
    const projectRootAuthority = new ProjectRootAuthority();
    await projectRootAuthority.configure(rootPath);
    const generatedArtifactFinalizer = new GeneratedArtifactFinalizer({
      projectRootAuthority,
    });
    const writer = new RecordingArtifactWriter({ generatedArtifactFinalizer });
    const wav = createPcmWav({ durationSeconds: 0.25, sampleRate: 8_000 });

    const artifact = await writer.saveWav(wav);

    expect(artifact).toMatchObject({
      audio: {
        bitsPerSample: 16,
        channels: 1,
        durationSeconds: 0.25,
        mimeType: 'audio/wav',
        sampleRate: 8_000,
      },
      destination: 'recording',
      file: {
        extension: '.wav',
        relativePath: expect.stringMatching(/^recordings\/artifact-[0-9a-f-]+\.wav$/),
        sizeBytes: wav.length,
      },
      kind: 'audio',
      status: 'FINALIZED',
    });
    await expect(
      readFile(join(rootPath, ...artifact.file.relativePath.split('/'))),
    ).resolves.toEqual(wav);
    expect(generatedArtifactFinalizer.getActiveReservationCount()).toBe(0);
  });

  it('requires a configured Project Root before creating a staging file', async () => {
    const projectRootAuthority = new ProjectRootAuthority();
    const generatedArtifactFinalizer = new GeneratedArtifactFinalizer({
      projectRootAuthority,
    });
    const writer = new RecordingArtifactWriter({ generatedArtifactFinalizer });

    await expect(writer.saveWav(createPcmWav())).rejects.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });
    expect(generatedArtifactFinalizer.getActiveReservationCount()).toBe(0);
  });

  it('accepts stereo PIPO output and rejects malformed channel layouts and non-16-bit input', () => {
    expect(() => inspectRecordingWav(Buffer.alloc(44))).toThrow(
      RecordingWavValidationError,
    );
    expect(inspectRecordingWav(createPcmWav({ channels: 2 }))).toMatchObject({
      bitsPerSample: 16,
      channels: 2,
    });
    expect(() => inspectRecordingWav(createPcmWav({ channels: 3 }))).toThrow(
      'mono or stereo',
    );
    expect(() => inspectRecordingWav(createPcmWav({ bitsPerSample: 8 }))).toThrow(
      '16-bit PCM',
    );
  });

  it('does not leave staging files when validation fails', async () => {
    const rootPath = await createTemporaryDirectory();
    const projectRootAuthority = new ProjectRootAuthority();
    await projectRootAuthority.configure(rootPath);
    const generatedArtifactFinalizer = new GeneratedArtifactFinalizer({
      projectRootAuthority,
    });
    const writer = new RecordingArtifactWriter({ generatedArtifactFinalizer });

    await expect(writer.saveWav(Buffer.from('not a WAV'))).rejects.toThrow(
      RecordingWavValidationError,
    );
    await expect(readdir(join(rootPath, 'recordings'))).resolves.toEqual([]);
    expect(generatedArtifactFinalizer.getActiveReservationCount()).toBe(0);
  });
});

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-recording-artifact-'));
  temporaryDirectories.add(directory);
  return directory;
}

function createPcmWav({
  bitsPerSample = 16,
  channels = 1,
  durationSeconds = 0.1,
  sampleRate = 8_000,
} = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataByteLength = frameCount * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataByteLength);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataByteLength, 40);

  return wav;
}
