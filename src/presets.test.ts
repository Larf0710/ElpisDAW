import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
  getPatchTabConnectionCompatibility,
} from './patchTabPortContract';
import { resolveOneShotGenerationFamily } from './oneShotGeneration';
import { tabFlowPresets } from './presets';

describe('TabFlow presets', () => {
  it('places one uniquely named ONE SHOT GENERATION entry before existing presets with truthful model prerequisites', () => {
    const preset = requireOneShotPreset();

    expect(tabFlowPresets[0]).toBe(preset);
    expect(preset).toMatchObject({
      description:
        'Write a backing Prompt and Lyrics, then Production Auto Patch runs SA3 T2A and ACE VOCALS once to create aligned backing and vocal Tracks.',
      id: 'one-shot-generation',
      intent:
        'Create one complete backing-and-vocals song draft. A ready Local Engine and both production models are required.',
      name: 'ONE SHOT GENERATION',
    });
    expect(new Set(tabFlowPresets.map(({ id }) => id)).size).toBe(
      tabFlowPresets.length,
    );
    expect(new Set(tabFlowPresets.map(({ name }) => name)).size).toBe(
      tabFlowPresets.length,
    );
    expect(tabFlowPresets.map(({ id }) => id)).toEqual([
      'one-shot-generation',
      'vocalist-starter-flow',
      'hum-to-instrument-flow',
    ]);
  });

  it('uses the exact current SA3 T2A and ACE VOCALS contracts in execution order', () => {
    const project = requireOneShotPreset().project;
    const nodeTypeIds = [
      BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio,
      BUILTIN_PATCH_TAB_TYPE_IDS.aceStep,
    ];
    const definitions = new Map(
      getBuiltinPatchTabDefinitions().map((definition) => [
        definition.nodeTypeId,
        definition,
      ]),
    );

    expect(project.patchTabs.map(({ nodeTypeId }) => nodeTypeId)).toEqual(
      nodeTypeIds,
    );
    project.patchTabs.forEach((patchTab, index) => {
      const definition = definitions.get(nodeTypeIds[index]);
      expect(definition).toBeDefined();
      expect(patchTab.nodeVersion).toBe(definition?.nodeVersion);
      expect(patchTab.portContractSnapshot).toEqual(definition);
    });
    expect(project.patchTabs.map(({ name }) => name)).toEqual([
      'SA3 T2A',
      'ACE VOCALS',
    ]);
    expect(project.patchTabs[0].inputBindings).toEqual([]);
    expect(project.patchTabs[1].inputBindings).toEqual([
      {
        connectionIds: ['one-shot-t2a-to-ace-vocals'],
        kind: 'connection',
        portId: 'guide-audio-in',
      },
    ]);
    expect(project.patchTabs[0].parameters).toEqual([
      expect.objectContaining({ id: 'prompt', kind: 'text' }),
      expect.objectContaining({ id: 'bars', kind: 'number', value: 8 }),
      expect.objectContaining({
        id: 'generationPosition',
        kind: 'select',
        value: 'Playhead',
      }),
      expect.objectContaining({ id: 'seed', kind: 'number', value: 0 }),
      expect.objectContaining({ id: 'takes', kind: 'number', value: 1 }),
    ]);
    expect(project.patchTabs[1].parameters).toEqual([
      expect.objectContaining({ id: 'lyrics', kind: 'text' }),
      expect.objectContaining({ id: 'caption', kind: 'text' }),
      expect.objectContaining({
        id: 'vocalLanguage',
        kind: 'select',
        value: 'Japanese (ja)',
      }),
      expect.objectContaining({ id: 'seed', kind: 'number', value: 0 }),
    ]);
    expect(project.patchTabs[1].description).toContain(
      'Language defaults to Japanese',
    );
  });

  it('defines one compatible ON connection and one enabled ordered Flow Family', () => {
    const project = requireOneShotPreset().project;

    expect(project.connections).toEqual([
      {
        activation: 'on',
        createdOrder: 0,
        enabled: true,
        fromPatchTabId: 'one-shot-sa3-t2a',
        fromPortId: 'audio-out',
        id: 'one-shot-t2a-to-ace-vocals',
        latencyMs: 0,
        order: 0,
        signalType: 'Audio',
        toPatchTabId: 'one-shot-ace-vocals',
        toPortId: 'guide-audio-in',
      },
    ]);
    for (const connection of project.connections) {
      const source = project.patchTabs.find(
        ({ id }) => id === connection.fromPatchTabId,
      );
      const target = project.patchTabs.find(
        ({ id }) => id === connection.toPatchTabId,
      );
      expect(
        getPatchTabConnectionCompatibility(
          source,
          target,
          connection.fromPortId,
          connection.toPortId,
        ).state,
      ).toBe('compatible');
    }
    expect(project.tabFlowLines).toEqual([
      {
        connectionIds: [
          'one-shot-t2a-to-ace-vocals',
        ],
        enabled: true,
        id: 'one-shot-generation-family',
        name: 'ONE SHOT GENERATION',
        order: 0,
        revision: 1,
      },
    ]);
  });

  it('contains no Timeline, generation, selection, or result fixture content', () => {
    const project = requireOneShotPreset().project;

    expect(project.tracks).toEqual([]);
    expect(project.selection).toEqual({ items: [] });
    expect(project.takes).toEqual([]);
    expect(project.artifacts).toEqual([]);
    expect(project.tabFlowStageResults).toEqual([]);
    expect(JSON.stringify(project)).not.toMatch(
      /mock|generatedBy|providerId|modelId|sourceFile|activeClipTakeId/i,
    );
  });

  it('resolves the exact production one-shot family without Timeline material', () => {
    const project = requireOneShotPreset().project;
    const resolution = resolveOneShotGenerationFamily(project);

    expect(resolution).toMatchObject({
      canResolve: true,
      line: { id: 'one-shot-generation-family' },
      textToAudioPatchTab: { id: 'one-shot-sa3-t2a' },
      acePatchTab: { id: 'one-shot-ace-vocals' },
    });
  });
});

function requireOneShotPreset() {
  const presets = tabFlowPresets.filter(
    ({ id }) => id === 'one-shot-generation',
  );

  if (presets.length !== 1) {
    throw new Error('Expected one ONE SHOT GENERATION preset.');
  }

  return presets[0];
}
