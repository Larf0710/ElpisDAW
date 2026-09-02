import type {
  ProjectState,
  SelectionItem,
  SelectionState,
  Track,
} from './types';

export type AutoPatchTargetSource =
  | 'track-selection'
  | 'clip-selection'
  | 'fallback-clip';

export type AutoPatchTargetResolution =
  | Readonly<{
      canResolve: true;
      source: AutoPatchTargetSource;
      targetClipIds: readonly string[];
    }>
  | Readonly<{
      canResolve: false;
      message: string;
      reason: 'no-targets' | 'ambiguous-clip-id';
      targetClipIds: readonly [];
    }>;

export function resolveAutoPatchTargetClipIds(
  project: Pick<ProjectState, 'selection' | 'tracks'>,
  fallbackClipId?: string,
): AutoPatchTargetResolution {
  const validTrackIds = new Set(project.tracks.map((track) => track.id));
  const clipIdCounts = countClipIds(project.tracks);
  const validClipIds = new Set(
    [...clipIdCounts]
      .filter(([, count]) => count === 1)
      .map(([clipId]) => clipId),
  );
  const selection = normalizeTargetSelection(
    project.selection,
    validTrackIds,
    validClipIds,
  );
  const selectedTrackIds = new Set(
    selection.items
      .filter((item) => item.type === 'track')
      .map((item) => item.id),
  );

  if (selectedTrackIds.size > 0) {
    const targetTrackIds = expandSelectedTrackIds(
      project.tracks,
      selectedTrackIds,
    );
    const targetClipIds = project.tracks
      .filter((track) => targetTrackIds.has(track.id))
      .flatMap((track) => track.clips.map((clip) => clip.id));

    return createTargetResolution(
      targetClipIds,
      clipIdCounts,
      'track-selection',
    );
  }

  const ambiguousSelectedClipId = Array.isArray(project.selection?.items)
    ? (project.selection.items as unknown[])
        .filter(isSelectionItem)
        .find(
          (item) =>
            item.type === 'clip' &&
            (clipIdCounts.get(item.id) ?? 0) > 1,
        )?.id
    : undefined;

  if (ambiguousSelectedClipId) {
    return createAmbiguousResolution(ambiguousSelectedClipId);
  }

  const selectedClipIds = new Set(
    selection.items
      .filter((item) => item.type === 'clip')
      .map((item) => item.id),
  );

  if (selectedClipIds.size > 0) {
    const targetClipIds = project.tracks.flatMap((track) =>
      track.clips
        .filter((clip) => selectedClipIds.has(clip.id))
        .map((clip) => clip.id),
    );

    return createTargetResolution(
      targetClipIds,
      clipIdCounts,
      'clip-selection',
    );
  }

  if (fallbackClipId && validClipIds.has(fallbackClipId)) {
    return Object.freeze({
      canResolve: true,
      source: 'fallback-clip',
      targetClipIds: Object.freeze([fallbackClipId]),
    });
  }

  if (fallbackClipId && (clipIdCounts.get(fallbackClipId) ?? 0) > 1) {
    return createAmbiguousResolution(fallbackClipId);
  }

  return createNoTargetsResolution();
}

function normalizeTargetSelection(
  selection: SelectionState | undefined,
  validTrackIds: ReadonlySet<string>,
  validClipIds: ReadonlySet<string>,
): SelectionState {
  const items = Array.isArray(selection?.items)
    ? (selection.items as unknown[]).filter(
        (item): item is SelectionItem =>
          isSelectionItem(item) &&
          (item.type === 'track'
            ? validTrackIds.has(item.id)
            : validClipIds.has(item.id)),
      )
    : [];

  return { items };
}

function expandSelectedTrackIds(
  tracks: readonly Track[],
  selectedTrackIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  const expandedTrackIds = new Set<string>();

  selectedTrackIds.forEach((trackId) => {
    const track = trackMap.get(trackId);

    if (!track) {
      return;
    }

    expandedTrackIds.add(track.id);
    track.group?.childTrackIds.forEach((childTrackId) => {
      if (trackMap.has(childTrackId)) {
        expandedTrackIds.add(childTrackId);
      }
    });
  });

  return expandedTrackIds;
}

function createTargetResolution(
  targetClipIds: string[],
  clipIdCounts: ReadonlyMap<string, number>,
  source: Exclude<AutoPatchTargetSource, 'fallback-clip'>,
): AutoPatchTargetResolution {
  const ambiguousClipId = targetClipIds.find(
    (clipId) => clipIdCounts.get(clipId) !== 1,
  );

  if (ambiguousClipId) {
    return createAmbiguousResolution(ambiguousClipId);
  }

  if (targetClipIds.length === 0) {
    return createNoTargetsResolution();
  }

  return Object.freeze({
    canResolve: true,
    source,
    targetClipIds: Object.freeze([...targetClipIds]),
  });
}

function createAmbiguousResolution(
  clipId: string,
): AutoPatchTargetResolution {
  return Object.freeze({
    canResolve: false,
    message: `Auto Patch target Clip ID ${clipId} is not unique in the Project.`,
    reason: 'ambiguous-clip-id',
    targetClipIds: Object.freeze([]) as readonly [],
  });
}

function createNoTargetsResolution(): AutoPatchTargetResolution {
  return Object.freeze({
    canResolve: false,
    message: 'Auto Patch requires at least one selected Clip or Track.',
    reason: 'no-targets',
    targetClipIds: Object.freeze([]) as readonly [],
  });
}

function countClipIds(tracks: readonly Track[]): Map<string, number> {
  const counts = new Map<string, number>();

  tracks.forEach((track) => {
    track.clips.forEach((clip) => {
      counts.set(clip.id, (counts.get(clip.id) ?? 0) + 1);
    });
  });

  return counts;
}

function isSelectionItem(value: unknown): value is SelectionItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'type' in value &&
    (value.type === 'clip' || value.type === 'track')
  );
}
