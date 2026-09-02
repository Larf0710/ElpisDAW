import { describe, expect, it } from 'vitest';

import { MAX_PROJECT_MIXDOWN_REQUEST_BYTES } from '../shared/projectMixdownApiProtocol.js';
import {
  createCanonicalProjectMixdownPlanJson,
  createCanonicalProjectRenderPlanJson,
  createCanonicalProjectStemPrintPlanJson,
} from './projectMixdownPlanIdentity';
import type { ProjectStemPrintPlan } from './projectStemPrintPlan';

describe('canonical Project render Plan identity', () => {
  it('keeps the existing Mixdown wrapper equivalent to the generic boundary', () => {
    const value = {
      nested: { z: 1, a: true },
      purpose: 'mixdown',
      version: 3,
    };

    expect(createCanonicalProjectMixdownPlanJson(value)).toBe(
      createCanonicalProjectRenderPlanJson(value),
    );
  });

  it('gives Stem Print Plans the same stable key-order identity', () => {
    const first = {
      purpose: 'stem-print',
      selectedTargets: [
        { kind: 'channel', resolvedTrackId: 'track-a', trackId: 'track-a' },
      ],
      version: 1,
    } as unknown as ProjectStemPrintPlan;
    const reordered = {
      version: 1,
      selectedTargets: [
        { trackId: 'track-a', resolvedTrackId: 'track-a', kind: 'channel' },
      ],
      purpose: 'stem-print',
    } as unknown as ProjectStemPrintPlan;

    expect(createCanonicalProjectStemPrintPlanJson(first)).toBe(
      createCanonicalProjectStemPrintPlanJson(reordered),
    );
    expect(createCanonicalProjectStemPrintPlanJson(first)).toBe(
      createCanonicalProjectRenderPlanJson(first),
    );
  });

  it('preserves the existing request-size, depth, and JSON-value limits', () => {
    let tooDeep: unknown = 'leaf';

    for (let depth = 0; depth < 33; depth += 1) {
      tooDeep = { child: tooDeep };
    }

    expect(createCanonicalProjectRenderPlanJson(tooDeep)).toBeUndefined();
    expect(createCanonicalProjectRenderPlanJson({ value: Number.NaN })).toBeUndefined();
    expect(createCanonicalProjectRenderPlanJson({ value: undefined })).toBeUndefined();
    expect(
      createCanonicalProjectRenderPlanJson({
        value: 'x'.repeat(MAX_PROJECT_MIXDOWN_REQUEST_BYTES),
      }),
    ).toBeUndefined();
  });
});
