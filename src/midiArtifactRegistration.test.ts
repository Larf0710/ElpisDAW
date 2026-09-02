import { describe, expect, it } from 'vitest';

import {
  createHumToMidiJobRequest,
  createInlineMidiArtifact,
  type InlineMidiArtifact,
} from './humToMidiContract';
import {
  createMidiArtifactRegistration,
  normalizeClipTakeState,
  normalizeProjectArtifacts,
} from './projectArtifactRegistration';
import { sampleProject } from './sampleProject';
import type {
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';

describe('createMidiArtifactRegistration', () => {
  it('registers one inline MIDI Artifact and activates one MIDI Clip Take', () => {
    const project = createProjectWithRecordingTake();
    const originalTarget = findClip(project, 'clip-midi-1');
    const update = createMidiArtifactRegistration(
      project,
      createMidiArtifact(),
      { clipId: 'clip-midi-1' },
    );

    expect(update).toMatchObject({
      artifact: {
        artifactId: 'artifact-midi-1',
        kind: 'midi',
        sourceJobId: 'job-hum-to-midi-1',
      },
      canRegister: true,
      clipTake: {
        artifactId: 'artifact-midi-1',
        label: 'MIDI Take 01',
        mediaType: 'midi',
        sourceType: 'job',
      },
      status: 'REGISTERED',
    });

    if (!update.canRegister) {
      throw new Error(update.message);
    }

    const registeredTarget = findClip(update.project, 'clip-midi-1');

    expect(update.project).not.toBe(project);
    expect(update.project.artifacts).toHaveLength(2);
    expect(registeredTarget).not.toBe(originalTarget);
    expect(registeredTarget.clipTakes).toEqual([update.clipTake]);
    expect(registeredTarget.activeClipTakeId).toBe(update.clipTake.clipTakeId);
    expect(registeredTarget.version).toBe(originalTarget.version + 1);
    expect(originalTarget.clipTakes).toBeUndefined();
  });

  it('requires one resolvable Audio Artifact and Audio Clip Take parent', () => {
    const missingArtifactProject = createProjectWithRecordingTake();
    missingArtifactProject.artifacts = [];

    expect(
      createMidiArtifactRegistration(
        missingArtifactProject,
        createMidiArtifact(),
        { clipId: 'clip-midi-1' },
      ),
    ).toMatchObject({
      canRegister: false,
      reason: 'source-lineage-invalid',
    });

    const mismatchedSourceProject = createProjectWithRecordingTake();
    const target = findClip(mismatchedSourceProject, 'clip-midi-1');
    target.sourceClipId = 'clip-hum-2';

    expect(
      createMidiArtifactRegistration(
        mismatchedSourceProject,
        createMidiArtifact(),
        { clipId: 'clip-midi-1' },
      ),
    ).toMatchObject({
      canRegister: false,
      reason: 'source-lineage-invalid',
    });
  });

  it('rejects malformed Artifacts and non-MIDI target Clips', () => {
    const project = createProjectWithRecordingTake();

    expect(
      createMidiArtifactRegistration(
        project,
        {
          ...createMidiArtifact(),
          midi: {
            ...createMidiArtifact().midi,
            ticksPerQuarter: 480,
          },
        },
        { clipId: 'clip-midi-1' },
      ),
    ).toMatchObject({ canRegister: false, reason: 'artifact-invalid' });

    expect(
      createMidiArtifactRegistration(project, createMidiArtifact(), {
        clipId: 'clip-hum-1',
      }),
    ).toMatchObject({ canRegister: false, reason: 'target-not-midi' });
  });

  it('is idempotent and rejects conflicting metadata for the same Artifact', () => {
    const first = createMidiArtifactRegistration(
      createProjectWithRecordingTake(),
      createMidiArtifact(),
      { clipId: 'clip-midi-1', label: 'Converted Lead' },
    );

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const repeated = createMidiArtifactRegistration(
      first.project,
      createMidiArtifact(),
      { clipId: 'clip-midi-1', label: 'Ignored Repeat Label' },
    );

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

    const changedArtifact = JSON.parse(
      JSON.stringify(createMidiArtifact()),
    ) as InlineMidiArtifact;
    changedArtifact.midi.notes[0].velocity = 1;

    expect(
      createMidiArtifactRegistration(first.project, changedArtifact, {
        clipId: 'clip-midi-1',
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'artifact-conflict',
    });
  });
});

describe('MIDI Artifact and Clip Take normalization', () => {
  it('round-trips MIDI Project JSON and restores deterministic note order', () => {
    const midiArtifact = JSON.parse(
      JSON.stringify(createMidiArtifact()),
    ) as InlineMidiArtifact;
    midiArtifact.midi.notes.reverse();
    const midiTake = {
      artifactId: midiArtifact.artifactId,
      clipTakeId: `clip-take-${midiArtifact.artifactId}`,
      createdAt: midiArtifact.createdAt,
      label: 'MIDI Take 01',
      mediaType: 'midi',
      sourceJobId: midiArtifact.sourceJobId,
      sourceType: 'job',
    };

    const artifacts = normalizeProjectArtifacts([
      createRecordingArtifact(),
      midiArtifact,
      midiArtifact,
      {
        ...midiArtifact,
        artifactId: 'artifact-midi-invalid',
        midi: { ...midiArtifact.midi, ticksPerQuarter: 480 },
        sourceJobId: 'job-hum-to-midi-invalid',
      },
    ]);
    const clipTakeState = normalizeClipTakeState(
      [midiTake, midiTake, { ...midiTake, mediaType: 'video' }],
      midiTake.clipTakeId,
    );

    expect(artifacts).toHaveLength(2);
    expect(artifacts[1]).toMatchObject({
      artifactId: 'artifact-midi-1',
      kind: 'midi',
    });
    expect(
      artifacts[1]?.kind === 'midi'
        ? artifacts[1].midi.notes.map((note) => note.id)
        : [],
    ).toEqual(['note-a', 'note-b']);
    expect(clipTakeState).toEqual({
      activeClipTakeId: midiTake.clipTakeId,
      clipTakes: [midiTake],
    });
  });
});

function createProjectWithRecordingTake(): ProjectState {
  const project = JSON.parse(JSON.stringify(sampleProject)) as ProjectState;
  const sourceClip = findClip(project, 'clip-hum-1');
  const sourceArtifact = createRecordingArtifact();
  const sourceTake = createRecordingTake();

  project.artifacts = [sourceArtifact];
  sourceClip.activeClipTakeId = sourceTake.clipTakeId;
  sourceClip.clipTakes = [sourceTake];

  return project;
}

function createMidiArtifact(): InlineMidiArtifact {
  const request = createHumToMidiJobRequest({
    modelId: 'basic-pitch',
    modelRevision: 'v1',
    parameters: {
      onsetThreshold: 0.5,
    },
    projectBpm: 120,
    providerId: 'local-basic-pitch',
    source: {
      artifactId: 'artifact-recording-1',
      clipTakeId: 'clip-take-recording-1',
      sourceEndSeconds: 4,
      sourceStartSeconds: 0,
    },
  });

  return createInlineMidiArtifact(
    {
      artifactId: 'artifact-midi-1',
      createdAt: '2026-07-25T12:34:56.000Z',
      notes: [
        {
          confidence: 0.95,
          id: 'note-a',
          lengthTicks: 960,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
        {
          confidence: 0.8,
          id: 'note-b',
          lengthTicks: 480,
          pitch: 64,
          startTick: 960,
          velocity: 90,
        },
      ],
      sourceJobId: 'job-hum-to-midi-1',
    },
    request,
  );
}

function createRecordingArtifact(): RecordingAudioArtifact {
  return {
    artifactId: 'artifact-recording-1',
    audio: {
      bitsPerSample: 16,
      channels: 1,
      durationSeconds: 4,
      mimeType: 'audio/wav',
      sampleRate: 48_000,
    },
    capture: {
      source: 'microphone',
    },
    createdAt: '2026-07-25T12:30:00.000Z',
    destination: 'recording',
    file: {
      extension: '.wav',
      name: 'artifact-recording-1.wav',
      relativePath: 'recordings/artifact-recording-1.wav',
      sizeBytes: 384_044,
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
    createdAt: '2026-07-25T12:30:00.000Z',
    label: 'Recording Take 01',
    mediaType: 'audio',
    sourceType: 'recording',
  };
}

function findClip(project: ProjectState, clipId: string) {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`Test Clip not found: ${clipId}.`);
  }

  return clip;
}
