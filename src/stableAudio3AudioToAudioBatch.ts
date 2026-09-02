import {
  createStableAudio3StageAdapterPlan,
  type StableAudio3StageAdapterPlan,
  type StableAudio3StageDispatch,
  type StableAudio3StageRuntimeProfile,
} from './stableAudio3StageAdapter';
import type { StableAudio3AudioToAudioContinuationPlan } from './stableAudio3AudioToAudioContinuation';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import { createStableAudio3Registration } from './stableAudio3Registration';
import {
  runStableAudio3StagePlan,
  type StableAudio3StageRunnerClient,
  type StableAudio3StageRunnerOptions,
} from './stableAudio3StageRunner';
import { registerProjectTabFlowStageResult } from './tabFlowStageResultIndex';
import type {
  Clip,
  CompletedTabFlowStageResultRecord,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  PatchTab,
  ProjectState,
  Track,
} from './types';

export type StableAudio3AudioToAudioBatchOptions = Readonly<{
  label?: string;
  resultId: string;
  runner?: Omit<
    StableAudio3StageRunnerOptions,
    'maxPollAttempts' | 'pollUntilTerminal'
  >;
}>;

export type StableAudio3AudioToAudioBatchResult =
  | Readonly<{
      artifacts: readonly (GeneratedAudioArtifact & {
        destination: 'stable-audio-3';
      })[];
      clipTakes: readonly GeneratedAudioClipTake[];
      jobs: readonly LocalEngineGpuJobRecord[];
      ok: true;
      outputClipId: string;
      plans: readonly StableAudio3StageAdapterPlan[];
      project: ProjectState;
      result: CompletedTabFlowStageResultRecord;
      status: 'STAGE_COMPLETED';
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      project: ProjectState;
      reason: 'batch-canceled';
      status: 'STAGE_CANCELED';
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      project: ProjectState;
      reason:
        | 'branch-invalid'
        | 'planning-failed'
        | 'registration-failed'
        | 'runner-failed'
        | 'stage-result-failed';
      status: 'STAGE_FAILED';
    }>;

export async function runStableAudio3AudioToAudioBatch(
  client: StableAudio3StageRunnerClient,
  project: ProjectState,
  dispatch: StableAudio3StageDispatch,
  continuation: StableAudio3AudioToAudioContinuationPlan,
  profile: StableAudio3StageRuntimeProfile,
  options: StableAudio3AudioToAudioBatchOptions,
): Promise<StableAudio3AudioToAudioBatchResult> {
  let preparedProject = project;
  let preparedOutputClipId = continuation.outputTarget.clipId;

  if (continuation.outputTarget.kind === 'new') {
    const branch = createBranchOutput(
      project,
      dispatch,
      continuation.outputTarget.trackId,
      continuation.outputTarget.clipId,
    );

    if (!branch.ok) {
      return failure(
        project,
        'branch-invalid',
        branch.cause,
        branch.message,
      );
    }

    preparedProject = branch.project;
    preparedOutputClipId = branch.clip.id;
  }

  const plans: StableAudio3StageAdapterPlan[] = [];

  for (const seed of continuation.seedSequence) {
    const planning = createStableAudio3StageAdapterPlan(
      {
        ...dispatch,
        parameters: { ...dispatch.parameters, seed },
      },
      project,
      profile,
    );

    if (!planning.canPlan) {
      return failure(
        project,
        'planning-failed',
        planning.cause,
        planning.message,
      );
    }

    plans.push(planning.plan);
  }

  const jobs: LocalEngineGpuJobRecord[] = [];

  for (const plan of plans) {
    const runner = await runStableAudio3StagePlan(client, plan, {
      ...(options.runner ?? {}),
      pollUntilTerminal: true,
    });

    if (!runner.ok) {
      if (
        runner.status === 'JOB_CANCELED' ||
        runner.status === 'RUN_CANCELED'
      ) {
        const cause =
          runner.status === 'JOB_CANCELED'
            ? runner.outcome.cause
            : runner.cause;
        const message =
          runner.status === 'JOB_CANCELED'
            ? runner.outcome.message
            : runner.message;

        return Object.freeze({
          cause,
          message,
          ok: false as const,
          project,
          reason: 'batch-canceled' as const,
          status: 'STAGE_CANCELED' as const,
        });
      }

      return failure(
        project,
        'runner-failed',
        'cause' in runner ? runner.cause : 'stable-audio-3-a2a-batch-pending',
        'message' in runner
          ? runner.message
          : 'Stable Audio 3 A2A batch did not reach a terminal Job state.',
      );
    }

    jobs.push(runner.outcome.completed.job);
  }

  let currentProject = preparedProject;
  const outputClipId = preparedOutputClipId;

  const outputLocation = findUniqueClipLocation(currentProject, outputClipId);

  if (!outputLocation) {
    return failure(
      project,
      'branch-invalid',
      'stable-audio-3-a2a-output-target-missing',
      'Stable Audio 3 A2A output target is unavailable.',
    );
  }

  const takeOffset = outputLocation.clip.clipTakes?.length ?? 0;
  const artifacts: Array<
    GeneratedAudioArtifact & { destination: 'stable-audio-3' }
  > = [];
  const clipTakes: GeneratedAudioClipTake[] = [];

  for (let index = 0; index < jobs.length; index += 1) {
    const registration = createStableAudio3Registration(
      currentProject,
      jobs[index],
      {
        activate: false,
        label:
          options.label ??
          `SA3 A2A Take ${String(takeOffset + index + 1).padStart(2, '0')}`,
        sourceClipId: continuation.sourceClipId,
        targetClipId: outputClipId,
      },
    );

    if (!registration.canRegister || registration.status !== 'REGISTERED') {
      return failure(
        project,
        'registration-failed',
        registration.canRegister
          ? 'stable-audio-3-a2a-registration-not-new'
          : registration.reason,
        registration.canRegister
          ? 'Stable Audio 3 A2A batch expected one new Take per completed Job.'
          : registration.message,
      );
    }

    currentProject = registration.project;
    artifacts.push(registration.artifact);
    clipTakes.push(registration.clipTake);
  }

  const finishedAtValues = jobs
    .map((job) => job.finishedAt as string)
    .sort();
  const finishedAt = finishedAtValues[finishedAtValues.length - 1];

  if (!finishedAt || artifacts.length === 0 || clipTakes.length === 0) {
    return failure(
      project,
      'registration-failed',
      'stable-audio-3-a2a-batch-empty',
      'Stable Audio 3 A2A batch completed without output Takes.',
    );
  }

  const result: CompletedTabFlowStageResultRecord = Object.freeze({
    fingerprint: dispatch.fingerprint,
    finishedAt,
    outputArtifactIds: Object.freeze(
      artifacts.map((artifact) => artifact.artifactId),
    ),
    outputClipTakeIds: Object.freeze(
      clipTakes.map((take) => take.clipTakeId),
    ),
    resultId: options.resultId,
    scope: Object.freeze({ ...dispatch.scope }),
    state: 'COMPLETED' as const,
  });

  try {
    currentProject = registerProjectTabFlowStageResult(currentProject, result);
    currentProject = updateContinuation(
      currentProject,
      dispatch.scope.stageId,
      continuation,
      outputClipId,
    );
  } catch (error) {
    return failure(
      project,
      'stage-result-failed',
      'stable-audio-3-a2a-batch-result-conflict',
      error instanceof Error
        ? error.message
        : 'Stable Audio 3 A2A batch result could not be registered.',
    );
  }

  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    clipTakes: Object.freeze(clipTakes),
    jobs: Object.freeze(jobs),
    ok: true as const,
    outputClipId,
    plans: Object.freeze(plans),
    project: currentProject,
    result,
    status: 'STAGE_COMPLETED' as const,
  });
}

function createBranchOutput(
  project: ProjectState,
  dispatch: StableAudio3StageDispatch,
  trackId: string,
  clipId: string,
):
  | Readonly<{ clip: Clip; ok: true; project: ProjectState; track: Track }>
  | Readonly<{ cause: string; message: string; ok: false }> {
  if (
    project.tracks.some(
      (track) =>
        track.id === trackId ||
        track.clips.some((clip) => clip.id === clipId),
    )
  ) {
    return Object.freeze({
      cause: 'stable-audio-3-a2a-branch-identity-conflict',
      message: 'Stable Audio 3 A2A branch Track or Clip identity already exists.',
      ok: false as const,
    });
  }

  const source = findUniqueClipLocation(project, dispatch.source.clipId);

  if (
    !source ||
    (source.clip.type !== 'instrument-audio' && source.clip.type !== 'mixdown')
  ) {
    return Object.freeze({
      cause: 'stable-audio-3-a2a-branch-source-unsupported',
      message: 'Stable Audio 3 A2A branches require one Instrument Audio or Raw Mixdown source Clip.',
      ok: false as const,
    });
  }

  const isMasterOutput = source.clip.type === 'mixdown';
  const clip: Clip = Object.freeze({
    color: isMasterOutput ? '#f7c948' : source.clip.color,
    createdAt: dispatch.startedAt,
    generatedBy: dispatch.scope.stageId,
    id: clipId,
    lengthTicks: source.clip.lengthTicks,
    name: isMasterOutput ? 'SA3 Master' : 'SA3 A2A Branch',
    sourceClipId: source.clip.id,
    startTick: source.clip.startTick,
    type: isMasterOutput ? 'master' as const : 'instrument-audio' as const,
    version: 1,
  });
  const track: Track = Object.freeze({
    clips: [clip],
    id: trackId,
    level: isMasterOutput ? 0 : source.track.level,
    muted: isMasterOutput,
    name: isMasterOutput ? 'SA3 Master' : 'SA3 A2A',
    type: isMasterOutput ? 'audio' as const : 'generated_audio' as const,
  });

  return Object.freeze({
    clip,
    ok: true as const,
    project: { ...project, tracks: [...project.tracks, track] },
    track,
  });
}

function updateContinuation(
  project: ProjectState,
  patchTabId: string,
  continuation: StableAudio3AudioToAudioContinuationPlan,
  outputClipId: string,
): ProjectState {
  const matches = project.patchTabs.filter(
    (patchTab) => patchTab.id === patchTabId,
  );

  if (matches.length !== 1) {
    throw new Error('Stable Audio 3 A2A PatchTab disappeared before settlement.');
  }

  return {
    ...project,
    patchTabs: project.patchTabs.map(
      (patchTab): PatchTab =>
        patchTab.id === patchTabId
          ? {
              ...patchTab,
              generationContinuation: {
                kind: 'stable-audio-3-audio-to-audio',
                outputClipId,
                recipeFingerprint: continuation.recipeFingerprint,
                sourceClipId: continuation.sourceClipId,
                sourceClipTakeId: continuation.sourceClipTakeId,
              },
            }
          : patchTab,
    ),
  };
}

function findUniqueClipLocation(
  project: ProjectState,
  clipId: string,
): Readonly<{ clip: Clip; track: Track }> | undefined {
  const matches = project.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => clip.id === clipId)
      .map((clip) => ({ clip, track })),
  );

  return matches.length === 1 ? matches[0] : undefined;
}

function failure(
  project: ProjectState,
  reason: Extract<
    StableAudio3AudioToAudioBatchResult,
    { status: 'STAGE_FAILED' }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  StableAudio3AudioToAudioBatchResult,
  { status: 'STAGE_FAILED' }
> {
  return Object.freeze({
    cause,
    message,
    ok: false as const,
    project,
    reason,
    status: 'STAGE_FAILED' as const,
  });
}
