import { describe, expect, it } from 'vitest';

import {
  createAutoPatchMidiEditStageFixture,
} from './autoPatchMidiEditStage.testFixture';
import {
  AUTO_PATCH_MIDI_EDIT_STAGE_ADAPTER_ID,
  createAutoPatchMidiEditProcessorOutcome,
  createAutoPatchMidiEditStagePlan,
} from './autoPatchMidiEditStage';
import { createEditedMidiArtifact } from './midiEditArtifact';
import { createMidiArtifactRegistration } from './projectArtifactRegistration';
import type { ProjectState } from './types';

describe('Auto Patch MIDI Edit Stage plan', () => {
  it('materializes one immutable built-in plan without inventing processing semantics', () => {
    const fixture = createAutoPatchMidiEditStageFixture();

    expect(fixture.plan).toMatchObject({
      adapterId: AUTO_PATCH_MIDI_EDIT_STAGE_ADAPTER_ID,
      attemptId: 'attempt-midi-edit',
      kind: 'builtin-midi-edit',
      parameters: [
        { id: 'quantize', kind: 'select', value: '1/16' },
      ],
      runId: 'run-midi-edit-completion',
      source: {
        source: {
          artifactId: 'artifact-midi-source',
          clipTakeId: 'take-midi-source',
          sourceType: 'manual',
        },
      },
    });
    expect(Object.isFrozen(fixture.plan)).toBe(true);
    expect(Object.isFrozen(fixture.plan.parameters)).toBe(true);
    expect(Object.isFrozen(fixture.plan.source.midi.notes)).toBe(true);
  });

  it('rejects a dispatch after the Active MIDI revision changes', () => {
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

    expect(
      createAutoPatchMidiEditStagePlan(
        fixture.dispatch,
        changedProject,
      ),
    ).toMatchObject({
      canPlan: false,
      cause: 'runtime-midi-input-stale',
      reason: 'source-midi-mismatch',
    });
  });

  it('protects an Active Edited Take from automatic reapplication', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const sourceArtifact = fixture.project.artifacts?.[0];
    const sourceTake = fixture.project.tracks[0].clips[0].clipTakes?.[0];

    if (
      !sourceArtifact ||
      sourceArtifact.kind !== 'midi' ||
      !sourceTake ||
      sourceTake.mediaType !== 'midi'
    ) {
      throw new Error('Expected one MIDI source.');
    }

    const edited = createEditedMidiArtifact({
      artifactId: 'artifact-manual-midi-edit',
      createdAt: '2026-07-31T00:00:05.000Z',
      notes: sourceArtifact.midi.notes,
      sourceArtifact,
      sourceClipTake: sourceTake,
      sourceEditId: 'manual-midi-edit',
    });
    const registration = createMidiArtifactRegistration(
      fixture.project,
      edited,
      { clipId: fixture.plan.scope.targetClipId },
    );

    if (!registration.canRegister) {
      throw new Error(registration.message);
    }

    expect(
      createAutoPatchMidiEditStagePlan(
        fixture.dispatch,
        registration.project,
      ),
    ).toMatchObject({
      canPlan: false,
      cause: 'automatic-midi-edit-reapplication-blocked',
      reason: 'edited-input-protected',
    });
  });
});

describe('Auto Patch MIDI Edit processor outcome', () => {
  it('normalizes and freezes a processor-owned note result', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const sourceNote = fixture.plan.source.midi.notes[0];
    const outcome = createAutoPatchMidiEditProcessorOutcome(
      fixture.plan,
      {
        finishedAt: '2026-07-31T00:00:20.000Z',
        notes: [
          { ...sourceNote, id: 'note-late', startTick: 960 },
          { ...sourceNote, id: 'note-early', startTick: 0 },
        ],
      },
    );

    expect(outcome.notes.map((note) => note.id)).toEqual([
      'note-early',
      'note-late',
    ]);
    expect(outcome.status).toBe('MIDI_EDIT_COMPLETED');
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.notes)).toBe(true);
  });

  it('rejects a processor completion timestamp before the Stage attempt', () => {
    const fixture = createAutoPatchMidiEditStageFixture();

    expect(() =>
      createAutoPatchMidiEditProcessorOutcome(fixture.plan, {
        finishedAt: '2026-07-31T00:00:09.000Z',
        notes: fixture.plan.source.midi.notes,
      }),
    ).toThrow('Automatic MIDI Edit completion timestamp is invalid.');
  });
});

function cloneProject(project: ProjectState): ProjectState {
  return JSON.parse(JSON.stringify(project)) as ProjectState;
}
