import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectRootAuthority } from '../projectRootAuthority.mjs';
import {
  BASIC_PITCH_MODEL_ID,
  BASIC_PITCH_MODEL_REVISION,
  BASIC_PITCH_PROVIDER_ID,
  BASIC_PITCH_TASK_ID,
} from '../providers/basicPitchProviderDefinition.mjs';
import { GpuJobQueue } from './gpuJobQueue.mjs';
import {
  BasicPitchJobExecutor,
  BasicPitchJobExecutorError,
} from './basicPitchJobExecutor.mjs';

const runningQueues = new Set();
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.allSettled([...runningQueues].map((queue) => queue.shutdown()));
  runningQueues.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('BasicPitchJobExecutor', () => {
  it('normalizes one exact Recording Artifact and Clip Take request', async () => {
    const { executor } = await createReadyExecutor();
    const request = executor.validateRequest(createRequest());

    expect(request).toMatchObject({
      inputArtifacts: [
        {
          artifactId: 'artifact-recording-a',
          kind: 'audio',
          relativePath: 'recordings/artifact-recording-a.wav',
        },
      ],
      lineage: {
        parentArtifactIds: ['artifact-recording-a'],
        parentClipTakeIds: ['clip-take-recording-a'],
      },
      modelId: BASIC_PITCH_MODEL_ID,
      modelRevision: BASIC_PITCH_MODEL_REVISION,
      providerId: BASIC_PITCH_PROVIDER_ID,
      taskId: BASIC_PITCH_TASK_ID,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.parameters)).toBe(true);
    expect(Object.isFrozen(request.lineage.parentClipTakeIds)).toBe(true);
    expect(executor.canHandleRequest(createRequest())).toBe(true);
    expect(executor.canHandleRequest({ providerId: 'mock-provider' })).toBe(false);

    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        extra: true,
      }),
    ).toThrow('exactly the supported Job fields');
    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        lineage: {
          parentArtifactIds: ['artifact-recording-other'],
          parentClipTakeIds: ['clip-take-recording-a'],
        },
      }),
    ).toThrow('must match');
    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        inputArtifacts: [
          {
            artifactId: 'artifact-recording-a',
            kind: 'audio',
            relativePath: 'recordings/../outside.wav',
          },
        ],
      }),
    ).toThrow('Project recording WAV');
    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        parameters: { ...createRequest().parameters, multiplePitchBends: true },
      }),
    ).toThrow('multiplePitchBends must be false');
  });

  it('runs through Queue and returns only a validated inline MIDI Artifact', async () => {
    const workerClient = new SuccessfulWorkerClient();
    const { executor, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    const recordingPath = join(rootPath, 'recordings', 'artifact-recording-a.wav');
    await writeFile(recordingPath, createPcmWav());
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();
    const completed = queue.getJob(queued.jobId);

    expect(completed).toMatchObject({
      result: {
        artifact: {
          artifactId: `artifact-${queued.jobId}`,
          kind: 'midi',
          lineage: {
            parentArtifactIds: ['artifact-recording-a'],
            parentClipTakeIds: ['clip-take-recording-a'],
          },
          midi: {
            bpm: 120,
            notes: [
              {
                confidence: 0.91,
                id: 'note-basic-pitch-a',
                lengthTicks: 960,
                pitch: 69,
                startTick: 0,
                velocity: 110,
              },
            ],
            ticksPerQuarter: 960,
          },
          provenance: {
            modelId: BASIC_PITCH_MODEL_ID,
            modelRevision: BASIC_PITCH_MODEL_REVISION,
            providerId: BASIC_PITCH_PROVIDER_ID,
            taskId: BASIC_PITCH_TASK_ID,
          },
          sourceJobId: queued.jobId,
        },
        transcription: {
          noteCount: 1,
          providerCompletedAt: '2026-08-02T00:00:01.000Z',
        },
      },
      state: 'COMPLETED',
    });
    expect(completed.history.map((entry) => entry.state)).toEqual([
      'QUEUED',
      'LOADING_MODEL',
      'PROCESSING',
      'SAVING',
      'COMPLETED',
    ]);
    expect(workerClient.calls).toEqual([
      'start',
      `load:${BASIC_PITCH_MODEL_ID}@${BASIC_PITCH_MODEL_REVISION}`,
      'execute',
      'unload',
      'close',
    ]);
    expect(workerClient.executedJob).toMatchObject({
      inputArtifacts: [
        {
          artifactId: 'artifact-recording-a',
          kind: 'audio',
          path: await realpath(recordingPath),
        },
      ],
      output: { kind: 'midi' },
    });
    expect(workerClient.executedJob.inputArtifacts[0].relativePath).toBeUndefined();
  });

  it('fails with a stable boundary error when the Recording is unavailable', async () => {
    const workerClient = new SuccessfulWorkerClient();
    const { executor } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: {
        code: 'BASIC_PITCH_INPUT_UNAVAILABLE',
        message: 'Basic Pitch input recording is unavailable.',
      },
      state: 'FAILED',
    });
    expect(workerClient.calls).toEqual([]);
    expect(workerClient.terminateCalls).toBe(1);
  });

  it('rejects malformed Worker MIDI before the Queue can complete', async () => {
    const workerClient = new SuccessfulWorkerClient({
      artifact: {
        bpm: 120,
        kind: 'midi',
        notes: [
          {
            id: 'note-invalid',
            lengthTicks: 0,
            pitch: 69,
            startTick: 0,
            velocity: 110,
          },
        ],
        ticksPerQuarter: 960,
      },
    });
    const { executor, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeFile(
      join(rootPath, 'recordings', 'artifact-recording-a.wav'),
      createPcmWav(),
    );
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: {
        code: 'WORKER_RESPONSE_INVALID',
        message: 'Provider Worker returned an invalid MIDI note at index 0.',
      },
      state: 'FAILED',
    });
    expect(queue.getJob(queued.jobId)?.result).toBeUndefined();
    expect(workerClient.terminateCalls).toBe(1);
  });

  it('retries a failed Job with a fresh Worker and preserves its immutable request', async () => {
    const failingWorkerClient = new FailingWorkerClient();
    const recoveredWorkerClient = new SuccessfulWorkerClient();
    const workerClients = [failingWorkerClient, recoveredWorkerClient];
    const { executor, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClients.shift(),
    });
    await writeFile(
      join(rootPath, 'recordings', 'artifact-recording-a.wav'),
      createPcmWav(),
    );
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());
    const immutableRequest = queue.getJob(queued.jobId)?.request;

    await queue.waitForIdle();
    expect(queue.getJob(queued.jobId)).toMatchObject({
      attempt: 1,
      error: { code: 'BASIC_PITCH_RUNTIME_UNAVAILABLE' },
      state: 'FAILED',
    });

    queue.retry(queued.jobId);
    await queue.waitForIdle();
    const recovered = queue.getJob(queued.jobId);

    expect(recovered).toMatchObject({
      attempt: 2,
      result: {
        artifact: {
          lineage: immutableRequest.lineage,
          sourceJobId: queued.jobId,
        },
      },
      state: 'COMPLETED',
    });
    expect(recovered.request).toBe(immutableRequest);
    expect(recovered.history.map(({ attempt, state }) => ({ attempt, state }))).toEqual([
      { attempt: 1, state: 'QUEUED' },
      { attempt: 1, state: 'LOADING_MODEL' },
      { attempt: 1, state: 'PROCESSING' },
      { attempt: 1, state: 'FAILED' },
      { attempt: 2, state: 'QUEUED' },
      { attempt: 2, state: 'LOADING_MODEL' },
      { attempt: 2, state: 'PROCESSING' },
      { attempt: 2, state: 'SAVING' },
      { attempt: 2, state: 'COMPLETED' },
    ]);
    expect(failingWorkerClient.terminateCalls).toBe(1);
    expect(recoveredWorkerClient.terminateCalls).toBe(0);
  });

  it('hard-terminates the Worker when Queue cancellation is requested', async () => {
    const workerClient = new BlockingWorkerClient();
    const { executor, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeFile(
      join(rootPath, 'recordings', 'artifact-recording-a.wav'),
      createPcmWav(),
    );
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());
    await workerClient.waitUntilStarted();

    await queue.requestCancel(queued.jobId);
    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)?.state).toBe('CANCELED');
    expect(workerClient.terminateCalls).toBe(1);
  });

  it('rejects construction without explicit Project Root authority', () => {
    expect(
      () => new BasicPitchJobExecutor({ projectRootAuthority: undefined }),
    ).toThrow(TypeError);
    expect(
      () =>
        new BasicPitchJobExecutor({
          createWorkerClient: undefined,
          projectRootAuthority: { getSnapshot: () => ({ status: 'MISSING' }) },
        }),
    ).not.toThrow();
    expect(BasicPitchJobExecutorError.prototype).toBeInstanceOf(Error);
  });
});

class SuccessfulWorkerClient {
  calls = [];
  executedJob;
  resultOverride;
  terminateCalls = 0;

  constructor(resultOverride) {
    this.resultOverride = resultOverride;
  }

  async start() {
    this.calls.push('start');
  }

  async loadModel(modelId, modelRevision) {
    this.calls.push(`load:${modelId}@${modelRevision}`);
  }

  async execute(job) {
    this.calls.push('execute');
    this.executedJob = job;
    return {
      artifact: this.resultOverride?.artifact ?? {
        bpm: job.parameters.projectBpm,
        kind: 'midi',
        notes: [
          {
            confidence: 0.91,
            id: 'note-basic-pitch-a',
            lengthTicks: 960,
            pitch: 69,
            startTick: 0,
            velocity: 110,
          },
        ],
        ticksPerQuarter: job.parameters.ticksPerQuarter,
      },
      completedAt: '2026-08-02T00:00:01.000Z',
      jobId: job.jobId,
      metadata: {
        modelId: job.modelId,
        modelRevision: job.modelRevision,
        parameters: job.parameters,
        providerId: job.providerId,
        taskId: job.taskId,
      },
      status: 'COMPLETED',
    };
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

class BlockingWorkerClient extends SuccessfulWorkerClient {
  #execution;
  #rejectExecution;
  #resolveStarted;
  #started = new Promise((resolve) => {
    this.#resolveStarted = resolve;
  });

  async execute(job) {
    this.calls.push('execute');
    this.executedJob = job;
    this.#resolveStarted();
    this.#execution = new Promise((_resolve, reject) => {
      this.#rejectExecution = reject;
    });
    return this.#execution;
  }

  async terminate() {
    this.terminateCalls += 1;
    this.#rejectExecution?.(
      Object.assign(new Error('Basic Pitch Worker terminated.'), {
        code: 'WORKER_TERMINATED',
      }),
    );
    await this.#execution?.catch(() => undefined);
  }

  waitUntilStarted() {
    return this.#started;
  }
}

class FailingWorkerClient extends SuccessfulWorkerClient {
  async execute() {
    throw Object.assign(new Error('Basic Pitch runtime is unavailable.'), {
      code: 'BASIC_PITCH_RUNTIME_UNAVAILABLE',
    });
  }
}

async function createReadyExecutor({ createWorkerClient } = {}) {
  const selectedPath = await createTemporaryDirectory();
  const authority = new ProjectRootAuthority();
  const projectRoot = await authority.configure(selectedPath);
  const executor = new BasicPitchJobExecutor({
    ...(createWorkerClient ? { createWorkerClient } : {}),
    projectRootAuthority: authority,
  });
  return { executor, rootPath: projectRoot.rootPath };
}

function createRequest() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-recording-a',
        kind: 'audio',
        relativePath: 'recordings/artifact-recording-a.wav',
      },
    ],
    lineage: {
      parentArtifactIds: ['artifact-recording-a'],
      parentClipTakeIds: ['clip-take-recording-a'],
    },
    modelId: BASIC_PITCH_MODEL_ID,
    modelRevision: BASIC_PITCH_MODEL_REVISION,
    output: { artifactKind: 'midi' },
    parameters: {
      frameThreshold: 0.3,
      maximumFrequencyHz: 1_100,
      melodiaTrick: true,
      minimumFrequencyHz: 80,
      minimumNoteLengthMs: 127.7,
      multiplePitchBends: false,
      onsetThreshold: 0.5,
      projectBpm: 120,
      sourceEndSeconds: 2,
      sourceStartSeconds: 0,
      ticksPerQuarter: 960,
    },
    providerId: BASIC_PITCH_PROVIDER_ID,
    taskId: BASIC_PITCH_TASK_ID,
  };
}

function createPcmWav({ durationSeconds = 2, sampleRate = 8_000 } = {}) {
  const frameCount = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataByteLength = frameCount * 2;
  const wav = Buffer.alloc(44 + dataByteLength);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
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
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-basic-pitch-job-executor-'));
  temporaryDirectories.add(directory);
  return directory;
}
