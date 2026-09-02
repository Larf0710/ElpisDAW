import { describe, expect, it, vi } from 'vitest';

import { prepareAceStepCoverRun } from './aceStepCoverPatchTab';
import { runAceStepCoverPlan } from './aceStepCoverRunner';
import {
  createAceStepCoverProject,
  createConfiguredAceStepCoverPatchTab,
} from './aceStepCoverTestFixture';

describe('ACE-Step Cover Runner', () => {
  it('enqueues the immutable Cover request and returns its matching completed Job', async () => {
    const plan = createPlan();
    const at = '2026-08-31T00:00:16.000Z';
    const job = {
      attempt: 1,
      createdAt: '2026-08-31T00:00:00.000Z',
      finishedAt: at,
      history: [{ attempt: 1, at, state: 'COMPLETED' as const }],
      jobId: 'job-ace-cover-runner-1',
      modelId: plan.request.modelId,
      modelRevision: plan.request.modelRevision,
      providerId: plan.request.providerId,
      request: plan.request,
      state: 'COMPLETED' as const,
      taskId: plan.request.taskId,
      updatedAt: at,
    };
    const client = {
      cancelJob: vi.fn(),
      enqueueAceStepJob: vi.fn().mockResolvedValue({ job, ok: true }),
      getJobs: vi.fn(),
      removeQueuedJob: vi.fn(),
    };

    const result = await runAceStepCoverPlan(client, plan);

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

    const result = await runAceStepCoverPlan(client, plan, {
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      cause: 'ace-step-cover-canceled-before-enqueue',
      ok: false,
      status: 'RUN_CANCELED',
    });
    expect(client.enqueueAceStepJob).not.toHaveBeenCalled();
  });
});

function createPlan() {
  const patchTab = createConfiguredAceStepCoverPatchTab();
  const project = createAceStepCoverProject(patchTab);
  const preparation = prepareAceStepCoverRun(project, patchTab, 'clip-source', {
    createdAt: '2026-08-31T00:00:00.000Z',
    lyricsArtifactId: 'artifact-lyrics',
    lyricsRelativePath: 'renders/ace-step/lyrics/artifact-lyrics.txt',
    requestToken: 'ace-cover-runner-1',
  });
  if (!preparation.canPrepare) throw new Error(preparation.message);
  return preparation.plans[0];
}
