export type MicrophoneRecordingResult = {
  blob: Blob;
  durationSeconds: number;
  inputDeviceId?: string;
  inputDeviceLabel?: string;
  sampleRate: number;
};

type MicrophoneRecordingRuntimeState =
  | 'IDLE'
  | 'PREPARING'
  | 'PREPARED'
  | 'RECORDING'
  | 'FINALIZING';

type MicrophoneRecordingRuntimeDependencies = {
  createAudioContext: () => AudioContext;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
};

type MicrophoneRecordingPrepareOptions = {
  onInputLevel?: (level: number) => void;
  onRecordingProgress?: (elapsedSeconds: number) => void;
};

const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;

function createDefaultDependencies(): MicrophoneRecordingRuntimeDependencies {
  return {
    createAudioContext: () => new AudioContext(),
    getUserMedia: (constraints) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone capture is not supported by this browser.');
      }

      return navigator.mediaDevices.getUserMedia(constraints);
    },
  };
}

function clampSample(sample: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
}

export function encodeMonoPcm16Wav(
  chunks: readonly Float32Array[],
  sampleRate: number,
): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('WAV sample rate must be a positive number.');
  }

  const frameCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytesPerSample = 2;
  const channelCount = 1;
  const dataSize = frameCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let writeOffset = 44;

  for (const chunk of chunks) {
    for (const rawSample of chunk) {
      const sample = clampSample(rawSample);
      const pcmSample = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);

      view.setInt16(writeOffset, pcmSample, true);
      writeOffset += bytesPerSample;
    }
  }

  return buffer;
}

export class MicrophoneRecordingRuntime {
  readonly #dependencies: MicrophoneRecordingRuntimeDependencies;
  #audioContext?: AudioContext;
  #inputDeviceId?: string;
  #inputDeviceLabel?: string;
  #mediaSource?: MediaStreamAudioSourceNode;
  #mutedGain?: GainNode;
  #operationId = 0;
  #onInputLevel?: (level: number) => void;
  #onRecordingProgress?: (elapsedSeconds: number) => void;
  #processor?: ScriptProcessorNode;
  #recordedChunks: Float32Array[] = [];
  #recordedFrameCount = 0;
  #state: MicrophoneRecordingRuntimeState = 'IDLE';
  #stream?: MediaStream;

  constructor(dependencies: Partial<MicrophoneRecordingRuntimeDependencies> = {}) {
    this.#dependencies = {
      ...createDefaultDependencies(),
      ...dependencies,
    };
  }

  get state(): MicrophoneRecordingRuntimeState {
    return this.#state;
  }

  async prepare(options: MicrophoneRecordingPrepareOptions = {}): Promise<boolean> {
    if (this.#state !== 'IDLE') {
      throw new Error('Microphone recording is already active.');
    }

    const operationId = ++this.#operationId;

    this.#state = 'PREPARING';
    this.#onInputLevel = options.onInputLevel;
    this.#onRecordingProgress = options.onRecordingProgress;

    let stream: MediaStream | undefined;
    let audioContext: AudioContext | undefined;

    try {
      stream = await this.#dependencies.getUserMedia({
        audio: {
          autoGainControl: false,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
        },
        video: false,
      });

      if (operationId !== this.#operationId || this.#state !== 'PREPARING') {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }

      audioContext = this.#dependencies.createAudioContext();

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      if (operationId !== this.#operationId || this.#state !== 'PREPARING') {
        stream.getTracks().forEach((track) => track.stop());
        await audioContext.close();
        return false;
      }

      const mediaSource = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(
        SCRIPT_PROCESSOR_BUFFER_SIZE,
        1,
        1,
      );
      const mutedGain = audioContext.createGain();
      const inputTrack = stream.getAudioTracks()[0];
      const settings = inputTrack?.getSettings();
      const recordingSampleRate = audioContext.sampleRate;

      mutedGain.gain.value = 0;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let peak = 0;

        for (const sample of input) {
          peak = Math.max(peak, Math.abs(sample));
        }

        this.#onInputLevel?.(Math.min(1, peak));

        if (this.#state !== 'RECORDING') {
          return;
        }

        const recordedChunk = new Float32Array(input);

        this.#recordedChunks.push(recordedChunk);
        this.#recordedFrameCount += recordedChunk.length;
        this.#onRecordingProgress?.(
          this.#recordedFrameCount / recordingSampleRate,
        );
      };

      mediaSource.connect(processor);
      processor.connect(mutedGain);
      mutedGain.connect(audioContext.destination);

      this.#audioContext = audioContext;
      this.#inputDeviceId = settings?.deviceId;
      this.#inputDeviceLabel = inputTrack?.label || undefined;
      this.#mediaSource = mediaSource;
      this.#mutedGain = mutedGain;
      this.#processor = processor;
      this.#stream = stream;
      this.#state = 'PREPARED';
      this.#onInputLevel?.(0);

      return true;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());

      if (audioContext && audioContext.state !== 'closed') {
        await audioContext.close().catch(() => undefined);
      }

      if (operationId === this.#operationId) {
        this.#resetState();
      }

      throw error;
    }
  }

  beginRecording(): void {
    if (this.#state !== 'PREPARED') {
      throw new Error('Microphone recording is not prepared.');
    }

    this.#recordedChunks = [];
    this.#recordedFrameCount = 0;
    this.#state = 'RECORDING';
  }

  async finish(): Promise<MicrophoneRecordingResult> {
    if (this.#state !== 'RECORDING' || !this.#audioContext) {
      throw new Error('Microphone recording is not active.');
    }

    const chunks = this.#recordedChunks;
    const frameCount = this.#recordedFrameCount;
    const inputDeviceId = this.#inputDeviceId;
    const inputDeviceLabel = this.#inputDeviceLabel;
    const sampleRate = this.#audioContext.sampleRate;

    this.#state = 'FINALIZING';

    try {
      if (frameCount === 0) {
        throw new Error('Microphone recording did not capture any audio frames.');
      }

      const wavBuffer = encodeMonoPcm16Wav(chunks, sampleRate);

      return {
        blob: new Blob([wavBuffer], { type: 'audio/wav' }),
        durationSeconds: frameCount / sampleRate,
        inputDeviceId,
        inputDeviceLabel,
        sampleRate,
      };
    } finally {
      await this.#releaseResources();
      this.#resetState();
    }
  }

  async cancel(): Promise<boolean> {
    const hadActiveCapture = this.#state !== 'IDLE';

    this.#operationId += 1;
    await this.#releaseResources();
    this.#resetState();

    return hadActiveCapture;
  }

  async #releaseResources(): Promise<void> {
    const audioContext = this.#audioContext;
    const stream = this.#stream;

    if (this.#processor) {
      this.#processor.onaudioprocess = null;
    }

    this.#mediaSource?.disconnect();
    this.#processor?.disconnect();
    this.#mutedGain?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    this.#onInputLevel?.(0);

    this.#audioContext = undefined;
    this.#mediaSource = undefined;
    this.#mutedGain = undefined;
    this.#processor = undefined;
    this.#stream = undefined;

    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close().catch(() => undefined);
    }
  }

  #resetState(): void {
    this.#inputDeviceId = undefined;
    this.#inputDeviceLabel = undefined;
    this.#onInputLevel = undefined;
    this.#onRecordingProgress = undefined;
    this.#recordedChunks = [];
    this.#recordedFrameCount = 0;
    this.#state = 'IDLE';
  }
}
