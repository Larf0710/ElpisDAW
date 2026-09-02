import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import { createStableAudio3SeedSequence } from './stableAudio3SeedVariations';
import type { StableAudio3StageDispatch } from './stableAudio3StageAdapter';
import type { Clip, PatchTab, ProjectState } from './types';

export type StableAudio3AudioToAudioTarget =
  | Readonly<{ clipId: string; kind: 'existing' }>
  | Readonly<{ clipId: string; kind: 'new'; trackId: string }>;

export type StableAudio3AudioToAudioContinuationPlan = Readonly<{
  outputTarget: StableAudio3AudioToAudioTarget;
  recipeFingerprint: string;
  seedSequence: readonly number[];
  sourceClipId: string;
  sourceClipTakeId: string;
}>;

export type StableAudio3AudioToAudioContinuationResolution =
  | Readonly<{
      ok: true;
      plan: StableAudio3AudioToAudioContinuationPlan;
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
    }>;

export function resolveStableAudio3AudioToAudioContinuation(
  project: ProjectState,
  patchTab: PatchTab,
  dispatch: StableAudio3StageDispatch,
): StableAudio3AudioToAudioContinuationResolution {
  const sourceLocation = findUniqueClip(project, dispatch.source.clipId);

  if (
    !sourceLocation ||
    sourceLocation.clip.activeClipTakeId !== dispatch.source.clipTakeId
  ) {
    return failure(
      'stable-audio-3-a2a-source-stale',
      'Stable Audio 3 A2A source Clip or Active Take changed before continuation planning.',
    );
  }

  const recipeFingerprint = createRecipeFingerprint(dispatch);
  const seedSequence = createStableAudio3SeedSequence(
    dispatch.parameters.seed,
    dispatch.parameters.takes,
  );
  const continuation = patchTab.generationContinuation;
  const canReuseContinuation =
    continuation?.kind === 'stable-audio-3-audio-to-audio' &&
    continuation.sourceClipId === dispatch.source.clipId &&
    continuation.sourceClipTakeId === dispatch.source.clipTakeId &&
    continuation.recipeFingerprint === recipeFingerprint;

  if (canReuseContinuation) {
    const targetLocation = findUniqueClip(project, continuation.outputClipId);

    if (targetLocation) {
      const collision = findSeedCollision(
        project,
        targetLocation.clip,
        seedSequence,
      );

      if (collision !== undefined) {
        return failure(
          'stable-audio-3-a2a-seed-duplicate',
          `Seed ${collision} already exists in the tracked SA3 A2A Clip. Choose a different Seed.`,
        );
      }

      return success({
        outputTarget: Object.freeze({
          clipId: continuation.outputClipId,
          kind: 'existing' as const,
        }),
        recipeFingerprint,
        seedSequence,
        sourceClipId: dispatch.source.clipId,
        sourceClipTakeId: dispatch.source.clipTakeId,
      });
    }
  }

  const sourceIsGeneratedA2A = isGeneratedA2ATake(
    project,
    dispatch.source.clipTakeId,
  );
  const sourceIsRawMixdown = sourceLocation.clip.type === 'mixdown';
  const shouldCreateBranch =
    sourceIsRawMixdown ||
    sourceIsGeneratedA2A ||
    (continuation?.kind === 'stable-audio-3-audio-to-audio' &&
      (!canReuseContinuation ||
        continuation.outputClipId !== dispatch.source.clipId));

  if (shouldCreateBranch) {
    const outputIdentity = sourceIsRawMixdown
      ? {
          clipId: `sa3-master-clip-${dispatch.attemptId}`,
          trackId: `sa3-master-track-${dispatch.attemptId}`,
        }
      : {
          clipId: `sa3-a2a-clip-${dispatch.attemptId}`,
          trackId: `sa3-a2a-track-${dispatch.attemptId}`,
        };
    return success({
      outputTarget: Object.freeze({
        clipId: outputIdentity.clipId,
        kind: 'new' as const,
        trackId: outputIdentity.trackId,
      }),
      recipeFingerprint,
      seedSequence,
      sourceClipId: dispatch.source.clipId,
      sourceClipTakeId: dispatch.source.clipTakeId,
    });
  }

  const collision = findSeedCollision(project, sourceLocation.clip, seedSequence);

  if (collision !== undefined) {
    return failure(
      'stable-audio-3-a2a-seed-duplicate',
      `Seed ${collision} already exists in the SA3 A2A source Clip. Choose a different Seed.`,
    );
  }

  return success({
    outputTarget: Object.freeze({
      clipId: dispatch.source.clipId,
      kind: 'existing' as const,
    }),
    recipeFingerprint,
    seedSequence,
    sourceClipId: dispatch.source.clipId,
    sourceClipTakeId: dispatch.source.clipTakeId,
  });
}

function createRecipeFingerprint(dispatch: StableAudio3StageDispatch): string {
  return JSON.stringify({
    durationSeconds: dispatch.parameters.durationSeconds,
    modelId: dispatch.execution.modelId,
    modelRevision: dispatch.execution.modelRevision,
    prompt: dispatch.parameters.prompt,
    providerId: dispatch.execution.providerId,
    strength: dispatch.parameters.strength,
    taskId: dispatch.execution.taskId,
  });
}

function findSeedCollision(
  project: ProjectState,
  clip: Clip,
  seedSequence: readonly number[],
): number | undefined {
  const artifactsById = new Map(
    (project.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact]),
  );
  const existingSeeds = new Set<number>();

  for (const take of clip.clipTakes ?? []) {
    const artifact = artifactsById.get(take.artifactId);

    if (
      take.mediaType === 'audio' &&
      artifact?.kind === 'audio' &&
      artifact.destination === 'stable-audio-3' &&
      artifact.provenance.providerId === STABLE_AUDIO_3_PROVIDER_ID &&
      artifact.provenance.modelId === STABLE_AUDIO_3_MODEL_ID &&
      artifact.provenance.modelRevision === STABLE_AUDIO_3_MODEL_REVISION &&
      artifact.provenance.taskId === STABLE_AUDIO_3_TASK_ID &&
      Number.isSafeInteger(artifact.provenance.seed)
    ) {
      existingSeeds.add(artifact.provenance.seed as number);
    }
  }

  return seedSequence.find((seed) => existingSeeds.has(seed));
}

function isGeneratedA2ATake(
  project: ProjectState,
  clipTakeId: string,
): boolean {
  const takeMatches = project.tracks.flatMap((track) =>
    track.clips.flatMap((clip) =>
      (clip.clipTakes ?? []).filter((take) => take.clipTakeId === clipTakeId),
    ),
  );
  const take = takeMatches[0];

  if (takeMatches.length !== 1 || !take) {
    return false;
  }

  const artifact = (project.artifacts ?? []).find(
    (candidate) => candidate.artifactId === take.artifactId,
  );

  return Boolean(
    artifact &&
      artifact.kind === 'audio' &&
      artifact.destination === 'stable-audio-3' &&
      artifact.provenance.providerId === STABLE_AUDIO_3_PROVIDER_ID &&
      artifact.provenance.taskId === STABLE_AUDIO_3_TASK_ID,
  );
}

function findUniqueClip(
  project: ProjectState,
  clipId: string,
): Readonly<{ clip: Clip }> | undefined {
  const matches = project.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => clip.id === clipId)
      .map((clip) => ({ clip })),
  );

  return matches.length === 1 ? matches[0] : undefined;
}

function success(
  input: StableAudio3AudioToAudioContinuationPlan,
): Extract<StableAudio3AudioToAudioContinuationResolution, { ok: true }> {
  return Object.freeze({
    ok: true as const,
    plan: Object.freeze({
      ...input,
      seedSequence: Object.freeze([...input.seedSequence]),
    }),
  });
}

function failure(
  cause: string,
  message: string,
): Extract<StableAudio3AudioToAudioContinuationResolution, { ok: false }> {
  return Object.freeze({ cause, message, ok: false as const });
}
