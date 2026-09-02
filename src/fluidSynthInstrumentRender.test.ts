import { describe, expect, it } from 'vitest';

import { createFluidSynthInstrumentRenderPlan } from './fluidSynthInstrumentRender';
import { createSoundFontPatchTab } from './soundFontPatchTab';
import type {
  GeneratedMidiArtifact,
  GeneratedMidiClipTake,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';

describe('createFluidSynthInstrumentRenderPlan', () => {
  it('snapshots the Active MIDI Take and matching Clip SoundFont revision', () => {
    const result = createFluidSynthInstrumentRenderPlan(
      createProject(),
      'clip-midi',
      [createCatalogResource()],
    );

    expect(result).toMatchObject({
      canPlan: true,
      plan: {
        request: {
          lineage: {
            parentArtifactIds: ['artifact-midi'],
            parentClipTakeIds: ['clip-take-midi'],
          },
          modelId: 'soundfont-0123456789abcdef0123456789abcdef',
          modelRevision: 'a'.repeat(64),
          parameters: {
            gainDb: -14,
            preset: { bank: 128, program: 24 },
            sampleRate: 48_000,
            soundFont: {
              format: 'sf2',
              library: 'project',
              relativePath: 'soundfonts/Test.sf2',
              revisionToken: 'a'.repeat(64),
            },
          },
          providerId: 'local-fluidsynth',
          taskId: 'midi-to-audio',
        },
        sourceClipId: 'clip-midi',
      },
    });
  });

  it('blocks an unassigned or offline SoundFont before enqueueing', () => {
    const unassigned = createProject();
    delete findMidiClip(unassigned).soundFont;

    expect(
      createFluidSynthInstrumentRenderPlan(
        unassigned,
        'clip-midi',
        [createCatalogResource()],
      ),
    ).toMatchObject({
      canPlan: false,
      reason: 'soundfont-unassigned',
    });
    expect(
      createFluidSynthInstrumentRenderPlan(
        createProject(),
        'clip-midi',
        [],
      ),
    ).toMatchObject({
      canPlan: false,
      reason: 'soundfont-offline',
    });
  });

  it('renders from the connected SoundFont PatchTab without a Piano Roll assignment', () => {
    const project = createProject();
    const soundFontPatchTab = createSoundFontPatchTab();
    soundFontPatchTab.parameters = soundFontPatchTab.parameters.map((parameter) => {
      if (parameter.id === 'soundfont-resource' && parameter.kind === 'select') {
        return { ...parameter, options: ['soundfonts/Test.sf2'], value: 'soundfonts/Test.sf2' };
      }

      if (parameter.id === 'program' && parameter.kind === 'number') {
        return { ...parameter, value: 5 };
      }

      return parameter;
    });
    project.patchTabs = [
      soundFontPatchTab,
      {
        colorIndex: 1,
        description: '',
        id: 'instrument',
        inputType: 'Edited MIDI',
        name: 'MIDI TO AUDIO',
        nodeTypeId: 'humstudio.patch.instrument',
        nodeVersion: '1.0.0',
        outputType: 'Instrument Audio',
        parameters: [],
        status: 'ready',
      },
    ];
    project.connections = [
      {
        activation: 'on',
        enabled: true,
        fromPatchTabId: 'soundfont',
        fromPortId: 'soundfont-out',
        id: 'soundfont-to-instrument',
        latencyMs: 0,
        order: 0,
        signalType: 'SOUNDFONT',
        toPatchTabId: 'instrument',
        toPortId: 'soundfont-in',
      },
    ];
    delete findMidiClip(project).soundFont;

    expect(
      createFluidSynthInstrumentRenderPlan(
        project,
        'clip-midi',
        [createCatalogResource()],
        'instrument',
      ),
    ).toMatchObject({
      canPlan: true,
      plan: {
        request: {
          parameters: { preset: { bank: 0, program: 5 } },
        },
      },
    });
  });

  it('blocks an empty Active MIDI Take before creating a render request', () => {
    const project = createProject();
    const midiArtifact = project.artifacts?.find(
      (artifact) => artifact.artifactId === 'artifact-midi',
    );

    if (!midiArtifact || midiArtifact.kind !== 'midi') {
      throw new Error('MIDI artifact fixture is missing.');
    }

    midiArtifact.midi.notes = [];

    expect(
      createFluidSynthInstrumentRenderPlan(
        project,
        'clip-midi',
        [createCatalogResource()],
      ),
    ).toEqual({
      canPlan: false,
      message: 'At least one MIDI note is required.',
      reason: 'active-midi-empty',
    });
  });
});

function createProject(): ProjectState {
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
    createdAt: '2026-07-28T08:00:00.000Z',
    destination: 'recording',
    file: {
      extension: '.wav',
      name: 'artifact-recording.wav',
      relativePath: 'recordings/artifact-recording.wav',
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
  const midiArtifact: GeneratedMidiArtifact = {
    artifactId: 'artifact-midi',
    createdAt: '2026-07-28T08:01:00.000Z',
    kind: 'midi',
    lineage: {
      parentArtifactIds: [recordingArtifact.artifactId],
      parentClipTakeIds: [recordingTake.clipTakeId],
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
    sourceJobId: 'job-hum-to-midi',
  };
  const midiTake: GeneratedMidiClipTake = {
    artifactId: midiArtifact.artifactId,
    clipTakeId: 'clip-take-midi',
    createdAt: midiArtifact.createdAt,
    label: 'MIDI Take 01',
    mediaType: 'midi',
    sourceJobId: midiArtifact.sourceJobId,
    sourceType: 'job',
  };

  return {
    artifacts: [recordingArtifact, midiArtifact],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'FluidSynth Plan Test',
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
    totalTicks: 7_680,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: recordingTake.clipTakeId,
            clipTakes: [recordingTake],
            color: '#ff8c5a',
            createdAt: recordingArtifact.createdAt,
            id: 'clip-recording',
            lengthTicks: 1_920,
            name: 'Hum Audio',
            startTick: 0,
            type: 'hum-audio',
            version: 1,
          },
        ],
        id: 'track-recording',
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
            soundFont: {
              bank: 128,
              program: 24,
              resource: {
                format: 'sf2',
                library: 'project',
                relativePath: 'soundfonts/Test.sf2',
                resourceId: 'soundfont-0123456789abcdef0123456789abcdef',
              },
            },
            sourceClipId: 'clip-recording',
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
    ],
  };
}

function createCatalogResource() {
  return {
    format: 'sf2' as const,
    lastModifiedAt: '2026-07-28T08:00:00.000Z',
    library: 'project' as const,
    name: 'Test.sf2',
    relativePath: 'soundfonts/Test.sf2',
    resourceId: 'soundfont-0123456789abcdef0123456789abcdef',
    revisionToken: 'a'.repeat(64),
    sizeBytes: 1_024,
    status: 'AVAILABLE' as const,
  };
}

function findMidiClip(project: ProjectState) {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === 'clip-midi');

  if (!clip) {
    throw new Error('MIDI Clip fixture is missing.');
  }

  return clip;
}
