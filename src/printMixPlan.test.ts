import { describe, expect, it } from 'vitest';

import { createPrintMixPlan } from './printMixPlan';
import {
  PRINT_MIX_TEST_OPERATION_ID,
  createPrintMixAudioProject,
  createPrintMixMidiProject,
} from './printMixTestFixture';

describe('createPrintMixPlan', () => {
  it('creates a bounded Audio Plan with relative placement, silence, and Normalize default On', () => {
    const project = createPrintMixAudioProject();
    const result = createPrintMixPlan(
      project,
      'print-mix',
      project.selection,
      PRINT_MIX_TEST_OPERATION_ID,
    );

    expect(result).toMatchObject({
      canCreate: true,
      plan: {
        durationSeconds: 1.5,
        durationTicks: 2_880,
        endTick: 3_840,
        mediaType: 'audio',
        normalize: true,
        startTick: 960,
        targetPeakDbfs: -1,
      },
    });
    if (!result.canCreate || result.plan.mediaType !== 'audio') {
      throw new Error('Missing Audio PRINT MIX Plan.');
    }
    expect(result.plan.events).toEqual([
      expect.objectContaining({
        clipId: 'audio-clip-1',
        durationSeconds: 0.5,
        startOffsetSeconds: 0,
      }),
      expect.objectContaining({
        clipId: 'audio-clip-2',
        durationSeconds: 0.5,
        startOffsetSeconds: 1,
      }),
    ]);
    expect(result.plan).not.toHaveProperty('mixerSnapshot');
    expect(result.plan).not.toHaveProperty('masterFaderDb');
    expect(Object.isFrozen(result.plan)).toBe(true);
  });

  it('captures Normalize Off exactly and rejects unsupported Audio settings', () => {
    const project = createPrintMixAudioProject();
    project.patchTabs = structuredClone(project.patchTabs);
    const normalize = project.patchTabs[0].parameters.find(
      (parameter) => parameter.id === 'normalize',
    );
    if (!normalize || normalize.kind !== 'select') {
      throw new Error('Missing Normalize setting fixture.');
    }
    normalize.value = 'Off';

    expect(
      createPrintMixPlan(
        project,
        'print-mix',
        project.selection,
        PRINT_MIX_TEST_OPERATION_ID,
      ),
    ).toMatchObject({
      canCreate: true,
      plan: { mediaType: 'audio', normalize: false },
    });

    normalize.value = 'Per Clip';
    expect(
      createPrintMixPlan(
        project,
        'print-mix',
        project.selection,
        PRINT_MIX_TEST_OPERATION_ID,
      ),
    ).toMatchObject({ canCreate: false, reason: 'patch-tab-invalid' });
  });

  it('rejects empty, single, non-Clip, duplicate, mixed, and unsupported selections', () => {
    const audioProject = createPrintMixAudioProject();

    for (const selection of [
      { items: [] },
      { items: [{ id: 'audio-clip-1', type: 'clip' as const }] },
    ]) {
      expect(
        createPrintMixPlan(
          audioProject,
          'print-mix',
          selection,
          PRINT_MIX_TEST_OPERATION_ID,
        ),
      ).toMatchObject({ canCreate: false, reason: 'selection-too-small' });
    }

    expect(
      createPrintMixPlan(
        audioProject,
        'print-mix',
        {
          items: [
            { id: 'audio-track-1', type: 'track' },
            { id: 'audio-clip-2', type: 'clip' },
          ],
        },
        PRINT_MIX_TEST_OPERATION_ID,
      ),
    ).toMatchObject({ canCreate: false, reason: 'selection-invalid' });

    expect(
      createPrintMixPlan(
        audioProject,
        'print-mix',
        {
          items: [
            { id: 'audio-clip-1', type: 'clip' },
            { id: 'audio-clip-1', type: 'clip' },
          ],
        },
        PRINT_MIX_TEST_OPERATION_ID,
      ),
    ).toMatchObject({ canCreate: false, reason: 'selection-invalid' });

    const midiProject = createPrintMixMidiProject();
    audioProject.tracks.push(midiProject.tracks[0]);
    const midiArtifact = midiProject.artifacts?.[0];
    if (!midiArtifact) {
      throw new Error('Missing mixed-selection Artifact fixture.');
    }
    audioProject.artifacts?.push(midiArtifact);

    expect(
      createPrintMixPlan(
        audioProject,
        'print-mix',
        {
          items: [
            { id: 'audio-clip-1', type: 'clip' },
            { id: 'midi-clip-1', type: 'clip' },
          ],
        },
        PRINT_MIX_TEST_OPERATION_ID,
      ),
    ).toMatchObject({ canCreate: false, reason: 'mixed-media-selection' });

    audioProject.tracks[0].clips[0].type = 'unsupported' as never;
    expect(
      createPrintMixPlan(
        audioProject,
        'print-mix',
        {
          items: [
            { id: 'audio-clip-1', type: 'clip' },
            { id: 'audio-clip-2', type: 'clip' },
          ],
        },
        PRINT_MIX_TEST_OPERATION_ID,
      ),
    ).toMatchObject({ canCreate: false, reason: 'clip-type-unsupported' });
  });

  it('fails closed on missing, stale, or ambiguous Active Audio identity without changing Project state', () => {
    const missing = createPrintMixAudioProject();
    missing.tracks[0].clips[0].activeClipTakeId = undefined;
    const beforeMissing = JSON.stringify(missing);

    expect(
      createPrintMixPlan(
        missing,
        'print-mix',
        missing.selection,
        PRINT_MIX_TEST_OPERATION_ID,
      ),
    ).toMatchObject({ canCreate: false, reason: 'clip-source-invalid' });

    const stale = createPrintMixAudioProject();
    const staleArtifact = stale.artifacts?.[0];
    if (!staleArtifact || staleArtifact.kind !== 'audio') {
      throw new Error('Missing Audio Artifact fixture.');
    }
    staleArtifact.file.relativePath = '../escape.wav';
    expect(
      createPrintMixPlan(
        stale,
        'print-mix',
        stale.selection,
        PRINT_MIX_TEST_OPERATION_ID,
      ),
    ).toMatchObject({ canCreate: false, reason: 'clip-source-invalid' });

    const ambiguous = createPrintMixAudioProject();
    const ambiguousTake = ambiguous.tracks[0].clips[0].clipTakes?.[0];
    if (!ambiguousTake) {
      throw new Error('Missing ambiguous Take fixture.');
    }
    ambiguous.tracks[0].clips[0].clipTakes?.push({ ...ambiguousTake });
    expect(
      createPrintMixPlan(
        ambiguous,
        'print-mix',
        ambiguous.selection,
        PRINT_MIX_TEST_OPERATION_ID,
      ),
    ).toMatchObject({ canCreate: false, reason: 'clip-source-invalid' });

    expect(JSON.stringify(missing)).toBe(beforeMissing);
  });

  it('merges MIDI Notes over the selected span while preserving duplicates and ignoring timbre metadata', () => {
    const project = createPrintMixMidiProject();
    const result = createPrintMixPlan(
      project,
      'print-mix',
      project.selection,
      PRINT_MIX_TEST_OPERATION_ID,
    );

    expect(result).toMatchObject({
      canCreate: true,
      plan: {
        durationTicks: 2_880,
        endTick: 3_840,
        mediaType: 'midi',
        startTick: 960,
      },
    });
    if (!result.canCreate || result.plan.mediaType !== 'midi') {
      throw new Error('Missing MIDI PRINT MIX Plan.');
    }

    expect(result.plan.notes).toEqual([
      {
        id: 'print-mix-note-1-1',
        lengthTicks: 480,
        pitch: 60,
        startTick: 0,
        velocity: 91,
      },
      {
        id: 'print-mix-note-1-2',
        lengthTicks: 480,
        pitch: 60,
        startTick: 0,
        velocity: 91,
      },
      {
        id: 'print-mix-note-2-1',
        lengthTicks: 960,
        pitch: 67,
        startTick: 1_920,
        velocity: 73,
      },
    ]);
    expect(result.plan).not.toHaveProperty('normalize');
    expect(result.plan).not.toHaveProperty('soundFont');
    expect(JSON.stringify(result.plan)).not.toContain('program');
    expect(JSON.stringify(result.plan)).not.toContain('bank');
  });
});
