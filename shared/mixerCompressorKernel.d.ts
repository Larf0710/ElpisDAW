import type {
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_SAMPLE_RATE_HZ,
  MixerCompressorEffect,
} from './mixerEffectsContract.js';
import type { MixerEffectSampleBlock } from './mixerEqualizerKernel.js';

export const MIXER_COMPRESSOR_COEFFICIENT_VERSION: 1;
export const MIXER_COMPRESSOR_PROCESSOR_STATE_VERSION: 1;

export type MixerCompressorCoefficients = Readonly<{
  attack: number;
  release: number;
  version: typeof MIXER_COMPRESSOR_COEFFICIENT_VERSION;
}>;

export type MixerCompressorProcessorState = Readonly<{
  reductionDb: number;
  version: typeof MIXER_COMPRESSOR_PROCESSOR_STATE_VERSION;
}>;

export type MixerCompressorProcessor = Readonly<{
  coefficients: MixerCompressorCoefficients;
  contractVersion: typeof MIXER_EFFECTS_CONTRACT_VERSION;
  effect: MixerCompressorEffect;
  sampleRateHz: typeof MIXER_EFFECTS_SAMPLE_RATE_HZ;
  state: MixerCompressorProcessorState;
}>;

export type MixerCompressorBlockResult = Readonly<{
  leftSamples: MixerEffectSampleBlock;
  processor: MixerCompressorProcessor;
  rightSamples: MixerEffectSampleBlock;
}>;

export function createMixerCompressorProcessor(
  effect: MixerCompressorEffect,
  sampleRateHz?: number,
): MixerCompressorProcessor;

export function processMixerCompressorBlock(
  processor: MixerCompressorProcessor,
  leftSamples: MixerEffectSampleBlock,
  rightSamples: MixerEffectSampleBlock,
): MixerCompressorBlockResult;

export function resetMixerCompressorProcessor(
  processor: MixerCompressorProcessor,
): MixerCompressorProcessor;
