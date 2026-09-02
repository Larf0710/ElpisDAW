import { doesClipTakeMatchArtifact } from './clipTakeActivation';
import { createSynchronizedClipSourceFile } from './clipSourceSynchronization';
import type {
  AudioArtifact,
  Clip,
  ClipTake,
  ProjectArtifact,
  ProjectState,
} from './types';

export type ClipTakeRemovalMode =
  | 'project-only'
  | 'project-and-audio-file';

export type ClipTakeRemovalFailureReason =
  | 'active-take-confirmation-required'
  | 'artifact-invalid'
  | 'artifact-still-referenced'
  | 'clip-not-found'
  | 'take-not-found'
  | 'target-not-audio';

export type ClipTakeRemovalRequest = Readonly<{
  clipId: string;
  clipTakeId: string;
  confirmActiveTakeRemoval?: boolean;
  mode: ClipTakeRemovalMode;
}>;

export type AudioFileDeletionDescriptor = Readonly<{
  artifactId: string;
  extension: string;
  name: string;
  relativePath: string;
  sizeBytes: number;
  storageKind: 'generated' | 'recording';
}>;

export type ClipTakeRemovalFileAction =
  | Readonly<{ action: 'preserve' }>
  | Readonly<{
      action: 'delete';
      descriptor: AudioFileDeletionDescriptor;
    }>;

export type ClipTakeRemovalResult =
  | Readonly<{
      artifactDisposition: 'preserved-shared' | 'removed' | 'unresolved';
      canRemove: true;
      directDescendantArtifactIds: readonly string[];
      fileAction: ClipTakeRemovalFileAction;
      mode: ClipTakeRemovalMode;
      nextActiveClipTakeId?: string;
      projectAfterRemoval: ProjectState;
      removedArtifact?: ProjectArtifact;
      removedClipTake: ClipTake;
      status: 'FILE_DELETION_REQUIRED' | 'READY_TO_REMOVE';
      wasActive: boolean;
    }>
  | Readonly<{
      canRemove: false;
      message: string;
      reason: ClipTakeRemovalFailureReason;
    }>;

export type ActiveClipTakeRemovalConfirmationCopy = Readonly<{
  message: string;
  preservationDetail: string;
}>;

type ClipLocation = Readonly<{
  clip: Clip;
  clipIndex: number;
  trackIndex: number;
}>;

export function createActiveClipTakeRemovalConfirmationCopy(
  clipTake: ClipTake,
): ActiveClipTakeRemovalConfirmationCopy {
  return clipTake.mediaType === 'audio'
    ? Object.freeze({
        message: `${clipTake.label} is Active. Remove it from the Project while preserving its physical Audio file?`,
        preservationDetail: 'The physical Audio file will be preserved.',
      })
    : Object.freeze({
        message: `${clipTake.label} is Active. Remove it from the Project?`,
        preservationDetail:
          'This MIDI Take does not reference a physical Audio file.',
      });
}

export function planClipTakeRemoval(
  project: ProjectState,
  request: ClipTakeRemovalRequest,
): ClipTakeRemovalResult {
  const target = findUniqueClipLocation(project, request.clipId);

  if (!target) {
    return fail(
      'clip-not-found',
      `Clip Take removal target does not resolve uniquely: ${request.clipId}.`,
    );
  }

  const clipTake = findUniqueProjectClipTake(project, request.clipTakeId);

  if (
    !clipTake ||
    !(target.clip.clipTakes ?? []).some((candidate) => candidate === clipTake)
  ) {
    return fail(
      'take-not-found',
      `${target.clip.name} Clip Take does not resolve uniquely: ${request.clipTakeId}.`,
    );
  }

  const wasActive = target.clip.activeClipTakeId === clipTake.clipTakeId;

  if (wasActive && request.confirmActiveTakeRemoval !== true) {
    return fail(
      'active-take-confirmation-required',
      `${clipTake.label} is Active and requires explicit removal confirmation.`,
    );
  }

  if (
    request.mode === 'project-and-audio-file' &&
    clipTake.mediaType !== 'audio'
  ) {
    return fail(
      'target-not-audio',
      `${clipTake.label} does not own an Audio file.`,
    );
  }

  const artifact = findMatchingArtifact(project, clipTake);
  const isArtifactShared = project.tracks.some((track) =>
    track.clips.some((clip) =>
      (clip.clipTakes ?? []).some(
        (candidate) =>
          candidate !== clipTake &&
          candidate.artifactId === clipTake.artifactId,
      ),
    ),
  );

  if (request.mode === 'project-and-audio-file') {
    if (!artifact || artifact.kind !== 'audio') {
      return fail(
        'artifact-invalid',
        `${clipTake.label} does not resolve to one matching Audio Artifact.`,
      );
    }

    if (isArtifactShared) {
      return fail(
        'artifact-still-referenced',
        `${clipTake.label} Audio Artifact is still referenced by another Clip Take.`,
      );
    }
  }

  const remainingClipTakes = (target.clip.clipTakes ?? []).filter(
    (candidate) => candidate !== clipTake,
  );
  const nextActiveClipTakeId = resolveNextActiveClipTakeId(
    target.clip,
    clipTake,
    remainingClipTakes,
  );
  const nextActiveClipTake = remainingClipTakes.find(
    (candidate) => candidate.clipTakeId === nextActiveClipTakeId,
  );
  const nextActiveAudioArtifact =
    nextActiveClipTake?.mediaType === 'audio'
      ? findMatchingArtifact(project, nextActiveClipTake)
      : undefined;

  if (
    nextActiveClipTake?.mediaType === 'audio' &&
    nextActiveAudioArtifact?.kind !== 'audio'
  ) {
    return fail(
      'artifact-invalid',
      `${nextActiveClipTake.label} fallback does not resolve to one matching Audio Artifact.`,
    );
  }

  const nextClip = createClipAfterTakeRemoval(
    target.clip,
    remainingClipTakes,
    nextActiveClipTakeId,
    nextActiveAudioArtifact?.kind === 'audio'
      ? nextActiveAudioArtifact
      : undefined,
    clipTake,
  );
  const canRemoveArtifact = Boolean(artifact && !isArtifactShared);
  const removedArtifact = canRemoveArtifact ? artifact : undefined;
  const projectAfterRemoval: ProjectState = {
    ...project,
    ...(removedArtifact
      ? {
          artifacts: (project.artifacts ?? []).filter(
            (candidate) => candidate !== removedArtifact,
          ),
        }
      : {}),
    tracks: project.tracks.map((track, trackIndex) =>
      trackIndex === target.trackIndex
        ? {
            ...track,
            clips: track.clips.map((clip, clipIndex) =>
              clipIndex === target.clipIndex ? nextClip : clip,
            ),
          }
        : track,
    ),
  };
  const directDescendantArtifactIds = Object.freeze(
    (project.artifacts ?? [])
      .filter(
        (candidate) =>
          candidate !== artifact &&
          (candidate.lineage.parentArtifactIds.includes(clipTake.artifactId) ||
            candidate.lineage.parentClipTakeIds.includes(
              clipTake.clipTakeId,
            )),
      )
      .map((candidate) => candidate.artifactId),
  );
  const artifactDisposition = removedArtifact
    ? 'removed'
    : isArtifactShared
      ? 'preserved-shared'
      : 'unresolved';
  const fileAction =
    request.mode === 'project-and-audio-file'
      ? Object.freeze({
          action: 'delete' as const,
          descriptor: createAudioFileDeletionDescriptor(
            removedArtifact as AudioArtifact,
          ),
        })
      : Object.freeze({ action: 'preserve' as const });

  return Object.freeze({
    artifactDisposition,
    canRemove: true as const,
    directDescendantArtifactIds,
    fileAction,
    mode: request.mode,
    ...(nextActiveClipTakeId ? { nextActiveClipTakeId } : {}),
    projectAfterRemoval,
    ...(removedArtifact ? { removedArtifact } : {}),
    removedClipTake: clipTake,
    status:
      request.mode === 'project-and-audio-file'
        ? ('FILE_DELETION_REQUIRED' as const)
        : ('READY_TO_REMOVE' as const),
    wasActive,
  });
}

function createClipAfterTakeRemoval(
  clip: Clip,
  remainingClipTakes: ClipTake[],
  nextActiveClipTakeId: string | undefined,
  nextActiveAudioArtifact: AudioArtifact | undefined,
  removedClipTake: ClipTake,
): Clip {
  const {
    activeClipTakeId: _activeClipTakeId,
    clipTakes: _clipTakes,
    sourceFile: currentSourceFile,
    ...clipWithoutTakeState
  } = clip;
  const nextSourceFile = nextActiveAudioArtifact
    ? createSynchronizedClipSourceFile(
        nextActiveAudioArtifact,
        currentSourceFile,
      )
    : removedClipTake.mediaType === 'audio' &&
        currentSourceFile?.sourceId === removedClipTake.artifactId
      ? undefined
      : currentSourceFile;

  return {
    ...clipWithoutTakeState,
    ...(remainingClipTakes.length > 0
      ? {
          clipTakes: remainingClipTakes,
          ...(nextActiveClipTakeId ? { activeClipTakeId: nextActiveClipTakeId } : {}),
        }
      : {}),
    ...(nextSourceFile ? { sourceFile: nextSourceFile } : {}),
    version: clip.version + 1,
  };
}

function resolveNextActiveClipTakeId(
  clip: Clip,
  removedClipTake: ClipTake,
  remainingClipTakes: ClipTake[],
): string | undefined {
  if (remainingClipTakes.length === 0) {
    return undefined;
  }

  if (clip.activeClipTakeId !== removedClipTake.clipTakeId) {
    return remainingClipTakes.some(
      (candidate) => candidate.clipTakeId === clip.activeClipTakeId,
    )
      ? clip.activeClipTakeId
      : remainingClipTakes[remainingClipTakes.length - 1]?.clipTakeId;
  }

  const removedIndex = (clip.clipTakes ?? []).indexOf(removedClipTake);
  return (
    remainingClipTakes[Math.max(0, removedIndex - 1)] ??
    remainingClipTakes[0]
  )?.clipTakeId;
}

function createAudioFileDeletionDescriptor(
  artifact: AudioArtifact,
): AudioFileDeletionDescriptor {
  return Object.freeze({
    artifactId: artifact.artifactId,
    extension: artifact.file.extension,
    name: artifact.file.name,
    relativePath: artifact.file.relativePath,
    sizeBytes: artifact.file.sizeBytes,
    storageKind:
      artifact.destination === 'recording' ? 'recording' : 'generated',
  });
}

function findUniqueClipLocation(
  project: ProjectState,
  clipId: string,
): ClipLocation | undefined {
  const matches: ClipLocation[] = [];

  project.tracks.forEach((track, trackIndex) => {
    track.clips.forEach((clip, clipIndex) => {
      if (clip.id === clipId) {
        matches.push({ clip, clipIndex, trackIndex });
      }
    });
  });

  return matches.length === 1 ? matches[0] : undefined;
}

function findUniqueProjectClipTake(
  project: ProjectState,
  clipTakeId: string,
): ClipTake | undefined {
  const matches = project.tracks
    .flatMap((track) => track.clips)
    .flatMap((clip) => clip.clipTakes ?? [])
    .filter((clipTake) => clipTake.clipTakeId === clipTakeId);

  return matches.length === 1 ? matches[0] : undefined;
}

function findMatchingArtifact(
  project: ProjectState,
  clipTake: ClipTake,
): ProjectArtifact | undefined {
  const matches = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === clipTake.artifactId,
  );

  return matches.length === 1 &&
    doesClipTakeMatchArtifact(clipTake, matches[0])
    ? matches[0]
    : undefined;
}

function fail(
  reason: ClipTakeRemovalFailureReason,
  message: string,
): ClipTakeRemovalResult {
  return Object.freeze({
    canRemove: false as const,
    message,
    reason,
  });
}
