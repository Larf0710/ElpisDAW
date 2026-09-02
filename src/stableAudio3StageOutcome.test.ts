import { describe, expect, it } from 'vitest';

import type {
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineJobs';
import type { StableAudio3StageAdapterPlan } from './stableAudio3StageAdapter';
import { resolveStableAudio3StageJobOutcome } from './stableAudio3StageOutcome';

const MODEL_REVISION = 'a'.repeat(40);

describe('Stable Audio 3 Stage Job outcome', () => {
  it('creates the exact completed Stage envelope only for a matching completed Job', () => {
    const plan = createPlan();
    const job = createJob('COMPLETED', plan);
    const outcome = resolveStableAudio3StageJobOutcome(plan, job);

    expect(outcome).toEqual({
      completed: {
        adapterId: 'local-stable-audio-3-audio-to-audio-v1',
        attemptId: 'attempt-sa3-a',
        fingerprint: 'fingerprint-sa3-a',
        job,
        runId: 'run-sa3-a',
        scope: {
          familyId: 'family-root',
          familyRevision: 3,
          stageId: 'stage-sa3-a',
          targetClipId: 'clip-source',
        },
        status: 'JOB_COMPLETED',
      },
      ok: true,
      status: 'JOB_COMPLETED',
    });

    if (!outcome.ok) {
      return;
    }

    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.completed)).toBe(true);
    expect(Object.isFrozen(outcome.completed.scope)).toBe(true);
  });

  it('keeps every active Job state pending and non-registerable', () => {
    const plan = createPlan();

    for (const state of [
      'QUEUED',
      'LOADING_MODEL',
      'PROCESSING',
      'SAVING',
    ] as const) {
      expect(
        resolveStableAudio3StageJobOutcome(
          plan,
          createJob(state, plan),
        ),
      ).toMatchObject({
        jobState: state,
        ok: false,
        reason: 'job-pending',
        status: 'PENDING',
      });
    }
  });

  it('waits for terminal cancellation and never exposes a completed envelope', () => {
    const plan = createPlan();
    const requested = resolveStableAudio3StageJobOutcome(
      plan,
      createJob('CANCEL_REQUESTED', plan),
    );
    const canceled = resolveStableAudio3StageJobOutcome(
      plan,
      createJob('CANCELED', plan),
    );

    expect(requested).toMatchObject({
      jobState: 'CANCEL_REQUESTED',
      ok: false,
      reason: 'job-pending',
      status: 'PENDING',
    });
    expect(canceled).toEqual({
      cause: 'stage-run-canceled',
      jobId: 'job-stable-audio-3',
      jobState: 'CANCELED',
      message:
        'Stable Audio 3 Job job-stable-audio-3 was canceled without output registration.',
      ok: false,
      reason: 'canceled',
      status: 'CANCELED',
    });
    expect('completed' in requested).toBe(false);
    expect('completed' in canceled).toBe(false);
  });

  it('maps failed, interrupted, and paused Jobs to terminal Stage failure', () => {
    const plan = createPlan();
    const failed = resolveStableAudio3StageJobOutcome(
      plan,
      createJob('FAILED', plan),
    );

    expect(failed).toMatchObject({
      cause: 'stable-audio-3-engine-job-failed',
      jobState: 'FAILED',
      message: 'Provider process exited unexpectedly.',
      ok: false,
      reason: 'engine-job-failed',
      status: 'FAILED',
    });

    for (const state of ['INTERRUPTED', 'PAUSED'] as const) {
      expect(
        resolveStableAudio3StageJobOutcome(
          plan,
          createJob(state, plan),
        ),
      ).toMatchObject({
        jobState: state,
        ok: false,
        reason: 'engine-job-failed',
        status: 'FAILED',
      });
    }
  });

  it('rejects a Job whose immutable request no longer matches the Stage plan', () => {
    const plan = createPlan();
    const job = createJob('COMPLETED', plan);
    const mismatched = {
      ...job,
      request: {
        ...job.request,
        parameters: {
          ...(job.request.parameters as Record<string, unknown>),
          prompt: 'Changed after Stage planning',
        },
      },
    } as LocalEngineGpuJobRecord;
    const outcome = resolveStableAudio3StageJobOutcome(plan, mismatched);

    expect(outcome).toMatchObject({
      cause: 'stable-audio-3-job-plan-mismatch',
      ok: false,
      reason: 'job-identity-mismatch',
      status: 'FAILED',
    });
    expect('completed' in outcome).toBe(false);
  });

  it('rejects a malformed completed Job timestamp', () => {
    const plan = createPlan();
    const job = {
      ...createJob('COMPLETED', plan),
      finishedAt: undefined,
    } as LocalEngineGpuJobRecord;
    const outcome = resolveStableAudio3StageJobOutcome(plan, job);

    expect(outcome).toMatchObject({
      cause: 'stable-audio-3-completed-job-invalid',
      ok: false,
      reason: 'engine-job-failed',
      status: 'FAILED',
    });
    expect('completed' in outcome).toBe(false);
  });
});

function createPlan(): StableAudio3StageAdapterPlan {
  const request = Object.freeze({
    inputArtifacts: Object.freeze([
      Object.freeze({
        artifactId: 'artifact-source',
        kind: 'audio' as const,
        relativePath: 'renders/instruments/artifact-source.wav',
      }),
    ]) as StableAudio3StageAdapterPlan['request']['inputArtifacts'],
    lineage: Object.freeze({
      parentArtifactIds: Object.freeze([
        'artifact-source',
      ]) as readonly [string],
      parentClipTakeIds: Object.freeze([
        'clip-take-source',
      ]) as readonly [string],
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
    attemptId: 'attempt-sa3-a',
    fingerprint: 'fingerprint-sa3-a',
    kind: 'local-engine-gpu-job',
    request,
    runId: 'run-sa3-a',
    runtime: Object.freeze({
      modelCompatibility: 'PARTIAL_SUPPORT',
      profileId: 'windows-target-verified-test',
      providerVersion: '0.1.0',
      supportsCancellation: false,
    }),
    scope: Object.freeze({
      familyId: 'family-root',
      familyRevision: 3,
      stageId: 'stage-sa3-a',
      targetClipId: 'clip-source',
    }),
    sourceClipId: 'clip-source',
  });
}

function createJob(
  state: LocalEngineGpuJobState,
  plan: StableAudio3StageAdapterPlan,
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-03T00:00:00.000Z';
  const finishedAt = '2026-08-03T00:00:12.000Z';
  const isFinished = [
    'COMPLETED',
    'CANCELED',
    'FAILED',
    'INTERRUPTED',
  ].includes(state);

  return {
    attempt: 1,
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
    jobId: 'job-stable-audio-3',
    modelId: plan.request.modelId,
    modelRevision: plan.request.modelRevision,
    providerId: plan.request.providerId,
    request: plan.request,
    ...(state === 'COMPLETED' ? { result: {} } : {}),
    ...(state === 'CANCEL_REQUESTED'
      ? { cancelRequestedAt: createdAt }
      : {}),
    startedAt: createdAt,
    state,
    taskId: plan.request.taskId,
    updatedAt: isFinished ? finishedAt : createdAt,
  };
}
