import { describe, expect, it } from 'vitest';

import {
  accumulateMixerSamplePeakBlock,
  createMixerSamplePeakAccumulator,
} from '../shared/mixerMeterContract.js';
import { createMixerMeterTapSummary } from '../shared/mixerMeterTapContract.js';
import { createProjectPlaybackMeterStore } from './projectPlaybackMeterStore';
import { sampleProject } from './sampleProject';

describe('Project Playback meter store', () => {
  it('notifies only the exact changed meter subscription', () => {
    const store = createProjectPlaybackMeterStore();
    const changes = { first: 0, master: 0, second: 0 };
    store.subscribe('channel', 'track-1', () => changes.first += 1);
    store.subscribe('channel', 'track-2', () => changes.second += 1);
    store.subscribe('master', undefined, () => changes.master += 1);

    store.publish(createSnapshot([
      ['track-1', 0.2, 0.3],
      ['track-2', 0.4, 0.5],
    ], 0.6, 0.7));
    expect(changes).toEqual({ first: 1, master: 1, second: 1 });

    store.publish(createSnapshot([
      ['track-1', 0.9, 0.3],
      ['track-2', 0.4, 0.5],
    ], 0.6, 0.7));
    expect(changes).toEqual({ first: 2, master: 1, second: 1 });
  });

  it('handles a bounded simultaneous 128-Channel snapshot without Project state', () => {
    const store = createProjectPlaybackMeterStore();
    let notifications = 0;
    const unsubscribe = Array.from({ length: 128 }, (_, index) =>
      store.subscribe('channel', `track-${index}`, () => notifications += 1),
    );
    const snapshot = createSnapshot(
      Array.from({ length: 128 }, (_, index) => [
        `track-${index}`,
        index / 256,
        index / 512,
      ] as const),
      1,
      0.5,
    );
    const projectBefore = JSON.stringify(sampleProject);

    store.publish(snapshot);

    expect(notifications).toBe(128);
    expect(store.getSubscriberCount()).toBe(128);
    expect(store.getMeter('channel', 'track-127')?.left.peak).toBe(127 / 256);
    expect(JSON.stringify(snapshot)).not.toContain('project');
    expect(JSON.stringify(sampleProject)).toBe(projectBefore);

    unsubscribe.forEach((unsubscribeMeter) => unsubscribeMeter());
    expect(store.getSubscriberCount()).toBe(0);
  });

  it('does not grow subscribers across repeated subscribe and unsubscribe cycles', () => {
    const store = createProjectPlaybackMeterStore();

    for (let cycle = 0; cycle < 200; cycle += 1) {
      const unsubscribe = store.subscribe(
        'channel',
        `track-${cycle % 16}`,
        () => undefined,
      );
      unsubscribe();
      unsubscribe();
    }

    expect(store.getSubscriberCount()).toBe(0);
  });

  it('clears exact observations without fabricating measured zero', () => {
    const store = createProjectPlaybackMeterStore();
    let notifications = 0;
    store.subscribe('channel', 'track-1', () => notifications += 1);
    store.publish(createSnapshot([['track-1', 1, 1.0001]], 0.5, 0.25));

    expect(store.getMeter('channel', 'track-1')).toMatchObject({
      left: { clipped: false, peak: 1 },
      right: { clipped: true, peak: 1.0001 },
    });

    store.clear();
    expect(store.getMeter('channel', 'track-1')).toBeUndefined();
    expect(notifications).toBe(2);
  });

  it('rejects mutable, duplicate, and malformed subscriptions fail closed', () => {
    const store = createProjectPlaybackMeterStore();
    const snapshot = createSnapshot([['track-1', 0.5, 0.4]], 0.8, 0.7);

    expect(() => store.publish({ ...snapshot })).toThrow(/immutable/);
    expect(() => store.subscribe('channel', '', () => undefined)).toThrow(
      /Track identity/,
    );
    expect(() => store.publish(createSnapshot([
      ['track-1', 0.5, 0.4],
      ['track-1', 0.6, 0.3],
    ], 0.8, 0.7))).toThrow(/invalid|duplicates/);
  });
});

function createSnapshot(
  channels: readonly (readonly [string, number, number])[],
  masterLeft: number,
  masterRight: number,
) {
  return Object.freeze({
    cycleSequence: 1,
    frameEnd: 4,
    frameStart: 0,
    meterSummary: createMixerMeterTapSummary(
      channels.map(([trackId, left, right]) => ({
        accumulator: accumulateMixerSamplePeakBlock(
          createMixerSamplePeakAccumulator(),
          [left],
          [right],
        ),
        trackId,
      })),
      accumulateMixerSamplePeakBlock(
        createMixerSamplePeakAccumulator(),
        [masterLeft],
        [masterRight],
      ),
    ),
    sessionId: 'meter-store-test',
    version: 1 as const,
  });
}
