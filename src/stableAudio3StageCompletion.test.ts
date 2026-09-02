import { describe, expect, it } from 'vitest';

import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import {
  createStableAudio3StageAdapterPlan,
  type StableAudio3StageAdapterPlan,
  type StableAudio3StageDispatch,
  type StableAudio3StageRuntimeProfile,
} from './stableAudio3StageAdapter';
import {
  completeStableAudio3StagePlan as completeStagePlan,
  type StableAudio3StageCompletedJob,
} from './stableAudio3StageCompletion';
import type { StableAudio3JobRequest } from './stableAudio3JobContract';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';

const MODEL_REVISION = 'a'.repeat(40);
const RESULT_ID = 'result-stable-audio-3';

describe('Stable Audio 3 Stage completion', () => {
  it('atomically registers one completed Job and persistent Stage Result', () => {
    const project = createProject();
    const plan = createPlan(project);
    const job = createCompletedJob(plan.request);
    const snapshot = JSON.stringify(project);
    const completion = completeStableAudio3StagePlan(project, plan, job, {
      label: 'SA3 Instrument Take 01',
      resultId: RESULT_ID,
    });

    expect(completion).toMatchObject({
      artifact: {
        artifactId: 'artifact-stable-audio-3',
        destination: 'stable-audio-3',
        sourceJobId: 'job-stable-audio-3',
      },
      clipTake: {
        artifactId: 'artifact-stable-audio-3',
        label: 'SA3 Instrument Take 01',
        mediaType: 'audio',
        sourceType: 'job',
      },
      ok: true,
      registrationStatus: 'REGISTERED',
      result: {
        fingerprint: 'fingerprint-sa3-a',
        resultId: RESULT_ID,
        state: 'COMPLETED',
      },
      status: 'COMPLETED',
    });

    if (!completion.ok) {
      throw new Error(completion.message);
    }

    expect(completion.project.artifacts).toHaveLength(2);
    expect(completion.project.tabFlowStageResults).toEqual([
      completion.result,
    ]);
    expect(findClip(completion.project, 'clip-source')).toMatchObject({
      activeClipTakeId: completion.clipTake.clipTakeId,
      clipTakes: expect.arrayContaining([completion.clipTake]),
    });
    expect(JSON.stringify(project)).toBe(snapshot);
    expect(project.artifacts).toHaveLength(1);
    expect(project.tabFlowStageResults).toBeUndefined();
  });

  it('is idempotent for the same completed Job and Stage Result', () => {
    const project = createProject();
    const plan = createPlan(project);
    const job = createCompletedJob(plan.request);
    const first = completeStableAudio3StagePlan(project, plan, job, {
      resultId: RESULT_ID,
    });

    if (!first.ok) {
      throw new Error(first.message);
    }

    const repeated = completeStableAudio3StagePlan(
      first.project,
      plan,
      job,
      { resultId: RESULT_ID },
    );

    expect(repeated).toMatchObject({
      ok: true,
      registrationStatus: 'ALREADY_REGISTERED',
      status: 'COMPLETED',
    });

    if (!repeated.ok) {
      throw new Error(repeated.message);
    }

    expect(repeated.artifact).toBe(first.artifact);
    expect(repeated.clipTake).toBe(first.clipTake);
    expect(repeated.project.artifacts).toHaveLength(2);
    expect(repeated.project.tabFlowStageResults).toHaveLength(1);
  });

  it('rejects incomplete or plan-mismatched Jobs without changing Project data', () => {
    const project = createProject();
    const plan = createPlan(project);
    const completedJob = createCompletedJob(plan.request);
    const incompleteJob = {
      ...completedJob,
      finishedAt: undefined,
      result: undefined,
      state: 'PROCESSING' as const,
    };
    const mismatchedJob = {
      ...completedJob,
      request: {
        ...completedJob.request,
        parameters: {
          ...(completedJob.request.parameters as Record<string, unknown>),
          prompt: 'Changed after dispatch',
        },
      },
    } as LocalEngineGpuJobRecord;
    const snapshot = JSON.stringify(project);

    expect(
      completeStableAudio3StagePlan(
        project,
        plan,
        incompleteJob,
        { resultId: RESULT_ID },
      ),
    ).toMatchObject({
      ok: false,
      reason: 'job-not-completed',
    });
    expect(
      completeStableAudio3StagePlan(
        project,
        plan,
        mismatchedJob,
        { resultId: RESULT_ID },
      ),
    ).toMatchObject({
      cause: 'stable-audio-3-job-plan-mismatch',
      ok: false,
      reason: 'job-identity-mismatch',
    });
    expect(
      completeStagePlan(
        project,
        plan,
        {
          ...createCompletedEnvelope(plan, completedJob),
          runId: 'run-other',
        },
        { resultId: RESULT_ID },
      ),
    ).toMatchObject({
      cause: 'stable-audio-3-stage-attempt-mismatch',
      ok: false,
      reason: 'stage-identity-mismatch',
    });
    expect(JSON.stringify(project)).toBe(snapshot);
  });

  it('rejects a stale Active source Take without retaining partial registration', () => {
    const project = createProject();
    const plan = createPlan(project);
    const job = createCompletedJob(plan.request);
    const replacementArtifact = createSourceArtifact({
      artifactId: 'artifact-source-new',
      name: 'artifact-source-new.wav',
      relativePath: 'renders/instruments/artifact-source-new.wav',
      sourceJobId: 'job-source-new',
    });
    const replacementTake = createSourceTake({
      artifactId: replacementArtifact.artifactId,
      clipTakeId: 'clip-take-source-new',
      sourceJobId: replacementArtifact.sourceJobId,
    });
    const sourceClip = findClip(project, 'clip-source');
    project.artifacts?.push(replacementArtifact);
    sourceClip.clipTakes?.push(replacementTake);
    sourceClip.activeClipTakeId = replacementTake.clipTakeId;
    const snapshot = JSON.stringify(project);
    const completion = completeStableAudio3StagePlan(
      project,
      plan,
      job,
      { resultId: RESULT_ID },
    );

    expect(completion).toMatchObject({
      ok: false,
      reason: 'registration-failed',
    });
    expect(JSON.stringify(project)).toBe(snapshot);
    expect(project.artifacts).toHaveLength(2);
    expect(
      project.artifacts?.some(
        (artifact) => artifact.artifactId === 'artifact-stable-audio-3',
      ),
    ).toBe(false);
  });

  it('rolls back registration when the persistent Stage Result conflicts', () => {
    const project = createProject();
    const plan = createPlan(project);
    const job = createCompletedJob(plan.request);
    project.tabFlowStageResults = [
      {
        fingerprint: 'conflicting-fingerprint',
        finishedAt: '2026-08-02T07:30:00.000Z',
        outputArtifactIds: ['artifact-conflict'],
        outputClipTakeIds: [],
        resultId: RESULT_ID,
        scope: { ...plan.scope },
        state: 'COMPLETED',
      },
    ];
    const snapshot = JSON.stringify(project);
    const completion = completeStableAudio3StagePlan(
      project,
      plan,
      job,
      { resultId: RESULT_ID },
    );

    expect(completion).toMatchObject({
      cause: 'stable-audio-3-stage-result-conflict',
      ok: false,
      reason: 'stage-result-failed',
    });
    expect(JSON.stringify(project)).toBe(snapshot);
    expect(project.artifacts).toHaveLength(1);
    expect(findClip(project, 'clip-source').clipTakes).toHaveLength(1);
  });

  it('rejects malformed finalized output without creating a Stage Result', () => {
    const project = createProject();
    const plan = createPlan(project);
    const job = createCompletedJob(plan.request);
    const result = job.result as Record<string, unknown>;
    const artifact = result.artifact as Record<string, unknown>;
    const file = artifact.file as Record<string, unknown>;
    const malformedJob = {
      ...job,
      result: {
        ...result,
        artifact: {
          ...artifact,
          file: {
            ...file,
            relativePath: 'renders/instruments/artifact-stable-audio-3.wav',
          },
        },
      },
    } as LocalEngineGpuJobRecord;
    const snapshot = JSON.stringify(project);
    const completion = completeStableAudio3StagePlan(
      project,
      plan,
      malformedJob,
      { resultId: RESULT_ID },
    );

    expect(completion).toMatchObject({
      ok: false,
      reason: 'registration-failed',
    });
    expect(JSON.stringify(project)).toBe(snapshot);
    expect(project.tabFlowStageResults).toBeUndefined();
  });
});

function createPlan(project: ProjectState): StableAudio3StageAdapterPlan {
  const resolution = createStableAudio3StageAdapterPlan(
    createDispatch(),
    project,
    createRuntimeProfile(),
  );

  if (!resolution.canPlan) {
    throw new Error(resolution.message);
  }

  return resolution.plan;
}

function createDispatch(): StableAudio3StageDispatch {
  return {
    attemptId: 'attempt-sa3-a',
    execution: {
      modelId: 'stable-audio-3-medium',
      modelRevision: MODEL_REVISION,
      providerId: 'local-stable-audio-3',
      taskId: 'audio-to-audio',
    },
    fingerprint: 'fingerprint-sa3-a',
    parameters: {
      durationSeconds: 12,
      prompt: 'Warm electric bass with a tight pocket',
      seed: 7,
      strength: 0.4,
      takes: 1,
    },
    runId: 'run-sa3-a',
    scope: {
      familyId: 'family-root',
      familyRevision: 3,
      stageId: 'stage-sa3-a',
      targetClipId: 'clip-source',
    },
    source: {
      artifactId: 'artifact-source',
      clipId: 'clip-source',
      clipTakeId: 'clip-take-source',
    },
    startedAt: '2026-08-02T08:00:00.000Z',
  };
}

function createRuntimeProfile(): StableAudio3StageRuntimeProfile {
  return {
    model: {
      compatibility: 'PARTIAL_SUPPORT',
      modelId: 'stable-audio-3-medium',
      revision: MODEL_REVISION,
    },
    providerId: 'local-stable-audio-3',
    providerVersion: '0.1.0',
    runtime: {
      compatibility: 'COMPATIBLE',
      profileId: 'windows-target-verified-test',
    },
    supportsCancellation: false,
    taskId: 'audio-to-audio',
  };
}

function completeStableAudio3StagePlan(
  project: ProjectState,
  plan: StableAudio3StageAdapterPlan,
  job: LocalEngineGpuJobRecord,
  options: Parameters<typeof completeStagePlan>[3],
) {
  return completeStagePlan(
    project,
    plan,
    createCompletedEnvelope(plan, job),
    options,
  );
}

function createCompletedEnvelope(
  plan: StableAudio3StageAdapterPlan,
  job: LocalEngineGpuJobRecord,
): StableAudio3StageCompletedJob {
  return {
    adapterId: plan.adapterId,
    attemptId: plan.attemptId,
    fingerprint: plan.fingerprint,
    job,
    runId: plan.runId,
    scope: { ...plan.scope },
    status: 'JOB_COMPLETED',
  };
}

function createCompletedJob(
  request: StableAudio3JobRequest,
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-02T08:00:00.000Z';
  const finishedAt = '2026-08-02T08:00:12.000Z';

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
    jobId: 'job-stable-audio-3',
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    providerId: request.providerId,
    request,
    result: {
      artifact: {
        artifactId: 'artifact-stable-audio-3',
        createdAt: finishedAt,
        destination: 'stable-audio-3',
        file: {
          extension: '.wav',
          name: 'artifact-stable-audio-3.wav',
          relativePath:
            'renders/stable-audio-3/artifact-stable-audio-3.wav',
          sizeBytes: 2_116_844,
        },
        kind: 'audio',
        lineage: request.lineage,
        provenance: {
          modelId: request.modelId,
          modelRevision: request.modelRevision,
          parameters: request.parameters,
          providerId: request.providerId,
          seed: request.parameters.seed,
          taskId: request.taskId,
        },
      },
      generation: {
        bytesWritten: 2_116_844,
        channels: 2,
        durationSeconds: 12,
        mimeType: 'audio/wav',
        providerCompletedAt: finishedAt,
      },
    },
    startedAt: createdAt,
    state: 'COMPLETED',
    taskId: request.taskId,
    updatedAt: finishedAt,
  };
}

function createProject(): ProjectState {
  const artifact = createSourceArtifact();
  const take = createSourceTake();

  return {
    artifacts: [artifact],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'Stable Audio 3 Stage Completion Test',
    patchTabs: [],
    playheadTick: 0,
    recordingSettings: {
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: '',
    selection: { items: [] },
    status: 'READY',
    takes: [],
    totalTicks: 23_040,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: take.clipTakeId,
            clipTakes: [take],
            color: '#8dff6b',
            createdAt: '2026-08-02T07:00:00.000Z',
            id: 'clip-source',
            lengthTicks: 23_040,
            name: 'Instrument Audio',
            startTick: 0,
            type: 'instrument-audio',
            version: 1,
          },
        ],
        id: 'track-audio',
        level: -6,
        name: 'Audio',
        type: 'audio',
      },
    ],
  };
}

function createSourceArtifact(
  overrides: Partial<{
    artifactId: string;
    name: string;
    relativePath: string;
    sourceJobId: string;
  }> = {},
): GeneratedAudioArtifact {
  const artifactId = overrides.artifactId ?? 'artifact-source';
  const name = overrides.name ?? `${artifactId}.wav`;

  return {
    artifactId,
    audio: {
      channels: 2,
      durationSeconds: 12,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-02T07:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name,
      relativePath:
        overrides.relativePath ?? `renders/instruments/${name}`,
      sizeBytes: 2_116_844,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    provenance: {
      modelId: 'soundfont-model',
      modelRevision: '1',
      parameters: {},
      providerId: 'local-fluidsynth',
      taskId: 'midi-to-audio',
    },
    sourceJobId: overrides.sourceJobId ?? 'job-source',
  };
}

function createSourceTake(
  overrides: Partial<GeneratedAudioClipTake> = {},
): GeneratedAudioClipTake {
  return {
    artifactId: 'artifact-source',
    clipTakeId: 'clip-take-source',
    createdAt: '2026-08-02T07:00:00.000Z',
    label: 'Source Take 01',
    mediaType: 'audio',
    sourceJobId: 'job-source',
    sourceType: 'job',
    ...overrides,
  };
}

function findClip(project: ProjectState, clipId: string) {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`Clip not found: ${clipId}.`);
  }

  return clip;
}
