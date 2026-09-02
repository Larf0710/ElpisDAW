import { describe, expect, it } from 'vitest';

import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import {
  activateClipTake,
  doesClipTakeMatchArtifact,
} from './clipTakeActivation';
import { sampleProject } from './sampleProject';
import {
  commitSessionEdit,
  createSessionEditHistory,
  redoSessionEdit,
  undoSessionEdit,
} from './sessionEditHistory';
import type {
  Clip,
  EditedMidiArtifact,
  EditedMidiClipTake,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  GeneratedMidiArtifact,
  GeneratedMidiClipTake,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';

describe('activateClipTake', () => {
  it('activates one valid Audio Clip Take without mutating Project input', () => {
    const fixture = createAudioFixture();
    const originalTrack = findTrackForClip(fixture.project, fixture.clip.id);
    const result = activateClipTake(
      fixture.project,
      fixture.clip.id,
      fixture.nextTake.clipTakeId,
    );

    expect(result).toMatchObject({
      canActivate: true,
      clipTake: fixture.nextTake,
      status: 'ACTIVATED',
    });

    if (!result.canActivate) {
      throw new Error(result.message);
    }

    const nextTrack = findTrackForClip(result.project, fixture.clip.id);
    const nextClip = findClip(result.project, fixture.clip.id);

    expect(result.project).not.toBe(fixture.project);
    expect(result.project.artifacts).toBe(fixture.project.artifacts);
    expect(nextTrack).not.toBe(originalTrack);
    expect(nextClip).not.toBe(fixture.clip);
    expect(nextClip.clipTakes).toBe(fixture.clip.clipTakes);
    expect(nextClip.activeClipTakeId).toBe(fixture.nextTake.clipTakeId);
    expect(nextClip.sourceFile).toEqual({
      durationSeconds: fixture.nextArtifact.audio.durationSeconds,
      mimeType: fixture.nextArtifact.audio.mimeType,
      name: fixture.nextArtifact.file.name,
      relativePath: fixture.nextArtifact.file.relativePath,
      sizeBytes: fixture.nextArtifact.file.sizeBytes,
      sourceId: fixture.nextArtifact.artifactId,
      status: 'unresolved',
    });
    expect(nextClip.version).toBe(fixture.clip.version + 1);
    expect(fixture.clip.activeClipTakeId).toBe(
      fixture.currentTake.clipTakeId,
    );
  });

  it('keeps a verified finalized Audio Take available immediately after activation', () => {
    const fixture = createAudioFixture();
    const result = activateClipTake(
      fixture.project,
      fixture.clip.id,
      fixture.nextTake.clipTakeId,
      {
        sourceAvailability: {
          availableArtifactIds: [fixture.nextArtifact.artifactId],
          checkedAt: '2026-08-30T09:00:00.000Z',
        },
      },
    );

    expect(result).toMatchObject({
      canActivate: true,
      clip: {
        activeClipTakeId: fixture.nextTake.clipTakeId,
        sourceFile: {
          checkedAt: '2026-08-30T09:00:00.000Z',
          sourceId: fixture.nextArtifact.artifactId,
          status: 'available',
        },
      },
      status: 'ACTIVATED',
    });
  });

  it('returns the original Project when the requested Take is already Active', () => {
    const fixture = createAudioFixture();
    const result = activateClipTake(
      fixture.project,
      fixture.clip.id,
      fixture.currentTake.clipTakeId,
    );

    expect(result).toMatchObject({
      canActivate: true,
      clip: fixture.clip,
      clipTake: fixture.currentTake,
      project: fixture.project,
      status: 'ALREADY_ACTIVE',
    });
  });

  it('rejects a shorter Audio Take when retained timing would become invalid', () => {
    const fixture = createAudioFixture();
    fixture.clip.audioTiming = {
      sourceEndSeconds: 1,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    };
    fixture.nextArtifact.audio.durationSeconds = 0.25;
    const originalSourceFile = fixture.clip.sourceFile;
    const originalTiming = fixture.clip.audioTiming;
    const originalProjectSnapshot = cloneProject(fixture.project);

    expect(
      resolveActiveAudioTakeSource(fixture.project, fixture.clip.id),
    ).toMatchObject({ canResolve: true });

    const result = activateClipTake(
      fixture.project,
      fixture.clip.id,
      fixture.nextTake.clipTakeId,
    );

    expect(result).toMatchObject({
      canActivate: false,
      reason: 'timing-invalid',
    });
    expect(fixture.clip.activeClipTakeId).toBe(
      fixture.currentTake.clipTakeId,
    );
    expect(fixture.clip.sourceFile).toBe(originalSourceFile);
    expect(fixture.clip.audioTiming).toBe(originalTiming);
    expect(fixture.project).toEqual(originalProjectSnapshot);
    expect(
      resolveActiveAudioTakeSource(fixture.project, fixture.clip.id),
    ).toMatchObject({ canResolve: true });
  });

  it('does not report ALREADY_ACTIVE when retained Audio timing is invalid', () => {
    const fixture = createAudioFixture();
    fixture.clip.audioTiming = {
      sourceEndSeconds: 1,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    };
    fixture.currentArtifact.audio.durationSeconds = 0.25;
    const originalProjectSnapshot = cloneProject(fixture.project);

    const result = activateClipTake(
      fixture.project,
      fixture.clip.id,
      fixture.currentTake.clipTakeId,
    );

    expect(result).toMatchObject({
      canActivate: false,
      reason: 'timing-invalid',
    });
    expect(fixture.project).toEqual(originalProjectSnapshot);
  });

  it('preserves the Active Take and source pair through serialization and Undo/Redo', () => {
    const fixture = createAudioFixture();
    const activation = activateClipTake(
      fixture.project,
      fixture.clip.id,
      fixture.nextTake.clipTakeId,
    );

    if (!activation.canActivate) {
      throw new Error(activation.message);
    }

    const serializedProject = JSON.parse(
      JSON.stringify(activation.project),
    ) as ProjectState;
    expect(findClip(serializedProject, fixture.clip.id)).toMatchObject({
      activeClipTakeId: fixture.nextTake.clipTakeId,
      sourceFile: { sourceId: fixture.nextArtifact.artifactId },
    });

    const initialEdit = {
      category: 'system' as const,
      createdAt: '2026-07-26T00:00:00.000Z',
      id: 'edit-initial',
      label: 'Initial state',
    };
    const activationEdit = {
      category: 'take' as const,
      createdAt: '2026-07-26T00:01:00.000Z',
      id: 'edit-activation',
      label: 'Activate Take B',
    };
    const history = commitSessionEdit(
      createSessionEditHistory(fixture.project, initialEdit),
      activation.project,
      activationEdit,
      10,
    );
    const undo = undoSessionEdit(history);

    expect(undo.status).toBe('MOVED');
    expect(findClip(undo.history.present.value, fixture.clip.id)).toMatchObject({
      activeClipTakeId: fixture.currentTake.clipTakeId,
      sourceFile: { sourceId: fixture.currentArtifact.artifactId },
    });

    const redo = redoSessionEdit(undo.history, 10);
    expect(redo.status).toBe('MOVED');
    expect(findClip(redo.history.present.value, fixture.clip.id)).toMatchObject({
      activeClipTakeId: fixture.nextTake.clipTakeId,
      sourceFile: { sourceId: fixture.nextArtifact.artifactId },
    });
  });

  it('uses the same activation contract for MIDI Clip Takes', () => {
    const project = cloneSampleProject();
    const clip = findClip(project, 'clip-midi-1');
    const currentArtifact = createMidiArtifact(
      'artifact-midi-current',
      'job-midi-current',
    );
    const nextArtifact = createMidiArtifact(
      'artifact-midi-next',
      'job-midi-next',
    );
    const currentTake = createMidiTake(currentArtifact, 'MIDI Take A');
    const nextTake = createMidiTake(nextArtifact, 'MIDI Take B');

    project.artifacts = [currentArtifact, nextArtifact];
    clip.clipTakes = [currentTake, nextTake];
    clip.activeClipTakeId = currentTake.clipTakeId;

    const result = activateClipTake(
      project,
      clip.id,
      nextTake.clipTakeId,
    );

    expect(result).toMatchObject({
      canActivate: true,
      clip: {
        activeClipTakeId: nextTake.clipTakeId,
        id: clip.id,
      },
      clipTake: nextTake,
      status: 'ACTIVATED',
    });
  });

  it('rejects missing or duplicate Clip targets', () => {
    const missing = createAudioFixture();

    expect(
      activateClipTake(
        missing.project,
        'clip-missing',
        missing.nextTake.clipTakeId,
      ),
    ).toMatchObject({
      canActivate: false,
      reason: 'clip-not-found',
    });

    const duplicate = createAudioFixture();
    duplicate.project.tracks[0].clips.push({ ...duplicate.clip });

    expect(
      activateClipTake(
        duplicate.project,
        duplicate.clip.id,
        duplicate.nextTake.clipTakeId,
      ),
    ).toMatchObject({
      canActivate: false,
      reason: 'clip-not-found',
    });
  });

  it('rejects missing, foreign, or duplicate Clip Take IDs', () => {
    const fixture = createAudioFixture();

    expect(
      activateClipTake(
        fixture.project,
        fixture.clip.id,
        'clip-take-missing',
      ),
    ).toMatchObject({
      canActivate: false,
      reason: 'take-not-found',
    });

    const foreignTake = createAudioTake(
      createAudioArtifact('artifact-foreign', 'job-foreign'),
      'Foreign Take',
    );
    const foreignClip = findClip(fixture.project, 'clip-inst-2');

    fixture.project.artifacts?.push(
      createAudioArtifact('artifact-foreign', 'job-foreign'),
    );
    foreignClip.clipTakes = [foreignTake];

    expect(
      activateClipTake(
        fixture.project,
        fixture.clip.id,
        foreignTake.clipTakeId,
      ),
    ).toMatchObject({
      canActivate: false,
      reason: 'take-not-found',
    });

    foreignClip.clipTakes = [{ ...fixture.nextTake }];

    expect(
      activateClipTake(
        fixture.project,
        fixture.clip.id,
        fixture.nextTake.clipTakeId,
      ),
    ).toMatchObject({
      canActivate: false,
      reason: 'take-not-found',
    });
  });

  it('rejects a Take whose media type does not match the target Clip', () => {
    const fixture = createAudioFixture();
    fixture.clip.type = 'midi-notes';

    expect(
      activateClipTake(
        fixture.project,
        fixture.clip.id,
        fixture.nextTake.clipTakeId,
      ),
    ).toMatchObject({
      canActivate: false,
      reason: 'target-media-mismatch',
    });
  });

  it('rejects missing, duplicate, or source-mismatched Artifacts', () => {
    const missing = createAudioFixture();
    missing.project.artifacts = missing.project.artifacts?.filter(
      (artifact) => artifact.artifactId !== missing.nextTake.artifactId,
    );

    expect(
      activateClipTake(
        missing.project,
        missing.clip.id,
        missing.nextTake.clipTakeId,
      ),
    ).toMatchObject({
      canActivate: false,
      reason: 'artifact-invalid',
    });

    const duplicate = createAudioFixture();
    const duplicateArtifact = duplicate.project.artifacts?.find(
      (artifact) => artifact.artifactId === duplicate.nextTake.artifactId,
    );

    if (!duplicateArtifact) {
      throw new Error('Audio fixture Artifact is missing.');
    }

    duplicate.project.artifacts?.push({ ...duplicateArtifact });

    expect(
      activateClipTake(
        duplicate.project,
        duplicate.clip.id,
        duplicate.nextTake.clipTakeId,
      ),
    ).toMatchObject({
      canActivate: false,
      reason: 'artifact-invalid',
    });

    const mismatched = createAudioFixture();
    mismatched.nextTake.sourceJobId = 'job-wrong';

    expect(
      activateClipTake(
        mismatched.project,
        mismatched.clip.id,
        mismatched.nextTake.clipTakeId,
      ),
    ).toMatchObject({
      canActivate: false,
      reason: 'artifact-invalid',
    });
  });
});

describe('doesClipTakeMatchArtifact', () => {
  it('matches recording and edited MIDI source identities', () => {
    const recordingArtifact: RecordingAudioArtifact = {
      artifactId: 'artifact-recording',
      audio: {
        bitsPerSample: 16,
        channels: 1,
        durationSeconds: 1,
        mimeType: 'audio/wav',
        sampleRate: 48_000,
      },
      capture: { source: 'microphone' },
      createdAt: '2026-07-26T00:00:00.000Z',
      destination: 'recording',
      file: {
        extension: '.wav',
        name: 'recording.wav',
        relativePath: 'recordings/recording.wav',
        sizeBytes: 96_044,
      },
      kind: 'audio',
      lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    };
    const recordingTake: RecordingAudioClipTake = {
      artifactId: recordingArtifact.artifactId,
      clipTakeId: 'clip-take-recording',
      createdAt: recordingArtifact.createdAt,
      label: 'Recording Take 01',
      mediaType: 'audio',
      sourceType: 'recording',
    };
    const editedArtifact: EditedMidiArtifact = {
      artifactId: 'artifact-midi-edited',
      createdAt: '2026-07-26T00:00:01.000Z',
      editProvenance: {
        editorId: 'humstudio-piano-roll',
        editorVersion: '0.1.0',
        taskId: 'midi-edit',
      },
      kind: 'midi',
      lineage: {
        parentArtifactIds: ['artifact-midi-source'],
        parentClipTakeIds: ['clip-take-midi-source'],
      },
      midi: {
        bpm: 120,
        notes: [],
        ticksPerQuarter: 960,
      },
      sourceEditId: 'midi-edit-1',
    };
    const editedTake: EditedMidiClipTake = {
      artifactId: editedArtifact.artifactId,
      clipTakeId: 'clip-take-midi-edited',
      createdAt: editedArtifact.createdAt,
      label: 'Edited MIDI Take 01',
      mediaType: 'midi',
      sourceEditId: editedArtifact.sourceEditId,
      sourceType: 'edit',
    };

    expect(
      doesClipTakeMatchArtifact(recordingTake, recordingArtifact),
    ).toBe(true);
    expect(doesClipTakeMatchArtifact(editedTake, editedArtifact)).toBe(true);
    expect(doesClipTakeMatchArtifact(recordingTake, editedArtifact)).toBe(
      false,
    );
  });
});

type AudioFixture = Readonly<{
  clip: Clip;
  currentArtifact: GeneratedAudioArtifact;
  currentTake: GeneratedAudioClipTake;
  nextArtifact: GeneratedAudioArtifact;
  nextTake: GeneratedAudioClipTake;
  project: ProjectState;
}>;

function createAudioFixture(): AudioFixture {
  const project = cloneSampleProject();
  const clip = findClip(project, 'clip-inst-1');
  const currentArtifact = createAudioArtifact(
    'artifact-audio-current',
    'job-audio-current',
  );
  const nextArtifact = createAudioArtifact(
    'artifact-audio-next',
    'job-audio-next',
  );
  const currentTake = createAudioTake(
    currentArtifact,
    'SoundFont Render 01',
  );
  const nextTake = createAudioTake(nextArtifact, 'SoundFont Render 02');

  project.artifacts = [currentArtifact, nextArtifact];
  clip.clipTakes = [currentTake, nextTake];
  clip.activeClipTakeId = currentTake.clipTakeId;
  clip.sourceFile = {
    durationSeconds: currentArtifact.audio.durationSeconds,
    mimeType: currentArtifact.audio.mimeType,
    name: currentArtifact.file.name,
    relativePath: currentArtifact.file.relativePath,
    sizeBytes: currentArtifact.file.sizeBytes,
    sourceId: currentArtifact.artifactId,
    status: 'available',
    checkedAt: '2026-07-26T00:01:00.000Z',
  };

  return {
    clip,
    currentArtifact,
    currentTake,
    nextArtifact,
    nextTake,
    project,
  };
}

function createAudioArtifact(
  artifactId: string,
  sourceJobId: string,
): GeneratedAudioArtifact {
  return {
    artifactId,
    audio: {
      channels: 2,
      durationSeconds: 1,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-07-26T00:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: `${artifactId}.wav`,
      relativePath: `renders/instruments/${artifactId}.wav`,
      sizeBytes: 192_044,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-midi-source'],
      parentClipTakeIds: ['clip-take-midi-source'],
    },
    provenance: {
      modelId: 'mock-soundfont-v1',
      modelRevision: '1',
      parameters: {},
      providerId: 'mock-provider',
      taskId: 'midi-to-audio',
    },
    sourceJobId,
  };
}

function createAudioTake(
  artifact: GeneratedAudioArtifact,
  label: string,
): GeneratedAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: `clip-take-${artifact.artifactId}`,
    createdAt: artifact.createdAt,
    label,
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
}

function createMidiArtifact(
  artifactId: string,
  sourceJobId: string,
): GeneratedMidiArtifact {
  return {
    artifactId,
    createdAt: '2026-07-26T00:00:00.000Z',
    kind: 'midi',
    lineage: {
      parentArtifactIds: ['artifact-recording-source'],
      parentClipTakeIds: ['clip-take-recording-source'],
    },
    midi: {
      bpm: 120,
      notes: [],
      ticksPerQuarter: 960,
    },
    provenance: {
      modelId: 'mock-hum-to-midi-v1',
      modelRevision: '1',
      parameters: {},
      providerId: 'mock-provider',
      taskId: 'hum-to-midi',
    },
    sourceJobId,
  };
}

function createMidiTake(
  artifact: GeneratedMidiArtifact,
  label: string,
): GeneratedMidiClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: `clip-take-${artifact.artifactId}`,
    createdAt: artifact.createdAt,
    label,
    mediaType: 'midi',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
}

function cloneSampleProject(): ProjectState {
  return cloneProject(sampleProject);
}

function cloneProject(project: ProjectState): ProjectState {
  return JSON.parse(JSON.stringify(project)) as ProjectState;
}

function findClip(project: ProjectState, clipId: string): Clip {
  const clips = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);

  if (clips.length !== 1) {
    throw new Error(`Expected one Clip: ${clipId}.`);
  }

  return clips[0];
}

function findTrackForClip(project: ProjectState, clipId: string) {
  const tracks = project.tracks.filter((track) =>
    track.clips.some((clip) => clip.id === clipId),
  );

  if (tracks.length !== 1) {
    throw new Error(`Expected one Track for Clip: ${clipId}.`);
  }

  return tracks[0];
}
