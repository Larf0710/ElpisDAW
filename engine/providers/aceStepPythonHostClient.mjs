import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDER_WORKER_PROTOCOL_VERSION } from './providerContract.mjs';
import {
  ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
  ACE_STEP_CFG_INTERVAL_END,
  ACE_STEP_CFG_INTERVAL_START,
  ACE_STEP_DCW_ENABLED,
  ACE_STEP_GENERATION_INSTRUCTION,
  ACE_STEP_GUIDANCE_SCALE,
  ACE_STEP_INFERENCE_STEPS,
  ACE_STEP_PROVIDER_CODE_REVISION,
  ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE,
  ACE_STEP_PYTORCH_VERSION,
  ACE_STEP_SUPPORT_MODEL_REVISION,
  ACE_STEP_SHIFT,
  ACE_STEP_TORCHAUDIO_VERSION,
  ACE_STEP_WORKER_REQUEST_TIMEOUT_MS,
  ACE_STEP_USE_ADG,
} from './aceStepRuntimeProfile.mjs';
import {
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PROVIDER_PACKAGE_VERSION,
  ACE_STEP_RUNTIME_PROFILE_ID,
} from '../../shared/aceStepProtocol.js';
import { parseProviderProgress } from './providerProgress.mjs';

const DEFAULT_HOST_SCRIPT_PATH = fileURLToPath(
  new URL('./aceStepWorkerHost.py', import.meta.url),
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

export class AceStepPythonHostError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'AceStepPythonHostError';
  }
}

export class AceStepPythonHostClient {
  #checkpointsRootPath;
  #child;
  #environment;
  #hostScriptPath;
  #nextRequestNumber = 1;
  #pendingRequest;
  #pythonPath;
  #requestTimeoutMs;
  #stderrTail = '';
  #stdoutBuffer = '';

  constructor({
    environment = process.env,
    checkpointsRootPath = environment[ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE],
    hostScriptPath = DEFAULT_HOST_SCRIPT_PATH,
    pythonPath = environment[ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE],
    requestTimeoutMs = ACE_STEP_WORKER_REQUEST_TIMEOUT_MS,
  } = {}) {
    if (!isRecord(environment)) {
      throw new TypeError('ACE-Step host environment must be an object.');
    }
    if (pythonPath !== undefined && (typeof pythonPath !== 'string' || !isAbsolute(pythonPath))) {
      throw new TypeError('ACE-Step Python path must be absolute when configured.');
    }
    if (
      checkpointsRootPath !== undefined &&
      (typeof checkpointsRootPath !== 'string' || !isAbsolute(checkpointsRootPath))
    ) {
      throw new TypeError('ACE-Step Checkpoints Root path must be absolute when configured.');
    }
    if (typeof hostScriptPath !== 'string' || !isAbsolute(hostScriptPath)) {
      throw new TypeError('ACE-Step Python host script path must be absolute.');
    }
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError('ACE-Step Python host timeout must be greater than zero.');
    }

    this.#checkpointsRootPath = checkpointsRootPath;
    this.#environment = environment;
    this.#hostScriptPath = hostScriptPath;
    this.#pythonPath = pythonPath;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  isRunning() {
    return Boolean(this.#child && this.#child.exitCode === null);
  }

  async start() {
    if (this.#child) return this.#inspectReadyHost();

    const pythonPath = await validateConfiguredRegularFile(
      this.#pythonPath,
      ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE,
      'ACE-Step Python executable is unavailable.',
    );
    const hostScriptPath = await validateRegularFile(
      this.#hostScriptPath,
      'ACE-Step Python host script is unavailable.',
    );
    const checkpointsRootPath = await validateConfiguredRegularDirectory(
      this.#checkpointsRootPath,
      ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
      'ACE-Step fixed-revision Checkpoints Root is unavailable.',
    );
    const child = spawn(
      pythonPath,
      ['-I', '-B', '-u', hostScriptPath, '--checkpoints-root', checkpointsRootPath],
      {
        env: createOfflineEnvironment(this.#environment, checkpointsRootPath),
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
    if (!child) return Object.freeze({ status: 'SHUTDOWN' });

    try {
      const result = await this.#request('shutdown');
      if (!isRecord(result) || result.status !== 'SHUTDOWN') {
        throw hostResponseError('ACE-Step Python host shutdown result is invalid.');
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
    if (!child) return;

    this.#rejectPending(
      new AceStepPythonHostError('ACE_STEP_HOST_TERMINATED', 'ACE-Step Python host was terminated.'),
    );
    if (!hasExited(child)) {
      child.kill();
      await waitForExit(child, Math.min(this.#requestTimeoutMs, 5_000));
    }
    if (this.#child === child) this.#child = undefined;
  }

  async #inspectReadyHost() {
    const result = await this.#request('inspect');
    if (
      !isRecord(result) ||
      result.status !== 'READY' ||
      result.profileId !== ACE_STEP_RUNTIME_PROFILE_ID ||
      result.providerVersion !== ACE_STEP_PROVIDER_PACKAGE_VERSION ||
      result.providerCodeRevision !== ACE_STEP_PROVIDER_CODE_REVISION ||
      result.modelId !== ACE_STEP_MODEL_ID ||
      result.modelRevision !== ACE_STEP_MODEL_REVISION ||
      result.supportModelRevision !== ACE_STEP_SUPPORT_MODEL_REVISION ||
      result.cfgIntervalEnd !== ACE_STEP_CFG_INTERVAL_END ||
      result.cfgIntervalStart !== ACE_STEP_CFG_INTERVAL_START ||
      result.dcwEnabled !== ACE_STEP_DCW_ENABLED ||
      result.inferenceSteps !== ACE_STEP_INFERENCE_STEPS ||
      result.guidanceScale !== ACE_STEP_GUIDANCE_SCALE ||
      result.instruction !== ACE_STEP_GENERATION_INSTRUCTION ||
      result.shift !== ACE_STEP_SHIFT ||
      result.useAdg !== ACE_STEP_USE_ADG ||
      result.pytorchVersion !== ACE_STEP_PYTORCH_VERSION ||
      result.torchaudioVersion !== ACE_STEP_TORCHAUDIO_VERSION ||
      result.offline !== true
    ) {
      throw hostResponseError('ACE-Step Python host profile is invalid.');
    }

    return Object.freeze({
      cfgIntervalEnd: result.cfgIntervalEnd,
      cfgIntervalStart: result.cfgIntervalStart,
      dcwEnabled: result.dcwEnabled,
      guidanceScale: result.guidanceScale,
      inferenceSteps: result.inferenceSteps,
      instruction: result.instruction,
      modelId: result.modelId,
      modelRevision: result.modelRevision,
      offline: true,
      profileId: result.profileId,
      providerCodeRevision: result.providerCodeRevision,
      providerVersion: result.providerVersion,
      pytorchVersion: result.pytorchVersion,
      status: 'READY',
      supportModelRevision: result.supportModelRevision,
      shift: result.shift,
      torchaudioVersion: result.torchaudioVersion,
      useAdg: result.useAdg,
    });
  }

  #request(operation, payload, { onProgress } = {}) {
    const child = this.#child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      return Promise.reject(
        new AceStepPythonHostError('ACE_STEP_HOST_OFFLINE', 'ACE-Step Python host is not running.'),
      );
    }
    if (this.#pendingRequest) {
      return Promise.reject(
        new AceStepPythonHostError(
          'ACE_STEP_HOST_BUSY',
          'ACE-Step Python host accepts one operation at a time.',
        ),
      );
    }

    const requestId = `ace-step-host-${this.#nextRequestNumber}`;
    this.#nextRequestNumber += 1;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.#pendingRequest?.requestId !== requestId) return;
        this.#pendingRequest = undefined;
        reject(
          new AceStepPythonHostError(
            'ACE_STEP_HOST_TIMEOUT',
            `ACE-Step Python host ${operation} timed out after ${this.#requestTimeoutMs} ms.`,
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
        if (!error || this.#pendingRequest?.requestId !== requestId) return;
        clearTimeout(timeoutId);
        this.#pendingRequest = undefined;
        reject(
          new AceStepPythonHostError(
            'ACE_STEP_HOST_SEND_FAILED',
            'Could not send a request to the ACE-Step Python host.',
            { cause: error },
          ),
        );
      });
    });
  }

  #handleStdout(child, chunk) {
    if (child !== this.#child) return;
    this.#stdoutBuffer += chunk;
    if (Buffer.byteLength(this.#stdoutBuffer, 'utf8') > MAX_STDOUT_BUFFER_BYTES) {
      this.#handleProtocolFailure('ACE-Step Python host response is too large.');
      return;
    }

    let newlineIndex = this.#stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.#stdoutBuffer.slice(0, newlineIndex).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0 && !this.#handleResponseLine(line)) return;
      newlineIndex = this.#stdoutBuffer.indexOf('\n');
    }
  }

  #handleStderr(child, chunk) {
    if (child !== this.#child) return;
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
      this.#handleProtocolFailure('ACE-Step Python host emitted non-JSON output.');
      return false;
    }

    const pending = this.#pendingRequest;
    if (
      !pending ||
      !isRecord(message) ||
      message.protocolVersion !== PROVIDER_WORKER_PROTOCOL_VERSION ||
      message.requestId !== pending.requestId
    ) {
      this.#handleProtocolFailure('ACE-Step Python host response identity is invalid.');
      return false;
    }

    if (message.event === 'progress') {
      const progress = parseProviderProgress(message.progress);

      if (!progress) {
        this.#handleProtocolFailure('ACE-Step Python host progress is malformed.');
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
      pending.reject(new AceStepPythonHostError(message.error.code, message.error.message));
      return true;
    }
    pending.reject(hostResponseError('ACE-Step Python host response is malformed.'));
    return true;
  }

  #handleProtocolFailure(message) {
    this.#rejectPending(hostResponseError(message));
    void this.terminate();
  }

  #handleFailure(child, error) {
    if (child === this.#child) {
      this.#rejectPending(
        new AceStepPythonHostError(
          'ACE_STEP_HOST_FAILED',
          'ACE-Step Python host process failed.',
          { cause: error },
        ),
      );
    }
  }

  #handleExit(child, code, signal) {
    if (child !== this.#child) return;
    this.#rejectPending(
      new AceStepPythonHostError(
        'ACE_STEP_HOST_EXITED',
        `ACE-Step Python host exited${code === null ? '' : ` with code ${code}`}${
          signal ? ` from ${signal}` : ''
        }.`,
      ),
    );
    this.#child = undefined;
  }

  #rejectPending(error) {
    if (!this.#pendingRequest) return;
    clearTimeout(this.#pendingRequest.timeoutId);
    this.#pendingRequest.reject(error);
    this.#pendingRequest = undefined;
  }
}

export function resolveAceStepPythonPath(environment = process.env) {
  return requireConfiguredAbsolutePath(environment, ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE);
}

export function resolveAceStepCheckpointsRootPath(environment = process.env) {
  return requireConfiguredAbsolutePath(
    environment,
    ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
  );
}

function requireConfiguredAbsolutePath(environment, key) {
  const value = environment[key];
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError(`${key} must contain an absolute path.`);
  }
  return value;
}

function createOfflineEnvironment(environment, checkpointsRootPath) {
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => typeof value === 'string'),
  );
  for (const key of REDACTED_ENVIRONMENT_KEYS) delete childEnvironment[key];
  childEnvironment.ACESTEP_CHECKPOINTS_DIR = checkpointsRootPath;
  childEnvironment.HF_DATASETS_OFFLINE = '1';
  childEnvironment.HF_HUB_DISABLE_PROGRESS_BARS = '1';
  childEnvironment.HF_HUB_DISABLE_TELEMETRY = '1';
  childEnvironment.HF_HUB_OFFLINE = '1';
  childEnvironment.NO_ALBUMENTATIONS_UPDATE = '1';
  childEnvironment.TOKENIZERS_PARALLELISM = 'false';
  childEnvironment.TRANSFORMERS_OFFLINE = '1';
  return childEnvironment;
}

async function validateConfiguredRegularFile(path, key, message) {
  if (typeof path !== 'string') {
    throw new AceStepPythonHostError(
      'ACE_STEP_RUNTIME_UNAVAILABLE',
      `${key} must be configured before ACE-Step execution.`,
    );
  }
  return validateRegularFile(path, message);
}

async function validateConfiguredRegularDirectory(path, key, message) {
  if (typeof path !== 'string') {
    throw new AceStepPythonHostError(
      'ACE_STEP_RUNTIME_UNAVAILABLE',
      `${key} must be configured before ACE-Step execution.`,
    );
  }
  try {
    const directoryStat = await lstat(path);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(message);
    return await realpath(path);
  } catch (error) {
    throw new AceStepPythonHostError('ACE_STEP_RUNTIME_UNAVAILABLE', message, { cause: error });
  }
}

async function validateRegularFile(path, message) {
  try {
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(message);
    return await realpath(path);
  } catch (error) {
    throw new AceStepPythonHostError('ACE_STEP_RUNTIME_UNAVAILABLE', message, { cause: error });
  }
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      child.off('exit', handleExit);
      reject(
        new AceStepPythonHostError(
          'ACE_STEP_HOST_EXIT_TIMEOUT',
          'ACE-Step Python host did not exit.',
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

function hostResponseError(message) {
  return new AceStepPythonHostError('ACE_STEP_HOST_RESPONSE_INVALID', message);
}

function isSafeHostErrorCode(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_HOST_ERROR_CODE_LENGTH && /^[A-Z0-9_]+$/.test(value);
}

function isSafeHostErrorMessage(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_HOST_ERROR_MESSAGE_LENGTH;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
