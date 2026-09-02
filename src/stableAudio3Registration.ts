import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_OUTPUT_DESTINATION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import {
  createCompletedAudioJobRegistration,
  type ProjectArtifactRegistrationFailureReason,
  type ProjectArtifactRegistrationUpdate,
} from './projectArtifactRegistration';
import { createStableAudio3JobRequest } from './stableAudio3JobContract';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';

export type StableAudio3RegistrationOptions = Readonly<{
  activate?: boolean;
  label?: string;
  sourceClipId: string;
  targetClipId: string;
}>;

export type StableAudio3RegistrationFailureReason =
  | ProjectArtifactRegistrationFailureReason
  | 'job-contract-invalid'
  | 'source-audio-unavailable'
  | 'target-role-invalid'
  | 'target-source-mismatch';

export type StableAudio3RegistrationUpdate =
  | Readonly<{
      artifact: GeneratedAudioArtifact & { destination: 'stable-audio-3' };
      canRegister: true;
      clipTake: GeneratedAudioClipTake;
      project: ProjectState;
      status: 'ALREADY_REGISTERED' | 'REGISTERED';
    }>
  | Readonly<{
      canRegister: false;
      message: string;
      reason: StableAudio3RegistrationFailureReason;
    }>;

export function createStableAudio3Registration(
  project: ProjectState,
  job: LocalEngineGpuJobRecord,
  options: StableAudio3RegistrationOptions,
): StableAudio3RegistrationUpdate {
  const sourceClip = findUniqueClip(project, options.sourceClipId);

  if (!sourceClip) {
    return fail(
      'clip-not-found',
      `Stable Audio 3 source Clip does not resolve uniquely: ${options.sourceClipId}.`,
    );
  }

  const targetClip = findUniqueClip(project, options.targetClipId);

  if (!targetClip) {
    return fail(
      'clip-not-found',
      `Stable Audio 3 target Clip does not resolve uniquely: ${options.targetClipId}.`,
    );
  }

  const targetFailure = validateTargetRole(sourceClip, targetClip);

  if (targetFailure) {
    return targetFailure;
  }

  if (job.state !== 'COMPLETED') {
    return fail(
      'job-not-completed',
      `Stable Audio 3 registration requires a COMPLETED Job, not ${job.state}.`,
    );
  }

  if (
    job.providerId !== STABLE_AUDIO_3_PROVIDER_ID ||
    job.modelId !== STABLE_AUDIO_3_MODEL_ID ||
    job.taskId !== STABLE_AUDIO_3_TASK_ID
  ) {
    return fail(
      'job-contract-invalid',
      'Completed Job does not use the Stable Audio 3 v0.1 Provider contract.',
    );
  }

  if (hasJobRegistrationFootprint(project, job.jobId)) {
    return validateCompletedRegistration(
      createCompletedAudioJobRegistration(project, job, {
        activate: options.activate,
        clipId: options.targetClipId,
        label: options.label,
      }),
      job,
    );
  }

  const source = resolveActiveAudioTakeSource(project, options.sourceClipId);

  if (!source.canResolve) {
    return fail(
      'source-audio-unavailable',
      `Stable Audio 3 source is unavailable: ${source.message}`,
    );
  }

  const expectedRequest = createExpectedRequest(job, source.plan);

  if (!expectedRequest || !areJsonValuesEqual(job.request, expectedRequest)) {
    return fail(
      'job-contract-invalid',
      'Stable Audio 3 Job no longer matches the current Active Audio Take or request contract.',
    );
  }

  return validateCompletedRegistration(
    createCompletedAudioJobRegistration(project, job, {
      activate: options.activate,
      clipId: options.targetClipId,
      label: options.label,
    }),
    job,
  );
}

function validateTargetRole(
  sourceClip: Clip,
  targetClip: Clip,
): StableAudio3RegistrationUpdate | undefined {
  if (targetClip.type === 'instrument-audio') {
    if (sourceClip.type !== 'instrument-audio') {
      return fail(
        'target-role-invalid',
        'An Instrument Stable Audio 3 Take requires an Instrument Audio source.',
      );
    }

    if (
      targetClip.id !== sourceClip.id &&
      targetClip.sourceClipId !== sourceClip.id
    ) {
      return fail(
        'target-source-mismatch',
        'Instrument Stable Audio 3 target must be the source Clip or derive from it.',
      );
    }

    return undefined;
  }

  if (targetClip.type === 'master') {
    if (sourceClip.type !== 'mixdown') {
      return fail(
        'target-role-invalid',
        'A Stable Audio 3 Master Take requires a Raw Mixdown source.',
      );
    }

    if (targetClip.id === sourceClip.id || targetClip.sourceClipId !== sourceClip.id) {
      return fail(
        'target-source-mismatch',
        'Stable Audio 3 Master target must derive from the selected Raw Mixdown Clip.',
      );
    }

    return undefined;
  }

  return fail(
    'target-role-invalid',
    'Stable Audio 3 output can register only as an Instrument Audio Take or Master Take.',
  );
}

function createExpectedRequest(
  job: LocalEngineGpuJobRecord,
  plan: Parameters<typeof createStableAudio3JobRequest>[0]['plan'],
) {
  const parameters = isRecord(job.request.parameters)
    ? job.request.parameters
    : undefined;

  if (!parameters) {
    return undefined;
  }

  try {
    return createStableAudio3JobRequest({
      durationSeconds: parameters.durationSeconds as number,
      modelId: job.modelId,
      modelRevision: job.modelRevision,
      plan,
      prompt: parameters.prompt as string,
      providerId: job.providerId,
      seed: parameters.seed as number,
      strength: parameters.strength as number,
    });
  } catch {
    return undefined;
  }
}

function validateCompletedRegistration(
  registration: ProjectArtifactRegistrationUpdate,
  job: LocalEngineGpuJobRecord,
): StableAudio3RegistrationUpdate {
  if (!registration.canRegister) {
    return registration;
  }

  const { artifact, clipTake } = registration;

  if (
    artifact.kind !== 'audio' ||
    artifact.destination !== STABLE_AUDIO_3_OUTPUT_DESTINATION ||
    artifact.provenance.providerId !== STABLE_AUDIO_3_PROVIDER_ID ||
    artifact.provenance.modelId !== STABLE_AUDIO_3_MODEL_ID ||
    artifact.provenance.taskId !== STABLE_AUDIO_3_TASK_ID ||
    artifact.audio.channels !== STABLE_AUDIO_3_CHANNELS ||
    artifact.audio.mimeType !== 'audio/wav' ||
    artifact.file.extension !== '.wav' ||
    artifact.file.sizeBytes <= 44 ||
    !artifact.file.relativePath.startsWith('renders/stable-audio-3/') ||
    clipTake.mediaType !== 'audio' ||
    clipTake.sourceType !== 'job' ||
    clipTake.sourceJobId !== job.jobId
  ) {
    return fail(
      'job-result-invalid',
      'Completed Stable Audio 3 Job did not produce one finalized stereo WAV Audio Take.',
    );
  }

  const stableArtifact = artifact as GeneratedAudioArtifact & {
    destination: 'stable-audio-3';
  };

  return {
    artifact: stableArtifact,
    canRegister: true,
    clipTake,
    project: registration.project,
    status: registration.status,
  };
}

function hasJobRegistrationFootprint(
  project: ProjectState,
  jobId: string,
): boolean {
  return Boolean(
    project.artifacts?.some(
      (artifact) =>
        artifact.kind === 'audio' &&
        'sourceJobId' in artifact &&
        artifact.sourceJobId === jobId,
    ) ||
      project.tracks.some((track) =>
        track.clips.some((clip) =>
          clip.clipTakes?.some(
            (take) => take.sourceType === 'job' && take.sourceJobId === jobId,
          ),
        ),
      ),
  );
}

function findUniqueClip(project: ProjectState, clipId: string): Clip | undefined {
  const matches = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);

  return matches.length === 1 ? matches[0] : undefined;
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

function fail(
  reason: StableAudio3RegistrationFailureReason,
  message: string,
): StableAudio3RegistrationUpdate {
  return {
    canRegister: false,
    message,
    reason,
  };
}
