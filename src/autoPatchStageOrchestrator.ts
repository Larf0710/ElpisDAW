import {
  completeAutoPatchInstrumentStage,
  type AutoPatchInstrumentStageCompletionResult,
} from './autoPatchInstrumentStageCompletion';
import {
  beginAutoPatchRuntimeStage,
  failAutoPatchRuntimeStage,
  type AutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeStageDispatch,
} from './autoPatchRuntimeCoordinator';
import {
  createAutoPatchStageAdapterPlan,
  type AutoPatchStageAdapterPlan,
} from './autoPatchStageAdapter';
import {
  runAutoPatchStageAdapterPlan,
  type AutoPatchStageRunnerClient,
  type AutoPatchStageRunnerOptions,
  type AutoPatchStageRunnerResult,
} from './autoPatchStageRunner';
import type { LocalEngineSoundFontResource } from './localEngineClient';
import type { ProjectState } from './types';

export type AutoPatchStageOrchestratorOptions = Readonly<{
  attemptId: string;
  label?: string;
  now?: () => string;
  outputClipId: string;
  resultId: string;
  runner?: AutoPatchStageRunnerOptions;
  startedAt: string;
}>;

export type AutoPatchStageOrchestratorResult =
  | Readonly<{
      completion: Extract<
        AutoPatchInstrumentStageCompletionResult,
        { ok: true }
      >;
      coordinator: AutoPatchRuntimeCoordinator;
      dispatch: AutoPatchRuntimeStageDispatch;
      ok: true;
      plan: AutoPatchStageAdapterPlan;
      project: ProjectState;
      runner: Extract<AutoPatchStageRunnerResult, { ok: true }>;
      status: 'STAGE_COMPLETED';
    }>
  | Readonly<{
      cause: string;
      coordinator: AutoPatchRuntimeCoordinator;
      message: string;
      ok: false;
      project: ProjectState;
      reason:
        | 'adapter-rejected'
        | 'begin-rejected'
        | 'completion-failed'
        | 'failure-transition-rejected'
        | 'runner-failed';
      status: 'STAGE_FAILED';
    }>;

export async function orchestrateAutoPatchRuntimeStage(
  client: AutoPatchStageRunnerClient,
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  verifiedSoundFontResources: readonly LocalEngineSoundFontResource[],
  options: AutoPatchStageOrchestratorOptions,
): Promise<AutoPatchStageOrchestratorResult> {
  const beginning = beginAutoPatchRuntimeStage(coordinator, {
    attemptId: options.attemptId,
    startedAt: options.startedAt,
  });

  if (!beginning.ok || !beginning.dispatch) {
    return failure(
      project,
      coordinator,
      'begin-rejected',
      beginning.ok ? 'runtime-dispatch-missing' : beginning.cause,
      beginning.ok
        ? 'Auto Patch Stage began without an immutable dispatch.'
        : beginning.message,
    );
  }

  const runningCoordinator = beginning.coordinator;
  const dispatch = beginning.dispatch;
  let planResolution: ReturnType<typeof createAutoPatchStageAdapterPlan>;

  try {
    planResolution = createAutoPatchStageAdapterPlan(
      dispatch,
      project,
      verifiedSoundFontResources,
    );
  } catch (error) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'adapter-rejected',
      'stage-adapter-exception',
      errorMessage(error, 'Auto Patch Stage Adapter threw an exception.'),
    );
  }

  if (!planResolution.canPlan) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'adapter-rejected',
      planResolution.cause,
      planResolution.message,
    );
  }

  const plan = planResolution.plan;
  let runner: AutoPatchStageRunnerResult;

  try {
    runner = await runAutoPatchStageAdapterPlan(
      client,
      plan,
      options.runner,
    );
  } catch (error) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'runner-failed',
      'stage-runner-exception',
      errorMessage(error, 'Auto Patch Stage Runner threw an exception.'),
    );
  }

  if (!runner.ok) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'runner-failed',
      runner.cause,
      runner.message,
    );
  }

  let completion: AutoPatchInstrumentStageCompletionResult;

  try {
    completion = completeAutoPatchInstrumentStage(
      project,
      runningCoordinator,
      runner,
      {
        ...(options.label ? { label: options.label } : {}),
        outputClipId: options.outputClipId,
        resultId: options.resultId,
      },
    );
  } catch (error) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'completion-failed',
      'stage-completion-exception',
      errorMessage(error, 'Auto Patch Stage completion threw an exception.'),
    );
  }

  if (!completion.ok) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'completion-failed',
      completion.cause,
      completion.message,
    );
  }

  return Object.freeze({
    completion,
    coordinator: completion.coordinator,
    dispatch,
    ok: true,
    plan,
    project: completion.project,
    runner,
    status: 'STAGE_COMPLETED',
  });
}

function recordRunningFailure(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  options: AutoPatchStageOrchestratorOptions,
  reason: Extract<
    AutoPatchStageOrchestratorResult,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<AutoPatchStageOrchestratorResult, { ok: false }> {
  let failedAt: string;

  try {
    failedAt = (options.now ?? defaultNow)();
  } catch (error) {
    return failure(
      project,
      coordinator,
      'failure-transition-rejected',
      'runtime-failure-clock-failed',
      errorMessage(
        error,
        `Auto Patch could not timestamp Stage failure ${cause}.`,
      ),
    );
  }

  const failed = failAutoPatchRuntimeStage(coordinator, {
    attemptId: options.attemptId,
    cause,
    failedAt,
    message,
  });

  if (!failed.ok) {
    return failure(
      project,
      coordinator,
      'failure-transition-rejected',
      failed.cause,
      `Auto Patch could not record Stage failure ${cause}: ${failed.message}`,
    );
  }

  return failure(
    project,
    failed.coordinator,
    reason,
    cause,
    message,
  );
}

function failure(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  reason: Extract<
    AutoPatchStageOrchestratorResult,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<AutoPatchStageOrchestratorResult, { ok: false }> {
  return Object.freeze({
    cause,
    coordinator,
    message,
    ok: false,
    project,
    reason,
    status: 'STAGE_FAILED',
  });
}

function defaultNow(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
