import { MIXER_DSP_CONTRACT_VERSION_V2 } from '../shared/mixerDspContract.js';
import { MIXER_EFFECTS_SAMPLE_RATE_HZ } from '../shared/mixerEffectsContract.js';
import {
  MIXER_METER_CONTRACT_VERSION,
  MIXER_SAMPLE_PEAK_CLIP_THRESHOLD,
} from '../shared/mixerMeterContract.js';
import type { MixerMeterTapSummary } from '../shared/mixerMeterTapContract.js';
import {
  MIXER_CHANNEL_METER_TAP_POSITION,
  MIXER_MASTER_METER_TAP_POSITION,
  MIXER_METER_TAP_CONTRACT_VERSION,
} from '../shared/mixerMeterTapContract.js';
import {
  PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE,
  PROJECT_PLAYBACK_AUDIO_WORKLET_METER_INTERVAL_FRAMES,
  PROJECT_PLAYBACK_AUDIO_WORKLET_PROCESSOR_NAME,
  assertProjectPlaybackAudioWorkletEventMessage,
  createProjectPlaybackAudioWorkletCancelMessage,
  createProjectPlaybackAudioWorkletConfiguration,
  createProjectPlaybackAudioWorkletMeterAcknowledgement,
  createProjectPlaybackAudioWorkletScheduleMessage,
  createProjectPlaybackAudioWorkletTerminateMessage,
  type ProjectPlaybackAudioWorkletMeterMessage,
} from '../shared/projectPlaybackAudioWorkletProtocol.js';
import {
  PROJECT_PLAYBACK_MIXER_KERNEL_VERSION,
  createProjectPlaybackMixerKernelConfiguration,
  estimateProjectPlaybackMixerKernelRuntimeBytes,
  type ProjectPlaybackMixerKernelConfiguration,
} from '../shared/projectPlaybackMixerKernel.js';
import { PROJECT_PLAYBACK_AUDIO_WORKLET_MODULE_URL } from './projectPlaybackAudioWorkletModule';
import type { ProjectPlaybackSchedule } from './projectPlaybackRuntime';
import {
  assertProjectMixerRenderSnapshotV2,
  type ProjectMixerRenderSnapshotV2,
} from './projectMixerRenderSnapshot';

export const PROJECT_PLAYBACK_EFFECTS_RUNTIME_VERSION = 1 as const;
export const PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ =
  MIXER_EFFECTS_SAMPLE_RATE_HZ;
export const PROJECT_PLAYBACK_EFFECTS_HANDSHAKE_TIMEOUT_MS = 5_000;

export type ProjectPlaybackEffectsFailureReason =
  | 'audio-worklet-unavailable'
  | 'handshake-failed'
  | 'module-load-failed'
  | 'protocol-failed'
  | 'source-sample-rate-unsupported'
  | 'unsupported-sample-rate';

export class ProjectPlaybackEffectsRuntimeError extends Error {
  readonly reason: ProjectPlaybackEffectsFailureReason;

  constructor(reason: ProjectPlaybackEffectsFailureReason, message: string) {
    super(message);
    this.name = 'ProjectPlaybackEffectsRuntimeError';
    this.reason = reason;
  }
}

export type ProjectPlaybackRuntimeMeterSnapshot = Readonly<{
  cycleSequence: number;
  frameEnd: number;
  frameStart: number;
  meterSummary: MixerMeterTapSummary;
  sessionId: string;
  version: typeof PROJECT_PLAYBACK_EFFECTS_RUNTIME_VERSION;
}>;

export type ProjectPlaybackEffectsControllerEnvironment = Readonly<{
  createAudioWorkletNode: (
    context: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ) => AudioWorkletNode;
  handshakeTimeoutMs: number;
  moduleUrl: string;
}>;

export type CreateProjectPlaybackEffectsControllerInput = Readonly<{
  audioContext: AudioContext;
  decodedSources: ReadonlyMap<string, AudioBuffer>;
  destination: AudioNode;
  environment?: Partial<ProjectPlaybackEffectsControllerEnvironment>;
  onError: (error: ProjectPlaybackEffectsRuntimeError) => void;
  onMeterSnapshot?: (snapshot: ProjectPlaybackRuntimeMeterSnapshot) => void;
  schedules: readonly ProjectPlaybackSchedule[];
}>;

const defaultEnvironment: ProjectPlaybackEffectsControllerEnvironment = {
  createAudioWorkletNode: (context, name, options) =>
    new AudioWorkletNode(context, name, options),
  handshakeTimeoutMs: PROJECT_PLAYBACK_EFFECTS_HANDSHAKE_TIMEOUT_MS,
  moduleUrl: PROJECT_PLAYBACK_AUDIO_WORKLET_MODULE_URL,
};

let nextSessionSequence = 1;

export class ProjectPlaybackEffectsController {
  readonly inputIndexByTrackAndChannels: ReadonlyMap<string, number>;
  readonly node: AudioWorkletNode;
  readonly sessionId: string;

  private failed = false;
  private readonly expectedMeterTrackIds: readonly string[];
  private lastMeterFrameEnd = -1;
  private lastMeterSequence = 0;
  private latestMeterSnapshot?: ProjectPlaybackRuntimeMeterSnapshot;
  private nextCycleSequence = 1;
  private readonly onError: (error: ProjectPlaybackEffectsRuntimeError) => void;
  private readonly onMeterSnapshot?: (snapshot: ProjectPlaybackRuntimeMeterSnapshot) => void;
  private readonly scheduledCycles = new Set<number>();
  private terminated = false;

  constructor(
    sessionId: string,
    node: AudioWorkletNode,
    inputIndexByTrackAndChannels: ReadonlyMap<string, number>,
    expectedMeterTrackIds: readonly string[],
    onError: (error: ProjectPlaybackEffectsRuntimeError) => void,
    onMeterSnapshot?: (snapshot: ProjectPlaybackRuntimeMeterSnapshot) => void,
  ) {
    this.sessionId = sessionId;
    this.node = node;
    this.inputIndexByTrackAndChannels = inputIndexByTrackAndChannels;
    this.expectedMeterTrackIds = Object.freeze([...expectedMeterTrackIds]);
    this.onError = onError;
    this.onMeterSnapshot = onMeterSnapshot;
  }

  attachMessageHandler(): void {
    this.node.port.onmessage = (event) => this.handleEvent(event.data);
    this.node.onprocessorerror = () => {
      this.fail('protocol-failed', 'Playback stopped: the Mixer AudioWorklet processor failed.');
    };
    this.node.port.start();
  }

  connectSource(
    source: AudioBufferSourceNode,
    trackId: string,
    sourceChannels: number,
  ): void {
    const inputIndex = this.inputIndexByTrackAndChannels.get(
      createInputKey(trackId, sourceChannels),
    );
    if (inputIndex === undefined || this.terminated || this.failed) {
      throw new ProjectPlaybackEffectsRuntimeError(
        'protocol-failed',
        `Playback stopped: Track ${trackId} has no valid AudioWorklet input.`,
      );
    }
    source.connect(this.node, 0, inputIndex);
  }

  scheduleCycle(startFrame: number, endFrame: number): number {
    if (this.terminated || this.failed) {
      throw new ProjectPlaybackEffectsRuntimeError(
        'protocol-failed',
        'Playback stopped: the Mixer AudioWorklet session is unavailable.',
      );
    }
    const sequence = this.nextCycleSequence;
    this.nextCycleSequence += 1;
    this.node.port.postMessage(
      createProjectPlaybackAudioWorkletScheduleMessage(
        this.sessionId,
        sequence,
        startFrame,
        endFrame,
      ),
    );
    this.scheduledCycles.add(sequence);
    return sequence;
  }

  cancelCycle(sequence: number): void {
    if (this.terminated || this.failed) {
      return;
    }
    this.node.port.postMessage(
      createProjectPlaybackAudioWorkletCancelMessage(this.sessionId, sequence),
    );
  }

  getMeterSnapshot(): ProjectPlaybackRuntimeMeterSnapshot | undefined {
    return this.latestMeterSnapshot;
  }

  terminate(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    if (!this.failed) {
      this.node.port.postMessage(
        createProjectPlaybackAudioWorkletTerminateMessage(this.sessionId),
      );
    }
    this.node.port.onmessage = null;
    this.node.onprocessorerror = null;
    this.node.port.close();
    this.node.disconnect();
  }

  private handleEvent(value: unknown): void {
    if (this.terminated || this.failed) {
      return;
    }
    try {
      assertProjectPlaybackAudioWorkletEventMessage(value);
      if (!isRecord(value) || value.sessionId !== this.sessionId) {
        throw new TypeError('AudioWorklet event belongs to another Playback session.');
      }
      if (value.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.error) {
        this.fail(
          'protocol-failed',
          `Playback stopped: Mixer AudioWorklet ${String(value.code)} at frame ${String(value.framePosition)}.`,
        );
        return;
      }
      if (value.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.unsupported) {
        this.fail(
          'unsupported-sample-rate',
          `Playback stopped: Mixer effects require ${PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ} Hz AudioWorklet processing.`,
        );
        return;
      }
      if (value.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.meter) {
        const snapshot = freezeRuntimeMeterSnapshot(value);
        if (
          snapshot.meterSummary.channels.length !==
            this.expectedMeterTrackIds.length ||
          snapshot.meterSummary.channels.some(
            (channel, index) =>
              channel.trackId !== this.expectedMeterTrackIds[index],
          ) ||
          !this.scheduledCycles.has(snapshot.cycleSequence) ||
          snapshot.cycleSequence < this.lastMeterSequence ||
          (snapshot.cycleSequence === this.lastMeterSequence &&
            snapshot.frameStart !== this.lastMeterFrameEnd)
        ) {
          throw new TypeError('AudioWorklet meter message is stale or out of order.');
        }
        this.lastMeterSequence = snapshot.cycleSequence;
        this.lastMeterFrameEnd = snapshot.frameEnd;
        this.latestMeterSnapshot = snapshot;
        this.onMeterSnapshot?.(snapshot);
        this.node.port.postMessage(
          createProjectPlaybackAudioWorkletMeterAcknowledgement(
            this.sessionId,
            snapshot.cycleSequence,
            snapshot.frameEnd,
          ),
        );
        return;
      }
      if (value.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.cycleComplete) {
        const sequence = readEventSequence(value);
        if (
          !this.scheduledCycles.has(sequence) ||
          sequence !== Math.min(...this.scheduledCycles)
        ) {
          throw new TypeError('AudioWorklet cycle completion is stale or out of order.');
        }
        this.scheduledCycles.delete(sequence);
        return;
      }
      if (value.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.cycleCanceled) {
        const sequence = readEventSequence(value);
        if (!this.scheduledCycles.delete(sequence)) {
          throw new TypeError('AudioWorklet cycle cancellation is stale or duplicated.');
        }
        return;
      }
      throw new TypeError('AudioWorklet event is unexpected for an active session.');
    } catch {
      this.fail(
        'protocol-failed',
        'Playback stopped: the Mixer AudioWorklet protocol failed validation.',
      );
    }
  }

  private fail(reason: ProjectPlaybackEffectsFailureReason, message: string): void {
    if (this.failed || this.terminated) {
      return;
    }
    this.failed = true;
    this.onError(new ProjectPlaybackEffectsRuntimeError(reason, message));
  }
}

export async function createProjectPlaybackEffectsController(
  input: CreateProjectPlaybackEffectsControllerInput,
): Promise<ProjectPlaybackEffectsController> {
  const environment = { ...defaultEnvironment, ...input.environment };
  if (
    input.audioContext.sampleRate !== PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ
  ) {
    throw new ProjectPlaybackEffectsRuntimeError(
      'unsupported-sample-rate',
      `Playback blocked: Mixer effects require an exact ${PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ} Hz AudioContext.`,
    );
  }
  if (!input.audioContext.audioWorklet) {
    throw new ProjectPlaybackEffectsRuntimeError(
      'audio-worklet-unavailable',
      'Playback blocked: AudioWorklet is unavailable in this browser.',
    );
  }

  const { configuration, inputIndexByTrackAndChannels } =
    createKernelConfiguration(input.schedules, input.decodedSources);
  for (const buffer of input.decodedSources.values()) {
    if (buffer.sampleRate !== PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ) {
      throw new ProjectPlaybackEffectsRuntimeError(
        'source-sample-rate-unsupported',
        `Playback blocked: enabled Mixer effects require ${PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ} Hz decoded sources.`,
      );
    }
  }

  try {
    await input.audioContext.audioWorklet.addModule(environment.moduleUrl);
  } catch {
    throw new ProjectPlaybackEffectsRuntimeError(
      'module-load-failed',
      'Playback blocked: the Mixer AudioWorklet module could not be loaded.',
    );
  }

  const sessionId = `project-playback-${nextSessionSequence}`;
  nextSessionSequence += 1;
  const workletConfiguration = createProjectPlaybackAudioWorkletConfiguration(
    sessionId,
    configuration,
  );
  let node: AudioWorkletNode;
  try {
    node = environment.createAudioWorkletNode(
      input.audioContext,
      PROJECT_PLAYBACK_AUDIO_WORKLET_PROCESSOR_NAME,
      {
        channelCount: 2,
        channelCountMode: 'max',
        channelInterpretation: 'discrete',
        numberOfInputs: inputIndexByTrackAndChannels.size,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { configuration: workletConfiguration },
      },
    );
  } catch {
    throw new ProjectPlaybackEffectsRuntimeError(
      'audio-worklet-unavailable',
      'Playback blocked: the Mixer AudioWorklet node could not be created.',
    );
  }

  const controller = new ProjectPlaybackEffectsController(
    sessionId,
    node,
    inputIndexByTrackAndChannels,
    configuration.channels.map((channel) => channel.trackId),
    input.onError,
    input.onMeterSnapshot,
  );
  const ready = waitForReady(
    node,
    sessionId,
    inputIndexByTrackAndChannels.size,
    estimateProjectPlaybackMixerKernelRuntimeBytes(configuration).delayRuntimeBytes,
    environment.handshakeTimeoutMs,
  );
  node.port.start();
  node.connect(input.destination);
  try {
    await ready;
  } catch (error) {
    controller.terminate();
    throw error;
  }
  controller.attachMessageHandler();
  return controller;
}

export function hasEnabledProjectPlaybackEffects(
  snapshot: ProjectMixerRenderSnapshotV2,
): boolean {
  assertProjectMixerRenderSnapshotV2(snapshot);
  return snapshot.channels.some((channel) =>
    channel.inserts.some((effect) => !effect.bypass)) ||
    snapshot.master.inserts.some((effect) => !effect.bypass);
}

function createKernelConfiguration(
  schedules: readonly ProjectPlaybackSchedule[],
  decodedSources: ReadonlyMap<string, AudioBuffer>,
): Readonly<{
  configuration: ProjectPlaybackMixerKernelConfiguration;
  inputIndexByTrackAndChannels: ReadonlyMap<string, number>;
}> {
  if (schedules.length === 0) {
    throw new ProjectPlaybackEffectsRuntimeError(
      'protocol-failed',
      'Playback blocked: no AudioWorklet schedule was provided.',
    );
  }
  const firstSnapshot = schedules[0].plan.mixerSnapshot;
  assertProjectMixerRenderSnapshotV2(firstSnapshot);
  const serializedSnapshot = JSON.stringify(firstSnapshot);
  for (const schedule of schedules) {
    assertProjectMixerRenderSnapshotV2(schedule.plan.mixerSnapshot);
    if (JSON.stringify(schedule.plan.mixerSnapshot) !== serializedSnapshot) {
      throw new ProjectPlaybackEffectsRuntimeError(
        'protocol-failed',
        'Playback blocked: Mixer effects changed between Playback schedules.',
      );
    }
  }

  const scheduledTracks = new Map<string, Set<number>>();
  for (const schedule of schedules) {
    for (const track of schedule.tracks) {
      const channelCounts = scheduledTracks.get(track.trackId) ?? new Set<number>();
      for (const event of track.events) {
        const buffer = decodedSources.get(event.sourceId);
        if (!buffer || (buffer.numberOfChannels !== 1 && buffer.numberOfChannels !== 2)) {
          throw new ProjectPlaybackEffectsRuntimeError(
            'protocol-failed',
            `Playback blocked: Track ${track.trackId} has an invalid decoded source.`,
          );
        }
        channelCounts.add(buffer.numberOfChannels);
      }
      scheduledTracks.set(track.trackId, channelCounts);
    }
  }

  const inputIndexByTrackAndChannels = new Map<string, number>();
  let nextInputIndex = 0;
  const channels = firstSnapshot.channels.flatMap((channel) => {
    const sourceChannelCounts = scheduledTracks.get(channel.trackId);
    if (!sourceChannelCounts || sourceChannelCounts.size === 0) {
      return [];
    }
    const inputs = [...sourceChannelCounts].sort().map((sourceChannels) => {
      const inputIndex = nextInputIndex;
      nextInputIndex += 1;
      inputIndexByTrackAndChannels.set(
        createInputKey(channel.trackId, sourceChannels),
        inputIndex,
      );
      return { inputIndex, sourceChannels: sourceChannels as 1 | 2 };
    });
    return [{
      faderDb: channel.faderDb,
      inputs,
      inserts: channel.inserts,
      pan: channel.pan,
      trackId: channel.trackId,
    }];
  });

  return {
    configuration: createProjectPlaybackMixerKernelConfiguration({
      channels,
      master: {
        faderDb: firstSnapshot.master.faderDb,
        inserts: firstSnapshot.master.inserts,
      },
      meterTapVersion: MIXER_METER_TAP_CONTRACT_VERSION,
      mixerDspVersion: MIXER_DSP_CONTRACT_VERSION_V2,
      sampleRateHz: PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ,
      version: PROJECT_PLAYBACK_MIXER_KERNEL_VERSION,
    }),
    inputIndexByTrackAndChannels,
  };
}

function waitForReady(
  node: AudioWorkletNode,
  sessionId: string,
  expectedInputCount: number,
  expectedDelayRuntimeBytes: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new ProjectPlaybackEffectsRuntimeError(
        'handshake-failed',
        'Playback blocked: the Mixer AudioWorklet handshake timed out.',
      ));
    }, timeoutMs);
    const previousHandler = node.port.onmessage;
    node.port.onmessage = (event) => {
      const value = event.data;
      try {
        assertProjectPlaybackAudioWorkletEventMessage(value);
        if (!isRecord(value) || value.sessionId !== sessionId) {
          throw new TypeError('AudioWorklet handshake session is invalid.');
        }
        if (
          value.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.ready &&
          value.actualSampleRateHz === PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ &&
          value.inputCount === expectedInputCount &&
          value.delayRuntimeBytes === expectedDelayRuntimeBytes &&
          value.meterIntervalFrames ===
            PROJECT_PLAYBACK_AUDIO_WORKLET_METER_INTERVAL_FRAMES
        ) {
          globalThis.clearTimeout(timeoutId);
          node.port.onmessage = previousHandler;
          resolve();
          return;
        }
        if (value.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.unsupported) {
          globalThis.clearTimeout(timeoutId);
          reject(new ProjectPlaybackEffectsRuntimeError(
            'unsupported-sample-rate',
            `Playback blocked: Mixer effects require ${PROJECT_PLAYBACK_EFFECTS_SAMPLE_RATE_HZ} Hz AudioWorklet processing.`,
          ));
          return;
        }
        if (value.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.error) {
          globalThis.clearTimeout(timeoutId);
          reject(new ProjectPlaybackEffectsRuntimeError(
            'handshake-failed',
            'Playback blocked: the Mixer AudioWorklet rejected initialization.',
          ));
        }
      } catch {
        globalThis.clearTimeout(timeoutId);
        reject(new ProjectPlaybackEffectsRuntimeError(
          'handshake-failed',
          'Playback blocked: the Mixer AudioWorklet handshake was malformed.',
        ));
      }
    };
  });
}

function freezeRuntimeMeterSnapshot(
  value: Record<string, unknown>,
): ProjectPlaybackRuntimeMeterSnapshot {
  const message = value as unknown as ProjectPlaybackAudioWorkletMeterMessage;
  if (
    !Number.isSafeInteger(message.cycleSequence) ||
    !Number.isSafeInteger(message.frameStart) ||
    !Number.isSafeInteger(message.frameEnd) ||
    message.cycleSequence <= 0 ||
    message.frameStart < 0 ||
    message.frameEnd <= message.frameStart
  ) {
    throw new TypeError('AudioWorklet meter frame range is invalid.');
  }
  const meterSummary = freezeMeterSummary(
    message.meterSummary,
    message.frameEnd - message.frameStart,
  );
  return Object.freeze({
    cycleSequence: message.cycleSequence,
    frameEnd: message.frameEnd,
    frameStart: message.frameStart,
    meterSummary,
    sessionId: message.sessionId,
    version: PROJECT_PLAYBACK_EFFECTS_RUNTIME_VERSION,
  });
}

function freezeMeterSummary(
  summary: MixerMeterTapSummary,
  expectedSampleCount: number,
): MixerMeterTapSummary {
  if (
    !isRecord(summary) ||
    !hasExactKeys(summary, [
      'channelTapPosition',
      'channels',
      'master',
      'masterTapPosition',
      'samplePeakContractVersion',
      'schemaVersion',
    ]) ||
    summary.schemaVersion !== MIXER_METER_TAP_CONTRACT_VERSION ||
    summary.samplePeakContractVersion !== MIXER_METER_CONTRACT_VERSION ||
    summary.channelTapPosition !== MIXER_CHANNEL_METER_TAP_POSITION ||
    summary.masterTapPosition !== MIXER_MASTER_METER_TAP_POSITION ||
    !Array.isArray(summary.channels) ||
    !isRecord(summary.master)
  ) {
    throw new TypeError('AudioWorklet meter summary is invalid.');
  }
  const trackIds = new Set<string>();
  const channels = summary.channels.map((channel) => {
    if (
      !isRecord(channel) ||
      !hasExactKeys(channel, ['meter', 'trackId']) ||
      typeof channel.trackId !== 'string' ||
      channel.trackId.length === 0 ||
      channel.trackId.trim() !== channel.trackId ||
      trackIds.has(channel.trackId)
    ) {
      throw new TypeError('AudioWorklet Channel meter summary is invalid.');
    }
    trackIds.add(channel.trackId);
    return Object.freeze({
      meter: freezePeakSnapshot(channel.meter, expectedSampleCount),
      trackId: channel.trackId,
    });
  });
  return Object.freeze({
    channelTapPosition: summary.channelTapPosition,
    channels: Object.freeze(channels),
    master: freezePeakSnapshot(summary.master, expectedSampleCount),
    masterTapPosition: summary.masterTapPosition,
    samplePeakContractVersion: summary.samplePeakContractVersion,
    schemaVersion: summary.schemaVersion,
  });
}

function freezePeakSnapshot(
  snapshot: unknown,
  expectedSampleCount: number,
): MixerMeterTapSummary['master'] {
  if (
    !isRecord(snapshot) ||
    !hasExactKeys(snapshot, ['clipped', 'left', 'right', 'sampleCount', 'version']) ||
    !isRecord(snapshot.left) ||
    !hasExactKeys(snapshot.left, ['clipped', 'peak']) ||
    !isRecord(snapshot.right) ||
    !hasExactKeys(snapshot.right, ['clipped', 'peak']) ||
    snapshot.version !== MIXER_METER_CONTRACT_VERSION ||
    typeof snapshot.sampleCount !== 'number' ||
    !Number.isSafeInteger(snapshot.sampleCount) ||
    snapshot.sampleCount !== expectedSampleCount ||
    typeof snapshot.left.peak !== 'number' ||
    !Number.isFinite(snapshot.left.peak) ||
    snapshot.left.peak < 0 ||
    typeof snapshot.right.peak !== 'number' ||
    !Number.isFinite(snapshot.right.peak) ||
    snapshot.right.peak < 0 ||
    typeof snapshot.left.clipped !== 'boolean' ||
    typeof snapshot.right.clipped !== 'boolean' ||
    typeof snapshot.clipped !== 'boolean' ||
    snapshot.left.clipped !==
      (snapshot.left.peak > MIXER_SAMPLE_PEAK_CLIP_THRESHOLD) ||
    snapshot.right.clipped !==
      (snapshot.right.peak > MIXER_SAMPLE_PEAK_CLIP_THRESHOLD) ||
    snapshot.clipped !== (snapshot.left.clipped || snapshot.right.clipped)
  ) {
    throw new TypeError('AudioWorklet sample-peak snapshot is invalid.');
  }
  return Object.freeze({
    clipped: snapshot.clipped,
    left: Object.freeze({
      clipped: snapshot.left.clipped,
      peak: snapshot.left.peak,
    }),
    right: Object.freeze({
      clipped: snapshot.right.clipped,
      peak: snapshot.right.peak,
    }),
    sampleCount: snapshot.sampleCount,
    version: snapshot.version,
  });
}

function createInputKey(trackId: string, sourceChannels: number): string {
  return `${trackId}:${sourceChannels}`;
}

function readEventSequence(value: Record<string, unknown>): number {
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) <= 0) {
    throw new TypeError('AudioWorklet event sequence is invalid.');
  }
  return Number(value.sequence);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => expected.has(key));
}
