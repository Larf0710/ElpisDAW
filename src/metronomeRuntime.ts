import type {
  MetronomeClickPlan,
  RecordingTimingPlan,
} from './recordingTiming';
import {
  METRONOME_VOLUME_MAX,
  METRONOME_VOLUME_MIN,
} from './recordingSettings';

const METRONOME_START_LEAD_SECONDS = 0.05;
const METRONOME_SCHEDULER_INTERVAL_MS = 100;
const METRONOME_SCHEDULER_HORIZON_SECONDS = 0.5;
const METRONOME_TONE_DURATION_SECONDS = 0.045;
const METRONOME_ACCENT_FREQUENCY_HZ = 1_760;
const METRONOME_BEAT_FREQUENCY_HZ = 1_320;
const METRONOME_ENVELOPE_FLOOR = 0.0001;

type TimerHandle = unknown;

type MetronomeAudioParam = {
  value: number;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
  setValueAtTime(value: number, startTime: number): void;
};

type MetronomeGainNode = {
  gain: MetronomeAudioParam;
  connect(destination: unknown): void;
};

type MetronomeOscillatorNode = {
  frequency: { value: number };
  type: OscillatorType;
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
};

type MetronomeAudioContext = {
  readonly currentTime: number;
  readonly destination: unknown;
  close(): Promise<void>;
  createGain(): MetronomeGainNode;
  createOscillator(): MetronomeOscillatorNode;
  resume(): Promise<void>;
};

type MetronomeTimers = {
  clearInterval(handle: TimerHandle): void;
  clearTimeout(handle: TimerHandle): void;
  setInterval(callback: () => void, delayMs: number): TimerHandle;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
};

export type MetronomeRuntimeOptions = Readonly<{
  metronomeEnabled: boolean;
  onCountInComplete: (plan: RecordingTimingPlan) => void;
  onError: (message: string, plan: RecordingTimingPlan) => void;
  volume: number;
}>;

export type MetronomeRuntimeDependencies = Readonly<{
  createAudioContext: () => MetronomeAudioContext;
  timers: MetronomeTimers;
}>;

type ActiveMetronome = {
  audioContext: MetronomeAudioContext;
  audioStartTime?: number;
  countInTimer?: TimerHandle;
  masterGainNode: MetronomeGainNode;
  nextRecordingClickIndex: number;
  options: MetronomeRuntimeOptions;
  plan: RecordingTimingPlan;
  schedulerTimer?: TimerHandle;
};

export class MetronomeRuntime {
  private activeMetronome?: ActiveMetronome;
  private readonly dependencies: MetronomeRuntimeDependencies;

  constructor(dependencies: MetronomeRuntimeDependencies = createBrowserDependencies()) {
    this.dependencies = dependencies;
  }

  isActive(): boolean {
    return this.activeMetronome !== undefined;
  }

  start(plan: RecordingTimingPlan, options: MetronomeRuntimeOptions): void {
    if (this.activeMetronome) {
      throw new Error('Metronome is already active.');
    }

    validateVolume(options.volume);
    const audioContext = this.dependencies.createAudioContext();
    const masterGainNode = audioContext.createGain();
    const activeMetronome: ActiveMetronome = {
      audioContext,
      masterGainNode,
      nextRecordingClickIndex: 0,
      options,
      plan,
    };

    masterGainNode.gain.value = options.volume / METRONOME_VOLUME_MAX;
    masterGainNode.connect(audioContext.destination);
    this.activeMetronome = activeMetronome;

    void audioContext
      .resume()
      .then(() => this.beginScheduling(activeMetronome))
      .catch((error) => {
        if (this.activeMetronome !== activeMetronome) {
          return;
        }

        this.release(activeMetronome);
        options.onError(
          error instanceof Error
            ? `Metronome could not start: ${error.message}`
            : 'Metronome could not start.',
          plan,
        );
      });
  }

  stop(): boolean {
    const activeMetronome = this.activeMetronome;

    if (!activeMetronome) {
      return false;
    }

    this.release(activeMetronome);
    return true;
  }

  private beginScheduling(activeMetronome: ActiveMetronome): void {
    if (this.activeMetronome !== activeMetronome) {
      return;
    }

    const { audioContext, options, plan } = activeMetronome;
    activeMetronome.audioStartTime =
      audioContext.currentTime + METRONOME_START_LEAD_SECONDS;

    for (const click of plan.countInClicks) {
      this.scheduleClick(activeMetronome, click, click.offsetSeconds);
    }

    if (options.metronomeEnabled) {
      this.scheduleRecordingClicks(activeMetronome);
      activeMetronome.schedulerTimer = this.dependencies.timers.setInterval(
        () => this.scheduleRecordingClicks(activeMetronome),
        METRONOME_SCHEDULER_INTERVAL_MS,
      );
    }

    const countInDelayMs = Math.max(
      0,
      (activeMetronome.audioStartTime +
        plan.recordingStartOffsetSeconds -
        audioContext.currentTime) *
        1_000,
    );
    activeMetronome.countInTimer = this.dependencies.timers.setTimeout(() => {
      if (this.activeMetronome !== activeMetronome) {
        return;
      }

      options.onCountInComplete(plan);
    }, countInDelayMs);
  }

  private scheduleRecordingClicks(activeMetronome: ActiveMetronome): void {
    const { audioContext, audioStartTime, plan } = activeMetronome;

    if (
      this.activeMetronome !== activeMetronome ||
      audioStartTime === undefined ||
      plan.recordingCycleClicks.length === 0
    ) {
      return;
    }

    const horizonTime =
      audioContext.currentTime + METRONOME_SCHEDULER_HORIZON_SECONDS;

    while (true) {
      const clickIndex = activeMetronome.nextRecordingClickIndex;
      const cycleIndex = clickIndex % plan.recordingCycleClicks.length;
      const cycleNumber = Math.floor(
        clickIndex / plan.recordingCycleClicks.length,
      );
      const click = plan.recordingCycleClicks[cycleIndex];
      const offsetSeconds =
        click.offsetSeconds +
        cycleNumber *
          plan.recordingCycleClicks.length *
          plan.beatDurationSeconds;
      const clickTime = audioStartTime + offsetSeconds;

      if (clickTime > horizonTime) {
        return;
      }

      if (clickTime >= audioContext.currentTime) {
        this.scheduleClick(activeMetronome, click, offsetSeconds);
      }

      activeMetronome.nextRecordingClickIndex += 1;
    }
  }

  private scheduleClick(
    activeMetronome: ActiveMetronome,
    click: MetronomeClickPlan,
    offsetSeconds: number,
  ): void {
    const { audioContext, audioStartTime, masterGainNode } = activeMetronome;

    if (audioStartTime === undefined) {
      return;
    }

    const clickTime = audioStartTime + offsetSeconds;
    const clickGainNode = audioContext.createGain();
    const oscillator = audioContext.createOscillator();

    oscillator.type = 'sine';
    oscillator.frequency.value = click.accented
      ? METRONOME_ACCENT_FREQUENCY_HZ
      : METRONOME_BEAT_FREQUENCY_HZ;
    clickGainNode.gain.setValueAtTime(METRONOME_ENVELOPE_FLOOR, clickTime);
    clickGainNode.gain.exponentialRampToValueAtTime(1, clickTime + 0.002);
    clickGainNode.gain.exponentialRampToValueAtTime(
      METRONOME_ENVELOPE_FLOOR,
      clickTime + METRONOME_TONE_DURATION_SECONDS,
    );
    oscillator.connect(clickGainNode);
    clickGainNode.connect(masterGainNode);
    oscillator.start(clickTime);
    oscillator.stop(clickTime + METRONOME_TONE_DURATION_SECONDS);
  }

  private release(activeMetronome: ActiveMetronome): void {
    if (this.activeMetronome !== activeMetronome) {
      return;
    }

    this.activeMetronome = undefined;

    if (activeMetronome.countInTimer !== undefined) {
      this.dependencies.timers.clearTimeout(activeMetronome.countInTimer);
    }

    if (activeMetronome.schedulerTimer !== undefined) {
      this.dependencies.timers.clearInterval(activeMetronome.schedulerTimer);
    }

    void activeMetronome.audioContext.close();
  }
}

function validateVolume(volume: number): void {
  if (
    !Number.isFinite(volume) ||
    volume < METRONOME_VOLUME_MIN ||
    volume > METRONOME_VOLUME_MAX
  ) {
    throw new RangeError(
      `Metronome Volume must be between ${METRONOME_VOLUME_MIN} and ${METRONOME_VOLUME_MAX}.`,
    );
  }
}

function createBrowserDependencies(): MetronomeRuntimeDependencies {
  return {
    createAudioContext: () => new AudioContext(),
    timers: {
      clearInterval: (handle) => globalThis.clearInterval(handle as number),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
      setInterval: (callback, delayMs) =>
        globalThis.setInterval(callback, delayMs),
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    },
  };
}
