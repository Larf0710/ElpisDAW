import { describe, expect, it } from 'vitest';

import {
  createProjectStemPrintApiRequest,
  createProjectStemPrintPlanSha256,
} from './projectStemPrintApi';
import { createProjectStemPrintRegistrationIntent } from './projectStemPrintRegistrationIntent';
import { createProjectStemPrintPlan } from './projectStemPrintPlan';
import { createProjectStemPrintTrackRegistration } from './projectStemPrintRegistration';
import { sampleProject } from './sampleProject';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
  Track,
} from './types';

const operationId =
  'stem-print-operation-11111111-1111-4111-8111-111111111111';
const artifactId = 'artifact-11111111-1111-4111-8111-111111111111';
const sourceArtifactId = 'artifact-stem-input';
const sourceTakeId = 'clip-take-artifact-stem-input';
const checkedAt = '2026-08-13T01:00:00.000Z';
const frameCount = 22_050;
const bytesWritten = 44 + frameCount * 4;

describe('Project Stem Print Track registration', () => {
  it('registers exactly one muted output Track, Clip, Artifact, and Active ClipTake', async () => {
    const fixture = await createFixture();
    const sourceTrack = fixture.project.tracks[0];
    const update = await createProjectStemPrintTrackRegistration(
      fixture.project,
      fixture.request,
      fixture.operation,
      verifiedOptions(fixture.intent),
    );

    expect(update).toMatchObject({
      artifact: {
        artifactId,
        destination: 'stem-print',
        lineage: {
          parentArtifactIds: [sourceArtifactId],
          parentClipTakeIds: [sourceTakeId],
        },
        sourceOperationId: operationId,
        stemPrintProvenance: {
          inputClipIds: ['clip-source'],
          inputSourceIds: [sourceArtifactId],
          inputTrackIds: ['track-source'],
          operationProtocolVersion: '1',
          planSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          planVersion: 1,
          schemaVersion: 1,
          selectedTargets: fixture.request.plan.selectedTargets,
        },
      },
      canRegister: true,
      clipTake: {
        artifactId,
        sourceOperationId: operationId,
        sourceType: 'stem-print',
      },
      status: 'REGISTERED',
    });

    if (!update.canRegister) {
      throw new Error(update.message);
    }

    const outputTrack = update.project.tracks[update.project.tracks.length - 1];
    const outputClip = outputTrack?.clips[0];
    expect(update.project).not.toBe(fixture.project);
    expect(fixture.project.tracks).toHaveLength(1);
    expect(update.project.tracks[0]).toEqual({ ...sourceTrack, muted: false });
    expect(outputTrack).toMatchObject({
      id: fixture.intent.output.trackId,
      level: 0,
      muted: true,
      name: 'Stem Print 01',
      type: 'audio',
    });
    expect(outputClip).toMatchObject({
      activeClipTakeId: fixture.intent.output.clipTakeId,
      id: fixture.intent.output.clipId,
      lengthTicks: 960,
      sourceFile: {
        checkedAt,
        relativePath: `stem-prints/${artifactId}.wav`,
        sourceId: artifactId,
        status: 'available',
      },
      startTick: 0,
      type: 'mixdown',
    });
    expect(update.project.artifacts).toHaveLength(2);
    const channels = update.project.mixer?.channels ?? [];
    expect(channels[channels.length - 1]).toMatchObject({
      muted: true,
      trackId: fixture.intent.output.trackId,
    });
  });

  it('is idempotent for the exact completed operation and Project result', async () => {
    const fixture = await createFixture();
    const first = await createProjectStemPrintTrackRegistration(
      fixture.project,
      fixture.request,
      fixture.operation,
      verifiedOptions(fixture.intent),
    );

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const second = await createProjectStemPrintTrackRegistration(
      first.project,
      fixture.request,
      fixture.operation,
      verifiedOptions(fixture.intent),
    );

    expect(second).toMatchObject({ canRegister: true, status: 'ALREADY_REGISTERED' });
    if (second.canRegister) {
      expect(second.project).toBe(first.project);
      expect(second.artifact).toBe(first.artifact);
    }
  });

  it('blocks Project mutation without exact Local Engine availability evidence', async () => {
    const fixture = await createFixture();
    const missing = await createProjectStemPrintTrackRegistration(
      fixture.project,
      fixture.request,
      fixture.operation,
      { intent: fixture.intent },
    );
    const extra = await createProjectStemPrintTrackRegistration(
      fixture.project,
      fixture.request,
      fixture.operation,
      {
        intent: fixture.intent,
        sourceAvailability: {
          availableArtifactIds: [artifactId, 'artifact-extra'],
          checkedAt,
        },
      },
    );

    expect(missing).toMatchObject({
      canRegister: false,
      reason: 'artifact-unavailable',
    });
    expect(extra).toMatchObject({
      canRegister: false,
      reason: 'artifact-unavailable',
    });
    expect(fixture.project.tracks).toHaveLength(1);
  });

  it('rejects operation identity, Plan hash, and selected-target drift', async () => {
    const fixture = await createFixture();
    const wrongIdentity = structuredClone(fixture.operation);
    wrongIdentity.result.artifact.artifactId =
      'artifact-22222222-2222-4222-8222-222222222222';
    const wrongHash = structuredClone(fixture.operation);
    wrongHash.result.artifact.provenance.planSha256 = 'b'.repeat(64);
    const wrongTarget = structuredClone(fixture.operation) as unknown as {
      result: {
        artifact: {
          provenance: {
            selectedTargets: Array<{
              kind: 'channel';
              resolvedTrackId: string;
              trackId: string;
            }>;
          };
        };
      };
    };
    wrongTarget.result.artifact.provenance.selectedTargets[0] = {
      kind: 'channel',
      resolvedTrackId: 'track-other',
      trackId: 'track-other',
    };

    for (const operation of [wrongIdentity, wrongHash, wrongTarget]) {
      await expect(
        createProjectStemPrintTrackRegistration(
          fixture.project,
          fixture.request,
          operation,
          verifiedOptions(fixture.intent),
        ),
      ).resolves.toMatchObject({
        canRegister: false,
        reason: 'operation-invalid',
      });
    }
  });

  it('fails closed on Project/Mixer drift after dispatch', async () => {
    const fixture = await createFixture();
    const drift = clone(fixture.project);
    drift.tracks[0].level = -12;

    await expect(
      createProjectStemPrintTrackRegistration(
        drift,
        fixture.request,
        fixture.operation,
        verifiedOptions(fixture.intent),
      ),
    ).resolves.toMatchObject({
      canRegister: false,
      reason: 'mixer-snapshot-stale',
    });
  });

  it('rejects partial reserved identities without replacing existing data', async () => {
    const fixture = await createFixture();
    const conflict = clone(fixture.project);
    conflict.tracks.push({
      clips: [],
      id: fixture.intent.output.trackId,
      level: 0,
      name: 'Existing Track',
      type: 'audio',
    });

    const update = await createProjectStemPrintTrackRegistration(
      conflict,
      fixture.request,
      fixture.operation,
      verifiedOptions(fixture.intent),
    );

    expect(update).toMatchObject({ canRegister: false, reason: 'identity-conflict' });
    expect(conflict.tracks[conflict.tracks.length - 1]?.name).toBe('Existing Track');
  });
});

async function createFixture() {
  const project = createProject();
  const request = createRequest(project);
  const intentResult = createProjectStemPrintRegistrationIntent(
    project,
    request,
    request.plan.mixerSnapshot,
  );

  if (!intentResult.canCreate) {
    throw new Error(intentResult.message);
  }

  const planSha256 = await createProjectStemPrintPlanSha256(request.plan);
  return {
    intent: intentResult.intent,
    operation: {
      operationId,
      protocolVersion: '1' as const,
      result: {
        artifact: {
          artifactId,
          createdAt: '2026-08-13T00:30:00.000Z',
          destination: 'stem-print' as const,
          file: {
            extension: '.wav' as const,
            name: `${artifactId}.wav`,
            relativePath: `stem-prints/${artifactId}.wav`,
            sizeBytes: bytesWritten,
          },
          kind: 'audio' as const,
          provenance: {
            planSha256,
            planVersion: 1 as const,
            rendererId: 'humstudio-pcm-mixdown' as const,
            rendererVersion: '0.2.0' as const,
            selectedTargets: request.plan.selectedTargets,
          },
        },
        status: 'COMPLETED' as const,
        stemPrint: {
          bitsPerSample: 16 as const,
          bytesWritten,
          channels: 2 as const,
          durationSeconds: 0.5,
          frameCount,
          mimeType: 'audio/wav' as const,
          sampleRate: 44_100 as const,
          sourceCount: 1,
          targetCount: 1,
          trackCount: 1,
        },
      },
    },
    project,
    request,
  };
}

function verifiedOptions(intent: Awaited<ReturnType<typeof createFixture>>['intent']) {
  return {
    intent,
    sourceAvailability: {
      availableArtifactIds: [artifactId],
      checkedAt,
    },
  };
}

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
