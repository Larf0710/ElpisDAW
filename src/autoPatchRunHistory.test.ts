import { describe, expect, it } from 'vitest';

import { createAutoPatchDriverIdentityLedger } from './autoPatchDriverIdentity';
import {
  autoPatchInstrumentOutputClipId,
  autoPatchInstrumentResultId,
  autoPatchInstrumentRunId,
  createAutoPatchInstrumentStageFixture,
} from './autoPatchInstrumentStage.testFixture';
import { completeAutoPatchInstrumentStage } from './autoPatchInstrumentStageCompletion';
import {
  createAutoPatchMidiEditStageFixture,
} from './autoPatchMidiEditStage.testFixture';
import type { AutoPatchProductionDriverResult } from './autoPatchProductionDriver';
import {
  isAutoPatchProductionRunHistoryEntry,
  MAX_AUTO_PATCH_RUN_HISTORY_ENTRIES,
  writeAutoPatchRunHistory,
} from './autoPatchRunHistory';
import {
  instrumentArtifactId,
} from './autoPatchExecutionFrontier.testFixture';
import type {
  AutoPatchReadyRuntimeCoordinator,
  AutoPatchRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';
import type { ProjectState, RunHistoryEntry } from './types';

const historyRequest = Object.freeze({
  entryId: 'history-auto-patch-production',
  name: 'Auto Patch Run 01',
  recordedAt: '2026-07-31T00:03:00.000Z',
});

describe('Auto Patch production Run History boundary', () => {
  it('writes one immutable completed RunHistoryEntry without changing the persistent Stage Result index', () => {
    const fixture = createCompletedRun();
    const persistentResults = fixture.result.project.tabFlowStageResults;
    const resolution = writeAutoPatchRunHistory(
      fixture.initialProject,
      fixture.initialCoordinator,
      fixture.result,
      historyRequest,
    );

    if (!resolution.ok) {
      throw new Error(resolution.message);
    }

    expect(resolution).toMatchObject({
      entry: {
        appliedPatchIds: ['stage-midi-edit', 'stage-instrument'],
        autoPatchProduction: {
          completedResultIds: [autoPatchInstrumentResultId],
          generatedArtifactIds: [instrumentArtifactId],
          planId: 'plan-frontier',
          referencedResultIds: [
            'result-midi-edit',
            autoPatchInstrumentResultId,
          ],
          resultStatus: 'COMPLETED',
          reusedResultIds: ['result-midi-edit'],
          runId: autoPatchInstrumentRunId,
          schemaVersion: 1,
        },
        executionMode: 'auto_patch',
        id: historyRequest.entryId,
        name: historyRequest.name,
        sourceSelection: [{ id: 'clip-midi', type: 'clip' }],
      },
      ok: true,
      status: 'RECORDED',
    });
    expect(resolution.project.takes).toEqual([resolution.entry]);
    expect(resolution.project.tabFlowStageResults).toBe(persistentResults);
    expect(fixture.result.project.takes).toEqual([]);
    expect(fixture.initialProject.takes).toEqual([]);
    expect(isAutoPatchProductionRunHistoryEntry(resolution.entry)).toBe(true);
    expect(Object.isFrozen(resolution.entry)).toBe(true);
    expect(Object.isFrozen(resolution.entry.autoPatchProduction)).toBe(true);
    expect(
      Object.isFrozen(
        resolution.entry.autoPatchProduction.graphSnapshot,
      ),
    ).toBe(true);
  });

  it('records cancellation after finalized output as history while preserving the completed lookup result', () => {
    const fixture = createCompletedRun();
    const canceledResult: AutoPatchProductionDriverResult = Object.freeze({
      cause: 'abort-signal',
      coordinator: fixture.result.coordinator,
      ledger: fixture.result.ledger,
      message: 'Auto Patch production run was canceled.',
      ok: false,
      project: fixture.result.project,
      reason: 'run-canceled',
      status: 'CANCELED',
    });
    const persistentResults = canceledResult.project.tabFlowStageResults;
    const resolution = writeAutoPatchRunHistory(
      fixture.initialProject,
      fixture.initialCoordinator,
      canceledResult,
      historyRequest,
    );

    if (!resolution.ok) {
      throw new Error(resolution.message);
    }

    expect(resolution.entry.autoPatchProduction).toMatchObject({
      cause: 'abort-signal',
      completedResultIds: [autoPatchInstrumentResultId],
      message: 'Auto Patch production run was canceled.',
      resultStatus: 'CANCELED',
    });
    expect(
      resolution.entry.logs[resolution.entry.logs.length - 1],
    ).toEqual({
      createdAt: historyRequest.recordedAt,
      level: 'warning',
      message: 'Auto Patch production run was canceled.',
    });
    expect(resolution.project.tabFlowStageResults).toBe(persistentResults);
    expect(resolution.project.tabFlowStageResults).toHaveLength(2);
  });

  it('records a blocked run with no Stage Result instead of adding a reusable lookup entry', () => {
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
      scope: Object.freeze({ ...initialCoordinator.activeStage.scope }),
      status: 'BLOCKED',
    });
    const persistentResults = fixture.project.tabFlowStageResults;
    const resolution = writeAutoPatchRunHistory(
      fixture.project,
      initialCoordinator,
      blockedResult,
      historyRequest,
    );

    if (!resolution.ok) {
      throw new Error(resolution.message);
    }

    expect(resolution.entry.autoPatchProduction).toMatchObject({
      completedResultIds: [],
      generatedArtifactIds: [],
      referencedResultIds: [],
      resultStatus: 'BLOCKED',
    });
    expect(resolution.project.tabFlowStageResults).toBe(persistentResults);
    expect(resolution.project.tabFlowStageResults).toEqual([]);
  });

  it('records reused Stage Result references without copying them into Run History as lookup records', () => {
    const fixture = createAutoPatchInstrumentStageFixture();
    const initialCoordinator = requireReady(fixture.coordinatorReady);
    const blockedResult: AutoPatchProductionDriverResult = Object.freeze({
      cause: 'instrument-runtime-unavailable',
      coordinator: initialCoordinator,
      ledger: createAutoPatchDriverIdentityLedger(initialCoordinator),
      message: 'Instrument runtime is unavailable.',
      ok: false,
      project: fixture.project,
      reason: 'driver-invariant',
      status: 'BLOCKED',
    });
    const persistentResults = fixture.project.tabFlowStageResults;
    const resolution = writeAutoPatchRunHistory(
      fixture.project,
      initialCoordinator,
      blockedResult,
      {
        ...historyRequest,
        entryId: 'history-auto-patch-instrument',
      },
    );

    if (!resolution.ok) {
      throw new Error(resolution.message);
    }

    expect(resolution.entry.autoPatchProduction).toMatchObject({
      completedResultIds: [],
      referencedResultIds: ['result-midi-edit'],
      reusedResultIds: ['result-midi-edit'],
    });
    expect(resolution.project.tabFlowStageResults).toBe(persistentResults);
    expect(resolution.project.tabFlowStageResults).toEqual([
      expect.objectContaining({ resultId: 'result-midi-edit' }),
    ]);
  });

  it('trims only bounded Run History while retaining Project results, Artifacts, ClipTakes, Clips, and Tracks', () => {
    const priorEntries = Array.from(
      { length: MAX_AUTO_PATCH_RUN_HISTORY_ENTRIES },
      (_, index) => createLegacyHistoryEntry(index + 1),
    );
    const fixture = createCompletedRun(priorEntries);
    const persistentResults = fixture.result.project.tabFlowStageResults;
    const artifacts = fixture.result.project.artifacts;
    const tracks = fixture.result.project.tracks;
    const resolution = writeAutoPatchRunHistory(
      fixture.initialProject,
      fixture.initialCoordinator,
      fixture.result,
      historyRequest,
    );

    if (!resolution.ok) {
      throw new Error(resolution.message);
    }

    expect(resolution.project.takes).toHaveLength(
      MAX_AUTO_PATCH_RUN_HISTORY_ENTRIES,
    );
    expect(resolution.project.takes[0].id).toBe('history-02');
    expect(
      resolution.project.takes[resolution.project.takes.length - 1],
    ).toBe(resolution.entry);
    expect(resolution.project.tabFlowStageResults).toBe(persistentResults);
    expect(resolution.project.artifacts).toBe(artifacts);
    expect(resolution.project.tracks).toBe(tracks);
  });

  it('rejects Project and Coordinator Stage Result mismatch without changing either history', () => {
    const fixture = createCompletedRun();
    const mismatchedResult: AutoPatchProductionDriverResult = Object.freeze({
      ...fixture.result,
      project: {
        ...fixture.result.project,
        tabFlowStageResults: [],
      },
    });
    const resolution = writeAutoPatchRunHistory(
      fixture.initialProject,
      fixture.initialCoordinator,
      mismatchedResult,
      historyRequest,
    );

    expect(resolution).toMatchObject({
      cause: 'run-history-stage-results-mismatch',
      ok: false,
      project: mismatchedResult.project,
      reason: 'project-result-mismatch',
      status: 'NOT_RECORDED',
    });
    expect(mismatchedResult.project.takes).toEqual([]);

    const resultsWithoutPriorSuccess =
      fixture.result.coordinator.stageResults.filter(
        (stageResult) => stageResult.resultId !== 'result-midi-edit',
      );
    const destructiveResult: AutoPatchProductionDriverResult = Object.freeze({
      ...fixture.result,
      coordinator: Object.freeze({
        ...fixture.result.coordinator,
        stageResults: resultsWithoutPriorSuccess,
      }),
      project: {
        ...fixture.result.project,
        tabFlowStageResults: resultsWithoutPriorSuccess,
      },
    });

    expect(
      writeAutoPatchRunHistory(
        fixture.initialProject,
        fixture.initialCoordinator,
        destructiveResult,
        historyRequest,
      ),
    ).toMatchObject({
      cause: 'run-history-prior-stage-result-missing',
      ok: false,
      reason: 'project-result-mismatch',
    });
  });

  it('rejects a changed Project history snapshot and a duplicate history identity', () => {
    const fixture = createCompletedRun();
    const changedHistoryResult: AutoPatchProductionDriverResult = Object.freeze({
      ...fixture.result,
      project: {
        ...fixture.result.project,
        takes: [],
      },
    });

    expect(
      writeAutoPatchRunHistory(
        fixture.initialProject,
        fixture.initialCoordinator,
        changedHistoryResult,
        historyRequest,
      ),
    ).toMatchObject({
      cause: 'run-history-project-history-changed',
      ok: false,
      reason: 'project-history-mismatch',
    });

    const duplicateEntry = createLegacyHistoryEntry(1, historyRequest.entryId);
    const duplicateFixture = createCompletedRun([duplicateEntry]);

    expect(
      writeAutoPatchRunHistory(
        duplicateFixture.initialProject,
        duplicateFixture.initialCoordinator,
        duplicateFixture.result,
        historyRequest,
      ),
    ).toMatchObject({
      cause: 'run-history-entry-conflict',
      ok: false,
      reason: 'history-conflict',
    });
  });

  it('rejects invalid request data and a result from another run', () => {
    const fixture = createCompletedRun();

    expect(
      writeAutoPatchRunHistory(
        fixture.initialProject,
        fixture.initialCoordinator,
        fixture.result,
        { ...historyRequest, entryId: ' history ' },
      ),
    ).toMatchObject({
      cause: 'run-history-request-invalid',
      ok: false,
      reason: 'invalid-request',
    });

    const foreignResult: AutoPatchProductionDriverResult = Object.freeze({
      ...fixture.result,
      coordinator: Object.freeze({
        ...fixture.result.coordinator,
        runId: 'run-foreign',
      }),
    });

    expect(
      writeAutoPatchRunHistory(
        fixture.initialProject,
        fixture.initialCoordinator,
        foreignResult,
        historyRequest,
      ),
    ).toMatchObject({
      cause: 'run-history-run-mismatch',
      ok: false,
      reason: 'run-mismatch',
    });
  });
});

type CompletedRunFixture = Readonly<{
  initialCoordinator: AutoPatchReadyRuntimeCoordinator;
  initialProject: ProjectState;
  result: Extract<AutoPatchProductionDriverResult, { status: 'COMPLETED' }>;
}>;

function createCompletedRun(
  takes: RunHistoryEntry[] = [],
): CompletedRunFixture {
  const fixture = createAutoPatchInstrumentStageFixture();
  const initialCoordinator = requireReady(fixture.coordinatorReady);
  const initialProject = {
    ...fixture.project,
    takes,
  };
  const stage = completeAutoPatchInstrumentStage(
    initialProject,
    fixture.coordinatorRunning,
    fixture.runner,
    {
      label: 'Auto Patch Instrument Render',
      outputClipId: autoPatchInstrumentOutputClipId,
      resultId: autoPatchInstrumentResultId,
    },
  );

  if (!stage.ok || stage.coordinator.status !== 'COMPLETED') {
    throw new Error(
      stage.ok ? 'Expected completed Coordinator.' : stage.message,
    );
  }

  return Object.freeze({
    initialCoordinator,
    initialProject,
    result: Object.freeze({
      coordinator: stage.coordinator,
      ledger: createAutoPatchDriverIdentityLedger(initialCoordinator),
      ok: true as const,
      project: stage.project,
      status: 'COMPLETED' as const,
    }),
  });
}

function createLegacyHistoryEntry(
  number: number,
  id = `history-${String(number).padStart(2, '0')}`,
): RunHistoryEntry {
  return {
    appliedPatchIds: [],
    appliedTabFlowIds: [],
    createdAt: `2026-07-30T00:${String(number % 60).padStart(2, '0')}:00.000Z`,
    executionMode: 'dry_run',
    generatedClipIds: [],
    generatedTrackIds: [],
    id,
    logs: [],
    name: `Prior Run ${number}`,
    patchSnapshots: [],
    routingSnapshots: [],
    sourceSelection: [],
    tabFlowSnapshots: [],
  };
}

function requireReady(
  coordinator: AutoPatchRuntimeCoordinator,
): AutoPatchReadyRuntimeCoordinator {
  if (coordinator.status !== 'READY') {
    throw new Error('Expected one READY Auto Patch Coordinator.');
  }

  return coordinator;
}
