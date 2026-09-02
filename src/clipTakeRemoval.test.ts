import { describe, expect, it } from 'vitest';

import {
  createActiveClipTakeRemovalConfirmationCopy,
  planClipTakeRemoval,
} from './clipTakeRemoval';
import { sampleProject } from './sampleProject';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  GeneratedMidiArtifact,
  GeneratedMidiClipTake,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';

describe('createActiveClipTakeRemovalConfirmationCopy', () => {
  it('does not claim that a MIDI Take owns a physical Audio file', () => {
    const clipTake = createMidiTake(
      createMidiArtifact('artifact-midi-confirmation', 'job-midi-confirmation'),
    );

    expect(createActiveClipTakeRemovalConfirmationCopy(clipTake)).toEqual({
      message: 'MIDI Take A is Active. Remove it from the Project?',
      preservationDetail:
        'This MIDI Take does not reference a physical Audio file.',
    });
  });

  it('keeps the physical Audio file preservation warning for an Audio Take', () => {
    const clipTake = createAudioTake(
      createAudioArtifact(
        'artifact-audio-confirmation',
        'job-audio-confirmation',
      ),
      'Audio Take',
    );

    expect(createActiveClipTakeRemovalConfirmationCopy(clipTake)).toEqual({
      message:
        'Audio Take is Active. Remove it from the Project while preserving its physical Audio file?',
      preservationDetail: 'The physical Audio file will be preserved.',
    });
  });
});

describe('planClipTakeRemoval', () => {
  it('removes an inactive Take and its Project Artifact while preserving the Audio file', () => {
    const fixture = createAudioFixture();
    const originalTrack = findTrackForClip(fixture.project, fixture.clip.id);
    const result = planClipTakeRemoval(fixture.project, {
      clipId: fixture.clip.id,
      clipTakeId: fixture.nextTake.clipTakeId,
      mode: 'project-only',
    });

    expect(result).toMatchObject({
      artifactDisposition: 'removed',
      canRemove: true,
      fileAction: { action: 'preserve' },
      removedArtifact: fixture.nextArtifact,
      removedClipTake: fixture.nextTake,
      status: 'READY_TO_REMOVE',
      wasActive: false,
    });

    if (!result.canRemove) {
      throw new Error(result.message);
    }

    const nextClip = findClip(result.projectAfterRemoval, fixture.clip.id);

    expect(result.projectAfterRemoval).not.toBe(fixture.project);
    expect(findTrackForClip(result.projectAfterRemoval, fixture.clip.id)).not.toBe(
      originalTrack,
    );
    expect(nextClip).not.toBe(fixture.clip);
    expect(nextClip.clipTakes).toEqual([fixture.currentTake]);
    expect(nextClip.activeClipTakeId).toBe(fixture.currentTake.clipTakeId);
    expect(nextClip.sourceFile).toBe(fixture.clip.sourceFile);
    expect(nextClip.version).toBe(fixture.clip.version + 1);
    expect(
      result.projectAfterRemoval.artifacts?.map(
        (artifact) => artifact.artifactId,
      ),
    ).toEqual([fixture.currentArtifact.artifactId]);
    expect(fixture.clip.clipTakes).toEqual([
      fixture.currentTake,
      fixture.nextTake,
    ]);
    expect(fixture.project.artifacts).toEqual([
      fixture.currentArtifact,
      fixture.nextArtifact,
    ]);
  });

  it('requires explicit confirmation before removing the Active Take', () => {
    const fixture = createAudioFixture();

    expect(
      planClipTakeRemoval(fixture.project, {
        clipId: fixture.clip.id,
        clipTakeId: fixture.currentTake.clipTakeId,
        mode: 'project-only',
      }),
    ).toEqual(
      expect.objectContaining({
        canRemove: false,
        reason: 'active-take-confirmation-required',
      }),
    );
    expect(fixture.clip.activeClipTakeId).toBe(
      fixture.currentTake.clipTakeId,
    );
  });

  it('activates the nearest remaining Take after confirmed Active removal', () => {
    const fixture = createAudioFixture();
    const result = planClipTakeRemoval(fixture.project, {
      clipId: fixture.clip.id,
      clipTakeId: fixture.currentTake.clipTakeId,
      confirmActiveTakeRemoval: true,
      mode: 'project-only',
    });

    expect(result).toMatchObject({
      canRemove: true,
      nextActiveClipTakeId: fixture.nextTake.clipTakeId,
      status: 'READY_TO_REMOVE',
      wasActive: true,
    });

    if (!result.canRemove) {
      throw new Error(result.message);
    }

    expect(
      findClip(result.projectAfterRemoval, fixture.clip.id),
    ).toMatchObject({
      activeClipTakeId: fixture.nextTake.clipTakeId,
      clipTakes: [fixture.nextTake],
      sourceFile: {
        sourceId: fixture.nextArtifact.artifactId,
        status: 'unresolved',
      },
    });
  });

  it('clears Take state when the confirmed Active Take is the only Take', () => {
    const fixture = createAudioFixture();

    fixture.clip.clipTakes = [fixture.currentTake];
    fixture.clip.activeClipTakeId = fixture.currentTake.clipTakeId;
    fixture.project.artifacts = [fixture.currentArtifact];

    const result = planClipTakeRemoval(fixture.project, {
      clipId: fixture.clip.id,
      clipTakeId: fixture.currentTake.clipTakeId,
      confirmActiveTakeRemoval: true,
      mode: 'project-only',
    });

    expect(result).toMatchObject({
      canRemove: true,
      wasActive: true,
    });

    if (!result.canRemove) {
      throw new Error(result.message);
    }

    const nextClip = findClip(result.projectAfterRemoval, fixture.clip.id);

    expect(nextClip).not.toHaveProperty('activeClipTakeId');
    expect(nextClip).not.toHaveProperty('clipTakes');
    expect(nextClip).not.toHaveProperty('sourceFile');
    expect(result.projectAfterRemoval.artifacts).toEqual([]);
  });

  it('returns a validated Audio file-deletion requirement without deleting the file', () => {
    const fixture = createAudioFixture();
    const result = planClipTakeRemoval(fixture.project, {
      clipId: fixture.clip.id,
      clipTakeId: fixture.nextTake.clipTakeId,
      mode: 'project-and-audio-file',
    });

    expect(result).toMatchObject({
      artifactDisposition: 'removed',
      canRemove: true,
      fileAction: {
        action: 'delete',
        descriptor: {
          artifactId: fixture.nextArtifact.artifactId,
          extension: '.wav',
          name: `${fixture.nextArtifact.artifactId}.wav`,
          relativePath: `renders/instruments/${fixture.nextArtifact.artifactId}.wav`,
          sizeBytes: 192_044,
          storageKind: 'generated',
        },
      },
      status: 'FILE_DELETION_REQUIRED',
    });
  });

  it('classifies a Recording Take file separately from generated Audio', () => {
    const project = cloneSampleProject();
    const clip = findClip(project, 'clip-hum-1');
    const artifact = createRecordingArtifact();
    const clipTake = createRecordingTake(artifact);

    project.artifacts = [artifact];
    clip.clipTakes = [clipTake];
    clip.activeClipTakeId = clipTake.clipTakeId;

    const result = planClipTakeRemoval(project, {
      clipId: clip.id,
      clipTakeId: clipTake.clipTakeId,
      confirmActiveTakeRemoval: true,
      mode: 'project-and-audio-file',
    });

    expect(result).toMatchObject({
      canRemove: true,
      fileAction: {
        action: 'delete',
        descriptor: {
          artifactId: artifact.artifactId,
          relativePath: 'recordings/artifact-recording-target.wav',
          storageKind: 'recording',
        },
      },
      status: 'FILE_DELETION_REQUIRED',
    });
  });

  it('does not offer physical file deletion for a MIDI Take', () => {
    const project = cloneSampleProject();
    const clip = findClip(project, 'clip-midi-1');
    const artifact = createMidiArtifact(
      'artifact-midi-target',
      'job-midi-target',
    );
    const clipTake = createMidiTake(artifact);

    project.artifacts = [artifact];
    clip.clipTakes = [clipTake];
    clip.activeClipTakeId = clipTake.clipTakeId;

    expect(
      planClipTakeRemoval(project, {
        clipId: clip.id,
        clipTakeId: clipTake.clipTakeId,
        confirmActiveTakeRemoval: true,
        mode: 'project-and-audio-file',
      }),
    ).toMatchObject({
      canRemove: false,
      reason: 'target-not-audio',
    });
  });

  it('preserves a shared Artifact and blocks deletion of its Audio file', () => {
    const fixture = createAudioFixture();
    const foreignClip = findClip(fixture.project, 'clip-inst-2');
    const sharedTake: GeneratedAudioClipTake = {
      ...fixture.nextTake,
      clipTakeId: 'clip-take-shared-audio',
      label: 'Shared Audio Take',
    };

    foreignClip.clipTakes = [sharedTake];
    foreignClip.activeClipTakeId = sharedTake.clipTakeId;

    const projectOnly = planClipTakeRemoval(fixture.project, {
      clipId: fixture.clip.id,
      clipTakeId: fixture.nextTake.clipTakeId,
      mode: 'project-only',
    });

    expect(projectOnly).toMatchObject({
      artifactDisposition: 'preserved-shared',
      canRemove: true,
      fileAction: { action: 'preserve' },
    });

    if (!projectOnly.canRemove) {
      throw new Error(projectOnly.message);
    }

    expect(
      projectOnly.projectAfterRemoval.artifacts?.some(
        (artifact) =>
          artifact.artifactId === fixture.nextArtifact.artifactId,
      ),
    ).toBe(true);

    expect(
      planClipTakeRemoval(fixture.project, {
        clipId: fixture.clip.id,
        clipTakeId: fixture.nextTake.clipTakeId,
        mode: 'project-and-audio-file',
      }),
    ).toMatchObject({
      canRemove: false,
      reason: 'artifact-still-referenced',
    });
  });

  it('preserves upstream and downstream Artifacts and reports direct broken lineage', () => {
    const fixture = createAudioFixture();
    const parentArtifact = createMidiArtifact(
      'artifact-midi-source',
      'job-midi-source',
    );
    const descendant = createAudioArtifact(
      'artifact-audio-descendant',
      'job-audio-descendant',
      {
        parentArtifactIds: [fixture.nextArtifact.artifactId],
        parentClipTakeIds: [fixture.nextTake.clipTakeId],
      },
    );

    fixture.project.artifacts = [
      parentArtifact,
      fixture.currentArtifact,
      fixture.nextArtifact,
      descendant,
    ];

    const result = planClipTakeRemoval(fixture.project, {
      clipId: fixture.clip.id,
      clipTakeId: fixture.nextTake.clipTakeId,
      mode: 'project-only',
    });

    expect(result).toMatchObject({
      canRemove: true,
      directDescendantArtifactIds: [descendant.artifactId],
    });

    if (!result.canRemove) {
      throw new Error(result.message);
    }

    expect(
      result.projectAfterRemoval.artifacts?.map(
        (artifact) => artifact.artifactId,
      ),
    ).toEqual([
      parentArtifact.artifactId,
      fixture.currentArtifact.artifactId,
      descendant.artifactId,
    ]);
    expect(
      result.projectAfterRemoval.artifacts?.find(
        (artifact) => artifact.artifactId === descendant.artifactId,
      )?.lineage,
    ).toEqual({
      parentArtifactIds: [fixture.nextArtifact.artifactId],
      parentClipTakeIds: [fixture.nextTake.clipTakeId],
    });
  });

  it('allows project-only cleanup of a Take with an unresolved Artifact', () => {
    const fixture = createAudioFixture();

    fixture.project.artifacts = [fixture.currentArtifact];

    const cleanup = planClipTakeRemoval(fixture.project, {
      clipId: fixture.clip.id,
      clipTakeId: fixture.nextTake.clipTakeId,
      mode: 'project-only',
    });

    expect(cleanup).toMatchObject({
      artifactDisposition: 'unresolved',
      canRemove: true,
      fileAction: { action: 'preserve' },
    });
    expect(
      planClipTakeRemoval(fixture.project, {
        clipId: fixture.clip.id,
        clipTakeId: fixture.nextTake.clipTakeId,
        mode: 'project-and-audio-file',
      }),
    ).toMatchObject({
      canRemove: false,
      reason: 'artifact-invalid',
    });
  });

  it('rejects missing, foreign, and duplicate Clip or Take targets', () => {
    const fixture = createAudioFixture();

    expect(
      planClipTakeRemoval(fixture.project, {
        clipId: 'clip-missing',
        clipTakeId: fixture.nextTake.clipTakeId,
        mode: 'project-only',
      }),
    ).toMatchObject({
      canRemove: false,
      reason: 'clip-not-found',
    });
    expect(
      planClipTakeRemoval(fixture.project, {
        clipId: fixture.clip.id,
        clipTakeId: 'clip-take-missing',
        mode: 'project-only',
      }),
    ).toMatchObject({
      canRemove: false,
      reason: 'take-not-found',
    });

    const foreignClip = findClip(fixture.project, 'clip-inst-2');

    foreignClip.clipTakes = [
      createAudioTake(
        createAudioArtifact('artifact-foreign', 'job-foreign'),
        'Foreign Take',
      ),
    ];

    expect(
      planClipTakeRemoval(fixture.project, {
        clipId: fixture.clip.id,
        clipTakeId: foreignClip.clipTakes[0].clipTakeId,
        mode: 'project-only',
      }),
    ).toMatchObject({
      canRemove: false,
      reason: 'take-not-found',
    });

    foreignClip.clipTakes = [{ ...fixture.nextTake }];

    expect(
      planClipTakeRemoval(fixture.project, {
        clipId: fixture.clip.id,
        clipTakeId: fixture.nextTake.clipTakeId,
        mode: 'project-only',
      }),
    ).toMatchObject({
      canRemove: false,
      reason: 'take-not-found',
    });

    fixture.project.tracks[0].clips.push({ ...fixture.clip });

    expect(
      planClipTakeRemoval(fixture.project, {
        clipId: fixture.clip.id,
        clipTakeId: fixture.currentTake.clipTakeId,
        confirmActiveTakeRemoval: true,
        mode: 'project-only',
      }),
    ).toMatchObject({
      canRemove: false,
      reason: 'clip-not-found',
    });
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
  const nextTake = createAudioTake(
    nextArtifact,
    'SoundFont Render 02',
  );

  project.artifacts = [currentArtifact, nextArtifact];
  clip.clipTakes = [currentTake, nextTake];
  clip.activeClipTakeId = currentTake.clipTakeId;
  clip.sourceFile = {
    checkedAt: '2026-07-27T00:01:00.000Z',
    durationSeconds: currentArtifact.audio.durationSeconds,
    mimeType: currentArtifact.audio.mimeType,
    name: currentArtifact.file.name,
    relativePath: currentArtifact.file.relativePath,
    sizeBytes: currentArtifact.file.sizeBytes,
    sourceId: currentArtifact.artifactId,
    status: 'available',
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
  lineage: GeneratedAudioArtifact['lineage'] = {
    parentArtifactIds: ['artifact-midi-source'],
    parentClipTakeIds: ['clip-take-midi-source'],
  },
): GeneratedAudioArtifact {
  return {
    artifactId,
    audio: {
      channels: 2,
      durationSeconds: 1,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-07-27T00:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: `${artifactId}.wav`,
      relativePath: `renders/instruments/${artifactId}.wav`,
      sizeBytes: 192_044,
    },
    kind: 'audio',
    lineage,
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
    createdAt: '2026-07-27T00:00:00.000Z',
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
): GeneratedMidiClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: `clip-take-${artifact.artifactId}`,
    createdAt: artifact.createdAt,
    label: 'MIDI Take A',
    mediaType: 'midi',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
}

function createRecordingArtifact(): RecordingAudioArtifact {
  return {
    artifactId: 'artifact-recording-target',
    audio: {
      bitsPerSample: 16,
      channels: 1,
      durationSeconds: 1,
      mimeType: 'audio/wav',
      sampleRate: 48_000,
    },
    capture: { source: 'microphone' },
    createdAt: '2026-07-27T00:00:00.000Z',
    destination: 'recording',
    file: {
      extension: '.wav',
      name: 'artifact-recording-target.wav',
      relativePath: 'recordings/artifact-recording-target.wav',
      sizeBytes: 96_044,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
  };
}

function createRecordingTake(
  artifact: RecordingAudioArtifact,
): RecordingAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: `clip-take-${artifact.artifactId}`,
    createdAt: artifact.createdAt,
    label: 'Recording Take 01',
    mediaType: 'audio',
    sourceType: 'recording',
  };
}

function cloneSampleProject(): ProjectState {
  return JSON.parse(JSON.stringify(sampleProject)) as ProjectState;
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
