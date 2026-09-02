import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  FluidSynthLiveHostRuntime,
  FluidSynthLiveHostRuntimeError,
} from './fluidSynthLiveHostRuntime.mjs';

describe('FluidSynthLiveHostRuntime', () => {
  it('waits for READY and writes validated Note commands to one hidden host', async () => {
    const child = createChild();
    const commands = [];
    child.stdin.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      commands.push(text);
      if (text.includes('STOP')) {
        queueMicrotask(() => child.emit('close', 0));
      }
    });
    const spawnProcess = vi.fn(() => child);
    const runtime = new FluidSynthLiveHostRuntime({
      hostPath: 'D:\\Runtime\\HumStudio.FluidSynthLiveHost.exe',
      spawnProcess,
    });
    const started = runtime.start({
      bank: 0,
      program: 24,
      soundFontPath: 'D:\\SoundFonts\\Default.sf3',
    });
    child.stdout.write('READY\r\n');
    const session = await started;

    session.noteOn(60, 100);
    session.noteOff(60);
    await session.close();

    expect(spawnProcess).toHaveBeenCalledWith(
      'D:\\Runtime\\HumStudio.FluidSynthLiveHost.exe',
      [
        'D:\\SoundFonts\\Default.sf3',
        '0',
        '24',
        '0.2',
        '48000',
        String(process.pid),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    expect(commands.join('')).toContain('NOTE_ON\t60\t100\n');
    expect(commands.join('')).toContain('NOTE_OFF\t60\n');
    expect(commands.join('')).toContain('ALL_NOTES_OFF\nSTOP\n');
  });

  it('surfaces host startup failures without creating a session', async () => {
    const child = createChild();
    const runtime = new FluidSynthLiveHostRuntime({
      spawnProcess: () => child,
    });
    const started = runtime.start({
      bank: 0,
      program: 0,
      soundFontPath: 'D:\\SoundFonts\\Missing.sf3',
    });
    child.stderr.write('ERROR\tLIVE_HOST_FAILED\tSoundFont failed.\r\n');
    child.emit('close', 1);

    await expect(started).rejects.toMatchObject({
      code: 'FLUIDSYNTH_LIVE_HOST_START_FAILED',
      message: 'SoundFont failed.',
    });
  });

  it('rejects invalid Note values before writing to the host', async () => {
    const child = createChild();
    const runtime = new FluidSynthLiveHostRuntime({ spawnProcess: () => child });
    const started = runtime.start({
      bank: 0,
      program: 0,
      soundFontPath: 'D:\\SoundFonts\\Default.sf3',
    });
    child.stdout.write('READY\n');
    const session = await started;

    expect(() => session.noteOn(128, 100)).toThrow(FluidSynthLiveHostRuntimeError);
    queueMicrotask(() => child.emit('close', 0));
    await session.close();
  });
});

function createChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}
