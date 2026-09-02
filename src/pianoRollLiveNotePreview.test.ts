import { describe, expect, it, vi } from 'vitest';

import type { LocalEngineClient } from './localEngineClient';
import {
  PIANO_ROLL_LIVE_NOTE_DURATION_MS,
  PIANO_ROLL_LIVE_NOTE_PREPARE_RETRY_DELAYS_MS,
  PianoRollLiveNotePreviewRuntime,
} from './pianoRollLiveNotePreview';

const sessionId = '12345678-1234-4abc-8def-1234567890ab';

describe('PianoRollLiveNotePreviewRuntime', () => {
  it('prepares the selected SoundFont once and triggers bounded live notes', async () => {
    const controlSoundFontLivePreview = vi.fn(async (request) => {
      if (request.action === 'prepare') {
        return {
          ok: true as const,
          snapshot: {
            bank: request.bank,
            program: request.program,
            resourceId: request.soundFont.resourceId,
            sessionId,
            status: 'READY' as const,
          },
        };
      }

      if (request.action === 'trigger') {
        return {
          ok: true as const,
          snapshot: {
            pitch: request.pitch,
            sessionId,
            status: 'TRIGGERED' as const,
          },
        };
      }

      return { ok: true as const, snapshot: { status: 'STOPPED' as const } };
    });
    const client = { controlSoundFontLivePreview } as unknown as LocalEngineClient;
    const runtime = new PianoRollLiveNotePreviewRuntime();
    const onStateChange = vi.fn();
    const selection = createSelection();

    await expect(runtime.prepare(client, selection, onStateChange)).resolves.toBe(true);
    await expect(runtime.prepare(client, selection, onStateChange)).resolves.toBe(true);
    await expect(runtime.trigger(60, 100, onStateChange)).resolves.toBe(true);

    expect(controlSoundFontLivePreview).toHaveBeenCalledTimes(2);
    expect(controlSoundFontLivePreview).toHaveBeenLastCalledWith({
      action: 'trigger',
      durationMs: PIANO_ROLL_LIVE_NOTE_DURATION_MS,
      pitch: 60,
      sessionId,
      velocity: 100,
    });
    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'READY' }),
    );
  });

  it('stops the active host when Piano Roll releases its preview boundary', async () => {
    const controlSoundFontLivePreview = vi.fn(async (request) =>
      request.action === 'prepare'
        ? {
            ok: true as const,
            snapshot: {
              bank: 0,
              program: 0,
              resourceId: createSelection().resource.resourceId,
              sessionId,
              status: 'READY' as const,
            },
          }
        : { ok: true as const, snapshot: { status: 'STOPPED' as const } },
    );
    const client = { controlSoundFontLivePreview } as unknown as LocalEngineClient;
    const runtime = new PianoRollLiveNotePreviewRuntime();
    const onStateChange = vi.fn();
    await runtime.prepare(client, createSelection(), onStateChange);

    await runtime.stop(onStateChange);

    expect(controlSoundFontLivePreview).toHaveBeenLastCalledWith({
      action: 'stop',
      sessionId,
    });
    expect(onStateChange).toHaveBeenLastCalledWith({ status: 'IDLE' });
  });

  it('rejects a failed host stop and keeps the active session available for retry', async () => {
    let stopAttempts = 0;
    const controlSoundFontLivePreview = vi.fn(async (request) => {
      if (request.action === 'prepare') {
        return {
          ok: true as const,
          snapshot: {
            bank: request.bank,
            program: request.program,
            resourceId: request.soundFont.resourceId,
            sessionId,
            status: 'READY' as const,
          },
        };
      }

      stopAttempts += 1;
      return stopAttempts === 1
        ? {
            message: 'Live Host stop failed.',
            ok: false as const,
            reason: 'http-error' as const,
            status: 500,
          }
        : { ok: true as const, snapshot: { status: 'STOPPED' as const } };
    });
    const client = { controlSoundFontLivePreview } as unknown as LocalEngineClient;
    const runtime = new PianoRollLiveNotePreviewRuntime();
    const onStateChange = vi.fn();
    await runtime.prepare(client, createSelection(), onStateChange);

    await expect(runtime.stop(onStateChange)).rejects.toThrow(
      'Live Host stop failed.',
    );
    expect(onStateChange).not.toHaveBeenLastCalledWith({ status: 'IDLE' });

    await expect(runtime.stop(onStateChange)).resolves.toBeUndefined();
    expect(
      controlSoundFontLivePreview.mock.calls.filter(
        ([request]) => request.action === 'stop',
      ),
    ).toHaveLength(2);
    expect(onStateChange).toHaveBeenLastCalledWith({ status: 'IDLE' });
  });

  it('rejects a stop response that does not confirm the STOPPED state', async () => {
    const controlSoundFontLivePreview = vi.fn(async (request) =>
      request.action === 'prepare'
        ? {
            ok: true as const,
            snapshot: {
              bank: request.bank,
              program: request.program,
              resourceId: request.soundFont.resourceId,
              sessionId,
              status: 'READY' as const,
            },
          }
        : {
            ok: true as const,
            snapshot: {
              bank: 0,
              program: 0,
              resourceId: createSelection().resource.resourceId,
              sessionId,
              status: 'READY' as const,
            },
          },
    );
    const client = { controlSoundFontLivePreview } as unknown as LocalEngineClient;
    const runtime = new PianoRollLiveNotePreviewRuntime();
    await runtime.prepare(client, createSelection(), vi.fn());

    await expect(runtime.stop()).rejects.toThrow(
      'Local Engine returned an invalid Note Preview stop state.',
    );
  });

  it('shares one in-flight host stop across concurrent release requests', async () => {
    type PreviewResult = Awaited<
      ReturnType<LocalEngineClient['controlSoundFontLivePreview']>
    >;
    let resolveStop!: (result: PreviewResult) => void;
    const controlSoundFontLivePreview = vi.fn((request) =>
      request.action === 'prepare'
        ? Promise.resolve({
            ok: true as const,
            snapshot: {
              bank: request.bank,
              program: request.program,
              resourceId: request.soundFont.resourceId,
              sessionId,
              status: 'READY' as const,
            },
          })
        : new Promise<PreviewResult>((resolve) => {
            resolveStop = resolve;
          }),
    );
    const client = { controlSoundFontLivePreview } as unknown as LocalEngineClient;
    const runtime = new PianoRollLiveNotePreviewRuntime();
    const onStateChange = vi.fn();
    await runtime.prepare(client, createSelection(), onStateChange);

    const firstStop = runtime.stop(onStateChange);
    const secondStop = runtime.stop(onStateChange);
    let stopped = false;
    void firstStop.then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(secondStop).toBe(firstStop);
    expect(stopped).toBe(false);
    expect(
      controlSoundFontLivePreview.mock.calls.filter(
        ([request]) => request.action === 'stop',
      ),
    ).toHaveLength(1);

    resolveStop({ ok: true, snapshot: { status: 'STOPPED' } });
    await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(onStateChange).toHaveBeenLastCalledWith({ status: 'IDLE' });
  });

  it('retries a transient startup preparation failure without requiring a manual toggle', async () => {
    vi.useFakeTimers();
    const controlSoundFontLivePreview = vi
      .fn()
      .mockResolvedValueOnce({
        message: 'SoundFont Live Preview is still starting.',
        ok: false as const,
        reason: 'http-error' as const,
        status: 409,
      })
      .mockImplementation(async (request) =>
        request.action === 'prepare'
          ? {
              ok: true as const,
              snapshot: {
                bank: request.bank,
                program: request.program,
                resourceId: request.soundFont.resourceId,
                sessionId,
                status: 'READY' as const,
              },
            }
          : { ok: true as const, snapshot: { status: 'STOPPED' as const } },
      );
    const client = { controlSoundFontLivePreview } as unknown as LocalEngineClient;
    const runtime = new PianoRollLiveNotePreviewRuntime();
    const onStateChange = vi.fn();

    try {
      const preparation = runtime.prepare(client, createSelection(), onStateChange);
      await vi.advanceTimersByTimeAsync(
        PIANO_ROLL_LIVE_NOTE_PREPARE_RETRY_DELAYS_MS[0],
      );

      await expect(preparation).resolves.toBe(true);
      expect(controlSoundFontLivePreview).toHaveBeenCalledTimes(2);
      expect(onStateChange).toHaveBeenCalledWith({
        message: expect.stringContaining('Retrying Note Preview automatically.'),
        status: 'PREPARING',
      });
      expect(onStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'READY' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for an unadopted preparation to close its late host before stopping', async () => {
    type PreviewResult = Awaited<
      ReturnType<LocalEngineClient['controlSoundFontLivePreview']>
    >;
    let resolvePreparation!: (result: PreviewResult) => void;
    const controlSoundFontLivePreview = vi.fn((request) =>
      request.action === 'prepare'
        ? new Promise<PreviewResult>((resolve) => {
            resolvePreparation = resolve;
          })
        : Promise.resolve({
            ok: true as const,
            snapshot: { status: 'STOPPED' as const },
          }),
    );
    const client = { controlSoundFontLivePreview } as unknown as LocalEngineClient;
    const runtime = new PianoRollLiveNotePreviewRuntime();
    const preparation = runtime.prepare(client, createSelection(), vi.fn());
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    resolvePreparation({
      ok: true,
      snapshot: {
        bank: 0,
        program: 0,
        resourceId: createSelection().resource.resourceId,
        sessionId,
        status: 'READY',
      },
    });

    await expect(preparation).resolves.toBe(false);
    await stopping;
    expect(controlSoundFontLivePreview).toHaveBeenLastCalledWith({
      action: 'stop',
      sessionId,
    });
    expect(stopped).toBe(true);
  });

  it('keeps a shared startup session alive when an effect replay adopts it', async () => {
    type PreviewResult = Awaited<
      ReturnType<LocalEngineClient['controlSoundFontLivePreview']>
    >;
    let resolvePreparation!: (result: PreviewResult) => void;
    const sharedPreparation = new Promise<PreviewResult>((resolve) => {
      resolvePreparation = resolve;
    });
    const controlSoundFontLivePreview = vi.fn((request) => {
      if (request.action === 'prepare') {
        return sharedPreparation;
      }

      if (request.action === 'trigger') {
        return Promise.resolve({
          ok: true as const,
          snapshot: {
            pitch: request.pitch,
            sessionId,
            status: 'TRIGGERED' as const,
          },
        });
      }

      return Promise.resolve({
        ok: true as const,
        snapshot: { status: 'STOPPED' as const },
      });
    });
    const client = { controlSoundFontLivePreview } as unknown as LocalEngineClient;
    const runtime = new PianoRollLiveNotePreviewRuntime();
    const onStateChange = vi.fn();
    const selection = createSelection();

    const firstPreparation = runtime.prepare(client, selection, onStateChange);
    const stopping = runtime.stop(onStateChange);
    const adoptedPreparation = runtime.prepare(client, selection, onStateChange);
    resolvePreparation({
      ok: true,
      snapshot: {
        bank: selection.bank,
        program: selection.program,
        resourceId: selection.resource.resourceId,
        sessionId,
        status: 'READY',
      },
    });
    await stopping;

    await expect(firstPreparation).resolves.toBe(false);
    await expect(adoptedPreparation).resolves.toBe(true);
    await expect(runtime.trigger(60, 100, onStateChange)).resolves.toBe(true);
    expect(
      controlSoundFontLivePreview.mock.calls.filter(
        ([request]) => request.action === 'stop',
      ),
    ).toHaveLength(0);
    expect(controlSoundFontLivePreview).toHaveBeenLastCalledWith({
      action: 'trigger',
      durationMs: PIANO_ROLL_LIVE_NOTE_DURATION_MS,
      pitch: 60,
      sessionId,
      velocity: 100,
    });
  });
});

function createSelection() {
  return {
    bank: 0,
    program: 0,
    resource: {
      format: 'sf3' as const,
      lastModifiedAt: '2026-08-22T00:00:00.000Z',
      library: 'builtin' as const,
      name: 'MuseScore_General.sf3',
      relativePath: 'soundfonts/HumStudio Default/MuseScore_General.sf3',
      resourceId: `soundfont-${'a'.repeat(32)}`,
      revisionToken: 'b'.repeat(64),
      sizeBytes: 39_900_972,
      status: 'AVAILABLE' as const,
    },
  };
}
