import { describe, expect, it, vi } from 'vitest';

import {
  createAceStepTextToMusicPatchTabTemplate,
  prepareAceStepTextToMusicRun,
} from './aceStepTextToMusicPatchTab';
import { runAceStepTextToMusicPlan } from './aceStepTextToMusicRunner';
import { createEmptyProject } from './emptyProject';

describe('ACE-Step Text to Music Runner', () => {
  it('enqueues the immutable request and returns a matching completed Job', async () => {
    const plan = createPlan();
    const job = createJob(plan, 'COMPLETED');
    const client = {
      cancelJob: vi.fn(),
      enqueueAceStepJob: vi.fn().mockResolvedValue({ job, ok: true }),
      getJobs: vi.fn(),
      removeQueuedJob: vi.fn(),
    };

    const result = await runAceStepTextToMusicPlan(client, plan);

    expect(result).toMatchObject({ jobId: job.jobId, ok: true, status: 'JOB_COMPLETED' });
    expect(client.enqueueAceStepJob).toHaveBeenCalledWith(plan.request);
    expect(client.getJobs).not.toHaveBeenCalled();
  });

  it('honors cancellation before enqueue', async () => {
    const plan = createPlan();
    const controller = new AbortController();
    controller.abort();
    const client = {
      cancelJob: vi.fn(),
      enqueueAceStepJob: vi.fn(),
      getJobs: vi.fn(),
      removeQueuedJob: vi.fn(),
    };

    const result = await runAceStepTextToMusicPlan(client, plan, {
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      cause: 'ace-step-t2m-canceled-before-enqueue',
      ok: false,
      status: 'RUN_CANCELED',
    });
    expect(client.enqueueAceStepJob).not.toHaveBeenCalled();
  });
});

function createPlan() {
  const template = createAceStepTextToMusicPatchTabTemplate();
  const patchTab = {
    ...template,
    id: 'ace-t2m-runner',
    parameters: template.parameters.map((parameter) => {
      if (parameter.id === 'prompt' && parameter.kind === 'text') {
        return { ...parameter, value: 'Dreamy synth pop instrumental' };
      }
      return parameter;
    }),
  };
  const project = {
    ...createEmptyProject(),
    bpm: 120,
    key: 'C major',
    patchTabs: [patchTab],
  };
  const preparation = prepareAceStepTextToMusicRun(project, patchTab, {
    createdAt: '2026-08-31T00:00:00.000Z',
    lyricsArtifactId: 'artifact-12345678-1234-4123-8123-123456789abc',
    lyricsRelativePath:
      'renders/ace-step/lyrics/artifact-12345678-1234-4123-8123-123456789abc.txt',
    requestToken: 'ace-t2m-runner-1',
  });
  if (!preparation.canPrepare) throw new Error(preparation.message);
  return preparation.plans[0];
}

function createJob(plan: ReturnType<typeof createPlan>, state: 'COMPLETED' | 'QUEUED') {
  const at = '2026-08-31T00:00:16.000Z';
  return {
    attempt: 1,
    createdAt: '2026-08-31T00:00:00.000Z',
    ...(state === 'COMPLETED' ? { finishedAt: at } : {}),
    history: [{ attempt: 1, at, state }],
    jobId: 'job-ace-t2m-runner-1',
    modelId: plan.request.modelId,
    modelRevision: plan.request.modelRevision,
    providerId: plan.request.providerId,
    request: plan.request,
    state,
    taskId: plan.request.taskId,
    updatedAt: at,
  } as const;
}
