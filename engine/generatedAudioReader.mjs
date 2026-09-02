import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative } from 'node:path';

import { LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE } from '../shared/localEngineProtocol.js';
import {
  localEngineLogger,
  toDiagnosticErrorFields,
} from './diagnosticLogger.mjs';
import { resolveProjectPath } from './projectRootAuthority.mjs';

export const MAX_GENERATED_AUDIO_READ_REQUEST_BYTES = 16_384;
export const MAX_GENERATED_AUDIO_AVAILABILITY_REQUEST_BYTES = 2_097_152;
export const MAX_GENERATED_AUDIO_AVAILABILITY_SOURCES =
  LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE;
export const MAX_GENERATED_WAV_BYTES = 512 * 1024 * 1024;
export const GENERATED_AUDIO_PROJECT_DIRECTORIES = Object.freeze([
  'recordings',
  'renders/instruments',
  'renders/stable-audio-3',
  'renders/ace-step',
  'mixdowns',
  'print-mixes',
  'stem-prints',
  'exports',
]);

const MAX_SOURCE_ID_LENGTH = 256;
const MAX_SOURCE_NAME_LENGTH = 1_024;
const MAX_SOURCE_PATH_LENGTH = 4_096;
const WAV_HEADER_BYTES = 12;
const GENERATED_AUDIO_UNAVAILABLE_CODES = new Set([
  'GENERATED_AUDIO_METADATA_MISMATCH',
  'GENERATED_AUDIO_NOT_FOUND',
  'GENERATED_AUDIO_OUTSIDE_PROJECT_ROOT',
  'GENERATED_AUDIO_UNOPENABLE',
  'GENERATED_AUDIO_WAV_INVALID',
]);

export class GeneratedAudioReadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GeneratedAudioReadError';
    this.code = code;
  }
}

export class GeneratedAudioReader {
  #logger;
  #projectRootAuthority;

  constructor({ logger = localEngineLogger, projectRootAuthority }) {
    if (!projectRootAuthority || typeof projectRootAuthority.getSnapshot !== 'function') {
      throw new TypeError('GeneratedAudioReader requires a ProjectRootAuthority.');
    }

    if (!isDiagnosticLogger(logger)) {
      throw new TypeError('GeneratedAudioReader requires a diagnostic logger.');
    }

    this.#logger = logger;
    this.#projectRootAuthority = projectRootAuthority;
  }

  async readWav(sourceDescriptor) {
    const descriptor = validateGeneratedWavDescriptor(sourceDescriptor);
    this.#logger.debug('SOURCE', 'SOURCE_READ_STARTED', {
      relativePath: descriptor.relativePath,
      sizeBytes: descriptor.sizeBytes,
      sourceId: descriptor.sourceId,
    });
    let source;

    try {
      const projectRoot = requireReadyProjectRoot(this.#projectRootAuthority);
      source = await openValidatedGeneratedWav(projectRoot.rootPath, descriptor);
      const bytes = Buffer.allocUnsafe(source.sizeBytes);
      let totalBytesRead = 0;

      while (totalBytesRead < bytes.length) {
        const { bytesRead } = await source.handle.read(
          bytes,
          totalBytesRead,
          bytes.length - totalBytesRead,
          totalBytesRead,
        );

        if (bytesRead === 0) {
          break;
        }

        totalBytesRead += bytesRead;
      }

      const finalStat = await source.handle.stat();

      if (
        totalBytesRead !== source.sizeBytes ||
        finalStat.size !== source.sizeBytes ||
        finalStat.mtimeMs !== source.mtimeMs ||
        finalStat.ctimeMs !== source.ctimeMs
      ) {
        throw new GeneratedAudioReadError(
          'GENERATED_AUDIO_METADATA_MISMATCH',
          'Generated audio changed while it was being read.',
        );
      }

      const result = Object.freeze({
        bytes,
        contentLength: bytes.length,
        contentType: 'audio/wav',
      });
      this.#logger.debug('SOURCE', 'SOURCE_READ_COMPLETED', {
        relativePath: descriptor.relativePath,
        sizeBytes: result.contentLength,
        sourceId: descriptor.sourceId,
      });
      return result;
    } catch (error) {
      this.#logger.error('SOURCE', 'SOURCE_READ_FAILED', {
        ...toDiagnosticErrorFields(error),
        relativePath: descriptor.relativePath,
        sourceId: descriptor.sourceId,
      });

      if (error instanceof GeneratedAudioReadError) {
        throw error;
      }

      throw mapOpenError(error);
    } finally {
      await source?.handle.close().catch(() => undefined);
    }
  }

  async findAvailableWavSourceIds(sourceDescriptors) {
    if (
      !Array.isArray(sourceDescriptors) ||
      sourceDescriptors.length > MAX_GENERATED_AUDIO_AVAILABILITY_SOURCES
    ) {
      throw invalidDescriptor(
        `Generated audio availability sources must be an array containing at most ${MAX_GENERATED_AUDIO_AVAILABILITY_SOURCES} entries.`,
      );
    }

    const descriptors = sourceDescriptors.map(validateGeneratedWavDescriptor);
    const sourceIds = descriptors.map((descriptor) => descriptor.sourceId);

    if (new Set(sourceIds).size !== sourceIds.length) {
      throw invalidDescriptor(
        'Generated audio availability sourceId values must be unique.',
      );
    }

    this.#logger.debug('SOURCE', 'SOURCE_AVAILABILITY_CHECK_STARTED', {
      sourceCount: descriptors.length,
    });
    const projectRoot = requireReadyProjectRoot(this.#projectRootAuthority);
    const availableSourceIds = [];

    for (const descriptor of descriptors) {
      let source;

      try {
        source = await openValidatedGeneratedWav(projectRoot.rootPath, descriptor);
        availableSourceIds.push(descriptor.sourceId);
      } catch (error) {
        if (
          error instanceof GeneratedAudioReadError &&
          GENERATED_AUDIO_UNAVAILABLE_CODES.has(error.code)
        ) {
          this.#logger.trace('SOURCE', 'SOURCE_UNAVAILABLE', {
            ...toDiagnosticErrorFields(error),
            relativePath: descriptor.relativePath,
            sourceId: descriptor.sourceId,
          });
          continue;
        }

        throw error;
      } finally {
        await source?.handle.close().catch(() => undefined);
      }
    }

    const sortedSourceIds = Object.freeze(availableSourceIds.sort(compareStableText));
    this.#logger.debug('SOURCE', 'SOURCE_AVAILABILITY_CHECK_COMPLETED', {
      availableCount: sortedSourceIds.length,
      sourceCount: descriptors.length,
      unavailableCount: descriptors.length - sortedSourceIds.length,
    });
    return sortedSourceIds;
  }
}

function requireReadyProjectRoot(projectRootAuthority) {
  const projectRoot = projectRootAuthority.getSnapshot();

  if (projectRoot.status !== 'READY') {
    throw new GeneratedAudioReadError(
      'PROJECT_ROOT_REQUIRED',
      'Select Project Root before accessing generated audio.',
    );
  }

  return projectRoot;
}

async function openValidatedGeneratedWav(rootPath, descriptor) {
  const candidatePath = resolveProjectPath(rootPath, descriptor.relativePath);
  let canonicalPath;

  try {
    canonicalPath = await realpath(candidatePath);
  } catch (error) {
    throw mapOpenError(error);
  }

  if (!isPathWithinRoot(rootPath, canonicalPath)) {
    throw new GeneratedAudioReadError(
      'GENERATED_AUDIO_OUTSIDE_PROJECT_ROOT',
      'Generated audio resolves outside the active Project Root.',
    );
  }

  let sourceHandle;

  try {
    sourceHandle = await open(canonicalPath, 'r');
    const sourceStat = await sourceHandle.stat();

    if (!sourceStat.isFile()) {
      throw new GeneratedAudioReadError(
        'GENERATED_AUDIO_UNOPENABLE',
        'Generated audio is not a regular file.',
      );
    }

    if (
      basename(canonicalPath) !== descriptor.name ||
      sourceStat.size !== descriptor.sizeBytes
    ) {
      throw new GeneratedAudioReadError(
        'GENERATED_AUDIO_METADATA_MISMATCH',
        'Generated audio no longer matches its Project descriptor.',
      );
    }

    const header = Buffer.allocUnsafe(WAV_HEADER_BYTES);
    const { bytesRead } = await sourceHandle.read(
      header,
      0,
      WAV_HEADER_BYTES,
      0,
    );

    if (
      bytesRead !== WAV_HEADER_BYTES ||
      header.toString('ascii', 0, 4) !== 'RIFF' ||
      header.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new GeneratedAudioReadError(
        'GENERATED_AUDIO_WAV_INVALID',
        'Generated audio is not a supported RIFF/WAVE file.',
      );
    }

    if ((await sourceHandle.stat()).size !== sourceStat.size) {
      throw new GeneratedAudioReadError(
        'GENERATED_AUDIO_METADATA_MISMATCH',
        'Generated audio changed while it was being inspected.',
      );
    }

    return Object.freeze({
      ctimeMs: sourceStat.ctimeMs,
      handle: sourceHandle,
      mtimeMs: sourceStat.mtimeMs,
      sizeBytes: sourceStat.size,
    });
  } catch (error) {
    await sourceHandle?.close().catch(() => undefined);

    if (error instanceof GeneratedAudioReadError) {
      throw error;
    }

    throw mapOpenError(error);
  }
}

function validateGeneratedWavDescriptor(value) {
  if (!isRecord(value)) {
    throw invalidDescriptor('Generated audio source must be an object.');
  }

  if (value.kind !== 'generated') {
    throw invalidDescriptor('Generated audio source kind must be generated.');
  }

  const sourceId = validateRequiredString(
    value.sourceId,
    'Generated audio sourceId',
    MAX_SOURCE_ID_LENGTH,
  );
  const name = validateRequiredString(
    value.name,
    'Generated audio name',
    MAX_SOURCE_NAME_LENGTH,
  );
  const relativePath = validateRequiredString(
    value.relativePath,
    'Generated audio relativePath',
    MAX_SOURCE_PATH_LENGTH,
  );
  const sizeBytes = value.sizeBytes;

  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 44 ||
    sizeBytes > MAX_GENERATED_WAV_BYTES
  ) {
    throw invalidDescriptor(
      `Generated audio sizeBytes must be an integer from 45 to ${MAX_GENERATED_WAV_BYTES}.`,
    );
  }

  if (
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..' ||
    !name.toLowerCase().endsWith('.wav')
  ) {
    throw invalidDescriptor('Generated audio name must be a safe .wav filename.');
  }

  if (name !== `${sourceId}.wav`) {
    throw invalidDescriptor(
      'Generated audio name must match its source Artifact ID.',
    );
  }

  const segments = relativePath.split('/');

  if (
    relativePath.includes('\\') ||
    isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':'),
    )
  ) {
    throw invalidDescriptor(
      'Generated audio relativePath must be a normalized Project-relative path.',
    );
  }

  if (
    relativePath.toLowerCase().endsWith('.partial') ||
    !relativePath.toLowerCase().endsWith('.wav')
  ) {
    throw invalidDescriptor('Generated audio must reference a finalized .wav file.');
  }

  const isSupported = GENERATED_AUDIO_PROJECT_DIRECTORIES.some(
    (directory) =>
      relativePath.startsWith(`${directory}/`) &&
      relativePath.length > directory.length + 1,
  );

  if (!isSupported) {
    throw invalidDescriptor(
      'Generated audio must be stored in a supported Project directory.',
    );
  }

  if (segments[segments.length - 1] !== name) {
    throw invalidDescriptor(
      'Generated audio name must match the final relativePath segment.',
    );
  }

  return Object.freeze({
    kind: 'generated',
    name,
    relativePath,
    sizeBytes,
    sourceId,
  });
}

function validateRequiredString(value, label, maximumLength) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw invalidDescriptor(`${label} must be a non-empty trimmed string.`);
  }

  if (value.length > maximumLength) {
    throw invalidDescriptor(`${label} exceeds the ${maximumLength} character limit.`);
  }

  return value;
}

function invalidDescriptor(message) {
  return new GeneratedAudioReadError('GENERATED_AUDIO_REQUEST_INVALID', message);
}

function mapOpenError(value) {
  if (isNodeError(value) && (value.code === 'ENOENT' || value.code === 'ENOTDIR')) {
    return new GeneratedAudioReadError(
      'GENERATED_AUDIO_NOT_FOUND',
      'Generated audio file is unavailable.',
    );
  }

  return new GeneratedAudioReadError(
    'GENERATED_AUDIO_UNOPENABLE',
    'Generated audio file could not be opened.',
  );
}

function isPathWithinRoot(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isNodeError(value) {
  return value instanceof Error && 'code' in value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDiagnosticLogger(value) {
  return (
    value &&
    typeof value.debug === 'function' &&
    typeof value.error === 'function' &&
    typeof value.trace === 'function'
  );
}

function compareStableText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
