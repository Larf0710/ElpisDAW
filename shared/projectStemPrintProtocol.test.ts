import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PROJECT_STEM_PRINT_PLAN_VERSION,
  PROJECT_STEM_PRINT_PURPOSE,
} from './projectStemPrintProtocol.js';

describe('Project Stem Print shared protocol', () => {
  it('pins the stable Plan identity for JavaScript and TypeScript consumers', () => {
    expect(PROJECT_STEM_PRINT_PLAN_VERSION).toBe(1);
    expect(PROJECT_STEM_PRINT_PURPOSE).toBe('stem-print');
    expectTypeOf(PROJECT_STEM_PRINT_PLAN_VERSION).toEqualTypeOf<1>();
    expectTypeOf(PROJECT_STEM_PRINT_PURPOSE).toEqualTypeOf<'stem-print'>();
  });
});
