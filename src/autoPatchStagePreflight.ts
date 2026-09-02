import type { LocalEngineSoundFontResource } from './localEngineClient';
import type {
  AutoPatchPreflightPlan,
  AutoPatchPreflightStage,
} from './autoPatchPreflightPlan';
import type { AutoPatchPatchTabSnapshot } from './autoPatchGraphSnapshot';
import {
  resolveAutoPatchMidiEditProductionCapability,
} from './autoPatchMidiEditProductionCapability';
import {
  resolveAutoPatchStableAudio3ProductionCapability,
} from './autoPatchStableAudio3ProductionCapability';
import {
  validateAutoPatchPortBindings,
  type AutoPatchValidatedPortBinding,
} from './autoPatchPortBindingValidation';
import {
  validateAutoPatchRuntimeProfile,
  type AutoPatchStageExecutionProfile,
  type AutoPatchVerifiedStageRuntimeProfile,
} from './autoPatchRuntimeProfileValidation';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import type { TabFlowStageResourceInput } from './tabFlowChangedStage';
import type { TabFlowStageResultScope } from './types';

export type {
  AutoPatchValidatedPortBinding,
} from './autoPatchPortBindingValidation';
export type {
  AutoPatchStageExecutionProfile,
  AutoPatchVerifiedStageRuntimeProfile,
} from './autoPatchRuntimeProfileValidation';

export type AutoPatchValidatedStage = Readonly<{
  execution: AutoPatchStageExecutionProfile;
  portBindings: readonly AutoPatchValidatedPortBinding[];
  resourceInputs: readonly TabFlowStageResourceInput[];
  scope: TabFlowStageResultScope;
}>;

export type AutoPatchValidatedPreflight = Readonly<{
  plan: AutoPatchPreflightPlan;
  stages: readonly AutoPatchValidatedStage[];
  verifiedSoundFontResourceIds: readonly string[];
}>;

export type AutoPatchStagePreflightResolution =
  | Readonly<{
      canValidate: true;
      validated: AutoPatchValidatedPreflight;
    }>
  | Readonly<{
      canValidate: false;
      cause: string;
      message: string;
      reason:
        | 'profile-invalid'
        | 'contract-invalid'
        | 'binding-invalid'
        | 'cardinality-invalid'
        | 'resource-unavailable'
        | 'provider-invalid';
      scope?: TabFlowStageResultScope;
    }>;

type AutoPatchStagePreflightFailure = Extract<
  AutoPatchStagePreflightResolution,
  { canValidate: false }
>;

type StageContext = Readonly<{
  familySnapshot: AutoPatchPreflightPlan['graphSnapshot']['families'][number];
  patchTab: AutoPatchPatchTabSnapshot;
  stage: AutoPatchPreflightStage;
  target: AutoPatchPreflightPlan['graphSnapshot']['targets'][number];
}>;

export function validateAutoPatchStagePreflight(
  plan: AutoPatchPreflightPlan,
  verifiedRuntimeProfiles: readonly AutoPatchVerifiedStageRuntimeProfile[],
  verifiedSoundFontResources: readonly LocalEngineSoundFontResource[],
): AutoPatchStagePreflightResolution {
  const contexts = collectStageContexts(plan);
  const plannedStageCount = plan.targetPlans.reduce(
    (targetCount, targetPlan) =>
      targetCount +
      targetPlan.families.reduce(
        (familyCount, family) => familyCount + family.stages.length,
        0,
      ),
    0,
  );

  if (contexts.length !== plannedStageCount) {
    return failure(
      'profile-invalid',
      'preflight-plan-structure-invalid',
      `Preflight Plan ${plan.planId} contains a Stage that is missing from its immutable graph snapshot.`,
    );
  }

  const contextMap = new Map(
    contexts.map((context) => [
      createScopeKey(context.stage.scope),
      context,
    ]),
  );

  if (contextMap.size !== contexts.length) {
    return failure(
      'profile-invalid',
      'preflight-plan-scope-duplicate',
      `Preflight Plan ${plan.planId} contains duplicate Stage scope.`,
    );
  }

  const profileResolution = indexRuntimeProfiles(
    plan.planId,
    contexts,
    verifiedRuntimeProfiles,
  );

  if (!profileResolution.ok) {
    return profileResolution.failure;
  }

  const duplicateSoundFontResourceId = findDuplicateId(
    verifiedSoundFontResources.map((resource) => resource.resourceId),
  );

  if (duplicateSoundFontResourceId) {
    return failure(
      'resource-unavailable',
      'soundfont-resource-ambiguous',
      `Verified SoundFont resource ${duplicateSoundFontResourceId} is not unique.`,
    );
  }

  const validatedStages: AutoPatchValidatedStage[] = [];
  const verifiedSoundFontResourceIds = new Set<string>();

  for (const context of contexts) {
    const scopeKey = createScopeKey(context.stage.scope);
    const profile = profileResolution.profileMap.get(scopeKey);

    if (!profile) {
      return failure(
        'profile-invalid',
        'runtime-profile-missing',
        `Stage ${context.stage.scope.stageId} does not have a verified runtime profile.`,
        context.stage.scope,
      );
    }

    const incomingConnections = context.familySnapshot.connections.filter(
      (connection) =>
        connection.toPatchTabId === context.patchTab.id,
    );
    const portResolution = validateAutoPatchPortBindings(
      context.patchTab,
      incomingConnections,
      {
        clipId: context.target.clipId,
        mediaType: context.target.activeTake.mediaType,
      },
    );

    if (!portResolution.ok) {
      return failure(
        portResolution.reason,
        portResolution.cause,
        portResolution.message,
        context.stage.scope,
      );
    }

    if (
      context.patchTab.nodeTypeId ===
      BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit
    ) {
      const capabilityResolution =
        resolveAutoPatchMidiEditProductionCapability(
          context.patchTab.parameters,
        );

      if (!capabilityResolution.productionReady) {
        return failure(
          'contract-invalid',
          capabilityResolution.cause,
          capabilityResolution.message,
          context.stage.scope,
        );
      }
    }

    if (
      context.patchTab.nodeTypeId ===
      BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3
    ) {
      const capabilityResolution =
        resolveAutoPatchStableAudio3ProductionCapability(
          context.patchTab.parameters,
        );

      if (!capabilityResolution.productionReady) {
        return failure(
          'contract-invalid',
          capabilityResolution.cause,
          capabilityResolution.message,
          context.stage.scope,
        );
      }
    }

    const runtimeResolution = validateAutoPatchRuntimeProfile(
      context.patchTab,
      context.target,
      profile,
      verifiedSoundFontResources,
    );

    if (!runtimeResolution.ok) {
      return failure(
        runtimeResolution.reason,
        runtimeResolution.cause,
        runtimeResolution.message,
        context.stage.scope,
      );
    }

    runtimeResolution.verifiedSoundFontResourceIds.forEach((resourceId) => {
      verifiedSoundFontResourceIds.add(resourceId);
    });
    validatedStages.push({
      execution: runtimeResolution.execution,
      portBindings: portResolution.portBindings,
      resourceInputs: runtimeResolution.resourceInputs,
      scope: { ...context.stage.scope },
    });
  }

  return freezeDeep({
    canValidate: true,
    validated: {
      plan,
      stages: validatedStages,
      verifiedSoundFontResourceIds: [...verifiedSoundFontResourceIds].sort(
        compareStableText,
      ),
    },
  });
}

function collectStageContexts(plan: AutoPatchPreflightPlan): StageContext[] {
  return plan.targetPlans.flatMap((targetPlan) => {
    const target = plan.graphSnapshot.targets.find(
      (candidate) => candidate.clipId === targetPlan.targetClipId,
    );

    if (!target) {
      return [];
    }

    return targetPlan.families.flatMap((familyPlan) => {
      const familySnapshot = plan.graphSnapshot.families.find(
        (candidate) => candidate.familyId === familyPlan.familyId,
      );

      if (!familySnapshot) {
        return [];
      }

      return familyPlan.stages.flatMap((stage) => {
        const patchTab = familySnapshot.patchTabs.find(
          (candidate) => candidate.id === stage.scope.stageId,
        );

        return patchTab
          ? [{ familySnapshot, patchTab, stage, target }]
          : [];
      });
    });
  });
}

function indexRuntimeProfiles(
  planId: string,
  contexts: readonly StageContext[],
  profiles: readonly AutoPatchVerifiedStageRuntimeProfile[],
):
  | Readonly<{
      ok: true;
      profileMap: ReadonlyMap<string, AutoPatchVerifiedStageRuntimeProfile>;
    }>
  | Readonly<{
      failure: AutoPatchStagePreflightFailure;
      ok: false;
    }> {
  const contextMap = new Map(
    contexts.map((context) => [
      createScopeKey(context.stage.scope),
      context,
    ]),
  );
  const profileMap = new Map<string, AutoPatchVerifiedStageRuntimeProfile>();

  for (const profile of profiles) {
    const profileKey = createScopeKey(profile.scope);
    const context = contextMap.get(profileKey);

    if (
      !context ||
      profileMap.has(profileKey) ||
      !areScopesEqual(profile.scope, context.stage.scope)
    ) {
      return {
        failure: failure(
          'profile-invalid',
          'runtime-profile-scope-invalid',
          `Stage runtime profile scope is missing, duplicated, or not part of Plan ${planId}.`,
          profile.scope,
        ),
        ok: false,
      };
    }

    profileMap.set(profileKey, profile);
  }

  if (profileMap.size !== contexts.length) {
    const missingContext = contexts.find(
      (context) => !profileMap.has(createScopeKey(context.stage.scope)),
    );

    return {
      failure: failure(
        'profile-invalid',
        'runtime-profile-missing',
        'Every planned Stage requires one verified runtime profile.',
        missingContext?.stage.scope,
      ),
      ok: false,
    };
  }

  return { ok: true, profileMap };
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

function createScopeKey(scope: TabFlowStageResultScope): string {
  return JSON.stringify([
    scope.familyId,
    scope.familyRevision,
    scope.stageId,
    scope.targetClipId,
  ]);
}

function findDuplicateId(ids: readonly string[]): string | undefined {
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) {
      return id;
    }

    seen.add(id);
  }

  return undefined;
}

function failure(
  reason: AutoPatchStagePreflightFailure['reason'],
  cause: string,
  message: string,
  scope?: TabFlowStageResultScope,
): AutoPatchStagePreflightFailure {
  return freezeDeep({
    canValidate: false,
    cause,
    message,
    reason,
    ...(scope ? { scope: { ...scope } } : {}),
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

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
