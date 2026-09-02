import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  ACE_STEP_COVER_TASK_ID,
  ACE_STEP_MODEL_ID,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_TASK_ID,
  ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
} from '../engine/providers/aceStepProviderDefinition.mjs';
import {
  ACE_STEP_CFG_INTERVAL_END,
  ACE_STEP_CFG_INTERVAL_START,
  ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
  ACE_STEP_DCW_ENABLED,
  ACE_STEP_GENERATION_INSTRUCTION,
  ACE_STEP_GUIDANCE_SCALE,
  ACE_STEP_INFERENCE_STEPS,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE,
  ACE_STEP_SHIFT,
  ACE_STEP_USE_ADG,
} from '../engine/providers/aceStepRuntimeProfile.mjs';
import { createAceStepProviderWorkerClient } from '../engine/providers/aceStepProviderWorkerClient.mjs';
import { writeAceStepLegoProbeFixture } from './Generate-AceStepLegoProbeFixture.mjs';

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
  const fixture = await writeAceStepLegoProbeFixture(join(evidenceDirectory, 'fixture'));
  const startedAt = performance.now();
  const provider = await client.start();
  const loaded = await client.loadModel(ACE_STEP_MODEL_ID, ACE_STEP_MODEL_REVISION);
  const outputs = [];

  for (const testCase of createTestCases(fixture)) {
    const stagingPath = join(evidenceDirectory, `${testCase.name}.wav.partial`);
    const outputPath = join(evidenceDirectory, `${testCase.name}.wav`);
    await writeFile(stagingPath, Buffer.alloc(0), { flag: 'wx' });

    const execution = await client.execute({
      ...testCase.job,
      output: { kind: 'audio', stagingPath },
    });
    const stagedBytes = await readFile(stagingPath);
    const stagedStat = await stat(stagingPath);

    if (
      execution.status !== 'COMPLETED' ||
      execution.artifact.bytesWritten !== stagedStat.size ||
      execution.artifact.durationSeconds !== 10 ||
      execution.artifact.channels !== 2 ||
      execution.artifact.mimeType !== 'audio/wav'
    ) {
      throw new Error(`${testCase.name} result does not match its staged output.`);
    }

    await rename(stagingPath, outputPath);
    outputs.push({
      bytesWritten: stagedStat.size,
      channels: execution.artifact.channels,
      durationSeconds: execution.artifact.durationSeconds,
      mimeType: execution.artifact.mimeType,
      path: outputPath,
      sha256: createHash('sha256').update(stagedBytes).digest('hex'),
      taskId: testCase.job.taskId,
    });
  }

  const unloaded = await client.unloadModel();
  await client.close();
  const report = {
    elapsedSeconds: Number(((performance.now() - startedAt) / 1_000).toFixed(3)),
    fixture: fixture.manifest,
    loaded,
    outputs,
    provider: {
      modelId: provider.models[0].modelId,
      modelRevision: provider.models[0].revision,
      providerId: provider.providerId,
      runtimeProfile: provider.runtime.profile,
    },
    qualityProfile: {
      cfgIntervalEnd: ACE_STEP_CFG_INTERVAL_END,
      cfgIntervalStart: ACE_STEP_CFG_INTERVAL_START,
      dcwEnabled: ACE_STEP_DCW_ENABLED,
      guidanceScale: ACE_STEP_GUIDANCE_SCALE,
      inferenceSteps: ACE_STEP_INFERENCE_STEPS,
      legoInstruction: ACE_STEP_GENERATION_INSTRUCTION,
      shift: ACE_STEP_SHIFT,
      useAdg: ACE_STEP_USE_ADG,
    },
    status: 'ACE_STEP_BASE_QUALITY_PROFILE_VERIFIED',
    unloaded,
  };

  await writeFile(
    join(evidenceDirectory, 'base-quality-verification.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await client.terminate();
  restoreEnvironment(
    ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE,
    previousPythonPath,
  );
  restoreEnvironment(
    ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
    previousCheckpointsRoot,
  );
}

function createTestCases(fixture) {
  const common = {
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    providerId: ACE_STEP_PROVIDER_ID,
  };
  const lyricsArtifact = {
    artifactId: 'artifact-ace-step-quality-lyrics',
    kind: 'lyrics',
    path: fixture.lyricsPath,
  };
  const guideArtifact = {
    artifactId: 'artifact-ace-step-quality-guide',
    kind: 'audio',
    path: fixture.guidePath,
  };

  return [
    {
      job: {
        ...common,
        inputArtifacts: [lyricsArtifact],
        jobId: 'job-ace-step-quality-t2m',
        parameters: {
          audioFormat: 'wav',
          batchSize: 1,
          bpm: 120,
          caption: 'Warm melodic indie pop with clear drums and a memorable chorus',
          channels: 2,
          durationSeconds: 10,
          guidanceScale: ACE_STEP_GUIDANCE_SCALE,
          inferenceSteps: ACE_STEP_INFERENCE_STEPS,
          instrumental: false,
          keyscale: 'C major',
          sampleRate: 48_000,
          seed: 1_370_421,
          taskType: 'text2music',
          thinking: false,
          timesignature: '4/4',
          vocalLanguage: 'en',
        },
        taskId: ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
      },
      name: 'text-to-music',
    },
    {
      job: {
        ...common,
        inputArtifacts: [guideArtifact, lyricsArtifact],
        jobId: 'job-ace-step-quality-cover',
        parameters: {
          audioCoverStrength: 0.2,
          audioFormat: 'wav',
          batchSize: 1,
          caption: 'Dreamy chamber pop reinterpretation with restrained drums',
          channels: 2,
          coverNoiseStrength: 0,
          durationSeconds: 10,
          guidanceScale: ACE_STEP_GUIDANCE_SCALE,
          inferenceSteps: ACE_STEP_INFERENCE_STEPS,
          instrumental: false,
          sampleRate: 48_000,
          seed: 1_370_421,
          taskType: 'cover',
          thinking: false,
          vocalLanguage: 'en',
        },
        taskId: ACE_STEP_COVER_TASK_ID,
      },
      name: 'cover',
    },
    {
      job: {
        ...common,
        inputArtifacts: [guideArtifact, lyricsArtifact],
        jobId: 'job-ace-step-quality-lego',
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
        taskId: ACE_STEP_TASK_ID,
      },
      name: 'lego-vocals',
    },
  ];
}

function restoreEnvironment(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}
