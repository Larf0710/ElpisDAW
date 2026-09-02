import {
  ACE_STEP_CHANNELS,
  ACE_STEP_COVER_TASK_ID,
  ACE_STEP_COVER_UPSTREAM_TASK_TYPE,
  ACE_STEP_MAX_DURATION_SECONDS,
  ACE_STEP_MIN_DURATION_SECONDS,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PROVIDER_PACKAGE_VERSION,
  ACE_STEP_PROVIDER_RELEASE_TAG,
  ACE_STEP_RUNTIME_PROFILE_ID,
  ACE_STEP_SAMPLE_RATE,
  ACE_STEP_TARGET_TRACK,
  ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
  ACE_STEP_TEXT_TO_MUSIC_TIME_SIGNATURE,
  ACE_STEP_TEXT_TO_MUSIC_UPSTREAM_TASK_TYPE,
  ACE_STEP_UPSTREAM_TASK_TYPE,
} from '../../shared/aceStepProtocol.js';

export {
  ACE_STEP_CHANNELS,
  ACE_STEP_COVER_TASK_ID,
  ACE_STEP_COVER_UPSTREAM_TASK_TYPE,
  ACE_STEP_MAX_DURATION_SECONDS,
  ACE_STEP_MIN_DURATION_SECONDS,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PROVIDER_PACKAGE_VERSION,
  ACE_STEP_PROVIDER_RELEASE_TAG,
  ACE_STEP_RUNTIME_PROFILE_ID,
  ACE_STEP_SAMPLE_RATE,
  ACE_STEP_TARGET_TRACK,
  ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
  ACE_STEP_TEXT_TO_MUSIC_TIME_SIGNATURE,
  ACE_STEP_TEXT_TO_MUSIC_UPSTREAM_TASK_TYPE,
  ACE_STEP_UPSTREAM_TASK_TYPE,
} from '../../shared/aceStepProtocol.js';

export const ACE_STEP_PROVIDER_CODE_REVISION =
  'dce621408bee8c31b4fcf4811682eb9359e1bc94';
export const ACE_STEP_PROVIDER_REPOSITORY =
  'https://github.com/ace-step/ACE-Step-1.5';
export const ACE_STEP_MODEL_REPOSITORY = 'ACE-Step/acestep-v15-base';
export const ACE_STEP_SUPPORT_MODEL_REPOSITORY = 'ACE-Step/Ace-Step1.5';
export const ACE_STEP_SUPPORT_MODEL_REVISION =
  '19671f406d603126926c1b7e2adc169acbcade22';
export const ACE_STEP_PYTORCH_VERSION = '2.7.1+cu128';
export const ACE_STEP_TORCHAUDIO_VERSION = '2.7.1+cu128';
export const ACE_STEP_CUDA_BUILD_VERSION = '12.8';
export const ACE_STEP_TARGET_GPU_NAME = 'NVIDIA GeForce RTX 4060 Ti';
export const ACE_STEP_MINIMUM_GPU_MEMORY_MIB = 15 * 1_024;
export const ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE = 'HUMSTUDIO_ACE_STEP_PYTHON';
export const ACE_STEP_MODEL_ROOT_ENVIRONMENT_VARIABLE =
  'HUMSTUDIO_ACE_STEP_MODEL_ROOT';
export const ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE =
  'HUMSTUDIO_ACE_STEP_CHECKPOINTS_ROOT';
export const ACE_STEP_WORKER_REQUEST_TIMEOUT_MS = 30 * 60 * 1_000;
export const ACE_STEP_INFERENCE_STEPS = 64;
export const ACE_STEP_GUIDANCE_SCALE = 8;
export const ACE_STEP_USE_ADG = true;
export const ACE_STEP_CFG_INTERVAL_START = 0;
export const ACE_STEP_CFG_INTERVAL_END = 1;
export const ACE_STEP_SHIFT = 3;
export const ACE_STEP_DCW_ENABLED = false;
export const ACE_STEP_GENERATION_INSTRUCTION =
  'Generate the VOCALS track based on the audio context:';
export const ACE_STEP_TEXT_TO_MUSIC_GENERATION_INSTRUCTION =
  'Fill the audio semantic mask based on the given conditions:';
export const ACE_STEP_COVER_GENERATION_INSTRUCTION =
  'Generate audio semantic tokens based on the given conditions:';
export const ACE_STEP_BASE_QUALITY_EVIDENCE_SHA256 =
  '2204a0a5155009f2cf7c3e125476d7b7d293d6ffc1db3b9e1ed0142fe65c8609';
export const ACE_STEP_TEXT_TO_MUSIC_OUTPUT_SHA256 =
  '9db5506f03b2d41bce158cc3b4b7b57684eba9ee80c695ed175e74d9c09f4691';
export const ACE_STEP_COVER_OUTPUT_SHA256 =
  'c559be2c71085561d2ddbcba2ec0d18942a7d57e80720b235a2d68cb78b7013a';
export const ACE_STEP_LEGO_VOCALS_OUTPUT_SHA256 =
  '3e4c8f812f94ec6bc0f79c6dda3e7b793c68986499cfa50228f100dc7de47dc0';
export const ACE_STEP_RUNTIME_PROFILE = Object.freeze({
  blockers: Object.freeze([]),
  compatibility: 'COMPATIBLE',
  generation: Object.freeze({
    audioFormat: 'wav',
    batchSize: 1,
    cfgIntervalEnd: ACE_STEP_CFG_INTERVAL_END,
    cfgIntervalStart: ACE_STEP_CFG_INTERVAL_START,
    dcwEnabled: ACE_STEP_DCW_ENABLED,
    guidanceScale: ACE_STEP_GUIDANCE_SCALE,
    inferenceSteps: ACE_STEP_INFERENCE_STEPS,
    instruction: ACE_STEP_GENERATION_INSTRUCTION,
    shift: ACE_STEP_SHIFT,
    targetTrack: ACE_STEP_TARGET_TRACK,
    taskType: ACE_STEP_UPSTREAM_TASK_TYPE,
    thinking: false,
    useAdg: ACE_STEP_USE_ADG,
  }),
  model: Object.freeze({
    access: 'PUBLIC',
    channels: ACE_STEP_CHANNELS,
    compatibility: 'COMPATIBLE',
    maximumDurationSeconds: ACE_STEP_MAX_DURATION_SECONDS,
    minimumDurationSeconds: ACE_STEP_MIN_DURATION_SECONDS,
    repository: ACE_STEP_MODEL_REPOSITORY,
    revision: ACE_STEP_MODEL_REVISION,
    sampleRate: ACE_STEP_SAMPLE_RATE,
  }),
  profileId: ACE_STEP_RUNTIME_PROFILE_ID,
  providerPackage: Object.freeze({
    name: 'ace-step',
    python: '>=3.11,<3.13',
    releaseTag: ACE_STEP_PROVIDER_RELEASE_TAG,
    repository: ACE_STEP_PROVIDER_REPOSITORY,
    revision: ACE_STEP_PROVIDER_CODE_REVISION,
    version: ACE_STEP_PROVIDER_PACKAGE_VERSION,
  }),
  promotionReview: Object.freeze({
    assessment: 'REAL_BASE_QUALITY_PROFILE_VERIFIED',
    audibleAssessment: 'MASTER_CONFIRMED',
    evidenceSha256: ACE_STEP_BASE_QUALITY_EVIDENCE_SHA256,
    outputSha256ByTask: Object.freeze({
      cover: ACE_STEP_COVER_OUTPUT_SHA256,
      legoVocals: ACE_STEP_LEGO_VOCALS_OUTPUT_SHA256,
      textToMusic: ACE_STEP_TEXT_TO_MUSIC_OUTPUT_SHA256,
    }),
    reviewedAt: '2026-08-31',
  }),
  runtime: Object.freeze({
    cudaBuild: ACE_STEP_CUDA_BUILD_VERSION,
    pytorch: ACE_STEP_PYTORCH_VERSION,
    torchaudio: ACE_STEP_TORCHAUDIO_VERSION,
  }),
  target: Object.freeze({
    architecture: 'x64',
    gpu: Object.freeze({
      minimumDedicatedMemoryMiB: ACE_STEP_MINIMUM_GPU_MEMORY_MIB,
      name: ACE_STEP_TARGET_GPU_NAME,
    }),
    platform: 'win32',
    python: Object.freeze({
      implementation: 'CPython',
      major: 3,
      minor: 11,
    }),
  }),
  targetObservation: Object.freeze({
    assessment: 'RUNTIME_REQUIREMENTS_MET',
    gpuDedicatedMemoryMiB: 16_379,
    gpuDriverVersion: '610.88',
    gpuName: ACE_STEP_TARGET_GPU_NAME,
    observedAt: '2026-08-12',
    pythonVersion: '3.11.9',
  }),
});

export const ACE_STEP_LICENSE_PROFILE = Object.freeze({
  modelWeights: Object.freeze({
    access: 'PUBLIC',
    component: 'ACE-Step 1.5 Base model weights',
    licenseSpdx: 'MIT',
    repository: ACE_STEP_MODEL_REPOSITORY,
    revision: ACE_STEP_MODEL_REVISION,
    sourceUrl:
      `https://huggingface.co/${ACE_STEP_MODEL_REPOSITORY}/tree/${ACE_STEP_MODEL_REVISION}`,
  }),
  providerCode: Object.freeze({
    component: 'ACE-Step 1.5 inference provider',
    licenseSpdx: 'MIT',
    sourceUrl:
      `${ACE_STEP_PROVIDER_REPOSITORY}/blob/${ACE_STEP_PROVIDER_CODE_REVISION}/LICENSE`,
    version: ACE_STEP_PROVIDER_RELEASE_TAG,
  }),
  review: Object.freeze({
    distributionApproved: false,
    generatedOutputTerms: 'NOT_SEPARATELY_REVIEWED',
    modelLicenseRecorded: true,
    trainingCorpusClaims: 'NOT_INDEPENDENTLY_VERIFIED',
    transitiveDependencyLicenses: 'PENDING',
  }),
});
