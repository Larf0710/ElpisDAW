import { describe, expect, it } from 'vitest';

import {
  ACE_STEP_JOB_CONTRACT_ERROR,
  AceStepJobContractError,
  createAceStepJobRequest,
} from './aceStepJobContract';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  MidiArtifact,
  MidiClipTake,
} from './types';

const LYRICS_ID = 'artifact-12345678-1234-4abc-8def-1234567890ab';

describe('createAceStepJobRequest', () => {
  it('creates one exact immutable Guide Audio-to-vocals request', () => {
    const request = createAceStepJobRequest(createInput());

    expect(request).toEqual({
      guideSource: {
        artifactId: 'artifact-guide-a',
        clipTakeId: 'clip-take-midi-a',
        kind: 'midi-instrument-guide',
      },
      inputArtifacts: [
        {
          artifactId: 'artifact-guide-a',
          kind: 'audio',
          relativePath: 'renders/instruments/artifact-guide-a.wav',
          sizeBytes: 1_920_044,
        },
        {
          artifactId: LYRICS_ID,
          kind: 'lyrics',
          relativePath: `renders/ace-step/lyrics/${LYRICS_ID}.txt`,
        },
      ],
      lineage: {
        parentArtifactIds: ['artifact-guide-a', LYRICS_ID],
        parentClipTakeIds: ['clip-take-midi-a'],
      },
      modelId: 'acestep-v15-base',
      modelRevision: 'e432212fec32b8965a14ffa57ae653438d6abd14',
      output: {
        artifactKind: 'audio',
        destination: 'ace-step',
        extension: '.wav',
      },
      parameters: {
        audioFormat: 'wav',
        batchSize: 1,
        caption: 'Warm intimate lead vocal following the corrected melody',
        channels: 2,
        durationSeconds: 10,
        sampleRate: 48_000,
        seed: 1_370_421,
        targetTrack: 'vocals',
        taskType: 'lego',
        thinking: false,
        vocalLanguage: 'en',
      },
      providerId: 'local-ace-step',
      taskId: 'guide-audio-to-vocals',
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts[0])).toBe(true);
    expect(Object.isFrozen(request.lineage.parentArtifactIds)).toBe(true);
    expect(Object.isFrozen(request.parameters)).toBe(true);
  });

  it('requires the exact Provider, Model, and pinned revision', () => {
    expect(() =>
      createAceStepJobRequest({ ...createInput(), providerId: 'mock-provider' }),
    ).toThrow('Provider ID must be local-ace-step');
    expect(() =>
      createAceStepJobRequest({ ...createInput(), modelId: 'other-model' }),
    ).toThrow('Model ID must be acestep-v15-base');
    expect(() =>
      createAceStepJobRequest({ ...createInput(), modelRevision: 'main' }),
    ).toThrow('Model revision must be');
  });

  it('rejects Guide Audio that is not derived from the corrected MIDI Take', () => {
    const input = createInput();
    const guideAudioArtifact = {
      ...input.guideSource.guideAudioArtifact,
      lineage: {
        parentArtifactIds: ['artifact-midi-other'],
        parentClipTakeIds: ['clip-take-midi-a'],
      },
    };

    expect(() =>
      createAceStepJobRequest({
        ...input,
        guideSource: { ...input.guideSource, guideAudioArtifact },
      }),
    ).toThrow('Instrument render of the corrected MIDI Take');
  });

  it('rejects unsafe or inconsistent Lyrics snapshot identity', () => {
    const input = createInput();

    expect(() =>
      createAceStepJobRequest({
        ...input,
        lyricsSnapshot: {
          ...input.lyricsSnapshot,
          file: {
            ...input.lyricsSnapshot.file,
            relativePath: 'renders/ace-step/lyrics/../outside.txt',
          },
        },
      }),
    ).toThrow('immutable ACE-Step Lyrics snapshot');
  });

  it('rejects unsafe caption, language, seed, and duration mismatch', () => {
    expect(() =>
      createAceStepJobRequest({ ...createInput(), caption: ' padded ' }),
    ).toThrow('Caption must be');
    expect(() =>
      createAceStepJobRequest({ ...createInput(), vocalLanguage: 'EN' }),
    ).toThrow('lowercase ISO 639-1');
    expect(() =>
      createAceStepJobRequest({ ...createInput(), seed: -1 }),
    ).toThrow('Seed must be an integer');
    expect(() =>
      createAceStepJobRequest({ ...createInput(), durationSeconds: 11 }),
    ).toThrow('match the immutable Guide Audio duration');
  });

  it('uses one stable typed error for all contract failures', () => {
    try {
      createAceStepJobRequest({ ...createInput(), caption: '' });
      throw new Error('Expected invalid caption to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AceStepJobContractError);
      expect((error as AceStepJobContractError).code).toBe(
        ACE_STEP_JOB_CONTRACT_ERROR,
      );
    }
  });

  it('accepts one exact finalized source-free SA3 T2A Guide without MIDI lineage', () => {
    const input = createInput();
    const request = createAceStepJobRequest({
      ...input,
      guideSource: createTextToAudioGuideSource(),
    });

    expect(request.guideSource).toEqual({
      artifactId: 'artifact-sa3-t2a-a',
      clipTakeId: 'clip-take-sa3-t2a-a',
      kind: 'stable-audio-3-text-to-audio',
      modelId: 'stable-audio-3-medium',
      modelRevision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
      providerId: 'local-stable-audio-3',
      taskId: 'text-to-audio',
    });
    expect(request.lineage.parentClipTakeIds).toEqual([
      'clip-take-sa3-t2a-a',
    ]);
    expect(request.inputArtifacts[0]).toEqual({
      artifactId: 'artifact-sa3-t2a-a',
      kind: 'audio',
      relativePath: 'renders/stable-audio-3/artifact-sa3-t2a-a.wav',
      sizeBytes: 1_920_044,
    });
  });

  it('rejects unknown T2A Guide fields and wrong source-free provenance', () => {
    const input = createInput();
    const guideSource = createTextToAudioGuideSource();

    expect(() =>
      createAceStepJobRequest({
        ...input,
        guideSource: { ...guideSource, unexpected: true } as never,
      }),
    ).toThrow('unsupported fields');
    expect(() =>
      createAceStepJobRequest({
        ...input,
        guideSource: {
          ...guideSource,
          guideAudioArtifact: {
            ...guideSource.guideAudioArtifact,
            provenance: {
              ...guideSource.guideAudioArtifact.provenance,
              taskId: 'audio-to-audio',
            },
          },
        },
      }),
    ).toThrow('source-free Stable Audio 3 Text-to-Audio');
    expect(() =>
      createAceStepJobRequest({
        ...input,
        guideSource: {
          ...guideSource,
          guideAudioArtifact: {
            ...guideSource.guideAudioArtifact,
            file: {
              ...guideSource.guideAudioArtifact.file,
              relativePath: 'renders/instruments/artifact-sa3-t2a-a.wav',
            },
          },
        },
      }),
    ).toThrow('source-free Stable Audio 3 Text-to-Audio');

    for (const guideAudioArtifact of [
      { ...guideSource.guideAudioArtifact, destination: 'instrument' },
      {
        ...guideSource.guideAudioArtifact,
        provenance: {
          ...guideSource.guideAudioArtifact.provenance,
          providerId: 'other-provider',
        },
      },
      {
        ...guideSource.guideAudioArtifact,
        provenance: {
          ...guideSource.guideAudioArtifact.provenance,
          modelId: 'other-model',
        },
      },
      {
        ...guideSource.guideAudioArtifact,
        provenance: {
          ...guideSource.guideAudioArtifact.provenance,
          modelRevision: 'other-revision',
        },
      },
      {
        ...guideSource.guideAudioArtifact,
        lineage: {
          parentArtifactIds: ['artifact-forged-parent'],
          parentClipTakeIds: [],
        },
      },
    ]) {
      expect(() =>
        createAceStepJobRequest({
          ...input,
          guideSource: {
            ...guideSource,
            guideAudioArtifact: guideAudioArtifact as never,
          },
        }),
      ).toThrow('source-free Stable Audio 3 Text-to-Audio');
    }

    expect(() =>
      createAceStepJobRequest({
        ...input,
        guideSource: {
          ...guideSource,
          guideClipTake: {
            ...guideSource.guideClipTake,
            artifactId: 'artifact-other',
          },
        },
      }),
    ).toThrow('source-free Stable Audio 3 Text-to-Audio');
    expect(() =>
      createAceStepJobRequest({
        ...input,
        guideSource: {
          ...guideSource,
          guideAudioArtifact: {
            ...guideSource.guideAudioArtifact,
            unexpected: true,
          } as never,
        },
      }),
    ).toThrow('source-free Stable Audio 3 Text-to-Audio');

    const dangerousGuideSource = { ...guideSource } as Record<string, unknown>;
    Object.defineProperty(dangerousGuideSource, '__proto__', {
      enumerable: false,
      value: { polluted: true },
    });
    expect(() =>
      createAceStepJobRequest({
        ...input,
        guideSource: dangerousGuideSource as never,
      }),
    ).toThrow('unsupported fields');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

function createInput() {
  const midiArtifact = createMidiArtifact();
  const midiClipTake = createMidiClipTake();

  return {
    caption: 'Warm intimate lead vocal following the corrected melody',
    durationSeconds: 10,
    guideSource: {
      guideAudioArtifact: createGuideAudioArtifact(),
      kind: 'midi-instrument-guide' as const,
      midiArtifact,
      midiClipTake,
    },
    lyricsSnapshot: {
      artifactId: LYRICS_ID,
      createdAt: '2026-08-12T13:00:00.000Z',
      destination: 'ace-step-lyrics' as const,
      file: {
        extension: '.txt' as const,
        name: `${LYRICS_ID}.txt`,
        relativePath: `renders/ace-step/lyrics/${LYRICS_ID}.txt`,
        sizeBytes: 64,
      },
      kind: 'lyrics' as const,
      sha256: 'a'.repeat(64),
      status: 'FINALIZED' as const,
    },
    modelId: 'acestep-v15-base',
    modelRevision: 'e432212fec32b8965a14ffa57ae653438d6abd14',
    providerId: 'local-ace-step',
    seed: 1_370_421,
    vocalLanguage: 'en',
  };
}

function createMidiArtifact(): MidiArtifact {
  return {
    artifactId: 'artifact-midi-a',
    contentHash: 'midi-content-hash-a',
    createdAt: '2026-08-12T12:00:00.000Z',
    editProvenance: {
      editorId: 'humstudio-midi-editor',
      editorVersion: '1',
      taskId: 'midi-edit',
    },
    kind: 'midi',
    lineage: {
      parentArtifactIds: ['artifact-midi-source'],
      parentClipTakeIds: ['clip-take-midi-source'],
    },
    midi: {
      bpm: 120,
      notes: [
        {
          id: 'note-a',
          lengthTicks: 960,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
      ],
      ticksPerQuarter: 960,
    },
    revision: 1,
    sourceEditId: 'midi-edit-a',
    updatedAt: '2026-08-12T12:00:00.000Z',
  };
}

function createMidiClipTake(): MidiClipTake {
  return {
    artifactId: 'artifact-midi-a',
    clipTakeId: 'clip-take-midi-a',
    contentHash: 'midi-content-hash-a',
    createdAt: '2026-08-12T12:00:00.000Z',
    label: 'Corrected MIDI',
    mediaType: 'midi',
    revision: 1,
    sourceEditId: 'midi-edit-a',
    sourceType: 'edit',
    updatedAt: '2026-08-12T12:00:00.000Z',
  };
}

function createGuideAudioArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-guide-a',
    audio: {
      channels: 2,
      durationSeconds: 10,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-12T12:30:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-guide-a.wav',
      relativePath: 'renders/instruments/artifact-guide-a.wav',
      sizeBytes: 1_920_044,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-midi-a'],
      parentClipTakeIds: ['clip-take-midi-a'],
    },
    provenance: {
      modelId: 'soundfont-renderer',
      modelRevision: '1',
      parameters: {},
      providerId: 'local-fluidsynth',
      taskId: 'midi-to-audio',
    },
    sourceJobId: 'job-guide-a',
  };
}

function createTextToAudioGuideSource() {
  const guideAudioArtifact: GeneratedAudioArtifact = {
    artifactId: 'artifact-sa3-t2a-a',
    audio: {
      channels: 2,
      durationSeconds: 10,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-12T12:30:00.000Z',
    destination: 'stable-audio-3',
    file: {
      extension: '.wav',
      name: 'artifact-sa3-t2a-a.wav',
      relativePath: 'renders/stable-audio-3/artifact-sa3-t2a-a.wav',
      sizeBytes: 1_920_044,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'stable-audio-3-medium',
      modelRevision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
      parameters: {
        channels: 2,
        durationSeconds: 10,
        prompt: 'Focused instrumental backing',
        sampleRate: 44_100,
        seed: 7,
      },
      providerId: 'local-stable-audio-3',
      seed: 7,
      taskId: 'text-to-audio',
    },
    sourceJobId: 'job-sa3-t2a-a',
  };
  const guideClipTake: GeneratedAudioClipTake = {
    artifactId: guideAudioArtifact.artifactId,
    clipTakeId: 'clip-take-sa3-t2a-a',
    createdAt: guideAudioArtifact.createdAt,
    label: 'SA3 T2A Take 01',
    mediaType: 'audio',
    sourceJobId: guideAudioArtifact.sourceJobId,
    sourceType: 'job',
  };

  return {
    guideAudioArtifact,
    guideClipTake,
    kind: 'stable-audio-3-text-to-audio' as const,
  };
}
