import { describe, expect, it } from 'vitest';

import { GENERATION_LIVENESS_INTERVAL_MS } from '../shared/generationLivenessProtocol.js';
import {
  createGenerationActivityLiveness,
  formatGenerationElapsedTime,
  reduceGenerationActivityClock,
  type GenerationActivityDescriptor,
} from './generationActivityClock';

const ACTIVE: GenerationActivityDescriptor = Object.freeze({
  activityId: 'ACE T2M',
  canBecomeStale: true,
  updateToken: 'PROCESSING:10',
});

describe('generation activity clock', () => {
  it('tracks total elapsed time and resets only the update age when activity advances', () => {
    const started = reduceGenerationActivityClock(undefined, ACTIVE, 1_000);
    const waiting = reduceGenerationActivityClock(started, ACTIVE, 21_000);
    const advanced = reduceGenerationActivityClock(
      waiting,
      { ...ACTIVE, updateToken: 'PROCESSING:20' },
      22_000,
    );

    expect(createGenerationActivityLiveness(advanced, {
      ...ACTIVE,
      updateToken: 'PROCESSING:20',
    })).toEqual({
      elapsedSeconds: 21,
      isStale: false,
      lastUpdateAgeSeconds: 0,
    });
  });

  it('marks eligible activity stale at the shared threshold without stopping it', () => {
    const started = reduceGenerationActivityClock(undefined, ACTIVE, 10_000);
    const stale = reduceGenerationActivityClock(
      started,
      ACTIVE,
      10_000 + GENERATION_LIVENESS_INTERVAL_MS,
    );

    expect(createGenerationActivityLiveness(stale, ACTIVE)).toEqual({
      elapsedSeconds: 30,
      isStale: true,
      lastUpdateAgeSeconds: 30,
    });
    expect(createGenerationActivityLiveness(stale, {
      ...ACTIVE,
      canBecomeStale: false,
    })?.isStale).toBe(false);
  });

  it('resets for a new operation and formats bounded elapsed labels', () => {
    const first = reduceGenerationActivityClock(undefined, ACTIVE, 1_000);
    const next = reduceGenerationActivityClock(
      first,
      { ...ACTIVE, activityId: 'SA3 T2A' },
      91_000,
    );

    expect(next).toMatchObject({
      activeSinceMs: 91_000,
      lastActivityAtMs: 91_000,
    });
    expect(formatGenerationElapsedTime(9)).toBe('00:09');
    expect(formatGenerationElapsedTime(125)).toBe('02:05');
    expect(formatGenerationElapsedTime(3_661)).toBe('1:01:01');
  });
});
