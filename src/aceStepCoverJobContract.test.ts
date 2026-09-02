import { describe, expect, it } from 'vitest';

import { ACE_STEP_COVER_TASK_ID } from '../shared/aceStepProtocol.js';
import { createAceStepCoverJobRequest } from './aceStepCoverJobContract';

describe('ACE-Step Cover Job contract', () => {
  it('captures exact Audio and Lyrics lineage with pinned stereo 48 kHz Remix defaults', () => {
    const request = createRequest();

    expect(request).toMatchObject({
      guideSource: {
        artifactId: 'artifact-source',
        clipTakeId: 'clip-take-source',
        kind: 'active-audio-take',
      },
      lineage: {
        parentArtifactIds: ['artifact-source', 'artifact-lyrics'],
        parentClipTakeIds: ['clip-take-source'],
      },
      parameters: {
        audioCoverStrength: 0.2,
        channels: 2,
        coverNoiseStrength: 0,
        guidanceScale: 8,
        inferenceSteps: 64,
        sampleRate: 48_000,
        taskType: 'cover',
        thinking: false,
      },
      taskId: ACE_STEP_COVER_TASK_ID,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts)).toBe(true);
  });

  it('rejects unsafe Guide paths and out-of-range Cover Strength', () => {
    expect(() =>
      createAceStepCoverJobRequest({
        ...createInput(),
        guideRelativePath: '../source.wav',
      }),
    ).toThrow('safe Project WAV path');
    expect(() =>
      createAceStepCoverJobRequest({
        ...createInput(),
        coverStrength: 1.1,
      }),
    ).toThrow('between 0 and 1');
  });
});

function createRequest() {
  return createAceStepCoverJobRequest(createInput());
}

function createInput() {
  return {
    caption: 'Dreamy chamber pop reinterpretation',
    coverStrength: 0.2,
    durationSeconds: 12,
    guideArtifactId: 'artifact-source',
    guideClipTakeId: 'clip-take-source',
    guideRelativePath: 'renders/instruments/artifact-source.wav',
    guideSizeBytes: 2_304_044,
    instrumental: false,
    lyricsArtifactId: 'artifact-lyrics',
    lyricsRelativePath: 'renders/ace-step/lyrics/artifact-lyrics.txt',
    seed: 42,
    vocalLanguage: 'ja',
  } as const;
}
