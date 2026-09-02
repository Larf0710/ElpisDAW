import type { StableAudio3StageAdapterPlan } from './stableAudio3StageAdapter';
import type {
  StableAudio3StageCompletionOptions,
} from './stableAudio3StageCompletion';
import {
  runStableAudio3StagePlan,
  type StableAudio3StageRunnerClient,
  type StableAudio3StageRunnerOptions,
  type StableAudio3StageRunnerResult,
} from './stableAudio3StageRunner';
import {
  settleStableAudio3StageJob,
  type StableAudio3StageSettlementResult,
} from './stableAudio3StageSettlement';
import type { ProjectState } from './types';

type CompletedRunner = Extract<
  StableAudio3StageRunnerResult,
  { status: 'JOB_COMPLETED' }
>;
type PendingRunner = Extract<
  StableAudio3StageRunnerResult,
  { status: 'JOB_PENDING' }
>;
type CanceledRunner = Extract<
  StableAudio3StageRunnerResult,
  { status: 'JOB_CANCELED' | 'RUN_CANCELED' }
>;
type FailedRunner = Extract<
  StableAudio3StageRunnerResult,
  { status: 'JOB_FAILED' | 'RUNNER_FAILED' }
>;
type CompletedSettlement = Extract<
  StableAudio3StageSettlementResult,
  { status: 'STAGE_COMPLETED' }
>;
type UnsuccessfulSettlement = Exclude<
  StableAudio3StageSettlementResult,
  { status: 'STAGE_COMPLETED' }
>;

export type StableAudio3StageExecutionOptions = Readonly<{
  completion: StableAudio3StageCompletionOptions;
  runner?: StableAudio3StageRunnerOptions;
}>;

export type StableAudio3StageExecutionResult =
  | Readonly<{
      ok: true;
      project: ProjectState;
      runner: CompletedRunner;
      settlement: CompletedSettlement;
      status: 'STAGE_COMPLETED';
    }>
  | Readonly<{
      ok: false;
      project: ProjectState;
      reason: PendingRunner['reason'];
      runner: PendingRunner;
      status: 'STAGE_PENDING';
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      project: ProjectState;
      reason: CanceledRunner['reason'];
      runner: CanceledRunner;
      status: 'STAGE_CANCELED';
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      project: ProjectState;
      reason:
        | 'execution-exception'
        | 'runner-failed'
        | 'settlement-failed';
      runner?: FailedRunner | CompletedRunner;
      settlement?: UnsuccessfulSettlement;
      status: 'STAGE_FAILED';
    }>;

export async function executeStableAudio3StagePlan(
  client: StableAudio3StageRunnerClient,
  project: ProjectState,
  plan: StableAudio3StageAdapterPlan,
  options: StableAudio3StageExecutionOptions,
): Promise<StableAudio3StageExecutionResult> {
  let runner: StableAudio3StageRunnerResult;

  try {
    runner = await runStableAudio3StagePlan(
      client,
      plan,
      options.runner,
    );
  } catch (error) {
    return executionFailure(
      project,
      'execution-exception',
      'stable-audio-3-runner-exception',
      errorMessage(
        error,
        'Stable Audio 3 Stage Runner threw an exception.',
      ),
    );
  }

  if (runner.status === 'JOB_PENDING') {
    return Object.freeze({
      ok: false,
      project,
      reason: runner.reason,
      runner,
      status: 'STAGE_PENDING' as const,
    });
  }

  if (runner.status === 'RUN_CANCELED') {
    return Object.freeze({
      cause: runner.cause,
      message: runner.message,
      ok: false,
      project,
      reason: runner.reason,
      runner,
      status: 'STAGE_CANCELED' as const,
    });
  }

  if (runner.status === 'JOB_CANCELED') {
    return Object.freeze({
      cause: runner.outcome.cause,
      message: runner.outcome.message,
      ok: false,
      project,
      reason: runner.reason,
      runner,
      status: 'STAGE_CANCELED' as const,
    });
  }

  if (
    runner.status === 'RUNNER_FAILED' ||
    runner.status === 'JOB_FAILED'
  ) {
    return executionFailure(
      project,
      'runner-failed',
      runner.cause,
      runner.message,
      { runner },
    );
  }

  let settlement: StableAudio3StageSettlementResult;

  try {
    settlement = settleStableAudio3StageJob(
      project,
      plan,
      runner.outcome.completed.job,
      options.completion,
    );
  } catch (error) {
    return executionFailure(
      project,
      'execution-exception',
      'stable-audio-3-settlement-exception',
      errorMessage(
        error,
        'Stable Audio 3 Stage settlement threw an exception.',
      ),
      { runner },
    );
  }

  if (!settlement.ok) {
    if (settlement.status === 'STAGE_FAILED') {
      return executionFailure(
        project,
        'settlement-failed',
        settlement.cause,
        settlement.message,
        { runner, settlement },
      );
    }

    return executionFailure(
      project,
      'settlement-failed',
      'stable-audio-3-settlement-state-inconsistent',
      `Completed Stable Audio 3 Runner produced ${settlement.status} during settlement.`,
      { runner, settlement },
    );
  }

  return Object.freeze({
    ok: true,
    project: settlement.project,
    runner,
    settlement,
    status: 'STAGE_COMPLETED' as const,
  });
}

function executionFailure(
  project: ProjectState,
  reason: Extract<
    StableAudio3StageExecutionResult,
    { status: 'STAGE_FAILED' }
  >['reason'],
  cause: string,
  message: string,
  details: Readonly<{
    runner?: FailedRunner | CompletedRunner;
    settlement?: UnsuccessfulSettlement;
  }> = {},
): Extract<
  StableAudio3StageExecutionResult,
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
