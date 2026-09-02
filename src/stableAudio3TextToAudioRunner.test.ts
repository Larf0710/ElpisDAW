import { describe, expect, it, vi } from 'vitest';

import { AUDIO_GENERATION_REGION_TICKS_PER_BAR } from './audioGenerationRegion';
import type {
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineClient';
import {
  resolveStableAudio3TextToAudioCapability,
  type StableAudio3TextToAudioJobPlan,
} from './stableAudio3TextToAudioCapability';
import {
  runStableAudio3TextToAudioPlan,
  type StableAudio3TextToAudioRunnerClient,
} from './stableAudio3TextToAudioRunner';
import type { ProjectState } from './types';

const MODEL_REVISION = '27b5a21b791b1b033d193a9e1e3ce78493f102f9';
const RUNTIME_PROFILE =
  'windows-x64-cpython-3-10-pytorch-2-7-1-cu126-flash-attention-2-8-3';

describe('Stable Audio 3 text-to-audio Runner', () => {
  it('reports same-state model progress updates and returns the exact completed Job', async () => {
    const plan = createPlan();
    const onProgress = vi.fn();
    const wait = vi.fn(async () => undefined);
    const completed = createJob('COMPLETED', plan);
    const processing = createJob('PROCESSING', plan);
    const client = createClient(plan, [
      Object.freeze({
        ...processing,
        progress: Object.freeze({
          accuracy: 'MEASURED' as const,
          currentStep: 4,
          percent: 50,
          totalSteps: 8,
          updatedAt: '2026-08-06T01:15:01.000Z',
        }),
      }),
      Object.freeze({
        ...processing,
        progress: Object.freeze({
          accuracy: 'MEASURED' as const,
          currentStep: 6,
          percent: 75,
          totalSteps: 8,
          updatedAt: '2026-08-06T01:15:02.000Z',
        }),
      }),
      completed,
    ]);

    const result = await runStableAudio3TextToAudioPlan(client, plan, {
      maxPollAttempts: 3,
      onProgress,
      pollIntervalMs: 0,
      wait,
    });

    expect(result).toEqual({
      job: completed,
      jobId: completed.jobId,
      ok: true,
      status: 'JOB_COMPLETED',
    });
    expect(onProgress.mock.calls.map(([progress]) => progress.state)).toEqual([
      'ENQUEUEING',
      'QUEUED',
      'PROCESSING',
      'PROCESSING',
      'COMPLETED',
    ]);
    expect(onProgress.mock.calls[2]?.[0]).toMatchObject({
      jobProgress: { currentStep: 4, percent: 50, totalSteps: 8 },
    });
    expect(onProgress.mock.calls[3]?.[0]).toMatchObject({
      jobProgress: { currentStep: 6, percent: 75, totalSteps: 8 },
    });
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it('rejects enqueue identity drift before polling', async () => {
    const plan = createPlan();
    const getJobs = vi.fn();
    const mismatched = {
      ...createJob('QUEUED', plan),
      taskId: 'audio-to-audio',
    };
    const result = await runStableAudio3TextToAudioPlan(
      createClient(plan, [], {
        enqueueStableAudio3Job: vi.fn(async () => ({
          job: mismatched,
          ok: true as const,
        })),
        getJobs,
      }),
      plan,
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-t2a-job-plan-mismatch',
      jobId: 'job-stable-audio-3-t2a-runner',
      ok: false,
      reason: 'job-plan-mismatch',
      status: 'RUNNER_FAILED',
    });
    expect(getJobs).not.toHaveBeenCalled();
  });

  it('returns an Engine failure without exposing it as completed output', async () => {
    const plan = createPlan();
    const failed = createJob('FAILED', plan);
    const result = await runStableAudio3TextToAudioPlan(
      createClient(plan, [failed]),
      plan,
      { maxPollAttempts: 1, pollIntervalMs: 0, wait: async () => undefined },
    );

    expect(result).toMatchObject({
      cause: 'STABLE_AUDIO_3_INFERENCE_FAILED',
      job: failed,
      ok: false,
      reason: 'job-failed',
      status: 'JOB_FAILED',
    });
  });

  it('cancels before enqueue without contacting the Local Engine', async () => {
    const plan = createPlan();
    const controller = new AbortController();
    const enqueueStableAudio3Job = vi.fn();
    controller.abort();

    const result = await runStableAudio3TextToAudioPlan(
      createClient(plan, [], { enqueueStableAudio3Job }),
      plan,
      { signal: controller.signal },
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-t2a-run-canceled-before-enqueue',
      reason: 'canceled-before-enqueue',
      status: 'RUN_CANCELED',
    });
    expect(enqueueStableAudio3Job).not.toHaveBeenCalled();
  });

  it('removes an aborted queued Job without active cancellation', async () => {
    const plan = createPlan();
    const controller = new AbortController();
    const queued = createJob('QUEUED', plan);
    const removeQueuedJob = vi.fn(async () => ({
      ok: true as const,
      removedJob: queued,
    }));
    const cancelJob = vi.fn();
    const getJobs = vi.fn();

    const result = await runStableAudio3TextToAudioPlan(
      createClient(plan, [], { cancelJob, getJobs, removeQueuedJob }),
      plan,
      {
        onProgress: (progress) => {
          if (progress.state === 'QUEUED') {
            controller.abort();
          }
        },
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-t2a-queued-job-removed',
      jobId: queued.jobId,
      reason: 'queued-job-removed',
      status: 'RUN_CANCELED',
    });
    expect(removeQueuedJob).toHaveBeenCalledWith(queued.jobId);
    expect(cancelJob).not.toHaveBeenCalled();
    expect(getJobs).not.toHaveBeenCalled();
  });

  it('requests active cancellation once and waits for terminal CANCELED', async () => {
    const plan = createPlan();
    const controller = new AbortController();
    const processing = createJob('PROCESSING', plan);
    const cancelRequested = createJob('CANCEL_REQUESTED', plan);
    const canceled = createJob('CANCELED', plan);
    const cancelJob = vi.fn(async () => ({
      job: cancelRequested,
      ok: true as const,
    }));

    const result = await runStableAudio3TextToAudioPlan(
      createClient(plan, [processing, canceled], { cancelJob }),
      plan,
      {
        maxPollAttempts: 3,
        onProgress: (progress) => {
          if (progress.state === 'PROCESSING') {
            controller.abort();
          }
        },
        pollIntervalMs: 0,
        signal: controller.signal,
        wait: async () => undefined,
      },
    );

    expect(result).toMatchObject({
      job: canceled,
      reason: 'job-canceled',
      status: 'JOB_CANCELED',
    });
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith(processing.jobId);
  });

  it('lets completion win when abort arrives after SAVING', async () => {
    const plan = createPlan();
    const controller = new AbortController();
    const cancelJob = vi.fn();
    const removeQueuedJob = vi.fn();
    const completed = createJob('COMPLETED', plan);

    const result = await runStableAudio3TextToAudioPlan(
      createClient(
        plan,
        [createJob('SAVING', plan), completed],
        { cancelJob, removeQueuedJob },
      ),
      plan,
      {
        maxPollAttempts: 2,
        onProgress: (progress) => {
          if (progress.state === 'SAVING') {
            controller.abort();
          }
        },
        pollIntervalMs: 0,
        signal: controller.signal,
        wait: async () => undefined,
      },
    );

    expect(result).toMatchObject({
      job: completed,
      ok: true,
      status: 'JOB_COMPLETED',
    });
    expect(cancelJob).not.toHaveBeenCalled();
    expect(removeQueuedJob).not.toHaveBeenCalled();
  });

  it('returns the exact pending Job when the polling budget expires', async () => {
    const plan = createPlan();
    const processing = createJob('PROCESSING', plan);
    const result = await runStableAudio3TextToAudioPlan(
      createClient(plan, [processing]),
      plan,
      { maxPollAttempts: 1, pollIntervalMs: 0, wait: async () => undefined },
    );

    expect(result).toEqual({
      job: processing,
      jobId: processing.jobId,
      ok: false,
      reason: 'poll-limit-reached',
      status: 'JOB_PENDING',
    });
  });
});

function createPlan(): StableAudio3TextToAudioJobPlan {
  const project = createProject();
  const resolution = resolveStableAudio3TextToAudioCapability(
    project,
    {
      execution: {
        modelId: 'stable-audio-3-medium',
        modelRevision: MODEL_REVISION,
        providerId: 'local-stable-audio-3',
        taskId: 'text-to-audio',
      },
      output: {
        bars: 8,
        createdAt: '2026-08-06T01:15:00.000Z',
        generationPosition: 'playhead',
        outputClipId: 'sa3-t2a-clip-runner',
        outputClipName: 'SA3 T2A Clip',
        outputTrackId: 'sa3-t2a-track-runner',
        outputTrackName: 'SA3 T2A',
      },
      prompt: 'Warm analog synths with a patient cinematic build',
      seed: 17,
    },
    {
      model: {
        compatibility: 'PARTIAL_SUPPORT',
        modelId: 'stable-audio-3-medium',
        revision: MODEL_REVISION,
      },
      providerId: 'local-stable-audio-3',
      providerVersion: '0.1.0',
      runtime: {
        compatibility: 'COMPATIBLE',
        profileId: RUNTIME_PROFILE,
      },
      supportsCancellation: true,
      taskId: 'text-to-audio',
    },
  );

  if (!resolution.canEnqueue) {
    throw new Error(resolution.message);
  }

  return resolution.plan;
}

function createClient(
  plan: StableAudio3TextToAudioJobPlan,
  snapshots: readonly LocalEngineGpuJobRecord[],
  overrides: Partial<StableAudio3TextToAudioRunnerClient> = {},
): StableAudio3TextToAudioRunnerClient {
  const queued = createJob('QUEUED', plan);
  let snapshotIndex = 0;
  const client: StableAudio3TextToAudioRunnerClient = {
    cancelJob: async () => ({
      job: createJob('CANCEL_REQUESTED', plan),
      ok: true,
    }),
    enqueueStableAudio3Job: async () => ({ job: queued, ok: true }),
    getJobs: async () => {
      const job =
        snapshots[
          Math.min(snapshotIndex, Math.max(0, snapshots.length - 1))
        ] ?? queued;
      snapshotIndex += 1;
      return {
        ok: true,
        snapshot: {
          acceptingJobs: true,
          jobs: [job],
        },
      };
    },
    removeQueuedJob: async () => ({ ok: true, removedJob: queued }),
  };

  return { ...client, ...overrides };
}

function createJob(
  state: LocalEngineGpuJobState,
  plan: StableAudio3TextToAudioJobPlan,
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-06T01:15:00.000Z';
  const finishedAt = '2026-08-06T01:15:16.000Z';
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
    ...(state === 'FAILED'
      ? {
          error: {
            code: 'STABLE_AUDIO_3_INFERENCE_FAILED',
            message: 'Stable Audio 3 inference failed.',
          },
        }
      : {}),
    ...(isFinished ? { finishedAt } : {}),
    history: Object.freeze([
      Object.freeze({ attempt: 1, at: createdAt, state }),
    ]),
    jobId: 'job-stable-audio-3-t2a-runner',
    modelId: plan.request.modelId,
    modelRevision: plan.request.modelRevision,
    providerId: plan.request.providerId,
    request: plan.request,
    ...(state === 'COMPLETED'
      ? { result: Object.freeze({ accepted: true }) }
      : {}),
    startedAt: createdAt,
    state,
    taskId: plan.request.taskId,
    updatedAt: isFinished ? finishedAt : createdAt,
  });
}

function createProject(): ProjectState {
  return {
    artifacts: [],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'SA3 T2A Runner Test',
    patchTabs: [],
    playheadTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 2,
    recordingSettings: {
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: '',
    selection: { items: [] },
    status: 'READY',
    tabFlowLines: [],
    tabFlowStageResults: [],
    takes: [],
    totalTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 16,
    tracks: [],
  };
}
