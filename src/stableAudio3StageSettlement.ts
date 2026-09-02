import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import type { StableAudio3StageAdapterPlan } from './stableAudio3StageAdapter';
import {
  completeStableAudio3StagePlan,
  type StableAudio3StageCompletionOptions,
  type StableAudio3StageCompletionResult,
} from './stableAudio3StageCompletion';
import {
  resolveStableAudio3StageJobOutcome,
  type StableAudio3StageJobOutcome,
} from './stableAudio3StageOutcome';
import type { ProjectState } from './types';

type CompletedOutcome = Extract<
  StableAudio3StageJobOutcome,
  { status: 'JOB_COMPLETED' }
>;
type PendingOutcome = Extract<
  StableAudio3StageJobOutcome,
  { status: 'PENDING' }
>;
type CanceledOutcome = Extract<
  StableAudio3StageJobOutcome,
  { status: 'CANCELED' }
>;
type FailedOutcome = Extract<
  StableAudio3StageJobOutcome,
  { status: 'FAILED' }
>;
type CompletedRegistration = Extract<
  StableAudio3StageCompletionResult,
  { ok: true }
>;
type FailedRegistration = Extract<
  StableAudio3StageCompletionResult,
  { ok: false }
>;

export type StableAudio3StageSettlementResult =
  | Readonly<{
      completion: CompletedRegistration;
      ok: true;
      outcome: CompletedOutcome;
      project: ProjectState;
      status: 'STAGE_COMPLETED';
    }>
  | Readonly<{
      ok: false;
      outcome: PendingOutcome;
      project: ProjectState;
      reason: 'job-pending';
      status: 'STAGE_PENDING';
    }>
  | Readonly<{
      ok: false;
      outcome: CanceledOutcome;
      project: ProjectState;
      reason: 'job-canceled';
      status: 'STAGE_CANCELED';
    }>
  | Readonly<{
      cause: string;
      completion?: FailedRegistration;
      message: string;
      ok: false;
      outcome?: StableAudio3StageJobOutcome;
      project: ProjectState;
      reason:
        | 'completion-failed'
        | 'job-failed'
        | 'settlement-exception';
      status: 'STAGE_FAILED';
    }>;

export function settleStableAudio3StageJob(
  project: ProjectState,
  plan: StableAudio3StageAdapterPlan,
  job: LocalEngineGpuJobRecord,
  options: StableAudio3StageCompletionOptions,
): StableAudio3StageSettlementResult {
  let outcome: StableAudio3StageJobOutcome;

  try {
    outcome = resolveStableAudio3StageJobOutcome(plan, job);
  } catch (error) {
    return failure(
      project,
      'settlement-exception',
      'stable-audio-3-outcome-exception',
      errorMessage(
        error,
        'Stable Audio 3 Stage Job outcome resolution threw an exception.',
      ),
    );
  }

  if (!outcome.ok) {
    if (outcome.status === 'PENDING') {
      return Object.freeze({
        ok: false,
        outcome,
        project,
        reason: 'job-pending' as const,
        status: 'STAGE_PENDING' as const,
      });
    }

    if (outcome.status === 'CANCELED') {
      return Object.freeze({
        ok: false,
        outcome,
        project,
        reason: 'job-canceled' as const,
        status: 'STAGE_CANCELED' as const,
      });
    }

    return failure(
      project,
      'job-failed',
      outcome.cause,
      outcome.message,
      { outcome },
    );
  }

  let completion: StableAudio3StageCompletionResult;

  try {
    completion = completeStableAudio3StagePlan(
      project,
      plan,
      outcome.completed,
      options,
    );
  } catch (error) {
    return failure(
      project,
      'settlement-exception',
      'stable-audio-3-completion-exception',
      errorMessage(
        error,
        'Stable Audio 3 Stage completion threw an exception.',
      ),
      { outcome },
    );
  }

  if (!completion.ok) {
    return failure(
      project,
      'completion-failed',
      completion.cause,
      completion.message,
      { completion, outcome },
    );
  }

  return Object.freeze({
    completion,
    ok: true,
    outcome,
    project: completion.project,
    status: 'STAGE_COMPLETED' as const,
  });
}

function failure(
  project: ProjectState,
  reason: Extract<
    StableAudio3StageSettlementResult,
    { status: 'STAGE_FAILED' }
  >['reason'],
  cause: string,
  message: string,
  details: Readonly<{
    completion?: FailedRegistration;
    outcome?: StableAudio3StageJobOutcome;
  }> = {},
): Extract<
  StableAudio3StageSettlementResult,
  { status: 'STAGE_FAILED' }
> {
  return Object.freeze({
    cause,
    ...details,
    message,
    ok: false,
    project,
    reason,
    status: 'STAGE_FAILED',
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
