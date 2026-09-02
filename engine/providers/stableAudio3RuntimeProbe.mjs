import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STABLE_AUDIO_3_CUDA_VERSION,
  STABLE_AUDIO_3_MINIMUM_GPU_MEMORY_MIB,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_PYTORCH_VERSION,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
  STABLE_AUDIO_3_TARGET_GPU_NAME,
  STABLE_AUDIO_3_TORCHAUDIO_VERSION,
} from './stableAudio3RuntimeProfile.mjs';

const DEFAULT_PROBE_SCRIPT_PATH = fileURLToPath(
  new URL('./stableAudio3RuntimeProbe.py', import.meta.url),
);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1_024;
const PROBE_VERSION = '1';
const EXPECTED_ARCHITECTURES = new Set(['AMD64', 'x86_64']);

export class StableAudio3RuntimeProbeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'StableAudio3RuntimeProbeError';
  }
}

export async function probeStableAudio3Runtime(
  pythonPath,
  {
    probeScriptPath = DEFAULT_PROBE_SCRIPT_PATH,
    runProcess = runPythonProbe,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  if (typeof pythonPath !== 'string' || !isAbsolute(pythonPath)) {
    throw new TypeError('Stable Audio 3 Runtime Probe Python path must be absolute.');
  }

  if (typeof probeScriptPath !== 'string' || !isAbsolute(probeScriptPath)) {
    throw new TypeError('Stable Audio 3 Runtime Probe script path must be absolute.');
  }

  if (typeof runProcess !== 'function') {
    throw new TypeError('Stable Audio 3 Runtime Probe runner must be a function.');
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Stable Audio 3 Runtime Probe timeout must be greater than zero.');
  }

  const canonicalPythonPath = await validateRegularFile(
    pythonPath,
    'Stable Audio 3 Runtime Probe Python executable is unavailable.',
  );
  const canonicalProbeScriptPath = await validateRegularFile(
    probeScriptPath,
    'Stable Audio 3 Runtime Probe script is unavailable.',
  );
  let processResult;

  try {
    processResult = await runProcess({
      probeScriptPath: canonicalProbeScriptPath,
      pythonPath: canonicalPythonPath,
      timeoutMs,
    });
  } catch (error) {
    throw new StableAudio3RuntimeProbeError(
      'STABLE_AUDIO_3_PROBE_FAILED',
      'Stable Audio 3 Runtime Probe process failed.',
      { cause: error },
    );
  }

  if (
    !isRecord(processResult) ||
    typeof processResult.stdout !== 'string' ||
    typeof processResult.stderr !== 'string' ||
    Buffer.byteLength(processResult.stdout, 'utf8') > MAX_OUTPUT_BYTES ||
    Buffer.byteLength(processResult.stderr, 'utf8') > MAX_OUTPUT_BYTES
  ) {
    throw createResponseError('Stable Audio 3 Runtime Probe process output is invalid.');
  }

  let rawReport;

  try {
    rawReport = JSON.parse(processResult.stdout.trim());
  } catch {
    throw createResponseError('Stable Audio 3 Runtime Probe emitted non-JSON output.');
  }

  return assessStableAudio3RuntimeProbe(rawReport);
}

export function assessStableAudio3RuntimeProbe(value) {
  const report = validateStableAudio3RuntimeProbeReport(value);
  const blockers = [];

  if (report.platform !== 'win32') {
    addBlocker(
      blockers,
      'PLATFORM_UNSUPPORTED',
      'Stable Audio 3 target Runtime requires native Windows.',
    );
  }

  if (!EXPECTED_ARCHITECTURES.has(report.architecture)) {
    addBlocker(
      blockers,
      'ARCHITECTURE_UNSUPPORTED',
      'Stable Audio 3 target Runtime requires x64 architecture.',
    );
  }

  if (report.python.implementation !== 'CPython') {
    addBlocker(
      blockers,
      'PYTHON_IMPLEMENTATION_UNSUPPORTED',
      'Stable Audio 3 target Runtime requires CPython.',
    );
  }

  const pythonVersion = parseVersion(report.python.version);

  if (pythonVersion?.major !== 3 || pythonVersion?.minor !== 10) {
    addBlocker(
      blockers,
      'PYTHON_VERSION_UNSUPPORTED',
      'Stable Audio 3 target Runtime is pinned to CPython 3.10.',
    );
  }

  assessExactPackage(
    blockers,
    report.packages.stableAudio3,
    'STABLE_AUDIO_3_PACKAGE',
    STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
    'stable-audio-3',
  );
  assessExactPackage(
    blockers,
    report.packages.torch,
    'PYTORCH',
    STABLE_AUDIO_3_PYTORCH_VERSION,
    'PyTorch',
  );
  assessExactPackage(
    blockers,
    report.packages.torchaudio,
    'TORCHAUDIO',
    STABLE_AUDIO_3_TORCHAUDIO_VERSION,
    'TorchAudio',
  );

  if (!report.packages.flashAttention.available) {
    addBlocker(
      blockers,
      'FLASH_ATTENTION_MISSING',
      'Flash Attention 2 is not installed.',
    );
  } else if (!report.packages.flashAttention.importable) {
    addBlocker(
      blockers,
      'FLASH_ATTENTION_IMPORT_FAILED',
      'Flash Attention is installed but cannot be imported.',
    );
  } else if (parseVersion(report.packages.flashAttention.version)?.major !== 2) {
    addBlocker(
      blockers,
      'FLASH_ATTENTION_VERSION_UNSUPPORTED',
      'Stable Audio 3 Medium requires Flash Attention 2.',
    );
  }

  if (!report.cuda.available) {
    addBlocker(blockers, 'CUDA_UNAVAILABLE', 'PyTorch CUDA is unavailable.');
  }

  if (report.cuda.buildVersion !== STABLE_AUDIO_3_CUDA_VERSION) {
    addBlocker(
      blockers,
      'CUDA_BUILD_VERSION_MISMATCH',
      `PyTorch must use CUDA ${STABLE_AUDIO_3_CUDA_VERSION}.`,
    );
  }

  if (report.cuda.deviceName !== STABLE_AUDIO_3_TARGET_GPU_NAME) {
    addBlocker(
      blockers,
      'GPU_MISMATCH',
      `Stable Audio 3 target GPU must be ${STABLE_AUDIO_3_TARGET_GPU_NAME}.`,
    );
  }

  if (
    report.cuda.totalMemoryMiB === null ||
    report.cuda.totalMemoryMiB < STABLE_AUDIO_3_MINIMUM_GPU_MEMORY_MIB
  ) {
    addBlocker(
      blockers,
      'GPU_MEMORY_INSUFFICIENT',
      `Stable Audio 3 target GPU requires at least ${STABLE_AUDIO_3_MINIMUM_GPU_MEMORY_MIB} MiB.`,
    );
  }

  return Object.freeze({
    blockers: Object.freeze(blockers),
    environment: report,
    profileId: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
    status: blockers.length === 0 ? 'READY_FOR_MODEL_PROBE' : 'UNVERIFIED',
  });
}

export function validateStableAudio3RuntimeProbeReport(value) {
  requireExactKeys(
    value,
    ['architecture', 'cuda', 'packages', 'platform', 'probeVersion', 'python'],
    'Stable Audio 3 Runtime Probe report',
  );

  if (value.probeVersion !== PROBE_VERSION) {
    throw createResponseError('Stable Audio 3 Runtime Probe version is unsupported.');
  }

  const architecture = requireText(value.architecture, 'Probe architecture');
  const platform = requireText(value.platform, 'Probe platform');
  const python = validatePython(value.python);
  const packages = validatePackages(value.packages);
  const cuda = validateCuda(value.cuda);

  return Object.freeze({
    architecture,
    cuda,
    packages,
    platform,
    probeVersion: PROBE_VERSION,
    python,
  });
}

function validatePython(value) {
  requireExactKeys(value, ['implementation', 'version'], 'Probe Python');

  return Object.freeze({
    implementation: requireText(value.implementation, 'Probe Python implementation'),
    version: requireText(value.version, 'Probe Python version'),
  });
}

function validatePackages(value) {
  requireExactKeys(
    value,
    ['flashAttention', 'stableAudio3', 'torch', 'torchaudio'],
    'Probe packages',
  );

  return Object.freeze({
    flashAttention: validatePackage(value.flashAttention, 'Flash Attention'),
    stableAudio3: validatePackage(value.stableAudio3, 'stable-audio-3'),
    torch: validatePackage(value.torch, 'PyTorch'),
    torchaudio: validatePackage(value.torchaudio, 'TorchAudio'),
  });
}

function validatePackage(value, label) {
  requireExactKeys(
    value,
    ['available', 'importErrorType', 'importable', 'version'],
    `Probe ${label}`,
  );

  if (typeof value.available !== 'boolean' || typeof value.importable !== 'boolean') {
    throw createResponseError(`Probe ${label} availability is invalid.`);
  }

  const version = requireNullableText(value.version, `Probe ${label} version`);
  const importErrorType = requireNullableText(
    value.importErrorType,
    `Probe ${label} import error`,
  );

  if (
    (value.available && version === null) ||
    (!value.available && version !== null) ||
    (value.importable && importErrorType !== null) ||
    (!value.importable && importErrorType === null)
  ) {
    throw createResponseError(`Probe ${label} state is inconsistent.`);
  }

  return Object.freeze({
    available: value.available,
    importable: value.importable,
    importErrorType,
    version,
  });
}

function validateCuda(value) {
  requireExactKeys(
    value,
    ['available', 'buildVersion', 'deviceName', 'probeErrorType', 'totalMemoryMiB'],
    'Probe CUDA',
  );

  if (typeof value.available !== 'boolean') {
    throw createResponseError('Probe CUDA availability is invalid.');
  }

  const buildVersion = requireNullableText(value.buildVersion, 'Probe CUDA build version');
  const deviceName = requireNullableText(value.deviceName, 'Probe CUDA device name');
  const probeErrorType = requireNullableText(
    value.probeErrorType,
    'Probe CUDA error type',
  );
  const totalMemoryMiB = value.totalMemoryMiB;

  if (
    totalMemoryMiB !== null &&
    (!Number.isSafeInteger(totalMemoryMiB) || totalMemoryMiB <= 0)
  ) {
    throw createResponseError('Probe CUDA memory is invalid.');
  }

  if (
    value.available &&
    (buildVersion === null ||
      deviceName === null ||
      totalMemoryMiB === null ||
      probeErrorType !== null)
  ) {
    throw createResponseError('Probe available CUDA state is incomplete.');
  }

  if (
    !value.available &&
    (deviceName !== null || totalMemoryMiB !== null)
  ) {
    throw createResponseError('Probe unavailable CUDA state contains device facts.');
  }

  return Object.freeze({
    available: value.available,
    buildVersion,
    deviceName,
    probeErrorType,
    totalMemoryMiB,
  });
}

function assessExactPackage(blockers, report, codePrefix, version, label) {
  if (!report.available) {
    addBlocker(blockers, `${codePrefix}_MISSING`, `${label} is not installed.`);
    return;
  }

  if (!report.importable) {
    addBlocker(
      blockers,
      `${codePrefix}_IMPORT_FAILED`,
      `${label} is installed but cannot be imported.`,
    );
    return;
  }

  if (!matchesBaseVersion(report.version, version)) {
    addBlocker(
      blockers,
      `${codePrefix}_VERSION_MISMATCH`,
      `${label} must use version ${version}.`,
    );
  }
}

function matchesBaseVersion(actual, expected) {
  return typeof actual === 'string' && actual.split('+', 1)[0] === expected;
}

function parseVersion(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);

  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: match[3] === undefined ? undefined : Number(match[3]),
      }
    : undefined;
}

function addBlocker(blockers, code, message) {
  blockers.push(Object.freeze({ code, message }));
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) {
    throw createResponseError(`${label} must be an object.`);
  }

  const actualKeys = Object.keys(value).sort();

  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw createResponseError(`${label} keys are invalid.`);
  }
}

function requireText(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 256
  ) {
    throw createResponseError(`${label} is invalid.`);
  }

  return value;
}

function requireNullableText(value, label) {
  return value === null ? null : requireText(value, label);
}

async function validateRegularFile(path, message) {
  try {
    const fileStat = await lstat(path);

    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(message);
    }

    return await realpath(path);
  } catch (error) {
    throw new StableAudio3RuntimeProbeError(
      'STABLE_AUDIO_3_PROBE_RUNTIME_UNAVAILABLE',
      message,
      { cause: error },
    );
  }
}

function runPythonProbe({ probeScriptPath, pythonPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(
      pythonPath,
      ['-I', '-B', probeScriptPath],
      {
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({ stderr, stdout });
      },
    );
  });
}

function createResponseError(message) {
  return new StableAudio3RuntimeProbeError(
    'STABLE_AUDIO_3_PROBE_RESPONSE_INVALID',
    message,
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
