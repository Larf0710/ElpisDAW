import {
  resolveActiveMidiTake,
  type ActiveMidiTakePlan,
} from './activeMidiTake';
import type { AutoPatchRuntimeStageDispatch } from './autoPatchRuntimeCoordinator';
import { normalizeMidiNotes } from './humToMidiContract';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
} from './patchTabPortContract';
import type {
  MidiNote,
  PatchTabParameter,
  ProjectState,
  TabFlowStageResultScope,
} from './types';

export const AUTO_PATCH_MIDI_EDIT_STAGE_ADAPTER_ID =
  'builtin-midi-edit-v1' as const;
export const AUTO_PATCH_MIDI_EDIT_EDITOR_ID =
  'auto-patch-midi-edit' as const;
export const AUTO_PATCH_MIDI_EDIT_EDITOR_VERSION = '1' as const;

export type AutoPatchMidiEditStagePlan = Readonly<{
  adapterId: typeof AUTO_PATCH_MIDI_EDIT_STAGE_ADAPTER_ID;
  attemptId: string;
  fingerprint: string;
  kind: 'builtin-midi-edit';
  parameters: readonly DeepReadonly<PatchTabParameter>[];
  runId: string;
  scope: TabFlowStageResultScope;
  source: ActiveMidiTakePlan;
  startedAt: string;
}>;

export type AutoPatchMidiEditStagePlanResolution =
  | Readonly<{
      canPlan: true;
      plan: AutoPatchMidiEditStagePlan;
    }>
  | Readonly<{
      canPlan: false;
      cause: string;
      message: string;
      reason:
        | 'dispatch-invalid'
        | 'edited-input-protected'
        | 'source-midi-mismatch'
        | 'source-midi-unavailable'
        | 'stage-type-invalid';
    }>;

export type AutoPatchMidiEditProcessorOutcome = Readonly<{
  adapterId: typeof AUTO_PATCH_MIDI_EDIT_STAGE_ADAPTER_ID;
  attemptId: string;
  fingerprint: string;
  finishedAt: string;
  notes: readonly MidiNote[];
  runId: string;
  scope: TabFlowStageResultScope;
  status: 'MIDI_EDIT_COMPLETED';
}>;

export function createAutoPatchMidiEditStagePlan(
  dispatch: AutoPatchRuntimeStageDispatch,
  project: ProjectState,
): AutoPatchMidiEditStagePlanResolution {
  if (dispatch.node.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit) {
    return failure(
      'stage-type-invalid',
      'midi-edit-stage-type-invalid',
      'Automatic MIDI Edit planning requires one built-in MIDI Edit Stage.',
    );
  }

  const definition = getBuiltinPatchTabDefinitions().find(
    (candidate) =>
      candidate.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
  );
  const artifactInput = dispatch.artifactInputs[0];

  if (
    !definition ||
    dispatch.node.nodeVersion !== definition.nodeVersion ||
    dispatch.node.patchTabId !== dispatch.scope.stageId ||
    dispatch.execution.kind !== 'builtin' ||
    dispatch.resourceInputs.length !== 0 ||
    dispatch.artifactInputs.length !== 1 ||
    artifactInput?.portId !== 'midi-in' ||
    artifactInput.artifactIds.length !== 1 ||
    artifactInput.clipTakeIds.length !== 1 ||
    !artifactInput.midi
  ) {
    return failure(
      'dispatch-invalid',
      'midi-edit-dispatch-invalid',
      'MIDI Edit dispatch does not match the built-in Stage contract.',
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
      `MIDI Edit Stage source is unavailable: ${source.message}`,
    );
  }

  if (source.plan.source.sourceType === 'edit') {
    return failure(
      'edited-input-protected',
      'automatic-midi-edit-reapplication-blocked',
      'Automatic MIDI Edit cannot run against an Active Edited MIDI Take. Execution must resume at the next downstream Stage.',
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
      'MIDI Edit dispatch no longer matches the exact Active MIDI Artifact and Take.',
    );
  }

  return freezeDeep({
    canPlan: true as const,
    plan: {
      adapterId: AUTO_PATCH_MIDI_EDIT_STAGE_ADAPTER_ID,
      attemptId: dispatch.attemptId,
      fingerprint: dispatch.fingerprint,
      kind: 'builtin-midi-edit' as const,
      parameters: dispatch.node.parameters.map(cloneParameter),
      runId: dispatch.runId,
      scope: { ...dispatch.scope },
      source: {
        midi: {
          ...source.plan.midi,
          notes: source.plan.midi.notes.map((note) => ({ ...note })),
        },
        source: { ...source.plan.source },
      },
      startedAt: dispatch.startedAt,
    },
  });
}

export function createAutoPatchMidiEditProcessorOutcome(
  plan: AutoPatchMidiEditStagePlan,
  input: Readonly<{
    finishedAt: string;
    notes: readonly MidiNote[];
  }>,
): AutoPatchMidiEditProcessorOutcome {
  const finishedAt = normalizeTimestamp(input.finishedAt);

  if (
    !finishedAt ||
    Date.parse(finishedAt) < Date.parse(plan.startedAt)
  ) {
    throw new Error(
      'Automatic MIDI Edit completion timestamp is invalid.',
    );
  }

  return freezeDeep({
    adapterId: plan.adapterId,
    attemptId: plan.attemptId,
    fingerprint: plan.fingerprint,
    finishedAt,
    notes: normalizeMidiNotes(input.notes),
    runId: plan.runId,
    scope: { ...plan.scope },
    status: 'MIDI_EDIT_COMPLETED' as const,
  });
}

function cloneParameter(
  parameter: DeepReadonly<PatchTabParameter>,
): PatchTabParameter {
  return parameter.kind === 'select'
    ? { ...parameter, options: [...parameter.options] }
    : { ...parameter };
}

function failure(
  reason: Extract<
    AutoPatchMidiEditStagePlanResolution,
    { canPlan: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchMidiEditStagePlanResolution,
  { canPlan: false }
> {
  return Object.freeze({ canPlan: false, cause, message, reason });
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
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
