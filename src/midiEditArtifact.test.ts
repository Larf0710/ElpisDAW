import { describe, expect, it } from 'vitest';

import {
  createHumToMidiJobRequest,
  createInlineMidiArtifact,
  type InlineMidiArtifact,
} from './humToMidiContract';
import {
  createEditedMidiArtifact,
  MIDI_EDIT_TASK_ID,
  PIANO_ROLL_EDITOR_ID,
} from './midiEditArtifact';
import {
  createMidiArtifactRegistration,
  normalizeClipTakeState,
  normalizeProjectArtifacts,
} from './projectArtifactRegistration';
import { sampleProject } from './sampleProject';
import type {
  MidiClipTake,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';

describe('createEditedMidiArtifact', () => {
  it('creates one immutable derived MIDI Artifact with MIDI lineage', () => {
    const { artifact, clipTake } = createGeneratedMidiSource();
    const edited = createEditedMidiArtifact({
      artifactId: 'artifact-midi-edited-1',
      createdAt: '2026-07-26T07:30:00.000Z',
      notes: [
        {
          id: 'note-late',
          lengthTicks: 480,
          pitch: 67,
          startTick: 960,
          velocity: 92,
        },
        {
          id: 'note-early',
          lengthTicks: 960,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
      ],
      sourceArtifact: artifact,
      sourceClipTake: clipTake,
      sourceEditId: 'edit-midi-1',
    });

    expect(edited).toMatchObject({
      artifactId: 'artifact-midi-edited-1',
      editProvenance: {
        editorId: PIANO_ROLL_EDITOR_ID,
        editorVersion: '1',
        taskId: MIDI_EDIT_TASK_ID,
      },
      kind: 'midi',
      lineage: {
        parentArtifactIds: [artifact.artifactId],
        parentClipTakeIds: [clipTake.clipTakeId],
      },
      midi: {
        bpm: artifact.midi.bpm,
        ticksPerQuarter: artifact.midi.ticksPerQuarter,
      },
      sourceEditId: 'edit-midi-1',
    });
    expect(edited.midi.notes.map((note) => note.id)).toEqual([
      'note-early',
      'note-late',
    ]);
    expect(Object.isFrozen(edited)).toBe(true);
    expect(Object.isFrozen(edited.lineage.parentArtifactIds)).toBe(true);
    expect(Object.isFrozen(edited.midi.notes)).toBe(true);
  });

  it('requires the source Take to reference the source Artifact', () => {
    const { artifact, clipTake } = createGeneratedMidiSource();

    expect(() =>
      createEditedMidiArtifact({
        artifactId: 'artifact-midi-edited-1',
        createdAt: '2026-07-26T07:30:00.000Z',
        notes: artifact.midi.notes,
        sourceArtifact: artifact,
        sourceClipTake: {
          ...clipTake,
          artifactId: 'artifact-midi-other',
        },
        sourceEditId: 'edit-midi-1',
      }),
    ).toThrow(
      'MIDI edit source Take must reference the source MIDI Artifact.',
    );
  });
});

describe('edited MIDI Artifact registration', () => {
  it('adds and activates a corrected MIDI Take without replacing the source Take', () => {
    const source = createProjectWithGeneratedMidiTake();
    const sourceClip = findClip(source.project, 'clip-midi-1');
    const editedArtifact = createEditedMidiArtifact({
      artifactId: 'artifact-midi-edited-1',
      createdAt: '2026-07-26T07:30:00.000Z',
      notes: [
        {
          ...source.artifact.midi.notes[0],
          pitch: 62,
        },
      ],
      sourceArtifact: source.artifact,
      sourceClipTake: source.clipTake,
      sourceEditId: 'edit-midi-1',
    });
    const update = createMidiArtifactRegistration(
      source.project,
      editedArtifact,
      { clipId: 'clip-midi-1', label: 'Corrected MIDI 01' },
    );

    expect(update).toMatchObject({
      artifact: {
        artifactId: 'artifact-midi-edited-1',
        sourceEditId: 'edit-midi-1',
      },
      canRegister: true,
      clipTake: {
        label: 'Corrected MIDI 01',
        mediaType: 'midi',
        sourceEditId: 'edit-midi-1',
        sourceType: 'edit',
      },
      status: 'REGISTERED',
    });

    if (!update.canRegister) {
      throw new Error(update.message);
    }

    const editedClip = findClip(update.project, 'clip-midi-1');

    expect(editedClip.clipTakes).toEqual([
      source.clipTake,
      update.clipTake,
    ]);
    expect(editedClip.activeClipTakeId).toBe(update.clipTake.clipTakeId);
    expect(editedClip.version).toBe(sourceClip.version + 1);
    expect(sourceClip.clipTakes).toEqual([source.clipTake]);
    expect(update.project.artifacts).toEqual([
      expect.objectContaining({ artifactId: 'artifact-recording-1' }),
      source.artifact,
      editedArtifact,
    ]);

    const repeated = createMidiArtifactRegistration(
      update.project,
      editedArtifact,
      { clipId: 'clip-midi-1' },
    );

    expect(repeated).toMatchObject({
      canRegister: true,
      status: 'ALREADY_REGISTERED',
    });
    if (!repeated.canRegister) {
      throw new Error(repeated.message);
    }
    expect(repeated.project).toBe(update.project);
    expect(repeated.artifact).toBe(update.artifact);
    expect(repeated.clipTake).toBe(update.clipTake);
  });

  it('allows a derived MIDI Clip target and rejects unrelated MIDI ancestry', () => {
    const source = createProjectWithGeneratedMidiTake();
    const editedArtifact = createEditedMidiArtifact({
      artifactId: 'artifact-midi-edited-1',
      createdAt: '2026-07-26T07:30:00.000Z',
      notes: source.artifact.midi.notes,
      sourceArtifact: source.artifact,
      sourceClipTake: source.clipTake,
      sourceEditId: 'edit-midi-1',
    });
    const derivedProject = JSON.parse(
      JSON.stringify(source.project),
    ) as ProjectState;
    findClip(derivedProject, 'clip-midi-2').sourceClipId = 'clip-midi-1';

    expect(
      createMidiArtifactRegistration(derivedProject, editedArtifact, {
        clipId: 'clip-midi-2',
      }),
    ).toMatchObject({
      canRegister: true,
      status: 'REGISTERED',
    });

    expect(
      createMidiArtifactRegistration(source.project, editedArtifact, {
        clipId: 'clip-midi-2',
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'source-lineage-invalid',
    });
  });

  it('round-trips edited Artifacts and Takes while rejecting mixed source metadata', () => {
    const source = createProjectWithGeneratedMidiTake();
    const editedArtifact = createEditedMidiArtifact({
      artifactId: 'artifact-midi-edited-1',
      createdAt: '2026-07-26T07:30:00.000Z',
      notes: source.artifact.midi.notes,
      sourceArtifact: source.artifact,
      sourceClipTake: source.clipTake,
      sourceEditId: 'edit-midi-1',
    });
    const editedTake: MidiClipTake = {
      artifactId: editedArtifact.artifactId,
      clipTakeId: `clip-take-${editedArtifact.artifactId}`,
      createdAt: editedArtifact.createdAt,
      label: 'Corrected MIDI 01',
      mediaType: 'midi',
      sourceEditId: editedArtifact.sourceEditId,
      sourceType: 'edit',
    };

    expect(
      normalizeProjectArtifacts([
        editedArtifact,
        {
          ...editedArtifact,
          artifactId: 'artifact-midi-mixed',
          provenance: source.artifact.provenance,
          sourceJobId: 'job-mixed',
        },
      ]),
    ).toEqual([editedArtifact]);
    expect(
      normalizeClipTakeState(
        [
          editedTake,
          {
            ...editedTake,
            clipTakeId: 'clip-take-mixed',
            sourceJobId: 'job-mixed',
          },
        ],
        editedTake.clipTakeId,
      ),
    ).toEqual({
      activeClipTakeId: editedTake.clipTakeId,
      clipTakes: [editedTake],
    });
  });
});

function createProjectWithGeneratedMidiTake(): {
  artifact: InlineMidiArtifact;
  clipTake: MidiClipTake;
  project: ProjectState;
} {
  const project = JSON.parse(JSON.stringify(sampleProject)) as ProjectState;
  const sourceAudioClip = findClip(project, 'clip-hum-1');
  const recordingArtifact = createRecordingArtifact();
  const recordingTake = createRecordingTake();

  project.artifacts = [recordingArtifact];
  sourceAudioClip.activeClipTakeId = recordingTake.clipTakeId;
  sourceAudioClip.clipTakes = [recordingTake];

  const artifact = createGeneratedMidiArtifact();
  const registration = createMidiArtifactRegistration(project, artifact, {
    clipId: 'clip-midi-1',
  });

  if (!registration.canRegister) {
    throw new Error(registration.message);
  }

  return {
    artifact,
    clipTake: registration.clipTake,
    project: registration.project,
  };
}

function createGeneratedMidiSource(): {
  artifact: InlineMidiArtifact;
  clipTake: MidiClipTake;
} {
  const artifact = createGeneratedMidiArtifact();

  return {
    artifact,
    clipTake: {
      artifactId: artifact.artifactId,
      clipTakeId: `clip-take-${artifact.artifactId}`,
      createdAt: artifact.createdAt,
      label: 'MIDI Take 01',
      mediaType: 'midi',
      sourceJobId: artifact.sourceJobId,
      sourceType: 'job',
    },
  };
}

function createGeneratedMidiArtifact(): InlineMidiArtifact {
  const request = createHumToMidiJobRequest({
    modelId: 'basic-pitch',
    modelRevision: 'v1',
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
      createdAt: '2026-07-26T07:00:00.000Z',
      notes: [
        {
          confidence: 0.95,
          id: 'note-a',
          lengthTicks: 960,
          pitch: 60,
          startTick: 0,
          velocity: 100,
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
    createdAt: '2026-07-26T06:55:00.000Z',
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
    createdAt: '2026-07-26T06:55:00.000Z',
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
    throw new Error(`Missing test Clip: ${clipId}`);
  }

  return clip;
}
