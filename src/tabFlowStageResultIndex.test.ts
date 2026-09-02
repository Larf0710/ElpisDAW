import { describe, expect, it } from 'vitest';

import { sampleProject } from './sampleProject';
import {
  MAX_TAB_FLOW_STAGE_RESULTS,
  MAX_TAB_FLOW_STAGE_RESULTS_PER_KEY,
  normalizeTabFlowStageResultIndex,
  registerProjectTabFlowStageResult,
  registerTabFlowStageResult,
  selectProjectTabFlowStageResultCandidates,
  selectTabFlowStageResultCandidates,
} from './tabFlowStageResultIndex';
import { lookupReusableTabFlowStageResult } from './tabFlowReusableResult';
import type {
  ProjectState,
  TabFlowStageResultRecord,
} from './types';

describe('persistent TabFlow Stage Result index', () => {
  it('registers, sorts, selects, and reuses exact persistent candidates', () => {
    const older = createResult('result-older', 1);
    const newer = createResult('result-newer', 2);
    const otherFingerprint = createResult('result-other', 3, {
      fingerprint: 'tabflow-fnv1a64-other',
    });
    const results = registerTabFlowStageResult(
      registerTabFlowStageResult(
        registerTabFlowStageResult([], older),
        otherFingerprint,
      ),
      newer,
    );
    const query = {
      fingerprint: newer.fingerprint,
      scope: newer.scope,
    };
    const candidates = selectTabFlowStageResultCandidates(results, query);
    const lookup = lookupReusableTabFlowStageResult(query, candidates, {
      artifactIds: candidates.flatMap(
        (candidate) => candidate.outputArtifactIds,
      ),
      clipTakeIds: candidates.flatMap(
        (candidate) => candidate.outputClipTakeIds,
      ),
    });

    expect(results.map((result) => result.resultId)).toEqual([
      'result-other',
      'result-newer',
      'result-older',
    ]);
    expect(candidates.map((result) => result.resultId)).toEqual([
      'result-newer',
      'result-older',
    ]);
    expect(lookup.matchedResult?.resultId).toBe('result-newer');
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(Object.isFrozen(candidates[0])).toBe(true);
    expect(Object.isFrozen(candidates[0].scope)).toBe(true);
    expect(Object.isFrozen(candidates[0].outputArtifactIds)).toBe(true);
  });

  it('updates only the Project result index and preserves musical state references', () => {
    const project: ProjectState = {
      ...sampleProject,
      artifacts: [],
      tabFlowStageResults: [],
    };
    const result = createResult('result-project', 1);
    const nextProject = registerProjectTabFlowStageResult(project, result);
    const candidates = selectProjectTabFlowStageResultCandidates(nextProject, {
      fingerprint: result.fingerprint,
      scope: result.scope,
    });

    expect(nextProject).not.toBe(project);
    expect(nextProject.artifacts).toBe(project.artifacts);
    expect(nextProject.tracks).toBe(project.tracks);
    expect(nextProject.takes).toBe(project.takes);
    expect(candidates).toEqual([result]);
    expect(project.tabFlowStageResults).toEqual([]);
  });

  it('is idempotent for an identical ID and rejects conflicts or non-completed results', () => {
    const result = createResult('result-stable', 1);
    const once = registerTabFlowStageResult([], result);
    const twice = registerTabFlowStageResult(once, { ...result });

    expect(twice).toEqual(once);
    expect(twice).toHaveLength(1);
    expect(() =>
      registerTabFlowStageResult(once, {
        ...result,
        fingerprint: 'tabflow-fnv1a64-conflict',
      }),
    ).toThrow('Conflicting persistent TabFlow Stage Result ID');
    expect(() =>
      registerTabFlowStageResult([], {
        ...result,
        resultId: 'result-failed',
        state: 'FAILED',
      }),
    ).toThrow('require one valid completed result');
  });

  it('conservatively normalizes legacy, malformed, duplicate, and non-completed entries', () => {
    const valid = createResult('result-valid', 4);
    const duplicate = createResult('result-duplicate', 3);
    const normalized = normalizeTabFlowStageResultIndex(
      JSON.parse(
        JSON.stringify([
          valid,
          duplicate,
          { ...duplicate, state: 'FAILED' },
          createResult('result-partial', 2, { state: 'PARTIAL' }),
          {
            ...createResult('result-invalid-date', 1),
            finishedAt: 'not-a-date',
          },
        ]),
      ),
    );

    expect(normalized).toEqual([valid]);
    expect(normalizeTabFlowStageResultIndex(undefined)).toEqual([]);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized[0])).toBe(true);
  });

  it('retains bounded fallback history per key and a bounded global index', () => {
    const sameKeyResults = Array.from(
      { length: MAX_TAB_FLOW_STAGE_RESULTS_PER_KEY + 3 },
      (_, index) => createResult(`result-key-${index}`, index),
    );
    const boundedKey = normalizeTabFlowStageResultIndex(sameKeyResults);
    const globalResults = Array.from(
      { length: MAX_TAB_FLOW_STAGE_RESULTS + 3 },
      (_, index) =>
        createResult(`result-global-${index}`, index, {
          scope: {
            ...createResult('scope-template', 0).scope,
            stageId: `stage-${index}`,
          },
        }),
    );
    const boundedGlobal = normalizeTabFlowStageResultIndex(globalResults);

    expect(boundedKey).toHaveLength(MAX_TAB_FLOW_STAGE_RESULTS_PER_KEY);
    expect(boundedKey[0].resultId).toBe(
      `result-key-${MAX_TAB_FLOW_STAGE_RESULTS_PER_KEY + 2}`,
    );
    expect(boundedGlobal).toHaveLength(MAX_TAB_FLOW_STAGE_RESULTS);
    expect(boundedGlobal[0].resultId).toBe(
      `result-global-${MAX_TAB_FLOW_STAGE_RESULTS + 2}`,
    );
  });

  it('rejects an invalid index query rather than broadening its scope', () => {
    const result = createResult('result-query', 1);

    expect(() =>
      selectTabFlowStageResultCandidates([result], {
        fingerprint: result.fingerprint,
        scope: {
          ...result.scope,
          familyRevision: 0,
        },
      }),
    ).toThrow('Family revision must be a positive safe integer');
  });
});

function createResult(
  resultId: string,
  sequence: number,
  overrides: Partial<TabFlowStageResultRecord> = {},
): TabFlowStageResultRecord {
  const timestamp = new Date(
    Date.parse('2026-07-31T00:00:00.000Z') + sequence * 1_000,
  ).toISOString();

  return {
    fingerprint: 'tabflow-fnv1a64-current',
    finishedAt: timestamp,
    outputArtifactIds: [`artifact-${resultId}`],
    outputClipTakeIds: [`take-${resultId}`],
    resultId,
    scope: {
      familyId: 'flow-family-1',
      familyRevision: 4,
      stageId: 'midi-to-audio',
      targetClipId: 'clip-midi-1',
    },
    state: 'COMPLETED',
    ...overrides,
  };
}
