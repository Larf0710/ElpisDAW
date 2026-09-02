import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDER_WORKER_PROTOCOL_VERSION } from './providerContract.mjs';
import {
  STABLE_AUDIO_3_CFG_SCALE,
  STABLE_AUDIO_3_CHUNKED_DECODE,
  STABLE_AUDIO_3_FLASH_ATTENTION_VERSION,
  STABLE_AUDIO_3_INFERENCE_STEPS,
  STABLE_AUDIO_3_MODEL_ROOT_ENVIRONMENT_VARIABLE,
  STABLE_AUDIO_3_PROVIDER_CODE_REVISION,
  STABLE_AUDIO_3_PYTHON_ENVIRONMENT_VARIABLE,
  STABLE_AUDIO_3_PYTORCH_VERSION,
  STABLE_AUDIO_3_TORCHAUDIO_VERSION,
  STABLE_AUDIO_3_WORKER_REQUEST_TIMEOUT_MS,
} from './stableAudio3RuntimeProfile.mjs';
import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
} from '../../shared/stableAudio3Protocol.js';
import { parseProviderProgress } from './providerProgress.mjs';

const DEFAULT_HOST_SCRIPT_PATH = fileURLToPath(
  new URL('./stableAudio3WorkerHost.py', import.meta.url),
);
const MAX_STDOUT_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 16 * 1024;
const MAX_HOST_ERROR_CODE_LENGTH = 128;
const MAX_HOST_ERROR_MESSAGE_LENGTH = 512;
const REDACTED_ENVIRONMENT_KEYS = Object.freeze([
  'HF_TOKEN',
  'HF_HUB_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  'HUGGINGFACE_TOKEN',
  'HUGGINGFACEHUB_API_TOKEN',
]);

export class StableAudio3PythonHostError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'StableAudio3PythonHostError';
  }
}

export class StableAudio3PythonHostClient {
  #child;
  #environment;
  #hostScriptPath;
  #modelRootPath;
  #nextRequestNumber = 1;
  #pendingRequest;
  #pythonPath;
  #requestTimeoutMs;
  #stderrTail = '';
  #stdoutBuffer = '';

  constructor({
    environment = process.env,
    hostScriptPath = DEFAULT_HOST_SCRIPT_PATH,
    modelRootPath = environment[STABLE_AUDIO_3_MODEL_ROOT_ENVIRONMENT_VARIABLE],
    pythonPath = environment[STABLE_AUDIO_3_PYTHON_ENVIRONMENT_VARIABLE],
    requestTimeoutMs = STABLE_AUDIO_3_WORKER_REQUEST_TIMEOUT_MS,
  } = {}) {
    if (!isRecord(environment)) {
      throw new TypeError('Stable Audio 3 host environment must be an object.');
    }

    if (pythonPath !== undefined && (typeof pythonPath !== 'string' || !isAbsolute(pythonPath))) {
      throw new TypeError('Stable Audio 3 Python path must be absolute when configured.');
    }

    if (
      modelRootPath !== undefined &&
      (typeof modelRootPath !== 'string' || !isAbsolute(modelRootPath))
    ) {
      throw new TypeError('Stable Audio 3 Model Root path must be absolute when configured.');
    }

    if (typeof hostScriptPath !== 'string' || !isAbsolute(hostScriptPath)) {
      throw new TypeError('Stable Audio 3 Python host script path must be absolute.');
    }

    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError('Stable Audio 3 Python host timeout must be greater than zero.');
    }

    this.#environment = environment;
    this.#hostScriptPath = hostScriptPath;
    this.#modelRootPath = modelRootPath;
    this.#pythonPath = pythonPath;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  isRunning() {
    return Boolean(this.#child && this.#child.exitCode === null);
  }

  async start() {
    if (this.#child) {
      return this.#inspectReadyHost();
    }

    const pythonPath = await validateConfiguredRegularFile(
      this.#pythonPath,
      STABLE_AUDIO_3_PYTHON_ENVIRONMENT_VARIABLE,
      'Stable Audio 3 Python executable is unavailable.',
    );
    const hostScriptPath = await validateRegularFile(
      this.#hostScriptPath,
      'Stable Audio 3 Python host script is unavailable.',
    );
    const modelRootPath = await validateConfiguredRegularDirectory(
      this.#modelRootPath,
      STABLE_AUDIO_3_MODEL_ROOT_ENVIRONMENT_VARIABLE,
      'Stable Audio 3 fixed-revision Model Root is unavailable.',
    );
    const child = spawn(
      pythonPath,
      ['-I', '-B', '-u', hostScriptPath, '--model-root', modelRootPath],
      {
        env: createOfflineEnvironment(this.#environment),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    this.#child = child;
    this.#stderrTail = '';
    this.#stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#handleStdout(child, chunk));
    child.stderr.on('data', (chunk) => this.#handleStderr(child, chunk));
    child.once('error', (error) => this.#handleFailure(child, error));
    child.once('exit', (code, signal) => this.#handleExit(child, code, signal));

    try {
      return await this.#inspectReadyHost();
    } catch (error) {
      await this.terminate();
      throw error;
    }
  }

  loadModel(modelId, revision) {
    return this.#request('load-model', { modelId, revision });
  }

  execute(job, { onProgress } = {}) {
    return this.#request('execute', job, { onProgress });
  }

  unloadModel() {
    return this.#request('unload-model');
  }

  async shutdown() {
    const child = this.#child;

    if (!child) {
      return Object.freeze({ status: 'SHUTDOWN' });
    }

    try {
      const result = await this.#request('shutdown');

      if (!isRecord(result) || result.status !== 'SHUTDOWN') {
        throw createHostResponseError('Stable Audio 3 Python host shutdown result is invalid.');
      }

      await waitForExit(child, this.#requestTimeoutMs);
      return Object.freeze({ status: 'SHUTDOWN' });
    } catch (error) {
      await this.terminate();
      throw error;
    }
  }

  async terminate() {
    const child = this.#child;

    if (!child) {
      return;
    }

    this.#rejectPending(
      new StableAudio3PythonHostError(
        'STABLE_AUDIO_3_HOST_TERMINATED',
        'Stable Audio 3 Python host was terminated.',
      ),
    );

    if (!hasExited(child)) {
      child.kill();
      await waitForExit(child, Math.min(this.#requestTimeoutMs, 5_000));
    }

    if (this.#child === child) {
      this.#child = undefined;
    }
  }

  async #inspectReadyHost() {
    const result = await this.#request('inspect');

    if (
      !isRecord(result) ||
      result.status !== 'READY' ||
      result.profileId !== STABLE_AUDIO_3_RUNTIME_PROFILE_ID ||
      result.providerVersion !== STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION ||
      result.providerCodeRevision !== STABLE_AUDIO_3_PROVIDER_CODE_REVISION ||
      result.modelId !== STABLE_AUDIO_3_MODEL_ID ||
      result.modelRevision !== STABLE_AUDIO_3_MODEL_REVISION ||
      result.inferenceSteps !== STABLE_AUDIO_3_INFERENCE_STEPS ||
      result.cfgScale !== STABLE_AUDIO_3_CFG_SCALE ||
      result.chunkedDecode !== STABLE_AUDIO_3_CHUNKED_DECODE ||
      result.pytorchVersion !== STABLE_AUDIO_3_PYTORCH_VERSION ||
      result.torchaudioVersion !== STABLE_AUDIO_3_TORCHAUDIO_VERSION ||
      result.flashAttentionVersion !== STABLE_AUDIO_3_FLASH_ATTENTION_VERSION ||
      result.offline !== true
    ) {
      throw createHostResponseError('Stable Audio 3 Python host profile is invalid.');
    }

    return Object.freeze({
      cfgScale: result.cfgScale,
      chunkedDecode: result.chunkedDecode,
      flashAttentionVersion: result.flashAttentionVersion,
      inferenceSteps: result.inferenceSteps,
      modelId: result.modelId,
      modelRevision: result.modelRevision,
      offline: true,
      profileId: result.profileId,
      providerCodeRevision: result.providerCodeRevision,
      providerVersion: result.providerVersion,
      pytorchVersion: result.pytorchVersion,
      status: 'READY',
      torchaudioVersion: result.torchaudioVersion,
    });
  }

  #request(operation, payload, { onProgress } = {}) {
    const child = this.#child;

    if (!child || child.exitCode !== null || !child.stdin.writable) {
      return Promise.reject(
        new StableAudio3PythonHostError(
          'STABLE_AUDIO_3_HOST_OFFLINE',
          'Stable Audio 3 Python host is not running.',
        ),
      );
    }

    if (this.#pendingRequest) {
      return Promise.reject(
        new StableAudio3PythonHostError(
          'STABLE_AUDIO_3_HOST_BUSY',
          'Stable Audio 3 Python host accepts one operation at a time.',
        ),
      );
    }

    const requestId = `stable-audio-3-host-${this.#nextRequestNumber}`;
    this.#nextRequestNumber += 1;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.#pendingRequest?.requestId !== requestId) {
          return;
        }

        this.#pendingRequest = undefined;
        reject(
          new StableAudio3PythonHostError(
            'STABLE_AUDIO_3_HOST_TIMEOUT',
            `Stable Audio 3 Python host ${operation} timed out after ${this.#requestTimeoutMs} ms.`,
          ),
        );
        void this.terminate();
      }, this.#requestTimeoutMs);

      this.#pendingRequest = {
        onProgress: typeof onProgress === 'function' ? onProgress : undefined,
        reject,
        requestId,
        resolve,
        timeoutId,
      };
      const message = `${JSON.stringify({
        operation,
        ...(payload === undefined ? {} : { payload }),
        protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
        requestId,
      })}\n`;

      child.stdin.write(message, 'utf8', (error) => {
        if (!error || this.#pendingRequest?.requestId !== requestId) {
          return;
        }

        clearTimeout(timeoutId);
        this.#pendingRequest = undefined;
        reject(
          new StableAudio3PythonHostError(
            'STABLE_AUDIO_3_HOST_SEND_FAILED',
            'Could not send a request to the Stable Audio 3 Python host.',
            { cause: error },
          ),
        );
      });
    });
  }

  #handleStdout(child, chunk) {
    if (child !== this.#child) {
      return;
    }

    this.#stdoutBuffer += chunk;

    if (Buffer.byteLength(this.#stdoutBuffer, 'utf8') > MAX_STDOUT_BUFFER_BYTES) {
      this.#handleProtocolFailure('Stable Audio 3 Python host response is too large.');
      return;
    }

    let newlineIndex = this.#stdoutBuffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = this.#stdoutBuffer.slice(0, newlineIndex).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);

      if (line.length > 0 && !this.#handleResponseLine(line)) {
        return;
      }

      newlineIndex = this.#stdoutBuffer.indexOf('\n');
    }
  }

  #handleStderr(child, chunk) {
    if (child !== this.#child) {
      return;
    }

    this.#stderrTail = `${this.#stderrTail}${chunk}`;

    while (Buffer.byteLength(this.#stderrTail, 'utf8') > MAX_STDERR_TAIL_BYTES) {
      this.#stderrTail = this.#stderrTail.slice(Math.ceil(this.#stderrTail.length / 4));
    }
  }

  #handleResponseLine(line) {
    let message;

    try {
      message = JSON.parse(line);
    } catch {
      this.#handleProtocolFailure('Stable Audio 3 Python host emitted non-JSON output.');
      return false;
    }

    const pending = this.#pendingRequest;

    if (
      !pending ||
      !isRecord(message) ||
      message.protocolVersion !== PROVIDER_WORKER_PROTOCOL_VERSION ||
      message.requestId !== pending.requestId
    ) {
      this.#handleProtocolFailure('Stable Audio 3 Python host response identity is invalid.');
      return false;
    }

    if (message.event === 'progress') {
      const progress = parseProviderProgress(message.progress);

      if (!progress) {
        this.#handleProtocolFailure('Stable Audio 3 Python host progress is malformed.');
        return false;
      }

      try {
        pending.onProgress?.(progress);
      } catch {
        // Progress observation is telemetry and must not fail model execution.
      }
      return true;
    }

    clearTimeout(pending.timeoutId);
    this.#pendingRequest = undefined;

    if (message.ok === true) {
      pending.resolve(message.result);
      return true;
    }

    if (
      message.ok === false &&
      isRecord(message.error) &&
      isSafeHostErrorCode(message.error.code) &&
      isSafeHostErrorMessage(message.error.message)
    ) {
      pending.reject(
        new StableAudio3PythonHostError(message.error.code, message.error.message),
      );
      return true;
    }

    pending.reject(createHostResponseError('Stable Audio 3 Python host response is malformed.'));
    return true;
  }

  #handleProtocolFailure(message) {
    this.#rejectPending(createHostResponseError(message));
    void this.terminate();
  }

  #handleFailure(child, error) {
    if (child === this.#child) {
      this.#rejectPending(
        new StableAudio3PythonHostError(
          'STABLE_AUDIO_3_HOST_FAILED',
          'Stable Audio 3 Python host process failed.',
          { cause: error },
        ),
      );
    }
  }

  #handleExit(child, code, signal) {
    if (child !== this.#child) {
      return;
    }

    this.#rejectPending(
      new StableAudio3PythonHostError(
        'STABLE_AUDIO_3_HOST_EXITED',
        `Stable Audio 3 Python host exited${code === null ? '' : ` with code ${code}`}${
          signal ? ` from ${signal}` : ''
        }.`,
      ),
    );
    this.#child = undefined;
  }

  #rejectPending(error) {
    if (!this.#pendingRequest) {
      return;
    }

    clearTimeout(this.#pendingRequest.timeoutId);
    this.#pendingRequest.reject(error);
    this.#pendingRequest = undefined;
  }
}

export function resolveStableAudio3PythonPath(environment = process.env) {
  return requireConfiguredAbsolutePath(
    environment,
    STABLE_AUDIO_3_PYTHON_ENVIRONMENT_VARIABLE,
  );
}

export function resolveStableAudio3ModelRootPath(environment = process.env) {
  return requireConfiguredAbsolutePath(
    environment,
    STABLE_AUDIO_3_MODEL_ROOT_ENVIRONMENT_VARIABLE,
  );
}

function requireConfiguredAbsolutePath(environment, key) {
  const value = environment[key];

  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError(`${key} must contain an absolute path.`);
  }

  return value;
}

function createOfflineEnvironment(environment) {
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => typeof value === 'string'),
  );

  for (const key of REDACTED_ENVIRONMENT_KEYS) {
    delete childEnvironment[key];
  }

  childEnvironment.HF_HUB_DISABLE_PROGRESS_BARS = '1';
  childEnvironment.HF_HUB_DISABLE_TELEMETRY = '1';
  childEnvironment.HF_HUB_OFFLINE = '1';
  childEnvironment.TOKENIZERS_PARALLELISM = 'false';
  childEnvironment.TRANSFORMERS_OFFLINE = '1';
  return childEnvironment;
}

async function validateConfiguredRegularFile(path, key, message) {
  if (typeof path !== 'string') {
    throw new StableAudio3PythonHostError(
      'STABLE_AUDIO_3_RUNTIME_UNAVAILABLE',
      `${key} must be configured before Stable Audio 3 execution.`,
    );
  }

  return validateRegularFile(path, message);
}

async function validateConfiguredRegularDirectory(path, key, message) {
  if (typeof path !== 'string') {
    throw new StableAudio3PythonHostError(
      'STABLE_AUDIO_3_RUNTIME_UNAVAILABLE',
      `${key} must be configured before Stable Audio 3 execution.`,
    );
  }

  try {
    const directoryStat = await lstat(path);

    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(message);
    }

    return await realpath(path);
  } catch (error) {
    throw new StableAudio3PythonHostError('STABLE_AUDIO_3_RUNTIME_UNAVAILABLE', message, {
      cause: error,
    });
  }
}

async function validateRegularFile(path, message) {
  try {
    const fileStat = await lstat(path);

    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(message);
    }

    return await realpath(path);
  } catch (error) {
    throw new StableAudio3PythonHostError('STABLE_AUDIO_3_RUNTIME_UNAVAILABLE', message, {
      cause: error,
    });
  }
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      child.off('exit', handleExit);
      reject(
        new StableAudio3PythonHostError(
          'STABLE_AUDIO_3_HOST_EXIT_TIMEOUT',
          'Stable Audio 3 Python host did not exit.',
        ),
      );
    }, timeoutMs);
    const handleExit = () => {
      clearTimeout(timeoutId);
      resolve();
    };

    child.once('exit', handleExit);
  });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function createHostResponseError(message) {
  return new StableAudio3PythonHostError('STABLE_AUDIO_3_HOST_RESPONSE_INVALID', message);
}

function isSafeHostErrorCode(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_HOST_ERROR_CODE_LENGTH &&
    /^[A-Z0-9_]+$/.test(value)
  );
}

function isSafeHostErrorMessage(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_HOST_ERROR_MESSAGE_LENGTH
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
