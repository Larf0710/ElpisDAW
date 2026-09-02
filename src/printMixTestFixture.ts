import { createMidiContentHash } from './midiContentHash';
import { createPrintMixPatchTab } from './printMixPatchTab';
import { sampleProject } from './sampleProject';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ManualMidiArtifact,
  ManualMidiClipTake,
  MidiNote,
  ProjectState,
} from './types';
import { TICKS_PER_QUARTER } from './workflow';

export const PRINT_MIX_TEST_OPERATION_ID =
  'print-mix-operation-11111111-1111-4111-8111-111111111111';
export const PRINT_MIX_TEST_OPERATION_ID_2 =
  'print-mix-operation-22222222-2222-4222-8222-222222222222';
export const PRINT_MIX_TEST_CREATED_AT = '2026-08-14T03:00:00.000Z';
export const PRINT_MIX_TEST_SOURCE_FRAMES = 22_050;
export const PRINT_MIX_TEST_SOURCE_BYTES =
  44 + PRINT_MIX_TEST_SOURCE_FRAMES * 4;

export function createPrintMixAudioProject(): ProjectState {
  const project = createProjectBase();
  const first = createAudioSource(1);
  const second = createAudioSource(2);

  project.artifacts = [first.artifact, second.artifact];
  project.tracks = [
    {
      clips: [
        {
          activeClipTakeId: first.take.clipTakeId,
          audioTiming: {
            sourceEndSeconds: 0.5,
            sourceStartSeconds: 0,
            timeBase: 'absolute-seconds',
          },
          clipTakes: [first.take],
          color: '#31748f',
          createdAt: PRINT_MIX_TEST_CREATED_AT,
          id: 'audio-clip-1',
          lengthTicks: 960,
          name: 'Audio One',
          startTick: 960,
          type: 'instrument-audio',
          version: 1,
        },
      ],
      id: 'audio-track-1',
      level: -6,
      muted: false,
      name: 'Audio Track One',
      type: 'audio',
    },
    {
      clips: [
        {
          activeClipTakeId: second.take.clipTakeId,
          audioTiming: {
            sourceEndSeconds: 0.5,
            sourceStartSeconds: 0,
            timeBase: 'absolute-seconds',
          },
          clipTakes: [second.take],
          color: '#9ccfd8',
          createdAt: PRINT_MIX_TEST_CREATED_AT,
          id: 'audio-clip-2',
          lengthTicks: 960,
          name: 'Audio Two',
          startTick: 2_880,
          type: 'vocal-audio',
          version: 1,
        },
      ],
      id: 'audio-track-2',
      level: 4,
      muted: false,
      name: 'Audio Track Two',
      type: 'audio',
    },
  ];
  project.selection = {
    items: [
      { id: 'audio-clip-1', type: 'clip' },
      { id: 'audio-clip-2', type: 'clip' },
    ],
  };
  return project;
}

export function createPrintMixMidiProject(): ProjectState {
  const project = createProjectBase();
  const first = createMidiSource(1, [
    {
      id: 'source-note-1a',
      lengthTicks: 480,
      pitch: 60,
      startTick: 0,
      velocity: 91,
    },
    {
      id: 'source-note-1b',
      lengthTicks: 480,
      pitch: 60,
      startTick: 0,
      velocity: 91,
    },
  ]);
  const second = createMidiSource(2, [
    {
      id: 'source-note-2a',
      lengthTicks: 960,
      pitch: 67,
      startTick: 0,
      velocity: 73,
    },
  ]);

  project.artifacts = [first.artifact, second.artifact];
  project.tracks = [
    {
      clips: [
        {
          activeClipTakeId: first.take.clipTakeId,
          clipTakes: [first.take],
          color: '#c4a7e7',
          createdAt: PRINT_MIX_TEST_CREATED_AT,
          id: 'midi-clip-1',
          lengthTicks: 960,
          name: 'MIDI One',
          soundFont: {
            bank: 8,
            program: 42,
            resource: {
              format: 'sf2',
              library: 'project',
              relativePath: 'soundfonts/one.sf2',
              resourceId: 'soundfont-one',
            },
          },
          startTick: 960,
          type: 'midi-notes',
          version: 1,
        },
      ],
      id: 'midi-track-1',
      level: -12,
      muted: false,
      name: 'MIDI Track One',
      type: 'midi',
    },
    {
      clips: [
        {
          activeClipTakeId: second.take.clipTakeId,
          clipTakes: [second.take],
          color: '#f6c177',
          createdAt: PRINT_MIX_TEST_CREATED_AT,
          id: 'midi-clip-2',
          lengthTicks: 960,
          name: 'MIDI Two',
          soundFont: {
            bank: 0,
            program: 1,
            resource: {
              format: 'sf3',
              library: 'project',
              relativePath: 'soundfonts/two.sf3',
              resourceId: 'soundfont-two',
            },
          },
          startTick: 2_880,
          type: 'edited-midi',
          version: 1,
        },
      ],
      id: 'midi-track-2',
      level: 5,
      muted: false,
      name: 'MIDI Track Two',
      type: 'midi',
    },
  ];
  project.selection = {
    items: [
      { id: 'midi-clip-1', type: 'clip' },
      { id: 'midi-clip-2', type: 'clip' },
    ],
  };
  return project;
}

function createProjectBase(): ProjectState {
  const project = structuredClone(sampleProject);
  project.artifacts = [];
  project.connections = [];
  project.mixer = undefined;
  project.patchTabs = [createPrintMixPatchTab('print-mix', 0)];
  project.selectedPatchTabId = 'print-mix';
  project.totalTicks = 7_680;
  project.tracks = [];
  return project;
}

function createAudioSource(index: number): Readonly<{
  artifact: GeneratedAudioArtifact;
  take: GeneratedAudioClipTake;
}> {
  const artifactId = `artifact-audio-source-${index}`;
  const jobId = `job-audio-source-${index}`;
  const artifact: GeneratedAudioArtifact = {
    artifactId,
    audio: {
      channels: 2,
      durationSeconds: 0.5,
      mimeType: 'audio/wav',
    },
    createdAt: PRINT_MIX_TEST_CREATED_AT,
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: `${artifactId}.wav`,
      relativePath: `renders/instruments/${artifactId}.wav`,
      sizeBytes: PRINT_MIX_TEST_SOURCE_BYTES,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    provenance: {
      modelId: 'fixture-model',
      modelRevision: 'fixture-revision',
      parameters: {},
      providerId: 'fixture-provider',
      taskId: 'instrument-render',
    },
    sourceJobId: jobId,
  };
  const take: GeneratedAudioClipTake = {
    artifactId,
    clipTakeId: `clip-take-audio-source-${index}`,
    createdAt: PRINT_MIX_TEST_CREATED_AT,
    label: `Audio Source ${index}`,
    mediaType: 'audio',
    sourceJobId: jobId,
    sourceType: 'job',
  };
  return { artifact, take };
}

function createMidiSource(
  index: number,
  notes: MidiNote[],
): Readonly<{
  artifact: ManualMidiArtifact;
  take: ManualMidiClipTake;
}> {
  const artifactId = `artifact-midi-source-${index}`;
  const manualId = `manual-midi-source-${index}`;
  const midi = {
    bpm: 120,
    notes,
    ticksPerQuarter: TICKS_PER_QUARTER,
  };
  const contentHash = createMidiContentHash(midi);
  const artifact: ManualMidiArtifact = {
    artifactId,
    contentHash,
    createdAt: PRINT_MIX_TEST_CREATED_AT,
    kind: 'midi',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    manualProvenance: {
      editorId: 'humstudio-piano-roll',
      editorVersion: '1.0.0',
      taskId: 'manual-midi',
    },
    midi,
    revision: 1,
    sourceManualId: manualId,
    updatedAt: PRINT_MIX_TEST_CREATED_AT,
  };
  const take: ManualMidiClipTake = {
    artifactId,
    clipTakeId: `clip-take-midi-source-${index}`,
    contentHash,
    createdAt: PRINT_MIX_TEST_CREATED_AT,
    label: `MIDI Source ${index}`,
    mediaType: 'midi',
    revision: 1,
    sourceManualId: manualId,
    sourceType: 'manual',
    updatedAt: PRINT_MIX_TEST_CREATED_AT,
  };
  return { artifact, take };
}
