import type {
  LocalEngineSourceDescriptor,
} from './localEngineClient';
import {
  RAW_MIXDOWN_PLAN_VERSION,
  RAW_MIXDOWN_WAVE_FORMAT,
} from '../shared/rawMixdownProtocol.js';
import { MIXER_EFFECTS_CONTRACT_VERSION } from '../shared/mixerEffectsContract.js';
import { MIXER_DSP_CONTRACT_VERSION_V2 } from '../shared/mixerDspContract.js';
import { MIXER_METER_TAP_CONTRACT_VERSION } from '../shared/mixerMeterTapContract.js';
import { GENERATED_AUDIO_PROJECT_DIRECTORIES } from './generatedAudioDescriptor';
import {
  createProjectPlaybackPlan,
  type ProjectPlaybackPlanFailureReason,
  type ProjectPlaybackPlanInput,
} from './projectPlaybackPlan';
import {
  createProjectPlaybackSchedule,
  type ProjectPlaybackTrackSchedule,
} from './projectPlaybackRuntime';
import {
  PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2,
  assertProjectMixerRenderSnapshotV2,
  type ProjectMixerRenderSnapshotV2,
} from './projectMixerRenderSnapshot';

export { RAW_MIXDOWN_WAVE_FORMAT };

export type ProjectMixdownSourceDescriptor =
  | Readonly<{
      kind: 'generated';
      name: string;
      relativePath: string;
      sizeBytes: number;
      sourceId: string;
    }>
  | Readonly<{
      kind: 'external';
      lastModified: number;
      name: string;
      path: string;
      sizeBytes: number;
      sourceId: string;
    }>;

export type ProjectMixdownPlan = Readonly<{
  bpm: number;
  durationSeconds: number;
  endTick: number;
  effectsContractVersion: typeof MIXER_EFFECTS_CONTRACT_VERSION;
  format: typeof RAW_MIXDOWN_WAVE_FORMAT;
  masterFaderDb: number;
  meterTapVersion: typeof MIXER_METER_TAP_CONTRACT_VERSION;
  mixerDspVersion: typeof MIXER_DSP_CONTRACT_VERSION_V2;
  mixerSnapshot: ProjectMixerRenderSnapshotV2;
  mixerSnapshotVersion: typeof PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2;
  purpose: 'mixdown';
  sources: readonly ProjectMixdownSourceDescriptor[];
  startTick: 0;
  tracks: readonly ProjectPlaybackTrackSchedule[];
  version: typeof RAW_MIXDOWN_PLAN_VERSION;
}>;

export type ProjectMixdownPlanInput = Omit<
  ProjectPlaybackPlanInput,
  'purpose'
> &
  Readonly<{
    sourceDescriptors: readonly LocalEngineSourceDescriptor[];
  }>;

export type ProjectMixdownPlanAvailability =
  | Readonly<{
      canCreate: true;
      mixerSnapshot: ProjectMixerRenderSnapshotV2;
      plan: ProjectMixdownPlan;
    }>
  | Readonly<{
      canCreate: false;
      cause?: ProjectPlaybackPlanFailureReason;
      message: string;
      reason:
        | 'playback-plan-unavailable'
        | 'schedule-unavailable'
        | 'source-descriptor-invalid';
    }>;

export function createProjectMixdownPlan(
  input: ProjectMixdownPlanInput,
): ProjectMixdownPlanAvailability {
  const playbackPlanning = createProjectPlaybackPlan({
    ...input,
    purpose: 'mixdown',
  });

  if (!playbackPlanning.canPlay) {
    return fail(
      'playback-plan-unavailable',
      playbackPlanning.message,
      playbackPlanning.reason,
    );
  }

  const scheduling = createProjectPlaybackSchedule(
    playbackPlanning.plan,
    input.bpm,
  );

  if (!scheduling.canSchedule) {
    return fail('schedule-unavailable', scheduling.message);
  }

  const mixerSnapshot = playbackPlanning.plan.mixerSnapshot;

  try {
    assertProjectMixerRenderSnapshotV2(mixerSnapshot);
  } catch {
    return fail(
      'schedule-unavailable',
      'Mixdown blocked: the Mixer Render Snapshot v2 is invalid.',
    );
  }

  const requiredSourceIds = collectRequiredProjectRenderSourceIds(
    scheduling.schedule.tracks,
  );
  const sourceSnapshot = createExactProjectRenderSourceSnapshot(
    requiredSourceIds,
    input.sourceDescriptors,
  );

  if (!sourceSnapshot) {
    return fail(
      'source-descriptor-invalid',
      'Mixdown blocked: required source descriptors are missing, duplicated, unexpected, or incomplete.',
    );
  }

  return Object.freeze({
    canCreate: true as const,
    mixerSnapshot,
    plan: Object.freeze({
      bpm: input.bpm,
      durationSeconds: scheduling.schedule.durationSeconds,
      endTick: scheduling.schedule.endTick,
      effectsContractVersion: MIXER_EFFECTS_CONTRACT_VERSION,
      format: RAW_MIXDOWN_WAVE_FORMAT,
      masterFaderDb: scheduling.schedule.masterFaderDb,
      meterTapVersion: MIXER_METER_TAP_CONTRACT_VERSION,
      mixerDspVersion: MIXER_DSP_CONTRACT_VERSION_V2,
      mixerSnapshot,
      mixerSnapshotVersion: PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2,
      purpose: 'mixdown' as const,
      sources: sourceSnapshot,
      startTick: 0 as const,
      tracks: snapshotProjectRenderTracks(scheduling.schedule.tracks),
      version: RAW_MIXDOWN_PLAN_VERSION,
    }),
  });
}

export function collectRequiredProjectRenderSourceIds(
  tracks: readonly ProjectPlaybackTrackSchedule[],
): readonly string[] {
  const sourceIds: string[] = [];
  const seenSourceIds = new Set<string>();

  for (const track of tracks) {
    for (const event of track.events) {
      if (!seenSourceIds.has(event.sourceId)) {
        seenSourceIds.add(event.sourceId);
        sourceIds.push(event.sourceId);
      }
    }
  }

  return Object.freeze(sourceIds);
}

export function createExactProjectRenderSourceSnapshot(
  requiredSourceIds: readonly string[],
  descriptors: readonly LocalEngineSourceDescriptor[],
): readonly ProjectMixdownSourceDescriptor[] | undefined {
  if (descriptors.length !== requiredSourceIds.length) {
    return undefined;
  }

  const descriptorsById = new Map<string, ProjectMixdownSourceDescriptor>();

  for (const descriptor of descriptors) {
    const snapshot = snapshotSourceDescriptor(descriptor);

    if (!snapshot || descriptorsById.has(snapshot.sourceId)) {
      return undefined;
    }

    descriptorsById.set(snapshot.sourceId, snapshot);
  }

  const sources = requiredSourceIds.map((sourceId) =>
    descriptorsById.get(sourceId),
  );

  return sources.every(
    (source): source is ProjectMixdownSourceDescriptor => source !== undefined,
  )
    ? Object.freeze(sources)
    : undefined;
}

function snapshotSourceDescriptor(
  descriptor: LocalEngineSourceDescriptor,
): ProjectMixdownSourceDescriptor | undefined {
  if (
    !isTrimmedText(descriptor.sourceId) ||
    !isTrimmedText(descriptor.name) ||
    !Number.isSafeInteger(descriptor.sizeBytes) ||
    (descriptor.sizeBytes as number) <= 44
  ) {
    return undefined;
  }

  if (descriptor.kind === 'generated') {
    if (
      descriptor.name !== `${descriptor.sourceId}.wav` ||
      !isGeneratedAudioPath(
        descriptor.relativePath,
        descriptor.name,
      )
    ) {
      return undefined;
    }

    return Object.freeze({
      kind: 'generated' as const,
      name: descriptor.name,
      relativePath: descriptor.relativePath,
      sizeBytes: descriptor.sizeBytes as number,
      sourceId: descriptor.sourceId,
    });
  }

  if (
    !isAbsoluteWindowsPath(descriptor.path) ||
    !Number.isSafeInteger(descriptor.lastModified) ||
    (descriptor.lastModified as number) < 0
  ) {
    return undefined;
  }

  return Object.freeze({
    kind: 'external' as const,
    lastModified: descriptor.lastModified as number,
    name: descriptor.name,
    path: descriptor.path,
    sizeBytes: descriptor.sizeBytes as number,
    sourceId: descriptor.sourceId,
  });
}

function isGeneratedAudioPath(relativePath: string, fileName: string): boolean {
  if (
    !isTrimmedText(relativePath) ||
    relativePath.includes('\\') ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    return false;
  }

  const segments = relativePath.split('/');

  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':'),
    ) ||
    segments[segments.length - 1] !== fileName ||
    relativePath.toLowerCase().endsWith('.partial') ||
    !relativePath.endsWith('.wav')
  ) {
    return false;
  }

  return GENERATED_AUDIO_PROJECT_DIRECTORIES.some(
    (directory) =>
      relativePath.startsWith(`${directory}/`) &&
      relativePath.length > directory.length + 1,
  );
}

function isAbsoluteWindowsPath(path: string): boolean {
  return (
    isTrimmedText(path) &&
    (/^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path))
  );
}

function isTrimmedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value
  );
}

export function snapshotProjectRenderTracks(
  tracks: readonly ProjectPlaybackTrackSchedule[],
): readonly ProjectPlaybackTrackSchedule[] {
  return Object.freeze(
    tracks.map((track) =>
      Object.freeze({
        events: Object.freeze(
          track.events.map((event) => Object.freeze({ ...event })),
        ),
        gainDb: track.gainDb,
        ...(track.groupTrackId
          ? { groupTrackId: track.groupTrackId }
          : {}),
        pan: track.pan,
        trackId: track.trackId,
      }),
    ),
  );
}

function fail(
  reason: Extract<
    ProjectMixdownPlanAvailability,
    { canCreate: false }
  >['reason'],
  message: string,
  cause?: ProjectPlaybackPlanFailureReason,
): Extract<ProjectMixdownPlanAvailability, { canCreate: false }> {
  return Object.freeze({
    canCreate: false as const,
    ...(cause ? { cause } : {}),
    message,
    reason,
  });
}
