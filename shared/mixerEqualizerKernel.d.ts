import type {
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_SAMPLE_RATE_HZ,
  MixerEqualizerEffect,
} from './mixerEffectsContract.js';

export const MIXER_EQUALIZER_COEFFICIENT_VERSION: 1;
export const MIXER_EQUALIZER_PROCESSOR_STATE_VERSION: 1;

export type MixerEffectSampleBlock =
  | readonly number[]
  | Float32Array
  | Float64Array;

export type MixerEqualizerBiquadCoefficients = Readonly<{
  a1: number;
  a2: number;
  b0: number;
  b1: number;
  b2: number;
  version: typeof MIXER_EQUALIZER_COEFFICIENT_VERSION;
}>;

export type MixerEqualizerCoefficients = Readonly<{
  highShelf: MixerEqualizerBiquadCoefficients;
  lowShelf: MixerEqualizerBiquadCoefficients;
  midPeaking: MixerEqualizerBiquadCoefficients;
  version: typeof MIXER_EQUALIZER_COEFFICIENT_VERSION;
}>;

export type MixerEqualizerBiquadState = Readonly<{
  z1: number;
  z2: number;
}>;

export type MixerEqualizerChannelState = Readonly<{
  highShelf: MixerEqualizerBiquadState;
  lowShelf: MixerEqualizerBiquadState;
  midPeaking: MixerEqualizerBiquadState;
}>;

export type MixerEqualizerProcessorState = Readonly<{
  left: MixerEqualizerChannelState;
  right: MixerEqualizerChannelState;
  version: typeof MIXER_EQUALIZER_PROCESSOR_STATE_VERSION;
}>;

export type MixerEqualizerProcessor = Readonly<{
  coefficients: MixerEqualizerCoefficients;
  contractVersion: typeof MIXER_EFFECTS_CONTRACT_VERSION;
  effect: MixerEqualizerEffect;
  sampleRateHz: typeof MIXER_EFFECTS_SAMPLE_RATE_HZ;
  state: MixerEqualizerProcessorState;
}>;

export type MixerEqualizerBlockResult = Readonly<{
  leftSamples: MixerEffectSampleBlock;
  processor: MixerEqualizerProcessor;
  rightSamples: MixerEffectSampleBlock;
}>;

export function createMixerEqualizerProcessor(
  effect: MixerEqualizerEffect,
  sampleRateHz?: number,
): MixerEqualizerProcessor;

export function processMixerEqualizerBlock(
  processor: MixerEqualizerProcessor,
  leftSamples: MixerEffectSampleBlock,
  rightSamples: MixerEffectSampleBlock,
): MixerEqualizerBlockResult;

export function resetMixerEqualizerProcessor(
  processor: MixerEqualizerProcessor,
): MixerEqualizerProcessor;
