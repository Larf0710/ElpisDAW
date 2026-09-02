import { normalizeMidiNotes } from './humToMidiContract';
import type { MidiNote } from './types';

export type MidiNotePosition = Readonly<{
  pitch: number;
  startTick: number;
}>;

export type MidiNoteEditOptions = Readonly<{
  gridStepTicks?: number;
}>;

export type MidiNoteGroupMove = Readonly<{
  pitchDelta: number;
  tickDelta: number;
}>;

export function addMidiNote(
  notes: readonly MidiNote[],
  note: Readonly<MidiNote>,
  options: MidiNoteEditOptions = {},
): MidiNote[] {
  const currentNotes = normalizeMidiNotes(notes);
  const normalizedNote = normalizeMidiNotes([note])[0];
  const gridStepTicks = normalizeOptionalGridStep(options.gridStepTicks);
  const manualNote = removeRecognitionConfidence(normalizedNote);

  if (gridStepTicks === undefined) {
    return normalizeMidiNotes([...currentNotes, manualNote]);
  }

  const startTick = snapMidiTick(manualNote.startTick, gridStepTicks);
  const sourceEndTick = manualNote.startTick + manualNote.lengthTicks;
  let endTick = snapMidiTick(sourceEndTick, gridStepTicks);

  if (endTick <= startTick) {
    endTick = addSafeTicks(startTick, gridStepTicks, 'MIDI note end tick');
  }

  return normalizeMidiNotes([
    ...currentNotes,
    {
      ...manualNote,
      lengthTicks: endTick - startTick,
      startTick,
    },
  ]);
}

export function deleteMidiNote(
  notes: readonly MidiNote[],
  noteId: string,
): MidiNote[] {
  const currentNotes = normalizeMidiNotes(notes);
  requireNoteId(noteId);

  if (!currentNotes.some((note) => note.id === noteId)) {
    throw new Error(`MIDI note "${noteId}" does not exist.`);
  }

  return normalizeMidiNotes(
    currentNotes.filter((note) => note.id !== noteId),
  );
}

export function deleteMidiNotes(
  notes: readonly MidiNote[],
  noteIds: readonly string[],
): MidiNote[] {
  const currentNotes = normalizeMidiNotes(notes);
  const selectedNoteIds = requireExistingNoteIds(currentNotes, noteIds);

  return normalizeMidiNotes(
    currentNotes.filter((note) => !selectedNoteIds.has(note.id)),
  );
}

export function hasMidiNoteAtPosition(
  notes: readonly MidiNote[],
  position: MidiNotePosition,
): boolean {
  const currentNotes = normalizeMidiNotes(notes);
  const pitch = requireSafeInteger(position.pitch, 'MIDI note pitch');
  const startTick = requireNonNegativeSafeInteger(
    position.startTick,
    'MIDI note start tick',
  );

  if (pitch < 0 || pitch > 127) {
    throw new Error('MIDI note pitch must be between 0 and 127.');
  }

  return currentNotes.some(
    (note) => note.pitch === pitch && note.startTick === startTick,
  );
}

export function moveMidiNote(
  notes: readonly MidiNote[],
  noteId: string,
  position: MidiNotePosition,
  options: MidiNoteEditOptions = {},
): MidiNote[] {
  const currentNotes = normalizeMidiNotes(notes);
  const targetNote = findMidiNote(currentNotes, noteId);
  const gridStepTicks = normalizeOptionalGridStep(options.gridStepTicks);
  const requestedStartTick = requireSafeInteger(
    position.startTick,
    'MIDI note start tick',
  );
  const requestedPitch = requireSafeInteger(position.pitch, 'MIDI note pitch');
  const startTick =
    gridStepTicks === undefined
      ? Math.max(0, requestedStartTick)
      : snapMidiTick(Math.max(0, requestedStartTick), gridStepTicks);
  const pitch = clamp(requestedPitch, 0, 127);
  const movedNote = removeRecognitionConfidence(targetNote);

  return replaceMidiNote(currentNotes, {
    ...movedNote,
    pitch,
    startTick,
  });
}

export function moveMidiNotesBy(
  notes: readonly MidiNote[],
  noteIds: readonly string[],
  move: MidiNoteGroupMove,
  options: MidiNoteEditOptions = {},
): MidiNote[] {
  const currentNotes = normalizeMidiNotes(notes);
  const selectedNoteIds = requireExistingNoteIds(currentNotes, noteIds);
  const selectedNotes = currentNotes.filter((note) =>
    selectedNoteIds.has(note.id),
  );
  const gridStepTicks = normalizeOptionalGridStep(options.gridStepTicks);
  const requestedTickDelta = requireSafeInteger(
    move.tickDelta,
    'MIDI note tick delta',
  );
  const requestedPitchDelta = requireSafeInteger(
    move.pitchDelta,
    'MIDI note pitch delta',
  );
  const snappedTickDelta =
    gridStepTicks === undefined
      ? requestedTickDelta
      : snapMidiTickDelta(requestedTickDelta, gridStepTicks);
  const minimumStartTick = Math.min(
    ...selectedNotes.map((note) => note.startTick),
  );
  const minimumPitch = Math.min(...selectedNotes.map((note) => note.pitch));
  const maximumPitch = Math.max(...selectedNotes.map((note) => note.pitch));
  const tickDelta = Math.max(-minimumStartTick, snappedTickDelta);
  const pitchDelta = clamp(
    requestedPitchDelta,
    -minimumPitch,
    127 - maximumPitch,
  );

  return normalizeMidiNotes(
    currentNotes.map((note) =>
      selectedNoteIds.has(note.id)
        ? {
            ...removeRecognitionConfidence(note),
            pitch: note.pitch + pitchDelta,
            startTick: addSafeTicks(
              note.startTick,
              tickDelta,
              'MIDI note start tick',
            ),
          }
        : note,
    ),
  );
}

export function resizeMidiNoteEnd(
  notes: readonly MidiNote[],
  noteId: string,
  requestedEndTick: number,
  options: MidiNoteEditOptions = {},
): MidiNote[] {
  const currentNotes = normalizeMidiNotes(notes);
  const targetNote = findMidiNote(currentNotes, noteId);
  const gridStepTicks = normalizeOptionalGridStep(options.gridStepTicks);
  const endTickValue = requireSafeInteger(
    requestedEndTick,
    'MIDI note end tick',
  );
  let endTick: number;

  if (gridStepTicks === undefined) {
    endTick = Math.max(targetNote.startTick + 1, endTickValue);
  } else {
    endTick = snapMidiTick(Math.max(0, endTickValue), gridStepTicks);

    if (endTick <= targetNote.startTick) {
      const nextGridIndex =
        Math.floor(targetNote.startTick / gridStepTicks) + 1;
      endTick = multiplySafeTicks(
        nextGridIndex,
        gridStepTicks,
        'MIDI note end tick',
      );
    }
  }

  const resizedNote = removeRecognitionConfidence(targetNote);

  return replaceMidiNote(currentNotes, {
    ...resizedNote,
    lengthTicks: endTick - targetNote.startTick,
  });
}

export function resizeMidiNoteEndsBy(
  notes: readonly MidiNote[],
  noteIds: readonly string[],
  requestedLengthDelta: number,
  options: MidiNoteEditOptions = {},
): MidiNote[] {
  const currentNotes = normalizeMidiNotes(notes);
  const selectedNoteIds = requireExistingNoteIds(currentNotes, noteIds);
  const selectedNotes = currentNotes.filter((note) =>
    selectedNoteIds.has(note.id),
  );
  const gridStepTicks = normalizeOptionalGridStep(options.gridStepTicks);
  const rawLengthDelta = requireSafeInteger(
    requestedLengthDelta,
    'MIDI note length delta',
  );
  const snappedLengthDelta =
    gridStepTicks === undefined
      ? rawLengthDelta
      : snapMidiTickDelta(rawLengthDelta, gridStepTicks);
  const minimumLength = gridStepTicks ?? 1;
  const minimumLengthDelta = Math.max(
    ...selectedNotes.map((note) => minimumLength - note.lengthTicks),
  );
  const lengthDelta = Math.max(
    minimumLengthDelta,
    snappedLengthDelta,
  );

  return normalizeMidiNotes(
    currentNotes.map((note) =>
      selectedNoteIds.has(note.id)
        ? {
            ...removeRecognitionConfidence(note),
            lengthTicks: addSafeTicks(
              note.lengthTicks,
              lengthDelta,
              'MIDI note length',
            ),
          }
        : note,
    ),
  );
}

export function snapMidiTick(tick: number, gridStepTicks: number): number {
  const normalizedTick = requireNonNegativeSafeInteger(tick, 'MIDI tick');
  const normalizedGridStep = requirePositiveSafeInteger(
    gridStepTicks,
    'MIDI grid step',
  );
  const gridIndex = Math.round(normalizedTick / normalizedGridStep);

  return multiplySafeTicks(
    gridIndex,
    normalizedGridStep,
    'Snapped MIDI tick',
  );
}

function replaceMidiNote(
  notes: readonly MidiNote[],
  replacement: MidiNote,
): MidiNote[] {
  return normalizeMidiNotes(
    notes.map((note) => (note.id === replacement.id ? replacement : note)),
  );
}

function findMidiNote(
  notes: readonly MidiNote[],
  noteId: string,
): MidiNote {
  requireNoteId(noteId);
  const note = notes.find((candidate) => candidate.id === noteId);

  if (!note) {
    throw new Error(`MIDI note "${noteId}" does not exist.`);
  }

  return note;
}

function normalizeOptionalGridStep(
  gridStepTicks: number | undefined,
): number | undefined {
  return gridStepTicks === undefined
    ? undefined
    : requirePositiveSafeInteger(gridStepTicks, 'MIDI grid step');
}

function requireNoteId(noteId: string): void {
  if (typeof noteId !== 'string' || noteId.trim() === '') {
    throw new Error('MIDI note ID must be a non-empty string.');
  }
}

function requireExistingNoteIds(
  notes: readonly MidiNote[],
  noteIds: readonly string[],
): ReadonlySet<string> {
  if (!Array.isArray(noteIds) || noteIds.length === 0) {
    throw new Error('MIDI note selection must contain at least one note ID.');
  }

  const existingNoteIds = new Set(notes.map((note) => note.id));
  const selectedNoteIds = new Set<string>();

  for (const noteId of noteIds) {
    requireNoteId(noteId);

    if (!existingNoteIds.has(noteId)) {
      throw new Error(`MIDI note "${noteId}" does not exist.`);
    }

    selectedNoteIds.add(noteId);
  }

  return selectedNoteIds;
}

function requireSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer.`);
  }

  return value;
}

function requireNonNegativeSafeInteger(value: number, label: string): number {
  const normalizedValue = requireSafeInteger(value, label);

  if (normalizedValue < 0) {
    throw new Error(`${label} must be non-negative.`);
  }

  return normalizedValue;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  const normalizedValue = requireSafeInteger(value, label);

  if (normalizedValue <= 0) {
    throw new Error(`${label} must be positive.`);
  }

  return normalizedValue;
}

function addSafeTicks(left: number, right: number, label: string): number {
  const result = left + right;

  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} exceeds the safe integer range.`);
  }

  return result;
}

function snapMidiTickDelta(delta: number, gridStepTicks: number): number {
  const gridIndex = Math.round(delta / gridStepTicks);

  return multiplySafeTicks(
    gridIndex,
    gridStepTicks,
    'Snapped MIDI tick delta',
  );
}

function multiplySafeTicks(
  left: number,
  right: number,
  label: string,
): number {
  const result = left * right;

  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} exceeds the safe integer range.`);
  }

  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function removeRecognitionConfidence(note: MidiNote): MidiNote {
  const { confidence: _confidence, ...manualNote } = note;
  return manualNote;
}
