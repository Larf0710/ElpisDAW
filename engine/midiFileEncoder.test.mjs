import { describe, expect, it } from 'vitest';

import { encodeStandardMidiFile } from './midiFileEncoder.mjs';

describe('encodeStandardMidiFile', () => {
  it('encodes deterministic format-zero MIDI with bank, program, and note events', () => {
    const midi = encodeStandardMidiFile({
      bank: 130,
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
      program: 7,
      ticksPerQuarter: 960,
    });

    expect(midi.subarray(0, 4).toString('ascii')).toBe('MThd');
    expect(midi.readUInt32BE(4)).toBe(6);
    expect(midi.readUInt16BE(8)).toBe(0);
    expect(midi.readUInt16BE(10)).toBe(1);
    expect(midi.readUInt16BE(12)).toBe(960);
    expect(midi.subarray(14, 18).toString('ascii')).toBe('MTrk');
    expect(midi.includes(Buffer.from([0x00, 0xb0, 0x00, 0x01]))).toBe(true);
    expect(midi.includes(Buffer.from([0x00, 0xb0, 0x20, 0x02]))).toBe(true);
    expect(midi.includes(Buffer.from([0x00, 0xc0, 0x07]))).toBe(true);
    expect(midi.includes(Buffer.from([0x00, 0x90, 60, 100]))).toBe(true);
    expect(midi.subarray(-4)).toEqual(Buffer.from([0x00, 0xff, 0x2f, 0x00]));
  });

  it('rejects notes whose end tick cannot be represented safely', () => {
    expect(() =>
      encodeStandardMidiFile({
        bank: 0,
        bpm: 120,
        notes: [
          {
            id: 'too-long',
            lengthTicks: 2,
            pitch: 60,
            startTick: 0x0fffffff,
            velocity: 100,
          },
        ],
        program: 0,
        ticksPerQuarter: 960,
      }),
    ).toThrow('end tick exceeds the MIDI file limit');
  });
});
