import { describe, expect, it } from 'vitest';

import {
  createGenerationHeaderProgress,
  createProductionHeaderProgress,
} from './generationHeaderProgress';

describe('generation header progress', () => {
  it('maps verified GPU Job phases to monotonic progress stages', () => {
    const statuses = [
      'ENQUEUEING',
      'QUEUED',
      'LOADING_MODEL',
      'PROCESSING',
      'SAVING',
    ];
    const progress = statuses.map((status) =>
      createGenerationHeaderProgress({ operationLabel: 'ACE T2M', status }),
    );

    expect(progress.map((item) => item?.percent)).toEqual([12, 20, 40, 68, 90]);
    expect(progress[progress.length - 1]).toMatchObject({ phaseLabel: 'SAVING OUTPUT' });
  });

  it('returns no progress for terminal Job states', () => {
    expect(
      createGenerationHeaderProgress({
        operationLabel: 'ACE T2M',
        status: 'COMPLETED',
      }),
    ).toBeUndefined();
  });

  it('keeps multi-Take progress monotonic across Take boundaries', () => {
    const firstSaving = createGenerationHeaderProgress({
      itemCount: 3,
      itemNumber: 1,
      operationLabel: 'ACE T2M',
      status: 'SAVING',
    });
    const secondEnqueueing = createGenerationHeaderProgress({
      itemCount: 3,
      itemNumber: 2,
      operationLabel: 'ACE T2M',
      status: 'ENQUEUEING',
    });

    expect(firstSaving?.percent).toBe(30);
    expect(secondEnqueueing?.percent).toBe(37);
  });

  it('uses completed production stages without claiming model-step precision', () => {
    expect(
      createProductionHeaderProgress({
        completedStageCount: 1,
        message: 'Running Stage stable-audio-3-a2a.',
        stageCount: 3,
        status: 'RUNNING',
      }),
    ).toMatchObject({
      percent: 53,
      phaseLabel: 'STAGE 2/3',
    });
  });

  it('shows measured SA3 steps and labels ACE ratios as estimates', () => {
    expect(
      createGenerationHeaderProgress({
        jobProgress: {
          accuracy: 'MEASURED',
          currentStep: 4,
          percent: 50,
          totalSteps: 8,
          updatedAt: '2026-09-01T00:00:01.000Z',
        },
        operationLabel: 'SA3 T2A',
        status: 'PROCESSING',
      }),
    ).toMatchObject({ percent: 65, phaseLabel: 'STEP 4/8 · 50%' });

    expect(
      createGenerationHeaderProgress({
        jobProgress: {
          accuracy: 'ESTIMATED',
          percent: 51,
          updatedAt: '2026-09-01T00:00:01.000Z',
        },
        operationLabel: 'ACE T2M',
        status: 'PROCESSING',
      }),
    ).toMatchObject({ percent: 66, phaseLabel: 'GENERATING · 51% EST.' });
  });

  it('shows elapsed time until a silent active operation becomes visibly stale', () => {
    expect(
      createGenerationHeaderProgress({
        liveness: {
          elapsedSeconds: 18,
          isStale: false,
          lastUpdateAgeSeconds: 18,
        },
        operationLabel: 'ACE T2M',
        status: 'LOADING_MODEL',
      }),
    ).toMatchObject({
      accessiblePhaseLabel: 'LOADING MODEL',
      isStale: false,
      phaseLabel: 'LOADING MODEL · ELAPSED 00:18',
    });

    expect(
      createGenerationHeaderProgress({
        jobProgress: {
          accuracy: 'ESTIMATED',
          percent: 51,
          updatedAt: '2026-09-01T00:00:01.000Z',
        },
        liveness: {
          elapsedSeconds: 72,
          isStale: true,
          lastUpdateAgeSeconds: 34,
        },
        operationLabel: 'ACE T2M',
        status: 'PROCESSING',
      }),
    ).toMatchObject({
      accessiblePhaseLabel: 'Still working. The generation operation remains active.',
      isStale: true,
      percent: 66,
      phaseLabel: 'STILL WORKING · LAST UPDATE 00:34',
    });
  });

  it('applies the same liveness warning to Auto Patch without changing stage progress', () => {
    expect(
      createProductionHeaderProgress({
        completedStageCount: 1,
        liveness: {
          elapsedSeconds: 95,
          isStale: true,
          lastUpdateAgeSeconds: 31,
        },
        message: 'Running Stage stable-audio-3-a2a.',
        stageCount: 3,
        status: 'RUNNING',
      }),
    ).toMatchObject({
      isStale: true,
      percent: 53,
      phaseLabel: 'STILL WORKING · LAST UPDATE 00:31',
    });
  });
});
