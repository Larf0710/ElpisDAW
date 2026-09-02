import { describe, expect, it } from 'vitest';

import type {
  LocalEngineSourceDescriptor,
  LocalEngineSourceRestoration,
} from './localEngineClient';
import { prepareProjectStemPrint } from './projectStemPrintPreparation';
import { sampleProject } from './sampleProject';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
  Track,
} from './types';

const operationId =
  'stem-print-operation-22222222-2222-4222-8222-222222222222';

describe('Project Stem Print preparation', () => {
  it('creates one immutable Request and registration intent for selected Channels', () => {
    const fixture = createFixture();
    const prepared = prepareProjectStemPrint(
      fixture.project,
      [{ kind: 'channel', trackId: 'track-a' }],
      fixture.descriptors,
      fixture.restoration,
      operationId,
    );

    expect(prepared).toMatchObject({
      canPrepare: true,
      intent: {
        operationId,
        output: { clipName: 'Stem Print 01', trackName: 'Stem Print 01' },
      },
      request: { operationId, protocolVersion: '1' },
      summary: {
        durationSeconds: 0.5,
        outputClipName: 'Stem Print 01',
        sourceCount: 1,
        targetCount: 1,
        trackCount: 1,
      },
    });
    if (!prepared.canPrepare) throw new Error(prepared.message);
    expect(prepared.plan.sources.map((source) => source.sourceId)).toEqual([
      'artifact-a',
    ]);
    expect(Object.isFrozen(prepared.request)).toBe(true);
    expect(Object.isFrozen(prepared.intent)).toBe(true);
  });

  it('filters unselected Project descriptors from the exact Plan source snapshot', () => {
    const fixture = createFixture();
    const prepared = prepareProjectStemPrint(
      fixture.project,
      [{ kind: 'channel', trackId: 'track-b' }],
      fixture.descriptors,
      fixture.restoration,
      operationId,
    );

    expect(prepared).toMatchObject({ canPrepare: true });
    if (prepared.canPrepare) {
      expect(prepared.plan.sources.map((source) => source.sourceId)).toEqual([
        'artifact-b',
      ]);
      expect(prepared.plan.tracks.map((track) => track.trackId)).toEqual([
        'track-b',
      ]);
    }
  });

  it('preserves Group identity and current active child lineage', () => {
    const fixture = createFixture();
    const prepared = prepareProjectStemPrint(
      fixture.project,
      [{ groupTrackId: 'group-a', kind: 'group' }],
      fixture.descriptors,
      fixture.restoration,
      operationId,
    );

    expect(prepared).toMatchObject({
      canPrepare: true,
      plan: {
        selectedTargets: [
          {
            groupTrackId: 'group-a',
            kind: 'group',
            resolvedTrackId: 'track-b',
          },
        ],
      },
    });
  });

  it('rejects no selection and mixed identities that resolve to one Channel', () => {
    const fixture = createFixture();
    expect(
      prepareProjectStemPrint(
        fixture.project,
        [],
        fixture.descriptors,
        fixture.restoration,
        operationId,
      ),
    ).toMatchObject({
      canPrepare: false,
      cause: 'target-selection-invalid',
    });
    expect(
      prepareProjectStemPrint(
        fixture.project,
        [
          { kind: 'channel', trackId: 'track-b' },
          { groupTrackId: 'group-a', kind: 'group' },
        ],
        fixture.descriptors,
        fixture.restoration,
        operationId,
      ),
    ).toMatchObject({
      canPrepare: false,
      cause: 'target-selection-invalid',
    });
  });

  it('rejects missing and duplicate required descriptors before Request creation', () => {
    const fixture = createFixture();
    const selected = [{ kind: 'channel' as const, trackId: 'track-a' }];

    expect(
      prepareProjectStemPrint(
        fixture.project,
        selected,
        fixture.descriptors.filter((descriptor) => descriptor.sourceId !== 'artifact-a'),
        fixture.restoration,
        operationId,
      ),
    ).toMatchObject({
      canPrepare: false,
      cause: 'playback-plan-unavailable',
    });
    expect(
      prepareProjectStemPrint(
        fixture.project,
        selected,
        [fixture.descriptors[0], fixture.descriptors[0], fixture.descriptors[1]],
        fixture.restoration,
        operationId,
      ),
    ).toMatchObject({
      canPrepare: false,
      cause: 'source-descriptor-unavailable',
    });
  });

  it('fails closed when the selected Channel has no audible material', () => {
    const fixture = createFixture();
    fixture.project.tracks.find((track) => track.id === 'track-a')!.muted = true;

    expect(
      prepareProjectStemPrint(
        fixture.project,
        [{ kind: 'channel', trackId: 'track-a' }],
        fixture.descriptors,
        fixture.restoration,
        operationId,
      ),
    ).toMatchObject({
      canPrepare: false,
      cause: 'playback-plan-unavailable',
    });
  });
});

function createFixture() {
  const project = clone(sampleProject);
  const artifactA = createArtifact('artifact-a');
  const artifactB = createArtifact('artifact-b');
  const trackA = createTrack('track-a', 'Channel A', artifactA);
  const trackB = createTrack('track-b', 'Channel B', artifactB, 'group-a');
  const group: Track = {
    clips: [],
    group: {
      activePlaybackTrackId: 'track-b',
      childTrackIds: ['track-b'],
      collapsed: false,
      playbackMode: 'bottom_child',
    },
    id: 'group-a',
    level: 0,
    name: 'Group A',
    type: 'group',
  };
  project.artifacts = [artifactA, artifactB];
  project.bpm = 120;
  project.mixer = undefined;
  project.playheadTick = 0;
  project.totalTicks = 960;
  project.tracks = [trackA, trackB, group];

  const descriptors: readonly LocalEngineSourceDescriptor[] = Object.freeze([
    descriptorFor(artifactA),
    descriptorFor(artifactB),
  ]);
  const restoration: LocalEngineSourceRestoration = Object.freeze({
    availability: Object.freeze({
      'artifact-a': 'available',
      'artifact-b': 'available',
    }),
    checkedAt: '2026-08-13T02:00:00.000Z',
    sources: Object.freeze([]),
  });
  return { descriptors, project, restoration };
}

function createTrack(
  id: string,
  name: string,
  artifact: GeneratedAudioArtifact,
  parentGroupId?: string,
): Track {
  const take: GeneratedAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: `clip-take-${artifact.artifactId}`,
    createdAt: artifact.createdAt,
    label: `${name} Take`,
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
  return {
    clips: [
      {
        activeClipTakeId: take.clipTakeId,
        audioTiming: {
          sourceEndSeconds: 0.5,
          sourceStartSeconds: 0,
          timeBase: 'absolute-seconds',
        },
        clipTakes: [take],
        color: '#5e8fb8',
        createdAt: artifact.createdAt,
        id: `clip-${id}`,
        lengthTicks: 960,
        name: `${name} Clip`,
        sourceFile: {
          durationSeconds: 0.5,
          mimeType: 'audio/wav',
          name: artifact.file.name,
          relativePath: artifact.file.relativePath,
          sizeBytes: artifact.file.sizeBytes,
          sourceId: artifact.artifactId,
          status: 'available',
        },
        startTick: 0,
        type: 'instrument-audio',
        version: 1,
      },
    ],
    id,
    level: 0,
    name,
    ...(parentGroupId ? { parentGroupId } : {}),
    type: 'audio',
  };
}

function createArtifact(artifactId: string): GeneratedAudioArtifact {
  return {
    artifactId,
    audio: { channels: 2, durationSeconds: 0.5, mimeType: 'audio/wav' },
    createdAt: '2026-08-13T00:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: `${artifactId}.wav`,
      relativePath: `renders/instruments/${artifactId}.wav`,
      sizeBytes: 88_244,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'mock-audio',
      modelRevision: '1',
      parameters: {},
      providerId: 'mock-provider',
      taskId: 'mock-audio-generation',
    },
    sourceJobId: `job-${artifactId}`,
  };
}

function descriptorFor(
  artifact: GeneratedAudioArtifact,
): LocalEngineSourceDescriptor {
  return {
    kind: 'generated',
    name: artifact.file.name,
    relativePath: artifact.file.relativePath,
    sizeBytes: artifact.file.sizeBytes,
    sourceId: artifact.artifactId,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
