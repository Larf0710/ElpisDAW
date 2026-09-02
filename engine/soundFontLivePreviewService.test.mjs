import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SoundFontLivePreviewError,
  SoundFontLivePreviewService,
} from './soundFontLivePreviewService.mjs';

afterEach(() => {
  vi.useRealTimers();
});

describe('SoundFontLivePreviewService', () => {
  it('prepares one verified SoundFont and triggers a bounded Note On/Off pair', async () => {
    vi.useFakeTimers();
    const session = createSession();
    const soundFontCatalog = {
      resolve: vi.fn(async (reference) => ({
        ...reference,
        absolutePath: 'D:\\SoundFonts\\MuseScore_General.sf3',
      })),
    };
    const fluidSynthRuntime = {
      start: vi.fn(async () => session),
    };
    const service = new SoundFontLivePreviewService({
      fluidSynthRuntime,
      soundFontCatalog,
    });

    const ready = await service.prepare(createPrepareRequest());
    const triggered = service.trigger({
      action: 'trigger',
      durationMs: 320,
      pitch: 60,
      sessionId: ready.sessionId,
      velocity: 100,
    });

    expect(ready).toMatchObject({
      bank: 0,
      program: 0,
      status: 'READY',
    });
    expect(triggered).toMatchObject({ pitch: 60, status: 'TRIGGERED' });
    expect(soundFontCatalog.resolve).toHaveBeenCalledOnce();
    expect(fluidSynthRuntime.start).toHaveBeenCalledWith({
      bank: 0,
      gain: 0.2,
      program: 0,
      sampleRate: 48_000,
      soundFontPath: 'D:\\SoundFonts\\MuseScore_General.sf3',
    });
    expect(session.noteOn).toHaveBeenCalledWith(60, 100);
    expect(session.noteOff).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(320);
    expect(session.noteOff).toHaveBeenCalledWith(60);
    await service.shutdown();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('reuses an identical preparation and replaces a changed preset safely', async () => {
    const firstSession = createSession();
    const secondSession = createSession();
    const fluidSynthRuntime = {
      start: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession),
    };
    const service = new SoundFontLivePreviewService({
      fluidSynthRuntime,
      soundFontCatalog: {
        resolve: async (reference) => ({
          ...reference,
          absolutePath: 'D:\\SoundFonts\\Default.sf3',
        }),
      },
    });

    const first = await service.prepare(createPrepareRequest());
    const reused = await service.prepare(createPrepareRequest());
    const changed = await service.prepare({
      ...createPrepareRequest(),
      program: 24,
    });

    expect(reused.sessionId).toBe(first.sessionId);
    expect(changed.sessionId).not.toBe(first.sessionId);
    expect(fluidSynthRuntime.start).toHaveBeenCalledTimes(2);
    expect(firstSession.close).toHaveBeenCalledOnce();
    await service.shutdown();
  });

  it('rejects triggers for stale or malformed sessions', async () => {
    const service = new SoundFontLivePreviewService({
      fluidSynthRuntime: { start: async () => createSession() },
      soundFontCatalog: {
        resolve: async (reference) => ({
          ...reference,
          absolutePath: 'D:\\SoundFonts\\Default.sf3',
        }),
      },
    });
    await service.prepare(createPrepareRequest());

    expect(() =>
      service.trigger({
        action: 'trigger',
        durationMs: 320,
        pitch: 60,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        velocity: 100,
      }),
    ).toThrow(SoundFontLivePreviewError);
    expect(() =>
      service.trigger({
        action: 'trigger',
        durationMs: 10,
        pitch: 60,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        velocity: 100,
      }),
    ).toThrow(/duration/i);
    await service.shutdown();
  });
});

function createPrepareRequest() {
  return {
    action: 'prepare',
    bank: 0,
    program: 0,
    soundFont: {
      format: 'sf3',
      library: 'builtin',
      relativePath: 'soundfonts/HumStudio Default/MuseScore_General.sf3',
      resourceId: `soundfont-${'a'.repeat(32)}`,
      revisionToken: 'b'.repeat(64),
    },
  };
}

function createSession() {
  return {
    close: vi.fn(async () => undefined),
    noteOff: vi.fn(),
    noteOn: vi.fn(),
  };
}
