import { createManualMidiClip } from './manualMidiClip';
import type { LocalEngineSoundFontResource } from './localEngineClient';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
} from './patchTabPortContract';
import { savePianoRollTake } from './pianoRollTakeEditing';
import { createDefaultRecordingSettings } from './recordingSettings';
import type {
  MidiNote,
  PatchTab,
  PatchTabDefinition,
  ProjectMixdownAudioArtifact,
  ProjectMixdownAudioClipTake,
  ProjectState,
} from './types';

export const productionCreatedAt = '2026-08-01T00:00:00.000Z';
export const productionSoundFontResourceId = `soundfont-${'a'.repeat(32)}`;
export const productionSoundFontRevision = 'b'.repeat(64);
export const rawMixdownArtifactId = 'artifact-production-raw-mix';
export const rawMixdownClipId = 'clip-production-raw-mix';
export const rawMixdownClipTakeId = 'take-production-raw-mix';

export const productionSoundFont: LocalEngineSoundFontResource = Object.freeze({
  format: 'sf2' as const,
  lastModifiedAt: productionCreatedAt,
  library: 'project' as const,
  name: 'Piano.sf2',
  relativePath: 'soundfonts/Piano.sf2',
  resourceId: productionSoundFontResourceId,
  revisionToken: productionSoundFontRevision,
  sizeBytes: 1_024,
  status: 'AVAILABLE' as const,
});

export type ProductionProjectFixtureOptions = Readonly<{
  includeStableAudio3?: boolean;
  midiNotes?: readonly MidiNote[];
  soundFont?: LocalEngineSoundFontResource;
  stableAudio3DurationSeconds?: number;
}>;

export function createProductionProject(
  options: ProductionProjectFixtureOptions = {},
): ProjectState {
  const soundFont = options.soundFont ?? productionSoundFont;
  const midiEditDefinition = requireDefinition(
    BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
  );
  const instrumentDefinition = requireDefinition(
    BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
  );
  const stableAudio3Definition = requireDefinition(
    BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
  );
  const baseProject: ProjectState = {
    artifacts: [],
    bpm: 120,
    connections: [
      {
        activation: 'on',
        createdOrder: 0,
        enabled: true,
        fromPatchTabId: 'midi-edit',
        fromPortId: 'midi-out',
        id: 'connection-midi-instrument',
        latencyMs: 0,
        order: 0,
        signalType: 'Edited MIDI',
        toPatchTabId: 'instrument',
        toPortId: 'midi-in',
      },
      ...(options.includeStableAudio3
        ? [
            {
              activation: 'on' as const,
              createdOrder: 1,
              enabled: true,
              fromPatchTabId: 'instrument',
              fromPortId: 'audio-out',
              id: 'connection-instrument-stable-audio-3',
              latencyMs: 0,
              order: 1,
              signalType: 'Instrument Audio',
              toPatchTabId: 'stable-audio-3',
              toPortId: 'audio-in',
            },
          ]
        : []),
    ],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C Major',
    name: 'Auto Patch Production Preparation',
    patchTabs: [
      createMidiEditPatchTab(midiEditDefinition),
      createInstrumentPatchTab(instrumentDefinition),
      ...(options.includeStableAudio3
        ? [
            createStableAudio3PatchTab(
              stableAudio3Definition,
              options.stableAudio3DurationSeconds ?? 12,
            ),
          ]
        : []),
    ],
    playheadTick: 0,
    recordingSettings: createDefaultRecordingSettings(),
    selectedPatchTabId: 'midi-edit',
    selection: { items: [] },
    status: 'READY',
    tabFlowLines: [
      {
        connectionIds: [
          'connection-midi-instrument',
          ...(options.includeStableAudio3
            ? ['connection-instrument-stable-audio-3']
            : []),
        ],
        enabled: true,
        id: 'family-main',
        name: 'Main Flow',
        order: 0,
        revision: 1,
      },
    ],
    takes: [],
    totalTicks: 15_360,
    tracks: [],
  };
  const creation = createManualMidiClip(baseProject, {
    createdAt: productionCreatedAt,
    startTick: 0,
  });

  if (!creation.canCreate) {
    throw new Error(creation.message);
  }

  const projectWithSoundFont: ProjectState = {
    ...creation.project,
    selection: { items: [{ id: creation.clip.id, type: 'clip' }] },
    tracks: creation.project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.id === creation.clip.id
          ? {
              ...clip,
              soundFont: {
                bank: 0,
                program: 0,
                resource: {
                  format: soundFont.format,
                  library: soundFont.library,
                  relativePath: soundFont.relativePath,
                  resourceId: soundFont.resourceId,
                },
              },
            }
          : clip,
      ),
    })),
  };

  if (!options.midiNotes) {
    return projectWithSoundFont;
  }

  const save = savePianoRollTake(projectWithSoundFont, {
    clipId: creation.clip.id,
    notes: options.midiNotes,
  });

  if (!save.canSave) {
    throw new Error(save.message);
  }

  return save.project;
}

export function createRawMixdownStableAudio3ProductionProject(): ProjectState {
  const baseProject = createProductionProject({ includeStableAudio3: true });
  const stableAudio3 = baseProject.patchTabs.find(
    (patchTab) =>
      patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
  );

  if (!stableAudio3) {
    throw new Error('Stable Audio 3 production fixture PatchTab is missing.');
  }

  const artifact: ProjectMixdownAudioArtifact = {
    artifactId: rawMixdownArtifactId,
    audio: {
      bitsPerSample: 16,
      channels: 2,
      durationSeconds: 12,
      frameCount: 529_200,
      mimeType: 'audio/wav',
      sampleRate: 44_100,
    },
    createdAt: productionCreatedAt,
    destination: 'mixdown',
    file: {
      extension: '.wav',
      name: `${rawMixdownArtifactId}.wav`,
      relativePath: `mixdowns/${rawMixdownArtifactId}.wav`,
      sizeBytes: 2_116_844,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-source-a'],
      parentClipTakeIds: ['take-source-a'],
    },
    mixdownProvenance: {
      canonicalPlanJson: '{"purpose":"mixdown"}',
      inputClipIds: ['clip-source-a'],
      inputSourceIds: ['source-a'],
      inputTrackIds: ['track-source-a'],
      operationProtocolVersion: '2',
      planVersion: 3,
      rendererId: 'humstudio-project-pcm-mixdown',
      rendererVersion: '3',
      schemaVersion: 2,
    },
    sourceOperationId: 'operation-production-raw-mix',
  };
  const clipTake: ProjectMixdownAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: rawMixdownClipTakeId,
    createdAt: artifact.createdAt,
    label: 'Raw Mix 01',
    mediaType: 'audio',
    sourceOperationId: artifact.sourceOperationId,
    sourceType: 'mixdown',
  };

  return {
    ...baseProject,
    artifacts: [artifact],
    connections: [],
    patchTabs: [
      {
        ...stableAudio3,
        inputBindings: [
          {
            kind: 'timeline-selection',
            portId: 'audio-in',
            selectionKind: 'clip',
          },
        ],
      },
    ],
    selectedPatchTabId: stableAudio3.id,
    selection: { items: [{ id: rawMixdownClipId, type: 'clip' }] },
    tabFlowLines: [],
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: clipTake.clipTakeId,
            audioTiming: {
              sourceEndSeconds: 12,
              sourceStartSeconds: 0,
              timeBase: 'absolute-seconds',
            },
            clipTakes: [clipTake],
            color: '#d8b25c',
            createdAt: artifact.createdAt,
            id: rawMixdownClipId,
            lengthTicks: 3_840,
            name: 'Raw Mix 01',
            startTick: 0,
            type: 'mixdown',
            version: 1,
          },
        ],
        id: 'track-production-raw-mix',
        level: 0,
        muted: true,
        name: 'Raw Mix 01',
        type: 'audio',
      },
    ],
  };
}

function createMidiEditPatchTab(
  definition: PatchTabDefinition,
): PatchTab {
  return {
    colorIndex: 0,
    description: 'Basic Quantize.',
    id: 'midi-edit',
    inputBindings: [
      {
        kind: 'timeline-selection',
        portId: 'midi-in',
        selectionKind: 'clip',
      },
    ],
    inputType: 'MIDI Notes',
    name: 'MIDI Edit',
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
    outputType: 'Edited MIDI',
    parameters: [
      {
        id: 'quantize',
        kind: 'select',
        label: 'Quantize',
        options: ['1/8', '1/16', '1/32', '1/64'],
        value: '1/16',
      },
    ],
    portContractSnapshot: definition,
    status: 'ready',
  };
}

function createInstrumentPatchTab(
  definition: PatchTabDefinition,
): PatchTab {
  return {
    colorIndex: 1,
    description: 'FluidSynth render.',
    id: 'instrument',
    inputBindings: [
      {
        connectionIds: ['connection-midi-instrument'],
        kind: 'connection',
        portId: 'midi-in',
      },
      {
        kind: 'project-context',
        portId: 'soundfont-in',
        selector: 'clip.soundFont',
      },
    ],
    inputType: 'Edited MIDI',
    name: 'MIDI TO AUDIO',
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
    outputType: 'Instrument Audio',
    parameters: [],
    portContractSnapshot: definition,
    status: 'ready',
  };
}

function createStableAudio3PatchTab(
  definition: PatchTabDefinition,
  durationSeconds: number,
): PatchTab {
  return {
    colorIndex: 2,
    description: 'Stable Audio 3 audio-to-audio transform.',
    id: 'stable-audio-3',
    inputBindings: [
      {
        connectionIds: ['connection-instrument-stable-audio-3'],
        kind: 'connection',
        portId: 'audio-in',
      },
    ],
    inputType: 'Instrument Audio',
    name: 'Stable Audio 3',
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
    outputType: 'Instrument Audio',
    parameters: [
      {
        id: 'prompt',
        kind: 'text',
        label: 'Prompt',
        value: 'Continue as a polished instrumental arrangement',
      },
      {
        id: 'durationSeconds',
        kind: 'slider',
        label: 'Duration',
        max: 380,
        min: 1,
        step: 1,
        unit: 's',
        value: durationSeconds,
      },
      {
        id: 'seed',
        kind: 'slider',
        label: 'Seed',
        max: 0xffff_ffff,
        min: 0,
        step: 1,
        value: 7,
      },
      {
        id: 'strength',
        kind: 'slider',
        label: 'Strength',
        max: 1,
        min: 0,
        step: 0.05,
        value: 0.4,
      },
    ],
    portContractSnapshot: definition,
    status: 'ready',
  };
}

function requireDefinition(nodeTypeId: string): PatchTabDefinition {
  const definition = getBuiltinPatchTabDefinitions().find(
    (candidate) => candidate.nodeTypeId === nodeTypeId,
  );

  if (!definition) {
    throw new Error(`Missing built-in PatchTab definition ${nodeTypeId}.`);
  }

  return definition;
}
