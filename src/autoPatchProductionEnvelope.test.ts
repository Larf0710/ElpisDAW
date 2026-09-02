import { describe, expect, it } from 'vitest';

import { createAutoPatchDriverIdentityLedger } from './autoPatchDriverIdentity';
import { completeAutoPatchInstrumentStage } from './autoPatchInstrumentStageCompletion';
import {
  autoPatchInstrumentAttemptId,
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
import {
  prepareAutoPatchProductionProgressEnvelope,
  prepareAutoPatchProductionResultEnvelope,
  type AutoPatchProductionEnvelope,
  type AutoPatchProductionEnvelopePreparation,
} from './autoPatchProductionEnvelope';
import type { AutoPatchProductionDriverResult } from './autoPatchProductionDriver';
import {
  beginAutoPatchRuntimeStage,
  failAutoPatchRuntimeStage,
  type AutoPatchReadyRuntimeCoordinator,
  type AutoPatchRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';
import type { ProjectState } from './types';

describe('Auto Patch production Envelope', () => {
  it('represents READY and RUNNING Coordinator progress without mutating runtime state', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const initial = requireReady(fixture.coordinatorReady);
    const ready = requirePrepared(
      prepareAutoPatchProductionProgressEnvelope(initial, initial),
    );
    const running = requirePrepared(
      prepareAutoPatchProductionProgressEnvelope(
        initial,
        fixture.coordinatorRunning,
      ),
    );

    expect(ready).toMatchObject({
      activeScope: { stageId: initial.activeStage.scope.stageId },
      completedStageCount: 0,
      newlyCompletedStageCount: 0,
      phase: 'READY',
      remainingStageCount: 2,
      schemaVersion: 1,
      stageCount: 2,
      status: 'PROGRESS',
    });
    expect(ready).not.toHaveProperty('activeAttemptId');
    expect(running).toMatchObject({
      activeAttemptId: autoPatchMidiEditAttemptId,
      phase: 'RUNNING',
      status: 'PROGRESS',
    });

    if (ready.status !== 'PROGRESS') {
      throw new Error('Expected one progress Envelope.');
    }

    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(ready.activeScope)).toBe(true);
    expect(initial.status).toBe('READY');
    expect(fixture.coordinatorRunning.status).toBe('RUNNING');
  });

  it('represents a completed run only when every planned Stage is accounted for', () => {
    const fixture = createAutoPatchInstrumentStageFixture();
    const initial = requireReady(fixture.coordinatorReady);
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

    const envelope = requirePrepared(
      prepareAutoPatchProductionResultEnvelope(initial, {
        coordinator: completed.coordinator,
        ledger: createAutoPatchDriverIdentityLedger(initial),
        ok: true,
        project: completed.project,
        status: 'COMPLETED',
      }),
    );

    expect(envelope).toMatchObject({
      completedAttemptIds: [autoPatchInstrumentAttemptId],
      completedResultIds: [autoPatchInstrumentResultId],
      completedStageCount: 2,
      newlyCompletedStageCount: 1,
      remainingStageCount: 0,
      reusedStageCount: 1,
      sourceStatus: 'COMPLETED',
      stageCount: 2,
      status: 'COMPLETED',
    });
  });

  it.each([
    ['BLOCKED', 'driver-invariant', 'production-driver-blocked'],
    ['CANCELED', 'run-canceled', 'abort-signal'],
  ] as const)(
    'keeps a no-output %s run distinct from PARTIAL',
    (status, reason, cause) => {
      const fixture = createAutoPatchMidiEditStageFixture();
      const initial = requireReady(fixture.coordinatorReady);
      const result = Object.freeze({
        cause,
        coordinator: initial,
        ledger: createAutoPatchDriverIdentityLedger(initial),
        message: `Auto Patch ${status.toLowerCase()} before output.`,
        ok: false as const,
        project: fixture.project,
        reason,
        status,
      }) as AutoPatchProductionDriverResult;
      const envelope = requirePrepared(
        prepareAutoPatchProductionResultEnvelope(initial, result),
      );

      expect(envelope).toMatchObject({
        cause,
        completedResultIds: [],
        newlyCompletedStageCount: 0,
        sourceStatus: status,
        status,
      });
    },
  );

  it('represents a first-Stage failure as FAILED when no output finalized', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const initial = requireReady(fixture.coordinatorReady);
    const failed = failAutoPatchRuntimeStage(
      requireRunning(fixture.coordinatorRunning),
      {
        attemptId: autoPatchMidiEditAttemptId,
        cause: 'midi-edit-failed',
        failedAt: '2026-07-31T00:00:20.000Z',
        message: 'MIDI Edit failed before completion.',
      },
    );

    if (!failed.ok || failed.coordinator.status !== 'FAILED') {
      throw new Error(failed.ok ? 'Expected FAILED Coordinator.' : failed.message);
    }

    const envelope = requirePrepared(
      prepareAutoPatchProductionResultEnvelope(initial, {
        cause: 'midi-edit-failed',
        coordinator: failed.coordinator,
        ledger: createAutoPatchDriverIdentityLedger(initial),
        message: 'MIDI Edit failed before completion.',
        ok: false,
        project: fixture.project,
        reason: 'stage-failed',
        scope: failed.coordinator.failure.scope,
        status: 'FAILED',
      }),
    );

    expect(envelope).toMatchObject({
      completedStageCount: 0,
      failureScope: { stageId: initial.activeStage.scope.stageId },
      newlyCompletedStageCount: 0,
      sourceStatus: 'FAILED',
      status: 'FAILED',
    });
  });

  it('does not call a run PARTIAL when it only reused an existing result before failure', () => {
    const fixture = createAutoPatchInstrumentStageFixture();
    const initial = requireReady(fixture.coordinatorReady);
    const failed = failAutoPatchRuntimeStage(
      requireRunning(fixture.coordinatorRunning),
      {
        attemptId: autoPatchInstrumentAttemptId,
        cause: 'instrument-engine-job-failed',
        failedAt: '2026-07-31T00:01:20.000Z',
        message: 'Instrument render failed before producing new output.',
      },
    );

    if (!failed.ok || failed.coordinator.status !== 'FAILED') {
      throw new Error(failed.ok ? 'Expected FAILED Coordinator.' : failed.message);
    }

    const envelope = requirePrepared(
      prepareAutoPatchProductionResultEnvelope(initial, {
        cause: 'instrument-engine-job-failed',
        coordinator: failed.coordinator,
        ledger: createAutoPatchDriverIdentityLedger(initial),
        message: 'Instrument render failed before producing new output.',
        ok: false,
        project: fixture.project,
        reason: 'stage-failed',
        scope: failed.coordinator.failure.scope,
        status: 'FAILED',
      }),
    );

    expect(envelope).toMatchObject({
      completedStageCount: 1,
      newlyCompletedStageCount: 0,
      reusedStageCount: 1,
      sourceStatus: 'FAILED',
      status: 'FAILED',
    });
  });

  it('promotes a later-Stage failure with a finalized earlier result to PARTIAL', () => {
    const fixture = createLaterStageFailure();
    const envelope = requirePrepared(
      prepareAutoPatchProductionResultEnvelope(
        fixture.initialCoordinator,
        fixture.result,
      ),
    );

    expect(envelope).toMatchObject({
      cause: 'instrument-engine-job-failed',
      completedAttemptIds: [autoPatchMidiEditAttemptId],
      completedResultIds: [autoPatchMidiEditResultId],
      completedStageCount: 1,
      newlyCompletedStageCount: 1,
      remainingStageCount: 1,
      sourceStatus: 'FAILED',
      status: 'PARTIAL',
    });

    if (envelope.status !== 'PARTIAL') {
      throw new Error('Expected one partial Envelope.');
    }

    expect(Object.isFrozen(envelope.completedResultIds)).toBe(true);
    expect(Object.isFrozen(envelope.failureScope)).toBe(true);
  });

  it('promotes cancellation after one atomic completion to PARTIAL without changing its source status', () => {
    const fixture = createCompletedMidiStage();
    const result: AutoPatchProductionDriverResult = Object.freeze({
      cause: 'abort-signal',
      coordinator: fixture.coordinator,
      ledger: createAutoPatchDriverIdentityLedger(
        fixture.initialCoordinator,
      ),
      message: 'Auto Patch run was canceled between Stages.',
      ok: false,
      project: fixture.project,
      reason: 'run-canceled',
      scope: fixture.coordinator.activeStage.scope,
      status: 'CANCELED',
    });
    const envelope = requirePrepared(
      prepareAutoPatchProductionResultEnvelope(
        fixture.initialCoordinator,
        result,
      ),
    );

    expect(envelope).toMatchObject({
      completedResultIds: [autoPatchMidiEditResultId],
      sourceStatus: 'CANCELED',
      status: 'PARTIAL',
    });
  });

  it('rejects terminal and progress Envelopes that do not belong to the initial run', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const initial = requireReady(fixture.coordinatorReady);
    const foreign = Object.freeze({
      ...fixture.coordinatorRunning,
      runId: 'run-foreign',
    }) as AutoPatchRuntimeCoordinator;
    const progress = prepareAutoPatchProductionProgressEnvelope(
      initial,
      foreign,
    );
    const result = prepareAutoPatchProductionResultEnvelope(initial, {
      cause: 'abort-signal',
      coordinator: foreign,
      ledger: createAutoPatchDriverIdentityLedger(initial),
      message: 'Foreign cancellation.',
      ok: false,
      project: fixture.project,
      reason: 'run-canceled',
      status: 'CANCELED',
    });

    expect(progress).toMatchObject({
      cause: 'production-envelope-run-mismatch',
      ok: false,
      reason: 'run-mismatch',
      status: 'NOT_PREPARED',
    });
    expect(result).toMatchObject({
      cause: 'production-envelope-run-mismatch',
      ok: false,
    });
  });
});

function createCompletedMidiStage(): Readonly<{
  coordinator: AutoPatchReadyRuntimeCoordinator;
  initialCoordinator: AutoPatchReadyRuntimeCoordinator;
  project: ProjectState;
}> {
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

  return Object.freeze({
    coordinator: midiStage.coordinator,
    initialCoordinator,
    project: midiStage.project,
  });
}

function createLaterStageFailure(): Readonly<{
  initialCoordinator: AutoPatchReadyRuntimeCoordinator;
  result: Extract<AutoPatchProductionDriverResult, { status: 'FAILED' }>;
}> {
  const completed = createCompletedMidiStage();
  const beginning = beginAutoPatchRuntimeStage(completed.coordinator, {
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
    initialCoordinator: completed.initialCoordinator,
    result: Object.freeze({
      cause: 'instrument-engine-job-failed',
      coordinator: failed.coordinator,
      ledger: createAutoPatchDriverIdentityLedger(
        completed.initialCoordinator,
      ),
      message: 'Instrument render failed after MIDI Edit completed.',
      ok: false,
      project: completed.project,
      reason: 'stage-failed',
      scope: failed.coordinator.failure.scope,
      status: 'FAILED',
    }),
  });
}

function requirePrepared(
  preparation: AutoPatchProductionEnvelopePreparation,
): AutoPatchProductionEnvelope {
  if (!preparation.ok) {
    throw new Error(preparation.message);
  }

  return preparation.envelope;
}

function requireReady(
  coordinator: AutoPatchRuntimeCoordinator,
): AutoPatchReadyRuntimeCoordinator {
  if (coordinator.status !== 'READY') {
    throw new Error('Expected READY Auto Patch Coordinator.');
  }

  return coordinator;
}

function requireRunning(
  coordinator: AutoPatchRuntimeCoordinator,
): Extract<AutoPatchRuntimeCoordinator, { status: 'RUNNING' }> {
  if (coordinator.status !== 'RUNNING') {
    throw new Error('Expected RUNNING Auto Patch Coordinator.');
  }

  return coordinator;
}
