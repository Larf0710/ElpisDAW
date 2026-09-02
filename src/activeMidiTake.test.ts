import { describe, expect, it } from 'vitest';

import { resolveActiveMidiTake } from './activeMidiTake';
import { normalizeClipTakeState } from './projectArtifactRegistration';
import { createDefaultRecordingSettings } from './recordingSettings';
import type {
  EditedMidiArtifact,
  EditedMidiClipTake,
  GeneratedAudioClipTake,
  GeneratedMidiArtifact,
  GeneratedMidiClipTake,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';
import { TICKS_PER_QUARTER } from './workflow';

describe('resolveActiveMidiTake', () => {
  it('resolves an immutable Instrument Render plan from a generated MIDI Take', () => {
    const project = createMidiProject();
    const resolution = resolveActiveMidiTake(project, 'clip-midi');

    expect(resolution).toMatchObject({
      canResolve: true,
      plan: {
        midi: {
          bpm: 120,
          ticksPerQuarter: TICKS_PER_QUARTER,
        },
        source: {
          artifactId: 'artifact-midi',
          clipId: 'clip-midi',
          clipTakeId: 'clip-take-midi',
        },
      },
    });

    if (!resolution.canResolve) {
      throw new Error(resolution.message);
    }

    expect(resolution.plan.midi.notes.map((note) => note.id)).toEqual([
      'note-a',
      'note-b',
    ]);
    expect(Object.isFrozen(resolution.plan)).toBe(true);
    expect(Object.isFrozen(resolution.plan.midi.notes)).toBe(true);
  });

  it('resolves an edited Active Take through its generated MIDI and Audio roots', () => {
    const project = createMidiProject({ includeEditedTake: true });
    const resolution = resolveActiveMidiTake(project, 'clip-midi');

    expect(resolution).toMatchObject({
      canResolve: true,
      plan: {
        source: {
          artifactId: 'artifact-midi-edited',
          clipTakeId: 'clip-take-midi-edited',
        },
      },
    });
  });

  it('requires a MIDI Clip and one selected Active Take', () => {
    const project = createMidiProject();

    expect(resolveActiveMidiTake(project, 'clip-audio')).toMatchObject({
      canResolve: false,
      reason: 'target-not-midi',
    });

    findClip(project, 'clip-midi').activeClipTakeId = undefined;

    expect(resolveActiveMidiTake(project, 'clip-midi')).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-selected',
    });
  });

  it('fails closed when normalization rejects an explicit stale Active Take reference', () => {
    const project = createMidiProject({ includeEditedTake: true });
    const clip = findClip(project, 'clip-midi');
    const normalizedTakeState = normalizeClipTakeState(
      JSON.parse(JSON.stringify(clip.clipTakes)),
      'clip-take-missing',
    );

    expect(normalizedTakeState.clipTakes).toHaveLength(2);
    expect(normalizedTakeState).not.toHaveProperty('activeClipTakeId');

    delete clip.activeClipTakeId;
    Object.assign(clip, normalizedTakeState);

    expect(clip.clipTakes).toHaveLength(2);
    expect(clip).not.toHaveProperty('activeClipTakeId');
    expect(resolveActiveMidiTake(project, clip.id)).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-selected',
    });
  });

  it('rejects missing, duplicate, and non-MIDI Active Take references', () => {
    const missingProject = createMidiProject();
    findClip(missingProject, 'clip-midi').activeClipTakeId =
      'clip-take-missing';

    expect(resolveActiveMidiTake(missingProject, 'clip-midi')).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-found',
    });

    const duplicateProject = createMidiProject();
    const midiClip = findClip(duplicateProject, 'clip-midi');
    midiClip.clipTakes = [
      ...(midiClip.clipTakes ?? []),
      { ...(midiClip.clipTakes?.[0] as GeneratedMidiClipTake) },
    ];

    expect(resolveActiveMidiTake(duplicateProject, 'clip-midi')).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-found',
    });

    const audioTakeProject = createMidiProject();
    const audioTake = findClip(audioTakeProject, 'clip-audio').clipTakes?.[0];
    if (!audioTake) {
      throw new Error('Missing Audio Take fixture.');
    }
    findClip(audioTakeProject, 'clip-midi').clipTakes = [audioTake];
    findClip(audioTakeProject, 'clip-midi').activeClipTakeId =
      audioTake.clipTakeId;

    expect(resolveActiveMidiTake(audioTakeProject, 'clip-midi')).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-midi',
    });
  });

  it('rejects missing and non-MIDI Active Artifacts', () => {
    const missingProject = createMidiProject();
    missingProject.artifacts = missingProject.artifacts?.filter(
      (artifact) => artifact.artifactId !== 'artifact-midi',
    );

    expect(resolveActiveMidiTake(missingProject, 'clip-midi')).toMatchObject({
      canResolve: false,
      reason: 'artifact-not-found',
    });

    const wrongKindProject = createMidiProject();
    const midiTake = findClip(wrongKindProject, 'clip-midi')
      .clipTakes?.[0] as GeneratedMidiClipTake;
    midiTake.artifactId = 'artifact-recording';

    expect(resolveActiveMidiTake(wrongKindProject, 'clip-midi')).toMatchObject({
      canResolve: false,
      reason: 'artifact-not-midi',
    });
  });

  it('rejects source metadata mismatches', () => {
    const project = createMidiProject();
    const midiTake = findClip(project, 'clip-midi')
      .clipTakes?.[0] as GeneratedMidiClipTake;
    midiTake.sourceJobId = 'job-other';

    expect(resolveActiveMidiTake(project, 'clip-midi')).toMatchObject({
      canResolve: false,
      reason: 'source-mismatch',
    });
  });

  it('rejects incomplete and circular edited MIDI Lineage', () => {
    const missingParentProject = createMidiProject({
      includeEditedTake: true,
    });
    missingParentProject.artifacts =
      missingParentProject.artifacts?.filter(
        (artifact) => artifact.artifactId !== 'artifact-midi',
      );

    expect(
      resolveActiveMidiTake(missingParentProject, 'clip-midi'),
    ).toMatchObject({
      canResolve: false,
      reason: 'lineage-invalid',
    });

    const circularProject = createMidiProject({ includeEditedTake: true });
    const generatedArtifact = findArtifact(
      circularProject,
      'artifact-midi',
    ) as GeneratedMidiArtifact;
    const editedTake = findClip(circularProject, 'clip-midi')
      .clipTakes?.find(
        (take) => take.clipTakeId === 'clip-take-midi-edited',
      ) as EditedMidiClipTake;
    generatedArtifact.lineage = {
      parentArtifactIds: ['artifact-midi-edited'],
      parentClipTakeIds: [editedTake.clipTakeId],
    };

    expect(resolveActiveMidiTake(circularProject, 'clip-midi')).toMatchObject({
      canResolve: false,
      reason: 'lineage-invalid',
    });

    const invalidRootProject = createMidiProject();
    const audioClip = findClip(invalidRootProject, 'clip-audio');
    const recordingTake = audioClip
      .clipTakes?.[0] as RecordingAudioClipTake;
    const mismatchedGeneratedTake: GeneratedAudioClipTake = {
      ...recordingTake,
      sourceJobId: 'job-impossible-recording',
      sourceType: 'job',
    };
    audioClip.clipTakes = [mismatchedGeneratedTake];

    expect(
      resolveActiveMidiTake(invalidRootProject, 'clip-midi'),
    ).toMatchObject({
      canResolve: false,
      reason: 'lineage-invalid',
    });
  });

  it('rejects invalid MIDI note and timing data', () => {
    const invalidNoteProject = createMidiProject();
    const invalidNoteArtifact = findArtifact(
      invalidNoteProject,
      'artifact-midi',
    ) as GeneratedMidiArtifact;
    invalidNoteArtifact.midi.notes[0].pitch = 200;

    expect(
      resolveActiveMidiTake(invalidNoteProject, 'clip-midi'),
    ).toMatchObject({
      canResolve: false,
      reason: 'midi-invalid',
    });

    const invalidTimingProject = createMidiProject();
    const invalidTimingArtifact = findArtifact(
      invalidTimingProject,
      'artifact-midi',
    ) as GeneratedMidiArtifact;
    invalidTimingArtifact.midi.ticksPerQuarter = 480;

    expect(
      resolveActiveMidiTake(invalidTimingProject, 'clip-midi'),
    ).toMatchObject({
      canResolve: false,
      reason: 'midi-invalid',
    });
  });
});

function createMidiProject(
  options: Readonly<{ includeEditedTake?: boolean }> = {},
): ProjectState {
  const recordingArtifact: RecordingAudioArtifact = {
    artifactId: 'artifact-recording',
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
    createdAt: '2026-07-26T08:00:00.000Z',
    destination: 'recording',
    file: {
      extension: '.wav',
      name: 'artifact-recording.wav',
      relativePath: 'recordings/artifact-recording.wav',
      sizeBytes: 384_044,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
  };
  const recordingTake: RecordingAudioClipTake = {
    artifactId: recordingArtifact.artifactId,
    clipTakeId: 'clip-take-recording',
    createdAt: recordingArtifact.createdAt,
    label: 'Recording Take 01',
    mediaType: 'audio',
    sourceType: 'recording',
  };
  const generatedArtifact: GeneratedMidiArtifact = {
    artifactId: 'artifact-midi',
    createdAt: '2026-07-26T08:01:00.000Z',
    kind: 'midi',
    lineage: {
      parentArtifactIds: [recordingArtifact.artifactId],
      parentClipTakeIds: [recordingTake.clipTakeId],
    },
    midi: {
      bpm: 120,
      notes: [
        {
          id: 'note-b',
          lengthTicks: 480,
          pitch: 64,
          startTick: 960,
          velocity: 90,
        },
        {
          id: 'note-a',
          lengthTicks: 960,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
      ],
      ticksPerQuarter: TICKS_PER_QUARTER,
    },
    provenance: {
      modelId: 'basic-pitch',
      modelRevision: 'v1',
      parameters: {},
      providerId: 'local-basic-pitch',
      taskId: 'hum-to-midi',
    },
    sourceJobId: 'job-hum-to-midi',
  };
  const generatedTake: GeneratedMidiClipTake = {
    artifactId: generatedArtifact.artifactId,
    clipTakeId: 'clip-take-midi',
    createdAt: generatedArtifact.createdAt,
    label: 'MIDI Take 01',
    mediaType: 'midi',
    sourceJobId: generatedArtifact.sourceJobId,
    sourceType: 'job',
  };
  const editedArtifact: EditedMidiArtifact = {
    artifactId: 'artifact-midi-edited',
    createdAt: '2026-07-26T08:02:00.000Z',
    editProvenance: {
      editorId: 'piano-roll',
      editorVersion: '1',
      taskId: 'midi-edit',
    },
    kind: 'midi',
    lineage: {
      parentArtifactIds: [generatedArtifact.artifactId],
      parentClipTakeIds: [generatedTake.clipTakeId],
    },
    midi: {
      bpm: 120,
      notes: [
        {
          id: 'note-a',
          lengthTicks: 960,
          pitch: 62,
          startTick: 0,
          velocity: 100,
        },
      ],
      ticksPerQuarter: TICKS_PER_QUARTER,
    },
    sourceEditId: 'edit-midi',
  };
  const editedTake: EditedMidiClipTake = {
    artifactId: editedArtifact.artifactId,
    clipTakeId: 'clip-take-midi-edited',
    createdAt: editedArtifact.createdAt,
    label: 'Corrected MIDI 01',
    mediaType: 'midi',
    sourceEditId: editedArtifact.sourceEditId,
    sourceType: 'edit',
  };
  const midiTakes = options.includeEditedTake
    ? [generatedTake, editedTake]
    : [generatedTake];

  return {
    artifacts: [
      recordingArtifact,
      generatedArtifact,
      ...(options.includeEditedTake ? [editedArtifact] : []),
    ],
    bpm: 120,
    connections: [],
    gridResolution: '1/8',
    isLooping: false,
    key: 'C major',
    name: 'Active MIDI Take Test',
    patchTabs: [],
    playheadTick: 0,
    recordingSettings: createDefaultRecordingSettings(),
    selectedPatchTabId: '',
    selection: { items: [] },
    status: 'READY',
    takes: [],
    totalTicks: 15_360,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: recordingTake.clipTakeId,
            clipTakes: [recordingTake],
            color: '#ff4d5d',
            createdAt: recordingArtifact.createdAt,
            id: 'clip-audio',
            lengthTicks: 3_840,
            name: 'Hum',
            startTick: 0,
            type: 'hum-audio',
            version: 1,
          },
        ],
        id: 'hum-audio',
        level: -6,
        name: 'Hum Audio',
        type: 'audio',
      },
      {
        clips: [
          {
            activeClipTakeId: options.includeEditedTake
              ? editedTake.clipTakeId
              : generatedTake.clipTakeId,
            clipTakes: midiTakes,
            color: '#4de1ff',
            createdAt: generatedArtifact.createdAt,
            id: 'clip-midi',
            lengthTicks: 3_840,
            name: 'MIDI',
            sourceClipId: 'clip-audio',
            startTick: 0,
            type: 'midi-notes',
            version: 1,
          },
        ],
        id: 'midi-notes',
        level: -6,
        name: 'MIDI Notes',
        type: 'midi',
      },
    ],
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

function findArtifact(project: ProjectState, artifactId: string) {
  const artifact = project.artifacts?.find(
    (candidate) => candidate.artifactId === artifactId,
  );

  if (!artifact) {
    throw new Error(`Missing test Artifact: ${artifactId}`);
  }

  return artifact;
}
