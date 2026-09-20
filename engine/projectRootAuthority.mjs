import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
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
export const PROJECT_ROOT_MARKER_FILE_NAME = '.elpisdaw-project-root.json';

const UNSET_PROJECT_ROOT = Object.freeze({ status: 'UNSET' });
const PROJECT_ROOT_STATE_VERSION = 1;
const PROJECT_ROOT_MARKER_VERSION = 1;
const MAX_PROJECT_ROOT_MARKER_BYTES = 4 * 1024;
const MAX_LEGACY_PROJECT_FILE_BYTES = 16 * 1024 * 1024;
const PROJECT_ROOT_MARKER = Object.freeze({
  app: 'ElpisDAW',
  kind: 'project-root',
  version: PROJECT_ROOT_MARKER_VERSION,
});
const PROJECT_ROOT_SELECTION_GUIDANCE =
  'This folder contains files but is not a recognized ElpisDAW Project Root. Choose a new empty folder or an existing ElpisDAW Project Root.';

export class ProjectRootSelectionError extends Error {}

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
  dataRoot = process.env.ELPISDAW_DATA_ROOT,
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  platform = process.platform,
} = {}) {
  const configuredDataRoot =
    typeof dataRoot === 'string' && dataRoot.trim().length > 0
      ? dataRoot.trim()
      : undefined;

  if (configuredDataRoot !== undefined) {
    if (!isAbsolute(configuredDataRoot)) {
      throw new Error('ElpisDAW ELPISDAW_DATA_ROOT must be an absolute path when provided.');
    }

    return resolve(configuredDataRoot, 'UserData', 'project-root.json');
  }

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
  const rootName = basename(rootPath) || 'ElpisDAW Project';
  const projectFileName = `${rootName}.humstudio.json`;
  const rootKind = await classifyProjectRoot(rootPath, projectFileName);
  await validateExistingManagedLayout(rootPath);

  for (const relativePath of PROJECT_ROOT_DIRECTORIES) {
    const targetPath = resolveProjectPath(rootPath, relativePath);
    await mkdir(targetPath, { recursive: true });
    const canonicalTargetPath = await realpath(targetPath);
    assertPathWithinRoot(rootPath, canonicalTargetPath);
  }

  if (provisionProjectRoot) {
    await provisionProjectRoot({ rootPath });
  }

  if (rootKind !== 'MARKED') {
    await writeTextAtomically(
      resolveProjectPath(rootPath, PROJECT_ROOT_MARKER_FILE_NAME),
      serializeJsonFile(PROJECT_ROOT_MARKER),
    );
  }

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

async function classifyProjectRoot(rootPath, projectFileName) {
  const entries = await readdir(rootPath, { withFileTypes: true });

  if (entries.length === 0) {
    return 'NEW';
  }

  if (entries.some((entry) => entry.name === PROJECT_ROOT_MARKER_FILE_NAME)) {
    await validateProjectRootMarker(rootPath);
    return 'MARKED';
  }

  if (entries.some((entry) => entry.name === projectFileName)) {
    await validateLegacyProjectFile(rootPath, projectFileName);
    return 'LEGACY';
  }

  if (await hasCompleteLegacyProjectLayout(rootPath, entries)) {
    return 'LEGACY';
  }

  throw new ProjectRootSelectionError(PROJECT_ROOT_SELECTION_GUIDANCE);
}

async function validateProjectRootMarker(rootPath) {
  const markerPath = resolveProjectPath(rootPath, PROJECT_ROOT_MARKER_FILE_NAME);
  const markerStat = await lstat(markerPath);

  if (
    markerStat.isSymbolicLink() ||
    !markerStat.isFile() ||
    markerStat.size > MAX_PROJECT_ROOT_MARKER_BYTES
  ) {
    throw new ProjectRootSelectionError('Project Root marker is invalid or unsupported.');
  }

  const canonicalMarkerPath = await realpath(markerPath);
  assertPathWithinRoot(rootPath, canonicalMarkerPath);
  let marker;

  try {
    marker = JSON.parse(await readFile(canonicalMarkerPath, 'utf8'));
  } catch {
    throw new ProjectRootSelectionError('Project Root marker is invalid or unsupported.');
  }

  if (
    !isRecord(marker) ||
    marker.app !== PROJECT_ROOT_MARKER.app ||
    marker.kind !== PROJECT_ROOT_MARKER.kind ||
    marker.version !== PROJECT_ROOT_MARKER.version
  ) {
    throw new ProjectRootSelectionError('Project Root marker is invalid or unsupported.');
  }
}

async function validateLegacyProjectFile(rootPath, projectFileName) {
  const projectFilePath = resolveProjectPath(rootPath, projectFileName);
  const projectFileStat = await lstat(projectFilePath);

  if (
    projectFileStat.isSymbolicLink() ||
    !projectFileStat.isFile() ||
    projectFileStat.size > MAX_LEGACY_PROJECT_FILE_BYTES
  ) {
    throw new ProjectRootSelectionError('Legacy Project JSON is invalid or unsupported.');
  }

  const canonicalProjectFilePath = await realpath(projectFilePath);
  assertPathWithinRoot(rootPath, canonicalProjectFilePath);
  let projectFile;

  try {
    projectFile = JSON.parse(await readFile(canonicalProjectFilePath, 'utf8'));
  } catch {
    throw new ProjectRootSelectionError('Legacy Project JSON is invalid or unsupported.');
  }

  if (
    !isRecord(projectFile) ||
    projectFile.app !== 'HumSTUDIO' ||
    typeof projectFile.version !== 'string' ||
    projectFile.version.length === 0 ||
    typeof projectFile.savedAt !== 'string' ||
    Number.isNaN(Date.parse(projectFile.savedAt)) ||
    !isRecord(projectFile.workspace)
  ) {
    throw new ProjectRootSelectionError('Legacy Project JSON is invalid or unsupported.');
  }
}

async function validateExistingManagedLayout(rootPath) {
  const inspectedPaths = new Set();

  for (const relativePath of PROJECT_ROOT_DIRECTORIES) {
    const segments = relativePath.split('/');

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const currentRelativePath = segments.slice(0, segmentIndex + 1).join('/');

      if (inspectedPaths.has(currentRelativePath)) {
        continue;
      }

      inspectedPaths.add(currentRelativePath);
      const targetPath = resolveProjectPath(rootPath, currentRelativePath);
      let targetStat;

      try {
        targetStat = await lstat(targetPath);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          break;
        }

        throw error;
      }

      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        throw new ProjectRootSelectionError(
          'Existing Project Root layout is invalid or unsafe.',
        );
      }

      const canonicalTargetPath = await realpath(targetPath);
      assertPathWithinRoot(rootPath, canonicalTargetPath);
    }
  }
}

async function hasCompleteLegacyProjectLayout(rootPath, entries) {
  const managedTopLevelDirectories = new Set(
    PROJECT_ROOT_DIRECTORIES.map((relativePath) => relativePath.split('/')[0]),
  );

  if (
    entries.length !== managedTopLevelDirectories.size ||
    entries.some(
      (entry) => !entry.isDirectory() || !managedTopLevelDirectories.has(entry.name),
    )
  ) {
    return false;
  }

  try {
    for (const relativePath of PROJECT_ROOT_DIRECTORIES) {
      const targetPath = resolveProjectPath(rootPath, relativePath);
      const targetStat = await lstat(targetPath);

      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        return false;
      }

      const canonicalTargetPath = await realpath(targetPath);
      assertPathWithinRoot(rootPath, canonicalTargetPath);
    }
  } catch {
    return false;
  }

  return true;
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
