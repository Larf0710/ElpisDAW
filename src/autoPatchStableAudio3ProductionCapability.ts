import { STABLE_AUDIO_3_MAX_DURATION_SECONDS } from '../shared/stableAudio3Protocol.js';
import { isStableAudio3TakeCount } from './stableAudio3SeedVariations';
export const AUTO_PATCH_STABLE_AUDIO_3_PARAMETER_IDS = Object.freeze({
  durationSeconds: 'durationSeconds',
  prompt: 'prompt',
  seed: 'seed',
  strength: 'strength',
  takes: 'takes',
} as const);

export type AutoPatchStableAudio3ProductionParameter =
  | Readonly<{
      id: string;
      kind: 'number' | 'slider';
      value: number;
    }>
  | Readonly<{
      id: string;
      kind: 'select';
      options: readonly string[];
      value: string;
    }>
  | Readonly<{
      id: string;
      kind: 'text';
      value: string;
    }>;

export type AutoPatchStableAudio3ProductionParameters = Readonly<{
  durationSeconds: number;
  prompt: string;
  seed: number;
  strength: number;
  takes: number;
}>;

export type AutoPatchStableAudio3ProductionCapabilityResolution =
  | Readonly<{
      parameters: AutoPatchStableAudio3ProductionParameters;
      productionReady: true;
    }>
  | Readonly<{
      cause: string;
      message: string;
      productionReady: false;
      reason: 'parameter-invalid' | 'parameter-unsupported';
    }>;

export function resolveAutoPatchStableAudio3ProductionCapability(
  parameters: readonly AutoPatchStableAudio3ProductionParameter[],
): AutoPatchStableAudio3ProductionCapabilityResolution {
  const supportedIds = new Set<string>(
    Object.values(AUTO_PATCH_STABLE_AUDIO_3_PARAMETER_IDS),
  );

  if (parameters.some((parameter) => !supportedIds.has(parameter.id))) {
    return failure(
      'parameter-unsupported',
      'stable-audio-3-parameter-unsupported',
      'Stable Audio 3 production supports only Prompt, Duration, Seed, Takes, and Strength parameters.',
    );
  }

  const parametersById = new Map(
    parameters.map((parameter) => [parameter.id, parameter]),
  );

  const isCurrentParameterSet =
    parameters.length === supportedIds.size &&
    parametersById.size === supportedIds.size;
  const isLegacySingleTakeParameterSet =
    parameters.length === supportedIds.size - 1 &&
    parametersById.size === supportedIds.size - 1 &&
    !parametersById.has(AUTO_PATCH_STABLE_AUDIO_3_PARAMETER_IDS.takes);

  if (!isCurrentParameterSet && !isLegacySingleTakeParameterSet) {
    return failure(
      'parameter-invalid',
      'stable-audio-3-parameter-set-invalid',
      'Stable Audio 3 production requires one exact Prompt, Duration, Seed, Takes, and Strength parameter.',
    );
  }

  const prompt = parametersById.get(
    AUTO_PATCH_STABLE_AUDIO_3_PARAMETER_IDS.prompt,
  );
  const duration = parametersById.get(
    AUTO_PATCH_STABLE_AUDIO_3_PARAMETER_IDS.durationSeconds,
  );
  const seed = parametersById.get(
    AUTO_PATCH_STABLE_AUDIO_3_PARAMETER_IDS.seed,
  );
  const strength = parametersById.get(
    AUTO_PATCH_STABLE_AUDIO_3_PARAMETER_IDS.strength,
  );
  const takes = parametersById.get(
    AUTO_PATCH_STABLE_AUDIO_3_PARAMETER_IDS.takes,
  );

  if (!isSupportedPrompt(prompt)) {
    return failure(
      'parameter-invalid',
      'stable-audio-3-prompt-invalid',
      'Stable Audio 3 Prompt must be non-empty, trimmed, and within 2000 characters.',
    );
  }

  if (
    !isNumberParameter(duration) ||
    !isFiniteRange(
      duration.value,
      Number.MIN_VALUE,
      STABLE_AUDIO_3_MAX_DURATION_SECONDS,
    )
  ) {
    return failure(
      'parameter-invalid',
      'stable-audio-3-duration-invalid',
      `Stable Audio 3 Duration must be greater than zero and no more than ${STABLE_AUDIO_3_MAX_DURATION_SECONDS} seconds.`,
    );
  }

  if (
    !isNumberParameter(seed) ||
    !Number.isSafeInteger(seed.value) ||
    seed.value < 0 ||
    seed.value > 0xffff_ffff
  ) {
    return failure(
      'parameter-invalid',
      'stable-audio-3-seed-invalid',
      'Stable Audio 3 Seed must be an integer between 0 and 4294967295.',
    );
  }

  if (
    !isNumberParameter(strength) ||
    !isFiniteRange(strength.value, 0, 1)
  ) {
    return failure(
      'parameter-invalid',
      'stable-audio-3-strength-invalid',
      'Stable Audio 3 Strength must be between 0 and 1.',
    );
  }

  if (
    takes !== undefined &&
    (!isNumberParameter(takes) || !isStableAudio3TakeCount(takes.value))
  ) {
    return failure(
      'parameter-invalid',
      'stable-audio-3-takes-invalid',
      'Stable Audio 3 Takes must be an integer between 1 and 3.',
    );
  }

  return Object.freeze({
    parameters: Object.freeze({
      durationSeconds: duration.value,
      prompt: prompt.value,
      seed: seed.value,
      strength: strength.value,
      takes: takes?.value ?? 1,
    }),
    productionReady: true as const,
  });
}

function isSupportedPrompt(
  parameter: AutoPatchStableAudio3ProductionParameter | undefined,
): parameter is Extract<
  AutoPatchStableAudio3ProductionParameter,
  { kind: 'select' | 'text' }
> {
  if (!parameter || !isPrompt(parameter.value)) {
    return false;
  }

  return (
    parameter.kind === 'text' ||
    (parameter.kind === 'select' && parameter.options.includes(parameter.value))
  );
}

function isNumberParameter(
  parameter: AutoPatchStableAudio3ProductionParameter | undefined,
): parameter is Extract<
  AutoPatchStableAudio3ProductionParameter,
  { kind: 'number' | 'slider' }
> {
  return parameter?.kind === 'number' || parameter?.kind === 'slider';
}

function isPrompt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2_000 &&
    value.trim() === value
  );
}

function isFiniteRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function failure(
  reason: Extract<
    AutoPatchStableAudio3ProductionCapabilityResolution,
    { productionReady: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchStableAudio3ProductionCapabilityResolution,
  { productionReady: false }
> {
  return Object.freeze({
    cause,
    message,
    productionReady: false,
    reason,
  });
}
