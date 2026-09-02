import {
  doesClipSupportTakeMedia,
  doesClipTakeMatchArtifact,
} from './clipTakeActivation';
import type { TabFlowStageResultAvailability } from './tabFlowReusableResult';
import type { Clip, ProjectArtifact } from './types';

export type TabFlowProjectAvailabilityState = Readonly<{
  artifacts?: readonly ProjectArtifact[];
  tracks: readonly Readonly<{
    clips: readonly Clip[];
  }>[];
}>;

export type TabFlowResultAvailabilityInput = Readonly<{
  targetClipId: string;
  verifiedAudioArtifactIds: readonly string[];
}>;

export function createTabFlowResultAvailability(
  project: TabFlowProjectAvailabilityState,
  input: TabFlowResultAvailabilityInput,
): TabFlowStageResultAvailability {
  requireNonEmptyString(input.targetClipId, 'TabFlow availability target Clip ID');

  const targetClips = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === input.targetClipId);

  if (targetClips.length !== 1) {
    return createFrozenAvailability([], []);
  }

  const artifacts = project.artifacts ?? [];
  const artifactCountById = countIds(
    artifacts.map((artifact) => artifact.artifactId),
  );
  const verifiedAudioArtifactIds = new Set(input.verifiedAudioArtifactIds);
  const availableArtifactMap = new Map<string, ProjectArtifact>();

  artifacts.forEach((artifact) => {
    if (
      isNonEmptyString(artifact.artifactId) &&
      artifactCountById.get(artifact.artifactId) === 1 &&
      (artifact.kind === 'midi' ||
        verifiedAudioArtifactIds.has(artifact.artifactId))
    ) {
      availableArtifactMap.set(artifact.artifactId, artifact);
    }
  });

  const allClipTakes = project.tracks
    .flatMap((track) => track.clips)
    .flatMap((clip) => clip.clipTakes ?? []);
  const clipTakeCountById = countIds(
    allClipTakes.map((clipTake) => clipTake.clipTakeId),
  );
  const targetClip = targetClips[0];
  const availableClipTakeIds = (targetClip.clipTakes ?? [])
    .filter((clipTake) => {
      const artifact = availableArtifactMap.get(clipTake.artifactId);

      return Boolean(
        isNonEmptyString(clipTake.clipTakeId) &&
          clipTakeCountById.get(clipTake.clipTakeId) === 1 &&
          artifact &&
          doesClipSupportTakeMedia(targetClip, clipTake.mediaType) &&
          doesClipTakeMatchArtifact(clipTake, artifact),
      );
    })
    .map((clipTake) => clipTake.clipTakeId);

  return createFrozenAvailability(
    [...availableArtifactMap.keys()],
    availableClipTakeIds,
  );
}

function createFrozenAvailability(
  artifactIds: string[],
  clipTakeIds: string[],
): TabFlowStageResultAvailability {
  return Object.freeze({
    artifactIds: Object.freeze([...artifactIds].sort(compareStableText)),
    clipTakeIds: Object.freeze([...clipTakeIds].sort(compareStableText)),
  });
}

function countIds(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();

  ids.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));
  return counts;
}

function isNonEmptyString(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireNonEmptyString(value: string, label: string): void {
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} must not be empty`);
  }
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
