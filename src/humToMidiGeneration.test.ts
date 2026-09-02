import { describe, expect, it } from 'vitest';

import {
  createCompletedMockHumToMidiRegistration,
  createMockHumToMidiGenerationPlan,
  type MockHumToMidiGenerationPlan,
} from './humToMidiGeneration';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import { sampleProject } from './sampleProject';
import type {
  Clip,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';

describe('createMockHumToMidiGenerationPlan', () => {
  it('binds the active Audio Take, WAV path, source range, BPM, and lineage', () => {
    const project = createProjectWithRecordingTake();
    const result = createMockHumToMidiGenerationPlan(project, {
      converterPatchTabId: 'hum-to-midi',
      seed: 17,
      sourceClipId: 'clip-hum-1',
    });

    expect(result).toMatchObject({
      canPlan: true,
      plan: {
        request: {
          inputArtifacts: [
            {
              artifactId: 'artifact-recording-1',
              kind: 'audio',
              relativePath: 'recordings/artifact-recording-1.wav',
            },
          ],
          lineage: {
            parentArtifactIds: ['artifact-recording-1'],
            parentClipTakeIds: ['clip-take-recording-1'],
          },
          modelId: 'mock-hum-to-midi-v1',
          parameters: {
            projectBpm: 120,
            seed: 17,
            sourceEndSeconds: 2,
            sourceStartSeconds: 0,
            ticksPerQuarter: 960,
          },
          taskId: 'hum-to-midi',
        },
        source: {
          artifactId: 'artifact-recording-1',
          clipId: 'clip-hum-1',
          clipTakeId: 'clip-take-recording-1',
        },
      },
    });

    expect(Object.isFrozen(result.canPlan ? result.plan.request : {})).toBe(
      true,
    );
  });

  it('rejects sources without one valid Active Audio Take', () => {
    const project = cloneProject();

    expect(
      createMockHumToMidiGenerationPlan(project, {
        converterPatchTabId: 'hum-to-midi',
        seed: 17,
        sourceClipId: 'clip-hum-1',
      }),
    ).toMatchObject({
      canPlan: false,
      reason: 'source-invalid',
    });
  });
});

describe('createCompletedMockHumToMidiRegistration', () => {
  it('reuses one source-linked MIDI Clip and appends repeated conversions as Takes', () => {
    const project = createProjectWithRecordingTake();
    const firstPlan = requirePlan(project, 7);
    const first = createCompletedMockHumToMidiRegistration(project, {
      createdAt: '2026-07-27T06:00:00.000Z',
      job: createCompletedJob(firstPlan, 'job-hum-midi-1'),
      plan: firstPlan,
    });

    expect(first).toMatchObject({
      canRegister: true,
      targetClip: { id: 'clip-midi-1' },
      targetCreated: false,
    });

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const secondPlan = requirePlan(first.project, 8);
    const second = createCompletedMockHumToMidiRegistration(first.project, {
      createdAt: '2026-07-27T06:01:00.000Z',
      job: createCompletedJob(secondPlan, 'job-hum-midi-2'),
      plan: secondPlan,
    });

    expect(second).toMatchObject({
      canRegister: true,
      clipTake: {
        label: 'MIDI Take 02',
        sourceJobId: 'job-hum-midi-2',
      },
      targetClip: { id: 'clip-midi-1' },
      targetCreated: false,
    });

    if (!second.canRegister) {
      throw new Error(second.message);
    }

    const matchingTargets = findSourceMidiClips(
      second.project,
      'clip-hum-1',
    );

    expect(matchingTargets).toHaveLength(1);
    expect(matchingTargets[0].clipTakes).toHaveLength(2);
    expect(matchingTargets[0].activeClipTakeId).toBe(
      second.clipTake.clipTakeId,
    );
    expect(second.project.selection.items).toEqual([
      { id: 'clip-midi-1', type: 'clip' },
    ]);
  });

  it('creates one MIDI Track and target Clip only after a valid Job completes', () => {
    const project = createProjectWithRecordingTake();
    project.tracks = project.tracks.filter(
      (track) => track.id !== 'midi-notes',
    );
    const plan = requirePlan(project, 9);
    const result = createCompletedMockHumToMidiRegistration(project, {
      createdAt: '2026-07-27T06:02:00.000Z',
      job: createCompletedJob(plan, 'job-hum-midi-3'),
      plan,
    });

    expect(project.tracks.some((track) => track.id === 'midi-notes')).toBe(
      false,
    );
    expect(result).toMatchObject({
      canRegister: true,
      targetClip: {
        generatedBy: 'Hum to MIDI',
        name: 'MIDI Take 01',
        sourceClipId: 'clip-hum-1',
        type: 'midi-notes',
      },
      targetCreated: true,
    });

    if (!result.canRegister) {
      throw new Error(result.message);
    }

    const humTrackIndex = result.project.tracks.findIndex(
      (track) => track.id === 'hum-audio',
    );
    expect(result.project.tracks[humTrackIndex + 1]).toMatchObject({
      id: 'midi-notes',
      type: 'midi',
    });
  });

  it('does not register a completed Artifact after the source Take changes', () => {
    const project = createProjectWithRecordingTake();
    const plan = requirePlan(project, 10);
    const changedProject = clone(project);
    const sourceClip = findClip(changedProject, 'clip-hum-1');

    sourceClip.activeClipTakeId = undefined;

    const result = createCompletedMockHumToMidiRegistration(changedProject, {
      createdAt: '2026-07-27T06:03:00.000Z',
      job: createCompletedJob(plan, 'job-hum-midi-4'),
      plan,
    });

    expect(result).toMatchObject({
      canRegister: false,
      reason: 'source-stale',
    });
    expect(changedProject.artifacts).toHaveLength(1);
    expect(findClip(changedProject, 'clip-midi-1').clipTakes).toBeUndefined();
  });

  it('rejects duplicate source targets and malformed completed Artifacts', () => {
    const project = createProjectWithRecordingTake();
    const plan = requirePlan(project, 11);
    const duplicateProject = clone(project);
    const midiTrack = duplicateProject.tracks.find(
      (track) => track.id === 'midi-notes',
    );

    if (!midiTrack) {
      throw new Error('MIDI Track fixture missing.');
    }

    midiTrack.clips.push({
      ...findClip(duplicateProject, 'clip-midi-1'),
      id: 'clip-midi-duplicate',
    });

    expect(
      createCompletedMockHumToMidiRegistration(duplicateProject, {
        createdAt: '2026-07-27T06:04:00.000Z',
        job: createCompletedJob(plan, 'job-hum-midi-5'),
        plan,
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'target-conflict',
    });

    const malformedJob = createCompletedJob(plan, 'job-hum-midi-6', {
      artifact: { kind: 'midi' },
    });

    expect(
      createCompletedMockHumToMidiRegistration(project, {
        createdAt: '2026-07-27T06:05:00.000Z',
        job: malformedJob,
        plan,
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'registration-failed',
    });

    const mismatchedJob = createCompletedJob(
      plan,
      'job-hum-midi-7',
      createCompletedJob(plan, 'job-other-source').result,
    );

    expect(
      createCompletedMockHumToMidiRegistration(project, {
        createdAt: '2026-07-27T06:06:00.000Z',
        job: mismatchedJob,
        plan,
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'job-invalid',
    });
  });
});

function createProjectWithRecordingTake(): ProjectState {
  const project = cloneProject();
  const sourceClip = findClip(project, 'clip-hum-1');
  const artifact = createRecordingArtifact();
  const clipTake = createRecordingTake();

  project.artifacts = [artifact];
  sourceClip.activeClipTakeId = clipTake.clipTakeId;
  sourceClip.clipTakes = [clipTake];
  return project;
}

function createRecordingArtifact(): RecordingAudioArtifact {
  return {
    artifactId: 'artifact-recording-1',
    audio: {
      bitsPerSample: 16,
      channels: 1,
      durationSeconds: 2,
      mimeType: 'audio/wav',
      sampleRate: 8_000,
    },
    capture: { source: 'microphone' },
    createdAt: '2026-07-27T05:00:00.000Z',
    destination: 'recording',
    file: {
      extension: '.wav',
      name: 'artifact-recording-1.wav',
      relativePath: 'recordings/artifact-recording-1.wav',
      sizeBytes: 32_044,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
  };
}

function createRecordingTake(): RecordingAudioClipTake {
  return {
    artifactId: 'artifact-recording-1',
    clipTakeId: 'clip-take-recording-1',
    createdAt: '2026-07-27T05:00:00.000Z',
    label: 'Recording Take 01',
    mediaType: 'audio',
    sourceType: 'recording',
  };
}

function requirePlan(
  project: ProjectState,
  seed: number,
): MockHumToMidiGenerationPlan {
  const result = createMockHumToMidiGenerationPlan(project, {
    converterPatchTabId: 'hum-to-midi',
    seed,
    sourceClipId: 'clip-hum-1',
  });

  if (!result.canPlan) {
    throw new Error(result.message);
  }

  return result.plan;
}

function createCompletedJob(
  plan: MockHumToMidiGenerationPlan,
  jobId: string,
  resultOverride?: LocalEngineGpuJobRecord['result'],
): LocalEngineGpuJobRecord {
  const createdAt = '2026-07-27T05:30:00.000Z';
  const finishedAt = '2026-07-27T05:30:01.000Z';
  const artifact = {
    artifactId: `artifact-${jobId}`,
    createdAt: finishedAt,
    kind: 'midi',
    lineage: plan.request.lineage,
    midi: {
      bpm: plan.request.parameters.projectBpm,
      notes: [
        {
          confidence: 0.9,
          id: `note-${jobId}`,
          lengthTicks: 960,
          pitch: 69,
          startTick: 0,
          velocity: 96,
        },
      ],
      ticksPerQuarter: 960,
    },
    provenance: {
      modelId: plan.request.modelId,
      modelRevision: plan.request.modelRevision,
      parameters: plan.request.parameters,
      providerId: plan.request.providerId,
      taskId: plan.request.taskId,
    },
    sourceJobId: jobId,
  };

  return {
    attempt: 1,
    createdAt,
    finishedAt,
    history: [{ attempt: 1, at: finishedAt, state: 'COMPLETED' }],
    jobId,
    modelId: plan.request.modelId,
    modelRevision: plan.request.modelRevision,
    providerId: plan.request.providerId,
    request: plan.request,
    result: resultOverride ?? {
      artifact,
      transcription: {
        noteCount: 1,
        providerCompletedAt: finishedAt,
      },
    },
    startedAt: createdAt,
    state: 'COMPLETED',
    taskId: plan.request.taskId,
    updatedAt: finishedAt,
  };
}

function findSourceMidiClips(
  project: ProjectState,
  sourceClipId: string,
): Clip[] {
  return project.tracks.flatMap((track) =>
    track.clips.filter(
      (clip) =>
        clip.type === 'midi-notes' &&
        clip.sourceClipId === sourceClipId,
    ),
  );
}

function findClip(project: ProjectState, clipId: string): Clip {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`Clip fixture missing: ${clipId}`);
  }

  return clip;
}

function cloneProject(): ProjectState {
  return clone(sampleProject);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
