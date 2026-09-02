import { describe, expect, it } from 'vitest';

import { sampleProject } from './sampleProject';
import { createStableAudio3T2APatchTabTemplate } from './stableAudio3PatchTab';
import {
  applyStableAudio3TextToAudioManagedPrompt,
  prepareStableAudio3TextToAudioPatchTabRun,
  resolveStableAudio3TextToAudioPatchTabSettings,
} from './stableAudio3TextToAudioPatchTab';
import type { PatchTab, ProjectState } from './types';

describe('Stable Audio 3 T2A PatchTab execution boundary', () => {
  it('refreshes duplicate managed context and derives read-only Duration from Bars', () => {
    const patchTab = updateParameter(
      createStableAudio3T2APatchTabTemplate(),
      'prompt',
      'Warm analog synths\n[Timeline Context] old\n[Timeline Context] duplicate',
    );
    const project = createProject(patchTab);
    const result = resolveStableAudio3TextToAudioPatchTabSettings(
      project,
      patchTab,
    );

    expect(result).toMatchObject({
      canResolve: true,
      settings: {
        bars: 4,
        durationSeconds: 8,
        generationPosition: 'playhead',
        maxBars: 190,
        prompt: 'Warm analog synths',
        seed: 0,
        timelineContext:
          '[Timeline Context] Tempo: 120 BPM | Bars: 4 | Key: C major',
      },
    });
    if (result.canResolve) {
      expect(result.settings.managedPrompt).toBe(
        'Warm analog synths\n[Timeline Context] Tempo: 120 BPM | Bars: 4 | Key: C major',
      );
    }
  });

  it('fails closed when a Tempo change makes Bars exceed the current limit', () => {
    const patchTab = updateParameter(
      createStableAudio3T2APatchTabTemplate(),
      'bars',
      100,
    );
    const result = resolveStableAudio3TextToAudioPatchTabSettings(
      createProject(patchTab, { bpm: 60 }),
      patchTab,
    );

    expect(result).toMatchObject({
      canResolve: false,
      cause: 'stable-audio-3-t2a-bars-out-of-range',
    });
    expect(
      patchTab.parameters.find((parameter) => parameter.id === 'bars'),
    ).toMatchObject({ value: 100 });
  });

  it('prepares one exact source-free Job with reserved Generated Audio identities', () => {
    const patchTab = createStableAudio3T2APatchTabTemplate();
    const result = prepareStableAudio3TextToAudioPatchTabRun(
      createProject(patchTab),
      patchTab,
      {
        createdAt: '2026-08-06T01:00:00.000Z',
        requestToken: 'test-run-1',
      },
    );

    expect(result).toMatchObject({
      canPrepare: true,
      plan: {
        output: {
          generationRegion: {
            outputTarget: {
              kind: 'new-track',
              trackId: 'sa3-t2a-track-test-run-1',
              trackName: 'Generated Audio',
            },
            region: {
              regionId: 'sa3-t2a-clip-test-run-1',
              name: 'Generated Audio',
            },
          },
        },
        request: {
          inputArtifacts: [],
          lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
          taskId: 'text-to-audio',
        },
      },
    });
  });

  it('applies managed Prompt only when the source parameters are unchanged', () => {
    const patchTab = createStableAudio3T2APatchTabTemplate();
    const project = createProject(patchTab);
    const preparation = prepareStableAudio3TextToAudioPatchTabRun(
      project,
      patchTab,
      {
        createdAt: '2026-08-06T01:00:00.000Z',
        requestToken: 'test-run-2',
      },
    );

    expect(preparation.canPrepare).toBe(true);
    if (!preparation.canPrepare) {
      return;
    }

    const applied = applyStableAudio3TextToAudioManagedPrompt(
      project,
      patchTab.id,
      preparation.sourceParameterFingerprint,
      preparation.managedPrompt,
    );
    expect(applied).toMatchObject({ applied: true });
    if (applied.applied) {
      expect(
        applied.project.patchTabs[0].parameters.find(
          (parameter) => parameter.id === 'prompt',
        ),
      ).toMatchObject({ value: preparation.managedPrompt });
    }

    const staleProject = createProject(
      updateParameter(patchTab, 'seed', 99),
    );
    expect(
      applyStableAudio3TextToAudioManagedPrompt(
        staleProject,
        patchTab.id,
        preparation.sourceParameterFingerprint,
        preparation.managedPrompt,
      ),
    ).toMatchObject({
      applied: false,
      cause: 'stable-audio-3-t2a-parameters-stale',
    });
  });

  it('appends only Seed-only variations to the tracked output Clip', () => {
    const basePatchTab = createStableAudio3T2APatchTabTemplate();
    const baseProject = createProject(basePatchTab);
    const first = prepareStableAudio3TextToAudioPatchTabRun(
      baseProject,
      basePatchTab,
      {
        createdAt: '2026-08-06T01:00:00.000Z',
        requestToken: 'continuation-first',
      },
    );

    if (!first.canPrepare) {
      throw new Error(first.message);
    }

    const trackedPatchTab = updateParameter(
      updateParameter(
        {
          ...basePatchTab,
          generationContinuation: {
            kind: 'stable-audio-3-text-to-audio',
            outputClipId: 'clip-tracked',
            recipeFingerprint: first.recipeFingerprint,
          },
        },
        'seed',
        1,
      ),
      'takes',
      2,
    );
    const trackedProject = createTrackedProject(trackedPatchTab, 0);
    const append = prepareStableAudio3TextToAudioPatchTabRun(
      trackedProject,
      trackedPatchTab,
      {
        createdAt: '2026-08-06T01:01:00.000Z',
        requestToken: 'continuation-append',
      },
    );

    expect(append).toMatchObject({
      canPrepare: true,
      seedSequence: [1, 2],
      target: { kind: 'append', outputClipId: 'clip-tracked' },
    });

    const changedPrompt = updateParameter(
      trackedPatchTab,
      'prompt',
      'A different musical recipe',
    );
    expect(
      prepareStableAudio3TextToAudioPatchTabRun(
        { ...trackedProject, patchTabs: [changedPrompt] },
        changedPrompt,
        {
          createdAt: '2026-08-06T01:02:00.000Z',
          requestToken: 'continuation-changed',
        },
      ),
    ).toMatchObject({ canPrepare: true, target: { kind: 'new' } });

    const duplicateSeed = updateParameter(trackedPatchTab, 'seed', 0);
    expect(
      prepareStableAudio3TextToAudioPatchTabRun(
        { ...trackedProject, patchTabs: [duplicateSeed] },
        duplicateSeed,
        {
          createdAt: '2026-08-06T01:03:00.000Z',
          requestToken: 'continuation-duplicate',
        },
      ),
    ).toMatchObject({
      canPrepare: false,
      cause: 'stable-audio-3-t2a-seed-duplicate',
    });
  });
});

function createTrackedProject(
  patchTab: PatchTab,
  seed: number,
): ProjectState {
  return createProject(patchTab, {
    artifacts: [
      {
        artifactId: 'artifact-tracked',
        audio: {
          channels: 2,
          durationSeconds: 8,
          mimeType: 'audio/wav',
        },
        createdAt: '2026-08-06T01:00:10.000Z',
        destination: 'stable-audio-3',
        file: {
          extension: '.wav',
          name: 'artifact-tracked.wav',
          relativePath: 'renders/stable-audio-3/artifact-tracked.wav',
          sizeBytes: 1000,
        },
        kind: 'audio',
        lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
        provenance: {
          modelId: 'stable-audio-3-medium',
          modelRevision:
            '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
          parameters: { seed },
          providerId: 'local-stable-audio-3',
          seed,
          taskId: 'text-to-audio',
        },
        sourceJobId: 'job-tracked',
      },
    ],
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: 'clip-take-tracked',
            clipTakes: [
              {
                artifactId: 'artifact-tracked',
                clipTakeId: 'clip-take-tracked',
                createdAt: '2026-08-06T01:00:10.000Z',
                label: 'SA3 T2A Take 01',
                mediaType: 'audio',
                sourceJobId: 'job-tracked',
                sourceType: 'job',
              },
            ],
            color: '#44aaff',
            createdAt: '2026-08-06T01:00:00.000Z',
            id: 'clip-tracked',
            lengthTicks: 3840,
            name: 'Generated Audio',
            startTick: 0,
            type: 'ai-fill-audio',
            version: 2,
          },
        ],
        id: 'track-tracked',
        level: -6,
        name: 'Generated Audio',
        type: 'generated_audio',
      },
    ],
  });
}

function createProject(
  patchTab: PatchTab,
  overrides: Partial<ProjectState> = {},
): ProjectState {
  return {
    ...sampleProject,
    artifacts: [],
    bpm: 120,
    key: 'C major',
    patchTabs: [patchTab],
    playheadTick: 0,
    tabFlowLines: [],
    tracks: [],
    ...overrides,
  };
}

function updateParameter(
  patchTab: PatchTab,
  parameterId: string,
  value: number | string,
): PatchTab {
  return {
    ...patchTab,
    parameters: patchTab.parameters.map((parameter) =>
      parameter.id === parameterId ? { ...parameter, value } as typeof parameter : parameter,
    ),
  };
}
