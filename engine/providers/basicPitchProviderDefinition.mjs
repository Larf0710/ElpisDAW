import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  ProviderContractValidationError,
  providerSupportsJob,
  validateProviderDescriptor,
  validateProviderJob,
} from './providerContract.mjs';
import {
  BASIC_PITCH_PROVIDER_VERSION,
  BASIC_PITCH_RUNTIME_PROFILE_ID,
} from './basicPitchRuntimeProfile.mjs';

export const BASIC_PITCH_PROVIDER_ID = 'local-basic-pitch';
export const BASIC_PITCH_TASK_ID = 'hum-to-midi';
export const BASIC_PITCH_MODEL_ID = 'basic-pitch-icassp-2022';
export const BASIC_PITCH_MODEL_REVISION = '0.4.0-onnx';
export const BASIC_PITCH_TICKS_PER_QUARTER = 960;

export const BASIC_PITCH_PROVIDER_DESCRIPTOR = validateProviderDescriptor({
  capabilities: [
    {
      inputArtifactKinds: ['audio'],
      outputArtifactKind: 'midi',
      supportsCancellation: false,
      taskId: BASIC_PITCH_TASK_ID,
    },
  ],
  displayName: 'Local Basic Pitch',
  models: [
    {
      compatibility: 'PARTIAL_SUPPORT',
      modelId: BASIC_PITCH_MODEL_ID,
      revision: BASIC_PITCH_MODEL_REVISION,
      taskIds: [BASIC_PITCH_TASK_ID],
    },
  ],
  providerId: BASIC_PITCH_PROVIDER_ID,
  protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
  runtime: {
    compatibility: 'COMPATIBLE',
    profile: BASIC_PITCH_RUNTIME_PROFILE_ID,
    version: BASIC_PITCH_PROVIDER_VERSION,
  },
});

export function validateBasicPitchProviderJob(value) {
  const job = validateProviderJob(value);

  if (!providerSupportsJob(BASIC_PITCH_PROVIDER_DESCRIPTOR, job)) {
    throw createBasicPitchValidationError(
      'BASIC_PITCH_JOB_UNSUPPORTED',
      'Basic Pitch does not support the requested Provider, Model, revision, or Task.',
    );
  }

  if (
    job.inputArtifacts.length !== 1 ||
    job.inputArtifacts[0]?.kind !== 'audio' ||
    typeof job.inputArtifacts[0]?.path !== 'string' ||
    job.inputArtifacts[0]?.midi !== undefined ||
    job.output.kind !== 'midi'
  ) {
    throw createBasicPitchValidationError(
      'BASIC_PITCH_JOB_ARTIFACTS_INVALID',
      'Basic Pitch requires one path-backed audio input and one inline MIDI output.',
    );
  }

  validateBasicPitchParameters(job.parameters);
  return job;
}

export function validateBasicPitchParameters(parameters) {
  if (!isRecord(parameters)) {
    throw createBasicPitchValidationError(
      'BASIC_PITCH_PARAMETERS_INVALID',
      'Basic Pitch parameters must be an object.',
    );
  }

  const expectedKeys = [
    'frameThreshold',
    'maximumFrequencyHz',
    'melodiaTrick',
    'minimumFrequencyHz',
    'minimumNoteLengthMs',
    'multiplePitchBends',
    'onsetThreshold',
    'projectBpm',
    'sourceEndSeconds',
    'sourceStartSeconds',
    'ticksPerQuarter',
  ];
  const parameterKeys = Object.keys(parameters).sort();

  if (
    parameterKeys.length !== expectedKeys.length ||
    parameterKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw createBasicPitchValidationError(
      'BASIC_PITCH_PARAMETERS_INVALID',
      `Basic Pitch parameters must contain exactly ${expectedKeys.join(', ')}.`,
    );
  }

  const {
    frameThreshold,
    maximumFrequencyHz,
    melodiaTrick,
    minimumFrequencyHz,
    minimumNoteLengthMs,
    multiplePitchBends,
    onsetThreshold,
    projectBpm,
    sourceEndSeconds,
    sourceStartSeconds,
    ticksPerQuarter,
  } = parameters;

  if (!isUnitInterval(onsetThreshold) || !isUnitInterval(frameThreshold)) {
    throw createBasicPitchValidationError(
      'BASIC_PITCH_PARAMETERS_INVALID',
      'Basic Pitch onsetThreshold and frameThreshold must be from 0 through 1.',
    );
  }

  if (
    typeof minimumNoteLengthMs !== 'number' ||
    !Number.isFinite(minimumNoteLengthMs) ||
    minimumNoteLengthMs <= 0 ||
    minimumNoteLengthMs > 5_000
  ) {
    throw createBasicPitchValidationError(
      'BASIC_PITCH_PARAMETERS_INVALID',
      'Basic Pitch minimumNoteLengthMs must be greater than 0 and no more than 5000.',
    );
  }

  if (
    typeof minimumFrequencyHz !== 'number' ||
    !Number.isFinite(minimumFrequencyHz) ||
    minimumFrequencyHz < 20 ||
    typeof maximumFrequencyHz !== 'number' ||
    !Number.isFinite(maximumFrequencyHz) ||
    maximumFrequencyHz <= minimumFrequencyHz ||
    maximumFrequencyHz > 5_000
  ) {
    throw createBasicPitchValidationError(
      'BASIC_PITCH_PARAMETERS_INVALID',
      'Basic Pitch frequency range must be finite, increasing, and within 20 through 5000 Hz.',
    );
  }

  if (typeof melodiaTrick !== 'boolean' || multiplePitchBends !== false) {
    throw createBasicPitchValidationError(
      'BASIC_PITCH_PARAMETERS_INVALID',
      'Basic Pitch melodiaTrick must be boolean and multiplePitchBends must be false for ElpisDAW v0.1.',
    );
  }

  if (
    typeof projectBpm !== 'number' ||
    !Number.isFinite(projectBpm) ||
    projectBpm < 40 ||
    projectBpm > 240
  ) {
    throw createBasicPitchValidationError(
      'BASIC_PITCH_PARAMETERS_INVALID',
      'Basic Pitch projectBpm must be from 40 through 240.',
    );
  }

  if (
    typeof sourceStartSeconds !== 'number' ||
    !Number.isFinite(sourceStartSeconds) ||
    sourceStartSeconds < 0 ||
    typeof sourceEndSeconds !== 'number' ||
    !Number.isFinite(sourceEndSeconds) ||
    sourceEndSeconds <= sourceStartSeconds
  ) {
    throw createBasicPitchValidationError(
      'BASIC_PITCH_PARAMETERS_INVALID',
      'Basic Pitch source range must be finite, non-negative, and increasing.',
    );
  }

  if (ticksPerQuarter !== BASIC_PITCH_TICKS_PER_QUARTER) {
    throw createBasicPitchValidationError(
      'BASIC_PITCH_PARAMETERS_INVALID',
      `Basic Pitch ticksPerQuarter must be ${BASIC_PITCH_TICKS_PER_QUARTER}.`,
    );
  }

  return Object.freeze({
    frameThreshold,
    maximumFrequencyHz,
    melodiaTrick,
    minimumFrequencyHz,
    minimumNoteLengthMs,
    multiplePitchBends,
    onsetThreshold,
    projectBpm,
    sourceEndSeconds,
    sourceStartSeconds,
    ticksPerQuarter,
  });
}

function isUnitInterval(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function createBasicPitchValidationError(code, message) {
  const error = new ProviderContractValidationError(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
