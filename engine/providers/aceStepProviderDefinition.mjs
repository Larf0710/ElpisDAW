import {
  ACE_STEP_COVER_TASK_ID,
  ACE_STEP_MODEL_ID,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_TASK_ID,
  ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
} from '../../shared/aceStepProtocol.js';

export {
  ACE_STEP_COVER_TASK_ID,
  ACE_STEP_MODEL_ID,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_TASK_ID,
  ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
} from '../../shared/aceStepProtocol.js';

import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  ProviderContractValidationError,
  providerDeclaresJob,
  providerSupportsJob,
  validateProviderDescriptor,
  validateProviderJob,
} from './providerContract.mjs';
import {
  ACE_STEP_CHANNELS,
  ACE_STEP_COVER_UPSTREAM_TASK_TYPE,
  ACE_STEP_GUIDANCE_SCALE,
  ACE_STEP_INFERENCE_STEPS,
  ACE_STEP_MAX_DURATION_SECONDS,
  ACE_STEP_MIN_DURATION_SECONDS,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PROVIDER_PACKAGE_VERSION,
  ACE_STEP_RUNTIME_PROFILE_ID,
  ACE_STEP_SAMPLE_RATE,
  ACE_STEP_TARGET_TRACK,
  ACE_STEP_TEXT_TO_MUSIC_TIME_SIGNATURE,
  ACE_STEP_TEXT_TO_MUSIC_UPSTREAM_TASK_TYPE,
  ACE_STEP_UPSTREAM_TASK_TYPE,
} from './aceStepRuntimeProfile.mjs';

export const ACE_STEP_PROVIDER_DESCRIPTOR = validateProviderDescriptor({
  capabilities: [
    {
      inputArtifactKinds: ['audio', 'lyrics'],
      outputArtifactKind: 'audio',
      supportsCancellation: true,
      taskId: ACE_STEP_TASK_ID,
    },
    {
      inputArtifactKinds: ['lyrics'],
      outputArtifactKind: 'audio',
      supportsCancellation: true,
      taskId: ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
    },
    {
      inputArtifactKinds: ['audio', 'lyrics'],
      outputArtifactKind: 'audio',
      supportsCancellation: true,
      taskId: ACE_STEP_COVER_TASK_ID,
    },
  ],
  displayName: 'Local ACE-Step',
  models: [
    {
      compatibility: 'COMPATIBLE',
      modelId: ACE_STEP_MODEL_ID,
      revision: ACE_STEP_MODEL_REVISION,
      taskIds: [
        ACE_STEP_TASK_ID,
        ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
        ACE_STEP_COVER_TASK_ID,
      ],
    },
  ],
  providerId: ACE_STEP_PROVIDER_ID,
  protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
  runtime: {
    compatibility: 'COMPATIBLE',
    profile: ACE_STEP_RUNTIME_PROFILE_ID,
    version: ACE_STEP_PROVIDER_PACKAGE_VERSION,
  },
});

export function validateAceStepProviderJob(value) {
  const job = validateProviderJob(value);

  if (!providerDeclaresJob(ACE_STEP_PROVIDER_DESCRIPTOR, job)) {
    throw createAceStepValidationError(
      'ACE_STEP_JOB_UNSUPPORTED',
      'ACE-Step does not declare the requested Provider, Model, revision, or Task.',
    );
  }

  const hasValidArtifacts =
    job.taskId === ACE_STEP_TASK_ID
      ? job.inputArtifacts.length === 2 &&
        job.inputArtifacts[0]?.kind === 'audio' &&
        typeof job.inputArtifacts[0]?.path === 'string' &&
        job.inputArtifacts[0]?.midi === undefined &&
        job.inputArtifacts[1]?.kind === 'lyrics' &&
        typeof job.inputArtifacts[1]?.path === 'string' &&
        job.inputArtifacts[1]?.midi === undefined
      : job.taskId === ACE_STEP_TEXT_TO_MUSIC_TASK_ID
        ? job.inputArtifacts.length === 1 &&
          job.inputArtifacts[0]?.kind === 'lyrics' &&
          typeof job.inputArtifacts[0]?.path === 'string' &&
          job.inputArtifacts[0]?.midi === undefined
        : job.taskId === ACE_STEP_COVER_TASK_ID &&
          job.inputArtifacts.length === 2 &&
          job.inputArtifacts[0]?.kind === 'audio' &&
          typeof job.inputArtifacts[0]?.path === 'string' &&
          job.inputArtifacts[0]?.midi === undefined &&
          job.inputArtifacts[1]?.kind === 'lyrics' &&
          typeof job.inputArtifacts[1]?.path === 'string' &&
          job.inputArtifacts[1]?.midi === undefined;

  if (!hasValidArtifacts || job.output.kind !== 'audio') {
    throw createAceStepValidationError(
      'ACE_STEP_JOB_ARTIFACTS_INVALID',
      'ACE-Step requires the exact path-backed inputs declared by its Task and one staged audio output.',
    );
  }

  validateAceStepParameters(job.parameters, job.taskId);

  if (!providerSupportsJob(ACE_STEP_PROVIDER_DESCRIPTOR, job)) {
    throw createAceStepValidationError(
      'ACE_STEP_EXECUTION_UNAVAILABLE',
      'ACE-Step execution requires verified Runtime, Model files, and real Lego vocals generation evidence.',
    );
  }

  return job;
}

export function validateAceStepParameters(parameters, taskId = ACE_STEP_TASK_ID) {
  if (!isRecord(parameters)) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step parameters must be an object.',
    );
  }

  if (taskId === ACE_STEP_TEXT_TO_MUSIC_TASK_ID) {
    return validateAceStepTextToMusicParameters(parameters);
  }

  if (taskId === ACE_STEP_COVER_TASK_ID) {
    return validateAceStepCoverParameters(parameters);
  }

  if (taskId !== ACE_STEP_TASK_ID) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step Task parameters are unsupported.',
    );
  }

  const expectedKeys = [
    'audioFormat',
    'batchSize',
    'caption',
    'channels',
    'durationSeconds',
    'sampleRate',
    'seed',
    'targetTrack',
    'taskType',
    'thinking',
    'vocalLanguage',
  ];
  const parameterKeys = Object.keys(parameters).sort();

  if (
    parameterKeys.length !== expectedKeys.length ||
    parameterKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      `ACE-Step parameters must contain exactly ${expectedKeys.join(', ')}.`,
    );
  }

  const {
    audioFormat,
    batchSize,
    caption,
    channels,
    durationSeconds,
    sampleRate,
    seed,
    targetTrack,
    taskType,
    thinking,
    vocalLanguage,
  } = parameters;

  if (
    taskType !== ACE_STEP_UPSTREAM_TASK_TYPE ||
    targetTrack !== ACE_STEP_TARGET_TRACK ||
    audioFormat !== 'wav' ||
    batchSize !== 1 ||
    thinking !== false
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step v0.1 requires Base-model Lego vocals, one WAV output, and disabled LM thinking.',
    );
  }

  if (channels !== ACE_STEP_CHANNELS || sampleRate !== ACE_STEP_SAMPLE_RATE) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      `ACE-Step output must be ${ACE_STEP_CHANNELS}-channel ${ACE_STEP_SAMPLE_RATE} Hz audio.`,
    );
  }

  if (
    typeof caption !== 'string' ||
    caption.length === 0 ||
    caption.trim() !== caption ||
    caption.length > 2_000
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step caption must be a non-empty trimmed string within 2000 characters.',
    );
  }

  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < ACE_STEP_MIN_DURATION_SECONDS ||
    durationSeconds > ACE_STEP_MAX_DURATION_SECONDS
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      `ACE-Step durationSeconds must be from ${ACE_STEP_MIN_DURATION_SECONDS} through ${ACE_STEP_MAX_DURATION_SECONDS}.`,
    );
  }

  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step seed must be an integer from 0 through 4294967295.',
    );
  }

  if (
    vocalLanguage !== 'unknown' &&
    (typeof vocalLanguage !== 'string' || !/^[a-z]{2}$/.test(vocalLanguage))
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step vocalLanguage must be unknown or a lowercase ISO 639-1 code.',
    );
  }

  return Object.freeze({
    audioFormat,
    batchSize,
    caption,
    channels,
    durationSeconds,
    sampleRate,
    seed,
    targetTrack,
    taskType,
    thinking,
    vocalLanguage,
  });
}

export function validateAceStepTextToMusicParameters(parameters) {
  if (!isRecord(parameters)) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step Text to Music parameters must be an object.',
    );
  }

  const expectedKeys = [
    'audioFormat',
    'batchSize',
    'bpm',
    'caption',
    'channels',
    'durationSeconds',
    'guidanceScale',
    'inferenceSteps',
    'instrumental',
    'keyscale',
    'sampleRate',
    'seed',
    'taskType',
    'thinking',
    'timesignature',
    'vocalLanguage',
  ];
  const parameterKeys = Object.keys(parameters).sort();

  if (
    parameterKeys.length !== expectedKeys.length ||
    parameterKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      `ACE-Step Text to Music parameters must contain exactly ${expectedKeys.join(', ')}.`,
    );
  }

  const {
    audioFormat,
    batchSize,
    bpm,
    caption,
    channels,
    durationSeconds,
    guidanceScale,
    inferenceSteps,
    instrumental,
    keyscale,
    sampleRate,
    seed,
    taskType,
    thinking,
    timesignature,
    vocalLanguage,
  } = parameters;

  if (
    taskType !== ACE_STEP_TEXT_TO_MUSIC_UPSTREAM_TASK_TYPE ||
    audioFormat !== 'wav' ||
    batchSize !== 1 ||
    thinking !== false ||
    inferenceSteps !== ACE_STEP_INFERENCE_STEPS ||
    guidanceScale !== ACE_STEP_GUIDANCE_SCALE ||
    timesignature !== ACE_STEP_TEXT_TO_MUSIC_TIME_SIGNATURE
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step Text to Music v0.1 requires the pinned Base-model generation defaults.',
    );
  }

  if (channels !== ACE_STEP_CHANNELS || sampleRate !== ACE_STEP_SAMPLE_RATE) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      `ACE-Step Text to Music output must be ${ACE_STEP_CHANNELS}-channel ${ACE_STEP_SAMPLE_RATE} Hz audio.`,
    );
  }

  if (
    typeof caption !== 'string' ||
    caption.length === 0 ||
    caption.trim() !== caption ||
    caption.length > 2_000 ||
    typeof keyscale !== 'string' ||
    keyscale.length === 0 ||
    keyscale.trim() !== keyscale ||
    keyscale.length > 64 ||
    typeof instrumental !== 'boolean'
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step Text to Music caption, Key, and Instrumental mode are invalid.',
    );
  }

  if (
    typeof bpm !== 'number' ||
    !Number.isFinite(bpm) ||
    bpm < 20 ||
    bpm > 300 ||
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < ACE_STEP_MIN_DURATION_SECONDS ||
    durationSeconds > ACE_STEP_MAX_DURATION_SECONDS
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      `ACE-Step Text to Music requires 20-300 BPM and ${ACE_STEP_MIN_DURATION_SECONDS}-${ACE_STEP_MAX_DURATION_SECONDS} seconds.`,
    );
  }

  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step Text to Music seed must be an integer from 0 through 4294967295.',
    );
  }

  if (
    vocalLanguage !== 'unknown' &&
    (typeof vocalLanguage !== 'string' || !/^[a-z]{2}$/.test(vocalLanguage))
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step Text to Music vocalLanguage must be unknown or a lowercase ISO 639-1 code.',
    );
  }

  return Object.freeze({
    audioFormat,
    batchSize,
    bpm,
    caption,
    channels,
    durationSeconds,
    guidanceScale,
    inferenceSteps,
    instrumental,
    keyscale,
    sampleRate,
    seed,
    taskType,
    thinking,
    timesignature,
    vocalLanguage,
  });
}

export function validateAceStepCoverParameters(parameters) {
  if (!isRecord(parameters)) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step Cover parameters must be an object.',
    );
  }

  const expectedKeys = [
    'audioCoverStrength',
    'audioFormat',
    'batchSize',
    'caption',
    'channels',
    'coverNoiseStrength',
    'durationSeconds',
    'guidanceScale',
    'inferenceSteps',
    'instrumental',
    'sampleRate',
    'seed',
    'taskType',
    'thinking',
    'vocalLanguage',
  ];
  const parameterKeys = Object.keys(parameters).sort();

  if (
    parameterKeys.length !== expectedKeys.length ||
    parameterKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      `ACE-Step Cover parameters must contain exactly ${expectedKeys.join(', ')}.`,
    );
  }

  const {
    audioCoverStrength,
    audioFormat,
    batchSize,
    caption,
    channels,
    coverNoiseStrength,
    durationSeconds,
    guidanceScale,
    inferenceSteps,
    instrumental,
    sampleRate,
    seed,
    taskType,
    thinking,
    vocalLanguage,
  } = parameters;

  if (
    taskType !== ACE_STEP_COVER_UPSTREAM_TASK_TYPE ||
    audioFormat !== 'wav' ||
    batchSize !== 1 ||
    thinking !== false ||
    inferenceSteps !== ACE_STEP_INFERENCE_STEPS ||
    guidanceScale !== ACE_STEP_GUIDANCE_SCALE ||
    coverNoiseStrength !== 0 ||
    typeof instrumental !== 'boolean'
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step Cover v0.1 requires the pinned Base-model Remix defaults.',
    );
  }

  if (channels !== ACE_STEP_CHANNELS || sampleRate !== ACE_STEP_SAMPLE_RATE) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      `ACE-Step Cover output must be ${ACE_STEP_CHANNELS}-channel ${ACE_STEP_SAMPLE_RATE} Hz audio.`,
    );
  }

  if (
    typeof caption !== 'string' ||
    caption.length === 0 ||
    caption.trim() !== caption ||
    caption.length > 2_000 ||
    typeof audioCoverStrength !== 'number' ||
    !Number.isFinite(audioCoverStrength) ||
    audioCoverStrength < 0 ||
    audioCoverStrength > 1
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step Cover Prompt or Cover Strength is invalid.',
    );
  }

  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < ACE_STEP_MIN_DURATION_SECONDS ||
    durationSeconds > ACE_STEP_MAX_DURATION_SECONDS
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      `ACE-Step Cover durationSeconds must be from ${ACE_STEP_MIN_DURATION_SECONDS} through ${ACE_STEP_MAX_DURATION_SECONDS}.`,
    );
  }

  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step Cover Seed must be an integer from 0 through 4294967295.',
    );
  }

  if (
    vocalLanguage !== 'unknown' &&
    (typeof vocalLanguage !== 'string' || !/^[a-z]{2}$/.test(vocalLanguage))
  ) {
    throw createAceStepValidationError(
      'ACE_STEP_PARAMETERS_INVALID',
      'ACE-Step Cover vocalLanguage must be unknown or a lowercase ISO 639-1 code.',
    );
  }

  return Object.freeze({
    audioCoverStrength,
    audioFormat,
    batchSize,
    caption,
    channels,
    coverNoiseStrength,
    durationSeconds,
    guidanceScale,
    inferenceSteps,
    instrumental,
    sampleRate,
    seed,
    taskType,
    thinking,
    vocalLanguage,
  });
}

function createAceStepValidationError(code, message) {
  const error = new ProviderContractValidationError(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
