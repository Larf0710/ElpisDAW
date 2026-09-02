import { STABLE_AUDIO_3_MAX_DURATION_SECONDS } from '../shared/stableAudio3Protocol.js';
import { AUDIO_GENERATION_REGION_MAX_BARS } from './audioGenerationRegion';
import {
  STABLE_AUDIO_3_MAX_TAKES,
  STABLE_AUDIO_3_MIN_TAKES,
} from './stableAudio3SeedVariations';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
} from './patchTabPortContract';
import type { PatchTab, PatchTabDefinition } from './types';
import { createAceStepPatchTabTemplate } from './aceStepPatchTab';
import { createAceStepTextToMusicPatchTabTemplate } from './aceStepTextToMusicPatchTab';
import { createAceStepCoverPatchTabTemplate } from './aceStepCoverPatchTab';
import { createPrintMixPatchTab } from './printMixPatchTab';

export const STABLE_AUDIO_3_A2A_PATCH_TAB_TEMPLATE_ID =
  'stable-audio-3-a2a' as const;
export const STABLE_AUDIO_3_T2A_PATCH_TAB_TEMPLATE_ID =
  'stable-audio-3-t2a' as const;

export const STABLE_AUDIO_3_PROMPT_MAX_LENGTH = 2_000 as const;

export function createStableAudio3A2APatchTabTemplate(
  colorIndex = 0,
): PatchTab {
  const definition = requireStableAudio3Definition();

  return {
    id: STABLE_AUDIO_3_A2A_PATCH_TAB_TEMPLATE_ID,
    name: 'SA3 A2A',
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
    portContractSnapshot: definition,
    inputBindings: [
      {
        kind: 'timeline-selection',
        portId: 'audio-in',
        selectionKind: 'clip',
      },
    ],
    colorIndex,
    inputType: 'Audio',
    outputType: 'Audio',
    status: 'ready',
    description:
      'Transforms one selected or connected Audio source into a new non-destructive Take with Stable Audio 3.',
    parameters: [
      {
        id: 'prompt',
        label: 'Prompt',
        kind: 'text',
        value: 'A polished instrumental variation that preserves the source structure',
        maxLength: STABLE_AUDIO_3_PROMPT_MAX_LENGTH,
        multiline: true,
        placeholder: 'Describe the sound, style, mood, and instrumentation',
      },
      {
        id: 'durationSeconds',
        label: 'Duration',
        kind: 'slider',
        min: 1,
        max: STABLE_AUDIO_3_MAX_DURATION_SECONDS,
        step: 1,
        value: 30,
        unit: 's',
      },
      {
        id: 'seed',
        label: 'Seed',
        kind: 'number',
        min: 0,
        max: 0xffff_ffff,
        step: 1,
        value: 0,
      },
      {
        id: 'takes',
        label: 'Takes',
        kind: 'number',
        min: STABLE_AUDIO_3_MIN_TAKES,
        max: STABLE_AUDIO_3_MAX_TAKES,
        step: 1,
        value: 1,
      },
      {
        id: 'strength',
        label: 'Init Noise Level',
        kind: 'slider',
        min: 0,
        max: 1,
        step: 0.05,
        value: 0.5,
      },
    ],
  };
}

export function createStableAudio3T2APatchTabTemplate(
  colorIndex = 0,
): PatchTab {
  const definition = requireStableAudio3Definition(
    BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio,
  );

  return {
    id: STABLE_AUDIO_3_T2A_PATCH_TAB_TEMPLATE_ID,
    name: 'SA3 T2A',
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
    portContractSnapshot: definition,
    inputBindings: [],
    colorIndex,
    inputType: 'None',
    outputType: 'Audio',
    status: 'ready',
    description:
      'Generates a new source-free Audio Clip from Prompt and captured Timeline context with Stable Audio 3.',
    parameters: [
      {
        id: 'prompt',
        label: 'Prompt',
        kind: 'text',
        value: 'A focused instrumental cue with a clear musical arc',
        maxLength: STABLE_AUDIO_3_PROMPT_MAX_LENGTH,
        multiline: true,
        placeholder: 'Describe the sound, style, mood, and instrumentation',
      },
      {
        id: 'bars',
        label: 'Bars',
        kind: 'number',
        min: 1,
        max: AUDIO_GENERATION_REGION_MAX_BARS,
        step: 1,
        value: 4,
      },
      {
        id: 'generationPosition',
        label: 'Generation Position',
        kind: 'select',
        value: 'Playhead',
        options: ['Playhead', 'Timeline Start'],
      },
      {
        id: 'seed',
        label: 'Seed',
        kind: 'number',
        min: 0,
        max: 0xffff_ffff,
        step: 1,
        value: 0,
      },
      {
        id: 'takes',
        label: 'Takes',
        kind: 'number',
        min: STABLE_AUDIO_3_MIN_TAKES,
        max: STABLE_AUDIO_3_MAX_TAKES,
        step: 1,
        value: 1,
      },
    ],
  };
}

export function createPatchTabTemplateCatalog(
  baseTemplates: readonly PatchTab[],
): PatchTab[] {
  const canonicalTemplateNodeTypeIds = new Set<string>([
    BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
    BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio,
    BUILTIN_PATCH_TAB_TYPE_IDS.aceStepTextToMusic,
    BUILTIN_PATCH_TAB_TYPE_IDS.aceStepCover,
    BUILTIN_PATCH_TAB_TYPE_IDS.aceStep,
    BUILTIN_PATCH_TAB_TYPE_IDS.printMix,
  ]);
  const creatableBaseTemplates = baseTemplates.filter(
    (patchTab) =>
      patchTab.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.humPrep &&
      patchTab.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler &&
      !canonicalTemplateNodeTypeIds.has(patchTab.nodeTypeId ?? '') &&
      !(
        patchTab.inputType === 'Hum Audio' &&
        patchTab.outputType === 'Hum Audio'
      ) &&
      !(
        patchTab.inputType === 'Selected Clip' &&
        patchTab.outputType === 'Export File'
      ),
  );
  const stableAudio3A2ATemplate = createStableAudio3A2APatchTabTemplate(
    creatableBaseTemplates.length,
  );
  const stableAudio3T2ATemplate = createStableAudio3T2APatchTabTemplate(
    creatableBaseTemplates.length + 1,
  );
  const aceStepTextToMusicTemplate = createAceStepTextToMusicPatchTabTemplate(
    creatableBaseTemplates.length + 2,
  );
  const aceStepCoverTemplate = createAceStepCoverPatchTabTemplate(
    creatableBaseTemplates.length + 3,
  );
  const aceStepTemplate = createAceStepPatchTabTemplate(
    creatableBaseTemplates.length + 4,
  );
  const printMixTemplate = createPrintMixPatchTab(
    'print-mix',
    creatableBaseTemplates.length + 5,
  );

  return [
    ...creatableBaseTemplates,
    stableAudio3A2ATemplate,
    stableAudio3T2ATemplate,
    aceStepTextToMusicTemplate,
    aceStepCoverTemplate,
    aceStepTemplate,
    printMixTemplate,
  ];
}

export function resolvePatchTabTemplateInstanceIdentity(
  template: Pick<PatchTab, 'id' | 'name'>,
  existingPatchTabs: readonly Pick<PatchTab, 'id'>[],
): Readonly<{ id: string; name: string }> {
  const existingIds = new Set(existingPatchTabs.map(({ id }) => id));

  if (!existingIds.has(template.id)) {
    return { id: template.id, name: template.name };
  }

  let suffix = 2;

  while (existingIds.has(`${template.id}-${suffix}`)) {
    suffix += 1;
  }

  return {
    id: `${template.id}-${suffix}`,
    name: `${template.name} ${suffix}`,
  };
}

function requireStableAudio3Definition(
  nodeTypeId: string = BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
): PatchTabDefinition {
  const definition = getBuiltinPatchTabDefinitions().find(
    (candidate) => candidate.nodeTypeId === nodeTypeId,
  );

  if (!definition) {
    throw new Error('Stable Audio 3 PatchTab definition is unavailable.');
  }

  return definition;
}
