import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  providerDeclaresJob,
  providerSupportsJob,
  validateProviderJob,
} from './providerContract.mjs';
import {
  ACE_STEP_COVER_TASK_ID,
  ACE_STEP_MODEL_ID,
  ACE_STEP_PROVIDER_DESCRIPTOR,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_TASK_ID,
  ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
  validateAceStepParameters,
  validateAceStepProviderJob,
} from './aceStepProviderDefinition.mjs';
import {
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_RUNTIME_PROFILE_ID,
} from './aceStepRuntimeProfile.mjs';

describe('ACE-Step Provider definition', () => {
  it('declares the verified Guide Audio plus Lyrics to vocals execution', () => {
    const job = validateProviderJob(createJob());

    expect(ACE_STEP_PROVIDER_DESCRIPTOR).toMatchObject({
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
      models: [
        {
          compatibility: 'COMPATIBLE',
          modelId: ACE_STEP_MODEL_ID,
          revision: ACE_STEP_MODEL_REVISION,
        },
      ],
      providerId: ACE_STEP_PROVIDER_ID,
      runtime: {
        compatibility: 'COMPATIBLE',
        profile: ACE_STEP_RUNTIME_PROFILE_ID,
        version: '1.5.0',
      },
    });
    expect(providerDeclaresJob(ACE_STEP_PROVIDER_DESCRIPTOR, job)).toBe(true);
    expect(providerSupportsJob(ACE_STEP_PROVIDER_DESCRIPTOR, job)).toBe(true);
    expect(Object.isFrozen(ACE_STEP_PROVIDER_DESCRIPTOR)).toBe(true);
  });

  it('validates the exact immutable Lego vocals parameter snapshot', () => {
    const parameters = validateAceStepParameters(createParameters());

    expect(parameters).toEqual(createParameters());
    expect(Object.isFrozen(parameters)).toBe(true);
  });

  it('returns an immutable validated executable Job', () => {
    const job = validateAceStepProviderJob(createJob());

    expect(job).toMatchObject(createJob());
    expect(Object.isFrozen(job)).toBe(true);
  });

  it('declares and validates source-free Text to Music at 48 kHz', () => {
    const parameters = validateAceStepParameters(
      createTextToMusicParameters(),
      ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
    );
    const job = validateAceStepProviderJob(createTextToMusicJob());

    expect(parameters).toEqual(createTextToMusicParameters());
    expect(job.taskId).toBe(ACE_STEP_TEXT_TO_MUSIC_TASK_ID);
    expect(job.inputArtifacts.map(({ kind }) => kind)).toEqual(['lyrics']);
    expect(providerSupportsJob(ACE_STEP_PROVIDER_DESCRIPTOR, job)).toBe(true);
    expect(() =>
      validateAceStepProviderJob({
        ...createTextToMusicJob(),
        parameters: { ...createTextToMusicParameters(), sampleRate: 44_100 },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'ACE_STEP_PARAMETERS_INVALID' }),
    );
  });

  it('declares and validates audio-backed Cover with pinned Remix defaults', () => {
    const parameters = validateAceStepParameters(
      createCoverParameters(),
      ACE_STEP_COVER_TASK_ID,
    );
    const job = validateAceStepProviderJob({
      ...createJob(),
      parameters: createCoverParameters(),
      taskId: ACE_STEP_COVER_TASK_ID,
    });

    expect(parameters).toEqual(createCoverParameters());
    expect(job.taskId).toBe(ACE_STEP_COVER_TASK_ID);
    expect(providerSupportsJob(ACE_STEP_PROVIDER_DESCRIPTOR, job)).toBe(true);
    expect(() =>
      validateAceStepParameters(
        { ...createCoverParameters(), audioCoverStrength: 1.01 },
        ACE_STEP_COVER_TASK_ID,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'ACE_STEP_PARAMETERS_INVALID' }),
    );
  });

  it('rejects mismatched identity and non-path-backed input Artifacts', () => {
    expect(() =>
      validateAceStepProviderJob({
        ...createJob(),
        modelRevision: 'floating-main',
      }),
    ).toThrowError(expect.objectContaining({ code: 'ACE_STEP_JOB_UNSUPPORTED' }));

    expect(() =>
      validateAceStepProviderJob({
        ...createJob(),
        inputArtifacts: [
          createJob().inputArtifacts[0],
          {
            artifactId: 'artifact-lyrics-a',
            kind: 'lyrics',
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'ACE_STEP_JOB_ARTIFACTS_INVALID' }),
    );
  });

  it('rejects Cover semantics, non-vocal targets, and speculative strength', () => {
    expect(() =>
      validateAceStepParameters({
        ...createParameters(),
        taskType: 'cover',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'ACE_STEP_PARAMETERS_INVALID' }),
    );

    expect(() =>
      validateAceStepParameters({
        ...createParameters(),
        targetTrack: 'backing_vocals',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'ACE_STEP_PARAMETERS_INVALID' }),
    );

    expect(() =>
      validateAceStepParameters({
        ...createParameters(),
        audioCoverStrength: 0.5,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'ACE_STEP_PARAMETERS_INVALID' }),
    );
  });

  it('enforces output format, duration, seed, and language boundaries', () => {
    for (const parameters of [
      { ...createParameters(), sampleRate: 44_100 },
      { ...createParameters(), durationSeconds: 9.999 },
      { ...createParameters(), durationSeconds: 600.001 },
      { ...createParameters(), seed: -1 },
      { ...createParameters(), vocalLanguage: 'Japanese' },
      { ...createParameters(), thinking: true },
    ]) {
      expect(() => validateAceStepParameters(parameters)).toThrowError(
        expect.objectContaining({ code: 'ACE_STEP_PARAMETERS_INVALID' }),
      );
    }
  });
});

function createJob() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-guide-audio-a',
        kind: 'audio',
        path: join(tmpdir(), 'artifact-guide-audio-a.wav'),
      },
      {
        artifactId: 'artifact-lyrics-a',
        kind: 'lyrics',
        path: join(tmpdir(), 'artifact-lyrics-a.txt'),
      },
    ],
    jobId: 'job-ace-step-a',
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    output: {
      kind: 'audio',
      stagingPath: join(tmpdir(), 'ace-step-output.wav.partial'),
    },
    parameters: createParameters(),
    providerId: ACE_STEP_PROVIDER_ID,
    taskId: ACE_STEP_TASK_ID,
  };
}

function createParameters() {
  return {
    audioFormat: 'wav',
    batchSize: 1,
    caption: 'Clear lead vocal with intimate phrasing and restrained vibrato',
    channels: 2,
    durationSeconds: 24,
    sampleRate: 48_000,
    seed: 17,
    targetTrack: 'vocals',
    taskType: 'lego',
    thinking: false,
    vocalLanguage: 'ja',
  };
}

function createTextToMusicJob() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-lyrics-t2m-a',
        kind: 'lyrics',
        path: join(tmpdir(), 'artifact-lyrics-t2m-a.txt'),
      },
    ],
    jobId: 'job-ace-step-t2m-a',
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    output: {
      kind: 'audio',
      stagingPath: join(tmpdir(), 'ace-step-t2m-output.wav.partial'),
    },
    parameters: createTextToMusicParameters(),
    providerId: ACE_STEP_PROVIDER_ID,
    taskId: ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
  };
}

function createTextToMusicParameters() {
  return {
    audioFormat: 'wav',
    batchSize: 1,
    bpm: 120,
    caption: 'Dreamy synth pop with a restrained verse and wide chorus',
    channels: 2,
    durationSeconds: 16,
    guidanceScale: 8,
    inferenceSteps: 64,
    instrumental: false,
    keyscale: 'C major',
    sampleRate: 48_000,
    seed: 42,
    taskType: 'text2music',
    thinking: false,
    timesignature: '4/4',
    vocalLanguage: 'ja',
  };
}

function createCoverParameters() {
  return {
    audioCoverStrength: 0.2,
    audioFormat: 'wav',
    batchSize: 1,
    caption: 'Dreamy chamber pop reinterpretation with restrained drums',
    channels: 2,
    coverNoiseStrength: 0,
    durationSeconds: 24,
    guidanceScale: 8,
    inferenceSteps: 64,
    instrumental: false,
    sampleRate: 48_000,
    seed: 42,
    taskType: 'cover',
    thinking: false,
    vocalLanguage: 'ja',
  };
}
