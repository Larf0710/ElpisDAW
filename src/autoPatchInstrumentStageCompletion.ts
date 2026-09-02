import {
  completeAutoPatchRuntimeStage,
  type AutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeStageDispatch,
} from './autoPatchRuntimeCoordinator';
import type { AutoPatchStageRunnerResult } from './autoPatchStageRunner';
import { secondsToTimelineTicks } from './audioClipTiming';
import {
  createInstrumentRenderRegistration,
  type InstrumentRenderRegistrationUpdate,
} from './instrumentRenderRegistration';
import {
  normalizeTabFlowStageResultIndex,
  registerProjectTabFlowStageResult,
} from './tabFlowStageResultIndex';
import type {
  Clip,
  CompletedTabFlowStageResultRecord,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';
import {
  createInstrumentRenderOutput,
  isInstrumentPatchTab,
} from './workflow';

export type AutoPatchInstrumentStageCompletionOptions = Readonly<{
  label?: string;
  outputClipId: string;
  resultId: string;
}>;

export type AutoPatchInstrumentStageCompletionResult =
  | Readonly<{
      artifact: GeneratedAudioArtifact & { destination: 'instrument' };
      clipTake: GeneratedAudioClipTake;
      coordinator: AutoPatchRuntimeCoordinator;
      dispatch?: AutoPatchRuntimeStageDispatch;
      ok: true;
      outputClip: Clip;
      project: ProjectState;
      registrationStatus: Extract<
        InstrumentRenderRegistrationUpdate,
        { canRegister: true }
      >['status'];
      result: CompletedTabFlowStageResultRecord;
      status: 'COMPLETED';
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      reason:
        | 'coordinator-rejected'
        | 'identity-mismatch'
        | 'output-invalid'
        | 'project-stale'
        | 'registration-failed'
        | 'runner-failed';
      status: 'FAILED';
    }>;

export function completeAutoPatchInstrumentStage(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  runner: AutoPatchStageRunnerResult,
  options: AutoPatchInstrumentStageCompletionOptions,
): AutoPatchInstrumentStageCompletionResult {
  if (!runner.ok) {
    return failure(
      'runner-failed',
      runner.cause,
      `Instrument Stage Runner did not complete: ${runner.message}`,
    );
  }

  if (
    coordinator.status !== 'RUNNING' ||
    runner.runId !== coordinator.runId ||
    runner.attemptId !== coordinator.activeAttempt.attemptId ||
    runner.fingerprint !== coordinator.activeStage.fingerprint ||
    !areScopesEqual(runner.scope, coordinator.activeStage.scope)
  ) {
    return failure(
      'identity-mismatch',
      'runner-coordinator-mismatch',
      'Completed Instrument Job does not match the running Auto Patch Stage attempt.',
    );
  }

  const projectStageResults = normalizeTabFlowStageResultIndex(
    project.tabFlowStageResults,
  );

  if (!areJsonValuesEqual(projectStageResults, coordinator.stageResults)) {
    return failure(
      'project-stale',
      'project-stage-results-changed',
      'Project Stage Results changed after the Auto Patch runtime snapshot was created.',
    );
  }

  const sourceMatches = findClips(project, runner.scope.targetClipId);
  const patchTabMatches = project.patchTabs.filter(
    (patchTab) => patchTab.id === runner.scope.stageId,
  );
  const finishedAt = runner.job.finishedAt;

  if (
    sourceMatches.length !== 1 ||
    patchTabMatches.length !== 1 ||
    !isInstrumentPatchTab(patchTabMatches[0]) ||
    !doesPatchTabMatchRuntimeSnapshot(
      coordinator,
      patchTabMatches[0],
      runner.scope,
    ) ||
    !finishedAt ||
    Number.isNaN(Date.parse(finishedAt))
  ) {
    return failure(
      'output-invalid',
      'instrument-output-context-invalid',
      'Instrument output requires one current source Clip, one MIDI TO AUDIO PatchTab, and a completed Job timestamp.',
    );
  }

  const sourceClip = sourceMatches[0];
  const patchTab = patchTabMatches[0];
  const outputMatches = findClips(project, options.outputClipId);
  let outputProject = project;
  let outputClip: Clip;

  if (outputMatches.length === 0) {
    try {
      const created = createInstrumentRenderOutput(
        project,
        sourceClip,
        patchTab,
        {
          clipId: options.outputClipId,
          createdAt: finishedAt,
        },
      );
      outputProject = created.project;
      outputClip = created.clip;
    } catch (error) {
      return failure(
        'output-invalid',
        'instrument-output-creation-failed',
        error instanceof Error
          ? error.message
          : 'Instrument output Clip could not be created.',
      );
    }
  } else if (
    outputMatches.length === 1 &&
    doesOutputClipMatch(
      outputMatches[0],
      sourceClip,
      patchTab.name,
      finishedAt,
      runner.job.result,
      project.bpm,
    )
  ) {
    outputClip = outputMatches[0];
  } else {
    return failure(
      'output-invalid',
      'instrument-output-conflict',
      `Instrument output Clip ID is already used by another output: ${options.outputClipId}.`,
    );
  }

  const registration = createInstrumentRenderRegistration(
    outputProject,
    runner.job,
    {
      label: options.label,
      sourceClipId: sourceClip.id,
      targetClipId: outputClip.id,
    },
  );

  if (!registration.canRegister) {
    return failure(
      'registration-failed',
      registration.reason,
      registration.message,
    );
  }

  const runtimeTarget = createCompletedRuntimeTarget(
    coordinator,
    runner.scope.targetClipId,
    registration.artifact.artifactId,
    registration.clipTake.clipTakeId,
  );

  if (!runtimeTarget) {
    return failure(
      'coordinator-rejected',
      'runtime-target-missing',
      'Running Auto Patch Stage does not have one exact runtime target snapshot.',
    );
  }

  const stageResult: CompletedTabFlowStageResultRecord = Object.freeze({
    fingerprint: runner.fingerprint,
    finishedAt,
    outputArtifactIds: Object.freeze([
      registration.artifact.artifactId,
    ]),
    outputClipTakeIds: Object.freeze([
      registration.clipTake.clipTakeId,
    ]),
    resultId: options.resultId,
    scope: Object.freeze({ ...runner.scope }),
    state: 'COMPLETED',
  });
  const completion = completeAutoPatchRuntimeStage(coordinator, {
    attemptId: runner.attemptId,
    result: stageResult,
    runtimeTarget,
  });

  if (!completion.ok) {
    return failure(
      'coordinator-rejected',
      completion.cause,
      completion.message,
    );
  }

  let completedProject: ProjectState;

  try {
    completedProject = registerProjectTabFlowStageResult(
      registration.project,
      stageResult,
    );
  } catch (error) {
    return failure(
      'project-stale',
      'project-stage-result-conflict',
      error instanceof Error
        ? error.message
        : 'Completed Stage Result could not be registered in the Project.',
    );
  }

  if (
    !areJsonValuesEqual(
      completedProject.tabFlowStageResults,
      completion.coordinator.stageResults,
    )
  ) {
    return failure(
      'project-stale',
      'project-coordinator-result-mismatch',
      'Project and Runtime Coordinator Stage Result indexes no longer match.',
    );
  }

  const registeredOutput = findClips(
    completedProject,
    outputClip.id,
  );

  if (registeredOutput.length !== 1) {
    return failure(
      'project-stale',
      'registered-output-missing',
      'Completed Instrument output no longer resolves uniquely in the Project.',
    );
  }

  return Object.freeze({
    artifact: registration.artifact,
    clipTake: registration.clipTake,
    coordinator: completion.coordinator,
    ...(completion.dispatch ? { dispatch: completion.dispatch } : {}),
    ok: true,
    outputClip: registeredOutput[0],
    project: completedProject,
    registrationStatus: registration.status,
    result: stageResult,
    status: 'COMPLETED',
  });
}

function doesPatchTabMatchRuntimeSnapshot(
  coordinator: AutoPatchRuntimeCoordinator,
  patchTab: ProjectState['patchTabs'][number],
  scope: AutoPatchStageRunnerResult['scope'],
): boolean {
  const family = coordinator.validatedPreflight.plan.graphSnapshot.families.find(
    (candidate) =>
      candidate.familyId === scope.familyId &&
      candidate.familyRevision === scope.familyRevision,
  );
  const snapshot = family?.patchTabs.find(
    (candidate) => candidate.id === scope.stageId,
  );

  return Boolean(
    snapshot &&
      patchTab.nodeTypeId === snapshot.nodeTypeId &&
      patchTab.nodeVersion === snapshot.nodeVersion &&
      areJsonValuesEqual(patchTab.parameters, snapshot.parameters),
  );
}

function createCompletedRuntimeTarget(
  coordinator: AutoPatchRuntimeCoordinator,
  targetClipId: string,
  artifactId: string,
  clipTakeId: string,
) {
  const matches = coordinator.runtimeTargets.filter(
    (target) => target.targetClipId === targetClipId,
  );

  if (matches.length !== 1) {
    return undefined;
  }

  const current = matches[0];
  const existingIdentity = current.artifactIdentities.find(
    (identity) => identity.artifactId === artifactId,
  );

  if (existingIdentity && existingIdentity.mediaType !== 'audio') {
    return undefined;
  }

  return {
    artifactIdentities: existingIdentity
      ? [...current.artifactIdentities]
      : [
          ...current.artifactIdentities,
          { artifactId, mediaType: 'audio' as const },
        ],
    availability: {
      artifactIds: appendUnique(
        current.availability.artifactIds,
        artifactId,
      ),
      clipTakeIds: appendUnique(
        current.availability.clipTakeIds,
        clipTakeId,
      ),
    },
    targetClipId,
  };
}

function doesOutputClipMatch(
  output: Clip,
  source: Clip,
  generatedBy: string,
  createdAt: string,
  jobResult: unknown,
  bpm: number,
): boolean {
  const generation = isRecord(jobResult) ? jobResult.generation : undefined;
  const renderedDurationSeconds = isRecord(generation) ? generation.durationSeconds : undefined;
  const matchesRenderedTiming =
    typeof renderedDurationSeconds === 'number' &&
    Number.isFinite(renderedDurationSeconds) && renderedDurationSeconds > 0 &&
    Number.isFinite(bpm) && bpm > 0 &&
    output.audioTiming?.timeBase === 'absolute-seconds' &&
    output.audioTiming.sourceStartSeconds === 0 &&
    output.audioTiming.sourceEndSeconds === renderedDurationSeconds &&
    output.lengthTicks === secondsToTimelineTicks(renderedDurationSeconds, bpm);
  return (
    output.type === 'instrument-audio' &&
    output.sourceClipId === source.id &&
    output.generatedBy === generatedBy &&
    output.createdAt === createdAt &&
    output.startTick === source.startTick &&
    (output.lengthTicks === source.lengthTicks || matchesRenderedTiming)
  );
}

function findClips(project: ProjectState, clipId: string): Clip[] {
  return project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);
}

function appendUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function areScopesEqual(
  left: AutoPatchStageRunnerResult['scope'],
  right: AutoPatchStageRunnerResult['scope'],
): boolean {
  return (
    left.familyId === right.familyId &&
    left.familyRevision === right.familyRevision &&
    left.stageId === right.stageId &&
    left.targetClipId === right.targetClipId
  );
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        areJsonValuesEqual(value, right[index]),
      )
    );
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        areJsonValuesEqual(left[key], right[key]),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(
  reason: Extract<
    AutoPatchInstrumentStageCompletionResult,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<AutoPatchInstrumentStageCompletionResult, { ok: false }> {
  return Object.freeze({ cause, message, ok: false, reason, status: 'FAILED' });
}
