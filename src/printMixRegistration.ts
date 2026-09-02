import {
  PRINT_MIX_NORMALIZE_TARGET_DBFS,
  PRINT_MIX_PLAN_VERSION,
  PRINT_MIX_PROTOCOL_VERSION,
  PRINT_MIX_RENDERER_ID,
  PRINT_MIX_RENDERER_VERSION,
  createPrintMixArtifactId,
} from '../shared/printMixProtocol.js';
import { createSynchronizedClipSourceFile } from './clipSourceSynchronization';
import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import { createMidiContentHash } from './midiContentHash';
import {
  parsePrintMixOperation,
  type PrintMixAudioCompletedResult,
  type PrintMixOperation,
  type PrintMixRequest,
} from './printMixOperation';
import {
  createCanonicalPrintMixPlanJson,
  createPrintMixPlan,
  type PrintMixPlan,
} from './printMixPlan';
import { reconcileProjectMixerState } from './projectMixerState';
import type {
  Clip,
  PrintMixAudioArtifact,
  PrintMixAudioClipTake,
  PrintMixMidiArtifact,
  PrintMixMidiClipTake,
  ProjectState,
  Track,
} from './types';

export const PRINT_MIX_REGISTRATION_INTENT_VERSION = 1 as const;

export type PrintMixOutputIdentity = Readonly<{
  artifactId: string;
  clipId: string;
  clipName: string;
  clipTakeId: string;
  trackId: string;
  trackName: string;
}>;

export type PrintMixRegistrationIntent = Readonly<{
  canonicalPlanJson: string;
  mediaType: PrintMixPlan['mediaType'];
  operationId: string;
  output: PrintMixOutputIdentity;
  sourceLineage: PrintMixPlan['sourceLineage'];
  version: typeof PRINT_MIX_REGISTRATION_INTENT_VERSION;
}>;

export type PrintMixRegistrationFailureReason =
  | 'artifact-unavailable'
  | 'identity-conflict'
  | 'intent-invalid'
  | 'operation-invalid'
  | 'plan-stale'
  | 'source-lineage-invalid';

export type PrintMixRegistrationIntentResolution =
  | Readonly<{ canCreate: true; intent: PrintMixRegistrationIntent }>
  | Readonly<{
      canCreate: false;
      message: string;
      reason: PrintMixRegistrationFailureReason;
    }>;

export type PrintMixRegistrationUpdate =
  | Readonly<{
      artifact: PrintMixAudioArtifact | PrintMixMidiArtifact;
      canRegister: true;
      clipTake: PrintMixAudioClipTake | PrintMixMidiClipTake;
      project: ProjectState;
      status: 'ALREADY_REGISTERED' | 'REGISTERED';
    }>
  | Readonly<{
      canRegister: false;
      message: string;
      reason: PrintMixRegistrationFailureReason;
    }>;

export type PrintMixRegistrationOptions = Readonly<{
  intent: PrintMixRegistrationIntent;
  sourceAvailability?: GeneratedAudioCommitAvailabilityEvidence;
}>;

export function createPrintMixRegistrationIntent(
  project: ProjectState,
  request: PrintMixRequest,
): PrintMixRegistrationIntentResolution {
  const canonicalPlanJson = createCanonicalPrintMixPlanJson(request.plan);
  const output = createOutputIdentity(request.operationId, project);

  if (
    request.operationId !== request.plan.operationId ||
    request.protocolVersion !== PRINT_MIX_PROTOCOL_VERSION ||
    !canonicalPlanJson ||
    !output ||
    !isDeeplyFrozen(request)
  ) {
    return failIntent(
      'intent-invalid',
      'PRINT MIX requires one immutable Request and Plan.',
    );
  }

  const current = validateCurrentPlan(project, request.plan, canonicalPlanJson);

  if (!current.ok) {
    return failIntent(current.reason, current.message);
  }

  if (hasOutputIdentityConflict(project, output)) {
    return failIntent(
      'identity-conflict',
      'Reserved PRINT MIX output identities are already in use.',
    );
  }

  return Object.freeze({
    canCreate: true as const,
    intent: freezeRecursively({
      canonicalPlanJson,
      mediaType: request.plan.mediaType,
      operationId: request.operationId,
      output,
      sourceLineage: request.plan.sourceLineage.map((item) => ({ ...item })),
      version: PRINT_MIX_REGISTRATION_INTENT_VERSION,
    }),
  });
}

export async function createPrintMixTrackRegistration(
  project: ProjectState,
  request: PrintMixRequest,
  operationValue: unknown,
  options: PrintMixRegistrationOptions,
): Promise<PrintMixRegistrationUpdate> {
  const intent = parseIntent(options.intent, request);
  const operation = await parsePrintMixOperation(operationValue, request);

  if (!intent) {
    return failRegistration(
      'intent-invalid',
      'PRINT MIX registration intent is invalid.',
    );
  }

  if (!operation || operation.result.printMix.mediaType !== request.plan.mediaType) {
    return failRegistration(
      'operation-invalid',
      'Completed PRINT MIX output does not match its immutable Request.',
    );
  }

  const artifact = createArtifact(request, operation, intent);
  const clipTake = createClipTake(artifact, intent);
  const existing = resolveExisting(project, artifact, clipTake, intent, request.plan);

  if (existing.status === 'CONFLICT') {
    return failRegistration('identity-conflict', existing.message);
  }

  if (existing.status === 'EXACT') {
    return Object.freeze({
      artifact: existing.artifact,
      canRegister: true as const,
      clipTake: existing.clipTake,
      project,
      status: 'ALREADY_REGISTERED' as const,
    });
  }

  const current = validateCurrentPlan(
    project,
    request.plan,
    intent.canonicalPlanJson,
  );

  if (!current.ok) {
    return failRegistration(current.reason, current.message);
  }

  if (!areJsonValuesEqual(request.plan.sourceLineage, intent.sourceLineage)) {
    return failRegistration(
      'source-lineage-invalid',
      'PRINT MIX source Lineage changed after registration was reserved.',
    );
  }

  if (hasOutputIdentityConflict(project, intent.output)) {
    return failRegistration(
      'identity-conflict',
      'Reserved PRINT MIX output identities are already in use.',
    );
  }

  if (
    artifact.kind === 'audio' &&
    !doesAvailabilityConfirm(options.sourceAvailability, artifact.artifactId)
  ) {
    return failRegistration(
      'artifact-unavailable',
      'Audio PRINT MIX must be verified with the Local Engine before Project registration.',
    );
  }

  const clip = createOutputClip(
    request.plan,
    artifact,
    clipTake,
    intent,
    options.sourceAvailability,
  );
  const track: Track = {
    clips: [clip],
    id: intent.output.trackId,
    level: 0,
    muted: true,
    name: intent.output.trackName,
    type: request.plan.mediaType,
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

function createArtifact(
  request: PrintMixRequest,
  operation: PrintMixOperation,
  intent: PrintMixRegistrationIntent,
): PrintMixAudioArtifact | PrintMixMidiArtifact {
  const commonProvenance = {
    canonicalPlanJson: intent.canonicalPlanJson,
    inputClipIds: [...request.plan.selectedClipIds],
    inputSourceIds: request.plan.sources.map((source) =>
      request.plan.mediaType === 'audio'
        ? (source as { sourceId: string }).sourceId
        : (source as { artifactId: string }).artifactId,
    ),
    operationProtocolVersion: PRINT_MIX_PROTOCOL_VERSION,
    planSha256: operation.result.artifact.provenance.planSha256,
    planVersion: PRINT_MIX_PLAN_VERSION,
    schemaVersion: 1 as const,
  };
  const lineage = {
    parentArtifactIds: unique(
      request.plan.sourceLineage.map((item) => item.artifactId),
    ),
    parentClipTakeIds: unique(
      request.plan.sourceLineage.map((item) => item.clipTakeId),
    ),
  };

  if (
    request.plan.mediaType === 'audio' &&
    operation.result.printMix.mediaType === 'audio' &&
    operation.result.artifact.kind === 'audio'
  ) {
    const completed = operation.result as PrintMixAudioCompletedResult;
    return freezeRecursively({
      artifactId: completed.artifact.artifactId,
      audio: {
        bitsPerSample: completed.printMix.bitsPerSample,
        channels: completed.printMix.channels,
        durationSeconds: completed.printMix.durationSeconds,
        frameCount: completed.printMix.frameCount,
        mimeType: completed.printMix.mimeType,
        sampleRate: completed.printMix.sampleRate,
      },
      createdAt: completed.artifact.createdAt,
      destination: 'print-mix' as const,
      file: { ...completed.artifact.file },
      kind: 'audio' as const,
      lineage,
      printMixProvenance: {
        ...commonProvenance,
        appliedGain: completed.printMix.appliedGain,
        clippingWarning: completed.printMix.clippingWarning,
        normalize: completed.printMix.normalize,
        outputPeak: completed.printMix.outputPeak,
        preNormalizationPeak: completed.printMix.preNormalizationPeak,
        rendererId: PRINT_MIX_RENDERER_ID,
        rendererVersion: PRINT_MIX_RENDERER_VERSION,
        targetPeakDbfs: PRINT_MIX_NORMALIZE_TARGET_DBFS,
      },
      sourceOperationId: request.operationId,
    });
  }

  if (
    request.plan.mediaType !== 'midi' ||
    operation.result.printMix.mediaType !== 'midi' ||
    operation.result.artifact.kind !== 'midi'
  ) {
    throw new Error('PRINT MIX operation media identity is inconsistent.');
  }

  const midi = {
    bpm: request.plan.bpm,
    notes: request.plan.notes.map((note) => ({ ...note })),
    ticksPerQuarter: request.plan.ticksPerQuarter,
  };
  return freezeRecursively({
    artifactId: operation.result.artifact.artifactId,
    contentHash: createMidiContentHash(midi),
    createdAt: operation.result.artifact.createdAt,
    kind: 'midi' as const,
    lineage,
    midi,
    printMixProvenance: commonProvenance,
    sourceOperationId: request.operationId,
  });
}

function createClipTake(
  artifact: PrintMixAudioArtifact | PrintMixMidiArtifact,
  intent: PrintMixRegistrationIntent,
): PrintMixAudioClipTake | PrintMixMidiClipTake {
  const base = {
    artifactId: artifact.artifactId,
    clipTakeId: intent.output.clipTakeId,
    createdAt: artifact.createdAt,
    label: intent.output.clipName,
    sourceOperationId: artifact.sourceOperationId,
    sourceType: 'print-mix' as const,
  };

  return artifact.kind === 'audio'
    ? Object.freeze({ ...base, mediaType: 'audio' as const })
    : Object.freeze({
        ...base,
        contentHash: artifact.contentHash,
        mediaType: 'midi' as const,
      });
}

function createOutputClip(
  plan: PrintMixPlan,
  artifact: PrintMixAudioArtifact | PrintMixMidiArtifact,
  clipTake: PrintMixAudioClipTake | PrintMixMidiClipTake,
  intent: PrintMixRegistrationIntent,
  availability: GeneratedAudioCommitAvailabilityEvidence | undefined,
): Clip {
  const common = {
    activeClipTakeId: clipTake.clipTakeId,
    clipTakes: [clipTake],
    color: artifact.kind === 'audio' ? '#9ccfd8' : '#f6c177',
    createdAt: artifact.createdAt,
    generatedBy: 'PRINT MIX',
    id: intent.output.clipId,
    lengthTicks: plan.durationTicks,
    name: intent.output.clipName,
    startTick: plan.startTick,
    version: 1,
  };

  if (artifact.kind === 'midi') {
    return {
      ...common,
      type: 'midi-notes',
    };
  }

  return {
    ...common,
    audioTiming: {
      sourceEndSeconds: artifact.audio.durationSeconds,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    },
    sourceFile: createSynchronizedClipSourceFile(
      artifact,
      undefined,
      availability,
    ),
    type: 'mixdown',
  };
}

function resolveExisting(
  project: ProjectState,
  expectedArtifact: PrintMixAudioArtifact | PrintMixMidiArtifact,
  expectedClipTake: PrintMixAudioClipTake | PrintMixMidiClipTake,
  intent: PrintMixRegistrationIntent,
  plan: PrintMixPlan,
):
  | Readonly<{
      artifact: PrintMixAudioArtifact | PrintMixMidiArtifact;
      clipTake: PrintMixAudioClipTake | PrintMixMidiClipTake;
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
  const takes = project.tracks
    .flatMap((track) => track.clips)
    .flatMap((clip) => clip.clipTakes ?? [])
    .filter((take) => take.clipTakeId === intent.output.clipTakeId);

  if (
    artifacts.length === 0 &&
    tracks.length === 0 &&
    clips.length === 0 &&
    takes.length === 0
  ) {
    return Object.freeze({ status: 'NONE' as const });
  }

  const artifact = artifacts[0];
  const track = tracks[0];
  const clip = clips[0];
  const clipTake = takes[0];
  const exact =
    artifacts.length === 1 &&
    tracks.length === 1 &&
    clips.length === 1 &&
    takes.length === 1 &&
    artifact &&
    'sourceOperationId' in artifact &&
    artifact.sourceOperationId === intent.operationId &&
    clipTake?.sourceType === 'print-mix' &&
    track?.clips.length === 1 &&
    track.clips[0] === clip &&
    track.name === intent.output.trackName &&
    track.type === plan.mediaType &&
    track.level === 0 &&
    track.muted === true &&
    clip.name === intent.output.clipName &&
    clip.startTick === plan.startTick &&
    clip.lengthTicks === plan.durationTicks &&
    clip.generatedBy === 'PRINT MIX' &&
    clip.clipTakes?.length === 1 &&
    clip.clipTakes[0] === clipTake &&
    clip.activeClipTakeId === clipTake.clipTakeId &&
    ((artifact.kind === 'midi' &&
      clip.type === 'midi-notes' &&
      clip.soundFont === undefined &&
      clip.sourceFile === undefined) ||
      (artifact.kind === 'audio' &&
        clip.type === 'mixdown' &&
        clip.audioTiming?.timeBase === 'absolute-seconds' &&
        clip.audioTiming.sourceStartSeconds === 0 &&
        clip.audioTiming.sourceEndSeconds === artifact.audio.durationSeconds &&
        clip.sourceFile?.sourceId === artifact.artifactId &&
        clip.sourceFile.relativePath === artifact.file.relativePath &&
        clip.sourceFile.status === 'available')) &&
    areJsonValuesEqual(artifact, expectedArtifact) &&
    areJsonValuesEqual(clipTake, expectedClipTake);

  return exact
    ? Object.freeze({
        artifact: artifact as PrintMixAudioArtifact | PrintMixMidiArtifact,
        clipTake: clipTake as PrintMixAudioClipTake | PrintMixMidiClipTake,
        status: 'EXACT' as const,
      })
    : Object.freeze({
        message:
          'Reserved PRINT MIX output identities are already used by a different or partial Project result.',
        status: 'CONFLICT' as const,
      });
}

function validateCurrentPlan(
  project: ProjectState,
  plan: PrintMixPlan,
  canonicalPlanJson: string,
):
  | Readonly<{ ok: true }>
  | Readonly<{
      message: string;
      ok: false;
      reason: 'plan-stale' | 'source-lineage-invalid';
    }> {
  const regenerated = createPrintMixPlan(
    project,
    plan.patchTabId,
    {
      items: plan.selectedClipIds.map((id) => ({ id, type: 'clip' as const })),
    },
    plan.operationId,
  );

  if (!regenerated.canCreate) {
    return Object.freeze({
      message: `PRINT MIX Plan could not be revalidated: ${regenerated.message}`,
      ok: false as const,
      reason: regenerated.reason === 'clip-source-invalid'
        ? 'source-lineage-invalid' as const
        : 'plan-stale' as const,
    });
  }

  const currentJson = createCanonicalPrintMixPlanJson(regenerated.plan);

  return currentJson === canonicalPlanJson
    ? Object.freeze({ ok: true as const })
    : Object.freeze({
        message: 'PRINT MIX Plan no longer matches the current Project.',
        ok: false as const,
        reason: 'plan-stale' as const,
      });
}

function parseIntent(
  value: unknown,
  request: PrintMixRequest,
): PrintMixRegistrationIntent | undefined {
  const canonicalPlanJson = createCanonicalPrintMixPlanJson(request.plan);

  if (
    !canonicalPlanJson ||
    !hasExactKeys(value, [
      'canonicalPlanJson',
      'mediaType',
      'operationId',
      'output',
      'sourceLineage',
      'version',
    ]) ||
    value.canonicalPlanJson !== canonicalPlanJson ||
    value.mediaType !== request.plan.mediaType ||
    value.operationId !== request.operationId ||
    value.version !== PRINT_MIX_REGISTRATION_INTENT_VERSION ||
    !hasExactKeys(value.output, [
      'artifactId',
      'clipId',
      'clipName',
      'clipTakeId',
      'trackId',
      'trackName',
    ]) ||
    !Array.isArray(value.sourceLineage) ||
    !areJsonValuesEqual(value.sourceLineage, request.plan.sourceLineage) ||
    !isDeeplyFrozen(value)
  ) {
    return undefined;
  }

  return value as unknown as PrintMixRegistrationIntent;
}

function createOutputIdentity(
  operationId: string,
  project: ProjectState,
): PrintMixOutputIdentity | undefined {
  const artifactId = createPrintMixArtifactId(operationId);

  if (!artifactId) {
    return undefined;
  }

  const suffix = artifactId.slice('artifact-'.length);
  const number = project.tracks.filter((track) =>
    /^Print Mix \d+$/.test(track.name),
  ).length + 1;
  const name = `Print Mix ${String(number).padStart(2, '0')}`;

  return Object.freeze({
    artifactId,
    clipId: `print-mix-clip-${suffix}`,
    clipName: name,
    clipTakeId: `clip-take-${artifactId}`,
    trackId: `print-mix-track-${suffix}`,
    trackName: name,
  });
}

function hasOutputIdentityConflict(
  project: ProjectState,
  output: PrintMixOutputIdentity,
): boolean {
  return (
    (project.artifacts ?? []).some(
      (artifact) => artifact.artifactId === output.artifactId,
    ) ||
    project.tracks.some(
      (track) =>
        track.id === output.trackId ||
        track.clips.some(
          (clip) =>
            clip.id === output.clipId ||
            (clip.clipTakes ?? []).some(
              (take) => take.clipTakeId === output.clipTakeId,
            ),
        ),
    )
  );
}

function doesAvailabilityConfirm(
  evidence: GeneratedAudioCommitAvailabilityEvidence | undefined,
  artifactId: string,
): boolean {
  return Boolean(
    evidence &&
      !Number.isNaN(Date.parse(evidence.checkedAt)) &&
      evidence.availableArtifactIds.length === 1 &&
      evidence.availableArtifactIds[0] === artifactId,
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
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

function failIntent(
  reason: PrintMixRegistrationFailureReason,
  message: string,
): PrintMixRegistrationIntentResolution {
  return Object.freeze({ canCreate: false as const, message, reason });
}

function failRegistration(
  reason: PrintMixRegistrationFailureReason,
  message: string,
): PrintMixRegistrationUpdate {
  return Object.freeze({ canRegister: false as const, message, reason });
}
