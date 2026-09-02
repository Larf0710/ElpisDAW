import type { MidiNote } from './types';

export type MaximumMidiNoteEndTickResolution =
  | Readonly<{
      canResolve: true;
      maximumEndTick: number;
    }>
  | Readonly<{
      canResolve: false;
      message: string;
      reason: 'invalid-note' | 'overflow';
    }>;

export type WholeBarMidiClipLengthResolution =
  | Readonly<{
      canResolve: true;
      lengthTicks: number;
      maximumNoteEndTick: number;
    }>
  | Readonly<{
      canResolve: false;
      message: string;
      reason:
        | 'invalid-current-length'
        | 'invalid-note'
        | 'invalid-timing'
        | 'overflow';
    }>;

export function resolveMaximumMidiNoteEndTick(
  notes: readonly MidiNote[],
): MaximumMidiNoteEndTickResolution {
  if (!Array.isArray(notes)) {
    return failure(
      'invalid-note',
      'MIDI note timing requires an array of notes.',
    );
  }

  let maximumEndTick = 0;

  for (const note of notes) {
    if (
      !note ||
      !Number.isSafeInteger(note.startTick) ||
      note.startTick < 0 ||
      !Number.isSafeInteger(note.lengthTicks) ||
      note.lengthTicks < 1
    ) {
      return failure(
        'invalid-note',
        'MIDI note timing requires a non-negative safe start tick and a positive safe length.',
      );
    }

    const endTick = note.startTick + note.lengthTicks;

    if (!Number.isSafeInteger(endTick)) {
      return failure(
        'overflow',
        `MIDI note ${note.id || '(unknown)'} end tick exceeds the safe integer range.`,
      );
    }

    maximumEndTick = Math.max(maximumEndTick, endTick);
  }

  return Object.freeze({
    canResolve: true,
    maximumEndTick,
  });
}

export function resolveWholeBarMidiClipLength(
  currentLengthTicks: number,
  notes: readonly MidiNote[],
  ticksPerQuarter: number,
): WholeBarMidiClipLengthResolution {
  if (
    !Number.isSafeInteger(currentLengthTicks) ||
    currentLengthTicks < 1
  ) {
    return clipLengthFailure(
      'invalid-current-length',
      'Current MIDI Clip length must be a positive safe integer.',
    );
  }

  if (!Number.isSafeInteger(ticksPerQuarter) || ticksPerQuarter < 1) {
    return clipLengthFailure(
      'invalid-timing',
      'MIDI ticks per quarter must be a positive safe integer.',
    );
  }

  const barTicks = ticksPerQuarter * 4;

  if (!Number.isSafeInteger(barTicks)) {
    return clipLengthFailure(
      'overflow',
      'MIDI whole-bar length exceeds the safe integer range.',
    );
  }

  const noteEnd = resolveMaximumMidiNoteEndTick(notes);

  if (!noteEnd.canResolve) {
    return clipLengthFailure(noteEnd.reason, noteEnd.message);
  }

  if (noteEnd.maximumEndTick <= currentLengthTicks) {
    return Object.freeze({
      canResolve: true,
      lengthTicks: currentLengthTicks,
      maximumNoteEndTick: noteEnd.maximumEndTick,
    });
  }

  const barCount = Math.ceil(noteEnd.maximumEndTick / barTicks);
  const lengthTicks = barCount * barTicks;

  if (
    !Number.isSafeInteger(lengthTicks) ||
    lengthTicks < noteEnd.maximumEndTick
  ) {
    return clipLengthFailure(
      'overflow',
      'Required MIDI Clip whole-bar length exceeds the safe integer range.',
    );
  }

  return Object.freeze({
    canResolve: true,
    lengthTicks,
    maximumNoteEndTick: noteEnd.maximumEndTick,
  });
}

function failure(
  reason: Extract<
    MaximumMidiNoteEndTickResolution,
    { canResolve: false }
  >['reason'],
  message: string,
): Extract<MaximumMidiNoteEndTickResolution, { canResolve: false }> {
  return Object.freeze({ canResolve: false, message, reason });
}

function clipLengthFailure(
  reason: Extract<
    WholeBarMidiClipLengthResolution,
    { canResolve: false }
  >['reason'],
  message: string,
): Extract<WholeBarMidiClipLengthResolution, { canResolve: false }> {
  return Object.freeze({ canResolve: false, message, reason });
}
