import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { writeDeterministicZipArchive } from './deterministicZipArchive.mjs';
import {
  ELPISDAW_PORTABLE_ARCHIVE,
  ELPISDAW_PORTABLE_ARCHIVE_POLICY_VERSION,
} from './elpisDawPortableArchivePolicy.mjs';
import {
  ELPISDAW_NODE_RUNTIME,
  ELPISDAW_PORTABLE_PACKAGE,
} from './elpisDawPortablePackagePolicy.mjs';

const execFile = promisify(execFileCallback);
const RELEASE_MANIFEST_FILE_NAME = 'release-manifest.json';
const MAXIMUM_MANIFEST_BYTES = 8 * 1024 * 1024;
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class ElpisDawPortableArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ElpisDawPortableArchiveError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ElpisDawPortableArchiveError(code, message);
}

function comparePaths(left, right) {
  return left.localeCompare(right, 'en');
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

function isPathInside(parentPath, childPath) {
  const childRelativePath = relative(parentPath, childPath);
  return (
    childRelativePath.length > 0 &&
    !childRelativePath.startsWith(`..${sep}`) &&
    childRelativePath !== '..' &&
    !isAbsolute(childRelativePath)
  );
}

function pathsEqual(left, right) {
  return left.localeCompare(right, 'en', { sensitivity: 'accent' }) === 0;
}

function pathsOverlap(left, right) {
  return pathsEqual(left, right) || isPathInside(left, right) || isPathInside(right, left);
}

function assertExactKeys(value, expectedKeys, code, message) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort(comparePaths).join('\n') !==
      [...expectedKeys].sort(comparePaths).join('\n')
  ) {
    fail(code, message);
  }
}

async function assertRegularFile(filePath, label, maximumBytes = undefined) {
  let file;

  try {
    file = await lstat(filePath);
  } catch {
    fail('REQUIRED_FILE_MISSING', `${label} is unavailable.`);
  }

  if (!file.isFile() || file.isSymbolicLink()) {
    fail('UNSAFE_FILE_TYPE', `${label} must be one regular file.`);
  }

  if (maximumBytes !== undefined && (file.size <= 0 || file.size > maximumBytes)) {
    fail('INVALID_FILE_SIZE', `${label} has an invalid file size.`);
  }

  return file;
}

async function resolveExistingDirectory(directoryPath, label) {
  if (typeof directoryPath !== 'string' || !isAbsolute(directoryPath)) {
    fail('PATH_NOT_ABSOLUTE', `${label} must be an absolute path.`);
  }

  const resolvedPath = resolve(directoryPath);
  let directory;

  try {
    directory = await lstat(resolvedPath);
  } catch {
    fail('DIRECTORY_UNAVAILABLE', `${label} is unavailable.`);
  }

  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    fail('UNSAFE_DIRECTORY_TYPE', `${label} must be one regular directory.`);
  }

  return realpath(resolvedPath);
}

async function resolveOutputRoot(outputRoot, packageRoot, repositoryPath) {
  if (typeof outputRoot !== 'string' || !isAbsolute(outputRoot)) {
    fail('OUTPUT_PATH_NOT_ABSOLUTE', 'Archive output root must be an absolute path.');
  }

  const resolvedOutputRoot = resolve(outputRoot);

  try {
    await lstat(resolvedOutputRoot);
    fail('OUTPUT_PATH_EXISTS', 'Archive output root must not already exist.');
  } catch (error) {
    if (error instanceof ElpisDawPortableArchiveError) {
      throw error;
    }

    if (error?.code !== 'ENOENT') {
      fail('OUTPUT_PATH_UNAVAILABLE', 'Archive output root could not be inspected.');
    }
  }

  const outputParent = await resolveExistingDirectory(
    dirname(resolvedOutputRoot),
    'Archive output parent',
  );
  const canonicalOutputRoot = join(outputParent, basename(resolvedOutputRoot));

  if (
    pathsOverlap(repositoryPath, canonicalOutputRoot) ||
    pathsOverlap(packageRoot, canonicalOutputRoot)
  ) {
    fail(
      'OUTPUT_PATH_OVERLAPS_SOURCE',
      'Archive output must stay outside the repository and package directory.',
    );
  }

  return canonicalOutputRoot;
}

function validateRepositoryRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.length > 1024 ||
    relativePath.startsWith('/') ||
    relativePath.endsWith('/') ||
    relativePath.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(relativePath)
  ) {
    fail('INVALID_MANIFEST_PATH', 'Release manifest contains an invalid path.');
  }

  const segments = relativePath.split('/');

  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      /[<>:"|?*]/.test(segment) ||
      WINDOWS_RESERVED_NAME_PATTERN.test(segment)
    ) {
      fail('INVALID_MANIFEST_PATH', 'Release manifest contains an unsafe path.');
    }
  }

  return relativePath;
}

function validateVersion(version) {
  if (
    typeof version !== 'string' ||
    version.length === 0 ||
    version.length > 64 ||
    !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)
  ) {
    fail('INVALID_RELEASE_VERSION', 'Portable release version is invalid.');
  }

  return version;
}

function validateArchivePolicy(policy) {
  assertExactKeys(
    policy,
    [
      'compression',
      'compressionLevel',
      'dosDate',
      'dosTime',
      'format',
      'formatVersion',
      'nodeSha256',
      'nodeVersion',
      'rootDirectoryName',
      'zlibVersion',
    ],
    'INVALID_ARCHIVE_POLICY',
    'Portable archive policy is invalid.',
  );

  if (
    policy.compression !== 'deflate' ||
    policy.compressionLevel !== 9 ||
    policy.dosDate !== 0x0021 ||
    policy.dosTime !== 0 ||
    policy.format !== 'zip' ||
    policy.formatVersion !== 1 ||
    policy.nodeSha256 !== ELPISDAW_NODE_RUNTIME.nodeSha256 ||
    policy.nodeVersion !== ELPISDAW_NODE_RUNTIME.version ||
    policy.rootDirectoryName !== ELPISDAW_PORTABLE_PACKAGE.product ||
    typeof policy.zlibVersion !== 'string' ||
    policy.zlibVersion.length === 0
  ) {
    fail('INVALID_ARCHIVE_POLICY', 'Portable archive policy changed unexpectedly.');
  }

  return policy;
}

async function inspectRepositoryBoundary(repositoryPath) {
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execFile('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryPath,
        encoding: 'utf8',
        windowsHide: true,
      }),
      execFile('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
        cwd: repositoryPath,
        encoding: 'utf8',
        windowsHide: true,
      }),
    ]);

    return { head: head.trim(), status };
  } catch {
    fail('REPOSITORY_INSPECTION_FAILED', 'The archive source repository could not be inspected.');
  }
}

function requireRepositoryBoundary(boundary, sourceCommit) {
  if (boundary?.head !== sourceCommit) {
    fail('SOURCE_COMMIT_MISMATCH', 'The archive source commit does not match HEAD.');
  }

  if (boundary.status !== '') {
    fail('REPOSITORY_NOT_CLEAN', 'The archive source repository must be clean.');
  }
}

async function listRegularFiles(rootPath) {
  const files = [];

  async function visit(relativePath) {
    const directoryPath = relativePath
      ? join(rootPath, ...relativePath.split('/'))
      : rootPath;
    const entries = (await readdir(directoryPath, { withFileTypes: true })).sort(
      (left, right) => comparePaths(left.name, right.name),
    );

    for (const entry of entries) {
      const childRelativePath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;

      validateRepositoryRelativePath(childRelativePath);

      if (entry.isSymbolicLink()) {
        fail('UNSAFE_PACKAGE_LINK', 'Portable package contains an unsupported link.');
      }

      if (entry.isDirectory()) {
        await visit(childRelativePath);
      } else if (entry.isFile()) {
        files.push(childRelativePath);
      } else {
        fail('UNSAFE_PACKAGE_FILE', 'Portable package contains an unsupported file type.');
      }
    }
  }

  await visit('');
  return files.sort(comparePaths);
}

function readPackageSourceCommit(sbom) {
  const properties = sbom?.metadata?.properties;

  if (!Array.isArray(properties)) {
    fail('INVALID_PACKAGE_SBOM', 'Portable package SBOM has no metadata properties.');
  }

  const sourceCommitProperties = properties.filter(
    (property) => property?.name === 'elpisdaw:sourceCommit',
  );

  if (
    sourceCommitProperties.length !== 1 ||
    typeof sourceCommitProperties[0].value !== 'string' ||
    !FULL_COMMIT_PATTERN.test(sourceCommitProperties[0].value)
  ) {
    fail('INVALID_PACKAGE_SBOM', 'Portable package SBOM source identity is invalid.');
  }

  return sourceCommitProperties[0].value;
}

async function inspectExactPackage(packageRoot) {
  const manifestPath = join(packageRoot, RELEASE_MANIFEST_FILE_NAME);
  await assertRegularFile(
    manifestPath,
    'Portable release manifest',
    MAXIMUM_MANIFEST_BYTES,
  );
  const manifestContent = await readFile(manifestPath);
  let manifest;

  try {
    manifest = JSON.parse(manifestContent.toString('utf8'));
  } catch {
    fail('INVALID_RELEASE_MANIFEST', 'Portable release manifest is not valid JSON.');
  }

  assertExactKeys(
    manifest,
    ['files', 'manifestVersion', 'platform', 'product', 'version'],
    'INVALID_RELEASE_MANIFEST',
    'Portable release manifest fields changed.',
  );

  if (
    manifest.manifestVersion !== ELPISDAW_PORTABLE_PACKAGE.manifestVersion ||
    manifest.platform !== ELPISDAW_PORTABLE_PACKAGE.platform ||
    manifest.product !== ELPISDAW_PORTABLE_PACKAGE.product ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    fail('INVALID_RELEASE_MANIFEST', 'Portable release manifest identity is invalid.');
  }

  const version = validateVersion(manifest.version);
  const listedPaths = [];
  let previousPath;
  let payloadSizeBytes = 0;

  for (const entry of manifest.files) {
    assertExactKeys(
      entry,
      ['path', 'sha256', 'sizeBytes'],
      'INVALID_RELEASE_MANIFEST_ENTRY',
      'Portable release manifest entry fields changed.',
    );
    const entryPath = validateRepositoryRelativePath(entry.path);

    if (
      entryPath === RELEASE_MANIFEST_FILE_NAME ||
      !SHA256_PATTERN.test(entry.sha256) ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      (previousPath !== undefined && comparePaths(previousPath, entryPath) >= 0)
    ) {
      fail('INVALID_RELEASE_MANIFEST_ENTRY', 'Portable release manifest entry is invalid.');
    }

    previousPath = entryPath;
    listedPaths.push(entryPath);
    payloadSizeBytes += entry.sizeBytes;
  }

  const actualFiles = await listRegularFiles(packageRoot);
  const actualPayloadFiles = actualFiles.filter(
    (relativePath) => relativePath !== RELEASE_MANIFEST_FILE_NAME,
  );

  if (
    actualPayloadFiles.length !== listedPaths.length ||
    actualPayloadFiles.some((relativePath, index) => relativePath !== listedPaths[index])
  ) {
    fail('PACKAGE_FILE_SET_MISMATCH', 'Portable package file set does not match its manifest.');
  }

  for (const entry of manifest.files) {
    const filePath = join(packageRoot, ...entry.path.split('/'));
    const file = await assertRegularFile(filePath, 'Manifest payload file');

    if (file.size !== entry.sizeBytes || (await sha256File(filePath)) !== entry.sha256) {
      fail('PACKAGE_FILE_MISMATCH', 'Portable package payload does not match its manifest.');
    }
  }

  const sbomPath = join(packageRoot, 'licenses', 'SBOM.cdx.json');
  let sbom;

  try {
    sbom = JSON.parse(await readFile(sbomPath, 'utf8'));
  } catch {
    fail('INVALID_PACKAGE_SBOM', 'Portable package SBOM is invalid.');
  }

  return {
    allFiles: actualFiles,
    manifest,
    manifestSha256: sha256(manifestContent),
    packageSourceCommit: readPackageSourceCommit(sbom),
    payloadFileCount: listedPaths.length,
    payloadSizeBytes,
    version,
  };
}

async function assertPinnedCompressionRuntime(packageRoot, archivePolicy) {
  const packageNodePath = join(packageRoot, 'runtime', 'node.exe');
  await assertRegularFile(packageNodePath, 'Packaged Node.js runtime');
  const [canonicalPackageNodePath, canonicalRunningNodePath] = await Promise.all([
    realpath(packageNodePath),
    realpath(process.execPath),
  ]);

  if (
    !pathsEqual(canonicalPackageNodePath, canonicalRunningNodePath) ||
    (await sha256File(canonicalPackageNodePath)) !== archivePolicy.nodeSha256 ||
    process.version !== `v${archivePolicy.nodeVersion}` ||
    process.versions.zlib !== archivePolicy.zlibVersion
  ) {
    fail(
      'PINNED_COMPRESSION_RUNTIME_REQUIRED',
      'Run the archive sealer with the exact packaged Node.js runtime.',
    );
  }
}

async function validatePackageWithLauncher({ packageRoot, resultFilePath, version }) {
  try {
    await execFile(
      join(packageRoot, 'ElpisDAW.exe'),
      [
        '--validate-only',
        '--package-root',
        packageRoot,
        '--result-file',
        resultFilePath,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
    );
    const result = await readFile(resultFilePath, 'utf8');

    if (result !== `READY\n${version}`) {
      fail('PACKAGE_VALIDATION_FAILED', 'The native launcher rejected the portable package.');
    }
  } catch (error) {
    if (error instanceof ElpisDawPortableArchiveError) {
      throw error;
    }

    fail('PACKAGE_VALIDATION_FAILED', 'The native launcher rejected the portable package.');
  }
}

async function extractArchive(archivePath, extractionRoot) {
  const systemRoot = process.env.SystemRoot;

  if (!systemRoot || !isAbsolute(systemRoot)) {
    fail('WINDOWS_RUNTIME_UNAVAILABLE', 'Windows system tools are unavailable.');
  }

  try {
    await execFile(
      join(systemRoot, 'System32', 'tar.exe'),
      ['-xf', archivePath, '-C', extractionRoot],
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
    );
  } catch {
    fail('ARCHIVE_EXTRACTION_FAILED', 'The sealed portable archive could not be extracted.');
  }
}

function comparePackageReviews(original, extracted) {
  if (
    original.manifestSha256 !== extracted.manifestSha256 ||
    original.packageSourceCommit !== extracted.packageSourceCommit ||
    original.payloadFileCount !== extracted.payloadFileCount ||
    original.payloadSizeBytes !== extracted.payloadSizeBytes ||
    original.allFiles.length !== extracted.allFiles.length ||
    original.allFiles.some((relativePath, index) => relativePath !== extracted.allFiles[index])
  ) {
    fail('EXTRACTED_PACKAGE_MISMATCH', 'Extracted portable archive changed the package.');
  }
}

export async function sealElpisDawPortableArchive({
  repositoryPath = repositoryRoot,
  sourceCommit,
  packageRoot,
  outputRoot,
  archivePolicy = ELPISDAW_PORTABLE_ARCHIVE,
  dependencies = {},
}) {
  if (process.platform !== 'win32' && dependencies.allowNonWindows !== true) {
    fail('UNSUPPORTED_BUILD_PLATFORM', 'ElpisDAW portable archives require Windows x64 release engineering.');
  }

  if (typeof sourceCommit !== 'string' || !FULL_COMMIT_PATTERN.test(sourceCommit)) {
    fail('SOURCE_COMMIT_NOT_EXACT', 'Archive sealing requires one full source commit ID.');
  }

  const checkedArchivePolicy = validateArchivePolicy(archivePolicy);
  const canonicalRepositoryPath = await resolveExistingDirectory(
    repositoryPath,
    'Archive source repository',
  );
  const canonicalPackageRoot = await resolveExistingDirectory(
    packageRoot,
    'Portable package',
  );

  if (
    basename(canonicalPackageRoot) !== checkedArchivePolicy.rootDirectoryName ||
    pathsOverlap(canonicalRepositoryPath, canonicalPackageRoot)
  ) {
    fail('INVALID_PACKAGE_ROOT', 'Portable package root is outside the archive policy.');
  }

  const canonicalOutputRoot = await resolveOutputRoot(
    outputRoot,
    canonicalPackageRoot,
    canonicalRepositoryPath,
  );
  const inspectRepository = dependencies.inspectRepositoryBoundary ?? inspectRepositoryBoundary;
  const inspectRuntime = dependencies.assertPinnedCompressionRuntime ?? assertPinnedCompressionRuntime;
  const validateWithLauncher = dependencies.validatePackageWithLauncher ?? validatePackageWithLauncher;
  const extractSealedArchive = dependencies.extractArchive ?? extractArchive;
  requireRepositoryBoundary(
    await inspectRepository(canonicalRepositoryPath),
    sourceCommit,
  );
  const originalReview = await inspectExactPackage(canonicalPackageRoot);
  await inspectRuntime(canonicalPackageRoot, checkedArchivePolicy);
  requireRepositoryBoundary(
    await inspectRepository(canonicalRepositoryPath),
    sourceCommit,
  );

  const stagingRoot = await mkdtemp(
    join(dirname(canonicalOutputRoot), '.elpisdaw-archive-staging-'),
  );
  const extractionRoot = await mkdtemp(join(tmpdir(), 'elpisdaw-archive-review-'));
  let published = false;

  try {
    const releaseRoot = join(stagingRoot, 'release');
    const evidenceRoot = join(stagingRoot, 'evidence');
    await mkdir(releaseRoot, { recursive: true });
    await mkdir(evidenceRoot, { recursive: true });
    await validateWithLauncher({
      packageRoot: canonicalPackageRoot,
      resultFilePath: join(evidenceRoot, 'source-launcher-validation.txt'),
      version: originalReview.version,
    });
    const archiveFileName =
      `ElpisDAW-${originalReview.version}-${ELPISDAW_PORTABLE_PACKAGE.platform}.zip`;
    const archivePath = join(releaseRoot, archiveFileName);
    const archiveResult = await writeDeterministicZipArchive({
      compressionLevel: checkedArchivePolicy.compressionLevel,
      dosDate: checkedArchivePolicy.dosDate,
      dosTime: checkedArchivePolicy.dosTime,
      entries: originalReview.allFiles.map((relativePath) => ({
        archivePath: `${checkedArchivePolicy.rootDirectoryName}/${relativePath}`,
        sourcePath: join(canonicalPackageRoot, ...relativePath.split('/')),
      })),
      outputPath: archivePath,
    });

    if ((await sha256File(archivePath)) !== archiveResult.archiveSha256) {
      fail('ARCHIVE_HASH_MISMATCH', 'Sealed archive hash changed after creation.');
    }

    await writeFile(
      join(releaseRoot, 'SHA256SUMS.txt'),
      `${archiveResult.archiveSha256}  ${archiveFileName}\n`,
      'utf8',
    );
    await extractSealedArchive(archivePath, extractionRoot);
    const extractedEntries = await readdir(extractionRoot, { withFileTypes: true });

    if (
      extractedEntries.length !== 1 ||
      extractedEntries[0].name !== checkedArchivePolicy.rootDirectoryName ||
      !extractedEntries[0].isDirectory() ||
      extractedEntries[0].isSymbolicLink()
    ) {
      fail('ARCHIVE_LAYOUT_MISMATCH', 'Sealed archive has an unexpected root layout.');
    }

    const extractedPackageRoot = join(
      extractionRoot,
      checkedArchivePolicy.rootDirectoryName,
    );
    const extractedReview = await inspectExactPackage(extractedPackageRoot);
    comparePackageReviews(originalReview, extractedReview);
    await validateWithLauncher({
      packageRoot: extractedPackageRoot,
      resultFilePath: join(evidenceRoot, 'extracted-launcher-validation.txt'),
      version: extractedReview.version,
    });
    const report = {
      archive: {
        compression: checkedArchivePolicy.compression,
        compressionLevel: checkedArchivePolicy.compressionLevel,
        entryCount: archiveResult.archiveEntryCount,
        fileName: archiveFileName,
        sha256: archiveResult.archiveSha256,
        sizeBytes: archiveResult.archiveSizeBytes,
      },
      archivePolicyVersion: ELPISDAW_PORTABLE_ARCHIVE_POLICY_VERSION,
      compressionRuntime: {
        nodeVersion: checkedArchivePolicy.nodeVersion,
        zlibVersion: checkedArchivePolicy.zlibVersion,
      },
      formatVersion: 1,
      package: {
        manifestSha256: originalReview.manifestSha256,
        payloadFileCount: originalReview.payloadFileCount,
        payloadSizeBytes: originalReview.payloadSizeBytes,
        sourceCommit: originalReview.packageSourceCommit,
        version: originalReview.version,
      },
      sealerSourceCommit: sourceCommit,
      status: 'READY',
    };
    await writeFile(
      join(evidenceRoot, 'archive-seal-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    requireRepositoryBoundary(
      await inspectRepository(canonicalRepositoryPath),
      sourceCommit,
    );
    await rename(stagingRoot, canonicalOutputRoot);
    published = true;

    return {
      archivePath: join(canonicalOutputRoot, 'release', archiveFileName),
      evidenceRoot: join(canonicalOutputRoot, 'evidence'),
      outputRoot: canonicalOutputRoot,
      releaseRoot: join(canonicalOutputRoot, 'release'),
      report,
    };
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });

    if (!published) {
      await rm(stagingRoot, { force: true, recursive: true });
    }
  }
}

function parseArguments(args) {
  const options = {};
  const names = new Map([
    ['--output-root', 'outputRoot'],
    ['--package-root', 'packageRoot'],
    ['--source-commit', 'sourceCommit'],
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const optionName = names.get(args[index]);

    if (!optionName || options[optionName] !== undefined) {
      fail('INVALID_ARGUMENT', 'Portable archive sealer arguments are invalid.');
    }

    if (index + 1 >= args.length || args[index + 1].trim() === '') {
      fail('MISSING_ARGUMENT_VALUE', 'Portable archive sealer argument value is missing.');
    }

    options[optionName] = args[index + 1];
    index += 1;
  }

  for (const requiredName of ['outputRoot', 'packageRoot', 'sourceCommit']) {
    if (options[requiredName] === undefined) {
      fail('MISSING_ARGUMENT', 'Portable archive sealer requires source, package, and output arguments.');
    }
  }

  return options;
}

async function main() {
  try {
    const result = await sealElpisDawPortableArchive(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(`ElpisDAW portable archive ready: ${result.outputRoot}\n`);
  } catch (error) {
    const code = error instanceof ElpisDawPortableArchiveError
      ? error.code
      : 'UNEXPECTED_FAILURE';
    const message = error instanceof ElpisDawPortableArchiveError
      ? error.message
      : 'ElpisDAW portable archive sealing failed unexpectedly.';
    process.stderr.write(`ERROR ${code}: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
