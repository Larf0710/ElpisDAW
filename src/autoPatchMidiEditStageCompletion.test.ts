import { describe, expect, it } from 'vitest';

import {
  autoPatchMidiEditArtifactId,
  autoPatchMidiEditResultId,
  autoPatchMidiEditSourceEditId,
  createAutoPatchMidiEditStageFixture,
} from './autoPatchMidiEditStage.testFixture';
import { completeAutoPatchMidiEditStage } from './autoPatchMidiEditStageCompletion';
import { AUTO_PATCH_MIDI_EDIT_EDITOR_ID } from './autoPatchMidiEditStage';
import { createEditedMidiArtifact } from './midiEditArtifact';
import { createMidiArtifactRegistration } from './projectArtifactRegistration';
import type {
  CompletedTabFlowStageResultRecord,
  ManualMidiArtifact,
  MidiArtifact,
  MidiClipTake,
  ProjectState,
} from './types';

const options = {
  artifactId: autoPatchMidiEditArtifactId,
  label: 'Auto Patch MIDI Edit',
  resultId: autoPatchMidiEditResultId,
  sourceEditId: autoPatchMidiEditSourceEditId,
};

describe('Auto Patch MIDI Edit Stage completion', () => {
  it('atomically registers one Edited MIDI Take and advances the Coordinator', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const result = completeAutoPatchMidiEditStage(
      fixture.project,
      fixture.coordinatorRunning,
      fixture.plan,
      fixture.outcome,
      options,
    );

    expect(result).toMatchObject({
      artifact: {
        artifactId: autoPatchMidiEditArtifactId,
        editProvenance: {
          editorId: AUTO_PATCH_MIDI_EDIT_EDITOR_ID,
          editorVersion: '1',
          taskId: 'midi-edit',
        },
        sourceEditId: autoPatchMidiEditSourceEditId,
      },
      clipTake: {
        artifactId: autoPatchMidiEditArtifactId,
        sourceType: 'edit',
      },
      coordinator: {
        activeStage: { scope: { stageId: 'stage-instrument' } },
        status: 'READY',
      },
      ok: true,
      registrationStatus: 'REGISTERED',
      result: {
        resultId: autoPatchMidiEditResultId,
        state: 'COMPLETED',
      },
      status: 'COMPLETED',
    });

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.artifact.midi.notes[0].startTick).toBe(240);
    expect(result.targetClip.activeClipTakeId).toBe(
      result.clipTake.clipTakeId,
    );
    expect(result.targetClip.lengthTicks).toBe(7_680);
    expect(result.targetClip.version).toBe(2);
    expect(result.project.totalTicks).toBe(7_680);
    expect(result.project.artifacts).toHaveLength(2);
    expect(result.targetClip.clipTakes).toHaveLength(2);
    expect(result.project.tabFlowStageResults).toEqual(
      result.coordinator.stageResults,
    );
    expect(result.coordinator.runtimeTargets[0]).toMatchObject({
      artifactIdentities: expect.arrayContaining([
        expect.objectContaining({
          artifactId: autoPatchMidiEditArtifactId,
          mediaType: 'midi',
          midi: {
            contentHash: result.artifact.contentHash,
            revision: 1,
          },
        }),
      ]),
      availability: {
        artifactIds: expect.arrayContaining([
          autoPatchMidiEditArtifactId,
        ]),
        clipTakeIds: expect.arrayContaining([
          result.clipTake.clipTakeId,
        ]),
      },
    });
    expect(fixture.project.artifacts).toHaveLength(1);
    expect(findClip(fixture.project).clipTakes).toHaveLength(1);
  });

  it('atomically extends the MIDI Clip and Project to the next whole bar', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const result = completeAutoPatchMidiEditStage(
      fixture.project,
      fixture.coordinatorRunning,
      fixture.plan,
      {
        ...fixture.outcome,
        notes: [
          {
            ...fixture.outcome.notes[0],
            lengthTicks: 960,
            startTick: 7_680,
          },
        ],
      },
      options,
    );

    expect(result).toMatchObject({
      ok: true,
      project: { totalTicks: 11_520 },
      status: 'COMPLETED',
      targetClip: {
        lengthTicks: 11_520,
        version: 2,
      },
    });

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.targetClip.activeClipTakeId).toBe(
      result.clipTake.clipTakeId,
    );
    expect(result.project.artifacts).toHaveLength(2);
    expect(result.project.tabFlowStageResults).toEqual(
      result.coordinator.stageResults,
    );
    expect(result.project).not.toBe(fixture.project);
    expect(findClip(fixture.project).lengthTicks).toBe(7_680);
    expect(findClip(fixture.project).version).toBe(1);
    expect(fixture.project.totalTicks).toBe(7_680);
  });

  it('rejects whole-bar overflow and returns the original Project reference', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const result = completeAutoPatchMidiEditStage(
      fixture.project,
      fixture.coordinatorRunning,
      fixture.plan,
      {
        ...fixture.outcome,
        notes: [
          {
            ...fixture.outcome.notes[0],
            lengthTicks: 1,
            startTick: Number.MAX_SAFE_INTEGER - 1,
          },
        ],
      },
      options,
    );

    expect(result).toMatchObject({
      cause: 'midi-edit-output-boundary-invalid',
      ok: false,
      reason: 'output-invalid',
    });
    expect(result.project).toBe(fixture.project);
    expect(findClip(fixture.project).lengthTicks).toBe(7_680);
    expect(fixture.project.artifacts).toHaveLength(1);
  });

  it('rejects stale MIDI Clip geometry before staging boundary growth', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const changedProject: ProjectState = {
      ...fixture.project,
      tracks: fixture.project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({
          ...clip,
          lengthTicks: 3_840,
          version: clip.version + 1,
        })),
      })),
    };
    const result = completeAutoPatchMidiEditStage(
      changedProject,
      fixture.coordinatorRunning,
      fixture.plan,
      fixture.outcome,
      options,
    );

    expect(result).toMatchObject({
      cause: 'midi-edit-target-clip-changed',
      ok: false,
      reason: 'project-stale',
    });
    expect(result.project).toBe(changedProject);
    expect(changedProject.artifacts).toHaveLength(1);
  });

  it('rejects a processor outcome with a different immutable identity', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const snapshot = JSON.stringify(fixture.project);

    expect(
      completeAutoPatchMidiEditStage(
        fixture.project,
        fixture.coordinatorRunning,
        fixture.plan,
        { ...fixture.outcome, fingerprint: 'wrong-fingerprint' },
        options,
      ),
    ).toMatchObject({
      cause: 'midi-edit-runtime-identity-mismatch',
      ok: false,
      reason: 'identity-mismatch',
    });
    expect(JSON.stringify(fixture.project)).toBe(snapshot);
  });

  it('rejects changed Project Stage Results before creating output', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const unrelatedResult: CompletedTabFlowStageResultRecord = {
      fingerprint: 'unrelated-fingerprint',
      finishedAt: '2026-07-31T00:00:05.000Z',
      outputArtifactIds: ['artifact-unrelated'],
      outputClipTakeIds: [],
      resultId: 'result-unrelated',
      scope: {
        ...fixture.plan.scope,
        stageId: 'stage-unrelated',
      },
      state: 'COMPLETED',
    };
    const staleProject = {
      ...fixture.project,
      tabFlowStageResults: [unrelatedResult],
    };

    expect(
      completeAutoPatchMidiEditStage(
        staleProject,
        fixture.coordinatorRunning,
        fixture.plan,
        fixture.outcome,
        options,
      ),
    ).toMatchObject({
      cause: 'project-stage-results-changed',
      ok: false,
      reason: 'project-stale',
    });
    expect(staleProject.artifacts).toHaveLength(1);
  });

  it('rejects a MIDI Edit PatchTab changed after the runtime snapshot', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const changedProject = {
      ...fixture.project,
      patchTabs: fixture.project.patchTabs.map((patchTab) => ({
        ...patchTab,
        parameters: patchTab.parameters.map((parameter) =>
          parameter.id === 'quantize'
            ? { ...parameter, value: '1/8' }
            : parameter,
        ),
      })),
    } as ProjectState;

    expect(
      completeAutoPatchMidiEditStage(
        changedProject,
        fixture.coordinatorRunning,
        fixture.plan,
        fixture.outcome,
        options,
      ),
    ).toMatchObject({
      cause: 'midi-edit-patch-tab-changed',
      ok: false,
      reason: 'project-stale',
    });
    expect(changedProject.artifacts).toHaveLength(1);
  });

  it('does not replace an Edited Take activated while processing was in flight', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const source = resolveSource(fixture.project);
    const manualEdit = createEditedMidiArtifact({
      artifactId: 'artifact-deliberate-midi-edit',
      createdAt: '2026-07-31T00:00:20.000Z',
      notes: source.artifact.midi.notes,
      sourceArtifact: source.artifact,
      sourceClipTake: source.clipTake,
      sourceEditId: 'deliberate-midi-edit',
    });
    const registration = createMidiArtifactRegistration(
      fixture.project,
      manualEdit,
      { clipId: fixture.plan.scope.targetClipId },
    );

    if (!registration.canRegister) {
      throw new Error(registration.message);
    }

    const snapshot = JSON.stringify(registration.project);
    const result = completeAutoPatchMidiEditStage(
      registration.project,
      fixture.coordinatorRunning,
      fixture.plan,
      fixture.outcome,
      options,
    );

    expect(result).toMatchObject({
      cause: 'automatic-midi-edit-reapplication-blocked',
      ok: false,
      reason: 'source-invalid',
    });
    expect(JSON.stringify(registration.project)).toBe(snapshot);
    expect(findClip(registration.project).activeClipTakeId).toBe(
      registration.clipTake.clipTakeId,
    );
  });

  it('rolls back when the requested output Artifact ID is already occupied', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const source = resolveSource(fixture.project);

    if (!('sourceManualId' in source.artifact)) {
      throw new Error('Expected one Manual MIDI Artifact.');
    }

    const conflictingArtifact: ManualMidiArtifact = {
      ...source.artifact,
      artifactId: autoPatchMidiEditArtifactId,
      sourceManualId: 'conflicting-manual-midi',
    };
    const conflictProject = {
      ...fixture.project,
      artifacts: [...(fixture.project.artifacts ?? []), conflictingArtifact],
    };
    const snapshot = JSON.stringify(conflictProject);

    const result = completeAutoPatchMidiEditStage(
      conflictProject,
      fixture.coordinatorRunning,
      fixture.plan,
      {
        ...fixture.outcome,
        notes: [
          {
            ...fixture.outcome.notes[0],
            lengthTicks: 960,
            startTick: 7_680,
          },
        ],
      },
      options,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'registration-failed',
    });
    expect(result.project).toBe(conflictProject);
    expect(JSON.stringify(conflictProject)).toBe(snapshot);
    expect(findClip(conflictProject).clipTakes).toHaveLength(1);
    expect(findClip(conflictProject).lengthTicks).toBe(7_680);
    expect(conflictProject.totalTicks).toBe(7_680);
  });
});

function resolveSource(project: ProjectState): Readonly<{
  artifact: MidiArtifact;
  clipTake: MidiClipTake;
}> {
  const artifact = project.artifacts?.[0];
  const clipTake = findClip(project).clipTakes?.[0];

  if (
    !artifact ||
    artifact.kind !== 'midi' ||
    !clipTake ||
    clipTake.mediaType !== 'midi'
  ) {
    throw new Error('Expected one MIDI source.');
  }

  return { artifact, clipTake };
}

function findClip(project: ProjectState) {
  return project.tracks[0].clips[0];
}
