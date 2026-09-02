import { describe, expect, it } from 'vitest';

import {
  applyFlatGroupTrackCopyPlan,
  copyOrdinaryTimelineTrack,
  resolveFlatGroupTrackCopyPlan,
  resolveTimelineCopyAvailability,
} from './timelineTrackCopy';
import { reconcileProjectMixerState } from './projectMixerState';
import { resolveGroupPlaybackTrack } from './playbackTarget';
import {
  commitSessionEdit,
  createSessionEditHistory,
  redoSessionEdit,
  undoSessionEdit,
  type SessionEditEntry,
} from './sessionEditHistory';
import { sampleProject } from './sampleProject';
import type { Clip, ProjectState, Track } from './types';

const copiedAt = '2026-08-16T14:30:00.000Z';

describe('recursive Group Track copy planning', () => {
  it('makes exactly one visible valid Group available through Timeline COPY', () => {
    const project = createGroupCopyProject();
    expect(
      resolveTimelineCopyAvailability(project.tracks, project.selection),
    ).toMatchObject({
      canCopy: true,
      groupPlan: { sourceGroupTrackId: 'group-1' },
      mode: 'group',
      sourceTrack: { id: 'group-1' },
    });
  });

  it('rejects mixed, multi-Track, stale, and hidden additional Track selection', () => {
    const project = createGroupCopyProject();
    const selections = [
      {
        items: [
          { id: 'group-1', type: 'track' as const },
          { id: 'clip-a-1', type: 'clip' as const },
        ],
      },
      {
        items: [
          { id: 'group-1', type: 'track' as const },
          { id: 'tail', type: 'track' as const },
        ],
      },
      { items: [{ id: 'stale-track', type: 'track' as const }] },
    ];
    requireGroup(project).collapsed = true;
    selections.push({
      items: [
        { id: 'group-1', type: 'track' as const },
        { id: 'child-a', type: 'track' as const },
      ],
    });

    for (const selection of selections) {
      expect(
        resolveTimelineCopyAvailability(project.tracks, selection),
      ).toMatchObject({ canCopy: false, mode: 'none' });
    }
  });

  it('surfaces an exact topology reason before COPY application', () => {
    const project = createGroupCopyProject();
    requireGroup(project).activePlaybackTrackId = 'missing-child';
    expect(
      resolveTimelineCopyAvailability(project.tracks, project.selection),
    ).toMatchObject({
      canCopy: false,
      message: expect.stringContaining('exact direct bottom child'),
      mode: 'none',
    });
  });

  it('accepts one exact Group with ordered direct children and bottom-child playback', () => {
    const project = createGroupCopyProject();
    const result = resolveFlatGroupTrackCopyPlan(project.tracks, 'group-1');

    expect(result).toMatchObject({
      canCopy: true,
      plan: {
        activeChildTrackId: 'child-b',
        childTrackIds: ['child-a', 'child-b'],
        sourceGroupTrackId: 'group-1',
      },
    });
    if (!result.canCopy) throw new Error(result.message);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.childTrackIds)).toBe(true);
  });

  it.each([
    [
      'missing Group data',
      (project: ProjectState) => {
        findTrack(project, 'group-1').group = undefined;
      },
      'topology-invalid',
    ],
    [
      'orphaned nested source Group',
      (project: ProjectState) => {
        findTrack(project, 'group-1').parentGroupId = 'outer-group';
      },
      'topology-invalid',
    ],
    [
      'container Clip',
      (project: ProjectState) => {
        findTrack(project, 'group-1').clips.push(createClip('group-clip'));
      },
      'topology-invalid',
    ],
    [
      'empty children',
      (project: ProjectState) => {
        requireGroup(project).childTrackIds = [];
      },
      'topology-invalid',
    ],
    [
      'duplicate child identity',
      (project: ProjectState) => {
        requireGroup(project).childTrackIds = ['child-a', 'child-a'];
      },
      'topology-invalid',
    ],
    [
      'missing child Track',
      (project: ProjectState) => {
        project.tracks = project.tracks.filter((track) => track.id !== 'child-a');
      },
      'topology-invalid',
    ],
    [
      'foreign child parent',
      (project: ProjectState) => {
        findTrack(project, 'child-a').parentGroupId = 'foreign-group';
      },
      'topology-invalid',
    ],
    [
      'nested child Group',
      (project: ProjectState) => {
        const child = findTrack(project, 'child-a');
        child.type = 'group';
        child.group = {
          activePlaybackTrackId: 'nested-leaf',
          childTrackIds: ['nested-leaf'],
          collapsed: true,
          playbackMode: 'bottom_child',
        };
      },
      'topology-invalid',
    ],
    [
      'undeclared direct child',
      (project: ProjectState) => {
        findTrack(project, 'tail').parentGroupId = 'group-1';
      },
      'topology-invalid',
    ],
    [
      'missing active child',
      (project: ProjectState) => {
        requireGroup(project).activePlaybackTrackId = 'missing-child';
      },
      'topology-invalid',
    ],
    [
      'non-bottom active child',
      (project: ProjectState) => {
        requireGroup(project).activePlaybackTrackId = 'child-a';
      },
      'topology-invalid',
    ],
    [
      'reversed physical child order',
      (project: ProjectState) => {
        const childAIndex = project.tracks.findIndex((track) => track.id === 'child-a');
        const childBIndex = project.tracks.findIndex((track) => track.id === 'child-b');
        [project.tracks[childAIndex], project.tracks[childBIndex]] = [
          project.tracks[childBIndex],
          project.tracks[childAIndex],
        ];
      },
      'topology-invalid',
    ],
    [
      'ambiguous child Clip identity',
      (project: ProjectState) => {
        findTrack(project, 'child-b').clips[0].id = 'clip-a-1';
      },
      'child-clip-identity-invalid',
    ],
  ] as const)('rejects %s without applying a partial clone', (_label, mutate, reason) => {
    const project = createGroupCopyProject();
    mutate(project);
    const before = JSON.stringify(project);

    expect(resolveFlatGroupTrackCopyPlan(project.tracks, 'group-1')).toMatchObject({
      canCopy: false,
      reason,
    });
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe('recursive Group Track copy application', () => {
  it('recursively clones every nested Group, Track, and Clip with no shared identity', () => {
    const project = createNestedGroupCopyProject();
    const planning = resolveFlatGroupTrackCopyPlan(project.tracks, 'outer-group');
    if (!planning.canCopy) throw new Error(planning.message);
    const result = applyFlatGroupTrackCopyPlan(project, planning.plan, { createdAt: copiedAt });

    if (!result.canCopy) throw new Error(result.message);
    expect(result.clonedSubtreeTracks).toHaveLength(5);
    const sourceTrackIds = new Set(['child-a', 'child-b', 'group-1', 'tail', 'outer-group']);
    const sourceClipIds = new Set(['clip-a-1', 'clip-a-2', 'clip-b-1', 'clip-tail']);
    expect(result.clonedSubtreeTracks.every((track) => !sourceTrackIds.has(track.id))).toBe(true);
    expect(result.clonedSubtreeTracks.flatMap((track) => track.clips).every(
      (clip) => !sourceClipIds.has(clip.id),
    )).toBe(true);
    const clonedInner = result.clonedSubtreeTracks.find(
      (track) => track.name === 'Vocal Group Copy',
    )!;
    const clonedTail = result.clonedSubtreeTracks.find((track) => track.name === 'Tail Copy')!;
    expect(clonedInner.parentGroupId).toBe(result.clonedGroupTrack.id);
    expect(clonedTail.parentGroupId).toBe(result.clonedGroupTrack.id);
    expect(result.clonedGroupTrack.group).toMatchObject({
      activePlaybackTrackId: clonedTail.id,
      childTrackIds: [clonedInner.id, clonedTail.id],
    });
    expect(clonedInner.group?.childTrackIds.every((id) => !sourceTrackIds.has(id))).toBe(true);
  });

  it('copies a nested Group as the next sibling and repairs the parent bottom-child identity', () => {
    const project = createNestedGroupCopyProject();
    const planning = resolveFlatGroupTrackCopyPlan(project.tracks, 'group-1');
    if (!planning.canCopy) throw new Error(planning.message);
    const result = applyFlatGroupTrackCopyPlan(project, planning.plan, { createdAt: copiedAt });

    if (!result.canCopy) throw new Error(result.message);
    const outer = findTrack(result.project, 'outer-group');
    expect(outer.group?.childTrackIds).toEqual([
      'group-1',
      result.clonedGroupTrack.id,
      'tail',
    ]);
    expect(outer.group?.activePlaybackTrackId).toBe('tail');
    expect(result.clonedGroupTrack.parentGroupId).toBe('outer-group');
    expect(result.project.selection.items).toEqual([
      { id: result.clonedGroupTrack.id, type: 'track' },
    ]);
  });

  it('atomically remaps Group, child Track, Clip, parent, and active-child identities', () => {
    const project = createGroupCopyProject();
    const sourceSnapshot = JSON.stringify(project);
    const unrelated = findTrack(project, 'unrelated');
    const sourceGroup = findTrack(project, 'group-1');
    const sourceChildA = findTrack(project, 'child-a');
    const sourceChildB = findTrack(project, 'child-b');
    const plan = requirePlan(project);
    const result = applyFlatGroupTrackCopyPlan(project, plan, { createdAt: copiedAt });

    expect(result.canCopy).toBe(true);
    if (!result.canCopy) throw new Error(result.message);
    expect(JSON.stringify(project)).toBe(sourceSnapshot);
    expect(result.project.tracks[0]).toBe(unrelated);
    expect(findTrack(result.project, 'group-1')).toBe(sourceGroup);
    expect(findTrack(result.project, 'child-a')).toBe(sourceChildA);
    expect(findTrack(result.project, 'child-b')).toBe(sourceChildB);

    const cloneIds = [
      result.clonedGroupTrack.id,
      ...result.clonedChildTracks.map((track) => track.id),
    ];
    expect(new Set(cloneIds).size).toBe(3);
    expect(cloneIds).not.toContain('group-1');
    expect(cloneIds).not.toContain('child-a');
    expect(cloneIds).not.toContain('child-b');
    expect(result.clonedGroupTrack).toMatchObject({
      clips: [],
      group: {
        activePlaybackTrackId: result.clonedChildTracks[1].id,
        childTrackIds: result.clonedChildTracks.map((track) => track.id),
        collapsed: false,
        playbackMode: 'bottom_child',
      },
      level: -3,
      muted: true,
      name: 'Vocal Group Copy',
      parentGroupId: null,
      type: 'group',
    });
    expect(result.clonedChildTracks[0]).toMatchObject({
      level: -8,
      muted: false,
      name: 'Lead Vocal Copy',
      parentGroupId: result.clonedGroupTrack.id,
      type: 'audio',
    });
    expect(result.clonedChildTracks[1]).toMatchObject({
      level: -4,
      muted: true,
      name: 'Harmony Copy',
      parentGroupId: result.clonedGroupTrack.id,
      type: 'midi',
    });
    expect(result.project.selection.items).toEqual([
      { id: result.clonedGroupTrack.id, type: 'track' },
    ]);
  });

  it('inserts one contiguous child block and Group immediately below the source Group', () => {
    const project = createGroupCopyProject();
    const result = applyFlatGroupTrackCopyPlan(project, requirePlan(project), {
      createdAt: copiedAt,
    });

    if (!result.canCopy) throw new Error(result.message);
    expect(result.project.tracks.map((track) => track.id)).toEqual([
      'unrelated',
      'child-a',
      'child-b',
      'group-1',
      result.clonedChildTracks[0].id,
      result.clonedChildTracks[1].id,
      result.clonedGroupTrack.id,
      'tail',
    ]);
  });

  it('uses ordinary Clip-copy semantics while sharing canonical source lineage references', () => {
    const project = createGroupCopyProject();
    const sourceAudioClip = findTrack(project, 'child-a').clips[0];
    const sourceMidiClip = findTrack(project, 'child-b').clips[0];
    const result = applyFlatGroupTrackCopyPlan(project, requirePlan(project), {
      createdAt: copiedAt,
    });

    if (!result.canCopy) throw new Error(result.message);
    const copiedAudioClip = result.clonedChildTracks[0].clips[0];
    const copiedMidiClip = result.clonedChildTracks[1].clips[0];

    expect(copiedAudioClip).toMatchObject({
      activeClipTakeId: copiedAudioClip.clipTakes![0].clipTakeId,
      appliedTabFlows: [],
      createdAt: copiedAt,
      exportManifest: undefined,
      name: `${sourceAudioClip.name} Copy`,
      version: 1,
    });
    expect(copiedAudioClip.id).not.toBe(sourceAudioClip.id);
    expect(copiedAudioClip.sourceFile).toBe(sourceAudioClip.sourceFile);
    expect(copiedAudioClip.clipTakes).not.toBe(sourceAudioClip.clipTakes);
    expect(copiedAudioClip.activeClipTakeId).not.toBe(sourceAudioClip.activeClipTakeId);
    expect({ ...copiedAudioClip.clipTakes![0], clipTakeId: sourceAudioClip.activeClipTakeId })
      .toEqual(sourceAudioClip.clipTakes![0]);
    expect(copiedAudioClip.parameterSnapshot).not.toBe(
      sourceAudioClip.parameterSnapshot,
    );
    expect(copiedMidiClip.soundFont).not.toBe(sourceMidiClip.soundFont);
    expect(copiedMidiClip.soundFont?.resource).not.toBe(
      sourceMidiClip.soundFont?.resource,
    );
    expect(
      new Set(
        result.clonedChildTracks.flatMap((track) =>
          track.clips.map((clip) => clip.id),
        ),
      ).size,
    ).toBe(3);
  });

  it('fails a stale Plan with the exact original Project and selection unchanged', () => {
    const project = createGroupCopyProject();
    const plan = requirePlan(project);
    findTrack(project, 'child-a').level = -7;
    const before = JSON.stringify(project);
    const result = applyFlatGroupTrackCopyPlan(project, plan, {
      createdAt: copiedAt,
    });

    expect(result).toMatchObject({ canCopy: false, reason: 'stale-plan' });
    expect(JSON.stringify(project)).toBe(before);
  });

  it('allocates collision-free Track, Clip, and Copy-label identities', () => {
    const project = createGroupCopyProject();
    project.tracks.push(
      createTrack('group-1-copy-09', 'Vocal Group Copy', 'audio', []),
      createTrack('child-a-copy-10', 'Lead Vocal Copy', 'audio', [
        createClip('clip-copy-clip-a-1-1'),
      ]),
    );
    const result = applyFlatGroupTrackCopyPlan(project, requirePlan(project), {
      createdAt: copiedAt,
    });

    if (!result.canCopy) throw new Error(result.message);
    const trackIds = result.project.tracks.map((track) => track.id);
    const trackNames = result.project.tracks.map((track) => track.name);
    const clipIds = result.project.tracks.flatMap((track) =>
      track.clips.map((clip) => clip.id),
    );
    expect(new Set(trackIds).size).toBe(trackIds.length);
    expect(new Set(clipIds).size).toBe(clipIds.length);
    expect(result.clonedGroupTrack.name).toBe('Vocal Group Copy 2');
    expect(result.clonedChildTracks[0].name).toBe('Lead Vocal Copy 2');
    expect(trackNames.filter((name) => name === 'Vocal Group Copy')).toHaveLength(1);
  });

  it('reconciles independent child Mixer Channels while keeping both Groups as proxies', () => {
    const project = createGroupCopyProject();
    const result = applyFlatGroupTrackCopyPlan(project, requirePlan(project), {
      createdAt: copiedAt,
    });

    if (!result.canCopy) throw new Error(result.message);
    const reconciled = reconcileProjectMixerState(result.project);
    const channelIds = reconciled.mixer?.channels.map((channel) => channel.trackId);
    expect(channelIds).not.toContain('group-1');
    expect(channelIds).not.toContain(result.clonedGroupTrack.id);
    expect(channelIds).toEqual(
      reconciled.tracks
        .filter((track) => track.type !== 'group' && !track.group)
        .map((track) => track.id),
    );
    for (const childTrack of result.clonedChildTracks) {
      expect(channelIds).toContain(childTrack.id);
    }
    expect(
      reconciled.mixer?.channels.find(
        (channel) => channel.trackId === result.clonedChildTracks[0].id,
      ),
    ).not.toBe(
      reconciled.mixer?.channels.find((channel) => channel.trackId === 'child-a'),
    );
  });

  it('keeps source and clone playback isolated on their own mapped bottom children', () => {
    const project = createGroupCopyProject();
    const result = applyFlatGroupTrackCopyPlan(project, requirePlan(project), {
      createdAt: copiedAt,
    });

    if (!result.canCopy) throw new Error(result.message);
    const sourceResolution = resolveGroupPlaybackTrack(
      findTrack(result.project, 'group-1'),
      result.project.tracks,
    );
    const cloneResolution = resolveGroupPlaybackTrack(
      result.clonedGroupTrack,
      result.project.tracks,
    );
    expect(sourceResolution).toMatchObject({
      canResolve: true,
      storedActiveTrackMatches: true,
      activeTrack: { id: 'child-b' },
    });
    expect(cloneResolution).toMatchObject({
      canResolve: true,
      storedActiveTrackMatches: true,
      activeTrack: { id: result.clonedChildTracks[1].id },
    });
    result.clonedChildTracks[1].muted = false;
    expect(findTrack(result.project, 'child-b').muted).toBe(true);
  });

  it('commits, undoes, and redoes the whole Group subtree as one history frame', () => {
    const project = createGroupCopyProject();
    const copied = applyFlatGroupTrackCopyPlan(project, requirePlan(project), {
      createdAt: copiedAt,
    });
    if (!copied.canCopy) throw new Error(copied.message);
    const history = createSessionEditHistory(project, createEntry('open', 'Open Project'));
    const committed = commitSessionEdit(
      history,
      copied.project,
      createEntry('copy-group', 'Copy Group: Vocal Group'),
      80,
    );
    const undone = undoSessionEdit(committed);
    expect(committed.past).toHaveLength(1);
    expect(undone.status).toBe('MOVED');
    if (undone.status !== 'MOVED') throw new Error(undone.status);
    expect(undone.history.present.value.tracks).toHaveLength(project.tracks.length);
    expect(undone.history.present.value.selection).toEqual(project.selection);
    const redone = redoSessionEdit(undone.history, 80);
    expect(redone.status).toBe('MOVED');
    if (redone.status !== 'MOVED') throw new Error(redone.status);
    expect(redone.history.present.value.tracks).toHaveLength(
      project.tracks.length + 3,
    );
    expect(redone.history.present.value.selection.items).toEqual([
      { id: copied.clonedGroupTrack.id, type: 'track' },
    ]);
  });
});

describe('ordinary Timeline Track and Clip copy regressions', () => {
  it('copies one top-level Track with all Clips below the source', () => {
    const project = createGroupCopyProject();
    const result = copyOrdinaryTimelineTrack(
      project.tracks,
      'tail',
      undefined,
      copiedAt,
    );

    if (!result.canCopy) throw new Error(result.message);
    const sourceIndex = result.tracks.findIndex((track) => track.id === 'tail');
    expect(result.tracks[sourceIndex + 1]).toBe(result.track);
    expect(result.track).toMatchObject({
      clips: [{ name: 'Tail Clip Copy' }],
      name: 'Tail Copy',
      parentGroupId: null,
    });
  });

  it('copies only the selected Clips into one new Track', () => {
    const project = createGroupCopyProject();
    const result = copyOrdinaryTimelineTrack(
      project.tracks,
      'child-a',
      ['clip-a-2'],
      copiedAt,
    );

    if (!result.canCopy) throw new Error(result.message);
    expect(result.track.clips).toHaveLength(1);
    expect(result.track.clips[0].name).toBe('Lead Outro Copy');
  });

  it('copies one child Track inside its existing Group without changing Group identity', () => {
    const project = createGroupCopyProject();
    const sourceGroup = findTrack(project, 'group-1');
    const result = copyOrdinaryTimelineTrack(
      project.tracks,
      'child-a',
      undefined,
      copiedAt,
    );

    if (!result.canCopy) throw new Error(result.message);
    const nextGroup = result.tracks.find((track) => track.id === 'group-1');
    expect(nextGroup).not.toBe(sourceGroup);
    expect(nextGroup?.group?.childTrackIds).toEqual([
      'child-a',
      result.track.id,
      'child-b',
    ]);
    expect(result.track.parentGroupId).toBe('group-1');
    expect(sourceGroup.group?.childTrackIds).toEqual(['child-a', 'child-b']);
  });

  it('reasserts the parent Group active bottom child when the copied child becomes last', () => {
    const project = createGroupCopyProject();
    const result = copyOrdinaryTimelineTrack(
      project.tracks,
      'child-b',
      undefined,
      copiedAt,
    );

    if (!result.canCopy) throw new Error(result.message);
    const group = result.tracks.find((track) => track.id === 'group-1');
    expect(group?.group?.childTrackIds).toEqual(['child-a', 'child-b', result.track.id]);
    expect(group?.group?.activePlaybackTrackId).toBe(result.track.id);
  });
});

function createGroupCopyProject(): ProjectState {
  const project = clone(sampleProject);
  const childA = createTrack('child-a', 'Lead Vocal', 'audio', [
    {
      ...createClip('clip-a-1', 'Lead Verse'),
      activeClipTakeId: 'take-a-1',
      appliedTabFlows: [
        {
          appliedAt: copiedAt,
          runId: 'run-a',
          sourceConnectionIds: ['connection-a'],
          tabFlowLineId: 'line-a',
          tabFlowLineName: 'Line A',
          tabFlowLineRevision: 1,
        },
      ],
      clipTakes: [
        {
          artifactId: 'artifact-a-1',
          clipTakeId: 'take-a-1',
          createdAt: copiedAt,
          label: 'Recording Take 01',
          mediaType: 'audio',
          sourceType: 'recording',
        },
      ],
      exportManifest: {
        createdAt: copiedAt,
        durationTicks: 960,
        estimatedFileName: 'lead.wav',
        format: 'WAV',
        id: 'mock-export-a',
        normalize: 'ON',
        sourceClipId: 'clip-a-1',
        status: 'mock-ready',
        targetClipId: 'clip-a-1',
        version: 1,
      },
      parameterSnapshot: { sensitivity: 72 },
      sourceFile: {
        name: 'lead.wav',
        relativePath: 'recordings/lead.wav',
        sourceId: 'source-lead',
        status: 'available',
      },
    },
    createClip('clip-a-2', 'Lead Outro'),
  ]);
  childA.level = -8;
  childA.muted = false;
  childA.parentGroupId = 'group-1';
  const childB = createTrack('child-b', 'Harmony', 'midi', [
    {
      ...createClip('clip-b-1', 'Harmony Notes'),
      soundFont: {
        bank: 0,
        program: 52,
        resource: {
          format: 'sf2',
          library: 'project',
          relativePath: 'soundfonts/choir.sf2',
          resourceId: 'soundfont-choir',
        },
      },
    },
  ]);
  childB.level = -4;
  childB.muted = true;
  childB.parentGroupId = 'group-1';
  const group = createTrack('group-1', 'Vocal Group', 'group', []);
  group.level = -3;
  group.muted = true;
  group.group = {
    activePlaybackTrackId: 'child-b',
    childTrackIds: ['child-a', 'child-b'],
    collapsed: false,
    playbackMode: 'bottom_child',
  };
  const unrelated = createTrack('unrelated', 'Unrelated', 'audio', []);
  const tail = createTrack('tail', 'Tail', 'audio', [
    createClip('clip-tail', 'Tail Clip'),
  ]);

  project.tracks = [unrelated, childA, childB, group, tail];
  project.selection = {
    anchorItem: { id: group.id, type: 'track' },
    items: [{ id: group.id, type: 'track' }],
    lastSelectedItem: { id: group.id, type: 'track' },
  };
  project.mixer = undefined;
  return project;
}

function createNestedGroupCopyProject(): ProjectState {
  const project = createGroupCopyProject();
  const group = findTrack(project, 'group-1');
  const tail = findTrack(project, 'tail');
  group.parentGroupId = 'outer-group';
  tail.parentGroupId = 'outer-group';
  const outer = createTrack('outer-group', 'Outer Group', 'group', []);
  outer.group = {
    activePlaybackTrackId: tail.id,
    childTrackIds: [group.id, tail.id],
    collapsed: true,
    playbackMode: 'bottom_child',
  };
  project.tracks.push(outer);
  project.selection = {
    anchorItem: { id: outer.id, type: 'track' },
    items: [{ id: outer.id, type: 'track' }],
    lastSelectedItem: { id: outer.id, type: 'track' },
  };
  return project;
}

function createTrack(
  id: string,
  name: string,
  type: Track['type'],
  clips: Clip[],
): Track {
  return { clips, id, level: 0, name, parentGroupId: null, type };
}

function createClip(id: string, name = id): Clip {
  return {
    color: '#ffffff',
    createdAt: '2026-08-16T14:00:00.000Z',
    id,
    lengthTicks: 960,
    name,
    startTick: 0,
    type: 'hum-audio',
    version: 1,
  };
}

function findTrack(project: ProjectState, trackId: string): Track {
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`Track fixture missing: ${trackId}`);
  return track;
}

function requireGroup(project: ProjectState): NonNullable<Track['group']> {
  const group = findTrack(project, 'group-1').group;
  if (!group) throw new Error('Group fixture missing.');
  return group;
}

function requirePlan(project: ProjectState) {
  const planning = resolveFlatGroupTrackCopyPlan(project.tracks, 'group-1');
  if (!planning.canCopy) throw new Error(planning.message);
  return planning.plan;
}

function createEntry(id: string, label: string): SessionEditEntry {
  return {
    category: 'track',
    createdAt: copiedAt,
    id,
    label,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
