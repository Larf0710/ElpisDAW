import { describe, expect, it } from 'vitest';

import { resolveTimelineLengthBarsValue } from './timelineLengthBars';
import { TICKS_PER_BEAT } from './workflow';

describe('Timeline Length Bars action', () => {
  it('copies Timeline Length into a Bars parameter using its numeric contract', () => {
    expect(
      resolveTimelineLengthBarsValue(TICKS_PER_BEAT * 4 * 12, {
        max: 64,
        min: 1,
        step: 1,
      }),
    ).toBe(12);
  });

  it('clamps and snaps without changing the Timeline', () => {
    expect(
      resolveTimelineLengthBarsValue(TICKS_PER_BEAT * 4 * 80, {
        max: 64,
        min: 2,
        step: 2,
      }),
    ).toBe(64);
  });
});
