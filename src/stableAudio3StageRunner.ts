import type {
  LocalEngineClient,
  LocalEngineGpuJobProgress,
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineClient';
import type { StableAudio3StageAdapterPlan } from './stableAudio3StageAdapter';
import {
  resolveStableAudio3StageJobOutcome,
  type StableAudio3StageJobOutcome,
} from './stableAudio3StageOutcome';
import type { TabFlowStageResultScope } from './types';

type CompletedOutcome = Extract<
  StableAudio3StageJobOutcome,
  { status: 'JOB_COMPLETED' }
>;
type PendingOutcome = Extract<
  StableAudio3StageJobOutcome,
  { status: 'PENDING' }
>;
type CanceledOutcome = Extract<
  StableAudio3StageJobOutcome,
  { status: 'CANCELED' }
>;
type FailedOutcome = Extract<
  StableAudio3StageJobOutcome,
  { status: 'FAILED' }
>;

export type StableAudio3StageRunnerClient = Pick<
  LocalEngineClient,
  | 'cancelJob'
  | 'enqueueStableAudio3Job'
  | 'getJobs'
  | 'removeQueuedJob'
>;

export type StableAudio3StageRunnerProgress = Readonly<{
  attemptId: string;
  jobProgress?: LocalEngineGpuJobProgress;
  jobId?: string;
  runId: string;
  scope: TabFlowStageResultScope;
  state: 'ENQUEUEING' | LocalEngineGpuJobState;
}>;

export type StableAudio3StageRunnerOptions = Readonly<{
  maxPollAttempts?: number;
  onProgress?: (progress: StableAudio3StageRunnerProgress) => void;
  pollIntervalMs?: number;
  pollUntilTerminal?: boolean;
  signal?: AbortSignal;
  wait?: (delayMs: number) => Promise<void>;
}>;

type StableAudio3StageRunnerIdentity = Readonly<{
  adapterId: StableAudio3StageAdapterPlan['adapterId'];
  attemptId: string;
  fingerprint: string;
  runId: string;
  scope: TabFlowStageResultScope;
}>;

export type StableAudio3StageRunnerResult =
  | (StableAudio3StageRunnerIdentity &
      Readonly<{
        jobId: string;
        ok: true;
        outcome: CompletedOutcome;
        status: 'JOB_COMPLETED';
      }>)
  | (StableAudio3StageRunnerIdentity &
      Readonly<{
        jobId: string;
        ok: false;
        outcome: PendingOutcome;
        reason:
          | 'cancellation-unsupported'
          | 'poll-limit-reached';
        status: 'JOB_PENDING';
      }>)
  | (StableAudio3StageRunnerIdentity &
      Readonly<{
        jobId: string;
        ok: false;
        outcome: CanceledOutcome;
        reason: 'job-canceled';
        status: 'JOB_CANCELED';
      }>)
  | (StableAudio3StageRunnerIdentity &
      Readonly<{
        cause: string;
        jobId: string;
        message: string;
        ok: false;
        outcome: FailedOutcome;
        reason: 'job-failed';
        status: 'JOB_FAILED';
      }>)
  | (StableAudio3StageRunnerIdentity &
      Readonly<{
        cause: string;
        jobId?: string;
        message: string;
        ok: false;
        reason:
          | 'canceled-before-enqueue'
          | 'queued-job-removed';
        status: 'RUN_CANCELED';
      }>)
  | (StableAudio3StageRunnerIdentity &
      Readonly<{
        cause: string;
        jobId?: string;
        message: string;
        ok: false;
        reason:
          | 'cancellation-failed'
          | 'enqueue-failed'
          | 'job-missing'
          | 'job-observation-failed'
          | 'poll-failed'
          | 'progress-failed'
          | 'runner-options-invalid'
          | 'wait-failed';
        status: 'RUNNER_FAILED';
      }>);

export async function runStableAudio3StagePlan(
  client: StableAudio3StageRunnerClient,
  plan: StableAudio3StageAdapterPlan,
  options: StableAudio3StageRunnerOptions = {},
): Promise<StableAudio3StageRunnerResult> {
  const identity = createIdentity(plan);
  const maxPollAttempts = options.maxPollAttempts ?? 900;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const pollUntilTerminal = options.pollUntilTerminal ?? false;
  const wait = options.wait ?? waitForDelay;

  if (
    !Number.isSafeInteger(maxPollAttempts) ||
    maxPollAttempts < 1 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    typeof pollUntilTerminal !== 'boolean' ||
    typeof wait !== 'function'
  ) {
    return runnerFailure(
      identity,
      'runner-options-invalid',
      'stable-audio-3-runner-options-invalid',
      'Stable Audio 3 Stage Runner polling options are invalid.',
    );
  }

  if (options.signal?.aborted) {
    return runCanceled(
      identity,
      'canceled-before-enqueue',
      'stable-audio-3-run-canceled-before-enqueue',
      'Stable Audio 3 Stage run was canceled before Job enqueue.',
    );
  }

  const enqueueProgress = notifyProgress(options.onProgress, {
    attemptId: identity.attemptId,
    runId: identity.runId,
    scope: identity.scope,
    state: 'ENQUEUEING',
  });

  if (!enqueueProgress.ok) {
    return runnerFailure(
      identity,
      'progress-failed',
      'stable-audio-3-progress-callback-failed',
      enqueueProgress.message,
    );
  }

  let enqueue: Awaited<
    ReturnType<StableAudio3StageRunnerClient['enqueueStableAudio3Job']>
  >;

  try {
    enqueue = await client.enqueueStableAudio3Job(plan.request);
  } catch (error) {
    return runnerFailure(
      identity,
      'enqueue-failed',
      'stable-audio-3-enqueue-exception',
      errorMessage(error, 'Stable Audio 3 Job enqueue threw an exception.'),
    );
  }

  if (!enqueue.ok) {
    return runnerFailure(
      identity,
      'enqueue-failed',
      `stable-audio-3-enqueue-${enqueue.reason}`,
      enqueue.message,
    );
  }

  const jobId = enqueue.job.jobId;
  let currentJob = enqueue.job;
  let currentOutcome = observeJob(plan, currentJob);

  if (!currentOutcome.ok) {
    return runnerFailure(
      identity,
      'job-observation-failed',
      'stable-audio-3-job-observation-exception',
      currentOutcome.message,
      jobId,
    );
  }

  let lastOutcome = currentOutcome.outcome;
  let lastProgressUpdatedAt: string | undefined;
  let lastProgressState: LocalEngineGpuJobState | undefined;
  const initialProgress = notifyJobProgress(
    options.onProgress,
    identity,
    currentJob,
    lastProgressState,
    lastProgressUpdatedAt,
  );

  if (!initialProgress.ok) {
    return runnerFailure(
      identity,
      'progress-failed',
      'stable-audio-3-progress-callback-failed',
      initialProgress.message,
      jobId,
    );
  }

  lastProgressState = currentJob.state;
  lastProgressUpdatedAt = currentJob.progress?.updatedAt;
  const initialTerminal = terminalResult(identity, lastOutcome);

  if (initialTerminal) {
    return initialTerminal;
  }

  if (lastOutcome.status !== 'PENDING') {
    return runnerFailure(
      identity,
      'job-observation-failed',
      'stable-audio-3-job-outcome-invalid',
      'Stable Audio 3 Job produced an unrecognized non-terminal outcome.',
      jobId,
    );
  }

  let lastPendingOutcome = lastOutcome;
  let cancellationRequested = false;
  const initialCancellation = await reactToCancellation(
    client,
    plan,
    identity,
    currentJob,
    lastPendingOutcome,
    cancellationRequested,
    options.signal,
  );

  if (initialCancellation.result) {
    return initialCancellation.result;
  }

  cancellationRequested = initialCancellation.cancellationRequested;

  for (
    let attempt = 0;
    pollUntilTerminal || attempt < maxPollAttempts;
    attempt += 1
  ) {
    let snapshot: Awaited<
      ReturnType<StableAudio3StageRunnerClient['getJobs']>
    >;

    try {
      snapshot = await client.getJobs();
    } catch (error) {
      return runnerFailure(
        identity,
        'poll-failed',
        'stable-audio-3-job-poll-exception',
        errorMessage(error, 'Stable Audio 3 Job polling threw an exception.'),
        jobId,
      );
    }

    if (!snapshot.ok) {
      return runnerFailure(
        identity,
        'poll-failed',
        `stable-audio-3-job-poll-${snapshot.reason}`,
        snapshot.message,
        jobId,
      );
    }

    const observedJob = snapshot.snapshot.jobs.find(
      (candidate) => candidate.jobId === jobId,
    );

    if (!observedJob) {
      return runnerFailure(
        identity,
        'job-missing',
        'stable-audio-3-job-missing',
        `Local Engine no longer reports Stable Audio 3 Job ${jobId}.`,
        jobId,
      );
    }

    currentJob = observedJob;
    currentOutcome = observeJob(plan, currentJob);

    if (!currentOutcome.ok) {
      return runnerFailure(
        identity,
        'job-observation-failed',
        'stable-audio-3-job-observation-exception',
        currentOutcome.message,
        jobId,
      );
    }

    lastOutcome = currentOutcome.outcome;
    const progress = notifyJobProgress(
      options.onProgress,
      identity,
      currentJob,
      lastProgressState,
      lastProgressUpdatedAt,
    );

    if (!progress.ok) {
      return runnerFailure(
        identity,
        'progress-failed',
        'stable-audio-3-progress-callback-failed',
        progress.message,
        jobId,
      );
    }

    lastProgressState = currentJob.state;
    lastProgressUpdatedAt = currentJob.progress?.updatedAt;
    const terminal = terminalResult(identity, lastOutcome);

    if (terminal) {
      return terminal;
    }

    if (lastOutcome.status !== 'PENDING') {
      return runnerFailure(
        identity,
        'job-observation-failed',
        'stable-audio-3-job-outcome-invalid',
        'Stable Audio 3 Job produced an unrecognized non-terminal outcome.',
        jobId,
      );
    }

    lastPendingOutcome = lastOutcome;
    const cancellation = await reactToCancellation(
      client,
      plan,
      identity,
      currentJob,
      lastPendingOutcome,
      cancellationRequested,
      options.signal,
    );

    if (cancellation.result) {
      return cancellation.result;
    }

    cancellationRequested = cancellation.cancellationRequested;

    if (pollUntilTerminal || attempt + 1 < maxPollAttempts) {
      try {
        await wait(pollIntervalMs);
      } catch (error) {
        return runnerFailure(
          identity,
          'wait-failed',
          'stable-audio-3-poll-wait-failed',
          errorMessage(error, 'Stable Audio 3 polling wait failed.'),
          jobId,
        );
      }
    }
  }

  return Object.freeze({
    ...identity,
    jobId,
    ok: false,
    outcome: lastPendingOutcome,
    reason: 'poll-limit-reached' as const,
    status: 'JOB_PENDING' as const,
  });
}

type CancellationReaction = Readonly<{
  cancellationRequested: boolean;
  result?: StableAudio3StageRunnerResult;
}>;

async function reactToCancellation(
  client: StableAudio3StageRunnerClient,
  plan: StableAudio3StageAdapterPlan,
  identity: StableAudio3StageRunnerIdentity,
  job: LocalEngineGpuJobRecord,
  outcome: PendingOutcome,
  cancellationRequested: boolean,
  signal: AbortSignal | undefined,
): Promise<CancellationReaction> {
  if (!signal?.aborted) {
    return { cancellationRequested };
  }

  if (job.state === 'SAVING' || job.state === 'CANCEL_REQUESTED') {
    return { cancellationRequested };
  }

  if (job.state === 'QUEUED') {
    let removal: Awaited<
      ReturnType<StableAudio3StageRunnerClient['removeQueuedJob']>
    >;

    try {
      removal = await client.removeQueuedJob(job.jobId);
    } catch (error) {
      return {
        cancellationRequested,
        result: runnerFailure(
          identity,
          'cancellation-failed',
          'stable-audio-3-queued-removal-exception',
          errorMessage(error, 'Stable Audio 3 queued Job removal threw an exception.'),
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
              identity,
              'cancellation-failed',
              `stable-audio-3-queued-removal-${removal.reason}`,
              removal.message,
              job.jobId,
            ),
          };
    }

    const removedOutcome = observeJob(plan, removal.removedJob);

    if (
      removal.removedJob.jobId !== job.jobId ||
      !removedOutcome.ok ||
      removedOutcome.outcome.status !== 'PENDING' ||
      removedOutcome.outcome.jobState !== 'QUEUED'
    ) {
      return {
        cancellationRequested,
        result: runnerFailure(
          identity,
          'cancellation-failed',
          'stable-audio-3-queued-removal-response-invalid',
          'Stable Audio 3 queued Job removal returned a mismatched Job.',
          job.jobId,
        ),
      };
    }

    return {
      cancellationRequested,
      result: runCanceled(
        identity,
        'queued-job-removed',
        'stable-audio-3-queued-job-removed',
        `Stable Audio 3 Job ${job.jobId} was removed before execution.`,
        job.jobId,
      ),
    };
  }

  if (!plan.runtime.supportsCancellation) {
    return {
      cancellationRequested,
      result: Object.freeze({
        ...identity,
        jobId: job.jobId,
        ok: false,
        outcome,
        reason: 'cancellation-unsupported' as const,
        status: 'JOB_PENDING' as const,
      }),
    };
  }

  if (cancellationRequested) {
    return { cancellationRequested };
  }

  let cancellation: Awaited<
    ReturnType<StableAudio3StageRunnerClient['cancelJob']>
  >;

  try {
    cancellation = await client.cancelJob(job.jobId);
  } catch (error) {
    return {
      cancellationRequested,
      result: runnerFailure(
        identity,
        'cancellation-failed',
        'stable-audio-3-cancellation-exception',
        errorMessage(error, 'Stable Audio 3 Job cancellation threw an exception.'),
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
            identity,
            'cancellation-failed',
            `stable-audio-3-cancellation-${cancellation.reason}`,
            cancellation.message,
            job.jobId,
          ),
        };
  }

  if (cancellation.job.jobId !== job.jobId) {
    return {
      cancellationRequested,
      result: runnerFailure(
        identity,
        'cancellation-failed',
        'stable-audio-3-cancellation-response-invalid',
        'Stable Audio 3 cancellation returned a mismatched Job.',
        job.jobId,
      ),
    };
  }

  const cancellationOutcome = observeJob(plan, cancellation.job);

  if (!cancellationOutcome.ok) {
    return {
      cancellationRequested,
      result: runnerFailure(
        identity,
        'cancellation-failed',
        'stable-audio-3-cancellation-response-invalid',
        cancellationOutcome.message,
        job.jobId,
      ),
    };
  }

  const terminal = terminalResult(identity, cancellationOutcome.outcome);

  if (terminal) {
    return { cancellationRequested: true, result: terminal };
  }

  if (
    cancellationOutcome.outcome.status !== 'PENDING' ||
    cancellationOutcome.outcome.jobState !== 'CANCEL_REQUESTED'
  ) {
    return {
      cancellationRequested,
      result: runnerFailure(
        identity,
        'cancellation-failed',
        'stable-audio-3-cancellation-response-invalid',
        'Stable Audio 3 cancellation did not produce CANCEL_REQUESTED.',
        job.jobId,
      ),
    };
  }

  return { cancellationRequested: true };
}

function observeJob(
  plan: StableAudio3StageAdapterPlan,
  job: LocalEngineGpuJobRecord,
):
  | Readonly<{ ok: true; outcome: StableAudio3StageJobOutcome }>
  | Readonly<{ message: string; ok: false }> {
  try {
    return {
      ok: true,
      outcome: resolveStableAudio3StageJobOutcome(plan, job),
    };
  } catch (error) {
    return {
      message: errorMessage(
        error,
        'Stable Audio 3 Job outcome resolution threw an exception.',
      ),
      ok: false,
    };
  }
}

function terminalResult(
  identity: StableAudio3StageRunnerIdentity,
  outcome: StableAudio3StageJobOutcome,
): StableAudio3StageRunnerResult | undefined {
  if (outcome.ok) {
    return Object.freeze({
      ...identity,
      jobId: outcome.completed.job.jobId,
      ok: true,
      outcome,
      status: 'JOB_COMPLETED' as const,
    });
  }

  if (outcome.status === 'CANCELED') {
    return Object.freeze({
      ...identity,
      jobId: outcome.jobId,
      ok: false,
      outcome,
      reason: 'job-canceled' as const,
      status: 'JOB_CANCELED' as const,
    });
  }

  if (outcome.status === 'FAILED') {
    return Object.freeze({
      ...identity,
      cause: outcome.cause,
      jobId: outcome.jobId,
      message: outcome.message,
      ok: false,
      outcome,
      reason: 'job-failed' as const,
      status: 'JOB_FAILED' as const,
    });
  }

  return undefined;
}

function notifyJobProgress(
  onProgress: StableAudio3StageRunnerOptions['onProgress'],
  identity: StableAudio3StageRunnerIdentity,
  job: LocalEngineGpuJobRecord,
  previousState: LocalEngineGpuJobState | undefined,
  previousProgressUpdatedAt: string | undefined,
): Readonly<{ ok: true }> | Readonly<{ message: string; ok: false }> {
  if (
    job.state === previousState &&
    job.progress?.updatedAt === previousProgressUpdatedAt
  ) {
    return { ok: true };
  }

  return notifyProgress(onProgress, {
    attemptId: identity.attemptId,
    ...(job.progress ? { jobProgress: job.progress } : {}),
    jobId: job.jobId,
    runId: identity.runId,
    scope: identity.scope,
    state: job.state,
  });
}

function notifyProgress(
  onProgress: StableAudio3StageRunnerOptions['onProgress'],
  progress: StableAudio3StageRunnerProgress,
): Readonly<{ ok: true }> | Readonly<{ message: string; ok: false }> {
  try {
    onProgress?.(Object.freeze({
      ...progress,
      scope: Object.freeze({ ...progress.scope }),
    }));
    return { ok: true };
  } catch (error) {
    return {
      message: errorMessage(
        error,
        'Stable Audio 3 progress callback threw an exception.',
      ),
      ok: false,
    };
  }
}

function createIdentity(
  plan: StableAudio3StageAdapterPlan,
): StableAudio3StageRunnerIdentity {
  return Object.freeze({
    adapterId: plan.adapterId,
    attemptId: plan.attemptId,
    fingerprint: plan.fingerprint,
    runId: plan.runId,
    scope: Object.freeze({ ...plan.scope }),
  });
}

function runCanceled(
  identity: StableAudio3StageRunnerIdentity,
  reason: Extract<
    StableAudio3StageRunnerResult,
    { status: 'RUN_CANCELED' }
  >['reason'],
  cause: string,
  message: string,
  jobId?: string,
): Extract<StableAudio3StageRunnerResult, { status: 'RUN_CANCELED' }> {
  return Object.freeze({
    ...identity,
    cause,
    ...(jobId ? { jobId } : {}),
    message,
    ok: false,
    reason,
    status: 'RUN_CANCELED',
  });
}

function runnerFailure(
  identity: StableAudio3StageRunnerIdentity,
  reason: Extract<
    StableAudio3StageRunnerResult,
    { status: 'RUNNER_FAILED' }
  >['reason'],
  cause: string,
  message: string,
  jobId?: string,
): Extract<StableAudio3StageRunnerResult, { status: 'RUNNER_FAILED' }> {
  return Object.freeze({
    ...identity,
    cause,
    ...(jobId ? { jobId } : {}),
    message,
    ok: false,
    reason,
    status: 'RUNNER_FAILED',
  });
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
