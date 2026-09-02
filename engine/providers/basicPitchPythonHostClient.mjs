import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDER_WORKER_PROTOCOL_VERSION } from './providerContract.mjs';
import {
  BASIC_PITCH_ONNX_RUNTIME_VERSION,
  BASIC_PITCH_PROVIDER_VERSION,
  BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE,
  BASIC_PITCH_RUNTIME_PROFILE_ID,
  BASIC_PITCH_WORKER_REQUEST_TIMEOUT_MS,
} from './basicPitchRuntimeProfile.mjs';

const DEFAULT_HOST_SCRIPT_PATH = fileURLToPath(
  new URL('./basicPitchWorkerHost.py', import.meta.url),
);
const DEFAULT_PYTHON_PATH = fileURLToPath(
  new URL('../bin/basic-pitch/0.4.0/Scripts/python.exe', import.meta.url),
);
const MAX_STDOUT_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 16 * 1024;

export class BasicPitchPythonHostError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'BasicPitchPythonHostError';
  }
}

export class BasicPitchPythonHostClient {
  #child;
  #hostScriptPath;
  #nextRequestNumber = 1;
  #pendingRequest;
  #pythonPath;
  #requestTimeoutMs;
  #stderrTail = '';
  #stdoutBuffer = '';

  constructor({
    hostScriptPath = DEFAULT_HOST_SCRIPT_PATH,
    pythonPath = resolveBasicPitchPythonPath(),
    requestTimeoutMs = BASIC_PITCH_WORKER_REQUEST_TIMEOUT_MS,
  } = {}) {
    if (typeof pythonPath !== 'string' || !isAbsolute(pythonPath)) {
      throw new TypeError('Basic Pitch Python path must be absolute.');
    }

    if (typeof hostScriptPath !== 'string' || !isAbsolute(hostScriptPath)) {
      throw new TypeError('Basic Pitch Python host script path must be absolute.');
    }

    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError('Basic Pitch Python host timeout must be greater than zero.');
    }

    this.#hostScriptPath = hostScriptPath;
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

    const pythonPath = await validateRegularFile(
      this.#pythonPath,
      'Basic Pitch Python executable is unavailable.',
    );
    const hostScriptPath = await validateRegularFile(
      this.#hostScriptPath,
      'Basic Pitch Python host script is unavailable.',
    );
    const child = spawn(pythonPath, ['-u', hostScriptPath], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

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

  execute(job) {
    return this.#request('execute', job);
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
        throw createHostResponseError('Basic Pitch Python host shutdown result is invalid.');
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
      new BasicPitchPythonHostError(
        'BASIC_PITCH_HOST_TERMINATED',
        'Basic Pitch Python host was terminated.',
      ),
    );

    if (child.exitCode === null) {
      child.kill();
      await waitForExit(child, Math.min(this.#requestTimeoutMs, 5_000)).catch(
        () => undefined,
      );
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
      result.profileId !== BASIC_PITCH_RUNTIME_PROFILE_ID ||
      result.providerVersion !== BASIC_PITCH_PROVIDER_VERSION ||
      result.runtimeVersion !== BASIC_PITCH_ONNX_RUNTIME_VERSION
    ) {
      throw createHostResponseError('Basic Pitch Python host profile is invalid.');
    }

    return Object.freeze({
      profileId: result.profileId,
      providerVersion: result.providerVersion,
      runtimeVersion: result.runtimeVersion,
      status: 'READY',
    });
  }

  #request(operation, payload) {
    const child = this.#child;

    if (!child || child.exitCode !== null || !child.stdin.writable) {
      return Promise.reject(
        new BasicPitchPythonHostError(
          'BASIC_PITCH_HOST_OFFLINE',
          'Basic Pitch Python host is not running.',
        ),
      );
    }

    if (this.#pendingRequest) {
      return Promise.reject(
        new BasicPitchPythonHostError(
          'BASIC_PITCH_HOST_BUSY',
          'Basic Pitch Python host accepts one operation at a time.',
        ),
      );
    }

    const requestId = `basic-pitch-host-${this.#nextRequestNumber}`;
    this.#nextRequestNumber += 1;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.#pendingRequest?.requestId !== requestId) {
          return;
        }

        this.#pendingRequest = undefined;
        reject(
          new BasicPitchPythonHostError(
            'BASIC_PITCH_HOST_TIMEOUT',
            `Basic Pitch Python host ${operation} timed out after ${this.#requestTimeoutMs} ms.`,
          ),
        );
        void this.terminate();
      }, this.#requestTimeoutMs);

      this.#pendingRequest = { reject, requestId, resolve, timeoutId };
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
          new BasicPitchPythonHostError(
            'BASIC_PITCH_HOST_SEND_FAILED',
            'Could not send a request to the Basic Pitch Python host.',
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
      this.#handleProtocolFailure('Basic Pitch Python host response is too large.');
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
      this.#handleProtocolFailure('Basic Pitch Python host emitted non-JSON output.');
      return false;
    }

    const pending = this.#pendingRequest;

    if (
      !pending ||
      !isRecord(message) ||
      message.protocolVersion !== PROVIDER_WORKER_PROTOCOL_VERSION ||
      message.requestId !== pending.requestId
    ) {
      this.#handleProtocolFailure('Basic Pitch Python host response identity is invalid.');
      return false;
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
      typeof message.error.code === 'string' &&
      typeof message.error.message === 'string'
    ) {
      pending.reject(
        new BasicPitchPythonHostError(message.error.code, message.error.message),
      );
      return true;
    }

    pending.reject(createHostResponseError('Basic Pitch Python host response is malformed.'));
    return true;
  }

  #handleProtocolFailure(message) {
    this.#rejectPending(createHostResponseError(message));
    void this.terminate();
  }

  #handleFailure(child, error) {
    if (child === this.#child) {
      this.#rejectPending(
        new BasicPitchPythonHostError(
          'BASIC_PITCH_HOST_FAILED',
          'Basic Pitch Python host process failed.',
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
      new BasicPitchPythonHostError(
        'BASIC_PITCH_HOST_EXITED',
        `Basic Pitch Python host exited${code === null ? '' : ` with code ${code}`}${
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

export function resolveBasicPitchPythonPath(environment = process.env) {
  const configuredPath = environment[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE];
  const pythonPath = configuredPath === undefined ? DEFAULT_PYTHON_PATH : configuredPath;

  if (typeof pythonPath !== 'string' || !isAbsolute(pythonPath)) {
    throw new TypeError(
      `${BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE} must contain an absolute path.`,
    );
  }

  return pythonPath;
}

async function validateRegularFile(path, message) {
  try {
    const fileStat = await lstat(path);

    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(message);
    }

    return await realpath(path);
  } catch (error) {
    throw new BasicPitchPythonHostError('BASIC_PITCH_RUNTIME_UNAVAILABLE', message, {
      cause: error,
    });
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      child.off('exit', handleExit);
      reject(
        new BasicPitchPythonHostError(
          'BASIC_PITCH_HOST_EXIT_TIMEOUT',
          'Basic Pitch Python host did not exit.',
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

function createHostResponseError(message) {
  return new BasicPitchPythonHostError('BASIC_PITCH_HOST_RESPONSE_INVALID', message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
