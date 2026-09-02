import { PROVIDER_WORKER_PROTOCOL_VERSION } from './providerContract.mjs';
import { StableAudio3PythonHostClient } from './stableAudio3PythonHostClient.mjs';
import {
  StableAudio3ProviderWorkerController,
} from './stableAudio3ProviderWorkerController.mjs';

const controller = new StableAudio3ProviderWorkerController({
  hostClient: new StableAudio3PythonHostClient(),
});
let activeRequestId;

process.on('message', (message) => {
  void handleMessage(message);
});

process.on('disconnect', () => {
  void controller.terminate().then(
    () => process.exit(0),
    () => {
      process.exitCode = 1;
    },
  );
});

async function handleMessage(message) {
  const requestId = readRequestId(message);

  if (!requestId) {
    return;
  }

  if (activeRequestId) {
    sendFailure(
      requestId,
      'WORKER_BUSY',
      `Stable Audio 3 Provider Worker is busy with ${activeRequestId}.`,
    );
    return;
  }

  activeRequestId = requestId;

  try {
    const operation = readOperation(message);

    if (operation === 'inspect') {
      sendSuccess(requestId, controller.inspect());
    } else if (operation === 'load-model') {
      sendSuccess(requestId, await controller.loadModel(message.payload));
    } else if (operation === 'unload-model') {
      sendSuccess(requestId, await controller.unloadModel());
    } else if (operation === 'execute') {
      sendSuccess(
        requestId,
        await controller.execute(message.payload, {
          onProgress: (progress) => sendProgress(requestId, progress),
        }),
      );
    } else if (operation === 'shutdown') {
      sendSuccess(requestId, await controller.shutdown(), () => {
        process.disconnect();
      });
    } else {
      sendFailure(
        requestId,
        'WORKER_OPERATION_UNSUPPORTED',
        'Worker operation is not supported.',
      );
    }
  } catch (error) {
    sendFailure(
      requestId,
      readErrorCode(error),
      error instanceof Error
        ? error.message
        : 'Stable Audio 3 Provider Worker operation failed.',
    );
  } finally {
    activeRequestId = undefined;
  }
}

function readRequestId(message) {
  if (
    !isRecord(message) ||
    message.protocolVersion !== PROVIDER_WORKER_PROTOCOL_VERSION ||
    typeof message.requestId !== 'string' ||
    message.requestId.length === 0
  ) {
    return undefined;
  }

  return message.requestId;
}

function readOperation(message) {
  return isRecord(message) && typeof message.operation === 'string'
    ? message.operation
    : undefined;
}

function sendSuccess(requestId, result, callback) {
  if (!process.connected) {
    callback?.();
    return;
  }

  process.send?.(
    {
      ok: true,
      protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
      requestId,
      result,
    },
    callback,
  );
}

function sendFailure(requestId, code, message) {
  if (!process.connected) {
    return;
  }

  process.send?.({
    error: { code, message },
    ok: false,
    protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
    requestId,
  });
}

function sendProgress(requestId, progress) {
  if (!process.connected) {
    return;
  }

  process.send?.({
    event: 'progress',
    progress,
    protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
    requestId,
  });
}

function readErrorCode(error) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'WORKER_OPERATION_FAILED';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
