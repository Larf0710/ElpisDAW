import {
  createAutoPatchExecutionFrontier,
  type AutoPatchRuntimeTargetSnapshot,
} from './autoPatchExecutionFrontier';
import { createAutoPatchRuntimeStageDispatch } from './autoPatchRuntimeDispatch';
import type {
  AutoPatchExecuteFrontierStage,
  AutoPatchRuntimeAttemptRecord,
  AutoPatchRuntimeCoordinator,
  AutoPatchRuntimeCoordinatorBase,
  AutoPatchRuntimeCoordinatorResolution,
  BeginAutoPatchRuntimeStageRequest,
  CompleteAutoPatchRuntimeStageRequest,
  CreateAutoPatchRuntimeCoordinatorRequest,
  FailAutoPatchRuntimeStageRequest,
} from './autoPatchRuntimeCoordinatorTypes';
import {
  normalizeTabFlowStageResultIndex,
  registerTabFlowStageResult,
} from './tabFlowStageResultIndex';
import type {
  CompletedTabFlowStageResultRecord,
  TabFlowStageResultScope,
} from './types';

export type {
  AutoPatchReadyRuntimeCoordinator,
  AutoPatchRuntimeAttemptRecord,
  AutoPatchRuntimeCoordinator,
  AutoPatchRuntimeCoordinatorResolution,
  AutoPatchRuntimeFailure,
  AutoPatchRuntimeStageDispatch,
  BeginAutoPatchRuntimeStageRequest,
  CompleteAutoPatchRuntimeStageRequest,
  CreateAutoPatchRuntimeCoordinatorRequest,
  FailAutoPatchRuntimeStageRequest,
} from './autoPatchRuntimeCoordinatorTypes';

export function createAutoPatchRuntimeCoordinator(
  request: CreateAutoPatchRuntimeCoordinatorRequest,
): AutoPatchRuntimeCoordinatorResolution {
  if (
    !isNonEmptyTrimmedString(request.runId) ||
    !isValidTimestamp(request.createdAt)
  ) {
    return failure(
      'invalid-request',
      'runtime-run-invalid',
      'Auto Patch runtime run ID and creation time are invalid.',
    );
  }

  const runtimeTargets = cloneRuntimeTargets(request.runtimeTargets);
  const stageResults = normalizeTabFlowStageResultIndex(
    request.stageResults,
  );
  const frontierResolution = createAutoPatchExecutionFrontier({
    runtimeTargets,
    stageResults,
    validatedPreflight: request.validatedPreflight,
  });

  if (!frontierResolution.canPlan) {
    return failure(
      'frontier-rejected',
      frontierResolution.cause,
      frontierResolution.message,
    );
  }

  return materializeCoordinator({
    attempts: [],
    createdAt: request.createdAt,
    frontier: frontierResolution.frontier,
    runId: request.runId,
    runtimeTargets,
    stageResults,
    updatedAt: request.createdAt,
    validatedPreflight: request.validatedPreflight,
  });
}

export function beginAutoPatchRuntimeStage(
  coordinator: AutoPatchRuntimeCoordinator,
  request: BeginAutoPatchRuntimeStageRequest,
): AutoPatchRuntimeCoordinatorResolution {
  if (coordinator.status !== 'READY') {
    return invalidTransition(
      `Auto Patch runtime ${coordinator.runId} is not ready to begin a Stage.`,
    );
  }

  if (
    !isNonEmptyTrimmedString(request.attemptId) ||
    !isValidTimestamp(request.startedAt) ||
    Date.parse(request.startedAt) < Date.parse(coordinator.updatedAt) ||
    coordinator.attempts.some(
      (attempt) => attempt.attemptId === request.attemptId,
    )
  ) {
    return failure(
      'invalid-request',
      'runtime-attempt-invalid',
      'Auto Patch Stage attempt identity or start time is invalid.',
    );
  }

  const dispatchResolution = createAutoPatchRuntimeStageDispatch(
    coordinator,
    request,
  );

  if (!dispatchResolution.ok) {
    return dispatchResolution;
  }

  const activeAttempt = freezeDeep({
    attemptId: request.attemptId,
    fingerprint: coordinator.activeStage.fingerprint,
    scope: { ...coordinator.activeStage.scope },
    startedAt: request.startedAt,
    state: 'RUNNING' as const,
  });
  const nextCoordinator = freezeDeep({
    ...coordinator,
    activeAttempt,
    attempts: [...coordinator.attempts, activeAttempt],
    status: 'RUNNING' as const,
    updatedAt: request.startedAt,
  });

  return freezeDeep({
    coordinator: nextCoordinator,
    dispatch: dispatchResolution.dispatch,
    ok: true,
  });
}

export function completeAutoPatchRuntimeStage(
  coordinator: AutoPatchRuntimeCoordinator,
  request: CompleteAutoPatchRuntimeStageRequest,
): AutoPatchRuntimeCoordinatorResolution {
  if (
    coordinator.status !== 'RUNNING' ||
    coordinator.activeAttempt.attemptId !== request.attemptId
  ) {
    return invalidTransition(
      `Auto Patch runtime ${coordinator.runId} does not have the requested running Stage attempt.`,
    );
  }

  const { activeAttempt, activeStage } = coordinator;
  const result = request.result;

  if (
    result.state !== 'COMPLETED' ||
    !areScopesEqual(result.scope, activeStage.scope) ||
    result.fingerprint !== activeStage.fingerprint ||
    !isValidTimestamp(result.finishedAt) ||
    Date.parse(result.finishedAt) < Date.parse(activeAttempt.startedAt) ||
    request.runtimeTarget.targetClipId !==
      activeStage.scope.targetClipId ||
    !result.outputArtifactIds.every((artifactId) =>
      request.runtimeTarget.availability.artifactIds.includes(
        artifactId,
      ),
    ) ||
    !result.outputClipTakeIds.every((clipTakeId) =>
      request.runtimeTarget.availability.clipTakeIds.includes(
        clipTakeId,
      ),
    )
  ) {
    return failure(
      'result-invalid',
      'completed-stage-result-mismatch',
      'Completed Stage result, output availability, scope, or fingerprint does not match the running attempt.',
    );
  }

  let stageResults: readonly CompletedTabFlowStageResultRecord[];

  try {
    stageResults = registerTabFlowStageResult(
      coordinator.stageResults,
      result,
    );
  } catch (error) {
    return failure(
      'result-invalid',
      'completed-stage-result-invalid',
      error instanceof Error
        ? error.message
        : 'Completed Stage result is invalid.',
    );
  }

  const runtimeTargets = replaceRuntimeTarget(
    coordinator.runtimeTargets,
    request.runtimeTarget,
  );
  const frontierResolution = createAutoPatchExecutionFrontier({
    runtimeTargets,
    stageResults,
    validatedPreflight: coordinator.validatedPreflight,
  });

  if (!frontierResolution.canPlan) {
    return failure(
      'frontier-rejected',
      frontierResolution.cause,
      frontierResolution.message,
    );
  }

  const completedAttempt = freezeDeep({
    attemptId: activeAttempt.attemptId,
    fingerprint: activeAttempt.fingerprint,
    finishedAt: result.finishedAt,
    resultId: result.resultId,
    scope: { ...activeAttempt.scope },
    startedAt: activeAttempt.startedAt,
    state: 'COMPLETED' as const,
  });
  const attempts = coordinator.attempts.map((attempt) =>
    attempt.attemptId === activeAttempt.attemptId
      ? completedAttempt
      : attempt,
  );

  return materializeCoordinator({
    attempts,
    createdAt: coordinator.createdAt,
    frontier: frontierResolution.frontier,
    runId: coordinator.runId,
    runtimeTargets,
    stageResults,
    updatedAt: result.finishedAt,
    validatedPreflight: coordinator.validatedPreflight,
  });
}

export function failAutoPatchRuntimeStage(
  coordinator: AutoPatchRuntimeCoordinator,
  request: FailAutoPatchRuntimeStageRequest,
): AutoPatchRuntimeCoordinatorResolution {
  if (
    coordinator.status !== 'RUNNING' ||
    coordinator.activeAttempt.attemptId !== request.attemptId
  ) {
    return invalidTransition(
      `Auto Patch runtime ${coordinator.runId} does not have the requested running Stage attempt.`,
    );
  }

  if (
    !isNonEmptyTrimmedString(request.cause) ||
    !isNonEmptyTrimmedString(request.message) ||
    !isValidTimestamp(request.failedAt) ||
    Date.parse(request.failedAt) <
      Date.parse(coordinator.activeAttempt.startedAt)
  ) {
    return failure(
      'invalid-request',
      'runtime-failure-invalid',
      'Auto Patch Stage failure identity, message, or timestamp is invalid.',
    );
  }

  const failedAttempt = freezeDeep({
    attemptId: coordinator.activeAttempt.attemptId,
    cause: request.cause,
    failedAt: request.failedAt,
    fingerprint: coordinator.activeAttempt.fingerprint,
    message: request.message,
    scope: { ...coordinator.activeAttempt.scope },
    startedAt: coordinator.activeAttempt.startedAt,
    state: 'FAILED' as const,
  });
  const attempts = coordinator.attempts.map((attempt) =>
    attempt.attemptId === coordinator.activeAttempt.attemptId
      ? failedAttempt
      : attempt,
  );
  const nextCoordinator = freezeDeep({
    ...coordinator,
    activeAttempt: null,
    activeStage: null,
    attempts,
    failure: {
      attemptId: failedAttempt.attemptId,
      cause: failedAttempt.cause,
      failedAt: failedAttempt.failedAt,
      message: failedAttempt.message,
      scope: { ...failedAttempt.scope },
    },
    status: 'FAILED' as const,
    updatedAt: request.failedAt,
  });

  return freezeDeep({ coordinator: nextCoordinator, ok: true });
}

function materializeCoordinator(
  base: AutoPatchRuntimeCoordinatorBase,
): AutoPatchRuntimeCoordinatorResolution {
  const stages = base.frontier.targets.flatMap((target) =>
    target.families.flatMap((family) => family.stages),
  );
  const activeStage = stages.find(
    (stage): stage is AutoPatchExecuteFrontierStage =>
      stage.action === 'execute',
  );

  if (activeStage) {
    return freezeDeep({
      coordinator: {
        ...base,
        activeAttempt: null,
        activeStage,
        failure: null,
        status: 'READY' as const,
      },
      ok: true,
    });
  }

  if (stages.some((stage) => stage.action === 'pending')) {
    return failure(
      'frontier-rejected',
      'execution-frontier-stalled',
      'Auto Patch execution frontier has pending Stages without an executable Stage.',
    );
  }

  return freezeDeep({
    coordinator: {
      ...base,
      activeAttempt: null,
      activeStage: null,
      failure: null,
      status: 'COMPLETED' as const,
    },
    ok: true,
  });
}

function replaceRuntimeTarget(
  currentTargets: readonly AutoPatchRuntimeTargetSnapshot[],
  replacement: AutoPatchRuntimeTargetSnapshot,
): readonly AutoPatchRuntimeTargetSnapshot[] {
  return cloneRuntimeTargets(
    currentTargets.map((target) =>
      target.targetClipId === replacement.targetClipId
        ? replacement
        : target,
    ),
  );
}

function cloneRuntimeTargets(
  runtimeTargets: readonly AutoPatchRuntimeTargetSnapshot[],
): readonly AutoPatchRuntimeTargetSnapshot[] {
  return freezeDeep(
    runtimeTargets.map((target) => ({
      artifactIdentities: target.artifactIdentities.map((identity) => ({
        artifactId: identity.artifactId,
        mediaType: identity.mediaType,
        ...(identity.midi ? { midi: { ...identity.midi } } : {}),
      })),
      availability: {
        artifactIds: [...target.availability.artifactIds],
        clipTakeIds: [...target.availability.clipTakeIds],
      },
      targetClipId: target.targetClipId,
    })),
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

function invalidTransition(
  message: string,
): Extract<
  AutoPatchRuntimeCoordinatorResolution,
  { ok: false }
> {
  return failure(
    'invalid-transition',
    'runtime-transition-invalid',
    message,
  );
}

function failure(
  reason: Extract<
    AutoPatchRuntimeCoordinatorResolution,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchRuntimeCoordinatorResolution,
  { ok: false }
> {
  return Object.freeze({ cause, message, ok: false, reason });
}

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !Number.isNaN(Date.parse(value))
  );
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value
  );
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => {
      freezeDeep(child);
    });
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
}
