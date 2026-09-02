import { describe, expect, it, vi } from 'vitest';

import type {
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineClient';
import type { StableAudio3StageAdapterPlan } from './stableAudio3StageAdapter';
import {
  executeStableAudio3StagePlan,
  type StableAudio3StageExecutionOptions,
} from './stableAudio3StageExecution';
import type { StableAudio3StageRunnerClient } from './stableAudio3StageRunner';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';

const MODEL_REVISION = 'a'.repeat(40);
const RESULT_ID = 'result-stable-audio-3-execution';

describe('Stable Audio 3 Stage execution', () => {
  it('runs and atomically settles one exact completed Job', async () => {
    const fixture = createFixture();
    const snapshot = JSON.stringify(fixture.project);
    const result = await executeStableAudio3StagePlan(
      createClient(fixture.plan, [createJob('COMPLETED', fixture.plan)]),
      fixture.project,
      fixture.plan,
      createOptions(),
    );

    expect(result).toMatchObject({
      ok: true,
      runner: { status: 'JOB_COMPLETED' },
      settlement: {
        completion: { registrationStatus: 'REGISTERED' },
        status: 'STAGE_COMPLETED',
      },
      status: 'STAGE_COMPLETED',
    });

    if (!result.ok) {
      throw new Error('Expected Stable Audio 3 execution to complete.');
    }

    expect(result.project).not.toBe(fixture.project);
    expect(result.project.artifacts).toHaveLength(2);
    expect(result.project.tabFlowStageResults).toEqual([
      result.settlement.completion.result,
    ]);
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
  });

  it('keeps a polling-limited Job pending without settling Project output', async () => {
    const fixture = createFixture();
    const snapshot = JSON.stringify(fixture.project);
    const result = await executeStableAudio3StagePlan(
      createClient(fixture.plan, [createJob('PROCESSING', fixture.plan)]),
      fixture.project,
      fixture.plan,
      createOptions({ maxPollAttempts: 1 }),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'poll-limit-reached',
      runner: {
        outcome: { jobState: 'PROCESSING', status: 'PENDING' },
        status: 'JOB_PENDING',
      },
      status: 'STAGE_PENDING',
    });
    expect(result.project).toBe(fixture.project);
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
  });

  it('cancels before enqueue without contacting the Engine or changing Project', async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    const enqueueStableAudio3Job = vi.fn();
    controller.abort();
    const result = await executeStableAudio3StagePlan(
      createClient(fixture.plan, [], { enqueueStableAudio3Job }),
      fixture.project,
      fixture.plan,
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

  it('keeps terminal Engine cancellation distinct from Stage failure', async () => {
    const fixture = createFixture();
    const result = await executeStableAudio3StagePlan(
      createClient(fixture.plan, [createJob('CANCELED', fixture.plan)]),
      fixture.project,
      fixture.plan,
      createOptions(),
    );

    expect(result).toMatchObject({
      cause: 'stage-run-canceled',
      ok: false,
      reason: 'job-canceled',
      runner: { status: 'JOB_CANCELED' },
      status: 'STAGE_CANCELED',
    });
    expect(result.project).toBe(fixture.project);
    expect(fixture.project.tabFlowStageResults).toBeUndefined();
  });

  it('keeps terminal Engine failure distinct from transport failure', async () => {
    const fixture = createFixture();
    const result = await executeStableAudio3StagePlan(
      createClient(fixture.plan, [createJob('FAILED', fixture.plan)]),
      fixture.project,
      fixture.plan,
      createOptions(),
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-engine-job-failed',
      ok: false,
      reason: 'runner-failed',
      runner: {
        outcome: { reason: 'engine-job-failed', status: 'FAILED' },
        status: 'JOB_FAILED',
      },
      status: 'STAGE_FAILED',
    });
    expect(result.project).toBe(fixture.project);
    expect(fixture.project.tabFlowStageResults).toBeUndefined();
  });

  it('returns transport failure without settling or changing Project', async () => {
    const fixture = createFixture();
    const getJobs = vi.fn();
    const result = await executeStableAudio3StagePlan(
      createClient(fixture.plan, [], {
        enqueueStableAudio3Job: vi.fn(async () => ({
          message: 'Stable Audio 3 is unavailable.',
          ok: false as const,
          reason: 'http-error' as const,
          status: 400,
        })),
        getJobs,
      }),
      fixture.project,
      fixture.plan,
      createOptions(),
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-enqueue-http-error',
      ok: false,
      reason: 'runner-failed',
      runner: { reason: 'enqueue-failed', status: 'RUNNER_FAILED' },
      status: 'STAGE_FAILED',
    });
    expect(result.project).toBe(fixture.project);
    expect(getJobs).not.toHaveBeenCalled();
  });

  it('rolls back completed output when settlement sees a stale Active Take', async () => {
    const fixture = createFixture();
    const sourceClip = findClip(fixture.project, 'clip-source');
    sourceClip.activeClipTakeId = 'clip-take-missing';
    const snapshot = JSON.stringify(fixture.project);
    const result = await executeStableAudio3StagePlan(
      createClient(fixture.plan, [createJob('COMPLETED', fixture.plan)]),
      fixture.project,
      fixture.plan,
      createOptions(),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'settlement-failed',
      runner: { status: 'JOB_COMPLETED' },
      settlement: {
        reason: 'completion-failed',
        status: 'STAGE_FAILED',
      },
      status: 'STAGE_FAILED',
    });
    expect(result.project).toBe(fixture.project);
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
    expect(fixture.project.artifacts).toHaveLength(1);
  });
});

function createOptions(
  runner: NonNullable<StableAudio3StageExecutionOptions['runner']> = {},
): StableAudio3StageExecutionOptions {
  return {
    completion: {
      label: 'SA3 Execution Take',
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

function createFixture(): Readonly<{
  plan: StableAudio3StageAdapterPlan;
  project: ProjectState;
}> {
  const project = createProject();
  const request = Object.freeze({
    inputArtifacts: Object.freeze([
      Object.freeze({
        artifactId: 'artifact-source',
        kind: 'audio' as const,
        relativePath: 'renders/instruments/artifact-source.wav',
      }),
    ]) as StableAudio3StageAdapterPlan['request']['inputArtifacts'],
    lineage: Object.freeze({
      parentArtifactIds: Object.freeze(['artifact-source']) as readonly [string],
      parentClipTakeIds: Object.freeze(['clip-take-source']) as readonly [string],
    }),
    modelId: 'stable-audio-3-medium' as const,
    modelRevision: MODEL_REVISION,
    output: Object.freeze({
      artifactKind: 'audio' as const,
      destination: 'stable-audio-3' as const,
      extension: '.wav' as const,
    }),
    parameters: Object.freeze({
      channels: 2 as const,
      durationSeconds: 12,
      prompt: 'Warm electric bass with a tight pocket',
      sampleRate: 44_100 as const,
      seed: 7,
      sourceEndSeconds: 12,
      sourceStartSeconds: 0,
      strength: 0.4,
    }),
    providerId: 'local-stable-audio-3' as const,
    taskId: 'audio-to-audio' as const,
  });
  const plan: StableAudio3StageAdapterPlan = Object.freeze({
    adapterId: 'local-stable-audio-3-audio-to-audio-v1',
    attemptId: 'attempt-sa3-execution',
    fingerprint: 'fingerprint-sa3-execution',
    kind: 'local-engine-gpu-job',
    request,
    runId: 'run-sa3-execution',
    runtime: Object.freeze({
      modelCompatibility: 'PARTIAL_SUPPORT',
      profileId: 'windows-target-verified-test',
      providerVersion: '0.1.0',
      supportsCancellation: false,
    }),
    scope: Object.freeze({
      familyId: 'family-root',
      familyRevision: 3,
      stageId: 'stage-sa3-execution',
      targetClipId: 'clip-source',
    }),
    sourceClipId: 'clip-source',
  });

  return { plan, project };
}

function createClient(
  plan: StableAudio3StageAdapterPlan,
  snapshots: readonly LocalEngineGpuJobRecord[],
  overrides: Partial<StableAudio3StageRunnerClient> = {},
): StableAudio3StageRunnerClient {
  const queued = createJob('QUEUED', plan);
  let snapshotIndex = 0;
  const client: StableAudio3StageRunnerClient = {
    cancelJob: async () => ({
      job: createJob('CANCEL_REQUESTED', plan),
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
  plan: StableAudio3StageAdapterPlan,
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-03T03:30:00.000Z';
  const finishedAt = '2026-08-03T03:30:12.000Z';
  const isFinished = [
    'COMPLETED',
    'CANCELED',
    'FAILED',
    'INTERRUPTED',
  ].includes(state);

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
    jobId: 'job-stable-audio-3-execution',
    modelId: plan.request.modelId,
    modelRevision: plan.request.modelRevision,
    providerId: plan.request.providerId,
    request: plan.request,
    ...(state === 'COMPLETED'
      ? {
          result: Object.freeze({
            artifact: Object.freeze({
              artifactId: 'artifact-stable-audio-3-execution',
              createdAt: finishedAt,
              destination: 'stable-audio-3' as const,
              file: Object.freeze({
                extension: '.wav' as const,
                name: 'artifact-stable-audio-3-execution.wav',
                relativePath:
                  'renders/stable-audio-3/artifact-stable-audio-3-execution.wav',
                sizeBytes: 2_116_844,
              }),
              kind: 'audio' as const,
              lineage: plan.request.lineage,
              provenance: Object.freeze({
                modelId: plan.request.modelId,
                modelRevision: plan.request.modelRevision,
                parameters: plan.request.parameters,
                providerId: plan.request.providerId,
                seed: plan.request.parameters.seed,
                taskId: plan.request.taskId,
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
    taskId: plan.request.taskId,
    updatedAt: isFinished ? finishedAt : createdAt,
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
    name: 'Stable Audio 3 Stage Execution Test',
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
            createdAt: '2026-08-03T03:00:00.000Z',
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
    createdAt: '2026-08-03T03:00:00.000Z',
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
    createdAt: '2026-08-03T03:00:00.000Z',
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
