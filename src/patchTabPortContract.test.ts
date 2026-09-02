import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
  getPatchTabConnectionCompatibility,
  getPatchTabDefinition,
  getPatchTabInputOptions,
  getPatchTabOutputOptions,
  migratePatchTabContract,
  migrateTabFlowConnectionPorts,
  PATCH_CAPABILITIES,
  PATCH_DATA_TYPES,
} from './patchTabPortContract';
import type { PatchTab, TabFlowConnection } from './types';

const basePatchTab: Omit<PatchTab, 'id' | 'name' | 'inputType' | 'outputType'> = {
  colorIndex: 0,
  status: 'ready',
  description: '',
  parameters: [],
};

function createPatchTab(
  id: string,
  name: string,
  inputType: string,
  outputType: string,
  overrides: Partial<PatchTab> = {},
): PatchTab {
  return {
    ...basePatchTab,
    id,
    name,
    inputType,
    outputType,
    ...overrides,
  };
}

const humPrep = createPatchTab('hum-prep', 'Hum Prep', 'Hum Audio', 'Hum Audio');
const humToMidi = createPatchTab('hum-to-midi', 'Hum to MIDI', 'Hum Audio', 'MIDI Notes');
const midiEdit = createPatchTab('midi-edit', 'MIDI Edit', 'MIDI Notes', 'Edited MIDI');
const soundFont = createPatchTab('soundfont', 'SoundFont', 'Project SoundFont', 'SoundFont Resource');
const instrument = createPatchTab('instrument', 'Instrument', 'Edited MIDI', 'Instrument Audio');
const stableAudio3 = createPatchTab('stable-audio-3', 'SA3 A2A', 'Instrument Audio', 'Instrument Audio');
const stableAudio3TextToAudio = createPatchTab(
  'stable-audio-3-t2a',
  'SA3 T2A',
  'None',
  'Audio',
);
const aceStep = createPatchTab(
  'ace-step-vocals',
  'ACE Vocals',
  'Guide Audio',
  'Vocal Audio',
);
const legacyStableAudio3 = createPatchTab(
  'legacy-stable-audio-3',
  'Stable Audio 3',
  'Instrument Audio',
  'Instrument Audio',
);
const aceStepTextToMusic = {
  ...createPatchTab('ace-t2m', 'ACE T2M', 'Text', 'Generated Audio'),
  nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.aceStepTextToMusic,
};
const aceStepCover = {
  ...createPatchTab('ace-cover', 'ACE COVER', 'Audio', 'Generated Audio'),
  nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.aceStepCover,
};
const clipFiler = createPatchTab('export', 'Clip Filer', 'Selected Clip', 'Export File');

describe('PatchTab Port Contract V1', () => {
  it('defines stable contracts for the built-in PatchTabs', () => {
    const definitions = getBuiltinPatchTabDefinitions();

    expect(definitions.map((definition) => definition.nodeTypeId)).toEqual([
      BUILTIN_PATCH_TAB_TYPE_IDS.humPrep,
      BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi,
      BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
      BUILTIN_PATCH_TAB_TYPE_IDS.soundFont,
      BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
      BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
      BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio,
      BUILTIN_PATCH_TAB_TYPE_IDS.aceStepTextToMusic,
      BUILTIN_PATCH_TAB_TYPE_IDS.aceStepCover,
      BUILTIN_PATCH_TAB_TYPE_IDS.aceStep,
      BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler,
      BUILTIN_PATCH_TAB_TYPE_IDS.printMix,
    ]);
    expect(getPatchTabDefinition(instrument)?.inputs.map((port) => port.id)).toEqual(['midi-in', 'soundfont-in']);
    expect(getPatchTabDefinition(stableAudio3)).toMatchObject({
      inputs: [{ id: 'audio-in', dataCategory: 'audio' }],
      outputs: [{ id: 'audio-out', dataCategory: 'audio', role: 'stable-audio-3' }],
    });
    expect(getPatchTabDefinition(stableAudio3TextToAudio)).toMatchObject({
      inputs: [],
      outputs: [
        {
          id: 'audio-out',
          dataCategory: 'audio',
          role: 'stable-audio-3-text-to-audio',
        },
      ],
    });
    expect(getPatchTabDefinition(aceStepTextToMusic)).toMatchObject({
      inputs: [],
      outputs: [
        {
          id: 'audio-out',
          dataCategory: 'audio',
          role: 'ace-step-text-to-music',
        },
      ],
    });
    expect(getPatchTabDefinition(aceStepCover)).toMatchObject({
      inputs: [{ id: 'audio-in', dataCategory: 'audio' }],
      outputs: [
        {
          id: 'audio-out',
          dataCategory: 'audio',
          role: 'ace-step-cover',
        },
      ],
    });
    expect(getPatchTabDefinition(aceStep)).toMatchObject({
      inputs: [
        {
          id: 'guide-audio-in',
          dataCategory: 'audio',
          preferredRoles: [
            'instrument-render',
            'stable-audio-3-text-to-audio',
          ],
        },
      ],
      outputs: [
        {
          id: 'vocal-audio-out',
          dataCategory: 'audio',
          role: 'vocal-render',
        },
      ],
    });
    expect(getPatchTabDefinition(clipFiler)?.outputs).toEqual([]);
  });

  it('treats detected and edited MIDI as one stable data type', () => {
    const detectedMidi = getPatchTabDefinition(humToMidi)?.outputs[0];
    const editedMidi = getPatchTabDefinition(midiEdit)?.outputs[0];

    expect(detectedMidi?.produces).toEqual(PATCH_DATA_TYPES.midiNotes);
    expect(editedMidi?.produces).toEqual(PATCH_DATA_TYPES.midiNotes);
    expect(detectedMidi?.role).toBe('detected-midi');
    expect(editedMidi?.role).toBe('edited-midi');
  });

  it('allows both direct and edited MIDI routes into Instrument', () => {
    expect(getPatchTabConnectionCompatibility(humToMidi, instrument).state).toBe('compatible');
    expect(getPatchTabConnectionCompatibility(midiEdit, instrument).state).toBe('compatible');
  });

  it('routes a SoundFont Resource into the Instrument model port', () => {
    const result = getPatchTabConnectionCompatibility(
      soundFont,
      instrument,
      'soundfont-out',
      'soundfont-in',
    );

    expect(result.state).toBe('compatible');
    expect(result.outputPort?.domain).toBe('resource');
    expect(result.outputPort?.produces).toEqual(PATCH_DATA_TYPES.soundFont);
  });

  it('accepts canonical SA3 T2A Audio as an intentional ACE Guide role', () => {
    const result = getPatchTabConnectionCompatibility(
      stableAudio3TextToAudio,
      aceStep,
      'audio-out',
      'guide-audio-in',
    );

    expect(result.state).toBe('compatible');
    expect(result.outputPort?.role).toBe('stable-audio-3-text-to-audio');
    expect(result.inputPort?.preferredRoles).toContain(
      'stable-audio-3-text-to-audio',
    );
    expect(getPatchTabConnectionCompatibility(midiEdit, aceStep).state).toBe(
      'mismatch',
    );
  });

  it('allows every basic producer to feed Clip Filer through the exportable capability', () => {
    [humPrep, humToMidi, midiEdit, instrument, stableAudio3, stableAudio3TextToAudio, aceStepTextToMusic, aceStep].forEach((sourcePatchTab) => {
      const result = getPatchTabConnectionCompatibility(sourcePatchTab, clipFiler);

      expect(result.state, sourcePatchTab.name).toBe('compatible');
      expect(result.outputPort?.capabilities).toContain(PATCH_CAPABILITIES.exportable);
    });
  });

  it('reports a mismatch without relying on PatchTab or Port labels', () => {
    const result = getPatchTabConnectionCompatibility(humPrep, midiEdit);

    expect(result.state).toBe('mismatch');
    expect(result.reason).toContain(PATCH_DATA_TYPES.audio.id);
  });

  it('reports an unknown contract for an unregistered Custom Node', () => {
    const customNode = createPatchTab('custom', 'Spectral Thing', 'Spectral', 'Spectral');

    expect(getPatchTabDefinition(customNode)).toBeUndefined();
    expect(getPatchTabConnectionCompatibility(customNode, instrument).state).toBe('unknown');
  });

  it('uses exact PatchTab names as the primary routing option label', () => {
    expect(getPatchTabOutputOptions(midiEdit)).toEqual([
      expect.objectContaining({
        patchTabName: 'MIDI Edit',
        portLabel: 'MIDI',
        label: 'MIDI Edit [MIDI]',
      }),
    ]);
    expect(getPatchTabInputOptions(instrument).map((option) => option.label)).toEqual([
      'Instrument / MIDI [MIDI]',
      'Instrument / SOUNDFONT [MODEL]',
    ]);
  });

  it('migrates built-in identity and legacy Connection endpoints idempotently', () => {
    const migratedPatchTab = migratePatchTabContract(midiEdit);
    const legacyConnection: TabFlowConnection = {
      id: 'legacy-midi-instrument',
      fromPatchTabId: humToMidi.id,
      toPatchTabId: instrument.id,
      signalType: 'MIDI Notes',
      order: 4,
      latencyMs: 2,
      enabled: true,
    };
    const patchTabs = [humToMidi, instrument].map(migratePatchTabContract);
    const migratedConnection = migrateTabFlowConnectionPorts(legacyConnection, patchTabs);

    expect(migratedPatchTab).toEqual(
      expect.objectContaining({
        nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
        nodeVersion: '1.0.0',
      }),
    );
    expect(migratedConnection).toEqual(
      expect.objectContaining({
        fromPortId: 'midi-out',
        toPortId: 'midi-in',
        activation: 'on',
        createdOrder: 4,
      }),
    );
    expect(migrateTabFlowConnectionPorts(migratedConnection, patchTabs)).toEqual(migratedConnection);
  });

  it('keeps the legacy Stable Audio 3 name on the SA3 A2A contract', () => {
    expect(migratePatchTabContract(stableAudio3)).toMatchObject({
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
      nodeVersion: '1.0.0',
    });
    expect(migratePatchTabContract(legacyStableAudio3)).toMatchObject({
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
      nodeVersion: '1.0.0',
    });
    expect(migratePatchTabContract(stableAudio3TextToAudio)).toMatchObject({
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio,
      nodeVersion: '1.0.0',
    });
  });
});
