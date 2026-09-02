import {
  PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
  PROJECT_STEM_PRINT_OPERATION_ID_PREFIX,
  createProjectStemPrintArtifactId,
  isProjectStemPrintOperationId,
} from '../shared/projectStemPrintApiProtocol.js';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import type { ProjectStemPrintApiRequest } from './projectStemPrintApi';
import {
  createCanonicalProjectStemPrintPlanJson,
} from './projectMixdownPlanIdentity';
import {
  createProjectMixerRenderSnapshotV2,
  type ProjectMixerRenderSnapshotV2,
} from './projectMixerRenderSnapshot';
import {
  createProjectStemPrintPlan,
  type ProjectStemPrintPlan,
  type ProjectStemPrintTarget,
  type ProjectStemPrintTargetSnapshot,
} from './projectStemPrintPlan';
import type { ProjectState } from './types';

export const PROJECT_STEM_PRINT_REGISTRATION_INTENT_VERSION = 1 as const;

export type ProjectStemPrintOutputIdentity = Readonly<{
  artifactId: string;
  clipId: string;
  clipName: string;
  clipTakeId: string;
  trackId: string;
  trackName: string;
}>;

export type ProjectStemPrintRegistrationIntent = Readonly<{
  canonicalPlanJson: string;
  mixerSnapshot: ProjectMixerRenderSnapshotV2;
  operationId: string;
  output: ProjectStemPrintOutputIdentity;
  selectedTargets: readonly ProjectStemPrintTargetSnapshot[];
  sourceLineage: Readonly<{
    parentArtifactIds: readonly string[];
    parentClipTakeIds: readonly string[];
  }>;
  version: typeof PROJECT_STEM_PRINT_REGISTRATION_INTENT_VERSION;
}>;

export type ProjectStemPrintRegistrationIntentFailureReason =
  | 'identity-conflict'
  | 'intent-invalid'
  | 'mixer-snapshot-stale'
  | 'plan-stale'
  | 'source-lineage-invalid';

export type ProjectStemPrintRegistrationIntentResolution =
  | Readonly<{
      canCreate: true;
      intent: ProjectStemPrintRegistrationIntent;
    }>
  | Readonly<{
      canCreate: false;
      message: string;
      reason: ProjectStemPrintRegistrationIntentFailureReason;
    }>;

export type ProjectStemPrintRegistrationPreflight =
  | Readonly<{ canDispatch: true; status: 'READY' }>
  | Readonly<{
      canDispatch: false;
      message: string;
      reason: ProjectStemPrintRegistrationIntentFailureReason;
    }>;

export function createProjectStemPrintRegistrationIntent(
  project: ProjectState,
  requestValue: unknown,
  mixerSnapshotValue: unknown,
): ProjectStemPrintRegistrationIntentResolution {
  const request = parseRequest(requestValue);

  if (!request || !isDeeplyFrozen(mixerSnapshotValue)) {
    return fail(
      'intent-invalid',
      'Stem Print requires one immutable Request and Mixer Render Snapshot.',
    );
  }

  if (!areJsonValuesEqual(request.plan.mixerSnapshot, mixerSnapshotValue)) {
    return fail(
      'intent-invalid',
      'Stem Print Request and Mixer Render Snapshot do not match.',
    );
  }

  const canonicalPlanJson = createCanonicalProjectStemPrintPlanJson(
    request.plan,
  );
  const output = createOutputIdentity(request.operationId, project);

  if (!canonicalPlanJson || !output) {
    return fail(
      'intent-invalid',
      'Stem Print registration identities could not be reserved safely.',
    );
  }

  const current = validateCurrentPlan(project, request, canonicalPlanJson);

  if (!current.ok) {
    return fail(current.reason, current.message);
  }

  const sourceLineage = collectSourceLineage(project, request);

  if (!sourceLineage) {
    return fail(
      'source-lineage-invalid',
      'Stem Print source lineage does not match the immutable Plan.',
    );
  }

  const intent = freezeRecursively({
    canonicalPlanJson,
    mixerSnapshot: mixerSnapshotValue,
    operationId: request.operationId,
    output,
    selectedTargets: request.plan.selectedTargets.map((target) => ({ ...target })),
    sourceLineage,
    version: PROJECT_STEM_PRINT_REGISTRATION_INTENT_VERSION,
  }) as ProjectStemPrintRegistrationIntent;

  const preflight = preflightProjectStemPrintRegistration(
    project,
    request,
    intent,
  );

  return preflight.canDispatch
    ? Object.freeze({ canCreate: true as const, intent })
    : fail(preflight.reason, preflight.message);
}

export function preflightProjectStemPrintRegistration(
  project: ProjectState,
  requestValue: unknown,
  intentValue: unknown,
): ProjectStemPrintRegistrationPreflight {
  const request = parseRequest(requestValue);
  const intent = parseIntent(intentValue, request);

  if (!request || !intent) {
    return preflightFail(
      'intent-invalid',
      'Stem Print registration intent is invalid or conflicts with its Request.',
    );
  }

  if (hasOutputIdentityConflict(project, intent.output)) {
    return preflightFail(
      'identity-conflict',
      'Reserved Stem Print output identities are already in use.',
    );
  }

  const current = validateCurrentPlan(
    project,
    request,
    intent.canonicalPlanJson,
  );

  if (!current.ok) {
    return preflightFail(current.reason, current.message);
  }

  const sourceLineage = collectSourceLineage(project, request);

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
      'Stem Print source lineage changed after registration was reserved.',
    );
  }

  return Object.freeze({ canDispatch: true as const, status: 'READY' as const });
}

function parseRequest(value: unknown): ProjectStemPrintApiRequest | undefined {
  if (
    !hasExactKeys(value, ['operationId', 'plan', 'protocolVersion']) ||
    value.protocolVersion !== PROJECT_STEM_PRINT_API_PROTOCOL_VERSION ||
    !isProjectStemPrintOperationId(value.operationId) ||
    !isRecord(value.plan) ||
    value.plan.purpose !== 'stem-print' ||
    value.plan.version !== 1 ||
    !isDeeplyFrozen(value)
  ) {
    return undefined;
  }

  return createCanonicalProjectStemPrintPlanJson(
    value.plan as unknown as ProjectStemPrintPlan,
  )
    ? value as unknown as ProjectStemPrintApiRequest
    : undefined;
}

function parseIntent(
  value: unknown,
  request: ProjectStemPrintApiRequest | undefined,
): ProjectStemPrintRegistrationIntent | undefined {
  if (
    !request ||
    !hasExactKeys(
      value,
      [
        'canonicalPlanJson',
        'mixerSnapshot',
        'operationId',
        'output',
        'selectedTargets',
        'sourceLineage',
        'version',
      ],
    ) ||
    value.version !== PROJECT_STEM_PRINT_REGISTRATION_INTENT_VERSION ||
    value.operationId !== request.operationId ||
    value.canonicalPlanJson !==
      createCanonicalProjectStemPrintPlanJson(request.plan) ||
    !hasExactKeys(
      value.output,
      ['artifactId', 'clipId', 'clipName', 'clipTakeId', 'trackId', 'trackName'],
    ) ||
    !hasExactKeys(
      value.sourceLineage,
      ['parentArtifactIds', 'parentClipTakeIds'],
    ) ||
    !Array.isArray(value.selectedTargets) ||
    !isDeeplyFrozen(value) ||
    !areJsonValuesEqual(value.mixerSnapshot, request.plan.mixerSnapshot) ||
    !areJsonValuesEqual(value.selectedTargets, request.plan.selectedTargets) ||
    !isUniqueTrimmedTextArray(value.sourceLineage.parentArtifactIds) ||
    !isUniqueTrimmedTextArray(value.sourceLineage.parentClipTakeIds) ||
    !isExactOutputIdentity(value.output, request.operationId)
  ) {
    return undefined;
  }

  return value as unknown as ProjectStemPrintRegistrationIntent;
}

function validateCurrentPlan(
  project: ProjectState,
  request: ProjectStemPrintApiRequest,
  canonicalPlanJson: string,
):
  | Readonly<{ ok: true }>
  | Readonly<{
      message: string;
      ok: false;
      reason: 'mixer-snapshot-stale' | 'plan-stale';
    }> {
  let currentSnapshot: ProjectMixerRenderSnapshotV2;

  try {
    currentSnapshot = createProjectMixerRenderSnapshotV2({
      mixer: project.mixer,
      tracks: project.tracks,
    });
  } catch {
    return Object.freeze({
      message: 'Stem Print Mixer state is invalid or incomplete.',
      ok: false as const,
      reason: 'mixer-snapshot-stale' as const,
    });
  }

  if (!areJsonValuesEqual(currentSnapshot, request.plan.mixerSnapshot)) {
    return Object.freeze({
      message: 'Stem Print Mixer state changed after its Snapshot was captured.',
      ok: false as const,
      reason: 'mixer-snapshot-stale' as const,
    });
  }

  const targets = request.plan.selectedTargets.map(toStemTarget);

  let regenerated: ReturnType<typeof createProjectStemPrintPlan>;

  try {
    regenerated = createProjectStemPrintPlan({
      artifacts: project.artifacts,
      bpm: project.bpm,
      mixer: project.mixer,
      playheadTick: project.playheadTick,
      projectEndTick: project.totalTicks,
      sourceAvailability: Object.fromEntries(
        request.plan.sources.map((source) => [source.sourceId, 'openable' as const]),
      ),
      sourceDescriptors: request.plan.sources,
      targets,
      tracks: project.tracks,
    });
  } catch {
    return Object.freeze({
      message: 'Stem Print Plan could not be revalidated against the Project.',
      ok: false as const,
      reason: 'plan-stale' as const,
    });
  }

  if (
    !regenerated.canCreate ||
    createCanonicalProjectStemPrintPlanJson(regenerated.plan) !== canonicalPlanJson
  ) {
    return Object.freeze({
      message: 'Stem Print Plan no longer matches the current Project.',
      ok: false as const,
      reason: 'plan-stale' as const,
    });
  }

  return Object.freeze({ ok: true as const });
}

function collectSourceLineage(
  project: ProjectState,
  request: ProjectStemPrintApiRequest,
): ProjectStemPrintRegistrationIntent['sourceLineage'] | undefined {
  const parentArtifactIds: string[] = [];
  const parentClipTakeIds: string[] = [];

  for (const track of request.plan.tracks) {
    for (const event of track.events) {
      const resolution = resolveActiveAudioTakeSource(project, event.clipId);

      if (resolution.canResolve) {
        if (resolution.plan.descriptor.sourceId !== event.sourceId) {
          return undefined;
        }
        addUnique(parentArtifactIds, resolution.plan.source.artifactId);
        addUnique(parentClipTakeIds, resolution.plan.source.clipTakeId);
        continue;
      }

      const matchingClips = project.tracks
        .flatMap((candidateTrack) => candidateTrack.clips)
        .filter((clip) => clip.id === event.clipId);
      const clip = matchingClips[0];

      if (
        matchingClips.length !== 1 ||
        clip?.sourceFile?.sourceId !== event.sourceId
      ) {
        return undefined;
      }
    }
  }

  return Object.freeze({
    parentArtifactIds: Object.freeze(parentArtifactIds),
    parentClipTakeIds: Object.freeze(parentClipTakeIds),
  });
}

function createOutputIdentity(
  operationId: string,
  project: ProjectState,
): ProjectStemPrintOutputIdentity | undefined {
  const artifactId = createProjectStemPrintArtifactId(operationId);

  if (!artifactId) {
    return undefined;
  }

  const suffix = operationId.slice(PROJECT_STEM_PRINT_OPERATION_ID_PREFIX.length);
  const number = project.tracks.filter(
    (track) => /^Stem Print \d+$/.test(track.name),
  ).length + 1;
  const name = `Stem Print ${String(number).padStart(2, '0')}`;

  return Object.freeze({
    artifactId,
    clipId: `stem-print-clip-${suffix}`,
    clipName: name,
    clipTakeId: `clip-take-${artifactId}`,
    trackId: `stem-print-track-${suffix}`,
    trackName: name,
  });
}

function isExactOutputIdentity(value: Record<string, unknown>, operationId: string) {
  const artifactId = createProjectStemPrintArtifactId(operationId);
  const suffix = operationId.slice(PROJECT_STEM_PRINT_OPERATION_ID_PREFIX.length);
  return Boolean(
    artifactId &&
    value.artifactId === artifactId &&
    value.clipId === `stem-print-clip-${suffix}` &&
    value.clipTakeId === `clip-take-${artifactId}` &&
    value.trackId === `stem-print-track-${suffix}` &&
    isTrimmedText(value.clipName) &&
    value.trackName === value.clipName
  );
}

function hasOutputIdentityConflict(
  project: ProjectState,
  output: ProjectStemPrintOutputIdentity,
): boolean {
  return (
    (project.artifacts ?? []).some((artifact) => artifact.artifactId === output.artifactId) ||
    project.tracks.some((track) =>
      track.id === output.trackId ||
      track.clips.some((clip) =>
        clip.id === output.clipId ||
        (clip.clipTakes ?? []).some((take) => take.clipTakeId === output.clipTakeId),
      ),
    )
  );
}

function toStemTarget(snapshot: ProjectStemPrintTargetSnapshot): ProjectStemPrintTarget {
  return snapshot.kind === 'channel'
    ? Object.freeze({ kind: 'channel' as const, trackId: snapshot.trackId })
    : Object.freeze({ groupTrackId: snapshot.groupTrackId, kind: 'group' as const });
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isDeeplyFrozen(value: unknown): boolean {
  if (!isRecord(value) && !Array.isArray(value)) {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
}

function isUniqueTrimmedTextArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    value.every(isTrimmedText) &&
    new Set(value).size === value.length;
}

function isTrimmedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function freezeRecursively<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(freezeRecursively);
  } else if (isRecord(value)) {
    Object.values(value).forEach(freezeRecursively);
  }
  return typeof value === 'object' && value !== null ? Object.freeze(value) : value;
}

function fail(
  reason: ProjectStemPrintRegistrationIntentFailureReason,
  message: string,
): ProjectStemPrintRegistrationIntentResolution {
  return Object.freeze({ canCreate: false as const, message, reason });
}

function preflightFail(
  reason: ProjectStemPrintRegistrationIntentFailureReason,
  message: string,
): ProjectStemPrintRegistrationPreflight {
  return Object.freeze({ canDispatch: false as const, message, reason });
}
