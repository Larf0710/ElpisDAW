import { describe, expect, it } from 'vitest';

import { getNearestScrollOffset } from './timelineClipReveal';

describe('Timeline clip reveal geometry', () => {
  it('keeps a fully visible target at the current offset', () => {
    expect(
      getNearestScrollOffset({
        currentOffset: 120,
        maxOffset: 600,
        targetEnd: 480,
        targetStart: 240,
        viewportEnd: 600,
        viewportStart: 200,
      }),
    ).toBe(120);
  });

  it('moves by the nearest leading or trailing edge for a smaller target', () => {
    expect(
      getNearestScrollOffset({
        currentOffset: 300,
        maxOffset: 800,
        targetEnd: 180,
        targetStart: 80,
        viewportEnd: 600,
        viewportStart: 200,
      }),
    ).toBe(180);
    expect(
      getNearestScrollOffset({
        currentOffset: 300,
        maxOffset: 800,
        targetEnd: 760,
        targetStart: 660,
        viewportEnd: 600,
        viewportStart: 200,
      }),
    ).toBe(460);
  });

  it('uses the nearest edge for a target larger than the viewport', () => {
    expect(
      getNearestScrollOffset({
        currentOffset: 300,
        maxOffset: 900,
        targetEnd: 180,
        targetStart: -420,
        viewportEnd: 600,
        viewportStart: 200,
      }),
    ).toBe(0);
    expect(
      getNearestScrollOffset({
        currentOffset: 300,
        maxOffset: 900,
        targetEnd: 1200,
        targetStart: 700,
        viewportEnd: 600,
        viewportStart: 200,
      }),
    ).toBe(800);
  });

  it('does not move when an oversized target already spans the viewport', () => {
    expect(
      getNearestScrollOffset({
        currentOffset: 300,
        maxOffset: 900,
        targetEnd: 700,
        targetStart: 100,
        viewportEnd: 600,
        viewportStart: 200,
      }),
    ).toBe(300);
  });

  it('clamps offsets and rejects invalid geometry', () => {
    expect(
      getNearestScrollOffset({
        currentOffset: 20,
        maxOffset: 100,
        targetEnd: 10,
        targetStart: -100,
        viewportEnd: 200,
        viewportStart: 0,
      }),
    ).toBe(0);
    expect(() =>
      getNearestScrollOffset({
        currentOffset: 0,
        maxOffset: 100,
        targetEnd: 20,
        targetStart: 30,
        viewportEnd: 200,
        viewportStart: 0,
      }),
    ).toThrow(RangeError);
  });
});
