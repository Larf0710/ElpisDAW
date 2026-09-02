import type {
  CompletedTabFlowStageResultRecord,
  ProjectState,
  TabFlowStageResultRecord,
  TabFlowStageResultScope,
} from './types';

export const MAX_TAB_FLOW_STAGE_RESULTS = 512;
export const MAX_TAB_FLOW_STAGE_RESULTS_PER_KEY = 8;

const MAX_RESULT_ID_LENGTH = 256;
const MAX_SCOPE_ID_LENGTH = 256;
const MAX_FINGERPRINT_LENGTH = 1_024;
const MAX_OUTPUT_IDS = 32;
const VALID_RESULT_STATES = new Set<TabFlowStageResultRecord['state']>([
  'COMPLETED',
  'FAILED',
  'PARTIAL',
]);

export type TabFlowStageResultIndexQuery = Readonly<{
  fingerprint: string;
  scope: TabFlowStageResultScope;
}>;

export function normalizeTabFlowStageResultIndex(
  value: unknown,
): readonly CompletedTabFlowStageResultRecord[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }

  const parsedResults = value
    .map(parseTabFlowStageResultRecord)
    .filter(
      (result): result is TabFlowStageResultRecord =>
        result !== undefined,
    );
  const resultIdCounts = new Map<string, number>();

  parsedResults.forEach((result) => {
    resultIdCounts.set(
      result.resultId,
      (resultIdCounts.get(result.resultId) ?? 0) + 1,
    );
  });

  return pruneTabFlowStageResults(
    parsedResults.filter(
      (result): result is CompletedTabFlowStageResultRecord =>
        result.state === 'COMPLETED' &&
        resultIdCounts.get(result.resultId) === 1,
    ),
  );
}

export function registerProjectTabFlowStageResult(
  project: ProjectState,
  result: TabFlowStageResultRecord,
): ProjectState {
  return {
    ...project,
    tabFlowStageResults: registerTabFlowStageResult(
      project.tabFlowStageResults,
      result,
    ),
  };
}

export function registerTabFlowStageResult(
  currentResults: unknown,
  result: TabFlowStageResultRecord,
): readonly CompletedTabFlowStageResultRecord[] {
  if (
    result.state !== 'COMPLETED' ||
    !isValidTabFlowStageResultRecord(result)
  ) {
    throw new Error(
      'Persistent TabFlow Stage Results require one valid completed result.',
    );
  }

  const frozenResult = freezeCompletedTabFlowStageResultRecord(result);
  const normalizedResults = normalizeTabFlowStageResultIndex(currentResults);
  const existingResult = normalizedResults.find(
    (candidate) => candidate.resultId === frozenResult.resultId,
  );

  if (existingResult) {
    if (areTabFlowStageResultsEqual(existingResult, frozenResult)) {
      return normalizedResults;
    }

    throw new Error(
      `Conflicting persistent TabFlow Stage Result ID: ${frozenResult.resultId}`,
    );
  }

  return pruneTabFlowStageResults([...normalizedResults, frozenResult]);
}

export function selectProjectTabFlowStageResultCandidates(
  project: Pick<ProjectState, 'tabFlowStageResults'>,
  query: TabFlowStageResultIndexQuery,
): readonly CompletedTabFlowStageResultRecord[] {
  return selectTabFlowStageResultCandidates(
    project.tabFlowStageResults,
    query,
  );
}

export function selectTabFlowStageResultCandidates(
  currentResults: unknown,
  query: TabFlowStageResultIndexQuery,
): readonly CompletedTabFlowStageResultRecord[] {
  validateTabFlowStageResultScope(query.scope, 'TabFlow result index query');
  requireBoundedString(
    query.fingerprint,
    'TabFlow result index query fingerprint',
    MAX_FINGERPRINT_LENGTH,
  );

  return Object.freeze(
    normalizeTabFlowStageResultIndex(currentResults).filter(
      (result) =>
        hasMatchingScope(result.scope, query.scope) &&
        result.fingerprint === query.fingerprint,
    ),
  );
}

export function isValidTabFlowStageResultRecord(
  value: unknown,
): value is TabFlowStageResultRecord {
  if (!isRecord(value) || !isRecord(value.scope)) {
    return false;
  }

  return (
    isBoundedString(value.resultId, MAX_RESULT_ID_LENGTH) &&
    isValidTabFlowStageResultScope(value.scope) &&
    isBoundedString(value.fingerprint, MAX_FINGERPRINT_LENGTH) &&
    VALID_RESULT_STATES.has(value.state as TabFlowStageResultRecord['state']) &&
    typeof value.finishedAt === 'string' &&
    !Number.isNaN(Date.parse(value.finishedAt)) &&
    isUniqueBoundedStringArray(
      value.outputArtifactIds,
      1,
      MAX_OUTPUT_IDS,
    ) &&
    isUniqueBoundedStringArray(
      value.outputClipTakeIds,
      0,
      MAX_OUTPUT_IDS,
    )
  );
}

export function freezeTabFlowStageResultRecord(
  result: TabFlowStageResultRecord,
): TabFlowStageResultRecord {
  return Object.freeze({
    fingerprint: result.fingerprint,
    finishedAt: result.finishedAt,
    outputArtifactIds: Object.freeze([...result.outputArtifactIds]),
    outputClipTakeIds: Object.freeze([...result.outputClipTakeIds]),
    resultId: result.resultId,
    scope: Object.freeze({ ...result.scope }),
    state: result.state,
  });
}

export function validateTabFlowStageResultScope(
  scope: TabFlowStageResultScope,
  label: string,
): void {
  requireBoundedString(scope.familyId, `${label} Family ID`, MAX_SCOPE_ID_LENGTH);

  if (!Number.isSafeInteger(scope.familyRevision) || scope.familyRevision <= 0) {
    throw new Error(`${label} Family revision must be a positive safe integer`);
  }

  requireBoundedString(
    scope.targetClipId,
    `${label} target Clip ID`,
    MAX_SCOPE_ID_LENGTH,
  );
  requireBoundedString(scope.stageId, `${label} stage ID`, MAX_SCOPE_ID_LENGTH);
}

function parseTabFlowStageResultRecord(
  value: unknown,
): TabFlowStageResultRecord | undefined {
  return isValidTabFlowStageResultRecord(value)
    ? freezeTabFlowStageResultRecord(value)
    : undefined;
}

function pruneTabFlowStageResults(
  results: readonly CompletedTabFlowStageResultRecord[],
): readonly CompletedTabFlowStageResultRecord[] {
  const perKeyCounts = new Map<string, number>();
  const retainedResults: CompletedTabFlowStageResultRecord[] = [];

  for (const result of [...results].sort(compareNewestResultFirst)) {
    const key = createResultLookupKey(result);
    const keyCount = perKeyCounts.get(key) ?? 0;

    if (keyCount >= MAX_TAB_FLOW_STAGE_RESULTS_PER_KEY) {
      continue;
    }

    perKeyCounts.set(key, keyCount + 1);
    retainedResults.push(freezeCompletedTabFlowStageResultRecord(result));

    if (retainedResults.length >= MAX_TAB_FLOW_STAGE_RESULTS) {
      break;
    }
  }

  return Object.freeze(retainedResults);
}

function freezeCompletedTabFlowStageResultRecord(
  result: TabFlowStageResultRecord,
): CompletedTabFlowStageResultRecord {
  return freezeTabFlowStageResultRecord(
    result,
  ) as CompletedTabFlowStageResultRecord;
}

function createResultLookupKey(result: TabFlowStageResultRecord): string {
  return JSON.stringify([
    result.scope.familyId,
    result.scope.familyRevision,
    result.scope.targetClipId,
    result.scope.stageId,
    result.fingerprint,
  ]);
}

function compareNewestResultFirst(
  left: TabFlowStageResultRecord,
  right: TabFlowStageResultRecord,
): number {
  const finishedAtDifference =
    Date.parse(right.finishedAt) - Date.parse(left.finishedAt);

  return finishedAtDifference !== 0
    ? finishedAtDifference
    : compareStableText(left.resultId, right.resultId);
}

function hasMatchingScope(
  left: TabFlowStageResultScope,
  right: TabFlowStageResultScope,
): boolean {
  return (
    left.familyId === right.familyId &&
    left.familyRevision === right.familyRevision &&
    left.targetClipId === right.targetClipId &&
    left.stageId === right.stageId
  );
}

function areTabFlowStageResultsEqual(
  left: TabFlowStageResultRecord,
  right: TabFlowStageResultRecord,
): boolean {
  return (
    left.resultId === right.resultId &&
    hasMatchingScope(left.scope, right.scope) &&
    left.fingerprint === right.fingerprint &&
    left.state === right.state &&
    left.finishedAt === right.finishedAt &&
    areStringArraysEqual(left.outputArtifactIds, right.outputArtifactIds) &&
    areStringArraysEqual(left.outputClipTakeIds, right.outputClipTakeIds)
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

function isValidTabFlowStageResultScope(
  value: Record<string, unknown>,
): value is Record<string, unknown> & TabFlowStageResultScope {
  return (
    isBoundedString(value.familyId, MAX_SCOPE_ID_LENGTH) &&
    Number.isSafeInteger(value.familyRevision) &&
    (value.familyRevision as number) > 0 &&
    isBoundedString(value.targetClipId, MAX_SCOPE_ID_LENGTH) &&
    isBoundedString(value.stageId, MAX_SCOPE_ID_LENGTH)
  );
}

function isUniqueBoundedStringArray(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    value.every((item) => isBoundedString(item, MAX_RESULT_ID_LENGTH)) &&
    new Set(value).size === value.length
  );
}

function requireBoundedString(
  value: unknown,
  label: string,
  maximumLength: number,
): asserts value is string {
  if (!isBoundedString(value, maximumLength)) {
    throw new Error(
      `${label} must be a non-empty trimmed string no longer than ${maximumLength} characters`,
    );
  }
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    value.length <= maximumLength
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
