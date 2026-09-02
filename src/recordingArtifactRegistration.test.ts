import { describe, expect, it } from 'vitest';

import type { LocalEngineRecordingArtifact } from './localEngineClient';
import {
  normalizeClipTakeState,
  normalizeProjectArtifacts,
} from './projectArtifactRegistration';
import { sampleProject } from './sampleProject';
import {
  createRecordingArtifactRegistration,
  type RecordingArtifactRegistrationUpdate,
} from './recordingArtifactRegistration';
import type { ProjectState } from './types';

describe('createRecordingArtifactRegistration', () => {
  it('creates one Hum Clip with one active Recording Take and source metadata', () => {
    const project = cloneSampleProject();
    const originalHumTrack = findTrack(project, 'hum-audio');
    originalHumTrack.clips = [];
    const update = createRecordingArtifactRegistration(
      project,
      createRecordingArtifact(),
      {
        inputDeviceId: 'microphone-a',
        inputDeviceLabel: 'Studio Microphone',
        startTick: 960,
      },
    );
    const registered = requireRegistration(update);

    expect(registered).toMatchObject({
      artifact: {
        artifactId: 'artifact-recording-a',
        capture: {
          inputDeviceId: 'microphone-a',
          inputDeviceLabel: 'Studio Microphone',
          source: 'microphone',
        },
        destination: 'recording',
      },
      clip: {
        audioTiming: {
          sourceEndSeconds: 1.5,
          sourceStartSeconds: 0,
          timeBase: 'absolute-seconds',
        },
        generatedBy: 'Microphone Recording',
        lengthTicks: 2_880,
        name: 'Hum Part 01',
        sourceFile: {
          relativePath: 'recordings/artifact-recording-a.wav',
          sourceId: 'artifact-recording-a',
          status: 'available',
        },
        startTick: 960,
      },
      clipTake: {
        artifactId: 'artifact-recording-a',
        label: 'Recording Take 01',
        sourceType: 'recording',
      },
      status: 'REGISTERED',
    });
    expect(registered.project.artifacts).toEqual([registered.artifact]);
    expect(findTrack(registered.project, 'hum-audio').clips).toEqual([registered.clip]);
    expect(registered.clip.activeClipTakeId).toBe(registered.clipTake.clipTakeId);
    expect(project.artifacts).toBeUndefined();
    expect(originalHumTrack.clips).toEqual([]);
  });

  it('adds another Recording Take to the same Hum Clip and activates it', () => {
    const first = requireRegistration(
      createRecordingArtifactRegistration(
        createProjectWithEmptyHumTrack(),
        createRecordingArtifact(),
        { startTick: 0 },
      ),
    );
    const second = requireRegistration(
      createRecordingArtifactRegistration(
        first.project,
        createRecordingArtifact({
          artifactId: 'artifact-recording-b',
          durationSeconds: 2,
          name: 'artifact-recording-b.wav',
          relativePath: 'recordings/artifact-recording-b.wav',
        }),
        { startTick: 9_999, targetClipId: first.clip.id },
      ),
    );

    expect(findTrack(second.project, 'hum-audio').clips).toHaveLength(1);
    expect(second.clip.clipTakes).toEqual([first.clipTake, second.clipTake]);
    expect(second.clipTake.label).toBe('Recording Take 02');
    expect(second.clip.activeClipTakeId).toBe(second.clipTake.clipTakeId);
    expect(second.clip.startTick).toBe(first.clip.startTick);
    expect(second.clip.lengthTicks).toBe(3_840);
    expect(second.clip.sourceFile?.sourceId).toBe('artifact-recording-b');
    expect(second.project.artifacts).toEqual([first.artifact, second.artifact]);
  });

  it('registers a new Recording Clip on one selected blank Track', () => {
    const project = cloneSampleProject();
    project.tracks.push({
      id: 'track-new',
      name: 'Track New',
      type: 'blank',
      level: 0,
      clips: [],
    });
    const originalHumClipCount = findTrack(project, 'hum-audio').clips.length;
    const registered = requireRegistration(
      createRecordingArtifactRegistration(
        project,
        createRecordingArtifact(),
        {
          startTick: 960,
          targetTrackId: 'track-new',
        },
      ),
    );

    expect(findTrack(registered.project, 'track-new')).toMatchObject({
      clips: [registered.clip],
      type: 'audio',
    });
    expect(findTrack(registered.project, 'hum-audio').clips).toHaveLength(
      originalHumClipCount,
    );
  });

  it('rejects missing and non-recordable target Tracks', () => {
    const project = cloneSampleProject();
    const nonRecordableTrack = project.tracks.find(
      (track) => track.type !== 'audio' && track.type !== 'blank',
    );

    if (!nonRecordableTrack) {
      throw new Error('A non-recordable sample Track is required.');
    }

    expect(
      createRecordingArtifactRegistration(project, createRecordingArtifact(), {
        startTick: 0,
        targetTrackId: 'missing-track',
      }),
    ).toMatchObject({ canRegister: false, reason: 'track-not-found' });
    expect(
      createRecordingArtifactRegistration(project, createRecordingArtifact(), {
        startTick: 0,
        targetTrackId: nonRecordableTrack.id,
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'target-not-recordable-track',
    });
  });

  it('clips a recorded Take to the reserved free Timeline range', () => {
    const project = createProjectWithEmptyHumTrack();
    const registered = requireRegistration(
      createRecordingArtifactRegistration(
        project,
        createRecordingArtifact({ durationSeconds: 4 }),
        {
          maximumEndTick: 2_880,
          startTick: 960,
        },
      ),
    );

    expect(registered.clip).toMatchObject({
      audioTiming: {
        sourceEndSeconds: 1,
        sourceStartSeconds: 0,
      },
      lengthTicks: 1_920,
      startTick: 960,
    });
    expect(registered.artifact.audio.durationSeconds).toBe(4);
  });

  it('is idempotent for the same Artifact and target Clip', () => {
    const first = requireRegistration(
      createRecordingArtifactRegistration(
        createProjectWithEmptyHumTrack(),
        createRecordingArtifact(),
        { startTick: 0 },
      ),
    );
    const repeated = requireRegistration(
      createRecordingArtifactRegistration(
        first.project,
        createRecordingArtifact(),
        { startTick: 0, targetClipId: first.clip.id },
      ),
    );

    expect(repeated.status).toBe('ALREADY_REGISTERED');
    expect(repeated.project).toBe(first.project);
    expect(repeated.artifact).toBe(first.artifact);
    expect(repeated.clip).toBe(first.clip);
    expect(repeated.clipTake).toBe(first.clipTake);
  });

  it('blocks duplicate Artifact registration on a different Hum Clip', () => {
    const project = cloneSampleProject();
    const alternateClip = findTrack(project, 'hum-audio').clips.find(
      (clip) => clip.type === 'hum-audio',
    );

    if (!alternateClip) {
      throw new Error('Sample Hum Clip is missing.');
    }

    const first = requireRegistration(
      createRecordingArtifactRegistration(project, createRecordingArtifact(), {
        startTick: 0,
      }),
    );
    expect(
      createRecordingArtifactRegistration(first.project, createRecordingArtifact(), {
        startTick: 0,
        targetClipId: alternateClip.id,
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'artifact-conflict',
    });
  });

  it('rejects missing, non-Hum, and malformed targets without changing Project state', () => {
    const project = cloneSampleProject();

    expect(
      createRecordingArtifactRegistration(project, createRecordingArtifact(), {
        startTick: 0,
        targetClipId: 'clip-missing',
      }),
    ).toMatchObject({ canRegister: false, reason: 'clip-not-found' });
    expect(
      createRecordingArtifactRegistration(project, createRecordingArtifact(), {
        startTick: 0,
        targetClipId: 'clip-midi-1',
      }),
    ).toMatchObject({ canRegister: false, reason: 'target-not-hum-audio' });
    expect(
      createRecordingArtifactRegistration(
        project,
        { ...createRecordingArtifact(), destination: 'instrument' } as never,
        { startTick: 0 },
      ),
    ).toMatchObject({ canRegister: false, reason: 'recording-invalid' });
    expect(project.artifacts).toBeUndefined();
  });

  it('round-trips multiple Recording Artifacts and Takes through Project normalization', () => {
    const first = requireRegistration(
      createRecordingArtifactRegistration(
        createProjectWithEmptyHumTrack(),
        createRecordingArtifact(),
        { startTick: 0 },
      ),
    );
    const second = requireRegistration(
      createRecordingArtifactRegistration(
        first.project,
        createRecordingArtifact({
          artifactId: 'artifact-recording-b',
          name: 'artifact-recording-b.wav',
          relativePath: 'recordings/artifact-recording-b.wav',
        }),
        { startTick: 0, targetClipId: first.clip.id },
      ),
    );
    const serializedArtifacts = JSON.parse(JSON.stringify(second.project.artifacts));
    const serializedTakes = JSON.parse(JSON.stringify(second.clip.clipTakes));

    expect(
      normalizeProjectArtifacts([
        ...serializedArtifacts,
        serializedArtifacts[0],
      ]),
    ).toEqual([first.artifact, second.artifact]);
    expect(
      normalizeClipTakeState(serializedTakes, second.clipTake.clipTakeId),
    ).toEqual({
      activeClipTakeId: second.clipTake.clipTakeId,
      clipTakes: [first.clipTake, second.clipTake],
    });
  });

  it('creates the Hum Audio Track when a Project does not have one', () => {
    const project = cloneSampleProject();
    project.tracks = project.tracks.filter((track) => track.id !== 'hum-audio');
    const registered = requireRegistration(
      createRecordingArtifactRegistration(project, createRecordingArtifact(), {
        startTick: 0,
      }),
    );

    expect(registered.project.tracks[0]).toMatchObject({
      id: 'hum-audio',
      clips: [registered.clip],
    });
  });
});

function createProjectWithEmptyHumTrack(): ProjectState {
  const project = cloneSampleProject();
  findTrack(project, 'hum-audio').clips = [];
  return project;
}

function createRecordingArtifact(
  overrides: Readonly<{
    artifactId?: string;
    durationSeconds?: number;
    name?: string;
    relativePath?: string;
  }> = {},
): LocalEngineRecordingArtifact {
  const artifactId = overrides.artifactId ?? 'artifact-recording-a';
  const name = overrides.name ?? `${artifactId}.wav`;

  return {
    artifactId,
    audio: {
      bitsPerSample: 16,
      channels: 1,
      durationSeconds: overrides.durationSeconds ?? 1.5,
      mimeType: 'audio/wav',
      sampleRate: 48_000,
    },
    createdAt: '2026-07-24T00:00:00.000Z',
    destination: 'recording',
    file: {
      extension: '.wav',
      name,
      relativePath: overrides.relativePath ?? `recordings/${name}`,
      sizeBytes: 144_044,
    },
    kind: 'audio',
    status: 'FINALIZED',
  };
}

function requireRegistration(
  update: RecordingArtifactRegistrationUpdate,
): Extract<RecordingArtifactRegistrationUpdate, { canRegister: true }> {
  if (!update.canRegister) {
    throw new Error(update.message);
  }

  return update;
}

function cloneSampleProject(): ProjectState {
  return JSON.parse(JSON.stringify(sampleProject)) as ProjectState;
}

function findTrack(project: ProjectState, trackId: string) {
  const track = project.tracks.find((candidate) => candidate.id === trackId);

  if (!track) {
    throw new Error(`Test Track not found: ${trackId}.`);
  }

  return track;
}
