import { describe, expect, it, vi } from 'vitest';

import type { LocalEngineSourceRestoration } from './localEngineClient';
import {
  prepareLoadedProjectSourceRestoration,
  type ProjectRootSourceRestorationAdapter,
} from './projectRootProjectOpen';
import {
  applyProjectSourceRestoration,
  collectProjectSourceRestorationDescriptors,
} from './projectSourceRestoration';
import { sampleProject } from './sampleProject';
import {
  reconnectProjectSessionAudioSources,
  SessionAudioSourceRegistry,
} from './sessionAudioSourceRegistry';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';

type TestWorkspace = Readonly<{ project: ProjectState }>;

const restorationAdapter: ProjectRootSourceRestorationAdapter<TestWorkspace> = {
  applyRestoration: (workspace, descriptors, restoration) => ({
    ...workspace,
    project: applyProjectSourceRestoration(
      workspace.project,
      descriptors,
      restoration,
    ),
  }),
  collectDescriptors: (workspace) =>
    collectProjectSourceRestorationDescriptors(workspace.project),
};

describe('saved Project generated and session source restoration', () => {
  it('restores Project Root generated audio before preserving session File reconnection', async () => {
    const workspace = createLoadedWorkspace();
    const restoration = createGeneratedRestoration();
    const restoreSources = vi.fn(async () => ({
      ok: true as const,
      restoration,
    }));
    const prepared = await prepareLoadedProjectSourceRestoration(
      { restoreSources },
      workspace,
      restorationAdapter,
      { engineReadyAndIdle: true, projectRootReady: true },
    );
    const registry = createSessionRegistry();
    const reconnected = reconnectProjectSessionAudioSources(
      prepared.workspace.project,
      registry,
    );

    expect(restoreSources).toHaveBeenCalledWith([
      {
        kind: 'generated',
        name: 'artifact-sa3.wav',
        relativePath: 'renders/stable-audio-3/artifact-sa3.wav',
        sizeBytes: 1_920_044,
        sourceId: 'artifact-sa3',
      },
    ]);
    expect(prepared).toMatchObject({
      availableGeneratedSourceCount: 1,
      generatedSourceCount: 1,
      status: 'RESTORED',
    });
    expect(findClip(reconnected.project, 'clip-generated').sourceFile?.status).toBe(
      'available',
    );
    expect(findClip(reconnected.project, 'clip-session').sourceFile?.status).toBe(
      'available',
    );
    expect(reconnected.reconnectedSourceCount).toBe(1);
    expect(findClip(workspace.project, 'clip-generated').sourceFile?.status).toBe(
      'unresolved',
    );
    expect(findClip(workspace.project, 'clip-session').sourceFile?.status).toBe(
      'unresolved',
    );
  });

  it('keeps generated audio unresolved after restoration failure while session File reconnect still works', async () => {
    const workspace = createLoadedWorkspace();
    const prepared = await prepareLoadedProjectSourceRestoration(
      {
        restoreSources: async () => ({
          message: 'Project Root is unavailable.',
          ok: false,
          reason: 'http-error',
          status: 503,
        }),
      },
      workspace,
      restorationAdapter,
      { engineReadyAndIdle: true, projectRootReady: true },
    );
    const reconnected = reconnectProjectSessionAudioSources(
      prepared.workspace.project,
      createSessionRegistry(),
    );

    expect(prepared).toMatchObject({
      status: 'RESTORATION_FAILED',
      workspace,
    });
    expect(prepared.message).toContain('Project Root is unavailable.');
    expect(findClip(reconnected.project, 'clip-generated').sourceFile?.status).toBe(
      'unresolved',
    );
    expect(findClip(reconnected.project, 'clip-session').sourceFile?.status).toBe(
      'available',
    );
    expect(reconnected.reconnectedSourceCount).toBe(1);
  });
});

function createLoadedWorkspace(): TestWorkspace {
  const project = structuredClone(sampleProject);
  const baseTrack = project.tracks[0];
  const baseClip = baseTrack?.clips[0];

  if (!baseTrack || !baseClip) {
    throw new Error('Sample Project requires one Track and Clip.');
  }

  const artifact = createGeneratedArtifact();
  const take: GeneratedAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-sa3',
    createdAt: artifact.createdAt,
    label: 'SA3 T2A Take',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
  const generatedClip: Clip = {
    ...baseClip,
    activeClipTakeId: take.clipTakeId,
    clipTakes: [take],
    id: 'clip-generated',
    name: 'Generated Backing',
    sourceFile: {
      name: artifact.file.name,
      relativePath: artifact.file.relativePath,
      sizeBytes: artifact.file.sizeBytes,
      sourceId: artifact.artifactId,
      status: 'unresolved',
    },
    type: 'ai-fill-audio',
  };
  const sessionClip: Clip = {
    ...baseClip,
    activeClipTakeId: undefined,
    clipTakes: undefined,
    id: 'clip-session',
    name: 'Imported Session Audio',
    sourceFile: {
      lastModified: 1_723_891_200_000,
      mimeType: 'audio/wav',
      name: 'session.wav',
      sizeBytes: 48_044,
      sourceId: 'session-source',
      status: 'unresolved',
    },
    type: 'hum-audio',
  };

  return Object.freeze({
    project: {
      ...project,
      artifacts: [artifact],
      tracks: [
        {
          ...baseTrack,
          clips: [generatedClip, sessionClip],
        },
      ],
    },
  });
}

function createGeneratedArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-sa3',
    audio: { channels: 2, durationSeconds: 10, mimeType: 'audio/wav' },
    createdAt: '2026-08-17T06:00:00.000Z',
    destination: 'stable-audio-3',
    file: {
      extension: '.wav',
      name: 'artifact-sa3.wav',
      relativePath: 'renders/stable-audio-3/artifact-sa3.wav',
      sizeBytes: 1_920_044,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'stable-audio-3-medium',
      modelRevision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
      parameters: {},
      providerId: 'local-stable-audio-3',
      taskId: 'text-to-audio',
    },
    sourceJobId: 'job-sa3',
  };
}

function createGeneratedRestoration(): LocalEngineSourceRestoration {
  return Object.freeze({
    availability: Object.freeze({ 'artifact-sa3': 'available' }),
    checkedAt: '2026-08-17T06:01:00.000Z',
    sources: Object.freeze([
      Object.freeze({
        actual: Object.freeze({
          lastModified: 1_723_891_260_000,
          name: 'artifact-sa3.wav',
          sizeBytes: 1_920_044,
        }),
        kind: 'generated' as const,
        reason: 'available' as const,
        relativePath: 'renders/stable-audio-3/artifact-sa3.wav',
        resolvedPath: 'D:\\Project\\renders\\stable-audio-3\\artifact-sa3.wav',
        sourceId: 'artifact-sa3',
        state: 'available' as const,
      }),
    ]),
  });
}

function createSessionRegistry(): SessionAudioSourceRegistry {
  const registry = new SessionAudioSourceRegistry();
  registry.register(
    'session-source',
    {
      lastModified: 1_723_891_200_000,
      name: 'session.wav',
      size: 48_044,
      type: 'audio/wav',
    } as File,
  );
  return registry;
}

function findClip(project: ProjectState, clipId: string): Clip {
  const matches = project.tracks.flatMap((track) => track.clips).filter(
    (clip) => clip.id === clipId,
  );

  if (matches.length !== 1) {
    throw new Error(`Expected one Clip ${clipId}.`);
  }

  return matches[0];
}
