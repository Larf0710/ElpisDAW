import { describe, expect, it, vi } from 'vitest';

import {
  AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID,
  type AutoPatchStageAdapterPlan,
} from './autoPatchStageAdapter';
import { runAutoPatchStageAdapterPlan } from './autoPatchStageRunner';
import {
  FLUIDSYNTH_INSTRUMENT_GAIN_DB,
  FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
  FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
  FLUIDSYNTH_INSTRUMENT_SAMPLE_RATE,
} from './fluidSynthInstrumentRender';
import {
  createInstrumentRenderJobRequest,
  INSTRUMENT_RENDER_TASK_ID,
} from './instrumentRenderContract';
import type { LocalEngineGpuJobRecord } from './localEngineClient';
import type { LocalEngineJsonValue } from './localEngineJobs';
import type { TabFlowStageResultScope } from './types';

const soundFontResourceId =
  'soundfont-0123456789abcdef0123456789abcdef';
const soundFontRevision = 'a'.repeat(64);

describe('Auto Patch Stage Runner', () => {
  it('enqueues one adapter plan and returns its exact completed Job', async () => {
    const plan = createPlan();
    const queued = createJob('QUEUED', plan);
    const processing = createJob('PROCESSING', plan);
    const completed = createJob('COMPLETED', plan);
    const progress: string[] = [];
    const client = {
      cancelJob: vi.fn(),
      enqueueInstrumentRenderJob: vi.fn(async () => ({
        job: queued,
        ok: true as const,
      })),
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
      removeQueuedJob: vi.fn(),
    };

    const result = await runAutoPatchStageAdapterPlan(client, plan, {
      onProgress: (update) =>
        progress.push(`${update.attemptId}:${update.state}`),
      wait: async () => undefined,
    });

    expect(result).toMatchObject({
      adapterId: AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID,
      attemptId: 'attempt-instrument',
      fingerprint: 'fingerprint-instrument',
      job: completed,
      ok: true,
      runId: 'run-auto-patch',
      scope: { stageId: 'stage-instrument' },
      status: 'JOB_COMPLETED',
    });
    expect(client.enqueueInstrumentRenderJob).toHaveBeenCalledWith(
      plan.request,
    );
    expect(progress).toEqual([
      'attempt-instrument:ENQUEUEING',
      'attempt-instrument:PROCESSING',
      'attempt-instrument:COMPLETED',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scope)).toBe(true);
  });

  it('returns an immutable failure without inventing Stage output', async () => {
    const plan = createPlan();
    const queued = createJob('QUEUED', plan);
    const failed = {
      ...createJob('FAILED', plan),
      error: {
        code: 'SOUNDFONT_OFFLINE',
        message: 'SoundFont is offline.',
      },
    };

    const result = await runAutoPatchStageAdapterPlan(
      {
        cancelJob: vi.fn(),
        enqueueInstrumentRenderJob: async () => ({
          job: queued,
          ok: true,
        }),
        getJobs: async () => ({
          ok: true,
          snapshot: { acceptingJobs: true, jobs: [failed] },
        }),
        removeQueuedJob: vi.fn(),
      },
      plan,
      { wait: async () => undefined },
    );

    expect(result).toEqual({
      adapterId: AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID,
      attemptId: 'attempt-instrument',
      cause: 'instrument-engine-job-failed',
      fingerprint: 'fingerprint-instrument',
      jobId: 'job-instrument-render',
      message: 'SoundFont is offline.',
      ok: false,
      reason: 'engine-job-failed',
      runId: 'run-auto-patch',
      scope: createScope(),
      status: 'FAILED',
    });
    expect('job' in result).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects a completed Job whose request differs from the adapter plan', async () => {
    const plan = createPlan();
    const queued = createJob('QUEUED', plan);
    const completed = createJob('COMPLETED', plan, {
      request: {
        ...asJobRequest(plan),
        modelRevision: 'b'.repeat(64),
      },
    });

    await expect(
      runAutoPatchStageAdapterPlan(
        {
          cancelJob: vi.fn(),
          enqueueInstrumentRenderJob: async () => ({
            job: queued,
            ok: true,
          }),
          getJobs: async () => ({
            ok: true,
            snapshot: { acceptingJobs: true, jobs: [completed] },
          }),
          removeQueuedJob: vi.fn(),
        },
        plan,
        { wait: async () => undefined },
      ),
    ).resolves.toMatchObject({
      cause: 'completed-job-plan-mismatch',
      jobId: 'job-instrument-render',
      ok: false,
      reason: 'completed-job-mismatch',
      status: 'FAILED',
    });
  });

  it('requests Engine cancellation and returns a canceled Stage outcome', async () => {
    const controller = new AbortController();
    const plan = createPlan();
    const queued = createJob('QUEUED', plan);
    const processing = createJob('PROCESSING', plan);
    const cancelJob = vi.fn(async () => ({
      job: createJob('CANCEL_REQUESTED', plan),
      ok: true as const,
    }));

    const result = await runAutoPatchStageAdapterPlan(
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
        removeQueuedJob: vi.fn(),
      },
      plan,
      { signal: controller.signal, wait: async () => undefined },
    );

    expect(result).toMatchObject({
      cause: 'stage-run-canceled',
      jobId: 'job-instrument-render',
      ok: false,
      reason: 'canceled',
      status: 'FAILED',
    });
    expect(cancelJob).toHaveBeenCalledWith('job-instrument-render');
  });

  it('does not report cancellation when the Engine cancellation request fails', async () => {
    const controller = new AbortController();
    const plan = createPlan();
    const queued = createJob('QUEUED', plan);
    const processing = createJob('PROCESSING', plan);

    const result = await runAutoPatchStageAdapterPlan(
      {
        cancelJob: async () => ({
          message: 'Local Engine is offline.',
          ok: false,
          reason: 'offline',
        }),
        enqueueInstrumentRenderJob: async () => {
          controller.abort();
          return { job: queued, ok: true };
        },
        getJobs: async () => ({
          ok: true,
          snapshot: { acceptingJobs: true, jobs: [processing] },
        }),
        removeQueuedJob: vi.fn(),
      },
      plan,
      { signal: controller.signal, wait: async () => undefined },
    );

    expect(result).toMatchObject({
      cause: 'instrument-engine-job-failed',
      jobId: 'job-instrument-render',
      ok: false,
      reason: 'engine-job-failed',
      status: 'FAILED',
    });
  });
});

function createPlan(): AutoPatchStageAdapterPlan {
  const request = createInstrumentRenderJobRequest({
    gainDb: FLUIDSYNTH_INSTRUMENT_GAIN_DB,
    modelId: soundFontResourceId,
    modelRevision: soundFontRevision,
    plan: {
      midi: {
        bpm: 120,
        notes: [
          {
            id: 'note-a',
            lengthTicks: 960,
            pitch: 60,
            startTick: 0,
            velocity: 100,
          },
        ],
        ticksPerQuarter: 960,
      },
      source: {
        artifactId: 'artifact-midi-edited',
        clipId: 'clip-midi',
        clipTakeId: 'take-midi-edited',
        contentHash: 'fnv1a64-0123456789abcdef',
        label: 'Edited MIDI',
        revision: 1,
        sourceType: 'edit',
      },
    },
    preset: { bank: 0, program: 24 },
    providerId: FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
    providerVersion: FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
    sampleRate: FLUIDSYNTH_INSTRUMENT_SAMPLE_RATE,
    soundFont: {
      format: 'sf2',
      library: 'project',
      relativePath: 'soundfonts/Piano.sf2',
      resourceId: soundFontResourceId,
      revisionToken: soundFontRevision,
    },
  });

  return Object.freeze({
    adapterId: AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID,
    attemptId: 'attempt-instrument',
    fingerprint: 'fingerprint-instrument',
    kind: 'local-engine-job',
    request,
    runId: 'run-auto-patch',
    scope: Object.freeze(createScope()),
    sourceClipId: 'clip-midi',
  });
}

function createScope(): TabFlowStageResultScope {
  return {
    familyId: 'family-main',
    familyRevision: 1,
    stageId: 'stage-instrument',
    targetClipId: 'clip-midi',
  };
}

function createJob(
  state: LocalEngineGpuJobRecord['state'],
  plan: AutoPatchStageAdapterPlan,
  overrides: Partial<LocalEngineGpuJobRecord> = {},
): LocalEngineGpuJobRecord {
  const timestamp = '2026-07-31T00:02:00.000Z';
  const isFinished = state === 'COMPLETED' || state === 'FAILED';

  return {
    attempt: 1,
    createdAt: timestamp,
    ...(isFinished ? { finishedAt: timestamp } : {}),
    history: [{ attempt: 1, at: timestamp, state }],
    jobId: 'job-instrument-render',
    modelId: plan.request.modelId,
    modelRevision: plan.request.modelRevision,
    providerId: plan.request.providerId,
    request: asJobRequest(plan),
    ...(state === 'COMPLETED'
      ? {
          result: {
            artifact: { artifactId: 'artifact-instrument-audio' },
            generation: { bytesWritten: 192_044 },
          },
        }
      : {}),
    state,
    taskId: INSTRUMENT_RENDER_TASK_ID,
    updatedAt: timestamp,
    ...overrides,
  };
}

function asJobRequest(
  plan: AutoPatchStageAdapterPlan,
): Readonly<{ [key: string]: LocalEngineJsonValue }> {
  return plan.request as unknown as Readonly<{
    [key: string]: LocalEngineJsonValue;
  }>;
}
