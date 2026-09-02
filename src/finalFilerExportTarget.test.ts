import { describe, expect, it } from 'vitest';

import { resolveClipFilerFinalExportTarget } from './clipFilerFinalExportTarget';
import { resolveFinalFilerExportTarget } from './finalFilerExportTarget';
import {
  FINAL_FILER_TEST_MASTER_CLIP_ID,
  FINAL_FILER_TEST_RAW_ARTIFACT_ID,
  FINAL_FILER_TEST_RAW_CLIP_ID,
  createFinalFilerTestProject,
  findFinalFilerTestClip,
} from './finalFilerTestFixture';
import type { PatchTab, ProjectState } from './types';

describe('resolveFinalFilerExportTarget', () => {
  it.each([
    ['Raw Mix', 'raw', FINAL_FILER_TEST_RAW_CLIP_ID, 'raw-mixdown'],
    [
      'Stable Audio 3 Master',
      'master',
      FINAL_FILER_TEST_MASTER_CLIP_ID,
      'stable-audio-3-master',
    ],
  ] as const)(
    'accepts one canonical registered %s without a PatchTab',
    (_label, selected, clipId, kind) => {
      const project = createFinalFilerTestProject(selected);
      const result = resolveFinalFilerExportTarget(project, clipId);

      expect(result).toMatchObject({
        canExport: true,
        exportTarget: {
          descriptor: { kind: 'generated', sizeBytes: 176_444 },
          format: 'WAV',
          target: { kind },
        },
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.canExport ? result.exportTarget : undefined)).toBe(true);
    },
  );

  it.each([
    ['PRINT MIX', 'print-mix'],
    ['Stem Print', 'stem-print'],
    ['Instrument Audio', 'instrument'],
    ['arbitrary WAV', 'export'],
  ] as const)('rejects %s artifacts even when their file resembles WAV', (_label, destination) => {
    const project = createFinalFilerTestProject();
    const artifact = project.artifacts?.find(
      (candidate) => candidate.artifactId === FINAL_FILER_TEST_RAW_ARTIFACT_ID,
    );

    if (!artifact || artifact.kind !== 'audio') {
      throw new Error('Missing test Artifact.');
    }

    Object.assign(artifact, { destination });

    expect(
      resolveFinalFilerExportTarget(project, FINAL_FILER_TEST_RAW_CLIP_ID),
    ).toMatchObject({ canExport: false, cause: 'source-artifact-invalid' });
  });

  it('rejects forged, duplicate, and stale identities fail-closed', () => {
    const forged = createFinalFilerTestProject();
    forged.artifacts?.push(structuredClone(forged.artifacts[0]));
    expect(
      resolveFinalFilerExportTarget(forged, FINAL_FILER_TEST_RAW_CLIP_ID),
    ).toMatchObject({ canExport: false });

    const stale = createFinalFilerTestProject();
    findFinalFilerTestClip(stale, FINAL_FILER_TEST_RAW_CLIP_ID).activeClipTakeId =
      'stale-take';
    expectFailure(stale, 'active-take-unavailable');

    const changedFile = createFinalFilerTestProject();
    findFinalFilerTestClip(
      changedFile,
      FINAL_FILER_TEST_RAW_CLIP_ID,
    ).sourceFile!.relativePath = 'renders/arbitrary.wav';
    expectFailure(changedFile, 'source-artifact-invalid');
  });

  it('preserves the historical Clip Filer settings gate and original identity', () => {
    const project = createFinalFilerTestProject();
    const legacyClipFiler = createHistoricalClipFiler('MP3');

    expect(
      resolveClipFilerFinalExportTarget(
        project,
        legacyClipFiler,
        FINAL_FILER_TEST_RAW_CLIP_ID,
      ),
    ).toMatchObject({
      canExport: false,
      cause: 'clip-filer-settings-invalid',
    });
    expect(legacyClipFiler.nodeTypeId).toBe('humstudio.patch.clip-filer');
    expect(legacyClipFiler.name).toBe('Clip Filer');
  });
});

function expectFailure(
  project: ProjectState,
  cause: 'active-take-unavailable' | 'identity-conflict' | 'source-artifact-invalid',
): void {
  expect(
    resolveFinalFilerExportTarget(project, FINAL_FILER_TEST_RAW_CLIP_ID),
  ).toMatchObject({ canExport: false, cause });
}

function createHistoricalClipFiler(format: 'MP3' | 'WAV'): PatchTab {
  return {
    colorIndex: 4,
    description: 'Historical production output settings.',
    id: 'historical-clip-filer',
    inputType: 'Selected Clip',
    name: 'Clip Filer',
    nodeTypeId: 'humstudio.patch.clip-filer',
    outputType: 'Export File',
    parameters: [
      {
        id: 'format',
        kind: 'select',
        label: 'Format',
        options: ['WAV', 'MP3', 'MIDI'],
        value: format,
      },
      {
        id: 'normalize',
        kind: 'select',
        label: 'Normalize',
        options: ['On', 'Off'],
        value: 'Off',
      },
    ],
    status: 'ready',
  };
}
