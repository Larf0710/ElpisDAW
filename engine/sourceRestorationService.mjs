import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative } from 'node:path';

import { GENERATED_AUDIO_PROJECT_DIRECTORIES } from './generatedAudioReader.mjs';
import {
  localEngineLogger,
  toDiagnosticErrorFields,
} from './diagnosticLogger.mjs';
import { resolveProjectPath } from './projectRootAuthority.mjs';

export const MAX_SOURCE_RESTORE_REQUEST_BYTES = 1_048_576;
export const MAX_SOURCE_RESTORE_DESCRIPTORS = 4_096;

const MAX_SOURCE_ID_LENGTH = 256;
const MAX_SOURCE_NAME_LENGTH = 1_024;
const MAX_SOURCE_PATH_LENGTH = 4_096;
const SOURCE_AVAILABILITY_STATES = Object.freeze([
  'available',
  'unresolved',
  'missing',
  'unopenable',
]);

export class SourceRestorationValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceRestorationValidationError';
  }
}

export class SourceRestorationService {
  #logger;
  #projectRootAuthority;

  constructor({ logger = localEngineLogger, projectRootAuthority }) {
    if (!projectRootAuthority || typeof projectRootAuthority.getSnapshot !== 'function') {
      throw new TypeError('SourceRestorationService requires a ProjectRootAuthority.');
    }

    if (!isDiagnosticLogger(logger)) {
      throw new TypeError('SourceRestorationService requires a diagnostic logger.');
    }

    this.#logger = logger;
    this.#projectRootAuthority = projectRootAuthority;
  }

  async restore(sourceDescriptors) {
    const descriptors = validateSourceDescriptors(sourceDescriptors);
    this.#logger.debug('SOURCE', 'SOURCE_RESTORATION_STARTED', {
      sourceCount: descriptors.length,
    });

    try {
      const projectRoot = this.#projectRootAuthority.getSnapshot();
      const sources = await Promise.all(
        descriptors.map((descriptor) => inspectSource(descriptor, projectRoot)),
      );
      const availability = Object.freeze(
        Object.fromEntries(sources.map((source) => [source.sourceId, source.state])),
      );
      const availableCount = sources.filter((source) => source.state === 'available').length;

      for (const source of sources) {
        this.#logger.trace('SOURCE', 'SOURCE_RESTORATION_RESULT', {
          reason: source.reason,
          sourceId: source.sourceId,
          state: source.state,
        });
      }

      const result = Object.freeze({
        availability,
        checkedAt: new Date().toISOString(),
        sources: Object.freeze(sources),
      });
      this.#logger.debug('SOURCE', 'SOURCE_RESTORATION_COMPLETED', {
        availableCount,
        sourceCount: sources.length,
        unavailableCount: sources.length - availableCount,
      });
      return result;
    } catch (error) {
      this.#logger.error('SOURCE', 'SOURCE_RESTORATION_FAILED', {
        ...toDiagnosticErrorFields(error),
        sourceCount: descriptors.length,
      });
      throw error;
    }
  }
}

function validateSourceDescriptors(value) {
  if (!Array.isArray(value)) {
    throw new SourceRestorationValidationError('Source restoration requires a sources array.');
  }

  if (value.length > MAX_SOURCE_RESTORE_DESCRIPTORS) {
    throw new SourceRestorationValidationError(
      `Source restoration accepts at most ${MAX_SOURCE_RESTORE_DESCRIPTORS} sources.`,
    );
  }

  const sourceIds = new Set();

  return Object.freeze(
    value.map((descriptor, index) => {
      const validated = validateSourceDescriptor(descriptor, index);

      if (sourceIds.has(validated.sourceId)) {
        throw new SourceRestorationValidationError(
          `Source restoration sourceId must be unique: ${validated.sourceId}.`,
        );
      }

      sourceIds.add(validated.sourceId);
      return validated;
    }),
  );
}

function validateSourceDescriptor(value, index) {
  if (!isRecord(value)) {
    throw new SourceRestorationValidationError(
      `Source descriptor at index ${index} must be an object.`,
    );
  }

  const sourceId = validateRequiredString(
    value.sourceId,
    `Source descriptor at index ${index} sourceId`,
    MAX_SOURCE_ID_LENGTH,
  );
  const metadata = validateMetadata(value, index);

  if (value.kind === 'generated') {
    const relativePath = validateGeneratedRelativePath(value.relativePath, index);
    validateGeneratedSourceIdentity(sourceId, relativePath, metadata.name, index);
    return Object.freeze({ kind: 'generated', relativePath, sourceId, ...metadata });
  }

  if (value.kind === 'external') {
    const path = validateRequiredString(
      value.path,
      `External source at index ${index} path`,
      MAX_SOURCE_PATH_LENGTH,
    );

    if (!isAbsolute(path)) {
      throw new SourceRestorationValidationError(
        `External source at index ${index} path must be absolute.`,
      );
    }

    return Object.freeze({ kind: 'external', path, sourceId, ...metadata });
  }

  throw new SourceRestorationValidationError(
    `Source descriptor at index ${index} kind must be generated or external.`,
  );
}

function validateMetadata(value, index) {
  const metadata = {};

  if (value.name !== undefined) {
    metadata.name = validateRequiredString(
      value.name,
      `Source descriptor at index ${index} name`,
      MAX_SOURCE_NAME_LENGTH,
    );
  }

  if (value.sizeBytes !== undefined) {
    metadata.sizeBytes = validateNonNegativeInteger(
      value.sizeBytes,
      `Source descriptor at index ${index} sizeBytes`,
    );
  }

  if (value.lastModified !== undefined) {
    metadata.lastModified = validateNonNegativeInteger(
      value.lastModified,
      `Source descriptor at index ${index} lastModified`,
    );
  }

  return metadata;
}

function validateGeneratedRelativePath(value, index) {
  const relativePath = validateRequiredString(
    value,
    `Generated source at index ${index} relativePath`,
    MAX_SOURCE_PATH_LENGTH,
  ).replaceAll('\\', '/');
  const segments = relativePath.split('/');

  if (
    isAbsolute(relativePath) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new SourceRestorationValidationError(
      `Generated source at index ${index} relativePath must be a normalized Project-relative path.`,
    );
  }

  if (relativePath.toLowerCase().endsWith('.partial')) {
    throw new SourceRestorationValidationError(
      `Generated source at index ${index} cannot reference a staging .partial file.`,
    );
  }

  const isSupported = GENERATED_AUDIO_PROJECT_DIRECTORIES.some(
    (directory) => relativePath.startsWith(`${directory}/`) && relativePath.length > directory.length + 1,
  );

  if (!isSupported) {
    throw new SourceRestorationValidationError(
      `Generated source at index ${index} must be stored in a supported Project directory.`,
    );
  }

  return relativePath;
}

function validateGeneratedSourceIdentity(sourceId, relativePath, name, index) {
  const expectedName = `${sourceId}.wav`;
  const relativePathName = relativePath.split('/').at(-1);

  if (name !== expectedName || relativePathName !== expectedName) {
    throw new SourceRestorationValidationError(
      `Generated source at index ${index} name and relativePath must match its source Artifact ID.`,
    );
  }
}

function validateRequiredString(value, label, maximumLength) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new SourceRestorationValidationError(`${label} must be a non-empty trimmed string.`);
  }

  if (value.length > maximumLength) {
    throw new SourceRestorationValidationError(
      `${label} exceeds the ${maximumLength} character limit.`,
    );
  }

  return value;
}

function validateNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SourceRestorationValidationError(`${label} must be a non-negative integer.`);
  }

  return value;
}

async function inspectSource(descriptor, projectRoot) {
  if (descriptor.kind === 'generated' && projectRoot.status !== 'READY') {
    return createSourceResult(descriptor, 'unresolved', 'project-root-required');
  }

  const candidatePath =
    descriptor.kind === 'generated'
      ? resolveProjectPath(projectRoot.rootPath, descriptor.relativePath)
      : descriptor.path;
  let canonicalPath;

  try {
    canonicalPath = await realpath(candidatePath);
  } catch (error) {
    return isMissingPathError(error)
      ? createSourceResult(descriptor, 'missing', 'missing')
      : createSourceResult(descriptor, 'unopenable', 'unopenable');
  }

  if (
    descriptor.kind === 'generated' &&
    !isPathWithinRoot(projectRoot.rootPath, canonicalPath)
  ) {
    return createSourceResult(descriptor, 'unopenable', 'outside-project-root');
  }

  let sourceHandle;

  try {
    sourceHandle = await open(canonicalPath, 'r');
    const sourceStat = await sourceHandle.stat();

    if (!sourceStat.isFile()) {
      return createSourceResult(descriptor, 'unopenable', 'unopenable');
    }

    const actual = Object.freeze({
      lastModified: Math.round(sourceStat.mtimeMs),
      name: basename(canonicalPath),
      sizeBytes: sourceStat.size,
    });

    if (!metadataMatches(descriptor, actual)) {
      return createSourceResult(descriptor, 'unresolved', 'metadata-mismatch', { actual });
    }

    return createSourceResult(descriptor, 'available', 'available', {
      actual,
      resolvedPath: canonicalPath,
    });
  } catch (error) {
    return isMissingPathError(error)
      ? createSourceResult(descriptor, 'missing', 'missing')
      : createSourceResult(descriptor, 'unopenable', 'unopenable');
  } finally {
    await sourceHandle?.close().catch(() => undefined);
  }
}

function metadataMatches(descriptor, actual) {
  return (
    (descriptor.name === undefined || descriptor.name === actual.name) &&
    (descriptor.sizeBytes === undefined || descriptor.sizeBytes === actual.sizeBytes) &&
    (descriptor.lastModified === undefined || descriptor.lastModified === actual.lastModified)
  );
}

function createSourceResult(descriptor, state, reason, details = {}) {
  if (!SOURCE_AVAILABILITY_STATES.includes(state)) {
    throw new Error(`Unsupported source availability state: ${state}.`);
  }

  return Object.freeze({
    kind: descriptor.kind,
    sourceId: descriptor.sourceId,
    state,
    reason,
    ...(descriptor.kind === 'generated'
      ? { relativePath: descriptor.relativePath }
      : { path: descriptor.path }),
    ...details,
  });
}

function isPathWithinRoot(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isMissingPathError(value) {
  return isNodeError(value) && (value.code === 'ENOENT' || value.code === 'ENOTDIR');
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
