import { describe, expect, it } from 'vitest';

import { resolveActiveMidiTake } from './activeMidiTake';
import { createManualMidiClip } from './manualMidiClip';
import {
  canPreviewMidiClipRightResize,
  createMidiClipRightResizeUpdate,
  isMidiClip,
  resolveMidiClipRightResizeSafety,
} from './midiClipResize';
import { savePianoRollTake } from './pianoRollTakeEditing';
import { sampleProject } from './sampleProject';
import type { Clip, MidiNote, ProjectState } from './types';

describe('MIDI Clip right resize', () => {
  it('extends a MIDI Clip and increments its version', () => {
    const fixture = createProject();
    const originalClip = findClip(fixture.project, fixture.clipId);
    const result = createMidiClipRightResizeUpdate(
      fixture.project,
      fixture.clipId,
      19_200,
    );

    expect(result.canResize).toBe(true);
    if (!result.canResize) {
      return;
    }

    expect(result.status).toBe('EXTENDED');
    expect(result.clip).toMatchObject({
      id: fixture.clipId,
      lengthTicks: 19_200,
      version: originalClip.version + 1,
    });
    expect(findClip({ ...fixture.project, tracks: result.tracks }, fixture.clipId)).toEqual(
      result.clip,
    );
    expect(originalClip.lengthTicks).toBe(15_360);
  });

  it('shortens only empty trailing time and preserves every MIDI note', () => {
    const notes = [createNote()];
    const fixture = createProject(notes);
    const result = createMidiClipRightResizeUpdate(
      fixture.project,
      fixture.clipId,
      3_840,
    );

    expect(result.canResize).toBe(true);
    if (!result.canResize) {
      return;
    }

    expect(result).toMatchObject({
      status: 'SHORTENED',
      clip: {
        id: fixture.clipId,
        lengthTicks: 3_840,
      },
    });
    const resizedProject = {
      ...fixture.project,
      tracks: result.tracks,
    };
    const activeTake = resolveActiveMidiTake(
      resizedProject,
      fixture.clipId,
    );
    expect(activeTake.canResolve).toBe(true);
    if (activeTake.canResolve) {
      expect(activeTake.plan.midi.notes).toEqual(notes);
    }
    expect(resizedProject.artifacts).toBe(fixture.project.artifacts);
  });

  it('clamps shortening to the Active MIDI Take final note boundary', () => {
    const fixture = createProject([createNote()]);

    expect(
      createMidiClipRightResizeUpdate(
        fixture.project,
        fixture.clipId,
        1_440,
      ),
    ).toMatchObject({
      adjustedToNoteBoundary: true,
      canResize: true,
      status: 'SHORTENED',
      clip: {
        lengthTicks: 1_920,
      },
    });
  });

  it('allows an empty MIDI Clip to shrink and blocks unverifiable shortening', () => {
    const fixture = createProject();

    expect(
      createMidiClipRightResizeUpdate(
        fixture.project,
        fixture.clipId,
        960,
      ),
    ).toMatchObject({
      canResize: true,
      status: 'SHORTENED',
      clip: {
        lengthTicks: 960,
      },
    });

    const unresolvedProject = updateClip(
      fixture.project,
      fixture.clipId,
      (clip) => ({
        ...clip,
        activeClipTakeId: undefined,
      }),
    );
    expect(
      createMidiClipRightResizeUpdate(
        unresolvedProject,
        fixture.clipId,
        960,
      ),
    ).toMatchObject({
      canResize: false,
      reason: 'active-midi-unavailable',
    });
    expect(
      createMidiClipRightResizeUpdate(
        unresolvedProject,
        fixture.clipId,
        19_200,
      ),
    ).toMatchObject({
      canResize: true,
      status: 'EXTENDED',
    });
  });

  it('caches the safe note boundary for lightweight drag previews', () => {
    const fixture = createProject([createNote()], 2_400);
    const safety = resolveMidiClipRightResizeSafety(
      fixture.project,
      fixture.clipId,
    );

    expect(safety).toEqual({
      canResolve: true,
      minimumEndTick: 4_320,
    });
    if (!safety.canResolve) {
      return;
    }

    expect(
      canPreviewMidiClipRightResize(
        fixture.project.tracks,
        fixture.clipId,
        Math.max(4_000, safety.minimumEndTick),
        fixture.project.totalTicks,
        safety.minimumEndTick,
      ),
    ).toBe(true);
    expect(
      canPreviewMidiClipRightResize(
        fixture.project.tracks,
        fixture.clipId,
        4_800,
        fixture.project.totalTicks,
        safety.minimumEndTick,
      ),
    ).toBe(true);
  });

  it('accepts Edited MIDI and reports an unchanged boundary without copying', () => {
    const fixture = createProject();
    const editedProject = updateClip(
      fixture.project,
      fixture.clipId,
      (clip) => ({
        ...clip,
        type: 'edited-midi',
      }),
    );
    const clip = findClip(editedProject, fixture.clipId);
    const result = createMidiClipRightResizeUpdate(
      editedProject,
      clip.id,
      clip.startTick + clip.lengthTicks,
    );

    expect(result).toMatchObject({
      canResize: true,
      status: 'UNCHANGED',
    });
    if (result.canResize) {
      expect(result.tracks).toBe(editedProject.tracks);
      expect(result.clip).toBe(clip);
    }
  });

  it('rejects Timeline overflow and Clip overlap', () => {
    const fixture = createProject();

    expect(
      createMidiClipRightResizeUpdate(
        fixture.project,
        fixture.clipId,
        fixture.project.totalTicks + 1,
      ),
    ).toMatchObject({
      canResize: false,
      reason: 'timeline-bounds',
    });

    const overlapProject = updateTrackWithClip(
      fixture.project,
      fixture.clipId,
      {
        ...findClip(fixture.project, fixture.clipId),
        id: 'midi-b',
        lengthTicks: 1_920,
        name: 'MIDI B',
        startTick: 19_200,
      },
    );
    expect(
      createMidiClipRightResizeUpdate(
        overlapProject,
        fixture.clipId,
        20_000,
      ),
    ).toMatchObject({
      canResize: false,
      reason: 'clip-overlap',
    });
  });

  it('rejects non-MIDI Clips and identifies both MIDI Clip types', () => {
    const fixture = createProject();
    const midiClip = findClip(fixture.project, fixture.clipId);
    const audioProject = updateClip(
      fixture.project,
      fixture.clipId,
      (clip) => ({
        ...clip,
        type: 'hum-audio',
      }),
    );
    const audioClip = findClip(audioProject, fixture.clipId);

    expect(isMidiClip(midiClip)).toBe(true);
    expect(
      isMidiClip({ ...midiClip, type: 'edited-midi' }),
    ).toBe(true);
    expect(isMidiClip(audioClip)).toBe(false);
    expect(
      createMidiClipRightResizeUpdate(
        audioProject,
        audioClip.id,
        19_200,
      ),
    ).toMatchObject({
      canResize: false,
      reason: 'not-midi',
    });
  });
});

function createProject(
  notes: readonly MidiNote[] = [],
  startTick = 0,
): Readonly<{ clipId: string; project: ProjectState }> {
  const creation = createManualMidiClip(cloneSampleProject(), {
    createdAt: '2026-07-31T09:30:00.000Z',
    startTick,
  });

  if (!creation.canCreate) {
    throw new Error(creation.message);
  }

  if (notes.length === 0) {
    return {
      clipId: creation.clip.id,
      project: creation.project,
    };
  }

  const saved = savePianoRollTake(creation.project, {
    clipId: creation.clip.id,
    identity: {
      artifactId: 'unused-manual-edit-artifact',
      createdAt: '2026-07-31T09:31:00.000Z',
      sourceEditId: 'unused-manual-edit',
    },
    notes,
  });

  if (!saved.canSave) {
    throw new Error(saved.message);
  }

  return {
    clipId: creation.clip.id,
    project: saved.project,
  };
}

function createNote(): MidiNote {
  return {
    id: 'note-safe-boundary',
    lengthTicks: 960,
    pitch: 60,
    startTick: 960,
    velocity: 100,
  };
}

function findClip(project: ProjectState, clipId: string): Clip {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`Clip not found: ${clipId}`);
  }

  return clip;
}

function updateClip(
  project: ProjectState,
  clipId: string,
  update: (clip: Clip) => Clip,
): ProjectState {
  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.id === clipId ? update(clip) : clip,
      ),
    })),
  };
}

function updateTrackWithClip(
  project: ProjectState,
  targetClipId: string,
  addedClip: Clip,
): ProjectState {
  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.clips.some((clip) => clip.id === targetClipId)
        ? {
            ...track,
            clips: [...track.clips, addedClip],
          }
        : track,
    ),
  };
}

function cloneSampleProject(): ProjectState {
  return JSON.parse(JSON.stringify(sampleProject)) as ProjectState;
}
