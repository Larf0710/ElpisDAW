export const MIXER_EFFECTS_CONTRACT_VERSION: 1;
export const MIXER_EFFECTS_SAMPLE_RATE_HZ: 44_100;
export const MIXER_EFFECTS_DENORMAL_THRESHOLD: 1e-20;

export const MIXER_EFFECT_TYPE_EQUALIZER: 'equalizer';
export const MIXER_EQUALIZER_ALGORITHM_ID: 'humstudio.equalizer.3band-tdf2.v1';
export const MIXER_EQUALIZER_ALGORITHM_VERSION: 1;
export const MIXER_EQUALIZER_SHELF_SLOPE: 1;
export const MIXER_EQUALIZER_STAGE_ORDER: readonly [
  'low-shelf',
  'peaking-mid',
  'high-shelf',
];

export const MIXER_EFFECT_TYPE_COMPRESSOR: 'compressor';
export const MIXER_COMPRESSOR_ALGORITHM_ID: 'humstudio.compressor.linked-peak.v1';
export const MIXER_COMPRESSOR_ALGORITHM_VERSION: 1;

export const MIXER_EFFECT_TYPE_LIMITER: 'limiter';
export const MIXER_LIMITER_ALGORITHM_ID: 'humstudio.limiter.linked-sample-peak.v1';
export const MIXER_LIMITER_ALGORITHM_VERSION: 1;
export const MIXER_LIMITER_TOPOLOGY_INVARIANT_VERSION: 1;
export const MIXER_LIMITER_TOPOLOGY_INVARIANT: Readonly<{
  effectType: typeof MIXER_EFFECT_TYPE_LIMITER;
  enabledChainPosition: 'last';
  insertTarget: 'master';
  version: typeof MIXER_LIMITER_TOPOLOGY_INVARIANT_VERSION;
}>;

export const MIXER_EFFECT_TYPE_ECHO_DELAY: 'echo-delay';
export const MIXER_ECHO_DELAY_ALGORITHM_ID: 'humstudio.echo-delay.stereo-feedback.v1';
export const MIXER_ECHO_DELAY_ALGORITHM_VERSION: 1;
export const MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT_VERSION: 1;
export const MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT: Readonly<{
  effectType: typeof MIXER_EFFECT_TYPE_ECHO_DELAY;
  enabledChainPosition: 'after-compressor';
  insertTarget: 'channel';
  version: typeof MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT_VERSION;
}>;

export type MixerEqualizerParameterName =
  | 'highFrequencyHz'
  | 'highGainDb'
  | 'lowFrequencyHz'
  | 'lowGainDb'
  | 'midFrequencyHz'
  | 'midGainDb'
  | 'midQ';

export type MixerEqualizerParameters = Readonly<{
  highFrequencyHz: number;
  highGainDb: number;
  lowFrequencyHz: number;
  lowGainDb: number;
  midFrequencyHz: number;
  midGainDb: number;
  midQ: number;
}>;

export type MixerCompressorParameterName =
  | 'attackMs'
  | 'kneeDb'
  | 'makeupGainDb'
  | 'ratio'
  | 'releaseMs'
  | 'thresholdDb';

export type MixerCompressorParameters = Readonly<{
  attackMs: number;
  kneeDb: number;
  makeupGainDb: number;
  ratio: number;
  releaseMs: number;
  thresholdDb: number;
}>;

export type MixerLimiterParameterName = 'ceilingDb' | 'releaseMs';

export type MixerLimiterParameters = Readonly<{
  ceilingDb: number;
  releaseMs: number;
}>;

export type MixerEchoDelayParameterName =
  | 'delayTimeMs'
  | 'dry'
  | 'feedback'
  | 'wet';

export type MixerEchoDelayParameters = Readonly<{
  delayTimeMs: number;
  dry: number;
  feedback: number;
  wet: number;
}>;

export type MixerEffectParameterSpec = Readonly<{
  defaultValue: number;
  maximum: number;
  minimum: number;
}>;

export const MIXER_EQUALIZER_PARAMETER_SPECS: Readonly<
  Record<MixerEqualizerParameterName, MixerEffectParameterSpec>
>;

export const MIXER_EQUALIZER_DEFAULT_PARAMETERS: MixerEqualizerParameters;

export const MIXER_COMPRESSOR_PARAMETER_SPECS: Readonly<
  Record<MixerCompressorParameterName, MixerEffectParameterSpec>
>;

export const MIXER_COMPRESSOR_DEFAULT_PARAMETERS: MixerCompressorParameters;

export const MIXER_LIMITER_PARAMETER_SPECS: Readonly<
  Record<MixerLimiterParameterName, MixerEffectParameterSpec>
>;

export const MIXER_LIMITER_DEFAULT_PARAMETERS: MixerLimiterParameters;

export const MIXER_ECHO_DELAY_PARAMETER_SPECS: Readonly<
  Record<MixerEchoDelayParameterName, MixerEffectParameterSpec>
>;

export const MIXER_ECHO_DELAY_DEFAULT_PARAMETERS: MixerEchoDelayParameters;

export type MixerEqualizerEffect = Readonly<{
  effectType: typeof MIXER_EFFECT_TYPE_EQUALIZER;
  algorithmId: typeof MIXER_EQUALIZER_ALGORITHM_ID;
  algorithmVersion: typeof MIXER_EQUALIZER_ALGORITHM_VERSION;
  bypass: boolean;
  parameters: MixerEqualizerParameters;
}>;

export type MixerCompressorEffect = Readonly<{
  effectType: typeof MIXER_EFFECT_TYPE_COMPRESSOR;
  algorithmId: typeof MIXER_COMPRESSOR_ALGORITHM_ID;
  algorithmVersion: typeof MIXER_COMPRESSOR_ALGORITHM_VERSION;
  bypass: boolean;
  parameters: MixerCompressorParameters;
}>;

export type MixerLimiterEffect = Readonly<{
  effectType: typeof MIXER_EFFECT_TYPE_LIMITER;
  algorithmId: typeof MIXER_LIMITER_ALGORITHM_ID;
  algorithmVersion: typeof MIXER_LIMITER_ALGORITHM_VERSION;
  bypass: boolean;
  parameters: MixerLimiterParameters;
}>;

export type MixerEchoDelayEffect = Readonly<{
  effectType: typeof MIXER_EFFECT_TYPE_ECHO_DELAY;
  algorithmId: typeof MIXER_ECHO_DELAY_ALGORITHM_ID;
  algorithmVersion: typeof MIXER_ECHO_DELAY_ALGORITHM_VERSION;
  bypass: boolean;
  parameters: MixerEchoDelayParameters;
}>;

export type MixerEffectState =
  | MixerEqualizerEffect
  | MixerCompressorEffect
  | MixerLimiterEffect
  | MixerEchoDelayEffect;

export function createMixerEqualizerEffect(
  parameters?: MixerEqualizerParameters,
  bypass?: boolean,
): MixerEqualizerEffect;

export function createDefaultMixerEqualizerEffect(): MixerEqualizerEffect;

export function createMixerCompressorEffect(
  parameters?: MixerCompressorParameters,
  bypass?: boolean,
): MixerCompressorEffect;

export function createDefaultMixerCompressorEffect(): MixerCompressorEffect;

export function createMixerLimiterEffect(
  parameters?: MixerLimiterParameters,
  bypass?: boolean,
): MixerLimiterEffect;

export function createDefaultMixerLimiterEffect(): MixerLimiterEffect;

export function createMixerEchoDelayEffect(
  parameters?: MixerEchoDelayParameters,
  bypass?: boolean,
): MixerEchoDelayEffect;

export function createDefaultMixerEchoDelayEffect(): MixerEchoDelayEffect;

export function createMixerEffectSnapshot(
  effect: MixerEqualizerEffect,
  sampleRateHz?: number,
): MixerEqualizerEffect;

export function createMixerEffectSnapshot(
  effect: MixerCompressorEffect,
  sampleRateHz?: number,
): MixerCompressorEffect;

export function createMixerEffectSnapshot(
  effect: MixerLimiterEffect,
  sampleRateHz?: number,
): MixerLimiterEffect;

export function createMixerEffectSnapshot(
  effect: MixerEchoDelayEffect,
  sampleRateHz?: number,
): MixerEchoDelayEffect;

export function createMixerEffectSnapshot(
  effect: MixerEffectState,
  sampleRateHz?: number,
): MixerEffectState;

export function assertMixerEffectState(
  effect: unknown,
  sampleRateHz?: number,
): asserts effect is MixerEffectState;

export function assertMixerEffectsSampleRate(
  sampleRateHz: unknown,
): asserts sampleRateHz is typeof MIXER_EFFECTS_SAMPLE_RATE_HZ;

export function assertMixerEqualizerParameters(
  parameters: unknown,
  sampleRateHz?: number,
): asserts parameters is MixerEqualizerParameters;

export function assertMixerCompressorParameters(
  parameters: unknown,
  sampleRateHz?: number,
): asserts parameters is MixerCompressorParameters;

export function assertMixerLimiterParameters(
  parameters: unknown,
  sampleRateHz?: number,
): asserts parameters is MixerLimiterParameters;

export function assertMixerEchoDelayParameters(
  parameters: unknown,
  sampleRateHz?: number,
): asserts parameters is MixerEchoDelayParameters;
