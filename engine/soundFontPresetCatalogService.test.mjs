import { describe, expect, it, vi } from 'vitest';

import {
  SoundFontPresetCatalogError,
  SoundFontPresetCatalogService,
} from './soundFontPresetCatalogService.mjs';

const reference = Object.freeze({
  format: 'sf3',
  library: 'builtin',
  relativePath: 'soundfonts/HumStudio Default/MuseScore_General.sf3',
  resourceId: `soundfont-${'a'.repeat(32)}`,
  revisionToken: 'b'.repeat(64),
});

describe('SoundFontPresetCatalogService', () => {
  it('resolves a verified resource, loads its real presets once, and caches by revision', async () => {
    const soundFontCatalog = {
      resolve: vi.fn(async () => ({
        ...reference,
        absolutePath: 'D:\\SoundFonts\\MuseScore_General.sf3',
      })),
    };
    const fluidSynthRuntime = {
      listSoundFontPresets: vi.fn(async () =>
        Object.freeze([
          Object.freeze({ bank: 0, name: 'Grand Piano', program: 0 }),
        ]),
      ),
    };
    const service = new SoundFontPresetCatalogService({
      fluidSynthRuntime,
      soundFontCatalog,
    });

    await expect(service.list({ soundFont: reference })).resolves.toEqual({
      presets: [{ bank: 0, name: 'Grand Piano', program: 0 }],
      resourceId: reference.resourceId,
      revisionToken: reference.revisionToken,
    });
    await service.list({ soundFont: reference });

    expect(soundFontCatalog.resolve).toHaveBeenCalledTimes(2);
    expect(fluidSynthRuntime.listSoundFontPresets).toHaveBeenCalledOnce();
    expect(fluidSynthRuntime.listSoundFontPresets).toHaveBeenCalledWith({
      soundFontPath: 'D:\\SoundFonts\\MuseScore_General.sf3',
    });
  });

  it('rejects malformed resource identities before touching the catalog', async () => {
    const soundFontCatalog = { resolve: vi.fn() };
    const service = new SoundFontPresetCatalogService({
      fluidSynthRuntime: { listSoundFontPresets: vi.fn() },
      soundFontCatalog,
    });

    await expect(
      service.list({ soundFont: { ...reference, relativePath: '../outside.sf3' } }),
    ).rejects.toBeInstanceOf(SoundFontPresetCatalogError);
    expect(soundFontCatalog.resolve).not.toHaveBeenCalled();
  });
});
