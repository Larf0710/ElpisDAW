import {
  createDefaultMixerCompressorEffect,
  createDefaultMixerEchoDelayEffect,
  createDefaultMixerEqualizerEffect,
  createDefaultMixerLimiterEffect,
} from '../shared/mixerEffectsContract.js';
import { RAW_MIXDOWN_WAVE_FORMAT } from '../shared/rawMixdownProtocol.js';
import type {
  ProjectMixdownPlan,
  ProjectMixdownSourceDescriptor,
} from './projectMixdownPlan';
import type { ProjectMixerRenderSnapshotV2 } from './projectMixerRenderSnapshot';
import type { ProjectPlaybackTrackSchedule } from './projectPlaybackRuntime';

export function createTestProjectMixerRenderSnapshotV2(
  channels: readonly Pick<
    ProjectPlaybackTrackSchedule,
    'gainDb' | 'pan' | 'trackId'
  >[],
  masterFaderDb = 0,
): ProjectMixerRenderSnapshotV2 {
  return {
    channels: channels.map((channel) => ({
      faderDb: channel.gainDb,
      inserts: [
        createDefaultMixerEqualizerEffect(),
        createDefaultMixerCompressorEffect(),
        createDefaultMixerEchoDelayEffect(),
      ],
      muted: false,
      outputBusId: 'stereo-master',
      pan: channel.pan,
      solo: false,
      trackId: channel.trackId,
    })),
    master: {
      busId: 'stereo-master',
      faderDb: masterFaderDb,
      inserts: [
        createDefaultMixerEqualizerEffect(),
        createDefaultMixerCompressorEffect(),
        createDefaultMixerLimiterEffect(),
      ],
    },
    schemaVersion: 2,
  };
}

export function createTestProjectMixdownPlanV3(input: Readonly<{
  bpm: number;
  durationSeconds: number;
  endTick: number;
  masterFaderDb?: number;
  snapshotChannels?: readonly Pick<
    ProjectPlaybackTrackSchedule,
    'gainDb' | 'pan' | 'trackId'
  >[];
  sources: readonly ProjectMixdownSourceDescriptor[];
  tracks: readonly ProjectPlaybackTrackSchedule[];
}>): ProjectMixdownPlan {
  const masterFaderDb = input.masterFaderDb ?? 0;
  return {
    bpm: input.bpm,
    durationSeconds: input.durationSeconds,
    effectsContractVersion: 1,
    endTick: input.endTick,
    format: RAW_MIXDOWN_WAVE_FORMAT,
    masterFaderDb,
    meterTapVersion: 2,
    mixerDspVersion: 2,
    mixerSnapshot: createTestProjectMixerRenderSnapshotV2(
      input.snapshotChannels ?? input.tracks,
      masterFaderDb,
    ),
    mixerSnapshotVersion: 2,
    purpose: 'mixdown',
    sources: input.sources,
    startTick: 0,
    tracks: input.tracks,
    version: 3,
  };
}
