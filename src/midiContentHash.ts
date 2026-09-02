import { normalizeMidiNotes } from './humToMidiContract';
import type { MidiNote } from './types';

const FNV_1A_64_OFFSET = 14_695_981_039_346_656_037n;
const FNV_1A_64_PRIME = 1_099_511_628_211n;
const FNV_1A_64_MASK = 0xffff_ffff_ffff_ffffn;

export type MidiContentHashInput = Readonly<{
  bpm: number;
  notes: readonly MidiNote[];
  ticksPerQuarter: number;
}>;

export function createMidiContentHash(input: MidiContentHashInput): string {
  const normalizedNotes = normalizeMidiNotes(input.notes);
  const serialized = JSON.stringify({
    bpm: input.bpm,
    notes: normalizedNotes.map((note) => ({
      confidence: note.confidence,
      id: note.id,
      lengthTicks: note.lengthTicks,
      pitch: note.pitch,
      startTick: note.startTick,
      velocity: note.velocity,
    })),
    ticksPerQuarter: input.ticksPerQuarter,
  });
  let hash = FNV_1A_64_OFFSET;

  for (let index = 0; index < serialized.length; index += 1) {
    const codeUnit = serialized.charCodeAt(index);
    hash ^= BigInt(codeUnit & 0xff);
    hash = (hash * FNV_1A_64_PRIME) & FNV_1A_64_MASK;
    hash ^= BigInt(codeUnit >>> 8);
    hash = (hash * FNV_1A_64_PRIME) & FNV_1A_64_MASK;
  }

  return `fnv1a64-${hash.toString(16).padStart(16, '0')}`;
}
