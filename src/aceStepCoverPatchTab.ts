import {
  ACE_STEP_MAX_DURATION_SECONDS,
  ACE_STEP_MIN_DURATION_SECONDS,
  ACE_STEP_COVER_TASK_ID,
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PROVIDER_PACKAGE_VERSION,
  ACE_STEP_RUNTIME_PROFILE_ID,
} from '../shared/aceStepProtocol.js';
import {
  AUDIO_DURATION_EPSILON_SECONDS,
  secondsToTimelineTicks,
} from './audioClipTiming';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import {
  createAceStepCoverJobRequest,
  type AceStepCoverJobRequest,
} from './aceStepCoverJobContract';
import {
  createAceStepCoverOutputPlan,
  type AceStepCoverOutputPlan,
} from './aceStepCoverOutput';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
} from './patchTabPortContract';
import type { PatchTab, PatchTabDefinition, PatchTabParameter, ProjectState } from './types';

export const ACE_STEP_COVER_PATCH_TAB_TEMPLATE_ID = 'ace-step-cover' as const;

export type AceStepCoverSettings = Readonly<{
  caption: string;
  coverStrength: number;
  instrumental: boolean;
  lyrics: string;
  lyricsSnapshotText: string;
  mode: 'instrumental' | 'vocals';
  seed: number;
  source: Readonly<{
    artifactId: string;
    clipId: string;
    clipTakeId: string;
    durationSeconds: number;
    name: string;
    relativePath: string;
    sizeBytes: number;
  }>;
  takes: number;
  vocalLanguage: string;
}>;

export type AceStepCoverJobPlan = Readonly<{
  kind: 'local-engine-gpu-job';
  output: AceStepCoverOutputPlan;
  request: AceStepCoverJobRequest;
  runtime: Readonly<{
    profileId: typeof ACE_STEP_RUNTIME_PROFILE_ID;
    providerVersion: typeof ACE_STEP_PROVIDER_PACKAGE_VERSION;
    supportsCancellation: true;
  }>;
}>;

export type AceStepCoverPreparation =
  | Readonly<{
      canPrepare: true;
      plans: readonly AceStepCoverJobPlan[];
      recipeFingerprint: string;
      sourceFingerprint: string;
      sourceParameterFingerprint: string;
      target:
        | Readonly<{ kind: 'append'; outputClipId: string }>
        | Readonly<{ kind: 'new' }>;
    }>
  | Readonly<{ canPrepare: false; cause: string; message: string }>;

export type AceStepCoverPreflight =
  | Readonly<{ canPreflight: true }>
  | Readonly<{ canPreflight: false; cause: string; message: string }>;

export function createAceStepCoverPatchTabTemplate(colorIndex = 0): PatchTab {
  const definition = requireDefinition();

  return {
    id: ACE_STEP_COVER_PATCH_TAB_TEMPLATE_ID,
    name: 'ACE COVER',
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
    outputType: 'Generated Audio',
    status: 'ready',
    description:
      'Remixes one full Active Audio Take into traceable stereo 48 kHz Takes. Advanced controls remain fixed in v0.1.',
    parameters: [
      {
        id: 'prompt',
        label: 'Prompt',
        kind: 'text',
        value: 'A polished reinterpretation that preserves the source melody and structure',
        maxLength: 2_000,
        multiline: true,
        placeholder: 'Describe the target genre, sound, mood, and arrangement.',
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
        id: 'coverStrength',
        label: 'Cover Strength',
        kind: 'slider',
        min: 0,
        max: 1,
        step: 0.05,
        value: 0.2,
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

export function isAceStepCoverPatchTab(patchTab: PatchTab | undefined): boolean {
  return patchTab?.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.aceStepCover;
}

export function resolveAceStepCoverSettings(
  project: ProjectState,
  patchTab: PatchTab | undefined,
  selectedClipId: string | undefined,
):
  | Readonly<{ canResolve: true; settings: AceStepCoverSettings }>
  | Readonly<{ canResolve: false; cause: string; message: string }> {
  if (!patchTab || !isAceStepCoverPatchTab(patchTab)) {
    return failure('ace-step-cover-patchtab-invalid', 'ACE Cover requires its dedicated PatchTab.');
  }

  if (!selectedClipId) {
    return failure('ace-step-cover-source-missing', 'Select one Audio Clip with an Active Take.');
  }

  const continuation = patchTab.generationContinuation;
  const sourceClipId =
    continuation?.kind === 'ace-step-cover' &&
    continuation.outputClipId === selectedClipId
      ? continuation.sourceClipId
      : selectedClipId;

  const sourceResolution = resolveActiveAudioTakeSource(project, sourceClipId);

  if (!sourceResolution.canResolve) {
    return failure(`ace-step-cover-source-${sourceResolution.reason}`, sourceResolution.message);
  }

  const activeSource = sourceResolution.plan;
  const sourceDurationSeconds = activeSource.clip.sourceFile.durationSeconds;

  if (
    sourceDurationSeconds < ACE_STEP_MIN_DURATION_SECONDS ||
    sourceDurationSeconds > ACE_STEP_MAX_DURATION_SECONDS
  ) {
    return failure(
      'ace-step-cover-source-duration-invalid',
      `ACE Cover requires a ${ACE_STEP_MIN_DURATION_SECONDS}-${ACE_STEP_MAX_DURATION_SECONDS} second Active Take.`,
    );
  }

  if (
    activeSource.clip.audioTiming.sourceStartSeconds !== 0 ||
    Math.abs(
      activeSource.clip.audioTiming.sourceEndSeconds - sourceDurationSeconds,
    ) > AUDIO_DURATION_EPSILON_SECONDS ||
    activeSource.clip.lengthTicks !==
      secondsToTimelineTicks(sourceDurationSeconds, project.bpm)
  ) {
    return failure(
      'ace-step-cover-source-trimmed',
      'ACE Cover v0.1 requires one full, untrimmed Active Take. Bounce or select a full-length Clip before Remix.',
    );
  }

  const prompt = findParameter(patchTab, 'prompt', 'text')?.value.trim();
  const modeValue = findParameter(patchTab, 'mode', 'select')?.value;
  const lyrics = findParameter(patchTab, 'lyrics', 'text')?.value.trim();
  const languageValue = findParameter(patchTab, 'language', 'select')?.value;
  const coverStrength = findParameter(patchTab, 'coverStrength', 'slider')?.value;
  const seed = findParameter(patchTab, 'seed', 'number')?.value;
  const takes = findParameter(patchTab, 'takes', 'number')?.value;

  if (!prompt || prompt.length > 2_000) {
    return failure('ace-step-cover-prompt-invalid', 'Prompt must contain a musical description within 2000 characters.');
  }

  const mode = modeValue === 'Instrumental' ? 'instrumental' : modeValue === 'Vocals' ? 'vocals' : undefined;
  const vocalLanguage =
    languageValue === 'Unknown'
      ? 'unknown'
      : languageValue === 'Japanese'
        ? 'ja'
        : languageValue === 'English'
          ? 'en'
          : undefined;

  if (!mode || !vocalLanguage) {
    return failure('ace-step-cover-mode-invalid', 'Mode or Language is invalid.');
  }

  if (mode === 'vocals' && !lyrics) {
    return failure('ace-step-cover-lyrics-empty', 'Lyrics are required in Vocals mode.');
  }

  if ((lyrics?.length ?? 0) > 4_096) {
    return failure('ace-step-cover-lyrics-too-long', 'Lyrics must be within 4096 characters.');
  }

  if (
    typeof coverStrength !== 'number' ||
    !Number.isFinite(coverStrength) ||
    coverStrength < 0 ||
    coverStrength > 1 ||
    !Number.isSafeInteger(seed) ||
    (seed as number) < 0 ||
    (seed as number) > 0xffff_ffff ||
    !Number.isSafeInteger(takes) ||
    (takes as number) < 1 ||
    (takes as number) > 3
  ) {
    return failure('ace-step-cover-numeric-invalid', 'Cover Strength, Seed, or Takes is outside the supported range.');
  }

  const source = activeSource;

  return Object.freeze({
    canResolve: true as const,
    settings: Object.freeze({
      caption: prompt,
      coverStrength,
      instrumental: mode === 'instrumental',
      lyrics: lyrics ?? '',
      lyricsSnapshotText: mode === 'instrumental' ? '[Instrumental]' : (lyrics as string),
      mode,
      seed: seed as number,
      source: Object.freeze({
        artifactId: source.source.artifactId,
        clipId: source.source.clipId,
        clipTakeId: source.source.clipTakeId,
        durationSeconds: source.clip.sourceFile.durationSeconds,
        name: source.clip.name,
        relativePath: source.descriptor.relativePath,
        sizeBytes: source.descriptor.sizeBytes,
      }),
      takes: takes as number,
      vocalLanguage,
    }),
  });
}

export function prepareAceStepCoverRun(
  project: ProjectState,
  patchTab: PatchTab | undefined,
  selectedClipId: string | undefined,
  input: Readonly<{
    createdAt: string;
    lyricsArtifactId: string;
    lyricsRelativePath: string;
    requestToken: string;
  }>,
): AceStepCoverPreparation {
  const resolution = resolveAceStepCoverSettings(project, patchTab, selectedClipId);

  if (!resolution.canResolve || !patchTab) {
    return failure(
      resolution.canResolve ? 'ace-step-cover-patchtab-missing' : resolution.cause,
      resolution.canResolve ? 'ACE Cover PatchTab is unavailable.' : resolution.message,
    );
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.requestToken)) {
    return failure('ace-step-cover-request-token-invalid', 'ACE Cover request identity is invalid.');
  }

  const settings = resolution.settings;
  const outputIdentity = createAvailableOutputIdentity(project, input.requestToken);
  const outputResolution = createAceStepCoverOutputPlan(project, {
    createdAt: input.createdAt,
    outputClipId: outputIdentity.clipId,
    outputClipName: `${settings.source.name} Cover`,
    outputTrackId: outputIdentity.trackId,
    outputTrackName: 'ACE Cover',
    sourceClipId: settings.source.clipId,
  });

  if (!outputResolution.canPlan) {
    return failure(outputResolution.cause, outputResolution.message);
  }

  const recipeFingerprint = createRecipeFingerprint(settings);
  const target = resolveContinuationTarget(project, patchTab, recipeFingerprint, settings);

  if (!target.ok) {
    return failure(target.cause, target.message);
  }

  const plans: AceStepCoverJobPlan[] = [];

  for (let index = 0; index < settings.takes; index += 1) {
    let request: AceStepCoverJobRequest;

    try {
      request = createAceStepCoverJobRequest({
        caption: settings.caption,
        coverStrength: settings.coverStrength,
        durationSeconds: settings.source.durationSeconds,
        guideArtifactId: settings.source.artifactId,
        guideClipTakeId: settings.source.clipTakeId,
        guideRelativePath: settings.source.relativePath,
        guideSizeBytes: settings.source.sizeBytes,
        instrumental: settings.instrumental,
        lyricsArtifactId: input.lyricsArtifactId,
        lyricsRelativePath: input.lyricsRelativePath,
        seed: (settings.seed + index) % 0x1_0000_0000,
        vocalLanguage: settings.vocalLanguage,
      });
    } catch (error) {
      return failure(
        'ace-step-cover-request-invalid',
        error instanceof Error ? error.message : 'ACE Cover request is invalid.',
      );
    }

    plans.push(Object.freeze({
      kind: 'local-engine-gpu-job' as const,
      output: outputResolution.plan,
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
    sourceFingerprint: createSourceFingerprint(settings),
    sourceParameterFingerprint: JSON.stringify(patchTab.parameters),
    target: target.target,
  });
}

export function preflightAceStepCoverRun(
  project: ProjectState,
  patchTab: PatchTab | undefined,
  selectedClipId: string | undefined,
  input: Readonly<{ createdAt: string; requestToken: string }>,
): AceStepCoverPreflight {
  const preparation = prepareAceStepCoverRun(project, patchTab, selectedClipId, {
    ...input,
    lyricsArtifactId: 'artifact-ace-cover-preflight',
    lyricsRelativePath: 'renders/ace-step/lyrics/artifact-ace-cover-preflight.txt',
  });

  return preparation.canPrepare
    ? Object.freeze({ canPreflight: true as const })
    : Object.freeze({
        canPreflight: false as const,
        cause: preparation.cause,
        message: preparation.message,
      });
}

function createAvailableOutputIdentity(
  project: ProjectState,
  requestToken: string,
): Readonly<{ clipId: string; trackId: string }> {
  const trackIds = new Set(project.tracks.map((track) => track.id));
  const clipIds = new Set(
    project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  const maximumAttempts = trackIds.size + clipIds.size + 1;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const clipId = `ace-cover-clip-${requestToken}${suffix}`;
    const trackId = `ace-cover-track-${requestToken}${suffix}`;

    if (!clipIds.has(clipId) && !trackIds.has(trackId)) {
      return Object.freeze({ clipId, trackId });
    }
  }

  throw new Error('ACE Cover could not allocate a unique output identity.');
}

function resolveContinuationTarget(
  project: ProjectState,
  patchTab: PatchTab,
  recipeFingerprint: string,
  settings: AceStepCoverSettings,
):
  | Readonly<{ ok: true; target: Readonly<{ kind: 'append'; outputClipId: string }> | Readonly<{ kind: 'new' }> }>
  | Readonly<{ cause: string; message: string; ok: false }> {
  const continuation = patchTab.generationContinuation;

  if (
    !continuation ||
    continuation.kind !== 'ace-step-cover' ||
    continuation.recipeFingerprint !== recipeFingerprint ||
    continuation.sourceClipId !== settings.source.clipId ||
    continuation.sourceClipTakeId !== settings.source.clipTakeId
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
      cause: 'ace-step-cover-continuation-invalid',
      message: 'The tracked ACE Cover output Clip is no longer a valid Take target.',
      ok: false as const,
    });
  }

  return Object.freeze({
    ok: true as const,
    target: Object.freeze({ kind: 'append' as const, outputClipId: continuation.outputClipId }),
  });
}

function createRecipeFingerprint(settings: AceStepCoverSettings): string {
  return JSON.stringify({
    caption: settings.caption,
    coverStrength: settings.coverStrength,
    instrumental: settings.instrumental,
    lyrics: settings.lyricsSnapshotText,
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    sourceArtifactId: settings.source.artifactId,
    sourceClipId: settings.source.clipId,
    sourceClipTakeId: settings.source.clipTakeId,
    taskId: ACE_STEP_COVER_TASK_ID,
    vocalLanguage: settings.vocalLanguage,
  });
}

function createSourceFingerprint(settings: AceStepCoverSettings): string {
  return JSON.stringify(settings.source);
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
    (candidate) => candidate.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.aceStepCover,
  );

  if (!definition) {
    throw new Error('ACE Cover PatchTab definition is unavailable.');
  }

  return definition;
}

function failure(cause: string, message: string): Readonly<{
  canPrepare: false;
  canResolve: false;
  cause: string;
  message: string;
}> {
  return Object.freeze({
    canPrepare: false as const,
    canResolve: false as const,
    cause,
    message,
  });
}
