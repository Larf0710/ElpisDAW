import { normalizeProjectMixerState } from './projectMixerState';
import type { MixerEffectState } from '../shared/mixerEffectsContract.js';
import type {
  ProjectMixerState,
  ProjectState,
  TabFlowLine,
} from './types';

export function createProjectDirtyStateFingerprint(
  project: ProjectState,
  normalizedTabFlowLines: readonly TabFlowLine[] = project.tabFlowLines ?? [],
): string {
  const mixer = project.mixer ?? normalizeProjectMixerState(project.tracks, undefined).mixer;

  return JSON.stringify({
    artifacts: project.artifacts ?? [],
    bpm: project.bpm,
    connections: project.connections,
    key: project.key,
    mixer: createPersistentMixerFingerprint(mixer),
    name: project.name,
    patchTabs: project.patchTabs,
    recordingSettings: project.recordingSettings,
    tabFlowLines: normalizedTabFlowLines,
    tabFlowStageResults: project.tabFlowStageResults ?? [],
    takes: project.takes,
    totalTicks: project.totalTicks,
    tracks: project.tracks,
  });
}

export function hasProjectDirtyStateDrift(
  sourceFingerprint: string,
  currentProject: ProjectState,
  normalizedTabFlowLines: readonly TabFlowLine[] = currentProject.tabFlowLines ?? [],
): boolean {
  return (
    createProjectDirtyStateFingerprint(currentProject, normalizedTabFlowLines) !==
    sourceFingerprint
  );
}

function createPersistentMixerFingerprint(mixer: ProjectMixerState): object {
  return {
    schemaVersion: mixer.schemaVersion,
    channels: mixer.channels.map((channel) => ({
      trackId: channel.trackId,
      faderDb: channel.faderDb,
      pan: channel.pan,
      muted: channel.muted,
      solo: channel.solo,
      inserts: channel.inserts.map(createPersistentEffectFingerprint),
      outputBusId: channel.outputBusId,
    })),
    master: {
      busId: mixer.master.busId,
      faderDb: mixer.master.faderDb,
      inserts: mixer.master.inserts.map(createPersistentEffectFingerprint),
    },
  };
}

function createPersistentEffectFingerprint(effect: MixerEffectState): object {
  const identity = {
    effectType: effect.effectType,
    algorithmId: effect.algorithmId,
    algorithmVersion: effect.algorithmVersion,
    bypass: effect.bypass,
  };

  switch (effect.effectType) {
    case 'equalizer':
      return {
        ...identity,
        parameters: {
          highFrequencyHz: effect.parameters.highFrequencyHz,
          highGainDb: effect.parameters.highGainDb,
          lowFrequencyHz: effect.parameters.lowFrequencyHz,
          lowGainDb: effect.parameters.lowGainDb,
          midFrequencyHz: effect.parameters.midFrequencyHz,
          midGainDb: effect.parameters.midGainDb,
          midQ: effect.parameters.midQ,
        },
      };
    case 'compressor':
      return {
        ...identity,
        parameters: {
          attackMs: effect.parameters.attackMs,
          kneeDb: effect.parameters.kneeDb,
          makeupGainDb: effect.parameters.makeupGainDb,
          ratio: effect.parameters.ratio,
          releaseMs: effect.parameters.releaseMs,
          thresholdDb: effect.parameters.thresholdDb,
        },
      };
    case 'echo-delay':
      return {
        ...identity,
        parameters: {
          delayTimeMs: effect.parameters.delayTimeMs,
          dry: effect.parameters.dry,
          feedback: effect.parameters.feedback,
          wet: effect.parameters.wet,
        },
      };
    case 'limiter':
      return {
        ...identity,
        parameters: {
          ceilingDb: effect.parameters.ceilingDb,
          releaseMs: effect.parameters.releaseMs,
        },
      };
  }
}
