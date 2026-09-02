import { describe, expect, it } from 'vitest';

import { canReadGeneratedAudioForProjectPlayback } from './projectPlaybackReadiness';

describe('canReadGeneratedAudioForProjectPlayback', () => {
  it('keeps read-only generated playback available with a reader and Project Root', () => {
    expect(
      canReadGeneratedAudioForProjectPlayback({
        hasGeneratedAudioReader: true,
        projectRootReady: true,
      }),
    ).toBe(true);
  });

  it.each([
    { hasGeneratedAudioReader: false, projectRootReady: true },
    { hasGeneratedAudioReader: true, projectRootReady: false },
    { hasGeneratedAudioReader: false, projectRootReady: false },
  ])('blocks when the read boundary is incomplete: %o', (input) => {
    expect(canReadGeneratedAudioForProjectPlayback(input)).toBe(false);
  });
});
