import { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import {
  PROJECT_MIXDOWN_WORKER_OPERATION,
  PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
  PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION_V2,
  PROJECT_RENDER_WORKER_UNKNOWN_OPERATION,
  PROJECT_STEM_PRINT_WORKER_OPERATION,
} from './projectMixdownWorkerProtocol.mjs';

const WORKER_URL = new URL('./projectMixdownWorker.mjs', import.meta.url);

describe('Project render Worker request protocol', () => {
  it('retains the legacy v2 constant and rejects an old protocol version', async () => {
    expect(PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION_V2).toBe('2');
    expect(PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION).toBe('3');

    const response = await send({
      operation: PROJECT_STEM_PRINT_WORKER_OPERATION,
      plan: {},
      protocolVersion: PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION_V2,
      requestId: 'old-protocol',
      sourceEntries: [],
    });

    expect(response).toEqual({
      error: {
        code: 'MIXDOWN_WORKER_REQUEST_INVALID',
        message: 'Project Mixdown Worker request identity is invalid.',
        name: 'Error',
      },
      ok: false,
      operation: PROJECT_STEM_PRINT_WORKER_OPERATION,
      protocolVersion: PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
      requestId: 'unknown-request',
    });
  });

  it('rejects an unsupported operation without reflecting it', async () => {
    const response = await send({
      operation: 'render-secret-operation',
      plan: {},
      protocolVersion: PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
      requestId: 'unsupported-operation',
      sourceEntries: [],
    });

    expect(response.operation).toBe(PROJECT_RENDER_WORKER_UNKNOWN_OPERATION);
    expect(response.error).toMatchObject({
      code: 'MIXDOWN_WORKER_REQUEST_INVALID',
    });
    expect(JSON.stringify(response)).not.toContain('render-secret-operation');
  });

  it.each([
    PROJECT_MIXDOWN_WORKER_OPERATION,
    PROJECT_STEM_PRINT_WORKER_OPERATION,
  ])('rejects duplicate source byte entries for %s', async (operation) => {
    const first = Uint8Array.from([1]);
    const second = Uint8Array.from([2]);
    const response = await send({
      operation,
      plan: {},
      protocolVersion: PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
      requestId: `duplicate-${operation}`,
      sourceEntries: [
        { bytes: first, sourceId: 'source-1' },
        { bytes: second, sourceId: 'source-1' },
      ],
    });

    expect(response).toMatchObject({
      error: { code: 'MIXDOWN_WORKER_REQUEST_INVALID' },
      ok: false,
      operation,
      requestId: `duplicate-${operation}`,
    });
  });
});

function send(message) {
  const worker = new Worker(WORKER_URL, { type: 'module' });

  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', resolve);
    worker.postMessage(message);
  }).finally(async () => {
    if (worker.threadId !== -1) {
      await worker.terminate();
    }
  });
}
