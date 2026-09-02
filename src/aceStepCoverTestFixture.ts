import { createAceStepCoverPatchTabTemplate } from './aceStepCoverPatchTab';
import type { GeneratedAudioArtifact, GeneratedAudioClipTake, ProjectState } from './types';

export function createConfiguredAceStepCoverPatchTab() {
  const template = createAceStepCoverPatchTabTemplate();
  return {
    ...template,
    id: 'ace-cover-test',
    parameters: template.parameters.map((parameter) => {
      if (parameter.id === 'mode' && parameter.kind === 'select') {
        return { ...parameter, value: 'Vocals' };
      }
      if (parameter.id === 'lyrics' && parameter.kind === 'text') {
        return { ...parameter, value: '[Verse]\nA quiet light' };
      }
      if (parameter.id === 'language' && parameter.kind === 'select') {
        return { ...parameter, value: 'Japanese' };
      }
      if (parameter.id === 'takes' && parameter.kind === 'number') {
        return { ...parameter, value: 2 };
      }
      return parameter;
    }),
  };
}

export function createAceStepCoverProject(
  patchTab: ReturnType<typeof createConfiguredAceStepCoverPatchTab>,
): ProjectState {
  const artifact: GeneratedAudioArtifact = {
    artifactId: 'artifact-source',
    audio: { channels: 2, durationSeconds: 12, mimeType: 'audio/wav' },
    createdAt: '2026-08-30T23:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-source.wav',
      relativePath: 'renders/instruments/artifact-source.wav',
      sizeBytes: 2_304_044,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'fluid-synth',
      modelRevision: '1',
      parameters: {},
      providerId: 'local-fluidsynth',
      taskId: 'instrument-render',
    },
    sourceJobId: 'job-source',
  };
  const take: GeneratedAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-source',
    createdAt: artifact.createdAt,
    label: 'Source Take 01',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };

  return {
    artifacts: [artifact],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C major',
    name: 'ACE Cover Test',
    patchTabs: [patchTab],
    playheadTick: 0,
    recordingSettings: { countInBars: 1, metronomeEnabled: true, metronomeVolume: 0.5 },
    selectedPatchTabId: patchTab.id,
    selection: { items: [{ id: 'clip-source', type: 'clip' }] },
    status: 'READY',
    tabFlowLines: [],
    tabFlowStageResults: [],
    takes: [],
    totalTicks: 960 * 4 * 16,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: take.clipTakeId,
            audioTiming: {
              sourceEndSeconds: 12,
              sourceStartSeconds: 0,
              timeBase: 'absolute-seconds',
            },
            clipTakes: [take],
            color: '#4488aa',
            createdAt: artifact.createdAt,
            id: 'clip-source',
            lengthTicks: 23_040,
            name: 'Source Song',
            startTick: 3_840,
            type: 'instrument-audio',
            version: 1,
          },
        ],
        id: 'track-source',
        level: -6,
        name: 'Source',
        type: 'audio',
      },
    ],
  };
}
