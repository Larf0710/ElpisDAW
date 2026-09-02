import { midiTickToPianoRollX } from './pianoRollGeometry';

export type PianoRollLinkedPlayhead = Readonly<{
  localTick: number;
  x: number;
}>;

export function resolvePianoRollLinkedPlayhead({
  clipLengthTicks,
  clipStartTick,
  playheadTick,
  ticksPerQuarter,
}: {
  clipLengthTicks: number;
  clipStartTick: number;
  playheadTick: number;
  ticksPerQuarter: number;
}): PianoRollLinkedPlayhead | undefined {
  const normalizedClipStartTick = requireNonNegativeSafeInteger(
    clipStartTick,
    'Clip start tick',
  );
  const normalizedClipLengthTicks = requirePositiveSafeInteger(
    clipLengthTicks,
    'Clip length ticks',
  );
  const normalizedPlayheadTick = requireNonNegativeSafeInteger(
    playheadTick,
    'Timeline playhead tick',
  );
  const normalizedTicksPerQuarter = requirePositiveSafeInteger(
    ticksPerQuarter,
    'MIDI ticks per quarter',
  );
  const clipEndTick =
    normalizedClipStartTick + normalizedClipLengthTicks;

  if (
    normalizedPlayheadTick < normalizedClipStartTick ||
    normalizedPlayheadTick > clipEndTick
  ) {
    return undefined;
  }

  const localTick = normalizedPlayheadTick - normalizedClipStartTick;

  return Object.freeze({
    localTick,
    x: midiTickToPianoRollX(localTick, normalizedTicksPerQuarter),
  });
}

export function getPianoRollLinkedPageScrollLeft({
  contentWidth,
  currentScrollLeft,
  keyboardWidth,
  playheadX,
  viewportWidth,
}: {
  contentWidth: number;
  currentScrollLeft: number;
  keyboardWidth: number;
  playheadX: number;
  viewportWidth: number;
}): number {
  const normalizedContentWidth = requirePositiveFiniteNumber(
    contentWidth,
    'Piano Roll content width',
  );
  const normalizedKeyboardWidth = requireNonNegativeFiniteNumber(
    keyboardWidth,
    'Piano Roll keyboard width',
  );
  const normalizedViewportWidth = requirePositiveFiniteNumber(
    viewportWidth,
    'Piano Roll viewport width',
  );
  const normalizedPlayheadX = requireNonNegativeFiniteNumber(
    playheadX,
    'Piano Roll playhead X',
  );
  const visibleGridWidth =
    normalizedViewportWidth - normalizedKeyboardWidth;
  const maxScrollLeft = Math.max(
    0,
    normalizedKeyboardWidth +
      normalizedContentWidth -
      normalizedViewportWidth,
  );
  const normalizedCurrentScrollLeft = clamp(
    requireNonNegativeFiniteNumber(
      currentScrollLeft,
      'Piano Roll scroll position',
    ),
    0,
    maxScrollLeft,
  );

  if (visibleGridWidth <= 0) {
    return normalizedCurrentScrollLeft;
  }

  const visibleRight =
    normalizedCurrentScrollLeft + visibleGridWidth;

  if (
    normalizedPlayheadX >= normalizedCurrentScrollLeft &&
    normalizedPlayheadX < visibleRight
  ) {
    return normalizedCurrentScrollLeft;
  }

  const targetPageStart =
    Math.floor(normalizedPlayheadX / visibleGridWidth) *
    visibleGridWidth;

  return clamp(targetPageStart, 0, maxScrollLeft);
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }

  return value;
}

function requireNonNegativeSafeInteger(
  value: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }

  return value;
}

function requirePositiveFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be positive and finite.`);
  }

  return value;
}

function requireNonNegativeFiniteNumber(
  value: number,
  label: string,
): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be non-negative and finite.`);
  }

  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
