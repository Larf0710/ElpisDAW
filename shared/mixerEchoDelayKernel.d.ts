import type {
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_SAMPLE_RATE_HZ,
  MixerEchoDelayEffect,
} from './mixerEffectsContract.js';
import type { MixerEffectSampleBlock } from './mixerEqualizerKernel.js';

export const MIXER_ECHO_DELAY_COEFFICIENT_VERSION: 1;
export const MIXER_ECHO_DELAY_PROCESSOR_STATE_VERSION: 1;
export const MIXER_ECHO_DELAY_INTERPOLATION_VERSION: 1;
export const MIXER_ECHO_DELAY_FAILURE_RULE_VERSION: 1;
export const MIXER_ECHO_DELAY_MAX_DELAY_SAMPLES: 88_200;
export const MIXER_ECHO_DELAY_INTERPOLATION_GUARD_SAMPLES: 1;
export const MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES: 88_201;
export const MIXER_ECHO_DELAY_RUNTIME_BYTES_PER_PROCESSOR: 705_608;

export type MixerEchoDelayCoefficients = Readonly<{
  bufferCapacitySamples: typeof MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES;
  delayFraction: number;
  delaySamples: number;
  delayWholeSamples: number;
  dry: number;
  feedback: number;
  newerWeight: number;
  version: typeof MIXER_ECHO_DELAY_COEFFICIENT_VERSION;
  wet: number;
}>;

export type MixerEchoDelayProcessorState = Readonly<{
  version: typeof MIXER_ECHO_DELAY_PROCESSOR_STATE_VERSION;
  writeIndex: number;
}>;

export type MixerEchoDelayProcessor = Readonly<{
  coefficients: MixerEchoDelayCoefficients;
  contractVersion: typeof MIXER_EFFECTS_CONTRACT_VERSION;
  effect: MixerEchoDelayEffect;
  sampleRateHz: typeof MIXER_EFFECTS_SAMPLE_RATE_HZ;
  state: MixerEchoDelayProcessorState;
}>;

export type MixerEchoDelayBlockResult = Readonly<{
  leftSamples: MixerEffectSampleBlock;
  processor: MixerEchoDelayProcessor;
  rightSamples: MixerEffectSampleBlock;
}>;

export function createMixerEchoDelayProcessor(
  effect: MixerEchoDelayEffect,
  sampleRateHz?: number,
): MixerEchoDelayProcessor;

export function processMixerEchoDelayBlock(
  processor: MixerEchoDelayProcessor,
  leftSamples: MixerEffectSampleBlock,
  rightSamples: MixerEffectSampleBlock,
): MixerEchoDelayBlockResult;

export function resetMixerEchoDelayProcessor(
  processor: MixerEchoDelayProcessor,
): MixerEchoDelayProcessor;
