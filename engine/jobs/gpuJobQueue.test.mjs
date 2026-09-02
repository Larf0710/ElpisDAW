import { describe, expect, it } from 'vitest';

import { createDiagnosticLogger } from '../diagnosticLogger.mjs';
import { GpuJobQueue, GpuJobQueueError } from './gpuJobQueue.mjs';

describe('GpuJobQueue', () => {
  it('executes FIFO Jobs one at a time and records every phase', async () => {
    const executor = new ManualExecutor();
    const queue = createQueue(executor);
    const first = queue.enqueue(createRequest('first'));
    const second = queue.enqueue(createRequest('second'));

    await waitForState(queue, first.jobId, 'PROCESSING');
    expect(queue.getJob(second.jobId)?.state).toBe('QUEUED');
    expect(executor.maxConcurrent).toBe(1);

    executor.complete(first.jobId);
    await waitForState(queue, second.jobId, 'PROCESSING');
    expect(executor.starts).toEqual([first.jobId, second.jobId]);
    expect(executor.maxConcurrent).toBe(1);

    executor.complete(second.jobId);
    await queue.waitForIdle();

    expect(queue.getJob(first.jobId)?.state).toBe('COMPLETED');
    expect(queue.getJob(second.jobId)?.state).toBe('COMPLETED');
    expect(queue.getJob(first.jobId)?.history.map((entry) => entry.state)).toEqual([
      'QUEUED',
      'LOADING_MODEL',
      'PROCESSING',
      'SAVING',
      'COMPLETED',
    ]);
  });

  it('emits correlated lifecycle and trace diagnostics without request payloads', async () => {
    const entries = [];
    const logger = createDiagnosticLogger({
      level: 'trace',
      now: () => '2026-08-19T00:00:00.000Z',
      sink: (_line, entry) => entries.push(entry),
    });
    const executor = new ManualExecutor();
    const queue = createQueue(executor, { logger });
    const job = queue.enqueue(createRequest('private prompt text'));

    await waitForState(queue, job.jobId, 'PROCESSING');
    executor.complete(job.jobId);
    await queue.waitForIdle();

    expect(
      entries
        .filter((entry) => entry.event !== 'JOB_STATE_TRANSITION')
        .map((entry) => entry.event),
    ).toEqual([
      'JOB_ENQUEUED',
      'JOB_STARTED',
      'JOB_PROCESSING',
      'JOB_SAVING',
      'JOB_COMPLETED',
    ]);
    expect(entries.filter((entry) => entry.event === 'JOB_STATE_TRANSITION')).toHaveLength(4);
    expect(entries.every((entry) => entry.fields.jobId === job.jobId)).toBe(true);
    expect(
      entries
        .filter((entry) => entry.event !== 'JOB_STATE_TRANSITION')
        .map((entry) => entry.fields.phase),
    ).toEqual(['QUEUED', 'MODEL LOAD', 'GENERATION', 'OUTPUT SAVE', 'COMPLETE']);
    expect(JSON.stringify(entries)).not.toContain('private prompt text');
  });

  it('publishes safe provider progress to the Job record and Engine log', async () => {
    const entries = [];
    const logger = createDiagnosticLogger({
      level: 'trace',
      now: () => '2026-08-19T00:00:00.000Z',
      sink: (_line, entry) => entries.push(entry),
    });
    const executor = new ManualExecutor();
    const queue = createQueue(executor, { logger });
    const job = queue.enqueue(createRequest('private prompt text'));

    await waitForState(queue, job.jobId, 'PROCESSING');
    executor.reportProgress(job.jobId, {
      accuracy: 'MEASURED',
      currentStep: 4,
      percent: 50,
      totalSteps: 8,
    });

    expect(queue.getJob(job.jobId)).toMatchObject({
      progress: {
        accuracy: 'MEASURED',
        currentStep: 4,
        percent: 50,
        totalSteps: 8,
      },
      state: 'PROCESSING',
    });
    expect(entries.find((entry) => entry.event === 'JOB_PROGRESS')).toMatchObject({
      fields: {
        currentStep: 4,
        phase: 'GENERATION',
        progressAccuracy: 'MEASURED',
        progressPercent: 50,
        totalSteps: 8,
      },
    });
    expect(JSON.stringify(entries)).not.toContain('private prompt text');

    executor.complete(job.jobId);
    await queue.waitForIdle();
    expect(queue.getJob(job.jobId)).not.toHaveProperty('progress');
  });

  it('emits bounded active Job heartbeats and stops the timer after settlement', async () => {
    const entries = [];
    const logger = createDiagnosticLogger({
      level: 'trace',
      now: () => '2026-09-01T00:00:00.000Z',
      sink: (_line, entry) => entries.push(entry),
    });
    const executor = new ManualExecutor();
    const intervalHandle = Object.freeze({ unref() {} });
    let heartbeat;
    let clearedHandle;
    let nowMs = Date.parse('2026-09-01T00:00:00.000Z');
    const queue = createQueue(executor, {
      clearIntervalFn: (handle) => {
        clearedHandle = handle;
      },
      heartbeatIntervalMs: 30_000,
      logger,
      now: () => new Date(nowMs).toISOString(),
      setIntervalFn: (callback, intervalMs) => {
        expect(intervalMs).toBe(30_000);
        heartbeat = callback;
        return intervalHandle;
      },
    });
    const job = queue.enqueue(createRequest('private prompt text'));

    await waitForState(queue, job.jobId, 'PROCESSING');
    nowMs += 31_000;
    heartbeat();

    expect(entries.find((entry) => entry.event === 'JOB_HEARTBEAT')).toMatchObject({
      fields: {
        elapsedSeconds: 31,
        lastUpdateAgeSeconds: 31,
        phase: 'GENERATION',
        state: 'PROCESSING',
      },
    });
    expect(JSON.stringify(entries)).not.toContain('private prompt text');

    executor.reportProgress(job.jobId, {
      accuracy: 'ESTIMATED',
      percent: 50,
    });
    nowMs += 10_000;
    heartbeat();

    expect(entries.filter((entry) => entry.event === 'JOB_HEARTBEAT')[1]).toMatchObject({
      fields: {
        elapsedSeconds: 41,
        lastUpdateAgeSeconds: 10,
        progressAccuracy: 'ESTIMATED',
        progressPercent: 50,
      },
    });

    executor.complete(job.jobId);
    await queue.waitForIdle();
    expect(clearedHandle).toBe(intervalHandle);
  });

  it('removes waiting Jobs immediately without disturbing the active execution', async () => {
    const executor = new ManualExecutor();
    const queue = createQueue(executor);
    const active = queue.enqueue(createRequest('active'));
    const waiting = queue.enqueue(createRequest('waiting'));
    await waitForState(queue, active.jobId, 'PROCESSING');

    expect(queue.removeQueued(waiting.jobId)).toMatchObject({ state: 'QUEUED' });
    expect(queue.getJob(waiting.jobId)).toBeUndefined();
    expect(() => queue.removeQueued(active.jobId)).toThrow('QUEUED');

    executor.complete(active.jobId);
    await queue.waitForIdle();
    expect(executor.starts).toEqual([active.jobId]);
  });

  it('records CANCEL_REQUESTED and cancels an active Job without completing it', async () => {
    const executor = new ManualExecutor();
    const queue = createQueue(executor);
    const job = queue.enqueue(createRequest('cancel'));
    await waitForState(queue, job.jobId, 'PROCESSING');

    await expect(queue.requestCancel(job.jobId)).resolves.toMatchObject({
      state: 'CANCEL_REQUESTED',
    });
    await queue.waitForIdle();

    expect(executor.cancelCalls).toEqual([job.jobId]);
    expect(queue.getJob(job.jobId)?.state).toBe('CANCELED');
    expect(queue.getJob(job.jobId)?.history.map((entry) => entry.state)).toEqual([
      'QUEUED',
      'LOADING_MODEL',
      'PROCESSING',
      'CANCEL_REQUESTED',
      'CANCELED',
    ]);
  });

  it('records a cancellation cleanup failure as FAILED instead of fake CANCELED', async () => {
    const executor = new CancelFailingExecutor();
    const queue = createQueue(executor);
    const job = queue.enqueue(createRequest('cancel-cleanup-failure'));
    await waitForState(queue, job.jobId, 'PROCESSING');

    await expect(queue.requestCancel(job.jobId)).rejects.toMatchObject({
      code: 'CANCEL_CLEANUP_FAILED',
    });
    await queue.waitForIdle();

    expect(queue.getJob(job.jobId)).toMatchObject({
      error: {
        code: 'CANCEL_CLEANUP_FAILED',
        message: 'Cancellation cleanup failed.',
      },
      state: 'FAILED',
    });
  });

  it('retries a FAILED Job with the same immutable settings and a new attempt', async () => {
    const executor = new ManualExecutor();
    const queue = createQueue(executor);
    const job = queue.enqueue(createRequest('retry'));
    await waitForState(queue, job.jobId, 'PROCESSING');
    const originalRequest = queue.getJob(job.jobId)?.request;

    executor.fail(job.jobId, Object.assign(new Error('Mock OOM.'), { code: 'GPU_OOM' }));
    await queue.waitForIdle();
    expect(queue.getJob(job.jobId)).toMatchObject({
      attempt: 1,
      error: { code: 'GPU_OOM', message: 'Mock OOM.' },
      state: 'FAILED',
    });

    expect(queue.retry(job.jobId)).toMatchObject({ attempt: 2, state: 'QUEUED' });
    await waitForState(queue, job.jobId, 'PROCESSING');
    expect(queue.getJob(job.jobId)?.request).toBe(originalRequest);
    executor.complete(job.jobId);
    await queue.waitForIdle();
    expect(queue.getJob(job.jobId)).toMatchObject({ attempt: 2, state: 'COMPLETED' });
  });

  it('interrupts the active Job, pauses waiting Jobs, and never auto-resumes after shutdown', async () => {
    const executor = new ManualExecutor();
    const queue = createQueue(executor);
    const active = queue.enqueue(createRequest('active'));
    const waiting = queue.enqueue(createRequest('waiting'));
    await waitForState(queue, active.jobId, 'PROCESSING');

    await queue.shutdown();

    expect(queue.getSnapshot()).toMatchObject({ acceptingJobs: false });
    expect(queue.getJob(active.jobId)?.state).toBe('INTERRUPTED');
    expect(queue.getJob(waiting.jobId)?.state).toBe('PAUSED');
    expect(executor.shutdownCalls).toBe(1);
    expect(() => queue.resume(waiting.jobId)).toThrow('stopped');
    expect(queue.cancelStopped(waiting.jobId)).toMatchObject({ state: 'CANCELED' });
    expect(() => queue.enqueue(createRequest('late'))).toThrow('stopped');
  });

  it('protects the SAVING critical section from cancellation and completes it before shutdown', async () => {
    const executor = new ManualExecutor();
    const queue = createQueue(executor);
    const job = queue.enqueue(createRequest('saving'));
    await waitForState(queue, job.jobId, 'PROCESSING');
    executor.beginSaving(job.jobId);
    await waitForState(queue, job.jobId, 'SAVING');

    await expect(queue.requestCancel(job.jobId)).rejects.toMatchObject({
      code: 'JOB_CANCEL_TOO_LATE',
    });
    const shutdown = queue.shutdown();
    await Promise.resolve();
    expect(executor.shutdownCalls).toBe(0);

    executor.finish(job.jobId);
    await shutdown;
    expect(queue.getJob(job.jobId)?.state).toBe('COMPLETED');
    expect(executor.shutdownCalls).toBe(1);
  });

  it('rejects invalid executor phase order as a failed Job', async () => {
    const executor = new ManualExecutor();
    const queue = createQueue(executor);
    const job = queue.enqueue(createRequest('bad-phase'));
    await waitForState(queue, job.jobId, 'PROCESSING');

    executor.reportPhase(job.jobId, 'PROCESSING');
    await queue.waitForIdle();

    expect(queue.getJob(job.jobId)).toMatchObject({
      error: { code: 'EXECUTOR_PHASE_INVALID' },
      state: 'FAILED',
    });
  });

  it('validates constructor and unknown Job operations explicitly', () => {
    expect(() => new GpuJobQueue({ executor: {} })).toThrow('requires an executor');
    const queue = createQueue(new ManualExecutor());
    expect(() => queue.removeQueued('job-missing')).toThrow(GpuJobQueueError);
  });
});

class ManualExecutor {
  cancelCalls = [];
  concurrent = 0;
  controls = new Map();
  maxConcurrent = 0;
  shutdownCalls = 0;
  starts = [];

  validateRequest(request) {
    return request;
  }

  run(_request, { jobId, onPhase, onProgress, signal }) {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    this.starts.push(jobId);
    onPhase('PROCESSING');

    return new Promise((resolve, reject) => {
      const control = {
        onPhase,
        onProgress,
        reject,
        resolve,
        saving: false,
      };
      const handleAbort = () => {
        const error = Object.assign(new Error('Execution aborted.'), { code: 'JOB_ABORTED' });
        reject(error);
      };
      signal.addEventListener('abort', handleAbort, { once: true });
      control.cleanup = () => signal.removeEventListener('abort', handleAbort);
      this.controls.set(jobId, control);
    }).finally(() => {
      this.controls.get(jobId)?.cleanup();
      this.controls.delete(jobId);
      this.concurrent -= 1;
    });
  }

  beginSaving(jobId) {
    const control = this.#requireControl(jobId);
    control.onPhase('SAVING');
    control.saving = true;
  }

  finish(jobId) {
    const control = this.#requireControl(jobId);
    control.resolve({ artifactId: `artifact-${jobId}` });
  }

  complete(jobId) {
    const control = this.#requireControl(jobId);

    if (!control.saving) {
      this.beginSaving(jobId);
    }

    this.finish(jobId);
  }

  fail(jobId, error) {
    this.#requireControl(jobId).reject(error);
  }

  reportPhase(jobId, phase) {
    const control = this.#requireControl(jobId);

    try {
      control.onPhase(phase);
    } catch (error) {
      control.reject(error);
    }
  }

  reportProgress(jobId, progress) {
    this.#requireControl(jobId).onProgress(progress);
  }

  async cancel(jobId) {
    this.cancelCalls.push(jobId);
  }

  async shutdown() {
    this.shutdownCalls += 1;
  }

  #requireControl(jobId) {
    const control = this.controls.get(jobId);

    if (!control) {
      throw new Error(`Missing ManualExecutor control for ${jobId}.`);
    }

    return control;
  }
}

class CancelFailingExecutor extends ManualExecutor {
  async cancel(jobId) {
    await super.cancel(jobId);
    throw Object.assign(new Error('Cancellation cleanup failed.'), {
      code: 'CANCEL_CLEANUP_FAILED',
    });
  }
}

function createQueue(executor, options = {}) {
  let id = 0;
  let timestamp = Date.parse('2026-07-23T00:00:00.000Z');

  return new GpuJobQueue({
    createJobId: () => `job-test-${++id}`,
    executor,
    now: () => new Date(timestamp++).toISOString(),
    ...options,
  });
}

function createRequest(label) {
  return {
    label,
    modelId: 'mock-audio-v1',
    modelRevision: '1',
    parameters: { seed: 7 },
    providerId: 'mock-provider',
    taskId: 'mock-audio-generation',
  };
}

async function waitForState(queue, jobId, expectedState) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (queue.getJob(jobId)?.state === expectedState) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${jobId} to reach ${expectedState}; current=${queue.getJob(jobId)?.state}.`,
  );
}
