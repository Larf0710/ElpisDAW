import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { BasicPitchJobExecutor } from '../engine/jobs/basicPitchJobExecutor.mjs';
import { GpuJobQueue } from '../engine/jobs/gpuJobQueue.mjs';
import { ProjectRootAuthority } from '../engine/projectRootAuthority.mjs';
import {
  BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE,
} from '../engine/providers/basicPitchRuntimeProfile.mjs';
import {
  createBasicPitchHumLikeWave,
  createBasicPitchVerificationJobRequest,
} from './basicPitchVerificationFixture.mjs';

const pythonPath = process.argv[2];

if (typeof pythonPath !== 'string' || !isAbsolute(pythonPath)) {
  throw new Error('Pass the absolute Python executable path for the pinned Basic Pitch venv.');
}

const previousPythonPath = process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE];
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'humstudio-basic-pitch-recovery-verification-'),
);
const projectRootAuthority = new ProjectRootAuthority();
let queue;

try {
  const projectRoot = await projectRootAuthority.configure(temporaryDirectory);
  const recordingRelativePath = 'recordings/artifact-basic-pitch-recovery-verification.wav';
  await writeFile(
    join(projectRoot.rootPath, ...recordingRelativePath.split('/')),
    createBasicPitchHumLikeWave(),
  );
  queue = new GpuJobQueue({
    createJobId: () => 'job-basic-pitch-recovery-verification',
    executor: new BasicPitchJobExecutor({ projectRootAuthority }),
  });
  process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE] = join(
    temporaryDirectory,
    'missing-python.exe',
  );
  const queued = queue.enqueue(
    createBasicPitchVerificationJobRequest({ relativePath: recordingRelativePath }),
  );
  await queue.waitForIdle();
  const failed = queue.getJob(queued.jobId);

  if (
    failed?.state !== 'FAILED' ||
    failed.error?.code !== 'BASIC_PITCH_RUNTIME_UNAVAILABLE'
  ) {
    throw new Error('Basic Pitch Queue did not expose the expected runtime failure.');
  }

  process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE] = pythonPath;
  const startedAt = performance.now();
  queue.retry(queued.jobId);
  await queue.waitForIdle();
  const recovered = queue.getJob(queued.jobId);
  const artifact = recovered?.result?.artifact;
  const matchingNote = artifact?.midi?.notes?.find(
    (note) => note.pitch === 69 && note.startTick <= 200 && note.lengthTicks >= 5_000,
  );

  if (
    recovered?.state !== 'COMPLETED' ||
    recovered.attempt !== 2 ||
    !matchingNote
  ) {
    throw new Error(
      recovered?.error?.message ?? 'Basic Pitch Queue did not recover on retry.',
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        elapsedSeconds: Number(((performance.now() - startedAt) / 1_000).toFixed(3)),
        failedAttempt: {
          attempt: failed.attempt,
          error: failed.error,
          state: failed.state,
        },
        jobId: recovered.jobId,
        matchingNote,
        recoveredAttempt: recovered.attempt,
        states: recovered.history.map((entry) => ({
          attempt: entry.attempt,
          state: entry.state,
        })),
        status: 'RECOVERY_VERIFIED',
        temporaryFilesRemoved: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await queue?.shutdown();
  await rm(temporaryDirectory, { force: true, recursive: true });

  if (previousPythonPath === undefined) {
    delete process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE];
  } else {
    process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE] = previousPythonPath;
  }
}
