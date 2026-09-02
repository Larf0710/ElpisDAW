import {
  PRINT_MIX_NORMALIZE_TARGET_DBFS,
  PRINT_MIX_PLAN_VERSION,
  PRINT_MIX_WAVE_FORMAT,
  isPrintMixOperationId,
} from '../shared/printMixProtocol.js';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { resolveActiveMidiTake } from './activeMidiTake';
import { timelineTicksToSeconds } from './audioClipTiming';
import { normalizeMidiNotes } from './humToMidiContract';
import type { LocalEngineGeneratedAudioDescriptor } from './localEngineClient';
import {
  isPrintMixPatchTab,
  resolvePrintMixNormalize,
} from './printMixPatchTab';
import type {
  Clip,
  MidiNote,
  ProjectState,
  SelectionState,
  Track,
} from './types';
import { TICKS_PER_QUARTER } from './workflow';

export type PrintMixPlanFailureReason =
  | 'clip-placement-invalid'
  | 'clip-source-invalid'
  | 'clip-type-unsupported'
  | 'mixed-media-selection'
  | 'operation-invalid'
  | 'patch-tab-invalid'
  | 'selection-invalid'
  | 'selection-too-small';

export type PrintMixAudioSource = Readonly<{
  kind: 'generated';
  name: string;
  relativePath: string;
  sizeBytes: number;
  sourceId: string;
}>;

export type PrintMixSourceLineage = Readonly<{
  artifactId: string;
  clipId: string;
  clipTakeId: string;
}>;

export type PrintMixAudioEvent = Readonly<{
  clipId: string;
  durationSeconds: number;
  sourceId: string;
  sourceStartSeconds: number;
  startOffsetSeconds: number;
}>;

type PrintMixPlanBase = Readonly<{
  bpm: number;
  durationSeconds: number;
  durationTicks: number;
  endTick: number;
  operationId: string;
  patchTabId: string;
  purpose: 'print-mix';
  selectedClipIds: readonly string[];
  sourceLineage: readonly PrintMixSourceLineage[];
  startTick: number;
  ticksPerQuarter: typeof TICKS_PER_QUARTER;
  version: typeof PRINT_MIX_PLAN_VERSION;
}>;

export type PrintMixAudioPlan = PrintMixPlanBase &
  Readonly<{
    events: readonly PrintMixAudioEvent[];
    format: typeof PRINT_MIX_WAVE_FORMAT;
    mediaType: 'audio';
    normalize: boolean;
    sources: readonly PrintMixAudioSource[];
    targetPeakDbfs: typeof PRINT_MIX_NORMALIZE_TARGET_DBFS;
  }>;

export type PrintMixMidiSource = PrintMixSourceLineage &
  Readonly<{
    contentHash: string;
    label: string;
    revision: number;
    sourceType: 'edit' | 'job' | 'manual' | 'print-mix';
  }>;

export type PrintMixMidiPlan = PrintMixPlanBase &
  Readonly<{
    mediaType: 'midi';
    notes: readonly MidiNote[];
    sources: readonly PrintMixMidiSource[];
  }>;

export type PrintMixPlan = PrintMixAudioPlan | PrintMixMidiPlan;

export type PrintMixPlanResolution =
  | Readonly<{ canCreate: true; plan: PrintMixPlan }>
  | Readonly<{
      canCreate: false;
      message: string;
      reason: PrintMixPlanFailureReason;
    }>;

type SelectedClip = Readonly<{
  clip: Clip;
  track: Track;
}>;

const MIDI_CLIP_TYPES = new Set<Clip['type']>([
  'edited-midi',
  'midi-notes',
]);

export function createPrintMixPlan(
  project: ProjectState,
  patchTabId: string,
  selection: SelectionState,
  operationId: string,
): PrintMixPlanResolution {
  if (!isPrintMixOperationId(operationId)) {
    return fail('operation-invalid', 'PRINT MIX operation identity is invalid.');
  }

  const patchTabs = project.patchTabs.filter(
    (patchTab) => patchTab.id === patchTabId,
  );

  if (patchTabs.length !== 1 || !isPrintMixPatchTab(patchTabs[0])) {
    return fail(
      'patch-tab-invalid',
      'PRINT MIX requires one exact versioned PatchTab contract.',
    );
  }

  if (!Array.isArray(selection.items)) {
    return fail('selection-invalid', 'PRINT MIX selection is invalid.');
  }

  if (selection.items.length < 2) {
    return fail(
      'selection-too-small',
      'PRINT MIX requires at least two selected Clips.',
    );
  }

  if (selection.items.some((item) => item.type !== 'clip')) {
    return fail(
      'selection-invalid',
      'PRINT MIX accepts Clip selections only.',
    );
  }

  const selectedClipIds = selection.items.map((item) => item.id);

  if (
    selectedClipIds.some((clipId) => !isTrimmedText(clipId)) ||
    new Set(selectedClipIds).size !== selectedClipIds.length
  ) {
    return fail(
      'selection-invalid',
      'PRINT MIX selected Clip identities must be unique.',
    );
  }

  const selectedClips: SelectedClip[] = [];

  for (const clipId of selectedClipIds) {
    const matches = project.tracks.flatMap((track) =>
      track.clips
        .filter((clip) => clip.id === clipId)
        .map((clip) => ({ clip, track })),
    );

    if (matches.length !== 1) {
      return fail(
        'selection-invalid',
        `PRINT MIX Clip does not resolve uniquely: ${clipId}.`,
      );
    }

    selectedClips.push(matches[0]);
  }

  selectedClips.sort(
    (left, right) =>
      left.clip.startTick - right.clip.startTick ||
      left.clip.id.localeCompare(right.clip.id),
  );

  const placement = resolvePlacement(project, selectedClips);

  if (!placement) {
    return fail(
      'clip-placement-invalid',
      'PRINT MIX selected Clip placement is invalid or outside the Project.',
    );
  }

  const mediaTypes = new Set(
    selectedClips.map(({ clip }) => getPrintMixClipMediaType(clip)),
  );

  if (mediaTypes.has(undefined)) {
    return fail(
      'clip-type-unsupported',
      'PRINT MIX selection contains an unsupported Clip type.',
    );
  }

  if (mediaTypes.size !== 1) {
    return fail(
      'mixed-media-selection',
      'PRINT MIX requires all selected Clips to use the same media type.',
    );
  }

  const base = {
    bpm: project.bpm,
    durationSeconds: timelineTicksToSeconds(
      placement.durationTicks,
      project.bpm,
    ),
    durationTicks: placement.durationTicks,
    endTick: placement.endTick,
    operationId,
    patchTabId,
    purpose: 'print-mix' as const,
    selectedClipIds: selectedClips.map(({ clip }) => clip.id),
    startTick: placement.startTick,
    ticksPerQuarter: TICKS_PER_QUARTER as typeof TICKS_PER_QUARTER,
    version: PRINT_MIX_PLAN_VERSION,
  };

  return mediaTypes.has('midi')
    ? createMidiPlan(project, selectedClips, base)
    : createAudioPlan(project, patchTabs[0], selectedClips, base);
}

export function createCanonicalPrintMixPlanJson(
  plan: PrintMixPlan,
): string | undefined {
  if (!isDeeplyFrozen(plan)) {
    return undefined;
  }

  try {
    const canonical = JSON.stringify(plan);
    return canonical && !canonical.includes('undefined') ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function createAudioPlan(
  project: ProjectState,
  patchTab: ProjectState['patchTabs'][number],
  selectedClips: readonly SelectedClip[],
  base: Omit<PrintMixAudioPlan, 'events' | 'format' | 'mediaType' | 'normalize' | 'sourceLineage' | 'sources' | 'targetPeakDbfs'>,
): PrintMixPlanResolution {
  const normalize = resolvePrintMixNormalize(patchTab);

  if (normalize === undefined) {
    return fail(
      'patch-tab-invalid',
      'Audio PRINT MIX requires one exact Normalize setting.',
    );
  }

  const descriptorsById = new Map<string, PrintMixAudioSource>();
  const events: PrintMixAudioEvent[] = [];
  const sourceLineage: PrintMixSourceLineage[] = [];

  for (const { clip } of selectedClips) {
    const resolution = resolveActiveAudioTakeSource(project, clip.id);

    if (!resolution.canResolve) {
      return fail(
        'clip-source-invalid',
        `PRINT MIX source is unavailable: ${resolution.message}`,
      );
    }

    const descriptor = snapshotGeneratedDescriptor(resolution.plan.descriptor);
    const sourceDurationSeconds =
      resolution.plan.clip.audioTiming.sourceEndSeconds -
      resolution.plan.clip.audioTiming.sourceStartSeconds;
    const timelineDurationSeconds = timelineTicksToSeconds(
      clip.lengthTicks,
      project.bpm,
    );
    const durationSeconds = Math.min(
      timelineDurationSeconds,
      sourceDurationSeconds,
    );

    if (!descriptor || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return fail(
        'clip-source-invalid',
        `${clip.name} does not have one valid finalized WAV source.`,
      );
    }

    const existingDescriptor = descriptorsById.get(descriptor.sourceId);

    if (
      existingDescriptor &&
      JSON.stringify(existingDescriptor) !== JSON.stringify(descriptor)
    ) {
      return fail(
        'clip-source-invalid',
        `${clip.name} source identity is ambiguous.`,
      );
    }

    descriptorsById.set(descriptor.sourceId, descriptor);
    sourceLineage.push(
      Object.freeze({ ...resolution.plan.source }),
    );
    events.push(
      Object.freeze({
        clipId: clip.id,
        durationSeconds,
        sourceId: descriptor.sourceId,
        sourceStartSeconds:
          resolution.plan.clip.audioTiming.sourceStartSeconds,
        startOffsetSeconds: timelineTicksToSeconds(
          clip.startTick - base.startTick,
          project.bpm,
        ),
      }),
    );
  }

  const plan = freezeRecursively({
    ...base,
    events,
    format: { ...PRINT_MIX_WAVE_FORMAT },
    mediaType: 'audio' as const,
    normalize,
    sourceLineage,
    sources: [...descriptorsById.values()],
    targetPeakDbfs: PRINT_MIX_NORMALIZE_TARGET_DBFS,
  }) as PrintMixAudioPlan;

  return Object.freeze({ canCreate: true as const, plan });
}

function createMidiPlan(
  project: ProjectState,
  selectedClips: readonly SelectedClip[],
  base: Omit<PrintMixMidiPlan, 'mediaType' | 'notes' | 'sourceLineage' | 'sources'>,
): PrintMixPlanResolution {
  const notes: MidiNote[] = [];
  const sources: PrintMixMidiSource[] = [];

  for (const [sourceIndex, { clip }] of selectedClips.entries()) {
    const resolution = resolveActiveMidiTake(project, clip.id);

    if (!resolution.canResolve) {
      return fail(
        'clip-source-invalid',
        `PRINT MIX source is unavailable: ${resolution.message}`,
      );
    }

    const clipOffset = clip.startTick - base.startTick;

    for (const [noteIndex, note] of resolution.plan.midi.notes.entries()) {
      if (
        !Number.isSafeInteger(note.startTick + note.lengthTicks) ||
        note.startTick + note.lengthTicks > clip.lengthTicks
      ) {
        return fail(
          'clip-source-invalid',
          `${clip.name} contains MIDI outside its selected Clip span.`,
        );
      }

      notes.push({
        id: `print-mix-note-${sourceIndex + 1}-${noteIndex + 1}`,
        lengthTicks: note.lengthTicks,
        pitch: note.pitch,
        startTick: clipOffset + note.startTick,
        velocity: note.velocity,
      });
    }

    sources.push(
      Object.freeze({
        ...resolution.plan.source,
        contentHash: resolution.plan.source.contentHash,
      }),
    );
  }

  let normalizedNotes: MidiNote[];

  try {
    normalizedNotes = normalizeMidiNotes(notes);
  } catch {
    return fail(
      'clip-source-invalid',
      'PRINT MIX merged MIDI notes cannot be represented safely.',
    );
  }

  const sourceLineage = sources.map(({ artifactId, clipId, clipTakeId }) =>
    Object.freeze({ artifactId, clipId, clipTakeId }),
  );
  const plan = freezeRecursively({
    ...base,
    mediaType: 'midi' as const,
    notes: normalizedNotes,
    sourceLineage,
    sources,
  }) as PrintMixMidiPlan;

  return Object.freeze({ canCreate: true as const, plan });
}

function resolvePlacement(
  project: ProjectState,
  selectedClips: readonly SelectedClip[],
): Readonly<{ durationTicks: number; endTick: number; startTick: number }> | undefined {
  if (
    !Number.isFinite(project.bpm) ||
    project.bpm <= 0 ||
    !Number.isSafeInteger(project.totalTicks) ||
    project.totalTicks <= 0 ||
    selectedClips.some(
      ({ clip }) =>
        !Number.isSafeInteger(clip.startTick) ||
        clip.startTick < 0 ||
        !Number.isSafeInteger(clip.lengthTicks) ||
        clip.lengthTicks <= 0 ||
        !Number.isSafeInteger(clip.startTick + clip.lengthTicks) ||
        clip.startTick + clip.lengthTicks > project.totalTicks,
    )
  ) {
    return undefined;
  }

  const startTick = Math.min(
    ...selectedClips.map(({ clip }) => clip.startTick),
  );
  const endTick = Math.max(
    ...selectedClips.map(({ clip }) => clip.startTick + clip.lengthTicks),
  );
  const durationTicks = endTick - startTick;

  return durationTicks > 0
    ? Object.freeze({ durationTicks, endTick, startTick })
    : undefined;
}

export function getPrintMixClipMediaType(
  clip: Pick<Clip, 'type'>,
): 'audio' | 'midi' | undefined {
  if (MIDI_CLIP_TYPES.has(clip.type)) {
    return 'midi';
  }

  return [
    'ai-fill-audio',
    'arrangement',
    'hum-audio',
    'instrument-audio',
    'master',
    'mixdown',
    'vocal-audio',
  ].includes(clip.type)
    ? 'audio'
    : undefined;
}

function snapshotGeneratedDescriptor(
  descriptor: LocalEngineGeneratedAudioDescriptor,
): PrintMixAudioSource | undefined {
  return descriptor.kind === 'generated' &&
    isTrimmedText(descriptor.sourceId) &&
    descriptor.name === `${descriptor.sourceId}.wav` &&
    isTrimmedText(descriptor.relativePath) &&
    Number.isSafeInteger(descriptor.sizeBytes) &&
    descriptor.sizeBytes > 44
    ? Object.freeze({ ...descriptor })
    : undefined;
}

function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
}

function isTrimmedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function freezeRecursively<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(freezeRecursively);
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeRecursively);
  }
  return typeof value === 'object' && value !== null ? Object.freeze(value) : value;
}

function fail(
  reason: PrintMixPlanFailureReason,
  message: string,
): PrintMixPlanResolution {
  return Object.freeze({ canCreate: false as const, message, reason });
}
