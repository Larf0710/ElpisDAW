import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FLUIDSYNTH_RUNTIME_VERSION = '2.5.7';
export const FLUIDSYNTH_RENDER_TIMEOUT_MS = 60_000;
export const FLUIDSYNTH_SAMPLE_RATE = 48_000;
export const FLUIDSYNTH_PRESET_CATALOG_TIMEOUT_MS = 30_000;

const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_PRESET_CATALOG_OUTPUT_BYTES = 1024 * 1024;
const MAX_SOUNDFONT_PRESETS = 16_384;
const DEFAULT_EXECUTABLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'bin',
  'fluidsynth',
  FLUIDSYNTH_RUNTIME_VERSION,
  'fluidsynth.exe',
);

export class FluidSynthRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FluidSynthRuntimeError';
    this.code = code;
  }
}

export class FluidSynthRuntime {
  #executablePath;
  #spawnProcess;
  #verified;

  constructor({
    executablePath = DEFAULT_EXECUTABLE_PATH,
    spawnProcess = spawn,
  } = {}) {
    this.#executablePath = executablePath;
    this.#spawnProcess = spawnProcess;
  }

  async verify() {
    if (!this.#verified) {
      this.#verified = runProcess({
        args: ['--version'],
        executablePath: this.#executablePath,
        spawnProcess: this.#spawnProcess,
        timeoutMs: 10_000,
      }).then(({ stdout }) => {
        if (!stdout.includes(`FluidSynth runtime version ${FLUIDSYNTH_RUNTIME_VERSION}`)) {
          throw new FluidSynthRuntimeError(
            'FLUIDSYNTH_VERSION_MISMATCH',
            `ElpisDAW requires FluidSynth ${FLUIDSYNTH_RUNTIME_VERSION}.`,
          );
        }

        return Object.freeze({
          executablePath: this.#executablePath,
          version: FLUIDSYNTH_RUNTIME_VERSION,
        });
      });
    }

    return this.#verified;
  }

  async renderMidiToWav({
    gain = 0.2,
    midiPath,
    outputPath,
    sampleRate = FLUIDSYNTH_SAMPLE_RATE,
    signal,
    soundFontPath,
  }) {
    if (!Number.isFinite(gain) || gain <= 0 || gain > 10) {
      throw new FluidSynthRuntimeError(
        'FLUIDSYNTH_GAIN_INVALID',
        'FluidSynth gain must be greater than 0 and no greater than 10.',
      );
    }

    if (
      !Number.isSafeInteger(sampleRate) ||
      sampleRate < 8_000 ||
      sampleRate > 192_000
    ) {
      throw new FluidSynthRuntimeError(
        'FLUIDSYNTH_SAMPLE_RATE_INVALID',
        'FluidSynth sample rate must be an integer from 8000 through 192000.',
      );
    }

    await this.verify();

    await runProcess({
      args: [
        '-q',
        '-n',
        '-i',
        '-R',
        '0',
        '-C',
        '0',
        '-g',
        String(gain),
        '-r',
        String(sampleRate),
        '-T',
        'wav',
        '-O',
        's16',
        '-F',
        outputPath,
        soundFontPath,
        midiPath,
      ],
      executablePath: this.#executablePath,
      signal,
      spawnProcess: this.#spawnProcess,
      timeoutMs: FLUIDSYNTH_RENDER_TIMEOUT_MS,
    });
  }

  async listSoundFontPresets({ soundFontPath }) {
    if (typeof soundFontPath !== 'string' || !soundFontPath.trim()) {
      throw new FluidSynthRuntimeError(
        'FLUIDSYNTH_PRESET_CATALOG_REQUEST_INVALID',
        'SoundFont preset catalog requires one absolute SoundFont path.',
      );
    }

    await this.verify();

    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'humstudio-soundfont-presets-'),
    );
    let presets;

    try {
      const outputPath = join(temporaryDirectory, 'silent-driver.wav');
      const { stdout } = await runProcess({
        args: [
          '-n',
          '-a',
          'file',
          '-o',
          `audio.file.name=${outputPath}`,
          soundFontPath,
        ],
        executablePath: this.#executablePath,
        failureCode: 'FLUIDSYNTH_PRESET_CATALOG_FAILED',
      inputText: 'inst 1\nquit\n',
      maxOutputBytes: MAX_PRESET_CATALOG_OUTPUT_BYTES,
      operationLabel: 'preset catalog',
      spawnProcess: this.#spawnProcess,
        timeoutCode: 'FLUIDSYNTH_PRESET_CATALOG_TIMEOUT',
        timeoutMs: FLUIDSYNTH_PRESET_CATALOG_TIMEOUT_MS,
      });
      presets = parseFluidSynthPresetCatalog(stdout);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }

    if (presets.length === 0) {
      throw new FluidSynthRuntimeError(
        'FLUIDSYNTH_PRESET_CATALOG_INVALID',
        'FluidSynth did not report any presets for the selected SoundFont.',
      );
    }

    return presets;
  }
}

function runProcess({
  args,
  executablePath,
  failureCode = 'FLUIDSYNTH_RENDER_FAILED',
  inputText,
  maxOutputBytes = MAX_PROCESS_OUTPUT_BYTES,
  operationLabel = 'render',
  signal,
  spawnProcess,
  timeoutCode = 'FLUIDSYNTH_RENDER_TIMEOUT',
  timeoutMs,
}) {
  return new Promise((resolveRun, rejectRun) => {
    if (signal?.aborted) {
      rejectRun(createCanceledError());
      return;
    }

    let child;

    try {
      child = spawnProcess(executablePath, args, {
        stdio: [inputText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      rejectRun(createSpawnError(error));
      return;
    }

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (action) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
      action();
    };
    const stopChild = () => {
      try {
        child.kill();
      } catch {
        // A process that already exited does not need another termination request.
      }
    };
    const handleAbort = () => {
      stopChild();
      finish(() => rejectRun(createCanceledError()));
    };
    const capture = (target) => (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;

      if (outputBytes > maxOutputBytes) {
        stopChild();
        finish(() =>
          rejectRun(
            new FluidSynthRuntimeError(
              'FLUIDSYNTH_OUTPUT_LIMIT_EXCEEDED',
              'FluidSynth produced too much diagnostic output.',
            ),
          ),
        );
        return;
      }

      target.push(bytes);
    };
    const timeoutId = setTimeout(() => {
      timedOut = true;
      stopChild();
      finish(() =>
        rejectRun(
          new FluidSynthRuntimeError(
            timeoutCode,
            `FluidSynth ${operationLabel} did not finish within ${timeoutMs} ms.`,
          ),
        ),
      );
    }, timeoutMs);

    signal?.addEventListener('abort', handleAbort, { once: true });
    child.stdout?.on('data', capture(stdout));
    child.stderr?.on('data', capture(stderr));
    if (inputText !== undefined) {
      child.stdin?.end(inputText);
    }
    child.once('error', (error) => {
      finish(() => rejectRun(createSpawnError(error)));
    });
    child.once('close', (code) => {
      if (timedOut || signal?.aborted) {
        return;
      }

      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');

      if (code !== 0) {
        const detail = stderrText.trim() || stdoutText.trim() || `exit code ${code}`;
        finish(() =>
          rejectRun(
            new FluidSynthRuntimeError(
              failureCode,
              `FluidSynth ${operationLabel} failed: ${detail}`,
            ),
          ),
        );
        return;
      }

      finish(() =>
        resolveRun({
          stderr: stderrText,
          stdout: stdoutText,
        }),
      );
    });
  });
}

export function parseFluidSynthPresetCatalog(output) {
  if (typeof output !== 'string') {
    return Object.freeze([]);
  }

  const presets = new Map();

  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*>?\s*(\d{1,5})-(\d{1,3})\s+(.+?)\s*$/u.exec(line);

    if (!match) {
      continue;
    }

    const bank = Number(match[1]);
    const program = Number(match[2]);
    const name = match[3].trim();

    if (
      !Number.isSafeInteger(bank) ||
      bank < 0 ||
      bank > 16_383 ||
      !Number.isSafeInteger(program) ||
      program < 0 ||
      program > 127 ||
      !name ||
      name.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(name)
    ) {
      continue;
    }

    presets.set(`${bank}:${program}`, Object.freeze({ bank, name, program }));

    if (presets.size > MAX_SOUNDFONT_PRESETS) {
      throw new FluidSynthRuntimeError(
        'FLUIDSYNTH_PRESET_CATALOG_LIMIT_EXCEEDED',
        `SoundFont exposes more than ${MAX_SOUNDFONT_PRESETS} presets.`,
      );
    }
  }

  return Object.freeze(
    [...presets.values()].sort(
      (left, right) => left.bank - right.bank || left.program - right.program,
    ),
  );
}

function createSpawnError(error) {
  const detail = error instanceof Error ? error.message : 'Unknown process error.';
  return new FluidSynthRuntimeError(
    'FLUIDSYNTH_RUNTIME_UNAVAILABLE',
    `FluidSynth runtime is unavailable: ${detail}`,
  );
}

function createCanceledError() {
  return new FluidSynthRuntimeError(
    'SOUNDFONT_AUDITION_CANCELED',
    'SoundFont audition was canceled.',
  );
}
