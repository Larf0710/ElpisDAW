import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GeneratedWaveNormalizationError,
  normalizeGeneratedWaveStagingFile,
} from './generatedWaveNormalizer.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('GeneratedWaveNormalizer', () => {
  it('retains an exact 48 kHz stereo PCM16 staging WAV', async () => {
    const { directory, path } = await createStagingPath();
    const source = createWave({
      channels: 2,
      frames: [[0.25, -0.5], [1, -1]],
      sampleRate: 48_000,
    });
    await writeFile(path, source);

    const result = await normalizeGeneratedWaveStagingFile(path);

    expect(result).toEqual({
      bitsPerSample: 16,
      channels: 2,
      durationSeconds: 2 / 48_000,
      formatTag: 1,
      normalized: false,
      sampleRate: 48_000,
      sha256: sha256(source),
      sizeBytes: source.length,
      source: {
        bitsPerSample: 16,
        channels: 2,
        formatTag: 1,
        sampleRate: 48_000,
      },
    });
    expect(await readFile(path)).toEqual(source);
    expect(await readdir(directory)).toEqual(['artifact.partial']);
  });

  it('resamples 44.1 kHz PCM16 to canonical 48 kHz stereo PCM16', async () => {
    const { directory, path } = await createStagingPath();
    const sourceFrames = Array.from({ length: 441 }, (_, index) => {
      const sample = index / 440 * 2 - 1;
      return [sample, -sample];
    });
    await writeFile(path, createWave({ channels: 2, frames: sourceFrames, sampleRate: 44_100 }));

    const result = await normalizeGeneratedWaveStagingFile(path);
    const normalized = await readFile(path);

    expect(result.normalized).toBe(true);
    expect(result.sampleRate).toBe(48_000);
    expect(result.bitsPerSample).toBe(16);
    expect(result.channels).toBe(2);
    expect(result.sizeBytes).toBe(44 + 480 * 4);
    expect(result.sha256).toBe(sha256(normalized));
    expect(readWaveFormat(normalized)).toEqual({
      bitsPerSample: 16,
      channels: 2,
      dataBytes: 480 * 4,
      formatTag: 1,
      sampleRate: 48_000,
    });
    expect(normalized.readInt16LE(44)).toBe(-32_768);
    expect(normalized.readInt16LE(normalized.length - 4)).toBeGreaterThan(32_000);
    expect(await readdir(directory)).toEqual(['artifact.partial']);
  });

  it('converts 48 kHz IEEE float32 to canonical PCM16 with clipping', async () => {
    const { directory, path } = await createStagingPath();
    await writeFile(path, createWave({
      channels: 2,
      float32: true,
      frames: [[1.5, -1.5], [0.5, -0.25]],
      sampleRate: 48_000,
    }));

    const result = await normalizeGeneratedWaveStagingFile(path);
    const normalized = await readFile(path);

    expect(result.normalized).toBe(true);
    expect(result.source).toEqual({
      bitsPerSample: 32,
      channels: 2,
      formatTag: 3,
      sampleRate: 48_000,
    });
    expect(readWaveFormat(normalized)).toEqual({
      bitsPerSample: 16,
      channels: 2,
      dataBytes: 8,
      formatTag: 1,
      sampleRate: 48_000,
    });
    expect([
      normalized.readInt16LE(44),
      normalized.readInt16LE(46),
      normalized.readInt16LE(48),
      normalized.readInt16LE(50),
    ]).toEqual([32_767, -32_768, 16_384, -8_192]);
    expect(await readdir(directory)).toEqual(['artifact.partial']);
  });

  it('duplicates a mono source into the canonical stereo target', async () => {
    const { path } = await createStagingPath();
    await writeFile(path, createWave({
      channels: 1,
      frames: [[0.25], [-0.5]],
      sampleRate: 48_000,
    }));

    await normalizeGeneratedWaveStagingFile(path);
    const normalized = await readFile(path);

    expect(normalized.readInt16LE(44)).toBe(normalized.readInt16LE(46));
    expect(normalized.readInt16LE(48)).toBe(normalized.readInt16LE(50));
  });

  it('rejects non-finite float samples without replacing the source', async () => {
    const { directory, path } = await createStagingPath();
    const source = createWave({
      channels: 2,
      float32: true,
      frames: [[Number.NaN, 0]],
      sampleRate: 48_000,
    });
    await writeFile(path, source);

    await expect(normalizeGeneratedWaveStagingFile(path)).rejects.toMatchObject({
      code: 'GENERATED_WAVE_SAMPLE_INVALID',
      name: 'GeneratedWaveNormalizationError',
    });
    expect(await readFile(path)).toEqual(source);
    expect(await readdir(directory)).toEqual(['artifact.partial']);
  });

  it('fails closed on unsupported WAVE input', async () => {
    const { path } = await createStagingPath();
    await writeFile(path, Buffer.from('not-a-wave'));

    await expect(normalizeGeneratedWaveStagingFile(path)).rejects.toBeInstanceOf(
      GeneratedWaveNormalizationError,
    );
  });
});

async function createStagingPath() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-wave-normalizer-'));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, 'artifact.partial') };
}

function createWave({ channels, float32 = false, frames, sampleRate }) {
  const bytesPerSample = float32 ? 4 : 2;
  const blockAlign = channels * bytesPerSample;
  const bytes = Buffer.alloc(44 + frames.length * blockAlign);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(float32 ? 3 : 1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(bytesPerSample * 8, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(frames.length * blockAlign, 40);

  frames.forEach((frame, frameIndex) => {
    frame.forEach((sample, channel) => {
      const offset = 44 + frameIndex * blockAlign + channel * bytesPerSample;
      if (float32) {
        bytes.writeFloatLE(sample, offset);
      } else {
        bytes.writeInt16LE(floatToPcm16(sample), offset);
      }
    });
  });
  return bytes;
}

function readWaveFormat(bytes) {
  return {
    bitsPerSample: bytes.readUInt16LE(34),
    channels: bytes.readUInt16LE(22),
    dataBytes: bytes.readUInt32LE(40),
    formatTag: bytes.readUInt16LE(20),
    sampleRate: bytes.readUInt32LE(24),
  };
}

function floatToPcm16(value) {
  if (value <= -1) {
    return -32_768;
  }
  if (value >= 1) {
    return 32_767;
  }
  return Math.round(value * (value < 0 ? 32_768 : 32_767));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
