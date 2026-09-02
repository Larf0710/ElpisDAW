import { describe, expect, it } from 'vitest';

import {
  createRecordingTimingPlan,
  getRecordingPlayheadTick,
  RECORDING_BEATS_PER_BAR,
} from './recordingTiming';
import { TICKS_PER_BEAT } from './workflow';

describe('createRecordingTimingPlan', () => {
  it('creates one aligned 4/4 Count-In bar from the Project BPM', () => {
    const plan = createRecordingTimingPlan({
      bpm: 120,
      countInBars: 1,
      recordStartTick: 0,
    });

    expect(plan).toMatchObject({
      beatDurationSeconds: 0.5,
      beatsPerBar: 4,
      bpm: 120,
      countInBars: 1,
      countInBeats: 4,
      countInDurationSeconds: 2,
      recordStartTick: 0,
      recordingStartOffsetSeconds: 2,
    });
    expect(plan.countInClicks).toEqual([
      createExpectedClick(-4, 0, 'count-in'),
      createExpectedClick(-3, 0.5, 'count-in'),
      createExpectedClick(-2, 1, 'count-in'),
      createExpectedClick(-1, 1.5, 'count-in'),
    ]);
    expect(plan.recordingCycleClicks).toEqual([
      createExpectedClick(0, 2, 'recording'),
      createExpectedClick(1, 2.5, 'recording'),
      createExpectedClick(2, 3, 'recording'),
      createExpectedClick(3, 3.5, 'recording'),
    ]);
  });

  it('preserves Timeline bar accents across a two-bar Count-In', () => {
    const plan = createRecordingTimingPlan({
      bpm: 90,
      countInBars: 2,
      recordStartTick: TICKS_PER_BEAT * 2,
    });

    expect(plan.countInClicks).toHaveLength(8);
    expect(plan.countInClicks.map((click) => click.timelineBeatIndex)).toEqual([
      -6, -5, -4, -3, -2, -1, 0, 1,
    ]);
    expect(plan.countInClicks.map((click) => click.accented)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(plan.recordingCycleClicks.map((click) => click.beatInBar)).toEqual([
      2, 3, 0, 1,
    ]);
    expect(plan.countInDurationSeconds).toBeCloseTo(16 / 3);
  });

  it('keeps metronome clicks aligned when recording starts between beats', () => {
    const plan = createRecordingTimingPlan({
      bpm: 120,
      countInBars: 1,
      recordStartTick: TICKS_PER_BEAT / 2,
    });

    expect(plan.countInClicks.map((click) => click.offsetSeconds)).toEqual([
      0.25, 0.75, 1.25, 1.75,
    ]);
    expect(plan.recordingCycleClicks[0]).toEqual(
      createExpectedClick(1, 2.25, 'recording'),
    );
  });

  it('starts recording immediately when Count-In is OFF', () => {
    const plan = createRecordingTimingPlan({
      bpm: 120,
      countInBars: 0,
      recordStartTick: TICKS_PER_BEAT * RECORDING_BEATS_PER_BAR,
    });

    expect(plan.countInClicks).toEqual([]);
    expect(plan.countInDurationSeconds).toBe(0);
    expect(plan.recordingStartOffsetSeconds).toBe(0);
    expect(plan.recordingCycleClicks[0]).toEqual(
      createExpectedClick(4, 0, 'recording'),
    );
  });

  it('returns a deeply immutable timing plan', () => {
    const plan = createRecordingTimingPlan({
      bpm: 100,
      countInBars: 1,
      recordStartTick: 0,
    });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.countInClicks)).toBe(true);
    expect(Object.isFrozen(plan.countInClicks[0])).toBe(true);
    expect(Object.isFrozen(plan.recordingCycleClicks)).toBe(true);
    expect(Object.isFrozen(plan.recordingCycleClicks[0])).toBe(true);
  });

  it('rejects invalid BPM, Count-In, and start positions', () => {
    expect(() =>
      createRecordingTimingPlan({ bpm: 39, countInBars: 1, recordStartTick: 0 }),
    ).toThrow('between 40 and 240');
    expect(() =>
      createRecordingTimingPlan({
        bpm: 120,
        countInBars: 3 as never,
        recordStartTick: 0,
      }),
    ).toThrow('OFF, 1 bar, or 2 bars');
    expect(() =>
      createRecordingTimingPlan({ bpm: 120, countInBars: 1, recordStartTick: -1 }),
    ).toThrow('non-negative safe integer');
  });
});

describe('getRecordingPlayheadTick', () => {
  it('moves from the frozen recording start using captured audio time', () => {
    expect(
      getRecordingPlayheadTick({
        bpm: 120,
        elapsedSeconds: 0.75,
        maximumEndTick: TICKS_PER_BEAT * 8,
        startTick: TICKS_PER_BEAT * 2,
      }),
    ).toBe(TICKS_PER_BEAT * 3.5);
  });

  it('clamps progress at the safe recording boundary', () => {
    expect(
      getRecordingPlayheadTick({
        bpm: 120,
        elapsedSeconds: 20,
        maximumEndTick: TICKS_PER_BEAT * 4,
        startTick: TICKS_PER_BEAT * 2,
      }),
    ).toBe(TICKS_PER_BEAT * 4);
  });

  it('rejects invalid recording progress inputs', () => {
    expect(() =>
      getRecordingPlayheadTick({
        bpm: 120,
        elapsedSeconds: Number.NaN,
        maximumEndTick: TICKS_PER_BEAT * 4,
        startTick: 0,
      }),
    ).toThrow('Audio position');
    expect(() =>
      getRecordingPlayheadTick({
        bpm: 120,
        elapsedSeconds: 1,
        maximumEndTick: TICKS_PER_BEAT,
        startTick: TICKS_PER_BEAT * 2,
      }),
    ).toThrow('at or after the start tick');
  });
});

function createExpectedClick(
  timelineBeatIndex: number,
  offsetSeconds: number,
  phase: 'count-in' | 'recording',
) {
  const beatInBar =
    ((timelineBeatIndex % RECORDING_BEATS_PER_BAR) + RECORDING_BEATS_PER_BAR) %
    RECORDING_BEATS_PER_BAR;

  return {
    accented: beatInBar === 0,
    barIndex: Math.floor(timelineBeatIndex / RECORDING_BEATS_PER_BAR),
    beatInBar,
    offsetSeconds,
    phase,
    timelineBeatIndex,
  };
}
