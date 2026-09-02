import { randomUUID } from 'node:crypto';

import { FluidSynthLiveHostRuntime } from './fluidSynthLiveHostRuntime.mjs';
import { SoundFontCatalogError } from './soundFontCatalog.mjs';

export const MAX_SOUNDFONT_LIVE_PREVIEW_REQUEST_BYTES = 16 * 1024;
export const SOUNDFONT_LIVE_PREVIEW_DURATION_MIN_MS = 120;
export const SOUNDFONT_LIVE_PREVIEW_DURATION_MAX_MS = 2_000;

export class SoundFontLivePreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SoundFontLivePreviewError';
    this.code = code;
  }
}

export class SoundFontLivePreviewService {
  #active;
  #activePrepare;
  #fluidSynthRuntime;
  #soundFontCatalog;
  #voiceGenerations = new Map();
  #voiceTimers = new Map();

  constructor({
    fluidSynthRuntime = new FluidSynthLiveHostRuntime(),
    soundFontCatalog,
  }) {
    if (!soundFontCatalog || typeof soundFontCatalog.resolve !== 'function') {
      throw new TypeError('SoundFontLivePreviewService requires a SoundFontCatalog.');
    }

    if (!fluidSynthRuntime || typeof fluidSynthRuntime.start !== 'function') {
      throw new TypeError('SoundFontLivePreviewService requires a FluidSynth Live Host runtime.');
    }

    this.#fluidSynthRuntime = fluidSynthRuntime;
    this.#soundFontCatalog = soundFontCatalog;
  }

  async prepare(request) {
    const normalized = validatePrepareRequest(request);
    const identity = createPreparationIdentity(normalized);

    if (this.#active?.identity === identity) {
      return createReadySnapshot(this.#active);
    }

    if (this.#activePrepare) {
      if (this.#activePrepare.identity === identity) {
        return this.#activePrepare.promise;
      }

      throw new SoundFontLivePreviewError(
        'SOUNDFONT_LIVE_PREVIEW_BUSY',
        'Another SoundFont Live Preview is preparing.',
      );
    }

    const promise = this.#prepare(normalized, identity).finally(() => {
      if (this.#activePrepare?.promise === promise) {
        this.#activePrepare = undefined;
      }
    });
    this.#activePrepare = { identity, promise };
    return promise;
  }

  trigger(request) {
    const normalized = validateTriggerRequest(request);
    const active = this.#requireActive(normalized.sessionId);
    const previousTimer = this.#voiceTimers.get(normalized.pitch);

    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    const generation = (this.#voiceGenerations.get(normalized.pitch) ?? 0) + 1;
    this.#voiceGenerations.set(normalized.pitch, generation);
    active.session.noteOn(normalized.pitch, normalized.velocity);
    const timer = setTimeout(() => {
      if (
        this.#active?.sessionId === normalized.sessionId &&
        this.#voiceGenerations.get(normalized.pitch) === generation
      ) {
        try {
          this.#active.session.noteOff(normalized.pitch);
        } catch {
          // A host that already exited cannot leave a sounding voice behind.
        }
        this.#voiceTimers.delete(normalized.pitch);
      }
    }, normalized.durationMs);
    timer.unref?.();
    this.#voiceTimers.set(normalized.pitch, timer);

    return Object.freeze({
      pitch: normalized.pitch,
      sessionId: active.sessionId,
      status: 'TRIGGERED',
    });
  }

  async stop(request = {}) {
    const sessionId = validateStopRequest(request);

    if (sessionId && this.#active && this.#active.sessionId !== sessionId) {
      throw new SoundFontLivePreviewError(
        'SOUNDFONT_LIVE_PREVIEW_SESSION_MISMATCH',
        'SoundFont Live Preview session identity does not match.',
      );
    }

    const active = this.#active;
    this.#active = undefined;
    this.#clearVoices();

    if (active) {
      await active.session.close();
    }

    return Object.freeze({ status: 'STOPPED' });
  }

  async shutdown() {
    try {
      await this.#activePrepare?.promise;
    } catch {
      // Shutdown still releases any session that completed preparation.
    }

    await this.stop();
  }

  async #prepare(request, identity) {
    let soundFont;

    try {
      soundFont = await this.#soundFontCatalog.resolve(request.soundFont);
    } catch (error) {
      if (error instanceof SoundFontCatalogError) {
        throw new SoundFontLivePreviewError(error.code, error.message);
      }

      throw error;
    }

    await this.stop();
    const session = await this.#fluidSynthRuntime.start({
      bank: request.bank,
      gain: request.gain,
      program: request.program,
      sampleRate: request.sampleRate,
      soundFontPath: soundFont.absolutePath,
    });
    const active = Object.freeze({
      bank: request.bank,
      identity,
      program: request.program,
      resourceId: soundFont.resourceId,
      session,
      sessionId: randomUUID(),
    });
    this.#active = active;
    return createReadySnapshot(active);
  }

  #requireActive(sessionId) {
    if (!this.#active) {
      throw new SoundFontLivePreviewError(
        'SOUNDFONT_LIVE_PREVIEW_OFFLINE',
        'Prepare SoundFont Live Preview before triggering a note.',
      );
    }

    if (this.#active.sessionId !== sessionId) {
      throw new SoundFontLivePreviewError(
        'SOUNDFONT_LIVE_PREVIEW_SESSION_MISMATCH',
        'SoundFont Live Preview session identity does not match.',
      );
    }

    return this.#active;
  }

  #clearVoices() {
    for (const timer of this.#voiceTimers.values()) {
      clearTimeout(timer);
    }
    this.#voiceTimers.clear();
    this.#voiceGenerations.clear();
  }
}

function validatePrepareRequest(value) {
  if (!isRecord(value) || value.action !== 'prepare' || !isRecord(value.soundFont)) {
    fail('SoundFont Live Preview prepare request is invalid.');
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
    !isNormalizedSoundFontPath(soundFont.relativePath, soundFont.format)
  ) {
    fail('SoundFont Live Preview resource identity is invalid.');
  }

  return Object.freeze({
    action: 'prepare',
    bank: requireInteger(value.bank, 0, 16_383, 'SoundFont bank'),
    gain: value.gain === undefined
      ? 0.2
      : requireNumber(value.gain, 0.01, 10, 'SoundFont gain'),
    program: requireInteger(value.program, 0, 127, 'SoundFont program'),
    sampleRate: value.sampleRate === undefined
      ? 48_000
      : requireInteger(value.sampleRate, 8_000, 192_000, 'SoundFont sample rate'),
    soundFont: Object.freeze(soundFont),
  });
}

function validateTriggerRequest(value) {
  if (!isRecord(value) || value.action !== 'trigger') {
    fail('SoundFont Live Preview trigger request is invalid.');
  }

  return Object.freeze({
    action: 'trigger',
    durationMs: requireInteger(
      value.durationMs,
      SOUNDFONT_LIVE_PREVIEW_DURATION_MIN_MS,
      SOUNDFONT_LIVE_PREVIEW_DURATION_MAX_MS,
      'Live Note duration',
    ),
    pitch: requireInteger(value.pitch, 0, 127, 'Live Note pitch'),
    sessionId: requireSessionId(value.sessionId),
    velocity: requireInteger(value.velocity, 1, 127, 'Live Note velocity'),
  });
}

function validateStopRequest(value) {
  if (!isRecord(value) || (value.action !== undefined && value.action !== 'stop')) {
    fail('SoundFont Live Preview stop request is invalid.');
  }

  return value.sessionId === undefined ? undefined : requireSessionId(value.sessionId);
}

function createPreparationIdentity(request) {
  return [
    request.soundFont.library,
    request.soundFont.resourceId,
    request.soundFont.revisionToken,
    request.bank,
    request.program,
    request.gain,
    request.sampleRate,
  ].join('\0');
}

function createReadySnapshot(active) {
  return Object.freeze({
    bank: active.bank,
    program: active.program,
    resourceId: active.resourceId,
    sessionId: active.sessionId,
    status: 'READY',
  });
}

function isNormalizedSoundFontPath(value, format) {
  const segments = value.split('/');
  return (
    value.startsWith('soundfonts/') &&
    value.toLowerCase().endsWith(`.${format}`) &&
    !value.includes('\\') &&
    segments.length > 1 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes(':'),
    )
  );
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function requireNumber(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${label} must be from ${minimum} through ${maximum}.`);
  }
  return value;
}

function requireOneOf(value, options, label) {
  if (!options.includes(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function requireSessionId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) {
    fail('SoundFont Live Preview session ID is invalid.');
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function fail(message) {
  throw new SoundFontLivePreviewError(
    'SOUNDFONT_LIVE_PREVIEW_REQUEST_INVALID',
    message,
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
