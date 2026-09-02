import { describe, expect, it } from 'vitest';

import {
  resolveMaximumMidiNoteEndTick,
  resolveWholeBarMidiClipLength,
} from './midiNoteTiming';
import type { MidiNote } from './types';

const note = (
  id: string,
  startTick: number,
  lengthTicks: number,
): MidiNote => ({
  id,
  lengthTicks,
  pitch: 60,
  startTick,
  velocity: 100,
});

describe('MIDI note timing', () => {
  it('resolves the maximum note end independently of note order', () => {
    expect(
      resolveMaximumMidiNoteEndTick([
        note('late', 3_700, 260),
        note('early', 120, 480),
      ]),
    ).toEqual({
      canResolve: true,
      maximumEndTick: 3_960,
    });
  });

  it('extends to a whole bar without ever shortening the current Clip', () => {
    expect(
      resolveWholeBarMidiClipLength(
        3_840,
        [note('crossing', 3_700, 260)],
        960,
      ),
    ).toEqual({
      canResolve: true,
      lengthTicks: 7_680,
      maximumNoteEndTick: 3_960,
    });
    expect(
      resolveWholeBarMidiClipLength(
        7_680,
        [note('early', 0, 480)],
        960,
      ),
    ).toEqual({
      canResolve: true,
      lengthTicks: 7_680,
      maximumNoteEndTick: 480,
    });
  });

  it('keeps an empty MIDI Clip length unchanged', () => {
    expect(resolveWholeBarMidiClipLength(3_840, [], 960)).toEqual({
      canResolve: true,
      lengthTicks: 3_840,
      maximumNoteEndTick: 0,
    });
  });

  it('rejects invalid note ranges and whole-bar overflow', () => {
    expect(
      resolveMaximumMidiNoteEndTick([note('invalid', -1, 480)]),
    ).toMatchObject({
      canResolve: false,
      reason: 'invalid-note',
    });
    expect(
      resolveWholeBarMidiClipLength(
        3_840,
        [note('overflow', Number.MAX_SAFE_INTEGER - 1, 1)],
        960,
      ),
    ).toMatchObject({
      canResolve: false,
      reason: 'overflow',
    });
  });
});
