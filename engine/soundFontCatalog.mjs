import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';

import { resolveProjectPath } from './projectRootAuthority.mjs';

export const SOUNDFONT_PROJECT_DIRECTORY = 'soundfonts';
export const MAX_SOUNDFONT_CATALOG_ENTRIES = 4_096;
export const MAX_SOUNDFONT_CATALOG_DEPTH = 8;

const SUPPORTED_SOUNDFONT_FORMATS = new Set(['sf2', 'sf3']);

export class SoundFontCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SoundFontCatalogError';
    this.code = code;
  }
}

export class SoundFontCatalog {
  #builtinSoundFonts;
  #projectRootAuthority;

  constructor({ builtinSoundFonts = [], projectRootAuthority }) {
    if (!projectRootAuthority || typeof projectRootAuthority.getSnapshot !== 'function') {
      throw new TypeError('SoundFontCatalog requires a ProjectRootAuthority.');
    }

    this.#builtinSoundFonts = normalizeBuiltinSoundFonts(builtinSoundFonts);
    this.#projectRootAuthority = projectRootAuthority;
  }

  async list() {
    const projectRoot = this.#projectRootAuthority.getSnapshot();

    if (projectRoot.status !== 'READY') {
      throw new SoundFontCatalogError(
        'PROJECT_ROOT_REQUIRED',
        'Select Project Root before listing SoundFonts.',
      );
    }

    const catalogPath = resolveProjectPath(projectRoot.rootPath, SOUNDFONT_PROJECT_DIRECTORY);
    const catalogStat = await inspectCatalogDirectory(catalogPath);
    const canonicalCatalogPath = await resolveCatalogDirectory(catalogPath);

    if (
      catalogStat.isSymbolicLink() ||
      !catalogStat.isDirectory() ||
      !isPathWithinRoot(projectRoot.rootPath, canonicalCatalogPath)
    ) {
      throw new SoundFontCatalogError(
        'SOUNDFONT_DIRECTORY_UNSAFE',
        'Project SoundFont directory must be a regular directory inside Project Root.',
      );
    }

    const state = {
      entriesVisited: 0,
      excludedResourcePaths: new Set(
        this.#builtinSoundFonts.map((resource) => resource.relativePath),
      ),
      issues: [],
      resources: [],
    };

    for (const builtinSoundFont of this.#builtinSoundFonts) {
      const resource = await inspectBuiltinSoundFont(builtinSoundFont);

      if (resource) {
        state.resources.push(resource);
      } else {
        state.issues.push(
          Object.freeze({
            reason: 'UNAVAILABLE',
            relativePath: builtinSoundFont.relativePath,
          }),
        );
      }
    }

    await scanDirectory({
      absoluteDirectory: canonicalCatalogPath,
      catalogRootPath: canonicalCatalogPath,
      depth: 0,
      relativeDirectory: '',
      state,
    });

    state.issues.sort(compareRelativePaths);
    state.resources.sort(compareRelativePaths);

    return Object.freeze({
      directory: SOUNDFONT_PROJECT_DIRECTORY,
      issues: Object.freeze(state.issues),
      resources: Object.freeze(state.resources),
      scannedAt: new Date().toISOString(),
      supportedFormats: Object.freeze(['sf2', 'sf3']),
    });
  }

  async resolve(reference) {
    validateResourceReference(reference);
    const catalog = await this.list();
    const resource = catalog.resources.find(
      (candidate) => candidate.resourceId === reference.resourceId,
    );

    if (!resource) {
      throw new SoundFontCatalogError(
        'SOUNDFONT_OFFLINE',
        'The selected SoundFont is not available in the Project catalog.',
      );
    }

    if (
      resource.library !== reference.library ||
      resource.format !== reference.format ||
      resource.relativePath !== reference.relativePath
    ) {
      throw new SoundFontCatalogError(
        'SOUNDFONT_IDENTITY_MISMATCH',
        'The selected SoundFont identity does not match the Project catalog.',
      );
    }

    if (resource.revisionToken !== reference.revisionToken) {
      throw new SoundFontCatalogError(
        'SOUNDFONT_REVISION_CHANGED',
        'The selected SoundFont changed on disk. Refresh the catalog before auditioning it.',
      );
    }

    if (resource.library === 'builtin') {
      const definition = this.#builtinSoundFonts.find(
        (candidate) => candidate.relativePath === resource.relativePath,
      );

      if (!definition) {
        throw new SoundFontCatalogError(
          'SOUNDFONT_OFFLINE',
          'The selected built-in SoundFont is unavailable.',
        );
      }

      return resolveBuiltinSoundFont(definition, resource);
    }

    const projectRoot = this.#projectRootAuthority.getSnapshot();

    if (projectRoot.status !== 'READY') {
      throw new SoundFontCatalogError(
        'PROJECT_ROOT_REQUIRED',
        'Select Project Root before resolving a SoundFont.',
      );
    }

    const catalogPath = resolveProjectPath(
      projectRoot.rootPath,
      SOUNDFONT_PROJECT_DIRECTORY,
    );
    const canonicalCatalogPath = await resolveCatalogDirectory(catalogPath);
    const candidatePath = resolveProjectPath(
      projectRoot.rootPath,
      resource.relativePath,
    );
    let candidateStat;
    let canonicalPath;
    let currentStat;

    try {
      candidateStat = await lstat(candidatePath);
      canonicalPath = await realpath(candidatePath);
      currentStat = await stat(canonicalPath);
    } catch (error) {
      throw new SoundFontCatalogError(
        'SOUNDFONT_OFFLINE',
        `The selected SoundFont cannot be opened: ${readNodeErrorCode(error)}.`,
      );
    }

    if (
      candidateStat.isSymbolicLink() ||
      !candidateStat.isFile() ||
      !currentStat.isFile() ||
      !isPathWithinRoot(canonicalCatalogPath, canonicalPath)
    ) {
      throw new SoundFontCatalogError(
        'SOUNDFONT_DIRECTORY_UNSAFE',
        'The selected SoundFont must be a regular file inside the Project soundfonts directory.',
      );
    }

    const currentRevisionToken = createRevisionToken(
      resource.relativePath,
      currentStat.size,
      currentStat.mtimeMs,
    );

    if (currentRevisionToken !== reference.revisionToken) {
      throw new SoundFontCatalogError(
        'SOUNDFONT_REVISION_CHANGED',
        'The selected SoundFont changed on disk. Refresh the catalog before auditioning it.',
      );
    }

    return Object.freeze({
      ...resource,
      absolutePath: canonicalPath,
    });
  }
}

function validateResourceReference(value) {
  if (
    !isRecord(value) ||
    (value.library !== 'builtin' && value.library !== 'project') ||
    !SUPPORTED_SOUNDFONT_FORMATS.has(value.format) ||
    typeof value.relativePath !== 'string' ||
    !value.relativePath.startsWith(`${SOUNDFONT_PROJECT_DIRECTORY}/`) ||
    value.relativePath.includes('\\') ||
    value.relativePath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    !value.relativePath.toLowerCase().endsWith(`.${value.format}`) ||
    typeof value.resourceId !== 'string' ||
    !/^soundfont-[a-f0-9]{32}$/.test(value.resourceId) ||
    typeof value.revisionToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.revisionToken)
  ) {
    throw new SoundFontCatalogError(
      'SOUNDFONT_REQUEST_INVALID',
      'SoundFont resource reference is invalid.',
    );
  }
}

async function inspectCatalogDirectory(catalogPath) {
  try {
    return await lstat(catalogPath);
  } catch (error) {
    throw new SoundFontCatalogError(
      'SOUNDFONT_CATALOG_READ_FAILED',
      `Project SoundFont directory cannot be inspected: ${readNodeErrorCode(error)}.`,
    );
  }
}

async function resolveCatalogDirectory(catalogPath) {
  try {
    return await realpath(catalogPath);
  } catch (error) {
    throw new SoundFontCatalogError(
      'SOUNDFONT_CATALOG_READ_FAILED',
      `Project SoundFont directory cannot be resolved: ${readNodeErrorCode(error)}.`,
    );
  }
}

async function scanDirectory({
  absoluteDirectory,
  catalogRootPath,
  depth,
  relativeDirectory,
  state,
}) {
  let entries;

  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (depth === 0) {
      throw new SoundFontCatalogError(
        'SOUNDFONT_CATALOG_READ_FAILED',
        `Project SoundFont directory cannot be read: ${readNodeErrorCode(error)}.`,
      );
    }

    state.issues.push(
      Object.freeze({
        reason: 'UNREADABLE',
        relativePath: toCatalogRelativePath(relativeDirectory),
      }),
    );
    return;
  }

  entries.sort((left, right) => compareText(left.name, right.name));

  for (const entry of entries) {
    state.entriesVisited += 1;

    if (state.entriesVisited > MAX_SOUNDFONT_CATALOG_ENTRIES) {
      throw new SoundFontCatalogError(
        'SOUNDFONT_CATALOG_LIMIT_EXCEEDED',
        `Project SoundFont catalog exceeds ${MAX_SOUNDFONT_CATALOG_ENTRIES} entries.`,
      );
    }

    const entryRelativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    const entryCatalogPath = toCatalogRelativePath(entryRelativePath);

    if (state.excludedResourcePaths.has(entryCatalogPath)) {
      continue;
    }

    const absolutePath = join(absoluteDirectory, entry.name);
    let entryStat;

    try {
      entryStat = await lstat(absolutePath);
    } catch {
      state.issues.push(
        Object.freeze({ reason: 'UNAVAILABLE', relativePath: entryCatalogPath }),
      );
      continue;
    }

    if (entryStat.isSymbolicLink()) {
      state.issues.push(
        Object.freeze({ reason: 'SYMBOLIC_LINK', relativePath: entryCatalogPath }),
      );
      continue;
    }

    if (entryStat.isDirectory()) {
      if (depth >= MAX_SOUNDFONT_CATALOG_DEPTH) {
        state.issues.push(
          Object.freeze({ reason: 'DEPTH_LIMIT', relativePath: entryCatalogPath }),
        );
        continue;
      }

      let canonicalDirectoryPath;

      try {
        canonicalDirectoryPath = await realpath(absolutePath);
      } catch {
        state.issues.push(
          Object.freeze({ reason: 'UNAVAILABLE', relativePath: entryCatalogPath }),
        );
        continue;
      }

      if (!isPathWithinRoot(catalogRootPath, canonicalDirectoryPath)) {
        state.issues.push(
          Object.freeze({ reason: 'OUTSIDE_CATALOG', relativePath: entryCatalogPath }),
        );
        continue;
      }

      await scanDirectory({
        absoluteDirectory: canonicalDirectoryPath,
        catalogRootPath,
        depth: depth + 1,
        relativeDirectory: entryRelativePath,
        state,
      });
      continue;
    }

    const format = readSoundFontFormat(entry.name);

    if (!entryStat.isFile() || !format) {
      continue;
    }

    let canonicalPath;
    let currentStat;

    try {
      canonicalPath = await realpath(absolutePath);
      currentStat = await stat(canonicalPath);
    } catch {
      state.issues.push(
        Object.freeze({ reason: 'UNAVAILABLE', relativePath: entryCatalogPath }),
      );
      continue;
    }

    if (!currentStat.isFile() || !isPathWithinRoot(catalogRootPath, canonicalPath)) {
      state.issues.push(
        Object.freeze({ reason: 'OUTSIDE_CATALOG', relativePath: entryCatalogPath }),
      );
      continue;
    }

    const normalizedRelativePath = entryCatalogPath.normalize('NFC');
    const resourceId = createStableId(normalizedRelativePath);
    const revisionToken = createRevisionToken(
      normalizedRelativePath,
      currentStat.size,
      currentStat.mtimeMs,
    );

    state.resources.push(
      Object.freeze({
        format,
        lastModifiedAt: currentStat.mtime.toISOString(),
        library: 'project',
        name: entry.name.normalize('NFC'),
        relativePath: normalizedRelativePath,
        resourceId,
        revisionToken,
        sizeBytes: currentStat.size,
        status: 'AVAILABLE',
      }),
    );
  }
}

function normalizeBuiltinSoundFonts(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('SoundFontCatalog builtinSoundFonts must be an array.');
  }

  const relativePaths = new Set();
  const resources = value.map((resource) => {
    if (
      !isRecord(resource) ||
      resource.library !== 'builtin' ||
      (resource.format !== 'sf2' && resource.format !== 'sf3') ||
      typeof resource.name !== 'string' ||
      resource.name.length === 0 ||
      typeof resource.relativePath !== 'string' ||
      !resource.relativePath.startsWith(`${SOUNDFONT_PROJECT_DIRECTORY}/`) ||
      !resource.relativePath.toLowerCase().endsWith(`.${resource.format}`) ||
      resource.relativePath.includes('\\') ||
      relativePaths.has(resource.relativePath) ||
      typeof resource.absolutePath !== 'string' ||
      !isAbsolute(resource.absolutePath) ||
      typeof resource.runtimeRootPath !== 'string' ||
      !isAbsolute(resource.runtimeRootPath) ||
      typeof resource.expectedSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(resource.expectedSha256) ||
      !Number.isSafeInteger(resource.sizeBytes) ||
      resource.sizeBytes <= 0
    ) {
      throw new TypeError('SoundFontCatalog built-in SoundFont definition is invalid.');
    }

    relativePaths.add(resource.relativePath);
    return Object.freeze({ ...resource });
  });

  return Object.freeze(resources);
}

async function inspectBuiltinSoundFont(definition) {
  try {
    const candidateStat = await lstat(definition.absolutePath);
    const canonicalRootPath = await realpath(definition.runtimeRootPath);
    const canonicalPath = await realpath(definition.absolutePath);
    const currentStat = await stat(canonicalPath);

    if (
      candidateStat.isSymbolicLink() ||
      !candidateStat.isFile() ||
      !currentStat.isFile() ||
      currentStat.size !== definition.sizeBytes ||
      !isPathWithinRoot(canonicalRootPath, canonicalPath)
    ) {
      return undefined;
    }

    return Object.freeze({
      format: definition.format,
      lastModifiedAt: currentStat.mtime.toISOString(),
      library: 'builtin',
      name: definition.name,
      relativePath: definition.relativePath,
      resourceId: createStableId(definition.relativePath),
      revisionToken: definition.expectedSha256,
      sizeBytes: currentStat.size,
      status: 'AVAILABLE',
    });
  } catch {
    return undefined;
  }
}

async function resolveBuiltinSoundFont(definition, resource) {
  let candidateStat;
  let canonicalRootPath;
  let canonicalPath;
  let currentStat;

  try {
    candidateStat = await lstat(definition.absolutePath);
    canonicalRootPath = await realpath(definition.runtimeRootPath);
    canonicalPath = await realpath(definition.absolutePath);
    currentStat = await stat(canonicalPath);
  } catch (error) {
    throw new SoundFontCatalogError(
      'SOUNDFONT_OFFLINE',
      `The built-in SoundFont cannot be opened: ${readNodeErrorCode(error)}.`,
    );
  }

  if (
    candidateStat.isSymbolicLink() ||
    !candidateStat.isFile() ||
    !currentStat.isFile() ||
    currentStat.size !== definition.sizeBytes ||
    !isPathWithinRoot(canonicalRootPath, canonicalPath)
  ) {
    throw new SoundFontCatalogError(
      'SOUNDFONT_DIRECTORY_UNSAFE',
      'The built-in SoundFont failed its immutable runtime boundary.',
    );
  }

  if ((await sha256File(canonicalPath)) !== definition.expectedSha256) {
    throw new SoundFontCatalogError(
      'SOUNDFONT_REVISION_CHANGED',
      'The built-in SoundFont failed its pinned integrity check.',
    );
  }

  return Object.freeze({
    ...resource,
    absolutePath: canonicalPath,
  });
}

async function sha256File(filePath) {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

function readSoundFontFormat(fileName) {
  const extension = extname(fileName).slice(1).toLowerCase();
  return SUPPORTED_SOUNDFONT_FORMATS.has(extension) ? extension : undefined;
}

function toCatalogRelativePath(relativePath) {
  return `${SOUNDFONT_PROJECT_DIRECTORY}/${relativePath.replaceAll('\\', '/')}`;
}

function createStableId(relativePath) {
  return `soundfont-${createHash('sha256').update(relativePath).digest('hex').slice(0, 32)}`;
}

function createRevisionToken(relativePath, sizeBytes, lastModifiedMs) {
  return createHash('sha256')
    .update(`${relativePath}\0${sizeBytes}\0${lastModifiedMs}`)
    .digest('hex');
}

function compareRelativePaths(left, right) {
  return compareText(left.relativePath, right.relativePath);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPathWithinRoot(rootPath, targetPath) {
  const candidate = relative(rootPath, targetPath);
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate));
}

function readNodeErrorCode(error) {
  return error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
