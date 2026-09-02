import type { Clip, Track } from './types';
import { TICKS_PER_BEAT } from './workflow';

export const MINIMUM_RECORDING_DURATION_SECONDS = 0.25;

export type RecordingPlacementPlan =
  | Readonly<{
      blockingClip: Clip;
      canRecord: false;
      message: string;
      reason: 'clip-overlap';
    }>
  | Readonly<{
      canRecord: false;
      message: string;
      reason: 'insufficient-space' | 'timeline-end';
    }>
  | Readonly<{
      boundaryReason: 'next-clip' | 'timeline-end';
      canRecord: true;
      maximumDurationSeconds: number;
      maximumEndTick: number;
      startTick: number;
    }>;

export function createRecordingPlacementPlan({
  bpm,
  excludedClipId,
  startTick: startTickValue,
  totalTicks: totalTicksValue,
  track,
}: {
  bpm: number;
  excludedClipId?: string;
  startTick: number;
  totalTicks: number;
  track?: Track;
}): RecordingPlacementPlan {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new RangeError('Recording placement requires a positive Project BPM.');
  }

  if (!Number.isSafeInteger(startTickValue) || startTickValue < 0) {
    throw new RangeError('Recording placement requires a non-negative start tick.');
  }

  if (!Number.isSafeInteger(totalTicksValue) || totalTicksValue <= 0) {
    throw new RangeError('Recording placement requires a positive Timeline length.');
  }

  const startTick = startTickValue;
  const totalTicks = totalTicksValue;

  if (startTick >= totalTicks) {
    return {
      canRecord: false,
      message: 'Recording cannot begin at or beyond the Timeline end.',
      reason: 'timeline-end',
    };
  }

  const relevantClips = (track?.clips ?? []).filter(
    (clip) => clip.id !== excludedClipId,
  );
  const blockingClip = relevantClips.find(
    (clip) =>
      startTick >= clip.startTick &&
      startTick < clip.startTick + clip.lengthTicks,
  );

  if (blockingClip) {
    return {
      blockingClip,
      canRecord: false,
      message: `Recording blocked: the Playhead overlaps ${blockingClip.name} on ${track?.name ?? 'the target Track'}.`,
      reason: 'clip-overlap',
    };
  }

  const nextClipStartTick = relevantClips
    .map((clip) => clip.startTick)
    .filter((clipStartTick) => clipStartTick > startTick)
    .sort((left, right) => left - right)[0];
  const maximumEndTick = Math.min(
    totalTicks,
    nextClipStartTick ?? totalTicks,
  );
  const maximumLengthTicks = maximumEndTick - startTick;

  if (maximumLengthTicks <= 0) {
    return {
      canRecord: false,
      message: 'Recording has no available Timeline space at the Playhead.',
      reason: 'timeline-end',
    };
  }

  const maximumDurationSeconds =
    (maximumLengthTicks / TICKS_PER_BEAT) * (60 / bpm);

  if (maximumDurationSeconds < MINIMUM_RECORDING_DURATION_SECONDS) {
    return {
      canRecord: false,
      message: `Recording needs at least ${MINIMUM_RECORDING_DURATION_SECONDS} seconds of clear Timeline space.`,
      reason: 'insufficient-space',
    };
  }

  return {
    boundaryReason:
      nextClipStartTick !== undefined && nextClipStartTick <= totalTicks
        ? 'next-clip'
        : 'timeline-end',
    canRecord: true,
    maximumDurationSeconds,
    maximumEndTick,
    startTick,
  };
}
