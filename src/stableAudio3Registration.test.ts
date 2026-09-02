import { describe, expect, it } from 'vitest';

import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import {
  createStableAudio3JobRequest,
  type StableAudio3JobRequest,
} from './stableAudio3JobContract';
import { createStableAudio3Registration } from './stableAudio3Registration';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';

const MODEL_REVISION = 'a'.repeat(40);

describe('createStableAudio3Registration', () => {
  it('registers one finalized SA3 Instrument Take from the current Active Audio Take', () => {
    const project = createProject('instrument');
    const request = createRequest(project, 'clip-source');
    const job = createCompletedJob(request);
    const registration = createStableAudio3Registration(project, job, {
      label: 'SA3 Instrument Take 01',
      sourceClipId: 'clip-source',
      targetClipId: 'clip-source',
    });

    expect(registration).toMatchObject({
      artifact: {
        audio: {
          channels: 2,
          mimeType: 'audio/wav',
        },
        destination: 'stable-audio-3',
        lineage: {
          parentArtifactIds: ['artifact-source'],
          parentClipTakeIds: ['clip-take-source'],
        },
        provenance: {
          modelId: 'stable-audio-3-medium',
          providerId: 'local-stable-audio-3',
          taskId: 'audio-to-audio',
        },
      },
      canRegister: true,
      clipTake: {
        label: 'SA3 Instrument Take 01',
        mediaType: 'audio',
        sourceJobId: 'job-stable-audio-3',
        sourceType: 'job',
      },
      status: 'REGISTERED',
    });

    if (!registration.canRegister) {
      throw new Error(registration.message);
    }

    const target = findClip(registration.project, 'clip-source');
    expect(registration.project).not.toBe(project);
    expect(registration.project.artifacts).toHaveLength(2);
    expect(target.clipTakes).toHaveLength(2);
    expect(target.activeClipTakeId).toBe(registration.clipTake.clipTakeId);
    expect(findClip(project, 'clip-source').clipTakes).toHaveLength(1);
  });

  it('is idempotent even when the SA3 output becomes Active on the source Clip', () => {
    const project = createProject('instrument');
    const job = createCompletedJob(createRequest(project, 'clip-source'));
    const first = createStableAudio3Registration(project, job, {
      sourceClipId: 'clip-source',
      targetClipId: 'clip-source',
    });

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const repeated = createStableAudio3Registration(first.project, job, {
      label: 'Ignored Repeat Label',
      sourceClipId: 'clip-source',
      targetClipId: 'clip-source',
    });

    expect(repeated).toMatchObject({
      canRegister: true,
      status: 'ALREADY_REGISTERED',
    });

    if (!repeated.canRegister) {
      throw new Error(repeated.message);
    }

    expect(repeated.project).toBe(first.project);
    expect(repeated.artifact).toBe(first.artifact);
    expect(repeated.clipTake).toBe(first.clipTake);
  });

  it('registers Raw Mixdown processing only as a derived Master Take', () => {
    const project = createProject('master');
    const request = createRequest(project, 'clip-source');
    const registration = createStableAudio3Registration(
      project,
      createCompletedJob(request),
      {
        sourceClipId: 'clip-source',
        targetClipId: 'clip-master',
      },
    );

    expect(registration).toMatchObject({
      artifact: {
        destination: 'stable-audio-3',
        lineage: {
          parentArtifactIds: ['artifact-source'],
          parentClipTakeIds: ['clip-take-source'],
        },
      },
      canRegister: true,
      status: 'REGISTERED',
    });

    if (!registration.canRegister) {
      throw new Error(registration.message);
    }

    expect(findClip(registration.project, 'clip-master')).toMatchObject({
      activeClipTakeId: registration.clipTake.clipTakeId,
      sourceClipId: 'clip-source',
      type: 'master',
    });
  });

  it('rejects a stale Job after the source Active Audio Take changes', () => {
    const project = createProject('instrument');
    const job = createCompletedJob(createRequest(project, 'clip-source'));
    const replacementArtifact = createSourceArtifact('instrument', {
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

    expect(
      createStableAudio3Registration(project, job, {
        sourceClipId: 'clip-source',
        targetClipId: 'clip-source',
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'job-contract-invalid',
    });
  });

  it('rejects unsupported target roles and mismatched Master derivation', () => {
    const instrumentProject = createProject('instrument');
    const instrumentJob = createCompletedJob(
      createRequest(instrumentProject, 'clip-source'),
    );
    findClip(instrumentProject, 'clip-source').type = 'arrangement';

    expect(
      createStableAudio3Registration(instrumentProject, instrumentJob, {
        sourceClipId: 'clip-source',
        targetClipId: 'clip-source',
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'target-role-invalid',
    });

    const masterProject = createProject('master');
    const masterJob = createCompletedJob(
      createRequest(masterProject, 'clip-source'),
    );
    findClip(masterProject, 'clip-master').sourceClipId = 'clip-other';

    expect(
      createStableAudio3Registration(masterProject, masterJob, {
        sourceClipId: 'clip-source',
        targetClipId: 'clip-master',
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'target-source-mismatch',
    });
  });

  it('rejects non-finalized or malformed Stable Audio 3 output', () => {
    const project = createProject('instrument');
    const request = createRequest(project, 'clip-source');
    const incomplete = {
      ...createCompletedJob(request),
      finishedAt: undefined,
      result: undefined,
      state: 'PROCESSING' as const,
    };

    expect(
      createStableAudio3Registration(project, incomplete, {
        sourceClipId: 'clip-source',
        targetClipId: 'clip-source',
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'job-not-completed',
    });

    const malformed = createCompletedJob(request);
    const result = malformed.result as Record<string, unknown>;
    const artifact = result.artifact as Record<string, unknown>;
    const file = artifact.file as Record<string, unknown>;
    const malformedJob = {
      ...malformed,
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

    expect(
      createStableAudio3Registration(project, malformedJob, {
        sourceClipId: 'clip-source',
        targetClipId: 'clip-source',
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'job-result-invalid',
    });
  });
});

function createRequest(
  project: ProjectState,
  sourceClipId: string,
): StableAudio3JobRequest {
  const source = resolveActiveAudioTakeSource(project, sourceClipId);

  if (!source.canResolve) {
    throw new Error(source.message);
  }

  return createStableAudio3JobRequest({
    durationSeconds: 12,
    modelId: 'stable-audio-3-medium',
    modelRevision: MODEL_REVISION,
    plan: source.plan,
    prompt: 'Warm electric bass with a tight pocket',
    providerId: 'local-stable-audio-3',
    seed: 7,
    strength: 0.4,
  });
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
          relativePath: 'renders/stable-audio-3/artifact-stable-audio-3.wav',
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

function createProject(mode: 'instrument' | 'master'): ProjectState {
  const sourceArtifact = createSourceArtifact(mode);
  const sourceTake = createSourceTake({
    artifactId: sourceArtifact.artifactId,
    clipTakeId: 'clip-take-source',
    sourceJobId: sourceArtifact.sourceJobId,
  });
  const sourceClip = {
    activeClipTakeId: sourceTake.clipTakeId,
    clipTakes: [sourceTake],
    color: '#8dff6b',
    createdAt: '2026-08-02T07:00:00.000Z',
    id: 'clip-source',
    lengthTicks: 23_040,
    name: mode === 'instrument' ? 'Instrument Audio' : 'Raw Mixdown',
    startTick: 0,
    type: mode === 'instrument' ? 'instrument-audio' as const : 'mixdown' as const,
    version: 1,
  };
  const clips = mode === 'master'
    ? [
        sourceClip,
        {
          color: '#f7c948',
          createdAt: '2026-08-02T07:01:00.000Z',
          id: 'clip-master',
          lengthTicks: 23_040,
          name: 'Master',
          sourceClipId: 'clip-source',
          startTick: 0,
          type: 'master' as const,
          version: 1,
        },
      ]
    : [sourceClip];

  return {
    artifacts: [sourceArtifact],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'Stable Audio 3 Registration Test',
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
        clips,
        id: 'track-audio',
        level: -6,
        name: 'Audio',
        type: 'audio',
      },
    ],
  };
}

function createSourceArtifact(
  mode: 'instrument' | 'master',
  overrides: Partial<{
    artifactId: string;
    name: string;
    relativePath: string;
    sourceJobId: string;
  }> = {},
): GeneratedAudioArtifact {
  const artifactId = overrides.artifactId ?? 'artifact-source';
  const name = overrides.name ?? `${artifactId}.wav`;
  const destination = mode === 'instrument' ? 'instrument' as const : 'mixdown' as const;
  const relativePath = overrides.relativePath ?? (
    mode === 'instrument'
      ? `renders/instruments/${name}`
      : `mixdowns/${name}`
  );

  return {
    artifactId,
    audio: {
      channels: 2,
      durationSeconds: 12,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-02T07:00:00.000Z',
    destination,
    file: {
      extension: '.wav',
      name,
      relativePath,
      sizeBytes: 2_116_844,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    provenance: {
      modelId: mode === 'instrument' ? 'soundfont-model' : 'mixdown-renderer',
      modelRevision: '1',
      parameters: {},
      providerId: mode === 'instrument' ? 'local-fluidsynth' : 'local-mixdown',
      taskId: mode === 'instrument' ? 'midi-to-audio' : 'mixdown',
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
