import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  FluidSynthRuntime,
  FluidSynthRuntimeError,
} from './fluidSynthRuntime.mjs';
import { encodeStandardMidiFile } from './midiFileEncoder.mjs';
import { SoundFontCatalogError } from './soundFontCatalog.mjs';

export const MAX_SOUNDFONT_AUDITION_REQUEST_BYTES = 1_048_576;
export const MAX_SOUNDFONT_AUDITION_NOTES = 4_096;
export const MAX_SOUNDFONT_AUDITION_SECONDS = 300;

const MAX_AUDITION_WAV_BYTES = 100 * 1024 * 1024;
const MIDI_TICKS_PER_QUARTER = 960;

export class SoundFontAuditionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SoundFontAuditionError';
    this.code = code;
  }
}

export class SoundFontAuditionService {
  #activeAbortController;
  #activeRender;
  #fluidSynthRuntime;
  #soundFontCatalog;

  constructor({
    fluidSynthRuntime = new FluidSynthRuntime(),
    soundFontCatalog,
  }) {
    if (!soundFontCatalog || typeof soundFontCatalog.resolve !== 'function') {
      throw new TypeError('SoundFontAuditionService requires a SoundFontCatalog.');
    }

    this.#fluidSynthRuntime = fluidSynthRuntime;
    this.#soundFontCatalog = soundFontCatalog;
  }

  async render(request, { gain, sampleRate, signal } = {}) {
    if (this.#activeRender) {
      throw new SoundFontAuditionError(
        'SOUNDFONT_AUDITION_BUSY',
        'Another SoundFont audition is already rendering.',
      );
    }

    const normalizedRequest = validateAuditionRequest(request);
    const abortController = new AbortController();
    const handleExternalAbort = () => abortController.abort();
    signal?.addEventListener('abort', handleExternalAbort, { once: true });
    if (signal?.aborted) {
      abortController.abort();
    }
    this.#activeAbortController = abortController;
    const render = this.#render(normalizedRequest, abortController.signal, {
      gain,
      sampleRate,
    });
    this.#activeRender = render;

    try {
      return await render;
    } finally {
      signal?.removeEventListener('abort', handleExternalAbort);
      if (this.#activeRender === render) {
        this.#activeRender = undefined;
        this.#activeAbortController = undefined;
      }
    }
  }

  async shutdown() {
    this.#activeAbortController?.abort();

    try {
      await this.#activeRender;
    } catch {
      // Shutdown only needs to ensure the temporary render is released.
    }
  }

  async #render(request, signal, renderingOptions) {
    let soundFont;

    try {
      soundFont = await this.#soundFontCatalog.resolve(request.soundFont);
    } catch (error) {
      if (error instanceof SoundFontCatalogError) {
        throw new SoundFontAuditionError(error.code, error.message);
      }

      throw error;
    }

    const midiBytes = encodeStandardMidiFile({
      bank: request.bank,
      bpm: request.midi.bpm,
      notes: request.midi.notes,
      program: request.program,
      ticksPerQuarter: request.midi.ticksPerQuarter,
    });
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'humstudio-soundfont-audition-'),
    );
    const midiPath = join(temporaryDirectory, 'audition.mid');
    const outputPath = join(temporaryDirectory, 'audition.wav');

    try {
      await writeFile(midiPath, midiBytes, { flag: 'wx' });
      await this.#fluidSynthRuntime.renderMidiToWav({
        ...(renderingOptions.gain === undefined
          ? {}
          : { gain: renderingOptions.gain }),
        midiPath,
        outputPath,
        ...(renderingOptions.sampleRate === undefined
          ? {}
          : { sampleRate: renderingOptions.sampleRate }),
        signal,
        soundFontPath: soundFont.absolutePath,
      });
      const outputStat = await stat(outputPath);

      if (
        !outputStat.isFile() ||
        outputStat.size < 44 ||
        outputStat.size > MAX_AUDITION_WAV_BYTES
      ) {
        throw new SoundFontAuditionError(
          'SOUNDFONT_AUDITION_WAV_INVALID',
          'FluidSynth returned an invalid audition WAV size.',
        );
      }

      const bytes = await readFile(outputPath);

      if (!isRiffWav(bytes)) {
        throw new SoundFontAuditionError(
          'SOUNDFONT_AUDITION_WAV_INVALID',
          'FluidSynth returned audio that is not a RIFF/WAVE file.',
        );
      }

      return Object.freeze({
        bytes,
        contentLength: bytes.length,
        contentType: 'audio/wav',
      });
    } catch (error) {
      if (
        error instanceof SoundFontAuditionError ||
        error instanceof FluidSynthRuntimeError
      ) {
        throw error;
      }

      throw new SoundFontAuditionError(
        'SOUNDFONT_AUDITION_RENDER_FAILED',
        error instanceof Error ? error.message : 'SoundFont audition failed.',
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

function validateAuditionRequest(value) {
  if (!isRecord(value)) {
    fail('SoundFont audition request must be an object.');
  }

  requireInteger(value.bank, 0, 16_383, 'SoundFont bank');
  requireInteger(value.program, 0, 127, 'SoundFont program');

  if (!isRecord(value.soundFont)) {
    fail('SoundFont audition request must include a SoundFont resource.');
  }

  const soundFont = {
    format: requireOneOf(value.soundFont.format, ['sf2', 'sf3'], 'SoundFont format'),
    library: requireOneOf(
      value.soundFont.library,
      ['builtin', 'project'],
      'SoundFont library',
    ),
    relativePath: requireText(value.soundFont.relativePath, 'SoundFont relative path'),
    resourceId: requireText(value.soundFont.resourceId, 'SoundFont resource ID'),
    revisionToken: requireText(value.soundFont.revisionToken, 'SoundFont revision token'),
  };

  if (
    !/^soundfont-[a-f0-9]{32}$/.test(soundFont.resourceId) ||
    !/^[a-f0-9]{64}$/.test(soundFont.revisionToken) ||
    !isNormalizedSoundFontPath(soundFont.relativePath) ||
    !soundFont.relativePath.toLowerCase().endsWith(`.${soundFont.format}`)
  ) {
    fail('SoundFont resource identity is invalid.');
  }

  if (!isRecord(value.midi)) {
    fail('SoundFont audition request must include MIDI data.');
  }

  const bpm = requireNumber(value.midi.bpm, 40, 240, 'MIDI BPM');
  const ticksPerQuarter = value.midi.ticksPerQuarter;

  if (ticksPerQuarter !== MIDI_TICKS_PER_QUARTER) {
    fail(`MIDI ticks per quarter must be ${MIDI_TICKS_PER_QUARTER}.`);
  }

  if (
    !Array.isArray(value.midi.notes) ||
    value.midi.notes.length === 0 ||
    value.midi.notes.length > MAX_SOUNDFONT_AUDITION_NOTES
  ) {
    fail(
      `SoundFont audition requires 1 to ${MAX_SOUNDFONT_AUDITION_NOTES} MIDI notes.`,
    );
  }

  const ids = new Set();
  const notes = value.midi.notes.map((note, index) => {
    if (!isRecord(note)) {
      fail(`MIDI note ${index + 1} must be an object.`);
    }

    const id = requireText(note.id, `MIDI note ${index + 1} ID`);

    if (ids.has(id)) {
      fail(`MIDI note ID "${id}" must be unique.`);
    }

    ids.add(id);
    const normalizedNote = {
      id,
      lengthTicks: requireInteger(note.lengthTicks, 1, 0x0fffffff, `MIDI note "${id}" length`),
      pitch: requireInteger(note.pitch, 0, 127, `MIDI note "${id}" pitch`),
      startTick: requireInteger(note.startTick, 0, 0x0fffffff, `MIDI note "${id}" start tick`),
      velocity: requireInteger(note.velocity, 1, 127, `MIDI note "${id}" velocity`),
    };

    if (normalizedNote.startTick + normalizedNote.lengthTicks > 0x0fffffff) {
      fail(`MIDI note "${id}" end tick exceeds the audition limit.`);
    }

    return normalizedNote;
  });
  const maximumEndTick = Math.max(
    ...notes.map((note) => note.startTick + note.lengthTicks),
  );
  const durationSeconds =
    (maximumEndTick / ticksPerQuarter) * (60 / bpm);

  if (durationSeconds > MAX_SOUNDFONT_AUDITION_SECONDS) {
    fail(
      `SoundFont audition exceeds the ${MAX_SOUNDFONT_AUDITION_SECONDS} second limit.`,
    );
  }

  return Object.freeze({
    bank: value.bank,
    midi: Object.freeze({
      bpm,
      notes: Object.freeze(notes),
      ticksPerQuarter,
    }),
    program: value.program,
    soundFont: Object.freeze(soundFont),
  });
}

function fail(message) {
  throw new SoundFontAuditionError('SOUNDFONT_AUDITION_REQUEST_INVALID', message);
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }

  return value;
}

function requireNumber(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${label} must be from ${minimum} to ${maximum}.`);
  }

  return value;
}

function requireOneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    fail(`${label} is invalid.`);
  }

  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string.`);
  }

  return value;
}

function isNormalizedSoundFontPath(value) {
  const segments = value.split('/');
  return (
    value.startsWith('soundfonts/') &&
    !value.includes('\\') &&
    segments.length > 1 &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function isRiffWav(bytes) {
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
