import { describe, expect, it } from 'vitest';

import {
  createHumToMidiJobRequest,
  createInlineMidiArtifact,
  HUM_TO_MIDI_CONTRACT_ERROR,
  HumToMidiContractError,
} from './humToMidiContract';
import { TICKS_PER_QUARTER } from './workflow';

describe('createHumToMidiJobRequest', () => {
  it('creates an immutable request for one recorded audio take', () => {
    const parameters = {
      onsetThreshold: 0.5,
      postProcessing: {
        minimumNoteLengthMs: 80,
      },
    };
    const request = createHumToMidiJobRequest({
      modelId: 'basic-pitch',
      modelRevision: 'v1',
      parameters,
      projectBpm: 120,
      providerId: 'local-basic-pitch',
      source: {
        artifactId: 'artifact-recording-1',
        clipTakeId: 'clip-take-recording-1',
        sourceEndSeconds: 4.5,
        sourceStartSeconds: 0.5,
      },
    });

    parameters.postProcessing.minimumNoteLengthMs = 999;

    expect(request).toEqual({
      modelId: 'basic-pitch',
      modelRevision: 'v1',
      parameters: {
        onsetThreshold: 0.5,
        postProcessing: {
          minimumNoteLengthMs: 80,
        },
      },
      projectBpm: 120,
      providerId: 'local-basic-pitch',
      source: {
        artifactId: 'artifact-recording-1',
        clipTakeId: 'clip-take-recording-1',
        sourceEndSeconds: 4.5,
        sourceStartSeconds: 0.5,
      },
      taskId: 'hum-to-midi',
      ticksPerQuarter: TICKS_PER_QUARTER,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.source)).toBe(true);
    expect(Object.isFrozen(request.parameters)).toBe(true);
    expect(Object.isFrozen(request.parameters.postProcessing)).toBe(true);
  });

  it('rejects invalid source ranges and Project BPM values', () => {
    expect(() =>
      createHumToMidiJobRequest({
        ...createRequestInput(),
        source: {
          ...createRequestInput().source,
          sourceEndSeconds: 1,
          sourceStartSeconds: 1,
        },
      }),
    ).toThrow('Source end must be after Source start');

    expect(() =>
      createHumToMidiJobRequest({
        ...createRequestInput(),
        projectBpm: 241,
      }),
    ).toThrow('Project BPM must be between 40 and 240');
  });

  it('rejects non-JSON and circular provider parameters', () => {
    expect(() =>
      createHumToMidiJobRequest({
        ...createRequestInput(),
        parameters: {
          threshold: Number.NaN,
        },
      }),
    ).toThrow('finite numbers');

    const circularParameters: Record<string, unknown> = {};
    circularParameters.self = circularParameters;

    expect(() =>
      createHumToMidiJobRequest({
        ...createRequestInput(),
        parameters: circularParameters as never,
      }),
    ).toThrow('circular references');
  });
});

describe('createInlineMidiArtifact', () => {
  it('derives lineage and provenance and returns notes in deterministic order', () => {
    const request = createHumToMidiJobRequest(createRequestInput());
    const artifact = createInlineMidiArtifact(
      {
        artifactId: 'artifact-midi-1',
        createdAt: '2026-07-25T12:34:56Z',
        notes: [
          {
            confidence: 0.8,
            id: 'note-c',
            lengthTicks: 480,
            pitch: 67,
            startTick: 960,
            velocity: 90,
          },
          {
            confidence: 0.95,
            id: 'note-a',
            lengthTicks: 960,
            pitch: 60,
            startTick: 0,
            velocity: 100,
          },
          {
            id: 'note-b',
            lengthTicks: 480,
            pitch: 64,
            startTick: 960,
            velocity: 80,
          },
        ],
        sourceJobId: 'job-hum-to-midi-1',
      },
      request,
    );

    expect(artifact.createdAt).toBe('2026-07-25T12:34:56.000Z');
    expect(artifact.kind).toBe('midi');
    expect(artifact.lineage).toEqual({
      parentArtifactIds: ['artifact-recording-1'],
      parentClipTakeIds: ['clip-take-recording-1'],
    });
    expect(artifact.midi).toMatchObject({
      bpm: 120,
      ticksPerQuarter: TICKS_PER_QUARTER,
    });
    expect(artifact.midi.notes.map((note) => note.id)).toEqual([
      'note-a',
      'note-b',
      'note-c',
    ]);
    expect(artifact.provenance).toEqual({
      modelId: 'basic-pitch',
      modelRevision: 'v1',
      parameters: {
        onsetThreshold: 0.5,
      },
      providerId: 'local-basic-pitch',
      taskId: 'hum-to-midi',
    });
  });

  it('returns a deeply immutable inline artifact', () => {
    const artifact = createInlineMidiArtifact(
      {
        artifactId: 'artifact-midi-1',
        createdAt: '2026-07-25T12:34:56.000Z',
        notes: [
          {
            confidence: 0.9,
            id: 'note-a',
            lengthTicks: 480,
            pitch: 60,
            startTick: 0,
            velocity: 100,
          },
        ],
        sourceJobId: 'job-hum-to-midi-1',
      },
      createHumToMidiJobRequest(createRequestInput()),
    );

    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.lineage)).toBe(true);
    expect(Object.isFrozen(artifact.lineage.parentArtifactIds)).toBe(true);
    expect(Object.isFrozen(artifact.midi)).toBe(true);
    expect(Object.isFrozen(artifact.midi.notes)).toBe(true);
    expect(Object.isFrozen(artifact.midi.notes[0])).toBe(true);
    expect(Object.isFrozen(artifact.provenance)).toBe(true);
    expect(Object.isFrozen(artifact.provenance.parameters)).toBe(true);
  });

  it('allows a valid empty transcription result', () => {
    const artifact = createInlineMidiArtifact(
      {
        artifactId: 'artifact-midi-empty',
        createdAt: '2026-07-25T12:34:56.000Z',
        notes: [],
        sourceJobId: 'job-hum-to-midi-empty',
      },
      createHumToMidiJobRequest(createRequestInput()),
    );

    expect(artifact.midi.notes).toEqual([]);
  });

  it('rejects duplicate IDs and invalid MIDI note values', () => {
    const request = createHumToMidiJobRequest(createRequestInput());
    const validNote = {
      id: 'note-a',
      lengthTicks: 480,
      pitch: 60,
      startTick: 0,
      velocity: 100,
    };

    expect(() =>
      createInlineMidiArtifact(
        {
          artifactId: 'artifact-midi-1',
          createdAt: '2026-07-25T12:34:56.000Z',
          notes: [validNote, validNote],
          sourceJobId: 'job-hum-to-midi-1',
        },
        request,
      ),
    ).toThrow('must be unique');

    expect(() =>
      createInlineMidiArtifact(
        {
          artifactId: 'artifact-midi-1',
          createdAt: '2026-07-25T12:34:56.000Z',
          notes: [{ ...validNote, pitch: 128 }],
          sourceJobId: 'job-hum-to-midi-1',
        },
        request,
      ),
    ).toThrow('pitch must be an integer between 0 and 127');

    expect(() =>
      createInlineMidiArtifact(
        {
          artifactId: 'artifact-midi-1',
          createdAt: '2026-07-25T12:34:56.000Z',
          notes: [{ ...validNote, confidence: 1.1 }],
          sourceJobId: 'job-hum-to-midi-1',
        },
        request,
      ),
    ).toThrow('confidence must be between 0 and 1');
  });

  it('uses a stable typed error for boundary failures', () => {
    try {
      createInlineMidiArtifact(
        {
          artifactId: 'artifact-midi-1',
          createdAt: 'not-a-date',
          notes: [],
          sourceJobId: 'job-hum-to-midi-1',
        },
        createHumToMidiJobRequest(createRequestInput()),
      );
      throw new Error('Expected the contract to reject an invalid timestamp.');
    } catch (error) {
      expect(error).toBeInstanceOf(HumToMidiContractError);
      expect((error as HumToMidiContractError).code).toBe(
        HUM_TO_MIDI_CONTRACT_ERROR,
      );
    }
  });
});

function createRequestInput() {
  return {
    modelId: 'basic-pitch',
    modelRevision: 'v1',
    parameters: {
      onsetThreshold: 0.5,
    },
    projectBpm: 120,
    providerId: 'local-basic-pitch',
    source: {
      artifactId: 'artifact-recording-1',
      clipTakeId: 'clip-take-recording-1',
      sourceEndSeconds: 4,
      sourceStartSeconds: 0,
    },
  } as const;
}
