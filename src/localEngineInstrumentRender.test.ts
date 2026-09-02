import { describe, expect, it, vi } from 'vitest';

import type {
  LocalEngineGpuJobRecord,
  LocalEngineInstrumentRenderJobRequest,
} from './localEngineClient';
import { runLocalEngineInstrumentRender } from './localEngineInstrumentRender';

describe('runLocalEngineInstrumentRender', () => {
  it('enqueues, reports state changes, and returns the completed Job', async () => {
    const queued = createJob('QUEUED');
    const processing = createJob('PROCESSING');
    const completed = createJob('COMPLETED');
    const states: string[] = [];
    const client = {
      enqueueInstrumentRenderJob: vi.fn(async () => ({ job: queued, ok: true as const })),
      getJobs: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          snapshot: { acceptingJobs: true, jobs: [processing] },
        })
        .mockResolvedValueOnce({
          ok: true,
          snapshot: { acceptingJobs: true, jobs: [completed] },
        }),
    };

    await expect(
      runLocalEngineInstrumentRender(client, {} as LocalEngineInstrumentRenderJobRequest, {
        onProgress: ({ state }) => states.push(state),
        wait: async () => undefined,
      }),
    ).resolves.toEqual({ job: completed, ok: true });
    expect(states).toEqual(['ENQUEUEING', 'PROCESSING', 'COMPLETED']);
  });

  it('returns the stable Engine error when rendering fails', async () => {
    const queued = createJob('QUEUED');
    const failed = {
      ...createJob('FAILED'),
      error: { code: 'SOUNDFONT_OFFLINE', message: 'SoundFont is offline.' },
    };

    await expect(
      runLocalEngineInstrumentRender(
        {
          enqueueInstrumentRenderJob: async () => ({ job: queued, ok: true }),
          getJobs: async () => ({
            ok: true,
            snapshot: { acceptingJobs: true, jobs: [failed] },
          }),
        },
        {} as LocalEngineInstrumentRenderJobRequest,
        { wait: async () => undefined },
      ),
    ).resolves.toEqual({
      jobId: 'job-instrument-render',
      message: 'SoundFont is offline.',
      ok: false,
      reason: 'engine-job-failed',
    });
  });

  it('removes a waiting queued Job when an enqueued Job is aborted', async () => {
    const controller = new AbortController();
    const queued = createJob('QUEUED');
    const cancelJob = vi.fn();
    const removeQueuedJob = vi.fn(async () => ({
      ok: true as const,
      removedJob: queued,
    }));
    const enqueueInstrumentRenderJob = vi.fn(async () => {
      controller.abort();
      return { job: queued, ok: true as const };
    });
    const getJobs = vi.fn(async () => ({
      ok: true as const,
      snapshot: { acceptingJobs: true, jobs: [queued] },
    }));

    await expect(
      runLocalEngineInstrumentRender(
        {
          cancelJob,
          enqueueInstrumentRenderJob,
          getJobs,
          removeQueuedJob,
        },
        {} as LocalEngineInstrumentRenderJobRequest,
        { signal: controller.signal, wait: async () => undefined },
      ),
    ).resolves.toEqual({
      jobId: 'job-instrument-render',
      message:
        'MIDI TO AUDIO Job job-instrument-render was canceled.',
      ok: false,
      reason: 'canceled',
    });
    expect(removeQueuedJob).toHaveBeenCalledWith('job-instrument-render');
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it('requests cancellation for an active Job when aborted', async () => {
    const controller = new AbortController();
    const queued = createJob('QUEUED');
    const processing = createJob('PROCESSING');
    const cancelJob = vi.fn(async () => ({
      job: createJob('CANCEL_REQUESTED'),
      ok: true as const,
    }));

    const result = await runLocalEngineInstrumentRender(
      {
        cancelJob,
        enqueueInstrumentRenderJob: async () => {
          controller.abort();
          return { job: queued, ok: true };
        },
        getJobs: async () => ({
          ok: true,
          snapshot: { acceptingJobs: true, jobs: [processing] },
        }),
      },
      {} as LocalEngineInstrumentRenderJobRequest,
      { signal: controller.signal, wait: async () => undefined },
    );

    expect(result).toMatchObject({
      jobId: 'job-instrument-render',
      ok: false,
    });
    expect(cancelJob).toHaveBeenCalledWith('job-instrument-render');
  });

  it('preserves atomic saving and returns the completed Job when cancellation is too late', async () => {
    const controller = new AbortController();
    const queued = createJob('QUEUED');
    const saving = createJob('SAVING');
    const completed = createJob('COMPLETED');
    const cancelJob = vi.fn();
    const removeQueuedJob = vi.fn();

    const result = await runLocalEngineInstrumentRender(
      {
        cancelJob,
        enqueueInstrumentRenderJob: async () => {
          controller.abort();
          return { job: queued, ok: true };
        },
        getJobs: vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            snapshot: { acceptingJobs: true, jobs: [saving] },
          })
          .mockResolvedValueOnce({
            ok: true,
            snapshot: { acceptingJobs: true, jobs: [completed] },
          }),
        removeQueuedJob,
      },
      {} as LocalEngineInstrumentRenderJobRequest,
      { signal: controller.signal, wait: async () => undefined },
    );

    expect(result).toEqual({ job: completed, ok: true });
    expect(cancelJob).not.toHaveBeenCalled();
    expect(removeQueuedJob).not.toHaveBeenCalled();
  });
});

function createJob(
  state: LocalEngineGpuJobRecord['state'],
): LocalEngineGpuJobRecord {
  const timestamp = '2026-07-28T09:00:00.000Z';
  const isFinished = state === 'COMPLETED' || state === 'FAILED';
  return {
    attempt: 1,
    createdAt: timestamp,
    ...(isFinished ? { finishedAt: timestamp } : {}),
    history: [{ attempt: 1, at: timestamp, state }],
    jobId: 'job-instrument-render',
    modelId: 'soundfont-0123456789abcdef0123456789abcdef',
    modelRevision: 'a'.repeat(64),
    providerId: 'local-fluidsynth',
    request: {
      modelId: 'soundfont-0123456789abcdef0123456789abcdef',
      modelRevision: 'a'.repeat(64),
      providerId: 'local-fluidsynth',
      taskId: 'midi-to-audio',
    },
    ...(state === 'COMPLETED'
      ? { result: { artifact: {}, generation: {} } }
      : {}),
    state,
    taskId: 'midi-to-audio',
    updatedAt: timestamp,
  };
}
