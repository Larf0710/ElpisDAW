import { fileURLToPath } from 'node:url';

import {
  BASIC_PITCH_WORKER_REQUEST_TIMEOUT_MS,
} from './basicPitchRuntimeProfile.mjs';
import { ProviderWorkerClient } from './providerWorkerClient.mjs';

export const BASIC_PITCH_PROVIDER_WORKER_PATH = fileURLToPath(
  new URL('./basicPitchProviderWorker.mjs', import.meta.url),
);

export function createBasicPitchProviderWorkerClient({
  logger,
  requestTimeoutMs = BASIC_PITCH_WORKER_REQUEST_TIMEOUT_MS,
} = {}) {
  return new ProviderWorkerClient({
    ...(logger ? { logger } : {}),
    requestTimeoutMs,
    subsystem: 'BASIC_PITCH',
    workerPath: BASIC_PITCH_PROVIDER_WORKER_PATH,
  });
}
