import type { MidiNote } from './types';

export const PIANO_ROLL_MIN_NOTE_WIDTH_PX = 8;
export const PIANO_ROLL_OCTAVE_PITCHES = 12;
export const PIANO_ROLL_QUARTER_WIDTH_PX = 96;
export const PIANO_ROLL_ROW_HEIGHT_PX = 18;
export const PIANO_ROLL_TOTAL_PITCHES = 128;
export const PIANO_ROLL_VISIBLE_PITCHES = 24;
export const PIANO_ROLL_GRID_DENOMINATORS = [4, 8, 16, 32] as const;

export type PianoRollGridDenominator =
  (typeof PIANO_ROLL_GRID_DENOMINATORS)[number];

const DEFAULT_MINIMUM_QUARTER_NOTES = 16;
const END_PADDING_QUARTER_NOTES = 4;
const BLACK_KEY_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

export type PianoRollNoteRect = Readonly<{
  height: number;
  left: number;
  top: number;
  width: number;
}>;

export type PianoRollMarqueeRect = Readonly<{
  height: number;
  left: number;
  top: number;
  width: number;
}>;

export function getPianoRollTickScale(ticksPerQuarter: number): number {
  requirePositiveSafeInteger(ticksPerQuarter, 'MIDI ticks per quarter');
  return PIANO_ROLL_QUARTER_WIDTH_PX / ticksPerQuarter;
}

export function getPianoRollGridStepTicks(
  ticksPerQuarter: number,
  denominator: PianoRollGridDenominator = 16,
): number {
  requirePositiveSafeInteger(ticksPerQuarter, 'MIDI ticks per quarter');
  const wholeNoteTicks = requirePositiveSafeInteger(
    ticksPerQuarter * 4,
    'MIDI whole note ticks',
  );

  if (wholeNoteTicks % denominator !== 0) {
    throw new Error(
      `MIDI ticks per quarter must support a 1/${denominator} note grid.`,
    );
  }

  return wholeNoteTicks / denominator;
}

export function getPianoRollDirectDrawLengthTicks(
  anchorStartTick: number,
  currentStartTick: number,
  gridStepTicks: number,
): number {
  const normalizedAnchorStartTick = requireNonNegativeSafeInteger(
    anchorStartTick,
    'Piano Roll direct-draw anchor tick',
  );
  const normalizedCurrentStartTick = requireNonNegativeSafeInteger(
    currentStartTick,
    'Piano Roll direct-draw current tick',
  );
  const normalizedGridStepTicks = requirePositiveSafeInteger(
    gridStepTicks,
    'Piano Roll grid step',
  );

  return Math.max(
    normalizedGridStepTicks,
    normalizedCurrentStartTick - normalizedAnchorStartTick,
  );
}

export function midiTickToPianoRollX(
  tick: number,
  ticksPerQuarter: number,
): number {
  requireNonNegativeSafeInteger(tick, 'MIDI tick');
  return tick * getPianoRollTickScale(ticksPerQuarter);
}

export function pianoRollXToMidiTick(
  x: number,
  ticksPerQuarter: number,
): number {
  const normalizedX = requireNonNegativeFiniteNumber(
    x,
    'Piano Roll horizontal position',
  );
  return Math.round(normalizedX / getPianoRollTickScale(ticksPerQuarter));
}

export function getPianoRollRowHeight(viewportHeight: number): number {
  const normalizedViewportHeight = requirePositiveFiniteNumber(
    viewportHeight,
    'Piano Roll viewport height',
  );

  return Math.max(
    PIANO_ROLL_ROW_HEIGHT_PX,
    normalizedViewportHeight / PIANO_ROLL_VISIBLE_PITCHES,
  );
}

export function getPianoRollOctaveScrollTop({
  currentScrollTop,
  direction,
  rowHeight,
  viewportHeight,
}: {
  currentScrollTop: number;
  direction: 'down' | 'up';
  rowHeight: number;
  viewportHeight: number;
}): number {
  const normalizedCurrentScrollTop = requireNonNegativeFiniteNumber(
    currentScrollTop,
    'Piano Roll scroll position',
  );
  const normalizedRowHeight = requirePositiveFiniteNumber(
    rowHeight,
    'Piano Roll row height',
  );
  const normalizedViewportHeight = requirePositiveFiniteNumber(
    viewportHeight,
    'Piano Roll viewport height',
  );
  const maxScrollTop = Math.max(
    0,
    Math.round(
      PIANO_ROLL_TOTAL_PITCHES * normalizedRowHeight -
        normalizedViewportHeight,
    ),
  );
  const clampedCurrentScrollTop = clamp(
    normalizedCurrentScrollTop,
    0,
    maxScrollTop,
  );
  const octaveDelta = Math.round(
    PIANO_ROLL_OCTAVE_PITCHES * normalizedRowHeight,
  );

  return clamp(
    clampedCurrentScrollTop +
      (direction === 'up' ? -octaveDelta : octaveDelta),
    0,
    maxScrollTop,
  );
}

export function midiPitchToPianoRollY(
  pitch: number,
  rowHeight = PIANO_ROLL_ROW_HEIGHT_PX,
): number {
  const normalizedPitch = requireMidiPitch(pitch);
  return (127 - normalizedPitch) * requirePositiveFiniteNumber(
    rowHeight,
    'Piano Roll row height',
  );
}

export function pianoRollYToMidiPitch(
  y: number,
  rowHeight = PIANO_ROLL_ROW_HEIGHT_PX,
): number {
  const normalizedY = requireNonNegativeFiniteNumber(
    y,
    'Piano Roll vertical position',
  );
  const normalizedRowHeight = requirePositiveFiniteNumber(
    rowHeight,
    'Piano Roll row height',
  );
  const rowIndex = Math.floor(normalizedY / normalizedRowHeight);

  return 127 - clamp(rowIndex, 0, PIANO_ROLL_TOTAL_PITCHES - 1);
}

export function pianoRollPixelDeltaToTicks(
  deltaX: number,
  ticksPerQuarter: number,
): number {
  requireFiniteNumber(deltaX, 'Piano Roll horizontal delta');
  return Math.round(deltaX / getPianoRollTickScale(ticksPerQuarter));
}

export function pianoRollPixelDeltaToSemitones(
  deltaY: number,
  rowHeight = PIANO_ROLL_ROW_HEIGHT_PX,
): number {
  requireFiniteNumber(deltaY, 'Piano Roll vertical delta');
  return Math.round(
    -deltaY /
      requirePositiveFiniteNumber(rowHeight, 'Piano Roll row height'),
  );
}

export function createPianoRollNoteRect(
  note: Readonly<MidiNote>,
  ticksPerQuarter: number,
  rowHeight = PIANO_ROLL_ROW_HEIGHT_PX,
): PianoRollNoteRect {
  const left = midiTickToPianoRollX(note.startTick, ticksPerQuarter);
  const width = Math.max(
    PIANO_ROLL_MIN_NOTE_WIDTH_PX,
    note.lengthTicks * getPianoRollTickScale(ticksPerQuarter),
  );
  const normalizedRowHeight = requirePositiveFiniteNumber(
    rowHeight,
    'Piano Roll row height',
  );

  return Object.freeze({
    height: normalizedRowHeight - 1,
    left,
    top: midiPitchToPianoRollY(note.pitch, normalizedRowHeight),
    width,
  });
}

export function createPianoRollMarqueeRect(
  anchorX: number,
  anchorY: number,
  currentX: number,
  currentY: number,
): PianoRollMarqueeRect {
  const normalizedAnchorX = requireNonNegativeFiniteNumber(
    anchorX,
    'Piano Roll marquee anchor X',
  );
  const normalizedAnchorY = requireNonNegativeFiniteNumber(
    anchorY,
    'Piano Roll marquee anchor Y',
  );
  const normalizedCurrentX = requireNonNegativeFiniteNumber(
    currentX,
    'Piano Roll marquee current X',
  );
  const normalizedCurrentY = requireNonNegativeFiniteNumber(
    currentY,
    'Piano Roll marquee current Y',
  );

  return Object.freeze({
    height: Math.abs(normalizedCurrentY - normalizedAnchorY),
    left: Math.min(normalizedAnchorX, normalizedCurrentX),
    top: Math.min(normalizedAnchorY, normalizedCurrentY),
    width: Math.abs(normalizedCurrentX - normalizedAnchorX),
  });
}

export function getPianoRollNoteIdsInMarquee(
  notes: readonly MidiNote[],
  marquee: PianoRollMarqueeRect,
  ticksPerQuarter: number,
  rowHeight = PIANO_ROLL_ROW_HEIGHT_PX,
): string[] {
  const normalizedMarquee = createPianoRollMarqueeRect(
    marquee.left,
    marquee.top,
    marquee.left + marquee.width,
    marquee.top + marquee.height,
  );
  const marqueeRight = normalizedMarquee.left + normalizedMarquee.width;
  const marqueeBottom = normalizedMarquee.top + normalizedMarquee.height;

  return notes
    .filter((note) => {
      const noteRect = createPianoRollNoteRect(
        note,
        ticksPerQuarter,
        rowHeight,
      );
      const noteRight = noteRect.left + noteRect.width;
      const noteBottom = noteRect.top + noteRect.height;

      return (
        noteRect.left <= marqueeRight &&
        noteRight >= normalizedMarquee.left &&
        noteRect.top <= marqueeBottom &&
        noteBottom >= normalizedMarquee.top
      );
    })
    .map((note) => note.id);
}

export function resolvePianoRollMarqueeSelection(
  originalNoteIds: readonly string[],
  intersectingNoteIds: readonly string[],
  isAdditive: boolean,
): string[] {
  return isAdditive
    ? [...new Set([...originalNoteIds, ...intersectingNoteIds])]
    : [...intersectingNoteIds];
}

export function togglePianoRollNoteSelection(
  selectedNoteIds: readonly string[],
  noteId: string,
): string[] {
  return selectedNoteIds.includes(noteId)
    ? selectedNoteIds.filter((selectedNoteId) => selectedNoteId !== noteId)
    : [...selectedNoteIds, noteId];
}

export function getPianoRollContentWidth(
  notes: readonly MidiNote[],
  ticksPerQuarter: number,
  minimumQuarterNotes = DEFAULT_MINIMUM_QUARTER_NOTES,
): number {
  requirePositiveSafeInteger(ticksPerQuarter, 'MIDI ticks per quarter');
  requirePositiveSafeInteger(
    minimumQuarterNotes,
    'Piano Roll minimum quarter notes',
  );
  const latestEndTick = notes.reduce(
    (latestTick, note) =>
      Math.max(latestTick, note.startTick + note.lengthTicks),
    0,
  );
  const contentQuarterNotes = Math.max(
    minimumQuarterNotes,
    Math.ceil(latestEndTick / ticksPerQuarter) + END_PADDING_QUARTER_NOTES,
  );

  return contentQuarterNotes * PIANO_ROLL_QUARTER_WIDTH_PX;
}

export function getPianoRollContentWidthForClip(
  notes: readonly MidiNote[],
  ticksPerQuarter: number,
  clipLengthTicks: number,
): number {
  requirePositiveSafeInteger(clipLengthTicks, 'MIDI Clip length');

  return Math.max(
    getPianoRollContentWidth(notes, ticksPerQuarter),
    midiTickToPianoRollX(clipLengthTicks, ticksPerQuarter) +
      END_PADDING_QUARTER_NOTES * PIANO_ROLL_QUARTER_WIDTH_PX,
  );
}

export function getPianoRollClipEndX(
  clipLengthTicks: number,
  ticksPerQuarter: number,
): number {
  requirePositiveSafeInteger(clipLengthTicks, 'MIDI Clip length');
  return midiTickToPianoRollX(clipLengthTicks, ticksPerQuarter);
}

export function getMidiNoteName(pitch: number): string {
  const normalizedPitch = requireMidiPitch(pitch);
  const noteName = NOTE_NAMES[normalizedPitch % NOTE_NAMES.length];
  const octave = Math.floor(normalizedPitch / NOTE_NAMES.length) - 1;
  return `${noteName}${octave}`;
}

export function isBlackMidiPitch(pitch: number): boolean {
  return BLACK_KEY_PITCH_CLASSES.has(
    requireMidiPitch(pitch) % NOTE_NAMES.length,
  );
}

function requireMidiPitch(pitch: number): number {
  const normalizedPitch = requireNonNegativeSafeInteger(pitch, 'MIDI pitch');

  if (normalizedPitch > 127) {
    throw new Error('MIDI pitch must be between 0 and 127.');
  }

  return normalizedPitch;
}

function requireFiniteNumber(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }

  return value;
}

function requirePositiveFiniteNumber(value: number, label: string): number {
  const normalizedValue = requireFiniteNumber(value, label);

  if (normalizedValue <= 0) {
    throw new Error(`${label} must be positive.`);
  }

  return normalizedValue;
}

function requireNonNegativeFiniteNumber(
  value: number,
  label: string,
): number {
  const normalizedValue = requireFiniteNumber(value, label);

  if (normalizedValue < 0) {
    throw new Error(`${label} must be non-negative.`);
  }

  return normalizedValue;
}

function requireNonNegativeSafeInteger(value: number, label: string): number {
  const normalizedValue = requirePositiveOrZeroSafeInteger(value, label);

  if (normalizedValue < 0) {
    throw new Error(`${label} must be non-negative.`);
  }

  return normalizedValue;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  const normalizedValue = requirePositiveOrZeroSafeInteger(value, label);

  if (normalizedValue <= 0) {
    throw new Error(`${label} must be positive.`);
  }

  return normalizedValue;
}

function requirePositiveOrZeroSafeInteger(
  value: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer.`);
  }

  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
