import type { AutoPatchRuntimeArtifactIdentity } from './autoPatchArtifactInputResolver';
import type { AutoPatchValidatedPreflight } from './autoPatchStagePreflight';
import type { TabFlowStageResultAvailability } from './tabFlowReusableResult';

export type AutoPatchRuntimeTargetSnapshot = Readonly<{
  artifactIdentities: readonly AutoPatchRuntimeArtifactIdentity[];
  availability: TabFlowStageResultAvailability;
  targetClipId: string;
}>;

export type AutoPatchIndexedRuntimeTarget = Readonly<{
  artifactIdentityMap: ReadonlyMap<
    string,
    AutoPatchRuntimeArtifactIdentity
  >;
  availability: TabFlowStageResultAvailability;
}>;

export type AutoPatchRuntimeTargetIndexResolution =
  | Readonly<{
      ok: true;
      runtimeTargetMap: ReadonlyMap<
        string,
        AutoPatchIndexedRuntimeTarget
      >;
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      targetClipId?: string;
    }>;

export function indexAutoPatchRuntimeTargets(
  validatedPreflight: AutoPatchValidatedPreflight,
  runtimeTargets: readonly AutoPatchRuntimeTargetSnapshot[],
): AutoPatchRuntimeTargetIndexResolution {
  const expectedTargetIds = validatedPreflight.plan.targetPlans.map(
    (targetPlan) => targetPlan.targetClipId,
  );
  const runtimeTargetMap = new Map<
    string,
    AutoPatchIndexedRuntimeTarget
  >();

  for (const runtimeTarget of runtimeTargets) {
    if (
      !expectedTargetIds.includes(runtimeTarget.targetClipId) ||
      runtimeTargetMap.has(runtimeTarget.targetClipId) ||
      !isValidAvailability(runtimeTarget.availability)
    ) {
      return runtimeFailure(
        'runtime-target-invalid',
        'Runtime target snapshots must uniquely match every immutable target Plan.',
        runtimeTarget.targetClipId,
      );
    }

    const target = validatedPreflight.plan.graphSnapshot.targets.find(
      (candidate) => candidate.clipId === runtimeTarget.targetClipId,
    );

    if (
      !target ||
      !runtimeTarget.availability.artifactIds.includes(
        target.activeTake.artifactId,
      ) ||
      !runtimeTarget.availability.clipTakeIds.includes(
        target.activeTake.clipTakeId,
      )
    ) {
      return runtimeFailure(
        'active-source-unavailable',
        `Runtime target ${runtimeTarget.targetClipId} does not contain its immutable Active Take source.`,
        runtimeTarget.targetClipId,
      );
    }

    const artifactIdentityMap = new Map<
      string,
      AutoPatchRuntimeArtifactIdentity
    >();

    for (const identity of runtimeTarget.artifactIdentities) {
      if (
        artifactIdentityMap.has(identity.artifactId) ||
        !runtimeTarget.availability.artifactIds.includes(
          identity.artifactId,
        ) ||
        !isValidArtifactIdentity(identity)
      ) {
        return runtimeFailure(
          'artifact-identity-invalid',
          `Runtime target ${runtimeTarget.targetClipId} contains an invalid or duplicate Artifact identity.`,
          runtimeTarget.targetClipId,
        );
      }

      artifactIdentityMap.set(identity.artifactId, freezeIdentity(identity));
    }

    runtimeTargetMap.set(runtimeTarget.targetClipId, {
      artifactIdentityMap,
      availability: freezeAvailability(runtimeTarget.availability),
    });
  }

  if (runtimeTargetMap.size !== expectedTargetIds.length) {
    return runtimeFailure(
      'runtime-target-missing',
      'Every immutable target Plan requires one runtime availability snapshot.',
    );
  }

  return Object.freeze({ ok: true, runtimeTargetMap });
}

function isValidAvailability(
  availability: TabFlowStageResultAvailability,
): boolean {
  return (
    Array.isArray(availability.artifactIds) &&
    Array.isArray(availability.clipTakeIds) &&
    areUniqueTrimmedStrings(availability.artifactIds) &&
    areUniqueTrimmedStrings(availability.clipTakeIds)
  );
}

function isValidArtifactIdentity(
  identity: AutoPatchRuntimeArtifactIdentity,
): boolean {
  if (!isNonEmptyTrimmedString(identity.artifactId)) {
    return false;
  }

  if (identity.mediaType === 'audio') {
    return identity.midi === undefined;
  }

  return (
    identity.mediaType === 'midi' &&
    identity.midi !== undefined &&
    isNonEmptyTrimmedString(identity.midi.contentHash) &&
    Number.isSafeInteger(identity.midi.revision) &&
    identity.midi.revision >= 0
  );
}

function freezeAvailability(
  availability: TabFlowStageResultAvailability,
): TabFlowStageResultAvailability {
  return Object.freeze({
    artifactIds: Object.freeze([...availability.artifactIds]),
    clipTakeIds: Object.freeze([...availability.clipTakeIds]),
  });
}

function freezeIdentity(
  identity: AutoPatchRuntimeArtifactIdentity,
): AutoPatchRuntimeArtifactIdentity {
  return Object.freeze({
    artifactId: identity.artifactId,
    mediaType: identity.mediaType,
    ...(identity.midi
      ? { midi: Object.freeze({ ...identity.midi }) }
      : {}),
  });
}

function areUniqueTrimmedStrings(values: readonly string[]): boolean {
  return (
    values.every(isNonEmptyTrimmedString) &&
    new Set(values).size === values.length
  );
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value
  );
}

function runtimeFailure(
  cause: string,
  message: string,
  targetClipId?: string,
): Extract<
  AutoPatchRuntimeTargetIndexResolution,
  { ok: false }
> {
  return Object.freeze({
    cause,
    message,
    ok: false,
    ...(targetClipId ? { targetClipId } : {}),
  });
}
