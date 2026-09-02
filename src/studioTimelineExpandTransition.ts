export const TIMELINE_EXPAND_SCROLL_FALLBACK_MS = 1200;
export const TIMELINE_EXPAND_SCROLL_TOP_TOLERANCE_PX = 10;
export const TIMELINE_EXPAND_FLIP_DURATION_MS = 260;
export const TIMELINE_EXPAND_FLIP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const TIMELINE_EXPAND_FLIP_MIN_DELTA_PX = 0.5;

export type TimelineExpandRequestResult = 'COMPLETED' | 'IGNORED' | 'PENDING';

export interface TimelineExpandTransitionEnvironment {
  cancelFrame(frameId: number): void;
  clearTimer(timerId: number): void;
  getScrollY(): number;
  prefersReducedMotion(): boolean;
  requestFrame(callback: () => void): number;
  scrollToTop(behavior: ScrollBehavior): void;
  setTimer(callback: () => void, delayMs: number): number;
  subscribeScrollEnd?(callback: () => void): () => void;
}

export interface TimelineExpandTransitionCoordinator {
  cancel(): void;
  isPending(): boolean;
  request(onComplete: () => void): TimelineExpandRequestResult;
}

export type TimelineFlipRequestResult = 'COMPLETED' | 'PENDING';

export interface TimelineFlipAnimation {
  cancel(): void;
  readonly finished: Promise<unknown>;
}

export interface TimelineFlipTransitionEnvironment<ElementType> {
  animate(element: ElementType, translateY: number): TimelineFlipAnimation;
  getTop(element: ElementType): number;
  prefersReducedMotion(): boolean;
}

export interface TimelineFlipTransitionCoordinator<ElementType> {
  cancel(): void;
  isPending(): boolean;
  play(
    element: ElementType,
    beforeTop: number,
    onComplete: () => void,
  ): TimelineFlipRequestResult;
}

type ActiveTransition = {
  fallbackTimerId: number;
  frameId: number;
  onComplete: () => void;
  unsubscribeScrollEnd?: () => void;
};

type ActiveFlipTransition = {
  animation: TimelineFlipAnimation;
  onComplete: () => void;
};

export function getTimelineFlipTranslateY(
  beforeTop: number,
  afterTop: number,
): number {
  if (!Number.isFinite(beforeTop) || !Number.isFinite(afterTop)) {
    throw new RangeError('Timeline FLIP positions must be finite.');
  }

  const translateY = beforeTop - afterTop;

  return Math.abs(translateY) < TIMELINE_EXPAND_FLIP_MIN_DELTA_PX
    ? 0
    : translateY;
}

export function createTimelineFlipTransitionCoordinator<ElementType>(
  environment: TimelineFlipTransitionEnvironment<ElementType>,
): TimelineFlipTransitionCoordinator<ElementType> {
  let activeTransition: ActiveFlipTransition | undefined;

  const cancel = () => {
    const transition = activeTransition;
    activeTransition = undefined;
    transition?.animation.cancel();
  };

  return Object.freeze({
    cancel,
    isPending(): boolean {
      return activeTransition !== undefined;
    },
    play(
      element: ElementType,
      beforeTop: number,
      onComplete: () => void,
    ): TimelineFlipRequestResult {
      cancel();

      if (environment.prefersReducedMotion()) {
        onComplete();
        return 'COMPLETED';
      }

      const translateY = getTimelineFlipTranslateY(
        beforeTop,
        environment.getTop(element),
      );

      if (translateY === 0) {
        onComplete();
        return 'COMPLETED';
      }

      const animation = environment.animate(element, translateY);
      const transition = { animation, onComplete };
      activeTransition = transition;

      void animation.finished.then(
        () => {
          if (activeTransition !== transition) {
            return;
          }

          activeTransition = undefined;
          animation.cancel();
          onComplete();
        },
        () => {
          if (activeTransition !== transition) {
            return;
          }

          activeTransition = undefined;
          animation.cancel();
          onComplete();
        },
      );

      return 'PENDING';
    },
  });
}

export function createTimelineExpandTransitionCoordinator(
  environment: TimelineExpandTransitionEnvironment,
  fallbackMs = TIMELINE_EXPAND_SCROLL_FALLBACK_MS,
): TimelineExpandTransitionCoordinator {
  if (!Number.isFinite(fallbackMs) || fallbackMs <= 0) {
    throw new RangeError('Timeline expand fallback must be a finite positive duration.');
  }

  let activeTransition: ActiveTransition | undefined;

  const isAtTop = () =>
    environment.getScrollY() <= TIMELINE_EXPAND_SCROLL_TOP_TOLERANCE_PX;

  const settle = (complete: boolean) => {
    const transition = activeTransition;
    if (!transition) {
      return;
    }

    activeTransition = undefined;
    environment.cancelFrame(transition.frameId);
    environment.clearTimer(transition.fallbackTimerId);
    transition.unsubscribeScrollEnd?.();

    if (complete) {
      transition.onComplete();
    }
  };

  const pollForTop = () => {
    if (!activeTransition) {
      return;
    }

    if (isAtTop()) {
      settle(true);
      return;
    }

    activeTransition.frameId = environment.requestFrame(pollForTop);
  };

  return Object.freeze({
    cancel(): void {
      settle(false);
    },
    isPending(): boolean {
      return activeTransition !== undefined;
    },
    request(onComplete: () => void): TimelineExpandRequestResult {
      if (activeTransition) {
        return 'IGNORED';
      }

      if (isAtTop()) {
        onComplete();
        return 'COMPLETED';
      }

      if (environment.prefersReducedMotion()) {
        environment.scrollToTop('auto');
        onComplete();
        return 'COMPLETED';
      }

      activeTransition = {
        fallbackTimerId: 0,
        frameId: 0,
        onComplete,
      };
      activeTransition.unsubscribeScrollEnd = environment.subscribeScrollEnd?.(() => {
        if (isAtTop()) {
          settle(true);
        }
      });
      activeTransition.fallbackTimerId = environment.setTimer(() => {
        environment.scrollToTop('auto');
        settle(true);
      }, fallbackMs);
      activeTransition.frameId = environment.requestFrame(pollForTop);
      environment.scrollToTop('smooth');

      return 'PENDING';
    },
  });
}

export function createBrowserTimelineExpandTransitionEnvironment(
  browserWindow: Window,
): TimelineExpandTransitionEnvironment {
  return Object.freeze({
    cancelFrame: (frameId: number) => browserWindow.cancelAnimationFrame(frameId),
    clearTimer: (timerId: number) => browserWindow.clearTimeout(timerId),
    getScrollY: () => browserWindow.scrollY,
    prefersReducedMotion: () =>
      browserWindow.matchMedia('(prefers-reduced-motion: reduce)').matches,
    requestFrame: (callback: () => void) => browserWindow.requestAnimationFrame(callback),
    scrollToTop: (behavior: ScrollBehavior) => {
      browserWindow.scrollTo({
        behavior,
        left: browserWindow.scrollX,
        top: 0,
      });
    },
    setTimer: (callback: () => void, delayMs: number) =>
      browserWindow.setTimeout(callback, delayMs),
    subscribeScrollEnd: 'onscrollend' in browserWindow
      ? (callback: () => void) => {
          browserWindow.addEventListener('scrollend', callback, { passive: true });
          return () => browserWindow.removeEventListener('scrollend', callback);
        }
      : undefined,
  });
}

export function createBrowserTimelineFlipTransitionEnvironment(
  browserWindow: Window,
): TimelineFlipTransitionEnvironment<HTMLElement> {
  return Object.freeze({
    animate: (element: HTMLElement, translateY: number) =>
      element.animate(
        [
          { transform: `translate3d(0, ${translateY}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        {
          duration: TIMELINE_EXPAND_FLIP_DURATION_MS,
          easing: TIMELINE_EXPAND_FLIP_EASING,
          fill: 'both',
        },
      ),
    getTop: (element: HTMLElement) => element.getBoundingClientRect().top,
    prefersReducedMotion: () =>
      browserWindow.matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
}
