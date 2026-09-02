import { describe, expect, it } from 'vitest';

import { resolveGroupPlaybackTrack } from './playbackTarget';
import { reconcileProjectMixerState } from './projectMixerState';
import {
  commitSessionEdit,
  createSessionEditHistory,
  redoSessionEdit,
  undoSessionEdit,
} from './sessionEditHistory';
import {
  applyTimelineTreeDeletionPlan,
  applyTrackGroupCollapsedState,
  applyTrackGroupingPlan,
  applyTrackUngroupPlan,
  resolveTimelineTreeDeletion,
  resolveTrackGroupingPlan,
  resolveTrackGroupPlaybackLeaf,
  resolveTrackGroupSubtree,
  resolveTrackGroupTree,
  resolveTrackGroupVisibleRows,
  resolveTrackUngroupPlan,
} from './trackGroupTree';
import { sampleProject } from './sampleProject';
import type { Clip, ProjectState, SelectionItem, SelectionState, Track } from './types';

const editTime = '2026-08-17T00:40:00.000Z';

describe('Track Group tree topology', () => {
  it('resolves arbitrary finite depth, ancestors, descendants, roots, and canonical postorder', () => {
    const project = createNestedProject();
    const result = resolveTrackGroupTree(project.tracks);

    expect(result.canResolve).toBe(true);
    if (!result.canResolve) throw new Error(result.message);
    expect(result.tree.rootTrackIds).toEqual(['loose', 'outer', 'tail']);
    expect(result.tree.depthByTrackId.get('leaf-a')).toBe(3);
    expect(result.tree.ancestorTrackIdsByTrackId.get('leaf-a')).toEqual([
      'outer',
      'middle',
      'inner',
    ]);
    expect(result.tree.subtreeTrackIdsByRootId.get('outer')).toEqual([
      'leaf-a',
      'leaf-b',
      'inner',
      'sibling',
      'middle',
      'outer-leaf',
      'outer',
    ]);
    expect(project.tracks.map((track) => track.id)).toEqual([
      'loose',
      'leaf-a',
      'leaf-b',
      'inner',
      'sibling',
      'middle',
      'outer-leaf',
      'outer',
      'tail',
    ]);
  });

  it.each([
    ['duplicate Track identity', (tracks: Track[]) => { tracks[1].id = 'loose'; }, 'identity-invalid'],
    ['Group type without data', (tracks: Track[]) => { findTrack(tracks, 'inner').group = undefined; }, 'group-invalid'],
    ['Group data on ordinary Track', (tracks: Track[]) => { findTrack(tracks, 'leaf-a').group = clone(findTrack(tracks, 'inner').group); }, 'group-invalid'],
    ['Group container Clip', (tracks: Track[]) => { findTrack(tracks, 'inner').clips.push(createClip('bad')); }, 'group-invalid'],
    ['duplicate direct child', (tracks: Track[]) => { requireGroup(tracks, 'inner').childTrackIds = ['leaf-a', 'leaf-a']; }, 'group-invalid'],
    ['missing direct child', (tracks: Track[]) => { tracks.splice(tracks.findIndex((track) => track.id === 'leaf-b'), 1); }, 'child-invalid'],
    ['foreign parent backlink', (tracks: Track[]) => { findTrack(tracks, 'leaf-a').parentGroupId = 'middle'; }, 'parent-invalid'],
    ['stale active child', (tracks: Track[]) => { requireGroup(tracks, 'inner').activePlaybackTrackId = 'leaf-a'; }, 'active-child-invalid'],
    ['noncanonical physical order', (tracks: Track[]) => { [tracks[1], tracks[2]] = [tracks[2], tracks[1]]; }, 'canonical-order-invalid'],
  ] as const)('rejects %s fail-closed', (_label, mutate, reason) => {
    const tracks = createNestedProject().tracks;
    mutate(tracks);
    expect(resolveTrackGroupTree(tracks)).toMatchObject({ canResolve: false, reason });
  });

  it('rejects self-parent and multi-Group cycles', () => {
    const self = createGroup('self', ['self'], 'self', 'self');
    expect(resolveTrackGroupTree([self])).toMatchObject({ canResolve: false, reason: 'cycle' });

    const groupA = createGroup('group-a', ['group-b'], 'group-b', 'group-b');
    const groupB = createGroup('group-b', ['group-a'], 'group-a', 'group-a');
    expect(resolveTrackGroupTree([groupA, groupB])).toMatchObject({ canResolve: false, reason: 'cycle' });
  });

  it('preserves valid nested and historical flat topology across serialized reopen', () => {
    const nested = createNestedProject().tracks;
    const flat = nested
      .filter((track) => ['leaf-a', 'leaf-b', 'inner'].includes(track.id))
      .map((track) => track.id === 'inner' ? { ...track, parentGroupId: null } : track);
    const reopenedNested = clone(nested);
    const reopenedFlat = clone(flat);

    expect(reopenedNested).toEqual(nested);
    expect(reopenedFlat).toEqual(flat);
    expect(resolveTrackGroupTree(reopenedNested)).toMatchObject({ canResolve: true });
    expect(resolveTrackGroupTree(reopenedFlat)).toMatchObject({ canResolve: true });
  });
});

describe('recursive visibility and collapse selection', () => {
  it('hides a row when any ancestor is collapsed without changing nested collapse state', () => {
    const project = createNestedProject();
    requireGroup(project.tracks, 'inner').collapsed = true;
    let rows = requireRows(project.tracks);
    expect(rows.map((row) => row.track.id)).toEqual([
      'loose', 'inner', 'sibling', 'middle', 'outer-leaf', 'outer', 'tail',
    ]);

    requireGroup(project.tracks, 'outer').collapsed = true;
    rows = requireRows(project.tracks);
    expect(rows.map((row) => row.track.id)).toEqual(['loose', 'outer', 'tail']);
    requireGroup(project.tracks, 'outer').collapsed = false;
    rows = requireRows(project.tracks);
    expect(rows.map((row) => row.track.id)).not.toContain('leaf-a');
    expect(requireGroup(project.tracks, 'inner').collapsed).toBe(true);
  });

  it('moves any recursive descendant Track or Clip selection to the collapsed Group', () => {
    const project = createNestedProject();
    project.selection = selection({ id: 'clip-a', type: 'clip' });
    const result = applyTrackGroupCollapsedState(project, 'outer');

    expect(result.canApply).toBe(true);
    if (!result.canApply) throw new Error(result.message);
    expect(result.collapsed).toBe(true);
    expect(result.project.selection.items).toEqual([{ id: 'outer', type: 'track' }]);
    expect(project.selection.items).toEqual([{ id: 'clip-a', type: 'clip' }]);
  });

  it('renders malformed saved topology safely as unindented rows while mutations remain blocked', () => {
    const project = createNestedProject();
    requireGroup(project.tracks, 'inner').activePlaybackTrackId = 'leaf-a';
    const rows = resolveTrackGroupVisibleRows(project.tracks);
    expect(rows.canResolve).toBe(false);
    expect(rows.rows).toHaveLength(project.tracks.length);
    expect(rows.rows.every((row) => row.depth === 0)).toBe(true);
    expect(resolveTrackGroupingPlan(project.tracks, project.selection).canGroup).toBe(false);
  });
});

describe('recursive Track grouping and ungrouping', () => {
  it('groups non-adjacent top-level sibling roots at the last selected position', () => {
    const project = createNestedProject();
    project.selection = selection(
      { id: 'loose', type: 'track' },
      { id: 'tail', type: 'track' },
    );
    const planning = resolveTrackGroupingPlan(project.tracks, project.selection);
    expect(planning).toMatchObject({ canGroup: true, selectedCount: 2 });
    if (!planning.canGroup) throw new Error(planning.message);
    const result = applyTrackGroupingPlan(project, planning.plan);
    expect(result.canApply).toBe(true);
    if (!result.canApply) throw new Error(result.message);

    expect(result.groupTrack.group?.childTrackIds).toEqual(['loose', 'tail']);
    expect(result.groupTrack.parentGroupId).toBeNull();
    expect(result.project.tracks.map((track) => track.id)).toEqual([
      'leaf-a', 'leaf-b', 'inner', 'sibling', 'middle', 'outer-leaf', 'outer',
      'loose', 'tail', result.groupTrack.id,
    ]);
    expect(result.project.selection.items).toEqual([{ id: result.groupTrack.id, type: 'track' }]);
  });

  it('groups ordinary and Group sibling roots inside a parent and preserves complete subtrees', () => {
    const project = createNestedProject();
    project.selection = selection(
      { id: 'inner', type: 'track' },
      { id: 'sibling', type: 'track' },
    );
    const planning = resolveTrackGroupingPlan(project.tracks, project.selection);
    if (!planning.canGroup) throw new Error(planning.message);
    const result = applyTrackGroupingPlan(project, planning.plan);
    if (!result.canApply) throw new Error(result.message);

    expect(result.groupTrack.parentGroupId).toBe('middle');
    expect(result.groupTrack.group?.childTrackIds).toEqual(['inner', 'sibling']);
    expect(requireGroup(result.project.tracks, 'middle').childTrackIds).toEqual([
      result.groupTrack.id,
    ]);
    expect(requireGroup(result.project.tracks, 'middle').activePlaybackTrackId).toBe(result.groupTrack.id);
    expect(resolveTrackGroupSubtree(result.project.tracks, result.groupTrack.id)).toMatchObject({
      canResolve: true,
      trackIds: ['leaf-a', 'leaf-b', 'inner', 'sibling', result.groupTrack.id],
    });
  });

  it('rejects cross-parent, ancestor/descendant, hidden, duplicate, and stale selection', () => {
    const project = createNestedProject();
    const selections = [
      selection({ id: 'inner', type: 'track' }, { id: 'outer-leaf', type: 'track' }),
      selection({ id: 'outer', type: 'track' }, { id: 'middle', type: 'track' }),
      selection({ id: 'inner', type: 'track' }, { id: 'inner', type: 'track' }),
      selection({ id: 'missing', type: 'track' }, { id: 'tail', type: 'track' }),
    ];
    requireGroup(project.tracks, 'middle').collapsed = true;
    selections.push(selection({ id: 'inner', type: 'track' }, { id: 'sibling', type: 'track' }));
    for (const candidate of selections) {
      expect(resolveTrackGroupingPlan(project.tracks, candidate).canGroup).toBe(false);
    }
  });

  it('rejects a stale grouping Plan with no Project mutation', () => {
    const project = createNestedProject();
    project.selection = selection({ id: 'loose', type: 'track' }, { id: 'tail', type: 'track' });
    const planning = resolveTrackGroupingPlan(project.tracks, project.selection);
    if (!planning.canGroup) throw new Error(planning.message);
    findTrack(project.tracks, 'tail').level = -11;
    const before = JSON.stringify(project);
    expect(applyTrackGroupingPlan(project, planning.plan)).toMatchObject({ canApply: false });
    expect(JSON.stringify(project)).toBe(before);
  });

  it('ungroups a nested Group in place and reparents only its direct children', () => {
    const project = createNestedProject();
    const planning = resolveTrackUngroupPlan(project.tracks, 'inner');
    if (!planning.canUngroup) throw new Error(planning.message);
    const result = applyTrackUngroupPlan(project, planning.plan);
    if (!result.canApply) throw new Error(result.message);

    expect(result.project.tracks.some((track) => track.id === 'inner')).toBe(false);
    expect(findTrack(result.project.tracks, 'leaf-a').parentGroupId).toBe('middle');
    expect(findTrack(result.project.tracks, 'leaf-b').parentGroupId).toBe('middle');
    expect(requireGroup(result.project.tracks, 'middle').childTrackIds).toEqual([
      'leaf-a', 'leaf-b', 'sibling',
    ]);
    expect(requireGroup(result.project.tracks, 'middle').activePlaybackTrackId).toBe('sibling');
    expect(result.project.selection.items).toEqual([
      { id: 'leaf-a', type: 'track' }, { id: 'leaf-b', type: 'track' },
    ]);
  });

  it('ungroups a top-level Group while preserving child subtrees and root order', () => {
    const project = createNestedProject();
    const planning = resolveTrackUngroupPlan(project.tracks, 'outer');
    if (!planning.canUngroup) throw new Error(planning.message);
    const result = applyTrackUngroupPlan(project, planning.plan);
    if (!result.canApply) throw new Error(result.message);
    const topology = resolveTrackGroupTree(result.project.tracks);
    if (!topology.canResolve) throw new Error(topology.message);
    expect(topology.tree.rootTrackIds).toEqual(['loose', 'middle', 'outer-leaf', 'tail']);
    expect(findTrack(result.project.tracks, 'middle').parentGroupId).toBeNull();
    expect(findTrack(result.project.tracks, 'inner').parentGroupId).toBe('middle');
  });
});

describe('recursive deletion, history, Mixer, and playback', () => {
  it('deletes one ordinary nested child and repairs the surviving direct parent', () => {
    const project = createNestedProject();
    project.selection = selection({ id: 'leaf-a', type: 'track' });
    const impact = resolveTimelineTreeDeletion(project.tracks, project.selection);
    if (!impact.canDelete) throw new Error(impact.message);
    const result = applyTimelineTreeDeletionPlan(project, impact.plan);
    if (!result.canApply) throw new Error(result.message);

    expect(result.project.tracks.some((track) => track.id === 'leaf-a')).toBe(false);
    expect(requireGroup(result.project.tracks, 'inner').childTrackIds).toEqual(['leaf-b']);
    expect(requireGroup(result.project.tracks, 'inner').activePlaybackTrackId).toBe('leaf-b');
    expect(findTrack(result.project.tracks, 'leaf-b').parentGroupId).toBe('inner');
    expect(resolveTrackGroupTree(result.project.tracks)).toMatchObject({ canResolve: true });
  });

  it('recursively deletes a selected nested Group subtree and repairs every survivor', () => {
    const project = createNestedProject();
    project.selection = selection({ id: 'inner', type: 'track' });
    const impact = resolveTimelineTreeDeletion(project.tracks, project.selection);
    if (!impact.canDelete) throw new Error(impact.message);
    expect(impact.trackIds).toEqual(['leaf-a', 'leaf-b', 'inner']);
    expect(impact.removedClipCount).toBe(2);
    const result = applyTimelineTreeDeletionPlan(project, impact.plan);
    if (!result.canApply) throw new Error(result.message);
    expect(requireGroup(result.project.tracks, 'middle').childTrackIds).toEqual(['sibling']);
    expect(requireGroup(result.project.tracks, 'middle').activePlaybackTrackId).toBe('sibling');
    expect(resolveTrackGroupTree(result.project.tracks).canResolve).toBe(true);
  });

  it('removes recursively emptied ancestor Groups after direct child deletion', () => {
    const project = createNestedProject();
    project.selection = selection(
      { id: 'leaf-a', type: 'track' },
      { id: 'leaf-b', type: 'track' },
      { id: 'sibling', type: 'track' },
      { id: 'outer-leaf', type: 'track' },
    );
    const impact = resolveTimelineTreeDeletion(project.tracks, project.selection);
    if (!impact.canDelete) throw new Error(impact.message);
    expect(impact.trackIds).toEqual([
      'leaf-a', 'leaf-b', 'inner', 'sibling', 'middle', 'outer-leaf', 'outer',
    ]);
    const result = applyTimelineTreeDeletionPlan(project, impact.plan);
    if (!result.canApply) throw new Error(result.message);
    expect(result.project.tracks.map((track) => track.id)).toEqual(['loose', 'tail']);
  });

  it('commits, undoes, and redoes a nested grouping as one edit frame', () => {
    const project = createNestedProject();
    project.selection = selection({ id: 'inner', type: 'track' }, { id: 'sibling', type: 'track' });
    const planning = resolveTrackGroupingPlan(project.tracks, project.selection);
    if (!planning.canGroup) throw new Error(planning.message);
    const grouped = applyTrackGroupingPlan(project, planning.plan);
    if (!grouped.canApply) throw new Error(grouped.message);
    const history = createSessionEditHistory(project, edit('open'));
    const committed = commitSessionEdit(history, grouped.project, edit('group'), 80);
    const undone = undoSessionEdit(committed);
    expect(undone.status).toBe('MOVED');
    if (undone.status !== 'MOVED') return;
    expect(undone.history.present.value).toEqual(project);
    const redone = redoSessionEdit(undone.history, 80);
    expect(redone.status).toBe('MOVED');
    if (redone.status !== 'MOVED') return;
    expect(redone.history.present.value).toEqual(grouped.project);
  });

  it('resolves recursive bottom-child playback to one ordinary leaf and keeps Groups as Mixer proxies', () => {
    const project = createNestedProject();
    const leaf = resolveTrackGroupPlaybackLeaf(project.tracks, 'outer');
    expect(leaf).toMatchObject({
      canResolve: true,
      activeTrack: { id: 'outer-leaf' },
      storedActiveTrackMatches: true,
    });
    const middle = resolveGroupPlaybackTrack(findTrack(project.tracks, 'middle'), project.tracks);
    expect(middle).toMatchObject({ canResolve: true, activeTrack: { id: 'sibling' } });
    const reconciled = reconcileProjectMixerState(project);
    const channelIds = reconciled.mixer?.channels.map((channel) => channel.trackId) ?? [];
    expect(channelIds).toEqual(['loose', 'leaf-a', 'leaf-b', 'sibling', 'outer-leaf', 'tail']);
    expect(channelIds).not.toContain('inner');
    expect(channelIds).not.toContain('middle');
    expect(channelIds).not.toContain('outer');
  });
});

function createNestedProject(): ProjectState {
  const project = clone(sampleProject);
  const loose = createTrack('loose');
  const leafA = createTrack('leaf-a', 'inner', [createClip('clip-a')]);
  const leafB = createTrack('leaf-b', 'inner', [createClip('clip-b')]);
  const inner = createGroup('inner', ['leaf-a', 'leaf-b'], 'leaf-b', 'middle');
  const sibling = createTrack('sibling', 'middle');
  const middle = createGroup('middle', ['inner', 'sibling'], 'sibling', 'outer');
  const outerLeaf = createTrack('outer-leaf', 'outer');
  const outer = createGroup('outer', ['middle', 'outer-leaf'], 'outer-leaf');
  const tail = createTrack('tail');

  project.tracks = [loose, leafA, leafB, inner, sibling, middle, outerLeaf, outer, tail];
  project.selection = selection({ id: 'outer', type: 'track' });
  project.mixer = undefined;
  return project;
}

function createTrack(id: string, parentGroupId: string | null = null, clips: Clip[] = []): Track {
  return { clips, id, level: -3, muted: false, name: id, parentGroupId, type: 'audio' };
}

function createGroup(
  id: string,
  childTrackIds: string[],
  activePlaybackTrackId: string,
  parentGroupId: string | null = null,
): Track {
  return {
    clips: [],
    group: { activePlaybackTrackId, childTrackIds, collapsed: false, playbackMode: 'bottom_child' },
    id,
    level: -3,
    muted: false,
    name: id,
    parentGroupId,
    type: 'group',
  };
}

function createClip(id: string): Clip {
  return { color: '#fff', createdAt: editTime, id, lengthTicks: 960, name: id, startTick: 0, type: 'hum-audio', version: 1 };
}

function selection(...items: SelectionItem[]): SelectionState {
  return { anchorItem: items[0], items, lastSelectedItem: items[items.length - 1] };
}

function findTrack(tracks: readonly Track[], id: string): Track {
  const track = tracks.find((candidate) => candidate.id === id);
  if (!track) throw new Error(`Missing Track fixture: ${id}`);
  return track;
}

function requireGroup(tracks: readonly Track[], id: string): NonNullable<Track['group']> {
  const group = findTrack(tracks, id).group;
  if (!group) throw new Error(`Missing Group fixture: ${id}`);
  return group;
}

function requireRows(tracks: readonly Track[]) {
  const rows = resolveTrackGroupVisibleRows(tracks);
  if (!rows.canResolve) throw new Error(rows.message);
  return rows.rows;
}

function edit(id: string) {
  return { category: 'track' as const, createdAt: editTime, id, label: id };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
