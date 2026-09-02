import {
  PRINT_MIX_BITS_PER_SAMPLE,
  PRINT_MIX_CHANNELS,
  PRINT_MIX_EXTENSION,
  PRINT_MIX_MIME_TYPE,
  PRINT_MIX_NORMALIZE_TARGET_DBFS,
  PRINT_MIX_NORMALIZE_TARGET_PEAK,
  PRINT_MIX_OPERATION_ID_PREFIX,
  PRINT_MIX_PLAN_VERSION,
  PRINT_MIX_PROTOCOL_VERSION,
  PRINT_MIX_RENDERER_ID,
  PRINT_MIX_RENDERER_VERSION,
  PRINT_MIX_SAMPLE_RATE,
  createPrintMixArtifactId,
  isPrintMixOperationId,
} from '../shared/printMixProtocol.js';
import {
  createCanonicalPrintMixPlanJson,
  type PrintMixAudioPlan,
  type PrintMixMidiPlan,
  type PrintMixPlan,
} from './printMixPlan';

export type PrintMixRequest = Readonly<{
  operationId: string;
  plan: PrintMixPlan;
  protocolVersion: typeof PRINT_MIX_PROTOCOL_VERSION;
}>;

export type PrintMixAudioCompletedResult = Readonly<{
  artifact: Readonly<{
    artifactId: string;
    createdAt: string;
    destination: 'print-mix';
    file: Readonly<{
      extension: typeof PRINT_MIX_EXTENSION;
      name: string;
      relativePath: string;
      sizeBytes: number;
    }>;
    kind: 'audio';
    provenance: Readonly<{
      planSha256: string;
      planVersion: typeof PRINT_MIX_PLAN_VERSION;
      rendererId: typeof PRINT_MIX_RENDERER_ID;
      rendererVersion: typeof PRINT_MIX_RENDERER_VERSION;
    }>;
  }>;
  printMix: Readonly<{
    appliedGain: number;
    bitsPerSample: typeof PRINT_MIX_BITS_PER_SAMPLE;
    bytesWritten: number;
    channels: typeof PRINT_MIX_CHANNELS;
    clippingWarning: boolean;
    durationSeconds: number;
    frameCount: number;
    mediaType: 'audio';
    mimeType: typeof PRINT_MIX_MIME_TYPE;
    normalize: boolean;
    outputPeak: number;
    preNormalizationPeak: number;
    sampleRate: typeof PRINT_MIX_SAMPLE_RATE;
    sourceCount: number;
    targetPeakDbfs: typeof PRINT_MIX_NORMALIZE_TARGET_DBFS;
  }>;
  status: 'COMPLETED';
}>;

export type PrintMixMidiCompletedResult = Readonly<{
  artifact: Readonly<{
    artifactId: string;
    createdAt: string;
    kind: 'midi';
    provenance: Readonly<{
      planSha256: string;
      planVersion: typeof PRINT_MIX_PLAN_VERSION;
    }>;
  }>;
  printMix: Readonly<{
    mediaType: 'midi';
    noteCount: number;
    sourceCount: number;
  }>;
  status: 'COMPLETED';
}>;

export type PrintMixOperation =
  | Readonly<{
      operationId: string;
      protocolVersion: typeof PRINT_MIX_PROTOCOL_VERSION;
      result: PrintMixAudioCompletedResult;
    }>
  | Readonly<{
      operationId: string;
      protocolVersion: typeof PRINT_MIX_PROTOCOL_VERSION;
      result: PrintMixMidiCompletedResult;
    }>;

export function createPrintMixRequest(
  plan: PrintMixPlan,
): PrintMixRequest {
  if (
    !isPrintMixOperationId(plan.operationId) ||
    createCanonicalPrintMixPlanJson(plan) === undefined
  ) {
    throw new Error('PRINT MIX Plan identity is invalid.');
  }

  let planSnapshot: PrintMixPlan;

  try {
    planSnapshot = freezeRecursively(structuredClone(plan)) as PrintMixPlan;
  } catch {
    throw new Error('PRINT MIX Plan could not be snapshotted safely.');
  }

  return Object.freeze({
    operationId: planSnapshot.operationId,
    plan: planSnapshot,
    protocolVersion: PRINT_MIX_PROTOCOL_VERSION,
  });
}

export async function createCompletedPrintMixMidiOperation(
  request: PrintMixRequest & Readonly<{ plan: PrintMixMidiPlan }>,
  clock: () => Date = () => new Date(),
): Promise<PrintMixOperation> {
  const artifactId = createPrintMixArtifactId(request.operationId);

  if (!artifactId || !isExactRequest(request) || request.plan.mediaType !== 'midi') {
    throw new Error('MIDI PRINT MIX Request is invalid.');
  }

  const createdAt = toIsoTimestamp(clock);
  const planSha256 = await createPrintMixPlanSha256(request.plan);

  return freezeRecursively({
    operationId: request.operationId,
    protocolVersion: PRINT_MIX_PROTOCOL_VERSION,
    result: {
      artifact: {
        artifactId,
        createdAt,
        kind: 'midi' as const,
        provenance: {
          planSha256,
          planVersion: PRINT_MIX_PLAN_VERSION,
        },
      },
      printMix: {
        mediaType: 'midi' as const,
        noteCount: request.plan.notes.length,
        sourceCount: request.plan.sources.length,
      },
      status: 'COMPLETED' as const,
    },
  }) as PrintMixOperation;
}

export async function parsePrintMixOperation(
  value: unknown,
  expectedRequest: PrintMixRequest,
): Promise<PrintMixOperation | undefined> {
  if (
    !isExactRequest(expectedRequest) ||
    !hasExactKeys(value, ['operationId', 'protocolVersion', 'result']) ||
    value.operationId !== expectedRequest.operationId ||
    value.protocolVersion !== PRINT_MIX_PROTOCOL_VERSION ||
    !hasExactKeys(value.result, ['artifact', 'printMix', 'status']) ||
    value.result.status !== 'COMPLETED'
  ) {
    return undefined;
  }

  const planSha256 = await createPrintMixPlanSha256(expectedRequest.plan);
  return expectedRequest.plan.mediaType === 'audio'
    ? parseAudioOperation(value, expectedRequest, planSha256)
    : parseMidiOperation(value, expectedRequest, planSha256);
}

export async function createPrintMixPlanSha256(
  plan: PrintMixPlan,
): Promise<string> {
  const canonicalPlanJson = createCanonicalPrintMixPlanJson(plan);

  if (!canonicalPlanJson) {
    throw new Error('PRINT MIX Plan identity is invalid.');
  }

  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalPlanJson),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseAudioOperation(
  value: Record<string, unknown>,
  request: PrintMixRequest,
  planSha256: string,
): PrintMixOperation | undefined {
  if (request.plan.mediaType !== 'audio') {
    return undefined;
  }

  const result = value.result as Record<string, unknown>;
  const artifact = result.artifact;
  const printMix = result.printMix;
  const artifactId = createPrintMixArtifactId(request.operationId);
  const expectedFrameCount = Math.round(
    request.plan.durationSeconds * PRINT_MIX_SAMPLE_RATE,
  );

  if (
    !artifactId ||
    !hasExactKeys(artifact, [
      'artifactId',
      'createdAt',
      'destination',
      'file',
      'kind',
      'provenance',
    ]) ||
    artifact.artifactId !== artifactId ||
    !isIsoTimestamp(artifact.createdAt) ||
    artifact.destination !== 'print-mix' ||
    artifact.kind !== 'audio' ||
    !hasExactKeys(artifact.file, [
      'extension',
      'name',
      'relativePath',
      'sizeBytes',
    ]) ||
    artifact.file.extension !== PRINT_MIX_EXTENSION ||
    artifact.file.name !== `${artifactId}.wav` ||
    artifact.file.relativePath !== `print-mixes/${artifact.file.name}` ||
    !Number.isSafeInteger(artifact.file.sizeBytes) ||
    !hasExactKeys(artifact.provenance, [
      'planSha256',
      'planVersion',
      'rendererId',
      'rendererVersion',
    ]) ||
    artifact.provenance.planSha256 !== planSha256 ||
    artifact.provenance.planVersion !== PRINT_MIX_PLAN_VERSION ||
    artifact.provenance.rendererId !== PRINT_MIX_RENDERER_ID ||
    artifact.provenance.rendererVersion !== PRINT_MIX_RENDERER_VERSION ||
    !hasExactKeys(printMix, [
      'appliedGain',
      'bitsPerSample',
      'bytesWritten',
      'channels',
      'clippingWarning',
      'durationSeconds',
      'frameCount',
      'mediaType',
      'mimeType',
      'normalize',
      'outputPeak',
      'preNormalizationPeak',
      'sampleRate',
      'sourceCount',
      'targetPeakDbfs',
    ]) ||
    printMix.bitsPerSample !== PRINT_MIX_BITS_PER_SAMPLE ||
    printMix.bytesWritten !== artifact.file.sizeBytes ||
    printMix.channels !== PRINT_MIX_CHANNELS ||
    printMix.frameCount !== expectedFrameCount ||
    printMix.durationSeconds !== expectedFrameCount / PRINT_MIX_SAMPLE_RATE ||
    printMix.mediaType !== 'audio' ||
    printMix.mimeType !== PRINT_MIX_MIME_TYPE ||
    printMix.normalize !== request.plan.normalize ||
    printMix.sampleRate !== PRINT_MIX_SAMPLE_RATE ||
    printMix.sourceCount !== request.plan.sources.length ||
    printMix.targetPeakDbfs !== PRINT_MIX_NORMALIZE_TARGET_DBFS ||
    artifact.file.sizeBytes !== 44 + expectedFrameCount * 4 ||
    !hasValidAudioLevels(printMix, request.plan)
  ) {
    return undefined;
  }

  return freezeRecursively({
    operationId: request.operationId,
    protocolVersion: PRINT_MIX_PROTOCOL_VERSION,
    result: {
      artifact: {
        artifactId,
        createdAt: artifact.createdAt,
        destination: 'print-mix' as const,
        file: {
          extension: PRINT_MIX_EXTENSION,
          name: artifact.file.name,
          relativePath: artifact.file.relativePath,
          sizeBytes: artifact.file.sizeBytes,
        },
        kind: 'audio' as const,
        provenance: {
          planSha256,
          planVersion: PRINT_MIX_PLAN_VERSION,
          rendererId: PRINT_MIX_RENDERER_ID,
          rendererVersion: PRINT_MIX_RENDERER_VERSION,
        },
      },
      printMix: { ...printMix },
      status: 'COMPLETED' as const,
    },
  }) as PrintMixOperation;
}

function parseMidiOperation(
  value: Record<string, unknown>,
  request: PrintMixRequest,
  planSha256: string,
): PrintMixOperation | undefined {
  if (request.plan.mediaType !== 'midi') {
    return undefined;
  }

  const result = value.result as Record<string, unknown>;
  const artifact = result.artifact;
  const printMix = result.printMix;
  const artifactId = createPrintMixArtifactId(request.operationId);

  if (
    !artifactId ||
    !hasExactKeys(artifact, [
      'artifactId',
      'createdAt',
      'kind',
      'provenance',
    ]) ||
    artifact.artifactId !== artifactId ||
    !isIsoTimestamp(artifact.createdAt) ||
    artifact.kind !== 'midi' ||
    !hasExactKeys(artifact.provenance, ['planSha256', 'planVersion']) ||
    artifact.provenance.planSha256 !== planSha256 ||
    artifact.provenance.planVersion !== PRINT_MIX_PLAN_VERSION ||
    !hasExactKeys(printMix, ['mediaType', 'noteCount', 'sourceCount']) ||
    printMix.mediaType !== 'midi' ||
    printMix.noteCount !== request.plan.notes.length ||
    printMix.sourceCount !== request.plan.sources.length
  ) {
    return undefined;
  }

  return freezeRecursively({
    operationId: request.operationId,
    protocolVersion: PRINT_MIX_PROTOCOL_VERSION,
    result: {
      artifact: {
        artifactId,
        createdAt: artifact.createdAt,
        kind: 'midi' as const,
        provenance: { planSha256, planVersion: PRINT_MIX_PLAN_VERSION },
      },
      printMix: { ...printMix },
      status: 'COMPLETED' as const,
    },
  }) as PrintMixOperation;
}

function hasValidAudioLevels(
  value: Record<string, unknown>,
  plan: PrintMixAudioPlan,
): boolean {
  const preNormalizationPeak = value.preNormalizationPeak;
  const outputPeak = value.outputPeak;
  const appliedGain = value.appliedGain;

  if (
    !isFiniteNonNegative(preNormalizationPeak) ||
    !isFiniteNonNegative(outputPeak) ||
    !isFiniteNonNegative(appliedGain) ||
    typeof value.clippingWarning !== 'boolean'
  ) {
    return false;
  }

  if (plan.normalize) {
    const expectedGain =
      preNormalizationPeak === 0
        ? 1
        : PRINT_MIX_NORMALIZE_TARGET_PEAK / preNormalizationPeak;
    const expectedOutputPeak =
      preNormalizationPeak === 0 ? 0 : PRINT_MIX_NORMALIZE_TARGET_PEAK;
    return (
      value.clippingWarning === false &&
      nearlyEqual(appliedGain, expectedGain) &&
      nearlyEqual(outputPeak, expectedOutputPeak)
    );
  }

  return (
    appliedGain === 1 &&
    outputPeak === preNormalizationPeak &&
    value.clippingWarning === (preNormalizationPeak > 1)
  );
}

function isExactRequest(value: unknown): value is PrintMixRequest {
  return (
    hasExactKeys(value, ['operationId', 'plan', 'protocolVersion']) &&
    value.protocolVersion === PRINT_MIX_PROTOCOL_VERSION &&
    isPrintMixOperationId(value.operationId) &&
    typeof value.plan === 'object' &&
    value.plan !== null &&
    (value.plan as PrintMixPlan).operationId === value.operationId &&
    (value.plan as PrintMixPlan).purpose === 'print-mix' &&
    (value.plan as PrintMixPlan).version === PRINT_MIX_PLAN_VERSION &&
    ((value.plan as PrintMixPlan).mediaType === 'audio' ||
      (value.plan as PrintMixPlan).mediaType === 'midi') &&
    isDeeplyFrozen(value)
  );
}

function toIsoTimestamp(clock: () => Date): string {
  let timestamp: string;

  try {
    timestamp = clock().toISOString();
  } catch {
    throw new Error('PRINT MIX completion clock is invalid.');
  }

  return timestamp;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(right)) * 8;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function freezeRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach(freezeRecursively);
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeRecursively);
  }
  return typeof value === 'object' && value !== null ? Object.freeze(value) : value;
}

export function createPrintMixOperationId(): string {
  return `${PRINT_MIX_OPERATION_ID_PREFIX}${globalThis.crypto.randomUUID()}`;
}
