import type {
  LocalEngineAudioFileDeletionResult,
  LocalEngineHealthFailureReason,
  LocalEngineProjectFileLoadResult,
  LocalEngineProjectFileSave,
  LocalEngineProjectFileSaveResult,
} from './localEngineClient';
import { planClipTakeRemoval } from './clipTakeRemoval';
import type { ProjectState } from './types';

const ambiguousSideEffectReasons = new Set<LocalEngineHealthFailureReason>([
  'invalid-response',
  'offline',
  'timeout',
]);

export type ProjectSaveSettlement =
  | Readonly<{
      confirmation: 'readback' | 'response';
      savedProject: LocalEngineProjectFileSave;
      status: 'CONFIRMED';
    }>
  | Readonly<{
      message: string;
      status: 'RECOVERY_REQUIRED' | 'REJECTED';
    }>;

export type AudioFileDeletionSettlement = Readonly<{
  fileDisposition: 'deleted' | 'preserved' | 'unknown';
  irreversible: boolean;
  message?: string;
}>;

export type CommittedRemovalReconciliation =
  | Readonly<{
      canReconcile: true;
      projectAfterRemoval: ProjectState;
    }>
  | Readonly<{
      canReconcile: false;
      message: string;
    }>;

export async function settleProjectSave(
  intendedProjectFile: unknown,
  saveResult: LocalEngineProjectFileSaveResult,
  loadProjectFile: () => Promise<LocalEngineProjectFileLoadResult>,
): Promise<ProjectSaveSettlement> {
  if (saveResult.ok) {
    return Object.freeze({
      confirmation: 'response' as const,
      savedProject: saveResult.savedProject,
      status: 'CONFIRMED' as const,
    });
  }

  if (!isAmbiguousSideEffectFailure(saveResult.reason)) {
    return Object.freeze({
      message: saveResult.message,
      status: 'REJECTED' as const,
    });
  }

  let loadResult: LocalEngineProjectFileLoadResult;

  try {
    loadResult = await loadProjectFile();
  } catch (error) {
    return Object.freeze({
      message: createProjectReadbackFailureMessage(
        saveResult.message,
        error instanceof Error ? error.message : 'Project readback failed.',
      ),
      status: 'RECOVERY_REQUIRED' as const,
    });
  }

  if (!loadResult.ok) {
    return Object.freeze({
      message: createProjectReadbackFailureMessage(
        saveResult.message,
        loadResult.message,
      ),
      status: 'RECOVERY_REQUIRED' as const,
    });
  }

  if (!areJsonValuesEquivalent(loadResult.loadedProject.projectFile, intendedProjectFile)) {
    return Object.freeze({
      message:
        'Project save outcome is unknown because exact readback did not match the intended removal.',
      status: 'RECOVERY_REQUIRED' as const,
    });
  }

  return Object.freeze({
    confirmation: 'readback' as const,
    savedProject: Object.freeze({
      bytesWritten: loadResult.loadedProject.bytesRead,
      lastModifiedAt: loadResult.loadedProject.lastModifiedAt,
      projectFileName: loadResult.loadedProject.projectFileName,
      projectFilePath: loadResult.loadedProject.projectFilePath,
      savedAt: loadResult.loadedProject.savedAt,
      status: 'SAVED' as const,
    }),
    status: 'CONFIRMED' as const,
  });
}

export function classifyAudioFileDeletion(
  result: LocalEngineAudioFileDeletionResult,
): AudioFileDeletionSettlement {
  if (result.ok) {
    return Object.freeze({
      fileDisposition: 'deleted' as const,
      irreversible: true,
    });
  }

  if (isAmbiguousSideEffectFailure(result.reason)) {
    return Object.freeze({
      fileDisposition: 'unknown' as const,
      irreversible: true,
      message: result.message,
    });
  }

  return Object.freeze({
    fileDisposition: 'preserved' as const,
    irreversible: false,
    message: result.message,
  });
}

export function reconcileCommittedClipTakeRemoval(
  project: ProjectState,
  clipId: string,
  clipTakeId: string,
): CommittedRemovalReconciliation {
  const removal = planClipTakeRemoval(project, {
    clipId,
    clipTakeId,
    confirmActiveTakeRemoval: true,
    mode: 'project-only',
  });

  return removal.canRemove
    ? Object.freeze({
        canReconcile: true as const,
        projectAfterRemoval: removal.projectAfterRemoval,
      })
    : Object.freeze({
        canReconcile: false as const,
        message: removal.message,
      });
}

export function isAmbiguousSideEffectFailure(
  reason: LocalEngineHealthFailureReason,
): boolean {
  return ambiguousSideEffectReasons.has(reason);
}

export function areJsonValuesEquivalent(first: unknown, second: unknown): boolean {
  try {
    return createCanonicalJson(first) === createCanonicalJson(second);
  } catch {
    return false;
  }
}

function createCanonicalJson(value: unknown): string {
  const json = JSON.stringify(value);

  if (json === undefined) {
    throw new TypeError('A Project file must be JSON serializable.');
  }

  return stableStringify(JSON.parse(json) as unknown);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function createProjectReadbackFailureMessage(
  saveMessage: string,
  readbackMessage: string,
): string {
  return `Project save outcome is unknown after the response failure: ${saveMessage} Exact readback failed: ${readbackMessage}`;
}
