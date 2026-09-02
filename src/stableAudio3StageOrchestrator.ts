import {
  createStableAudio3StageAdapterPlan,
  type StableAudio3StageAdapterPlan,
  type StableAudio3StageAdapterPlanResolution,
  type StableAudio3StageDispatch,
  type StableAudio3StageRuntimeProfile,
} from './stableAudio3StageAdapter';
import {
  executeStableAudio3StagePlan,
  type StableAudio3StageExecutionOptions,
  type StableAudio3StageExecutionResult,
} from './stableAudio3StageExecution';
import type { StableAudio3StageRunnerClient } from './stableAudio3StageRunner';
import type { ProjectState } from './types';

type PlanningFailure = Extract<
  StableAudio3StageAdapterPlanResolution,
  { canPlan: false }
>;
type CompletedExecution = Extract<
  StableAudio3StageExecutionResult,
  { status: 'STAGE_COMPLETED' }
>;
type PendingExecution = Extract<
  StableAudio3StageExecutionResult,
  { status: 'STAGE_PENDING' }
>;
type CanceledExecution = Extract<
  StableAudio3StageExecutionResult,
  { status: 'STAGE_CANCELED' }
>;
type FailedExecution = Extract<
  StableAudio3StageExecutionResult,
  { status: 'STAGE_FAILED' }
>;

export type StableAudio3StageOrchestratorOptions =
  StableAudio3StageExecutionOptions;

export type StableAudio3StageOrchestratorResult =
  | Readonly<{
      execution: CompletedExecution;
      ok: true;
      plan: StableAudio3StageAdapterPlan;
      project: ProjectState;
      status: 'STAGE_COMPLETED';
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      planning: PlanningFailure;
      project: ProjectState;
      reason: PlanningFailure['reason'];
      status: 'STAGE_BLOCKED';
    }>
  | Readonly<{
      execution: PendingExecution;
      ok: false;
      plan: StableAudio3StageAdapterPlan;
      project: ProjectState;
      reason: PendingExecution['reason'];
      status: 'STAGE_PENDING';
    }>
  | Readonly<{
      cause: string;
      execution: CanceledExecution;
      message: string;
      ok: false;
      plan: StableAudio3StageAdapterPlan;
      project: ProjectState;
      reason: CanceledExecution['reason'];
      status: 'STAGE_CANCELED';
    }>
  | Readonly<{
      cause: string;
      execution?: FailedExecution;
      message: string;
      ok: false;
      plan?: StableAudio3StageAdapterPlan;
      project: ProjectState;
      reason: 'planning-exception' | FailedExecution['reason'];
      status: 'STAGE_FAILED';
    }>;

export async function orchestrateStableAudio3Stage(
  client: StableAudio3StageRunnerClient,
  project: ProjectState,
  dispatch: StableAudio3StageDispatch,
  profile: StableAudio3StageRuntimeProfile,
  options: StableAudio3StageOrchestratorOptions,
): Promise<StableAudio3StageOrchestratorResult> {
  let planning: StableAudio3StageAdapterPlanResolution;

  try {
    planning = createStableAudio3StageAdapterPlan(
      dispatch,
      project,
      profile,
    );
  } catch (error) {
    return failure(
      project,
      'planning-exception',
      'stable-audio-3-planning-exception',
      errorMessage(
        error,
        'Stable Audio 3 Stage planning threw an exception.',
      ),
    );
  }

  if (!planning.canPlan) {
    return Object.freeze({
      cause: planning.cause,
      message: planning.message,
      ok: false,
      planning,
      project,
      reason: planning.reason,
      status: 'STAGE_BLOCKED' as const,
    });
  }

  const plan = planning.plan;
  let execution: StableAudio3StageExecutionResult;

  try {
    execution = await executeStableAudio3StagePlan(
      client,
      project,
      plan,
      options,
    );
  } catch (error) {
    return failure(
      project,
      'execution-exception',
      'stable-audio-3-execution-exception',
      errorMessage(
        error,
        'Stable Audio 3 Stage execution threw an exception.',
      ),
      { plan },
    );
  }

  if (execution.status === 'STAGE_PENDING') {
    return Object.freeze({
      execution,
      ok: false,
      plan,
      project,
      reason: execution.reason,
      status: 'STAGE_PENDING' as const,
    });
  }

  if (execution.status === 'STAGE_CANCELED') {
    return Object.freeze({
      cause: execution.cause,
      execution,
      message: execution.message,
      ok: false,
      plan,
      project,
      reason: execution.reason,
      status: 'STAGE_CANCELED' as const,
    });
  }

  if (execution.status === 'STAGE_FAILED') {
    return failure(
      project,
      execution.reason,
      execution.cause,
      execution.message,
      { execution, plan },
    );
  }

  return Object.freeze({
    execution,
    ok: true,
    plan,
    project: execution.project,
    status: 'STAGE_COMPLETED' as const,
  });
}

function failure(
  project: ProjectState,
  reason: Extract<
    StableAudio3StageOrchestratorResult,
    { status: 'STAGE_FAILED' }
  >['reason'],
  cause: string,
  message: string,
  details: Readonly<{
    execution?: FailedExecution;
    plan?: StableAudio3StageAdapterPlan;
  }> = {},
): Extract<
  StableAudio3StageOrchestratorResult,
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
