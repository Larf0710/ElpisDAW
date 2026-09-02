import { describe, expect, it } from 'vitest';

import { ACE_STEP_TEXT_TO_MUSIC_TASK_ID } from '../shared/aceStepProtocol.js';
import { createAceStepTextToMusicJobRequest } from './aceStepTextToMusicJobContract';

describe('ACE-Step Text to Music Job Contract', () => {
  it('creates one immutable Lyrics-only request with a stereo 48 kHz output contract', () => {
    const request = createAceStepTextToMusicJobRequest(createInput());

    expect(request).toMatchObject({
      inputArtifacts: [
        {
          artifactId: 'artifact-12345678-1234-4123-8123-123456789abc',
          kind: 'lyrics',
        },
      ],
      lineage: {
        parentArtifactIds: ['artifact-12345678-1234-4123-8123-123456789abc'],
        parentClipTakeIds: [],
      },
      parameters: {
        channels: 2,
        guidanceScale: 8,
        inferenceSteps: 64,
        sampleRate: 48_000,
        taskType: 'text2music',
        thinking: false,
        timesignature: '4/4',
      },
      taskId: ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.parameters)).toBe(true);
  });

  it('rejects non-canonical Lyrics paths and out-of-range generation settings', () => {
    expect(() =>
      createAceStepTextToMusicJobRequest({
        ...createInput(),
        lyricsRelativePath: 'lyrics.txt',
      }),
    ).toThrow(/Lyrics path/);
    expect(() =>
      createAceStepTextToMusicJobRequest({ ...createInput(), durationSeconds: 9 }),
    ).toThrow(/duration/);
    expect(() =>
      createAceStepTextToMusicJobRequest({ ...createInput(), bpm: 301 }),
    ).toThrow(/Tempo/);
  });
});

function createInput() {
  const artifactId = 'artifact-12345678-1234-4123-8123-123456789abc';
  return {
    bpm: 120,
    caption: 'Dreamy synth pop with a restrained verse and wide chorus',
    durationSeconds: 16,
    instrumental: false,
    keyscale: 'C major',
    lyricsArtifactId: artifactId,
    lyricsRelativePath: `renders/ace-step/lyrics/${artifactId}.txt`,
    seed: 42,
    vocalLanguage: 'ja',
  };
}
