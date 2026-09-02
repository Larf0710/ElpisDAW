import {
  BASIC_PITCH_MODEL_ID,
  BASIC_PITCH_MODEL_REVISION,
  BASIC_PITCH_PROVIDER_DESCRIPTOR,
  validateBasicPitchProviderJob,
} from './basicPitchProviderDefinition.mjs';

export class BasicPitchProviderWorkerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'BasicPitchProviderWorkerError';
  }
}

export class BasicPitchProviderWorkerController {
  #hostClient;
  #loadedModel;
  #now;

  constructor({ hostClient, now = () => new Date().toISOString() }) {
    if (!isHostClient(hostClient)) {
      throw new TypeError('Basic Pitch Worker requires a Python host client.');
    }

    if (typeof now !== 'function') {
      throw new TypeError('Basic Pitch Worker clock must be a function.');
    }

    this.#hostClient = hostClient;
    this.#now = now;
  }

  inspect() {
    return BASIC_PITCH_PROVIDER_DESCRIPTOR;
  }

  async loadModel(payload) {
    if (
      !isRecord(payload) ||
      payload.modelId !== BASIC_PITCH_MODEL_ID ||
      payload.revision !== BASIC_PITCH_MODEL_REVISION
    ) {
      throw new BasicPitchProviderWorkerError(
        'MODEL_INCOMPATIBLE',
        'Basic Pitch Worker cannot load the requested Model or revision.',
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
      throw createHostResponseError('Basic Pitch Model load result is invalid.');
    }

    this.#loadedModel = Object.freeze({
      loadedAt: result.loadedAt,
      modelId: result.modelId,
      revision: result.revision,
      status: 'LOADED',
    });
    return this.#loadedModel;
  }

  async execute(payload) {
    const job = validateBasicPitchProviderJob(payload);

    if (
      !this.#loadedModel ||
      this.#loadedModel.modelId !== job.modelId ||
      this.#loadedModel.revision !== job.modelRevision
    ) {
      throw new BasicPitchProviderWorkerError(
        'MODEL_NOT_LOADED',
        'Load the requested Basic Pitch Model before execution.',
      );
    }

    const hostResult = await this.#hostClient.execute(job);
    const notes = validateHostNotes(hostResult);
    const completedAt = this.#now();

    if (!isTimestamp(completedAt)) {
      throw new BasicPitchProviderWorkerError(
        'BASIC_PITCH_CLOCK_INVALID',
        'Basic Pitch Worker clock returned an invalid timestamp.',
      );
    }

    return Object.freeze({
      artifact: Object.freeze({
        bpm: job.parameters.projectBpm,
        kind: 'midi',
        notes,
        ticksPerQuarter: job.parameters.ticksPerQuarter,
      }),
      completedAt,
      jobId: job.jobId,
      metadata: Object.freeze({
        modelId: job.modelId,
        modelRevision: job.modelRevision,
        parameters: job.parameters,
        providerId: job.providerId,
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
      throw createHostResponseError('Basic Pitch Model unload result is invalid.');
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
      throw createHostResponseError('Basic Pitch Python host shutdown result is invalid.');
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
      throw new BasicPitchProviderWorkerError(
        'BASIC_PITCH_CLOCK_INVALID',
        'Basic Pitch Worker clock returned an invalid timestamp.',
      );
    }

    return timestamp;
  }
}

function validateHostNotes(value) {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.notes)) {
    throw createHostResponseError('Basic Pitch Python host MIDI result is invalid.');
  }

  const notes = [];
  const noteIds = new Set();
  let previousSortKey;

  for (const [index, note] of value.notes.entries()) {
    if (
      !isRecord(note) ||
      typeof note.id !== 'string' ||
      note.id.length === 0 ||
      noteIds.has(note.id) ||
      !Number.isInteger(note.pitch) ||
      note.pitch < 0 ||
      note.pitch > 127 ||
      !Number.isSafeInteger(note.startTick) ||
      note.startTick < 0 ||
      !Number.isSafeInteger(note.lengthTicks) ||
      note.lengthTicks <= 0 ||
      !Number.isSafeInteger(note.startTick + note.lengthTicks) ||
      !Number.isInteger(note.velocity) ||
      note.velocity < 1 ||
      note.velocity > 127 ||
      (note.confidence !== undefined &&
        (typeof note.confidence !== 'number' ||
          !Number.isFinite(note.confidence) ||
          note.confidence < 0 ||
          note.confidence > 1))
    ) {
      throw createHostResponseError(
        `Basic Pitch Python host returned an invalid MIDI note at index ${index}.`,
      );
    }

    const sortKey = `${String(note.startTick).padStart(16, '0')}:${String(note.pitch).padStart(
      3,
      '0',
    )}:${note.id}`;

    if (previousSortKey !== undefined && sortKey.localeCompare(previousSortKey) < 0) {
      throw createHostResponseError(
        'Basic Pitch Python host MIDI notes must use deterministic order.',
      );
    }

    noteIds.add(note.id);
    previousSortKey = sortKey;
    notes.push(
      Object.freeze({
        ...(note.confidence === undefined ? {} : { confidence: note.confidence }),
        id: note.id,
        lengthTicks: note.lengthTicks,
        pitch: note.pitch,
        startTick: note.startTick,
        velocity: note.velocity,
      }),
    );
  }

  return Object.freeze(notes);
}

function createHostResponseError(message) {
  return new BasicPitchProviderWorkerError('BASIC_PITCH_HOST_RESPONSE_INVALID', message);
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
