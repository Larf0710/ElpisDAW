import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  sealElpisDawPortableArchive,
} from './Seal-ElpisDawPortableArchive.mjs';
import { ELPISDAW_PORTABLE_PACKAGE } from './elpisDawPortablePackagePolicy.mjs';

const execFile = promisify(execFileCallback);
const PACKAGE_SOURCE_COMMIT = 'a'.repeat(40);
const SEALER_SOURCE_COMMIT = 'b'.repeat(40);
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe.runIf(process.platform === 'win32')('ElpisDAW portable archive sealer', () => {
  it('writes byte-identical ZIP archives with exact checksums and extracted validation', async () => {
    const fixture = await createFixture();
    const first = await sealFixture(fixture, join(fixture.root, 'first'));
    const second = await sealFixture(fixture, join(fixture.root, 'second'));
    const firstArchive = await readFile(first.archivePath);
    const secondArchive = await readFile(second.archivePath);

    expect(sha256(firstArchive)).toBe(sha256(secondArchive));
    expect(firstArchive.equals(secondArchive)).toBe(true);
    expect(first.report).toMatchObject({
      archive: {
        compression: 'deflate',
        compressionLevel: 9,
        entryCount: 6,
        sha256: sha256(firstArchive),
        sizeBytes: firstArchive.length,
      },
      package: {
        payloadFileCount: 5,
        sourceCommit: PACKAGE_SOURCE_COMMIT,
        version: ELPISDAW_PORTABLE_PACKAGE.version,
      },
      sealerSourceCommit: SEALER_SOURCE_COMMIT,
      status: 'READY',
    });
    expect(firstArchive.readUInt32LE(0)).toBe(0x04034b50);
    expect(firstArchive.readUInt16LE(10)).toBe(0);
    expect(firstArchive.readUInt16LE(12)).toBe(0x0021);
    expect(firstArchive.readUInt16LE(28)).toBe(0);
    const checksum = await readFile(
      join(first.releaseRoot, 'SHA256SUMS.txt'),
      'utf8',
    );
    expect(checksum).toBe(
      `${first.report.archive.sha256}  ${first.report.archive.fileName}\n`,
    );
    const reportText = await readFile(
      join(first.evidenceRoot, 'archive-seal-report.json'),
      'utf8',
    );
    expect(reportText).not.toMatch(/\b[A-Za-z]:\\/);
    expect(fixture.validationCalls).toHaveLength(4);
    const { stdout: archiveListing } = await execFile(
      join(process.env.SystemRoot, 'System32', 'tar.exe'),
      ['-tf', first.archivePath],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(archiveListing.trim().split(/\r?\n/)).toEqual([
      'ElpisDAW/app/ui/index.html',
      'ElpisDAW/ElpisDAW.exe',
      'ElpisDAW/licenses/ElpisDAW-LICENSE.txt',
      'ElpisDAW/licenses/SBOM.cdx.json',
      'ElpisDAW/release-manifest.json',
      'ElpisDAW/runtime/node.exe',
    ]);
  }, 30_000);

  it('rejects payload drift before creating archive output', async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.packageRoot, 'app', 'ui', 'index.html'),
      '<title>Changed</title>\n',
      'utf8',
    );
    const outputRoot = join(fixture.root, 'tampered');

    await expect(sealFixture(fixture, outputRoot)).rejects.toMatchObject({
      code: 'PACKAGE_FILE_MISMATCH',
    });
    await expect(access(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the exact packaged Node and zlib runtime by default', async () => {
    const fixture = await createFixture();
    const outputRoot = join(fixture.root, 'wrong-runtime');

    const sealing = sealElpisDawPortableArchive({
      dependencies: {
        inspectRepositoryBoundary: fixture.dependencies.inspectRepositoryBoundary,
      },
      outputRoot,
      packageRoot: fixture.packageRoot,
      repositoryPath: fixture.repositoryPath,
      sourceCommit: SEALER_SOURCE_COMMIT,
    });
    await expect(sealing).rejects.toMatchObject({
      code: 'PINNED_COMPRESSION_RUNTIME_REQUIRED',
      name: 'ElpisDawPortableArchiveError',
    });
    await expect(access(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects existing and source-overlapping output without mutation', async () => {
    const fixture = await createFixture();
    const existingOutput = join(fixture.root, 'existing');
    await mkdir(existingOutput);
    await writeFile(join(existingOutput, 'keep.txt'), 'keep\n', 'utf8');

    await expect(sealFixture(fixture, existingOutput)).rejects.toMatchObject({
      code: 'OUTPUT_PATH_EXISTS',
    });
    await expect(
      sealFixture(fixture, join(fixture.repositoryPath, 'archive')),
    ).rejects.toMatchObject({ code: 'OUTPUT_PATH_OVERLAPS_SOURCE' });
    await expect(readFile(join(existingOutput, 'keep.txt'), 'utf8')).resolves.toBe('keep\n');
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'elpisdaw-archive-sealer-'));
  temporaryDirectories.add(root);
  const repositoryPath = join(root, 'repository');
  const packageRoot = join(root, 'package', 'ElpisDAW');
  await mkdir(repositoryPath, { recursive: true });
  await writeFixtureFile(packageRoot, 'ElpisDAW.exe', 'fixture launcher\n');
  await writeFixtureFile(packageRoot, 'app/ui/index.html', '<title>ElpisDAW</title>\n');
  await writeFixtureFile(packageRoot, 'licenses/ElpisDAW-LICENSE.txt', 'MPL-2.0\n');
  await writeFixtureFile(
    packageRoot,
    'licenses/SBOM.cdx.json',
    `${JSON.stringify({
      metadata: {
        properties: [
          { name: 'elpisdaw:sourceCommit', value: PACKAGE_SOURCE_COMMIT },
        ],
      },
    }, null, 2)}\n`,
  );
  await writeFixtureFile(packageRoot, 'runtime/node.exe', 'fixture node\n');
  await createReleaseManifest(packageRoot);
  const validationCalls = [];

  return {
    dependencies: {
      assertPinnedCompressionRuntime: async () => {},
      inspectRepositoryBoundary: async () => ({
        head: SEALER_SOURCE_COMMIT,
        status: '',
      }),
      validatePackageWithLauncher: async (options) => {
        validationCalls.push(options);
        await writeFile(
          options.resultFilePath,
          `READY\n${options.version}`,
          'utf8',
        );
      },
    },
    packageRoot,
    repositoryPath,
    root,
    validationCalls,
  };
}

async function sealFixture(fixture, outputRoot) {
  return sealElpisDawPortableArchive({
    dependencies: fixture.dependencies,
    outputRoot,
    packageRoot: fixture.packageRoot,
    repositoryPath: fixture.repositoryPath,
    sourceCommit: SEALER_SOURCE_COMMIT,
  });
}

async function createReleaseManifest(packageRoot) {
  const relativePaths = [
    'ElpisDAW.exe',
    'app/ui/index.html',
    'licenses/ElpisDAW-LICENSE.txt',
    'licenses/SBOM.cdx.json',
    'runtime/node.exe',
  ].sort((left, right) => left.localeCompare(right, 'en'));
  const files = [];

  for (const relativePath of relativePaths) {
    const content = await readFile(
      join(packageRoot, ...relativePath.split('/')),
    );
    files.push({
      path: relativePath,
      sha256: sha256(content),
      sizeBytes: content.length,
    });
  }

  await writeFixtureFile(
    packageRoot,
    'release-manifest.json',
    `${JSON.stringify({
      files,
      manifestVersion: ELPISDAW_PORTABLE_PACKAGE.manifestVersion,
      platform: ELPISDAW_PORTABLE_PACKAGE.platform,
      product: ELPISDAW_PORTABLE_PACKAGE.product,
      version: ELPISDAW_PORTABLE_PACKAGE.version,
    }, null, 2)}\n`,
  );
}

async function writeFixtureFile(rootPath, relativePath, content) {
  const filePath = join(rootPath, ...relativePath.split('/'));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}
