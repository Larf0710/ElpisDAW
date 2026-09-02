import {
  ACE_STEP_CHANNELS,
  ACE_STEP_COVER_TASK_ID,
  ACE_STEP_MODEL_ID,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_SAMPLE_RATE,
} from '../shared/aceStepProtocol.js';
import {
  createFullSourceAudioClipTiming,
  secondsToTimelineTicks,
} from './audioClipTiming';
import { AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS } from './audioGenerationRegion';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { createAceStepCoverJobRequest } from './aceStepCoverJobContract';
import type { AceStepCoverJobPlan } from './aceStepCoverPatchTab';
import { applyAceStepCoverOutputPlan } from './aceStepCoverOutput';
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

export type AceStepCoverWorkspace = Readonly<{
  project: ProjectState;
  selectedClipId: string;
}>;

export type AceStepCoverSettlementResult<Workspace extends AceStepCoverWorkspace> =
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

export function settleAceStepCoverJobs<Workspace extends AceStepCoverWorkspace>(
  history: SessionEditHistory<Workspace>,
  plans: readonly AceStepCoverJobPlan[],
  jobs: readonly LocalEngineGpuJobRecord[],
  input: Readonly<{
    historyLimit: number;
    patchTabId: string;
    recipeFingerprint: string;
    sourceAvailability?: GeneratedAudioCommitAvailabilityEvidence;
    sourceFingerprint: string;
    sourceParameterFingerprint: string;
    target: Readonly<{ kind: 'append'; outputClipId: string }> | Readonly<{ kind: 'new' }>;
  }>,
): AceStepCoverSettlementResult<Workspace> {
  const workspace = history.present.value;

  if (
    !Number.isSafeInteger(input.historyLimit) ||
    input.historyLimit < 1 ||
    plans.length < 1 ||
    plans.length > 3 ||
    plans.length !== jobs.length ||
    new Set(jobs.map((job) => job.jobId)).size !== jobs.length
  ) {
    return blocked(history, workspace, 'ace-step-cover-batch-invalid', 'ACE Cover settlement requires one to three distinct completed Jobs and matching plans.');
  }

  const sourcePatchTab = workspace.project.patchTabs.find((patchTab) => patchTab.id === input.patchTabId);

  if (
    !sourcePatchTab ||
    sourcePatchTab.nodeTypeId !== 'humstudio.patch.ace-step-cover' ||
    JSON.stringify(sourcePatchTab.parameters) !== input.sourceParameterFingerprint
  ) {
    return blocked(history, workspace, 'ace-step-cover-source-stale', 'ACE Cover parameters changed or its PatchTab was removed before settlement.');
  }

  const firstPlan = plans[0];

  if (
    !firstPlan ||
    currentSourceFingerprint(workspace.project, firstPlan.output.source.clipId) !== input.sourceFingerprint ||
    plans.some((plan) => !plansShareRecipe(firstPlan, plan)) ||
    jobs.some((job, index) => !jobMatchesPlan(job, plans[index]))
  ) {
    return blocked(history, workspace, 'ace-step-cover-plan-mismatch', 'ACE Cover source and completed Jobs must match one immutable recipe and differ only by Seed.');
  }

  try {
    let project = workspace.project;
    let outputClipId: string;

    if (input.target.kind === 'new') {
      const application = applyAceStepCoverOutputPlan(project, firstPlan.output);
      if (!application.applied) {
        return blocked(history, workspace, application.cause, application.message);
      }
      project = application.project;
      outputClipId = firstPlan.output.output.clipId;
    } else {
      const location = findUniqueClip(project, input.target.outputClipId);
      if (
        !location ||
        location.clip.type !== 'ai-fill-audio' ||
        location.clip.sourceClipId !== firstPlan.output.source.clipId
      ) {
        return blocked(history, workspace, 'ace-step-cover-append-target-stale', 'The tracked ACE Cover Clip is unavailable for Take append.');
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
        label: `ACE Cover Take ${String(existingTakeCount + index + 1).padStart(2, '0')}`,
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
          'ace-step-cover-registration-failed',
          registration.canRegister
            ? 'ACE Cover did not produce one valid stereo 48 kHz Audio Take per completed Job.'
            : registration.message,
        );
      }

      project = registration.project;
      artifacts.push(registration.artifact);
      clipTakes.push(registration.clipTake);
    }

    const firstTake = clipTakes[0];
    if (!firstTake) {
      return blocked(history, workspace, 'ace-step-cover-registration-empty', 'ACE Cover completed without a registered Take.');
    }

    const firstArtifact = artifacts[0];
    if (!firstArtifact) {
      return blocked(history, workspace, 'ace-step-cover-artifact-missing', 'ACE Cover completed without one active Audio Artifact.');
    }

    const registeredLocation = findUniqueClip(project, outputClipId);
    if (!registeredLocation) {
      return blocked(history, workspace, 'ace-step-cover-output-missing', 'ACE Cover output Clip disappeared during registration.');
    }

    const renderedLengthTicks = secondsToTimelineTicks(
      firstArtifact.audio.durationSeconds,
      project.bpm,
    );
    const requiredTotalTicks = registeredLocation.clip.startTick + renderedLengthTicks;
    if (requiredTotalTicks > AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS) {
      return blocked(history, workspace, 'ace-step-cover-output-placement-invalid', 'ACE Cover rendered Audio does not fit the supported Timeline.');
    }

    const synchronizedClip: Clip = {
      ...registeredLocation.clip,
      audioTiming: createFullSourceAudioClipTiming(firstArtifact.audio.durationSeconds),
      lengthTicks: renderedLengthTicks,
      version: registeredLocation.clip.version + 1,
    };
    project = {
      ...project,
      totalTicks: Math.max(project.totalTicks, requiredTotalTicks),
      tracks: project.tracks.map((track) =>
        track.id === registeredLocation.track.id
          ? {
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === outputClipId ? synchronizedClip : clip,
              ),
            }
          : track,
      ),
    };

    const activation = activateClipTake(project, outputClipId, firstTake.clipTakeId, {
      sourceAvailability: input.sourceAvailability,
    });
    if (!activation.canActivate) {
      return blocked(history, workspace, 'ace-step-cover-activation-failed', activation.message);
    }

    project = {
      ...activation.project,
      patchTabs: activation.project.patchTabs.map((patchTab) =>
        patchTab.id === input.patchTabId
          ? {
              ...patchTab,
              generationContinuation: {
                kind: 'ace-step-cover' as const,
                outputClipId,
                recipeFingerprint: input.recipeFingerprint,
                sourceClipId: firstPlan.output.source.clipId,
                sourceClipTakeId: firstPlan.output.source.clipTakeId,
              },
            }
          : patchTab,
      ),
    };
    const location = findUniqueClip(project, outputClipId);
    if (!location) {
      return blocked(history, workspace, 'ace-step-cover-output-missing', 'ACE Cover output Clip disappeared during settlement.');
    }

    const finishedAtValues = jobs.map((job) => job.finishedAt as string).sort();
    const finishedAt = finishedAtValues[finishedAtValues.length - 1] as string;
    const edit = Object.freeze({
      category: 'clip' as const,
      createdAt: finishedAt,
      id: `edit-${jobs.map((job) => job.jobId).join('-')}-ace-cover`,
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
      'ace-step-cover-settlement-exception',
      error instanceof Error ? error.message : 'ACE Cover settlement failed unexpectedly.',
    );
  }
}

function currentSourceFingerprint(project: ProjectState, clipId: string): string | undefined {
  const resolution = resolveActiveAudioTakeSource(project, clipId);
  if (!resolution.canResolve) return undefined;
  const source = resolution.plan;
  return JSON.stringify({
    artifactId: source.source.artifactId,
    clipId: source.source.clipId,
    clipTakeId: source.source.clipTakeId,
    durationSeconds: source.clip.sourceFile.durationSeconds,
    name: source.clip.name,
    relativePath: source.descriptor.relativePath,
    sizeBytes: source.descriptor.sizeBytes,
  });
}

function jobMatchesPlan(job: LocalEngineGpuJobRecord, plan: AceStepCoverJobPlan): boolean {
  if (
    job.state !== 'COMPLETED' ||
    !job.finishedAt ||
    Number.isNaN(Date.parse(job.finishedAt)) ||
    !isLocalEngineJobId(job.jobId) ||
    job.providerId !== ACE_STEP_PROVIDER_ID ||
    job.modelId !== ACE_STEP_MODEL_ID ||
    job.taskId !== ACE_STEP_COVER_TASK_ID
  ) {
    return false;
  }

  try {
    const request = createAceStepCoverJobRequest({
      caption: plan.request.parameters.caption,
      coverStrength: plan.request.parameters.audioCoverStrength,
      durationSeconds: plan.request.parameters.durationSeconds,
      guideArtifactId: plan.request.guideSource.artifactId,
      guideClipTakeId: plan.request.guideSource.clipTakeId,
      guideRelativePath: plan.request.guideSource.relativePath,
      guideSizeBytes: plan.request.inputArtifacts[0].sizeBytes,
      instrumental: plan.request.parameters.instrumental,
      lyricsArtifactId: plan.request.inputArtifacts[1].artifactId,
      lyricsRelativePath: plan.request.inputArtifacts[1].relativePath,
      seed: plan.request.parameters.seed,
      vocalLanguage: plan.request.parameters.vocalLanguage,
    });
    return jsonEqual(request, plan.request) && jsonEqual(request, job.request);
  } catch {
    return false;
  }
}

function plansShareRecipe(first: AceStepCoverJobPlan, candidate: AceStepCoverJobPlan): boolean {
  return jsonEqual(
    { ...first, request: { ...first.request, parameters: { ...first.request.parameters, seed: 0 } } },
    { ...candidate, request: { ...candidate.request, parameters: { ...candidate.request.parameters, seed: 0 } } },
  );
}

type CompletedRegistration = Extract<ProjectArtifactRegistrationUpdate, { canRegister: true }>;

function validRegistration(
  registration: CompletedRegistration,
  plan: AceStepCoverJobPlan,
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
    artifact.provenance.taskId === ACE_STEP_COVER_TASK_ID &&
    artifact.provenance.parameters.sampleRate === ACE_STEP_SAMPLE_RATE &&
    artifact.provenance.parameters.channels === ACE_STEP_CHANNELS &&
    artifact.lineage.parentArtifactIds.length === 2 &&
    artifact.lineage.parentArtifactIds[0] === plan.request.inputArtifacts[0].artifactId &&
    artifact.lineage.parentArtifactIds[1] === plan.request.inputArtifacts[1].artifactId &&
    artifact.lineage.parentClipTakeIds.length === 1 &&
    artifact.lineage.parentClipTakeIds[0] === plan.request.guideSource.clipTakeId &&
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

function blocked<Workspace extends AceStepCoverWorkspace>(
  history: SessionEditHistory<Workspace>,
  workspace: Workspace,
  cause: string,
  message: string,
): Extract<AceStepCoverSettlementResult<Workspace>, { settled: false }> {
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
