import {
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_TASK_ID,
} from '../shared/aceStepProtocol.js';
import {
  createAceStepJobRequest,
  validateAceStepGuideSource,
  type AceStepJobRequest,
  type AceStepGuideSourceInput,
} from './aceStepJobContract';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { getClipTypeColor } from './clipTypeColors';
import type {
  LocalEngineAceStepLyricsSnapshot,
  LocalEngineClient,
  LocalEngineGpuJobProgress,
  LocalEngineGpuJobRecord,
} from './localEngineClient';
import {
  createCompletedAudioJobRegistration,
  type ProjectArtifactRegistrationFailureReason,
} from './projectArtifactRegistration';
import { doesClipTakeMatchArtifact } from './clipTakeActivation';
import type {
  AudioArtifact,
  AudioClipTake,
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  MidiArtifact,
  MidiClipTake,
  ProjectState,
} from './types';

export type AceStepVocalStageClient = Pick<
  LocalEngineClient,
  | 'cancelJob'
  | 'enqueueAceStepJob'
  | 'getJobs'
  | 'removeQueuedJob'
  | 'saveAceStepLyrics'
>;

export type AceStepVocalStageInput = Readonly<{
  caption: string;
  guideClipId: string;
  label?: string;
  lyrics: string;
  midiClipId: string;
  project: ProjectState;
  seed: number;
  targetClipId: string;
  vocalLanguage: string;
}>;

export type AceStepTextToAudioVocalTarget = Readonly<{
  clipId: string;
  clipName: string;
  createdAt: string;
  trackId: string;
  trackName: string;
}>;

export type AceStepTextToAudioVocalStageInput = Readonly<{
  caption: string;
  guideClipId: string;
  lyrics: string;
  mode: 'stable-audio-3-text-to-audio';
  project: ProjectState;
  seed: number;
  target: AceStepTextToAudioVocalTarget;
  vocalLanguage: string;
}>;

export type AceStepVocalStageOptions = Readonly<{
  maxPollAttempts?: number;
  onProgress?: (progress: Readonly<{
    jobProgress?: LocalEngineGpuJobProgress;
    jobId?: string;
    state: 'SAVING_LYRICS' | 'ENQUEUEING' | LocalEngineGpuJobRecord['state'];
  }>) => void;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  wait?: (delayMs: number) => Promise<void>;
}>;

export const ACE_STEP_PRODUCTION_MONITORING_POLICY: Readonly<
  Required<Pick<AceStepVocalStageOptions, 'maxPollAttempts' | 'pollIntervalMs'>>
> = Object.freeze({
  maxPollAttempts: 3_600,
  pollIntervalMs: 500,
});

export type AceStepVocalStageFailureReason =
  | ProjectArtifactRegistrationFailureReason
  | 'cancellation-failed'
  | 'enqueue-failed'
  | 'input-invalid'
  | 'job-contract-drift'
  | 'job-failed'
  | 'job-missing'
  | 'lyrics-save-failed'
  | 'poll-failed'
  | 'poll-limit-reached'
  | 'progress-failed'
  | 'registration-invalid'
  | 'runner-options-invalid'
  | 'wait-failed';

export type AceStepVocalStageResult =
  | Readonly<{
      artifact: GeneratedAudioArtifact & { destination: 'ace-step' };
      clipTake: GeneratedAudioClipTake;
      job: LocalEngineGpuJobRecord;
      lyricsSnapshot: LocalEngineAceStepLyricsSnapshot;
      ok: true;
      project: ProjectState;
      request: AceStepJobRequest;
      status: 'COMPLETED';
    }>
  | Readonly<{
      job?: LocalEngineGpuJobRecord;
      lyricsSnapshot?: LocalEngineAceStepLyricsSnapshot;
      message: string;
      ok: false;
      project: ProjectState;
      reason:
        | 'canceled-before-enqueue'
        | 'job-canceled'
        | 'queued-job-removed';
      request?: AceStepJobRequest;
      status: 'CANCELED';
    }>
  | Readonly<{
      job?: LocalEngineGpuJobRecord;
      lyricsSnapshot?: LocalEngineAceStepLyricsSnapshot;
      message: string;
      ok: false;
      project: ProjectState;
      reason: AceStepVocalStageFailureReason;
      request?: AceStepJobRequest;
      status: 'FAILED' | 'PENDING';
    }>;

type ExistingVocalResolvedInputs = Readonly<{
  guideArtifact: GeneratedAudioArtifact;
  guideClip: Clip;
  guideSource: Extract<AceStepGuideSourceInput, { kind: 'midi-instrument-guide' }>;
  midiArtifact: MidiArtifact;
  midiClip: Clip;
  midiClipTake: MidiClipTake;
  targetClip: Clip;
}>;

type TextToAudioResolvedInputs = Readonly<{
  guideArtifact: GeneratedAudioArtifact;
  guideClip: Clip;
  guideClipTake: GeneratedAudioClipTake;
  guideSource: Extract<
    AceStepGuideSourceInput,
    { kind: 'stable-audio-3-text-to-audio' }
  >;
}>;

type ResolvedInputs = ExistingVocalResolvedInputs | TextToAudioResolvedInputs;

export type AceStepVocalTargetResolution =
  | Readonly<{
      canResolve: true;
      guideClipId: string;
      guideClipName: string;
      guideDurationSeconds: number;
      midiClipId: string;
      midiClipName: string;
      targetClipId: string;
      targetClipName: string;
    }>
  | Readonly<{
      canResolve: false;
      message: string;
    }>;

export type AceStepTextToAudioGuideResolution =
  | Readonly<{
      canResolve: true;
      guideArtifactId: string;
      guideClipId: string;
      guideClipTakeId: string;
      guideDurationSeconds: number;
      guideLengthTicks: number;
      guideStartTick: number;
    }>
  | Readonly<{ canResolve: false; message: string }>;

export function resolveAceStepVocalTarget(
  project: ProjectState,
  targetClipId: string,
): AceStepVocalTargetResolution {
  const resolved = resolveStageInputs(project, { targetClipId });

  if (!resolved.ok) {
    return Object.freeze({ canResolve: false as const, message: resolved.message });
  }

  return Object.freeze({
    canResolve: true as const,
    guideClipId: resolved.value.guideClip.id,
    guideClipName: resolved.value.guideClip.name,
    guideDurationSeconds: resolved.value.guideArtifact.audio.durationSeconds,
    midiClipId: resolved.value.midiClip.id,
    midiClipName: resolved.value.midiClip.name,
    targetClipId: resolved.value.targetClip.id,
    targetClipName: resolved.value.targetClip.name,
  });
}

export function resolveAceStepTextToAudioGuide(
  project: ProjectState,
  guideClipId: string,
): AceStepTextToAudioGuideResolution {
  const resolved = resolveTextToAudioInputs(project, guideClipId);

  if (!resolved.ok) {
    return Object.freeze({ canResolve: false as const, message: resolved.message });
  }

  return Object.freeze({
    canResolve: true as const,
    guideArtifactId: resolved.value.guideArtifact.artifactId,
    guideClipId: resolved.value.guideClip.id,
    guideClipTakeId: resolved.value.guideClipTake.clipTakeId,
    guideDurationSeconds: resolved.value.guideArtifact.audio.durationSeconds,
    guideLengthTicks: resolved.value.guideClip.lengthTicks,
    guideStartTick: resolved.value.guideClip.startTick,
  });
}

export async function runAceStepVocalStage(
  client: AceStepVocalStageClient,
  input: AceStepVocalStageInput,
  options: AceStepVocalStageOptions = {},
): Promise<AceStepVocalStageResult> {
  const resolved = resolveStageInputs(input.project, input);
  return runResolvedAceStepVocalStage(client, input, resolved, options);
}

export async function runAceStepTextToAudioVocalStage(
  client: AceStepVocalStageClient,
  input: AceStepTextToAudioVocalStageInput,
  options: AceStepVocalStageOptions = {},
): Promise<AceStepVocalStageResult> {
  const resolved = resolveTextToAudioInputs(input.project, input.guideClipId);
  return runResolvedAceStepVocalStage(client, input, resolved, options);
}

async function runResolvedAceStepVocalStage(
  client: AceStepVocalStageClient,
  input: AceStepVocalStageInput | AceStepTextToAudioVocalStageInput,
  resolved:
    | Readonly<{ ok: true; value: ResolvedInputs }>
    | Readonly<{ message: string; ok: false }>,
  options: AceStepVocalStageOptions,
): Promise<AceStepVocalStageResult> {
  const maxPollAttempts = options.maxPollAttempts ?? 900;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const wait = options.wait ?? waitForDelay;

  if (
    !Number.isSafeInteger(maxPollAttempts) ||
    maxPollAttempts < 1 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    typeof wait !== 'function'
  ) {
    return fail(
      input.project,
      'runner-options-invalid',
      'ACE-Step Stage polling options are invalid.',
    );
  }

  if (options.signal?.aborted) {
    return canceled(
      input.project,
      'canceled-before-enqueue',
      'ACE Vocals preparation was canceled before Lyrics were saved.',
    );
  }

  if (!resolved.ok) {
    return fail(input.project, 'input-invalid', resolved.message);
  }

  const lyricsProgress = notifyProgress(options.onProgress, {
    state: 'SAVING_LYRICS',
  });

  if (!lyricsProgress.ok) {
    return fail(input.project, 'progress-failed', lyricsProgress.message);
  }

  let lyricsSave: Awaited<
    ReturnType<AceStepVocalStageClient['saveAceStepLyrics']>
  >;

  try {
    lyricsSave = await client.saveAceStepLyrics(input.lyrics);
  } catch (error) {
    return fail(
      input.project,
      'lyrics-save-failed',
      errorMessage(error, 'ACE-Step Lyrics save threw an exception.'),
    );
  }

  if (!lyricsSave.ok) {
    return fail(
      input.project,
      'lyrics-save-failed',
      lyricsSave.message,
    );
  }

  const lyricsSnapshot = lyricsSave.lyricsSnapshot;

  if (options.signal?.aborted) {
    return canceled(
      input.project,
      'canceled-before-enqueue',
      'ACE Vocals preparation was canceled before Job enqueue.',
      { lyricsSnapshot },
    );
  }

  let request: AceStepJobRequest;

  try {
    request = createAceStepJobRequest({
      caption: input.caption,
      durationSeconds: resolved.value.guideArtifact.audio.durationSeconds,
      guideSource: resolved.value.guideSource,
      lyricsSnapshot,
      modelId: ACE_STEP_MODEL_ID,
      modelRevision: ACE_STEP_MODEL_REVISION,
      providerId: ACE_STEP_PROVIDER_ID,
      seed: input.seed,
      vocalLanguage: input.vocalLanguage,
    });
  } catch (error) {
    return fail(
      input.project,
      'input-invalid',
      errorMessage(error, 'ACE-Step Job request construction failed.'),
      { lyricsSnapshot },
    );
  }

  const enqueueProgress = notifyProgress(options.onProgress, {
    state: 'ENQUEUEING',
  });

  if (!enqueueProgress.ok) {
    return fail(input.project, 'progress-failed', enqueueProgress.message, {
      lyricsSnapshot,
      request,
    });
  }

  if (options.signal?.aborted) {
    return canceled(
      input.project,
      'canceled-before-enqueue',
      'ACE Vocals preparation was canceled before Job enqueue.',
      { lyricsSnapshot, request },
    );
  }

  let enqueue: Awaited<ReturnType<AceStepVocalStageClient['enqueueAceStepJob']>>;

  try {
    enqueue = await client.enqueueAceStepJob(request);
  } catch (error) {
    return fail(
      input.project,
      'enqueue-failed',
      errorMessage(error, 'ACE-Step Job enqueue threw an exception.'),
      { lyricsSnapshot, request },
    );
  }

  if (!enqueue.ok) {
    return fail(input.project, 'enqueue-failed', enqueue.message, {
      lyricsSnapshot,
      request,
    });
  }

  let job = enqueue.job;
  let cancellationRequested = false;

  for (let attempt = 0; attempt <= maxPollAttempts; attempt += 1) {
    const observed = observeJob(job, request);

    if (!observed.ok) {
      return fail(input.project, 'job-contract-drift', observed.message, {
        job,
        lyricsSnapshot,
        request,
      });
    }

    const progress = notifyProgress(options.onProgress, {
      ...(job.progress ? { jobProgress: job.progress } : {}),
      jobId: job.jobId,
      state: job.state,
    });

    if (!progress.ok) {
      return fail(input.project, 'progress-failed', progress.message, {
        job,
        lyricsSnapshot,
        request,
      });
    }

    if (job.state === 'COMPLETED') {
      return registerCompletedJob(
        input.project,
        input,
        resolved.value,
        request,
        lyricsSnapshot,
        job,
      );
    }

    if (job.state === 'CANCELED') {
      return canceled(
        input.project,
        'job-canceled',
        `ACE-Step Job ${job.jobId} was canceled.`,
        { job, lyricsSnapshot, request },
      );
    }

    if (job.state === 'FAILED' || job.state === 'INTERRUPTED') {
      return fail(
        input.project,
        'job-failed',
        job.error?.message ?? `ACE-Step Job ended as ${job.state}.`,
        { job, lyricsSnapshot, request },
      );
    }

    const cancellation = await reactToCancellation(
      client,
      input.project,
      request,
      lyricsSnapshot,
      job,
      cancellationRequested,
      options.signal,
    );

    if (cancellation.result) {
      return cancellation.result;
    }

    if (cancellation.job.state !== job.state) {
      const cancellationProgress = notifyProgress(options.onProgress, {
        ...(cancellation.job.progress
          ? { jobProgress: cancellation.job.progress }
          : {}),
        jobId: cancellation.job.jobId,
        state: cancellation.job.state,
      });

      if (!cancellationProgress.ok) {
        return fail(
          input.project,
          'progress-failed',
          cancellationProgress.message,
          { job: cancellation.job, lyricsSnapshot, request },
        );
      }
    }

    cancellationRequested = cancellation.cancellationRequested;
    job = cancellation.job;

    if (attempt === maxPollAttempts) {
      return {
        job,
        lyricsSnapshot,
        message: `ACE-Step Job ${job.jobId} remains ${job.state}.`,
        ok: false,
        project: input.project,
        reason: 'poll-limit-reached',
        request,
        status: 'PENDING',
      };
    }

    try {
      await wait(pollIntervalMs);
    } catch (error) {
      return fail(
        input.project,
        'wait-failed',
        errorMessage(error, 'ACE-Step Job polling wait failed.'),
        { job, lyricsSnapshot, request },
      );
    }

    let snapshot: Awaited<ReturnType<AceStepVocalStageClient['getJobs']>>;

    try {
      snapshot = await client.getJobs();
    } catch (error) {
      return fail(
        input.project,
        'poll-failed',
        errorMessage(error, 'ACE-Step Job polling threw an exception.'),
        { job, lyricsSnapshot, request },
      );
    }

    if (!snapshot.ok) {
      return fail(input.project, 'poll-failed', snapshot.message, {
        job,
        lyricsSnapshot,
        request,
      });
    }

    const nextJob = snapshot.snapshot.jobs.find(
      (candidate) => candidate.jobId === job.jobId,
    );

    if (!nextJob) {
      return fail(
        input.project,
        'job-missing',
        `Local Engine no longer reports ACE-Step Job ${job.jobId}.`,
        { job, lyricsSnapshot, request },
      );
    }

    job = nextJob;
  }

  return fail(
    input.project,
    'poll-failed',
    'ACE-Step Stage reached an unreachable polling state.',
    { job, lyricsSnapshot, request },
  );
}

type CancellationReaction = Readonly<{
  cancellationRequested: boolean;
  job: LocalEngineGpuJobRecord;
  result?: AceStepVocalStageResult;
}>;

async function reactToCancellation(
  client: AceStepVocalStageClient,
  project: ProjectState,
  request: AceStepJobRequest,
  lyricsSnapshot: LocalEngineAceStepLyricsSnapshot,
  job: LocalEngineGpuJobRecord,
  cancellationRequested: boolean,
  signal: AbortSignal | undefined,
): Promise<CancellationReaction> {
  if (!signal?.aborted || job.state === 'SAVING') {
    return { cancellationRequested, job };
  }

  if (job.state === 'CANCEL_REQUESTED') {
    return { cancellationRequested: true, job };
  }

  if (job.state === 'QUEUED') {
    let removal: Awaited<
      ReturnType<AceStepVocalStageClient['removeQueuedJob']>
    >;

    try {
      removal = await client.removeQueuedJob(job.jobId);
    } catch (error) {
      return {
        cancellationRequested,
        job,
        result: fail(
          project,
          'cancellation-failed',
          errorMessage(error, 'ACE-Step queued Job removal threw an exception.'),
          { job, lyricsSnapshot, request },
        ),
      };
    }

    if (!removal.ok) {
      return removal.status === 409
        ? { cancellationRequested, job }
        : {
            cancellationRequested,
            job,
            result: fail(
              project,
              'cancellation-failed',
              removal.message,
              { job, lyricsSnapshot, request },
            ),
          };
    }

    const removedJob = removal.removedJob;
    const observed = observeJob(removedJob, request);

    if (
      removedJob.jobId !== job.jobId ||
      removedJob.state !== 'QUEUED' ||
      !observed.ok
    ) {
      return {
        cancellationRequested,
        job,
        result: fail(
          project,
          'cancellation-failed',
          'ACE-Step queued Job removal returned a mismatched Job.',
          { job, lyricsSnapshot, request },
        ),
      };
    }

    return {
      cancellationRequested,
      job,
      result: canceled(
        project,
        'queued-job-removed',
        `ACE-Step Job ${job.jobId} was removed before execution.`,
        { job: removedJob, lyricsSnapshot, request },
      ),
    };
  }

  if (job.state !== 'LOADING_MODEL' && job.state !== 'PROCESSING') {
    return { cancellationRequested, job };
  }

  if (cancellationRequested) {
    return { cancellationRequested, job };
  }

  let cancellation: Awaited<ReturnType<AceStepVocalStageClient['cancelJob']>>;

  try {
    cancellation = await client.cancelJob(job.jobId);
  } catch (error) {
    return {
      cancellationRequested,
      job,
      result: fail(
        project,
        'cancellation-failed',
        errorMessage(error, 'ACE-Step active Job cancellation threw an exception.'),
        { job, lyricsSnapshot, request },
      ),
    };
  }

  if (!cancellation.ok) {
    return cancellation.status === 409
      ? { cancellationRequested: true, job }
      : {
          cancellationRequested,
          job,
          result: fail(
            project,
            'cancellation-failed',
            cancellation.message,
            { job, lyricsSnapshot, request },
          ),
        };
  }

  const canceledJob = cancellation.job;
  const observed = observeJob(canceledJob, request);

  if (
    canceledJob.jobId !== job.jobId ||
    !observed.ok ||
    (canceledJob.state !== 'CANCEL_REQUESTED' &&
      canceledJob.state !== 'CANCELED')
  ) {
    return {
      cancellationRequested,
      job,
      result: fail(
        project,
        'cancellation-failed',
        'ACE-Step cancellation returned a mismatched Job.',
        { job, lyricsSnapshot, request },
      ),
    };
  }

  if (canceledJob.state === 'CANCELED') {
    return {
      cancellationRequested: true,
      job: canceledJob,
      result: canceled(
        project,
        'job-canceled',
        `ACE-Step Job ${job.jobId} was canceled.`,
        { job: canceledJob, lyricsSnapshot, request },
      ),
    };
  }

  return {
    cancellationRequested: true,
    job: canceledJob,
  };
}

function resolveStageInputs(
  project: ProjectState,
  input: Readonly<{
    guideClipId?: string;
    midiClipId?: string;
    targetClipId: string;
  }>,
):
  | Readonly<{ ok: true; value: ExistingVocalResolvedInputs }>
  | Readonly<{ message: string; ok: false }> {
  const targetClip = findUniqueClip(project, input.targetClipId);
  const guideClip = targetClip?.sourceClipId
    ? findUniqueClip(project, targetClip.sourceClipId)
    : undefined;
  const midiClip = guideClip?.sourceClipId
    ? findUniqueClip(project, guideClip.sourceClipId)
    : undefined;

  if (!midiClip || !guideClip || !targetClip) {
    return { message: 'ACE-Step Stage Clip identities must resolve uniquely.', ok: false };
  }

  if (
    (input.guideClipId !== undefined && input.guideClipId !== guideClip.id) ||
    (input.midiClipId !== undefined && input.midiClipId !== midiClip.id) ||
    (midiClip.type !== 'midi-notes' && midiClip.type !== 'edited-midi') ||
    guideClip.type !== 'instrument-audio' ||
    guideClip.sourceClipId !== midiClip.id ||
    targetClip.type !== 'vocal-audio' ||
    targetClip.sourceClipId !== guideClip.id
  ) {
    return {
      message: 'ACE-Step Stage requires MIDI -> Instrument Guide -> Vocal Clip roles.',
      ok: false,
    };
  }

  const midiClipTake = findActiveTake(midiClip, 'midi');
  const guideClipTake = findActiveTake(guideClip, 'audio');
  const targetClipTake = findActiveTake(targetClip, 'audio');

  if (!midiClipTake || !guideClipTake || !targetClipTake) {
    return {
      message:
        'ACE-Step Stage requires active corrected MIDI, Guide Audio, and existing Vocal Takes.',
      ok: false,
    };
  }

  const midiArtifacts = project.artifacts?.filter(
    (artifact): artifact is MidiArtifact =>
      artifact.kind === 'midi' && artifact.artifactId === midiClipTake.artifactId,
  ) ?? [];
  const guideArtifacts = project.artifacts?.filter(
    (artifact): artifact is GeneratedAudioArtifact =>
      artifact.kind === 'audio' &&
      'sourceJobId' in artifact &&
      artifact.artifactId === guideClipTake.artifactId,
  ) ?? [];
  const targetArtifacts = project.artifacts?.filter(
    (artifact): artifact is AudioArtifact =>
      artifact.kind === 'audio' &&
      artifact.artifactId === targetClipTake.artifactId,
  ) ?? [];
  const [midiArtifact] = midiArtifacts;
  const [guideArtifact] = guideArtifacts;
  const [targetArtifact] = targetArtifacts;

  if (
    midiArtifacts.length !== 1 ||
    guideArtifacts.length !== 1 ||
    targetArtifacts.length !== 1 ||
    !midiArtifact ||
    !guideArtifact ||
    !targetArtifact ||
    !doesClipTakeMatchArtifact(midiClipTake, midiArtifact) ||
    !doesClipTakeMatchArtifact(guideClipTake, guideArtifact) ||
    !doesClipTakeMatchArtifact(targetClipTake, targetArtifact)
  ) {
    return {
      message:
        'ACE-Step Stage active Takes must resolve uniquely to matching Project Artifacts.',
      ok: false,
    };
  }

  return {
    ok: true,
    value: Object.freeze({
      guideArtifact,
      guideClip,
      guideSource: Object.freeze({
        guideAudioArtifact: guideArtifact,
        kind: 'midi-instrument-guide' as const,
        midiArtifact,
        midiClipTake,
      }),
      midiArtifact,
      midiClip,
      midiClipTake,
      targetClip,
    }),
  };
}

function resolveTextToAudioInputs(
  project: ProjectState,
  guideClipId: string,
):
  | Readonly<{ ok: true; value: TextToAudioResolvedInputs }>
  | Readonly<{ message: string; ok: false }> {
  const guideClip = findUniqueClip(project, guideClipId);

  if (!guideClip || guideClip.type !== 'ai-fill-audio') {
    return {
      message: 'ACE-Step T2A Guide must resolve to one generated Audio Clip.',
      ok: false,
    };
  }

  const activeSource = resolveActiveAudioTakeSource(project, guideClip.id);

  if (!activeSource.canResolve) {
    return {
      message: `ACE-Step T2A Guide is unavailable: ${activeSource.message}`,
      ok: false,
    };
  }

  const guideClipTake = findActiveTake(guideClip, 'audio');

  if (
    !guideClipTake ||
    guideClipTake.sourceType !== 'job' ||
    guideClipTake.clipTakeId !== activeSource.plan.source.clipTakeId ||
    guideClipTake.artifactId !== activeSource.plan.source.artifactId
  ) {
    return {
      message: 'ACE-Step T2A Guide requires one Active generated Audio Take.',
      ok: false,
    };
  }

  const guideArtifacts = (project.artifacts ?? []).filter(
    (artifact): artifact is GeneratedAudioArtifact =>
      artifact.kind === 'audio' &&
      'sourceJobId' in artifact &&
      artifact.artifactId === guideClipTake.artifactId,
  );
  const [guideArtifact] = guideArtifacts;

  if (
    guideArtifacts.length !== 1 ||
    !guideArtifact ||
    !doesClipTakeMatchArtifact(guideClipTake, guideArtifact)
  ) {
    return {
      message:
        'ACE-Step T2A Guide Active Take must resolve uniquely to one matching Project Artifact.',
      ok: false,
    };
  }

  const guideSource = Object.freeze({
    guideAudioArtifact: guideArtifact,
    guideClipTake,
    kind: 'stable-audio-3-text-to-audio' as const,
  });

  try {
    validateAceStepGuideSource(guideSource);
  } catch (error) {
    return {
      message:
        error instanceof Error
          ? error.message
          : 'ACE-Step T2A Guide is invalid.',
      ok: false,
    };
  }

  return {
    ok: true,
    value: Object.freeze({
      guideArtifact,
      guideClip,
      guideClipTake,
      guideSource,
    }),
  };
}

function registerCompletedJob(
  project: ProjectState,
  input: AceStepVocalStageInput | AceStepTextToAudioVocalStageInput,
  resolved: ResolvedInputs,
  request: AceStepJobRequest,
  lyricsSnapshot: LocalEngineAceStepLyricsSnapshot,
  job: LocalEngineGpuJobRecord,
): AceStepVocalStageResult {
  if (!areJsonValuesEqual(job.request, request)) {
    return fail(
      project,
      'job-contract-drift',
      'Completed ACE-Step Job no longer matches its immutable Stage request.',
      { job, lyricsSnapshot, request },
    );
  }

  const target = prepareRegistrationTarget(project, input, resolved);

  if (!target.ok) {
    return fail(project, 'registration-invalid', target.message, {
      job,
      lyricsSnapshot,
      request,
    });
  }

  const registration = createCompletedAudioJobRegistration(target.project, job, {
    activate: target.activate,
    clipId: target.clipId,
    label: target.label,
  });

  if (!registration.canRegister) {
    return fail(project, registration.reason, registration.message, {
      job,
      lyricsSnapshot,
      request,
    });
  }

  const { artifact, clipTake } = registration;

  if (
    artifact.kind !== 'audio' ||
    artifact.destination !== ACE_STEP_OUTPUT_DESTINATION ||
    artifact.provenance.providerId !== ACE_STEP_PROVIDER_ID ||
    artifact.provenance.modelId !== ACE_STEP_MODEL_ID ||
    artifact.provenance.modelRevision !== ACE_STEP_MODEL_REVISION ||
    artifact.provenance.taskId !== ACE_STEP_TASK_ID ||
    artifact.audio.channels !== 2 ||
    artifact.audio.mimeType !== 'audio/wav' ||
    artifact.file.extension !== '.wav' ||
    !artifact.file.relativePath.startsWith('renders/ace-step/') ||
    clipTake.mediaType !== 'audio' ||
    clipTake.sourceType !== 'job' ||
    clipTake.sourceJobId !== job.jobId
  ) {
    return fail(
      project,
      'registration-invalid',
      'Completed ACE-Step Job did not produce one finalized Vocal Audio Take.',
      { job, lyricsSnapshot, request },
    );
  }

  return {
    artifact: artifact as GeneratedAudioArtifact & { destination: 'ace-step' },
    clipTake,
    job,
    lyricsSnapshot,
    ok: true,
    project: registration.project,
    request,
    status: 'COMPLETED',
  };
}

function prepareRegistrationTarget(
  project: ProjectState,
  input: AceStepVocalStageInput | AceStepTextToAudioVocalStageInput,
  resolved: ResolvedInputs,
):
  | Readonly<{
      activate: boolean;
      clipId: string;
      label: string;
      ok: true;
      project: ProjectState;
    }>
  | Readonly<{ message: string; ok: false }> {
  if (!('mode' in input)) {
    if (!('targetClip' in resolved) || resolved.targetClip.id !== input.targetClipId) {
      return { message: 'Existing ACE Vocal target identity changed.', ok: false };
    }

    return {
      activate: false,
      clipId: input.targetClipId,
      label: input.label ?? 'ACE-Step Vocal Take',
      ok: true,
      project,
    };
  }

  if ('targetClip' in resolved) {
    return { message: 'ACE T2A target mode is inconsistent.', ok: false };
  }

  const ids = new Set([
    ...project.tracks.map((track) => track.id),
    ...project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  ]);
  const { target } = input;

  if (
    !isNewTargetId(target.trackId) ||
    !isNewTargetId(target.clipId) ||
    target.trackId === target.clipId ||
    ids.has(target.trackId) ||
    ids.has(target.clipId) ||
    !isNewTargetName(target.trackName) ||
    !isNewTargetName(target.clipName) ||
    Number.isNaN(Date.parse(target.createdAt))
  ) {
    return { message: 'ACE T2A Vocal target identity is invalid or colliding.', ok: false };
  }

  const clip: Clip = {
    color: getClipTypeColor('vocal-audio'),
    createdAt: target.createdAt,
    generatedBy: 'ACE Vocals',
    id: target.clipId,
    lengthTicks: resolved.guideClip.lengthTicks,
    name: target.clipName,
    sourceClipId: resolved.guideClip.id,
    startTick: resolved.guideClip.startTick,
    type: 'vocal-audio',
    version: 1,
  };
  const nextProject: ProjectState = {
    ...project,
    tracks: [
      ...project.tracks,
      {
        clips: [clip],
        id: target.trackId,
        level: 0,
        muted: false,
        name: target.trackName,
        type: 'vocal',
      },
    ],
  };

  return {
    activate: true,
    clipId: target.clipId,
    label: 'ACE-Step Vocal Take',
    ok: true,
    project: nextProject,
  };
}

function isNewTargetId(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isNewTargetName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && value.trim() === value;
}

function observeJob(
  job: LocalEngineGpuJobRecord,
  request: AceStepJobRequest,
): Readonly<{ ok: true }> | Readonly<{ message: string; ok: false }> {
  return job.providerId === request.providerId &&
    job.modelId === request.modelId &&
    job.modelRevision === request.modelRevision &&
    job.taskId === request.taskId &&
    areJsonValuesEqual(job.request, request)
    ? { ok: true }
    : {
        message: 'Observed ACE-Step Job identity or immutable request changed.',
        ok: false,
      };
}

function findUniqueClip(project: ProjectState, clipId: string): Clip | undefined {
  const matches = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);
  return matches.length === 1 ? matches[0] : undefined;
}

function findActiveTake(
  clip: Clip,
  mediaType: 'audio',
): AudioClipTake | undefined;
function findActiveTake(
  clip: Clip,
  mediaType: 'midi',
): MidiClipTake | undefined;
function findActiveTake(clip: Clip, mediaType: 'audio' | 'midi') {
  return clip.clipTakes?.find(
    (take) =>
      take.clipTakeId === clip.activeClipTakeId && take.mediaType === mediaType,
  );
}

function notifyProgress(
  callback: AceStepVocalStageOptions['onProgress'],
  progress: Parameters<NonNullable<AceStepVocalStageOptions['onProgress']>>[0],
): Readonly<{ ok: true }> | Readonly<{ message: string; ok: false }> {
  if (!callback) {
    return { ok: true };
  }

  try {
    callback(progress);
    return { ok: true };
  } catch (error) {
    return {
      message: errorMessage(error, 'ACE-Step Stage progress callback failed.'),
      ok: false,
    };
  }
}

function canceled(
  project: ProjectState,
  reason: Extract<
    AceStepVocalStageResult,
    { status: 'CANCELED' }
  >['reason'],
  message: string,
  details: Readonly<{
    job?: LocalEngineGpuJobRecord;
    lyricsSnapshot?: LocalEngineAceStepLyricsSnapshot;
    request?: AceStepJobRequest;
  }> = {},
): Extract<AceStepVocalStageResult, { status: 'CANCELED' }> {
  return {
    ...details,
    message,
    ok: false,
    project,
    reason,
    status: 'CANCELED',
  };
}

function fail(
  project: ProjectState,
  reason: AceStepVocalStageFailureReason,
  message: string,
  details: Readonly<{
    job?: LocalEngineGpuJobRecord;
    lyricsSnapshot?: LocalEngineAceStepLyricsSnapshot;
    request?: AceStepJobRequest;
  }> = {},
): AceStepVocalStageResult {
  return {
    ...details,
    message,
    ok: false,
    project,
    reason,
    status: 'FAILED',
  };
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
      left.every((value, index) => areJsonValuesEqual(value, right[index]))
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

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
