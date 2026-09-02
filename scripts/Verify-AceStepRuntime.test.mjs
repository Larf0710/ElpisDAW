import { describe, expect, it } from 'vitest';

import { runAceStepRuntimeCli } from './Verify-AceStepRuntime.mjs';

describe('Verify ACE-Step Runtime CLI', () => {
  it('returns success only for a Runtime ready for Model probing', async () => {
    const writes = [];
    const exitCode = await runAceStepRuntimeCli(['C:\\Runtime\\python.exe'], {
      probeRuntime: async () => createAssessment('READY_FOR_MODEL_PROBE'),
      writeOutput: (value) => writes.push(value),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(writes.join(''))).toEqual(
      createAssessment('READY_FOR_MODEL_PROBE'),
    );
  });

  it('returns a distinct non-success result for an unverified Runtime', async () => {
    const writes = [];
    const exitCode = await runAceStepRuntimeCli(['C:\\Runtime\\python.exe'], {
      probeRuntime: async () => createAssessment('UNVERIFIED'),
      writeOutput: (value) => writes.push(value),
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(writes.join('')).status).toBe('UNVERIFIED');
  });

  it('rejects missing or relative Python paths without running the probe', async () => {
    for (const args of [[], ['python.exe']]) {
      const writes = [];
      let calls = 0;
      const exitCode = await runAceStepRuntimeCli(args, {
        probeRuntime: async () => {
          calls += 1;
          return createAssessment('READY_FOR_MODEL_PROBE');
        },
        writeOutput: (value) => writes.push(value),
      });

      expect(exitCode).toBe(1);
      expect(calls).toBe(0);
      expect(JSON.parse(writes.join(''))).toEqual({
        error: {
          code: 'ACE_STEP_PROBE_CLI_USAGE_INVALID',
          message: 'ACE-Step Runtime could not be verified.',
        },
        status: 'VERIFICATION_FAILED',
      });
    }
  });

  it('sanitizes probe failures', async () => {
    const writes = [];
    const exitCode = await runAceStepRuntimeCli(['C:\\Runtime\\python.exe'], {
      probeRuntime: async () => {
        const error = new Error('sensitive runtime detail');
        error.code = 'not safe';
        throw error;
      },
      writeOutput: (value) => writes.push(value),
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(writes.join(''))).toEqual({
      error: {
        code: 'ACE_STEP_PROBE_FAILED',
        message: 'ACE-Step Runtime could not be verified.',
      },
      status: 'VERIFICATION_FAILED',
    });
  });
});

function createAssessment(status) {
  return {
    blockers:
      status === 'UNVERIFIED'
        ? [{ code: 'PYTHON_VERSION_UNSUPPORTED', message: 'Use CPython 3.11.' }]
        : [],
    environment: {
      platform: 'win32',
    },
    profileId:
      'windows-x64-cpython-3-11-pytorch-2-7-1-cu128-ace-step-1-5-0',
    status,
  };
}
