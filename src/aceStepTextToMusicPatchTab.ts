import {
  ACE_STEP_MAX_DURATION_SECONDS,
  ACE_STEP_MIN_DURATION_SECONDS,
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_PROVIDER_PACKAGE_VERSION,
  ACE_STEP_RUNTIME_PROFILE_ID,
  ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
} from '../shared/aceStepProtocol.js';
import {
  AUDIO_GENERATION_REGION_MAX_BARS,
  AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS,
  AUDIO_GENERATION_REGION_TICKS_PER_BAR,
} from './audioGenerationRegion';
import {
  createAceStepTextToMusicJobRequest,
  type AceStepTextToMusicJobRequest,
} from './aceStepTextToMusicJobContract';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
} from './patchTabPortContract';
import {
  createStableAudio3TextToAudioOutputPlan,
  type StableAudio3TextToAudioGenerationPosition,
  type StableAudio3TextToAudioOutputPlan,
} from './stableAudio3TextToAudioOutput';
import type { PatchTab, PatchTabDefinition, PatchTabParameter, ProjectState } from './types';

export const ACE_STEP_TEXT_TO_MUSIC_PATCH_TAB_TEMPLATE_ID = 'ace-step-t2m' as const;

export type AceStepTextToMusicMode = 'instrumental' | 'vocals';

export type AceStepTextToMusicSettings = Readonly<{
  bars: number;
  bpm: number;
  caption: string;
  durationSeconds: number;
  generationPosition: StableAudio3TextToAudioGenerationPosition;
  instrumental: boolean;
  keyscale: string;
  lyrics: string;
  lyricsSnapshotText: string;
  maxBars: number;
  mode: AceStepTextToMusicMode;
  seed: number;
  takes: number;
  vocalLanguage: string;
}>;

export type AceStepTextToMusicJobPlan = Readonly<{
  kind: 'local-engine-gpu-job';
  output: StableAudio3TextToAudioOutputPlan;
  request: AceStepTextToMusicJobRequest;
  runtime: Readonly<{
    profileId: typeof ACE_STEP_RUNTIME_PROFILE_ID;
    providerVersion: typeof ACE_STEP_PROVIDER_PACKAGE_VERSION;
    supportsCancellation: true;
  }>;
}>;

export type AceStepTextToMusicPreparation =
  | Readonly<{
      canPrepare: true;
      plans: readonly AceStepTextToMusicJobPlan[];
      recipeFingerprint: string;
      sourceParameterFingerprint: string;
      target:
        | Readonly<{ kind: 'append'; outputClipId: string }>
        | Readonly<{ kind: 'new' }>;
    }>
  | Readonly<{ canPrepare: false; cause: string; message: string }>;

export function createAceStepTextToMusicPatchTabTemplate(colorIndex = 0): PatchTab {
  const definition = requireDefinition();

  return {
    id: ACE_STEP_TEXT_TO_MUSIC_PATCH_TAB_TEMPLATE_ID,
    name: 'ACE T2M',
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
    portContractSnapshot: definition,
    inputBindings: [],
    colorIndex,
    inputType: 'Text',
    outputType: 'Generated Audio',
    status: 'ready',
    description:
      'Generates traceable 48 kHz music Takes from a Prompt and optional Lyrics. Advanced model controls remain fixed in v0.1.',
    parameters: [
      {
        id: 'prompt',
        label: 'Prompt',
        kind: 'text',
        value: '',
        maxLength: 2_000,
        multiline: true,
        placeholder: 'Describe genre, instruments, mood, and arrangement.',
      },
      {
        id: 'mode',
        label: 'Mode',
        kind: 'select',
        value: 'Instrumental',
        options: ['Instrumental', 'Vocals'],
      },
      {
        id: 'lyrics',
        label: 'Lyrics',
        kind: 'text',
        value: '',
        maxLength: 4_096,
        multiline: true,
        placeholder: 'Required in Vocals mode. Section tags such as [Verse] are supported.',
      },
      {
        id: 'language',
        label: 'Language',
        kind: 'select',
        value: 'Unknown',
        options: ['Unknown', 'Japanese', 'English'],
      },
      {
        id: 'bars',
        label: 'Bars',
        kind: 'number',
        min: 1,
        max: AUDIO_GENERATION_REGION_MAX_BARS,
        step: 1,
        value: 8,
        unit: 'Bars',
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
        value: 42,
      },
      {
        id: 'takes',
        label: 'Takes',
        kind: 'number',
        min: 1,
        max: 3,
        step: 1,
        value: 1,
      },
    ],
  };
}

export function isAceStepTextToMusicPatchTab(patchTab: PatchTab | undefined): boolean {
  return patchTab?.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.aceStepTextToMusic;
}

export function resolveAceStepTextToMusicSettings(
  project: ProjectState,
  patchTab: PatchTab | undefined,
):
  | Readonly<{ canResolve: true; settings: AceStepTextToMusicSettings }>
  | Readonly<{ canResolve: false; cause: string; message: string }> {
  if (!patchTab || !isAceStepTextToMusicPatchTab(patchTab)) {
    return failure('ace-step-t2m-patchtab-invalid', 'ACE T2M requires its dedicated PatchTab.');
  }

  const prompt = findParameter(patchTab, 'prompt', 'text')?.value.trim();
  const modeValue = findParameter(patchTab, 'mode', 'select')?.value;
  const lyrics = findParameter(patchTab, 'lyrics', 'text')?.value.trim();
  const languageValue = findParameter(patchTab, 'language', 'select')?.value;
  const bars = findParameter(patchTab, 'bars', 'number')?.value;
  const positionValue = findParameter(patchTab, 'generationPosition', 'select')?.value;
  const seed = findParameter(patchTab, 'seed', 'number')?.value;
  const takes = findParameter(patchTab, 'takes', 'number')?.value;

  if (!prompt || prompt.length > 2_000) {
    return failure('ace-step-t2m-prompt-invalid', 'Prompt must contain a musical description within 2000 characters.');
  }

  const mode = modeValue === 'Instrumental' ? 'instrumental' : modeValue === 'Vocals' ? 'vocals' : undefined;
  const generationPosition =
    positionValue === 'Playhead'
      ? 'playhead'
      : positionValue === 'Timeline Start'
        ? 'timeline-start'
        : undefined;
  const vocalLanguage =
    languageValue === 'Unknown'
      ? 'unknown'
      : languageValue === 'Japanese'
        ? 'ja'
        : languageValue === 'English'
          ? 'en'
          : undefined;

  if (!mode || !generationPosition || !vocalLanguage) {
    return failure('ace-step-t2m-mode-invalid', 'Mode, Language, or Generation Position is invalid.');
  }

  if (mode === 'vocals' && !lyrics) {
    return failure('ace-step-t2m-lyrics-empty', 'Lyrics are required in Vocals mode.');
  }

  if ((lyrics?.length ?? 0) > 4_096) {
    return failure('ace-step-t2m-lyrics-too-long', 'Lyrics must be within 4096 characters.');
  }

  if (
    !Number.isSafeInteger(bars) ||
    (bars as number) < 1 ||
    !Number.isSafeInteger(seed) ||
    (seed as number) < 0 ||
    (seed as number) > 0xffff_ffff ||
    !Number.isSafeInteger(takes) ||
    (takes as number) < 1 ||
    (takes as number) > 3
  ) {
    return failure('ace-step-t2m-numeric-invalid', 'Bars, Seed, or Takes is outside the supported range.');
  }

  if (
    !Number.isFinite(project.bpm) ||
    project.bpm < 20 ||
    project.bpm > 300 ||
    !project.key.trim() ||
    project.key.trim() !== project.key ||
    !Number.isSafeInteger(project.totalTicks) ||
    project.totalTicks <= 0 ||
    project.totalTicks > AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS ||
    !Number.isSafeInteger(project.playheadTick) ||
    project.playheadTick < 0 ||
    project.playheadTick > project.totalTicks
  ) {
    return failure('ace-step-t2m-project-context-invalid', 'ACE T2M requires valid Tempo, Key, Playhead, and Timeline context.');
  }

  const startTick = generationPosition === 'playhead' ? project.playheadTick : 0;
  const providerMaxBars = Math.floor((ACE_STEP_MAX_DURATION_SECONDS * project.bpm) / 240);
  const timelineMaxBars = Math.floor(
    (AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS - startTick) /
      AUDIO_GENERATION_REGION_TICKS_PER_BAR,
  );
  const maxBars = Math.min(AUDIO_GENERATION_REGION_MAX_BARS, providerMaxBars, timelineMaxBars);
  const durationSeconds = ((bars as number) * 240) / project.bpm;

  if ((bars as number) > maxBars || durationSeconds < ACE_STEP_MIN_DURATION_SECONDS) {
    return failure(
      'ace-step-t2m-duration-invalid',
      `Bars must resolve to ${ACE_STEP_MIN_DURATION_SECONDS}-${ACE_STEP_MAX_DURATION_SECONDS} seconds and fit the Timeline. Current duration is ${durationSeconds.toFixed(1)} seconds.`,
    );
  }

  return Object.freeze({
    canResolve: true as const,
    settings: Object.freeze({
      bars: bars as number,
      bpm: project.bpm,
      caption: prompt,
      durationSeconds,
      generationPosition,
      instrumental: mode === 'instrumental',
      keyscale: project.key,
      lyrics: lyrics ?? '',
      lyricsSnapshotText: mode === 'instrumental' ? '[Instrumental]' : (lyrics as string),
      maxBars,
      mode,
      seed: seed as number,
      takes: takes as number,
      vocalLanguage,
    }),
  });
}

export function prepareAceStepTextToMusicRun(
  project: ProjectState,
  patchTab: PatchTab | undefined,
  input: Readonly<{
    createdAt: string;
    lyricsArtifactId: string;
    lyricsRelativePath: string;
    requestToken: string;
  }>,
): AceStepTextToMusicPreparation {
  const resolution = resolveAceStepTextToMusicSettings(project, patchTab);

  if (!resolution.canResolve || !patchTab) {
    return failure(
      resolution.canResolve ? 'ace-step-t2m-patchtab-missing' : resolution.cause,
      resolution.canResolve ? 'ACE T2M PatchTab is unavailable.' : resolution.message,
    );
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.requestToken)) {
    return failure('ace-step-t2m-request-token-invalid', 'ACE T2M request identity is invalid.');
  }

  const settings = resolution.settings;
  const recipeFingerprint = createRecipeFingerprint(project, settings);
  const target = resolveContinuationTarget(project, patchTab, recipeFingerprint);

  if (!target.ok) {
    return failure(target.cause, target.message);
  }

  const plans: AceStepTextToMusicJobPlan[] = [];

  for (let index = 0; index < settings.takes; index += 1) {
    const seed = (settings.seed + index) % 0x1_0000_0000;
    const output = createStableAudio3TextToAudioOutputPlan(project, {
      bars: settings.bars,
      createdAt: input.createdAt,
      generationPosition: settings.generationPosition,
      outputClipId: `ace-t2m-clip-${input.requestToken}`,
      outputClipName: 'ACE Music',
      outputTrackId: `ace-t2m-track-${input.requestToken}`,
      outputTrackName: 'ACE Music',
    });

    if (!output.canPlan) {
      return failure(output.cause, output.message);
    }

    let request: AceStepTextToMusicJobRequest;

    try {
      request = createAceStepTextToMusicJobRequest({
        bpm: settings.bpm,
        caption: settings.caption,
        durationSeconds: settings.durationSeconds,
        instrumental: settings.instrumental,
        keyscale: settings.keyscale,
        lyricsArtifactId: input.lyricsArtifactId,
        lyricsRelativePath: input.lyricsRelativePath,
        seed,
        vocalLanguage: settings.vocalLanguage,
      });
    } catch (error) {
      return failure(
        'ace-step-t2m-request-invalid',
        error instanceof Error ? error.message : 'ACE T2M request is invalid.',
      );
    }

    plans.push(Object.freeze({
      kind: 'local-engine-gpu-job' as const,
      output: output.plan,
      request,
      runtime: Object.freeze({
        profileId: ACE_STEP_RUNTIME_PROFILE_ID,
        providerVersion: ACE_STEP_PROVIDER_PACKAGE_VERSION,
        supportsCancellation: true as const,
      }),
    }));
  }

  return Object.freeze({
    canPrepare: true as const,
    plans: Object.freeze(plans),
    recipeFingerprint,
    sourceParameterFingerprint: JSON.stringify(patchTab.parameters),
    target: target.target,
  });
}

function resolveContinuationTarget(
  project: ProjectState,
  patchTab: PatchTab,
  recipeFingerprint: string,
):
  | Readonly<{ ok: true; target: Readonly<{ kind: 'append'; outputClipId: string }> | Readonly<{ kind: 'new' }> }>
  | Readonly<{ cause: string; message: string; ok: false }> {
  const continuation = patchTab.generationContinuation;

  if (
    !continuation ||
    continuation.kind !== 'ace-step-text-to-music' ||
    continuation.recipeFingerprint !== recipeFingerprint
  ) {
    return Object.freeze({ ok: true as const, target: Object.freeze({ kind: 'new' as const }) });
  }

  const matches = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => clip.id === continuation.outputClipId),
  );

  if (matches.length === 0) {
    return Object.freeze({ ok: true as const, target: Object.freeze({ kind: 'new' as const }) });
  }

  if (matches.length !== 1 || matches[0].type !== 'ai-fill-audio' || !matches[0].clipTakes?.length) {
    return Object.freeze({
      cause: 'ace-step-t2m-continuation-invalid',
      message: 'The tracked ACE T2M output Clip is no longer a valid Take target.',
      ok: false as const,
    });
  }

  return Object.freeze({
    ok: true as const,
    target: Object.freeze({ kind: 'append' as const, outputClipId: continuation.outputClipId }),
  });
}

function createRecipeFingerprint(project: ProjectState, settings: AceStepTextToMusicSettings): string {
  return JSON.stringify({
    bars: settings.bars,
    bpm: settings.bpm,
    caption: settings.caption,
    generationPosition: settings.generationPosition,
    instrumental: settings.instrumental,
    keyscale: settings.keyscale,
    lyrics: settings.lyricsSnapshotText,
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    resolvedStartTick: settings.generationPosition === 'playhead' ? project.playheadTick : 0,
    taskId: ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
    vocalLanguage: settings.vocalLanguage,
  });
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

function requireDefinition(): PatchTabDefinition {
  const definition = getBuiltinPatchTabDefinitions().find(
    (candidate) =>
      candidate.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.aceStepTextToMusic,
  );

  if (!definition) {
    throw new Error('ACE T2M PatchTab definition is unavailable.');
  }

  return definition;
}

function failure(cause: string, message: string) {
  return Object.freeze({ canPrepare: false as const, canResolve: false as const, cause, message });
}
