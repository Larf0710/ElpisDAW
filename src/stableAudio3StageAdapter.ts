import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import {
  createStableAudio3JobRequest,
  type StableAudio3JobRequest,
} from './stableAudio3JobContract';
import type { ProjectState, TabFlowStageResultScope } from './types';

export const STABLE_AUDIO_3_STAGE_ADAPTER_ID =
  'local-stable-audio-3-audio-to-audio-v1' as const;

export type StableAudio3Compatibility =
  | 'COMPATIBLE'
  | 'PARTIAL_SUPPORT'
  | 'UNVERIFIED'
  | 'INCOMPATIBLE';

export type StableAudio3StageDispatch = Readonly<{
  attemptId: string;
  execution: Readonly<{
    modelId: string;
    modelRevision: string;
    providerId: string;
    taskId: string;
  }>;
  fingerprint: string;
  parameters: Readonly<{
    durationSeconds: number;
    prompt: string;
    seed: number;
    strength: number;
    takes: number;
  }>;
  runId: string;
  scope: TabFlowStageResultScope;
  source: Readonly<{
    artifactId: string;
    clipId: string;
    clipTakeId: string;
  }>;
  startedAt: string;
}>;

export type StableAudio3StageRuntimeProfile = Readonly<{
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

export type StableAudio3StageAdapterPlan = Readonly<{
  adapterId: typeof STABLE_AUDIO_3_STAGE_ADAPTER_ID;
  attemptId: string;
  fingerprint: string;
  kind: 'local-engine-gpu-job';
  request: StableAudio3JobRequest;
  runId: string;
  runtime: Readonly<{
    modelCompatibility: 'COMPATIBLE' | 'PARTIAL_SUPPORT';
    profileId: string;
    providerVersion: string;
    supportsCancellation: boolean;
  }>;
  scope: TabFlowStageResultScope;
  sourceClipId: string;
}>;

export type StableAudio3StageAdapterPlanResolution =
  | Readonly<{
      canPlan: true;
      plan: StableAudio3StageAdapterPlan;
    }>
  | Readonly<{
      canPlan: false;
      cause: string;
      message: string;
      reason:
        | 'dispatch-invalid'
        | 'model-incompatible'
        | 'model-unverified'
        | 'profile-invalid'
        | 'request-invalid'
        | 'runtime-incompatible'
        | 'runtime-unverified'
        | 'source-audio-mismatch'
        | 'source-audio-unavailable';
    }>;

export function createStableAudio3StageAdapterPlan(
  dispatch: StableAudio3StageDispatch,
  project: ProjectState,
  profile: StableAudio3StageRuntimeProfile,
): StableAudio3StageAdapterPlanResolution {
  const dispatchFailure = validateDispatch(dispatch);

  if (dispatchFailure) {
    return dispatchFailure;
  }

  const profileFailure = validateProfile(dispatch, profile);

  if (profileFailure) {
    return profileFailure;
  }

  if (profile.runtime.compatibility === 'UNVERIFIED') {
    return failure(
      'runtime-unverified',
      'stable-audio-3-runtime-unverified',
      'Stable Audio 3 Stage planning is blocked until the exact Runtime Profile passes target-GPU verification.',
    );
  }

  if (profile.runtime.compatibility !== 'COMPATIBLE') {
    return failure(
      'runtime-incompatible',
      'stable-audio-3-runtime-incompatible',
      'Stable Audio 3 Stage planning requires a compatible Runtime Profile.',
    );
  }

  if (profile.model.compatibility === 'UNVERIFIED') {
    return failure(
      'model-unverified',
      'stable-audio-3-model-unverified',
      'Stable Audio 3 Stage planning is blocked until the exact model revision passes verification.',
    );
  }

  if (
    profile.model.compatibility !== 'COMPATIBLE' &&
    profile.model.compatibility !== 'PARTIAL_SUPPORT'
  ) {
    return failure(
      'model-incompatible',
      'stable-audio-3-model-incompatible',
      'Stable Audio 3 Stage planning requires a declared compatible model revision.',
    );
  }

  const source = resolveActiveAudioTakeSource(
    project,
    dispatch.source.clipId,
  );

  if (!source.canResolve) {
    return failure(
      'source-audio-unavailable',
      source.reason,
      `Stable Audio 3 Stage source is unavailable: ${source.message}`,
    );
  }

  if (
    source.plan.source.artifactId !== dispatch.source.artifactId ||
    source.plan.source.clipId !== dispatch.source.clipId ||
    source.plan.source.clipTakeId !== dispatch.source.clipTakeId
  ) {
    return failure(
      'source-audio-mismatch',
      'stable-audio-3-source-stale',
      'Stable Audio 3 Stage dispatch no longer matches the exact Active Audio Artifact and Take.',
    );
  }

  let request: StableAudio3JobRequest;

  try {
    request = createStableAudio3JobRequest({
      durationSeconds: dispatch.parameters.durationSeconds,
      modelId: dispatch.execution.modelId,
      modelRevision: dispatch.execution.modelRevision,
      plan: source.plan,
      prompt: dispatch.parameters.prompt,
      providerId: dispatch.execution.providerId,
      seed: dispatch.parameters.seed,
      strength: dispatch.parameters.strength,
    });
  } catch (error) {
    return failure(
      'request-invalid',
      'stable-audio-3-job-request-invalid',
      error instanceof Error
        ? error.message
        : 'Stable Audio 3 Job request is invalid.',
    );
  }

  const plan: StableAudio3StageAdapterPlan = Object.freeze({
    adapterId: STABLE_AUDIO_3_STAGE_ADAPTER_ID,
    attemptId: dispatch.attemptId,
    fingerprint: dispatch.fingerprint,
    kind: 'local-engine-gpu-job' as const,
    request,
    runId: dispatch.runId,
    runtime: Object.freeze({
      modelCompatibility: profile.model.compatibility,
      profileId: profile.runtime.profileId,
      providerVersion: profile.providerVersion,
      supportsCancellation: profile.supportsCancellation,
    }),
    scope: Object.freeze({ ...dispatch.scope }),
    sourceClipId: dispatch.source.clipId,
  });

  return Object.freeze({ canPlan: true, plan });
}

function validateDispatch(
  dispatch: StableAudio3StageDispatch,
): Extract<
  StableAudio3StageAdapterPlanResolution,
  { canPlan: false }
> | undefined {
  if (
    !isRecord(dispatch) ||
    !isRecord(dispatch.execution) ||
    !isRecord(dispatch.parameters) ||
    !isRecord(dispatch.scope) ||
    !isRecord(dispatch.source) ||
    ![
      dispatch.attemptId,
      dispatch.fingerprint,
      dispatch.runId,
      dispatch.scope.familyId,
      dispatch.scope.stageId,
      dispatch.scope.targetClipId,
      dispatch.source.artifactId,
      dispatch.source.clipId,
      dispatch.source.clipTakeId,
    ].every(isNonEmptyTrimmedString) ||
    !Number.isSafeInteger(dispatch.scope.familyRevision) ||
    dispatch.scope.familyRevision < 0 ||
    !isValidTimestamp(dispatch.startedAt) ||
    dispatch.execution.providerId !== STABLE_AUDIO_3_PROVIDER_ID ||
    dispatch.execution.taskId !== STABLE_AUDIO_3_TASK_ID ||
    dispatch.execution.modelId !== STABLE_AUDIO_3_MODEL_ID ||
    !isNonEmptyTrimmedString(dispatch.execution.modelRevision)
  ) {
    return failure(
      'dispatch-invalid',
      'stable-audio-3-dispatch-invalid',
      'Stable Audio 3 Stage dispatch identity, scope, source, or Provider contract is invalid.',
    );
  }

  return undefined;
}

function validateProfile(
  dispatch: StableAudio3StageDispatch,
  profile: StableAudio3StageRuntimeProfile,
): Extract<
  StableAudio3StageAdapterPlanResolution,
  { canPlan: false }
> | undefined {
  if (
    !isRecord(profile) ||
    !isRecord(profile.model) ||
    !isRecord(profile.runtime) ||
    profile.providerId !== dispatch.execution.providerId ||
    profile.taskId !== dispatch.execution.taskId ||
    profile.model.modelId !== dispatch.execution.modelId ||
    profile.model.revision !== dispatch.execution.modelRevision ||
    !isNonEmptyTrimmedString(profile.providerVersion) ||
    !isNonEmptyTrimmedString(profile.runtime.profileId) ||
    !isCompatibility(profile.runtime.compatibility) ||
    !isCompatibility(profile.model.compatibility) ||
    typeof profile.supportsCancellation !== 'boolean'
  ) {
    return failure(
      'profile-invalid',
      'stable-audio-3-runtime-profile-mismatch',
      'Stable Audio 3 Runtime Profile is invalid or does not match the immutable Stage dispatch.',
    );
  }

  return undefined;
}

function failure(
  reason: Extract<
    StableAudio3StageAdapterPlanResolution,
    { canPlan: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  StableAudio3StageAdapterPlanResolution,
  { canPlan: false }
> {
  return Object.freeze({ canPlan: false, cause, message, reason });
}

function isCompatibility(value: unknown): value is StableAudio3Compatibility {
  return (
    value === 'COMPATIBLE' ||
    value === 'PARTIAL_SUPPORT' ||
    value === 'UNVERIFIED' ||
    value === 'INCOMPATIBLE'
  );
}

function isValidTimestamp(value: unknown): value is string {
  return (
    isNonEmptyTrimmedString(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
