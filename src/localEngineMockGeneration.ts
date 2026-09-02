import type {
  LocalEngineClient,
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobState,
  LocalEngineMockJobRequest,
} from './localEngineClient';

export type LocalEngineMockGenerationProgress = Readonly<{
  jobId?: string;
  state: 'ENQUEUEING' | LocalEngineGpuJobState;
}>;

export type LocalEngineMockGenerationResult =
  | Readonly<{ job: LocalEngineGpuJobRecord; ok: true }>
  | Readonly<{ jobId?: string; message: string; ok: false }>;

type MockGenerationClient = Pick<LocalEngineClient, 'enqueueMockJob' | 'getJobs'>;

type LocalEngineMockGenerationOptions = Readonly<{
  maxPollAttempts?: number;
  onProgress?: (progress: LocalEngineMockGenerationProgress) => void;
  pollIntervalMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}>;

const failedJobStates = new Set<LocalEngineGpuJobState>([
  'CANCELED',
  'FAILED',
  'INTERRUPTED',
  'PAUSED',
]);

export async function runLocalEngineMockGeneration(
  client: MockGenerationClient,
  request: LocalEngineMockJobRequest,
  {
    maxPollAttempts = 300,
    onProgress,
    pollIntervalMs = 100,
    wait = waitForDelay,
  }: LocalEngineMockGenerationOptions = {},
): Promise<LocalEngineMockGenerationResult> {
  onProgress?.({ state: 'ENQUEUEING' });
  const enqueue = await client.enqueueMockJob(request);

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

    const job = snapshotResult.snapshot.jobs.find((candidate) => candidate.jobId === jobId);

    if (!job) {
      return {
        jobId,
        message: `Local Engine no longer reports GPU Job ${jobId}.`,
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
          `GPU Job ${jobId} stopped in ${job.state}.`,
        ok: false,
      };
    }

    await wait(pollIntervalMs);
  }

  return {
    jobId,
    message: `GPU Job ${jobId} did not finish before the UI polling timeout.`,
    ok: false,
  };
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}
