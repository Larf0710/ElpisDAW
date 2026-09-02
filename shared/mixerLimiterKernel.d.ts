import type {
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_SAMPLE_RATE_HZ,
  MixerLimiterEffect,
} from './mixerEffectsContract.js';
import type { MixerEffectSampleBlock } from './mixerEqualizerKernel.js';

export const MIXER_LIMITER_COEFFICIENT_VERSION: 1;
export const MIXER_LIMITER_PROCESSOR_STATE_VERSION: 1;
export const MIXER_LIMITER_CEILING_GUARD_VERSION: 1;

export type MixerLimiterCoefficients = Readonly<{
  ceilingLinear: number;
  release: number;
  version: typeof MIXER_LIMITER_COEFFICIENT_VERSION;
}>;

export type MixerLimiterProcessorState = Readonly<{
  reductionDb: number;
  version: typeof MIXER_LIMITER_PROCESSOR_STATE_VERSION;
}>;

export type MixerLimiterProcessor = Readonly<{
  coefficients: MixerLimiterCoefficients;
  contractVersion: typeof MIXER_EFFECTS_CONTRACT_VERSION;
  effect: MixerLimiterEffect;
  sampleRateHz: typeof MIXER_EFFECTS_SAMPLE_RATE_HZ;
  state: MixerLimiterProcessorState;
}>;

export type MixerLimiterBlockResult = Readonly<{
  leftSamples: MixerEffectSampleBlock;
  processor: MixerLimiterProcessor;
  rightSamples: MixerEffectSampleBlock;
}>;

export function createMixerLimiterProcessor(
  effect: MixerLimiterEffect,
  sampleRateHz?: number,
): MixerLimiterProcessor;

export function processMixerLimiterBlock(
  processor: MixerLimiterProcessor,
  leftSamples: MixerEffectSampleBlock,
  rightSamples: MixerEffectSampleBlock,
): MixerLimiterBlockResult;

export function resetMixerLimiterProcessor(
  processor: MixerLimiterProcessor,
): MixerLimiterProcessor;
