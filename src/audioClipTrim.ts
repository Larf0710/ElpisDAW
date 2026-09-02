import {
  AUDIO_DURATION_EPSILON_SECONDS,
  doesAudioClipTimingFitSourceDuration,
  secondsToTimelineTickOffset,
  secondsToTimelineTicks,
  timelineTicksToSeconds,
} from './audioClipTiming';
import {
  isSourceBackedAudioClip,
  type SourceBackedAudioClip,
} from './audioClipSource';
import { doesTickRangeOverlapTrack } from './timelineClipPlacement';
import type { Track } from './types';

export type AudioClipTrimUpdate =
  | {
      canTrim: true;
      clip: SourceBackedAudioClip;
      track: Track;
      tracks: Track[];
    }
  | {
      canTrim: false;
      message: string;
      reason:
        | 'clip-not-found'
        | 'not-source-backed'
        | 'invalid-position'
        | 'minimum-length'
        | 'timeline-bounds'
        | 'source-bounds'
        | 'clip-overlap';
    };

export function createAudioClipRightTrimUpdate(
  tracks: Track[],
  clipId: string,
  targetEndTick: number,
  totalTicks: number,
  bpm: number,
): AudioClipTrimUpdate {
  const track = tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((candidate) => candidate.id === clipId);

  if (!track || !clip) {
    return {
      canTrim: false,
      message: 'Trim blocked: the selected clip was not found.',
      reason: 'clip-not-found',
    };
  }

  if (!isSourceBackedAudioClip(clip)) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} does not have reliable source timing.`,
      reason: 'not-source-backed',
    };
  }

  if (!Number.isFinite(targetEndTick) || !isFinitePositiveNumber(bpm)) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} received an invalid Timeline position.`,
      reason: 'invalid-position',
    };
  }

  const endTick = Math.round(targetEndTick);
  const lengthTicks = endTick - clip.startTick;

  if (lengthTicks < 1) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} must remain at least one tick long.`,
      reason: 'minimum-length',
    };
  }

  if (endTick > totalTicks) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} must stay inside the Timeline length.`,
      reason: 'timeline-bounds',
    };
  }

  const availableSourceDurationSeconds = clip.sourceFile.durationSeconds - clip.audioTiming.sourceStartSeconds;
  const maxSourceLengthTicks =
    availableSourceDurationSeconds > 0 ? secondsToTimelineTicks(availableSourceDurationSeconds, bpm) : 0;
  const requestedSourceEndSeconds = lengthTicks === maxSourceLengthTicks
    ? clip.sourceFile.durationSeconds
    : clip.audioTiming.sourceStartSeconds + timelineTicksToSeconds(lengthTicks, bpm);
  const requestedAudioTiming = {
    ...clip.audioTiming,
    sourceEndSeconds: requestedSourceEndSeconds,
  };

  if (
    lengthTicks > maxSourceLengthTicks ||
    !doesAudioClipTimingFitSourceDuration(requestedAudioTiming, clip.sourceFile.durationSeconds)
  ) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} cannot extend beyond ${clip.sourceFile.name}.`,
      reason: 'source-bounds',
    };
  }

  if (doesTickRangeOverlapTrack(clip.startTick, endTick, track, clip.id)) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} would overlap another clip on ${track.name}.`,
      reason: 'clip-overlap',
    };
  }

  const trimmedClip: SourceBackedAudioClip = {
    ...clip,
    lengthTicks,
    audioTiming: {
      ...clip.audioTiming,
      sourceEndSeconds: Math.min(requestedSourceEndSeconds, clip.sourceFile.durationSeconds),
    },
  };
  const trimmedTrack = {
    ...track,
    clips: track.clips.map((candidate) => (candidate.id === clip.id ? trimmedClip : candidate)),
  };

  return {
    canTrim: true,
    clip: trimmedClip,
    track: trimmedTrack,
    tracks: tracks.map((candidate) => (candidate.id === track.id ? trimmedTrack : candidate)),
  };
}

export function createAudioClipLeftTrimUpdate(
  tracks: Track[],
  clipId: string,
  targetStartTick: number,
  totalTicks: number,
  bpm: number,
): AudioClipTrimUpdate {
  const track = tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((candidate) => candidate.id === clipId);

  if (!track || !clip) {
    return {
      canTrim: false,
      message: 'Trim blocked: the selected clip was not found.',
      reason: 'clip-not-found',
    };
  }

  if (!isSourceBackedAudioClip(clip)) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} does not have reliable source timing.`,
      reason: 'not-source-backed',
    };
  }

  if (!Number.isFinite(targetStartTick) || !isFinitePositiveNumber(bpm)) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} received an invalid Timeline position.`,
      reason: 'invalid-position',
    };
  }

  const startTick = Math.round(targetStartTick);
  const endTick = clip.startTick + clip.lengthTicks;
  const lengthTicks = endTick - startTick;

  if (lengthTicks < 1) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} must remain at least one tick long.`,
      reason: 'minimum-length',
    };
  }

  if (startTick < 0 || endTick > totalTicks) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} must stay inside the Timeline length.`,
      reason: 'timeline-bounds',
    };
  }

  const startDeltaTicks = startTick - clip.startTick;
  // Move the existing source edge; the opposite edge may not fall on an exact tick.
  const requestedSourceStartSeconds = clip.audioTiming.sourceStartSeconds +
    Math.sign(startDeltaTicks) * timelineTicksToSeconds(Math.abs(startDeltaTicks), bpm);
  const maxSourceLengthTicks = clip.lengthTicks +
    secondsToTimelineTickOffset(clip.audioTiming.sourceStartSeconds, bpm);

  if (
    lengthTicks > maxSourceLengthTicks ||
    requestedSourceStartSeconds < -AUDIO_DURATION_EPSILON_SECONDS
  ) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} cannot extend before the beginning of ${clip.sourceFile.name}.`,
      reason: 'source-bounds',
    };
  }

  if (doesTickRangeOverlapTrack(startTick, endTick, track, clip.id)) {
    return {
      canTrim: false,
      message: `Trim blocked: ${clip.name} would overlap another clip on ${track.name}.`,
      reason: 'clip-overlap',
    };
  }

  const trimmedClip: SourceBackedAudioClip = {
    ...clip,
    startTick,
    lengthTicks,
    audioTiming: {
      ...clip.audioTiming,
      sourceStartSeconds: Math.max(0, requestedSourceStartSeconds),
    },
  };
  const trimmedTrack = {
    ...track,
    clips: track.clips.map((candidate) => (candidate.id === clip.id ? trimmedClip : candidate)),
  };

  return {
    canTrim: true,
    clip: trimmedClip,
    track: trimmedTrack,
    tracks: tracks.map((candidate) => (candidate.id === track.id ? trimmedTrack : candidate)),
  };
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
