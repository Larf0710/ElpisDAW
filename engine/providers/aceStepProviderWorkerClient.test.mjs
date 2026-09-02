import { afterEach, describe, expect, it } from 'vitest';

import {
  ACE_STEP_MODEL_ID,
  ACE_STEP_PROVIDER_ID,
} from './aceStepProviderDefinition.mjs';
import {
  resolveAceStepCheckpointsRootPath,
  resolveAceStepPythonPath,
  AceStepPythonHostClient,
} from './aceStepPythonHostClient.mjs';
import {
  createAceStepProviderWorkerClient,
  ACE_STEP_PROVIDER_WORKER_PATH,
} from './aceStepProviderWorkerClient.mjs';

const clients = new Set();

afterEach(async () => {
  await Promise.allSettled([...clients].map((client) => client.terminate()));
  clients.clear();
});

describe('ACE-Step Provider Worker boundary', () => {
  it('inspects the isolated compatible Node Worker without starting Python', async () => {
    const client = trackClient(
      createAceStepProviderWorkerClient({ requestTimeoutMs: 5_000 }),
    );

    await expect(client.start()).resolves.toMatchObject({
      models: [{ compatibility: 'COMPATIBLE', modelId: ACE_STEP_MODEL_ID }],
      providerId: ACE_STEP_PROVIDER_ID,
      runtime: { compatibility: 'COMPATIBLE' },
    });
    expect(client.isRunning()).toBe(true);
    expect(ACE_STEP_PROVIDER_WORKER_PATH).toMatch(/aceStepProviderWorker\.mjs$/);
    await client.terminate();
    expect(client.isRunning()).toBe(false);
  });

  it('fails closed before spawning Python when Runtime paths are not configured', async () => {
    const hostClient = new AceStepPythonHostClient({
      environment: {},
      requestTimeoutMs: 1_000,
    });

    await expect(hostClient.start()).rejects.toMatchObject({
      code: 'ACE_STEP_RUNTIME_UNAVAILABLE',
      message:
        'HUMSTUDIO_ACE_STEP_PYTHON must be configured before ACE-Step execution.',
    });
    expect(hostClient.isRunning()).toBe(false);
  });

  it('requires absolute configured Python and Checkpoints Root paths', () => {
    expect(() => resolveAceStepPythonPath({})).toThrow('HUMSTUDIO_ACE_STEP_PYTHON');
    expect(() =>
      resolveAceStepCheckpointsRootPath({
        HUMSTUDIO_ACE_STEP_CHECKPOINTS_ROOT: 'relative-checkpoints',
      }),
    ).toThrow('HUMSTUDIO_ACE_STEP_CHECKPOINTS_ROOT');
  });
});

function trackClient(client) {
  clients.add(client);
  return client;
}
