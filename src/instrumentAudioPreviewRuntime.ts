import { decibelsToLinearGain } from './projectPlaybackRuntime';

export type InstrumentAudioPreviewPlan = Readonly<{
  artifactId: string;
  clipId: string;
  clipName: string;
  clipTakeId: string;
  gainDb: number;
  sourceId: string;
}>;

export type InstrumentAudioPreviewCallbacks = Readonly<{
  onComplete: (plan: InstrumentAudioPreviewPlan) => void;
  onError: (message: string, plan: InstrumentAudioPreviewPlan) => void;
  onStarted: (plan: InstrumentAudioPreviewPlan) => void;
}>;

type InstrumentAudioPreviewEnvironment = Readonly<{
  createAudioContext: () => AudioContext;
}>;

type ActiveInstrumentAudioPreview = {
  audioContext: AudioContext;
  callbacks: InstrumentAudioPreviewCallbacks;
  gainNode: GainNode;
  plan: InstrumentAudioPreviewPlan;
  sourceNode?: AudioBufferSourceNode;
};

const defaultEnvironment: InstrumentAudioPreviewEnvironment = {
  createAudioContext: () => new AudioContext(),
};

export class InstrumentAudioPreviewRuntime {
  private activePreview?: ActiveInstrumentAudioPreview;

  constructor(
    private readonly environment: InstrumentAudioPreviewEnvironment = defaultEnvironment,
  ) {}

  isActive(): boolean {
    return this.activePreview !== undefined;
  }

  play(
    wavPromise: Promise<Blob>,
    plan: InstrumentAudioPreviewPlan,
    callbacks: InstrumentAudioPreviewCallbacks,
  ): void {
    if (this.activePreview) {
      throw new Error('Instrument Audio Preview is already active.');
    }

    const audioContext = this.environment.createAudioContext();
    let gainNode: GainNode;

    try {
      gainNode = audioContext.createGain();
      gainNode.gain.value = decibelsToLinearGain(plan.gainDb);
      gainNode.connect(audioContext.destination);
    } catch (error) {
      closeAudioContext(audioContext);
      throw error;
    }

    const activePreview: ActiveInstrumentAudioPreview = {
      audioContext,
      callbacks,
      gainNode,
      plan,
    };

    this.activePreview = activePreview;

    let resumePromise: Promise<void>;

    try {
      resumePromise = audioContext.resume();
    } catch (error) {
      this.fail(activePreview, createPreviewErrorMessage(error));
      return;
    }

    void this.prepare(activePreview, wavPromise, resumePromise);
  }

  stop(): InstrumentAudioPreviewPlan | undefined {
    const activePreview = this.activePreview;

    if (!activePreview) {
      return undefined;
    }

    this.release(activePreview);
    return activePreview.plan;
  }

  private async prepare(
    activePreview: ActiveInstrumentAudioPreview,
    wavPromise: Promise<Blob>,
    resumePromise: Promise<void>,
  ): Promise<void> {
    try {
      const [wav] = await Promise.all([wavPromise, resumePromise]);

      if (this.activePreview !== activePreview) {
        return;
      }

      const audioBuffer = await activePreview.audioContext.decodeAudioData(
        await wav.arrayBuffer(),
      );

      if (this.activePreview !== activePreview) {
        return;
      }

      const sourceNode = activePreview.audioContext.createBufferSource();

      sourceNode.buffer = audioBuffer;
      sourceNode.connect(activePreview.gainNode);
      sourceNode.onended = () => this.complete(activePreview);
      activePreview.sourceNode = sourceNode;
      sourceNode.start();
      activePreview.callbacks.onStarted(activePreview.plan);
    } catch (error) {
      this.fail(activePreview, createPreviewErrorMessage(error));
    }
  }

  private complete(activePreview: ActiveInstrumentAudioPreview): void {
    if (this.activePreview !== activePreview) {
      return;
    }

    this.release(activePreview);
    activePreview.callbacks.onComplete(activePreview.plan);
  }

  private fail(
    activePreview: ActiveInstrumentAudioPreview,
    message: string,
  ): void {
    if (this.activePreview !== activePreview) {
      return;
    }

    this.release(activePreview);
    activePreview.callbacks.onError(message, activePreview.plan);
  }

  private release(activePreview: ActiveInstrumentAudioPreview): void {
    if (this.activePreview !== activePreview) {
      return;
    }

    this.activePreview = undefined;

    if (activePreview.sourceNode) {
      activePreview.sourceNode.onended = null;

      try {
        activePreview.sourceNode.stop();
      } catch {
        // A source that already ended does not need another stop.
      }

      activePreview.sourceNode.disconnect();
    }

    activePreview.gainNode.disconnect();
    closeAudioContext(activePreview.audioContext);
  }
}

function createPreviewErrorMessage(error: unknown): string {
  const detail =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'Generated WAV playback failed unexpectedly.';

  return `Instrument Audio Preview failed: ${detail}`;
}

function closeAudioContext(audioContext: AudioContext): void {
  try {
    void audioContext.close().catch(() => undefined);
  } catch {
    // A context that already failed during setup has no remaining audio resources.
  }
}
