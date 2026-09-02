import { describe, expect, it } from 'vitest';

import {
  accumulateMixerSamplePeakBlock,
  createMixerSamplePeakAccumulator,
  snapshotMixerSamplePeak,
} from '../shared/mixerMeterContract.js';
import {
  createMixerMasterPeakHoldPresentation,
  createMixerMasterPeakHoldState,
  reduceMixerMasterPeakHoldState,
} from './mixerMasterPeakHold';

describe('Mixer Master Peak Hold', () => {
  it('reports neutral NO DATA without an exact Master observation', () => {
    expect(
      createMixerMasterPeakHoldPresentation(
        createMixerMasterPeakHoldState(),
        undefined,
      ),
    ).toMatchObject({ label: 'NO DATA', tone: 'neutral' });
  });

  it('reports green NO CLIP only from an available non-clipping observation', () => {
    const meter = createMeter(0.7, 0.8);

    expect(
      createMixerMasterPeakHoldPresentation(
        reduceMixerMasterPeakHoldState(createMixerMasterPeakHoldState(), {
          meter,
          type: 'OBSERVE',
        }),
        meter,
      ),
    ).toMatchObject({ label: 'NO CLIP', tone: 'safe' });
  });

  it('latches CLIP across later safe observations until RESET', () => {
    const clippedMeter = createMeter(1.0001, 0.8);
    const safeMeter = createMeter(0.4, 0.5);
    const clipped = reduceMixerMasterPeakHoldState(
      createMixerMasterPeakHoldState(),
      { meter: clippedMeter, type: 'OBSERVE' },
    );
    const held = reduceMixerMasterPeakHoldState(clipped, {
      meter: safeMeter,
      type: 'OBSERVE',
    });

    expect(
      createMixerMasterPeakHoldPresentation(held, safeMeter),
    ).toMatchObject({ label: 'CLIP', tone: 'clipped' });

    const reset = reduceMixerMasterPeakHoldState(held, { type: 'RESET' });

    expect(reset).toEqual(createMixerMasterPeakHoldState());
    expect(
      createMixerMasterPeakHoldPresentation(reset, safeMeter),
    ).toMatchObject({ label: 'NO CLIP', tone: 'safe' });
  });

  it('cannot hide a clip that is still present in the current exact observation', () => {
    const clippedMeter = createMeter(0.9, 1.1);
    const reset = reduceMixerMasterPeakHoldState(
      reduceMixerMasterPeakHoldState(createMixerMasterPeakHoldState(), {
        meter: clippedMeter,
        type: 'OBSERVE',
      }),
      { type: 'RESET' },
    );

    expect(
      createMixerMasterPeakHoldPresentation(reset, clippedMeter),
    ).toMatchObject({ label: 'CLIP', tone: 'clipped' });
  });
});

function createMeter(leftPeak: number, rightPeak: number) {
  return snapshotMixerSamplePeak(
    accumulateMixerSamplePeakBlock(
      createMixerSamplePeakAccumulator(),
      [leftPeak],
      [rightPeak],
    ),
  );
}
