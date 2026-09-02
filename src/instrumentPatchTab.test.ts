import { describe, expect, it } from 'vitest';

import {
  createInstrumentPresetParameters,
  isInstrumentPresetControlLocked,
  normalizeInstrumentPresetParameters,
  resolveInstrumentPatchTabPreset,
} from './instrumentPatchTab';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';

describe('MIDI TO AUDIO preset parameters', () => {
  it('creates MuseScore General Bank 0 Program 0 defaults', () => {
    expect(createInstrumentPresetParameters()).toEqual([
      expect.objectContaining({ id: 'bank', value: 0 }),
      expect.objectContaining({ id: 'program', value: 0 }),
    ]);
  });

  it('migrates retired mock controls and preserves valid saved presets', () => {
    expect(
      normalizeInstrumentPresetParameters([
        {
          id: 'patch',
          kind: 'select',
          label: 'Patch',
          options: ['Glass Keys'],
          value: 'Glass Keys',
        },
        {
          id: 'bank',
          kind: 'number',
          label: 'Bank',
          max: 16_383,
          min: 0,
          step: 1,
          value: 8,
        },
        {
          id: 'program',
          kind: 'number',
          label: 'Program',
          max: 127,
          min: 0,
          step: 1,
          value: 24,
        },
      ]),
    ).toEqual([
      expect.objectContaining({ id: 'bank', value: 8 }),
      expect.objectContaining({ id: 'program', value: 24 }),
    ]);
  });

  it('reads valid preset values and defaults legacy empty parameter arrays', () => {
    expect(
      resolveInstrumentPatchTabPreset({
        nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
        parameters: createInstrumentPresetParameters(),
      }),
    ).toEqual({ bank: 0, program: 0 });
    expect(
      resolveInstrumentPatchTabPreset({
        nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
        parameters: [],
      }),
    ).toEqual({ bank: 0, program: 0 });
  });

  it('locks built-in preset controls while a custom or clip voice overrides them', () => {
    expect(isInstrumentPresetControlLocked('builtin-default')).toBe(false);
    expect(isInstrumentPresetControlLocked('connection')).toBe(true);
    expect(isInstrumentPresetControlLocked('clip')).toBe(true);
    expect(isInstrumentPresetControlLocked(undefined)).toBe(false);
  });
});
