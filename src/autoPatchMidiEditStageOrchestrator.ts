import {
  completeAutoPatchMidiEditStage,
  type AutoPatchMidiEditStageCompletionResult,
} from './autoPatchMidiEditStageCompletion';
import {
  completeAutoPatchMidiEditProcessing,
  processAutoPatchMidiEditStageContent,
  type AutoPatchMidiEditContentProcessingResolution,
  type AutoPatchMidiEditProcessorResolution,
} from './autoPatchMidiEditProcessor';
import {
  beginAutoPatchRuntimeStage,
  failAutoPatchRuntimeStage,
  type AutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeStageDispatch,
} from './autoPatchRuntimeCoordinator';
import {
  createAutoPatchMidiEditStagePlan,
  type AutoPatchMidiEditStagePlan,
} from './autoPatchMidiEditStage';
import type { ProjectState } from './types';

export type AutoPatchMidiEditStageOrchestratorOptions = Readonly<{
  artifactId: string;
  attemptId: string;
  finishedAt?: string;
  label?: string;
  now?: () => string;
  resultId: string;
  sourceEditId: string;
  startedAt: string;
}>;

export type AutoPatchMidiEditStageOrchestratorResult =
  | Readonly<{
      completion: Extract<
        AutoPatchMidiEditStageCompletionResult,
        { ok: true }
      >;
      coordinator: AutoPatchRuntimeCoordinator;
      dispatch: AutoPatchRuntimeStageDispatch;
      ok: true;
      plan: AutoPatchMidiEditStagePlan;
      processor: Extract<
        AutoPatchMidiEditProcessorResolution,
        { canProcess: true }
      >;
      project: ProjectState;
      status: 'STAGE_COMPLETED';
    }>
  | Readonly<{
      cause: string;
      coordinator: AutoPatchRuntimeCoordinator;
      message: string;
      ok: false;
      project: ProjectState;
      reason:
        | 'begin-rejected'
        | 'completion-failed'
        | 'failure-transition-rejected'
        | 'plan-rejected'
        | 'processor-rejected';
      status: 'STAGE_FAILED';
    }>;

export function orchestrateAutoPatchMidiEditStage(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  options: AutoPatchMidiEditStageOrchestratorOptions,
): AutoPatchMidiEditStageOrchestratorResult {
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
        ? 'Auto Patch MIDI Edit Stage began without an immutable dispatch.'
        : beginning.message,
    );
  }

  const runningCoordinator = beginning.coordinator;
  const dispatch = beginning.dispatch;
  let planResolution: ReturnType<
    typeof createAutoPatchMidiEditStagePlan
  >;

  try {
    planResolution = createAutoPatchMidiEditStagePlan(
      dispatch,
      project,
    );
  } catch (error) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'plan-rejected',
      'midi-edit-stage-plan-exception',
      errorMessage(
        error,
        'Auto Patch MIDI Edit Stage planning threw an exception.',
      ),
    );
  }

  if (!planResolution.canPlan) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'plan-rejected',
      planResolution.cause,
      planResolution.message,
    );
  }

  const plan = planResolution.plan;
  let content: AutoPatchMidiEditContentProcessingResolution;

  try {
    content = processAutoPatchMidiEditStageContent(plan);
  } catch (error) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'processor-rejected',
      'midi-edit-processor-exception',
      errorMessage(
        error,
        'Auto Patch MIDI Edit processor threw an exception.',
      ),
    );
  }

  if (!content.canProcess) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'processor-rejected',
      content.cause,
      content.message,
    );
  }

  let finishedAt: string;

  try {
    finishedAt = options.finishedAt ?? (options.now ?? defaultNow)();
  } catch (error) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'processor-rejected',
      'midi-edit-completion-clock-failed',
      errorMessage(
        error,
        'Auto Patch MIDI Edit completion clock failed.',
      ),
    );
  }

  let processor: AutoPatchMidiEditProcessorResolution;

  try {
    processor = completeAutoPatchMidiEditProcessing(
      plan,
      content,
      finishedAt,
    );
  } catch (error) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'processor-rejected',
      'midi-edit-processor-exception',
      errorMessage(
        error,
        'Auto Patch MIDI Edit processor completion threw an exception.',
      ),
    );
  }

  if (!processor.canProcess) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'processor-rejected',
      processor.cause,
      processor.message,
    );
  }

  let completion: AutoPatchMidiEditStageCompletionResult;

  try {
    completion = completeAutoPatchMidiEditStage(
      project,
      runningCoordinator,
      plan,
      processor.outcome,
      {
        artifactId: options.artifactId,
        ...(options.label ? { label: options.label } : {}),
        resultId: options.resultId,
        sourceEditId: options.sourceEditId,
      },
    );
  } catch (error) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'completion-failed',
      'midi-edit-stage-completion-exception',
      errorMessage(
        error,
        'Auto Patch MIDI Edit Stage completion threw an exception.',
      ),
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
    processor,
    project: completion.project,
    status: 'STAGE_COMPLETED' as const,
  });
}

function recordRunningFailure(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  options: AutoPatchMidiEditStageOrchestratorOptions,
  reason: Extract<
    AutoPatchMidiEditStageOrchestratorResult,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchMidiEditStageOrchestratorResult,
  { ok: false }
> {
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
        `Auto Patch could not timestamp MIDI Edit Stage failure ${cause}.`,
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
      `Auto Patch could not record MIDI Edit Stage failure ${cause}: ${failed.message}`,
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
    AutoPatchMidiEditStageOrchestratorResult,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchMidiEditStageOrchestratorResult,
  { ok: false }
> {
  return Object.freeze({
    cause,
    coordinator,
    message,
    ok: false,
    project,
    reason,
    status: 'STAGE_FAILED' as const,
  });
}

function defaultNow(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
