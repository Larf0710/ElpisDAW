import { describe, expect, it, vi } from 'vitest';

import { verifyGeneratedAudioArtifactsForCommit } from './generatedAudioCommitAvailability';
import type { LocalEngineGeneratedAudioDescriptor } from './localEngineClient';
import type { GeneratedAudioArtifact } from './types';

describe('verifyGeneratedAudioArtifactsForCommit', () => {
  it('returns exact authenticated availability evidence for every Artifact', async () => {
    const artifacts = [createArtifact('artifact-a'), createArtifact('artifact-b')];
    const checkGeneratedAudioAvailability = vi.fn(async (
      descriptors: readonly LocalEngineGeneratedAudioDescriptor[],
    ) => ({
      availableSourceIds: descriptors.map((descriptor) => descriptor.sourceId),
      ok: true as const,
    }));

    await expect(
      verifyGeneratedAudioArtifactsForCommit(
        { checkGeneratedAudioAvailability },
        artifacts,
        () => new Date('2026-08-06T00:00:00.000Z'),
      ),
    ).resolves.toEqual({
      evidence: {
        availableArtifactIds: ['artifact-a', 'artifact-b'],
        checkedAt: '2026-08-06T00:00:00.000Z',
      },
      ok: true,
    });
  });

  it('fails the whole batch when one finalized Artifact is unavailable', async () => {
    const artifacts = [
      createArtifact('artifact-a'),
      createArtifact('artifact-b'),
      createArtifact('artifact-c'),
    ];

    await expect(
      verifyGeneratedAudioArtifactsForCommit(
        {
          checkGeneratedAudioAvailability: async () => ({
            availableSourceIds: ['artifact-a', 'artifact-c'],
            ok: true,
          }),
        },
        artifacts,
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'artifact-unavailable',
      unavailableArtifactIds: ['artifact-b'],
    });
  });

  it('fails closed on invalid Artifacts, transport errors, and Engine failures', async () => {
    const artifact = createArtifact('artifact-a');

    await expect(
      verifyGeneratedAudioArtifactsForCommit(
        { checkGeneratedAudioAvailability: vi.fn() },
        [{ ...artifact, file: { ...artifact.file, name: 'artifact-decoy.wav' } }],
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'artifact-invalid' });

    await expect(
      verifyGeneratedAudioArtifactsForCommit(
        {
          checkGeneratedAudioAvailability: async () => {
            throw new Error('connection lost');
          },
        },
        [artifact],
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'transport-failed' });

    await expect(
      verifyGeneratedAudioArtifactsForCommit(
        {
          checkGeneratedAudioAvailability: async () => ({
            message: 'Local Engine is offline.',
            ok: false,
            reason: 'offline',
          }),
        },
        [artifact],
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'offline' });
  });
});

function createArtifact(artifactId: string): GeneratedAudioArtifact {
  return {
    artifactId,
    audio: {
      channels: 2,
      durationSeconds: 1,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-06T00:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: `${artifactId}.wav`,
      relativePath: `renders/instruments/${artifactId}.wav`,
      sizeBytes: 192_044,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'mock-audio-v1',
      modelRevision: '1',
      parameters: {},
      providerId: 'mock-provider',
      taskId: 'mock-audio-generation',
    },
    sourceJobId: `job-${artifactId}`,
  };
}
