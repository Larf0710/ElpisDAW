import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  runAceStepExecutionSupportSnapshotCli,
} from './Verify-AceStepExecutionSupportSnapshot.mjs';

describe('Verify ACE-Step execution-support snapshot CLI', () => {
  it('returns the shared deterministic success contract', async () => {
    const writes = [];
    const assessment = createAssessment('READY_FOR_REAL_GENERATION_PROBE');
    const exitCode = await runAceStepExecutionSupportSnapshotCli(
      [join(tmpdir(), 'ace-step-checkpoints')],
      {
        probeExecutionSupportSnapshot: async () => assessment,
        writeOutput: (value) => writes.push(value),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(writes.join(''))).toEqual(assessment);
  });

  it('keeps incomplete support files fail-closed', async () => {
    const writes = [];
    const assessment = createAssessment('UNVERIFIED');
    const exitCode = await runAceStepExecutionSupportSnapshotCli(
      [join(tmpdir(), 'ace-step-checkpoints')],
      {
        probeExecutionSupportSnapshot: async () => assessment,
        writeOutput: (value) => writes.push(value),
      },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(writes.join(''))).toEqual(assessment);
  });

  it('rejects a relative checkpoints root before probing', async () => {
    const writes = [];
    let calls = 0;
    const exitCode = await runAceStepExecutionSupportSnapshotCli(
      ['relative-checkpoints'],
      {
        probeExecutionSupportSnapshot: async () => {
          calls += 1;
          return createAssessment('READY_FOR_REAL_GENERATION_PROBE');
        },
        writeOutput: (value) => writes.push(value),
      },
    );

    expect(exitCode).toBe(1);
    expect(calls).toBe(0);
    expect(JSON.parse(writes.join('')).status).toBe('VERIFICATION_FAILED');
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
      modelRepository: 'ACE-Step/Ace-Step1.5',
      modelRevision: '19671f406d603126926c1b7e2adc169acbcade22',
      providerRevision: 'dce621408bee8c31b4fcf4811682eb9359e1bc94',
    },
    snapshot: {
      extraFilesPolicy: 'IGNORED_OUTSIDE_VERIFIED_SET',
      requiredFileCount: 11,
      totalRequiredBytes: 1_544_902_819,
      verifiedFileCount:
        status === 'READY_FOR_REAL_GENERATION_PROBE' ? 11 : 10,
    },
    status,
  };
}
