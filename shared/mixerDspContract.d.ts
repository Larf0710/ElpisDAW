export const MIXER_DSP_CONTRACT_VERSION_V1: 1;
export const MIXER_DSP_CONTRACT_VERSION_V2: 2;
export const MIXER_DSP_CONTRACT_VERSION: typeof MIXER_DSP_CONTRACT_VERSION_V1;
export const MIXER_RENDER_SNAPSHOT_VERSION: 1;
export const MIXER_PAN_MIN: -1;
export const MIXER_PAN_MAX: 1;
export const MIXER_SOURCE_CHANNELS_MONO: 1;
export const MIXER_SOURCE_CHANNELS_STEREO: 2;

export type MixerPanMode = 'mono-equal-power' | 'stereo-balance';

export type MixerPanCoefficients = Readonly<{
  leftGain: number;
  mode: MixerPanMode;
  rightGain: number;
  version:
    | typeof MIXER_DSP_CONTRACT_VERSION_V1
    | typeof MIXER_DSP_CONTRACT_VERSION_V2;
}>;

export type MixerChannelDspCoefficients = Readonly<{
  faderGain: number;
  leftOutputGain: number;
  panLeftGain: number;
  panMode: MixerPanMode;
  panRightGain: number;
  rightOutputGain: number;
  version:
    | typeof MIXER_DSP_CONTRACT_VERSION_V1
    | typeof MIXER_DSP_CONTRACT_VERSION_V2;
}>;

export function createMixerPanCoefficients(
  pan: number,
  sourceChannels: 1 | 2,
): MixerPanCoefficients;

export function createMixerPanCoefficientsV2(
  pan: number,
  sourceChannels: 1 | 2,
): MixerPanCoefficients & Readonly<{
  version: typeof MIXER_DSP_CONTRACT_VERSION_V2;
}>;

export function createMixerChannelDspCoefficients(
  faderDb: number,
  pan: number,
  sourceChannels: 1 | 2,
): MixerChannelDspCoefficients;

export function createMixerChannelDspCoefficientsV2(
  faderDb: number,
  pan: number,
  sourceChannels: 1 | 2,
): MixerChannelDspCoefficients & Readonly<{
  version: typeof MIXER_DSP_CONTRACT_VERSION_V2;
}>;

export function decibelsToMixerGain(decibels: number): number;

export function assertMixerPan(pan: unknown): asserts pan is number;
