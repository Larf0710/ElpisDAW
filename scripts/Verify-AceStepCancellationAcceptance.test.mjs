import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ACE_STEP_MODEL_ID,
} from '../engine/providers/aceStepProviderDefinition.mjs';
import {
  ACE_STEP_PROVIDER_CODE_REVISION,
  ACE_STEP_SUPPORT_MODEL_REVISION,
} from '../engine/providers/aceStepRuntimeProfile.mjs';
import {
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_RUNTIME_PROFILE_ID,
} from '../shared/aceStepProtocol.js';
import {
  ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_REPORT_NAME,
  ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_STATUS,
  ACE_STEP_CANCELLATION_ACCEPTANCE_REPORT_NAME,
  ACE_STEP_CANCELLATION_ACCEPTANCE_STATUS,
  runAceStepCancellationAcceptance,
  runAceStepCancellationAcceptanceCli,
  validateAcceptanceArguments,
} from './Verify-AceStepCancellationAcceptance.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('ACE-Step cancellation acceptance harness', () => {
  it('requires exactly three absolute arguments before mutation', async () => {
    await expect(validateAcceptanceArguments([])).rejects.toMatchObject({
      code: 'ACE_STEP_ACCEPTANCE_CLI_USAGE_INVALID',
    });
    await expect(
      validateAcceptanceArguments([
        'relative-python',
        'relative-model',
        'relative-evidence',
      ]),
    ).rejects.toMatchObject({
      code: 'ACE_STEP_ACCEPTANCE_CLI_USAGE_INVALID',
    });
  });

  it('rejects unavailable and mismatched Runtime or Model identity before evidence creation', async () => {
    const paths = await createPaths({ pythonRevision: 'wrong-revision' });

    await expect(
      validateAcceptanceArguments([
        paths.pythonPath,
        paths.checkpointsRootPath,
        paths.evidenceDirectory,
      ]),
    ).rejects.toMatchObject({
      code: 'ACE_STEP_ACCEPTANCE_IDENTITY_MISMATCH',
    });
    await expect(
      validateAcceptanceArguments([
        join(paths.rootPath, 'missing-python.exe'),
        paths.checkpointsRootPath,
        paths.evidenceDirectory,
      ]),
    ).rejects.toMatchObject({
      code: 'ACE_STEP_ACCEPTANCE_PYTHON_UNAVAILABLE',
    });
    await expect(readFile(paths.evidenceDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a pre-existing evidence directory without running preflight', async () => {
    const paths = await createPaths();
    await mkdir(paths.evidenceDirectory);
    let preflightCalls = 0;

    await expect(
      runAceStepCancellationAcceptance(createArgs(paths), {
        preflightRuntime: async () => {
          preflightCalls += 1;
          return createPreflight();
        },
      }),
    ).rejects.toMatchObject({
      code: 'ACE_STEP_ACCEPTANCE_EVIDENCE_EXISTS',
    });
    expect(preflightCalls).toBe(0);
  });

  it('fails preflight identity mismatch before creating evidence', async () => {
    const paths = await createPaths();

    await expect(
      runAceStepCancellationAcceptance(createArgs(paths), {
        preflightRuntime: async () => ({
          ...createPreflight(),
          providerCodeRevision: 'wrong-revision',
        }),
      }),
    ).rejects.toMatchObject({
      code: 'ACE_STEP_ACCEPTANCE_PREFLIGHT_MISMATCH',
    });
    await expect(readFile(paths.evidenceDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('times out bounded state polling, writes failure evidence, and terminates', async () => {
    const paths = await createPaths();
    const clock = createClock();
    let queue;

    await expect(
      runAceStepCancellationAcceptance(createArgs(paths), {
        activeTimeoutMs: 3,
        createRuntime: ({ projectRootPath }) => {
          queue = new FakeAcceptanceQueue(projectRootPath, {
            neverActivate: true,
          });
          return { queue };
        },
        monotonicNow: clock.now,
        nowIso: createIsoClock(),
        pollIntervalMs: 1,
        preflightRuntime: async () => createPreflight(),
        wait: clock.wait,
        writeFixture: writeFastFixture,
      }),
    ).rejects.toMatchObject({ code: 'ACE_STEP_ACCEPTANCE_POLL_TIMEOUT' });

    expect(queue.shutdownCalls).toBe(1);
    const failure = await readJson(
      join(
        paths.evidenceDirectory,
        ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_REPORT_NAME,
      ),
    );
    expect(failure.status).toBe(
      ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_STATUS,
    );
    expect(JSON.stringify(failure)).not.toContain(
      ACE_STEP_CANCELLATION_ACCEPTANCE_STATUS,
    );
  });

  it('fails a wrong or stale Job before sending cancellation', async () => {
    const paths = await createPaths();
    const clock = createClock();
    let queue;

    await expect(
      runAceStepCancellationAcceptance(createArgs(paths), {
        createRuntime: ({ projectRootPath }) => {
          queue = new FakeAcceptanceQueue(projectRootPath, {
            staleActiveJob: true,
          });
          return { queue };
        },
        monotonicNow: clock.now,
        nowIso: createIsoClock(),
        pollIntervalMs: 1,
        preflightRuntime: async () => createPreflight(),
        wait: async (delay) => {
          await clock.wait(delay);
          await queue.advance();
        },
        writeFixture: writeFastFixture,
      }),
    ).rejects.toMatchObject({
      code: 'ACE_STEP_ACCEPTANCE_JOB_IDENTITY_INVALID',
    });

    expect(queue.cancelCalls).toBe(0);
    expect(queue.shutdownCalls).toBe(1);
  });

  it('records cancellation cleanup failure as FAILED evidence and always terminates', async () => {
    const paths = await createPaths();
    const clock = createClock();
    let queue;

    await expect(
      runAceStepCancellationAcceptance(createArgs(paths), {
        createRuntime: ({ projectRootPath }) => {
          queue = new FakeAcceptanceQueue(projectRootPath, {
            cancellationFailure: true,
          });
          return { queue };
        },
        monotonicNow: clock.now,
        nowIso: createIsoClock(),
        pollIntervalMs: 1,
        preflightRuntime: async () => createPreflight(),
        wait: async (delay) => {
          await clock.wait(delay);
          await queue.advance();
        },
        writeFixture: writeFastFixture,
      }),
    ).rejects.toMatchObject({ code: 'TEST_CANCELLATION_CLEANUP_FAILED' });

    expect(queue.cancelCalls).toBe(1);
    expect(queue.shutdownCalls).toBe(1);
    const failure = await readJson(
      join(
        paths.evidenceDirectory,
        ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_REPORT_NAME,
      ),
    );
    expect(failure).toMatchObject({
      error: { code: 'TEST_CANCELLATION_CLEANUP_FAILED' },
      status: ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_STATUS,
      termination: { completed: true },
    });
  });

  it('preserves a classified recovery Job failure in FAILED evidence', async () => {
    const paths = await createPaths();
    const clock = createClock();
    let queue;

    await expect(
      runAceStepCancellationAcceptance(createArgs(paths), {
        createRuntime: ({ projectRootPath }) => {
          queue = new FakeAcceptanceQueue(projectRootPath, {
            recoveryFailure: true,
          });
          return { queue };
        },
        monotonicNow: clock.now,
        nowIso: createIsoClock(),
        pollIntervalMs: 1,
        preflightRuntime: async () => createPreflight(),
        wait: async (delay) => {
          await clock.wait(delay);
          await queue.advance();
        },
        writeFixture: writeFastFixture,
      }),
    ).rejects.toMatchObject({ code: 'TEST_RECOVERY_FAILED' });

    const failure = await readJson(
      join(
        paths.evidenceDirectory,
        ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_REPORT_NAME,
      ),
    );
    expect(failure).toMatchObject({
      error: {
        code: 'TEST_RECOVERY_FAILED',
        message: 'Recovery generation failed.',
      },
      status: ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_STATUS,
      termination: { completed: true },
    });
  });

  it('verifies idempotent cancellation, cleanup, recovery, strict UTF-8 report, and termination', async () => {
    const paths = await createPaths();
    const clock = createClock();
    let queue;

    const result = await runAceStepCancellationAcceptance(createArgs(paths), {
      createRuntime: ({ projectRootPath }) => {
        queue = new FakeAcceptanceQueue(projectRootPath);
        return { queue };
      },
      monotonicNow: clock.now,
      nowIso: createIsoClock(),
      pollIntervalMs: 1,
      preflightRuntime: async () => createPreflight(),
      wait: async (delay) => {
        await clock.wait(delay);
        await queue.advance();
      },
      writeFixture: writeFastFixture,
    });

    expect(queue.cancelCalls).toBe(1);
    expect(queue.repeatedCancellationCalls).toBe(1);
    expect(queue.shutdownCalls).toBe(1);
    expect(result.report).toMatchObject({
      cancellation: {
        idempotentRepeatedCancellation: true,
        requestedFromState: 'PROCESSING',
        terminalState: 'CANCELED',
      },
      cleanup: {
        finalizedVocalArtifactCount: 0,
        partialOrStagingFileCount: 0,
        queueIdle: true,
        reservationCount: 0,
        unrelatedFilePreserved: true,
      },
      recovery: {
        terminalState: 'COMPLETED',
        wave: { channels: 2, durationSeconds: 10, sampleRate: 48_000 },
      },
      status: ACE_STEP_CANCELLATION_ACCEPTANCE_STATUS,
      termination: { completed: true },
    });

    const reportBytes = await readFile(
      join(
        paths.evidenceDirectory,
        ACE_STEP_CANCELLATION_ACCEPTANCE_REPORT_NAME,
      ),
    );
    expect(reportBytes.subarray(0, 3)).not.toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
    const reportText = new TextDecoder('utf-8', { fatal: true }).decode(
      reportBytes,
    );
    expect(reportText).not.toContain('\uFFFD');
    expect(JSON.parse(reportText)).toEqual(result.report);
  });

  it('returns classified CLI output without throwing or loading a model', async () => {
    const output = [];
    const successExit = await runAceStepCancellationAcceptanceCli(
      ['C:\\python.exe', 'C:\\models', 'C:\\evidence'],
      {
        runAcceptance: async () => ({
          report: { status: ACE_STEP_CANCELLATION_ACCEPTANCE_STATUS },
        }),
        writeOutput: (value) => output.push(value),
      },
    );
    const failureExit = await runAceStepCancellationAcceptanceCli([], {
      runAcceptance: async () => {
        throw Object.assign(new Error('Acceptance failed.'), {
          code: 'TEST_ACCEPTANCE_FAILED',
        });
      },
      writeOutput: (value) => output.push(value),
    });

    expect(successExit).toBe(0);
    expect(failureExit).toBe(1);
    expect(JSON.parse(output[0]).status).toBe(
      ACE_STEP_CANCELLATION_ACCEPTANCE_STATUS,
    );
    expect(JSON.parse(output[1])).toEqual({
      error: {
        code: 'TEST_ACCEPTANCE_FAILED',
        message: 'Acceptance failed.',
      },
      status: ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_STATUS,
    });
  });
});

class FakeAcceptanceQueue {
  constructor(projectRootPath, options = {}) {
    this.options = options;
    this.projectRootPath = projectRootPath;
  }

  cancelCalls = 0;
  jobs = new Map();
  nextJobNumber = 0;
  repeatedCancellationCalls = 0;
  shutdownCalls = 0;

  enqueue(request) {
    const jobId = `job-acceptance-${++this.nextJobNumber}`;
    const job = { jobId, request, state: 'QUEUED' };
    this.jobs.set(jobId, job);
    return job;
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);

    if (
      this.options.staleActiveJob &&
      job?.state === 'PROCESSING' &&
      jobId === 'job-acceptance-1'
    ) {
      return { ...job, jobId: 'job-stale-owner' };
    }

    return job;
  }

  getSnapshot() {
    const jobs = [...this.jobs.values()];
    const active = jobs.find((job) =>
      ['LOADING_MODEL', 'PROCESSING', 'SAVING', 'CANCEL_REQUESTED'].includes(
        job.state,
      ),
    );
    return {
      acceptingJobs: this.shutdownCalls === 0,
      activeJobId: active?.jobId,
      jobs,
    };
  }

  requestCancel(jobId) {
    const job = this.jobs.get(jobId);

    if (job?.state === 'CANCEL_REQUESTED') {
      this.repeatedCancellationCalls += 1;
      return Promise.resolve({ ...job });
    }

    if (!job || job.state !== 'PROCESSING') {
      return Promise.reject(new Error('Test Job is not cancellable.'));
    }

    this.cancelCalls += 1;
    job.state = 'CANCEL_REQUESTED';

    if (this.options.cancellationFailure) {
      return Promise.resolve().then(() => {
        job.state = 'FAILED';
        throw Object.assign(new Error('Cancellation cleanup failed.'), {
          code: 'TEST_CANCELLATION_CLEANUP_FAILED',
        });
      });
    }

    return Promise.resolve(job);
  }

  waitForIdle() {
    return Promise.resolve();
  }

  async shutdown() {
    this.shutdownCalls += 1;
  }

  async advance() {
    const first = this.jobs.get('job-acceptance-1');

    if (first?.state === 'QUEUED' && !this.options.neverActivate) {
      first.state = 'PROCESSING';
      return;
    }

    if (first?.state === 'CANCEL_REQUESTED') {
      first.state = 'CANCELED';
      return;
    }

    const recovery = this.jobs.get('job-acceptance-2');

    if (recovery?.state === 'QUEUED') {
      recovery.state = 'PROCESSING';
      return;
    }

    if (recovery?.state === 'PROCESSING') {
      if (this.options.recoveryFailure) {
        recovery.state = 'FAILED';
        recovery.error = {
          code: 'TEST_RECOVERY_FAILED',
          message: 'Recovery generation failed.',
        };
        return;
      }

      const relativePath =
        'renders/ace-step/artifact-acceptance-recovery.wav';
      const outputPath = join(
        this.projectRootPath,
        ...relativePath.split('/'),
      );
      const bytes = createRecoveryWave();
      await writeFile(outputPath, bytes, { flag: 'wx' });
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      recovery.state = 'COMPLETED';
      recovery.result = {
        artifact: {
          artifactId: 'artifact-acceptance-recovery',
          destination: ACE_STEP_OUTPUT_DESTINATION,
          file: {
            extension: '.wav',
            name: 'artifact-acceptance-recovery.wav',
            relativePath,
            sizeBytes: bytes.byteLength,
          },
          kind: 'audio',
        },
        generation: {
          bytesWritten: bytes.byteLength,
          channels: 2,
          durationSeconds: 10,
          evidence: {
            outputEncoding: 'PCM16',
            outputSha256: sha256,
            sampleRate: 48_000,
          },
          mimeType: 'audio/wav',
        },
      };
    }
  }
}

async function createPaths({ pythonRevision = ACE_STEP_PROVIDER_CODE_REVISION } = {}) {
  const rootPath = await mkdtemp(
    join(tmpdir(), 'humstudio-ace-cancellation-acceptance-'),
  );
  temporaryDirectories.push(rootPath);
  const pythonPath = join(
    rootPath,
    'runtime',
    pythonRevision,
    'Scripts',
    'python.exe',
  );
  const checkpointsRootPath = join(
    rootPath,
    'models',
    ACE_STEP_SUPPORT_MODEL_REVISION,
  );
  const evidenceDirectory = join(rootPath, 'evidence');
  await mkdir(dirname(pythonPath), { recursive: true });
  await writeFile(pythonPath, 'test-python', 'utf8');
  await mkdir(checkpointsRootPath, { recursive: true });
  return { checkpointsRootPath, evidenceDirectory, pythonPath, rootPath };
}

function createArgs(paths) {
  return [
    paths.pythonPath,
    paths.checkpointsRootPath,
    paths.evidenceDirectory,
  ];
}

function createPreflight() {
  return {
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    offline: true,
    profileId: ACE_STEP_RUNTIME_PROFILE_ID,
    providerCodeRevision: ACE_STEP_PROVIDER_CODE_REVISION,
    status: 'READY',
    supportModelRevision: ACE_STEP_SUPPORT_MODEL_REVISION,
  };
}

async function writeFastFixture(outputDirectory) {
  await mkdir(outputDirectory);
  const guidePath = join(outputDirectory, 'guide.wav');
  const lyricsPath = join(outputDirectory, 'lyrics.txt');
  await writeFile(guidePath, createRecoveryWave(), { flag: 'wx' });
  await writeFile(lyricsPath, '[Verse]\nTest fixture\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
  return {
    guidePath,
    lyricsPath,
    manifest: {
      channels: 2,
      durationSeconds: 10,
      guideSizeBytes: createRecoveryWave().byteLength,
      sampleRate: 48_000,
      source: 'injected-unit-test-fixture',
    },
  };
}

function createRecoveryWave() {
  const channels = 2;
  const sampleRate = 48_000;
  const frameCount = sampleRate * 10;
  const blockAlign = channels * 2;
  const dataSize = frameCount * blockAlign;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataSize, 40);
  bytes.writeInt16LE(1_024, 44);
  bytes.writeInt16LE(-1_024, 46);
  return bytes;
}

function createClock() {
  let value = 0;
  return {
    now: () => value,
    wait: async (delay) => {
      value += delay;
    },
  };
}

function createIsoClock() {
  let second = 0;
  return () => new Date(Date.UTC(2026, 7, 17, 0, 0, second++)).toISOString();
}

async function readJson(pathValue) {
  return JSON.parse(await readFile(pathValue, 'utf8'));
}
