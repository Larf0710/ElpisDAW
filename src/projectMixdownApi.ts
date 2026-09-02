import {
  PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
  PROJECT_MIXDOWN_OPERATION_ID_PREFIX,
  isProjectMixdownOperationId,
} from '../shared/projectMixdownApiProtocol.js';
import {
  PROJECT_MIXDOWN_RENDERER_ID,
  PROJECT_MIXDOWN_RENDERER_VERSION,
  RAW_MIXDOWN_BITS_PER_SAMPLE,
  RAW_MIXDOWN_CHANNELS,
  RAW_MIXDOWN_MIME_TYPE,
  RAW_MIXDOWN_PLAN_VERSION,
  RAW_MIXDOWN_SAMPLE_RATE,
} from '../shared/rawMixdownProtocol.js';
import type { ProjectMixdownPlan } from './projectMixdownPlan';

export type ProjectMixdownApiRequest = Readonly<{
  operationId: string;
  plan: ProjectMixdownPlan;
  protocolVersion: typeof PROJECT_MIXDOWN_API_PROTOCOL_VERSION;
}>;

export type ProjectMixdownApiCompletedResult = Readonly<{
  artifact: Readonly<{
    artifactId: string;
    createdAt: string;
    destination: 'mixdown';
    file: Readonly<{
      extension: '.wav';
      name: string;
      relativePath: string;
      sizeBytes: number;
    }>;
    kind: 'audio';
    provenance: Readonly<{
      planVersion: typeof RAW_MIXDOWN_PLAN_VERSION;
      rendererId: typeof PROJECT_MIXDOWN_RENDERER_ID;
      rendererVersion: typeof PROJECT_MIXDOWN_RENDERER_VERSION;
    }>;
  }>;
  mixdown: Readonly<{
    bitsPerSample: typeof RAW_MIXDOWN_BITS_PER_SAMPLE;
    bytesWritten: number;
    channels: typeof RAW_MIXDOWN_CHANNELS;
    durationSeconds: number;
    frameCount: number;
    mimeType: typeof RAW_MIXDOWN_MIME_TYPE;
    sampleRate: typeof RAW_MIXDOWN_SAMPLE_RATE;
    sourceCount: number;
    trackCount: number;
  }>;
  status: 'COMPLETED';
}>;

export type ProjectMixdownApiOperation = Readonly<{
  operationId: string;
  protocolVersion: typeof PROJECT_MIXDOWN_API_PROTOCOL_VERSION;
  result: ProjectMixdownApiCompletedResult;
}>;

export function createProjectMixdownApiRequest(
  plan: ProjectMixdownPlan,
  operationId = `${PROJECT_MIXDOWN_OPERATION_ID_PREFIX}${globalThis.crypto.randomUUID()}`,
): ProjectMixdownApiRequest {
  if (!isProjectMixdownOperationId(operationId)) {
    throw new Error('Project Mixdown operationId is invalid.');
  }

  let planSnapshot: ProjectMixdownPlan;

  try {
    planSnapshot = freezeRecursively(
      structuredClone(plan),
    ) as ProjectMixdownPlan;
  } catch {
    throw new Error('Project Mixdown Plan could not be snapshotted safely.');
  }

  return Object.freeze({
    operationId,
    plan: planSnapshot,
    protocolVersion: PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
  });
}

export function parseProjectMixdownApiOperation(
  value: unknown,
  expectedOperationId: string,
): ProjectMixdownApiOperation | undefined {
  if (
    !hasExactKeys(value, ['operationId', 'protocolVersion', 'result']) ||
    value.operationId !== expectedOperationId ||
    value.protocolVersion !== PROJECT_MIXDOWN_API_PROTOCOL_VERSION ||
    !hasExactKeys(value.result, ['artifact', 'mixdown', 'status']) ||
    value.result.status !== 'COMPLETED'
  ) {
    return undefined;
  }

  const artifact = parseArtifact(value.result.artifact);
  const mixdown = parseMixdown(value.result.mixdown, artifact);

  if (!artifact || !mixdown) {
    return undefined;
  }

  return Object.freeze({
    operationId: expectedOperationId,
    protocolVersion: PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
    result: Object.freeze({
      artifact,
      mixdown,
      status: 'COMPLETED',
    }),
  });
}

function parseArtifact(value: unknown): ProjectMixdownApiCompletedResult['artifact'] | undefined {
  if (
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
    !isArtifactId(value.artifactId) ||
    !isIsoDate(value.createdAt) ||
    value.destination !== 'mixdown' ||
    value.kind !== 'audio' ||
    !hasExactKeys(value.file, ['extension', 'name', 'relativePath', 'sizeBytes']) ||
    value.file.extension !== '.wav' ||
    value.file.name !== `${value.artifactId}.wav` ||
    value.file.relativePath !== `mixdowns/${value.file.name}` ||
    !Number.isSafeInteger(value.file.sizeBytes) ||
    (value.file.sizeBytes as number) <= 44 ||
    !hasExactKeys(
      value.provenance,
      ['planVersion', 'rendererId', 'rendererVersion'],
    ) ||
    value.provenance.planVersion !== RAW_MIXDOWN_PLAN_VERSION ||
    value.provenance.rendererId !== PROJECT_MIXDOWN_RENDERER_ID ||
    value.provenance.rendererVersion !== PROJECT_MIXDOWN_RENDERER_VERSION
  ) {
    return undefined;
  }

  return Object.freeze({
    artifactId: value.artifactId,
    createdAt: value.createdAt,
    destination: 'mixdown',
    file: Object.freeze({
      extension: '.wav',
      name: value.file.name,
      relativePath: value.file.relativePath,
      sizeBytes: value.file.sizeBytes as number,
    }),
    kind: 'audio',
    provenance: Object.freeze({
      planVersion: RAW_MIXDOWN_PLAN_VERSION,
      rendererId: PROJECT_MIXDOWN_RENDERER_ID,
      rendererVersion: PROJECT_MIXDOWN_RENDERER_VERSION,
    }),
  });
}

function parseMixdown(
  value: unknown,
  artifact: ProjectMixdownApiCompletedResult['artifact'] | undefined,
): ProjectMixdownApiCompletedResult['mixdown'] | undefined {
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
    !Number.isSafeInteger(value.sourceCount) ||
    (value.sourceCount as number) <= 0 ||
    !Number.isSafeInteger(value.trackCount) ||
    (value.trackCount as number) <= 0
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
    trackCount: value.trackCount as number,
  });
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

function isArtifactId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^artifact-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
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
