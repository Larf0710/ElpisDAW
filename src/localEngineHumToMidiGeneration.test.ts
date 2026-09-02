import { describe, expect, it, vi } from 'vitest';

import type {
  LocalEngineGpuJobRecord,
  LocalEngineMockHumToMidiJobRequest,
} from './localEngineClient';
import { runLocalEngineHumToMidiGeneration } from './localEngineHumToMidiGeneration';

describe('runLocalEngineHumToMidiGeneration', () => {
  it('enqueues one Hum-to-MIDI Job and reports state changes through completion', async () => {
    const queued = createJob('QUEUED');
    const processing = createJob('PROCESSING');
    const completed = createJob('COMPLETED');
    const getJobs = vi
      .fn()
      .mockResolvedValueOnce(createSnapshotResult(queued))
      .mockResolvedValueOnce(createSnapshotResult(processing))
      .mockResolvedValueOnce(createSnapshotResult(completed));
    const onProgress = vi.fn();
    const result = await runLocalEngineHumToMidiGeneration(
      {
        enqueueMockHumToMidiJob: vi.fn(async () => ({
          job: queued,
          ok: true as const,
        })),
        getJobs,
      },
      createRequest(),
      { onProgress, wait: async () => undefined },
    );

    expect(result).toEqual({ job: completed, ok: true });
    expect(onProgress.mock.calls.map(([progress]) => progress.state)).toEqual([
      'ENQUEUEING',
      'QUEUED',
      'PROCESSING',
      'COMPLETED',
    ]);
  });

  it('surfaces enqueue, snapshot, and terminal Job failures', async () => {
    const enqueueFailure = await runLocalEngineHumToMidiGeneration(
      {
        enqueueMockHumToMidiJob: async () => ({
          message: 'Project Root required.',
          ok: false,
          reason: 'http-error',
          status: 409,
        }),
        getJobs: vi.fn(),
      },
      createRequest(),
    );
    const queued = createJob('QUEUED');
    const snapshotFailure = await runLocalEngineHumToMidiGeneration(
      {
        enqueueMockHumToMidiJob: async () => ({ job: queued, ok: true }),
        getJobs: async () => ({
          message: 'Engine offline.',
          ok: false,
          reason: 'offline',
        }),
      },
      createRequest(),
    );
    const failed = createJob('FAILED', {
      error: {
        code: 'MOCK_HUM_TO_MIDI_FAILED',
        message: 'Transcription failed.',
      },
    });
    const jobFailure = await runLocalEngineHumToMidiGeneration(
      {
        enqueueMockHumToMidiJob: async () => ({ job: queued, ok: true }),
        getJobs: async () => createSnapshotResult(failed),
      },
      createRequest(),
    );

    expect(enqueueFailure).toEqual({
      message: 'Project Root required.',
      ok: false,
    });
    expect(snapshotFailure).toEqual({
      jobId: queued.jobId,
      message: 'Engine offline.',
      ok: false,
    });
    expect(jobFailure).toEqual({
      jobId: failed.jobId,
      message: 'Transcription failed.',
      ok: false,
    });
  });

  it('fails explicitly when the Job disappears or polling expires', async () => {
    const queued = createJob('QUEUED');
    const missing = await runLocalEngineHumToMidiGeneration(
      {
        enqueueMockHumToMidiJob: async () => ({ job: queued, ok: true }),
        getJobs: async () => ({
          ok: true,
          snapshot: { acceptingJobs: true, jobs: [] },
        }),
      },
      createRequest(),
    );
    const timedOut = await runLocalEngineHumToMidiGeneration(
      {
        enqueueMockHumToMidiJob: async () => ({ job: queued, ok: true }),
        getJobs: async () => createSnapshotResult(queued),
      },
      createRequest(),
      { maxPollAttempts: 2, wait: async () => undefined },
    );

    expect(missing).toMatchObject({
      message: expect.stringContaining('no longer'),
      ok: false,
    });
    expect(timedOut).toMatchObject({
      message: expect.stringContaining('timeout'),
      ok: false,
    });
  });
});

function createSnapshotResult(job: LocalEngineGpuJobRecord) {
  return {
    ok: true as const,
    snapshot: {
      acceptingJobs: true,
      ...(job.state === 'PROCESSING' ? { activeJobId: job.jobId } : {}),
      jobs: [job],
    },
  };
}

function createJob(
  state: LocalEngineGpuJobRecord['state'],
  additions: Partial<LocalEngineGpuJobRecord> = {},
): LocalEngineGpuJobRecord {
  const createdAt = '2026-07-27T05:00:00.000Z';
  const updatedAt =
    state === 'QUEUED' ? createdAt : '2026-07-27T05:00:01.000Z';
  const isFinished = state === 'COMPLETED' || state === 'FAILED';

  return {
    attempt: 1,
    createdAt,
    ...(isFinished ? { finishedAt: updatedAt } : {}),
    history: [{ attempt: 1, at: updatedAt, state }],
    jobId: 'job-hum-midi-ui-test',
    modelId: 'mock-hum-to-midi-v1',
    modelRevision: '1',
    providerId: 'mock-provider',
    request: createRequest(),
    ...(state === 'COMPLETED'
      ? { result: { artifact: {}, transcription: {} } }
      : {}),
    ...(state !== 'QUEUED' ? { startedAt: createdAt } : {}),
    state,
    taskId: 'hum-to-midi',
    updatedAt,
    ...additions,
  };
}

function createRequest(): LocalEngineMockHumToMidiJobRequest {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-recording-1',
        kind: 'audio',
        relativePath: 'recordings/artifact-recording-1.wav',
      },
    ],
    lineage: {
      parentArtifactIds: ['artifact-recording-1'],
      parentClipTakeIds: ['clip-take-recording-1'],
    },
    modelId: 'mock-hum-to-midi-v1',
    modelRevision: '1',
    output: { artifactKind: 'midi' },
    parameters: {
      projectBpm: 120,
      seed: 7,
      sourceEndSeconds: 2,
      sourceStartSeconds: 0,
      ticksPerQuarter: 960,
    },
    providerId: 'mock-provider',
    taskId: 'hum-to-midi',
  };
}
