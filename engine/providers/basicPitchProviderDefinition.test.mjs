import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BASIC_PITCH_MODEL_ID,
  BASIC_PITCH_MODEL_REVISION,
  BASIC_PITCH_PROVIDER_DESCRIPTOR,
  BASIC_PITCH_PROVIDER_ID,
  BASIC_PITCH_TASK_ID,
  BASIC_PITCH_TICKS_PER_QUARTER,
  validateBasicPitchParameters,
  validateBasicPitchProviderJob,
} from './basicPitchProviderDefinition.mjs';
import {
  BASIC_PITCH_LICENSE_PROFILE,
  BASIC_PITCH_MODEL_SHA256,
  BASIC_PITCH_RUNTIME_PROFILE,
  BASIC_PITCH_RUNTIME_PROFILE_ID,
} from './basicPitchRuntimeProfile.mjs';

describe('Basic Pitch Provider definition', () => {
  it('publishes the verified Windows ONNX runtime without claiming real-hum acceptance', () => {
    expect(BASIC_PITCH_PROVIDER_DESCRIPTOR).toMatchObject({
      capabilities: [
        {
          inputArtifactKinds: ['audio'],
          outputArtifactKind: 'midi',
          supportsCancellation: false,
          taskId: BASIC_PITCH_TASK_ID,
        },
      ],
      models: [
        {
          compatibility: 'PARTIAL_SUPPORT',
          modelId: BASIC_PITCH_MODEL_ID,
          revision: BASIC_PITCH_MODEL_REVISION,
        },
      ],
      providerId: BASIC_PITCH_PROVIDER_ID,
      runtime: {
        compatibility: 'COMPATIBLE',
        profile: BASIC_PITCH_RUNTIME_PROFILE_ID,
        version: '0.4.0',
      },
    });
    expect(BASIC_PITCH_RUNTIME_PROFILE).toMatchObject({
      inferenceRuntime: {
        executionProvider: 'CPUExecutionProvider',
        name: 'onnxruntime',
        version: '1.23.2',
      },
      model: {
        filename: 'nmp.onnx',
        sha256: BASIC_PITCH_MODEL_SHA256,
      },
      target: {
        architecture: 'x64',
        platform: 'win32',
        python: { major: 3, minor: 10 },
      },
    });
    expect(Object.isFrozen(BASIC_PITCH_PROVIDER_DESCRIPTOR)).toBe(true);
    expect(Object.isFrozen(BASIC_PITCH_RUNTIME_PROFILE.target.python)).toBe(true);
  });

  it('keeps Provider code, bundled model, and inference runtime licenses separate', () => {
    expect(BASIC_PITCH_LICENSE_PROFILE).toMatchObject({
      inferenceRuntime: {
        component: 'ONNX Runtime',
        licenseSpdx: 'MIT',
      },
      model: {
        component: 'Basic Pitch ICASSP 2022 ONNX model',
        licenseSpdx: 'Apache-2.0',
        sha256: BASIC_PITCH_MODEL_SHA256,
      },
      providerCode: {
        component: 'Basic Pitch',
        licenseSpdx: 'Apache-2.0',
        noticeRequired: true,
      },
      review: {
        distributionApproved: false,
        transitiveDependencyLicenses: 'PENDING',
      },
    });
    expect(BASIC_PITCH_LICENSE_PROFILE.providerCode).not.toBe(
      BASIC_PITCH_LICENSE_PROFILE.model,
    );
    expect(BASIC_PITCH_LICENSE_PROFILE.model).not.toBe(
      BASIC_PITCH_LICENSE_PROFILE.inferenceRuntime,
    );
  });

  it('accepts one path-backed recording and an exact immutable parameter set', () => {
    const job = validateBasicPitchProviderJob(createJob());
    const parameters = validateBasicPitchParameters(job.parameters);

    expect(job.inputArtifacts[0]).toEqual({
      artifactId: 'artifact-recording-a',
      kind: 'audio',
      path: join(tmpdir(), 'artifact-recording-a.wav'),
    });
    expect(job.output).toEqual({ kind: 'midi' });
    expect(parameters).toEqual(createParameters());
    expect(Object.isFrozen(job)).toBe(true);
    expect(Object.isFrozen(job.parameters)).toBe(true);
    expect(Object.isFrozen(parameters)).toBe(true);
  });

  it('rejects a mismatched identity or artifact boundary', () => {
    expect(() =>
      validateBasicPitchProviderJob({
        ...createJob(),
        providerId: 'mock-provider',
      }),
    ).toThrowError(expect.objectContaining({ code: 'BASIC_PITCH_JOB_UNSUPPORTED' }));

    expect(() =>
      validateBasicPitchProviderJob({
        ...createJob(),
        inputArtifacts: [
          {
            artifactId: 'artifact-recording-a',
            kind: 'audio',
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'BASIC_PITCH_JOB_ARTIFACTS_INVALID' }),
    );

    expect(() =>
      validateBasicPitchProviderJob({
        ...createJob(),
        output: {
          kind: 'audio',
          stagingPath: join(tmpdir(), 'unexpected.partial'),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'BASIC_PITCH_JOB_UNSUPPORTED' }));
  });

  it('rejects mock-only, pitch-bend, and invalid transcription parameters', () => {
    expect(() =>
      validateBasicPitchProviderJob({
        ...createJob(),
        parameters: { ...createParameters(), seed: 7 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'BASIC_PITCH_PARAMETERS_INVALID' }));

    expect(() =>
      validateBasicPitchProviderJob({
        ...createJob(),
        parameters: { ...createParameters(), multiplePitchBends: true },
      }),
    ).toThrow('multiplePitchBends must be false');

    expect(() =>
      validateBasicPitchProviderJob({
        ...createJob(),
        parameters: {
          ...createParameters(),
          maximumFrequencyHz: 80,
          minimumFrequencyHz: 80,
        },
      }),
    ).toThrow('frequency range');

    expect(() =>
      validateBasicPitchProviderJob({
        ...createJob(),
        parameters: {
          ...createParameters(),
          sourceEndSeconds: 1,
          sourceStartSeconds: 1,
        },
      }),
    ).toThrow('source range');
  });
});

function createJob() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-recording-a',
        kind: 'audio',
        path: join(tmpdir(), 'artifact-recording-a.wav'),
      },
    ],
    jobId: 'job-basic-pitch-a',
    modelId: BASIC_PITCH_MODEL_ID,
    modelRevision: BASIC_PITCH_MODEL_REVISION,
    output: { kind: 'midi' },
    parameters: createParameters(),
    providerId: BASIC_PITCH_PROVIDER_ID,
    taskId: BASIC_PITCH_TASK_ID,
  };
}

function createParameters() {
  return {
    frameThreshold: 0.3,
    maximumFrequencyHz: 1_100,
    melodiaTrick: true,
    minimumFrequencyHz: 80,
    minimumNoteLengthMs: 127.7,
    multiplePitchBends: false,
    onsetThreshold: 0.5,
    projectBpm: 120,
    sourceEndSeconds: 3,
    sourceStartSeconds: 0,
    ticksPerQuarter: BASIC_PITCH_TICKS_PER_QUARTER,
  };
}
