import { describe, expect, it } from 'vitest';

import {
  createDefaultMixerChannelInsertChain,
  createDefaultMixerMasterInsertChain,
  isMixerEligibleTrack,
  normalizeProjectMixerState,
  PROJECT_MIXER_MASTER_BUS_ID,
  PROJECT_MIXER_STATE_VERSION,
  PROJECT_MIXER_STATE_VERSION_V1,
  ProjectMixerStateError,
  reconcileProjectMixerState,
  toggleProjectMixerChannelMute,
} from './projectMixerState';
import {
  commitSessionEdit,
  createSessionEditHistory,
  redoSessionEdit,
  undoSessionEdit,
} from './sessionEditHistory';
import { sampleProject } from './sampleProject';
import type {
  ProjectMixerStateV1,
  ProjectMixerStateV2,
  ProjectState,
  Track,
} from './types';

describe('Project Mixer state', () => {
  it('migrates legacy Track Gain and Mute into one versioned Mixer state', () => {
    const tracks = [
      createTrack('vocal', -6.25, true),
      createTrack('drums', 1.5, false),
    ];

    const normalization = normalizeProjectMixerState(tracks, undefined);

    expect(normalization.metadata).toEqual({
      migrated: true,
      source: 'legacy-no-mixer',
    });
    expect(normalization.mixer.schemaVersion).toBe(PROJECT_MIXER_STATE_VERSION);
    expect(normalization.mixer.channels).toHaveLength(2);
    expect(normalization.mixer.channels[0]).toMatchObject({
      trackId: 'vocal',
      faderDb: -6.25,
      pan: 0,
      muted: true,
      solo: false,
      outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
    });
    expect(normalization.mixer.channels[1]).toMatchObject({
      trackId: 'drums',
      faderDb: 1.5,
      pan: 0,
      muted: false,
      solo: false,
      outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
    });
    expect(normalization.mixer.channels[0].inserts.map(({ effectType }) => effectType)).toEqual([
      'equalizer',
      'compressor',
      'echo-delay',
    ]);
    expect(normalization.mixer.master.inserts.map(({ effectType }) => effectType)).toEqual([
      'equalizer',
      'compressor',
      'limiter',
    ]);
    expect([
      ...normalization.mixer.channels[0].inserts,
      ...normalization.mixer.master.inserts,
    ].every(({ bypass }) => bypass)).toBe(true);
    expect(normalization.tracks.map(({ level, muted }) => ({ level, muted }))).toEqual([
      { level: -6.25, muted: true },
      { level: 1.5, muted: false },
    ]);
    expect(tracks[0]).toEqual(createTrack('vocal', -6.25, true));
  });

  it('treats saved Mixer values as authoritative and synchronizes legacy projections', () => {
    const tracks = [createTrack('vocal', 12, true)];
    const mixer = createMixer([
      {
        trackId: 'vocal',
        faderDb: -3,
        pan: -0.75,
        muted: false,
        solo: true,
        inserts: createDefaultMixerChannelInsertChain(),
        outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
      },
    ], -1.5);
    const persistedValue = JSON.parse(JSON.stringify(mixer)) as unknown;

    const normalization = normalizeProjectMixerState(tracks, persistedValue);

    expect(normalization.mixer).toEqual(mixer);
    expect(normalization.metadata).toEqual({
      migrated: false,
      source: 'mixer-state-v2',
    });
    expect(normalization.tracks[0]).toMatchObject({
      id: 'vocal',
      level: -3,
      muted: false,
    });
  });

  it('rejects unsupported versions and malformed sound-affecting state', () => {
    const tracks = [createTrack('vocal', 0, false)];

    expectMixerError(
      () => normalizeProjectMixerState(tracks, { schemaVersion: 3 }),
      'MIXER_STATE_VERSION_UNSUPPORTED',
    );
    expectMixerError(
      () =>
        normalizeProjectMixerState(
          tracks,
          createMixer([
            {
              trackId: 'vocal',
              faderDb: 0,
              pan: 1.01,
              muted: false,
              solo: false,
              inserts: createDefaultMixerChannelInsertChain(),
              outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
            },
          ]),
        ),
      'MIXER_STATE_INVALID',
    );
    expectMixerError(
      () =>
        normalizeProjectMixerState(tracks, {
          ...createMixer([]),
          channels: [
            {
              trackId: 'vocal',
              faderDb: 0,
              pan: 0,
              muted: false,
              solo: false,
              inserts: [{ effectType: 'equalizer' }],
              outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
            },
          ],
        }),
      'MIXER_STATE_INVALID',
    );
  });

  it('rejects incomplete, stale, and duplicate saved Channel identity', () => {
    const tracks = [
      createTrack('vocal', 0, false),
      createTrack('drums', 0, false),
    ];
    const vocalChannel = createMixerChannel('vocal');

    expectMixerError(
      () => normalizeProjectMixerState(tracks, createMixer([vocalChannel])),
      'MIXER_STATE_INVALID',
    );
    expectMixerError(
      () =>
        normalizeProjectMixerState(
          tracks,
          createMixer([vocalChannel, createMixerChannel('unknown')]),
        ),
      'MIXER_STATE_INVALID',
    );
    expectMixerError(
      () =>
        normalizeProjectMixerState(
          tracks,
          createMixer([vocalChannel, vocalChannel]),
        ),
      'MIXER_STATE_INVALID',
    );
  });

  it('reconciles runtime Track additions and removals without changing retained Channels', () => {
    const mixer = createMixer([
      {
        ...createMixerChannel('vocal'),
        faderDb: -4,
        pan: 0.5,
        muted: true,
        solo: true,
      },
      createMixerChannel('removed'),
    ], -1);
    const project = createProject(
      [createTrack('vocal', 10, false), createTrack('new-track', -7, true)],
      mixer,
    );

    const reconciled = reconcileProjectMixerState(project);

    expect(reconciled.mixer).toEqual(
      createMixer([
        {
          ...createMixerChannel('vocal'),
          faderDb: -4,
          pan: 0.5,
          muted: true,
          solo: true,
        },
        {
          ...createMixerChannel('new-track'),
          faderDb: -7,
          muted: true,
        },
      ], -1),
    );
    expect(reconciled.tracks.map(({ id, level, muted }) => ({ id, level, muted }))).toEqual([
      { id: 'vocal', level: -4, muted: true },
      { id: 'new-track', level: -7, muted: true },
    ]);
  });

  it('updates Mute through Mixer authority and keeps the Track projection synchronized', () => {
    const project = createProject([createTrack('vocal', -3, false)]);

    const updated = toggleProjectMixerChannelMute(project, 'vocal');

    expect(updated.mixer?.channels[0].muted).toBe(true);
    expect(updated.tracks[0].muted).toBe(true);
    expect(project.mixer).toBeUndefined();
    expect(project.tracks[0].muted).toBe(false);
  });

  it('creates no Group Channel and projects the active bottom child Mixer state', () => {
    const vocal = { ...createTrack('vocal', -8, true), parentGroupId: 'group-1' };
    const drums = { ...createTrack('drums', 2, false), parentGroupId: 'group-1' };
    const group = createGroupTrack('group-1', ['vocal', 'drums'], 'drums');

    const normalization = normalizeProjectMixerState([vocal, drums, group], undefined);

    expect(normalization.mixer.channels.map((channel) => channel.trackId)).toEqual([
      'vocal',
      'drums',
    ]);
    expect(normalization.tracks.find((track) => track.id === 'group-1')).toMatchObject({
      level: 2,
      muted: false,
    });
    expect(isMixerEligibleTrack(vocal)).toBe(true);
    expect(isMixerEligibleTrack(group)).toBe(false);
  });

  it('keeps eligible Channel identity stable when the active Group child changes', () => {
    const vocal = { ...createTrack('vocal', -8, true), parentGroupId: 'group-1' };
    const drums = { ...createTrack('drums', 2, false), parentGroupId: 'group-1' };
    const initial = reconcileProjectMixerState(
      createProject([
        vocal,
        drums,
        createGroupTrack('group-1', ['vocal', 'drums'], 'drums'),
      ]),
    );
    const initialVocal = initial.tracks.find((track) => track.id === 'vocal')!;
    const initialDrums = initial.tracks.find((track) => track.id === 'drums')!;
    const changed = reconcileProjectMixerState({
      ...initial,
      tracks: [
        initialDrums,
        initialVocal,
        createGroupTrack('group-1', ['drums', 'vocal'], 'vocal'),
      ],
    });

    expect(changed.mixer?.channels.map((channel) => channel.trackId)).toEqual([
      'drums',
      'vocal',
    ]);
    expect(changed.tracks.find((track) => track.id === 'group-1')).toMatchObject({
      level: -8,
      muted: true,
    });
  });

  it('migrates R6.1 saved Group Channels without letting them override child audio state', () => {
    const vocal = { ...createTrack('vocal', 12, false), parentGroupId: 'group-1' };
    const group = createGroupTrack('group-1', ['vocal'], 'vocal');
    const r61Mixer = createMixerV1([
      { ...createMixerChannelV1('vocal'), faderDb: -4, muted: true },
      { ...createMixerChannelV1('group-1'), faderDb: 9, muted: false },
    ], -1);

    const firstOpen = normalizeProjectMixerState(
      [vocal, group],
      JSON.parse(JSON.stringify(r61Mixer)),
    );
    const reopened = normalizeProjectMixerState(
      firstOpen.tracks,
      JSON.parse(JSON.stringify(firstOpen.mixer)),
    );

    expect(firstOpen.mixer.channels.map((channel) => channel.trackId)).toEqual(['vocal']);
    expect(firstOpen.tracks.find((track) => track.id === 'group-1')).toMatchObject({
      level: -4,
      muted: true,
    });
    expect(firstOpen.metadata).toEqual({ migrated: true, source: 'mixer-state-v1' });
    expect(reopened.metadata).toEqual({ migrated: false, source: 'mixer-state-v2' });
    expect(reopened.mixer).toEqual(firstOpen.mixer);
    expect(reopened.tracks).toEqual(firstOpen.tracks);
  });

  it('preserves eligible Channel identity across ungroup, Undo, and Redo', () => {
    const groupedProject = reconcileProjectMixerState(
      createProject([
        { ...createTrack('vocal', -4, false), parentGroupId: 'group-1' },
        { ...createTrack('drums', -2, true), parentGroupId: 'group-1' },
        createGroupTrack('group-1', ['vocal', 'drums'], 'drums'),
      ]),
    );
    const ungroupedProject = reconcileProjectMixerState({
      ...groupedProject,
      tracks: groupedProject.tracks.flatMap((track) =>
        track.id === 'group-1'
          ? []
          : [{ ...track, parentGroupId: null }],
      ),
    });
    let history = createSessionEditHistory(groupedProject, createEdit('group'));
    history = commitSessionEdit(history, ungroupedProject, createEdit('ungroup'), 10);

    const undone = undoSessionEdit(history);
    expect(undone.status).toBe('MOVED');
    expect(undone.history.present.value.mixer?.channels.map(({ trackId }) => trackId)).toEqual([
      'vocal',
      'drums',
    ]);
    expect(undone.history.present.value.tracks.some(({ id }) => id === 'group-1')).toBe(true);

    const redone = redoSessionEdit(undone.history, 10);
    expect(redone.status).toBe('MOVED');
    expect(redone.history.present.value.mixer?.channels.map(({ trackId }) => trackId)).toEqual([
      'vocal',
      'drums',
    ]);
    expect(redone.history.present.value.tracks.some(({ id }) => id === 'group-1')).toBe(false);
  });

  it('migrates an exact v1 state once and preserves its sound-affecting balance fields', () => {
    const track = createTrack('vocal', 12, true);
    const v1 = createMixerV1([
      {
        ...createMixerChannelV1(track.id),
        faderDb: -5,
        muted: false,
        pan: 0.4,
        solo: true,
      },
    ], -2);
    const migrated = normalizeProjectMixerState([track], v1);

    expect(migrated.metadata).toEqual({ migrated: true, source: 'mixer-state-v1' });
    expect(migrated.mixer).toMatchObject({
      schemaVersion: 2,
      channels: [{ faderDb: -5, muted: false, pan: 0.4, solo: true }],
      master: { faderDb: -2 },
    });
    expect(migrated.mixer.channels[0].inserts.every(({ bypass }) => bypass)).toBe(true);
    expect(migrated.mixer.master.inserts.every(({ bypass }) => bypass)).toBe(true);
  });

  it('rejects malformed, confused, reordered, duplicate, missing, and extra v2 effect slots', () => {
    const track = createTrack('vocal', 0, false);
    const valid = JSON.parse(JSON.stringify(
      normalizeProjectMixerState([track], undefined).mixer,
    ));
    const invalidValues = [
      mutateJson(valid, (value) => { value.extra = true; }),
      mutateJson(valid, (value) => { value.channels[0].inserts[0].runtimeState = {}; }),
      mutateJson(valid, (value) => { value.channels[0].inserts[0].algorithmId = 'fake'; }),
      mutateJson(valid, (value) => {
        [value.channels[0].inserts[0], value.channels[0].inserts[1]] =
          [value.channels[0].inserts[1], value.channels[0].inserts[0]];
      }),
      mutateJson(valid, (value) => { value.channels[0].inserts[2] = value.channels[0].inserts[1]; }),
      mutateJson(valid, (value) => { value.channels[0].inserts.pop(); }),
      mutateJson(valid, (value) => { value.channels[0].inserts.push(value.master.inserts[2]); }),
      mutateJson(valid, (value) => { value.channels[0].inserts[0].parameters.lowGainDb = 13; }),
      mutateJson(valid, (value) => { value.channels[0].inserts[2] = value.master.inserts[2]; }),
      mutateJson(valid, (value) => { value.master.inserts[2] = value.channels[0].inserts[2]; }),
    ];

    for (const invalid of invalidValues) {
      expectMixerError(
        () => normalizeProjectMixerState([track], invalid),
        'MIXER_STATE_INVALID',
      );
    }
  });

  it('rejects missing, stale, Group-owned, and reordered v2 Channel coverage', () => {
    const vocal = createTrack('vocal', 0, false);
    const drums = createTrack('drums', 0, false);
    const group = createGroupTrack('group-1', ['vocal'], 'vocal');
    const valid = JSON.parse(JSON.stringify(
      normalizeProjectMixerState([vocal, drums], undefined).mixer,
    ));
    const invalidValues = [
      mutateJson(valid, (value) => { value.channels.pop(); }),
      mutateJson(valid, (value) => { value.channels[0].trackId = 'stale'; }),
      mutateJson(valid, (value) => { value.channels.reverse(); }),
      mutateJson(valid, (value) => { value.channels.push(value.channels[0]); }),
    ];

    for (const invalid of invalidValues) {
      expectMixerError(
        () => normalizeProjectMixerState([vocal, drums], invalid),
        'MIXER_STATE_INVALID',
      );
    }

    const groupOwned = JSON.parse(JSON.stringify(
      normalizeProjectMixerState([vocal], undefined).mixer,
    ));
    groupOwned.channels.push({ ...groupOwned.channels[0], trackId: group.id });
    expectMixerError(
      () => normalizeProjectMixerState([vocal, group], groupOwned),
      'MIXER_STATE_INVALID',
    );
  });

  it('retains validated effect configuration across Track reordering and defaults new Channels', () => {
    const vocal = createTrack('vocal', -3, false);
    const drums = createTrack('drums', -6, true);
    const initial = reconcileProjectMixerState(createProject([vocal, drums]));
    const vocalChannel = initial.mixer!.channels[0];
    const configuredVocal = {
      ...vocalChannel,
      inserts: [
        {
          ...vocalChannel.inserts[0],
          bypass: false,
          parameters: { ...vocalChannel.inserts[0].parameters, midGainDb: 4 },
        },
        vocalChannel.inserts[1],
        vocalChannel.inserts[2],
      ] as const,
    };
    const reordered = reconcileProjectMixerState({
      ...initial,
      tracks: [initial.tracks[1], initial.tracks[0], createTrack('new', -9, false)],
      mixer: {
        ...initial.mixer!,
        channels: [configuredVocal, initial.mixer!.channels[1]],
      },
    });

    expect(reordered.mixer!.channels.map(({ trackId }) => trackId)).toEqual([
      'drums',
      'vocal',
      'new',
    ]);
    expect(reordered.mixer!.channels[1].inserts[0]).toEqual(configuredVocal.inserts[0]);
    expect(reordered.mixer!.channels[2].inserts.every(({ bypass }) => bypass)).toBe(true);
  });

  it('copies and freezes persistent effect state and round-trips valid v2 JSON deterministically', () => {
    const track = createTrack('vocal', 0, false);
    const callerOwned = JSON.parse(JSON.stringify(
      normalizeProjectMixerState([track], undefined).mixer,
    ));
    const normalized = normalizeProjectMixerState([track], callerOwned);
    const serialized = JSON.stringify(normalized.mixer);
    const reopened = normalizeProjectMixerState([track], JSON.parse(serialized));

    callerOwned.channels[0].inserts[0].bypass = false;
    callerOwned.channels[0].inserts[0].parameters.lowGainDb = 12;
    callerOwned.channels[0].inserts.reverse();

    expect(normalized.mixer.channels[0].inserts[0].bypass).toBe(true);
    expect(normalized.mixer.channels[0].inserts[0].parameters.lowGainDb).toBe(0);
    expect(Object.isFrozen(normalized.mixer)).toBe(true);
    expect(Object.isFrozen(normalized.mixer.channels[0].inserts)).toBe(true);
    expect(Object.isFrozen(normalized.mixer.channels[0].inserts[0].parameters)).toBe(true);
    expect(JSON.stringify(reopened.mixer)).toBe(serialized);
    expect(reopened.metadata).toEqual({ migrated: false, source: 'mixer-state-v2' });
  });
});

function mutateJson(value: unknown, mutation: (value: any) => void): unknown {
  const copy = JSON.parse(JSON.stringify(value));
  mutation(copy);
  return copy;
}

function createTrack(id: string, level: number, muted: boolean): Track {
  return {
    id,
    name: id,
    type: 'audio',
    level,
    muted,
    clips: [],
  };
}

function createGroupTrack(
  id: string,
  childTrackIds: string[],
  activePlaybackTrackId: string,
): Track {
  return {
    id,
    name: id,
    type: 'group',
    level: 99,
    muted: false,
    clips: [],
    parentGroupId: null,
    group: {
      childTrackIds,
      collapsed: true,
      playbackMode: 'bottom_child',
      activePlaybackTrackId,
    },
  };
}

function createEdit(id: string) {
  return {
    category: 'track' as const,
    createdAt: `2026-08-09T00:00:0${id.length}.000Z`,
    id,
    label: id,
  };
}

function createMixerChannel(
  trackId: string,
): ProjectMixerStateV2['channels'][number] {
  return {
    trackId,
    faderDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    inserts: createDefaultMixerChannelInsertChain(),
    outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
  };
}

function createMixer(
  channels: ProjectMixerStateV2['channels'],
  masterFaderDb = 0,
): ProjectMixerStateV2 {
  return {
    schemaVersion: PROJECT_MIXER_STATE_VERSION,
    channels,
    master: {
      busId: PROJECT_MIXER_MASTER_BUS_ID,
      faderDb: masterFaderDb,
      inserts: createDefaultMixerMasterInsertChain(),
    },
  };
}

function createProject(
  tracks: Track[],
  mixer?: ProjectMixerStateV2,
): ProjectState {
  return {
    ...sampleProject,
    tracks,
    mixer,
  };
}

function createMixerChannelV1(
  trackId: string,
): ProjectMixerStateV1['channels'][number] {
  return {
    trackId,
    faderDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    inserts: [],
    outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
  };
}

function createMixerV1(
  channels: ProjectMixerStateV1['channels'],
  masterFaderDb = 0,
): ProjectMixerStateV1 {
  return {
    schemaVersion: PROJECT_MIXER_STATE_VERSION_V1,
    channels,
    master: {
      busId: PROJECT_MIXER_MASTER_BUS_ID,
      faderDb: masterFaderDb,
      inserts: [],
    },
  };
}

function expectMixerError(
  action: () => unknown,
  code: ProjectMixerStateError['code'],
): void {
  try {
    action();
    throw new Error('Expected Project Mixer state validation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectMixerStateError);
    expect((error as ProjectMixerStateError).code).toBe(code);
  }
}
