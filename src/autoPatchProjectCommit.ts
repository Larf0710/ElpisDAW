import type {
  AutoPatchProductionDriverResult,
} from './autoPatchProductionDriver';
import type {
  AutoPatchReadyRuntimeCoordinator,
  AutoPatchRuntimeAttemptRecord,
  AutoPatchRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';
import type {
  LocalEngineClient,
  LocalEngineProjectFileSave,
} from './localEngineClient';
import { normalizeTabFlowStageResultIndex } from './tabFlowStageResultIndex';
import type { ProjectState } from './types';

export type AutoPatchProjectCommitPlan = Readonly<{
  commitKind: 'COMPLETED' | 'PARTIAL';
  completedAttemptIds: readonly string[];
  completedResultIds: readonly string[];
  coordinator: AutoPatchRuntimeCoordinator;
  project: ProjectState;
  runId: string;
  sourceStatus: AutoPatchProductionDriverResult['status'];
}>;

export type AutoPatchProjectCommitPlanResolution =
  | Readonly<{
      canCommit: true;
      plan: AutoPatchProjectCommitPlan;
      status: 'COMMIT_READY';
    }>
  | Readonly<{
      canCommit: false;
      cause: string;
      coordinator: AutoPatchRuntimeCoordinator;
      message: string;
      project: ProjectState;
      reason:
        | 'attempt-result-mismatch'
        | 'no-finalized-output'
        | 'project-result-mismatch'
        | 'run-mismatch';
      status: 'NOT_COMMITTABLE';
    }>;

export type AutoPatchProjectCommitClient = Pick<
  LocalEngineClient,
  'saveProjectFile'
>;

export type AutoPatchProjectFileMaterializer = (
  project: ProjectState,
  plan: AutoPatchProjectCommitPlan,
) => unknown;

export type AutoPatchProjectCommitRequest = Readonly<{
  currentProject: ProjectState;
  materializeProjectFile: AutoPatchProjectFileMaterializer;
}>;

export type AutoPatchProjectCommitResult =
  | Readonly<{
      ok: true;
      plan: AutoPatchProjectCommitPlan;
      savedProject: LocalEngineProjectFileSave;
      status: 'COMMITTED';
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      plan: AutoPatchProjectCommitPlan;
      reason:
        | 'project-file-materialization-failed'
        | 'project-stale';
      status: 'BLOCKED';
    }>
  | Readonly<{
      cause: string;
      engineStatus?: number;
      message: string;
      ok: false;
      plan: AutoPatchProjectCommitPlan;
      reason: 'project-save-failed';
      status: 'FAILED';
    }>;

export function prepareAutoPatchProjectCommit(
  initialProject: ProjectState,
  initialCoordinator: AutoPatchReadyRuntimeCoordinator,
  result: AutoPatchProductionDriverResult,
): AutoPatchProjectCommitPlanResolution {
  if (
    result.coordinator.runId !== initialCoordinator.runId ||
    result.coordinator.createdAt !== initialCoordinator.createdAt
  ) {
    return notCommittable(
      result.project,
      result.coordinator,
      'run-mismatch',
      'project-commit-run-mismatch',
      'Auto Patch Project commit source does not belong to the supplied run.',
    );
  }

  const projectResults = normalizeTabFlowStageResultIndex(
    result.project.tabFlowStageResults,
  );
  const coordinatorResults = normalizeTabFlowStageResultIndex(
    result.coordinator.stageResults,
  );

  if (!areJsonValuesEqual(projectResults, coordinatorResults)) {
    return notCommittable(
      result.project,
      result.coordinator,
      'project-result-mismatch',
      'project-commit-stage-results-mismatch',
      'Auto Patch Project and Coordinator Stage Results do not match at the commit boundary.',
    );
  }

  const initialCompletedAttemptIds = new Set(
    initialCoordinator.attempts
      .filter((attempt) => attempt.state === 'COMPLETED')
      .map((attempt) => attempt.attemptId),
  );
  const completedAttempts = result.coordinator.attempts
    .filter(
      (
        attempt,
      ): attempt is Extract<
        AutoPatchRuntimeAttemptRecord,
        { state: 'COMPLETED' }
      > =>
        attempt.state === 'COMPLETED' &&
        !initialCompletedAttemptIds.has(attempt.attemptId),
    );
  const initialResultIds = new Set(
    normalizeTabFlowStageResultIndex(initialCoordinator.stageResults).map(
      (stageResult) => stageResult.resultId,
    ),
  );
  const completedResultIds = completedAttempts.map(
    (attempt) => attempt.resultId,
  );
  const hasAttemptResultMismatch =
    new Set(completedResultIds).size !== completedResultIds.length ||
    completedAttempts.some((attempt) => {
      const stageResult = coordinatorResults.find(
        (candidate) => candidate.resultId === attempt.resultId,
      );

      return (
        initialResultIds.has(attempt.resultId) ||
        !stageResult ||
        stageResult.fingerprint !== attempt.fingerprint ||
        stageResult.finishedAt !== attempt.finishedAt ||
        !areStageScopesEqual(stageResult.scope, attempt.scope)
      );
    });

  if (hasAttemptResultMismatch) {
    return notCommittable(
      result.project,
      result.coordinator,
      'attempt-result-mismatch',
      'project-commit-attempt-result-mismatch',
      'Auto Patch completed attempts do not match their finalized Stage Results.',
    );
  }

  if (
    result.project === initialProject ||
    completedAttempts.length === 0 ||
    completedResultIds.length === 0
  ) {
    return notCommittable(
      result.project,
      result.coordinator,
      'no-finalized-output',
      'project-commit-finalized-output-missing',
      'Auto Patch Project commit requires at least one newly finalized Stage output.',
    );
  }

  return Object.freeze({
    canCommit: true as const,
    plan: Object.freeze({
      commitKind:
        result.status === 'COMPLETED' ? 'COMPLETED' : 'PARTIAL',
      completedAttemptIds: Object.freeze(
        completedAttempts.map((attempt) => attempt.attemptId),
      ),
      completedResultIds: Object.freeze([...completedResultIds]),
      coordinator: result.coordinator,
      project: result.project,
      runId: result.coordinator.runId,
      sourceStatus: result.status,
    }),
    status: 'COMMIT_READY' as const,
  });
}

export async function commitAutoPatchProject(
  client: AutoPatchProjectCommitClient,
  plan: AutoPatchProjectCommitPlan,
  request: AutoPatchProjectCommitRequest,
): Promise<AutoPatchProjectCommitResult> {
  if (request.currentProject !== plan.project) {
    return commitBlocked(
      plan,
      'project-stale',
      'project-commit-current-project-changed',
      'Current Project changed after the Auto Patch commit plan was prepared.',
    );
  }

  let projectFile: unknown;

  try {
    projectFile = request.materializeProjectFile(plan.project, plan);
  } catch (error) {
    return commitBlocked(
      plan,
      'project-file-materialization-failed',
      'project-commit-file-materialization-failed',
      error instanceof Error
        ? `Auto Patch Project file materialization failed: ${error.message}`
        : 'Auto Patch Project file materialization failed.',
    );
  }

  if (!isHumStudioProjectFile(projectFile)) {
    return commitBlocked(
      plan,
      'project-file-materialization-failed',
      'project-commit-file-invalid',
      'Auto Patch Project file materialization did not return one supported HumSTUDIO Project object.',
    );
  }

  let projectMatches: boolean;

  try {
    projectMatches = areJsonValuesEqual(
      projectFile.workspace.project,
      plan.project,
    );
  } catch {
    projectMatches = false;
  }

  if (!projectMatches) {
    return commitBlocked(
      plan,
      'project-file-materialization-failed',
      'project-commit-file-project-mismatch',
      'Materialized HumSTUDIO Project data does not match the Auto Patch commit plan.',
    );
  }

  let saveResult: Awaited<
    ReturnType<AutoPatchProjectCommitClient['saveProjectFile']>
  >;

  try {
    saveResult = await client.saveProjectFile(projectFile);
  } catch (error) {
    return commitFailed(
      plan,
      'project-save-exception',
      error instanceof Error
        ? `Auto Patch Project save threw an exception: ${error.message}`
        : 'Auto Patch Project save threw an exception.',
    );
  }

  if (!saveResult.ok) {
    return commitFailed(
      plan,
      saveResult.reason,
      saveResult.message,
      saveResult.status,
    );
  }

  return Object.freeze({
    ok: true as const,
    plan,
    savedProject: Object.freeze({ ...saveResult.savedProject }),
    status: 'COMMITTED' as const,
  });
}

function notCommittable(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  reason: Extract<
    AutoPatchProjectCommitPlanResolution,
    { canCommit: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchProjectCommitPlanResolution,
  { canCommit: false }
> {
  return Object.freeze({
    canCommit: false,
    cause,
    coordinator,
    message,
    project,
    reason,
    status: 'NOT_COMMITTABLE' as const,
  });
}

function commitBlocked(
  plan: AutoPatchProjectCommitPlan,
  reason: Extract<
    AutoPatchProjectCommitResult,
    { status: 'BLOCKED' }
  >['reason'],
  cause: string,
  message: string,
): Extract<AutoPatchProjectCommitResult, { status: 'BLOCKED' }> {
  return Object.freeze({
    cause,
    message,
    ok: false,
    plan,
    reason,
    status: 'BLOCKED' as const,
  });
}

function commitFailed(
  plan: AutoPatchProjectCommitPlan,
  cause: string,
  message: string,
  engineStatus?: number,
): Extract<AutoPatchProjectCommitResult, { status: 'FAILED' }> {
  return Object.freeze({
    cause,
    ...(engineStatus !== undefined ? { engineStatus } : {}),
    message,
    ok: false,
    plan,
    reason: 'project-save-failed' as const,
    status: 'FAILED' as const,
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
  left: AutoPatchRuntimeAttemptRecord['scope'],
  right: AutoPatchRuntimeAttemptRecord['scope'],
): boolean {
  return (
    left.familyId === right.familyId &&
    left.familyRevision === right.familyRevision &&
    left.stageId === right.stageId &&
    left.targetClipId === right.targetClipId
  );
}

function isHumStudioProjectFile(value: unknown): value is Readonly<{
  app: 'HumSTUDIO';
  savedAt: string;
  version: string;
  workspace: Readonly<{ project: unknown }>;
}> {
  if (
    !isRecord(value) ||
    value.app !== 'HumSTUDIO' ||
    typeof value.version !== 'string' ||
    value.version.length === 0 ||
    typeof value.savedAt !== 'string' ||
    Number.isNaN(Date.parse(value.savedAt)) ||
    !isRecord(value.workspace)
  ) {
    return false;
  }

  return 'project' in value.workspace;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
