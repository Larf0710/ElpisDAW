import { describe, expect, it } from 'vitest';

import { createProjectStemPrintApiRequest } from './projectStemPrintApi';
import {
  createProjectStemPrintRegistrationIntent,
  preflightProjectStemPrintRegistration,
} from './projectStemPrintRegistrationIntent';
import { createProjectStemPrintPlan } from './projectStemPrintPlan';
import { sampleProject } from './sampleProject';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
  Track,
} from './types';

const operationId =
  'stem-print-operation-11111111-1111-4111-8111-111111111111';
const sourceArtifactId = 'artifact-stem-input';
const sourceTakeId = 'clip-take-artifact-stem-input';

describe('Project Stem Print registration intent', () => {
  it('reserves immutable operation-derived output and exact source lineage', () => {
    const project = createProject();
    const request = createRequest(project);
    const result = createProjectStemPrintRegistrationIntent(
      project,
      request,
      request.plan.mixerSnapshot,
    );

    expect(result).toMatchObject({
      canCreate: true,
      intent: {
        canonicalPlanJson: expect.any(String),
        operationId,
        output: {
          artifactId: 'artifact-11111111-1111-4111-8111-111111111111',
          clipId: 'stem-print-clip-11111111-1111-4111-8111-111111111111',
          clipName: 'Stem Print 01',
          clipTakeId: 'clip-take-artifact-11111111-1111-4111-8111-111111111111',
          trackId: 'stem-print-track-11111111-1111-4111-8111-111111111111',
          trackName: 'Stem Print 01',
        },
        selectedTargets: [
          {
            kind: 'channel',
            resolvedTrackId: 'track-source',
            trackId: 'track-source',
          },
        ],
        sourceLineage: {
          parentArtifactIds: [sourceArtifactId],
          parentClipTakeIds: [sourceTakeId],
        },
        version: 1,
      },
    });

    if (!result.canCreate) {
      throw new Error(result.message);
    }

    expect(Object.isFrozen(result.intent)).toBe(true);
    expect(Object.isFrozen(result.intent.output)).toBe(true);
    expect(Object.isFrozen(result.intent.sourceLineage.parentArtifactIds)).toBe(true);
    expect(
      preflightProjectStemPrintRegistration(project, request, result.intent),
    ).toEqual({ canDispatch: true, status: 'READY' });
  });

  it('rejects mutable requests, mutable snapshots, and mismatched snapshots', () => {
    const project = createProject();
    const request = createRequest(project);
    const mutableRequest = structuredClone(request);
    const mutableSnapshot = structuredClone(request.plan.mixerSnapshot);
    const mismatchedSnapshot = structuredClone(
      request.plan.mixerSnapshot,
    ) as unknown as {
      channels: Array<(typeof request.plan.mixerSnapshot.channels)[number]>;
    } & Omit<typeof request.plan.mixerSnapshot, 'channels'>;
    mismatchedSnapshot.channels[0] = {
      ...mismatchedSnapshot.channels[0],
      faderDb: -9,
    };
    freezeRecursively(mismatchedSnapshot);

    expect(
      createProjectStemPrintRegistrationIntent(
        project,
        mutableRequest,
        request.plan.mixerSnapshot,
      ),
    ).toMatchObject({ canCreate: false, reason: 'intent-invalid' });
    expect(
      createProjectStemPrintRegistrationIntent(project, request, mutableSnapshot),
    ).toMatchObject({ canCreate: false, reason: 'intent-invalid' });
    expect(
      createProjectStemPrintRegistrationIntent(
        project,
        request,
        mismatchedSnapshot,
      ),
    ).toMatchObject({ canCreate: false, reason: 'intent-invalid' });
  });

  it('fails closed when Mixer or selected source state drifts', () => {
    const project = createProject();
    const request = createRequest(project);
    const result = createProjectStemPrintRegistrationIntent(
      project,
      request,
      request.plan.mixerSnapshot,
    );

    if (!result.canCreate) {
      throw new Error(result.message);
    }

    const mixerDrift = clone(project);
    mixerDrift.tracks[0].level = -12;
    const sourceDrift = clone(project);
    sourceDrift.tracks[0].clips[0].activeClipTakeId = 'different-take';

    expect(
      preflightProjectStemPrintRegistration(mixerDrift, request, result.intent),
    ).toMatchObject({ canDispatch: false, reason: 'mixer-snapshot-stale' });
    expect(
      preflightProjectStemPrintRegistration(sourceDrift, request, result.intent),
    ).toMatchObject({ canDispatch: false });
  });

  it('rejects reserved Track, Clip, Artifact, and ClipTake identity collisions', () => {
    const project = createProject();
    const request = createRequest(project);
    const result = createProjectStemPrintRegistrationIntent(
      project,
      request,
      request.plan.mixerSnapshot,
    );

    if (!result.canCreate) {
      throw new Error(result.message);
    }

    const collision = clone(project);
    collision.tracks.push({
      clips: [],
      id: result.intent.output.trackId,
      level: 0,
      name: 'Conflicting Track',
      type: 'audio',
    });

    expect(
      preflightProjectStemPrintRegistration(collision, request, result.intent),
    ).toMatchObject({ canDispatch: false, reason: 'identity-conflict' });
  });

  it('rejects caller-mutated or request-swapped intents', () => {
    const project = createProject();
    const request = createRequest(project);
    const result = createProjectStemPrintRegistrationIntent(
      project,
      request,
      request.plan.mixerSnapshot,
    );

    if (!result.canCreate) {
      throw new Error(result.message);
    }

    const mutableIntent = structuredClone(result.intent);
    const otherRequest = createProjectStemPrintApiRequest(
      request.plan,
      'stem-print-operation-22222222-2222-4222-8222-222222222222',
    );

    expect(
      preflightProjectStemPrintRegistration(project, request, mutableIntent),
    ).toMatchObject({ canDispatch: false, reason: 'intent-invalid' });
    expect(
      preflightProjectStemPrintRegistration(project, otherRequest, result.intent),
    ).toMatchObject({ canDispatch: false, reason: 'intent-invalid' });
  });
});

function createProject(): ProjectState {
  const project = clone(sampleProject);
  const artifact = createSourceArtifact();
  const take: GeneratedAudioClipTake = {
    artifactId: sourceArtifactId,
    clipTakeId: sourceTakeId,
    createdAt: artifact.createdAt,
    label: 'Source Take 01',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
  const track: Track = {
    clips: [
      {
        activeClipTakeId: sourceTakeId,
        audioTiming: {
          sourceEndSeconds: 0.5,
          sourceStartSeconds: 0,
          timeBase: 'absolute-seconds',
        },
        clipTakes: [take],
        color: '#5e8fb8',
        createdAt: artifact.createdAt,
        id: 'clip-source',
        lengthTicks: 960,
        name: 'Source Clip',
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
    id: 'track-source',
    level: -3,
    name: 'Source',
    type: 'audio',
  };

  project.artifacts = [artifact];
  project.bpm = 120;
  project.mixer = undefined;
  project.playheadTick = 0;
  project.totalTicks = 960;
  project.tracks = [track];
  return project;
}

function createRequest(project: ProjectState) {
  const plan = createProjectStemPrintPlan({
    artifacts: project.artifacts,
    bpm: project.bpm,
    mixer: project.mixer,
    playheadTick: project.playheadTick,
    projectEndTick: project.totalTicks,
    sourceAvailability: { [sourceArtifactId]: 'openable' },
    sourceDescriptors: [
      {
        kind: 'generated',
        name: `${sourceArtifactId}.wav`,
        relativePath: `renders/instruments/${sourceArtifactId}.wav`,
        sizeBytes: 88_244,
        sourceId: sourceArtifactId,
      },
    ],
    targets: [{ kind: 'channel', trackId: 'track-source' }],
    tracks: project.tracks,
  });

  if (!plan.canCreate) {
    throw new Error(plan.message);
  }

  return createProjectStemPrintApiRequest(plan.plan, operationId);
}

function createSourceArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: sourceArtifactId,
    audio: { channels: 2, durationSeconds: 0.5, mimeType: 'audio/wav' },
    createdAt: '2026-08-13T00:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: `${sourceArtifactId}.wav`,
      relativePath: `renders/instruments/${sourceArtifactId}.wav`,
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
    sourceJobId: 'job-input',
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach(freezeRecursively);
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeRecursively);
  }
  return typeof value === 'object' && value !== null ? Object.freeze(value) : value;
}
