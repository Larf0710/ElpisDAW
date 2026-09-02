import { createSynchronizedClipSourceFile } from './clipSourceSynchronization';
import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import {
  createProjectStemPrintPlanSha256,
  parseProjectStemPrintApiOperation,
  type ProjectStemPrintApiOperation,
  type ProjectStemPrintApiRequest,
} from './projectStemPrintApi';
import {
  preflightProjectStemPrintRegistration,
  type ProjectStemPrintRegistrationIntent,
  type ProjectStemPrintRegistrationIntentFailureReason,
} from './projectStemPrintRegistrationIntent';
import { reconcileProjectMixerState } from './projectMixerState';
import type {
  Clip,
  ProjectState,
  ProjectStemPrintAudioArtifact,
  ProjectStemPrintAudioClipTake,
  Track,
} from './types';

export type ProjectStemPrintRegistrationFailureReason =
  | ProjectStemPrintRegistrationIntentFailureReason
  | 'artifact-unavailable'
  | 'operation-invalid';

export type ProjectStemPrintRegistrationUpdate =
  | Readonly<{
      artifact: ProjectStemPrintAudioArtifact;
      canRegister: true;
      clipTake: ProjectStemPrintAudioClipTake;
      project: ProjectState;
      status: 'ALREADY_REGISTERED' | 'REGISTERED';
    }>
  | Readonly<{
      canRegister: false;
      message: string;
      reason: ProjectStemPrintRegistrationFailureReason;
    }>;

export type ProjectStemPrintArtifactCandidate =
  | Readonly<{
      artifact: ProjectStemPrintAudioArtifact;
      canPrepare: true;
      status: 'ALREADY_REGISTERED' | 'READY';
    }>
  | Readonly<{
      canPrepare: false;
      message: string;
      reason: ProjectStemPrintRegistrationFailureReason;
    }>;

export type ProjectStemPrintRegistrationOptions = Readonly<{
  intent: ProjectStemPrintRegistrationIntent;
  sourceAvailability?: GeneratedAudioCommitAvailabilityEvidence;
}>;

export async function createProjectStemPrintArtifactCandidate(
  project: ProjectState,
  requestValue: unknown,
  operationValue: unknown,
  intent: ProjectStemPrintRegistrationIntent,
): Promise<ProjectStemPrintArtifactCandidate> {
  const prepared = await prepareRegistration(
    project,
    requestValue,
    operationValue,
    intent,
  );

  if (!prepared.canPrepare) {
    return prepared;
  }

  return Object.freeze({
    artifact: prepared.artifact,
    canPrepare: true as const,
    status: prepared.status,
  });
}

export async function createProjectStemPrintTrackRegistration(
  project: ProjectState,
  requestValue: unknown,
  operationValue: unknown,
  options: ProjectStemPrintRegistrationOptions,
): Promise<ProjectStemPrintRegistrationUpdate> {
  const prepared = await prepareRegistration(
    project,
    requestValue,
    operationValue,
    options.intent,
  );

  if (!prepared.canPrepare) {
    return Object.freeze({
      canRegister: false as const,
      message: prepared.message,
      reason: prepared.reason,
    });
  }

  if (prepared.status === 'ALREADY_REGISTERED') {
    return Object.freeze({
      artifact: prepared.artifact,
      canRegister: true as const,
      clipTake: prepared.clipTake,
      project,
      status: 'ALREADY_REGISTERED' as const,
    });
  }

  const request = prepared.request;
  const artifact = prepared.artifact;
  const clipTake = prepared.clipTake;

  if (!doesAvailabilityConfirm(options.sourceAvailability, artifact.artifactId)) {
    return fail(
      'artifact-unavailable',
      'Stem Print must be verified with the Local Engine before Project registration.',
    );
  }

  const sourceFile = createSynchronizedClipSourceFile(
    artifact,
    undefined,
    options.sourceAvailability,
  );
  const clip: Clip = {
    activeClipTakeId: clipTake.clipTakeId,
    audioTiming: {
      sourceEndSeconds: artifact.audio.durationSeconds,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    },
    clipTakes: [clipTake],
    color: '#c4a7e7',
    createdAt: artifact.createdAt,
    id: options.intent.output.clipId,
    lengthTicks: request.plan.endTick - request.plan.startTick,
    name: options.intent.output.clipName,
    sourceFile,
    startTick: request.plan.startTick,
    type: 'mixdown',
    version: 1,
  };
  const track: Track = {
    clips: [clip],
    id: options.intent.output.trackId,
    level: 0,
    muted: true,
    name: options.intent.output.trackName,
    type: 'audio',
  };
  const nextProject = reconcileProjectMixerState({
    ...project,
    artifacts: [...(project.artifacts ?? []), artifact],
    tracks: [...project.tracks, track],
  });

  return Object.freeze({
    artifact,
    canRegister: true as const,
    clipTake,
    project: nextProject,
    status: 'REGISTERED' as const,
  });
}

type PreparedStemPrintRegistration =
  | Readonly<{
      artifact: ProjectStemPrintAudioArtifact;
      canPrepare: true;
      clipTake: ProjectStemPrintAudioClipTake;
      request: ProjectStemPrintApiRequest;
      status: 'ALREADY_REGISTERED' | 'READY';
    }>
  | Extract<ProjectStemPrintArtifactCandidate, { canPrepare: false }>;

async function prepareRegistration(
  project: ProjectState,
  requestValue: unknown,
  operationValue: unknown,
  intent: ProjectStemPrintRegistrationIntent,
): Promise<PreparedStemPrintRegistration> {
  const request = requestValue as ProjectStemPrintApiRequest;
  let operation: ProjectStemPrintApiOperation | undefined;

  try {
    operation = parseProjectStemPrintApiOperation(
      operationValue,
      request,
      await createProjectStemPrintPlanSha256(request.plan),
    );
  } catch {
    operation = undefined;
  }

  if (
    !operation ||
    operation.operationId !== intent.operationId ||
    operation.result.artifact.artifactId !== intent.output.artifactId
  ) {
    return candidateFail(
      'operation-invalid',
      'Completed Stem Print output does not match its registration intent.',
    );
  }

  const artifact = createArtifact(request, operation, intent);
  const clipTake = createClipTake(artifact, intent);
  const existing = resolveExisting(project, artifact, clipTake, intent);

  if (existing.status === 'CONFLICT') {
    return candidateFail('identity-conflict', existing.message);
  }

  if (existing.status === 'EXACT') {
    return Object.freeze({
      artifact: existing.artifact,
      canPrepare: true as const,
      clipTake: existing.clipTake,
      request,
      status: 'ALREADY_REGISTERED' as const,
    });
  }

  const preflight = preflightProjectStemPrintRegistration(
    project,
    requestValue,
    intent,
  );

  if (!preflight.canDispatch) {
    return candidateFail(preflight.reason, preflight.message);
  }

  return Object.freeze({
    artifact,
    canPrepare: true as const,
    clipTake,
    request,
    status: 'READY' as const,
  });
}

function createArtifact(
  request: ProjectStemPrintApiRequest,
  operation: ProjectStemPrintApiOperation,
  intent: ProjectStemPrintRegistrationIntent,
): ProjectStemPrintAudioArtifact {
  const completed = operation.result;
  const inputClipIds = unique(
    request.plan.tracks.flatMap((track) => track.events.map((event) => event.clipId)),
  );

  return freezeRecursively({
    artifactId: completed.artifact.artifactId,
    audio: {
      bitsPerSample: completed.stemPrint.bitsPerSample,
      channels: completed.stemPrint.channels,
      durationSeconds: completed.stemPrint.durationSeconds,
      frameCount: completed.stemPrint.frameCount,
      mimeType: completed.stemPrint.mimeType,
      sampleRate: completed.stemPrint.sampleRate,
    },
    createdAt: completed.artifact.createdAt,
    destination: 'stem-print' as const,
    file: { ...completed.artifact.file },
    kind: 'audio' as const,
    lineage: {
      parentArtifactIds: [...intent.sourceLineage.parentArtifactIds],
      parentClipTakeIds: [...intent.sourceLineage.parentClipTakeIds],
    },
    sourceOperationId: operation.operationId,
    stemPrintProvenance: {
      canonicalPlanJson: intent.canonicalPlanJson,
      inputClipIds,
      inputSourceIds: request.plan.sources.map((source) => source.sourceId),
      inputTrackIds: request.plan.tracks.map((track) => track.trackId),
      operationProtocolVersion: operation.protocolVersion,
      planSha256: completed.artifact.provenance.planSha256,
      planVersion: completed.artifact.provenance.planVersion,
      rendererId: completed.artifact.provenance.rendererId,
      rendererVersion: completed.artifact.provenance.rendererVersion,
      schemaVersion: 1 as const,
      selectedTargets: completed.artifact.provenance.selectedTargets.map(
        (target) => ({ ...target }),
      ),
    },
  });
}

function createClipTake(
  artifact: ProjectStemPrintAudioArtifact,
  intent: ProjectStemPrintRegistrationIntent,
): ProjectStemPrintAudioClipTake {
  return Object.freeze({
    artifactId: artifact.artifactId,
    clipTakeId: intent.output.clipTakeId,
    createdAt: artifact.createdAt,
    label: intent.output.clipName,
    mediaType: 'audio' as const,
    sourceOperationId: artifact.sourceOperationId,
    sourceType: 'stem-print' as const,
  });
}

function resolveExisting(
  project: ProjectState,
  expectedArtifact: ProjectStemPrintAudioArtifact,
  expectedClipTake: ProjectStemPrintAudioClipTake,
  intent: ProjectStemPrintRegistrationIntent,
):
  | Readonly<{
      artifact: ProjectStemPrintAudioArtifact;
      clipTake: ProjectStemPrintAudioClipTake;
      status: 'EXACT';
    }>
  | Readonly<{ message: string; status: 'CONFLICT' }>
  | Readonly<{ status: 'NONE' }> {
  const artifacts = (project.artifacts ?? []).filter(
    (artifact) =>
      artifact.artifactId === intent.output.artifactId ||
      ('sourceOperationId' in artifact &&
        artifact.sourceOperationId === intent.operationId),
  );
  const tracks = project.tracks.filter((track) => track.id === intent.output.trackId);
  const clips = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === intent.output.clipId);
  const clipTakes = project.tracks
    .flatMap((track) => track.clips)
    .flatMap((clip) => clip.clipTakes ?? [])
    .filter((take) => take.clipTakeId === intent.output.clipTakeId);

  if (
    artifacts.length === 0 &&
    tracks.length === 0 &&
    clips.length === 0 &&
    clipTakes.length === 0
  ) {
    return Object.freeze({ status: 'NONE' as const });
  }

  const artifact = artifacts[0];
  const track = tracks[0];
  const clip = clips[0];
  const clipTake = clipTakes[0];
  const exact =
    artifacts.length === 1 &&
    tracks.length === 1 &&
    clips.length === 1 &&
    clipTakes.length === 1 &&
    artifact?.kind === 'audio' &&
    artifact.destination === 'stem-print' &&
    clipTake?.mediaType === 'audio' &&
    clipTake.sourceType === 'stem-print' &&
    track?.clips.length === 1 &&
    track.clips[0] === clip &&
    track.id === intent.output.trackId &&
    track.name === intent.output.trackName &&
    track.type === 'audio' &&
    track.level === 0 &&
    track.muted === true &&
    clip.id === intent.output.clipId &&
    clip.name === intent.output.clipName &&
    clip.type === 'mixdown' &&
    clip.startTick === 0 &&
    clip.lengthTicks > 0 &&
    clip.clipTakes?.length === 1 &&
    clip.activeClipTakeId === clipTake.clipTakeId &&
    clip.sourceFile?.sourceId === artifact.artifactId &&
    clip.sourceFile.relativePath === artifact.file.relativePath &&
    clip.sourceFile.status === 'available' &&
    areJsonValuesEqual(artifact, expectedArtifact) &&
    areJsonValuesEqual(clipTake, expectedClipTake);

  return exact
    ? Object.freeze({
        artifact,
        clipTake,
        status: 'EXACT' as const,
      })
    : Object.freeze({
        message: 'Reserved Stem Print output identities are already used by a different or partial Project result.',
        status: 'CONFLICT' as const,
      });
}

function doesAvailabilityConfirm(
  evidence: GeneratedAudioCommitAvailabilityEvidence | undefined,
  artifactId: string,
): boolean {
  return Boolean(
    evidence &&
    !Number.isNaN(Date.parse(evidence.checkedAt)) &&
    new Set(evidence.availableArtifactIds).size ===
      evidence.availableArtifactIds.length &&
    evidence.availableArtifactIds.length === 1 &&
    evidence.availableArtifactIds[0] === artifactId,
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function freezeRecursively<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(freezeRecursively);
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeRecursively);
  }
  return typeof value === 'object' && value !== null ? Object.freeze(value) : value;
}

function fail(
  reason: ProjectStemPrintRegistrationFailureReason,
  message: string,
): ProjectStemPrintRegistrationUpdate {
  return Object.freeze({ canRegister: false as const, message, reason });
}

function candidateFail(
  reason: ProjectStemPrintRegistrationFailureReason,
  message: string,
): Extract<ProjectStemPrintArtifactCandidate, { canPrepare: false }> {
  return Object.freeze({
    canPrepare: false as const,
    message,
    reason,
  });
}
