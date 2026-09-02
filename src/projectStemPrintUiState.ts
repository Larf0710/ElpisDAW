export type ProjectStemPrintUiState = Readonly<{
  message?: string;
  operationId?: string;
  status:
    | 'IDLE'
    | 'PREPARING'
    | 'RUNNING'
    | 'RECOVERING'
    | 'CANCEL_REQUESTED'
    | 'OUTCOME_UNKNOWN'
    | 'REGISTERED'
    | 'CANCELED'
    | 'ERROR';
  summary?: Readonly<{
    durationSeconds: number;
    outputClipName: string;
    sourceCount: number;
    targetCount: number;
    trackCount: number;
  }>;
}>;

export type MixerProjectStemPrintControlModel = Readonly<{
  canCancel: boolean;
  canRecover: boolean;
  canRun: boolean;
  label: string;
  message: string;
  operationId?: string;
  showCancel: boolean;
  showRecover: boolean;
  tone: 'active' | 'error' | 'ready' | 'success' | 'warning';
}>;

export function isProjectStemPrintOperationActive(
  state: ProjectStemPrintUiState,
): boolean {
  return ['PREPARING', 'RUNNING', 'RECOVERING', 'CANCEL_REQUESTED'].includes(
    state.status,
  );
}

export function createMixerProjectStemPrintControlModel(input: Readonly<{
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  hasRawMixdownLock: boolean;
  hasSelection: boolean;
  isProjectRootReady: boolean;
  state: ProjectStemPrintUiState;
}>): MixerProjectStemPrintControlModel {
  const active = isProjectStemPrintOperationActive(input.state);
  const unknown = input.state.status === 'OUTCOME_UNKNOWN';
  const canUseEngine = input.engineAcceptsNewJobs && input.isProjectRootReady;

  if (active) {
    return presentation(input.state, {
      canCancel: input.state.status !== 'CANCEL_REQUESTED',
      canRecover: false,
      canRun: false,
      label: input.state.status === 'PREPARING' ? 'PREPARING' : 'RUNNING',
      showCancel: true,
      showRecover: false,
      tone: 'active',
    });
  }

  if (unknown) {
    return presentation(input.state, {
      canCancel: false,
      canRecover: canUseEngine && !input.hasRawMixdownLock,
      canRun: false,
      label: 'OUTCOME UNKNOWN',
      showCancel: false,
      showRecover: true,
      tone: 'warning',
    });
  }

  if (input.hasRawMixdownLock) {
    return readyPresentation(false, 'BUSY', 'Raw Mixdown owns the Project render operation lock.', 'active');
  }

  if (!input.engineAcceptsNewJobs) {
    return readyPresentation(false, 'ERROR', input.engineAvailabilityMessage, 'error');
  }

  if (!input.isProjectRootReady) {
    return readyPresentation(false, 'ERROR', 'Select one ready Project Root before printing Stems.', 'error');
  }

  if (!input.hasSelection) {
    return readyPresentation(false, 'SELECT TARGETS', 'Select one or more Mixer Channels or Groups.', 'warning');
  }

  if (input.state.status === 'REGISTERED') {
    return presentation(input.state, {
      canCancel: false,
      canRecover: false,
      canRun: true,
      label: 'READY',
      showCancel: false,
      showRecover: false,
      tone: 'success',
    });
  }

  if (input.state.status === 'ERROR') {
    return presentation(input.state, {
      canCancel: false,
      canRecover: false,
      canRun: true,
      label: 'ERROR',
      showCancel: false,
      showRecover: false,
      tone: 'error',
    });
  }

  if (input.state.status === 'CANCELED') {
    return presentation(input.state, {
      canCancel: false,
      canRecover: false,
      canRun: true,
      label: 'CANCELED',
      showCancel: false,
      showRecover: false,
      tone: 'warning',
    });
  }

  return readyPresentation(
    true,
    'READY',
    'Print the selected Mixer Channels or Groups to one new muted Stem Track.',
    'ready',
  );
}

function presentation(
  state: ProjectStemPrintUiState,
  model: Omit<MixerProjectStemPrintControlModel, 'message' | 'operationId'>,
): MixerProjectStemPrintControlModel {
  return Object.freeze({
    ...model,
    message: state.message ?? 'Project Stem Print state updated.',
    ...(state.operationId ? { operationId: state.operationId } : {}),
  });
}

function readyPresentation(
  canRun: boolean,
  label: string,
  message: string,
  tone: MixerProjectStemPrintControlModel['tone'],
): MixerProjectStemPrintControlModel {
  return Object.freeze({
    canCancel: false,
    canRecover: false,
    canRun,
    label,
    message,
    showCancel: false,
    showRecover: false,
    tone,
  });
}
