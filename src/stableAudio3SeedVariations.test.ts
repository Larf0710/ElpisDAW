import { describe, expect, it } from 'vitest';

import {
  createRandomStableAudio3Seed,
  createStableAudio3SeedSequence,
} from './stableAudio3SeedVariations';

describe('Stable Audio 3 Seed variations', () => {
  it('creates one to three deterministic consecutive Seeds', () => {
    expect(createStableAudio3SeedSequence(42, 1)).toEqual([42]);
    expect(createStableAudio3SeedSequence(42, 3)).toEqual([42, 43, 44]);
    expect(createStableAudio3SeedSequence(0xffff_ffff, 3)).toEqual([
      0xffff_ffff,
      0,
      1,
    ]);
  });

  it('rejects invalid Seed or Take counts', () => {
    expect(() => createStableAudio3SeedSequence(-1, 1)).toThrow(RangeError);
    expect(() => createStableAudio3SeedSequence(0, 0)).toThrow(RangeError);
    expect(() => createStableAudio3SeedSequence(0, 4)).toThrow(RangeError);
  });

  it('reads one unsigned 32-bit random Seed from the supplied source', () => {
    expect(
      createRandomStableAudio3Seed((values) => {
        values[0] = 3_141_592_653;
        return values;
      }),
    ).toBe(3_141_592_653);
  });
});
