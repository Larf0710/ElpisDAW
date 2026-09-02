import { isSourceBackedAudioClip } from './audioClipSource';
import { createSynchronizedClipSourceFile } from './clipSourceSynchronization';
import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import type {
  Clip,
  ClipTake,
  ProjectArtifact,
  ProjectState,
} from './types';

export type ClipTakeActivationFailureReason =
  | 'artifact-invalid'
  | 'clip-not-found'
  | 'take-not-found'
  | 'timing-invalid'
  | 'target-media-mismatch';

export type ClipTakeActivationResult =
  | Readonly<{
      canActivate: true;
      clip: Clip;
      clipTake: ClipTake;
      project: ProjectState;
      status: 'ACTIVATED' | 'ALREADY_ACTIVE';
    }>
  | Readonly<{
      canActivate: false;
      message: string;
      reason: ClipTakeActivationFailureReason;
    }>;

export type ClipTakeActivationOptions = Readonly<{
  sourceAvailability?: GeneratedAudioCommitAvailabilityEvidence;
}>;

type ClipLocation = Readonly<{
  clip: Clip;
  clipIndex: number;
  trackIndex: number;
}>;

const audioClipTypes = new Set<Clip['type']>([
  'hum-audio',
  'instrument-audio',
  'arrangement',
  'vocal-audio',
  'ai-fill-audio',
  'mixdown',
  'master',
]);
const midiClipTypes = new Set<Clip['type']>([
  'midi-notes',
  'edited-midi',
]);

export function activateClipTake(
  project: ProjectState,
  clipId: string,
  clipTakeId: string,
  options: ClipTakeActivationOptions = {},
): ClipTakeActivationResult {
  const target = findUniqueClipLocation(project, clipId);

  if (!target) {
    return fail(
      'clip-not-found',
      `Clip Take activation target does not resolve uniquely: ${clipId}.`,
    );
  }

  const clipTake = findUniqueProjectClipTake(project, clipTakeId);

  if (
    !clipTake ||
    !(target.clip.clipTakes ?? []).some(
      (candidate) => candidate === clipTake,
    )
  ) {
    return fail(
      'take-not-found',
      `${target.clip.name} Clip Take does not resolve uniquely: ${clipTakeId}.`,
    );
  }

  if (!doesClipSupportTakeMedia(target.clip, clipTake.mediaType)) {
    return fail(
      'target-media-mismatch',
      `${target.clip.name} cannot activate a ${clipTake.mediaType} Clip Take.`,
    );
  }

  const artifact = findUniqueArtifact(project, clipTake.artifactId);

  if (!artifact || !doesClipTakeMatchArtifact(clipTake, artifact)) {
    return fail(
      'artifact-invalid',
      `${clipTake.label} does not resolve to one matching Project Artifact.`,
    );
  }

  const nextSourceFile =
    clipTake.mediaType === 'audio' && artifact.kind === 'audio'
      ? createSynchronizedClipSourceFile(
          artifact,
          target.clip.sourceFile,
          options.sourceAvailability,
        )
      : target.clip.sourceFile;

  if (
    clipTake.mediaType === 'audio' &&
    artifact.kind === 'audio' &&
    target.clip.audioTiming &&
    nextSourceFile &&
    !isSourceBackedAudioClip({
      ...target.clip,
      sourceFile: nextSourceFile,
    })
  ) {
    return fail(
      'timing-invalid',
      `${clipTake.label} cannot be activated because ${target.clip.name} retained Audio timing does not fit the selected Artifact.`,
    );
  }

  if (
    target.clip.activeClipTakeId === clipTake.clipTakeId &&
    nextSourceFile === target.clip.sourceFile
  ) {
    return Object.freeze({
      canActivate: true,
      clip: target.clip,
      clipTake,
      project,
      status: 'ALREADY_ACTIVE' as const,
    });
  }

  const nextClip: Clip = {
    ...target.clip,
    activeClipTakeId: clipTake.clipTakeId,
    ...(nextSourceFile ? { sourceFile: nextSourceFile } : {}),
    version: target.clip.version + 1,
  };
  const nextProject: ProjectState = {
    ...project,
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

  return Object.freeze({
    canActivate: true,
    clip: nextClip,
    clipTake,
    project: nextProject,
    status: 'ACTIVATED' as const,
  });
}

export function doesClipTakeMatchArtifact(
  clipTake: ClipTake,
  artifact: ProjectArtifact,
): boolean {
  if (clipTake.mediaType !== artifact.kind) {
    return false;
  }

  if (clipTake.sourceType === 'recording') {
    return artifact.kind === 'audio' && artifact.destination === 'recording';
  }

  if (clipTake.sourceType === 'job') {
    return (
      'sourceJobId' in artifact &&
      clipTake.sourceJobId === artifact.sourceJobId
    );
  }

  if (clipTake.sourceType === 'mixdown') {
    return (
      artifact.kind === 'audio' &&
      'sourceOperationId' in artifact &&
      clipTake.sourceOperationId === artifact.sourceOperationId
    );
  }

  if (clipTake.sourceType === 'stem-print') {
    return (
      artifact.kind === 'audio' &&
      artifact.destination === 'stem-print' &&
      'sourceOperationId' in artifact &&
      clipTake.sourceOperationId === artifact.sourceOperationId
    );
  }

  if (clipTake.sourceType === 'print-mix') {
    return (
      'sourceOperationId' in artifact &&
      artifact.sourceOperationId === clipTake.sourceOperationId &&
      ((artifact.kind === 'audio' && artifact.destination === 'print-mix') ||
        (artifact.kind === 'midi' &&
          'printMixProvenance' in artifact &&
          clipTake.mediaType === 'midi' &&
          clipTake.contentHash === artifact.contentHash))
    );
  }

  if (clipTake.sourceType === 'manual') {
    return (
      artifact.kind === 'midi' &&
      'sourceManualId' in artifact &&
      clipTake.sourceManualId === artifact.sourceManualId &&
      clipTake.contentHash === artifact.contentHash &&
      clipTake.revision === artifact.revision
    );
  }

  return clipTake.sourceType === 'edit' && (
    artifact.kind === 'midi' &&
    'sourceEditId' in artifact &&
    clipTake.sourceEditId === artifact.sourceEditId &&
    (clipTake.contentHash === undefined ||
      artifact.contentHash === undefined ||
      clipTake.contentHash === artifact.contentHash) &&
    (clipTake.revision === undefined ||
      artifact.revision === undefined ||
      clipTake.revision === artifact.revision)
  );
}

export function doesClipSupportTakeMedia(
  clip: Pick<Clip, 'type'>,
  mediaType: ClipTake['mediaType'],
): boolean {
  return mediaType === 'audio'
    ? audioClipTypes.has(clip.type)
    : midiClipTypes.has(clip.type);
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

function findUniqueArtifact(
  project: ProjectState,
  artifactId: string,
): ProjectArtifact | undefined {
  const matches = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === artifactId,
  );

  return matches.length === 1 ? matches[0] : undefined;
}

function fail(
  reason: ClipTakeActivationFailureReason,
  message: string,
): ClipTakeActivationResult {
  return Object.freeze({
    canActivate: false,
    message,
    reason,
  });
}
