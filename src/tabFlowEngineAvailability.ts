import { LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE } from '../shared/localEngineProtocol.js';
import { createLocalEngineGeneratedAudioDescriptor } from './generatedAudioDescriptor';
import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import type {
  LocalEngineGeneratedAudioAvailabilityResult,
  LocalEngineGeneratedAudioDescriptor,
  LocalEngineHealthFailureReason,
} from './localEngineClient';
import {
  createTabFlowResultAvailability,
  type TabFlowProjectAvailabilityState,
} from './tabFlowResultAvailability';
import type { TabFlowStageResultAvailability } from './tabFlowReusableResult';

export type TabFlowAudioAvailabilityClient = Readonly<{
  checkGeneratedAudioAvailability: (
    sources: readonly LocalEngineGeneratedAudioDescriptor[],
  ) => Promise<LocalEngineGeneratedAudioAvailabilityResult>;
}>;

export type TabFlowEngineAvailabilityResolution =
  | Readonly<{
      availability: TabFlowStageResultAvailability;
      ok: true;
      sourceAvailability: GeneratedAudioCommitAvailabilityEvidence;
      verifiedAudioArtifactIds: readonly string[];
    }>
  | Readonly<{
      availability: TabFlowStageResultAvailability;
      message: string;
      ok: false;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    }>;

export async function resolveTabFlowEngineAvailability(
  client: TabFlowAudioAvailabilityClient,
  project: TabFlowProjectAvailabilityState,
  targetClipId: string,
  clock: () => Date = () => new Date(),
): Promise<TabFlowEngineAvailabilityResolution> {
  const descriptors = collectUniqueAudioDescriptors(project);
  const verifiedAudioArtifactIds: string[] = [];

  for (
    let offset = 0;
    offset < descriptors.length;
    offset += LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE
  ) {
    const result = await client.checkGeneratedAudioAvailability(
      descriptors.slice(
        offset,
        offset + LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE,
      ),
    );

    if (!result.ok) {
      return Object.freeze({
        availability: createTabFlowResultAvailability(project, {
          targetClipId,
          verifiedAudioArtifactIds: [],
        }),
        message: result.message,
        ok: false,
        reason: result.reason,
        status: result.status,
      });
    }

    verifiedAudioArtifactIds.push(...result.availableSourceIds);
  }

  const frozenVerifiedAudioArtifactIds = Object.freeze(
    [...verifiedAudioArtifactIds].sort(compareStableText),
  );
  let checkedAt: string;

  try {
    checkedAt = clock().toISOString();
  } catch {
    return Object.freeze({
      availability: createTabFlowResultAvailability(project, {
        targetClipId,
        verifiedAudioArtifactIds: [],
      }),
      message: 'TabFlow Audio availability verification clock is invalid.',
      ok: false,
      reason: 'invalid-response' as const,
    });
  }
  const sourceAvailability = Object.freeze({
    availableArtifactIds: frozenVerifiedAudioArtifactIds,
    checkedAt,
  });

  return Object.freeze({
    availability: createTabFlowResultAvailability(project, {
      targetClipId,
      verifiedAudioArtifactIds: frozenVerifiedAudioArtifactIds,
    }),
    ok: true,
    sourceAvailability,
    verifiedAudioArtifactIds: frozenVerifiedAudioArtifactIds,
  });
}

function collectUniqueAudioDescriptors(
  project: TabFlowProjectAvailabilityState,
): LocalEngineGeneratedAudioDescriptor[] {
  const artifacts = project.artifacts ?? [];
  const artifactIdCounts = new Map<string, number>();

  artifacts.forEach((artifact) => {
    artifactIdCounts.set(
      artifact.artifactId,
      (artifactIdCounts.get(artifact.artifactId) ?? 0) + 1,
    );
  });

  return artifacts
    .filter(
      (artifact) =>
        artifact.kind === 'audio' &&
        artifactIdCounts.get(artifact.artifactId) === 1,
    )
    .map((artifact) =>
      artifact.kind === 'audio'
        ? createLocalEngineGeneratedAudioDescriptor(artifact)
        : undefined,
    )
    .filter(
      (
        descriptor,
      ): descriptor is LocalEngineGeneratedAudioDescriptor =>
        descriptor !== undefined,
    )
    .sort((left, right) => compareStableText(left.sourceId, right.sourceId));
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
