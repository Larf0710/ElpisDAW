import { parentPort } from 'node:worker_threads';

import {
  PROJECT_MIXDOWN_WORKER_OPERATION,
  PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
  PROJECT_STEM_PRINT_WORKER_OPERATION,
} from './projectMixdownWorkerProtocol.mjs';

if (!parentPort) {
  throw new Error('Wrong-operation test Worker requires a parent port.');
}

parentPort.once('message', (message) => {
  const operation = message.operation === PROJECT_MIXDOWN_WORKER_OPERATION
    ? PROJECT_STEM_PRINT_WORKER_OPERATION
    : PROJECT_MIXDOWN_WORKER_OPERATION;

  parentPort.postMessage({
    error: {
      code: 'SHOULD_NOT_PROPAGATE',
      message: 'Wrong operation response.',
      name: 'Error',
    },
    ok: false,
    operation,
    protocolVersion: PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
    requestId: message.requestId,
  });
  parentPort.close();
});
