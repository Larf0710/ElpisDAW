import { describe, expect, it } from 'vitest';

import { AUDIO_GENERATION_REGION_TICKS_PER_BAR } from './audioGenerationRegion';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import {
  createSessionEditHistory,
  redoSessionEdit,
  type SessionEditHistory,
  undoSessionEdit,
} from './sessionEditHistory';
import {
  resolveStableAudio3TextToAudioCapability,
  type StableAudio3TextToAudioJobPlan,
} from './stableAudio3TextToAudioCapability';
import {
  settleStableAudio3TextToAudioJob,
  settleStableAudio3TextToAudioJobs,
} from './stableAudio3TextToAudioSettlement';
import type { ProjectState } from './types';

const MODEL_REVISION = '27b5a21b791b1b033d193a9e1e3ce78493f102f9';
const RUNTIME_PROFILE =
  'windows-x64-cpython-3-10-pytorch-2-7-1-cu126-flash-attention-2-8-3';

type TestWorkspace = Readonly<{
  panel: 'timeline';
  project: ProjectState;
  selectedClipId: string;
}>;

describe('Stable Audio 3 text-to-audio settlement', () => {
  it('registers a three-Seed batch as three Takes in one new Clip and one Edit', () => {
    const project = createProject();
    const history = createHistory(createWorkspace(project));
    const plans = [17, 18, 19].map((seed) => createPlan(project, seed));
    const jobs = plans.map((plan, index) =>
      createCompletedJob(plan, `batch-${index + 1}`),
    );
    const result = settleStableAudio3TextToAudioJobs(
      history,
      plans,
      jobs,
      { kind: 'new' },
      { historyLimit: 80 },
    );

    expect(result).toMatchObject({
      artifacts: [
        { provenance: { seed: 17 } },
        { provenance: { seed: 18 } },
        { provenance: { seed: 19 } },
      ],
      clip: {
        activeClipTakeId:
          'clip-take-artifact-stable-audio-3-t2a-batch-1',
        clipTakes: [
          { label: 'SA3 T2A Take 01' },
          { label: 'SA3 T2A Take 02' },
          { label: 'SA3 T2A Take 03' },
        ],
        id: 'sa3-t2a-clip-1',
      },
      settled: true,
      status: 'SETTLED',
      workspace: { selectedClipId: 'sa3-t2a-clip-1' },
    });

    if (!result.settled) {
      throw new Error(result.message);
    }

    expect(result.history.past).toHaveLength(1);
    expect(result.workspace.project.tracks).toHaveLength(1);
    expect(result.workspace.project.artifacts).toHaveLength(3);
  });

  it('atomically creates the planned Track, Clip, Artifact, and first Clip Take', () => {
    const project = createProject();
    const workspace = createWorkspace(project);
    const history = createHistory(workspace);
    const plan = createPlan(project);
    const job = createCompletedJob(plan);
    const projectSnapshot = JSON.stringify(project);

    const result = settleStableAudio3TextToAudioJob(history, plan, job, {
      historyLimit: 80,
    });

    expect(result).toMatchObject({
      artifact: {
        destination: 'stable-audio-3',
        lineage: {
          parentArtifactIds: [],
          parentClipTakeIds: [],
        },
        provenance: { taskId: 'text-to-audio' },
      },
      clip: {
        activeClipTakeId: 'clip-take-artifact-stable-audio-3-t2a',
        id: 'sa3-t2a-clip-1',
        startTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 2,
        type: 'ai-fill-audio',
        version: 2,
      },
      clipTake: {
        artifactId: 'artifact-stable-audio-3-t2a',
        label: 'SA3 T2A Take 01',
        sourceJobId: 'job-stable-audio-3-t2a',
      },
      edit: {
        category: 'clip',
        createdAt: '2026-08-06T01:00:16.000Z',
        id: 'edit-job-stable-audio-3-t2a-sa3-t2a-settlement',
        label: 'Generate SA3 T2A Clip',
      },
      settled: true,
      status: 'SETTLED',
      track: {
        id: 'sa3-t2a-track-1',
        level: -6,
        type: 'generated_audio',
      },
      workspace: {
        panel: 'timeline',
        selectedClipId: 'sa3-t2a-clip-1',
      },
    });
    expect(JSON.stringify(project)).toBe(projectSnapshot);
    expect(history.present.value).toBe(workspace);

    if (!result.settled || result.status !== 'SETTLED') {
      throw new Error('Expected SA3 T2A settlement to succeed.');
    }

    expect(result.workspace.project.artifacts).toEqual([result.artifact]);
    expect(result.workspace.project.tracks).toHaveLength(1);
    expect(result.track.clips).toEqual([result.clip]);
    expect(result.clip.clipTakes).toEqual([result.clipTake]);
    expect(result.history.past).toHaveLength(1);
    expect(result.history.present.value).toBe(result.workspace);

    const undone = undoSessionEdit(result.history);
    expect(undone.status).toBe('MOVED');
    expect(undone.history.present.value).toBe(workspace);
    const redone = redoSessionEdit(undone.history, 80);
    expect(redone.status).toBe('MOVED');
    expect(redone.history.present.value).toBe(result.workspace);
  });

  it('does not create an empty Track for unfinished or failed output', () => {
    const project = createProject();
    const history = createHistory(createWorkspace(project));
    const plan = createPlan(project);
    const completed = createCompletedJob(plan);
    const job = {
      ...completed,
      finishedAt: undefined,
      result: undefined,
      state: 'FAILED' as const,
    };

    const result = settleStableAudio3TextToAudioJob(history, plan, job, {
      historyLimit: 80,
    });

    expect(result).toMatchObject({
      cause: 'stable-audio-3-t2a-job-not-completed',
      reason: 'job-not-completed',
      settled: false,
      status: 'BLOCKED',
    });
    expect(result.history).toBe(history);
    expect(result.workspace).toBe(history.present.value);
    expect(result.workspace.project).toBe(project);
    expect(project.tracks).toEqual([]);
    expect(project.artifacts).toEqual([]);
  });

  it('blocks a completed Job whose immutable request differs from the plan', () => {
    const project = createProject();
    const history = createHistory(createWorkspace(project));
    const plan = createPlan(project);
    const job = createCompletedJob(plan);
    const mismatchedJob = {
      ...job,
      request: {
        ...job.request,
        parameters: {
          ...plan.request.parameters,
          prompt: 'A different request',
        },
      },
    };

    const result = settleStableAudio3TextToAudioJob(
      history,
      plan,
      mismatchedJob,
      { historyLimit: 80 },
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-t2a-job-plan-mismatch',
      reason: 'job-plan-mismatch',
      settled: false,
    });
    expect(result.history).toBe(history);
    expect(result.workspace.project).toBe(project);
  });

  it('blocks stale Tempo before materializing any Project output', () => {
    const plannedProject = createProject();
    const plan = createPlan(plannedProject);
    const job = createCompletedJob(plan);
    const currentProject = { ...plannedProject, bpm: 90 };
    const history = createHistory(createWorkspace(currentProject));

    const result = settleStableAudio3TextToAudioJob(history, plan, job, {
      historyLimit: 80,
    });

    expect(result).toMatchObject({
      cause: 'generation-region-application-plan-stale',
      reason: 'output-stale',
      settled: false,
    });
    expect(result.history).toBe(history);
    expect(result.workspace.project).toBe(currentProject);
    expect(currentProject.tracks).toEqual([]);
  });

  it('rejects malformed completed Artifact metadata without retaining the Region', () => {
    const project = createProject();
    const history = createHistory(createWorkspace(project));
    const plan = createPlan(project);
    const job = createCompletedJob(plan);
    const malformedJob = {
      ...job,
      result: {
        ...(job.result as Record<string, unknown>),
        generation: {
          ...((job.result as Record<string, unknown>)
            .generation as Record<string, unknown>),
          channels: 1,
        },
      },
    };

    const result = settleStableAudio3TextToAudioJob(
      history,
      plan,
      malformedJob,
      { historyLimit: 80 },
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-t2a-registration-invalid',
      reason: 'registration-invalid',
      settled: false,
    });
    expect(result.history).toBe(history);
    expect(result.workspace.project).toBe(project);
    expect(project.tracks).toEqual([]);
  });

  it('is idempotent after success and respects an explicit Undo', () => {
    const project = createProject();
    const workspace = createWorkspace(project);
    const history = createHistory(workspace);
    const plan = createPlan(project);
    const job = createCompletedJob(plan);
    const first = settleStableAudio3TextToAudioJob(history, plan, job, {
      historyLimit: 80,
    });

    if (!first.settled || first.status !== 'SETTLED') {
      throw new Error('Expected first SA3 T2A settlement to succeed.');
    }

    const repeated = settleStableAudio3TextToAudioJob(
      first.history,
      plan,
      job,
      { historyLimit: 80 },
    );

    expect(repeated).toMatchObject({
      settled: true,
      status: 'ALREADY_SETTLED',
    });
    expect(repeated.history).toBe(first.history);
    expect(repeated.workspace).toBe(first.workspace);
    expect(repeated.workspace.project.tracks).toHaveLength(1);
    expect(repeated.workspace.project.artifacts).toHaveLength(1);

    const undone = undoSessionEdit(first.history);
    const afterUndo = settleStableAudio3TextToAudioJob(
      undone.history,
      plan,
      job,
      { historyLimit: 80 },
    );

    expect(afterUndo).toMatchObject({
      cause: 'stable-audio-3-t2a-settlement-edit-conflict',
      reason: 'command-invalid',
      settled: false,
    });
    expect(afterUndo.history).toBe(undone.history);
    expect(afterUndo.workspace).toBe(workspace);
  });
});

function createPlan(
  project: ProjectState,
  seed = 17,
): StableAudio3TextToAudioJobPlan {
  const resolution = resolveStableAudio3TextToAudioCapability(
    project,
    {
      execution: {
        modelId: 'stable-audio-3-medium',
        modelRevision: MODEL_REVISION,
        providerId: 'local-stable-audio-3',
        taskId: 'text-to-audio',
      },
      output: {
        bars: 8,
        createdAt: '2026-08-06T01:00:00.000Z',
        generationPosition: 'playhead',
        outputClipId: 'sa3-t2a-clip-1',
        outputClipName: 'SA3 T2A Clip',
        outputTrackId: 'sa3-t2a-track-1',
        outputTrackName: 'SA3 T2A',
      },
      prompt: 'Warm analog synths with a patient cinematic build',
      seed,
    },
    {
      model: {
        compatibility: 'PARTIAL_SUPPORT',
        modelId: 'stable-audio-3-medium',
        revision: MODEL_REVISION,
      },
      providerId: 'local-stable-audio-3',
      providerVersion: '0.1.0',
      runtime: {
        compatibility: 'COMPATIBLE',
        profileId: RUNTIME_PROFILE,
      },
      supportsCancellation: true,
      taskId: 'text-to-audio',
    },
  );

  if (!resolution.canEnqueue) {
    throw new Error(resolution.message);
  }

  return resolution.plan;
}

function createCompletedJob(
  plan: StableAudio3TextToAudioJobPlan,
  suffix = '',
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-06T01:00:00.000Z';
  const finishedAt = '2026-08-06T01:00:16.000Z';
  const identitySuffix = suffix ? `-${suffix}` : '';
  const artifactId = `artifact-stable-audio-3-t2a${identitySuffix}`;

  return {
    attempt: 1,
    createdAt,
    finishedAt,
    history: [
      { attempt: 1, at: createdAt, state: 'QUEUED' },
      { attempt: 1, at: createdAt, state: 'LOADING_MODEL' },
      { attempt: 1, at: createdAt, state: 'PROCESSING' },
      { attempt: 1, at: finishedAt, state: 'SAVING' },
      { attempt: 1, at: finishedAt, state: 'COMPLETED' },
    ],
    jobId: `job-stable-audio-3-t2a${identitySuffix}`,
    modelId: plan.request.modelId,
    modelRevision: plan.request.modelRevision,
    providerId: plan.request.providerId,
    request: plan.request,
    result: {
      artifact: {
        artifactId,
        createdAt: finishedAt,
        destination: 'stable-audio-3',
        file: {
          extension: '.wav',
          name: `${artifactId}.wav`,
          relativePath: `renders/stable-audio-3/${artifactId}.wav`,
          sizeBytes: 2_822_444,
        },
        kind: 'audio',
        lineage: plan.request.lineage,
        provenance: {
          modelId: plan.request.modelId,
          modelRevision: plan.request.modelRevision,
          parameters: plan.request.parameters,
          providerId: plan.request.providerId,
          seed: plan.request.parameters.seed,
          taskId: plan.request.taskId,
        },
      },
      generation: {
        bytesWritten: 2_822_444,
        channels: 2,
        durationSeconds: plan.request.parameters.durationSeconds,
        mimeType: 'audio/wav',
        providerCompletedAt: finishedAt,
      },
    },
    startedAt: createdAt,
    state: 'COMPLETED',
    taskId: plan.request.taskId,
    updatedAt: finishedAt,
  };
}

function createHistory(
  workspace: TestWorkspace,
): SessionEditHistory<TestWorkspace> {
  return createSessionEditHistory(workspace, {
    category: 'system',
    createdAt: '2026-08-06T00:59:00.000Z',
    id: 'edit-initial',
    label: 'Initial workspace',
  });
}

function createWorkspace(project: ProjectState): TestWorkspace {
  return {
    panel: 'timeline',
    project,
    selectedClipId: '',
  };
}

function createProject(): ProjectState {
  return {
    artifacts: [],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'SA3 T2A Settlement Test',
    patchTabs: [],
    playheadTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 2,
    recordingSettings: {
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: '',
    selection: { items: [] },
    status: 'READY',
    tabFlowLines: [],
    tabFlowStageResults: [],
    takes: [],
    totalTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 16,
    tracks: [],
  };
}
