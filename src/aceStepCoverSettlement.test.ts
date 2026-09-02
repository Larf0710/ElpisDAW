import { describe, expect, it } from 'vitest';

import { secondsToTimelineTicks } from './audioClipTiming';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import {
  prepareAceStepCoverRun,
  type AceStepCoverJobPlan,
} from './aceStepCoverPatchTab';
import {
  createAceStepCoverProject,
  createConfiguredAceStepCoverPatchTab,
} from './aceStepCoverTestFixture';
import { settleAceStepCoverJobs } from './aceStepCoverSettlement';
import { createSessionEditHistory, redoSessionEdit, undoSessionEdit } from './sessionEditHistory';
import { createTimelineExportPlan } from './timelineExportPlan';

describe('ACE-Step Cover settlement', () => {
  it('registers a multi-Seed batch as non-destructive 48 kHz Takes in one undoable Edit', () => {
    const patchTab = createConfiguredAceStepCoverPatchTab();
    const project = createAceStepCoverProject(patchTab);
    const preparation = prepareAceStepCoverRun(project, patchTab, 'clip-source', {
      createdAt: '2026-08-31T00:00:00.000Z',
      lyricsArtifactId: 'artifact-lyrics',
      lyricsRelativePath: 'renders/ace-step/lyrics/artifact-lyrics.txt',
      requestToken: 'ace-cover-settlement-1',
    });
    if (!preparation.canPrepare) throw new Error(preparation.message);

    const workspace = { panel: 'timeline' as const, project, selectedClipId: 'clip-source' };
    const history = createSessionEditHistory(workspace, {
      category: 'system',
      createdAt: '2026-08-30T23:59:00.000Z',
      id: 'edit-initial',
      label: 'Initial workspace',
    });
    const jobs = preparation.plans.map((plan, index) => createCompletedJob(plan, index + 1));
    const result = settleAceStepCoverJobs(history, preparation.plans, jobs, {
      historyLimit: 80,
      patchTabId: patchTab.id,
      recipeFingerprint: preparation.recipeFingerprint,
      sourceFingerprint: preparation.sourceFingerprint,
      sourceParameterFingerprint: preparation.sourceParameterFingerprint,
      target: preparation.target,
    });

    expect(result).toMatchObject({
      artifacts: [
        { provenance: { parameters: { sampleRate: 48_000 }, seed: 42 } },
        { provenance: { parameters: { sampleRate: 48_000 }, seed: 43 } },
      ],
      clip: {
        activeClipTakeId: 'clip-take-artifact-ace-cover-1',
        clipTakes: [
          { label: 'ACE Cover Take 01' },
          { label: 'ACE Cover Take 02' },
        ],
        sourceClipId: 'clip-source',
        startTick: 3_840,
        lengthTicks: 23_040,
      },
      settled: true,
      status: 'SETTLED',
    });

    if (!result.settled) throw new Error(result.message);
    expect(result.workspace.project.tracks[0]).toBe(project.tracks[0]);
    expect(result.workspace.project.patchTabs[0].generationContinuation).toMatchObject({
      kind: 'ace-step-cover',
      outputClipId: result.clip.id,
      sourceClipId: 'clip-source',
      sourceClipTakeId: 'clip-take-source',
    });
    expect(result.history.past).toHaveLength(1);

    const reloadedProject = structuredClone(result.workspace.project);
    const appendPreparation = prepareAceStepCoverRun(
      reloadedProject,
      reloadedProject.patchTabs[0],
      result.workspace.selectedClipId,
      {
        createdAt: '2026-08-31T00:01:00.000Z',
        lyricsArtifactId: 'artifact-lyrics-next',
        lyricsRelativePath: 'renders/ace-step/lyrics/artifact-lyrics-next.txt',
        requestToken: 'ace-cover-settlement-1',
      },
    );
    expect(appendPreparation).toMatchObject({
      canPrepare: true,
      target: { kind: 'append', outputClipId: result.clip.id },
    });

    const undone = undoSessionEdit(result.history);
    expect(undone.status).toBe('MOVED');
    expect(undone.history.present.value).toBe(workspace);
    const redone = redoSessionEdit(undone.history, 80);
    expect(redone.status).toBe('MOVED');
    expect(redone.history.present.value).toBe(result.workspace);
  });

  it('blocks settlement if the source Active Take changes during generation', () => {
    const patchTab = createConfiguredAceStepCoverPatchTab();
    const project = createAceStepCoverProject(patchTab);
    const preparation = prepareAceStepCoverRun(project, patchTab, 'clip-source', {
      createdAt: '2026-08-31T00:00:00.000Z',
      lyricsArtifactId: 'artifact-lyrics',
      lyricsRelativePath: 'renders/ace-step/lyrics/artifact-lyrics.txt',
      requestToken: 'ace-cover-settlement-2',
    });
    if (!preparation.canPrepare) throw new Error(preparation.message);

    const changedProject = {
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({ ...clip, activeClipTakeId: 'missing-take' })),
      })),
    };
    const workspace = { project: changedProject, selectedClipId: 'clip-source' };
    const history = createSessionEditHistory(workspace, {
      category: 'system',
      createdAt: '2026-08-30T23:59:00.000Z',
      id: 'edit-stale',
      label: 'Initial workspace',
    });
    const jobs = preparation.plans.map((plan, index) => createCompletedJob(plan, index + 1));
    const result = settleAceStepCoverJobs(history, preparation.plans, jobs, {
      historyLimit: 80,
      patchTabId: patchTab.id,
      recipeFingerprint: preparation.recipeFingerprint,
      sourceFingerprint: preparation.sourceFingerprint,
      sourceParameterFingerprint: preparation.sourceParameterFingerprint,
      target: preparation.target,
    });

    expect(result).toMatchObject({
      cause: 'ace-step-cover-plan-mismatch',
      settled: false,
    });
    expect(result.workspace.project.tracks).toHaveLength(1);
  });

  it('aligns the Cover Clip timing to the rendered duration so Timeline EXPORT remains valid', () => {
    const patchTab = createConfiguredAceStepCoverPatchTab();
    const project = createAceStepCoverProject(patchTab);
    const preparation = prepareAceStepCoverRun(project, patchTab, 'clip-source', {
      createdAt: '2026-08-31T00:00:00.000Z',
      lyricsArtifactId: 'artifact-lyrics',
      lyricsRelativePath: 'renders/ace-step/lyrics/artifact-lyrics.txt',
      requestToken: 'ace-cover-duration-drift',
    });
    if (!preparation.canPrepare) throw new Error(preparation.message);

    const workspace = { panel: 'timeline' as const, project, selectedClipId: 'clip-source' };
    const history = createSessionEditHistory(workspace, {
      category: 'system',
      createdAt: '2026-08-30T23:59:00.000Z',
      id: 'edit-initial',
      label: 'Initial workspace',
    });
    const renderedDurationSeconds = 11.97;
    const jobs = preparation.plans.map((plan, index) =>
      createCompletedJob(plan, index + 1, renderedDurationSeconds),
    );
    const result = settleAceStepCoverJobs(history, preparation.plans, jobs, {
      historyLimit: 80,
      patchTabId: patchTab.id,
      recipeFingerprint: preparation.recipeFingerprint,
      sourceFingerprint: preparation.sourceFingerprint,
      sourceParameterFingerprint: preparation.sourceParameterFingerprint,
      target: preparation.target,
    });

    expect(result.settled).toBe(true);
    if (!result.settled) throw new Error(result.message);
    expect(result.clip).toMatchObject({
      audioTiming: {
        sourceEndSeconds: renderedDurationSeconds,
        sourceStartSeconds: 0,
        timeBase: 'absolute-seconds',
      },
      lengthTicks: secondsToTimelineTicks(renderedDurationSeconds, project.bpm),
    });
    expect(createTimelineExportPlan(result.workspace.project)).toMatchObject({
      canExport: true,
      plan: {
        durationTicks: secondsToTimelineTicks(renderedDurationSeconds, project.bpm),
        target: {
          id: result.clip.id,
        },
      },
    });

    const appendPreparation = prepareAceStepCoverRun(
      result.workspace.project,
      result.workspace.project.patchTabs[0],
      result.workspace.selectedClipId,
      {
        createdAt: '2026-08-31T00:01:00.000Z',
        lyricsArtifactId: 'artifact-lyrics-next',
        lyricsRelativePath: 'renders/ace-step/lyrics/artifact-lyrics-next.txt',
        requestToken: 'ace-cover-duration-drift',
      },
    );
    if (!appendPreparation.canPrepare) throw new Error(appendPreparation.message);

    const appendedDurationSeconds = 11.96;
    const appendResult = settleAceStepCoverJobs(
      result.history,
      appendPreparation.plans,
      appendPreparation.plans.map((plan, index) =>
        createCompletedJob(plan, index + 3, appendedDurationSeconds),
      ),
      {
        historyLimit: 80,
        patchTabId: patchTab.id,
        recipeFingerprint: appendPreparation.recipeFingerprint,
        sourceFingerprint: appendPreparation.sourceFingerprint,
        sourceParameterFingerprint: appendPreparation.sourceParameterFingerprint,
        target: appendPreparation.target,
      },
    );

    expect(appendResult).toMatchObject({
      clip: {
        audioTiming: { sourceEndSeconds: appendedDurationSeconds },
        lengthTicks: secondsToTimelineTicks(appendedDurationSeconds, project.bpm),
      },
      settled: true,
    });
  });
});

function createCompletedJob(
  plan: AceStepCoverJobPlan,
  index: number,
  durationSeconds = plan.request.parameters.durationSeconds,
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-31T00:00:00.000Z';
  const finishedAt = `2026-08-31T00:00:${String(15 + index).padStart(2, '0')}.000Z`;
  const artifactId = `artifact-ace-cover-${index}`;
  return {
    attempt: 1,
    createdAt,
    finishedAt,
    history: [
      { attempt: 1, at: createdAt, state: 'QUEUED' },
      { attempt: 1, at: finishedAt, state: 'COMPLETED' },
    ],
    jobId: `job-ace-cover-${index}`,
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
          sizeBytes: 2_304_044,
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
        bytesWritten: 2_304_044,
        channels: 2,
        durationSeconds,
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
