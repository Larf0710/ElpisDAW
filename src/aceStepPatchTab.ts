import {
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_TASK_ID,
  ACE_STEP_UPSTREAM_TASK_TYPE,
} from '../shared/aceStepProtocol.js';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
} from './patchTabPortContract';
import {
  resolveAceStepTextToAudioGuide,
  resolveAceStepVocalTarget,
  type AceStepTextToAudioGuideResolution,
  type AceStepTextToAudioVocalTarget,
  type AceStepVocalTargetResolution,
} from './aceStepVocalStage';
import type { PatchTab, PatchTabDefinition, PatchTabParameter, ProjectState } from './types';

export const ACE_STEP_PATCH_TAB_TEMPLATE_ID = 'ace-step-vocals' as const;
export const ACE_STEP_LYRICS_MAX_LENGTH = 4_096 as const;
export const ACE_STEP_CAPTION_MAX_LENGTH = 2_000 as const;

const ACE_STEP_LYRICS_MAX_UTF8_BYTES = 16 * 1024;
const VOCAL_LANGUAGE_BY_OPTION = Object.freeze({
  'English (en)': 'en',
  'Japanese (ja)': 'ja',
  Unknown: 'unknown',
} as const);

export type AceStepPatchTabSettings = Readonly<{
  caption: string;
  lyrics: string;
  seed: number;
  vocalLanguage: string;
  vocalLanguageLabel: string;
}>;

export type AceStepPatchTabSettingsResolution =
  | Readonly<{ canResolve: true; settings: AceStepPatchTabSettings }>
  | Readonly<{ canResolve: false; cause: string; message: string }>;

export type AceStepPatchTabPreparation =
  | Readonly<{
      canPrepare: true;
      mode: 'existing-vocal';
      settings: AceStepPatchTabSettings;
      target: Extract<AceStepVocalTargetResolution, { canResolve: true }>;
    }>
  | Readonly<{
      canPrepare: true;
      guide: Extract<AceStepTextToAudioGuideResolution, { canResolve: true }> &
        Readonly<{ guideClipName: string }>;
      mode: 'stable-audio-3-text-to-audio';
      settings: AceStepPatchTabSettings;
    }>
  | Readonly<{ canPrepare: false; cause: string; message: string }>;

export type AceStepTextToAudioVocalTargetResolution =
  | Readonly<{
      canCreate: true;
      target: AceStepTextToAudioVocalTarget;
    }>
  | Readonly<{ canCreate: false; message: string }>;

export function createAceStepPatchTabTemplate(colorIndex = 0): PatchTab {
  const definition = requireAceStepDefinition();

  return {
    id: ACE_STEP_PATCH_TAB_TEMPLATE_ID,
    name: 'ACE Vocals',
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
    portContractSnapshot: definition,
    inputBindings: [],
    colorIndex,
    inputType: 'Guide Audio',
    outputType: 'Vocal Audio',
    status: 'ready',
    description:
      'Generates one traceable vocal Take from a selected SA3 T2A Guide or an existing Vocal target and written Lyrics.',
    parameters: [
      {
        id: 'lyrics',
        label: 'Lyrics',
        kind: 'text',
        value: '',
        maxLength: ACE_STEP_LYRICS_MAX_LENGTH,
        multiline: true,
        placeholder: 'Enter the lyrics exactly as they should be sung',
      },
      {
        id: 'caption',
        label: 'Caption',
        kind: 'text',
        value:
          'Solo vocal, a cappella, warm intimate lead vocal following the guide melody',
        maxLength: ACE_STEP_CAPTION_MAX_LENGTH,
        multiline: true,
        placeholder: 'Describe vocal character, delivery, and tone',
      },
      {
        id: 'vocalLanguage',
        label: 'Language',
        kind: 'select',
        value: 'English (en)',
        options: Object.keys(VOCAL_LANGUAGE_BY_OPTION),
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
    ],
  };
}

export function isAceStepPatchTab(
  patchTab: PatchTab | undefined,
): boolean {
  return patchTab?.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.aceStep;
}

export function resolveAceStepPatchTabSettings(
  patchTab: PatchTab | undefined,
): AceStepPatchTabSettingsResolution {
  if (!patchTab || !isAceStepPatchTab(patchTab)) {
    return failure(
      'ace-step-patchtab-invalid',
      'ACE Vocals requires the dedicated Guide Audio PatchTab.',
    );
  }

  const lyricsParameter = findParameter(patchTab, 'lyrics', 'text');
  const captionParameter = findParameter(patchTab, 'caption', 'text');
  const languageParameter = findParameter(patchTab, 'vocalLanguage', 'select');
  const seedParameter = findParameter(patchTab, 'seed', 'number');

  if (
    !lyricsParameter ||
    !captionParameter ||
    !languageParameter ||
    !seedParameter
  ) {
    return failure(
      'ace-step-parameters-invalid',
      'ACE Vocals PatchTab parameters are incomplete or invalid.',
    );
  }

  const lyrics = lyricsParameter.value.trim();
  const caption = captionParameter.value.trim();

  if (!lyrics) {
    return failure(
      'ace-step-lyrics-empty',
      'Enter Lyrics before generating a vocal Take.',
    );
  }

  if (
    lyrics !== lyricsParameter.value ||
    lyrics.includes('\0') ||
    lyrics.length > ACE_STEP_LYRICS_MAX_LENGTH ||
    new TextEncoder().encode(lyrics).byteLength > ACE_STEP_LYRICS_MAX_UTF8_BYTES
  ) {
    return failure(
      'ace-step-lyrics-invalid',
      'Lyrics must be trimmed text within 4,096 characters and 16 KiB UTF-8.',
    );
  }

  if (
    !caption ||
    caption !== captionParameter.value ||
    caption.length > ACE_STEP_CAPTION_MAX_LENGTH
  ) {
    return failure(
      'ace-step-caption-invalid',
      'Caption must be trimmed text within 2,000 characters.',
    );
  }

  const vocalLanguage = parseVocalLanguage(languageParameter.value);

  if (!vocalLanguage) {
    return failure(
      'ace-step-language-invalid',
      'Language must be English, Japanese, or Unknown.',
    );
  }

  if (
    !Number.isSafeInteger(seedParameter.value) ||
    seedParameter.value < 0 ||
    seedParameter.value > 0xffff_ffff
  ) {
    return failure(
      'ace-step-seed-invalid',
      'Seed must be an integer between 0 and 4294967295.',
    );
  }

  return Object.freeze({
    canResolve: true as const,
    settings: Object.freeze({
      caption,
      lyrics,
      seed: seedParameter.value,
      vocalLanguage,
      vocalLanguageLabel: languageParameter.value,
    }),
  });
}

export function prepareAceStepPatchTabRun(
  project: ProjectState,
  patchTab: PatchTab | undefined,
  selectedClipId: string | undefined,
): AceStepPatchTabPreparation {
  const settingsResolution = resolveAceStepPatchTabSettings(patchTab);

  if (!settingsResolution.canResolve) {
    return Object.freeze({
      canPrepare: false as const,
      cause: settingsResolution.cause,
      message: settingsResolution.message,
    });
  }

  if (!selectedClipId) {
    return Object.freeze({
      canPrepare: false as const,
      cause: 'ace-step-target-missing',
      message: 'Select one finalized SA3 T2A Guide or existing Vocal Audio Clip before generation.',
    });
  }

  const selectedClips = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => clip.id === selectedClipId),
  );

  if (selectedClips.length !== 1) {
    return Object.freeze({
      canPrepare: false as const,
      cause: 'ace-step-target-invalid',
      message: 'Select one finalized SA3 T2A Guide or existing Vocal Audio Clip before generation.',
    });
  }

  const selectedClip = selectedClips[0];

  if (selectedClip.type === 'ai-fill-audio') {
    const guide = resolveAceStepTextToAudioGuide(project, selectedClip.id);

    if (!guide.canResolve) {
      return Object.freeze({
        canPrepare: false as const,
        cause: 'ace-step-guide-invalid',
        message: guide.message,
      });
    }

    return Object.freeze({
      canPrepare: true as const,
      guide: Object.freeze({
        ...guide,
        guideClipName: selectedClip.name,
      }),
      mode: 'stable-audio-3-text-to-audio' as const,
      settings: settingsResolution.settings,
    });
  }

  if (selectedClip.type !== 'vocal-audio') {
    return Object.freeze({
      canPrepare: false as const,
      cause: 'ace-step-target-invalid',
      message: 'Select one finalized SA3 T2A Guide or existing Vocal Audio Clip before generation.',
    });
  }

  const target = resolveAceStepVocalTarget(project, selectedClipId);

  if (!target.canResolve) {
    return Object.freeze({
      canPrepare: false as const,
      cause: 'ace-step-target-invalid',
      message:
        'Selected Vocal Clip requires Active Vocal, Guide Audio, and corrected MIDI Takes.',
    });
  }

  return Object.freeze({
    canPrepare: true as const,
    mode: 'existing-vocal' as const,
    settings: settingsResolution.settings,
    target,
  });
}

export function createAceStepTextToAudioVocalTarget(
  project: ProjectState,
  identityToken: string,
  createdAt: string,
): AceStepTextToAudioVocalTargetResolution {
  const normalizedToken = identityToken
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalizedToken || Number.isNaN(Date.parse(createdAt))) {
    return Object.freeze({
      canCreate: false as const,
      message: 'ACE Vocals target identity is invalid.',
    });
  }

  const usedIds = new Set([
    ...project.tracks.map((track) => track.id),
    ...project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  ]);
  const trackId = createUniqueTargetId(
    usedIds,
    `ace-vocals-${normalizedToken}-track`,
  );
  usedIds.add(trackId);
  const clipId = createUniqueTargetId(
    usedIds,
    `ace-vocals-${normalizedToken}-clip`,
  );

  return Object.freeze({
    canCreate: true as const,
    target: Object.freeze({
      clipId,
      clipName: 'ACE Vocal',
      createdAt,
      trackId,
      trackName: 'ACE Vocals',
    }),
  });
}

export function createAceStepPatchTabModelSummary(): string {
  return `${ACE_STEP_MODEL_ID} / ${ACE_STEP_MODEL_REVISION.slice(0, 7)} / ${ACE_STEP_UPSTREAM_TASK_TYPE.toUpperCase()} ${ACE_STEP_TASK_ID}`;
}

function requireAceStepDefinition(): PatchTabDefinition {
  const definition = getBuiltinPatchTabDefinitions().find(
    (candidate) => candidate.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.aceStep,
  );

  if (!definition) {
    throw new Error('ACE-Step PatchTab definition is unavailable.');
  }

  return definition;
}

function findParameter<Kind extends PatchTabParameter['kind']>(
  patchTab: PatchTab,
  id: string,
  kind: Kind,
): Extract<PatchTabParameter, { kind: Kind }> | undefined {
  const matches = patchTab.parameters.filter(
    (parameter) => parameter.id === id && parameter.kind === kind,
  );

  return matches.length === 1
    ? (matches[0] as Extract<PatchTabParameter, { kind: Kind }>)
    : undefined;
}

function parseVocalLanguage(value: string): string | undefined {
  return VOCAL_LANGUAGE_BY_OPTION[
    value as keyof typeof VOCAL_LANGUAGE_BY_OPTION
  ];
}

function failure(
  cause: string,
  message: string,
): Extract<AceStepPatchTabSettingsResolution, { canResolve: false }> {
  return Object.freeze({ canResolve: false as const, cause, message });
}

function createUniqueTargetId(
  usedIds: ReadonlySet<string>,
  baseId: string,
): string {
  if (!usedIds.has(baseId)) {
    return baseId;
  }

  let suffix = 2;

  while (usedIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }

  return `${baseId}-${suffix}`;
}
