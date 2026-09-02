import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  runAceStepModelSnapshotCli,
} from './Verify-AceStepModelSnapshot.mjs';

describe('Verify ACE-Step Model Snapshot CLI', () => {
  it('returns 0 only for a snapshot ready for a real generation probe', async () => {
    const modelRoot = join(tmpdir(), 'ace-step-model');
    const firstWrites = [];
    const secondWrites = [];
    const options = {
      probeModelSnapshot: async () =>
        createAssessment('READY_FOR_REAL_GENERATION_PROBE'),
    };

    const firstExitCode = await runAceStepModelSnapshotCli([modelRoot], {
      ...options,
      writeOutput: (value) => firstWrites.push(value),
    });
    const secondExitCode = await runAceStepModelSnapshotCli([modelRoot], {
      ...options,
      writeOutput: (value) => secondWrites.push(value),
    });

    expect(firstExitCode).toBe(0);
    expect(secondExitCode).toBe(0);
    expect(firstWrites.join('')).toBe(secondWrites.join(''));
    expect(JSON.parse(firstWrites.join(''))).toEqual(
      createAssessment('READY_FOR_REAL_GENERATION_PROBE'),
    );
  });

  it('returns 2 for a valid but unverified snapshot', async () => {
    const writes = [];
    const exitCode = await runAceStepModelSnapshotCli(
      [join(tmpdir(), 'ace-step-model')],
      {
        probeModelSnapshot: async () => createAssessment('UNVERIFIED'),
        writeOutput: (value) => writes.push(value),
      },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(writes.join(''))).toEqual(createAssessment('UNVERIFIED'));
  });

  it('returns 1 for missing, extra, relative, or blank arguments', async () => {
    for (const args of [
      [],
      ['relative-model'],
      [''],
      [join(tmpdir(), 'model'), join(tmpdir(), 'other')],
    ]) {
      const writes = [];
      let calls = 0;
      const exitCode = await runAceStepModelSnapshotCli(args, {
        probeModelSnapshot: async () => {
          calls += 1;
          return createAssessment('READY_FOR_REAL_GENERATION_PROBE');
        },
        writeOutput: (value) => writes.push(value),
      });

      expect(exitCode).toBe(1);
      expect(calls).toBe(0);
      expect(JSON.parse(writes.join(''))).toEqual({
        error: {
          code: 'ACE_STEP_MODEL_PROBE_CLI_USAGE_INVALID',
          message: 'ACE-Step Model Snapshot could not be verified.',
        },
        status: 'VERIFICATION_FAILED',
      });
    }
  });

  it('sanitizes probe failures and invalid responses', async () => {
    const modelRoot = join(tmpdir(), 'ace-step-model');
    const failureWrites = [];
    const failureExitCode = await runAceStepModelSnapshotCli([modelRoot], {
      probeModelSnapshot: async () => {
        const error = new Error('secret path and token');
        error.code = 'not safe';
        throw error;
      },
      writeOutput: (value) => failureWrites.push(value),
    });
    const invalidWrites = [];
    const invalidExitCode = await runAceStepModelSnapshotCli([modelRoot], {
      probeModelSnapshot: async () => ({ status: 'looks-ready' }),
      writeOutput: (value) => invalidWrites.push(value),
    });

    expect(failureExitCode).toBe(1);
    expect(JSON.parse(failureWrites.join(''))).toEqual({
      error: {
        code: 'ACE_STEP_MODEL_PROBE_FAILED',
        message: 'ACE-Step Model Snapshot could not be verified.',
      },
      status: 'VERIFICATION_FAILED',
    });
    expect(invalidExitCode).toBe(1);
    expect(JSON.parse(invalidWrites.join('')).error.code).toBe(
      'ACE_STEP_MODEL_PROBE_RESPONSE_INVALID',
    );
  });
});

function createAssessment(status) {
  return {
    blockers:
      status === 'UNVERIFIED'
        ? [
            {
              code: 'ACE_STEP_MODEL_FILE_MISSING',
              message: 'ACE-Step Model required file is missing.',
            },
          ]
        : [],
    manifest: {
      manifestVersion: '1',
      modelRepository: 'ACE-Step/acestep-v15-base',
      modelRevision: 'e432212fec32b8965a14ffa57ae653438d6abd14',
      providerRevision: 'dce621408bee8c31b4fcf4811682eb9359e1bc94',
    },
    snapshot: {
      extraFilesPolicy: 'IGNORED_OUTSIDE_VERIFIED_SET',
      requiredFileCount: 6,
      totalRequiredBytes: 4_791_785_390,
      verifiedFileCount:
        status === 'READY_FOR_REAL_GENERATION_PROBE' ? 6 : 5,
    },
    status,
  };
}
