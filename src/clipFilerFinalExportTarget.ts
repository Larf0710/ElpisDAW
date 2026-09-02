import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_OUTPUT_DESTINATION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import {
  resolveActiveAudioTakeSource,
  type ActiveAudioTakeSourcePlan,
} from './activeAudioTakeSource';
import { doesClipTakeMatchArtifact } from './clipTakeActivation';
import type { LocalEngineGeneratedAudioDescriptor } from './localEngineClient';
import { normalizeProjectArtifacts } from './projectArtifactRegistration';
import { createProjectDirtyStateFingerprint } from './projectDirtyStateFingerprint';
import { resolveClipFilerProductionSettings } from './projectMixdownPreparation';
import { createStableAudio3JobRequest } from './stableAudio3JobContract';
import type {
  AudioArtifact,
  AudioClipTake,
  Clip,
  GeneratedAudioArtifact,
  PatchTab,
  ProjectState,
} from './types';

export type ClipFilerRawMixdownIdentity = Readonly<{
  artifactId: string;
  clipId: string;
  clipTakeId: string;
  operationId: string;
}>;

export type ClipFilerFinalExportTarget = Readonly<{
  descriptor: LocalEngineGeneratedAudioDescriptor;
  fileName: string;
  format: 'WAV';
  projectFingerprint: string;
  target:
    | Readonly<{
        artifactId: string;
        clipId: string;
        clipTakeId: string;
        kind: 'raw-mixdown';
        rawMixdown: ClipFilerRawMixdownIdentity;
      }>
    | Readonly<{
        artifactId: string;
        clipId: string;
        clipTakeId: string;
        jobId: string;
        kind: 'stable-audio-3-master';
        rawMixdown: ClipFilerRawMixdownIdentity;
      }>;
}>;

export type ClipFilerFinalExportTargetResolution =
  | Readonly<{
      canExport: true;
      exportTarget: ClipFilerFinalExportTarget;
    }>
  | Readonly<{
      canExport: false;
      cause:
        | 'active-take-unavailable'
        | 'clip-filer-settings-invalid'
        | 'identity-conflict'
        | 'lineage-invalid'
        | 'source-artifact-invalid'
        | 'target-invalid';
      message: string;
    }>;

export type FinalFilerExportTarget = ClipFilerFinalExportTarget;

export type FinalFilerExportTargetResolution =
  | Extract<ClipFilerFinalExportTargetResolution, { canExport: true }>
  | (Omit<
      Extract<ClipFilerFinalExportTargetResolution, { canExport: false }>,
      'cause'
    > &
      Readonly<{
        cause: Exclude<
          Extract<
            ClipFilerFinalExportTargetResolution,
            { canExport: false }
          >['cause'],
          'clip-filer-settings-invalid'
        >;
      }>);

type AudioSourceResolution = Readonly<{
  artifact: AudioArtifact;
  clip: Clip;
  descriptor: LocalEngineGeneratedAudioDescriptor;
  plan: ActiveAudioTakeSourcePlan;
  take: AudioClipTake;
}>;

export function resolveClipFilerFinalExportTarget(
  project: ProjectState,
  patchTab: PatchTab | undefined,
  selectedClipId: string | undefined,
): ClipFilerFinalExportTargetResolution {
  const settings = resolveClipFilerProductionSettings(patchTab);

  if (!settings.canResolve) {
    return fail('clip-filer-settings-invalid', settings.message);
  }

  return resolveFinalFilerExportTarget(project, selectedClipId);
}

export function resolveFinalFilerExportTarget(
  project: ProjectState,
  selectedClipId: string | undefined,
): FinalFilerExportTargetResolution {
  const selectedClip = findUniqueClip(project, selectedClipId);

  if (!selectedClip || selectedClip.exportManifest) {
    return fail(
      'target-invalid',
      'Final WAV export requires one registered Raw Mixdown or Stable Audio 3 Master Clip.',
    );
  }

  if (selectedClip.type !== 'mixdown' && selectedClip.type !== 'master') {
    return fail(
      'target-invalid',
      'Instrument, vocal, arrangement, and mock export Clips are not final WAV targets.',
    );
  }

  const source = resolveAudioSource(project, selectedClip);

  if (!source.ok) {
    return source.failure;
  }

  if (selectedClip.type === 'mixdown') {
    const rawMixdown = resolveRawMixdownIdentity(project, source.value);

    if (!rawMixdown.ok) {
      return rawMixdown.failure;
    }

    return success(
      project,
      selectedClip,
      source.value.descriptor,
      Object.freeze({
        artifactId: source.value.artifact.artifactId,
        clipId: selectedClip.id,
        clipTakeId: source.value.take.clipTakeId,
        kind: 'raw-mixdown' as const,
        rawMixdown: rawMixdown.value,
      }),
    );
  }

  const master = resolveStableAudio3MasterIdentity(project, source.value);

  if (!master.ok) {
    return master.failure;
  }

  return success(
    project,
    selectedClip,
    source.value.descriptor,
    Object.freeze({
      artifactId: source.value.artifact.artifactId,
      clipId: selectedClip.id,
      clipTakeId: source.value.take.clipTakeId,
      jobId: master.jobId,
      kind: 'stable-audio-3-master' as const,
      rawMixdown: master.rawMixdown,
    }),
  );
}

function resolveAudioSource(
  project: ProjectState,
  clip: Clip,
):
  | Readonly<{ ok: true; value: AudioSourceResolution }>
  | Readonly<{
      failure: Extract<FinalFilerExportTargetResolution, { canExport: false }>;
      ok: false;
    }> {
  const resolution = resolveActiveAudioTakeSource(project, clip.id);

  if (!resolution.canResolve) {
    return Object.freeze({
      failure: fail('active-take-unavailable', resolution.message),
      ok: false as const,
    });
  }

  const takeMatches = collectAudioTakes(project).filter(
    ({ take }) => take.clipTakeId === resolution.plan.source.clipTakeId,
  );
  const artifactMatches = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === resolution.plan.source.artifactId,
  );
  const take = takeMatches.length === 1 ? takeMatches[0]?.take : undefined;
  const artifact =
    artifactMatches.length === 1 && artifactMatches[0]?.kind === 'audio'
      ? artifactMatches[0]
      : undefined;

  if (
    !take ||
    !artifact ||
    take.artifactId !== artifact.artifactId ||
    !doesClipTakeMatchArtifact(take, artifact)
  ) {
    return Object.freeze({
      failure: fail(
        'identity-conflict',
        'Final WAV target Take and Artifact identities do not resolve uniquely.',
      ),
      ok: false as const,
    });
  }

  if (!doesOptionalSourceFileMatch(clip, resolution.plan.descriptor)) {
    return Object.freeze({
      failure: fail(
        'source-artifact-invalid',
        'Final WAV target is marked unavailable or no longer matches its registered file descriptor.',
      ),
      ok: false as const,
    });
  }

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      artifact,
      clip: resolution.plan.clip,
      descriptor: resolution.plan.descriptor,
      plan: resolution.plan,
      take,
    }),
  });
}

function resolveRawMixdownIdentity(
  project: ProjectState,
  source: AudioSourceResolution,
):
  | Readonly<{ ok: true; value: ClipFilerRawMixdownIdentity }>
  | Readonly<{
      failure: Extract<FinalFilerExportTargetResolution, { canExport: false }>;
      ok: false;
    }> {
  const { artifact, clip, descriptor, take } = source;
  const canonicalArtifact = normalizeSingleAudioArtifact(artifact);

  if (
    clip.type !== 'mixdown' ||
    take.sourceType !== 'mixdown' ||
    !canonicalArtifact ||
    canonicalArtifact.destination !== 'mixdown' ||
    !('sourceOperationId' in canonicalArtifact) ||
    !('mixdownProvenance' in canonicalArtifact) ||
    take.sourceOperationId !== canonicalArtifact.sourceOperationId ||
    descriptor.relativePath !== `mixdowns/${descriptor.name}` ||
    descriptor.sourceId !== canonicalArtifact.artifactId
  ) {
    return invalidRawMixdown();
  }

  const operationArtifacts = (project.artifacts ?? []).filter(
    (candidate) =>
      candidate.kind === 'audio' &&
      'sourceOperationId' in candidate &&
      candidate.sourceOperationId === canonicalArtifact.sourceOperationId,
  );
  const operationTakes = collectAudioTakes(project).filter(
    ({ take: candidate }) =>
      candidate.sourceType === 'mixdown' &&
      candidate.sourceOperationId === canonicalArtifact.sourceOperationId,
  );

  if (operationArtifacts.length !== 1 || operationTakes.length !== 1) {
    return Object.freeze({
      failure: fail(
        'identity-conflict',
        'Raw Mixdown operation identity collides with another Artifact or Clip Take.',
      ),
      ok: false as const,
    });
  }

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      artifactId: canonicalArtifact.artifactId,
      clipId: clip.id,
      clipTakeId: take.clipTakeId,
      operationId: canonicalArtifact.sourceOperationId,
    }),
  });
}

function resolveStableAudio3MasterIdentity(
  project: ProjectState,
  source: AudioSourceResolution,
):
  | Readonly<{
      jobId: string;
      ok: true;
      rawMixdown: ClipFilerRawMixdownIdentity;
    }>
  | Readonly<{
      failure: Extract<FinalFilerExportTargetResolution, { canExport: false }>;
      ok: false;
    }> {
  const { artifact, clip, descriptor, take } = source;
  const canonicalArtifact = normalizeSingleAudioArtifact(artifact);

  if (
    clip.type !== 'master' ||
    take.sourceType !== 'job' ||
    !canonicalArtifact ||
    !isStableAudio3MasterArtifact(canonicalArtifact) ||
    take.sourceJobId !== canonicalArtifact.sourceJobId ||
    descriptor.relativePath !== `renders/stable-audio-3/${descriptor.name}` ||
    descriptor.sourceId !== canonicalArtifact.artifactId
  ) {
    return invalidMaster(
      'Stable Audio 3 Master does not resolve to one finalized registered A2A Job WAV.',
    );
  }

  const jobArtifacts = (project.artifacts ?? []).filter(
    (candidate) =>
      candidate.kind === 'audio' &&
      'sourceJobId' in candidate &&
      candidate.sourceJobId === canonicalArtifact.sourceJobId,
  );
  const jobTakes = collectAudioTakes(project).filter(
    ({ take: candidate }) =>
      candidate.sourceType === 'job' &&
      candidate.sourceJobId === canonicalArtifact.sourceJobId,
  );

  if (jobArtifacts.length !== 1 || jobTakes.length !== 1) {
    return Object.freeze({
      failure: fail(
        'identity-conflict',
        'Stable Audio 3 Job identity collides with another Artifact or Clip Take.',
      ),
      ok: false as const,
    });
  }

  const [parentArtifactId] = canonicalArtifact.lineage.parentArtifactIds;
  const [parentClipTakeId] = canonicalArtifact.lineage.parentClipTakeIds;
  const parentClip = findUniqueClip(project, clip.sourceClipId);

  if (
    canonicalArtifact.lineage.parentArtifactIds.length !== 1 ||
    canonicalArtifact.lineage.parentClipTakeIds.length !== 1 ||
    !parentArtifactId ||
    !parentClipTakeId ||
    !parentClip ||
    parentClip.type !== 'mixdown' ||
    parentClip.exportManifest ||
    clip.sourceClipId !== parentClip.id ||
    parentClip.activeClipTakeId !== parentClipTakeId
  ) {
    return invalidLineage();
  }

  const parentSource = resolveAudioSource(project, parentClip);

  if (!parentSource.ok) {
    return Object.freeze({
      failure: fail('lineage-invalid', parentSource.failure.message),
      ok: false as const,
    });
  }

  if (
    parentSource.value.artifact.artifactId !== parentArtifactId ||
    parentSource.value.take.clipTakeId !== parentClipTakeId
  ) {
    return invalidLineage();
  }

  const rawMixdown = resolveRawMixdownIdentity(project, parentSource.value);

  if (!rawMixdown.ok) {
    return Object.freeze({
      failure: fail('lineage-invalid', rawMixdown.failure.message),
      ok: false as const,
    });
  }

  if (
    !doesStableAudio3RequestMatchArtifact(
      canonicalArtifact,
      parentSource.value.plan,
    )
  ) {
    return invalidLineage();
  }

  return Object.freeze({
    jobId: canonicalArtifact.sourceJobId,
    ok: true as const,
    rawMixdown: rawMixdown.value,
  });
}

function isStableAudio3MasterArtifact(
  artifact: AudioArtifact,
): artifact is GeneratedAudioArtifact & { destination: 'stable-audio-3' } {
  if (
    artifact.destination !== STABLE_AUDIO_3_OUTPUT_DESTINATION ||
    !('sourceJobId' in artifact) ||
    artifact.provenance.providerId !== STABLE_AUDIO_3_PROVIDER_ID ||
    artifact.provenance.modelId !== STABLE_AUDIO_3_MODEL_ID ||
    artifact.provenance.modelRevision !== STABLE_AUDIO_3_MODEL_REVISION ||
    artifact.provenance.taskId !== STABLE_AUDIO_3_TASK_ID ||
    artifact.audio.channels !== STABLE_AUDIO_3_CHANNELS ||
    artifact.audio.mimeType !== 'audio/wav' ||
    artifact.file.extension !== '.wav' ||
    artifact.file.name !== `${artifact.artifactId}.wav` ||
    artifact.file.relativePath !==
      `renders/stable-audio-3/${artifact.artifactId}.wav` ||
    !isTrimmedId(artifact.sourceJobId)
  ) {
    return false;
  }

  const parameters = artifact.provenance.parameters;

  return artifact.provenance.seed === parameters.seed;
}

function doesStableAudio3RequestMatchArtifact(
  masterArtifact: GeneratedAudioArtifact,
  rawMixdownPlan: ActiveAudioTakeSourcePlan,
): boolean {
  const parameters = masterArtifact.provenance.parameters;

  try {
    const request = createStableAudio3JobRequest({
      durationSeconds: parameters.durationSeconds as number,
      modelId: masterArtifact.provenance.modelId,
      modelRevision: masterArtifact.provenance.modelRevision,
      plan: rawMixdownPlan,
      prompt: parameters.prompt as string,
      providerId: masterArtifact.provenance.providerId,
      seed: parameters.seed as number,
      strength: parameters.strength as number,
    });

    return (
      request.parameters.durationSeconds ===
        masterArtifact.audio.durationSeconds &&
      areJsonValuesEqual(request.lineage, masterArtifact.lineage) &&
      areJsonValuesEqual(request.parameters, parameters)
    );
  } catch {
    return false;
  }
}

function normalizeSingleAudioArtifact(
  artifact: AudioArtifact,
): AudioArtifact | undefined {
  const normalized = normalizeProjectArtifacts([artifact]);
  const candidate = normalized.length === 1 ? normalized[0] : undefined;

  return candidate?.kind === 'audio' ? candidate : undefined;
}

function collectAudioTakes(
  project: ProjectState,
): ReadonlyArray<Readonly<{ clip: Clip; take: AudioClipTake }>> {
  return project.tracks.flatMap((track) =>
    track.clips.flatMap((clip) =>
      (clip.clipTakes ?? [])
        .filter((take): take is AudioClipTake => take.mediaType === 'audio')
        .map((take) => Object.freeze({ clip, take })),
    ),
  );
}

function findUniqueClip(
  project: ProjectState,
  clipId: string | undefined,
): Clip | undefined {
  if (!clipId) {
    return undefined;
  }

  const matches = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);

  return matches.length === 1 ? matches[0] : undefined;
}

function doesOptionalSourceFileMatch(
  clip: Clip,
  descriptor: LocalEngineGeneratedAudioDescriptor,
): boolean {
  const sourceFile = clip.sourceFile;

  if (!sourceFile) {
    return true;
  }

  return (
    sourceFile.status === 'available' &&
    sourceFile.mimeType === 'audio/wav' &&
    sourceFile.sourceId === descriptor.sourceId &&
    sourceFile.name === descriptor.name &&
    sourceFile.relativePath === descriptor.relativePath &&
    sourceFile.sizeBytes === descriptor.sizeBytes
  );
}

function success(
  project: ProjectState,
  clip: Clip,
  descriptor: LocalEngineGeneratedAudioDescriptor,
  target: ClipFilerFinalExportTarget['target'],
): Extract<ClipFilerFinalExportTargetResolution, { canExport: true }> {
  return Object.freeze({
    canExport: true as const,
    exportTarget: Object.freeze({
      descriptor,
      fileName: createDownloadFileName(project.name, clip.name),
      format: 'WAV' as const,
      projectFingerprint: createProjectDirtyStateFingerprint(project),
      target,
    }),
  });
}

function createDownloadFileName(projectName: string, clipName: string): string {
  return `${sanitizeFileNamePart(projectName)}-${sanitizeFileNamePart(clipName)}.wav`;
}

function sanitizeFileNamePart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  const safeName = sanitized || 'ElpisDAW';

  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(safeName)
    ? `${safeName}-file`
    : safeName;
}

function invalidRawMixdown() {
  return Object.freeze({
    failure: fail(
      'source-artifact-invalid',
      'Raw Mixdown is not backed by one canonical finalized Mixdown Artifact and operation.',
    ),
    ok: false as const,
  });
}

function invalidMaster(message: string) {
  return Object.freeze({
    failure: fail('source-artifact-invalid', message),
    ok: false as const,
  });
}

function invalidLineage() {
  return Object.freeze({
    failure: fail(
      'lineage-invalid',
      'Stable Audio 3 Master does not resolve to one active registered Raw Mixdown parent.',
    ),
    ok: false as const,
  });
}

function isTrimmedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    value.length <= 256
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

function fail<
  Cause extends Extract<
    ClipFilerFinalExportTargetResolution,
    { canExport: false }
  >['cause'],
>(
  cause: Cause,
  message: string,
): Readonly<{ canExport: false; cause: Cause; message: string }> {
  return Object.freeze({ canExport: false as const, cause, message });
}
