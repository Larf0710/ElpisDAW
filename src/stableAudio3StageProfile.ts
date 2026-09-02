import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import type { StableAudio3StageRuntimeProfile } from './stableAudio3StageAdapter';

export const CURRENT_STABLE_AUDIO_3_STAGE_RUNTIME_PROFILE:
  StableAudio3StageRuntimeProfile = Object.freeze({
    model: Object.freeze({
      compatibility: 'PARTIAL_SUPPORT',
      modelId: STABLE_AUDIO_3_MODEL_ID,
      revision: STABLE_AUDIO_3_MODEL_REVISION,
    }),
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    providerVersion: STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
    runtime: Object.freeze({
      compatibility: 'COMPATIBLE',
      profileId: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
    }),
    supportsCancellation: true,
    taskId: STABLE_AUDIO_3_TASK_ID,
  });
