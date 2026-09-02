import type {
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineJobs';
import type { StableAudio3StageAdapterPlan } from './stableAudio3StageAdapter';
import type { StableAudio3StageCompletedJob } from './stableAudio3StageCompletion';

export type StableAudio3StageJobOutcome =
  | Readonly<{
      completed: StableAudio3StageCompletedJob;
      ok: true;
      status: 'JOB_COMPLETED';
    }>
  | Readonly<{
      jobId: string;
      jobState: LocalEngineGpuJobState;
      message: string;
      ok: false;
      reason: 'job-pending';
      status: 'PENDING';
    }>
  | Readonly<{
      cause: string;
      jobId: string;
      jobState: LocalEngineGpuJobState;
      message: string;
      ok: false;
      reason: 'canceled';
      status: 'CANCELED';
    }>
  | Readonly<{
      cause: string;
      jobId: string;
      jobState: LocalEngineGpuJobState;
      message: string;
      ok: false;
      reason:
        | 'engine-job-failed'
        | 'job-identity-mismatch';
      status: 'FAILED';
    }>;

export function resolveStableAudio3StageJobOutcome(
  plan: StableAudio3StageAdapterPlan,
  job: LocalEngineGpuJobRecord,
): StableAudio3StageJobOutcome {
  if (!doesJobMatchPlan(job, plan)) {
    return terminalFailure(
      job,
      'job-identity-mismatch',
      'stable-audio-3-job-plan-mismatch',
      'Stable Audio 3 Job does not match the immutable Stage plan.',
    );
  }

  switch (job.state) {
    case 'COMPLETED':
      if (!job.finishedAt || Number.isNaN(Date.parse(job.finishedAt))) {
        return terminalFailure(
          job,
          'engine-job-failed',
          'stable-audio-3-completed-job-invalid',
          'Stable Audio 3 Job reported COMPLETED without a valid finish time.',
        );
      }

      return Object.freeze({
        completed: Object.freeze({
          adapterId: plan.adapterId,
          attemptId: plan.attemptId,
          fingerprint: plan.fingerprint,
          job,
          runId: plan.runId,
          scope: Object.freeze({ ...plan.scope }),
          status: 'JOB_COMPLETED' as const,
        }),
        ok: true,
        status: 'JOB_COMPLETED' as const,
      });

    case 'CANCELED':
      return Object.freeze({
        cause: 'stage-run-canceled',
        jobId: job.jobId,
        jobState: job.state,
        message: `Stable Audio 3 Job ${job.jobId} was canceled without output registration.`,
        ok: false,
        reason: 'canceled' as const,
        status: 'CANCELED' as const,
      });

    case 'FAILED':
      return terminalFailure(
        job,
        'engine-job-failed',
        'stable-audio-3-engine-job-failed',
        job.error?.message ??
          `Stable Audio 3 Job ${job.jobId} failed without an Engine error message.`,
      );

    case 'INTERRUPTED':
    case 'PAUSED':
      return terminalFailure(
        job,
        'engine-job-failed',
        `stable-audio-3-job-${job.state.toLowerCase()}`,
        `Stable Audio 3 Job ${job.jobId} stopped in ${job.state} and cannot complete this Stage attempt.`,
      );

    case 'CANCEL_REQUESTED':
      return pending(
        job,
        `Stable Audio 3 Job ${job.jobId} is awaiting a terminal cancellation state.`,
      );

    case 'QUEUED':
    case 'LOADING_MODEL':
    case 'PROCESSING':
    case 'SAVING':
      return pending(
        job,
        `Stable Audio 3 Job ${job.jobId} is still ${job.state}.`,
      );
  }
}

function doesJobMatchPlan(
  job: LocalEngineGpuJobRecord,
  plan: StableAudio3StageAdapterPlan,
): boolean {
  return (
    job.providerId === plan.request.providerId &&
    job.taskId === plan.request.taskId &&
    job.modelId === plan.request.modelId &&
    job.modelRevision === plan.request.modelRevision &&
    areJsonValuesEqual(job.request, plan.request)
  );
}

function pending(
  job: LocalEngineGpuJobRecord,
  message: string,
): Extract<StableAudio3StageJobOutcome, { status: 'PENDING' }> {
  return Object.freeze({
    jobId: job.jobId,
    jobState: job.state,
    message,
    ok: false,
    reason: 'job-pending',
    status: 'PENDING',
  });
}

function terminalFailure(
  job: LocalEngineGpuJobRecord,
  reason: Extract<
    StableAudio3StageJobOutcome,
    { status: 'FAILED' }
  >['reason'],
  cause: string,
  message: string,
): Extract<StableAudio3StageJobOutcome, { status: 'FAILED' }> {
  return Object.freeze({
    cause,
    jobId: job.jobId,
    jobState: job.state,
    message,
    ok: false,
    reason,
    status: 'FAILED',
  });
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        areJsonValuesEqual(value, right[index]),
      )
    );
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        areJsonValuesEqual(left[key], right[key]),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
