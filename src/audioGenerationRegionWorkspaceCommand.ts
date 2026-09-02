import type { AudioGenerationRegionPlan } from './audioGenerationRegion';
import {
  applyAudioGenerationRegionPlan,
} from './audioGenerationRegionApplication';
import {
  commitSessionEdit,
  getSessionEditFrames,
  type SessionEditEntry,
  type SessionEditHistory,
} from './sessionEditHistory';
import type { Clip, ProjectState, Track } from './types';

const MAX_EDIT_ID_LENGTH = 200;

export type AudioGenerationRegionWorkspace = Readonly<{
  project: ProjectState;
  selectedClipId: string;
}>;

export type AudioGenerationRegionWorkspaceCommandRequest = Readonly<{
  createdAt: string;
  editId: string;
  historyLimit: number;
}>;

export type AudioGenerationRegionWorkspaceCommandResult<
  Workspace extends AudioGenerationRegionWorkspace,
> =
  | Readonly<{
      clip: Clip;
      edit: SessionEditEntry;
      executed: true;
      history: SessionEditHistory<Workspace>;
      status: 'EXECUTED';
      track: Track;
      workspace: Workspace;
    }>
  | Readonly<{
      cause: string;
      executed: false;
      history: SessionEditHistory<Workspace>;
      message: string;
      reason: 'command-invalid' | 'plan-invalid' | 'project-stale';
      status: 'BLOCKED';
      workspace: Workspace;
    }>;

export function executeAudioGenerationRegionWorkspaceCommand<
  Workspace extends AudioGenerationRegionWorkspace,
>(
  history: SessionEditHistory<Workspace>,
  plan: AudioGenerationRegionPlan,
  request: AudioGenerationRegionWorkspaceCommandRequest,
): AudioGenerationRegionWorkspaceCommandResult<Workspace> {
  const workspace = history.present.value;
  const commandFailure = validateCommand(history, request);

  if (commandFailure) {
    return blocked(
      history,
      workspace,
      'command-invalid',
      commandFailure.cause,
      commandFailure.message,
    );
  }

  const application = applyAudioGenerationRegionPlan(workspace.project, plan);

  if (!application.applied) {
    return blocked(
      history,
      workspace,
      application.reason,
      application.cause,
      application.message,
    );
  }

  const nextWorkspace: Workspace = {
    ...workspace,
    project: application.project,
    selectedClipId: application.clip.id,
  };
  const edit = Object.freeze({
    category: 'clip' as const,
    createdAt: request.createdAt,
    id: request.editId,
    label: `Create ${application.clip.name}`,
  });
  const nextHistory = commitSessionEdit(
    history,
    nextWorkspace,
    edit,
    request.historyLimit,
  );

  return Object.freeze({
    clip: application.clip,
    edit,
    executed: true as const,
    history: nextHistory,
    status: 'EXECUTED' as const,
    track: application.track,
    workspace: nextWorkspace,
  });
}

function validateCommand<Workspace extends AudioGenerationRegionWorkspace>(
  history: SessionEditHistory<Workspace>,
  request: AudioGenerationRegionWorkspaceCommandRequest,
): Readonly<{ cause: string; message: string }> | undefined {
  if (
    typeof request.createdAt !== 'string' ||
    !request.createdAt.trim() ||
    request.createdAt.trim() !== request.createdAt ||
    !Number.isFinite(Date.parse(request.createdAt))
  ) {
    return {
      cause: 'generation-region-command-timestamp-invalid',
      message: 'Generation Region command requires a valid timestamp.',
    };
  }

  if (
    typeof request.editId !== 'string' ||
    !request.editId.trim() ||
    request.editId.trim() !== request.editId ||
    request.editId.length > MAX_EDIT_ID_LENGTH
  ) {
    return {
      cause: 'generation-region-command-edit-id-invalid',
      message: 'Generation Region command requires one valid Edit identity.',
    };
  }

  if (
    getSessionEditFrames(history).some(
      (frame) => frame.edit.id === request.editId,
    )
  ) {
    return {
      cause: 'generation-region-command-edit-id-conflict',
      message: `Generation Region Edit identity already exists: ${request.editId}.`,
    };
  }

  if (!Number.isSafeInteger(request.historyLimit) || request.historyLimit < 1) {
    return {
      cause: 'generation-region-command-history-limit-invalid',
      message:
        'Generation Region command requires a positive Edit History limit.',
    };
  }

  return undefined;
}

function blocked<Workspace extends AudioGenerationRegionWorkspace>(
  history: SessionEditHistory<Workspace>,
  workspace: Workspace,
  reason: Extract<
    AudioGenerationRegionWorkspaceCommandResult<Workspace>,
    { executed: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AudioGenerationRegionWorkspaceCommandResult<Workspace>,
  { executed: false }
> {
  return Object.freeze({
    cause,
    executed: false as const,
    history,
    message,
    reason,
    status: 'BLOCKED' as const,
    workspace,
  });
}
