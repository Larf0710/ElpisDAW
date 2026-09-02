import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import {
  assessStableAudio3GenerationAcceptance,
} from './stableAudio3GenerationAcceptance.mjs';

const HASH_BUFFER_BYTES = 1024 * 1024;
const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
const MAX_PATH_LENGTH = 32_767;
const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

export class StableAudio3GenerationEvidenceFileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'StableAudio3GenerationEvidenceFileError';
  }
}

export async function verifyStableAudio3GenerationEvidenceFiles(
  evidenceValue,
  locationValue,
) {
  const assessment = assessStableAudio3GenerationAcceptance(evidenceValue);

  if (assessment.status !== 'ACCEPTED_FOR_REVIEW') {
    throw failure(
      'STABLE_AUDIO_3_EVIDENCE_REJECTED',
      'Stable Audio 3 file verification requires technically accepted generation evidence.',
    );
  }

  const locations = validateLocations(locationValue);
  const modelRootPath = await resolveModelRoot(locations.modelRootPath);
  const input = await inspectEvidenceFile(locations.inputPath, {
    expectedSha256: assessment.evidence.generation.inputSha256,
    label: 'Generation input',
    requireWave: true,
  });
  const output = await inspectEvidenceFile(locations.outputPath, {
    expectedSha256: assessment.evidence.generation.output.sha256,
    expectedSizeBytes: assessment.evidence.generation.output.sizeBytes,
    label: 'Generation output',
    requireWave: true,
  });

  if (input.canonicalPath === output.canonicalPath) {
    throw failure(
      'STABLE_AUDIO_3_EVIDENCE_FILE_INVALID',
      'Generation input and output must be different regular files.',
    );
  }

  assertOutputMatchesEvidence(output.wave, assessment.evidence.generation.output);

  const modelFiles = [];

  for (const expectedFile of assessment.evidence.model.files) {
    const candidatePath = join(modelRootPath, ...expectedFile.path.split('/'));
    const modelFile = await inspectEvidenceFile(candidatePath, {
      containmentRoot: modelRootPath,
      expectedSha256: expectedFile.sha256,
      expectedSizeBytes: expectedFile.sizeBytes,
      label: 'Model evidence file',
    });

    modelFiles.push(
      Object.freeze({
        path: expectedFile.path,
        sha256: modelFile.sha256,
        sizeBytes: modelFile.sizeBytes,
      }),
    );
  }

  return Object.freeze({
    assessment,
    files: Object.freeze({
      input: Object.freeze({
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        wave: input.wave,
      }),
      model: Object.freeze(modelFiles),
      output: Object.freeze({
        sha256: output.sha256,
        sizeBytes: output.sizeBytes,
        wave: output.wave,
      }),
    }),
    status: 'FILES_VERIFIED',
  });
}

function validateLocations(value) {
  requireExactKeys(
    value,
    ['inputPath', 'modelRootPath', 'outputPath'],
    'Stable Audio 3 evidence file locations',
  );

  return Object.freeze({
    inputPath: requireAbsolutePath(value.inputPath, 'Generation input path'),
    modelRootPath: requireAbsolutePath(value.modelRootPath, 'Model root path'),
    outputPath: requireAbsolutePath(value.outputPath, 'Generation output path'),
  });
}

async function resolveModelRoot(path) {
  let pathStat;

  try {
    pathStat = await lstat(path);
  } catch {
    throw unavailable('Stable Audio 3 model root is unavailable.');
  }

  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw failure(
      'STABLE_AUDIO_3_EVIDENCE_FILE_INVALID',
      'Stable Audio 3 model root must be a regular directory, not a link.',
    );
  }

  try {
    return await realpath(path);
  } catch {
    throw unavailable('Stable Audio 3 model root is unavailable.');
  }
}

async function inspectEvidenceFile(
  path,
  {
    containmentRoot,
    expectedSha256,
    expectedSizeBytes,
    label,
    requireWave = false,
  },
) {
  let pathStat;

  try {
    pathStat = await lstat(path);
  } catch {
    throw unavailable(`${label} is unavailable.`);
  }

  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw failure(
      'STABLE_AUDIO_3_EVIDENCE_FILE_INVALID',
      `${label} must be a regular file, not a link.`,
    );
  }

  let canonicalPath;

  try {
    canonicalPath = await realpath(path);
  } catch {
    throw unavailable(`${label} is unavailable.`);
  }

  if (
    containmentRoot !== undefined &&
    !isPathWithinRoot(containmentRoot, canonicalPath)
  ) {
    throw failure(
      'STABLE_AUDIO_3_EVIDENCE_OUTSIDE_MODEL_ROOT',
      'Model evidence file resolves outside the declared model root.',
    );
  }

  let fileHandle;

  try {
    fileHandle = await open(canonicalPath, 'r');
    const initialStat = await fileHandle.stat();

    if (!initialStat.isFile() || initialStat.size <= 0) {
      throw failure(
        'STABLE_AUDIO_3_EVIDENCE_FILE_INVALID',
        `${label} must be a non-empty regular file.`,
      );
    }

    if (requireWave && initialStat.size > MAX_AUDIO_BYTES) {
      throw failure(
        'STABLE_AUDIO_3_EVIDENCE_FILE_INVALID',
        `${label} exceeds the bounded audio evidence size.`,
      );
    }

    if (
      expectedSizeBytes !== undefined &&
      initialStat.size !== expectedSizeBytes
    ) {
      throw mismatch(`${label} size does not match its acceptance evidence.`);
    }

    const sha256 = await hashFileHandle(fileHandle, initialStat.size, label);
    const wave = requireWave
      ? await inspectWaveFile(fileHandle, initialStat.size, label)
      : undefined;
    const finalStat = await fileHandle.stat();

    if (
      finalStat.size !== initialStat.size ||
      finalStat.mtimeMs !== initialStat.mtimeMs ||
      finalStat.ctimeMs !== initialStat.ctimeMs
    ) {
      throw failure(
        'STABLE_AUDIO_3_EVIDENCE_FILE_CHANGED',
        `${label} changed while it was being verified.`,
      );
    }

    if (sha256 !== expectedSha256) {
      throw mismatch(`${label} hash does not match its acceptance evidence.`);
    }

    return Object.freeze({
      canonicalPath,
      sha256,
      sizeBytes: initialStat.size,
      wave,
    });
  } catch (error) {
    if (error instanceof StableAudio3GenerationEvidenceFileError) {
      throw error;
    }

    throw unavailable(`${label} could not be verified.`);
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

async function hashFileHandle(fileHandle, sizeBytes, label) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(
    Math.min(HASH_BUFFER_BYTES, sizeBytes),
  );
  let position = 0;

  while (position < sizeBytes) {
    const length = Math.min(buffer.length, sizeBytes - position);
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      length,
      position,
    );

    if (bytesRead === 0) {
      throw failure(
        'STABLE_AUDIO_3_EVIDENCE_FILE_CHANGED',
        `${label} changed while it was being hashed.`,
      );
    }

    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }

  return hash.digest('hex');
}

async function inspectWaveFile(fileHandle, sizeBytes, label) {
  const riffHeader = await readExactly(fileHandle, RIFF_HEADER_BYTES, 0, label);

  if (
    riffHeader.toString('ascii', 0, 4) !== 'RIFF' ||
    riffHeader.toString('ascii', 8, 12) !== 'WAVE' ||
    riffHeader.readUInt32LE(4) + 8 !== sizeBytes
  ) {
    throw invalidWave(`${label} is not one complete RIFF/WAVE file.`);
  }

  let dataSizeBytes;
  let format;
  let offset = RIFF_HEADER_BYTES;

  while (offset + CHUNK_HEADER_BYTES <= sizeBytes) {
    const chunkHeader = await readExactly(
      fileHandle,
      CHUNK_HEADER_BYTES,
      offset,
      label,
    );
    const chunkId = chunkHeader.toString('ascii', 0, 4);
    const chunkSize = chunkHeader.readUInt32LE(4);
    const chunkDataOffset = offset + CHUNK_HEADER_BYTES;
    const paddedChunkEnd =
      chunkDataOffset + chunkSize + (chunkSize % 2);

    if (paddedChunkEnd > sizeBytes) {
      throw invalidWave(`${label} contains an incomplete WAVE chunk.`);
    }

    if (chunkId === 'fmt ') {
      if (format !== undefined || chunkSize < 16) {
        throw invalidWave(`${label} contains an invalid WAVE format chunk.`);
      }

      format = parseWaveFormat(
        await readExactly(fileHandle, 16, chunkDataOffset, label),
        label,
      );
    } else if (chunkId === 'data') {
      if (dataSizeBytes !== undefined || chunkSize === 0) {
        throw invalidWave(`${label} contains an invalid WAVE data chunk.`);
      }

      dataSizeBytes = chunkSize;
    }

    offset = paddedChunkEnd;
  }

  if (
    offset !== sizeBytes ||
    format === undefined ||
    dataSizeBytes === undefined ||
    dataSizeBytes % format.blockAlign !== 0
  ) {
    throw invalidWave(`${label} has incomplete or inconsistent WAVE data.`);
  }

  return Object.freeze({
    channels: format.channels,
    container: 'RIFF/WAVE',
    durationSeconds: dataSizeBytes / format.byteRate,
    sampleRate: format.sampleRate,
  });
}

function parseWaveFormat(bytes, label) {
  const formatTag = bytes.readUInt16LE(0);
  const channels = bytes.readUInt16LE(2);
  const sampleRate = bytes.readUInt32LE(4);
  const byteRate = bytes.readUInt32LE(8);
  const blockAlign = bytes.readUInt16LE(12);
  const bitsPerSample = bytes.readUInt16LE(14);
  const supportedBits =
    (formatTag === 1 && [8, 16, 24, 32].includes(bitsPerSample)) ||
    (formatTag === 3 && [32, 64].includes(bitsPerSample));
  const expectedBlockAlign = (channels * bitsPerSample) / 8;

  if (
    !supportedBits ||
    channels <= 0 ||
    channels > 32 ||
    sampleRate < 8_000 ||
    sampleRate > 192_000 ||
    !Number.isSafeInteger(expectedBlockAlign) ||
    blockAlign !== expectedBlockAlign ||
    byteRate !== sampleRate * blockAlign
  ) {
    throw invalidWave(`${label} uses an unsupported WAVE format.`);
  }

  return Object.freeze({
    blockAlign,
    byteRate,
    channels,
    sampleRate,
  });
}

async function readExactly(fileHandle, length, position, label) {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await fileHandle.read(
    buffer,
    0,
    length,
    position,
  );

  if (bytesRead !== length) {
    throw invalidWave(`${label} contains truncated WAVE metadata.`);
  }

  return buffer;
}

function assertOutputMatchesEvidence(actual, expected) {
  const durationTolerance = Math.max(1 / actual.sampleRate, 0.000_001);

  if (
    actual.channels !== expected.channels ||
    actual.sampleRate !== expected.sampleRate ||
    Math.abs(actual.durationSeconds - expected.durationSeconds) >
      durationTolerance
  ) {
    throw mismatch(
      'Generation output WAVE properties do not match the acceptance evidence.',
    );
  }
}

function requireExactKeys(value, expectedKeys, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw requestInvalid(`${label} must be an object.`);
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw requestInvalid(`${label} keys are invalid.`);
  }
}

function requireAbsolutePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > MAX_PATH_LENGTH ||
    !isAbsolute(value)
  ) {
    throw requestInvalid(`${label} must be one absolute path.`);
  }

  return value;
}

function isPathWithinRoot(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function requestInvalid(message) {
  return failure('STABLE_AUDIO_3_EVIDENCE_FILE_REQUEST_INVALID', message);
}

function unavailable(message) {
  return failure('STABLE_AUDIO_3_EVIDENCE_FILE_UNAVAILABLE', message);
}

function mismatch(message) {
  return failure('STABLE_AUDIO_3_EVIDENCE_FILE_MISMATCH', message);
}

function invalidWave(message) {
  return failure('STABLE_AUDIO_3_EVIDENCE_WAV_INVALID', message);
}

function failure(code, message) {
  return new StableAudio3GenerationEvidenceFileError(code, message);
}
