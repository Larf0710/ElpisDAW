import {
  activateClipTake,
  doesClipSupportTakeMedia,
  doesClipTakeMatchArtifact,
} from './clipTakeActivation';
import type { AutoPatchProductionDriverResult } from './autoPatchProductionDriver';
import {
  prepareAutoPatchProjectCommit,
  type AutoPatchProjectCommitPlan,
} from './autoPatchProjectCommit';
import {
  writeAutoPatchRunHistory,
  type AutoPatchProductionRunHistoryEntry,
  type AutoPatchRunHistoryWriteRequest,
} from './autoPatchRunHistory';
import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import type { AutoPatchReadyRuntimeCoordinator } from './autoPatchRuntimeCoordinator';
import { normalizeTabFlowStageResultIndex } from './tabFlowStageResultIndex';
import type {
  Clip,
  ClipTake,
  ProjectState,
} from './types';

export type AutoPatchProductionPersistenceRequest = Readonly<{
  history: AutoPatchRunHistoryWriteRequest;
  sourceAvailability: GeneratedAudioCommitAvailabilityEvidence;
}>;

export type AutoPatchProductionPersistencePreparation =
  | Readonly<{
      canCommit: true;
      historyEntry: AutoPatchProductionRunHistoryEntry;
      plan: AutoPatchProjectCommitPlan;
      project: ProjectState;
      result: AutoPatchProductionDriverResult;
      status: 'COMMIT_READY';
    }>
  | Readonly<{
      canCommit: false;
      cause: string;
      message: string;
      project: ProjectState;
      reason:
        | 'availability-invalid'
        | 'finalized-output-unavailable'
        | 'history-not-recorded'
        | 'project-not-committable'
        | 'source-synchronization-failed';
      result: AutoPatchProductionDriverResult;
      status: 'NOT_COMMITTABLE';
      historyEntry?: AutoPatchProductionRunHistoryEntry;
    }>;

export function prepareAutoPatchProductionPersistence(
  initialProject: ProjectState,
  initialCoordinator: AutoPatchReadyRuntimeCoordinator,
  result: AutoPatchProductionDriverResult,
  request: AutoPatchProductionPersistenceRequest,
): AutoPatchProductionPersistencePreparation {
  if (!isValidSourceAvailability(request.sourceAvailability)) {
    return failure(
      result,
      result.project,
      'availability-invalid',
      'production-persistence-audio-availability-invalid',
      'Generated Audio availability evidence must contain unique canonical Artifact IDs and a valid check time.',
    );
  }

  const history = writeAutoPatchRunHistory(
    initialProject,
    initialCoordinator,
    result,
    request.history,
  );

  if (!history.ok) {
    return failure(
      result,
      history.project,
      'history-not-recorded',
      history.cause,
      history.message,
    );
  }

  const outputFailure = validateReferencedFinalizedOutputs(
    history.project,
    history.entry.autoPatchProduction.referencedResultIds,
    request.sourceAvailability.availableArtifactIds,
  );

  if (outputFailure) {
    return failure(
      replaceProject(result, history.project),
      history.project,
      'finalized-output-unavailable',
      outputFailure.cause,
      outputFailure.message,
      history.entry,
    );
  }

  const synchronization = synchronizeReferencedActiveAudioSources(
    history.project,
    history.entry.autoPatchProduction.referencedResultIds,
    request.sourceAvailability,
  );

  if (!synchronization.ok) {
    return failure(
      replaceProject(result, history.project),
      history.project,
      'source-synchronization-failed',
      synchronization.cause,
      synchronization.message,
      history.entry,
    );
  }

  const resultWithHistory = replaceProject(result, synchronization.project);
  const commit = prepareAutoPatchProjectCommit(
    initialProject,
    initialCoordinator,
    resultWithHistory,
  );

  if (!commit.canCommit) {
    return failure(
      resultWithHistory,
      synchronization.project,
      'project-not-committable',
      commit.cause,
      commit.message,
      history.entry,
    );
  }

  return Object.freeze({
    canCommit: true as const,
    historyEntry: history.entry,
    plan: commit.plan,
    project: commit.plan.project,
    result: resultWithHistory,
    status: 'COMMIT_READY' as const,
  });
}

type SourceSynchronizationResult =
  | Readonly<{
      ok: true;
      project: ProjectState;
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
    }>;

function synchronizeReferencedActiveAudioSources(
  project: ProjectState,
  referencedResultIds: readonly string[],
  sourceAvailability: GeneratedAudioCommitAvailabilityEvidence,
): SourceSynchronizationResult {
  const referencedIds = new Set(referencedResultIds);
  const outputClipTakeIds = new Set(
    normalizeTabFlowStageResultIndex(project.tabFlowStageResults)
      .filter((stageResult) => referencedIds.has(stageResult.resultId))
      .flatMap((stageResult) => stageResult.outputClipTakeIds),
  );
  const clipTakeLocations = indexClipTakes(project);
  let synchronizedProject = project;

  for (const clipTakeId of outputClipTakeIds) {
    const locations = clipTakeLocations.get(clipTakeId) ?? [];

    if (locations.length !== 1) {
      return {
        cause: 'production-persistence-source-clip-take-unavailable',
        message: `Referenced output ClipTake ${clipTakeId} is missing or ambiguous during source synchronization.`,
        ok: false,
      };
    }

    const { clip, clipTake } = locations[0];

    if (
      clipTake.mediaType !== 'audio' ||
      clip.activeClipTakeId !== clipTake.clipTakeId
    ) {
      continue;
    }

    const activation = activateClipTake(
      synchronizedProject,
      clip.id,
      clipTake.clipTakeId,
      { sourceAvailability },
    );

    if (!activation.canActivate) {
      return {
        cause: `production-persistence-source-${activation.reason}`,
        message: activation.message,
        ok: false,
      };
    }

    synchronizedProject = activation.project;
  }

  return Object.freeze({
    ok: true as const,
    project: synchronizedProject,
  });
}

type FinalizedOutputFailure = Readonly<{
  cause: string;
  message: string;
}>;

function validateReferencedFinalizedOutputs(
  project: ProjectState,
  referencedResultIds: readonly string[],
  verifiedAudioArtifactIds: readonly string[],
): FinalizedOutputFailure | undefined {
  const stageResults = normalizeTabFlowStageResultIndex(
    project.tabFlowStageResults,
  );
  const artifacts = project.artifacts ?? [];
  const artifactLocations = indexById(
    artifacts,
    (artifact) => artifact.artifactId,
  );
  const clipTakeLocations = indexClipTakes(project);
  const verifiedAudioIds = new Set(verifiedAudioArtifactIds);

  for (const resultId of referencedResultIds) {
    const stageResult = stageResults.find(
      (candidate) => candidate.resultId === resultId,
    );

    if (!stageResult) {
      return {
        cause: 'production-persistence-stage-result-missing',
        message: `Referenced Stage Result ${resultId} is missing from the Project.`,
      };
    }

    const outputArtifactIds = new Set(stageResult.outputArtifactIds);

    for (const artifactId of stageResult.outputArtifactIds) {
      const matches = artifactLocations.get(artifactId) ?? [];

      if (
        matches.length !== 1 ||
        (matches[0].kind === 'audio' &&
          !verifiedAudioIds.has(artifactId))
      ) {
        return {
          cause: 'production-persistence-artifact-unavailable',
          message: `Stage Result ${resultId} output Artifact ${artifactId} is missing, ambiguous, or unverified.`,
        };
      }
    }

    for (const clipTakeId of stageResult.outputClipTakeIds) {
      const locations = clipTakeLocations.get(clipTakeId) ?? [];

      if (locations.length !== 1) {
        return {
          cause: 'production-persistence-clip-take-unavailable',
          message: `Stage Result ${resultId} output ClipTake ${clipTakeId} is missing or ambiguous.`,
        };
      }

      const { clip, clipTake } = locations[0];
      const artifactMatches = artifactLocations.get(clipTake.artifactId) ?? [];

      if (
        !outputArtifactIds.has(clipTake.artifactId) ||
        artifactMatches.length !== 1 ||
        !doesClipSupportTakeMedia(clip, clipTake.mediaType) ||
        !doesClipTakeMatchArtifact(clipTake, artifactMatches[0])
      ) {
        return {
          cause: 'production-persistence-clip-take-invalid',
          message: `Stage Result ${resultId} output ClipTake ${clipTakeId} does not match one valid output Artifact and Clip.`,
        };
      }
    }
  }

  return undefined;
}

function replaceProject(
  result: AutoPatchProductionDriverResult,
  project: ProjectState,
): AutoPatchProductionDriverResult {
  return Object.freeze({ ...result, project }) as AutoPatchProductionDriverResult;
}

function failure(
  result: AutoPatchProductionDriverResult,
  project: ProjectState,
  reason: Extract<
    AutoPatchProductionPersistencePreparation,
    { canCommit: false }
  >['reason'],
  cause: string,
  message: string,
  historyEntry?: AutoPatchProductionRunHistoryEntry,
): Extract<
  AutoPatchProductionPersistencePreparation,
  { canCommit: false }
> {
  return Object.freeze({
    canCommit: false as const,
    cause,
    ...(historyEntry ? { historyEntry } : {}),
    message,
    project,
    reason,
    result,
    status: 'NOT_COMMITTABLE' as const,
  });
}

function indexById<T>(
  values: readonly T[],
  getId: (value: T) => string,
): Map<string, T[]> {
  const index = new Map<string, T[]>();

  values.forEach((value) => {
    const id = getId(value);
    index.set(id, [...(index.get(id) ?? []), value]);
  });

  return index;
}

function indexClipTakes(
  project: ProjectState,
): Map<string, Array<Readonly<{ clip: Clip; clipTake: ClipTake }>>> {
  const locations = project.tracks.flatMap((track) =>
    track.clips.flatMap((clip) =>
      (clip.clipTakes ?? []).map((clipTake) => ({ clip, clipTake })),
    ),
  );

  return indexById(locations, (location) => location.clipTake.clipTakeId);
}

function isValidSourceAvailability(
  value: unknown,
): value is GeneratedAudioCommitAvailabilityEvidence {
  return (
    typeof value === 'object' &&
    value !== null &&
    'availableArtifactIds' in value &&
    Array.isArray(value.availableArtifactIds) &&
    value.availableArtifactIds.every(
      (artifactId) =>
        typeof artifactId === 'string' &&
        artifactId.length > 0 &&
        artifactId.trim() === artifactId,
    ) &&
    new Set(value.availableArtifactIds).size ===
      value.availableArtifactIds.length &&
    'checkedAt' in value &&
    typeof value.checkedAt === 'string' &&
    !Number.isNaN(Date.parse(value.checkedAt))
  );
}
