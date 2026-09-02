import { resolveActiveMidiTake } from './activeMidiTake';
import {
  completeAutoPatchRuntimeStage,
  type AutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeStageDispatch,
} from './autoPatchRuntimeCoordinator';
import {
  AUTO_PATCH_MIDI_EDIT_EDITOR_ID,
  AUTO_PATCH_MIDI_EDIT_EDITOR_VERSION,
  AUTO_PATCH_MIDI_EDIT_STAGE_ADAPTER_ID,
  type AutoPatchMidiEditProcessorOutcome,
  type AutoPatchMidiEditStagePlan,
} from './autoPatchMidiEditStage';
import { createEditedMidiArtifact } from './midiEditArtifact';
import {
  createMidiArtifactRegistration,
  type MidiArtifactRegistrationUpdate,
} from './projectArtifactRegistration';
import { resolveWholeBarMidiClipLength } from './midiNoteTiming';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import {
  normalizeTabFlowStageResultIndex,
  registerProjectTabFlowStageResult,
} from './tabFlowStageResultIndex';
import type {
  Clip,
  CompletedTabFlowStageResultRecord,
  EditedMidiArtifact,
  EditedMidiClipTake,
  MidiArtifact,
  MidiClipTake,
  MidiNote,
  ProjectState,
} from './types';
import { TICKS_PER_QUARTER } from './workflow';

export type AutoPatchMidiEditStageCompletionOptions = Readonly<{
  artifactId: string;
  label?: string;
  resultId: string;
  sourceEditId: string;
}>;

export type AutoPatchMidiEditStageCompletionResult =
  | Readonly<{
      artifact: EditedMidiArtifact;
      clipTake: EditedMidiClipTake;
      coordinator: AutoPatchRuntimeCoordinator;
      dispatch?: AutoPatchRuntimeStageDispatch;
      ok: true;
      project: ProjectState;
      registrationStatus: Extract<
        MidiArtifactRegistrationUpdate,
        { canRegister: true }
      >['status'];
      result: CompletedTabFlowStageResultRecord;
      status: 'COMPLETED';
      targetClip: Clip;
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      project: ProjectState;
      reason:
        | 'coordinator-rejected'
        | 'identity-mismatch'
        | 'output-invalid'
        | 'project-stale'
        | 'registration-failed'
        | 'source-invalid';
      status: 'FAILED';
    }>;

export function completeAutoPatchMidiEditStage(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  plan: AutoPatchMidiEditStagePlan,
  outcome: AutoPatchMidiEditProcessorOutcome,
  options: AutoPatchMidiEditStageCompletionOptions,
): AutoPatchMidiEditStageCompletionResult {
  if (
    coordinator.status !== 'RUNNING' ||
    plan.adapterId !== AUTO_PATCH_MIDI_EDIT_STAGE_ADAPTER_ID ||
    plan.kind !== 'builtin-midi-edit' ||
    plan.runId !== coordinator.runId ||
    plan.attemptId !== coordinator.activeAttempt.attemptId ||
    plan.startedAt !== coordinator.activeAttempt.startedAt ||
    plan.fingerprint !== coordinator.activeStage.fingerprint ||
    !areScopesEqual(plan.scope, coordinator.activeStage.scope) ||
    outcome.adapterId !== plan.adapterId ||
    outcome.runId !== plan.runId ||
    outcome.attemptId !== plan.attemptId ||
    outcome.fingerprint !== plan.fingerprint ||
    outcome.status !== 'MIDI_EDIT_COMPLETED' ||
    !areScopesEqual(outcome.scope, plan.scope)
  ) {
    return failure(
      project,
      'identity-mismatch',
      'midi-edit-runtime-identity-mismatch',
      'Automatic MIDI Edit plan or processor outcome does not match the running Stage attempt.',
    );
  }

  const projectStageResults = normalizeTabFlowStageResultIndex(
    project.tabFlowStageResults,
  );

  if (!areJsonValuesEqual(projectStageResults, coordinator.stageResults)) {
    return failure(
      project,
      'project-stale',
      'project-stage-results-changed',
      'Project Stage Results changed after the Auto Patch runtime snapshot was created.',
    );
  }

  const patchTabMatches = project.patchTabs.filter(
    (patchTab) => patchTab.id === outcome.scope.stageId,
  );

  if (
    patchTabMatches.length !== 1 ||
    patchTabMatches[0].nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit ||
    !doesPatchTabMatchRuntimeSnapshot(
      coordinator,
      patchTabMatches[0],
      outcome.scope,
    ) ||
    !areJsonValuesEqual(patchTabMatches[0].parameters, plan.parameters)
  ) {
    return failure(
      project,
      'project-stale',
      'midi-edit-patch-tab-changed',
      'Current MIDI Edit PatchTab no longer matches its immutable runtime plan.',
    );
  }

  const sourceResolution = resolveActiveMidiTake(
    project,
    outcome.scope.targetClipId,
  );

  if (!sourceResolution.canResolve) {
    return failure(
      project,
      'source-invalid',
      sourceResolution.reason,
      `Automatic MIDI Edit source is unavailable: ${sourceResolution.message}`,
    );
  }

  if (
    sourceResolution.plan.source.sourceType === 'edit' ||
    !areJsonValuesEqual(sourceResolution.plan, plan.source)
  ) {
    return failure(
      project,
      'source-invalid',
      sourceResolution.plan.source.sourceType === 'edit'
        ? 'automatic-midi-edit-reapplication-blocked'
        : 'midi-edit-source-changed',
      sourceResolution.plan.source.sourceType === 'edit'
        ? 'Automatic MIDI Edit cannot replace deliberate Active Edited MIDI.'
        : 'Active MIDI changed after the automatic MIDI Edit plan was created.',
    );
  }

  const source = resolveSourceObjects(project, plan);

  if (!source) {
    return failure(
      project,
      'source-invalid',
      'midi-edit-source-context-invalid',
      'Automatic MIDI Edit requires one exact source Clip, Artifact, and MIDI Take.',
    );
  }

  if (!doesTargetClipMatchRuntimeSnapshot(coordinator, source)) {
    return failure(
      project,
      'project-stale',
      'midi-edit-target-clip-changed',
      'Target MIDI Clip geometry, version, or Track changed after the Auto Patch runtime snapshot was created.',
    );
  }

  let artifact: EditedMidiArtifact;

  try {
    artifact = createEditedMidiArtifact({
      artifactId: options.artifactId,
      createdAt: outcome.finishedAt,
      editorId: AUTO_PATCH_MIDI_EDIT_EDITOR_ID,
      editorVersion: AUTO_PATCH_MIDI_EDIT_EDITOR_VERSION,
      notes: outcome.notes,
      sourceArtifact: source.artifact,
      sourceClipTake: source.clipTake,
      sourceEditId: options.sourceEditId,
    });
  } catch (error) {
    return failure(
      project,
      'output-invalid',
      'midi-edit-output-invalid',
      error instanceof Error
        ? error.message
        : 'Automatic MIDI Edit output is invalid.',
    );
  }

  const boundaryUpdate = stageMidiClipBoundaryGrowth(
    project,
    source.clip,
    artifact.midi.notes,
  );

  if (!boundaryUpdate.ok) {
    return failure(
      project,
      boundaryUpdate.reason,
      boundaryUpdate.cause,
      boundaryUpdate.message,
    );
  }

  const registration = createMidiArtifactRegistration(
    boundaryUpdate.project,
    artifact,
    {
      clipId: source.clip.id,
      ...(options.label ? { label: options.label } : {}),
    },
  );

  if (!registration.canRegister) {
    return failure(
      project,
      'registration-failed',
      registration.reason,
      registration.message,
    );
  }

  if (
    !('sourceEditId' in registration.artifact) ||
    registration.clipTake.sourceType !== 'edit'
  ) {
    return failure(
      project,
      'registration-failed',
      'midi-edit-registration-invalid',
      'Automatic MIDI Edit registration returned an invalid Artifact or Take.',
    );
  }

  const runtimeTarget = createCompletedRuntimeTarget(
    coordinator,
    outcome.scope.targetClipId,
    registration.artifact,
    registration.clipTake,
  );

  if (!runtimeTarget) {
    return failure(
      project,
      'coordinator-rejected',
      'runtime-target-missing',
      'Running MIDI Edit Stage does not have one exact runtime target snapshot.',
    );
  }

  const stageResult: CompletedTabFlowStageResultRecord = Object.freeze({
    fingerprint: outcome.fingerprint,
    finishedAt: outcome.finishedAt,
    outputArtifactIds: Object.freeze([
      registration.artifact.artifactId,
    ]),
    outputClipTakeIds: Object.freeze([
      registration.clipTake.clipTakeId,
    ]),
    resultId: options.resultId,
    scope: Object.freeze({ ...outcome.scope }),
    state: 'COMPLETED',
  });
  const completion = completeAutoPatchRuntimeStage(coordinator, {
    attemptId: outcome.attemptId,
    result: stageResult,
    runtimeTarget,
  });

  if (!completion.ok) {
    return failure(
      project,
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
      project,
      'project-stale',
      'project-stage-result-conflict',
      error instanceof Error
        ? error.message
        : 'Completed MIDI Edit Stage Result could not be registered.',
    );
  }

  if (
    !areJsonValuesEqual(
      completedProject.tabFlowStageResults,
      completion.coordinator.stageResults,
    )
  ) {
    return failure(
      project,
      'project-stale',
      'project-coordinator-result-mismatch',
      'Project and Runtime Coordinator Stage Result indexes no longer match.',
    );
  }

  const targetMatches = findClips(
    completedProject,
    outcome.scope.targetClipId,
  );
  const activeTake = targetMatches[0]?.clipTakes?.find(
    (take) =>
      take.clipTakeId === registration.clipTake.clipTakeId &&
      take.artifactId === registration.artifact.artifactId,
  );

  if (
    targetMatches.length !== 1 ||
    targetMatches[0].activeClipTakeId !==
      registration.clipTake.clipTakeId ||
    activeTake?.mediaType !== 'midi' ||
    activeTake.sourceType !== 'edit'
  ) {
    return failure(
      project,
      'project-stale',
      'registered-midi-edit-output-missing',
      'Completed automatic MIDI Edit output no longer resolves as the Active Take.',
    );
  }

  return Object.freeze({
    artifact: registration.artifact,
    clipTake: registration.clipTake,
    coordinator: completion.coordinator,
    ...(completion.dispatch ? { dispatch: completion.dispatch } : {}),
    ok: true,
    project: completedProject,
    registrationStatus: registration.status,
    result: stageResult,
    status: 'COMPLETED',
    targetClip: targetMatches[0],
  });
}

function resolveSourceObjects(
  project: ProjectState,
  plan: AutoPatchMidiEditStagePlan,
): Readonly<{
  artifact: MidiArtifact;
  clip: Clip;
  clipTake: MidiClipTake;
  trackId: string;
}> | undefined {
  const locations = findClipLocations(project, plan.scope.targetClipId);
  const artifacts = (project.artifacts ?? []).filter(
    (artifact): artifact is MidiArtifact =>
      artifact.artifactId === plan.source.source.artifactId &&
      artifact.kind === 'midi',
  );
  const takes = locations[0]?.clip.clipTakes?.filter(
    (take): take is MidiClipTake =>
      take.clipTakeId === plan.source.source.clipTakeId &&
      take.artifactId === plan.source.source.artifactId &&
      take.mediaType === 'midi',
  );

  return locations.length === 1 &&
    artifacts.length === 1 &&
    takes?.length === 1
    ? {
        artifact: artifacts[0],
        clip: locations[0].clip,
        clipTake: takes[0],
        trackId: locations[0].trackId,
      }
    : undefined;
}

function doesTargetClipMatchRuntimeSnapshot(
  coordinator: AutoPatchRuntimeCoordinator,
  source: Readonly<{ clip: Clip; trackId: string }>,
): boolean {
  const matches =
    coordinator.validatedPreflight.plan.graphSnapshot.targets.filter(
      (target) => target.clipId === source.clip.id,
    );
  const snapshot = matches[0];

  return Boolean(
    matches.length === 1 &&
      snapshot &&
      snapshot.clipType === source.clip.type &&
      snapshot.clipVersion === source.clip.version &&
      snapshot.lengthTicks === source.clip.lengthTicks &&
      snapshot.startTick === source.clip.startTick &&
      snapshot.trackId === source.trackId,
  );
}

type MidiClipBoundaryGrowthResult =
  | Readonly<{ ok: true; project: ProjectState }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      reason: 'output-invalid' | 'project-stale';
    }>;

function stageMidiClipBoundaryGrowth(
  project: ProjectState,
  clip: Clip,
  notes: readonly MidiNote[],
): MidiClipBoundaryGrowthResult {
  const currentEndTick = clip.startTick + clip.lengthTicks;

  if (
    (clip.type !== 'midi-notes' && clip.type !== 'edited-midi') ||
    !Number.isSafeInteger(clip.startTick) ||
    clip.startTick < 0 ||
    !Number.isSafeInteger(clip.lengthTicks) ||
    clip.lengthTicks < 1 ||
    !Number.isSafeInteger(clip.version) ||
    clip.version < 1 ||
    !Number.isSafeInteger(project.totalTicks) ||
    project.totalTicks < 1 ||
    !Number.isSafeInteger(currentEndTick) ||
    currentEndTick > project.totalTicks
  ) {
    return Object.freeze({
      cause: 'midi-edit-target-boundary-invalid',
      message: 'Target MIDI Clip or Project Timeline has invalid boundary state.',
      ok: false,
      reason: 'project-stale',
    });
  }

  const lengthResolution = resolveWholeBarMidiClipLength(
    clip.lengthTicks,
    notes,
    TICKS_PER_QUARTER,
  );

  if (!lengthResolution.canResolve) {
    return Object.freeze({
      cause: 'midi-edit-output-boundary-invalid',
      message: `Automatic MIDI Edit output cannot resolve a safe Clip boundary: ${lengthResolution.message}`,
      ok: false,
      reason: 'output-invalid',
    });
  }

  const nextProjectEndTick = clip.startTick + lengthResolution.lengthTicks;

  if (!Number.isSafeInteger(nextProjectEndTick)) {
    return Object.freeze({
      cause: 'midi-edit-output-boundary-invalid',
      message: 'Automatic MIDI Edit output exceeds the safe Project Timeline range.',
      ok: false,
      reason: 'output-invalid',
    });
  }

  if (lengthResolution.lengthTicks === clip.lengthTicks) {
    return Object.freeze({ ok: true, project });
  }

  return Object.freeze({
    ok: true,
    project: {
      ...project,
      totalTicks: Math.max(project.totalTicks, nextProjectEndTick),
      tracks: project.tracks.map((track) =>
        track.clips.some((candidate) => candidate.id === clip.id)
          ? {
              ...track,
              clips: track.clips.map((candidate) =>
                candidate.id === clip.id
                  ? {
                      ...candidate,
                      lengthTicks: lengthResolution.lengthTicks,
                    }
                  : candidate,
              ),
            }
          : track,
      ),
    },
  });
}

function doesPatchTabMatchRuntimeSnapshot(
  coordinator: AutoPatchRuntimeCoordinator,
  patchTab: ProjectState['patchTabs'][number],
  scope: AutoPatchMidiEditProcessorOutcome['scope'],
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
  artifact: EditedMidiArtifact,
  clipTake: EditedMidiClipTake,
) {
  const matches = coordinator.runtimeTargets.filter(
    (target) => target.targetClipId === targetClipId,
  );

  if (matches.length !== 1) {
    return undefined;
  }

  const current = matches[0];
  const existingIdentity = current.artifactIdentities.find(
    (identity) => identity.artifactId === artifact.artifactId,
  );
  const midiIdentity = {
    contentHash: artifact.contentHash ?? '',
    revision: artifact.revision ?? 1,
  };

  if (
    existingIdentity &&
    (existingIdentity.mediaType !== 'midi' ||
      !existingIdentity.midi ||
      !areJsonValuesEqual(existingIdentity.midi, midiIdentity))
  ) {
    return undefined;
  }

  return {
    artifactIdentities: existingIdentity
      ? [...current.artifactIdentities]
      : [
          ...current.artifactIdentities,
          {
            artifactId: artifact.artifactId,
            mediaType: 'midi' as const,
            midi: midiIdentity,
          },
        ],
    availability: {
      artifactIds: appendUnique(
        current.availability.artifactIds,
        artifact.artifactId,
      ),
      clipTakeIds: appendUnique(
        current.availability.clipTakeIds,
        clipTake.clipTakeId,
      ),
    },
    targetClipId,
  };
}

function findClips(project: ProjectState, clipId: string): Clip[] {
  return project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);
}

function findClipLocations(
  project: ProjectState,
  clipId: string,
): ReadonlyArray<Readonly<{ clip: Clip; trackId: string }>> {
  return project.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => clip.id === clipId)
      .map((clip) => ({ clip, trackId: track.id })),
  );
}

function appendUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function areScopesEqual(
  left: AutoPatchMidiEditProcessorOutcome['scope'],
  right: AutoPatchMidiEditProcessorOutcome['scope'],
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
  project: ProjectState,
  reason: Extract<
    AutoPatchMidiEditStageCompletionResult,
    { ok: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<AutoPatchMidiEditStageCompletionResult, { ok: false }> {
  return Object.freeze({
    cause,
    message,
    ok: false,
    project,
    reason,
    status: 'FAILED',
  });
}
