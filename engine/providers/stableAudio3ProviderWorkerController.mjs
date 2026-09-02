import {
  STABLE_AUDIO_3_PROVIDER_DESCRIPTOR,
  validateStableAudio3ProviderJob,
} from './stableAudio3ProviderDefinition.mjs';
import { createStableAudio3PartialWavPath } from './stableAudio3StagingPath.mjs';
import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_SAMPLE_RATE,
} from '../../shared/stableAudio3Protocol.js';

export class StableAudio3ProviderWorkerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'StableAudio3ProviderWorkerError';
  }
}

export class StableAudio3ProviderWorkerController {
  #hostClient;
  #loadedModel;
  #now;

  constructor({ hostClient, now = () => new Date().toISOString() }) {
    if (!isHostClient(hostClient)) {
      throw new TypeError('Stable Audio 3 Worker requires a Python host client.');
    }

    if (typeof now !== 'function') {
      throw new TypeError('Stable Audio 3 Worker clock must be a function.');
    }

    this.#hostClient = hostClient;
    this.#now = now;
  }

  inspect() {
    return STABLE_AUDIO_3_PROVIDER_DESCRIPTOR;
  }

  async loadModel(payload) {
    if (
      !isRecord(payload) ||
      payload.modelId !== STABLE_AUDIO_3_MODEL_ID ||
      payload.revision !== STABLE_AUDIO_3_MODEL_REVISION
    ) {
      throw new StableAudio3ProviderWorkerError(
        'MODEL_INCOMPATIBLE',
        'Stable Audio 3 Worker cannot load the requested Model or revision.',
      );
    }

    if (this.#loadedModel) {
      return this.#loadedModel;
    }

    await this.#hostClient.start();
    const result = await this.#hostClient.loadModel(payload.modelId, payload.revision);

    if (
      !isRecord(result) ||
      result.status !== 'LOADED' ||
      result.modelId !== payload.modelId ||
      result.revision !== payload.revision ||
      !isTimestamp(result.loadedAt)
    ) {
      throw createHostResponseError('Stable Audio 3 Model load result is invalid.');
    }

    this.#loadedModel = Object.freeze({
      loadedAt: result.loadedAt,
      modelId: result.modelId,
      revision: result.revision,
      status: 'LOADED',
    });
    return this.#loadedModel;
  }

  async execute(payload, { onProgress } = {}) {
    const job = validateStableAudio3ProviderJob(payload);

    if (
      !this.#loadedModel ||
      this.#loadedModel.modelId !== job.modelId ||
      this.#loadedModel.revision !== job.modelRevision
    ) {
      throw new StableAudio3ProviderWorkerError(
        'MODEL_NOT_LOADED',
        'Load the requested Stable Audio 3 Model before execution.',
      );
    }

    const partialWavPath = createStableAudio3PartialWavPath(job.output.stagingPath);
    const hostResult = await this.#hostClient.execute(
      {
        ...job,
        output: {
          kind: 'audio',
          partialWavPath,
          stagingPath: job.output.stagingPath,
        },
      },
      { onProgress },
    );
    const artifact = validateHostArtifact(hostResult, job);
    const completedAt = this.#readNow();

    return Object.freeze({
      artifact,
      completedAt,
      jobId: job.jobId,
      metadata: Object.freeze({
        modelId: job.modelId,
        modelRevision: job.modelRevision,
        parameters: job.parameters,
        providerId: job.providerId,
        seed: job.parameters.seed,
        taskId: job.taskId,
      }),
      status: 'COMPLETED',
    });
  }

  async unloadModel() {
    const previousModel = this.#loadedModel;

    if (!previousModel) {
      return Object.freeze({ status: 'UNLOADED', unloadedAt: this.#readNow() });
    }

    const result = await this.#hostClient.unloadModel();

    if (
      !isRecord(result) ||
      result.status !== 'UNLOADED' ||
      result.modelId !== previousModel.modelId ||
      result.revision !== previousModel.revision ||
      !isTimestamp(result.unloadedAt)
    ) {
      throw createHostResponseError('Stable Audio 3 Model unload result is invalid.');
    }

    this.#loadedModel = undefined;
    return Object.freeze({
      modelId: result.modelId,
      revision: result.revision,
      status: 'UNLOADED',
      unloadedAt: result.unloadedAt,
    });
  }

  async shutdown() {
    this.#loadedModel = undefined;
    const result = await this.#hostClient.shutdown();

    if (!isRecord(result) || result.status !== 'SHUTDOWN') {
      throw createHostResponseError('Stable Audio 3 Python host shutdown result is invalid.');
    }

    return Object.freeze({ status: 'SHUTDOWN' });
  }

  async terminate() {
    this.#loadedModel = undefined;
    await this.#hostClient.terminate();
  }

  #readNow() {
    const timestamp = this.#now();

    if (!isTimestamp(timestamp)) {
      throw new StableAudio3ProviderWorkerError(
        'STABLE_AUDIO_3_CLOCK_INVALID',
        'Stable Audio 3 Worker clock returned an invalid timestamp.',
      );
    }

    return timestamp;
  }
}

function validateHostArtifact(value, job) {
  if (
    !isRecord(value) ||
    value.stagingPath !== job.output.stagingPath ||
    value.mimeType !== 'audio/wav' ||
    value.channels !== STABLE_AUDIO_3_CHANNELS ||
    value.sampleRate !== STABLE_AUDIO_3_SAMPLE_RATE ||
    !Number.isSafeInteger(value.bytesWritten) ||
    value.bytesWritten <= 44 ||
    typeof value.durationSeconds !== 'number' ||
    !Number.isFinite(value.durationSeconds) ||
    Math.abs(value.durationSeconds - job.parameters.durationSeconds) >
      1 / STABLE_AUDIO_3_SAMPLE_RATE ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw createHostResponseError('Stable Audio 3 Python host audio result is invalid.');
  }

  return Object.freeze({
    bytesWritten: value.bytesWritten,
    channels: STABLE_AUDIO_3_CHANNELS,
    durationSeconds: value.durationSeconds,
    mimeType: 'audio/wav',
    sampleRate: STABLE_AUDIO_3_SAMPLE_RATE,
    sha256: value.sha256,
    stagingPath: job.output.stagingPath,
  });
}

function createHostResponseError(message) {
  return new StableAudio3ProviderWorkerError(
    'STABLE_AUDIO_3_HOST_RESPONSE_INVALID',
    message,
  );
}

function isTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isHostClient(value) {
  return (
    value &&
    typeof value.start === 'function' &&
    typeof value.loadModel === 'function' &&
    typeof value.execute === 'function' &&
    typeof value.unloadModel === 'function' &&
    typeof value.shutdown === 'function' &&
    typeof value.terminate === 'function'
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
