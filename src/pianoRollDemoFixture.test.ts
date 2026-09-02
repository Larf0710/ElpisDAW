import { describe, expect, it } from 'vitest';

import demoProjectFile from './fixtures/PianoRollInteractionSpikeDemo.humstudio.json';
import { resolveActiveMidiTake } from './activeMidiTake';
import type { ProjectState } from './types';

describe('PianoRollInteractionSpike demo fixture', () => {
  it('resolves one selected Active MIDI Take with 512 notes', () => {
    const workspace = demoProjectFile.workspace;
    const project = workspace.project as ProjectState;

    expect(demoProjectFile.app).toBe('HumSTUDIO');
    expect(demoProjectFile.version).toBe('0.1.0');
    expect(project.selection.items).toEqual([
      { type: 'clip', id: workspace.selectedClipId },
    ]);

    const resolution = resolveActiveMidiTake(
      project,
      workspace.selectedClipId,
    );

    expect(resolution.canResolve).toBe(true);

    if (!resolution.canResolve) {
      throw new Error(resolution.message);
    }

    expect(resolution.plan.source).toMatchObject({
      artifactId: 'piano-roll-demo-midi-artifact',
      clipId: 'piano-roll-demo-midi',
      clipTakeId: 'piano-roll-demo-midi-take',
      label: 'Piano Roll Demo MIDI Take',
      revision: 1,
      sourceType: 'job',
    });
    expect(resolution.plan.source.contentHash).toMatch(/^fnv1a64-/);
    expect(resolution.plan.midi.notes).toHaveLength(512);
    expect(
      new Set(resolution.plan.midi.notes.map((note) => note.id)).size,
    ).toBe(512);
  });

  it('contains no launch token or absolute filesystem path', () => {
    const serializedFixture = JSON.stringify(demoProjectFile);

    expect(serializedFixture).not.toMatch(
      /engineToken|engineBaseUrl|[a-z]:\\|file:\/\//i,
    );
  });
});
