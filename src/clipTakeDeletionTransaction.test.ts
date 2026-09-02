import { describe, expect, it, vi } from 'vitest';

import {
  areJsonValuesEquivalent,
  classifyAudioFileDeletion,
  isAmbiguousSideEffectFailure,
  reconcileCommittedClipTakeRemoval,
  settleProjectSave,
} from './clipTakeDeletionTransaction';
import type {
  LocalEngineHealthFailureReason,
  LocalEngineProjectFileLoadResult,
  LocalEngineProjectFileSaveResult,
} from './localEngineClient';
import { sampleProject } from './sampleProject';
import type { GeneratedAudioArtifact, GeneratedAudioClipTake } from './types';

const intendedProjectFile = {
  app: 'HumSTUDIO',
  savedAt: '2026-08-08T06:00:00.000Z',
  version: '0.1.0',
  workspace: {
    project: { artifacts: [], name: 'Deletion Safety' },
    selectedClipId: 'clip-a',
  },
};

describe('settleProjectSave', () => {
  it('accepts a normal successful save without readback', async () => {
    const loadProjectFile = vi.fn<() => Promise<LocalEngineProjectFileLoadResult>>();
    const result = await settleProjectSave(
      intendedProjectFile,
      createSuccessfulSaveResult(),
      loadProjectFile,
    );

    expect(result).toMatchObject({
      confirmation: 'response',
      savedProject: { status: 'SAVED' },
      status: 'CONFIRMED',
    });
    expect(loadProjectFile).not.toHaveBeenCalled();
  });

  it.each(['offline', 'timeout', 'invalid-response'] as const)(
    'confirms an ambiguous %s result through exact readback',
    async (reason) => {
      const result = await settleProjectSave(
        intendedProjectFile,
        createFailedSaveResult(reason),
        async () => createSuccessfulLoadResult(reorderKeys(intendedProjectFile)),
      );

      expect(result).toMatchObject({
        confirmation: 'readback',
        savedProject: {
          bytesWritten: 512,
          status: 'SAVED',
        },
        status: 'CONFIRMED',
      });
    },
  );

  it('requires recovery when ambiguous save readback differs', async () => {
    const result = await settleProjectSave(
      intendedProjectFile,
      createFailedSaveResult('offline'),
      async () =>
        createSuccessfulLoadResult({
          ...intendedProjectFile,
          workspace: { project: { name: 'Older Project' } },
        }),
    );

    expect(result).toMatchObject({
      status: 'RECOVERY_REQUIRED',
    });
  });

  it('requires recovery when ambiguous save readback is unavailable', async () => {
    const result = await settleProjectSave(
      intendedProjectFile,
      createFailedSaveResult('timeout'),
      async () => ({
        message: 'Project open timed out.',
        ok: false,
        reason: 'timeout',
      }),
    );

    expect(result).toMatchObject({
      message: expect.stringContaining('Exact readback failed'),
      status: 'RECOVERY_REQUIRED',
    });
  });

  it.each(['unauthorized', 'http-error'] as const)(
    'keeps explicit %s rejection reversible without readback',
    async (reason) => {
      const loadProjectFile = vi.fn<() => Promise<LocalEngineProjectFileLoadResult>>();
      const result = await settleProjectSave(
        intendedProjectFile,
        createFailedSaveResult(reason),
        loadProjectFile,
      );

      expect(result).toMatchObject({ status: 'REJECTED' });
      expect(loadProjectFile).not.toHaveBeenCalled();
    },
  );

});

describe('classifyAudioFileDeletion', () => {
  it('makes confirmed deletion irreversible', () => {
    expect(
      classifyAudioFileDeletion({
        deletedFile: {
          artifactId: 'artifact-a',
          extension: '.wav',
          name: 'artifact-a.wav',
          relativePath: 'renders/instruments/artifact-a.wav',
          sizeBytes: 512,
          status: 'DELETED',
          storageKind: 'generated',
        },
        ok: true,
      }),
    ).toEqual({
      fileDisposition: 'deleted',
      irreversible: true,
    });
  });

  it.each(['offline', 'timeout', 'invalid-response'] as const)(
    'makes an ambiguous %s result irreversible',
    (reason) => {
      expect(
        classifyAudioFileDeletion({
          message: 'The response was lost.',
          ok: false,
          reason,
        }),
      ).toEqual({
        fileDisposition: 'unknown',
        irreversible: true,
        message: 'The response was lost.',
      });
    },
  );

  it.each(['unauthorized', 'http-error'] as const)(
    'keeps an explicit %s rejection reversible',
    (reason) => {
      expect(
        classifyAudioFileDeletion({
          message: 'The Engine rejected deletion.',
          ok: false,
          reason,
        }),
      ).toEqual({
        fileDisposition: 'preserved',
        irreversible: false,
        message: 'The Engine rejected deletion.',
      });
    },
  );

});

describe('transaction outcome helpers', () => {
  it('treats only post-dispatch uncertainty as ambiguous', () => {
    const reasons: readonly LocalEngineHealthFailureReason[] = [
      'canceled',
      'http-error',
      'invalid-response',
      'offline',
      'timeout',
      'unauthorized',
      'version-mismatch',
    ];

    expect(reasons.filter(isAmbiguousSideEffectFailure)).toEqual([
      'invalid-response',
      'offline',
      'timeout',
    ]);
  });

  it('compares JSON values independently of key order and undefined fields', () => {
    expect(
      areJsonValuesEquivalent(
        { a: 1, nested: { b: 2 }, omitted: undefined },
        { nested: { b: 2 }, a: 1 },
      ),
    ).toBe(true);
    expect(areJsonValuesEquivalent({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('reconciles a committed removal without discarding concurrent Project work', () => {
    const artifact = createAudioArtifact();
    const take = createAudioTake(artifact);
    const initialProject = attachAudioTake(artifact, take);
    const concurrentProject = {
      ...initialProject,
      bpm: initialProject.bpm + 7,
    };
    const result = reconcileCommittedClipTakeRemoval(
      concurrentProject,
      'clip-inst-1',
      take.clipTakeId,
    );

    expect(result.canReconcile).toBe(true);

    if (!result.canReconcile) {
      return;
    }

    const clip = result.projectAfterRemoval.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === 'clip-inst-1');
    expect(result.projectAfterRemoval.bpm).toBe(concurrentProject.bpm);
    expect(clip?.clipTakes).toBeUndefined();
    expect(
      result.projectAfterRemoval.artifacts?.some(
        (candidate) => candidate.artifactId === artifact.artifactId,
      ),
    ).toBe(false);
  });
});

function createSuccessfulSaveResult(): LocalEngineProjectFileSaveResult {
  return {
    ok: true,
    savedProject: {
      bytesWritten: 512,
      lastModifiedAt: '2026-08-08T06:00:01.000Z',
      projectFileName: 'Deletion Safety.humstudio.json',
      projectFilePath: 'D:\\Projects\\Deletion Safety.humstudio.json',
      savedAt: intendedProjectFile.savedAt,
      status: 'SAVED',
    },
  };
}

function createFailedSaveResult(
  reason: LocalEngineHealthFailureReason,
): LocalEngineProjectFileSaveResult {
  return {
    message: `Project save failed: ${reason}.`,
    ok: false,
    reason,
  };
}

function createSuccessfulLoadResult(
  projectFile: Readonly<Record<string, unknown>>,
): LocalEngineProjectFileLoadResult {
  return {
    loadedProject: {
      bytesRead: 512,
      lastModifiedAt: '2026-08-08T06:00:01.000Z',
      projectFile,
      projectFileName: 'Deletion Safety.humstudio.json',
      projectFilePath: 'D:\\Projects\\Deletion Safety.humstudio.json',
      savedAt: intendedProjectFile.savedAt,
      status: 'LOADED',
    },
    ok: true,
  };
}

function reorderKeys(
  projectFile: typeof intendedProjectFile,
): Readonly<Record<string, unknown>> {
  return {
    workspace: projectFile.workspace,
    version: projectFile.version,
    savedAt: projectFile.savedAt,
    app: projectFile.app,
  };
}

function attachAudioTake(
  artifact: GeneratedAudioArtifact,
  take: GeneratedAudioClipTake,
) {
  const project = structuredClone(sampleProject);
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === 'clip-inst-1');

  if (!clip) {
    throw new Error('Expected the sample instrument Clip.');
  }

  project.artifacts = [artifact];
  clip.clipTakes = [take];
  clip.activeClipTakeId = take.clipTakeId;
  clip.sourceFile = {
    checkedAt: artifact.createdAt,
    durationSeconds: artifact.audio.durationSeconds,
    mimeType: artifact.audio.mimeType,
    name: artifact.file.name,
    relativePath: artifact.file.relativePath,
    sizeBytes: artifact.file.sizeBytes,
    sourceId: artifact.artifactId,
    status: 'available',
  };
  return project;
}

function createAudioArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-deletion-transaction-test',
    audio: {
      channels: 2,
      durationSeconds: 1,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-08T06:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-deletion-transaction-test.wav',
      relativePath:
        'renders/instruments/artifact-deletion-transaction-test.wav',
      sizeBytes: 192_044,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'mock-v1',
      modelRevision: '1',
      parameters: {},
      providerId: 'mock-provider',
      taskId: 'midi-to-audio',
    },
    sourceJobId: 'job-deletion-transaction-test',
  };
}

function createAudioTake(
  artifact: GeneratedAudioArtifact,
): GeneratedAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-deletion-transaction-test',
    createdAt: artifact.createdAt,
    label: 'Deletion Transaction Test Take',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
}
