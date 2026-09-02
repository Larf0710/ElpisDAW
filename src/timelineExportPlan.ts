import {
  TIMELINE_EXPORT_AUDIO_FORMAT,
  TIMELINE_EXPORT_MIDI_FORMAT,
  TIMELINE_EXPORT_PLAN_VERSION,
  TIMELINE_EXPORT_TICKS_PER_QUARTER,
} from '../shared/timelineExportProtocol.js';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { resolveActiveMidiTake } from './activeMidiTake';
import { getEffectiveAudioClipDurationSeconds, timelineTicksToSeconds } from './audioClipTiming';
import { doesClipSupportTakeMedia } from './clipTakeActivation';
import type { LocalEngineGeneratedAudioDescriptor } from './localEngineClient';
import type {
  Clip,
  MidiNote,
  ProjectState,
  SelectionItem,
  SelectionState,
  Track,
} from './types';

export type TimelineExportFailureReason =
  | 'project-invalid'
  | 'selection-invalid'
  | 'target-ambiguous'
  | 'target-empty'
  | 'target-mixed-media'
  | 'target-stale'
  | 'target-unsupported';

export type TimelineExportTarget = Readonly<{
  id: string;
  kind: 'clip' | 'track';
  name: string;
}>;

export type TimelineExportSourceLineage = Readonly<{
  artifactId: string;
  clipId: string;
  clipTakeId: string;
}>;

export type TimelineExportAudioSource = Readonly<
  LocalEngineGeneratedAudioDescriptor
>;

export type TimelineExportAudioEvent = Readonly<{
  clipId: string;
  durationSeconds: number;
  sourceId: string;
  sourceStartSeconds: number;
  startOffsetSeconds: number;
}>;

export type TimelineExportMidiSource = Readonly<{
  artifactId: string;
  clipId: string;
  clipTakeId: string;
  contentHash: string;
}>;

export type TimelineExportMidiNote = Readonly<
  Pick<MidiNote, 'lengthTicks' | 'pitch' | 'startTick' | 'velocity'> & {
    sourceClipId: string;
    sourceNoteId: string;
  }
>;

type TimelineExportPlanBase = Readonly<{
  bpm: number;
  durationTicks: number;
  endTick: number;
  fileName: string;
  originTick: number;
  purpose: 'timeline-export';
  target: TimelineExportTarget;
  ticksPerQuarter: typeof TIMELINE_EXPORT_TICKS_PER_QUARTER;
  version: typeof TIMELINE_EXPORT_PLAN_VERSION;
}>;

export type TimelineExportAudioPlan = TimelineExportPlanBase &
  Readonly<{
    durationSeconds: number;
    events: readonly TimelineExportAudioEvent[];
    format: typeof TIMELINE_EXPORT_AUDIO_FORMAT;
    mediaType: 'audio';
    sourceLineage: readonly TimelineExportSourceLineage[];
    sources: readonly TimelineExportAudioSource[];
  }>;

export type TimelineExportMidiPlan = TimelineExportPlanBase &
  Readonly<{
    format: typeof TIMELINE_EXPORT_MIDI_FORMAT;
    mediaType: 'midi';
    notes: readonly TimelineExportMidiNote[];
    sourceLineage: readonly TimelineExportSourceLineage[];
    sources: readonly TimelineExportMidiSource[];
  }>;

export type TimelineExportPlan =
  | TimelineExportAudioPlan
  | TimelineExportMidiPlan;

export type TimelineExportPlanResolution =
  | Readonly<{ canExport: true; plan: TimelineExportPlan }>
  | Readonly<{
      canExport: false;
      message: string;
      reason: TimelineExportFailureReason;
    }>;

type ClipLocation = Readonly<{ clip: Clip; track: Track }>;

const AUDIO_TRACK_TYPES = new Set<Track['type']>([
  'audio',
  'bass',
  'chord',
  'drum',
  'fx',
  'generated_audio',
  'melody',
  'vocal',
]);

export function createTimelineExportPlan(
  project: ProjectState,
  selection: SelectionState = project.selection,
): TimelineExportPlanResolution {
  const projectIssue = validateProject(project);

  if (projectIssue) {
    return fail('project-invalid', projectIssue);
  }

  const selectedItem = resolveExactSelection(selection);

  if (!selectedItem) {
    return fail(
      'selection-invalid',
      'Timeline EXPORT requires exactly one selected Clip or Track.',
    );
  }

  return selectedItem.type === 'clip'
    ? createClipPlan(project, selectedItem)
    : createTrackPlan(project, selectedItem);
}

export function createCanonicalTimelineExportPlanJson(
  plan: TimelineExportPlan,
): string | undefined {
  try {
    const canonical = JSON.stringify(plan);
    return canonical && !canonical.includes('undefined') ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function createClipPlan(
  project: ProjectState,
  selectedItem: SelectionItem & { type: 'clip' },
): TimelineExportPlanResolution {
  const matches = findClipLocations(project, selectedItem.id);

  if (matches.length !== 1) {
    return fail(
      'target-ambiguous',
      `Selected Clip does not resolve uniquely: ${selectedItem.id}.`,
    );
  }

  const location = matches[0];

  if (location.track.group) {
    return fail('target-unsupported', 'Group Tracks cannot contain Timeline EXPORT Clips.');
  }

  if (doesClipSupportTakeMedia(location.clip, 'audio')) {
    return createAudioPlan(project, [location], {
      endTick: location.clip.startTick + location.clip.lengthTicks,
      originTick: location.clip.startTick,
      target: createTarget(location.clip, 'clip'),
    });
  }

  if (doesClipSupportTakeMedia(location.clip, 'midi')) {
    return createMidiPlan(project, [location], {
      endTick: location.clip.startTick + location.clip.lengthTicks,
      originTick: location.clip.startTick,
      target: createTarget(location.clip, 'clip'),
    });
  }

  return fail(
    'target-unsupported',
    `${location.clip.name} is not an exportable Audio or MIDI Clip.`,
  );
}

function createTrackPlan(
  project: ProjectState,
  selectedItem: SelectionItem & { type: 'track' },
): TimelineExportPlanResolution {
  const matches = project.tracks.filter((track) => track.id === selectedItem.id);

  if (matches.length !== 1) {
    return fail(
      'target-ambiguous',
      `Selected Track does not resolve uniquely: ${selectedItem.id}.`,
    );
  }

  const track = matches[0];

  if (track.group || track.type === 'master') {
    return fail(
      'target-unsupported',
      'Timeline EXPORT accepts one direct Audio or MIDI Track, not a Group or Master.',
    );
  }

  if (track.clips.length === 0) {
    return fail('target-empty', `${track.name} does not contain exportable Clips.`);
  }

  const locations = track.clips.map((clip) => ({ clip, track }));
  const target = createTarget(track, 'track');
  const endTick = Math.max(
    ...track.clips.map((clip) => clip.startTick + clip.lengthTicks),
  );

  if (track.type === 'midi') {
    if (track.clips.some((clip) => !doesClipSupportTakeMedia(clip, 'midi'))) {
      return fail(
        'target-mixed-media',
        `${track.name} contains non-MIDI Clips and cannot be exported implicitly.`,
      );
    }

    return createMidiPlan(project, locations, { endTick, originTick: 0, target });
  }

  if (AUDIO_TRACK_TYPES.has(track.type)) {
    if (track.clips.some((clip) => !doesClipSupportTakeMedia(clip, 'audio'))) {
      return fail(
        'target-mixed-media',
        `${track.name} contains non-Audio Clips and cannot be exported implicitly.`,
      );
    }

    return createAudioPlan(project, locations, { endTick, originTick: 0, target });
  }

  return fail(
    'target-unsupported',
    `${track.name} is not a direct Audio or MIDI Track.`,
  );
}

function createAudioPlan(
  project: ProjectState,
  locations: readonly ClipLocation[],
  placement: Readonly<{
    endTick: number;
    originTick: number;
    target: TimelineExportTarget;
  }>,
): TimelineExportPlanResolution {
  const placementIssue = validatePlacement(project, locations, placement);

  if (placementIssue) {
    return fail('target-stale', placementIssue);
  }

  const descriptorBySourceId = new Map<string, TimelineExportAudioSource>();
  const events: TimelineExportAudioEvent[] = [];
  const sourceLineage: TimelineExportSourceLineage[] = [];

  for (const { clip } of locations) {
    const resolution = resolveActiveAudioTakeSource(project, clip.id);

    if (!resolution.canResolve || resolution.plan.clip.lengthTicks !== clip.lengthTicks) {
      return fail(
        'target-stale',
        resolution.canResolve
          ? `${clip.name} timing no longer matches its Active Audio Take.`
          : resolution.message,
      );
    }

    const descriptor = snapshotDescriptor(resolution.plan.descriptor);
    const durationSeconds = getEffectiveAudioClipDurationSeconds(
      resolution.plan.clip.audioTiming,
      clip.lengthTicks,
      project.bpm,
    );
    const availableDurationSeconds =
      resolution.plan.clip.audioTiming.sourceEndSeconds -
      resolution.plan.clip.audioTiming.sourceStartSeconds;

    if (
      !descriptor ||
      durationSeconds > availableDurationSeconds + 1 / TIMELINE_EXPORT_AUDIO_FORMAT.sampleRate
    ) {
      return fail(
        'target-stale',
        `${clip.name} does not resolve to one complete effective Audio segment.`,
      );
    }

    const currentDescriptor = descriptorBySourceId.get(descriptor.sourceId);

    if (
      currentDescriptor &&
      JSON.stringify(currentDescriptor) !== JSON.stringify(descriptor)
    ) {
      return fail('target-ambiguous', `${clip.name} source identity collides.`);
    }

    descriptorBySourceId.set(descriptor.sourceId, descriptor);
    sourceLineage.push(Object.freeze({ ...resolution.plan.source }));
    events.push(
      Object.freeze({
        clipId: clip.id,
        durationSeconds,
        sourceId: descriptor.sourceId,
        sourceStartSeconds:
          resolution.plan.clip.audioTiming.sourceStartSeconds,
        startOffsetSeconds: timelineTicksToSeconds(
          clip.startTick - placement.originTick,
          project.bpm,
        ),
      }),
    );
  }

  const durationTicks = placement.endTick - placement.originTick;
  const plan = freezeRecursively({
    bpm: project.bpm,
    durationSeconds: Math.max(...events.map((event) =>
      event.startOffsetSeconds + event.durationSeconds,
    )),
    durationTicks,
    endTick: placement.endTick,
    events,
    fileName: createDownloadFileName(
      project.name,
      placement.target.name,
      '.wav',
    ),
    format: { ...TIMELINE_EXPORT_AUDIO_FORMAT },
    mediaType: 'audio' as const,
    originTick: placement.originTick,
    purpose: 'timeline-export' as const,
    sourceLineage,
    sources: [...descriptorBySourceId.values()],
    target: placement.target,
    ticksPerQuarter: TIMELINE_EXPORT_TICKS_PER_QUARTER,
    version: TIMELINE_EXPORT_PLAN_VERSION,
  }) as TimelineExportAudioPlan;

  return Object.freeze({ canExport: true as const, plan });
}

function createMidiPlan(
  project: ProjectState,
  locations: readonly ClipLocation[],
  placement: Readonly<{
    endTick: number;
    originTick: number;
    target: TimelineExportTarget;
  }>,
): TimelineExportPlanResolution {
  const placementIssue = validatePlacement(project, locations, placement);

  if (placementIssue) {
    return fail('target-stale', placementIssue);
  }

  const notes: TimelineExportMidiNote[] = [];
  const sources: TimelineExportMidiSource[] = [];

  for (const { clip } of locations) {
    const resolution = resolveActiveMidiTake(project, clip.id);

    if (!resolution.canResolve) {
      return fail('target-stale', resolution.message);
    }

    for (const note of resolution.plan.midi.notes) {
      if (
        !Number.isSafeInteger(note.startTick + note.lengthTicks) ||
        note.startTick + note.lengthTicks > clip.lengthTicks
      ) {
        return fail(
          'target-stale',
          `${clip.name} contains MIDI outside its Clip span.`,
        );
      }

      notes.push(
        Object.freeze({
          lengthTicks: note.lengthTicks,
          pitch: note.pitch,
          sourceClipId: clip.id,
          sourceNoteId: note.id,
          startTick: clip.startTick - placement.originTick + note.startTick,
          velocity: note.velocity,
        }),
      );
    }

    sources.push(
      Object.freeze({
        artifactId: resolution.plan.source.artifactId,
        clipId: clip.id,
        clipTakeId: resolution.plan.source.clipTakeId,
        contentHash: resolution.plan.source.contentHash,
      }),
    );
  }

  if (notes.length === 0) {
    return fail(
      'target-empty',
      `${placement.target.name} does not contain exportable MIDI Notes.`,
    );
  }

  const sourceLineage = sources.map(({ artifactId, clipId, clipTakeId }) =>
    Object.freeze({ artifactId, clipId, clipTakeId }),
  );
  const durationTicks = placement.endTick - placement.originTick;
  const plan = freezeRecursively({
    bpm: project.bpm,
    durationTicks,
    endTick: placement.endTick,
    fileName: createDownloadFileName(
      project.name,
      placement.target.name,
      '.mid',
    ),
    format: { ...TIMELINE_EXPORT_MIDI_FORMAT },
    mediaType: 'midi' as const,
    notes,
    originTick: placement.originTick,
    purpose: 'timeline-export' as const,
    sourceLineage,
    sources,
    target: placement.target,
    ticksPerQuarter: TIMELINE_EXPORT_TICKS_PER_QUARTER,
    version: TIMELINE_EXPORT_PLAN_VERSION,
  }) as TimelineExportMidiPlan;

  return Object.freeze({ canExport: true as const, plan });
}

function resolveExactSelection(
  selection: SelectionState,
): SelectionItem | undefined {
  if (!selection || selection.items.length !== 1) {
    return undefined;
  }

  const item = selection.items[0];

  if (
    !isTrimmedText(item.id) ||
    (item.type !== 'clip' && item.type !== 'track') ||
    !doesOptionalSelectionItemMatch(selection.anchorItem, item) ||
    !doesOptionalSelectionItemMatch(selection.lastSelectedItem, item)
  ) {
    return undefined;
  }

  return item;
}

function doesOptionalSelectionItemMatch(
  candidate: SelectionItem | null | undefined,
  selected: SelectionItem,
): boolean {
  return (
    candidate === undefined ||
    candidate === null ||
    (candidate.type === selected.type && candidate.id === selected.id)
  );
}

function findClipLocations(
  project: ProjectState,
  clipId: string,
): ClipLocation[] {
  return project.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => clip.id === clipId)
      .map((clip) => ({ clip, track })),
  );
}

function validateProject(project: ProjectState): string | undefined {
  if (
    !Number.isFinite(project.bpm) ||
    project.bpm <= 0 ||
    !Number.isSafeInteger(project.totalTicks) ||
    project.totalTicks <= 0 ||
    !Array.isArray(project.tracks)
  ) {
    return 'Timeline EXPORT Project timing is invalid.';
  }

  const trackIds = project.tracks.map((track) => track.id);
  return trackIds.some((trackId) => !isTrimmedText(trackId)) ||
    new Set(trackIds).size !== trackIds.length
    ? 'Timeline EXPORT Project Track identity is ambiguous.'
    : undefined;
}

function validatePlacement(
  project: ProjectState,
  locations: readonly ClipLocation[],
  placement: Readonly<{ endTick: number; originTick: number }>,
): string | undefined {
  if (
    locations.length === 0 ||
    !Number.isSafeInteger(placement.originTick) ||
    placement.originTick < 0 ||
    !Number.isSafeInteger(placement.endTick) ||
    placement.endTick <= placement.originTick ||
    placement.endTick > project.totalTicks
  ) {
    return 'Timeline EXPORT target span is invalid.';
  }

  for (const { clip } of locations) {
    if (
      !isTrimmedText(clip.id) ||
      !Number.isSafeInteger(clip.startTick) ||
      clip.startTick < placement.originTick ||
      !Number.isSafeInteger(clip.lengthTicks) ||
      clip.lengthTicks <= 0 ||
      !Number.isSafeInteger(clip.startTick + clip.lengthTicks) ||
      clip.startTick + clip.lengthTicks > placement.endTick
    ) {
      return `${clip.name} has invalid Timeline placement.`;
    }
  }

  const clipIds = locations.map(({ clip }) => clip.id);
  return new Set(clipIds).size !== clipIds.length
    ? 'Timeline EXPORT Clip identity is ambiguous.'
    : undefined;
}

function snapshotDescriptor(
  descriptor: LocalEngineGeneratedAudioDescriptor,
): TimelineExportAudioSource | undefined {
  if (
    descriptor.kind !== 'generated' ||
    !isTrimmedText(descriptor.sourceId) ||
    descriptor.name !== `${descriptor.sourceId}.wav` ||
    !isSafeRelativePath(descriptor.relativePath, descriptor.name) ||
    !Number.isSafeInteger(descriptor.sizeBytes) ||
    descriptor.sizeBytes <= 44
  ) {
    return undefined;
  }

  return Object.freeze({
    kind: 'generated' as const,
    name: descriptor.name,
    relativePath: descriptor.relativePath,
    sizeBytes: descriptor.sizeBytes,
    sourceId: descriptor.sourceId,
  });
}

function isSafeRelativePath(value: string, fileName: string): boolean {
  if (!isTrimmedText(value) || value.includes('\\')) {
    return false;
  }
  const segments = value.split('/');
  return (
    segments.length >= 2 &&
    segments[segments.length - 1] === fileName &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes(':'),
    )
  );
}

function createTarget(
  value: Pick<Clip | Track, 'id' | 'name'>,
  kind: TimelineExportTarget['kind'],
): TimelineExportTarget {
  return Object.freeze({ id: value.id, kind, name: value.name });
}

function createDownloadFileName(
  projectName: string,
  targetName: string,
  extension: '.mid' | '.wav',
): string {
  return `${sanitizeFileNamePart(projectName)}-${sanitizeFileNamePart(targetName)}${extension}`;
}

function sanitizeFileNamePart(value: string): string {
  const sanitized = String(value)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 72);
  const safeName = sanitized || 'ElpisDAW';

  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(safeName)
    ? `${safeName}-file`
    : safeName;
}

function isTrimmedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    value.length <= 256
  );
}

function freezeRecursively<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(freezeRecursively);
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeRecursively);
  }
  return Object.freeze(value);
}

function fail(
  reason: TimelineExportFailureReason,
  message: string,
): TimelineExportPlanResolution {
  return Object.freeze({ canExport: false as const, message, reason });
}
