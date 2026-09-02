import type {
  LocalEngineClient,
  LocalEngineBasicPitchHumToMidiJobRequest,
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
  LocalEngineMockHumToMidiJobRequest,
} from './localEngineClient';

export type LocalEngineHumToMidiGenerationProgress = Readonly<{
  jobId?: string;
  state: 'ENQUEUEING' | LocalEngineGpuJobState;
}>;

export type LocalEngineHumToMidiGenerationResult =
  | Readonly<{ job: LocalEngineGpuJobRecord; ok: true }>
  | Readonly<{ jobId?: string; message: string; ok: false }>;

type HumToMidiGenerationClient = Pick<
  LocalEngineClient,
  'enqueueMockHumToMidiJob' | 'getJobs'
>;

type LocalEngineHumToMidiGenerationOptions = Readonly<{
  maxPollAttempts?: number;
  onProgress?: (progress: LocalEngineHumToMidiGenerationProgress) => void;
  pollIntervalMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}>;

const failedJobStates = new Set<LocalEngineGpuJobState>([
  'CANCELED',
  'FAILED',
  'INTERRUPTED',
  'PAUSED',
]);

export async function runLocalEngineHumToMidiGeneration(
  client: HumToMidiGenerationClient,
  request: LocalEngineMockHumToMidiJobRequest,
  {
    maxPollAttempts = 300,
    onProgress,
    pollIntervalMs = 100,
    wait = waitForDelay,
  }: LocalEngineHumToMidiGenerationOptions = {},
): Promise<LocalEngineHumToMidiGenerationResult> {
  onProgress?.({ state: 'ENQUEUEING' });
  const enqueue = await client.enqueueMockHumToMidiJob(request);

  if (!enqueue.ok) {
    return { message: enqueue.message, ok: false };
  }

  const jobId = enqueue.job.jobId;
  let lastState: LocalEngineGpuJobState | undefined;

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    const snapshotResult = await client.getJobs();

    if (!snapshotResult.ok) {
      return { jobId, message: snapshotResult.message, ok: false };
    }

    const job = snapshotResult.snapshot.jobs.find(
      (candidate) => candidate.jobId === jobId,
    );

    if (!job) {
      return {
        jobId,
        message: `Local Engine no longer reports Hum-to-MIDI Job ${jobId}.`,
        ok: false,
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
          `Hum-to-MIDI Job ${jobId} stopped in ${job.state}.`,
        ok: false,
      };
    }

    await wait(pollIntervalMs);
  }

  return {
    jobId,
    message: `Hum-to-MIDI Job ${jobId} did not finish before the UI polling timeout.`,
    ok: false,
  };
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

export type LocalEngineBasicPitchHumToMidiProgress = Readonly<{
  jobId?: string;
  state: 'ENQUEUEING' | 'RETRYING' | LocalEngineGpuJobState;
}>;

export type LocalEngineBasicPitchHumToMidiResult =
  | Readonly<{ job: LocalEngineGpuJobRecord; ok: true }>
  | Readonly<{
      job?: LocalEngineGpuJobRecord;
      jobId?: string;
      message: string;
      ok: false;
      reason: 'canceled' | 'engine-job-failed';
      retryable: boolean;
    }>;

export type LocalEngineBasicPitchHumToMidiClient = Pick<
  LocalEngineClient,
  | 'enqueueBasicPitchHumToMidiJob'
  | 'getJobs'
  | 'removeQueuedJob'
  | 'retryJob'
>;

export type LocalEngineBasicPitchHumToMidiOptions = Readonly<{
  maxPollAttempts?: number;
  onProgress?: (progress: LocalEngineBasicPitchHumToMidiProgress) => void;
  pollIntervalMs?: number;
  retryJobId?: string;
  signal?: AbortSignal;
  wait?: (delayMs: number) => Promise<void>;
}>;

export async function runLocalEngineBasicPitchHumToMidiGeneration(
  client: LocalEngineBasicPitchHumToMidiClient,
  request: LocalEngineBasicPitchHumToMidiJobRequest,
  {
    maxPollAttempts = 900,
    onProgress,
    pollIntervalMs = 100,
    retryJobId,
    signal,
    wait = waitForDelay,
  }: LocalEngineBasicPitchHumToMidiOptions = {},
): Promise<LocalEngineBasicPitchHumToMidiResult> {
  if (signal?.aborted) {
    return basicPitchCanceled('Basic Pitch was canceled before dispatch.');
  }

  let initialJob: LocalEngineGpuJobRecord;

  if (retryJobId) {
    onProgress?.({ jobId: retryJobId, state: 'RETRYING' });
    const snapshot = await client.getJobs();

    if (!snapshot.ok) {
      return basicPitchFailure(
        'Local Engine Job state could not be verified before retry.',
        retryJobId,
      );
    }

    const failedJob = snapshot.snapshot.jobs.find(
      (candidate) => candidate.jobId === retryJobId,
    );

    if (
      !failedJob ||
      failedJob.state !== 'FAILED' ||
      !doesJobMatchBasicPitchRequest(failedJob, request)
    ) {
      return basicPitchFailure(
        'The exact failed Basic Pitch Job is unavailable or no longer matches its request.',
        retryJobId,
      );
    }

    const retry = await client.retryJob(retryJobId);

    if (
      !retry.ok ||
      retry.job.jobId !== retryJobId ||
      !doesJobMatchBasicPitchRequest(retry.job, request)
    ) {
      return basicPitchFailure(
        'The exact Basic Pitch Job could not be retried safely.',
        retryJobId,
        failedJob,
      );
    }

    initialJob = retry.job;
  } else {
    onProgress?.({ state: 'ENQUEUEING' });
    const enqueue = await client.enqueueBasicPitchHumToMidiJob(request);

    if (!enqueue.ok) {
      return basicPitchFailure(
        'Local Engine rejected the Basic Pitch Job.',
      );
    }

    if (!doesJobMatchBasicPitchRequest(enqueue.job, request)) {
      return basicPitchFailure(
        'Local Engine returned a Basic Pitch Job that did not match its request.',
        enqueue.job.jobId,
        enqueue.job,
      );
    }

    initialJob = enqueue.job;
  }

  return pollBasicPitchHumToMidiJob(client, request, initialJob, {
    maxPollAttempts,
    onProgress,
    pollIntervalMs,
    signal,
    wait,
  });
}

async function pollBasicPitchHumToMidiJob(
  client: LocalEngineBasicPitchHumToMidiClient,
  request: LocalEngineBasicPitchHumToMidiJobRequest,
  initialJob: LocalEngineGpuJobRecord,
  options: Required<
    Pick<
      LocalEngineBasicPitchHumToMidiOptions,
      'maxPollAttempts' | 'pollIntervalMs' | 'wait'
    >
  > &
    Pick<LocalEngineBasicPitchHumToMidiOptions, 'onProgress' | 'signal'>,
): Promise<LocalEngineBasicPitchHumToMidiResult> {
  let job = initialJob;
  let lastState: LocalEngineBasicPitchHumToMidiProgress['state'] | undefined;

  for (let attempt = 0; attempt < options.maxPollAttempts; attempt += 1) {
    if (!doesJobMatchBasicPitchRequest(job, request)) {
      return basicPitchFailure(
        'Basic Pitch Job identity changed while it was running.',
        job.jobId,
        job,
      );
    }

    if (job.state !== lastState) {
      lastState = job.state;
      options.onProgress?.({ jobId: job.jobId, state: job.state });
    }

    if (job.state === 'COMPLETED') {
      return Object.freeze({ job, ok: true as const });
    }

    if (failedJobStates.has(job.state)) {
      return Object.freeze({
        job,
        jobId: job.jobId,
        message: `Basic Pitch Job stopped in ${job.state}.`,
        ok: false as const,
        reason: job.state === 'CANCELED' ? ('canceled' as const) : ('engine-job-failed' as const),
        retryable: job.state === 'FAILED',
      });
    }

    if (options.signal?.aborted && job.state === 'QUEUED') {
      const removal = await client.removeQueuedJob(job.jobId);

      if (removal.ok) {
        return basicPitchCanceled(
          'Queued Basic Pitch Job was removed before conversion.',
          job.jobId,
        );
      }

      if (removal.status !== 409) {
        return basicPitchFailure(
          'Queued Basic Pitch Job could not be removed safely.',
          job.jobId,
          job,
        );
      }
    }

    await options.wait(options.pollIntervalMs);
    const snapshot = await client.getJobs();

    if (!snapshot.ok) {
      return basicPitchFailure(
        'Local Engine Job state could not be read.',
        job.jobId,
        job,
      );
    }

    const nextJob = snapshot.snapshot.jobs.find(
      (candidate) => candidate.jobId === job.jobId,
    );

    if (!nextJob) {
      return basicPitchFailure(
        'Local Engine no longer reports the exact Basic Pitch Job.',
        job.jobId,
        job,
      );
    }

    job = nextJob;
  }

  return basicPitchFailure(
    'Basic Pitch did not finish before the UI polling timeout.',
    job.jobId,
    job,
  );
}

function doesJobMatchBasicPitchRequest(
  job: LocalEngineGpuJobRecord,
  request: LocalEngineBasicPitchHumToMidiJobRequest,
): boolean {
  return (
    job.modelId === request.modelId &&
    job.modelRevision === request.modelRevision &&
    job.providerId === request.providerId &&
    job.taskId === request.taskId &&
    stableJson(job.request) === stableJson(request)
  );
}

function basicPitchCanceled(
  message: string,
  jobId?: string,
): LocalEngineBasicPitchHumToMidiResult {
  return Object.freeze({
    ...(jobId ? { jobId } : {}),
    message,
    ok: false as const,
    reason: 'canceled' as const,
    retryable: false,
  });
}

function basicPitchFailure(
  message: string,
  jobId?: string,
  job?: LocalEngineGpuJobRecord,
): LocalEngineBasicPitchHumToMidiResult {
  return Object.freeze({
    ...(job ? { job } : {}),
    ...(jobId ? { jobId } : {}),
    message,
    ok: false as const,
    reason: 'engine-job-failed' as const,
    retryable: job?.state === 'FAILED',
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
