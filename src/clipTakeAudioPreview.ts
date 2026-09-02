import { doesClipTakeMatchArtifact } from './clipTakeActivation';
import type {
  AudioArtifact,
  AudioClipTake,
  Clip,
  ProjectState,
  Track,
} from './types';

export type ClipTakeAudioPreviewFailureReason =
  | 'artifact-invalid'
  | 'clip-not-found'
  | 'source-unavailable'
  | 'take-not-audio'
  | 'take-not-found';

export type ClipTakeAudioPreviewResolution =
  | Readonly<{
      canPreview: true;
      plan: Readonly<{
        artifact: AudioArtifact;
        clip: Clip;
        descriptor: Readonly<{
          kind: 'generated';
          name: string;
          relativePath: string;
          sizeBytes: number;
          sourceId: string;
        }>;
        take: AudioClipTake;
        track: Track;
      }>;
    }>
  | Readonly<{
      canPreview: false;
      message: string;
      reason: ClipTakeAudioPreviewFailureReason;
    }>;

export function resolveClipTakeAudioPreview(
  project: ProjectState,
  clipId: string,
  clipTakeId: string,
): ClipTakeAudioPreviewResolution {
  const clipLocations = project.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => clip.id === clipId)
      .map((clip) => ({ clip, track })),
  );

  if (clipLocations.length !== 1) {
    return fail(
      'clip-not-found',
      `Clip Take preview target does not resolve uniquely: ${clipId}.`,
    );
  }

  const { clip, track } = clipLocations[0];
  const takeMatches = project.tracks
    .flatMap((candidateTrack) => candidateTrack.clips)
    .flatMap((candidateClip) => candidateClip.clipTakes ?? [])
    .filter((take) => take.clipTakeId === clipTakeId);

  if (
    takeMatches.length !== 1 ||
    !(clip.clipTakes ?? []).includes(takeMatches[0])
  ) {
    return fail(
      'take-not-found',
      `${clip.name} Clip Take does not resolve uniquely: ${clipTakeId}.`,
    );
  }

  const take = takeMatches[0];

  if (take.mediaType !== 'audio') {
    return fail(
      'take-not-audio',
      `${take.label} is a MIDI Take and cannot use Audio Preview.`,
    );
  }

  const artifactMatches = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === take.artifactId,
  );
  const artifact = artifactMatches.length === 1
    ? artifactMatches[0]
    : undefined;

  if (
    !artifact ||
    artifact.kind !== 'audio' ||
    !doesClipTakeMatchArtifact(take, artifact) ||
    artifact.file.extension.toLowerCase() !== '.wav' ||
    artifact.audio.mimeType !== 'audio/wav'
  ) {
    return fail(
      'artifact-invalid',
      `${take.label} does not resolve to one previewable WAV Artifact.`,
    );
  }

  const activeSourceFile =
    clip.activeClipTakeId === take.clipTakeId &&
    clip.sourceFile?.sourceId === artifact.artifactId
      ? clip.sourceFile
      : undefined;

  if (activeSourceFile && activeSourceFile.status !== 'available') {
    return fail(
      'source-unavailable',
      `${take.label} cannot be previewed because ${artifact.file.name} is ${formatUnavailableSourceStatus(activeSourceFile.status)}.`,
    );
  }

  return Object.freeze({
    canPreview: true as const,
    plan: Object.freeze({
      artifact,
      clip,
      descriptor: Object.freeze({
        kind: 'generated' as const,
        name: artifact.file.name,
        relativePath: artifact.file.relativePath,
        sizeBytes: artifact.file.sizeBytes,
        sourceId: artifact.artifactId,
      }),
      take,
      track,
    }),
  });
}

function formatUnavailableSourceStatus(
  status: 'missing' | 'moved' | 'unresolved',
): string {
  if (status === 'missing') {
    return 'missing from the Project Root';
  }

  if (status === 'moved') {
    return 'no longer at its saved location';
  }

  return 'not restored from the Project Root';
}

function fail(
  reason: ClipTakeAudioPreviewFailureReason,
  message: string,
): ClipTakeAudioPreviewResolution {
  return Object.freeze({
    canPreview: false as const,
    message,
    reason,
  });
}
