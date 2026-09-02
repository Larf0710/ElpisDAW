import {
  FluidSynthRuntime,
  FluidSynthRuntimeError,
} from './fluidSynthRuntime.mjs';
import { SoundFontCatalogError } from './soundFontCatalog.mjs';

export const MAX_SOUNDFONT_PRESET_CATALOG_REQUEST_BYTES = 4_096;

const MAX_CACHED_CATALOGS = 64;

export class SoundFontPresetCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SoundFontPresetCatalogError';
    this.code = code;
  }
}

export class SoundFontPresetCatalogService {
  #cache = new Map();
  #fluidSynthRuntime;
  #soundFontCatalog;

  constructor({
    fluidSynthRuntime = new FluidSynthRuntime(),
    soundFontCatalog,
  }) {
    if (!soundFontCatalog || typeof soundFontCatalog.resolve !== 'function') {
      throw new TypeError(
        'SoundFontPresetCatalogService requires a SoundFontCatalog.',
      );
    }

    if (
      !fluidSynthRuntime ||
      typeof fluidSynthRuntime.listSoundFontPresets !== 'function'
    ) {
      throw new TypeError(
        'SoundFontPresetCatalogService requires a FluidSynthRuntime.',
      );
    }

    this.#fluidSynthRuntime = fluidSynthRuntime;
    this.#soundFontCatalog = soundFontCatalog;
  }

  async list(request) {
    const soundFontReference = validateRequest(request);
    let soundFont;

    try {
      soundFont = await this.#soundFontCatalog.resolve(soundFontReference);
    } catch (error) {
      if (error instanceof SoundFontCatalogError) {
        throw new SoundFontPresetCatalogError(error.code, error.message);
      }

      throw error;
    }

    const cacheKey = `${soundFont.absolutePath}\0${soundFont.resourceId}\0${soundFont.revisionToken}`;
    const cached = this.#cache.get(cacheKey);

    if (cached) {
      return cached;
    }

    let presets;

    try {
      presets = await this.#fluidSynthRuntime.listSoundFontPresets({
        soundFontPath: soundFont.absolutePath,
      });
    } catch (error) {
      if (error instanceof FluidSynthRuntimeError) {
        throw error;
      }

      throw new SoundFontPresetCatalogError(
        'SOUNDFONT_PRESET_CATALOG_FAILED',
        error instanceof Error
          ? error.message
          : 'SoundFont preset catalog failed.',
      );
    }

    const result = Object.freeze({
      presets,
      resourceId: soundFont.resourceId,
      revisionToken: soundFont.revisionToken,
    });

    if (this.#cache.size >= MAX_CACHED_CATALOGS) {
      const oldestKey = this.#cache.keys().next().value;

      if (oldestKey !== undefined) {
        this.#cache.delete(oldestKey);
      }
    }

    this.#cache.set(cacheKey, result);
    return result;
  }
}

function validateRequest(value) {
  if (!isRecord(value) || !isRecord(value.soundFont)) {
    fail('SoundFont preset catalog request must include one SoundFont resource.');
  }

  const soundFont = value.soundFont;

  if (
    (soundFont.format !== 'sf2' && soundFont.format !== 'sf3') ||
    (soundFont.library !== 'builtin' && soundFont.library !== 'project') ||
    typeof soundFont.relativePath !== 'string' ||
    !isNormalizedSoundFontPath(soundFont.relativePath) ||
    !soundFont.relativePath.toLowerCase().endsWith(`.${soundFont.format}`) ||
    typeof soundFont.resourceId !== 'string' ||
    !/^soundfont-[a-f0-9]{32}$/u.test(soundFont.resourceId) ||
    typeof soundFont.revisionToken !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(soundFont.revisionToken)
  ) {
    fail('SoundFont preset catalog resource identity is invalid.');
  }

  return Object.freeze({
    format: soundFont.format,
    library: soundFont.library,
    relativePath: soundFont.relativePath,
    resourceId: soundFont.resourceId,
    revisionToken: soundFont.revisionToken,
  });
}

function fail(message) {
  throw new SoundFontPresetCatalogError(
    'SOUNDFONT_PRESET_CATALOG_REQUEST_INVALID',
    message,
  );
}

function isNormalizedSoundFontPath(value) {
  const segments = value.split('/');
  return (
    value.startsWith('soundfonts/') &&
    !value.includes('\\') &&
    segments.length > 1 &&
    segments.every(
      (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
    )
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
