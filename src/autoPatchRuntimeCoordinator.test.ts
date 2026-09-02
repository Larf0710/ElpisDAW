import { describe, expect, it } from 'vitest';
import {
  beginAutoPatchRuntimeStage,
  completeAutoPatchRuntimeStage,
  createAutoPatchRuntimeCoordinator,
  failAutoPatchRuntimeStage,
  type AutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeCoordinatorResolution,
} from './autoPatchRuntimeCoordinator';
import {
  createCompletedResult,
  createRuntimeTarget,
  createScope,
  createValidatedPreflight,
  editedArtifactId,
  editedClipTakeId,
  instrumentArtifactId,
  instrumentClipTakeId,
  soundFontResourceId,
  stageInstrumentId,
  stageMidiEditId,
} from './autoPatchExecutionFrontier.testFixture';

const runId = 'run-runtime-coordinator';
const createdAt = '2026-07-31T00:00:00.000Z';

describe('Auto Patch runtime coordinator', () => {
  it('dispatches and completes executable Stages in canonical order', () => {
    const initial = requireCoordinator(
      createAutoPatchRuntimeCoordinator({
        createdAt,
        runId,
        runtimeTargets: [createRuntimeTarget()],
        stageResults: [],
        validatedPreflight: createValidatedPreflight(),
      }),
    );

    expect(initial).toMatchObject({
      activeAttempt: null,
      activeStage: {
        action: 'execute',
        scope: { stageId: stageMidiEditId },
      },
      status: 'READY',
    });

    const midiStarted = beginAutoPatchRuntimeStage(initial, {
      attemptId: 'attempt-midi-edit',
      startedAt: '2026-07-31T00:00:10.000Z',
    });
    const midiRunning = requireCoordinator(midiStarted);

    expect(midiStarted).toMatchObject({
      dispatch: {
        attemptId: 'attempt-midi-edit',
        execution: { kind: 'builtin' },
        node: {
          parameters: [{ id: 'quantize', value: '1/16' }],
          patchTabId: stageMidiEditId,
        },
        runId,
        scope: { stageId: stageMidiEditId },
      },
      ok: true,
    });
    expect(midiRunning.status).toBe('RUNNING');

    if (midiRunning.status !== 'RUNNING') {
      throw new Error('MIDI Edit Stage must be running');
    }

    const midiResult = {
      ...createCompletedResult(
        createScope(stageMidiEditId),
        midiRunning.activeStage.fingerprint,
        'result-midi-edit',
        [editedArtifactId],
        [editedClipTakeId],
      ),
      finishedAt: '2026-07-31T00:01:00.000Z',
    };
    const instrumentReady = requireCoordinator(
      completeAutoPatchRuntimeStage(midiRunning, {
        attemptId: 'attempt-midi-edit',
        result: midiResult,
        runtimeTarget: createRuntimeTarget({
          artifactIds: [editedArtifactId],
          artifactIdentities: [
            {
              artifactId: editedArtifactId,
              mediaType: 'midi',
              midi: {
                contentHash: 'edited-hash',
                revision: 2,
              },
            },
          ],
          clipTakeIds: [editedClipTakeId],
        }),
      }),
    );

    expect(instrumentReady).toMatchObject({
      activeStage: {
        action: 'execute',
        artifactInputs: [
          {
            artifactIds: [editedArtifactId],
            clipTakeIds: [editedClipTakeId],
            portId: 'midi-in',
          },
        ],
        scope: { stageId: stageInstrumentId },
      },
      attempts: [
        {
          attemptId: 'attempt-midi-edit',
          resultId: 'result-midi-edit',
          state: 'COMPLETED',
        },
      ],
      status: 'READY',
    });

    const instrumentStarted = beginAutoPatchRuntimeStage(
      instrumentReady,
      {
        attemptId: 'attempt-instrument',
        startedAt: '2026-07-31T00:01:10.000Z',
      },
    );
    const instrumentRunning = requireCoordinator(instrumentStarted);

    expect(instrumentStarted).toMatchObject({
      dispatch: {
        execution: {
          kind: 'provider',
          modelId: soundFontResourceId,
        },
        node: { patchTabId: stageInstrumentId },
        resourceInputs: [
          {
            portId: 'soundfont-in',
            resourceId: soundFontResourceId,
          },
        ],
      },
      ok: true,
    });

    if (instrumentRunning.status !== 'RUNNING') {
      throw new Error('MIDI TO AUDIO Stage must be running');
    }

    const instrumentResult = {
      ...createCompletedResult(
        createScope(stageInstrumentId),
        instrumentRunning.activeStage.fingerprint,
        'result-instrument',
        [instrumentArtifactId],
        [instrumentClipTakeId],
      ),
      finishedAt: '2026-07-31T00:02:00.000Z',
    };
    const completed = requireCoordinator(
      completeAutoPatchRuntimeStage(instrumentRunning, {
        attemptId: 'attempt-instrument',
        result: instrumentResult,
        runtimeTarget: createRuntimeTarget({
          artifactIds: [editedArtifactId, instrumentArtifactId],
          artifactIdentities: [
            {
              artifactId: editedArtifactId,
              mediaType: 'midi',
              midi: {
                contentHash: 'edited-hash',
                revision: 2,
              },
            },
          ],
          clipTakeIds: [
            editedClipTakeId,
            instrumentClipTakeId,
          ],
        }),
      }),
    );

    expect(completed).toMatchObject({
      activeAttempt: null,
      activeStage: null,
      attempts: [
        { state: 'COMPLETED' },
        {
          attemptId: 'attempt-instrument',
          resultId: 'result-instrument',
          state: 'COMPLETED',
        },
      ],
      stageResults: [
        { resultId: 'result-instrument' },
        { resultId: 'result-midi-edit' },
      ],
      status: 'COMPLETED',
    });
    expect(Object.isFrozen(completed)).toBe(true);
    expect(Object.isFrozen(completed.attempts)).toBe(true);
  });

  it('rejects mismatched completion without changing the running coordinator', () => {
    const ready = requireCoordinator(
      createAutoPatchRuntimeCoordinator({
        createdAt,
        runId,
        runtimeTargets: [createRuntimeTarget()],
        stageResults: [],
        validatedPreflight: createValidatedPreflight(),
      }),
    );
    const running = requireCoordinator(
      beginAutoPatchRuntimeStage(ready, {
        attemptId: 'attempt-midi-edit',
        startedAt: '2026-07-31T00:00:10.000Z',
      }),
    );

    if (running.status !== 'RUNNING') {
      throw new Error('MIDI Edit Stage must be running');
    }

    const originalAttempts = running.attempts;
    const originalRuntimeTargets = running.runtimeTargets;
    const originalStageResults = running.stageResults;
    const rejected = completeAutoPatchRuntimeStage(running, {
      attemptId: 'attempt-midi-edit',
      result: createCompletedResult(
        createScope(stageMidiEditId),
        'wrong-fingerprint',
        'result-midi-edit',
        [editedArtifactId],
        [editedClipTakeId],
      ),
      runtimeTarget: createRuntimeTarget({
        artifactIds: [editedArtifactId],
        clipTakeIds: [editedClipTakeId],
      }),
    });

    expect(rejected).toEqual({
      cause: 'completed-stage-result-mismatch',
      message:
        'Completed Stage result, output availability, scope, or fingerprint does not match the running attempt.',
      ok: false,
      reason: 'result-invalid',
    });
    expect(running.status).toBe('RUNNING');
    expect(running.attempts).toBe(originalAttempts);
    expect(running.runtimeTargets).toBe(originalRuntimeTargets);
    expect(running.stageResults).toBe(originalStageResults);
  });

  it('records failure while preserving completed results and runtime assets', () => {
    const ready = requireCoordinator(
      createAutoPatchRuntimeCoordinator({
        createdAt,
        runId,
        runtimeTargets: [createRuntimeTarget()],
        stageResults: [],
        validatedPreflight: createValidatedPreflight(),
      }),
    );
    const running = requireCoordinator(
      beginAutoPatchRuntimeStage(ready, {
        attemptId: 'attempt-midi-edit',
        startedAt: '2026-07-31T00:00:10.000Z',
      }),
    );
    const failed = requireCoordinator(
      failAutoPatchRuntimeStage(running, {
        attemptId: 'attempt-midi-edit',
        cause: 'adapter-failed',
        failedAt: '2026-07-31T00:00:20.000Z',
        message: 'The Stage adapter failed.',
      }),
    );

    expect(failed).toMatchObject({
      activeAttempt: null,
      activeStage: null,
      attempts: [
        {
          attemptId: 'attempt-midi-edit',
          cause: 'adapter-failed',
          state: 'FAILED',
        },
      ],
      failure: {
        attemptId: 'attempt-midi-edit',
        cause: 'adapter-failed',
      },
      status: 'FAILED',
    });
    expect(failed.runtimeTargets).toEqual(ready.runtimeTargets);
    expect(failed.stageResults).toEqual(ready.stageResults);
  });
});

function requireCoordinator(
  resolution: AutoPatchRuntimeCoordinatorResolution,
): AutoPatchRuntimeCoordinator {
  if (!resolution.ok) {
    throw new Error(resolution.message);
  }

  return resolution.coordinator;
}
