import { describe, expect, it } from 'vitest';

import type { AceStepJobRequest } from './aceStepJobContract';
import type {
  LocalEngineGpuJobRecord,
  LocalEngineStableAudio3JobRequest,
} from './localEngineClient';
import {
  resolveOneShotGenerationFamily,
  runOneShotGeneration,
} from './oneShotGeneration';
import { tabFlowPresets } from './presets';
import type { ProjectState } from './types';

const CREATED_AT = '2026-08-17T04:00:00.000Z';
const FINISHED_AT = '2026-08-17T04:00:08.000Z';
const LYRICS_ID = 'artifact-12345678-1234-4abc-8def-1234567890ab';

describe('runOneShotGeneration', () => {
  it('runs T2A then ACE once and returns aligned backing and vocal Tracks', async () => {
    const project = createReadyProject();
    const client = new FakeOneShotClient();
    const progress: string[] = [];

    const result = await runOneShotGeneration(client, project, {
      getCurrentProject: () => project,
      historyLimit: 32,
      identity: createIdentity(),
      onProgress: ({ stageId }) => progress.push(stageId),
      verifyGeneratedAudio: async (_currentProject, artifact) => ({
        availableArtifactIds: [artifact.artifactId],
        checkedAt: FINISHED_AT,
      }),
    });

    expect(result, result.message).toMatchObject({
      canCommit: true,
      completedStageCount: 2,
      status: 'COMPLETED',
    });
    expect(client.calls).toEqual(['T2A', 'LYRICS', 'ACE']);
    expect(client.t2aRequests).toHaveLength(1);
    expect(client.aceRequests).toHaveLength(1);
    expect(progress).toEqual(expect.arrayContaining(['SA3 T2A', 'ACE VOCALS']));

    const backing = findClip(result.project, 'sa3-t2a-clip-one-shot-test');
    const vocal = findClip(result.project, 'one-shot-test-vocal-clip');

    expect(backing).toMatchObject({
      activeClipTakeId: 'clip-take-artifact-sa3-t2a-one-shot',
      startTick: 0,
      type: 'ai-fill-audio',
    });
    expect(vocal).toMatchObject({
      activeClipTakeId: 'clip-take-artifact-ace-one-shot',
      lengthTicks: backing.lengthTicks,
      sourceClipId: backing.id,
      startTick: backing.startTick,
      type: 'vocal-audio',
    });
    expect(result.project.tracks.map(({ name }) => name)).toEqual([
      'Generated Audio',
      'Vocals',
    ]);
    expect(result.project.artifacts).toHaveLength(2);
    expect(result.project.tabFlowStageResults).toHaveLength(2);
    expect(result.project.selection.items).toEqual([
      { id: vocal.id, type: 'clip' },
    ]);
    expect(client.aceRequests[0]).toMatchObject({
      guideSource: {
        artifactId: 'artifact-sa3-t2a-one-shot',
        clipTakeId: 'clip-take-artifact-sa3-t2a-one-shot',
        kind: 'stable-audio-3-text-to-audio',
      },
      inputArtifacts: [
        {
          artifactId: 'artifact-sa3-t2a-one-shot',
          kind: 'audio',
          relativePath:
            'renders/stable-audio-3/artifact-sa3-t2a-one-shot.wav',
          sizeBytes: 2_822_444,
        },
        {
          artifactId: LYRICS_ID,
          kind: 'lyrics',
          relativePath: `renders/ace-step/lyrics/${LYRICS_ID}.txt`,
        },
      ],
      lineage: {
        parentArtifactIds: [
          'artifact-sa3-t2a-one-shot',
          LYRICS_ID,
        ],
        parentClipTakeIds: ['clip-take-artifact-sa3-t2a-one-shot'],
      },
      parameters: {
        thinking: false,
        vocalLanguage: 'ja',
      },
    });
    expect(JSON.stringify(result.project)).not.toMatch(
      /mixdown|print-mix|stem-print|final filer/i,
    );
  });

  it('preserves an explicit English one-shot Language selection', async () => {
    const project = createReadyProject();
    const acePatchTab = project.patchTabs.find(
      ({ id }) => id === 'one-shot-ace-vocals',
    );
    const language = acePatchTab?.parameters.find(
      (parameter) =>
        parameter.id === 'vocalLanguage' && parameter.kind === 'select',
    );
    const lyrics = acePatchTab?.parameters.find(
      (parameter) => parameter.id === 'lyrics' && parameter.kind === 'text',
    );

    if (!language || language.kind !== 'select' || !lyrics || lyrics.kind !== 'text') {
      throw new Error('ONE SHOT GENERATION ACE parameters are incomplete.');
    }

    language.value = 'English (en)';
    lyrics.value = 'Stay with me\nThrough the night';
    const client = new FakeOneShotClient();
    const result = await runOneShotGeneration(client, project, {
      getCurrentProject: () => project,
      historyLimit: 32,
      identity: createIdentity(),
      verifyGeneratedAudio: async (_currentProject, artifact) => ({
        availableArtifactIds: [artifact.artifactId],
        checkedAt: FINISHED_AT,
      }),
    });

    expect(result.status).toBe('COMPLETED');
    expect(client.aceRequests[0].parameters.vocalLanguage).toBe('en');
  });

  it('preserves the finalized backing and creates no Vocal placeholder when ACE fails', async () => {
    const project = createReadyProject();
    const client = new FakeOneShotClient({ failAce: true });
    const result = await runOneShotGeneration(client, project, {
      getCurrentProject: () => project,
      historyLimit: 32,
      identity: createIdentity(),
      verifyGeneratedAudio: async (_currentProject, artifact) => ({
        availableArtifactIds: [artifact.artifactId],
        checkedAt: FINISHED_AT,
      }),
    });

    expect(result).toMatchObject({
      canCommit: true,
      completedStageCount: 1,
      status: 'PARTIAL',
    });
    expect(result.project.tracks).toHaveLength(1);
    expect(result.project.tracks[0]?.clips[0]?.type).toBe('ai-fill-audio');
    expect(result.project.tracks.flatMap(({ clips }) => clips)).not.toContainEqual(
      expect.objectContaining({ type: 'vocal-audio' }),
    );
    expect(result.project.artifacts).toHaveLength(1);
  });

  it('registers nothing when T2A fails or is canceled before enqueue', async () => {
    const project = createReadyProject();
    const client = new FakeOneShotClient({ failTextToAudio: true });
    const result = await runOneShotGeneration(client, project, {
      getCurrentProject: () => project,
      historyLimit: 32,
      identity: createIdentity(),
      verifyGeneratedAudio: async () => {
        throw new Error('Availability must not run.');
      },
    });

    expect(result).toMatchObject({ canCommit: false, status: 'FAILED' });
    expect(result.project).toBe(project);
    expect(client.calls).toEqual(['T2A']);
    expect(project.tracks).toEqual([]);
    expect(project.artifacts).toEqual([]);
  });

  it('blocks a T2A duration that cannot satisfy ACE before either Job is enqueued', async () => {
    const project = createReadyProject();
    const textToAudioPatchTab = project.patchTabs.find(
      ({ id }) => id === 'one-shot-sa3-t2a',
    );
    const bars = textToAudioPatchTab?.parameters.find(
      (parameter) => parameter.id === 'bars' && parameter.kind === 'number',
    );

    if (!bars || bars.kind !== 'number') {
      throw new Error('ONE SHOT GENERATION Bars parameter is missing.');
    }

    bars.value = 4;
    const client = new FakeOneShotClient();
    const result = await runOneShotGeneration(client, project, {
      getCurrentProject: () => project,
      historyLimit: 32,
      identity: createIdentity(),
      verifyGeneratedAudio: async () => {
        throw new Error('Availability must not run.');
      },
    });

    expect(result).toMatchObject({
      canCommit: false,
      completedStageCount: 0,
      status: 'BLOCKED',
    });
    expect(result.message).toContain('10 to 600 seconds');
    expect(client.calls).toEqual([]);
  });

  it('blocks a stale Project after T2A without enqueueing ACE or allowing a stale commit', async () => {
    const project = createReadyProject();
    const changedProject = { ...project, status: 'CHANGED' };
    const client = new FakeOneShotClient();
    const result = await runOneShotGeneration(client, project, {
      getCurrentProject: () => changedProject,
      historyLimit: 32,
      identity: createIdentity(),
      verifyGeneratedAudio: async (_currentProject, artifact) => ({
        availableArtifactIds: [artifact.artifactId],
        checkedAt: FINISHED_AT,
      }),
    });

    expect(result).toMatchObject({
      canCommit: false,
      completedStageCount: 1,
      status: 'FAILED',
    });
    expect(client.calls).toEqual(['T2A']);
    expect(client.aceRequests).toEqual([]);
  });

  it('fails closed for a changed or broadened one-shot family', async () => {
    const project = createReadyProject();
    const connection = project.connections[0];
    const changedProject: ProjectState = {
      ...project,
      connections: connection
        ? [{ ...connection, toPortId: 'other-input' }]
        : [],
    };
    const client = new FakeOneShotClient();

    expect(resolveOneShotGenerationFamily(changedProject)).toMatchObject({
      canResolve: false,
    });
    const result = await runOneShotGeneration(client, changedProject, {
      getCurrentProject: () => changedProject,
      historyLimit: 32,
      identity: createIdentity(),
      verifyGeneratedAudio: async () => {
        throw new Error('Availability must not run.');
      },
    });
    expect(result).toMatchObject({ canCommit: false, status: 'BLOCKED' });
    expect(client.calls).toEqual([]);

    const broadenedProject: ProjectState = {
      ...project,
      connections: connection
        ? [
            connection,
            {
              ...connection,
              createdOrder: 1,
              id: 'one-shot-unexpected-route',
              order: 1,
            },
          ]
        : [],
    };
    expect(resolveOneShotGenerationFamily(broadenedProject)).toMatchObject({
      canResolve: false,
    });
  });
});

class FakeOneShotClient {
  readonly aceRequests: AceStepJobRequest[] = [];
  readonly calls: string[] = [];
  readonly t2aRequests: LocalEngineStableAudio3JobRequest[] = [];

  constructor(
    private readonly options: Readonly<{
      failAce?: boolean;
      failTextToAudio?: boolean;
    }> = {},
  ) {}

  async enqueueStableAudio3Job(request: LocalEngineStableAudio3JobRequest) {
    this.calls.push('T2A');
    this.t2aRequests.push(request);
    const job = createTextToAudioJob(
      request,
      this.options.failTextToAudio ? 'FAILED' : 'COMPLETED',
    );
    return { job, ok: true as const };
  }

  async saveAceStepLyrics(lyrics: string) {
    this.calls.push('LYRICS');
    return {
      lyricsSnapshot: {
        artifactId: LYRICS_ID,
        createdAt: CREATED_AT,
        destination: 'ace-step-lyrics' as const,
        file: {
          extension: '.txt' as const,
          name: `${LYRICS_ID}.txt`,
          relativePath: `renders/ace-step/lyrics/${LYRICS_ID}.txt`,
          sizeBytes: new TextEncoder().encode(lyrics).byteLength,
        },
        kind: 'lyrics' as const,
        sha256: 'a'.repeat(64),
        status: 'FINALIZED' as const,
      },
      ok: true as const,
    };
  }

  async enqueueAceStepJob(request: AceStepJobRequest) {
    this.calls.push('ACE');
    this.aceRequests.push(request);
    return {
      job: createAceJob(request, this.options.failAce ? 'FAILED' : 'COMPLETED'),
      ok: true as const,
    };
  }

  async getJobs() {
    return { ok: true as const, snapshot: { acceptingJobs: true, jobs: [] } };
  }

  async removeQueuedJob() {
    return {
      message: 'No queued Job.',
      ok: false as const,
      reason: 'http-error' as const,
      status: 404,
    };
  }

  async cancelJob() {
    return {
      message: 'No active Job.',
      ok: false as const,
      reason: 'http-error' as const,
      status: 404,
    };
  }
}

function createReadyProject(): ProjectState {
  const preset = tabFlowPresets.find(({ id }) => id === 'one-shot-generation');

  if (!preset) {
    throw new Error('ONE SHOT GENERATION preset is missing.');
  }

  const project = structuredClone(preset.project);
  const acePatchTab = project.patchTabs.find(
    ({ id }) => id === 'one-shot-ace-vocals',
  );
  const lyrics = acePatchTab?.parameters.find(
    (parameter) => parameter.id === 'lyrics' && parameter.kind === 'text',
  );

  if (!lyrics || lyrics.kind !== 'text') {
    throw new Error('ONE SHOT GENERATION Lyrics parameter is missing.');
  }

  lyrics.value = '夜を越えて\nここにいて';
  return project;
}

function createIdentity() {
  return {
    createdAt: CREATED_AT,
    operationId: 'one-shot-test',
    requestToken: 'one-shot-test',
    vocalClipId: 'one-shot-test-vocal-clip',
    vocalTrackId: 'one-shot-test-vocal-track',
  } as const;
}

function createTextToAudioJob(
  request: LocalEngineStableAudio3JobRequest,
  state: 'COMPLETED' | 'FAILED',
): LocalEngineGpuJobRecord {
  const artifactId = 'artifact-sa3-t2a-one-shot';
  return {
    attempt: 1,
    createdAt: CREATED_AT,
    finishedAt: FINISHED_AT,
    history: [
      { attempt: 1, at: CREATED_AT, state: 'QUEUED' },
      { attempt: 1, at: FINISHED_AT, state },
    ],
    jobId: 'job-sa3-t2a-one-shot',
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    providerId: request.providerId,
    request,
    ...(state === 'COMPLETED'
      ? {
          result: {
            artifact: {
              artifactId,
              createdAt: FINISHED_AT,
              destination: 'stable-audio-3',
              file: {
                extension: '.wav',
                name: `${artifactId}.wav`,
                relativePath: `renders/stable-audio-3/${artifactId}.wav`,
                sizeBytes: 2_822_444,
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
              bytesWritten: 2_822_444,
              channels: 2,
              durationSeconds: request.parameters.durationSeconds,
              mimeType: 'audio/wav',
              providerCompletedAt: FINISHED_AT,
            },
          },
        }
      : { error: { code: 'fixture-failure', message: 'T2A failed.' } }),
    startedAt: CREATED_AT,
    state,
    taskId: request.taskId,
    updatedAt: FINISHED_AT,
  };
}

function createAceJob(
  request: AceStepJobRequest,
  state: 'COMPLETED' | 'FAILED',
): LocalEngineGpuJobRecord {
  const artifactId = 'artifact-ace-one-shot';
  return {
    attempt: 1,
    createdAt: CREATED_AT,
    finishedAt: FINISHED_AT,
    history: [
      { attempt: 1, at: CREATED_AT, state: 'QUEUED' },
      { attempt: 1, at: FINISHED_AT, state },
    ],
    jobId: 'job-ace-one-shot',
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    providerId: request.providerId,
    request,
    ...(state === 'COMPLETED'
      ? {
          result: {
            artifact: {
              artifactId,
              createdAt: FINISHED_AT,
              destination: 'ace-step',
              file: {
                extension: '.wav',
                name: `${artifactId}.wav`,
                relativePath: `renders/ace-step/${artifactId}.wav`,
                sizeBytes: 3_840_088,
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
              bytesWritten: 3_840_088,
              channels: 2,
              durationSeconds: request.parameters.durationSeconds,
              mimeType: 'audio/wav',
              providerCompletedAt: FINISHED_AT,
            },
          },
        }
      : { error: { code: 'fixture-failure', message: 'ACE failed.' } }),
    startedAt: CREATED_AT,
    state,
    taskId: request.taskId,
    updatedAt: FINISHED_AT,
  };
}

function findClip(project: ProjectState, clipId: string) {
  const matches = project.tracks
    .flatMap(({ clips }) => clips)
    .filter((clip) => clip.id === clipId);

  if (matches.length !== 1) {
    throw new Error(`Expected one Clip ${clipId}.`);
  }

  return matches[0];
}
