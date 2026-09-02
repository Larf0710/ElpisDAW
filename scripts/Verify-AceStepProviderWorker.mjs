import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  ACE_STEP_MODEL_ID,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_TASK_ID,
} from '../engine/providers/aceStepProviderDefinition.mjs';
import {
  ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE,
} from '../engine/providers/aceStepRuntimeProfile.mjs';
import {
  createAceStepProviderWorkerClient,
} from '../engine/providers/aceStepProviderWorkerClient.mjs';
import {
  writeAceStepLegoProbeFixture,
} from './Generate-AceStepLegoProbeFixture.mjs';

const [pythonPath, checkpointsRootPath, evidenceDirectory] = process.argv.slice(2);

for (const [value, label] of [
  [pythonPath, 'Python path'],
  [checkpointsRootPath, 'Checkpoints Root path'],
  [evidenceDirectory, 'Evidence directory'],
]) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`${label} must be absolute.`);
  }
}

const previousPythonPath = process.env[ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE];
const previousCheckpointsRoot =
  process.env[ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE];
const client = createAceStepProviderWorkerClient();

process.env[ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE] = pythonPath;
process.env[ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE] = checkpointsRootPath;

try {
  await mkdir(evidenceDirectory, { recursive: false });
  const fixture = await writeAceStepLegoProbeFixture(
    join(evidenceDirectory, 'fixture'),
  );
  const stagingPath = join(evidenceDirectory, 'worker-output.wav.partial');
  const outputPath = join(evidenceDirectory, 'worker-output.wav');
  const reportPath = join(evidenceDirectory, 'worker-verification.json');
  await writeFile(stagingPath, Buffer.alloc(0), { flag: 'wx' });

  const startedAt = performance.now();
  const provider = await client.start();
  const loaded = await client.loadModel(ACE_STEP_MODEL_ID, ACE_STEP_MODEL_REVISION);
  const execution = await client.execute({
    inputArtifacts: [
      {
        artifactId: 'artifact-ace-step-worker-guide',
        kind: 'audio',
        path: fixture.guidePath,
      },
      {
        artifactId: 'artifact-ace-step-worker-lyrics',
        kind: 'lyrics',
        path: fixture.lyricsPath,
      },
    ],
    jobId: 'job-ace-step-worker-verification',
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    output: { kind: 'audio', stagingPath },
    parameters: {
      audioFormat: 'wav',
      batchSize: 1,
      caption: 'Solo female lead vocal, clear dry a cappella, no instruments',
      channels: 2,
      durationSeconds: 10,
      sampleRate: 48_000,
      seed: 1_370_421,
      targetTrack: 'vocals',
      taskType: 'lego',
      thinking: false,
      vocalLanguage: 'en',
    },
    providerId: ACE_STEP_PROVIDER_ID,
    taskId: ACE_STEP_TASK_ID,
  });
  const unloaded = await client.unloadModel();
  await client.close();

  const stagedBytes = await readFile(stagingPath);
  const stagedStat = await stat(stagingPath);
  const outputSha256 = createHash('sha256').update(stagedBytes).digest('hex');
  if (
    execution.status !== 'COMPLETED' ||
    execution.artifact.bytesWritten !== stagedStat.size ||
    execution.artifact.durationSeconds !== 10 ||
    execution.artifact.channels !== 2 ||
    execution.artifact.mimeType !== 'audio/wav'
  ) {
    throw new Error('ACE-Step Provider Worker result does not match its staged output.');
  }

  await rename(stagingPath, outputPath);
  await access(outputPath);
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  const report = {
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    fixture: fixture.manifest,
    loaded,
    output: {
      bytesWritten: stagedStat.size,
      channels: execution.artifact.channels,
      durationSeconds: execution.artifact.durationSeconds,
      mimeType: execution.artifact.mimeType,
      path: outputPath,
      sha256: outputSha256,
    },
    provider: {
      modelId: provider.models[0].modelId,
      modelRevision: provider.models[0].revision,
      providerId: provider.providerId,
      runtimeProfile: provider.runtime.profile,
    },
    status: 'ACE_STEP_PROVIDER_WORKER_VERIFIED',
    unloaded,
  };

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await client.terminate();
  if (previousPythonPath === undefined) {
    delete process.env[ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE];
  } else {
    process.env[ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE] = previousPythonPath;
  }
  if (previousCheckpointsRoot === undefined) {
    delete process.env[ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE];
  } else {
    process.env[ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE] = previousCheckpointsRoot;
  }
}
