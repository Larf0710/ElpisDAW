import { describe, expect, it } from 'vitest';

import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import type {
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineJobs';
import type { StableAudio3StageAdapterPlan } from './stableAudio3StageAdapter';
import { createStableAudio3JobRequest } from './stableAudio3JobContract';
import { settleStableAudio3StageJob } from './stableAudio3StageSettlement';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';

const MODEL_REVISION = 'a'.repeat(40);
const RESULT_ID = 'result-stable-audio-3-settlement';

describe('Stable Audio 3 Stage settlement', () => {
  it('settles one matching completed Job into atomic Project output', () => {
    const fixture = createFixture();
    const snapshot = JSON.stringify(fixture.project);
    const result = settleStableAudio3StageJob(
      fixture.project,
      fixture.plan,
      createJob('COMPLETED', fixture.plan),
      { label: 'SA3 Settlement Take', resultId: RESULT_ID },
    );

    expect(result).toMatchObject({
      completion: {
        artifact: {
          artifactId: 'artifact-stable-audio-3',
          destination: 'stable-audio-3',
        },
        clipTake: {
          artifactId: 'artifact-stable-audio-3',
          label: 'SA3 Settlement Take',
        },
        registrationStatus: 'REGISTERED',
      },
      ok: true,
      outcome: { status: 'JOB_COMPLETED' },
      status: 'STAGE_COMPLETED',
    });

    if (!result.ok) {
      throw new Error('Expected Stable Audio 3 Stage settlement to complete.');
    }

    expect(result.project).not.toBe(fixture.project);
    expect(result.project.artifacts).toHaveLength(2);
    expect(result.project.tabFlowStageResults).toEqual([
      result.completion.result,
    ]);
    expect(findClip(result.project, 'clip-source')).toMatchObject({
      activeClipTakeId: result.completion.clipTake.clipTakeId,
    });
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
  });

  it('returns the original Project for processing and cancel-requested Jobs', () => {
    const fixture = createFixture();

    for (const state of ['PROCESSING', 'CANCEL_REQUESTED'] as const) {
      const result = settleStableAudio3StageJob(
        fixture.project,
        fixture.plan,
        createJob(state, fixture.plan),
        { resultId: RESULT_ID },
      );

      expect(result).toMatchObject({
        ok: false,
        outcome: { jobState: state, status: 'PENDING' },
        reason: 'job-pending',
        status: 'STAGE_PENDING',
      });
      expect(result.project).toBe(fixture.project);
      expect(fixture.project.tabFlowStageResults).toBeUndefined();
    }
  });

  it('returns the original Project for canceled and failed Jobs', () => {
    const fixture = createFixture();
    const canceled = settleStableAudio3StageJob(
      fixture.project,
      fixture.plan,
      createJob('CANCELED', fixture.plan),
      { resultId: RESULT_ID },
    );
    const failed = settleStableAudio3StageJob(
      fixture.project,
      fixture.plan,
      createJob('FAILED', fixture.plan),
      { resultId: RESULT_ID },
    );

    expect(canceled).toMatchObject({
      ok: false,
      reason: 'job-canceled',
      status: 'STAGE_CANCELED',
    });
    expect(failed).toMatchObject({
      cause: 'stable-audio-3-engine-job-failed',
      ok: false,
      reason: 'job-failed',
      status: 'STAGE_FAILED',
    });
    expect(canceled.project).toBe(fixture.project);
    expect(failed.project).toBe(fixture.project);
    expect(fixture.project.artifacts).toHaveLength(1);
  });

  it('rejects mismatched Job identity before any Project update', () => {
    const fixture = createFixture();
    const job = createJob('COMPLETED', fixture.plan);
    const mismatched = {
      ...job,
      modelRevision: 'b'.repeat(40),
    } as LocalEngineGpuJobRecord;
    const result = settleStableAudio3StageJob(
      fixture.project,
      fixture.plan,
      mismatched,
      { resultId: RESULT_ID },
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-job-plan-mismatch',
      ok: false,
      reason: 'job-failed',
      status: 'STAGE_FAILED',
    });
    expect(result.project).toBe(fixture.project);
    expect(fixture.project.artifacts).toHaveLength(1);
  });

  it('rolls back completed output when registration sees a stale Active Take', () => {
    const fixture = createFixture();
    const job = createJob('COMPLETED', fixture.plan);
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
    const sourceClip = findClip(fixture.project, 'clip-source');
    fixture.project.artifacts?.push(replacementArtifact);
    sourceClip.clipTakes?.push(replacementTake);
    sourceClip.activeClipTakeId = replacementTake.clipTakeId;
    const snapshot = JSON.stringify(fixture.project);
    const result = settleStableAudio3StageJob(
      fixture.project,
      fixture.plan,
      job,
      { resultId: RESULT_ID },
    );

    expect(result).toMatchObject({
      ok: false,
      outcome: { status: 'JOB_COMPLETED' },
      reason: 'completion-failed',
      status: 'STAGE_FAILED',
    });
    expect(result.project).toBe(fixture.project);
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
    expect(
      fixture.project.artifacts?.some(
        (artifact) => artifact.artifactId === 'artifact-stable-audio-3',
      ),
    ).toBe(false);
  });

  it('settles the same completed Job idempotently without duplicate output', () => {
    const fixture = createFixture();
    const job = createJob('COMPLETED', fixture.plan);
    const first = settleStableAudio3StageJob(
      fixture.project,
      fixture.plan,
      job,
      { resultId: RESULT_ID },
    );

    if (!first.ok) {
      throw new Error('Expected first settlement to complete.');
    }

    const repeated = settleStableAudio3StageJob(
      first.project,
      fixture.plan,
      job,
      { resultId: RESULT_ID },
    );

    expect(repeated).toMatchObject({
      completion: { registrationStatus: 'ALREADY_REGISTERED' },
      ok: true,
      status: 'STAGE_COMPLETED',
    });

    if (!repeated.ok) {
      throw new Error('Expected repeated settlement to complete.');
    }

    expect(repeated.project.artifacts).toHaveLength(2);
    expect(repeated.project.tabFlowStageResults).toHaveLength(1);
  });
});

function createFixture(): Readonly<{
  plan: StableAudio3StageAdapterPlan;
  project: ProjectState;
}> {
  const project = createProject();
  const source = resolveActiveAudioTakeSource(project, 'clip-source');

  if (!source.canResolve) {
    throw new Error(source.message);
  }

  const request = createStableAudio3JobRequest({
    durationSeconds: 12,
    modelId: 'stable-audio-3-medium',
    modelRevision: MODEL_REVISION,
    plan: source.plan,
    prompt: 'Warm electric bass with a tight pocket',
    providerId: 'local-stable-audio-3',
    seed: 7,
    strength: 0.4,
  });
  const plan: StableAudio3StageAdapterPlan = Object.freeze({
    adapterId: 'local-stable-audio-3-audio-to-audio-v1',
    attemptId: 'attempt-sa3-settlement',
    fingerprint: 'fingerprint-sa3-settlement',
    kind: 'local-engine-gpu-job',
    request,
    runId: 'run-sa3-settlement',
    runtime: Object.freeze({
      modelCompatibility: 'PARTIAL_SUPPORT',
      profileId: 'windows-target-verified-test',
      providerVersion: '0.1.0',
      supportsCancellation: false,
    }),
    scope: Object.freeze({
      familyId: 'family-root',
      familyRevision: 3,
      stageId: 'stage-sa3-settlement',
      targetClipId: 'clip-source',
    }),
    sourceClipId: 'clip-source',
  });

  return { plan, project };
}

function createJob(
  state: LocalEngineGpuJobState,
  plan: StableAudio3StageAdapterPlan,
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-03T01:00:00.000Z';
  const finishedAt = '2026-08-03T01:00:12.000Z';
  const isFinished = [
    'COMPLETED',
    'CANCELED',
    'FAILED',
    'INTERRUPTED',
  ].includes(state);

  return {
    attempt: 1,
    ...(state === 'CANCEL_REQUESTED'
      ? { cancelRequestedAt: createdAt }
      : {}),
    createdAt,
    ...(state === 'FAILED'
      ? {
          error: {
            code: 'PROVIDER_EXITED',
            message: 'Provider process exited unexpectedly.',
          },
        }
      : {}),
    ...(isFinished ? { finishedAt } : {}),
    history: Object.freeze([
      Object.freeze({ attempt: 1, at: createdAt, state }),
    ]),
    jobId: 'job-stable-audio-3',
    modelId: plan.request.modelId,
    modelRevision: plan.request.modelRevision,
    providerId: plan.request.providerId,
    request: plan.request,
    ...(state === 'COMPLETED'
      ? {
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
              bytesWritten: 2_116_844,
              channels: 2,
              durationSeconds: 12,
              mimeType: 'audio/wav',
              providerCompletedAt: finishedAt,
            },
          },
        }
      : {}),
    startedAt: createdAt,
    state,
    taskId: plan.request.taskId,
    updatedAt: isFinished ? finishedAt : createdAt,
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
    name: 'Stable Audio 3 Stage Settlement Test',
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
            createdAt: '2026-08-03T00:30:00.000Z',
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
    createdAt: '2026-08-03T00:30:00.000Z',
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
    createdAt: '2026-08-03T00:30:00.000Z',
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
