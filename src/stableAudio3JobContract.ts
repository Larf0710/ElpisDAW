import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MAX_DURATION_SECONDS,
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_OUTPUT_DESTINATION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_SAMPLE_RATE,
  STABLE_AUDIO_3_TASK_ID,
  STABLE_AUDIO_3_UNPINNED_MODEL_REVISION,
} from '../shared/stableAudio3Protocol.js';
import type { ActiveAudioTakeSourcePlan } from './activeAudioTakeSource';

export const STABLE_AUDIO_3_JOB_CONTRACT_ERROR =
  'STABLE_AUDIO_3_JOB_CONTRACT_INVALID' as const;

const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
const SOURCE_DURATION_EPSILON_SECONDS = 0.000_001;
const MODEL_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const AUDIO_PROJECT_DIRECTORIES = Object.freeze([
  'recordings',
  'renders/instruments',
  'renders/stable-audio-3',
  'renders/ace-step',
  'mixdowns',
  'exports',
]);

export type StableAudio3JobRequestInput = Readonly<{
  durationSeconds: number;
  modelId: string;
  modelRevision: string;
  plan: ActiveAudioTakeSourcePlan;
  prompt: string;
  providerId: string;
  seed: number;
  strength: number;
}>;

export type StableAudio3JobRequest = Readonly<{
  inputArtifacts: readonly [
    Readonly<{
      artifactId: string;
      kind: 'audio';
      relativePath: string;
    }>,
  ];
  lineage: Readonly<{
    parentArtifactIds: readonly [string];
    parentClipTakeIds: readonly [string];
  }>;
  modelId: typeof STABLE_AUDIO_3_MODEL_ID;
  modelRevision: string;
  output: Readonly<{
    artifactKind: 'audio';
    destination: typeof STABLE_AUDIO_3_OUTPUT_DESTINATION;
    extension: '.wav';
  }>;
  parameters: Readonly<{
    channels: typeof STABLE_AUDIO_3_CHANNELS;
    durationSeconds: number;
    prompt: string;
    sampleRate: typeof STABLE_AUDIO_3_SAMPLE_RATE;
    seed: number;
    sourceEndSeconds: number;
    sourceStartSeconds: number;
    strength: number;
  }>;
  providerId: typeof STABLE_AUDIO_3_PROVIDER_ID;
  taskId: typeof STABLE_AUDIO_3_TASK_ID;
}>;

export class StableAudio3JobContractError extends Error {
  readonly code = STABLE_AUDIO_3_JOB_CONTRACT_ERROR;

  constructor(message: string) {
    super(message);
    this.name = 'StableAudio3JobContractError';
  }
}

export function createStableAudio3JobRequest(
  input: StableAudio3JobRequestInput,
): StableAudio3JobRequest {
  if (!isRecord(input)) {
    fail('Stable Audio 3 Job input must be an object.');
  }

  if (input.providerId !== STABLE_AUDIO_3_PROVIDER_ID) {
    fail(`Provider ID must be ${STABLE_AUDIO_3_PROVIDER_ID}.`);
  }

  if (input.modelId !== STABLE_AUDIO_3_MODEL_ID) {
    fail(`Model ID must be ${STABLE_AUDIO_3_MODEL_ID}.`);
  }

  const modelRevision = requirePinnedModelRevision(input.modelRevision);
  const source = normalizeSourcePlan(input.plan);
  const prompt = requirePrompt(input.prompt);
  const strength = requireFiniteRange(input.strength, 0, 1, 'Strength');
  const seed = requireIntegerRange(input.seed, 0, 0xffff_ffff, 'Seed');
  const durationSeconds = requireFiniteRange(
    input.durationSeconds,
    Number.MIN_VALUE,
    STABLE_AUDIO_3_MAX_DURATION_SECONDS,
    'Duration',
  );
  const inputArtifact = Object.freeze({
    artifactId: source.artifactId,
    kind: 'audio' as const,
    relativePath: source.relativePath,
  });
  const inputArtifacts = Object.freeze([inputArtifact]) as
    StableAudio3JobRequest['inputArtifacts'];
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
    destination: STABLE_AUDIO_3_OUTPUT_DESTINATION,
    extension: '.wav' as const,
  });
  const parameters = Object.freeze({
    channels: STABLE_AUDIO_3_CHANNELS,
    durationSeconds,
    prompt,
    sampleRate: STABLE_AUDIO_3_SAMPLE_RATE,
    seed,
    sourceEndSeconds: source.sourceEndSeconds,
    sourceStartSeconds: source.sourceStartSeconds,
    strength,
  });

  return Object.freeze({
    inputArtifacts,
    lineage,
    modelId: STABLE_AUDIO_3_MODEL_ID,
    modelRevision,
    output,
    parameters,
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    taskId: STABLE_AUDIO_3_TASK_ID,
  });
}

function normalizeSourcePlan(plan: ActiveAudioTakeSourcePlan): Readonly<{
  artifactId: string;
  clipTakeId: string;
  relativePath: string;
  sourceEndSeconds: number;
  sourceStartSeconds: number;
}> {
  if (
    !isRecord(plan) ||
    !isRecord(plan.source) ||
    !isRecord(plan.descriptor) ||
    !isRecord(plan.clip)
  ) {
    fail('Active Audio Take plan must contain source, descriptor, and Clip data.');
  }

  const artifactId = requireText(plan.source.artifactId, 'Source Artifact ID', 256);
  const clipId = requireText(plan.source.clipId, 'Source Clip ID', 256);
  const clipTakeId = requireText(plan.source.clipTakeId, 'Source Clip Take ID', 256);
  const descriptor = plan.descriptor;

  if (descriptor.kind !== 'generated' || descriptor.sourceId !== artifactId) {
    fail('Source descriptor must match the selected Audio Artifact.');
  }

  const name = requireText(descriptor.name, 'Source WAV name', 1_024);
  const relativePath = requireAudioProjectPath(descriptor.relativePath, name);

  if (
    !Number.isSafeInteger(descriptor.sizeBytes) ||
    descriptor.sizeBytes <= 44 ||
    descriptor.sizeBytes > MAX_AUDIO_BYTES
  ) {
    fail('Source WAV size is invalid.');
  }

  const clip = plan.clip;

  if (clip.id !== clipId || clip.activeClipTakeId !== clipTakeId) {
    fail('Source Clip and Active Audio Take identity must match the plan.');
  }

  if (!isRecord(clip.sourceFile) || !isRecord(clip.audioTiming)) {
    fail('Source Clip must snapshot WAV metadata and absolute-second timing.');
  }

  const sourceFile = clip.sourceFile;

  if (
    sourceFile.status !== 'available' ||
    sourceFile.sourceId !== artifactId ||
    sourceFile.name !== name ||
    sourceFile.relativePath !== relativePath ||
    sourceFile.sizeBytes !== descriptor.sizeBytes ||
    sourceFile.mimeType !== 'audio/wav'
  ) {
    fail('Source Clip WAV metadata must match the selected Audio Artifact.');
  }

  const sourceDurationSeconds = requireFiniteRange(
    sourceFile.durationSeconds,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    'Source WAV duration',
  );
  const audioTiming = clip.audioTiming;

  if (audioTiming.timeBase !== 'absolute-seconds') {
    fail('Source range must use absolute seconds.');
  }

  const sourceStartSeconds = requireFiniteRange(
    audioTiming.sourceStartSeconds,
    0,
    sourceDurationSeconds,
    'Source start',
  );
  const sourceEndSeconds = requireFiniteRange(
    audioTiming.sourceEndSeconds,
    Number.MIN_VALUE,
    sourceDurationSeconds + SOURCE_DURATION_EPSILON_SECONDS,
    'Source end',
  );

  if (
    sourceEndSeconds <= sourceStartSeconds ||
    sourceEndSeconds - sourceStartSeconds > STABLE_AUDIO_3_MAX_DURATION_SECONDS
  ) {
    fail(
      `Source range must be increasing and no longer than ${STABLE_AUDIO_3_MAX_DURATION_SECONDS} seconds.`,
    );
  }

  return Object.freeze({
    artifactId,
    clipTakeId,
    relativePath,
    sourceEndSeconds,
    sourceStartSeconds,
  });
}

function requirePinnedModelRevision(value: unknown): string {
  if (
    value === STABLE_AUDIO_3_UNPINNED_MODEL_REVISION ||
    typeof value !== 'string' ||
    !MODEL_REVISION_PATTERN.test(value)
  ) {
    fail('Model revision must be one exact lowercase 40-character commit hash.');
  }

  return value;
}

function requirePrompt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 2_000
  ) {
    fail('Prompt must be a non-empty trimmed string within 2000 characters.');
  }

  return value;
}

function requireAudioProjectPath(value: unknown, fileName: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 4_096 ||
    value.includes('\\') ||
    /^[a-zA-Z]:/.test(value) ||
    !value.endsWith('.wav') ||
    value.toLowerCase().endsWith('.partial')
  ) {
    fail('Source WAV path is invalid.');
  }

  const segments = value.split('/');

  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':'),
    ) ||
    segments[segments.length - 1] !== fileName ||
    !AUDIO_PROJECT_DIRECTORIES.some(
      (directory) =>
        value.startsWith(`${directory}/`) && value.length > directory.length + 1,
    )
  ) {
    fail('Source WAV path is outside the explicit Project audio allowlist.');
  }

  return value;
}

function requireText(value: unknown, label: string, maximumLength: number): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new StableAudio3JobContractError(message);
}
