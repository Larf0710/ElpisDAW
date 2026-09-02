import type {
  AutoPatchProductionEnvelope,
  AutoPatchProductionProgressEnvelope,
  AutoPatchProductionTerminalEnvelope,
} from './autoPatchProductionEnvelope';
import type { LocalEngineGpuJobProgress } from './localEngineJobs';

export type AutoPatchProductionUiStatus =
  | 'IDLE'
  | 'PREPARING'
  | 'RUNNING'
  | 'CANCEL_REQUESTED'
  | AutoPatchProductionTerminalEnvelope['status'];

export type AutoPatchProductionUiState = Readonly<{
  completedStageCount: number;
  message: string;
  stageCount: number;
  status: AutoPatchProductionUiStatus;
  activeStageId?: string;
  jobProgress?: LocalEngineGpuJobProgress;
  runId?: string;
}>;

export type AutoPatchProductionUiPresentation = Readonly<{
  active: boolean;
  buttonLabel: string;
  canCancel: boolean;
  canDismiss: boolean;
  meterLabel: string;
  statusLabel: string;
  tone:
    | 'idle'
    | 'preparing'
    | 'running'
    | 'success'
    | 'warning'
    | 'error';
}>;

export function createIdleAutoPatchProductionUiState(): AutoPatchProductionUiState {
  return freezeState({
    completedStageCount: 0,
    message: 'Production Auto Patch is idle.',
    stageCount: 0,
    status: 'IDLE',
  });
}

export function createPreparingAutoPatchProductionUiState(
  message = 'Checking production targets, sources, Stages, and runtime resources.',
): AutoPatchProductionUiState {
  return freezeState({
    completedStageCount: 0,
    message,
    stageCount: 0,
    status: 'PREPARING',
  });
}

export function createAutoPatchProductionUiStateFromEnvelope(
  envelope: AutoPatchProductionEnvelope,
): AutoPatchProductionUiState {
  if (envelope.status === 'PROGRESS') {
    return createProgressState(envelope);
  }

  return createTerminalState(envelope);
}

export function createBlockedAutoPatchProductionUiState(
  message: string,
): AutoPatchProductionUiState {
  return freezeState({
    completedStageCount: 0,
    message,
    stageCount: 0,
    status: 'BLOCKED',
  });
}

export function createFailedAutoPatchProductionUiState(
  message: string,
  progress: Readonly<{
    completedStageCount?: number;
    stageCount?: number;
  }> = {},
): AutoPatchProductionUiState {
  return freezeState({
    completedStageCount: progress.completedStageCount ?? 0,
    message,
    stageCount: progress.stageCount ?? 0,
    status: 'FAILED',
  });
}

export function requestAutoPatchProductionCancellation(
  state: AutoPatchProductionUiState,
): AutoPatchProductionUiState {
  if (state.status !== 'RUNNING') {
    return state;
  }

  return freezeState({
    ...state,
    message: 'Cancel requested. Completed Stage outputs will be preserved.',
    status: 'CANCEL_REQUESTED',
  });
}

export function isAutoPatchProductionUiActive(
  state: AutoPatchProductionUiState,
): boolean {
  return (
    state.status === 'PREPARING' ||
    state.status === 'RUNNING' ||
    state.status === 'CANCEL_REQUESTED'
  );
}

export function getAutoPatchProductionUiPresentation(
  state: AutoPatchProductionUiState,
): AutoPatchProductionUiPresentation {
  const progress = `${state.completedStageCount}/${state.stageCount}`;

  switch (state.status) {
    case 'IDLE':
      return presentation(false, 'AUTO PATCH', false, false, 'PRODUCTION', 'PATCH IDLE', 'idle');
    case 'PREPARING':
      return presentation(true, 'CHECKING', false, false, 'PREFLIGHT', 'PATCH CHECK', 'preparing');
    case 'RUNNING':
      return presentation(true, 'AUTO PATCH', true, false, `${progress} RUN`, `PATCH ${progress}`, 'running');
    case 'CANCEL_REQUESTED':
      return presentation(true, 'CANCELING', false, false, `${progress} KEEP`, 'PATCH CANCEL', 'warning');
    case 'COMPLETED':
      return presentation(false, 'AUTO PATCH', false, true, `${progress} DONE`, 'PATCH DONE', 'success');
    case 'PARTIAL':
      return presentation(false, 'AUTO PATCH', false, true, `${progress} PART`, 'PATCH PARTIAL', 'warning');
    case 'BLOCKED':
      return presentation(false, 'AUTO PATCH', false, true, 'BLOCKED', 'PATCH BLOCKED', 'warning');
    case 'CANCELED':
      return presentation(false, 'AUTO PATCH', false, true, `${progress} KEPT`, 'PATCH CANCELED', 'warning');
    case 'FAILED':
      return presentation(false, 'AUTO PATCH', false, true, `${progress} FAIL`, 'PATCH FAILED', 'error');
  }
}

function createProgressState(
  envelope: AutoPatchProductionProgressEnvelope,
): AutoPatchProductionUiState {
  return freezeState({
    activeStageId: envelope.activeScope.stageId,
    completedStageCount: envelope.completedStageCount,
    message: `Running Stage ${envelope.activeScope.stageId}. Completed ${envelope.completedStageCount} of ${envelope.stageCount}.`,
    runId: envelope.runId,
    stageCount: envelope.stageCount,
    status: 'RUNNING',
  });
}

function createTerminalState(
  envelope: AutoPatchProductionTerminalEnvelope,
): AutoPatchProductionUiState {
  return freezeState({
    completedStageCount: envelope.completedStageCount,
    message:
      envelope.status === 'COMPLETED'
        ? 'Auto Patch production run completed. Save Project to persist the new results.'
        : envelope.message,
    runId: envelope.runId,
    stageCount: envelope.stageCount,
    status: envelope.status,
  });
}

function presentation(
  active: boolean,
  buttonLabel: string,
  canCancel: boolean,
  canDismiss: boolean,
  meterLabel: string,
  statusLabel: string,
  tone: AutoPatchProductionUiPresentation['tone'],
): AutoPatchProductionUiPresentation {
  return Object.freeze({
    active,
    buttonLabel,
    canCancel,
    canDismiss,
    meterLabel,
    statusLabel,
    tone,
  });
}

function freezeState(
  state: AutoPatchProductionUiState,
): AutoPatchProductionUiState {
  return Object.freeze({ ...state });
}
