import { describe, expect, it, vi } from 'vitest';

import { createAutoPatchDriverIdentityLedger } from './autoPatchDriverIdentity';
import {
  instrumentArtifactId,
  targetClipId,
} from './autoPatchExecutionFrontier.testFixture';
import { completeAutoPatchInstrumentStage } from './autoPatchInstrumentStageCompletion';
import {
  autoPatchInstrumentOutputClipId,
  autoPatchInstrumentResultId,
  createAutoPatchInstrumentStageFixture,
} from './autoPatchInstrumentStage.testFixture';
import {
  autoPatchMidiEditArtifactId,
  autoPatchMidiEditAttemptId,
  autoPatchMidiEditResultId,
  autoPatchMidiEditSourceEditId,
  createAutoPatchMidiEditStageFixture,
} from './autoPatchMidiEditStage.testFixture';
import { orchestrateAutoPatchMidiEditStage } from './autoPatchMidiEditStageOrchestrator';
import type { AutoPatchProductionDriverResult } from './autoPatchProductionDriver';
import { prepareAutoPatchProductionPersistence } from './autoPatchProductionPersistence';
import {
  commitAutoPatchProject,
  type AutoPatchProjectCommitClient,
} from './autoPatchProjectCommit';
import {
  beginAutoPatchRuntimeStage,
  failAutoPatchRuntimeStage,
  type AutoPatchReadyRuntimeCoordinator,
  type AutoPatchRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';
import type { LocalEngineProjectFileSave } from './localEngineClient';
import type { ProjectState } from './types';

const historyRequest = Object.freeze({
  entryId: 'history-partial-run',
  name: 'Auto Patch Partial Run',
  recordedAt: '2026-07-31T00:01:00.000Z',
});

const savedProject: LocalEngineProjectFileSave = Object.freeze({
  bytesWritten: 4_096,
  lastModifiedAt: '2026-07-31T00:01:02.000Z',
  projectFileName: 'Partial Run.humstudio.json',
  projectFilePath:
    'D:\\Music Projects\\Partial Run\\Partial Run.humstudio.json',
  savedAt: '2026-07-31T00:01:01.000Z',
  status: 'SAVED',
});

describe('Auto Patch production persistence preparation', () => {
  it('preserves an earlier finalized MIDI result and its failed-run history in one partial commit plan', () => {
    const fixture = createLaterStageFailure();
    const persistentResults = fixture.result.project.tabFlowStageResults;
    const preparation = prepareAutoPatchProductionPersistence(
      fixture.initialProject,
      fixture.initialCoordinator,
      fixture.result,
      {
        history: historyRequest,
        sourceAvailability: createSourceAvailability(),
      },
    );

    if (!preparation.canCommit) {
      throw new Error(preparation.message);
    }

    expect(preparation).toMatchObject({
      canCommit: true,
      historyEntry: {
        autoPatchProduction: {
          cause: 'instrument-engine-job-failed',
          completedResultIds: [autoPatchMidiEditResultId],
          resultStatus: 'FAILED',
        },
      },
      plan: {
        commitKind: 'PARTIAL',
        completedAttemptIds: [autoPatchMidiEditAttemptId],
        completedResultIds: [autoPatchMidiEditResultId],
        sourceStatus: 'FAILED',
      },
      status: 'COMMIT_READY',
    });
    expect(preparation.plan.project).toBe(preparation.project);
    expect(preparation.result.project).toBe(preparation.project);
    expect(preparation.project.tabFlowStageResults).toBe(persistentResults);
    expect(preparation.project.takes).toEqual([
      preparation.historyEntry,
    ]);
    expect(
      (preparation.project.artifacts ?? []).some(
        (artifact) => artifact.artifactId === autoPatchMidiEditArtifactId,
      ),
    ).toBe(true);
    expect(
      findClip(preparation.project, targetClipId).clipTakes?.some(
        (clipTake) =>
          clipTake.artifactId === autoPatchMidiEditArtifactId,
      ),
    ).toBe(true);
  });

  it('writes the prepared partial Project only through the explicit commit command', async () => {
    const fixture = createLaterStageFailure();
    const preparation = prepareAutoPatchProductionPersistence(
      fixture.initialProject,
      fixture.initialCoordinator,
      fixture.result,
      {
        history: historyRequest,
        sourceAvailability: createSourceAvailability(),
      },
    );
    const saveProjectFile = vi.fn(async () => ({
      ok: true as const,
      savedProject,
    }));
    const client: AutoPatchProjectCommitClient = { saveProjectFile };

    expect(saveProjectFile).not.toHaveBeenCalled();

    if (!preparation.canCommit) {
      throw new Error(preparation.message);
    }

    const projectFile = {
      app: 'HumSTUDIO',
      savedAt: savedProject.savedAt,
      version: '0.1.0',
      workspace: { project: preparation.project },
    };
    const committed = await commitAutoPatchProject(
      client,
      preparation.plan,
      {
        currentProject: preparation.project,
        materializeProjectFile: () => projectFile,
      },
    );

    expect(committed).toMatchObject({ ok: true, status: 'COMMITTED' });
    expect(saveProjectFile).toHaveBeenCalledTimes(1);
    expect(saveProjectFile).toHaveBeenCalledWith(projectFile);
    expect(projectFile.workspace.project.takes).toContain(
      preparation.historyEntry,
    );
    expect(projectFile.workspace.project.tabFlowStageResults).toContainEqual(
      expect.objectContaining({ resultId: autoPatchMidiEditResultId }),
    );
  });

  it('rejects a partial commit when the earlier finalized Artifact disappeared after Stage failure', () => {
    const fixture = createLaterStageFailure();
    const brokenResult: AutoPatchProductionDriverResult = Object.freeze({
      ...fixture.result,
      project: {
        ...fixture.result.project,
        artifacts: (fixture.result.project.artifacts ?? []).filter(
          (artifact) =>
            artifact.artifactId !== autoPatchMidiEditArtifactId,
        ),
      },
    });
    const preparation = prepareAutoPatchProductionPersistence(
      fixture.initialProject,
      fixture.initialCoordinator,
      brokenResult,
      {
        history: historyRequest,
        sourceAvailability: createSourceAvailability(),
      },
    );

    expect(preparation).toMatchObject({
      canCommit: false,
      cause: 'production-persistence-artifact-unavailable',
      historyEntry: {
        autoPatchProduction: { resultStatus: 'FAILED' },
      },
      reason: 'finalized-output-unavailable',
      status: 'NOT_COMMITTABLE',
    });
    expect(preparation.project.takes).toHaveLength(1);
  });

  it('requires Engine-verified Audio identity before a completed Audio result becomes committable', () => {
    const fixture = createCompletedInstrumentRun();
    const unverified = prepareAutoPatchProductionPersistence(
      fixture.initialProject,
      fixture.initialCoordinator,
      fixture.result,
      {
        history: {
          ...historyRequest,
          entryId: 'history-completed-instrument',
          name: 'Auto Patch Completed Run',
          recordedAt: '2026-07-31T00:03:00.000Z',
        },
        sourceAvailability: createSourceAvailability(),
      },
    );

    expect(unverified).toMatchObject({
      canCommit: false,
      cause: 'production-persistence-artifact-unavailable',
      reason: 'finalized-output-unavailable',
    });

    const verified = prepareAutoPatchProductionPersistence(
      fixture.initialProject,
      fixture.initialCoordinator,
      fixture.result,
      {
        history: {
          ...historyRequest,
          entryId: 'history-completed-instrument',
          name: 'Auto Patch Completed Run',
          recordedAt: '2026-07-31T00:03:00.000Z',
        },
        sourceAvailability: createSourceAvailability([instrumentArtifactId]),
      },
    );

    expect(verified).toMatchObject({
      canCommit: true,
      plan: {
        commitKind: 'COMPLETED',
        completedResultIds: [autoPatchInstrumentResultId],
      },
      status: 'COMMIT_READY',
    });
  });

  it('retains a no-output blocked run in memory without inventing a partial commit plan', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const initialCoordinator = requireReady(fixture.coordinatorReady);
    const blockedResult: AutoPatchProductionDriverResult = Object.freeze({
      cause: 'production-driver-stage-unsupported',
      coordinator: initialCoordinator,
      ledger: createAutoPatchDriverIdentityLedger(initialCoordinator),
      message: 'Auto Patch production Driver cannot dispatch this Stage.',
      ok: false,
      project: fixture.project,
      reason: 'driver-invariant',
      status: 'BLOCKED',
    });
    const preparation = prepareAutoPatchProductionPersistence(
      fixture.project,
      initialCoordinator,
      blockedResult,
      {
        history: historyRequest,
        sourceAvailability: createSourceAvailability(),
      },
    );

    expect(preparation).toMatchObject({
      canCommit: false,
      cause: 'project-commit-finalized-output-missing',
      historyEntry: {
        autoPatchProduction: {
          completedResultIds: [],
          resultStatus: 'BLOCKED',
        },
      },
      reason: 'project-not-committable',
    });
    expect(preparation.project.takes).toHaveLength(1);
    expect(preparation.result.project).toBe(preparation.project);
  });

  it('rejects invalid Audio availability before writing Run History', () => {
    const fixture = createLaterStageFailure();
    const preparation = prepareAutoPatchProductionPersistence(
      fixture.initialProject,
      fixture.initialCoordinator,
      fixture.result,
      {
        history: historyRequest,
        sourceAvailability: createSourceAvailability([' artifact-audio ']),
      },
    );

    expect(preparation).toMatchObject({
      canCommit: false,
      cause: 'production-persistence-audio-availability-invalid',
      project: fixture.result.project,
      reason: 'availability-invalid',
    });
    expect(preparation.project.takes).toEqual([]);
    expect(preparation).not.toHaveProperty('historyEntry');
  });
});

type LaterStageFailureFixture = Readonly<{
  initialCoordinator: AutoPatchReadyRuntimeCoordinator;
  initialProject: ProjectState;
  result: Extract<AutoPatchProductionDriverResult, { status: 'FAILED' }>;
}>;

function createLaterStageFailure(): LaterStageFailureFixture {
  const fixture = createAutoPatchMidiEditStageFixture();
  const initialCoordinator = requireReady(fixture.coordinatorReady);
  const midiStage = orchestrateAutoPatchMidiEditStage(
    fixture.project,
    initialCoordinator,
    {
      artifactId: autoPatchMidiEditArtifactId,
      attemptId: autoPatchMidiEditAttemptId,
      finishedAt: '2026-07-31T00:00:20.000Z',
      resultId: autoPatchMidiEditResultId,
      sourceEditId: autoPatchMidiEditSourceEditId,
      startedAt: '2026-07-31T00:00:10.000Z',
    },
  );

  if (!midiStage.ok || midiStage.coordinator.status !== 'READY') {
    throw new Error(
      midiStage.ok ? 'Expected the later Stage to be READY.' : midiStage.message,
    );
  }

  const beginning = beginAutoPatchRuntimeStage(midiStage.coordinator, {
    attemptId: 'attempt-instrument-failed',
    startedAt: '2026-07-31T00:00:30.000Z',
  });

  if (!beginning.ok || beginning.coordinator.status !== 'RUNNING') {
    throw new Error(
      beginning.ok ? 'Expected the later Stage to be RUNNING.' : beginning.message,
    );
  }

  const failed = failAutoPatchRuntimeStage(beginning.coordinator, {
    attemptId: 'attempt-instrument-failed',
    cause: 'instrument-engine-job-failed',
    failedAt: '2026-07-31T00:00:40.000Z',
    message: 'Instrument render failed after MIDI Edit completed.',
  });

  if (!failed.ok || failed.coordinator.status !== 'FAILED') {
    throw new Error(
      failed.ok ? 'Expected the later Stage to be FAILED.' : failed.message,
    );
  }

  return Object.freeze({
    initialCoordinator,
    initialProject: fixture.project,
    result: Object.freeze({
      cause: 'instrument-engine-job-failed',
      coordinator: failed.coordinator,
      ledger: createAutoPatchDriverIdentityLedger(initialCoordinator),
      message: 'Instrument render failed after MIDI Edit completed.',
      ok: false as const,
      project: midiStage.project,
      reason: 'stage-failed' as const,
      scope: Object.freeze({ ...failed.coordinator.failure.scope }),
      status: 'FAILED' as const,
    }),
  });
}

function createCompletedInstrumentRun() {
  const fixture = createAutoPatchInstrumentStageFixture();
  const initialCoordinator = requireReady(fixture.coordinatorReady);
  const completed = completeAutoPatchInstrumentStage(
    fixture.project,
    fixture.coordinatorRunning,
    fixture.runner,
    {
      outputClipId: autoPatchInstrumentOutputClipId,
      resultId: autoPatchInstrumentResultId,
    },
  );

  if (!completed.ok || completed.coordinator.status !== 'COMPLETED') {
    throw new Error(
      completed.ok ? 'Expected completed Instrument run.' : completed.message,
    );
  }

  return Object.freeze({
    initialCoordinator,
    initialProject: fixture.project,
    result: Object.freeze({
      coordinator: completed.coordinator,
      ledger: createAutoPatchDriverIdentityLedger(initialCoordinator),
      ok: true as const,
      project: completed.project,
      status: 'COMPLETED' as const,
    }),
  });
}

function findClip(project: ProjectState, clipId: string) {
  const matches = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);

  if (matches.length !== 1) {
    throw new Error(`Expected one Clip ${clipId}.`);
  }

  return matches[0];
}

function createSourceAvailability(
  availableArtifactIds: readonly string[] = [],
) {
  return Object.freeze({
    availableArtifactIds: Object.freeze([...availableArtifactIds]),
    checkedAt: '2026-07-31T00:02:00.000Z',
  });
}

function requireReady(
  coordinator: AutoPatchRuntimeCoordinator,
): AutoPatchReadyRuntimeCoordinator {
  if (coordinator.status !== 'READY') {
    throw new Error('Expected one READY Auto Patch Coordinator.');
  }

  return coordinator;
}
