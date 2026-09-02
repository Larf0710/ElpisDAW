import { describe, expect, it } from 'vitest';

import {
  autoPatchMidiEditArtifactId,
  autoPatchMidiEditAttemptId,
  autoPatchMidiEditResultId,
  autoPatchMidiEditSourceEditId,
  createAutoPatchMidiEditStageFixture,
} from './autoPatchMidiEditStage.testFixture';
import { orchestrateAutoPatchMidiEditStage } from './autoPatchMidiEditStageOrchestrator';
import type { ProjectState } from './types';

const options = {
  artifactId: autoPatchMidiEditArtifactId,
  attemptId: autoPatchMidiEditAttemptId,
  finishedAt: '2026-07-31T00:00:30.000Z',
  label: 'Auto Patch MIDI Edit',
  now: () => '2026-07-31T00:00:40.000Z',
  resultId: autoPatchMidiEditResultId,
  sourceEditId: autoPatchMidiEditSourceEditId,
  startedAt: '2026-07-31T00:00:10.000Z',
};

describe('Auto Patch MIDI Edit Stage orchestrator', () => {
  it('runs one MIDI Edit Stage from Coordinator dispatch through atomic Project completion', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const result = orchestrateAutoPatchMidiEditStage(
      fixture.project,
      fixture.coordinatorReady,
      options,
    );

    expect(result).toMatchObject({
      completion: {
        artifact: {
          artifactId: autoPatchMidiEditArtifactId,
          sourceEditId: autoPatchMidiEditSourceEditId,
        },
        clipTake: { sourceType: 'edit' },
        registrationStatus: 'REGISTERED',
        result: { resultId: autoPatchMidiEditResultId },
      },
      coordinator: {
        activeStage: { scope: { stageId: 'stage-instrument' } },
        status: 'READY',
      },
      ok: true,
      processor: {
        gridResolution: '1/16',
        gridStepTicks: 240,
      },
      status: 'STAGE_COMPLETED',
    });

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.completion.artifact.midi.notes[0].startTick).toBe(
      240,
    );
    expect(result.project).not.toBe(fixture.project);
    expect(fixture.project.artifacts).toHaveLength(1);
    expect(result.project.artifacts).toHaveLength(2);
    expect(result.project.tabFlowStageResults).toEqual(
      result.coordinator.stageResults,
    );
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('records a stale-source plan rejection without changing Project data', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const changedProject = cloneProject(fixture.project);
    const sourceArtifact = changedProject.artifacts?.[0];
    const sourceTake = changedProject.tracks[0].clips[0].clipTakes?.[0];

    if (
      !sourceArtifact ||
      sourceArtifact.kind !== 'midi' ||
      !('sourceManualId' in sourceArtifact) ||
      !sourceTake ||
      sourceTake.mediaType !== 'midi' ||
      sourceTake.sourceType !== 'manual'
    ) {
      throw new Error('Expected one Manual MIDI source.');
    }

    sourceArtifact.revision = 2;
    sourceTake.revision = 2;
    const snapshot = JSON.stringify(changedProject);
    const result = orchestrateAutoPatchMidiEditStage(
      changedProject,
      fixture.coordinatorReady,
      options,
    );

    expect(result).toMatchObject({
      cause: 'runtime-midi-input-stale',
      coordinator: {
        failure: { cause: 'runtime-midi-input-stale' },
        status: 'FAILED',
      },
      ok: false,
      reason: 'plan-rejected',
    });
    expect(result.project).toBe(changedProject);
    expect(JSON.stringify(changedProject)).toBe(snapshot);
  });

  it('records processor rejection without creating an Edited MIDI output', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const result = orchestrateAutoPatchMidiEditStage(
      fixture.project,
      fixture.coordinatorReady,
      {
        ...options,
        finishedAt: '2026-07-31T00:00:09.000Z',
      },
    );

    expect(result).toMatchObject({
      cause: 'midi-edit-processing-failed',
      coordinator: {
        failure: { cause: 'midi-edit-processing-failed' },
        status: 'FAILED',
      },
      ok: false,
      reason: 'processor-rejected',
    });
    expect(result.project).toBe(fixture.project);
    expect(fixture.project.artifacts).toHaveLength(1);
  });

  it('records completion rejection without returning partial Project output', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const snapshot = JSON.stringify(fixture.project);
    const result = orchestrateAutoPatchMidiEditStage(
      fixture.project,
      fixture.coordinatorReady,
      { ...options, sourceEditId: '' },
    );

    expect(result).toMatchObject({
      cause: 'midi-edit-output-invalid',
      coordinator: {
        failure: { cause: 'midi-edit-output-invalid' },
        status: 'FAILED',
      },
      ok: false,
      reason: 'completion-failed',
    });
    expect(result.project).toBe(fixture.project);
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
  });

  it('rejects a non-ready Coordinator before planning or processing', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const result = orchestrateAutoPatchMidiEditStage(
      fixture.project,
      fixture.coordinatorRunning,
      options,
    );

    expect(result).toMatchObject({
      cause: 'runtime-transition-invalid',
      coordinator: { status: 'RUNNING' },
      ok: false,
      reason: 'begin-rejected',
    });
    expect(result.project).toBe(fixture.project);
  });

  it('reports when a running failure cannot be recorded', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const result = orchestrateAutoPatchMidiEditStage(
      fixture.project,
      fixture.coordinatorReady,
      {
        ...options,
        finishedAt: '2026-07-31T00:00:09.000Z',
        now: () => '2026-07-31T00:00:00.000Z',
      },
    );

    expect(result).toMatchObject({
      cause: 'runtime-failure-invalid',
      coordinator: { status: 'RUNNING' },
      ok: false,
      reason: 'failure-transition-rejected',
    });
    expect(result.project).toBe(fixture.project);
  });
});

function cloneProject(project: ProjectState): ProjectState {
  return JSON.parse(JSON.stringify(project)) as ProjectState;
}
