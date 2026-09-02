import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
  ACE_STEP_PROVIDER_CODE_REVISION,
  ACE_STEP_PROVIDER_REPOSITORY,
  ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE,
  ACE_STEP_SUPPORT_MODEL_REPOSITORY,
  ACE_STEP_SUPPORT_MODEL_REVISION,
} from '../engine/providers/aceStepRuntimeProfile.mjs';

const defaultLocalAppDataRoot =
  typeof process.env.LOCALAPPDATA === 'string' &&
  isAbsolute(process.env.LOCALAPPDATA)
    ? process.env.LOCALAPPDATA
    : process.cwd();

export const DEFAULT_HUMSTUDIO_AI_CACHE_ROOT = join(
  defaultLocalAppDataRoot,
  'ElpisDAW',
  'AI_CACHE',
);

export async function resolveHumStudioAceStepRuntime({
  aiCacheRoot = DEFAULT_HUMSTUDIO_AI_CACHE_ROOT,
  environment = process.env,
} = {}) {
  if (typeof aiCacheRoot !== 'string' || !isAbsolute(aiCacheRoot)) {
    throw new TypeError('ElpisDAW AI Cache Root must be an absolute path.');
  }
  if (typeof environment !== 'object' || environment === null) {
    throw new TypeError('ElpisDAW launcher environment must be an object.');
  }

  const configuredPythonPath = readConfiguredPath(
    environment,
    ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE,
  );
  const configuredCheckpointsRootPath = readConfiguredPath(
    environment,
    ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
  );

  if (Boolean(configuredPythonPath) !== Boolean(configuredCheckpointsRootPath)) {
    throw new Error(
      `${ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE} and ` +
        `${ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE} must be configured together.`,
    );
  }

  const usesConfiguredEnvironment = Boolean(configuredPythonPath);
  const pythonPath =
    configuredPythonPath ??
    join(
      aiCacheRoot,
      'runtimes',
      'HumStudio',
      repositoryFolderName(ACE_STEP_PROVIDER_REPOSITORY),
      ACE_STEP_PROVIDER_CODE_REVISION,
      'Scripts',
      'python.exe',
    );
  const checkpointsRootPath =
    configuredCheckpointsRootPath ??
    join(
      aiCacheRoot,
      'models',
      'HumStudio',
      repositoryFolderName(ACE_STEP_SUPPORT_MODEL_REPOSITORY),
      ACE_STEP_SUPPORT_MODEL_REVISION,
    );

  try {
    const [canonicalPythonPath, canonicalCheckpointsRootPath] = await Promise.all([
      validateRegularFile(pythonPath, 'ACE-Step Python executable'),
      validateDirectory(checkpointsRootPath, 'ACE-Step Checkpoints Root'),
    ]);

    return Object.freeze({
      checkpointsRootPath: canonicalCheckpointsRootPath,
      pythonPath: canonicalPythonPath,
      source: usesConfiguredEnvironment ? 'environment' : 'ai-cache',
      status: 'configured',
    });
  } catch (error) {
    if (usesConfiguredEnvironment) {
      throw error;
    }

    return Object.freeze({
      message:
        'Pinned ACE-Step runtime was not found in the ElpisDAW AI Cache. ' +
        'ACE Vocals will remain unavailable until the runtime is installed or both ACE-Step paths are configured.',
      status: 'unavailable',
    });
  }
}

function readConfiguredPath(environment, name) {
  const value = environment[name];

  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path when configured.`);
  }

  return value;
}

function repositoryFolderName(repository) {
  const segments = repository.split('/').filter(Boolean);
  const name = segments.at(-1);

  if (!name) {
    throw new Error('ACE-Step repository identity is invalid.');
  }

  return name;
}

async function validateRegularFile(path, label) {
  try {
    const canonicalPath = await realpath(path);
    const stats = await lstat(canonicalPath);

    if (!stats.isFile()) {
      throw new Error(`${label} is not a regular file.`);
    }

    return canonicalPath;
  } catch (error) {
    throw new Error(`${label} is unavailable at ${path}`, { cause: error });
  }
}

async function validateDirectory(path, label) {
  try {
    const canonicalPath = await realpath(path);
    const stats = await lstat(canonicalPath);

    if (!stats.isDirectory()) {
      throw new Error(`${label} is not a directory.`);
    }

    return canonicalPath;
  } catch (error) {
    throw new Error(`${label} is unavailable at ${path}`, { cause: error });
  }
}

function parseArguments(argv) {
  if (argv.length === 0) {
    return {};
  }
  if (argv.length === 2 && argv[0] === '--ai-cache-root') {
    return { aiCacheRoot: argv[1] };
  }

  throw new Error(
    'Usage: node scripts/Resolve-HumStudioAceStepRuntime.mjs [--ai-cache-root <absolute-path>]',
  );
}

async function main() {
  const result = await resolveHumStudioAceStepRuntime(
    parseArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entryPath = process.argv[1];

if (entryPath && pathToFileURL(entryPath).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'ACE-Step runtime resolution failed.'}\n`,
    );
    process.exitCode = 1;
  });
}
