import type {
  GeneratedMidiArtifact,
  MidiNote,
  ProjectJsonValue,
} from './types';
import {
  RECORDING_BPM_MAX,
  RECORDING_BPM_MIN,
} from './recordingTiming';
import { TICKS_PER_QUARTER } from './workflow';

export const HUM_TO_MIDI_TASK_ID = 'hum-to-midi' as const;
export const HUM_TO_MIDI_CONTRACT_ERROR =
  'HUM_TO_MIDI_CONTRACT_INVALID' as const;

type ImmutableJsonValue =
  | boolean
  | number
  | string
  | null
  | ImmutableJsonArray
  | ImmutableJsonObject;

interface ImmutableJsonArray extends ReadonlyArray<ImmutableJsonValue> {}

interface ImmutableJsonObject {
  readonly [key: string]: ImmutableJsonValue;
}

export type HumToMidiSource = Readonly<{
  artifactId: string;
  clipTakeId: string;
  sourceEndSeconds: number;
  sourceStartSeconds: number;
}>;

export type HumToMidiJobRequestInput = Readonly<{
  modelId: string;
  modelRevision: string;
  parameters?: Readonly<Record<string, ProjectJsonValue>>;
  projectBpm: number;
  providerId: string;
  source: HumToMidiSource;
}>;

export type HumToMidiJobRequest = Readonly<{
  modelId: string;
  modelRevision: string;
  parameters: Readonly<Record<string, ImmutableJsonValue>>;
  projectBpm: number;
  providerId: string;
  source: HumToMidiSource;
  taskId: typeof HUM_TO_MIDI_TASK_ID;
  ticksPerQuarter: typeof TICKS_PER_QUARTER;
}>;

export type MidiNoteInput = Readonly<MidiNote>;
export type InlineMidiArtifact = GeneratedMidiArtifact;
export type { MidiNote } from './types';

export class HumToMidiContractError extends Error {
  readonly code = HUM_TO_MIDI_CONTRACT_ERROR;

  constructor(message: string) {
    super(message);
    this.name = 'HumToMidiContractError';
  }
}

export function createHumToMidiJobRequest(
  input: HumToMidiJobRequestInput,
): HumToMidiJobRequest {
  const modelId = requireText(input.modelId, 'Model ID');
  const modelRevision = requireText(input.modelRevision, 'Model revision');
  const providerId = requireText(input.providerId, 'Provider ID');
  const projectBpm = requireRange(
    input.projectBpm,
    RECORDING_BPM_MIN,
    RECORDING_BPM_MAX,
    'Project BPM',
  );
  const source = createSource(input.source);
  const parameters = cloneParameters(input.parameters ?? {});

  return Object.freeze({
    modelId,
    modelRevision,
    parameters,
    projectBpm,
    providerId,
    source,
    taskId: HUM_TO_MIDI_TASK_ID,
    ticksPerQuarter: TICKS_PER_QUARTER,
  });
}

export function createInlineMidiArtifact(
  input: Readonly<{
    artifactId: string;
    createdAt: string;
    notes: readonly MidiNoteInput[];
    sourceJobId: string;
  }>,
  request: HumToMidiJobRequest,
): InlineMidiArtifact {
  const parameters = validateRequest(request);

  const artifactId = requireText(input.artifactId, 'Artifact ID');
  const createdAt = requireTimestamp(input.createdAt);
  const sourceJobId = requireText(input.sourceJobId, 'Source Job ID');
  const notes = normalizeMidiNotes(input.notes);
  const lineage = {
    parentArtifactIds: [request.source.artifactId],
    parentClipTakeIds: [request.source.clipTakeId],
  };
  Object.freeze(lineage.parentArtifactIds);
  Object.freeze(lineage.parentClipTakeIds);
  Object.freeze(lineage);
  const midi = {
    bpm: request.projectBpm,
    notes,
    ticksPerQuarter: TICKS_PER_QUARTER,
  };
  Object.freeze(midi);
  const provenance = {
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    parameters: parameters as Record<string, ProjectJsonValue>,
    providerId: request.providerId,
    taskId: HUM_TO_MIDI_TASK_ID,
  };
  Object.freeze(provenance);

  const artifact: InlineMidiArtifact = {
    artifactId,
    createdAt,
    kind: 'midi',
    lineage,
    midi,
    provenance,
    sourceJobId,
  };

  return Object.freeze(artifact);
}

function createSource(source: HumToMidiSource): HumToMidiSource {
  const artifactId = requireText(source.artifactId, 'Source Artifact ID');
  const clipTakeId = requireText(source.clipTakeId, 'Source Clip Take ID');
  const sourceStartSeconds = requireNonNegativeNumber(
    source.sourceStartSeconds,
    'Source start',
  );
  const sourceEndSeconds = requireNonNegativeNumber(
    source.sourceEndSeconds,
    'Source end',
  );

  if (sourceEndSeconds <= sourceStartSeconds) {
    fail('Source end must be after Source start.');
  }

  return Object.freeze({
    artifactId,
    clipTakeId,
    sourceEndSeconds,
    sourceStartSeconds,
  });
}

export function normalizeMidiNotes(notes: unknown): MidiNote[] {
  if (!Array.isArray(notes)) {
    fail('MIDI notes must be an array.');
  }

  const noteIds = new Set<string>();
  const normalizedNotes = notes.map((note, index) => {
    if (!isRecord(note)) {
      fail(`MIDI note ${index + 1} must be an object.`);
    }

    const id = requireText(note.id, `MIDI note ${index + 1} ID`);
    if (noteIds.has(id)) {
      fail(`MIDI note ID "${id}" must be unique.`);
    }
    noteIds.add(id);

    const pitch = requireIntegerRange(
      note.pitch,
      0,
      127,
      `MIDI note "${id}" pitch`,
    );
    const startTick = requireNonNegativeSafeInteger(
      note.startTick,
      `MIDI note "${id}" start tick`,
    );
    const lengthTicks = requirePositiveSafeInteger(
      note.lengthTicks,
      `MIDI note "${id}" length`,
    );
    const velocity = requireIntegerRange(
      note.velocity,
      1,
      127,
      `MIDI note "${id}" velocity`,
    );

    if (!Number.isSafeInteger(startTick + lengthTicks)) {
      fail(`MIDI note "${id}" end tick must be a safe integer.`);
    }

    const confidence =
      note.confidence === undefined
        ? undefined
        : requireRange(
            note.confidence,
            0,
            1,
            `MIDI note "${id}" confidence`,
          );

    return Object.freeze({
      ...(confidence === undefined ? {} : { confidence }),
      id,
      lengthTicks,
      pitch,
      startTick,
      velocity,
    });
  });

  normalizedNotes.sort(
    (left, right) =>
      left.startTick - right.startTick ||
      left.pitch - right.pitch ||
      left.id.localeCompare(right.id),
  );

  Object.freeze(normalizedNotes);
  return normalizedNotes;
}

function validateRequest(
  request: HumToMidiJobRequest,
): Readonly<Record<string, ImmutableJsonValue>> {
  if (request.taskId !== HUM_TO_MIDI_TASK_ID) {
    fail(`Task ID must be "${HUM_TO_MIDI_TASK_ID}".`);
  }
  if (request.ticksPerQuarter !== TICKS_PER_QUARTER) {
    fail(`Ticks per quarter must be ${TICKS_PER_QUARTER}.`);
  }

  requireText(request.modelId, 'Model ID');
  requireText(request.modelRevision, 'Model revision');
  requireText(request.providerId, 'Provider ID');
  requireRange(
    request.projectBpm,
    RECORDING_BPM_MIN,
    RECORDING_BPM_MAX,
    'Project BPM',
  );
  createSource(request.source);
  return cloneParameters(request.parameters);
}

function cloneParameters(
  parameters: Readonly<Record<string, unknown>>,
): Readonly<Record<string, ImmutableJsonValue>> {
  if (!isRecord(parameters)) {
    fail('Hum-to-MIDI parameters must be a JSON object.');
  }

  return cloneJsonObject(parameters, 'Hum-to-MIDI parameters', new Set<object>());
}

function cloneJsonObject(
  value: Readonly<Record<string, unknown>>,
  label: string,
  ancestors: Set<object>,
): Readonly<Record<string, ImmutableJsonValue>> {
  if (ancestors.has(value)) {
    fail(`${label} must not contain circular references.`);
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  const entries = Object.keys(value)
    .sort()
    .map(
      (key) =>
        [
          key,
          cloneJsonValue(value[key], `${label}.${key}`, nextAncestors),
        ] as const,
    );

  return Object.freeze(Object.fromEntries(entries));
}

function cloneJsonValue(
  value: unknown,
  label: string,
  ancestors: Set<object>,
): ImmutableJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(`${label} must contain only finite numbers.`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      fail(`${label} must not contain circular references.`);
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value);
    return Object.freeze(
      value.map((item, index) =>
        cloneJsonValue(item, `${label}[${index}]`, nextAncestors),
      ),
    );
  }

  if (isRecord(value)) {
    return cloneJsonObject(value, label, ancestors);
  }

  fail(`${label} must contain only JSON values.`);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string.`);
  }
  if (value !== value.trim()) {
    fail(`${label} must not have surrounding whitespace.`);
  }
  if (value.length > 256) {
    fail(`${label} must be at most 256 characters.`);
  }
  return value;
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireText(value, 'Artifact timestamp');
  const milliseconds = Date.parse(timestamp);

  if (!Number.isFinite(milliseconds)) {
    fail('Artifact timestamp must be a valid ISO timestamp.');
  }

  return new Date(milliseconds).toISOString();
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a finite non-negative number.`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function requireIntegerRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function requireRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): never {
  throw new HumToMidiContractError(message);
}
