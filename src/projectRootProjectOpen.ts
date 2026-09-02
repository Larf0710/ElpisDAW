import type {
  LocalEngineClient,
  LocalEngineHealthFailureReason,
  LocalEngineProjectFileLoad,
  LocalEngineProjectFileLoadResult,
  LocalEngineSourceDescriptor,
  LocalEngineSourceRestoration,
  LocalEngineSourceRestorationResult,
} from './localEngineClient';
import type { NormalizedProjectLoad } from './projectLoadNormalization';

export type ProjectRootProjectOpenClient = Pick<
  LocalEngineClient,
  'loadProjectFile' | 'restoreSources'
>;

export type LoadedProjectSourceRestorationClient = Pick<
  LocalEngineClient,
  'restoreSources'
>;

export type ProjectRootProjectParser<Workspace extends object> = (
  projectFile: Readonly<Record<string, unknown>>,
) => NormalizedProjectLoad<Workspace>;

export type ProjectRootSourceRestorationAdapter<Workspace extends object> =
  Readonly<{
    applyRestoration: (
      workspace: Workspace,
      descriptors: readonly LocalEngineSourceDescriptor[],
      restoration: LocalEngineSourceRestoration,
    ) => Workspace;
    collectDescriptors: (
      workspace: Workspace,
    ) => readonly LocalEngineSourceDescriptor[];
  }>;

export type ProjectRootProjectOpenPlan<Workspace extends object> = Readonly<{
  expectedWorkspace: Workspace;
  loadedProject: LocalEngineProjectFileLoad;
  mixerNormalization: NormalizedProjectLoad<Workspace>['mixerNormalization'];
  replacementWorkspace: Workspace;
  sourceRestoration: LocalEngineSourceRestoration;
}>;

export type ProjectRootProjectOpenPreparation<Workspace extends object> =
  | Readonly<{
      canOpen: true;
      plan: ProjectRootProjectOpenPlan<Workspace>;
      status: 'OPEN_READY';
    }>
  | Readonly<{
      canOpen: false;
      cause: string;
      engineReason?: LocalEngineHealthFailureReason;
      engineStatus?: number;
      message: string;
      reason:
        | 'engine-read-failed'
        | 'project-invalid'
        | 'source-restoration-failed'
        | 'source-restoration-invalid';
      status: 'NOT_OPENABLE';
      workspace: Workspace;
    }>;

export type ProjectRootProjectOpenResult<Workspace extends object> =
  | Readonly<{
      loadedProject: LocalEngineProjectFileLoad;
      mixerNormalization: NormalizedProjectLoad<Workspace>['mixerNormalization'];
      opened: true;
      sourceRestoration: LocalEngineSourceRestoration;
      status: 'OPENED';
      workspace: Workspace;
    }>
  | Readonly<{
      cause: string;
      message: string;
      opened: false;
      reason: 'workspace-stale';
      status: 'BLOCKED';
      workspace: Workspace;
    }>;

export type LoadedProjectSourceRestorationPreparation<Workspace extends object> =
  Readonly<{
    availableGeneratedSourceCount: number;
    generatedSourceCount: number;
    message: string;
    status:
      | 'NO_GENERATED_SOURCES'
      | 'PROJECT_ROOT_REQUIRED'
      | 'RESTORATION_FAILED'
      | 'RESTORED';
    workspace: Workspace;
  }>;

export async function prepareLoadedProjectSourceRestoration<Workspace extends object>(
  client: LoadedProjectSourceRestorationClient | undefined,
  loadedWorkspace: Workspace,
  sourceRestorationAdapter: ProjectRootSourceRestorationAdapter<Workspace>,
  readiness: Readonly<{
    engineReadyAndIdle: boolean;
    projectRootReady: boolean;
  }>,
): Promise<LoadedProjectSourceRestorationPreparation<Workspace>> {
  let collectedDescriptors: readonly LocalEngineSourceDescriptor[];

  try {
    collectedDescriptors = sourceRestorationAdapter.collectDescriptors(
      loadedWorkspace,
    );
  } catch (error) {
    return loadedRestorationFailure(
      loadedWorkspace,
      0,
      error instanceof Error
        ? `Generated Project source metadata is invalid: ${error.message}`
        : 'Generated Project source metadata is invalid.',
    );
  }

  if (!Array.isArray(collectedDescriptors)) {
    return loadedRestorationFailure(
      loadedWorkspace,
      0,
      'Generated Project source metadata did not produce a descriptor array.',
    );
  }

  const generatedDescriptors = Object.freeze(
    collectedDescriptors.filter(
      (
        descriptor,
      ): descriptor is Extract<LocalEngineSourceDescriptor, { kind: 'generated' }> =>
        descriptor.kind === 'generated',
    ),
  );

  if (generatedDescriptors.length === 0) {
    return Object.freeze({
      availableGeneratedSourceCount: 0,
      generatedSourceCount: 0,
      message: 'Loaded Project has no generated Project Root sources to restore.',
      status: 'NO_GENERATED_SOURCES' as const,
      workspace: loadedWorkspace,
    });
  }

  if (!client || !readiness.engineReadyAndIdle || !readiness.projectRootReady) {
    return Object.freeze({
      availableGeneratedSourceCount: 0,
      generatedSourceCount: generatedDescriptors.length,
      message:
        'Generated Project sources remain unresolved. A ready, idle Local Engine and ready Project Root are required to restore them.',
      status: 'PROJECT_ROOT_REQUIRED' as const,
      workspace: loadedWorkspace,
    });
  }

  let restorationResult: LocalEngineSourceRestorationResult;

  try {
    restorationResult = await client.restoreSources(generatedDescriptors);
  } catch (error) {
    return loadedRestorationFailure(
      loadedWorkspace,
      generatedDescriptors.length,
      error instanceof Error
        ? `Generated Project source restoration failed: ${error.message}`
        : 'Generated Project source restoration failed.',
    );
  }

  if (!restorationResult.ok) {
    return loadedRestorationFailure(
      loadedWorkspace,
      generatedDescriptors.length,
      `Generated Project source restoration failed: ${restorationResult.message}`,
    );
  }

  let restoredWorkspace: Workspace;

  try {
    restoredWorkspace = sourceRestorationAdapter.applyRestoration(
      loadedWorkspace,
      generatedDescriptors,
      restorationResult.restoration,
    );
  } catch (error) {
    return loadedRestorationFailure(
      loadedWorkspace,
      generatedDescriptors.length,
      error instanceof Error
        ? `Generated Project source restoration response is invalid: ${error.message}`
        : 'Generated Project source restoration response is invalid.',
    );
  }

  if (typeof restoredWorkspace !== 'object' || restoredWorkspace === null) {
    return loadedRestorationFailure(
      loadedWorkspace,
      generatedDescriptors.length,
      'Generated Project source restoration did not return one replacement Workspace.',
    );
  }

  const availableGeneratedSourceCount = generatedDescriptors.filter(
    (descriptor) =>
      restorationResult.restoration.availability[descriptor.sourceId] ===
      'available',
  ).length;

  return Object.freeze({
    availableGeneratedSourceCount,
    generatedSourceCount: generatedDescriptors.length,
    message:
      availableGeneratedSourceCount === generatedDescriptors.length
        ? `Restored ${availableGeneratedSourceCount} generated Project source${availableGeneratedSourceCount === 1 ? '' : 's'} from the Project Root.`
        : `Restored ${availableGeneratedSourceCount} of ${generatedDescriptors.length} generated Project sources. Unavailable generated sources remain unresolved.`,
    status: 'RESTORED' as const,
    workspace: restoredWorkspace,
  });
}

export async function prepareProjectRootProjectOpen<Workspace extends object>(
  client: ProjectRootProjectOpenClient,
  currentWorkspace: Workspace,
  parseProjectFile: ProjectRootProjectParser<Workspace>,
  sourceRestorationAdapter: ProjectRootSourceRestorationAdapter<Workspace>,
): Promise<ProjectRootProjectOpenPreparation<Workspace>> {
  let loadResult: LocalEngineProjectFileLoadResult;

  try {
    loadResult = await client.loadProjectFile();
  } catch (error) {
    return openFailure(
      currentWorkspace,
      'engine-read-failed',
      'project-root-open-engine-read-failed',
      error instanceof Error
        ? `Local Engine Project open failed: ${error.message}`
        : 'Local Engine Project open failed.',
    );
  }

  if (!loadResult.ok) {
    return openFailure(
      currentWorkspace,
      'engine-read-failed',
      'project-root-open-engine-read-failed',
      loadResult.message,
      loadResult.reason,
      loadResult.status,
    );
  }

  let parsedProject: NormalizedProjectLoad<Workspace>;

  try {
    parsedProject = parseProjectFile(
      loadResult.loadedProject.projectFile,
    );
  } catch (error) {
    return openFailure(
      currentWorkspace,
      'project-invalid',
      'project-root-open-project-invalid',
      error instanceof Error
        ? `Project JSON validation failed: ${error.message}`
        : 'Project JSON validation failed.',
    );
  }

  let replacementWorkspace = parsedProject.workspace;

  if (
    typeof replacementWorkspace !== 'object' ||
    replacementWorkspace === null
  ) {
    return openFailure(
      currentWorkspace,
      'project-invalid',
      'project-root-open-project-invalid',
      'Project JSON validation did not return one replacement Workspace.',
    );
  }

  let sourceDescriptors: readonly LocalEngineSourceDescriptor[];

  try {
    sourceDescriptors = sourceRestorationAdapter.collectDescriptors(
      replacementWorkspace,
    );
  } catch (error) {
    return openFailure(
      currentWorkspace,
      'source-restoration-invalid',
      'project-root-open-source-descriptors-invalid',
      error instanceof Error
        ? `Project source metadata validation failed: ${error.message}`
        : 'Project source metadata validation failed.',
    );
  }

  if (!Array.isArray(sourceDescriptors)) {
    return openFailure(
      currentWorkspace,
      'source-restoration-invalid',
      'project-root-open-source-descriptors-invalid',
      'Project source metadata validation did not return a descriptor array.',
    );
  }

  let sourceRestorationResult: LocalEngineSourceRestorationResult;

  try {
    sourceRestorationResult = await client.restoreSources(sourceDescriptors);
  } catch (error) {
    return openFailure(
      currentWorkspace,
      'source-restoration-failed',
      'project-root-open-source-restoration-failed',
      error instanceof Error
        ? `Local Engine source restoration failed: ${error.message}`
        : 'Local Engine source restoration failed.',
    );
  }

  if (!sourceRestorationResult.ok) {
    return openFailure(
      currentWorkspace,
      'source-restoration-failed',
      'project-root-open-source-restoration-failed',
      sourceRestorationResult.message,
      sourceRestorationResult.reason,
      sourceRestorationResult.status,
    );
  }

  try {
    replacementWorkspace = sourceRestorationAdapter.applyRestoration(
      replacementWorkspace,
      sourceDescriptors,
      sourceRestorationResult.restoration,
    );
  } catch (error) {
    return openFailure(
      currentWorkspace,
      'source-restoration-invalid',
      'project-root-open-source-restoration-invalid',
      error instanceof Error
        ? `Project source restoration validation failed: ${error.message}`
        : 'Project source restoration validation failed.',
    );
  }

  if (
    typeof replacementWorkspace !== 'object' ||
    replacementWorkspace === null
  ) {
    return openFailure(
      currentWorkspace,
      'source-restoration-invalid',
      'project-root-open-source-restoration-invalid',
      'Project source restoration did not return one replacement Workspace.',
    );
  }

  return Object.freeze({
    canOpen: true as const,
    plan: Object.freeze({
      expectedWorkspace: currentWorkspace,
      loadedProject: loadResult.loadedProject,
      mixerNormalization: parsedProject.mixerNormalization,
      replacementWorkspace,
      sourceRestoration: sourceRestorationResult.restoration,
    }),
    status: 'OPEN_READY' as const,
  });
}

export function applyProjectRootProjectOpen<Workspace extends object>(
  plan: ProjectRootProjectOpenPlan<Workspace>,
  currentWorkspace: Workspace,
): ProjectRootProjectOpenResult<Workspace> {
  if (currentWorkspace !== plan.expectedWorkspace) {
    return Object.freeze({
      cause: 'project-root-open-workspace-stale',
      message: 'Current Workspace changed after the Project open plan was prepared.',
      opened: false as const,
      reason: 'workspace-stale' as const,
      status: 'BLOCKED' as const,
      workspace: currentWorkspace,
    });
  }

  return Object.freeze({
    loadedProject: plan.loadedProject,
    mixerNormalization: plan.mixerNormalization,
    opened: true as const,
    sourceRestoration: plan.sourceRestoration,
    status: 'OPENED' as const,
    workspace: plan.replacementWorkspace,
  });
}

function openFailure<Workspace extends object>(
  workspace: Workspace,
  reason: Extract<
    ProjectRootProjectOpenPreparation<Workspace>,
    { canOpen: false }
  >['reason'],
  cause: string,
  message: string,
  engineReason?: LocalEngineHealthFailureReason,
  engineStatus?: number,
): Extract<
  ProjectRootProjectOpenPreparation<Workspace>,
  { canOpen: false }
> {
  return Object.freeze({
    canOpen: false as const,
    cause,
    ...(engineReason ? { engineReason } : {}),
    ...(engineStatus !== undefined ? { engineStatus } : {}),
    message,
    reason,
    status: 'NOT_OPENABLE' as const,
    workspace,
  });
}

function loadedRestorationFailure<Workspace extends object>(
  workspace: Workspace,
  generatedSourceCount: number,
  message: string,
): LoadedProjectSourceRestorationPreparation<Workspace> {
  return Object.freeze({
    availableGeneratedSourceCount: 0,
    generatedSourceCount,
    message,
    status: 'RESTORATION_FAILED' as const,
    workspace,
  });
}
