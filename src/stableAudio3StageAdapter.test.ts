import { describe, expect, it } from 'vitest';

import {
  createStableAudio3StageAdapterPlan,
  STABLE_AUDIO_3_STAGE_ADAPTER_ID,
  type StableAudio3StageDispatch,
  type StableAudio3StageRuntimeProfile,
} from './stableAudio3StageAdapter';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';

const MODEL_REVISION = 'a'.repeat(40);
const UNPINNED_MODEL_REVISION = 'hugging-face-main-unpinned';

describe('Stable Audio 3 Stage Adapter plan', () => {
  it('blocks the current unverified Runtime before materializing a Job', () => {
    const resolution = createStableAudio3StageAdapterPlan(
      createDispatch({ modelRevision: UNPINNED_MODEL_REVISION }),
      createProject(),
      createRuntimeProfile({
        modelRevision: UNPINNED_MODEL_REVISION,
        runtimeCompatibility: 'UNVERIFIED',
      }),
    );

    expect(resolution).toEqual({
      canPlan: false,
      cause: 'stable-audio-3-runtime-unverified',
      message:
        'Stable Audio 3 Stage planning is blocked until the exact Runtime Profile passes target-GPU verification.',
      reason: 'runtime-unverified',
    });
  });

  it('creates one immutable planning-only Job snapshot after explicit compatibility', () => {
    const project = createProject();
    const projectBefore = JSON.stringify(project);
    const resolution = createStableAudio3StageAdapterPlan(
      createDispatch(),
      project,
      createRuntimeProfile(),
    );

    expect(resolution.canPlan).toBe(true);

    if (!resolution.canPlan) {
      return;
    }

    expect(resolution.plan).toEqual({
      adapterId: STABLE_AUDIO_3_STAGE_ADAPTER_ID,
      attemptId: 'attempt-sa3-a',
      fingerprint: 'fingerprint-sa3-a',
      kind: 'local-engine-gpu-job',
      request: {
        inputArtifacts: [
          {
            artifactId: 'artifact-source',
            kind: 'audio',
            relativePath: 'renders/instruments/artifact-source.wav',
          },
        ],
        lineage: {
          parentArtifactIds: ['artifact-source'],
          parentClipTakeIds: ['clip-take-source'],
        },
        modelId: 'stable-audio-3-medium',
        modelRevision: MODEL_REVISION,
        output: {
          artifactKind: 'audio',
          destination: 'stable-audio-3',
          extension: '.wav',
        },
        parameters: {
          channels: 2,
          durationSeconds: 12,
          prompt: 'Warm electric bass with a tight pocket',
          sampleRate: 44_100,
          seed: 7,
          sourceEndSeconds: 12,
          sourceStartSeconds: 0,
          strength: 0.4,
        },
        providerId: 'local-stable-audio-3',
        taskId: 'audio-to-audio',
      },
      runId: 'run-sa3-a',
      runtime: {
        modelCompatibility: 'PARTIAL_SUPPORT',
        profileId: 'windows-target-verified-test',
        providerVersion: '0.1.0',
        supportsCancellation: false,
      },
      scope: {
        familyId: 'family-root',
        familyRevision: 3,
        stageId: 'stage-sa3-a',
        targetClipId: 'clip-source',
      },
      sourceClipId: 'clip-source',
    });
    expect(Object.isFrozen(resolution.plan)).toBe(true);
    expect(Object.isFrozen(resolution.plan.runtime)).toBe(true);
    expect(Object.isFrozen(resolution.plan.scope)).toBe(true);
    expect(Object.isFrozen(resolution.plan.request)).toBe(true);
    expect(JSON.stringify(project)).toBe(projectBefore);
  });

  it('rejects a stale source Artifact or Active Take', () => {
    const staleArtifact = createStableAudio3StageAdapterPlan(
      createDispatch({ sourceArtifactId: 'artifact-stale' }),
      createProject(),
      createRuntimeProfile(),
    );

    expect(staleArtifact).toMatchObject({
      canPlan: false,
      cause: 'stable-audio-3-source-stale',
      reason: 'source-audio-mismatch',
    });

    const project = createProject();
    project.tracks[0].clips[0].activeClipTakeId = undefined;
    const missingActiveTake = createStableAudio3StageAdapterPlan(
      createDispatch(),
      project,
      createRuntimeProfile(),
    );

    expect(missingActiveTake).toMatchObject({
      canPlan: false,
      reason: 'source-audio-unavailable',
    });
  });

  it('rejects mismatched Runtime identity before source resolution', () => {
    const profile = createRuntimeProfile();
    const mismatchedProfile: StableAudio3StageRuntimeProfile = {
      ...profile,
      model: {
        ...profile.model,
        revision: 'b'.repeat(40),
      },
    };
    const resolution = createStableAudio3StageAdapterPlan(
      createDispatch(),
      createProject(),
      mismatchedProfile,
    );

    expect(resolution).toEqual({
      canPlan: false,
      cause: 'stable-audio-3-runtime-profile-mismatch',
      message:
        'Stable Audio 3 Runtime Profile is invalid or does not match the immutable Stage dispatch.',
      reason: 'profile-invalid',
    });
  });

  it('distinguishes incompatible Runtime and Model gates', () => {
    const runtimeFailure = createStableAudio3StageAdapterPlan(
      createDispatch(),
      createProject(),
      createRuntimeProfile({ runtimeCompatibility: 'INCOMPATIBLE' }),
    );
    const modelUnverified = createStableAudio3StageAdapterPlan(
      createDispatch(),
      createProject(),
      createRuntimeProfile({ modelCompatibility: 'UNVERIFIED' }),
    );
    const modelIncompatible = createStableAudio3StageAdapterPlan(
      createDispatch(),
      createProject(),
      createRuntimeProfile({ modelCompatibility: 'INCOMPATIBLE' }),
    );

    expect(runtimeFailure).toMatchObject({
      canPlan: false,
      reason: 'runtime-incompatible',
    });
    expect(modelUnverified).toMatchObject({
      canPlan: false,
      reason: 'model-unverified',
    });
    expect(modelIncompatible).toMatchObject({
      canPlan: false,
      reason: 'model-incompatible',
    });
  });

  it('delegates pinned revision and generation parameter validation to the Job contract', () => {
    const unpinned = createStableAudio3StageAdapterPlan(
      createDispatch({ modelRevision: UNPINNED_MODEL_REVISION }),
      createProject(),
      createRuntimeProfile({
        modelRevision: UNPINNED_MODEL_REVISION,
      }),
    );
    const invalidPrompt = createStableAudio3StageAdapterPlan(
      createDispatch({ prompt: ' padded prompt ' }),
      createProject(),
      createRuntimeProfile(),
    );

    expect(unpinned).toMatchObject({
      canPlan: false,
      cause: 'stable-audio-3-job-request-invalid',
      reason: 'request-invalid',
    });
    expect(invalidPrompt).toMatchObject({
      canPlan: false,
      cause: 'stable-audio-3-job-request-invalid',
      reason: 'request-invalid',
    });
  });
});

function createDispatch(
  overrides: Partial<{
    modelRevision: string;
    prompt: string;
    sourceArtifactId: string;
  }> = {},
): StableAudio3StageDispatch {
  return {
    attemptId: 'attempt-sa3-a',
    execution: {
      modelId: 'stable-audio-3-medium',
      modelRevision: overrides.modelRevision ?? MODEL_REVISION,
      providerId: 'local-stable-audio-3',
      taskId: 'audio-to-audio',
    },
    fingerprint: 'fingerprint-sa3-a',
    parameters: {
      durationSeconds: 12,
      prompt:
        overrides.prompt ?? 'Warm electric bass with a tight pocket',
      seed: 7,
      strength: 0.4,
      takes: 1,
    },
    runId: 'run-sa3-a',
    scope: {
      familyId: 'family-root',
      familyRevision: 3,
      stageId: 'stage-sa3-a',
      targetClipId: 'clip-source',
    },
    source: {
      artifactId: overrides.sourceArtifactId ?? 'artifact-source',
      clipId: 'clip-source',
      clipTakeId: 'clip-take-source',
    },
    startedAt: '2026-08-02T09:00:00.000Z',
  };
}

function createRuntimeProfile(
  overrides: Partial<{
    modelCompatibility: StableAudio3StageRuntimeProfile['model']['compatibility'];
    modelRevision: string;
    runtimeCompatibility: StableAudio3StageRuntimeProfile['runtime']['compatibility'];
  }> = {},
): StableAudio3StageRuntimeProfile {
  return {
    model: {
      compatibility: overrides.modelCompatibility ?? 'PARTIAL_SUPPORT',
      modelId: 'stable-audio-3-medium',
      revision: overrides.modelRevision ?? MODEL_REVISION,
    },
    providerId: 'local-stable-audio-3',
    providerVersion: '0.1.0',
    runtime: {
      compatibility: overrides.runtimeCompatibility ?? 'COMPATIBLE',
      profileId: 'windows-target-verified-test',
    },
    supportsCancellation: false,
    taskId: 'audio-to-audio',
  };
}

function createProject(): ProjectState {
  const artifact = createSourceArtifact();
  const take = createSourceTake();

  return {
    artifacts: [artifact],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'Stable Audio 3 Stage Adapter Test',
    patchTabs: [],
    playheadTick: 0,
    recordingSettings: {
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: '',
    selection: { items: [] },
    status: 'READY',
    takes: [],
    totalTicks: 23_040,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: take.clipTakeId,
            clipTakes: [take],
            color: '#8dff6b',
            createdAt: '2026-08-02T07:00:00.000Z',
            id: 'clip-source',
            lengthTicks: 23_040,
            name: 'Instrument Audio',
            startTick: 0,
            type: 'instrument-audio',
            version: 1,
          },
        ],
        id: 'track-audio',
        level: -6,
        name: 'Audio',
        type: 'audio',
      },
    ],
  };
}

function createSourceArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-source',
    audio: {
      channels: 2,
      durationSeconds: 12,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-02T07:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-source.wav',
      relativePath: 'renders/instruments/artifact-source.wav',
      sizeBytes: 2_116_844,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    provenance: {
      modelId: 'soundfont-model',
      modelRevision: '1',
      parameters: {},
      providerId: 'local-fluidsynth',
      taskId: 'midi-to-audio',
    },
    sourceJobId: 'job-source',
  };
}

function createSourceTake(): GeneratedAudioClipTake {
  return {
    artifactId: 'artifact-source',
    clipTakeId: 'clip-take-source',
    createdAt: '2026-08-02T07:00:00.000Z',
    label: 'Source Take 01',
    mediaType: 'audio',
    sourceJobId: 'job-source',
    sourceType: 'job',
  };
}
