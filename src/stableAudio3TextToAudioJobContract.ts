import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MAX_DURATION_SECONDS,
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_OUTPUT_DESTINATION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_SAMPLE_RATE,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../shared/stableAudio3Protocol.js';

export const STABLE_AUDIO_3_TEXT_TO_AUDIO_JOB_CONTRACT_ERROR =
  'STABLE_AUDIO_3_TEXT_TO_AUDIO_JOB_CONTRACT_INVALID' as const;

export type StableAudio3TextToAudioJobRequestInput = Readonly<{
  durationSeconds: number;
  modelId: string;
  modelRevision: string;
  prompt: string;
  providerId: string;
  seed: number;
}>;

export type StableAudio3TextToAudioJobRequest = Readonly<{
  inputArtifacts: readonly [];
  lineage: Readonly<{
    parentArtifactIds: readonly [];
    parentClipTakeIds: readonly [];
  }>;
  modelId: typeof STABLE_AUDIO_3_MODEL_ID;
  modelRevision: typeof STABLE_AUDIO_3_MODEL_REVISION;
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
  }>;
  providerId: typeof STABLE_AUDIO_3_PROVIDER_ID;
  taskId: typeof STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID;
}>;

export class StableAudio3TextToAudioJobContractError extends Error {
  readonly code = STABLE_AUDIO_3_TEXT_TO_AUDIO_JOB_CONTRACT_ERROR;

  constructor(message: string) {
    super(message);
    this.name = 'StableAudio3TextToAudioJobContractError';
  }
}

export function createStableAudio3TextToAudioJobRequest(
  input: StableAudio3TextToAudioJobRequestInput,
): StableAudio3TextToAudioJobRequest {
  if (!isRecord(input)) {
    fail('SA3 T2A Job input must be an object.');
  }

  if (input.providerId !== STABLE_AUDIO_3_PROVIDER_ID) {
    fail(`Provider ID must be ${STABLE_AUDIO_3_PROVIDER_ID}.`);
  }

  if (input.modelId !== STABLE_AUDIO_3_MODEL_ID) {
    fail(`Model ID must be ${STABLE_AUDIO_3_MODEL_ID}.`);
  }

  if (input.modelRevision !== STABLE_AUDIO_3_MODEL_REVISION) {
    fail(`Model revision must be ${STABLE_AUDIO_3_MODEL_REVISION}.`);
  }

  const prompt = requirePrompt(input.prompt);
  const seed = requireSeed(input.seed);
  const durationSeconds = requireDuration(input.durationSeconds);
  const inputArtifacts = Object.freeze([]) as readonly [];
  const parentArtifactIds = Object.freeze([]) as readonly [];
  const parentClipTakeIds = Object.freeze([]) as readonly [];

  return Object.freeze({
    inputArtifacts,
    lineage: Object.freeze({
      parentArtifactIds,
      parentClipTakeIds,
    }),
    modelId: STABLE_AUDIO_3_MODEL_ID,
    modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
    output: Object.freeze({
      artifactKind: 'audio' as const,
      destination: STABLE_AUDIO_3_OUTPUT_DESTINATION,
      extension: '.wav' as const,
    }),
    parameters: Object.freeze({
      channels: STABLE_AUDIO_3_CHANNELS,
      durationSeconds,
      prompt,
      sampleRate: STABLE_AUDIO_3_SAMPLE_RATE,
      seed,
    }),
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
  });
}

function requirePrompt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_000 ||
    value.trim() !== value
  ) {
    fail('Prompt must be a non-empty trimmed string within 2000 characters.');
  }

  return value;
}

function requireSeed(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 0xffff_ffff
  ) {
    fail('Seed must be an integer between 0 and 4294967295.');
  }

  return value as number;
}

function requireDuration(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > STABLE_AUDIO_3_MAX_DURATION_SECONDS
  ) {
    fail(
      `Duration must be greater than zero and no more than ${STABLE_AUDIO_3_MAX_DURATION_SECONDS} seconds.`,
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new StableAudio3TextToAudioJobContractError(message);
}
