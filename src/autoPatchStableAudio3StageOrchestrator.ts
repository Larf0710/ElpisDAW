import {
  beginAutoPatchRuntimeStage,
  completeAutoPatchRuntimeStage,
  failAutoPatchRuntimeStage,
  type AutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeStageDispatch,
} from './autoPatchRuntimeCoordinator';
import {
  createAutoPatchStableAudio3StageDispatch,
} from './autoPatchStableAudio3StageDispatch';
import { CURRENT_STABLE_AUDIO_3_STAGE_RUNTIME_PROFILE } from './stableAudio3StageProfile';
import {
  runStableAudio3AudioToAudioBatch,
  type StableAudio3AudioToAudioBatchResult,
} from './stableAudio3AudioToAudioBatch';
import type {
  StableAudio3StageRunnerClient,
  StableAudio3StageRunnerOptions,
} from './stableAudio3StageRunner';
import { normalizeTabFlowStageResultIndex } from './tabFlowStageResultIndex';
import type { ProjectState } from './types';

export type AutoPatchStableAudio3StageOrchestratorOptions = Readonly<{
  attemptId: string;
  label?: string;
  now?: () => string;
  resultId: string;
  runner?: Omit<
    StableAudio3StageRunnerOptions,
    'maxPollAttempts' | 'pollUntilTerminal'
  >;
  startedAt: string;
}>;

type CompletedStableAudio3Stage = Extract<
  StableAudio3AudioToAudioBatchResult,
  { status: 'STAGE_COMPLETED' }
>;

export type AutoPatchStableAudio3StageOrchestratorResult =
  | Readonly<{
      coordinator: AutoPatchRuntimeCoordinator;
      dispatch: AutoPatchRuntimeStageDispatch;
      ok: true;
      project: ProjectState;
      sourceClipId: string;
      stableAudio3: CompletedStableAudio3Stage;
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
        | 'dispatch-rejected'
        | 'failure-transition-rejected'
        | 'project-stale'
        | 'stable-audio-3-failed';
      status: 'STAGE_FAILED';
    }>
  | Readonly<{
      cause: string;
      coordinator: AutoPatchRuntimeCoordinator;
      message: string;
      ok: false;
      project: ProjectState;
      reason: 'stable-audio-3-canceled';
      status: 'STAGE_CANCELED';
    }>;

export async function orchestrateAutoPatchStableAudio3Stage(
  client: StableAudio3StageRunnerClient,
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  options: AutoPatchStableAudio3StageOrchestratorOptions,
): Promise<AutoPatchStableAudio3StageOrchestratorResult> {
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
        ? 'Auto Patch Stable Audio 3 Stage began without an immutable dispatch.'
        : beginning.message,
    );
  }

  const runningCoordinator = beginning.coordinator;
  const dispatch = beginning.dispatch;

  if (
    !areJsonValuesEqual(
      normalizeTabFlowStageResultIndex(project.tabFlowStageResults),
      runningCoordinator.stageResults,
    )
  ) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'project-stale',
      'project-stage-results-changed',
      'Project Stage Results changed after the Auto Patch runtime snapshot was created.',
    );
  }

  const productionDispatch = createAutoPatchStableAudio3StageDispatch(
    dispatch,
    project,
  );

  if (!productionDispatch.ok) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'dispatch-rejected',
      productionDispatch.cause,
      productionDispatch.message,
    );
  }

  let stableAudio3: StableAudio3AudioToAudioBatchResult;

  try {
    stableAudio3 = await runStableAudio3AudioToAudioBatch(
      client,
      project,
      productionDispatch.dispatch,
      productionDispatch.continuation,
      CURRENT_STABLE_AUDIO_3_STAGE_RUNTIME_PROFILE,
      {
        ...(options.label ? { label: options.label } : {}),
        resultId: options.resultId,
        runner: {
          ...(options.runner ?? {}),
        },
      },
    );
  } catch (error) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'stable-audio-3-failed',
      'stable-audio-3-production-orchestration-exception',
      errorMessage(
        error,
        'Stable Audio 3 production orchestration threw an exception.',
      ),
    );
  }

  if (stableAudio3.status === 'STAGE_CANCELED') {
    return recordRunningCancellation(
      stableAudio3.project,
      runningCoordinator,
      options,
      stableAudio3.cause,
      stableAudio3.message,
    );
  }

  if (!stableAudio3.ok) {
    return recordRunningFailure(
      stableAudio3.project,
      runningCoordinator,
      options,
      'stable-audio-3-failed',
      stableAudio3.cause,
      stableAudio3.message,
    );
  }

  const runtimeTarget = createCompletedRuntimeTarget(
    runningCoordinator,
    dispatch.scope.targetClipId,
    stableAudio3.artifacts.map((artifact) => artifact.artifactId),
    stableAudio3.clipTakes.map((clipTake) => clipTake.clipTakeId),
  );

  if (!runtimeTarget) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'completion-failed',
      'runtime-target-missing',
      'Running Stable Audio 3 Stage does not have one exact runtime target snapshot.',
    );
  }

  const coordinatorCompletion = completeAutoPatchRuntimeStage(
    runningCoordinator,
    {
      attemptId: options.attemptId,
      result: stableAudio3.result,
      runtimeTarget,
    },
  );

  if (!coordinatorCompletion.ok) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'completion-failed',
      coordinatorCompletion.cause,
      coordinatorCompletion.message,
    );
  }

  if (
    !areJsonValuesEqual(
      normalizeTabFlowStageResultIndex(
        stableAudio3.project.tabFlowStageResults,
      ),
      coordinatorCompletion.coordinator.stageResults,
    )
  ) {
    return recordRunningFailure(
      project,
      runningCoordinator,
      options,
      'project-stale',
      'project-coordinator-result-mismatch',
      'Project and Runtime Coordinator Stage Result indexes no longer match.',
    );
  }

  return Object.freeze({
    coordinator: coordinatorCompletion.coordinator,
    dispatch,
    ok: true as const,
    project: stableAudio3.project,
    sourceClipId: productionDispatch.sourceClipId,
    stableAudio3,
    status: 'STAGE_COMPLETED' as const,
  });
}

function createCompletedRuntimeTarget(
  coordinator: AutoPatchRuntimeCoordinator,
  targetClipId: string,
  artifactIds: readonly string[],
  clipTakeIds: readonly string[],
) {
  const matches = coordinator.runtimeTargets.filter(
    (target) => target.targetClipId === targetClipId,
  );

  if (matches.length !== 1) {
    return undefined;
  }

  const current = matches[0];
  if (
    artifactIds.length === 0 ||
    clipTakeIds.length !== artifactIds.length ||
    new Set(artifactIds).size !== artifactIds.length ||
    new Set(clipTakeIds).size !== clipTakeIds.length ||
    artifactIds.some((artifactId) =>
      current.artifactIdentities.some(
        (identity) =>
          identity.artifactId === artifactId && identity.mediaType !== 'audio',
      ),
    )
  ) {
    return undefined;
  }

  const existingArtifactIds = new Set(
    current.artifactIdentities.map((identity) => identity.artifactId),
  );

  return {
    artifactIdentities: [
      ...current.artifactIdentities,
      ...artifactIds
        .filter((artifactId) => !existingArtifactIds.has(artifactId))
        .map((artifactId) => ({ artifactId, mediaType: 'audio' as const })),
    ],
    availability: {
      artifactIds: appendUniqueMany(
        current.availability.artifactIds,
        artifactIds,
      ),
      clipTakeIds: appendUniqueMany(
        current.availability.clipTakeIds,
        clipTakeIds,
      ),
    },
    targetClipId,
  };
}

function recordRunningFailure(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  options: AutoPatchStableAudio3StageOrchestratorOptions,
  reason: Extract<
    AutoPatchStableAudio3StageOrchestratorResult,
    { status: 'STAGE_FAILED' }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchStableAudio3StageOrchestratorResult,
  { status: 'STAGE_FAILED' }
> {
  const failed = transitionRunningFailure(
    coordinator,
    options,
    cause,
    message,
  );

  return failed.ok
    ? failure(project, failed.coordinator, reason, cause, message)
    : failure(
        project,
        coordinator,
        'failure-transition-rejected',
        failed.cause,
        failed.message,
      );
}

function recordRunningCancellation(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  options: AutoPatchStableAudio3StageOrchestratorOptions,
  cause: string,
  message: string,
): AutoPatchStableAudio3StageOrchestratorResult {
  const failed = transitionRunningFailure(
    coordinator,
    options,
    cause,
    message,
  );

  if (!failed.ok) {
    return failure(
      project,
      coordinator,
      'failure-transition-rejected',
      failed.cause,
      failed.message,
    );
  }

  return Object.freeze({
    cause,
    coordinator: failed.coordinator,
    message,
    ok: false as const,
    project,
    reason: 'stable-audio-3-canceled' as const,
    status: 'STAGE_CANCELED' as const,
  });
}

function transitionRunningFailure(
  coordinator: AutoPatchRuntimeCoordinator,
  options: AutoPatchStableAudio3StageOrchestratorOptions,
  cause: string,
  message: string,
):
  | Readonly<{ coordinator: AutoPatchRuntimeCoordinator; ok: true }>
  | Readonly<{ cause: string; message: string; ok: false }> {
  let failedAt: string;

  try {
    failedAt = (options.now ?? defaultNow)();
  } catch (error) {
    return Object.freeze({
      cause: 'runtime-failure-clock-failed',
      message: errorMessage(
        error,
        `Auto Patch could not timestamp Stable Audio 3 Stage failure ${cause}.`,
      ),
      ok: false as const,
    });
  }

  const failed = failAutoPatchRuntimeStage(coordinator, {
    attemptId: options.attemptId,
    cause,
    failedAt,
    message,
  });

  return failed.ok
    ? Object.freeze({ coordinator: failed.coordinator, ok: true as const })
    : Object.freeze({
        cause: failed.cause,
        message: `Auto Patch could not record Stable Audio 3 Stage failure ${cause}: ${failed.message}`,
        ok: false as const,
      });
}

function failure(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  reason: Extract<
    AutoPatchStableAudio3StageOrchestratorResult,
    { status: 'STAGE_FAILED' }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchStableAudio3StageOrchestratorResult,
  { status: 'STAGE_FAILED' }
> {
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

function appendUniqueMany(
  values: readonly string[],
  additions: readonly string[],
): string[] {
  return [...new Set([...values, ...additions])];
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

function defaultNow(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
