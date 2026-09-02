import { useEffect, useState } from 'react';

import { GENERATION_LIVENESS_INTERVAL_MS } from '../shared/generationLivenessProtocol.js';

export const GENERATION_ACTIVITY_TICK_MS = 1_000;

export type GenerationActivityDescriptor = Readonly<{
  activityId: string;
  canBecomeStale: boolean;
  updateToken: string;
}>;

export type GenerationActivityClock = Readonly<{
  activityId: string;
  activeSinceMs: number;
  lastActivityAtMs: number;
  lastUpdateToken: string;
  nowMs: number;
}>;

export type GenerationActivityLiveness = Readonly<{
  elapsedSeconds: number;
  isStale: boolean;
  lastUpdateAgeSeconds: number;
}>;

export function reduceGenerationActivityClock(
  current: GenerationActivityClock | undefined,
  descriptor: GenerationActivityDescriptor | undefined,
  observedAtMs: number,
): GenerationActivityClock | undefined {
  if (!descriptor) {
    return undefined;
  }

  if (!Number.isFinite(observedAtMs)) {
    throw new TypeError('Generation activity observation time must be finite.');
  }

  if (!current || current.activityId !== descriptor.activityId) {
    return freezeClock({
      activityId: descriptor.activityId,
      activeSinceMs: observedAtMs,
      lastActivityAtMs: observedAtMs,
      lastUpdateToken: descriptor.updateToken,
      nowMs: observedAtMs,
    });
  }

  const nowMs = Math.max(current.nowMs, observedAtMs);
  const activityChanged = current.lastUpdateToken !== descriptor.updateToken;

  return freezeClock({
    ...current,
    lastActivityAtMs: activityChanged ? nowMs : current.lastActivityAtMs,
    lastUpdateToken: descriptor.updateToken,
    nowMs,
  });
}

export function createGenerationActivityLiveness(
  clock: GenerationActivityClock | undefined,
  descriptor: GenerationActivityDescriptor | undefined,
): GenerationActivityLiveness | undefined {
  if (!clock || !descriptor || clock.activityId !== descriptor.activityId) {
    return undefined;
  }

  const elapsedMs = Math.max(0, clock.nowMs - clock.activeSinceMs);
  const lastUpdateAgeMs = Math.max(0, clock.nowMs - clock.lastActivityAtMs);

  return Object.freeze({
    elapsedSeconds: Math.floor(elapsedMs / 1_000),
    isStale:
      descriptor.canBecomeStale &&
      lastUpdateAgeMs >= GENERATION_LIVENESS_INTERVAL_MS,
    lastUpdateAgeSeconds: Math.floor(lastUpdateAgeMs / 1_000),
  });
}

export function formatGenerationElapsedTime(totalSeconds: number): string {
  const seconds = Number.isFinite(totalSeconds)
    ? Math.max(0, Math.floor(totalSeconds))
    : 0;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;

  return hours > 0
    ? `${hours}:${padTime(minutes)}:${padTime(remainingSeconds)}`
    : `${padTime(minutes)}:${padTime(remainingSeconds)}`;
}

export function useGenerationActivityLiveness(
  descriptor: GenerationActivityDescriptor | undefined,
): GenerationActivityLiveness | undefined {
  const [clock, setClock] = useState<GenerationActivityClock>();
  const activityId = descriptor?.activityId;
  const canBecomeStale = descriptor?.canBecomeStale;
  const updateToken = descriptor?.updateToken;
  const observedDescriptor = activityId && updateToken !== undefined
    ? Object.freeze({
        activityId,
        canBecomeStale: Boolean(canBecomeStale),
        updateToken,
      })
    : undefined;

  useEffect(() => {
    setClock((current) =>
      reduceGenerationActivityClock(current, observedDescriptor, Date.now()),
    );
  }, [activityId, canBecomeStale, updateToken]);

  useEffect(() => {
    if (!activityId) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setClock((current) =>
        reduceGenerationActivityClock(current, observedDescriptor, Date.now()),
      );
    }, GENERATION_ACTIVITY_TICK_MS);

    return () => window.clearInterval(intervalId);
  }, [activityId, canBecomeStale, updateToken]);

  const visibleClock = reduceGenerationActivityClock(
    clock,
    observedDescriptor,
    clock?.nowMs ?? Date.now(),
  );

  return createGenerationActivityLiveness(visibleClock, observedDescriptor);
}

function freezeClock(clock: GenerationActivityClock): GenerationActivityClock {
  return Object.freeze({ ...clock });
}

function padTime(value: number): string {
  return String(value).padStart(2, '0');
}
