import { describe, expect, it } from 'vitest';

import { parseProviderProgress } from './providerProgress.mjs';

describe('Provider progress contract', () => {
  it('accepts measured steps and estimated percentages', () => {
    expect(
      parseProviderProgress({
        accuracy: 'MEASURED',
        currentStep: 4,
        percent: 50,
        totalSteps: 8,
      }),
    ).toEqual({ accuracy: 'MEASURED', currentStep: 4, percent: 50, totalSteps: 8 });
    expect(parseProviderProgress({ accuracy: 'ESTIMATED', percent: 51 })).toEqual({
      accuracy: 'ESTIMATED',
      percent: 51,
    });
  });

  it('rejects invalid bounds and fake precision on estimates', () => {
    expect(parseProviderProgress({ accuracy: 'ESTIMATED', percent: 101 })).toBeUndefined();
    expect(
      parseProviderProgress({
        accuracy: 'ESTIMATED',
        currentStep: 4,
        percent: 50,
        totalSteps: 8,
      }),
    ).toBeUndefined();
    expect(
      parseProviderProgress({
        accuracy: 'MEASURED',
        currentStep: 9,
        percent: 100,
        totalSteps: 8,
      }),
    ).toBeUndefined();
  });
});
