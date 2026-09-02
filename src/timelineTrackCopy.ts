import {
  canonicalizeTrackGroupTracks,
  createTrackGroupTreeFingerprint,
  isTrackGroup,
  resolveTrackGroupSubtree,
  resolveTrackGroupTree,
  resolveTrackGroupVisibleRows,
} from './trackGroupTree';
import type {
  Clip,
  ProjectState,
  SelectionItem,
  SelectionState,
  SoundFontAssignment,
  Track,
} from './types';

export type TrackGroupSubtreeCopyPlan = Readonly<{
  activeChildTrackId: string;
  childTrackIds: readonly string[];
  sourceFingerprint: string;
  sourceGroupTrackId: string;
  subtreeTrackIds: readonly string[];
}>;

/** Compatibility name retained for item-1 callers and saved evidence. */
export type FlatGroupTrackCopyPlan = TrackGroupSubtreeCopyPlan;

export type TrackGroupSubtreeCopyPlanningResult =
  | Readonly<{ canCopy: true; plan: TrackGroupSubtreeCopyPlan }>
  | TrackGroupSubtreeCopyFailure;

export type FlatGroupTrackCopyPlanningResult =
  TrackGroupSubtreeCopyPlanningResult;

export type TrackGroupSubtreeCopyApplicationResult =
  | Readonly<{
      canCopy: true;
      clonedChildTracks: readonly Track[];
      clonedGroupTrack: Track;
      clonedSubtreeTracks: readonly Track[];
      project: ProjectState;
    }>
  | TrackGroupSubtreeCopyFailure;

export type FlatGroupTrackCopyApplicationResult =
  TrackGroupSubtreeCopyApplicationResult;

export type TrackGroupSubtreeCopyFailure = Readonly<{
  canCopy: false;
  message: string;
  reason:
    | 'child-clip-identity-invalid'
    | 'group-identity-invalid'
    | 'stale-plan'
    | 'topology-invalid';
}>;

export type FlatGroupTrackCopyFailure = TrackGroupSubtreeCopyFailure;

export type OrdinaryTimelineTrackCopyResult =
  | Readonly<{ canCopy: true; track: Track; tracks: Track[] }>
  | Readonly<{ canCopy: false; message: string }>;

export type TimelineCopyClipInfo = Readonly<{ clip: Clip; track: Track }>;

export type TimelineCopyAvailability = Readonly<{
  canCopy: boolean;
  clipInfos: readonly TimelineCopyClipInfo[];
  groupPlan?: TrackGroupSubtreeCopyPlan;
  message: string;
  mode: 'clips' | 'group' | 'none' | 'track';
  sourceTrack?: Track;
}>;

type TrackGroupSubtreeCopyOptions = Readonly<{ createdAt?: string }>;

export function resolveTimelineCopyAvailability(
  tracks: readonly Track[],
  selection: SelectionState,
): TimelineCopyAvailability {
  const visibleRows = resolveTrackGroupVisibleRows(tracks);
  if (!visibleRows.canResolve) {
    return availabilityFailure(visibleRows.message);
  }

  const selectedClipItems = selection.items.filter((item) => item.type === 'clip');
  const selectedTrackItems = selection.items.filter((item) => item.type === 'track');
  const selectedClipIds = new Set(selectedClipItems.map((item) => item.id));
  const selectedTrackIds = new Set(selectedTrackItems.map((item) => item.id));
  const selectedClipInfos = tracks.flatMap((track) =>
    track.clips
      .filter((clip) => selectedClipIds.has(clip.id))
      .map((clip) => ({ clip, track })),
  );
  const visibleSelectedTracks = visibleRows.rows
    .map((row) => row.track)
    .filter((track) => selectedTrackIds.has(track.id));

  if (
    selectedClipItems.length !== selectedClipIds.size ||
    selectedTrackItems.length !== selectedTrackIds.size
  ) {
    return availabilityFailure(
      'Copy is unavailable because selection identities are duplicated.',
      selectedClipInfos,
    );
  }

  if (selectedClipIds.size > 0 && selectedTrackIds.size > 0) {
    return availabilityFailure(
      'Select either one Track or Clips from one Track before copying.',
      selectedClipInfos,
    );
  }

  if (selectedClipIds.size > 0) {
    if (selectedClipInfos.length !== selectedClipIds.size) {
      return availabilityFailure(
        'Copy is unavailable because a selected Clip is stale or ambiguous.',
        selectedClipInfos,
      );
    }
    const sourceTrack = selectedClipInfos[0]?.track;
    if (
      !sourceTrack ||
      selectedClipInfos.some((clipInfo) => clipInfo.track.id !== sourceTrack.id)
    ) {
      return availabilityFailure(
        'Select Clips from one Track only before copying.',
        selectedClipInfos,
      );
    }
    return Object.freeze({
      canCopy: true,
      clipInfos: Object.freeze(selectedClipInfos),
      message: `Copy ${formatCount(selectedClipInfos.length, 'Clip')} from ${sourceTrack.name} into a new Track below.`,
      mode: 'clips',
      sourceTrack,
    });
  }

  if (selectedTrackIds.size > 1) {
    return availabilityFailure('Select only one Track before copying.');
  }
  if (selectedTrackIds.size !== 1 || visibleSelectedTracks.length !== 1) {
    return availabilityFailure(
      'Select one visible Track, or Clips from one Track, before copying.',
    );
  }

  const sourceTrack = visibleSelectedTracks[0];
  if (isTrackGroup(sourceTrack)) {
    const planning = resolveTrackGroupSubtreeCopyPlan(tracks, sourceTrack.id);
    if (!planning.canCopy) {
      return Object.freeze({
        canCopy: false,
        clipInfos: Object.freeze([]),
        message: planning.message,
        mode: 'none',
        sourceTrack,
      });
    }
    return Object.freeze({
      canCopy: true,
      clipInfos: Object.freeze([]),
      groupPlan: planning.plan,
      message: `Copy Group ${sourceTrack.name} and ${formatCount(planning.plan.subtreeTrackIds.length - 1, 'descendant Track')}.`,
      mode: 'group',
      sourceTrack,
    });
  }

  return Object.freeze({
    canCopy: true,
    clipInfos: Object.freeze([]),
    message: `Copy ${sourceTrack.name} into a new Track below.`,
    mode: 'track',
    sourceTrack,
  });
}

export function resolveTrackGroupSubtreeCopyPlan(
  tracks: readonly Track[],
  sourceGroupTrackId: string,
): TrackGroupSubtreeCopyPlanningResult {
  const subtree = resolveTrackGroupSubtree(tracks, sourceGroupTrackId);
  if (!subtree.canResolve) {
    return copyFailure('topology-invalid', subtree.message);
  }
  const sourceGroup = subtree.tree.trackById.get(sourceGroupTrackId);
  if (!sourceGroup?.group || sourceGroup.type !== 'group') {
    return copyFailure(
      'group-identity-invalid',
      'Group copy requires one exact Group Track with valid Group data.',
    );
  }
  const clipIds = new Set<string>();
  const projectClipCounts = new Map<string, number>();
  tracks.forEach((track) =>
    track.clips.forEach((clip) =>
      projectClipCounts.set(clip.id, (projectClipCounts.get(clip.id) ?? 0) + 1),
    ),
  );
  for (const track of subtree.tracks) {
    for (const clip of track.clips) {
      if (
        !clip.id.trim() ||
        clipIds.has(clip.id) ||
        projectClipCounts.get(clip.id) !== 1
      ) {
        return copyFailure(
          'child-clip-identity-invalid',
          'Group copy requires every descendant Clip to have one unique Project identity.',
        );
      }
      clipIds.add(clip.id);
    }
  }
  return Object.freeze({
    canCopy: true as const,
    plan: Object.freeze({
      activeChildTrackId: sourceGroup.group.activePlaybackTrackId,
      childTrackIds: Object.freeze([...sourceGroup.group.childTrackIds]),
      sourceFingerprint: createTrackGroupTreeFingerprint(tracks),
      sourceGroupTrackId,
      subtreeTrackIds: Object.freeze([...subtree.trackIds]),
    }),
  });
}

/** Compatibility entry point retained while now supporting any valid depth. */
export function resolveFlatGroupTrackCopyPlan(
  tracks: readonly Track[],
  sourceGroupTrackId: string,
): FlatGroupTrackCopyPlanningResult {
  return resolveTrackGroupSubtreeCopyPlan(tracks, sourceGroupTrackId);
}

export function applyTrackGroupSubtreeCopyPlan(
  project: ProjectState,
  plan: TrackGroupSubtreeCopyPlan,
  { createdAt = new Date().toISOString() }: TrackGroupSubtreeCopyOptions = {},
): TrackGroupSubtreeCopyApplicationResult {
  const current = resolveTrackGroupSubtreeCopyPlan(project.tracks, plan.sourceGroupTrackId);
  if (
    !current.canCopy ||
    current.plan.sourceFingerprint !== plan.sourceFingerprint ||
    current.plan.activeChildTrackId !== plan.activeChildTrackId ||
    !areStringArraysEqual(current.plan.childTrackIds, plan.childTrackIds) ||
    !areStringArraysEqual(current.plan.subtreeTrackIds, plan.subtreeTrackIds)
  ) {
    return copyFailure(
      'stale-plan',
      'Group copy was canceled because the source subtree changed before application.',
    );
  }

  const treeResolution = resolveTrackGroupTree(project.tracks);
  if (!treeResolution.canResolve) {
    return copyFailure('topology-invalid', treeResolution.message);
  }
  const tree = treeResolution.tree;
  const sourceRoot = tree.trackById.get(plan.sourceGroupTrackId)!;
  const sourceSubtree = plan.subtreeTrackIds.map((trackId) => tree.trackById.get(trackId)!);
  const usedTrackIds = new Set(project.tracks.map((track) => track.id));
  const usedTrackNames = new Set(project.tracks.map((track) => track.name));
  const usedClipIds = new Set(
    project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  const usedClipTakeIds = collectClipTakeIds(project.tracks);
  const idMap = new Map<string, string>();
  for (const sourceTrack of sourceSubtree) {
    idMap.set(sourceTrack.id, createUniqueTrackId(usedTrackIds, `${sourceTrack.id}-copy`));
  }

  const clonedSubtreeTracks = sourceSubtree.map((sourceTrack): Track => {
    const id = idMap.get(sourceTrack.id)!;
    const parentGroupId = sourceTrack.parentGroupId
      ? idMap.get(sourceTrack.parentGroupId) ?? sourceTrack.parentGroupId
      : null;
    return {
      ...sourceTrack,
      clips: sourceTrack.clips.map((clip) =>
        createCopiedTimelineClip(clip, usedClipIds, createdAt, usedClipTakeIds),
      ),
      group: sourceTrack.group
        ? {
            ...sourceTrack.group,
            activePlaybackTrackId: idMap.get(sourceTrack.group.activePlaybackTrackId)!,
            childTrackIds: sourceTrack.group.childTrackIds.map(
              (childTrackId) => idMap.get(childTrackId)!,
            ),
          }
        : undefined,
      id,
      name: createCopyTrackName(usedTrackNames, sourceTrack.name),
      parentGroupId,
    };
  });
  const clonedGroupTrack = clonedSubtreeTracks.find(
    (track) => track.id === idMap.get(sourceRoot.id),
  )!;
  const clonedTrackMap = new Map(clonedSubtreeTracks.map((track) => [track.id, track]));
  const clonedChildTracks = clonedGroupTrack.group!.childTrackIds.map(
    (trackId) => clonedTrackMap.get(trackId)!,
  );
  const trackMap = new Map(tree.trackById);
  clonedSubtreeTracks.forEach((track) => trackMap.set(track.id, track));
  let rootTrackIds = [...tree.rootTrackIds];

  if (sourceRoot.parentGroupId) {
    const parent = trackMap.get(sourceRoot.parentGroupId);
    if (!parent?.group) {
      return copyFailure(
        'stale-plan',
        'Group copy was canceled because the parent Group is unavailable.',
      );
    }
    const sourceIndex = parent.group.childTrackIds.indexOf(sourceRoot.id);
    const childTrackIds = [
      ...parent.group.childTrackIds.slice(0, sourceIndex + 1),
      clonedGroupTrack.id,
      ...parent.group.childTrackIds.slice(sourceIndex + 1),
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
    const sourceIndex = rootTrackIds.indexOf(sourceRoot.id);
    rootTrackIds = [
      ...rootTrackIds.slice(0, sourceIndex + 1),
      clonedGroupTrack.id,
      ...rootTrackIds.slice(sourceIndex + 1),
    ];
  }

  const ordering = canonicalizeTrackGroupTracks([...trackMap.values()], rootTrackIds);
  if (!ordering.canOrder) {
    return copyFailure('topology-invalid', ordering.message);
  }
  const selectionItem: SelectionItem = { id: clonedGroupTrack.id, type: 'track' };
  return Object.freeze({
    canCopy: true as const,
    clonedChildTracks: Object.freeze(clonedChildTracks),
    clonedGroupTrack,
    clonedSubtreeTracks: Object.freeze(clonedSubtreeTracks),
    project: {
      ...project,
      selection: {
        anchorItem: selectionItem,
        items: [selectionItem],
        lastSelectedItem: selectionItem,
      },
      tracks: [...ordering.tracks],
    },
  });
}

/** Compatibility entry point retained while now cloning recursive subtrees. */
export function applyFlatGroupTrackCopyPlan(
  project: ProjectState,
  plan: FlatGroupTrackCopyPlan,
  options: TrackGroupSubtreeCopyOptions = {},
): FlatGroupTrackCopyApplicationResult {
  return applyTrackGroupSubtreeCopyPlan(project, plan, options);
}

export function copyOrdinaryTimelineTrack(
  tracks: readonly Track[],
  sourceTrackId: string,
  sourceClipIds?: readonly string[],
  createdAt = new Date().toISOString(),
): OrdinaryTimelineTrackCopyResult {
  const topology = resolveTrackGroupTree(tracks);
  if (!topology.canResolve) {
    return Object.freeze({ canCopy: false as const, message: topology.message });
  }
  const sourceTrack = topology.tree.trackById.get(sourceTrackId);
  if (!sourceTrack || isTrackGroup(sourceTrack)) {
    return Object.freeze({
      canCopy: false as const,
      message: 'Track copy requires one exact non-Group source Track.',
    });
  }
  const selectedClipIds = sourceClipIds === undefined ? undefined : new Set(sourceClipIds);
  const sourceClips = selectedClipIds
    ? sourceTrack.clips.filter((clip) => selectedClipIds.has(clip.id))
    : sourceTrack.clips;
  if (
    selectedClipIds &&
    (selectedClipIds.size === 0 ||
      selectedClipIds.size !== sourceClipIds?.length ||
      sourceClips.length !== selectedClipIds.size)
  ) {
    return Object.freeze({
      canCopy: false as const,
      message: 'Track copy requires exact unique source Clips from one Track.',
    });
  }

  const usedTrackIds = new Set(tracks.map((track) => track.id));
  const usedTrackNames = new Set(tracks.map((track) => track.name));
  const usedClipIds = new Set(tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  const usedClipTakeIds = collectClipTakeIds(tracks);
  const copiedTrack: Track = {
    ...sourceTrack,
    clips: sourceClips.map((clip) => createCopiedTimelineClip(clip, usedClipIds, createdAt, usedClipTakeIds)),
    group: undefined,
    id: createUniqueTrackId(usedTrackIds, `${sourceTrack.id}-copy`),
    name: createCopyTrackName(usedTrackNames, sourceTrack.name),
    parentGroupId: sourceTrack.parentGroupId ?? null,
  };
  const trackMap = new Map(topology.tree.trackById);
  trackMap.set(copiedTrack.id, copiedTrack);
  let rootTrackIds = [...topology.tree.rootTrackIds];

  if (sourceTrack.parentGroupId) {
    const parent = trackMap.get(sourceTrack.parentGroupId);
    if (!parent?.group) {
      return Object.freeze({
        canCopy: false as const,
        message: 'Track copy requires one valid direct parent Group.',
      });
    }
    const sourceIndex = parent.group.childTrackIds.indexOf(sourceTrack.id);
    const childTrackIds = [
      ...parent.group.childTrackIds.slice(0, sourceIndex + 1),
      copiedTrack.id,
      ...parent.group.childTrackIds.slice(sourceIndex + 1),
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
    const sourceIndex = rootTrackIds.indexOf(sourceTrack.id);
    rootTrackIds = [
      ...rootTrackIds.slice(0, sourceIndex + 1),
      copiedTrack.id,
      ...rootTrackIds.slice(sourceIndex + 1),
    ];
  }

  const ordering = canonicalizeTrackGroupTracks([...trackMap.values()], rootTrackIds);
  return ordering.canOrder
    ? Object.freeze({ canCopy: true as const, track: copiedTrack, tracks: [...ordering.tracks] })
    : Object.freeze({ canCopy: false as const, message: ordering.message });
}

export function createCopiedTimelineClip(
  clip: Clip,
  usedClipIds: Set<string>,
  createdAt: string,
  usedClipTakeIds: Set<string>,
): Clip {
  const id = createUniqueClipId(usedClipIds, `clip-copy-${clip.id}`);
  usedClipIds.add(id);
  // A stale active choice must not become valid by coinciding with a new ID.
  if (clip.activeClipTakeId) usedClipTakeIds.add(clip.activeClipTakeId);
  const copiedTakeIdBySourceId = new Map<string, string>();
  // Takes belong to one Clip; source Artifact references and provenance stay shared.
  const clipTakes = clip.clipTakes?.map((take) => {
    const clipTakeId = createUniqueClipTakeId(usedClipTakeIds, take.clipTakeId);
    copiedTakeIdBySourceId.set(take.clipTakeId, clipTakeId);
    return { ...take, clipTakeId };
  });
  return {
    ...clip,
    activeClipTakeId: copiedTakeIdBySourceId.get(clip.activeClipTakeId ?? '') ?? clip.activeClipTakeId,
    appliedTabFlows: [],
    clipTakes,
    createdAt,
    exportManifest: undefined,
    id,
    name: `${clip.name} Copy`,
    parameterSnapshot: clip.parameterSnapshot ? { ...clip.parameterSnapshot } : undefined,
    soundFont: cloneSoundFontAssignment(clip.soundFont),
    version: 1,
  };
}

function collectClipTakeIds(tracks: readonly Track[]): Set<string> {
  return new Set(tracks.flatMap((track) => track.clips.flatMap(
    (clip) => clip.clipTakes?.map((take) => take.clipTakeId) ?? [],
  )));
}

function createUniqueClipTakeId(usedClipTakeIds: Set<string>, sourceClipTakeId: string): string {
  let number = 1;
  let id = `${sourceClipTakeId}-copy-${number}`;
  while (usedClipTakeIds.has(id)) {
    number += 1;
    id = `${sourceClipTakeId}-copy-${number}`;
  }
  usedClipTakeIds.add(id);
  return id;
}

function createUniqueTrackId(usedTrackIds: Set<string>, baseId: string): string {
  const safeBaseId = sanitizeIdPart(baseId) || 'track-copy';
  let number = usedTrackIds.size + 1;
  let id = `${safeBaseId}-${String(number).padStart(2, '0')}`;
  while (usedTrackIds.has(id)) {
    number += 1;
    id = `${safeBaseId}-${String(number).padStart(2, '0')}`;
  }
  usedTrackIds.add(id);
  return id;
}

function createUniqueClipId(usedClipIds: Set<string>, baseId: string): string {
  const safeBaseId = sanitizeIdPart(baseId) || 'clip-copy';
  let number = 1;
  let id = `${safeBaseId}-${number}`;
  while (usedClipIds.has(id)) {
    number += 1;
    id = `${safeBaseId}-${number}`;
  }
  return id;
}

function createCopyTrackName(usedTrackNames: Set<string>, sourceTrackName: string): string {
  const baseName = `${sourceTrackName} Copy`;
  let number = 1;
  let name = baseName;
  while (usedTrackNames.has(name)) {
    number += 1;
    name = `${baseName} ${number}`;
  }
  usedTrackNames.add(name);
  return name;
}

function cloneSoundFontAssignment(soundFont: SoundFontAssignment | undefined): SoundFontAssignment | undefined {
  return soundFont ? { ...soundFont, resource: { ...soundFont.resource } } : undefined;
}

function sanitizeIdPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function copyFailure(
  reason: TrackGroupSubtreeCopyFailure['reason'],
  message: string,
): TrackGroupSubtreeCopyFailure {
  return Object.freeze({ canCopy: false as const, message, reason });
}

function availabilityFailure(
  message: string,
  clipInfos: readonly TimelineCopyClipInfo[] = [],
): TimelineCopyAvailability {
  return Object.freeze({
    canCopy: false,
    clipInfos: Object.freeze([...clipInfos]),
    message,
    mode: 'none',
  });
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
