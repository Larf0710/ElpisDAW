import { resolveActiveMidiTake } from './activeMidiTake';
import type { AutoPatchRuntimeStageDispatch } from './autoPatchRuntimeCoordinator';
import {
  FLUIDSYNTH_INSTRUMENT_GAIN_DB,
  FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
  FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
  FLUIDSYNTH_INSTRUMENT_SAMPLE_RATE,
} from './fluidSynthInstrumentRender';
import {
  createInstrumentRenderJobRequest,
  INSTRUMENT_RENDER_TASK_ID,
  type InstrumentRenderJobRequest,
} from './instrumentRenderContract';
import type { LocalEngineSoundFontResource } from './localEngineClient';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
} from './patchTabPortContract';
import type { ProjectState, TabFlowStageResultScope } from './types';

export const AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID =
  'local-fluidsynth-midi-to-audio-v1' as const;

export type AutoPatchStageAdapterPlan = Readonly<{
  adapterId: typeof AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID;
  attemptId: string;
  fingerprint: string;
  kind: 'local-engine-job';
  request: InstrumentRenderJobRequest;
  runId: string;
  scope: TabFlowStageResultScope;
  sourceClipId: string;
}>;

export type AutoPatchStageAdapterPlanResolution =
  | Readonly<{
      canPlan: true;
      plan: AutoPatchStageAdapterPlan;
    }>
  | Readonly<{
      canPlan: false;
      cause: string;
      message: string;
      reason:
        | 'adapter-unavailable'
        | 'dispatch-invalid'
        | 'request-invalid'
        | 'resource-unavailable'
        | 'source-midi-mismatch'
        | 'source-midi-unavailable';
    }>;

export function createAutoPatchStageAdapterPlan(
  dispatch: AutoPatchRuntimeStageDispatch,
  project: ProjectState,
  verifiedSoundFontResources: readonly LocalEngineSoundFontResource[],
): AutoPatchStageAdapterPlanResolution {
  if (dispatch.node.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.instrument) {
    return failure(
      'adapter-unavailable',
      'stage-adapter-unavailable',
      `No production Stage Adapter is registered for ${dispatch.node.nodeTypeId}.`,
    );
  }

  const definition = getBuiltinPatchTabDefinitions().find(
    (candidate) =>
      candidate.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
  );
  const artifactInput = dispatch.artifactInputs[0];
  const resourceInput = dispatch.resourceInputs[0];

  if (
    !definition ||
    dispatch.node.nodeVersion !== definition.nodeVersion ||
    dispatch.node.parameters.length !== 0 ||
    dispatch.artifactInputs.length !== 1 ||
    artifactInput?.portId !== 'midi-in' ||
    artifactInput.artifactIds.length !== 1 ||
    artifactInput.clipTakeIds.length !== 1 ||
    !artifactInput.midi ||
    dispatch.resourceInputs.length !== 1 ||
    resourceInput?.portId !== 'soundfont-in' ||
    dispatch.execution.kind !== 'provider' ||
    dispatch.execution.providerId !==
      FLUIDSYNTH_INSTRUMENT_PROVIDER_ID ||
    dispatch.execution.providerRevision !==
      FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION ||
    dispatch.execution.taskId !== INSTRUMENT_RENDER_TASK_ID ||
    dispatch.execution.modelId !== resourceInput.resourceId ||
    dispatch.execution.modelRevision !== resourceInput.revision
  ) {
    return failure(
      'dispatch-invalid',
      'instrument-dispatch-invalid',
      'MIDI TO AUDIO dispatch does not match the production FluidSynth Stage Adapter contract.',
    );
  }

  const bank = resourceInput.selections.bank;
  const program = resourceInput.selections.program;

  if (
    !Number.isSafeInteger(bank) ||
    (bank as number) < 0 ||
    (bank as number) > 16_383 ||
    !Number.isSafeInteger(program) ||
    (program as number) < 0 ||
    (program as number) > 127
  ) {
    return failure(
      'dispatch-invalid',
      'instrument-preset-invalid',
      'MIDI TO AUDIO dispatch contains an invalid SoundFont Bank or Program.',
    );
  }

  const source = resolveActiveMidiTake(
    project,
    dispatch.scope.targetClipId,
  );

  if (!source.canResolve) {
    return failure(
      'source-midi-unavailable',
      source.reason,
      `MIDI TO AUDIO Stage source is unavailable: ${source.message}`,
    );
  }

  if (
    source.plan.source.artifactId !== artifactInput.artifactIds[0] ||
    source.plan.source.clipTakeId !== artifactInput.clipTakeIds[0] ||
    source.plan.source.contentHash !== artifactInput.midi.contentHash ||
    source.plan.source.revision !== artifactInput.midi.revision
  ) {
    return failure(
      'source-midi-mismatch',
      'runtime-midi-input-stale',
      'MIDI TO AUDIO dispatch no longer matches the exact Active MIDI Artifact and Take.',
    );
  }

  const matchingResources = verifiedSoundFontResources.filter(
    (resource) =>
      resource.status === 'AVAILABLE' &&
      resource.resourceId === resourceInput.resourceId &&
      resource.revisionToken === resourceInput.revision,
  );

  if (matchingResources.length !== 1) {
    return failure(
      'resource-unavailable',
      'soundfont-resource-unavailable',
      'MIDI TO AUDIO SoundFont is missing, stale, or ambiguous at Stage execution time.',
    );
  }

  const soundFont = matchingResources[0];
  let request: InstrumentRenderJobRequest;

  try {
    request = createInstrumentRenderJobRequest({
      gainDb: FLUIDSYNTH_INSTRUMENT_GAIN_DB,
      modelId: dispatch.execution.modelId,
      modelRevision: dispatch.execution.modelRevision,
      plan: source.plan,
      preset: {
        bank: bank as number,
        program: program as number,
      },
      providerId: dispatch.execution.providerId,
      providerVersion: dispatch.execution.providerRevision,
      sampleRate: FLUIDSYNTH_INSTRUMENT_SAMPLE_RATE,
      soundFont: {
        format: soundFont.format,
        library: soundFont.library,
        relativePath: soundFont.relativePath,
        resourceId: soundFont.resourceId,
        revisionToken: soundFont.revisionToken,
      },
    });
  } catch (error) {
    return failure(
      'request-invalid',
      'instrument-job-request-invalid',
      error instanceof Error
        ? error.message
        : 'MIDI TO AUDIO Job request is invalid.',
    );
  }

  const plan: AutoPatchStageAdapterPlan = Object.freeze({
    adapterId: AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID,
    attemptId: dispatch.attemptId,
    fingerprint: dispatch.fingerprint,
    kind: 'local-engine-job',
    request,
    runId: dispatch.runId,
    scope: Object.freeze({ ...dispatch.scope }),
    sourceClipId: dispatch.scope.targetClipId,
  });

  return Object.freeze({
    canPlan: true,
    plan,
  });
}

function failure(
  reason: Extract<
    AutoPatchStageAdapterPlanResolution,
    { canPlan: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchStageAdapterPlanResolution,
  { canPlan: false }
> {
  return Object.freeze({ canPlan: false, cause, message, reason });
}
