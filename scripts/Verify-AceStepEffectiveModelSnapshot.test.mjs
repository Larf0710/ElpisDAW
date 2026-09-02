import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  runAceStepEffectiveModelSnapshotCli,
} from './Verify-AceStepEffectiveModelSnapshot.mjs';

describe('Verify ACE-Step effective Model Snapshot CLI', () => {
  it('returns 0 only for a ready effective snapshot', async () => {
    const writes = [];
    const assessment = createAssessment('READY_FOR_REAL_GENERATION_PROBE');
    const exitCode = await runAceStepEffectiveModelSnapshotCli(
      [join(tmpdir(), 'ace-step-effective-model')],
      {
        probeEffectiveModelSnapshot: async () => assessment,
        writeOutput: (value) => writes.push(value),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(writes.join(''))).toEqual(assessment);
  });

  it('returns 2 without promoting an incomplete derived snapshot', async () => {
    const writes = [];
    const assessment = createAssessment('UNVERIFIED');
    const exitCode = await runAceStepEffectiveModelSnapshotCli(
      [join(tmpdir(), 'ace-step-effective-model')],
      {
        probeEffectiveModelSnapshot: async () => assessment,
        writeOutput: (value) => writes.push(value),
      },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(writes.join(''))).toEqual(assessment);
  });
});

function createAssessment(status) {
  return {
    blockers:
      status === 'UNVERIFIED'
        ? [
            {
              code: 'ACE_STEP_MODEL_FILE_SHA256_MISMATCH',
              message: 'ACE-Step Model file hash does not match.',
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
      totalRequiredBytes: 4_791_780_535,
      verifiedFileCount:
        status === 'READY_FOR_REAL_GENERATION_PROBE' ? 6 : 5,
    },
    status,
  };
}
