import { describe, expect, it } from 'vitest';

import { parseLocalEngineGpuJobRecord } from './localEngineJobs';

describe('Local Engine GPU Job progress', () => {
  it('accepts measured progress only on a PROCESSING Job', () => {
    const record = createProcessingRecord({
      accuracy: 'MEASURED',
      currentStep: 4,
      percent: 50,
      totalSteps: 8,
      updatedAt: '2026-09-01T00:00:03.000Z',
    });

    expect(parseLocalEngineGpuJobRecord(record)).toMatchObject({
      progress: {
        accuracy: 'MEASURED',
        currentStep: 4,
        percent: 50,
        totalSteps: 8,
      },
    });
    expect(parseLocalEngineGpuJobRecord({ ...record, state: 'SAVING' })).toBeUndefined();
  });

  it('rejects fake step precision on estimated progress', () => {
    expect(
      parseLocalEngineGpuJobRecord(
        createProcessingRecord({
          accuracy: 'ESTIMATED',
          currentStep: 4,
          percent: 51,
          totalSteps: 8,
          updatedAt: '2026-09-01T00:00:03.000Z',
        }),
      ),
    ).toBeUndefined();
  });
});

function createProcessingRecord(progress: unknown) {
  return {
    attempt: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    history: [
      { attempt: 1, at: '2026-09-01T00:00:00.000Z', state: 'QUEUED' },
      { attempt: 1, at: '2026-09-01T00:00:01.000Z', state: 'LOADING_MODEL' },
      { attempt: 1, at: '2026-09-01T00:00:02.000Z', state: 'PROCESSING' },
    ],
    jobId: 'job-progress-client',
    modelId: 'stable-audio-3-medium',
    modelRevision: 'revision-a',
    progress,
    providerId: 'local-stable-audio-3',
    request: {
      modelId: 'stable-audio-3-medium',
      modelRevision: 'revision-a',
      providerId: 'local-stable-audio-3',
      taskId: 'text-to-audio',
    },
    startedAt: '2026-09-01T00:00:01.000Z',
    state: 'PROCESSING',
    taskId: 'text-to-audio',
    updatedAt: '2026-09-01T00:00:02.000Z',
  };
}
