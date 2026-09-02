import { describe, expect, it, vi } from 'vitest';

import {
  InstrumentAudioPreviewRuntime,
  type InstrumentAudioPreviewCallbacks,
  type InstrumentAudioPreviewPlan,
} from './instrumentAudioPreviewRuntime';
import { decibelsToLinearGain } from './projectPlaybackRuntime';

class FakeGainNode {
  readonly gain = { value: 1 };
  connectedTo?: unknown;
  disconnected = false;

  connect(destination: unknown): void {
    this.connectedTo = destination;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeAudioBufferSourceNode {
  buffer: AudioBuffer | null = null;
  connectedTo?: unknown;
  disconnected = false;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;

  connect(destination: unknown): void {
    this.connectedTo = destination;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }
}

class FakeAudioContext {
  readonly destination = {};
  readonly gainNode = new FakeGainNode();
  readonly sourceNode = new FakeAudioBufferSourceNode();
  close = vi.fn(async () => undefined);
  createBufferSource = vi.fn(() => this.sourceNode as unknown as AudioBufferSourceNode);
  createGain = vi.fn(() => this.gainNode as unknown as GainNode);
  decodeAudioData = vi.fn(async () => ({ duration: 1 }) as AudioBuffer);
  resume = vi.fn(async () => undefined);
}

const plan: InstrumentAudioPreviewPlan = {
  artifactId: 'artifact-audio-1',
  clipId: 'clip-instrument-1',
  clipName: 'Instrument Take',
  clipTakeId: 'clip-take-audio-1',
  gainDb: -6,
  sourceId: 'artifact-audio-1',
};

function createCallbacks(): InstrumentAudioPreviewCallbacks {
  return {
    onComplete: vi.fn(),
    onError: vi.fn(),
    onStarted: vi.fn(),
  };
}

function createWav(): Blob {
  return new Blob([new Uint8Array(48)], { type: 'audio/wav' });
}

function createDeferred<T>(): Readonly<{
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

describe('InstrumentAudioPreviewRuntime', () => {
  it('decodes and plays the generated WAV at the frozen Track Gain', async () => {
    const audioContext = new FakeAudioContext();
    const callbacks = createCallbacks();
    const runtime = new InstrumentAudioPreviewRuntime({
      createAudioContext: () => audioContext as unknown as AudioContext,
    });

    runtime.play(Promise.resolve(createWav()), plan, callbacks);

    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledWith(plan));

    expect(runtime.isActive()).toBe(true);
    expect(audioContext.resume).toHaveBeenCalledOnce();
    expect(audioContext.decodeAudioData).toHaveBeenCalledOnce();
    expect(audioContext.gainNode.gain.value).toBeCloseTo(decibelsToLinearGain(-6));
    expect(audioContext.sourceNode.connectedTo).toBe(audioContext.gainNode);
    expect(audioContext.sourceNode.started).toBe(true);
  });

  it('completes once and releases every Web Audio resource', async () => {
    const audioContext = new FakeAudioContext();
    const callbacks = createCallbacks();
    const runtime = new InstrumentAudioPreviewRuntime({
      createAudioContext: () => audioContext as unknown as AudioContext,
    });

    runtime.play(Promise.resolve(createWav()), plan, callbacks);
    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledOnce());
    audioContext.sourceNode.onended?.();

    expect(callbacks.onComplete).toHaveBeenCalledWith(plan);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(runtime.isActive()).toBe(false);
    expect(audioContext.sourceNode.stopped).toBe(true);
    expect(audioContext.sourceNode.disconnected).toBe(true);
    expect(audioContext.gainNode.disconnected).toBe(true);
    expect(audioContext.close).toHaveBeenCalledOnce();
  });

  it('cancels a pending read without starting playback after it resolves', async () => {
    const audioContext = new FakeAudioContext();
    const callbacks = createCallbacks();
    const wav = createDeferred<Blob>();
    const runtime = new InstrumentAudioPreviewRuntime({
      createAudioContext: () => audioContext as unknown as AudioContext,
    });

    runtime.play(wav.promise, plan, callbacks);

    expect(runtime.stop()).toBe(plan);
    wav.resolve(createWav());
    await wav.promise;
    await Promise.resolve();

    expect(runtime.isActive()).toBe(false);
    expect(audioContext.decodeAudioData).not.toHaveBeenCalled();
    expect(audioContext.sourceNode.started).toBe(false);
    expect(callbacks.onStarted).not.toHaveBeenCalled();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(audioContext.gainNode.disconnected).toBe(true);
    expect(audioContext.close).toHaveBeenCalledOnce();
  });

  it('reports decode failures and releases the active preview', async () => {
    const audioContext = new FakeAudioContext();
    audioContext.decodeAudioData.mockRejectedValueOnce(new Error('Unsupported audio data.'));
    const callbacks = createCallbacks();
    const runtime = new InstrumentAudioPreviewRuntime({
      createAudioContext: () => audioContext as unknown as AudioContext,
    });

    runtime.play(Promise.resolve(createWav()), plan, callbacks);

    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith(
      'Instrument Audio Preview failed: Unsupported audio data.',
      plan,
    ));

    expect(callbacks.onStarted).not.toHaveBeenCalled();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(runtime.isActive()).toBe(false);
    expect(audioContext.gainNode.disconnected).toBe(true);
    expect(audioContext.close).toHaveBeenCalledOnce();
  });

  it('reports generated WAV read failures and never creates a source node', async () => {
    const audioContext = new FakeAudioContext();
    const callbacks = createCallbacks();
    const runtime = new InstrumentAudioPreviewRuntime({
      createAudioContext: () => audioContext as unknown as AudioContext,
    });

    runtime.play(
      Promise.reject(new Error('Local Engine generated audio read failed.')),
      plan,
      callbacks,
    );

    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith(
      'Instrument Audio Preview failed: Local Engine generated audio read failed.',
      plan,
    ));

    expect(audioContext.createBufferSource).not.toHaveBeenCalled();
    expect(callbacks.onStarted).not.toHaveBeenCalled();
    expect(runtime.isActive()).toBe(false);
    expect(audioContext.gainNode.disconnected).toBe(true);
    expect(audioContext.close).toHaveBeenCalledOnce();
  });
});
