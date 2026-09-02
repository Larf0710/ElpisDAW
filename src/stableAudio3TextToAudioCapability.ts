import {
  STABLE_AUDIO_3_MAX_DURATION_SECONDS,
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import type { StableAudio3Compatibility } from './stableAudio3StageAdapter';
import {
  createStableAudio3TextToAudioJobRequest,
  type StableAudio3TextToAudioJobRequest,
} from './stableAudio3TextToAudioJobContract';
import {
  createStableAudio3TextToAudioOutputPlan,
  type StableAudio3TextToAudioOutputPlan,
  type StableAudio3TextToAudioOutputRequest,
} from './stableAudio3TextToAudioOutput';
import type { ProjectState } from './types';

export type StableAudio3TextToAudioExecution = Readonly<{
  modelId: string;
  modelRevision: string;
  providerId: string;
  taskId: string;
}>;

export type StableAudio3TextToAudioRuntimeCapability = Readonly<{
  model: Readonly<{
    compatibility: StableAudio3Compatibility;
    modelId: string;
    revision: string;
  }>;
  providerId: string;
  providerVersion: string;
  runtime: Readonly<{
    compatibility: StableAudio3Compatibility;
    profileId: string;
  }>;
  supportsCancellation: boolean;
  taskId: string;
}>;

export const CURRENT_STABLE_AUDIO_3_TEXT_TO_AUDIO_RUNTIME_CAPABILITY:
  StableAudio3TextToAudioRuntimeCapability = Object.freeze({
    model: Object.freeze({
      compatibility: 'PARTIAL_SUPPORT',
      modelId: STABLE_AUDIO_3_MODEL_ID,
      revision: STABLE_AUDIO_3_MODEL_REVISION,
    }),
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    providerVersion: STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
    runtime: Object.freeze({
      compatibility: 'COMPATIBLE',
      profileId: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
    }),
    supportsCancellation: true,
    taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
  });

export type StableAudio3TextToAudioCapabilityInput = Readonly<{
  execution: StableAudio3TextToAudioExecution;
  output: StableAudio3TextToAudioOutputRequest;
  prompt: string;
  seed: number;
}>;

export type StableAudio3TextToAudioJobPlan = Readonly<{
  kind: 'local-engine-gpu-job';
  output: StableAudio3TextToAudioOutputPlan;
  request: StableAudio3TextToAudioJobRequest;
  runtime: Readonly<{
    modelCompatibility: 'COMPATIBLE' | 'PARTIAL_SUPPORT';
    profileId: typeof STABLE_AUDIO_3_RUNTIME_PROFILE_ID;
    providerVersion: typeof STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION;
    supportsCancellation: boolean;
  }>;
}>;

export type StableAudio3TextToAudioCapabilityResolution =
  | Readonly<{
      canEnqueue: true;
      plan: StableAudio3TextToAudioJobPlan;
    }>
  | Readonly<{
      canEnqueue: false;
      cause: string;
      message: string;
      reason:
        | 'duration-unsupported'
        | 'execution-invalid'
        | 'model-incompatible'
        | 'model-unverified'
        | 'output-invalid'
        | 'profile-invalid'
        | 'request-invalid'
        | 'runtime-incompatible'
        | 'runtime-unverified';
    }>;

export function resolveStableAudio3TextToAudioCapability(
  project: ProjectState,
  input: StableAudio3TextToAudioCapabilityInput,
  capability: StableAudio3TextToAudioRuntimeCapability,
): StableAudio3TextToAudioCapabilityResolution {
  if (!hasValidExecution(input)) {
    return failure(
      'execution-invalid',
      'stable-audio-3-t2a-execution-invalid',
      'SA3 T2A requires the exact Provider, model revision, and text-to-audio task.',
    );
  }

  if (!hasMatchingCapability(input.execution, capability)) {
    return failure(
      'profile-invalid',
      'stable-audio-3-t2a-capability-mismatch',
      'SA3 T2A Runtime capability is invalid or does not match the requested execution identity.',
    );
  }

  if (capability.runtime.compatibility === 'UNVERIFIED') {
    return failure(
      'runtime-unverified',
      'stable-audio-3-t2a-runtime-unverified',
      'SA3 T2A is blocked until the exact Runtime Profile declares text-to-audio support.',
    );
  }

  if (capability.runtime.compatibility !== 'COMPATIBLE') {
    return failure(
      'runtime-incompatible',
      'stable-audio-3-t2a-runtime-incompatible',
      'SA3 T2A requires a compatible Runtime Profile.',
    );
  }

  if (capability.model.compatibility === 'UNVERIFIED') {
    return failure(
      'model-unverified',
      'stable-audio-3-t2a-model-unverified',
      'SA3 T2A is blocked until the exact model revision is verified for text-to-audio.',
    );
  }

  if (
    capability.model.compatibility !== 'COMPATIBLE' &&
    capability.model.compatibility !== 'PARTIAL_SUPPORT'
  ) {
    return failure(
      'model-incompatible',
      'stable-audio-3-t2a-model-incompatible',
      'SA3 T2A requires a declared compatible model revision.',
    );
  }

  const outputResolution = createStableAudio3TextToAudioOutputPlan(
    project,
    input.output,
  );

  if (!outputResolution.canPlan) {
    return failure(
      'output-invalid',
      outputResolution.cause,
      outputResolution.message,
    );
  }

  const durationSeconds =
    outputResolution.plan.generationRegion.durationSeconds;

  if (durationSeconds > STABLE_AUDIO_3_MAX_DURATION_SECONDS) {
    return failure(
      'duration-unsupported',
      'stable-audio-3-t2a-duration-unsupported',
      `SA3 T2A duration must be no more than ${STABLE_AUDIO_3_MAX_DURATION_SECONDS} seconds at the captured Tempo.`,
    );
  }

  let request: StableAudio3TextToAudioJobRequest;

  try {
    request = createStableAudio3TextToAudioJobRequest({
      durationSeconds,
      modelId: input.execution.modelId,
      modelRevision: input.execution.modelRevision,
      prompt: input.prompt,
      providerId: input.execution.providerId,
      seed: input.seed,
    });
  } catch (error) {
    return failure(
      'request-invalid',
      'stable-audio-3-t2a-job-request-invalid',
      error instanceof Error ? error.message : 'SA3 T2A Job request is invalid.',
    );
  }

  return Object.freeze({
    canEnqueue: true as const,
    plan: Object.freeze({
      kind: 'local-engine-gpu-job' as const,
      output: outputResolution.plan,
      request,
      runtime: Object.freeze({
        modelCompatibility: capability.model.compatibility,
        profileId: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
        providerVersion: STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
        supportsCancellation: capability.supportsCancellation,
      }),
    }),
  });
}

function hasValidExecution(
  input: StableAudio3TextToAudioCapabilityInput,
): boolean {
  return (
    isRecord(input) &&
    isRecord(input.execution) &&
    isRecord(input.output) &&
    input.execution.providerId === STABLE_AUDIO_3_PROVIDER_ID &&
    input.execution.taskId === STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID &&
    input.execution.modelId === STABLE_AUDIO_3_MODEL_ID &&
    input.execution.modelRevision === STABLE_AUDIO_3_MODEL_REVISION
  );
}

function hasMatchingCapability(
  execution: StableAudio3TextToAudioExecution,
  capability: StableAudio3TextToAudioRuntimeCapability,
): boolean {
  return (
    isRecord(capability) &&
    isRecord(capability.model) &&
    isRecord(capability.runtime) &&
    capability.providerId === execution.providerId &&
    capability.providerId === STABLE_AUDIO_3_PROVIDER_ID &&
    capability.providerVersion === STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION &&
    capability.taskId === execution.taskId &&
    capability.taskId === STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID &&
    capability.model.modelId === execution.modelId &&
    capability.model.modelId === STABLE_AUDIO_3_MODEL_ID &&
    capability.model.revision === execution.modelRevision &&
    capability.model.revision === STABLE_AUDIO_3_MODEL_REVISION &&
    capability.runtime.profileId === STABLE_AUDIO_3_RUNTIME_PROFILE_ID &&
    isCompatibility(capability.runtime.compatibility) &&
    isCompatibility(capability.model.compatibility) &&
    typeof capability.supportsCancellation === 'boolean'
  );
}

function isCompatibility(value: unknown): value is StableAudio3Compatibility {
  return (
    value === 'COMPATIBLE' ||
    value === 'PARTIAL_SUPPORT' ||
    value === 'UNVERIFIED' ||
    value === 'INCOMPATIBLE'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(
  reason: Extract<
    StableAudio3TextToAudioCapabilityResolution,
    { canEnqueue: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  StableAudio3TextToAudioCapabilityResolution,
  { canEnqueue: false }
> {
  return Object.freeze({ canEnqueue: false as const, cause, message, reason });
}
