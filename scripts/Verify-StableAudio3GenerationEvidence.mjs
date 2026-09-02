import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

import {
  verifyStableAudio3GenerationEvidenceFiles,
} from '../engine/providers/stableAudio3GenerationEvidenceFiles.mjs';

const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/;
const MAX_EVIDENCE_JSON_BYTES = 1024 * 1024;
const MAX_MODEL_FILES = 64;
const MAX_PATH_LENGTH = 32_767;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REJECTION_CODES = new Set([
  'STABLE_AUDIO_3_EVIDENCE_REJECTED',
  'STABLE_AUDIO_3_EVIDENCE_FILE_CHANGED',
  'STABLE_AUDIO_3_EVIDENCE_FILE_INVALID',
  'STABLE_AUDIO_3_EVIDENCE_FILE_MISMATCH',
  'STABLE_AUDIO_3_EVIDENCE_FILE_UNAVAILABLE',
  'STABLE_AUDIO_3_EVIDENCE_OUTSIDE_MODEL_ROOT',
  'STABLE_AUDIO_3_EVIDENCE_WAV_INVALID',
]);

export class StableAudio3GenerationEvidenceCliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'StableAudio3GenerationEvidenceCliError';
  }
}

export async function runStableAudio3GenerationEvidenceCli(
  args,
  {
    loadEvidence = loadStableAudio3GenerationEvidenceFile,
    verifyEvidenceFiles = verifyStableAudio3GenerationEvidenceFiles,
    writeOutput = (value) => process.stdout.write(value),
  } = {},
) {
  let exitCode;
  let output;

  try {
    const locations = validateCliArguments(args);
    const evidence = await loadEvidence(locations.evidencePath);
    const result = await verifyEvidenceFiles(evidence, {
      inputPath: locations.inputPath,
      modelRootPath: locations.modelRootPath,
      outputPath: locations.outputPath,
    });

    if (
      result?.status !== 'FILES_VERIFIED' ||
      result.assessment?.status !== 'ACCEPTED_FOR_REVIEW' ||
      typeof result.assessment.supportsCancellation !== 'boolean' ||
      !isRecord(result.files)
    ) {
      throw invalidVerifierResponse();
    }

    output = {
      assessment: {
        status: result.assessment.status,
        supportsCancellation: result.assessment.supportsCancellation,
      },
      files: sanitizeVerifiedFiles(result.files),
      status: 'FILES_VERIFIED',
    };
    exitCode = 0;
  } catch (error) {
    const code = errorCode(error);
    const rejected = REJECTION_CODES.has(code);
    output = {
      error: {
        code,
        message: rejected
          ? 'Stable Audio 3 generation evidence did not pass verification.'
          : 'Stable Audio 3 generation evidence could not be verified.',
      },
      status: rejected ? 'VERIFICATION_REJECTED' : 'VERIFICATION_FAILED',
    };
    exitCode = rejected ? 2 : 1;
  }

  writeOutput(`${JSON.stringify(output, null, 2)}\n`);
  return exitCode;
}

export async function loadStableAudio3GenerationEvidenceFile(path) {
  const requestedPath = requireAbsolutePath(
    path,
    'Stable Audio 3 evidence JSON path',
  );
  let pathStat;

  try {
    pathStat = await lstat(requestedPath);
  } catch {
    throw jsonError('Stable Audio 3 evidence JSON is unavailable.');
  }

  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw jsonError(
      'Stable Audio 3 evidence JSON must be a regular file, not a link.',
    );
  }

  let canonicalPath;

  try {
    canonicalPath = await realpath(requestedPath);
  } catch {
    throw jsonError('Stable Audio 3 evidence JSON is unavailable.');
  }

  let fileHandle;

  try {
    fileHandle = await open(canonicalPath, 'r');
    const initialStat = await fileHandle.stat();

    if (
      !initialStat.isFile() ||
      initialStat.size <= 0 ||
      initialStat.size > MAX_EVIDENCE_JSON_BYTES
    ) {
      throw jsonError(
        `Stable Audio 3 evidence JSON must contain from 1 to ${MAX_EVIDENCE_JSON_BYTES} bytes.`,
      );
    }

    const bytes = Buffer.allocUnsafe(initialStat.size);
    let position = 0;

    while (position < bytes.length) {
      const { bytesRead } = await fileHandle.read(
        bytes,
        position,
        bytes.length - position,
        position,
      );

      if (bytesRead === 0) {
        throw jsonError(
          'Stable Audio 3 evidence JSON changed while it was being read.',
        );
      }

      position += bytesRead;
    }

    const finalStat = await fileHandle.stat();

    if (
      finalStat.size !== initialStat.size ||
      finalStat.mtimeMs !== initialStat.mtimeMs ||
      finalStat.ctimeMs !== initialStat.ctimeMs
    ) {
      throw jsonError(
        'Stable Audio 3 evidence JSON changed while it was being read.',
      );
    }

    let text;

    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw jsonError('Stable Audio 3 evidence JSON must use valid UTF-8.');
    }

    try {
      return JSON.parse(text);
    } catch {
      throw jsonError('Stable Audio 3 evidence JSON is malformed.');
    }
  } catch (error) {
    if (error instanceof StableAudio3GenerationEvidenceCliError) {
      throw error;
    }

    throw jsonError('Stable Audio 3 evidence JSON could not be read.');
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function sanitizeVerifiedFiles(value) {
  requireExactKeys(value, ['input', 'model', 'output']);

  if (
    !Array.isArray(value.model) ||
    value.model.length === 0 ||
    value.model.length > MAX_MODEL_FILES
  ) {
    throw invalidVerifierResponse();
  }

  return {
    input: sanitizeAudioFile(value.input),
    model: value.model.map(sanitizeModelFile),
    output: sanitizeAudioFile(value.output),
  };
}

function sanitizeAudioFile(value) {
  requireExactKeys(value, ['sha256', 'sizeBytes', 'wave']);
  requireExactKeys(
    value.wave,
    ['channels', 'container', 'durationSeconds', 'sampleRate'],
  );

  if (
    value.wave.container !== 'RIFF/WAVE' ||
    !Number.isSafeInteger(value.wave.channels) ||
    value.wave.channels <= 0 ||
    !Number.isSafeInteger(value.wave.sampleRate) ||
    value.wave.sampleRate <= 0 ||
    !Number.isFinite(value.wave.durationSeconds) ||
    value.wave.durationSeconds <= 0
  ) {
    throw invalidVerifierResponse();
  }

  return {
    sha256: requireResponseSha256(value.sha256),
    sizeBytes: requireResponseSize(value.sizeBytes),
    wave: {
      channels: value.wave.channels,
      container: 'RIFF/WAVE',
      durationSeconds: value.wave.durationSeconds,
      sampleRate: value.wave.sampleRate,
    },
  };
}

function sanitizeModelFile(value) {
  requireExactKeys(value, ['path', 'sha256', 'sizeBytes']);

  if (
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    value.path.trim() !== value.path ||
    value.path.length > MAX_PATH_LENGTH ||
    isAbsolute(value.path) ||
    value.path.includes('\\') ||
    value.path.includes(':') ||
    value.path
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw invalidVerifierResponse();
  }

  return {
    path: value.path,
    sha256: requireResponseSha256(value.sha256),
    sizeBytes: requireResponseSize(value.sizeBytes),
  };
}

function requireResponseSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw invalidVerifierResponse();
  }

  return value;
}

function requireResponseSize(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidVerifierResponse();
  }

  return value;
}

function requireExactKeys(value, expectedKeys) {
  if (!isRecord(value)) {
    throw invalidVerifierResponse();
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw invalidVerifierResponse();
  }
}

function invalidVerifierResponse() {
  return new StableAudio3GenerationEvidenceCliError(
    'STABLE_AUDIO_3_EVIDENCE_VERIFIER_RESPONSE_INVALID',
    'Stable Audio 3 evidence verifier returned an invalid response.',
  );
}

function validateCliArguments(args) {
  if (!Array.isArray(args) || args.length !== 4) {
    throw new StableAudio3GenerationEvidenceCliError(
      'STABLE_AUDIO_3_EVIDENCE_CLI_USAGE_INVALID',
      'Pass evidence JSON, input WAV, model root, and output WAV absolute paths.',
    );
  }

  return Object.freeze({
    evidencePath: requireAbsolutePath(args[0], 'Evidence JSON path'),
    inputPath: requireAbsolutePath(args[1], 'Generation input path'),
    modelRootPath: requireAbsolutePath(args[2], 'Model root path'),
    outputPath: requireAbsolutePath(args[3], 'Generation output path'),
  });
}

function requireAbsolutePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > MAX_PATH_LENGTH ||
    !isAbsolute(value)
  ) {
    throw new StableAudio3GenerationEvidenceCliError(
      'STABLE_AUDIO_3_EVIDENCE_CLI_USAGE_INVALID',
      `${label} must be one absolute path.`,
    );
  }

  return value;
}

function jsonError(message) {
  return new StableAudio3GenerationEvidenceCliError(
    'STABLE_AUDIO_3_EVIDENCE_JSON_INVALID',
    message,
  );
}

function errorCode(error) {
  const code =
    error &&
    typeof error === 'object' &&
    typeof error.code === 'string'
    ? error.code
    : 'STABLE_AUDIO_3_EVIDENCE_VERIFICATION_FAILED';

  return ERROR_CODE_PATTERN.test(code)
    ? code
    : 'STABLE_AUDIO_3_EVIDENCE_VERIFICATION_FAILED';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMainModule() {
  return (
    typeof process.argv[1] === 'string' &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  );
}

if (isMainModule()) {
  process.exitCode = await runStableAudio3GenerationEvidenceCli(
    process.argv.slice(2),
  );
}
