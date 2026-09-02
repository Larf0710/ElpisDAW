import { fileURLToPath } from 'node:url';

import { ProviderWorkerClient } from './providerWorkerClient.mjs';
import { ACE_STEP_WORKER_REQUEST_TIMEOUT_MS } from './aceStepRuntimeProfile.mjs';

export const ACE_STEP_PROVIDER_WORKER_PATH = fileURLToPath(
  new URL('./aceStepProviderWorker.mjs', import.meta.url),
);

export function createAceStepProviderWorkerClient({
  logger,
  requestTimeoutMs = ACE_STEP_WORKER_REQUEST_TIMEOUT_MS,
} = {}) {
  return new ProviderWorkerClient({
    ...(logger ? { logger } : {}),
    requestTimeoutMs,
    subsystem: 'ACE',
    workerPath: ACE_STEP_PROVIDER_WORKER_PATH,
  });
}
