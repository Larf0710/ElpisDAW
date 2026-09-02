import {
  resolveAutoPatchStageArtifactInputs,
  type AutoPatchRuntimeArtifactIdentity,
} from './autoPatchArtifactInputResolver';
import {
  getAutoPatchChangedStageReason,
  createAutoPatchStageFingerprintSnapshot,
} from './autoPatchFrontierStageFingerprint';
import {
  indexAutoPatchRuntimeTargets,
  type AutoPatchRuntimeTargetSnapshot,
} from './autoPatchFrontierRuntime';
import type {
  AutoPatchFamilyGraphSnapshot,
  AutoPatchPatchTabSnapshot,
  AutoPatchTargetSnapshot,
} from './autoPatchGraphSnapshot';
import type {
  AutoPatchPreflightStage,
} from './autoPatchPreflightPlan';
import type {
  AutoPatchValidatedPreflight,
  AutoPatchValidatedStage,
} from './autoPatchStagePreflight';
import {
  type TabFlowChangedStageReason,
  type TabFlowStageArtifactInput,
} from './tabFlowChangedStage';
import { lookupReusableTabFlowStageResult } from './tabFlowReusableResult';
import { normalizeTabFlowStageResultIndex } from './tabFlowStageResultIndex';
import type {
  CompletedTabFlowStageResultRecord,
  TabFlowStageResultScope,
} from './types';

export type {
  AutoPatchRuntimeArtifactIdentity,
} from './autoPatchArtifactInputResolver';
export type {
  AutoPatchRuntimeTargetSnapshot,
} from './autoPatchFrontierRuntime';

export type AutoPatchExecutionFrontierRequest = Readonly<{
  runtimeTargets: readonly AutoPatchRuntimeTargetSnapshot[];
  stageResults: unknown;
  validatedPreflight: AutoPatchValidatedPreflight;
}>;

export type AutoPatchExecutionFrontierStage =
  | Readonly<{
      action: 'reuse';
      artifactInputs: readonly TabFlowStageArtifactInput[];
      fingerprint: string;
      matchedResult: CompletedTabFlowStageResultRecord;
      reasons: readonly TabFlowChangedStageReason[];
      scope: TabFlowStageResultScope;
    }>
  | Readonly<{
      action: 'execute';
      artifactInputs: readonly TabFlowStageArtifactInput[];
      fingerprint: string;
      matchedResult: null;
      reasons: readonly TabFlowChangedStageReason[];
      scope: TabFlowStageResultScope;
    }>
  | Readonly<{
      action: 'pending';
      artifactInputs: readonly TabFlowStageArtifactInput[];
      fingerprint: null;
      matchedResult: null;
      reasons: readonly TabFlowChangedStageReason[];
      scope: TabFlowStageResultScope;
      waitingForStageIds: readonly string[];
    }>;

export type AutoPatchExecutionFrontierFamily = Readonly<{
  familyId: string;
  familyRevision: number;
  stages: readonly AutoPatchExecutionFrontierStage[];
}>;

export type AutoPatchExecutionFrontierTarget = Readonly<{
  families: readonly AutoPatchExecutionFrontierFamily[];
  targetClipId: string;
}>;

export type AutoPatchExecutionFrontier = Readonly<{
  planId: string;
  targets: readonly AutoPatchExecutionFrontierTarget[];
}>;

export type AutoPatchExecutionFrontierResolution =
  | Readonly<{
      canPlan: true;
      frontier: AutoPatchExecutionFrontier;
    }>
  | Readonly<{
      canPlan: false;
      cause: string;
      message: string;
      reason:
        | 'plan-invalid'
        | 'runtime-invalid'
        | 'fingerprint-unavailable';
      scope?: TabFlowStageResultScope;
      targetClipId?: string;
    }>;

type StagePlanningContext = Readonly<{
  patchTab: AutoPatchPatchTabSnapshot;
  validatedStage: AutoPatchValidatedStage;
}>;

export function createAutoPatchExecutionFrontier(
  request: AutoPatchExecutionFrontierRequest,
): AutoPatchExecutionFrontierResolution {
  const { validatedPreflight } = request;
  const runtimeResolution = indexAutoPatchRuntimeTargets(
    validatedPreflight,
    request.runtimeTargets,
  );

  if (!runtimeResolution.ok) {
    return failure(
      'runtime-invalid',
      runtimeResolution.cause,
      runtimeResolution.message,
      undefined,
      runtimeResolution.targetClipId,
    );
  }

  const validatedStageMap = new Map(
    validatedPreflight.stages.map((stage) => [
      createScopeKey(stage.scope),
      stage,
    ]),
  );
  const plannedStageCount =
    validatedPreflight.plan.targetPlans.reduce(
      (targetCount, targetPlan) =>
        targetCount +
        targetPlan.families.reduce(
          (familyCount, family) =>
            familyCount + family.stages.length,
          0,
        ),
      0,
    );

  if (
    validatedStageMap.size !== validatedPreflight.stages.length ||
    validatedPreflight.stages.length !== plannedStageCount
  ) {
    return failure(
      'plan-invalid',
      'validated-stage-duplicate',
      'Validated Auto Patch Stages must have unique exact scopes.',
    );
  }

  const stageResults = normalizeTabFlowStageResultIndex(
    request.stageResults,
  );
  const targets: AutoPatchExecutionFrontierTarget[] = [];

  for (const targetPlan of validatedPreflight.plan.targetPlans) {
    const target = validatedPreflight.plan.graphSnapshot.targets.find(
      (candidate) => candidate.clipId === targetPlan.targetClipId,
    );
    const runtimeTarget = runtimeResolution.runtimeTargetMap.get(
      targetPlan.targetClipId,
    );

    if (!target || !runtimeTarget) {
      return failure(
        'plan-invalid',
        'target-plan-mismatch',
        `Target Plan ${targetPlan.targetClipId} does not match its immutable graph and runtime snapshots.`,
        undefined,
        targetPlan.targetClipId,
      );
    }

    const families: AutoPatchExecutionFrontierFamily[] = [];

    for (const familyPlan of targetPlan.families) {
      const family = validatedPreflight.plan.graphSnapshot.families.find(
        (candidate) => candidate.familyId === familyPlan.familyId,
      );

      if (
        !family ||
        family.familyRevision !== familyPlan.familyRevision
      ) {
        return failure(
          'plan-invalid',
          'family-plan-mismatch',
          `Flow Family ${familyPlan.familyId} does not match its immutable graph snapshot.`,
          undefined,
          targetPlan.targetClipId,
        );
      }

      const reusedResultsByStageId = new Map<
        string,
        CompletedTabFlowStageResultRecord
      >();
      const stageContextMap = new Map<string, StagePlanningContext>();
      const seenStageIds = new Set<string>();
      const stages: AutoPatchExecutionFrontierStage[] = [];

      for (const stage of familyPlan.stages) {
        if (
          stage.scope.familyId !== familyPlan.familyId ||
          stage.scope.familyRevision !== familyPlan.familyRevision ||
          stage.scope.targetClipId !== targetPlan.targetClipId ||
          seenStageIds.has(stage.scope.stageId) ||
          stage.dependsOnStageIds.some(
            (dependencyId) => !seenStageIds.has(dependencyId),
          )
        ) {
          return failure(
            'plan-invalid',
            'stage-order-invalid',
            `Stage ${stage.scope.stageId} has an invalid scope, duplicate identity, or dependency order.`,
            stage.scope,
          );
        }

        const contextResolution = resolveStagePlanningContext(
          validatedStageMap,
          family,
          stage,
        );

        if (!contextResolution.ok) {
          return contextResolution.failure;
        }

        stageContextMap.set(
          stage.scope.stageId,
          contextResolution.context,
        );
        seenStageIds.add(stage.scope.stageId);
      }

      for (const stage of familyPlan.stages) {
        const waitingForStageIds = stage.dependsOnStageIds.filter(
          (dependencyId) => !reusedResultsByStageId.has(dependencyId),
        );

        if (waitingForStageIds.length > 0) {
          stages.push({
            action: 'pending',
            artifactInputs: [],
            fingerprint: null,
            matchedResult: null,
            reasons: ['upstream-changed'],
            scope: { ...stage.scope },
            waitingForStageIds,
          });
          continue;
        }

        const context = stageContextMap.get(stage.scope.stageId);

        if (!context) {
          return failure(
            'plan-invalid',
            'stage-context-missing',
            `Stage ${stage.scope.stageId} does not have an immutable planning context.`,
            stage.scope,
          );
        }

        const artifactInputResolution =
          resolveAutoPatchStageArtifactInputs(
            family,
            context.patchTab,
            stage,
            target,
            reusedResultsByStageId,
            runtimeTarget.artifactIdentityMap,
          );

        if (!artifactInputResolution.canResolve) {
          return failure(
            'fingerprint-unavailable',
            artifactInputResolution.cause,
            artifactInputResolution.message,
            stage.scope,
          );
        }

        const fingerprintResolution =
          createAutoPatchStageFingerprintSnapshot(
            context.patchTab,
            context.validatedStage,
            artifactInputResolution.artifactInputs,
            {
              ...validatedPreflight.plan.graphSnapshot.projectContext,
            },
          );

        if (!fingerprintResolution.ok) {
          return failure(
            'fingerprint-unavailable',
            fingerprintResolution.cause,
            fingerprintResolution.message,
            stage.scope,
          );
        }

        const fingerprint = fingerprintResolution.fingerprint;
        const lookup = lookupReusableTabFlowStageResult(
          { fingerprint, scope: stage.scope },
          stageResults,
          runtimeTarget.availability,
        );

        if (lookup.matchedResult) {
          reusedResultsByStageId.set(
            stage.scope.stageId,
            lookup.matchedResult as CompletedTabFlowStageResultRecord,
          );
          stages.push({
            action: 'reuse',
            artifactInputs: artifactInputResolution.artifactInputs,
            fingerprint,
            matchedResult:
              lookup.matchedResult as CompletedTabFlowStageResultRecord,
            reasons: [],
            scope: { ...stage.scope },
          });
          continue;
        }

        stages.push({
          action: 'execute',
          artifactInputs: artifactInputResolution.artifactInputs,
          fingerprint,
          matchedResult: null,
          reasons: [
            getAutoPatchChangedStageReason(
              stage.scope,
              fingerprint,
              stageResults,
              runtimeTarget.availability,
            ),
          ],
          scope: { ...stage.scope },
        });
      }

      families.push({
        familyId: familyPlan.familyId,
        familyRevision: familyPlan.familyRevision,
        stages,
      });
    }

    targets.push({
      families,
      targetClipId: targetPlan.targetClipId,
    });
  }

  return freezeDeep({
    canPlan: true,
    frontier: {
      planId: validatedPreflight.plan.planId,
      targets,
    },
  });
}

function resolveStagePlanningContext(
  validatedStageMap: ReadonlyMap<string, AutoPatchValidatedStage>,
  family: AutoPatchFamilyGraphSnapshot,
  stage: AutoPatchPreflightStage,
):
  | Readonly<{ context: StagePlanningContext; ok: true }>
  | Readonly<{
      failure: Extract<
        AutoPatchExecutionFrontierResolution,
        { canPlan: false }
      >;
      ok: false;
    }> {
  const patchTab = family.patchTabs.find(
    (candidate) => candidate.id === stage.scope.stageId,
  );
  const validatedStage = validatedStageMap.get(
    createScopeKey(stage.scope),
  );

  if (!patchTab || !validatedStage) {
    return {
      failure: failure(
        'plan-invalid',
        'stage-plan-mismatch',
        `Stage ${stage.scope.stageId} is missing from its immutable graph or validated runtime profile.`,
        stage.scope,
      ),
      ok: false,
    };
  }

  return {
    context: {
      patchTab,
      validatedStage,
    },
    ok: true,
  };
}

function createScopeKey(scope: TabFlowStageResultScope): string {
  return JSON.stringify([
    scope.familyId,
    scope.familyRevision,
    scope.stageId,
    scope.targetClipId,
  ]);
}

function failure(
  reason: Extract<
    AutoPatchExecutionFrontierResolution,
    { canPlan: false }
  >['reason'],
  cause: string,
  message: string,
  scope?: TabFlowStageResultScope,
  targetClipId?: string,
): Extract<
  AutoPatchExecutionFrontierResolution,
  { canPlan: false }
> {
  return freezeDeep({
    canPlan: false,
    cause,
    message,
    reason,
    ...(scope ? { scope: { ...scope } } : {}),
    ...(targetClipId ? { targetClipId } : {}),
  });
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
