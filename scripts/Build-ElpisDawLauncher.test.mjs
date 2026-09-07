import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDirectory, '..');
const launcherPath = join(projectRoot, 'engine', 'bin', 'ElpisDAW.exe');
const buildScriptPath = join(projectRoot, 'scripts', 'Build-ElpisDawLauncher.ps1');
const directoryPickerBuildScriptPath = join(
  projectRoot,
  'scripts',
  'Build-WindowsDirectoryPicker.ps1',
);
const directoryPickerPath = join(
  projectRoot,
  'engine',
  'bin',
  'HumStudio.DirectoryPicker.exe',
);
const temporaryDirectories = new Set();
const windowsPowerShellPath = process.env.SystemRoot
  ? join(
      process.env.SystemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
  : 'powershell.exe';

async function buildNativeBinaries() {
  await execFileAsync(
    windowsPowerShellPath,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', directoryPickerBuildScriptPath],
    { cwd: projectRoot, windowsHide: true },
  );
  await execFileAsync(
    windowsPowerShellPath,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', buildScriptPath],
    { cwd: projectRoot, windowsHide: true },
  );
}

beforeAll(async () => {
  if (process.platform !== 'win32') {
    return;
  }

  await buildNativeBinaries();
}, 30_000);

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe.runIf(process.platform === 'win32')('ElpisDAW native launcher manifest validation', () => {
  it('rebuilds both native executables byte-for-byte deterministically', async () => {
    const firstLauncher = await readFile(launcherPath);
    const firstDirectoryPicker = await readFile(directoryPickerPath);

    await buildNativeBinaries();

    await expect(readFile(launcherPath)).resolves.toEqual(firstLauncher);
    await expect(readFile(directoryPickerPath)).resolves.toEqual(firstDirectoryPicker);
  }, 30_000);

  it('accepts an exact package with every required file and hash', async () => {
    const fixture = await createPackageFixture();
    const result = await validatePackage(fixture.packageRoot, fixture.resultFilePath);

    expect(result.exitCode).toBe(0);
    expect(result.text).toBe('READY\n0.1.0-preview.1');
  });

  it('rejects a package file changed after manifest creation', async () => {
    const fixture = await createPackageFixture();
    await appendFile(join(fixture.packageRoot, 'runtime', 'node.exe'), 'tampered', 'utf8');
    const result = await validatePackage(fixture.packageRoot, fixture.resultFilePath);

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain('ERROR\nRelease package size mismatch: runtime/node.exe');
  });

  it('rejects unlisted files and unsafe manifest paths', async () => {
    const unlistedFixture = await createPackageFixture();
    await writeFile(join(unlistedFixture.packageRoot, 'unlisted.txt'), 'extra\n', 'utf8');
    const unlistedResult = await validatePackage(
      unlistedFixture.packageRoot,
      unlistedFixture.resultFilePath,
    );

    expect(unlistedResult.exitCode).toBe(1);
    expect(unlistedResult.text).toContain(
      'ERROR\nRelease package file set does not match release-manifest.json.',
    );

    const unsafeFixture = await createPackageFixture();
    const manifestPath = join(unsafeFixture.packageRoot, 'release-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files[0].path = '../outside.exe';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const unsafeResult = await validatePackage(
      unsafeFixture.packageRoot,
      unsafeFixture.resultFilePath,
    );

    expect(unsafeResult.exitCode).toBe(1);
    expect(unsafeResult.text).toContain(
      'ERROR\nrelease-manifest.json contains an unsafe file path.',
    );
  });

  it('rejects unreviewed manifest fields', async () => {
    const fixture = await createPackageFixture();
    const manifestPath = join(fixture.packageRoot, 'release-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.unreviewed = true;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const result = await validatePackage(fixture.packageRoot, fixture.resultFilePath);

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain('ERROR\nrelease-manifest.json has an unexpected field set.');
  });

  it('rejects non-numeric sizes instead of applying permissive .NET conversion', async () => {
    const fixture = await createPackageFixture();
    const manifestPath = join(fixture.packageRoot, 'release-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files[0].sizeBytes = true;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const result = await validatePackage(fixture.packageRoot, fixture.resultFilePath);

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain(
      'ERROR\nrelease-manifest.json file row contains an invalid sizeBytes.',
    );
  });

  it('starts the real Local Engine, verifies readiness, and terminates it with the job', async () => {
    const fixture = await createRunnablePackageFixture();
    const result = await runLauncherTest(
      fixture.packageRoot,
      fixture.resultFilePath,
      '--smoke-test',
      {
        ...process.env,
        HUMSTUDIO_LOG_LEVEL: 'error',
        LOCALAPPDATA: fixture.localAppDataRoot,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/^READY\n0\.1\.0-preview\.1\nENGINE_ORIGIN=http:\/\/127\.0\.0\.1:\d+$/);
    expect(result.text).not.toContain(fixture.packageRoot);

    const engineOrigin = result.text.split('ENGINE_ORIGIN=', 2)[1];
    await expect(
      fetch(`${engineOrigin}/api/v1/health`, { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toThrow();
  }, 30_000);
});

async function createPackageFixture() {
  const packageRoot = await createTemporaryDirectory('elpisdaw-launcher-package-');
  const resultRoot = await createTemporaryDirectory('elpisdaw-launcher-result-');
  const files = new Map([
    ['app/engine/server.mjs', Buffer.from('export {};\n')],
    ['app/ui/elpisdaw-icon.png', Buffer.from('web-icon-fixture\n')],
    ['app/ui/index.html', Buffer.from('<title>ElpisDAW</title>\n')],
    ['licenses/ElpisDAW-LICENSE.txt', Buffer.from('MPL-2.0 fixture\n')],
    ['licenses/ElpisDAW-TRADEMARKS.md', Buffer.from('Trademark policy fixture\n')],
    ['licenses/THIRD_PARTY_NOTICES.md', Buffer.from('# Notices\n')],
    ['native/HumStudio.DirectoryPicker.exe', Buffer.from('directory-picker-fixture\n')],
    ['runtime/LICENSE', Buffer.from('Node.js license fixture\n')],
    ['runtime/node.exe', Buffer.from('node-runtime-fixture\n')],
    ['runtime/THIRD_PARTY_NOTICES/node.txt', Buffer.from('Node.js notices fixture\n')],
  ]);

  await copyFile(launcherPath, join(packageRoot, 'ElpisDAW.exe'));

  for (const [relativePath, bytes] of files) {
    const absolutePath = join(packageRoot, ...relativePath.split('/'));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
  }

  const manifestEntries = [];
  const packageFilePaths = ['ElpisDAW.exe', ...files.keys()].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );

  for (const relativePath of packageFilePaths) {
    const bytes = await readFile(join(packageRoot, ...relativePath.split('/')));
    manifestEntries.push({
      path: relativePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    });
  }

  await writeFile(
    join(packageRoot, 'release-manifest.json'),
    `${JSON.stringify(
      {
        files: manifestEntries,
        manifestVersion: 1,
        platform: 'windows-x64',
        product: 'ElpisDAW',
        version: '0.1.0-preview.1',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    packageRoot,
    resultFilePath: join(resultRoot, 'validation.result'),
  };
}

async function createRunnablePackageFixture() {
  const packageRoot = await createTemporaryDirectory('elpisdaw-launcher-runtime-package-');
  const resultRoot = await createTemporaryDirectory('elpisdaw-launcher-runtime-result-');
  const localAppDataRoot = await createTemporaryDirectory('elpisdaw-launcher-local-app-data-');

  await copyFile(launcherPath, join(packageRoot, 'ElpisDAW.exe'));
  await mkdir(join(packageRoot, 'native'), { recursive: true });
  await copyFile(
    directoryPickerPath,
    join(packageRoot, 'native', 'HumStudio.DirectoryPicker.exe'),
  );
  await mkdir(join(packageRoot, 'runtime'), { recursive: true });
  await copyFile(process.execPath, join(packageRoot, 'runtime', 'node.exe'));
  await copySelectedTree(
    join(projectRoot, 'engine'),
    join(packageRoot, 'app', 'engine'),
    (relativePath, isDirectory) => {
      const firstSegment = relativePath.split('/', 1)[0];

      if (isDirectory) {
        return firstSegment !== 'bin' && firstSegment !== 'windows';
      }

      return (
        !relativePath.endsWith('.test.mjs') &&
        !relativePath.endsWith('.fixture.mjs') &&
        /\.(mjs|py|txt)$/.test(relativePath)
      );
    },
  );
  await copySelectedTree(
    join(projectRoot, 'shared'),
    join(packageRoot, 'app', 'shared'),
    (relativePath, isDirectory) =>
      isDirectory ||
      (!relativePath.includes('.test.') && /\.(js|json)$/.test(relativePath)),
  );
  await writePackageFile(
    packageRoot,
    'app/ui/index.html',
    '<!doctype html><title>ElpisDAW launcher smoke fixture</title>\n',
  );
  await writePackageFile(
    packageRoot,
    'app/ui/elpisdaw-icon.png',
    'web icon fixture\n',
  );
  await mkdir(join(packageRoot, 'licenses'), { recursive: true });
  await copyFile(
    join(projectRoot, 'LICENSE'),
    join(packageRoot, 'licenses', 'ElpisDAW-LICENSE.txt'),
  );
  await copyFile(
    join(projectRoot, 'TRADEMARKS.md'),
    join(packageRoot, 'licenses', 'ElpisDAW-TRADEMARKS.md'),
  );
  await writePackageFile(
    packageRoot,
    'licenses/THIRD_PARTY_NOTICES.md',
    '# Internal launcher smoke notices\n',
  );
  await writePackageFile(packageRoot, 'runtime/LICENSE', 'Internal Node.js license fixture\n');
  await writePackageFile(
    packageRoot,
    'runtime/THIRD_PARTY_NOTICES/node.txt',
    'Internal Node.js notice fixture\n',
  );
  await writeReleaseManifest(packageRoot);

  return {
    localAppDataRoot,
    packageRoot,
    resultFilePath: join(resultRoot, 'smoke.result'),
  };
}

async function validatePackage(packageRoot, resultFilePath) {
  return runLauncherTest(packageRoot, resultFilePath, '--validate-only');
}

async function runLauncherTest(
  packageRoot,
  resultFilePath,
  mode,
  environment = process.env,
) {
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const child = spawn(
      launcherPath,
      [
        mode,
        '--package-root',
        packageRoot,
        '--result-file',
        resultFilePath,
      ],
      { env: environment, stdio: 'ignore', windowsHide: true },
    );

    child.once('error', rejectExit);
    child.once('close', (code) => resolveExit(code ?? 1));
  });

  return {
    exitCode,
    text: await readFile(resultFilePath, 'utf8'),
  };
}

async function writeReleaseManifest(packageRoot) {
  const packageFilePaths = (await listFiles(packageRoot))
    .filter((relativePath) => relativePath !== 'release-manifest.json')
    .sort((left, right) => left.localeCompare(right, 'en'));
  const files = [];

  for (const relativePath of packageFilePaths) {
    const bytes = await readFile(join(packageRoot, ...relativePath.split('/')));
    files.push({
      path: relativePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    });
  }

  await writeFile(
    join(packageRoot, 'release-manifest.json'),
    `${JSON.stringify(
      {
        files,
        manifestVersion: 1,
        platform: 'windows-x64',
        product: 'ElpisDAW',
        version: '0.1.0-preview.1',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function copySelectedTree(sourceRoot, destinationRoot, include) {
  async function visit(relativePath) {
    const sourceDirectory = relativePath
      ? join(sourceRoot, ...relativePath.split('/'))
      : sourceRoot;
    const entries = await readdir(sourceDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (!include(childRelativePath, entry.isDirectory())) {
        continue;
      }

      const sourcePath = join(sourceRoot, ...childRelativePath.split('/'));
      const destinationPath = join(destinationRoot, ...childRelativePath.split('/'));

      if (entry.isDirectory()) {
        await mkdir(destinationPath, { recursive: true });
        await visit(childRelativePath);
      } else if (entry.isFile()) {
        await mkdir(dirname(destinationPath), { recursive: true });
        await copyFile(sourcePath, destinationPath);
      }
    }
  }

  await mkdir(destinationRoot, { recursive: true });
  await visit('');
}

async function listFiles(rootPath) {
  const files = [];

  async function visit(relativePath) {
    const directoryPath = relativePath
      ? join(rootPath, ...relativePath.split('/'))
      : rootPath;
    const entries = await readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await visit(childRelativePath);
      } else if (entry.isFile()) {
        files.push(childRelativePath);
      }
    }
  }

  await visit('');
  return files;
}

async function writePackageFile(packageRoot, relativePath, content) {
  const absolutePath = join(packageRoot, ...relativePath.split('/'));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
}

async function createTemporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}
