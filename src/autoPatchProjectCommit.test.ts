import { describe, expect, it, vi } from 'vitest';

import { createAutoPatchDriverIdentityLedger } from './autoPatchDriverIdentity';
import {
  autoPatchMidiEditArtifactId,
  autoPatchMidiEditAttemptId,
  autoPatchMidiEditResultId,
  autoPatchMidiEditSourceEditId,
  createAutoPatchMidiEditStageFixture,
} from './autoPatchMidiEditStage.testFixture';
import { orchestrateAutoPatchMidiEditStage } from './autoPatchMidiEditStageOrchestrator';
import {
  commitAutoPatchProject,
  prepareAutoPatchProjectCommit,
  type AutoPatchProjectCommitClient,
} from './autoPatchProjectCommit';
import type { AutoPatchProductionDriverResult } from './autoPatchProductionDriver';
import type {
  AutoPatchReadyRuntimeCoordinator,
  AutoPatchRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';
import type { LocalEngineProjectFileSave } from './localEngineClient';
import type { ProjectState } from './types';

const savedProject: LocalEngineProjectFileSave = Object.freeze({
  bytesWritten: 2_048,
  lastModifiedAt: '2026-08-01T00:01:01.000Z',
  projectFileName: 'Auto Patch Commit.humstudio.json',
  projectFilePath:
    'D:\\Music Projects\\Auto Patch Commit\\Auto Patch Commit.humstudio.json',
  savedAt: '2026-08-01T00:01:00.000Z',
  status: 'SAVED',
});

describe('Auto Patch Project commit boundary', () => {
  it('prepares a partial output without saving, then commits only through the explicit command', async () => {
    const fixture = createPartialRunFixture();
    const saveProjectFile = vi.fn(async () => ({
      ok: true as const,
      savedProject,
    }));
    const client: AutoPatchProjectCommitClient = { saveProjectFile };
    const resolution = prepareAutoPatchProjectCommit(
      fixture.initialProject,
      fixture.initialCoordinator,
      fixture.result,
    );

    expect(resolution).toMatchObject({
      canCommit: true,
      plan: {
        commitKind: 'PARTIAL',
        completedAttemptIds: [autoPatchMidiEditAttemptId],
        completedResultIds: [autoPatchMidiEditResultId],
        runId: fixture.initialCoordinator.runId,
        sourceStatus: 'CANCELED',
      },
      status: 'COMMIT_READY',
    });
    expect(saveProjectFile).not.toHaveBeenCalled();

    if (!resolution.canCommit) {
      throw new Error(resolution.message);
    }

    const projectFile = {
      app: 'HumSTUDIO',
      savedAt: savedProject.savedAt,
      version: '0.1.0',
      workspace: { project: resolution.plan.project },
    };
    const materializeProjectFile = vi.fn(() => projectFile);
    const result = await commitAutoPatchProject(
      client,
      resolution.plan,
      {
        currentProject: resolution.plan.project,
        materializeProjectFile,
      },
    );

    expect(result).toEqual({
      ok: true,
      plan: resolution.plan,
      savedProject,
      status: 'COMMITTED',
    });
    expect(materializeProjectFile).toHaveBeenCalledWith(
      resolution.plan.project,
      resolution.plan,
    );
    expect(saveProjectFile).toHaveBeenCalledTimes(1);
    expect(saveProjectFile).toHaveBeenCalledWith(projectFile);
    expect(Object.isFrozen(resolution.plan)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects a canceled run that finalized no new output', () => {
    const fixture = createPartialRunFixture();
    const result: AutoPatchProductionDriverResult = Object.freeze({
      cause: 'abort-signal',
      coordinator: fixture.initialCoordinator,
      ledger: createAutoPatchDriverIdentityLedger(
        fixture.initialCoordinator,
      ),
      message: 'Auto Patch production run was canceled.',
      ok: false,
      project: fixture.initialProject,
      reason: 'run-canceled',
      status: 'CANCELED',
    });

    expect(
      prepareAutoPatchProjectCommit(
        fixture.initialProject,
        fixture.initialCoordinator,
        result,
      ),
    ).toMatchObject({
      canCommit: false,
      cause: 'project-commit-finalized-output-missing',
      coordinator: fixture.initialCoordinator,
      project: fixture.initialProject,
      reason: 'no-finalized-output',
      status: 'NOT_COMMITTABLE',
    });
  });

  it('rejects a Project whose persistent Stage Results differ from the Coordinator', () => {
    const fixture = createPartialRunFixture();
    const mismatchedProject = {
      ...fixture.result.project,
      tabFlowStageResults: [],
    };
    const result = Object.freeze({
      ...fixture.result,
      project: mismatchedProject,
    }) as AutoPatchProductionDriverResult;

    expect(
      prepareAutoPatchProjectCommit(
        fixture.initialProject,
        fixture.initialCoordinator,
        result,
      ),
    ).toMatchObject({
      canCommit: false,
      cause: 'project-commit-stage-results-mismatch',
      coordinator: fixture.result.coordinator,
      project: mismatchedProject,
      reason: 'project-result-mismatch',
    });
  });

  it('rejects a completed attempt that does not match its finalized Stage Result', () => {
    const fixture = createPartialRunFixture();
    const mismatchedCoordinator = Object.freeze({
      ...fixture.result.coordinator,
      attempts: fixture.result.coordinator.attempts.map(
        (attempt, index) =>
          index === 0 && attempt.state === 'COMPLETED'
            ? Object.freeze({
                ...attempt,
                resultId: 'result-mismatched-attempt',
              })
            : attempt,
      ),
    }) as AutoPatchRuntimeCoordinator;
    const result = Object.freeze({
      ...fixture.result,
      coordinator: mismatchedCoordinator,
    }) as AutoPatchProductionDriverResult;

    expect(
      prepareAutoPatchProjectCommit(
        fixture.initialProject,
        fixture.initialCoordinator,
        result,
      ),
    ).toMatchObject({
      canCommit: false,
      cause: 'project-commit-attempt-result-mismatch',
      reason: 'attempt-result-mismatch',
      status: 'NOT_COMMITTABLE',
    });
  });

  it('blocks a stale current Project before materialization or Engine save', async () => {
    const fixture = createPartialRunFixture();
    const plan = requireCommitPlan(fixture);
    const materializeProjectFile = vi.fn(() => ({
      workspace: { project: plan.project },
    }));
    const saveProjectFile = vi.fn();

    const result = await commitAutoPatchProject(
      { saveProjectFile },
      plan,
      {
        currentProject: { ...plan.project },
        materializeProjectFile,
      },
    );

    expect(result).toMatchObject({
      cause: 'project-commit-current-project-changed',
      ok: false,
      plan,
      reason: 'project-stale',
      status: 'BLOCKED',
    });
    expect(materializeProjectFile).not.toHaveBeenCalled();
    expect(saveProjectFile).not.toHaveBeenCalled();
  });

  it('blocks invalid Project file materialization without calling the Engine', async () => {
    const fixture = createPartialRunFixture();
    const plan = requireCommitPlan(fixture);
    const saveProjectFile = vi.fn();

    const result = await commitAutoPatchProject(
      { saveProjectFile },
      plan,
      {
        currentProject: plan.project,
        materializeProjectFile: () => undefined,
      },
    );

    expect(result).toMatchObject({
      cause: 'project-commit-file-invalid',
      ok: false,
      reason: 'project-file-materialization-failed',
      status: 'BLOCKED',
    });
    expect(saveProjectFile).not.toHaveBeenCalled();
  });

  it('blocks materialized Project data that does not match the commit plan', async () => {
    const fixture = createPartialRunFixture();
    const plan = requireCommitPlan(fixture);
    const saveProjectFile = vi.fn();

    const result = await commitAutoPatchProject(
      { saveProjectFile },
      plan,
      {
        currentProject: plan.project,
        materializeProjectFile: () => ({
          app: 'HumSTUDIO',
          savedAt: '2026-08-01T00:01:00.000Z',
          version: '0.1.0',
          workspace: { project: fixture.initialProject },
        }),
      },
    );

    expect(result).toMatchObject({
      cause: 'project-commit-file-project-mismatch',
      ok: false,
      reason: 'project-file-materialization-failed',
      status: 'BLOCKED',
    });
    expect(saveProjectFile).not.toHaveBeenCalled();
  });

  it('surfaces the exact Local Engine save failure without changing the plan', async () => {
    const fixture = createPartialRunFixture();
    const plan = requireCommitPlan(fixture);
    const saveProjectFile = vi.fn(async () => ({
      message: 'Project Root is not configured.',
      ok: false as const,
      reason: 'offline' as const,
      status: 503,
    }));

    const result = await commitAutoPatchProject(
      { saveProjectFile },
      plan,
      {
        currentProject: plan.project,
        materializeProjectFile: (project) => ({
          app: 'HumSTUDIO',
          savedAt: '2026-08-01T00:01:00.000Z',
          version: '0.1.0',
          workspace: { project },
        }),
      },
    );

    expect(result).toEqual({
      cause: 'offline',
      engineStatus: 503,
      message: 'Project Root is not configured.',
      ok: false,
      plan,
      reason: 'project-save-failed',
      status: 'FAILED',
    });
  });
});

type PartialRunFixture = Readonly<{
  initialCoordinator: AutoPatchReadyRuntimeCoordinator;
  initialProject: ProjectState;
  result: Extract<
    AutoPatchProductionDriverResult,
    { status: 'CANCELED' }
  >;
}>;

function createPartialRunFixture(): PartialRunFixture {
  const fixture = createAutoPatchMidiEditStageFixture();
  const initialCoordinator = requireReady(fixture.coordinatorReady);
  const stage = orchestrateAutoPatchMidiEditStage(
    fixture.project,
    initialCoordinator,
    {
      artifactId: autoPatchMidiEditArtifactId,
      attemptId: autoPatchMidiEditAttemptId,
      finishedAt: '2026-07-31T00:00:20.000Z',
      resultId: autoPatchMidiEditResultId,
      sourceEditId: autoPatchMidiEditSourceEditId,
      startedAt: '2026-07-31T00:00:10.000Z',
    },
  );

  if (!stage.ok) {
    throw new Error(stage.message);
  }

  return Object.freeze({
    initialCoordinator,
    initialProject: fixture.project,
    result: Object.freeze({
      cause: 'abort-signal',
      coordinator: stage.coordinator,
      ledger: createAutoPatchDriverIdentityLedger(initialCoordinator),
      message: 'Auto Patch production run was canceled.',
      ok: false,
      project: stage.project,
      reason: 'run-canceled',
      scope:
        stage.coordinator.status === 'READY'
          ? Object.freeze({ ...stage.coordinator.activeStage.scope })
          : undefined,
      status: 'CANCELED',
    }),
  });
}

function requireCommitPlan(fixture: PartialRunFixture) {
  const resolution = prepareAutoPatchProjectCommit(
    fixture.initialProject,
    fixture.initialCoordinator,
    fixture.result,
  );

  if (!resolution.canCommit) {
    throw new Error(resolution.message);
  }

  return resolution.plan;
}

function requireReady(
  coordinator: AutoPatchRuntimeCoordinator,
): AutoPatchReadyRuntimeCoordinator {
  if (coordinator.status !== 'READY') {
    throw new Error('Expected one READY Auto Patch Coordinator.');
  }

  return coordinator;
}
