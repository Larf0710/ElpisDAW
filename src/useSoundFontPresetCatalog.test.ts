import { describe, expect, it } from 'vitest';

import {
  createSoundFontPresetKey,
  parseSoundFontPresetKey,
} from './useSoundFontPresetCatalog';

describe('SoundFont preset catalog UI helpers', () => {
  it('round-trips bounded Bank and Program keys', () => {
    expect(createSoundFontPresetKey(128, 96)).toBe('128:96');
    expect(parseSoundFontPresetKey('128:96')).toEqual({ bank: 128, program: 96 });
  });

  it('rejects malformed or out-of-range preset keys', () => {
    expect(parseSoundFontPresetKey('-1:0')).toBeUndefined();
    expect(parseSoundFontPresetKey('16384:0')).toBeUndefined();
    expect(parseSoundFontPresetKey('0:128')).toBeUndefined();
    expect(parseSoundFontPresetKey('0/1')).toBeUndefined();
  });
});
