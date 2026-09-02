import type { MixerMeterTapSummary } from './mixerMeterTapContract.js';
import type { ProjectPlaybackMixerKernelConfiguration } from './projectPlaybackMixerKernel.js';

export const PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID:
  'humstudio.project-playback-mixer-worklet.v1';
export const PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION: 1;
export const PROJECT_PLAYBACK_AUDIO_WORKLET_PROCESSOR_NAME:
  'humstudio-project-playback-mixer-v1';
export const PROJECT_PLAYBACK_AUDIO_WORKLET_METER_INTERVAL_FRAMES: 2_205;
export const PROJECT_PLAYBACK_AUDIO_WORKLET_MAX_PENDING_CYCLES: 2;
export const PROJECT_PLAYBACK_AUDIO_WORKLET_MAX_UNACKNOWLEDGED_METERS: 2;

export const PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE: Readonly<{
  acknowledgeMeter: 'ACKNOWLEDGE_METER';
  cancelCycle: 'CANCEL_CYCLE';
  cycleCanceled: 'CYCLE_CANCELED';
  cycleComplete: 'CYCLE_COMPLETE';
  error: 'ERROR';
  meter: 'METER';
  ready: 'READY';
  scheduleCycle: 'SCHEDULE_CYCLE';
  terminate: 'TERMINATE';
  terminated: 'TERMINATED';
  unsupported: 'UNSUPPORTED';
}>;

export type ProjectPlaybackAudioWorkletConfiguration = Readonly<{
  kernelConfiguration: ProjectPlaybackMixerKernelConfiguration;
  meterIntervalFrames: number;
  protocolId: typeof PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID;
  protocolVersion: typeof PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION;
  sampleRateHz: 44_100;
  sessionId: string;
}>;

export type ProjectPlaybackAudioWorkletMeterMessage = Readonly<{
  cycleSequence: number;
  frameEnd: number;
  frameStart: number;
  meterSummary: MixerMeterTapSummary;
  protocolId: typeof PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID;
  protocolVersion: typeof PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION;
  sessionId: string;
  type: 'METER';
}>;

export function createProjectPlaybackAudioWorkletConfiguration(
  sessionId: string,
  kernelConfiguration: ProjectPlaybackMixerKernelConfiguration,
  meterIntervalFrames?: number,
): ProjectPlaybackAudioWorkletConfiguration;

export function assertProjectPlaybackAudioWorkletConfiguration(
  value: unknown,
): asserts value is ProjectPlaybackAudioWorkletConfiguration;

export function createProjectPlaybackAudioWorkletScheduleMessage(
  sessionId: string,
  sequence: number,
  startFrame: number,
  endFrame: number,
): Readonly<Record<string, unknown>>;

export function createProjectPlaybackAudioWorkletCancelMessage(
  sessionId: string,
  sequence: number,
): Readonly<Record<string, unknown>>;

export function createProjectPlaybackAudioWorkletMeterAcknowledgement(
  sessionId: string,
  cycleSequence: number,
  frameEnd: number,
): Readonly<Record<string, unknown>>;

export function createProjectPlaybackAudioWorkletTerminateMessage(
  sessionId: string,
): Readonly<Record<string, unknown>>;

export function assertProjectPlaybackAudioWorkletControlMessage(
  value: unknown,
): void;

export function assertProjectPlaybackAudioWorkletEventMessage(
  value: unknown,
): void;
