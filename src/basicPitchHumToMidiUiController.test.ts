import { describe, expect, it, vi } from 'vitest';

import {
  BasicPitchHumToMidiUiController,
  createBasicPitchHumToMidiUiPresentation,
  createInitialBasicPitchHumToMidiUiState,
} from './basicPitchHumToMidiUiController';
import { createBasicPitchHumToMidiPlanKey } from './humToMidiGeneration';
import type { LocalEngineBasicPitchHumToMidiClient } from './localEngineHumToMidiGeneration';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import {
  cloneBasicPitchTestValue,
  createBasicPitchHumToMidiTestProject,
  createCompletedBasicPitchHumToMidiTestJob,
  findBasicPitchTestClip,
  requireBasicPitchHumToMidiTestPlan,
} from './basicPitchHumToMidiTestFixture';
import type { ProjectState, SoundFontAssignment } from './types';

const defaultSoundFontAssignment: SoundFontAssignment = {
  bank: 0,
  program: 0,
  resource: {
    format: 'sf3',
    library: 'builtin',
    relativePath: 'soundfonts/HumStudio Default/MuseScore_General.sf3',
    resourceId: `soundfont-${'d'.repeat(32)}`,
  },
};

describe('BasicPitchHumToMidiUiController', () => {
  it('runs one exact production request and returns an atomic uncommitted registration result', async () => {
    const project = createBasicPitchHumToMidiTestProject();
    const before = JSON.stringify(project);
    const plan = requireBasicPitchHumToMidiTestPlan(project);
    const completed = createCompletedBasicPitchHumToMidiTestJob(plan);
    const runGeneration = vi.fn(async (_client, request, options) => {
      options?.onProgress?.({ jobId: completed.jobId, state: 'PROCESSING' });
      expect(request).toEqual(plan.request);
      return { job: completed, ok: true as const };
    });
    const controller = new BasicPitchHumToMidiUiController({
      clock: () => new Date('2026-08-16T13:00:02.000Z'),
      runGeneration,
    });
    const states = vi.fn();

    const result = await controller.run({
      client: createClient(),
      getProject: () => project,
      onState: states,
      patchTabId: 'hum-to-midi',
    });

    expect(result).toMatchObject({
      kind: 'registered',
      sourceClipName: plan.source.clipName,
      state: { status: 'REGISTERED' },
      targetClip: { id: 'clip-midi-1' },
    });
    expect(runGeneration).toHaveBeenCalledOnce();
    expect(JSON.stringify(project)).toBe(before);
    expect(states.mock.calls.map(([state]) => state.status)).toContain('PROCESSING');
  });

  it('resolves the current default SoundFont when a new MIDI target settles', async () => {
    const project = createBasicPitchHumToMidiTestProject();
    project.tracks = project.tracks.filter((track) => track.id !== 'midi-notes');
    const plan = requireBasicPitchHumToMidiTestPlan(project);
    const completed = createCompletedBasicPitchHumToMidiTestJob(plan);
    const controller = new BasicPitchHumToMidiUiController({
      clock: () => new Date('2026-08-16T13:00:02.000Z'),
      runGeneration: vi.fn(async () => ({ job: completed, ok: true as const })),
    });
    const resolveDefaultSoundFontAssignment = vi.fn(
      () => defaultSoundFontAssignment,
    );

    const result = await controller.run({
      client: createClient(),
      getProject: () => project,
      patchTabId: 'hum-to-midi',
      resolveDefaultSoundFontAssignment,
    });

    expect(result).toMatchObject({
      kind: 'registered',
      targetClip: { soundFont: defaultSoundFontAssignment },
      targetCreated: true,
    });
    expect(resolveDefaultSoundFontAssignment).toHaveBeenCalledOnce();
  });

  it('blocks a duplicate operation globally while one exact Job is active', async () => {
    const project = createBasicPitchHumToMidiTestProject();
    let finish: ((job: LocalEngineGpuJobRecord) => void) | undefined;
    const runGeneration = vi.fn(
      async (_client, _request, options) =>
        new Promise<{ job: LocalEngineGpuJobRecord; ok: true }>((resolve) => {
          options?.onProgress?.({ jobId: 'job-basic-pitch-1', state: 'PROCESSING' });
          finish = (job) => resolve({ job, ok: true });
        }),
    );
    const controller = new BasicPitchHumToMidiUiController({ runGeneration });
    const request = {
      client: createClient(),
      getProject: () => project,
      patchTabId: 'hum-to-midi',
    };
    const first = controller.run(request);

    expect(await controller.run(request)).toMatchObject({ kind: 'busy' });
    finish?.(
      createCompletedBasicPitchHumToMidiTestJob(
        requireBasicPitchHumToMidiTestPlan(project),
      ),
    );
    await first;
  });

  it('cancels only a queued Job and releases busy state without Project mutation', async () => {
    const project = createBasicPitchHumToMidiTestProject();
    const before = JSON.stringify(project);
    const runGeneration = vi.fn(async (_client, _request, options) => {
      options?.onProgress?.({ jobId: 'job-basic-pitch-queued', state: 'QUEUED' });
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return {
        jobId: 'job-basic-pitch-queued',
        message: 'internal cancellation detail',
        ok: false as const,
        reason: 'canceled' as const,
        retryable: false,
      };
    });
    const controller = new BasicPitchHumToMidiUiController({ runGeneration });
    const running = controller.run({
      client: createClient(),
      getProject: () => project,
      patchTabId: 'hum-to-midi',
    });

    await Promise.resolve();
    expect(controller.state.status).toBe('QUEUED');
    expect(controller.cancel()).toBe(true);
    expect(await running).toMatchObject({
      kind: 'canceled',
      state: { status: 'CANCELED' },
    });
    expect(controller.isExecuting).toBe(false);
    expect(JSON.stringify(project)).toBe(before);
  });

  it('offers exact retry only while source, request, selection, and settings remain unchanged', async () => {
    const project = createBasicPitchHumToMidiTestProject();
    const plan = requireBasicPitchHumToMidiTestPlan(project);
    const failed = createFailedJob(plan.request);
    const completed = createCompletedBasicPitchHumToMidiTestJob(plan, failed.jobId);
    const runGeneration = vi
      .fn()
      .mockResolvedValueOnce({
        job: failed,
        jobId: failed.jobId,
        message: 'provider detail',
        ok: false,
        reason: 'engine-job-failed',
        retryable: true,
      })
      .mockResolvedValueOnce({ job: completed, ok: true });
    const controller = new BasicPitchHumToMidiUiController({ runGeneration });
    const request = {
      client: createClient(),
      getProject: () => project,
      patchTabId: 'hum-to-midi',
    };

    expect(await controller.run(request)).toMatchObject({ kind: 'retry-required' });
    expect(await controller.retry(request)).toMatchObject({ kind: 'registered' });
    expect(runGeneration.mock.calls[1][2]).toMatchObject({
      retryJobId: failed.jobId,
    });

    const changedProject = createBasicPitchHumToMidiTestProject();
    const changedPlan = requireBasicPitchHumToMidiTestPlan(changedProject);
    const changedFailed = createFailedJob(changedPlan.request);
    const changedController = new BasicPitchHumToMidiUiController({
      runGeneration: vi.fn(async () => ({
        job: changedFailed,
        jobId: changedFailed.jobId,
        message: 'failed',
        ok: false as const,
        reason: 'engine-job-failed' as const,
        retryable: true,
      })),
    });
    const changedRequest = {
      client: createClient(),
      getProject: () => changedProject,
      patchTabId: 'hum-to-midi',
    };
    await changedController.run(changedRequest);
    changedProject.bpm += 1;
    expect(await changedController.retry(changedRequest)).toMatchObject({
      kind: 'blocked',
    });
  });

  it('keeps a completed exact Job recoverable when settlement becomes stale', async () => {
    const original = createBasicPitchHumToMidiTestProject();
    const plan = requireBasicPitchHumToMidiTestPlan(original);
    const completed = createCompletedBasicPitchHumToMidiTestJob(plan);
    let current = cloneBasicPitchTestValue(original);
    current.selection.items = [];
    const controller = new BasicPitchHumToMidiUiController({
      clock: () => new Date('2026-08-16T13:00:02.000Z'),
      runGeneration: vi.fn(async () => ({ job: completed, ok: true as const })),
    });
    const request = {
      client: createClient(),
      getProject: () => current,
      patchTabId: 'hum-to-midi',
    };

    expect(await controller.run({ ...request, getProject: () => original })).toMatchObject({
      kind: 'registered',
    });
    controller.markRegistrationPending(
      completed.jobId,
      'Project changed before commit.',
    );
    expect(await controller.run(request)).toMatchObject({
      kind: 'recovery-required',
    });
    expect(await controller.recover(request)).toMatchObject({
      kind: 'registration-pending',
    });

    current = original;
    expect(await controller.recover(request)).toMatchObject({
      kind: 'registered',
    });
  });

  it('sanitizes unexpected runner failures and never mutates Project state', async () => {
    const project = createBasicPitchHumToMidiTestProject();
    const before = JSON.stringify(project);
    const controller = new BasicPitchHumToMidiUiController({
      runGeneration: vi.fn(async () => {
        throw new Error('C:\\Users\\secret\\recording.wav TOKEN=top-secret');
      }),
    });
    const result = await controller.run({
      client: createClient(),
      getProject: () => project,
      patchTabId: 'hum-to-midi',
    });

    expect(result).toMatchObject({ kind: 'failed', state: { status: 'ERROR' } });
    expect(result.state.message).not.toContain('Users');
    expect(result.state.message).not.toContain('TOKEN');
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe('Basic Pitch Hum to MIDI UI presentation', () => {
  it('shows READY only for an eligible recording with ready Engine and Project Root', () => {
    const project = createBasicPitchHumToMidiTestProject();
    const patchTab = project.patchTabs.find((candidate) => candidate.id === 'hum-to-midi');
    if (!patchTab) throw new Error('Hum to MIDI fixture missing.');

    expect(
      createBasicPitchHumToMidiUiPresentation({
        engineAcceptsNewJobs: true,
        engineAvailabilityMessage: 'Engine ready.',
        isProjectRootReady: true,
        patchTab,
        project,
        runtime: { status: 'READY' },
        state: createInitialBasicPitchHumToMidiUiState(),
      }),
    ).toMatchObject({
      buttonLabel: 'CONVERT',
      canAct: true,
      eyebrow: 'BASIC PITCH READY',
    });

    const empty = cloneBasicPitchTestValue(project);
    empty.selection.items = [];
    expect(
      createBasicPitchHumToMidiUiPresentation({
        engineAcceptsNewJobs: true,
        engineAvailabilityMessage: 'Engine ready.',
        isProjectRootReady: true,
        patchTab,
        project: empty,
        runtime: { status: 'READY' },
        state: createInitialBasicPitchHumToMidiUiState(),
      }),
    ).toMatchObject({ buttonLabel: 'CONVERT', canAct: false });

    expect(
      createBasicPitchHumToMidiUiPresentation({
        engineAcceptsNewJobs: false,
        engineAvailabilityMessage: 'Local Engine is busy.',
        isProjectRootReady: true,
        patchTab,
        project,
        runtime: { status: 'READY' },
        state: createInitialBasicPitchHumToMidiUiState(),
      }),
    ).toMatchObject({
      buttonLabel: 'CONVERT',
      canAct: false,
      detail: 'Local Engine is busy.',
      eyebrow: 'ENGINE UNAVAILABLE',
    });

    expect(
      createBasicPitchHumToMidiUiPresentation({
        engineAcceptsNewJobs: true,
        engineAvailabilityMessage: 'Engine ready.',
        isProjectRootReady: false,
        patchTab,
        project,
        runtime: { status: 'READY' },
        state: createInitialBasicPitchHumToMidiUiState(),
      }),
    ).toMatchObject({
      buttonLabel: 'CONVERT',
      canAct: false,
      detail: expect.stringContaining('Project Root'),
      eyebrow: 'ENGINE UNAVAILABLE',
    });
  });

  it('shows CANCEL for queued work, WAIT after dispatch, RETRY, and RECOVER truthfully', () => {
    const project = createBasicPitchHumToMidiTestProject();
    const patchTab = project.patchTabs.find((candidate) => candidate.id === 'hum-to-midi');
    const plan = requireBasicPitchHumToMidiTestPlan(project);
    if (!patchTab) throw new Error('Hum to MIDI fixture missing.');
    const base = {
      engineAcceptsNewJobs: true,
      engineAvailabilityMessage: 'Engine ready.',
      isProjectRootReady: true,
      patchTab,
      project,
      runtime: { status: 'READY' } as const,
    };

    expect(
      createBasicPitchHumToMidiUiPresentation({
        ...base,
        state: { patchTabId: patchTab.id, status: 'QUEUED' },
      }),
    ).toMatchObject({ buttonLabel: 'CANCEL', canAct: true });
    expect(
      createBasicPitchHumToMidiUiPresentation({
        ...base,
        state: { patchTabId: patchTab.id, status: 'PROCESSING' },
      }),
    ).toMatchObject({ buttonLabel: 'WAIT', canAct: false });
    expect(
      createBasicPitchHumToMidiUiPresentation({
        ...base,
        state: {
          patchTabId: patchTab.id,
          planKey: createBasicPitchHumToMidiPlanKey(plan),
          retryable: true,
          status: 'ERROR',
        },
      }).buttonLabel,
    ).toBe('RETRY');
  });

  it('blocks CONVERT and RETRY until the pinned Runtime inspection is READY', () => {
    const project = createBasicPitchHumToMidiTestProject();
    const patchTab = project.patchTabs.find((candidate) => candidate.id === 'hum-to-midi');
    const plan = requireBasicPitchHumToMidiTestPlan(project);
    if (!patchTab) throw new Error('Hum to MIDI fixture missing.');
    const base = {
      engineAcceptsNewJobs: true,
      engineAvailabilityMessage: 'Engine ready.',
      isProjectRootReady: true,
      patchTab,
      project,
      state: createInitialBasicPitchHumToMidiUiState(),
    };

    expect(
      createBasicPitchHumToMidiUiPresentation({
        ...base,
        runtime: { status: 'CHECKING' },
      }),
    ).toMatchObject({
      ariaBusy: true,
      canAct: false,
      eyebrow: 'BASIC PITCH RUNTIME CHECK',
    });
    expect(
      createBasicPitchHumToMidiUiPresentation({
        ...base,
        runtime: {
          message: 'Basic Pitch Runtime is unavailable.',
          status: 'UNAVAILABLE',
        },
      }),
    ).toMatchObject({
      canAct: false,
      detail: 'Basic Pitch Runtime is unavailable.',
      eyebrow: 'BASIC PITCH RUNTIME UNAVAILABLE',
    });
    expect(
      createBasicPitchHumToMidiUiPresentation({
        ...base,
        runtime: {
          message: 'Basic Pitch Runtime is unavailable.',
          status: 'UNAVAILABLE',
        },
        state: {
          patchTabId: patchTab.id,
          planKey: createBasicPitchHumToMidiPlanKey(plan),
          retryable: true,
          status: 'ERROR',
        },
      }),
    ).toMatchObject({ buttonLabel: 'RETRY', canAct: false });
  });
});

function createClient(): LocalEngineBasicPitchHumToMidiClient {
  return {
    enqueueBasicPitchHumToMidiJob: vi.fn(),
    getJobs: vi.fn(),
    removeQueuedJob: vi.fn(),
    retryJob: vi.fn(),
  };
}

function createFailedJob(
  request: ReturnType<typeof requireBasicPitchHumToMidiTestPlan>['request'],
): LocalEngineGpuJobRecord {
  const completed = createCompletedBasicPitchHumToMidiTestJob(
    { ...requireBasicPitchHumToMidiTestPlan(createBasicPitchHumToMidiTestProject()), request },
    'job-basic-pitch-failed',
  );
  return {
    ...completed,
    error: { code: 'BASIC_PITCH_FAILED', message: 'provider detail' },
    result: undefined,
    state: 'FAILED',
  };
}
