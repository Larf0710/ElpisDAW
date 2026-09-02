import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { resolveProjectPath } from './projectRootAuthority.mjs';
import { serializeJsonFile, writeTextAtomically } from './atomicFileWriter.mjs';

export const MAX_PROJECT_FILE_BYTES = 16 * 1024 * 1024;

export class ProjectFileValidationError extends Error {}

export class ProjectFileNotFoundError extends Error {}

export class ProjectFileReadError extends Error {}

export class ProjectFileTooLargeError extends Error {}

export class ProjectRootRequiredError extends Error {}

export class AtomicProjectFileStore {
  #projectRootAuthority;

  constructor({ projectRootAuthority }) {
    if (!projectRootAuthority || typeof projectRootAuthority.getSnapshot !== 'function') {
      throw new TypeError('AtomicProjectFileStore requires a ProjectRootAuthority.');
    }

    this.#projectRootAuthority = projectRootAuthority;
  }

  async save(projectFile) {
    validateProjectFile(projectFile);

    const projectRoot = this.#projectRootAuthority.getSnapshot();

    if (projectRoot.status !== 'READY') {
      throw new ProjectRootRequiredError('Select a Project Root before saving the Project JSON.');
    }

    const projectFilePath = resolveProjectPath(projectRoot.rootPath, projectRoot.projectFileName);
    const contents = serializeJsonFile(projectFile);
    const bytesWritten = Buffer.byteLength(contents, 'utf8');

    if (bytesWritten > MAX_PROJECT_FILE_BYTES) {
      throw new ProjectFileValidationError(
        `Project JSON exceeds the ${MAX_PROJECT_FILE_BYTES} byte limit.`,
      );
    }

    await writeTextAtomically(projectFilePath, contents);
    const lastModifiedAt = new Date().toISOString();
    this.#projectRootAuthority.recordProjectFileSave({
      bytesWritten,
      lastModifiedAt,
      projectFilePath,
    });

    return Object.freeze({
      bytesWritten,
      lastModifiedAt,
      projectFileName: projectRoot.projectFileName,
      projectFilePath,
      savedAt: projectFile.savedAt,
      status: 'SAVED',
    });
  }

  async load() {
    const projectRoot = this.#projectRootAuthority.getSnapshot();

    if (projectRoot.status !== 'READY') {
      throw new ProjectRootRequiredError('Select a Project Root before opening the Project JSON.');
    }

    const projectFilePath = resolveProjectPath(projectRoot.rootPath, projectRoot.projectFileName);
    let sourceHandle;

    try {
      const pathStat = await lstat(projectFilePath);

      if (pathStat.isSymbolicLink()) {
        throw new ProjectFileValidationError(
          'Project JSON must be a regular file, not a symbolic link.',
        );
      }

      const canonicalPath = await realpath(projectFilePath);

      if (!isPathWithinRoot(projectRoot.rootPath, canonicalPath)) {
        throw new ProjectFileValidationError(
          'Project JSON resolves outside the active Project Root.',
        );
      }

      sourceHandle = await open(canonicalPath, 'r');
      const sourceStat = await sourceHandle.stat();

      if (!sourceStat.isFile()) {
        throw new ProjectFileValidationError('Project JSON path is not a regular file.');
      }

      if (sourceStat.size > MAX_PROJECT_FILE_BYTES) {
        throw new ProjectFileTooLargeError(
          `Project JSON exceeds the ${MAX_PROJECT_FILE_BYTES} byte limit.`,
        );
      }

      const contents = await readExactFile(sourceHandle, sourceStat.size);
      const finalStat = await sourceHandle.stat();

      if (
        finalStat.size !== sourceStat.size ||
        finalStat.mtimeMs !== sourceStat.mtimeMs
      ) {
        throw new ProjectFileReadError('Project JSON changed while it was being read.');
      }

      let projectFile;

      try {
        projectFile = JSON.parse(contents.toString('utf8'));
      } catch {
        throw new ProjectFileValidationError('Project JSON is not valid JSON.');
      }

      validateProjectFile(projectFile);

      return Object.freeze({
        bytesRead: contents.byteLength,
        lastModifiedAt: sourceStat.mtime.toISOString(),
        projectFile,
        projectFileName: projectRoot.projectFileName,
        projectFilePath,
        savedAt: projectFile.savedAt,
        status: 'LOADED',
      });
    } catch (error) {
      if (
        error instanceof ProjectFileValidationError ||
        error instanceof ProjectFileReadError ||
        error instanceof ProjectFileTooLargeError ||
        error instanceof ProjectRootRequiredError
      ) {
        throw error;
      }

      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new ProjectFileNotFoundError(
          'The active Project Root does not contain its Project JSON file.',
        );
      }

      throw new ProjectFileReadError(
        error instanceof Error ? error.message : 'Project JSON could not be read.',
      );
    } finally {
      await sourceHandle?.close().catch(() => undefined);
    }
  }
}

export function validateProjectFile(value) {
  if (
    !isRecord(value) ||
    value.app !== 'HumSTUDIO' ||
    typeof value.version !== 'string' ||
    value.version.length === 0 ||
    typeof value.savedAt !== 'string' ||
    Number.isNaN(Date.parse(value.savedAt)) ||
    !isRecord(value.workspace)
  ) {
    throw new ProjectFileValidationError('Project JSON has an unsupported HumSTUDIO structure.');
  }

  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readExactFile(sourceHandle, sizeBytes) {
  const contents = Buffer.allocUnsafe(sizeBytes);
  let offset = 0;

  while (offset < sizeBytes) {
    const { bytesRead } = await sourceHandle.read(
      contents,
      offset,
      sizeBytes - offset,
      offset,
    );

    if (bytesRead === 0) {
      throw new ProjectFileReadError('Project JSON changed while it was being read.');
    }

    offset += bytesRead;
  }

  return contents;
}

function isPathWithinRoot(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);

  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isNodeError(value) {
  return value instanceof Error && 'code' in value;
}
