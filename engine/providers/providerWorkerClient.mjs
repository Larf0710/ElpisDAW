import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  providerSupportsJob,
  providerSupportsModelLoad,
  validateProviderDescriptor,
  validateProviderJob,
} from './providerContract.mjs';
import { parseProviderProgress } from './providerProgress.mjs';
import {
  DIAGNOSTIC_LOG_SUBSYSTEMS,
  localEngineLogger,
  toDiagnosticErrorFields,
} from '../diagnosticLogger.mjs';

const DEFAULT_WORKER_PATH = fileURLToPath(new URL('./mockProviderWorker.mjs', import.meta.url));

export class ProviderWorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ProviderWorkerError';
  }
}

export class ProviderWorkerClient {
  #expectedExit = false;
  #logger;
  #pendingRequests = new Map();
  #provider;
  #requestTimeoutMs;
  #subsystem;
  #worker;
  #workerId;
  #workerPath;

  constructor({
    logger = localEngineLogger,
    requestTimeoutMs = 5_000,
    subsystem = 'WORKER',
    workerId = `worker-${randomUUID()}`,
    workerPath = DEFAULT_WORKER_PATH,
  } = {}) {
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError('Provider Worker request timeout must be greater than zero.');
    }

    if (typeof workerPath !== 'string' || !isAbsolute(workerPath)) {
      throw new TypeError('Provider Worker path must be absolute.');
    }

    if (
      !isDiagnosticLogger(logger) ||
      !DIAGNOSTIC_LOG_SUBSYSTEMS.includes(subsystem) ||
      typeof workerId !== 'string' ||
      workerId.length === 0
    ) {
      throw new TypeError('Provider Worker diagnostic options are invalid.');
    }

    this.#logger = logger;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#subsystem = subsystem;
    this.#workerId = workerId;
    this.#workerPath = workerPath;
  }

  isRunning() {
    return Boolean(this.#worker && this.#worker.exitCode === null);
  }

  getProviderDescriptor() {
    return this.#provider;
  }

  async start() {
    if (this.#worker) {
      if (!this.#provider) {
        throw new ProviderWorkerError('WORKER_STARTING', 'Provider Worker is already starting.');
      }

      return this.#provider;
    }

    const worker = fork(this.#workerPath, [], {
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    this.#worker = worker;
    this.#logger.info(this.#subsystem, 'WORKER_STARTED', {
      workerId: this.#workerId,
    });
    worker.on('message', (message) => this.#handleMessage(worker, message));
    worker.once('error', (error) => this.#handleWorkerFailure(worker, error));
    worker.once('exit', (code, signal) => {
      this.#handleWorkerExit(worker, code, signal);
    });

    try {
      this.#provider = validateProviderDescriptor(await this.#request('inspect'));
      this.#logger.info(this.#subsystem, 'PROVIDER_READY', {
        compatibility: this.#provider.runtime.compatibility,
        providerId: this.#provider.providerId,
        workerId: this.#workerId,
      });
      return this.#provider;
    } catch (error) {
      this.#logger.error(this.#subsystem, 'WORKER_START_FAILED', {
        ...toDiagnosticErrorFields(error),
        workerId: this.#workerId,
      });
      await this.terminate();
      throw error;
    }
  }

  async loadModel(modelId, revision) {
    const provider = this.#requireProvider();

    if (provider.runtime.compatibility !== 'COMPATIBLE') {
      throw new ProviderWorkerError(
        provider.runtime.compatibility === 'UNVERIFIED'
          ? 'RUNTIME_UNVERIFIED'
          : 'RUNTIME_INCOMPATIBLE',
        'Provider Worker cannot load a Model through an unverified or incompatible Runtime.',
      );
    }

    if (!providerSupportsModelLoad(provider, modelId, revision)) {
      throw new ProviderWorkerError(
        'MODEL_INCOMPATIBLE',
        'Provider Worker cannot load the requested Model or revision.',
      );
    }

    this.#logger.info(this.#subsystem, 'PROVIDER_LOADING', {
      modelId,
      modelRevision: revision,
      providerId: provider.providerId,
      workerId: this.#workerId,
    });
    const result = await this.#request('load-model', { modelId, revision });

    if (
      !isRecord(result) ||
      result.status !== 'LOADED' ||
      result.modelId !== modelId ||
      result.revision !== revision ||
      typeof result.loadedAt !== 'string' ||
      Number.isNaN(Date.parse(result.loadedAt))
    ) {
      throw createInvalidResponseError('Provider Worker returned an invalid Model load result.');
    }

    const loaded = Object.freeze({
      loadedAt: result.loadedAt,
      modelId,
      revision,
      status: 'LOADED',
    });
    this.#logger.info(this.#subsystem, 'MODEL_READY', {
      modelId,
      modelRevision: revision,
      providerId: provider.providerId,
      status: loaded.status,
      workerId: this.#workerId,
    });
    return loaded;
  }

  async unloadModel() {
    const provider = this.#requireProvider();
    const result = await this.#request('unload-model');

    if (
      !isRecord(result) ||
      result.status !== 'UNLOADED' ||
      typeof result.unloadedAt !== 'string' ||
      Number.isNaN(Date.parse(result.unloadedAt))
    ) {
      throw createInvalidResponseError('Provider Worker returned an invalid Model unload result.');
    }

    const unloaded = Object.freeze({
      ...(typeof result.modelId === 'string' ? { modelId: result.modelId } : {}),
      ...(typeof result.revision === 'string' ? { revision: result.revision } : {}),
      status: 'UNLOADED',
      unloadedAt: result.unloadedAt,
    });
    this.#logger.debug(this.#subsystem, 'MODEL_UNLOADED', {
      modelId: unloaded.modelId,
      modelRevision: unloaded.revision,
      providerId: provider.providerId,
      workerId: this.#workerId,
    });
    return unloaded;
  }

  async execute(jobValue, { onProgress } = {}) {
    const provider = this.#requireProvider();
    const job = validateProviderJob(jobValue);

    if (!providerSupportsJob(provider, job)) {
      throw new ProviderWorkerError(
        'JOB_UNSUPPORTED',
        'Provider Worker does not declare support for this Job.',
      );
    }

    this.#logger.info(this.#subsystem, 'PROCESS_STARTED', {
      jobId: job.jobId,
      providerId: job.providerId,
      taskId: job.taskId,
      workerId: this.#workerId,
    });

    try {
      const result = validateProviderExecutionResult(
        await this.#request('execute', job, { onProgress }),
        job,
      );
      this.#logger.info(this.#subsystem, 'OUTPUT_CREATED', {
        bytesWritten: result.artifact.bytesWritten,
        channels: result.artifact.channels,
        durationSeconds: result.artifact.durationSeconds,
        jobId: job.jobId,
        providerId: job.providerId,
        taskId: job.taskId,
        workerId: this.#workerId,
      });
      return result;
    } catch (error) {
      this.#logger.error(this.#subsystem, 'PROVIDER_FAILED', {
        ...toDiagnosticErrorFields(error),
        jobId: job.jobId,
        providerId: job.providerId,
        taskId: job.taskId,
        workerId: this.#workerId,
      });
      throw error;
    }
  }

  async close() {
    const worker = this.#worker;

    if (!worker) {
      return;
    }

    this.#expectedExit = true;
    try {
      if (worker.connected && worker.exitCode === null) {
        const result = await this.#request('shutdown');

        if (!isRecord(result) || result.status !== 'SHUTDOWN') {
          throw createInvalidResponseError('Provider Worker returned an invalid shutdown result.');
        }
      }

      await waitForExit(worker, this.#requestTimeoutMs);
      this.#logger.info(this.#subsystem, 'WORKER_STOPPED', {
        providerId: this.#provider?.providerId,
        workerId: this.#workerId,
      });
    } catch (error) {
      await terminateWorker(worker, this.#requestTimeoutMs);
      throw error;
    } finally {
      if (this.#worker === worker) {
        this.#worker = undefined;
      }

      this.#provider = undefined;
      this.#expectedExit = false;
    }
  }

  async terminate() {
    const worker = this.#worker;

    if (!worker) {
      return;
    }

    this.#expectedExit = true;
    this.#rejectPending(
      new ProviderWorkerError('WORKER_TERMINATED', 'Provider Worker was terminated.'),
    );
    this.#logger.warn(this.#subsystem, 'WORKER_TERMINATED', {
      providerId: this.#provider?.providerId,
      workerId: this.#workerId,
    });
    await terminateWorker(worker, this.#requestTimeoutMs);

    if (this.#worker === worker) {
      this.#worker = undefined;
    }

    this.#provider = undefined;
    this.#expectedExit = false;
  }

  #requireProvider() {
    if (!this.#worker || !this.#provider) {
      throw new ProviderWorkerError('WORKER_NOT_STARTED', 'Start the Provider Worker first.');
    }

    return this.#provider;
  }

  #request(operation, payload, { onProgress } = {}) {
    const worker = this.#worker;

    if (!worker || !worker.connected || worker.exitCode !== null) {
      return Promise.reject(
        new ProviderWorkerError('WORKER_OFFLINE', 'Provider Worker is not connected.'),
      );
    }

    if (this.#pendingRequests.size > 0) {
      return Promise.reject(
        new ProviderWorkerError('WORKER_BUSY', 'Provider Worker accepts one operation at a time.'),
      );
    }

    const requestId = `provider-request-${randomUUID()}`;
    const requestFields = createWorkerRequestLogFields(payload);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.#pendingRequests.delete(requestId);
        const error = new ProviderWorkerError(
          'WORKER_TIMEOUT',
          `Provider Worker ${operation} timed out after ${this.#requestTimeoutMs} ms.`,
        );
        this.#logger.error(this.#subsystem, 'WORKER_REQUEST_FAILED', {
          ...requestFields,
          ...toDiagnosticErrorFields(error),
          operation,
          requestId,
          workerId: this.#workerId,
        });
        reject(error);
      }, this.#requestTimeoutMs);

      this.#pendingRequests.set(requestId, {
        onProgress: typeof onProgress === 'function' ? onProgress : undefined,
        operation,
        reject,
        requestFields,
        resolve,
        timeoutId,
      });
      this.#logger.trace(this.#subsystem, 'WORKER_MESSAGE_SENT', {
        ...requestFields,
        operation,
        requestId,
        workerId: this.#workerId,
      });
      worker.send(
        {
          operation,
          ...(payload === undefined ? {} : { payload }),
          protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
          requestId,
        },
        (error) => {
          if (!error) {
            return;
          }

          const pending = this.#pendingRequests.get(requestId);

          if (pending) {
            clearTimeout(pending.timeoutId);
            this.#pendingRequests.delete(requestId);
            const sendError = new ProviderWorkerError('WORKER_SEND_FAILED', error.message);
            this.#logger.error(this.#subsystem, 'WORKER_REQUEST_FAILED', {
              ...pending.requestFields,
              ...toDiagnosticErrorFields(sendError),
              operation: pending.operation,
              requestId,
              workerId: this.#workerId,
            });
            pending.reject(sendError);
          }
        },
      );
    });
  }

  #handleMessage(worker, message) {
    if (worker !== this.#worker || !isRecord(message) || typeof message.requestId !== 'string') {
      return;
    }

    const pending = this.#pendingRequests.get(message.requestId);

    if (!pending) {
      return;
    }

    if (message.protocolVersion !== PROVIDER_WORKER_PROTOCOL_VERSION) {
      clearTimeout(pending.timeoutId);
      this.#pendingRequests.delete(message.requestId);
      pending.reject(createInvalidResponseError('Provider Worker protocol version is invalid.'));
      return;
    }

    if (message.event === 'progress') {
      const progress = parseProviderProgress(message.progress);

      if (!progress) {
        clearTimeout(pending.timeoutId);
        this.#pendingRequests.delete(message.requestId);
        pending.reject(createInvalidResponseError('Provider Worker progress is malformed.'));
        return;
      }

      try {
        pending.onProgress?.(progress);
      } catch {
        // Progress observation is telemetry and must not fail model execution.
      }
      return;
    }

    clearTimeout(pending.timeoutId);
    this.#pendingRequests.delete(message.requestId);
    this.#logger.trace(this.#subsystem, 'WORKER_MESSAGE_RECEIVED', {
      ...pending.requestFields,
      operation: pending.operation,
      requestId: message.requestId,
      workerId: this.#workerId,
    });

    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }

    if (
      message.ok === false &&
      isRecord(message.error) &&
      typeof message.error.code === 'string' &&
      typeof message.error.message === 'string'
    ) {
      pending.reject(new ProviderWorkerError(message.error.code, message.error.message));
      return;
    }

    pending.reject(createInvalidResponseError('Provider Worker response is malformed.'));
  }

  #handleWorkerFailure(worker, error) {
    if (worker === this.#worker) {
      this.#logger.error(this.#subsystem, 'WORKER_FAILED', {
        ...toDiagnosticErrorFields(error),
        providerId: this.#provider?.providerId,
        workerId: this.#workerId,
      });
      this.#rejectPending(new ProviderWorkerError('WORKER_FAILED', error.message));
    }
  }

  #handleWorkerExit(worker, code, signal) {
    if (worker !== this.#worker) {
      return;
    }

    this.#rejectPending(
      new ProviderWorkerError(
        'WORKER_EXITED',
        `Provider Worker exited${code === null ? '' : ` with code ${code}`}${
          signal ? ` from ${signal}` : ''
        }.`,
      ),
    );
    const logExit = this.#expectedExit
      ? this.#logger.debug.bind(this.#logger)
      : this.#logger.warn.bind(this.#logger);
    logExit(this.#subsystem, 'WORKER_EXITED', {
      exitCode: code ?? undefined,
      providerId: this.#provider?.providerId,
      signal: signal ?? undefined,
      workerId: this.#workerId,
    });
    this.#worker = undefined;
    this.#provider = undefined;
  }

  #rejectPending(error) {
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }

    this.#pendingRequests.clear();
  }
}

export function validateProviderExecutionResult(value, job) {
  const hasSeed = Object.prototype.hasOwnProperty.call(job.parameters, 'seed');

  if (
    !isRecord(value) ||
    value.status !== 'COMPLETED' ||
    value.jobId !== job.jobId ||
    typeof value.completedAt !== 'string' ||
    Number.isNaN(Date.parse(value.completedAt)) ||
    !isRecord(value.artifact) ||
    !isRecord(value.metadata) ||
    value.metadata.providerId !== job.providerId ||
    value.metadata.modelId !== job.modelId ||
    value.metadata.modelRevision !== job.modelRevision ||
    value.metadata.taskId !== job.taskId ||
    (hasSeed
      ? value.metadata.seed !== job.parameters.seed
      : value.metadata.seed !== undefined)
  ) {
    throw createInvalidResponseError('Provider Worker returned an invalid execution result.');
  }

  if (job.output.kind === 'midi') {
    return validateMidiExecutionResult(value, job);
  }

  const expectedChannels = job.parameters.channels ?? 1;
  const hasSha256 = Object.prototype.hasOwnProperty.call(
    value.artifact,
    'sha256',
  );

  if (
    (expectedChannels !== 1 && expectedChannels !== 2) ||
    value.artifact.stagingPath !== job.output.stagingPath ||
    value.artifact.mimeType !== 'audio/wav' ||
    value.artifact.channels !== expectedChannels ||
    typeof value.artifact.bytesWritten !== 'number' ||
    !Number.isSafeInteger(value.artifact.bytesWritten) ||
    value.artifact.bytesWritten <= 44 ||
    typeof value.artifact.durationSeconds !== 'number' ||
    !Number.isFinite(value.artifact.durationSeconds) ||
    value.artifact.durationSeconds <= 0 ||
    (hasSha256 &&
      (typeof value.artifact.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.artifact.sha256)))
  ) {
    throw createInvalidResponseError('Provider Worker returned an invalid audio result.');
  }

  return Object.freeze({
    artifact: Object.freeze({
      bytesWritten: value.artifact.bytesWritten,
      channels: expectedChannels,
      durationSeconds: value.artifact.durationSeconds,
      mimeType: 'audio/wav',
      ...(hasSha256 ? { sha256: value.artifact.sha256 } : {}),
      stagingPath: value.artifact.stagingPath,
    }),
    completedAt: value.completedAt,
    jobId: job.jobId,
    metadata: Object.freeze({
      modelId: job.modelId,
      modelRevision: job.modelRevision,
      parameters: job.parameters,
      providerId: job.providerId,
      ...(hasSeed ? { seed: job.parameters.seed } : {}),
      taskId: job.taskId,
    }),
    status: 'COMPLETED',
  });
}

function validateMidiExecutionResult(value, job) {
  if (
    value.artifact.kind !== 'midi' ||
    value.artifact.bpm !== job.parameters.projectBpm ||
    value.artifact.ticksPerQuarter !== job.parameters.ticksPerQuarter ||
    !Array.isArray(value.artifact.notes)
  ) {
    throw createInvalidResponseError('Provider Worker returned an invalid MIDI result.');
  }

  const notes = [];
  const noteIds = new Set();
  let previousSortKey;

  for (const [index, note] of value.artifact.notes.entries()) {
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
      throw createInvalidResponseError(
        `Provider Worker returned an invalid MIDI note at index ${index}.`,
      );
    }

    const sortKey = `${String(note.startTick).padStart(16, '0')}:${String(note.pitch).padStart(
      3,
      '0',
    )}:${note.id}`;

    if (previousSortKey !== undefined && sortKey.localeCompare(previousSortKey) < 0) {
      throw createInvalidResponseError('Provider Worker MIDI notes must use deterministic order.');
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

  return Object.freeze({
    artifact: Object.freeze({
      bpm: value.artifact.bpm,
      kind: 'midi',
      notes: Object.freeze(notes),
      ticksPerQuarter: value.artifact.ticksPerQuarter,
    }),
    completedAt: value.completedAt,
    jobId: job.jobId,
    metadata: Object.freeze({
      modelId: job.modelId,
      modelRevision: job.modelRevision,
      parameters: job.parameters,
      providerId: job.providerId,
      ...(Object.prototype.hasOwnProperty.call(job.parameters, 'seed')
        ? { seed: job.parameters.seed }
        : {}),
      taskId: job.taskId,
    }),
    status: 'COMPLETED',
  });
}

function waitForExit(worker, timeoutMs) {
  if (hasExited(worker)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      worker.off('exit', handleExit);
      reject(new ProviderWorkerError('WORKER_EXIT_TIMEOUT', 'Provider Worker did not exit.'));
    }, timeoutMs);
    const handleExit = () => {
      clearTimeout(timeoutId);
      resolve();
    };

    worker.once('exit', handleExit);
  });
}

async function terminateWorker(worker, timeoutMs) {
  if (hasExited(worker)) {
    return;
  }

  try {
    if (worker.connected) {
      worker.disconnect();
    }

    await waitForExit(worker, Math.min(timeoutMs, 5_000));
    return;
  } catch {
    // Fall through to forced termination when graceful child cleanup stalls.
  }

  if (hasExited(worker)) {
    return;
  }

  await forceTerminateWorkerTree(worker, Math.min(timeoutMs, 5_000));
  await waitForExit(worker, Math.min(timeoutMs, 5_000));
}

function createWorkerRequestLogFields(payload) {
  if (!isRecord(payload)) {
    return {};
  }

  return {
    jobId: typeof payload.jobId === 'string' ? payload.jobId : undefined,
    modelId: typeof payload.modelId === 'string' ? payload.modelId : undefined,
    modelRevision:
      typeof payload.modelRevision === 'string' ? payload.modelRevision : undefined,
    providerId: typeof payload.providerId === 'string' ? payload.providerId : undefined,
    taskId: typeof payload.taskId === 'string' ? payload.taskId : undefined,
  };
}

function isDiagnosticLogger(value) {
  return (
    value &&
    typeof value.debug === 'function' &&
    typeof value.info === 'function' &&
    typeof value.trace === 'function' &&
    typeof value.warn === 'function' &&
    typeof value.error === 'function'
  );
}

async function forceTerminateWorkerTree(worker, timeoutMs) {
  if (
    process.platform === 'win32' &&
    Number.isSafeInteger(worker.pid) &&
    typeof process.env.SystemRoot === 'string' &&
    isAbsolute(process.env.SystemRoot)
  ) {
    const taskkillPath = join(process.env.SystemRoot, 'System32', 'taskkill.exe');

    await new Promise((resolve) => {
      execFile(
        taskkillPath,
        ['/PID', String(worker.pid), '/T', '/F'],
        { timeout: timeoutMs, windowsHide: true },
        () => resolve(),
      );
    });
  }

  if (!hasExited(worker)) {
    worker.kill();
  }
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function createInvalidResponseError(message) {
  return new ProviderWorkerError('WORKER_RESPONSE_INVALID', message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
