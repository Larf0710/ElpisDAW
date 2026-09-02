import type { SelectionItem, SelectionState, Track } from './types';
import {
  isTrackGroup,
  resolveTrackGroupPlaybackLeaf,
  resolveTrackGroupTree,
} from './trackGroupTree';

export type PlaybackTarget =
  | { readonly kind: 'all' }
  | { readonly kind: 'clip'; readonly clipId: string }
  | { readonly kind: 'track'; readonly trackId: string }
  | { readonly kind: 'group'; readonly activeTrackId: string; readonly groupTrackId: string }
  | { readonly kind: 'tracks'; readonly trackIds: readonly string[] }
  | {
      readonly kind: 'groups';
      readonly activeTrackIds: readonly string[];
      readonly groupTrackIds: readonly string[];
    };

export type PlaybackTargetLockReason =
  | 'group-unresolved'
  | 'mixed-selection'
  | 'multiple-clips'
  | 'target-not-found';

export type PlaybackTargetResolution =
  | { canTarget: true; target: PlaybackTarget }
  | { canTarget: false; message: string; reason: PlaybackTargetLockReason };

export type GroupPlaybackTrackResolution =
  | {
      canResolve: true;
      activeTrack: Track;
      storedActiveTrackMatches: boolean;
    }
  | {
      canResolve: false;
      message: string;
      reason: 'invalid-topology' | 'no-valid-child' | 'not-a-group';
    };

export function resolvePlaybackTarget(
  tracks: readonly Track[],
  selection: SelectionState,
): PlaybackTargetResolution {
  const topology = resolveTrackGroupTree(tracks);

  if (!topology.canResolve) {
    return {
      canTarget: false,
      message: topology.message,
      reason: 'group-unresolved',
    };
  }

  const selectedItems = deduplicateSelectionItems(selection.items);

  if (selectedItems.length === 0) {
    return { canTarget: true, target: { kind: 'all' } };
  }

  const clipItems = selectedItems.filter((item) => item.type === 'clip');
  const trackItems = selectedItems.filter((item) => item.type === 'track');

  if (clipItems.length > 0 && trackItems.length > 0) {
    return {
      canTarget: false,
      message: 'Playback locked: mixed Clip and Track selections are not playable together.',
      reason: 'mixed-selection',
    };
  }

  if (clipItems.length > 0) {
    if (clipItems.length > 1) {
      return {
        canTarget: false,
        message: 'Playback locked: multiple selected Clips are not supported in v0.1.',
        reason: 'multiple-clips',
      };
    }

    const clipId = clipItems[0].id;
    const clipExists = tracks.some((track) => track.clips.some((clip) => clip.id === clipId));

    return clipExists
      ? { canTarget: true, target: { kind: 'clip', clipId } }
      : {
          canTarget: false,
          message: `Playback locked: selected Clip ${clipId} no longer exists.`,
          reason: 'target-not-found',
        };
  }

  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  const selectedTracks: Track[] = [];

  for (const item of trackItems) {
    const track = trackMap.get(item.id);

    if (!track) {
      return {
        canTarget: false,
        message: `Playback locked: selected Track ${item.id} no longer exists.`,
        reason: 'target-not-found',
      };
    }

    selectedTracks.push(track);
  }

  const groupTracks = selectedTracks.filter(isGroupTrack);

  if (groupTracks.length > 0 && groupTracks.length !== selectedTracks.length) {
    return {
      canTarget: false,
      message: 'Playback locked: Track and Group selections are not playable together.',
      reason: 'mixed-selection',
    };
  }

  if (groupTracks.length === 0) {
    const trackIds = selectedTracks.map((track) => track.id);

    return trackIds.length === 1
      ? { canTarget: true, target: { kind: 'track', trackId: trackIds[0] } }
      : { canTarget: true, target: { kind: 'tracks', trackIds } };
  }

  const activeTrackIds: string[] = [];

  for (const groupTrack of groupTracks) {
    const resolution = resolveGroupPlaybackTrack(groupTrack, tracks);

    if (!resolution.canResolve) {
      return {
        canTarget: false,
        message: resolution.message,
        reason: 'group-unresolved',
      };
    }

    activeTrackIds.push(resolution.activeTrack.id);
  }

  const groupTrackIds = groupTracks.map((track) => track.id);

  return groupTrackIds.length === 1
    ? {
        canTarget: true,
        target: { kind: 'group', activeTrackId: activeTrackIds[0], groupTrackId: groupTrackIds[0] },
      }
    : {
        canTarget: true,
        target: { kind: 'groups', activeTrackIds, groupTrackIds },
      };
}

export function resolveGroupPlaybackTrack(
  groupTrack: Track,
  tracks: readonly Track[],
): GroupPlaybackTrackResolution {
  if (!isGroupTrack(groupTrack) || !groupTrack.group) {
    return {
      canResolve: false,
      message: `Playback locked: ${groupTrack.name} is missing valid Group data.`,
      reason: 'not-a-group',
    };
  }

  const resolution = resolveTrackGroupPlaybackLeaf(tracks, groupTrack.id);

  if (!resolution.canResolve) {
    return {
      canResolve: false,
      message: resolution.message,
      reason: 'invalid-topology',
    };
  }

  return {
    activeTrack: resolution.activeTrack,
    canResolve: true,
    storedActiveTrackMatches: resolution.storedActiveTrackMatches,
  };
}

export function isGroupTrack(track: Track): boolean {
  return isTrackGroup(track);
}

function deduplicateSelectionItems(items: readonly SelectionItem[]): SelectionItem[] {
  const seenItems = new Set<string>();

  return items.filter((item) => {
    const key = `${item.type}:${item.id}`;

    if (seenItems.has(key)) {
      return false;
    }

    seenItems.add(key);
    return true;
  });
}
