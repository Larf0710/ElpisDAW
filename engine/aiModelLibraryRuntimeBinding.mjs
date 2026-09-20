import { join } from 'node:path';

import { ACE_STEP_MODEL_ID } from '../shared/aceStepProtocol.js';
import {
  ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
  ACE_STEP_MODEL_ROOT_ENVIRONMENT_VARIABLE,
} from './providers/aceStepRuntimeProfile.mjs';
import {
  STABLE_AUDIO_3_MODEL_ROOT_ENVIRONMENT_VARIABLE,
} from './providers/stableAudio3RuntimeProfile.mjs';

export function applyAiModelLibraryRuntimeBinding(storage, environment = process.env) {
  if (!isRecord(environment)) {
    throw new TypeError('AI Model Library runtime environment must be an object.');
  }

  if (storage?.aiModelLibrary?.status !== 'READY') {
    return false;
  }

  const { aceStep, stableAudio3 } = storage.aiModelLibrary.directories;
  environment[ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE] = aceStep;
  environment[ACE_STEP_MODEL_ROOT_ENVIRONMENT_VARIABLE] = join(
    aceStep,
    ACE_STEP_MODEL_ID,
  );
  environment[STABLE_AUDIO_3_MODEL_ROOT_ENVIRONMENT_VARIABLE] = stableAudio3;
  return true;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
