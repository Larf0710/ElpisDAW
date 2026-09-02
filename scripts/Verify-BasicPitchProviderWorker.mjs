import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  BASIC_PITCH_MODEL_ID,
  BASIC_PITCH_MODEL_REVISION,
  BASIC_PITCH_PROVIDER_ID,
  BASIC_PITCH_TASK_ID,
  BASIC_PITCH_TICKS_PER_QUARTER,
} from '../engine/providers/basicPitchProviderDefinition.mjs';
import {
  BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE,
} from '../engine/providers/basicPitchRuntimeProfile.mjs';
import {
  createBasicPitchProviderWorkerClient,
} from '../engine/providers/basicPitchProviderWorkerClient.mjs';
import { createBasicPitchHumLikeWave } from './basicPitchVerificationFixture.mjs';

const pythonPath = process.argv[2];

if (typeof pythonPath !== 'string' || !isAbsolute(pythonPath)) {
  throw new Error('Pass the absolute Python executable path for the pinned Basic Pitch venv.');
}

const previousPythonPath = process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE];
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'humstudio-basic-pitch-worker-verification-'),
);
const inputPath = join(temporaryDirectory, 'hum-like-a4-with-padding.wav');
const client = createBasicPitchProviderWorkerClient();

process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE] = pythonPath;

try {
  await writeFile(inputPath, createBasicPitchHumLikeWave());
  const startedAt = performance.now();
  const provider = await client.start();
  await client.loadModel(BASIC_PITCH_MODEL_ID, BASIC_PITCH_MODEL_REVISION);
  const execution = await client.execute({
    inputArtifacts: [
      {
        artifactId: 'artifact-basic-pitch-verification',
        kind: 'audio',
        path: inputPath,
      },
    ],
    jobId: 'job-basic-pitch-verification',
    modelId: BASIC_PITCH_MODEL_ID,
    modelRevision: BASIC_PITCH_MODEL_REVISION,
    output: { kind: 'midi' },
    parameters: {
      frameThreshold: 0.3,
      maximumFrequencyHz: 880,
      melodiaTrick: true,
      minimumFrequencyHz: 220,
      minimumNoteLengthMs: 127.7,
      multiplePitchBends: false,
      onsetThreshold: 0.5,
      projectBpm: 120,
      sourceEndSeconds: 3.5,
      sourceStartSeconds: 0.5,
      ticksPerQuarter: BASIC_PITCH_TICKS_PER_QUARTER,
    },
    providerId: BASIC_PITCH_PROVIDER_ID,
    taskId: BASIC_PITCH_TASK_ID,
  });
  await client.unloadModel();
  await client.close();
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  const matchingNote = execution.artifact.notes.find(
    (note) => note.pitch === 69 && note.startTick <= 200 && note.lengthTicks >= 5_000,
  );

  if (!matchingNote) {
    throw new Error('Basic Pitch Provider Worker did not return the expected cropped A4 note.');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        matchingNote,
        noteCount: execution.artifact.notes.length,
        providerId: provider.providerId,
        status: 'VERIFIED',
        temporaryFilesRemoved: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.terminate();
  await rm(temporaryDirectory, { force: true, recursive: true });

  if (previousPythonPath === undefined) {
    delete process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE];
  } else {
    process.env[BASIC_PITCH_PYTHON_ENVIRONMENT_VARIABLE] = previousPythonPath;
  }
}
