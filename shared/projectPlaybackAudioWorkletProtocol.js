import { MIXER_EFFECTS_SAMPLE_RATE_HZ } from './mixerEffectsContract.js';
import {
  PROJECT_PLAYBACK_MIXER_KERNEL_VERSION,
  assertProjectPlaybackMixerKernelConfiguration,
  createProjectPlaybackMixerKernelConfiguration,
} from './projectPlaybackMixerKernel.js';

export const PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID =
  'humstudio.project-playback-mixer-worklet.v1';
export const PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION = 1;
export const PROJECT_PLAYBACK_AUDIO_WORKLET_PROCESSOR_NAME =
  'humstudio-project-playback-mixer-v1';
export const PROJECT_PLAYBACK_AUDIO_WORKLET_METER_INTERVAL_FRAMES = 2_205;
export const PROJECT_PLAYBACK_AUDIO_WORKLET_MAX_PENDING_CYCLES = 2;
export const PROJECT_PLAYBACK_AUDIO_WORKLET_MAX_UNACKNOWLEDGED_METERS = 2;

export const PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE = Object.freeze({
  acknowledgeMeter: 'ACKNOWLEDGE_METER',
  cancelCycle: 'CANCEL_CYCLE',
  cycleCanceled: 'CYCLE_CANCELED',
  cycleComplete: 'CYCLE_COMPLETE',
  error: 'ERROR',
  meter: 'METER',
  ready: 'READY',
  scheduleCycle: 'SCHEDULE_CYCLE',
  terminate: 'TERMINATE',
  terminated: 'TERMINATED',
  unsupported: 'UNSUPPORTED',
});

const CONFIGURATION_KEYS = Object.freeze([
  'kernelConfiguration',
  'meterIntervalFrames',
  'protocolId',
  'protocolVersion',
  'sampleRateHz',
  'sessionId',
]);

export function createProjectPlaybackAudioWorkletConfiguration(
  sessionId,
  kernelConfiguration,
  meterIntervalFrames = PROJECT_PLAYBACK_AUDIO_WORKLET_METER_INTERVAL_FRAMES,
) {
  const configuration = {
    kernelConfiguration:
      createProjectPlaybackMixerKernelConfiguration(kernelConfiguration),
    meterIntervalFrames,
    protocolId: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
    protocolVersion: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION,
    sampleRateHz: MIXER_EFFECTS_SAMPLE_RATE_HZ,
    sessionId,
  };
  assertProjectPlaybackAudioWorkletConfiguration(configuration);
  return Object.freeze(configuration);
}

export function assertProjectPlaybackAudioWorkletConfiguration(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CONFIGURATION_KEYS) ||
    value.protocolId !== PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID ||
    value.protocolVersion !== PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION ||
    value.sampleRateHz !== MIXER_EFFECTS_SAMPLE_RATE_HZ ||
    !isTrimmedText(value.sessionId) ||
    !Number.isSafeInteger(value.meterIntervalFrames) ||
    value.meterIntervalFrames < 128 ||
    value.meterIntervalFrames > MIXER_EFFECTS_SAMPLE_RATE_HZ ||
    value.kernelConfiguration?.version !== PROJECT_PLAYBACK_MIXER_KERNEL_VERSION
  ) {
    throw new TypeError('Project Playback AudioWorklet configuration is malformed.');
  }
  assertProjectPlaybackMixerKernelConfiguration(value.kernelConfiguration);
}

export function createProjectPlaybackAudioWorkletScheduleMessage(
  sessionId,
  sequence,
  startFrame,
  endFrame,
) {
  const message = Object.freeze({
    endFrame,
    protocolId: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
    protocolVersion: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION,
    sequence,
    sessionId,
    startFrame,
    type: PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.scheduleCycle,
  });
  assertProjectPlaybackAudioWorkletControlMessage(message);
  return message;
}

export function createProjectPlaybackAudioWorkletCancelMessage(
  sessionId,
  sequence,
) {
  const message = Object.freeze({
    protocolId: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
    protocolVersion: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION,
    sequence,
    sessionId,
    type: PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.cancelCycle,
  });
  assertProjectPlaybackAudioWorkletControlMessage(message);
  return message;
}

export function createProjectPlaybackAudioWorkletMeterAcknowledgement(
  sessionId,
  cycleSequence,
  frameEnd,
) {
  const message = Object.freeze({
    cycleSequence,
    frameEnd,
    protocolId: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
    protocolVersion: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION,
    sessionId,
    type: PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.acknowledgeMeter,
  });
  assertProjectPlaybackAudioWorkletControlMessage(message);
  return message;
}

export function createProjectPlaybackAudioWorkletTerminateMessage(sessionId) {
  const message = Object.freeze({
    protocolId: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
    protocolVersion: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION,
    sessionId,
    type: PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.terminate,
  });
  assertProjectPlaybackAudioWorkletControlMessage(message);
  return message;
}

export function assertProjectPlaybackAudioWorkletControlMessage(value) {
  if (
    !isRecord(value) ||
    value.protocolId !== PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID ||
    value.protocolVersion !== PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION ||
    !isTrimmedText(value.sessionId)
  ) {
    throw new TypeError('Project Playback AudioWorklet control message is malformed.');
  }

  if (value.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.scheduleCycle) {
    if (
      !hasExactKeys(value, [
        'endFrame',
        'protocolId',
        'protocolVersion',
        'sequence',
        'sessionId',
        'startFrame',
        'type',
      ]) ||
      !isSequence(value.sequence) ||
      !Number.isSafeInteger(value.startFrame) ||
      !Number.isSafeInteger(value.endFrame) ||
      value.startFrame < 0 ||
      value.endFrame <= value.startFrame
    ) {
      throw new TypeError('Project Playback AudioWorklet cycle schedule is malformed.');
    }
    return;
  }

  if (value.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.cancelCycle) {
    if (
      !hasExactKeys(value, [
        'protocolId',
        'protocolVersion',
        'sequence',
        'sessionId',
        'type',
      ]) ||
      !isSequence(value.sequence)
    ) {
      throw new TypeError('Project Playback AudioWorklet cycle cancellation is malformed.');
    }
    return;
  }

  if (value.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.acknowledgeMeter) {
    if (
      !hasExactKeys(value, [
        'cycleSequence',
        'frameEnd',
        'protocolId',
        'protocolVersion',
        'sessionId',
        'type',
      ]) ||
      !isSequence(value.cycleSequence) ||
      !Number.isSafeInteger(value.frameEnd) ||
      value.frameEnd <= 0
    ) {
      throw new TypeError('Project Playback AudioWorklet meter acknowledgement is malformed.');
    }
    return;
  }

  if (
    value.type !== PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.terminate ||
    !hasExactKeys(value, [
      'protocolId',
      'protocolVersion',
      'sessionId',
      'type',
    ])
  ) {
    throw new TypeError('Project Playback AudioWorklet control message type is unsupported.');
  }
}

export function assertProjectPlaybackAudioWorkletEventMessage(value) {
  if (
    !isRecord(value) ||
    value.protocolId !== PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID ||
    value.protocolVersion !== PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION ||
    !isTrimmedText(value.sessionId) ||
    !Object.values(PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE).includes(value.type)
  ) {
    throw new TypeError('Project Playback AudioWorklet event message is malformed.');
  }
}

function isSequence(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function hasExactKeys(value, keys) {
  const expected = new Set(keys);
  return Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => expected.has(key));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTrimmedText(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}
