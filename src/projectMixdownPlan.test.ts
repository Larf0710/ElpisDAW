import { describe, expect, it } from 'vitest';

import { timelineTicksToSeconds } from './audioClipTiming';
import type { LocalEngineSourceDescriptor } from './localEngineClient';
import {
  createProjectMixdownPlan,
  RAW_MIXDOWN_WAVE_FORMAT,
  type ProjectMixdownPlan,
  type ProjectMixdownPlanAvailability,
  type ProjectMixdownPlanInput,
} from './projectMixdownPlan';
import { createCanonicalProjectMixdownPlanJson } from './projectMixdownPlanIdentity';
import {
  createDefaultMixerChannelInsertChain,
  createDefaultMixerMasterInsertChain,
  PROJECT_MIXER_MASTER_BUS_ID,
  PROJECT_MIXER_STATE_VERSION,
} from './projectMixerState';
import type {
  Clip,
  ClipSourceFile,
  ProjectMixerStateV2,
  SelectionState,
  Track,
} from './types';
import { TICKS_PER_BEAT } from './workflow';

const BPM = 120;
const PROJECT_END_TICK = TICKS_PER_BEAT * 8;

describe('Project Mixdown Plan', () => {
  it('snapshots the full audible Project into the canonical Raw Mixdown format', () => {
    const generated = audioClip('generated', 0, TICKS_PER_BEAT * 2, {
      name: 'artifact-generated.wav',
      relativePath: 'renders/instruments/artifact-generated.wav',
      sizeBytes: 48_044,
      sourceId: 'artifact-generated',
      status: 'available',
    });
    const external = audioClip('external', TICKS_PER_BEAT, TICKS_PER_BEAT, {
      lastKnownPath: 'D:\\Audio\\external.wav',
      lastModified: 1_786_089_600_000,
      name: 'external.wav',
      sizeBytes: 96_044,
      sourceId: 'external-source',
      status: 'available',
    });
    const muted = audioClip('muted', 0, TICKS_PER_BEAT, {
      name: 'artifact-muted.wav',
      relativePath: 'renders/instruments/artifact-muted.wav',
      sizeBytes: 48_044,
      sourceId: 'artifact-muted',
      status: 'available',
    });
    const input = mixdownInput(
      [
        audioTrack('generated-track', [generated], -6),
        audioTrack('external-track', [external], 3),
        audioTrack('muted-track', [muted], 0, true),
      ],
      [
        generatedDescriptor('artifact-generated'),
        externalDescriptor('external-source'),
      ],
      selection({ type: 'track', id: 'muted-track' }),
    );

    const planning = createProjectMixdownPlan(input);
    const plan = requirePlan(planning);

    expect(plan).toMatchObject({
      bpm: BPM,
      durationSeconds: timelineTicksToSeconds(PROJECT_END_TICK, BPM),
      endTick: PROJECT_END_TICK,
      effectsContractVersion: 1,
      format: RAW_MIXDOWN_WAVE_FORMAT,
      masterFaderDb: 0,
      meterTapVersion: 2,
      mixerDspVersion: 2,
      mixerSnapshotVersion: 2,
      purpose: 'mixdown',
      startTick: 0,
      version: 3,
    });
    expect(plan.tracks.map((track) => track.trackId)).toEqual([
      'generated-track',
      'external-track',
    ]);
    expect(plan.tracks.map((track) => track.gainDb)).toEqual([-6, 3]);
    expect(plan).not.toHaveProperty('meterSummary');
    expect(plan.tracks.every((track) => !('meter' in track))).toBe(true);
    expect(plan.sources).toEqual([
      generatedDescriptor('artifact-generated'),
      externalDescriptor('external-source'),
    ]);
    expect(plan.tracks[1].events[0]).toMatchObject({
      clipId: external.id,
      durationSeconds: timelineTicksToSeconds(TICKS_PER_BEAT, BPM),
      sourceId: 'external-source',
      startOffsetSeconds: timelineTicksToSeconds(TICKS_PER_BEAT, BPM),
    });
    expect(planning).toMatchObject({
      canCreate: true,
      mixerSnapshot: {
        channels: [
          { trackId: 'generated-track' },
          { trackId: 'external-track' },
          { trackId: 'muted-track' },
        ],
        schemaVersion: 2,
      },
    });

    if (planning.canCreate) {
      expect(Object.isFrozen(planning.mixerSnapshot)).toBe(true);
    }
  });

  it('does not require descriptors for muted sources', () => {
    const audible = audioClip('audible', 0, TICKS_PER_BEAT, {
      name: 'artifact-audible.wav',
      relativePath: 'renders/instruments/artifact-audible.wav',
      sizeBytes: 48_044,
      sourceId: 'artifact-audible',
      status: 'available',
    });
    const muted = audioClip('muted', 0, TICKS_PER_BEAT, {
      name: 'artifact-muted.wav',
      relativePath: 'renders/instruments/artifact-muted.wav',
      sizeBytes: 48_044,
      sourceId: 'artifact-muted',
      status: 'available',
    });
    const result = createProjectMixdownPlan(
      mixdownInput(
        [
          audioTrack('audible-track', [audible]),
          audioTrack('muted-track', [muted], 0, true),
        ],
        [generatedDescriptor('artifact-audible')],
      ),
    );

    expect(requirePlan(result).sources.map((source) => source.sourceId)).toEqual([
      'artifact-audible',
    ]);
  });

  it('derives the offline schedule from the same Mixer snapshot authority', () => {
    const vocal = audioClip('vocal', 0, TICKS_PER_BEAT, {
      name: 'artifact-vocal.wav',
      relativePath: 'renders/instruments/artifact-vocal.wav',
      sizeBytes: 48_044,
      sourceId: 'artifact-vocal',
      status: 'available',
    });
    const drums = audioClip('drums', 0, TICKS_PER_BEAT, {
      name: 'artifact-drums.wav',
      relativePath: 'renders/instruments/artifact-drums.wav',
      sizeBytes: 48_044,
      sourceId: 'artifact-drums',
      status: 'available',
    });
    const tracks = [
      audioTrack('vocal-track', [vocal], 12, true),
      audioTrack('drums-track', [drums], 3),
    ];
    const mixer = createMixer([
      {
        ...createMixerChannel('vocal-track'),
        faderDb: -5,
        muted: false,
        pan: -0.4,
        solo: true,
      },
      {
        ...createMixerChannel('drums-track'),
        faderDb: 6,
        pan: 0.6,
      },
    ], -2);

    const plan = requirePlan(
      createProjectMixdownPlan({
        ...mixdownInput(tracks, [generatedDescriptor('artifact-vocal')]),
        mixer,
      }),
    );

    expect(plan).toMatchObject({ masterFaderDb: -2, mixerDspVersion: 2 });
    expect(plan.tracks.map(({ gainDb, pan, trackId }) => ({ gainDb, pan, trackId }))).toEqual([
      { gainDb: -5, pan: -0.4, trackId: 'vocal-track' },
    ]);
    expect(plan.sources.map(({ sourceId }) => sourceId)).toEqual(['artifact-vocal']);
  });

  it('captures enabled Mixer v2 effects in the immutable offline Plan v3', () => {
    const clip = audioClip('source', 0, TICKS_PER_BEAT, {
      name: 'artifact-source.wav',
      relativePath: 'renders/instruments/artifact-source.wav',
      sizeBytes: 48_044,
      sourceId: 'artifact-source',
      status: 'available',
    });
    const track = audioTrack('track', [clip]);
    const mixer = createMixer([createMixerChannel(track.id)]);
    const limiter = mixer.master.inserts[2];
    const enabledMixer: ProjectMixerStateV2 = {
      ...mixer,
      master: {
        ...mixer.master,
        inserts: [
          mixer.master.inserts[0],
          mixer.master.inserts[1],
          { ...limiter, bypass: false },
        ],
      },
    };
    const planning = createProjectMixdownPlan({
        ...mixdownInput([track], [generatedDescriptor('artifact-source')]),
        mixer: enabledMixer,
      });
    const plan = requirePlan(planning);

    expect(plan.mixerSnapshot.master.inserts[2]).toMatchObject({
      bypass: false,
      effectType: 'limiter',
    });
    expect(Object.isFrozen(plan.mixerSnapshot.master.inserts[2].parameters)).toBe(true);
  });

  it('includes effect bypass and parameter state in canonical Plan identity', () => {
    const clip = audioClip('source', 0, TICKS_PER_BEAT, {
      name: 'artifact-source.wav',
      relativePath: 'renders/instruments/artifact-source.wav',
      sizeBytes: 48_044,
      sourceId: 'artifact-source',
      status: 'available',
    });
    const track = audioTrack('track', [clip]);
    const baseMixer = createMixer([createMixerChannel(track.id)]);
    const channel = baseMixer.channels[0];
    const baseInput = mixdownInput(
      [track],
      [generatedDescriptor('artifact-source')],
    );
    const basePlan = requirePlan(createProjectMixdownPlan({
      ...baseInput,
      mixer: baseMixer,
    }));
    const enabledPlan = requirePlan(createProjectMixdownPlan({
      ...baseInput,
      mixer: {
        ...baseMixer,
        channels: [{
          ...channel,
          inserts: [
            { ...channel.inserts[0], bypass: false },
            channel.inserts[1],
            channel.inserts[2],
          ],
        }],
      },
    }));
    const parameterPlan = requirePlan(createProjectMixdownPlan({
      ...baseInput,
      mixer: {
        ...baseMixer,
        channels: [{
          ...channel,
          inserts: [
            {
              ...channel.inserts[0],
              parameters: {
                ...channel.inserts[0].parameters,
                midGainDb: 3,
              },
            },
            channel.inserts[1],
            channel.inserts[2],
          ],
        }],
      },
    }));

    const identities = [basePlan, enabledPlan, parameterPlan].map(
      createCanonicalProjectMixdownPlanJson,
    );
    expect(new Set(identities).size).toBe(3);
    expect(basePlan).not.toHaveProperty('meterSummary');
  });

  it('fails closed when a required source is not currently openable', () => {
    const clip = audioClip('missing', 0, TICKS_PER_BEAT, {
      name: 'artifact-missing.wav',
      relativePath: 'renders/instruments/artifact-missing.wav',
      sizeBytes: 48_044,
      sourceId: 'artifact-missing',
      status: 'available',
    });
    const input = mixdownInput(
      [audioTrack('track-missing', [clip])],
      [generatedDescriptor('artifact-missing')],
    );
    expect(
      requireFailure(
        createProjectMixdownPlan({
          ...input,
          sourceAvailability: {
            ...input.sourceAvailability,
            'artifact-missing': 'unopenable',
          },
        }),
      ),
    ).toMatchObject({
      cause: 'source-unavailable',
      reason: 'playback-plan-unavailable',
    });
  });

  it.each([
    {
      label: 'missing',
      descriptors: [],
    },
    {
      label: 'duplicate',
      descriptors: [
        generatedDescriptor('artifact-source'),
        generatedDescriptor('artifact-source'),
      ],
    },
    {
      label: 'unexpected',
      descriptors: [
        generatedDescriptor('artifact-source'),
        generatedDescriptor('artifact-extra'),
      ],
    },
    {
      label: 'incomplete external metadata',
      descriptors: [
        {
          ...externalDescriptor('artifact-source'),
          lastModified: undefined,
        },
      ],
    },
  ])('rejects $label source authority', ({ descriptors }) => {
    const clip = audioClip('source', 0, TICKS_PER_BEAT, {
      lastKnownPath: 'D:\\Audio\\source.wav',
      lastModified: 1_786_089_600_000,
      name: 'source.wav',
      sizeBytes: 96_044,
      sourceId: 'artifact-source',
      status: 'available',
    });

    expect(
      requireFailure(
        createProjectMixdownPlan(
          mixdownInput(
            [audioTrack('track-source', [clip])],
            descriptors,
          ),
        ),
      ).reason,
    ).toBe('source-descriptor-invalid');
  });

  it('preserves the prepared snapshot after caller-owned input changes', () => {
    const clip = audioClip('stable', 0, TICKS_PER_BEAT, {
      name: 'artifact-stable.wav',
      relativePath: 'renders/instruments/artifact-stable.wav',
      sizeBytes: 48_044,
      sourceId: 'artifact-stable',
      status: 'available',
    });
    const track = audioTrack('stable-track', [clip], -9);
    const descriptor = generatedDescriptor('artifact-stable');
    const descriptors = [descriptor];
    const input = mixdownInput([track], descriptors);
    const plan = requirePlan(createProjectMixdownPlan(input));

    track.level = 12;
    clip.startTick = TICKS_PER_BEAT * 4;
    descriptors.splice(0, descriptors.length);

    expect(plan.tracks[0].gainDb).toBe(-9);
    expect(plan.tracks[0].events[0].startOffsetSeconds).toBe(0);
    expect(plan.sources).toEqual([descriptor]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.tracks)).toBe(true);
    expect(Object.isFrozen(plan.tracks[0].events[0])).toBe(true);
  });
});

function mixdownInput(
  tracks: Track[],
  sourceDescriptors: LocalEngineSourceDescriptor[],
  projectSelection: SelectionState = selection(),
): ProjectMixdownPlanInput {
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
    selection: projectSelection,
    sourceAvailability,
    sourceDescriptors,
    tracks,
  };
}

function audioClip(
  id: string,
  startTick: number,
  lengthTicks: number,
  sourceFile: ClipSourceFile,
): Clip {
  const sourceDurationSeconds = timelineTicksToSeconds(lengthTicks, BPM);

  return {
    audioTiming: {
      sourceEndSeconds: sourceDurationSeconds,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    },
    color: '#5e8fb8',
    createdAt: '2026-08-08T00:00:00.000Z',
    id,
    lengthTicks,
    name: id,
    sourceFile: {
      ...sourceFile,
      durationSeconds: sourceDurationSeconds,
    },
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
): Track {
  return {
    clips,
    id,
    level,
    muted,
    name: id,
    parentGroupId: null,
    type: 'audio',
  };
}

function generatedDescriptor(
  sourceId: string,
): LocalEngineSourceDescriptor {
  return {
    kind: 'generated',
    name: `${sourceId}.wav`,
    relativePath: `renders/instruments/${sourceId}.wav`,
    sizeBytes: 48_044,
    sourceId,
  };
}

function externalDescriptor(sourceId: string): LocalEngineSourceDescriptor {
  return {
    kind: 'external',
    lastModified: 1_786_089_600_000,
    name: 'external.wav',
    path: 'D:\\Audio\\external.wav',
    sizeBytes: 96_044,
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

function selection(
  ...items: SelectionState['items']
): SelectionState {
  return { items };
}

function requirePlan(
  result: ProjectMixdownPlanAvailability,
): ProjectMixdownPlan {
  if (!result.canCreate) {
    throw new Error(result.message);
  }

  return result.plan;
}

function requireFailure(
  result: ProjectMixdownPlanAvailability,
): Extract<ProjectMixdownPlanAvailability, { canCreate: false }> {
  if (result.canCreate) {
    throw new Error('Expected Mixdown Plan creation to fail.');
  }

  return result;
}
