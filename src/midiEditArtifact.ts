import { normalizeMidiNotes } from './humToMidiContract';
import { createMidiContentHash } from './midiContentHash';
import type {
  EditedMidiArtifact,
  MidiArtifact,
  MidiClipTake,
  MidiNote,
} from './types';
import {
  RECORDING_BPM_MAX,
  RECORDING_BPM_MIN,
} from './recordingTiming';
import { TICKS_PER_QUARTER } from './workflow';

export const MIDI_EDIT_TASK_ID = 'midi-edit' as const;
export const PIANO_ROLL_EDITOR_ID = 'piano-roll' as const;
export const PIANO_ROLL_EDITOR_VERSION = '1' as const;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type EditedMidiArtifactInput = Readonly<{
  artifactId: string;
  createdAt: string;
  editorId?: string;
  editorVersion?: string;
  notes: readonly MidiNote[];
  sourceArtifact: MidiArtifact;
  sourceClipTake: MidiClipTake;
  sourceEditId: string;
}>;

export function createEditedMidiArtifact(
  input: EditedMidiArtifactInput,
): EditedMidiArtifact {
  const artifactId = requireId(input.artifactId, 'Edited MIDI Artifact ID');
  const sourceEditId = requireId(input.sourceEditId, 'MIDI edit ID');
  const editorId = requireId(
    input.editorId ?? PIANO_ROLL_EDITOR_ID,
    'MIDI editor ID',
  );
  const editorVersion = requireId(
    input.editorVersion ?? PIANO_ROLL_EDITOR_VERSION,
    'MIDI editor version',
  );
  const createdAt = requireTimestamp(input.createdAt);
  const sourceArtifact = validateSourceArtifact(input.sourceArtifact);
  const sourceClipTake = validateSourceClipTake(input.sourceClipTake);

  if (sourceClipTake.artifactId !== sourceArtifact.artifactId) {
    throw new Error(
      'MIDI edit source Take must reference the source MIDI Artifact.',
    );
  }

  const lineage: EditedMidiArtifact['lineage'] = {
    parentArtifactIds: [sourceArtifact.artifactId],
    parentClipTakeIds: [sourceClipTake.clipTakeId],
  };
  Object.freeze(lineage.parentArtifactIds);
  Object.freeze(lineage.parentClipTakeIds);
  Object.freeze(lineage);
  const midi = Object.freeze({
    bpm: sourceArtifact.midi.bpm,
    notes: normalizeMidiNotes(input.notes),
    ticksPerQuarter: TICKS_PER_QUARTER,
  });
  const contentHash = createMidiContentHash(midi);
  const editProvenance = Object.freeze({
    editorId,
    editorVersion,
    taskId: MIDI_EDIT_TASK_ID,
  });

  return Object.freeze({
    artifactId,
    contentHash,
    createdAt,
    editProvenance,
    kind: 'midi',
    lineage,
    midi,
    revision: 1,
    sourceEditId,
    updatedAt: createdAt,
  });
}

function validateSourceArtifact(sourceArtifact: MidiArtifact): MidiArtifact {
  requireId(sourceArtifact.artifactId, 'Source MIDI Artifact ID');

  if (
    sourceArtifact.kind !== 'midi' ||
    sourceArtifact.midi.ticksPerQuarter !== TICKS_PER_QUARTER ||
    typeof sourceArtifact.midi.bpm !== 'number' ||
    !Number.isFinite(sourceArtifact.midi.bpm) ||
    sourceArtifact.midi.bpm < RECORDING_BPM_MIN ||
    sourceArtifact.midi.bpm > RECORDING_BPM_MAX
  ) {
    throw new Error('MIDI edit source Artifact is invalid.');
  }

  normalizeMidiNotes(sourceArtifact.midi.notes);
  return sourceArtifact;
}

function validateSourceClipTake(sourceClipTake: MidiClipTake): MidiClipTake {
  requireId(sourceClipTake.clipTakeId, 'Source MIDI Clip Take ID');
  requireId(sourceClipTake.artifactId, 'Source MIDI Clip Take Artifact ID');

  if (sourceClipTake.mediaType !== 'midi') {
    throw new Error('MIDI edit source Take must contain MIDI.');
  }

  return sourceClipTake;
}

function requireId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !ID_PATTERN.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }

  return value;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Edited MIDI Artifact timestamp is invalid.');
  }

  const milliseconds = Date.parse(value);

  if (!Number.isFinite(milliseconds)) {
    throw new Error('Edited MIDI Artifact timestamp is invalid.');
  }

  return new Date(milliseconds).toISOString();
}
