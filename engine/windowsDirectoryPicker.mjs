import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const WINDOWS_DIRECTORY_PICKER_EXECUTABLE_PATH = join(
  moduleDirectory,
  'bin',
  'HumStudio.DirectoryPicker.exe',
);

export async function selectWindowsProjectRoot({
  platform = process.platform,
  runPicker = runPickerProcess,
  pickerExecutablePath = WINDOWS_DIRECTORY_PICKER_EXECUTABLE_PATH,
} = {}) {
  if (platform !== 'win32') {
    throw new Error('ElpisDAW Project Root selection currently requires Windows.');
  }

  const result = await runPicker(pickerExecutablePath);

  if (result.exitCode === 2) {
    return undefined;
  }

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Project Root picker exited with code ${result.exitCode}.`);
  }

  const selectedPath = result.stdout.trim();

  if (!selectedPath) {
    throw new Error('Project Root picker returned an empty path.');
  }

  return selectedPath;
}

export async function runPickerProcess(executablePath, pickerArguments = []) {
  if (!existsSync(executablePath)) {
    throw new Error(
      'ElpisDAW Windows directory picker is not built. Run pnpm build or the ElpisDAW Launcher.',
    );
  }

  const resultFilePath = join(
    tmpdir(),
    `humstudio-directory-picker-${process.pid}-${randomUUID()}.result`,
  );

  try {
    const exitCode = await new Promise((resolveProcess, rejectProcess) => {
      const child = spawn(
        executablePath,
        ['--result-file', resultFilePath, ...pickerArguments],
        {
          stdio: 'ignore',
          windowsHide: false,
        },
      );

      child.once('error', rejectProcess);
      child.once('close', (code) => {
        resolveProcess(code ?? 1);
      });
    });
    const result = await readPickerResult(resultFilePath);

    if (exitCode === 2 || result === 'CANCELED') {
      return { exitCode: 2, stderr: '', stdout: '' };
    }

    if (exitCode !== 0) {
      return {
        exitCode,
        stderr:
          result.startsWith('ERROR\n')
            ? result.slice('ERROR\n'.length).trim()
            : 'Windows directory picker failed without an error message.',
        stdout: '',
      };
    }

    if (result.startsWith('SELECTED\n')) {
      return {
        exitCode,
        stderr: '',
        stdout: result.slice('SELECTED\n'.length),
      };
    }

    return { exitCode, stderr: '', stdout: result };
  } finally {
    await unlink(resultFilePath).catch(() => undefined);
  }
}

async function readPickerResult(resultFilePath) {
  try {
    return await readFile(resultFilePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}
