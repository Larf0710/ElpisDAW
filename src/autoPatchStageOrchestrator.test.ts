import { describe, expect, it, vi } from 'vitest';

import {
  autoPatchInstrumentAttemptId,
  autoPatchInstrumentOutputClipId,
  autoPatchInstrumentResultId,
  createAutoPatchInstrumentStageFixture,
} from './autoPatchInstrumentStage.testFixture';
import type { AutoPatchStageRunnerClient } from './autoPatchStageRunner';
import { orchestrateAutoPatchRuntimeStage } from './autoPatchStageOrchestrator';
import type {
  LocalEngineGpuJobRecord,
  LocalEngineJsonValue,
} from './localEngineJobs';
import type { ProjectState } from './types';

const options = {
  attemptId: autoPatchInstrumentAttemptId,
  label: 'Auto Patch Instrument Render',
  now: () => '2026-07-31T00:03:00.000Z',
  outputClipId: autoPatchInstrumentOutputClipId,
  resultId: autoPatchInstrumentResultId,
  runner: { wait: async () => undefined },
  startedAt: '2026-07-31T00:01:10.000Z',
};

describe('Auto Patch Stage orchestrator', () => {
  it('runs one Instrument Stage from Coordinator dispatch through atomic Project completion', async () => {
    const fixture = createAutoPatchInstrumentStageFixture();
    const client = createCompletedClient(fixture.runner.job);
    const progress: string[] = [];

    const result = await orchestrateAutoPatchRuntimeStage(
      client,
      fixture.project,
      fixture.coordinatorReady,
      fixture.soundFontResources,
      {
        ...options,
        runner: {
          onProgress: (update) => progress.push(update.state),
          wait: async () => undefined,
        },
      },
    );

    expect(result).toMatchObject({
      completion: {
        outputClip: { id: autoPatchInstrumentOutputClipId },
        registrationStatus: 'REGISTERED',
        result: { resultId: autoPatchInstrumentResultId },
      },
      coordinator: { status: 'COMPLETED' },
      ok: true,
      runner: { status: 'JOB_COMPLETED' },
      status: 'STAGE_COMPLETED',
    });
    expect(client.enqueueInstrumentRenderJob).toHaveBeenCalledTimes(1);
    expect(progress).toEqual(['ENQUEUEING', 'COMPLETED']);

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(findClips(result.project, autoPatchInstrumentOutputClipId)).toHaveLength(1);
    expect(findClips(fixture.project, autoPatchInstrumentOutputClipId)).toHaveLength(0);
    expect(result.project.tabFlowStageResults).toEqual(
      result.coordinator.stageResults,
    );
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('records an Adapter rejection without calling the Engine or changing Project data', async () => {
    const fixture = createAutoPatchInstrumentStageFixture();
    const snapshot = JSON.stringify(fixture.project);
    const client = createCompletedClient(fixture.runner.job);

    const result = await orchestrateAutoPatchRuntimeStage(
      client,
      fixture.project,
      fixture.coordinatorReady,
      [],
      options,
    );

    expect(result).toMatchObject({
      cause: 'soundfont-resource-unavailable',
      coordinator: {
        failure: {
          attemptId: autoPatchInstrumentAttemptId,
          cause: 'soundfont-resource-unavailable',
        },
        status: 'FAILED',
      },
      ok: false,
      reason: 'adapter-rejected',
      status: 'STAGE_FAILED',
    });
    expect(client.enqueueInstrumentRenderJob).not.toHaveBeenCalled();
    expect(result.project).toBe(fixture.project);
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
  });

  it('records the exact Engine Job failure without creating Project output', async () => {
    const fixture = createAutoPatchInstrumentStageFixture();
    const client = createFailedClient(fixture.runner.job);

    const result = await orchestrateAutoPatchRuntimeStage(
      client,
      fixture.project,
      fixture.coordinatorReady,
      fixture.soundFontResources,
      options,
    );

    expect(result).toMatchObject({
      cause: 'instrument-engine-job-failed',
      coordinator: {
        failure: {
          cause: 'instrument-engine-job-failed',
          message: 'SoundFont is offline.',
        },
        status: 'FAILED',
      },
      message: 'SoundFont is offline.',
      ok: false,
      reason: 'runner-failed',
    });
    expect(findClips(result.project, autoPatchInstrumentOutputClipId)).toHaveLength(0);
  });

  it('records cancellation after requesting Engine cancellation', async () => {
    const fixture = createAutoPatchInstrumentStageFixture();
    const controller = new AbortController();
    const queued = createJobState(fixture.runner.job, 'QUEUED');
    const processing = createJobState(
      fixture.runner.job,
      'PROCESSING',
    );
    const cancelJob = vi.fn(async () => ({
      job: createJobState(fixture.runner.job, 'CANCEL_REQUESTED'),
      ok: true as const,
    }));
    const client: AutoPatchStageRunnerClient = {
      cancelJob,
      enqueueInstrumentRenderJob: vi.fn(async () => {
        controller.abort();
        return { job: queued, ok: true as const };
      }),
      getJobs: vi.fn(async () => ({
        ok: true as const,
        snapshot: { acceptingJobs: true, jobs: [processing] },
      })),
      removeQueuedJob: vi.fn(),
    };

    const result = await orchestrateAutoPatchRuntimeStage(
      client,
      fixture.project,
      fixture.coordinatorReady,
      fixture.soundFontResources,
      {
        ...options,
        runner: {
          signal: controller.signal,
          wait: async () => undefined,
        },
      },
    );

    expect(result).toMatchObject({
      cause: 'stage-run-canceled',
      coordinator: {
        failure: { cause: 'stage-run-canceled' },
        status: 'FAILED',
      },
      ok: false,
      reason: 'runner-failed',
    });
    expect(cancelJob).toHaveBeenCalledWith(
      fixture.runner.job.jobId,
    );
  });

  it('rolls back completion output and records a Coordinator result conflict', async () => {
    const fixture = createAutoPatchInstrumentStageFixture();
    const snapshot = JSON.stringify(fixture.project);

    const result = await orchestrateAutoPatchRuntimeStage(
      createCompletedClient(fixture.runner.job),
      fixture.project,
      fixture.coordinatorReady,
      fixture.soundFontResources,
      { ...options, resultId: 'result-midi-edit' },
    );

    expect(result).toMatchObject({
      cause: 'completed-stage-result-invalid',
      coordinator: {
        failure: { cause: 'completed-stage-result-invalid' },
        status: 'FAILED',
      },
      ok: false,
      reason: 'completion-failed',
    });
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
    expect(findClips(result.project, autoPatchInstrumentOutputClipId)).toHaveLength(0);
  });

  it('rejects a non-ready Coordinator before calling Adapter or Engine', async () => {
    const fixture = createAutoPatchInstrumentStageFixture();
    const client = createCompletedClient(fixture.runner.job);

    const result = await orchestrateAutoPatchRuntimeStage(
      client,
      fixture.project,
      fixture.coordinatorRunning,
      fixture.soundFontResources,
      options,
    );

    expect(result).toMatchObject({
      cause: 'runtime-transition-invalid',
      coordinator: { status: 'RUNNING' },
      ok: false,
      reason: 'begin-rejected',
    });
    expect(client.enqueueInstrumentRenderJob).not.toHaveBeenCalled();
  });
});

function createCompletedClient(
  completed: LocalEngineGpuJobRecord,
): AutoPatchStageRunnerClient & Readonly<{
  enqueueInstrumentRenderJob: ReturnType<typeof vi.fn>;
}> {
  return {
    cancelJob: vi.fn(),
    enqueueInstrumentRenderJob: vi.fn(async () => ({
      job: createJobState(completed, 'QUEUED'),
      ok: true as const,
    })),
    getJobs: vi.fn(async () => ({
      ok: true as const,
      snapshot: { acceptingJobs: true, jobs: [completed] },
    })),
    removeQueuedJob: vi.fn(),
  };
}

function createFailedClient(
  completed: LocalEngineGpuJobRecord,
): AutoPatchStageRunnerClient {
  const failed = {
    ...createJobState(completed, 'FAILED'),
    error: {
      code: 'SOUNDFONT_OFFLINE',
      message: 'SoundFont is offline.',
    },
    finishedAt: '2026-07-31T00:02:00.000Z',
  };

  return {
    cancelJob: vi.fn(),
    enqueueInstrumentRenderJob: vi.fn(async () => ({
      job: createJobState(completed, 'QUEUED'),
      ok: true as const,
    })),
    getJobs: vi.fn(async () => ({
      ok: true as const,
      snapshot: { acceptingJobs: true, jobs: [failed] },
    })),
    removeQueuedJob: vi.fn(),
  };
}

function createJobState(
  completed: LocalEngineGpuJobRecord,
  state: Exclude<LocalEngineGpuJobRecord['state'], 'COMPLETED'>,
): LocalEngineGpuJobRecord {
  const {
    finishedAt: _finishedAt,
    result: _result,
    ...base
  } = completed;
  const timestamp = '2026-07-31T00:01:11.000Z';

  return {
    ...base,
    history: [{ attempt: 1, at: timestamp, state }],
    request: completed.request as Readonly<{
      [key: string]: LocalEngineJsonValue;
    }>,
    state,
    updatedAt: timestamp,
  };
}

function findClips(project: ProjectState, clipId: string) {
  return project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);
}
