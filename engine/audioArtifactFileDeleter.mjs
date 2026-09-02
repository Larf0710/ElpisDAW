import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import {
  GENERATED_AUDIO_PROJECT_DIRECTORIES,
  MAX_GENERATED_WAV_BYTES,
} from './generatedAudioReader.mjs';
import { resolveProjectPath } from './projectRootAuthority.mjs';

export const MAX_AUDIO_FILE_DELETE_REQUEST_BYTES = 16_384;
export const AUDIO_FILE_DELETE_PROJECT_DIRECTORIES =
  GENERATED_AUDIO_PROJECT_DIRECTORIES;

const MAX_ARTIFACT_ID_LENGTH = 256;
const MAX_FILE_NAME_LENGTH = 1_024;
const MAX_RELATIVE_PATH_LENGTH = 4_096;
const RECORDING_DIRECTORY = 'recordings';
const WAV_HEADER_BYTES = 12;

export class AudioArtifactFileDeletionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AudioArtifactFileDeletionError';
    this.code = code;
  }
}

export class AudioArtifactFileDeleter {
  #projectRootAuthority;

  constructor({ projectRootAuthority }) {
    if (!projectRootAuthority || typeof projectRootAuthority.getSnapshot !== 'function') {
      throw new TypeError('AudioArtifactFileDeleter requires a ProjectRootAuthority.');
    }

    this.#projectRootAuthority = projectRootAuthority;
  }

  async deleteWav(fileDescriptor) {
    const descriptor = validateAudioFileDeletionDescriptor(fileDescriptor);
    const projectRoot = this.#projectRootAuthority.getSnapshot();

    if (projectRoot.status !== 'READY') {
      throw new AudioArtifactFileDeletionError(
        'PROJECT_ROOT_REQUIRED',
        'Select Project Root before deleting an Audio Artifact file.',
      );
    }

    const candidatePath = resolveProjectPath(
      projectRoot.rootPath,
      descriptor.relativePath,
    );
    const initialPathStat = await inspectCandidatePath(candidatePath);
    let canonicalPath;

    try {
      canonicalPath = await realpath(candidatePath);
    } catch (error) {
      throw mapInspectionError(error);
    }

    if (!isPathWithinRoot(projectRoot.rootPath, canonicalPath)) {
      throw new AudioArtifactFileDeletionError(
        'AUDIO_FILE_DELETE_OUTSIDE_PROJECT_ROOT',
        'Audio Artifact file resolves outside the active Project Root.',
      );
    }

    let sourceHandle;
    let validatedStat;

    try {
      sourceHandle = await open(candidatePath, 'r');
      validatedStat = await sourceHandle.stat();

      if (!validatedStat.isFile()) {
        throw new AudioArtifactFileDeletionError(
          'AUDIO_FILE_DELETE_UNOPENABLE',
          'Audio Artifact target is not a regular file.',
        );
      }

      if (validatedStat.size !== descriptor.sizeBytes) {
        throw new AudioArtifactFileDeletionError(
          'AUDIO_FILE_DELETE_METADATA_MISMATCH',
          'Audio Artifact file no longer matches its Project descriptor.',
        );
      }

      const header = Buffer.alloc(WAV_HEADER_BYTES);
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
        throw new AudioArtifactFileDeletionError(
          'AUDIO_FILE_DELETE_WAV_INVALID',
          'Audio Artifact target is not a supported RIFF/WAVE file.',
        );
      }
    } catch (error) {
      if (error instanceof AudioArtifactFileDeletionError) {
        throw error;
      }

      throw mapInspectionError(error);
    } finally {
      await sourceHandle?.close().catch(() => undefined);
    }

    let finalCanonicalPath;
    let finalPathStat;

    try {
      finalCanonicalPath = await realpath(candidatePath);
      finalPathStat = await lstat(candidatePath);
    } catch (error) {
      throw mapChangedFileError(error);
    }

    if (
      finalCanonicalPath !== canonicalPath ||
      !finalPathStat.isFile() ||
      !isSameFile(initialPathStat, finalPathStat) ||
      !isSameFile(validatedStat, finalPathStat)
    ) {
      throw new AudioArtifactFileDeletionError(
        'AUDIO_FILE_DELETE_METADATA_MISMATCH',
        'Audio Artifact file changed before deletion.',
      );
    }

    try {
      await unlink(candidatePath);
    } catch (error) {
      throw mapDeletionError(error);
    }

    return Object.freeze({
      artifactId: descriptor.artifactId,
      extension: '.wav',
      name: descriptor.name,
      relativePath: descriptor.relativePath,
      sizeBytes: descriptor.sizeBytes,
      status: 'DELETED',
      storageKind: descriptor.storageKind,
    });
  }
}

function validateAudioFileDeletionDescriptor(value) {
  if (!isRecord(value)) {
    throw invalidDescriptor('Audio file deletion descriptor must be an object.');
  }

  const artifactId = validateRequiredString(
    value.artifactId,
    'Audio file deletion artifactId',
    MAX_ARTIFACT_ID_LENGTH,
  );
  const name = validateRequiredString(
    value.name,
    'Audio file deletion name',
    MAX_FILE_NAME_LENGTH,
  );
  const relativePath = validateRequiredString(
    value.relativePath,
    'Audio file deletion relativePath',
    MAX_RELATIVE_PATH_LENGTH,
  );
  const sizeBytes = value.sizeBytes;

  if (value.extension !== '.wav') {
    throw invalidDescriptor('Audio file deletion extension must be .wav.');
  }

  if (value.storageKind !== 'generated' && value.storageKind !== 'recording') {
    throw invalidDescriptor(
      'Audio file deletion storageKind must be generated or recording.',
    );
  }

  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 44 ||
    sizeBytes > MAX_GENERATED_WAV_BYTES
  ) {
    throw invalidDescriptor(
      `Audio file deletion sizeBytes must be an integer from 45 to ${MAX_GENERATED_WAV_BYTES}.`,
    );
  }

  if (
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..' ||
    !name.toLowerCase().endsWith('.wav')
  ) {
    throw invalidDescriptor('Audio file deletion name must be a safe .wav filename.');
  }

  if (name !== `${artifactId}.wav`) {
    throw invalidDescriptor(
      'Audio file deletion name must match its Artifact ID.',
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
      'Audio file deletion relativePath must be a normalized Project-relative path.',
    );
  }

  if (
    relativePath.toLowerCase().endsWith('.partial') ||
    !relativePath.toLowerCase().endsWith('.wav')
  ) {
    throw invalidDescriptor(
      'Audio file deletion must reference a finalized .wav file.',
    );
  }

  const matchedDirectory = GENERATED_AUDIO_PROJECT_DIRECTORIES.find(
    (directory) =>
      relativePath.startsWith(`${directory}/`) &&
      relativePath.length > directory.length + 1,
  );

  if (!matchedDirectory) {
    throw invalidDescriptor(
      'Audio file deletion must reference a supported Project audio directory.',
    );
  }

  if (
    (value.storageKind === 'recording' &&
      matchedDirectory !== RECORDING_DIRECTORY) ||
    (value.storageKind === 'generated' &&
      matchedDirectory === RECORDING_DIRECTORY)
  ) {
    throw invalidDescriptor(
      'Audio file deletion storageKind does not match its Project directory.',
    );
  }

  if (segments[segments.length - 1] !== name) {
    throw invalidDescriptor(
      'Audio file deletion name must match the final relativePath segment.',
    );
  }

  return Object.freeze({
    artifactId,
    extension: '.wav',
    name,
    relativePath,
    sizeBytes,
    storageKind: value.storageKind,
  });
}

async function inspectCandidatePath(candidatePath) {
  try {
    const candidateStat = await lstat(candidatePath);

    if (!candidateStat.isFile()) {
      throw new AudioArtifactFileDeletionError(
        'AUDIO_FILE_DELETE_UNOPENABLE',
        'Audio Artifact target must be a regular file, not a link or directory.',
      );
    }

    return candidateStat;
  } catch (error) {
    if (error instanceof AudioArtifactFileDeletionError) {
      throw error;
    }

    throw mapInspectionError(error);
  }
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
  return new AudioArtifactFileDeletionError(
    'AUDIO_FILE_DELETE_REQUEST_INVALID',
    message,
  );
}

function mapInspectionError(value) {
  if (isMissingFileError(value)) {
    return new AudioArtifactFileDeletionError(
      'AUDIO_FILE_DELETE_NOT_FOUND',
      'Audio Artifact file is unavailable.',
    );
  }

  return new AudioArtifactFileDeletionError(
    'AUDIO_FILE_DELETE_UNOPENABLE',
    'Audio Artifact file could not be inspected.',
  );
}

function mapChangedFileError(value) {
  if (isMissingFileError(value)) {
    return new AudioArtifactFileDeletionError(
      'AUDIO_FILE_DELETE_METADATA_MISMATCH',
      'Audio Artifact file changed before deletion.',
    );
  }

  return mapInspectionError(value);
}

function mapDeletionError(value) {
  if (isMissingFileError(value)) {
    return new AudioArtifactFileDeletionError(
      'AUDIO_FILE_DELETE_METADATA_MISMATCH',
      'Audio Artifact file changed before deletion.',
    );
  }

  return new AudioArtifactFileDeletionError(
    'AUDIO_FILE_DELETE_FAILED',
    'Audio Artifact file could not be deleted.',
  );
}

function isSameFile(firstStat, secondStat) {
  return (
    firstStat.dev === secondStat.dev &&
    firstStat.ino === secondStat.ino &&
    firstStat.size === secondStat.size &&
    firstStat.mtimeMs === secondStat.mtimeMs
  );
}

function isPathWithinRoot(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isMissingFileError(value) {
  return (
    isNodeError(value) &&
    (value.code === 'ENOENT' || value.code === 'ENOTDIR')
  );
}

function isNodeError(value) {
  return value instanceof Error && 'code' in value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
