import type {
  LocalEngineClient,
  LocalEngineGpuJobProgress,
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineClient';
import {
  createAceStepTextToMusicJobRequest,
  type AceStepTextToMusicJobRequest,
} from './aceStepTextToMusicJobContract';
import type { AceStepTextToMusicJobPlan } from './aceStepTextToMusicPatchTab';

export type AceStepTextToMusicRunnerClient = Pick<
  LocalEngineClient,
  'cancelJob' | 'enqueueAceStepJob' | 'getJobs' | 'removeQueuedJob'
>;

export type AceStepTextToMusicRunnerProgress = Readonly<{
  jobProgress?: LocalEngineGpuJobProgress;
  jobId?: string;
  state: 'ENQUEUEING' | LocalEngineGpuJobState;
}>;

export type AceStepTextToMusicRunnerResult =
  | Readonly<{ job: LocalEngineGpuJobRecord; jobId: string; ok: true; status: 'JOB_COMPLETED' }>
  | Readonly<{
      cause: string;
      job?: LocalEngineGpuJobRecord;
      jobId?: string;
      message: string;
      ok: false;
      status: 'RUN_CANCELED' | 'RUNNER_FAILED';
    }>;

export async function runAceStepTextToMusicPlan(
  client: AceStepTextToMusicRunnerClient,
  plan: AceStepTextToMusicJobPlan,
  options: Readonly<{
    maxPollAttempts?: number;
    onProgress?: (progress: AceStepTextToMusicRunnerProgress) => void;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    wait?: (delayMs: number) => Promise<void>;
  }> = {},
): Promise<AceStepTextToMusicRunnerResult> {
  const maxPollAttempts = options.maxPollAttempts ?? 18_600;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const wait = options.wait ?? ((delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)));
  const expectedRequest = recreateRequest(plan.request);

  if (
    !expectedRequest ||
    !Number.isSafeInteger(maxPollAttempts) ||
    maxPollAttempts < 1 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 0
  ) {
    return failed('ace-step-t2m-runner-plan-invalid', 'ACE T2M Runner requires one exact immutable Job plan.');
  }

  if (options.signal?.aborted) {
    return canceled('ace-step-t2m-canceled-before-enqueue', 'ACE T2M was canceled before Job enqueue.');
  }

  try {
    options.onProgress?.(Object.freeze({ state: 'ENQUEUEING' as const }));
  } catch (error) {
    return failed('ace-step-t2m-progress-failed', message(error, 'ACE T2M progress callback failed.'));
  }

  let enqueue: Awaited<ReturnType<AceStepTextToMusicRunnerClient['enqueueAceStepJob']>>;

  try {
    enqueue = await client.enqueueAceStepJob(expectedRequest);
  } catch (error) {
    return failed('ace-step-t2m-enqueue-exception', message(error, 'ACE T2M enqueue failed.'));
  }

  if (!enqueue.ok) {
    return failed(`ace-step-t2m-enqueue-${enqueue.reason}`, enqueue.message);
  }

  const jobId = enqueue.job.jobId;
  let currentJob = enqueue.job;
  let cancellationRequested = false;
  let lastProgressUpdatedAt: string | undefined;
  let lastState: LocalEngineGpuJobState | undefined;

  for (let attempt = 0; attempt <= maxPollAttempts; attempt += 1) {
    if (!matches(currentJob, expectedRequest)) {
      return failed('ace-step-t2m-job-plan-mismatch', 'Observed ACE T2M Job does not match its immutable request.', jobId, currentJob);
    }

    if (
      currentJob.state !== lastState ||
      currentJob.progress?.updatedAt !== lastProgressUpdatedAt
    ) {
      try {
        options.onProgress?.(Object.freeze({
          ...(currentJob.progress ? { jobProgress: currentJob.progress } : {}),
          jobId,
          state: currentJob.state,
        }));
      } catch (error) {
        return failed('ace-step-t2m-progress-failed', message(error, 'ACE T2M progress callback failed.'), jobId, currentJob);
      }
      lastProgressUpdatedAt = currentJob.progress?.updatedAt;
      lastState = currentJob.state;
    }

    const terminal = terminalResult(currentJob);
    if (terminal) {
      return terminal;
    }

    if (options.signal?.aborted && currentJob.state !== 'SAVING') {
      if (currentJob.state === 'QUEUED') {
        try {
          const removal = await client.removeQueuedJob(jobId);
          if (removal.ok) {
            return canceled('ace-step-t2m-queued-job-removed', `ACE T2M Job ${jobId} was removed before execution.`, jobId, removal.removedJob);
          }
          if (removal.status !== 409) {
            return failed(`ace-step-t2m-removal-${removal.reason}`, removal.message, jobId, currentJob);
          }
        } catch (error) {
          return failed('ace-step-t2m-removal-exception', message(error, 'ACE T2M queued Job removal failed.'), jobId, currentJob);
        }
      } else if (!cancellationRequested && currentJob.state !== 'CANCEL_REQUESTED') {
        try {
          const cancellation = await client.cancelJob(jobId);
          if (cancellation.ok) {
            currentJob = cancellation.job;
            cancellationRequested = true;
            continue;
          }
          if (cancellation.status !== 409) {
            return failed(`ace-step-t2m-cancel-${cancellation.reason}`, cancellation.message, jobId, currentJob);
          }
        } catch (error) {
          return failed('ace-step-t2m-cancel-exception', message(error, 'ACE T2M cancellation failed.'), jobId, currentJob);
        }
      }
    }

    if (attempt === maxPollAttempts) {
      return failed('ace-step-t2m-poll-limit', `ACE T2M Job ${jobId} is still pending.`, jobId, currentJob);
    }

    try {
      await wait(pollIntervalMs);
      const snapshot = await client.getJobs();
      if (!snapshot.ok) {
        return failed(`ace-step-t2m-poll-${snapshot.reason}`, snapshot.message, jobId, currentJob);
      }
      const observed = snapshot.snapshot.jobs.find((candidate) => candidate.jobId === jobId);
      if (!observed) {
        return failed('ace-step-t2m-job-missing', `Local Engine no longer reports ACE T2M Job ${jobId}.`, jobId, currentJob);
      }
      currentJob = observed;
    } catch (error) {
      return failed('ace-step-t2m-poll-exception', message(error, 'ACE T2M polling failed.'), jobId, currentJob);
    }
  }

  return failed('ace-step-t2m-runner-unreachable', 'ACE T2M Runner reached an invalid state.', jobId, currentJob);
}

function recreateRequest(request: AceStepTextToMusicJobRequest): AceStepTextToMusicJobRequest | undefined {
  try {
    const expected = createAceStepTextToMusicJobRequest({
      bpm: request.parameters.bpm,
      caption: request.parameters.caption,
      durationSeconds: request.parameters.durationSeconds,
      instrumental: request.parameters.instrumental,
      keyscale: request.parameters.keyscale,
      lyricsArtifactId: request.inputArtifacts[0].artifactId,
      lyricsRelativePath: request.inputArtifacts[0].relativePath,
      seed: request.parameters.seed,
      vocalLanguage: request.parameters.vocalLanguage,
    });
    return jsonEqual(request, expected) ? expected : undefined;
  } catch {
    return undefined;
  }
}

function terminalResult(job: LocalEngineGpuJobRecord): AceStepTextToMusicRunnerResult | undefined {
  if (job.state === 'COMPLETED') {
    return Object.freeze({ job, jobId: job.jobId, ok: true as const, status: 'JOB_COMPLETED' as const });
  }

  if (job.state === 'CANCELED') {
    return canceled('ace-step-t2m-job-canceled', `ACE T2M Job ${job.jobId} was canceled.`, job.jobId, job);
  }

  if (job.state === 'FAILED' || job.state === 'INTERRUPTED' || job.state === 'PAUSED') {
    return failed(
      job.error?.code ?? 'ace-step-t2m-job-failed',
      job.error?.message ?? `ACE T2M Job ${job.jobId} stopped in ${job.state}.`,
      job.jobId,
      job,
    );
  }

  return undefined;
}

function matches(job: LocalEngineGpuJobRecord, request: AceStepTextToMusicJobRequest): boolean {
  return (
    job.providerId === request.providerId &&
    job.modelId === request.modelId &&
    job.modelRevision === request.modelRevision &&
    job.taskId === request.taskId &&
    jsonEqual(job.request, request)
  );
}

function canceled(cause: string, text: string, jobId?: string, job?: LocalEngineGpuJobRecord): AceStepTextToMusicRunnerResult {
  return Object.freeze({ cause, ...(job ? { job } : {}), ...(jobId ? { jobId } : {}), message: text, ok: false as const, status: 'RUN_CANCELED' as const });
}

function failed(cause: string, text: string, jobId?: string, job?: LocalEngineGpuJobRecord): AceStepTextToMusicRunnerResult {
  return Object.freeze({ cause, ...(job ? { job } : {}), ...(jobId ? { jobId } : {}), message: text, ok: false as const, status: 'RUNNER_FAILED' as const });
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
