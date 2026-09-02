import { TICKS_PER_BEAT } from './workflow';
import type { CountInBars } from './types';
import { secondsToTimelineTickOffset } from './audioClipTiming';

export const RECORDING_BPM_MIN = 40;
export const RECORDING_BPM_MAX = 240;
export const RECORDING_BEATS_PER_BAR = 4;
export const countInBarOptions = [0, 1, 2] as const satisfies readonly CountInBars[];

export type RecordingTimingRequest = Readonly<{
  bpm: number;
  countInBars: CountInBars;
  recordStartTick: number;
}>;

export type MetronomeClickPlan = Readonly<{
  accented: boolean;
  barIndex: number;
  beatInBar: number;
  offsetSeconds: number;
  phase: 'count-in' | 'recording';
  timelineBeatIndex: number;
}>;

export type RecordingTimingPlan = Readonly<{
  beatDurationSeconds: number;
  beatsPerBar: number;
  bpm: number;
  countInBars: CountInBars;
  countInBeats: number;
  countInClicks: readonly MetronomeClickPlan[];
  countInDurationSeconds: number;
  recordStartTick: number;
  recordingCycleClicks: readonly MetronomeClickPlan[];
  recordingStartOffsetSeconds: number;
}>;

export function createRecordingTimingPlan({
  bpm,
  countInBars,
  recordStartTick,
}: RecordingTimingRequest): RecordingTimingPlan {
  validateBpm(bpm);
  validateCountInBars(countInBars);
  validateRecordStartTick(recordStartTick);

  const beatDurationSeconds = 60 / bpm;
  const countInBeats = countInBars * RECORDING_BEATS_PER_BAR;
  const countInDurationSeconds = countInBeats * beatDurationSeconds;
  const countInStartTick = recordStartTick - countInBeats * TICKS_PER_BEAT;
  const countInClicks = createClickSequence({
    beatCount: countInBeats,
    beatDurationSeconds,
    phase: 'count-in',
    runtimeStartTick: countInStartTick,
    sequenceStartTick: countInStartTick,
  });
  const recordingCycleClicks = createClickSequence({
    beatCount: RECORDING_BEATS_PER_BAR,
    beatDurationSeconds,
    phase: 'recording',
    runtimeStartTick: countInStartTick,
    sequenceStartTick: recordStartTick,
  });

  return Object.freeze({
    beatDurationSeconds,
    beatsPerBar: RECORDING_BEATS_PER_BAR,
    bpm,
    countInBars,
    countInBeats,
    countInClicks,
    countInDurationSeconds,
    recordStartTick,
    recordingCycleClicks,
    recordingStartOffsetSeconds: countInDurationSeconds,
  });
}

export function getRecordingPlayheadTick({
  bpm,
  elapsedSeconds,
  maximumEndTick,
  startTick,
}: {
  bpm: number;
  elapsedSeconds: number;
  maximumEndTick: number;
  startTick: number;
}): number {
  validateBpm(bpm);
  validateRecordStartTick(startTick);

  if (!Number.isSafeInteger(maximumEndTick) || maximumEndTick < startTick) {
    throw new RangeError(
      'Recording Playhead maximum end tick must be at or after the start tick.',
    );
  }

  return Math.min(
    maximumEndTick,
    startTick + secondsToTimelineTickOffset(elapsedSeconds, bpm),
  );
}

function createClickSequence({
  beatCount,
  beatDurationSeconds,
  phase,
  runtimeStartTick,
  sequenceStartTick,
}: {
  beatCount: number;
  beatDurationSeconds: number;
  phase: MetronomeClickPlan['phase'];
  runtimeStartTick: number;
  sequenceStartTick: number;
}): readonly MetronomeClickPlan[] {
  if (beatCount === 0) {
    return Object.freeze([]);
  }

  const firstTimelineBeatIndex = Math.ceil(sequenceStartTick / TICKS_PER_BEAT);

  return Object.freeze(
    Array.from({ length: beatCount }, (_, index) => {
      const timelineBeatIndex = firstTimelineBeatIndex + index;
      const clickTick = timelineBeatIndex * TICKS_PER_BEAT;
      const beatInBar = positiveModulo(timelineBeatIndex, RECORDING_BEATS_PER_BAR);

      return Object.freeze({
        accented: beatInBar === 0,
        barIndex: Math.floor(timelineBeatIndex / RECORDING_BEATS_PER_BAR),
        beatInBar,
        offsetSeconds:
          ((clickTick - runtimeStartTick) / TICKS_PER_BEAT) * beatDurationSeconds,
        phase,
        timelineBeatIndex,
      });
    }),
  );
}

function validateBpm(bpm: number): void {
  if (!Number.isFinite(bpm) || bpm < RECORDING_BPM_MIN || bpm > RECORDING_BPM_MAX) {
    throw new RangeError(
      `Recording BPM must be between ${RECORDING_BPM_MIN} and ${RECORDING_BPM_MAX}.`,
    );
  }
}

function validateCountInBars(countInBars: number): asserts countInBars is CountInBars {
  if (!countInBarOptions.includes(countInBars as CountInBars)) {
    throw new RangeError('Count-In must be OFF, 1 bar, or 2 bars.');
  }
}

function validateRecordStartTick(recordStartTick: number): void {
  if (!Number.isSafeInteger(recordStartTick) || recordStartTick < 0) {
    throw new RangeError('Recording start tick must be a non-negative safe integer.');
  }
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
