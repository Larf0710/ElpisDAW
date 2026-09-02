import { describe, expect, it } from 'vitest';

import {
  PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE,
  PROJECT_PLAYBACK_AUDIO_WORKLET_METER_INTERVAL_FRAMES,
  PROJECT_PLAYBACK_AUDIO_WORKLET_PROCESSOR_NAME,
  PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
  PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION,
  assertProjectPlaybackAudioWorkletConfiguration,
  assertProjectPlaybackAudioWorkletControlMessage,
  assertProjectPlaybackAudioWorkletEventMessage,
  createProjectPlaybackAudioWorkletCancelMessage,
  createProjectPlaybackAudioWorkletConfiguration,
  createProjectPlaybackAudioWorkletMeterAcknowledgement,
  createProjectPlaybackAudioWorkletScheduleMessage,
  createProjectPlaybackAudioWorkletTerminateMessage,
} from './projectPlaybackAudioWorkletProtocol.js';
import { createProjectPlaybackAudioWorkletProofCase } from './projectPlaybackAudioWorkletCases.js';

describe('Project Playback AudioWorklet production protocol', () => {
  it('freezes one exact production identity and immutable kernel configuration', () => {
    const proofCase = createProjectPlaybackAudioWorkletProofCase(
      'channel-equalizer-mono-pan',
    );
    const configuration = createProjectPlaybackAudioWorkletConfiguration(
      'session-1',
      proofCase.configuration,
    );

    expect(PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID).toBe(
      'humstudio.project-playback-mixer-worklet.v1',
    );
    expect(PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION).toBe(1);
    expect(PROJECT_PLAYBACK_AUDIO_WORKLET_PROCESSOR_NAME).toBe(
      'humstudio-project-playback-mixer-v1',
    );
    expect(configuration).toMatchObject({
      meterIntervalFrames: PROJECT_PLAYBACK_AUDIO_WORKLET_METER_INTERVAL_FRAMES,
      protocolId: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
      protocolVersion: 1,
      sampleRateHz: 44_100,
      sessionId: 'session-1',
    });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.kernelConfiguration)).toBe(true);
    expect(Object.isFrozen(configuration.kernelConfiguration.channels[0].inserts[0])).toBe(
      true,
    );
  });

  it('constructs exact ordered schedule, cancellation, and termination messages', () => {
    const schedule = createProjectPlaybackAudioWorkletScheduleMessage(
      'session-1',
      1,
      256,
      512,
    );
    const cancel = createProjectPlaybackAudioWorkletCancelMessage('session-1', 1);
    const acknowledgement = createProjectPlaybackAudioWorkletMeterAcknowledgement(
      'session-1',
      1,
      512,
    );
    const terminate = createProjectPlaybackAudioWorkletTerminateMessage('session-1');

    expect(schedule).toEqual({
      endFrame: 512,
      protocolId: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
      protocolVersion: 1,
      sequence: 1,
      sessionId: 'session-1',
      startFrame: 256,
      type: PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.scheduleCycle,
    });
    expect(cancel).toMatchObject({ sequence: 1, type: 'CANCEL_CYCLE' });
    expect(acknowledgement).toMatchObject({
      cycleSequence: 1,
      frameEnd: 512,
      type: 'ACKNOWLEDGE_METER',
    });
    expect(terminate).toMatchObject({ type: 'TERMINATE' });
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(Object.isFrozen(cancel)).toBe(true);
    expect(Object.isFrozen(acknowledgement)).toBe(true);
    expect(Object.isFrozen(terminate)).toBe(true);
  });

  it('fails closed on confused versions, exact keys, ranges, and control shapes', () => {
    const proofCase = createProjectPlaybackAudioWorkletProofCase(
      'bypass-transparency',
    );
    const valid = createProjectPlaybackAudioWorkletConfiguration(
      'session-1',
      proofCase.configuration,
    );

    for (const invalid of [
      { ...valid, protocolVersion: 2 },
      { ...valid, sampleRateHz: 48_000 },
      { ...valid, meterIntervalFrames: 127 },
      { ...valid, meterIntervalFrames: 44_101 },
      { ...valid, extra: true },
      { ...valid, sessionId: ' session-1' },
    ]) {
      expect(() => assertProjectPlaybackAudioWorkletConfiguration(invalid)).toThrow(
        TypeError,
      );
    }

    const schedule = createProjectPlaybackAudioWorkletScheduleMessage(
      'session-1',
      1,
      256,
      512,
    );
    for (const invalid of [
      { ...schedule, sequence: 0 },
      { ...schedule, startFrame: -1 },
      { ...schedule, endFrame: 256 },
      { ...schedule, protocolVersion: 99 },
      { ...schedule, unexpected: true },
      { ...schedule, type: 'PLAY' },
      {
        ...createProjectPlaybackAudioWorkletMeterAcknowledgement(
          'session-1',
          1,
          512,
        ),
        frameEnd: 0,
      },
    ]) {
      expect(() => assertProjectPlaybackAudioWorkletControlMessage(invalid)).toThrow(
        TypeError,
      );
    }
  });

  it('accepts only the production event envelope before payload-specific validation', () => {
    const ready = {
      actualSampleRateHz: 44_100,
      inputCount: 1,
      meterIntervalFrames: PROJECT_PLAYBACK_AUDIO_WORKLET_METER_INTERVAL_FRAMES,
      protocolId: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
      protocolVersion: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION,
      sessionId: 'session-1',
      type: PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.ready,
    };

    expect(() => assertProjectPlaybackAudioWorkletEventMessage(ready)).not.toThrow();
    expect(() => assertProjectPlaybackAudioWorkletEventMessage({
      ...ready,
      protocolId: 'humstudio.audio-worklet-equalizer-parity-spike.v1',
    })).toThrow(TypeError);
    expect(() => assertProjectPlaybackAudioWorkletEventMessage({
      ...ready,
      type: 'PCM_SAMPLES',
    })).toThrow(TypeError);
  });
});
