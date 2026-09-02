import {
  STABLE_AUDIO_3_MAX_DURATION_SECONDS,
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import {
  AUDIO_GENERATION_REGION_MAX_BARS,
  AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS,
  AUDIO_GENERATION_REGION_TICKS_PER_BAR,
} from './audioGenerationRegion';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import {
  CURRENT_STABLE_AUDIO_3_TEXT_TO_AUDIO_RUNTIME_CAPABILITY,
  resolveStableAudio3TextToAudioCapability,
  type StableAudio3TextToAudioJobPlan,
} from './stableAudio3TextToAudioCapability';
import type { StableAudio3TextToAudioGenerationPosition } from './stableAudio3TextToAudioOutput';
import {
  createStableAudio3SeedSequence,
  isStableAudio3TakeCount,
} from './stableAudio3SeedVariations';
import type { PatchTab, PatchTabParameter, ProjectState } from './types';

const MANAGED_TIMELINE_CONTEXT_PREFIX = '[Timeline Context]';
const PROMPT_MAX_LENGTH = 2_000;

export type StableAudio3TextToAudioPatchTabSettings = Readonly<{
  bars: number;
  durationSeconds: number;
  generationPosition: StableAudio3TextToAudioGenerationPosition;
  managedPrompt: string;
  maxBars: number;
  prompt: string;
  seed: number;
  takes: number;
  timelineContext: string;
}>;

export type StableAudio3TextToAudioPatchTabSettingsResolution =
  | Readonly<{
      canResolve: true;
      settings: StableAudio3TextToAudioPatchTabSettings;
    }>
  | Readonly<{
      canResolve: false;
      cause: string;
      message: string;
    }>;

export type StableAudio3TextToAudioPatchTabPreparation =
  | Readonly<{
      canPrepare: true;
      managedPrompt: string;
      plan: StableAudio3TextToAudioJobPlan;
      plans: readonly StableAudio3TextToAudioJobPlan[];
      recipeFingerprint: string;
      seedSequence: readonly number[];
      sourceParameterFingerprint: string;
      target:
        | Readonly<{ kind: 'append'; outputClipId: string }>
        | Readonly<{ kind: 'new' }>;
    }>
  | Readonly<{
      canPrepare: false;
      cause: string;
      message: string;
    }>;

export type StableAudio3TextToAudioManagedPromptUpdate =
  | Readonly<{ applied: true; project: ProjectState }>
  | Readonly<{
      applied: false;
      cause: string;
      message: string;
    }>;

export function isStableAudio3TextToAudioPatchTab(
  patchTab: PatchTab | undefined,
): boolean {
  return (
    patchTab?.nodeTypeId ===
    BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio
  );
}

export function resolveStableAudio3TextToAudioPatchTabSettings(
  project: ProjectState,
  patchTab: PatchTab | undefined,
): StableAudio3TextToAudioPatchTabSettingsResolution {
  if (!patchTab || !isStableAudio3TextToAudioPatchTab(patchTab)) {
    return failure(
      'stable-audio-3-t2a-patchtab-invalid',
      'SA3 T2A requires the dedicated source-free PatchTab.',
    );
  }

  const promptParameter = findParameter(patchTab, 'prompt', 'text');
  const barsParameter = findParameter(patchTab, 'bars', 'number');
  const positionParameter = findParameter(
    patchTab,
    'generationPosition',
    'select',
  );
  const seedParameter = findParameter(patchTab, 'seed', 'number');
  const takesParameter = findParameter(patchTab, 'takes', 'number');

  if (
    !promptParameter ||
    !barsParameter ||
    !positionParameter ||
    !seedParameter ||
    !takesParameter
  ) {
    return failure(
      'stable-audio-3-t2a-parameters-invalid',
      'SA3 T2A PatchTab parameters are incomplete or invalid.',
    );
  }

  const prompt = stripManagedTimelineContext(promptParameter.value).trim();

  if (!prompt) {
    return failure(
      'stable-audio-3-t2a-prompt-empty',
      'Prompt must contain a musical description.',
    );
  }

  if (!Number.isSafeInteger(barsParameter.value) || barsParameter.value < 1) {
    return failure(
      'stable-audio-3-t2a-bars-invalid',
      'Bars must be a positive whole number.',
    );
  }

  if (
    !Number.isSafeInteger(seedParameter.value) ||
    seedParameter.value < 0 ||
    seedParameter.value > 0xffff_ffff
  ) {
    return failure(
      'stable-audio-3-t2a-seed-invalid',
      'Seed must be an integer between 0 and 4294967295.',
    );
  }

  if (!isStableAudio3TakeCount(takesParameter.value)) {
    return failure(
      'stable-audio-3-t2a-takes-invalid',
      'Takes must be an integer between 1 and 3.',
    );
  }

  const generationPosition = parseGenerationPosition(positionParameter.value);

  if (!generationPosition) {
    return failure(
      'stable-audio-3-t2a-position-invalid',
      'Generation Position must be Playhead or Timeline Start.',
    );
  }

  if (
    !Number.isFinite(project.bpm) ||
    project.bpm <= 0 ||
    !Number.isSafeInteger(project.totalTicks) ||
    project.totalTicks <= 0 ||
    project.totalTicks > AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS ||
    !Number.isSafeInteger(project.playheadTick) ||
    project.playheadTick < 0 ||
    project.playheadTick > project.totalTicks ||
    typeof project.key !== 'string' ||
    !project.key.trim() ||
    project.key.trim() !== project.key
  ) {
    return failure(
      'stable-audio-3-t2a-project-context-invalid',
      'SA3 T2A requires valid Tempo, Key, Playhead, and Timeline context.',
    );
  }

  const startTick = generationPosition === 'playhead' ? project.playheadTick : 0;
  const providerMaxBars = Math.floor(
    (STABLE_AUDIO_3_MAX_DURATION_SECONDS * project.bpm) / (4 * 60),
  );
  const timelineMaxBars = Math.floor(
    (AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS - startTick) /
      AUDIO_GENERATION_REGION_TICKS_PER_BAR,
  );
  const maxBars = Math.min(
    AUDIO_GENERATION_REGION_MAX_BARS,
    providerMaxBars,
    timelineMaxBars,
  );

  if (barsParameter.value > maxBars) {
    return failure(
      'stable-audio-3-t2a-bars-out-of-range',
      `Bars exceeds the current limit of ${maxBars} at ${formatNumber(project.bpm)} BPM and the selected Generation Position.`,
    );
  }

  const durationSeconds = (barsParameter.value * 4 * 60) / project.bpm;
  const timelineContext = createManagedTimelineContext({
    bars: barsParameter.value,
    bpm: project.bpm,
    key: project.key,
  });
  const managedPrompt = `${prompt}\n${timelineContext}`;

  if (managedPrompt.length > PROMPT_MAX_LENGTH) {
    return failure(
      'stable-audio-3-t2a-prompt-too-long',
      `Prompt plus Timeline Context must be within ${PROMPT_MAX_LENGTH} characters.`,
    );
  }

  return Object.freeze({
    canResolve: true as const,
    settings: Object.freeze({
      bars: barsParameter.value,
      durationSeconds,
      generationPosition,
      managedPrompt,
      maxBars,
      prompt,
      seed: seedParameter.value,
      takes: takesParameter.value,
      timelineContext,
    }),
  });
}

export function prepareStableAudio3TextToAudioPatchTabRun(
  project: ProjectState,
  patchTab: PatchTab | undefined,
  input: Readonly<{ createdAt: string; requestToken: string }>,
): StableAudio3TextToAudioPatchTabPreparation {
  const settingsResolution =
    resolveStableAudio3TextToAudioPatchTabSettings(project, patchTab);

  if (!settingsResolution.canResolve || !patchTab) {
    return Object.freeze({
      canPrepare: false as const,
      cause: settingsResolution.canResolve
        ? 'stable-audio-3-t2a-patchtab-missing'
        : settingsResolution.cause,
      message: settingsResolution.canResolve
        ? 'SA3 T2A PatchTab is unavailable.'
        : settingsResolution.message,
    });
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.requestToken)) {
    return Object.freeze({
      canPrepare: false as const,
      cause: 'stable-audio-3-t2a-request-token-invalid',
      message: 'SA3 T2A request identity is invalid.',
    });
  }

  const settings = settingsResolution.settings;
  const seedSequence = createStableAudio3SeedSequence(
    settings.seed,
    settings.takes,
  );
  const recipeFingerprint = createRecipeFingerprint(project, settings);
  const targetResolution = resolveContinuationTarget(
    project,
    patchTab,
    recipeFingerprint,
    seedSequence,
  );

  if (!targetResolution.ok) {
    return Object.freeze({
      canPrepare: false as const,
      cause: targetResolution.cause,
      message: targetResolution.message,
    });
  }

  const plans: StableAudio3TextToAudioJobPlan[] = [];

  for (const seed of seedSequence) {
    const capability = resolveStableAudio3TextToAudioCapability(
      project,
      {
        execution: {
          modelId: STABLE_AUDIO_3_MODEL_ID,
          modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
          providerId: STABLE_AUDIO_3_PROVIDER_ID,
          taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
        },
        output: {
          bars: settings.bars,
          createdAt: input.createdAt,
          generationPosition: settings.generationPosition,
          outputClipId: `sa3-t2a-clip-${input.requestToken}`,
          outputClipName: 'Generated Audio',
          outputTrackId: `sa3-t2a-track-${input.requestToken}`,
          outputTrackName: 'Generated Audio',
        },
        prompt: settings.managedPrompt,
        seed,
      },
      CURRENT_STABLE_AUDIO_3_TEXT_TO_AUDIO_RUNTIME_CAPABILITY,
    );

    if (!capability.canEnqueue) {
      return Object.freeze({
        canPrepare: false as const,
        cause: capability.cause,
        message: capability.message,
      });
    }

    plans.push(capability.plan);
  }

  const plan = plans[0];

  if (!plan) {
    return Object.freeze({
      canPrepare: false as const,
      cause: 'stable-audio-3-t2a-plan-empty',
      message: 'SA3 T2A requires at least one Take plan.',
    });
  }

  return Object.freeze({
    canPrepare: true as const,
    managedPrompt: settings.managedPrompt,
    plan,
    plans: Object.freeze(plans),
    recipeFingerprint,
    seedSequence,
    sourceParameterFingerprint: createParameterFingerprint(patchTab),
    target: targetResolution.target,
  });
}

export function applyStableAudio3TextToAudioManagedPrompt(
  project: ProjectState,
  patchTabId: string,
  expectedParameterFingerprint: string,
  managedPrompt: string,
  continuation?: Readonly<{
    outputClipId: string;
    recipeFingerprint: string;
  }>,
): StableAudio3TextToAudioManagedPromptUpdate {
  const patchTab = project.patchTabs.find((candidate) => candidate.id === patchTabId);

  if (!patchTab || !isStableAudio3TextToAudioPatchTab(patchTab)) {
    return Object.freeze({
      applied: false as const,
      cause: 'stable-audio-3-t2a-patchtab-stale',
      message:
        'SA3 T2A WAV finalized, but its source PatchTab no longer exists.',
    });
  }

  if (createParameterFingerprint(patchTab) !== expectedParameterFingerprint) {
    return Object.freeze({
      applied: false as const,
      cause: 'stable-audio-3-t2a-parameters-stale',
      message:
        'SA3 T2A WAV finalized, but its source PatchTab parameters changed before settlement.',
    });
  }

  const promptParameter = findParameter(patchTab, 'prompt', 'text');

  if (!promptParameter) {
    return Object.freeze({
      applied: false as const,
      cause: 'stable-audio-3-t2a-prompt-stale',
      message:
        'SA3 T2A WAV finalized, but its Prompt parameter is unavailable.',
    });
  }

  const nextPatchTab: PatchTab = {
    ...patchTab,
    ...(continuation
      ? {
          generationContinuation: {
            kind: 'stable-audio-3-text-to-audio' as const,
            outputClipId: continuation.outputClipId,
            recipeFingerprint: continuation.recipeFingerprint,
          },
        }
      : {}),
    parameters: patchTab.parameters.map((parameter) =>
      parameter === promptParameter
        ? { ...promptParameter, value: managedPrompt }
        : parameter,
    ),
  };

  return Object.freeze({
    applied: true as const,
    project: {
      ...project,
      patchTabs: project.patchTabs.map((candidate) =>
        candidate.id === patchTab.id ? nextPatchTab : candidate,
      ),
    },
  });
}

function createRecipeFingerprint(
  project: ProjectState,
  settings: StableAudio3TextToAudioPatchTabSettings,
): string {
  const resolvedStartTick =
    settings.generationPosition === 'playhead' ? project.playheadTick : 0;

  return JSON.stringify({
    bars: settings.bars,
    durationSeconds: settings.durationSeconds,
    generationPosition: settings.generationPosition,
    managedPrompt: settings.managedPrompt,
    modelId: STABLE_AUDIO_3_MODEL_ID,
    modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    resolvedStartTick,
    taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
  });
}

function resolveContinuationTarget(
  project: ProjectState,
  patchTab: PatchTab,
  recipeFingerprint: string,
  seedSequence: readonly number[],
):
  | Readonly<{
      ok: true;
      target:
        | Readonly<{ kind: 'append'; outputClipId: string }>
        | Readonly<{ kind: 'new' }>;
    }>
  | Readonly<{ cause: string; message: string; ok: false }> {
  const continuation = patchTab.generationContinuation;

  if (
    !continuation ||
    continuation.kind !== 'stable-audio-3-text-to-audio' ||
    continuation.recipeFingerprint !== recipeFingerprint
  ) {
    return Object.freeze({
      ok: true as const,
      target: Object.freeze({ kind: 'new' as const }),
    });
  }

  const matchingClips = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => clip.id === continuation.outputClipId),
  );

  if (matchingClips.length === 0) {
    return Object.freeze({
      ok: true as const,
      target: Object.freeze({ kind: 'new' as const }),
    });
  }

  const targetClip = matchingClips[0];

  if (
    matchingClips.length !== 1 ||
    targetClip.type !== 'ai-fill-audio' ||
    !targetClip.clipTakes?.length
  ) {
    return Object.freeze({
      cause: 'stable-audio-3-t2a-continuation-invalid',
      message: 'The tracked SA3 T2A output Clip is no longer a valid Take target.',
      ok: false as const,
    });
  }

  const artifactsById = new Map(
    (project.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact]),
  );
  const existingSeeds = new Set<number>();

  for (const take of targetClip.clipTakes) {
    const artifact = artifactsById.get(take.artifactId);

    if (
      take.mediaType !== 'audio' ||
      take.sourceType !== 'job' ||
      !artifact ||
      artifact.kind !== 'audio' ||
      artifact.destination !== 'stable-audio-3' ||
      artifact.provenance.providerId !== STABLE_AUDIO_3_PROVIDER_ID ||
      artifact.provenance.modelId !== STABLE_AUDIO_3_MODEL_ID ||
      artifact.provenance.modelRevision !== STABLE_AUDIO_3_MODEL_REVISION ||
      artifact.provenance.taskId !== STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID ||
      !Number.isSafeInteger(artifact.provenance.seed)
    ) {
      return Object.freeze({
        cause: 'stable-audio-3-t2a-continuation-provenance-invalid',
        message: 'The tracked SA3 T2A output Clip contains an incompatible Take.',
        ok: false as const,
      });
    }

    existingSeeds.add(artifact.provenance.seed as number);
  }

  const duplicateSeed = seedSequence.find((seed) => existingSeeds.has(seed));

  if (duplicateSeed !== undefined) {
    return Object.freeze({
      cause: 'stable-audio-3-t2a-seed-duplicate',
      message: `Seed ${duplicateSeed} already exists in the tracked SA3 T2A Clip. Choose a different Seed.`,
      ok: false as const,
    });
  }

  return Object.freeze({
    ok: true as const,
    target: Object.freeze({
      kind: 'append' as const,
      outputClipId: continuation.outputClipId,
    }),
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

function parseGenerationPosition(
  value: string,
): StableAudio3TextToAudioGenerationPosition | undefined {
  if (value === 'Playhead') {
    return 'playhead';
  }

  return value === 'Timeline Start' ? 'timeline-start' : undefined;
}

function stripManagedTimelineContext(prompt: string): string {
  return prompt
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(MANAGED_TIMELINE_CONTEXT_PREFIX))
    .join('\n')
    .trim();
}

function createManagedTimelineContext(input: Readonly<{
  bars: number;
  bpm: number;
  key?: string;
}>): string {
  const key = input.key?.trim();

  return `${MANAGED_TIMELINE_CONTEXT_PREFIX} Tempo: ${formatNumber(input.bpm)} BPM | Bars: ${input.bars}${key ? ` | Key: ${key}` : ''}`;
}

function createParameterFingerprint(patchTab: PatchTab): string {
  return JSON.stringify(patchTab.parameters);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function failure(
  cause: string,
  message: string,
): Extract<
  StableAudio3TextToAudioPatchTabSettingsResolution,
  { canResolve: false }
> {
  return Object.freeze({ canResolve: false as const, cause, message });
}
