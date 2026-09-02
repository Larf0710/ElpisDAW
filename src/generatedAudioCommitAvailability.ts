import { LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE } from '../shared/localEngineProtocol.js';
import { createLocalEngineGeneratedAudioDescriptor } from './generatedAudioDescriptor';
import type {
  LocalEngineGeneratedAudioAvailabilityResult,
  LocalEngineGeneratedAudioDescriptor,
  LocalEngineHealthFailureReason,
} from './localEngineClient';
import type { AudioArtifact } from './types';

export type GeneratedAudioCommitAvailabilityClient = Readonly<{
  checkGeneratedAudioAvailability: (
    sources: readonly LocalEngineGeneratedAudioDescriptor[],
  ) => Promise<LocalEngineGeneratedAudioAvailabilityResult>;
}>;

export type GeneratedAudioCommitAvailabilityEvidence = Readonly<{
  availableArtifactIds: readonly string[];
  checkedAt: string;
}>;

export type GeneratedAudioCommitAvailabilityResult =
  | Readonly<{
      evidence: GeneratedAudioCommitAvailabilityEvidence;
      ok: true;
    }>
  | Readonly<{
      message: string;
      ok: false;
      reason:
        | LocalEngineHealthFailureReason
        | 'artifact-invalid'
        | 'artifact-unavailable'
        | 'transport-failed';
      status?: number;
      unavailableArtifactIds?: readonly string[];
    }>;

export async function verifyGeneratedAudioArtifactsForCommit(
  client: GeneratedAudioCommitAvailabilityClient,
  artifacts: readonly AudioArtifact[],
  clock: () => Date = () => new Date(),
): Promise<GeneratedAudioCommitAvailabilityResult> {
  const artifactIds = artifacts.map((artifact) => artifact.artifactId);
  const descriptors = artifacts.map((artifact) =>
    createLocalEngineGeneratedAudioDescriptor(artifact),
  );

  if (
    artifacts.length === 0 ||
    artifacts.some((artifact) => artifact.destination === 'recording') ||
    new Set(artifactIds).size !== artifactIds.length ||
    descriptors.some((descriptor) => descriptor === undefined)
  ) {
    return failure(
      'artifact-invalid',
      'Generated audio commit verification requires distinct canonical Audio Artifacts.',
    );
  }

  const canonicalDescriptors = descriptors as LocalEngineGeneratedAudioDescriptor[];
  const verifiedArtifactIds = new Set<string>();

  for (
    let offset = 0;
    offset < canonicalDescriptors.length;
    offset += LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE
  ) {
    let result: LocalEngineGeneratedAudioAvailabilityResult;

    try {
      result = await client.checkGeneratedAudioAvailability(
        canonicalDescriptors.slice(
          offset,
          offset + LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE,
        ),
      );
    } catch (error) {
      return failure(
        'transport-failed',
        error instanceof Error
          ? `Generated audio availability verification failed: ${error.message}`
          : 'Generated audio availability verification failed.',
      );
    }

    if (!result.ok) {
      return Object.freeze({
        message: result.message,
        ok: false as const,
        reason: result.reason,
        ...(result.status !== undefined ? { status: result.status } : {}),
      });
    }

    const requestedIds = new Set(
      canonicalDescriptors
        .slice(
          offset,
          offset + LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE,
        )
        .map((descriptor) => descriptor.sourceId),
    );

    if (
      new Set(result.availableSourceIds).size !== result.availableSourceIds.length ||
      result.availableSourceIds.some((artifactId) => !requestedIds.has(artifactId))
    ) {
      return failure(
        'invalid-response',
        'Local Engine returned unexpected generated audio availability evidence.',
      );
    }

    result.availableSourceIds.forEach((artifactId) =>
      verifiedArtifactIds.add(artifactId),
    );
  }

  const unavailableArtifactIds = artifactIds.filter(
    (artifactId) => !verifiedArtifactIds.has(artifactId),
  );

  if (unavailableArtifactIds.length > 0) {
    return Object.freeze({
      message: `Finalized generated audio is unavailable: ${unavailableArtifactIds.join(', ')}.`,
      ok: false as const,
      reason: 'artifact-unavailable' as const,
      unavailableArtifactIds: Object.freeze(unavailableArtifactIds),
    });
  }

  let checkedAt: string;

  try {
    checkedAt = clock().toISOString();
  } catch {
    return failure(
      'invalid-response',
      'Generated audio availability verification clock is invalid.',
    );
  }

  return Object.freeze({
    evidence: Object.freeze({
      availableArtifactIds: Object.freeze([...artifactIds]),
      checkedAt,
    }),
    ok: true as const,
  });
}

function failure(
  reason: Extract<GeneratedAudioCommitAvailabilityResult, { ok: false }>['reason'],
  message: string,
): Extract<GeneratedAudioCommitAvailabilityResult, { ok: false }> {
  return Object.freeze({ message, ok: false as const, reason });
}
