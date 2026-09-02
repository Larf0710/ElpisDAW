import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TASK_ID,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../../shared/stableAudio3Protocol.js';

export {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TASK_ID,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../../shared/stableAudio3Protocol.js';

import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  ProviderContractValidationError,
  providerDeclaresJob,
  providerSupportsJob,
  validateProviderDescriptor,
  validateProviderJob,
} from './providerContract.mjs';
import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MAX_DURATION_SECONDS,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
  STABLE_AUDIO_3_SAMPLE_RATE,
} from './stableAudio3RuntimeProfile.mjs';

export const STABLE_AUDIO_3_PROVIDER_DESCRIPTOR = validateProviderDescriptor({
  capabilities: [
    {
      inputArtifactKinds: ['audio'],
      outputArtifactKind: 'audio',
      supportsCancellation: true,
      taskId: STABLE_AUDIO_3_TASK_ID,
    },
    {
      inputArtifactKinds: [],
      outputArtifactKind: 'audio',
      supportsCancellation: true,
      taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
    },
  ],
  displayName: 'Local Stable Audio 3',
  models: [
    {
      compatibility: 'PARTIAL_SUPPORT',
      modelId: STABLE_AUDIO_3_MODEL_ID,
      revision: STABLE_AUDIO_3_MODEL_REVISION,
      taskIds: [
        STABLE_AUDIO_3_TASK_ID,
        STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
      ],
    },
  ],
  providerId: STABLE_AUDIO_3_PROVIDER_ID,
  protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
  runtime: {
    compatibility: 'COMPATIBLE',
    profile: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
    version: STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  },
});

export function validateStableAudio3ProviderJob(value) {
  const job = validateProviderJob(value);

  if (!providerDeclaresJob(STABLE_AUDIO_3_PROVIDER_DESCRIPTOR, job)) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_JOB_UNSUPPORTED',
      'Stable Audio 3 does not declare the requested Provider, Model, revision, or Task.',
    );
  }

  if (job.output.kind !== 'audio') {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_JOB_ARTIFACTS_INVALID',
      'Stable Audio 3 requires one staged audio output.',
    );
  }

  if (job.taskId === STABLE_AUDIO_3_TASK_ID) {
    if (
      job.inputArtifacts.length !== 1 ||
      job.inputArtifacts[0]?.kind !== 'audio' ||
      typeof job.inputArtifacts[0]?.path !== 'string' ||
      job.inputArtifacts[0]?.midi !== undefined
    ) {
      throw createStableAudio3ValidationError(
        'STABLE_AUDIO_3_JOB_ARTIFACTS_INVALID',
        'Stable Audio 3 Audio-to-Audio requires one path-backed audio input.',
      );
    }

    validateStableAudio3Parameters(job.parameters);
  } else if (job.taskId === STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID) {
    if (job.inputArtifacts.length !== 0) {
      throw createStableAudio3ValidationError(
        'STABLE_AUDIO_3_JOB_ARTIFACTS_INVALID',
        'Stable Audio 3 Text-to-Audio requires no input Artifacts.',
      );
    }

    validateStableAudio3TextToAudioParameters(job.parameters);
  } else {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_JOB_UNSUPPORTED',
      'Stable Audio 3 Task is unsupported.',
    );
  }

  if (!providerSupportsJob(STABLE_AUDIO_3_PROVIDER_DESCRIPTOR, job)) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_EXECUTION_UNAVAILABLE',
      'Stable Audio 3 execution requires the promoted exact Windows Runtime and Model Profile.',
    );
  }

  return job;
}

export function validateStableAudio3Parameters(parameters) {
  if (!isRecord(parameters)) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      'Stable Audio 3 parameters must be an object.',
    );
  }

  const expectedKeys = [
    'channels',
    'durationSeconds',
    'prompt',
    'sampleRate',
    'seed',
    'sourceEndSeconds',
    'sourceStartSeconds',
    'strength',
  ];
  const parameterKeys = Object.keys(parameters).sort();

  if (
    parameterKeys.length !== expectedKeys.length ||
    parameterKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      `Stable Audio 3 parameters must contain exactly ${expectedKeys.join(', ')}.`,
    );
  }

  const {
    channels,
    durationSeconds,
    prompt,
    sampleRate,
    seed,
    sourceEndSeconds,
    sourceStartSeconds,
    strength,
  } = parameters;

  if (channels !== STABLE_AUDIO_3_CHANNELS || sampleRate !== STABLE_AUDIO_3_SAMPLE_RATE) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      `Stable Audio 3 output must be ${STABLE_AUDIO_3_CHANNELS}-channel ${STABLE_AUDIO_3_SAMPLE_RATE} Hz audio.`,
    );
  }

  if (
    typeof prompt !== 'string' ||
    prompt.length === 0 ||
    prompt.trim() !== prompt ||
    prompt.length > 2_000
  ) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      'Stable Audio 3 prompt must be a non-empty trimmed string within 2000 characters.',
    );
  }

  if (
    typeof strength !== 'number' ||
    !Number.isFinite(strength) ||
    strength < 0 ||
    strength > 1
  ) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      'Stable Audio 3 strength must be from 0 through 1.',
    );
  }

  if (
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    seed > 0xffff_ffff
  ) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      'Stable Audio 3 seed must be an integer from 0 through 4294967295.',
    );
  }

  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > STABLE_AUDIO_3_MAX_DURATION_SECONDS
  ) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      `Stable Audio 3 durationSeconds must be greater than 0 and no more than ${STABLE_AUDIO_3_MAX_DURATION_SECONDS}.`,
    );
  }

  if (
    typeof sourceStartSeconds !== 'number' ||
    !Number.isFinite(sourceStartSeconds) ||
    sourceStartSeconds < 0 ||
    typeof sourceEndSeconds !== 'number' ||
    !Number.isFinite(sourceEndSeconds) ||
    sourceEndSeconds <= sourceStartSeconds ||
    sourceEndSeconds - sourceStartSeconds > STABLE_AUDIO_3_MAX_DURATION_SECONDS
  ) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      `Stable Audio 3 source range must be finite, non-negative, increasing, and no longer than ${STABLE_AUDIO_3_MAX_DURATION_SECONDS} seconds.`,
    );
  }

  return Object.freeze({
    channels,
    durationSeconds,
    prompt,
    sampleRate,
    seed,
    sourceEndSeconds,
    sourceStartSeconds,
    strength,
  });
}

export function validateStableAudio3TextToAudioParameters(parameters) {
  if (!isRecord(parameters)) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      'Stable Audio 3 Text-to-Audio parameters must be an object.',
    );
  }

  const expectedKeys = [
    'channels',
    'durationSeconds',
    'prompt',
    'sampleRate',
    'seed',
  ];
  const parameterKeys = Object.keys(parameters).sort();

  if (
    parameterKeys.length !== expectedKeys.length ||
    parameterKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      `Stable Audio 3 Text-to-Audio parameters must contain exactly ${expectedKeys.join(', ')}.`,
    );
  }

  const { channels, durationSeconds, prompt, sampleRate, seed } = parameters;

  if (channels !== STABLE_AUDIO_3_CHANNELS || sampleRate !== STABLE_AUDIO_3_SAMPLE_RATE) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      `Stable Audio 3 output must be ${STABLE_AUDIO_3_CHANNELS}-channel ${STABLE_AUDIO_3_SAMPLE_RATE} Hz audio.`,
    );
  }

  if (
    typeof prompt !== 'string' ||
    prompt.length === 0 ||
    prompt.trim() !== prompt ||
    prompt.length > 2_000
  ) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      'Stable Audio 3 prompt must be a non-empty trimmed string within 2000 characters.',
    );
  }

  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      'Stable Audio 3 seed must be an integer from 0 through 4294967295.',
    );
  }

  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > STABLE_AUDIO_3_MAX_DURATION_SECONDS
  ) {
    throw createStableAudio3ValidationError(
      'STABLE_AUDIO_3_PARAMETERS_INVALID',
      `Stable Audio 3 durationSeconds must be greater than 0 and no more than ${STABLE_AUDIO_3_MAX_DURATION_SECONDS}.`,
    );
  }

  return Object.freeze({
    channels,
    durationSeconds,
    prompt,
    sampleRate,
    seed,
  });
}

function createStableAudio3ValidationError(code, message) {
  const error = new ProviderContractValidationError(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
