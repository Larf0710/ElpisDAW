import { describe, expect, it, vi } from 'vitest';

import type { FinalFilerDownloadFile } from './finalFilerBrowserDownload';
import {
  FinalFilerController,
  resolveFinalFilerAvailability,
  resolveFinalFilerFileName,
} from './finalFilerController';
import {
  FINAL_FILER_TEST_MASTER_CLIP_ID,
  FINAL_FILER_TEST_RAW_ARTIFACT_ID,
  FINAL_FILER_TEST_RAW_CLIP_ID,
  createFinalFilerTestProject,
  createFinalFilerTestWav,
  findFinalFilerTestClip,
} from './finalFilerTestFixture';
import { createProjectDirtyStateFingerprint } from './projectDirtyStateFingerprint';
import type { LocalEngineGeneratedAudioDescriptor } from './localEngineClient';

const operationId = 'final-filer:11111111-1111-4111-8111-111111111111';
const runDefaults = {
  buildIdentity: { gitCommit: 'ce09e2f', version: '0.1.0' },
  exportedAtUtc: '2026-08-16T12:34:56.000Z',
  fileName: 'HumStudio-delivery.wav',
  includeSourceReport: true,
};

describe('FinalFilerController', () => {
  it.each([
    ['Raw Mix', 'raw', FINAL_FILER_TEST_RAW_CLIP_ID],
    ['Stable Audio 3 Master', 'master', FINAL_FILER_TEST_MASTER_CLIP_ID],
  ] as const)('downloads a canonical %s WAV plus Source Report without Project mutation', async (
    _label,
    selected,
    selectedClipId,
  ) => {
    const project = createFinalFilerTestProject(selected);
    const before = structuredClone(project);
    const fingerprint = createProjectDirtyStateFingerprint(project);
    const downloadFiles = vi.fn((_files: readonly FinalFilerDownloadFile[]) => undefined);
    const readGeneratedAudio = vi.fn(async (
      _descriptor: LocalEngineGeneratedAudioDescriptor,
      _signal: AbortSignal,
    ) => ({
      ok: true as const,
      wav: createFinalFilerTestWav(),
    }));
    const controller = createController({ downloadFiles });

    const result = await controller.run({
      ...runDefaults,
      getProject: () => project,
      readGeneratedAudio,
    });

    expect(result).toMatchObject({
      downloadCount: 2,
      message: 'EXPORT COMPLETE',
      operationId,
      status: 'success',
    });
    expect(readGeneratedAudio).toHaveBeenCalledOnce();
    expect(readGeneratedAudio.mock.calls[0][0]).toMatchObject({
      kind: 'generated',
      sizeBytes: 176_444,
    });
    expect(readGeneratedAudio.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(downloadFiles).toHaveBeenCalledOnce();
    expect(downloadFiles.mock.calls[0][0]).toHaveLength(2);
    expect(downloadFiles.mock.calls[0][0].map((file: FinalFilerDownloadFile) => file.kind)).toEqual([
      'wav',
      'source-report',
    ]);
    expect(controller.isBusy).toBe(false);
    expect(project).toEqual(before);
    expect(createProjectDirtyStateFingerprint(project)).toBe(fingerprint);
    expect(project.selection.items[0]?.id).toBe(selectedClipId);
  });

  it('downloads exactly one WAV when Include Source Report is Off', async () => {
    const project = createFinalFilerTestProject();
    const downloadFiles = vi.fn();
    const createSourceReport = vi.fn();
    const controller = createController({ createSourceReport, downloadFiles });
    const result = await controller.run({
      ...runDefaults,
      getProject: () => project,
      includeSourceReport: false,
      readGeneratedAudio: async () => ({
        ok: true,
        wav: createFinalFilerTestWav(),
      }),
    });

    expect(result).toMatchObject({ downloadCount: 1, status: 'success' });
    expect(createSourceReport).not.toHaveBeenCalled();
    expect(downloadFiles.mock.calls[0][0]).toHaveLength(1);
    expect(downloadFiles.mock.calls[0][0][0]).toMatchObject({
      fileName: 'HumStudio-delivery.wav',
      kind: 'wav',
    });
  });

  it('presents browser adapter failure without leaking raw detail or mutating Project', async () => {
    const project = createFinalFilerTestProject();
    const before = structuredClone(project);
    const controller = createController({
      downloadFiles: () => {
        throw new Error('C:\\Users\\private\\download blocked');
      },
    });
    const result = await controller.run({
      ...runDefaults,
      getProject: () => project,
      includeSourceReport: false,
      readGeneratedAudio: async () => ({
        ok: true,
        wav: createFinalFilerTestWav(),
      }),
    });

    expect(result).toMatchObject({
      detail: 'FINAL FILER could not prepare all requested delivery files.',
      downloadCount: 0,
      message: 'EXPORT FAILED',
      status: 'failed',
    });
    expect(result.detail).not.toContain('private');
    expect(project).toEqual(before);
  });

  it.each([
    ['empty selection', () => ({ items: [] })],
    [
      'multiple selection',
      () => ({
        items: [
          { id: FINAL_FILER_TEST_RAW_CLIP_ID, type: 'clip' as const },
          { id: FINAL_FILER_TEST_MASTER_CLIP_ID, type: 'clip' as const },
        ],
      }),
    ],
    ['Track selection', () => ({ items: [{ id: 'track-raw-mix', type: 'track' as const }] })],
    ['stale selection', () => ({ items: [{ id: 'missing', type: 'clip' as const }] })],
  ] as const)('blocks %s before read or download', async (_label, createSelection) => {
    const project = createFinalFilerTestProject();
    project.selection = createSelection();
    const readGeneratedAudio = vi.fn();
    const downloadFiles = vi.fn();
    const controller = createController({ downloadFiles });

    await expect(
      controller.run({
        ...runDefaults,
        getProject: () => project,
        readGeneratedAudio,
      }),
    ).resolves.toMatchObject({ downloadCount: 0, status: 'blocked' });
    expect(readGeneratedAudio).not.toHaveBeenCalled();
    expect(downloadFiles).not.toHaveBeenCalled();
  });

  it('prevents duplicate execution and cancellation aborts the exact read with zero downloads', async () => {
    const project = createFinalFilerTestProject();
    const downloadFiles = vi.fn();
    let observedSignal: AbortSignal | undefined;
    const controller = createController({ downloadFiles });
    const first = controller.run({
      ...runDefaults,
      getProject: () => project,
      readGeneratedAudio: (_descriptor, signal) =>
        new Promise((resolve) => {
          observedSignal = signal;
          signal.addEventListener(
            'abort',
            () =>
              resolve({
                message: 'Canceled.',
                ok: false,
                reason: 'canceled',
              }),
            { once: true },
          );
        }),
    });

    expect(controller.isBusy).toBe(true);
    expect(controller.activeSnapshot).toMatchObject({
      fileName: 'HumStudio-delivery.wav',
      operationId,
      selectedClipId: FINAL_FILER_TEST_RAW_CLIP_ID,
    });
    expect(Object.isFrozen(controller.activeSnapshot)).toBe(true);
    await expect(
      controller.run({
        ...runDefaults,
        getProject: () => project,
        readGeneratedAudio: vi.fn(),
      }),
    ).resolves.toMatchObject({ message: 'EXPORT BUSY', status: 'busy' });

    expect(controller.cancel()).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    await expect(first).resolves.toMatchObject({
      downloadCount: 0,
      message: 'EXPORT CANCELED',
      status: 'canceled',
    });
    expect(downloadFiles).not.toHaveBeenCalled();
    expect(controller.isBusy).toBe(false);
  });

  it('causes zero downloads for read, report, and post-read Project failures', async () => {
    const readProject = createFinalFilerTestProject();
    const readDownloads = vi.fn();
    await expect(
      createController({ downloadFiles: readDownloads }).run({
        ...runDefaults,
        getProject: () => readProject,
        readGeneratedAudio: async () => ({
          message: 'C:\\Users\\private\\engine-error',
          ok: false,
          reason: 'offline',
        }),
      }),
    ).resolves.toMatchObject({
      detail: 'FINAL FILER could not read the registered WAV.',
      downloadCount: 0,
      status: 'failed',
    });
    expect(readDownloads).not.toHaveBeenCalled();

    const reportProject = createFinalFilerTestProject();
    const reportDownloads = vi.fn();
    await expect(
      createController({
        createSourceReport: async () => {
          throw new Error('Report failed.');
        },
        downloadFiles: reportDownloads,
      }).run({
        ...runDefaults,
        getProject: () => reportProject,
        readGeneratedAudio: async () => ({
          ok: true,
          wav: createFinalFilerTestWav(),
        }),
      }),
    ).resolves.toMatchObject({ downloadCount: 0, status: 'failed' });
    expect(reportDownloads).not.toHaveBeenCalled();

    const changedProject = createFinalFilerTestProject();
    const changedDownloads = vi.fn();
    await expect(
      createController({
        downloadFiles: changedDownloads,
        hashWav: async () => {
          changedProject.name = 'Changed after read';
          return 'a'.repeat(64);
        },
      }).run({
        ...runDefaults,
        getProject: () => changedProject,
        includeSourceReport: false,
        readGeneratedAudio: async () => ({
          ok: true,
          wav: createFinalFilerTestWav(),
        }),
      }),
    ).resolves.toMatchObject({ downloadCount: 0, status: 'interrupted' });
    expect(changedDownloads).not.toHaveBeenCalled();
  });

  it('revalidates before Engine read and before browser download when selection changes', async () => {
    const beforeReadProject = createFinalFilerTestProject();
    const changedBeforeRead = structuredClone(beforeReadProject);
    changedBeforeRead.selection = {
      items: [{ id: FINAL_FILER_TEST_MASTER_CLIP_ID, type: 'clip' }],
    };
    let projectReadCount = 0;
    const beforeRead = vi.fn();
    const beforeReadDownloads = vi.fn();

    await expect(
      createController({ downloadFiles: beforeReadDownloads }).run({
        ...runDefaults,
        getProject: () =>
          projectReadCount++ === 0 ? beforeReadProject : changedBeforeRead,
        readGeneratedAudio: beforeRead,
      }),
    ).resolves.toMatchObject({ downloadCount: 0, status: 'interrupted' });
    expect(beforeRead).not.toHaveBeenCalled();
    expect(beforeReadDownloads).not.toHaveBeenCalled();

    const afterReadProject = createFinalFilerTestProject();
    const afterReadDownloads = vi.fn();
    await expect(
      createController({
        downloadFiles: afterReadDownloads,
        hashWav: async () => {
          afterReadProject.selection = {
            items: [{ id: FINAL_FILER_TEST_MASTER_CLIP_ID, type: 'clip' }],
          };
          return 'b'.repeat(64);
        },
      }).run({
        ...runDefaults,
        getProject: () => afterReadProject,
        includeSourceReport: false,
        readGeneratedAudio: async () => ({
          ok: true,
          wav: createFinalFilerTestWav(),
        }),
      }),
    ).resolves.toMatchObject({ downloadCount: 0, status: 'interrupted' });
    expect(afterReadDownloads).not.toHaveBeenCalled();
  });

  it('fails closed when Active Take, Artifact, selection, or project fingerprint is stale', async () => {
    const project = createFinalFilerTestProject();
    const before = structuredClone(project);
    const downloadFiles = vi.fn();
    findFinalFilerTestClip(project, FINAL_FILER_TEST_RAW_CLIP_ID).activeClipTakeId =
      'stale-take';

    await expect(
      createController({ downloadFiles }).run({
        ...runDefaults,
        getProject: () => project,
        readGeneratedAudio: vi.fn(),
      }),
    ).resolves.toMatchObject({ status: 'blocked' });
    expect(downloadFiles).not.toHaveBeenCalled();
    expect(project.artifacts).toEqual(before.artifacts);

    const collision = createFinalFilerTestProject();
    collision.artifacts?.push(structuredClone(collision.artifacts[0]));
    expect(resolveFinalFilerAvailability(collision)).toMatchObject({ canExport: false });

    const forged = createFinalFilerTestProject();
    const artifact = forged.artifacts?.find(
      (candidate) => candidate.artifactId === FINAL_FILER_TEST_RAW_ARTIFACT_ID,
    );
    if (artifact?.kind === 'audio') {
      artifact.file.relativePath = 'mixdowns/forged.wav';
    }
    expect(resolveFinalFilerAvailability(forged)).toMatchObject({ canExport: false });
  });
});

describe('resolveFinalFilerAvailability guidance', () => {
  it('routes an empty selection to Mixer MIXDOWN', () => {
    const project = createFinalFilerTestProject();
    project.selection = { items: [] };

    expect(resolveFinalFilerAvailability(project)).toEqual({
      canExport: false,
      message: 'Select one registered Raw Mixdown or Stable Audio 3 Master Clip. If none exists, create MIXDOWN in Mixer first.',
    });
  });

  it('explains that a non-final generated Clip needs a Raw Mixdown first', () => {
    const project = createFinalFilerTestProject();
    findFinalFilerTestClip(project, FINAL_FILER_TEST_RAW_CLIP_ID).type = 'vocal-audio';

    expect(resolveFinalFilerAvailability(project)).toMatchObject({
      canExport: false,
      message: expect.stringContaining(
        'Create MIXDOWN in Mixer first, then select its Raw Mixdown Clip.',
      ),
    });
  });
});

describe('resolveFinalFilerFileName', () => {
  it('preserves an edited safe .wav name exactly', () => {
    expect(resolveFinalFilerFileName('My Final Mix v2.wav')).toEqual({
      fileName: 'My Final Mix v2.wav',
      valid: true,
    });
  });

  it.each([
    '',
    ' delivery.wav',
    'delivery.wav ',
    'delivery',
    'delivery.WAV',
    '../delivery.wav',
    'folder/delivery.wav',
    'folder\\delivery.wav',
    'CON.wav',
    'LPT1.final.wav',
    'bad\u0000name.wav',
    `${'x'.repeat(177)}.wav`,
  ])('rejects unsafe browser delivery name %j', (fileName) => {
    expect(resolveFinalFilerFileName(fileName)).toMatchObject({ valid: false });
  });
});

function createController(
  options: ConstructorParameters<typeof FinalFilerController>[0] = {},
): FinalFilerController {
  return new FinalFilerController({
    createOperationId: () => operationId,
    ...options,
  });
}
