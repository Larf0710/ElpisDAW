import { describe, expect, it } from 'vitest';
import {
  addMidiNote,
  deleteMidiNote,
  deleteMidiNotes,
  hasMidiNoteAtPosition,
  moveMidiNote,
  moveMidiNotesBy,
  resizeMidiNoteEnd,
  resizeMidiNoteEndsBy,
  snapMidiTick,
} from './midiNoteEditing';
import type { MidiNote } from './types';

const GRID_STEP_TICKS = 480;

describe('MIDI note editing', () => {
  it('adds a note and preserves canonical timeline order', () => {
    const notes = createNotes();
    const added = addMidiNote(notes, {
      confidence: 0.75,
      id: 'note-middle',
      lengthTicks: 240,
      pitch: 62,
      startTick: 480,
      velocity: 90,
    });

    expect(added.map((note) => note.id)).toEqual([
      'note-first',
      'note-middle',
      'note-last',
    ]);
    expect(added).not.toBe(notes);
    expect(added[1].confidence).toBeUndefined();
    expect(notes).toHaveLength(2);
    expect(Object.isFrozen(added)).toBe(true);
  });

  it('snaps a newly added note start and end to the grid', () => {
    const added = addMidiNote(
      [],
      {
        id: 'note-new',
        lengthTicks: 300,
        pitch: 64,
        startTick: 250,
        velocity: 96,
      },
      { gridStepTicks: GRID_STEP_TICKS },
    );

    expect(added[0]).toMatchObject({
      lengthTicks: GRID_STEP_TICKS,
      startTick: GRID_STEP_TICKS,
    });
  });

  it('rejects a duplicate note ID', () => {
    expect(() =>
      addMidiNote(createNotes(), {
        id: 'note-first',
        lengthTicks: 240,
        pitch: 65,
        startTick: 1_440,
        velocity: 80,
      }),
    ).toThrow('must be unique');
  });

  it('deletes exactly one note without mutating the source', () => {
    const notes = createNotes();
    const deleted = deleteMidiNote(notes, 'note-first');

    expect(deleted.map((note) => note.id)).toEqual(['note-last']);
    expect(notes.map((note) => note.id)).toEqual([
      'note-last',
      'note-first',
    ]);
  });

  it('rejects deletion of an unknown note', () => {
    expect(() => deleteMidiNote(createNotes(), 'note-missing')).toThrow(
      'MIDI note "note-missing" does not exist.',
    );
  });

  it('deletes a selected note group without touching other notes', () => {
    const deleted = deleteMidiNotes(
      [
        ...createNotes(),
        {
          id: 'note-kept',
          lengthTicks: 240,
          pitch: 67,
          startTick: 1_920,
          velocity: 100,
        },
      ],
      ['note-first', 'note-last'],
    );

    expect(deleted.map((note) => note.id)).toEqual(['note-kept']);
  });

  it('detects an occupied pitch and start without blocking other overlaps', () => {
    const notes = createNotes();

    expect(
      hasMidiNoteAtPosition(notes, { pitch: 60, startTick: 0 }),
    ).toBe(true);
    expect(
      hasMidiNoteAtPosition(notes, { pitch: 61, startTick: 0 }),
    ).toBe(false);
    expect(
      hasMidiNoteAtPosition(notes, { pitch: 60, startTick: 120 }),
    ).toBe(false);
  });

  it('moves pitch and start position with optional grid snap', () => {
    const moved = moveMidiNote(
      createNotes(),
      'note-first',
      { pitch: 67, startTick: 731 },
      { gridStepTicks: GRID_STEP_TICKS },
    );

    expect(moved.find((note) => note.id === 'note-first')).toMatchObject({
      lengthTicks: 240,
      pitch: 67,
      startTick: 960,
    });
    expect(
      moved.find((note) => note.id === 'note-first')?.confidence,
    ).toBeUndefined();
    expect(
      moved.find((note) => note.id === 'note-last')?.confidence,
    ).toBe(0.8);
  });

  it('clamps moved notes to MIDI and timeline boundaries', () => {
    const moved = moveMidiNote(createNotes(), 'note-first', {
      pitch: 200,
      startTick: -500,
    });

    expect(moved.find((note) => note.id === 'note-first')).toMatchObject({
      pitch: 127,
      startTick: 0,
    });
  });

  it('moves a selected note group by one shared snapped delta', () => {
    const moved = moveMidiNotesBy(
      createNotes(),
      ['note-first', 'note-last'],
      { pitchDelta: 3, tickDelta: 550 },
      { gridStepTicks: GRID_STEP_TICKS },
    );

    expect(moved).toMatchObject([
      {
        id: 'note-first',
        pitch: 63,
        startTick: 480,
      },
      {
        id: 'note-last',
        pitch: 67,
        startTick: 1_440,
      },
    ]);
  });

  it('clamps a selected note group as a unit at timeline and pitch bounds', () => {
    const moved = moveMidiNotesBy(
      createNotes(),
      ['note-first', 'note-last'],
      { pitchDelta: 100, tickDelta: -960 },
      { gridStepTicks: GRID_STEP_TICKS },
    );

    expect(moved).toMatchObject([
      {
        id: 'note-first',
        pitch: 123,
        startTick: 0,
      },
      {
        id: 'note-last',
        pitch: 127,
        startTick: 960,
      },
    ]);
  });

  it('resizes a note end with grid snap', () => {
    const resized = resizeMidiNoteEnd(
      createNotes(),
      'note-first',
      1_100,
      { gridStepTicks: GRID_STEP_TICKS },
    );

    expect(resized.find((note) => note.id === 'note-first')).toMatchObject({
      lengthTicks: 960,
      startTick: 0,
    });
    expect(
      resized.find((note) => note.id === 'note-first')?.confidence,
    ).toBeUndefined();
  });

  it('keeps a resized note positive when the requested end precedes its start', () => {
    const resized = resizeMidiNoteEnd(
      [
        {
          id: 'note-offset',
          lengthTicks: 480,
          pitch: 60,
          startTick: 500,
          velocity: 100,
        },
      ],
      'note-offset',
      400,
      { gridStepTicks: GRID_STEP_TICKS },
    );

    expect(resized[0]).toMatchObject({
      lengthTicks: 460,
      startTick: 500,
    });
  });

  it('resizes a selected note group by one shared delta', () => {
    const resized = resizeMidiNoteEndsBy(
      createNotes(),
      ['note-first', 'note-last'],
      550,
      { gridStepTicks: GRID_STEP_TICKS },
    );

    expect(resized).toMatchObject([
      {
        id: 'note-first',
        lengthTicks: 720,
      },
      {
        id: 'note-last',
        lengthTicks: 960,
      },
    ]);
  });

  it('limits group shortening when the shortest note reaches one grid step', () => {
    const resized = resizeMidiNoteEndsBy(
      createNotes(),
      ['note-first', 'note-last'],
      -960,
      { gridStepTicks: 120 },
    );

    expect(resized).toMatchObject([
      {
        id: 'note-first',
        lengthTicks: 120,
      },
      {
        id: 'note-last',
        lengthTicks: 360,
      },
    ]);
  });

  it('rounds ticks to the nearest grid line', () => {
    expect(snapMidiTick(239, GRID_STEP_TICKS)).toBe(0);
    expect(snapMidiTick(240, GRID_STEP_TICKS)).toBe(GRID_STEP_TICKS);
    expect(snapMidiTick(721, GRID_STEP_TICKS)).toBe(960);
  });

  it('rejects invalid edit values before producing unsafe MIDI data', () => {
    expect(() => snapMidiTick(100, 0)).toThrow(
      'MIDI grid step must be positive.',
    );
    expect(() =>
      moveMidiNote(createNotes(), 'note-first', {
        pitch: Number.NaN,
        startTick: 0,
      }),
    ).toThrow('MIDI note pitch must be a safe integer.');
    expect(() =>
      resizeMidiNoteEnd(
        [
          {
            id: 'note-max',
            lengthTicks: 1,
            pitch: 60,
            startTick: Number.MAX_SAFE_INTEGER - 1,
            velocity: 100,
          },
        ],
        'note-max',
        Number.MAX_SAFE_INTEGER,
        { gridStepTicks: 4 },
      ),
    ).toThrow('exceeds the safe integer range');
  });
});

function createNotes(): MidiNote[] {
  return [
    {
      id: 'note-last',
      confidence: 0.8,
      lengthTicks: 480,
      pitch: 64,
      startTick: 960,
      velocity: 96,
    },
    {
      id: 'note-first',
      confidence: 0.9,
      lengthTicks: 240,
      pitch: 60,
      startTick: 0,
      velocity: 88,
    },
  ];
}
