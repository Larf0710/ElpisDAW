import { describe, expect, it, vi } from 'vitest';

import {
  createTimelineFlipTransitionCoordinator,
  createTimelineExpandTransitionCoordinator,
  getTimelineFlipTranslateY,
  type TimelineExpandTransitionEnvironment,
  type TimelineFlipAnimation,
  type TimelineFlipTransitionEnvironment,
} from './studioTimelineExpandTransition';

function createTestEnvironment(options: { reducedMotion?: boolean; scrollY?: number } = {}) {
  let scrollY = options.scrollY ?? 640;
  let nextId = 1;
  let scrollEndListener: (() => void) | undefined;
  const frameCallbacks = new Map<number, () => void>();
  const timerCallbacks = new Map<number, () => void>();
  const scrollCalls: ScrollBehavior[] = [];

  const environment: TimelineExpandTransitionEnvironment = {
    cancelFrame: (frameId) => frameCallbacks.delete(frameId),
    clearTimer: (timerId) => timerCallbacks.delete(timerId),
    getScrollY: () => scrollY,
    prefersReducedMotion: () => options.reducedMotion ?? false,
    requestFrame: (callback) => {
      const id = nextId++;
      frameCallbacks.set(id, callback);
      return id;
    },
    scrollToTop: (behavior) => {
      scrollCalls.push(behavior);
      if (behavior === 'auto') {
        scrollY = 0;
      }
    },
    setTimer: (callback) => {
      const id = nextId++;
      timerCallbacks.set(id, callback);
      return id;
    },
    subscribeScrollEnd: (callback) => {
      scrollEndListener = callback;
      return () => {
        if (scrollEndListener === callback) {
          scrollEndListener = undefined;
        }
      };
    },
  };

  return {
    environment,
    frameCallbacks,
    runNextFrame() {
      const entry = frameCallbacks.entries().next().value as [number, () => void] | undefined;
      if (!entry) {
        throw new Error('No animation frame is pending.');
      }
      frameCallbacks.delete(entry[0]);
      entry[1]();
    },
    runNextTimer() {
      const entry = timerCallbacks.entries().next().value as [number, () => void] | undefined;
      if (!entry) {
        throw new Error('No fallback timer is pending.');
      }
      timerCallbacks.delete(entry[0]);
      entry[1]();
    },
    scrollCalls,
    setScrollY(value: number) {
      scrollY = value;
    },
    timerCallbacks,
    triggerScrollEnd() {
      scrollEndListener?.();
    },
  };
}

function createFlipTestEnvironment(
  options: { afterTop?: number; reducedMotion?: boolean } = {},
) {
  let afterTop = options.afterTop ?? 330;
  const animations: Array<{
    animation: TimelineFlipAnimation;
    element: string;
    finish: () => void;
    translateY: number;
  }> = [];

  const environment: TimelineFlipTransitionEnvironment<string> = {
    animate: (element, translateY) => {
      let finish: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const animation = {
        cancel: vi.fn(),
        finished,
      };
      animations.push({ animation, element, finish, translateY });
      return animation;
    },
    getTop: () => afterTop,
    prefersReducedMotion: () => options.reducedMotion ?? false,
  };

  return {
    animations,
    environment,
    setAfterTop(value: number) {
      afterTop = value;
    },
  };
}

describe('Timeline expand transition', () => {
  it('smooth-scrolls first and completes only after the page reaches the top', () => {
    const testEnvironment = createTestEnvironment({ scrollY: 720 });
    const coordinator = createTimelineExpandTransitionCoordinator(
      testEnvironment.environment,
    );
    const onComplete = vi.fn();

    expect(coordinator.request(onComplete)).toBe('PENDING');
    expect(coordinator.isPending()).toBe(true);
    expect(testEnvironment.scrollCalls).toEqual(['smooth']);
    expect(onComplete).not.toHaveBeenCalled();

    testEnvironment.setScrollY(0);
    testEnvironment.runNextFrame();

    expect(onComplete).toHaveBeenCalledOnce();
    expect(coordinator.isPending()).toBe(false);
    expect(testEnvironment.frameCallbacks.size).toBe(0);
    expect(testEnvironment.timerCallbacks.size).toBe(0);
  });

  it('completes immediately without scrolling when the page is already at the top', () => {
    const testEnvironment = createTestEnvironment({ scrollY: 8 });
    const coordinator = createTimelineExpandTransitionCoordinator(
      testEnvironment.environment,
    );
    const onComplete = vi.fn();

    expect(coordinator.request(onComplete)).toBe('COMPLETED');
    expect(onComplete).toHaveBeenCalledOnce();
    expect(testEnvironment.scrollCalls).toEqual([]);
    expect(coordinator.isPending()).toBe(false);
  });

  it('jumps to the top and completes immediately for reduced motion', () => {
    const testEnvironment = createTestEnvironment({ reducedMotion: true, scrollY: 500 });
    const coordinator = createTimelineExpandTransitionCoordinator(
      testEnvironment.environment,
    );
    const onComplete = vi.fn();

    expect(coordinator.request(onComplete)).toBe('COMPLETED');
    expect(testEnvironment.scrollCalls).toEqual(['auto']);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('uses native scroll completion when the browser reports the target reached', () => {
    const testEnvironment = createTestEnvironment({ scrollY: 360 });
    const coordinator = createTimelineExpandTransitionCoordinator(
      testEnvironment.environment,
    );
    const onComplete = vi.fn();

    expect(coordinator.request(onComplete)).toBe('PENDING');
    testEnvironment.setScrollY(0);
    testEnvironment.triggerScrollEnd();

    expect(onComplete).toHaveBeenCalledOnce();
    expect(coordinator.isPending()).toBe(false);
  });

  it('uses a bounded fallback that finishes at the exact page top', () => {
    const testEnvironment = createTestEnvironment({ scrollY: 800 });
    const coordinator = createTimelineExpandTransitionCoordinator(
      testEnvironment.environment,
      250,
    );
    const onComplete = vi.fn();

    expect(coordinator.request(onComplete)).toBe('PENDING');
    testEnvironment.runNextTimer();

    expect(testEnvironment.scrollCalls).toEqual(['smooth', 'auto']);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(coordinator.isPending()).toBe(false);
  });

  it('ignores duplicate requests and cancellation prevents stale completion', () => {
    const testEnvironment = createTestEnvironment({ scrollY: 640 });
    const coordinator = createTimelineExpandTransitionCoordinator(
      testEnvironment.environment,
    );
    const firstCompletion = vi.fn();
    const duplicateCompletion = vi.fn();

    expect(coordinator.request(firstCompletion)).toBe('PENDING');
    expect(coordinator.request(duplicateCompletion)).toBe('IGNORED');
    coordinator.cancel();

    expect(coordinator.isPending()).toBe(false);
    expect(testEnvironment.frameCallbacks.size).toBe(0);
    expect(testEnvironment.timerCallbacks.size).toBe(0);
    expect(firstCompletion).not.toHaveBeenCalled();
    expect(duplicateCompletion).not.toHaveBeenCalled();
    expect(coordinator.request(firstCompletion)).toBe('PENDING');
  });

  it('computes the measured FLIP translation and rejects invalid geometry', () => {
    expect(getTimelineFlipTranslateY(680, 330)).toBe(350);
    expect(getTimelineFlipTranslateY(330.4, 330)).toBe(0);
    expect(() => getTimelineFlipTranslateY(Number.NaN, 330)).toThrow(
      'Timeline FLIP positions must be finite.',
    );
  });

  it('applies the measured Timeline delta until the FLIP animation completes', async () => {
    const testEnvironment = createFlipTestEnvironment({ afterTop: 330 });
    const coordinator = createTimelineFlipTransitionCoordinator(
      testEnvironment.environment,
    );
    const onComplete = vi.fn();

    expect(coordinator.play('timeline', 680, onComplete)).toBe('PENDING');
    expect(testEnvironment.animations).toHaveLength(1);
    expect(testEnvironment.animations[0]).toMatchObject({
      element: 'timeline',
      translateY: 350,
    });
    expect(coordinator.isPending()).toBe(true);

    testEnvironment.animations[0].finish();
    await Promise.resolve();

    expect(onComplete).toHaveBeenCalledOnce();
    expect(coordinator.isPending()).toBe(false);
    expect(testEnvironment.animations[0].animation.cancel).toHaveBeenCalledOnce();
  });

  it('skips FLIP animation for no-op geometry and reduced motion', () => {
    const noOpEnvironment = createFlipTestEnvironment({ afterTop: 330 });
    const noOpCoordinator = createTimelineFlipTransitionCoordinator(
      noOpEnvironment.environment,
    );
    const noOpComplete = vi.fn();

    expect(noOpCoordinator.play('timeline', 330.2, noOpComplete)).toBe('COMPLETED');
    expect(noOpEnvironment.animations).toHaveLength(0);
    expect(noOpComplete).toHaveBeenCalledOnce();

    const reducedEnvironment = createFlipTestEnvironment({
      afterTop: 330,
      reducedMotion: true,
    });
    const reducedCoordinator = createTimelineFlipTransitionCoordinator(
      reducedEnvironment.environment,
    );
    const reducedComplete = vi.fn();

    expect(reducedCoordinator.play('timeline', 680, reducedComplete)).toBe('COMPLETED');
    expect(reducedEnvironment.animations).toHaveLength(0);
    expect(reducedComplete).toHaveBeenCalledOnce();
  });

  it('cancels stale FLIP animations when replaced or explicitly canceled', async () => {
    const testEnvironment = createFlipTestEnvironment({ afterTop: 330 });
    const coordinator = createTimelineFlipTransitionCoordinator(
      testEnvironment.environment,
    );
    const firstComplete = vi.fn();
    const replacementComplete = vi.fn();

    expect(coordinator.play('timeline', 680, firstComplete)).toBe('PENDING');
    testEnvironment.setAfterTop(300);
    expect(coordinator.play('timeline', 700, replacementComplete)).toBe('PENDING');
    expect(testEnvironment.animations[0].animation.cancel).toHaveBeenCalledOnce();
    expect(testEnvironment.animations[1].translateY).toBe(400);

    coordinator.cancel();
    expect(testEnvironment.animations[1].animation.cancel).toHaveBeenCalledOnce();
    expect(coordinator.isPending()).toBe(false);

    testEnvironment.animations[0].finish();
    testEnvironment.animations[1].finish();
    await Promise.resolve();

    expect(firstComplete).not.toHaveBeenCalled();
    expect(replacementComplete).not.toHaveBeenCalled();
  });

  it('starts FLIP only after the current document-scroll phase reaches the top', () => {
    const scrollEnvironment = createTestEnvironment({ scrollY: 640 });
    const flipEnvironment = createFlipTestEnvironment({ afterTop: 330 });
    const scrollCoordinator = createTimelineExpandTransitionCoordinator(
      scrollEnvironment.environment,
    );
    const flipCoordinator = createTimelineFlipTransitionCoordinator(
      flipEnvironment.environment,
    );
    const onComplete = vi.fn();

    expect(scrollCoordinator.request(() => {
      flipCoordinator.play('timeline', 680, onComplete);
    })).toBe('PENDING');
    expect(flipEnvironment.animations).toHaveLength(0);

    scrollEnvironment.setScrollY(0);
    scrollEnvironment.runNextFrame();

    expect(flipEnvironment.animations).toHaveLength(1);
    expect(flipEnvironment.animations[0].translateY).toBe(350);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
