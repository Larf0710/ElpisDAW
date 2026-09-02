import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { serializeJsonFile, writeTextAtomically } from './atomicFileWriter.mjs';

export const PROJECT_ROOT_DIRECTORIES = Object.freeze([
  'recordings',
  'renders/instruments',
  'renders/stable-audio-3',
  'renders/ace-step',
  'renders/ace-step/lyrics',
  'mixdowns',
  'print-mixes',
  'stem-prints',
  'exports',
  'soundfonts',
]);

const UNSET_PROJECT_ROOT = Object.freeze({ status: 'UNSET' });
const PROJECT_ROOT_STATE_VERSION = 1;

export class ProjectRootAuthority {
  #provisionProjectRoot;
  #snapshot = UNSET_PROJECT_ROOT;
  #stateFilePath;

  constructor({ provisionProjectRoot, stateFilePath } = {}) {
    if (
      stateFilePath !== undefined &&
      (typeof stateFilePath !== 'string' ||
        stateFilePath.trim().length === 0 ||
        !isAbsolute(stateFilePath))
    ) {
      throw new Error('Project Root stateFilePath must be an absolute path when provided.');
    }
    if (
      provisionProjectRoot !== undefined &&
      typeof provisionProjectRoot !== 'function'
    ) {
      throw new TypeError('Project Root provisionProjectRoot must be a function when provided.');
    }

    this.#provisionProjectRoot = provisionProjectRoot;
    this.#stateFilePath = stateFilePath?.trim();
  }

  getSnapshot() {
    return this.#snapshot;
  }

  async restore() {
    if (!this.#stateFilePath) {
      return this.#snapshot;
    }

    let rawState;

    try {
      rawState = await readFile(this.#stateFilePath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return this.#snapshot;
      }

      return this.#setRecoveryIssue(error);
    }

    try {
      const storedState = parseStoredProjectRootState(rawState);
      this.#snapshot = await prepareProjectRootSnapshot(
        storedState.rootPath,
        storedState.configuredAt,
        this.#provisionProjectRoot,
      );
    } catch (error) {
      return this.#setRecoveryIssue(error);
    }

    return this.#snapshot;
  }

  async configure(selectedPath) {
    const nextSnapshot = await prepareProjectRootSnapshot(
      selectedPath,
      new Date().toISOString(),
      this.#provisionProjectRoot,
    );

    if (this.#stateFilePath) {
      await writeTextAtomically(
        this.#stateFilePath,
        serializeJsonFile({
          app: 'HumStudio Local Engine',
          projectRoot: {
            configuredAt: nextSnapshot.configuredAt,
            rootPath: nextSnapshot.rootPath,
          },
          version: PROJECT_ROOT_STATE_VERSION,
        }),
      );
    }

    this.#snapshot = nextSnapshot;

    return this.#snapshot;
  }

  recordProjectFileSave({ bytesWritten, lastModifiedAt, projectFilePath }) {
    if (this.#snapshot.status !== 'READY') {
      throw new Error('Cannot record a Project file without a ready Project Root.');
    }

    const expectedPath = resolveProjectPath(
      this.#snapshot.rootPath,
      this.#snapshot.projectFileName,
    );

    if (projectFilePath !== expectedPath) {
      throw new Error('Saved Project file does not match the active Project Root.');
    }

    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      projectFile: Object.freeze({
        lastModifiedAt,
        path: projectFilePath,
        sizeBytes: bytesWritten,
        status: 'EXISTS',
      }),
    });

    return this.#snapshot;
  }

  #setRecoveryIssue(error) {
    this.#snapshot = Object.freeze({
      recoveryIssue: `Stored Project Root could not be restored: ${
        error instanceof Error ? error.message : String(error)
      }`,
      status: 'UNSET',
    });
    return this.#snapshot;
  }
}

export function resolveDefaultProjectRootStateFilePath({
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  platform = process.platform,
} = {}) {
  const stateRoot =
    typeof localAppData === 'string' && localAppData.trim().length > 0
      ? localAppData.trim()
      : platform === 'win32'
        ? join(homeDirectory, 'AppData', 'Local')
        : join(homeDirectory, '.local', 'state');

  return resolve(stateRoot, 'HumStudio', 'project-root.json');
}

export async function resolveCanonicalDirectory(selectedPath) {
  if (typeof selectedPath !== 'string' || selectedPath.trim().length === 0) {
    throw new TypeError('Project Root selection must return a directory path.');
  }

  const trimmedPath = selectedPath.trim();

  if (!isAbsolute(trimmedPath)) {
    throw new Error('Project Root must resolve to an absolute path.');
  }

  const resolvedPath = resolve(trimmedPath);
  const canonicalPath = await realpath(resolvedPath);
  const selectedStat = await stat(canonicalPath);

  if (!selectedStat.isDirectory()) {
    throw new Error('Project Root must be an existing directory.');
  }

  return canonicalPath;
}

export function resolveProjectPath(rootPath, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new Error('Project-relative paths must be non-empty and relative.');
  }

  const targetPath = resolve(rootPath, relativePath);
  assertPathWithinRoot(rootPath, targetPath);
  return targetPath;
}

async function prepareProjectRootSnapshot(
  selectedPath,
  configuredAt,
  provisionProjectRoot,
) {
  if (typeof configuredAt !== 'string' || Number.isNaN(Date.parse(configuredAt))) {
    throw new Error('Stored Project Root configuredAt is invalid.');
  }

  const rootPath = await resolveCanonicalDirectory(selectedPath);

  for (const relativePath of PROJECT_ROOT_DIRECTORIES) {
    const targetPath = resolveProjectPath(rootPath, relativePath);
    await mkdir(targetPath, { recursive: true });
    const canonicalTargetPath = await realpath(targetPath);
    assertPathWithinRoot(rootPath, canonicalTargetPath);
  }

  if (provisionProjectRoot) {
    await provisionProjectRoot({ rootPath });
  }

  const rootName = basename(rootPath) || 'ElpisDAW Project';
  const projectFileName = `${rootName}.humstudio.json`;
  const projectFile = await inspectProjectFile(rootPath, projectFileName);

  return Object.freeze({
    configuredAt,
    directories: PROJECT_ROOT_DIRECTORIES,
    projectFile,
    projectFileName,
    rootName,
    rootPath,
    status: 'READY',
  });
}

async function inspectProjectFile(rootPath, projectFileName) {
  const projectFilePath = resolveProjectPath(rootPath, projectFileName);

  try {
    const projectFileStat = await stat(projectFilePath);

    if (!projectFileStat.isFile()) {
      throw new Error('Project JSON path exists but is not a regular file.');
    }

    return Object.freeze({
      lastModifiedAt: projectFileStat.mtime.toISOString(),
      path: projectFilePath,
      sizeBytes: projectFileStat.size,
      status: 'EXISTS',
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return Object.freeze({ status: 'MISSING' });
    }

    throw error;
  }
}

function parseStoredProjectRootState(rawState) {
  let value;

  try {
    value = JSON.parse(rawState);
  } catch {
    throw new Error('Project Root state is not valid JSON.');
  }

  if (
    !isRecord(value) ||
    value.app !== 'HumStudio Local Engine' ||
    value.version !== PROJECT_ROOT_STATE_VERSION ||
    !isRecord(value.projectRoot) ||
    typeof value.projectRoot.configuredAt !== 'string' ||
    typeof value.projectRoot.rootPath !== 'string'
  ) {
    throw new Error('Project Root state has an unsupported structure.');
  }

  return value.projectRoot;
}

function assertPathWithinRoot(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);

  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return;
  }

  throw new Error('Resolved Project path escapes the Project Root.');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value) {
  return value instanceof Error && 'code' in value;
}
