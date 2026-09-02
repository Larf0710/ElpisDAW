import {
  ACE_STEP_CHANNELS,
  ACE_STEP_COVER_TASK_ID,
  ACE_STEP_COVER_UPSTREAM_TASK_TYPE,
  ACE_STEP_MAX_DURATION_SECONDS,
  ACE_STEP_MIN_DURATION_SECONDS,
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_SAMPLE_RATE,
} from '../shared/aceStepProtocol.js';

export const ACE_STEP_COVER_INFERENCE_STEPS = 64 as const;
export const ACE_STEP_COVER_GUIDANCE_SCALE = 8 as const;
export const ACE_STEP_COVER_NOISE_STRENGTH = 0 as const;

export type AceStepCoverJobRequestInput = Readonly<{
  caption: string;
  coverStrength: number;
  durationSeconds: number;
  guideArtifactId: string;
  guideClipTakeId: string;
  guideRelativePath: string;
  guideSizeBytes: number;
  instrumental: boolean;
  lyricsArtifactId: string;
  lyricsRelativePath: string;
  seed: number;
  vocalLanguage: string;
}>;

export type AceStepCoverJobRequest = Readonly<{
  guideSource: Readonly<{
    artifactId: string;
    clipTakeId: string;
    kind: 'active-audio-take';
    relativePath: string;
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
    audioCoverStrength: number;
    audioFormat: 'wav';
    batchSize: 1;
    caption: string;
    channels: typeof ACE_STEP_CHANNELS;
    coverNoiseStrength: typeof ACE_STEP_COVER_NOISE_STRENGTH;
    durationSeconds: number;
    guidanceScale: typeof ACE_STEP_COVER_GUIDANCE_SCALE;
    inferenceSteps: typeof ACE_STEP_COVER_INFERENCE_STEPS;
    instrumental: boolean;
    sampleRate: typeof ACE_STEP_SAMPLE_RATE;
    seed: number;
    taskType: typeof ACE_STEP_COVER_UPSTREAM_TASK_TYPE;
    thinking: false;
    vocalLanguage: string;
  }>;
  providerId: typeof ACE_STEP_PROVIDER_ID;
  taskId: typeof ACE_STEP_COVER_TASK_ID;
}>;

export function createAceStepCoverJobRequest(
  input: AceStepCoverJobRequestInput,
): AceStepCoverJobRequest {
  if (!isRecord(input)) {
    throw new TypeError('ACE Cover Job input must be an object.');
  }

  const caption = requireTrimmedText(input.caption, 'Prompt', 2_000);
  const guideArtifactId = requireIdentity(input.guideArtifactId, 'Guide Artifact');
  const guideClipTakeId = requireIdentity(input.guideClipTakeId, 'Guide Clip Take');
  const lyricsArtifactId = requireIdentity(input.lyricsArtifactId, 'Lyrics Artifact');
  const lyricsRelativePath = `renders/ace-step/lyrics/${lyricsArtifactId}.txt`;

  if (input.lyricsRelativePath !== lyricsRelativePath) {
    throw new RangeError('ACE Cover Lyrics path must match its finalized Artifact identity.');
  }

  if (!isSafeWavePath(input.guideRelativePath)) {
    throw new RangeError('ACE Cover Guide Audio must use one safe Project WAV path.');
  }

  if (!Number.isSafeInteger(input.guideSizeBytes) || input.guideSizeBytes <= 44) {
    throw new RangeError('ACE Cover Guide Audio size is invalid.');
  }

  if (
    typeof input.durationSeconds !== 'number' ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds < ACE_STEP_MIN_DURATION_SECONDS ||
    input.durationSeconds > ACE_STEP_MAX_DURATION_SECONDS
  ) {
    throw new RangeError(
      `ACE Cover duration must be between ${ACE_STEP_MIN_DURATION_SECONDS} and ${ACE_STEP_MAX_DURATION_SECONDS} seconds.`,
    );
  }

  if (
    typeof input.coverStrength !== 'number' ||
    !Number.isFinite(input.coverStrength) ||
    input.coverStrength < 0 ||
    input.coverStrength > 1
  ) {
    throw new RangeError('ACE Cover Strength must be between 0 and 1.');
  }

  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffff_ffff) {
    throw new RangeError('ACE Cover Seed must be an integer between 0 and 4294967295.');
  }

  if (
    input.vocalLanguage !== 'unknown' &&
    !/^[a-z]{2}$/.test(input.vocalLanguage)
  ) {
    throw new RangeError('ACE Cover Language must be Unknown or a two-letter language code.');
  }

  if (typeof input.instrumental !== 'boolean') {
    throw new TypeError('ACE Cover Instrumental mode must be a boolean.');
  }

  const guideSource = Object.freeze({
    artifactId: guideArtifactId,
    clipTakeId: guideClipTakeId,
    kind: 'active-audio-take' as const,
    relativePath: input.guideRelativePath,
  });
  const inputArtifacts = Object.freeze([
    Object.freeze({
      artifactId: guideArtifactId,
      kind: 'audio' as const,
      relativePath: input.guideRelativePath,
      sizeBytes: input.guideSizeBytes,
    }),
    Object.freeze({
      artifactId: lyricsArtifactId,
      kind: 'lyrics' as const,
      relativePath: lyricsRelativePath,
    }),
  ]) as AceStepCoverJobRequest['inputArtifacts'];

  return Object.freeze({
    guideSource,
    inputArtifacts,
    lineage: Object.freeze({
      parentArtifactIds: Object.freeze([
        guideArtifactId,
        lyricsArtifactId,
      ]) as readonly [string, string],
      parentClipTakeIds: Object.freeze([guideClipTakeId]) as readonly [string],
    }),
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    output: Object.freeze({
      artifactKind: 'audio' as const,
      destination: ACE_STEP_OUTPUT_DESTINATION,
      extension: '.wav' as const,
    }),
    parameters: Object.freeze({
      audioCoverStrength: input.coverStrength,
      audioFormat: 'wav' as const,
      batchSize: 1 as const,
      caption,
      channels: ACE_STEP_CHANNELS,
      coverNoiseStrength: ACE_STEP_COVER_NOISE_STRENGTH,
      durationSeconds: input.durationSeconds,
      guidanceScale: ACE_STEP_COVER_GUIDANCE_SCALE,
      inferenceSteps: ACE_STEP_COVER_INFERENCE_STEPS,
      instrumental: input.instrumental,
      sampleRate: ACE_STEP_SAMPLE_RATE,
      seed: input.seed,
      taskType: ACE_STEP_COVER_UPSTREAM_TASK_TYPE,
      thinking: false as const,
      vocalLanguage: input.vocalLanguage,
    }),
    providerId: ACE_STEP_PROVIDER_ID,
    taskId: ACE_STEP_COVER_TASK_ID,
  });
}

function requireTrimmedText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    throw new RangeError(`${label} must be non-empty, trimmed, and at most ${maxLength} characters.`);
  }

  return value;
}

function requireIdentity(value: unknown, label: string): string {
  const identity = requireTrimmedText(value, label, 256);

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identity)) {
    throw new RangeError(`${label} identity is invalid.`);
  }

  return identity;
}

function isSafeWavePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 4 &&
    value.length <= 4_096 &&
    value.endsWith('.wav') &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.startsWith('/') &&
    value.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
