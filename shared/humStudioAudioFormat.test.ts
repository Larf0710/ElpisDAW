import { describe, expect, it } from 'vitest';

import { HUMSTUDIO_AUDIO_FORMAT } from './humStudioAudioFormat.js';

describe('HUMSTUDIO_AUDIO_FORMAT', () => {
  it('defines one immutable 48 kHz stereo PCM16 WAV boundary', () => {
    expect(HUMSTUDIO_AUDIO_FORMAT).toEqual({
      bitsPerSample: 16,
      channels: 2,
      encoding: 'pcm-signed-integer',
      mimeType: 'audio/wav',
      sampleRate: 48_000,
    });
    expect(Object.isFrozen(HUMSTUDIO_AUDIO_FORMAT)).toBe(true);
  });
});
