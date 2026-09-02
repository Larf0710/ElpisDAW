import { describe, expect, it } from 'vitest';

import {
  createAceStepTextToMusicPatchTabTemplate,
  prepareAceStepTextToMusicRun,
  resolveAceStepTextToMusicSettings,
} from './aceStepTextToMusicPatchTab';
import { createEmptyProject } from './emptyProject';

describe('ACE-Step Text to Music PatchTab', () => {
  it('exposes only the v0.1 basic controls and resolves Project Tempo and Key', () => {
    const patchTab = configuredPatchTab();
    const project = { ...createEmptyProject(), bpm: 120, key: 'C major' };
    const resolution = resolveAceStepTextToMusicSettings(project, patchTab);

    expect(patchTab.parameters.map(({ id }) => id)).toEqual([
      'prompt',
      'mode',
      'lyrics',
      'language',
      'bars',
      'generationPosition',
      'seed',
      'takes',
    ]);
    expect(patchTab.parameters.some(({ id }) => id === 'advanced')).toBe(false);
    expect(resolution).toMatchObject({
      canResolve: true,
      settings: {
        bpm: 120,
        durationSeconds: 16,
        instrumental: false,
        keyscale: 'C major',
        vocalLanguage: 'ja',
      },
    });
  });

  it('creates multiple 48 kHz plans with sequential Seeds and one output identity', () => {
    const patchTab = configuredPatchTab();
    const project = {
      ...createEmptyProject(),
      bpm: 120,
      key: 'C major',
      patchTabs: [patchTab],
    };
    const preparation = prepareAceStepTextToMusicRun(project, patchTab, {
      createdAt: '2026-08-31T00:00:00.000Z',
      lyricsArtifactId: 'artifact-12345678-1234-4123-8123-123456789abc',
      lyricsRelativePath:
        'renders/ace-step/lyrics/artifact-12345678-1234-4123-8123-123456789abc.txt',
      requestToken: 'ace-t2m-1',
    });

    expect(preparation.canPrepare).toBe(true);
    if (!preparation.canPrepare) return;

    expect(preparation.plans).toHaveLength(2);
    expect(preparation.plans.map((plan) => plan.request.parameters.seed)).toEqual([42, 43]);
    expect(preparation.plans.map((plan) => plan.request.parameters.sampleRate)).toEqual([48_000, 48_000]);
    expect(
      new Set(
        preparation.plans.map(
          (plan) => plan.output.generationRegion.output.clipId,
        ),
      ).size,
    ).toBe(1);
  });

  it('requires Lyrics for Vocals mode and accepts the Instrumental snapshot marker', () => {
    const patchTab = configuredPatchTab();
    const lyrics = patchTab.parameters.find((parameter) => parameter.id === 'lyrics');
    if (lyrics?.kind !== 'text') throw new Error('Lyrics fixture missing.');
    const withoutLyrics = {
      ...patchTab,
      parameters: patchTab.parameters.map((parameter) =>
        parameter.id === 'lyrics' ? { ...lyrics, value: '' } : parameter,
      ),
    };
    const project = { ...createEmptyProject(), bpm: 120, key: 'C major' };

    expect(resolveAceStepTextToMusicSettings(project, withoutLyrics)).toMatchObject({
      canResolve: false,
      cause: 'ace-step-t2m-lyrics-empty',
    });

    const instrumental = {
      ...withoutLyrics,
      parameters: withoutLyrics.parameters.map((parameter) =>
        parameter.id === 'mode' && parameter.kind === 'select'
          ? { ...parameter, value: 'Instrumental' }
          : parameter,
      ),
    };
    expect(resolveAceStepTextToMusicSettings(project, instrumental)).toMatchObject({
      canResolve: true,
      settings: { lyricsSnapshotText: '[Instrumental]' },
    });
  });
});

function configuredPatchTab() {
  const patchTab = createAceStepTextToMusicPatchTabTemplate();
  return {
    ...patchTab,
    id: 'ace-t2m-test',
    parameters: patchTab.parameters.map((parameter) => {
      if (parameter.id === 'prompt' && parameter.kind === 'text') {
        return { ...parameter, value: 'Dreamy synth pop with a wide chorus' };
      }
      if (parameter.id === 'mode' && parameter.kind === 'select') {
        return { ...parameter, value: 'Vocals' };
      }
      if (parameter.id === 'lyrics' && parameter.kind === 'text') {
        return { ...parameter, value: '[Verse]\nA quiet light' };
      }
      if (parameter.id === 'language' && parameter.kind === 'select') {
        return { ...parameter, value: 'Japanese' };
      }
      if (parameter.id === 'takes' && parameter.kind === 'number') {
        return { ...parameter, value: 2 };
      }
      return parameter;
    }),
  };
}
