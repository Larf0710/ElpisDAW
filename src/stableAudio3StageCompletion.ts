import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import type { StableAudio3StageAdapterPlan } from './stableAudio3StageAdapter';
import {
  createStableAudio3Registration,
  type StableAudio3RegistrationUpdate,
} from './stableAudio3Registration';
import { registerProjectTabFlowStageResult } from './tabFlowStageResultIndex';
import type {
  CompletedTabFlowStageResultRecord,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
  TabFlowStageResultScope,
} from './types';

export type StableAudio3StageCompletionOptions = Readonly<{
  activate?: boolean;
  label?: string;
  resultId: string;
  targetClipId?: string;
}>;

export type StableAudio3StageCompletedJob = Readonly<{
  adapterId: StableAudio3StageAdapterPlan['adapterId'];
  attemptId: string;
  fingerprint: string;
  job: LocalEngineGpuJobRecord;
  runId: string;
  scope: TabFlowStageResultScope;
  status: 'JOB_COMPLETED';
}>;

export type StableAudio3StageCompletionResult =
  | Readonly<{
      artifact: GeneratedAudioArtifact & { destination: 'stable-audio-3' };
      clipTake: GeneratedAudioClipTake;
      ok: true;
      project: ProjectState;
      registrationStatus: Extract<
        StableAudio3RegistrationUpdate,
        { canRegister: true }
      >['status'];
      result: CompletedTabFlowStageResultRecord;
      status: 'COMPLETED';
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      reason:
        | 'job-identity-mismatch'
        | 'job-not-completed'
        | 'registration-failed'
        | 'stage-identity-mismatch'
        | 'stage-result-failed';
      status: 'FAILED';
    }>;

export function completeStableAudio3StagePlan(
  project: ProjectState,
  plan: StableAudio3StageAdapterPlan,
  completed: StableAudio3StageCompletedJob,
  options: StableAudio3StageCompletionOptions,
): StableAudio3StageCompletionResult {
  if (
    completed.status !== 'JOB_COMPLETED' ||
    completed.adapterId !== plan.adapterId ||
    completed.attemptId !== plan.attemptId ||
    completed.fingerprint !== plan.fingerprint ||
    completed.runId !== plan.runId ||
    !areScopesEqual(completed.scope, plan.scope)
  ) {
    return failure(
      'stage-identity-mismatch',
      'stable-audio-3-stage-attempt-mismatch',
      'Completed Stable Audio 3 Job envelope does not match the immutable Stage attempt.',
    );
  }

  const job = completed.job;

  if (
    job.state !== 'COMPLETED' ||
    !job.finishedAt ||
    Number.isNaN(Date.parse(job.finishedAt))
  ) {
    return failure(
      'job-not-completed',
      'stable-audio-3-job-not-completed',
      'Stable Audio 3 Stage completion requires one completed Job with a valid finish time.',
    );
  }

  if (
    job.providerId !== plan.request.providerId ||
    job.taskId !== plan.request.taskId ||
    job.modelId !== plan.request.modelId ||
    job.modelRevision !== plan.request.modelRevision ||
    !areJsonValuesEqual(job.request, plan.request)
  ) {
    return failure(
      'job-identity-mismatch',
      'stable-audio-3-job-plan-mismatch',
      'Completed Stable Audio 3 Job does not match the immutable Stage plan.',
    );
  }

  const registration = createStableAudio3Registration(project, job, {
    ...(options.activate === undefined
      ? {}
      : { activate: options.activate }),
    ...(options.label === undefined ? {} : { label: options.label }),
    sourceClipId: plan.sourceClipId,
    targetClipId: options.targetClipId ?? plan.scope.targetClipId,
  });

  if (!registration.canRegister) {
    return failure(
      'registration-failed',
      registration.reason,
      registration.message,
    );
  }

  const stageResult: CompletedTabFlowStageResultRecord = Object.freeze({
    fingerprint: plan.fingerprint,
    finishedAt: job.finishedAt,
    outputArtifactIds: Object.freeze([
      registration.artifact.artifactId,
    ]),
    outputClipTakeIds: Object.freeze([
      registration.clipTake.clipTakeId,
    ]),
    resultId: options.resultId,
    scope: Object.freeze({ ...plan.scope }),
    state: 'COMPLETED',
  });
  let completedProject: ProjectState;

  try {
    completedProject = registerProjectTabFlowStageResult(
      registration.project,
      stageResult,
    );
  } catch (error) {
    return failure(
      'stage-result-failed',
      'stable-audio-3-stage-result-conflict',
      error instanceof Error
        ? error.message
        : 'Stable Audio 3 completed Stage Result could not be registered.',
    );
  }

  return Object.freeze({
    artifact: registration.artifact,
    clipTake: registration.clipTake,
    ok: true,
    project: completedProject,
    registrationStatus: registration.status,
    result: stageResult,
    status: 'COMPLETED',
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

function areScopesEqual(
  left: TabFlowStageResultScope,
  right: TabFlowStageResultScope,
): boolean {
  return (
    left.familyId === right.familyId &&
    left.familyRevision === right.familyRevision &&
    left.stageId === right.stageId &&
    left.targetClipId === right.targetClipId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(
  reason: Extract<
    StableAudio3StageCompletionResult,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<StableAudio3StageCompletionResult, { ok: false }> {
  return Object.freeze({
    cause,
    message,
    ok: false,
    reason,
    status: 'FAILED',
  });
}
