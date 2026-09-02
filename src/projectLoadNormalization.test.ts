import { describe, expect, it } from 'vitest';

import {
  createNormalizedProjectLoad,
  createSavedProjectFingerprintAfterLoad,
} from './projectLoadNormalization';
import { createSessionEditHistory } from './sessionEditHistory';

describe('Project load normalization', () => {
  it.each(['legacy-no-mixer', 'mixer-state-v1'] as const)(
    'keeps a %s load dirty until its normalized v2 representation is saved',
    (source) => {
      const normalizedFingerprint = '{"mixer":{"schemaVersion":2}}';
      const savedFingerprint = createSavedProjectFingerprintAfterLoad(
        normalizedFingerprint,
        Object.freeze({ migrated: true, source }),
      );

      expect(savedFingerprint).not.toBe(normalizedFingerprint);
      const savedAfterSuccessfulSave = normalizedFingerprint;
      expect(savedAfterSuccessfulSave).not.toBe(savedFingerprint);
    },
  );

  it('keeps a valid v2 reopen clean without creating an Undo entry', () => {
    const workspace = Object.freeze({ projectId: 'loaded-v2' });
    const load = createNormalizedProjectLoad(
      workspace,
      Object.freeze({ migrated: false, source: 'mixer-state-v2' }),
    );
    const fingerprint = '{"mixer":{"schemaVersion":2}}';
    const history = createSessionEditHistory(load.workspace, {
      category: 'system',
      createdAt: '2026-08-09T00:00:00.000Z',
      id: 'project-load',
      label: 'Open Project',
    });

    expect(createSavedProjectFingerprintAfterLoad(
      fingerprint,
      load.mixerNormalization,
    )).toBe(fingerprint);
    expect(history.past).toEqual([]);
    expect(history.future).toEqual([]);
    expect(history.present.value).toBe(workspace);
  });
});
