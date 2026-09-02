import type { ActiveMidiTakePlan } from './activeMidiTake';
import { normalizeMidiNotes } from './humToMidiContract';
import { createMidiContentHash } from './midiContentHash';
import {
  RECORDING_BPM_MAX,
  RECORDING_BPM_MIN,
} from './recordingTiming';
import type { MidiNote, ProjectSoundFontResourceReference } from './types';
import { TICKS_PER_QUARTER } from './workflow';

export const INSTRUMENT_RENDER_TASK_ID = 'midi-to-audio' as const;
export const INSTRUMENT_RENDER_CONTRACT_ERROR =
  'INSTRUMENT_RENDER_CONTRACT_INVALID' as const;
export const INSTRUMENT_RENDER_CHANNELS = 2 as const;
export const INSTRUMENT_RENDER_GAIN_DB_MIN = -60 as const;
export const INSTRUMENT_RENDER_GAIN_DB_MAX = 12 as const;
export const INSTRUMENT_RENDER_SAMPLE_RATE_MIN = 8_000 as const;
export const INSTRUMENT_RENDER_SAMPLE_RATE_MAX = 192_000 as const;

export type InstrumentRenderPreset = Readonly<{
  bank: number;
  program: number;
}>;

export type InstrumentRenderSoundFontResource =
  Readonly<ProjectSoundFontResourceReference> &
  Readonly<{
    revisionToken: string;
  }>;

export type InstrumentRenderJobRequestInput = Readonly<{
  gainDb: number;
  modelId: string;
  modelRevision: string;
  plan: ActiveMidiTakePlan;
  preset: InstrumentRenderPreset;
  providerId: string;
  providerVersion: string;
  sampleRate: number;
  soundFont?: InstrumentRenderSoundFontResource;
}>;

export type InstrumentRenderJobRequest = Readonly<{
  inputArtifacts: readonly [
    Readonly<{
      artifactId: string;
      kind: 'midi';
      midi: Readonly<{
        bpm: number;
        notes: readonly MidiNote[];
        ticksPerQuarter: typeof TICKS_PER_QUARTER;
      }>;
    }>,
  ];
  lineage: Readonly<{
    parentArtifactIds: readonly [string];
    parentClipTakeIds: readonly [string];
  }>;
  modelId: string;
  modelRevision: string;
  output: Readonly<{
    artifactKind: 'audio';
    destination: 'instrument';
    extension: '.wav';
  }>;
  parameters: Readonly<{
    channels: typeof INSTRUMENT_RENDER_CHANNELS;
    gainDb: number;
    preset: InstrumentRenderPreset;
    providerVersion: string;
    sampleRate: number;
    soundFont?: InstrumentRenderSoundFontResource;
    sourceMidiContentHash: string;
    sourceMidiRevision: number;
  }>;
  providerId: string;
  taskId: typeof INSTRUMENT_RENDER_TASK_ID;
}>;

export class InstrumentRenderContractError extends Error {
  readonly code = INSTRUMENT_RENDER_CONTRACT_ERROR;

  constructor(message: string) {
    super(message);
    this.name = 'InstrumentRenderContractError';
  }
}

export function createInstrumentRenderJobRequest(
  input: InstrumentRenderJobRequestInput,
): InstrumentRenderJobRequest {
  const providerId = requireId(input.providerId, 'Provider ID');
  const providerVersion = requireText(
    input.providerVersion,
    'Provider version',
  );
  const modelId = requireId(input.modelId, 'SoundFont Model ID');
  const modelRevision = requireText(
    input.modelRevision,
    'SoundFont Model revision',
  );
  const source = normalizeActiveMidiTakePlan(input.plan);
  const preset = Object.freeze({
    bank: requireIntegerRange(input.preset?.bank, 0, 16_383, 'Preset bank'),
    program: requireIntegerRange(
      input.preset?.program,
      0,
      127,
      'Preset program',
    ),
  });
  const gainDb = requireRange(
    input.gainDb,
    INSTRUMENT_RENDER_GAIN_DB_MIN,
    INSTRUMENT_RENDER_GAIN_DB_MAX,
    'Render gain',
  );
  const sampleRate = requireIntegerRange(
    input.sampleRate,
    INSTRUMENT_RENDER_SAMPLE_RATE_MIN,
    INSTRUMENT_RENDER_SAMPLE_RATE_MAX,
    'Render sample rate',
  );
  const soundFont = input.soundFont
    ? normalizeSoundFontResource(input.soundFont)
    : undefined;

  if (
    soundFont &&
    (modelId !== soundFont.resourceId ||
      modelRevision !== soundFont.revisionToken)
  ) {
    fail(
      'SoundFont Model ID and revision must match the selected SoundFont resource.',
    );
  }
  const inputArtifact = Object.freeze({
    artifactId: source.artifactId,
    kind: 'midi' as const,
    midi: source.midi,
  });
  const inputArtifacts = Object.freeze([inputArtifact]) as
    InstrumentRenderJobRequest['inputArtifacts'];
  const parentArtifactIds = Object.freeze([source.artifactId]) as readonly [
    string,
  ];
  const parentClipTakeIds = Object.freeze([source.clipTakeId]) as readonly [
    string,
  ];
  const lineage = Object.freeze({
    parentArtifactIds,
    parentClipTakeIds,
  });
  const output = Object.freeze({
    artifactKind: 'audio' as const,
    destination: 'instrument' as const,
    extension: '.wav' as const,
  });
  const parameters = Object.freeze({
    channels: INSTRUMENT_RENDER_CHANNELS,
    gainDb,
    preset,
    providerVersion,
    sampleRate,
    ...(soundFont ? { soundFont } : {}),
    sourceMidiContentHash: requireText(
      source.contentHash,
      'Source MIDI content hash',
    ),
    sourceMidiRevision: requireIntegerRange(
      source.revision,
      1,
      Number.MAX_SAFE_INTEGER,
      'Source MIDI revision',
    ),
  });

  return Object.freeze({
    inputArtifacts,
    lineage,
    modelId,
    modelRevision,
    output,
    parameters,
    providerId,
    taskId: INSTRUMENT_RENDER_TASK_ID,
  });
}

function normalizeSoundFontResource(
  value: InstrumentRenderSoundFontResource,
): InstrumentRenderSoundFontResource {
  if (
    !isRecord(value) ||
    (value.library !== 'builtin' && value.library !== 'project') ||
    (value.format !== 'sf2' && value.format !== 'sf3') ||
    typeof value.resourceId !== 'string' ||
    !/^soundfont-[a-f0-9]{32}$/.test(value.resourceId) ||
    typeof value.revisionToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.revisionToken) ||
    typeof value.relativePath !== 'string' ||
    !isNormalizedSoundFontPath(value.relativePath, value.format)
  ) {
    fail('SoundFont resource identity is invalid.');
  }

  return Object.freeze({
    format: value.format,
    library: value.library,
    relativePath: value.relativePath,
    resourceId: value.resourceId,
    revisionToken: value.revisionToken,
  });
}

function isNormalizedSoundFontPath(
  value: string,
  format: InstrumentRenderSoundFontResource['format'],
): boolean {
  const segments = value.split('/');
  return (
    value.startsWith('soundfonts/') &&
    value.toLowerCase().endsWith(`.${format}`) &&
    !value.includes('\\') &&
    segments.length > 1 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes(':'),
    )
  );
}

function normalizeActiveMidiTakePlan(plan: ActiveMidiTakePlan): Readonly<{
  artifactId: string;
  clipTakeId: string;
  contentHash: string;
  midi: InstrumentRenderJobRequest['inputArtifacts'][0]['midi'];
  revision: number;
}> {
  if (!isRecord(plan) || !isRecord(plan.source) || !isRecord(plan.midi)) {
    fail('Active MIDI Take plan must contain source and MIDI data.');
  }

  const artifactId = requireText(
    plan.source.artifactId,
    'Source Artifact ID',
  );
  const clipTakeId = requireText(
    plan.source.clipTakeId,
    'Source Clip Take ID',
  );
  requireText(plan.source.clipId, 'Source Clip ID');
  const bpm = requireRange(
    plan.midi.bpm,
    RECORDING_BPM_MIN,
    RECORDING_BPM_MAX,
    'MIDI BPM',
  );

  if (plan.midi.ticksPerQuarter !== TICKS_PER_QUARTER) {
    fail(`MIDI ticks per quarter must be ${TICKS_PER_QUARTER}.`);
  }

  let notes: MidiNote[];

  try {
    notes = normalizeMidiNotes(plan.midi.notes);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'MIDI notes are invalid.';
    fail(`Active MIDI Take is invalid: ${message}`);
  }

  if (notes.length === 0) {
    fail('Instrument Render requires at least one MIDI note.');
  }

  return Object.freeze({
    artifactId,
    clipTakeId,
    contentHash:
      typeof plan.source.contentHash === 'string'
        ? requireText(plan.source.contentHash, 'Source MIDI content hash')
        : createMidiContentHash({
            bpm,
            notes,
            ticksPerQuarter: TICKS_PER_QUARTER,
          }),
    midi: Object.freeze({
      bpm,
      notes,
      ticksPerQuarter: TICKS_PER_QUARTER,
    }),
    revision:
      plan.source.revision === undefined
        ? 1
        : requireIntegerRange(
            plan.source.revision,
            1,
            Number.MAX_SAFE_INTEGER,
            'Source MIDI revision',
          ),
  });
}

function requireId(value: unknown, label: string): string {
  const id = requireText(value, label);

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    fail(`${label} must use lowercase letters, numbers, and single hyphens.`);
  }

  return id;
}

function requireText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 256
  ) {
    fail(`${label} must be a non-empty trimmed string within 256 characters.`);
  }

  return value;
}

function requireIntegerRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
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
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new InstrumentRenderContractError(message);
}
