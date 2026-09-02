import { createAceStepPatchTabTemplate } from './aceStepPatchTab';
import { createStableAudio3T2APatchTabTemplate } from './stableAudio3PatchTab';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import { createSoundFontPatchTab } from './soundFontPatchTab';
import { createInstrumentPresetParameters } from './instrumentPatchTab';
import type {
  PatchTab,
  ProjectState,
  TabFlowConnection,
  TabFlowPreset,
} from './types';
import { getClipTypeColor } from './clipTypeColors';
import { createDefaultRecordingSettings } from './recordingSettings';
import { beatsToTicks } from './workflow';

const toTick = beatsToTicks;

type PatchTabSeed = Omit<PatchTab, 'colorIndex'>;

function withColorIndexes(patchTabs: PatchTabSeed[]): PatchTab[] {
  return patchTabs.map((patchTab, index) => ({
    ...patchTab,
    colorIndex: index,
  }));
}

function connect(
  id: string,
  fromPatchTabId: string,
  toPatchTabId: string,
  signalType: string,
  latencyMs: number,
  order = 0,
  fromPortId?: string,
  toPortId?: string,
): TabFlowConnection {
  return {
    id,
    fromPatchTabId,
    toPatchTabId,
    ...(fromPortId ? { fromPortId } : {}),
    ...(toPortId ? { toPortId } : {}),
    activation: 'on',
    createdOrder: order,
    signalType,
    order,
    latencyMs,
    enabled: true,
  };
}

function createSoundFontSeed(id: string): PatchTabSeed {
  const { colorIndex: _colorIndex, ...patchTab } = createSoundFontPatchTab(id);
  return patchTab;
}

const oneShotTextToAudioPatchTab = createStableAudio3T2APatchTabTemplate(0);
const oneShotAceVocalsPatchTab = createAceStepPatchTabTemplate(1);

const oneShotGenerationProject: ProjectState = {
  artifacts: [],
  bpm: 120,
  connections: [
    {
      activation: 'on',
      createdOrder: 0,
      enabled: true,
      fromPatchTabId: 'one-shot-sa3-t2a',
      fromPortId: 'audio-out',
      id: 'one-shot-t2a-to-ace-vocals',
      latencyMs: 0,
      order: 0,
      signalType: 'Audio',
      toPatchTabId: 'one-shot-ace-vocals',
      toPortId: 'guide-audio-in',
    },
  ],
  gridResolution: '1/16',
  isLooping: false,
  key: 'C major',
  name: 'ONE SHOT GENERATION',
  patchTabs: withColorIndexes([
    {
      ...oneShotTextToAudioPatchTab,
      description:
        'Creates the backing from Prompt and current Tempo, Key, and Bars. Local Engine and model readiness are required.',
      id: 'one-shot-sa3-t2a',
      name: 'SA3 T2A',
      parameters: oneShotTextToAudioPatchTab.parameters.map((parameter) =>
        parameter.id === 'bars' && parameter.kind === 'number'
          ? { ...parameter, value: 8 }
          : parameter,
      ),
    },
    {
      ...oneShotAceVocalsPatchTab,
      description:
        'Uses the finalized backing as Guide Audio and written Lyrics to create aligned vocals. Language defaults to Japanese and remains editable. Local Engine and model readiness are required.',
      id: 'one-shot-ace-vocals',
      inputBindings: [
        {
          connectionIds: ['one-shot-t2a-to-ace-vocals'],
          kind: 'connection',
          portId: 'guide-audio-in',
        },
      ],
      name: 'ACE VOCALS',
      parameters: oneShotAceVocalsPatchTab.parameters.map((parameter) =>
        parameter.id === 'vocalLanguage' && parameter.kind === 'select'
          ? { ...parameter, value: 'Japanese (ja)' }
          : parameter,
      ),
    },
  ]),
  playheadTick: 0,
  recordingSettings: createDefaultRecordingSettings(),
  selectedPatchTabId: 'one-shot-sa3-t2a',
  selection: { items: [] },
  status: 'READY',
  tabFlowLines: [
    {
      connectionIds: [
        'one-shot-t2a-to-ace-vocals',
      ],
      enabled: true,
      id: 'one-shot-generation-family',
      name: 'ONE SHOT GENERATION',
      order: 0,
      revision: 1,
    },
  ],
  tabFlowStageResults: [],
  takes: [],
  totalTicks: toTick(64),
  tracks: [],
};

const vocalistStarterProject: ProjectState = {
  name: 'Vocalist Starter Flow',
  bpm: 96,
  key: 'C major',
  status: 'READY',
  isLooping: false,
  selectedPatchTabId: 'vocal-hum-to-midi',
  playheadTick: toTick(16),
  totalTicks: toTick(64),
  gridResolution: '1/8',
  recordingSettings: createDefaultRecordingSettings(),
  selection: { items: [] },
  takes: [],
  patchTabs: withColorIndexes([
    {
      id: 'vocal-hum-to-midi',
      name: 'Guide MIDI',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi,
      nodeVersion: '1.0.0',
      inputType: 'Hum Audio',
      outputType: 'MIDI Notes',
      status: 'ready',
      description: 'Converts the selected hum recording into editable MIDI notes with Basic Pitch.',
      parameters: [
        { id: 'sensitivity', label: 'Pitch Sensitivity', kind: 'slider', min: 0, max: 100, step: 1, value: 70, unit: '%' },
        { id: 'note-range', label: 'Note Range', kind: 'select', value: 'Vocal', options: ['Bass', 'Vocal', 'Lead'] },
      ],
    },
    {
      id: 'vocal-midi-edit',
      name: 'Melody Clean',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
      nodeVersion: '1.0.0',
      inputType: 'MIDI Notes',
      outputType: 'Edited MIDI',
      status: 'ready',
      description: 'Snaps guide MIDI note starts to the selected grid while preserving note length and velocity.',
      parameters: [
        { id: 'quantize', label: 'Quantize', kind: 'select', value: '1/16', options: ['1/8', '1/16', '1/32', '1/64'] },
      ],
    },
    createSoundFontSeed('vocal-soundfont'),
    {
      id: 'vocal-guide-instrument',
      name: 'Guide MIDI TO AUDIO',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
      nodeVersion: '1.0.0',
      inputType: 'Edited MIDI',
      outputType: 'Instrument Audio',
      status: 'ready',
      description: 'Creates a backing guide from cleaned MIDI and the connected SoundFont.',
      inputBindings: [
        { portId: 'midi-in', kind: 'connection', connectionIds: ['vocal-c3'] },
        { portId: 'soundfont-in', kind: 'connection', connectionIds: ['vocal-c4'] },
      ],
      parameters: createInstrumentPresetParameters(),
    },
  ]),
  connections: [
    connect('vocal-c2', 'vocal-hum-to-midi', 'vocal-midi-edit', 'MIDI Notes', 2, 0, 'midi-out', 'midi-in'),
    connect('vocal-c3', 'vocal-midi-edit', 'vocal-guide-instrument', 'Edited MIDI', 1, 1, 'midi-out', 'midi-in'),
    connect('vocal-c4', 'vocal-soundfont', 'vocal-guide-instrument', 'SOUNDFONT', 0, 2, 'soundfont-out', 'soundfont-in'),
  ],
  tracks: [
    {
      id: 'hum-audio',
      name: 'Verse Hum',
      type: 'audio',
      level: -9,
      clips: [
        {
          id: 'vocal-clip-hum-1',
          type: 'hum-audio',
          name: 'Verse Sketch',
          startTick: toTick(4),
          lengthTicks: toTick(16),
          color: getClipTypeColor('hum-audio'),
          generatedBy: 'Microphone Recording',
          createdAt: '2026-06-24T10:00:00.000Z',
          version: 1,
        },
      ],
    },
    {
      id: 'midi-notes',
      name: 'Guide MIDI',
      type: 'midi',
      level: -7,
      clips: [
        {
          id: 'vocal-clip-midi-1',
          type: 'midi-notes',
          name: 'Guide Notes',
          startTick: toTick(4),
          lengthTicks: toTick(16),
          color: getClipTypeColor('midi-notes'),
          sourceClipId: 'vocal-clip-hum-1',
          generatedBy: 'Guide MIDI',
          createdAt: '2026-06-24T10:04:00.000Z',
          version: 1,
        },
      ],
    },
    {
      id: 'guide-instrument',
      name: 'Guide Instrument',
      type: 'audio',
      level: -6,
      clips: [
        {
          id: 'vocal-clip-guide-1',
          type: 'instrument-audio',
          name: 'General MIDI Guide',
          startTick: toTick(4),
          lengthTicks: toTick(24),
          color: getClipTypeColor('instrument-audio'),
          sourceClipId: 'vocal-clip-midi-1',
          generatedBy: 'Guide MIDI TO AUDIO',
          createdAt: '2026-06-24T10:08:00.000Z',
          version: 1,
        },
      ],
    },
    {
      id: 'vocal-audio',
      name: 'Vocal Audio',
      type: 'audio',
      level: -5,
      clips: [
        {
          id: 'vocal-clip-take-1',
          type: 'vocal-audio',
          name: 'Lead Take',
          startTick: toTick(20),
          lengthTicks: toTick(20),
          color: getClipTypeColor('vocal-audio'),
          sourceClipId: 'vocal-clip-guide-1',
          generatedBy: 'Vocal Record',
          createdAt: '2026-06-24T10:12:00.000Z',
          version: 1,
        },
      ],
    },
    {
      id: 'master',
      name: 'Master',
      type: 'master',
      level: -3,
      clips: [],
    },
  ],
};

const humToInstrumentProject: ProjectState = {
  name: 'Hum to Instrument Flow',
  bpm: 120,
  key: 'A minor',
  status: 'READY',
  isLooping: false,
  selectedPatchTabId: 'preset-midi-edit',
  playheadTick: toTick(18),
  totalTicks: toTick(64),
  gridResolution: '1/8',
  recordingSettings: createDefaultRecordingSettings(),
  selection: { items: [] },
  takes: [],
  patchTabs: withColorIndexes([
    {
      id: 'preset-hum-to-midi',
      name: 'Hum to MIDI',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi,
      nodeVersion: '1.0.0',
      inputType: 'Hum Audio',
      outputType: 'MIDI Notes',
      status: 'ready',
      description: 'Converts the selected hum recording into editable MIDI notes with Basic Pitch.',
      parameters: [
        { id: 'sensitivity', label: 'Pitch Sensitivity', kind: 'slider', min: 0, max: 100, step: 1, value: 72, unit: '%' },
        { id: 'note-range', label: 'Note Range', kind: 'select', value: 'Vocal', options: ['Bass', 'Vocal', 'Lead'] },
      ],
    },
    {
      id: 'preset-midi-edit',
      name: 'MIDI Edit',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
      nodeVersion: '1.0.0',
      inputType: 'MIDI Notes',
      outputType: 'Edited MIDI',
      status: 'processing',
      description: 'Snaps MIDI note starts to the selected grid while preserving note length and velocity.',
      parameters: [
        { id: 'quantize', label: 'Quantize', kind: 'select', value: '1/16', options: ['1/8', '1/16', '1/32', '1/64'] },
      ],
    },
    createSoundFontSeed('preset-soundfont'),
    {
      id: 'preset-instrument',
      name: 'MIDI TO AUDIO',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
      nodeVersion: '1.0.0',
      inputType: 'Edited MIDI',
      outputType: 'Instrument Audio',
      status: 'ready',
      description: 'Renders edited MIDI through the connected built-in or custom SoundFont.',
      inputBindings: [
        { portId: 'midi-in', kind: 'connection', connectionIds: ['instrument-c3'] },
        { portId: 'soundfont-in', kind: 'connection', connectionIds: ['instrument-c4'] },
      ],
      parameters: createInstrumentPresetParameters(),
    },
  ]),
  connections: [
    connect('instrument-c2', 'preset-hum-to-midi', 'preset-midi-edit', 'MIDI Notes', 2, 0, 'midi-out', 'midi-in'),
    connect('instrument-c3', 'preset-midi-edit', 'preset-instrument', 'Edited MIDI', 1, 1, 'midi-out', 'midi-in'),
    connect('instrument-c4', 'preset-soundfont', 'preset-instrument', 'SOUNDFONT', 0, 2, 'soundfont-out', 'soundfont-in'),
  ],
  tracks: [
    {
      id: 'hum-audio',
      name: 'Hum Audio',
      type: 'audio',
      level: -8,
      clips: [
        {
          id: 'instrument-clip-hum-1',
          type: 'hum-audio',
          name: 'Take 01',
          startTick: toTick(4),
          lengthTicks: toTick(12),
          color: getClipTypeColor('hum-audio'),
          generatedBy: 'Microphone Recording',
          createdAt: '2026-06-24T09:00:00.000Z',
          version: 1,
        },
      ],
    },
    {
      id: 'midi-notes',
      name: 'MIDI Notes',
      type: 'midi',
      level: -6,
      clips: [
        {
          id: 'instrument-clip-midi-1',
          type: 'midi-notes',
          name: 'Converted Motif',
          startTick: toTick(6),
          lengthTicks: toTick(18),
          color: getClipTypeColor('midi-notes'),
          sourceClipId: 'instrument-clip-hum-1',
          generatedBy: 'Hum to MIDI',
          createdAt: '2026-06-24T09:18:00.000Z',
          version: 1,
        },
      ],
    },
    {
      id: 'instrument-audio',
      name: 'Instrument Audio',
      type: 'audio',
      level: -5,
      clips: [
        {
          id: 'instrument-clip-audio-1',
          type: 'instrument-audio',
          name: 'Instrument Audio',
          startTick: toTick(8),
          lengthTicks: toTick(24),
          color: getClipTypeColor('instrument-audio'),
          sourceClipId: 'instrument-clip-midi-1',
          generatedBy: 'MIDI TO AUDIO',
          createdAt: '2026-06-24T09:31:00.000Z',
          version: 1,
        },
      ],
    },
    {
      id: 'master',
      name: 'Master',
      type: 'master',
      level: -2,
      clips: [
        {
          id: 'instrument-clip-master-1',
          type: 'master',
          name: 'Rough Mix',
          startTick: toTick(0),
          lengthTicks: toTick(48),
          color: getClipTypeColor('master'),
          sourceClipId: 'instrument-clip-audio-1',
          generatedBy: 'Timeline',
          createdAt: '2026-06-24T09:45:00.000Z',
          version: 1,
        },
      ],
    },
  ],
};

export const tabFlowPresets: TabFlowPreset[] = [
  {
    id: 'one-shot-generation',
    name: 'ONE SHOT GENERATION',
    description:
      'Write a backing Prompt and Lyrics, then Production Auto Patch runs SA3 T2A and ACE VOCALS once to create aligned backing and vocal Tracks.',
    intent:
      'Create one complete backing-and-vocals song draft. A ready Local Engine and both production models are required.',
    project: oneShotGenerationProject,
  },
  {
    id: 'vocalist-starter-flow',
    name: 'Vocalist Starter Flow',
    description: 'A singer-first flow with Basic Pitch guide MIDI, MIDI editing, and instrument rendering.',
    intent: 'Start from a rough vocal idea and build a guide arrangement around it.',
    project: vocalistStarterProject,
  },
  {
    id: 'hum-to-instrument-flow',
    name: 'Hum to Instrument Flow',
    description: 'The core ElpisDAW path: convert hum, edit MIDI, and render instrument audio.',
    intent: 'Turn a hummed melody into a playable instrument part.',
    project: humToInstrumentProject,
  },
];
