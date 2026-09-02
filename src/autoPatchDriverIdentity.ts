import { createAutoPatchRuntimeStageDispatch } from './autoPatchRuntimeDispatch';
import type {
  AutoPatchReadyRuntimeCoordinator,
  AutoPatchRuntimeStageDispatch,
} from './autoPatchRuntimeCoordinator';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import type { TabFlowStageResultScope } from './types';

export type AutoPatchDriverIdentityKind =
  | 'attempt'
  | 'instrument-output-clip'
  | 'midi-artifact'
  | 'midi-source-edit'
  | 'stage-result';

export type AutoPatchDriverIdentityServices = Readonly<{
  allocateId: (kind: AutoPatchDriverIdentityKind) => string;
  clock: () => string;
}>;

export type AutoPatchDriverOutputReservation =
  | Readonly<{
      artifactId: string;
      key: string;
      nodeTypeId: typeof BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit;
      resultId: string;
      sourceEditId: string;
    }>
  | Readonly<{
      key: string;
      nodeTypeId: typeof BUILTIN_PATCH_TAB_TYPE_IDS.instrument;
      outputClipId: string;
      resultId: string;
    }>
  | Readonly<{
      key: string;
      nodeTypeId: typeof BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3;
      resultId: string;
    }>;

export type AutoPatchDriverIdentityLedger = Readonly<{
  attemptIds: readonly string[];
  createdAt: string;
  lastTimestamp: string;
  outputReservations: readonly AutoPatchDriverOutputReservation[];
  runId: string;
}>;

export type AutoPatchDriverStageAttempt = Readonly<{
  attemptId: string;
  dispatch: AutoPatchRuntimeStageDispatch;
  outputReservation: AutoPatchDriverOutputReservation;
  startedAt: string;
}>;

export type AutoPatchDriverStageAttemptResolution =
  | Readonly<{
      attempt: AutoPatchDriverStageAttempt;
      coordinator: AutoPatchReadyRuntimeCoordinator;
      ledger: AutoPatchDriverIdentityLedger;
      ok: true;
    }>
  | Readonly<{
      cause: string;
      coordinator: AutoPatchReadyRuntimeCoordinator;
      ledger: AutoPatchDriverIdentityLedger;
      message: string;
      ok: false;
      reason:
        | 'clock-invalid'
        | 'coordinator-mismatch'
        | 'dispatch-rejected'
        | 'identity-invalid'
        | 'stage-unsupported';
    }>;

export type AutoPatchDriverClockResolution =
  | Readonly<{
      ledger: AutoPatchDriverIdentityLedger;
      ok: true;
      timestamp: string;
    }>
  | Readonly<{
      cause: string;
      ledger: AutoPatchDriverIdentityLedger;
      message: string;
      ok: false;
      reason: 'clock-invalid';
    }>;

export function createAutoPatchDriverIdentityLedger(
  coordinator: AutoPatchReadyRuntimeCoordinator,
): AutoPatchDriverIdentityLedger {
  return freezeLedger({
    attemptIds: [],
    createdAt: coordinator.createdAt,
    lastTimestamp: coordinator.createdAt,
    outputReservations: [],
    runId: coordinator.runId,
  });
}

export function reserveAutoPatchDriverStageAttempt(
  ledger: AutoPatchDriverIdentityLedger,
  coordinator: AutoPatchReadyRuntimeCoordinator,
  services: AutoPatchDriverIdentityServices,
): AutoPatchDriverStageAttemptResolution {
  if (
    ledger.runId !== coordinator.runId ||
    ledger.createdAt !== coordinator.createdAt
  ) {
    return attemptFailure(
      ledger,
      coordinator,
      'coordinator-mismatch',
      'driver-ledger-coordinator-mismatch',
      'Auto Patch driver identity state does not belong to the supplied Coordinator run.',
    );
  }

  const scope = coordinator.activeStage.scope;
  const family =
    coordinator.validatedPreflight.plan.graphSnapshot.families.find(
      (candidate) =>
        candidate.familyId === scope.familyId &&
        candidate.familyRevision === scope.familyRevision,
    );
  const patchTab = family?.patchTabs.find(
    (candidate) => candidate.id === scope.stageId,
  );

  if (
    !patchTab ||
    (patchTab.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit &&
      patchTab.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.instrument &&
      patchTab.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3)
  ) {
    return attemptFailure(
      ledger,
      coordinator,
      'stage-unsupported',
      'driver-stage-identity-unsupported',
      `Stage ${scope.stageId} does not have a supported driver identity contract.`,
    );
  }

  const key = createOutputReservationKey(
    coordinator.runId,
    scope,
    coordinator.activeStage.fingerprint,
  );
  const existingReservation = ledger.outputReservations.find(
    (reservation) => reservation.key === key,
  );

  if (
    existingReservation &&
    existingReservation.nodeTypeId !== patchTab.nodeTypeId
  ) {
    return attemptFailure(
      ledger,
      coordinator,
      'identity-invalid',
      'driver-output-reservation-conflict',
      `Stage ${scope.stageId} has a conflicting logical output reservation.`,
    );
  }

  const timestampResolution = readClock(
    ledger,
    coordinator.updatedAt,
    services.clock,
  );

  if (!timestampResolution.ok) {
    return attemptFailure(
      ledger,
      coordinator,
      timestampResolution.reason,
      timestampResolution.cause,
      timestampResolution.message,
    );
  }

  const allocatedIds = new Set(collectAllocatedIds(ledger));
  const attemptIdResolution = allocateUniqueId(
    services.allocateId,
    'attempt',
    allocatedIds,
  );

  if (!attemptIdResolution.ok) {
    return attemptFailure(
      ledger,
      coordinator,
      'identity-invalid',
      attemptIdResolution.cause,
      attemptIdResolution.message,
    );
  }

  let outputReservation = existingReservation;

  if (!outputReservation) {
    const reservationResolution = allocateOutputReservation(
      services.allocateId,
      allocatedIds,
      key,
      patchTab.nodeTypeId,
    );

    if (!reservationResolution.ok) {
      return attemptFailure(
        ledger,
        coordinator,
        'identity-invalid',
        reservationResolution.cause,
        reservationResolution.message,
      );
    }

    outputReservation = reservationResolution.reservation;
  }

  const dispatchResolution = createAutoPatchRuntimeStageDispatch(
    coordinator,
    {
      attemptId: attemptIdResolution.id,
      startedAt: timestampResolution.timestamp,
    },
  );

  if (!dispatchResolution.ok) {
    return attemptFailure(
      ledger,
      coordinator,
      'dispatch-rejected',
      dispatchResolution.cause,
      dispatchResolution.message,
    );
  }

  const nextLedger = freezeLedger({
    attemptIds: [...ledger.attemptIds, attemptIdResolution.id],
    createdAt: ledger.createdAt,
    lastTimestamp: timestampResolution.timestamp,
    outputReservations: existingReservation
      ? ledger.outputReservations
      : [...ledger.outputReservations, outputReservation],
    runId: ledger.runId,
  });
  const attempt = Object.freeze({
    attemptId: attemptIdResolution.id,
    dispatch: dispatchResolution.dispatch,
    outputReservation,
    startedAt: timestampResolution.timestamp,
  });

  return Object.freeze({
    attempt,
    coordinator,
    ledger: nextLedger,
    ok: true as const,
  });
}

export function advanceAutoPatchDriverClock(
  ledger: AutoPatchDriverIdentityLedger,
  minimumTimestamp: string,
  clock: AutoPatchDriverIdentityServices['clock'],
): AutoPatchDriverClockResolution {
  const resolution = readClock(ledger, minimumTimestamp, clock);

  if (!resolution.ok) {
    return Object.freeze({
      ...resolution,
      ledger,
    });
  }

  return Object.freeze({
    ledger: freezeLedger({
      ...ledger,
      lastTimestamp: resolution.timestamp,
    }),
    ok: true as const,
    timestamp: resolution.timestamp,
  });
}

function allocateOutputReservation(
  allocateId: AutoPatchDriverIdentityServices['allocateId'],
  allocatedIds: Set<string>,
  key: string,
  nodeTypeId:
    | typeof BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit
    | typeof BUILTIN_PATCH_TAB_TYPE_IDS.instrument
    | typeof BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
):
  | Readonly<{
      ok: true;
      reservation: AutoPatchDriverOutputReservation;
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
    }> {
  if (nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit) {
    const artifactId = allocateUniqueId(
      allocateId,
      'midi-artifact',
      allocatedIds,
    );

    if (!artifactId.ok) {
      return artifactId;
    }

    const sourceEditId = allocateUniqueId(
      allocateId,
      'midi-source-edit',
      allocatedIds,
    );

    if (!sourceEditId.ok) {
      return sourceEditId;
    }

    const resultId = allocateUniqueId(
      allocateId,
      'stage-result',
      allocatedIds,
    );

    if (!resultId.ok) {
      return resultId;
    }

    return Object.freeze({
      ok: true as const,
      reservation: Object.freeze({
        artifactId: artifactId.id,
        key,
        nodeTypeId,
        resultId: resultId.id,
        sourceEditId: sourceEditId.id,
      }),
    });
  }

  if (nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3) {
    const resultId = allocateUniqueId(
      allocateId,
      'stage-result',
      allocatedIds,
    );

    if (!resultId.ok) {
      return resultId;
    }

    return Object.freeze({
      ok: true as const,
      reservation: Object.freeze({
        key,
        nodeTypeId,
        resultId: resultId.id,
      }),
    });
  }

  const outputClipId = allocateUniqueId(
    allocateId,
    'instrument-output-clip',
    allocatedIds,
  );
  const resultId = allocateUniqueId(
    allocateId,
    'stage-result',
    allocatedIds,
  );

  if (!outputClipId.ok) {
    return outputClipId;
  }

  if (!resultId.ok) {
    return resultId;
  }

  return Object.freeze({
    ok: true as const,
    reservation: Object.freeze({
      key,
      nodeTypeId,
      outputClipId: outputClipId.id,
      resultId: resultId.id,
    }),
  });
}

function allocateUniqueId(
  allocateId: AutoPatchDriverIdentityServices['allocateId'],
  kind: AutoPatchDriverIdentityKind,
  allocatedIds: Set<string>,
):
  | Readonly<{ id: string; ok: true }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
    }> {
  let id: string;

  try {
    id = allocateId(kind);
  } catch (error) {
    return idFailure(
      'driver-identity-allocation-failed',
      error instanceof Error
        ? `Auto Patch ${kind} identity allocation failed: ${error.message}`
        : `Auto Patch ${kind} identity allocation failed.`,
    );
  }

  if (!isNonEmptyTrimmedString(id) || allocatedIds.has(id)) {
    return idFailure(
      'driver-identity-invalid',
      `Auto Patch ${kind} identity is empty, malformed, or duplicated.`,
    );
  }

  allocatedIds.add(id);

  return Object.freeze({ id, ok: true as const });
}

function readClock(
  ledger: AutoPatchDriverIdentityLedger,
  minimumTimestamp: string,
  clock: AutoPatchDriverIdentityServices['clock'],
):
  | Readonly<{ ok: true; timestamp: string }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      reason: 'clock-invalid';
    }> {
  if (
    !isUtcTimestamp(ledger.lastTimestamp) ||
    !isUtcTimestamp(minimumTimestamp)
  ) {
    return clockFailure(
      'driver-clock-minimum-invalid',
      'Auto Patch driver clock minimum is not a valid UTC timestamp.',
    );
  }

  let timestamp: string;

  try {
    timestamp = clock();
  } catch (error) {
    return clockFailure(
      'driver-clock-failed',
      error instanceof Error
        ? `Auto Patch driver clock failed: ${error.message}`
        : 'Auto Patch driver clock failed.',
    );
  }

  if (
    !isUtcTimestamp(timestamp) ||
    Date.parse(timestamp) < Date.parse(ledger.lastTimestamp) ||
    Date.parse(timestamp) < Date.parse(minimumTimestamp)
  ) {
    return clockFailure(
      'driver-clock-not-monotonic',
      'Auto Patch driver clock must return a monotonic UTC timestamp at or after the required minimum.',
    );
  }

  return Object.freeze({ ok: true as const, timestamp });
}

function collectAllocatedIds(
  ledger: AutoPatchDriverIdentityLedger,
): string[] {
  return [
    ...ledger.attemptIds,
    ...ledger.outputReservations.flatMap((reservation) =>
      reservation.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit
        ? [
            reservation.artifactId,
            reservation.resultId,
            reservation.sourceEditId,
          ]
        : reservation.nodeTypeId ===
            BUILTIN_PATCH_TAB_TYPE_IDS.instrument
          ? [reservation.outputClipId, reservation.resultId]
          : [reservation.resultId],
    ),
  ];
}

function createOutputReservationKey(
  runId: string,
  scope: TabFlowStageResultScope,
  fingerprint: string,
): string {
  return JSON.stringify([
    runId,
    scope.targetClipId,
    scope.familyId,
    scope.familyRevision,
    scope.stageId,
    fingerprint,
  ]);
}

function freezeLedger(
  ledger: AutoPatchDriverIdentityLedger,
): AutoPatchDriverIdentityLedger {
  return Object.freeze({
    attemptIds: Object.freeze([...ledger.attemptIds]),
    createdAt: ledger.createdAt,
    lastTimestamp: ledger.lastTimestamp,
    outputReservations: Object.freeze([...ledger.outputReservations]),
    runId: ledger.runId,
  });
}

function attemptFailure(
  ledger: AutoPatchDriverIdentityLedger,
  coordinator: AutoPatchReadyRuntimeCoordinator,
  reason: Extract<
    AutoPatchDriverStageAttemptResolution,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<AutoPatchDriverStageAttemptResolution, { ok: false }> {
  return Object.freeze({
    cause,
    coordinator,
    ledger,
    message,
    ok: false,
    reason,
  });
}

function idFailure(
  cause: string,
  message: string,
): Readonly<{
  cause: string;
  message: string;
  ok: false;
}> {
  return Object.freeze({ cause, message, ok: false });
}

function clockFailure(
  cause: string,
  message: string,
): Extract<
  ReturnType<typeof readClock>,
  { ok: false }
> {
  return Object.freeze({
    cause,
    message,
    ok: false,
    reason: 'clock-invalid' as const,
  });
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value
  );
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.endsWith('Z') &&
    Number.isFinite(Date.parse(value))
  );
}
