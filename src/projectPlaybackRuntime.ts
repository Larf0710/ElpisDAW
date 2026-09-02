import {
  AUDIO_DURATION_EPSILON_SECONDS,
  secondsToTimelineTickOffset,
  timelineTicksToSeconds,
} from './audioClipTiming';
import {
  MIXER_DSP_CONTRACT_VERSION,
  MIXER_DSP_CONTRACT_VERSION_V1,
  MIXER_DSP_CONTRACT_VERSION_V2,
  createMixerChannelDspCoefficients,
  createMixerChannelDspCoefficientsV2,
  decibelsToMixerGain,
} from '../shared/mixerDspContract.js';
import type {
  ProjectPlaybackPlan,
  ResolvedPlaybackClip,
} from './projectPlaybackPlan';
import {
  assertProjectMixerRenderSnapshot,
  assertProjectMixerRenderSnapshotV2,
} from './projectMixerRenderSnapshot';
import {
  PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ,
  createProjectPlaybackEffectsController,
  type ProjectPlaybackEffectsController,
  type ProjectPlaybackEffectsControllerEnvironment,
  type ProjectPlaybackRuntimeMeterSnapshot,
} from './projectPlaybackAudioWorkletRuntime';
import {
  TimelineExportEncodingError,
  inspectUncompressedWave,
  readInterpolatedUncompressedWaveSample,
} from './timelineExportEncoding';
import {
  recordProjectPlaybackDiagnostic,
  resetProjectPlaybackDiagnostics,
} from './projectPlaybackDiagnostics';

const PLAYBACK_START_LEAD_SECONDS = 0.05;
const PLAYBACK_PROGRESS_INTERVAL_MS = 80;
const PLAYBACK_EFFECTS_RENDER_QUANTUM_FRAMES = 128;
const PLAYBACK_PREPARATION_TIMEOUT_MS = 60_000;
const GENERATED_WAVE_DECODE_BLOCK_FRAMES = 65_536;
const MAX_GENERATED_WAVE_DECODE_SAMPLES = 60_000_000;

export type ProjectPlaybackEvent = Readonly<{
  clipId: string;
  clipName: string;
  durationSeconds: number;
  sourceId: string;
  sourceStartSeconds: number;
  startOffsetSeconds: number;
  timelineEndTick: number;
  timelineStartTick: number;
}>;

export type ProjectPlaybackTrackSchedule = Readonly<{
  events: readonly ProjectPlaybackEvent[];
  gainDb: number;
  groupTrackId?: string;
  pan: number;
  trackId: string;
}>;

export type ProjectPlaybackSchedule = Readonly<{
  durationSeconds: number;
  endTick: number;
  masterFaderDb: number;
  mixerDspVersion:
    | typeof MIXER_DSP_CONTRACT_VERSION
    | typeof MIXER_DSP_CONTRACT_VERSION_V2;
  plan: ProjectPlaybackPlan;
  startTick: number;
  tracks: readonly ProjectPlaybackTrackSchedule[];
}>;

export type ProjectPlaybackScheduleOptions = Readonly<{
  endTick?: number;
}>;

export type ProjectPlaybackScheduleAvailability =
  | { canSchedule: true; schedule: ProjectPlaybackSchedule }
  | {
      canSchedule: false;
      message: string;
      reason: 'invalid-plan' | 'invalid-timing' | 'no-tracks';
    };

export type ProjectPlaybackRuntimeCallbacks = {
  onComplete: (schedule: ProjectPlaybackSchedule) => void;
  onError: (message: string, plan: ProjectPlaybackPlan) => void;
  onProgress: (playheadTick: number, plan: ProjectPlaybackPlan) => void;
  onStarted: (schedule: ProjectPlaybackSchedule) => void;
  onMeterSnapshot?: (snapshot: ProjectPlaybackRuntimeMeterSnapshot) => void;
};

export type ProjectPlaybackRuntimeOptions = {
  loopEnabled?: boolean;
  loopSchedule?: ProjectPlaybackSchedule;
};

export type ProjectPlaybackAudioSource = Readonly<{
  data: Blob | Promise<Blob>;
  kind?: 'generated' | 'midi-cache' | 'session';
  name: string;
}>;

export type ProjectPlaybackRuntimeEnvironment = Readonly<{
  createAudioContext: (options?: AudioContextOptions) => AudioContext;
  effectsControllerEnvironment?: Partial<ProjectPlaybackEffectsControllerEnvironment>;
  preparationTimeoutMs?: number;
}>;

type ScheduledPlaybackCycle = {
  endTime: number;
  effectsSequence?: number;
  graphs: ScheduledPlaybackGraph[];
  schedule: ProjectPlaybackSchedule;
  startTime: number;
};

type ScheduledPlaybackGraph = {
  nodes: readonly AudioNode[];
  source: AudioBufferSourceNode;
};

type ActiveProjectPlayback = {
  animationFrameId?: number;
  audioContext: AudioContext;
  bpm: number;
  callbacks: ProjectPlaybackRuntimeCallbacks;
  currentCycle?: ScheduledPlaybackCycle;
  decodedSources: Map<string, AudioBuffer>;
  diagnosticMeterCount: number;
  effectsController?: ProjectPlaybackEffectsController;
  initialSchedule: ProjectPlaybackSchedule;
  lastPlayheadUpdateAt: number;
  loopEnabled: boolean;
  loopSchedule?: ProjectPlaybackSchedule;
  masterGainNode?: GainNode;
  nextCycle?: ScheduledPlaybackCycle;
  phase: 'preparing' | 'playing';
  preparationAbortController: AbortController;
  preparationDeadlineId?: ReturnType<typeof globalThis.setTimeout>;
  preparationTimedOut: boolean;
  preparationTimeoutMessage: string;
  scheduledGraphs: Set<ScheduledPlaybackGraph>;
  trackDspStates: Map<string, ProjectPlaybackTrackSchedule>;
  useEffectsWorklet: boolean;
};

const defaultRuntimeEnvironment: ProjectPlaybackRuntimeEnvironment = {
  createAudioContext: (options) => new AudioContext(options),
};

class PlaybackPreparationCanceledError extends Error {
  constructor() {
    super('Project playback preparation was canceled.');
    this.name = 'PlaybackPreparationCanceledError';
  }
}

class PlaybackPreparationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybackPreparationTimeoutError';
  }
}

function isPlaybackPreparationSettlementError(
  error: unknown,
): error is PlaybackPreparationCanceledError | PlaybackPreparationTimeoutError {
  return (
    error instanceof PlaybackPreparationCanceledError ||
    error instanceof PlaybackPreparationTimeoutError
  );
}

function createPlaybackPreparationAbortError(
  activePlayback: ActiveProjectPlayback,
): PlaybackPreparationCanceledError | PlaybackPreparationTimeoutError {
  return activePlayback.preparationTimedOut
    ? new PlaybackPreparationTimeoutError(activePlayback.preparationTimeoutMessage)
    : new PlaybackPreparationCanceledError();
}

export function createProjectPlaybackSchedule(
  plan: ProjectPlaybackPlan,
  bpm: number,
  options: ProjectPlaybackScheduleOptions = {},
): ProjectPlaybackScheduleAvailability {
  const endTick = options.endTick ?? plan.endTick;

  if (!isPlaybackPlanDspValid(plan)) {
    return {
      canSchedule: false,
      message: 'Playback locked: the Mixer DSP state is invalid or incomplete.',
      reason: 'invalid-plan',
    };
  }

  if (
    !Number.isFinite(bpm) ||
    bpm <= 0 ||
    !Number.isFinite(endTick) ||
    endTick <= plan.startTick ||
    endTick > plan.endTick
  ) {
    return {
      canSchedule: false,
      message: 'Playback locked: the Project Playback Plan has invalid timing.',
      reason: 'invalid-timing',
    };
  }

  if (plan.tracks.length === 0) {
    if (plan.purpose === 'all-playback') {
      return {
        canSchedule: true,
        schedule: {
          durationSeconds: timelineTicksToSeconds(endTick - plan.startTick, bpm),
          endTick,
          masterFaderDb: plan.mixerSnapshot.master.faderDb,
          mixerDspVersion: getPlanningMixerDspVersion(plan),
          plan,
          startTick: plan.startTick,
          tracks: [],
        },
      };
    }

    return {
      canSchedule: false,
      message: 'Playback locked: the target has no playable Tracks.',
      reason: 'no-tracks',
    };
  }

  const seenTrackIds = new Set<string>();
  const tracks: ProjectPlaybackTrackSchedule[] = [];

  for (const track of plan.tracks) {
    if (seenTrackIds.has(track.trackId)) {
      return {
        canSchedule: false,
        message: `Playback locked: Track ${track.trackId} appears more than once in the Plan.`,
        reason: 'invalid-plan',
      };
    }

    seenTrackIds.add(track.trackId);
    const events: ProjectPlaybackEvent[] = [];

    for (const clip of track.clips) {
      if (clip.timelineEndTick <= plan.startTick || clip.timelineStartTick >= endTick) {
        continue;
      }

      const event = createPlaybackEvent(clip, plan.startTick, endTick, bpm);

      if (!event) {
        return {
          canSchedule: false,
          message: `Playback locked: ${clip.clipName} has an invalid scheduled range.`,
          reason: 'invalid-plan',
        };
      }

      events.push(event);
    }

    if (events.length === 0) {
      continue;
    }

    events.sort(
      (left, right) =>
        left.timelineStartTick - right.timelineStartTick || left.clipId.localeCompare(right.clipId),
    );
    tracks.push({
      events,
      gainDb: track.gainDb,
      groupTrackId: track.groupTrackId,
      pan: track.pan,
      trackId: track.trackId,
    });
  }

  if (tracks.length === 0) {
    if (plan.purpose === 'all-playback') {
      return {
        canSchedule: true,
        schedule: {
          durationSeconds: timelineTicksToSeconds(endTick - plan.startTick, bpm),
          endTick,
          masterFaderDb: plan.mixerSnapshot.master.faderDb,
          mixerDspVersion: getPlanningMixerDspVersion(plan),
          plan,
          startTick: plan.startTick,
          tracks: [],
        },
      };
    }

    return {
      canSchedule: false,
      message: 'Playback locked: the target has no scheduled audio Clips in this range.',
      reason: 'invalid-plan',
    };
  }

  return {
    canSchedule: true,
    schedule: {
      durationSeconds:
        plan.purpose === 'selection-playback' && endTick === plan.audibleRange.endTick
          ? Math.max(...tracks.flatMap((track) =>
              track.events.map((event) => event.startOffsetSeconds + event.durationSeconds),
            ))
          : timelineTicksToSeconds(endTick - plan.startTick, bpm),
      endTick,
      masterFaderDb: plan.mixerSnapshot.master.faderDb,
      mixerDspVersion: getPlanningMixerDspVersion(plan),
      plan,
      startTick: plan.startTick,
      tracks,
    },
  };
}

export class ProjectPlaybackRuntime {
  private activePlayback?: ActiveProjectPlayback;
  private readonly environment: ProjectPlaybackRuntimeEnvironment;
  private readonly preparationTimeoutMs: number;

  constructor(environment: Partial<ProjectPlaybackRuntimeEnvironment> = {}) {
    this.environment = { ...defaultRuntimeEnvironment, ...environment };
    this.preparationTimeoutMs =
      environment.preparationTimeoutMs ?? PLAYBACK_PREPARATION_TIMEOUT_MS;

    if (
      !Number.isFinite(this.preparationTimeoutMs) ||
      this.preparationTimeoutMs <= 0
    ) {
      throw new RangeError('Project playback preparation timeout must be positive.');
    }
  }

  isPlaying(): boolean {
    return this.activePlayback !== undefined;
  }

  /** Exact session-only meters exist for versioned Mixer AudioWorklet playback. */
  getMeterSnapshot(): ProjectPlaybackRuntimeMeterSnapshot | undefined {
    return this.activePlayback?.effectsController?.getMeterSnapshot();
  }

  play(
    audioSources: ReadonlyMap<string, ProjectPlaybackAudioSource>,
    schedule: ProjectPlaybackSchedule,
    bpm: number,
    callbacks: ProjectPlaybackRuntimeCallbacks,
    options: ProjectPlaybackRuntimeOptions = {},
  ): void {
    if (this.activePlayback) {
      throw new Error('Project audio playback is already active.');
    }

    assertPlaybackScheduleDsp(schedule);

    if (options.loopSchedule) {
      assertPlaybackScheduleDsp(options.loopSchedule);
    }

    if (
      options.loopSchedule &&
      createPlaybackTargetKey(options.loopSchedule.plan) !== createPlaybackTargetKey(schedule.plan)
    ) {
      throw new Error('Project Loop Plan must resolve to the same target as the active Plan.');
    }

    const runtimeTracks = collectRuntimeTrackSchedules(schedule, options.loopSchedule);
    const useEffectsWorklet = shouldUseEffectsWorklet(schedule, options.loopSchedule);
    resetProjectPlaybackDiagnostics({
      audioSources: [...audioSources.entries()].map(([sourceId, source]) => ({
        kind: source.kind ?? 'session',
        name: source.name,
        sourceId,
      })),
      loopEnabled: (options.loopEnabled ?? false) && options.loopSchedule !== undefined,
      masterFaderDb: schedule.masterFaderDb,
      purpose: schedule.plan.purpose,
      scheduleDurationSeconds: schedule.durationSeconds,
      target: schedule.plan.target,
      tracks: schedule.tracks.map((track) => ({
        eventCount: track.events.length,
        gainDb: track.gainDb,
        pan: track.pan,
        trackId: track.trackId,
      })),
      useEffectsWorklet,
    });
    let audioContext: AudioContext;

    try {
      audioContext = this.environment.createAudioContext(
        useEffectsWorklet
          ? { sampleRate: PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ }
          : undefined,
      );
    } catch (error) {
      recordProjectPlaybackDiagnostic('context-create-failed', {
        message: readPlaybackErrorDetail(error),
        useEffectsWorklet,
      });
      throw new Error(
        `Playback blocked: the browser could not create an audio device context. ${readPlaybackErrorDetail(error)}`,
      );
    }
    recordProjectPlaybackDiagnostic('context-created', {
      sampleRate: audioContext.sampleRate,
      state: audioContext.state,
      useEffectsWorklet,
    });
    const masterGainNode = useEffectsWorklet
      ? undefined
      : audioContext.createGain();

    if (masterGainNode) {
      masterGainNode.gain.value = decibelsToMixerGain(schedule.masterFaderDb);
      masterGainNode.connect(audioContext.destination);
    }

    const activePlayback: ActiveProjectPlayback = {
      audioContext,
      bpm,
      callbacks,
      decodedSources: new Map(),
      diagnosticMeterCount: 0,
      initialSchedule: schedule,
      lastPlayheadUpdateAt: 0,
      loopEnabled: (options.loopEnabled ?? false) && options.loopSchedule !== undefined,
      loopSchedule: options.loopSchedule,
      masterGainNode,
      phase: 'preparing',
      preparationAbortController: new AbortController(),
      preparationTimedOut: false,
      preparationTimeoutMessage: 'Playback blocked: audio preparation timed out.',
      scheduledGraphs: new Set(),
      trackDspStates: runtimeTracks,
      useEffectsWorklet,
    };

    this.activePlayback = activePlayback;
    activePlayback.preparationDeadlineId = globalThis.setTimeout(() => {
      if (this.activePlayback !== activePlayback || activePlayback.phase !== 'preparing') {
        return;
      }
      activePlayback.preparationTimedOut = true;
      activePlayback.preparationAbortController.abort();
    }, this.preparationTimeoutMs);
    const resumePromise = audioContext.resume();
    void this.prepare(activePlayback, audioSources, resumePromise);
  }

  stop(): ProjectPlaybackPlan | undefined {
    const activePlayback = this.activePlayback;

    if (!activePlayback) {
      return undefined;
    }

    recordProjectPlaybackDiagnostic('playback-stop-requested', {
      audioContextState: activePlayback.audioContext.state,
      phase: activePlayback.phase,
      startTick: activePlayback.initialSchedule.startTick,
    });
    this.release(activePlayback);
    return activePlayback.initialSchedule.plan;
  }

  setLoopEnabled(loopEnabled: boolean): void {
    const activePlayback = this.activePlayback;

    if (!activePlayback || activePlayback.loopEnabled === loopEnabled) {
      return;
    }

    activePlayback.loopEnabled = loopEnabled && activePlayback.loopSchedule !== undefined;

    if (activePlayback.phase !== 'playing' || !activePlayback.currentCycle) {
      return;
    }

    if (!activePlayback.loopEnabled) {
      if (activePlayback.nextCycle) {
        if (
          activePlayback.audioContext.currentTime >=
          activePlayback.nextCycle.startTime - AUDIO_DURATION_EPSILON_SECONDS
        ) {
          activePlayback.currentCycle = activePlayback.nextCycle;
          activePlayback.lastPlayheadUpdateAt = 0;
        } else {
          this.cancelCycle(activePlayback, activePlayback.nextCycle);
        }
        activePlayback.nextCycle = undefined;
      }
      return;
    }

    this.ensureNextLoopCycle(activePlayback);
  }

  private async prepare(
    activePlayback: ActiveProjectPlayback,
    audioSources: ReadonlyMap<string, ProjectPlaybackAudioSource>,
    resumePromise: Promise<void>,
  ): Promise<void> {
    try {
      try {
        await this.awaitPreparationStep(
          activePlayback,
          resumePromise,
          'Playback blocked: the browser did not resume audio in time.',
        );
        recordProjectPlaybackDiagnostic('context-resumed', {
          sampleRate: activePlayback.audioContext.sampleRate,
          state: activePlayback.audioContext.state,
        });
      } catch (error) {
        if (isPlaybackPreparationSettlementError(error)) {
          throw error;
        }

        throw new Error(
          `Playback blocked: the browser could not resume the audio device. ${readPlaybackErrorDetail(error)}`,
        );
      }
      const sourceIds = collectScheduleSourceIds(
        activePlayback.initialSchedule,
        activePlayback.loopSchedule,
      );

      for (const sourceId of sourceIds) {
        if (this.activePlayback !== activePlayback) {
          return;
        }

        const source = audioSources.get(sourceId);

        if (!source) {
          throw new Error(`Playback blocked: source ${sourceId} is not available in this session.`);
        }

        const data = await this.awaitPreparationStep(
          activePlayback,
          source.data,
          `Playback blocked: ${source.name} did not load in time.`,
        );
        recordProjectPlaybackDiagnostic('source-loaded', {
          kind: source.kind ?? 'session',
          mimeType: data.type,
          name: source.name,
          sizeBytes: data.size,
          sourceId,
        });
        let decodedSource: AudioBuffer;
        let encodedData: ArrayBuffer;

        try {
          encodedData = await this.awaitPreparationStep(
            activePlayback,
            data.arrayBuffer(),
            `Playback blocked: ${source.name} did not finish reading in time.`,
          );
        } catch (error) {
          if (isPlaybackPreparationSettlementError(error)) {
            throw error;
          }

          throw new Error(
            `Playback blocked: ${source.name} could not be read by this browser.`,
          );
        }

        try {
          const generatedWaveDecoded = source.kind === 'generated'
            ? await this.awaitPreparationStep(
                activePlayback,
                decodeGeneratedWave(
                  activePlayback.audioContext,
                  new Uint8Array(encodedData),
                  sourceId,
                  activePlayback.preparationAbortController.signal,
                ),
                `Playback blocked: ${source.name} WAV preparation did not finish in time.`,
              )
            : undefined;
          decodedSource = generatedWaveDecoded ?? await this.awaitPreparationStep(
            activePlayback,
            activePlayback.audioContext.decodeAudioData(encodedData),
            `Playback blocked: ${source.name} browser decoding did not finish in time.`,
          );
        } catch (error) {
          if (isPlaybackPreparationSettlementError(error)) {
            throw error;
          }

          throw new Error(
            `Playback blocked: ${source.name} could not be decoded by this browser. ${readPlaybackErrorDetail(error)}`,
          );
        }

        activePlayback.decodedSources.set(sourceId, decodedSource);
        recordProjectPlaybackDiagnostic('source-decoded', {
          durationSeconds: decodedSource.duration,
          frameCount: decodedSource.length,
          kind: source.kind ?? 'session',
          name: source.name,
          numberOfChannels: decodedSource.numberOfChannels,
          sampleRate: decodedSource.sampleRate,
          sourceId,
        });
      }

      if (this.activePlayback !== activePlayback) {
        return;
      }

      validateDecodedRanges(activePlayback.initialSchedule, activePlayback.decodedSources);

      if (activePlayback.loopSchedule) {
        validateDecodedRanges(activePlayback.loopSchedule, activePlayback.decodedSources);
      }
      recordProjectPlaybackDiagnostic('ranges-validated', {
        events: [
          activePlayback.initialSchedule,
          ...(activePlayback.loopSchedule ? [activePlayback.loopSchedule] : []),
        ].flatMap((candidate) => candidate.tracks.flatMap((track) =>
          track.events.map((event) => {
            const decodedSource = activePlayback.decodedSources.get(event.sourceId);
            return {
              clipId: event.clipId,
              clipName: event.clipName,
              decodedDurationSeconds: decodedSource?.duration,
              durationSeconds: event.durationSeconds,
              sourceEndSeconds: event.sourceStartSeconds + event.durationSeconds,
              sourceId: event.sourceId,
              sourceStartSeconds: event.sourceStartSeconds,
              startOffsetSeconds: event.startOffsetSeconds,
              trackId: track.trackId,
            };
          }),
        )),
      });

      if (activePlayback.useEffectsWorklet) {
        const effectsController = await this.awaitPreparationStep(
          activePlayback,
          createProjectPlaybackEffectsController({
            audioContext: activePlayback.audioContext,
            decodedSources: activePlayback.decodedSources,
            destination: activePlayback.audioContext.destination,
            environment: this.environment.effectsControllerEnvironment,
            onError: (error) => this.fail(activePlayback, error.message),
            onMeterSnapshot: (snapshot) => {
              activePlayback.diagnosticMeterCount += 1;
              if (activePlayback.diagnosticMeterCount <= 8) {
                recordProjectPlaybackDiagnostic('effects-meter', {
                  channels: snapshot.meterSummary.channels.map((channel) => ({
                    leftPeak: channel.meter.left.peak,
                    rightPeak: channel.meter.right.peak,
                    sampleCount: channel.meter.sampleCount,
                    trackId: channel.trackId,
                  })),
                  frameEnd: snapshot.frameEnd,
                  frameStart: snapshot.frameStart,
                  leftPeak: snapshot.meterSummary.master.left.peak,
                  rightPeak: snapshot.meterSummary.master.right.peak,
                  sampleCount: snapshot.meterSummary.master.sampleCount,
                });
              }
              activePlayback.callbacks.onMeterSnapshot?.(snapshot);
            },
            schedules: [
              activePlayback.initialSchedule,
              ...(activePlayback.loopSchedule ? [activePlayback.loopSchedule] : []),
            ],
          }).then((controller) => {
            if (
              this.activePlayback !== activePlayback ||
              activePlayback.preparationAbortController.signal.aborted
            ) {
              controller.terminate();
            }
            return controller;
          }),
          'Playback blocked: Mixer effects preparation did not finish in time.',
        );
        if (this.activePlayback !== activePlayback) {
          effectsController.terminate();
          return;
        }
        activePlayback.effectsController = effectsController;
        recordProjectPlaybackDiagnostic('effects-ready', {
          inputCount: effectsController.inputIndexByTrackAndChannels.size,
          sampleRate: activePlayback.audioContext.sampleRate,
          sessionId: effectsController.sessionId,
        });
      }

      const requestedStartTime =
        activePlayback.audioContext.currentTime + PLAYBACK_START_LEAD_SECONDS;
      const startTime = activePlayback.useEffectsWorklet
        ? alignEffectsStartTime(requestedStartTime)
        : requestedStartTime;
      activePlayback.currentCycle = this.scheduleCycle(
        activePlayback,
        activePlayback.initialSchedule,
        startTime,
      );
      this.clearPreparationDeadline(activePlayback);
      activePlayback.phase = 'playing';
      this.ensureNextLoopCycle(activePlayback);
      activePlayback.callbacks.onStarted(activePlayback.initialSchedule);
      recordProjectPlaybackDiagnostic('playback-started', {
        audioContextState: activePlayback.audioContext.state,
        scheduledGraphCount: activePlayback.scheduledGraphs.size,
        startTime: activePlayback.currentCycle.startTime,
        useEffectsWorklet: activePlayback.useEffectsWorklet,
      });
      activePlayback.callbacks.onProgress(
        activePlayback.initialSchedule.startTick,
        activePlayback.initialSchedule.plan,
      );
      this.startProgressLoop(activePlayback);
    } catch (error) {
      if (error instanceof PlaybackPreparationCanceledError) {
        return;
      }

      this.fail(
        activePlayback,
        error instanceof Error ? error.message : 'Playback failed unexpectedly.',
      );
    }
  }

  private awaitPreparationStep<T>(
    activePlayback: ActiveProjectPlayback,
    pending: PromiseLike<T> | T,
    timeoutMessage: string,
  ): Promise<T> {
    const signal = activePlayback.preparationAbortController.signal;
    activePlayback.preparationTimeoutMessage = timeoutMessage;

    if (signal.aborted) {
      return Promise.reject(createPlaybackPreparationAbortError(activePlayback));
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener('abort', handleAbort);
      };
      const finish = (settler: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        settler();
      };
      const handleAbort = () =>
        finish(() => reject(createPlaybackPreparationAbortError(activePlayback)));

      signal.addEventListener('abort', handleAbort, { once: true });
      Promise.resolve(pending).then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private clearPreparationDeadline(activePlayback: ActiveProjectPlayback): void {
    if (activePlayback.preparationDeadlineId === undefined) {
      return;
    }
    globalThis.clearTimeout(activePlayback.preparationDeadlineId);
    activePlayback.preparationDeadlineId = undefined;
  }

  private scheduleCycle(
    activePlayback: ActiveProjectPlayback,
    schedule: ProjectPlaybackSchedule,
    startTime: number,
  ): ScheduledPlaybackCycle {
    const cycleStartTime = activePlayback.useEffectsWorklet
      ? alignEffectsStartTime(startTime)
      : startTime;
    const cycleFrameCount = activePlayback.useEffectsWorklet
      ? Math.round(schedule.durationSeconds * PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ)
      : undefined;
    const effectsSequence = activePlayback.useEffectsWorklet
      ? activePlayback.effectsController?.scheduleCycle(
          Math.round(cycleStartTime * PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ),
          Math.round(cycleStartTime * PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ) +
            (cycleFrameCount ?? 0),
        )
      : undefined;
    if (activePlayback.useEffectsWorklet && effectsSequence === undefined) {
      throw new Error('Playback blocked: the Mixer AudioWorklet is not ready.');
    }
    const graphs = schedule.tracks.flatMap((track) => {
      const trackDsp = activePlayback.trackDspStates.get(track.trackId);

      if (!trackDsp) {
        throw new Error(`Playback blocked: Track ${track.trackId} has no Mixer DSP state.`);
      }

      return track.events.map((event) => {
        const decodedSource = activePlayback.decodedSources.get(event.sourceId);

        if (!decodedSource) {
          throw new Error(`Playback blocked: source ${event.sourceId} was not decoded.`);
        }

        const graph = createPlaybackGraph(
          activePlayback.audioContext,
          activePlayback.masterGainNode,
          activePlayback.effectsController,
          decodedSource,
          trackDsp,
          schedule.mixerDspVersion,
        );
        graph.source.onended = () => {
          activePlayback.scheduledGraphs.delete(graph);
          disconnectPlaybackGraph(graph);
        };
        activePlayback.scheduledGraphs.add(graph);
        graph.source.start(
          cycleStartTime + event.startOffsetSeconds,
          event.sourceStartSeconds,
          event.durationSeconds,
        );
        recordProjectPlaybackDiagnostic('event-scheduled', {
          audioContextState: activePlayback.audioContext.state,
          clipId: event.clipId,
          clipName: event.clipName,
          cycleStartTime,
          decodedDurationSeconds: decodedSource.duration,
          decodedFrameCount: decodedSource.length,
          decodedSampleRate: decodedSource.sampleRate,
          durationSeconds: event.durationSeconds,
          sourceId: event.sourceId,
          sourceStartSeconds: event.sourceStartSeconds,
          startOffsetSeconds: event.startOffsetSeconds,
          trackGainDb: trackDsp.gainDb,
          trackId: track.trackId,
          trackPan: trackDsp.pan,
        });
        return graph;
      });
    });

    return {
      endTime: activePlayback.useEffectsWorklet
        ? cycleStartTime + (cycleFrameCount ?? 0) /
          PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ
        : cycleStartTime + schedule.durationSeconds,
      effectsSequence,
      graphs,
      schedule,
      startTime: cycleStartTime,
    };
  }

  private startProgressLoop(activePlayback: ActiveProjectPlayback): void {
    const updatePlaybackProgress = (timestamp: number) => {
      if (this.activePlayback !== activePlayback || !activePlayback.currentCycle) {
        return;
      }

      if (!this.advancePlaybackBoundary(activePlayback)) {
        return;
      }

      if (timestamp - activePlayback.lastPlayheadUpdateAt >= PLAYBACK_PROGRESS_INTERVAL_MS) {
        activePlayback.lastPlayheadUpdateAt = timestamp;
        const currentCycle = activePlayback.currentCycle;
        const elapsedSeconds = Math.max(
          0,
          activePlayback.audioContext.currentTime - currentCycle.startTime,
        );
        const nextPlayheadTick = Math.min(
          currentCycle.schedule.endTick,
          currentCycle.schedule.startTick +
            secondsToTimelineTickOffset(elapsedSeconds, activePlayback.bpm),
        );
        activePlayback.callbacks.onProgress(nextPlayheadTick, currentCycle.schedule.plan);
      }

      activePlayback.animationFrameId = window.requestAnimationFrame(updatePlaybackProgress);
    };

    activePlayback.animationFrameId = window.requestAnimationFrame(updatePlaybackProgress);
  }

  private advancePlaybackBoundary(activePlayback: ActiveProjectPlayback): boolean {
    const currentCycle = activePlayback.currentCycle;

    if (
      !currentCycle ||
      activePlayback.audioContext.currentTime <
        currentCycle.endTime - AUDIO_DURATION_EPSILON_SECONDS
    ) {
      return true;
    }

    if (activePlayback.nextCycle) {
      activePlayback.currentCycle = activePlayback.nextCycle;
      activePlayback.nextCycle = undefined;
      activePlayback.lastPlayheadUpdateAt = 0;
      this.ensureNextLoopCycle(activePlayback);
      activePlayback.callbacks.onProgress(
        activePlayback.currentCycle.schedule.startTick,
        activePlayback.currentCycle.schedule.plan,
      );
      return true;
    }

    if (activePlayback.loopEnabled && activePlayback.loopSchedule) {
      const restartTime =
        activePlayback.audioContext.currentTime + PLAYBACK_START_LEAD_SECONDS;
      activePlayback.currentCycle = this.scheduleCycle(
        activePlayback,
        activePlayback.loopSchedule,
        restartTime,
      );
      activePlayback.lastPlayheadUpdateAt = 0;
      this.ensureNextLoopCycle(activePlayback);
      activePlayback.callbacks.onProgress(
        activePlayback.loopSchedule.startTick,
        activePlayback.loopSchedule.plan,
      );
      return true;
    }

    this.complete(activePlayback, currentCycle.schedule);
    return false;
  }

  private ensureNextLoopCycle(activePlayback: ActiveProjectPlayback): void {
    if (
      !activePlayback.loopEnabled ||
      !activePlayback.loopSchedule ||
      !activePlayback.currentCycle ||
      activePlayback.nextCycle
    ) {
      return;
    }

    activePlayback.nextCycle = this.scheduleCycle(
      activePlayback,
      activePlayback.loopSchedule,
      Math.max(
        activePlayback.currentCycle.endTime,
        activePlayback.audioContext.currentTime + PLAYBACK_START_LEAD_SECONDS,
      ),
    );
  }

  private cancelCycle(
    activePlayback: ActiveProjectPlayback,
    cycle: ScheduledPlaybackCycle,
  ): void {
    if (cycle.effectsSequence !== undefined) {
      activePlayback.effectsController?.cancelCycle(cycle.effectsSequence);
    }
    for (const graph of cycle.graphs) {
      graph.source.onended = null;
      activePlayback.scheduledGraphs.delete(graph);

      try {
        graph.source.stop();
      } catch {
        // A source that already reached its scheduled end is already harmless.
      }

      disconnectPlaybackGraph(graph);
    }
  }

  private complete(
    activePlayback: ActiveProjectPlayback,
    completedSchedule: ProjectPlaybackSchedule,
  ): void {
    if (this.activePlayback !== activePlayback) {
      return;
    }

    recordProjectPlaybackDiagnostic('playback-complete', {
      audioContextState: activePlayback.audioContext.state,
      endTick: completedSchedule.endTick,
    });
    this.release(activePlayback);
    activePlayback.callbacks.onComplete(completedSchedule);
  }

  private fail(activePlayback: ActiveProjectPlayback, message: string): void {
    if (this.activePlayback !== activePlayback) {
      return;
    }

    recordProjectPlaybackDiagnostic('playback-failed', {
      audioContextState: activePlayback.audioContext.state,
      message,
      phase: activePlayback.phase,
    });
    this.release(activePlayback);
    activePlayback.callbacks.onError(message, activePlayback.initialSchedule.plan);
  }

  private release(activePlayback: ActiveProjectPlayback): void {
    if (this.activePlayback !== activePlayback) {
      return;
    }

    this.activePlayback = undefined;
    this.clearPreparationDeadline(activePlayback);
    activePlayback.preparationAbortController.abort();

    if (activePlayback.animationFrameId !== undefined) {
      window.cancelAnimationFrame(activePlayback.animationFrameId);
    }

    for (const graph of activePlayback.scheduledGraphs) {
      graph.source.onended = null;

      try {
        graph.source.stop();
      } catch {
        // A source that already ended does not need further cleanup.
      }

      disconnectPlaybackGraph(graph);
    }

    activePlayback.scheduledGraphs.clear();
    activePlayback.trackDspStates.clear();
    activePlayback.effectsController?.terminate();
    activePlayback.masterGainNode?.disconnect();
    void activePlayback.audioContext.close().catch(() => undefined);
  }
}

async function decodeGeneratedWave(
  audioContext: AudioContext,
  bytes: Uint8Array,
  sourceId: string,
  signal: AbortSignal,
): Promise<AudioBuffer | undefined> {
  let source: ReturnType<typeof inspectUncompressedWave>;

  try {
    source = inspectUncompressedWave(bytes, sourceId);
  } catch (error) {
    if (error instanceof TimelineExportEncodingError) {
      return undefined;
    }
    throw error;
  }

  const targetSampleRate = audioContext.sampleRate;
  recordProjectPlaybackDiagnostic('generated-wave-inspected', {
    bitsPerSample: source.bitsPerSample,
    channels: source.channels,
    durationSeconds: source.durationSeconds,
    formatTag: source.formatTag,
    frameCount: source.frameCount,
    sampleRate: source.sampleRate,
    sourceId,
    targetSampleRate,
  });

  if (
    !Number.isSafeInteger(targetSampleRate) ||
    targetSampleRate < 8_000 ||
    targetSampleRate > 192_000
  ) {
    throw new Error(
      `Generated WAV ${sourceId} cannot use the browser audio device sample rate.`,
    );
  }

  const targetFrameCount = Math.round(
    source.durationSeconds * targetSampleRate,
  );

  if (
    !Number.isSafeInteger(targetFrameCount) ||
    targetFrameCount <= 0 ||
    targetFrameCount * source.channels > MAX_GENERATED_WAVE_DECODE_SAMPLES
  ) {
    throw new Error(
      `Generated WAV ${sourceId} exceeds the bounded playback preparation limit.`,
    );
  }

  const audioBuffer = audioContext.createBuffer(
    source.channels,
    targetFrameCount,
    targetSampleRate,
  );
  const blockCapacity = Math.min(
    GENERATED_WAVE_DECODE_BLOCK_FRAMES,
    targetFrameCount,
  );
  const channelBlocks = Array.from(
    { length: source.channels },
    () => new Float32Array(blockCapacity),
  );
  let nonFiniteSampleCount = 0;
  let nonZeroSampleCount = 0;
  let peakAbsoluteSample = 0;

  for (
    let blockStartFrame = 0;
    blockStartFrame < targetFrameCount;
    blockStartFrame += GENERATED_WAVE_DECODE_BLOCK_FRAMES
  ) {
    if (signal.aborted) {
      throw new PlaybackPreparationCanceledError();
    }

    const frameCount = Math.min(
      GENERATED_WAVE_DECODE_BLOCK_FRAMES,
      targetFrameCount - blockStartFrame,
    );

    for (let channel = 0; channel < source.channels; channel += 1) {
      const samples = channelBlocks[channel];

      for (let frame = 0; frame < frameCount; frame += 1) {
        const targetFrame = blockStartFrame + frame;
        const sourceFrame =
          targetFrame * (source.sampleRate / targetSampleRate);
        const sample = readInterpolatedUncompressedWaveSample(
          source,
          sourceFrame,
          channel,
        );
        samples[frame] = sample;
        if (!Number.isFinite(sample)) {
          nonFiniteSampleCount += 1;
        } else {
          const magnitude = Math.abs(sample);
          peakAbsoluteSample = Math.max(peakAbsoluteSample, magnitude);
          if (magnitude > 1e-7) {
            nonZeroSampleCount += 1;
          }
        }
      }

      audioBuffer.copyToChannel(
        samples.subarray(0, frameCount),
        channel,
        blockStartFrame,
      );
    }

    if (blockStartFrame + frameCount < targetFrameCount) {
      await yieldPlaybackPreparation();
    }
  }

  if (signal.aborted) {
    throw new PlaybackPreparationCanceledError();
  }

  recordProjectPlaybackDiagnostic('generated-wave-decoded', {
    channels: source.channels,
    nonFiniteSampleCount,
    nonZeroSampleCount,
    peakAbsoluteSample,
    sourceFrameCount: source.frameCount,
    sourceId,
    sourceSampleRate: source.sampleRate,
    targetFrameCount,
    targetSampleRate,
    totalSampleCount: targetFrameCount * source.channels,
  });
  return audioBuffer;
}

function yieldPlaybackPreparation(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function readPlaybackErrorDetail(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'The decode failure did not provide a browser error message.';
}

export function decibelsToLinearGain(decibels: number): number {
  return decibelsToMixerGain(decibels);
}

function createPlaybackGraph(
  audioContext: AudioContext,
  masterGainNode: GainNode | undefined,
  effectsController: ProjectPlaybackEffectsController | undefined,
  decodedSource: AudioBuffer,
  track: ProjectPlaybackTrackSchedule,
  mixerDspVersion:
    | typeof MIXER_DSP_CONTRACT_VERSION_V1
    | typeof MIXER_DSP_CONTRACT_VERSION_V2,
): ScheduledPlaybackGraph {
  const sourceChannels = decodedSource.numberOfChannels;

  if (sourceChannels !== 1 && sourceChannels !== 2) {
    throw new Error('Playback blocked: Mixer DSP supports only mono or stereo sources.');
  }

  const source = audioContext.createBufferSource();
  source.buffer = decodedSource;

  if (effectsController) {
    effectsController.connectSource(source, track.trackId, sourceChannels);
    return {
      nodes: Object.freeze([source]),
      source,
    };
  }

  if (!masterGainNode) {
    throw new Error('Playback blocked: the legacy Master graph is unavailable.');
  }
  const coefficients = mixerDspVersion === MIXER_DSP_CONTRACT_VERSION_V2
    ? createMixerChannelDspCoefficientsV2(
        track.gainDb,
        track.pan,
        sourceChannels,
      )
    : createMixerChannelDspCoefficients(
        track.gainDb,
        track.pan,
        sourceChannels,
      );
  const faderGainNode = audioContext.createGain();
  const splitterNode = audioContext.createChannelSplitter(2);
  const leftPanGainNode = audioContext.createGain();
  const rightPanGainNode = audioContext.createGain();
  const mergerNode = audioContext.createChannelMerger(2);

  faderGainNode.gain.value = coefficients.faderGain;
  leftPanGainNode.gain.value = coefficients.panLeftGain;
  rightPanGainNode.gain.value = coefficients.panRightGain;

  source.connect(faderGainNode);
  faderGainNode.connect(splitterNode);
  splitterNode.connect(leftPanGainNode, 0);
  splitterNode.connect(rightPanGainNode, sourceChannels === 1 ? 0 : 1);
  leftPanGainNode.connect(mergerNode, 0, 0);
  rightPanGainNode.connect(mergerNode, 0, 1);
  mergerNode.connect(masterGainNode);

  return {
    nodes: Object.freeze([
      source,
      faderGainNode,
      splitterNode,
      leftPanGainNode,
      rightPanGainNode,
      mergerNode,
    ]),
    source,
  };
}

function disconnectPlaybackGraph(graph: ScheduledPlaybackGraph): void {
  for (const node of graph.nodes) {
    node.disconnect();
  }
}

function isPlaybackPlanDspValid(plan: ProjectPlaybackPlan): boolean {
  try {
    if (plan.mixerSnapshot.schemaVersion === 2) {
      assertProjectMixerRenderSnapshotV2(plan.mixerSnapshot);
    } else {
      assertProjectMixerRenderSnapshot(plan.mixerSnapshot);
    }
    decibelsToMixerGain(plan.mixerSnapshot.master.faderDb);
  } catch {
    return false;
  }

  const channels = new Map(
    plan.mixerSnapshot.channels.map((channel) => [channel.trackId, channel]),
  );

  return plan.tracks.every((track) => {
    const channel = channels.get(track.trackId);

    if (
      !channel ||
      track.gainDb !== channel.faderDb ||
      track.pan !== channel.pan
    ) {
      return false;
    }

    try {
      decibelsToMixerGain(track.gainDb);
      if (plan.mixerSnapshot.schemaVersion === 2) {
        createMixerChannelDspCoefficientsV2(track.gainDb, track.pan, 1);
      } else {
        createMixerChannelDspCoefficients(track.gainDb, track.pan, 1);
      }
      return true;
    } catch {
      return false;
    }
  });
}

function assertPlaybackScheduleDsp(schedule: ProjectPlaybackSchedule): void {
  if (
    schedule.plan.purpose === 'mixdown' ||
    schedule.mixerDspVersion !== getPlanningMixerDspVersion(schedule.plan) ||
    !isPlaybackPlanDspValid(schedule.plan) ||
    schedule.masterFaderDb !== schedule.plan.mixerSnapshot.master.faderDb
  ) {
    throw new Error('Playback blocked: the Mixer DSP schedule is invalid or incomplete.');
  }

  const planTracks = new Map(
    schedule.plan.tracks.map((track) => [track.trackId, track]),
  );
  const scheduledTrackIds = new Set<string>();

  for (const track of schedule.tracks) {
    const planTrack = planTracks.get(track.trackId);

    if (
      scheduledTrackIds.has(track.trackId) ||
      !planTrack ||
      track.gainDb !== planTrack.gainDb ||
      track.pan !== planTrack.pan ||
      track.groupTrackId !== planTrack.groupTrackId
    ) {
      throw new Error('Playback blocked: a Track Mixer DSP schedule is invalid.');
    }

    decibelsToMixerGain(track.gainDb);
    if (schedule.mixerDspVersion === MIXER_DSP_CONTRACT_VERSION_V2) {
      createMixerChannelDspCoefficientsV2(track.gainDb, track.pan, 1);
    } else {
      createMixerChannelDspCoefficients(track.gainDb, track.pan, 1);
    }
    scheduledTrackIds.add(track.trackId);
  }
}

function getPlanningMixerDspVersion(
  plan: ProjectPlaybackPlan,
): typeof MIXER_DSP_CONTRACT_VERSION | typeof MIXER_DSP_CONTRACT_VERSION_V2 {
  return plan.purpose === 'mixdown'
    ? MIXER_DSP_CONTRACT_VERSION_V2
    : plan.mixerSnapshot.schemaVersion === 2
      ? MIXER_DSP_CONTRACT_VERSION_V2
      : MIXER_DSP_CONTRACT_VERSION;
}

function createPlaybackEvent(
  clip: ResolvedPlaybackClip,
  scheduleStartTick: number,
  scheduleEndTick: number,
  bpm: number,
): ProjectPlaybackEvent | undefined {
  const timelineStartTick = Math.max(clip.timelineStartTick, scheduleStartTick);
  const timelineEndTick = Math.min(clip.timelineEndTick, scheduleEndTick);

  if (
    timelineEndTick <= timelineStartTick ||
    clip.sourceStartSeconds < 0 ||
    clip.sourceEndSeconds <= clip.sourceStartSeconds
  ) {
    return undefined;
  }

  const sourceStartSeconds =
    clip.sourceStartSeconds +
    timelineTicksToSeconds(timelineStartTick - clip.timelineStartTick, bpm);
  const timelineDurationSeconds = timelineTicksToSeconds(
    timelineEndTick - timelineStartTick,
    bpm,
  );
  const sourceEndSeconds = Math.min(
    clip.sourceEndSeconds,
    timelineEndTick === clip.timelineEndTick
      ? clip.sourceEndSeconds
      : sourceStartSeconds + timelineDurationSeconds,
  );
  const sourceDurationSeconds = sourceEndSeconds - sourceStartSeconds;

  if (
    sourceDurationSeconds <= 0 ||
    Math.abs(timelineDurationSeconds - sourceDurationSeconds) >
      Math.max(AUDIO_DURATION_EPSILON_SECONDS, timelineTicksToSeconds(0.5, bpm))
  ) {
    return undefined;
  }

  return {
    clipId: clip.clipId,
    clipName: clip.clipName,
    durationSeconds: sourceDurationSeconds,
    sourceId: clip.sourceId,
    sourceStartSeconds,
    startOffsetSeconds: timelineTicksToSeconds(timelineStartTick - scheduleStartTick, bpm),
    timelineEndTick,
    timelineStartTick,
  };
}

function collectScheduleSourceIds(
  schedule: ProjectPlaybackSchedule,
  loopSchedule: ProjectPlaybackSchedule | undefined,
): Set<string> {
  return new Set(
    [schedule, ...(loopSchedule ? [loopSchedule] : [])].flatMap((candidate) =>
      candidate.tracks.flatMap((track) => track.events.map((event) => event.sourceId)),
    ),
  );
}

function collectRuntimeTrackSchedules(
  schedule: ProjectPlaybackSchedule,
  loopSchedule: ProjectPlaybackSchedule | undefined,
): Map<string, ProjectPlaybackTrackSchedule> {
  if (
    loopSchedule &&
    (loopSchedule.mixerDspVersion !== schedule.mixerDspVersion ||
      loopSchedule.masterFaderDb !== schedule.masterFaderDb ||
      JSON.stringify(loopSchedule.plan.mixerSnapshot) !==
        JSON.stringify(schedule.plan.mixerSnapshot))
  ) {
    throw new Error('Mixer DSP state changed between the active and Loop Plans.');
  }

  const tracks = new Map<string, ProjectPlaybackTrackSchedule>();

  for (const track of [
    ...schedule.tracks,
    ...(loopSchedule?.tracks ?? []),
  ]) {
    const currentTrack = tracks.get(track.trackId);

    if (
      currentTrack &&
      (currentTrack.gainDb !== track.gainDb ||
        currentTrack.pan !== track.pan ||
        currentTrack.groupTrackId !== track.groupTrackId)
    ) {
      throw new Error(`Track ${track.trackId} changed between the active and Loop Plans.`);
    }

    tracks.set(track.trackId, track);
  }

  return tracks;
}

function shouldUseEffectsWorklet(
  schedule: ProjectPlaybackSchedule,
  loopSchedule: ProjectPlaybackSchedule | undefined,
): boolean {
  // Snapshot v2 always uses the Mixer AudioWorklet so exact Channel and Master
  // meters remain available even when every Insert is bypassed.
  if (schedule.plan.mixerSnapshot.schemaVersion !== 2) {
    if (loopSchedule?.plan.mixerSnapshot.schemaVersion === 2) {
      throw new Error('Mixer DSP state changed between the active and Loop Plans.');
    }
    return false;
  }
  assertProjectMixerRenderSnapshotV2(schedule.plan.mixerSnapshot);
  if (loopSchedule) {
    const loopSnapshot = loopSchedule.plan.mixerSnapshot;
    assertProjectMixerRenderSnapshotV2(loopSnapshot);
  }
  return true;
}

function alignEffectsStartTime(timeSeconds: number): number {
  const frame = Math.ceil(
    timeSeconds * PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ /
      PLAYBACK_EFFECTS_RENDER_QUANTUM_FRAMES,
  ) * PLAYBACK_EFFECTS_RENDER_QUANTUM_FRAMES;
  return frame / PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ;
}

function createPlaybackTargetKey(plan: ProjectPlaybackPlan): string {
  const { target } = plan;

  if (target.kind === 'all') {
    return 'all';
  }

  if (target.kind === 'clip') {
    return `clip:${target.clipId}`;
  }

  if (target.kind === 'track') {
    return `track:${target.trackId}`;
  }

  if (target.kind === 'group') {
    return `group:${target.groupTrackId}:${target.activeTrackId}`;
  }

  if (target.kind === 'tracks') {
    return `tracks:${target.trackIds.join(',')}`;
  }

  return `groups:${target.groupTrackIds.join(',')}:${target.activeTrackIds.join(',')}`;
}

function validateDecodedRanges(
  schedule: ProjectPlaybackSchedule,
  decodedSources: ReadonlyMap<string, AudioBuffer>,
): void {
  for (const event of schedule.tracks.flatMap((track) => track.events)) {
    const decodedSource = decodedSources.get(event.sourceId);

    if (
      decodedSource &&
      decodedSource.numberOfChannels !== 1 &&
      decodedSource.numberOfChannels !== 2
    ) {
      throw new Error(
        `Playback blocked: source ${event.sourceId} must decode as mono or stereo audio.`,
      );
    }

    if (
      !decodedSource ||
      event.sourceStartSeconds + event.durationSeconds >
        decodedSource.duration + AUDIO_DURATION_EPSILON_SECONDS
    ) {
      throw new Error(
        `Playback blocked: ${event.clipName} exceeds its decoded source duration. Relink the source and try again.`,
      );
    }
  }
}
