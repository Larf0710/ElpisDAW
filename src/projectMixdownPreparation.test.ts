import { describe, expect, it } from 'vitest';

import type {
  LocalEngineSourceDescriptor,
  LocalEngineSourceRestoration,
} from './localEngineClient';
import {
  prepareProjectMixdown,
  resolveClipFilerProductionSettings,
  resolveProjectMixdownDownload,
} from './projectMixdownPreparation';
import { timelineTicksToSeconds } from './audioClipTiming';
import { sampleProject } from './sampleProject';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  PatchTab,
  ProjectMixdownAudioArtifact,
  ProjectMixdownAudioClipTake,
  ProjectState,
} from './types';

const sourceArtifactId = 'artifact-source-a';
const operationId =
  'mixdown-operation-11111111-1111-4111-8111-111111111111';

describe('Project Mixdown preparation', () => {
  it('accepts only the explicit WAV and Normalize Off production boundary', () => {
    expect(resolveClipFilerProductionSettings(createClipFiler())).toEqual({
      canResolve: true,
      settings: { format: 'WAV', normalize: 'Off' },
    });
    expect(
      resolveClipFilerProductionSettings(
        createClipFiler({ format: 'MP3' }),
      ),
    ).toMatchObject({
      canResolve: false,
      cause: 'format-unsupported',
    });
    expect(
      resolveClipFilerProductionSettings(
        createClipFiler({ normalize: 'On' }),
      ),
    ).toMatchObject({
      canResolve: false,
      cause: 'normalize-unsupported',
    });
  });

  it('prepares one immutable whole-Project Request and ignores unrelated descriptors', () => {
    const project = createProject();
    const descriptor = createSourceDescriptor();
    const preparation = prepareProjectMixdown(
      project,
      [
        descriptor,
        {
          kind: 'generated',
          name: 'artifact-muted.wav',
          relativePath: 'renders/instruments/artifact-muted.wav',
          sizeBytes: 48_044,
          sourceId: 'artifact-muted',
        },
      ],
      createRestoration(descriptor),
      operationId,
    );

    expect(preparation).toMatchObject({
      canPrepare: true,
      request: { operationId },
      summary: {
        durationSeconds: 0.5,
        sourceCount: 1,
        trackCount: 1,
      },
    });

    if (!preparation.canPrepare) {
      throw new Error(preparation.message);
    }

    expect(preparation.plan.sources).toEqual([descriptor]);
    expect(preparation.plan.tracks[0]?.trackId).toBe('track-source');
    expect(preparation.intent.output.trackName).toBe('Raw Mix 01');
    expect(Object.isFrozen(preparation.request)).toBe(true);
    expect(Object.isFrozen(preparation.intent)).toBe(true);
  });

  it('preserves a terminal 48 kHz source duration that is not an integer Timeline tick', () => {
    const project = createProject();
    const descriptor = createSourceDescriptor();
    const sourceDurationSeconds = 470_528 / 48_000;
    const sourceClip = project.tracks[0]!.clips[0]!;
    const sourceArtifact = project.artifacts![0] as GeneratedAudioArtifact;

    project.totalTicks = 61_440;
    sourceArtifact.audio.durationSeconds = sourceDurationSeconds;
    sourceClip.audioTiming!.sourceEndSeconds = sourceDurationSeconds;
    sourceClip.sourceFile!.durationSeconds = sourceDurationSeconds;
    sourceClip.lengthTicks = 18_821;

    expect(
      timelineTicksToSeconds(sourceClip.lengthTicks, project.bpm),
    ).not.toBe(sourceDurationSeconds);

    const preparation = prepareProjectMixdown(
      project,
      [descriptor],
      createRestoration(descriptor),
      operationId,
    );

    expect(preparation).toMatchObject({
      canPrepare: true,
      request: { operationId },
    });

    if (!preparation.canPrepare) {
      throw new Error(preparation.message);
    }

    expect(preparation.plan.tracks[0]?.events[0]).toMatchObject({
      durationSeconds: sourceDurationSeconds,
      timelineEndTick: sourceClip.lengthTicks,
    });
    expect(preparation.intent.sourceLineage).toEqual({
      parentArtifactIds: [sourceArtifactId],
      parentClipTakeIds: ['clip-take-source-a'],
    });
  });

  it('fails closed when an audible source is not Engine-openable', () => {
    const project = createProject();
    const descriptor = createSourceDescriptor();
    const restoration = createRestoration(descriptor, 'unopenable');

    expect(
      prepareProjectMixdown(
        project,
        [descriptor],
        restoration,
        operationId,
      ),
    ).toMatchObject({
      canPrepare: false,
      cause: 'playback-plan-unavailable',
    });
  });

  it('resolves only a finalized registered Raw Mix as a downloadable WAV', () => {
    const project = createProjectWithMixdown();

    expect(
      resolveProjectMixdownDownload(
        project,
        createClipFiler(),
        'clip-raw-mix-a',
      ),
    ).toEqual({
      canDownload: true,
      descriptor: {
        kind: 'generated',
        name: 'artifact-mixdown-a.wav',
        relativePath: 'mixdowns/artifact-mixdown-a.wav',
        sizeBytes: 176_444,
        sourceId: 'artifact-mixdown-a',
      },
      fileName: 'ElpisDAW-Raw Mix 01.wav',
    });
    expect(
      resolveProjectMixdownDownload(
        project,
        createClipFiler(),
        'clip-source-a',
      ),
    ).toMatchObject({ canDownload: false, cause: 'target-invalid' });

    const forgedProject = createProject();
    forgedProject.tracks[0]!.clips[0]!.type = 'mixdown';
    expect(
      resolveProjectMixdownDownload(
        forgedProject,
        createClipFiler(),
        'clip-source-a',
      ),
    ).toMatchObject({
      canDownload: false,
      cause: 'mixdown-source-invalid',
    });
  });
});

function createClipFiler(
  settings: Readonly<{ format?: string; normalize?: string }> = {},
): PatchTab {
  return {
    id: 'export',
    name: 'Clip Filer',
    colorIndex: 4,
    inputType: 'Selected Clip',
    outputType: 'Export File',
    status: 'ready',
    description: 'Production output settings.',
    parameters: [
      {
        id: 'format',
        label: 'Format',
        kind: 'select',
        value: settings.format ?? 'WAV',
        options: ['WAV', 'MP3', 'MIDI'],
      },
      {
        id: 'normalize',
        label: 'Normalize',
        kind: 'select',
        value: settings.normalize ?? 'Off',
        options: ['On', 'Off'],
      },
    ],
  };
}

function createProject(): ProjectState {
  const project = structuredClone(sampleProject);
  const artifact = createSourceArtifact();
  const clipTake: GeneratedAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-source-a',
    createdAt: artifact.createdAt,
    label: 'Instrument Take 01',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };

  project.artifacts = [artifact];
  project.bpm = 120;
  project.mixer = undefined;
  project.playheadTick = 0;
  project.selection = { items: [] };
  project.totalTicks = 960;
  project.tracks = [
    {
      clips: [
        {
          activeClipTakeId: clipTake.clipTakeId,
          audioTiming: {
            sourceEndSeconds: 0.5,
            sourceStartSeconds: 0,
            timeBase: 'absolute-seconds',
          },
          clipTakes: [clipTake],
          color: '#5e8fb8',
          createdAt: artifact.createdAt,
          id: 'clip-source-a',
          lengthTicks: 960,
          name: 'Instrument Source',
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
      level: 0,
      name: 'Source',
      parentGroupId: null,
      type: 'audio',
    },
  ];

  return project;
}

function createProjectWithMixdown(): ProjectState {
  const project = createProject();
  const artifact: ProjectMixdownAudioArtifact = {
    artifactId: 'artifact-mixdown-a',
    audio: {
      bitsPerSample: 16,
      channels: 2,
      durationSeconds: 1,
      frameCount: 44_100,
      mimeType: 'audio/wav',
      sampleRate: 44_100,
    },
    createdAt: '2026-08-12T14:00:00.000Z',
    destination: 'mixdown',
    file: {
      extension: '.wav',
      name: 'artifact-mixdown-a.wav',
      relativePath: 'mixdowns/artifact-mixdown-a.wav',
      sizeBytes: 176_444,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    mixdownProvenance: {
      canonicalPlanJson: '{}',
      inputClipIds: [],
      inputSourceIds: [],
      inputTrackIds: [],
      operationProtocolVersion: '2',
      planVersion: 3,
      rendererId: 'humstudio-pcm-mixdown',
      rendererVersion: '0.2.0',
      schemaVersion: 2,
    },
    sourceOperationId: operationId,
  };
  const clipTake: ProjectMixdownAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-artifact-mixdown-a',
    createdAt: artifact.createdAt,
    label: 'Raw Mix 01',
    mediaType: 'audio',
    sourceOperationId: operationId,
    sourceType: 'mixdown',
  };

  project.artifacts = [...(project.artifacts ?? []), artifact];
  project.tracks = [
    ...project.tracks,
    {
      clips: [
        {
          activeClipTakeId: clipTake.clipTakeId,
          audioTiming: {
            sourceEndSeconds: 1,
            sourceStartSeconds: 0,
            timeBase: 'absolute-seconds',
          },
          clipTakes: [clipTake],
          color: '#d8b25c',
          createdAt: artifact.createdAt,
          id: 'clip-raw-mix-a',
          lengthTicks: 960,
          name: 'Raw Mix 01',
          sourceFile: {
            durationSeconds: 1,
            mimeType: 'audio/wav',
            name: artifact.file.name,
            relativePath: artifact.file.relativePath,
            sizeBytes: artifact.file.sizeBytes,
            sourceId: artifact.artifactId,
            status: 'available',
          },
          startTick: 0,
          type: 'mixdown',
          version: 1,
        },
      ],
      id: 'track-raw-mix-a',
      level: 0,
      muted: true,
      name: 'Raw Mix 01',
      type: 'audio',
    },
  ];

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
    createdAt: '2026-08-12T12:00:00.000Z',
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
      modelId: 'test-model',
      modelRevision: '1',
      parameters: {},
      providerId: 'test-provider',
      taskId: 'instrument-render',
    },
    sourceJobId: 'job-source-a',
  };
}

function createSourceDescriptor(): LocalEngineSourceDescriptor {
  return Object.freeze({
    kind: 'generated' as const,
    name: `${sourceArtifactId}.wav`,
    relativePath: `renders/instruments/${sourceArtifactId}.wav`,
    sizeBytes: 88_244,
    sourceId: sourceArtifactId,
  });
}

function createRestoration(
  descriptor: LocalEngineSourceDescriptor,
  state: 'available' | 'unopenable' = 'available',
): LocalEngineSourceRestoration {
  return Object.freeze({
    availability: Object.freeze({ [descriptor.sourceId]: state }),
    checkedAt: '2026-08-12T13:00:00.000Z',
    sources: Object.freeze([
      Object.freeze({
        kind: descriptor.kind,
        reason: state,
        sourceId: descriptor.sourceId,
        state,
        ...(descriptor.kind === 'generated'
          ? { relativePath: descriptor.relativePath }
          : { path: descriptor.path }),
      }),
    ]),
  });
}
