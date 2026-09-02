export const BASIC_PITCH_RUNTIME_PROFILE_ID =
  'windows-x64-python-3-10-onnx-cpu';
export const BASIC_PITCH_PROVIDER_VERSION = '0.4.0';
export const BASIC_PITCH_ONNX_RUNTIME_VERSION = '1.23.2';
export const BASIC_PITCH_MODEL_FILENAME = 'nmp.onnx';
export const BASIC_PITCH_MODEL_SHA256 =
  '2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec';
export const BASIC_PITCH_REQUIREMENTS_FILE =
  'engine/providers/basicPitchRuntime.requirements.txt';
export const BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE =
  'HUMSTUDIO_BASIC_PITCH_PYTHON';
export const BASIC_PITCH_WORKER_REQUEST_TIMEOUT_MS = 180_000;

export const BASIC_PITCH_RUNTIME_PROFILE = Object.freeze({
  inferenceRuntime: Object.freeze({
    executionProvider: 'CPUExecutionProvider',
    name: 'onnxruntime',
    version: BASIC_PITCH_ONNX_RUNTIME_VERSION,
  }),
  model: Object.freeze({
    filename: BASIC_PITCH_MODEL_FILENAME,
    sha256: BASIC_PITCH_MODEL_SHA256,
  }),
  profileId: BASIC_PITCH_RUNTIME_PROFILE_ID,
  providerPackage: Object.freeze({
    name: 'basic-pitch',
    version: BASIC_PITCH_PROVIDER_VERSION,
  }),
  requirementsFile: BASIC_PITCH_REQUIREMENTS_FILE,
  target: Object.freeze({
    architecture: 'x64',
    platform: 'win32',
    python: Object.freeze({
      implementation: 'CPython',
      major: 3,
      minor: 10,
      verifiedVersion: '3.10.6',
    }),
  }),
});

export const BASIC_PITCH_LICENSE_PROFILE = Object.freeze({
  inferenceRuntime: Object.freeze({
    component: 'ONNX Runtime',
    licenseSpdx: 'MIT',
    sourceUrl:
      'https://github.com/microsoft/onnxruntime/blob/v1.23.2/LICENSE',
    version: BASIC_PITCH_ONNX_RUNTIME_VERSION,
  }),
  model: Object.freeze({
    component: 'Basic Pitch ICASSP 2022 ONNX model',
    distribution: `basic-pitch==${BASIC_PITCH_PROVIDER_VERSION}`,
    filename: BASIC_PITCH_MODEL_FILENAME,
    licenseBasis:
      'The model is tracked in the Basic Pitch v0.4.0 repository and distributed in its wheel; no separate model license file was found.',
    licenseSpdx: 'Apache-2.0',
    sha256: BASIC_PITCH_MODEL_SHA256,
    sourceUrl:
      'https://github.com/spotify/basic-pitch/tree/v0.4.0/basic_pitch/saved_models/icassp_2022',
  }),
  providerCode: Object.freeze({
    component: 'Basic Pitch',
    licenseSpdx: 'Apache-2.0',
    noticeRequired: true,
    noticeUrl: 'https://github.com/spotify/basic-pitch/blob/v0.4.0/NOTICE',
    sourceUrl: 'https://github.com/spotify/basic-pitch/blob/v0.4.0/LICENSE',
    version: BASIC_PITCH_PROVIDER_VERSION,
  }),
  review: Object.freeze({
    distributionApproved: false,
    transitiveDependencyLicenses: 'PENDING',
  }),
});
