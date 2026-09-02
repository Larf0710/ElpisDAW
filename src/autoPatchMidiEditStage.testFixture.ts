import {
  beginAutoPatchRuntimeStage,
  createAutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeCoordinatorResolution,
  type AutoPatchRuntimeStageDispatch,
} from './autoPatchRuntimeCoordinator';
import {
  createRuntimeTarget,
  createValidatedPreflight,
  requireDefinition,
  sourceArtifactId,
  sourceClipTakeId,
  stageMidiEditId,
  targetClipId,
} from './autoPatchExecutionFrontier.testFixture';
import {
  createAutoPatchMidiEditStagePlan,
  type AutoPatchMidiEditProcessorOutcome,
  type AutoPatchMidiEditStagePlan,
} from './autoPatchMidiEditStage';
import { processAutoPatchMidiEditStage } from './autoPatchMidiEditProcessor';
import { createMidiContentHash } from './midiContentHash';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import type {
  ManualMidiArtifact,
  ManualMidiClipTake,
  PatchTab,
  ProjectState,
} from './types';

export const autoPatchMidiEditRunId = 'run-midi-edit-completion';
export const autoPatchMidiEditAttemptId = 'attempt-midi-edit';
export const autoPatchMidiEditArtifactId = 'artifact-midi-edited';
export const autoPatchMidiEditSourceEditId = 'edit-auto-patch-midi';
export const autoPatchMidiEditResultId = 'result-midi-edit';

export type AutoPatchMidiEditStageFixture = Readonly<{
  coordinatorReady: AutoPatchRuntimeCoordinator;
  coordinatorRunning: AutoPatchRuntimeCoordinator;
  dispatch: AutoPatchRuntimeStageDispatch;
  outcome: AutoPatchMidiEditProcessorOutcome;
  plan: AutoPatchMidiEditStagePlan;
  project: ProjectState;
}>;

export function createAutoPatchMidiEditStageFixture(): AutoPatchMidiEditStageFixture {
  const midi = {
    bpm: 120,
    notes: [
      {
        id: 'note-source',
        lengthTicks: 960,
        pitch: 60,
        startTick: 121,
        velocity: 100,
      },
    ],
    ticksPerQuarter: 960 as const,
  };
  const contentHash = createMidiContentHash(midi);
  const sourceArtifact: ManualMidiArtifact = {
    artifactId: sourceArtifactId,
    contentHash,
    createdAt: '2026-07-31T00:00:00.000Z',
    kind: 'midi',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    manualProvenance: {
      editorId: 'humstudio.piano-roll',
      editorVersion: '1',
      taskId: 'manual-midi',
    },
    midi,
    revision: 1,
    sourceManualId: 'manual-midi-source',
    updatedAt: '2026-07-31T00:00:00.000Z',
  };
  const sourceTake: ManualMidiClipTake = {
    artifactId: sourceArtifact.artifactId,
    clipTakeId: sourceClipTakeId,
    contentHash,
    createdAt: sourceArtifact.createdAt,
    label: 'Source MIDI',
    mediaType: 'midi',
    revision: 1,
    sourceManualId: sourceArtifact.sourceManualId,
    sourceType: 'manual',
    updatedAt: sourceArtifact.updatedAt,
  };
  const patchTab = createMidiEditPatchTab();
  const project: ProjectState = {
    artifacts: [sourceArtifact],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'Auto Patch MIDI Edit Test',
    patchTabs: [patchTab],
    playheadTick: 0,
    recordingSettings: {
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: patchTab.id,
    selection: { items: [] },
    status: 'READY',
    tabFlowStageResults: [],
    takes: [],
    totalTicks: 7_680,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: sourceTake.clipTakeId,
            clipTakes: [sourceTake],
            color: '#3b82f6',
            createdAt: sourceArtifact.createdAt,
            id: targetClipId,
            lengthTicks: 7_680,
            name: 'Auto Patch MIDI',
            startTick: 0,
            type: 'midi-notes',
            version: 1,
          },
        ],
        id: 'track-midi',
        level: -6,
        name: 'Auto Patch MIDI',
        type: 'midi',
      },
    ],
  };
  const coordinatorReady = requireCoordinator(
    createAutoPatchRuntimeCoordinator({
      createdAt: '2026-07-31T00:00:00.000Z',
      runId: autoPatchMidiEditRunId,
      runtimeTargets: [
        createRuntimeTarget({
          artifactIdentities: [
            {
              artifactId: sourceArtifactId,
              mediaType: 'midi',
              midi: { contentHash, revision: 1 },
            },
          ],
        }),
      ],
      stageResults: [],
      validatedPreflight: createValidatedPreflight({
        sourceContentHash: contentHash,
      }),
    }),
  );
  const beginning = beginAutoPatchRuntimeStage(coordinatorReady, {
    attemptId: autoPatchMidiEditAttemptId,
    startedAt: '2026-07-31T00:00:10.000Z',
  });

  if (!beginning.ok || !beginning.dispatch) {
    throw new Error(
      beginning.ok
        ? 'Expected one MIDI Edit dispatch.'
        : beginning.message,
    );
  }

  const planResolution = createAutoPatchMidiEditStagePlan(
    beginning.dispatch,
    project,
  );

  if (!planResolution.canPlan) {
    throw new Error(planResolution.message);
  }

  const plan = planResolution.plan;
  const processorResolution = processAutoPatchMidiEditStage(plan, {
    finishedAt: '2026-07-31T00:00:30.000Z',
  });

  if (!processorResolution.canProcess) {
    throw new Error(processorResolution.message);
  }

  const outcome = processorResolution.outcome;

  return {
    coordinatorReady,
    coordinatorRunning: beginning.coordinator,
    dispatch: beginning.dispatch,
    outcome,
    plan,
    project,
  };
}

function createMidiEditPatchTab(): PatchTab {
  const definition = requireDefinition(
    BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
  );

  return {
    colorIndex: 2,
    description: 'Shapes MIDI before downstream rendering.',
    id: stageMidiEditId,
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
        options: ['1/8', '1/16'],
        value: '1/16',
      },
    ],
    status: 'ready',
  };
}

function requireCoordinator(
  resolution: AutoPatchRuntimeCoordinatorResolution,
): AutoPatchRuntimeCoordinator {
  if (!resolution.ok) {
    throw new Error(resolution.message);
  }

  return resolution.coordinator;
}
