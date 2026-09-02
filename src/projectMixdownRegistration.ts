import {
  PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
  PROJECT_MIXDOWN_OPERATION_ID_PREFIX,
  createProjectMixdownArtifactId,
  isProjectMixdownOperationId,
} from '../shared/projectMixdownApiProtocol.js';
import {
  RAW_MIXDOWN_BITS_PER_SAMPLE,
  RAW_MIXDOWN_CHANNELS,
  RAW_MIXDOWN_MIME_TYPE,
  RAW_MIXDOWN_PLAN_VERSION,
  RAW_MIXDOWN_SAMPLE_RATE,
  RAW_MIXDOWN_WAVE_FORMAT,
} from '../shared/rawMixdownProtocol.js';
import {
  MIXER_DSP_CONTRACT_VERSION_V2,
  decibelsToMixerGain,
} from '../shared/mixerDspContract.js';
import { MIXER_EFFECTS_CONTRACT_VERSION } from '../shared/mixerEffectsContract.js';
import { MIXER_METER_TAP_CONTRACT_VERSION } from '../shared/mixerMeterTapContract.js';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { isSourceBackedAudioClip } from './audioClipSource';
import {
  AUDIO_DURATION_EPSILON_SECONDS,
  getEffectiveAudioClipDurationSeconds,
  timelineTicksToSeconds,
} from './audioClipTiming';
import { doesClipTakeMatchArtifact } from './clipTakeActivation';
import { createSynchronizedClipSourceFile } from './clipSourceSynchronization';
import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import {
  parseProjectMixdownApiOperation,
  type ProjectMixdownApiOperation,
  type ProjectMixdownApiRequest,
} from './projectMixdownApi';
import { createCanonicalProjectMixdownPlanJson } from './projectMixdownPlanIdentity';
import {
  createProjectMixdownPlan,
} from './projectMixdownPlan';
import {
  PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2,
  assertProjectMixerRenderSnapshotV2,
  createProjectMixerRenderSnapshotV2,
  type ProjectMixerRenderSnapshotV2,
} from './projectMixerRenderSnapshot';
import { reconcileProjectMixerState } from './projectMixerState';
import type {
  ArtifactLineage,
  AudioArtifact,
  Clip,
  ProjectArtifact,
  ProjectMixdownAudioArtifact,
  ProjectMixdownAudioClipTake,
  ProjectState,
  Track,
} from './types';

export type ProjectMixdownRegistrationOptions = Readonly<{
  activate?: boolean;
  clipId: string;
  label?: string;
  sourceAvailability?: GeneratedAudioCommitAvailabilityEvidence;
}>;

export type ProjectMixdownRegistrationFailureReason =
  | 'artifact-conflict'
  | 'artifact-unavailable'
  | 'identity-conflict'
  | 'intent-invalid'
  | 'mixer-snapshot-stale'
  | 'operation-invalid'
  | 'plan-stale'
  | 'routing-cycle'
  | 'source-lineage-invalid'
  | 'target-is-input'
  | 'target-not-found'
  | 'target-not-master';

export type ProjectMixdownRegistrationUpdate =
  | Readonly<{
      artifact: ProjectMixdownAudioArtifact;
      canRegister: true;
      clipTake: ProjectMixdownAudioClipTake;
      project: ProjectState;
      status: 'ALREADY_REGISTERED' | 'REGISTERED';
    }>
  | Readonly<{
      canRegister: false;
      message: string;
      reason: ProjectMixdownRegistrationFailureReason;
    }>;

export type ProjectMixdownArtifactCandidate =
  | Readonly<{
      artifact: ProjectMixdownAudioArtifact;
      canPrepare: true;
      status: 'ALREADY_REGISTERED' | 'READY';
    }>
  | Readonly<{
      canPrepare: false;
      message: string;
      reason: ProjectMixdownRegistrationFailureReason;
    }>;

export const PROJECT_MIXDOWN_REGISTRATION_INTENT_VERSION = 2 as const;

export type ProjectMixdownRegistrationIntent = Readonly<{
  canonicalPlanJson: string;
  mixerSnapshot: ProjectMixerRenderSnapshotV2;
  operationId: string;
  output: Readonly<{
    artifactId: string;
    clipId: string;
    clipName: string;
    clipTakeId: string;
    trackId: string;
    trackName: string;
  }>;
  sourceLineage: Readonly<{
    parentArtifactIds: readonly string[];
    parentClipTakeIds: readonly string[];
  }>;
  version: typeof PROJECT_MIXDOWN_REGISTRATION_INTENT_VERSION;
}>;

export type ProjectMixdownRegistrationIntentResolution =
  | Readonly<{
      canCreate: true;
      intent: ProjectMixdownRegistrationIntent;
    }>
  | Readonly<{
      canCreate: false;
      message: string;
      reason: ProjectMixdownRegistrationFailureReason;
    }>;

export type ProjectMixdownRegistrationPreflight =
  | Readonly<{
      canDispatch: true;
      status: 'ALREADY_REGISTERED' | 'READY';
    }>
  | Readonly<{
      canDispatch: false;
      message: string;
      reason: ProjectMixdownRegistrationFailureReason;
    }>;

export type ProjectMixdownTrackRegistrationOptions = Readonly<{
  intent: ProjectMixdownRegistrationIntent;
  sourceAvailability?: GeneratedAudioCommitAvailabilityEvidence;
}>;

type ClipLocation = Readonly<{
  clip: Clip;
  clipIndex: number;
  track: Track;
  trackIndex: number;
}>;

type RequestPlanAuthority = Readonly<{
  canonicalPlanJson: string;
  inputClipIds: readonly string[];
  inputSourceIds: readonly string[];
  inputTrackIds: readonly string[];
  request: ProjectMixdownApiRequest;
}>;

type RegistrationPlanAuthority = RequestPlanAuthority &
  Readonly<{ operation: ProjectMixdownApiOperation }>;

type PreparedRegistration = Readonly<{
  artifact: ProjectMixdownAudioArtifact;
  artifacts: readonly ProjectArtifact[];
  authority: RegistrationPlanAuthority;
  existingTake?: ProjectMixdownAudioClipTake;
  status: 'ALREADY_REGISTERED' | 'READY';
  target: ClipLocation;
}>;

/** Legacy existing-Master-Clip path. Mixer Print must use the intent-based Track path below. */
export function createProjectMixdownArtifactCandidate(
  project: ProjectState,
  requestValue: unknown,
  operationValue: unknown,
  options: Pick<ProjectMixdownRegistrationOptions, 'clipId'>,
): ProjectMixdownArtifactCandidate {
  const prepared = prepareRegistration(
    project,
    requestValue,
    operationValue,
    options.clipId,
  );

  return 'reason' in prepared
    ? Object.freeze({
        canPrepare: false as const,
        message: prepared.message,
        reason: prepared.reason,
      })
    : Object.freeze({
        artifact: prepared.artifact,
        canPrepare: true as const,
        status: prepared.status,
      });
}

export function createProjectMixdownRegistrationIntent(
  project: ProjectState,
  requestValue: unknown,
  mixerSnapshotValue: unknown,
): ProjectMixdownRegistrationIntentResolution {
  const authority = parseRequestPlanAuthority(requestValue);

  if (!authority || !isDeeplyFrozen(mixerSnapshotValue)) {
    return intentFail(
      'intent-invalid',
      'Raw Mixdown requires one immutable Request and Mixer Render Snapshot.',
    );
  }

  const output = createOutputIdentity(authority.request.operationId, project);

  if (!output) {
    return intentFail(
      'intent-invalid',
      'Raw Mixdown output identities could not be reserved safely.',
    );
  }

  const snapshotCheck = validateCurrentPlanAndSnapshot(
    project,
    authority,
    mixerSnapshotValue,
  );

  if (!snapshotCheck.ok) {
    return intentFail(snapshotCheck.reason, snapshotCheck.message);
  }

  const sourceLineage = resolveInputLineage(project, authority.request);

  if (!sourceLineage) {
    return intentFail(
      'source-lineage-invalid',
      'Raw Mixdown input lineage does not match the immutable render Plan.',
    );
  }

  const intent = freezeRecursively({
    canonicalPlanJson: authority.canonicalPlanJson,
    mixerSnapshot: mixerSnapshotValue,
    operationId: authority.request.operationId,
    output,
    sourceLineage: {
      parentArtifactIds: [...sourceLineage.parentArtifactIds],
      parentClipTakeIds: [...sourceLineage.parentClipTakeIds],
    },
    version: PROJECT_MIXDOWN_REGISTRATION_INTENT_VERSION,
  }) as ProjectMixdownRegistrationIntent;
  const preflight = preflightProjectMixdownRegistration(
    project,
    authority.request,
    intent,
  );

  return preflight.canDispatch
    ? Object.freeze({ canCreate: true as const, intent })
    : intentFail(preflight.reason, preflight.message);
}

export function preflightProjectMixdownRegistration(
  project: ProjectState,
  requestValue: unknown,
  intentValue: unknown,
): ProjectMixdownRegistrationPreflight {
  const authority = parseRequestPlanAuthority(requestValue);
  const intent = parseRegistrationIntent(intentValue, authority);

  if (!authority || !intent) {
    return preflightFail(
      'intent-invalid',
      'Raw Mixdown registration intent is invalid or conflicts with its Request.',
    );
  }

  const existing = resolveExistingTrackRegistration(project, intent);

  if (existing.status === 'CONFLICT') {
    return preflightFail('identity-conflict', existing.message);
  }

  if (existing.status === 'EXACT') {
    return Object.freeze({
      canDispatch: true as const,
      status: 'ALREADY_REGISTERED' as const,
    });
  }

  const snapshotCheck = validateCurrentPlanAndSnapshot(
    project,
    authority,
    intent.mixerSnapshot,
  );

  if (!snapshotCheck.ok) {
    return preflightFail(snapshotCheck.reason, snapshotCheck.message);
  }

  const sourceLineage = resolveInputLineage(project, authority.request);

  if (
    !sourceLineage ||
    !areStringArraysEqual(
      sourceLineage.parentArtifactIds,
      intent.sourceLineage.parentArtifactIds,
    ) ||
    !areStringArraysEqual(
      sourceLineage.parentClipTakeIds,
      intent.sourceLineage.parentClipTakeIds,
    )
  ) {
    return preflightFail(
      'source-lineage-invalid',
      'Raw Mixdown input lineage changed after the registration intent was reserved.',
    );
  }

  if (hasUnsafeOutputRouting(project, authority, intent)) {
    return preflightFail(
      'routing-cycle',
      'Raw Mixdown output cannot be one of its own inputs or ancestors.',
    );
  }

  return Object.freeze({
    canDispatch: true as const,
    status: 'READY' as const,
  });
}

export function createProjectMixdownTrackArtifactCandidate(
  project: ProjectState,
  requestValue: unknown,
  operationValue: unknown,
  intentValue: unknown,
): ProjectMixdownArtifactCandidate {
  const authority = parseRegistrationAuthority(requestValue, operationValue);
  const intent = parseRegistrationIntent(intentValue, authority);

  if (
    !authority ||
    !intent ||
    authority.operation.result.artifact.artifactId !== intent.output.artifactId
  ) {
    return candidateFail(
      'operation-invalid',
      'Completed Raw Mixdown output does not match its reserved registration intent.',
    );
  }

  const preflight = preflightProjectMixdownRegistration(
    project,
    authority.request,
    intent,
  );

  if (!preflight.canDispatch) {
    return candidateFail(preflight.reason, preflight.message);
  }

  const existing = resolveExistingTrackRegistration(project, intent);

  if (existing.status === 'EXACT') {
    return Object.freeze({
      artifact: existing.artifact,
      canPrepare: true as const,
      status: 'ALREADY_REGISTERED' as const,
    });
  }

  return Object.freeze({
    artifact: createArtifact(authority, {
      parentArtifactIds: [...intent.sourceLineage.parentArtifactIds],
      parentClipTakeIds: [...intent.sourceLineage.parentClipTakeIds],
    }),
    canPrepare: true as const,
    status: 'READY' as const,
  });
}

export function createProjectMixdownTrackRegistration(
  project: ProjectState,
  requestValue: unknown,
  operationValue: unknown,
  options: ProjectMixdownTrackRegistrationOptions,
): ProjectMixdownRegistrationUpdate {
  const candidate = createProjectMixdownTrackArtifactCandidate(
    project,
    requestValue,
    operationValue,
    options.intent,
  );

  if (!candidate.canPrepare) {
    return Object.freeze({
      canRegister: false as const,
      message: candidate.message,
      reason: candidate.reason,
    });
  }

  const existing = resolveExistingTrackRegistration(project, options.intent);

  if (candidate.status === 'ALREADY_REGISTERED' && existing.status === 'EXACT') {
    return Object.freeze({
      artifact: existing.artifact,
      canRegister: true as const,
      clipTake: existing.clipTake,
      project,
      status: 'ALREADY_REGISTERED' as const,
    });
  }

  if (!doesAvailabilityEvidenceConfirm(options.sourceAvailability, candidate.artifact)) {
    return fail(
      'artifact-unavailable',
      'Raw Mixdown must be verified with the Local Engine before Project registration.',
    );
  }

  const intent = options.intent;
  const artifact = candidate.artifact;
  const clipTake = createIntentClipTake(artifact, intent);
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
    color: '#d8b25c',
    createdAt: artifact.createdAt,
    id: intent.output.clipId,
    lengthTicks: (requestValue as ProjectMixdownApiRequest).plan.endTick,
    name: intent.output.clipName,
    sourceFile,
    startTick: (requestValue as ProjectMixdownApiRequest).plan.startTick,
    type: 'mixdown',
    version: 1,
  };
  const track: Track = {
    clips: [clip],
    id: intent.output.trackId,
    level: 0,
    muted: true,
    name: intent.output.trackName,
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

/** Legacy existing-Master-Clip path retained only for compatibility coverage. */
export function createProjectMixdownRegistration(
  project: ProjectState,
  requestValue: unknown,
  operationValue: unknown,
  options: ProjectMixdownRegistrationOptions,
): ProjectMixdownRegistrationUpdate {
  const prepared = prepareRegistration(
    project,
    requestValue,
    operationValue,
    options.clipId,
  );

  if ('reason' in prepared) {
    return prepared;
  }

  const {
    artifact,
    artifacts,
    authority,
    existingTake,
    status,
    target,
  } = prepared;

  if (status === 'ALREADY_REGISTERED' && existingTake) {
    return Object.freeze({
      artifact,
      canRegister: true as const,
      clipTake: existingTake,
      project,
      status,
    });
  }

  if (!doesAvailabilityEvidenceConfirm(options.sourceAvailability, artifact)) {
    return fail(
      'artifact-unavailable',
      'Raw Mixdown must be verified with the Local Engine before Project registration.',
    );
  }

  const clipTake = createClipTake(
    artifact,
    normalizeTakeLabel(options.label, target.clip),
  );
  const clipTakes = [...(target.clip.clipTakes ?? []), clipTake];
  const activeClipTakeId =
    options.activate === false && target.clip.activeClipTakeId
      ? target.clip.activeClipTakeId
      : clipTake.clipTakeId;
  const activeClipTake = clipTakes.find(
    (candidate) => candidate.clipTakeId === activeClipTakeId,
  );
  const nextArtifacts = [...artifacts, artifact];
  const activeAudioArtifacts = activeClipTake
    ? nextArtifacts.filter(
        (candidate): candidate is AudioArtifact =>
          candidate.kind === 'audio' &&
          candidate.artifactId === activeClipTake.artifactId &&
          doesClipTakeMatchArtifact(activeClipTake, candidate),
      )
    : [];
  const activeAudioArtifact =
    activeAudioArtifacts.length === 1 ? activeAudioArtifacts[0] : undefined;

  if (activeClipTake?.mediaType === 'audio' && !activeAudioArtifact) {
    return fail(
      'artifact-conflict',
      'Active Master Audio Take does not resolve to one matching Project Artifact.',
    );
  }

  const activatesMixdown = activeClipTakeId === clipTake.clipTakeId;
  const nextSourceFile = activeAudioArtifact
    ? createSynchronizedClipSourceFile(
        activeAudioArtifact,
        target.clip.sourceFile,
        options.sourceAvailability,
      )
    : target.clip.sourceFile;
  const nextClip: Clip = {
    ...target.clip,
    activeClipTakeId,
    ...(activatesMixdown
      ? {
          audioTiming: {
            sourceEndSeconds: artifact.audio.durationSeconds,
            sourceStartSeconds: 0,
            timeBase: 'absolute-seconds' as const,
          },
          lengthTicks: authority.request.plan.endTick,
          startTick: authority.request.plan.startTick,
        }
      : {}),
    clipTakes,
    ...(nextSourceFile ? { sourceFile: nextSourceFile } : {}),
    version: target.clip.version + 1,
  };
  const nextProject: ProjectState = {
    ...project,
    artifacts: nextArtifacts,
    tracks: project.tracks.map((track, trackIndex) =>
      trackIndex === target.trackIndex
        ? {
            ...track,
            clips: track.clips.map((clip, clipIndex) =>
              clipIndex === target.clipIndex ? nextClip : clip,
            ),
          }
        : track,
    ),
  };

  return Object.freeze({
    artifact,
    canRegister: true as const,
    clipTake,
    project: nextProject,
    status: 'REGISTERED' as const,
  });
}

function prepareRegistration(
  project: ProjectState,
  requestValue: unknown,
  operationValue: unknown,
  clipId: string,
): PreparedRegistration | Extract<ProjectMixdownRegistrationUpdate, { canRegister: false }> {
  const authority = parseRegistrationAuthority(requestValue, operationValue);

  if (!authority) {
    return fail(
      'operation-invalid',
      'Raw Mixdown registration requires one matching versioned Request and completed Operation.',
    );
  }

  const target = findUniqueClipLocation(project, clipId);

  if (!target) {
    return fail(
      'target-not-found',
      `Raw Mixdown registration target does not resolve uniquely: ${clipId}.`,
    );
  }

  if (target.track.type !== 'master' || target.clip.type !== 'master') {
    return fail(
      'target-not-master',
      `${target.clip.name} is not a Master Audio Clip.`,
    );
  }

  if (authority.inputClipIds.includes(target.clip.id)) {
    return fail(
      'target-is-input',
      'Raw Mixdown cannot be registered onto a Master Clip that was also rendered as an input.',
    );
  }

  const artifacts = project.artifacts ?? [];
  const outputArtifactId = authority.operation.result.artifact.artifactId;
  const operationId = authority.operation.operationId;
  const matchingArtifacts = artifacts.filter(
    (candidate) =>
      candidate.artifactId === outputArtifactId ||
      ('sourceOperationId' in candidate &&
        candidate.sourceOperationId === operationId),
  );
  const matchingTakes = project.tracks.flatMap((track) =>
    track.clips.flatMap((clip) =>
      (clip.clipTakes ?? []).filter(
        (candidate) =>
          candidate.artifactId === outputArtifactId ||
          (candidate.sourceType === 'mixdown' &&
            candidate.sourceOperationId === operationId),
      ),
    ),
  );
  const existingArtifact = matchingArtifacts.find(
    (candidate): candidate is ProjectMixdownAudioArtifact =>
      candidate.kind === 'audio' &&
      'sourceOperationId' in candidate &&
      candidate.sourceOperationId === operationId,
  );
  const existingTake = matchingTakes.find(
    (candidate): candidate is ProjectMixdownAudioClipTake =>
      candidate.mediaType === 'audio' &&
      candidate.sourceType === 'mixdown' &&
      candidate.artifactId === outputArtifactId &&
      candidate.sourceOperationId === operationId &&
      (target.clip.clipTakes ?? []).includes(candidate),
  );
  const recoveredArtifact = existingArtifact
    ? createArtifact(authority, existingArtifact.lineage)
    : undefined;

  if (
    existingArtifact &&
    recoveredArtifact &&
    JSON.stringify(existingArtifact) === JSON.stringify(recoveredArtifact) &&
    existingTake &&
    existingTake.clipTakeId === createClipTakeId(outputArtifactId) &&
    matchingArtifacts.length === 1 &&
    matchingTakes.length === 1
  ) {
    return Object.freeze({
      artifact: existingArtifact,
      artifacts,
      authority,
      existingTake,
      status: 'ALREADY_REGISTERED' as const,
      target,
    });
  }

  if (matchingArtifacts.length > 0 || matchingTakes.length > 0) {
    return fail(
      'artifact-conflict',
      `Mixdown Operation ${operationId} or Artifact ${outputArtifactId} is already registered elsewhere.`,
    );
  }

  const lineage = resolveInputLineage(project, authority.request);

  if (!lineage) {
    return fail(
      'source-lineage-invalid',
      'Raw Mixdown input lineage no longer matches the immutable render Plan.',
    );
  }

  const artifact = createArtifact(authority, lineage);
  return Object.freeze({
    artifact,
    artifacts,
    authority,
    status: 'READY' as const,
    target,
  });
}

function parseRegistrationAuthority(
  requestValue: unknown,
  operationValue: unknown,
): RegistrationPlanAuthority | undefined {
  const requestAuthority = parseRequestPlanAuthority(requestValue);

  if (!requestAuthority) {
    return undefined;
  }

  const operation = parseProjectMixdownApiOperation(
    operationValue,
    requestAuthority.request.operationId,
  );

  if (
    !operation ||
    !doesOperationMatchPlan(
      requestAuthority.request.plan as unknown as Record<string, unknown>,
      operation,
    )
  ) {
    return undefined;
  }

  return Object.freeze({
    ...requestAuthority,
    operation,
  });
}

function parseRequestPlanAuthority(
  requestValue: unknown,
): RequestPlanAuthority | undefined {
  if (
    !isRecord(requestValue) ||
    !hasExactKeys(requestValue, ['operationId', 'plan', 'protocolVersion']) ||
    requestValue.protocolVersion !== PROJECT_MIXDOWN_API_PROTOCOL_VERSION ||
    !isProjectMixdownOperationId(requestValue.operationId) ||
    !isRecord(requestValue.plan)
  ) {
    return undefined;
  }

  const canonicalPlanJson = createCanonicalProjectMixdownPlanJson(
    requestValue.plan,
  );

  if (!canonicalPlanJson) {
    return undefined;
  }

  const planIdentity = parsePlanIdentity(requestValue.plan);

  if (!planIdentity) {
    return undefined;
  }

  return Object.freeze({
    ...planIdentity,
    canonicalPlanJson,
    request: requestValue as unknown as ProjectMixdownApiRequest,
  });
}

function parseRegistrationIntent(
  value: unknown,
  authority: RequestPlanAuthority | undefined,
): ProjectMixdownRegistrationIntent | undefined {
  if (
    !authority ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'canonicalPlanJson',
      'mixerSnapshot',
      'operationId',
      'output',
      'sourceLineage',
      'version',
    ]) ||
    value.version !== PROJECT_MIXDOWN_REGISTRATION_INTENT_VERSION ||
    value.operationId !== authority.request.operationId ||
    value.canonicalPlanJson !== authority.canonicalPlanJson ||
    !isDeeplyFrozen(value) ||
    !isRecord(value.output) ||
    !hasExactKeys(value.output, [
      'artifactId',
      'clipId',
      'clipName',
      'clipTakeId',
      'trackId',
      'trackName',
    ]) ||
    !isRecord(value.sourceLineage) ||
    !hasExactKeys(value.sourceLineage, [
      'parentArtifactIds',
      'parentClipTakeIds',
    ]) ||
    !isUniqueTrimmedTextArray(value.sourceLineage.parentArtifactIds) ||
    !isUniqueTrimmedTextArray(value.sourceLineage.parentClipTakeIds)
  ) {
    return undefined;
  }

  const artifactId = createProjectMixdownArtifactId(value.operationId);
  const operationSuffix = value.operationId.slice(
    PROJECT_MIXDOWN_OPERATION_ID_PREFIX.length,
  );

  if (
    !artifactId ||
    value.output.artifactId !== artifactId ||
    value.output.trackId !== `mixdown-track-${operationSuffix}` ||
    value.output.clipId !== `mixdown-clip-${operationSuffix}` ||
    value.output.clipTakeId !== `clip-take-${artifactId}` ||
    !isTrimmedText(value.output.trackName) ||
    !isTrimmedText(value.output.clipName) ||
    !isRecord(value.mixerSnapshot)
  ) {
    return undefined;
  }

  return value as unknown as ProjectMixdownRegistrationIntent;
}

function createOutputIdentity(
  operationId: string,
  project: ProjectState,
): ProjectMixdownRegistrationIntent['output'] | undefined {
  const artifactId = createProjectMixdownArtifactId(operationId);

  if (!artifactId) {
    return undefined;
  }

  const operationSuffix = operationId.slice(
    PROJECT_MIXDOWN_OPERATION_ID_PREFIX.length,
  );
  const outputNumber =
    (project.artifacts ?? []).filter(
      (artifact) => artifact.kind === 'audio' && artifact.destination === 'mixdown',
    ).length + 1;
  const name = `Raw Mix ${String(outputNumber).padStart(2, '0')}`;

  return Object.freeze({
    artifactId,
    clipId: `mixdown-clip-${operationSuffix}`,
    clipName: name,
    clipTakeId: `clip-take-${artifactId}`,
    trackId: `mixdown-track-${operationSuffix}`,
    trackName: name,
  });
}

function validateCurrentPlanAndSnapshot(
  project: ProjectState,
  authority: RequestPlanAuthority,
  expectedSnapshot: unknown,
):
  | Readonly<{ ok: true }>
  | Readonly<{
      message: string;
      ok: false;
      reason: 'mixer-snapshot-stale' | 'plan-stale';
    }> {
  if (!isDeeplyFrozen(expectedSnapshot)) {
    return Object.freeze({
      message: 'Raw Mixdown Mixer Render Snapshot is mutable or invalid.',
      ok: false as const,
      reason: 'mixer-snapshot-stale' as const,
    });
  }

  let currentSnapshot: ProjectMixerRenderSnapshotV2;

  try {
    currentSnapshot = createProjectMixerRenderSnapshotV2({
      mixer: project.mixer,
      tracks: project.tracks,
    });
  } catch {
    return Object.freeze({
      message: 'Raw Mixdown Mixer state is invalid or no longer complete.',
      ok: false as const,
      reason: 'mixer-snapshot-stale' as const,
    });
  }

  if (!areJsonValuesEqual(currentSnapshot, expectedSnapshot)) {
    return Object.freeze({
      message: 'Raw Mixdown Mixer state changed after its Snapshot was captured.',
      ok: false as const,
      reason: 'mixer-snapshot-stale' as const,
    });
  }

  let regenerated: ReturnType<typeof createProjectMixdownPlan>;

  try {
    regenerated = createProjectMixdownPlan({
      artifacts: project.artifacts,
      bpm: project.bpm,
      mixer: project.mixer,
      playheadTick: project.playheadTick,
      projectEndTick: project.totalTicks,
      selection: project.selection,
      sourceAvailability: Object.fromEntries(
        authority.inputSourceIds.map((sourceId) => [sourceId, 'openable' as const]),
      ),
      sourceDescriptors: authority.request.plan.sources,
      tracks: project.tracks,
    });
  } catch {
    return Object.freeze({
      message: 'Raw Mixdown Plan could not be revalidated against the current Project.',
      ok: false as const,
      reason: 'plan-stale' as const,
    });
  }

  if (
    !regenerated.canCreate ||
    createCanonicalProjectMixdownPlanJson(regenerated.plan) !==
      authority.canonicalPlanJson
  ) {
    return Object.freeze({
      message: 'Raw Mixdown Plan no longer matches the current Project.',
      ok: false as const,
      reason: 'plan-stale' as const,
    });
  }

  return Object.freeze({ ok: true as const });
}

function hasUnsafeOutputRouting(
  project: ProjectState,
  authority: RequestPlanAuthority,
  intent: ProjectMixdownRegistrationIntent,
): boolean {
  if (
    authority.inputTrackIds.includes(intent.output.trackId) ||
    authority.inputClipIds.includes(intent.output.clipId) ||
    authority.inputSourceIds.includes(intent.output.artifactId) ||
    intent.sourceLineage.parentArtifactIds.includes(intent.output.artifactId) ||
    intent.sourceLineage.parentClipTakeIds.includes(intent.output.clipTakeId) ||
    intent.mixerSnapshot.channels.some(
      (channel) => channel.trackId === intent.output.trackId,
    )
  ) {
    return true;
  }

  const artifactById = new Map(
    (project.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact]),
  );
  const pending = [...intent.sourceLineage.parentArtifactIds];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const artifactId = pending.pop();

    if (!artifactId || visited.has(artifactId)) {
      continue;
    }

    if (artifactId === intent.output.artifactId) {
      return true;
    }

    visited.add(artifactId);
    const artifact = artifactById.get(artifactId);

    if (!artifact) {
      continue;
    }

    if (
      artifact.kind === 'audio' &&
      artifact.destination === 'mixdown' &&
      'sourceOperationId' in artifact &&
      (artifact.mixdownProvenance.inputTrackIds.includes(intent.output.trackId) ||
        artifact.mixdownProvenance.inputClipIds.includes(intent.output.clipId) ||
        artifact.mixdownProvenance.inputSourceIds.includes(
          intent.output.artifactId,
        ))
    ) {
      return true;
    }

    if (artifact.lineage.parentClipTakeIds.includes(intent.output.clipTakeId)) {
      return true;
    }

    pending.push(...artifact.lineage.parentArtifactIds);
  }

  return false;
}

function parsePlanIdentity(
  plan: Record<string, unknown>,
): Pick<
  RegistrationPlanAuthority,
  'inputClipIds' | 'inputSourceIds' | 'inputTrackIds'
> | undefined {
  if (
    !hasExactKeys(plan, [
      'bpm',
      'durationSeconds',
      'endTick',
      'effectsContractVersion',
      'format',
      'masterFaderDb',
      'meterTapVersion',
      'mixerDspVersion',
      'mixerSnapshot',
      'mixerSnapshotVersion',
      'purpose',
      'sources',
      'startTick',
      'tracks',
      'version',
    ]) ||
    plan.version !== RAW_MIXDOWN_PLAN_VERSION ||
    plan.effectsContractVersion !== MIXER_EFFECTS_CONTRACT_VERSION ||
    plan.meterTapVersion !== MIXER_METER_TAP_CONTRACT_VERSION ||
    plan.mixerDspVersion !== MIXER_DSP_CONTRACT_VERSION_V2 ||
    plan.mixerSnapshotVersion !== PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2 ||
    plan.purpose !== 'mixdown' ||
    plan.startTick !== 0 ||
    !Number.isFinite(plan.bpm) ||
    (plan.bpm as number) <= 0 ||
    !Number.isFinite(plan.durationSeconds) ||
    (plan.durationSeconds as number) <= 0 ||
    !isRepresentableMixerFader(plan.masterFaderDb) ||
    !Number.isSafeInteger(plan.endTick) ||
    (plan.endTick as number) <= 0 ||
    !isRecord(plan.format) ||
    !doesFormatMatch(plan.format) ||
    !Array.isArray(plan.sources) ||
    plan.sources.length === 0 ||
    !Array.isArray(plan.tracks) ||
    plan.tracks.length === 0
  ) {
    return undefined;
  }

  try {
    assertProjectMixerRenderSnapshotV2(plan.mixerSnapshot);
  } catch {
    return undefined;
  }

  if (
    plan.mixerSnapshot.schemaVersion !== plan.mixerSnapshotVersion ||
    plan.mixerSnapshot.master.faderDb !== plan.masterFaderDb
  ) {
    return undefined;
  }

  const inputSourceIds: string[] = [];
  const sourceIds = new Set<string>();

  for (const source of plan.sources) {
    if (
      !isRecord(source) ||
      !isTrimmedText(source.sourceId) ||
      (source.kind !== 'generated' && source.kind !== 'external') ||
      sourceIds.has(source.sourceId)
    ) {
      return undefined;
    }

    sourceIds.add(source.sourceId);
    inputSourceIds.push(source.sourceId);
  }

  const inputTrackIds: string[] = [];
  const inputClipIds: string[] = [];
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  const referencedSourceIds = new Set<string>();

  for (const track of plan.tracks) {
    const expectedTrackKeys =
      isRecord(track) && track.groupTrackId === undefined
        ? ['events', 'gainDb', 'pan', 'trackId']
        : ['events', 'gainDb', 'groupTrackId', 'pan', 'trackId'];

    const mixerChannel = isRecord(track)
      ? plan.mixerSnapshot.channels.find(
          (channel) => channel.trackId === track.trackId,
        )
      : undefined;

    if (
      !isRecord(track) ||
      !hasExactKeys(track, expectedTrackKeys) ||
      !isTrimmedText(track.trackId) ||
      trackIds.has(track.trackId) ||
      !isRepresentableMixerFader(track.gainDb) ||
      !Number.isFinite(track.pan) ||
      (track.pan as number) < -1 ||
      (track.pan as number) > 1 ||
      !Array.isArray(track.events) ||
      track.events.length === 0
    ) {
      return undefined;
    }

    if (
      !mixerChannel ||
      mixerChannel.faderDb !== track.gainDb ||
      mixerChannel.pan !== track.pan
    ) {
      return undefined;
    }

    trackIds.add(track.trackId);
    inputTrackIds.push(track.trackId);

    for (const event of track.events) {
      if (
        !isRecord(event) ||
        !isTrimmedText(event.clipId) ||
        clipIds.has(event.clipId) ||
        !isTrimmedText(event.sourceId) ||
        !sourceIds.has(event.sourceId)
      ) {
        return undefined;
      }

      clipIds.add(event.clipId);
      inputClipIds.push(event.clipId);
      referencedSourceIds.add(event.sourceId);
    }
  }

  return referencedSourceIds.size === sourceIds.size
    ? Object.freeze({
        inputClipIds: Object.freeze(inputClipIds),
        inputSourceIds: Object.freeze(inputSourceIds),
        inputTrackIds: Object.freeze(inputTrackIds),
      })
    : undefined;
}

function doesOperationMatchPlan(
  plan: Record<string, unknown>,
  operation: ProjectMixdownApiOperation,
): boolean {
  return (
    operation.result.artifact.provenance.planVersion === plan.version &&
    operation.result.mixdown.frameCount ===
      Math.round((plan.durationSeconds as number) * RAW_MIXDOWN_SAMPLE_RATE) &&
    operation.result.mixdown.sourceCount ===
      (plan.sources as unknown[]).length &&
    operation.result.mixdown.trackCount ===
      (plan.tracks as unknown[]).length &&
    operation.result.artifact.file.sizeBytes ===
      44 + operation.result.mixdown.frameCount * 4
  );
}

function resolveInputLineage(
  project: ProjectState,
  request: ProjectMixdownApiRequest,
): ArtifactLineage | undefined {
  let mixerSnapshot: ProjectMixerRenderSnapshotV2;

  try {
    mixerSnapshot = createProjectMixerRenderSnapshotV2({
      mixer: project.mixer,
      tracks: project.tracks,
    });
  } catch {
    return undefined;
  }

  const mixerChannelByTrackId = new Map(
    mixerSnapshot.channels.map((channel) => [channel.trackId, channel]),
  );
  const hasSolo = mixerSnapshot.channels.some((channel) => channel.solo);
  const descriptors = new Map(
    request.plan.sources.map((source) => [source.sourceId, source]),
  );
  const parentArtifactIds: string[] = [];
  const parentClipTakeIds: string[] = [];

  if (
    request.plan.mixerDspVersion !== MIXER_DSP_CONTRACT_VERSION_V2 ||
    request.plan.mixerSnapshotVersion !== mixerSnapshot.schemaVersion ||
    request.plan.masterFaderDb !== mixerSnapshot.master.faderDb ||
    !areJsonValuesEqual(request.plan.mixerSnapshot, mixerSnapshot)
  ) {
    return undefined;
  }

  for (const plannedTrack of request.plan.tracks) {
    const tracks = project.tracks.filter(
      (track) => track.id === plannedTrack.trackId,
    );

    if (tracks.length !== 1) {
      return undefined;
    }

    const track = tracks[0];
    const mixerChannel = mixerChannelByTrackId.get(track.id);

    if (
      !mixerChannel ||
      mixerChannel.muted ||
      (hasSolo && !mixerChannel.solo) ||
      mixerChannel.faderDb !== plannedTrack.gainDb ||
      mixerChannel.pan !== plannedTrack.pan ||
      (plannedTrack.groupTrackId ?? undefined) !==
        (track.parentGroupId ?? undefined)
    ) {
      return undefined;
    }

    for (const event of plannedTrack.events) {
      const location = findUniqueClipLocation(project, event.clipId);
      const descriptor = descriptors.get(event.sourceId);

      if (
        !location ||
        location.track.id !== track.id ||
        !descriptor ||
        location.clip.name !== event.clipName
      ) {
        return undefined;
      }

      if (descriptor.kind === 'generated') {
        const source = resolveActiveAudioTakeSource(project, event.clipId);

        if (
          !source.canResolve ||
          source.plan.source.artifactId !== event.sourceId ||
          !doesGeneratedDescriptorMatch(
            source.plan.descriptor,
            descriptor,
          ) ||
          !doesEventMatchClip(
            event,
            source.plan.clip,
            request.plan.bpm,
            request.plan.endTick,
          )
        ) {
          return undefined;
        }

        addUnique(parentArtifactIds, source.plan.source.artifactId);
        addUnique(parentClipTakeIds, source.plan.source.clipTakeId);
        continue;
      }

      if (
        location.clip.activeClipTakeId ||
        !isSourceBackedAudioClip(location.clip) ||
        !doesExternalDescriptorMatch(location.clip, descriptor) ||
        !doesEventMatchClip(
          event,
          location.clip,
          request.plan.bpm,
          request.plan.endTick,
        )
      ) {
        return undefined;
      }
    }
  }

  return Object.freeze({
    parentArtifactIds: Object.freeze(parentArtifactIds) as string[],
    parentClipTakeIds: Object.freeze(parentClipTakeIds) as string[],
  });
}

function createArtifact(
  authority: RegistrationPlanAuthority,
  lineage: ArtifactLineage,
): ProjectMixdownAudioArtifact {
  const { artifact: outputArtifact, mixdown } = authority.operation.result;

  return {
    artifactId: outputArtifact.artifactId,
    audio: {
      bitsPerSample: RAW_MIXDOWN_BITS_PER_SAMPLE,
      channels: RAW_MIXDOWN_CHANNELS,
      durationSeconds: mixdown.durationSeconds,
      frameCount: mixdown.frameCount,
      mimeType: RAW_MIXDOWN_MIME_TYPE,
      sampleRate: RAW_MIXDOWN_SAMPLE_RATE,
    },
    createdAt: outputArtifact.createdAt,
    destination: 'mixdown',
    file: { ...outputArtifact.file },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [...lineage.parentArtifactIds],
      parentClipTakeIds: [...lineage.parentClipTakeIds],
    },
    mixdownProvenance: {
      canonicalPlanJson: authority.canonicalPlanJson,
      inputClipIds: [...authority.inputClipIds],
      inputSourceIds: [...authority.inputSourceIds],
      inputTrackIds: [...authority.inputTrackIds],
      operationProtocolVersion: PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
      planVersion: RAW_MIXDOWN_PLAN_VERSION,
      rendererId: outputArtifact.provenance.rendererId,
      rendererVersion: outputArtifact.provenance.rendererVersion,
      schemaVersion: 2,
    },
    sourceOperationId: authority.operation.operationId,
  };
}

function createClipTake(
  artifact: ProjectMixdownAudioArtifact,
  label: string,
): ProjectMixdownAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: createClipTakeId(artifact.artifactId),
    createdAt: artifact.createdAt,
    label,
    mediaType: 'audio',
    sourceOperationId: artifact.sourceOperationId,
    sourceType: 'mixdown',
  };
}

function createClipTakeId(artifactId: string): string {
  return `clip-take-${artifactId}`;
}

function normalizeTakeLabel(value: string | undefined, clip: Clip): string {
  const requestedLabel = value?.trim();

  if (requestedLabel) {
    return requestedLabel.slice(0, 128);
  }

  const takeNumber =
    (clip.clipTakes?.filter((take) => take.sourceType === 'mixdown').length ??
      0) + 1;
  return `Raw Mixdown ${String(takeNumber).padStart(2, '0')}`;
}

function findUniqueClipLocation(
  project: ProjectState,
  clipId: string,
): ClipLocation | undefined {
  const matches: ClipLocation[] = [];

  project.tracks.forEach((track, trackIndex) => {
    track.clips.forEach((clip, clipIndex) => {
      if (clip.id === clipId) {
        matches.push({ clip, clipIndex, track, trackIndex });
      }
    });
  });

  return matches.length === 1 ? matches[0] : undefined;
}

function doesGeneratedDescriptorMatch(
  actual: Readonly<{
    kind: 'generated';
    name: string;
    relativePath: string;
    sizeBytes: number;
    sourceId: string;
  }>,
  expected: ProjectMixdownApiRequest['plan']['sources'][number],
): boolean {
  return (
    expected.kind === 'generated' &&
    actual.sourceId === expected.sourceId &&
    actual.name === expected.name &&
    actual.relativePath === expected.relativePath &&
    actual.sizeBytes === expected.sizeBytes
  );
}

function doesExternalDescriptorMatch(
  clip: Clip,
  expected: Extract<
    ProjectMixdownApiRequest['plan']['sources'][number],
    { kind: 'external' }
  >,
): boolean {
  const sourceFile = clip.sourceFile;
  const path = sourceFile?.path?.trim() || sourceFile?.lastKnownPath?.trim();

  return Boolean(
    sourceFile &&
      sourceFile.sourceId === expected.sourceId &&
      sourceFile.name === expected.name &&
      sourceFile.sizeBytes === expected.sizeBytes &&
      sourceFile.lastModified === expected.lastModified &&
      path === expected.path &&
      !sourceFile.relativePath,
  );
}

function doesEventMatchClip(
  event: ProjectMixdownApiRequest['plan']['tracks'][number]['events'][number],
  clip: Clip & {
    audioTiming: NonNullable<Clip['audioTiming']>;
    sourceFile: NonNullable<Clip['sourceFile']> & { durationSeconds: number };
  },
  bpm: number,
  planEndTick: number,
): boolean {
  const originalStartTick = Math.round(clip.startTick);
  const originalEndTick =
    originalStartTick + Math.round(clip.lengthTicks);
  const timelineStartTick = Math.max(originalStartTick, 0);
  const timelineEndTick = Math.min(
    originalEndTick,
    planEndTick,
  );
  const sourceStartSeconds =
    clip.audioTiming.sourceStartSeconds +
    timelineTicksToSeconds(timelineStartTick - originalStartTick, bpm);
  const timelineDurationSeconds = timelineTicksToSeconds(
    timelineEndTick - timelineStartTick,
    bpm,
  );
  const sourceEndSeconds = Math.min(
    clip.audioTiming.sourceEndSeconds,
    clip.audioTiming.sourceStartSeconds +
      (timelineEndTick === originalEndTick
        ? getEffectiveAudioClipDurationSeconds(
            clip.audioTiming,
            clip.lengthTicks,
            bpm,
          )
        : timelineTicksToSeconds(
            timelineEndTick - originalStartTick,
            bpm,
          )),
  );
  const sourceDurationSeconds = sourceEndSeconds - sourceStartSeconds;

  return (
    timelineEndTick > timelineStartTick &&
    sourceDurationSeconds > 0 &&
    Math.abs(timelineDurationSeconds - sourceDurationSeconds) <=
      AUDIO_DURATION_EPSILON_SECONDS &&
    event.timelineStartTick === timelineStartTick &&
    event.timelineEndTick === timelineEndTick &&
    event.sourceStartSeconds === sourceStartSeconds &&
    event.startOffsetSeconds === timelineTicksToSeconds(timelineStartTick, bpm) &&
    event.durationSeconds === sourceDurationSeconds
  );
}

function doesFormatMatch(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(value, Object.keys(RAW_MIXDOWN_WAVE_FORMAT)) &&
    Object.entries(RAW_MIXDOWN_WAVE_FORMAT).every(
      ([key, expected]) => value[key] === expected,
    )
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function resolveExistingTrackRegistration(
  project: ProjectState,
  intent: ProjectMixdownRegistrationIntent,
):
  | Readonly<{ status: 'NONE' }>
  | Readonly<{
      artifact: ProjectMixdownAudioArtifact;
      clipTake: ProjectMixdownAudioClipTake;
      status: 'EXACT';
    }>
  | Readonly<{ message: string; status: 'CONFLICT' }> {
  const artifacts = (project.artifacts ?? []).filter(
    (artifact) =>
      artifact.artifactId === intent.output.artifactId ||
      ('sourceOperationId' in artifact &&
        artifact.sourceOperationId === intent.operationId),
  );
  const tracks = project.tracks.filter(
    (track) => track.id === intent.output.trackId,
  );
  const clips = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => clip.id === intent.output.clipId),
  );
  const clipTakes = project.tracks.flatMap((track) =>
    track.clips.flatMap((clip) =>
      (clip.clipTakes ?? []).filter(
        (take) =>
          take.clipTakeId === intent.output.clipTakeId ||
          (take.sourceType === 'mixdown' &&
            take.sourceOperationId === intent.operationId),
      ),
    ),
  );

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

  if (
    artifacts.length !== 1 ||
    tracks.length !== 1 ||
    clips.length !== 1 ||
    clipTakes.length !== 1 ||
    !artifact ||
    artifact.kind !== 'audio' ||
    artifact.destination !== 'mixdown' ||
    !('sourceOperationId' in artifact) ||
    artifact.sourceOperationId !== intent.operationId ||
    artifact.artifactId !== intent.output.artifactId ||
    artifact.mixdownProvenance.canonicalPlanJson !== intent.canonicalPlanJson ||
    !areStringArraysEqual(
      artifact.lineage.parentArtifactIds,
      intent.sourceLineage.parentArtifactIds,
    ) ||
    !areStringArraysEqual(
      artifact.lineage.parentClipTakeIds,
      intent.sourceLineage.parentClipTakeIds,
    ) ||
    !track ||
    track.type !== 'audio' ||
    !clip ||
    clip.type !== 'mixdown' ||
    !track.clips.includes(clip) ||
    !clipTake ||
    clipTake.mediaType !== 'audio' ||
    clipTake.sourceType !== 'mixdown' ||
    clipTake.sourceOperationId !== intent.operationId ||
    clipTake.artifactId !== artifact.artifactId ||
    !(clip.clipTakes ?? []).includes(clipTake) ||
    clip.activeClipTakeId !== clipTake.clipTakeId ||
    clip.sourceFile?.sourceId !== artifact.artifactId ||
    clip.sourceFile.relativePath !== artifact.file.relativePath ||
    clip.sourceFile.name !== artifact.file.name ||
    clip.sourceFile.sizeBytes !== artifact.file.sizeBytes
  ) {
    return Object.freeze({
      message:
        'Reserved Raw Mixdown output identities are already used by a different or partial Project result.',
      status: 'CONFLICT' as const,
    });
  }

  return Object.freeze({
    artifact,
    clipTake,
    status: 'EXACT' as const,
  });
}

function createIntentClipTake(
  artifact: ProjectMixdownAudioArtifact,
  intent: ProjectMixdownRegistrationIntent,
): ProjectMixdownAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: intent.output.clipTakeId,
    createdAt: artifact.createdAt,
    label: intent.output.clipName,
    mediaType: 'audio',
    sourceOperationId: intent.operationId,
    sourceType: 'mixdown',
  };
}

function isUniqueTrimmedTextArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(isTrimmedText) &&
    new Set(value).size === value.length
  );
}

function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
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

function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return true;
  }

  return (
    Object.isFrozen(value) &&
    Object.values(value).every((entry) => isDeeplyFrozen(entry))
  );
}

function freezeRecursively<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(freezeRecursively);
    Object.freeze(value);
  }

  return value;
}

function doesAvailabilityEvidenceConfirm(
  evidence: GeneratedAudioCommitAvailabilityEvidence | undefined,
  artifact: ProjectMixdownAudioArtifact,
): boolean {
  return Boolean(
    evidence &&
      new Set(evidence.availableArtifactIds).size ===
        evidence.availableArtifactIds.length &&
      evidence.availableArtifactIds.includes(artifact.artifactId) &&
      !Number.isNaN(Date.parse(evidence.checkedAt)) &&
      new Date(evidence.checkedAt).toISOString() === evidence.checkedAt,
  );
}

function isTrimmedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1_024 &&
    value.trim() === value
  );
}

function isRepresentableMixerFader(value: unknown): value is number {
  if (typeof value !== 'number') {
    return false;
  }

  try {
    decibelsToMixerGain(value);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(
  reason: ProjectMixdownRegistrationFailureReason,
  message: string,
): Extract<ProjectMixdownRegistrationUpdate, { canRegister: false }> {
  return Object.freeze({ canRegister: false as const, message, reason });
}

function candidateFail(
  reason: ProjectMixdownRegistrationFailureReason,
  message: string,
): Extract<ProjectMixdownArtifactCandidate, { canPrepare: false }> {
  return Object.freeze({ canPrepare: false as const, message, reason });
}

function intentFail(
  reason: ProjectMixdownRegistrationFailureReason,
  message: string,
): Extract<ProjectMixdownRegistrationIntentResolution, { canCreate: false }> {
  return Object.freeze({ canCreate: false as const, message, reason });
}

function preflightFail(
  reason: ProjectMixdownRegistrationFailureReason,
  message: string,
): Extract<ProjectMixdownRegistrationPreflight, { canDispatch: false }> {
  return Object.freeze({ canDispatch: false as const, message, reason });
}
