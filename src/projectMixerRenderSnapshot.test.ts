import { describe, expect, it } from 'vitest';

import {
  assertProjectMixerRenderSnapshotV2,
  createProjectMixerRenderSnapshot,
  createProjectMixerRenderSnapshotV2,
  PROJECT_MIXER_RENDER_SNAPSHOT_VERSION,
  PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2,
  ProjectMixerEffectsExecutionUnavailableError,
} from './projectMixerRenderSnapshot';
import {
  normalizeProjectMixerState,
  PROJECT_MIXER_MASTER_BUS_ID,
  PROJECT_MIXER_STATE_VERSION_V1,
  ProjectMixerStateError,
} from './projectMixerState';
import type { ProjectMixerStateV1, ProjectMixerStateV2, Track } from './types';

describe('Project Mixer Render Snapshot', () => {
  it('captures and deeply freezes every persistent v0.1 Mixer render field', () => {
    const track = createTrack('vocal', 12, true);
    const mixer = createMixer([
      {
        faderDb: -4.5,
        inserts: [],
        muted: false,
        outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
        pan: -0.25,
        solo: true,
        trackId: track.id,
      },
    ], -1.5);

    const snapshot = createProjectMixerRenderSnapshot({ mixer, tracks: [track] });

    expect(snapshot).toEqual({
      channels: mixer.channels,
      master: mixer.master,
      schemaVersion: PROJECT_MIXER_RENDER_SNAPSHOT_VERSION,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.channels)).toBe(true);
    expect(Object.isFrozen(snapshot.channels[0])).toBe(true);
    expect(Object.isFrozen(snapshot.channels[0].inserts)).toBe(true);
    expect(Object.isFrozen(snapshot.master)).toBe(true);
    expect(Object.isFrozen(snapshot.master.inserts)).toBe(true);
  });

  it('excludes Group containers and retains eligible child Channel identity', () => {
    const child = { ...createTrack('child', -7, false), parentGroupId: 'group-a' };
    const group = createGroupTrack('group-a', [child.id]);
    const r61Mixer = createMixer([
      createChannel(child.id, { faderDb: -7 }),
      createChannel(group.id, { faderDb: 9 }),
    ]);

    const snapshot = createProjectMixerRenderSnapshot({
      mixer: r61Mixer,
      tracks: [child, group],
    });

    expect(snapshot.channels.map(({ trackId }) => trackId)).toEqual([child.id]);
    expect(snapshot.channels[0].faderDb).toBe(-7);
  });

  it('does not change when caller-owned Tracks and Mixer objects change later', () => {
    const track = createTrack('vocal', -3, false);
    const channel = createChannel(track.id, { faderDb: -3, pan: 0.5 });
    const mutableChannels = [channel];
    const mixer = createMixer(mutableChannels);
    const snapshot = createProjectMixerRenderSnapshot({ mixer, tracks: [track] });

    track.level = 6;
    (channel as { faderDb: number; pan: number }).faderDb = 8;
    (channel as { faderDb: number; pan: number }).pan = -1;
    (mixer.master as { faderDb: number }).faderDb = 5;
    mutableChannels.splice(0, mutableChannels.length);

    expect(snapshot.channels[0]).toMatchObject({ faderDb: -3, pan: 0.5 });
    expect(snapshot.master.faderDb).toBe(0);
  });

  it('fails closed when saved Mixer state is incomplete or unsupported', () => {
    const track = createTrack('vocal', 0, false);

    expect(() =>
      createProjectMixerRenderSnapshot({
        mixer: createMixer([]),
        tracks: [track],
      }),
    ).toThrow(ProjectMixerStateError);
    expect(() =>
      createProjectMixerRenderSnapshot({
        mixer: { schemaVersion: 2 } as unknown as ProjectMixerStateV1,
        tracks: [track],
      }),
    ).toThrow(ProjectMixerStateError);
  });

  it('keeps the production v1 Snapshot sound-equivalent for default-bypassed v2 state', () => {
    const track = createTrack('vocal', -3, false);
    const mixer = normalizeProjectMixerState([track], undefined).mixer;
    const snapshot = createProjectMixerRenderSnapshot({ mixer, tracks: [track] });

    expect(snapshot).toEqual({
      channels: [{
        faderDb: -3,
        inserts: [],
        muted: false,
        outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
        pan: 0,
        solo: false,
        trackId: 'vocal',
      }],
      master: {
        busId: PROJECT_MIXER_MASTER_BUS_ID,
        faderDb: 0,
        inserts: [],
      },
      schemaVersion: PROJECT_MIXER_RENDER_SNAPSHOT_VERSION,
    });
  });

  it('fails the compatibility path closed when any Channel or Master effect is enabled', () => {
    const track = createTrack('vocal', 0, false);
    const mixer = normalizeProjectMixerState([track], undefined).mixer;
    const channelEnabled = withEnabledChannelEqualizer(mixer);
    const masterEnabled = withEnabledMasterLimiter(mixer);

    expect(() =>
      createProjectMixerRenderSnapshot({ mixer: channelEnabled, tracks: [track] }),
    ).toThrow(ProjectMixerEffectsExecutionUnavailableError);
    expect(() =>
      createProjectMixerRenderSnapshot({ mixer: masterEnabled, tracks: [track] }),
    ).toThrow(ProjectMixerEffectsExecutionUnavailableError);
  });

  it('builds an isolated deeply immutable Snapshot v2 with exact effect state only', () => {
    const track = createTrack('vocal', -2, false);
    const mutableMixer = JSON.parse(JSON.stringify(
      normalizeProjectMixerState([track], undefined).mixer,
    )) as ProjectMixerStateV2;
    const snapshot = createProjectMixerRenderSnapshotV2({
      mixer: mutableMixer,
      tracks: [track],
    });

    expect(snapshot.schemaVersion).toBe(PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2);
    expect(snapshot.channels[0].inserts.map(({ effectType }) => effectType)).toEqual([
      'equalizer',
      'compressor',
      'echo-delay',
    ]);
    expect(snapshot.master.inserts.map(({ effectType }) => effectType)).toEqual([
      'equalizer',
      'compressor',
      'limiter',
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.channels)).toBe(true);
    expect(Object.isFrozen(snapshot.channels[0].inserts)).toBe(true);
    expect(Object.isFrozen(snapshot.channels[0].inserts[0])).toBe(true);
    expect(Object.isFrozen(snapshot.channels[0].inserts[0].parameters)).toBe(true);
    expect(Object.isFrozen(snapshot.master.inserts[2].parameters)).toBe(true);
    expect(Object.keys(snapshot.channels[0].inserts[0]).sort()).toEqual([
      'algorithmId',
      'algorithmVersion',
      'bypass',
      'effectType',
      'parameters',
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /runtimeMeter|processorState|ringBuffer/i,
    );
    expect(() => assertProjectMixerRenderSnapshotV2(snapshot)).not.toThrow();

    (mutableMixer.channels[0].inserts[0] as { bypass: boolean }).bypass = false;
    (mutableMixer.channels[0].inserts[0].parameters as { lowGainDb: number }).lowGainDb = 9;
    expect(snapshot.channels[0].inserts[0].bypass).toBe(true);
    expect(snapshot.channels[0].inserts[0].parameters.lowGainDb).toBe(0);
  });

  it('rejects confused or runtime-augmented Snapshot v2 effect shapes', () => {
    const track = createTrack('vocal', 0, false);
    const snapshot = createProjectMixerRenderSnapshotV2({ tracks: [track] });
    const confused = JSON.parse(JSON.stringify(snapshot));
    confused.channels[0].inserts[0].processorState = { z1: 0 };

    expect(() => assertProjectMixerRenderSnapshotV2(confused)).toThrow(TypeError);
  });
});

function withEnabledChannelEqualizer(
  mixer: ProjectMixerStateV2,
): ProjectMixerStateV2 {
  const channel = mixer.channels[0];

  return {
    ...mixer,
    channels: [{
      ...channel,
      inserts: [
        { ...channel.inserts[0], bypass: false },
        channel.inserts[1],
        channel.inserts[2],
      ],
    }],
  };
}

function withEnabledMasterLimiter(
  mixer: ProjectMixerStateV2,
): ProjectMixerStateV2 {
  return {
    ...mixer,
    master: {
      ...mixer.master,
      inserts: [
        mixer.master.inserts[0],
        mixer.master.inserts[1],
        { ...mixer.master.inserts[2], bypass: false },
      ],
    },
  };
}

function createTrack(id: string, level: number, muted: boolean): Track {
  return {
    clips: [],
    id,
    level,
    muted,
    name: id,
    type: 'audio',
  };
}

function createGroupTrack(id: string, childTrackIds: string[]): Track {
  return {
    clips: [],
    group: {
      activePlaybackTrackId: childTrackIds[childTrackIds.length - 1] ?? '',
      childTrackIds,
      collapsed: true,
      playbackMode: 'bottom_child',
    },
    id,
    level: 0,
    name: id,
    parentGroupId: null,
    type: 'group',
  };
}

function createChannel(
  trackId: string,
  updates: Partial<ProjectMixerStateV1['channels'][number]> = {},
): ProjectMixerStateV1['channels'][number] {
  return {
    faderDb: 0,
    inserts: [],
    muted: false,
    outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
    pan: 0,
    solo: false,
    trackId,
    ...updates,
  };
}

function createMixer(
  channels: ProjectMixerStateV1['channels'],
  masterFaderDb = 0,
): ProjectMixerStateV1 {
  return {
    channels,
    master: {
      busId: PROJECT_MIXER_MASTER_BUS_ID,
      faderDb: masterFaderDb,
      inserts: [],
    },
    schemaVersion: PROJECT_MIXER_STATE_VERSION_V1,
  };
}
