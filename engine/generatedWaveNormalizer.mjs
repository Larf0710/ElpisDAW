import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, rename, rm } from 'node:fs/promises';

import { MAX_GENERATED_WAV_BYTES } from './generatedAudioReader.mjs';
import { HUMSTUDIO_AUDIO_FORMAT } from '../shared/humStudioAudioFormat.js';

export const GENERATED_WAVE_TARGET_FORMAT = Object.freeze({
  ...HUMSTUDIO_AUDIO_FORMAT,
  formatTag: 1,
});

const PCM_WAVE_HEADER_BYTES = 44;
const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const MAX_WAVE_HEADER_BYTES = 1024 * 1024;
const OUTPUT_BLOCK_FRAMES = 16_384;
const HASH_BUFFER_BYTES = 8 * 1024 * 1024;

export class GeneratedWaveNormalizationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'GeneratedWaveNormalizationError';
  }
}

export async function normalizeGeneratedWaveStagingFile(
  stagingPath,
  { signal } = {},
) {
  assertStagingPath(stagingPath);
  throwIfAborted(signal);

  const stagingStat = await lstat(stagingPath);

  if (
    !stagingStat.isFile() ||
    stagingStat.isSymbolicLink() ||
    stagingStat.size <= PCM_WAVE_HEADER_BYTES ||
    stagingStat.size > MAX_GENERATED_WAV_BYTES
  ) {
    throw invalidSource();
  }

  const sourceHandle = await open(stagingPath, 'r');
  let source;

  try {
    const headerLength = Math.min(stagingStat.size, MAX_WAVE_HEADER_BYTES);
    const header = Buffer.allocUnsafe(headerLength);
    await readExactly(sourceHandle, header, 0);
    source = inspectSupportedWave(header, stagingStat.size);

    if (isTargetFormat(source)) {
      const sha256 = await hashOpenFile(sourceHandle, stagingStat.size, signal);
      return createEvidence(source, stagingStat.size, sha256, false);
    }

    return await normalizeToTarget(
      stagingPath,
      sourceHandle,
      source,
      signal,
    );
  } finally {
    if (sourceHandle.fd !== -1) {
      await sourceHandle.close().catch(() => undefined);
    }
  }
}

async function normalizeToTarget(stagingPath, sourceHandle, source, signal) {
  const targetFrameCount = Math.max(
    1,
    Math.round(
      source.frameCount *
        GENERATED_WAVE_TARGET_FORMAT.sampleRate /
        source.sampleRate,
    ),
  );
  const targetSizeBytes = PCM_WAVE_HEADER_BYTES + targetFrameCount * 4;

  if (
    !Number.isSafeInteger(targetSizeBytes) ||
    targetSizeBytes > MAX_GENERATED_WAV_BYTES ||
    targetSizeBytes - 8 > 0xffff_ffff
  ) {
    throw new GeneratedWaveNormalizationError(
      'GENERATED_WAVE_TARGET_TOO_LARGE',
      'Generated WAV normalization would exceed the safe artifact size.',
    );
  }

  const operationId = randomUUID();
  const normalizedPath = `${stagingPath}.${operationId}.normalized.partial`;
  const sourceBackupPath = `${stagingPath}.${operationId}.source.partial`;
  const targetHandle = await open(normalizedPath, 'wx', 0o600);
  const digest = createHash('sha256');
  let targetPosition = 0;
  let sourceMoved = false;
  let normalizedInstalled = false;

  try {
    const header = createTargetWaveHeader(targetFrameCount);
    await writeExactly(targetHandle, header, targetPosition);
    digest.update(header);
    targetPosition += header.length;

    const sourceFrameStep =
      source.sampleRate / GENERATED_WAVE_TARGET_FORMAT.sampleRate;

    for (
      let targetStartFrame = 0;
      targetStartFrame < targetFrameCount;
      targetStartFrame += OUTPUT_BLOCK_FRAMES
    ) {
      throwIfAborted(signal);
      const blockFrameCount = Math.min(
        OUTPUT_BLOCK_FRAMES,
        targetFrameCount - targetStartFrame,
      );
      const firstSourcePosition = targetStartFrame * sourceFrameStep;
      const lastSourcePosition =
        (targetStartFrame + blockFrameCount - 1) * sourceFrameStep;
      const sourceStartFrame = Math.min(
        source.frameCount - 1,
        Math.max(0, Math.floor(firstSourcePosition)),
      );
      const sourceEndFrame = Math.min(
        source.frameCount - 1,
        Math.floor(lastSourcePosition) + 1,
      );
      const sourceFrameCount = sourceEndFrame - sourceStartFrame + 1;
      const sourceBytes = Buffer.allocUnsafe(
        sourceFrameCount * source.blockAlign,
      );
      await readExactly(
        sourceHandle,
        sourceBytes,
        source.dataOffset + sourceStartFrame * source.blockAlign,
      );

      const targetBytes = Buffer.allocUnsafe(blockFrameCount * 4);

      for (let frame = 0; frame < blockFrameCount; frame += 1) {
        const targetFrame = targetStartFrame + frame;
        const sourcePosition = Math.min(
          source.frameCount - 1,
          targetFrame * sourceFrameStep,
        );
        const lowerFrame = Math.floor(sourcePosition);
        const upperFrame = Math.min(source.frameCount - 1, lowerFrame + 1);
        const fraction = sourcePosition - lowerFrame;

        for (let channel = 0; channel < 2; channel += 1) {
          const sourceChannel = source.channels === 1 ? 0 : channel;
          const lower = readSourceSample(
            sourceBytes,
            source,
            lowerFrame - sourceStartFrame,
            sourceChannel,
          );
          const upper = readSourceSample(
            sourceBytes,
            source,
            upperFrame - sourceStartFrame,
            sourceChannel,
          );
          targetBytes.writeInt16LE(
            floatToPcm16(lower + (upper - lower) * fraction),
            frame * 4 + channel * 2,
          );
        }
      }

      await writeExactly(targetHandle, targetBytes, targetPosition);
      digest.update(targetBytes);
      targetPosition += targetBytes.length;
    }

    throwIfAborted(signal);
    await targetHandle.sync();
    await targetHandle.close();
    await sourceHandle.close();

    await rename(stagingPath, sourceBackupPath);
    sourceMoved = true;

    try {
      await rename(normalizedPath, stagingPath);
      normalizedInstalled = true;
    } catch (error) {
      await rename(sourceBackupPath, stagingPath);
      sourceMoved = false;
      throw error;
    }

    await rm(sourceBackupPath, { force: true });
    sourceMoved = false;

    return Object.freeze({
      bitsPerSample: GENERATED_WAVE_TARGET_FORMAT.bitsPerSample,
      channels: GENERATED_WAVE_TARGET_FORMAT.channels,
      durationSeconds:
        targetFrameCount / GENERATED_WAVE_TARGET_FORMAT.sampleRate,
      formatTag: GENERATED_WAVE_TARGET_FORMAT.formatTag,
      normalized: true,
      sampleRate: GENERATED_WAVE_TARGET_FORMAT.sampleRate,
      sha256: digest.digest('hex'),
      sizeBytes: targetSizeBytes,
      source: createSourceFormatEvidence(source),
    });
  } catch (error) {
    if (error instanceof GeneratedWaveNormalizationError) {
      throw error;
    }

    throw new GeneratedWaveNormalizationError(
      'GENERATED_WAVE_NORMALIZATION_FAILED',
      'Generated WAV could not be normalized to 48 kHz stereo PCM16.',
      { cause: error },
    );
  } finally {
    if (targetHandle.fd !== -1) {
      await targetHandle.close().catch(() => undefined);
    }

    if (sourceMoved && !normalizedInstalled) {
      await rename(sourceBackupPath, stagingPath).catch(() => undefined);
    }

    if (!normalizedInstalled) {
      await rm(normalizedPath, { force: true }).catch(() => undefined);
    }

    if (normalizedInstalled || !sourceMoved) {
      await rm(sourceBackupPath, { force: true }).catch(() => undefined);
    }
  }
}

function inspectSupportedWave(header, fileSize) {
  if (
    header.length < PCM_WAVE_HEADER_BYTES ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE' ||
    header.readUInt32LE(4) + 8 !== fileSize
  ) {
    throw invalidSource();
  }

  let format;
  let data;
  let offset = RIFF_HEADER_BYTES;

  while (offset + CHUNK_HEADER_BYTES <= header.length) {
    const chunkId = header.toString('ascii', offset, offset + 4);
    const chunkSize = header.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + CHUNK_HEADER_BYTES;
    const paddedChunkEnd = chunkDataOffset + chunkSize + (chunkSize % 2);

    if (paddedChunkEnd > fileSize) {
      throw invalidSource();
    }

    if (chunkId === 'fmt ') {
      if (format || chunkSize < 16 || chunkDataOffset + 16 > header.length) {
        throw invalidSource();
      }

      format = {
        bitsPerSample: header.readUInt16LE(chunkDataOffset + 14),
        blockAlign: header.readUInt16LE(chunkDataOffset + 12),
        byteRate: header.readUInt32LE(chunkDataOffset + 8),
        channels: header.readUInt16LE(chunkDataOffset + 2),
        formatTag: header.readUInt16LE(chunkDataOffset),
        sampleRate: header.readUInt32LE(chunkDataOffset + 4),
      };
    } else if (chunkId === 'data') {
      if (data || chunkSize === 0) {
        throw invalidSource();
      }
      data = { byteLength: chunkSize, offset: chunkDataOffset };
    }

    if (format && data) {
      break;
    }

    if (paddedChunkEnd > header.length) {
      throw invalidSource();
    }
    offset = paddedChunkEnd;
  }

  const bytesPerSample = format ? format.bitsPerSample / 8 : 0;

  if (
    !format ||
    !data ||
    (format.channels !== 1 && format.channels !== 2) ||
    format.sampleRate < 8_000 ||
    format.sampleRate > 192_000 ||
    !(
      (format.formatTag === 1 && format.bitsPerSample === 16) ||
      (format.formatTag === 3 && format.bitsPerSample === 32)
    ) ||
    format.blockAlign !== format.channels * bytesPerSample ||
    format.byteRate !== format.sampleRate * format.blockAlign ||
    data.offset + data.byteLength > fileSize ||
    data.byteLength % format.blockAlign !== 0
  ) {
    throw invalidSource();
  }

  return Object.freeze({
    bitsPerSample: format.bitsPerSample,
    blockAlign: format.blockAlign,
    channels: format.channels,
    dataOffset: data.offset,
    formatTag: format.formatTag,
    frameCount: data.byteLength / format.blockAlign,
    sampleRate: format.sampleRate,
  });
}

function isTargetFormat(source) {
  return (
    source.formatTag === GENERATED_WAVE_TARGET_FORMAT.formatTag &&
    source.bitsPerSample === GENERATED_WAVE_TARGET_FORMAT.bitsPerSample &&
    source.channels === GENERATED_WAVE_TARGET_FORMAT.channels &&
    source.sampleRate === GENERATED_WAVE_TARGET_FORMAT.sampleRate
  );
}

function createEvidence(source, sizeBytes, sha256, normalized) {
  return Object.freeze({
    bitsPerSample: source.bitsPerSample,
    channels: source.channels,
    durationSeconds: source.frameCount / source.sampleRate,
    formatTag: source.formatTag,
    normalized,
    sampleRate: source.sampleRate,
    sha256,
    sizeBytes,
    source: createSourceFormatEvidence(source),
  });
}

function createSourceFormatEvidence(source) {
  return Object.freeze({
    bitsPerSample: source.bitsPerSample,
    channels: source.channels,
    formatTag: source.formatTag,
    sampleRate: source.sampleRate,
  });
}

function createTargetWaveHeader(frameCount) {
  const dataByteLength = frameCount * 4;
  const header = Buffer.alloc(PCM_WAVE_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(dataByteLength + 36, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(GENERATED_WAVE_TARGET_FORMAT.sampleRate, 24);
  header.writeUInt32LE(GENERATED_WAVE_TARGET_FORMAT.sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataByteLength, 40);
  return header;
}

function readSourceSample(bytes, source, frame, channel) {
  const offset = frame * source.blockAlign + channel * (source.bitsPerSample / 8);

  if (source.formatTag === 3) {
    const value = bytes.readFloatLE(offset);

    if (!Number.isFinite(value)) {
      throw new GeneratedWaveNormalizationError(
        'GENERATED_WAVE_SAMPLE_INVALID',
        'Generated WAV contains a non-finite float sample.',
      );
    }

    return value;
  }

  const value = bytes.readInt16LE(offset);
  return value < 0 ? value / 32_768 : value / 32_767;
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

async function readExactly(fileHandle, bytes, position) {
  let offset = 0;

  while (offset < bytes.length) {
    const result = await fileHandle.read(
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );

    if (result.bytesRead === 0) {
      throw invalidSource();
    }
    offset += result.bytesRead;
  }
}

async function writeExactly(fileHandle, bytes, position) {
  let offset = 0;

  while (offset < bytes.length) {
    const result = await fileHandle.write(
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );

    if (result.bytesWritten === 0) {
      throw new GeneratedWaveNormalizationError(
        'GENERATED_WAVE_WRITE_FAILED',
        'Generated WAV normalization stopped before the target was complete.',
      );
    }
    offset += result.bytesWritten;
  }
}

async function hashOpenFile(fileHandle, sizeBytes, signal) {
  const digest = createHash('sha256');
  const bytes = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let position = 0;

  while (position < sizeBytes) {
    throwIfAborted(signal);
    const length = Math.min(bytes.length, sizeBytes - position);
    const result = await fileHandle.read(bytes, 0, length, position);

    if (result.bytesRead === 0) {
      throw invalidSource();
    }
    digest.update(bytes.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }

  return digest.digest('hex');
}

function assertStagingPath(stagingPath) {
  if (typeof stagingPath !== 'string' || stagingPath.length === 0) {
    throw new TypeError('Generated WAV normalization requires a staging path.');
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new GeneratedWaveNormalizationError(
      'GENERATED_WAVE_NORMALIZATION_ABORTED',
      'Generated WAV normalization was aborted.',
    );
  }
}

function invalidSource() {
  return new GeneratedWaveNormalizationError(
    'GENERATED_WAVE_SOURCE_INVALID',
    'Generated output must be one complete mono or stereo PCM16 or IEEE float32 RIFF/WAVE file.',
  );
}
