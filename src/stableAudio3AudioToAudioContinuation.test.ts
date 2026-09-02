import { describe, expect, it } from 'vitest';

import type { LocalEngineStableAudio3JobRequest } from './localEngineClient';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import { runStableAudio3AudioToAudioBatch } from './stableAudio3AudioToAudioBatch';
import { createStableAudio3A2APatchTabTemplate } from './stableAudio3PatchTab';
import { resolveStableAudio3AudioToAudioContinuation } from './stableAudio3AudioToAudioContinuation';
import type { StableAudio3StageDispatch } from './stableAudio3StageAdapter';
import type {
  PatchTab,
  ProjectMixdownAudioArtifact,
  ProjectMixdownAudioClipTake,
  ProjectState,
} from './types';

const MODEL_REVISION = '27b5a21b791b1b033d193a9e1e3ce78493f102f9';

describe('Stable Audio 3 A2A continuation', () => {
  it('keeps one original source Take and creates consecutive Seed variants in its Clip', () => {
    const patchTab = createStableAudio3A2APatchTabTemplate();
    const project = createProject(patchTab, false);
    const resolution = resolveStableAudio3AudioToAudioContinuation(
      project,
      patchTab,
      createDispatch('clip-take-source', 20, 3),
    );

    expect(resolution).toMatchObject({
      ok: true,
      plan: {
        outputTarget: { clipId: 'clip-source', kind: 'existing' },
        seedSequence: [20, 21, 22],
        sourceClipId: 'clip-source',
        sourceClipTakeId: 'clip-take-source',
      },
    });
  });

  it('blocks a Seed already present in the tracked A2A output Clip', () => {
    const basePatchTab = createStableAudio3A2APatchTabTemplate();
    const baseProject = createProject(basePatchTab, true);
    const first = resolveStableAudio3AudioToAudioContinuation(
      baseProject,
      basePatchTab,
      createDispatch('clip-take-source', 20, 1),
    );

    if (!first.ok) {
      throw new Error(first.message);
    }

    const patchTab: PatchTab = {
      ...basePatchTab,
      generationContinuation: {
        kind: 'stable-audio-3-audio-to-audio',
        outputClipId: 'clip-source',
        recipeFingerprint: first.plan.recipeFingerprint,
        sourceClipId: 'clip-source',
        sourceClipTakeId: 'clip-take-source',
      },
    };
    const project = {
      ...baseProject,
      patchTabs: [patchTab],
    };
    const resolution = resolveStableAudio3AudioToAudioContinuation(
      project,
      patchTab,
      createDispatch('clip-take-source', 7, 1),
    );

    expect(resolution).toMatchObject({
      cause: 'stable-audio-3-a2a-seed-duplicate',
      ok: false,
    });
  });

  it('creates a new branch Track when a generated A2A Take becomes the source', () => {
    const patchTab = createStableAudio3A2APatchTabTemplate();
    const project = createProject(patchTab, true, 'clip-take-sa3');
    const resolution = resolveStableAudio3AudioToAudioContinuation(
      project,
      patchTab,
      createDispatch('clip-take-sa3', 30, 1),
    );

    expect(resolution).toMatchObject({
      ok: true,
      plan: {
        outputTarget: {
          clipId: 'sa3-a2a-clip-attempt-a2a-test',
          kind: 'new',
          trackId: 'sa3-a2a-track-attempt-a2a-test',
        },
        sourceClipTakeId: 'clip-take-sa3',
      },
    });
  });

  it('materializes a nested A2A source as a new Generated Audio Track', async () => {
    const patchTab = createStableAudio3A2APatchTabTemplate();
    const project = createProject(patchTab, true, 'clip-take-sa3');
    const dispatch = createDispatch('clip-take-sa3', 30, 1);
    const continuation = resolveStableAudio3AudioToAudioContinuation(
      project,
      patchTab,
      dispatch,
    );

    if (!continuation.ok) {
      throw new Error(continuation.message);
    }

    let request: LocalEngineStableAudio3JobRequest | undefined;
    const client = {
      cancelJob: async () => {
        throw new Error('Cancellation was not expected.');
      },
      enqueueStableAudio3Job: async (
        nextRequest: LocalEngineStableAudio3JobRequest,
      ) => {
        request = nextRequest;
        return {
          job: createStableAudio3Job(nextRequest, 'QUEUED'),
          ok: true as const,
        };
      },
      getJobs: async () => ({
        ok: true as const,
        snapshot: {
          acceptingJobs: true,
          jobs: request
            ? [createStableAudio3Job(request, 'COMPLETED')]
            : [],
        },
      }),
      removeQueuedJob: async () => {
        throw new Error('Queued removal was not expected.');
      },
    };
    const result = await runStableAudio3AudioToAudioBatch(
      client,
      project,
      dispatch,
      continuation.plan,
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
          profileId: 'windows-target-verified-test',
        },
        supportsCancellation: true,
        taskId: 'audio-to-audio',
      },
      {
        resultId: 'result-a2a-branch',
        runner: { wait: async () => undefined },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      outputClipId: 'sa3-a2a-clip-attempt-a2a-test',
      project: {
        patchTabs: [
          {
            generationContinuation: {
              kind: 'stable-audio-3-audio-to-audio',
              outputClipId: 'sa3-a2a-clip-attempt-a2a-test',
              sourceClipTakeId: 'clip-take-sa3',
            },
          },
        ],
      },
      result: {
        outputArtifactIds: ['artifact-a2a-seed-30'],
        outputClipTakeIds: ['clip-take-artifact-a2a-seed-30'],
      },
      status: 'STAGE_COMPLETED',
    });

    if (result.ok) {
      expect(
        result.project.tracks.find(
          (track) => track.id === 'sa3-a2a-track-attempt-a2a-test',
        ),
      ).toMatchObject({
        clips: [
          {
            activeClipTakeId: 'clip-take-artifact-a2a-seed-30',
            id: 'sa3-a2a-clip-attempt-a2a-test',
            sourceClipId: 'clip-source',
          },
        ],
        type: 'generated_audio',
      });
    }
  });

  it('reserves a derived Master output for a Raw Mixdown source', () => {
    const patchTab = createStableAudio3A2APatchTabTemplate();
    const project = createRawMixdownProject(patchTab);
    const resolution = resolveStableAudio3AudioToAudioContinuation(
      project,
      patchTab,
      createRawMixdownDispatch(40),
    );

    expect(resolution).toMatchObject({
      ok: true,
      plan: {
        outputTarget: {
          clipId: 'sa3-master-clip-attempt-sa3-master-test',
          kind: 'new',
          trackId: 'sa3-master-track-attempt-sa3-master-test',
        },
        sourceClipId: 'clip-source',
        sourceClipTakeId: 'clip-take-raw-mix',
      },
    });
  });

  it('registers Raw Mixdown processing on one new muted Master Track without changing the source', async () => {
    const patchTab = createStableAudio3A2APatchTabTemplate();
    const project = createRawMixdownProject(patchTab);
    const sourceSnapshot = structuredClone(project);
    const dispatch = createRawMixdownDispatch(40);
    const continuation = resolveStableAudio3AudioToAudioContinuation(
      project,
      patchTab,
      dispatch,
    );

    if (!continuation.ok) {
      throw new Error(continuation.message);
    }

    const result = await runStableAudio3AudioToAudioBatch(
      createRunnerClient(),
      project,
      dispatch,
      continuation.plan,
      createRuntimeProfile(),
      {
        resultId: 'result-sa3-master',
        runner: { wait: async () => undefined },
      },
    );

    expect(project).toEqual(sourceSnapshot);
    expect(result).toMatchObject({
      ok: true,
      outputClipId: 'sa3-master-clip-attempt-sa3-master-test',
      project: {
        patchTabs: [
          {
            generationContinuation: {
              outputClipId: 'sa3-master-clip-attempt-sa3-master-test',
              sourceClipId: 'clip-source',
              sourceClipTakeId: 'clip-take-raw-mix',
            },
          },
        ],
      },
      result: {
        outputArtifactIds: ['artifact-a2a-seed-40'],
        outputClipTakeIds: ['clip-take-artifact-a2a-seed-40'],
      },
      status: 'STAGE_COMPLETED',
    });

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.project.tracks[0]).toEqual(project.tracks[0]);
    expect(
      result.project.tracks.find(
        (track) => track.id === 'sa3-master-track-attempt-sa3-master-test',
      ),
    ).toMatchObject({
      clips: [
        {
          activeClipTakeId: 'clip-take-artifact-a2a-seed-40',
          id: 'sa3-master-clip-attempt-sa3-master-test',
          sourceClipId: 'clip-source',
          type: 'master',
        },
      ],
      level: 0,
      muted: true,
      name: 'SA3 Master',
      type: 'audio',
    });
    expect(result.artifacts[0]).toMatchObject({
      lineage: {
        parentArtifactIds: ['artifact-raw-mix'],
        parentClipTakeIds: ['clip-take-raw-mix'],
      },
    });

    const rememberedPatchTab = result.project.patchTabs[0];
    const repeated = resolveStableAudio3AudioToAudioContinuation(
      result.project,
      rememberedPatchTab,
      createRawMixdownDispatch(41),
    );
    expect(repeated).toMatchObject({
      ok: true,
      plan: {
        outputTarget: {
          clipId: 'sa3-master-clip-attempt-sa3-master-test',
          kind: 'existing',
        },
      },
    });
  });

  it('rejects a Master output identity collision before enqueueing a Job', async () => {
    const patchTab = createStableAudio3A2APatchTabTemplate();
    const project = createRawMixdownProject(patchTab);
    const dispatch = createRawMixdownDispatch(40);
    const continuation = resolveStableAudio3AudioToAudioContinuation(
      project,
      patchTab,
      dispatch,
    );

    if (!continuation.ok) {
      throw new Error(continuation.message);
    }

    const collidingProject: ProjectState = {
      ...project,
      tracks: [
        ...project.tracks,
        {
          clips: [],
          id: 'sa3-master-track-attempt-sa3-master-test',
          level: 0,
          name: 'Collision',
          type: 'audio',
        },
      ],
    };
    let enqueueCount = 0;
    const result = await runStableAudio3AudioToAudioBatch(
      {
        cancelJob: async () => {
          throw new Error('Cancellation was not expected.');
        },
        enqueueStableAudio3Job: async () => {
          enqueueCount += 1;
          throw new Error('Job enqueue must not occur after an identity collision.');
        },
        getJobs: async () => ({
          ok: true as const,
          snapshot: { acceptingJobs: true, jobs: [] },
        }),
        removeQueuedJob: async () => {
          throw new Error('Queue removal was not expected.');
        },
      },
      collidingProject,
      dispatch,
      continuation.plan,
      createRuntimeProfile(),
      { resultId: 'result-sa3-master-collision' },
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-a2a-branch-identity-conflict',
      ok: false,
      reason: 'branch-invalid',
      status: 'STAGE_FAILED',
    });
    expect(enqueueCount).toBe(0);
  });
});

function createStableAudio3Job(
  request: LocalEngineStableAudio3JobRequest,
  state: 'COMPLETED' | 'QUEUED',
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-06T07:00:01.000Z';
  const finishedAt = '2026-08-06T07:00:12.000Z';
  const artifactId = `artifact-a2a-seed-${request.parameters.seed}`;
  const base = {
    attempt: 1,
    createdAt,
    history: [{ attempt: 1, at: createdAt, state: 'QUEUED' as const }],
    jobId: `job-a2a-seed-${request.parameters.seed}`,
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    providerId: request.providerId,
    request,
    startedAt: createdAt,
    taskId: request.taskId,
    updatedAt: state === 'COMPLETED' ? finishedAt : createdAt,
  };

  if (state === 'QUEUED') {
    return { ...base, state };
  }

  return {
    ...base,
    finishedAt,
    history: [
      ...base.history,
      { attempt: 1, at: finishedAt, state: 'COMPLETED' },
    ],
    result: {
      artifact: {
        artifactId,
        createdAt: finishedAt,
        destination: 'stable-audio-3',
        file: {
          extension: '.wav',
          name: `${artifactId}.wav`,
          relativePath: `renders/stable-audio-3/${artifactId}.wav`,
          sizeBytes: 2000,
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
        bytesWritten: 2000,
        channels: 2,
        durationSeconds: request.parameters.durationSeconds,
        mimeType: 'audio/wav',
        providerCompletedAt: finishedAt,
      },
    },
    state,
  };
}

function createDispatch(
  sourceClipTakeId: string,
  seed: number,
  takes: number,
): StableAudio3StageDispatch {
  return {
    attemptId: 'attempt-a2a-test',
    execution: {
      modelId: 'stable-audio-3-medium',
      modelRevision: MODEL_REVISION,
      providerId: 'local-stable-audio-3',
      taskId: 'audio-to-audio',
    },
    fingerprint: 'fingerprint-a2a-test',
    parameters: {
      durationSeconds: 12,
      prompt: 'Warm electric bass with a tight pocket',
      seed,
      strength: 0.4,
      takes,
    },
    runId: 'run-a2a-test',
    scope: {
      familyId: 'family-root',
      familyRevision: 1,
      stageId: 'stable-audio-3-a2a',
      targetClipId: 'clip-source',
    },
    source: {
      artifactId:
        sourceClipTakeId === 'clip-take-sa3'
          ? 'artifact-sa3'
          : 'artifact-source',
      clipId: 'clip-source',
      clipTakeId: sourceClipTakeId,
    },
    startedAt: '2026-08-06T07:00:00.000Z',
  };
}

function createRawMixdownDispatch(seed: number): StableAudio3StageDispatch {
  return {
    ...createDispatch('clip-take-raw-mix', seed, 1),
    attemptId: 'attempt-sa3-master-test',
    source: {
      artifactId: 'artifact-raw-mix',
      clipId: 'clip-source',
      clipTakeId: 'clip-take-raw-mix',
    },
  };
}

function createRuntimeProfile() {
  return {
    model: {
      compatibility: 'PARTIAL_SUPPORT' as const,
      modelId: 'stable-audio-3-medium',
      revision: MODEL_REVISION,
    },
    providerId: 'local-stable-audio-3',
    providerVersion: '0.1.0',
    runtime: {
      compatibility: 'COMPATIBLE' as const,
      profileId: 'windows-target-verified-test',
    },
    supportsCancellation: true,
    taskId: 'audio-to-audio',
  };
}

function createRunnerClient() {
  let request: LocalEngineStableAudio3JobRequest | undefined;
  return {
    cancelJob: async () => {
      throw new Error('Cancellation was not expected.');
    },
    enqueueStableAudio3Job: async (
      nextRequest: LocalEngineStableAudio3JobRequest,
    ) => {
      request = nextRequest;
      return {
        job: createStableAudio3Job(nextRequest, 'QUEUED'),
        ok: true as const,
      };
    },
    getJobs: async () => ({
      ok: true as const,
      snapshot: {
        acceptingJobs: true,
        jobs: request ? [createStableAudio3Job(request, 'COMPLETED')] : [],
      },
    }),
    removeQueuedJob: async () => {
      throw new Error('Queued removal was not expected.');
    },
  };
}

function createRawMixdownProject(patchTab: PatchTab): ProjectState {
  const artifact: ProjectMixdownAudioArtifact = {
    artifactId: 'artifact-raw-mix',
    audio: {
      bitsPerSample: 16,
      channels: 2,
      durationSeconds: 12,
      frameCount: 529_200,
      mimeType: 'audio/wav',
      sampleRate: 44_100,
    },
    createdAt: '2026-08-06T06:00:00.000Z',
    destination: 'mixdown',
    file: {
      extension: '.wav',
      name: 'artifact-raw-mix.wav',
      relativePath: 'mixdowns/artifact-raw-mix.wav',
      sizeBytes: 2_116_844,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-source-a'],
      parentClipTakeIds: ['clip-take-source-a'],
    },
    mixdownProvenance: {
      canonicalPlanJson: '{"purpose":"mixdown"}',
      inputClipIds: ['clip-a'],
      inputSourceIds: ['source-a'],
      inputTrackIds: ['track-a'],
      operationProtocolVersion: '2',
      planVersion: 3,
      rendererId: 'humstudio-project-pcm-mixdown',
      rendererVersion: '3',
      schemaVersion: 2,
    },
    sourceOperationId: 'mixdown-operation-source',
  };
  const clipTake: ProjectMixdownAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-raw-mix',
    createdAt: artifact.createdAt,
    label: 'Raw Mix 01',
    mediaType: 'audio',
    sourceOperationId: artifact.sourceOperationId,
    sourceType: 'mixdown',
  };
  return {
    ...createProject(patchTab, false),
    artifacts: [artifact],
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: clipTake.clipTakeId,
            audioTiming: {
              sourceEndSeconds: 12,
              sourceStartSeconds: 0,
              timeBase: 'absolute-seconds',
            },
            clipTakes: [clipTake],
            color: '#d8b25c',
            createdAt: artifact.createdAt,
            id: 'clip-source',
            lengthTicks: 3840,
            name: 'Raw Mix 01',
            startTick: 0,
            type: 'mixdown',
            version: 1,
          },
        ],
        id: 'track-raw-mix',
        level: 0,
        muted: true,
        name: 'Raw Mix 01',
        type: 'audio',
      },
    ],
  };
}

function createProject(
  patchTab: PatchTab,
  includeA2A: boolean,
  activeClipTakeId = 'clip-take-source',
): ProjectState {
  const sourceArtifact = {
    artifactId: 'artifact-source',
    audio: {
      channels: 2,
      durationSeconds: 12,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-06T06:00:00.000Z',
    destination: 'instrument' as const,
    file: {
      extension: '.wav',
      name: 'artifact-source.wav',
      relativePath: 'renders/instruments/artifact-source.wav',
      sizeBytes: 1000,
    },
    kind: 'audio' as const,
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'fluidsynth',
      modelRevision: '1',
      parameters: {},
      providerId: 'local-fluidsynth',
      taskId: 'instrument-render',
    },
    sourceJobId: 'job-source',
  };
  const a2aArtifact = {
    ...sourceArtifact,
    artifactId: 'artifact-sa3',
    destination: 'stable-audio-3' as const,
    file: {
      ...sourceArtifact.file,
      name: 'artifact-sa3.wav',
      relativePath: 'renders/stable-audio-3/artifact-sa3.wav',
    },
    lineage: {
      parentArtifactIds: ['artifact-source'],
      parentClipTakeIds: ['clip-take-source'],
    },
    provenance: {
      modelId: 'stable-audio-3-medium',
      modelRevision: MODEL_REVISION,
      parameters: { seed: 7 },
      providerId: 'local-stable-audio-3',
      seed: 7,
      taskId: 'audio-to-audio',
    },
    sourceJobId: 'job-sa3',
  };

  return {
    artifacts: includeA2A ? [sourceArtifact, a2aArtifact] : [sourceArtifact],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'A2A Continuation Test',
    patchTabs: [patchTab],
    playheadTick: 0,
    recordingSettings: {
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: patchTab.id,
    selection: { items: [] },
    status: 'READY',
    tabFlowLines: [],
    tabFlowStageResults: [],
    takes: [],
    totalTicks: 16 * 480,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId,
            clipTakes: [
              {
                artifactId: 'artifact-source',
                clipTakeId: 'clip-take-source',
                createdAt: '2026-08-06T06:00:00.000Z',
                label: 'Source Take',
                mediaType: 'audio',
                sourceJobId: 'job-source',
                sourceType: 'job',
              },
              ...(includeA2A
                ? [
                    {
                      artifactId: 'artifact-sa3',
                      clipTakeId: 'clip-take-sa3',
                      createdAt: '2026-08-06T06:05:00.000Z',
                      label: 'SA3 A2A Take 01',
                      mediaType: 'audio' as const,
                      sourceJobId: 'job-sa3',
                      sourceType: 'job' as const,
                    },
                  ]
                : []),
            ],
            color: '#44aaff',
            createdAt: '2026-08-06T06:00:00.000Z',
            id: 'clip-source',
            lengthTicks: 3840,
            name: 'Instrument Audio',
            startTick: 0,
            type: 'instrument-audio',
            version: 2,
          },
        ],
        id: 'track-source',
        level: -6,
        name: 'Instrument Audio',
        type: 'generated_audio',
      },
    ],
  };
}
