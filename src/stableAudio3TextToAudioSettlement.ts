import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_OUTPUT_DESTINATION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_SAMPLE_RATE,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import { applyAudioGenerationRegionPlan } from './audioGenerationRegionApplication';
import { activateClipTake } from './clipTakeActivation';
import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import {
  isLocalEngineJobId,
  type LocalEngineGpuJobRecord,
} from './localEngineJobs';
import {
  createCompletedAudioJobRegistration,
  type ProjectArtifactRegistrationUpdate,
} from './projectArtifactRegistration';
import {
  commitSessionEdit,
  getSessionEditFrames,
  type SessionEditEntry,
  type SessionEditHistory,
} from './sessionEditHistory';
import type { StableAudio3TextToAudioJobPlan } from './stableAudio3TextToAudioCapability';
import { createStableAudio3TextToAudioJobRequest } from './stableAudio3TextToAudioJobContract';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
  Track,
} from './types';

const TAKE_LABEL = 'SA3 T2A Take 01';
const MAX_BATCH_TAKES = 3;

export type StableAudio3TextToAudioWorkspace = Readonly<{
  project: ProjectState;
  selectedClipId: string;
}>;

export type StableAudio3TextToAudioSettlementOptions = Readonly<{
  historyLimit: number;
  sourceAvailability?: GeneratedAudioCommitAvailabilityEvidence;
}>;

export type StableAudio3TextToAudioBatchTarget =
  | Readonly<{ kind: 'append'; outputClipId: string }>
  | Readonly<{ kind: 'new' }>;

export type StableAudio3TextToAudioBatchSettlementResult<
  Workspace extends StableAudio3TextToAudioWorkspace,
> =
  | Readonly<{
      artifacts: readonly (GeneratedAudioArtifact & {
        destination: 'stable-audio-3';
      })[];
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

type StableAudio3TextToAudioSettlementDetails = Readonly<{
  artifact: GeneratedAudioArtifact & { destination: 'stable-audio-3' };
  clip: Clip;
  clipTake: GeneratedAudioClipTake;
  track: Track;
}>;

export type StableAudio3TextToAudioSettlementResult<
  Workspace extends StableAudio3TextToAudioWorkspace,
> =
  | (StableAudio3TextToAudioSettlementDetails &
      Readonly<{
        edit: SessionEditEntry;
        history: SessionEditHistory<Workspace>;
        settled: true;
        status: 'SETTLED';
        workspace: Workspace;
      }>)
  | (StableAudio3TextToAudioSettlementDetails &
      Readonly<{
        history: SessionEditHistory<Workspace>;
        settled: true;
        status: 'ALREADY_SETTLED';
        workspace: Workspace;
      }>)
  | Readonly<{
      cause: string;
      history: SessionEditHistory<Workspace>;
      message: string;
      reason:
        | 'command-invalid'
        | 'job-not-completed'
        | 'job-plan-mismatch'
        | 'output-stale'
        | 'registration-failed'
        | 'registration-invalid'
        | 'settlement-exception';
      settled: false;
      status: 'BLOCKED';
      workspace: Workspace;
    }>;

export function settleStableAudio3TextToAudioJob<
  Workspace extends StableAudio3TextToAudioWorkspace,
>(
  history: SessionEditHistory<Workspace>,
  plan: StableAudio3TextToAudioJobPlan,
  job: LocalEngineGpuJobRecord,
  options: StableAudio3TextToAudioSettlementOptions,
): StableAudio3TextToAudioSettlementResult<Workspace> {
  const workspace = history.present.value;

  if (!Number.isSafeInteger(options.historyLimit) || options.historyLimit < 1) {
    return blocked(
      history,
      workspace,
      'command-invalid',
      'stable-audio-3-t2a-settlement-history-limit-invalid',
      'SA3 T2A settlement requires a positive Edit History limit.',
    );
  }

  if (
    job.state !== 'COMPLETED' ||
    !job.finishedAt ||
    Number.isNaN(Date.parse(job.finishedAt))
  ) {
    return blocked(
      history,
      workspace,
      'job-not-completed',
      'stable-audio-3-t2a-job-not-completed',
      'SA3 T2A settlement requires one completed Job with a valid finish time.',
    );
  }

  try {
    if (!doesJobMatchPlan(job, plan)) {
      return blocked(
        history,
        workspace,
        'job-plan-mismatch',
        'stable-audio-3-t2a-job-plan-mismatch',
        'Completed SA3 T2A Job does not match the immutable output and request plan.',
      );
    }

    const existing = resolveExistingSettlement(workspace.project, plan, job);

    if (existing.status === 'ALREADY_SETTLED') {
      return Object.freeze({
        ...existing.details,
        history,
        settled: true as const,
        status: 'ALREADY_SETTLED' as const,
        workspace,
      });
    }

    if (existing.status === 'CONFLICT') {
      return blocked(
        history,
        workspace,
        'output-stale',
        existing.cause,
        existing.message,
      );
    }

    const editId = createEditId(job.jobId);

    if (
      getSessionEditFrames(history).some((frame) => frame.edit.id === editId)
    ) {
      return blocked(
        history,
        workspace,
        'command-invalid',
        'stable-audio-3-t2a-settlement-edit-conflict',
        `SA3 T2A settlement Edit identity already exists: ${editId}.`,
      );
    }

    const application = applyAudioGenerationRegionPlan(
      workspace.project,
      plan.output.generationRegion,
    );

    if (!application.applied) {
      return blocked(
        history,
        workspace,
        'output-stale',
        application.cause,
        application.message,
      );
    }

    const registration = createCompletedAudioJobRegistration(
      application.project,
      job,
      {
        clipId: plan.output.generationRegion.output.clipId,
        label: TAKE_LABEL,
        sourceAvailability: options.sourceAvailability,
      },
    );

    if (!registration.canRegister) {
      return blocked(
        history,
        workspace,
        'registration-failed',
        `stable-audio-3-t2a-${registration.reason}`,
        registration.message,
      );
    }

    if (
      registration.status !== 'REGISTERED' ||
      !isValidTextToAudioRegistration(registration, plan, job)
    ) {
      return blocked(
        history,
        workspace,
        'registration-invalid',
        'stable-audio-3-t2a-registration-invalid',
        'Completed SA3 T2A Job did not produce one valid first Audio Clip Take.',
      );
    }

    const location = findUniqueClipLocation(
      registration.project,
      plan.output.generationRegion.output.clipId,
    );

    if (
      !location ||
      location.track.id !== plan.output.generationRegion.output.trackId
    ) {
      return blocked(
        history,
        workspace,
        'registration-invalid',
        'stable-audio-3-t2a-output-location-invalid',
        'Completed SA3 T2A output does not match the reserved Track and Clip identities.',
      );
    }

    const nextWorkspace: Workspace = {
      ...workspace,
      project: registration.project,
      selectedClipId: location.clip.id,
    };
    const edit = Object.freeze({
      category: 'clip' as const,
      createdAt: job.finishedAt,
      id: editId,
      label: `Generate ${location.clip.name}`,
    });
    const nextHistory = commitSessionEdit(
      history,
      nextWorkspace,
      edit,
      options.historyLimit,
    );

    return Object.freeze({
      artifact: registration.artifact,
      clip: location.clip,
      clipTake: registration.clipTake,
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
      'settlement-exception',
      'stable-audio-3-t2a-settlement-exception',
      error instanceof Error
        ? error.message
        : 'SA3 T2A settlement failed unexpectedly.',
    );
  }
}

export function settleStableAudio3TextToAudioJobs<
  Workspace extends StableAudio3TextToAudioWorkspace,
>(
  history: SessionEditHistory<Workspace>,
  plans: readonly StableAudio3TextToAudioJobPlan[],
  jobs: readonly LocalEngineGpuJobRecord[],
  target: StableAudio3TextToAudioBatchTarget,
  options: StableAudio3TextToAudioSettlementOptions,
): StableAudio3TextToAudioBatchSettlementResult<Workspace> {
  const workspace = history.present.value;

  if (
    !Number.isSafeInteger(options.historyLimit) ||
    options.historyLimit < 1 ||
    plans.length < 1 ||
    plans.length > MAX_BATCH_TAKES ||
    jobs.length !== plans.length ||
    new Set(jobs.map((job) => job.jobId)).size !== jobs.length
  ) {
    return batchBlocked(
      history,
      workspace,
      'stable-audio-3-t2a-batch-invalid',
      'SA3 T2A batch settlement requires one to three distinct completed Jobs and matching plans.',
    );
  }

  const firstPlan = plans[0];

  if (
    !firstPlan ||
    plans.some((plan) => !doesPlanMatchBatch(firstPlan, plan)) ||
    jobs.some(
      (job, index) =>
        job.state !== 'COMPLETED' ||
        !job.finishedAt ||
        Number.isNaN(Date.parse(job.finishedAt)) ||
        !doesJobMatchPlan(job, plans[index]),
    )
  ) {
    return batchBlocked(
      history,
      workspace,
      'stable-audio-3-t2a-batch-plan-mismatch',
      'SA3 T2A batch Jobs must share one recipe and differ only by Seed.',
    );
  }

  try {
    let currentProject = workspace.project;
    let outputClipId: string;

    if (target.kind === 'new') {
      const application = applyAudioGenerationRegionPlan(
        currentProject,
        firstPlan.output.generationRegion,
      );

      if (!application.applied) {
        return batchBlocked(history, workspace, application.cause, application.message);
      }

      currentProject = application.project;
      outputClipId = firstPlan.output.generationRegion.output.clipId;
    } else {
      const location = findUniqueClipLocation(currentProject, target.outputClipId);

      if (!location || location.clip.type !== 'ai-fill-audio') {
        return batchBlocked(
          history,
          workspace,
          'stable-audio-3-t2a-append-target-stale',
          'The tracked SA3 T2A output Clip is no longer available for Take append.',
        );
      }

      outputClipId = target.outputClipId;
    }

    const existingTakeCount =
      findUniqueClipLocation(currentProject, outputClipId)?.clip.clipTakes?.length ?? 0;
    const artifacts: Array<
      GeneratedAudioArtifact & { destination: 'stable-audio-3' }
    > = [];
    const clipTakes: GeneratedAudioClipTake[] = [];

    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const plan = plans[index];
      const registration = createCompletedAudioJobRegistration(
        currentProject,
        job,
        {
          activate: false,
          clipId: outputClipId,
          label: `SA3 T2A Take ${String(existingTakeCount + index + 1).padStart(2, '0')}`,
          sourceAvailability: options.sourceAvailability,
        },
      );

      if (
        !registration.canRegister ||
        registration.status !== 'REGISTERED' ||
        !isValidTextToAudioRegistration(registration, plan, job)
      ) {
        return batchBlocked(
          history,
          workspace,
          'stable-audio-3-t2a-batch-registration-failed',
          registration.canRegister
            ? 'SA3 T2A batch did not produce one valid Audio Take per completed Job.'
            : registration.message,
        );
      }

      currentProject = registration.project;
      artifacts.push(registration.artifact);
      clipTakes.push(registration.clipTake);
    }

    const firstClipTake = clipTakes[0];

    if (!firstClipTake) {
      return batchBlocked(
        history,
        workspace,
        'stable-audio-3-t2a-batch-registration-empty',
        'SA3 T2A batch completed without a registered Take.',
      );
    }

    const activation = activateClipTake(
      currentProject,
      outputClipId,
      firstClipTake.clipTakeId,
      { sourceAvailability: options.sourceAvailability },
    );

    if (!activation.canActivate) {
      return batchBlocked(
        history,
        workspace,
        'stable-audio-3-t2a-batch-activation-failed',
        activation.message,
      );
    }

    currentProject = activation.project;
    const location = findUniqueClipLocation(currentProject, outputClipId);

    if (!location) {
      return batchBlocked(
        history,
        workspace,
        'stable-audio-3-t2a-batch-output-missing',
        'SA3 T2A output Clip disappeared during batch settlement.',
      );
    }

    const finishedAtValues = jobs
      .map((job) => job.finishedAt as string)
      .sort();
    const finishedAt = finishedAtValues[finishedAtValues.length - 1] as string;
    const edit = Object.freeze({
      category: 'clip' as const,
      createdAt: finishedAt,
      id: `edit-${jobs.map((job) => job.jobId).join('-')}-sa3-t2a-batch`,
      label: `Generate ${clipTakes.length} ${clipTakes.length === 1 ? 'Take' : 'Takes'} for ${location.clip.name}`,
    });
    const nextWorkspace: Workspace = {
      ...workspace,
      project: currentProject,
      selectedClipId:
        target.kind === 'new' ? outputClipId : workspace.selectedClipId,
    };
    const nextHistory = commitSessionEdit(
      history,
      nextWorkspace,
      edit,
      options.historyLimit,
    );

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
    return batchBlocked(
      history,
      workspace,
      'stable-audio-3-t2a-batch-settlement-exception',
      error instanceof Error
        ? error.message
        : 'SA3 T2A batch settlement failed unexpectedly.',
    );
  }
}

function doesPlanMatchBatch(
  first: StableAudio3TextToAudioJobPlan,
  candidate: StableAudio3TextToAudioJobPlan,
): boolean {
  const firstRequest = {
    ...first.request,
    parameters: { ...first.request.parameters, seed: 0 },
  };
  const candidateRequest = {
    ...candidate.request,
    parameters: { ...candidate.request.parameters, seed: 0 },
  };

  return (
    areJsonValuesEqual(first.output, candidate.output) &&
    areJsonValuesEqual(first.runtime, candidate.runtime) &&
    areJsonValuesEqual(firstRequest, candidateRequest)
  );
}

function batchBlocked<Workspace extends StableAudio3TextToAudioWorkspace>(
  history: SessionEditHistory<Workspace>,
  workspace: Workspace,
  cause: string,
  message: string,
): Extract<
  StableAudio3TextToAudioBatchSettlementResult<Workspace>,
  { settled: false }
> {
  return Object.freeze({
    cause,
    history,
    message,
    settled: false as const,
    status: 'BLOCKED' as const,
    workspace,
  });
}

function doesJobMatchPlan(
  job: LocalEngineGpuJobRecord,
  plan: StableAudio3TextToAudioJobPlan,
): boolean {
  if (
    plan.kind !== 'local-engine-gpu-job' ||
    plan.output.materialization.kind !== 'after-generation-success' ||
    plan.output.generationRegion.output.kind !== 'first-clip-take' ||
    plan.output.generationRegion.outputTarget.kind !== 'new-track' ||
    plan.output.generationRegion.output.clipId !==
      plan.output.generationRegion.region.regionId ||
    plan.output.generationRegion.output.trackId !==
      plan.output.generationRegion.outputTarget.trackId ||
    plan.output.generationPosition.resolvedStartTick !==
      plan.output.generationRegion.region.startTick ||
    (plan.output.generationPosition.choice === 'playhead'
      ? plan.output.generationPosition.capturedPlayheadTick !==
        plan.output.generationPosition.resolvedStartTick
      : plan.output.generationPosition.choice !== 'timeline-start' ||
        plan.output.generationPosition.resolvedStartTick !== 0)
  ) {
    return false;
  }

  const expectedRequest = createStableAudio3TextToAudioJobRequest({
    durationSeconds: plan.output.generationRegion.durationSeconds,
    modelId: plan.request.modelId,
    modelRevision: plan.request.modelRevision,
    prompt: plan.request.parameters.prompt,
    providerId: plan.request.providerId,
    seed: plan.request.parameters.seed,
  });

  return (
    isLocalEngineJobId(job.jobId) &&
    job.providerId === STABLE_AUDIO_3_PROVIDER_ID &&
    job.modelId === STABLE_AUDIO_3_MODEL_ID &&
    job.modelRevision === expectedRequest.modelRevision &&
    job.taskId === STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID &&
    areJsonValuesEqual(plan.request, expectedRequest) &&
    areJsonValuesEqual(job.request, expectedRequest)
  );
}

function resolveExistingSettlement(
  project: ProjectState,
  plan: StableAudio3TextToAudioJobPlan,
  job: LocalEngineGpuJobRecord,
):
  | Readonly<{
      details: StableAudio3TextToAudioSettlementDetails;
      status: 'ALREADY_SETTLED';
    }>
  | Readonly<{
      cause: string;
      message: string;
      status: 'CONFLICT';
    }>
  | Readonly<{ status: 'NOT_SETTLED' }> {
  const clipId = plan.output.generationRegion.output.clipId;
  const locations = findClipLocations(project, clipId);

  if (locations.length === 0) {
    return Object.freeze({ status: 'NOT_SETTLED' as const });
  }

  if (
    locations.length !== 1 ||
    locations[0].track.id !== plan.output.generationRegion.output.trackId
  ) {
    return Object.freeze({
      cause: 'stable-audio-3-t2a-output-identity-conflict',
      message: 'Reserved SA3 T2A output identities are already used by another Project item.',
      status: 'CONFLICT' as const,
    });
  }

  const registration = createCompletedAudioJobRegistration(project, job, {
    clipId,
    label: TAKE_LABEL,
  });

  if (
    !registration.canRegister ||
    registration.status !== 'ALREADY_REGISTERED' ||
    !isValidTextToAudioRegistration(registration, plan, job)
  ) {
    return Object.freeze({
      cause: 'stable-audio-3-t2a-output-partially-materialized',
      message: 'Reserved SA3 T2A output exists without the exact completed Job registration.',
      status: 'CONFLICT' as const,
    });
  }

  return Object.freeze({
    details: Object.freeze({
      artifact: registration.artifact,
      clip: locations[0].clip,
      clipTake: registration.clipTake,
      track: locations[0].track,
    }),
    status: 'ALREADY_SETTLED' as const,
  });
}

type CompletedAudioRegistration = Extract<
  ProjectArtifactRegistrationUpdate,
  { canRegister: true }
>;

function isValidTextToAudioRegistration(
  registration: CompletedAudioRegistration,
  plan: StableAudio3TextToAudioJobPlan,
  job: LocalEngineGpuJobRecord,
): registration is CompletedAudioRegistration &
  Readonly<{
    artifact: GeneratedAudioArtifact & { destination: 'stable-audio-3' };
    clipTake: GeneratedAudioClipTake;
  }> {
  const { artifact, clipTake } = registration;

  return (
    artifact.kind === 'audio' &&
    artifact.destination === STABLE_AUDIO_3_OUTPUT_DESTINATION &&
    artifact.sourceJobId === job.jobId &&
    artifact.provenance.providerId === STABLE_AUDIO_3_PROVIDER_ID &&
    artifact.provenance.modelId === STABLE_AUDIO_3_MODEL_ID &&
    artifact.provenance.modelRevision === plan.request.modelRevision &&
    artifact.provenance.taskId === STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID &&
    artifact.lineage.parentArtifactIds.length === 0 &&
    artifact.lineage.parentClipTakeIds.length === 0 &&
    artifact.audio.channels === STABLE_AUDIO_3_CHANNELS &&
    artifact.audio.mimeType === 'audio/wav' &&
    Math.abs(
      artifact.audio.durationSeconds - plan.request.parameters.durationSeconds,
    ) <=
      1 / STABLE_AUDIO_3_SAMPLE_RATE &&
    artifact.file.extension === '.wav' &&
    artifact.file.sizeBytes > 44 &&
    artifact.file.relativePath.startsWith('renders/stable-audio-3/') &&
    clipTake.mediaType === 'audio' &&
    clipTake.sourceType === 'job' &&
    clipTake.sourceJobId === job.jobId &&
    clipTake.artifactId === artifact.artifactId
  );
}

function createEditId(jobId: string): string {
  return `edit-${jobId}-sa3-t2a-settlement`;
}

function findUniqueClipLocation(
  project: ProjectState,
  clipId: string,
): Readonly<{ clip: Clip; track: Track }> | undefined {
  const locations = findClipLocations(project, clipId);
  return locations.length === 1 ? locations[0] : undefined;
}

function findClipLocations(
  project: ProjectState,
  clipId: string,
): Readonly<{ clip: Clip; track: Track }>[] {
  return project.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => clip.id === clipId)
      .map((clip) => ({ clip, track })),
  );
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => areJsonValuesEqual(value, right[index]))
    );
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        areJsonValuesEqual(left[key], right[key]),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blocked<Workspace extends StableAudio3TextToAudioWorkspace>(
  history: SessionEditHistory<Workspace>,
  workspace: Workspace,
  reason: Extract<
    StableAudio3TextToAudioSettlementResult<Workspace>,
    { settled: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  StableAudio3TextToAudioSettlementResult<Workspace>,
  { settled: false }
> {
  return Object.freeze({
    cause,
    history,
    message,
    reason,
    settled: false as const,
    status: 'BLOCKED' as const,
    workspace,
  });
}
