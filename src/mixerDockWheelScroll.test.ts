import { describe, expect, it, vi } from 'vitest';

import { routeVerticalWheelPriority } from './mixerDockWheelScroll';

describe('routeVerticalWheelPriority', () => {
  it('moves only the deepest eligible owner in both pixel-wheel directions', () => {
    const inner = createOwner();
    const outer = createOwner({ scrollTop: 80 });

    expect(route([inner, outer], { deltaY: 140 })).toBe(true);
    expect(inner.scrollTop).toBe(140);
    expect(outer.scrollTop).toBe(80);

    expect(route([inner, outer], { deltaY: -70 })).toBe(true);
    expect(inner.scrollTop).toBe(70);
    expect(outer.scrollTop).toBe(80);
  });

  it('passes an inner directional boundary to the Top Dock owner', () => {
    const inner = createOwner({ scrollTop: 400 });
    const outer = createOwner({ scrollTop: 50 });

    expect(route([inner, outer], { deltaY: 120 })).toBe(true);
    expect(inner.scrollTop).toBe(400);
    expect(outer.scrollTop).toBe(170);

    inner.scrollTop = 0;
    expect(route([inner, outer], { deltaY: -70 })).toBe(true);
    expect(inner.scrollTop).toBe(0);
    expect(outer.scrollTop).toBe(100);
  });

  it('leaves the event unconsumed for the document at an outer boundary or without overflow', () => {
    const inner = createOwner({ scrollTop: 400 });
    const outer = createOwner({ scrollTop: 400 });

    expect(route([inner, outer], { deltaY: 120 })).toBe(false);

    const timelineOwner = createOwner({ clientHeight: 600, scrollHeight: 600 });
    expect(route([timelineOwner], { deltaY: 120 })).toBe(false);

    inner.scrollTop = 0;
    outer.scrollTop = 0;
    expect(route([inner, outer], { deltaY: -120 })).toBe(false);
  });

  it('normalizes pixel, line, and page wheel input for the selected owner', () => {
    const owner = createOwner();

    expect(route([owner], { deltaY: 3 })).toBe(true);
    expect(owner.scrollTop).toBe(3);

    expect(route([owner], { deltaMode: 1, deltaY: 3 })).toBe(true);
    expect(owner.scrollTop).toBe(51);

    expect(route([owner], { deltaMode: 2, deltaY: 1 })).toBe(true);
    expect(owner.scrollTop).toBe(251);
  });

  it('ignores prevented, horizontal, Shift, interactive, zero, and invalid input', () => {
    const owner = createOwner({ scrollTop: 100 });

    expect(route([owner], { defaultPrevented: true, deltaY: 120 })).toBe(false);
    expect(route([owner], { deltaX: 120, deltaY: 20 })).toBe(false);
    expect(route([owner], { deltaX: 20, deltaY: 20 })).toBe(false);
    expect(route([owner], { deltaY: 120, shiftKey: true })).toBe(false);
    expect(route([owner], { deltaY: 120, targetIsInteractive: true })).toBe(false);
    expect(route([owner], { deltaY: 0 })).toBe(false);
    expect(route([owner], { deltaY: Number.NaN })).toBe(false);
    expect(route([owner], { deltaX: Number.POSITIVE_INFINITY, deltaY: 120 })).toBe(false);
    expect(route([owner], { deltaMode: Number.NaN, deltaY: 120 })).toBe(false);
    expect(route([owner], { deltaMode: 3, deltaY: 120 })).toBe(false);

    expect(owner.scrollTop).toBe(100);
  });

  it('skips duplicate, invalid, and immovable owners before a valid fallback', () => {
    const invalid = createOwner({ scrollHeight: Number.NaN });
    const immovable = createOwner({ clientHeight: 600, scrollHeight: 600 });
    const assignmentBlocked = {
      clientHeight: 200,
      scrollHeight: 600,
      get scrollTop() {
        return 0;
      },
      set scrollTop(_value: number) {},
    };
    const outer = createOwner();

    expect(
      route([invalid, immovable, assignmentBlocked, outer, outer], { deltaY: 120 }),
    ).toBe(true);
    expect(outer.scrollTop).toBe(120);
  });
});

function createOwner(overrides: Partial<{
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}> = {}) {
  return {
    clientHeight: 200,
    scrollHeight: 600,
    scrollTop: 0,
    ...overrides,
  };
}

function route(
  owners: Parameters<typeof routeVerticalWheelPriority>[1],
  overrides: Partial<{
    defaultPrevented: boolean;
    deltaMode: number;
    deltaX: number;
    deltaY: number;
    shiftKey: boolean;
    targetIsInteractive: boolean;
  }>,
): boolean {
  const preventDefault = vi.fn();
  const routed = routeVerticalWheelPriority(
    {
      defaultPrevented: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 0,
      shiftKey: false,
      targetIsInteractive: false,
      preventDefault,
      ...overrides,
    },
    owners,
  );

  expect(preventDefault).toHaveBeenCalledTimes(routed ? 1 : 0);
  return routed;
}
