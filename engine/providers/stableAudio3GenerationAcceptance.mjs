import {
  assessStableAudio3RuntimeProbe,
  validateStableAudio3RuntimeProbeReport,
} from './stableAudio3RuntimeProbe.mjs';
import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_FLASH_ATTENTION_VERSION,
  STABLE_AUDIO_3_GENERATION_EVIDENCE_PROFILE_ID,
  STABLE_AUDIO_3_MAX_DURATION_SECONDS,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_MODEL_REPOSITORY,
  STABLE_AUDIO_3_PROVIDER_CODE_REVISION,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_SAMPLE_RATE,
} from './stableAudio3RuntimeProfile.mjs';

const ACCEPTANCE_VERSION = '1';
const MAX_MODEL_FILES = 64;
const MAX_TEXT_LENGTH = 512;
const MODEL_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class StableAudio3GenerationAcceptanceError extends Error {
  constructor(message) {
    super(message);
    this.code = 'STABLE_AUDIO_3_GENERATION_ACCEPTANCE_INVALID';
    this.name = 'StableAudio3GenerationAcceptanceError';
  }
}

export function assessStableAudio3GenerationAcceptance(value) {
  const evidence = validateStableAudio3GenerationAcceptanceRecord(value);
  const runtimeAssessment = assessStableAudio3RuntimeProbe(evidence.runtime);
  const blockers = [];

  if (
    evidence.sourceProfileId !==
    STABLE_AUDIO_3_GENERATION_EVIDENCE_PROFILE_ID
  ) {
    addBlocker(
      blockers,
      'RUNTIME_PROFILE_MISMATCH',
      'Generation evidence does not match the current Stable Audio 3 Runtime Profile.',
    );
  }

  if (evidence.provider.codeRevision !== STABLE_AUDIO_3_PROVIDER_CODE_REVISION) {
    addBlocker(
      blockers,
      'PROVIDER_CODE_REVISION_MISMATCH',
      'Generation evidence does not use the pinned Stable Audio 3 Provider code revision.',
    );
  }

  if (
    evidence.provider.packageVersion !==
    STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION
  ) {
    addBlocker(
      blockers,
      'PROVIDER_PACKAGE_VERSION_MISMATCH',
      'Generation evidence does not use the pinned Stable Audio 3 Provider package version.',
    );
  }

  if (evidence.model.repository !== STABLE_AUDIO_3_MODEL_REPOSITORY) {
    addBlocker(
      blockers,
      'MODEL_REPOSITORY_MISMATCH',
      'Generation evidence does not use the approved Stable Audio 3 model repository.',
    );
  }

  if (!MODEL_REVISION_PATTERN.test(evidence.model.revision)) {
    addBlocker(
      blockers,
      'MODEL_REVISION_UNPINNED',
      'Generation evidence requires one exact lowercase model commit revision.',
    );
  } else if (evidence.model.revision !== STABLE_AUDIO_3_MODEL_REVISION) {
    addBlocker(
      blockers,
      'MODEL_REVISION_MISMATCH',
      'Generation evidence does not use the promoted Stable Audio 3 model revision.',
    );
  }

  if (runtimeAssessment.status !== 'READY_FOR_MODEL_PROBE') {
    addBlocker(
      blockers,
      'RUNTIME_NOT_READY',
      'Generation evidence was not produced by the exact target dependency Runtime.',
    );
  }

  const flashAttention = evidence.runtime.packages.flashAttention;

  if (
    flashAttention.available &&
    flashAttention.importable &&
    flashAttention.version !== STABLE_AUDIO_3_FLASH_ATTENTION_VERSION
  ) {
    addBlocker(
      blockers,
      'FLASH_ATTENTION_VERSION_MISMATCH',
      `Generation evidence must use Flash Attention ${STABLE_AUDIO_3_FLASH_ATTENTION_VERSION}.`,
    );
  }

  if (evidence.generation.output.channels !== STABLE_AUDIO_3_CHANNELS) {
    addBlocker(
      blockers,
      'OUTPUT_CHANNELS_MISMATCH',
      `Stable Audio 3 acceptance output must contain ${STABLE_AUDIO_3_CHANNELS} channels.`,
    );
  }

  if (evidence.generation.output.sampleRate !== STABLE_AUDIO_3_SAMPLE_RATE) {
    addBlocker(
      blockers,
      'OUTPUT_SAMPLE_RATE_MISMATCH',
      `Stable Audio 3 acceptance output must use ${STABLE_AUDIO_3_SAMPLE_RATE} Hz.`,
    );
  }

  if (
    evidence.generation.output.durationSeconds >
    STABLE_AUDIO_3_MAX_DURATION_SECONDS
  ) {
    addBlocker(
      blockers,
      'OUTPUT_DURATION_UNSUPPORTED',
      `Stable Audio 3 acceptance output cannot exceed ${STABLE_AUDIO_3_MAX_DURATION_SECONDS} seconds.`,
    );
  }

  const totalMemoryMiB = runtimeAssessment.environment.cuda.totalMemoryMiB;

  if (
    totalMemoryMiB !== null &&
    evidence.generation.peakGpuMemoryMiB > totalMemoryMiB
  ) {
    addBlocker(
      blockers,
      'PEAK_GPU_MEMORY_INVALID',
      'Generation evidence peak GPU memory exceeds the probed device total.',
    );
  }

  return Object.freeze({
    blockers: Object.freeze(blockers),
    evidence,
    runtimeAssessment,
    status:
      blockers.length === 0 ? 'ACCEPTED_FOR_REVIEW' : 'REJECTED',
    supportsCancellation: evidence.cancellation.outcome === 'SUPPORTED',
  });
}

export function validateStableAudio3GenerationAcceptanceRecord(value) {
  requireExactKeys(
    value,
    [
      'acceptanceVersion',
      'cancellation',
      'generation',
      'model',
      'provider',
      'runtime',
      'sourceProfileId',
    ],
    'Stable Audio 3 generation acceptance record',
  );

  if (value.acceptanceVersion !== ACCEPTANCE_VERSION) {
    throw invalid('Stable Audio 3 generation acceptance version is unsupported.');
  }

  return Object.freeze({
    acceptanceVersion: ACCEPTANCE_VERSION,
    cancellation: validateCancellation(value.cancellation),
    generation: validateGeneration(value.generation),
    model: validateModel(value.model),
    provider: validateProvider(value.provider),
    runtime: validateStableAudio3RuntimeProbeReport(value.runtime),
    sourceProfileId: requireText(value.sourceProfileId, 'Source Runtime Profile ID'),
  });
}

function validateCancellation(value) {
  requireExactKeys(value, ['outcome'], 'Generation cancellation evidence');

  if (value.outcome !== 'SUPPORTED' && value.outcome !== 'UNSUPPORTED') {
    throw invalid('Generation cancellation outcome is invalid.');
  }

  return Object.freeze({ outcome: value.outcome });
}

function validateGeneration(value) {
  requireExactKeys(
    value,
    [
      'elapsedMilliseconds',
      'inputSha256',
      'output',
      'peakGpuMemoryMiB',
      'status',
    ],
    'Generation measurement',
  );

  if (value.status !== 'COMPLETED') {
    throw invalid('Generation acceptance requires one completed probe.');
  }

  return Object.freeze({
    elapsedMilliseconds: requirePositiveInteger(
      value.elapsedMilliseconds,
      'Generation elapsed time',
    ),
    inputSha256: requireSha256(value.inputSha256, 'Generation input hash'),
    output: validateOutput(value.output),
    peakGpuMemoryMiB: requirePositiveInteger(
      value.peakGpuMemoryMiB,
      'Generation peak GPU memory',
    ),
    status: 'COMPLETED',
  });
}

function validateOutput(value) {
  requireExactKeys(
    value,
    [
      'channels',
      'container',
      'durationSeconds',
      'sampleRate',
      'sha256',
      'sizeBytes',
    ],
    'Generation output',
  );

  if (value.container !== 'RIFF/WAVE') {
    throw invalid('Generation output container is invalid.');
  }

  if (!Number.isSafeInteger(value.channels) || value.channels <= 0) {
    throw invalid('Generation output channel count is invalid.');
  }

  if (!Number.isSafeInteger(value.sampleRate) || value.sampleRate <= 0) {
    throw invalid('Generation output sample rate is invalid.');
  }

  if (!Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0) {
    throw invalid('Generation output duration is invalid.');
  }

  return Object.freeze({
    channels: value.channels,
    container: 'RIFF/WAVE',
    durationSeconds: value.durationSeconds,
    sampleRate: value.sampleRate,
    sha256: requireSha256(value.sha256, 'Generation output hash'),
    sizeBytes: requirePositiveInteger(value.sizeBytes, 'Generation output size'),
  });
}

function validateModel(value) {
  requireExactKeys(
    value,
    ['files', 'repository', 'revision'],
    'Generation model evidence',
  );

  if (
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_MODEL_FILES
  ) {
    throw invalid('Generation model file evidence is invalid.');
  }

  const files = value.files.map(validateModelFile);
  const paths = files.map(({ path }) => path);

  if (
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => index > 0 && paths[index - 1] >= path)
  ) {
    throw invalid('Generation model file paths must be unique and sorted.');
  }

  return Object.freeze({
    files: Object.freeze(files),
    repository: requireText(value.repository, 'Generation model repository'),
    revision: requireText(value.revision, 'Generation model revision'),
  });
}

function validateModelFile(value) {
  requireExactKeys(value, ['path', 'sha256', 'sizeBytes'], 'Generation model file');
  const path = requireText(value.path, 'Generation model file path');
  const segments = path.split('/');

  if (
    path.includes('\\') ||
    path.startsWith('/') ||
    path.includes(':') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw invalid('Generation model file path is unsafe.');
  }

  return Object.freeze({
    path,
    sha256: requireSha256(value.sha256, 'Generation model file hash'),
    sizeBytes: requirePositiveInteger(value.sizeBytes, 'Generation model file size'),
  });
}

function validateProvider(value) {
  requireExactKeys(
    value,
    ['codeRevision', 'packageVersion'],
    'Generation Provider evidence',
  );

  return Object.freeze({
    codeRevision: requireText(value.codeRevision, 'Provider code revision'),
    packageVersion: requireText(value.packageVersion, 'Provider package version'),
  });
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) {
    throw invalid(`${label} must be an object.`);
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw invalid(`${label} keys are invalid.`);
  }
}

function requireText(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > MAX_TEXT_LENGTH
  ) {
    throw invalid(`${label} is invalid.`);
  }

  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${label} is invalid.`);
  }

  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw invalid(`${label} must be one lowercase SHA-256 value.`);
  }

  return value;
}

function addBlocker(blockers, code, message) {
  blockers.push(Object.freeze({ code, message }));
}

function invalid(message) {
  return new StableAudio3GenerationAcceptanceError(message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
