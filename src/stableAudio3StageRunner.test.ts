import { describe, expect, it, vi } from 'vitest';

import type {
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineClient';
import type { StableAudio3StageAdapterPlan } from './stableAudio3StageAdapter';
import {
  runStableAudio3StagePlan,
  type StableAudio3StageRunnerClient,
} from './stableAudio3StageRunner';

const MODEL_REVISION = 'a'.repeat(40);

describe('Stable Audio 3 Stage Runner', () => {
  it('enqueues, polls, and returns one exact completed Job', async () => {
    const plan = createPlan();
    const onProgress = vi.fn();
    const client = createClient(plan, [
      createJob('PROCESSING', plan),
      createJob('COMPLETED', plan),
    ]);
    const result = await runStableAudio3StagePlan(client, plan, {
      maxPollAttempts: 2,
      onProgress,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });

    expect(result).toMatchObject({
      jobId: 'job-stable-audio-3-runner',
      ok: true,
      outcome: { status: 'JOB_COMPLETED' },
      status: 'JOB_COMPLETED',
    });
    expect(onProgress.mock.calls.map(([progress]) => progress.state)).toEqual([
      'ENQUEUEING',
      'QUEUED',
      'PROCESSING',
      'COMPLETED',
    ]);
  });

  it('returns an enqueue transport failure without allocating a Job identity', async () => {
    const plan = createPlan();
    const getJobs = vi.fn();
    const client = createClient(plan, [], {
      enqueueStableAudio3Job: vi.fn(async () => ({
        message: 'Stable Audio 3 is unavailable.',
        ok: false as const,
        reason: 'http-error' as const,
        status: 400,
      })),
      getJobs,
    });
    const result = await runStableAudio3StagePlan(client, plan);

    expect(result).toMatchObject({
      cause: 'stable-audio-3-enqueue-http-error',
      ok: false,
      reason: 'enqueue-failed',
      status: 'RUNNER_FAILED',
    });
    expect(result).not.toHaveProperty('jobId');
    expect(getJobs).not.toHaveBeenCalled();
  });

  it('keeps a still-processing Job pending when the polling budget expires', async () => {
    const plan = createPlan();
    const processing = createJob('PROCESSING', plan);
    const result = await runStableAudio3StagePlan(
      createClient(plan, [processing]),
      plan,
      {
        maxPollAttempts: 1,
        pollIntervalMs: 0,
        wait: async () => undefined,
      },
    );

    expect(result).toMatchObject({
      jobId: processing.jobId,
      ok: false,
      outcome: { jobState: 'PROCESSING', status: 'PENDING' },
      reason: 'poll-limit-reached',
      status: 'JOB_PENDING',
    });
  });

  it('keeps polling to a terminal Job in production terminal mode', async () => {
    const plan = createPlan();
    const wait = vi.fn(async () => undefined);
    const client = createClient(plan, [
      createJob('PROCESSING', plan),
      createJob('PROCESSING', plan),
      createJob('COMPLETED', plan),
    ]);
    const result = await runStableAudio3StagePlan(client, plan, {
      maxPollAttempts: 1,
      pollIntervalMs: 0,
      pollUntilTerminal: true,
      wait,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'JOB_COMPLETED',
    });
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('separates Job disappearance from an Engine-reported Job failure', async () => {
    const plan = createPlan();
    const missingClient = createClient(plan, [], {
      getJobs: vi.fn(async () => ({
        ok: true as const,
        snapshot: { acceptingJobs: true, jobs: [] },
      })),
    });
    const failedClient = createClient(plan, [createJob('FAILED', plan)]);
    const missing = await runStableAudio3StagePlan(missingClient, plan);
    const failed = await runStableAudio3StagePlan(failedClient, plan);

    expect(missing).toMatchObject({
      ok: false,
      reason: 'job-missing',
      status: 'RUNNER_FAILED',
    });
    expect(failed).toMatchObject({
      cause: 'stable-audio-3-engine-job-failed',
      ok: false,
      reason: 'job-failed',
      status: 'JOB_FAILED',
    });
  });

  it('rejects Job identity drift through the shared Stage outcome boundary', async () => {
    const plan = createPlan();
    const mismatched = {
      ...createJob('COMPLETED', plan),
      modelRevision: 'b'.repeat(40),
    } as LocalEngineGpuJobRecord;
    const result = await runStableAudio3StagePlan(
      createClient(plan, [mismatched]),
      plan,
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-job-plan-mismatch',
      ok: false,
      outcome: { reason: 'job-identity-mismatch' },
      reason: 'job-failed',
      status: 'JOB_FAILED',
    });
  });

  it('cancels before enqueue without contacting the Engine', async () => {
    const plan = createPlan();
    const controller = new AbortController();
    const enqueueStableAudio3Job = vi.fn();
    controller.abort();
    const result = await runStableAudio3StagePlan(
      createClient(plan, [], { enqueueStableAudio3Job }),
      plan,
      { signal: controller.signal },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'canceled-before-enqueue',
      status: 'RUN_CANCELED',
    });
    expect(enqueueStableAudio3Job).not.toHaveBeenCalled();
  });

  it('removes an aborted queued Job without requesting active cancellation', async () => {
    const plan = createPlan();
    const controller = new AbortController();
    const queued = createJob('QUEUED', plan);
    const removeQueuedJob = vi.fn(async () => ({
      ok: true as const,
      removedJob: queued,
    }));
    const cancelJob = vi.fn();
    const getJobs = vi.fn();
    const result = await runStableAudio3StagePlan(
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
      cause: 'stable-audio-3-queued-job-removed',
      jobId: queued.jobId,
      ok: false,
      reason: 'queued-job-removed',
      status: 'RUN_CANCELED',
    });
    expect(removeQueuedJob).toHaveBeenCalledWith(queued.jobId);
    expect(cancelJob).not.toHaveBeenCalled();
    expect(getJobs).not.toHaveBeenCalled();
  });

  it('returns an active Job as pending when the Runtime cannot cancel safely', async () => {
    const plan = createPlan({ supportsCancellation: false });
    const controller = new AbortController();
    const cancelJob = vi.fn();
    const processing = createJob('PROCESSING', plan);
    const result = await runStableAudio3StagePlan(
      createClient(plan, [processing], { cancelJob }),
      plan,
      {
        maxPollAttempts: 2,
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
      jobId: processing.jobId,
      ok: false,
      outcome: { jobState: 'PROCESSING', status: 'PENDING' },
      reason: 'cancellation-unsupported',
      status: 'JOB_PENDING',
    });
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it('requests supported active cancellation once and waits for terminal CANCELED', async () => {
    const plan = createPlan({ supportsCancellation: true });
    const controller = new AbortController();
    const processing = createJob('PROCESSING', plan);
    const cancelRequested = createJob('CANCEL_REQUESTED', plan);
    const canceled = createJob('CANCELED', plan);
    const cancelJob = vi.fn(async () => ({
      job: cancelRequested,
      ok: true as const,
    }));
    const result = await runStableAudio3StagePlan(
      createClient(plan, [processing, canceled], { cancelJob }),
      plan,
      {
        maxPollAttempts: 2,
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
      jobId: canceled.jobId,
      ok: false,
      outcome: { status: 'CANCELED' },
      reason: 'job-canceled',
      status: 'JOB_CANCELED',
    });
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith(processing.jobId);
  });

  it('lets completion win when abort arrives after the Job reaches SAVING', async () => {
    const plan = createPlan({ supportsCancellation: false });
    const controller = new AbortController();
    const cancelJob = vi.fn();
    const removeQueuedJob = vi.fn();
    const result = await runStableAudio3StagePlan(
      createClient(
        plan,
        [createJob('SAVING', plan), createJob('COMPLETED', plan)],
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
      ok: true,
      outcome: { status: 'JOB_COMPLETED' },
      status: 'JOB_COMPLETED',
    });
    expect(cancelJob).not.toHaveBeenCalled();
    expect(removeQueuedJob).not.toHaveBeenCalled();
  });
});

function createPlan(
  options: Readonly<{ supportsCancellation?: boolean }> = {},
): StableAudio3StageAdapterPlan {
  const request = Object.freeze({
    inputArtifacts: Object.freeze([
      Object.freeze({
        artifactId: 'artifact-instrument-a',
        kind: 'audio' as const,
        relativePath: 'renders/instruments/artifact-instrument-a.wav',
      }),
    ]) as StableAudio3StageAdapterPlan['request']['inputArtifacts'],
    lineage: Object.freeze({
      parentArtifactIds: Object.freeze(['artifact-instrument-a']) as readonly [string],
      parentClipTakeIds: Object.freeze(['clip-take-instrument-a']) as readonly [string],
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

  return Object.freeze({
    adapterId: 'local-stable-audio-3-audio-to-audio-v1',
    attemptId: 'attempt-sa3-runner',
    fingerprint: 'fingerprint-sa3-runner',
    kind: 'local-engine-gpu-job',
    request,
    runId: 'run-sa3-runner',
    runtime: Object.freeze({
      modelCompatibility: 'PARTIAL_SUPPORT' as const,
      profileId: 'windows-target-verified-test',
      providerVersion: '0.1.0',
      supportsCancellation: options.supportsCancellation ?? false,
    }),
    scope: Object.freeze({
      familyId: 'family-root',
      familyRevision: 3,
      stageId: 'stage-sa3-runner',
      targetClipId: 'clip-instrument-a',
    }),
    sourceClipId: 'clip-instrument-a',
  });
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
  plan: StableAudio3StageAdapterPlan,
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-03T03:00:00.000Z';
  const finishedAt = '2026-08-03T03:00:12.000Z';
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
            code: 'PROVIDER_EXITED',
            message: 'Provider process exited unexpectedly.',
          },
        }
      : {}),
    ...(isFinished ? { finishedAt } : {}),
    history: Object.freeze([
      Object.freeze({ attempt: 1, at: createdAt, state }),
    ]),
    jobId: 'job-stable-audio-3-runner',
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
