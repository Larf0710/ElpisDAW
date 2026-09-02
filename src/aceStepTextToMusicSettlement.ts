import {
  ACE_STEP_CHANNELS,
  ACE_STEP_MODEL_ID,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_SAMPLE_RATE,
  ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
} from '../shared/aceStepProtocol.js';
import { applyAudioGenerationRegionPlan } from './audioGenerationRegionApplication';
import type { AceStepTextToMusicJobPlan } from './aceStepTextToMusicPatchTab';
import { createAceStepTextToMusicJobRequest } from './aceStepTextToMusicJobContract';
import { activateClipTake } from './clipTakeActivation';
import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import { isLocalEngineJobId, type LocalEngineGpuJobRecord } from './localEngineJobs';
import {
  createCompletedAudioJobRegistration,
  type ProjectArtifactRegistrationUpdate,
} from './projectArtifactRegistration';
import { commitSessionEdit, type SessionEditEntry, type SessionEditHistory } from './sessionEditHistory';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
  Track,
} from './types';

export type AceStepTextToMusicWorkspace = Readonly<{
  project: ProjectState;
  selectedClipId: string;
}>;

export type AceStepTextToMusicSettlementResult<Workspace extends AceStepTextToMusicWorkspace> =
  | Readonly<{
      artifacts: readonly (GeneratedAudioArtifact & { destination: 'ace-step' })[];
      clip: Clip;
      clipTakes: readonly GeneratedAudioClipTake[];
      edit: SessionEditEntry;
      history: SessionEditHistory<Workspace>;
      settled: true;
      status: 'SETTLED';
      track: Track;
      workspace: Workspace;
    }>
  | Readonly<{
      cause: string;
      history: SessionEditHistory<Workspace>;
      message: string;
      settled: false;
      status: 'BLOCKED';
      workspace: Workspace;
    }>;

export function settleAceStepTextToMusicJobs<Workspace extends AceStepTextToMusicWorkspace>(
  history: SessionEditHistory<Workspace>,
  plans: readonly AceStepTextToMusicJobPlan[],
  jobs: readonly LocalEngineGpuJobRecord[],
  input: Readonly<{
    historyLimit: number;
    patchTabId: string;
    recipeFingerprint: string;
    sourceAvailability?: GeneratedAudioCommitAvailabilityEvidence;
    sourceParameterFingerprint: string;
    target: Readonly<{ kind: 'append'; outputClipId: string }> | Readonly<{ kind: 'new' }>;
  }>,
): AceStepTextToMusicSettlementResult<Workspace> {
  const workspace = history.present.value;

  if (
    !Number.isSafeInteger(input.historyLimit) ||
    input.historyLimit < 1 ||
    plans.length < 1 ||
    plans.length > 3 ||
    plans.length !== jobs.length ||
    new Set(jobs.map((job) => job.jobId)).size !== jobs.length
  ) {
    return blocked(history, workspace, 'ace-step-t2m-batch-invalid', 'ACE T2M settlement requires one to three distinct completed Jobs and matching plans.');
  }

  const sourcePatchTab = workspace.project.patchTabs.find((patchTab) => patchTab.id === input.patchTabId);

  if (
    !sourcePatchTab ||
    sourcePatchTab.nodeTypeId !== 'humstudio.patch.ace-step-text-to-music' ||
    JSON.stringify(sourcePatchTab.parameters) !== input.sourceParameterFingerprint
  ) {
    return blocked(history, workspace, 'ace-step-t2m-source-stale', 'ACE T2M parameters changed or its PatchTab was removed before settlement.');
  }

  const firstPlan = plans[0];

  if (
    !firstPlan ||
    plans.some((plan) => !plansShareRecipe(firstPlan, plan)) ||
    jobs.some((job, index) => !jobMatchesPlan(job, plans[index]))
  ) {
    return blocked(history, workspace, 'ace-step-t2m-plan-mismatch', 'ACE T2M completed Jobs must match one immutable recipe and differ only by Seed.');
  }

  try {
    let project = workspace.project;
    let outputClipId: string;

    if (input.target.kind === 'new') {
      const application = applyAudioGenerationRegionPlan(project, firstPlan.output.generationRegion);
      if (!application.applied) {
        return blocked(history, workspace, application.cause, application.message);
      }
      project = application.project;
      outputClipId = firstPlan.output.generationRegion.output.clipId;
    } else {
      const location = findUniqueClip(project, input.target.outputClipId);
      if (!location || location.clip.type !== 'ai-fill-audio') {
        return blocked(history, workspace, 'ace-step-t2m-append-target-stale', 'The tracked ACE T2M Clip is unavailable for Take append.');
      }
      outputClipId = input.target.outputClipId;
    }

    const existingTakeCount = findUniqueClip(project, outputClipId)?.clip.clipTakes?.length ?? 0;
    const artifacts: Array<GeneratedAudioArtifact & { destination: 'ace-step' }> = [];
    const clipTakes: GeneratedAudioClipTake[] = [];

    for (let index = 0; index < jobs.length; index += 1) {
      const registration = createCompletedAudioJobRegistration(project, jobs[index], {
        activate: false,
        clipId: outputClipId,
        label: `ACE T2M Take ${String(existingTakeCount + index + 1).padStart(2, '0')}`,
        sourceAvailability: input.sourceAvailability,
      });

      if (
        !registration.canRegister ||
        registration.status !== 'REGISTERED' ||
        !validRegistration(registration, plans[index], jobs[index])
      ) {
        return blocked(
          history,
          workspace,
          'ace-step-t2m-registration-failed',
          registration.canRegister
            ? 'ACE T2M did not produce one valid 48 kHz Audio Take per completed Job.'
            : registration.message,
        );
      }

      project = registration.project;
      artifacts.push(registration.artifact);
      clipTakes.push(registration.clipTake);
    }

    const firstTake = clipTakes[0];
    if (!firstTake) {
      return blocked(history, workspace, 'ace-step-t2m-registration-empty', 'ACE T2M completed without a registered Take.');
    }

    const activation = activateClipTake(project, outputClipId, firstTake.clipTakeId, {
      sourceAvailability: input.sourceAvailability,
    });
    if (!activation.canActivate) {
      return blocked(history, workspace, 'ace-step-t2m-activation-failed', activation.message);
    }

    project = {
      ...activation.project,
      patchTabs: activation.project.patchTabs.map((patchTab) =>
        patchTab.id === input.patchTabId
          ? {
              ...patchTab,
              generationContinuation: {
                kind: 'ace-step-text-to-music' as const,
                outputClipId,
                recipeFingerprint: input.recipeFingerprint,
              },
            }
          : patchTab,
      ),
    };
    const location = findUniqueClip(project, outputClipId);
    if (!location) {
      return blocked(history, workspace, 'ace-step-t2m-output-missing', 'ACE T2M output Clip disappeared during settlement.');
    }

    const finishedAtValues = jobs.map((job) => job.finishedAt as string).sort();
    const finishedAt = finishedAtValues[finishedAtValues.length - 1] as string;
    const edit = Object.freeze({
      category: 'clip' as const,
      createdAt: finishedAt,
      id: `edit-${jobs.map((job) => job.jobId).join('-')}-ace-t2m`,
      label: `Generate ${clipTakes.length} ${clipTakes.length === 1 ? 'Take' : 'Takes'} for ${location.clip.name}`,
    });
    const nextWorkspace: Workspace = {
      ...workspace,
      project,
      selectedClipId: input.target.kind === 'new' ? outputClipId : workspace.selectedClipId,
    };
    const nextHistory = commitSessionEdit(history, nextWorkspace, edit, input.historyLimit);

    return Object.freeze({
      artifacts: Object.freeze(artifacts),
      clip: location.clip,
      clipTakes: Object.freeze(clipTakes),
      edit,
      history: nextHistory,
      settled: true as const,
      status: 'SETTLED' as const,
      track: location.track,
      workspace: nextWorkspace,
    });
  } catch (error) {
    return blocked(
      history,
      workspace,
      'ace-step-t2m-settlement-exception',
      error instanceof Error ? error.message : 'ACE T2M settlement failed unexpectedly.',
    );
  }
}

function jobMatchesPlan(job: LocalEngineGpuJobRecord, plan: AceStepTextToMusicJobPlan): boolean {
  if (
    job.state !== 'COMPLETED' ||
    !job.finishedAt ||
    Number.isNaN(Date.parse(job.finishedAt)) ||
    !isLocalEngineJobId(job.jobId) ||
    job.providerId !== ACE_STEP_PROVIDER_ID ||
    job.modelId !== ACE_STEP_MODEL_ID ||
    job.taskId !== ACE_STEP_TEXT_TO_MUSIC_TASK_ID
  ) {
    return false;
  }

  try {
    const request = createAceStepTextToMusicJobRequest({
      bpm: plan.request.parameters.bpm,
      caption: plan.request.parameters.caption,
      durationSeconds: plan.request.parameters.durationSeconds,
      instrumental: plan.request.parameters.instrumental,
      keyscale: plan.request.parameters.keyscale,
      lyricsArtifactId: plan.request.inputArtifacts[0].artifactId,
      lyricsRelativePath: plan.request.inputArtifacts[0].relativePath,
      seed: plan.request.parameters.seed,
      vocalLanguage: plan.request.parameters.vocalLanguage,
    });
    return jsonEqual(request, plan.request) && jsonEqual(request, job.request);
  } catch {
    return false;
  }
}

function plansShareRecipe(first: AceStepTextToMusicJobPlan, candidate: AceStepTextToMusicJobPlan): boolean {
  return jsonEqual(
    { ...first, request: { ...first.request, parameters: { ...first.request.parameters, seed: 0 } } },
    { ...candidate, request: { ...candidate.request, parameters: { ...candidate.request.parameters, seed: 0 } } },
  );
}

type CompletedRegistration = Extract<ProjectArtifactRegistrationUpdate, { canRegister: true }>;

function validRegistration(
  registration: CompletedRegistration,
  plan: AceStepTextToMusicJobPlan,
  job: LocalEngineGpuJobRecord,
): registration is CompletedRegistration & Readonly<{
  artifact: GeneratedAudioArtifact & { destination: 'ace-step' };
  clipTake: GeneratedAudioClipTake;
}> {
  const artifact = registration.artifact;
  const clipTake = registration.clipTake;
  return (
    artifact.kind === 'audio' &&
    artifact.destination === ACE_STEP_OUTPUT_DESTINATION &&
    artifact.sourceJobId === job.jobId &&
    artifact.provenance.providerId === ACE_STEP_PROVIDER_ID &&
    artifact.provenance.modelId === ACE_STEP_MODEL_ID &&
    artifact.provenance.taskId === ACE_STEP_TEXT_TO_MUSIC_TASK_ID &&
    artifact.provenance.parameters.sampleRate === ACE_STEP_SAMPLE_RATE &&
    artifact.provenance.parameters.channels === ACE_STEP_CHANNELS &&
    artifact.lineage.parentArtifactIds.length === 1 &&
    artifact.lineage.parentArtifactIds[0] === plan.request.inputArtifacts[0].artifactId &&
    artifact.lineage.parentClipTakeIds.length === 0 &&
    artifact.audio.channels === ACE_STEP_CHANNELS &&
    artifact.audio.mimeType === 'audio/wav' &&
    Math.abs(artifact.audio.durationSeconds - plan.request.parameters.durationSeconds) <= 0.1 &&
    artifact.file.extension === '.wav' &&
    artifact.file.sizeBytes > 44 &&
    artifact.file.relativePath.startsWith('renders/ace-step/') &&
    clipTake.mediaType === 'audio' &&
    clipTake.sourceType === 'job' &&
    clipTake.sourceJobId === job.jobId &&
    clipTake.artifactId === artifact.artifactId
  );
}

function findUniqueClip(project: ProjectState, clipId: string): Readonly<{ clip: Clip; track: Track }> | undefined {
  const matches = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => clip.id === clipId).map((clip) => ({ clip, track })),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function blocked<Workspace extends AceStepTextToMusicWorkspace>(
  history: SessionEditHistory<Workspace>,
  workspace: Workspace,
  cause: string,
  message: string,
): Extract<AceStepTextToMusicSettlementResult<Workspace>, { settled: false }> {
  return Object.freeze({ cause, history, message, settled: false as const, status: 'BLOCKED' as const, workspace });
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
