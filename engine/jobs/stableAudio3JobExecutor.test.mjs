import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GeneratedArtifactFinalizer } from '../generatedArtifactFinalizer.mjs';
import { ProjectRootAuthority } from '../projectRootAuthority.mjs';
import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
  STABLE_AUDIO_3_TASK_ID,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../../shared/stableAudio3Protocol.js';
import { GpuJobQueue } from './gpuJobQueue.mjs';
import {
  StableAudio3JobExecutor,
  StableAudio3JobExecutorError,
} from './stableAudio3JobExecutor.mjs';

const runningQueues = new Set();
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.allSettled([...runningQueues].map((queue) => queue.shutdown()));
  runningQueues.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('StableAudio3JobExecutor', () => {
  it('validates one immutable allowlisted Audio-to-Audio request', async () => {
    const { executor } = await createReadyExecutor();
    const request = executor.validateRequest(createRequest());

    expect(request).toMatchObject({
      inputArtifacts: [
        {
          artifactId: 'artifact-source-a',
          kind: 'audio',
          relativePath: 'recordings/artifact-source-a.wav',
        },
      ],
      lineage: {
        parentArtifactIds: ['artifact-source-a'],
        parentClipTakeIds: ['clip-take-source-a'],
      },
      modelId: STABLE_AUDIO_3_MODEL_ID,
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      output: {
        artifactKind: 'audio',
        destination: 'stable-audio-3',
        extension: '.wav',
      },
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      taskId: STABLE_AUDIO_3_TASK_ID,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts)).toBe(true);
    expect(Object.isFrozen(request.parameters)).toBe(true);
    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        inputArtifacts: [
          {
            artifactId: 'artifact-source-a',
            kind: 'audio',
            relativePath: 'recordings/../outside.wav',
          },
        ],
      }),
    ).toThrow('allowlisted Project WAV');
    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        output: {
          artifactKind: 'audio',
          destination: 'instrument',
          extension: '.wav',
        },
      }),
    ).toThrow('stable-audio-3 Project destination');
  });

  it('validates one immutable source-free Text-to-Audio request', async () => {
    const { executor } = await createReadyExecutor();
    const request = executor.validateRequest(createTextToAudioRequest());

    expect(request).toMatchObject({
      inputArtifacts: [],
      lineage: {
        parentArtifactIds: [],
        parentClipTakeIds: [],
      },
      parameters: {
        durationSeconds: 0.1,
        prompt: 'Warm analog synths with a patient cinematic build',
        seed: 17,
      },
      taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts)).toBe(true);
    expect(Object.isFrozen(request.lineage.parentArtifactIds)).toBe(true);
    expect(() =>
      executor.validateRequest({
        ...createTextToAudioRequest(),
        inputArtifacts: createRequest().inputArtifacts,
      }),
    ).toThrow('requires no input Artifacts');
    expect(() =>
      executor.validateRequest({
        ...createTextToAudioRequest(),
        lineage: createRequest().lineage,
      }),
    ).toThrow('requires empty parent Artifact and Clip Take lineage');
    expect(() =>
      executor.validateRequest({
        ...createTextToAudioRequest(),
        parameters: {
          ...createTextToAudioRequest().parameters,
          strength: 0.5,
        },
      }),
    ).toThrow('must contain exactly');
  });

  it('finalizes one Project WAV with immutable generation evidence through Queue', async () => {
    const workerClient = new SuccessfulWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeInput(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();
    const completed = queue.getJob(queued.jobId);
    const files = await readdir(join(rootPath, 'renders', 'stable-audio-3'));

    expect(completed).toMatchObject({
      result: {
        artifact: {
          destination: 'stable-audio-3',
          kind: 'audio',
          lineage: {
            parentArtifactIds: ['artifact-source-a'],
            parentClipTakeIds: ['clip-take-source-a'],
          },
          provenance: {
            modelId: STABLE_AUDIO_3_MODEL_ID,
            modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
            providerId: STABLE_AUDIO_3_PROVIDER_ID,
            seed: 20_260_805,
            taskId: STABLE_AUDIO_3_TASK_ID,
          },
        },
        generation: {
          channels: 2,
          durationSeconds: 0.1,
          evidence: {
            cfgScale: 1,
            chunkedDecode: true,
            inferenceSteps: 8,
            modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
            runtimeProfileId: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
            sampleRate: 48_000,
          },
          mimeType: 'audio/wav',
          providerCompletedAt: '2026-08-05T02:10:01.000Z',
        },
      },
      state: 'COMPLETED',
    });
    expect(files).toEqual([completed.result.artifact.file.name]);
    expect(files[0]).not.toContain('.partial');

    const finalPath = join(
      rootPath,
      ...completed.result.artifact.file.relativePath.split('/'),
    );
    const finalBytes = await readFile(finalPath);
    const outputSha256 = createHash('sha256').update(finalBytes).digest('hex');
    const inputBytes = await readFile(
      join(rootPath, 'recordings', 'artifact-source-a.wav'),
    );
    const inputSha256 = createHash('sha256').update(inputBytes).digest('hex');

    expect(finalBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(finalBytes.readUInt16LE(22)).toBe(2);
    expect(completed.result.generation.bytesWritten).toBe(finalBytes.length);
    expect(completed.result.generation.evidence.inputArtifactId).toBe(
      'artifact-source-a',
    );
    expect(completed.result.generation.evidence.inputSha256).toBe(inputSha256);
    expect(completed.result.generation.evidence.inputSizeBytes).toBe(
      inputBytes.length,
    );
    expect(completed.result.generation.evidence.outputSha256).toBe(outputSha256);
    expect(Object.isFrozen(completed.result)).toBe(true);
    expect(Object.isFrozen(completed.result.generation.evidence)).toBe(true);
    expect(workerClient.calls).toEqual([
      'start',
      `load:${STABLE_AUDIO_3_MODEL_ID}@${STABLE_AUDIO_3_MODEL_REVISION}`,
      'execute',
      'unload',
      'close',
    ]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('finalizes Text-to-Audio without resolving or recording input evidence', async () => {
    const workerClient = new SuccessfulWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createTextToAudioRequest());

    await queue.waitForIdle();
    const completed = queue.getJob(queued.jobId);

    expect(completed).toMatchObject({
      result: {
        artifact: {
          lineage: {
            parentArtifactIds: [],
            parentClipTakeIds: [],
          },
          provenance: {
            taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
          },
        },
        generation: {
          evidence: {
            modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
            runtimeProfileId: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
          },
        },
      },
      state: 'COMPLETED',
    });
    expect(completed.result.generation.evidence.inputArtifactId).toBeUndefined();
    expect(completed.result.generation.evidence.inputSha256).toBeUndefined();
    expect(completed.result.generation.evidence.inputSizeBytes).toBeUndefined();
    expect(workerClient.executedJob).toMatchObject({
      inputArtifacts: [],
      taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
    });
    expect(
      workerClient.executedJob.parameters.sourceStartSeconds,
    ).toBeUndefined();
    expect(workerClient.executedJob.parameters.strength).toBeUndefined();
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(
      readdir(join(rootPath, 'renders', 'stable-audio-3')),
    ).resolves.toHaveLength(1);
  });

  it('fails before starting a Worker when the Project input is unavailable', async () => {
    const workerClient = new SuccessfulWorkerClient();
    const { executor } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: { code: 'STABLE_AUDIO_3_INPUT_UNAVAILABLE' },
      state: 'FAILED',
    });
    expect(workerClient.calls).toEqual([]);
    expect(workerClient.terminateCalls).toBe(1);
  });

  it('rejects invalid physical WAV output and discards all staging files', async () => {
    const workerClient = new InvalidWaveWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeInput(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: { code: 'STABLE_AUDIO_3_STAGING_WAV_INVALID' },
      state: 'FAILED',
    });
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(readdir(join(rootPath, 'renders', 'stable-audio-3'))).resolves.toEqual([]);
  });

  it('rejects generation when the authorized input changes during execution', async () => {
    const workerClient = new MutatingInputWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeInput(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: { code: 'STABLE_AUDIO_3_INPUT_CHANGED' },
      state: 'FAILED',
    });
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(readdir(join(rootPath, 'renders', 'stable-audio-3'))).resolves.toEqual([]);
  });

  it('hard-terminates the Worker and removes .partial.wav on Queue cancellation', async () => {
    const workerClient = new BlockingWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeInput(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());
    await workerClient.waitUntilStarted();

    await queue.requestCancel(queued.jobId);
    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)?.state).toBe('CANCELED');
    expect(workerClient.terminateCalls).toBe(1);
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(readdir(join(rootPath, 'renders', 'stable-audio-3'))).resolves.toEqual([]);
  });

  it('discards both reservation and internal partial output after Worker failure', async () => {
    const workerClient = new FailingWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeInput(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: { code: 'STABLE_AUDIO_3_INFERENCE_FAILED' },
      state: 'FAILED',
    });
    expect(workerClient.terminateCalls).toBe(1);
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(readdir(join(rootPath, 'renders', 'stable-audio-3'))).resolves.toEqual([]);
  });

  it('requires explicit Project Root and Artifact finalization authorities', () => {
    expect(
      () =>
        new StableAudio3JobExecutor({
          generatedArtifactFinalizer: undefined,
          projectRootAuthority: undefined,
        }),
    ).toThrow(TypeError);
    expect(StableAudio3JobExecutorError.prototype).toBeInstanceOf(Error);
  });
});

class SuccessfulWorkerClient {
  calls = [];
  executedJob;
  terminateCalls = 0;

  async start() {
    this.calls.push('start');
  }

  async loadModel(modelId, modelRevision) {
    this.calls.push(`load:${modelId}@${modelRevision}`);
  }

  async execute(job) {
    this.calls.push('execute');
    this.executedJob = job;
    const wav = createPcmWav({
      channels: 2,
      durationSeconds: job.parameters.durationSeconds,
      sampleRate: 44_100,
    });
    await writeFile(job.output.stagingPath, wav);
    return createProviderResult(job, wav.length);
  }

  async unloadModel() {
    this.calls.push('unload');
  }

  async close() {
    this.calls.push('close');
  }

  async terminate() {
    this.terminateCalls += 1;
  }
}

class InvalidWaveWorkerClient extends SuccessfulWorkerClient {
  async execute(job) {
    this.calls.push('execute');
    const invalidBytes = Buffer.alloc(128, 1);
    await writeFile(job.output.stagingPath, invalidBytes);
    return createProviderResult(job, invalidBytes.length);
  }
}

class MutatingInputWorkerClient extends SuccessfulWorkerClient {
  async execute(job) {
    const result = await super.execute(job);
    const changedInput = createPcmWav({
      channels: 1,
      durationSeconds: 1,
      sampleRate: 8_000,
    });
    changedInput[changedInput.length - 1] = 1;
    await writeFile(job.inputArtifacts[0].path, changedInput);
    return result;
  }
}

class FailingWorkerClient extends SuccessfulWorkerClient {
  async execute(job) {
    this.calls.push('execute');
    await writeFile(`${job.output.stagingPath}.wav`, 'incomplete', 'utf8');
    throw Object.assign(new Error('Stable Audio 3 inference failed.'), {
      code: 'STABLE_AUDIO_3_INFERENCE_FAILED',
    });
  }
}

class BlockingWorkerClient extends SuccessfulWorkerClient {
  #execution;
  #rejectExecution;
  #resolveStarted;
  #started = new Promise((resolve) => {
    this.#resolveStarted = resolve;
  });

  async execute(job) {
    this.calls.push('execute');
    await writeFile(`${job.output.stagingPath}.wav`, 'incomplete', 'utf8');
    this.#resolveStarted();
    this.#execution = new Promise((_resolve, reject) => {
      this.#rejectExecution = reject;
    });
    return this.#execution;
  }

  async terminate() {
    this.terminateCalls += 1;
    this.#rejectExecution?.(
      Object.assign(new Error('Stable Audio 3 Worker terminated.'), {
        code: 'WORKER_TERMINATED',
      }),
    );
    await this.#execution?.catch(() => undefined);
  }

  waitUntilStarted() {
    return this.#started;
  }
}

function createProviderResult(job, bytesWritten) {
  return {
    artifact: {
      bytesWritten,
      channels: 2,
      durationSeconds: job.parameters.durationSeconds,
      mimeType: 'audio/wav',
      stagingPath: job.output.stagingPath,
    },
    completedAt: '2026-08-05T02:10:01.000Z',
    jobId: job.jobId,
    metadata: {
      modelId: job.modelId,
      modelRevision: job.modelRevision,
      parameters: job.parameters,
      providerId: job.providerId,
      seed: job.parameters.seed,
      taskId: job.taskId,
    },
    status: 'COMPLETED',
  };
}

async function createReadyExecutor({ createWorkerClient } = {}) {
  const selectedPath = await createTemporaryDirectory();
  const authority = new ProjectRootAuthority();
  const projectRoot = await authority.configure(selectedPath);
  const finalizer = new GeneratedArtifactFinalizer({
    projectRootAuthority: authority,
  });
  const executor = new StableAudio3JobExecutor({
    ...(createWorkerClient ? { createWorkerClient } : {}),
    generatedArtifactFinalizer: finalizer,
    projectRootAuthority: authority,
  });
  return { executor, finalizer, rootPath: projectRoot.rootPath };
}

function createRequest() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-source-a',
        kind: 'audio',
        relativePath: 'recordings/artifact-source-a.wav',
      },
    ],
    lineage: {
      parentArtifactIds: ['artifact-source-a'],
      parentClipTakeIds: ['clip-take-source-a'],
    },
    modelId: STABLE_AUDIO_3_MODEL_ID,
    modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
    output: {
      artifactKind: 'audio',
      destination: 'stable-audio-3',
      extension: '.wav',
    },
    parameters: {
      channels: 2,
      durationSeconds: 0.1,
      prompt: 'Warm instrumental arrangement following the source melody',
      sampleRate: 44_100,
      seed: 20_260_805,
      sourceEndSeconds: 1,
      sourceStartSeconds: 0,
      strength: 0.5,
    },
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    taskId: STABLE_AUDIO_3_TASK_ID,
  };
}

function createTextToAudioRequest() {
  return {
    inputArtifacts: [],
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    modelId: STABLE_AUDIO_3_MODEL_ID,
    modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
    output: {
      artifactKind: 'audio',
      destination: 'stable-audio-3',
      extension: '.wav',
    },
    parameters: {
      channels: 2,
      durationSeconds: 0.1,
      prompt: 'Warm analog synths with a patient cinematic build',
      sampleRate: 44_100,
      seed: 17,
    },
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
  };
}

async function writeInput(rootPath) {
  await writeFile(
    join(rootPath, 'recordings', 'artifact-source-a.wav'),
    createPcmWav({ channels: 1, durationSeconds: 1, sampleRate: 8_000 }),
  );
}

function createPcmWav({ channels, durationSeconds, sampleRate }) {
  const frameCount = Math.max(1, Math.round(sampleRate * durationSeconds));
  const blockAlign = channels * 2;
  const dataByteLength = frameCount * blockAlign;
  const wav = Buffer.alloc(44 + dataByteLength);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * blockAlign, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataByteLength, 40);

  return wav;
}

function trackQueue(queue) {
  runningQueues.add(queue);
  return queue;
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-stable-audio-3-job-'));
  temporaryDirectories.add(directory);
  return directory;
}
