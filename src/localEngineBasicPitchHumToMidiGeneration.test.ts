import { describe, expect, it, vi } from 'vitest';

import {
  runLocalEngineBasicPitchHumToMidiGeneration,
  type LocalEngineBasicPitchHumToMidiClient,
} from './localEngineHumToMidiGeneration';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import {
  cloneBasicPitchTestValue,
  createBasicPitchHumToMidiTestProject,
  createCompletedBasicPitchHumToMidiTestJob,
  requireBasicPitchHumToMidiTestPlan,
} from './basicPitchHumToMidiTestFixture';

describe('runLocalEngineBasicPitchHumToMidiGeneration', () => {
  it('uses only the production Basic Pitch enqueue and reports exact Job progress', async () => {
    const request = requireBasicPitchHumToMidiTestPlan(
      createBasicPitchHumToMidiTestProject(),
    ).request;
    const jobs = [
      createJob(request, 'QUEUED'),
      createJob(request, 'LOADING_MODEL'),
      createJob(request, 'PROCESSING'),
      createJob(request, 'SAVING'),
      createJob(request, 'COMPLETED'),
    ];
    const progress = vi.fn();
    const client = createClient(jobs[0], jobs.slice(1));

    const result = await runLocalEngineBasicPitchHumToMidiGeneration(
      client,
      request,
      { onProgress: progress, wait: async () => undefined },
    );

    expect(result).toEqual({ job: jobs[4], ok: true });
    expect(client.enqueueBasicPitchHumToMidiJob).toHaveBeenCalledOnce();
    expect(client.enqueueBasicPitchHumToMidiJob).toHaveBeenCalledWith(request);
    expect(
      progress.mock.calls.map(([value]) => value.state),
    ).toEqual([
      'ENQUEUEING',
      'QUEUED',
      'LOADING_MODEL',
      'PROCESSING',
      'SAVING',
      'COMPLETED',
    ]);
    expect(JSON.stringify(request)).not.toContain('mock-provider');
  });

  it('removes only the exact queued Job when canceled', async () => {
    const request = requireBasicPitchHumToMidiTestPlan(
      createBasicPitchHumToMidiTestProject(),
    ).request;
    const queued = createJob(request, 'QUEUED');
    const controller = new AbortController();
    const client = createClient(queued, [queued]);
    client.removeQueuedJob.mockResolvedValue({ ok: true, removedJob: queued });

    const result = await runLocalEngineBasicPitchHumToMidiGeneration(
      client,
      request,
      {
        signal: controller.signal,
        wait: async () => controller.abort(),
      },
    );

    expect(result).toMatchObject({
      jobId: queued.jobId,
      ok: false,
      reason: 'canceled',
      retryable: false,
    });
    expect(client.removeQueuedJob).toHaveBeenCalledOnce();
    expect(client.removeQueuedJob).toHaveBeenCalledWith(queued.jobId);
  });

  it('waits when cancellation becomes too late and never removes an active Job', async () => {
    const request = requireBasicPitchHumToMidiTestPlan(
      createBasicPitchHumToMidiTestProject(),
    ).request;
    const processing = createJob(request, 'PROCESSING');
    const completed = createJob(request, 'COMPLETED');
    const controller = new AbortController();
    const client = createClient(processing, [completed]);

    const result = await runLocalEngineBasicPitchHumToMidiGeneration(
      client,
      request,
      {
        signal: controller.signal,
        wait: async () => controller.abort(),
      },
    );

    expect(result).toEqual({ job: completed, ok: true });
    expect(client.removeQueuedJob).not.toHaveBeenCalled();
  });

  it('retries only the exact failed Job with the unchanged request and same Job id', async () => {
    const request = requireBasicPitchHumToMidiTestPlan(
      createBasicPitchHumToMidiTestProject(),
    ).request;
    const failed = createJob(request, 'FAILED');
    const queued = createJob(request, 'QUEUED', { attempt: 2 });
    const completed = createJob(request, 'COMPLETED', { attempt: 2 });
    const client = createClient(queued, [failed, completed]);
    client.retryJob.mockResolvedValue({ job: queued, ok: true });

    const result = await runLocalEngineBasicPitchHumToMidiGeneration(
      client,
      request,
      {
        retryJobId: failed.jobId,
        wait: async () => undefined,
      },
    );

    expect(result).toEqual({ job: completed, ok: true });
    expect(client.enqueueBasicPitchHumToMidiJob).not.toHaveBeenCalled();
    expect(client.retryJob).toHaveBeenCalledWith(failed.jobId);

    const changedRequest = {
      ...cloneBasicPitchTestValue(request),
      parameters: {
        ...request.parameters,
        onsetThreshold: request.parameters.onsetThreshold + 0.01,
      },
    };
    const conflictClient = createClient(queued, [failed]);
    const conflict = await runLocalEngineBasicPitchHumToMidiGeneration(
      conflictClient,
      changedRequest,
      { retryJobId: failed.jobId },
    );
    expect(conflict).toMatchObject({ ok: false, retryable: false });
    expect(conflictClient.retryJob).not.toHaveBeenCalled();
  });

  it.each(['CANCELED', 'FAILED', 'INTERRUPTED', 'PAUSED'] as const)(
    'classifies terminal %s without fabricating success',
    async (state) => {
      const request = requireBasicPitchHumToMidiTestPlan(
        createBasicPitchHumToMidiTestProject(),
      ).request;
      const terminal = createJob(request, state);
      const result = await runLocalEngineBasicPitchHumToMidiGeneration(
        createClient(terminal, []),
        request,
      );

      expect(result).toMatchObject({
        job: terminal,
        ok: false,
        reason: state === 'CANCELED' ? 'canceled' : 'engine-job-failed',
        retryable: state === 'FAILED',
      });
    },
  );

  it('fails closed for pre-dispatch abort, snapshot failure, disappearance, timeout, and identity drift', async () => {
    const request = requireBasicPitchHumToMidiTestPlan(
      createBasicPitchHumToMidiTestProject(),
    ).request;
    const queued = createJob(request, 'QUEUED');
    const aborted = new AbortController();
    aborted.abort();
    const preDispatchClient = createClient(queued, []);
    expect(
      await runLocalEngineBasicPitchHumToMidiGeneration(
        preDispatchClient,
        request,
        { signal: aborted.signal },
      ),
    ).toMatchObject({ ok: false, reason: 'canceled' });
    expect(preDispatchClient.enqueueBasicPitchHumToMidiJob).not.toHaveBeenCalled();

    const snapshotFailure = createClient(queued, []);
    snapshotFailure.getJobs.mockResolvedValue({
      message: 'sensitive engine detail',
      ok: false,
      reason: 'offline',
    });
    expect(
      await runLocalEngineBasicPitchHumToMidiGeneration(
        snapshotFailure,
        request,
        { wait: async () => undefined },
      ),
    ).toMatchObject({
      message: 'Local Engine Job state could not be read.',
      ok: false,
    });

    const disappeared = createClient(queued, []);
    disappeared.getJobs.mockResolvedValue({
      ok: true,
      snapshot: { acceptingJobs: true, jobs: [] },
    });
    expect(
      await runLocalEngineBasicPitchHumToMidiGeneration(
        disappeared,
        request,
        { wait: async () => undefined },
      ),
    ).toMatchObject({ message: expect.stringContaining('exact'), ok: false });

    expect(
      await runLocalEngineBasicPitchHumToMidiGeneration(
        createClient(queued, [queued]),
        request,
        { maxPollAttempts: 1, wait: async () => undefined },
      ),
    ).toMatchObject({ message: expect.stringContaining('timeout'), ok: false });

    const drifted = {
      ...createJob(request, 'PROCESSING'),
      providerId: 'mock-provider',
    };
    expect(
      await runLocalEngineBasicPitchHumToMidiGeneration(
        createClient(drifted, []),
        request,
      ),
    ).toMatchObject({ message: expect.stringContaining('did not match'), ok: false });
  });
});

function createClient(
  enqueueJob: LocalEngineGpuJobRecord,
  snapshots: LocalEngineGpuJobRecord[],
) {
  const getJobs = vi.fn();
  for (const job of snapshots) {
    getJobs.mockResolvedValueOnce({
      ok: true,
      snapshot: { acceptingJobs: true, jobs: [job] },
    });
  }

  return {
    enqueueBasicPitchHumToMidiJob: vi.fn(async () => ({
      job: enqueueJob,
      ok: true as const,
    })),
    getJobs,
    removeQueuedJob: vi.fn(async () => ({
      ok: true as const,
      removedJob: enqueueJob,
    })),
    retryJob: vi.fn(async () => ({ job: enqueueJob, ok: true as const })),
  } satisfies LocalEngineBasicPitchHumToMidiClient;
}

function createJob(
  request: ReturnType<typeof requireBasicPitchHumToMidiTestPlan>['request'],
  state: LocalEngineGpuJobRecord['state'],
  additions: Partial<LocalEngineGpuJobRecord> = {},
): LocalEngineGpuJobRecord {
  const completed = createCompletedBasicPitchHumToMidiTestJob(
    { ...requireBasicPitchHumToMidiTestPlan(createBasicPitchHumToMidiTestProject()), request },
  );
  const createdAt = completed.createdAt;
  const updatedAt = state === 'QUEUED' ? createdAt : completed.updatedAt;

  return {
    ...completed,
    ...(state !== 'COMPLETED' ? { result: undefined } : {}),
    ...(state === 'QUEUED' ? { finishedAt: undefined, startedAt: undefined } : {}),
    history: [{ attempt: 1, at: updatedAt, state }],
    request,
    state,
    updatedAt,
    ...additions,
  };
}
