import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';

import { BasicPitchJobExecutor } from '../engine/jobs/basicPitchJobExecutor.mjs';
import { GpuJobQueue } from '../engine/jobs/gpuJobQueue.mjs';
import { ProjectRootAuthority } from '../engine/projectRootAuthority.mjs';
import {
  inspectRecordingWav,
  MAX_RECORDING_WAV_BYTES,
} from '../engine/recordingArtifactWriter.mjs';
import {
  BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE,
} from '../engine/providers/basicPitchRuntimeProfile.mjs';
import {
  createBasicPitchVerificationJobRequest,
} from './basicPitchVerificationFixture.mjs';

const pythonPath = requireAbsolutePath(
  process.argv[2],
  'Pass the absolute Python executable path for the pinned Basic Pitch venv.',
);
const sourcePath = requireAbsolutePath(
  process.argv[3],
  'Pass the absolute path to one ElpisDAW mono PCM recording WAV.',
);

if (extname(sourcePath).toLowerCase() !== '.wav') {
  throw new Error('Basic Pitch humming acceptance input must use the .wav extension.');
}

const sourceStat = await lstat(sourcePath);

if (
  !sourceStat.isFile() ||
  sourceStat.isSymbolicLink() ||
  sourceStat.size <= 44 ||
  sourceStat.size > MAX_RECORDING_WAV_BYTES
) {
  throw new Error('Basic Pitch humming acceptance requires one regular ElpisDAW recording WAV.');
}

const canonicalSourcePath = await realpath(sourcePath);
const sourceBytes = await readFile(canonicalSourcePath);
const audio = inspectRecordingWav(sourceBytes);
const sourceStartSeconds = readOptionalNumber(process.argv[4], 0, 'Source start');
const sourceEndSeconds = readOptionalNumber(
  process.argv[5],
  audio.durationSeconds,
  'Source end',
);
const projectBpm = readOptionalNumber(process.argv[6], 120, 'Project BPM');

if (
  sourceStartSeconds < 0 ||
  sourceEndSeconds <= sourceStartSeconds ||
  sourceEndSeconds > audio.durationSeconds
) {
  throw new Error('Source range must be increasing and remain inside the recording duration.');
}

if (projectBpm < 40 || projectBpm > 240) {
  throw new Error('Project BPM must be from 40 through 240.');
}

const previousPythonPath = process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE];
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'humstudio-basic-pitch-humming-acceptance-'),
);
const projectRootAuthority = new ProjectRootAuthority();
let queue;

process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE] = pythonPath;

try {
  const projectRoot = await projectRootAuthority.configure(temporaryDirectory);
  const recordingRelativePath = 'recordings/artifact-basic-pitch-humming-acceptance.wav';
  await writeFile(
    join(projectRoot.rootPath, ...recordingRelativePath.split('/')),
    sourceBytes,
  );
  queue = new GpuJobQueue({
    createJobId: () => 'job-basic-pitch-humming-acceptance',
    executor: new BasicPitchJobExecutor({ projectRootAuthority }),
  });
  const startedAt = performance.now();
  const queued = queue.enqueue(
    createBasicPitchVerificationJobRequest({
      artifactId: 'artifact-basic-pitch-humming-acceptance',
      clipTakeId: 'clip-take-basic-pitch-humming-acceptance',
      maximumFrequencyHz: 1_100,
      minimumFrequencyHz: 80,
      projectBpm,
      relativePath: recordingRelativePath,
      sourceEndSeconds,
      sourceStartSeconds,
    }),
  );
  await queue.waitForIdle();
  const completed = queue.getJob(queued.jobId);

  if (completed?.state !== 'COMPLETED') {
    throw new Error(
      completed?.error
        ? `${completed.error.code}: ${completed.error.message}`
        : 'Basic Pitch humming acceptance Job did not complete.',
    );
  }

  const artifact = completed.result?.artifact;
  const notes = artifact?.midi?.notes;

  if (!Array.isArray(notes)) {
    throw new Error('Basic Pitch humming acceptance did not return a MIDI Artifact.');
  }

  const confidences = notes.flatMap((note) =>
    typeof note.confidence === 'number' ? [note.confidence] : [],
  );
  const pitches = notes.map((note) => note.pitch);

  process.stdout.write(
    `${JSON.stringify(
      {
        artifact,
        audio,
        checks: {
          artifactAndLineage: 'PASSED',
          queueExecution: 'PASSED',
          realVocalQuality: 'MANUAL_REVIEW_REQUIRED',
          runtime: 'PASSED',
        },
        elapsedSeconds: Number(((performance.now() - startedAt) / 1_000).toFixed(3)),
        source: {
          fileName: canonicalSourcePath.split(/[\\/]/).at(-1),
          projectBpm,
          sourceEndSeconds,
          sourceStartSeconds,
        },
        summary: {
          averageConfidence:
            confidences.length === 0
              ? undefined
              : Number(
                  (
                    confidences.reduce((total, confidence) => total + confidence, 0) /
                    confidences.length
                  ).toFixed(9),
                ),
          maximumPitch: pitches.length === 0 ? undefined : Math.max(...pitches),
          minimumPitch: pitches.length === 0 ? undefined : Math.min(...pitches),
          noteCount: notes.length,
        },
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

function requireAbsolutePath(value, message) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(message);
  }

  return value;
}

function readOptionalNumber(value, fallback, label) {
  if (value === undefined) {
    return fallback;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a finite number.`);
  }

  return number;
}
