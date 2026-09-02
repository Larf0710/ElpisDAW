import type { MixerSamplePeakSnapshot } from '../shared/mixerMeterContract.js';

export type MixerMasterPeakHoldState = Readonly<{
  clipLatched: boolean;
  heldLeftPeak: number;
  heldRightPeak: number;
}>;

export type MixerMasterPeakHoldAction =
  | Readonly<{ meter: MixerSamplePeakSnapshot; type: 'OBSERVE' }>
  | Readonly<{ type: 'RESET' }>;

export type MixerMasterPeakHoldPresentation = Readonly<{
  label: 'CLIP' | 'NO CLIP' | 'NO DATA';
  message: string;
  tone: 'clipped' | 'neutral' | 'safe';
}>;

export function createMixerMasterPeakHoldState(): MixerMasterPeakHoldState {
  return Object.freeze({
    clipLatched: false,
    heldLeftPeak: 0,
    heldRightPeak: 0,
  });
}

export function reduceMixerMasterPeakHoldState(
  state: MixerMasterPeakHoldState,
  action: MixerMasterPeakHoldAction,
): MixerMasterPeakHoldState {
  if (action.type === 'RESET') {
    return createMixerMasterPeakHoldState();
  }

  return Object.freeze({
    clipLatched: state.clipLatched || action.meter.clipped,
    heldLeftPeak: Math.max(state.heldLeftPeak, action.meter.left.peak),
    heldRightPeak: Math.max(state.heldRightPeak, action.meter.right.peak),
  });
}

export function createMixerMasterPeakHoldPresentation(
  state: MixerMasterPeakHoldState,
  currentMeter: MixerSamplePeakSnapshot | undefined,
): MixerMasterPeakHoldPresentation {
  if (!currentMeter) {
    return {
      label: 'NO DATA',
      message: 'No exact Master meter observation is available.',
      tone: 'neutral',
    };
  }

  if (state.clipLatched || currentMeter.clipped) {
    return {
      label: 'CLIP',
      message: 'An exact Master sample peak above 1.0 is latched.',
      tone: 'clipped',
    };
  }

  return {
    label: 'NO CLIP',
    message: 'Available exact Master observations contain no clipped sample peak.',
    tone: 'safe',
  };
}
