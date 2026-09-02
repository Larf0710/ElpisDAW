import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  providerDeclaresJob,
  providerSupportsJob,
  validateProviderJob,
} from './providerContract.mjs';
import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_PROVIDER_DESCRIPTOR,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TASK_ID,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
  validateStableAudio3Parameters,
  validateStableAudio3ProviderJob,
  validateStableAudio3TextToAudioParameters,
} from './stableAudio3ProviderDefinition.mjs';
import {
  STABLE_AUDIO_3_LICENSE_PROFILE,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_CODE_REVISION,
  STABLE_AUDIO_3_RUNTIME_PROFILE,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
} from './stableAudio3RuntimeProfile.mjs';

describe('Stable Audio 3 Provider definition', () => {
  it('declares executable Audio-to-Audio for the promoted Windows Runtime', () => {
    const job = validateProviderJob(createJob());

    expect(STABLE_AUDIO_3_PROVIDER_DESCRIPTOR).toMatchObject({
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
      models: [
        {
          compatibility: 'PARTIAL_SUPPORT',
          modelId: STABLE_AUDIO_3_MODEL_ID,
          revision: STABLE_AUDIO_3_MODEL_REVISION,
        },
      ],
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      runtime: {
        compatibility: 'COMPATIBLE',
        profile: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
        version: '0.1.0',
      },
    });
    expect(providerDeclaresJob(STABLE_AUDIO_3_PROVIDER_DESCRIPTOR, job)).toBe(true);
    expect(providerSupportsJob(STABLE_AUDIO_3_PROVIDER_DESCRIPTOR, job)).toBe(true);
    expect(Object.isFrozen(STABLE_AUDIO_3_PROVIDER_DESCRIPTOR)).toBe(true);
    expect(Object.isFrozen(STABLE_AUDIO_3_RUNTIME_PROFILE.target.gpu)).toBe(true);
  });

  it('pins the verified official code, model, and promoted Runtime evidence', () => {
    expect(STABLE_AUDIO_3_RUNTIME_PROFILE).toMatchObject({
      blockers: [],
      compatibility: 'COMPATIBLE',
      model: {
        access: 'GATED_TERMS_ACCEPTED',
        channels: 2,
        maximumDurationSeconds: 380,
        revision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
        sampleRate: 44_100,
      },
      providerPackage: {
        name: 'stable-audio-3',
        python: '>=3.10',
        revision: STABLE_AUDIO_3_PROVIDER_CODE_REVISION,
        version: '0.1.0',
      },
      promotionReview: {
        assessment: 'ACCEPTED_FOR_REVIEW',
        fileStatus: 'FILES_VERIFIED',
        reviewedAt: '2026-08-05',
      },
      runtime: {
        cuda: '12.6.3-native-windows-toolkit',
        flashAttention: '2.8.3-native-windows-local-wheel',
        flashAttentionSourceRevision:
          '060c9188beec3a8b62b33a3bfa6d5d2d44975fab',
        flashAttentionWheelSha256:
          '74e2409ecafcfe1a5f07e64acfd309d87f0f1a69cdc557861c72787767031a28',
        flashAttentionWheelTag: 'cp310-cp310-win_amd64',
        pytorch: '2.7.1',
        torchaudio: '2.7.1',
      },
      target: {
        architecture: 'x64',
        platform: 'win32',
      },
    });
    expect(STABLE_AUDIO_3_RUNTIME_PROFILE.blockers).toHaveLength(0);
  });

  it('keeps Provider code, model weights, and text encoder terms separate', () => {
    expect(STABLE_AUDIO_3_LICENSE_PROFILE).toMatchObject({
      modelWeights: {
        access: 'GATED',
        licenseName: 'Stability AI Community License',
      },
      providerCode: {
        licenseSpdx: 'MIT',
      },
      review: {
        distributionApproved: false,
        modelAccessAccepted: true,
        transitiveDependencyLicenses: 'PENDING',
      },
      textEncoder: {
        licenseName: 'Gemma Terms of Use',
        termsAccepted: true,
      },
    });
    expect(STABLE_AUDIO_3_LICENSE_PROFILE.providerCode).not.toBe(
      STABLE_AUDIO_3_LICENSE_PROFILE.modelWeights,
    );
    expect(STABLE_AUDIO_3_LICENSE_PROFILE.modelWeights).not.toBe(
      STABLE_AUDIO_3_LICENSE_PROFILE.textEncoder,
    );
  });

  it('validates an exact immutable v0.1 Audio-to-Audio parameter snapshot', () => {
    const parameters = validateStableAudio3Parameters(createParameters());

    expect(parameters).toEqual(createParameters());
    expect(Object.isFrozen(parameters)).toBe(true);
  });

  it('accepts a valid declared Job through the promoted compatibility gate', () => {
    const job = validateStableAudio3ProviderJob(createJob());

    expect(job).toMatchObject({
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      taskId: STABLE_AUDIO_3_TASK_ID,
    });
    expect(Object.isFrozen(job)).toBe(true);
  });

  it('validates a separately declared source-free Text-to-Audio Job', () => {
    const job = validateStableAudio3ProviderJob(createTextToAudioJob());
    const parameters = validateStableAudio3TextToAudioParameters(
      createTextToAudioParameters(),
    );

    expect(job).toMatchObject({
      inputArtifacts: [],
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
    });
    expect(parameters).toEqual(createTextToAudioParameters());
    expect(Object.isFrozen(parameters)).toBe(true);
    expect(providerDeclaresJob(STABLE_AUDIO_3_PROVIDER_DESCRIPTOR, job)).toBe(
      true,
    );
    expect(providerSupportsJob(STABLE_AUDIO_3_PROVIDER_DESCRIPTOR, job)).toBe(
      true,
    );
  });

  it('rejects mismatched identity, artifact shape, and speculative parameters', () => {
    expect(() =>
      validateStableAudio3ProviderJob({
        ...createJob(),
        modelRevision: 'floating-main',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'STABLE_AUDIO_3_JOB_UNSUPPORTED' }),
    );

    expect(() =>
      validateStableAudio3ProviderJob({
        ...createJob(),
        inputArtifacts: [
          {
            artifactId: 'artifact-instrument-a',
            kind: 'audio',
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'STABLE_AUDIO_3_JOB_ARTIFACTS_INVALID' }),
    );

    expect(() =>
      validateStableAudio3Parameters({
        ...createParameters(),
        inferenceSteps: 8,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'STABLE_AUDIO_3_PARAMETERS_INVALID' }),
    );

    expect(() =>
      validateStableAudio3ProviderJob({
        ...createTextToAudioJob(),
        inputArtifacts: createJob().inputArtifacts,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'STABLE_AUDIO_3_JOB_UNSUPPORTED' }),
    );
    expect(() =>
      validateStableAudio3TextToAudioParameters({
        ...createTextToAudioParameters(),
        strength: 0.5,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'STABLE_AUDIO_3_PARAMETERS_INVALID' }),
    );
  });
});

function createJob() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-instrument-a',
        kind: 'audio',
        path: join(tmpdir(), 'artifact-instrument-a.wav'),
      },
    ],
    jobId: 'job-stable-audio-3-a',
    modelId: STABLE_AUDIO_3_MODEL_ID,
    modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
    output: {
      kind: 'audio',
      stagingPath: join(tmpdir(), 'stable-audio-3-output.wav.partial'),
    },
    parameters: createParameters(),
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    taskId: STABLE_AUDIO_3_TASK_ID,
  };
}

function createParameters() {
  return {
    channels: 2,
    durationSeconds: 12,
    prompt: 'Warm electric bass with a tight pocket and clean articulation',
    sampleRate: 44_100,
    seed: 7,
    sourceEndSeconds: 12,
    sourceStartSeconds: 0,
    strength: 0.4,
  };
}

function createTextToAudioJob() {
  return {
    inputArtifacts: [],
    jobId: 'job-stable-audio-3-t2a-a',
    modelId: STABLE_AUDIO_3_MODEL_ID,
    modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
    output: {
      kind: 'audio',
      stagingPath: join(tmpdir(), 'stable-audio-3-t2a-output.wav.partial'),
    },
    parameters: createTextToAudioParameters(),
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
  };
}

function createTextToAudioParameters() {
  return {
    channels: 2,
    durationSeconds: 16,
    prompt: 'Warm analog synths with a patient cinematic build',
    sampleRate: 44_100,
    seed: 17,
  };
}
