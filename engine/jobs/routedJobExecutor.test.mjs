import { describe, expect, it, vi } from 'vitest';

import {
  RoutedJobExecutor,
  RoutedJobExecutorError,
} from './routedJobExecutor.mjs';

describe('RoutedJobExecutor', () => {
  it('validates and runs through the single matching Provider executor', async () => {
    const mock = createExecutor('mock-provider');
    const fluidSynth = createExecutor('local-fluidsynth');
    const routed = new RoutedJobExecutor({ executors: [mock, fluidSynth] });
    const request = { providerId: 'local-fluidsynth', taskId: 'midi-to-audio' };
    const normalized = routed.validateRequest(request);

    await expect(
      routed.run(normalized, {
        jobId: 'job-render',
        onPhase: () => undefined,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ providerId: 'local-fluidsynth' });
    expect(mock.run).not.toHaveBeenCalled();
    expect(fluidSynth.validateRequest).toHaveBeenCalledWith(request);
    expect(fluidSynth.run).toHaveBeenCalledWith(
      normalized,
      expect.objectContaining({ jobId: 'job-render' }),
    );
  });

  it('rejects unsupported and ambiguous Provider routes', () => {
    const routed = new RoutedJobExecutor({
      executors: [
        createExecutor('mock-provider'),
        createExecutor('local-fluidsynth'),
      ],
    });

    expect(() =>
      routed.validateRequest({ providerId: 'unknown-provider' }),
    ).toThrow(RoutedJobExecutorError);

    const ambiguous = new RoutedJobExecutor({
      executors: [
        createExecutor('local-fluidsynth'),
        createExecutor('local-fluidsynth'),
      ],
    });

    expect(() =>
      ambiguous.validateRequest({ providerId: 'local-fluidsynth' }),
    ).toThrow('more than one executor');
  });
});

function createExecutor(providerId) {
  return {
    canHandleRequest: vi.fn((request) => request?.providerId === providerId),
    cancel: vi.fn(async () => undefined),
    run: vi.fn(async () => ({ providerId })),
    shutdown: vi.fn(async () => undefined),
    validateRequest: vi.fn((request) => Object.freeze({ ...request })),
  };
}
