import { describe, expect, it } from 'vitest';

import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import {
  createAceStepTextToMusicPatchTabTemplate,
  prepareAceStepTextToMusicRun,
  type AceStepTextToMusicJobPlan,
} from './aceStepTextToMusicPatchTab';
import { settleAceStepTextToMusicJobs } from './aceStepTextToMusicSettlement';
import { createSessionEditHistory, redoSessionEdit, undoSessionEdit } from './sessionEditHistory';
import type { ProjectState } from './types';

describe('ACE-Step Text to Music settlement', () => {
  it('registers a multi-Seed batch as 48 kHz Takes in one Clip and one undoable Edit', () => {
    const patchTab = configuredPatchTab();
    const project = createProject(patchTab);
    const preparation = prepareAceStepTextToMusicRun(project, patchTab, {
      createdAt: '2026-08-31T00:00:00.000Z',
      lyricsArtifactId: 'artifact-12345678-1234-4123-8123-123456789abc',
      lyricsRelativePath:
        'renders/ace-step/lyrics/artifact-12345678-1234-4123-8123-123456789abc.txt',
      requestToken: 'ace-t2m-settlement-1',
    });
    if (!preparation.canPrepare) throw new Error(preparation.message);

    const workspace = { panel: 'timeline' as const, project, selectedClipId: '' };
    const history = createSessionEditHistory(workspace, {
      category: 'system',
      createdAt: '2026-08-30T23:59:00.000Z',
      id: 'edit-initial',
      label: 'Initial workspace',
    });
    const jobs = preparation.plans.map((plan, index) => createCompletedJob(plan, index + 1));
    const result = settleAceStepTextToMusicJobs(history, preparation.plans, jobs, {
      historyLimit: 80,
      patchTabId: patchTab.id,
      recipeFingerprint: preparation.recipeFingerprint,
      sourceParameterFingerprint: preparation.sourceParameterFingerprint,
      target: preparation.target,
    });

    expect(result).toMatchObject({
      artifacts: [
        { provenance: { parameters: { sampleRate: 48_000 }, seed: 42 } },
        { provenance: { parameters: { sampleRate: 48_000 }, seed: 43 } },
      ],
      clip: {
        activeClipTakeId: 'clip-take-artifact-ace-t2m-1',
        clipTakes: [
          { label: 'ACE T2M Take 01' },
          { label: 'ACE T2M Take 02' },
        ],
      },
      settled: true,
      status: 'SETTLED',
    });

    if (!result.settled) throw new Error(result.message);
    expect(result.history.past).toHaveLength(1);
    expect(result.workspace.project.patchTabs[0].generationContinuation).toMatchObject({
      kind: 'ace-step-text-to-music',
      outputClipId: result.clip.id,
    });

    const undone = undoSessionEdit(result.history);
    expect(undone.status).toBe('MOVED');
    expect(undone.history.present.value).toBe(workspace);
    const redone = redoSessionEdit(undone.history, 80);
    expect(redone.status).toBe('MOVED');
    expect(redone.history.present.value).toBe(result.workspace);
  });

  it('accepts real-model duration quantization within the executor tolerance', () => {
    const patchTab = configuredPatchTab();
    const project = createProject(patchTab);
    const preparation = prepareAceStepTextToMusicRun(project, patchTab, {
      createdAt: '2026-08-31T00:00:00.000Z',
      lyricsArtifactId: 'artifact-12345678-1234-4123-8123-123456789abc',
      lyricsRelativePath:
        'renders/ace-step/lyrics/artifact-12345678-1234-4123-8123-123456789abc.txt',
      requestToken: 'ace-t2m-settlement-duration-tolerance',
    });
    if (!preparation.canPrepare) throw new Error(preparation.message);

    const workspace = { panel: 'timeline' as const, project, selectedClipId: '' };
    const history = createSessionEditHistory(workspace, {
      category: 'system',
      createdAt: '2026-08-30T23:59:00.000Z',
      id: 'edit-initial-duration-tolerance',
      label: 'Initial workspace',
    });
    const jobs = preparation.plans.map((plan, index) =>
      createCompletedJob(plan, index + 1, {
        durationSeconds: plan.request.parameters.durationSeconds - 0.05,
      }),
    );
    const result = settleAceStepTextToMusicJobs(history, preparation.plans, jobs, {
      historyLimit: 80,
      patchTabId: patchTab.id,
      recipeFingerprint: preparation.recipeFingerprint,
      sourceParameterFingerprint: preparation.sourceParameterFingerprint,
      target: preparation.target,
    });

    expect(result).toMatchObject({
      clipTakes: [{ label: 'ACE T2M Take 01' }, { label: 'ACE T2M Take 02' }],
      settled: true,
      status: 'SETTLED',
    });
  });

  it('blocks settlement when PatchTab parameters change during generation', () => {
    const patchTab = configuredPatchTab();
    const project = createProject(patchTab);
    const preparation = prepareAceStepTextToMusicRun(project, patchTab, {
      createdAt: '2026-08-31T00:00:00.000Z',
      lyricsArtifactId: 'artifact-12345678-1234-4123-8123-123456789abc',
      lyricsRelativePath:
        'renders/ace-step/lyrics/artifact-12345678-1234-4123-8123-123456789abc.txt',
      requestToken: 'ace-t2m-settlement-2',
    });
    if (!preparation.canPrepare) throw new Error(preparation.message);

    const changedProject = {
      ...project,
      patchTabs: project.patchTabs.map((candidate) => ({
        ...candidate,
        parameters: candidate.parameters.map((parameter) =>
          parameter.id === 'seed' && parameter.kind === 'number'
            ? { ...parameter, value: 99 }
            : parameter,
        ),
      })),
    };
    const workspace = { project: changedProject, selectedClipId: '' };
    const history = createSessionEditHistory(workspace, {
      category: 'system',
      createdAt: '2026-08-30T23:59:00.000Z',
      id: 'edit-initial-stale',
      label: 'Initial workspace',
    });
    const jobs = preparation.plans.map((plan, index) => createCompletedJob(plan, index + 1));
    const result = settleAceStepTextToMusicJobs(history, preparation.plans, jobs, {
      historyLimit: 80,
      patchTabId: patchTab.id,
      recipeFingerprint: preparation.recipeFingerprint,
      sourceParameterFingerprint: preparation.sourceParameterFingerprint,
      target: preparation.target,
    });

    expect(result).toMatchObject({
      cause: 'ace-step-t2m-source-stale',
      settled: false,
    });
    expect(result.workspace.project.tracks).toEqual([]);
  });
});

function createCompletedJob(
  plan: AceStepTextToMusicJobPlan,
  index: number,
  overrides: Readonly<{ durationSeconds?: number }> = {},
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-31T00:00:00.000Z';
  const finishedAt = `2026-08-31T00:00:${String(15 + index).padStart(2, '0')}.000Z`;
  const artifactId = `artifact-ace-t2m-${index}`;
  return {
    attempt: 1,
    createdAt,
    finishedAt,
    history: [
      { attempt: 1, at: createdAt, state: 'QUEUED' },
      { attempt: 1, at: finishedAt, state: 'COMPLETED' },
    ],
    jobId: `job-ace-t2m-${index}`,
    modelId: plan.request.modelId,
    modelRevision: plan.request.modelRevision,
    providerId: plan.request.providerId,
    request: plan.request,
    result: {
      artifact: {
        artifactId,
        createdAt: finishedAt,
        destination: 'ace-step',
        file: {
          extension: '.wav',
          name: `${artifactId}.wav`,
          relativePath: `renders/ace-step/${artifactId}.wav`,
          sizeBytes: 3_072_044,
        },
        kind: 'audio',
        lineage: plan.request.lineage,
        provenance: {
          modelId: plan.request.modelId,
          modelRevision: plan.request.modelRevision,
          parameters: plan.request.parameters,
          providerId: plan.request.providerId,
          seed: plan.request.parameters.seed,
          taskId: plan.request.taskId,
        },
      },
      generation: {
        bytesWritten: 3_072_044,
        channels: 2,
        durationSeconds: overrides.durationSeconds ?? plan.request.parameters.durationSeconds,
        mimeType: 'audio/wav',
        providerCompletedAt: finishedAt,
      },
    },
    startedAt: createdAt,
    state: 'COMPLETED',
    taskId: plan.request.taskId,
    updatedAt: finishedAt,
  };
}

function configuredPatchTab() {
  const template = createAceStepTextToMusicPatchTabTemplate();
  return {
    ...template,
    id: 'ace-t2m-test',
    parameters: template.parameters.map((parameter) => {
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

function createProject(patchTab: ReturnType<typeof configuredPatchTab>): ProjectState {
  return {
    artifacts: [],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C major',
    name: 'ACE T2M Settlement Test',
    patchTabs: [patchTab],
    playheadTick: 0,
    recordingSettings: { countInBars: 1, metronomeEnabled: true, metronomeVolume: 0.5 },
    selectedPatchTabId: patchTab.id,
    selection: { items: [] },
    status: 'READY',
    tabFlowLines: [],
    tabFlowStageResults: [],
    takes: [],
    totalTicks: 960 * 4 * 32,
    tracks: [],
  };
}
