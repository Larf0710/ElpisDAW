import { describe, expect, it } from 'vitest';

import { createProjectMixdownApiRequest } from './projectMixdownApi';
import {
  createProjectMixdownArtifactCandidate,
  createProjectMixdownRegistration,
} from './projectMixdownRegistration';
import {
  normalizeClipTakeState,
  normalizeProjectArtifacts,
} from './projectArtifactRegistration';
import { sampleProject } from './sampleProject';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
  Track,
} from './types';
import type { ProjectMixdownPlan } from './projectMixdownPlan';
import { createTestProjectMixdownPlanV3 } from './projectMixdownTestFixtures';

const operationId =
  'mixdown-operation-11111111-1111-4111-8111-111111111111';
const artifactId = 'artifact-22222222-2222-4222-8222-222222222222';
const sourceArtifactId = 'artifact-input';
const sourceTakeId = 'clip-take-artifact-input';
const frameCount = 44_100;
const bytesWritten = 44 + frameCount * 4;

describe('createProjectMixdownRegistration', () => {
  it('registers one verified Raw Mixdown Take with exact typed input lineage', () => {
    const project = createProject();
    const sourceTracks = project.tracks.slice(0, 2);
    const request = createRequest();
    const update = createProjectMixdownRegistration(
      project,
      request,
      createOperation(),
      {
        clipId: 'clip-master',
        sourceAvailability: {
          availableArtifactIds: [artifactId],
          checkedAt: '2026-08-08T01:00:02.000Z',
        },
      },
    );

    expect(update).toMatchObject({
      artifact: {
        artifactId,
        audio: {
          bitsPerSample: 16,
          channels: 2,
          durationSeconds: 1,
          frameCount,
          mimeType: 'audio/wav',
          sampleRate: 44_100,
        },
        destination: 'mixdown',
        lineage: {
          parentArtifactIds: [sourceArtifactId],
          parentClipTakeIds: [sourceTakeId],
        },
        mixdownProvenance: {
          canonicalPlanJson: expect.any(String),
          inputClipIds: ['clip-generated', 'clip-external'],
          inputSourceIds: [sourceArtifactId, 'external-source'],
          inputTrackIds: ['track-generated', 'track-external'],
          operationProtocolVersion: '2',
          planVersion: 3,
          rendererId: 'humstudio-pcm-mixdown',
          rendererVersion: '0.2.0',
          schemaVersion: 2,
        },
        sourceOperationId: operationId,
      },
      canRegister: true,
      clipTake: {
        artifactId,
        label: 'Raw Mixdown 01',
        mediaType: 'audio',
        sourceOperationId: operationId,
        sourceType: 'mixdown',
      },
      status: 'REGISTERED',
    });

    if (!update.canRegister) {
      throw new Error(update.message);
    }

    const master = findClip(update.project, 'clip-master');

    expect(update.project).not.toBe(project);
    expect(update.project.tracks[0]).toBe(sourceTracks[0]);
    expect(update.project.tracks[1]).toBe(sourceTracks[1]);
    expect(update.project.tracks[0]).toEqual(project.tracks[0]);
    expect(update.project.tracks[1]).toEqual(project.tracks[1]);
    expect(master.activeClipTakeId).toBe(update.clipTake.clipTakeId);
    expect(master.audioTiming).toEqual({
      sourceEndSeconds: 1,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    });
    expect(master.startTick).toBe(0);
    expect(master.lengthTicks).toBe(1_920);
    expect(master.sourceFile).toEqual({
      checkedAt: '2026-08-08T01:00:02.000Z',
      durationSeconds: 1,
      mimeType: 'audio/wav',
      name: `${artifactId}.wav`,
      relativePath: `mixdowns/${artifactId}.wav`,
      sizeBytes: bytesWritten,
      sourceId: artifactId,
      status: 'available',
    });
    expect(project.artifacts).toHaveLength(1);
    expect(findClip(project, 'clip-master').clipTakes).toBeUndefined();
  });

  it('prepares immutable verification authority but blocks an unverified Project commit', () => {
    const project = createProject();
    const candidate = createProjectMixdownArtifactCandidate(
      project,
      createRequest(),
      createOperation(),
      { clipId: 'clip-master' },
    );

    expect(candidate).toMatchObject({
      artifact: { artifactId, sourceOperationId: operationId },
      canPrepare: true,
      status: 'READY',
    });
    expect(project.artifacts).toHaveLength(1);
    expect(findClip(project, 'clip-master').clipTakes).toBeUndefined();
    expect(
      createProjectMixdownRegistration(
        project,
        createRequest(),
        createOperation(),
        { clipId: 'clip-master' },
      ),
    ).toMatchObject({
      canRegister: false,
      reason: 'artifact-unavailable',
    });
  });

  it('is idempotent for the same operation, outcome, Plan, and Master Clip', () => {
    const first = createProjectMixdownRegistration(
      createProject(),
      createRequest(),
      createOperation(),
      verifiedOptions(),
    );

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const repeated = createProjectMixdownRegistration(
      first.project,
      createRequest(),
      createOperation(),
      { clipId: 'clip-master', label: 'Ignored repeat label' },
    );

    expect(repeated).toMatchObject({
      canRegister: true,
      status: 'ALREADY_REGISTERED',
    });

    if (!repeated.canRegister) {
      throw new Error(repeated.message);
    }

    expect(repeated.project).toBe(first.project);
    expect(repeated.artifact).toBe(first.artifact);
    expect(repeated.clipTake).toBe(first.clipTake);
  });

  it('recovers an existing identical registration before checking later source drift', () => {
    const first = createProjectMixdownRegistration(
      createProject(),
      createRequest(),
      createOperation(),
      verifiedOptions(),
    );

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    first.project.tracks[0].level = 12;
    findClip(first.project, 'clip-generated').activeClipTakeId = 'deleted-take';

    expect(
      createProjectMixdownRegistration(
        first.project,
        createRequest(),
        createOperation(),
        { clipId: 'clip-master' },
      ),
    ).toMatchObject({
      canRegister: true,
      status: 'ALREADY_REGISTERED',
    });
  });

  it('rejects reuse of a registered operationId with a different canonical Plan', () => {
    const first = createProjectMixdownRegistration(
      createProject(),
      createRequest(),
      createOperation(),
      verifiedOptions(),
    );

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const differentPlan = clone(createPlan()) as ProjectMixdownPlan & {
      tracks: Array<{ gainDb: number }>;
    };
    differentPlan.tracks[0].gainDb = -2;
    const mutableSnapshot = differentPlan.mixerSnapshot as unknown as {
      channels: Array<{ faderDb: number }>;
    };
    mutableSnapshot.channels[0].faderDb = -2;

    expect(
      createProjectMixdownRegistration(
        first.project,
        createProjectMixdownApiRequest(differentPlan, operationId),
        createOperation(),
        { clipId: 'clip-master' },
      ),
    ).toMatchObject({
      canRegister: false,
      reason: 'artifact-conflict',
    });
  });

  it('rejects operation/artifact identity conflicts instead of creating a second Take', () => {
    const first = createProjectMixdownRegistration(
      createProject(),
      createRequest(),
      createOperation(),
      verifiedOptions(),
    );

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const conflictingOperation = createOperation({
      artifactId: 'artifact-33333333-3333-4333-8333-333333333333',
    });
    const conflict = createProjectMixdownRegistration(
      first.project,
      createRequest(),
      conflictingOperation,
      verifiedOptions(),
    );

    expect(conflict).toMatchObject({
      canRegister: false,
      reason: 'artifact-conflict',
    });
    expect(findClip(first.project, 'clip-master').clipTakes).toHaveLength(1);
    expect(first.project.artifacts).toHaveLength(2);
  });

  it('rejects mismatched envelopes and impossible completed output metadata', () => {
    const request = createRequest();
    const differentRequest = createProjectMixdownApiRequest(
      createPlan(),
      'mixdown-operation-44444444-4444-4444-8444-444444444444',
    );
    const invalidSize = createOperation();
    invalidSize.result.artifact.file.sizeBytes += 4;
    invalidSize.result.mixdown.bytesWritten += 4;

    expect(
      createProjectMixdownRegistration(
        createProject(),
        differentRequest,
        createOperation(),
        { clipId: 'clip-master' },
      ),
    ).toMatchObject({ canRegister: false, reason: 'operation-invalid' });
    expect(
      createProjectMixdownRegistration(
        createProject(),
        request,
        invalidSize,
        { clipId: 'clip-master' },
      ),
    ).toMatchObject({ canRegister: false, reason: 'operation-invalid' });
  });

  it('requires one Master Audio Clip and rejects self-input registration', () => {
    expect(
      createProjectMixdownRegistration(
        createProject(),
        createRequest(),
        createOperation(),
        { clipId: 'clip-generated' },
      ),
    ).toMatchObject({ canRegister: false, reason: 'target-not-master' });
    expect(
      createProjectMixdownRegistration(
        createProject(),
        createRequest(),
        createOperation(),
        { clipId: 'missing-master' },
      ),
    ).toMatchObject({ canRegister: false, reason: 'target-not-found' });

    const selfInputPlan = clone(createPlan()) as ProjectMixdownPlan & {
      tracks: Array<{
        events: Array<{
          clipId: string;
          clipName: string;
        }>;
      }>;
    };
    selfInputPlan.tracks[0].events[0].clipId = 'clip-master';
    selfInputPlan.tracks[0].events[0].clipName = 'Master';

    expect(
      createProjectMixdownRegistration(
        createProject(),
        createProjectMixdownApiRequest(selfInputPlan, operationId),
        createOperation(),
        { clipId: 'clip-master' },
      ),
    ).toMatchObject({ canRegister: false, reason: 'target-is-input' });
  });

  it('fails closed when Track, Clip timing, descriptor, or Active Take lineage drifts', () => {
    const mutations: Array<(project: ProjectState) => void> = [
      (project) => {
        project.tracks[0].level = -2;
      },
      (project) => {
        findClip(project, 'clip-external').startTick = 480;
      },
      (project) => {
        const sourceFile = findClip(project, 'clip-external').sourceFile;
        if (sourceFile) sourceFile.sizeBytes = 99;
      },
      (project) => {
        findClip(project, 'clip-generated').activeClipTakeId = 'missing-take';
      },
    ];

    for (const mutate of mutations) {
      const project = createProject();
      mutate(project);

      expect(
        createProjectMixdownRegistration(
          project,
          createRequest(),
          createOperation(),
          { clipId: 'clip-master' },
        ),
      ).toMatchObject({
        canRegister: false,
        reason: 'source-lineage-invalid',
      });
    }
  });

  it('preserves the current Master Take when the Raw Mixdown is registered inactive', () => {
    const first = createProjectMixdownRegistration(
      createProject(),
      createRequest(),
      createOperation(),
      verifiedOptions(),
    );

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const previousMaster = findClip(first.project, 'clip-master');
    const nextOperationId =
      'mixdown-operation-55555555-5555-4555-8555-555555555555';
    const nextArtifactId = 'artifact-66666666-6666-4666-8666-666666666666';
    const second = createProjectMixdownRegistration(
      first.project,
      createProjectMixdownApiRequest(createPlan(), nextOperationId),
      createOperation({ artifactId: nextArtifactId, operationId: nextOperationId }),
      verifiedOptions({
        activate: false,
        artifactId: nextArtifactId,
      }),
    );

    if (!second.canRegister) {
      throw new Error(second.message);
    }

    const nextMaster = findClip(second.project, 'clip-master');

    expect(nextMaster.activeClipTakeId).toBe(previousMaster.activeClipTakeId);
    expect(nextMaster.audioTiming).toEqual(previousMaster.audioTiming);
    expect(nextMaster.sourceFile).toEqual(previousMaster.sourceFile);
    expect(nextMaster.clipTakes).toHaveLength(2);
  });
});

describe('Raw Mixdown Project persistence', () => {
  it('round-trips typed Artifact/ClipTake records and drops duplicate operations', () => {
    const registered = createProjectMixdownRegistration(
      createProject(),
      createRequest(),
      createOperation(),
      verifiedOptions(),
    );

    if (!registered.canRegister) {
      throw new Error(registered.message);
    }

    const serializedArtifact = clone(registered.artifact);
    const serializedTake = clone(registered.clipTake);
    const duplicateOperationArtifact = {
      ...serializedArtifact,
      artifactId: 'artifact-77777777-7777-4777-8777-777777777777',
      file: {
        ...serializedArtifact.file,
        name: 'artifact-77777777-7777-4777-8777-777777777777.wav',
        relativePath:
          'mixdowns/artifact-77777777-7777-4777-8777-777777777777.wav',
      },
    };
    const malformedArtifact = {
      ...serializedArtifact,
      audio: { ...serializedArtifact.audio, frameCount: frameCount + 1 },
    };

    expect(
      normalizeProjectArtifacts([
        serializedArtifact,
        duplicateOperationArtifact,
        malformedArtifact,
      ]),
    ).toEqual([registered.artifact]);
    expect(normalizeProjectArtifacts([malformedArtifact])).toEqual([]);
    expect(
      normalizeClipTakeState(
        [
          serializedTake,
          {
            ...serializedTake,
            artifactId: duplicateOperationArtifact.artifactId,
            clipTakeId: `clip-take-${duplicateOperationArtifact.artifactId}`,
          },
        ],
        serializedTake.clipTakeId,
      ),
    ).toEqual({
      activeClipTakeId: registered.clipTake.clipTakeId,
      clipTakes: [registered.clipTake],
    });
  });

  it('parses legacy Plan v1 provenance explicitly without reinterpreting v2 DSP fields', () => {
    const registered = createProjectMixdownRegistration(
      createProject(),
      createRequest(),
      createOperation(),
      verifiedOptions(),
    );

    if (!registered.canRegister) {
      throw new Error(registered.message);
    }

    const legacyArtifact = clone(registered.artifact);
    const legacyPlan = JSON.parse(
      legacyArtifact.mixdownProvenance.canonicalPlanJson,
    ) as Record<string, unknown> & {
      tracks: Array<Record<string, unknown>>;
      version: number;
    };
    legacyPlan.version = 1;
    delete legacyPlan.effectsContractVersion;
    delete legacyPlan.masterFaderDb;
    delete legacyPlan.meterTapVersion;
    delete legacyPlan.mixerDspVersion;
    delete legacyPlan.mixerSnapshot;
    delete legacyPlan.mixerSnapshotVersion;
    legacyPlan.tracks.forEach((track) => delete track.pan);
    legacyArtifact.mixdownProvenance = {
      canonicalPlanJson: JSON.stringify(legacyPlan),
      inputClipIds: legacyArtifact.mixdownProvenance.inputClipIds,
      inputSourceIds: legacyArtifact.mixdownProvenance.inputSourceIds,
      inputTrackIds: legacyArtifact.mixdownProvenance.inputTrackIds,
      operationProtocolVersion: '1',
      planVersion: 1,
      rendererId: 'humstudio-pcm-mixdown',
      rendererVersion: '0.1.0',
    };

    const mislabeledV2Artifact = clone(registered.artifact);
    const mislabeledV2Plan = JSON.parse(
      mislabeledV2Artifact.mixdownProvenance.canonicalPlanJson,
    ) as Record<string, unknown>;
    mislabeledV2Plan.version = 1;
    mislabeledV2Artifact.mixdownProvenance = {
      canonicalPlanJson: JSON.stringify(mislabeledV2Plan),
      inputClipIds: mislabeledV2Artifact.mixdownProvenance.inputClipIds,
      inputSourceIds: mislabeledV2Artifact.mixdownProvenance.inputSourceIds,
      inputTrackIds: mislabeledV2Artifact.mixdownProvenance.inputTrackIds,
      operationProtocolVersion: '1',
      planVersion: 1,
      rendererId: 'humstudio-pcm-mixdown',
      rendererVersion: '0.1.0',
    };

    expect(normalizeProjectArtifacts([legacyArtifact])).toEqual([
      legacyArtifact,
    ]);
    expect(normalizeProjectArtifacts([mislabeledV2Artifact])).toEqual([]);
  });
});

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

function createRequest() {
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
  overrides: Readonly<{
    artifactId?: string;
    operationId?: string;
  }> = {},
) {
  const nextArtifactId = overrides.artifactId ?? artifactId;

  return {
    operationId: overrides.operationId ?? operationId,
    protocolVersion: '2',
    result: {
      artifact: {
        artifactId: nextArtifactId,
        createdAt: '2026-08-08T01:00:01.000Z',
        destination: 'mixdown',
        file: {
          extension: '.wav',
          name: `${nextArtifactId}.wav`,
          relativePath: `mixdowns/${nextArtifactId}.wav`,
          sizeBytes: bytesWritten,
        },
        kind: 'audio',
        provenance: {
          planVersion: 3,
          rendererId: 'humstudio-pcm-mixdown',
          rendererVersion: '0.2.0',
        },
      },
      mixdown: {
        bitsPerSample: 16,
        bytesWritten,
        channels: 2,
        durationSeconds: 1,
        frameCount,
        mimeType: 'audio/wav',
        sampleRate: 44_100,
        sourceCount: 2,
        trackCount: 2,
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

function verifiedOptions(
  overrides: Readonly<{
    activate?: boolean;
    artifactId?: string;
    label?: string;
  }> = {},
) {
  const {
    artifactId: availableArtifactId = artifactId,
    ...registrationOptions
  } = overrides;

  return {
    ...registrationOptions,
    clipId: 'clip-master',
    sourceAvailability: {
      availableArtifactIds: [availableArtifactId],
      checkedAt: '2026-08-08T01:00:02.000Z',
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
