import { describe, expect, it } from 'vitest';

import type { ActiveMidiTakePlan } from './activeMidiTake';
import {
  createInstrumentRenderJobRequest,
  INSTRUMENT_RENDER_CONTRACT_ERROR,
  InstrumentRenderContractError,
} from './instrumentRenderContract';
import { TICKS_PER_QUARTER } from './workflow';

describe('createInstrumentRenderJobRequest', () => {
  it('creates one immutable MIDI-to-audio Job from the Active MIDI Take', () => {
    const plan = createActiveMidiTakePlan();
    const request = createInstrumentRenderJobRequest({
      gainDb: -3,
      modelId: 'general-user-gs',
      modelRevision: 'sha256-abc123',
      plan,
      preset: {
        bank: 0,
        program: 24,
      },
      providerId: 'local-fluidsynth',
      providerVersion: '2.4.6',
      sampleRate: 48_000,
    });

    expect(request).toEqual({
      inputArtifacts: [
        {
          artifactId: 'artifact-midi-edited-1',
          kind: 'midi',
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
              {
                id: 'note-b',
                lengthTicks: 480,
                pitch: 67,
                startTick: 960,
                velocity: 90,
              },
            ],
            ticksPerQuarter: TICKS_PER_QUARTER,
          },
        },
      ],
      lineage: {
        parentArtifactIds: ['artifact-midi-edited-1'],
        parentClipTakeIds: ['clip-take-midi-edited-1'],
      },
      modelId: 'general-user-gs',
      modelRevision: 'sha256-abc123',
      output: {
        artifactKind: 'audio',
        destination: 'instrument',
        extension: '.wav',
      },
      parameters: {
        channels: 2,
        gainDb: -3,
        preset: {
          bank: 0,
          program: 24,
        },
        providerVersion: '2.4.6',
        sampleRate: 48_000,
        sourceMidiContentHash: 'fnv1a64-2018e2fb1a952156',
        sourceMidiRevision: 1,
      },
      providerId: 'local-fluidsynth',
      taskId: 'midi-to-audio',
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts[0])).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts[0].midi)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts[0].midi.notes)).toBe(true);
    expect(Object.isFrozen(request.lineage)).toBe(true);
    expect(Object.isFrozen(request.lineage.parentArtifactIds)).toBe(true);
    expect(Object.isFrozen(request.output)).toBe(true);
    expect(Object.isFrozen(request.parameters)).toBe(true);
    expect(Object.isFrozen(request.parameters.preset)).toBe(true);
  });

  it('clones and normalizes MIDI data without retaining caller mutations', () => {
    const mutableNotes = [
      {
        id: 'note-later',
        lengthTicks: 480,
        pitch: 67,
        startTick: 960,
        velocity: 90,
      },
      {
        id: 'note-first',
        lengthTicks: 960,
        pitch: 60,
        startTick: 0,
        velocity: 100,
      },
    ];
    const plan = createActiveMidiTakePlan(mutableNotes);
    const request = createInstrumentRenderJobRequest({
      ...createRequestInput(),
      plan,
    });

    mutableNotes[0].pitch = 1;

    expect(request.inputArtifacts[0].midi.notes.map((note) => note.id)).toEqual([
      'note-first',
      'note-later',
    ]);
    expect(request.inputArtifacts[0].midi.notes[1].pitch).toBe(67);
  });

  it('snapshots one Project SoundFont identity for production rendering', () => {
    const revisionToken = 'a'.repeat(64);
    const resourceId = `soundfont-${'b'.repeat(32)}`;
    const request = createInstrumentRenderJobRequest({
      ...createRequestInput(),
      modelId: resourceId,
      modelRevision: revisionToken,
      providerVersion: '2.5.7',
      soundFont: {
        format: 'sf2',
        library: 'project',
        relativePath: 'soundfonts/Studio Keys.sf2',
        resourceId,
        revisionToken,
      },
    });

    expect(request.parameters.soundFont).toEqual({
      format: 'sf2',
      library: 'project',
      relativePath: 'soundfonts/Studio Keys.sf2',
      resourceId,
      revisionToken,
    });
    expect(Object.isFrozen(request.parameters.soundFont)).toBe(true);

    expect(() =>
      createInstrumentRenderJobRequest({
        ...createRequestInput(),
        modelId: resourceId,
        modelRevision: 'c'.repeat(64),
        soundFont: {
          format: 'sf2',
          library: 'project',
          relativePath: 'soundfonts/Studio Keys.sf2',
          resourceId,
          revisionToken,
        },
      }),
    ).toThrow('must match the selected SoundFont resource');
  });

  it('rejects empty or invalid MIDI before a render file can be requested', () => {
    expect(() =>
      createInstrumentRenderJobRequest({
        ...createRequestInput(),
        plan: createActiveMidiTakePlan([]),
      }),
    ).toThrow('requires at least one MIDI note');

    expect(() =>
      createInstrumentRenderJobRequest({
        ...createRequestInput(),
        plan: createActiveMidiTakePlan([
          {
            id: 'note-invalid',
            lengthTicks: 480,
            pitch: 128,
            startTick: 0,
            velocity: 100,
          },
        ]),
      }),
    ).toThrow('pitch must be an integer between 0 and 127');

    expect(() =>
      createInstrumentRenderJobRequest({
        ...createRequestInput(),
        plan: {
          ...createActiveMidiTakePlan(),
          midi: {
            ...createActiveMidiTakePlan().midi,
            ticksPerQuarter: 480,
          },
        } as unknown as ActiveMidiTakePlan,
      }),
    ).toThrow(`ticks per quarter must be ${TICKS_PER_QUARTER}`);
  });

  it('rejects invalid SoundFont, Provider, Preset, Gain, and sample rate values', () => {
    expect(() =>
      createInstrumentRenderJobRequest({
        ...createRequestInput(),
        modelId: 'General User GS',
      }),
    ).toThrow('SoundFont Model ID must use lowercase');

    expect(() =>
      createInstrumentRenderJobRequest({
        ...createRequestInput(),
        providerId: 'Local FluidSynth',
      }),
    ).toThrow('Provider ID must use lowercase');

    expect(() =>
      createInstrumentRenderJobRequest({
        ...createRequestInput(),
        preset: {
          bank: 0,
          program: 128,
        },
      }),
    ).toThrow('Preset program must be an integer between 0 and 127');

    expect(() =>
      createInstrumentRenderJobRequest({
        ...createRequestInput(),
        gainDb: 13,
      }),
    ).toThrow('Render gain must be between -60 and 12');

    expect(() =>
      createInstrumentRenderJobRequest({
        ...createRequestInput(),
        sampleRate: 44_100.5,
      }),
    ).toThrow('Render sample rate must be an integer');
  });

  it('uses a stable typed error for contract failures', () => {
    try {
      createInstrumentRenderJobRequest({
        ...createRequestInput(),
        providerVersion: '',
      });
      throw new Error('Expected the contract to reject an empty Provider version.');
    } catch (error) {
      expect(error).toBeInstanceOf(InstrumentRenderContractError);
      expect((error as InstrumentRenderContractError).code).toBe(
        INSTRUMENT_RENDER_CONTRACT_ERROR,
      );
    }
  });
});

function createRequestInput() {
  return {
    gainDb: -3,
    modelId: 'general-user-gs',
    modelRevision: 'sha256-abc123',
    plan: createActiveMidiTakePlan(),
    preset: {
      bank: 0,
      program: 24,
    },
    providerId: 'local-fluidsynth',
    providerVersion: '2.4.6',
    sampleRate: 48_000,
  } as const;
}

function createActiveMidiTakePlan(
  notes = [
    {
      id: 'note-a',
      lengthTicks: 960,
      pitch: 60,
      startTick: 0,
      velocity: 100,
    },
    {
      id: 'note-b',
      lengthTicks: 480,
      pitch: 67,
      startTick: 960,
      velocity: 90,
    },
  ],
): ActiveMidiTakePlan {
  return {
    midi: {
      bpm: 120,
      notes,
      ticksPerQuarter: TICKS_PER_QUARTER,
    },
    source: {
      artifactId: 'artifact-midi-edited-1',
      clipId: 'clip-midi-1',
      clipTakeId: 'clip-take-midi-edited-1',
      contentHash: 'fnv1a64-2018e2fb1a952156',
      label: 'Edited Take 01',
      revision: 1,
      sourceType: 'edit',
    },
  };
}
