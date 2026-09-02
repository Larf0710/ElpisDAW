import {
  AUDIO_DURATION_EPSILON_SECONDS,
  timelineTicksToSeconds,
} from './audioClipTiming';
import {
  isSourceBackedAudioClip,
  type SourceBackedAudioClip,
} from './audioClipSource';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { doesTickRangeOverlapTrack } from './timelineClipPlacement';
import type { ProjectState, Track } from './types';

export type AudioClipSplitUpdate =
  | {
      canSplit: true;
      leftClip: SourceBackedAudioClip;
      rightClip: SourceBackedAudioClip;
      track: Track;
      tracks: Track[];
    }
  | {
      canSplit: false;
      message: string;
      reason:
        | 'clip-not-found'
        | 'not-source-backed'
        | 'invalid-position'
        | 'timeline-bounds'
        | 'minimum-length'
        | 'source-range'
        | 'clip-overlap';
    };

export function createProjectAudioClipSplitUpdate(
  project: ProjectState,
  clipId: string,
  splitTick: number,
  totalTicks = project.totalTicks,
): AudioClipSplitUpdate {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip || isSourceBackedAudioClip(clip)) {
    return createAudioClipSplitUpdate(
      project.tracks,
      clipId,
      splitTick,
      totalTicks,
      project.bpm,
    );
  }

  const sourceResolution = resolveActiveAudioTakeSource(project, clipId);

  if (!sourceResolution.canResolve) {
    return {
      canSplit: false,
      message: `Split blocked: ${clip.name} does not have reliable source timing.`,
      reason: 'not-source-backed',
    };
  }

  const sourceBackedTracks = project.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((candidate) =>
      candidate.id === clipId ? sourceResolution.plan.clip : candidate,
    ),
  }));

  return createAudioClipSplitUpdate(
    sourceBackedTracks,
    clipId,
    splitTick,
    totalTicks,
    project.bpm,
  );
}

export function createAudioClipSplitUpdate(
  tracks: Track[],
  clipId: string,
  splitTick: number,
  totalTicks: number,
  bpm: number,
): AudioClipSplitUpdate {
  const track = tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((candidate) => candidate.id === clipId);

  if (!track || !clip) {
    return {
      canSplit: false,
      message: 'Split blocked: the selected clip was not found.',
      reason: 'clip-not-found',
    };
  }

  if (!isSourceBackedAudioClip(clip)) {
    return {
      canSplit: false,
      message: `Split blocked: ${clip.name} does not have reliable source timing.`,
      reason: 'not-source-backed',
    };
  }

  if (!Number.isFinite(splitTick) || !isFinitePositiveNumber(bpm)) {
    return {
      canSplit: false,
      message: `Split blocked: ${clip.name} received an invalid Playhead position.`,
      reason: 'invalid-position',
    };
  }

  const startTick = clip.startTick;
  const endTick = clip.startTick + clip.lengthTicks;
  const normalizedSplitTick = Math.round(splitTick);

  if (startTick < 0 || endTick > totalTicks) {
    return {
      canSplit: false,
      message: `Split blocked: ${clip.name} must stay inside the Timeline length.`,
      reason: 'timeline-bounds',
    };
  }

  const leftLengthTicks = normalizedSplitTick - startTick;
  const rightLengthTicks = endTick - normalizedSplitTick;

  if (leftLengthTicks < 1 || rightLengthTicks < 1) {
    return {
      canSplit: false,
      message: `Split blocked: move the Playhead inside ${clip.name}.`,
      reason: 'minimum-length',
    };
  }

  const splitSourceSeconds =
    clip.audioTiming.sourceStartSeconds + timelineTicksToSeconds(leftLengthTicks, bpm);

  if (
    splitSourceSeconds <= clip.audioTiming.sourceStartSeconds + AUDIO_DURATION_EPSILON_SECONDS ||
    splitSourceSeconds >= clip.audioTiming.sourceEndSeconds - AUDIO_DURATION_EPSILON_SECONDS
  ) {
    return {
      canSplit: false,
      message: `Split blocked: ${clip.name} would create an invalid source range.`,
      reason: 'source-range',
    };
  }

  if (
    doesTickRangeOverlapTrack(startTick, normalizedSplitTick, track, clip.id) ||
    doesTickRangeOverlapTrack(normalizedSplitTick, endTick, track, clip.id)
  ) {
    return {
      canSplit: false,
      message: `Split blocked: ${clip.name} overlaps another clip on ${track.name}.`,
      reason: 'clip-overlap',
    };
  }

  const usedClipIds = new Set(tracks.flatMap((candidate) => candidate.clips.map((candidateClip) => candidateClip.id)));
  const rightClipId = createUniqueSplitId(usedClipIds, clip.id);
  const usedClipTakeIds = new Set(
    tracks.flatMap((candidate) => candidate.clips.flatMap(
      (candidateClip) => candidateClip.clipTakes?.map((take) => take.clipTakeId) ?? [],
    )),
  );
  const rightTakeIdBySourceId = new Map<string, string>();
  // Takes belong to one Clip; the underlying Artifacts remain shared.
  const rightClipTakes = clip.clipTakes?.map((take) => {
    const clipTakeId = createUniqueSplitId(usedClipTakeIds, take.clipTakeId);
    usedClipTakeIds.add(clipTakeId);
    rightTakeIdBySourceId.set(take.clipTakeId, clipTakeId);
    return { ...take, clipTakeId };
  });
  const leftClip: SourceBackedAudioClip = {
    ...clip,
    lengthTicks: leftLengthTicks,
    audioTiming: {
      ...clip.audioTiming,
      sourceEndSeconds: splitSourceSeconds,
    },
  };
  const rightClip: SourceBackedAudioClip = {
    ...clip,
    activeClipTakeId: rightTakeIdBySourceId.get(clip.activeClipTakeId ?? '') ?? clip.activeClipTakeId,
    clipTakes: rightClipTakes,
    id: rightClipId,
    startTick: normalizedSplitTick,
    lengthTicks: rightLengthTicks,
    audioTiming: {
      ...clip.audioTiming,
      sourceStartSeconds: splitSourceSeconds,
    },
  };
  const splitTrack = {
    ...track,
    clips: track.clips
      .flatMap((candidate) => (candidate.id === clip.id ? [leftClip, rightClip] : [candidate]))
      .sort((left, right) => left.startTick - right.startTick),
  };

  return {
    canSplit: true,
    leftClip,
    rightClip,
    track: splitTrack,
    tracks: tracks.map((candidate) => (candidate.id === track.id ? splitTrack : candidate)),
  };
}

function createUniqueSplitId(usedIds: ReadonlySet<string>, sourceId: string): string {
  let splitNumber = 1;
  let id = `${sourceId}-split-${splitNumber}`;

  while (usedIds.has(id)) {
    splitNumber += 1;
    id = `${sourceId}-split-${splitNumber}`;
  }

  return id;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
