import { describe, expect, it } from 'vitest';

import demoProjectFile from './fixtures/PianoRollInteractionSpikeDemo.humstudio.json';
import { resolveActiveMidiTake } from './activeMidiTake';
import {
  createManualMidiClip,
  MANUAL_MIDI_DEFAULT_LENGTH_TICKS,
} from './manualMidiClip';
import {
  createNewPianoRollTake,
  savePianoRollTake,
} from './pianoRollTakeEditing';
import { sampleProject } from './sampleProject';
import type { ProjectState } from './types';

describe('Piano Roll Take editing', () => {
  it('protects the Generated Take by creating one active Edited Take', () => {
    const project = createProject();
    const source = resolve(project);
    const result = savePianoRollTake(project, {
      clipId: source.source.clipId,
      identity: createIdentity(1),
      notes: source.midi.notes.map((note, index) =>
        index === 0 ? { ...note, pitch: note.pitch + 1 } : note,
      ),
    });

    expect(result.canSave).toBe(true);
    if (!result.canSave) {
      throw new Error(result.message);
    }

    const clip = findMidiClip(result.project);
    expect(result.status).toBe('CREATED');
    expect(result.clipTake).toMatchObject({
      contentHash: expect.stringMatching(/^fnv1a64-/),
      label: 'Edited Take 02',
      revision: 1,
      sourceType: 'edit',
    });
    expect(clip.clipTakes).toHaveLength(2);
    expect(clip.clipTakes?.[0].sourceType).toBe('job');
    expect(clip.activeClipTakeId).toBe(result.clipTake.clipTakeId);
  });

  it('auto-saves later edits into the same visible Take and increments revision', () => {
    const first = createEditedProject();
    const firstTakeId = first.clipTake.clipTakeId;
    const active = resolve(first.project);
    const saved = savePianoRollTake(first.project, {
      clipId: active.source.clipId,
      notes: active.midi.notes.map((note, index) =>
        index === 1 ? { ...note, startTick: note.startTick + 240 } : note,
      ),
    });

    expect(saved.canSave).toBe(true);
    if (!saved.canSave) {
      throw new Error(saved.message);
    }

    expect(saved.status).toBe('SAVED');
    expect(saved.clipTake.clipTakeId).toBe(firstTakeId);
    expect(saved.clipTake.revision).toBe(2);
    expect(findMidiClip(saved.project).clipTakes).toHaveLength(2);
    expect(resolve(saved.project).source.contentHash).toBe(
      saved.clipTake.contentHash,
    );
  });

  it('creates another visible Take only for the explicit NEW TAKE action', () => {
    const first = createEditedProject();
    const active = resolve(first.project);
    const forked = createNewPianoRollTake(first.project, {
      clipId: active.source.clipId,
      identity: createIdentity(2),
      notes: active.midi.notes,
    });

    expect(forked.canSave).toBe(true);
    if (!forked.canSave) {
      throw new Error(forked.message);
    }

    expect(forked.status).toBe('CREATED');
    expect(forked.clipTake.clipTakeId).not.toBe(first.clipTake.clipTakeId);
    expect(findMidiClip(forked.project).clipTakes).toHaveLength(3);
    expect(findMidiClip(forked.project).activeClipTakeId).toBe(
      forked.clipTake.clipTakeId,
    );
  });

  it('saves Manual MIDI into its root Take and extends the Clip by whole bars', () => {
    const manual = createManualMidiClip(cloneSampleProject(), {
      createdAt: '2026-07-31T01:30:00.000Z',
      startTick: 0,
    });
    expect(manual.canCreate).toBe(true);
    if (!manual.canCreate) {
      return;
    }

    const saved = savePianoRollTake(manual.project, {
      clipId: manual.clip.id,
      notes: [
        {
          id: 'manual-note-1',
          lengthTicks: 960,
          pitch: 60,
          startTick: MANUAL_MIDI_DEFAULT_LENGTH_TICKS,
          velocity: 100,
        },
      ],
    });
    expect(saved.canSave).toBe(true);
    if (!saved.canSave) {
      return;
    }

    const savedClip = findClip(saved.project, manual.clip.id);
    const active = resolveActiveMidiTake(saved.project, manual.clip.id);
    expect(saved.status).toBe('SAVED');
    expect(saved.clipTake).toMatchObject({
      clipTakeId: manual.clipTake.clipTakeId,
      revision: 2,
      sourceType: 'manual',
    });
    expect(savedClip.lengthTicks).toBe(
      MANUAL_MIDI_DEFAULT_LENGTH_TICKS + 4 * 960,
    );
    expect(active.canResolve).toBe(true);
    if (active.canResolve) {
      expect(active.plan.midi.notes).toHaveLength(1);
      expect(active.plan.source.sourceType).toBe('manual');
    }
  });

  it('branches an explicit Edited Take from a Manual MIDI root', () => {
    const manual = createManualMidiClip(cloneSampleProject(), {
      createdAt: '2026-07-31T01:30:00.000Z',
      startTick: 0,
    });
    expect(manual.canCreate).toBe(true);
    if (!manual.canCreate) {
      return;
    }

    const forked = createNewPianoRollTake(manual.project, {
      clipId: manual.clip.id,
      identity: createIdentity(3),
      notes: [],
    });
    expect(forked.canSave).toBe(true);
    if (!forked.canSave) {
      return;
    }

    expect(forked.clipTake.sourceType).toBe('edit');
    expect(resolveActiveMidiTake(forked.project, manual.clip.id).canResolve).toBe(
      true,
    );
  });
});

function createEditedProject() {
  const project = createProject();
  const source = resolve(project);
  const result = savePianoRollTake(project, {
    clipId: source.source.clipId,
    identity: createIdentity(1),
    notes: source.midi.notes.map((note, index) =>
      index === 0 ? { ...note, velocity: note.velocity - 1 } : note,
    ),
  });

  if (!result.canSave) {
    throw new Error(result.message);
  }

  return result;
}

function createProject(): ProjectState {
  return JSON.parse(
    JSON.stringify(demoProjectFile.workspace.project),
  ) as ProjectState;
}

function resolve(project: ProjectState) {
  const resolution = resolveActiveMidiTake(
    project,
    'piano-roll-demo-midi',
  );

  if (!resolution.canResolve) {
    throw new Error(resolution.message);
  }

  return resolution.plan;
}

function findMidiClip(project: ProjectState) {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === 'piano-roll-demo-midi');

  if (!clip) {
    throw new Error('Demo MIDI Clip is missing.');
  }

  return clip;
}

function findClip(project: ProjectState, clipId: string) {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`MIDI Clip is missing: ${clipId}.`);
  }

  return clip;
}

function cloneSampleProject(): ProjectState {
  return JSON.parse(JSON.stringify(sampleProject)) as ProjectState;
}

function createIdentity(index: number) {
  return {
    artifactId: `artifact-piano-roll-edit-${index}`,
    createdAt: `2026-07-28T0${index}:00:00.000Z`,
    sourceEditId: `edit-piano-roll-${index}`,
  };
}
