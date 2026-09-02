import type {
  AutoPatchReadyRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import type { ProjectState, TabFlowStageResultScope } from './types';

export type {
  AutoPatchReadyRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';

export type AutoPatchProductionCapabilityPreflightResolution =
  | Readonly<{
      canStart: true;
      coordinator: AutoPatchReadyRuntimeCoordinator;
      family: Readonly<{
        familyId: string;
        familyRevision: number;
      }>;
      project: ProjectState;
      stageScopes: readonly TabFlowStageResultScope[];
      status: 'READY';
      targetClipIds: readonly string[];
    }>
  | Readonly<{
      canStart: false;
      cause: string;
      coordinator: AutoPatchReadyRuntimeCoordinator;
      message: string;
      project: ProjectState;
      reason:
        | 'multi-family-driver-not-supported'
        | 'unsupported-stage';
      scope?: TabFlowStageResultScope;
      status: 'BLOCKED';
    }>;

const supportedNodeTypeIds = new Set<string>([
  BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
  BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
  BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
]);

export function validateAutoPatchProductionCapabilityPreflight(
  project: ProjectState,
  coordinator: AutoPatchReadyRuntimeCoordinator,
): AutoPatchProductionCapabilityPreflightResolution {
  const familyMap = new Map<
    string,
    Readonly<{ familyId: string; familyRevision: number }>
  >();

  coordinator.frontier.targets.forEach((target) => {
    target.families.forEach((family) => {
      familyMap.set(createFamilyKey(family), {
        familyId: family.familyId,
        familyRevision: family.familyRevision,
      });
    });
  });

  if (familyMap.size !== 1) {
    return blocked(
      project,
      coordinator,
      'multi-family-driver-not-supported',
      'production-driver-family-count-unsupported',
      'The first production Auto Patch driver requires exactly one enabled Root Flow Family.',
    );
  }

  const stageScopes: TabFlowStageResultScope[] = [];

  for (const target of coordinator.frontier.targets) {
    for (const family of target.families) {
      const familySnapshot =
        coordinator.validatedPreflight.plan.graphSnapshot.families.find(
          (candidate) =>
            candidate.familyId === family.familyId &&
            candidate.familyRevision === family.familyRevision,
        );

      for (const stage of family.stages) {
        if (stage.action === 'reuse') {
          continue;
        }

        const patchTab = familySnapshot?.patchTabs.find(
          (candidate) => candidate.id === stage.scope.stageId,
        );

        if (!patchTab) {
          return blocked(
            project,
            coordinator,
            'unsupported-stage',
            'production-stage-contract-unavailable',
            `Stage ${stage.scope.stageId} does not have an immutable production contract.`,
            stage.scope,
          );
        }

        if (!supportedNodeTypeIds.has(patchTab.nodeTypeId)) {
          return blocked(
            project,
            coordinator,
            'unsupported-stage',
            'production-stage-unsupported',
            `Stage ${stage.scope.stageId} uses unsupported production node type ${patchTab.nodeTypeId}.`,
            stage.scope,
          );
        }

        stageScopes.push(Object.freeze({ ...stage.scope }));
      }
    }
  }

  const family = familyMap.values().next().value;

  if (!family) {
    return blocked(
      project,
      coordinator,
      'multi-family-driver-not-supported',
      'production-driver-family-count-unsupported',
      'The first production Auto Patch driver requires exactly one enabled Root Flow Family.',
    );
  }

  return Object.freeze({
    canStart: true as const,
    coordinator,
    family: Object.freeze({ ...family }),
    project,
    stageScopes: Object.freeze(stageScopes),
    status: 'READY' as const,
    targetClipIds: Object.freeze(
      coordinator.frontier.targets.map((target) => target.targetClipId),
    ),
  });
}

function blocked(
  project: ProjectState,
  coordinator: AutoPatchReadyRuntimeCoordinator,
  reason: Extract<
    AutoPatchProductionCapabilityPreflightResolution,
    { canStart: false }
  >['reason'],
  cause: string,
  message: string,
  scope?: TabFlowStageResultScope,
): Extract<
  AutoPatchProductionCapabilityPreflightResolution,
  { canStart: false }
> {
  return Object.freeze({
    canStart: false,
    cause,
    coordinator,
    message,
    project,
    reason,
    ...(scope ? { scope: Object.freeze({ ...scope }) } : {}),
    status: 'BLOCKED',
  });
}

function createFamilyKey(
  family: Readonly<{ familyId: string; familyRevision: number }>,
): string {
  return JSON.stringify([family.familyId, family.familyRevision]);
}
