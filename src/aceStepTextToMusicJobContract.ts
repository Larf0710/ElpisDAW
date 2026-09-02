import {
  ACE_STEP_CHANNELS,
  ACE_STEP_MAX_DURATION_SECONDS,
  ACE_STEP_MIN_DURATION_SECONDS,
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_SAMPLE_RATE,
  ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
  ACE_STEP_TEXT_TO_MUSIC_TIME_SIGNATURE,
  ACE_STEP_TEXT_TO_MUSIC_UPSTREAM_TASK_TYPE,
} from '../shared/aceStepProtocol.js';

export const ACE_STEP_TEXT_TO_MUSIC_INFERENCE_STEPS = 64 as const;
export const ACE_STEP_TEXT_TO_MUSIC_GUIDANCE_SCALE = 8 as const;

export type AceStepTextToMusicJobRequestInput = Readonly<{
  bpm: number;
  caption: string;
  durationSeconds: number;
  instrumental: boolean;
  keyscale: string;
  lyricsArtifactId: string;
  lyricsRelativePath: string;
  seed: number;
  vocalLanguage: string;
}>;

export type AceStepTextToMusicJobRequest = Readonly<{
  inputArtifacts: readonly [Readonly<{
    artifactId: string;
    kind: 'lyrics';
    relativePath: string;
  }>];
  lineage: Readonly<{
    parentArtifactIds: readonly [string];
    parentClipTakeIds: readonly [];
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
    bpm: number;
    caption: string;
    channels: typeof ACE_STEP_CHANNELS;
    durationSeconds: number;
    guidanceScale: typeof ACE_STEP_TEXT_TO_MUSIC_GUIDANCE_SCALE;
    inferenceSteps: typeof ACE_STEP_TEXT_TO_MUSIC_INFERENCE_STEPS;
    instrumental: boolean;
    keyscale: string;
    sampleRate: typeof ACE_STEP_SAMPLE_RATE;
    seed: number;
    taskType: typeof ACE_STEP_TEXT_TO_MUSIC_UPSTREAM_TASK_TYPE;
    thinking: false;
    timesignature: typeof ACE_STEP_TEXT_TO_MUSIC_TIME_SIGNATURE;
    vocalLanguage: string;
  }>;
  providerId: typeof ACE_STEP_PROVIDER_ID;
  taskId: typeof ACE_STEP_TEXT_TO_MUSIC_TASK_ID;
}>;

export function createAceStepTextToMusicJobRequest(
  input: AceStepTextToMusicJobRequestInput,
): AceStepTextToMusicJobRequest {
  if (!isRecord(input)) {
    throw new TypeError('ACE T2M Job input must be an object.');
  }

  const caption = requireTrimmedText(input.caption, 'Prompt', 2_000);
  const keyscale = requireTrimmedText(input.keyscale, 'Key', 64);
  const artifactId = requireIdentity(input.lyricsArtifactId, 'Lyrics Artifact');
  const expectedRelativePath = `renders/ace-step/lyrics/${artifactId}.txt`;

  if (input.lyricsRelativePath !== expectedRelativePath) {
    throw new RangeError('ACE T2M Lyrics path must match its finalized Artifact identity.');
  }

  if (
    typeof input.bpm !== 'number' ||
    !Number.isFinite(input.bpm) ||
    input.bpm < 20 ||
    input.bpm > 300
  ) {
    throw new RangeError('ACE T2M Tempo must be between 20 and 300 BPM.');
  }

  if (
    typeof input.durationSeconds !== 'number' ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds < ACE_STEP_MIN_DURATION_SECONDS ||
    input.durationSeconds > ACE_STEP_MAX_DURATION_SECONDS
  ) {
    throw new RangeError(
      `ACE T2M duration must be between ${ACE_STEP_MIN_DURATION_SECONDS} and ${ACE_STEP_MAX_DURATION_SECONDS} seconds.`,
    );
  }

  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffff_ffff) {
    throw new RangeError('ACE T2M Seed must be an integer between 0 and 4294967295.');
  }

  if (
    input.vocalLanguage !== 'unknown' &&
    !/^[a-z]{2}$/.test(input.vocalLanguage)
  ) {
    throw new RangeError('ACE T2M Language must be Unknown or a two-letter language code.');
  }

  if (typeof input.instrumental !== 'boolean') {
    throw new TypeError('ACE T2M Instrumental mode must be a boolean.');
  }

  return Object.freeze({
    inputArtifacts: Object.freeze([
      Object.freeze({
        artifactId,
        kind: 'lyrics' as const,
        relativePath: expectedRelativePath,
      }),
    ]) as AceStepTextToMusicJobRequest['inputArtifacts'],
    lineage: Object.freeze({
      parentArtifactIds: Object.freeze([artifactId]) as readonly [string],
      parentClipTakeIds: Object.freeze([]) as readonly [],
    }),
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    output: Object.freeze({
      artifactKind: 'audio' as const,
      destination: ACE_STEP_OUTPUT_DESTINATION,
      extension: '.wav' as const,
    }),
    parameters: Object.freeze({
      audioFormat: 'wav' as const,
      batchSize: 1 as const,
      bpm: input.bpm,
      caption,
      channels: ACE_STEP_CHANNELS,
      durationSeconds: input.durationSeconds,
      guidanceScale: ACE_STEP_TEXT_TO_MUSIC_GUIDANCE_SCALE,
      inferenceSteps: ACE_STEP_TEXT_TO_MUSIC_INFERENCE_STEPS,
      instrumental: input.instrumental,
      keyscale,
      sampleRate: ACE_STEP_SAMPLE_RATE,
      seed: input.seed,
      taskType: ACE_STEP_TEXT_TO_MUSIC_UPSTREAM_TASK_TYPE,
      thinking: false as const,
      timesignature: ACE_STEP_TEXT_TO_MUSIC_TIME_SIGNATURE,
      vocalLanguage: input.vocalLanguage,
    }),
    providerId: ACE_STEP_PROVIDER_ID,
    taskId: ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
