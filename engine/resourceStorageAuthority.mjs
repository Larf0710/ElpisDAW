import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import {
  STABLE_AUDIO_3_MODEL_REVISION,
} from '../shared/stableAudio3Protocol.js';
import { serializeJsonFile, writeTextAtomically } from './atomicFileWriter.mjs';
import { ACE_STEP_SUPPORT_MODEL_REVISION } from './providers/aceStepRuntimeProfile.mjs';

export const AI_MODEL_LIBRARY_DIRECTORIES = Object.freeze([
  'stable-audio-3',
  'ace-step',
  'loras',
]);

export const ELPISDAW_DATA_ROOT_ENVIRONMENT_VARIABLE = 'ELPISDAW_DATA_ROOT';

const STORAGE_STATE_VERSION = 2;

export class ResourceStorageAuthority {
  #applicationRootPath;
  #paths;
  #snapshot;

  constructor({
    applicationRootPath,
    paths = resolveDefaultResourceStoragePaths(),
  } = {}) {
    validateStoragePaths(paths);

    if (
      applicationRootPath !== undefined &&
      (typeof applicationRootPath !== 'string' || !isAbsolute(applicationRootPath))
    ) {
      throw new Error('ElpisDAW applicationRootPath must be absolute when provided.');
    }

    this.#applicationRootPath = applicationRootPath
      ? resolve(applicationRootPath)
      : undefined;
    this.#paths = Object.freeze({ ...paths });
    this.#snapshot = createStorageSnapshot(this.#paths);
  }

  getSnapshot() {
    return this.#snapshot;
  }

  async restore() {
    await provisionFixedResourceDirectories(this.#paths);

    let rawState;

    try {
      rawState = await readFile(this.#paths.stateFilePath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        this.#snapshot = createStorageSnapshot(this.#paths);
        return this.#snapshot;
      }

      return this.#setRecoveryIssue(error);
    }

    try {
      const storedState = parseStoredStorageState(rawState);

      if (storedState.mode === 'PORTABLE') {
        await mkdir(this.#paths.aiModelLibraryPath, { recursive: true });
      }

      this.#snapshot = await prepareStorageSnapshot({
        applicationRootPath: this.#applicationRootPath,
        configuredAt: storedState.configuredAt,
        mode: storedState.mode,
        paths: this.#paths,
        selectedPath:
          storedState.mode === 'PORTABLE'
            ? this.#paths.aiModelLibraryPath
            : storedState.rootPath,
        verifyWritable: false,
      });
    } catch (error) {
      return this.#setRecoveryIssue(error);
    }

    return this.#snapshot;
  }

  async configureAiModelLibrary(selectedPath) {
    await provisionFixedResourceDirectories(this.#paths);
    const nextSnapshot = await prepareStorageSnapshot({
      applicationRootPath: this.#applicationRootPath,
      configuredAt: new Date().toISOString(),
      mode: 'EXTERNAL',
      paths: this.#paths,
      selectedPath,
      verifyWritable: true,
    });

    await this.#writeStorageState(nextSnapshot);

    this.#snapshot = nextSnapshot;
    return this.#snapshot;
  }

  async configurePortableAiModelLibrary() {
    await provisionFixedResourceDirectories(this.#paths);
    await mkdir(this.#paths.aiModelLibraryPath, { recursive: true });
    const nextSnapshot = await prepareStorageSnapshot({
      applicationRootPath: this.#applicationRootPath,
      configuredAt: new Date().toISOString(),
      mode: 'PORTABLE',
      paths: this.#paths,
      selectedPath: this.#paths.aiModelLibraryPath,
      verifyWritable: true,
    });

    await this.#writeStorageState(nextSnapshot);

    this.#snapshot = nextSnapshot;
    return this.#snapshot;
  }

  async #writeStorageState(snapshot) {
    const aiModelLibrary = {
      configuredAt: snapshot.aiModelLibrary.configuredAt,
      mode: snapshot.aiModelLibrary.mode,
      ...(snapshot.aiModelLibrary.mode === 'EXTERNAL'
        ? { rootPath: snapshot.aiModelLibrary.rootPath }
        : {}),
    };

    await writeTextAtomically(
      this.#paths.stateFilePath,
      serializeJsonFile({
        aiModelLibrary,
        app: 'ElpisDAW',
        version: STORAGE_STATE_VERSION,
      }),
    );
  }

  #setRecoveryIssue(error) {
    this.#snapshot = createStorageSnapshot(
      this.#paths,
      `Stored AI Model Library could not be restored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return this.#snapshot;
  }
}

export function resolveDefaultResourceStoragePaths({
  dataRoot = process.env[ELPISDAW_DATA_ROOT_ENVIRONMENT_VARIABLE],
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  platform = process.platform,
} = {}) {
  const configuredDataRoot =
    typeof dataRoot === 'string' && dataRoot.trim().length > 0
      ? dataRoot.trim()
      : undefined;

  if (configuredDataRoot !== undefined && !isAbsolute(configuredDataRoot)) {
    throw new Error('ElpisDAW ELPISDAW_DATA_ROOT must be an absolute path when provided.');
  }

  const configuredLocalAppData =
    typeof localAppData === 'string' && localAppData.trim().length > 0
      ? localAppData.trim()
      : undefined;

  if (configuredLocalAppData !== undefined && !isAbsolute(configuredLocalAppData)) {
    throw new Error('ElpisDAW LOCALAPPDATA must be an absolute path when provided.');
  }

  const localStateRoot =
    configuredLocalAppData !== undefined
      ? configuredLocalAppData
      : platform === 'win32'
        ? join(homeDirectory, 'AppData', 'Local')
        : join(homeDirectory, '.local', 'state');
  const appDataRoot = configuredDataRoot
    ? resolve(configuredDataRoot)
    : resolve(localStateRoot, 'ElpisDAW');

  return Object.freeze({
    appDataRoot,
    aiModelLibraryPath: join(appDataRoot, 'Models'),
    basicPitchRuntimePath: join(appDataRoot, 'Runtimes', 'BasicPitch'),
    fluidSynthRuntimePath: join(appDataRoot, 'Runtimes', 'FluidSynth'),
    soundFontsPath: join(appDataRoot, 'Resources', 'SoundFonts'),
    stateFilePath: join(appDataRoot, 'UserData', 'storage.json'),
  });
}

async function provisionFixedResourceDirectories(paths) {
  await Promise.all([
    mkdir(paths.basicPitchRuntimePath, { recursive: true }),
    mkdir(paths.fluidSynthRuntimePath, { recursive: true }),
    mkdir(paths.soundFontsPath, { recursive: true }),
  ]);
}

async function prepareStorageSnapshot({
  applicationRootPath,
  configuredAt,
  mode,
  paths,
  selectedPath,
  verifyWritable,
}) {
  if (typeof configuredAt !== 'string' || Number.isNaN(Date.parse(configuredAt))) {
    throw new Error('Stored AI Model Library configuredAt is invalid.');
  }

  if (mode !== 'PORTABLE' && mode !== 'EXTERNAL') {
    throw new Error('Stored AI Model Library mode is invalid.');
  }

  const rootPath = await resolveCanonicalModelDirectory(selectedPath);
  const managedResourceRootPath = await realpath(paths.appDataRoot);

  if (mode === 'PORTABLE') {
    const portableModelRootPath = await realpath(paths.aiModelLibraryPath);

    if (!pathsEqual(rootPath, portableModelRootPath)) {
      throw new Error('Portable AI Model Library must use the ElpisDAW data root.');
    }
  } else {
    assertStorageSeparation(
      rootPath,
      managedResourceRootPath,
      'ElpisDAW managed resource root',
    );
  }

  if (applicationRootPath) {
    const canonicalApplicationRootPath = await realpath(applicationRootPath);
    assertStorageSeparation(
      rootPath,
      canonicalApplicationRootPath,
      'ElpisDAW application root',
    );
  }

  if (verifyWritable) {
    await verifyDirectoryWritable(rootPath);
  }

  const directoryEntries = [
    ['aceStep', 'ace-step', ACE_STEP_SUPPORT_MODEL_REVISION],
    ['loras', 'loras'],
    ['stableAudio3', 'stable-audio-3', STABLE_AUDIO_3_MODEL_REVISION],
  ];
  const directories = {};

  for (const [key, ...segments] of directoryEntries) {
    const targetPath = resolve(rootPath, ...segments);
    assertPathWithinRoot(rootPath, targetPath);
    await mkdir(targetPath, { recursive: true });
    const canonicalTargetPath = await realpath(targetPath);
    assertPathWithinRoot(rootPath, canonicalTargetPath);
    directories[key] = canonicalTargetPath;
  }

  return createStorageSnapshot(paths, undefined, {
    configuredAt,
    directories: Object.freeze(directories),
    mode,
    rootPath,
    status: 'READY',
  });
}

async function resolveCanonicalModelDirectory(selectedPath) {
  if (typeof selectedPath !== 'string' || selectedPath.trim().length === 0) {
    throw new TypeError('AI Model Library selection must return a directory path.');
  }

  const trimmedPath = selectedPath.trim();

  if (!isAbsolute(trimmedPath)) {
    throw new Error('AI Model Library must resolve to an absolute path.');
  }

  const resolvedPath = resolve(trimmedPath);
  const selectedStat = await lstat(resolvedPath);

  if (selectedStat.isSymbolicLink()) {
    throw new Error('AI Model Library cannot be a symbolic link or junction.');
  }

  if (!selectedStat.isDirectory()) {
    throw new Error('AI Model Library must be an existing directory.');
  }

  await assertPathDoesNotTraverseSymbolicLinkOrJunction(resolvedPath);

  return realpath(resolvedPath);
}

async function assertPathDoesNotTraverseSymbolicLinkOrJunction(resolvedPath) {
  const rootPath = parse(resolvedPath).root;
  const pathSegments = relative(rootPath, resolvedPath)
    .split(sep)
    .filter(Boolean);
  let currentPath = rootPath;

  for (const pathSegment of pathSegments) {
    currentPath = join(currentPath, pathSegment);
    const pathStat = await lstat(currentPath);

    if (pathStat.isSymbolicLink()) {
      throw new Error('AI Model Library cannot resolve through a symbolic link or junction.');
    }
  }
}

async function verifyDirectoryWritable(rootPath) {
  const probePath = join(
    rootPath,
    `.elpisdaw-write-probe-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle;

  try {
    handle = await open(probePath, 'wx', 0o600);
    await handle.writeFile('ElpisDAW storage probe\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }

    throw new Error(
      `AI Model Library is not writable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await unlink(probePath).catch(() => undefined);
  }
}

function createStorageSnapshot(paths, recoveryIssue, aiModelLibrary) {
  return Object.freeze({
    aiModelLibrary:
      aiModelLibrary ??
      Object.freeze({
        ...(recoveryIssue ? { recoveryIssue } : {}),
        status: 'UNSET',
      }),
    fixedResources: Object.freeze({
      basicPitchRuntime: Object.freeze({
        path: paths.basicPitchRuntimePath,
        policy: 'APP_MANAGED',
      }),
      fluidSynthRuntime: Object.freeze({
        path: paths.fluidSynthRuntimePath,
        policy: 'APP_MANAGED',
      }),
      soundFonts: Object.freeze({
        path: paths.soundFontsPath,
        policy: 'APP_MANAGED',
      }),
    }),
    portableAiModelLibraryPath: paths.aiModelLibraryPath,
    policyVersion: STORAGE_STATE_VERSION,
  });
}

function parseStoredStorageState(rawState) {
  let value;

  try {
    value = JSON.parse(rawState);
  } catch {
    throw new Error('Storage state is not valid JSON.');
  }

  if (!isRecord(value) || value.app !== 'ElpisDAW' || !isRecord(value.aiModelLibrary)) {
    throw new Error('Storage state has an unsupported structure.');
  }

  if (
    value.version === 1 &&
    typeof value.aiModelLibrary.configuredAt === 'string' &&
    typeof value.aiModelLibrary.rootPath === 'string'
  ) {
    return Object.freeze({
      configuredAt: value.aiModelLibrary.configuredAt,
      mode: 'EXTERNAL',
      rootPath: value.aiModelLibrary.rootPath,
    });
  }

  if (
    value.version !== STORAGE_STATE_VERSION ||
    typeof value.aiModelLibrary.configuredAt !== 'string' ||
    (value.aiModelLibrary.mode !== 'PORTABLE' &&
      value.aiModelLibrary.mode !== 'EXTERNAL') ||
    (value.aiModelLibrary.mode === 'EXTERNAL' &&
      typeof value.aiModelLibrary.rootPath !== 'string') ||
    (value.aiModelLibrary.mode === 'PORTABLE' &&
      value.aiModelLibrary.rootPath !== undefined)
  ) {
    throw new Error('Storage state has an unsupported structure.');
  }

  return value.aiModelLibrary;
}

function validateStoragePaths(paths) {
  const entries = [
    ['appDataRoot', paths?.appDataRoot],
    ['aiModelLibraryPath', paths?.aiModelLibraryPath],
    ['basicPitchRuntimePath', paths?.basicPitchRuntimePath],
    ['fluidSynthRuntimePath', paths?.fluidSynthRuntimePath],
    ['soundFontsPath', paths?.soundFontsPath],
    ['stateFilePath', paths?.stateFilePath],
  ];

  for (const [name, value] of entries) {
    if (typeof value !== 'string' || !isAbsolute(value)) {
      throw new Error(`ElpisDAW ${name} must be an absolute path.`);
    }
  }
}

function assertStorageSeparation(modelRootPath, protectedRootPath, label) {
  if (
    isPathWithinOrEqual(modelRootPath, protectedRootPath) ||
    isPathWithinOrEqual(protectedRootPath, modelRootPath)
  ) {
    throw new Error(`AI Model Library must be separate from the ${label}.`);
  }
}

function assertPathWithinRoot(rootPath, targetPath) {
  if (!isPathWithinOrEqual(rootPath, targetPath)) {
    throw new Error('Resolved AI Model Library path escapes its selected root.');
  }
}

function isPathWithinOrEqual(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function pathsEqual(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value) {
  return value instanceof Error && 'code' in value;
}
