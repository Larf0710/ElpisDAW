import { describe, expect, it, vi } from 'vitest';

import {
  BASIC_PITCH_MODEL_ID,
  BASIC_PITCH_MODEL_REVISION,
} from './basicPitchProviderDefinition.mjs';
import { BasicPitchRuntimeInspector } from './basicPitchRuntimeInspector.mjs';
import {
  BASIC_PITCH_PROVIDER_VERSION,
  BASIC_PITCH_RUNTIME_PROFILE_ID,
} from './basicPitchRuntimeProfile.mjs';

describe('BasicPitchRuntimeInspector', () => {
  it('reports READY only after the pinned model loads and the worker closes cleanly', async () => {
    const worker = createWorkerClient();
    const inspector = new BasicPitchRuntimeInspector({
      createWorkerClient: () => worker,
    });

    await expect(inspector.inspect()).resolves.toEqual({
      modelId: BASIC_PITCH_MODEL_ID,
      modelRevision: BASIC_PITCH_MODEL_REVISION,
      profileId: BASIC_PITCH_RUNTIME_PROFILE_ID,
      providerVersion: BASIC_PITCH_PROVIDER_VERSION,
      status: 'READY',
    });
    expect(worker.start).toHaveBeenCalledOnce();
    expect(worker.loadModel).toHaveBeenCalledWith(
      BASIC_PITCH_MODEL_ID,
      BASIC_PITCH_MODEL_REVISION,
    );
    expect(worker.unloadModel).toHaveBeenCalledOnce();
    expect(worker.close).toHaveBeenCalledOnce();
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('caches an unavailable result, terminates the worker, and hides provider details', async () => {
    const worker = createWorkerClient({
      loadModel: vi.fn(async () => {
        throw Object.assign(new Error('C:\\Users\\secret\\python.exe TOKEN=secret'), {
          code: 'BASIC_PITCH_RUNTIME_INVALID',
        });
      }),
    });
    const workerFactory = vi.fn(() => worker);
    const inspector = new BasicPitchRuntimeInspector({
      createWorkerClient: workerFactory,
    });

    const first = await inspector.inspect();
    const second = await inspector.inspect();

    expect(first).toEqual({
      code: 'BASIC_PITCH_RUNTIME_INVALID',
      message:
        'Basic Pitch Runtime is unavailable. Install or repair the pinned Runtime, then restart Local Engine.',
      status: 'UNAVAILABLE',
    });
    expect(second).toBe(first);
    expect(workerFactory).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(first.message).not.toContain('Users');
    expect(first.message).not.toContain('TOKEN');
  });
});

function createWorkerClient(overrides = {}) {
  return {
    close: vi.fn(async () => undefined),
    loadModel: vi.fn(async () => ({ status: 'LOADED' })),
    start: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    unloadModel: vi.fn(async () => undefined),
    ...overrides,
  };
}
