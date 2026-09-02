import { describe, expect, it } from 'vitest';

import { timelineTicksToSeconds } from './audioClipTiming';
import type { LocalEngineSourceDescriptor } from './localEngineClient';
import {
  createDefaultMixerChannelInsertChain,
  createDefaultMixerMasterInsertChain,
  PROJECT_MIXER_MASTER_BUS_ID,
  PROJECT_MIXER_STATE_VERSION,
} from './projectMixerState';
import {
  createProjectStemPrintPlan,
  PROJECT_STEM_PRINT_PLAN_VERSION,
  type ProjectStemPrintPlan,
  type ProjectStemPrintPlanAvailability,
  type ProjectStemPrintPlanInput,
  type ProjectStemPrintTarget,
} from './projectStemPrintPlan';
import { RAW_MIXDOWN_WAVE_FORMAT } from '../shared/rawMixdownProtocol.js';
import type {
  Clip,
  ClipSourceFile,
  ProjectMixerStateV2,
  Track,
} from './types';
import { TICKS_PER_BEAT } from './workflow';

const BPM = 120;
const PROJECT_END_TICK = TICKS_PER_BEAT * 8;

describe('Project Stem Print Plan', () => {
  it('creates one canonical stereo submix Plan for one Mixer Channel', () => {
    const vocal = audioTrack('vocal', [
      audioClip('vocal-clip', TICKS_PER_BEAT, TICKS_PER_BEAT * 2, 'vocal-source'),
    ], -4);
    const drums = audioTrack('drums', [
      audioClip('drums-clip', 0, TICKS_PER_BEAT, 'drums-source'),
    ], 2);
    const plan = requirePlan(createProjectStemPrintPlan(stemInput(
      [vocal, drums],
      [{ kind: 'channel', trackId: vocal.id }],
      [generatedDescriptor('vocal-source')],
    )));

    expect(plan).toMatchObject({
      audibleRange: {
        endTick: TICKS_PER_BEAT * 3,
        startTick: TICKS_PER_BEAT,
      },
      bpm: BPM,
      durationSeconds: timelineTicksToSeconds(PROJECT_END_TICK, BPM),
      effectsContractVersion: 1,
      endTick: PROJECT_END_TICK,
      format: RAW_MIXDOWN_WAVE_FORMAT,
      masterFaderDb: 0,
      meterTapVersion: 2,
      mixerDspVersion: 2,
      mixerSnapshotVersion: 2,
      purpose: 'stem-print',
      selectedTargets: [
        {
          kind: 'channel',
          resolvedTrackId: vocal.id,
          trackId: vocal.id,
        },
      ],
      startTick: 0,
      version: PROJECT_STEM_PRINT_PLAN_VERSION,
    });
    expect(plan.tracks.map((track) => track.trackId)).toEqual([vocal.id]);
    expect(plan.tracks[0].gainDb).toBe(-4);
    expect(plan.sources.map((source) => source.sourceId)).toEqual(['vocal-source']);
    expect(plan).not.toHaveProperty('normalize');
  });

  it('retains Group identity and the current deterministic active child Track', () => {
    const first = audioTrack('bass-midi', [
      audioClip('bass-midi-clip', 0, TICKS_PER_BEAT, 'bass-midi-source'),
    ], 0, false, 'bass-group');
    const active = audioTrack('bass-audio', [
      audioClip('bass-audio-clip', 0, TICKS_PER_BEAT * 2, 'bass-audio-source'),
    ], -3, false, 'bass-group');
    const group = groupTrack(
      'bass-group',
      [first.id, active.id],
      active.id,
    );
    const plan = requirePlan(createProjectStemPrintPlan(stemInput(
      [first, active, group],
      [{ groupTrackId: group.id, kind: 'group' }],
      [generatedDescriptor('bass-audio-source')],
    )));

    expect(plan.selectedTargets).toEqual([
      {
        groupTrackId: group.id,
        kind: 'group',
        resolvedTrackId: active.id,
      },
    ]);
    expect(plan.tracks).toHaveLength(1);
    expect(plan.tracks[0]).toMatchObject({
      groupTrackId: group.id,
      trackId: active.id,
    });
    expect(plan.sources.map((source) => source.sourceId)).toEqual([
      'bass-audio-source',
    ]);
  });

  it('retains the selected outer Group while resolving a recursively nested active leaf', () => {
    const leaf = audioTrack('nested-leaf', [
      audioClip('nested-clip', 0, TICKS_PER_BEAT, 'nested-source'),
    ], -2, false, 'inner-group');
    const inner = groupTrack('inner-group', [leaf.id], leaf.id, 'outer-group');
    const outer = groupTrack('outer-group', [inner.id], inner.id);
    const plan = requirePlan(createProjectStemPrintPlan(stemInput(
      [leaf, inner, outer],
      [{ groupTrackId: outer.id, kind: 'group' }],
      [generatedDescriptor('nested-source')],
    )));

    expect(plan.selectedTargets).toEqual([{
      groupTrackId: outer.id,
      kind: 'group',
      resolvedTrackId: leaf.id,
    }]);
    expect(plan.tracks).toHaveLength(1);
    expect(plan.tracks[0]).toMatchObject({
      groupTrackId: outer.id,
      trackId: leaf.id,
    });
  });

  it('preserves ordered mixed Channel and Group targets in one deterministic Plan', () => {
    const groupChild = audioTrack('group-child', [
      audioClip('group-clip', 0, TICKS_PER_BEAT, 'group-source'),
    ], -2, false, 'group');
    const group = groupTrack('group', [groupChild.id], groupChild.id);
    const vocal = audioTrack('vocal', [
      audioClip('vocal-clip', TICKS_PER_BEAT, TICKS_PER_BEAT, 'vocal-source'),
    ], -5);
    const plan = requirePlan(createProjectStemPrintPlan(stemInput(
      [groupChild, group, vocal],
      [
        { groupTrackId: group.id, kind: 'group' },
        { kind: 'channel', trackId: vocal.id },
      ],
      [
        generatedDescriptor('group-source'),
        generatedDescriptor('vocal-source'),
      ],
    )));

    expect(plan.selectedTargets).toEqual([
      { groupTrackId: group.id, kind: 'group', resolvedTrackId: groupChild.id },
      { kind: 'channel', resolvedTrackId: vocal.id, trackId: vocal.id },
    ]);
    expect(plan.tracks.map((track) => track.trackId)).toEqual([
      groupChild.id,
      vocal.id,
    ]);
    expect(plan.sources.map((source) => source.sourceId)).toEqual([
      'group-source',
      'vocal-source',
    ]);
  });

  it('respects selected Mute and the global Mixer Solo gate', () => {
    const vocal = audioTrack('vocal', [
      audioClip('vocal-clip', 0, TICKS_PER_BEAT, 'vocal-source'),
    ]);
    const drums = audioTrack('drums', [
      audioClip('drums-clip', 0, TICKS_PER_BEAT, 'drums-source'),
    ]);
    const guide = audioTrack('guide', [
      audioClip('guide-clip', 0, TICKS_PER_BEAT, 'guide-source'),
    ]);
    const soloMixer = createMixer([
      createMixerChannel(vocal.id),
      createMixerChannel(drums.id),
      { ...createMixerChannel(guide.id), solo: true },
    ]);
    const soloFailure = requireFailure(createProjectStemPrintPlan({
      ...stemInput(
        [vocal, drums, guide],
        [
          { kind: 'channel', trackId: vocal.id },
          { kind: 'channel', trackId: drums.id },
        ],
        [],
      ),
      mixer: soloMixer,
    }));
    const mutedMixer = createMixer([
      { ...createMixerChannel(vocal.id), muted: true },
    ]);
    const mutedFailure = requireFailure(createProjectStemPrintPlan({
      ...stemInput(
        [vocal],
        [{ kind: 'channel', trackId: vocal.id }],
        [],
      ),
      mixer: mutedMixer,
    }));

    expect(soloFailure).toMatchObject({
      cause: 'no-playable-material',
      reason: 'playback-plan-unavailable',
    });
    expect(mutedFailure).toMatchObject({
      cause: 'no-playable-material',
      reason: 'playback-plan-unavailable',
    });
  });

  it('prints only selected solo-audible targets from a mixed selected set', () => {
    const vocal = audioTrack('vocal', [
      audioClip('vocal-clip', 0, TICKS_PER_BEAT, 'vocal-source'),
    ]);
    const drums = audioTrack('drums', [
      audioClip('drums-clip', 0, TICKS_PER_BEAT, 'drums-source'),
    ]);
    const mixer = createMixer([
      { ...createMixerChannel(vocal.id), solo: true },
      createMixerChannel(drums.id),
    ]);
    const plan = requirePlan(createProjectStemPrintPlan({
      ...stemInput(
        [vocal, drums],
        [
          { kind: 'channel', trackId: vocal.id },
          { kind: 'channel', trackId: drums.id },
        ],
        [generatedDescriptor('vocal-source')],
      ),
      mixer,
    }));

    expect(plan.tracks.map((track) => track.trackId)).toEqual([vocal.id]);
    expect(plan.sources.map((source) => source.sourceId)).toEqual([
      'vocal-source',
    ]);
  });

  it('fails closed when the selected Mixer Channel has no audible material', () => {
    const empty = audioTrack('empty', []);
    const result = createProjectStemPrintPlan(stemInput(
      [empty],
      [{ kind: 'channel', trackId: empty.id }],
      [],
    ));

    expect(requireFailure(result)).toMatchObject({
      cause: 'no-playable-material',
      reason: 'playback-plan-unavailable',
    });
  });

  it.each([
    {
      expectedReason: 'target-selection-required',
      label: 'no selected target',
      targets: [],
    },
    {
      expectedReason: 'target-kind-unsupported',
      label: 'a Clip-only target',
      targets: [{ clipId: 'clip', kind: 'clip' }],
    },
    {
      expectedReason: 'target-not-found',
      label: 'a missing Channel',
      targets: [{ kind: 'channel', trackId: 'missing' }],
    },
    {
      expectedReason: 'target-invalid',
      label: 'a malformed Channel target',
      targets: [{ extra: true, kind: 'channel', trackId: 'missing' }],
    },
  ])('rejects $label', ({ expectedReason, targets }) => {
    const result = createProjectStemPrintPlan(stemInput(
      [],
      targets as unknown as ProjectStemPrintTarget[],
      [],
    ));

    expect(requireFailure(result).reason).toBe(expectedReason);
  });

  it('rejects duplicate targets and Group/Channel collisions', () => {
    const child = audioTrack('child', [
      audioClip('child-clip', 0, TICKS_PER_BEAT, 'child-source'),
    ], 0, false, 'group');
    const group = groupTrack('group', [child.id], child.id);
    const duplicate = createProjectStemPrintPlan(stemInput(
      [child, group],
      [
        { kind: 'channel', trackId: child.id },
        { kind: 'channel', trackId: child.id },
      ],
      [],
    ));
    const collision = createProjectStemPrintPlan(stemInput(
      [child, group],
      [
        { kind: 'channel', trackId: child.id },
        { groupTrackId: group.id, kind: 'group' },
      ],
      [],
    ));

    expect(requireFailure(duplicate).reason).toBe('target-duplicate');
    expect(requireFailure(collision).reason).toBe('target-duplicate');
  });

  it('rejects an unresolved Group and a missing Mixer Channel', () => {
    const unresolvedGroup = groupTrack('empty-group', ['missing'], 'missing');
    const groupFailure = createProjectStemPrintPlan(stemInput(
      [unresolvedGroup],
      [{ groupTrackId: unresolvedGroup.id, kind: 'group' }],
      [],
    ));
    const vocal = audioTrack('vocal', [
      audioClip('vocal-clip', 0, TICKS_PER_BEAT, 'vocal-source'),
    ]);
    const missingMixerChannel = createProjectStemPrintPlan({
      ...stemInput(
        [vocal],
        [{ kind: 'channel', trackId: vocal.id }],
        [generatedDescriptor('vocal-source')],
      ),
      mixer: createMixer([]),
    });

    expect(requireFailure(groupFailure).reason).toBe('group-unresolved');
    expect(requireFailure(missingMixerChannel)).toMatchObject({
      cause: 'mixer-state-invalid',
      reason: 'playback-plan-unavailable',
    });
  });

  it.each([
    {
      descriptors: [] as LocalEngineSourceDescriptor[],
      label: 'missing',
    },
    {
      descriptors: [
        generatedDescriptor('vocal-source'),
        generatedDescriptor('vocal-source'),
      ],
      label: 'duplicated',
    },
    {
      descriptors: [generatedDescriptor('stale-source')],
      label: 'stale',
    },
    {
      descriptors: [{
        ...generatedDescriptor('vocal-source'),
        sizeBytes: undefined,
      }],
      label: 'incomplete',
    },
    {
      descriptors: [{
        ...generatedDescriptor('vocal-source'),
        name: 'mismatched.wav',
      }],
      label: 'internally mismatched',
    },
  ])('rejects $label source descriptors', ({ descriptors }) => {
    const vocal = audioTrack('vocal', [
      audioClip('vocal-clip', 0, TICKS_PER_BEAT, 'vocal-source'),
    ]);
    const result = createProjectStemPrintPlan(stemInput(
      [vocal],
      [{ kind: 'channel', trackId: vocal.id }],
      descriptors,
    ));

    expect(requireFailure(result).reason).toBe('source-descriptor-invalid');
  });

  it('pins Mixer/effects/DSP/meter versions and isolates every caller-owned value', () => {
    const clip = audioClip('vocal-clip', 0, TICKS_PER_BEAT, 'vocal-source');
    const vocal = audioTrack('vocal', [clip], -7);
    const target: { kind: 'channel'; trackId: string } = {
      kind: 'channel',
      trackId: vocal.id,
    };
    const targets = [target];
    const descriptor = generatedDescriptor('vocal-source') as {
      kind: 'generated';
      name: string;
      relativePath: string;
      sizeBytes: number;
      sourceId: string;
    };
    const descriptors = [descriptor];
    const channel = {
      ...createMixerChannel(vocal.id),
      faderDb: -7,
    };
    const mixer = createMixer([{
      ...channel,
      inserts: [
        { ...channel.inserts[0], bypass: false },
        channel.inserts[1],
        channel.inserts[2],
      ],
    }]);
    const plan = requirePlan(createProjectStemPrintPlan({
      ...stemInput([vocal], targets, descriptors),
      mixer,
    }));

    target.trackId = 'changed';
    targets.splice(0, targets.length);
    descriptor.sizeBytes = 96_044;
    descriptors.splice(0, descriptors.length);
    (mixer.channels as unknown as Array<{ faderDb: number }>)[0].faderDb = 6;
    vocal.level = 9;
    clip.startTick = TICKS_PER_BEAT * 4;

    expect(plan).toMatchObject({
      effectsContractVersion: 1,
      meterTapVersion: 2,
      mixerDspVersion: 2,
      mixerSnapshotVersion: 2,
      version: 1,
    });
    expect(plan.selectedTargets).toEqual([
      { kind: 'channel', resolvedTrackId: 'vocal', trackId: 'vocal' },
    ]);
    expect(plan.sources[0].sizeBytes).toBe(48_044);
    expect(plan.tracks[0].gainDb).toBe(-7);
    expect(plan.tracks[0].events[0].startOffsetSeconds).toBe(0);
    expect(plan.mixerSnapshot.channels[0].inserts[0].bypass).toBe(false);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.audibleRange)).toBe(true);
    expect(Object.isFrozen(plan.selectedTargets)).toBe(true);
    expect(Object.isFrozen(plan.selectedTargets[0])).toBe(true);
    expect(Object.isFrozen(plan.sources)).toBe(true);
    expect(Object.isFrozen(plan.sources[0])).toBe(true);
    expect(Object.isFrozen(plan.tracks)).toBe(true);
    expect(Object.isFrozen(plan.tracks[0].events[0])).toBe(true);
    expect(Object.isFrozen(
      plan.mixerSnapshot.channels[0].inserts[0].parameters,
    )).toBe(true);
  });
});

function stemInput(
  tracks: Track[],
  targets: ProjectStemPrintTarget[],
  sourceDescriptors: LocalEngineSourceDescriptor[],
): ProjectStemPrintPlanInput {
  const sourceAvailability = Object.fromEntries(
    tracks.flatMap((track) =>
      track.clips.flatMap((clip) =>
        clip.sourceFile?.sourceId
          ? [[clip.sourceFile.sourceId, 'openable' as const]]
          : [],
      ),
    ),
  );

  return {
    bpm: BPM,
    playheadTick: TICKS_PER_BEAT * 5,
    projectEndTick: PROJECT_END_TICK,
    sourceAvailability,
    sourceDescriptors,
    targets,
    tracks,
  };
}

function audioClip(
  id: string,
  startTick: number,
  lengthTicks: number,
  sourceId: string,
): Clip {
  const durationSeconds = timelineTicksToSeconds(lengthTicks, BPM);
  const sourceFile: ClipSourceFile = {
    durationSeconds,
    name: `${sourceId}.wav`,
    relativePath: `renders/instruments/${sourceId}.wav`,
    sizeBytes: 48_044,
    sourceId,
    status: 'available',
  };

  return {
    audioTiming: {
      sourceEndSeconds: durationSeconds,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    },
    color: '#5e8fb8',
    createdAt: '2026-08-13T00:00:00.000Z',
    id,
    lengthTicks,
    name: id,
    sourceFile,
    startTick,
    type: 'instrument-audio',
    version: 1,
  };
}

function audioTrack(
  id: string,
  clips: Clip[],
  level = 0,
  muted = false,
  parentGroupId: string | null = null,
): Track {
  return {
    clips,
    id,
    level,
    muted,
    name: id,
    parentGroupId,
    type: 'audio',
  };
}

function groupTrack(
  id: string,
  childTrackIds: string[],
  activePlaybackTrackId: string,
  parentGroupId: string | null = null,
): Track {
  return {
    clips: [],
    group: {
      activePlaybackTrackId,
      childTrackIds,
      collapsed: true,
      playbackMode: 'bottom_child',
    },
    id,
    level: 0,
    name: id,
    parentGroupId,
    type: 'group',
  };
}

function generatedDescriptor(sourceId: string): LocalEngineSourceDescriptor {
  return {
    kind: 'generated',
    name: `${sourceId}.wav`,
    relativePath: `renders/instruments/${sourceId}.wav`,
    sizeBytes: 48_044,
    sourceId,
  };
}

function createMixerChannel(
  trackId: string,
): ProjectMixerStateV2['channels'][number] {
  return {
    faderDb: 0,
    inserts: createDefaultMixerChannelInsertChain(),
    muted: false,
    outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
    pan: 0,
    solo: false,
    trackId,
  };
}

function createMixer(
  channels: ProjectMixerStateV2['channels'],
  masterFaderDb = 0,
): ProjectMixerStateV2 {
  return {
    channels,
    master: {
      busId: PROJECT_MIXER_MASTER_BUS_ID,
      faderDb: masterFaderDb,
      inserts: createDefaultMixerMasterInsertChain(),
    },
    schemaVersion: PROJECT_MIXER_STATE_VERSION,
  };
}

function requirePlan(
  result: ProjectStemPrintPlanAvailability,
): ProjectStemPrintPlan {
  if (!result.canCreate) {
    throw new Error(result.message);
  }

  return result.plan;
}

function requireFailure(
  result: ProjectStemPrintPlanAvailability,
): Extract<ProjectStemPrintPlanAvailability, { canCreate: false }> {
  if (result.canCreate) {
    throw new Error('Expected Stem Print Plan creation to fail.');
  }

  return result;
}
