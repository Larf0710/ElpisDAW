import { describe, expect, it } from 'vitest';

import { resolveAutoPatchTargetClipIds } from './autoPatchTargetResolution';
import type { Clip, ProjectState, Track } from './types';

describe('resolveAutoPatchTargetClipIds', () => {
  it('gives Track selection priority and expands selected Groups in Project order', () => {
    const project = createSelectionProject();
    project.selection = {
      items: [
        { type: 'clip', id: 'clip-loose' },
        { type: 'track', id: 'group-1' },
      ],
    };

    expect(resolveAutoPatchTargetClipIds(project)).toEqual({
      canResolve: true,
      source: 'track-selection',
      targetClipIds: ['clip-child-a', 'clip-child-b'],
    });
  });

  it('resolves Clip selection in stable Track and Clip order', () => {
    const project = createSelectionProject();
    project.selection = {
      items: [
        { type: 'clip', id: 'clip-loose' },
        { type: 'clip', id: 'clip-child-a' },
        { type: 'clip', id: 'clip-loose' },
      ],
    };

    expect(resolveAutoPatchTargetClipIds(project)).toEqual({
      canResolve: true,
      source: 'clip-selection',
      targetClipIds: ['clip-child-a', 'clip-loose'],
    });
  });

  it('uses one valid fallback only when canonical selection is empty', () => {
    const project = createSelectionProject();

    expect(
      resolveAutoPatchTargetClipIds(project, 'clip-child-b'),
    ).toEqual({
      canResolve: true,
      source: 'fallback-clip',
      targetClipIds: ['clip-child-b'],
    });

    project.selection = {
      items: [{ type: 'clip', id: 'clip-loose' }],
    };

    expect(
      resolveAutoPatchTargetClipIds(project, 'clip-child-b'),
    ).toMatchObject({
      source: 'clip-selection',
      targetClipIds: ['clip-loose'],
    });
  });

  it('does not fall through from a selected empty Track to a fallback Clip', () => {
    const project = createSelectionProject();
    project.tracks.push(createTrack('track-empty', []));
    project.selection = {
      items: [{ type: 'track', id: 'track-empty' }],
    };

    expect(
      resolveAutoPatchTargetClipIds(project, 'clip-loose'),
    ).toMatchObject({
      canResolve: false,
      reason: 'no-targets',
    });
  });

  it('rejects ambiguous target and fallback Clip identity', () => {
    const selectedProject = createSelectionProject();
    selectedProject.tracks.push(
      createTrack('track-duplicate', [createClip('clip-child-a')]),
    );
    selectedProject.selection = {
      items: [{ type: 'track', id: 'track-child-a' }],
    };

    expect(resolveAutoPatchTargetClipIds(selectedProject)).toMatchObject({
      canResolve: false,
      reason: 'ambiguous-clip-id',
    });

    selectedProject.selection = {
      items: [{ type: 'clip', id: 'clip-child-a' }],
    };

    expect(resolveAutoPatchTargetClipIds(selectedProject)).toMatchObject({
      canResolve: false,
      reason: 'ambiguous-clip-id',
    });

    const fallbackProject = createSelectionProject();
    fallbackProject.tracks.push(
      createTrack('track-duplicate', [createClip('clip-loose')]),
    );

    expect(
      resolveAutoPatchTargetClipIds(fallbackProject, 'clip-loose'),
    ).toMatchObject({
      canResolve: false,
      reason: 'ambiguous-clip-id',
    });
  });

  it('returns immutable target order without exposing selection arrays', () => {
    const project = createSelectionProject();
    project.selection = {
      items: [{ type: 'track', id: 'group-1' }],
    };
    const resolution = resolveAutoPatchTargetClipIds(project);

    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.targetClipIds)).toBe(true);
    project.selection.items.push({ type: 'clip', id: 'clip-loose' });
    expect(resolution.targetClipIds).toEqual([
      'clip-child-a',
      'clip-child-b',
    ]);
  });
});

function createSelectionProject(): Pick<
  ProjectState,
  'selection' | 'tracks'
> {
  const childA = createTrack('track-child-a', [
    createClip('clip-child-a'),
  ]);
  const childB = createTrack('track-child-b', [
    createClip('clip-child-b'),
  ]);
  const group: Track = {
    id: 'group-1',
    name: 'Group',
    type: 'group',
    level: 1,
    clips: [],
    group: {
      activePlaybackTrackId: childB.id,
      childTrackIds: [childA.id, childB.id],
      collapsed: false,
      playbackMode: 'bottom_child',
    },
  };

  return {
    selection: { items: [] },
    tracks: [
      group,
      childA,
      childB,
      createTrack('track-loose', [createClip('clip-loose')]),
    ],
  };
}

function createTrack(id: string, clips: Clip[]): Track {
  return {
    id,
    name: id,
    type: 'midi',
    level: 1,
    clips,
  };
}

function createClip(id: string): Clip {
  return {
    id,
    type: 'midi-notes',
    name: id,
    startTick: 0,
    lengthTicks: 1_920,
    color: '#255fff',
    createdAt: '2026-07-31T05:00:00.000Z',
    version: 1,
  };
}
