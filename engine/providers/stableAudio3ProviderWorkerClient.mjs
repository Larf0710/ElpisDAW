import { fileURLToPath } from 'node:url';

import { ProviderWorkerClient } from './providerWorkerClient.mjs';
import { STABLE_AUDIO_3_WORKER_REQUEST_TIMEOUT_MS } from './stableAudio3RuntimeProfile.mjs';

export const STABLE_AUDIO_3_PROVIDER_WORKER_PATH = fileURLToPath(
  new URL('./stableAudio3ProviderWorker.mjs', import.meta.url),
);

export function createStableAudio3ProviderWorkerClient({
  logger,
  requestTimeoutMs = STABLE_AUDIO_3_WORKER_REQUEST_TIMEOUT_MS,
} = {}) {
  return new ProviderWorkerClient({
    ...(logger ? { logger } : {}),
    requestTimeoutMs,
    subsystem: 'SA3',
    workerPath: STABLE_AUDIO_3_PROVIDER_WORKER_PATH,
  });
}
