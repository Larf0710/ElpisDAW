import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BASIC_PITCH_MODEL_ID,
  BASIC_PITCH_MODEL_REVISION,
  BASIC_PITCH_PROVIDER_ID,
  BASIC_PITCH_TASK_ID,
  BASIC_PITCH_TICKS_PER_QUARTER,
} from './basicPitchProviderDefinition.mjs';
import {
  BasicPitchProviderWorkerController,
  BasicPitchProviderWorkerError,
} from './basicPitchProviderWorkerController.mjs';

describe('BasicPitchProviderWorkerController', () => {
  it('publishes the Basic Pitch descriptor without starting Python', () => {
    const hostClient = new FakeHostClient();
    const controller = createController(hostClient);

    expect(controller.inspect()).toMatchObject({
      models: [
        expect.objectContaining({
          compatibility: 'PARTIAL_SUPPORT',
          modelId: BASIC_PITCH_MODEL_ID,
          revision: BASIC_PITCH_MODEL_REVISION,
        }),
      ],
      providerId: BASIC_PITCH_PROVIDER_ID,
    });
    expect(hostClient.calls).toEqual([]);
  });

  it('loads once and returns validated deterministic inline MIDI', async () => {
    const hostClient = new FakeHostClient();
    const controller = createController(hostClient);

    await expect(
      controller.loadModel({
        modelId: BASIC_PITCH_MODEL_ID,
        revision: BASIC_PITCH_MODEL_REVISION,
      }),
    ).resolves.toMatchObject({
      modelId: BASIC_PITCH_MODEL_ID,
      revision: BASIC_PITCH_MODEL_REVISION,
      status: 'LOADED',
    });
    await controller.loadModel({
      modelId: BASIC_PITCH_MODEL_ID,
      revision: BASIC_PITCH_MODEL_REVISION,
    });

    const result = await controller.execute(createJob());

    expect(result).toEqual({
      artifact: {
        bpm: 120,
        kind: 'midi',
        notes: [
          {
            confidence: 0.875,
            id: 'note-0001',
            lengthTicks: 5_680,
            pitch: 69,
            startTick: 22,
            velocity: 111,
          },
        ],
        ticksPerQuarter: BASIC_PITCH_TICKS_PER_QUARTER,
      },
      completedAt: '2026-08-02T04:00:01.000Z',
      jobId: 'job-basic-pitch-worker-a',
      metadata: {
        modelId: BASIC_PITCH_MODEL_ID,
        modelRevision: BASIC_PITCH_MODEL_REVISION,
        parameters: createParameters(),
        providerId: BASIC_PITCH_PROVIDER_ID,
        taskId: BASIC_PITCH_TASK_ID,
      },
      status: 'COMPLETED',
    });
    expect(hostClient.calls.map((call) => call.operation)).toEqual([
      'start',
      'loadModel',
      'execute',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifact.notes)).toBe(true);
    expect(Object.isFrozen(result.artifact.notes[0])).toBe(true);
  });

  it('requires the exact Model and a successful load before execution', async () => {
    const controller = createController(new FakeHostClient());

    await expect(controller.execute(createJob())).rejects.toMatchObject({
      code: 'MODEL_NOT_LOADED',
    });
    await expect(
      controller.loadModel({
        modelId: 'unexpected-model',
        revision: BASIC_PITCH_MODEL_REVISION,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_INCOMPATIBLE' });
  });

  it('rejects invalid Task parameters before crossing the Python boundary', async () => {
    const hostClient = new FakeHostClient();
    const controller = createController(hostClient);
    await loadModel(controller);

    await expect(
      controller.execute({
        ...createJob(),
        parameters: { ...createParameters(), seed: 7 },
      }),
    ).rejects.toMatchObject({ code: 'BASIC_PITCH_PARAMETERS_INVALID' });
    expect(hostClient.calls.filter((call) => call.operation === 'execute')).toEqual([]);
  });

  it('rejects malformed or non-deterministic Python MIDI output', async () => {
    const invalidHostClient = new FakeHostClient({
      executeResult: {
        notes: [{ ...createNote(), pitch: 128 }],
      },
    });
    const invalidController = createController(invalidHostClient);
    await loadModel(invalidController);

    await expect(invalidController.execute(createJob())).rejects.toBeInstanceOf(
      BasicPitchProviderWorkerError,
    );
    await expect(invalidController.execute(createJob())).rejects.toMatchObject({
      code: 'BASIC_PITCH_HOST_RESPONSE_INVALID',
    });

    const unorderedHostClient = new FakeHostClient({
      executeResult: {
        notes: [
          { ...createNote(), id: 'note-b', startTick: 100 },
          { ...createNote(), id: 'note-a', startTick: 0 },
        ],
      },
    });
    const unorderedController = createController(unorderedHostClient);
    await loadModel(unorderedController);

    await expect(unorderedController.execute(createJob())).rejects.toThrow(
      'deterministic order',
    );
  });

  it('unloads and shuts down the Python host explicitly', async () => {
    const hostClient = new FakeHostClient();
    const controller = createController(hostClient);
    await loadModel(controller);

    await expect(controller.unloadModel()).resolves.toMatchObject({
      modelId: BASIC_PITCH_MODEL_ID,
      revision: BASIC_PITCH_MODEL_REVISION,
      status: 'UNLOADED',
    });
    await expect(controller.shutdown()).resolves.toEqual({ status: 'SHUTDOWN' });
    expect(hostClient.calls.map((call) => call.operation)).toEqual([
      'start',
      'loadModel',
      'unloadModel',
      'shutdown',
    ]);
  });
});

class FakeHostClient {
  calls = [];
  executeResult;

  constructor({ executeResult = { notes: [createNote()] } } = {}) {
    this.executeResult = executeResult;
  }

  async start() {
    this.calls.push({ operation: 'start' });
    return { status: 'READY' };
  }

  async loadModel(modelId, revision) {
    this.calls.push({ modelId, operation: 'loadModel', revision });
    return {
      loadedAt: '2026-08-02T04:00:00.000Z',
      modelId,
      revision,
      status: 'LOADED',
    };
  }

  async execute(job) {
    this.calls.push({ job, operation: 'execute' });
    return this.executeResult;
  }

  async unloadModel() {
    this.calls.push({ operation: 'unloadModel' });
    return {
      modelId: BASIC_PITCH_MODEL_ID,
      revision: BASIC_PITCH_MODEL_REVISION,
      status: 'UNLOADED',
      unloadedAt: '2026-08-02T04:00:02.000Z',
    };
  }

  async shutdown() {
    this.calls.push({ operation: 'shutdown' });
    return { status: 'SHUTDOWN' };
  }

  async terminate() {
    this.calls.push({ operation: 'terminate' });
  }
}

function createController(hostClient) {
  return new BasicPitchProviderWorkerController({
    hostClient,
    now: () => '2026-08-02T04:00:01.000Z',
  });
}

function loadModel(controller) {
  return controller.loadModel({
    modelId: BASIC_PITCH_MODEL_ID,
    revision: BASIC_PITCH_MODEL_REVISION,
  });
}

function createJob() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-recording-a',
        kind: 'audio',
        path: join(tmpdir(), 'artifact-recording-a.wav'),
      },
    ],
    jobId: 'job-basic-pitch-worker-a',
    modelId: BASIC_PITCH_MODEL_ID,
    modelRevision: BASIC_PITCH_MODEL_REVISION,
    output: { kind: 'midi' },
    parameters: createParameters(),
    providerId: BASIC_PITCH_PROVIDER_ID,
    taskId: BASIC_PITCH_TASK_ID,
  };
}

function createParameters() {
  return {
    frameThreshold: 0.3,
    maximumFrequencyHz: 1_100,
    melodiaTrick: true,
    minimumFrequencyHz: 80,
    minimumNoteLengthMs: 127.7,
    multiplePitchBends: false,
    onsetThreshold: 0.5,
    projectBpm: 120,
    sourceEndSeconds: 3,
    sourceStartSeconds: 0,
    ticksPerQuarter: BASIC_PITCH_TICKS_PER_QUARTER,
  };
}

function createNote() {
  return {
    confidence: 0.875,
    id: 'note-0001',
    lengthTicks: 5_680,
    pitch: 69,
    startTick: 22,
    velocity: 111,
  };
}
