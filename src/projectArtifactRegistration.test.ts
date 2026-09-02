import { describe, expect, it } from 'vitest';

import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import {
  createCompletedAudioJobRegistration,
  normalizeClipTakeState,
  normalizeProjectArtifacts,
} from './projectArtifactRegistration';
import { sampleProject } from './sampleProject';
import type { ProjectState } from './types';

describe('createCompletedAudioJobRegistration', () => {
  it('registers one finalized Artifact and activates one Clip Take immutably', () => {
    const project = cloneSampleProject();
    const originalClip = findClip(project, 'clip-inst-1');
    const update = createCompletedAudioJobRegistration(project, createCompletedJob(), {
      clipId: 'clip-inst-1',
    });

    expect(update).toMatchObject({
      artifact: {
        artifactId: 'artifact-client-test',
        audio: { channels: 1, durationSeconds: 0.1, mimeType: 'audio/wav' },
        sourceJobId: 'job-registration-test',
      },
      canRegister: true,
      clipTake: {
        artifactId: 'artifact-client-test',
        label: 'Generated Take 01',
        mediaType: 'audio',
      },
      status: 'REGISTERED',
    });

    if (!update.canRegister) {
      throw new Error(update.message);
    }

    const registeredClip = findClip(update.project, 'clip-inst-1');

    expect(update.project).not.toBe(project);
    expect(update.project.artifacts).toHaveLength(1);
    expect(registeredClip).not.toBe(originalClip);
    expect(registeredClip.clipTakes).toEqual([update.clipTake]);
    expect(registeredClip.activeClipTakeId).toBe(update.clipTake.clipTakeId);
    expect(registeredClip.sourceFile).toEqual({
      durationSeconds: update.artifact.audio.durationSeconds,
      mimeType: update.artifact.audio.mimeType,
      name: update.artifact.file.name,
      relativePath: update.artifact.file.relativePath,
      sizeBytes: update.artifact.file.sizeBytes,
      sourceId: update.artifact.artifactId,
      status: 'unresolved',
    });
    expect(registeredClip.version).toBe(originalClip.version + 1);
    expect(originalClip.clipTakes).toBeUndefined();
    expect(project.artifacts).toBeUndefined();
  });

  it('does not register failed, canceled, or incomplete Job output', () => {
    for (const state of ['FAILED', 'CANCELED', 'PROCESSING'] as const) {
      const job = { ...createCompletedJob(), state };
      const update = createCompletedAudioJobRegistration(cloneSampleProject(), job, {
        clipId: 'clip-inst-1',
      });

      expect(update).toMatchObject({
        canRegister: false,
        reason: 'job-not-completed',
      });
    }
  });

  it('rejects malformed or non-finalized Artifact metadata', () => {
    const job = createCompletedJob();
    const result = job.result as Record<string, unknown>;
    const artifact = result.artifact as Record<string, unknown>;
    const file = artifact.file as Record<string, unknown>;
    const invalidJob = {
      ...job,
      result: {
        ...result,
        artifact: {
          ...artifact,
          file: { ...file, relativePath: '../outside.wav' },
        },
      },
    } as LocalEngineGpuJobRecord;
    const update = createCompletedAudioJobRegistration(cloneSampleProject(), invalidJob, {
      clipId: 'clip-inst-1',
    });

    expect(update).toMatchObject({
      canRegister: false,
      reason: 'job-result-invalid',
    });
  });

  it('rejects completed Job output whose Artifact ID or destination does not own its WAV path', () => {
    const job = createCompletedJob();
    const result = job.result as Record<string, unknown>;
    const artifact = result.artifact as Record<string, unknown>;
    const file = artifact.file as Record<string, unknown>;
    const invalidArtifacts = [
      {
        ...artifact,
        artifactId: 'artifact-decoy',
      },
      {
        ...artifact,
        file: {
          ...file,
          relativePath: `mixdowns/${String(file.name)}`,
        },
      },
    ];

    for (const invalidArtifact of invalidArtifacts) {
      const update = createCompletedAudioJobRegistration(
        cloneSampleProject(),
        {
          ...job,
          result: {
            ...result,
            artifact: invalidArtifact,
          },
        } as LocalEngineGpuJobRecord,
        { clipId: 'clip-inst-1' },
      );

      expect(update).toMatchObject({
        canRegister: false,
        reason: 'job-result-invalid',
      });
    }
  });

  it('rejects missing and non-audio target Clips', () => {
    const job = createCompletedJob();

    expect(
      createCompletedAudioJobRegistration(cloneSampleProject(), job, {
        clipId: 'clip-missing',
      }),
    ).toMatchObject({ canRegister: false, reason: 'clip-not-found' });
    expect(
      createCompletedAudioJobRegistration(cloneSampleProject(), job, {
        clipId: 'clip-midi-1',
      }),
    ).toMatchObject({ canRegister: false, reason: 'target-not-audio' });
  });

  it('is idempotent for the same completed Job and target Clip', () => {
    const first = createCompletedAudioJobRegistration(
      cloneSampleProject(),
      createCompletedJob(),
      { clipId: 'clip-inst-1', label: 'Mock Instrument Take' },
    );

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const repeated = createCompletedAudioJobRegistration(
      first.project,
      createCompletedJob(),
      { clipId: 'clip-inst-1', label: 'Ignored Repeat Label' },
    );

    expect(repeated).toMatchObject({
      canRegister: true,
      status: 'ALREADY_REGISTERED',
    });

    if (!repeated.canRegister) {
      throw new Error(repeated.message);
    }

    expect(repeated.project).toBe(first.project);
    expect(repeated.clipTake).toBe(first.clipTake);
    expect(repeated.artifact).toBe(first.artifact);
  });

  it('blocks an Artifact or Job from being attached to a second Clip', () => {
    const first = createCompletedAudioJobRegistration(
      cloneSampleProject(),
      createCompletedJob(),
      { clipId: 'clip-inst-1' },
    );

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const conflict = createCompletedAudioJobRegistration(
      first.project,
      createCompletedJob(),
      { clipId: 'clip-inst-2' },
    );

    expect(conflict).toMatchObject({
      canRegister: false,
      reason: 'artifact-conflict',
    });
  });
});

describe('Project Artifact and Clip Take normalization', () => {
  it('round-trips valid registered data and removes duplicate or malformed records', () => {
    const registered = createCompletedAudioJobRegistration(
      cloneSampleProject(),
      createCompletedJob(),
      { clipId: 'clip-inst-1' },
    );

    if (!registered.canRegister) {
      throw new Error(registered.message);
    }

    const serializedArtifact = JSON.parse(JSON.stringify(registered.artifact));
    const artifacts = normalizeProjectArtifacts([
      serializedArtifact,
      serializedArtifact,
      { artifactId: 'artifact-invalid' },
    ]);
    const clipTakeState = normalizeClipTakeState(
      [
        JSON.parse(JSON.stringify(registered.clipTake)),
        JSON.parse(JSON.stringify(registered.clipTake)),
        { clipTakeId: 'invalid' },
      ],
      registered.clipTake.clipTakeId,
    );
    const legacyClipTakeState = normalizeClipTakeState(
      [JSON.parse(JSON.stringify(registered.clipTake))],
      undefined,
    );

    expect(artifacts).toEqual([registered.artifact]);
    expect(clipTakeState.clipTakes).toEqual([registered.clipTake]);
    expect(clipTakeState.activeClipTakeId).toBe(registered.clipTake.clipTakeId);
    expect(legacyClipTakeState).toEqual({
      activeClipTakeId: registered.clipTake.clipTakeId,
      clipTakes: [registered.clipTake],
    });
  });
});

function createCompletedJob(): LocalEngineGpuJobRecord {
  const createdAt = '2026-07-23T03:00:00.000Z';
  const finishedAt = '2026-07-23T03:00:01.000Z';

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
    jobId: 'job-registration-test',
    modelId: 'mock-audio-v1',
    modelRevision: '1',
    providerId: 'mock-provider',
    request: {
      inputArtifacts: [],
      lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
      modelId: 'mock-audio-v1',
      modelRevision: '1',
      output: {
        artifactKind: 'audio',
        destination: 'instrument',
        extension: '.wav',
      },
      parameters: {
        durationSeconds: 0.1,
        frequencyHz: 440,
        sampleRate: 8_000,
        seed: 7,
      },
      providerId: 'mock-provider',
      taskId: 'mock-audio-generation',
    },
    result: {
      artifact: {
        artifactId: 'artifact-client-test',
        createdAt: finishedAt,
        destination: 'instrument',
        file: {
          extension: '.wav',
          name: 'artifact-client-test.wav',
          relativePath: 'renders/instruments/artifact-client-test.wav',
          sizeBytes: 1_644,
        },
        kind: 'audio',
        lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
        provenance: {
          modelId: 'mock-audio-v1',
          modelRevision: '1',
          parameters: {
            durationSeconds: 0.1,
            frequencyHz: 440,
            sampleRate: 8_000,
            seed: 7,
          },
          providerId: 'mock-provider',
          seed: 7,
          taskId: 'mock-audio-generation',
        },
      },
      generation: {
        bytesWritten: 1_644,
        channels: 1,
        durationSeconds: 0.1,
        mimeType: 'audio/wav',
        providerCompletedAt: finishedAt,
      },
    },
    startedAt: createdAt,
    state: 'COMPLETED',
    taskId: 'mock-audio-generation',
    updatedAt: finishedAt,
  };
}

function cloneSampleProject(): ProjectState {
  return JSON.parse(JSON.stringify(sampleProject)) as ProjectState;
}

function findClip(project: ProjectState, clipId: string) {
  const clip = project.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`Test Clip not found: ${clipId}.`);
  }

  return clip;
}
