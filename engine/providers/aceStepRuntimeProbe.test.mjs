import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AceStepRuntimeProbeError,
  assessAceStepRuntimeProbe,
  probeAceStepRuntime,
  validateAceStepRuntimeProbeReport,
} from './aceStepRuntimeProbe.mjs';
import { ACE_STEP_RUNTIME_PROFILE_ID } from './aceStepRuntimeProfile.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('ACE-Step Runtime Probe', () => {
  it('accepts the exact target Runtime without claiming Model acceptance', () => {
    const assessment = assessAceStepRuntimeProbe(createReadyReport());

    expect(assessment).toEqual({
      blockers: [],
      environment: createReadyReport(),
      profileId: ACE_STEP_RUNTIME_PROFILE_ID,
      status: 'READY_FOR_MODEL_PROBE',
    });
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.blockers)).toBe(true);
    expect(Object.isFrozen(assessment.environment.packages.torch)).toBe(true);
  });

  it('reports every missing dependency and unavailable target boundary', () => {
    const assessment = assessAceStepRuntimeProbe({
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
        aceStep: createMissingPackage(),
        torch: createMissingPackage(),
        torchaudio: createMissingPackage(),
      },
      platform: 'linux',
      python: {
        implementation: 'PyPy',
        version: '3.10.6',
      },
    });

    expect(assessment.status).toBe('UNVERIFIED');
    expect(assessment.blockers.map(({ code }) => code)).toEqual([
      'PLATFORM_UNSUPPORTED',
      'ARCHITECTURE_UNSUPPORTED',
      'PYTHON_IMPLEMENTATION_UNSUPPORTED',
      'PYTHON_VERSION_UNSUPPORTED',
      'ACE_STEP_PACKAGE_MISSING',
      'PYTORCH_MISSING',
      'TORCHAUDIO_MISSING',
      'CUDA_UNAVAILABLE',
      'CUDA_BUILD_VERSION_MISMATCH',
      'GPU_MISMATCH',
      'GPU_MEMORY_INSUFFICIENT',
    ]);
  });

  it('distinguishes import failures and incompatible package versions', () => {
    const assessment = assessAceStepRuntimeProbe({
      ...createReadyReport(),
      packages: {
        aceStep: createPackage({ importable: false, version: '1.5.0' }),
        torch: createPackage({ version: '2.7.1+cu126' }),
        torchaudio: createPackage({ importable: false, version: '2.7.1+cu128' }),
      },
    });

    expect(assessment.blockers.map(({ code }) => code)).toEqual([
      'ACE_STEP_PACKAGE_IMPORT_FAILED',
      'PYTORCH_VERSION_MISMATCH',
      'TORCHAUDIO_IMPORT_FAILED',
    ]);
  });

  it('rejects malformed, extra, or internally inconsistent reports', () => {
    expect(() =>
      validateAceStepRuntimeProbeReport({
        ...createReadyReport(),
        unexpected: true,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'ACE_STEP_PROBE_RESPONSE_INVALID' }),
    );

    expect(() =>
      validateAceStepRuntimeProbeReport({
        ...createReadyReport(),
        packages: {
          ...createReadyReport().packages,
          torch: {
            available: false,
            importable: false,
            importErrorType: 'ModuleNotFoundError',
            version: '2.7.1+cu128',
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

    const assessment = await probeAceStepRuntime(pythonPath, {
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
      probeAceStepRuntime(join(tmpdir(), 'missing-ace-step-python.exe')),
    ).rejects.toMatchObject({
      code: 'ACE_STEP_PROBE_RUNTIME_UNAVAILABLE',
    });

    const directory = await createTemporaryDirectory();
    const pythonPath = join(directory, 'python.exe');
    const probeScriptPath = join(directory, 'probe.py');
    await writeFile(pythonPath, 'test');
    await writeFile(probeScriptPath, 'test');

    await expect(
      probeAceStepRuntime(pythonPath, {
        probeScriptPath,
        runProcess: async () => ({ stderr: '', stdout: 'not-json' }),
      }),
    ).rejects.toBeInstanceOf(AceStepRuntimeProbeError);
    await expect(
      probeAceStepRuntime(pythonPath, {
        probeScriptPath,
        runProcess: async () => ({ stderr: '', stdout: 'not-json' }),
      }),
    ).rejects.toMatchObject({
      code: 'ACE_STEP_PROBE_RESPONSE_INVALID',
    });
  });
});

function createReadyReport() {
  return {
    architecture: 'AMD64',
    cuda: {
      available: true,
      buildVersion: '12.8',
      deviceName: 'NVIDIA GeForce RTX 4060 Ti',
      probeErrorType: null,
      totalMemoryMiB: 16_380,
    },
    packages: {
      aceStep: createPackage({ version: '1.5.0' }),
      torch: createPackage({ version: '2.7.1+cu128' }),
      torchaudio: createPackage({ version: '2.7.1+cu128' }),
    },
    platform: 'win32',
    probeVersion: '1',
    python: {
      implementation: 'CPython',
      version: '3.11.9',
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
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-ace-step-probe-'));
  temporaryDirectories.add(directory);
  return directory;
}
