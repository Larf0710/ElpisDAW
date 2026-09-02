import type {
  LocalEngineClient,
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
  LocalEngineInstrumentRenderJobRequest,
} from './localEngineClient';

export type LocalEngineInstrumentRenderProgress = Readonly<{
  jobId?: string;
  state: 'ENQUEUEING' | LocalEngineGpuJobState;
}>;

export type LocalEngineInstrumentRenderResult =
  | Readonly<{ job: LocalEngineGpuJobRecord; ok: true }>
  | Readonly<{
      jobId?: string;
      message: string;
      ok: false;
      reason: 'canceled' | 'engine-job-failed';
    }>;

type InstrumentRenderClient = Pick<
  LocalEngineClient,
  'enqueueInstrumentRenderJob' | 'getJobs'
> &
  Partial<Pick<LocalEngineClient, 'cancelJob' | 'removeQueuedJob'>>;

export type LocalEngineInstrumentRenderOptions = Readonly<{
  maxPollAttempts?: number;
  onProgress?: (progress: LocalEngineInstrumentRenderProgress) => void;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  wait?: (delayMs: number) => Promise<void>;
}>;

const failedJobStates = new Set<LocalEngineGpuJobState>([
  'CANCELED',
  'FAILED',
  'INTERRUPTED',
  'PAUSED',
]);

export async function runLocalEngineInstrumentRender(
  client: InstrumentRenderClient,
  request: LocalEngineInstrumentRenderJobRequest,
  {
    maxPollAttempts = 900,
    onProgress,
    pollIntervalMs = 100,
    signal,
    wait = waitForDelay,
  }: LocalEngineInstrumentRenderOptions = {},
): Promise<LocalEngineInstrumentRenderResult> {
  if (signal?.aborted) {
    return {
      message: 'MIDI TO AUDIO was canceled before enqueue.',
      ok: false,
      reason: 'canceled',
    };
  }

  onProgress?.({ state: 'ENQUEUEING' });
  const enqueue = await client.enqueueInstrumentRenderJob(request);

  if (!enqueue.ok) {
    return {
      message: enqueue.message,
      ok: false,
      reason: 'engine-job-failed',
    };
  }

  const jobId = enqueue.job.jobId;
  let lastState: LocalEngineGpuJobState | undefined;

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    const snapshotResult = await client.getJobs();

    if (!snapshotResult.ok) {
      return {
        jobId,
        message: snapshotResult.message,
        ok: false,
        reason: 'engine-job-failed',
      };
    }

    const job = snapshotResult.snapshot.jobs.find(
      (candidate) => candidate.jobId === jobId,
    );

    if (!job) {
      return {
        jobId,
        message: `Local Engine no longer reports MIDI TO AUDIO Job ${jobId}.`,
        ok: false,
        reason: 'engine-job-failed',
      };
    }

    if (job.state !== lastState) {
      lastState = job.state;
      onProgress?.({ jobId, state: job.state });
    }

    if (job.state === 'COMPLETED') {
      return { job, ok: true };
    }

    if (failedJobStates.has(job.state)) {
      return {
        jobId,
        message:
          job.error?.message ??
          `MIDI TO AUDIO Job ${jobId} stopped in ${job.state}.`,
        ok: false,
        reason:
          job.state === 'CANCELED' ? 'canceled' : 'engine-job-failed',
      };
    }

    if (signal?.aborted) {
      const cancellation = await requestInstrumentRenderCancellation(
        client,
        job,
      );

      if (cancellation.status === 'canceled') {
        return {
          jobId,
          message: `MIDI TO AUDIO Job ${jobId} was canceled.`,
          ok: false,
          reason: 'canceled',
        };
      }

      if (cancellation.status === 'failed') {
        return {
          jobId,
          message: cancellation.message,
          ok: false,
          reason: 'engine-job-failed',
        };
      }
    }

    await wait(pollIntervalMs);
  }

  return {
    jobId,
    message: `MIDI TO AUDIO Job ${jobId} did not finish before the UI polling timeout.`,
    ok: false,
    reason: 'engine-job-failed',
  };
}

type InstrumentRenderCancellationAttempt =
  | Readonly<{ status: 'canceled' }>
  | Readonly<{ status: 'retry' }>
  | Readonly<{ message: string; status: 'failed' }>;

async function requestInstrumentRenderCancellation(
  client: InstrumentRenderClient,
  job: LocalEngineGpuJobRecord,
): Promise<InstrumentRenderCancellationAttempt> {
  if (job.state === 'SAVING') {
    return { status: 'retry' };
  }

  if (job.state === 'QUEUED') {
    if (!client.removeQueuedJob) {
      return {
        message: `MIDI TO AUDIO Job ${job.jobId} could not be removed because the Client has no queued-Job removal boundary.`,
        status: 'failed',
      };
    }

    const removal = await client.removeQueuedJob(job.jobId);

    if (removal.ok) {
      return { status: 'canceled' };
    }

    return removal.status === 409
      ? { status: 'retry' }
      : {
          message: `MIDI TO AUDIO Job ${job.jobId} removal failed: ${removal.message}`,
          status: 'failed',
        };
  }

  if (!client.cancelJob) {
    return {
      message: `MIDI TO AUDIO Job ${job.jobId} could not be canceled because the Client has no active-Job cancellation boundary.`,
      status: 'failed',
    };
  }

  const cancellation = await client.cancelJob(job.jobId);

  if (cancellation.ok) {
    return { status: 'canceled' };
  }

  return cancellation.status === 409
    ? { status: 'retry' }
    : {
        message: `MIDI TO AUDIO Job ${job.jobId} cancellation failed: ${cancellation.message}`,
        status: 'failed',
      };
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}
