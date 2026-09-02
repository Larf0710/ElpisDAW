import type {
  Clip,
  ProjectState,
  SelectionItem,
  SelectionState,
  Track,
} from './types';

export type TrackGroupTreeFailureReason =
  | 'active-child-invalid'
  | 'canonical-order-invalid'
  | 'child-invalid'
  | 'cycle'
  | 'group-invalid'
  | 'identity-invalid'
  | 'parent-invalid';

export type TrackGroupTreeFailure = Readonly<{
  canResolve: false;
  message: string;
  reason: TrackGroupTreeFailureReason;
}>;

export type TrackGroupTree = Readonly<{
  ancestorTrackIdsByTrackId: ReadonlyMap<string, readonly string[]>;
  depthByTrackId: ReadonlyMap<string, number>;
  rootTrackIds: readonly string[];
  subtreeTrackIdsByRootId: ReadonlyMap<string, readonly string[]>;
  trackById: ReadonlyMap<string, Track>;
  tracks: readonly Track[];
}>;

export type TrackGroupTreeResolution =
  | Readonly<{ canResolve: true; tree: TrackGroupTree }>
  | TrackGroupTreeFailure;

export type TrackGroupVisibleRow = Readonly<{
  depth: number;
  track: Track;
}>;

export type TrackGroupVisibleRowsResolution =
  | Readonly<{
      canResolve: true;
      rows: readonly TrackGroupVisibleRow[];
      tree: TrackGroupTree;
    }>
  | Readonly<{
      canResolve: false;
      message: string;
      reason: TrackGroupTreeFailureReason;
      rows: readonly TrackGroupVisibleRow[];
    }>;

export type TrackGroupPlaybackLeafResolution =
  | Readonly<{
      canResolve: true;
      activeTrack: Track;
      groupPath: readonly Track[];
      storedActiveTrackMatches: true;
    }>
  | TrackGroupTreeFailure;

export type TrackGroupingPlan = Readonly<{
  selectedRootTrackIds: readonly string[];
  sharedParentGroupId: string | null;
  sourceFingerprint: string;
}>;

export type TrackGroupingAvailability =
  | Readonly<{
      canGroup: true;
      message: string;
      plan: TrackGroupingPlan;
      selectedCount: number;
    }>
  | Readonly<{
      canGroup: false;
      message: string;
      selectedCount: number;
    }>;

export type TrackGroupingApplication =
  | Readonly<{
      canApply: true;
      groupTrack: Track;
      project: ProjectState;
    }>
  | Readonly<{
      canApply: false;
      message: string;
    }>;

export type TrackUngroupPlan = Readonly<{
  childTrackIds: readonly string[];
  groupTrackId: string;
  parentGroupId: string | null;
  sourceFingerprint: string;
}>;

export type TrackUngroupPlanning =
  | Readonly<{ canUngroup: true; plan: TrackUngroupPlan }>
  | Readonly<{ canUngroup: false; message: string }>;

export type TrackUngroupApplication =
  | Readonly<{
      canApply: true;
      childTrackIds: readonly string[];
      project: ProjectState;
    }>
  | Readonly<{ canApply: false; message: string }>;

export type TrackGroupCollapseApplication =
  | Readonly<{
      canApply: true;
      collapsed: boolean;
      project: ProjectState;
    }>
  | Readonly<{ canApply: false; message: string }>;

export type TrackTreeDeletionPlan = Readonly<{
  looseClipIds: readonly string[];
  selectedTrackRootIds: readonly string[];
  sourceFingerprint: string;
}>;

export type TimelineTreeDeletionImpact =
  | Readonly<{
      canDelete: true;
      looseClipIds: readonly string[];
      looseClips: readonly Clip[];
      plan: TrackTreeDeletionPlan;
      removedClipCount: number;
      trackIds: readonly string[];
      tracks: readonly Track[];
    }>
  | Readonly<{
      canDelete: false;
      looseClipIds: readonly [];
      looseClips: readonly [];
      message: string;
      removedClipCount: 0;
      trackIds: readonly [];
      tracks: readonly [];
    }>;

export type TrackTreeDeletionApplication =
  | Readonly<{ canApply: true; project: ProjectState }>
  | Readonly<{ canApply: false; message: string }>;

export type CanonicalTrackOrderResolution =
  | Readonly<{ canOrder: true; tracks: readonly Track[] }>
  | Readonly<{ canOrder: false; message: string }>;

type SemanticTreeBuild =
  | Readonly<{ canResolve: true; tree: TrackGroupTree }>
  | TrackGroupTreeFailure;

export function isTrackGroup(track: Track): boolean {
  return track.type === 'group' || track.group !== undefined;
}

export function resolveTrackGroupTree(
  tracks: readonly Track[],
): TrackGroupTreeResolution {
  return buildTrackGroupTree(tracks, true);
}

export function resolveTrackGroupVisibleRows(
  tracks: readonly Track[],
): TrackGroupVisibleRowsResolution {
  const resolution = resolveTrackGroupTree(tracks);

  if (!resolution.canResolve) {
    return Object.freeze({
      canResolve: false as const,
      message: resolution.message,
      reason: resolution.reason,
      rows: Object.freeze(
        tracks.map((track) => Object.freeze({ depth: 0, track })),
      ),
    });
  }

  const rows = resolution.tree.tracks.flatMap((track) => {
    const ancestorIds =
      resolution.tree.ancestorTrackIdsByTrackId.get(track.id) ?? [];
    const hidden = ancestorIds.some(
      (ancestorId) =>
        resolution.tree.trackById.get(ancestorId)?.group?.collapsed === true,
    );

    return hidden
      ? []
      : [
          Object.freeze({
            depth: resolution.tree.depthByTrackId.get(track.id) ?? 0,
            track,
          }),
        ];
  });

  return Object.freeze({
    canResolve: true as const,
    rows: Object.freeze(rows),
    tree: resolution.tree,
  });
}

export function resolveTrackGroupSubtree(
  tracks: readonly Track[],
  rootTrackId: string,
):
  | Readonly<{
      canResolve: true;
      trackIds: readonly string[];
      tracks: readonly Track[];
      tree: TrackGroupTree;
    }>
  | TrackGroupTreeFailure {
  const resolution = resolveTrackGroupTree(tracks);

  if (!resolution.canResolve) {
    return resolution;
  }

  const trackIds = resolution.tree.subtreeTrackIdsByRootId.get(rootTrackId);

  if (!trackIds) {
    return treeFailure(
      'identity-invalid',
      `Track Group topology is invalid: Track ${rootTrackId} does not exist.`,
    );
  }

  return Object.freeze({
    canResolve: true as const,
    trackIds,
    tracks: Object.freeze(
      trackIds.map((trackId) => resolution.tree.trackById.get(trackId)!),
    ),
    tree: resolution.tree,
  });
}

export function resolveTrackGroupPlaybackLeaf(
  tracks: readonly Track[],
  groupTrackId: string,
): TrackGroupPlaybackLeafResolution {
  const resolution = resolveTrackGroupTree(tracks);

  if (!resolution.canResolve) {
    return resolution;
  }

  const initialGroup = resolution.tree.trackById.get(groupTrackId);

  if (!initialGroup || !isTrackGroup(initialGroup) || !initialGroup.group) {
    return treeFailure(
      'group-invalid',
      `Playback locked: Group ${groupTrackId} is missing valid Group data.`,
    );
  }

  const groupPath: Track[] = [];
  let current = initialGroup;

  while (current.group) {
    groupPath.push(current);
    const activeChild = resolution.tree.trackById.get(
      current.group.activePlaybackTrackId,
    );

    if (!activeChild) {
      return treeFailure(
        'active-child-invalid',
        `Playback locked: ${current.name} has no valid active direct child.`,
      );
    }

    current = activeChild;
  }

  return Object.freeze({
    activeTrack: current,
    canResolve: true as const,
    groupPath: Object.freeze(groupPath),
    storedActiveTrackMatches: true as const,
  });
}

export function resolveTrackGroupingPlan(
  tracks: readonly Track[],
  selection: SelectionState,
): TrackGroupingAvailability {
  const resolution = resolveTrackGroupTree(tracks);
  const selectedTrackItems = selection.items.filter(
    (item) => item.type === 'track',
  );
  const selectedCount = new Set(
    selectedTrackItems.map((item) => item.id),
  ).size;

  if (!resolution.canResolve) {
    return groupFailure(resolution.message, selectedCount);
  }

  if (selection.items.some((item) => item.type !== 'track')) {
    return groupFailure(
      'Group unavailable: select Track roots only.',
      selectedCount,
    );
  }

  if (
    selectedTrackItems.length !== selectedCount ||
    selectedCount < 2
  ) {
    return groupFailure(
      selectedTrackItems.length !== selectedCount
        ? 'Group unavailable: selected Track identities are duplicated.'
        : 'Select at least two Track roots.',
      selectedCount,
    );
  }

  const selectedIds = new Set(selectedTrackItems.map((item) => item.id));
  const visibleRows = resolveTrackGroupVisibleRows(tracks);

  if (!visibleRows.canResolve) {
    return groupFailure(visibleRows.message, selectedCount);
  }

  const visibleIds = new Set(visibleRows.rows.map((row) => row.track.id));
  const selectedTracks = [...selectedIds].map((trackId) =>
    resolution.tree.trackById.get(trackId),
  );

  if (
    selectedTracks.some((track) => !track) ||
    [...selectedIds].some((trackId) => !visibleIds.has(trackId))
  ) {
    return groupFailure(
      'Group unavailable: selection is stale, ambiguous, or hidden by a collapsed ancestor.',
      selectedCount,
    );
  }

  const parentIds = new Set(
    selectedTracks.map((track) => track?.parentGroupId ?? null),
  );

  if (parentIds.size !== 1) {
    return groupFailure(
      'Group unavailable: selected Track roots must be siblings under the same parent.',
      selectedCount,
    );
  }

  const sharedParentGroupId = selectedTracks[0]?.parentGroupId ?? null;
  const siblingIds = sharedParentGroupId
    ? resolution.tree.trackById.get(sharedParentGroupId)?.group?.childTrackIds
    : resolution.tree.rootTrackIds;

  if (!siblingIds) {
    return groupFailure(
      'Group unavailable: the shared parent Group is invalid.',
      selectedCount,
    );
  }

  const selectedRootTrackIds = siblingIds.filter((trackId) =>
    selectedIds.has(trackId),
  );

  if (selectedRootTrackIds.length !== selectedCount) {
    return groupFailure(
      'Group unavailable: selection contains an ancestor, descendant, or foreign Track.',
      selectedCount,
    );
  }

  const plan: TrackGroupingPlan = Object.freeze({
    selectedRootTrackIds: Object.freeze([...selectedRootTrackIds]),
    sharedParentGroupId,
    sourceFingerprint: createTreeOperationFingerprint(tracks, selection),
  });

  return Object.freeze({
    canGroup: true as const,
    message: `Group ${selectedCount} selected Track roots.`,
    plan,
    selectedCount,
  });
}

export function applyTrackGroupingPlan(
  project: ProjectState,
  plan: TrackGroupingPlan,
): TrackGroupingApplication {
  const current = resolveTrackGroupingPlan(project.tracks, project.selection);

  if (
    !current.canGroup ||
    current.plan.sourceFingerprint !== plan.sourceFingerprint ||
    current.plan.sharedParentGroupId !== plan.sharedParentGroupId ||
    !areStringArraysEqual(
      current.plan.selectedRootTrackIds,
      plan.selectedRootTrackIds,
    )
  ) {
    return operationFailure(
      'Group canceled: the Track tree or selection changed before the operation was applied.',
    );
  }

  const treeResolution = resolveTrackGroupTree(project.tracks);
  if (!treeResolution.canResolve) return operationFailure(treeResolution.message);
  const tree = treeResolution.tree;
  const groupTrackId = createTrackGroupId(project.tracks);
  const groupTrackName = createTrackGroupName(project.tracks);
  const activeChildId =
    plan.selectedRootTrackIds[plan.selectedRootTrackIds.length - 1];
  const activeChild = tree.trackById.get(activeChildId)!;
  const groupTrack: Track = {
    clips: [],
    group: {
      activePlaybackTrackId: activeChildId,
      childTrackIds: [...plan.selectedRootTrackIds],
      collapsed: true,
      playbackMode: 'bottom_child',
    },
    id: groupTrackId,
    level: activeChild.level,
    muted: activeChild.muted,
    name: groupTrackName,
    parentGroupId: plan.sharedParentGroupId,
    type: 'group',
  };
  const trackMap = new Map(tree.trackById);

  for (const selectedRootId of plan.selectedRootTrackIds) {
    const selectedRoot = trackMap.get(selectedRootId)!;
    trackMap.set(selectedRootId, {
      ...selectedRoot,
      parentGroupId: groupTrackId,
    });
  }

  trackMap.set(groupTrackId, groupTrack);
  let rootTrackIds = [...tree.rootTrackIds];

  if (plan.sharedParentGroupId) {
    const parent = trackMap.get(plan.sharedParentGroupId);
    if (!parent?.group) {
      return operationFailure('Group canceled: the shared parent Group is unavailable.');
    }
    const childTrackIds = replaceSelectedSiblings(
      parent.group.childTrackIds,
      plan.selectedRootTrackIds,
      groupTrackId,
    );
    trackMap.set(parent.id, {
      ...parent,
      group: {
        ...parent.group,
        activePlaybackTrackId: childTrackIds[childTrackIds.length - 1],
        childTrackIds,
      },
    });
  } else {
    rootTrackIds = replaceSelectedSiblings(
      rootTrackIds,
      plan.selectedRootTrackIds,
      groupTrackId,
    );
  }

  const ordering = canonicalizeTrackGroupTracks(
    [...trackMap.values()],
    rootTrackIds,
  );
  if (!ordering.canOrder) return operationFailure(ordering.message);
  const selectionItem: SelectionItem = { id: groupTrackId, type: 'track' };

  return Object.freeze({
    canApply: true as const,
    groupTrack,
    project: {
      ...project,
      selection: createSelection([selectionItem]),
      tracks: [...ordering.tracks],
    },
  });
}

export function resolveTrackUngroupPlan(
  tracks: readonly Track[],
  groupTrackId: string,
): TrackUngroupPlanning {
  const resolution = resolveTrackGroupTree(tracks);

  if (!resolution.canResolve) {
    return Object.freeze({ canUngroup: false as const, message: resolution.message });
  }

  const groupTrack = resolution.tree.trackById.get(groupTrackId);
  if (!groupTrack?.group || groupTrack.type !== 'group') {
    return Object.freeze({
      canUngroup: false as const,
      message: 'Ungroup unavailable: the selected Track is not one exact Group.',
    });
  }

  return Object.freeze({
    canUngroup: true as const,
    plan: Object.freeze({
      childTrackIds: Object.freeze([...groupTrack.group.childTrackIds]),
      groupTrackId,
      parentGroupId: groupTrack.parentGroupId ?? null,
      sourceFingerprint: createTreeFingerprint(tracks),
    }),
  });
}

export function applyTrackUngroupPlan(
  project: ProjectState,
  plan: TrackUngroupPlan,
): TrackUngroupApplication {
  const current = resolveTrackUngroupPlan(project.tracks, plan.groupTrackId);

  if (
    !current.canUngroup ||
    current.plan.sourceFingerprint !== plan.sourceFingerprint ||
    current.plan.parentGroupId !== plan.parentGroupId ||
    !areStringArraysEqual(current.plan.childTrackIds, plan.childTrackIds)
  ) {
    return Object.freeze({
      canApply: false as const,
      message: 'Ungroup canceled: the Track tree changed before the operation was applied.',
    });
  }

  const treeResolution = resolveTrackGroupTree(project.tracks);
  if (!treeResolution.canResolve) {
    return Object.freeze({ canApply: false as const, message: treeResolution.message });
  }
  const tree = treeResolution.tree;
  const trackMap = new Map(tree.trackById);

  for (const childTrackId of plan.childTrackIds) {
    const child = trackMap.get(childTrackId)!;
    trackMap.set(childTrackId, {
      ...child,
      parentGroupId: plan.parentGroupId,
    });
  }

  trackMap.delete(plan.groupTrackId);
  let rootTrackIds = [...tree.rootTrackIds];

  if (plan.parentGroupId) {
    const parent = trackMap.get(plan.parentGroupId);
    if (!parent?.group) {
      return Object.freeze({
        canApply: false as const,
        message: 'Ungroup canceled: the parent Group is unavailable.',
      });
    }
    const groupIndex = parent.group.childTrackIds.indexOf(plan.groupTrackId);
    if (groupIndex < 0) {
      return Object.freeze({
        canApply: false as const,
        message: 'Ungroup canceled: the parent Group no longer owns the selected Group.',
      });
    }
    const childTrackIds = [
      ...parent.group.childTrackIds.slice(0, groupIndex),
      ...plan.childTrackIds,
      ...parent.group.childTrackIds.slice(groupIndex + 1),
    ];
    trackMap.set(parent.id, {
      ...parent,
      group: {
        ...parent.group,
        activePlaybackTrackId: childTrackIds[childTrackIds.length - 1],
        childTrackIds,
      },
    });
  } else {
    const groupIndex = rootTrackIds.indexOf(plan.groupTrackId);
    rootTrackIds = [
      ...rootTrackIds.slice(0, groupIndex),
      ...plan.childTrackIds,
      ...rootTrackIds.slice(groupIndex + 1),
    ];
  }

  const ordering = canonicalizeTrackGroupTracks(
    [...trackMap.values()],
    rootTrackIds,
  );
  if (!ordering.canOrder) {
    return Object.freeze({ canApply: false as const, message: ordering.message });
  }
  const selectionItems = plan.childTrackIds.map(
    (trackId): SelectionItem => ({ id: trackId, type: 'track' }),
  );

  return Object.freeze({
    canApply: true as const,
    childTrackIds: plan.childTrackIds,
    project: {
      ...project,
      selection: createSelection(selectionItems),
      tracks: [...ordering.tracks],
    },
  });
}

export function applyTrackGroupCollapsedState(
  project: ProjectState,
  groupTrackId: string,
): TrackGroupCollapseApplication {
  const resolution = resolveTrackGroupTree(project.tracks);

  if (!resolution.canResolve) {
    return Object.freeze({ canApply: false as const, message: resolution.message });
  }

  const groupTrack = resolution.tree.trackById.get(groupTrackId);
  const subtreeTrackIds =
    resolution.tree.subtreeTrackIdsByRootId.get(groupTrackId);

  if (!groupTrack?.group || !subtreeTrackIds) {
    return Object.freeze({
      canApply: false as const,
      message: 'Group toggle unavailable: the selected Group is stale or invalid.',
    });
  }

  const collapsed = !groupTrack.group.collapsed;
  const descendantTrackIds = new Set(
    subtreeTrackIds.filter((trackId) => trackId !== groupTrackId),
  );
  const descendantClipIds = new Set(
    [...descendantTrackIds].flatMap(
      (trackId) =>
        resolution.tree.trackById
          .get(trackId)
          ?.clips.map((clip) => clip.id) ?? [],
    ),
  );
  const selectionTouchesDescendant = project.selection.items.some((item) =>
    item.type === 'track'
      ? descendantTrackIds.has(item.id)
      : descendantClipIds.has(item.id),
  );
  const nextTrack: Track = {
    ...groupTrack,
    group: { ...groupTrack.group, collapsed },
  };

  return Object.freeze({
    canApply: true as const,
    collapsed,
    project: {
      ...project,
      selection:
        collapsed && selectionTouchesDescendant
          ? createSelection([{ id: groupTrackId, type: 'track' }])
          : project.selection,
      tracks: project.tracks.map((track) =>
        track.id === groupTrackId ? nextTrack : track,
      ),
    },
  });
}

export function resolveTimelineTreeDeletion(
  tracks: readonly Track[],
  selection: SelectionState,
): TimelineTreeDeletionImpact {
  const resolution = resolveTrackGroupTree(tracks);

  if (!resolution.canResolve) return deletionFailure(resolution.message);
  if (selection.items.length === 0) {
    return deletionFailure('Select Timeline Tracks or Clips to delete.');
  }

  const selectionKeys = selection.items.map((item) => `${item.type}:${item.id}`);
  if (new Set(selectionKeys).size !== selectionKeys.length) {
    return deletionFailure('Delete unavailable: selection identities are duplicated.');
  }

  const selectedTrackRootIds = selection.items
    .filter((item) => item.type === 'track')
    .map((item) => item.id);
  if (
    selectedTrackRootIds.some(
      (trackId) => !resolution.tree.trackById.has(trackId),
    )
  ) {
    return deletionFailure('Delete unavailable: a selected Track is stale.');
  }

  const clipLocations = new Map<string, Array<{ clip: Clip; track: Track }>>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      const locations = clipLocations.get(clip.id) ?? [];
      locations.push({ clip, track });
      clipLocations.set(clip.id, locations);
    }
  }

  const selectedClipIds = selection.items
    .filter((item) => item.type === 'clip')
    .map((item) => item.id);
  if (
    selectedClipIds.some(
      (clipId) => clipLocations.get(clipId)?.length !== 1,
    )
  ) {
    return deletionFailure(
      'Delete unavailable: a selected Clip is stale or ambiguous.',
    );
  }

  const initialRemovedTrackIds = new Set<string>();
  for (const rootTrackId of selectedTrackRootIds) {
    const subtree =
      resolution.tree.subtreeTrackIdsByRootId.get(rootTrackId) ?? [];
    subtree.forEach((trackId) => initialRemovedTrackIds.add(trackId));
  }
  const looseClipIds = selectedClipIds.filter((clipId) => {
    const track = clipLocations.get(clipId)![0].track;
    return !initialRemovedTrackIds.has(track.id);
  });
  const simulation = simulateTreeDeletion(
    resolution.tree,
    initialRemovedTrackIds,
    new Set(looseClipIds),
  );

  if (!simulation.canApply) return deletionFailure(simulation.message);
  const remainingTrackIds = new Set(
    simulation.tracks.map((track) => track.id),
  );
  const removedTracks = tracks.filter(
    (track) => !remainingTrackIds.has(track.id),
  );
  const looseClips = looseClipIds.map(
    (clipId) => clipLocations.get(clipId)![0].clip,
  );
  const removedClipCount =
    removedTracks.reduce((count, track) => count + track.clips.length, 0) +
    looseClips.length;

  if (removedTracks.length === 0 && looseClips.length === 0) {
    return deletionFailure('Select Timeline Tracks or Clips to delete.');
  }

  return Object.freeze({
    canDelete: true as const,
    looseClipIds: Object.freeze([...looseClipIds]),
    looseClips: Object.freeze(looseClips),
    plan: Object.freeze({
      looseClipIds: Object.freeze([...looseClipIds]),
      selectedTrackRootIds: Object.freeze([...selectedTrackRootIds]),
      sourceFingerprint: createTreeOperationFingerprint(tracks, selection),
    }),
    removedClipCount,
    trackIds: Object.freeze(removedTracks.map((track) => track.id)),
    tracks: Object.freeze(removedTracks),
  });
}

export function applyTimelineTreeDeletionPlan(
  project: ProjectState,
  plan: TrackTreeDeletionPlan,
): TrackTreeDeletionApplication {
  const current = resolveTimelineTreeDeletion(project.tracks, project.selection);

  if (
    !current.canDelete ||
    current.plan.sourceFingerprint !== plan.sourceFingerprint ||
    !areStringArraysEqual(
      current.plan.selectedTrackRootIds,
      plan.selectedTrackRootIds,
    ) ||
    !areStringArraysEqual(current.plan.looseClipIds, plan.looseClipIds)
  ) {
    return Object.freeze({
      canApply: false as const,
      message: 'Delete canceled: the Track tree or selection changed before the operation was applied.',
    });
  }

  const resolution = resolveTrackGroupTree(project.tracks);
  if (!resolution.canResolve) {
    return Object.freeze({ canApply: false as const, message: resolution.message });
  }
  const initialRemovedTrackIds = new Set<string>();
  for (const rootTrackId of plan.selectedTrackRootIds) {
    resolution.tree.subtreeTrackIdsByRootId
      .get(rootTrackId)
      ?.forEach((trackId) => initialRemovedTrackIds.add(trackId));
  }
  const simulation = simulateTreeDeletion(
    resolution.tree,
    initialRemovedTrackIds,
    new Set(plan.looseClipIds),
  );

  if (!simulation.canApply) return simulation;
  return Object.freeze({
    canApply: true as const,
    project: {
      ...project,
      selection: createSelection([]),
      tracks: [...simulation.tracks],
    },
  });
}

export function canonicalizeTrackGroupTracks(
  tracks: readonly Track[],
  rootTrackIds?: readonly string[],
): CanonicalTrackOrderResolution {
  const semantic = buildTrackGroupTree(tracks, false);

  if (!semantic.canResolve) {
    return Object.freeze({ canOrder: false as const, message: semantic.message });
  }

  const roots = rootTrackIds ?? semantic.tree.rootTrackIds;
  const semanticRootSet = new Set(semantic.tree.rootTrackIds);
  if (
    roots.length !== semanticRootSet.size ||
    new Set(roots).size !== roots.length ||
    roots.some((rootId) => !semanticRootSet.has(rootId))
  ) {
    return Object.freeze({
      canOrder: false as const,
      message: 'Track Group ordering failed because root Track identities are invalid.',
    });
  }

  const orderedIds = roots.flatMap(
    (rootId) => semantic.tree.subtreeTrackIdsByRootId.get(rootId) ?? [],
  );
  const orderedTracks = orderedIds.map(
    (trackId) => semantic.tree.trackById.get(trackId)!,
  );
  const validation = buildTrackGroupTree(orderedTracks, true);

  return validation.canResolve
    ? Object.freeze({ canOrder: true as const, tracks: Object.freeze(orderedTracks) })
    : Object.freeze({ canOrder: false as const, message: validation.message });
}

export function createTrackGroupTreeFingerprint(
  tracks: readonly Track[],
): string {
  return createTreeFingerprint(tracks);
}

function buildTrackGroupTree(
  tracks: readonly Track[],
  requireCanonicalOrder: boolean,
): SemanticTreeBuild {
  if (!Array.isArray(tracks)) {
    return treeFailure(
      'identity-invalid',
      'Track Group topology is invalid: Project Tracks are unavailable.',
    );
  }

  const trackById = new Map<string, Track>();
  for (const track of tracks) {
    if (
      !track ||
      typeof track.id !== 'string' ||
      track.id.length === 0 ||
      track.id.trim() !== track.id ||
      trackById.has(track.id)
    ) {
      return treeFailure(
        'identity-invalid',
        'Track Group topology is invalid: every Track requires one unique non-empty identity.',
      );
    }
    trackById.set(track.id, track);
  }

  const declaredParents = new Map<string, string>();
  for (const track of tracks) {
    const hasGroupData = track.group !== undefined;
    const isGroupType = track.type === 'group';

    if (hasGroupData !== isGroupType) {
      return treeFailure(
        'group-invalid',
        `Track Group topology is invalid: ${track.name} has mismatched Group type and data.`,
      );
    }

    if (!track.group) continue;
    if (!Array.isArray(track.clips) || track.clips.length !== 0) {
      return treeFailure(
        'group-invalid',
        `Track Group topology is invalid: Group ${track.name} must contain zero Clips.`,
      );
    }

    const childTrackIds = track.group.childTrackIds;
    if (
      !Array.isArray(childTrackIds) ||
      childTrackIds.length === 0 ||
      childTrackIds.some(
        (trackId) =>
          typeof trackId !== 'string' ||
          trackId.length === 0 ||
          trackId.trim() !== trackId,
      ) ||
      new Set(childTrackIds).size !== childTrackIds.length ||
      track.group.playbackMode !== 'bottom_child' ||
      typeof track.group.collapsed !== 'boolean'
    ) {
      return treeFailure(
        'group-invalid',
        `Track Group topology is invalid: Group ${track.name} requires unique direct children and bottom-child state.`,
      );
    }

    if (
      track.group.activePlaybackTrackId !==
      childTrackIds[childTrackIds.length - 1]
    ) {
      return treeFailure(
        'active-child-invalid',
        `Track Group topology is invalid: Group ${track.name} must store its exact direct bottom child as active.`,
      );
    }

    for (const childTrackId of childTrackIds) {
      if (childTrackId === track.id) {
        return treeFailure(
          'cycle',
          `Track Group topology is invalid: Group ${track.name} cannot contain itself.`,
        );
      }
      if (declaredParents.has(childTrackId)) {
        return treeFailure(
          'child-invalid',
          `Track Group topology is invalid: Track ${childTrackId} is declared by multiple parents.`,
        );
      }
      declaredParents.set(childTrackId, track.id);
    }
  }

  for (const track of tracks) {
    const parentGroupId = track.parentGroupId ?? null;
    if (
      parentGroupId !== null &&
      (typeof parentGroupId !== 'string' ||
        parentGroupId.length === 0 ||
        parentGroupId.trim() !== parentGroupId)
    ) {
      return treeFailure(
        'parent-invalid',
        `Track Group topology is invalid: ${track.name} has an invalid parent identity.`,
      );
    }

    const declaredParentId = declaredParents.get(track.id) ?? null;
    if (parentGroupId !== declaredParentId) {
      return treeFailure(
        'parent-invalid',
        `Track Group topology is invalid: ${track.name} and its declared parent do not agree.`,
      );
    }

    if (parentGroupId) {
      const parent = trackById.get(parentGroupId);
      if (!parent?.group || parent.type !== 'group') {
        return treeFailure(
          'parent-invalid',
          `Track Group topology is invalid: parent ${parentGroupId} is missing or is not a Group.`,
        );
      }
    }
  }

  for (const [childTrackId, parentGroupId] of declaredParents) {
    const child = trackById.get(childTrackId);
    if (!child || child.parentGroupId !== parentGroupId) {
      return treeFailure(
        'child-invalid',
        `Track Group topology is invalid: Group ${parentGroupId} has a missing or foreign direct child.`,
      );
    }
  }

  const rootTrackIds = tracks
    .filter((track) => !track.parentGroupId)
    .map((track) => track.id);
  const state = new Map<string, 'visiting' | 'visited'>();
  const subtreeTrackIdsByRootId = new Map<string, readonly string[]>();

  const visit = (trackId: string): readonly string[] | undefined => {
    if (state.get(trackId) === 'visiting') return undefined;
    if (state.get(trackId) === 'visited') {
      return subtreeTrackIdsByRootId.get(trackId);
    }
    const track = trackById.get(trackId);
    if (!track) return undefined;
    state.set(trackId, 'visiting');
    const ids: string[] = [];
    for (const childTrackId of track.group?.childTrackIds ?? []) {
      const childIds = visit(childTrackId);
      if (!childIds) return undefined;
      ids.push(...childIds);
    }
    ids.push(trackId);
    const frozenIds = Object.freeze(ids);
    subtreeTrackIdsByRootId.set(trackId, frozenIds);
    state.set(trackId, 'visited');
    return frozenIds;
  };

  for (const rootTrackId of rootTrackIds) {
    if (!visit(rootTrackId)) {
      return treeFailure(
        'cycle',
        'Track Group topology is invalid: a cyclic child relationship was detected.',
      );
    }
  }

  if (state.size !== tracks.length) {
    return treeFailure(
      'cycle',
      'Track Group topology is invalid: one or more Tracks are cyclic or unreachable from a root.',
    );
  }

  const expectedTrackIds = rootTrackIds.flatMap(
    (rootId) => subtreeTrackIdsByRootId.get(rootId) ?? [],
  );
  if (
    requireCanonicalOrder &&
    !areStringArraysEqual(expectedTrackIds, tracks.map((track) => track.id))
  ) {
    return treeFailure(
      'canonical-order-invalid',
      'Track Group topology is invalid: complete child subtrees must immediately precede each parent Group in saved child order.',
    );
  }

  const depthByTrackId = new Map<string, number>();
  const ancestorTrackIdsByTrackId = new Map<string, readonly string[]>();
  const assignDepth = (
    trackId: string,
    depth: number,
    ancestors: readonly string[],
  ) => {
    depthByTrackId.set(trackId, depth);
    ancestorTrackIdsByTrackId.set(trackId, Object.freeze([...ancestors]));
    const track = trackById.get(trackId)!;
    for (const childTrackId of track.group?.childTrackIds ?? []) {
      assignDepth(childTrackId, depth + 1, [...ancestors, trackId]);
    }
  };
  rootTrackIds.forEach((rootTrackId) => assignDepth(rootTrackId, 0, []));

  const tree: TrackGroupTree = Object.freeze({
    ancestorTrackIdsByTrackId,
    depthByTrackId,
    rootTrackIds: Object.freeze([...rootTrackIds]),
    subtreeTrackIdsByRootId,
    trackById,
    tracks: Object.freeze([...tracks]),
  });

  return Object.freeze({ canResolve: true as const, tree });
}

function simulateTreeDeletion(
  tree: TrackGroupTree,
  initialRemovedTrackIds: Set<string>,
  looseClipIds: Set<string>,
):
  | Readonly<{ canApply: true; tracks: readonly Track[] }>
  | Readonly<{ canApply: false; message: string }> {
  const removedTrackIds = new Set(initialRemovedTrackIds);
  const trackMap = new Map<string, Track>();

  for (const track of tree.tracks) {
    if (!removedTrackIds.has(track.id)) {
      trackMap.set(track.id, {
        ...track,
        clips: track.clips.filter((clip) => !looseClipIds.has(clip.id)),
      });
    }
  }

  for (const track of tree.tracks) {
    const current = trackMap.get(track.id);
    if (!current?.group) continue;
    const childTrackIds = current.group.childTrackIds.filter(
      (childTrackId) => !removedTrackIds.has(childTrackId),
    );

    if (childTrackIds.length === 0) {
      trackMap.delete(current.id);
      removedTrackIds.add(current.id);
      continue;
    }

    trackMap.set(current.id, {
      ...current,
      group: {
        ...current.group,
        activePlaybackTrackId: childTrackIds[childTrackIds.length - 1],
        childTrackIds,
      },
    });
  }

  const rootTrackIds = tree.rootTrackIds.filter(
    (rootTrackId) => !removedTrackIds.has(rootTrackId),
  );
  const ordering = canonicalizeTrackGroupTracks(
    [...trackMap.values()],
    rootTrackIds,
  );

  return ordering.canOrder
    ? Object.freeze({ canApply: true as const, tracks: ordering.tracks })
    : Object.freeze({ canApply: false as const, message: ordering.message });
}

function replaceSelectedSiblings(
  siblingIds: readonly string[],
  selectedIds: readonly string[],
  replacementId: string,
): string[] {
  const selectedSet = new Set(selectedIds);
  const lastSelectedId = selectedIds[selectedIds.length - 1];
  return siblingIds.flatMap((siblingId) => {
    if (!selectedSet.has(siblingId)) return [siblingId];
    return siblingId === lastSelectedId ? [replacementId] : [];
  });
}

function createTrackGroupId(tracks: readonly Track[]): string {
  const usedTrackIds = new Set(tracks.map((track) => track.id));
  let groupNumber = tracks.filter(isTrackGroup).length + 1;
  let groupId = `track-group-${String(groupNumber).padStart(2, '0')}`;

  while (usedTrackIds.has(groupId)) {
    groupNumber += 1;
    groupId = `track-group-${String(groupNumber).padStart(2, '0')}`;
  }

  return groupId;
}

function createTrackGroupName(tracks: readonly Track[]): string {
  const usedTrackNames = new Set(tracks.map((track) => track.name));
  let groupNumber = tracks.filter(isTrackGroup).length + 1;
  let groupName = `Track Group ${String(groupNumber).padStart(2, '0')}`;

  while (usedTrackNames.has(groupName)) {
    groupNumber += 1;
    groupName = `Track Group ${String(groupNumber).padStart(2, '0')}`;
  }

  return groupName;
}

function createSelection(items: SelectionItem[]): SelectionState {
  return {
    anchorItem: items[0],
    items,
    lastSelectedItem: items[items.length - 1],
  };
}

function createTreeFingerprint(tracks: readonly Track[]): string {
  return stableJson(tracks);
}

function createTreeOperationFingerprint(
  tracks: readonly Track[],
  selection: SelectionState,
): string {
  return stableJson({ selection, tracks });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function treeFailure(
  reason: TrackGroupTreeFailureReason,
  message: string,
): TrackGroupTreeFailure {
  return Object.freeze({ canResolve: false as const, message, reason });
}

function groupFailure(
  message: string,
  selectedCount: number,
): Extract<TrackGroupingAvailability, { canGroup: false }> {
  return Object.freeze({ canGroup: false as const, message, selectedCount });
}

function operationFailure(message: string): Extract<
  TrackGroupingApplication,
  { canApply: false }
> {
  return Object.freeze({ canApply: false as const, message });
}

function deletionFailure(message: string): Extract<
  TimelineTreeDeletionImpact,
  { canDelete: false }
> {
  return Object.freeze({
    canDelete: false as const,
    looseClipIds: Object.freeze([]) as readonly [],
    looseClips: Object.freeze([]) as readonly [],
    message,
    removedClipCount: 0 as const,
    trackIds: Object.freeze([]) as readonly [],
    tracks: Object.freeze([]) as readonly [],
  });
}
