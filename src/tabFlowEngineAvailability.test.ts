import { describe, expect, it, vi } from 'vitest';

import { LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE } from '../shared/localEngineProtocol.js';
import {
  resolveTabFlowEngineAvailability,
  type TabFlowAudioAvailabilityClient,
} from './tabFlowEngineAvailability';
import type { LocalEngineGeneratedAudioDescriptor } from './localEngineClient';
import type { TabFlowProjectAvailabilityState } from './tabFlowResultAvailability';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
} from './types';

describe('TabFlow Engine availability', () => {
  it('feeds verified Audio Artifact IDs into the target-scoped snapshot', async () => {
    const project = createAudioProject();
    const checkGeneratedAudioAvailability = vi.fn(
      async (sources: readonly LocalEngineGeneratedAudioDescriptor[]) => ({
        availableSourceIds: sources.map((source) => source.sourceId),
        ok: true as const,
      }),
    );
    const client: TabFlowAudioAvailabilityClient = {
      checkGeneratedAudioAvailability,
    };
    const resolution = await resolveTabFlowEngineAvailability(
      client,
      project,
      'clip-audio',
      () => new Date('2026-08-29T04:00:00.000Z'),
    );

    expect(resolution).toEqual({
      availability: {
        artifactIds: ['artifact-audio'],
        clipTakeIds: ['take-audio'],
      },
      ok: true,
      sourceAvailability: {
        availableArtifactIds: ['artifact-audio'],
        checkedAt: '2026-08-29T04:00:00.000Z',
      },
      verifiedAudioArtifactIds: ['artifact-audio'],
    });
    expect(checkGeneratedAudioAvailability).toHaveBeenCalledWith([
      {
        kind: 'generated',
        name: 'artifact-audio.wav',
        relativePath: 'renders/instruments/artifact-audio.wav',
        sizeBytes: 48,
        sourceId: 'artifact-audio',
      },
    ]);
    expect(Object.isFrozen(resolution)).toBe(true);

    if (resolution.ok) {
      expect(Object.isFrozen(resolution.sourceAvailability)).toBe(true);
      expect(Object.isFrozen(resolution.verifiedAudioArtifactIds)).toBe(true);
    }
  });

  it('returns an explicit failure and a conservative snapshot when Engine verification fails', async () => {
    const project = createAudioProject();
    const client: TabFlowAudioAvailabilityClient = {
      checkGeneratedAudioAvailability: async () => ({
        message: 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      }),
    };
    const resolution = await resolveTabFlowEngineAvailability(
      client,
      project,
      'clip-audio',
    );

    expect(resolution).toEqual({
      availability: {
        artifactIds: [],
        clipTakeIds: [],
      },
      message: 'Local Engine is unreachable.',
      ok: false,
      reason: 'offline',
      status: undefined,
    });
  });

  it('skips invalid Audio descriptors without contacting Engine', async () => {
    const project = createAudioProject();
    const artifact = project.artifacts?.[0];

    if (!artifact || artifact.kind !== 'audio') {
      throw new Error('Expected Audio Artifact fixture.');
    }

    const invalidProject: TabFlowProjectAvailabilityState = {
      ...project,
      artifacts: [
        {
          ...artifact,
          file: {
            ...artifact.file,
            relativePath: 'assets/artifact-audio.wav',
          },
        },
      ],
    };
    const checkGeneratedAudioAvailability = vi.fn();
    const resolution = await resolveTabFlowEngineAvailability(
      { checkGeneratedAudioAvailability },
      invalidProject,
      'clip-audio',
    );

    expect(checkGeneratedAudioAvailability).not.toHaveBeenCalled();
    expect(resolution).toMatchObject({
      availability: {
        artifactIds: [],
        clipTakeIds: [],
      },
      ok: true,
      verifiedAudioArtifactIds: [],
    });
  });

  it('splits large registered Audio sets into bounded Engine batches', async () => {
    const artifactCount =
      LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE + 1;
    const artifacts = Array.from({ length: artifactCount }, (_, index) =>
      createAudioArtifact(`artifact-${String(index).padStart(3, '0')}`),
    );
    const targetTake = createAudioTake(artifacts[0]);
    const project: TabFlowProjectAvailabilityState = {
      artifacts,
      tracks: [
        {
          clips: [createAudioClip('clip-audio', [targetTake])],
        },
      ],
    };
    const batchSizes: number[] = [];
    const client: TabFlowAudioAvailabilityClient = {
      checkGeneratedAudioAvailability: async (sources) => {
        batchSizes.push(sources.length);
        return {
          availableSourceIds: sources.map((source) => source.sourceId),
          ok: true,
        };
      },
    };
    const resolution = await resolveTabFlowEngineAvailability(
      client,
      project,
      'clip-audio',
    );

    expect(batchSizes).toEqual([
      LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_BATCH_SIZE,
      1,
    ]);
    expect(resolution.ok).toBe(true);

    if (resolution.ok) {
      expect(resolution.verifiedAudioArtifactIds).toHaveLength(artifactCount);
      expect(resolution.availability.clipTakeIds).toEqual(['take-artifact-000']);
    }
  });
});

function createAudioProject(): TabFlowProjectAvailabilityState {
  const artifact = createAudioArtifact('artifact-audio');
  const take = createAudioTake(artifact, 'take-audio');

  return {
    artifacts: [artifact],
    tracks: [
      {
        clips: [createAudioClip('clip-audio', [take])],
      },
    ],
  };
}

function createAudioArtifact(artifactId: string): GeneratedAudioArtifact {
  return {
    artifactId,
    audio: {
      channels: 2,
      durationSeconds: 1,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-07-31T02:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: `${artifactId}.wav`,
      relativePath: `renders/instruments/${artifactId}.wav`,
      sizeBytes: 48,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    provenance: {
      modelId: 'fluidsynth',
      modelRevision: '2.5.7',
      parameters: {},
      providerId: 'local-fluidsynth',
      taskId: 'midi-to-audio',
    },
    sourceJobId: `job-${artifactId}`,
  };
}

function createAudioTake(
  artifact: GeneratedAudioArtifact,
  clipTakeId = `take-${artifact.artifactId}`,
): GeneratedAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId,
    createdAt: '2026-07-31T02:00:00.000Z',
    label: 'Instrument Audio',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
}

function createAudioClip(
  id: string,
  clipTakes: GeneratedAudioClipTake[],
): Clip {
  return {
    id,
    type: 'instrument-audio',
    name: id,
    startTick: 0,
    lengthTicks: 3_840,
    color: '#f54848',
    activeClipTakeId: clipTakes[0]?.clipTakeId,
    clipTakes,
    createdAt: '2026-07-31T00:00:00.000Z',
    version: 1,
  };
}
