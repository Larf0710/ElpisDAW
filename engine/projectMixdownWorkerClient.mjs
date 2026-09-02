import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import {
  RAW_MIXDOWN_BITS_PER_SAMPLE,
  RAW_MIXDOWN_CHANNELS,
  RAW_MIXDOWN_MIME_TYPE,
  RAW_MIXDOWN_SAMPLE_RATE,
} from '../shared/rawMixdownProtocol.js';
import {
  PROJECT_MIXDOWN_WORKER_OPERATION,
  PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
  PROJECT_STEM_PRINT_WORKER_OPERATION,
} from './projectMixdownWorkerProtocol.mjs';

const DEFAULT_WORKER_URL = new URL('./projectMixdownWorker.mjs', import.meta.url);
const DEFAULT_RENDER_TIMEOUT_MS = 30 * 60 * 1_000;

export class ProjectMixdownWorkerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'ProjectMixdownWorkerError';
  }
}

export class ProjectMixdownWorkerClient {
  #activeWorker;
  #renderTimeoutMs;
  #workerUrl;

  constructor({
    renderTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
    workerUrl = DEFAULT_WORKER_URL,
  } = {}) {
    if (!Number.isSafeInteger(renderTimeoutMs) || renderTimeoutMs <= 0) {
      throw new RangeError('Project Mixdown Worker timeout must be a positive integer.');
    }

    if (!(workerUrl instanceof URL) || workerUrl.protocol !== 'file:') {
      throw new TypeError('Project Mixdown Worker URL must be one local file URL.');
    }

    this.#renderTimeoutMs = renderTimeoutMs;
    this.#workerUrl = workerUrl;
  }

  isRunning() {
    return this.#activeWorker !== undefined;
  }

  async render(plan, sourceBytes, options = {}) {
    return this.#renderOperation(
      PROJECT_MIXDOWN_WORKER_OPERATION,
      'mixdown-worker',
      plan,
      sourceBytes,
      options,
    );
  }

  async renderStemPrint(plan, sourceBytes, options = {}) {
    return this.#renderOperation(
      PROJECT_STEM_PRINT_WORKER_OPERATION,
      'stem-print-worker',
      plan,
      sourceBytes,
      options,
    );
  }

  async #renderOperation(operation, requestPrefix, plan, sourceBytes, options) {
    const signal = validateOptions(options);

    if (this.#activeWorker) {
      throw new ProjectMixdownWorkerError(
        'MIXDOWN_WORKER_BUSY',
        'Project Mixdown Worker is already rendering.',
      );
    }

    if (signal?.aborted) {
      throw aborted();
    }

    const { entries, transferList } = prepareSourceEntries(sourceBytes);
    const requestId = `${requestPrefix}-${randomUUID()}`;
    const worker = new Worker(this.#workerUrl, { type: 'module' });
    this.#activeWorker = worker;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        void finish(
          undefined,
          new ProjectMixdownWorkerError(
            'MIXDOWN_WORKER_TIMEOUT',
            `Project Mixdown Worker timed out after ${this.#renderTimeoutMs} ms.`,
          ),
        );
      }, this.#renderTimeoutMs);
      const handleAbort = () => {
        void finish(undefined, aborted());
      };
      const handleError = (error) => {
        void finish(
          undefined,
          new ProjectMixdownWorkerError(
            'MIXDOWN_WORKER_FAILED',
            'Project Mixdown Worker failed.',
            { cause: error },
          ),
        );
      };
      const handleExit = (code) => {
        if (!settled) {
          void finish(
            undefined,
            new ProjectMixdownWorkerError(
              'MIXDOWN_WORKER_EXITED',
              `Project Mixdown Worker exited before returning a result with code ${code}.`,
            ),
            false,
          );
        }
      };
      const handleMessage = (message) => {
        try {
          const result = parseResponse(message, operation, requestId);
          void finish(result);
        } catch (error) {
          void finish(undefined, error);
        }
      };
      const finish = async (result, error, terminate = true) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', handleAbort);
        worker.off('error', handleError);
        worker.off('exit', handleExit);
        worker.off('message', handleMessage);
        let terminationError;

        if (terminate && worker.threadId !== -1) {
          try {
            await worker.terminate();
          } catch (cause) {
            terminationError = new ProjectMixdownWorkerError(
              'MIXDOWN_WORKER_TERMINATION_FAILED',
              'Project Mixdown Worker could not be terminated cleanly.',
              { cause },
            );
          }
        }

        if (this.#activeWorker === worker) {
          this.#activeWorker = undefined;
        }

        if (error || terminationError) {
          reject(error ?? terminationError);
        } else {
          resolve(result);
        }
      };

      signal?.addEventListener('abort', handleAbort, { once: true });
      worker.once('error', handleError);
      worker.once('exit', handleExit);
      worker.once('message', handleMessage);

      try {
        worker.postMessage(
          {
            operation,
            plan,
            protocolVersion: PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
            requestId,
            sourceEntries: entries,
          },
          transferList,
        );
      } catch (error) {
        void finish(
          undefined,
          new ProjectMixdownWorkerError(
            'MIXDOWN_WORKER_SEND_FAILED',
            'Project Mixdown request could not be sent to the Worker.',
            { cause: error },
          ),
        );
      }
    });
  }
}

function prepareSourceEntries(value) {
  if (!(value instanceof Map) || value.size === 0) {
    throw new ProjectMixdownWorkerError(
      'MIXDOWN_WORKER_REQUEST_INVALID',
      'Project Mixdown Worker requires a non-empty source Map.',
    );
  }

  const entries = [];
  const transferList = [];

  for (const [sourceId, valueBytes] of value) {
    if (
      typeof sourceId !== 'string' ||
      sourceId.length === 0 ||
      sourceId.trim() !== sourceId ||
      (!Buffer.isBuffer(valueBytes) && !(valueBytes instanceof Uint8Array)) ||
      valueBytes.byteLength === 0
    ) {
      throw new ProjectMixdownWorkerError(
        'MIXDOWN_WORKER_REQUEST_INVALID',
        'Project Mixdown Worker source Map is invalid.',
      );
    }

    const bytes = Uint8Array.from(valueBytes);
    entries.push({ bytes, sourceId });
    transferList.push(bytes.buffer);
  }

  return { entries, transferList };
}

function parseResponse(value, operation, requestId) {
  if (
    !isRecord(value) ||
    value.operation !== operation ||
    value.protocolVersion !== PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION ||
    value.requestId !== requestId ||
    typeof value.ok !== 'boolean'
  ) {
    throw responseInvalid('Project Mixdown Worker response envelope is invalid.');
  }

  if (value.ok === false) {
    requireExactResponseKeys(
      value,
      ['error', 'ok', 'operation', 'protocolVersion', 'requestId'],
      'Project Mixdown Worker error envelope',
    );

    if (
      !isRecord(value.error) ||
      typeof value.error.code !== 'string' ||
      typeof value.error.message !== 'string' ||
      typeof value.error.name !== 'string'
    ) {
      throw responseInvalid('Project Mixdown Worker error response is invalid.');
    }

    requireExactResponseKeys(
      value.error,
      ['code', 'message', 'name'],
      'Project Mixdown Worker error',
    );

    throw new ProjectMixdownWorkerError(
      value.error.code,
      value.error.message,
    );
  }

  requireExactResponseKeys(
    value,
    ['ok', 'operation', 'protocolVersion', 'requestId', 'result'],
    'Project Mixdown Worker success envelope',
  );
  const result = value.result;

  if (
    !isRecord(result) ||
    result.bitsPerSample !== RAW_MIXDOWN_BITS_PER_SAMPLE ||
    result.channels !== RAW_MIXDOWN_CHANNELS ||
    !Number.isFinite(result.durationSeconds) ||
    result.durationSeconds <= 0 ||
    !Number.isSafeInteger(result.frameCount) ||
    result.frameCount <= 0 ||
    result.mimeType !== RAW_MIXDOWN_MIME_TYPE ||
    result.sampleRate !== RAW_MIXDOWN_SAMPLE_RATE ||
    !(result.bytes instanceof Uint8Array)
  ) {
    throw responseInvalid('Project Mixdown Worker result metadata is invalid.');
  }

  requireExactResponseKeys(
    result,
    [
      'bitsPerSample',
      'bytes',
      'channels',
      'durationSeconds',
      'frameCount',
      'mimeType',
      'sampleRate',
    ],
    'Project Mixdown Worker result',
  );

  const bytes = Buffer.from(
    result.bytes.buffer,
    result.bytes.byteOffset,
    result.bytes.byteLength,
  );
  const bytesPerSample = RAW_MIXDOWN_BITS_PER_SAMPLE / 8;
  const blockAlignment = RAW_MIXDOWN_CHANNELS * bytesPerSample;
  const dataByteLength = result.frameCount * blockAlignment;
  const expectedByteLength = 44 + dataByteLength;

  if (
    !Number.isSafeInteger(dataByteLength) ||
    bytes.byteLength !== expectedByteLength ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.readUInt32LE(4) !== expectedByteLength - 8 ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.toString('ascii', 12, 16) !== 'fmt ' ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== RAW_MIXDOWN_CHANNELS ||
    bytes.readUInt32LE(24) !== RAW_MIXDOWN_SAMPLE_RATE ||
    bytes.readUInt32LE(28) !== RAW_MIXDOWN_SAMPLE_RATE * blockAlignment ||
    bytes.readUInt16LE(32) !== blockAlignment ||
    bytes.readUInt16LE(34) !== RAW_MIXDOWN_BITS_PER_SAMPLE ||
    bytes.toString('ascii', 36, 40) !== 'data' ||
    bytes.readUInt32LE(40) !== dataByteLength ||
    result.durationSeconds !== result.frameCount / RAW_MIXDOWN_SAMPLE_RATE
  ) {
    throw responseInvalid('Project Mixdown Worker WAV result is invalid.');
  }

  return Object.freeze({
    bitsPerSample: RAW_MIXDOWN_BITS_PER_SAMPLE,
    bytes,
    channels: RAW_MIXDOWN_CHANNELS,
    durationSeconds: result.durationSeconds,
    frameCount: result.frameCount,
    mimeType: RAW_MIXDOWN_MIME_TYPE,
    sampleRate: RAW_MIXDOWN_SAMPLE_RATE,
  });
}

function requireExactResponseKeys(value, expectedKeys, label) {
  if (!isRecord(value)) {
    throw responseInvalid(`${label} must be an object.`);
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw responseInvalid(`${label} keys are invalid.`);
  }
}

function validateOptions(value) {
  if (!isRecord(value)) {
    throw new ProjectMixdownWorkerError(
      'MIXDOWN_WORKER_REQUEST_INVALID',
      'Project Mixdown Worker options must be an object.',
    );
  }

  if (value.signal === undefined) {
    return undefined;
  }

  if (
    !isRecord(value.signal) ||
    typeof value.signal.aborted !== 'boolean' ||
    typeof value.signal.addEventListener !== 'function' ||
    typeof value.signal.removeEventListener !== 'function'
  ) {
    throw new ProjectMixdownWorkerError(
      'MIXDOWN_WORKER_REQUEST_INVALID',
      'Project Mixdown Worker signal is invalid.',
    );
  }

  return value.signal;
}

function aborted() {
  return new ProjectMixdownWorkerError(
    'MIXDOWN_ABORTED',
    'Project Mixdown was aborted.',
  );
}

function responseInvalid(message) {
  return new ProjectMixdownWorkerError(
    'MIXDOWN_WORKER_RESPONSE_INVALID',
    message,
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
