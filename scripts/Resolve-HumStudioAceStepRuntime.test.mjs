import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  resolveHumStudioAceStepRuntime,
} from './Resolve-HumStudioAceStepRuntime.mjs';
import {
  ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
  ACE_STEP_PROVIDER_CODE_REVISION,
  ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE,
  ACE_STEP_SUPPORT_MODEL_REVISION,
} from '../engine/providers/aceStepRuntimeProfile.mjs';

describe('HumStudio ACE-Step launcher runtime resolution', () => {
  it('resolves the pinned runtime and Checkpoints Root from the AI Cache', async () => {
    const aiCacheRoot = await mkdtemp(join(tmpdir(), 'humstudio-ace-launcher-'));
    const expected = await createPinnedRuntime(aiCacheRoot);

    await expect(
      resolveHumStudioAceStepRuntime({ aiCacheRoot, environment: {} }),
    ).resolves.toEqual({
      checkpointsRootPath: await realpath(expected.checkpointsRootPath),
      pythonPath: await realpath(expected.pythonPath),
      source: 'ai-cache',
      status: 'configured',
    });
  });

  it('preserves one complete explicit environment pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'humstudio-ace-explicit-'));
    const pythonPath = join(root, 'python.exe');
    const checkpointsRootPath = join(root, 'checkpoints');
    await writeFile(pythonPath, 'fixture');
    await mkdir(checkpointsRootPath);

    await expect(
      resolveHumStudioAceStepRuntime({
        aiCacheRoot: root,
        environment: {
          [ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE]: checkpointsRootPath,
          [ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE]: pythonPath,
        },
      }),
    ).resolves.toEqual({
      checkpointsRootPath: await realpath(checkpointsRootPath),
      pythonPath: await realpath(pythonPath),
      source: 'environment',
      status: 'configured',
    });
  });

  it('rejects an incomplete explicit environment pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'humstudio-ace-incomplete-'));

    await expect(
      resolveHumStudioAceStepRuntime({
        aiCacheRoot: root,
        environment: {
          [ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE]: join(root, 'python.exe'),
        },
      }),
    ).rejects.toThrow('must be configured together');
  });

  it('keeps the launcher available when the optional cached runtime is absent', async () => {
    const aiCacheRoot = await mkdtemp(join(tmpdir(), 'humstudio-ace-missing-'));

    await expect(
      resolveHumStudioAceStepRuntime({ aiCacheRoot, environment: {} }),
    ).resolves.toMatchObject({
      status: 'unavailable',
    });
  });
});

async function createPinnedRuntime(aiCacheRoot) {
  const pythonPath = join(
    aiCacheRoot,
    'runtimes',
    'HumStudio',
    'ACE-Step-1.5',
    ACE_STEP_PROVIDER_CODE_REVISION,
    'Scripts',
    'python.exe',
  );
  const checkpointsRootPath = join(
    aiCacheRoot,
    'models',
    'HumStudio',
    'Ace-Step1.5',
    ACE_STEP_SUPPORT_MODEL_REVISION,
  );
  await mkdir(join(pythonPath, '..'), { recursive: true });
  await writeFile(pythonPath, 'fixture');
  await mkdir(checkpointsRootPath, { recursive: true });

  return { checkpointsRootPath, pythonPath };
}
