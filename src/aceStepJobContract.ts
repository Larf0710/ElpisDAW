import {
  ACE_STEP_CHANNELS,
  ACE_STEP_MAX_DURATION_SECONDS,
  ACE_STEP_MIN_DURATION_SECONDS,
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_SAMPLE_RATE,
  ACE_STEP_TARGET_TRACK,
  ACE_STEP_TASK_ID,
  ACE_STEP_UPSTREAM_TASK_TYPE,
} from '../shared/aceStepProtocol.js';
import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_SAMPLE_RATE,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import type { LocalEngineAceStepLyricsSnapshot } from './localEngineClient';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  MidiArtifact,
  MidiClipTake,
} from './types';

export const ACE_STEP_JOB_CONTRACT_ERROR =
  'ACE_STEP_JOB_CONTRACT_INVALID' as const;

const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
const DURATION_EPSILON_SECONDS = 0.1;

type AceStepJobRequestInputCommon = Readonly<{
  caption: string;
  durationSeconds: number;
  lyricsSnapshot: LocalEngineAceStepLyricsSnapshot;
  modelId: string;
  modelRevision: string;
  providerId: string;
  seed: number;
  vocalLanguage: string;
}>;

export type AceStepGuideSourceInput =
  | Readonly<{
      guideAudioArtifact: GeneratedAudioArtifact;
      kind: 'midi-instrument-guide';
      midiArtifact: MidiArtifact;
      midiClipTake: MidiClipTake;
    }>
  | Readonly<{
      guideAudioArtifact: GeneratedAudioArtifact;
      guideClipTake: GeneratedAudioClipTake;
      kind: 'stable-audio-3-text-to-audio';
    }>;

export type AceStepJobRequestInput = AceStepJobRequestInputCommon &
  Readonly<{ guideSource: AceStepGuideSourceInput }>;

export type AceStepJobRequest = Readonly<{
  guideSource:
    | Readonly<{
        artifactId: string;
        clipTakeId: string;
        kind: 'midi-instrument-guide';
      }>
    | Readonly<{
        artifactId: string;
        clipTakeId: string;
        kind: 'stable-audio-3-text-to-audio';
        modelId: typeof STABLE_AUDIO_3_MODEL_ID;
        modelRevision: typeof STABLE_AUDIO_3_MODEL_REVISION;
        providerId: typeof STABLE_AUDIO_3_PROVIDER_ID;
        taskId: typeof STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID;
      }>;
  inputArtifacts: readonly [
    Readonly<{
      artifactId: string;
      kind: 'audio';
      relativePath: string;
      sizeBytes: number;
    }>,
    Readonly<{
      artifactId: string;
      kind: 'lyrics';
      relativePath: string;
    }>,
  ];
  lineage: Readonly<{
    parentArtifactIds: readonly [string, string];
    parentClipTakeIds: readonly [string];
  }>;
  modelId: typeof ACE_STEP_MODEL_ID;
  modelRevision: typeof ACE_STEP_MODEL_REVISION;
  output: Readonly<{
    artifactKind: 'audio';
    destination: typeof ACE_STEP_OUTPUT_DESTINATION;
    extension: '.wav';
  }>;
  parameters: Readonly<{
    audioFormat: 'wav';
    batchSize: 1;
    caption: string;
    channels: typeof ACE_STEP_CHANNELS;
    durationSeconds: number;
    sampleRate: typeof ACE_STEP_SAMPLE_RATE;
    seed: number;
    targetTrack: typeof ACE_STEP_TARGET_TRACK;
    taskType: typeof ACE_STEP_UPSTREAM_TASK_TYPE;
    thinking: false;
    vocalLanguage: string;
  }>;
  providerId: typeof ACE_STEP_PROVIDER_ID;
  taskId: typeof ACE_STEP_TASK_ID;
}>;

export class AceStepJobContractError extends Error {
  readonly code = ACE_STEP_JOB_CONTRACT_ERROR;

  constructor(message: string) {
    super(message);
    this.name = 'AceStepJobContractError';
  }
}

export function createAceStepJobRequest(
  input: AceStepJobRequestInput,
): AceStepJobRequest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'caption',
      'durationSeconds',
      'guideSource',
      'lyricsSnapshot',
      'modelId',
      'modelRevision',
      'providerId',
      'seed',
      'vocalLanguage',
    ])
  ) {
    fail('ACE-Step Job input must be an object.');
  }

  if (input.providerId !== ACE_STEP_PROVIDER_ID) {
    fail(`Provider ID must be ${ACE_STEP_PROVIDER_ID}.`);
  }

  if (input.modelId !== ACE_STEP_MODEL_ID) {
    fail(`Model ID must be ${ACE_STEP_MODEL_ID}.`);
  }

  if (input.modelRevision !== ACE_STEP_MODEL_REVISION) {
    fail(`Model revision must be ${ACE_STEP_MODEL_REVISION}.`);
  }

  const guide = validateAceStepGuideSource(input.guideSource);
  const lyrics = validateLyricsSnapshot(input.lyricsSnapshot);
  const caption = requireTrimmedText(input.caption, 'Caption', 2_000);
  const vocalLanguage = requireVocalLanguage(input.vocalLanguage);
  const seed = requireIntegerRange(input.seed, 0, 0xffff_ffff, 'Seed');
  const durationSeconds = requireFiniteRange(
    input.durationSeconds,
    ACE_STEP_MIN_DURATION_SECONDS,
    ACE_STEP_MAX_DURATION_SECONDS,
    'Duration',
  );

  if (Math.abs(durationSeconds - guide.durationSeconds) > DURATION_EPSILON_SECONDS) {
    fail('Duration must match the immutable Guide Audio duration.');
  }

  const inputArtifacts = Object.freeze([
    Object.freeze({
      artifactId: guide.artifactId,
      kind: 'audio' as const,
      relativePath: guide.relativePath,
      sizeBytes: guide.sizeBytes,
    }),
    Object.freeze({
      artifactId: lyrics.artifactId,
      kind: 'lyrics' as const,
      relativePath: lyrics.relativePath,
    }),
  ]) as AceStepJobRequest['inputArtifacts'];
  const lineage = Object.freeze({
    parentArtifactIds: Object.freeze([
      guide.artifactId,
      lyrics.artifactId,
    ]) as readonly [string, string],
    parentClipTakeIds: Object.freeze([guide.clipTakeId]) as readonly [string],
  });
  const output = Object.freeze({
    artifactKind: 'audio' as const,
    destination: ACE_STEP_OUTPUT_DESTINATION,
    extension: '.wav' as const,
  });
  const parameters = Object.freeze({
    audioFormat: 'wav' as const,
    batchSize: 1 as const,
    caption,
    channels: ACE_STEP_CHANNELS,
    durationSeconds,
    sampleRate: ACE_STEP_SAMPLE_RATE,
    seed,
    targetTrack: ACE_STEP_TARGET_TRACK,
    taskType: ACE_STEP_UPSTREAM_TASK_TYPE,
    thinking: false as const,
    vocalLanguage,
  });

  return Object.freeze({
    guideSource: guide.requestGuideSource,
    inputArtifacts,
    lineage,
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    output,
    parameters,
    providerId: ACE_STEP_PROVIDER_ID,
    taskId: ACE_STEP_TASK_ID,
  });
}

export function validateAceStepGuideSource(input: AceStepGuideSourceInput): Readonly<{
  artifactId: string;
  clipTakeId: string;
  durationSeconds: number;
  relativePath: string;
  sizeBytes: number;
  requestGuideSource: AceStepJobRequest['guideSource'];
}> {
  if (!isRecord(input) || typeof input.kind !== 'string') {
    fail('Guide source must be one supported exact object.');
  }

  if (input.kind === 'midi-instrument-guide') {
    if (
      !hasExactKeys(input, [
        'guideAudioArtifact',
        'kind',
        'midiArtifact',
        'midiClipTake',
      ])
    ) {
      fail('MIDI Instrument Guide source contains unsupported fields.');
    }

    const midi = validateCorrectedMidi(input.midiArtifact, input.midiClipTake);
    const guide = validateInstrumentGuideAudio(input.guideAudioArtifact, midi);

    return Object.freeze({
      ...guide,
      clipTakeId: midi.clipTakeId,
      requestGuideSource: Object.freeze({
        artifactId: guide.artifactId,
        clipTakeId: midi.clipTakeId,
        kind: 'midi-instrument-guide' as const,
      }),
    });
  }

  if (input.kind === 'stable-audio-3-text-to-audio') {
    if (
      !hasExactKeys(input, ['guideAudioArtifact', 'guideClipTake', 'kind'])
    ) {
      fail('SA3 T2A Guide source contains unsupported fields.');
    }

    const guide = validateTextToAudioGuide(
      input.guideAudioArtifact,
      input.guideClipTake,
    );

    return Object.freeze({
      ...guide,
      requestGuideSource: Object.freeze({
        artifactId: guide.artifactId,
        clipTakeId: guide.clipTakeId,
        kind: 'stable-audio-3-text-to-audio' as const,
        modelId: STABLE_AUDIO_3_MODEL_ID,
        modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
        providerId: STABLE_AUDIO_3_PROVIDER_ID,
        taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
      }),
    });
  }

  fail('Guide source kind is unsupported.');
}

function validateCorrectedMidi(
  artifact: MidiArtifact,
  clipTake: MidiClipTake,
): Readonly<{ artifactId: string; clipTakeId: string }> {
  if (
    !isRecord(artifact) ||
    artifact.kind !== 'midi' ||
    !isId(artifact.artifactId) ||
    !isRecord(artifact.midi) ||
    !Array.isArray(artifact.midi.notes) ||
    artifact.midi.notes.length === 0 ||
    !isRecord(clipTake) ||
    clipTake.mediaType !== 'midi' ||
    !isId(clipTake.clipTakeId) ||
    clipTake.artifactId !== artifact.artifactId
  ) {
    fail('Corrected MIDI Artifact and Clip Take identity is invalid.');
  }

  return Object.freeze({
    artifactId: artifact.artifactId,
    clipTakeId: clipTake.clipTakeId,
  });
}

function validateInstrumentGuideAudio(
  artifact: GeneratedAudioArtifact,
  midi: Readonly<{ artifactId: string; clipTakeId: string }>,
): Readonly<{
  artifactId: string;
  durationSeconds: number;
  relativePath: string;
  sizeBytes: number;
}> {
  if (
    !isRecord(artifact) ||
    artifact.kind !== 'audio' ||
    artifact.destination !== 'instrument' ||
    !isId(artifact.artifactId) ||
    !isRecord(artifact.audio) ||
    artifact.audio.mimeType !== 'audio/wav' ||
    typeof artifact.audio.durationSeconds !== 'number' ||
    !Number.isFinite(artifact.audio.durationSeconds) ||
    artifact.audio.durationSeconds < ACE_STEP_MIN_DURATION_SECONDS ||
    artifact.audio.durationSeconds > ACE_STEP_MAX_DURATION_SECONDS ||
    !isRecord(artifact.file) ||
    artifact.file.extension !== '.wav' ||
    artifact.file.name !== `${artifact.artifactId}.wav` ||
    artifact.file.relativePath !==
      `renders/instruments/${artifact.artifactId}.wav` ||
    !Number.isSafeInteger(artifact.file.sizeBytes) ||
    artifact.file.sizeBytes <= 44 ||
    artifact.file.sizeBytes > MAX_AUDIO_BYTES ||
    !isRecord(artifact.lineage) ||
    !Array.isArray(artifact.lineage.parentArtifactIds) ||
    artifact.lineage.parentArtifactIds.length !== 1 ||
    artifact.lineage.parentArtifactIds[0] !== midi.artifactId ||
    !Array.isArray(artifact.lineage.parentClipTakeIds) ||
    artifact.lineage.parentClipTakeIds.length !== 1 ||
    artifact.lineage.parentClipTakeIds[0] !== midi.clipTakeId
  ) {
    fail('Guide Audio must be one finalized Instrument render of the corrected MIDI Take.');
  }

  return Object.freeze({
    artifactId: artifact.artifactId,
    durationSeconds: artifact.audio.durationSeconds,
    relativePath: artifact.file.relativePath,
    sizeBytes: artifact.file.sizeBytes,
  });
}

function validateTextToAudioGuide(
  artifact: GeneratedAudioArtifact,
  clipTake: GeneratedAudioClipTake,
): Readonly<{
  artifactId: string;
  clipTakeId: string;
  durationSeconds: number;
  relativePath: string;
  sizeBytes: number;
}> {
  if (
    !isRecord(artifact) ||
    !hasExactKeys(artifact, [
      'artifactId',
      'audio',
      'createdAt',
      'destination',
      'file',
      'kind',
      'lineage',
      'provenance',
      'sourceJobId',
    ]) ||
    artifact.kind !== 'audio' ||
    artifact.destination !== 'stable-audio-3' ||
    !isId(artifact.artifactId) ||
    !isId(artifact.sourceJobId) ||
    !isRecord(artifact.audio) ||
    !hasExactKeys(artifact.audio, [
      'channels',
      'durationSeconds',
      'mimeType',
    ]) ||
    artifact.audio.channels !== STABLE_AUDIO_3_CHANNELS ||
    artifact.audio.mimeType !== 'audio/wav' ||
    typeof artifact.audio.durationSeconds !== 'number' ||
    !Number.isFinite(artifact.audio.durationSeconds) ||
    artifact.audio.durationSeconds < ACE_STEP_MIN_DURATION_SECONDS ||
    artifact.audio.durationSeconds > ACE_STEP_MAX_DURATION_SECONDS ||
    !isRecord(artifact.file) ||
    !hasExactKeys(artifact.file, [
      'extension',
      'name',
      'relativePath',
      'sizeBytes',
    ]) ||
    artifact.file.extension !== '.wav' ||
    artifact.file.name !== `${artifact.artifactId}.wav` ||
    artifact.file.relativePath !==
      `renders/stable-audio-3/${artifact.artifactId}.wav` ||
    !Number.isSafeInteger(artifact.file.sizeBytes) ||
    artifact.file.sizeBytes <= 44 ||
    artifact.file.sizeBytes > MAX_AUDIO_BYTES ||
    !isRecord(artifact.provenance) ||
    !hasExactKeys(artifact.provenance, [
      'modelId',
      'modelRevision',
      'parameters',
      'providerId',
      'seed',
      'taskId',
    ]) ||
    artifact.provenance.providerId !== STABLE_AUDIO_3_PROVIDER_ID ||
    artifact.provenance.modelId !== STABLE_AUDIO_3_MODEL_ID ||
    artifact.provenance.modelRevision !== STABLE_AUDIO_3_MODEL_REVISION ||
    artifact.provenance.taskId !== STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID ||
    !isRecord(artifact.provenance.parameters) ||
    !hasExactKeys(artifact.provenance.parameters, [
      'channels',
      'durationSeconds',
      'prompt',
      'sampleRate',
      'seed',
    ]) ||
    artifact.provenance.parameters.channels !== STABLE_AUDIO_3_CHANNELS ||
    artifact.provenance.parameters.sampleRate !== STABLE_AUDIO_3_SAMPLE_RATE ||
    typeof artifact.provenance.parameters.durationSeconds !== 'number' ||
    !Number.isFinite(artifact.provenance.parameters.durationSeconds) ||
    Math.abs(
      artifact.provenance.parameters.durationSeconds -
        artifact.audio.durationSeconds,
    ) > DURATION_EPSILON_SECONDS ||
    typeof artifact.provenance.parameters.prompt !== 'string' ||
    artifact.provenance.parameters.prompt.length === 0 ||
    artifact.provenance.parameters.prompt.trim() !==
      artifact.provenance.parameters.prompt ||
    !Number.isSafeInteger(artifact.provenance.parameters.seed) ||
    !isRecord(artifact.lineage) ||
    !hasExactKeys(artifact.lineage, [
      'parentArtifactIds',
      'parentClipTakeIds',
    ]) ||
    !Array.isArray(artifact.lineage.parentArtifactIds) ||
    artifact.lineage.parentArtifactIds.length !== 0 ||
    !Array.isArray(artifact.lineage.parentClipTakeIds) ||
    artifact.lineage.parentClipTakeIds.length !== 0 ||
    !isRecord(clipTake) ||
    !hasExactKeys(clipTake, [
      'artifactId',
      'clipTakeId',
      'createdAt',
      'label',
      'mediaType',
      'sourceJobId',
      'sourceType',
    ]) ||
    clipTake.mediaType !== 'audio' ||
    clipTake.sourceType !== 'job' ||
    !isId(clipTake.clipTakeId) ||
    clipTake.artifactId !== artifact.artifactId ||
    clipTake.sourceJobId !== artifact.sourceJobId
  ) {
    fail(
      'Guide Audio must be one finalized source-free Stable Audio 3 Text-to-Audio Take.',
    );
  }

  return Object.freeze({
    artifactId: artifact.artifactId,
    clipTakeId: clipTake.clipTakeId,
    durationSeconds: artifact.audio.durationSeconds,
    relativePath: artifact.file.relativePath,
    sizeBytes: artifact.file.sizeBytes,
  });
}

function validateLyricsSnapshot(
  snapshot: LocalEngineAceStepLyricsSnapshot,
): Readonly<{ artifactId: string; relativePath: string }> {
  if (
    !isRecord(snapshot) ||
    snapshot.kind !== 'lyrics' ||
    snapshot.destination !== 'ace-step-lyrics' ||
    snapshot.status !== 'FINALIZED' ||
    !isUuidArtifactId(snapshot.artifactId) ||
    !isRecord(snapshot.file) ||
    snapshot.file.extension !== '.txt' ||
    snapshot.file.name !== `${snapshot.artifactId}.txt` ||
    snapshot.file.relativePath !==
      `renders/ace-step/lyrics/${snapshot.artifactId}.txt` ||
    !Number.isSafeInteger(snapshot.file.sizeBytes) ||
    snapshot.file.sizeBytes <= 0 ||
    snapshot.file.sizeBytes > 16 * 1024 ||
    typeof snapshot.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(snapshot.sha256)
  ) {
    fail('Lyrics must be one finalized immutable ACE-Step Lyrics snapshot.');
  }

  return Object.freeze({
    artifactId: snapshot.artifactId,
    relativePath: snapshot.file.relativePath,
  });
}

function requireVocalLanguage(value: unknown): string {
  if (
    value !== 'unknown' &&
    (typeof value !== 'string' || !/^[a-z]{2}$/.test(value))
  ) {
    fail('Vocal language must be unknown or a lowercase ISO 639-1 code.');
  }

  return value;
}

function requireTrimmedText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > maximumLength
  ) {
    fail(`${label} must be a non-empty trimmed string within ${maximumLength} characters.`);
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

function requireFiniteRange(
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

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value
  );
}

function isUuidArtifactId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^artifact-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value);

  if (ownKeys.some((key) => typeof key !== 'string')) {
    return false;
  }

  const actualKeys = (ownKeys as string[]).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function fail(message: string): never {
  throw new AceStepJobContractError(message);
}
