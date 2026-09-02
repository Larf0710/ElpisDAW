import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import type { AutoPatchRuntimeStageDispatch } from './autoPatchRuntimeCoordinator';
import {
  resolveAutoPatchStableAudio3ProductionCapability,
  type AutoPatchStableAudio3ProductionParameters,
} from './autoPatchStableAudio3ProductionCapability';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import type { StableAudio3StageDispatch } from './stableAudio3StageAdapter';
import {
  resolveStableAudio3AudioToAudioContinuation,
  type StableAudio3AudioToAudioContinuationPlan,
} from './stableAudio3AudioToAudioContinuation';
import type { ProjectState } from './types';

export type AutoPatchStableAudio3StageDispatchResolution =
  | Readonly<{
      dispatch: StableAudio3StageDispatch;
      continuation: StableAudio3AudioToAudioContinuationPlan;
      ok: true;
      sourceClipId: string;
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      reason:
        | 'dispatch-invalid'
        | 'parameter-invalid'
        | 'project-stale'
        | 'source-unavailable';
    }>;

export function createAutoPatchStableAudio3StageDispatch(
  dispatch: AutoPatchRuntimeStageDispatch,
  project: ProjectState,
): AutoPatchStableAudio3StageDispatchResolution {
  if (
    dispatch.node.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3 ||
    dispatch.node.nodeVersion !== '1.0.0' ||
    dispatch.execution.kind !== 'provider' ||
    dispatch.execution.providerId !== STABLE_AUDIO_3_PROVIDER_ID ||
    dispatch.execution.providerRevision !==
      STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION ||
    dispatch.execution.taskId !== STABLE_AUDIO_3_TASK_ID ||
    dispatch.execution.modelId !== STABLE_AUDIO_3_MODEL_ID ||
    dispatch.execution.modelRevision !== STABLE_AUDIO_3_MODEL_REVISION ||
    dispatch.resourceInputs.length !== 0
  ) {
    return failure(
      'dispatch-invalid',
      'stable-audio-3-production-dispatch-invalid',
      'Stable Audio 3 production requires the exact promoted Provider, model, task, node version, and an empty resource-input set.',
    );
  }

  const projectPatchTabs = project.patchTabs.filter(
    (patchTab) => patchTab.id === dispatch.node.patchTabId,
  );
  const projectPatchTab = projectPatchTabs[0];

  if (
    projectPatchTabs.length !== 1 ||
    !projectPatchTab ||
    projectPatchTab.nodeTypeId !== dispatch.node.nodeTypeId ||
    projectPatchTab.nodeVersion !== dispatch.node.nodeVersion ||
    !areJsonValuesEqual(
      projectPatchTab.parameters,
      dispatch.node.parameters,
    )
  ) {
    return failure(
      'project-stale',
      'stable-audio-3-patch-tab-changed',
      'Current Stable Audio 3 PatchTab no longer matches its immutable runtime snapshot.',
    );
  }

  const parameterResolution =
    resolveAutoPatchStableAudio3ProductionCapability(
      dispatch.node.parameters,
    );

  if (!parameterResolution.productionReady) {
    return failure(
      'parameter-invalid',
      parameterResolution.cause,
      parameterResolution.message,
    );
  }

  const sourceInput = dispatch.artifactInputs[0];

  if (
    dispatch.artifactInputs.length !== 1 ||
    !sourceInput ||
    sourceInput.portId !== 'audio-in' ||
    sourceInput.artifactIds.length !== 1 ||
    sourceInput.clipTakeIds.length !== 1 ||
    sourceInput.midi !== undefined
  ) {
    return failure(
      'dispatch-invalid',
      'stable-audio-3-artifact-input-invalid',
      'Stable Audio 3 production requires one exact Audio Artifact and Clip Take on audio-in.',
    );
  }

  const sourceClipId = resolveSourceClipId(
    project,
    sourceInput.artifactIds[0],
    sourceInput.clipTakeIds[0],
  );

  if (!sourceClipId) {
    return failure(
      'source-unavailable',
      'stable-audio-3-source-clip-unavailable',
      'Stable Audio 3 upstream Artifact and Clip Take do not resolve to one current Active Audio Clip.',
    );
  }

  const stableAudio3Dispatch = createStableAudio3Dispatch(
    dispatch,
    parameterResolution.parameters,
    sourceClipId,
    sourceInput.artifactIds[0],
    sourceInput.clipTakeIds[0],
  );
  const continuation = resolveStableAudio3AudioToAudioContinuation(
    project,
    projectPatchTab,
    stableAudio3Dispatch,
  );

  if (!continuation.ok) {
    return failure(
      'parameter-invalid',
      continuation.cause,
      continuation.message,
    );
  }

  return Object.freeze({
    continuation: continuation.plan,
    dispatch: stableAudio3Dispatch,
    ok: true as const,
    sourceClipId,
  });
}

function createStableAudio3Dispatch(
  dispatch: AutoPatchRuntimeStageDispatch,
  parameters: AutoPatchStableAudio3ProductionParameters,
  sourceClipId: string,
  artifactId: string,
  clipTakeId: string,
): StableAudio3StageDispatch {
  const execution = dispatch.execution;

  if (execution.kind !== 'provider') {
    throw new Error('Stable Audio 3 Provider dispatch narrowed unexpectedly.');
  }

  return Object.freeze({
    attemptId: dispatch.attemptId,
    execution: Object.freeze({
      modelId: execution.modelId,
      modelRevision: execution.modelRevision,
      providerId: execution.providerId,
      taskId: execution.taskId,
    }),
    fingerprint: dispatch.fingerprint,
    parameters: Object.freeze({ ...parameters }),
    runId: dispatch.runId,
    scope: Object.freeze({ ...dispatch.scope }),
    source: Object.freeze({
      artifactId,
      clipId: sourceClipId,
      clipTakeId,
    }),
    startedAt: dispatch.startedAt,
  });
}

function resolveSourceClipId(
  project: ProjectState,
  artifactId: string,
  clipTakeId: string,
): string | undefined {
  const matches = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => {
      if (clip.activeClipTakeId !== clipTakeId) {
        return false;
      }

      const takes = (clip.clipTakes ?? []).filter(
        (take) =>
          take.clipTakeId === clipTakeId &&
          take.artifactId === artifactId &&
          take.mediaType === 'audio',
      );

      return takes.length === 1;
    }),
  );

  return matches.length === 1 ? matches[0].id : undefined;
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        areJsonValuesEqual(value, right[index]),
      )
    );
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        areJsonValuesEqual(left[key], right[key]),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(
  reason: Extract<
    AutoPatchStableAudio3StageDispatchResolution,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchStableAudio3StageDispatchResolution,
  { ok: false }
> {
  return Object.freeze({ cause, message, ok: false, reason });
}
