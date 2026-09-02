import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MAX_DURATION_SECONDS,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
  STABLE_AUDIO_3_SAMPLE_RATE,
} from '../../shared/stableAudio3Protocol.js';

export {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MAX_DURATION_SECONDS,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
  STABLE_AUDIO_3_SAMPLE_RATE,
} from '../../shared/stableAudio3Protocol.js';

export const STABLE_AUDIO_3_PROVIDER_CODE_REVISION =
  '9ae61a0ae72fb22c80caf00378c61882fff25921';
export const STABLE_AUDIO_3_MODEL_REPOSITORY =
  'stabilityai/stable-audio-3-medium';
export const STABLE_AUDIO_3_GENERATION_EVIDENCE_PROFILE_ID =
  'windows-x64-cpython-3-10-pytorch-2-7-1-cu126-unverified';
export const STABLE_AUDIO_3_GENERATION_EVIDENCE_SHA256 =
  '198cc2d2af32eec6764e69b0f9f7718029b324bdaa4cae8b09f9b14915ad0047';
export const STABLE_AUDIO_3_GENERATION_OUTPUT_SHA256 =
  '621a2977a4bef6bf196c4d0522bce06af90f8d63b710ea0358ce9f48cf752230';
export const STABLE_AUDIO_3_GENERATION_VERIFICATION_SHA256 =
  '2d85635d2e67c8863b4ebd8847e7c2796e4010eff2570e28ee548facdd161c34';
export const STABLE_AUDIO_3_PYTORCH_VERSION = '2.7.1';
export const STABLE_AUDIO_3_TORCHAUDIO_VERSION = '2.7.1';
export const STABLE_AUDIO_3_CUDA_VERSION = '12.6';
export const STABLE_AUDIO_3_FLASH_ATTENTION_VERSION = '2.8.3';
export const STABLE_AUDIO_3_FLASH_ATTENTION_SOURCE_REVISION =
  '060c9188beec3a8b62b33a3bfa6d5d2d44975fab';
export const STABLE_AUDIO_3_FLASH_ATTENTION_WHEEL_SHA256 =
  '74e2409ecafcfe1a5f07e64acfd309d87f0f1a69cdc557861c72787767031a28';
export const STABLE_AUDIO_3_TARGET_GPU_NAME = 'NVIDIA GeForce RTX 4060 Ti';
export const STABLE_AUDIO_3_MINIMUM_GPU_MEMORY_MIB = 12 * 1_024;
export const STABLE_AUDIO_3_PYTHON_ENVIRONMENT_VARIABLE =
  'HUMSTUDIO_STABLE_AUDIO_3_PYTHON';
export const STABLE_AUDIO_3_MODEL_ROOT_ENVIRONMENT_VARIABLE =
  'HUMSTUDIO_STABLE_AUDIO_3_MODEL_ROOT';
export const STABLE_AUDIO_3_WORKER_REQUEST_TIMEOUT_MS = 30 * 60 * 1_000;
export const STABLE_AUDIO_3_INFERENCE_STEPS = 8;
export const STABLE_AUDIO_3_CFG_SCALE = 1;
export const STABLE_AUDIO_3_CHUNKED_DECODE = true;

export const STABLE_AUDIO_3_RUNTIME_PROFILE = Object.freeze({
  blockers: Object.freeze([]),
  compatibility: 'COMPATIBLE',
  model: Object.freeze({
    access: 'GATED_TERMS_ACCEPTED',
    channels: STABLE_AUDIO_3_CHANNELS,
    maximumDurationSeconds: STABLE_AUDIO_3_MAX_DURATION_SECONDS,
    repository: STABLE_AUDIO_3_MODEL_REPOSITORY,
    revision: STABLE_AUDIO_3_MODEL_REVISION,
    sampleRate: STABLE_AUDIO_3_SAMPLE_RATE,
  }),
  profileId: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
  providerPackage: Object.freeze({
    name: 'stable-audio-3',
    python: '>=3.10',
    repository: 'https://github.com/Stability-AI/stable-audio-3',
    revision: STABLE_AUDIO_3_PROVIDER_CODE_REVISION,
    version: STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  }),
  promotionReview: Object.freeze({
    assessment: 'ACCEPTED_FOR_REVIEW',
    evidenceSha256: STABLE_AUDIO_3_GENERATION_EVIDENCE_SHA256,
    evidenceProfileId: STABLE_AUDIO_3_GENERATION_EVIDENCE_PROFILE_ID,
    fileStatus: 'FILES_VERIFIED',
    generationOutputSha256: STABLE_AUDIO_3_GENERATION_OUTPUT_SHA256,
    reviewedAt: '2026-08-05',
    verificationSha256: STABLE_AUDIO_3_GENERATION_VERIFICATION_SHA256,
  }),
  runtime: Object.freeze({
    cuda: `${STABLE_AUDIO_3_CUDA_VERSION}.3-native-windows-toolkit`,
    flashAttention: `${STABLE_AUDIO_3_FLASH_ATTENTION_VERSION}-native-windows-local-wheel`,
    flashAttentionSourceRevision:
      STABLE_AUDIO_3_FLASH_ATTENTION_SOURCE_REVISION,
    flashAttentionWheelSha256: STABLE_AUDIO_3_FLASH_ATTENTION_WHEEL_SHA256,
    flashAttentionWheelTag: 'cp310-cp310-win_amd64',
    pytorch: STABLE_AUDIO_3_PYTORCH_VERSION,
    torchaudio: STABLE_AUDIO_3_TORCHAUDIO_VERSION,
  }),
  target: Object.freeze({
    architecture: 'x64',
    gpu: Object.freeze({
      cudaUmdVersion: '13.3',
      dedicatedMemoryMiB: 16_380,
      driverVersion: '610.88',
      name: STABLE_AUDIO_3_TARGET_GPU_NAME,
    }),
    platform: 'win32',
    pythonLauncherDetected: true,
    verifiedAt: '2026-08-05',
  }),
});

export const STABLE_AUDIO_3_LICENSE_PROFILE = Object.freeze({
  modelWeights: Object.freeze({
    access: 'GATED',
    commercialRegistrationRequired: true,
    component: 'Stable Audio 3 Medium model weights',
    enterpriseLicenseRevenueThresholdUsd: 1_000_000,
    licenseName: 'Stability AI Community License',
    licenseUrl:
      'https://huggingface.co/stabilityai/stable-audio-3-medium/blob/main/LICENSE.md',
    repository: STABLE_AUDIO_3_MODEL_REPOSITORY,
    revision: STABLE_AUDIO_3_MODEL_REVISION,
  }),
  providerCode: Object.freeze({
    component: 'stable-audio-3 inference library',
    licenseSpdx: 'MIT',
    sourceUrl:
      `https://github.com/Stability-AI/stable-audio-3/blob/${STABLE_AUDIO_3_PROVIDER_CODE_REVISION}/LICENSE`,
    version: STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  }),
  review: Object.freeze({
    distributionApproved: false,
    modelAccessAccepted: true,
    transitiveDependencyLicenses: 'PENDING',
  }),
  textEncoder: Object.freeze({
    component: 'T5Gemma',
    licenseName: 'Gemma Terms of Use',
    termsAccepted: true,
    termsUrl: 'https://ai.google.dev/gemma/terms',
  }),
});
