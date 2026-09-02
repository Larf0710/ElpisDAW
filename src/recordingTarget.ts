import type { Clip, SelectionState, Track } from './types';

export type RecordingTargetResolution =
  | Readonly<{
      canRecord: true;
      targetClip?: Clip;
      targetTrack?: Track;
      targetTrackId: string;
    }>
  | Readonly<{
      canRecord: false;
      message: string;
      reason:
        | 'clip-not-found'
        | 'multiple-selection'
        | 'target-not-hum-audio'
        | 'track-not-found'
        | 'track-not-recordable';
    }>;

export function resolveRecordingTarget(
  tracks: readonly Track[],
  selection: SelectionState,
): RecordingTargetResolution {
  if (selection.items.length === 0) {
    const defaultTrack = tracks.find((track) => track.id === 'hum-audio');

    if (defaultTrack && !isMicrophoneRecordingTrack(defaultTrack)) {
      return {
        canRecord: false,
        message: 'Recording blocked: the default Hum Audio Track is not an Audio Track.',
        reason: 'track-not-recordable',
      };
    }

    return {
      canRecord: true,
      targetTrack: defaultTrack,
      targetTrackId: defaultTrack?.id ?? 'hum-audio',
    };
  }

  if (selection.items.length !== 1) {
    return {
      canRecord: false,
      message: 'Recording requires no selection, one Hum Audio Clip, or one Audio Track.',
      reason: 'multiple-selection',
    };
  }

  const selectedItem = selection.items[0];

  if (selectedItem.type === 'track') {
    const selectedTrack = tracks.find((track) => track.id === selectedItem.id);

    if (!selectedTrack) {
      return {
        canRecord: false,
        message: `Recording target Track was not found: ${selectedItem.id}.`,
        reason: 'track-not-found',
      };
    }

    if (!isMicrophoneRecordingTrack(selectedTrack)) {
      return {
        canRecord: false,
        message: `Recording blocked: ${selectedTrack.name} must be a blank or Audio Track.`,
        reason: 'track-not-recordable',
      };
    }

    return {
      canRecord: true,
      targetTrack: selectedTrack,
      targetTrackId: selectedTrack.id,
    };
  }

  for (const track of tracks) {
    const selectedClip = track.clips.find((clip) => clip.id === selectedItem.id);

    if (!selectedClip) {
      continue;
    }

    if (selectedClip.type !== 'hum-audio') {
      return {
        canRecord: false,
        message: `Recording blocked: ${selectedClip.name} is not a Hum Audio Clip.`,
        reason: 'target-not-hum-audio',
      };
    }

    return {
      canRecord: true,
      targetClip: selectedClip,
      targetTrack: track,
      targetTrackId: track.id,
    };
  }

  return {
    canRecord: false,
    message: `Recording target Clip was not found: ${selectedItem.id}.`,
    reason: 'clip-not-found',
  };
}

export function isMicrophoneRecordingTrack(track: Track): boolean {
  return !track.group && (track.type === 'audio' || track.type === 'blank');
}
