import type { TabFlowReusableStageResult } from './tabFlowChangedStage';
import {
  freezeTabFlowStageResultRecord,
  isValidTabFlowStageResultRecord,
  validateTabFlowStageResultScope,
} from './tabFlowStageResultIndex';
import type {
  TabFlowStageResultRecord,
  TabFlowStageResultScope,
} from './types';

export type { TabFlowStageResultScope } from './types';
export type TabFlowStageResultCandidate = TabFlowStageResultRecord;

export type TabFlowStageResultQuery = Readonly<{
  scope: TabFlowStageResultScope;
  fingerprint: string;
}>;

export type TabFlowStageResultAvailability = Readonly<{
  artifactIds: readonly string[];
  clipTakeIds: readonly string[];
}>;

export type TabFlowReusableResultLookup = Readonly<{
  matchedResult: TabFlowStageResultCandidate | null;
  reusableResult: TabFlowReusableStageResult;
}>;

export function lookupReusableTabFlowStageResult(
  query: TabFlowStageResultQuery,
  candidates: readonly TabFlowStageResultCandidate[],
  availability: TabFlowStageResultAvailability,
): TabFlowReusableResultLookup {
  validateScope(query.scope, 'TabFlow result query');
  requireNonEmptyString(query.fingerprint, 'TabFlow result query fingerprint');

  const availableArtifactIds = new Set(availability.artifactIds);
  const availableClipTakeIds = new Set(availability.clipTakeIds);
  const matchedResult =
    candidates
      .filter(
        (candidate) =>
          isReusableCandidate(
            candidate,
            query,
            availableArtifactIds,
            availableClipTakeIds,
          ),
      )
      .sort(compareReusableCandidates)[0] ?? null;
  const frozenResult = matchedResult
    ? freezeTabFlowStageResultRecord(matchedResult)
    : null;

  return Object.freeze({
    matchedResult: frozenResult,
    reusableResult: Object.freeze({
      stageId: query.scope.stageId,
      fingerprint: query.fingerprint,
      isAvailable: frozenResult !== null,
    }),
  });
}

function isReusableCandidate(
  candidate: TabFlowStageResultCandidate,
  query: TabFlowStageResultQuery,
  availableArtifactIds: ReadonlySet<string>,
  availableClipTakeIds: ReadonlySet<string>,
): boolean {
  if (
    candidate.state !== 'COMPLETED' ||
    !isValidTabFlowStageResultRecord(candidate) ||
    !hasMatchingScope(candidate.scope, query.scope) ||
    candidate.fingerprint !== query.fingerprint
  ) {
    return false;
  }

  return (
    candidate.outputArtifactIds.every((artifactId) =>
      availableArtifactIds.has(artifactId),
    ) &&
    candidate.outputClipTakeIds.every((clipTakeId) =>
      availableClipTakeIds.has(clipTakeId),
    )
  );
}

function hasMatchingScope(
  candidate: TabFlowStageResultScope,
  query: TabFlowStageResultScope,
): boolean {
  return (
    candidate.familyId === query.familyId &&
    candidate.familyRevision === query.familyRevision &&
    candidate.targetClipId === query.targetClipId &&
    candidate.stageId === query.stageId
  );
}

function compareReusableCandidates(
  left: TabFlowStageResultCandidate,
  right: TabFlowStageResultCandidate,
): number {
  const finishedAtDifference =
    Date.parse(right.finishedAt) - Date.parse(left.finishedAt);

  if (finishedAtDifference !== 0) {
    return finishedAtDifference;
  }

  return compareStableText(left.resultId, right.resultId);
}

function validateScope(scope: TabFlowStageResultScope, label: string): void {
  validateTabFlowStageResultScope(scope, label);
}

function isNonEmptyString(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireNonEmptyString(value: string, label: string): void {
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} must not be empty`);
  }
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
