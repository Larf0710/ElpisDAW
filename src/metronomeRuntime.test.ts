import { describe, expect, it, vi } from 'vitest';

import {
  MetronomeRuntime,
  type MetronomeRuntimeDependencies,
} from './metronomeRuntime';
import { createRecordingTimingPlan } from './recordingTiming';

describe('MetronomeRuntime', () => {
  it('schedules Count-In clicks with a distinct beat-one accent', async () => {
    const harness = createHarness();
    const onCountInComplete = vi.fn();
    const plan = createRecordingTimingPlan({
      bpm: 120,
      countInBars: 1,
      recordStartTick: 0,
    });
    const runtime = new MetronomeRuntime(harness.dependencies);

    runtime.start(plan, {
      metronomeEnabled: false,
      onCountInComplete,
      onError: vi.fn(),
      volume: 60,
    });
    await Promise.resolve();

    expect(harness.context.masterGain.gain.value).toBe(0.6);
    expect(harness.context.oscillators.map((oscillator) => oscillator.frequency.value)).toEqual([
      1_760,
      1_320,
      1_320,
      1_320,
    ]);
    expect(harness.context.oscillators.map((oscillator) => oscillator.startTimes[0])).toEqual([
      0.05,
      0.55,
      1.05,
      1.55,
    ]);
    expect(harness.timers.timeouts[0]?.delayMs).toBeCloseTo(2_050);

    harness.timers.timeouts[0]?.callback();
    expect(onCountInComplete).toHaveBeenCalledWith(plan);
  });

  it('continues scheduling recording clicks only when Metronome is enabled', async () => {
    const harness = createHarness();
    const plan = createRecordingTimingPlan({
      bpm: 120,
      countInBars: 0,
      recordStartTick: 0,
    });
    const runtime = new MetronomeRuntime(harness.dependencies);

    runtime.start(plan, {
      metronomeEnabled: true,
      onCountInComplete: vi.fn(),
      onError: vi.fn(),
      volume: 50,
    });
    await Promise.resolve();

    expect(harness.context.oscillators).toHaveLength(1);
    expect(harness.timers.intervals).toHaveLength(1);

    harness.context.currentTime = 0.1;
    harness.timers.intervals[0]?.callback();
    harness.context.currentTime = 0.6;
    harness.timers.intervals[0]?.callback();
    harness.context.currentTime = 1.1;
    harness.timers.intervals[0]?.callback();
    expect(harness.context.oscillators).toHaveLength(4);
    expect(
      harness.context.oscillators.map((oscillator) => oscillator.frequency.value),
    ).toEqual([1_760, 1_320, 1_320, 1_320]);
  });

  it('cancels callbacks and closes AudioContext when stopped', async () => {
    const harness = createHarness();
    const plan = createRecordingTimingPlan({
      bpm: 100,
      countInBars: 2,
      recordStartTick: 0,
    });
    const runtime = new MetronomeRuntime(harness.dependencies);

    runtime.start(plan, {
      metronomeEnabled: true,
      onCountInComplete: vi.fn(),
      onError: vi.fn(),
      volume: 70,
    });
    await Promise.resolve();

    expect(runtime.stop()).toBe(true);
    expect(runtime.isActive()).toBe(false);
    expect(harness.context.close).toHaveBeenCalledOnce();
    expect(harness.timers.clearedTimeouts).toEqual([1]);
    expect(harness.timers.clearedIntervals).toEqual([1]);
    expect(runtime.stop()).toBe(false);
  });

  it('reports AudioContext resume failures and releases the session', async () => {
    const harness = createHarness(new Error('audio permission denied'));
    const onError = vi.fn();
    const plan = createRecordingTimingPlan({
      bpm: 120,
      countInBars: 1,
      recordStartTick: 0,
    });
    const runtime = new MetronomeRuntime(harness.dependencies);

    runtime.start(plan, {
      metronomeEnabled: true,
      onCountInComplete: vi.fn(),
      onError,
      volume: 60,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.isActive()).toBe(false);
    expect(harness.context.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      'Metronome could not start: audio permission denied',
      plan,
    );
  });

  it('rejects invalid Volume and overlapping sessions', () => {
    const harness = createHarness();
    const plan = createRecordingTimingPlan({
      bpm: 120,
      countInBars: 0,
      recordStartTick: 0,
    });
    const runtime = new MetronomeRuntime(harness.dependencies);
    const options = {
      metronomeEnabled: false,
      onCountInComplete: vi.fn(),
      onError: vi.fn(),
      volume: 60,
    };

    expect(() => runtime.start(plan, { ...options, volume: 101 })).toThrow(
      'between 0 and 100',
    );
    runtime.start(plan, options);
    expect(() => runtime.start(plan, options)).toThrow('already active');
  });
});

function createHarness(resumeError?: Error) {
  const context = new FakeAudioContext(resumeError);
  const timers = new FakeTimers();
  const dependencies: MetronomeRuntimeDependencies = {
    createAudioContext: () => context,
    timers,
  };

  return { context, dependencies, timers };
}

class FakeTimers {
  readonly clearedIntervals: number[] = [];
  readonly clearedTimeouts: number[] = [];
  readonly intervals: Array<{ callback: () => void; delayMs: number }> = [];
  readonly timeouts: Array<{ callback: () => void; delayMs: number }> = [];

  clearInterval = (handle: unknown) => {
    this.clearedIntervals.push(handle as number);
  };

  clearTimeout = (handle: unknown) => {
    this.clearedTimeouts.push(handle as number);
  };

  setInterval = (callback: () => void, delayMs: number) => {
    this.intervals.push({ callback, delayMs });
    return this.intervals.length;
  };

  setTimeout = (callback: () => void, delayMs: number) => {
    this.timeouts.push({ callback, delayMs });
    return this.timeouts.length;
  };
}

class FakeAudioContext {
  currentTime = 0;
  readonly destination = {};
  readonly close = vi.fn(async () => undefined);
  readonly masterGain = new FakeGainNode();
  readonly oscillators: FakeOscillatorNode[] = [];

  constructor(private readonly resumeError?: Error) {}

  createGain() {
    return this.oscillators.length === 0 && this.masterGain.connect.mock.calls.length === 0
      ? this.masterGain
      : new FakeGainNode();
  }

  createOscillator() {
    const oscillator = new FakeOscillatorNode();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  async resume() {
    if (this.resumeError) {
      throw this.resumeError;
    }
  }
}

class FakeGainNode {
  readonly connect = vi.fn();
  readonly gain = {
    value: 0,
    exponentialRampToValueAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
  };
}

class FakeOscillatorNode {
  readonly connect = vi.fn();
  readonly frequency = { value: 0 };
  readonly startTimes: number[] = [];
  readonly stopTimes: number[] = [];
  type: OscillatorType = 'sine';

  start = (when = 0) => {
    this.startTimes.push(when);
  };

  stop = (when = 0) => {
    this.stopTimes.push(when);
  };
}
