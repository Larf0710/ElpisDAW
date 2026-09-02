import {
  FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
  FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
} from './fluidSynthInstrumentRender';
import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import { INSTRUMENT_RENDER_TASK_ID } from './instrumentRenderContract';
import type { LocalEngineSoundFontResource } from './localEngineClient';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  PATCH_DATA_TYPES,
} from './patchTabPortContract';
import type {
  AutoPatchPatchTabSnapshot,
  AutoPatchTargetSnapshot,
} from './autoPatchGraphSnapshot';
import type { TabFlowStageResourceInput } from './tabFlowChangedStage';
import type { TabFlowStageResultScope } from './types';

type SnapshotInputBinding =
  AutoPatchPatchTabSnapshot['inputBindings'][number];
type SnapshotProjectContextBinding = Extract<
  SnapshotInputBinding,
  { readonly kind: 'project-context' }
>;
type SnapshotConnectionBinding = Extract<
  SnapshotInputBinding,
  { readonly kind: 'connection' }
>;
type SnapshotInputPort =
  AutoPatchPatchTabSnapshot['portContract']['inputs'][number];

export const AUTO_PATCH_CLIP_SOUNDFONT_SELECTOR = 'clip.soundFont';

export type AutoPatchStageExecutionProfile =
  | Readonly<{
      kind: 'builtin';
    }>
  | Readonly<{
      kind: 'provider';
      modelId: string;
      modelRevision: string;
      providerId: string;
      providerRevision: string;
      taskId: string;
    }>;

export type AutoPatchVerifiedStageRuntimeProfile = Readonly<{
  execution: AutoPatchStageExecutionProfile;
  resourceInputs: readonly TabFlowStageResourceInput[];
  scope: TabFlowStageResultScope;
}>;

export type AutoPatchRuntimeProfileValidationResolution =
  | Readonly<{
      execution: AutoPatchStageExecutionProfile;
      ok: true;
      resourceInputs: readonly TabFlowStageResourceInput[];
      verifiedSoundFontResourceIds: readonly string[];
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      reason:
        | 'profile-invalid'
        | 'resource-unavailable'
        | 'provider-invalid';
    }>;

export function validateAutoPatchRuntimeProfile(
  patchTab: AutoPatchPatchTabSnapshot,
  target: AutoPatchTargetSnapshot,
  profile: AutoPatchVerifiedStageRuntimeProfile,
  verifiedSoundFontResources: readonly LocalEngineSoundFontResource[],
): AutoPatchRuntimeProfileValidationResolution {
  if (!Array.isArray(profile.resourceInputs)) {
    return failure(
      'profile-invalid',
      'resource-profile-invalid',
      `Stage ${patchTab.id} runtime resource profile is invalid.`,
    );
  }

  const duplicatePortId = findDuplicateId(
    profile.resourceInputs.map((resourceInput) => resourceInput.portId),
  );

  if (duplicatePortId) {
    return failure(
      'profile-invalid',
      'resource-profile-duplicate-port',
      `Runtime profile contains duplicate resource Port ${duplicatePortId}.`,
    );
  }

  const resourceInputs: TabFlowStageResourceInput[] = [];
  const verifiedSoundFontResourceIds: string[] = [];

  for (const resourceInput of profile.resourceInputs) {
    const port = patchTab.portContract.inputs.find(
      (candidate) => candidate.id === resourceInput.portId,
    );
    const matchingBindings = patchTab.inputBindings.filter(
      (binding) => binding.portId === resourceInput.portId,
    );
    const binding = matchingBindings[0];

    if (
      !port ||
      port.domain !== 'resource' ||
      matchingBindings.length !== 1 ||
      !binding ||
      !isValidResourceInput(resourceInput)
    ) {
      return failure(
        'profile-invalid',
        'resource-profile-invalid',
        `Stage ${patchTab.id} resource input ${resourceInput.portId} is invalid or unbound.`,
      );
    }

    if (acceptsSoundFont(port)) {
      const bank = resourceInput.selections.bank;
      const program = resourceInput.selections.program;

      if (
        !Number.isSafeInteger(bank) ||
        typeof bank !== 'number' ||
        bank < 0 ||
        bank > 16_383 ||
        !Number.isSafeInteger(program) ||
        typeof program !== 'number' ||
        program < 0 ||
        program > 127
      ) {
        return failure(
          'resource-unavailable',
          'soundfont-resource-unavailable',
          `Stage ${patchTab.id} SoundFont Bank or Program is invalid.`,
        );
      }

      const verifiedResource =
        binding.kind === 'project-context'
          ? validateProjectContextSoundFont(
              binding,
              target,
              resourceInput,
              verifiedSoundFontResources,
            )
          : binding.kind === 'connection'
            ? validateConnectedSoundFont(
                binding,
                resourceInput,
                verifiedSoundFontResources,
              )
            : undefined;

      if (!verifiedResource) {
        return failure(
          'resource-unavailable',
          'soundfont-resource-unavailable',
          `Stage ${patchTab.id} SoundFont resource is missing, stale, or mismatched.`,
        );
      }

      verifiedSoundFontResourceIds.push(verifiedResource.resourceId);
    }

    resourceInputs.push(cloneResourceInput(resourceInput));
  }

  const missingResourceBinding = patchTab.portContract.inputs.find(
    (port) =>
      port.domain === 'resource' &&
      patchTab.inputBindings.some((binding) => binding.portId === port.id) &&
      !resourceInputs.some((resourceInput) => resourceInput.portId === port.id),
  );

  if (missingResourceBinding) {
    return failure(
      'resource-unavailable',
      'resource-profile-missing',
      `Resource Port ${missingResourceBinding.id} does not have a verified runtime resource.`,
    );
  }

  const executionFailure = validateExecutionProfile(
    patchTab,
    profile.execution,
    resourceInputs,
  );

  if (executionFailure) {
    return failure(
      'provider-invalid',
      executionFailure.cause,
      executionFailure.message,
    );
  }

  return freezeDeep({
    execution: cloneExecutionProfile(profile.execution),
    ok: true,
    resourceInputs,
    verifiedSoundFontResourceIds,
  });
}

function validateProjectContextSoundFont(
  binding: SnapshotProjectContextBinding,
  target: AutoPatchTargetSnapshot,
  resourceInput: TabFlowStageResourceInput,
  resources: readonly LocalEngineSoundFontResource[],
): LocalEngineSoundFontResource | undefined {
  const assignment = target.soundFont;

  if (
    binding.selector !== AUTO_PATCH_CLIP_SOUNDFONT_SELECTOR ||
    !assignment ||
    resourceInput.resourceId !== assignment.resource.resourceId ||
    resourceInput.selections.bank !== assignment.bank ||
    resourceInput.selections.program !== assignment.program
  ) {
    return undefined;
  }

  const matches = resources.filter(
    (resource) =>
      resource.resourceId === assignment.resource.resourceId &&
      resource.format === assignment.resource.format &&
      resource.relativePath === assignment.resource.relativePath &&
      resource.revisionToken === resourceInput.revision,
  );

  return matches.length === 1 ? matches[0] : undefined;
}

function validateConnectedSoundFont(
  binding: SnapshotConnectionBinding,
  resourceInput: TabFlowStageResourceInput,
  resources: readonly LocalEngineSoundFontResource[],
): LocalEngineSoundFontResource | undefined {
  if (binding.connectionIds.length !== 1) {
    return undefined;
  }

  const matches = resources.filter(
    (resource) =>
      resource.resourceId === resourceInput.resourceId &&
      resource.revisionToken === resourceInput.revision,
  );

  return matches.length === 1 ? matches[0] : undefined;
}

function validateExecutionProfile(
  patchTab: AutoPatchPatchTabSnapshot,
  execution: AutoPatchStageExecutionProfile,
  resourceInputs: readonly TabFlowStageResourceInput[],
): Readonly<{ cause: string; message: string }> | undefined {
  const executionKind = (execution as { kind?: unknown } | undefined)?.kind;

  if (executionKind !== 'builtin' && executionKind !== 'provider') {
    return {
      cause: 'provider-profile-invalid',
      message: `Stage ${patchTab.id} execution profile is invalid.`,
    };
  }

  if (
    execution.kind === 'provider' &&
    ![
      execution.providerId,
      execution.providerRevision,
      execution.taskId,
      execution.modelId,
      execution.modelRevision,
    ].every(isNonEmptyTrimmedString)
  ) {
    return {
      cause: 'provider-profile-invalid',
      message: `Stage ${patchTab.id} Provider identity is invalid.`,
    };
  }

  if (patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3) {
    if (
      execution.kind !== 'provider' ||
      execution.providerId !== STABLE_AUDIO_3_PROVIDER_ID ||
      execution.providerRevision !==
        STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION ||
      execution.taskId !== STABLE_AUDIO_3_TASK_ID ||
      execution.modelId !== STABLE_AUDIO_3_MODEL_ID ||
      execution.modelRevision !== STABLE_AUDIO_3_MODEL_REVISION ||
      resourceInputs.length !== 0
    ) {
      return {
        cause: 'stable-audio-3-provider-mismatch',
        message:
          'Stable Audio 3 requires the exact promoted local Provider, model revision, task, and an empty resource-input set.',
      };
    }

    return undefined;
  }

  if (patchTab.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.instrument) {
    return undefined;
  }

  const soundFont = resourceInputs.find(
    (resourceInput) => resourceInput.portId === 'soundfont-in',
  );

  if (
    execution.kind !== 'provider' ||
    execution.providerId !== FLUIDSYNTH_INSTRUMENT_PROVIDER_ID ||
    execution.providerRevision !==
      FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION ||
    execution.taskId !== INSTRUMENT_RENDER_TASK_ID ||
    !soundFont ||
    execution.modelId !== soundFont.resourceId ||
    execution.modelRevision !== soundFont.revision
  ) {
    return {
      cause: 'instrument-provider-mismatch',
      message:
        'MIDI TO AUDIO requires the verified local FluidSynth Provider and matching SoundFont model identity.',
    };
  }

  return undefined;
}

function acceptsSoundFont(port: SnapshotInputPort): boolean {
  return port.accepts.some(
    (accepted) =>
      accepted.id === PATCH_DATA_TYPES.soundFont.id &&
      accepted.major === PATCH_DATA_TYPES.soundFont.major,
  );
}

function isValidResourceInput(
  resourceInput: TabFlowStageResourceInput,
): boolean {
  return (
    isNonEmptyTrimmedString(resourceInput.portId) &&
    isNonEmptyTrimmedString(resourceInput.resourceId) &&
    isNonEmptyTrimmedString(resourceInput.revision) &&
    typeof resourceInput.selections === 'object' &&
    resourceInput.selections !== null &&
    !Array.isArray(resourceInput.selections) &&
    Object.values(resourceInput.selections).every((value) =>
      typeof value === 'string'
        ? isNonEmptyTrimmedString(value)
        : Number.isFinite(value),
    )
  );
}

function cloneResourceInput(
  resourceInput: TabFlowStageResourceInput,
): TabFlowStageResourceInput {
  return {
    portId: resourceInput.portId,
    resourceId: resourceInput.resourceId,
    revision: resourceInput.revision,
    selections: { ...resourceInput.selections },
  };
}

function cloneExecutionProfile(
  execution: AutoPatchStageExecutionProfile,
): AutoPatchStageExecutionProfile {
  return execution.kind === 'builtin'
    ? { kind: 'builtin' }
    : { ...execution };
}

function findDuplicateId(ids: readonly string[]): string | undefined {
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) {
      return id;
    }

    seen.add(id);
  }

  return undefined;
}

function failure(
  reason: Extract<
    AutoPatchRuntimeProfileValidationResolution,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): AutoPatchRuntimeProfileValidationResolution {
  return freezeDeep({ cause, message, ok: false, reason });
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value
  );
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => {
      freezeDeep(child);
    });
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
}
