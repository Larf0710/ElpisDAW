import { afterEach, describe, expect, it } from 'vitest';

import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
} from '../../shared/stableAudio3Protocol.js';
import {
  resolveStableAudio3ModelRootPath,
  resolveStableAudio3PythonPath,
  StableAudio3PythonHostClient,
} from './stableAudio3PythonHostClient.mjs';
import {
  createStableAudio3ProviderWorkerClient,
  STABLE_AUDIO_3_PROVIDER_WORKER_PATH,
} from './stableAudio3ProviderWorkerClient.mjs';

const clients = new Set();

afterEach(async () => {
  await Promise.allSettled([...clients].map((client) => client.terminate()));
  clients.clear();
});

describe('Stable Audio 3 Provider Worker boundary', () => {
  it('inspects the isolated Node Worker without starting Python or loading weights', async () => {
    const client = trackClient(
      createStableAudio3ProviderWorkerClient({ requestTimeoutMs: 5_000 }),
    );

    await expect(client.start()).resolves.toMatchObject({
      models: [
        expect.objectContaining({
          modelId: STABLE_AUDIO_3_MODEL_ID,
          revision: STABLE_AUDIO_3_MODEL_REVISION,
        }),
      ],
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
    });
    expect(client.isRunning()).toBe(true);
    expect(STABLE_AUDIO_3_PROVIDER_WORKER_PATH).toMatch(
      /stableAudio3ProviderWorker\.mjs$/,
    );
    await client.terminate();
    expect(client.isRunning()).toBe(false);
  });

  it('fails closed before spawning Python when runtime paths are not configured', async () => {
    const hostClient = new StableAudio3PythonHostClient({
      environment: {},
      requestTimeoutMs: 1_000,
    });

    await expect(hostClient.start()).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_RUNTIME_UNAVAILABLE',
      message:
        'HUMSTUDIO_STABLE_AUDIO_3_PYTHON must be configured before Stable Audio 3 execution.',
    });
    expect(hostClient.isRunning()).toBe(false);
  });

  it('requires absolute configured Python and fixed-revision Model Root paths', () => {
    expect(() => resolveStableAudio3PythonPath({})).toThrow(
      'HUMSTUDIO_STABLE_AUDIO_3_PYTHON',
    );
    expect(() =>
      resolveStableAudio3ModelRootPath({
        HUMSTUDIO_STABLE_AUDIO_3_MODEL_ROOT: 'relative-model-root',
      }),
    ).toThrow('HUMSTUDIO_STABLE_AUDIO_3_MODEL_ROOT');
  });
});

function trackClient(client) {
  clients.add(client);
  return client;
}
