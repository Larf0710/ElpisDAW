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
  join(tmpdir(), 'humstudio-basic-pitch-queue-verification-'),
);
const projectRootAuthority = new ProjectRootAuthority();
let queue;

process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE] = pythonPath;

try {
  const projectRoot = await projectRootAuthority.configure(temporaryDirectory);
  const recordingRelativePath = 'recordings/artifact-basic-pitch-queue-verification.wav';
  await writeFile(
    join(projectRoot.rootPath, ...recordingRelativePath.split('/')),
    createBasicPitchHumLikeWave(),
  );
  queue = new GpuJobQueue({
    createJobId: () => 'job-basic-pitch-queue-verification',
    executor: new BasicPitchJobExecutor({ projectRootAuthority }),
  });
  const startedAt = performance.now();
  const queued = queue.enqueue(
    createBasicPitchVerificationJobRequest({ relativePath: recordingRelativePath }),
  );
  await queue.waitForIdle();
  const completed = queue.getJob(queued.jobId);

  if (completed?.state !== 'COMPLETED') {
    throw new Error(
      completed?.error?.message ?? 'Basic Pitch Queue verification did not complete.',
    );
  }

  const artifact = completed.result?.artifact;
  const matchingNote = artifact?.midi?.notes?.find(
    (note) => note.pitch === 69 && note.startTick <= 200 && note.lengthTicks >= 5_000,
  );

  if (
    !matchingNote ||
    artifact.sourceJobId !== queued.jobId ||
    artifact.lineage.parentArtifactIds[0] !==
      'artifact-basic-pitch-recording-verification' ||
    artifact.lineage.parentClipTakeIds[0] !==
      'clip-take-basic-pitch-recording-verification'
  ) {
    throw new Error('Basic Pitch Queue did not preserve the expected MIDI and lineage.');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        elapsedSeconds: Number(((performance.now() - startedAt) / 1_000).toFixed(3)),
        jobId: completed.jobId,
        matchingNote,
        noteCount: artifact.midi.notes.length,
        states: completed.history.map((entry) => entry.state),
        status: 'VERIFIED',
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
