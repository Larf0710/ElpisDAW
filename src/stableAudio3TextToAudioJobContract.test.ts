import { describe, expect, it } from 'vitest';

import {
  createStableAudio3TextToAudioJobRequest,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_JOB_CONTRACT_ERROR,
  StableAudio3TextToAudioJobContractError,
} from './stableAudio3TextToAudioJobContract';

const MODEL_REVISION = '27b5a21b791b1b033d193a9e1e3ce78493f102f9';

describe('Stable Audio 3 text-to-audio Job contract', () => {
  it('creates one immutable source-free text-to-audio request', () => {
    const request = createStableAudio3TextToAudioJobRequest(createInput());

    expect(request).toEqual({
      inputArtifacts: [],
      lineage: {
        parentArtifactIds: [],
        parentClipTakeIds: [],
      },
      modelId: 'stable-audio-3-medium',
      modelRevision: MODEL_REVISION,
      output: {
        artifactKind: 'audio',
        destination: 'stable-audio-3',
        extension: '.wav',
      },
      parameters: {
        channels: 2,
        durationSeconds: 16,
        prompt: 'Warm analog synths with a patient cinematic build',
        sampleRate: 44_100,
        seed: 17,
      },
      providerId: 'local-stable-audio-3',
      taskId: 'text-to-audio',
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts)).toBe(true);
    expect(Object.isFrozen(request.lineage)).toBe(true);
    expect(Object.isFrozen(request.lineage.parentArtifactIds)).toBe(true);
    expect(Object.isFrozen(request.lineage.parentClipTakeIds)).toBe(true);
    expect(Object.isFrozen(request.output)).toBe(true);
    expect(Object.isFrozen(request.parameters)).toBe(true);
  });

  it('requires the exact Provider, Model, and pinned revision', () => {
    expect(() =>
      createStableAudio3TextToAudioJobRequest({
        ...createInput(),
        providerId: 'mock-provider',
      }),
    ).toThrow('Provider ID must be local-stable-audio-3');
    expect(() =>
      createStableAudio3TextToAudioJobRequest({
        ...createInput(),
        modelId: 'stable-audio-open-small',
      }),
    ).toThrow('Model ID must be stable-audio-3-medium');
    expect(() =>
      createStableAudio3TextToAudioJobRequest({
        ...createInput(),
        modelRevision: 'a'.repeat(40),
      }),
    ).toThrow(`Model revision must be ${MODEL_REVISION}`);
  });

  it('rejects unsafe Prompt, Seed, and Duration values', () => {
    expect(() =>
      createStableAudio3TextToAudioJobRequest({
        ...createInput(),
        prompt: ' padded ',
      }),
    ).toThrow('Prompt must be');
    expect(() =>
      createStableAudio3TextToAudioJobRequest({
        ...createInput(),
        seed: 1.5,
      }),
    ).toThrow('Seed must be an integer');
    expect(() =>
      createStableAudio3TextToAudioJobRequest({
        ...createInput(),
        durationSeconds: 381,
      }),
    ).toThrow('Duration must be greater than zero');
  });

  it('uses one stable typed error for contract failures', () => {
    try {
      createStableAudio3TextToAudioJobRequest({
        ...createInput(),
        prompt: '',
      });
      throw new Error('Expected an empty Prompt to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(StableAudio3TextToAudioJobContractError);
      expect((error as StableAudio3TextToAudioJobContractError).code).toBe(
        STABLE_AUDIO_3_TEXT_TO_AUDIO_JOB_CONTRACT_ERROR,
      );
    }
  });
});

function createInput() {
  return {
    durationSeconds: 16,
    modelId: 'stable-audio-3-medium',
    modelRevision: MODEL_REVISION,
    prompt: 'Warm analog synths with a patient cinematic build',
    providerId: 'local-stable-audio-3',
    seed: 17,
  } as const;
}
