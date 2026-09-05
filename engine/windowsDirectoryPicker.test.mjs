import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

import {
  resolveWindowsDirectoryPickerExecutablePath,
  runPickerProcess,
  selectWindowsProjectRoot,
  WINDOWS_DIRECTORY_PICKER_EXECUTABLE_PATH,
} from './windowsDirectoryPicker.mjs';

describe('selectWindowsProjectRoot', () => {
  it('uses an absolute production helper override without changing the development fallback', () => {
    expect(resolveWindowsDirectoryPickerExecutablePath({})).toBe(
      WINDOWS_DIRECTORY_PICKER_EXECUTABLE_PATH,
    );
    expect(
      resolveWindowsDirectoryPickerExecutablePath({
        HUMSTUDIO_DIRECTORY_PICKER_PATH: 'C:\\ElpisDAW\\native\\HumStudio.DirectoryPicker.exe',
      }),
    ).toBe('C:\\ElpisDAW\\native\\HumStudio.DirectoryPicker.exe');
    expect(() =>
      resolveWindowsDirectoryPickerExecutablePath({
        HUMSTUDIO_DIRECTORY_PICKER_PATH: 'native/HumStudio.DirectoryPicker.exe',
      }),
    ).toThrow('ElpisDAW directory picker path must be absolute.');
  });

  it('runs the native Windows picker and returns the selected path', async () => {
    const runPicker = vi.fn(async (executablePath) => {
      expect(executablePath).toBe(WINDOWS_DIRECTORY_PICKER_EXECUTABLE_PATH);
      return {
        exitCode: 0,
        stderr: '',
        stdout: '  D:\\HumStudioProjects\\MicTest  ',
      };
    });

    await expect(
      selectWindowsProjectRoot({ platform: 'win32', runPicker }),
    ).resolves.toBe('D:\\HumStudioProjects\\MicTest');
    expect(runPicker).toHaveBeenCalledOnce();
  });

  it('returns undefined when the picker is canceled', async () => {
    await expect(
      selectWindowsProjectRoot({
        platform: 'win32',
        runPicker: async () => ({ exitCode: 2, stderr: '', stdout: '' }),
      }),
    ).resolves.toBeUndefined();
  });

  it('reports picker process failures and empty successful output', async () => {
    await expect(
      selectWindowsProjectRoot({
        platform: 'win32',
        runPicker: async () => ({
          exitCode: 1,
          stderr: 'Picker failed.',
          stdout: '',
        }),
      }),
    ).rejects.toThrow('Picker failed.');
    await expect(
      selectWindowsProjectRoot({
        platform: 'win32',
        runPicker: async () => ({ exitCode: 0, stderr: '', stdout: '  ' }),
      }),
    ).rejects.toThrow('Project Root picker returned an empty path.');
  });

  it('rejects non-Windows platforms before spawning a picker', async () => {
    const runPicker = vi.fn();

    await expect(
      selectWindowsProjectRoot({ platform: 'linux', runPicker }),
    ).rejects.toThrow('currently requires Windows');
    expect(runPicker).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')(
    'loads the real Windows Common Item Dialog helper',
    async () => {
      if (!existsSync(WINDOWS_DIRECTORY_PICKER_EXECUTABLE_PATH)) {
        return;
      }

      await expect(
        runPickerProcess(
          WINDOWS_DIRECTORY_PICKER_EXECUTABLE_PATH,
          ['--smoke-test'],
        ),
      ).resolves.toMatchObject({ exitCode: 0, stderr: '', stdout: 'READY' });
    },
  );
});
