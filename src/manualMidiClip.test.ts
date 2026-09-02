import { describe, expect, it } from 'vitest';

import { resolveActiveMidiTake } from './activeMidiTake';
import {
  createManualMidiClip,
  MANUAL_MIDI_DEFAULT_LENGTH_TICKS,
} from './manualMidiClip';
import { MIDI_CLIP_COLOR } from './clipTypeColors';
import {
  normalizeClipTakeState,
  normalizeProjectArtifacts,
} from './projectArtifactRegistration';
import { sampleProject } from './sampleProject';
import type { ProjectState } from './types';

describe('Manual MIDI Clip creation', () => {
  it('creates one empty four-bar MIDI Clip and root Take at the playhead', () => {
    const project = cloneSampleProject();
    project.playheadTick = 2_400;

    const result = createManualMidiClip(project, {
      createdAt: '2026-07-31T01:30:00.000Z',
      startTick: project.playheadTick,
    });

    expect(result.canCreate).toBe(true);
    if (!result.canCreate) {
      return;
    }

    expect(result.track).toMatchObject({
      id: 'track-manual-midi-1',
      name: 'MIDI 01',
      type: 'midi',
    });
    expect(result.clip).toMatchObject({
      activeClipTakeId: result.clipTake.clipTakeId,
      color: MIDI_CLIP_COLOR,
      id: 'clip-manual-midi-1',
      lengthTicks: MANUAL_MIDI_DEFAULT_LENGTH_TICKS,
      name: 'MIDI Clip 01',
      startTick: 2_400,
      type: 'midi-notes',
    });
    expect(result.clipTake).toMatchObject({
      label: 'Manual Take 01',
      sourceManualId: 'manual-midi-1',
      sourceType: 'manual',
    });
    expect(result.artifact).toMatchObject({
      lineage: {
        parentArtifactIds: [],
        parentClipTakeIds: [],
      },
      sourceManualId: 'manual-midi-1',
    });
    expect(result.artifact.midi.notes).toEqual([]);

    const active = resolveActiveMidiTake(result.project, result.clip.id);
    expect(active.canResolve).toBe(true);
    if (active.canResolve) {
      expect(active.plan.midi.notes).toEqual([]);
      expect(active.plan.source.sourceType).toBe('manual');
    }
  });

  it('allocates unique identities and extends the Project for a late Clip', () => {
    const project = cloneSampleProject();
    project.playheadTick = project.totalTicks;

    const first = createManualMidiClip(project, {
      createdAt: '2026-07-31T01:30:00.000Z',
      startTick: project.playheadTick,
    });
    expect(first.canCreate).toBe(true);
    if (!first.canCreate) {
      return;
    }

    const second = createManualMidiClip(first.project, {
      createdAt: '2026-07-31T01:31:00.000Z',
      startTick: project.playheadTick,
    });
    expect(second.canCreate).toBe(true);
    if (!second.canCreate) {
      return;
    }

    expect(second.track.id).toBe('track-manual-midi-2');
    expect(second.clip.id).toBe('clip-manual-midi-2');
    expect(second.project.totalTicks).toBe(
      project.playheadTick + MANUAL_MIDI_DEFAULT_LENGTH_TICKS,
    );
  });

  it('survives Project Artifact and Clip Take normalization', () => {
    const result = createManualMidiClip(cloneSampleProject(), {
      createdAt: '2026-07-31T01:30:00.000Z',
      startTick: 0,
    });
    expect(result.canCreate).toBe(true);
    if (!result.canCreate) {
      return;
    }

    const artifacts = normalizeProjectArtifacts(
      JSON.parse(JSON.stringify(result.project.artifacts)),
    );
    const takeState = normalizeClipTakeState(
      JSON.parse(JSON.stringify(result.clip.clipTakes)),
      result.clip.activeClipTakeId,
    );

    expect(artifacts).toContainEqual(result.artifact);
    expect(takeState.clipTakes).toContainEqual(result.clipTake);
    expect(takeState.activeClipTakeId).toBe(result.clipTake.clipTakeId);
  });
});

function cloneSampleProject(): ProjectState {
  return JSON.parse(JSON.stringify(sampleProject)) as ProjectState;
}
