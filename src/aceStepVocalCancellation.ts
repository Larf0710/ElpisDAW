import type {
  LocalEngineGpuJobProgress,
  LocalEngineGpuJobState,
} from './localEngineClient';

export type AceStepVocalUiStatus =
  | 'IDLE'
  | 'SAVING_LYRICS'
  | 'ENQUEUEING'
  | 'PENDING'
  | 'REGISTERED'
  | 'ERROR'
  | LocalEngineGpuJobState;

export type AceStepVocalUiState = Readonly<{
  jobProgress?: LocalEngineGpuJobProgress;
  jobId?: string;
  message?: string;
  patchTabId?: string;
  status: AceStepVocalUiStatus;
}>;

export type AceStepVocalActionResolution = Readonly<{
  action: 'CANCEL' | 'GENERATE' | 'WAIT';
  ariaBusy: boolean;
  disabled: boolean;
}>;

const activeStatuses = new Set<AceStepVocalUiStatus>([
  'SAVING_LYRICS',
  'ENQUEUEING',
  'QUEUED',
  'LOADING_MODEL',
  'PROCESSING',
  'SAVING',
  'COMPLETED',
  'CANCEL_REQUESTED',
]);

const cancellableStatuses = new Set<AceStepVocalUiStatus>([
  'QUEUED',
  'LOADING_MODEL',
  'PROCESSING',
]);

export function isAceStepVocalUiActive(state: AceStepVocalUiState): boolean {
  return activeStatuses.has(state.status);
}

export function resolveAceStepVocalAction(input: Readonly<{
  canGenerate: boolean;
  patchTabId: string;
  state: AceStepVocalUiState;
}>): AceStepVocalActionResolution {
  const isAnyRunActive = isAceStepVocalUiActive(input.state);

  if (!isAnyRunActive) {
    return Object.freeze({
      action: 'GENERATE' as const,
      ariaBusy: false,
      disabled: !input.canGenerate,
    });
  }

  const ownsOperation = input.state.patchTabId === input.patchTabId;
  const canCancel =
    ownsOperation &&
    typeof input.state.jobId === 'string' &&
    cancellableStatuses.has(input.state.status);

  return Object.freeze({
    action: canCancel ? ('CANCEL' as const) : ('WAIT' as const),
    ariaBusy: ownsOperation,
    disabled: !canCancel,
  });
}

export function canRequestAceStepVocalCancellation(
  state: AceStepVocalUiState,
  patchTabId: string,
): boolean {
  return (
    state.patchTabId === patchTabId &&
    typeof state.jobId === 'string' &&
    cancellableStatuses.has(state.status)
  );
}
