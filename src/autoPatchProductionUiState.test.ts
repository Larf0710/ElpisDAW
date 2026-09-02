import { describe, expect, it } from 'vitest';

import type {
  AutoPatchProductionProgressEnvelope,
  AutoPatchProductionTerminalEnvelope,
} from './autoPatchProductionEnvelope';
import {
  createAutoPatchProductionUiStateFromEnvelope,
  createBlockedAutoPatchProductionUiState,
  createPreparingAutoPatchProductionUiState,
  getAutoPatchProductionUiPresentation,
  isAutoPatchProductionUiActive,
  requestAutoPatchProductionCancellation,
} from './autoPatchProductionUiState';

describe('Auto Patch production UI state', () => {
  it('maps exact progress metrics and active Stage identity', () => {
    const state = createAutoPatchProductionUiStateFromEnvelope(
      createProgressEnvelope(),
    );

    expect(state).toEqual({
      activeStageId: 'midi-edit',
      completedStageCount: 1,
      message: 'Running Stage midi-edit. Completed 1 of 2.',
      runId: 'run-ui',
      stageCount: 2,
      status: 'RUNNING',
    });
    expect(getAutoPatchProductionUiPresentation(state)).toMatchObject({
      active: true,
      canCancel: true,
      meterLabel: '1/2 RUN',
      statusLabel: 'PATCH 1/2',
      tone: 'running',
    });
  });

  it.each([
    ['COMPLETED', 'PATCH DONE', 'success'],
    ['PARTIAL', 'PATCH PARTIAL', 'warning'],
    ['BLOCKED', 'PATCH BLOCKED', 'warning'],
    ['CANCELED', 'PATCH CANCELED', 'warning'],
    ['FAILED', 'PATCH FAILED', 'error'],
  ] as const)('maps %s terminal state without leaving the editor locked', (status, statusLabel, tone) => {
    const state = createAutoPatchProductionUiStateFromEnvelope(
      createTerminalEnvelope(status),
    );
    const presentation = getAutoPatchProductionUiPresentation(state);

    expect(state.status).toBe(status);
    expect(isAutoPatchProductionUiActive(state)).toBe(false);
    expect(presentation).toMatchObject({
      active: false,
      canDismiss: true,
      statusLabel,
      tone,
    });
  });

  it('keeps preparation and cancel request active while preserving completed progress', () => {
    const preparing = createPreparingAutoPatchProductionUiState();
    const running = createAutoPatchProductionUiStateFromEnvelope(
      createProgressEnvelope(),
    );
    const canceling = requestAutoPatchProductionCancellation(running);

    expect(isAutoPatchProductionUiActive(preparing)).toBe(true);
    expect(getAutoPatchProductionUiPresentation(preparing).canCancel).toBe(false);
    expect(requestAutoPatchProductionCancellation(preparing)).toBe(preparing);
    expect(canceling).toMatchObject({
      completedStageCount: 1,
      stageCount: 2,
      status: 'CANCEL_REQUESTED',
    });
    expect(getAutoPatchProductionUiPresentation(canceling)).toMatchObject({
      canCancel: false,
      meterLabel: '1/2 KEEP',
      tone: 'warning',
    });
  });

  it('represents a pre-run block without pretending a production Stage ran', () => {
    const state = createBlockedAutoPatchProductionUiState(
      'One enabled Flow Family is required.',
    );

    expect(state).toMatchObject({
      completedStageCount: 0,
      stageCount: 0,
      status: 'BLOCKED',
    });
    expect(isAutoPatchProductionUiActive(state)).toBe(false);
  });
});

function createProgressEnvelope(): AutoPatchProductionProgressEnvelope {
  return {
    activeScope: {
      familyId: 'family-main',
      familyRevision: 1,
      stageId: 'midi-edit',
      targetClipId: 'clip-midi',
    },
    completedAttemptIds: ['attempt-1'],
    completedResultIds: ['result-1'],
    completedStageCount: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    newlyCompletedStageCount: 1,
    phase: 'READY',
    planId: 'plan-ui',
    remainingStageCount: 1,
    reusedResultIds: [],
    reusedStageCount: 0,
    runId: 'run-ui',
    schemaVersion: 1,
    stageCount: 2,
    status: 'PROGRESS',
    updatedAt: '2026-08-01T00:00:10.000Z',
  };
}

function createTerminalEnvelope(
  status: AutoPatchProductionTerminalEnvelope['status'],
): AutoPatchProductionTerminalEnvelope {
  const base = {
    completedAttemptIds: ['attempt-1'],
    completedResultIds: ['result-1'],
    completedStageCount: status === 'COMPLETED' ? 2 : 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    newlyCompletedStageCount: status === 'COMPLETED' ? 2 : 1,
    planId: 'plan-ui',
    remainingStageCount: status === 'COMPLETED' ? 0 : 1,
    reusedResultIds: [],
    reusedStageCount: 0,
    runId: 'run-ui',
    schemaVersion: 1 as const,
    stageCount: 2,
    updatedAt: '2026-08-01T00:00:20.000Z',
  };

  if (status === 'COMPLETED') {
    return { ...base, sourceStatus: 'COMPLETED', status };
  }

  const sourceStatus = status === 'PARTIAL' ? 'FAILED' : status;
  return {
    ...base,
    cause: 'test-cause',
    message: 'Test terminal message.',
    reason: sourceStatus === 'CANCELED' ? 'run-canceled' : 'stage-failed',
    sourceStatus,
    status,
  } as AutoPatchProductionTerminalEnvelope;
}
