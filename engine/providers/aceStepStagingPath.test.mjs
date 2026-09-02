import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAceStepPartialWavPath } from './aceStepStagingPath.mjs';

describe('ACE-Step staging path', () => {
  it('derives one sibling partial WAV path', () => {
    const stagingPath = join(tmpdir(), 'ace-step-output.wav.partial');

    expect(createAceStepPartialWavPath(stagingPath)).toBe(`${stagingPath}.wav`);
  });

  it('rejects relative and non-partial paths', () => {
    expect(() => createAceStepPartialWavPath('output.partial')).toThrow(
      'absolute .partial path',
    );
    expect(() => createAceStepPartialWavPath(join(tmpdir(), 'output.wav'))).toThrow(
      'absolute .partial path',
    );
  });
});
