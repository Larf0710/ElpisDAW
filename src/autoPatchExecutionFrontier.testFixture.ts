import {
  createAutoPatchExecutionFrontier,
  type AutoPatchRuntimeTargetSnapshot,
} from './autoPatchExecutionFrontier';
import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import type { AutoPatchValidatedPreflight } from './autoPatchStagePreflight';
import {
  FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
  FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
} from './fluidSynthInstrumentRender';
import { INSTRUMENT_RENDER_TASK_ID } from './instrumentRenderContract';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
} from './patchTabPortContract';
import type {
  CompletedTabFlowStageResultRecord,
  PatchTabDefinition,
  TabFlowStageResultScope,
} from './types';

export const targetClipId = 'clip-midi';
export const familyId = 'family-main';
export const familyRevision = 1;
export const stageMidiEditId = 'stage-midi-edit';
export const stageInstrumentId = 'stage-instrument';
export const stageStableAudio3Id = 'stage-stable-audio-3';
export const sourceArtifactId = 'artifact-midi-source';
export const sourceClipTakeId = 'take-midi-source';
export const editedArtifactId = 'artifact-midi-edited';
export const editedClipTakeId = 'take-midi-edited';
export const instrumentArtifactId = 'artifact-instrument-audio';
export const instrumentClipTakeId = 'take-instrument-audio';
export const stableAudio3ConnectionId =
  'connection-instrument-stable-audio-3';
export const soundFontResourceId =
  'soundfont-0123456789abcdef0123456789abcdef';
export const soundFontRevision = 'a'.repeat(64);

export function createValidatedPreflight(
  options: Readonly<{
    program?: number;
    sourceContentHash?: string;
    sourceRevision?: number;
  }> = {},
): AutoPatchValidatedPreflight {
  const program = options.program ?? 0;
  const midiEditDefinition = requireDefinition(
    BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
  );
  const instrumentDefinition = requireDefinition(
    BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
  );
  const midiEditScope = createScope(stageMidiEditId);
  const instrumentScope = createScope(stageInstrumentId);
  const target = {
    activeTake: {
      artifactCreatedAt: '2026-07-31T00:00:00.000Z',
      artifactId: sourceArtifactId,
      clipTakeCreatedAt: '2026-07-31T00:00:00.000Z',
      clipTakeId: sourceClipTakeId,
      contentHash: options.sourceContentHash ?? 'source-hash',
      mediaType: 'midi' as const,
      revision: options.sourceRevision ?? 1,
      sourceType: 'manual' as const,
    },
    clipId: targetClipId,
    clipType: 'midi-notes' as const,
    clipVersion: 1,
    lengthTicks: 7_680,
    soundFont: {
      bank: 0,
      program,
      resource: {
        format: 'sf2' as const,
        library: 'project' as const,
        relativePath: 'soundfonts/Piano.sf2',
        resourceId: soundFontResourceId,
      },
    },
    startTick: 0,
    trackId: 'track-midi',
  };
  const connection = {
    activation: 'on' as const,
    createdOrder: 1,
    enabled: true,
    fromPatchTabId: stageMidiEditId,
    fromPortId: 'midi-out',
    id: 'connection-midi-instrument',
    latencyMs: 0,
    order: 1,
    signalType: 'Edited MIDI',
    toPatchTabId: stageInstrumentId,
    toPortId: 'midi-in',
  };
  const family = {
    connectionOrder: [connection.id],
    connections: [connection],
    familyId,
    familyRevision,
    lineOrder: [familyId],
    lines: [
      {
        connectionIds: [connection.id],
        enabled: true,
        id: familyId,
        name: 'Main Flow',
        order: 1,
        revision: familyRevision,
      },
    ],
    order: 1,
    patchTabOrder: [stageMidiEditId, stageInstrumentId],
    patchTabs: [
      {
        id: stageMidiEditId,
        inputBindings: [
          {
            kind: 'timeline-selection' as const,
            portId: 'midi-in',
            selectionKind: 'clip' as const,
          },
        ],
        name: 'MIDI Edit',
        nodeTypeId: midiEditDefinition.nodeTypeId,
        nodeVersion: midiEditDefinition.nodeVersion,
        parameters: [
          {
            id: 'quantize',
            kind: 'select' as const,
            label: 'Quantize',
            options: ['1/8', '1/16'],
            value: '1/16',
          },
        ],
        portContract: midiEditDefinition,
      },
      {
        id: stageInstrumentId,
        inputBindings: [
          {
            connectionIds: [connection.id],
            kind: 'connection' as const,
            portId: 'midi-in',
          },
          {
            kind: 'project-context' as const,
            portId: 'soundfont-in',
            selector: 'clip.soundFont',
          },
        ],
        name: 'MIDI TO AUDIO',
        nodeTypeId: instrumentDefinition.nodeTypeId,
        nodeVersion: instrumentDefinition.nodeVersion,
        parameters: [],
        portContract: instrumentDefinition,
      },
    ],
  };
  const availability = {
    artifactIds: [sourceArtifactId],
    clipTakeIds: [sourceClipTakeId],
  };
  const plan = {
    createdAt: '2026-07-31T00:00:00.000Z',
    graphSnapshot: {
      createdAt: '2026-07-31T00:00:00.000Z',
      families: [family],
      familyOrder: [familyId],
      projectContext: {
        bpm: 120,
        key: 'C Major',
      },
      snapshotId: 'plan-frontier',
      targetClipIds: [targetClipId],
      targets: [target],
    },
    planId: 'plan-frontier',
    targetPlans: [
      {
        availability,
        families: [
          {
            familyId,
            familyRevision,
            stages: [
              {
                dependsOnStageIds: [],
                incomingConnectionIds: [],
                scope: midiEditScope,
              },
              {
                dependsOnStageIds: [stageMidiEditId],
                incomingConnectionIds: [connection.id],
                scope: instrumentScope,
              },
            ],
          },
        ],
        targetClipId,
      },
    ],
    targetSource: 'clip-selection' as const,
  };

  return {
    plan,
    stages: [
      {
        execution: { kind: 'builtin' },
        portBindings: [
          {
            bindingKinds: ['timeline-selection'],
            connectionIds: [],
            portId: 'midi-in',
            sourceCount: 1,
          },
        ],
        resourceInputs: [],
        scope: midiEditScope,
      },
      {
        execution: {
          kind: 'provider',
          modelId: soundFontResourceId,
          modelRevision: soundFontRevision,
          providerId: FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
          providerRevision: FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
          taskId: INSTRUMENT_RENDER_TASK_ID,
        },
        portBindings: [
          {
            bindingKinds: ['connection'],
            connectionIds: [connection.id],
            portId: 'midi-in',
            sourceCount: 1,
          },
          {
            bindingKinds: ['project-context'],
            connectionIds: [],
            portId: 'soundfont-in',
            sourceCount: 1,
          },
        ],
        resourceInputs: [
          {
            portId: 'soundfont-in',
            resourceId: soundFontResourceId,
            revision: soundFontRevision,
            selections: {
              bank: 0,
              program,
            },
          },
        ],
        scope: instrumentScope,
      },
    ],
    verifiedSoundFontResourceIds: [soundFontResourceId],
  };
}

export function createValidatedPreflightWithStableAudio3(
  base: AutoPatchValidatedPreflight = createValidatedPreflight(),
  takes?: number,
): AutoPatchValidatedPreflight {
  const definition = requireDefinition(
    BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
  );
  const scope = createScope(stageStableAudio3Id);
  const connection = {
    activation: 'on' as const,
    createdOrder: 2,
    enabled: true,
    fromPatchTabId: stageInstrumentId,
    fromPortId: 'audio-out',
    id: stableAudio3ConnectionId,
    latencyMs: 0,
    order: 2,
    signalType: 'Instrument Audio',
    toPatchTabId: stageStableAudio3Id,
    toPortId: 'audio-in',
  };
  const patchTab = {
    id: stageStableAudio3Id,
    inputBindings: [
      {
        connectionIds: [connection.id],
        kind: 'connection' as const,
        portId: 'audio-in',
      },
    ],
    name: 'Stable Audio 3',
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
    parameters: [
      {
        id: 'prompt',
        kind: 'text' as const,
        label: 'Prompt',
        value: 'Continue as a polished instrumental arrangement',
      },
      {
        id: 'durationSeconds',
        kind: 'slider' as const,
        label: 'Duration',
        max: 380,
        min: 1,
        step: 1,
        unit: 's',
        value: 1,
      },
      {
        id: 'seed',
        kind: 'slider' as const,
        label: 'Seed',
        max: 0xffff_ffff,
        min: 0,
        step: 1,
        value: 7,
      },
      ...(takes === undefined
        ? []
        : [
            {
              id: 'takes',
              kind: 'number' as const,
              label: 'Takes',
              max: 3,
              min: 1,
              step: 1,
              value: takes,
            },
          ]),
      {
        id: 'strength',
        kind: 'slider' as const,
        label: 'Strength',
        max: 1,
        min: 0,
        step: 0.05,
        value: 0.4,
      },
    ],
    portContract: definition,
  };

  return {
    ...base,
    plan: {
      ...base.plan,
      graphSnapshot: {
        ...base.plan.graphSnapshot,
        families: base.plan.graphSnapshot.families.map((family) =>
          family.familyId === familyId &&
          family.familyRevision === familyRevision
            ? {
                ...family,
                connectionOrder: [
                  ...family.connectionOrder,
                  connection.id,
                ],
                connections: [...family.connections, connection],
                patchTabOrder: [
                  ...family.patchTabOrder,
                  patchTab.id,
                ],
                patchTabs: [...family.patchTabs, patchTab],
              }
            : family,
        ),
      },
      targetPlans: base.plan.targetPlans.map((targetPlan) => ({
        ...targetPlan,
        families: targetPlan.families.map((family) =>
          family.familyId === familyId &&
          family.familyRevision === familyRevision
            ? {
                ...family,
                stages: [
                  ...family.stages,
                  {
                    dependsOnStageIds: [stageInstrumentId],
                    incomingConnectionIds: [connection.id],
                    scope,
                  },
                ],
              }
            : family,
        ),
      })),
    },
    stages: [
      ...base.stages,
      {
        execution: {
          kind: 'provider',
          modelId: STABLE_AUDIO_3_MODEL_ID,
          modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
          providerId: STABLE_AUDIO_3_PROVIDER_ID,
          providerRevision: STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
          taskId: STABLE_AUDIO_3_TASK_ID,
        },
        portBindings: [
          {
            bindingKinds: ['connection'],
            connectionIds: [connection.id],
            portId: 'audio-in',
            sourceCount: 1,
          },
        ],
        resourceInputs: [],
        scope,
      },
    ],
  };
}

export function createRuntimeTarget(
  additions: Readonly<{
    artifactIds?: readonly string[];
    artifactIdentities?: AutoPatchRuntimeTargetSnapshot['artifactIdentities'];
    clipTakeIds?: readonly string[];
  }> = {},
): AutoPatchRuntimeTargetSnapshot {
  return {
    artifactIdentities: additions.artifactIdentities ?? [],
    availability: {
      artifactIds: [
        sourceArtifactId,
        ...(additions.artifactIds ?? []),
      ],
      clipTakeIds: [
        sourceClipTakeId,
        ...(additions.clipTakeIds ?? []),
      ],
    },
    targetClipId,
  };
}

export function createCompletedResult(
  scope: TabFlowStageResultScope,
  fingerprint: string,
  resultId: string,
  outputArtifactIds: readonly string[],
  outputClipTakeIds: readonly string[],
): CompletedTabFlowStageResultRecord {
  return {
    fingerprint,
    finishedAt: '2026-07-31T00:01:00.000Z',
    outputArtifactIds,
    outputClipTakeIds,
    resultId,
    scope,
    state: 'COMPLETED',
  };
}

export function createScope(
  stageId: string,
): TabFlowStageResultScope {
  return {
    familyId,
    familyRevision,
    stageId,
    targetClipId,
  };
}

export function requireDefinition(
  nodeTypeId: string,
): PatchTabDefinition {
  const definition = getBuiltinPatchTabDefinitions().find(
    (candidate) => candidate.nodeTypeId === nodeTypeId,
  );

  if (!definition) {
    throw new Error(
      `Missing built-in PatchTab definition: ${nodeTypeId}`,
    );
  }

  return definition;
}

export function requireFrontier(
  resolution: ReturnType<typeof createAutoPatchExecutionFrontier>,
) {
  if (!resolution.canPlan) {
    throw new Error(resolution.message);
  }

  return resolution.frontier;
}
