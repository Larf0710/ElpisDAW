import { describe, expect, it, vi } from 'vitest';

import {
  encodeMonoPcm16Wav,
  MicrophoneRecordingRuntime,
} from './microphoneRecordingRuntime';

class FakeAudioTrack {
  label = 'Test Microphone';
  stop = vi.fn();

  getSettings() {
    return { deviceId: 'test-device' };
  }
}

class FakeMediaStream {
  readonly track = new FakeAudioTrack();

  getAudioTracks() {
    return [this.track];
  }

  getTracks() {
    return [this.track];
  }
}

class FakeAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeScriptProcessorNode extends FakeAudioNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;

  emit(samples: number[]) {
    this.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => Float32Array.from(samples),
      },
    } as unknown as AudioProcessingEvent);
  }
}

class FakeAudioContext {
  readonly destination = {};
  readonly mediaSource = new FakeAudioNode();
  readonly mutedGain = Object.assign(new FakeAudioNode(), { gain: { value: 1 } });
  readonly processor = new FakeScriptProcessorNode();
  readonly sampleRate = 48_000;
  close = vi.fn(async () => undefined);
  resume = vi.fn(async () => undefined);
  state: AudioContextState = 'running';

  createGain() {
    return this.mutedGain;
  }

  createMediaStreamSource() {
    return this.mediaSource;
  }

  createScriptProcessor() {
    return this.processor;
  }
}

describe('encodeMonoPcm16Wav', () => {
  it('writes a mono 16-bit PCM WAV header and clamps samples', () => {
    const wav = encodeMonoPcm16Wav(
      [Float32Array.from([-2, -0.5, 0, 0.5, 2])],
      48_000,
    );
    const view = new DataView(wav);
    const text = (offset: number, length: number) =>
      String.fromCharCode(
        ...Array.from({ length }, (_, index) => view.getUint8(offset + index)),
      );

    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(46, true)).toBe(-16_384);
    expect(view.getInt16(48, true)).toBe(0);
    expect(view.getInt16(50, true)).toBe(16_384);
    expect(view.getInt16(52, true)).toBe(32_767);
  });

  it('rejects an invalid sample rate', () => {
    expect(() => encodeMonoPcm16Wav([], 0)).toThrow(
      'WAV sample rate must be a positive number.',
    );
  });
});

describe('MicrophoneRecordingRuntime', () => {
  it('captures input levels and returns a WAV recording', async () => {
    const stream = new FakeMediaStream();
    const context = new FakeAudioContext();
    const onInputLevel = vi.fn();
    const onRecordingProgress = vi.fn();
    const runtime = new MicrophoneRecordingRuntime({
      createAudioContext: () => context as unknown as AudioContext,
      getUserMedia: async () => stream as unknown as MediaStream,
    });

    await expect(
      runtime.prepare({ onInputLevel, onRecordingProgress }),
    ).resolves.toBe(true);
    expect(runtime.state).toBe('PREPARED');
    expect(context.mutedGain.gain.value).toBe(0);

    context.processor.emit([0.1, -0.75, 0.25]);
    expect(onInputLevel).toHaveBeenLastCalledWith(0.75);
    expect(onRecordingProgress).not.toHaveBeenCalled();

    runtime.beginRecording();
    context.processor.emit([0.5, -0.25, 0]);
    expect(onRecordingProgress).toHaveBeenLastCalledWith(3 / 48_000);

    const result = await runtime.finish();

    expect(result.blob.type).toBe('audio/wav');
    expect(result.blob.size).toBe(50);
    expect(result.durationSeconds).toBe(3 / 48_000);
    expect(result.inputDeviceId).toBe('test-device');
    expect(result.inputDeviceLabel).toBe('Test Microphone');
    expect(runtime.state).toBe('IDLE');
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(onInputLevel).toHaveBeenLastCalledWith(0);
  });

  it('cancels a pending microphone request without retaining the late stream', async () => {
    const stream = new FakeMediaStream();
    let resolveStream!: (value: MediaStream) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
    );
    const runtime = new MicrophoneRecordingRuntime({ getUserMedia });

    const preparing = runtime.prepare();

    await expect(runtime.cancel()).resolves.toBe(true);
    resolveStream(stream as unknown as MediaStream);

    await expect(preparing).resolves.toBe(false);
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(runtime.state).toBe('IDLE');
  });

  it('rejects finishing before any audio frames were captured and releases resources', async () => {
    const stream = new FakeMediaStream();
    const context = new FakeAudioContext();
    const runtime = new MicrophoneRecordingRuntime({
      createAudioContext: () => context as unknown as AudioContext,
      getUserMedia: async () => stream as unknown as MediaStream,
    });

    await runtime.prepare();
    runtime.beginRecording();

    await expect(runtime.finish()).rejects.toThrow(
      'Microphone recording did not capture any audio frames.',
    );
    expect(runtime.state).toBe('IDLE');
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });
});
