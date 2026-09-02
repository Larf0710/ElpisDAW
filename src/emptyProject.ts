import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import { createInstrumentPresetParameters } from './instrumentPatchTab';
import { createDefaultRecordingSettings } from './recordingSettings';
import { createSoundFontPatchTab } from './soundFontPatchTab';
import { createStableAudio3A2APatchTabTemplate } from './stableAudio3PatchTab';
import type { PatchTab, ProjectState, TabFlowConnection } from './types';
import { beatsToTicks } from './workflow';

const defaultStableAudio3A2A = createStableAudio3A2APatchTabTemplate(3);

const defaultPatchTabs: readonly PatchTab[] = [
  {
    id: 'hum-to-midi',
    name: 'Hum to MIDI',
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi,
    nodeVersion: '1.0.0',
    colorIndex: 0,
    inputType: 'Hum Audio',
    outputType: 'MIDI Notes',
    status: 'ready',
    description: 'Converts the selected hum recording into editable MIDI notes with Basic Pitch.',
    parameters: [
      {
        id: 'sensitivity',
        label: 'Pitch Sensitivity',
        kind: 'slider',
        min: 0,
        max: 100,
        step: 1,
        value: 72,
        unit: '%',
      },
      {
        id: 'note-range',
        label: 'Note Range',
        kind: 'select',
        value: 'Vocal',
        options: ['Bass', 'Vocal', 'Lead'],
      },
    ],
  },
  {
    id: 'midi-edit',
    name: 'MIDI Edit',
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
    nodeVersion: '1.0.0',
    colorIndex: 1,
    inputType: 'MIDI Notes',
    outputType: 'Edited MIDI',
    status: 'ready',
    description: 'Snaps MIDI note starts to the selected grid while preserving note length and velocity.',
    parameters: [
      {
        id: 'quantize',
        label: 'Quantize',
        kind: 'select',
        value: '1/16',
        options: ['1/8', '1/16', '1/32', '1/64'],
      },
    ],
  },
  {
    id: 'instrument',
    name: 'MIDI TO AUDIO',
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
    nodeVersion: '1.0.0',
    colorIndex: 2,
    inputType: 'Edited MIDI',
    outputType: 'Instrument Audio',
    status: 'ready',
    description: 'Renders MIDI through its assigned built-in or custom SoundFont into audio.',
    inputBindings: [
      { portId: 'midi-in', kind: 'connection', connectionIds: ['c3'] },
      { portId: 'soundfont-in', kind: 'project-context', selector: 'clip.soundFont' },
    ],
    parameters: createInstrumentPresetParameters(),
  },
  {
    ...defaultStableAudio3A2A,
    inputBindings: [
      { portId: 'audio-in', kind: 'connection', connectionIds: ['c4'] },
    ],
  },
  {
    ...createSoundFontPatchTab('soundfont', 4),
  },
];

const defaultConnections: readonly TabFlowConnection[] = [
  {
    id: 'c2',
    fromPatchTabId: 'hum-to-midi',
    toPatchTabId: 'midi-edit',
    fromPortId: 'midi-out',
    toPortId: 'midi-in',
    activation: 'on',
    createdOrder: 0,
    signalType: 'MIDI Notes',
    order: 0,
    latencyMs: 2,
    enabled: true,
  },
  {
    id: 'c3',
    fromPatchTabId: 'midi-edit',
    toPatchTabId: 'instrument',
    fromPortId: 'midi-out',
    toPortId: 'midi-in',
    activation: 'on',
    createdOrder: 1,
    signalType: 'Edited MIDI',
    order: 1,
    latencyMs: 1,
    enabled: true,
  },
  {
    id: 'c4',
    fromPatchTabId: 'instrument',
    toPatchTabId: 'stable-audio-3-a2a',
    fromPortId: 'audio-out',
    toPortId: 'audio-in',
    activation: 'on',
    createdOrder: 2,
    signalType: 'Instrument Audio',
    order: 2,
    latencyMs: 0,
    enabled: true,
  },
];

export function createDefaultPatchTabs(): PatchTab[] {
  return defaultPatchTabs.map((patchTab) => ({
    ...patchTab,
    inputBindings: patchTab.inputBindings?.map((binding) =>
      binding.kind === 'connection'
        ? { ...binding, connectionIds: [...binding.connectionIds] }
        : { ...binding },
    ),
    parameters: patchTab.parameters.map((parameter) =>
      parameter.kind === 'select'
        ? { ...parameter, options: [...parameter.options] }
        : { ...parameter },
    ),
  }));
}

export function createEmptyProject(): ProjectState {
  return {
    name: 'Untitled Project',
    bpm: 120,
    key: 'C major',
    status: 'READY',
    isLooping: false,
    selectedPatchTabId: 'midi-edit',
    playheadTick: 0,
    totalTicks: beatsToTicks(64),
    gridResolution: '1/8',
    recordingSettings: createDefaultRecordingSettings(),
    selection: { items: [] },
    takes: [],
    artifacts: [],
    tabFlowStageResults: [],
    patchTabs: createDefaultPatchTabs(),
    connections: defaultConnections.map((connection) => ({ ...connection })),
    tracks: [],
  };
}
