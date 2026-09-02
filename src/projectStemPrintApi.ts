import {
  PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
  PROJECT_STEM_PRINT_OPERATION_ID_PREFIX,
  createProjectStemPrintArtifactId,
  isProjectStemPrintOperationId,
} from '../shared/projectStemPrintApiProtocol.js';
import {
  PROJECT_STEM_PRINT_PLAN_VERSION,
} from '../shared/projectStemPrintProtocol.js';
import {
  PROJECT_MIXDOWN_RENDERER_ID,
  PROJECT_MIXDOWN_RENDERER_VERSION,
  RAW_MIXDOWN_BITS_PER_SAMPLE,
  RAW_MIXDOWN_CHANNELS,
  RAW_MIXDOWN_MIME_TYPE,
  RAW_MIXDOWN_SAMPLE_RATE,
} from '../shared/rawMixdownProtocol.js';
import type {
  ProjectStemPrintPlan,
  ProjectStemPrintTargetSnapshot,
} from './projectStemPrintPlan';
import {
  createCanonicalProjectStemPrintPlanJson,
} from './projectMixdownPlanIdentity';

export type ProjectStemPrintApiRequest = Readonly<{
  operationId: string;
  plan: ProjectStemPrintPlan;
  protocolVersion: typeof PROJECT_STEM_PRINT_API_PROTOCOL_VERSION;
}>;

export type ProjectStemPrintApiCompletedResult = Readonly<{
  artifact: Readonly<{
    artifactId: string;
    createdAt: string;
    destination: 'stem-print';
    file: Readonly<{
      extension: '.wav';
      name: string;
      relativePath: string;
      sizeBytes: number;
    }>;
    kind: 'audio';
    provenance: Readonly<{
      planSha256: string;
      planVersion: typeof PROJECT_STEM_PRINT_PLAN_VERSION;
      rendererId: typeof PROJECT_MIXDOWN_RENDERER_ID;
      rendererVersion: typeof PROJECT_MIXDOWN_RENDERER_VERSION;
      selectedTargets: readonly ProjectStemPrintTargetSnapshot[];
    }>;
  }>;
  status: 'COMPLETED';
  stemPrint: Readonly<{
    bitsPerSample: typeof RAW_MIXDOWN_BITS_PER_SAMPLE;
    bytesWritten: number;
    channels: typeof RAW_MIXDOWN_CHANNELS;
    durationSeconds: number;
    frameCount: number;
    mimeType: typeof RAW_MIXDOWN_MIME_TYPE;
    sampleRate: typeof RAW_MIXDOWN_SAMPLE_RATE;
    sourceCount: number;
    targetCount: number;
    trackCount: number;
  }>;
}>;

export type ProjectStemPrintApiOperation = Readonly<{
  operationId: string;
  protocolVersion: typeof PROJECT_STEM_PRINT_API_PROTOCOL_VERSION;
  result: ProjectStemPrintApiCompletedResult;
}>;

export function createProjectStemPrintApiRequest(
  plan: ProjectStemPrintPlan,
  operationId = `${PROJECT_STEM_PRINT_OPERATION_ID_PREFIX}${globalThis.crypto.randomUUID()}`,
): ProjectStemPrintApiRequest {
  if (!isProjectStemPrintOperationId(operationId)) {
    throw new Error('Project Stem Print operationId is invalid.');
  }

  let planSnapshot: ProjectStemPrintPlan;

  try {
    planSnapshot = freezeRecursively(
      structuredClone(plan),
    ) as ProjectStemPrintPlan;
  } catch {
    throw new Error('Project Stem Print Plan could not be snapshotted safely.');
  }

  return Object.freeze({
    operationId,
    plan: planSnapshot,
    protocolVersion: PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
  });
}

export function parseProjectStemPrintApiOperation(
  value: unknown,
  expectedRequest: ProjectStemPrintApiRequest,
  expectedPlanSha256: string,
): ProjectStemPrintApiOperation | undefined {
  if (
    !hasExactKeys(value, ['operationId', 'protocolVersion', 'result']) ||
    value.operationId !== expectedRequest.operationId ||
    value.protocolVersion !== PROJECT_STEM_PRINT_API_PROTOCOL_VERSION ||
    !hasExactKeys(value.result, ['artifact', 'status', 'stemPrint']) ||
    value.result.status !== 'COMPLETED'
  ) {
    return undefined;
  }

  const artifact = parseArtifact(
    value.result.artifact,
    expectedRequest,
    expectedPlanSha256,
  );
  const stemPrint = parseStemPrint(
    value.result.stemPrint,
    artifact,
    expectedRequest,
  );

  if (!artifact || !stemPrint) {
    return undefined;
  }

  return Object.freeze({
    operationId: expectedRequest.operationId,
    protocolVersion: PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
    result: Object.freeze({
      artifact,
      status: 'COMPLETED',
      stemPrint,
    }),
  });
}

export async function createProjectStemPrintPlanSha256(
  plan: ProjectStemPrintPlan,
): Promise<string> {
  const canonicalPlanJson = createCanonicalProjectStemPrintPlanJson(plan);

  if (canonicalPlanJson === undefined) {
    throw new Error('Project Stem Print Plan identity is invalid.');
  }

  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalPlanJson),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseArtifact(
  value: unknown,
  expectedRequest: ProjectStemPrintApiRequest,
  expectedPlanSha256: string,
): ProjectStemPrintApiCompletedResult['artifact'] | undefined {
  const expectedArtifactId = createProjectStemPrintArtifactId(
    expectedRequest.operationId,
  );

  if (
    !expectedArtifactId ||
    !hasExactKeys(
      value,
      [
        'artifactId',
        'createdAt',
        'destination',
        'file',
        'kind',
        'provenance',
      ],
    ) ||
    value.artifactId !== expectedArtifactId ||
    !isIsoDate(value.createdAt) ||
    value.destination !== 'stem-print' ||
    value.kind !== 'audio' ||
    !hasExactKeys(value.file, ['extension', 'name', 'relativePath', 'sizeBytes']) ||
    value.file.extension !== '.wav' ||
    value.file.name !== `${expectedArtifactId}.wav` ||
    value.file.relativePath !== `stem-prints/${value.file.name}` ||
    !Number.isSafeInteger(value.file.sizeBytes) ||
    (value.file.sizeBytes as number) <= 44 ||
    !hasExactKeys(
      value.provenance,
      [
        'planSha256',
        'planVersion',
        'rendererId',
        'rendererVersion',
        'selectedTargets',
      ],
    ) ||
    !isSha256(expectedPlanSha256) ||
    value.provenance.planSha256 !== expectedPlanSha256 ||
    value.provenance.planVersion !== PROJECT_STEM_PRINT_PLAN_VERSION ||
    value.provenance.rendererId !== PROJECT_MIXDOWN_RENDERER_ID ||
    value.provenance.rendererVersion !== PROJECT_MIXDOWN_RENDERER_VERSION
  ) {
    return undefined;
  }

  const selectedTargets = parseSelectedTargets(
    value.provenance.selectedTargets,
    expectedRequest.plan.selectedTargets,
  );

  if (!selectedTargets) {
    return undefined;
  }

  return Object.freeze({
    artifactId: expectedArtifactId,
    createdAt: value.createdAt,
    destination: 'stem-print',
    file: Object.freeze({
      extension: '.wav',
      name: value.file.name,
      relativePath: value.file.relativePath,
      sizeBytes: value.file.sizeBytes as number,
    }),
    kind: 'audio',
    provenance: Object.freeze({
      planSha256: value.provenance.planSha256,
      planVersion: PROJECT_STEM_PRINT_PLAN_VERSION,
      rendererId: PROJECT_MIXDOWN_RENDERER_ID,
      rendererVersion: PROJECT_MIXDOWN_RENDERER_VERSION,
      selectedTargets,
    }),
  });
}

function parseStemPrint(
  value: unknown,
  artifact: ProjectStemPrintApiCompletedResult['artifact'] | undefined,
  expectedRequest: ProjectStemPrintApiRequest,
): ProjectStemPrintApiCompletedResult['stemPrint'] | undefined {
  if (
    !artifact ||
    !hasExactKeys(
      value,
      [
        'bitsPerSample',
        'bytesWritten',
        'channels',
        'durationSeconds',
        'frameCount',
        'mimeType',
        'sampleRate',
        'sourceCount',
        'targetCount',
        'trackCount',
      ],
    ) ||
    value.bitsPerSample !== RAW_MIXDOWN_BITS_PER_SAMPLE ||
    value.bytesWritten !== artifact.file.sizeBytes ||
    value.channels !== RAW_MIXDOWN_CHANNELS ||
    !Number.isFinite(value.durationSeconds) ||
    (value.durationSeconds as number) <= 0 ||
    !Number.isSafeInteger(value.frameCount) ||
    (value.frameCount as number) <= 0 ||
    value.durationSeconds !==
      (value.frameCount as number) / RAW_MIXDOWN_SAMPLE_RATE ||
    value.mimeType !== RAW_MIXDOWN_MIME_TYPE ||
    value.sampleRate !== RAW_MIXDOWN_SAMPLE_RATE ||
    value.sourceCount !== expectedRequest.plan.sources.length ||
    value.targetCount !== expectedRequest.plan.selectedTargets.length ||
    value.trackCount !== expectedRequest.plan.tracks.length
  ) {
    return undefined;
  }

  return Object.freeze({
    bitsPerSample: RAW_MIXDOWN_BITS_PER_SAMPLE,
    bytesWritten: value.bytesWritten as number,
    channels: RAW_MIXDOWN_CHANNELS,
    durationSeconds: value.durationSeconds as number,
    frameCount: value.frameCount as number,
    mimeType: RAW_MIXDOWN_MIME_TYPE,
    sampleRate: RAW_MIXDOWN_SAMPLE_RATE,
    sourceCount: value.sourceCount as number,
    targetCount: value.targetCount as number,
    trackCount: value.trackCount as number,
  });
}

function parseSelectedTargets(
  value: unknown,
  expectedTargets: readonly ProjectStemPrintTargetSnapshot[],
): readonly ProjectStemPrintTargetSnapshot[] | undefined {
  if (!Array.isArray(value) || value.length !== expectedTargets.length) {
    return undefined;
  }

  const targets: ProjectStemPrintTargetSnapshot[] = [];

  for (const [index, candidate] of value.entries()) {
    const expected = expectedTargets[index];

    if (!expected || !isExactTarget(candidate, expected)) {
      return undefined;
    }

    targets.push(Object.freeze({ ...expected }));
  }

  return Object.freeze(targets);
}

function isExactTarget(
  value: unknown,
  expected: ProjectStemPrintTargetSnapshot,
): boolean {
  if (expected.kind === 'channel') {
    return (
      hasExactKeys(value, ['kind', 'resolvedTrackId', 'trackId']) &&
      value.kind === 'channel' &&
      value.trackId === expected.trackId &&
      value.resolvedTrackId === expected.resolvedTrackId
    );
  }

  return (
    hasExactKeys(value, ['groupTrackId', 'kind', 'resolvedTrackId']) &&
    value.kind === 'group' &&
    value.groupTrackId === expected.groupTrackId &&
    value.resolvedTrackId === expected.resolvedTrackId
  );
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach(freezeRecursively);
  } else if (isRecord(value)) {
    Object.values(value).forEach(freezeRecursively);
  }

  return typeof value === 'object' && value !== null
    ? Object.freeze(value)
    : value;
}
