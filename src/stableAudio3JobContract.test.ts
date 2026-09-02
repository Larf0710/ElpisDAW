import { describe, expect, it } from 'vitest';

import type { ActiveAudioTakeSourcePlan } from './activeAudioTakeSource';
import {
  createStableAudio3JobRequest,
  STABLE_AUDIO_3_JOB_CONTRACT_ERROR,
  StableAudio3JobContractError,
} from './stableAudio3JobContract';

const MODEL_REVISION = 'a'.repeat(40);

describe('createStableAudio3JobRequest', () => {
  it('creates one exact immutable Audio-to-Audio snapshot', () => {
    const request = createStableAudio3JobRequest(createRequestInput());

    expect(request).toEqual({
      inputArtifacts: [
        {
          artifactId: 'artifact-instrument-a',
          kind: 'audio',
          relativePath: 'renders/instruments/artifact-instrument-a.wav',
        },
      ],
      lineage: {
        parentArtifactIds: ['artifact-instrument-a'],
        parentClipTakeIds: ['clip-take-instrument-a'],
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
        durationSeconds: 12,
        prompt: 'Warm electric bass with a tight pocket',
        sampleRate: 44_100,
        seed: 7,
        sourceEndSeconds: 12,
        sourceStartSeconds: 0,
        strength: 0.4,
      },
      providerId: 'local-stable-audio-3',
      taskId: 'audio-to-audio',
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts[0])).toBe(true);
    expect(Object.isFrozen(request.lineage)).toBe(true);
    expect(Object.isFrozen(request.lineage.parentArtifactIds)).toBe(true);
    expect(Object.isFrozen(request.output)).toBe(true);
    expect(Object.isFrozen(request.parameters)).toBe(true);
  });

  it('supports any explicitly allowed Audio Take source without becoming instrument-only', () => {
    const request = createStableAudio3JobRequest({
      ...createRequestInput(),
      plan: createPlan({
        artifactId: 'artifact-raw-mixdown',
        clipId: 'clip-raw-mixdown',
        clipTakeId: 'clip-take-raw-mixdown',
        durationSeconds: 30,
        name: 'artifact-raw-mixdown.wav',
        relativePath: 'mixdowns/artifact-raw-mixdown.wav',
        sourceEndSeconds: 24,
        sourceStartSeconds: 4,
      }),
    });

    expect(request.inputArtifacts[0]).toEqual({
      artifactId: 'artifact-raw-mixdown',
      kind: 'audio',
      relativePath: 'mixdowns/artifact-raw-mixdown.wav',
    });
    expect(request.lineage.parentClipTakeIds).toEqual([
      'clip-take-raw-mixdown',
    ]);
    expect(request.parameters).toMatchObject({
      sourceEndSeconds: 24,
      sourceStartSeconds: 4,
    });
  });

  it('requires the exact Provider, Model, and pinned model revision', () => {
    expect(() =>
      createStableAudio3JobRequest({
        ...createRequestInput(),
        providerId: 'mock-provider',
      }),
    ).toThrow('Provider ID must be local-stable-audio-3');

    expect(() =>
      createStableAudio3JobRequest({
        ...createRequestInput(),
        modelId: 'stable-audio-open-small',
      }),
    ).toThrow('Model ID must be stable-audio-3-medium');

    for (const modelRevision of [
      'hugging-face-main-unpinned',
      'main',
      'A'.repeat(40),
      'a'.repeat(39),
    ]) {
      expect(() =>
        createStableAudio3JobRequest({
          ...createRequestInput(),
          modelRevision,
        }),
      ).toThrow('exact lowercase 40-character commit hash');
    }
  });

  it('rejects mismatched source identity and paths outside the audio allowlist', () => {
    const mismatched = createPlan();
    mismatched.descriptor.sourceId = 'artifact-other';

    expect(() =>
      createStableAudio3JobRequest({
        ...createRequestInput(),
        plan: mismatched,
      }),
    ).toThrow('descriptor must match');

    for (const relativePath of [
      '../outside.wav',
      'renders/instruments/../outside.wav',
      'models/source.wav',
      'renders/instruments/source.wav.partial',
    ]) {
      const pathSegments = relativePath.split('/');
      const plan = createPlan({
        name: pathSegments[pathSegments.length - 1] ?? 'source.wav',
        relativePath,
      });

      expect(() =>
        createStableAudio3JobRequest({
          ...createRequestInput(),
          plan,
        }),
      ).toThrow(StableAudio3JobContractError);
    }
  });

  it('rejects unsafe prompt, strength, seed, duration, and source ranges', () => {
    expect(() =>
      createStableAudio3JobRequest({
        ...createRequestInput(),
        prompt: ' padded ',
      }),
    ).toThrow('Prompt must be');
    expect(() =>
      createStableAudio3JobRequest({
        ...createRequestInput(),
        strength: 1.1,
      }),
    ).toThrow('Strength must be between 0 and 1');
    expect(() =>
      createStableAudio3JobRequest({
        ...createRequestInput(),
        seed: -1,
      }),
    ).toThrow('Seed must be an integer');
    expect(() =>
      createStableAudio3JobRequest({
        ...createRequestInput(),
        durationSeconds: 381,
      }),
    ).toThrow('Duration must be between');
    expect(() =>
      createStableAudio3JobRequest({
        ...createRequestInput(),
        plan: createPlan({
          durationSeconds: 12,
          sourceEndSeconds: 13,
        }),
      }),
    ).toThrow('Source end must be between');
  });

  it('uses one stable typed error for contract failures', () => {
    try {
      createStableAudio3JobRequest({
        ...createRequestInput(),
        prompt: '',
      });
      throw new Error('Expected an empty prompt to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(StableAudio3JobContractError);
      expect((error as StableAudio3JobContractError).code).toBe(
        STABLE_AUDIO_3_JOB_CONTRACT_ERROR,
      );
    }
  });
});

function createRequestInput() {
  return {
    durationSeconds: 12,
    modelId: 'stable-audio-3-medium',
    modelRevision: MODEL_REVISION,
    plan: createPlan(),
    prompt: 'Warm electric bass with a tight pocket',
    providerId: 'local-stable-audio-3',
    seed: 7,
    strength: 0.4,
  } as const;
}

function createPlan(
  overrides: Partial<{
    artifactId: string;
    clipId: string;
    clipTakeId: string;
    durationSeconds: number;
    name: string;
    relativePath: string;
    sourceEndSeconds: number;
    sourceStartSeconds: number;
  }> = {},
): ActiveAudioTakeSourcePlan & {
  descriptor: ActiveAudioTakeSourcePlan['descriptor'] & { sourceId: string };
} {
  const artifactId = overrides.artifactId ?? 'artifact-instrument-a';
  const clipId = overrides.clipId ?? 'clip-instrument-a';
  const clipTakeId = overrides.clipTakeId ?? 'clip-take-instrument-a';
  const durationSeconds = overrides.durationSeconds ?? 12;
  const name = overrides.name ?? 'artifact-instrument-a.wav';
  const relativePath =
    overrides.relativePath ?? 'renders/instruments/artifact-instrument-a.wav';
  const sourceStartSeconds = overrides.sourceStartSeconds ?? 0;
  const sourceEndSeconds = overrides.sourceEndSeconds ?? durationSeconds;

  return {
    clip: {
      activeClipTakeId: clipTakeId,
      audioTiming: {
        sourceEndSeconds,
        sourceStartSeconds,
        timeBase: 'absolute-seconds',
      },
      color: '#000000',
      createdAt: '2026-08-02T00:00:00.000Z',
      id: clipId,
      lengthTicks: 23_040,
      name: 'Instrument Audio A',
      sourceFile: {
        durationSeconds,
        mimeType: 'audio/wav',
        name,
        relativePath,
        sizeBytes: 2_116_844,
        sourceId: artifactId,
        status: 'available',
      },
      startTick: 0,
      type: 'instrument-audio',
      version: 1,
    },
    descriptor: {
      kind: 'generated',
      name,
      relativePath,
      sizeBytes: 2_116_844,
      sourceId: artifactId,
    },
    source: {
      artifactId,
      clipId,
      clipTakeId,
    },
  };
}
