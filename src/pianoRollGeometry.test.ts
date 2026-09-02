import { describe, expect, it } from 'vitest';

import {
  createPianoRollNoteRect,
  createPianoRollMarqueeRect,
  getMidiNoteName,
  getPianoRollClipEndX,
  getPianoRollContentWidth,
  getPianoRollContentWidthForClip,
  getPianoRollDirectDrawLengthTicks,
  getPianoRollGridStepTicks,
  getPianoRollNoteIdsInMarquee,
  getPianoRollOctaveScrollTop,
  getPianoRollRowHeight,
  isBlackMidiPitch,
  midiPitchToPianoRollY,
  midiTickToPianoRollX,
  pianoRollPixelDeltaToSemitones,
  pianoRollPixelDeltaToTicks,
  resolvePianoRollMarqueeSelection,
  togglePianoRollNoteSelection,
  pianoRollXToMidiTick,
  pianoRollYToMidiPitch,
  PIANO_ROLL_GRID_DENOMINATORS,
  PIANO_ROLL_QUARTER_WIDTH_PX,
  PIANO_ROLL_ROW_HEIGHT_PX,
  PIANO_ROLL_VISIBLE_PITCHES,
} from './pianoRollGeometry';
import type { MidiNote } from './types';

const TICKS_PER_QUARTER = 480;

describe('Piano Roll geometry', () => {
  it('maps ticks and pitches to deterministic DOM coordinates', () => {
    expect(midiTickToPianoRollX(0, TICKS_PER_QUARTER)).toBe(0);
    expect(midiTickToPianoRollX(960, TICKS_PER_QUARTER)).toBe(
      PIANO_ROLL_QUARTER_WIDTH_PX * 2,
    );
    expect(midiPitchToPianoRollY(127)).toBe(0);
    expect(midiPitchToPianoRollY(60)).toBe(
      (127 - 60) * PIANO_ROLL_ROW_HEIGHT_PX,
    );
  });

  it('expands the edit surface when the Timeline MIDI Clip is extended', () => {
    expect(
      getPianoRollContentWidthForClip([], TICKS_PER_QUARTER, 7_680),
    ).toBe(PIANO_ROLL_QUARTER_WIDTH_PX * 20);
    expect(
      getPianoRollContentWidthForClip([], TICKS_PER_QUARTER, 15_360),
    ).toBe(PIANO_ROLL_QUARTER_WIDTH_PX * 36);
  });

  it('places the Clip end before the dedicated edit padding', () => {
    const clipLengthTicks = 7_680;
    const clipEndX = getPianoRollClipEndX(
      clipLengthTicks,
      TICKS_PER_QUARTER,
    );

    expect(clipEndX).toBe(PIANO_ROLL_QUARTER_WIDTH_PX * 16);
    expect(
      getPianoRollContentWidthForClip(
        [],
        TICKS_PER_QUARTER,
        clipLengthTicks,
      ) - clipEndX,
    ).toBe(PIANO_ROLL_QUARTER_WIDTH_PX * 4);
  });

  it('converts pointer movement back into tick and semitone deltas', () => {
    expect(pianoRollPixelDeltaToTicks(48, TICKS_PER_QUARTER)).toBe(240);
    expect(pianoRollPixelDeltaToTicks(-24, TICKS_PER_QUARTER)).toBe(-120);
    expect(pianoRollPixelDeltaToSemitones(-36)).toBe(2);
    expect(pianoRollPixelDeltaToSemitones(18)).toBe(-1);
  });

  it('keeps direct-draw insertion at one step until dragged right', () => {
    const gridStepTicks = getPianoRollGridStepTicks(TICKS_PER_QUARTER);

    expect(getPianoRollDirectDrawLengthTicks(960, 960, gridStepTicks)).toBe(120);
    expect(getPianoRollDirectDrawLengthTicks(960, 1_440, gridStepTicks)).toBe(
      480,
    );
    expect(getPianoRollDirectDrawLengthTicks(960, 720, gridStepTicks)).toBe(120);
  });

  it('maps grid positions back into MIDI ticks and pitches', () => {
    expect(pianoRollXToMidiTick(48, TICKS_PER_QUARTER)).toBe(240);
    expect(pianoRollXToMidiTick(192, TICKS_PER_QUARTER)).toBe(960);
    expect(pianoRollYToMidiPitch(0, 20)).toBe(127);
    expect(pianoRollYToMidiPitch((127 - 60) * 20 + 19, 20)).toBe(60);
    expect(pianoRollYToMidiPitch(20 * 200, 20)).toBe(0);
  });

  it('normalizes a marquee and returns every intersecting note', () => {
    const notes: MidiNote[] = [
      {
        id: 'note-low',
        lengthTicks: 480,
        pitch: 60,
        startTick: 0,
        velocity: 100,
      },
      {
        id: 'note-high',
        lengthTicks: 240,
        pitch: 72,
        startTick: 960,
        velocity: 100,
      },
    ];
    const lowNoteRect = createPianoRollNoteRect(
      notes[0],
      TICKS_PER_QUARTER,
      20,
    );
    const marquee = createPianoRollMarqueeRect(
      lowNoteRect.left + lowNoteRect.width + 4,
      lowNoteRect.top + lowNoteRect.height + 4,
      lowNoteRect.left,
      lowNoteRect.top - 4,
    );

    expect(marquee).toMatchObject({
      left: 0,
      top: lowNoteRect.top - 4,
    });
    expect(
      getPianoRollNoteIdsInMarquee(
        notes,
        marquee,
        TICKS_PER_QUARTER,
        20,
      ),
    ).toEqual(['note-low']);
  });

  it('replaces or adds marquee selection without duplicate note IDs', () => {
    expect(
      resolvePianoRollMarqueeSelection(
        ['note-first'],
        ['note-second'],
        false,
      ),
    ).toEqual(['note-second']);
    expect(
      resolvePianoRollMarqueeSelection(
        ['note-first', 'note-second'],
        ['note-second', 'note-third'],
        true,
      ),
    ).toEqual(['note-first', 'note-second', 'note-third']);
  });

  it('adds or removes one note from the current selection', () => {
    expect(
      togglePianoRollNoteSelection(['note-first'], 'note-second'),
    ).toEqual(['note-first', 'note-second']);
    expect(
      togglePianoRollNoteSelection(
        ['note-first', 'note-second', 'note-third'],
        'note-second',
      ),
    ).toEqual(['note-first', 'note-third']);
  });

  it('fits 24 pitch rows to the available viewport without making rows thinner', () => {
    expect(getPianoRollRowHeight(480)).toBe(
      480 / PIANO_ROLL_VISIBLE_PITCHES,
    );
    expect(getPianoRollRowHeight(240)).toBe(
      PIANO_ROLL_ROW_HEIGHT_PX,
    );
    expect(pianoRollPixelDeltaToSemitones(-40, 20)).toBe(2);
  });

  it('moves the vertical viewport by one octave without crossing its bounds', () => {
    expect(
      getPianoRollOctaveScrollTop({
        currentScrollTop: 1_200,
        direction: 'up',
        rowHeight: 20,
        viewportHeight: 480,
      }),
    ).toBe(960);
    expect(
      getPianoRollOctaveScrollTop({
        currentScrollTop: 1_200,
        direction: 'down',
        rowHeight: 20,
        viewportHeight: 480,
      }),
    ).toBe(1_440);
    expect(
      getPianoRollOctaveScrollTop({
        currentScrollTop: 100,
        direction: 'up',
        rowHeight: 20,
        viewportHeight: 480,
      }),
    ).toBe(0);
    expect(
      getPianoRollOctaveScrollTop({
        currentScrollTop: 2_000,
        direction: 'down',
        rowHeight: 20,
        viewportHeight: 480,
      }),
    ).toBe(2_080);

    const fittedRowHeight = 451 / PIANO_ROLL_VISIBLE_PITCHES;
    const fittedDownScrollTop = getPianoRollOctaveScrollTop({
      currentScrollTop: 1_043,
      direction: 'down',
      rowHeight: fittedRowHeight,
      viewportHeight: 451,
    });

    expect(fittedDownScrollTop).toBe(1_269);
    expect(
      getPianoRollOctaveScrollTop({
        currentScrollTop: fittedDownScrollTop,
        direction: 'up',
        rowHeight: fittedRowHeight,
        viewportHeight: 451,
      }),
    ).toBe(1_043);
  });

  it('resolves the supported note-grid divisions and keeps short notes operable', () => {
    expect(PIANO_ROLL_GRID_DENOMINATORS).toEqual([4, 8, 16, 32]);
    expect(getPianoRollGridStepTicks(TICKS_PER_QUARTER, 4)).toBe(480);
    expect(getPianoRollGridStepTicks(TICKS_PER_QUARTER, 8)).toBe(240);
    expect(getPianoRollGridStepTicks(TICKS_PER_QUARTER)).toBe(120);
    expect(getPianoRollGridStepTicks(TICKS_PER_QUARTER, 32)).toBe(60);
    expect(
      createPianoRollNoteRect(
        {
          id: 'short-note',
          lengthTicks: 1,
          pitch: 69,
          startTick: 240,
          velocity: 96,
        },
        TICKS_PER_QUARTER,
        20,
      ),
    ).toMatchObject({
      height: 19,
      left: 48,
      top: (127 - 69) * 20,
      width: 8,
    });
  });

  it('sizes the scroll surface for long takes with end padding', () => {
    const notes: MidiNote[] = [
      {
        id: 'late-note',
        lengthTicks: 480,
        pitch: 64,
        startTick: 9_600,
        velocity: 90,
      },
    ];

    expect(getPianoRollContentWidth(notes, TICKS_PER_QUARTER)).toBe(
      25 * PIANO_ROLL_QUARTER_WIDTH_PX,
    );
    expect(getPianoRollContentWidth([], TICKS_PER_QUARTER)).toBe(
      16 * PIANO_ROLL_QUARTER_WIDTH_PX,
    );
  });

  it('provides familiar keyboard names and black-key classes', () => {
    expect(getMidiNoteName(60)).toBe('C4');
    expect(getMidiNoteName(69)).toBe('A4');
    expect(isBlackMidiPitch(61)).toBe(true);
    expect(isBlackMidiPitch(60)).toBe(false);
  });

  it('lays out several hundred notes without changing their identity', () => {
    const notes = Array.from({ length: 512 }, (_, index): MidiNote => ({
      id: `note-${index}`,
      lengthTicks: 120 + (index % 4) * 120,
      pitch: 36 + (index % 48),
      startTick: index * 60,
      velocity: 64 + (index % 48),
    }));
    const rects = notes.map((note) =>
      createPianoRollNoteRect(note, TICKS_PER_QUARTER),
    );

    expect(rects).toHaveLength(512);
    expect(rects.every((rect) => rect.width >= 8)).toBe(true);
    expect(getPianoRollContentWidth(notes, TICKS_PER_QUARTER)).toBeGreaterThan(
      PIANO_ROLL_QUARTER_WIDTH_PX * 16,
    );
  });
});
