import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ElpisDawPortablePackageError,
  materializeElpisDawPortablePackage,
} from './Materialize-ElpisDawPortablePackage.mjs';

const execFile = promisify(execFileCallback);
const SOURCE_COMMIT = 'a'.repeat(40);
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe.runIf(process.platform === 'win32')('ElpisDAW portable package materializer', () => {
  it('materializes one deterministic exact package with notices, SBOM, and evidence', async () => {
    const fixture = await createFixture();
    const first = await materializeFixture(fixture, join(fixture.root, 'first'));
    const second = await materializeFixture(fixture, join(fixture.root, 'second'));

    expect(first.report).toMatchObject({
      packagePolicyVersion: expect.any(String),
      platform: 'windows-x64',
      product: 'ElpisDAW',
      sourceCommit: SOURCE_COMMIT,
      signing: { status: 'UNSIGNED_INTERNAL' },
      stabilityAiProductUse: {
        attributionText: 'Powered by Stability AI',
        commercialRegistrationStatus: 'NOT_VERIFIED',
      },
      status: 'READY',
      version: '0.1.0-preview.1',
    });
    expect(first.report.manifest.payloadFileCount).toBeGreaterThan(10);
    expect(first.manifest.files.map((entry) => entry.path)).toEqual(
      [...first.manifest.files.map((entry) => entry.path)].sort((left, right) =>
        left.localeCompare(right, 'en'),
      ),
    );
    expect(first.manifest.files).toEqual(second.manifest.files);
    expect(await snapshotTree(first.outputRoot)).toEqual(
      await snapshotTree(second.outputRoot),
    );
    expect(fixture.buildCalls).toHaveLength(2);
    expect(
      fixture.buildCalls.every(
        (path) => path.toLowerCase() === fixture.repositoryPath.toLowerCase(),
      ),
    ).toBe(true);
    expect(fixture.validationCalls).toHaveLength(2);

    const packageFiles = (await listFiles(first.packageRoot)).sort();
    expect(packageFiles).toEqual(
      expect.arrayContaining([
        'ElpisDAW.exe',
        'app/engine/server.mjs',
        'app/engine/providers/runtime.py',
        'app/shared/protocol.js',
        'app/ui/index.html',
        'licenses/AI_GENERATED_OUTPUT_NOTICE.md',
        'licenses/ElpisDAW-LICENSE.txt',
        'licenses/SBOM.cdx.json',
        'licenses/STABILITY_AI_NOTICE.txt',
        'licenses/Stability-AI-Community-License.md',
        'licenses/THIRD_PARTY_NOTICES.md',
        'native/HumStudio.DirectoryPicker.exe',
        'release-manifest.json',
        'runtime/LICENSE',
        'runtime/THIRD_PARTY_NOTICES/Node.js-LICENSE.txt',
        'runtime/node.exe',
      ]),
    );
    expect(packageFiles.some((path) => /(?:test|fixture|node_modules|\.map)/i.test(path))).toBe(false);
    expect(packageFiles.some((path) => path.includes('__pycache__'))).toBe(false);
    expect(packageFiles).not.toContain(
      'app/shared/projectPlaybackAudioWorkletCases.js',
    );
    expect(packageFiles.some((path) => path.endsWith('.d.ts'))).toBe(false);
    const notices = await readFile(
      join(first.packageRoot, 'licenses', 'THIRD_PARTY_NOTICES.md'),
      'utf8',
    );
    expect(notices).toContain('Optional AI Providers, model weights, Python environments, FluidSynth, and SoundFonts are not bundled.');
    expect(notices).toContain(fixture.runtimePolicy.archiveSha256);
    expect(notices).toContain('Powered by Stability AI');
    expect(notices).toContain(fixture.stabilityAiProductUsePolicy.agreementSourceUrl);
    const outputNotice = await readFile(
      join(first.packageRoot, 'licenses', 'AI_GENERATED_OUTPUT_NOTICE.md'),
      'utf8',
    );
    expect(outputNotice).toContain('ElpisDAW does not grant rights in AI-generated output');
    expect(outputNotice).toContain('V0.1 ACE-Step 1.5 compatibility target');
    await expect(
      readFile(
        join(first.packageRoot, 'licenses', 'Stability-AI-Community-License.md'),
      ),
    ).resolves.toEqual(fixture.stabilityAiAgreementBytes);
    await expect(
      readFile(
        join(first.packageRoot, 'licenses', 'STABILITY_AI_NOTICE.txt'),
        'utf8',
      ),
    ).resolves.toBe(`${fixture.stabilityAiProductUsePolicy.noticeText}\n`);
    const sbom = JSON.parse(
      await readFile(join(first.packageRoot, 'licenses', 'SBOM.cdx.json'), 'utf8'),
    );
    expect(sbom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6' });
    expect(sbom.components.map((component) => component.name)).toEqual([
      'Node.js',
      'react',
      'react-dom',
      'scheduler',
    ]);
    const serializedReport = await readFile(
      join(first.evidenceRoot, 'materialization-report.json'),
      'utf8',
    );
    expect(serializedReport).not.toMatch(/\b[A-Za-z]:\\/);
  }, 30_000);

  it('signs only staged native copies before manifest creation and records provenance', async () => {
    const fixture = await createFixture();
    const signToolPath = join(fixture.root, 'sign-tools', 'signtool.exe');
    await writeFixtureFile(fixture.root, 'sign-tools/signtool.exe', 'fixture sign tool\n');
    const signing = {
      certificateStore: 'current-user',
      certificateThumbprint: 'ab'.repeat(20),
      signToolPath,
      signToolSha256: sha256(await readFile(signToolPath)),
      timestampUrl: 'https://timestamp.example.test',
    };
    const signingCalls = [];
    fixture.dependencies.signPackageNativeBinaries = async (options) => {
      signingCalls.push(options);
      await appendFile(join(options.packageRoot, 'ElpisDAW.exe'), 'signed\n', 'utf8');
      await appendFile(
        join(options.packageRoot, 'native', 'HumStudio.DirectoryPicker.exe'),
        'signed\n',
        'utf8',
      );
      return {
        certificateNotAfter: '2030-01-01T00:00:00.000Z',
        certificateStore: options.signing.certificateStore,
        certificateThumbprint: options.signing.certificateThumbprint,
        signerSubject: 'CN=Fixture Code Signing',
        signToolFileName: 'signtool.exe',
        signToolSha256: options.signing.signToolSha256,
        status: 'SIGNED',
        timestamped: true,
        timestampUrl: options.signing.timestampUrl,
      };
    };

    const result = await materializeFixture(fixture, join(fixture.root, 'signed'), {
      signing,
    });

    expect(signingCalls).toHaveLength(1);
    expect(signingCalls[0].signing.certificateThumbprint).toBe('AB'.repeat(20));
    expect(signingCalls[0].packageRoot).toMatch(/[\\/]ElpisDAW$/);
    expect(signingCalls[0].packageRoot.startsWith(fixture.repositoryPath)).toBe(false);
    expect(result.report.signing).toMatchObject({
      certificateStore: 'current-user',
      certificateThumbprint: 'AB'.repeat(20),
      signerSubject: 'CN=Fixture Code Signing',
      status: 'SIGNED',
      timestamped: true,
      timestampUrl: 'https://timestamp.example.test/',
    });
    expect(await readFile(join(result.packageRoot, 'ElpisDAW.exe'), 'utf8')).toBe(
      'launcher\nsigned\n',
    );
    expect(
      await readFile(
        join(result.packageRoot, 'native', 'HumStudio.DirectoryPicker.exe'),
        'utf8',
      ),
    ).toBe('directory picker\nsigned\n');
    expect(
      await readFile(join(fixture.repositoryPath, 'engine', 'bin', 'ElpisDAW.exe'), 'utf8'),
    ).toBe('launcher\n');
    await assertExactManifest(result.packageRoot);
  });

  it('rejects incomplete signing evidence and removes staging output', async () => {
    const fixture = await createFixture();
    const signToolPath = join(fixture.root, 'sign-tools', 'signtool.exe');
    await writeFixtureFile(fixture.root, 'sign-tools/signtool.exe', 'fixture sign tool\n');
    fixture.dependencies.signPackageNativeBinaries = async () => ({ status: 'SIGNED' });
    const outputRoot = join(fixture.root, 'rejected-signing');

    await expect(
      materializeFixture(fixture, outputRoot, {
        signing: {
          certificateStore: 'local-machine',
          certificateThumbprint: '12'.repeat(20),
          signToolPath,
          signToolSha256: sha256(await readFile(signToolPath)),
          timestampUrl: 'https://timestamp.example.test',
        },
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_SIGNING_EVIDENCE_INVALID' });
    await expect(access(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await readdir(fixture.root)).some((name) =>
        name.startsWith('.elpisdaw-portable-staging-'),
      ),
    ).toBe(false);
  });

  it('rejects a changed runtime archive before building or creating output', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.nodeArchivePath, Buffer.from('changed archive'));
    const outputRoot = join(fixture.root, 'rejected-runtime');

    await expect(materializeFixture(fixture, outputRoot)).rejects.toMatchObject({
      code: 'NODE_ARCHIVE_PROVENANCE_MISMATCH',
    });
    expect(fixture.buildCalls).toEqual([]);
    await expect(access(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a changed Stability AI agreement before building or creating output', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.stabilityAiAgreementPath, Buffer.from('changed agreement'));
    const outputRoot = join(fixture.root, 'rejected-stability-agreement');

    await expect(materializeFixture(fixture, outputRoot)).rejects.toMatchObject({
      code: 'STABILITY_AI_AGREEMENT_PROVENANCE_MISMATCH',
    });
    expect(fixture.buildCalls).toEqual([]);
    await expect(access(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed for an unreviewed production source file and removes staging output', async () => {
    const fixture = await createFixture();
    await writeFixtureFile(fixture.repositoryPath, 'engine/unreviewed.md', '# Unexpected\n');
    const outputRoot = join(fixture.root, 'rejected-source');

    await expect(materializeFixture(fixture, outputRoot)).rejects.toMatchObject({
      code: 'UNREVIEWED_SOURCE_FILE',
    });
    await expect(access(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await readdir(fixture.root)).some((name) =>
        name.startsWith('.elpisdaw-portable-staging-'),
      ),
    ).toBe(false);
  });

  it('does not publish when the exact source boundary changes after package validation', async () => {
    const fixture = await createFixture();
    const outputRoot = join(fixture.root, 'changed-source');
    let inspectionCount = 0;
    fixture.dependencies.inspectRepositoryBoundary = async () => {
      inspectionCount += 1;
      return {
        head: SOURCE_COMMIT,
        status: inspectionCount === 3 ? ' M src/App.tsx\n' : '',
      };
    };

    await expect(materializeFixture(fixture, outputRoot)).rejects.toMatchObject({
      code: 'REPOSITORY_NOT_CLEAN',
    });
    expect(inspectionCount).toBe(3);
    await expect(access(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await readdir(fixture.root)).some((name) =>
        name.startsWith('.elpisdaw-portable-staging-'),
      ),
    ).toBe(false);
  });

  it('rejects existing and repository-overlapping output roots without changing them', async () => {
    const fixture = await createFixture();
    const existingOutput = join(fixture.root, 'existing-output');
    await mkdir(existingOutput);
    await writeFile(join(existingOutput, 'keep.txt'), 'keep\n', 'utf8');

    await expect(materializeFixture(fixture, existingOutput)).rejects.toMatchObject({
      code: 'OUTPUT_PATH_EXISTS',
    });
    await expect(
      materializeFixture(fixture, join(fixture.repositoryPath, 'portable')),
    ).rejects.toMatchObject({ code: 'OUTPUT_PATH_OVERLAPS_REPOSITORY' });
    await expect(readFile(join(existingOutput, 'keep.txt'), 'utf8')).resolves.toBe('keep\n');
  });
});

async function createFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'elpisdaw-portable-materializer-')),
  );
  temporaryDirectories.add(root);
  const repositoryPath = join(root, 'repository');
  const runtimeSourceParent = join(root, 'runtime-source');
  const runtimeVersion = '9.9.9';
  const runtimeRootName = `node-v${runtimeVersion}-win-x64`;
  const runtimeRoot = join(runtimeSourceParent, runtimeRootName);
  const nodeBytes = Buffer.from('fixture-node-executable\n');
  const nodeLicense = Buffer.from('Fixture Node.js license and notices\n');
  const componentLicense = Buffer.from('Fixture MIT license\n');
  const stabilityAiAgreementBytes = Buffer.from(
    'Fixture Stability AI Community License Agreement\n',
  );
  const components = [
    { name: 'react', version: '18.3.1' },
    { name: 'react-dom', version: '18.3.1' },
    { name: 'scheduler', version: '0.23.2' },
  ].map(({ name, version }) => ({
    license: 'MIT',
    licenseSha256: sha256(componentLicense),
    name,
    purl: `pkg:npm/${name}@${version}`,
    version,
  }));

  await writeFixtureFile(repositoryPath, 'LICENSE', 'Fixture MPL-2.0 license\n');
  await writeFixtureFile(
    repositoryPath,
    'docs/AI_Generated_Output_Notice.md',
    [
      '# AI-Generated Output Notice',
      '',
      'ElpisDAW does not grant rights in AI-generated output.',
      'V0.1 ACE-Step 1.5 compatibility target.',
      '',
    ].join('\n'),
  );
  await writeFixtureFile(repositoryPath, 'engine/bin/ElpisDAW.exe', 'launcher\n');
  await writeFixtureFile(
    repositoryPath,
    'engine/bin/HumStudio.DirectoryPicker.exe',
    'directory picker\n',
  );
  await writeFixtureFile(repositoryPath, 'engine/server.mjs', 'export {};\n');
  await writeFixtureFile(repositoryPath, 'engine/runtime.mjs', 'export {};\n');
  await writeFixtureFile(repositoryPath, 'engine/runtime.test.mjs', 'throw new Error();\n');
  await writeFixtureFile(repositoryPath, 'engine/projectMixdownTestFixtures.mjs', 'export {};\n');
  await writeFixtureFile(repositoryPath, 'engine/providers/runtime.py', 'pass\n');
  await writeFixtureFile(repositoryPath, 'engine/providers/runtime.txt', 'runtime\n');
  await writeFixtureFile(
    repositoryPath,
    'engine/providers/__pycache__/runtime.cpython-311.pyc',
    Buffer.from([0x00, 0x01, 0x02]),
  );
  await writeFixtureFile(repositoryPath, 'engine/windows/source.cs', 'class Fixture {}\n');
  await writeFixtureFile(repositoryPath, 'shared/protocol.js', 'export {};\n');
  await writeFixtureFile(repositoryPath, 'shared/protocol.d.ts', 'export {};\n');
  await writeFixtureFile(repositoryPath, 'shared/protocol.test.ts', 'export {};\n');
  await writeFixtureFile(
    repositoryPath,
    'shared/projectPlaybackAudioWorkletCases.js',
    'export {};\n',
  );
  await writeFixtureFile(repositoryPath, 'dist/index.html', '<title>ElpisDAW</title>\n');
  await writeFixtureFile(repositoryPath, 'dist/assets/index.js', 'console.log("ready");\n');
  await writeFixtureFile(repositoryPath, 'dist/assets/index.css', ':root {}\n');

  for (const component of components) {
    await writeFixtureFile(
      repositoryPath,
      `node_modules/${component.name}/package.json`,
      `${JSON.stringify({
        license: component.license,
        name: component.name,
        version: component.version,
      })}\n`,
    );
    await writeFixtureFile(
      repositoryPath,
      `node_modules/${component.name}/LICENSE`,
      componentLicense,
    );
  }

  await writeFixtureFile(runtimeRoot, 'node.exe', nodeBytes);
  await writeFixtureFile(runtimeRoot, 'LICENSE', nodeLicense);
  const nodeArchivePath = join(root, `node-v${runtimeVersion}-win-x64.zip`);
  const tarPath = join(process.env.SystemRoot, 'System32', 'tar.exe');
  await execFile(
    tarPath,
    ['-a', '-cf', nodeArchivePath, '-C', runtimeSourceParent, runtimeRootName],
    { windowsHide: true },
  );
  const runtimePolicy = {
    archiveFileName: `node-v${runtimeVersion}-win-x64.zip`,
    archiveRootName: runtimeRootName,
    archiveSha256: sha256(await readFile(nodeArchivePath)),
    nodeSha256: sha256(nodeBytes),
    releasePageUrl: `https://nodejs.org/en/blog/release/v${runtimeVersion}`,
    sourceUrl: `https://nodejs.org/dist/v${runtimeVersion}/node-v${runtimeVersion}-win-x64.zip`,
    version: runtimeVersion,
  };
  const stabilityAiAgreementPath = join(
    root,
    'external-licenses',
    'Stability-AI-Community-License.md',
  );
  await writeFixtureFile(
    root,
    'external-licenses/Stability-AI-Community-License.md',
    stabilityAiAgreementBytes,
  );
  const stabilityAiProductUsePolicy = {
    acceptableUsePolicyUrl: 'https://stability.example.test/use-policy',
    agreementSha256: sha256(stabilityAiAgreementBytes),
    agreementSourceUrl: 'https://models.example.test/stable-audio/LICENSE.md',
    attributionText: 'Powered by Stability AI',
    commercialRegistrationStatus: 'NOT_VERIFIED',
    commercialRegistrationUrl: 'https://stability.example.test/register',
    noticeText:
      'This Stability AI Model is licensed under the Stability AI Community License, Copyright © Stability AI Ltd. All Rights Reserved',
  };
  const buildCalls = [];
  const validationCalls = [];

  return {
    buildCalls,
    bundledComponents: components,
    dependencies: {
      buildReleaseArtifacts: async (path) => buildCalls.push(path),
      inspectRepositoryBoundary: async () => ({
        head: SOURCE_COMMIT,
        status: '',
      }),
      readNodeVersion: async () => `v${runtimeVersion}`,
      validateMaterializedPackage: async (options) => {
        validationCalls.push(options);
        await assertExactManifest(options.packageRoot);
        await mkdir(dirname(options.resultFilePath), { recursive: true });
        await writeFile(
          options.resultFilePath,
          `READY\n${options.version}`,
          'utf8',
        );
      },
    },
    nodeArchivePath,
    repositoryPath,
    root,
    runtimePolicy,
    stabilityAiAgreementBytes,
    stabilityAiAgreementPath,
    stabilityAiProductUsePolicy,
    validationCalls,
  };
}

async function materializeFixture(fixture, outputRoot, overrides = {}) {
  return materializeElpisDawPortablePackage({
    bundledComponents: fixture.bundledComponents,
    dependencies: fixture.dependencies,
    nodeArchivePath: fixture.nodeArchivePath,
    outputRoot,
    repositoryPath: fixture.repositoryPath,
    runtimePolicy: fixture.runtimePolicy,
    sourceCommit: SOURCE_COMMIT,
    stabilityAiAgreementPath: fixture.stabilityAiAgreementPath,
    stabilityAiProductUsePolicy: fixture.stabilityAiProductUsePolicy,
    ...overrides,
  });
}

async function assertExactManifest(packageRoot) {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, 'release-manifest.json'), 'utf8'),
  );
  const actualFiles = (await listFiles(packageRoot)).filter(
    (path) => path !== 'release-manifest.json',
  );

  expect(manifest.files.map((entry) => entry.path)).toEqual(
    actualFiles.sort((left, right) => left.localeCompare(right, 'en')),
  );

  for (const entry of manifest.files) {
    const content = await readFile(join(packageRoot, ...entry.path.split('/')));
    expect(entry).toMatchObject({
      sha256: sha256(content),
      sizeBytes: content.length,
    });
  }
}

async function snapshotTree(rootPath) {
  const files = await listFiles(rootPath);
  const snapshot = [];

  for (const relativePath of files.sort()) {
    const content = await readFile(join(rootPath, ...relativePath.split('/')));
    snapshot.push({ relativePath, sha256: sha256(content), sizeBytes: content.length });
  }

  return snapshot;
}

async function listFiles(rootPath) {
  const files = [];

  async function visit(relativePath) {
    const directoryPath = relativePath
      ? join(rootPath, ...relativePath.split('/'))
      : rootPath;
    const entries = await readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
      const childRelativePath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;
      const childPath = join(rootPath, ...childRelativePath.split('/'));

      if (entry.isDirectory()) {
        await visit(childRelativePath);
      } else if (entry.isFile()) {
        files.push(childRelativePath);
      } else {
        const metadata = await lstat(childPath);
        throw new Error(`Unexpected fixture entry type: ${metadata.mode}`);
      }
    }
  }

  await visit('');
  return files;
}

async function writeFixtureFile(rootPath, relativePath, content) {
  const filePath = join(rootPath, ...relativePath.split('/'));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}
