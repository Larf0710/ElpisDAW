import type {
  LocalEngineClient,
  LocalEngineGpuJobProgress,
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
} from './localEngineClient';
import {
  createAceStepCoverJobRequest,
  type AceStepCoverJobRequest,
} from './aceStepCoverJobContract';
import type { AceStepCoverJobPlan } from './aceStepCoverPatchTab';

export type AceStepCoverRunnerClient = Pick<
  LocalEngineClient,
  'cancelJob' | 'enqueueAceStepJob' | 'getJobs' | 'removeQueuedJob'
>;

export type AceStepCoverRunnerProgress = Readonly<{
  jobProgress?: LocalEngineGpuJobProgress;
  jobId?: string;
  state: 'ENQUEUEING' | LocalEngineGpuJobState;
}>;

export type AceStepCoverRunnerResult =
  | Readonly<{ job: LocalEngineGpuJobRecord; jobId: string; ok: true; status: 'JOB_COMPLETED' }>
  | Readonly<{
      cause: string;
      job?: LocalEngineGpuJobRecord;
      jobId?: string;
      message: string;
      ok: false;
      status: 'RUN_CANCELED' | 'RUNNER_FAILED';
    }>;

export async function runAceStepCoverPlan(
  client: AceStepCoverRunnerClient,
  plan: AceStepCoverJobPlan,
  options: Readonly<{
    maxPollAttempts?: number;
    onProgress?: (progress: AceStepCoverRunnerProgress) => void;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    wait?: (delayMs: number) => Promise<void>;
  }> = {},
): Promise<AceStepCoverRunnerResult> {
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
    return failed('ace-step-cover-runner-plan-invalid', 'ACE Cover Runner requires one exact immutable Job plan.');
  }

  if (options.signal?.aborted) {
    return canceled('ace-step-cover-canceled-before-enqueue', 'ACE Cover was canceled before Job enqueue.');
  }

  try {
    options.onProgress?.(Object.freeze({ state: 'ENQUEUEING' as const }));
  } catch (error) {
    return failed('ace-step-cover-progress-failed', message(error, 'ACE Cover progress callback failed.'));
  }

  let enqueue: Awaited<ReturnType<AceStepCoverRunnerClient['enqueueAceStepJob']>>;

  try {
    enqueue = await client.enqueueAceStepJob(expectedRequest);
  } catch (error) {
    return failed('ace-step-cover-enqueue-exception', message(error, 'ACE Cover enqueue failed.'));
  }

  if (!enqueue.ok) {
    return failed(`ace-step-cover-enqueue-${enqueue.reason}`, enqueue.message);
  }

  const jobId = enqueue.job.jobId;
  let currentJob = enqueue.job;
  let cancellationRequested = false;
  let lastProgressUpdatedAt: string | undefined;
  let lastState: LocalEngineGpuJobState | undefined;

  for (let attempt = 0; attempt <= maxPollAttempts; attempt += 1) {
    if (!matches(currentJob, expectedRequest)) {
      return failed('ace-step-cover-job-plan-mismatch', 'Observed ACE Cover Job does not match its immutable request.', jobId, currentJob);
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
        return failed('ace-step-cover-progress-failed', message(error, 'ACE Cover progress callback failed.'), jobId, currentJob);
      }
      lastProgressUpdatedAt = currentJob.progress?.updatedAt;
      lastState = currentJob.state;
    }

    const terminal = terminalResult(currentJob);
    if (terminal) return terminal;

    if (options.signal?.aborted && currentJob.state !== 'SAVING') {
      if (currentJob.state === 'QUEUED') {
        try {
          const removal = await client.removeQueuedJob(jobId);
          if (removal.ok) {
            return canceled('ace-step-cover-queued-job-removed', `ACE Cover Job ${jobId} was removed before execution.`, jobId, removal.removedJob);
          }
          if (removal.status !== 409) {
            return failed(`ace-step-cover-removal-${removal.reason}`, removal.message, jobId, currentJob);
          }
        } catch (error) {
          return failed('ace-step-cover-removal-exception', message(error, 'ACE Cover queued Job removal failed.'), jobId, currentJob);
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
            return failed(`ace-step-cover-cancel-${cancellation.reason}`, cancellation.message, jobId, currentJob);
          }
        } catch (error) {
          return failed('ace-step-cover-cancel-exception', message(error, 'ACE Cover cancellation failed.'), jobId, currentJob);
        }
      }
    }

    if (attempt === maxPollAttempts) {
      return failed('ace-step-cover-poll-limit', `ACE Cover Job ${jobId} is still pending.`, jobId, currentJob);
    }

    try {
      await wait(pollIntervalMs);
      const snapshot = await client.getJobs();
      if (!snapshot.ok) {
        return failed(`ace-step-cover-poll-${snapshot.reason}`, snapshot.message, jobId, currentJob);
      }
      const observed = snapshot.snapshot.jobs.find((candidate) => candidate.jobId === jobId);
      if (!observed) {
        return failed('ace-step-cover-job-missing', `Local Engine no longer reports ACE Cover Job ${jobId}.`, jobId, currentJob);
      }
      currentJob = observed;
    } catch (error) {
      return failed('ace-step-cover-poll-exception', message(error, 'ACE Cover polling failed.'), jobId, currentJob);
    }
  }

  return failed('ace-step-cover-runner-unreachable', 'ACE Cover Runner reached an invalid state.', jobId, currentJob);
}

function recreateRequest(request: AceStepCoverJobRequest): AceStepCoverJobRequest | undefined {
  try {
    const expected = createAceStepCoverJobRequest({
      caption: request.parameters.caption,
      coverStrength: request.parameters.audioCoverStrength,
      durationSeconds: request.parameters.durationSeconds,
      guideArtifactId: request.guideSource.artifactId,
      guideClipTakeId: request.guideSource.clipTakeId,
      guideRelativePath: request.guideSource.relativePath,
      guideSizeBytes: request.inputArtifacts[0].sizeBytes,
      instrumental: request.parameters.instrumental,
      lyricsArtifactId: request.inputArtifacts[1].artifactId,
      lyricsRelativePath: request.inputArtifacts[1].relativePath,
      seed: request.parameters.seed,
      vocalLanguage: request.parameters.vocalLanguage,
    });
    return jsonEqual(request, expected) ? expected : undefined;
  } catch {
    return undefined;
  }
}

function terminalResult(job: LocalEngineGpuJobRecord): AceStepCoverRunnerResult | undefined {
  if (job.state === 'COMPLETED') {
    return Object.freeze({ job, jobId: job.jobId, ok: true as const, status: 'JOB_COMPLETED' as const });
  }
  if (job.state === 'CANCELED') {
    return canceled('ace-step-cover-job-canceled', `ACE Cover Job ${job.jobId} was canceled.`, job.jobId, job);
  }
  if (job.state === 'FAILED' || job.state === 'INTERRUPTED' || job.state === 'PAUSED') {
    return failed(
      job.error?.code ?? 'ace-step-cover-job-failed',
      job.error?.message ?? `ACE Cover Job ${job.jobId} stopped in ${job.state}.`,
      job.jobId,
      job,
    );
  }
  return undefined;
}

function matches(job: LocalEngineGpuJobRecord, request: AceStepCoverJobRequest): boolean {
  return (
    job.providerId === request.providerId &&
    job.modelId === request.modelId &&
    job.modelRevision === request.modelRevision &&
    job.taskId === request.taskId &&
    jsonEqual(job.request, request)
  );
}

function canceled(cause: string, text: string, jobId?: string, job?: LocalEngineGpuJobRecord): AceStepCoverRunnerResult {
  return Object.freeze({ cause, ...(job ? { job } : {}), ...(jobId ? { jobId } : {}), message: text, ok: false as const, status: 'RUN_CANCELED' as const });
}

function failed(cause: string, text: string, jobId?: string, job?: LocalEngineGpuJobRecord): AceStepCoverRunnerResult {
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
