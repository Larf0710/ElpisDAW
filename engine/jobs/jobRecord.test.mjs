import { describe, expect, it } from 'vitest';

import {
  JobRecordValidationError,
  createQueuedJobRecord,
  transitionJobRecord,
  updateJobProgress,
} from './jobRecord.mjs';

describe('JobRecord', () => {
  it('records an immutable successful state history', () => {
    const queued = createQueuedJobRecord({
      jobId: 'job-history-a',
      request: createRequest(),
      timestamp: '2026-07-23T00:00:00.000Z',
    });
    const loading = transitionJobRecord(queued, 'LOADING_MODEL', {
      timestamp: '2026-07-23T00:00:01.000Z',
    });
    const processing = transitionJobRecord(loading, 'PROCESSING', {
      timestamp: '2026-07-23T00:00:02.000Z',
    });
    const saving = transitionJobRecord(processing, 'SAVING', {
      timestamp: '2026-07-23T00:00:03.000Z',
    });
    const completed = transitionJobRecord(saving, 'COMPLETED', {
      result: { artifactId: 'artifact-mock-a' },
      timestamp: '2026-07-23T00:00:04.000Z',
    });

    expect(completed).toMatchObject({
      attempt: 1,
      finishedAt: '2026-07-23T00:00:04.000Z',
      result: { artifactId: 'artifact-mock-a' },
      startedAt: '2026-07-23T00:00:01.000Z',
      state: 'COMPLETED',
    });
    expect(completed.history.map((entry) => entry.state)).toEqual([
      'QUEUED',
      'LOADING_MODEL',
      'PROCESSING',
      'SAVING',
      'COMPLETED',
    ]);
    expect(Object.isFrozen(completed)).toBe(true);
    expect(Object.isFrozen(completed.history)).toBe(true);
    expect(Object.isFrozen(completed.request)).toBe(true);
    expect(Object.isFrozen(completed.result)).toBe(true);
  });

  it('rejects illegal transitions and missing failure details', () => {
    const queued = createQueuedJobRecord({ jobId: 'job-invalid-a', request: createRequest() });
    const loading = transitionJobRecord(queued, 'LOADING_MODEL');

    expect(() => transitionJobRecord(queued, 'COMPLETED', { result: {} })).toThrow(
      'cannot transition',
    );
    expect(() => transitionJobRecord(loading, 'FAILED')).toThrow('requires an error');
    expect(() => transitionJobRecord(queued, 'UNKNOWN')).toThrow(JobRecordValidationError);
    expect(() =>
      transitionJobRecord(loading, 'PROCESSING', {
        timestamp: '2020-01-01T00:00:00.000Z',
      }),
    ).toThrow('cannot move backward');
  });

  it('retries failed or interrupted attempts while paused Jobs resume the same attempt', () => {
    const failed = transitionJobRecord(
      transitionJobRecord(
        createQueuedJobRecord({ jobId: 'job-retry-a', request: createRequest() }),
        'LOADING_MODEL',
      ),
      'FAILED',
      { error: Object.assign(new Error('Provider failed.'), { code: 'PROVIDER_FAILED' }) },
    );
    const retried = transitionJobRecord(failed, 'QUEUED', { incrementAttempt: true });
    const paused = transitionJobRecord(
      createQueuedJobRecord({ jobId: 'job-paused-a', request: createRequest() }),
      'PAUSED',
    );
    const resumedPaused = transitionJobRecord(paused, 'QUEUED');
    const interrupted = transitionJobRecord(
      transitionJobRecord(
        createQueuedJobRecord({ jobId: 'job-interrupted-a', request: createRequest() }),
        'LOADING_MODEL',
      ),
      'INTERRUPTED',
    );
    const resumedInterrupted = transitionJobRecord(interrupted, 'QUEUED', {
      incrementAttempt: true,
    });

    expect(failed.error).toEqual({ code: 'PROVIDER_FAILED', message: 'Provider failed.' });
    expect(retried).toMatchObject({ attempt: 2, state: 'QUEUED' });
    expect(retried).not.toHaveProperty('error');
    expect(resumedPaused).toMatchObject({ attempt: 1, state: 'QUEUED' });
    expect(resumedInterrupted).toMatchObject({ attempt: 2, state: 'QUEUED' });
  });

  it('rejects cyclic or non-finite Job request data', () => {
    const cyclic = createRequest();
    cyclic.self = cyclic;

    expect(() =>
      createQueuedJobRecord({ jobId: 'job-cyclic-a', request: cyclic }),
    ).toThrow('cycle');
    expect(() =>
      createQueuedJobRecord({
        jobId: 'job-infinite-a',
        request: { ...createRequest(), strength: Number.POSITIVE_INFINITY },
      }),
    ).toThrow('non-finite');
  });

  it('records monotonic PROCESSING progress without rewriting state history', () => {
    const processing = transitionJobRecord(
      transitionJobRecord(
        createQueuedJobRecord({
          jobId: 'job-progress-a',
          request: createRequest(),
          timestamp: '2026-07-23T00:00:00.000Z',
        }),
        'LOADING_MODEL',
        { timestamp: '2026-07-23T00:00:01.000Z' },
      ),
      'PROCESSING',
      { timestamp: '2026-07-23T00:00:02.000Z' },
    );
    const progressed = updateJobProgress(
      processing,
      { accuracy: 'MEASURED', currentStep: 4, percent: 50, totalSteps: 8 },
      '2026-07-23T00:00:03.000Z',
    );

    expect(progressed).toMatchObject({
      progress: {
        accuracy: 'MEASURED',
        currentStep: 4,
        percent: 50,
        totalSteps: 8,
        updatedAt: '2026-07-23T00:00:03.000Z',
      },
      state: 'PROCESSING',
      updatedAt: '2026-07-23T00:00:02.000Z',
    });
    expect(progressed.history).toBe(processing.history);
    expect(Object.isFrozen(progressed.progress)).toBe(true);
    expect(() =>
      updateJobProgress(
        progressed,
        { accuracy: 'MEASURED', currentStep: 3, percent: 38, totalSteps: 8 },
        '2026-07-23T00:00:04.000Z',
      ),
    ).toThrow('cannot move backward');
    expect(
      transitionJobRecord(progressed, 'SAVING', {
        timestamp: '2026-07-23T00:00:04.000Z',
      }),
    ).not.toHaveProperty('progress');
  });
});

function createRequest() {
  return {
    modelId: 'mock-audio-v1',
    modelRevision: '1',
    parameters: { seed: 7 },
    providerId: 'mock-provider',
    taskId: 'mock-audio-generation',
  };
}
