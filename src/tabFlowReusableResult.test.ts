import { describe, expect, it } from 'vitest';

import {
  lookupReusableTabFlowStageResult,
  type TabFlowStageResultCandidate,
  type TabFlowStageResultQuery,
} from './tabFlowReusableResult';

const query: TabFlowStageResultQuery = {
  scope: {
    familyId: 'flow-family-1',
    familyRevision: 4,
    targetClipId: 'clip-midi-1',
    stageId: 'midi-to-audio',
  },
  fingerprint: 'tabflow-fnv1a64-current',
};

function createCandidate(
  resultId: string,
  finishedAt: string,
  overrides: Partial<TabFlowStageResultCandidate> = {},
): TabFlowStageResultCandidate {
  return {
    resultId,
    scope: query.scope,
    fingerprint: query.fingerprint,
    state: 'COMPLETED',
    finishedAt,
    outputArtifactIds: [`artifact-${resultId}`],
    outputClipTakeIds: [`take-${resultId}`],
    ...overrides,
  };
}

function createAvailability(candidates: readonly TabFlowStageResultCandidate[]) {
  return {
    artifactIds: candidates.flatMap((candidate) =>
      candidate.outputArtifactIds,
    ),
    clipTakeIds: candidates.flatMap((candidate) =>
      candidate.outputClipTakeIds,
    ),
  };
}

describe('TabFlow reusable-result lookup', () => {
  it('selects the newest completed result with an exact scope and fingerprint', () => {
    const older = createCandidate(
      'result-older',
      '2026-07-31T01:00:00.000Z',
    );
    const newer = createCandidate(
      'result-newer',
      '2026-07-31T02:00:00.000Z',
    );
    const lookup = lookupReusableTabFlowStageResult(
      query,
      [older, newer],
      createAvailability([older, newer]),
    );

    expect(lookup.matchedResult?.resultId).toBe('result-newer');
    expect(lookup.reusableResult).toEqual({
      stageId: 'midi-to-audio',
      fingerprint: query.fingerprint,
      isAvailable: true,
    });
  });

  it('rejects failed, partial, stale-fingerprint, and wrong-scope results', () => {
    const candidates = [
      createCandidate('result-failed', '2026-07-31T05:00:00.000Z', {
        state: 'FAILED',
      }),
      createCandidate('result-partial', '2026-07-31T04:00:00.000Z', {
        state: 'PARTIAL',
      }),
      createCandidate('result-stale', '2026-07-31T03:00:00.000Z', {
        fingerprint: 'tabflow-fnv1a64-stale',
      }),
      createCandidate('result-old-family', '2026-07-31T02:00:00.000Z', {
        scope: {
          ...query.scope,
          familyRevision: query.scope.familyRevision - 1,
        },
      }),
    ];
    const lookup = lookupReusableTabFlowStageResult(
      query,
      candidates,
      createAvailability(candidates),
    );

    expect(lookup.matchedResult).toBeNull();
    expect(lookup.reusableResult.isAvailable).toBe(false);
  });

  it('falls back to an older valid result when newer output is unavailable', () => {
    const older = createCandidate(
      'result-older',
      '2026-07-31T01:00:00.000Z',
    );
    const newer = createCandidate(
      'result-newer',
      '2026-07-31T02:00:00.000Z',
    );
    const lookup = lookupReusableTabFlowStageResult(
      query,
      [newer, older],
      createAvailability([older]),
    );

    expect(lookup.matchedResult?.resultId).toBe('result-older');
  });

  it('requires at least one available Artifact output', () => {
    const takeOnly = createCandidate(
      'result-take-only',
      '2026-07-31T01:00:00.000Z',
      {
        outputArtifactIds: [],
      },
    );

    expect(
      lookupReusableTabFlowStageResult(query, [takeOnly], {
        artifactIds: [],
        clipTakeIds: takeOnly.outputClipTakeIds,
      }).matchedResult,
    ).toBeNull();
  });

  it('allows a finalized Artifact result without a ClipTake', () => {
    const artifactOnly = createCandidate(
      'result-artifact-only',
      '2026-07-31T01:00:00.000Z',
      {
        outputClipTakeIds: [],
      },
    );

    expect(
      lookupReusableTabFlowStageResult(query, [artifactOnly], {
        artifactIds: artifactOnly.outputArtifactIds,
        clipTakeIds: [],
      }).matchedResult?.resultId,
    ).toBe('result-artifact-only');
  });

  it('uses the stable result ID as the timestamp tie-breaker', () => {
    const alpha = createCandidate(
      'result-alpha',
      '2026-07-31T01:00:00.000Z',
    );
    const beta = createCandidate(
      'result-beta',
      '2026-07-31T01:00:00.000Z',
    );
    const availability = createAvailability([alpha, beta]);

    expect(
      lookupReusableTabFlowStageResult(
        query,
        [beta, alpha],
        availability,
      ).matchedResult?.resultId,
    ).toBe('result-alpha');
    expect(
      lookupReusableTabFlowStageResult(
        query,
        [alpha, beta],
        availability,
      ).matchedResult?.resultId,
    ).toBe('result-alpha');
  });

  it('returns a frozen snapshot without freezing the candidate input', () => {
    const candidate = createCandidate(
      'result-frozen',
      '2026-07-31T01:00:00.000Z',
    );
    const lookup = lookupReusableTabFlowStageResult(
      query,
      [candidate],
      createAvailability([candidate]),
    );

    expect(Object.isFrozen(lookup)).toBe(true);
    expect(Object.isFrozen(lookup.reusableResult)).toBe(true);
    expect(Object.isFrozen(lookup.matchedResult)).toBe(true);
    expect(Object.isFrozen(lookup.matchedResult?.scope)).toBe(true);
    expect(Object.isFrozen(lookup.matchedResult?.outputArtifactIds)).toBe(true);
    expect(Object.isFrozen(candidate)).toBe(false);
  });

  it('rejects an invalid query instead of guessing a cache scope', () => {
    expect(() =>
      lookupReusableTabFlowStageResult(
        {
          ...query,
          scope: {
            ...query.scope,
            familyRevision: 0,
          },
        },
        [],
        {
          artifactIds: [],
          clipTakeIds: [],
        },
      ),
    ).toThrow('Family revision must be a positive safe integer');
  });
});
