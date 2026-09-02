import { describe, expect, it } from 'vitest';

import { resolveActiveInstrumentAudioTake } from './activeInstrumentAudioTake';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  GeneratedMidiArtifact,
  GeneratedMidiClipTake,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';

describe('resolveActiveInstrumentAudioTake', () => {
  it('resolves an immutable generated source plan for Preview and Audio-to-Audio', () => {
    const resolution = resolveActiveInstrumentAudioTake(
      createProject(),
      'clip-instrument',
    );

    expect(resolution).toMatchObject({
      canResolve: true,
      plan: {
        audio: {
          channels: 2,
          durationSeconds: 1.1,
          mimeType: 'audio/wav',
        },
        descriptor: {
          kind: 'generated',
          name: 'artifact-instrument.wav',
          relativePath: 'renders/instruments/artifact-instrument.wav',
          sizeBytes: 35_244,
          sourceId: 'artifact-instrument',
        },
        midiSource: {
          artifactId: 'artifact-midi',
          clipId: 'clip-midi',
          clipTakeId: 'clip-take-midi',
        },
        source: {
          artifactId: 'artifact-instrument',
          clipId: 'clip-instrument',
          clipTakeId: 'clip-take-instrument',
          sourceJobId: 'job-instrument',
        },
      },
    });

    if (!resolution.canResolve) {
      throw new Error(resolution.message);
    }

    expect(Object.isFrozen(resolution.plan)).toBe(true);
    expect(Object.isFrozen(resolution.plan.audio)).toBe(true);
    expect(Object.isFrozen(resolution.plan.descriptor)).toBe(true);
    expect(Object.isFrozen(resolution.plan.file)).toBe(true);
    expect(Object.isFrozen(resolution.plan.source)).toBe(true);
  });

  it('requires one Instrument Audio Clip with one selected Active Take', () => {
    const wrongType = createProject();
    findClip(wrongType, 'clip-instrument').type = 'arrangement';

    expect(
      resolveActiveInstrumentAudioTake(wrongType, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'target-not-instrument-audio',
    });

    const noActive = createProject();
    findClip(noActive, 'clip-instrument').activeClipTakeId = undefined;

    expect(
      resolveActiveInstrumentAudioTake(noActive, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-selected',
    });
  });

  it('rejects missing, duplicate, or non-Audio Active Take references', () => {
    const missing = createProject();
    findClip(missing, 'clip-instrument').activeClipTakeId =
      'clip-take-missing';

    expect(
      resolveActiveInstrumentAudioTake(missing, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-found',
    });

    const duplicate = createProject();
    const instrumentClip = findClip(duplicate, 'clip-instrument');
    instrumentClip.clipTakes = [
      ...(instrumentClip.clipTakes ?? []),
      { ...(instrumentClip.clipTakes?.[0] as GeneratedAudioClipTake) },
    ];

    expect(
      resolveActiveInstrumentAudioTake(duplicate, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-found',
    });

    const wrongMedia = createProject();
    const midiTake = findClip(wrongMedia, 'clip-midi')
      .clipTakes?.[0] as GeneratedMidiClipTake;
    findClip(wrongMedia, 'clip-instrument').clipTakes = [midiTake];
    findClip(wrongMedia, 'clip-instrument').activeClipTakeId =
      midiTake.clipTakeId;

    expect(
      resolveActiveInstrumentAudioTake(wrongMedia, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-audio',
    });
  });

  it('rejects missing, non-Audio, and source-mismatched Artifacts', () => {
    const missing = createProject();
    missing.artifacts = missing.artifacts?.filter(
      (artifact) => artifact.artifactId !== 'artifact-instrument',
    );

    expect(
      resolveActiveInstrumentAudioTake(missing, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'artifact-not-found',
    });

    const wrongKind = createProject();
    const activeTake = findClip(wrongKind, 'clip-instrument')
      .clipTakes?.[0] as GeneratedAudioClipTake;
    activeTake.artifactId = 'artifact-midi';

    expect(
      resolveActiveInstrumentAudioTake(wrongKind, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'artifact-not-audio',
    });

    const wrongSource = createProject();
    const wrongSourceTake = findClip(wrongSource, 'clip-instrument')
      .clipTakes?.[0] as GeneratedAudioClipTake;
    wrongSourceTake.sourceJobId = 'job-other';

    expect(
      resolveActiveInstrumentAudioTake(wrongSource, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'source-mismatch',
    });
  });

  it('rejects unavailable or stale source MIDI Lineage', () => {
    const unlinked = createProject();
    findClip(unlinked, 'clip-instrument').sourceClipId = undefined;

    expect(
      resolveActiveInstrumentAudioTake(unlinked, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'source-midi-unavailable',
    });

    const stale = createProject();
    const midiClip = findClip(stale, 'clip-midi');
    midiClip.activeClipTakeId = 'clip-take-midi-new';
    midiClip.clipTakes?.push({
      ...createMidiTake(),
      artifactId: 'artifact-midi-new',
      clipTakeId: 'clip-take-midi-new',
      sourceJobId: 'job-midi-new',
    });
    stale.artifacts?.push({
      ...createMidiArtifact(),
      artifactId: 'artifact-midi-new',
      sourceJobId: 'job-midi-new',
    });

    expect(
      resolveActiveInstrumentAudioTake(stale, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'lineage-invalid',
    });
  });

  it('rejects invalid render provenance and audio metadata', () => {
    const wrongTask = createProject();
    findInstrumentArtifact(wrongTask).provenance.taskId =
      'mock-audio-generation';

    expect(
      resolveActiveInstrumentAudioTake(wrongTask, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'artifact-invalid',
    });

    const wrongChannels = createProject();
    findInstrumentArtifact(wrongChannels).audio.channels = 1;

    expect(
      resolveActiveInstrumentAudioTake(wrongChannels, 'clip-instrument'),
    ).toMatchObject({
      canResolve: false,
      reason: 'artifact-invalid',
    });
  });

  it('rejects paths outside the generated Instrument directory', () => {
    for (const relativePath of [
      '../outside.wav',
      'renders/instruments/../outside.wav',
      'renders/instruments/staging.partial',
      'renders/stable-audio-3/artifact-instrument.wav',
    ]) {
      const project = createProject();
      findInstrumentArtifact(project).file.relativePath = relativePath;

      expect(
        resolveActiveInstrumentAudioTake(project, 'clip-instrument'),
      ).toMatchObject({
        canResolve: false,
        reason: 'file-invalid',
      });
    }
  });
});

function createProject(): ProjectState {
  const recordingArtifact = createRecordingArtifact();
  const recordingTake = createRecordingTake();
  const midiArtifact = createMidiArtifact();
  const midiTake = createMidiTake();
  const instrumentArtifact = createInstrumentArtifact();
  const instrumentTake = createInstrumentTake();

  return {
    artifacts: [recordingArtifact, midiArtifact, instrumentArtifact],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'Active Instrument Take Test',
    patchTabs: [],
    playheadTick: 0,
    recordingSettings: {
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: '',
    selection: {
      items: [],
    },
    status: 'READY',
    takes: [],
    totalTicks: 7_680,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: recordingTake.clipTakeId,
            clipTakes: [recordingTake],
            color: '#ff8c5a',
            createdAt: recordingArtifact.createdAt,
            id: 'clip-audio',
            lengthTicks: 1_920,
            name: 'Hum Audio',
            startTick: 0,
            type: 'hum-audio',
            version: 1,
          },
        ],
        id: 'track-audio',
        level: -6,
        name: 'Hum Audio',
        type: 'audio',
      },
      {
        clips: [
          {
            activeClipTakeId: midiTake.clipTakeId,
            clipTakes: [midiTake],
            color: '#4de1ff',
            createdAt: midiArtifact.createdAt,
            id: 'clip-midi',
            lengthTicks: 1_920,
            name: 'MIDI Notes',
            sourceClipId: 'clip-audio',
            startTick: 0,
            type: 'midi-notes',
            version: 1,
          },
        ],
        id: 'track-midi',
        level: -6,
        name: 'MIDI Notes',
        type: 'midi',
      },
      {
        clips: [
          {
            activeClipTakeId: instrumentTake.clipTakeId,
            clipTakes: [instrumentTake],
            color: '#8dff6b',
            createdAt: instrumentArtifact.createdAt,
            id: 'clip-instrument',
            lengthTicks: 1_920,
            name: 'Instrument Audio',
            sourceClipId: 'clip-midi',
            startTick: 0,
            type: 'instrument-audio',
            version: 1,
          },
        ],
        id: 'track-instrument',
        level: -5,
        name: 'Instrument Audio',
        type: 'audio',
      },
    ],
  };
}

function createRecordingArtifact(): RecordingAudioArtifact {
  return {
    artifactId: 'artifact-recording',
    audio: {
      bitsPerSample: 16,
      channels: 1,
      durationSeconds: 1,
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
      sizeBytes: 96_044,
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
    artifactId: 'artifact-recording',
    clipTakeId: 'clip-take-recording',
    createdAt: '2026-07-26T08:00:00.000Z',
    label: 'Recording Take 01',
    mediaType: 'audio',
    sourceType: 'recording',
  };
}

function createMidiArtifact(): GeneratedMidiArtifact {
  return {
    artifactId: 'artifact-midi',
    createdAt: '2026-07-26T08:01:00.000Z',
    kind: 'midi',
    lineage: {
      parentArtifactIds: ['artifact-recording'],
      parentClipTakeIds: ['clip-take-recording'],
    },
    midi: {
      bpm: 120,
      notes: [
        {
          id: 'note-a',
          lengthTicks: 960,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
      ],
      ticksPerQuarter: 960,
    },
    provenance: {
      modelId: 'mock-hum-to-midi-v1',
      modelRevision: '1',
      parameters: {},
      providerId: 'mock-provider',
      taskId: 'hum-to-midi',
    },
    sourceJobId: 'job-midi',
  };
}

function createMidiTake(): GeneratedMidiClipTake {
  return {
    artifactId: 'artifact-midi',
    clipTakeId: 'clip-take-midi',
    createdAt: '2026-07-26T08:01:00.000Z',
    label: 'MIDI Take 01',
    mediaType: 'midi',
    sourceJobId: 'job-midi',
    sourceType: 'job',
  };
}

function createInstrumentArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-instrument',
    audio: {
      channels: 2,
      durationSeconds: 1.1,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-07-26T08:02:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-instrument.wav',
      relativePath: 'renders/instruments/artifact-instrument.wav',
      sizeBytes: 35_244,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-midi'],
      parentClipTakeIds: ['clip-take-midi'],
    },
    provenance: {
      modelId: 'mock-soundfont-v1',
      modelRevision: '1',
      parameters: {
        channels: 2,
        gainDb: -3,
        preset: {
          bank: 0,
          program: 24,
        },
        providerVersion: '1',
        sampleRate: 8_000,
      },
      providerId: 'mock-provider',
      taskId: 'midi-to-audio',
    },
    sourceJobId: 'job-instrument',
  };
}

function createInstrumentTake(): GeneratedAudioClipTake {
  return {
    artifactId: 'artifact-instrument',
    clipTakeId: 'clip-take-instrument',
    createdAt: '2026-07-26T08:02:00.000Z',
    label: 'SoundFont Render 01',
    mediaType: 'audio',
    sourceJobId: 'job-instrument',
    sourceType: 'job',
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

function findInstrumentArtifact(project: ProjectState) {
  const artifact = project.artifacts?.find(
    (candidate) => candidate.artifactId === 'artifact-instrument',
  );

  if (!artifact || artifact.kind !== 'audio' || !('provenance' in artifact)) {
    throw new Error('Instrument Artifact fixture is missing.');
  }

  return artifact;
}
