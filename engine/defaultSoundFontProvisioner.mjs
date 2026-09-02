import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_URL = new URL('../shared/defaultSoundFontManifest.json', import.meta.url);
const HUMSTUDIO_PROJECT_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const DEFAULT_SOUNDFONT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export async function loadDefaultSoundFontManifest() {
  const manifest = JSON.parse(await readFile(MANIFEST_URL, 'utf8'));
  validateManifest(manifest);
  return Object.freeze({
    ...manifest,
    assets: Object.freeze(manifest.assets.map((asset) => Object.freeze({ ...asset }))),
  });
}

export async function createDefaultSoundFontBuiltinDefinition({
  projectDirectory = HUMSTUDIO_PROJECT_DIRECTORY,
} = {}) {
  const manifest = await loadDefaultSoundFontManifest();
  const soundFontFileName = basename(manifest.preferredSoundFontRelativePath);
  const asset = manifest.assets.find(
    (candidate) =>
      candidate.kind === 'soundfont' && candidate.fileName === soundFontFileName,
  );

  if (!asset) {
    throw new Error('Default SoundFont manifest has no preferred SoundFont asset.');
  }

  const format = extname(asset.fileName).slice(1).toLowerCase();

  if (format !== 'sf2' && format !== 'sf3') {
    throw new Error('Default SoundFont asset format is unsupported.');
  }

  const runtimeRootPath = resolve(
    validateAbsoluteDirectoryPath(projectDirectory, 'ElpisDAW project directory'),
    manifest.runtimeRelativeDirectory,
  );

  return Object.freeze({
    absolutePath: resolveAssetPath(runtimeRootPath, asset.fileName),
    expectedSha256: asset.sha256,
    format,
    library: 'builtin',
    name: asset.fileName,
    relativePath: manifest.preferredSoundFontRelativePath,
    runtimeRootPath,
    sizeBytes: asset.sizeBytes,
  });
}

export async function installDefaultSoundFontAssets({
  allowUnavailableSource = false,
  destinationRoot,
  downloadTimeoutMs = DEFAULT_SOUNDFONT_DOWNLOAD_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  manifest,
  sourceRoot,
}) {
  const resolvedManifest = manifest ?? (await loadDefaultSoundFontManifest());
  validateManifest(resolvedManifest);
  const resolvedDestinationRoot = validateAbsoluteDirectoryPath(
    destinationRoot,
    'Default SoundFont destinationRoot',
  );
  const resolvedSourceRoot =
    sourceRoot === undefined
      ? undefined
      : validateAbsoluteDirectoryPath(sourceRoot, 'Default SoundFont sourceRoot');
  const resolvedDownloadTimeoutMs = validateDownloadTimeout(downloadTimeoutMs);

  if (resolvedSourceRoot) {
    const sourceAvailability = await inspectSourceAssets(
      resolvedManifest,
      resolvedSourceRoot,
    );

    if (!sourceAvailability.available) {
      if (allowUnavailableSource) {
        return Object.freeze({
          displayName: resolvedManifest.displayName,
          missingFileName: sourceAvailability.missingFileName,
          status: 'UNAVAILABLE',
          version: resolvedManifest.version,
        });
      }

      throw new Error(
        `Default SoundFont source is unavailable: ${sourceAvailability.missingFileName}.`,
      );
    }
  } else if (typeof fetchImpl !== 'function') {
    throw new TypeError('Default SoundFont fetch implementation is unavailable.');
  }

  await mkdir(resolvedDestinationRoot, { recursive: true });
  let installedCount = 0;

  for (const asset of resolvedManifest.assets) {
    const destinationPath = resolveAssetPath(resolvedDestinationRoot, asset.fileName);
    const destinationState = await inspectAsset(destinationPath, asset);

    if (destinationState === 'MATCH') {
      continue;
    }
    if (destinationState === 'MISMATCH') {
      throw new Error(
        `Default SoundFont destination differs from the pinned asset: ${asset.fileName}.`,
      );
    }

    const partialPath = `${destinationPath}.partial-${randomUUID()}`;

    try {
      if (resolvedSourceRoot) {
        await copyFile(resolveAssetPath(resolvedSourceRoot, asset.fileName), partialPath);
      } else {
        await downloadAsset(
          asset,
          partialPath,
          fetchImpl,
          resolvedDownloadTimeoutMs,
        );
      }

      await assertAssetIntegrity(partialPath, asset);
      await rename(partialPath, destinationPath);
      installedCount += 1;
    } finally {
      await rm(partialPath, { force: true });
    }
  }

  return Object.freeze({
    displayName: resolvedManifest.displayName,
    installedCount,
    status: installedCount > 0 ? 'INSTALLED' : 'READY',
    version: resolvedManifest.version,
  });
}

async function inspectSourceAssets(manifest, sourceRoot) {
  for (const asset of manifest.assets) {
    const sourcePath = resolveAssetPath(sourceRoot, asset.fileName);

    if ((await inspectAsset(sourcePath, asset)) === 'MISSING') {
      return { available: false, missingFileName: asset.fileName };
    }

    await assertAssetIntegrity(sourcePath, asset);
  }

  return { available: true };
}

async function downloadAsset(asset, destinationPath, fetchImpl, timeoutMs) {
  const abortController = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Default SoundFont download timed out for ${asset.fileName} after ${timeoutMs} ms.`,
        ),
      );
      abortController.abort();
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl(asset.url, { signal: abortController.signal }),
      timeout,
    ]);

    if (!response?.ok) {
      throw new Error(
        `Default SoundFont download failed for ${asset.fileName}: HTTP ${response?.status ?? 'UNKNOWN'}.`,
      );
    }

    const bytes = new Uint8Array(
      await Promise.race([response.arrayBuffer(), timeout]),
    );

    if (bytes.byteLength !== asset.sizeBytes) {
      throw new Error(
        `Default SoundFont download size mismatch for ${asset.fileName}.`,
      );
    }

    await writeFile(destinationPath, bytes);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function inspectAsset(filePath, asset) {
  try {
    const fileStat = await stat(filePath);

    if (!fileStat.isFile() || fileStat.size !== asset.sizeBytes) {
      return 'MISMATCH';
    }

    return (await sha256File(filePath)) === asset.sha256 ? 'MATCH' : 'MISMATCH';
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return 'MISSING';
    }

    throw error;
  }
}

async function assertAssetIntegrity(filePath, asset) {
  const state = await inspectAsset(filePath, asset);

  if (state !== 'MATCH') {
    throw new Error(`Default SoundFont integrity check failed: ${asset.fileName}.`);
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

function resolveAssetPath(rootPath, fileName) {
  const targetPath = resolve(rootPath, fileName);
  const relativePath = relative(rootPath, targetPath);

  if (
    relativePath.length === 0 ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) {
    throw new Error('Default SoundFont asset path escapes its root.');
  }

  return targetPath;
}

function validateAbsoluteDirectoryPath(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || !isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path.`);
  }

  return resolve(value.trim());
}

function validateDownloadTimeout(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(
      'Default SoundFont downloadTimeoutMs must be a positive safe integer.',
    );
  }

  return value;
}

function validateManifest(manifest) {
  if (
    !isRecord(manifest) ||
    typeof manifest.displayName !== 'string' ||
    manifest.displayName.length === 0 ||
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0 ||
    !isSafeRelativePath(manifest.runtimeRelativeDirectory) ||
    !isSafeRelativePath(manifest.projectRelativeDirectory) ||
    !isSafeRelativePath(manifest.preferredSoundFontRelativePath) ||
    !manifest.preferredSoundFontRelativePath.startsWith(
      `${manifest.projectRelativeDirectory}/`,
    ) ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length === 0
  ) {
    throw new Error('Default SoundFont manifest is invalid.');
  }

  const fileNames = new Set();

  for (const asset of manifest.assets) {
    if (
      !isRecord(asset) ||
      typeof asset.fileName !== 'string' ||
      asset.fileName.length === 0 ||
      asset.fileName.includes('/') ||
      asset.fileName.includes('\\') ||
      !Number.isSafeInteger(asset.sizeBytes) ||
      asset.sizeBytes <= 0 ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      typeof asset.url !== 'string' ||
      !asset.url.startsWith('https://')
    ) {
      throw new Error('Default SoundFont manifest contains an invalid asset.');
    }

    if (fileNames.has(asset.fileName)) {
      throw new Error('Default SoundFont manifest contains a duplicate asset.');
    }
    fileNames.add(asset.fileName);
  }
}

function isSafeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    value.split('/').every((segment) => segment.length > 0 && segment !== '..')
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value) {
  return value instanceof Error && 'code' in value;
}
