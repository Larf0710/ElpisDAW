import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  ACE_STEP_MODEL_ROOT_ENVIRONMENT_VARIABLE,
} from './aceStepRuntimeProfile.mjs';
import {
  ACE_STEP_MODEL_MANIFEST_VERSION,
  ACE_STEP_PINNED_MODEL_SNAPSHOT_MANIFEST,
} from './aceStepModelSnapshotManifest.mjs';

const HASH_BUFFER_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 32_767;
const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;
const MODEL_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const DEFAULT_FILE_SYSTEM = Object.freeze({
  lstat,
  open,
  readdir,
  realpath,
});

export class AceStepModelSnapshotProbeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'AceStepModelSnapshotProbeError';
  }
}

export async function probeAceStepModelSnapshot(
  modelRootPath,
  {
    fileSystem = DEFAULT_FILE_SYSTEM,
    hashFile = hashFileHandleWithBoundedReads,
    manifest = ACE_STEP_PINNED_MODEL_SNAPSHOT_MANIFEST,
  } = {},
) {
  requireAbsoluteModelRoot(modelRootPath);
  const validatedManifest = validateAceStepModelSnapshotManifest(manifest);
  const validatedFileSystem = validateFileSystem(fileSystem);

  if (typeof hashFile !== 'function') {
    throw requestInvalid('ACE-Step Model Snapshot hash function is invalid.');
  }

  const rootResult = await resolveCanonicalModelRoot(
    modelRootPath,
    validatedFileSystem,
  );

  if (rootResult.blocker !== undefined) {
    return createAssessment(validatedManifest, [rootResult.blocker], 0);
  }

  const blockers = [];
  let verifiedFileCount = 0;

  for (const expectedFile of validatedManifest.files) {
    const inspection = await inspectRequiredFile(
      rootResult.canonicalRoot,
      expectedFile,
      validatedFileSystem,
      hashFile,
    );

    if (inspection.blocker === undefined) {
      verifiedFileCount += 1;
    } else {
      blockers.push(inspection.blocker);
    }
  }

  return createAssessment(validatedManifest, blockers, verifiedFileCount);
}

export function resolveAceStepModelRootFromEnvironment(environment = process.env) {
  if (
    typeof environment !== 'object' ||
    environment === null ||
    Array.isArray(environment)
  ) {
    throw requestInvalid('ACE-Step Model Snapshot environment is invalid.');
  }

  const modelRootPath = environment[ACE_STEP_MODEL_ROOT_ENVIRONMENT_VARIABLE];
  requireAbsoluteModelRoot(modelRootPath);
  return modelRootPath;
}

export function validateAceStepModelSnapshotManifest(value) {
  requireExactKeys(
    value,
    [
      'files',
      'manifestVersion',
      'modelMetadataUrl',
      'modelRepository',
      'modelRevision',
      'modelSourceUrl',
      'providerRepository',
      'providerRevision',
      'providerSourceUrl',
    ],
    'ACE-Step Model Snapshot manifest',
  );

  if (value.manifestVersion !== ACE_STEP_MODEL_MANIFEST_VERSION) {
    throw manifestInvalid('ACE-Step Model Snapshot manifest version is unsupported.');
  }

  const modelRepository = requirePattern(
    value.modelRepository,
    REPOSITORY_PATTERN,
    'ACE-Step Model repository',
  );
  const modelRevision = requirePattern(
    value.modelRevision,
    REVISION_PATTERN,
    'ACE-Step Model revision',
  );
  const providerRepository = requireHttpsUrl(
    value.providerRepository,
    'ACE-Step Provider repository',
  );
  const providerRevision = requirePattern(
    value.providerRevision,
    REVISION_PATTERN,
    'ACE-Step Provider revision',
  );
  const expectedMetadataUrl =
    `https://huggingface.co/api/models/${modelRepository}/revision/` +
    `${modelRevision}?blobs=true`;
  const expectedModelSourceUrl =
    `https://huggingface.co/${modelRepository}/tree/${modelRevision}`;
  const expectedProviderSourceUrl =
    `${providerRepository}/tree/${providerRevision}`;

  if (
    value.modelMetadataUrl !== expectedMetadataUrl ||
    value.modelSourceUrl !== expectedModelSourceUrl ||
    value.providerSourceUrl !== expectedProviderSourceUrl
  ) {
    throw manifestInvalid(
      'ACE-Step Model Snapshot provenance must use exact pinned revision URLs.',
    );
  }

  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw manifestInvalid('ACE-Step Model Snapshot files are invalid.');
  }

  const files = value.files.map(validateManifestFile);
  const exactPaths = new Set();
  const caseFoldedPaths = new Set();

  for (const file of files) {
    const caseFoldedPath = file.path.toLowerCase();

    if (exactPaths.has(file.path) || caseFoldedPaths.has(caseFoldedPath)) {
      throw manifestInvalid(
        'ACE-Step Model Snapshot contains duplicate or case-colliding paths.',
      );
    }

    exactPaths.add(file.path);
    caseFoldedPaths.add(caseFoldedPath);
  }

  files.sort(compareManifestPaths);

  return Object.freeze({
    files: Object.freeze(files),
    manifestVersion: ACE_STEP_MODEL_MANIFEST_VERSION,
    modelMetadataUrl: expectedMetadataUrl,
    modelRepository,
    modelRevision,
    modelSourceUrl: expectedModelSourceUrl,
    providerRepository,
    providerRevision,
    providerSourceUrl: expectedProviderSourceUrl,
  });
}

export async function hashFileHandleWithBoundedReads(fileHandle, sizeBytes) {
  if (
    typeof fileHandle !== 'object' ||
    fileHandle === null ||
    typeof fileHandle.read !== 'function' ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0
  ) {
    throw requestInvalid('ACE-Step Model Snapshot hash request is invalid.');
  }

  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, sizeBytes));
  let position = 0;

  while (position < sizeBytes) {
    const length = Math.min(buffer.length, sizeBytes - position);
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      length,
      position,
    );

    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) {
      throw fileChanged('ACE-Step Model file changed while it was hashed.');
    }

    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }

  return hash.digest('hex');
}

async function resolveCanonicalModelRoot(modelRootPath, fileSystem) {
  let requestedStat;

  try {
    requestedStat = await fileSystem.lstat(modelRootPath);
  } catch {
    return {
      blocker: blocker(
        'ACE_STEP_MODEL_ROOT_UNAVAILABLE',
        'ACE-Step Model root is unavailable.',
      ),
    };
  }

  if (!requestedStat.isDirectory() && !requestedStat.isSymbolicLink()) {
    return {
      blocker: blocker(
        'ACE_STEP_MODEL_ROOT_NOT_DIRECTORY',
        'ACE-Step Model root must resolve to a directory.',
      ),
    };
  }

  try {
    const canonicalRoot = await fileSystem.realpath(modelRootPath);
    const canonicalStat = await fileSystem.lstat(canonicalRoot);

    if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
      return {
        blocker: blocker(
          'ACE_STEP_MODEL_ROOT_NOT_DIRECTORY',
          'ACE-Step Model root must resolve to a regular directory.',
        ),
      };
    }

    return { canonicalRoot };
  } catch {
    return {
      blocker: blocker(
        'ACE_STEP_MODEL_ROOT_UNAVAILABLE',
        'ACE-Step Model root is unavailable.',
      ),
    };
  }
}

async function inspectRequiredFile(
  canonicalRoot,
  expectedFile,
  fileSystem,
  hashFile,
) {
  const pathResult = await resolveExactRequiredPath(
    canonicalRoot,
    expectedFile.path,
    fileSystem,
  );

  if (pathResult.blocker !== undefined) {
    return pathResult;
  }

  if (pathResult.fileStat.size !== expectedFile.sizeBytes) {
    return {
      blocker: fileBlocker(
        'ACE_STEP_MODEL_FILE_SIZE_MISMATCH',
        'ACE-Step Model file size does not match the pinned manifest.',
        expectedFile.path,
      ),
    };
  }

  let fileHandle;

  try {
    fileHandle = await fileSystem.open(pathResult.canonicalPath, 'r');
    const initialStat = await fileHandle.stat();

    if (!initialStat.isFile() || isLinkOrReparsePoint(initialStat)) {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_NOT_REGULAR',
          'ACE-Step Model file is not a regular file.',
          expectedFile.path,
        ),
      };
    }

    if (initialStat.size !== expectedFile.sizeBytes) {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_SIZE_MISMATCH',
          'ACE-Step Model file size does not match the pinned manifest.',
          expectedFile.path,
        ),
      };
    }

    const sha256 = await hashFile(fileHandle, initialStat.size);
    const finalStat = await fileHandle.stat();

    if (!sameFileObservation(initialStat, finalStat)) {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_CHANGED',
          'ACE-Step Model file changed during verification.',
          expectedFile.path,
        ),
      };
    }

    if (sha256 !== expectedFile.sha256) {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_SHA256_MISMATCH',
          'ACE-Step Model file hash does not match the pinned manifest.',
          expectedFile.path,
        ),
      };
    }

    return {};
  } catch (error) {
    if (
      error instanceof AceStepModelSnapshotProbeError &&
      error.code === 'ACE_STEP_MODEL_FILE_CHANGED'
    ) {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_CHANGED',
          'ACE-Step Model file changed during verification.',
          expectedFile.path,
        ),
      };
    }

    return {
      blocker: fileBlocker(
        'ACE_STEP_MODEL_FILE_UNREADABLE',
        'ACE-Step Model file could not be verified.',
        expectedFile.path,
      ),
    };
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

async function resolveExactRequiredPath(canonicalRoot, relativePath, fileSystem) {
  const segments = relativePath.split('/');
  let currentPath = canonicalRoot;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    let entries;

    try {
      entries = await fileSystem.readdir(currentPath, { withFileTypes: true });
    } catch {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_MISSING',
          'ACE-Step Model required file is missing.',
          relativePath,
        ),
      };
    }

    const caseMatches = entries.filter(
      (entry) => entry.name.toLowerCase() === segment.toLowerCase(),
    );

    if (caseMatches.length === 0) {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_MISSING',
          'ACE-Step Model required file is missing.',
          relativePath,
        ),
      };
    }

    if (caseMatches.length !== 1 || caseMatches[0].name !== segment) {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_PATH_ALIAS',
          'ACE-Step Model file path does not match the pinned path exactly.',
          relativePath,
        ),
      };
    }

    currentPath = join(currentPath, segment);
    let pathStat;

    try {
      pathStat = await fileSystem.lstat(currentPath);
    } catch {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_MISSING',
          'ACE-Step Model required file is missing.',
          relativePath,
        ),
      };
    }

    if (isLinkOrReparsePoint(pathStat)) {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_REPARSE_POINT',
          'ACE-Step Model required path must not use a link or reparse point.',
          relativePath,
        ),
      };
    }

    const isLastSegment = index === segments.length - 1;

    if (!isLastSegment && !pathStat.isDirectory()) {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_NOT_REGULAR',
          'ACE-Step Model required path contains a non-directory segment.',
          relativePath,
        ),
      };
    }

    if (isLastSegment && !pathStat.isFile()) {
      return {
        blocker: fileBlocker(
          'ACE_STEP_MODEL_FILE_NOT_REGULAR',
          'ACE-Step Model required path is not a regular file.',
          relativePath,
        ),
      };
    }

    if (isLastSegment) {
      try {
        const canonicalPath = await fileSystem.realpath(currentPath);

        if (!isPathWithinRoot(canonicalRoot, canonicalPath)) {
          return {
            blocker: fileBlocker(
              'ACE_STEP_MODEL_FILE_ROOT_ESCAPE',
              'ACE-Step Model required file resolves outside the Model root.',
              relativePath,
            ),
          };
        }

        return { canonicalPath, fileStat: pathStat };
      } catch {
        return {
          blocker: fileBlocker(
            'ACE_STEP_MODEL_FILE_UNREADABLE',
            'ACE-Step Model required file could not be resolved.',
            relativePath,
          ),
        };
      }
    }
  }

  throw new Error('Unreachable ACE-Step Model path state.');
}

function validateManifestFile(value) {
  requireExactKeys(
    value,
    ['path', 'sha256', 'sizeBytes'],
    'ACE-Step Model Snapshot file',
  );

  if (
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    value.path.length > 1_024 ||
    !MODEL_PATH_PATTERN.test(value.path) ||
    value.path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw manifestInvalid('ACE-Step Model Snapshot file path is invalid.');
  }

  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) {
    throw manifestInvalid('ACE-Step Model Snapshot file size is invalid.');
  }

  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw manifestInvalid('ACE-Step Model Snapshot file hash is invalid.');
  }

  return Object.freeze({
    path: value.path,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
  });
}

function validateFileSystem(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw requestInvalid('ACE-Step Model Snapshot filesystem is invalid.');
  }

  for (const method of ['lstat', 'open', 'readdir', 'realpath']) {
    if (typeof value[method] !== 'function') {
      throw requestInvalid('ACE-Step Model Snapshot filesystem is invalid.');
    }
  }

  return value;
}

function createAssessment(manifest, blockers, verifiedFileCount) {
  const totalRequiredBytes = manifest.files.reduce(
    (total, file) => total + file.sizeBytes,
    0,
  );
  const frozenBlockers = Object.freeze([...blockers]);

  return Object.freeze({
    blockers: frozenBlockers,
    manifest: Object.freeze({
      manifestVersion: manifest.manifestVersion,
      modelRepository: manifest.modelRepository,
      modelRevision: manifest.modelRevision,
      providerRevision: manifest.providerRevision,
    }),
    snapshot: Object.freeze({
      extraFilesPolicy: 'IGNORED_OUTSIDE_VERIFIED_SET',
      requiredFileCount: manifest.files.length,
      totalRequiredBytes,
      verifiedFileCount,
    }),
    status:
      blockers.length === 0
        ? 'READY_FOR_REAL_GENERATION_PROBE'
        : 'UNVERIFIED',
  });
}

function sameFileObservation(initialStat, finalStat) {
  return (
    finalStat.isFile() &&
    finalStat.size === initialStat.size &&
    finalStat.mtimeMs === initialStat.mtimeMs &&
    finalStat.ctimeMs === initialStat.ctimeMs &&
    sameProvidedIdentity(initialStat.dev, finalStat.dev) &&
    sameProvidedIdentity(initialStat.ino, finalStat.ino)
  );
}

function sameProvidedIdentity(initialValue, finalValue) {
  return (
    initialValue === undefined ||
    finalValue === undefined ||
    initialValue === finalValue
  );
}

function requireAbsoluteModelRoot(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.trim() !== value ||
    !isAbsolute(value)
  ) {
    throw requestInvalid('ACE-Step Model root must be one absolute path.');
  }
}

function requirePattern(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw manifestInvalid(`${label} is invalid.`);
  }

  return value;
}

function requireHttpsUrl(value, label) {
  if (
    typeof value !== 'string' ||
    !/^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._-]+)+$/.test(value) ||
    value.endsWith('/')
  ) {
    throw manifestInvalid(`${label} is invalid.`);
  }

  return value;
}

function requireExactKeys(value, expectedKeys, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw manifestInvalid(`${label} must be an object.`);
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw manifestInvalid(`${label} keys are invalid.`);
  }
}

function isPathWithinRoot(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function isLinkOrReparsePoint(pathStat) {
  return (
    pathStat.isSymbolicLink() ||
    (Number.isInteger(pathStat.fileAttributes) &&
      (pathStat.fileAttributes & WINDOWS_REPARSE_POINT_ATTRIBUTE) !== 0)
  );
}

function compareManifestPaths(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function blocker(code, message) {
  return Object.freeze({ code, message });
}

function fileBlocker(code, message, path) {
  return blocker(code, `${message} Required path: ${path}`);
}

function requestInvalid(message) {
  return new AceStepModelSnapshotProbeError(
    'ACE_STEP_MODEL_PROBE_REQUEST_INVALID',
    message,
  );
}

function manifestInvalid(message) {
  return new AceStepModelSnapshotProbeError(
    'ACE_STEP_MODEL_MANIFEST_INVALID',
    message,
  );
}

function fileChanged(message) {
  return new AceStepModelSnapshotProbeError(
    'ACE_STEP_MODEL_FILE_CHANGED',
    message,
  );
}
