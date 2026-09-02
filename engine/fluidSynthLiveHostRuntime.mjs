import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FLUIDSYNTH_RUNTIME_VERSION,
  FLUIDSYNTH_SAMPLE_RATE,
} from './fluidSynthRuntime.mjs';

export const FLUIDSYNTH_LIVE_HOST_START_TIMEOUT_MS = 15_000;
export const FLUIDSYNTH_LIVE_HOST_STOP_TIMEOUT_MS = 2_000;

const MAX_HOST_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_HOST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'bin',
  'fluidsynth',
  FLUIDSYNTH_RUNTIME_VERSION,
  'HumStudio.FluidSynthLiveHost.exe',
);

export class FluidSynthLiveHostRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FluidSynthLiveHostRuntimeError';
    this.code = code;
  }
}

export class FluidSynthLiveHostRuntime {
  #hostPath;
  #spawnProcess;

  constructor({ hostPath = DEFAULT_HOST_PATH, spawnProcess = spawn } = {}) {
    this.#hostPath = hostPath;
    this.#spawnProcess = spawnProcess;
  }

  async start({
    bank,
    gain = 0.2,
    program,
    sampleRate = FLUIDSYNTH_SAMPLE_RATE,
    signal,
    soundFontPath,
  }) {
    validateStartOptions({ bank, gain, program, sampleRate, soundFontPath });

    if (signal?.aborted) {
      throw canceledError();
    }

    let child;

    try {
      child = this.#spawnProcess(
        this.#hostPath,
        [
          soundFontPath,
          String(bank),
          String(program),
          String(gain),
          String(sampleRate),
          String(process.pid),
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch (error) {
      throw spawnError(error);
    }

    try {
      await waitForReady(child, signal);
    } catch (error) {
      stopChild(child);
      throw error;
    }

    return new FluidSynthLiveHostSession(child);
  }
}

export class FluidSynthLiveHostSession {
  #child;
  #closed = false;
  #closedPromise;

  constructor(child) {
    this.#child = child;
    this.#closedPromise = new Promise((resolveClosed) => {
      child.once('close', () => {
        this.#closed = true;
        resolveClosed();
      });
    });
  }

  noteOn(pitch, velocity) {
    requireInteger(pitch, 0, 127, 'Live Note pitch');
    requireInteger(velocity, 1, 127, 'Live Note velocity');
    this.#write(`NOTE_ON\t${pitch}\t${velocity}\n`);
  }

  noteOff(pitch) {
    requireInteger(pitch, 0, 127, 'Live Note pitch');
    this.#write(`NOTE_OFF\t${pitch}\n`);
  }

  allNotesOff() {
    if (!this.#closed) {
      this.#write('ALL_NOTES_OFF\n');
    }
  }

  async close() {
    if (this.#closed) {
      return;
    }

    try {
      this.#write('ALL_NOTES_OFF\nSTOP\n');
      this.#child.stdin?.end();
    } catch {
      stopChild(this.#child);
    }

    let timeoutId;
    await Promise.race([
      this.#closedPromise,
      new Promise((resolveTimeout) => {
        timeoutId = setTimeout(() => {
          stopChild(this.#child);
          resolveTimeout();
        }, FLUIDSYNTH_LIVE_HOST_STOP_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timeoutId);
  }

  #write(command) {
    if (
      this.#closed ||
      !this.#child.stdin ||
      this.#child.stdin.destroyed ||
      !this.#child.stdin.writable
    ) {
      throw new FluidSynthLiveHostRuntimeError(
        'FLUIDSYNTH_LIVE_HOST_OFFLINE',
        'FluidSynth Live Host is not available.',
      );
    }

    this.#child.stdin.write(command, 'utf8');
  }
}

function waitForReady(child, signal) {
  return new Promise((resolveReady, rejectReady) => {
    let outputBytes = 0;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (action) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
      child.off('error', handleError);
      child.off('close', handleClose);
      child.stdout?.off('data', handleStdout);
      child.stderr?.off('data', handleStderr);
      action();
    };
    const capture = (current, chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;

      if (outputBytes > MAX_HOST_OUTPUT_BYTES) {
        finish(() =>
          rejectReady(
            new FluidSynthLiveHostRuntimeError(
              'FLUIDSYNTH_LIVE_HOST_OUTPUT_LIMIT_EXCEEDED',
              'FluidSynth Live Host produced too much diagnostic output.',
            ),
          ),
        );
        return current;
      }

      return `${current}${bytes.toString('utf8')}`;
    };
    const handleStdout = (chunk) => {
      stdout = capture(stdout, chunk);

      if (/(?:^|\r?\n)READY(?:\r?\n|$)/.test(stdout)) {
        finish(resolveReady);
      }
    };
    const handleStderr = (chunk) => {
      stderr = capture(stderr, chunk);
    };
    const handleAbort = () => finish(() => rejectReady(canceledError()));
    const handleError = (error) => finish(() => rejectReady(spawnError(error)));
    const handleClose = (code) =>
      finish(() =>
        rejectReady(
          new FluidSynthLiveHostRuntimeError(
            'FLUIDSYNTH_LIVE_HOST_START_FAILED',
            readHostFailure(stderr, code),
          ),
        ),
      );
    const timeoutId = setTimeout(() => {
      finish(() =>
        rejectReady(
          new FluidSynthLiveHostRuntimeError(
            'FLUIDSYNTH_LIVE_HOST_START_TIMEOUT',
            'FluidSynth Live Host did not become ready in time.',
          ),
        ),
      );
    }, FLUIDSYNTH_LIVE_HOST_START_TIMEOUT_MS);

    signal?.addEventListener('abort', handleAbort, { once: true });
    child.once('error', handleError);
    child.once('close', handleClose);
    child.stdout?.on('data', handleStdout);
    child.stderr?.on('data', handleStderr);
  });
}

function validateStartOptions({ bank, gain, program, sampleRate, soundFontPath }) {
  requireInteger(bank, 0, 16_383, 'Live SoundFont bank');
  requireInteger(program, 0, 127, 'Live SoundFont program');
  requireInteger(sampleRate, 8_000, 192_000, 'Live sample rate');

  if (!Number.isFinite(gain) || gain <= 0 || gain > 10) {
    throw new FluidSynthLiveHostRuntimeError(
      'FLUIDSYNTH_LIVE_HOST_REQUEST_INVALID',
      'Live FluidSynth gain must be greater than 0 and no greater than 10.',
    );
  }

  if (typeof soundFontPath !== 'string' || soundFontPath.trim().length === 0) {
    throw new FluidSynthLiveHostRuntimeError(
      'FLUIDSYNTH_LIVE_HOST_REQUEST_INVALID',
      'Live SoundFont path is required.',
    );
  }
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new FluidSynthLiveHostRuntimeError(
      'FLUIDSYNTH_LIVE_HOST_REQUEST_INVALID',
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
}

function readHostFailure(stderr, code) {
  const match = stderr.match(/(?:^|\r?\n)ERROR\t[^\t\r\n]+\t([^\r\n]+)/);
  return match?.[1] ?? `FluidSynth Live Host exited before READY (${String(code)}).`;
}

function spawnError(error) {
  return new FluidSynthLiveHostRuntimeError(
    'FLUIDSYNTH_LIVE_HOST_UNAVAILABLE',
    `FluidSynth Live Host is unavailable: ${
      error instanceof Error ? error.message : 'Unknown process error.'
    }`,
  );
}

function canceledError() {
  return new FluidSynthLiveHostRuntimeError(
    'FLUIDSYNTH_LIVE_HOST_CANCELED',
    'FluidSynth Live Host startup was canceled.',
  );
}

function stopChild(child) {
  try {
    child.kill();
  } catch {
    // An exited host does not need another termination request.
  }
}
