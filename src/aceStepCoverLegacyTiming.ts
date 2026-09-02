import { doesClipTakeMatchArtifact } from './clipTakeActivation';
import {
  AUDIO_DURATION_EPSILON_SECONDS,
  createFullSourceAudioClipTiming,
  secondsToTimelineTicks,
} from './audioClipTiming';
import type { AudioArtifact, Clip, ProjectArtifact, Track } from './types';

export function normalizeLegacyAceStepCoverClipTiming(
  tracks: readonly Track[],
  artifacts: readonly ProjectArtifact[],
  bpm: number,
): Track[] {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return [...tracks];
  }

  return tracks.map((track) => {
    let changed = false;
    const clips = track.clips.map((clip) => {
      const normalized = normalizeLegacyClip(clip, artifacts, bpm);
      changed ||= normalized !== clip;
      return normalized;
    });

    return changed ? { ...track, clips } : track;
  });
}

function normalizeLegacyClip(
  clip: Clip,
  artifacts: readonly ProjectArtifact[],
  bpm: number,
): Clip {
  if (
    clip.generatedBy !== 'ACE Cover' ||
    clip.audioTiming !== undefined ||
    !clip.activeClipTakeId
  ) {
    return clip;
  }

  const activeTakes = (clip.clipTakes ?? []).filter(
    (take) => take.clipTakeId === clip.activeClipTakeId,
  );
  if (activeTakes.length !== 1 || activeTakes[0].mediaType !== 'audio') {
    return clip;
  }

  const matchingArtifacts = artifacts.filter(
    (artifact): artifact is AudioArtifact =>
      artifact.artifactId === activeTakes[0].artifactId &&
      artifact.kind === 'audio' &&
      artifact.destination === 'ace-step' &&
      artifact.provenance.taskId === 'audio-cover' &&
      doesClipTakeMatchArtifact(activeTakes[0], artifact),
  );
  if (matchingArtifacts.length !== 1) {
    return clip;
  }

  const artifact = matchingArtifacts[0];
  if (!isMatchingLegacySourceFile(clip, artifact)) {
    return clip;
  }

  return {
    ...clip,
    audioTiming: createFullSourceAudioClipTiming(artifact.audio.durationSeconds),
    lengthTicks: secondsToTimelineTicks(artifact.audio.durationSeconds, bpm),
  };
}

function isMatchingLegacySourceFile(clip: Clip, artifact: AudioArtifact): boolean {
  const sourceFile = clip.sourceFile;

  return Boolean(
    sourceFile &&
      sourceFile.sourceId === artifact.artifactId &&
      sourceFile.relativePath === artifact.file.relativePath &&
      sourceFile.name === artifact.file.name &&
      sourceFile.sizeBytes === artifact.file.sizeBytes &&
      typeof sourceFile.durationSeconds === 'number' &&
      Number.isFinite(sourceFile.durationSeconds) &&
      Math.abs(sourceFile.durationSeconds - artifact.audio.durationSeconds) <=
        AUDIO_DURATION_EPSILON_SECONDS,
  );
}
