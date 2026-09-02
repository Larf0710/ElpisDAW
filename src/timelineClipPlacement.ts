import type { Clip, Track } from './types';

export type TimelineClipMoveUpdate =
  | {
      canMove: true;
      adjustedForOverlap?: boolean;
      blockingClip?: Clip;
      clip: Clip;
      track: Track;
      tracks: Track[];
    }
  | {
      canMove: false;
      message: string;
      reason: 'clip-not-found' | 'invalid-position' | 'timeline-bounds' | 'clip-overlap';
    };

export function createTimelineClipMoveUpdate(
  tracks: Track[],
  clipId: string,
  targetStartTick: number,
  totalTicks: number,
): TimelineClipMoveUpdate {
  const track = tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((candidate) => candidate.id === clipId);

  if (!track || !clip) {
    return {
      canMove: false,
      message: 'Move blocked: the selected clip was not found.',
      reason: 'clip-not-found',
    };
  }

  if (!Number.isFinite(targetStartTick)) {
    return {
      canMove: false,
      message: `Move blocked: ${clip.name} received an invalid Timeline position.`,
      reason: 'invalid-position',
    };
  }

  const startTick = Math.round(targetStartTick);
  const endTick = startTick + clip.lengthTicks;

  if (startTick < 0 || endTick > totalTicks) {
    return {
      canMove: false,
      message: `Move blocked: ${clip.name} must stay inside the Timeline length.`,
      reason: 'timeline-bounds',
    };
  }

  if (doesTickRangeOverlapTrack(startTick, endTick, track, clip.id)) {
    return {
      canMove: false,
      message: `Move blocked: ${clip.name} would overlap another clip on ${track.name}.`,
      reason: 'clip-overlap',
    };
  }

  const movedClip = { ...clip, startTick };
  const movedTrack = {
    ...track,
    clips: track.clips.map((candidate) => (candidate.id === clip.id ? movedClip : candidate)),
  };

  return {
    canMove: true,
    clip: movedClip,
    track: movedTrack,
    tracks: tracks.map((candidate) => (candidate.id === track.id ? movedTrack : candidate)),
  };
}

export function createTimelineClipDropUpdate(
  tracks: Track[],
  clipId: string,
  targetStartTick: number,
  totalTicks: number,
): TimelineClipMoveUpdate {
  const directMove = createTimelineClipMoveUpdate(tracks, clipId, targetStartTick, totalTicks);

  if (directMove.canMove || directMove.reason !== 'clip-overlap') {
    return directMove;
  }

  const track = tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((candidate) => candidate.id === clipId);

  if (!track || !clip || !Number.isFinite(targetStartTick)) {
    return directMove;
  }

  const startTick = Math.round(targetStartTick);
  const endTick = startTick + clip.lengthTicks;
  const isMovingRight = startTick > clip.startTick;
  const isMovingLeft = startTick < clip.startTick;

  if (!isMovingRight && !isMovingLeft) {
    return directMove;
  }

  const blockingClip = track.clips
    .filter(
      (candidate) =>
        candidate.id !== clip.id &&
        doTickRangesOverlap(startTick, endTick, candidate.startTick, candidate.startTick + candidate.lengthTicks),
    )
    .sort((left, right) =>
      isMovingRight
        ? left.startTick - right.startTick
        : right.startTick + right.lengthTicks - (left.startTick + left.lengthTicks),
    )[0];

  if (!blockingClip) {
    return directMove;
  }

  const adjacentStartTick = isMovingRight
    ? blockingClip.startTick - clip.lengthTicks
    : blockingClip.startTick + blockingClip.lengthTicks;
  const adjacentMove = createTimelineClipMoveUpdate(tracks, clipId, adjacentStartTick, totalTicks);

  if (!adjacentMove.canMove) {
    return {
      ...adjacentMove,
      message: `Move blocked: ${clip.name} cannot fit next to ${blockingClip.name} on ${track.name}.`,
    };
  }

  return {
    ...adjacentMove,
    adjustedForOverlap: true,
    blockingClip,
  };
}

export function doesTickRangeOverlapTrack(
  startTick: number,
  endTick: number,
  track: Track,
  excludedClipId?: string,
): boolean {
  return track.clips.some(
    (clip) =>
      clip.id !== excludedClipId &&
      doTickRangesOverlap(startTick, endTick, clip.startTick, clip.startTick + clip.lengthTicks),
  );
}

export function getTimelineClipEdgeAutoScrollStep(
  clientX: number,
  viewportLeft: number,
  viewportRight: number,
): number {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(viewportLeft) ||
    !Number.isFinite(viewportRight) ||
    viewportRight <= viewportLeft
  ) {
    return 0;
  }

  const edgeThreshold = Math.min(48, (viewportRight - viewportLeft) / 2);
  const maxScrollStep = 22;

  if (clientX < viewportLeft + edgeThreshold) {
    const proximity = Math.min(1, (viewportLeft + edgeThreshold - clientX) / edgeThreshold);
    return -Math.max(1, Math.ceil(proximity * maxScrollStep));
  }

  if (clientX > viewportRight - edgeThreshold) {
    const proximity = Math.min(1, (clientX - (viewportRight - edgeThreshold)) / edgeThreshold);
    return Math.max(1, Math.ceil(proximity * maxScrollStep));
  }

  return 0;
}

function doTickRangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}
