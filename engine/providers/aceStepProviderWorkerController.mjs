import {
  ACE_STEP_MODEL_ID,
  ACE_STEP_PROVIDER_DESCRIPTOR,
  validateAceStepProviderJob,
} from './aceStepProviderDefinition.mjs';
import {
  ACE_STEP_CHANNELS,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_SAMPLE_RATE,
} from './aceStepRuntimeProfile.mjs';
import { createAceStepPartialWavPath } from './aceStepStagingPath.mjs';

export class AceStepProviderWorkerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'AceStepProviderWorkerError';
  }
}

export class AceStepProviderWorkerController {
  #hostClient;
  #loadedModel;
  #now;

  constructor({ hostClient, now = () => new Date().toISOString() }) {
    if (!isHostClient(hostClient)) {
      throw new TypeError('ACE-Step Worker requires a Python host client.');
    }
    if (typeof now !== 'function') {
      throw new TypeError('ACE-Step Worker clock must be a function.');
    }

    this.#hostClient = hostClient;
    this.#now = now;
  }

  inspect() {
    return ACE_STEP_PROVIDER_DESCRIPTOR;
  }

  async loadModel(payload) {
    if (
      !isRecord(payload) ||
      payload.modelId !== ACE_STEP_MODEL_ID ||
      payload.revision !== ACE_STEP_MODEL_REVISION
    ) {
      throw new AceStepProviderWorkerError(
        'MODEL_INCOMPATIBLE',
        'ACE-Step Worker cannot load the requested Model or revision.',
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
      throw hostResponseError('ACE-Step Model load result is invalid.');
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
    const job = validateAceStepProviderJob(payload);
    if (
      !this.#loadedModel ||
      this.#loadedModel.modelId !== job.modelId ||
      this.#loadedModel.revision !== job.modelRevision
    ) {
      throw new AceStepProviderWorkerError(
        'MODEL_NOT_LOADED',
        'Load the requested ACE-Step Model before execution.',
      );
    }

    const hostResult = await this.#hostClient.execute(
      {
        ...job,
        output: {
          kind: 'audio',
          partialWavPath: createAceStepPartialWavPath(job.output.stagingPath),
          stagingPath: job.output.stagingPath,
        },
      },
      { onProgress },
    );
    const artifact = validateHostArtifact(hostResult, job);

    return Object.freeze({
      artifact,
      completedAt: this.#readNow(),
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
      throw hostResponseError('ACE-Step Model unload result is invalid.');
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
      throw hostResponseError('ACE-Step Python host shutdown result is invalid.');
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
      throw new AceStepProviderWorkerError(
        'ACE_STEP_CLOCK_INVALID',
        'ACE-Step Worker clock returned an invalid timestamp.',
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
    value.channels !== ACE_STEP_CHANNELS ||
    value.sampleRate !== ACE_STEP_SAMPLE_RATE ||
    !Number.isSafeInteger(value.bytesWritten) ||
    value.bytesWritten <= 44 ||
    typeof value.durationSeconds !== 'number' ||
    !Number.isFinite(value.durationSeconds) ||
    Math.abs(value.durationSeconds - job.parameters.durationSeconds) > 0.1 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw hostResponseError('ACE-Step Python host audio result is invalid.');
  }

  return Object.freeze({
    bytesWritten: value.bytesWritten,
    channels: ACE_STEP_CHANNELS,
    durationSeconds: value.durationSeconds,
    mimeType: 'audio/wav',
    sampleRate: ACE_STEP_SAMPLE_RATE,
    sha256: value.sha256,
    stagingPath: job.output.stagingPath,
  });
}

function hostResponseError(message) {
  return new AceStepProviderWorkerError('ACE_STEP_HOST_RESPONSE_INVALID', message);
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
