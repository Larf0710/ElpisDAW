import { describe, expect, it } from 'vitest';

import {
  prepareAceStepCoverRun,
  resolveAceStepCoverSettings,
} from './aceStepCoverPatchTab';
import {
  createAceStepCoverProject,
  createConfiguredAceStepCoverPatchTab,
} from './aceStepCoverTestFixture';

describe('ACE-Step Cover PatchTab', () => {
  it('exposes v0.1 basic controls and resolves one full Active Audio Take', () => {
    const patchTab = createConfiguredAceStepCoverPatchTab();
    const project = createAceStepCoverProject(patchTab);
    const resolution = resolveAceStepCoverSettings(project, patchTab, 'clip-source');

    expect(patchTab.parameters.map(({ id }) => id)).toEqual([
      'prompt',
      'mode',
      'lyrics',
      'language',
      'coverStrength',
      'seed',
      'takes',
    ]);
    expect(patchTab.parameters.some(({ id }) => id === 'advanced')).toBe(false);
    expect(resolution).toMatchObject({
      canResolve: true,
      settings: {
        coverStrength: 0.2,
        source: {
          artifactId: 'artifact-source',
          clipTakeId: 'clip-take-source',
          durationSeconds: 12,
        },
      },
    });
  });

  it('creates one immutable output identity with sequential Seeds and exact source lineage', () => {
    const patchTab = createConfiguredAceStepCoverPatchTab();
    const project = createAceStepCoverProject(patchTab);
    const preparation = prepareAceStepCoverRun(project, patchTab, 'clip-source', {
      createdAt: '2026-08-31T00:00:00.000Z',
      lyricsArtifactId: 'artifact-lyrics',
      lyricsRelativePath: 'renders/ace-step/lyrics/artifact-lyrics.txt',
      requestToken: 'ace-cover-1',
    });

    expect(preparation.canPrepare).toBe(true);
    if (!preparation.canPrepare) return;

    expect(preparation.plans).toHaveLength(2);
    expect(preparation.plans.map((plan) => plan.request.parameters.seed)).toEqual([42, 43]);
    expect(preparation.plans.map((plan) => plan.request.parameters.sampleRate)).toEqual([48_000, 48_000]);
    expect(new Set(preparation.plans.map((plan) => plan.output.output.clipId)).size).toBe(1);
    expect(preparation.plans[0].request.lineage).toEqual({
      parentArtifactIds: ['artifact-source', 'artifact-lyrics'],
      parentClipTakeIds: ['clip-take-source'],
    });
    expect(preparation.plans[0].output.output).toMatchObject({
      lengthTicks: 23_040,
      startTick: 3_840,
    });
  });

  it('blocks trimmed sources in v0.1 before enqueue', () => {
    const patchTab = createConfiguredAceStepCoverPatchTab();
    const project = createAceStepCoverProject(patchTab);
    const trimmed = {
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({
          ...clip,
          audioTiming: {
            sourceEndSeconds: 10,
            sourceStartSeconds: 2,
            timeBase: 'absolute-seconds' as const,
          },
          lengthTicks: 15_360,
        })),
      })),
    };

    expect(resolveAceStepCoverSettings(trimmed, patchTab, 'clip-source')).toMatchObject({
      canResolve: false,
      cause: 'ace-step-cover-source-trimmed',
    });
  });
});
