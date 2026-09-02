import { resolveActiveMidiTake } from './activeMidiTake';
import { resolveMaximumMidiNoteEndTick } from './midiNoteTiming';
import { doesTickRangeOverlapTrack } from './timelineClipPlacement';
import type { Clip, ProjectState, Track } from './types';

export type MidiClipRightResizeUpdate =
  | Readonly<{
      adjustedToNoteBoundary?: boolean;
      canResize: true;
      clip: Clip;
      status: 'EXTENDED' | 'SHORTENED' | 'UNCHANGED';
      track: Track;
      tracks: Track[];
    }>
  | Readonly<{
      canResize: false;
      message: string;
      reason:
        | 'clip-not-found'
        | 'not-midi'
        | 'invalid-position'
        | 'minimum-length'
        | 'active-midi-unavailable'
        | 'timeline-bounds'
        | 'clip-overlap';
    }>;

export type MidiClipRightResizeSafety =
  | Readonly<{
      canResolve: true;
      minimumEndTick: number;
    }>
  | Readonly<{
      canResolve: false;
      message: string;
    }>;

export function isMidiClip(clip: Clip | undefined): boolean {
  return clip?.type === 'midi-notes' || clip?.type === 'edited-midi';
}

export function resolveMidiClipRightResizeSafety(
  project: ProjectState,
  clipId: string,
): MidiClipRightResizeSafety {
  const location = findMidiClipLocation(project.tracks, clipId);

  if (!location || !isMidiClip(location.clip)) {
    return {
      canResolve: false,
      message: 'The selected MIDI Clip could not be resolved.',
    };
  }

  const activeTake = resolveActiveMidiTake(project, clipId);

  if (!activeTake.canResolve) {
    return {
      canResolve: false,
      message: activeTake.message,
    };
  }

  const noteEnd = resolveMaximumMidiNoteEndTick(
    activeTake.plan.midi.notes,
  );

  if (!noteEnd.canResolve) {
    return {
      canResolve: false,
      message: `${location.clip.name} Active MIDI Take has invalid note timing. ${noteEnd.message}`,
    };
  }

  const minimumEndTick =
    location.clip.startTick + Math.max(1, noteEnd.maximumEndTick);

  if (!Number.isSafeInteger(minimumEndTick)) {
    return {
      canResolve: false,
      message: `${location.clip.name} Active MIDI Take has an invalid end position.`,
    };
  }

  return {
    canResolve: true,
    minimumEndTick,
  };
}

export function canPreviewMidiClipRightResize(
  tracks: Track[],
  clipId: string,
  targetEndTick: number,
  totalTicks: number,
  minimumEndTick: number,
): boolean {
  const location = findMidiClipLocation(tracks, clipId);

  if (
    !location ||
    !isMidiClip(location.clip) ||
    !Number.isFinite(targetEndTick) ||
    !Number.isFinite(totalTicks) ||
    !Number.isSafeInteger(minimumEndTick)
  ) {
    return false;
  }

  const endTick = Math.round(targetEndTick);
  const timelineEndTick = Math.round(totalTicks);

  return (
    endTick >= Math.max(location.clip.startTick + 1, minimumEndTick) &&
    endTick <= timelineEndTick &&
    !doesTickRangeOverlapTrack(
      location.clip.startTick,
      endTick,
      location.track,
      location.clip.id,
    )
  );
}

export function createMidiClipRightResizeUpdate(
  project: ProjectState,
  clipId: string,
  targetEndTick: number,
): MidiClipRightResizeUpdate {
  const location = findMidiClipLocation(project.tracks, clipId);
  const track = location?.track;
  const clip = location?.clip;

  if (!track || !clip) {
    return {
      canResize: false,
      message: 'Resize blocked: the selected clip was not found.',
      reason: 'clip-not-found',
    };
  }

  if (!isMidiClip(clip)) {
    return {
      canResize: false,
      message: `Resize blocked: ${clip.name} is not a MIDI Clip.`,
      reason: 'not-midi',
    };
  }

  if (
    !Number.isFinite(targetEndTick) ||
    !Number.isFinite(project.totalTicks)
  ) {
    return {
      canResize: false,
      message: `Resize blocked: ${clip.name} received an invalid Timeline position.`,
      reason: 'invalid-position',
    };
  }

  const requestedEndTick = Math.round(targetEndTick);
  const timelineEndTick = Math.round(project.totalTicks);
  const currentEndTick = clip.startTick + clip.lengthTicks;
  let adjustedToNoteBoundary = false;
  let endTick = requestedEndTick;

  if (requestedEndTick < clip.startTick + 1) {
    return {
      canResize: false,
      message: `Resize blocked: ${clip.name} must remain at least one tick long.`,
      reason: 'minimum-length',
    };
  }

  if (requestedEndTick > timelineEndTick) {
    return {
      canResize: false,
      message: `Resize blocked: ${clip.name} must stay inside the Timeline length.`,
      reason: 'timeline-bounds',
    };
  }

  if (requestedEndTick < currentEndTick) {
    const safety = resolveMidiClipRightResizeSafety(project, clip.id);

    if (!safety.canResolve) {
      return {
        canResize: false,
        message: `Resize blocked: ${clip.name} Active MIDI Take could not be verified. ${safety.message}`,
        reason: 'active-midi-unavailable',
      };
    }

    if (requestedEndTick < safety.minimumEndTick) {
      endTick = safety.minimumEndTick;
      adjustedToNoteBoundary = true;
    }
  }

  if (
    doesTickRangeOverlapTrack(clip.startTick, endTick, track, clip.id)
  ) {
    return {
      canResize: false,
      message: `Resize blocked: ${clip.name} would overlap another clip on ${track.name}.`,
      reason: 'clip-overlap',
    };
  }

  if (endTick === currentEndTick) {
    return {
      adjustedToNoteBoundary: adjustedToNoteBoundary || undefined,
      canResize: true,
      clip,
      status: 'UNCHANGED',
      track,
      tracks: project.tracks,
    };
  }

  const resizedClip: Clip = {
    ...clip,
    lengthTicks: endTick - clip.startTick,
    version: clip.version + 1,
  };
  const resizedTrack: Track = {
    ...track,
    clips: track.clips.map((candidate) =>
      candidate.id === clip.id ? resizedClip : candidate,
    ),
  };

  return {
    adjustedToNoteBoundary: adjustedToNoteBoundary || undefined,
    canResize: true,
    clip: resizedClip,
    status: endTick < currentEndTick ? 'SHORTENED' : 'EXTENDED',
    track: resizedTrack,
    tracks: project.tracks.map((candidate) =>
      candidate.id === track.id ? resizedTrack : candidate,
    ),
  };
}

function findMidiClipLocation(
  tracks: readonly Track[],
  clipId: string,
): Readonly<{ clip: Clip; track: Track }> | undefined {
  let match: Readonly<{ clip: Clip; track: Track }> | undefined;

  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.id !== clipId) {
        continue;
      }

      if (match) {
        return undefined;
      }

      match = { clip, track };
    }
  }

  return match;
}
