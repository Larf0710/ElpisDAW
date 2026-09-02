import { describe, expect, it } from 'vitest';

import { normalizeLegacyAceStepCoverClipTiming } from './aceStepCoverLegacyTiming';
import {
  createAceStepCoverProject,
  createConfiguredAceStepCoverPatchTab,
} from './aceStepCoverTestFixture';
import { secondsToTimelineTicks } from './audioClipTiming';
import { createTimelineExportPlan } from './timelineExportPlan';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
  Track,
} from './types';

describe('legacy ACE Cover timing normalization', () => {
  it('repairs a pre-fix Cover Clip from its exact active Artifact so Timeline EXPORT succeeds', () => {
    const artifact = createCoverArtifact();
    const take = createCoverTake(artifact);
    const track = createLegacyCoverTrack(artifact, take);
    const patchTab = createConfiguredAceStepCoverPatchTab();
    const base = createAceStepCoverProject(patchTab);

    const tracks = normalizeLegacyAceStepCoverClipTiming(
      [track],
      [artifact],
      base.bpm,
    );
    const project: ProjectState = {
      ...base,
      artifacts: [artifact],
      selection: { items: [{ id: track.id, type: 'track' }] },
      tracks,
    };

    expect(tracks[0].clips[0]).toMatchObject({
      audioTiming: {
        sourceEndSeconds: artifact.audio.durationSeconds,
        sourceStartSeconds: 0,
        timeBase: 'absolute-seconds',
      },
      lengthTicks: secondsToTimelineTicks(artifact.audio.durationSeconds, base.bpm),
    });
    expect(createTimelineExportPlan(project)).toMatchObject({
      canExport: true,
      plan: {
        target: { id: track.id },
      },
    });
  });

  it('leaves explicit timing and unrelated generated audio unchanged', () => {
    const artifact = createCoverArtifact();
    const take = createCoverTake(artifact);
    const explicit = {
      ...createLegacyCoverTrack(artifact, take),
      clips: [
        {
          ...createLegacyCoverTrack(artifact, take).clips[0],
          audioTiming: {
            sourceEndSeconds: 10,
            sourceStartSeconds: 0,
            timeBase: 'absolute-seconds' as const,
          },
        },
      ],
    };
    const unrelated = {
      ...createLegacyCoverTrack(artifact, take),
      id: 'track-unrelated',
      clips: [
        {
          ...createLegacyCoverTrack(artifact, take).clips[0],
          generatedBy: 'ACE T2M',
          id: 'clip-unrelated',
        },
      ],
    };

    const normalized = normalizeLegacyAceStepCoverClipTiming(
      [explicit, unrelated],
      [artifact],
      120,
    );

    expect(normalized[0]).toBe(explicit);
    expect(normalized[1]).toBe(unrelated);
  });
});

function createCoverArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-cover-legacy',
    audio: { channels: 2, durationSeconds: 20.28, mimeType: 'audio/wav' },
    createdAt: '2026-08-30T20:40:38.571Z',
    destination: 'ace-step',
    file: {
      extension: '.wav',
      name: 'artifact-cover-legacy.wav',
      relativePath: 'renders/ace-step/artifact-cover-legacy.wav',
      sizeBytes: 3_893_804,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'acestep-v15-base',
      modelRevision: 'e432212fec32b8965a14ffa57ae653438d6abd14',
      parameters: {},
      providerId: 'local-ace-step',
      taskId: 'audio-cover',
    },
    sourceJobId: 'job-cover-legacy',
  };
}

function createCoverTake(
  artifact: GeneratedAudioArtifact,
): GeneratedAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-cover-legacy',
    createdAt: artifact.createdAt,
    label: 'ACE Cover Take 01',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
}

function createLegacyCoverTrack(
  artifact: GeneratedAudioArtifact,
  take: GeneratedAudioClipTake,
): Track {
  return {
    clips: [
      {
        activeClipTakeId: take.clipTakeId,
        clipTakes: [take],
        color: '#ff4d5d',
        createdAt: artifact.createdAt,
        generatedBy: 'ACE Cover',
        id: 'clip-cover-legacy',
        lengthTicks: 38_994,
        name: 'Hum Part 01 Cover',
        sourceFile: {
          durationSeconds: artifact.audio.durationSeconds,
          mimeType: artifact.audio.mimeType,
          name: artifact.file.name,
          relativePath: artifact.file.relativePath,
          sizeBytes: artifact.file.sizeBytes,
          sourceId: artifact.artifactId,
          status: 'available',
        },
        startTick: 0,
        type: 'ai-fill-audio',
        version: 3,
      },
    ],
    id: 'track-cover-legacy',
    level: -6,
    name: 'ACE Cover',
    type: 'generated_audio',
  };
}
