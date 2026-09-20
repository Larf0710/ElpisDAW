import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
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
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ELPISDAW_BUNDLED_JAVASCRIPT_COMPONENTS,
  ELPISDAW_NODE_RUNTIME,
  ELPISDAW_PORTABLE_PACKAGE,
  ELPISDAW_PORTABLE_PACKAGE_POLICY_VERSION,
  ELPISDAW_STABILITY_AI_PRODUCT_USE,
} from './elpisDawPortablePackagePolicy.mjs';

const execFile = promisify(execFileCallback);
const RELEASE_MANIFEST_FILE_NAME = 'release-manifest.json';
const SELF_SIGNED_PREVIEW_NOTICE_FILE_NAME = 'SELF_SIGNED_PREVIEW.txt';
const MAXIMUM_NODE_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAXIMUM_LICENSE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_SIGN_TOOL_BYTES = 32 * 1024 * 1024;
const SIGNING_TRUST_MODES = new Set(['public-trust', 'self-signed-preview']);
const SELF_SIGNED_AUTHENTICODE_STATUSES = new Set(['NotTrusted', 'UnknownError']);
const WINTRUST_STATUS_SUCCESS = '0x00000000';
const WINTRUST_STATUS_UNTRUSTED_ROOT = '0x800B0109';
const WINTRUST_TYPE_DEFINITION = String.raw`
using System;
using System.Runtime.InteropServices;

namespace ElpisDaw
{
    public static class WinTrustVerifier
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WinTrustFileInfo
        {
            public uint cbStruct;
            [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WinTrustData
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            public IntPtr pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
        }

        [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = false, CharSet = CharSet.Unicode)]
        private static extern int WinVerifyTrust(
            IntPtr hwnd,
            [MarshalAs(UnmanagedType.LPStruct)] Guid actionId,
            ref WinTrustData data);

        public static string VerifyEmbeddedSignature(string filePath)
        {
            var fileInfo = new WinTrustFileInfo
            {
                cbStruct = (uint)Marshal.SizeOf(typeof(WinTrustFileInfo)),
                pcwszFilePath = filePath,
                hFile = IntPtr.Zero,
                pgKnownSubject = IntPtr.Zero
            };
            IntPtr fileInfoPointer = Marshal.AllocHGlobal(
                Marshal.SizeOf(typeof(WinTrustFileInfo)));

            try
            {
                Marshal.StructureToPtr(fileInfo, fileInfoPointer, false);
                var data = new WinTrustData
                {
                    cbStruct = (uint)Marshal.SizeOf(typeof(WinTrustData)),
                    pPolicyCallbackData = IntPtr.Zero,
                    pSIPClientData = IntPtr.Zero,
                    dwUIChoice = 2,
                    fdwRevocationChecks = 0,
                    dwUnionChoice = 1,
                    pFile = fileInfoPointer,
                    dwStateAction = 0,
                    hWVTStateData = IntPtr.Zero,
                    pwszURLReference = IntPtr.Zero,
                    dwProvFlags = 0x00001000,
                    dwUIContext = 0
                };
                Guid actionId = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
                int status = WinVerifyTrust(new IntPtr(-1), actionId, ref data);
                return "0x" + unchecked((uint)status).ToString("X8");
            }
            finally
            {
                Marshal.DestroyStructure(fileInfoPointer, typeof(WinTrustFileInfo));
                Marshal.FreeHGlobal(fileInfoPointer);
            }
        }
    }
}
`;
const ENGINE_RUNTIME_EXTENSIONS = new Set(['.mjs', '.py', '.txt']);
const UI_RUNTIME_EXTENSIONS = new Set([
  '.css',
  '.gif',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.otf',
  '.png',
  '.svg',
  '.ttf',
  '.wasm',
  '.webp',
  '.woff',
  '.woff2',
]);
const GENERATED_ENGINE_DIRECTORY_NAMES = new Set(['__pycache__']);
const TEST_ONLY_FILE_PATTERN = /(?:\.test\.|\.fixture\.|TestFixtures\.mjs$)/i;
const SHARED_TEST_ONLY_PATHS = new Set([
  'projectPlaybackAudioWorkletCases.js',
]);

export class ElpisDawPortablePackageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ElpisDawPortablePackageError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ElpisDawPortablePackageError(code, message);
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

async function resolveOutputRoot(outputRoot, repositoryPath) {
  if (typeof outputRoot !== 'string' || !isAbsolute(outputRoot)) {
    fail('OUTPUT_PATH_NOT_ABSOLUTE', 'Portable output root must be an absolute path.');
  }

  const resolvedOutputRoot = resolve(outputRoot);

  try {
    await lstat(resolvedOutputRoot);
    fail('OUTPUT_PATH_EXISTS', 'Portable output root must not already exist.');
  } catch (error) {
    if (error instanceof ElpisDawPortablePackageError) {
      throw error;
    }

    if (error?.code !== 'ENOENT') {
      fail('OUTPUT_PATH_UNAVAILABLE', 'Portable output root could not be inspected.');
    }
  }

  const outputParent = await resolveExistingDirectory(
    dirname(resolvedOutputRoot),
    'Portable output parent',
  );
  const canonicalOutputRoot = join(outputParent, basename(resolvedOutputRoot));

  if (
    canonicalOutputRoot === repositoryPath ||
    isPathInside(repositoryPath, canonicalOutputRoot) ||
    isPathInside(canonicalOutputRoot, repositoryPath)
  ) {
    fail('OUTPUT_PATH_OVERLAPS_REPOSITORY', 'Portable output must stay outside the repository.');
  }

  return canonicalOutputRoot;
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

function validateRuntimePolicy(runtimePolicy) {
  const keys = [
    'archiveFileName',
    'archiveRootName',
    'archiveSha256',
    'nodeSha256',
    'releasePageUrl',
    'sourceUrl',
    'version',
  ];

  if (
    !runtimePolicy ||
    Object.keys(runtimePolicy).sort(comparePaths).join('\n') !== keys.sort(comparePaths).join('\n') ||
    !/^\d+\.\d+\.\d+$/.test(runtimePolicy.version) ||
    !/^[0-9a-f]{64}$/.test(runtimePolicy.archiveSha256) ||
    !/^[0-9a-f]{64}$/.test(runtimePolicy.nodeSha256) ||
    runtimePolicy.archiveFileName !== `node-v${runtimePolicy.version}-win-x64.zip` ||
    runtimePolicy.archiveRootName !== `node-v${runtimePolicy.version}-win-x64` ||
    runtimePolicy.sourceUrl !==
      `https://nodejs.org/dist/v${runtimePolicy.version}/${runtimePolicy.archiveFileName}` ||
    runtimePolicy.releasePageUrl !==
      `https://nodejs.org/en/blog/release/v${runtimePolicy.version}`
  ) {
    fail('INVALID_RUNTIME_POLICY', 'Node.js runtime policy is invalid.');
  }

  return runtimePolicy;
}

function validateStabilityAiProductUsePolicy(policy) {
  const keys = [
    'acceptableUsePolicyUrl',
    'agreementSha256',
    'agreementSourceUrl',
    'attributionText',
    'commercialRegistrationStatus',
    'commercialRegistrationUrl',
    'noticeText',
  ];

  if (
    !policy ||
    Object.keys(policy).sort(comparePaths).join('\n') !== keys.sort(comparePaths).join('\n') ||
    typeof policy.acceptableUsePolicyUrl !== 'string' ||
    typeof policy.agreementSha256 !== 'string' ||
    typeof policy.agreementSourceUrl !== 'string' ||
    typeof policy.attributionText !== 'string' ||
    typeof policy.commercialRegistrationStatus !== 'string' ||
    typeof policy.commercialRegistrationUrl !== 'string' ||
    typeof policy.noticeText !== 'string' ||
    !/^[0-9a-f]{64}$/.test(policy.agreementSha256) ||
    !policy.agreementSourceUrl.startsWith('https://') ||
    policy.attributionText !== 'Powered by Stability AI' ||
    policy.commercialRegistrationStatus !== 'NOT_VERIFIED' ||
    !policy.commercialRegistrationUrl.startsWith('https://') ||
    !policy.acceptableUsePolicyUrl.startsWith('https://') ||
    policy.noticeText !==
      'This Stability AI Model is licensed under the Stability AI Community License, Copyright © Stability AI Ltd. All Rights Reserved'
  ) {
    fail(
      'INVALID_STABILITY_AI_PRODUCT_USE_POLICY',
      'Stability AI product-use policy is invalid.',
    );
  }

  return policy;
}

function validateBundledComponents(components) {
  if (!Array.isArray(components) || components.length === 0) {
    fail('INVALID_COMPONENT_POLICY', 'Bundled JavaScript component policy is invalid.');
  }

  const names = new Set();

  for (const component of components) {
    if (
      !component ||
      typeof component.name !== 'string' ||
      names.has(component.name) ||
      !/^\d+\.\d+\.\d+$/.test(component.version) ||
      component.license !== 'MIT' ||
      !/^[0-9a-f]{64}$/.test(component.licenseSha256) ||
      component.purl !== `pkg:npm/${component.name}@${component.version}`
    ) {
      fail('INVALID_COMPONENT_POLICY', 'Bundled JavaScript component policy is invalid.');
    }

    names.add(component.name);
  }

  return [...components].sort((left, right) => comparePaths(left.name, right.name));
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
    fail('REPOSITORY_INSPECTION_FAILED', 'The release repository could not be inspected.');
  }
}

function requireRepositoryBoundary(boundary, sourceCommit) {
  if (boundary?.head !== sourceCommit) {
    fail('SOURCE_COMMIT_MISMATCH', 'The release source commit does not match HEAD.');
  }

  if (boundary.status !== '') {
    fail('REPOSITORY_NOT_CLEAN', 'The release repository must be clean.');
  }
}

async function buildReleaseArtifacts(repositoryPath) {
  const systemRoot = process.env.SystemRoot;

  if (!systemRoot || !isAbsolute(systemRoot)) {
    fail('WINDOWS_RUNTIME_UNAVAILABLE', 'Windows system tools are unavailable.');
  }

  const powershellPath = join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const commands = [
    [
      powershellPath,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(repositoryPath, 'scripts', 'Build-WindowsDirectoryPicker.ps1'),
      ],
    ],
    [
      powershellPath,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(repositoryPath, 'scripts', 'Build-ElpisDawLauncher.ps1'),
      ],
    ],
    [
      process.execPath,
      [join(repositoryPath, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'],
    ],
    [
      process.execPath,
      [join(repositoryPath, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
    ],
  ];

  try {
    for (const [executablePath, args] of commands) {
      await execFile(executablePath, args, {
        cwd: repositoryPath,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      });
    }
  } catch {
    fail('RELEASE_BUILD_FAILED', 'ElpisDAW release artifacts could not be built.');
  }
}

async function extractNodeArchive(nodeArchivePath, extractionRoot) {
  const systemRoot = process.env.SystemRoot;

  if (!systemRoot || !isAbsolute(systemRoot)) {
    fail('WINDOWS_RUNTIME_UNAVAILABLE', 'Windows system tools are unavailable.');
  }

  const tarPath = join(systemRoot, 'System32', 'tar.exe');

  try {
    await execFile(tarPath, ['-xf', nodeArchivePath, '-C', extractionRoot], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    });
  } catch {
    fail('NODE_ARCHIVE_EXTRACTION_FAILED', 'The pinned Node.js archive could not be extracted.');
  }
}

async function readNodeVersion(nodePath) {
  try {
    const { stdout } = await execFile(nodePath, ['--version'], {
      encoding: 'utf8',
      maxBuffer: 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    fail('NODE_RUNTIME_EXECUTION_FAILED', 'The pinned Node.js runtime could not be inspected.');
  }
}

function normalizeCertificateThumbprint(value) {
  if (typeof value !== 'string') {
    fail('INVALID_SIGNING_CONFIGURATION', 'The signing certificate thumbprint is invalid.');
  }

  const normalized = value.replace(/\s/g, '').toUpperCase();

  if (!/^[0-9A-F]{40}$/.test(normalized)) {
    fail('INVALID_SIGNING_CONFIGURATION', 'The signing certificate thumbprint is invalid.');
  }

  return normalized;
}

async function validateSigningConfiguration(signing, repositoryPath) {
  if (signing === undefined || signing === null) {
    return null;
  }

  const requiredKeys = [
    'certificateStore',
    'certificateThumbprint',
    'signToolPath',
    'signToolSha256',
  ];
  const allowedKeys = new Set([...requiredKeys, 'timestampUrl', 'trustMode']);
  const signingKeys = Object.keys(signing);
  const trustMode = signing.trustMode ?? 'public-trust';

  if (
    typeof signing !== 'object' ||
    Array.isArray(signing) ||
    requiredKeys.some((key) => !(key in signing)) ||
    signingKeys.some((key) => !allowedKeys.has(key)) ||
    !SIGNING_TRUST_MODES.has(trustMode) ||
    !['current-user', 'local-machine'].includes(signing.certificateStore) ||
    (trustMode === 'self-signed-preview' && signing.certificateStore !== 'current-user') ||
    typeof signing.signToolPath !== 'string' ||
    !isAbsolute(signing.signToolPath) ||
    typeof signing.signToolSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(signing.signToolSha256)
  ) {
    fail('INVALID_SIGNING_CONFIGURATION', 'Native signing configuration is invalid.');
  }

  const certificateThumbprint = normalizeCertificateThumbprint(
    signing.certificateThumbprint,
  );
  let timestampUrl = null;

  if (trustMode === 'public-trust') {
    try {
      timestampUrl = new URL(signing.timestampUrl);
    } catch {
      fail('INVALID_SIGNING_CONFIGURATION', 'The signing timestamp URL is invalid.');
    }

    if (
      timestampUrl.protocol !== 'https:' ||
      timestampUrl.username !== '' ||
      timestampUrl.password !== '' ||
      timestampUrl.hash !== ''
    ) {
      fail('INVALID_SIGNING_CONFIGURATION', 'The signing timestamp URL must be an HTTPS service URL.');
    }
  } else if (signing.timestampUrl !== undefined && signing.timestampUrl !== null) {
    fail(
      'INVALID_SIGNING_CONFIGURATION',
      'Self-signed preview signatures must not claim trusted timestamping.',
    );
  }

  const canonicalSignToolPath = await realpath(resolve(signing.signToolPath)).catch(() =>
    fail('SIGN_TOOL_UNAVAILABLE', 'The pinned SignTool executable is unavailable.'),
  );
  await assertRegularFile(
    canonicalSignToolPath,
    'Pinned SignTool executable',
    MAXIMUM_SIGN_TOOL_BYTES,
  );

  if (
    basename(canonicalSignToolPath).toLowerCase() !== 'signtool.exe' ||
    isPathInside(repositoryPath, canonicalSignToolPath) ||
    (await sha256File(canonicalSignToolPath)) !== signing.signToolSha256
  ) {
    fail('SIGN_TOOL_PROVENANCE_MISMATCH', 'Pinned SignTool provenance changed.');
  }

  return Object.freeze({
    certificateStore: signing.certificateStore,
    certificateThumbprint,
    signToolPath: canonicalSignToolPath,
    signToolSha256: signing.signToolSha256,
    timestampUrl: timestampUrl?.toString() ?? null,
    trustMode,
  });
}

export async function inspectAuthenticodeSignature(filePath) {
  const systemRoot = process.env.SystemRoot;

  if (!systemRoot || !isAbsolute(systemRoot)) {
    fail('WINDOWS_RUNTIME_UNAVAILABLE', 'Windows system tools are unavailable.');
  }

  const powershellPath = join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const securityModulePath = join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'Modules',
    'Microsoft.PowerShell.Security',
    'Microsoft.PowerShell.Security.psd1',
  );
  const inspectionScript = [
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    'Import-Module -Name $env:ELPISDAW_SECURITY_MODULE_PATH -ErrorAction Stop',
    'Add-Type -TypeDefinition $env:ELPISDAW_WINTRUST_TYPE_DEFINITION',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:ELPISDAW_SIGNED_FILE',
    '$certificate = $signature.SignerCertificate',
    '$winTrustStatus = [ElpisDaw.WinTrustVerifier]::VerifyEmbeddedSignature($env:ELPISDAW_SIGNED_FILE)',
    '$codeSigningEku = $false',
    'if ($certificate) { $eku = $certificate.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.37" } | Select-Object -First 1; if ($eku) { $codeSigningEku = [bool]($eku.EnhancedKeyUsages | Where-Object { $_.Value -eq "1.3.6.1.5.5.7.3.3" }) } }',
    '$result = [ordered]@{ certificateNotAfter = if ($certificate) { $certificate.NotAfter.ToUniversalTime().ToString("o") } else { $null }; certificateNotBefore = if ($certificate) { $certificate.NotBefore.ToUniversalTime().ToString("o") } else { $null }; codeSigningEku = $codeSigningEku; signerIssuer = if ($certificate) { $certificate.Issuer } else { $null }; signerSubject = if ($certificate) { $certificate.Subject } else { $null }; signerThumbprint = if ($certificate) { $certificate.Thumbprint } else { $null }; status = $signature.Status.ToString(); timestamped = [bool]$signature.TimeStamperCertificate; winTrustStatus = $winTrustStatus }',
    '$result | ConvertTo-Json -Compress',
  ].join('; ');

  let inspection;

  try {
    inspection = await execFile(
      powershellPath,
      ['-NoProfile', '-NonInteractive', '-Command', inspectionScript],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ELPISDAW_SECURITY_MODULE_PATH: securityModulePath,
          ELPISDAW_SIGNED_FILE: filePath,
          ELPISDAW_WINTRUST_TYPE_DEFINITION: WINTRUST_TYPE_DEFINITION,
        },
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );
  } catch (error) {
    const diagnostic = [error?.stderr, error?.stdout, error?.message]
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
    fail(
      'NATIVE_SIGNATURE_INSPECTION_FAILED',
      diagnostic
        ? 'A signed native binary could not be inspected. ' + diagnostic
        : 'A signed native binary could not be inspected.',
    );
  }

  try {
    return JSON.parse(inspection.stdout);
  } catch (error) {
    const diagnostic = [inspection.stderr, error?.message]
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
    fail(
      'NATIVE_SIGNATURE_INSPECTION_FAILED',
      'A signed native binary returned invalid inspection evidence. ' + diagnostic,
    );
  }
}

function validateSigningEvidence(evidence, signing) {
  const keys = [
    'authenticodeStatus',
    'certificateNotAfter',
    'certificateNotBefore',
    'certificateStore',
    'certificateThumbprint',
    'codeSigningEku',
    'signerIssuer',
    'signerSubject',
    'signToolFileName',
    'signToolSha256',
    'status',
    'timestamped',
    'timestampUrl',
    'trustMode',
    'winTrustStatus',
  ];
  const certificateNotAfter = Date.parse(evidence?.certificateNotAfter);
  const certificateNotBefore = Date.parse(evidence?.certificateNotBefore);
  const expectedStatus = signing.trustMode === 'public-trust'
    ? 'SIGNED'
    : 'SELF_SIGNED_PREVIEW';
  const authenticodeStatusAccepted = signing.trustMode === 'public-trust'
    ? evidence?.authenticodeStatus === 'Valid'
    : SELF_SIGNED_AUTHENTICODE_STATUSES.has(evidence?.authenticodeStatus);
  const timestampAccepted = signing.trustMode === 'public-trust'
    ? evidence?.timestamped === true && evidence?.timestampUrl === signing.timestampUrl
    : evidence?.timestamped === false && evidence?.timestampUrl === null;
  const identityAccepted = signing.trustMode === 'public-trust'
    ? evidence?.signerSubject !== evidence?.signerIssuer
    : evidence?.signerSubject === evidence?.signerIssuer;
  const winTrustStatusAccepted = signing.trustMode === 'public-trust'
    ? evidence?.winTrustStatus === WINTRUST_STATUS_SUCCESS
    : evidence?.winTrustStatus === WINTRUST_STATUS_UNTRUSTED_ROOT;

  if (
    !evidence ||
    typeof evidence !== 'object' ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort(comparePaths).join('\n') !== keys.sort(comparePaths).join('\n') ||
    evidence.status !== expectedStatus ||
    evidence.trustMode !== signing.trustMode ||
    !authenticodeStatusAccepted ||
    evidence.certificateStore !== signing.certificateStore ||
    evidence.certificateThumbprint !== signing.certificateThumbprint ||
    typeof evidence.certificateNotAfter !== 'string' ||
    Number.isNaN(certificateNotAfter) ||
    certificateNotAfter <= Date.now() ||
    typeof evidence.certificateNotBefore !== 'string' ||
    Number.isNaN(certificateNotBefore) ||
    certificateNotBefore > Date.now() ||
    evidence.codeSigningEku !== true ||
    typeof evidence.signerIssuer !== 'string' ||
    evidence.signerIssuer.trim() === '' ||
    typeof evidence.signerSubject !== 'string' ||
    evidence.signerSubject.trim() === '' ||
    !identityAccepted ||
    !winTrustStatusAccepted ||
    evidence.signToolFileName !== 'signtool.exe' ||
    evidence.signToolSha256 !== signing.signToolSha256 ||
    !timestampAccepted
  ) {
    fail('NATIVE_SIGNING_EVIDENCE_INVALID', 'Native signing evidence is incomplete or inconsistent.');
  }

  return Object.freeze({ ...evidence });
}

async function signPackageNativeBinaries({ packageRoot, signing }) {
  const launcherPath = join(packageRoot, 'ElpisDAW.exe');
  const directoryPickerPath = join(packageRoot, 'native', 'HumStudio.DirectoryPicker.exe');
  const targetPaths = [launcherPath, directoryPickerPath];
  const storeArguments = signing.certificateStore === 'local-machine' ? ['/sm'] : [];

  try {
    const timestampArguments = signing.trustMode === 'public-trust'
      ? ['/tr', signing.timestampUrl, '/td', 'SHA256']
      : [];
    await execFile(
      signing.signToolPath,
      [
        'sign',
        '/fd',
        'SHA256',
        '/sha1',
        signing.certificateThumbprint,
        ...storeArguments,
        ...timestampArguments,
        ...targetPaths,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
    );

    if (signing.trustMode === 'public-trust') {
      for (const targetPath of targetPaths) {
        await execFile(signing.signToolPath, ['verify', '/pa', '/all', '/v', targetPath], {
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
          timeout: 30_000,
          windowsHide: true,
        });
      }
    }

    const signatures = await Promise.all(
      targetPaths.map((targetPath) => inspectAuthenticodeSignature(targetPath)),
    );

    const acceptedAuthenticodeStatuses = signing.trustMode === 'public-trust'
      ? new Set(['Valid'])
      : SELF_SIGNED_AUTHENTICODE_STATUSES;
    const expectedTimestamped = signing.trustMode === 'public-trust';
    if (
      signatures.some(
        (signature) =>
          !acceptedAuthenticodeStatuses.has(signature.status) ||
          normalizeCertificateThumbprint(signature.signerThumbprint) !==
            signing.certificateThumbprint ||
          signature.codeSigningEku !== true ||
          signature.timestamped !== expectedTimestamped ||
          signature.winTrustStatus !== (
            signing.trustMode === 'public-trust'
              ? WINTRUST_STATUS_SUCCESS
              : WINTRUST_STATUS_UNTRUSTED_ROOT
          ),
      ) ||
      (signing.trustMode === 'self-signed-preview' &&
        signatures.some((signature) => signature.signerSubject !== signature.signerIssuer)) ||
      signatures[0].signerSubject !== signatures[1].signerSubject ||
      signatures[0].signerIssuer !== signatures[1].signerIssuer ||
      signatures[0].certificateNotBefore !== signatures[1].certificateNotBefore ||
      signatures[0].certificateNotAfter !== signatures[1].certificateNotAfter
    ) {
      fail('NATIVE_SIGNATURE_VERIFICATION_FAILED', 'Signed native binaries failed Authenticode verification.');
    }

    return validateSigningEvidence(
      {
        authenticodeStatus: signatures[0].status,
        certificateNotAfter: signatures[0].certificateNotAfter,
        certificateNotBefore: signatures[0].certificateNotBefore,
        certificateStore: signing.certificateStore,
        certificateThumbprint: signing.certificateThumbprint,
        codeSigningEku: signatures[0].codeSigningEku,
        signerIssuer: signatures[0].signerIssuer,
        signerSubject: signatures[0].signerSubject,
        signToolFileName: basename(signing.signToolPath),
        signToolSha256: signing.signToolSha256,
        status: signing.trustMode === 'public-trust' ? 'SIGNED' : 'SELF_SIGNED_PREVIEW',
        timestamped: expectedTimestamped,
        timestampUrl: signing.timestampUrl,
        trustMode: signing.trustMode,
        winTrustStatus: signatures[0].winTrustStatus,
      },
      signing,
    );
  } catch (error) {
    if (error instanceof ElpisDawPortablePackageError) {
      throw error;
    }

    fail('NATIVE_SIGNING_FAILED', 'ElpisDAW native binaries could not be signed and verified.');
  }
}

function createSelfSignedPreviewNotice(signingEvidence) {
  return [
    'ElpisDAW Self-Signed Preview',
    '',
    'This preview uses an Authenticode signature from a self-signed certificate.',
    'Windows does not trust this publisher identity by default, and security warnings or blocks may still appear.',
    'Do not install this certificate into Trusted Root Certification Authorities or Trusted Publishers.',
    'Verify the ZIP SHA-256 against the value published through the official ElpisDAW release channel.',
    '',
    `Certificate subject: ${signingEvidence.signerSubject}`,
    `Certificate thumbprint: ${signingEvidence.certificateThumbprint}`,
    '',
    'This temporary preview signature is not a corporate or publicly trusted code-signing certificate.',
    '',
  ].join('\n');
}

async function validateMaterializedPackage({ packageRoot, resultFilePath, version }) {
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
    if (error instanceof ElpisDawPortablePackageError) {
      throw error;
    }

    fail('PACKAGE_VALIDATION_FAILED', 'The native launcher rejected the portable package.');
  }
}

function classifyEnginePath(relativePath, isDirectory) {
  const pathSegments = relativePath.split('/');
  const firstSegment = pathSegments[0];

  if (
    firstSegment === 'bin' ||
    firstSegment === 'windows' ||
    pathSegments.some((segment) => GENERATED_ENGINE_DIRECTORY_NAMES.has(segment))
  ) {
    return 'EXCLUDE';
  }

  if (isDirectory) {
    return 'TRAVERSE';
  }

  if (TEST_ONLY_FILE_PATTERN.test(relativePath)) {
    return 'EXCLUDE';
  }

  if (ENGINE_RUNTIME_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
    return 'INCLUDE';
  }

  return 'UNREVIEWED';
}

function classifySharedPath(relativePath, isDirectory) {
  if (isDirectory) {
    return 'TRAVERSE';
  }

  if (
    TEST_ONLY_FILE_PATTERN.test(relativePath) ||
    SHARED_TEST_ONLY_PATHS.has(relativePath) ||
    relativePath.endsWith('.d.ts') ||
    relativePath.endsWith('.test.ts')
  ) {
    return 'EXCLUDE';
  }

  if (relativePath.endsWith('.js') || relativePath.endsWith('.json')) {
    return 'INCLUDE';
  }

  return 'UNREVIEWED';
}

function classifyUiPath(relativePath, isDirectory) {
  if (isDirectory) {
    return 'TRAVERSE';
  }

  return UI_RUNTIME_EXTENSIONS.has(extname(relativePath).toLowerCase())
    ? 'INCLUDE'
    : 'UNREVIEWED';
}

async function copyRegularFile(sourcePath, destinationPath, label) {
  await assertRegularFile(sourcePath, label);
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

async function copySelectedTree(sourceRoot, destinationRoot, classify, label) {
  await resolveExistingDirectory(sourceRoot, label);

  async function visit(relativePath) {
    const sourceDirectory = relativePath
      ? join(sourceRoot, ...relativePath.split('/'))
      : sourceRoot;
    const entries = (await readdir(sourceDirectory, { withFileTypes: true })).sort(
      (left, right) => comparePaths(left.name, right.name),
    );

    for (const entry of entries) {
      const childRelativePath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;

      if (entry.isSymbolicLink()) {
        fail('UNSAFE_SOURCE_LINK', `${label} contains an unsupported link.`);
      }

      const decision = classify(childRelativePath, entry.isDirectory());

      if (decision === 'EXCLUDE') {
        continue;
      }

      if (decision === 'UNREVIEWED' || (!entry.isDirectory() && !entry.isFile())) {
        fail('UNREVIEWED_SOURCE_FILE', `${label} contains an unreviewed file type.`);
      }

      const sourcePath = join(sourceRoot, ...childRelativePath.split('/'));
      const destinationPath = join(
        destinationRoot,
        ...childRelativePath.split('/'),
      );

      if (entry.isDirectory()) {
        await mkdir(destinationPath, { recursive: true });
        await visit(childRelativePath);
      } else {
        await mkdir(dirname(destinationPath), { recursive: true });
        await copyFile(sourcePath, destinationPath);
      }
    }
  }

  await mkdir(destinationRoot, { recursive: true });
  await visit('');
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

async function copyBundledComponentLicenses(
  repositoryPath,
  packageRoot,
  components,
) {
  const copied = [];

  for (const component of components) {
    const componentRoot = join(repositoryPath, 'node_modules', component.name);
    const packageJsonPath = join(componentRoot, 'package.json');
    const licensePath = join(componentRoot, 'LICENSE');
    await assertRegularFile(packageJsonPath, `${component.name} package metadata`);
    await assertRegularFile(licensePath, `${component.name} license`, MAXIMUM_LICENSE_BYTES);

    let packageJson;

    try {
      packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    } catch {
      fail('INVALID_COMPONENT_METADATA', 'Bundled JavaScript component metadata is invalid.');
    }

    if (
      packageJson.name !== component.name ||
      packageJson.version !== component.version ||
      packageJson.license !== component.license ||
      (await sha256File(licensePath)) !== component.licenseSha256
    ) {
      fail('COMPONENT_PROVENANCE_MISMATCH', 'Bundled JavaScript component provenance changed.');
    }

    const publicLicensePath = `licenses/npm/${component.name}-LICENSE.txt`;
    await copyRegularFile(
      licensePath,
      join(packageRoot, ...publicLicensePath.split('/')),
      `${component.name} license`,
    );
    copied.push({ ...component, publicLicensePath });
  }

  return copied;
}

function createThirdPartyNotices(runtimePolicy, components, stabilityAiPolicy) {
  const lines = [
    '# ElpisDAW Third-Party Notices',
    '',
    'This portable Core package contains the following reviewed third-party software.',
    'Optional AI Providers, model weights, Python environments, FluidSynth, and SoundFonts are not bundled.',
    '',
    '## Stable Audio 3 product-use materials',
    '',
    `- ${stabilityAiPolicy.attributionText}`,
    '- Agreement copy: `licenses/Stability-AI-Community-License.md`',
    '- Required attribution: `licenses/STABILITY_AI_NOTICE.txt`',
    `- Agreement source: ${stabilityAiPolicy.agreementSourceUrl}`,
    `- Commercial registration: ${stabilityAiPolicy.commercialRegistrationUrl}`,
    `- Acceptable Use Policy: ${stabilityAiPolicy.acceptableUsePolicyUrl}`,
    `- Commercial registration status: \`${stabilityAiPolicy.commercialRegistrationStatus}\``,
    '- Stable Audio 3 runtime and model bytes are not bundled.',
    '',
    `## Node.js ${runtimePolicy.version}`,
    '',
    '- License and bundled upstream notices: `runtime/LICENSE`',
    '- Retained notice copy: `runtime/THIRD_PARTY_NOTICES/Node.js-LICENSE.txt`',
    `- Official release: ${runtimePolicy.releasePageUrl}`,
    `- Official Windows x64 archive: ${runtimePolicy.sourceUrl}`,
    `- Archive SHA-256: \`${runtimePolicy.archiveSha256}\``,
    `- node.exe SHA-256: \`${runtimePolicy.nodeSha256}\``,
    '',
    '## Bundled JavaScript components',
    '',
    ...components.flatMap((component) => [
      `### ${component.name} ${component.version}`,
      '',
      `- License: ${component.license}`,
      `- License file: \`${component.publicLicensePath}\``,
      `- Package URL: \`${component.purl}\``,
      '',
    ]),
  ];

  return `${lines.join('\n')}\n`;
}

function createCycloneDxSbom({ components, runtimePolicy, sourceCommit, version }) {
  const applicationRef = `pkg:generic/ElpisDAW@${version}`;
  const nodeRef = `pkg:generic/nodejs@${runtimePolicy.version}`;
  const componentRefs = new Map(
    components.map((component) => [component.name, component.purl]),
  );
  const componentEntries = [
    {
      'bom-ref': nodeRef,
      hashes: [{ alg: 'SHA-256', content: runtimePolicy.nodeSha256 }],
      licenses: [{ license: { id: 'MIT' } }],
      name: 'Node.js',
      purl: nodeRef,
      type: 'framework',
      version: runtimePolicy.version,
    },
    ...components.map((component) => ({
      'bom-ref': component.purl,
      licenses: [{ license: { id: component.license } }],
      name: component.name,
      purl: component.purl,
      type: 'library',
      version: component.version,
    })),
  ];

  return {
    bomFormat: 'CycloneDX',
    components: componentEntries,
    dependencies: [
      {
        dependsOn: componentEntries.map((component) => component['bom-ref']).sort(comparePaths),
        ref: applicationRef,
      },
      { dependsOn: [], ref: nodeRef },
      ...components.map((component) => ({
        dependsOn:
          component.name === 'react-dom'
            ? ['react', 'scheduler']
                .map((name) => componentRefs.get(name))
                .filter(Boolean)
                .sort(comparePaths)
            : [],
        ref: component.purl,
      })),
    ],
    metadata: {
      component: {
        'bom-ref': applicationRef,
        licenses: [{ license: { id: 'MPL-2.0' } }],
        name: 'ElpisDAW',
        type: 'application',
        version,
      },
      properties: [
        { name: 'elpisdaw:sourceCommit', value: sourceCommit },
        {
          name: 'elpisdaw:portablePackagePolicyVersion',
          value: ELPISDAW_PORTABLE_PACKAGE_POLICY_VERSION,
        },
      ],
    },
    specVersion: '1.6',
    version: 1,
  };
}

async function createReleaseManifest(packageRoot, version) {
  const packageFiles = (await listRegularFiles(packageRoot)).filter(
    (relativePath) => relativePath !== RELEASE_MANIFEST_FILE_NAME,
  );
  const files = [];

  for (const relativePath of packageFiles) {
    const content = await readFile(join(packageRoot, ...relativePath.split('/')));
    files.push({
      path: relativePath,
      sha256: sha256(content),
      sizeBytes: content.length,
    });
  }

  const manifest = {
    files,
    manifestVersion: ELPISDAW_PORTABLE_PACKAGE.manifestVersion,
    platform: ELPISDAW_PORTABLE_PACKAGE.platform,
    product: ELPISDAW_PORTABLE_PACKAGE.product,
    version,
  };
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(packageRoot, RELEASE_MANIFEST_FILE_NAME), serializedManifest, 'utf8');
  return { manifest, serializedManifest };
}

export async function materializeElpisDawPortablePackage({
  repositoryPath = process.cwd(),
  sourceCommit,
  nodeArchivePath,
  stabilityAiAgreementPath,
  outputRoot,
  version = ELPISDAW_PORTABLE_PACKAGE.version,
  runtimePolicy = ELPISDAW_NODE_RUNTIME,
  stabilityAiProductUsePolicy = ELPISDAW_STABILITY_AI_PRODUCT_USE,
  bundledComponents = ELPISDAW_BUNDLED_JAVASCRIPT_COMPONENTS,
  signing = null,
  dependencies = {},
}) {
  if (process.platform !== 'win32' && dependencies.allowNonWindows !== true) {
    fail('UNSUPPORTED_BUILD_PLATFORM', 'ElpisDAW portable packages require Windows x64 release engineering.');
  }

  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
    fail('SOURCE_COMMIT_NOT_EXACT', 'Portable materialization requires one full source commit ID.');
  }

  const checkedRuntimePolicy = validateRuntimePolicy(runtimePolicy);
  const checkedStabilityAiPolicy = validateStabilityAiProductUsePolicy(
    stabilityAiProductUsePolicy,
  );
  const checkedComponents = validateBundledComponents(bundledComponents);
  const checkedVersion = validateVersion(version);
  const canonicalRepositoryPath = await resolveExistingDirectory(
    repositoryPath,
    'Release repository',
  );
  const checkedSigning = await validateSigningConfiguration(
    signing,
    canonicalRepositoryPath,
  );
  const canonicalOutputRoot = await resolveOutputRoot(
    outputRoot,
    canonicalRepositoryPath,
  );
  const inspectRepository = dependencies.inspectRepositoryBoundary ?? inspectRepositoryBoundary;
  const buildArtifacts = dependencies.buildReleaseArtifacts ?? buildReleaseArtifacts;
  const extractArchive = dependencies.extractNodeArchive ?? extractNodeArchive;
  const inspectNodeVersion = dependencies.readNodeVersion ?? readNodeVersion;
  const signNativeBinaries = dependencies.signPackageNativeBinaries ?? signPackageNativeBinaries;
  const validatePackage = dependencies.validateMaterializedPackage ?? validateMaterializedPackage;
  requireRepositoryBoundary(
    await inspectRepository(canonicalRepositoryPath),
    sourceCommit,
  );

  if (typeof nodeArchivePath !== 'string' || !isAbsolute(nodeArchivePath)) {
    fail('NODE_ARCHIVE_PATH_NOT_ABSOLUTE', 'Pinned Node.js archive path must be absolute.');
  }

  const canonicalNodeArchivePath = await realpath(resolve(nodeArchivePath)).catch(() =>
    fail('NODE_ARCHIVE_UNAVAILABLE', 'Pinned Node.js archive is unavailable.'),
  );
  await assertRegularFile(
    canonicalNodeArchivePath,
    'Pinned Node.js archive',
    MAXIMUM_NODE_ARCHIVE_BYTES,
  );

  if (
    basename(canonicalNodeArchivePath) !== checkedRuntimePolicy.archiveFileName ||
    isPathInside(canonicalRepositoryPath, canonicalNodeArchivePath) ||
    (await sha256File(canonicalNodeArchivePath)) !== checkedRuntimePolicy.archiveSha256
  ) {
    fail('NODE_ARCHIVE_PROVENANCE_MISMATCH', 'Pinned Node.js archive provenance changed.');
  }

  if (
    typeof stabilityAiAgreementPath !== 'string' ||
    !isAbsolute(stabilityAiAgreementPath)
  ) {
    fail(
      'STABILITY_AI_AGREEMENT_PATH_NOT_ABSOLUTE',
      'Pinned Stability AI agreement path must be absolute.',
    );
  }

  const canonicalStabilityAiAgreementPath = await realpath(
    resolve(stabilityAiAgreementPath),
  ).catch(() =>
    fail(
      'STABILITY_AI_AGREEMENT_UNAVAILABLE',
      'Pinned Stability AI agreement is unavailable.',
    ),
  );
  await assertRegularFile(
    canonicalStabilityAiAgreementPath,
    'Pinned Stability AI agreement',
    MAXIMUM_LICENSE_BYTES,
  );

  if (
    isPathInside(canonicalRepositoryPath, canonicalStabilityAiAgreementPath) ||
    (await sha256File(canonicalStabilityAiAgreementPath)) !==
      checkedStabilityAiPolicy.agreementSha256
  ) {
    fail(
      'STABILITY_AI_AGREEMENT_PROVENANCE_MISMATCH',
      'Pinned Stability AI agreement provenance changed.',
    );
  }

  await buildArtifacts(canonicalRepositoryPath);
  requireRepositoryBoundary(
    await inspectRepository(canonicalRepositoryPath),
    sourceCommit,
  );

  const stagingRoot = await mkdtemp(
    join(dirname(canonicalOutputRoot), '.elpisdaw-portable-staging-'),
  );
  const extractionRoot = await mkdtemp(join(tmpdir(), 'elpisdaw-node-runtime-'));
  let published = false;

  try {
    await extractArchive(canonicalNodeArchivePath, extractionRoot);
    const extractedEntries = await readdir(extractionRoot, { withFileTypes: true });

    if (
      extractedEntries.length !== 1 ||
      extractedEntries[0].name !== checkedRuntimePolicy.archiveRootName ||
      !extractedEntries[0].isDirectory() ||
      extractedEntries[0].isSymbolicLink()
    ) {
      fail('NODE_ARCHIVE_LAYOUT_MISMATCH', 'Pinned Node.js archive layout changed.');
    }

    const extractedRuntimeRoot = join(
      extractionRoot,
      checkedRuntimePolicy.archiveRootName,
    );
    const extractedNodePath = join(extractedRuntimeRoot, 'node.exe');
    const extractedLicensePath = join(extractedRuntimeRoot, 'LICENSE');
    await assertRegularFile(extractedNodePath, 'Pinned Node.js executable');
    await assertRegularFile(
      extractedLicensePath,
      'Pinned Node.js license',
      MAXIMUM_LICENSE_BYTES,
    );

    if (
      (await sha256File(extractedNodePath)) !== checkedRuntimePolicy.nodeSha256 ||
      (await inspectNodeVersion(extractedNodePath)) !== `v${checkedRuntimePolicy.version}`
    ) {
      fail('NODE_RUNTIME_PROVENANCE_MISMATCH', 'Pinned Node.js runtime provenance changed.');
    }

    const packageRoot = join(
      stagingRoot,
      ELPISDAW_PORTABLE_PACKAGE.applicationDirectoryName,
    );
    const evidenceRoot = join(stagingRoot, 'evidence');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(evidenceRoot, { recursive: true });
    await copyRegularFile(
      join(canonicalRepositoryPath, 'engine', 'bin', 'ElpisDAW.exe'),
      join(packageRoot, 'ElpisDAW.exe'),
      'Built ElpisDAW launcher',
    );
    await copyRegularFile(
      join(canonicalRepositoryPath, 'engine', 'bin', 'HumStudio.DirectoryPicker.exe'),
      join(packageRoot, 'native', 'HumStudio.DirectoryPicker.exe'),
      'Built directory picker',
    );
    await copyRegularFile(
      join(canonicalRepositoryPath, 'LICENSE'),
      join(packageRoot, 'licenses', 'ElpisDAW-LICENSE.txt'),
      'ElpisDAW license',
    );
    await copyRegularFile(
      join(canonicalRepositoryPath, 'TRADEMARKS.md'),
      join(packageRoot, 'licenses', 'ElpisDAW-TRADEMARKS.md'),
      'ElpisDAW trademark policy',
    );
    await copyRegularFile(
      join(canonicalRepositoryPath, 'docs', 'AI_Generated_Output_Notice.md'),
      join(packageRoot, 'licenses', 'AI_GENERATED_OUTPUT_NOTICE.md'),
      'AI-generated output notice',
    );
    await copyRegularFile(
      join(canonicalRepositoryPath, 'docs', 'ElpisDAW_LLM_User_Guide.md'),
      join(packageRoot, 'docs', 'ElpisDAW_LLM_User_Guide.md'),
      'ElpisDAW LLM user guide',
    );
    await copyRegularFile(
      canonicalStabilityAiAgreementPath,
      join(packageRoot, 'licenses', 'Stability-AI-Community-License.md'),
      'Pinned Stability AI agreement',
    );
    await writeFile(
      join(packageRoot, 'licenses', 'STABILITY_AI_NOTICE.txt'),
      `${checkedStabilityAiPolicy.noticeText}\n`,
      'utf8',
    );
    await copyRegularFile(
      extractedNodePath,
      join(packageRoot, 'runtime', 'node.exe'),
      'Pinned Node.js executable',
    );
    await copyRegularFile(
      extractedLicensePath,
      join(packageRoot, 'runtime', 'LICENSE'),
      'Pinned Node.js license',
    );
    await copyRegularFile(
      extractedLicensePath,
      join(
        packageRoot,
        'runtime',
        'THIRD_PARTY_NOTICES',
        'Node.js-LICENSE.txt',
      ),
      'Pinned Node.js license',
    );
    await copySelectedTree(
      join(canonicalRepositoryPath, 'engine'),
      join(packageRoot, 'app', 'engine'),
      classifyEnginePath,
      'Engine source',
    );
    await copySelectedTree(
      join(canonicalRepositoryPath, 'shared'),
      join(packageRoot, 'app', 'shared'),
      classifySharedPath,
      'Shared runtime source',
    );
    await copySelectedTree(
      join(canonicalRepositoryPath, 'dist'),
      join(packageRoot, 'app', 'ui'),
      classifyUiPath,
      'Production UI build',
    );
    await assertRegularFile(
      join(packageRoot, 'app', 'engine', 'server.mjs'),
      'Packaged Local Engine entry point',
    );
    await assertRegularFile(
      join(packageRoot, 'app', 'ui', 'index.html'),
      'Packaged production UI entry point',
    );
    await assertRegularFile(
      join(packageRoot, 'app', 'ui', 'elpisdaw-icon.png'),
      'Packaged ElpisDAW web icon',
    );

    const copiedComponents = await copyBundledComponentLicenses(
      canonicalRepositoryPath,
      packageRoot,
      checkedComponents,
    );
    await writeFile(
      join(packageRoot, 'licenses', 'THIRD_PARTY_NOTICES.md'),
      createThirdPartyNotices(
        checkedRuntimePolicy,
        copiedComponents,
        checkedStabilityAiPolicy,
      ),
      'utf8',
    );
    await writeFile(
      join(packageRoot, 'licenses', 'SBOM.cdx.json'),
      `${JSON.stringify(
        createCycloneDxSbom({
          components: copiedComponents,
          runtimePolicy: checkedRuntimePolicy,
          sourceCommit,
          version: checkedVersion,
        }),
        null,
        2,
      )}\n`,
      'utf8',
    );

    const signingEvidence = checkedSigning
      ? validateSigningEvidence(
          await signNativeBinaries({ packageRoot, signing: checkedSigning }),
          checkedSigning,
        )
      : Object.freeze({ status: 'UNSIGNED_INTERNAL' });

    if (signingEvidence.status === 'SELF_SIGNED_PREVIEW') {
      await writeFile(
        join(packageRoot, SELF_SIGNED_PREVIEW_NOTICE_FILE_NAME),
        createSelfSignedPreviewNotice(signingEvidence),
        'utf8',
      );
    }

    const { manifest, serializedManifest } = await createReleaseManifest(
      packageRoot,
      checkedVersion,
    );
    const validationResultPath = join(evidenceRoot, 'launcher-validation.txt');
    await validatePackage({
      packageRoot,
      resultFilePath: validationResultPath,
      version: checkedVersion,
    });
    const payloadSizeBytes = manifest.files.reduce(
      (total, entry) => total + entry.sizeBytes,
      0,
    );
    const report = {
      formatVersion: 1,
      manifest: {
        payloadFileCount: manifest.files.length,
        payloadSizeBytes,
        sha256: sha256(serializedManifest),
      },
      nodeRuntime: {
        archiveFileName: checkedRuntimePolicy.archiveFileName,
        archiveSha256: checkedRuntimePolicy.archiveSha256,
        nodeSha256: checkedRuntimePolicy.nodeSha256,
        sourceUrl: checkedRuntimePolicy.sourceUrl,
        version: checkedRuntimePolicy.version,
      },
      packagePolicyVersion: ELPISDAW_PORTABLE_PACKAGE_POLICY_VERSION,
      platform: ELPISDAW_PORTABLE_PACKAGE.platform,
      product: ELPISDAW_PORTABLE_PACKAGE.product,
      signing: signingEvidence,
      sourceCommit,
      stabilityAiProductUse: {
        acceptableUsePolicyUrl: checkedStabilityAiPolicy.acceptableUsePolicyUrl,
        agreementSha256: checkedStabilityAiPolicy.agreementSha256,
        agreementSourceUrl: checkedStabilityAiPolicy.agreementSourceUrl,
        attributionText: checkedStabilityAiPolicy.attributionText,
        commercialRegistrationStatus:
          checkedStabilityAiPolicy.commercialRegistrationStatus,
        commercialRegistrationUrl:
          checkedStabilityAiPolicy.commercialRegistrationUrl,
        noticeSha256: sha256(`${checkedStabilityAiPolicy.noticeText}\n`),
      },
      status: 'READY',
      version: checkedVersion,
    };
    await writeFile(
      join(evidenceRoot, 'materialization-report.json'),
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
      evidenceRoot: join(canonicalOutputRoot, 'evidence'),
      manifest,
      outputRoot: canonicalOutputRoot,
      packageRoot: join(
        canonicalOutputRoot,
        ELPISDAW_PORTABLE_PACKAGE.applicationDirectoryName,
      ),
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
    ['--certificate-store', 'signingCertificateStore'],
    ['--node-archive', 'nodeArchivePath'],
    ['--output-root', 'outputRoot'],
    ['--sign-tool', 'signToolPath'],
    ['--sign-tool-sha256', 'signToolSha256'],
    ['--signing-trust-mode', 'signingTrustMode'],
    ['--signing-thumbprint', 'certificateThumbprint'],
    ['--source-commit', 'sourceCommit'],
    ['--stability-ai-agreement', 'stabilityAiAgreementPath'],
    ['--timestamp-url', 'timestampUrl'],
    ['--version', 'version'],
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const optionName = names.get(args[index]);

    if (!optionName || options[optionName] !== undefined) {
      fail('INVALID_ARGUMENT', 'Portable materializer arguments are invalid.');
    }

    if (index + 1 >= args.length || args[index + 1].trim() === '') {
      fail('MISSING_ARGUMENT_VALUE', 'Portable materializer argument value is missing.');
    }

    options[optionName] = args[index + 1];
    index += 1;
  }

  for (const requiredName of [
    'nodeArchivePath',
    'outputRoot',
    'sourceCommit',
    'stabilityAiAgreementPath',
  ]) {
    if (options[requiredName] === undefined) {
      fail(
        'MISSING_ARGUMENT',
        'Portable materializer requires source, runtime, Stability AI agreement, and output arguments.',
      );
    }
  }

  const signingOptionNames = [
    'signingCertificateStore',
    'signToolPath',
    'signToolSha256',
    'signingTrustMode',
    'certificateThumbprint',
    'timestampUrl',
  ];
  const suppliedSigningOptionNames = signingOptionNames.filter(
    (name) => options[name] !== undefined,
  );

  if (suppliedSigningOptionNames.length > 0) {
    for (const requiredName of [
      'signToolPath',
      'signToolSha256',
      'certificateThumbprint',
    ]) {
      if (options[requiredName] === undefined) {
        fail(
          'INVALID_SIGNING_CONFIGURATION',
          'Portable native signing arguments must be supplied as one complete set.',
        );
      }
    }

    const signingTrustMode = options.signingTrustMode ?? 'public-trust';
    if (
      !SIGNING_TRUST_MODES.has(signingTrustMode) ||
      (signingTrustMode === 'public-trust' && options.timestampUrl === undefined) ||
      (signingTrustMode === 'self-signed-preview' && options.timestampUrl !== undefined)
    ) {
      fail(
        'INVALID_SIGNING_CONFIGURATION',
        'Portable native signing mode and timestamp arguments are inconsistent.',
      );
    }

    options.signing = {
      certificateStore: options.signingCertificateStore ?? 'current-user',
      certificateThumbprint: options.certificateThumbprint,
      signToolPath: options.signToolPath,
      signToolSha256: options.signToolSha256,
      timestampUrl: options.timestampUrl,
      trustMode: signingTrustMode,
    };

    for (const name of signingOptionNames) {
      delete options[name];
    }
  }

  return options;
}

async function main() {
  try {
    const result = await materializeElpisDawPortablePackage(parseArguments(process.argv.slice(2)));
    process.stdout.write(`ElpisDAW portable candidate ready: ${result.outputRoot}\n`);
  } catch (error) {
    const code = error instanceof ElpisDawPortablePackageError
      ? error.code
      : 'UNEXPECTED_FAILURE';
    const message = error instanceof ElpisDawPortablePackageError
      ? error.message
      : 'ElpisDAW portable materialization failed unexpectedly.';
    process.stderr.write(`ERROR ${code}: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
