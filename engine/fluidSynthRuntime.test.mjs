import { describe, expect, it } from 'vitest';

import { parseFluidSynthPresetCatalog } from './fluidSynthRuntime.mjs';

describe('FluidSynth preset catalog parsing', () => {
  it('extracts sorted Bank, Program, and voice names from FluidSynth shell output', () => {
    expect(
      parseFluidSynthPresetCatalog([
        'FluidSynth runtime version 2.5.7',
        '> 128-000 Standard',
        '000-024 Nylon String Guitar',
        '000-000 Grand Piano',
        '> cheers!',
      ].join('\r\n')),
    ).toEqual([
      { bank: 0, name: 'Grand Piano', program: 0 },
      { bank: 0, name: 'Nylon String Guitar', program: 24 },
      { bank: 128, name: 'Standard', program: 0 },
    ]);
  });

  it('ignores malformed, unsafe, or out-of-range lines', () => {
    expect(
      parseFluidSynthPresetCatalog([
        'not a preset',
        '16384-000 Outside Bank',
        '000-128 Outside Program',
        '000-001 Unsafe\u0001Name',
      ].join('\n')),
    ).toEqual([]);
  });
});
