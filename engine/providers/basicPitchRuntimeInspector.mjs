import {
  BASIC_PITCH_MODEL_ID,
  BASIC_PITCH_MODEL_REVISION,
} from './basicPitchProviderDefinition.mjs';
import { createBasicPitchProviderWorkerClient } from './basicPitchProviderWorkerClient.mjs';
import {
  BASIC_PITCH_PROVIDER_VERSION,
  BASIC_PITCH_RUNTIME_PROFILE_ID,
} from './basicPitchRuntimeProfile.mjs';

export class BasicPitchRuntimeInspector {
  #createWorkerClient;
  #inspectionPromise;
  #workerClient;

  constructor({ createWorkerClient = createBasicPitchProviderWorkerClient } = {}) {
    if (typeof createWorkerClient !== 'function') {
      throw new TypeError('Basic Pitch Runtime Inspector worker factory must be a function.');
    }

    this.#createWorkerClient = createWorkerClient;
  }

  inspect() {
    if (!this.#inspectionPromise) {
      this.#inspectionPromise = this.#inspectOnce();
    }

    return this.#inspectionPromise;
  }

  async shutdown() {
    const workerClient = this.#workerClient;

    if (workerClient) {
      await workerClient.terminate();
    }
  }

  async #inspectOnce() {
    const workerClient = this.#createWorkerClient();

    if (!isWorkerClient(workerClient)) {
      throw new TypeError('Basic Pitch Runtime Inspector received an invalid worker client.');
    }

    this.#workerClient = workerClient;

    try {
      await workerClient.start();
      await workerClient.loadModel(BASIC_PITCH_MODEL_ID, BASIC_PITCH_MODEL_REVISION);
      await workerClient.unloadModel();
      await workerClient.close();
      this.#workerClient = undefined;

      return Object.freeze({
        modelId: BASIC_PITCH_MODEL_ID,
        modelRevision: BASIC_PITCH_MODEL_REVISION,
        profileId: BASIC_PITCH_RUNTIME_PROFILE_ID,
        providerVersion: BASIC_PITCH_PROVIDER_VERSION,
        status: 'READY',
      });
    } catch (error) {
      try {
        await workerClient.terminate();
      } catch {
        // The inspection result remains unavailable even if cleanup also fails.
      }

      this.#workerClient = undefined;
      return Object.freeze({
        code: readErrorCode(error),
        message: 'Basic Pitch Runtime is unavailable. Install or repair the pinned Runtime, then restart Local Engine.',
        status: 'UNAVAILABLE',
      });
    }
  }
}

function isWorkerClient(value) {
  return (
    value &&
    typeof value.start === 'function' &&
    typeof value.loadModel === 'function' &&
    typeof value.unloadModel === 'function' &&
    typeof value.close === 'function' &&
    typeof value.terminate === 'function'
  );
}

function readErrorCode(error) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'BASIC_PITCH_RUNTIME_UNAVAILABLE';
}
