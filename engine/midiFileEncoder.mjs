const MIDI_HEADER_LENGTH = 6;
const MIDI_FORMAT_ZERO = 0;
const MIDI_TRACK_COUNT = 1;
const MAX_MIDI_TICK = 0x0fffffff;

export function encodeStandardMidiFile({
  bank,
  bpm,
  notes,
  program,
  ticksPerQuarter,
}) {
  validateMidiSequence({ bank, bpm, notes, program, ticksPerQuarter });

  const tempoMicroseconds = Math.round(60_000_000 / bpm);
  const events = [
    {
      data: Buffer.from([
        0xff,
        0x51,
        0x03,
        (tempoMicroseconds >> 16) & 0xff,
        (tempoMicroseconds >> 8) & 0xff,
        tempoMicroseconds & 0xff,
      ]),
      order: 0,
      tick: 0,
    },
    {
      data: Buffer.from([0xb0, 0x00, Math.floor(bank / 128)]),
      order: 1,
      tick: 0,
    },
    {
      data: Buffer.from([0xb0, 0x20, bank % 128]),
      order: 2,
      tick: 0,
    },
    {
      data: Buffer.from([0xc0, program]),
      order: 3,
      tick: 0,
    },
  ];

  for (const note of notes) {
    events.push(
      {
        data: Buffer.from([0x80, note.pitch, 0]),
        noteId: note.id,
        order: 4,
        tick: note.startTick + note.lengthTicks,
      },
      {
        data: Buffer.from([0x90, note.pitch, note.velocity]),
        noteId: note.id,
        order: 5,
        tick: note.startTick,
      },
    );
  }

  events.sort(
    (left, right) =>
      left.tick - right.tick ||
      left.order - right.order ||
      (left.noteId ?? '').localeCompare(right.noteId ?? ''),
  );

  const trackParts = [];
  let previousTick = 0;

  for (const event of events) {
    trackParts.push(encodeVariableLengthQuantity(event.tick - previousTick));
    trackParts.push(event.data);
    previousTick = event.tick;
  }

  trackParts.push(Buffer.from([0x00, 0xff, 0x2f, 0x00]));
  const track = Buffer.concat(trackParts);
  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(MIDI_HEADER_LENGTH, 4);
  header.writeUInt16BE(MIDI_FORMAT_ZERO, 8);
  header.writeUInt16BE(MIDI_TRACK_COUNT, 10);
  header.writeUInt16BE(ticksPerQuarter, 12);
  const trackHeader = Buffer.alloc(8);
  trackHeader.write('MTrk', 0, 'ascii');
  trackHeader.writeUInt32BE(track.length, 4);

  return Buffer.concat([header, trackHeader, track]);
}

function validateMidiSequence({
  bank,
  bpm,
  notes,
  program,
  ticksPerQuarter,
}) {
  requireInteger(bank, 0, 16_383, 'SoundFont bank');
  requireNumber(bpm, 40, 240, 'MIDI BPM');
  requireInteger(program, 0, 127, 'SoundFont program');
  requireInteger(ticksPerQuarter, 1, 0x7fff, 'MIDI ticks per quarter');

  if (!Array.isArray(notes)) {
    throw new TypeError('MIDI notes must be an array.');
  }

  for (const [index, note] of notes.entries()) {
    if (!isRecord(note) || typeof note.id !== 'string' || note.id.length === 0) {
      throw new TypeError(`MIDI note ${index + 1} must have an ID.`);
    }

    requireInteger(note.pitch, 0, 127, `MIDI note "${note.id}" pitch`);
    requireInteger(note.startTick, 0, MAX_MIDI_TICK, `MIDI note "${note.id}" start tick`);
    requireInteger(note.lengthTicks, 1, MAX_MIDI_TICK, `MIDI note "${note.id}" length`);
    requireInteger(note.velocity, 1, 127, `MIDI note "${note.id}" velocity`);

    if (note.startTick + note.lengthTicks > MAX_MIDI_TICK) {
      throw new RangeError(`MIDI note "${note.id}" end tick exceeds the MIDI file limit.`);
    }
  }
}

function encodeVariableLengthQuantity(value) {
  requireInteger(value, 0, MAX_MIDI_TICK, 'MIDI delta tick');
  const bytes = [value & 0x7f];
  let remaining = value >> 7;

  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining >>= 7;
  }

  return Buffer.from(bytes);
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function requireNumber(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}.`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
