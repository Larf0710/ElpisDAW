import { describe, expect, it } from 'vitest';

import { createMidiContentHash } from './midiContentHash';

describe('createMidiContentHash', () => {
  it('is stable across input note ordering while detecting musical edits', () => {
    const first = createMidiContentHash({
      bpm: 120,
      notes: [
        {
          id: 'note-b',
          lengthTicks: 480,
          pitch: 64,
          startTick: 480,
          velocity: 90,
        },
        {
          id: 'note-a',
          lengthTicks: 480,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
      ],
      ticksPerQuarter: 960,
    });
    const reordered = createMidiContentHash({
      bpm: 120,
      notes: [
        {
          id: 'note-a',
          lengthTicks: 480,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
        {
          id: 'note-b',
          lengthTicks: 480,
          pitch: 64,
          startTick: 480,
          velocity: 90,
        },
      ],
      ticksPerQuarter: 960,
    });
    const edited = createMidiContentHash({
      bpm: 120,
      notes: [
        {
          id: 'note-a',
          lengthTicks: 480,
          pitch: 61,
          startTick: 0,
          velocity: 100,
        },
        {
          id: 'note-b',
          lengthTicks: 480,
          pitch: 64,
          startTick: 480,
          velocity: 90,
        },
      ],
      ticksPerQuarter: 960,
    });

    expect(first).toBe(reordered);
    expect(edited).not.toBe(first);
    expect(first).toMatch(/^fnv1a64-[0-9a-f]{16}$/);
  });
});
