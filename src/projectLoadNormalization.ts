import type { ProjectMixerStateNormalizationMetadata } from './projectMixerState';

export type NormalizedProjectLoad<Workspace extends object> = Readonly<{
  mixerNormalization: ProjectMixerStateNormalizationMetadata;
  workspace: Workspace;
}>;

export function createNormalizedProjectLoad<Workspace extends object>(
  workspace: Workspace,
  mixerNormalization: ProjectMixerStateNormalizationMetadata,
): NormalizedProjectLoad<Workspace> {
  return Object.freeze({ mixerNormalization, workspace });
}

/**
 * A migrated Project intentionally receives a distinct saved baseline until a
 * successful save stores the normalized Mixer State v2 representation.
 */
export function createSavedProjectFingerprintAfterLoad(
  normalizedFingerprint: string,
  mixerNormalization: ProjectMixerStateNormalizationMetadata,
): string {
  if (!mixerNormalization.migrated) {
    return normalizedFingerprint;
  }

  return JSON.stringify({
    pendingMixerStateV2Save: mixerNormalization.source,
    normalizedFingerprint,
  });
}
