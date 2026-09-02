import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GeneratedArtifactFinalizer } from '../generatedArtifactFinalizer.mjs';
import { ProjectRootAuthority } from '../projectRootAuthority.mjs';
import {
  MOCK_HUM_TO_MIDI_MODEL_ID,
  MOCK_HUM_TO_MIDI_MODEL_REVISION,
  MOCK_HUM_TO_MIDI_TASK_ID,
  MOCK_INSTRUMENT_RENDER_MODEL_ID,
  MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
  MOCK_INSTRUMENT_RENDER_TASK_ID,
  MOCK_PROVIDER_ID,
  MOCK_PROVIDER_MODEL_ID,
  MOCK_PROVIDER_MODEL_REVISION,
  MOCK_PROVIDER_TASK_ID,
} from '../providers/mockProviderDefinition.mjs';
import { GpuJobQueue } from './gpuJobQueue.mjs';
import {
  MockProviderJobExecutor,
  MockProviderJobExecutorError,
} from './mockProviderJobExecutor.mjs';

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

describe('MockProviderJobExecutor', () => {
  it('validates explicit output purpose, typed parameters, and multi-parent lineage', async () => {
    const { executor } = await createReadyExecutor();
    const request = executor.validateRequest(createRequest());

    expect(request).toMatchObject({
      lineage: {
        parentArtifactIds: ['artifact-parent-a', 'artifact-parent-b'],
        parentClipTakeIds: ['take-parent-a', 'take-parent-b'],
      },
      output: { artifactKind: 'audio', destination: 'instrument', extension: '.wav' },
      providerId: MOCK_PROVIDER_ID,
      taskId: MOCK_PROVIDER_TASK_ID,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.lineage.parentArtifactIds)).toBe(true);
    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        output: { artifactKind: 'audio', destination: 'unknown', extension: '.wav' },
      }),
    ).toThrow(MockProviderJobExecutorError);
    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        lineage: {
          parentArtifactIds: ['artifact-a', 'artifact-a'],
          parentClipTakeIds: [],
        },
      }),
    ).toThrow('unique');
    expect(() =>
      executor.validateRequest({
        ...createHumToMidiRequest(),
        inputArtifacts: [
          {
            artifactId: 'artifact-recording-a',
            kind: 'audio',
            relativePath: 'recordings/../outside.wav',
          },
        ],
      }),
    ).toThrow('Project recording input');
    expect(() =>
      executor.validateRequest({
        ...createInstrumentRenderRequest(),
        lineage: {
          parentArtifactIds: ['artifact-midi-other'],
          parentClipTakeIds: ['clip-take-midi-a'],
        },
      }),
    ).toThrow('match Lineage');
  });

  it('runs the real Mock Worker through Queue and finalizes one Project Artifact', async () => {
    const { executor, finalizer, rootPath } = await createReadyExecutor();
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();
    const completed = queue.getJob(queued.jobId);
    const files = await readdir(join(rootPath, 'renders', 'instruments'));

    expect(completed).toMatchObject({
      result: {
        artifact: {
          destination: 'instrument',
          kind: 'audio',
          lineage: {
            parentArtifactIds: ['artifact-parent-a', 'artifact-parent-b'],
            parentClipTakeIds: ['take-parent-a', 'take-parent-b'],
          },
          provenance: {
            modelId: MOCK_PROVIDER_MODEL_ID,
            modelRevision: MOCK_PROVIDER_MODEL_REVISION,
            providerId: MOCK_PROVIDER_ID,
            seed: 7,
            taskId: MOCK_PROVIDER_TASK_ID,
          },
        },
        generation: { channels: 1, mimeType: 'audio/wav' },
      },
      state: 'COMPLETED',
    });
    expect(files).toEqual([completed.result.artifact.file.name]);
    expect(files[0]).not.toContain('.partial');
    const finalBytes = await readFile(
      join(rootPath, ...completed.result.artifact.file.relativePath.split('/')),
    );
    expect(finalBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(finalBytes.length).toBe(completed.result.generation.bytesWritten);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('runs Mock Hum-to-MIDI through Queue and returns one inline MIDI Artifact', async () => {
    const { executor, finalizer, rootPath } = await createReadyExecutor();
    await writeFile(
      join(rootPath, 'recordings', 'artifact-recording-a.wav'),
      createPcmWav(),
    );
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createHumToMidiRequest());

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
            ticksPerQuarter: 960,
          },
          provenance: {
            modelId: MOCK_HUM_TO_MIDI_MODEL_ID,
            modelRevision: MOCK_HUM_TO_MIDI_MODEL_REVISION,
            providerId: MOCK_PROVIDER_ID,
            taskId: MOCK_HUM_TO_MIDI_TASK_ID,
          },
          sourceJobId: queued.jobId,
        },
        transcription: {
          noteCount: 4,
        },
      },
      state: 'COMPLETED',
    });
    expect(completed.result.artifact.midi.notes).toHaveLength(4);
    expect(completed.result.artifact.midi.notes.map((note) => note.pitch)).toEqual([
      67, 69, 71, 74,
    ]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(readdir(join(rootPath, 'renders', 'instruments'))).resolves.toEqual([]);
  });

  it('renders an Active MIDI Take to one finalized Instrument Audio Artifact', async () => {
    const { executor, finalizer, rootPath } = await createReadyExecutor();
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createInstrumentRenderRequest());

    await queue.waitForIdle();
    const completed = queue.getJob(queued.jobId);
    const files = await readdir(join(rootPath, 'renders', 'instruments'));

    expect(completed).toMatchObject({
      result: {
        artifact: {
          destination: 'instrument',
          kind: 'audio',
          lineage: {
            parentArtifactIds: ['artifact-midi-a'],
            parentClipTakeIds: ['clip-take-midi-a'],
          },
          provenance: {
            modelId: MOCK_INSTRUMENT_RENDER_MODEL_ID,
            modelRevision: MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
            parameters: {
              gainDb: -3,
              preset: {
                bank: 0,
                program: 24,
              },
              providerVersion: '1',
            },
            providerId: MOCK_PROVIDER_ID,
            taskId: MOCK_INSTRUMENT_RENDER_TASK_ID,
          },
        },
        generation: {
          channels: 2,
          mimeType: 'audio/wav',
        },
      },
      state: 'COMPLETED',
    });
    expect(completed.result.artifact.provenance.seed).toBeUndefined();
    expect(files).toEqual([completed.result.artifact.file.name]);
    const finalBytes = await readFile(
      join(rootPath, ...completed.result.artifact.file.relativePath.split('/')),
    );
    expect(finalBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(finalBytes.readUInt16LE(22)).toBe(2);
    expect(finalBytes.length).toBe(completed.result.generation.bytesWritten);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('fails Mock Hum-to-MIDI with a stable error when its recording is unavailable', async () => {
    const { executor } = await createReadyExecutor();
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createHumToMidiRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: {
        code: 'MOCK_HUM_TO_MIDI_INPUT_UNAVAILABLE',
        message: 'Mock Hum-to-MIDI input recording is unavailable.',
      },
      state: 'FAILED',
    });
  });

  it('fails safely and discards staging when Worker execution throws', async () => {
    const failingClient = new FailingWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => failingClient,
    });
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: { code: 'MOCK_WORKER_FAILED', message: 'Mock Worker failed deliberately.' },
      state: 'FAILED',
    });
    expect(failingClient.terminateCalls).toBe(1);
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(readdir(join(rootPath, 'renders', 'instruments'))).resolves.toEqual([]);
  });

  it('rejects a successful Worker response when physical staging bytes do not match', async () => {
    const mismatchedClient = new MismatchedWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => mismatchedClient,
    });
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: { code: 'MOCK_STAGING_OUTPUT_MISMATCH' },
      state: 'FAILED',
    });
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(readdir(join(rootPath, 'renders', 'instruments'))).resolves.toEqual([]);
  });

  it('terminates Worker and discards partial bytes when an active Job is canceled', async () => {
    const blockingClient = new BlockingWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => blockingClient,
    });
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());
    await blockingClient.waitUntilStarted();

    await queue.requestCancel(queued.jobId);
    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)?.state).toBe('CANCELED');
    expect(blockingClient.terminateCalls).toBe(1);
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(readdir(join(rootPath, 'renders', 'instruments'))).resolves.toEqual([]);
  });

  it('interrupts active work and discards partial bytes during Queue shutdown', async () => {
    const blockingClient = new BlockingWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => blockingClient,
    });
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const active = queue.enqueue(createRequest());
    const waiting = queue.enqueue({
      ...createRequest(),
      lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    });
    await blockingClient.waitUntilStarted();

    await queue.shutdown();

    expect(queue.getJob(active.jobId)?.state).toBe('INTERRUPTED');
    expect(queue.getJob(waiting.jobId)?.state).toBe('PAUSED');
    expect(blockingClient.terminateCalls).toBe(1);
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(readdir(join(rootPath, 'renders', 'instruments'))).resolves.toEqual([]);
  });
});

class FailingWorkerClient {
  terminateCalls = 0;

  async start() {}

  async loadModel() {}

  async execute() {
    throw Object.assign(new Error('Mock Worker failed deliberately.'), {
      code: 'MOCK_WORKER_FAILED',
    });
  }

  async unloadModel() {}

  async close() {}

  async terminate() {
    this.terminateCalls += 1;
  }
}

class BlockingWorkerClient {
  #execution;
  #rejectExecution;
  #resolveStarted;
  #started = new Promise((resolve) => {
    this.#resolveStarted = resolve;
  });
  terminateCalls = 0;

  async start() {}

  async loadModel() {}

  async execute(job) {
    await writeFile(job.output.stagingPath, 'incomplete mock bytes', 'utf8');
    this.#resolveStarted();
    this.#execution = new Promise((_resolve, reject) => {
      this.#rejectExecution = reject;
    });
    return this.#execution;
  }

  async unloadModel() {}

  async close() {}

  async terminate() {
    this.terminateCalls += 1;
    this.#rejectExecution?.(
      Object.assign(new Error('Blocking Mock Worker terminated.'), {
        code: 'WORKER_TERMINATED',
      }),
    );
    await this.#execution?.catch(() => undefined);
  }

  waitUntilStarted() {
    return this.#started;
  }
}

class MismatchedWorkerClient {
  async start() {}

  async loadModel() {}

  async execute(job) {
    const bytes = Buffer.alloc(100, 1);
    await writeFile(job.output.stagingPath, bytes);
    return {
      artifact: {
        bytesWritten: bytes.length + 1,
        channels: 1,
        durationSeconds: 0.1,
        mimeType: 'audio/wav',
        stagingPath: job.output.stagingPath,
      },
      completedAt: '2026-07-23T00:00:00.000Z',
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

  async unloadModel() {}

  async close() {}

  async terminate() {}
}

async function createReadyExecutor({ createWorkerClient } = {}) {
  const selectedPath = await createTemporaryDirectory();
  const authority = new ProjectRootAuthority();
  const projectRoot = await authority.configure(selectedPath);
  const finalizer = new GeneratedArtifactFinalizer({ projectRootAuthority: authority });
  const executor = new MockProviderJobExecutor({
    ...(createWorkerClient ? { createWorkerClient } : {}),
    generatedArtifactFinalizer: finalizer,
    projectRootAuthority: authority,
  });
  return { executor, finalizer, rootPath: projectRoot.rootPath };
}

function createHumToMidiRequest() {
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
    modelId: MOCK_HUM_TO_MIDI_MODEL_ID,
    modelRevision: MOCK_HUM_TO_MIDI_MODEL_REVISION,
    output: { artifactKind: 'midi' },
    parameters: {
      projectBpm: 120,
      seed: 7,
      sourceEndSeconds: 2,
      sourceStartSeconds: 0,
      ticksPerQuarter: 960,
    },
    providerId: MOCK_PROVIDER_ID,
    taskId: MOCK_HUM_TO_MIDI_TASK_ID,
  };
}

function createInstrumentRenderRequest() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-midi-a',
        kind: 'midi',
        midi: {
          bpm: 120,
          notes: [
            {
              id: 'note-a',
              lengthTicks: 960,
              pitch: 60,
              startTick: 0,
              velocity: 100,
            },
            {
              id: 'note-b',
              lengthTicks: 480,
              pitch: 67,
              startTick: 960,
              velocity: 90,
            },
          ],
          ticksPerQuarter: 960,
        },
      },
    ],
    lineage: {
      parentArtifactIds: ['artifact-midi-a'],
      parentClipTakeIds: ['clip-take-midi-a'],
    },
    modelId: MOCK_INSTRUMENT_RENDER_MODEL_ID,
    modelRevision: MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
    output: {
      artifactKind: 'audio',
      destination: 'instrument',
      extension: '.wav',
    },
    parameters: {
      channels: 2,
      gainDb: -3,
      preset: {
        bank: 0,
        program: 24,
      },
      providerVersion: '1',
      sampleRate: 8_000,
    },
    providerId: MOCK_PROVIDER_ID,
    taskId: MOCK_INSTRUMENT_RENDER_TASK_ID,
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

function createRequest() {
  return {
    inputArtifacts: [],
    lineage: {
      parentArtifactIds: ['artifact-parent-a', 'artifact-parent-b'],
      parentClipTakeIds: ['take-parent-a', 'take-parent-b'],
    },
    modelId: MOCK_PROVIDER_MODEL_ID,
    modelRevision: MOCK_PROVIDER_MODEL_REVISION,
    output: { artifactKind: 'audio', destination: 'instrument', extension: '.wav' },
    parameters: {
      durationSeconds: 0.1,
      frequencyHz: 440,
      sampleRate: 8_000,
      seed: 7,
    },
    providerId: MOCK_PROVIDER_ID,
    taskId: MOCK_PROVIDER_TASK_ID,
  };
}

function trackQueue(queue) {
  runningQueues.add(queue);
  return queue;
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-mock-job-executor-'));
  temporaryDirectories.add(directory);
  return directory;
}
