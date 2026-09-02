import { describe, expect, it } from 'vitest';

import {
  accumulateMixerSamplePeakBlock,
  createMixerSamplePeakAccumulator,
} from './mixerMeterContract.js';
import {
  MIXER_CHANNEL_METER_TAP_POSITION,
  MIXER_MASTER_METER_TAP_POSITION,
  MIXER_METER_TAP_CONTRACT_VERSION,
  createMixerMeterTapSummary,
} from './mixerMeterTapContract.js';

describe('Mixer meter tap contract v2', () => {
  it('freezes exact Channel and Master tap semantics around sample-peak v1', () => {
    const channel = accumulateMixerSamplePeakBlock(
      createMixerSamplePeakAccumulator(),
      [0.5, -1],
      [1.25, 0],
    );
    const master = accumulateMixerSamplePeakBlock(
      createMixerSamplePeakAccumulator(),
      [0.75, -0.25],
      [-1, 0.5],
    );
    const summary = createMixerMeterTapSummary(
      [{ accumulator: channel, trackId: 'track-a' }],
      master,
    );

    expect(summary).toEqual({
      channelTapPosition: MIXER_CHANNEL_METER_TAP_POSITION,
      channels: [{
        meter: {
          clipped: true,
          left: { clipped: false, peak: 1 },
          right: { clipped: true, peak: 1.25 },
          sampleCount: 2,
          version: 1,
        },
        trackId: 'track-a',
      }],
      master: {
        clipped: false,
        left: { clipped: false, peak: 0.75 },
        right: { clipped: false, peak: 1 },
        sampleCount: 2,
        version: 1,
      },
      masterTapPosition: MIXER_MASTER_METER_TAP_POSITION,
      samplePeakContractVersion: 1,
      schemaVersion: MIXER_METER_TAP_CONTRACT_VERSION,
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.channels)).toBe(true);
    expect(Object.isFrozen(summary.channels[0])).toBe(true);
    expect(Object.isFrozen(summary.channels[0].meter.left)).toBe(true);
    expect(Object.isFrozen(summary.master.right)).toBe(true);
  });

  it('preserves snapshot order without retaining accumulator aliases', () => {
    const accumulator = createMixerSamplePeakAccumulator();
    const entries = [
      { accumulator, trackId: 'track-b' },
      { accumulator, trackId: 'track-a' },
    ];
    const summary = createMixerMeterTapSummary(entries, accumulator);

    entries.reverse();
    expect(summary.channels.map((channel) => channel.trackId)).toEqual([
      'track-b',
      'track-a',
    ]);
    expect(summary.channels[0]).not.toHaveProperty('accumulator');
  });

  it.each([
    ['non-array Channels', null],
    ['duplicate Track identities', [
      { accumulator: createMixerSamplePeakAccumulator(), trackId: 'track-a' },
      { accumulator: createMixerSamplePeakAccumulator(), trackId: 'track-a' },
    ]],
    ['untrimmed Track identity', [
      { accumulator: createMixerSamplePeakAccumulator(), trackId: ' track-a' },
    ]],
    ['extra entry key', [
      {
        accumulator: createMixerSamplePeakAccumulator(),
        extra: true,
        trackId: 'track-a',
      },
    ]],
  ])('rejects %s', (_label, channels) => {
    expect(() => createMixerMeterTapSummary(
      channels as never,
      createMixerSamplePeakAccumulator(),
    )).toThrow();
  });
});
