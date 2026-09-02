import type {
  MixerCompressorEffect,
  MixerEchoDelayEffect,
  MixerEqualizerEffect,
  MixerLimiterEffect,
} from './mixerEffectsContract.js';
import type { MixerEffectSampleBlock } from './mixerEqualizerKernel.js';
import type { MixerMeterTapSummary } from './mixerMeterTapContract.js';

export const PROJECT_PLAYBACK_MIXER_KERNEL_VERSION: 1;
export const PROJECT_PLAYBACK_MIXER_CHANNEL_ORDER: readonly [
  'fader',
  'source-aware-pan',
  'equalizer',
  'compressor',
  'echo-delay',
  'channel-meter',
  'master-sum',
];
export const PROJECT_PLAYBACK_MIXER_MASTER_ORDER: readonly [
  'master-fader',
  'equalizer',
  'compressor',
  'limiter',
  'master-meter',
  'destination',
];

export type ProjectPlaybackMixerKernelInputMapping = Readonly<{
  inputIndex: number;
  sourceChannels: 1 | 2;
}>;

export type ProjectPlaybackMixerKernelChannelConfiguration = Readonly<{
  faderDb: number;
  inputs: readonly ProjectPlaybackMixerKernelInputMapping[];
  inserts: readonly [
    MixerEqualizerEffect,
    MixerCompressorEffect,
    MixerEchoDelayEffect,
  ];
  pan: number;
  trackId: string;
}>;

export type ProjectPlaybackMixerKernelConfiguration = Readonly<{
  channels: readonly ProjectPlaybackMixerKernelChannelConfiguration[];
  master: Readonly<{
    faderDb: number;
    inserts: readonly [
      MixerEqualizerEffect,
      MixerCompressorEffect,
      MixerLimiterEffect,
    ];
  }>;
  meterTapVersion: 2;
  mixerDspVersion: 2;
  sampleRateHz: 44_100;
  version: typeof PROJECT_PLAYBACK_MIXER_KERNEL_VERSION;
}>;

export type ProjectPlaybackMixerKernelProcessor = Readonly<{
  channels: readonly Readonly<Record<string, unknown>>[];
  configuration: ProjectPlaybackMixerKernelConfiguration;
  inputCount: number;
  master: Readonly<Record<string, unknown>>;
  version: typeof PROJECT_PLAYBACK_MIXER_KERNEL_VERSION;
}>;

export type ProjectPlaybackMixerKernelBlockResult = Readonly<{
  leftSamples: MixerEffectSampleBlock;
  processor: ProjectPlaybackMixerKernelProcessor;
  rightSamples: MixerEffectSampleBlock;
}>;

export function createProjectPlaybackMixerKernelConfiguration(
  value: ProjectPlaybackMixerKernelConfiguration,
): ProjectPlaybackMixerKernelConfiguration;

export function assertProjectPlaybackMixerKernelConfiguration(
  value: unknown,
): asserts value is ProjectPlaybackMixerKernelConfiguration;

export function createProjectPlaybackMixerKernelProcessor(
  configuration: ProjectPlaybackMixerKernelConfiguration,
): ProjectPlaybackMixerKernelProcessor;

export function processProjectPlaybackMixerKernelBlock(
  processor: ProjectPlaybackMixerKernelProcessor,
  inputs: readonly (readonly MixerEffectSampleBlock[])[],
  frameCount: number,
): ProjectPlaybackMixerKernelBlockResult;

export function snapshotProjectPlaybackMixerKernelMeters(
  processor: ProjectPlaybackMixerKernelProcessor,
): MixerMeterTapSummary;

export function resetProjectPlaybackMixerKernelMeters(
  processor: ProjectPlaybackMixerKernelProcessor,
): ProjectPlaybackMixerKernelProcessor;

export function estimateProjectPlaybackMixerKernelRuntimeBytes(
  configuration: ProjectPlaybackMixerKernelConfiguration,
): Readonly<{
  delayRuntimeBytes: number;
  delayRuntimeBytesPerChannel: number;
  scheduledChannelCount: number;
}>;
