// @ts-expect-error Vitest executes this optional retained-fixture probe in Node.
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMixerChannelDspCoefficients } from '../shared/mixerDspContract.js';
import {
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
import type { ProjectPlaybackPlan, ResolvedPlaybackClip } from './projectPlaybackPlan';
import {
  createProjectPlaybackSchedule,
  decibelsToLinearGain,
  ProjectPlaybackRuntime,
  type ProjectPlaybackAudioSource,
  type ProjectPlaybackSchedule,
} from './projectPlaybackRuntime';

afterEach(() => {
  vi.unstubAllGlobals();
});

const testProcess = (globalThis as typeof globalThis & {
  process?: { env: Record<string, string | undefined> };
}).process;
const realGeneratedPlaybackFixturePaths = [
  testProcess?.env.HUMSTUDIO_SA3_PLAYBACK_FIXTURE,
  testProcess?.env.HUMSTUDIO_ACE_PLAYBACK_FIXTURE,
].filter((value): value is string => typeof value === 'string' && value.length > 0);

function createClip(overrides: Partial<ResolvedPlaybackClip> = {}): ResolvedPlaybackClip {
  return {
    clipId: 'clip-1',
    clipName: 'Clip 1',
    originalClipEndTick: 960,
    originalClipStartTick: 0,
    sourceEndSeconds: 1,
    sourceId: 'source-1',
    sourceStartSeconds: 0,
    timelineEndTick: 960,
    timelineStartTick: 0,
    ...overrides,
  };
}

function createPlan(
  overrides: Partial<ProjectPlaybackPlan> = {},
): ProjectPlaybackPlan {
  const mixerSnapshot = overrides.mixerSnapshot ?? {
    channels: [
      {
        faderDb: -6,
        inserts: [],
        muted: false,
        outputBusId: 'stereo-master' as const,
        pan: 0,
        solo: false,
        trackId: 'track-1',
      },
    ],
    master: {
      busId: 'stereo-master' as const,
      faderDb: 0,
      inserts: [],
    },
    schemaVersion: 1 as const,
  };

  return {
    audibleRange: { endTick: 2880, startTick: 0 },
    endTick: 2880,
    generatedSources: [],
    isIncomplete: false,
    missingSourceCount: 0,
    purpose: 'selection-playback',
    sourceIssues: [],
    startTick: 0,
    target: { kind: 'track', trackId: 'track-1' },
    tracks: [
      {
        clips: [
          createClip(),
          createClip({
            clipId: 'clip-2',
            clipName: 'Clip 2',
            originalClipEndTick: 2880,
            originalClipStartTick: 1920,
            sourceEndSeconds: 4,
            sourceId: 'source-2',
            sourceStartSeconds: 3,
            timelineEndTick: 2880,
            timelineStartTick: 1920,
          }),
        ],
        gainDb: -6,
        pan: 0,
        trackId: 'track-1',
        trackMuted: false,
      },
    ],
    ...overrides,
    mixerSnapshot,
  };
}

describe('createProjectPlaybackSchedule', () => {
  it('carries the exact shared Channel Pan and Master Fader contract into ALL Playback', () => {
    const base = createPlan();
    const plan: ProjectPlaybackPlan = {
      ...base,
      mixerSnapshot: {
        ...base.mixerSnapshot,
        channels: [
          {
            ...base.mixerSnapshot.channels[0],
            pan: 0.5,
          },
        ],
        master: {
          ...base.mixerSnapshot.master,
          faderDb: -3,
        },
      },
      purpose: 'all-playback',
      target: { kind: 'all' },
      tracks: base.tracks.map((track) => ({ ...track, pan: 0.5 })),
    };
    const result = createProjectPlaybackSchedule(plan, 60);

    expect(result.canSchedule).toBe(true);

    if (!result.canSchedule) {
      return;
    }

    expect(result.schedule).toMatchObject({
      masterFaderDb: -3,
      mixerDspVersion: 1,
      tracks: [{ gainDb: -6, pan: 0.5, trackId: 'track-1' }],
    });
    expect(
      createMixerChannelDspCoefficients(
        result.schedule.tracks[0].gainDb,
        result.schedule.tracks[0].pan,
        1,
      ),
    ).toMatchObject({
      panMode: 'mono-equal-power',
      version: result.schedule.mixerDspVersion,
    });
  });

  it('rejects incomplete, non-finite, or conflicting Mixer DSP state before scheduling', () => {
    const plan = createPlan();
    const panMismatch = {
      ...plan,
      tracks: plan.tracks.map((track) => ({ ...track, pan: 0.25 })),
    };
    const nonFiniteMaster = {
      ...plan,
      mixerSnapshot: {
        ...plan.mixerSnapshot,
        master: { ...plan.mixerSnapshot.master, faderDb: Number.NaN },
      },
    };

    expect(createProjectPlaybackSchedule(panMismatch, 60)).toMatchObject({
      canSchedule: false,
      reason: 'invalid-plan',
    });
    expect(
      createProjectPlaybackSchedule(
        nonFiniteMaster as ProjectPlaybackPlan,
        60,
      ),
    ).toMatchObject({ canSchedule: false, reason: 'invalid-plan' });
  });

  it('keeps Timeline gaps between multiple Clips on one Track', () => {
    const result = createProjectPlaybackSchedule(createPlan(), 60);

    expect(result.canSchedule).toBe(true);

    if (!result.canSchedule) {
      return;
    }

    expect(result.schedule.durationSeconds).toBe(3);
    expect(result.schedule.tracks[0].events).toHaveLength(2);
    expect(result.schedule.tracks[0].events[0]).toMatchObject({
      clipId: 'clip-1',
      durationSeconds: 1,
      startOffsetSeconds: 0,
    });
    expect(result.schedule.tracks[0].events[1]).toMatchObject({
      clipId: 'clip-2',
      durationSeconds: 1,
      sourceStartSeconds: 3,
      startOffsetSeconds: 2,
    });
  });

  it('schedules multiple Tracks on the same Project clock with independent Gain', () => {
    const plan = createPlan();
    const result = createProjectPlaybackSchedule(
      {
        ...plan,
        mixerSnapshot: {
          ...plan.mixerSnapshot,
          channels: [
            ...plan.mixerSnapshot.channels,
            {
              faderDb: -12,
              inserts: [],
              muted: false,
              outputBusId: 'stereo-master' as const,
              pan: 0,
              solo: false,
              trackId: 'track-2',
            },
          ],
        },
        target: { kind: 'tracks', trackIds: ['track-1', 'track-2'] },
        tracks: [
          ...plan.tracks,
          {
            clips: [
              createClip({
                clipId: 'track-2-clip',
                clipName: 'Track 2 Clip',
                sourceId: 'track-2-source',
              }),
            ],
            gainDb: -12,
            pan: 0,
            trackId: 'track-2',
            trackMuted: false,
          },
        ],
      },
      60,
    );

    expect(result.canSchedule).toBe(true);

    if (!result.canSchedule) {
      return;
    }

    expect(result.schedule.tracks).toHaveLength(2);
    expect(result.schedule.tracks.map((track) => ({
      gainDb: track.gainDb,
      startOffsetSeconds: track.events[0].startOffsetSeconds,
      trackId: track.trackId,
    }))).toEqual([
      { gainDb: -6, startOffsetSeconds: 0, trackId: 'track-1' },
      { gainDb: -12, startOffsetSeconds: 0, trackId: 'track-2' },
    ]);
  });

  it('uses the frozen Plan start when playback begins inside a Clip', () => {
    const plan = createPlan({
      startTick: 480,
      tracks: [
        {
          clips: [
            createClip({
              sourceEndSeconds: 1,
              sourceStartSeconds: 0.5,
              timelineStartTick: 480,
            }),
            createClip({
              clipId: 'clip-2',
              clipName: 'Clip 2',
              originalClipEndTick: 2880,
              originalClipStartTick: 1920,
              sourceEndSeconds: 4,
              sourceId: 'source-2',
              sourceStartSeconds: 3,
              timelineEndTick: 2880,
              timelineStartTick: 1920,
            }),
          ],
          gainDb: -6,
          pan: 0,
          trackId: 'track-1',
          trackMuted: false,
        },
      ],
    });
    const result = createProjectPlaybackSchedule(plan, 60);

    expect(result.canSchedule).toBe(true);

    if (!result.canSchedule) {
      return;
    }

    expect(result.schedule.startTick).toBe(480);
    expect(result.schedule.tracks[0].events[0]).toMatchObject({
      durationSeconds: 0.5,
      sourceStartSeconds: 0.5,
      startOffsetSeconds: 0,
    });
    expect(result.schedule.tracks[0].events[1].startOffsetSeconds).toBe(1.5);
  });

  it('clips scheduled events to an audible Loop end', () => {
    const plan = createPlan({
      audibleRange: { endTick: 2400, startTick: 0 },
      endTick: 3840,
      tracks: [
        {
          clips: [
            createClip({
              clipId: 'long-clip',
              clipName: 'Long Clip',
              originalClipEndTick: 2880,
              originalClipStartTick: 1920,
              sourceEndSeconds: 5,
              sourceId: 'long-source',
              sourceStartSeconds: 3,
              timelineEndTick: 2880,
              timelineStartTick: 1920,
            }),
          ],
          gainDb: -6,
          pan: 0,
          trackId: 'track-1',
          trackMuted: false,
        },
      ],
    });
    const result = createProjectPlaybackSchedule(plan, 60, { endTick: 2400 });

    expect(result.canSchedule).toBe(true);

    if (!result.canSchedule) {
      return;
    }

    expect(result.schedule.durationSeconds).toBe(2.5);
    expect(result.schedule.tracks[0].events[0]).toMatchObject({
      durationSeconds: 0.5,
      sourceStartSeconds: 3,
      timelineEndTick: 2400,
    });
  });

  it('sorts equal-position Clips deterministically', () => {
    const plan = createPlan({
      endTick: 960,
      tracks: [
        {
          clips: [
            createClip({ clipId: 'clip-z', clipName: 'Z' }),
            createClip({ clipId: 'clip-a', clipName: 'A', sourceId: 'source-2' }),
          ],
          gainDb: -6,
          pan: 0,
          trackId: 'track-1',
          trackMuted: false,
        },
      ],
    });
    const result = createProjectPlaybackSchedule(plan, 60);

    expect(result.canSchedule).toBe(true);

    if (result.canSchedule) {
      expect(result.schedule.tracks[0].events.map((event) => event.clipId)).toEqual([
        'clip-a',
        'clip-z',
      ]);
    }
  });

  it('locks duplicate Track graph identities', () => {
    const plan = createPlan();
    const result = createProjectPlaybackSchedule(
      { ...plan, tracks: [...plan.tracks, { ...plan.tracks[0] }] },
      60,
    );

    expect(result).toMatchObject({
      canSchedule: false,
      reason: 'invalid-plan',
    });
  });

  it('keeps an ALL Playback clock running through trailing Project silence', () => {
    const result = createProjectPlaybackSchedule(
      createPlan({
        endTick: 3840,
        purpose: 'all-playback',
        startTick: 2880,
        target: { kind: 'all' },
        tracks: [],
      }),
      60,
    );

    expect(result.canSchedule).toBe(true);

    if (result.canSchedule) {
      expect(result.schedule).toMatchObject({
        durationSeconds: 1,
        endTick: 3840,
        startTick: 2880,
        tracks: [],
      });
    }
  });

  it('locks source and Timeline duration mismatches', () => {
    const plan = createPlan({
      tracks: [
        {
          clips: [createClip({ sourceEndSeconds: 0.75 })],
          gainDb: -6,
          pan: 0,
          trackId: 'track-1',
          trackMuted: false,
        },
      ],
    });

    expect(createProjectPlaybackSchedule(plan, 60)).toMatchObject({
      canSchedule: false,
      reason: 'invalid-plan',
    });
  });
});

describe('decibelsToLinearGain', () => {
  it('converts finite Track gain and rejects invalid state', () => {
    expect(decibelsToLinearGain(0)).toBe(1);
    expect(decibelsToLinearGain(-6)).toBeCloseTo(0.501187, 6);
    expect(() => decibelsToLinearGain(Number.NaN)).toThrow(RangeError);
  });
});

describe('ProjectPlaybackRuntime preparation settlement', () => {
  it('surfaces an actionable audio-device creation failure', () => {
    const schedule = createLegacySchedule();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: () => {
        throw new DOMException('No output device is available.', 'NotSupportedError');
      },
    });

    expect(() => runtime.play(
      new Map(),
      schedule,
      60,
      createRuntimeCallbacks(),
    )).toThrow(
      'Playback blocked: the browser could not create an audio device context. No output device is available.',
    );
    expect(runtime.isPlaying()).toBe(false);
  });

  it('surfaces an actionable audio-device resume failure', async () => {
    const schedule = createLegacySchedule();
    const harness = createLegacyRuntimeHarness({
      resume: Promise.reject(
        new DOMException('Audio permission was denied.', 'NotAllowedError'),
      ),
    });
    const callbacks = createRuntimeCallbacks();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: harness.createAudioContext,
    });

    runtime.play(new Map(), schedule, 60, callbacks);
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledTimes(1));

    expect(callbacks.onError).toHaveBeenCalledWith(
      'Playback blocked: the browser could not resume the audio device. Audio permission was denied.',
      schedule.plan,
    );
    expect(runtime.isPlaying()).toBe(false);
  });

  it('plays strict generated PCM16 without browser decodeAudioData', async () => {
    installAnimationFrameStub();
    const schedule = createLegacySchedule();
    const harness = createLegacyRuntimeHarness();
    const callbacks = createRuntimeCallbacks();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: harness.createAudioContext,
      preparationTimeoutMs: 1_000,
    });

    runtime.play(
      new Map([
        [
          'source-1',
          {
            data: createPcm16WaveBlob(),
            kind: 'generated' as const,
            name: 'generated-sa3.wav',
          },
        ],
      ]),
      schedule,
      60,
      callbacks,
    );

    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledTimes(1));
    expect(harness.context.decodeAudioData).not.toHaveBeenCalled();
    expect(harness.context.createBuffer).toHaveBeenCalledWith(2, 44_100, 44_100);
    expect(harness.copyToChannel).toHaveBeenCalledTimes(2);
    expect(harness.copyToChannel.mock.calls[0]?.[0]?.[0]).toBeCloseTo(
      16_384 / 32_767,
      6,
    );
    expect(harness.copyToChannel.mock.calls[1]?.[0]?.[0]).toBe(-0.5);
    expect(harness.context.createBufferSource).toHaveBeenCalledTimes(1);
    expect(runtime.stop()).toBe(schedule.plan);
  });

  it('resamples generated ACE IEEE float32 to the browser device without decodeAudioData', async () => {
    installAnimationFrameStub();
    const schedule = createLegacySchedule();
    const harness = createLegacyRuntimeHarness();
    const callbacks = createRuntimeCallbacks();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: harness.createAudioContext,
      preparationTimeoutMs: 1_000,
    });

    runtime.play(
      new Map([[
        'source-1',
        {
          data: createFloat32WaveBlob(),
          kind: 'generated' as const,
          name: 'generated-ace.wav',
        },
      ]]),
      schedule,
      60,
      callbacks,
    );

    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledTimes(1));
    expect(harness.context.decodeAudioData).not.toHaveBeenCalled();
    expect(harness.context.createBuffer).toHaveBeenCalledWith(2, 44_100, 44_100);
    expect(harness.copyToChannel.mock.calls[0]?.[0]?.[0]).toBe(0.5);
    expect(harness.copyToChannel.mock.calls[1]?.[0]?.[0]).toBe(-0.25);
    expect(runtime.stop()).toBe(schedule.plan);
  });

  it('keeps browser decoding for generated formats outside supported WAV', async () => {
    installAnimationFrameStub();
    const schedule = createLegacySchedule();
    const harness = createLegacyRuntimeHarness();
    const callbacks = createRuntimeCallbacks();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: harness.createAudioContext,
      preparationTimeoutMs: 1_000,
    });

    runtime.play(
      new Map([
        [
          'source-1',
          {
            data: new Blob([new Uint8Array([1])]),
            kind: 'generated' as const,
            name: 'generated-other.wav',
          },
        ],
      ]),
      schedule,
      60,
      callbacks,
    );

    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledTimes(1));
    expect(harness.context.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(harness.context.createBuffer).not.toHaveBeenCalled();
    expect(runtime.stop()).toBe(schedule.plan);
  });

  it('blocks when generated Blob reading never settles', async () => {
    const schedule = createLegacySchedule();
    const harness = createLegacyRuntimeHarness();
    const callbacks = createRuntimeCallbacks();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: harness.createAudioContext,
      preparationTimeoutMs: 10,
    });
    const stalledBlob = {
      arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined),
    } as Blob;

    runtime.play(
      new Map([
        [
          'source-1',
          { data: stalledBlob, kind: 'generated', name: 'generated-sa3.wav' },
        ],
      ]),
      schedule,
      60,
      callbacks,
    );

    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledTimes(1));
    expect(callbacks.onError).toHaveBeenCalledWith(
      'Playback blocked: generated-sa3.wav did not finish reading in time.',
      schedule.plan,
    );
    expect(callbacks.onStarted).not.toHaveBeenCalled();
    expect(harness.context.decodeAudioData).not.toHaveBeenCalled();
    expect(harness.context.close).toHaveBeenCalledTimes(1);
    expect(runtime.isPlaying()).toBe(false);
  });

  it('uses one total deadline instead of restarting the budget per source step', async () => {
    vi.useFakeTimers();
    try {
      const schedule = createLegacySchedule();
      let resolveResume!: () => void;
      const resume = new Promise<void>((resolve) => {
        resolveResume = resolve;
      });
      const harness = createLegacyRuntimeHarness({ resume });
      const callbacks = createRuntimeCallbacks();
      const runtime = new ProjectPlaybackRuntime({
        createAudioContext: harness.createAudioContext,
        preparationTimeoutMs: 10,
      });

      runtime.play(
        new Map([
          [
            'source-1',
            {
              data: new Promise<Blob>(() => undefined),
              kind: 'generated',
              name: 'generated-sa3.wav',
            },
          ],
        ]),
        schedule,
        60,
        callbacks,
      );
      await vi.advanceTimersByTimeAsync(9);
      resolveResume();
      await Promise.resolve();
      expect(callbacks.onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(callbacks.onError).toHaveBeenCalledWith(
        'Playback blocked: generated-sa3.wav did not load in time.',
        schedule.plan,
      );
      expect(runtime.isPlaying()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels preparation on STOP and ignores stale browser decode completion', async () => {
    const schedule = createLegacySchedule();
    let resolveDecode!: (buffer: AudioBuffer) => void;
    const decodePromise = new Promise<AudioBuffer>((resolve) => {
      resolveDecode = resolve;
    });
    const harness = createLegacyRuntimeHarness({
      decodeAudioData: vi.fn(() => decodePromise),
    });
    const callbacks = createRuntimeCallbacks();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: harness.createAudioContext,
      preparationTimeoutMs: 1_000,
    });

    runtime.play(
      new Map([
        [
          'source-1',
          { data: new Blob([new Uint8Array([1])]), name: 'session.wav' },
        ],
      ]),
      schedule,
      60,
      callbacks,
    );
    await vi.waitFor(() =>
      expect(harness.context.decodeAudioData).toHaveBeenCalledTimes(1),
    );

    expect(runtime.stop()).toBe(schedule.plan);
    resolveDecode({
      duration: 1,
      numberOfChannels: 2,
      sampleRate: 44_100,
    } as AudioBuffer);
    await Promise.resolve();
    await Promise.resolve();

    expect(callbacks.onStarted).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(harness.context.createBufferSource).not.toHaveBeenCalled();
    expect(harness.context.close).toHaveBeenCalledTimes(1);
    expect(runtime.isPlaying()).toBe(false);
  });
});

describe('ProjectPlaybackRuntime production effects path', () => {
  it.each(['all-playback', 'selection-playback'] as const)(
    'runs enabled effects through the 44.1 kHz AudioWorklet for %s',
    async (purpose) => {
      installAnimationFrameStub();
      const schedule = createEffectsSchedule(purpose);
      const harness = createRuntimeHarness();
      const callbacks = createRuntimeCallbacks();
      const runtime = new ProjectPlaybackRuntime({
        createAudioContext: harness.createAudioContext,
        effectsControllerEnvironment: harness.effectsEnvironment,
      });

      runtime.play(createRuntimeSources(schedule), schedule, 60, callbacks);
      await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledTimes(1));

      expect(harness.createAudioContext).toHaveBeenCalledWith({ sampleRate: 44_100 });
      expect(harness.context.createGain).not.toHaveBeenCalled();
      expect(harness.addModule).toHaveBeenCalledTimes(1);
      expect(harness.sources).toHaveLength(1);
      expect(harness.sources[0].connections).toEqual([
        { destination: harness.node, input: 0, output: 0 },
      ]);
      const scheduleMessage = harness.port.sent.find(
        (message) => readMessageType(message) === 'SCHEDULE_CYCLE',
      ) as Record<string, number>;
      expect(scheduleMessage).toMatchObject({ sequence: 1 });

      const accumulator = accumulateMixerSamplePeakBlock(
        createMixerSamplePeakAccumulator(),
        new Float32Array([1]),
        new Float32Array([1.01]),
      );
      harness.port.emit(createRuntimeWorkletEvent(
        harness.sessionId,
        'METER',
        {
          cycleSequence: 1,
          frameEnd: scheduleMessage.startFrame + 1,
          frameStart: scheduleMessage.startFrame,
          meterSummary: createMixerMeterTapSummary(
            [{ accumulator, trackId: 'track-1' }],
            accumulator,
          ),
        },
      ));
      expect(callbacks.onMeterSnapshot).toHaveBeenCalledTimes(1);
      expect(runtime.getMeterSnapshot()?.meterSummary.master).toMatchObject({
        clipped: true,
        left: { clipped: false, peak: 1 },
        right: { clipped: true, peak: expect.any(Number) },
      });

      expect(runtime.stop()).toBe(schedule.plan);
      expect(harness.port.sent.map(readMessageType)).toContain('TERMINATE');
      expect(harness.context.close).toHaveBeenCalledTimes(1);
      expect(runtime.isPlaying()).toBe(false);
    },
  );

  it.each(['all-playback', 'selection-playback'] as const)(
    'keeps exact meters active with all Inserts bypassed for %s',
    async (purpose) => {
      installAnimationFrameStub();
      const schedule = createEffectsSchedule(purpose, false);
      const harness = createRuntimeHarness();
      const callbacks = createRuntimeCallbacks();
      const runtime = new ProjectPlaybackRuntime({
        createAudioContext: harness.createAudioContext,
        effectsControllerEnvironment: harness.effectsEnvironment,
      });

      runtime.play(createRuntimeSources(schedule), schedule, 60, callbacks);
      await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledTimes(1));

      expect(harness.createAudioContext).toHaveBeenCalledWith({ sampleRate: 44_100 });
      expect(harness.context.createGain).not.toHaveBeenCalled();
      expect(harness.addModule).toHaveBeenCalledTimes(1);
      const scheduleMessage = harness.port.sent.find(
        (message) => readMessageType(message) === 'SCHEDULE_CYCLE',
      ) as Record<string, number>;
      const accumulator = accumulateMixerSamplePeakBlock(
        createMixerSamplePeakAccumulator(),
        new Float32Array([0.25]),
        new Float32Array([0.5]),
      );

      harness.port.emit(createRuntimeWorkletEvent(
        harness.sessionId,
        'METER',
        {
          cycleSequence: 1,
          frameEnd: scheduleMessage.startFrame + 1,
          frameStart: scheduleMessage.startFrame,
          meterSummary: createMixerMeterTapSummary(
            [{ accumulator, trackId: 'track-1' }],
            accumulator,
          ),
        },
      ));

      expect(callbacks.onMeterSnapshot).toHaveBeenCalledTimes(1);
      expect(runtime.getMeterSnapshot()?.meterSummary.master.left.peak).toBe(0.25);
      runtime.stop();
    },
  );

  it('resamples canonical 48 kHz generated audio into the 44.1 kHz Mixer AudioWorklet', async () => {
    installAnimationFrameStub();
    const schedule = createEffectsSchedule('selection-playback');
    const harness = createRuntimeHarness();
    const callbacks = createRuntimeCallbacks();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: harness.createAudioContext,
      effectsControllerEnvironment: harness.effectsEnvironment,
    });

    runtime.play(
      new Map([[
        'source-1',
        {
          data: createPcm16WaveBlob(48_000, 48_000),
          kind: 'generated' as const,
          name: 'generated-sa3-48khz.wav',
        },
      ]]),
      schedule,
      60,
      callbacks,
    );
    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledTimes(1));

    expect(harness.context.decodeAudioData).not.toHaveBeenCalled();
    expect(harness.context.createBuffer).toHaveBeenCalledWith(2, 44_100, 44_100);
    expect(harness.copyToChannel).toHaveBeenCalledTimes(2);
    expect(harness.addModule).toHaveBeenCalledTimes(1);
    expect(harness.sources).toHaveLength(1);
    expect(harness.sources[0].starts).toHaveLength(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(runtime.stop()).toBe(schedule.plan);
  });

  it.runIf(realGeneratedPlaybackFixturePaths.length === 2)(
    'prepares and schedules the two retained 268.8-second generated WAV fixtures without audio output',
    async () => {
      installAnimationFrameStub();

      for (const [index, fixturePath] of realGeneratedPlaybackFixturePaths.entries()) {
        const bytes = await readFile(fixturePath);
        expect(bytes.byteLength).toBe(51_609_644);
        const schedule = createGeneratedEffectsSchedule(
          268.8,
          index === 0 ? 'generated-sa3-real' : 'generated-ace-real',
        );
        const harness = createRuntimeHarness();
        const callbacks = createRuntimeCallbacks();
        const runtime = new ProjectPlaybackRuntime({
          createAudioContext: harness.createAudioContext,
          effectsControllerEnvironment: harness.effectsEnvironment,
          preparationTimeoutMs: 30_000,
        });

        runtime.play(
          new Map([[
            schedule.tracks[0].events[0].sourceId,
            {
              data: new Blob([bytes], { type: 'audio/wav' }),
              kind: 'generated' as const,
              name: fixturePath,
            },
          ]]),
          schedule,
          60,
          callbacks,
        );
        await vi.waitFor(
          () => expect(callbacks.onStarted).toHaveBeenCalledTimes(1),
          { timeout: 30_000 },
        );

        expect(harness.context.createBuffer).toHaveBeenCalledWith(
          2,
          11_854_080,
          44_100,
        );
        expect(harness.addModule).toHaveBeenCalledTimes(1);
        expect(harness.sources[0].starts).toHaveLength(1);
        expect(callbacks.onError).not.toHaveBeenCalled();
        runtime.stop();
      }
    },
    60_000,
  );

  it('pre-schedules one fresh loop cycle and cancels it deterministically', async () => {
    installAnimationFrameStub();
    const schedule = createEffectsSchedule('all-playback');
    const harness = createRuntimeHarness();
    const callbacks = createRuntimeCallbacks();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: harness.createAudioContext,
      effectsControllerEnvironment: harness.effectsEnvironment,
    });

    runtime.play(
      createRuntimeSources(schedule),
      schedule,
      60,
      callbacks,
      { loopEnabled: true, loopSchedule: schedule },
    );
    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledTimes(1));
    expect(harness.port.sent.map(readMessageType)).toEqual([
      'SCHEDULE_CYCLE',
      'SCHEDULE_CYCLE',
    ]);

    runtime.setLoopEnabled(false);
    expect(harness.port.sent.map(readMessageType)).toEqual([
      'SCHEDULE_CYCLE',
      'SCHEDULE_CYCLE',
      'CANCEL_CYCLE',
    ]);
    expect(harness.sources).toHaveLength(2);
    expect(harness.sources[1].stopped).toBe(true);
    runtime.stop();
  });

  it('keeps an already-started loop cycle instead of sending a stale cancellation', async () => {
    installAnimationFrameStub();
    const schedule = createEffectsSchedule('all-playback');
    const harness = createRuntimeHarness();
    const callbacks = createRuntimeCallbacks();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: harness.createAudioContext,
      effectsControllerEnvironment: harness.effectsEnvironment,
    });

    runtime.play(
      createRuntimeSources(schedule),
      schedule,
      60,
      callbacks,
      { loopEnabled: true, loopSchedule: schedule },
    );
    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledTimes(1));
    const messages = harness.port.sent as Record<string, number>[];
    const secondCycle = messages.filter(
      (message) => readMessageType(message) === 'SCHEDULE_CYCLE',
    )[1];
    (harness.context as unknown as { currentTime: number }).currentTime =
      secondCycle.startFrame / 44_100;

    runtime.setLoopEnabled(false);

    expect(harness.port.sent.map(readMessageType)).toEqual([
      'SCHEDULE_CYCLE',
      'SCHEDULE_CYCLE',
    ]);
    expect(harness.sources[1].stopped).toBe(false);
    runtime.stop();
  });

  it('preserves an ALL Playback clock with enabled Master effects and no Clip inputs', async () => {
    installAnimationFrameStub();
    const schedule = createMasterOnlyEffectsSchedule();
    const harness = createRuntimeHarness();
    const callbacks = createRuntimeCallbacks();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: harness.createAudioContext,
      effectsControllerEnvironment: harness.effectsEnvironment,
    });

    runtime.play(new Map(), schedule, 60, callbacks);
    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledTimes(1));

    expect(harness.createdOptions?.numberOfInputs).toBe(0);
    expect(harness.sources).toHaveLength(0);
    expect(harness.port.sent.map(readMessageType)).toEqual(['SCHEDULE_CYCLE']);
    runtime.stop();
  });

  it('fails once and never uses the legacy graph when module loading fails', async () => {
    installAnimationFrameStub();
    const schedule = createEffectsSchedule('all-playback');
    const harness = createRuntimeHarness({ moduleFailure: true });
    const callbacks = createRuntimeCallbacks();
    const runtime = new ProjectPlaybackRuntime({
      createAudioContext: harness.createAudioContext,
      effectsControllerEnvironment: harness.effectsEnvironment,
    });

    runtime.play(createRuntimeSources(schedule), schedule, 60, callbacks);
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledTimes(1));

    expect(callbacks.onStarted).not.toHaveBeenCalled();
    expect(harness.context.createGain).not.toHaveBeenCalled();
    expect(harness.sources).toHaveLength(0);
    expect(harness.context.close).toHaveBeenCalledTimes(1);
    expect(runtime.isPlaying()).toBe(false);
  });
});

class RuntimeFakePort {
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

class RuntimeFakeWorkletNode {
  onprocessorerror: ((event: Event) => void) | null = null;

  constructor(readonly port: RuntimeFakePort) {}

  connect(): this {
    return this;
  }

  disconnect(): void {}
}

class RuntimeFakeSourceNode {
  buffer: AudioBuffer | null = null;
  readonly connections: unknown[] = [];
  disconnected = false;
  onended: (() => void) | null = null;
  readonly starts: unknown[][] = [];
  stopped = false;

  connect(destination: unknown, output = 0, input = 0): unknown {
    this.connections.push({ destination, input, output });
    return destination;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  start(...arguments_: unknown[]): void {
    this.starts.push(arguments_);
  }

  stop(): void {
    this.stopped = true;
  }
}

function createRuntimeHarness(options: { moduleFailure?: boolean } = {}) {
  let node: RuntimeFakeWorkletNode | undefined;
  let port: RuntimeFakePort | undefined;
  let sessionId = '';
  let createdOptions: AudioWorkletNodeOptions | undefined;
  const sources: RuntimeFakeSourceNode[] = [];
  const copyToChannel = vi.fn();
  const addModule = options.moduleFailure
    ? vi.fn().mockRejectedValue(new Error('module unavailable'))
    : vi.fn().mockResolvedValue(undefined);
  const context = {
    audioWorklet: { addModule },
    close: vi.fn().mockResolvedValue(undefined),
    createBuffer: vi.fn((channels: number, frameCount: number, sampleRate: number) => ({
      copyToChannel,
      duration: frameCount / sampleRate,
      numberOfChannels: channels,
      sampleRate,
    } as unknown as AudioBuffer)),
    createBufferSource: vi.fn(() => {
      const source = new RuntimeFakeSourceNode();
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    }),
    createGain: vi.fn(() => {
      throw new Error('Legacy graph must not be created for enabled effects.');
    }),
    currentTime: 0,
    decodeAudioData: vi.fn().mockResolvedValue({
      duration: 1,
      numberOfChannels: 2,
      sampleRate: 44_100,
    } as AudioBuffer),
    destination: {} as AudioNode,
    resume: vi.fn().mockResolvedValue(undefined),
    sampleRate: 44_100,
  } as unknown as AudioContext;
  const createAudioContext = vi.fn(() => context);
  const effectsEnvironment = {
    createAudioWorkletNode: (
      _context: AudioContext,
      _name: string,
      workletOptions: AudioWorkletNodeOptions,
    ) => {
      createdOptions = workletOptions;
      const configuration = workletOptions.processorOptions?.configuration as {
        kernelConfiguration: { channels: readonly unknown[] };
        meterIntervalFrames: number;
        sessionId: string;
      };
      sessionId = configuration.sessionId;
      port = new RuntimeFakePort(createRuntimeWorkletEvent(
        sessionId,
        'READY',
        {
          actualSampleRateHz: 44_100,
          delayRuntimeBytes:
            configuration.kernelConfiguration.channels.length * 705_608,
          inputCount: workletOptions.numberOfInputs,
          meterIntervalFrames: configuration.meterIntervalFrames,
        },
      ));
      node = new RuntimeFakeWorkletNode(port);
      return node as unknown as AudioWorkletNode;
    },
    handshakeTimeoutMs: 250,
    moduleUrl: '/project-playback-mixer-worklet.js',
  };

  return {
    addModule,
    context,
    createAudioContext,
    effectsEnvironment,
    get createdOptions() { return createdOptions; },
    get node() {
      if (!node) throw new Error('Worklet node was not created.');
      return node;
    },
    get port() {
      if (!port) throw new Error('Worklet port was not created.');
      return port;
    },
    get sessionId() { return sessionId; },
    sources,
    copyToChannel,
  };
}

function createEffectsSchedule(
  purpose: 'all-playback' | 'selection-playback',
  effectsEnabled = true,
): ProjectPlaybackSchedule {
  const base = createPlan({
    audibleRange: { endTick: 960, startTick: 0 },
    endTick: 960,
    purpose,
    target: purpose === 'all-playback'
      ? { kind: 'all' }
      : { kind: 'track', trackId: 'track-1' },
    tracks: [{
      clips: [createClip()],
      gainDb: -6,
      pan: 0,
      trackId: 'track-1',
      trackMuted: false,
    }],
  });
  const snapshot = createTestProjectMixerRenderSnapshotV2([
    { gainDb: -6, pan: 0, trackId: 'track-1' },
  ]);
  const mixerSnapshot = effectsEnabled
    ? {
        ...snapshot,
        channels: [{
          ...snapshot.channels[0],
          inserts: [
            { ...snapshot.channels[0].inserts[0], bypass: false },
            snapshot.channels[0].inserts[1],
            snapshot.channels[0].inserts[2],
          ],
        }],
      } as ProjectPlaybackPlan['mixerSnapshot']
    : snapshot;
  const result = createProjectPlaybackSchedule(
    { ...base, mixerSnapshot },
    60,
  );
  if (!result.canSchedule) {
    throw new Error(result.message);
  }
  return result.schedule;
}

function createGeneratedEffectsSchedule(
  durationSeconds: number,
  sourceId: string,
): ProjectPlaybackSchedule {
  const schedule = createEffectsSchedule('selection-playback');
  const endTick = Math.round(durationSeconds * 960);
  const clip = schedule.plan.tracks[0].clips[0];
  const event = schedule.tracks[0].events[0];

  return {
    ...schedule,
    durationSeconds,
    endTick,
    plan: {
      ...schedule.plan,
      audibleRange: { endTick, startTick: 0 },
      endTick,
      tracks: [{
        ...schedule.plan.tracks[0],
        clips: [{
          ...clip,
          originalClipEndTick: endTick,
          sourceEndSeconds: durationSeconds,
          sourceId,
          timelineEndTick: endTick,
        }],
      }],
    },
    tracks: [{
      ...schedule.tracks[0],
      events: [{
        ...event,
        durationSeconds,
        sourceId,
        timelineEndTick: endTick,
      }],
    }],
  };
}

function createRuntimeSources(
  schedule: ProjectPlaybackSchedule,
): ReadonlyMap<string, ProjectPlaybackAudioSource> {
  return new Map(schedule.tracks.flatMap((track) =>
    track.events.map((event) => [
      event.sourceId,
      { data: new Blob([new Uint8Array([1])]), name: `${event.sourceId}.wav` },
    ] as const),
  ));
}

function createMasterOnlyEffectsSchedule(): ProjectPlaybackSchedule {
  const snapshot = createTestProjectMixerRenderSnapshotV2([]);
  const enabledSnapshot = {
    ...snapshot,
    master: {
      ...snapshot.master,
      inserts: [
        { ...snapshot.master.inserts[0], bypass: false },
        snapshot.master.inserts[1],
        snapshot.master.inserts[2],
      ],
    },
  } as ProjectPlaybackPlan['mixerSnapshot'];
  const plan = createPlan({
    audibleRange: { endTick: 960, startTick: 0 },
    endTick: 960,
    mixerSnapshot: enabledSnapshot,
    purpose: 'all-playback',
    target: { kind: 'all' },
    tracks: [],
  });
  const result = createProjectPlaybackSchedule(plan, 60);
  if (!result.canSchedule) {
    throw new Error(result.message);
  }
  return result.schedule;
}

function createRuntimeCallbacks() {
  return {
    onComplete: vi.fn(),
    onError: vi.fn(),
    onMeterSnapshot: vi.fn(),
    onProgress: vi.fn(),
    onStarted: vi.fn(),
  };
}

function createLegacySchedule(): ProjectPlaybackSchedule {
  const result = createProjectPlaybackSchedule(
    createPlan({
      audibleRange: { endTick: 960, startTick: 0 },
      endTick: 960,
      tracks: [
        {
          clips: [createClip()],
          gainDb: -6,
          pan: 0,
          trackId: 'track-1',
          trackMuted: false,
        },
      ],
    }),
    60,
  );

  if (!result.canSchedule) {
    throw new Error(result.message);
  }

  return result.schedule;
}

function createLegacyRuntimeHarness(options: {
  decodeAudioData?: (data: ArrayBuffer) => Promise<AudioBuffer>;
  resume?: Promise<void>;
  sampleRate?: number;
} = {}) {
  const copyToChannel = vi.fn();
  const audioBuffer = {
    copyToChannel,
    duration: 1,
    numberOfChannels: 2,
    sampleRate: 44_100,
  } as unknown as AudioBuffer;
  const node = {
    connect: vi.fn((destination: unknown) => destination),
    disconnect: vi.fn(),
    gain: { value: 1 },
  };
  const sources: RuntimeFakeSourceNode[] = [];
  const context = {
    close: vi.fn().mockResolvedValue(undefined),
    createBuffer: vi.fn(() => audioBuffer),
    createBufferSource: vi.fn(() => {
      const source = new RuntimeFakeSourceNode();
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    }),
    createChannelMerger: vi.fn(() => node as unknown as ChannelMergerNode),
    createChannelSplitter: vi.fn(() => node as unknown as ChannelSplitterNode),
    createGain: vi.fn(() => node as unknown as GainNode),
    currentTime: 0,
    decodeAudioData:
      options.decodeAudioData ?? vi.fn().mockResolvedValue(audioBuffer),
    destination: {} as AudioNode,
    resume: vi.fn(() => options.resume ?? Promise.resolve()),
    sampleRate: options.sampleRate ?? 44_100,
  } as unknown as AudioContext;
  const createAudioContext = vi.fn(() => context);

  return { audioBuffer, context, copyToChannel, createAudioContext, sources };
}

function createPcm16WaveBlob(
  frameCount = 44_100,
  sampleRate = 44_100,
): Blob {
  const bytes = new Uint8Array(44 + frameCount * 4);
  const view = new DataView(bytes.buffer);
  writeTestAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeTestAscii(bytes, 8, 'WAVE');
  writeTestAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeTestAscii(bytes, 36, 'data');
  view.setUint32(40, frameCount * 4, true);
  view.setInt16(44, 16_384, true);
  view.setInt16(46, -16_384, true);
  return new Blob([bytes], { type: 'audio/wav' });
}

function createFloat32WaveBlob(): Blob {
  const frameCount = 48_000;
  const bytes = new Uint8Array(44 + frameCount * 8);
  const view = new DataView(bytes.buffer);
  writeTestAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeTestAscii(bytes, 8, 'WAVE');
  writeTestAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 48_000 * 8, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  writeTestAscii(bytes, 36, 'data');
  view.setUint32(40, frameCount * 8, true);
  view.setFloat32(44, 0.5, true);
  view.setFloat32(48, -0.25, true);
  return new Blob([bytes], { type: 'audio/wav' });
}

function writeTestAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function createRuntimeWorkletEvent(
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

function readMessageType(value: unknown): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>).type
    : undefined;
}

function installAnimationFrameStub(): void {
  vi.stubGlobal('window', {
    cancelAnimationFrame: vi.fn(),
    requestAnimationFrame: vi.fn(() => 1),
  });
}
