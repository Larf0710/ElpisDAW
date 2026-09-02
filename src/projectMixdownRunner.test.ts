import { describe, expect, it, vi } from 'vitest';

import { createProjectMixdownArtifactId } from '../shared/projectMixdownApiProtocol.js';
import { createProjectMixdownApiRequest } from './projectMixdownApi';
import type {
  ProjectMixdownApiOperation,
  ProjectMixdownApiRequest,
} from './projectMixdownApi';
import {
  createProjectMixdownPlan,
  type ProjectMixdownPlan,
} from './projectMixdownPlan';
import { createProjectMixerRenderSnapshotV2 } from './projectMixerRenderSnapshot';
import { createTestProjectMixdownPlanV3 } from './projectMixdownTestFixtures';
import {
  createProjectMixdownRegistrationIntent,
  createProjectMixdownTrackRegistration,
  type ProjectMixdownRegistrationIntent,
} from './projectMixdownRegistration';
import {
  recoverProjectMixdownRequest,
  runProjectMixdownRequest,
  type ProjectMixdownRunnerClient,
  type ProjectMixdownRunnerCommand,
  type ProjectMixdownUnknownOutcome,
  type ProjectMixdownUnknownResult,
} from './projectMixdownRunner';
import { sampleProject } from './sampleProject';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectMixdownAudioArtifact,
  ProjectMixdownAudioClipTake,
  ProjectState,
  Track,
} from './types';

const operationId =
  'mixdown-operation-11111111-1111-4111-8111-111111111111';
const otherOperationId =
  'mixdown-operation-99999999-9999-4999-8999-999999999999';
const artifactId = 'artifact-11111111-1111-4111-8111-111111111111';
const sourceArtifactId = 'artifact-input';
const sourceTakeId = 'clip-take-artifact-input';
type AvailabilitySources = Parameters<
  ProjectMixdownRunnerClient['checkGeneratedAudioAvailability']
>[0];
type AvailabilityResult = Awaited<
  ReturnType<ProjectMixdownRunnerClient['checkGeneratedAudioAvailability']>
>;
type MixdownResult = Awaited<
  ReturnType<ProjectMixdownRunnerClient['runProjectMixdown']>
>;

describe('Project Mixdown Runner', () => {
  it('runs one immutable Request, verifies its WAV, and returns a registered Project update', async () => {
    const project = createProject();
    const request = createRequest();
    const client = createClient();
    const command = createCommand(project, request);

    const result = await runProjectMixdownRequest(client, command, {
      clock: () => new Date('2026-08-08T01:00:02.000Z'),
    });

    expect(result).toMatchObject({
      artifact: { artifactId, sourceOperationId: operationId },
      baseProject: project,
      ok: true,
      operation: { operationId },
      request,
      status: 'MIXDOWN_REGISTERED',
    });
    expect(client.runProjectMixdown).toHaveBeenCalledWith(request, undefined);
    expect(client.recoverProjectMixdown).not.toHaveBeenCalled();
    expect(client.checkGeneratedAudioAvailability).toHaveBeenCalledTimes(1);

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.project).not.toBe(project);
    expect(result.project.artifacts).toHaveLength(2);
    expect(result.project.tracks).toHaveLength(project.tracks.length + 1);
    expect(
      result.project.tracks.find(
        (track) => track.id === result.intent.output.trackId,
      ),
    ).toMatchObject({ muted: true, type: 'audio' });
    expect(
      findClip(result.project, result.intent.output.clipId).clipTakes,
    ).toHaveLength(1);
    expect(
      findClip(result.project, result.intent.output.clipId).sourceFile?.checkedAt,
    ).toBe(
      '2026-08-08T01:00:02.000Z',
    );
  });

  it('accepts an explicitly unmuted prior Mixdown as input and settles to a different muted Track', async () => {
    const project = createProjectWithPriorMixdown();
    const planning = createProjectMixdownPlan({
      artifacts: project.artifacts,
      bpm: project.bpm,
      mixer: project.mixer,
      playheadTick: project.playheadTick,
      projectEndTick: project.totalTicks,
      selection: project.selection,
      sourceAvailability: {
        [sourceArtifactId]: 'openable',
        'external-source': 'openable',
        'artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'openable',
      },
      sourceDescriptors: [
        ...createPlan().sources,
        {
          kind: 'generated',
          name: 'artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.wav',
          relativePath:
            'mixdowns/artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.wav',
          sizeBytes: 176_444,
          sourceId: 'artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      ],
      tracks: project.tracks,
    });

    if (!planning.canCreate) {
      throw new Error(planning.message);
    }

    const request = createProjectMixdownApiRequest(planning.plan, operationId);
    const intentResolution = createProjectMixdownRegistrationIntent(
      project,
      request,
      planning.mixerSnapshot,
    );

    if (!intentResolution.canCreate) {
      throw new Error(intentResolution.message);
    }

    const operation = createOperation(request);
    const client = createClient({
      runProjectMixdown: vi.fn(async () => ({ ok: true as const, operation })),
    });
    const result = await runProjectMixdownRequest(
      client,
      createCommand(
        project,
        request,
        () => project,
        intentResolution.intent,
      ),
    );

    expect(planning.plan.tracks.map((track) => track.trackId)).toContain(
      'track-prior-mix',
    );
    expect(result).toMatchObject({ ok: true, status: 'MIXDOWN_REGISTERED' });

    if (!result.ok) {
      throw new Error(result.message);
    }

    const priorTrack = result.project.tracks.find(
      (track) => track.id === 'track-prior-mix',
    );
    const outputTrack = result.project.tracks.find(
      (track) => track.id === result.intent.output.trackId,
    );
    expect(priorTrack).toMatchObject({ muted: false });
    expect(outputTrack).toMatchObject({ muted: true, type: 'audio' });
    expect(outputTrack?.id).not.toBe(priorTrack?.id);
  });

  it('returns an ambiguous post-dispatch outcome without automatic recovery or registration', async () => {
    const project = createProject();
    const unknownOutcome = createUnknownOutcome('offline');
    const client = createClient({
      runProjectMixdown: vi.fn(async () => unknownOutcome),
    });
    const getCurrentProject = vi.fn(() => project);

    const result = await runProjectMixdownRequest(
      client,
      createCommand(project, createRequest(), getCurrentProject),
    );

    expect(result).toEqual({
      cause: 'offline',
      intent: expect.any(Object),
      message: 'The response was lost after dispatch.',
      ok: false,
      operationId,
      reason: 'unknown-outcome',
      request: expect.any(Object),
      status: 'MIXDOWN_OUTCOME_UNKNOWN',
      unknownOutcome,
    });
    expect(client.recoverProjectMixdown).not.toHaveBeenCalled();
    expect(client.checkGeneratedAudioAvailability).not.toHaveBeenCalled();
    expect(getCurrentProject).toHaveBeenCalledTimes(1);
  });

  it('recovers only through the explicit same-operation entry point', async () => {
    const project = createProject();
    const request = createRequest();
    const unknownOutcome = createUnknownOutcome('timeout');
    const client = createClient({
      runProjectMixdown: vi.fn(async () => unknownOutcome),
    });
    const command = createCommand(project, request);
    const unknownResult = await runProjectMixdownRequest(client, command);

    if (unknownResult.status !== 'MIXDOWN_OUTCOME_UNKNOWN') {
      throw new Error('Expected one unknown Project Mixdown outcome.');
    }

    const result = await recoverProjectMixdownRequest(
      client,
      command,
      unknownResult,
      { clock: () => new Date('2026-08-08T01:00:03.000Z') },
    );

    expect(result).toMatchObject({
      ok: true,
      operation: { operationId },
      status: 'MIXDOWN_REGISTERED',
    });
    expect(client.runProjectMixdown).toHaveBeenCalledTimes(1);
    expect(client.recoverProjectMixdown).toHaveBeenCalledWith(
      request,
      unknownResult.unknownOutcome,
      undefined,
    );
  });

  it('rejects an unknown result paired with a different Request before contacting the Engine', async () => {
    const project = createProject();
    const client = createClient();
    const mismatchedRequest = createProjectMixdownApiRequest(
      createPlan(),
      otherOperationId,
    );
    const mismatchedResult = createUnknownResult(
      mismatchedRequest,
      createUnknownOutcome('timeout', otherOperationId),
      createIntent(project, mismatchedRequest),
    );

    const result = await recoverProjectMixdownRequest(
      client,
      createCommand(project, createRequest()),
      mismatchedResult,
    );

    expect(result).toMatchObject({
      cause: 'project-mixdown-recovery-operation-mismatch',
      ok: false,
      reason: 'recovery-operation-mismatch',
      status: 'RUNNER_FAILED',
    });
    expect(client.recoverProjectMixdown).not.toHaveBeenCalled();
    expect(client.checkGeneratedAudioAvailability).not.toHaveBeenCalled();
  });

  it('rejects the same operationId when recovery substitutes a different immutable Plan', async () => {
    const project = createProject();
    const client = createClient();
    const originalRequest = createRequest();
    const unknownOutcome = createUnknownOutcome('invalid-response');
    const originalIntent = createIntent(project, originalRequest);
    const unknownResult = createUnknownResult(
      originalRequest,
      unknownOutcome,
      originalIntent,
    );
    const differentPlan = clone(createPlan()) as ProjectMixdownPlan & {
      tracks: Array<{ gainDb: number }>;
    };
    differentPlan.tracks[0].gainDb = -6;
    const substitutedRequest = createProjectMixdownApiRequest(
      differentPlan,
      operationId,
    );

    const result = await recoverProjectMixdownRequest(
      client,
      createCommand(project, substitutedRequest, () => project, originalIntent),
      unknownResult,
    );

    expect(result).toMatchObject({
      cause: 'project-mixdown-recovery-operation-mismatch',
      reason: 'recovery-operation-mismatch',
      status: 'RUNNER_FAILED',
    });
    expect(client.recoverProjectMixdown).not.toHaveBeenCalled();
  });

  it('blocks registration when input lineage changes during WAV verification', async () => {
    const project = createProject();
    let currentProject = project;
    const client = createClient({
      checkGeneratedAudioAvailability: vi.fn(async (
        sources: AvailabilitySources,
      ): Promise<AvailabilityResult> => {
        currentProject = clone(currentProject);
        currentProject.tracks[0].level = -12;
        return {
          availableSourceIds: sources.map((source) => source.sourceId),
          ok: true as const,
        };
      }),
    });

    const result = await runProjectMixdownRequest(
      client,
      createCommand(project, createRequest(), () => currentProject),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'registration-rejected',
      registrationReason: 'mixer-snapshot-stale',
      status: 'REGISTRATION_BLOCKED',
    });
    expect(currentProject.artifacts).toHaveLength(1);
    expect(currentProject.tracks).toHaveLength(project.tracks.length);
    expect(findClip(currentProject, 'clip-master').clipTakes).toBeUndefined();
  });

  it('does not register a completed result when the finalized WAV cannot be reverified', async () => {
    const project = createProject();
    const client = createClient({
      checkGeneratedAudioAvailability: vi.fn(async () => ({
        message: 'Local Engine is offline.',
        ok: false as const,
        reason: 'offline' as const,
      })),
    });

    const result = await runProjectMixdownRequest(
      client,
      createCommand(project, createRequest()),
    );

    expect(result).toMatchObject({
      availabilityReason: 'offline',
      ok: false,
      reason: 'availability-verification-failed',
      status: 'REGISTRATION_BLOCKED',
    });
    expect(project.artifacts).toHaveLength(1);
    expect(project.tracks).toHaveLength(3);
    expect(findClip(project, 'clip-master').clipTakes).toBeUndefined();
  });

  it('recovers an existing identical Project registration without another availability request', async () => {
    const request = createRequest();
    const operation = createOperation();
    const project = createProject();
    const intent = createIntent(project, request);
    const first = createProjectMixdownTrackRegistration(
      project,
      request,
      operation,
      {
        intent,
        sourceAvailability: {
          availableArtifactIds: [artifactId],
          checkedAt: '2026-08-08T01:00:02.000Z',
        },
      },
    );

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const client = createClient({
      runProjectMixdown: vi.fn(async () => ({ ok: true as const, operation })),
    });
    const result = await runProjectMixdownRequest(
      client,
      createCommand(first.project, request, () => first.project, intent),
    );

    expect(result).toMatchObject({
      baseProject: first.project,
      ok: true,
      project: first.project,
      status: 'MIXDOWN_ALREADY_REGISTERED',
    });
    expect(first.project.artifacts).toHaveLength(2);
    expect(
      first.project.tracks.filter((track) => track.id === intent.output.trackId),
    ).toHaveLength(1);
    expect(
      first.project.tracks.flatMap((track) =>
        track.clips.filter((clip) => clip.id === intent.output.clipId),
      ),
    ).toHaveLength(1);
    expect(client.checkGeneratedAudioAvailability).not.toHaveBeenCalled();
  });

  it('preserves confirmed cancellation and rejection without treating either as output', async () => {
    const project = createProject();
    const controller = new AbortController();
    controller.abort();
    const canceledClient = createClient({
      runProjectMixdown: vi.fn(async (_request, signal) => {
        expect(signal).toBe(controller.signal);
        return {
          message: 'Project Mixdown was canceled before dispatch.',
          ok: false as const,
          outcome: 'not-dispatched' as const,
          reason: 'canceled' as const,
        };
      }),
    });
    const rejectedClient = createClient({
      runProjectMixdown: vi.fn(async () => ({
        code: 'MIXDOWN_BUSY',
        message: 'Project Mixdown is busy.',
        ok: false as const,
        outcome: 'confirmed' as const,
        reason: 'rejected' as const,
        status: 409,
      })),
    });

    await expect(
      runProjectMixdownRequest(
        canceledClient,
        createCommand(project, createRequest()),
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({
      reason: 'canceled-before-dispatch',
      status: 'MIXDOWN_CANCELED',
    });
    await expect(
      runProjectMixdownRequest(
        rejectedClient,
        createCommand(project, createRequest()),
      ),
    ).resolves.toMatchObject({
      code: 'MIXDOWN_BUSY',
      engineStatus: 409,
      reason: 'engine-rejected',
      status: 'MIXDOWN_REJECTED',
    });
    expect(canceledClient.checkGeneratedAudioAvailability).not.toHaveBeenCalled();
    expect(rejectedClient.checkGeneratedAudioAvailability).not.toHaveBeenCalled();
  });

  it.each([
    {
      expectedReason: 'routing-cycle',
      mutate(project: ProjectState, intent: ProjectMixdownRegistrationIntent) {
        const source = project.artifacts?.find(
          (artifact) => artifact.artifactId === sourceArtifactId,
        );

        if (!source) {
          throw new Error('Expected source Artifact.');
        }

        source.lineage.parentArtifactIds = [intent.output.artifactId];
      },
      name: 'self-input ancestry',
    },
    {
      expectedReason: 'identity-conflict',
      mutate(project: ProjectState, intent: ProjectMixdownRegistrationIntent) {
        project.tracks.push({
          clips: [],
          id: intent.output.trackId,
          level: 0,
          name: 'Conflicting Track',
          type: 'audio',
        });
      },
      name: 'reserved Track identity reuse',
    },
    {
      expectedReason: 'identity-conflict',
      mutate(project: ProjectState, intent: ProjectMixdownRegistrationIntent) {
        const source = project.artifacts?.[0];

        if (!source) {
          throw new Error('Expected source Artifact.');
        }

        project.artifacts?.push({
          ...clone(source),
          artifactId: intent.output.artifactId,
        });
      },
      name: 'reserved Artifact identity reuse',
    },
    {
      expectedReason: 'identity-conflict',
      mutate(project: ProjectState, intent: ProjectMixdownRegistrationIntent) {
        project.tracks[0].clips.push({
          ...clone(project.tracks[0].clips[0]),
          id: intent.output.clipId,
        });
      },
      name: 'reserved Clip identity reuse',
    },
    {
      expectedReason: 'identity-conflict',
      mutate(project: ProjectState, intent: ProjectMixdownRegistrationIntent) {
        const clip = project.tracks[0].clips[0];
        const sourceTake = clip.clipTakes?.[0];

        if (!sourceTake) {
          throw new Error('Expected source Clip Take.');
        }

        clip.clipTakes = [
          ...(clip.clipTakes ?? []),
          { ...clone(sourceTake), clipTakeId: intent.output.clipTakeId },
        ];
      },
      name: 'reserved Clip Take identity reuse',
    },
    {
      expectedReason: 'mixer-snapshot-stale',
      mutate(project: ProjectState) {
        project.tracks[0].level = -12;
      },
      name: 'Mixer-only Snapshot drift',
    },
    {
      expectedReason: 'plan-stale',
      mutate(project: ProjectState) {
        project.tracks[0].clips[0].name = 'Changed Source';
      },
      name: 'render Plan drift',
    },
  ])('blocks $name before the Engine call', async ({ expectedReason, mutate }) => {
    const project = createProject();
    const request = createRequest();
    const intent = createIntent(project, request);
    const currentProject = clone(project);
    const client = createClient();
    mutate(currentProject, intent);
    const beforeRun = clone(currentProject);

    const result = await runProjectMixdownRequest(
      client,
      createCommand(project, request, () => currentProject, intent),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'preflight-rejected',
      registrationReason: expectedReason,
      status: 'PREFLIGHT_BLOCKED',
    });
    expect(client.runProjectMixdown).not.toHaveBeenCalled();
    expect(client.recoverProjectMixdown).not.toHaveBeenCalled();
    expect(client.checkGeneratedAudioAvailability).not.toHaveBeenCalled();
    expect(currentProject).toEqual(beforeRun);
  });

  it('rejects a conflicting immutable registration intent before dispatch', async () => {
    const project = createProject();
    const request = createRequest();
    const originalIntent = createIntent(project, request);
    const conflictingIntent = freezeDeep({
      ...clone(originalIntent),
      output: {
        ...originalIntent.output,
        clipId: 'mixdown-clip-conflict',
      },
    }) as ProjectMixdownRegistrationIntent;
    const client = createClient();

    const result = await runProjectMixdownRequest(
      client,
      createCommand(project, request, () => project, conflictingIntent),
    );

    expect(result).toMatchObject({
      registrationReason: 'intent-invalid',
      status: 'PREFLIGHT_BLOCKED',
    });
    expect(client.runProjectMixdown).not.toHaveBeenCalled();
  });

  it('rejects a mutable Request before dispatch', async () => {
    const project = createProject();
    const client = createClient();
    const mutableRequest = clone(createRequest()) as ProjectMixdownApiRequest;

    const result = await runProjectMixdownRequest(
      client,
      createCommand(project, mutableRequest),
    );

    expect(result).toMatchObject({
      cause: 'project-mixdown-runner-command-invalid',
      reason: 'request-invalid',
      status: 'RUNNER_FAILED',
    });
    expect(client.runProjectMixdown).not.toHaveBeenCalled();
  });
});

function createClient(
  overrides: Partial<ProjectMixdownRunnerClient> = {},
): ProjectMixdownRunnerClient {
  const operation = createOperation();
  const client: ProjectMixdownRunnerClient = {
    checkGeneratedAudioAvailability: vi.fn(async (
      sources: AvailabilitySources,
    ): Promise<AvailabilityResult> => ({
      availableSourceIds: sources.map((source) => source.sourceId),
      ok: true,
    })),
    recoverProjectMixdown: vi.fn(async (): Promise<MixdownResult> => ({
      ok: true,
      operation,
    })),
    runProjectMixdown: vi.fn(async (): Promise<MixdownResult> => ({
      ok: true,
      operation,
    })),
  };

  return { ...client, ...overrides };
}

function createCommand(
  project: ProjectState,
  request: ProjectMixdownApiRequest,
  getCurrentProject: () => ProjectState = () => project,
  intent: ProjectMixdownRegistrationIntent = createIntent(project, request),
): ProjectMixdownRunnerCommand {
  return {
    getCurrentProject,
    intent,
    request,
  };
}

function createIntent(
  project: ProjectState,
  request: ProjectMixdownApiRequest,
): ProjectMixdownRegistrationIntent {
  const resolution = createProjectMixdownRegistrationIntent(
    project,
    request,
    createProjectMixerRenderSnapshotV2({
      mixer: project.mixer,
      tracks: project.tracks,
    }),
  );

  if (!resolution.canCreate) {
    throw new Error(resolution.message);
  }

  return resolution.intent;
}

function createUnknownOutcome(
  cause: ProjectMixdownUnknownOutcome['cause'],
  nextOperationId = operationId,
): ProjectMixdownUnknownOutcome {
  return {
    cause,
    message: 'The response was lost after dispatch.',
    ok: false,
    operationId: nextOperationId,
    outcome: 'unknown',
    reason: 'unknown-outcome',
  };
}

function createUnknownResult(
  request: ProjectMixdownApiRequest,
  unknownOutcome: ProjectMixdownUnknownOutcome,
  intent: ProjectMixdownRegistrationIntent,
): ProjectMixdownUnknownResult {
  return {
    cause: unknownOutcome.cause,
    intent,
    message: unknownOutcome.message,
    ok: false,
    operationId: unknownOutcome.operationId,
    reason: 'unknown-outcome',
    request,
    status: 'MIXDOWN_OUTCOME_UNKNOWN',
    unknownOutcome,
  };
}

function createProject(): ProjectState {
  const project = clone(sampleProject);
  const sourceArtifact = createSourceArtifact();
  const sourceTake: GeneratedAudioClipTake = {
    artifactId: sourceArtifact.artifactId,
    clipTakeId: sourceTakeId,
    createdAt: sourceArtifact.createdAt,
    label: 'Instrument Take 01',
    mediaType: 'audio',
    sourceJobId: sourceArtifact.sourceJobId,
    sourceType: 'job',
  };
  const tracks: Track[] = [
    {
      clips: [
        {
          activeClipTakeId: sourceTake.clipTakeId,
          audioTiming: {
            sourceEndSeconds: 0.5,
            sourceStartSeconds: 0,
            timeBase: 'absolute-seconds',
          },
          clipTakes: [sourceTake],
          color: '#5e8fb8',
          createdAt: sourceArtifact.createdAt,
          id: 'clip-generated',
          lengthTicks: 960,
          name: 'Generated Source',
          sourceFile: {
            durationSeconds: 0.5,
            mimeType: 'audio/wav',
            name: `${sourceArtifact.artifactId}.wav`,
            relativePath: `renders/instruments/${sourceArtifact.artifactId}.wav`,
            sizeBytes: sourceArtifact.file.sizeBytes,
            sourceId: sourceArtifact.artifactId,
            status: 'available',
          },
          startTick: 0,
          type: 'instrument-audio',
          version: 1,
        },
      ],
      id: 'track-generated',
      level: -3,
      name: 'Generated',
      type: 'audio',
    },
    {
      clips: [
        {
          audioTiming: {
            sourceEndSeconds: 0.5,
            sourceStartSeconds: 0,
            timeBase: 'absolute-seconds',
          },
          color: '#8b6fb8',
          createdAt: '2026-08-08T00:00:00.000Z',
          id: 'clip-external',
          lengthTicks: 960,
          name: 'External Source',
          sourceFile: {
            durationSeconds: 0.5,
            lastModified: 1_786_089_600_000,
            lastKnownPath: 'D:\\Audio\\external.wav',
            mimeType: 'audio/wav',
            name: 'external.wav',
            sizeBytes: 88_244,
            sourceId: 'external-source',
            status: 'available',
          },
          startTick: 960,
          type: 'vocal-audio',
          version: 1,
        },
      ],
      id: 'track-external',
      level: 2,
      name: 'External',
      type: 'audio',
    },
    {
      clips: [
        {
          color: '#d8b25c',
          createdAt: '2026-08-08T00:00:00.000Z',
          id: 'clip-master',
          lengthTicks: 1,
          name: 'Master',
          startTick: 0,
          type: 'master',
          version: 1,
        },
      ],
      id: 'track-master',
      level: 0,
      name: 'Master',
      type: 'master',
    },
  ];

  project.artifacts = [sourceArtifact];
  project.bpm = 120;
  project.mixer = undefined;
  project.totalTicks = 1_920;
  project.tracks = tracks;
  return project;
}

function createProjectWithPriorMixdown(): ProjectState {
  const project = createProject();
  const priorArtifactId = 'artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const priorOperationId =
    'mixdown-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const priorClipTakeId = `clip-take-${priorArtifactId}`;
  const priorArtifact: ProjectMixdownAudioArtifact = {
    artifactId: priorArtifactId,
    audio: {
      bitsPerSample: 16,
      channels: 2,
      durationSeconds: 1,
      frameCount: 44_100,
      mimeType: 'audio/wav',
      sampleRate: 44_100,
    },
    createdAt: '2026-08-08T00:30:00.000Z',
    destination: 'mixdown',
    file: {
      extension: '.wav',
      name: `${priorArtifactId}.wav`,
      relativePath: `mixdowns/${priorArtifactId}.wav`,
      sizeBytes: 176_444,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    mixdownProvenance: {
      canonicalPlanJson: '{}',
      inputClipIds: [],
      inputSourceIds: [],
      inputTrackIds: [],
      operationProtocolVersion: '1',
      planVersion: 2,
      rendererId: 'humstudio-pcm-mixdown',
      rendererVersion: '0.1.0',
    },
    sourceOperationId: priorOperationId,
  };
  const priorClipTake: ProjectMixdownAudioClipTake = {
    artifactId: priorArtifactId,
    clipTakeId: priorClipTakeId,
    createdAt: priorArtifact.createdAt,
    label: 'Raw Mix 01',
    mediaType: 'audio',
    sourceOperationId: priorOperationId,
    sourceType: 'mixdown',
  };

  project.artifacts = [...(project.artifacts ?? []), priorArtifact];
  project.tracks = [
    ...project.tracks,
    {
      clips: [
        {
          activeClipTakeId: priorClipTakeId,
          audioTiming: {
            sourceEndSeconds: 1,
            sourceStartSeconds: 0,
            timeBase: 'absolute-seconds',
          },
          clipTakes: [priorClipTake],
          color: '#d8b25c',
          createdAt: priorArtifact.createdAt,
          id: 'clip-prior-mix',
          lengthTicks: 1_920,
          name: 'Raw Mix 01',
          sourceFile: {
            durationSeconds: 1,
            mimeType: 'audio/wav',
            name: priorArtifact.file.name,
            relativePath: priorArtifact.file.relativePath,
            sizeBytes: priorArtifact.file.sizeBytes,
            sourceId: priorArtifact.artifactId,
            status: 'available',
          },
          startTick: 0,
          type: 'mixdown',
          version: 1,
        },
      ],
      id: 'track-prior-mix',
      level: 0,
      muted: false,
      name: 'Raw Mix 01',
      type: 'audio',
    },
  ];
  project.mixer = undefined;
  return project;
}

function createSourceArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: sourceArtifactId,
    audio: {
      channels: 2,
      durationSeconds: 0.5,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-08T00:00:00.000Z',
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

function createRequest(): ProjectMixdownApiRequest {
  return createProjectMixdownApiRequest(createPlan(), operationId);
}

function createPlan(): ProjectMixdownPlan {
  return createTestProjectMixdownPlanV3({
    bpm: 120,
    durationSeconds: 1,
    endTick: 1_920,
    snapshotChannels: [
      { gainDb: -3, pan: 0, trackId: 'track-generated' },
      { gainDb: 2, pan: 0, trackId: 'track-external' },
      { gainDb: 0, pan: 0, trackId: 'track-master' },
    ],
    sources: [
      {
        kind: 'generated',
        name: `${sourceArtifactId}.wav`,
        relativePath: `renders/instruments/${sourceArtifactId}.wav`,
        sizeBytes: 88_244,
        sourceId: sourceArtifactId,
      },
      {
        kind: 'external',
        lastModified: 1_786_089_600_000,
        name: 'external.wav',
        path: 'D:\\Audio\\external.wav',
        sizeBytes: 88_244,
        sourceId: 'external-source',
      },
    ],
    tracks: [
      {
        events: [
          {
            clipId: 'clip-generated',
            clipName: 'Generated Source',
            durationSeconds: 0.5,
            sourceId: sourceArtifactId,
            sourceStartSeconds: 0,
            startOffsetSeconds: 0,
            timelineEndTick: 960,
            timelineStartTick: 0,
          },
        ],
        gainDb: -3,
        pan: 0,
        trackId: 'track-generated',
      },
      {
        events: [
          {
            clipId: 'clip-external',
            clipName: 'External Source',
            durationSeconds: 0.5,
            sourceId: 'external-source',
            sourceStartSeconds: 0,
            startOffsetSeconds: 0.5,
            timelineEndTick: 1_920,
            timelineStartTick: 960,
          },
        ],
        gainDb: 2,
        pan: 0,
        trackId: 'track-external',
      },
    ],
  });
}

function createOperation(
  request: ProjectMixdownApiRequest = createRequest(),
): ProjectMixdownApiOperation {
  const resultArtifactId = createProjectMixdownArtifactId(request.operationId);

  if (!resultArtifactId) {
    throw new Error('Expected one valid Mixdown Artifact identity.');
  }

  const resultFrameCount = Math.round(
    request.plan.durationSeconds * 44_100,
  );
  const resultBytesWritten = 44 + resultFrameCount * 4;

  return {
    operationId: request.operationId,
    protocolVersion: '2',
    result: {
      artifact: {
        artifactId: resultArtifactId,
        createdAt: '2026-08-08T01:00:01.000Z',
        destination: 'mixdown',
        file: {
          extension: '.wav',
          name: `${resultArtifactId}.wav`,
          relativePath: `mixdowns/${resultArtifactId}.wav`,
          sizeBytes: resultBytesWritten,
        },
        kind: 'audio',
        provenance: {
          planVersion: request.plan.version,
          rendererId: 'humstudio-pcm-mixdown',
          rendererVersion: '0.2.0',
        },
      },
      mixdown: {
        bitsPerSample: 16,
        bytesWritten: resultBytesWritten,
        channels: 2,
        durationSeconds: resultFrameCount / 44_100,
        frameCount: resultFrameCount,
        mimeType: 'audio/wav',
        sampleRate: 44_100,
        sourceCount: request.plan.sources.length,
        trackCount: request.plan.tracks.length,
      },
      status: 'COMPLETED',
    },
  };
}

function findClip(project: ProjectState, clipId: string) {
  const clips = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);

  if (clips.length !== 1) {
    throw new Error(`Expected one Clip: ${clipId}.`);
  }

  return clips[0];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(freezeDeep);
    Object.freeze(value);
  }

  return value;
}
