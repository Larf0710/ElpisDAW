import type { AudioClipTiming, Clip, ProjectState, Track } from './types';
import { TICKS_PER_BEAT } from './workflow';

export const AUDIO_DURATION_EPSILON_SECONDS = 0.01;

export type ProjectBpmUpdate =
  | {
      canChange: true;
      project: ProjectState;
    }
  | {
      canChange: false;
      message: string;
    };

export function createFullSourceAudioClipTiming(durationSeconds: number): AudioClipTiming {
  assertFinitePositiveNumber(durationSeconds, 'Audio source duration');

  return {
    timeBase: 'absolute-seconds',
    sourceStartSeconds: 0,
    sourceEndSeconds: durationSeconds,
  };
}

export function normalizeAudioClipTiming(value: unknown, clipName: string): AudioClipTiming {
  if (!isRecord(value) || value.timeBase !== 'absolute-seconds') {
    throw new Error(`Clip "${clipName}" has invalid audio timing metadata.`);
  }

  const { sourceStartSeconds, sourceEndSeconds } = value;

  if (
    !isFiniteNonNegativeNumber(sourceStartSeconds) ||
    !isFinitePositiveNumber(sourceEndSeconds) ||
    sourceEndSeconds <= sourceStartSeconds
  ) {
    throw new Error(`Clip "${clipName}" has an invalid audio source range.`);
  }

  return {
    timeBase: 'absolute-seconds',
    sourceStartSeconds,
    sourceEndSeconds,
  };
}

export function normalizeClipAudioTimingMetadata(
  clip: Clip & Record<string, unknown>,
  sourceFile: Clip['sourceFile'],
): Clip['audioTiming'] {
  const clipName = typeof clip.name === 'string' && clip.name.trim() ? clip.name.trim() : 'Unnamed Clip';
  const hasExplicitAudioTiming =
    Object.prototype.hasOwnProperty.call(clip, 'audioTiming') && clip.audioTiming !== undefined;

  if (!hasExplicitAudioTiming) {
    return clip.type === 'hum-audio' &&
      clip.generatedBy === 'Audio Import' &&
      isFinitePositiveNumber(sourceFile?.durationSeconds)
      ? createFullSourceAudioClipTiming(sourceFile.durationSeconds)
      : undefined;
  }

  const audioTiming = normalizeAudioClipTiming(clip.audioTiming, clipName);

  if (!isFinitePositiveNumber(sourceFile?.durationSeconds)) {
    throw new Error(`Clip "${clipName}" audio timing requires source duration metadata.`);
  }

  if (!doesAudioClipTimingFitSourceDuration(audioTiming, sourceFile.durationSeconds)) {
    throw new Error(`Clip "${clipName}" audio source range exceeds its saved source duration.`);
  }

  return audioTiming;
}

export function secondsToTimelineTicks(seconds: number, bpm: number): number {
  assertFinitePositiveNumber(seconds, 'Audio duration');

  return Math.max(1, secondsToTimelineTickOffset(seconds, bpm));
}

export function secondsToTimelineTickOffset(seconds: number, bpm: number): number {
  assertFiniteNonNegativeNumber(seconds, 'Audio position');
  assertFinitePositiveNumber(bpm, 'Project BPM');

  return Math.max(0, Math.round((seconds * bpm * TICKS_PER_BEAT) / 60));
}

export function timelineTicksToSeconds(ticks: number, bpm: number): number {
  assertFiniteNonNegativeNumber(ticks, 'Timeline tick length');
  assertFinitePositiveNumber(bpm, 'Project BPM');

  return (ticks * 60) / (bpm * TICKS_PER_BEAT);
}

export function getAudioClipSourceDurationSeconds(audioTiming: AudioClipTiming): number {
  return audioTiming.sourceEndSeconds - audioTiming.sourceStartSeconds;
}

export function getEffectiveAudioClipDurationSeconds(
  audioTiming: AudioClipTiming,
  lengthTicks: number,
  bpm: number,
): number {
  const sourceDuration = getAudioClipSourceDurationSeconds(audioTiming);
  // The Timeline display is tick-quantized; an absolute source endpoint is not.
  // A shorter explicit Clip span still limits playback and export as before.
  return lengthTicks === secondsToTimelineTicks(sourceDuration, bpm)
    ? sourceDuration
    : timelineTicksToSeconds(lengthTicks, bpm);
}

export function doesAudioClipTimingFitSourceDuration(
  audioTiming: AudioClipTiming,
  sourceDurationSeconds: number,
): boolean {
  assertFinitePositiveNumber(sourceDurationSeconds, 'Audio source duration');

  return audioTiming.sourceEndSeconds <= sourceDurationSeconds + AUDIO_DURATION_EPSILON_SECONDS;
}

export function createAudioTimebaseBpmProjectUpdate(project: ProjectState, nextBpm: number): ProjectBpmUpdate {
  assertFinitePositiveNumber(nextBpm, 'Project BPM');

  if (nextBpm === project.bpm) {
    return { canChange: true, project };
  }

  const changedClipIds = new Set<string>();
  const tracks = project.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (!clip.audioTiming) {
        return clip;
      }

      changedClipIds.add(clip.id);

      return {
        ...clip,
        lengthTicks: secondsToTimelineTicks(getAudioClipSourceDurationSeconds(clip.audioTiming), nextBpm),
      };
    }),
  }));

  const unresolvedImportedClip = tracks
    .flatMap((track) => track.clips)
    .find((clip) => requiresAudioTimingForBpmChange(clip) && !clip.audioTiming);

  if (unresolvedImportedClip) {
    return {
      canChange: false,
      message: `BPM change blocked: ${unresolvedImportedClip.name} does not have reliable source timing. Re-import the audio before changing BPM.`,
    };
  }

  for (const track of tracks) {
    const conflictMessage = validateChangedAudioClipPlacement(track, project.totalTicks, changedClipIds);

    if (conflictMessage) {
      return { canChange: false, message: conflictMessage };
    }
  }

  return {
    canChange: true,
    project: {
      ...project,
      bpm: nextBpm,
      tracks,
    },
  };
}

function requiresAudioTimingForBpmChange(clip: Clip): boolean {
  return clip.type === 'hum-audio' && clip.generatedBy === 'Audio Import';
}

function validateChangedAudioClipPlacement(
  track: Track,
  totalTicks: number,
  changedClipIds: ReadonlySet<string>,
): string | undefined {
  const clipsByStart = [...track.clips].sort(
    (left, right) => left.startTick - right.startTick || left.id.localeCompare(right.id),
  );

  for (const clip of clipsByStart) {
    if (changedClipIds.has(clip.id) && clip.startTick + clip.lengthTicks > totalTicks) {
      return `BPM change blocked: ${clip.name} would extend beyond Timeline Length.`;
    }
  }

  for (let leftIndex = 0; leftIndex < clipsByStart.length; leftIndex += 1) {
    const left = clipsByStart[leftIndex];
    const leftEndTick = left.startTick + left.lengthTicks;

    for (let rightIndex = leftIndex + 1; rightIndex < clipsByStart.length; rightIndex += 1) {
      const right = clipsByStart[rightIndex];

      if (right.startTick >= leftEndTick) {
        break;
      }

      if (changedClipIds.has(left.id) || changedClipIds.has(right.id)) {
        return `BPM change blocked: ${left.name} would overlap ${right.name} on ${track.name}.`;
      }
    }
  }

  return undefined;
}

function assertFiniteNonNegativeNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
}

function assertFinitePositiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number.`);
  }
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
