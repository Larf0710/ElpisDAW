import { describe, expect, it } from 'vitest';

import {
  completeAutoPatchInstrumentStage,
  type AutoPatchInstrumentStageCompletionOptions,
} from './autoPatchInstrumentStageCompletion';
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
  soundFontResourceId,
  soundFontRevision,
  sourceArtifactId,
  sourceClipTakeId,
  stageInstrumentId,
  stageMidiEditId,
  targetClipId,
  requireDefinition,
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

const runId = 'run-instrument-completion';
const outputClipId = 'clip-auto-patch-instrument';
const resultId = 'result-auto-patch-instrument';
const options: AutoPatchInstrumentStageCompletionOptions = {
  label: 'Auto Patch Instrument Render',
  outputClipId,
  resultId,
};

describe('Auto Patch Instrument Stage completion', () => {
  it('atomically registers Instrument output and completes the Runtime Coordinator', () => {
    const fixture = createFixture();
    const result = completeAutoPatchInstrumentStage(
      fixture.project,
      fixture.coordinator,
      fixture.runner,
      options,
    );

    expect(result).toMatchObject({
      artifact: {
        artifactId: instrumentArtifactId,
        destination: 'instrument',
        sourceJobId: 'job-auto-patch-instrument',
      },
      clipTake: {
        artifactId: instrumentArtifactId,
        mediaType: 'audio',
        sourceType: 'job',
      },
      coordinator: { status: 'COMPLETED' },
      ok: true,
      outputClip: {
        id: outputClipId,
        sourceClipId: targetClipId,
        type: 'instrument-audio',
      },
      registrationStatus: 'REGISTERED',
      result: {
        resultId,
        state: 'COMPLETED',
      },
      status: 'COMPLETED',
    });

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(findClips(result.project, outputClipId)).toHaveLength(1);
    expect(result.project.artifacts).toHaveLength(3);
    expect(result.project.tabFlowStageResults).toEqual(
      result.coordinator.stageResults,
    );
    expect(result.coordinator.runtimeTargets[0]).toMatchObject({
      artifactIdentities: [
        { artifactId: editedArtifactId, mediaType: 'midi' },
        { artifactId: instrumentArtifactId, mediaType: 'audio' },
      ],
      availability: {
        artifactIds: expect.arrayContaining([instrumentArtifactId]),
        clipTakeIds: expect.arrayContaining([
          result.clipTake.clipTakeId,
        ]),
      },
    });
    expect(findClips(fixture.project, outputClipId)).toHaveLength(0);
    expect(fixture.project.artifacts).toHaveLength(2);
  });

  it('rejects a completed Job whose run identity differs without changing Project data', () => {
    const fixture = createFixture();
    const snapshot = JSON.stringify(fixture.project);
    const mismatchedRunner = {
      ...fixture.runner,
      fingerprint: 'wrong-fingerprint',
    };

    expect(
      completeAutoPatchInstrumentStage(
        fixture.project,
        fixture.coordinator,
        mismatchedRunner,
        options,
      ),
    ).toMatchObject({
      cause: 'runner-coordinator-mismatch',
      ok: false,
      reason: 'identity-mismatch',
    });
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
    expect(findClips(fixture.project, outputClipId)).toHaveLength(0);
  });

  it('rejects stale Project Stage Results before creating output', () => {
    const fixture = createFixture();
    const staleProject = {
      ...fixture.project,
      tabFlowStageResults: [],
    };

    expect(
      completeAutoPatchInstrumentStage(
        staleProject,
        fixture.coordinator,
        fixture.runner,
        options,
      ),
    ).toMatchObject({
      cause: 'project-stage-results-changed',
      ok: false,
      reason: 'project-stale',
    });
    expect(findClips(staleProject, outputClipId)).toHaveLength(0);
  });

  it('rejects a PatchTab that changed after the runtime graph snapshot', () => {
    const fixture = createFixture();
    const changedProject = {
      ...fixture.project,
      patchTabs: fixture.project.patchTabs.map((patchTab) =>
        patchTab.id === stageInstrumentId
          ? { ...patchTab, nodeVersion: 'changed-version' }
          : patchTab,
      ),
    };

    expect(
      completeAutoPatchInstrumentStage(
        changedProject,
        fixture.coordinator,
        fixture.runner,
        options,
      ),
    ).toMatchObject({
      cause: 'instrument-output-context-invalid',
      ok: false,
      reason: 'output-invalid',
    });
    expect(findClips(changedProject, outputClipId)).toHaveLength(0);
  });

  it('rolls back the derived Clip when Instrument registration rejects a stale Active Take', () => {
    const fixture = createFixture();
    const staleProject = JSON.parse(
      JSON.stringify(fixture.project),
    ) as ProjectState;
    const sourceClip = findClips(staleProject, targetClipId)[0];

    sourceClip.activeClipTakeId = sourceClipTakeId;
    const snapshot = JSON.stringify(staleProject);

    const result = completeAutoPatchInstrumentStage(
      staleProject,
      fixture.coordinator,
      fixture.runner,
      options,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'registration-failed',
    });
    expect(findClips(staleProject, outputClipId)).toHaveLength(0);
    expect(staleProject.artifacts).toHaveLength(2);
    expect(JSON.stringify(staleProject)).toBe(snapshot);
  });

  it('rolls back the derived Clip and registration when Coordinator completion rejects the result', () => {
    const fixture = createFixture();
    const snapshot = JSON.stringify(fixture.project);

    expect(
      completeAutoPatchInstrumentStage(
        fixture.project,
        fixture.coordinator,
        fixture.runner,
        { ...options, resultId: 'result-midi-edit' },
      ),
    ).toMatchObject({
      cause: 'completed-stage-result-invalid',
      ok: false,
      reason: 'coordinator-rejected',
    });
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
    expect(findClips(fixture.project, outputClipId)).toHaveLength(0);
  });

  it('recovers idempotently from an already registered Job without duplicating output', () => {
    const fixture = createFixture();
    const first = completeAutoPatchInstrumentStage(
      fixture.project,
      fixture.coordinator,
      fixture.runner,
      options,
    );

    if (!first.ok) {
      throw new Error(first.message);
    }

    const recoveryProject = {
      ...first.project,
      tabFlowStageResults: fixture.project.tabFlowStageResults,
    };
    expect(first.outputClip.audioTiming).toEqual({
      timeBase: 'absolute-seconds',
      sourceStartSeconds: 0,
      sourceEndSeconds: first.artifact.audio.durationSeconds,
    });
    const recovered = completeAutoPatchInstrumentStage(
      recoveryProject,
      fixture.coordinator,
      fixture.runner,
      options,
    );

    expect(recovered).toMatchObject({
      ok: true,
      registrationStatus: 'ALREADY_REGISTERED',
      status: 'COMPLETED',
    });

    if (!recovered.ok) {
      throw new Error(recovered.message);
    }

    expect(findClips(recovered.project, outputClipId)).toHaveLength(1);
    expect(recovered.project.artifacts).toHaveLength(3);
    expect(
      findClips(recovered.project, outputClipId)[0].clipTakes,
    ).toHaveLength(1);
  });
});

type CompletionFixture = Readonly<{
  coordinator: AutoPatchRuntimeCoordinator;
  project: ProjectState;
  runner: Extract<AutoPatchStageRunnerResult, { ok: true }>;
}>;

function createFixture(): CompletionFixture {
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
  const runtime = createInstrumentRunningCoordinator(
    sourceHash,
    editedHash,
  );
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
  const job = createCompletedJob(editedArtifact, editedTake);

  if (runtime.coordinator.status !== 'RUNNING') {
    throw new Error('Expected one running Instrument Stage');
  }

  return {
    coordinator: runtime.coordinator,
    project,
    runner: Object.freeze({
      adapterId: AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID,
      attemptId: runtime.coordinator.activeAttempt.attemptId,
      fingerprint: runtime.coordinator.activeStage.fingerprint,
      job,
      ok: true,
      runId,
      scope: Object.freeze({ ...runtime.coordinator.activeStage.scope }),
      status: 'JOB_COMPLETED',
    }),
  };
}

function createInstrumentRunningCoordinator(
  sourceHash: string,
  editedHash: string,
): Readonly<{
  coordinator: AutoPatchRuntimeCoordinator;
  midiResult: CompletedTabFlowStageResultRecord;
}> {
  const initial = requireCoordinator(
    createAutoPatchRuntimeCoordinator({
      createdAt: '2026-07-31T00:00:00.000Z',
      runId,
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
  const instrumentReady = requireCoordinator(
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
  const instrumentRunning = requireCoordinator(
    beginAutoPatchRuntimeStage(instrumentReady, {
      attemptId: 'attempt-instrument',
      startedAt: '2026-07-31T00:01:10.000Z',
    }),
  );

  return { coordinator: instrumentRunning, midiResult };
}

function createCompletedJob(
  artifact: EditedMidiArtifact,
  take: EditedMidiClipTake,
): LocalEngineGpuJobRecord {
  const request = createInstrumentRenderJobRequest({
    gainDb: FLUIDSYNTH_INSTRUMENT_GAIN_DB,
    modelId: soundFontResourceId,
    modelRevision: soundFontRevision,
    plan: {
      midi: {
        ...artifact.midi,
        ticksPerQuarter: 960,
      },
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

function findClips(project: ProjectState, clipId: string) {
  return project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);
}
