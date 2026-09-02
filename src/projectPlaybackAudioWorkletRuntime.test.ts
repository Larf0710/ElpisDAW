import { describe, expect, it, vi } from 'vitest';

import {
  PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE,
  PROJECT_PLAYBACK_AUDIO_WORKLET_METER_INTERVAL_FRAMES,
  PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
  PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION,
} from '../shared/projectPlaybackAudioWorkletProtocol.js';
import {
  accumulateMixerSamplePeakBlock,
  createMixerSamplePeakAccumulator,
} from '../shared/mixerMeterContract.js';
import { createMixerMeterTapSummary } from '../shared/mixerMeterTapContract.js';
import { createTestProjectMixerRenderSnapshotV2 } from './projectMixdownTestFixtures';
import type { ProjectPlaybackPlan } from './projectPlaybackPlan';
import type { ProjectPlaybackSchedule } from './projectPlaybackRuntime';
import {
  PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ,
  ProjectPlaybackEffectsRuntimeError,
  createProjectPlaybackEffectsController,
  hasEnabledProjectPlaybackEffects,
} from './projectPlaybackAudioWorkletRuntime';

describe('Project Playback AudioWorklet runtime boundary', () => {
  it('loads, handshakes, freezes the Snapshot, routes stereo input, and tears down', async () => {
    const schedule = createSchedule();
    const originalPlan = JSON.stringify(schedule.plan);
    const harness = createControllerHarness();
    const onError = vi.fn();
    const controller = await createProjectPlaybackEffectsController({
      audioContext: harness.context,
      decodedSources: createDecodedSources(),
      destination: harness.destination,
      environment: harness.environment,
      onError,
      schedules: [schedule],
    });

    expect(harness.addModule).toHaveBeenCalledTimes(1);
    expect(harness.createdName).toBe('humstudio-project-playback-mixer-v1');
    expect(harness.createdOptions).toMatchObject({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const configuration = harness.createdOptions?.processorOptions?.configuration as {
      kernelConfiguration: { channels: readonly { inserts: readonly unknown[] }[] };
    };
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.kernelConfiguration.channels[0].inserts[0])).toBe(
      true,
    );

    const source = new FakeSourceNode();
    controller.connectSource(source as unknown as AudioBufferSourceNode, 'track-1', 2);
    expect(source.connections).toEqual([
      { destination: harness.node, input: 0, output: 0 },
    ]);
    expect(JSON.stringify(schedule.plan)).toBe(originalPlan);
    expect(onError).not.toHaveBeenCalled();

    controller.terminate();
    expect(harness.node.disconnected).toBe(true);
    expect(harness.port.closed).toBe(true);
    expect(harness.port.sent[harness.port.sent.length - 1]).toMatchObject({
      type: 'TERMINATE',
    });
  });

  it('publishes immutable exact meter snapshots without PCM arrays or identity mutation', async () => {
    const schedule = createSchedule();
    const planBefore = JSON.stringify(schedule.plan);
    const harness = createControllerHarness();
    const onError = vi.fn();
    const onMeterSnapshot = vi.fn();
    const controller = await createProjectPlaybackEffectsController({
      audioContext: harness.context,
      decodedSources: createDecodedSources(),
      destination: harness.destination,
      environment: harness.environment,
      onError,
      onMeterSnapshot,
      schedules: [schedule],
    });

    const sequence = controller.scheduleCycle(256, 259);
    const accumulator = accumulateMixerSamplePeakBlock(
      createMixerSamplePeakAccumulator(),
      new Float32Array([1, -1, 1.25]),
      new Float32Array([-1, 0.5, -1.5]),
    );
    harness.port.emit(createEvent(controller.sessionId, 'METER', {
      cycleSequence: sequence,
      frameEnd: 259,
      frameStart: 256,
      meterSummary: createMixerMeterTapSummary(
        [{ accumulator, trackId: 'track-1' }],
        accumulator,
      ),
    }));

    const snapshot = controller.getMeterSnapshot();
    expect(snapshot).toMatchObject({
      cycleSequence: 1,
      frameEnd: 259,
      frameStart: 256,
      meterSummary: {
        channels: [{
          meter: {
            clipped: true,
            left: { clipped: true, peak: 1.25 },
            right: { clipped: true, peak: 1.5 },
            sampleCount: 3,
          },
          trackId: 'track-1',
        }],
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.meterSummary.channels[0].meter.left)).toBe(true);
    expect(onMeterSnapshot).toHaveBeenCalledWith(snapshot);
    expect(harness.port.sent[harness.port.sent.length - 1]).toMatchObject({
      cycleSequence: 1,
      frameEnd: 259,
      type: 'ACKNOWLEDGE_METER',
    });
    expect(JSON.stringify(schedule.plan)).toBe(planBefore);
    expect(harness.port.sent.some(containsSampleArrayField)).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('fails once on stale meter events and never accepts a duplicate observation', async () => {
    const harness = createControllerHarness();
    const onError = vi.fn();
    const controller = await createProjectPlaybackEffectsController({
      audioContext: harness.context,
      decodedSources: createDecodedSources(),
      destination: harness.destination,
      environment: harness.environment,
      onError,
      schedules: [createSchedule()],
    });
    controller.scheduleCycle(256, 260);
    const accumulator = accumulateMixerSamplePeakBlock(
      createMixerSamplePeakAccumulator(),
      new Float32Array([1]),
      new Float32Array([1]),
    );
    const meter = createEvent(controller.sessionId, 'METER', {
      cycleSequence: 1,
      frameEnd: 257,
      frameStart: 256,
      meterSummary: createMixerMeterTapSummary(
        [{ accumulator, trackId: 'track-1' }],
        accumulator,
      ),
    });

    harness.port.emit(meter);
    harness.port.emit(meter);
    harness.port.emit({ ...meter, protocolVersion: 99 });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ reason: 'protocol-failed' });
  });

  it('fails closed on unavailable worklets, module failure, and non-44.1 kHz state', async () => {
    const schedule = createSchedule();
    const base = createControllerHarness();

    await expect(createProjectPlaybackEffectsController({
      audioContext: { ...base.context, sampleRate: 48_000 } as AudioContext,
      decodedSources: createDecodedSources(),
      destination: base.destination,
      environment: base.environment,
      onError: vi.fn(),
      schedules: [schedule],
    })).rejects.toMatchObject({ reason: 'unsupported-sample-rate' });

    await expect(createProjectPlaybackEffectsController({
      audioContext: base.context,
      decodedSources: createDecodedSources(48_000),
      destination: base.destination,
      environment: base.environment,
      onError: vi.fn(),
      schedules: [schedule],
    })).rejects.toMatchObject({ reason: 'source-sample-rate-unsupported' });

    const moduleFailure = createControllerHarness({ moduleFailure: true });
    await expect(createProjectPlaybackEffectsController({
      audioContext: moduleFailure.context,
      decodedSources: createDecodedSources(),
      destination: moduleFailure.destination,
      environment: moduleFailure.environment,
      onError: vi.fn(),
      schedules: [schedule],
    })).rejects.toEqual(expect.objectContaining({
      name: ProjectPlaybackEffectsRuntimeError.name,
      reason: 'module-load-failed',
    }));

    const noWorklet = {
      ...base.context,
      audioWorklet: undefined,
    } as unknown as AudioContext;
    await expect(createProjectPlaybackEffectsController({
      audioContext: noWorklet,
      decodedSources: createDecodedSources(),
      destination: base.destination,
      environment: base.environment,
      onError: vi.fn(),
      schedules: [schedule],
    })).rejects.toMatchObject({ reason: 'audio-worklet-unavailable' });
  });

  it('detects enabled Channel or Master effects without mutating the Snapshot', () => {
    const schedule = createSchedule();
    expect(hasEnabledProjectPlaybackEffects(schedule.plan.mixerSnapshot as never)).toBe(true);
    expect(JSON.stringify(schedule.plan.mixerSnapshot)).toContain('"bypass":false');

    const bypassSnapshot = createTestProjectMixerRenderSnapshotV2([
      { gainDb: 0, pan: 0, trackId: 'track-bypass' },
    ]);
    expect(hasEnabledProjectPlaybackEffects(bypassSnapshot)).toBe(false);
  });
});

class FakePort {
  closed = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: unknown[] = [];
  private readySent = false;

  constructor(private readonly readyMessage: unknown) {}

  close(): void {
    this.closed = true;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  start(): void {
    if (this.readySent) {
      return;
    }
    this.readySent = true;
    queueMicrotask(() => this.emit(this.readyMessage));
  }
}

class FakeWorkletNode {
  disconnected = false;
  onprocessorerror: ((event: Event) => void) | null = null;

  constructor(readonly port: FakePort) {}

  connect(): this {
    return this;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeSourceNode {
  readonly connections: unknown[] = [];

  connect(destination: unknown, output = 0, input = 0): unknown {
    this.connections.push({ destination, input, output });
    return destination;
  }
}

function createControllerHarness(options: { moduleFailure?: boolean } = {}) {
  let createdOptions: AudioWorkletNodeOptions | undefined;
  let createdName: string | undefined;
  let node: FakeWorkletNode | undefined;
  let port: FakePort | undefined;
  const addModule = options.moduleFailure
    ? vi.fn().mockRejectedValue(new Error('missing module'))
    : vi.fn().mockResolvedValue(undefined);
  const destination = {} as AudioNode;
  const context = {
    audioWorklet: { addModule },
    sampleRate: PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ,
  } as unknown as AudioContext;
  const environment = {
    createAudioWorkletNode: (
      _context: AudioContext,
      name: string,
      workletOptions: AudioWorkletNodeOptions,
    ) => {
      createdName = name;
      createdOptions = workletOptions;
      const configuration = workletOptions.processorOptions?.configuration as {
        meterIntervalFrames: number;
        sessionId: string;
      };
      port = new FakePort(createEvent(configuration.sessionId, 'READY', {
        actualSampleRateHz: 44_100,
        delayRuntimeBytes: 705_608,
        inputCount: workletOptions.numberOfInputs,
        meterIntervalFrames: configuration.meterIntervalFrames,
      }));
      node = new FakeWorkletNode(port);
      return node as unknown as AudioWorkletNode;
    },
    handshakeTimeoutMs: 250,
    moduleUrl: '/project-playback-mixer-worklet.js',
  };

  return {
    addModule,
    context,
    destination,
    environment,
    get createdName() { return createdName; },
    get createdOptions() { return createdOptions; },
    get node() {
      if (!node) throw new Error('Worklet node was not created.');
      return node;
    },
    get port() {
      if (!port) throw new Error('Worklet port was not created.');
      return port;
    },
  };
}

function createSchedule(): ProjectPlaybackSchedule {
  const baseSnapshot = createTestProjectMixerRenderSnapshotV2([
    { gainDb: -3, pan: 0.25, trackId: 'track-1' },
  ]);
  const snapshot = {
    ...baseSnapshot,
    channels: [{
      ...baseSnapshot.channels[0],
      inserts: [
        { ...baseSnapshot.channels[0].inserts[0], bypass: false },
        baseSnapshot.channels[0].inserts[1],
        baseSnapshot.channels[0].inserts[2],
      ],
    }],
  } as const;
  const plan = {
    audibleRange: { endTick: 960, startTick: 0 },
    endTick: 960,
    generatedSources: [],
    isIncomplete: false,
    missingSourceCount: 0,
    mixerSnapshot: snapshot,
    purpose: 'all-playback',
    sourceIssues: [],
    startTick: 0,
    target: { kind: 'all' },
    tracks: [{
      clips: [],
      gainDb: -3,
      pan: 0.25,
      trackId: 'track-1',
      trackMuted: false,
    }],
  } as unknown as ProjectPlaybackPlan;
  return {
    durationSeconds: 1,
    endTick: 960,
    masterFaderDb: 0,
    mixerDspVersion: 2,
    plan,
    startTick: 0,
    tracks: [{
      events: [{
        clipId: 'clip-1',
        clipName: 'Clip 1',
        durationSeconds: 1,
        sourceId: 'source-1',
        sourceStartSeconds: 0,
        startOffsetSeconds: 0,
        timelineEndTick: 960,
        timelineStartTick: 0,
      }],
      gainDb: -3,
      pan: 0.25,
      trackId: 'track-1',
    }],
  };
}

function createDecodedSources(sampleRate = 44_100): ReadonlyMap<string, AudioBuffer> {
  return new Map([[
    'source-1',
    {
      duration: 1,
      numberOfChannels: 2,
      sampleRate,
    } as AudioBuffer,
  ]]);
}

function createEvent(
  sessionId: string,
  type: string,
  payload: Readonly<Record<string, unknown>>,
) {
  return {
    ...payload,
    protocolId: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
    protocolVersion: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION,
    sessionId,
    type,
  };
}

function containsSampleArrayField(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    Object.keys(value).some((key) => /samples|pcm|audio/i.test(key));
}
