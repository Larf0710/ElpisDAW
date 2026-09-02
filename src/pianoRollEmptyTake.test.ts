import { describe, expect, it } from 'vitest';

import demoProjectFile from './fixtures/PianoRollInteractionSpikeDemo.humstudio.json';
import { resolveActiveMidiTake } from './activeMidiTake';
import { savePianoRollTake } from './pianoRollTakeEditing';
import type { ProjectState } from './types';

describe('Piano Roll empty Edited Take', () => {
  it('allows the last note deletion to create one resolvable Edited Take', () => {
    const project = JSON.parse(
      JSON.stringify(demoProjectFile.workspace.project),
    ) as ProjectState;
    const source = resolveActiveMidiTake(project, 'piano-roll-demo-midi');

    if (!source.canResolve) {
      throw new Error(source.message);
    }

    const result = savePianoRollTake(project, {
      clipId: source.plan.source.clipId,
      identity: {
        artifactId: 'artifact-piano-roll-empty',
        createdAt: '2026-07-29T10:00:00.000Z',
        sourceEditId: 'edit-piano-roll-empty',
      },
      notes: [],
    });

    expect(result.canSave).toBe(true);
    if (!result.canSave) {
      throw new Error(result.message);
    }

    expect(result).toMatchObject({
      status: 'CREATED',
      clipTake: {
        revision: 1,
        sourceType: 'edit',
      },
    });

    const active = resolveActiveMidiTake(
      result.project,
      'piano-roll-demo-midi',
    );

    expect(active.canResolve).toBe(true);
    if (active.canResolve) {
      expect(active.plan.midi.notes).toEqual([]);
    }
  });
});
