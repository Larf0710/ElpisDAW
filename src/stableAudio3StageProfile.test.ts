import { describe, expect, it, vi } from 'vitest';

import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import type { StableAudio3StageDispatch } from './stableAudio3StageAdapter';
import { orchestrateStableAudio3Stage } from './stableAudio3StageOrchestrator';
import { CURRENT_STABLE_AUDIO_3_STAGE_RUNTIME_PROFILE } from './stableAudio3StageProfile';
import type { StableAudio3StageRunnerClient } from './stableAudio3StageRunner';
import type { ProjectState } from './types';

describe('current Stable Audio 3 Stage Runtime Profile', () => {
  it('uses the promoted shared cross-process Runtime and pinned Model identities', () => {
    expect(CURRENT_STABLE_AUDIO_3_STAGE_RUNTIME_PROFILE).toEqual({
      model: {
        compatibility: 'PARTIAL_SUPPORT',
        modelId: STABLE_AUDIO_3_MODEL_ID,
        revision: STABLE_AUDIO_3_MODEL_REVISION,
      },
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      providerVersion: STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
      runtime: {
        compatibility: 'COMPATIBLE',
        profileId: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
      },
      supportsCancellation: true,
      taskId: STABLE_AUDIO_3_TASK_ID,
    });
  });

  it('freezes the Profile and its nested compatibility evidence', () => {
    expect(Object.isFrozen(CURRENT_STABLE_AUDIO_3_STAGE_RUNTIME_PROFILE)).toBe(
      true,
    );
    expect(
      Object.isFrozen(CURRENT_STABLE_AUDIO_3_STAGE_RUNTIME_PROFILE.model),
    ).toBe(true);
    expect(
      Object.isFrozen(CURRENT_STABLE_AUDIO_3_STAGE_RUNTIME_PROFILE.runtime),
    ).toBe(true);
  });

  it('passes compatibility and fails closed on an unavailable source before any Engine call', async () => {
    const engineCall = vi.fn(async () => {
      throw new Error('The Engine must not be contacted.');
    });
    const client: StableAudio3StageRunnerClient = {
      cancelJob: engineCall,
      enqueueStableAudio3Job: engineCall,
      getJobs: engineCall,
      removeQueuedJob: engineCall,
    };
    const project = Object.freeze({
      artifacts: Object.freeze([]),
      bpm: 120,
      tracks: Object.freeze([]),
    }) as unknown as ProjectState;
    const dispatch: StableAudio3StageDispatch = Object.freeze({
      attemptId: 'attempt-current-stable-audio-3-profile',
      execution: Object.freeze({
        modelId: STABLE_AUDIO_3_MODEL_ID,
        modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
        providerId: STABLE_AUDIO_3_PROVIDER_ID,
        taskId: STABLE_AUDIO_3_TASK_ID,
      }),
      fingerprint: 'fingerprint-current-stable-audio-3-profile',
      parameters: Object.freeze({
        durationSeconds: 12,
        prompt: 'Warm electric bass with a tight pocket',
        seed: 7,
        strength: 0.4,
        takes: 1,
      }),
      runId: 'run-current-stable-audio-3-profile',
      scope: Object.freeze({
        familyId: 'family-root',
        familyRevision: 1,
        stageId: 'stage-current-stable-audio-3-profile',
        targetClipId: 'clip-source',
      }),
      source: Object.freeze({
        artifactId: 'artifact-source',
        clipId: 'clip-source',
        clipTakeId: 'clip-take-source',
      }),
      startedAt: '2026-08-03T06:00:00.000Z',
    });

    const result = await orchestrateStableAudio3Stage(
      client,
      project,
      dispatch,
      CURRENT_STABLE_AUDIO_3_STAGE_RUNTIME_PROFILE,
      {
        completion: {
          label: 'Current Stable Audio 3 Take',
          resultId: 'result-current-stable-audio-3-profile',
        },
      },
    );

    expect(result).toMatchObject({
      cause: 'clip-not-found',
      ok: false,
      planning: {
        canPlan: false,
        reason: 'source-audio-unavailable',
      },
      project,
      reason: 'source-audio-unavailable',
      status: 'STAGE_BLOCKED',
    });
    expect(engineCall).not.toHaveBeenCalled();
  });
});
