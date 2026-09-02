import type {
  LocalEngineClient,
  LocalEngineGpuJobProgress,
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineClient';
import type { StableAudio3TextToAudioJobPlan } from './stableAudio3TextToAudioCapability';
import { createStableAudio3TextToAudioJobRequest } from './stableAudio3TextToAudioJobContract';

export type StableAudio3TextToAudioRunnerClient = Pick<
  LocalEngineClient,
  | 'cancelJob'
  | 'enqueueStableAudio3Job'
  | 'getJobs'
  | 'removeQueuedJob'
>;

export type StableAudio3TextToAudioRunnerProgress = Readonly<{
  jobProgress?: LocalEngineGpuJobProgress;
  jobId?: string;
  state: 'ENQUEUEING' | LocalEngineGpuJobState;
}>;

export type StableAudio3TextToAudioRunnerOptions = Readonly<{
  maxPollAttempts?: number;
  onProgress?: (progress: StableAudio3TextToAudioRunnerProgress) => void;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  wait?: (delayMs: number) => Promise<void>;
}>;

export type StableAudio3TextToAudioRunnerResult =
  | Readonly<{
      job: LocalEngineGpuJobRecord;
      jobId: string;
      ok: true;
      status: 'JOB_COMPLETED';
    }>
  | Readonly<{
      job: LocalEngineGpuJobRecord;
      jobId: string;
      ok: false;
      reason: 'cancellation-unsupported' | 'poll-limit-reached';
      status: 'JOB_PENDING';
    }>
  | Readonly<{
      job: LocalEngineGpuJobRecord;
      jobId: string;
      message: string;
      ok: false;
      reason: 'job-canceled';
      status: 'JOB_CANCELED';
    }>
  | Readonly<{
      cause: string;
      job: LocalEngineGpuJobRecord;
      jobId: string;
      message: string;
      ok: false;
      reason: 'job-failed';
      status: 'JOB_FAILED';
    }>
  | Readonly<{
      cause: string;
      jobId?: string;
      message: string;
      ok: false;
      reason: 'canceled-before-enqueue' | 'queued-job-removed';
      status: 'RUN_CANCELED';
    }>
  | Readonly<{
      cause: string;
      jobId?: string;
      message: string;
      ok: false;
      reason:
        | 'cancellation-failed'
        | 'enqueue-failed'
        | 'job-missing'
        | 'job-plan-mismatch'
        | 'poll-failed'
        | 'progress-failed'
        | 'runner-options-invalid'
        | 'wait-failed';
      status: 'RUNNER_FAILED';
    }>;

const FAILED_JOB_STATES = new Set<LocalEngineGpuJobState>([
  'FAILED',
  'INTERRUPTED',
  'PAUSED',
]);

export async function runStableAudio3TextToAudioPlan(
  client: StableAudio3TextToAudioRunnerClient,
  plan: StableAudio3TextToAudioJobPlan,
  options: StableAudio3TextToAudioRunnerOptions = {},
): Promise<StableAudio3TextToAudioRunnerResult> {
  const maxPollAttempts = options.maxPollAttempts ?? 18_600;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const wait = options.wait ?? waitForDelay;

  if (
    !Number.isSafeInteger(maxPollAttempts) ||
    maxPollAttempts < 1 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    typeof wait !== 'function'
  ) {
    return runnerFailure(
      'runner-options-invalid',
      'stable-audio-3-t2a-runner-options-invalid',
      'SA3 T2A Runner polling options are invalid.',
    );
  }

  const expectedRequest = resolveExpectedRequest(plan);

  if (!expectedRequest) {
    return runnerFailure(
      'job-plan-mismatch',
      'stable-audio-3-t2a-runner-plan-invalid',
      'SA3 T2A Runner requires one exact immutable text-to-audio Job plan.',
    );
  }

  if (options.signal?.aborted) {
    return runCanceled(
      'canceled-before-enqueue',
      'stable-audio-3-t2a-run-canceled-before-enqueue',
      'SA3 T2A was canceled before Job enqueue.',
    );
  }

  const enqueueProgress = notifyProgress(options.onProgress, {
    state: 'ENQUEUEING',
  });

  if (!enqueueProgress.ok) {
    return runnerFailure(
      'progress-failed',
      'stable-audio-3-t2a-progress-callback-failed',
      enqueueProgress.message,
    );
  }

  let enqueue: Awaited<
    ReturnType<StableAudio3TextToAudioRunnerClient['enqueueStableAudio3Job']>
  >;

  try {
    enqueue = await client.enqueueStableAudio3Job(expectedRequest);
  } catch (error) {
    return runnerFailure(
      'enqueue-failed',
      'stable-audio-3-t2a-enqueue-exception',
      errorMessage(error, 'SA3 T2A Job enqueue threw an exception.'),
    );
  }

  if (!enqueue.ok) {
    return runnerFailure(
      'enqueue-failed',
      `stable-audio-3-t2a-enqueue-${enqueue.reason}`,
      enqueue.message,
    );
  }

  const jobId = enqueue.job.jobId;
  let currentJob = enqueue.job;
  let lastProgressUpdatedAt: string | undefined;
  let lastProgressState: LocalEngineGpuJobState | undefined;
  let cancellationRequested = false;

  for (let attempt = 0; attempt <= maxPollAttempts; attempt += 1) {
    if (!doesJobMatchRequest(currentJob, expectedRequest)) {
      return runnerFailure(
        'job-plan-mismatch',
        'stable-audio-3-t2a-job-plan-mismatch',
        'Observed SA3 T2A Job does not match the immutable request plan.',
        jobId,
      );
    }

    const progress = notifyProgressIfChanged(
      options.onProgress,
      currentJob,
      lastProgressState,
      lastProgressUpdatedAt,
    );

    if (!progress.ok) {
      return runnerFailure(
        'progress-failed',
        'stable-audio-3-t2a-progress-callback-failed',
        progress.message,
        jobId,
      );
    }

    lastProgressState = currentJob.state;
    lastProgressUpdatedAt = currentJob.progress?.updatedAt;
    const terminal = createTerminalResult(currentJob);

    if (terminal) {
      return terminal;
    }

    if (options.signal?.aborted) {
      const cancellation = await reactToCancellation(
        client,
        plan,
        currentJob,
        cancellationRequested,
      );

      if (cancellation.result) {
        return cancellation.result;
      }

      cancellationRequested = cancellation.cancellationRequested;

      if (cancellation.job) {
        currentJob = cancellation.job;
        continue;
      }
    }

    if (attempt === maxPollAttempts) {
      return Object.freeze({
        job: currentJob,
        jobId,
        ok: false as const,
        reason: 'poll-limit-reached' as const,
        status: 'JOB_PENDING' as const,
      });
    }

    try {
      await wait(pollIntervalMs);
    } catch (error) {
      return runnerFailure(
        'wait-failed',
        'stable-audio-3-t2a-wait-exception',
        errorMessage(error, 'SA3 T2A polling wait threw an exception.'),
        jobId,
      );
    }

    let snapshot: Awaited<
      ReturnType<StableAudio3TextToAudioRunnerClient['getJobs']>
    >;

    try {
      snapshot = await client.getJobs();
    } catch (error) {
      return runnerFailure(
        'poll-failed',
        'stable-audio-3-t2a-job-poll-exception',
        errorMessage(error, 'SA3 T2A Job polling threw an exception.'),
        jobId,
      );
    }

    if (!snapshot.ok) {
      return runnerFailure(
        'poll-failed',
        `stable-audio-3-t2a-job-poll-${snapshot.reason}`,
        snapshot.message,
        jobId,
      );
    }

    const observedJob = snapshot.snapshot.jobs.find(
      (candidate) => candidate.jobId === jobId,
    );

    if (!observedJob) {
      return runnerFailure(
        'job-missing',
        'stable-audio-3-t2a-job-missing',
        `Local Engine no longer reports SA3 T2A Job ${jobId}.`,
        jobId,
      );
    }

    currentJob = observedJob;
  }

  return runnerFailure(
    'poll-failed',
    'stable-audio-3-t2a-runner-unreachable',
    'SA3 T2A Runner reached an invalid polling state.',
    jobId,
  );
}

type CancellationReaction = Readonly<{
  cancellationRequested: boolean;
  job?: LocalEngineGpuJobRecord;
  result?: StableAudio3TextToAudioRunnerResult;
}>;

async function reactToCancellation(
  client: StableAudio3TextToAudioRunnerClient,
  plan: StableAudio3TextToAudioJobPlan,
  job: LocalEngineGpuJobRecord,
  cancellationRequested: boolean,
): Promise<CancellationReaction> {
  if (job.state === 'SAVING') {
    return { cancellationRequested };
  }

  if (job.state === 'QUEUED') {
    let removal: Awaited<
      ReturnType<StableAudio3TextToAudioRunnerClient['removeQueuedJob']>
    >;

    try {
      removal = await client.removeQueuedJob(job.jobId);
    } catch (error) {
      return {
        cancellationRequested,
        result: runnerFailure(
          'cancellation-failed',
          'stable-audio-3-t2a-queued-removal-exception',
          errorMessage(error, 'SA3 T2A queued Job removal threw an exception.'),
          job.jobId,
        ),
      };
    }

    if (!removal.ok) {
      return removal.status === 409
        ? { cancellationRequested }
        : {
            cancellationRequested,
            result: runnerFailure(
              'cancellation-failed',
              `stable-audio-3-t2a-queued-removal-${removal.reason}`,
              removal.message,
              job.jobId,
            ),
          };
    }

    if (
      removal.removedJob.jobId !== job.jobId ||
      !doesJobMatchRequest(removal.removedJob, plan.request)
    ) {
      return {
        cancellationRequested,
        result: runnerFailure(
          'cancellation-failed',
          'stable-audio-3-t2a-queued-removal-response-invalid',
          'SA3 T2A queued Job removal returned a mismatched Job.',
          job.jobId,
        ),
      };
    }

    return {
      cancellationRequested: true,
      result: runCanceled(
        'queued-job-removed',
        'stable-audio-3-t2a-queued-job-removed',
        `SA3 T2A Job ${job.jobId} was removed before execution.`,
        job.jobId,
      ),
    };
  }

  if (!plan.runtime.supportsCancellation) {
    return {
      cancellationRequested,
      result: Object.freeze({
        job,
        jobId: job.jobId,
        ok: false as const,
        reason: 'cancellation-unsupported' as const,
        status: 'JOB_PENDING' as const,
      }),
    };
  }

  if (cancellationRequested || job.state === 'CANCEL_REQUESTED') {
    return { cancellationRequested: true };
  }

  let cancellation: Awaited<
    ReturnType<StableAudio3TextToAudioRunnerClient['cancelJob']>
  >;

  try {
    cancellation = await client.cancelJob(job.jobId);
  } catch (error) {
    return {
      cancellationRequested,
      result: runnerFailure(
        'cancellation-failed',
        'stable-audio-3-t2a-cancellation-exception',
        errorMessage(error, 'SA3 T2A active Job cancellation threw an exception.'),
        job.jobId,
      ),
    };
  }

  if (!cancellation.ok) {
    return cancellation.status === 409
      ? { cancellationRequested }
      : {
          cancellationRequested,
          result: runnerFailure(
            'cancellation-failed',
            `stable-audio-3-t2a-cancellation-${cancellation.reason}`,
            cancellation.message,
            job.jobId,
          ),
        };
  }

  if (
    cancellation.job.jobId !== job.jobId ||
    !doesJobMatchRequest(cancellation.job, plan.request)
  ) {
    return {
      cancellationRequested,
      result: runnerFailure(
        'cancellation-failed',
        'stable-audio-3-t2a-cancellation-response-invalid',
        'SA3 T2A cancellation returned a mismatched Job.',
        job.jobId,
      ),
    };
  }

  const terminal = createTerminalResult(cancellation.job);

  if (terminal) {
    return {
      cancellationRequested: true,
      result: terminal,
    };
  }

  if (cancellation.job.state !== 'CANCEL_REQUESTED') {
    return {
      cancellationRequested,
      result: runnerFailure(
        'cancellation-failed',
        'stable-audio-3-t2a-cancellation-response-invalid',
        'SA3 T2A cancellation did not produce CANCEL_REQUESTED.',
        job.jobId,
      ),
    };
  }

  return {
    cancellationRequested: true,
    job: cancellation.job,
  };
}

function resolveExpectedRequest(
  plan: StableAudio3TextToAudioJobPlan,
): StableAudio3TextToAudioJobPlan['request'] | undefined {
  try {
    const expected = createStableAudio3TextToAudioJobRequest({
      durationSeconds: plan.request.parameters.durationSeconds,
      modelId: plan.request.modelId,
      modelRevision: plan.request.modelRevision,
      prompt: plan.request.parameters.prompt,
      providerId: plan.request.providerId,
      seed: plan.request.parameters.seed,
    });

    return areJsonValuesEqual(plan.request, expected) ? expected : undefined;
  } catch {
    return undefined;
  }
}

function doesJobMatchRequest(
  job: LocalEngineGpuJobRecord,
  request: StableAudio3TextToAudioJobPlan['request'],
): boolean {
  return (
    job.providerId === request.providerId &&
    job.modelId === request.modelId &&
    job.modelRevision === request.modelRevision &&
    job.taskId === request.taskId &&
    areJsonValuesEqual(job.request, request)
  );
}

function createTerminalResult(
  job: LocalEngineGpuJobRecord,
): StableAudio3TextToAudioRunnerResult | undefined {
  if (job.state === 'COMPLETED') {
    return Object.freeze({
      job,
      jobId: job.jobId,
      ok: true as const,
      status: 'JOB_COMPLETED' as const,
    });
  }

  if (job.state === 'CANCELED') {
    return Object.freeze({
      job,
      jobId: job.jobId,
      message: `SA3 T2A Job ${job.jobId} was canceled.`,
      ok: false as const,
      reason: 'job-canceled' as const,
      status: 'JOB_CANCELED' as const,
    });
  }

  if (FAILED_JOB_STATES.has(job.state)) {
    return Object.freeze({
      cause: job.error?.code ?? 'stable-audio-3-t2a-engine-job-failed',
      job,
      jobId: job.jobId,
      message:
        job.error?.message ??
        `SA3 T2A Job ${job.jobId} stopped in ${job.state}.`,
      ok: false as const,
      reason: 'job-failed' as const,
      status: 'JOB_FAILED' as const,
    });
  }

  return undefined;
}

function notifyProgressIfChanged(
  onProgress: StableAudio3TextToAudioRunnerOptions['onProgress'],
  job: LocalEngineGpuJobRecord,
  previousState: LocalEngineGpuJobState | undefined,
  previousProgressUpdatedAt: string | undefined,
): Readonly<{ ok: true }> | Readonly<{ message: string; ok: false }> {
  return job.state === previousState &&
    job.progress?.updatedAt === previousProgressUpdatedAt
    ? { ok: true }
    : notifyProgress(onProgress, {
        ...(job.progress ? { jobProgress: job.progress } : {}),
        jobId: job.jobId,
        state: job.state,
      });
}

function notifyProgress(
  onProgress: StableAudio3TextToAudioRunnerOptions['onProgress'],
  progress: StableAudio3TextToAudioRunnerProgress,
): Readonly<{ ok: true }> | Readonly<{ message: string; ok: false }> {
  try {
    onProgress?.(Object.freeze({ ...progress }));
    return { ok: true };
  } catch (error) {
    return {
      message: errorMessage(
        error,
        'SA3 T2A progress callback threw an exception.',
      ),
      ok: false,
    };
  }
}

function runCanceled(
  reason: Extract<
    StableAudio3TextToAudioRunnerResult,
    { status: 'RUN_CANCELED' }
  >['reason'],
  cause: string,
  message: string,
  jobId?: string,
): Extract<
  StableAudio3TextToAudioRunnerResult,
  { status: 'RUN_CANCELED' }
> {
  return Object.freeze({
    cause,
    ...(jobId ? { jobId } : {}),
    message,
    ok: false as const,
    reason,
    status: 'RUN_CANCELED' as const,
  });
}

function runnerFailure(
  reason: Extract<
    StableAudio3TextToAudioRunnerResult,
    { status: 'RUNNER_FAILED' }
  >['reason'],
  cause: string,
  message: string,
  jobId?: string,
): Extract<
  StableAudio3TextToAudioRunnerResult,
  { status: 'RUNNER_FAILED' }
> {
  return Object.freeze({
    cause,
    ...(jobId ? { jobId } : {}),
    message,
    ok: false as const,
    reason,
    status: 'RUNNER_FAILED' as const,
  });
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
