import { describe, expect, it } from 'vitest';

import {
  createProjectStemPrintTargetKey,
  listProjectStemPrintTargetOptions,
  resolveProjectStemPrintSelection,
  toggleProjectStemPrintTarget,
} from './projectStemPrintSelection';
import { sampleProject } from './sampleProject';
import type { ProjectState, Track } from './types';

describe('Project Stem Print target selection', () => {
  it('lists Mixer Channels first and Groups in stable Project order', () => {
    const project = createProject();
    const catalog = listProjectStemPrintTargetOptions(project);

    expect(catalog).toMatchObject({
      canList: true,
      options: [
        { key: 'channel:track-a', label: 'Channel A', resolvedTrackId: 'track-a' },
        { key: 'channel:track-b', label: 'Channel B', resolvedTrackId: 'track-b' },
        { key: 'group:group-a', label: 'Group A', resolvedTrackId: 'track-b' },
      ],
    });
  });

  it('never exposes the fixed Master Track as a printable Channel target', () => {
    const project = createProject();
    project.tracks.push({
      clips: [],
      id: 'master-track',
      level: 0,
      name: 'Master',
      type: 'master',
    });

    const catalog = listProjectStemPrintTargetOptions(project);

    expect(catalog.canList).toBe(true);
    expect(catalog.options).not.toContainEqual(
      expect.objectContaining({ key: 'channel:master-track' }),
    );
  });

  it('retains explicit target identity while exposing Group active-Channel lineage', () => {
    const project = createProject();
    const catalog = listProjectStemPrintTargetOptions(project);
    if (!catalog.canList) throw new Error(catalog.message);

    expect(catalog.options[2]).toMatchObject({
      canSelect: true,
      target: { groupTrackId: 'group-a', kind: 'group' },
    });
    expect(catalog.options[2]?.target).toEqual({
      groupTrackId: 'group-a',
      kind: 'group',
    });
  });

  it('canonicalizes selection to Mixer/Project order rather than click order', () => {
    const project = createProject();
    const resolution = resolveProjectStemPrintSelection(project, [
      { kind: 'channel', trackId: 'track-b' },
      { kind: 'channel', trackId: 'track-a' },
    ]);

    expect(resolution).toEqual({
      canResolve: true,
      selectedKeys: ['channel:track-a', 'channel:track-b'],
      targets: [
        { kind: 'channel', trackId: 'track-a' },
        { kind: 'channel', trackId: 'track-b' },
      ],
    });
  });

  it('toggles one target without mutating caller selection', () => {
    const project = createProject();
    const original = Object.freeze([{ kind: 'channel' as const, trackId: 'track-a' }]);
    const added = toggleProjectStemPrintTarget(project, original, {
      kind: 'channel',
      trackId: 'track-b',
    });
    const removed = toggleProjectStemPrintTarget(project, original, original[0]);

    expect(original).toEqual([{ kind: 'channel', trackId: 'track-a' }]);
    expect(added).toMatchObject({
      canResolve: true,
      selectedKeys: ['channel:track-a', 'channel:track-b'],
    });
    expect(removed).toEqual({ canResolve: true, selectedKeys: [], targets: [] });
  });

  it('rejects duplicate target identity', () => {
    expect(
      resolveProjectStemPrintSelection(createProject(), [
        { kind: 'channel', trackId: 'track-a' },
        { kind: 'channel', trackId: 'track-a' },
      ]),
    ).toMatchObject({ canResolve: false, reason: 'target-duplicated' });
  });

  it('rejects direct Channel and Group targets that resolve to the same Channel', () => {
    expect(
      resolveProjectStemPrintSelection(createProject(), [
        { kind: 'channel', trackId: 'track-b' },
        { groupTrackId: 'group-a', kind: 'group' },
      ]),
    ).toMatchObject({
      canResolve: false,
      reason: 'resolved-channel-duplicated',
    });
  });

  it('rejects missing Channels and Groups', () => {
    const project = createProject();
    expect(
      resolveProjectStemPrintSelection(project, [
        { kind: 'channel', trackId: 'missing' },
      ]),
    ).toMatchObject({ canResolve: false, reason: 'target-unavailable' });
    expect(
      resolveProjectStemPrintSelection(project, [
        { groupTrackId: 'missing', kind: 'group' },
      ]),
    ).toMatchObject({ canResolve: false, reason: 'target-unavailable' });
  });

  it('keeps unresolved Groups visible but disabled with an honest message', () => {
    const project = createProject();
    project.tracks.find((track) => track.id === 'track-b')!.parentGroupId = undefined;
    const catalog = listProjectStemPrintTargetOptions(project);
    if (!catalog.canList) throw new Error(catalog.message);

    expect(catalog.options[2]).toMatchObject({
      canSelect: false,
      key: 'group:group-a',
    });
    expect(catalog.options[2]?.message).toContain('declared parent do not agree');
  });

  it('fails closed when Mixer state is structurally invalid', () => {
    const project = createProject();
    project.mixer = { schemaVersion: 999 } as never;

    expect(listProjectStemPrintTargetOptions(project)).toMatchObject({
      canList: false,
      options: [],
    });
    expect(resolveProjectStemPrintSelection(project, [])).toMatchObject({
      canResolve: false,
      reason: 'mixer-invalid',
    });
  });

  it('creates stable non-overlapping keys for Channel and Group identities', () => {
    expect(createProjectStemPrintTargetKey({ kind: 'channel', trackId: 'same' })).toBe(
      'channel:same',
    );
    expect(
      createProjectStemPrintTargetKey({ groupTrackId: 'same', kind: 'group' }),
    ).toBe('group:same');
  });
});

function createProject(): ProjectState {
  const project = clone(sampleProject);
  const channelA = createTrack('track-a', 'Channel A');
  const channelB = createTrack('track-b', 'Channel B', 'group-a');
  const group: Track = {
    clips: [],
    group: {
      activePlaybackTrackId: 'track-b',
      childTrackIds: ['track-b'],
      collapsed: false,
      playbackMode: 'bottom_child',
    },
    id: 'group-a',
    level: 0,
    name: 'Group A',
    type: 'group',
  };
  project.mixer = undefined;
  project.tracks = [channelA, channelB, group];
  return project;
}

function createTrack(id: string, name: string, parentGroupId?: string): Track {
  return {
    clips: [],
    id,
    level: 0,
    name,
    ...(parentGroupId ? { parentGroupId } : {}),
    type: 'audio',
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
