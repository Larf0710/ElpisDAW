import { MIXER_EFFECTS_CONTRACT_VERSION } from '../shared/mixerEffectsContract.js';
import { MIXER_DSP_CONTRACT_VERSION_V2 } from '../shared/mixerDspContract.js';
import { MIXER_METER_TAP_CONTRACT_VERSION } from '../shared/mixerMeterTapContract.js';
import { RAW_MIXDOWN_WAVE_FORMAT } from '../shared/rawMixdownProtocol.js';
import {
  PROJECT_STEM_PRINT_PLAN_VERSION,
  PROJECT_STEM_PRINT_PURPOSE,
} from '../shared/projectStemPrintProtocol.js';
import type { LocalEngineSourceDescriptor } from './localEngineClient';
import { isGroupTrack, resolveGroupPlaybackTrack } from './playbackTarget';
import {
  collectRequiredProjectRenderSourceIds,
  createExactProjectRenderSourceSnapshot,
  snapshotProjectRenderTracks,
  type ProjectMixdownSourceDescriptor,
} from './projectMixdownPlan';
import {
  createProjectExplicitMixdownPlaybackPlan,
  type ProjectExplicitMixdownTrackReference,
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
import type { Track } from './types';

export {
  PROJECT_STEM_PRINT_PLAN_VERSION,
  PROJECT_STEM_PRINT_PURPOSE,
};

export type ProjectStemPrintTarget =
  | Readonly<{
      kind: 'channel';
      trackId: string;
    }>
  | Readonly<{
      groupTrackId: string;
      kind: 'group';
    }>;

export type ProjectStemPrintTargetSnapshot =
  | Readonly<{
      kind: 'channel';
      resolvedTrackId: string;
      trackId: string;
    }>
  | Readonly<{
      groupTrackId: string;
      kind: 'group';
      resolvedTrackId: string;
    }>;

export type ProjectStemPrintSourceDescriptor = ProjectMixdownSourceDescriptor;

export type ProjectStemPrintPlan = Readonly<{
  audibleRange: Readonly<{
    endTick: number;
    startTick: number;
  }>;
  bpm: number;
  durationSeconds: number;
  effectsContractVersion: typeof MIXER_EFFECTS_CONTRACT_VERSION;
  endTick: number;
  format: typeof RAW_MIXDOWN_WAVE_FORMAT;
  masterFaderDb: number;
  meterTapVersion: typeof MIXER_METER_TAP_CONTRACT_VERSION;
  mixerDspVersion: typeof MIXER_DSP_CONTRACT_VERSION_V2;
  mixerSnapshot: ProjectMixerRenderSnapshotV2;
  mixerSnapshotVersion: typeof PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2;
  purpose: typeof PROJECT_STEM_PRINT_PURPOSE;
  selectedTargets: readonly ProjectStemPrintTargetSnapshot[];
  sources: readonly ProjectStemPrintSourceDescriptor[];
  startTick: 0;
  tracks: readonly ProjectPlaybackTrackSchedule[];
  version: typeof PROJECT_STEM_PRINT_PLAN_VERSION;
}>;

export type ProjectStemPrintPlanInput = Omit<
  ProjectPlaybackPlanInput,
  'purpose' | 'selection'
> &
  Readonly<{
    sourceDescriptors: readonly LocalEngineSourceDescriptor[];
    targets: readonly ProjectStemPrintTarget[];
  }>;

export type ProjectStemPrintPlanAvailability =
  | Readonly<{
      canCreate: true;
      mixerSnapshot: ProjectMixerRenderSnapshotV2;
      plan: ProjectStemPrintPlan;
    }>
  | Readonly<{
      canCreate: false;
      cause?: ProjectPlaybackPlanFailureReason;
      message: string;
      reason:
        | 'group-unresolved'
        | 'playback-plan-unavailable'
        | 'schedule-unavailable'
        | 'source-descriptor-invalid'
        | 'target-duplicate'
        | 'target-invalid'
        | 'target-kind-unsupported'
        | 'target-not-found'
        | 'target-selection-required';
    }>;

export type ResolvedProjectStemPrintTargets = Readonly<{
  references: readonly ProjectExplicitMixdownTrackReference[];
  snapshots: readonly ProjectStemPrintTargetSnapshot[];
}>;

type StemPrintTargetResolution =
  | Readonly<{
      canCreate: true;
      value: ResolvedProjectStemPrintTargets;
    }>
  | Extract<ProjectStemPrintPlanAvailability, { canCreate: false }>;

export function createProjectStemPrintPlan(
  input: ProjectStemPrintPlanInput,
): ProjectStemPrintPlanAvailability {
  const targetResolution = resolveProjectStemPrintTargets(
    input.targets,
    input.tracks,
  );

  if (!targetResolution.canCreate) {
    return targetResolution;
  }

  const playbackPlanning = createProjectExplicitMixdownPlaybackPlan({
    artifacts: input.artifacts,
    bpm: input.bpm,
    mixer: input.mixer,
    playheadTick: input.playheadTick,
    projectEndTick: input.projectEndTick,
    sourceAvailability: input.sourceAvailability,
    targetReferences: targetResolution.value.references,
    tracks: input.tracks,
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
      'Stem Print blocked: the Mixer Render Snapshot v2 is invalid.',
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
      'Stem Print blocked: required source descriptors are missing, duplicated, unexpected, or incomplete.',
    );
  }

  const plan = Object.freeze({
    audibleRange: Object.freeze({
      endTick: playbackPlanning.plan.audibleRange.endTick,
      startTick: playbackPlanning.plan.audibleRange.startTick,
    }),
    bpm: input.bpm,
    durationSeconds: scheduling.schedule.durationSeconds,
    effectsContractVersion: MIXER_EFFECTS_CONTRACT_VERSION,
    endTick: scheduling.schedule.endTick,
    format: RAW_MIXDOWN_WAVE_FORMAT,
    masterFaderDb: scheduling.schedule.masterFaderDb,
    meterTapVersion: MIXER_METER_TAP_CONTRACT_VERSION,
    mixerDspVersion: MIXER_DSP_CONTRACT_VERSION_V2,
    mixerSnapshot,
    mixerSnapshotVersion: PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2,
    purpose: PROJECT_STEM_PRINT_PURPOSE,
    selectedTargets: targetResolution.value.snapshots,
    sources: sourceSnapshot,
    startTick: 0 as const,
    tracks: snapshotProjectRenderTracks(scheduling.schedule.tracks),
    version: PROJECT_STEM_PRINT_PLAN_VERSION,
  });

  return Object.freeze({
    canCreate: true as const,
    mixerSnapshot,
    plan,
  });
}

export function resolveProjectStemPrintTargets(
  targets: readonly ProjectStemPrintTarget[],
  tracks: readonly Track[],
): StemPrintTargetResolution {
  if (!Array.isArray(targets) || targets.length === 0) {
    return fail(
      'target-selection-required',
      'Stem Print blocked: select at least one Mixer Channel or Group.',
    );
  }

  const trackMap = new Map(tracks.map((track) => [track.id, track]));

  if (trackMap.size !== tracks.length) {
    return fail(
      'target-invalid',
      'Stem Print blocked: the Project Track identity state is invalid.',
    );
  }

  const seenSelectedTargets = new Set<string>();
  const seenResolvedTrackIds = new Set<string>();
  const snapshots: ProjectStemPrintTargetSnapshot[] = [];

  for (const target of targets) {
    if (!isRecord(target) || !isTrimmedText(target.kind)) {
      return fail(
        'target-invalid',
        'Stem Print blocked: a selected target is invalid.',
      );
    }

    if (target.kind === 'channel') {
      if (
        !hasExactKeys(target, ['kind', 'trackId']) ||
        !isTrimmedText(target.trackId)
      ) {
        return fail(
          'target-invalid',
          'Stem Print blocked: a selected Mixer Channel target is invalid.',
        );
      }

      const selectedKey = `channel:${target.trackId}`;

      if (seenSelectedTargets.has(selectedKey)) {
        return fail(
          'target-duplicate',
          'Stem Print blocked: a Mixer target was selected more than once.',
        );
      }

      const track = trackMap.get(target.trackId);

      if (!track) {
        return fail(
          'target-not-found',
          `Stem Print blocked: Mixer Channel ${target.trackId} no longer exists.`,
        );
      }

      if (isGroupTrack(track)) {
        return fail(
          'target-invalid',
          `Stem Print blocked: ${target.trackId} is a Group, not a Mixer Channel.`,
        );
      }

      if (seenResolvedTrackIds.has(track.id)) {
        return fail(
          'target-duplicate',
          'Stem Print blocked: multiple selected targets resolve to the same Mixer Channel.',
        );
      }

      seenSelectedTargets.add(selectedKey);
      seenResolvedTrackIds.add(track.id);
      snapshots.push(Object.freeze({
        kind: 'channel' as const,
        resolvedTrackId: track.id,
        trackId: target.trackId,
      }));
      continue;
    }

    if (target.kind === 'group') {
      if (
        !hasExactKeys(target, ['groupTrackId', 'kind']) ||
        !isTrimmedText(target.groupTrackId)
      ) {
        return fail(
          'target-invalid',
          'Stem Print blocked: a selected Group target is invalid.',
        );
      }

      const selectedKey = `group:${target.groupTrackId}`;

      if (seenSelectedTargets.has(selectedKey)) {
        return fail(
          'target-duplicate',
          'Stem Print blocked: a Mixer target was selected more than once.',
        );
      }

      const groupTrack = trackMap.get(target.groupTrackId);

      if (!groupTrack) {
        return fail(
          'target-not-found',
          `Stem Print blocked: Group ${target.groupTrackId} no longer exists.`,
        );
      }

      const resolution = resolveGroupPlaybackTrack(groupTrack, tracks);

      if (!resolution.canResolve) {
        return fail('group-unresolved', resolution.message);
      }

      if (seenResolvedTrackIds.has(resolution.activeTrack.id)) {
        return fail(
          'target-duplicate',
          'Stem Print blocked: multiple selected targets resolve to the same Mixer Channel.',
        );
      }

      seenSelectedTargets.add(selectedKey);
      seenResolvedTrackIds.add(resolution.activeTrack.id);
      snapshots.push(Object.freeze({
        groupTrackId: target.groupTrackId,
        kind: 'group' as const,
        resolvedTrackId: resolution.activeTrack.id,
      }));
      continue;
    }

    return fail(
      'target-kind-unsupported',
      'Stem Print blocked: only Mixer Channel and Group targets are supported.',
    );
  }

  return Object.freeze({
    canCreate: true as const,
    value: Object.freeze({
      references: Object.freeze(
        snapshots.map((target) => Object.freeze({
          ...(target.kind === 'group'
            ? { groupTrackId: target.groupTrackId }
            : {}),
          trackId: target.resolvedTrackId,
        })),
      ),
      snapshots: Object.freeze(snapshots),
    }),
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTrimmedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value
  );
}

function fail(
  reason: Extract<
    ProjectStemPrintPlanAvailability,
    { canCreate: false }
  >['reason'],
  message: string,
  cause?: ProjectPlaybackPlanFailureReason,
): Extract<ProjectStemPrintPlanAvailability, { canCreate: false }> {
  return Object.freeze({
    canCreate: false as const,
    ...(cause ? { cause } : {}),
    message,
    reason,
  });
}
