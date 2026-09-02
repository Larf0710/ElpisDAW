import {
  beginAutoPatchRuntimeStage,
  completeAutoPatchRuntimeStage,
  createAutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeCoordinatorResolution,
} from './autoPatchRuntimeCoordinator';
import {
  createCompletedResult,
  createRuntimeTarget,
  createScope,
  createValidatedPreflight,
  editedArtifactId,
  editedClipTakeId,
  instrumentArtifactId,
  requireDefinition,
  soundFontResourceId,
  soundFontRevision,
  sourceArtifactId,
  sourceClipTakeId,
  stageInstrumentId,
  stageMidiEditId,
  targetClipId,
} from './autoPatchExecutionFrontier.testFixture';
import { AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID } from './autoPatchStageAdapter';
import type { AutoPatchStageRunnerResult } from './autoPatchStageRunner';
import {
  FLUIDSYNTH_INSTRUMENT_GAIN_DB,
  FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
  FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
  FLUIDSYNTH_INSTRUMENT_SAMPLE_RATE,
} from './fluidSynthInstrumentRender';
import { createInstrumentRenderJobRequest } from './instrumentRenderContract';
import type { LocalEngineSoundFontResource } from './localEngineClient';
import { createMidiContentHash } from './midiContentHash';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import type {
  CompletedTabFlowStageResultRecord,
  EditedMidiArtifact,
  EditedMidiClipTake,
  ManualMidiArtifact,
  ManualMidiClipTake,
  PatchTab,
  ProjectState,
} from './types';

export const autoPatchInstrumentRunId = 'run-instrument-completion';
export const autoPatchInstrumentAttemptId = 'attempt-instrument';
export const autoPatchInstrumentOutputClipId =
  'clip-auto-patch-instrument';
export const autoPatchInstrumentResultId =
  'result-auto-patch-instrument';

export type AutoPatchInstrumentStageFixture = Readonly<{
  coordinatorReady: AutoPatchRuntimeCoordinator;
  coordinatorRunning: AutoPatchRuntimeCoordinator;
  project: ProjectState;
  runner: Extract<AutoPatchStageRunnerResult, { ok: true }>;
  soundFontResources: readonly LocalEngineSoundFontResource[];
}>;

export function createAutoPatchInstrumentStageFixture(): AutoPatchInstrumentStageFixture {
  const sourceMidi = {
    bpm: 120,
    notes: [
      {
        id: 'note-source',
        lengthTicks: 960,
        pitch: 60,
        startTick: 0,
        velocity: 100,
      },
    ],
    ticksPerQuarter: 960 as const,
  };
  const editedMidi = {
    ...sourceMidi,
    notes: [{ ...sourceMidi.notes[0], pitch: 62 }],
  };
  const sourceHash = createMidiContentHash(sourceMidi);
  const editedHash = createMidiContentHash(editedMidi);
  const sourceArtifact: ManualMidiArtifact = {
    artifactId: sourceArtifactId,
    contentHash: sourceHash,
    createdAt: '2026-07-31T00:00:00.000Z',
    kind: 'midi',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    manualProvenance: {
      editorId: 'humstudio.piano-roll',
      editorVersion: '1',
      taskId: 'manual-midi',
    },
    midi: sourceMidi,
    revision: 1,
    sourceManualId: 'manual-source',
    updatedAt: '2026-07-31T00:00:00.000Z',
  };
  const sourceTake: ManualMidiClipTake = {
    artifactId: sourceArtifactId,
    clipTakeId: sourceClipTakeId,
    contentHash: sourceHash,
    createdAt: sourceArtifact.createdAt,
    label: 'Source MIDI',
    mediaType: 'midi',
    revision: 1,
    sourceManualId: sourceArtifact.sourceManualId,
    sourceType: 'manual',
    updatedAt: sourceArtifact.updatedAt,
  };
  const editedArtifact: EditedMidiArtifact = {
    artifactId: editedArtifactId,
    contentHash: editedHash,
    createdAt: '2026-07-31T00:01:00.000Z',
    editProvenance: {
      editorId: 'humstudio.midi-edit',
      editorVersion: '1',
      taskId: 'midi-edit',
    },
    kind: 'midi',
    lineage: {
      parentArtifactIds: [sourceArtifactId],
      parentClipTakeIds: [sourceClipTakeId],
    },
    midi: editedMidi,
    revision: 1,
    sourceEditId: 'edit-auto-patch',
    updatedAt: '2026-07-31T00:01:00.000Z',
  };
  const editedTake: EditedMidiClipTake = {
    artifactId: editedArtifactId,
    clipTakeId: editedClipTakeId,
    contentHash: editedHash,
    createdAt: editedArtifact.createdAt,
    label: 'Edited MIDI',
    mediaType: 'midi',
    revision: 1,
    sourceEditId: editedArtifact.sourceEditId,
    sourceType: 'edit',
    updatedAt: editedArtifact.updatedAt,
  };
  const runtime = createInstrumentReadyCoordinator(sourceHash, editedHash);
  const patchTab = createInstrumentPatchTab();
  const project: ProjectState = {
    artifacts: [sourceArtifact, editedArtifact],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'Auto Patch Instrument Completion Test',
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
    tabFlowStageResults: [runtime.midiResult],
    takes: [],
    totalTicks: 7_680,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: editedClipTakeId,
            clipTakes: [sourceTake, editedTake],
            color: '#3b82f6',
            createdAt: sourceArtifact.createdAt,
            id: targetClipId,
            lengthTicks: 7_680,
            name: 'Auto Patch MIDI',
            soundFont: {
              bank: 0,
              program: 0,
              resource: {
                format: 'sf2',
                library: 'project',
                relativePath: 'soundfonts/Piano.sf2',
                resourceId: soundFontResourceId,
              },
            },
            startTick: 0,
            type: 'midi-notes',
            version: 2,
          },
        ],
        id: 'track-midi',
        level: -6,
        name: 'Auto Patch MIDI',
        type: 'midi',
      },
    ],
  };
  const running = requireCoordinator(
    beginAutoPatchRuntimeStage(runtime.coordinatorReady, {
      attemptId: autoPatchInstrumentAttemptId,
      startedAt: '2026-07-31T00:01:10.000Z',
    }),
  );

  if (running.status !== 'RUNNING') {
    throw new Error('Expected one running Instrument Stage');
  }

  const job = createCompletedInstrumentJob(editedArtifact, editedTake);

  return {
    coordinatorReady: runtime.coordinatorReady,
    coordinatorRunning: running,
    project,
    runner: Object.freeze({
      adapterId: AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID,
      attemptId: running.activeAttempt.attemptId,
      fingerprint: running.activeStage.fingerprint,
      job,
      ok: true,
      runId: autoPatchInstrumentRunId,
      scope: Object.freeze({ ...running.activeStage.scope }),
      status: 'JOB_COMPLETED',
    }),
    soundFontResources: Object.freeze([
      Object.freeze({
        format: 'sf2' as const,
        lastModifiedAt: '2026-07-31T00:00:00.000Z',
        library: 'project' as const,
        name: 'Piano.sf2',
        relativePath: 'soundfonts/Piano.sf2',
        resourceId: soundFontResourceId,
        revisionToken: soundFontRevision,
        sizeBytes: 1_024,
        status: 'AVAILABLE' as const,
      }),
    ]),
  };
}

function createInstrumentReadyCoordinator(
  sourceHash: string,
  editedHash: string,
): Readonly<{
  coordinatorReady: AutoPatchRuntimeCoordinator;
  midiResult: CompletedTabFlowStageResultRecord;
}> {
  const initial = requireCoordinator(
    createAutoPatchRuntimeCoordinator({
      createdAt: '2026-07-31T00:00:00.000Z',
      runId: autoPatchInstrumentRunId,
      runtimeTargets: [createRuntimeTarget()],
      stageResults: [],
      validatedPreflight: createValidatedPreflight({
        sourceContentHash: sourceHash,
      }),
    }),
  );
  const midiRunning = requireCoordinator(
    beginAutoPatchRuntimeStage(initial, {
      attemptId: 'attempt-midi-edit',
      startedAt: '2026-07-31T00:00:10.000Z',
    }),
  );

  if (midiRunning.status !== 'RUNNING') {
    throw new Error('Expected one running MIDI Edit Stage');
  }

  const midiResult = createCompletedResult(
    createScope(stageMidiEditId),
    midiRunning.activeStage.fingerprint,
    'result-midi-edit',
    [editedArtifactId],
    [editedClipTakeId],
  );
  const coordinatorReady = requireCoordinator(
    completeAutoPatchRuntimeStage(midiRunning, {
      attemptId: 'attempt-midi-edit',
      result: midiResult,
      runtimeTarget: createRuntimeTarget({
        artifactIds: [editedArtifactId],
        artifactIdentities: [
          {
            artifactId: editedArtifactId,
            mediaType: 'midi',
            midi: { contentHash: editedHash, revision: 1 },
          },
        ],
        clipTakeIds: [editedClipTakeId],
      }),
    }),
  );

  return { coordinatorReady, midiResult };
}

function createCompletedInstrumentJob(
  artifact: EditedMidiArtifact,
  take: EditedMidiClipTake,
): LocalEngineGpuJobRecord {
  const request = createInstrumentRenderJobRequest({
    gainDb: FLUIDSYNTH_INSTRUMENT_GAIN_DB,
    modelId: soundFontResourceId,
    modelRevision: soundFontRevision,
    plan: {
      midi: { ...artifact.midi, ticksPerQuarter: 960 },
      source: {
        artifactId: artifact.artifactId,
        clipId: targetClipId,
        clipTakeId: take.clipTakeId,
        contentHash: artifact.contentHash ?? '',
        label: take.label,
        revision: artifact.revision ?? 0,
        sourceType: take.sourceType,
      },
    },
    preset: { bank: 0, program: 0 },
    providerId: FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
    providerVersion: FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
    sampleRate: FLUIDSYNTH_INSTRUMENT_SAMPLE_RATE,
    soundFont: {
      format: 'sf2',
      library: 'project',
      relativePath: 'soundfonts/Piano.sf2',
      resourceId: soundFontResourceId,
      revisionToken: soundFontRevision,
    },
  });
  const createdAt = '2026-07-31T00:01:11.000Z';
  const finishedAt = '2026-07-31T00:02:00.000Z';

  return {
    attempt: 1,
    createdAt,
    finishedAt,
    history: [
      { attempt: 1, at: createdAt, state: 'QUEUED' },
      { attempt: 1, at: createdAt, state: 'PROCESSING' },
      { attempt: 1, at: finishedAt, state: 'SAVING' },
      { attempt: 1, at: finishedAt, state: 'COMPLETED' },
    ],
    jobId: 'job-auto-patch-instrument',
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    providerId: request.providerId,
    request,
    result: {
      artifact: {
        artifactId: instrumentArtifactId,
        createdAt: finishedAt,
        destination: 'instrument',
        file: {
          extension: '.wav',
          name: `${instrumentArtifactId}.wav`,
          relativePath: `renders/instruments/${instrumentArtifactId}.wav`,
          sizeBytes: 192_044,
        },
        kind: 'audio',
        lineage: request.lineage,
        provenance: {
          modelId: request.modelId,
          modelRevision: request.modelRevision,
          parameters: request.parameters,
          providerId: request.providerId,
          taskId: request.taskId,
        },
      },
      generation: {
        bytesWritten: 192_044,
        channels: 2,
        durationSeconds: 1,
        mimeType: 'audio/wav',
        providerCompletedAt: finishedAt,
      },
    },
    state: 'COMPLETED',
    taskId: request.taskId,
    updatedAt: finishedAt,
  };
}

function createInstrumentPatchTab(): PatchTab {
  const definition = requireDefinition(
    BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
  );

  return {
    colorIndex: 3,
    description: 'Render MIDI through the assigned SoundFont.',
    id: stageInstrumentId,
    inputType: 'Edited MIDI',
    name: 'MIDI TO AUDIO',
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
    outputType: 'Instrument Audio',
    parameters: [],
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
