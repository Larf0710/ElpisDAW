import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  StableAudio3RuntimeProbeError,
  assessStableAudio3RuntimeProbe,
  probeStableAudio3Runtime,
  validateStableAudio3RuntimeProbeReport,
} from './stableAudio3RuntimeProbe.mjs';
import { STABLE_AUDIO_3_RUNTIME_PROFILE_ID } from './stableAudio3RuntimeProfile.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('Stable Audio 3 Runtime Probe', () => {
  it('accepts the exact target environment without claiming Model acceptance', () => {
    const assessment = assessStableAudio3RuntimeProbe(createReadyReport());

    expect(assessment).toEqual({
      blockers: [],
      environment: createReadyReport(),
      profileId: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
      status: 'READY_FOR_MODEL_PROBE',
    });
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.blockers)).toBe(true);
    expect(Object.isFrozen(assessment.environment.packages.torch)).toBe(true);
  });

  it('reports every missing dependency and unavailable target boundary', () => {
    const assessment = assessStableAudio3RuntimeProbe({
      ...createReadyReport(),
      architecture: 'ARM64',
      cuda: {
        available: false,
        buildVersion: null,
        deviceName: null,
        probeErrorType: null,
        totalMemoryMiB: null,
      },
      packages: {
        flashAttention: createMissingPackage(),
        stableAudio3: createMissingPackage(),
        torch: createMissingPackage(),
        torchaudio: createMissingPackage(),
      },
      platform: 'linux',
      python: {
        implementation: 'PyPy',
        version: '3.11.9',
      },
    });

    expect(assessment.status).toBe('UNVERIFIED');
    expect(assessment.blockers.map(({ code }) => code)).toEqual([
      'PLATFORM_UNSUPPORTED',
      'ARCHITECTURE_UNSUPPORTED',
      'PYTHON_IMPLEMENTATION_UNSUPPORTED',
      'PYTHON_VERSION_UNSUPPORTED',
      'STABLE_AUDIO_3_PACKAGE_MISSING',
      'PYTORCH_MISSING',
      'TORCHAUDIO_MISSING',
      'FLASH_ATTENTION_MISSING',
      'CUDA_UNAVAILABLE',
      'CUDA_BUILD_VERSION_MISMATCH',
      'GPU_MISMATCH',
      'GPU_MEMORY_INSUFFICIENT',
    ]);
  });

  it('distinguishes import failures and incompatible versions', () => {
    const assessment = assessStableAudio3RuntimeProbe({
      ...createReadyReport(),
      packages: {
        flashAttention: createPackage({ version: '1.0.9' }),
        stableAudio3: createPackage({ importable: false, version: '0.1.0' }),
        torch: createPackage({ version: '2.6.0+cu126' }),
        torchaudio: createPackage({ importable: false, version: '2.7.1+cu126' }),
      },
    });

    expect(assessment.blockers.map(({ code }) => code)).toEqual([
      'STABLE_AUDIO_3_PACKAGE_IMPORT_FAILED',
      'PYTORCH_VERSION_MISMATCH',
      'TORCHAUDIO_IMPORT_FAILED',
      'FLASH_ATTENTION_VERSION_UNSUPPORTED',
    ]);
  });

  it('rejects malformed, extra, or internally inconsistent reports', () => {
    expect(() =>
      validateStableAudio3RuntimeProbeReport({
        ...createReadyReport(),
        unexpected: true,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'STABLE_AUDIO_3_PROBE_RESPONSE_INVALID' }),
    );

    expect(() =>
      validateStableAudio3RuntimeProbeReport({
        ...createReadyReport(),
        packages: {
          ...createReadyReport().packages,
          torch: {
            available: false,
            importable: false,
            importErrorType: 'ModuleNotFoundError',
            version: '2.7.1',
          },
        },
      }),
    ).toThrow('state is inconsistent');
  });

  it('uses canonical regular files and returns only validated process output', async () => {
    const directory = await createTemporaryDirectory();
    const pythonPath = join(directory, 'python.exe');
    const probeScriptPath = join(directory, 'probe.py');
    await writeFile(pythonPath, 'test');
    await writeFile(probeScriptPath, 'test');
    const calls = [];
    const [canonicalPythonPath, canonicalProbeScriptPath] = await Promise.all([
      realpath(pythonPath),
      realpath(probeScriptPath),
    ]);

    const assessment = await probeStableAudio3Runtime(pythonPath, {
      probeScriptPath,
      runProcess: async (request) => {
        calls.push(request);
        return { stderr: '', stdout: JSON.stringify(createReadyReport()) };
      },
      timeoutMs: 1_234,
    });

    expect(assessment.status).toBe('READY_FOR_MODEL_PROBE');
    expect(calls).toEqual([
      {
        probeScriptPath: canonicalProbeScriptPath,
        pythonPath: canonicalPythonPath,
        timeoutMs: 1_234,
      },
    ]);
  });

  it('rejects missing runtimes and non-JSON subprocess output', async () => {
    await expect(
      probeStableAudio3Runtime(join(tmpdir(), 'missing-stable-audio-python.exe')),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_PROBE_RUNTIME_UNAVAILABLE',
    });

    const directory = await createTemporaryDirectory();
    const pythonPath = join(directory, 'python.exe');
    const probeScriptPath = join(directory, 'probe.py');
    await writeFile(pythonPath, 'test');
    await writeFile(probeScriptPath, 'test');

    await expect(
      probeStableAudio3Runtime(pythonPath, {
        probeScriptPath,
        runProcess: async () => ({ stderr: '', stdout: 'not-json' }),
      }),
    ).rejects.toBeInstanceOf(StableAudio3RuntimeProbeError);
    await expect(
      probeStableAudio3Runtime(pythonPath, {
        probeScriptPath,
        runProcess: async () => ({ stderr: '', stdout: 'not-json' }),
      }),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_PROBE_RESPONSE_INVALID',
    });
  });
});

function createReadyReport() {
  return {
    architecture: 'AMD64',
    cuda: {
      available: true,
      buildVersion: '12.6',
      deviceName: 'NVIDIA GeForce RTX 4060 Ti',
      probeErrorType: null,
      totalMemoryMiB: 16_380,
    },
    packages: {
      flashAttention: createPackage({ version: '2.7.4' }),
      stableAudio3: createPackage({ version: '0.1.0' }),
      torch: createPackage({ version: '2.7.1+cu126' }),
      torchaudio: createPackage({ version: '2.7.1+cu126' }),
    },
    platform: 'win32',
    probeVersion: '1',
    python: {
      implementation: 'CPython',
      version: '3.10.6',
    },
  };
}

function createPackage({ importable = true, version }) {
  return {
    available: true,
    importable,
    importErrorType: importable ? null : 'ImportError',
    version,
  };
}

function createMissingPackage() {
  return {
    available: false,
    importable: false,
    importErrorType: 'ModuleNotFoundError',
    version: null,
  };
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-stable-audio-3-probe-'));
  temporaryDirectories.add(directory);
  return directory;
}
