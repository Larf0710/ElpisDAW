export const MIXER_METER_CONTRACT_VERSION: 1;
export const MIXER_SAMPLE_PEAK_CLIP_THRESHOLD: 1;

export type MixerSampleBlock =
  | readonly number[]
  | Float32Array
  | Float64Array;

export type MixerSamplePeakAccumulator = Readonly<{
  leftPeak: number;
  rightPeak: number;
  sampleCount: number;
  version: typeof MIXER_METER_CONTRACT_VERSION;
}>;

export type MixerSamplePeakChannelSnapshot = Readonly<{
  clipped: boolean;
  peak: number;
}>;

export type MixerSamplePeakSnapshot = Readonly<{
  clipped: boolean;
  left: MixerSamplePeakChannelSnapshot;
  right: MixerSamplePeakChannelSnapshot;
  sampleCount: number;
  version: typeof MIXER_METER_CONTRACT_VERSION;
}>;

export function createMixerSamplePeakAccumulator(): MixerSamplePeakAccumulator;

export function accumulateMixerSamplePeakBlock(
  accumulator: MixerSamplePeakAccumulator,
  leftSamples: MixerSampleBlock,
  rightSamples: MixerSampleBlock,
  scale?: number,
): MixerSamplePeakAccumulator;

export function resetMixerSamplePeakAccumulator(
  accumulator: MixerSamplePeakAccumulator,
): MixerSamplePeakAccumulator;

export function snapshotMixerSamplePeak(
  accumulator: MixerSamplePeakAccumulator,
): MixerSamplePeakSnapshot;
