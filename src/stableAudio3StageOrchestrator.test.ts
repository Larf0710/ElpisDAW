import { describe, expect, it, vi } from 'vitest';

import type {
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineClient';
import type {
  StableAudio3Compatibility,
  StableAudio3StageDispatch,
  StableAudio3StageRuntimeProfile,
} from './stableAudio3StageAdapter';
import {
  orchestrateStableAudio3Stage,
  type StableAudio3StageOrchestratorOptions,
} from './stableAudio3StageOrchestrator';
import type { StableAudio3StageRunnerClient } from './stableAudio3StageRunner';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';

const MODEL_REVISION = 'a'.repeat(40);
const RESULT_ID = 'result-stable-audio-3-orchestrator';

describe('Stable Audio 3 Stage orchestrator', () => {
  it('blocks the current unverified Runtime before contacting the Engine', async () => {
    const fixture = createFixture();
    const enqueueStableAudio3Job = vi.fn();
    const result = await orchestrateStableAudio3Stage(
      createClient(fixture.dispatch, [], { enqueueStableAudio3Job }),
      fixture.project,
      fixture.dispatch,
      createProfile({ runtimeCompatibility: 'UNVERIFIED' }),
      createOptions(),
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-runtime-unverified',
      ok: false,
      planning: { canPlan: false, reason: 'runtime-unverified' },
      reason: 'runtime-unverified',
      status: 'STAGE_BLOCKED',
    });
    expect(result.project).toBe(fixture.project);
    expect(enqueueStableAudio3Job).not.toHaveBeenCalled();
  });

  it('blocks an unverified model revision before contacting the Engine', async () => {
    const fixture = createFixture();
    const enqueueStableAudio3Job = vi.fn();
    const result = await orchestrateStableAudio3Stage(
      createClient(fixture.dispatch, [], { enqueueStableAudio3Job }),
      fixture.project,
      fixture.dispatch,
      createProfile({ modelCompatibility: 'UNVERIFIED' }),
      createOptions(),
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-model-unverified',
      ok: false,
      planning: { canPlan: false, reason: 'model-unverified' },
      reason: 'model-unverified',
      status: 'STAGE_BLOCKED',
    });
    expect(result.project).toBe(fixture.project);
    expect(enqueueStableAudio3Job).not.toHaveBeenCalled();
  });

  it('plans, runs, and atomically settles one compatible Stage', async () => {
    const fixture = createFixture();
    const completed = createJob('COMPLETED', fixture.dispatch);
    const snapshot = JSON.stringify(fixture.project);
    const result = await orchestrateStableAudio3Stage(
      createClient(fixture.dispatch, [completed]),
      fixture.project,
      fixture.dispatch,
      createProfile(),
      createOptions(),
    );

    expect(result).toMatchObject({
      execution: {
        runner: { status: 'JOB_COMPLETED' },
        settlement: { status: 'STAGE_COMPLETED' },
      },
      ok: true,
      plan: {
        attemptId: fixture.dispatch.attemptId,
        runtime: { modelCompatibility: 'PARTIAL_SUPPORT' },
      },
      status: 'STAGE_COMPLETED',
    });

    if (!result.ok) {
      throw new Error('Expected Stable Audio 3 orchestration to complete.');
    }

    expect(result.project).not.toBe(fixture.project);
    expect(result.project.artifacts).toHaveLength(2);
    expect(result.project.tabFlowStageResults).toHaveLength(1);
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
  });

  it('keeps polling-budget exhaustion pending with the exact plan', async () => {
    const fixture = createFixture();
    const result = await orchestrateStableAudio3Stage(
      createClient(fixture.dispatch, [
        createJob('PROCESSING', fixture.dispatch),
      ]),
      fixture.project,
      fixture.dispatch,
      createProfile(),
      createOptions({ maxPollAttempts: 1 }),
    );

    expect(result).toMatchObject({
      execution: { status: 'STAGE_PENDING' },
      ok: false,
      plan: { attemptId: fixture.dispatch.attemptId },
      reason: 'poll-limit-reached',
      status: 'STAGE_PENDING',
    });
    expect(result.project).toBe(fixture.project);
  });

  it('keeps pre-enqueue cancellation distinct from Stage failure', async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    const enqueueStableAudio3Job = vi.fn();
    controller.abort();
    const result = await orchestrateStableAudio3Stage(
      createClient(fixture.dispatch, [], { enqueueStableAudio3Job }),
      fixture.project,
      fixture.dispatch,
      createProfile(),
      createOptions({ signal: controller.signal }),
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-run-canceled-before-enqueue',
      ok: false,
      reason: 'canceled-before-enqueue',
      status: 'STAGE_CANCELED',
    });
    expect(result.project).toBe(fixture.project);
    expect(enqueueStableAudio3Job).not.toHaveBeenCalled();
  });

  it('propagates a typed Runner failure without changing Project', async () => {
    const fixture = createFixture();
    const result = await orchestrateStableAudio3Stage(
      createClient(fixture.dispatch, [], {
        enqueueStableAudio3Job: vi.fn(async () => ({
          message: 'Stable Audio 3 is unavailable.',
          ok: false as const,
          reason: 'http-error' as const,
          status: 400,
        })),
      }),
      fixture.project,
      fixture.dispatch,
      createProfile(),
      createOptions(),
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-enqueue-http-error',
      execution: { reason: 'runner-failed', status: 'STAGE_FAILED' },
      ok: false,
      reason: 'runner-failed',
      status: 'STAGE_FAILED',
    });
    expect(result.project).toBe(fixture.project);
  });

  it('blocks a stale Active Take before contacting the Engine', async () => {
    const fixture = createFixture();
    const sourceClip = findClip(fixture.project, 'clip-source');
    const enqueueStableAudio3Job = vi.fn();
    sourceClip.activeClipTakeId = 'clip-take-missing';
    const result = await orchestrateStableAudio3Stage(
      createClient(fixture.dispatch, [], { enqueueStableAudio3Job }),
      fixture.project,
      fixture.dispatch,
      createProfile(),
      createOptions(),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'source-audio-unavailable',
      status: 'STAGE_BLOCKED',
    });
    expect(result.project).toBe(fixture.project);
    expect(enqueueStableAudio3Job).not.toHaveBeenCalled();
  });
});

function createOptions(
  runner: NonNullable<StableAudio3StageOrchestratorOptions['runner']> = {},
): StableAudio3StageOrchestratorOptions {
  return {
    completion: {
      label: 'SA3 Orchestrated Take',
      resultId: RESULT_ID,
    },
    runner: {
      maxPollAttempts: 2,
      pollIntervalMs: 0,
      wait: async () => undefined,
      ...runner,
    },
  };
}

function createProfile(
  options: Readonly<{
    modelCompatibility?: StableAudio3Compatibility;
    runtimeCompatibility?: StableAudio3Compatibility;
  }> = {},
): StableAudio3StageRuntimeProfile {
  return Object.freeze({
    model: Object.freeze({
      compatibility: options.modelCompatibility ?? 'PARTIAL_SUPPORT',
      modelId: 'stable-audio-3-medium',
      revision: MODEL_REVISION,
    }),
    providerId: 'local-stable-audio-3',
    providerVersion: '0.1.0',
    runtime: Object.freeze({
      compatibility: options.runtimeCompatibility ?? 'COMPATIBLE',
      profileId: 'windows-target-verified-test',
    }),
    supportsCancellation: false,
    taskId: 'audio-to-audio',
  });
}

function createFixture(): Readonly<{
  dispatch: StableAudio3StageDispatch;
  project: ProjectState;
}> {
  const project = createProject();
  const dispatch: StableAudio3StageDispatch = Object.freeze({
    attemptId: 'attempt-sa3-orchestrator',
    execution: Object.freeze({
      modelId: 'stable-audio-3-medium',
      modelRevision: MODEL_REVISION,
      providerId: 'local-stable-audio-3',
      taskId: 'audio-to-audio',
    }),
    fingerprint: 'fingerprint-sa3-orchestrator',
    parameters: Object.freeze({
      durationSeconds: 12,
      takes: 1,
      prompt: 'Warm electric bass with a tight pocket',
      seed: 7,
      strength: 0.4,
    }),
    runId: 'run-sa3-orchestrator',
    scope: Object.freeze({
      familyId: 'family-root',
      familyRevision: 3,
      stageId: 'stage-sa3-orchestrator',
      targetClipId: 'clip-source',
    }),
    source: Object.freeze({
      artifactId: 'artifact-source',
      clipId: 'clip-source',
      clipTakeId: 'clip-take-source',
    }),
    startedAt: '2026-08-03T03:45:00.000Z',
  });

  return { dispatch, project };
}

function createClient(
  dispatch: StableAudio3StageDispatch,
  snapshots: readonly LocalEngineGpuJobRecord[],
  overrides: Partial<StableAudio3StageRunnerClient> = {},
): StableAudio3StageRunnerClient {
  const queued = createJob('QUEUED', dispatch);
  let snapshotIndex = 0;
  const client: StableAudio3StageRunnerClient = {
    cancelJob: async () => ({
      job: createJob('CANCEL_REQUESTED', dispatch),
      ok: true,
    }),
    enqueueStableAudio3Job: async () => ({ job: queued, ok: true }),
    getJobs: async () => {
      const job = snapshots[
        Math.min(snapshotIndex, Math.max(0, snapshots.length - 1))
      ] ?? queued;
      snapshotIndex += 1;
      return {
        ok: true,
        snapshot: { acceptingJobs: true, jobs: [job] },
      };
    },
    removeQueuedJob: async () => ({ ok: true, removedJob: queued }),
  };

  return { ...client, ...overrides };
}

function createJob(
  state: LocalEngineGpuJobState,
  dispatch: StableAudio3StageDispatch,
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-03T03:50:00.000Z';
  const finishedAt = '2026-08-03T03:50:12.000Z';
  const isFinished = [
    'COMPLETED',
    'CANCELED',
    'FAILED',
    'INTERRUPTED',
  ].includes(state);
  const request = createExpectedRequest(dispatch);

  return Object.freeze({
    attempt: 1,
    ...(state === 'CANCEL_REQUESTED'
      ? { cancelRequestedAt: createdAt }
      : {}),
    createdAt,
    ...(isFinished ? { finishedAt } : {}),
    history: Object.freeze([
      Object.freeze({ attempt: 1, at: createdAt, state }),
    ]),
    jobId: 'job-stable-audio-3-orchestrator',
    modelId: dispatch.execution.modelId,
    modelRevision: dispatch.execution.modelRevision,
    providerId: dispatch.execution.providerId,
    request,
    ...(state === 'COMPLETED'
      ? {
          result: Object.freeze({
            artifact: Object.freeze({
              artifactId: 'artifact-stable-audio-3-orchestrator',
              createdAt: finishedAt,
              destination: 'stable-audio-3' as const,
              file: Object.freeze({
                extension: '.wav' as const,
                name: 'artifact-stable-audio-3-orchestrator.wav',
                relativePath:
                  'renders/stable-audio-3/artifact-stable-audio-3-orchestrator.wav',
                sizeBytes: 2_116_844,
              }),
              kind: 'audio' as const,
              lineage: request.lineage,
              provenance: Object.freeze({
                modelId: request.modelId,
                modelRevision: request.modelRevision,
                parameters: request.parameters,
                providerId: request.providerId,
                seed: request.parameters.seed,
                taskId: request.taskId,
              }),
            }),
            generation: Object.freeze({
              bytesWritten: 2_116_844,
              channels: 2 as const,
              durationSeconds: 12,
              mimeType: 'audio/wav' as const,
              providerCompletedAt: finishedAt,
            }),
          }),
        }
      : {}),
    startedAt: createdAt,
    state,
    taskId: dispatch.execution.taskId,
    updatedAt: isFinished ? finishedAt : createdAt,
  });
}

function createExpectedRequest(dispatch: StableAudio3StageDispatch) {
  return Object.freeze({
    inputArtifacts: Object.freeze([
      Object.freeze({
        artifactId: dispatch.source.artifactId,
        kind: 'audio' as const,
        relativePath: 'renders/instruments/artifact-source.wav',
      }),
    ]) as readonly [
      Readonly<{
        artifactId: string;
        kind: 'audio';
        relativePath: string;
      }>,
    ],
    lineage: Object.freeze({
      parentArtifactIds: Object.freeze([
        dispatch.source.artifactId,
      ]) as readonly [string],
      parentClipTakeIds: Object.freeze([
        dispatch.source.clipTakeId,
      ]) as readonly [string],
    }),
    modelId: 'stable-audio-3-medium' as const,
    modelRevision: dispatch.execution.modelRevision,
    output: Object.freeze({
      artifactKind: 'audio' as const,
      destination: 'stable-audio-3' as const,
      extension: '.wav' as const,
    }),
    parameters: Object.freeze({
      channels: 2 as const,
      durationSeconds: dispatch.parameters.durationSeconds,
      prompt: dispatch.parameters.prompt,
      sampleRate: 44_100 as const,
      seed: dispatch.parameters.seed,
      sourceEndSeconds: 12,
      sourceStartSeconds: 0,
      strength: dispatch.parameters.strength,
    }),
    providerId: 'local-stable-audio-3' as const,
    taskId: 'audio-to-audio' as const,
  });
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
    name: 'Stable Audio 3 Stage Orchestrator Test',
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
            createdAt: '2026-08-03T03:30:00.000Z',
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
    createdAt: '2026-08-03T03:30:00.000Z',
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
    createdAt: '2026-08-03T03:30:00.000Z',
    label: 'Source Take 01',
    mediaType: 'audio',
    sourceJobId: 'job-source',
    sourceType: 'job',
  };
}

function findClip(project: ProjectState, clipId: string) {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`Clip not found: ${clipId}.`);
  }

  return clip;
}
