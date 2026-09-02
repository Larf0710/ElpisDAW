import {
  createDefaultMixerCompressorEffect,
  createDefaultMixerEchoDelayEffect,
  createDefaultMixerEqualizerEffect,
  createDefaultMixerLimiterEffect,
} from '../shared/mixerEffectsContract.js';
import {
  PROJECT_STEM_PRINT_PLAN_VERSION,
  PROJECT_STEM_PRINT_PURPOSE,
} from '../shared/projectStemPrintProtocol.js';
import { RAW_MIXDOWN_WAVE_FORMAT } from '../shared/rawMixdownProtocol.js';

export function createTestMixerSnapshotV2(tracks, masterFaderDb = 0) {
  return {
    channels: tracks.map((track) => ({
      faderDb: track.gainDb,
      inserts: [
        createDefaultMixerEqualizerEffect(),
        createDefaultMixerCompressorEffect(),
        createDefaultMixerEchoDelayEffect(),
      ],
      muted: false,
      outputBusId: 'stereo-master',
      pan: track.pan,
      solo: false,
      trackId: track.trackId,
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

export function createTestRawMixdownPlanV3({
  bpm,
  durationSeconds,
  endTick,
  masterFaderDb = 0,
  sources,
  tracks,
}) {
  return {
    bpm,
    durationSeconds,
    effectsContractVersion: 1,
    endTick,
    format: { ...RAW_MIXDOWN_WAVE_FORMAT },
    masterFaderDb,
    meterTapVersion: 2,
    mixerDspVersion: 2,
    mixerSnapshot: createTestMixerSnapshotV2(tracks, masterFaderDb),
    mixerSnapshotVersion: 2,
    purpose: 'mixdown',
    sources,
    startTick: 0,
    tracks,
    version: 3,
  };
}

export function createTestStemPrintPlanV1({
  bpm,
  durationSeconds,
  endTick,
  masterFaderDb = 0,
  selectedTargets,
  sources,
  tracks,
}) {
  const rawPlan = createTestRawMixdownPlanV3({
    bpm,
    durationSeconds,
    endTick,
    masterFaderDb,
    sources,
    tracks,
  });
  const events = tracks.flatMap((track) => track.events);

  return {
    ...rawPlan,
    audibleRange: {
      endTick: Math.max(...events.map((event) => event.timelineEndTick)),
      startTick: Math.min(...events.map((event) => event.timelineStartTick)),
    },
    purpose: PROJECT_STEM_PRINT_PURPOSE,
    selectedTargets,
    version: PROJECT_STEM_PRINT_PLAN_VERSION,
  };
}
