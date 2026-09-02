import { describe, expect, it } from 'vitest';
import { createAudioPlaybackContentFingerprint } from './audioClipPlayback';
import type { Track } from './types';

const track: Track = {
  clips: [],
  id: 'audio-track',
  level: -8,
  name: 'Audio Track',
  parentGroupId: null,
  type: 'audio',
};

describe('audio playback content fingerprint', () => {
  it('stays stable when normalization recreates equivalent Track objects', () => {
    expect(createAudioPlaybackContentFingerprint(120, [track])).toBe(
      createAudioPlaybackContentFingerprint(120, [structuredClone(track)]),
    );
  });

  it('changes for playback-affecting BPM or Track edits', () => {
    const source = createAudioPlaybackContentFingerprint(120, [track]);

    expect(createAudioPlaybackContentFingerprint(121, [track])).not.toBe(source);
    expect(
      createAudioPlaybackContentFingerprint(120, [{ ...track, level: -7 }]),
    ).not.toBe(source);
  });
});
