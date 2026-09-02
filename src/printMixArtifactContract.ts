import {
  PRINT_MIX_BITS_PER_SAMPLE,
  PRINT_MIX_CHANNELS,
  PRINT_MIX_MIME_TYPE,
  PRINT_MIX_NORMALIZE_TARGET_DBFS,
  PRINT_MIX_NORMALIZE_TARGET_PEAK,
  PRINT_MIX_PLAN_VERSION,
  PRINT_MIX_PROTOCOL_VERSION,
  PRINT_MIX_RENDERER_ID,
  PRINT_MIX_RENDERER_VERSION,
  PRINT_MIX_SAMPLE_RATE,
  createPrintMixArtifactId,
  isPrintMixOperationId,
} from '../shared/printMixProtocol.js';
import { normalizeMidiNotes } from './humToMidiContract';
import { createMidiContentHash } from './midiContentHash';
import type {
  ArtifactLineage,
  PrintMixAudioArtifact,
  PrintMixAudioClipTake,
  PrintMixMidiArtifact,
  PrintMixMidiClipTake,
  PrintMixProvenance,
} from './types';
import { TICKS_PER_QUARTER } from './workflow';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type ParsedPrintMixPlan = Readonly<{
  bpm?: unknown;
  durationSeconds?: unknown;
  mediaType: 'audio' | 'midi';
  normalize?: unknown;
  notes?: unknown;
  operationId: string;
  selectedClipIds: unknown[];
  sourceLineage: unknown[];
  sources: unknown[];
}>;

export function parsePrintMixArtifact(
  value: unknown,
): PrintMixAudioArtifact | PrintMixMidiArtifact | undefined {
  if (!isRecord(value) || !isPrintMixOperationId(value.sourceOperationId)) {
    return undefined;
  }

  return value.kind === 'audio'
    ? parseAudioArtifact(value)
    : value.kind === 'midi'
      ? parseMidiArtifact(value)
      : undefined;
}

export function parsePrintMixClipTake(
  value: unknown,
): PrintMixAudioClipTake | PrintMixMidiClipTake | undefined {
  if (
    !isRecord(value) ||
    value.sourceType !== 'print-mix' ||
    !isId(value.artifactId) ||
    !isId(value.clipTakeId) ||
    !isIsoTimestamp(value.createdAt) ||
    !isTrimmedText(value.label) ||
    value.label.length > 128 ||
    !isPrintMixOperationId(value.sourceOperationId) ||
    value.artifactId !== createPrintMixArtifactId(value.sourceOperationId) ||
    value.clipTakeId !== `clip-take-${value.artifactId}`
  ) {
    return undefined;
  }

  if (
    value.mediaType === 'audio' &&
    hasExactKeys(value, [
      'artifactId',
      'clipTakeId',
      'createdAt',
      'label',
      'mediaType',
      'sourceOperationId',
      'sourceType',
    ])
  ) {
    return {
      artifactId: value.artifactId,
      clipTakeId: value.clipTakeId,
      createdAt: value.createdAt,
      label: value.label,
      mediaType: 'audio',
      sourceOperationId: value.sourceOperationId,
      sourceType: 'print-mix',
    };
  }

  if (
    value.mediaType === 'midi' &&
    hasExactKeys(value, [
      'artifactId',
      'clipTakeId',
      'contentHash',
      'createdAt',
      'label',
      'mediaType',
      'sourceOperationId',
      'sourceType',
    ]) &&
    isMidiContentHash(value.contentHash)
  ) {
    return {
      artifactId: value.artifactId,
      clipTakeId: value.clipTakeId,
      contentHash: value.contentHash,
      createdAt: value.createdAt,
      label: value.label,
      mediaType: 'midi',
      sourceOperationId: value.sourceOperationId,
      sourceType: 'print-mix',
    };
  }

  return undefined;
}

function parseAudioArtifact(
  value: Record<string, unknown>,
): PrintMixAudioArtifact | undefined {
  if (
    !hasExactKeys(value, [
      'artifactId',
      'audio',
      'createdAt',
      'destination',
      'file',
      'kind',
      'lineage',
      'printMixProvenance',
      'sourceOperationId',
    ]) ||
    !isId(value.artifactId) ||
    value.artifactId !== createPrintMixArtifactId(value.sourceOperationId as string) ||
    !isIsoTimestamp(value.createdAt) ||
    value.destination !== 'print-mix' ||
    !hasExactKeys(value.audio, [
      'bitsPerSample',
      'channels',
      'durationSeconds',
      'frameCount',
      'mimeType',
      'sampleRate',
    ]) ||
    value.audio.bitsPerSample !== PRINT_MIX_BITS_PER_SAMPLE ||
    value.audio.channels !== PRINT_MIX_CHANNELS ||
    !Number.isSafeInteger(value.audio.frameCount) ||
    (value.audio.frameCount as number) <= 0 ||
    value.audio.durationSeconds !==
      (value.audio.frameCount as number) / PRINT_MIX_SAMPLE_RATE ||
    value.audio.mimeType !== PRINT_MIX_MIME_TYPE ||
    value.audio.sampleRate !== PRINT_MIX_SAMPLE_RATE ||
    !hasExactKeys(value.file, ['extension', 'name', 'relativePath', 'sizeBytes']) ||
    value.file.extension !== '.wav' ||
    value.file.name !== `${value.artifactId}.wav` ||
    value.file.relativePath !== `print-mixes/${value.file.name}` ||
    value.file.sizeBytes !== 44 + (value.audio.frameCount as number) * 4
  ) {
    return undefined;
  }

  const lineage = parseLineage(value.lineage);
  const provenance = parseAudioProvenance(value.printMixProvenance);
  const plan = provenance
    ? parseCanonicalPlan(provenance.canonicalPlanJson)
    : undefined;

  if (
    !lineage ||
    !provenance ||
    !plan ||
    plan.mediaType !== 'audio' ||
    plan.operationId !== value.sourceOperationId ||
    !isPositiveFinite(plan.durationSeconds) ||
    !doesCommonPlanMatch(plan, provenance, lineage) ||
    plan.normalize !== provenance.normalize ||
    Math.round(plan.durationSeconds * PRINT_MIX_SAMPLE_RATE) !==
      value.audio.frameCount
  ) {
    return undefined;
  }

  return {
    artifactId: value.artifactId,
    audio: {
      bitsPerSample: PRINT_MIX_BITS_PER_SAMPLE,
      channels: PRINT_MIX_CHANNELS,
      durationSeconds: value.audio.durationSeconds as number,
      frameCount: value.audio.frameCount as number,
      mimeType: PRINT_MIX_MIME_TYPE,
      sampleRate: PRINT_MIX_SAMPLE_RATE,
    },
    createdAt: value.createdAt,
    destination: 'print-mix',
    file: {
      extension: '.wav',
      name: value.file.name as string,
      relativePath: value.file.relativePath as string,
      sizeBytes: value.file.sizeBytes as number,
    },
    kind: 'audio',
    lineage,
    printMixProvenance: provenance,
    sourceOperationId: value.sourceOperationId as string,
  };
}

function parseMidiArtifact(
  value: Record<string, unknown>,
): PrintMixMidiArtifact | undefined {
  if (
    !hasExactKeys(value, [
      'artifactId',
      'contentHash',
      'createdAt',
      'kind',
      'lineage',
      'midi',
      'printMixProvenance',
      'sourceOperationId',
    ]) ||
    !isId(value.artifactId) ||
    value.artifactId !== createPrintMixArtifactId(value.sourceOperationId as string) ||
    !isIsoTimestamp(value.createdAt) ||
    !isMidiContentHash(value.contentHash) ||
    !hasExactKeys(value.midi, ['bpm', 'notes', 'ticksPerQuarter']) ||
    !isPositiveFinite(value.midi.bpm) ||
    value.midi.ticksPerQuarter !== TICKS_PER_QUARTER
  ) {
    return undefined;
  }

  let notes;

  try {
    notes = normalizeMidiNotes(value.midi.notes);
  } catch {
    return undefined;
  }

  const midi = {
    bpm: value.midi.bpm as number,
    notes,
    ticksPerQuarter: TICKS_PER_QUARTER,
  };
  const lineage = parseLineage(value.lineage);
  const provenance = parseCommonProvenance(value.printMixProvenance);
  const plan = provenance
    ? parseCanonicalPlan(provenance.canonicalPlanJson)
    : undefined;

  if (
    !lineage ||
    !provenance ||
    !plan ||
    plan.mediaType !== 'midi' ||
    plan.operationId !== value.sourceOperationId ||
    !doesCommonPlanMatch(plan, provenance, lineage) ||
    !areJsonValuesEqual(plan.notes, notes) ||
    plan.bpm !== midi.bpm ||
    createMidiContentHash(midi) !== value.contentHash
  ) {
    return undefined;
  }

  return {
    artifactId: value.artifactId,
    contentHash: value.contentHash,
    createdAt: value.createdAt,
    kind: 'midi',
    lineage,
    midi,
    printMixProvenance: provenance,
    sourceOperationId: value.sourceOperationId as string,
  };
}

function parseCommonProvenance(
  value: unknown,
): PrintMixProvenance | undefined {
  if (
    !hasExactKeys(value, [
      'canonicalPlanJson',
      'inputClipIds',
      'inputSourceIds',
      'operationProtocolVersion',
      'planSha256',
      'planVersion',
      'schemaVersion',
    ]) ||
    !isTrimmedText(value.canonicalPlanJson) ||
    !isUniqueTextArray(value.inputClipIds) ||
    value.inputClipIds.length < 2 ||
    !isUniqueTextArray(value.inputSourceIds) ||
    value.inputSourceIds.length === 0 ||
    value.operationProtocolVersion !== PRINT_MIX_PROTOCOL_VERSION ||
    !isSha256(value.planSha256) ||
    value.planVersion !== PRINT_MIX_PLAN_VERSION ||
    value.schemaVersion !== 1
  ) {
    return undefined;
  }

  return {
    canonicalPlanJson: value.canonicalPlanJson,
    inputClipIds: value.inputClipIds,
    inputSourceIds: value.inputSourceIds,
    operationProtocolVersion: PRINT_MIX_PROTOCOL_VERSION,
    planSha256: value.planSha256,
    planVersion: PRINT_MIX_PLAN_VERSION,
    schemaVersion: 1,
  };
}

function parseAudioProvenance(
  value: unknown,
): PrintMixAudioArtifact['printMixProvenance'] | undefined {
  if (
    !hasExactKeys(value, [
      'appliedGain',
      'canonicalPlanJson',
      'clippingWarning',
      'inputClipIds',
      'inputSourceIds',
      'normalize',
      'operationProtocolVersion',
      'outputPeak',
      'planSha256',
      'planVersion',
      'preNormalizationPeak',
      'rendererId',
      'rendererVersion',
      'schemaVersion',
      'targetPeakDbfs',
    ])
  ) {
    return undefined;
  }

  const common = parseCommonProvenance({
    canonicalPlanJson: value.canonicalPlanJson,
    inputClipIds: value.inputClipIds,
    inputSourceIds: value.inputSourceIds,
    operationProtocolVersion: value.operationProtocolVersion,
    planSha256: value.planSha256,
    planVersion: value.planVersion,
    schemaVersion: value.schemaVersion,
  });

  if (
    !common ||
    !isNonNegativeFinite(value.appliedGain) ||
    typeof value.clippingWarning !== 'boolean' ||
    typeof value.normalize !== 'boolean' ||
    !isNonNegativeFinite(value.outputPeak) ||
    !isNonNegativeFinite(value.preNormalizationPeak) ||
    value.rendererId !== PRINT_MIX_RENDERER_ID ||
    value.rendererVersion !== PRINT_MIX_RENDERER_VERSION ||
    value.targetPeakDbfs !== PRINT_MIX_NORMALIZE_TARGET_DBFS ||
    (value.normalize &&
      (value.clippingWarning ||
        !nearlyEqual(
          value.appliedGain,
          value.preNormalizationPeak === 0
            ? 1
            : PRINT_MIX_NORMALIZE_TARGET_PEAK /
                value.preNormalizationPeak,
        ) ||
        !nearlyEqual(
          value.outputPeak,
          value.preNormalizationPeak === 0
            ? 0
            : PRINT_MIX_NORMALIZE_TARGET_PEAK,
        ))) ||
    (!value.normalize &&
      (value.appliedGain !== 1 ||
        value.outputPeak !== value.preNormalizationPeak ||
        value.clippingWarning !== (value.preNormalizationPeak > 1)))
  ) {
    return undefined;
  }

  return {
    ...common,
    appliedGain: value.appliedGain,
    clippingWarning: value.clippingWarning,
    normalize: value.normalize,
    outputPeak: value.outputPeak,
    preNormalizationPeak: value.preNormalizationPeak,
    rendererId: PRINT_MIX_RENDERER_ID,
    rendererVersion: PRINT_MIX_RENDERER_VERSION,
    targetPeakDbfs: PRINT_MIX_NORMALIZE_TARGET_DBFS,
  };
}

function parseCanonicalPlan(value: string): ParsedPrintMixPlan | undefined {
  try {
    const plan: unknown = JSON.parse(value);

    if (
      !isRecord(plan) ||
      JSON.stringify(plan) !== value ||
      plan.version !== PRINT_MIX_PLAN_VERSION ||
      plan.purpose !== 'print-mix' ||
      !isPrintMixOperationId(plan.operationId) ||
      (plan.mediaType !== 'audio' && plan.mediaType !== 'midi') ||
      !Array.isArray(plan.selectedClipIds) ||
      !Array.isArray(plan.sourceLineage) ||
      !Array.isArray(plan.sources)
    ) {
      return undefined;
    }

    return plan as unknown as ParsedPrintMixPlan;
  } catch {
    return undefined;
  }
}

function doesCommonPlanMatch(
  plan: ParsedPrintMixPlan,
  provenance: PrintMixProvenance,
  lineage: ArtifactLineage,
): boolean {
  const planSourceIds = plan.sources.map((source) =>
    isRecord(source)
      ? plan.mediaType === 'audio'
        ? source.sourceId
        : source.artifactId
      : undefined,
  );
  const parentArtifactIds = unique(
    plan.sourceLineage.map(
      (source) => isRecord(source) ? source.artifactId : undefined,
    ),
  );
  const parentClipTakeIds = unique(
    plan.sourceLineage.map(
      (source) => isRecord(source) ? source.clipTakeId : undefined,
    ),
  );

  return (
    areJsonValuesEqual(plan.selectedClipIds, provenance.inputClipIds) &&
    areJsonValuesEqual(planSourceIds, provenance.inputSourceIds) &&
    areJsonValuesEqual(parentArtifactIds, lineage.parentArtifactIds) &&
    areJsonValuesEqual(parentClipTakeIds, lineage.parentClipTakeIds)
  );
}

function parseLineage(value: unknown): ArtifactLineage | undefined {
  if (
    !hasExactKeys(value, ['parentArtifactIds', 'parentClipTakeIds']) ||
    !isUniqueTextArray(value.parentArtifactIds) ||
    !isUniqueTextArray(value.parentClipTakeIds) ||
    value.parentArtifactIds.length === 0 ||
    value.parentClipTakeIds.length === 0
  ) {
    return undefined;
  }
  return {
    parentArtifactIds: value.parentArtifactIds,
    parentClipTakeIds: value.parentClipTakeIds,
  };
}

function isUniqueTextArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every(isTrimmedText) &&
    new Set(value).size === value.length;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isMidiContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^fnv1a64-[0-9a-f]{16}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function isTrimmedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <=
    Number.EPSILON * Math.max(1, Math.abs(right)) * 8;
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

function unique(values: readonly unknown[]): unknown[] {
  return [...new Set(values)];
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
