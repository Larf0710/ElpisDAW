import { resolveClipFilerProductionSettings } from './projectMixdownPreparation';
import type { ProjectState } from './types';

export type ProjectMixdownOwner =
  | Readonly<{ kind: 'mixer' }>
  | Readonly<{ kind: 'clip-filer'; patchTabId: string }>;

export type ProjectMixdownUiState = Readonly<{
  message?: string;
  operationId?: string;
  owner?: ProjectMixdownOwner;
  status:
    | 'IDLE'
    | 'PREPARING'
    | 'RUNNING'
    | 'RECOVERING'
    | 'CANCEL_REQUESTED'
    | 'MIXDOWN_OUTCOME_UNKNOWN'
    | 'REGISTERED'
    | 'DOWNLOADING'
    | 'DOWNLOADED'
    | 'CANCELED'
    | 'ERROR';
  summary?: Readonly<{
    durationSeconds: number;
    outputClipName: string;
    sourceCount: number;
    trackCount: number;
  }>;
}>;

export type MixerProjectMixdownControlModel = Readonly<{
  canCancel: boolean;
  canRecover: boolean;
  canRun: boolean;
  label: string;
  message: string;
  operationId?: string;
  showCancel: boolean;
  showRecover: boolean;
  summary?: ProjectMixdownUiState['summary'];
  tone: 'active' | 'error' | 'ready' | 'success' | 'warning';
}>;

export const MIXER_PROJECT_MIXDOWN_OWNER: ProjectMixdownOwner = Object.freeze({
  kind: 'mixer',
});

export function createClipFilerProjectMixdownOwner(
  patchTabId: string,
): ProjectMixdownOwner {
  return Object.freeze({ kind: 'clip-filer', patchTabId });
}

export function isProjectMixdownOwner(
  owner: ProjectMixdownOwner | undefined,
  expectedOwner: ProjectMixdownOwner,
): boolean {
  if (!owner || owner.kind !== expectedOwner.kind) {
    return false;
  }

  return owner.kind === 'mixer' ||
    (expectedOwner.kind === 'clip-filer' &&
      owner.patchTabId === expectedOwner.patchTabId);
}

export function isProjectMixdownOperationActive(
  state: ProjectMixdownUiState,
): boolean {
  return state.status === 'PREPARING' ||
    state.status === 'RUNNING' ||
    state.status === 'RECOVERING' ||
    state.status === 'CANCEL_REQUESTED';
}

export function isProjectMixdownRuntimeActive(
  state: ProjectMixdownUiState,
): boolean {
  return isProjectMixdownOperationActive(state) || state.status === 'DOWNLOADING';
}

export function canStartProjectMixdown(
  state: ProjectMixdownUiState,
): boolean {
  return !isProjectMixdownRuntimeActive(state) &&
    state.status !== 'MIXDOWN_OUTCOME_UNKNOWN';
}

export function resolveProjectMixdownStartEntry(
  project: ProjectState,
  owner: ProjectMixdownOwner,
): Readonly<{ canStart: true }> | Readonly<{ canStart: false; message: string }> {
  if (owner.kind === 'mixer') {
    return { canStart: true };
  }

  const patchTab = project.patchTabs.find(
    (candidate) => candidate.id === owner.patchTabId,
  );
  const settingsResolution = resolveClipFilerProductionSettings(patchTab);

  return settingsResolution.canResolve
    ? { canStart: true }
    : { canStart: false, message: settingsResolution.message };
}

export function createMixerProjectMixdownControlModel(input: Readonly<{
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  hasStemPrintLock?: boolean;
  isProjectRootReady: boolean;
  state: ProjectMixdownUiState;
}>): MixerProjectMixdownControlModel {
  const isMixerOwner = isProjectMixdownOwner(
    input.state.owner,
    MIXER_PROJECT_MIXDOWN_OWNER,
  );
  const operationActive = isProjectMixdownOperationActive(input.state);
  const runtimeActive = isProjectMixdownRuntimeActive(input.state);
  const hasUnknownOutcome = input.state.status === 'MIXDOWN_OUTCOME_UNKNOWN';
  const canRun = input.engineAcceptsNewJobs &&
    input.isProjectRootReady &&
    canStartProjectMixdown(input.state);
  const ownedState = isMixerOwner
    ? createOwnedMixerPresentation(input.state)
    : undefined;

  if (ownedState) {
    return {
      ...ownedState,
      canCancel: operationActive && input.state.status !== 'CANCEL_REQUESTED',
      canRecover:
        hasUnknownOutcome &&
        input.engineAcceptsNewJobs &&
        input.isProjectRootReady,
      canRun,
      ...(input.state.operationId
        ? { operationId: input.state.operationId }
        : {}),
      showCancel: operationActive,
      showRecover: hasUnknownOutcome,
      ...(input.state.summary ? { summary: input.state.summary } : {}),
    };
  }

  if (runtimeActive) {
    return {
      canCancel: false,
      canRecover: false,
      canRun: false,
      label: 'BUSY',
      message: input.state.owner?.kind === 'clip-filer'
        ? 'Clip Filer owns the active Project Mixdown operation.'
        : 'Another Project Mixdown operation is active.',
      showCancel: false,
      showRecover: false,
      tone: 'active',
    };
  }

  if (hasUnknownOutcome) {
    return {
      canCancel: false,
      canRecover: false,
      canRun: false,
      label: 'OUTCOME UNKNOWN',
      message: input.state.owner?.kind === 'clip-filer'
        ? 'Clip Filer must recover its exact unknown Mixdown operation.'
        : 'Recover the exact unknown Mixdown operation before printing again.',
      showCancel: false,
      showRecover: false,
      tone: 'warning',
    };
  }

  if (input.hasStemPrintLock) {
    return {
      canCancel: false,
      canRecover: false,
      canRun: false,
      label: 'BUSY',
      message: 'Stem Print owns the Project render operation lock.',
      showCancel: false,
      showRecover: false,
      tone: 'active',
    };
  }

  if (!input.engineAcceptsNewJobs) {
    return {
      canCancel: false,
      canRecover: false,
      canRun: false,
      label: 'ERROR',
      message: input.engineAvailabilityMessage,
      showCancel: false,
      showRecover: false,
      tone: 'error',
    };
  }

  if (!input.isProjectRootReady) {
    return {
      canCancel: false,
      canRecover: false,
      canRun: false,
      label: 'ERROR',
      message: 'Select one ready Project Root before printing the Master Bus.',
      showCancel: false,
      showRecover: false,
      tone: 'error',
    };
  }

  return {
    canCancel: false,
    canRecover: false,
    canRun,
    label: 'READY',
    message: 'Print the current stereo Master Bus to a new muted Raw Mix.',
    showCancel: false,
    showRecover: false,
    tone: 'ready',
  };
}

function createOwnedMixerPresentation(
  state: ProjectMixdownUiState,
): Pick<MixerProjectMixdownControlModel, 'label' | 'message' | 'tone'> | undefined {
  if (state.status === 'IDLE' || state.status === 'DOWNLOADING' || state.status === 'DOWNLOADED') {
    return undefined;
  }

  if (state.status === 'PREPARING') {
    return statePresentation('PREPARING', state, 'active');
  }

  if (
    state.status === 'RUNNING' ||
    state.status === 'RECOVERING' ||
    state.status === 'CANCEL_REQUESTED'
  ) {
    return statePresentation('RUNNING', state, 'active');
  }

  if (state.status === 'REGISTERED') {
    return statePresentation('READY', state, 'success');
  }

  if (state.status === 'MIXDOWN_OUTCOME_UNKNOWN') {
    return statePresentation('OUTCOME UNKNOWN', state, 'warning');
  }

  if (state.status === 'CANCELED') {
    return statePresentation('CANCELED', state, 'warning');
  }

  return statePresentation('ERROR', state, 'error');
}

function statePresentation(
  label: string,
  state: ProjectMixdownUiState,
  tone: MixerProjectMixdownControlModel['tone'],
): Pick<MixerProjectMixdownControlModel, 'label' | 'message' | 'tone'> {
  return {
    label,
    message: state.message ?? 'Project Mixdown state updated.',
    tone,
  };
}
