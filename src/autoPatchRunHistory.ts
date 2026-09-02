import type { AutoPatchGraphSnapshot } from './autoPatchGraphSnapshot';
import type { AutoPatchProductionDriverResult } from './autoPatchProductionDriver';
import type {
  AutoPatchReadyRuntimeCoordinator,
  AutoPatchRuntimeAttemptRecord,
  AutoPatchRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';
import type { AutoPatchValidatedStage } from './autoPatchStagePreflight';
import { normalizeTabFlowStageResultIndex } from './tabFlowStageResultIndex';
import type {
  ProjectState,
  RunHistoryEntry,
  TabFlowStageResultScope,
} from './types';

export const MAX_AUTO_PATCH_RUN_HISTORY_ENTRIES = 50;

export type AutoPatchProductionRunHistorySnapshot = Readonly<{
  attempts: readonly AutoPatchRuntimeAttemptRecord[];
  completedResultIds: readonly string[];
  generatedArtifactIds: readonly string[];
  generatedClipIds: readonly string[];
  generatedClipTakeIds: readonly string[];
  generatedTrackIds: readonly string[];
  graphSnapshot: AutoPatchGraphSnapshot;
  planId: string;
  recordedAt: string;
  referencedResultIds: readonly string[];
  resultStatus: AutoPatchProductionDriverResult['status'];
  reusedResultIds: readonly string[];
  runId: string;
  schemaVersion: 1;
  stages: readonly AutoPatchValidatedStage[];
  updatedAt: string;
  cause?: string;
  failureScope?: TabFlowStageResultScope;
  message?: string;
}>;

export type AutoPatchProductionRunHistoryEntry = Readonly<
  RunHistoryEntry &
    Readonly<{
      autoPatchProduction: AutoPatchProductionRunHistorySnapshot;
    }>
>;

export type AutoPatchRunHistoryWriteRequest = Readonly<{
  entryId: string;
  name: string;
  recordedAt: string;
}>;

export type AutoPatchRunHistoryWriteResolution =
  | Readonly<{
      entry: AutoPatchProductionRunHistoryEntry;
      ok: true;
      project: ProjectState;
      status: 'RECORDED';
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      project: ProjectState;
      reason:
        | 'history-conflict'
        | 'invalid-request'
        | 'project-history-mismatch'
        | 'project-result-mismatch'
        | 'run-mismatch';
      status: 'NOT_RECORDED';
    }>;

export function writeAutoPatchRunHistory(
  initialProject: ProjectState,
  initialCoordinator: AutoPatchReadyRuntimeCoordinator,
  result: AutoPatchProductionDriverResult,
  request: AutoPatchRunHistoryWriteRequest,
): AutoPatchRunHistoryWriteResolution {
  const requestFailure = validateRequest(
    result.project,
    initialCoordinator,
    result.coordinator,
    request,
  );

  if (requestFailure) {
    return requestFailure;
  }

  if (
    result.coordinator.runId !== initialCoordinator.runId ||
    result.coordinator.createdAt !== initialCoordinator.createdAt
  ) {
    return notRecorded(
      result.project,
      'run-mismatch',
      'run-history-run-mismatch',
      'Auto Patch Run History source does not belong to the supplied run.',
    );
  }

  if (result.project.takes !== initialProject.takes) {
    return notRecorded(
      result.project,
      'project-history-mismatch',
      'run-history-project-history-changed',
      'Project Run History changed after the Auto Patch runtime snapshot was created.',
    );
  }

  const initialResults = normalizeTabFlowStageResultIndex(
    initialProject.tabFlowStageResults,
  );
  const initialCoordinatorResults = normalizeTabFlowStageResultIndex(
    initialCoordinator.stageResults,
  );
  const projectResults = normalizeTabFlowStageResultIndex(
    result.project.tabFlowStageResults,
  );
  const coordinatorResults = normalizeTabFlowStageResultIndex(
    result.coordinator.stageResults,
  );

  if (
    !areJsonValuesEqual(initialResults, initialCoordinatorResults) ||
    !areJsonValuesEqual(projectResults, coordinatorResults)
  ) {
    return notRecorded(
      result.project,
      'project-result-mismatch',
      'run-history-stage-results-mismatch',
      'Project and Coordinator Stage Result indexes do not match at the Run History boundary.',
    );
  }

  if (
    initialCoordinatorResults.some(
      (initialResult) =>
        !coordinatorResults.some((resultRecord) =>
          areJsonValuesEqual(resultRecord, initialResult),
        ),
    )
  ) {
    return notRecorded(
      result.project,
      'project-result-mismatch',
      'run-history-prior-stage-result-missing',
      'Auto Patch Run History cannot reference a Project that removed an earlier completed Stage Result.',
    );
  }

  if (
    result.coordinator.attempts.length <
      initialCoordinator.attempts.length ||
    !areJsonValuesEqual(
      result.coordinator.attempts.slice(
        0,
        initialCoordinator.attempts.length,
      ),
      initialCoordinator.attempts,
    )
  ) {
    return notRecorded(
      result.project,
      'run-mismatch',
      'run-history-attempt-history-mismatch',
      'Auto Patch Coordinator attempt history changed before Run History was written.',
    );
  }

  const existingRun = result.project.takes.find(
    (entry) =>
      entry.id === request.entryId ||
      (isAutoPatchProductionRunHistoryEntry(entry) &&
        entry.autoPatchProduction.runId === result.coordinator.runId),
  );

  if (existingRun) {
    return notRecorded(
      result.project,
      'history-conflict',
      'run-history-entry-conflict',
      'Auto Patch Run History entry ID and run ID must be unique.',
    );
  }

  const graphSnapshot =
    initialCoordinator.validatedPreflight.plan.graphSnapshot;
  const initialResultIds = new Set(
    initialCoordinatorResults.map((stageResult) => stageResult.resultId),
  );
  const runAttempts = result.coordinator.attempts.slice(
    initialCoordinator.attempts.length,
  );
  const completedResultIds = runAttempts.flatMap(
    (attempt) =>
      attempt.state === 'COMPLETED' &&
      !initialResultIds.has(attempt.resultId)
        ? [attempt.resultId]
        : [],
  );
  const reusedResultIds = collectReusedResultIds(initialCoordinator);

  if (
    runAttempts.some((attempt) => {
      if (attempt.state !== 'COMPLETED') {
        return false;
      }

      const stageResult = coordinatorResults.find(
        (candidate) => candidate.resultId === attempt.resultId,
      );

      return (
        !stageResult ||
        stageResult.fingerprint !== attempt.fingerprint ||
        stageResult.finishedAt !== attempt.finishedAt ||
        !areStageScopesEqual(stageResult.scope, attempt.scope)
      );
    }) ||
    reusedResultIds.some(
      (resultId) =>
        !coordinatorResults.some(
          (stageResult) => stageResult.resultId === resultId,
        ),
    )
  ) {
    return notRecorded(
      result.project,
      'project-result-mismatch',
      'run-history-result-reference-invalid',
      'Auto Patch Run History contains an invalid completed or reused Stage Result reference.',
    );
  }
  const generatedArtifactIds = collectAddedIds(
    initialProject.artifacts ?? [],
    result.project.artifacts ?? [],
    (artifact) => artifact.artifactId,
  );
  const generatedClipIds = collectAddedIds(
    collectClips(initialProject),
    collectClips(result.project),
    (clip) => clip.id,
  );
  const generatedClipTakeIds = collectAddedIds(
    collectClipTakes(initialProject),
    collectClipTakes(result.project),
    (clipTake) => clipTake.clipTakeId,
  );
  const generatedTrackIds = collectAddedIds(
    initialProject.tracks,
    result.project.tracks,
    (track) => track.id,
  );
  const entry = freezeDeep({
    appliedPatchIds: uniqueInOrder(
      graphSnapshot.families.flatMap((family) => family.patchTabOrder),
    ),
    appliedTabFlowIds: uniqueInOrder(
      graphSnapshot.families.flatMap((family) => family.lineOrder),
    ),
    autoPatchProduction: {
      attempts: cloneSnapshot(runAttempts),
      completedResultIds,
      generatedArtifactIds,
      generatedClipIds,
      generatedClipTakeIds,
      generatedTrackIds,
      graphSnapshot: cloneSnapshot(graphSnapshot),
      planId: initialCoordinator.validatedPreflight.plan.planId,
      recordedAt: request.recordedAt,
      referencedResultIds: uniqueInOrder([
        ...reusedResultIds,
        ...completedResultIds,
      ]),
      resultStatus: result.status,
      reusedResultIds,
      runId: result.coordinator.runId,
      schemaVersion: 1 as const,
      stages: cloneSnapshot(
        initialCoordinator.validatedPreflight.stages,
      ),
      updatedAt: result.coordinator.updatedAt,
      ...getFailureSnapshot(result),
    },
    createdAt: initialCoordinator.createdAt,
    executionMode: 'auto_patch' as const,
    generatedClipIds,
    generatedTrackIds,
    id: request.entryId,
    logs: createRunLogs(
      result,
      runAttempts,
      reusedResultIds,
      request.recordedAt,
    ),
    name: request.name,
    patchSnapshots: graphSnapshot.families.flatMap((family) =>
      family.patchTabs.map((patchTab) => {
        const projectPatchTab = initialProject.patchTabs.find(
          (candidate) => candidate.id === patchTab.id,
        );

        return {
          id: patchTab.id,
          inputType: projectPatchTab?.inputType ?? 'unknown',
          name: patchTab.name,
          outputType: projectPatchTab?.outputType ?? 'unknown',
        };
      }),
    ),
    routingSnapshots: graphSnapshot.families.flatMap((family) =>
      family.connections.map((connection) => ({
        activation: connection.activation,
        connectionId: connection.id,
        enabled: connection.enabled,
        fromPatchTabId: connection.fromPatchTabId,
        fromPortId: connection.fromPortId,
        order: connection.order,
        toPatchTabId: connection.toPatchTabId,
        toPortId: connection.toPortId,
      })),
    ),
    sourceSelection: graphSnapshot.targetClipIds.map((clipId) => ({
      id: clipId,
      type: 'clip' as const,
    })),
    tabFlowSnapshots: graphSnapshot.families.flatMap((family) =>
      family.lines.map((line) => ({
        connectionIds: [...line.connectionIds],
        displayLabel: line.name,
        enabled: line.enabled,
        familyId: line.familyId ?? family.familyId,
        id: line.id,
        name: line.name,
        order: line.order,
        parentLineId: line.attachment?.parentLineId,
        revision: line.revision,
      })),
    ),
  }) as AutoPatchProductionRunHistoryEntry;
  const project = {
    ...result.project,
    takes: [...result.project.takes, entry].slice(
      -MAX_AUTO_PATCH_RUN_HISTORY_ENTRIES,
    ),
  };

  return Object.freeze({
    entry,
    ok: true as const,
    project,
    status: 'RECORDED' as const,
  });
}

export function isAutoPatchProductionRunHistoryEntry(
  entry: RunHistoryEntry,
): entry is AutoPatchProductionRunHistoryEntry {
  const candidate = entry as RunHistoryEntry & {
    autoPatchProduction?: unknown;
  };

  return (
    isRecord(candidate.autoPatchProduction) &&
    candidate.autoPatchProduction.schemaVersion === 1 &&
    typeof candidate.autoPatchProduction.runId === 'string'
  );
}

function validateRequest(
  project: ProjectState,
  initialCoordinator: AutoPatchReadyRuntimeCoordinator,
  resultCoordinator: AutoPatchRuntimeCoordinator,
  request: AutoPatchRunHistoryWriteRequest,
): Extract<AutoPatchRunHistoryWriteResolution, { ok: false }> | undefined {
  if (
    !isNonEmptyTrimmedString(request.entryId) ||
    !isNonEmptyTrimmedString(request.name) ||
    !isValidTimestamp(request.recordedAt) ||
    Date.parse(request.recordedAt) <
      Math.max(
        Date.parse(initialCoordinator.createdAt),
        Date.parse(resultCoordinator.updatedAt),
      )
  ) {
    return notRecorded(
      project,
      'invalid-request',
      'run-history-request-invalid',
      'Auto Patch Run History requires a unique entry ID, a name, and a valid non-decreasing recorded timestamp.',
    );
  }

  return undefined;
}

function collectReusedResultIds(
  coordinator: AutoPatchReadyRuntimeCoordinator,
): string[] {
  return uniqueInOrder(
    coordinator.frontier.targets.flatMap((target) =>
      target.families.flatMap((family) =>
        family.stages.flatMap((stage) =>
          stage.action === 'reuse' ? [stage.matchedResult.resultId] : [],
        ),
      ),
    ),
  );
}

function createRunLogs(
  result: AutoPatchProductionDriverResult,
  attempts: readonly AutoPatchRuntimeAttemptRecord[],
  reusedResultIds: readonly string[],
  recordedAt: string,
) {
  const attemptLogs = attempts.map((attempt) => {
    if (attempt.state === 'COMPLETED') {
      return {
        createdAt: attempt.finishedAt,
        level: 'info' as const,
        message: `Completed Stage ${attempt.scope.stageId} with result ${attempt.resultId}.`,
      };
    }

    if (attempt.state === 'FAILED') {
      return {
        createdAt: attempt.failedAt,
        level: 'error' as const,
        message: `Stage ${attempt.scope.stageId} failed: ${attempt.message}`,
      };
    }

    return {
      createdAt: attempt.startedAt,
      level: 'warning' as const,
      message: `Stage ${attempt.scope.stageId} remained active when the run ended.`,
    };
  });
  const reuseLogs = reusedResultIds.map((resultId) => ({
    createdAt: result.coordinator.createdAt,
    level: 'info' as const,
    message: `Reused Stage Result ${resultId}.`,
  }));
  const finalLevel =
    result.status === 'COMPLETED'
      ? ('info' as const)
      : result.status === 'BLOCKED' || result.status === 'CANCELED'
        ? ('warning' as const)
        : ('error' as const);

  return [
    ...reuseLogs,
    ...attemptLogs,
    {
      createdAt: recordedAt,
      level: finalLevel,
      message:
        result.status === 'COMPLETED'
          ? 'Auto Patch production run completed.'
          : result.message,
    },
  ];
}

function getFailureSnapshot(result: AutoPatchProductionDriverResult) {
  if (result.status === 'COMPLETED') {
    return {};
  }

  return {
    cause: result.cause,
    ...(result.scope
      ? { failureScope: { ...result.scope } }
      : {}),
    message: result.message,
  };
}

function collectClips(project: ProjectState) {
  return project.tracks.flatMap((track) => track.clips);
}

function collectClipTakes(project: ProjectState) {
  return collectClips(project).flatMap((clip) => clip.clipTakes ?? []);
}

function collectAddedIds<T>(
  initialValues: readonly T[],
  resultValues: readonly T[],
  getId: (value: T) => string,
): string[] {
  const initialIds = new Set(initialValues.map(getId));

  return uniqueInOrder(
    resultValues.map(getId).filter((id) => !initialIds.has(id)),
  );
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function notRecorded(
  project: ProjectState,
  reason: Extract<
    AutoPatchRunHistoryWriteResolution,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<AutoPatchRunHistoryWriteResolution, { ok: false }> {
  return Object.freeze({
    cause,
    message,
    ok: false as const,
    project,
    reason,
    status: 'NOT_RECORDED' as const,
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

function areStageScopesEqual(
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

function cloneSnapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneSnapshot(item)) as T;
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      cloneSnapshot(child),
    ]),
  ) as T;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => {
      freezeDeep(child);
    });
    Object.freeze(value);
  }

  return value;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value
  );
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
