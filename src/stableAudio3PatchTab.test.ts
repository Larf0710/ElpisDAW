import { describe, expect, it } from 'vitest';

import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import { tabFlowPresets } from './presets';
import { sampleProject } from './sampleProject';
import { ACE_STEP_PATCH_TAB_TEMPLATE_ID } from './aceStepPatchTab';
import {
  createPatchTabTemplateCatalog,
  createStableAudio3A2APatchTabTemplate,
  createStableAudio3T2APatchTabTemplate,
  resolvePatchTabTemplateInstanceIdentity,
  STABLE_AUDIO_3_A2A_PATCH_TAB_TEMPLATE_ID,
  STABLE_AUDIO_3_PROMPT_MAX_LENGTH,
  STABLE_AUDIO_3_T2A_PATCH_TAB_TEMPLATE_ID,
} from './stableAudio3PatchTab';
import { ACE_STEP_TEXT_TO_MUSIC_PATCH_TAB_TEMPLATE_ID } from './aceStepTextToMusicPatchTab';
import { ACE_STEP_COVER_PATCH_TAB_TEMPLATE_ID } from './aceStepCoverPatchTab';

describe('Stable Audio 3 A2A PatchTab template', () => {
  it('publishes the existing production A2A contract with editable parameters', () => {
    const template = createStableAudio3A2APatchTabTemplate(6);

    expect(template).toMatchObject({
      id: STABLE_AUDIO_3_A2A_PATCH_TAB_TEMPLATE_ID,
      name: 'SA3 A2A',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
      nodeVersion: '1.0.0',
      inputBindings: [
        {
          kind: 'timeline-selection',
          portId: 'audio-in',
          selectionKind: 'clip',
        },
      ],
      inputType: 'Audio',
      outputType: 'Audio',
      colorIndex: 6,
    });
    expect(template.portContractSnapshot).toMatchObject({
      inputs: [
        {
          id: 'audio-in',
          cardinality: { min: 1, max: 1 },
        },
      ],
      outputs: [{ id: 'audio-out' }],
    });
    expect(template.parameters).toEqual([
      expect.objectContaining({
        id: 'prompt',
        kind: 'text',
        maxLength: STABLE_AUDIO_3_PROMPT_MAX_LENGTH,
        multiline: true,
      }),
      expect.objectContaining({ id: 'durationSeconds', kind: 'slider' }),
      expect.objectContaining({ id: 'seed', kind: 'number' }),
      expect.objectContaining({
        id: 'takes',
        kind: 'number',
        min: 1,
        max: 3,
        value: 1,
      }),
      expect.objectContaining({
        id: 'strength',
        kind: 'slider',
        label: 'Init Noise Level',
      }),
    ]);
  });

  it('adds generation and PRINT MIX templates without publishing Clip Filer', () => {
    const initialPatchTabIds = sampleProject.patchTabs.map(({ id }) => id);
    const historicalClipFiler = {
      id: 'historical-clip-filer',
      name: 'Clip Filer',
      colorIndex: 4,
      inputType: 'Selected Clip',
      outputType: 'Export File',
      status: 'ready' as const,
      description: 'Historical Clip Filer.',
      parameters: [],
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler,
      nodeVersion: '1.0.0',
    };
    const historicalHumPrep = {
      id: 'historical-hum-prep',
      name: 'Hum Prep',
      colorIndex: 5,
      inputType: 'Hum Audio',
      outputType: 'Hum Audio',
      status: 'idle' as const,
      description: 'Historical Hum Prep.',
      parameters: [],
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.humPrep,
      nodeVersion: '1.0.0',
    };
    const catalog = createPatchTabTemplateCatalog([
      ...sampleProject.patchTabs,
      historicalClipFiler,
      historicalHumPrep,
    ]);
    const sa3Index = catalog.findIndex(
      ({ id }) => id === STABLE_AUDIO_3_A2A_PATCH_TAB_TEMPLATE_ID,
    );
    const t2aIndex = catalog.findIndex(
      ({ id }) => id === STABLE_AUDIO_3_T2A_PATCH_TAB_TEMPLATE_ID,
    );
    const aceStepIndex = catalog.findIndex(
      ({ id }) => id === ACE_STEP_PATCH_TAB_TEMPLATE_ID,
    );
    const aceStepTextToMusicIndex = catalog.findIndex(
      ({ id }) => id === ACE_STEP_TEXT_TO_MUSIC_PATCH_TAB_TEMPLATE_ID,
    );
    const aceStepCoverIndex = catalog.findIndex(
      ({ id }) => id === ACE_STEP_COVER_PATCH_TAB_TEMPLATE_ID,
    );
    const printMixIndex = catalog.findIndex(
      ({ nodeTypeId }) => nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.printMix,
    );

    expect(catalog).toHaveLength(sampleProject.patchTabs.length + 6);
    expect(sa3Index).toBeGreaterThanOrEqual(0);
    expect(t2aIndex).toBe(sa3Index + 1);
    expect(aceStepTextToMusicIndex).toBe(t2aIndex + 1);
    expect(aceStepCoverIndex).toBe(aceStepTextToMusicIndex + 1);
    expect(aceStepIndex).toBe(aceStepCoverIndex + 1);
    expect(printMixIndex).toBe(aceStepIndex + 1);
    expect(catalog[printMixIndex]).toMatchObject({
      id: 'print-mix',
      name: 'PRINT MIX',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.printMix,
      nodeVersion: '1.0.0',
    });
    expect(catalog).not.toContainEqual(
      expect.objectContaining({
        nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler,
      }),
    );
    expect(catalog).not.toContainEqual(
      expect.objectContaining({ outputType: 'Export File' }),
    );
    expect(catalog).not.toContainEqual(
      expect.objectContaining({
        nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.humPrep,
      }),
    );
    expect(historicalClipFiler).toMatchObject({
      name: 'Clip Filer',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler,
    });
    expect(sampleProject.patchTabs.map(({ id }) => id)).toEqual(
      initialPatchTabIds,
    );
    expect(sampleProject.patchTabs).not.toContain(catalog[sa3Index]);
  });

  it('keeps legacy and mock-only PatchTabs out of fresh sample and preset layouts', () => {
    const freshProjects = [
      sampleProject,
      ...tabFlowPresets.map(({ project }) => project),
    ];

    freshProjects.forEach((project) => {
      expect(project.patchTabs).not.toContainEqual(
        expect.objectContaining({
          nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler,
        }),
      );
      expect(project.patchTabs).not.toContainEqual(
        expect.objectContaining({ outputType: 'Export File' }),
      );
      expect(project.patchTabs).not.toContainEqual(
        expect.objectContaining({
          nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.humPrep,
        }),
      );
      expect(project.patchTabs).not.toContainEqual(
        expect.objectContaining({
          inputType: 'Hum Audio',
          outputType: 'Hum Audio',
        }),
      );
      expect(
        project.patchTabs.some(({ description, name }) =>
          /mock|dummy|placeholder/i.test(`${name} ${description}`),
        ),
      ).toBe(false);
      const patchTabIds = new Set(project.patchTabs.map(({ id }) => id));
      expect(patchTabIds.has(project.selectedPatchTabId)).toBe(true);
      expect(
        project.connections.every(
          ({ fromPatchTabId, toPatchTabId }) =>
            patchTabIds.has(fromPatchTabId) && patchTabIds.has(toPatchTabId),
        ),
      ).toBe(true);
    });
  });

  it('publishes a separate source-free T2A contract with vertical editor parameters', () => {
    const template = createStableAudio3T2APatchTabTemplate(7);

    expect(template).toMatchObject({
      id: STABLE_AUDIO_3_T2A_PATCH_TAB_TEMPLATE_ID,
      name: 'SA3 T2A',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio,
      nodeVersion: '1.0.0',
      inputBindings: [],
      inputType: 'None',
      outputType: 'Audio',
      colorIndex: 7,
    });
    expect(template.portContractSnapshot).toMatchObject({
      inputs: [],
      outputs: [{ id: 'audio-out' }],
    });
    expect(template.parameters).toEqual([
      expect.objectContaining({ id: 'prompt', kind: 'text', multiline: true }),
      expect.objectContaining({ id: 'bars', kind: 'number', value: 4 }),
      expect.objectContaining({
        id: 'generationPosition',
        kind: 'select',
        value: 'Playhead',
      }),
      expect.objectContaining({ id: 'seed', kind: 'number', value: 0 }),
      expect.objectContaining({
        id: 'takes',
        kind: 'number',
        min: 1,
        max: 3,
        value: 1,
      }),
    ]);
  });

  it('keeps the official name for the first instance and numbers duplicates', () => {
    const template = createStableAudio3A2APatchTabTemplate();
    const firstIdentity = resolvePatchTabTemplateInstanceIdentity(template, []);
    const secondIdentity = resolvePatchTabTemplateInstanceIdentity(template, [
      { id: firstIdentity.id },
    ]);

    expect(firstIdentity).toEqual({
      id: STABLE_AUDIO_3_A2A_PATCH_TAB_TEMPLATE_ID,
      name: 'SA3 A2A',
    });
    expect(secondIdentity).toEqual({
      id: `${STABLE_AUDIO_3_A2A_PATCH_TAB_TEMPLATE_ID}-2`,
      name: 'SA3 A2A 2',
    });
  });
});
