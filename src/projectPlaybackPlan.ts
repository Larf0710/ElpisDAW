import { getEffectiveAudioClipDurationSeconds, timelineTicksToSeconds } from './audioClipTiming';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { isSourceBackedAudioClip, type SourceBackedAudioClip } from './audioClipSource';
import { doesClipSupportTakeMedia } from './clipTakeActivation';
import type { LocalEngineGeneratedAudioDescriptor } from './localEngineClient';
import type { MidiClipPlaybackSourceSnapshot } from './midiClipPlaybackCache';
import {
  createProjectMixerRenderSnapshotV2,
  type MixerRenderChannelSnapshotV1,
  type MixerRenderChannelSnapshotV2,
  type ProjectMixerRenderSnapshot,
  type ProjectMixerRenderSnapshotV2,
} from './projectMixerRenderSnapshot';
import {
  isGroupTrack,
  resolveGroupPlaybackTrack,
  resolvePlaybackTarget,
  type PlaybackTarget,
  type PlaybackTargetLockReason,
} from './playbackTarget';
import type {
  Clip,
  ClipSourceFileStatus,
  ProjectArtifact,
  ProjectMixerState,
  SelectionState,
  Track,
} from './types';

export type RenderPurpose = 'all-playback' | 'selection-playback' | 'mixdown';

export type RuntimeSourceAvailabilityState = 'openable' | 'unopenable' | 'unknown';

export type SourceAvailabilitySnapshot = Readonly<Record<string, RuntimeSourceAvailabilityState>>;

export type PlaybackSourceIssueReason =
  | 'active-take-unresolved'
  | 'midi-playback-unavailable'
  | 'metadata-missing'
  | 'metadata-moved'
  | 'metadata-unresolved'
  | 'runtime-unknown'
  | 'runtime-unopenable'
  | 'source-id-missing';

export type PlaybackSourceIssue = Readonly<{
  clipIds: readonly string[];
  fileName: string;
  key: string;
  reason: PlaybackSourceIssueReason;
  sourceId?: string;
}>;

export type ResolvedPlaybackClip = Readonly<{
  clipId: string;
  clipName: string;
  originalClipEndTick: number;
  originalClipStartTick: number;
  sourceEndSeconds: number;
  sourceId: string;
  sourceStartSeconds: number;
  timelineEndTick: number;
  timelineStartTick: number;
}>;

export type ResolvedPlaybackTrack = Readonly<{
  clips: readonly ResolvedPlaybackClip[];
  gainDb: number;
  groupTrackId?: string;
  pan: number;
  trackId: string;
  trackMuted: boolean;
}>;

export type ProjectMixerPlanningSnapshot = Readonly<{
  channels: readonly (
    | MixerRenderChannelSnapshotV1
    | MixerRenderChannelSnapshotV2
  )[];
  master:
    | ProjectMixerRenderSnapshot['master']
    | ProjectMixerRenderSnapshotV2['master'];
  schemaVersion:
    | ProjectMixerRenderSnapshot['schemaVersion']
    | ProjectMixerRenderSnapshotV2['schemaVersion'];
}>;

export type ProjectPlaybackPlan = Readonly<{
  audibleRange: Readonly<{
    endTick: number;
    startTick: number;
  }>;
  endTick: number;
  generatedSources: readonly LocalEngineGeneratedAudioDescriptor[];
  isIncomplete: boolean;
  missingSourceCount: number;
  mixerSnapshot: ProjectMixerPlanningSnapshot;
  purpose: RenderPurpose;
  sourceIssues: readonly PlaybackSourceIssue[];
  startTick: number;
  target: PlaybackTarget;
  tracks: readonly ResolvedPlaybackTrack[];
}>;

export type ProjectPlaybackPlanInput = {
  artifacts?: readonly ProjectArtifact[];
  bpm: number;
  mixer?: ProjectMixerState;
  midiPlaybackSources?: MidiClipPlaybackSourceSnapshot;
  playheadTick: number;
  projectEndTick: number;
  purpose: RenderPurpose;
  selection: SelectionState;
  sourceAvailability: SourceAvailabilitySnapshot;
  tracks: readonly Track[];
};

export type ProjectExplicitMixdownTrackReference = Readonly<{
  groupTrackId?: string;
  trackId: string;
}>;

export type ProjectExplicitMixdownPlaybackPlanInput = Omit<
  ProjectPlaybackPlanInput,
  'purpose' | 'selection'
> &
  Readonly<{
    targetReferences: readonly ProjectExplicitMixdownTrackReference[];
  }>;

export type ProjectPlaybackPlanFailureReason =
  | 'group-unresolved'
  | 'invalid-project-timing'
  | 'mixer-state-invalid'
  | 'no-playable-material'
  | 'selection-required'
  | 'source-unavailable'
  | 'target-locked'
  | 'target-unplayable';

export type ProjectPlaybackPlanAvailability =
  | { canPlay: true; plan: ProjectPlaybackPlan }
  | {
      canPlay: false;
      message: string;
      reason: ProjectPlaybackPlanFailureReason;
      sourceIssues: PlaybackSourceIssue[];
      targetLockReason?: PlaybackTargetLockReason;
    };

type TargetTrackReference = {
  groupTrackId?: string;
  track: Track;
};

type TargetTrackResolution =
  | { canResolve: true; references: TargetTrackReference[] }
  | { canResolve: false; message: string };

type ClipSourceResolution =
  | {
      canResolve: true;
      clip: SourceBackedAudioClip;
      generatedSource?: LocalEngineGeneratedAudioDescriptor;
      sourceId: string;
    }
  | { canResolve: false; issue: PlaybackSourceIssue };

type AvailableTargetTrack = TargetTrackReference & {
  clips: Array<{
    clip: SourceBackedAudioClip;
    sourceId: string;
  }>;
  mixerChannel: MixerRenderChannelSnapshotV1 | MixerRenderChannelSnapshotV2;
};

type MutablePlaybackSourceIssue = Omit<PlaybackSourceIssue, 'clipIds'> & {
  clipIds: string[];
};

const emptySelection: SelectionState = { items: [] };

export function createProjectPlaybackPlan(
  input: ProjectPlaybackPlanInput,
): ProjectPlaybackPlanAvailability {
  return createProjectPlaybackPlanInternal(input);
}

export function createProjectExplicitMixdownPlaybackPlan(
  input: ProjectExplicitMixdownPlaybackPlanInput,
): ProjectPlaybackPlanAvailability {
  const targetTrackResolution = resolveExplicitMixdownTrackReferences(
    input.targetReferences,
    input.tracks,
  );

  if (!targetTrackResolution.canResolve) {
    return createFailure('group-unresolved', targetTrackResolution.message);
  }

  const trackIds = targetTrackResolution.references.map(
    (reference) => reference.track.id,
  );
  const target: PlaybackTarget = trackIds.length === 1
    ? { kind: 'track', trackId: trackIds[0] }
    : { kind: 'tracks', trackIds };

  return createProjectPlaybackPlanInternal(
    {
      ...input,
      purpose: 'mixdown',
      selection: emptySelection,
    },
    {
      target,
      targetTrackResolution,
    },
  );
}

type ProjectPlaybackPlanTargetOverride = Readonly<{
  target: PlaybackTarget;
  targetTrackResolution: TargetTrackResolution;
}>;

function createProjectPlaybackPlanInternal(
  input: ProjectPlaybackPlanInput,
  targetOverride?: ProjectPlaybackPlanTargetOverride,
): ProjectPlaybackPlanAvailability {
  if (
    !Number.isFinite(input.bpm) ||
    input.bpm <= 0 ||
    !Number.isFinite(input.playheadTick) ||
    !Number.isFinite(input.projectEndTick) ||
    input.projectEndTick <= 0
  ) {
    return createFailure(
      'invalid-project-timing',
      'Playback locked: the Project timing data is invalid.',
    );
  }

  let mixerSnapshot: ProjectMixerRenderSnapshot | ProjectMixerRenderSnapshotV2;

  try {
    mixerSnapshot = createProjectMixerRenderSnapshotV2({
      mixer: input.mixer,
      tracks: input.tracks,
    });
  } catch {
    const action = input.purpose === 'mixdown' ? 'Mixdown blocked' : 'Playback locked';
    return createFailure(
      'mixer-state-invalid',
      `${action}: the Project Mixer state is invalid.`,
    );
  }

  const targetResolution = targetOverride
    ? { canTarget: true as const, target: targetOverride.target }
    : resolvePlaybackTarget(
        input.tracks,
        input.purpose === 'selection-playback' ? input.selection : emptySelection,
      );

  if (!targetResolution.canTarget) {
    return {
      canPlay: false,
      message: targetResolution.message,
      reason: 'target-locked',
      sourceIssues: [],
      targetLockReason: targetResolution.reason,
    };
  }

  const { target } = targetResolution;

  if (input.purpose === 'selection-playback' && target.kind === 'all') {
    return createFailure(
      'selection-required',
      'Playback locked: select one Clip, Track, or Group target.',
    );
  }

  const targetTrackResolution = targetOverride?.targetTrackResolution ??
    resolveTargetTrackReferences(target, input.tracks);

  if (!targetTrackResolution.canResolve) {
    return createFailure('group-unresolved', targetTrackResolution.message);
  }

  const sourceIssueMap = new Map<string, MutablePlaybackSourceIssue>();
  const generatedSourceMap = new Map<
    string,
    LocalEngineGeneratedAudioDescriptor
  >();
  const availableTracks: AvailableTargetTrack[] = [];
  let explicitlyUnplayableTargetCount = 0;
  const respectMixerAudibility = input.purpose !== 'selection-playback';
  const mixerChannelByTrackId = new Map(
    mixerSnapshot.channels.map((channel) => [channel.trackId, channel]),
  );
  const targetChannels = targetTrackResolution.references.map((reference) =>
    mixerChannelByTrackId.get(reference.track.id),
  );

  if (targetChannels.some((channel) => channel === undefined)) {
    const action = input.purpose === 'mixdown' ? 'Mixdown blocked' : 'Playback locked';
    return createFailure(
      'mixer-state-invalid',
      `${action}: a target Track has no Mixer Channel.`,
    );
  }

  const hasSoloChannel = respectMixerAudibility && (
    targetOverride
      ? mixerSnapshot.channels.some((channel) => channel.solo)
      : targetChannels.some((channel) => channel?.solo === true)
  );

  for (const reference of targetTrackResolution.references) {
    const mixerChannel = mixerChannelByTrackId.get(reference.track.id)!;

    if (
      respectMixerAudibility &&
      (mixerChannel.muted || (hasSoloChannel && !mixerChannel.solo))
    ) {
      continue;
    }

    const requestedClips = getRequestedTrackClips(
      target,
      reference.track,
      input.midiPlaybackSources,
    );

    if (requestedClips.length === 0) {
      if (input.purpose === 'selection-playback') {
        explicitlyUnplayableTargetCount += 1;
      }
      continue;
    }

    const availableClips: AvailableTargetTrack['clips'] = [];

    for (const clip of requestedClips) {
      const resolution = resolveClipSource(
        {
          artifacts: input.artifacts,
          bpm: input.bpm,
          tracks: input.tracks,
        },
        clip,
        input.sourceAvailability,
        input.midiPlaybackSources,
      );

      if (!resolution.canResolve) {
        addSourceIssue(sourceIssueMap, resolution.issue);
        continue;
      }

      if (resolution.generatedSource) {
        generatedSourceMap.set(
          resolution.generatedSource.sourceId,
          resolution.generatedSource,
        );
      }

      availableClips.push({
        clip: resolution.clip,
        sourceId: resolution.sourceId,
      });
    }

    if (availableClips.length > 0) {
      availableTracks.push({
        ...reference,
        clips: availableClips,
        mixerChannel,
      });
    }
  }

  const sourceIssues: PlaybackSourceIssue[] = [...sourceIssueMap.values()].map((issue) => ({
    ...issue,
    clipIds: [...issue.clipIds],
  }));

  if (explicitlyUnplayableTargetCount > 0) {
    const targetLabel = explicitlyUnplayableTargetCount === 1 ? 'target has' : 'targets have';
    return createFailure(
      'target-unplayable',
      `Playback locked: ${explicitlyUnplayableTargetCount} selected ${targetLabel} no playable material.`,
      sourceIssues,
    );
  }

  if (input.purpose !== 'all-playback' && sourceIssues.length > 0) {
    const action = input.purpose === 'mixdown' ? 'Mixdown blocked' : 'Playback locked';
    return createFailure(
      'source-unavailable',
      `${action}: ${formatSourceIssueCount(sourceIssues.length)} need relink or source access.`,
      sourceIssues,
    );
  }

  const availableClips = availableTracks.flatMap((track) => track.clips.map(({ clip }) => clip));

  if (availableClips.length === 0) {
    return createFailure(
      'no-playable-material',
      sourceIssues.length > 0
        ? `Playback locked: ${formatSourceIssueCount(sourceIssues.length)} need relink or source access.`
        : 'Playback locked: the target has no playable audio material.',
      sourceIssues,
    );
  }

  const audibleStartTick = Math.min(...availableClips.map((clip) => Math.round(clip.startTick)));
  const audibleEndTick = Math.max(
    ...availableClips.map((clip) => Math.round(clip.startTick) + Math.round(clip.lengthTicks)),
  );
  const projectEndTick = Math.round(input.projectEndTick);
  const normalizedPlayheadTick = clampTick(Math.round(input.playheadTick), 0, projectEndTick);
  const isFullProjectPlan = target.kind === 'all';
  const startTick =
    input.purpose === 'mixdown'
      ? 0
      : isFullProjectPlan
        ? normalizedPlayheadTick >= projectEndTick
          ? 0
          : normalizedPlayheadTick
        : resolveTargetStartTick(normalizedPlayheadTick, audibleStartTick, audibleEndTick);
  const endTick = isFullProjectPlan || targetOverride
    ? projectEndTick
    : audibleEndTick;
  const tracks = availableTracks.flatMap((reference) => {
    const clips = reference.clips.flatMap(({ clip, sourceId }) => {
      const scheduledClip = createResolvedPlaybackClip(
        clip,
        sourceId,
        startTick,
        endTick,
        input.bpm,
      );

      return scheduledClip ? [scheduledClip] : [];
    });

    return clips.length > 0
      ? [
          {
            clips,
            gainDb: reference.mixerChannel.faderDb,
            groupTrackId: reference.groupTrackId,
            pan: reference.mixerChannel.pan,
            trackId: reference.track.id,
            trackMuted: reference.mixerChannel.muted,
          },
        ]
      : [];
  });

  return {
    canPlay: true,
    plan: {
      audibleRange: { endTick: audibleEndTick, startTick: audibleStartTick },
      endTick,
      generatedSources: [...generatedSourceMap.values()],
      isIncomplete: input.purpose === 'all-playback' && sourceIssues.length > 0,
      missingSourceCount: sourceIssues.length,
      mixerSnapshot,
      purpose: input.purpose,
      sourceIssues,
      startTick,
      target,
      tracks,
    },
  };
}

function resolveExplicitMixdownTrackReferences(
  references: readonly ProjectExplicitMixdownTrackReference[],
  tracks: readonly Track[],
): TargetTrackResolution {
  if (!Array.isArray(references) || references.length === 0) {
    return {
      canResolve: false,
      message: 'Stem Print blocked: select at least one Mixer Channel or Group.',
    };
  }

  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  const seenTrackIds = new Set<string>();
  const resolvedReferences: TargetTrackReference[] = [];

  for (const reference of references) {
    if (
      !isRecord(reference) ||
      !hasExactKeys(
        reference,
        reference.groupTrackId === undefined
          ? ['trackId']
          : ['groupTrackId', 'trackId'],
      ) ||
      !isTrimmedText(reference.trackId) ||
      (reference.groupTrackId !== undefined &&
        !isTrimmedText(reference.groupTrackId)) ||
      seenTrackIds.has(reference.trackId)
    ) {
      return {
        canResolve: false,
        message: 'Stem Print blocked: the resolved Mixer target set is invalid or duplicated.',
      };
    }

    const track = trackMap.get(reference.trackId);

    if (!track || isGroupTrack(track)) {
      return {
        canResolve: false,
        message: `Stem Print blocked: Mixer Channel ${reference.trackId} no longer exists.`,
      };
    }

    if (reference.groupTrackId !== undefined) {
      const groupTrack = trackMap.get(reference.groupTrackId);

      if (!groupTrack) {
        return {
          canResolve: false,
          message: `Stem Print blocked: Group ${reference.groupTrackId} no longer exists.`,
        };
      }

      const resolution = resolveGroupPlaybackTrack(groupTrack, tracks);

      if (!resolution.canResolve || resolution.activeTrack.id !== track.id) {
        return {
          canResolve: false,
          message: resolution.canResolve
            ? `Stem Print blocked: Group ${reference.groupTrackId} changed its active Track.`
            : resolution.message,
        };
      }
    }

    seenTrackIds.add(track.id);
    resolvedReferences.push({
      ...(reference.groupTrackId
        ? { groupTrackId: reference.groupTrackId }
        : {}),
      track,
    });
  }

  return { canResolve: true, references: resolvedReferences };
}

function resolveTargetTrackReferences(
  target: PlaybackTarget,
  tracks: readonly Track[],
): TargetTrackResolution {
  const trackMap = new Map(tracks.map((track) => [track.id, track]));

  if (target.kind === 'clip') {
    const track = tracks.find((candidate) => candidate.clips.some((clip) => clip.id === target.clipId));

    return track
      ? { canResolve: true, references: [{ track }] }
      : { canResolve: false, message: `Playback locked: Clip ${target.clipId} no longer exists.` };
  }

  if (target.kind === 'track' || target.kind === 'tracks') {
    const trackIds = target.kind === 'track' ? [target.trackId] : target.trackIds;
    const references = trackIds.flatMap((trackId) => {
      const track = trackMap.get(trackId);
      return track ? [{ track }] : [];
    });

    return references.length === trackIds.length
      ? { canResolve: true, references }
      : { canResolve: false, message: 'Playback locked: one or more selected Tracks no longer exist.' };
  }

  if (target.kind === 'group' || target.kind === 'groups') {
    const groupTrackIds = target.kind === 'group' ? [target.groupTrackId] : target.groupTrackIds;
    const references: TargetTrackReference[] = [];

    for (const groupTrackId of groupTrackIds) {
      const groupTrack = trackMap.get(groupTrackId);

      if (!groupTrack) {
        return { canResolve: false, message: `Playback locked: Group ${groupTrackId} no longer exists.` };
      }

      const resolution = resolveGroupPlaybackTrack(groupTrack, tracks);

      if (!resolution.canResolve) {
        return { canResolve: false, message: resolution.message };
      }

      references.push({ groupTrackId, track: resolution.activeTrack });
    }

    return { canResolve: true, references };
  }

  const references: TargetTrackReference[] = [];

  for (const groupTrack of tracks.filter(
    (track) => isGroupTrack(track) && !track.parentGroupId,
  )) {
    const resolution = resolveGroupPlaybackTrack(groupTrack, tracks);

    if (!resolution.canResolve) {
      return { canResolve: false, message: resolution.message };
    }

    references.push({ groupTrackId: groupTrack.id, track: resolution.activeTrack });
  }

  tracks.forEach((track) => {
    if (!isGroupTrack(track) && !track.parentGroupId) {
      references.push({ track });
    }
  });

  return { canResolve: true, references: deduplicateTrackReferences(references) };
}

function getRequestedTrackClips(
  target: PlaybackTarget,
  track: Track,
  midiPlaybackSources: MidiClipPlaybackSourceSnapshot | undefined,
): Clip[] {
  if (target.kind === 'clip') {
    const clip = track.clips.find((candidate) => candidate.id === target.clipId);
    return clip && isPlaybackSourceCandidate(clip, midiPlaybackSources)
      ? [clip]
      : [];
  }

  return track.clips.filter((clip) =>
    isPlaybackSourceCandidate(clip, midiPlaybackSources),
  );
}

function resolveClipSource(
  project: Readonly<{
    artifacts?: readonly ProjectArtifact[];
    bpm: number;
    tracks: readonly Track[];
  }>,
  clip: Clip,
  sourceAvailability: SourceAvailabilitySnapshot,
  midiPlaybackSources: MidiClipPlaybackSourceSnapshot | undefined,
): ClipSourceResolution {
  const midiPlaybackSource = midiPlaybackSources?.[clip.id];

  if (midiPlaybackSource) {
    if (midiPlaybackSource.status === 'UNAVAILABLE') {
      return {
        canResolve: false,
        issue: {
          clipIds: [clip.id],
          fileName: clip.name,
          key: `midi-cache:${clip.id}`,
          reason: 'midi-playback-unavailable',
        },
      };
    }

    const playableDurationSeconds = timelineTicksToSeconds(
      midiPlaybackSource.lengthTicks,
      project.bpm,
    );
    const playbackClip: SourceBackedAudioClip = {
      ...clip,
      audioTiming: {
        sourceEndSeconds: playableDurationSeconds,
        sourceStartSeconds: 0,
        timeBase: 'absolute-seconds',
      },
      lengthTicks: midiPlaybackSource.lengthTicks,
      sourceFile: {
        durationSeconds: midiPlaybackSource.durationSeconds,
        mimeType: 'audio/wav',
        name: midiPlaybackSource.name,
        sourceId: midiPlaybackSource.sourceId,
        status: 'available',
      },
    };

    return resolveAvailableSource(playbackClip, sourceAvailability);
  }

  if (clip.activeClipTakeId) {
    const activeSource = resolveActiveAudioTakeSource(project, clip.id);

    if (!activeSource.canResolve) {
      return {
        canResolve: false,
        issue: {
          clipIds: [clip.id],
          fileName: clip.name,
          key: `active-take:${clip.id}`,
          reason: 'active-take-unresolved',
        },
      };
    }

    return resolveAvailableSource(
      activeSource.plan.clip,
      sourceAvailability,
      activeSource.plan.descriptor,
    );
  }

  if (!isSourceBackedAudioClip(clip)) {
    return {
      canResolve: false,
      issue: {
        clipIds: [clip.id],
        fileName: clip.name,
        key: `clip:${clip.id}`,
        reason: 'source-id-missing',
      },
    };
  }

  return resolveAvailableSource(clip, sourceAvailability);
}

function resolveAvailableSource(
  clip: SourceBackedAudioClip,
  sourceAvailability: SourceAvailabilitySnapshot,
  generatedSource?: LocalEngineGeneratedAudioDescriptor,
): ClipSourceResolution {
  const sourceId = clip.sourceFile.sourceId?.trim();

  if (!sourceId) {
    return {
      canResolve: false,
      issue: createSourceIssue(clip, `clip:${clip.id}`, 'source-id-missing'),
    };
  }

  if (clip.sourceFile.status !== 'available') {
    return {
      canResolve: false,
      issue: createSourceIssue(
        clip,
        sourceId,
        getMetadataIssueReason(clip.sourceFile.status),
        sourceId,
      ),
    };
  }

  const runtimeStatus = sourceAvailability[sourceId] ?? 'unknown';

  if (runtimeStatus !== 'openable') {
    return {
      canResolve: false,
      issue: createSourceIssue(
        clip,
        sourceId,
        runtimeStatus === 'unopenable' ? 'runtime-unopenable' : 'runtime-unknown',
        sourceId,
      ),
    };
  }

  return { canResolve: true, clip, generatedSource, sourceId };
}

function isPlaybackSourceCandidate(
  clip: Clip,
  midiPlaybackSources: MidiClipPlaybackSourceSnapshot | undefined,
): boolean {
  if (midiPlaybackSources?.[clip.id]) {
    return true;
  }

  return (
    doesClipSupportTakeMedia(clip, 'audio') &&
    (Boolean(clip.activeClipTakeId) || isSourceBackedAudioClip(clip))
  );
}

function getMetadataIssueReason(status: ClipSourceFileStatus): PlaybackSourceIssueReason {
  if (status === 'missing') {
    return 'metadata-missing';
  }

  if (status === 'moved') {
    return 'metadata-moved';
  }

  return 'metadata-unresolved';
}

function createSourceIssue(
  clip: SourceBackedAudioClip,
  key: string,
  reason: PlaybackSourceIssueReason,
  sourceId?: string,
): PlaybackSourceIssue {
  return {
    clipIds: [clip.id],
    fileName: clip.sourceFile.name,
    key,
    reason,
    sourceId,
  };
}

function addSourceIssue(
  sourceIssueMap: Map<string, MutablePlaybackSourceIssue>,
  issue: PlaybackSourceIssue,
): void {
  const currentIssue = sourceIssueMap.get(issue.key);

  if (!currentIssue) {
    sourceIssueMap.set(issue.key, { ...issue, clipIds: [...issue.clipIds] });
    return;
  }

  if (!currentIssue.clipIds.includes(issue.clipIds[0])) {
    currentIssue.clipIds.push(issue.clipIds[0]);
  }
}

function createResolvedPlaybackClip(
  clip: SourceBackedAudioClip,
  sourceId: string,
  planStartTick: number,
  planEndTick: number,
  bpm: number,
): ResolvedPlaybackClip | undefined {
  const originalClipStartTick = Math.round(clip.startTick);
  const originalClipEndTick = originalClipStartTick + Math.round(clip.lengthTicks);
  const timelineStartTick = Math.max(originalClipStartTick, planStartTick);
  const timelineEndTick = Math.min(originalClipEndTick, planEndTick);

  if (timelineEndTick <= timelineStartTick) {
    return undefined;
  }

  const sourceStartSeconds =
    clip.audioTiming.sourceStartSeconds +
    timelineTicksToSeconds(timelineStartTick - originalClipStartTick, bpm);
  const sourceEndSeconds = Math.min(
    clip.audioTiming.sourceEndSeconds,
    clip.audioTiming.sourceStartSeconds +
      (timelineEndTick === originalClipEndTick
        ? getEffectiveAudioClipDurationSeconds(clip.audioTiming, clip.lengthTicks, bpm)
        : timelineTicksToSeconds(timelineEndTick - originalClipStartTick, bpm)),
  );

  if (sourceEndSeconds <= sourceStartSeconds) {
    return undefined;
  }

  return {
    clipId: clip.id,
    clipName: clip.name,
    originalClipEndTick,
    originalClipStartTick,
    sourceEndSeconds,
    sourceId,
    sourceStartSeconds,
    timelineEndTick,
    timelineStartTick,
  };
}

function resolveTargetStartTick(playheadTick: number, startTick: number, endTick: number): number {
  return playheadTick >= startTick && playheadTick < endTick ? playheadTick : startTick;
}

function deduplicateTrackReferences(references: TargetTrackReference[]): TargetTrackReference[] {
  const seenTrackIds = new Set<string>();

  return references.filter((reference) => {
    if (seenTrackIds.has(reference.track.id)) {
      return false;
    }

    seenTrackIds.add(reference.track.id);
    return true;
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

function createFailure(
  reason: ProjectPlaybackPlanFailureReason,
  message: string,
  sourceIssues: PlaybackSourceIssue[] = [],
): ProjectPlaybackPlanAvailability {
  return { canPlay: false, message, reason, sourceIssues };
}

function formatSourceIssueCount(count: number): string {
  return `${count} ${count === 1 ? 'source' : 'sources'}`;
}

function clampTick(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
