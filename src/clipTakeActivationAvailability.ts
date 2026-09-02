import type {
  GeneratedAudioCommitAvailabilityClient,
  GeneratedAudioCommitAvailabilityEvidence,
} from './generatedAudioCommitAvailability';
import { createLocalEngineGeneratedAudioDescriptor } from './generatedAudioDescriptor';
import type { LocalEngineHealthFailureReason } from './localEngineClient';
import type { AudioArtifact } from './types';

export type ClipTakeActivationAvailabilityFailureReason =
  | LocalEngineHealthFailureReason
  | 'artifact-invalid'
  | 'artifact-unavailable'
  | 'transport-failed';

export type ClipTakeActivationAvailabilityResult =
  | Readonly<{
      evidence: GeneratedAudioCommitAvailabilityEvidence;
      ok: true;
    }>
  | Readonly<{
      message: string;
      ok: false;
      reason: ClipTakeActivationAvailabilityFailureReason;
      status?: number;
    }>;

export async function verifyClipTakeActivationAvailability(
  client: GeneratedAudioCommitAvailabilityClient,
  artifact: AudioArtifact,
  clock: () => Date = () => new Date(),
): Promise<ClipTakeActivationAvailabilityResult> {
  const descriptor = createLocalEngineGeneratedAudioDescriptor(artifact);

  if (!descriptor) {
    return fail(
      'artifact-invalid',
      `${artifact.artifactId || 'Audio Artifact'} cannot be activated because its WAV descriptor is invalid.`,
    );
  }

  let availability;

  try {
    availability = await client.checkGeneratedAudioAvailability([descriptor]);
  } catch (error) {
    return fail(
      'transport-failed',
      error instanceof Error
        ? `Audio Take availability verification failed: ${error.message}`
        : 'Audio Take availability verification failed.',
    );
  }

  if (!availability.ok) {
    return Object.freeze({
      message: availability.message,
      ok: false as const,
      reason: availability.reason,
      ...(availability.status !== undefined
        ? { status: availability.status }
        : {}),
    });
  }

  if (
    availability.availableSourceIds.length !== 1 ||
    availability.availableSourceIds[0] !== artifact.artifactId
  ) {
    return fail(
      'artifact-unavailable',
      `${artifact.file.name} is unavailable in the current Project Root. The current Active Take was preserved.`,
    );
  }

  let checkedAt: string;

  try {
    checkedAt = clock().toISOString();
  } catch {
    return fail(
      'invalid-response',
      'Audio Take availability verification time is invalid.',
    );
  }

  return Object.freeze({
    evidence: Object.freeze({
      availableArtifactIds: Object.freeze([artifact.artifactId]),
      checkedAt,
    }),
    ok: true as const,
  });
}

function fail(
  reason: ClipTakeActivationAvailabilityFailureReason,
  message: string,
): Extract<ClipTakeActivationAvailabilityResult, { ok: false }> {
  return Object.freeze({ message, ok: false as const, reason });
}
