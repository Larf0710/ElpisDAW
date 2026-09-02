import { describe, expect, it } from 'vitest';

import {
  getPianoRollLinkedPageScrollLeft,
  resolvePianoRollLinkedPlayhead,
} from './pianoRollLink';

const TICKS_PER_QUARTER = 480;

describe('Piano Roll Timeline link', () => {
  it('maps the project playhead to Clip-local Piano Roll coordinates', () => {
    expect(
      resolvePianoRollLinkedPlayhead({
        clipLengthTicks: 3_840,
        clipStartTick: 1_920,
        playheadTick: 2_880,
        ticksPerQuarter: TICKS_PER_QUARTER,
      }),
    ).toEqual({
      localTick: 960,
      x: 192,
    });
  });

  it('hides the linked marker outside the selected Clip range', () => {
    const input = {
      clipLengthTicks: 3_840,
      clipStartTick: 1_920,
      ticksPerQuarter: TICKS_PER_QUARTER,
    };

    expect(
      resolvePianoRollLinkedPlayhead({
        ...input,
        playheadTick: 1_919,
      }),
    ).toBeUndefined();
    expect(
      resolvePianoRollLinkedPlayhead({
        ...input,
        playheadTick: 5_761,
      }),
    ).toBeUndefined();
  });

  it('keeps the current page while the marker remains visible', () => {
    expect(
      getPianoRollLinkedPageScrollLeft({
        contentWidth: 2_400,
        currentScrollLeft: 120,
        keyboardWidth: 68,
        playheadX: 300,
        viewportWidth: 500,
      }),
    ).toBe(120);
  });

  it('advances exactly one page when playback crosses the right edge', () => {
    expect(
      getPianoRollLinkedPageScrollLeft({
        contentWidth: 2_400,
        currentScrollLeft: 0,
        keyboardWidth: 68,
        playheadX: 431,
        viewportWidth: 500,
      }),
    ).toBe(0);
    expect(
      getPianoRollLinkedPageScrollLeft({
        contentWidth: 2_400,
        currentScrollLeft: 0,
        keyboardWidth: 68,
        playheadX: 432,
        viewportWidth: 500,
      }),
    ).toBe(432);
  });

  it('uses the full note viewport after the keyboard is split out', () => {
    expect(
      getPianoRollLinkedPageScrollLeft({
        contentWidth: 2_400,
        currentScrollLeft: 0,
        keyboardWidth: 0,
        playheadX: 499,
        viewportWidth: 500,
      }),
    ).toBe(0);
    expect(
      getPianoRollLinkedPageScrollLeft({
        contentWidth: 2_400,
        currentScrollLeft: 0,
        keyboardWidth: 0,
        playheadX: 500,
        viewportWidth: 500,
      }),
    ).toBe(500);
  });

  it('returns to the page containing a playhead that jumps left', () => {
    expect(
      getPianoRollLinkedPageScrollLeft({
        contentWidth: 2_400,
        currentScrollLeft: 864,
        keyboardWidth: 68,
        playheadX: 200,
        viewportWidth: 500,
      }),
    ).toBe(0);
  });

  it('clamps the last page to the available scroll range', () => {
    expect(
      getPianoRollLinkedPageScrollLeft({
        contentWidth: 1_000,
        currentScrollLeft: 0,
        keyboardWidth: 68,
        playheadX: 999,
        viewportWidth: 500,
      }),
    ).toBe(568);
  });
});
