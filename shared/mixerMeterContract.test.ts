import { describe, expect, it } from 'vitest';

import {
  createMixerChannelDspCoefficients,
} from './mixerDspContract.js';
import {
  MIXER_METER_CONTRACT_VERSION,
  accumulateMixerSamplePeakBlock,
  createMixerSamplePeakAccumulator,
  resetMixerSamplePeakAccumulator,
  snapshotMixerSamplePeak,
  type MixerSamplePeakAccumulator,
} from './mixerMeterContract.js';

describe('Mixer sample-peak meter contract v1', () => {
  it('reports silence as zero peaks without clipping', () => {
    const accumulator = accumulateMixerSamplePeakBlock(
      createMixerSamplePeakAccumulator(),
      new Float32Array([0, -0, 0]),
      new Float64Array([0, 0, -0]),
    );

    expect(snapshotMixerSamplePeak(accumulator)).toEqual({
      clipped: false,
      left: { clipped: false, peak: 0 },
      right: { clipped: false, peak: 0 },
      sampleCount: 3,
      version: MIXER_METER_CONTRACT_VERSION,
    });
  });

  it('uses strict greater-than-full-scale clipping with left/right independence', () => {
    const justBelow = 1 - Number.EPSILON;
    const justAbove = 1 + Number.EPSILON;
    const accumulator = accumulateMixerSamplePeakBlock(
      createMixerSamplePeakAccumulator(),
      [justBelow, 1, -1],
      [0.25, -justAbove, 0.5],
    );
    const snapshot = snapshotMixerSamplePeak(accumulator);

    expect(snapshot.left).toEqual({ clipped: false, peak: 1 });
    expect(snapshot.right.peak).toBe(justAbove);
    expect(snapshot.right.clipped).toBe(true);
    expect(snapshot.clipped).toBe(true);
  });

  it('measures mono and stereo samples after the shared Fader/Pan coefficients', () => {
    const mono = createMixerChannelDspCoefficients(0, 0, 1);
    const monoSnapshot = snapshotMixerSamplePeak(
      accumulateMixerSamplePeakBlock(
        createMixerSamplePeakAccumulator(),
        [mono.leftOutputGain, -mono.leftOutputGain],
        [mono.rightOutputGain, -mono.rightOutputGain],
      ),
    );
    const stereo = createMixerChannelDspCoefficients(0, 0.5, 2);
    const stereoSnapshot = snapshotMixerSamplePeak(
      accumulateMixerSamplePeakBlock(
        createMixerSamplePeakAccumulator(),
        [stereo.leftOutputGain],
        [-0.5 * stereo.rightOutputGain],
      ),
    );

    expect(monoSnapshot.left.peak).toBeCloseTo(Math.SQRT1_2, 15);
    expect(monoSnapshot.right.peak).toBeCloseTo(Math.SQRT1_2, 15);
    expect(stereoSnapshot.left.peak).toBeCloseTo(Math.SQRT1_2, 15);
    expect(stereoSnapshot.right.peak).toBe(0.5);
  });

  it('is invariant to valid block partitioning and applies scale before measuring', () => {
    const left = [0.25, -0.75, 1.25, -0.5];
    const right = [-0.5, 0.125, 0.75, -1.5];
    const single = accumulateMixerSamplePeakBlock(
      createMixerSamplePeakAccumulator(),
      left,
      right,
      0.5,
    );
    const first = accumulateMixerSamplePeakBlock(
      createMixerSamplePeakAccumulator(),
      left.slice(0, 1),
      right.slice(0, 1),
      0.5,
    );
    const partitioned = accumulateMixerSamplePeakBlock(
      accumulateMixerSamplePeakBlock(
        first,
        left.slice(1, 3),
        right.slice(1, 3),
        0.5,
      ),
      left.slice(3),
      right.slice(3),
      0.5,
    );

    expect(partitioned).toEqual(single);
    expect(snapshotMixerSamplePeak(single)).toMatchObject({
      left: { clipped: false, peak: 0.625 },
      right: { clipped: false, peak: 0.75 },
      sampleCount: 4,
    });
  });

  it('returns immutable snapshots and resets to a fresh zero accumulator', () => {
    const accumulated = accumulateMixerSamplePeakBlock(
      createMixerSamplePeakAccumulator(),
      [0.5],
      [-0.75],
    );
    const snapshot = snapshotMixerSamplePeak(accumulated);
    const reset = resetMixerSamplePeakAccumulator(accumulated);

    expect(Object.isFrozen(accumulated)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.left)).toBe(true);
    expect(Object.isFrozen(snapshot.right)).toBe(true);
    expect(reset).toEqual(createMixerSamplePeakAccumulator());
    expect(snapshot.left.peak).toBe(0.5);
    expect(snapshot.right.peak).toBe(0.75);
  });

  it('rejects malformed meter state, blocks, scale, NaN, and infinities', () => {
    const empty = createMixerSamplePeakAccumulator();
    const invalidState = {
      ...empty,
      leftPeak: 0.5,
    } as MixerSamplePeakAccumulator;

    expect(() => snapshotMixerSamplePeak(invalidState)).toThrow(TypeError);
    expect(() =>
      accumulateMixerSamplePeakBlock(empty, [0], [0, 1]),
    ).toThrow(TypeError);
    expect(() =>
      accumulateMixerSamplePeakBlock(empty, [Number.NaN], [0]),
    ).toThrow(RangeError);
    expect(() =>
      accumulateMixerSamplePeakBlock(empty, [0], [Number.POSITIVE_INFINITY]),
    ).toThrow(RangeError);
    expect(() =>
      accumulateMixerSamplePeakBlock(empty, [1], [1], Number.NEGATIVE_INFINITY),
    ).toThrow(RangeError);
    expect(() =>
      accumulateMixerSamplePeakBlock(empty, [Number.MAX_VALUE], [0], 2),
    ).toThrow(RangeError);
  });
});
