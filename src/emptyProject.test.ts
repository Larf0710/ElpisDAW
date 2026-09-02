import { describe, expect, it } from 'vitest';

import { createDefaultPatchTabs, createEmptyProject } from './emptyProject';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import { sampleProject } from './sampleProject';
import { createPatchTabTemplateCatalog } from './stableAudio3PatchTab';
import { createTabFlowFamiliesFromConnections } from './tabFlowFamilies';

describe('empty production Project', () => {
  it('starts with no Timeline or generated-media state', () => {
    const project = createEmptyProject();

    expect(project.tracks).toEqual([]);
    expect(project.tracks.flatMap((track) => track.clips)).toEqual([]);
    expect(project.artifacts).toEqual([]);
    expect(project.takes).toEqual([]);
    expect(project.tabFlowStageResults).toEqual([]);
    expect(project.selection.items).toEqual([]);
    expect(project.playheadTick).toBe(0);
    expect(JSON.stringify(project)).not.toMatch(
      /activeClipTakeId|clipTakes|createdAt|generatedBy|modelId|providerId|sourceFile|sourceJobId/,
    );
  });

  it('keeps only canonical real default PatchTabs and routing', () => {
    const project = createEmptyProject();

    expect(project.patchTabs.map(({ nodeTypeId }) => nodeTypeId)).toEqual([
      BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi,
      BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
      BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
      BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
      BUILTIN_PATCH_TAB_TYPE_IDS.soundFont,
    ]);
    expect(project.connections).toHaveLength(3);
    expect(project.connections.every(({ enabled }) => enabled)).toBe(true);
    expect(project.connections.map(({ fromPatchTabId, toPatchTabId }) => [
      fromPatchTabId,
      toPatchTabId,
    ])).toEqual([
      ['hum-to-midi', 'midi-edit'],
      ['midi-edit', 'instrument'],
      ['instrument', 'stable-audio-3-a2a'],
    ]);
    expect(project.connections[2]).toMatchObject({
      fromPortId: 'audio-out',
      toPortId: 'audio-in',
    });
    expect(project.patchTabs[2]?.inputBindings).toEqual([
      { connectionIds: ['c3'], kind: 'connection', portId: 'midi-in' },
      {
        kind: 'project-context',
        portId: 'soundfont-in',
        selector: 'clip.soundFont',
      },
    ]);
    expect(project.patchTabs[2]?.parameters).toEqual([
      expect.objectContaining({ id: 'bank', value: 0 }),
      expect.objectContaining({ id: 'program', value: 0 }),
    ]);
    expect(project.patchTabs[3]?.inputBindings).toEqual([
      { connectionIds: ['c4'], kind: 'connection', portId: 'audio-in' },
    ]);
    expect(createTabFlowFamiliesFromConnections(project.connections)).toEqual([
      expect.objectContaining({
        connectionIds: ['c2', 'c3', 'c4'],
        enabled: true,
      }),
    ]);
  });

  it('returns independent deterministic state without mutating the sample fixture', () => {
    const sampleSnapshot = structuredClone(sampleProject);
    const first = createEmptyProject();
    const second = createEmptyProject();

    first.patchTabs[0].name = 'Changed';
    first.connections[0].enabled = false;
    first.recordingSettings.countInBars = 2;

    expect(second).toEqual(createEmptyProject());
    expect(second.patchTabs[0].name).toBe('Hum to MIDI');
    expect(second.connections[0].enabled).toBe(true);
    expect(sampleProject).toEqual(sampleSnapshot);
    expect(sampleProject.tracks.length).toBeGreaterThan(0);
  });

  it('keeps PRINT MIX creatable and historical Clip Filer out of fresh creation', () => {
    const catalog = createPatchTabTemplateCatalog(createDefaultPatchTabs());

    expect(catalog).toContainEqual(
      expect.objectContaining({
        name: 'PRINT MIX',
        nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.printMix,
      }),
    );
    expect(catalog).not.toContainEqual(
      expect.objectContaining({
        nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler,
      }),
    );
    const stableAudio3Templates = catalog.filter(
      ({ nodeTypeId }) => nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
    );

    expect(stableAudio3Templates).toHaveLength(1);
    expect(stableAudio3Templates[0]?.inputBindings).toEqual([
      {
        kind: 'timeline-selection',
        portId: 'audio-in',
        selectionKind: 'clip',
      },
    ]);
  });
});
