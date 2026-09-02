import { parentPort } from 'node:worker_threads';

import { renderProjectPcmMixdown } from './projectPcmMixdownRenderer.mjs';
import { renderProjectPcmStemPrint } from './projectPcmStemPrintRenderer.mjs';
import {
  PROJECT_MIXDOWN_WORKER_OPERATION,
  PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
  PROJECT_RENDER_WORKER_UNKNOWN_OPERATION,
  PROJECT_STEM_PRINT_WORKER_OPERATION,
} from './projectMixdownWorkerProtocol.mjs';

if (!parentPort) {
  throw new Error('Project Mixdown Worker requires a parent message port.');
}

parentPort.once('message', (message) => {
  let requestId = 'unknown-request';
  let operation = getResponseOperation(message);

  try {
    const request = validateRequest(message);
    requestId = request.requestId;
    operation = request.operation;
    const rendered = selectRenderer(operation)(
      request.plan,
      createSourceMap(request.sourceEntries),
    );
    const bytes = createTransferableView(rendered.bytes);
    parentPort.postMessage(
      {
        ok: true,
        operation,
        protocolVersion: PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
        requestId,
        result: {
          bitsPerSample: rendered.bitsPerSample,
          bytes,
          channels: rendered.channels,
          durationSeconds: rendered.durationSeconds,
          frameCount: rendered.frameCount,
          mimeType: rendered.mimeType,
          sampleRate: rendered.sampleRate,
        },
      },
      [bytes.buffer],
    );
  } catch (error) {
    parentPort.postMessage({
      error: serializeError(error),
      ok: false,
      operation,
      protocolVersion: PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
      requestId,
    });
  } finally {
    parentPort.close();
  }
});

function validateRequest(value) {
  requireExactKeys(
    value,
    ['operation', 'plan', 'protocolVersion', 'requestId', 'sourceEntries'],
    'Project Mixdown Worker request',
  );

  if (
    value.protocolVersion !== PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION ||
    !isSupportedOperation(value.operation) ||
    !isTrimmedText(value.requestId) ||
    !Array.isArray(value.sourceEntries)
  ) {
    throw workerRequestInvalid('Project Mixdown Worker request identity is invalid.');
  }

  return value;
}

function selectRenderer(operation) {
  return operation === PROJECT_STEM_PRINT_WORKER_OPERATION
    ? renderProjectPcmStemPrint
    : renderProjectPcmMixdown;
}

function getResponseOperation(value) {
  return isRecord(value) && isSupportedOperation(value.operation)
    ? value.operation
    : PROJECT_RENDER_WORKER_UNKNOWN_OPERATION;
}

function isSupportedOperation(value) {
  return (
    value === PROJECT_MIXDOWN_WORKER_OPERATION ||
    value === PROJECT_STEM_PRINT_WORKER_OPERATION
  );
}

function createSourceMap(entries) {
  const sources = new Map();

  for (const entry of entries) {
    requireExactKeys(entry, ['bytes', 'sourceId'], 'Project Mixdown Worker source');

    if (
      !isTrimmedText(entry.sourceId) ||
      sources.has(entry.sourceId) ||
      !(entry.bytes instanceof Uint8Array) ||
      entry.bytes.byteLength === 0
    ) {
      throw workerRequestInvalid('Project Mixdown Worker source is invalid.');
    }

    sources.set(
      entry.sourceId,
      Buffer.from(
        entry.bytes.buffer,
        entry.bytes.byteOffset,
        entry.bytes.byteLength,
      ),
    );
  }

  return sources;
}

function createTransferableView(bytes) {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return new Uint8Array(bytes.buffer);
  }

  return Uint8Array.from(bytes);
}

function serializeError(error) {
  return {
    code:
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'MIXDOWN_WORKER_RENDER_FAILED',
    message:
      error instanceof Error
        ? error.message
        : 'Project Mixdown Worker failed unexpectedly.',
    name: error instanceof Error ? error.name : 'Error',
  };
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) {
    throw workerRequestInvalid(`${label} must be an object.`);
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw workerRequestInvalid(`${label} keys are invalid.`);
  }
}

function workerRequestInvalid(message) {
  return Object.assign(new Error(message), {
    code: 'MIXDOWN_WORKER_REQUEST_INVALID',
  });
}

function isTrimmedText(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
