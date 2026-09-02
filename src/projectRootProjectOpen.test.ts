import { describe, expect, it, vi } from 'vitest';

import type {
  LocalEngineProjectFileLoad,
  LocalEngineSourceDescriptor,
  LocalEngineSourceRestoration,
} from './localEngineClient';
import {
  applyProjectRootProjectOpen,
  prepareLoadedProjectSourceRestoration,
  prepareProjectRootProjectOpen,
  type ProjectRootProjectOpenClient,
  type ProjectRootSourceRestorationAdapter,
} from './projectRootProjectOpen';
import { createNormalizedProjectLoad } from './projectLoadNormalization';

type TestWorkspace = Readonly<{
  projectName: string;
  restoredSourceCount?: number;
  revision: number;
}>;

function createProjectLoad(workspace: TestWorkspace, migrated = false) {
  return createNormalizedProjectLoad(
    workspace,
    Object.freeze({
      migrated,
      source: migrated ? 'mixer-state-v1' : 'mixer-state-v2',
    }),
  );
}

const noSourceAdapter: ProjectRootSourceRestorationAdapter<TestWorkspace> = {
  applyRestoration: (workspace) => workspace,
  collectDescriptors: () => [],
};

describe('Project Root Project open boundary', () => {
  it('restores only generated relativePath sources before replacing a loaded Workspace', async () => {
    const loadedWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Loaded Project',
      revision: 2,
    });
    const restoredWorkspace: TestWorkspace = Object.freeze({
      ...loadedWorkspace,
      restoredSourceCount: 1,
    });
    const generatedDescriptor: LocalEngineSourceDescriptor = Object.freeze({
      kind: 'generated',
      relativePath: 'renders/stable-audio-3/generated.wav',
      sourceId: 'artifact-generated',
    });
    const externalDescriptor: LocalEngineSourceDescriptor = Object.freeze({
      kind: 'external',
      path: 'C:\\Audio\\session-source.wav',
      sourceId: 'session-source',
    });
    const restoration = createAvailableRestoration(generatedDescriptor);
    const restoreSources = vi.fn(async () => ({
      ok: true as const,
      restoration,
    }));
    const applyRestoration = vi.fn(() => restoredWorkspace);

    const preparation = await prepareLoadedProjectSourceRestoration(
      { restoreSources },
      loadedWorkspace,
      {
        applyRestoration,
        collectDescriptors: () => [generatedDescriptor, externalDescriptor],
      },
      { engineReadyAndIdle: true, projectRootReady: true },
    );

    expect(preparation).toEqual({
      availableGeneratedSourceCount: 1,
      generatedSourceCount: 1,
      message: 'Restored 1 generated Project source from the Project Root.',
      status: 'RESTORED',
      workspace: restoredWorkspace,
    });
    expect(restoreSources).toHaveBeenCalledWith([generatedDescriptor]);
    expect(applyRestoration).toHaveBeenCalledWith(
      loadedWorkspace,
      [generatedDescriptor],
      restoration,
    );
  });

  it('preserves unresolved loaded sources when Engine or Project Root restoration is unavailable', async () => {
    const loadedWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Loaded Project',
      revision: 2,
    });
    const descriptor: LocalEngineSourceDescriptor = Object.freeze({
      kind: 'generated',
      relativePath: 'renders/stable-audio-3/generated.wav',
      sourceId: 'artifact-generated',
    });
    const restoreSources = vi.fn();
    const applyRestoration = vi.fn();

    const preparation = await prepareLoadedProjectSourceRestoration(
      { restoreSources },
      loadedWorkspace,
      { applyRestoration, collectDescriptors: () => [descriptor] },
      { engineReadyAndIdle: false, projectRootReady: true },
    );

    expect(preparation).toMatchObject({
      availableGeneratedSourceCount: 0,
      generatedSourceCount: 1,
      status: 'PROJECT_ROOT_REQUIRED',
      workspace: loadedWorkspace,
    });
    expect(preparation.message).toContain('remain unresolved');
    expect(restoreSources).not.toHaveBeenCalled();
    expect(applyRestoration).not.toHaveBeenCalled();
  });

  it('keeps the parsed Workspace unchanged when generated restoration fails', async () => {
    const loadedWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Loaded Project',
      revision: 2,
    });
    const descriptor: LocalEngineSourceDescriptor = Object.freeze({
      kind: 'generated',
      relativePath: 'renders/stable-audio-3/generated.wav',
      sourceId: 'artifact-generated',
    });
    const applyRestoration = vi.fn();

    const preparation = await prepareLoadedProjectSourceRestoration(
      {
        restoreSources: async () => ({
          message: 'Project Root source read failed.',
          ok: false,
          reason: 'http-error',
          status: 500,
        }),
      },
      loadedWorkspace,
      { applyRestoration, collectDescriptors: () => [descriptor] },
      { engineReadyAndIdle: true, projectRootReady: true },
    );

    expect(preparation).toMatchObject({
      availableGeneratedSourceCount: 0,
      generatedSourceCount: 1,
      status: 'RESTORATION_FAILED',
      workspace: loadedWorkspace,
    });
    expect(preparation.message).toContain('Project Root source read failed.');
    expect(applyRestoration).not.toHaveBeenCalled();
  });

  it('validates the Project and restores its sources before preparing replacement', async () => {
    const currentWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Current Project',
      revision: 1,
    });
    const parsedWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Loaded Project',
      revision: 2,
    });
    const replacementWorkspace: TestWorkspace = Object.freeze({
      ...parsedWorkspace,
      restoredSourceCount: 1,
    });
    const loadedProject = createLoadedProject();
    const descriptor: LocalEngineSourceDescriptor = Object.freeze({
      kind: 'generated',
      relativePath: 'recordings/take-a.wav',
      sourceId: 'source-a',
    });
    const sourceRestoration = createAvailableRestoration(descriptor);
    const loadProjectFile = vi.fn(async () => ({
      loadedProject,
      ok: true as const,
    }));
    const restoreSources = vi.fn(async () => ({
      ok: true as const,
      restoration: sourceRestoration,
    }));
    const parseProjectFile = vi.fn(() => createProjectLoad(parsedWorkspace, true));
    const collectDescriptors = vi.fn(() => [descriptor]);
    const applyRestoration = vi.fn(() => replacementWorkspace);
    const preparation = await prepareProjectRootProjectOpen(
      { loadProjectFile, restoreSources },
      currentWorkspace,
      parseProjectFile,
      { applyRestoration, collectDescriptors },
    );

    expect(preparation).toMatchObject({
      canOpen: true,
      plan: {
        expectedWorkspace: currentWorkspace,
        loadedProject,
        mixerNormalization: {
          migrated: true,
          source: 'mixer-state-v1',
        },
        replacementWorkspace,
        sourceRestoration,
      },
      status: 'OPEN_READY',
    });
    expect(parseProjectFile).toHaveBeenCalledWith(loadedProject.projectFile);
    expect(collectDescriptors).toHaveBeenCalledWith(parsedWorkspace);
    expect(restoreSources).toHaveBeenCalledWith([descriptor]);
    expect(applyRestoration).toHaveBeenCalledWith(
      parsedWorkspace,
      [descriptor],
      sourceRestoration,
    );
    expect(currentWorkspace).toEqual({
      projectName: 'Current Project',
      revision: 1,
    });
    expect(Object.isFrozen(preparation)).toBe(true);

    if (!preparation.canOpen) {
      throw new Error(preparation.message);
    }

    const opened = applyProjectRootProjectOpen(
      preparation.plan,
      currentWorkspace,
    );

    expect(opened).toEqual({
      loadedProject,
      mixerNormalization: {
        migrated: true,
        source: 'mixer-state-v1',
      },
      opened: true,
      sourceRestoration,
      status: 'OPENED',
      workspace: replacementWorkspace,
    });
  });

  it('preserves the current Workspace when the Engine cannot read the Project', async () => {
    const currentWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Current Project',
      revision: 1,
    });
    const restoreSources = vi.fn();
    const client: ProjectRootProjectOpenClient = {
      loadProjectFile: async () => ({
        message: 'Project JSON was not found.',
        ok: false,
        reason: 'http-error',
        status: 404,
      }),
      restoreSources,
    };
    const parseProjectFile = vi.fn(() => createProjectLoad({
      projectName: 'Must Not Open',
      revision: 2,
    }));
    const preparation = await prepareProjectRootProjectOpen(
      client,
      currentWorkspace,
      parseProjectFile,
      noSourceAdapter,
    );

    expect(preparation).toMatchObject({
      canOpen: false,
      engineReason: 'http-error',
      engineStatus: 404,
      reason: 'engine-read-failed',
      status: 'NOT_OPENABLE',
      workspace: currentWorkspace,
    });
    expect(parseProjectFile).not.toHaveBeenCalled();
    expect(restoreSources).not.toHaveBeenCalled();
  });

  it('preserves the current Workspace when complete Project validation fails', async () => {
    const currentWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Current Project',
      revision: 1,
    });
    const loadedProject = createLoadedProject();
    const restoreSources = vi.fn();
    const preparation = await prepareProjectRootProjectOpen(
      {
        loadProjectFile: async () => ({ loadedProject, ok: true }),
        restoreSources,
      },
      currentWorkspace,
      () => {
        throw new Error('Project Track data is invalid.');
      },
      noSourceAdapter,
    );

    expect(preparation).toMatchObject({
      canOpen: false,
      cause: 'project-root-open-project-invalid',
      message: 'Project JSON validation failed: Project Track data is invalid.',
      reason: 'project-invalid',
      workspace: currentWorkspace,
    });
    expect(restoreSources).not.toHaveBeenCalled();
  });

  it('preserves the current Workspace when source restoration fails', async () => {
    const currentWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Current Project',
      revision: 1,
    });
    const replacementWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Loaded Project',
      revision: 2,
    });
    const loadedProject = createLoadedProject();
    const preparation = await prepareProjectRootProjectOpen(
      {
        loadProjectFile: async () => ({ loadedProject, ok: true }),
        restoreSources: async () => ({
          message: 'Local Engine source restoration timed out.',
          ok: false,
          reason: 'timeout',
        }),
      },
      currentWorkspace,
      () => createProjectLoad(replacementWorkspace),
      noSourceAdapter,
    );

    expect(preparation).toMatchObject({
      canOpen: false,
      cause: 'project-root-open-source-restoration-failed',
      engineReason: 'timeout',
      reason: 'source-restoration-failed',
      workspace: currentWorkspace,
    });

    if (preparation.canOpen) {
      throw new Error('Source restoration unexpectedly prepared an open plan.');
    }

    expect(preparation.workspace).not.toBe(replacementWorkspace);
  });

  it('preserves the current Workspace when Project source descriptors conflict', async () => {
    const currentWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Current Project',
      revision: 1,
    });
    const replacementWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Loaded Project',
      revision: 2,
    });
    const loadedProject = createLoadedProject();
    const restoreSources = vi.fn();
    const preparation = await prepareProjectRootProjectOpen(
      {
        loadProjectFile: async () => ({ loadedProject, ok: true }),
        restoreSources,
      },
      currentWorkspace,
      () => createProjectLoad(replacementWorkspace),
      {
        applyRestoration: (workspace) => workspace,
        collectDescriptors: () => {
          throw new Error('Source source-a has conflicting storage descriptors.');
        },
      },
    );

    expect(preparation).toMatchObject({
      canOpen: false,
      cause: 'project-root-open-source-descriptors-invalid',
      message:
        'Project source metadata validation failed: Source source-a has conflicting storage descriptors.',
      reason: 'source-restoration-invalid',
      workspace: currentWorkspace,
    });
    expect(restoreSources).not.toHaveBeenCalled();
  });

  it('preserves the current Workspace when restoration application rejects the response', async () => {
    const currentWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Current Project',
      revision: 1,
    });
    const replacementWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Loaded Project',
      revision: 2,
    });
    const loadedProject = createLoadedProject();
    const preparation = await prepareProjectRootProjectOpen(
      {
        loadProjectFile: async () => ({ loadedProject, ok: true }),
        restoreSources: async () => ({
          ok: true,
          restoration: createEmptyRestoration(),
        }),
      },
      currentWorkspace,
      () => createProjectLoad(replacementWorkspace),
      {
        applyRestoration: () => {
          throw new Error('Restoration response omitted source-a.');
        },
        collectDescriptors: () => [],
      },
    );

    expect(preparation).toMatchObject({
      canOpen: false,
      cause: 'project-root-open-source-restoration-invalid',
      message:
        'Project source restoration validation failed: Restoration response omitted source-a.',
      reason: 'source-restoration-invalid',
      workspace: currentWorkspace,
    });
  });

  it('blocks a prepared replacement when the current Workspace became stale', async () => {
    const currentWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Current Project',
      revision: 1,
    });
    const changedWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Current Project',
      revision: 2,
    });
    const replacementWorkspace: TestWorkspace = Object.freeze({
      projectName: 'Loaded Project',
      revision: 3,
    });
    const loadedProject = createLoadedProject();
    const preparation = await prepareProjectRootProjectOpen(
      {
        loadProjectFile: async () => ({ loadedProject, ok: true }),
        restoreSources: async () => ({
          ok: true,
          restoration: createEmptyRestoration(),
        }),
      },
      currentWorkspace,
      () => createProjectLoad(replacementWorkspace),
      noSourceAdapter,
    );

    if (!preparation.canOpen) {
      throw new Error(preparation.message);
    }

    const blocked = applyProjectRootProjectOpen(
      preparation.plan,
      changedWorkspace,
    );

    expect(blocked).toEqual({
      cause: 'project-root-open-workspace-stale',
      message: 'Current Workspace changed after the Project open plan was prepared.',
      opened: false,
      reason: 'workspace-stale',
      status: 'BLOCKED',
      workspace: changedWorkspace,
    });
    expect(blocked.workspace).not.toBe(replacementWorkspace);
  });
});

function createLoadedProject(): LocalEngineProjectFileLoad {
  const projectFile = Object.freeze({
    app: 'HumSTUDIO',
    savedAt: '2026-07-23T00:00:00.000Z',
    version: '0.1.0',
    workspace: Object.freeze({
      project: Object.freeze({ name: 'Loaded Project' }),
    }),
  });

  return Object.freeze({
    bytesRead: 512,
    lastModifiedAt: '2026-07-23T00:00:01.000Z',
    projectFile,
    projectFileName: 'Loaded Project.humstudio.json',
    projectFilePath:
      'D:\\Music Projects\\Loaded Project\\Loaded Project.humstudio.json',
    savedAt: projectFile.savedAt,
    status: 'LOADED',
  });
}

function createEmptyRestoration(): LocalEngineSourceRestoration {
  return Object.freeze({
    availability: Object.freeze({}),
    checkedAt: '2026-07-23T00:00:02.000Z',
    sources: Object.freeze([]),
  });
}

function createAvailableRestoration(
  descriptor: Extract<LocalEngineSourceDescriptor, { kind: 'generated' }>,
): LocalEngineSourceRestoration {
  return Object.freeze({
    availability: Object.freeze({ [descriptor.sourceId]: 'available' }),
    checkedAt: '2026-07-23T00:00:02.000Z',
    sources: Object.freeze([
      Object.freeze({
        actual: Object.freeze({
          lastModified: 1_721_692_802_000,
          name: 'take-a.wav',
          sizeBytes: 48_044,
        }),
        kind: 'generated' as const,
        reason: 'available' as const,
        relativePath: descriptor.relativePath,
        resolvedPath:
          'D:\\Music Projects\\Loaded Project\\recordings\\take-a.wav',
        sourceId: descriptor.sourceId,
        state: 'available' as const,
      }),
    ]),
  });
}
