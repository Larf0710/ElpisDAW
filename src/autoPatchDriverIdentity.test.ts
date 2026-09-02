import { describe, expect, it, vi } from 'vitest';

import {
  advanceAutoPatchDriverClock,
  createAutoPatchDriverIdentityLedger,
  reserveAutoPatchDriverStageAttempt,
  type AutoPatchDriverIdentityKind,
  type AutoPatchDriverIdentityServices,
} from './autoPatchDriverIdentity';
import {
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
  stageInstrumentId,
  stageMidiEditId,
} from './autoPatchExecutionFrontier.testFixture';
import type { AutoPatchValidatedPreflight } from './autoPatchStagePreflight';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';

const runId = 'run-driver-identity';
const createdAt = '2026-08-01T00:00:00.000Z';

describe('Auto Patch driver identity allocation', () => {
  it('allocates one MIDI Edit attempt from immutable Coordinator identity', () => {
    const coordinator = createReadyCoordinator();
    const ledger = createAutoPatchDriverIdentityLedger(coordinator);
    const services = createServices([
      '2026-08-01T00:00:10.000Z',
    ]);

    expect(services.allocateId).not.toHaveBeenCalled();
    expect(services.clock).not.toHaveBeenCalled();

    const resolution = reserveAutoPatchDriverStageAttempt(
      ledger,
      coordinator,
      services,
    );

    expect(resolution).toMatchObject({
      ok: true,
      coordinator,
      attempt: {
        attemptId: 'attempt-1',
        startedAt: '2026-08-01T00:00:10.000Z',
        dispatch: {
          attemptId: 'attempt-1',
          artifactInputs: coordinator.activeStage.artifactInputs,
          fingerprint: coordinator.activeStage.fingerprint,
          node: {
            nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
            patchTabId: stageMidiEditId,
          },
          runId: coordinator.runId,
          scope: coordinator.activeStage.scope,
        },
        outputReservation: {
          artifactId: 'midi-artifact-1',
          key: JSON.stringify([
            coordinator.runId,
            coordinator.activeStage.scope.targetClipId,
            coordinator.activeStage.scope.familyId,
            coordinator.activeStage.scope.familyRevision,
            coordinator.activeStage.scope.stageId,
            coordinator.activeStage.fingerprint,
          ]),
          nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
          resultId: 'stage-result-1',
          sourceEditId: 'midi-source-edit-1',
        },
      },
      ledger: {
        attemptIds: ['attempt-1'],
        createdAt: coordinator.createdAt,
        lastTimestamp: '2026-08-01T00:00:10.000Z',
        runId: coordinator.runId,
      },
    });
    expect(services.allocateId).toHaveBeenCalledTimes(4);
    expect(services.allocateId.mock.calls.map(([kind]) => kind)).toEqual([
      'attempt',
      'midi-artifact',
      'midi-source-edit',
      'stage-result',
    ]);
    expect(resolution.coordinator).toBe(coordinator);
    expect(coordinator.attempts).toHaveLength(0);
    expect(coordinator.status).toBe('READY');
  });

  it('keeps logical outputs stable while assigning a new attempt on retry', () => {
    const coordinator = createReadyCoordinator();
    const services = createServices([
      '2026-08-01T00:00:10.000Z',
      '2026-08-01T00:00:20.000Z',
    ]);
    const first = requireAttempt(
      reserveAutoPatchDriverStageAttempt(
        createAutoPatchDriverIdentityLedger(coordinator),
        coordinator,
        services,
      ),
    );
    const retry = requireAttempt(
      reserveAutoPatchDriverStageAttempt(
        first.ledger,
        coordinator,
        services,
      ),
    );

    expect(retry.attempt.attemptId).toBe('attempt-2');
    expect(retry.attempt.startedAt).toBe(
      '2026-08-01T00:00:20.000Z',
    );
    expect(retry.attempt.outputReservation).toBe(
      first.attempt.outputReservation,
    );
    expect(retry.ledger).toMatchObject({
      attemptIds: ['attempt-1', 'attempt-2'],
      outputReservations: [first.attempt.outputReservation],
    });
    expect(services.allocateId.mock.calls.map(([kind]) => kind)).toEqual([
      'attempt',
      'midi-artifact',
      'midi-source-edit',
      'stage-result',
      'attempt',
    ]);
  });

  it('creates a new output reservation when the Stage fingerprint changes', () => {
    const firstCoordinator = createReadyCoordinator();
    const changedCoordinator = createReadyCoordinator(
      createValidatedPreflight({
        sourceContentHash: 'source-hash-changed',
        sourceRevision: 2,
      }),
    );
    const services = createServices([
      '2026-08-01T00:00:10.000Z',
      '2026-08-01T00:00:20.000Z',
    ]);
    const first = requireAttempt(
      reserveAutoPatchDriverStageAttempt(
        createAutoPatchDriverIdentityLedger(firstCoordinator),
        firstCoordinator,
        services,
      ),
    );
    const changed = requireAttempt(
      reserveAutoPatchDriverStageAttempt(
        first.ledger,
        changedCoordinator,
        services,
      ),
    );

    expect(changedCoordinator.activeStage.fingerprint).not.toBe(
      firstCoordinator.activeStage.fingerprint,
    );
    expect(changed.attempt.outputReservation).not.toEqual(
      first.attempt.outputReservation,
    );
    expect(changed.ledger.outputReservations).toHaveLength(2);
    expect(changed.attempt.outputReservation.key).not.toBe(
      first.attempt.outputReservation.key,
    );
  });

  it('allocates only driver-owned Instrument identities after MIDI reuse', () => {
    const firstCoordinator = createReadyCoordinator();
    const midiResult = createCompletedResult(
      createScope(stageMidiEditId),
      firstCoordinator.activeStage.fingerprint,
      'result-midi-reusable',
      [editedArtifactId],
      [editedClipTakeId],
    );
    const coordinator = createReadyCoordinator(
      createValidatedPreflight(),
      [
        createRuntimeTarget({
          artifactIds: [editedArtifactId],
          artifactIdentities: [
            {
              artifactId: editedArtifactId,
              mediaType: 'midi',
              midi: {
                contentHash: 'edited-hash',
                revision: 2,
              },
            },
          ],
          clipTakeIds: [editedClipTakeId],
        }),
      ],
      [midiResult],
    );
    const services = createServices([
      '2026-08-01T00:00:10.000Z',
    ]);
    const resolution = requireAttempt(
      reserveAutoPatchDriverStageAttempt(
        createAutoPatchDriverIdentityLedger(coordinator),
        coordinator,
        services,
      ),
    );

    expect(coordinator.frontier.targets[0].families[0].stages).toMatchObject([
      { action: 'reuse', scope: { stageId: stageMidiEditId } },
      { action: 'execute', scope: { stageId: stageInstrumentId } },
    ]);
    expect(resolution.attempt.outputReservation).toEqual({
      key: expect.any(String),
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
      outputClipId: 'instrument-output-clip-1',
      resultId: 'stage-result-1',
    });
    expect(services.allocateId.mock.calls.map(([kind]) => kind)).toEqual([
      'attempt',
      'instrument-output-clip',
      'stage-result',
    ]);
  });

  it('rejects a retrograde clock and duplicate retry attempt atomically', () => {
    const coordinator = createReadyCoordinator();
    const retrogradeServices = createServices([
      '2026-07-31T23:59:59.000Z',
    ]);
    const ledger = createAutoPatchDriverIdentityLedger(coordinator);
    const retrograde = reserveAutoPatchDriverStageAttempt(
      ledger,
      coordinator,
      retrogradeServices,
    );

    expect(retrograde).toMatchObject({
      ok: false,
      cause: 'driver-clock-not-monotonic',
      reason: 'clock-invalid',
    });
    expect(retrograde.ledger).toBe(ledger);
    expect(retrograde.coordinator).toBe(coordinator);
    expect(retrogradeServices.allocateId).not.toHaveBeenCalled();

    const firstServices = createServices([
      '2026-08-01T00:00:10.000Z',
    ]);
    const first = requireAttempt(
      reserveAutoPatchDriverStageAttempt(
        ledger,
        coordinator,
        firstServices,
      ),
    );
    const duplicateServices: AutoPatchDriverIdentityServices = {
      allocateId: vi.fn(() => first.attempt.attemptId),
      clock: vi.fn(() => '2026-08-01T00:00:20.000Z'),
    };
    const duplicate = reserveAutoPatchDriverStageAttempt(
      first.ledger,
      coordinator,
      duplicateServices,
    );

    expect(duplicate).toMatchObject({
      ok: false,
      cause: 'driver-identity-invalid',
      reason: 'identity-invalid',
    });
    expect(duplicate.ledger).toBe(first.ledger);
    expect(duplicate.coordinator).toBe(coordinator);
  });

  it('advances the shared clock monotonically for later Stage timestamps', () => {
    const coordinator = createReadyCoordinator();
    const services = createServices([
      '2026-08-01T00:00:10.000Z',
      '2026-08-01T00:00:20.000Z',
      '2026-08-01T00:00:19.000Z',
    ]);
    const attempt = requireAttempt(
      reserveAutoPatchDriverStageAttempt(
        createAutoPatchDriverIdentityLedger(coordinator),
        coordinator,
        services,
      ),
    );
    const advanced = advanceAutoPatchDriverClock(
      attempt.ledger,
      attempt.attempt.startedAt,
      services.clock,
    );

    expect(advanced).toMatchObject({
      ok: true,
      timestamp: '2026-08-01T00:00:20.000Z',
      ledger: { lastTimestamp: '2026-08-01T00:00:20.000Z' },
    });

    if (!advanced.ok) {
      throw new Error(advanced.message);
    }

    const rejected = advanceAutoPatchDriverClock(
      advanced.ledger,
      advanced.timestamp,
      services.clock,
    );

    expect(rejected).toMatchObject({
      ok: false,
      cause: 'driver-clock-not-monotonic',
    });
    expect(rejected.ledger).toBe(advanced.ledger);
  });
});

function createReadyCoordinator(
  validatedPreflight: AutoPatchValidatedPreflight =
    createValidatedPreflight(),
  runtimeTargets: Parameters<
    typeof createAutoPatchRuntimeCoordinator
  >[0]['runtimeTargets'] = [createRuntimeTarget()],
  stageResults: Parameters<
    typeof createAutoPatchRuntimeCoordinator
  >[0]['stageResults'] = [],
): Extract<AutoPatchRuntimeCoordinator, { status: 'READY' }> {
  const coordinator = requireCoordinator(
    createAutoPatchRuntimeCoordinator({
      createdAt,
      runId,
      runtimeTargets,
      stageResults,
      validatedPreflight,
    }),
  );

  if (coordinator.status !== 'READY') {
    throw new Error('Expected a READY driver identity fixture.');
  }

  return coordinator;
}

function createServices(
  timestamps: readonly string[],
): AutoPatchDriverIdentityServices & {
  allocateId: ReturnType<typeof vi.fn<(kind: AutoPatchDriverIdentityKind) => string>>;
  clock: ReturnType<typeof vi.fn<() => string>>;
} {
  const counts = new Map<AutoPatchDriverIdentityKind, number>();
  const allocateId = vi.fn((kind: AutoPatchDriverIdentityKind) => {
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    return `${kind}-${count}`;
  });
  const remainingTimestamps = [...timestamps];
  const clock = vi.fn(() => {
    const timestamp = remainingTimestamps.shift();

    if (!timestamp) {
      throw new Error('Driver test clock exhausted.');
    }

    return timestamp;
  });

  return { allocateId, clock };
}

function requireAttempt(
  resolution: ReturnType<typeof reserveAutoPatchDriverStageAttempt>,
) {
  if (!resolution.ok) {
    throw new Error(resolution.message);
  }

  return resolution;
}

function requireCoordinator(
  resolution: AutoPatchRuntimeCoordinatorResolution,
): AutoPatchRuntimeCoordinator {
  if (!resolution.ok) {
    throw new Error(resolution.message);
  }

  return resolution.coordinator;
}
