import { describe, expect, it, vi } from 'vitest';

import {
  createProjectStemPrintApiRequest,
  createProjectStemPrintPlanSha256,
  type ProjectStemPrintApiOperation,
} from './projectStemPrintApi';
import { createProjectStemPrintRegistrationIntent } from './projectStemPrintRegistrationIntent';
import { createProjectStemPrintPlan } from './projectStemPrintPlan';
import {
  recoverProjectStemPrintRequest,
  runProjectStemPrintRequest,
  type ProjectStemPrintRunnerClient,
} from './projectStemPrintRunner';
import type {
  LocalEngineGeneratedAudioAvailabilityResult,
  LocalEngineProjectStemPrintResult,
} from './localEngineClient';
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
const frameCount = 22_050;
const bytesWritten = 44 + frameCount * 4;

describe('Project Stem Print Runner', () => {
  it('runs, verifies, and registers one muted Stem Print output', async () => {
    const fixture = await createFixture();
    const client = createClient(fixture.operation);
    const result = await runProjectStemPrintRequest(client, fixture.command, {
      clock: () => new Date('2026-08-13T01:00:00.000Z'),
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'STEM_PRINT_REGISTERED',
      artifact: { artifactId, destination: 'stem-print' },
    });
    expect(client.runProjectStemPrint).toHaveBeenCalledWith(
      fixture.request,
      undefined,
    );
    expect(client.checkGeneratedAudioAvailability).toHaveBeenCalledTimes(1);
    if (result.ok) {
      const output = result.project.tracks[result.project.tracks.length - 1];
      expect(output).toMatchObject({ muted: true, type: 'audio' });
      expect(fixture.project.tracks).toHaveLength(1);
    }
  });

  it('preserves the exact unknown Request and recovers with the same operation identity', async () => {
    const fixture = await createFixture();
    const unknown = Object.freeze({
      cause: 'timeout' as const,
      message: 'Project Stem Print outcome is unknown.',
      ok: false as const,
      operationId,
      outcome: 'unknown' as const,
      reason: 'unknown-outcome' as const,
    });
    const client = createClient(fixture.operation);
    client.runProjectStemPrint.mockResolvedValue(unknown);

    const first = await runProjectStemPrintRequest(client, fixture.command);
    expect(first).toMatchObject({
      ok: false,
      operationId,
      status: 'STEM_PRINT_OUTCOME_UNKNOWN',
    });
    if (first.status !== 'STEM_PRINT_OUTCOME_UNKNOWN') {
      throw new Error('Expected unknown outcome.');
    }
    expect(first.request).toBe(fixture.request);
    expect(first.intent).toBe(fixture.intent);

    const recovered = await recoverProjectStemPrintRequest(
      client,
      fixture.command,
      first,
    );
    expect(recovered).toMatchObject({
      ok: true,
      status: 'STEM_PRINT_REGISTERED',
    });
    expect(client.recoverProjectStemPrint).toHaveBeenCalledWith(
      fixture.request,
      first.unknownOutcome,
      undefined,
    );
  });

  it('rejects recovery through a replacement Request even with the same operationId', async () => {
    const fixture = await createFixture();
    const unknown = Object.freeze({
      cause: 'offline' as const,
      message: 'Offline after dispatch.',
      ok: false as const,
      operationId,
      outcome: 'unknown' as const,
      reason: 'unknown-outcome' as const,
    });
    const client = createClient(fixture.operation);
    client.runProjectStemPrint.mockResolvedValue(unknown);
    const first = await runProjectStemPrintRequest(client, fixture.command);
    if (first.status !== 'STEM_PRINT_OUTCOME_UNKNOWN') {
      throw new Error('Expected unknown outcome.');
    }

    const replacementRequest = createProjectStemPrintApiRequest(
      fixture.request.plan,
      operationId,
    );
    const blocked = await recoverProjectStemPrintRequest(
      client,
      Object.freeze({ ...fixture.command, request: replacementRequest }),
      first,
    );

    expect(blocked).toMatchObject({
      ok: false,
      reason: 'recovery-operation-mismatch',
      status: 'RUNNER_FAILED',
    });
    expect(client.recoverProjectStemPrint).not.toHaveBeenCalled();
  });

  it('distinguishes cancellation before dispatch from a confirmed rejection', async () => {
    const fixture = await createFixture();
    const client = createClient(fixture.operation);
    client.runProjectStemPrint.mockResolvedValueOnce({
      message: 'Canceled.',
      ok: false,
      outcome: 'not-dispatched',
      reason: 'canceled',
    });
    const canceled = await runProjectStemPrintRequest(client, fixture.command);

    client.runProjectStemPrint.mockResolvedValueOnce({
      code: 'engine-busy',
      message: 'Engine busy.',
      ok: false,
      outcome: 'confirmed',
      reason: 'rejected',
      status: 409,
    });
    const rejected = await runProjectStemPrintRequest(client, fixture.command);

    expect(canceled).toMatchObject({ status: 'STEM_PRINT_CANCELED' });
    expect(rejected).toMatchObject({
      code: 'engine-busy',
      engineStatus: 409,
      status: 'STEM_PRINT_REJECTED',
    });
  });

  it('blocks Project registration when finalized audio is unavailable', async () => {
    const fixture = await createFixture();
    const client = createClient(fixture.operation);
    client.checkGeneratedAudioAvailability.mockResolvedValue({
      availableSourceIds: [],
      ok: true,
    });

    const result = await runProjectStemPrintRequest(client, fixture.command);

    expect(result).toMatchObject({
      availabilityReason: 'artifact-unavailable',
      ok: false,
      reason: 'availability-verification-failed',
      status: 'REGISTRATION_BLOCKED',
    });
    expect(fixture.project.tracks).toHaveLength(1);
  });

  it('fails closed when Project or Mixer state drifts after Engine completion', async () => {
    const fixture = await createFixture();
    let current = fixture.project;
    const client = createClient(fixture.operation);
    client.runProjectStemPrint.mockImplementation(async () => {
      current = clone(fixture.project);
      current.tracks[0].level = -18;
      return { ok: true, operation: fixture.operation };
    });

    const result = await runProjectStemPrintRequest(
      client,
      Object.freeze({ ...fixture.command, getCurrentProject: () => current }),
    );

    expect(result).toMatchObject({
      ok: false,
      registrationReason: 'mixer-snapshot-stale',
      status: 'REGISTRATION_BLOCKED',
    });
    expect(client.checkGeneratedAudioAvailability).not.toHaveBeenCalled();
  });

  it('blocks replacement dispatch after the exact output has already been registered', async () => {
    const fixture = await createFixture();
    let current = fixture.project;
    const client = createClient(fixture.operation);
    const command = Object.freeze({
      ...fixture.command,
      getCurrentProject: () => current,
    });
    const first = await runProjectStemPrintRequest(client, command);
    if (!first.ok) throw new Error(first.message);
    current = first.project;
    client.checkGeneratedAudioAvailability.mockClear();
    client.runProjectStemPrint.mockClear();

    const second = await runProjectStemPrintRequest(client, command);

    expect(second).toMatchObject({
      ok: false,
      registrationReason: 'identity-conflict',
      status: 'PREFLIGHT_BLOCKED',
    });
    expect(client.checkGeneratedAudioAvailability).not.toHaveBeenCalled();
    expect(client.runProjectStemPrint).not.toHaveBeenCalled();
  });

  it('sanitizes client exceptions into a bounded runner failure', async () => {
    const fixture = await createFixture();
    const client = createClient(fixture.operation);
    client.runProjectStemPrint.mockRejectedValue(new Error('bounded failure'));

    await expect(
      runProjectStemPrintRequest(client, fixture.command),
    ).resolves.toMatchObject({
      cause: 'project-stem-print-run-exception',
      message: 'bounded failure',
      reason: 'client-exception',
      status: 'RUNNER_FAILED',
    });
  });
});

function createClient(operation: ProjectStemPrintApiOperation) {
  return {
    checkGeneratedAudioAvailability: vi.fn(
      async (): Promise<LocalEngineGeneratedAudioAvailabilityResult> => ({
        availableSourceIds: [artifactId],
        ok: true,
      }),
    ),
    recoverProjectStemPrint: vi.fn(
      async (): Promise<LocalEngineProjectStemPrintResult> => ({
        ok: true,
        operation,
      }),
    ),
    runProjectStemPrint: vi.fn(
      async (): Promise<LocalEngineProjectStemPrintResult> => ({
        ok: true,
        operation,
      }),
    ),
  } satisfies ProjectStemPrintRunnerClient;
}

async function createFixture() {
  const project = createProject();
  const request = createRequest(project);
  const intentResult = createProjectStemPrintRegistrationIntent(
    project,
    request,
    request.plan.mixerSnapshot,
  );
  if (!intentResult.canCreate) throw new Error(intentResult.message);

  const operation: ProjectStemPrintApiOperation = Object.freeze({
    operationId,
    protocolVersion: '1',
    result: Object.freeze({
      artifact: Object.freeze({
        artifactId,
        createdAt: '2026-08-13T00:30:00.000Z',
        destination: 'stem-print',
        file: Object.freeze({
          extension: '.wav',
          name: `${artifactId}.wav`,
          relativePath: `stem-prints/${artifactId}.wav`,
          sizeBytes: bytesWritten,
        }),
        kind: 'audio',
        provenance: Object.freeze({
          planSha256: await createProjectStemPrintPlanSha256(request.plan),
          planVersion: 1,
          rendererId: 'humstudio-pcm-mixdown',
          rendererVersion: '0.2.0',
          selectedTargets: request.plan.selectedTargets,
        }),
      }),
      status: 'COMPLETED',
      stemPrint: Object.freeze({
        bitsPerSample: 16,
        bytesWritten,
        channels: 2,
        durationSeconds: 0.5,
        frameCount,
        mimeType: 'audio/wav',
        sampleRate: 44_100,
        sourceCount: 1,
        targetCount: 1,
        trackCount: 1,
      }),
    }),
  });
  const intent = intentResult.intent;
  return {
    command: Object.freeze({
      getCurrentProject: () => project,
      intent,
      request,
    }),
    intent,
    operation,
    project,
    request,
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
  if (!plan.canCreate) throw new Error(plan.message);
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
