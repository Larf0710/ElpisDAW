import type { AutoPatchStageAdapterPlan } from './autoPatchStageAdapter';
import type {
  LocalEngineClient,
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineClient';
import {
  runLocalEngineInstrumentRender,
  type LocalEngineInstrumentRenderOptions,
} from './localEngineInstrumentRender';
import type { TabFlowStageResultScope } from './types';

export type AutoPatchStageRunnerClient = Pick<
  LocalEngineClient,
  | 'cancelJob'
  | 'enqueueInstrumentRenderJob'
  | 'getJobs'
  | 'removeQueuedJob'
>;

export type AutoPatchStageRunnerProgress = Readonly<{
  attemptId: string;
  jobId?: string;
  runId: string;
  scope: TabFlowStageResultScope;
  state: 'ENQUEUEING' | LocalEngineGpuJobState;
}>;

export type AutoPatchStageRunnerOptions = Omit<
  LocalEngineInstrumentRenderOptions,
  'onProgress'
> &
  Readonly<{
    onProgress?: (progress: AutoPatchStageRunnerProgress) => void;
  }>;

type AutoPatchStageRunnerIdentity = Readonly<{
  adapterId: AutoPatchStageAdapterPlan['adapterId'];
  attemptId: string;
  fingerprint: string;
  runId: string;
  scope: TabFlowStageResultScope;
}>;

export type AutoPatchStageRunnerResult =
  | (AutoPatchStageRunnerIdentity &
      Readonly<{
        job: LocalEngineGpuJobRecord;
        ok: true;
        status: 'JOB_COMPLETED';
      }>)
  | (AutoPatchStageRunnerIdentity &
      Readonly<{
        cause: string;
        jobId?: string;
        message: string;
        ok: false;
        reason:
          | 'canceled'
          | 'completed-job-mismatch'
          | 'engine-job-failed';
        status: 'FAILED';
      }>);

export async function runAutoPatchStageAdapterPlan(
  client: AutoPatchStageRunnerClient,
  plan: AutoPatchStageAdapterPlan,
  options: AutoPatchStageRunnerOptions = {},
): Promise<AutoPatchStageRunnerResult> {
  const identity = createIdentity(plan);
  const { onProgress, ...renderOptions } = options;
  const result = await runLocalEngineInstrumentRender(
    client,
    plan.request,
    {
      ...renderOptions,
      onProgress: (progress) => {
        onProgress?.(
          Object.freeze({
            attemptId: plan.attemptId,
            ...(progress.jobId ? { jobId: progress.jobId } : {}),
            runId: plan.runId,
            scope: identity.scope,
            state: progress.state,
          }),
        );
      },
    },
  );

  if (!result.ok) {
    return Object.freeze({
      ...identity,
      cause: result.reason === 'canceled'
        ? 'stage-run-canceled'
        : 'instrument-engine-job-failed',
      ...(result.jobId ? { jobId: result.jobId } : {}),
      message: result.message,
      ok: false,
      reason: result.reason === 'canceled'
        ? 'canceled'
        : 'engine-job-failed',
      status: 'FAILED',
    });
  }

  if (!doesCompletedJobMatchPlan(result.job, plan)) {
    return Object.freeze({
      ...identity,
      cause: 'completed-job-plan-mismatch',
      jobId: result.job.jobId,
      message:
        'Completed MIDI TO AUDIO Job does not match the immutable Auto Patch Stage Adapter plan.',
      ok: false,
      reason: 'completed-job-mismatch',
      status: 'FAILED',
    });
  }

  return Object.freeze({
    ...identity,
    job: result.job,
    ok: true,
    status: 'JOB_COMPLETED',
  });
}

function createIdentity(
  plan: AutoPatchStageAdapterPlan,
): AutoPatchStageRunnerIdentity {
  return Object.freeze({
    adapterId: plan.adapterId,
    attemptId: plan.attemptId,
    fingerprint: plan.fingerprint,
    runId: plan.runId,
    scope: Object.freeze({ ...plan.scope }),
  });
}

function doesCompletedJobMatchPlan(
  job: LocalEngineGpuJobRecord,
  plan: AutoPatchStageAdapterPlan,
): boolean {
  return (
    job.state === 'COMPLETED' &&
    job.providerId === plan.request.providerId &&
    job.taskId === plan.request.taskId &&
    job.modelId === plan.request.modelId &&
    job.modelRevision === plan.request.modelRevision &&
    areJsonValuesEqual(job.request, plan.request)
  );
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
