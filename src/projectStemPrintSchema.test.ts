import { describe, expect, it } from 'vitest';

import { doesClipTakeMatchArtifact } from './clipTakeActivation';
import { createLocalEngineGeneratedAudioDescriptor } from './generatedAudioDescriptor';
import {
  normalizeClipTakeState,
  normalizeProjectArtifacts,
} from './projectArtifactRegistration';
import { createCanonicalProjectStemPrintPlanJson } from './projectMixdownPlanIdentity';
import { createTestProjectMixdownPlanV3 } from './projectMixdownTestFixtures';
import type {
  ProjectStemPrintAudioArtifact,
  ProjectStemPrintAudioClipTake,
} from './types';

const operationId =
  'stem-print-operation-11111111-1111-4111-8111-111111111111';
const artifactId = 'artifact-11111111-1111-4111-8111-111111111111';
const clipTakeId = `clip-take-${artifactId}`;
const frameCount = 44_100;

describe('Project Stem Print persisted schema', () => {
  it('normalizes one exact Stem Artifact and preserves complete provenance', () => {
    const artifact = createArtifact();

    expect(normalizeProjectArtifacts([artifact])).toEqual([artifact]);
    expect(createLocalEngineGeneratedAudioDescriptor(artifact)).toEqual({
      kind: 'generated',
      name: `${artifactId}.wav`,
      relativePath: `stem-prints/${artifactId}.wav`,
      sizeBytes: 44 + frameCount * 4,
      sourceId: artifactId,
    });
  });

  it('normalizes and matches one exact Stem ClipTake to its Artifact', () => {
    const artifact = createArtifact();
    const clipTake = createClipTake();

    expect(normalizeClipTakeState([clipTake], clipTakeId)).toEqual({
      activeClipTakeId: clipTakeId,
      clipTakes: [clipTake],
    });
    expect(doesClipTakeMatchArtifact(clipTake, artifact)).toBe(true);
    expect(doesClipTakeMatchArtifact(
      { ...clipTake, sourceOperationId: operationId.replace(/1/g, '2') },
      artifact,
    )).toBe(false);
  });

  it('rejects output path, selected-target, and canonical Plan drift', () => {
    const pathDrift = createArtifact();
    pathDrift.file.relativePath = `mixdowns/${artifactId}.wav`;
    const targetDrift = createArtifact();
    targetDrift.stemPrintProvenance.selectedTargets[0] = {
      kind: 'channel',
      resolvedTrackId: 'track-other',
      trackId: 'track-other',
    };
    const planDrift = createArtifact();
    planDrift.stemPrintProvenance.canonicalPlanJson = '{}';

    expect(normalizeProjectArtifacts([pathDrift])).toEqual([]);
    expect(normalizeProjectArtifacts([targetDrift])).toEqual([]);
    expect(normalizeProjectArtifacts([planDrift])).toEqual([]);
  });

  it('rejects extra keys and duplicate operation identities', () => {
    const artifact = createArtifact();
    const extra = { ...artifact, absolutePath: 'D:\\Music\\stem.wav' };

    expect(normalizeProjectArtifacts([extra])).toEqual([]);
    expect(normalizeProjectArtifacts([artifact, structuredClone(artifact)])).toEqual([
      artifact,
    ]);
  });
});

function createArtifact(): ProjectStemPrintAudioArtifact {
  const plan = createPlan();
  const canonicalPlanJson = createCanonicalProjectStemPrintPlanJson(plan);

  if (!canonicalPlanJson) {
    throw new Error('Stem Print schema test Plan is invalid.');
  }

  return {
    artifactId,
    audio: {
      bitsPerSample: 16,
      channels: 2,
      durationSeconds: 1,
      frameCount,
      mimeType: 'audio/wav',
      sampleRate: 44_100,
    },
    createdAt: '2026-08-13T00:00:00.000Z',
    destination: 'stem-print',
    file: {
      extension: '.wav',
      name: `${artifactId}.wav`,
      relativePath: `stem-prints/${artifactId}.wav`,
      sizeBytes: 44 + frameCount * 4,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-source'],
      parentClipTakeIds: ['clip-take-artifact-source'],
    },
    sourceOperationId: operationId,
    stemPrintProvenance: {
      canonicalPlanJson,
      inputClipIds: ['clip-source'],
      inputSourceIds: ['artifact-source'],
      inputTrackIds: ['track-source'],
      operationProtocolVersion: '1',
      planSha256: 'a'.repeat(64),
      planVersion: 1,
      rendererId: 'humstudio-pcm-mixdown',
      rendererVersion: '0.2.0',
      schemaVersion: 1,
      selectedTargets: [
        {
          kind: 'channel',
          resolvedTrackId: 'track-source',
          trackId: 'track-source',
        },
      ],
    },
  };
}

function createClipTake(): ProjectStemPrintAudioClipTake {
  return {
    artifactId,
    clipTakeId,
    createdAt: '2026-08-13T00:00:00.000Z',
    label: 'Stem Print 01',
    mediaType: 'audio',
    sourceOperationId: operationId,
    sourceType: 'stem-print',
  };
}

function createPlan() {
  const raw = createTestProjectMixdownPlanV3({
    bpm: 120,
    durationSeconds: 1,
    endTick: 1_920,
    sources: [
      {
        kind: 'generated',
        name: 'artifact-source.wav',
        relativePath: 'renders/instruments/artifact-source.wav',
        sizeBytes: 88_244,
        sourceId: 'artifact-source',
      },
    ],
    tracks: [
      {
        events: [
          {
            clipId: 'clip-source',
            clipName: 'Source Clip',
            durationSeconds: 1,
            sourceId: 'artifact-source',
            sourceStartSeconds: 0,
            startOffsetSeconds: 0,
            timelineEndTick: 1_920,
            timelineStartTick: 0,
          },
        ],
        gainDb: 0,
        pan: 0,
        trackId: 'track-source',
      },
    ],
  });

  return {
    ...raw,
    audibleRange: { endTick: 1_920, startTick: 0 },
    purpose: 'stem-print' as const,
    selectedTargets: [
      {
        kind: 'channel' as const,
        resolvedTrackId: 'track-source',
        trackId: 'track-source',
      },
    ],
    version: 1 as const,
  };
}
