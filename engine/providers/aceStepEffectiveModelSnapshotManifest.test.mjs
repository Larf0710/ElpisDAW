import { describe, expect, it } from 'vitest';

import {
  ACE_STEP_PINNED_EFFECTIVE_MODEL_SNAPSHOT_MANIFEST,
} from './aceStepEffectiveModelSnapshotManifest.mjs';
import {
  ACE_STEP_PINNED_MODEL_SNAPSHOT_MANIFEST,
} from './aceStepModelSnapshotManifest.mjs';

describe('ACE-Step effective execution Model Snapshot manifest', () => {
  it('combines immutable official weights with pinned Provider-side Base code', () => {
    const effective = ACE_STEP_PINNED_EFFECTIVE_MODEL_SNAPSHOT_MANIFEST;
    const canonical = ACE_STEP_PINNED_MODEL_SNAPSHOT_MANIFEST;

    expect(effective).toMatchObject({
      manifestVersion: '1',
      modelRepository: 'ACE-Step/acestep-v15-base',
      modelRevision: 'e432212fec32b8965a14ffa57ae653438d6abd14',
      providerRevision: 'dce621408bee8c31b4fcf4811682eb9359e1bc94',
    });
    expect(effective.files).toEqual([
      {
        path: 'apg_guidance.py',
        sha256: 'f51c7c8ed2fcd55e24b9a8226824679a48456feafed0f34e116e5b2c24e9b967',
        sizeBytes: 627,
      },
      canonical.files[1],
      {
        path: 'configuration_acestep_v15.py',
        sha256: 'a48cf207b12b24913fa680b085a410855a628e48841ab885d90c23f0ccb44dd6',
        sizeBytes: 217,
      },
      canonical.files[3],
      {
        path: 'modeling_acestep_v15_base.py',
        sha256: 'dd8857d821f0c9cd0a04b35ca876cca332515a81bf8c4a8177770e2f074bc060',
        sizeBytes: 110_932,
      },
      canonical.files[5],
    ]);
    expect(effective.files[1]).toBe(canonical.files[1]);
    expect(effective.files[3]).toBe(canonical.files[3]);
    expect(effective.files[5]).toBe(canonical.files[5]);
  });

  it('is deeply frozen with a deterministic total size', () => {
    const manifest = ACE_STEP_PINNED_EFFECTIVE_MODEL_SNAPSHOT_MANIFEST;

    expect(
      manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
    ).toBe(4_791_780_535);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.files)).toBe(true);
    expect(manifest.files.every(Object.isFrozen)).toBe(true);
  });
});
