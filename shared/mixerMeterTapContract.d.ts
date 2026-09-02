import type {
  MIXER_METER_CONTRACT_VERSION,
  MixerSamplePeakAccumulator,
  MixerSamplePeakSnapshot,
} from './mixerMeterContract.js';

export const MIXER_METER_TAP_CONTRACT_VERSION: 2;
export const MIXER_CHANNEL_METER_TAP_POSITION:
  'post-channel-effects-pre-master-sum';
export const MIXER_MASTER_METER_TAP_POSITION:
  'post-master-effects-pre-pcm-clamp';

export type MixerMeterTapSummary = Readonly<{
  channelTapPosition: typeof MIXER_CHANNEL_METER_TAP_POSITION;
  channels: readonly Readonly<{
    meter: MixerSamplePeakSnapshot;
    trackId: string;
  }>[];
  master: MixerSamplePeakSnapshot;
  masterTapPosition: typeof MIXER_MASTER_METER_TAP_POSITION;
  samplePeakContractVersion: typeof MIXER_METER_CONTRACT_VERSION;
  schemaVersion: typeof MIXER_METER_TAP_CONTRACT_VERSION;
}>;

export function createMixerMeterTapSummary(
  channelAccumulators: readonly Readonly<{
    accumulator: MixerSamplePeakAccumulator;
    trackId: string;
  }>[],
  masterAccumulator: MixerSamplePeakAccumulator,
): MixerMeterTapSummary;
