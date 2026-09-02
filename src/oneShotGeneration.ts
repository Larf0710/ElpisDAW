import {
  ACE_STEP_MAX_DURATION_SECONDS,
  ACE_STEP_MIN_DURATION_SECONDS,
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_TASK_ID,
} from '../shared/aceStepProtocol.js';
import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import { resolveAceStepPatchTabSettings } from './aceStepPatchTab';
import {
  runAceStepTextToAudioVocalStage,
  type AceStepVocalStageClient,
  type AceStepVocalStageOptions,
  type AceStepVocalStageResult,
} from './aceStepVocalStage';
import { activateClipTake } from './clipTakeActivation';
import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
  getPatchTabConnectionCompatibility,
} from './patchTabPortContract';
import {
  createSessionEditHistory,
  type SessionEditEntry,
} from './sessionEditHistory';
import {
  applyStableAudio3TextToAudioManagedPrompt,
  prepareStableAudio3TextToAudioPatchTabRun,
} from './stableAudio3TextToAudioPatchTab';
import {
  runStableAudio3TextToAudioPlan,
  type StableAudio3TextToAudioRunnerClient,
  type StableAudio3TextToAudioRunnerOptions,
  type StableAudio3TextToAudioRunnerResult,
} from './stableAudio3TextToAudioRunner';
import type { LocalEngineGpuJobProgress } from './localEngineJobs';
import { settleStableAudio3TextToAudioJobs } from './stableAudio3TextToAudioSettlement';
import { createTabFlowStageFingerprint } from './tabFlowChangedStage';
import { registerProjectTabFlowStageResult } from './tabFlowStageResultIndex';
import type {
  GeneratedAudioArtifact,
  PatchTab,
  ProjectState,
  TabFlowConnection,
  TabFlowLine,
} from './types';

export const ONE_SHOT_GENERATION_PRESET_ID = 'one-shot-generation' as const;
export const ONE_SHOT_GENERATION_LINE_ID =
  'one-shot-generation-family' as const;

const TEXT_TO_AUDIO_PATCH_TAB_ID = 'one-shot-sa3-t2a';
const ACE_VOCALS_PATCH_TAB_ID = 'one-shot-ace-vocals';
const CONNECTION_ID = 'one-shot-t2a-to-ace-vocals';
const STAGE_COUNT = 2;

export type OneShotGenerationClient = StableAudio3TextToAudioRunnerClient &
  AceStepVocalStageClient;

export type OneShotGenerationAvailabilityVerifier = (
  project: ProjectState,
  artifact: GeneratedAudioArtifact,
  clipId: string,
) => Promise<GeneratedAudioCommitAvailabilityEvidence>;

export type OneShotGenerationIdentity = Readonly<{
  createdAt: string;
  operationId: string;
  requestToken: string;
  vocalClipId: string;
  vocalTrackId: string;
}>;

export type OneShotGenerationProgress = Readonly<{
  completedStageCount: number;
  jobProgress?: LocalEngineGpuJobProgress;
  message: string;
  stageId: 'ACE VOCALS' | 'SA3 T2A';
  stageCount: 2;
}>;

export type OneShotGenerationOptions = Readonly<{
  ace?: Omit<AceStepVocalStageOptions, 'onProgress' | 'signal'>;
  getCurrentProject: () => ProjectState;
  historyLimit: number;
  identity: OneShotGenerationIdentity;
  onProgress?: (progress: OneShotGenerationProgress) => void;
  signal?: AbortSignal;
  textToAudio?: Omit<
    StableAudio3TextToAudioRunnerOptions,
    'onProgress' | 'signal'
  >;
  verifyGeneratedAudio: OneShotGenerationAvailabilityVerifier;
}>;

export type OneShotGenerationResult = Readonly<{
  ace?: AceStepVocalStageResult;
  canCommit: boolean;
  completedStageCount: number;
  message: string;
  operationId: string;
  project: ProjectState;
  status: 'BLOCKED' | 'CANCELED' | 'COMPLETED' | 'FAILED' | 'PARTIAL';
  textToAudio?: StableAudio3TextToAudioRunnerResult;
}>;

export type OneShotGenerationFamilyResolution =
  | Readonly<{
      acePatchTab: PatchTab;
      canResolve: true;
      connection: TabFlowConnection;
      line: TabFlowLine;
      textToAudioPatchTab: PatchTab;
    }>
  | Readonly<{ canResolve: false; message: string }>;

export function resolveOneShotGenerationFamily(
  project: ProjectState,
): OneShotGenerationFamilyResolution {
  const textToAudioMatches = project.patchTabs.filter(
    (patchTab) =>
      patchTab.id === TEXT_TO_AUDIO_PATCH_TAB_ID &&
      patchTab.nodeTypeId ===
        BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio,
  );
  const aceMatches = project.patchTabs.filter(
    (patchTab) =>
      patchTab.id === ACE_VOCALS_PATCH_TAB_ID &&
      patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.aceStep,
  );
  const connectionMatches = project.connections.filter(
    (connection) => connection.id === CONNECTION_ID,
  );
  const lineMatches = (project.tabFlowLines ?? []).filter(
    (line) => line.id === ONE_SHOT_GENERATION_LINE_ID,
  );

  if (
    textToAudioMatches.length !== 1 ||
    aceMatches.length !== 1 ||
    connectionMatches.length !== 1 ||
    lineMatches.length !== 1
  ) {
    return blockedFamily(
      'ONE SHOT GENERATION requires one exact SA3 T2A to ACE VOCALS family.',
    );
  }

  const textToAudioPatchTab = textToAudioMatches[0];
  const acePatchTab = aceMatches[0];
  const connection = connectionMatches[0];
  const line = lineMatches[0];
  const involvedConnections = project.connections.filter(
    (candidate) =>
      candidate.fromPatchTabId === textToAudioPatchTab.id ||
      candidate.toPatchTabId === textToAudioPatchTab.id ||
      candidate.fromPatchTabId === acePatchTab.id ||
      candidate.toPatchTabId === acePatchTab.id,
  );
  const familyMembershipCount = (project.tabFlowLines ?? []).filter(
    (candidate) => candidate.connectionIds.includes(connection.id),
  ).length;
  const definitions = getBuiltinPatchTabDefinitions();
  const textToAudioDefinition = definitions.find(
    (definition) =>
      definition.nodeTypeId ===
      BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio,
  );
  const aceDefinition = definitions.find(
    (definition) =>
      definition.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.aceStep,
  );

  if (
    !textToAudioDefinition ||
    !aceDefinition ||
    textToAudioPatchTab.nodeVersion !== textToAudioDefinition.nodeVersion ||
    acePatchTab.nodeVersion !== aceDefinition.nodeVersion ||
    JSON.stringify(textToAudioPatchTab.portContractSnapshot) !==
      JSON.stringify(textToAudioDefinition) ||
    JSON.stringify(acePatchTab.portContractSnapshot) !==
      JSON.stringify(aceDefinition)
  ) {
    return blockedFamily(
      'ONE SHOT GENERATION PatchTab contracts are stale or unsupported.',
    );
  }

  if (
    connection.fromPatchTabId !== textToAudioPatchTab.id ||
    connection.fromPortId !== 'audio-out' ||
    connection.toPatchTabId !== acePatchTab.id ||
    connection.toPortId !== 'guide-audio-in' ||
    connection.enabled !== true ||
    connection.activation !== 'on' ||
    connection.createdOrder !== 0 ||
    connection.order !== 0 ||
    involvedConnections.length !== 1 ||
    involvedConnections[0] !== connection ||
    familyMembershipCount !== 1 ||
    line.enabled !== true ||
    line.revision !== 1 ||
    line.order !== 0 ||
    line.connectionIds.length !== 1 ||
    line.connectionIds[0] !== connection.id
  ) {
    return blockedFamily(
      'ONE SHOT GENERATION routing must be one enabled SA3 T2A to ACE VOCALS connection.',
    );
  }

  const compatibility = getPatchTabConnectionCompatibility(
    textToAudioPatchTab,
    acePatchTab,
    'audio-out',
    'guide-audio-in',
  );

  if (compatibility.state !== 'compatible') {
    return blockedFamily(
      `ONE SHOT GENERATION Guide Audio route is invalid: ${compatibility.reason}`,
    );
  }

  const bindings = acePatchTab.inputBindings ?? [];

  if (
    bindings.length !== 1 ||
    bindings[0]?.kind !== 'connection' ||
    bindings[0].portId !== 'guide-audio-in' ||
    bindings[0].connectionIds.length !== 1 ||
    bindings[0].connectionIds[0] !== connection.id
  ) {
    return blockedFamily(
      'ONE SHOT GENERATION ACE VOCALS Guide binding is invalid.',
    );
  }

  return Object.freeze({
    acePatchTab,
    canResolve: true as const,
    connection,
    line,
    textToAudioPatchTab,
  });
}

export async function runOneShotGeneration(
  client: OneShotGenerationClient,
  initialProject: ProjectState,
  options: OneShotGenerationOptions,
): Promise<OneShotGenerationResult> {
  const family = resolveOneShotGenerationFamily(initialProject);

  if (!family.canResolve) {
    return terminal(initialProject, options.identity.operationId, 'BLOCKED', 0, family.message);
  }

  const optionError = validateOptions(options);

  if (optionError) {
    return terminal(initialProject, options.identity.operationId, 'BLOCKED', 0, optionError);
  }

  const aceSettings = resolveAceStepPatchTabSettings(family.acePatchTab);

  if (!aceSettings.canResolve) {
    return terminal(initialProject, options.identity.operationId, 'BLOCKED', 0, aceSettings.message);
  }

  const preparation = prepareStableAudio3TextToAudioPatchTabRun(
    initialProject,
    family.textToAudioPatchTab,
    {
      createdAt: options.identity.createdAt,
      requestToken: options.identity.requestToken,
    },
  );

  if (!preparation.canPrepare || preparation.plans.length !== 1) {
    return terminal(
      initialProject,
      options.identity.operationId,
      'BLOCKED',
      0,
      preparation.canPrepare
        ? 'ONE SHOT GENERATION requires exactly one SA3 T2A Take.'
        : preparation.message,
    );
  }

  const textToAudioDurationSeconds =
    preparation.plan.request.parameters.durationSeconds;

  if (
    textToAudioDurationSeconds < ACE_STEP_MIN_DURATION_SECONDS ||
    textToAudioDurationSeconds > ACE_STEP_MAX_DURATION_SECONDS
  ) {
    return terminal(
      initialProject,
      options.identity.operationId,
      'BLOCKED',
      0,
      `ONE SHOT GENERATION requires an SA3 T2A duration from ${ACE_STEP_MIN_DURATION_SECONDS} to ${ACE_STEP_MAX_DURATION_SECONDS} seconds for ACE VOCALS.`,
    );
  }

  progress(options, 0, 'SA3 T2A', 'Generating the backing with SA3 T2A.');
  const textToAudio = await runStableAudio3TextToAudioPlan(
    client,
    preparation.plan,
    {
      ...options.textToAudio,
      signal: options.signal,
      onProgress: (state) =>
        progress(
          options,
          0,
          'SA3 T2A',
          `SA3 T2A ${state.state}.`,
          state.jobProgress,
        ),
    },
  );

  if (!textToAudio.ok) {
    const canceled =
      textToAudio.status === 'JOB_CANCELED' ||
      textToAudio.status === 'RUN_CANCELED';
    return Object.freeze({
      canCommit: false,
      completedStageCount: 0,
      message:
        'message' in textToAudio
          ? textToAudio.message
          : 'SA3 T2A did not reach a completed state.',
      operationId: options.identity.operationId,
      project: initialProject,
      status: canceled ? 'CANCELED' : 'FAILED',
      textToAudio,
    });
  }

  const history = createSessionEditHistory(
    { project: initialProject, selectedClipId: '' },
    createInternalEdit(options.identity, 'prepare'),
  );
  const provisionalSettlement = settleStableAudio3TextToAudioJobs(
    history,
    preparation.plans,
    [textToAudio.job],
    preparation.target,
    { historyLimit: options.historyLimit },
  );

  if (!provisionalSettlement.settled) {
    return terminal(
      initialProject,
      options.identity.operationId,
      'FAILED',
      0,
      provisionalSettlement.message,
      { textToAudio },
    );
  }

  const provisionalArtifact = provisionalSettlement.artifacts[0];

  if (!provisionalArtifact) {
    return terminal(
      initialProject,
      options.identity.operationId,
      'FAILED',
      0,
      'SA3 T2A completed without one exact backing Artifact.',
      { textToAudio },
    );
  }

  let textToAudioAvailability: GeneratedAudioCommitAvailabilityEvidence;

  try {
    textToAudioAvailability = await options.verifyGeneratedAudio(
      provisionalSettlement.workspace.project,
      provisionalArtifact,
      provisionalSettlement.clip.id,
    );
  } catch (error) {
    return terminal(
      initialProject,
      options.identity.operationId,
      'FAILED',
      0,
      errorMessage(error, 'SA3 T2A backing availability verification failed.'),
      { textToAudio },
    );
  }

  const finalSettlement = settleStableAudio3TextToAudioJobs(
    history,
    preparation.plans,
    [textToAudio.job],
    preparation.target,
    {
      historyLimit: options.historyLimit,
      sourceAvailability: textToAudioAvailability,
    },
  );

  if (!finalSettlement.settled) {
    return terminal(
      initialProject,
      options.identity.operationId,
      'FAILED',
      0,
      finalSettlement.message,
      { textToAudio },
    );
  }

  const promptUpdate = applyStableAudio3TextToAudioManagedPrompt(
    finalSettlement.workspace.project,
    family.textToAudioPatchTab.id,
    preparation.sourceParameterFingerprint,
    preparation.managedPrompt,
    {
      outputClipId: finalSettlement.clip.id,
      recipeFingerprint: preparation.recipeFingerprint,
    },
  );

  if (!promptUpdate.applied) {
    return terminal(
      initialProject,
      options.identity.operationId,
      'FAILED',
      0,
      promptUpdate.message,
      { textToAudio },
    );
  }

  let backingProject = registerStageResult(
    promptUpdate.project,
    family,
    'sa3-t2a',
    createTextToAudioFingerprint(family.textToAudioPatchTab, initialProject),
    textToAudio.job.finishedAt ?? options.identity.createdAt,
    finalSettlement.clip.id,
    finalSettlement.artifacts.map((artifact) => artifact.artifactId),
    finalSettlement.clipTakes.map((take) => take.clipTakeId),
    `${options.identity.operationId}-sa3-t2a`,
  );

  if (options.getCurrentProject() !== initialProject) {
    return terminal(
      backingProject,
      options.identity.operationId,
      'FAILED',
      1,
      'ONE SHOT GENERATION was not committed because the Project changed after SA3 T2A.',
      { canCommit: false, textToAudio },
    );
  }

  progress(options, 1, 'ACE VOCALS', 'Generating aligned vocals from the finalized backing.');
  const ace = await runAceStepTextToAudioVocalStage(
    client,
    {
      caption: aceSettings.settings.caption,
      guideClipId: finalSettlement.clip.id,
      lyrics: aceSettings.settings.lyrics,
      mode: 'stable-audio-3-text-to-audio',
      project: backingProject,
      seed: aceSettings.settings.seed,
      target: {
        clipId: options.identity.vocalClipId,
        clipName: 'Vocals',
        createdAt: options.identity.createdAt,
        trackId: options.identity.vocalTrackId,
        trackName: 'Vocals',
      },
      vocalLanguage: aceSettings.settings.vocalLanguage,
    },
    {
      ...options.ace,
      signal: options.signal,
      onProgress: (state) =>
        progress(
          options,
          1,
          'ACE VOCALS',
          `ACE VOCALS ${state.state}.`,
          state.jobProgress,
        ),
    },
  );

  if (!ace.ok) {
    return Object.freeze({
      ace,
      canCommit: true,
      completedStageCount: 1,
      message: `Backing completed. ${ace.message}`,
      operationId: options.identity.operationId,
      project: backingProject,
      status: ace.status === 'CANCELED' ? 'CANCELED' : 'PARTIAL',
      textToAudio,
    });
  }

  let aceAvailability: GeneratedAudioCommitAvailabilityEvidence;

  try {
    aceAvailability = await options.verifyGeneratedAudio(
      ace.project,
      ace.artifact,
      options.identity.vocalClipId,
    );
  } catch (error) {
    return Object.freeze({
      ace,
      canCommit: true,
      completedStageCount: 1,
      message: `Backing completed. ${errorMessage(
        error,
        'ACE Vocal availability verification failed.',
      )}`,
      operationId: options.identity.operationId,
      project: backingProject,
      status: 'PARTIAL',
      textToAudio,
    });
  }

  const activation = activateClipTake(
    ace.project,
    options.identity.vocalClipId,
    ace.clipTake.clipTakeId,
    { sourceAvailability: aceAvailability },
  );

  if (!activation.canActivate) {
    return Object.freeze({
      ace,
      canCommit: true,
      completedStageCount: 1,
      message: `Backing completed. ${activation.message}`,
      operationId: options.identity.operationId,
      project: backingProject,
      status: 'PARTIAL',
      textToAudio,
    });
  }

  let completedProject = registerStageResult(
    activation.project,
    family,
    'ace-vocals',
    createAceFingerprint(
      family.acePatchTab,
      provisionalArtifact.artifactId,
      finalSettlement.clip.activeClipTakeId ?? '',
    ),
    ace.job.finishedAt ?? options.identity.createdAt,
    options.identity.vocalClipId,
    [ace.artifact.artifactId],
    [ace.clipTake.clipTakeId],
    `${options.identity.operationId}-ace-vocals`,
  );
  completedProject = {
    ...completedProject,
    selection: {
      anchorItem: { id: options.identity.vocalClipId, type: 'clip' },
      items: [{ id: options.identity.vocalClipId, type: 'clip' }],
      lastSelectedItem: { id: options.identity.vocalClipId, type: 'clip' },
    },
    status: 'ONE SHOT COMPLETE',
  };

  if (options.getCurrentProject() !== initialProject) {
    return terminal(
      backingProject,
      options.identity.operationId,
      'FAILED',
      1,
      'ONE SHOT GENERATION was not committed because the Project changed during ACE VOCALS.',
      { ace, canCommit: false, textToAudio },
    );
  }

  return Object.freeze({
    ace,
    canCommit: true,
    completedStageCount: 2,
    message:
      'ONE SHOT GENERATION completed the aligned backing and vocal Tracks. Save Project to persist the result.',
    operationId: options.identity.operationId,
    project: completedProject,
    status: 'COMPLETED',
    textToAudio,
  });
}

function registerStageResult(
  project: ProjectState,
  family: Extract<OneShotGenerationFamilyResolution, { canResolve: true }>,
  stageId: string,
  fingerprint: string,
  finishedAt: string,
  targetClipId: string,
  outputArtifactIds: readonly string[],
  outputClipTakeIds: readonly string[],
  resultId: string,
): ProjectState {
  return registerProjectTabFlowStageResult(project, {
    fingerprint,
    finishedAt,
    outputArtifactIds,
    outputClipTakeIds,
    resultId,
    scope: {
      familyId: family.line.id,
      familyRevision: family.line.revision,
      stageId,
      targetClipId,
    },
    state: 'COMPLETED',
  });
}

function createTextToAudioFingerprint(
  patchTab: PatchTab,
  project: ProjectState,
): string {
  return createTabFlowStageFingerprint({
    artifactInputs: [],
    node: {
      nodeTypeId: patchTab.nodeTypeId ?? '',
      nodeVersion: patchTab.nodeVersion ?? '',
      parameters: parameterValues(patchTab),
      patchTabId: patchTab.id,
    },
    projectContext: {
      bpm: project.bpm,
      key: project.key,
      playheadTick: project.playheadTick,
      totalTicks: project.totalTicks,
    },
    provider: {
      modelId: STABLE_AUDIO_3_MODEL_ID,
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      providerRevision: STABLE_AUDIO_3_MODEL_REVISION,
      taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
    },
    resourceInputs: [],
  });
}

function createAceFingerprint(
  patchTab: PatchTab,
  artifactId: string,
  clipTakeId: string,
): string {
  return createTabFlowStageFingerprint({
    artifactInputs: [
      {
        artifactIds: [artifactId],
        clipTakeIds: [clipTakeId],
        portId: 'guide-audio-in',
      },
    ],
    node: {
      nodeTypeId: patchTab.nodeTypeId ?? '',
      nodeVersion: patchTab.nodeVersion ?? '',
      parameters: parameterValues(patchTab),
      patchTabId: patchTab.id,
    },
    projectContext: {},
    provider: {
      modelId: ACE_STEP_MODEL_ID,
      modelRevision: ACE_STEP_MODEL_REVISION,
      providerId: ACE_STEP_PROVIDER_ID,
      providerRevision: ACE_STEP_MODEL_REVISION,
      taskId: ACE_STEP_TASK_ID,
    },
    resourceInputs: [],
  });
}

function parameterValues(patchTab: PatchTab): Record<string, string | number> {
  return Object.fromEntries(
    patchTab.parameters.map((parameter) => [parameter.id, parameter.value]),
  );
}

function createInternalEdit(
  identity: OneShotGenerationIdentity,
  suffix: string,
): SessionEditEntry {
  return Object.freeze({
    category: 'auto-patch' as const,
    createdAt: identity.createdAt,
    id: `${identity.operationId}-${suffix}`,
    label: 'Run ONE SHOT GENERATION',
  });
}

function validateOptions(options: OneShotGenerationOptions): string | undefined {
  if (
    !Number.isSafeInteger(options.historyLimit) ||
    options.historyLimit < 1 ||
    typeof options.getCurrentProject !== 'function' ||
    typeof options.verifyGeneratedAudio !== 'function' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.identity.operationId) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.identity.requestToken) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.identity.vocalClipId) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.identity.vocalTrackId) ||
    Number.isNaN(Date.parse(options.identity.createdAt))
  ) {
    return 'ONE SHOT GENERATION identity or runner options are invalid.';
  }

  return undefined;
}

function progress(
  options: OneShotGenerationOptions,
  completedStageCount: number,
  stageId: OneShotGenerationProgress['stageId'],
  message: string,
  jobProgress?: LocalEngineGpuJobProgress,
): void {
  options.onProgress?.(
    Object.freeze({
      completedStageCount,
      ...(jobProgress ? { jobProgress } : {}),
      message,
      stageCount: STAGE_COUNT,
      stageId,
    }),
  );
}

function terminal(
  project: ProjectState,
  operationId: string,
  status: OneShotGenerationResult['status'],
  completedStageCount: number,
  message: string,
  details: Partial<Pick<OneShotGenerationResult, 'ace' | 'canCommit' | 'textToAudio'>> = {},
): OneShotGenerationResult {
  return Object.freeze({
    canCommit: details.canCommit ?? false,
    completedStageCount,
    message,
    operationId,
    project,
    status,
    ...(details.ace ? { ace: details.ace } : {}),
    ...(details.textToAudio ? { textToAudio: details.textToAudio } : {}),
  });
}

function blockedFamily(message: string): Extract<
  OneShotGenerationFamilyResolution,
  { canResolve: false }
> {
  return Object.freeze({ canResolve: false as const, message });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
