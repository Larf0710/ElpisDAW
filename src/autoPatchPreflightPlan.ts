import {
  createAutoPatchGraphSnapshot,
  createStandaloneStableAudio3FamilyId,
  type AutoPatchGraphSnapshot,
} from './autoPatchGraphSnapshot';
import {
  resolveAutoPatchTargetClipIds,
  type AutoPatchTargetSource,
} from './autoPatchTargetResolution';
import { createTabFlowResultAvailability } from './tabFlowResultAvailability';
import type { TabFlowStageResultAvailability } from './tabFlowReusableResult';
import type {
  ProjectState,
  TabFlowStageResultScope,
} from './types';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';

export type AutoPatchPreflightPlanRequest = Readonly<{
  createdAt: string;
  fallbackClipId?: string;
  planId: string;
  standalonePatchTabId?: string;
  verifiedAudioArtifactIds: readonly string[];
}>;

export type AutoPatchPreflightStage = Readonly<{
  dependsOnStageIds: readonly string[];
  incomingConnectionIds: readonly string[];
  scope: TabFlowStageResultScope;
}>;

export type AutoPatchPreflightFamilyPlan = Readonly<{
  familyId: string;
  familyRevision: number;
  stages: readonly AutoPatchPreflightStage[];
}>;

export type AutoPatchPreflightTargetPlan = Readonly<{
  availability: TabFlowStageResultAvailability;
  families: readonly AutoPatchPreflightFamilyPlan[];
  targetClipId: string;
}>;

export type AutoPatchPreflightPlan = Readonly<{
  createdAt: string;
  graphSnapshot: AutoPatchGraphSnapshot;
  planId: string;
  targetPlans: readonly AutoPatchPreflightTargetPlan[];
  targetSource: AutoPatchTargetSource;
}>;

export type AutoPatchPreflightPlanResolution =
  | Readonly<{
      canPlan: true;
      plan: AutoPatchPreflightPlan;
    }>
  | Readonly<{
      canPlan: false;
      cause: string;
      message: string;
      reason:
        | 'target-resolution-failed'
        | 'graph-snapshot-failed'
        | 'invalid-availability'
        | 'source-unavailable';
      targetClipId?: string;
    }>;

export function createAutoPatchPreflightPlan(
  project: ProjectState,
  request: AutoPatchPreflightPlanRequest,
): AutoPatchPreflightPlanResolution {
  const invalidVerifiedArtifactId = request.verifiedAudioArtifactIds.find(
    (artifactId) =>
      typeof artifactId !== 'string' ||
      !artifactId.trim() ||
      artifactId.trim() !== artifactId,
  );

  if (
    request.standalonePatchTabId !== undefined &&
    (!request.standalonePatchTabId.trim() ||
      request.standalonePatchTabId.trim() !== request.standalonePatchTabId)
  ) {
    return failure(
      'invalid-availability',
      'invalid-standalone-patch-tab-id',
      'Standalone PatchTab ID must be one non-empty trimmed string.',
    );
  }

  if (
    invalidVerifiedArtifactId !== undefined ||
    new Set(request.verifiedAudioArtifactIds).size !==
      request.verifiedAudioArtifactIds.length
  ) {
    return failure(
      'invalid-availability',
      'invalid-verified-audio-artifact-ids',
      'Verified Audio Artifact IDs must be unique non-empty trimmed strings.',
    );
  }

  const targetResolution = resolveAutoPatchTargetClipIds(
    project,
    request.fallbackClipId,
  );

  if (!targetResolution.canResolve) {
    return failure(
      'target-resolution-failed',
      targetResolution.reason,
      targetResolution.message,
    );
  }

  const graphResolution = createAutoPatchGraphSnapshot(project, {
    createdAt: request.createdAt,
    snapshotId: request.planId,
    targetClipIds: targetResolution.targetClipIds,
  });

  if (!graphResolution.canBuild) {
    return failure(
      'graph-snapshot-failed',
      graphResolution.reason,
      graphResolution.message,
    );
  }

  const graphSnapshot = request.standalonePatchTabId
    ? selectStandaloneStableAudio3Family(
        graphResolution.snapshot,
        request.standalonePatchTabId,
      )
    : graphResolution.snapshot;

  if (!graphSnapshot) {
    return failure(
      'graph-snapshot-failed',
      'standalone-stable-audio-3-unavailable',
      `PatchTab ${request.standalonePatchTabId} is not one exact Timeline-bound standalone Stable Audio 3 Stage.`,
    );
  }

  const targetPlans: AutoPatchPreflightTargetPlan[] = [];

  for (const target of graphSnapshot.targets) {
    const availability = createTabFlowResultAvailability(project, {
      targetClipId: target.clipId,
      verifiedAudioArtifactIds: request.verifiedAudioArtifactIds,
    });

    if (
      !availability.artifactIds.includes(target.activeTake.artifactId) ||
      !availability.clipTakeIds.includes(target.activeTake.clipTakeId)
    ) {
      return failure(
        'source-unavailable',
        'active-source-unavailable',
        `Target Clip ${target.clipId} Active Take source is not available.`,
        target.clipId,
      );
    }

    targetPlans.push({
      availability,
      families: graphSnapshot.families.map((family) =>
        createFamilyPlan(target.clipId, family),
      ),
      targetClipId: target.clipId,
    });
  }

  return freezeDeep({
    canPlan: true,
    plan: {
      createdAt: request.createdAt,
      graphSnapshot,
      planId: request.planId,
      targetPlans,
      targetSource: targetResolution.source,
    },
  });
}

function selectStandaloneStableAudio3Family(
  snapshot: AutoPatchGraphSnapshot,
  patchTabId: string,
): AutoPatchGraphSnapshot | undefined {
  const familyId = createStandaloneStableAudio3FamilyId(patchTabId);
  const matches = snapshot.families.filter(
    (family) =>
      family.familyId === familyId &&
      family.patchTabOrder.length === 1 &&
      family.patchTabOrder[0] === patchTabId,
  );

  if (matches.length !== 1) {
    return undefined;
  }

  return freezeDeep({
    ...snapshot,
    families: matches,
    familyOrder: [familyId],
  });
}

function createFamilyPlan(
  targetClipId: string,
  family: AutoPatchGraphSnapshot['families'][number],
): AutoPatchPreflightFamilyPlan {
  const patchTabOrderIndex = new Map(
    family.patchTabOrder.map((patchTabId, index) => [patchTabId, index]),
  );
  const executableStageIds = new Set(
    family.patchTabs
      .filter(
        (patchTab) =>
          patchTab.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.soundFont,
      )
      .map((patchTab) => patchTab.id),
  );

  return {
    familyId: family.familyId,
    familyRevision: family.familyRevision,
    stages: family.patchTabOrder
      .filter((stageId) => executableStageIds.has(stageId))
      .map((stageId) => {
      const incomingConnections = family.connections.filter(
        (connection) => connection.toPatchTabId === stageId,
      );
      const dependsOnStageIds = [
        ...new Set(
          incomingConnections
            .map((connection) => connection.fromPatchTabId)
            .filter((patchTabId) => executableStageIds.has(patchTabId)),
        ),
      ].sort(
        (left, right) =>
          (patchTabOrderIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (patchTabOrderIndex.get(right) ?? Number.MAX_SAFE_INTEGER) ||
          compareStableText(left, right),
      );

      return {
        dependsOnStageIds,
        incomingConnectionIds: incomingConnections.map(
          (connection) => connection.id,
        ),
        scope: {
          familyId: family.familyId,
          familyRevision: family.familyRevision,
          stageId,
          targetClipId,
        },
      };
    }),
  };
}

function failure(
  reason: Exclude<
    AutoPatchPreflightPlanResolution,
    Readonly<{ canPlan: true }>
  >['reason'],
  cause: string,
  message: string,
  targetClipId?: string,
): Exclude<
  AutoPatchPreflightPlanResolution,
  Readonly<{ canPlan: true }>
> {
  return freezeDeep({
    canPlan: false,
    cause,
    message,
    reason,
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

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
