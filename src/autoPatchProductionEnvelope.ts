import type { AutoPatchProductionDriverResult } from './autoPatchProductionDriver';
import type {
  AutoPatchReadyRuntimeCoordinator,
  AutoPatchRuntimeAttemptRecord,
  AutoPatchRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';
import type {
  CompletedTabFlowStageResultRecord,
  TabFlowStageResultScope,
} from './types';

export const AUTO_PATCH_PRODUCTION_ENVELOPE_SCHEMA_VERSION = 1;

export type AutoPatchProductionEnvelopeBase = Readonly<{
  completedAttemptIds: readonly string[];
  completedResultIds: readonly string[];
  completedStageCount: number;
  createdAt: string;
  newlyCompletedStageCount: number;
  planId: string;
  remainingStageCount: number;
  reusedResultIds: readonly string[];
  reusedStageCount: number;
  runId: string;
  schemaVersion: typeof AUTO_PATCH_PRODUCTION_ENVELOPE_SCHEMA_VERSION;
  stageCount: number;
  updatedAt: string;
}>;

export type AutoPatchProductionProgressEnvelope =
  AutoPatchProductionEnvelopeBase &
    Readonly<{
      activeAttemptId?: string;
      activeScope: TabFlowStageResultScope;
      phase: 'READY' | 'RUNNING';
      status: 'PROGRESS';
    }>;

type AutoPatchBlockedDriverResult = Extract<
  AutoPatchProductionDriverResult,
  { status: 'BLOCKED' }
>;
type AutoPatchCanceledDriverResult = Extract<
  AutoPatchProductionDriverResult,
  { status: 'CANCELED' }
>;
type AutoPatchFailedDriverResult = Extract<
  AutoPatchProductionDriverResult,
  { status: 'FAILED' }
>;
type AutoPatchIncompleteDriverResult =
  | AutoPatchBlockedDriverResult
  | AutoPatchCanceledDriverResult
  | AutoPatchFailedDriverResult;

type AutoPatchProductionFailureEnvelopeBase =
  AutoPatchProductionEnvelopeBase &
    Readonly<{
      cause: string;
      failureScope?: TabFlowStageResultScope;
      message: string;
    }>;

export type AutoPatchProductionTerminalEnvelope =
  | (AutoPatchProductionEnvelopeBase &
      Readonly<{
        sourceStatus: 'COMPLETED';
        status: 'COMPLETED';
      }>)
  | (AutoPatchProductionFailureEnvelopeBase &
      Readonly<{
        reason: AutoPatchBlockedDriverResult['reason'];
        sourceStatus: 'BLOCKED';
        status: 'BLOCKED';
      }>)
  | (AutoPatchProductionFailureEnvelopeBase &
      Readonly<{
        reason: AutoPatchCanceledDriverResult['reason'];
        sourceStatus: 'CANCELED';
        status: 'CANCELED';
      }>)
  | (AutoPatchProductionFailureEnvelopeBase &
      Readonly<{
        reason: AutoPatchFailedDriverResult['reason'];
        sourceStatus: 'FAILED';
        status: 'FAILED';
      }>)
  | (AutoPatchProductionFailureEnvelopeBase &
      Readonly<{
        reason: AutoPatchIncompleteDriverResult['reason'];
        sourceStatus: AutoPatchIncompleteDriverResult['status'];
        status: 'PARTIAL';
      }>);

export type AutoPatchProductionEnvelope =
  | AutoPatchProductionProgressEnvelope
  | AutoPatchProductionTerminalEnvelope;

type AutoPatchProductionEnvelopePreparationFailureReason =
  | 'coordinator-invalid'
  | 'progress-not-active'
  | 'result-inconsistent'
  | 'run-mismatch';

export type AutoPatchProductionEnvelopePreparation =
  | Readonly<{
      envelope: AutoPatchProductionEnvelope;
      ok: true;
      status: 'ENVELOPE_READY';
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      reason: AutoPatchProductionEnvelopePreparationFailureReason;
      status: 'NOT_PREPARED';
    }>;

export function prepareAutoPatchProductionProgressEnvelope(
  initialCoordinator: AutoPatchReadyRuntimeCoordinator,
  coordinator: AutoPatchRuntimeCoordinator,
): AutoPatchProductionEnvelopePreparation {
  if (coordinator.status !== 'READY' && coordinator.status !== 'RUNNING') {
    return notPrepared(
      'progress-not-active',
      'production-envelope-progress-not-active',
      'Auto Patch progress requires a READY or RUNNING Coordinator.',
    );
  }

  const metrics = prepareMetrics(initialCoordinator, coordinator);

  if (!metrics.ok) {
    return metrics;
  }

  if (
    !isScopeInInitialExecutablePlan(
      initialCoordinator,
      coordinator.activeStage.scope,
    ) ||
    (coordinator.status === 'RUNNING' &&
      !areStageScopesEqual(
        coordinator.activeAttempt.scope,
        coordinator.activeStage.scope,
      ))
  ) {
    return notPrepared(
      'coordinator-invalid',
      'production-envelope-active-stage-invalid',
      'Auto Patch progress active Stage does not match the immutable run Plan.',
    );
  }

  const activeScope = Object.freeze({ ...coordinator.activeStage.scope });
  const envelope: AutoPatchProductionProgressEnvelope = Object.freeze({
    ...metrics.base,
    ...(coordinator.status === 'RUNNING'
      ? { activeAttemptId: coordinator.activeAttempt.attemptId }
      : {}),
    activeScope,
    phase: coordinator.status,
    status: 'PROGRESS' as const,
  });

  return prepared(envelope);
}

export function prepareAutoPatchProductionResultEnvelope(
  initialCoordinator: AutoPatchReadyRuntimeCoordinator,
  result: AutoPatchProductionDriverResult,
): AutoPatchProductionEnvelopePreparation {
  const metrics = prepareMetrics(initialCoordinator, result.coordinator);

  if (!metrics.ok) {
    return metrics;
  }

  if (
    result.status === 'COMPLETED' &&
    metrics.base.completedStageCount !== metrics.base.stageCount
  ) {
    return notPrepared(
      'result-inconsistent',
      'production-envelope-completion-incomplete',
      'A completed Auto Patch run must account for every planned Stage.',
    );
  }

  if (result.status === 'COMPLETED') {
    return prepared(
      Object.freeze({
        ...metrics.base,
        sourceStatus: 'COMPLETED' as const,
        status: 'COMPLETED' as const,
      }),
    );
  }

  const failure = Object.freeze({
    cause: result.cause,
    ...(result.scope
      ? { failureScope: Object.freeze({ ...result.scope }) }
      : {}),
    message: result.message,
    reason: result.reason,
    sourceStatus: result.status,
  });

  if (metrics.base.newlyCompletedStageCount > 0) {
    return prepared(
      Object.freeze({
        ...metrics.base,
        ...failure,
        status: 'PARTIAL' as const,
      }),
    );
  }

  if (result.status === 'BLOCKED') {
    return prepared(
      Object.freeze({
        ...metrics.base,
        ...failure,
        reason: result.reason,
        sourceStatus: 'BLOCKED' as const,
        status: 'BLOCKED' as const,
      }),
    );
  }

  if (result.status === 'CANCELED') {
    return prepared(
      Object.freeze({
        ...metrics.base,
        ...failure,
        reason: result.reason,
        sourceStatus: 'CANCELED' as const,
        status: 'CANCELED' as const,
      }),
    );
  }

  return prepared(
    Object.freeze({
      ...metrics.base,
      ...failure,
      reason: result.reason,
      sourceStatus: 'FAILED' as const,
      status: 'FAILED' as const,
    }),
  );
}

type AutoPatchProductionEnvelopeMetrics = Readonly<{
  base: AutoPatchProductionEnvelopeBase;
  ok: true;
}>;

function prepareMetrics(
  initialCoordinator: AutoPatchReadyRuntimeCoordinator,
  coordinator: AutoPatchRuntimeCoordinator,
):
  | AutoPatchProductionEnvelopeMetrics
  | Extract<AutoPatchProductionEnvelopePreparation, { ok: false }> {
  if (
    coordinator.runId !== initialCoordinator.runId ||
    coordinator.createdAt !== initialCoordinator.createdAt ||
    coordinator.frontier.planId !== initialCoordinator.frontier.planId ||
    !areJsonValuesEqual(
      coordinator.validatedPreflight,
      initialCoordinator.validatedPreflight,
    )
  ) {
    return notPrepared(
      'run-mismatch',
      'production-envelope-run-mismatch',
      'Auto Patch production Envelope source does not belong to the supplied run and Plan.',
    );
  }

  if (
    !isValidTimestamp(initialCoordinator.createdAt) ||
    !isValidTimestamp(initialCoordinator.updatedAt) ||
    !isValidTimestamp(coordinator.updatedAt) ||
    Date.parse(initialCoordinator.updatedAt) > Date.parse(coordinator.updatedAt)
  ) {
    return notPrepared(
      'coordinator-invalid',
      'production-envelope-clock-invalid',
      'Auto Patch production Envelope requires valid non-decreasing Coordinator timestamps.',
    );
  }

  if (
    coordinator.attempts.length < initialCoordinator.attempts.length ||
    !areJsonValuesEqual(
      coordinator.attempts.slice(0, initialCoordinator.attempts.length),
      initialCoordinator.attempts,
    )
  ) {
    return notPrepared(
      'coordinator-invalid',
      'production-envelope-attempt-history-invalid',
      'Auto Patch Coordinator attempt history changed before the production Envelope was prepared.',
    );
  }

  const initialStages = initialCoordinator.frontier.targets.flatMap((target) =>
    target.families.flatMap((family) => family.stages),
  );
  const stageCount = initialCoordinator.validatedPreflight.stages.length;
  const stageScopeKeys = initialStages.map((stage) =>
    createScopeKey(stage.scope),
  );

  if (
    stageCount === 0 ||
    initialStages.length !== stageCount ||
    new Set(stageScopeKeys).size !== stageScopeKeys.length
  ) {
    return notPrepared(
      'coordinator-invalid',
      'production-envelope-stage-plan-invalid',
      'Auto Patch production Envelope requires one complete unique Stage plan.',
    );
  }

  const reusedStages = initialStages.filter(
    (stage) => stage.action === 'reuse',
  );
  const reusedResultIds = reusedStages.map(
    (stage) => stage.matchedResult.resultId,
  );
  const newAttempts = coordinator.attempts.slice(
    initialCoordinator.attempts.length,
  );
  const completedAttempts = newAttempts.filter(
    (
      attempt,
    ): attempt is Extract<
      AutoPatchRuntimeAttemptRecord,
      { state: 'COMPLETED' }
    > => attempt.state === 'COMPLETED',
  );
  const completedScopeKeys = completedAttempts.map((attempt) =>
    createScopeKey(attempt.scope),
  );
  const completedResultIds = completedAttempts.map(
    (attempt) => attempt.resultId,
  );
  const completedAttemptIds = completedAttempts.map(
    (attempt) => attempt.attemptId,
  );
  const attemptIds = coordinator.attempts.map(
    (attempt) => attempt.attemptId,
  );
  const resultLocations = indexStageResults(coordinator.stageResults);
  const initialResultLocations = indexStageResults(
    initialCoordinator.stageResults,
  );
  const initialResultsPreserved = initialCoordinator.stageResults.every(
    (stageResult) =>
      (resultLocations.get(stageResult.resultId) ?? []).some((candidate) =>
        areJsonValuesEqual(candidate, stageResult),
      ),
  );
  const completedAttemptsMatch = completedAttempts.every((attempt) => {
    const matches = resultLocations.get(attempt.resultId) ?? [];

    return (
      matches.length === 1 &&
      matches[0].fingerprint === attempt.fingerprint &&
      matches[0].finishedAt === attempt.finishedAt &&
      areStageScopesEqual(matches[0].scope, attempt.scope) &&
      stageScopeKeys.includes(createScopeKey(attempt.scope)) &&
      !reusedStages.some((stage) =>
        areStageScopesEqual(stage.scope, attempt.scope),
      )
    );
  });
  const completedStageCount =
    reusedStages.length + completedAttempts.length;

  if (
    initialResultLocations.size !== initialCoordinator.stageResults.length ||
    resultLocations.size !== coordinator.stageResults.length ||
    coordinator.stageResults.length !==
      initialCoordinator.stageResults.length + completedAttempts.length ||
    !initialResultsPreserved ||
    new Set(reusedResultIds).size !== reusedResultIds.length ||
    new Set(attemptIds).size !== attemptIds.length ||
    new Set(completedAttemptIds).size !== completedAttemptIds.length ||
    new Set(completedResultIds).size !== completedResultIds.length ||
    new Set(completedScopeKeys).size !== completedScopeKeys.length ||
    !completedAttemptsMatch ||
    completedStageCount > stageCount
  ) {
    return notPrepared(
      'coordinator-invalid',
      'production-envelope-stage-progress-invalid',
      'Auto Patch completed and reused Stage progress does not match the immutable run Plan.',
    );
  }

  return Object.freeze({
    base: Object.freeze({
      completedAttemptIds: Object.freeze([...completedAttemptIds]),
      completedResultIds: Object.freeze([...completedResultIds]),
      completedStageCount,
      createdAt: initialCoordinator.createdAt,
      newlyCompletedStageCount: completedAttempts.length,
      planId: initialCoordinator.frontier.planId,
      remainingStageCount: stageCount - completedStageCount,
      reusedResultIds: Object.freeze([...reusedResultIds]),
      reusedStageCount: reusedStages.length,
      runId: initialCoordinator.runId,
      schemaVersion: AUTO_PATCH_PRODUCTION_ENVELOPE_SCHEMA_VERSION,
      stageCount,
      updatedAt: coordinator.updatedAt,
    }),
    ok: true as const,
  });
}

function isScopeInInitialExecutablePlan(
  initialCoordinator: AutoPatchReadyRuntimeCoordinator,
  scope: TabFlowStageResultScope,
): boolean {
  return initialCoordinator.frontier.targets.some((target) =>
    target.families.some((family) =>
      family.stages.some(
        (stage) =>
          stage.action !== 'reuse' &&
          areStageScopesEqual(stage.scope, scope),
      ),
    ),
  );
}

function prepared(
  envelope: AutoPatchProductionEnvelope,
): Extract<AutoPatchProductionEnvelopePreparation, { ok: true }> {
  return Object.freeze({
    envelope,
    ok: true as const,
    status: 'ENVELOPE_READY' as const,
  });
}

function notPrepared(
  reason: AutoPatchProductionEnvelopePreparationFailureReason,
  cause: string,
  message: string,
): Extract<AutoPatchProductionEnvelopePreparation, { ok: false }> {
  return Object.freeze({
    cause,
    message,
    ok: false as const,
    reason,
    status: 'NOT_PREPARED' as const,
  });
}

function indexStageResults(
  stageResults: readonly CompletedTabFlowStageResultRecord[],
): Map<string, CompletedTabFlowStageResultRecord[]> {
  const index = new Map<string, CompletedTabFlowStageResultRecord[]>();

  stageResults.forEach((stageResult) => {
    index.set(stageResult.resultId, [
      ...(index.get(stageResult.resultId) ?? []),
      stageResult,
    ]);
  });

  return index;
}

function createScopeKey(scope: TabFlowStageResultScope): string {
  return JSON.stringify([
    scope.targetClipId,
    scope.familyId,
    scope.familyRevision,
    scope.stageId,
  ]);
}

function areStageScopesEqual(
  left: TabFlowStageResultScope,
  right: TabFlowStageResultScope,
): boolean {
  return createScopeKey(left) === createScopeKey(right);
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isValidTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}
