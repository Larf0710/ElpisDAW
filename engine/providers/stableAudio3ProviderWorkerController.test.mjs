import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
  STABLE_AUDIO_3_TASK_ID,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../../shared/stableAudio3Protocol.js';
import {
  StableAudio3ProviderWorkerController,
  StableAudio3ProviderWorkerError,
} from './stableAudio3ProviderWorkerController.mjs';

const STAGING_PATH = join(tmpdir(), '.stable-audio-3-test.partial');
const OUTPUT_SHA256 = 'a'.repeat(64);

describe('StableAudio3ProviderWorkerController', () => {
  it('publishes the executable descriptor without starting Python', () => {
    const hostClient = new FakeHostClient();
    const controller = createController(hostClient);

    expect(controller.inspect()).toMatchObject({
      capabilities: [
        expect.objectContaining({
          supportsCancellation: true,
          taskId: STABLE_AUDIO_3_TASK_ID,
        }),
        expect.objectContaining({
          inputArtifactKinds: [],
          supportsCancellation: true,
          taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
        }),
      ],
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      runtime: {
        compatibility: 'COMPATIBLE',
        profile: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
        version: '0.1.0',
      },
    });
    expect(hostClient.calls).toEqual([]);
  });

  it('loads once and returns validated immutable audio metadata', async () => {
    const hostClient = new FakeHostClient();
    const controller = createController(hostClient);

    await expect(loadModel(controller)).resolves.toMatchObject({
      modelId: STABLE_AUDIO_3_MODEL_ID,
      revision: STABLE_AUDIO_3_MODEL_REVISION,
      status: 'LOADED',
    });
    await loadModel(controller);
    const result = await controller.execute(createJob());

    expect(result).toEqual({
      artifact: {
        bytesWritten: 1_411_244,
        channels: 2,
        durationSeconds: 8,
        mimeType: 'audio/wav',
        sampleRate: 44_100,
        sha256: OUTPUT_SHA256,
        stagingPath: STAGING_PATH,
      },
      completedAt: '2026-08-05T02:00:01.000Z',
      jobId: 'job-stable-audio-3-worker-a',
      metadata: {
        modelId: STABLE_AUDIO_3_MODEL_ID,
        modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
        parameters: createParameters(),
        providerId: STABLE_AUDIO_3_PROVIDER_ID,
        seed: 20_260_805,
        taskId: STABLE_AUDIO_3_TASK_ID,
      },
      status: 'COMPLETED',
    });
    expect(hostClient.calls.map((call) => call.operation)).toEqual([
      'start',
      'loadModel',
      'execute',
    ]);
    expect(hostClient.calls[2].job.output).toEqual({
      kind: 'audio',
      partialWavPath: `${STAGING_PATH}.wav`,
      stagingPath: STAGING_PATH,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifact)).toBe(true);
    expect(Object.isFrozen(result.metadata.parameters)).toBe(true);
  });

  it('requires the exact Model and a successful load before execution', async () => {
    const controller = createController(new FakeHostClient());

    await expect(controller.execute(createJob())).rejects.toMatchObject({
      code: 'MODEL_NOT_LOADED',
    });
    await expect(
      controller.loadModel({
        modelId: STABLE_AUDIO_3_MODEL_ID,
        revision: 'floating-main',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_INCOMPATIBLE' });
  });

  it('passes a validated source-free Text-to-Audio Job to Python', async () => {
    const hostClient = new FakeHostClient();
    const controller = createController(hostClient);
    await loadModel(controller);

    const result = await controller.execute(createTextToAudioJob());
    const hostJob = hostClient.calls.find(
      (call) => call.operation === 'execute',
    )?.job;

    expect(result).toMatchObject({
      metadata: {
        parameters: createTextToAudioParameters(),
        taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
      },
      status: 'COMPLETED',
    });
    expect(hostJob).toMatchObject({
      inputArtifacts: [],
      parameters: createTextToAudioParameters(),
      taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
    });
    expect(hostJob.output).toEqual({
      kind: 'audio',
      partialWavPath: `${STAGING_PATH}.wav`,
      stagingPath: STAGING_PATH,
    });
  });

  it('rejects invalid parameters before crossing the Python boundary', async () => {
    const hostClient = new FakeHostClient();
    const controller = createController(hostClient);
    await loadModel(controller);

    await expect(
      controller.execute({
        ...createJob(),
        parameters: { ...createParameters(), inferenceSteps: 8 },
      }),
    ).rejects.toMatchObject({ code: 'STABLE_AUDIO_3_PARAMETERS_INVALID' });
    expect(hostClient.calls.filter((call) => call.operation === 'execute')).toEqual([]);
  });

  it('rejects mismatched Python output metadata', async () => {
    const hostClient = new FakeHostClient({
      executeResult: createHostResult({ channels: 1 }),
    });
    const controller = createController(hostClient);
    await loadModel(controller);

    await expect(controller.execute(createJob())).rejects.toBeInstanceOf(
      StableAudio3ProviderWorkerError,
    );
    await expect(controller.execute(createJob())).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_HOST_RESPONSE_INVALID',
    });
  });

  it('unloads, shuts down, and hard-terminates the Python host explicitly', async () => {
    const lifecycleClient = new FakeHostClient();
    const lifecycleController = createController(lifecycleClient);
    await loadModel(lifecycleController);

    await expect(lifecycleController.unloadModel()).resolves.toMatchObject({
      modelId: STABLE_AUDIO_3_MODEL_ID,
      revision: STABLE_AUDIO_3_MODEL_REVISION,
      status: 'UNLOADED',
    });
    await expect(lifecycleController.shutdown()).resolves.toEqual({ status: 'SHUTDOWN' });

    const terminationClient = new FakeHostClient();
    const terminationController = createController(terminationClient);
    await loadModel(terminationController);
    await terminationController.terminate();

    expect(lifecycleClient.calls.map((call) => call.operation)).toEqual([
      'start',
      'loadModel',
      'unloadModel',
      'shutdown',
    ]);
    expect(terminationClient.calls.map((call) => call.operation)).toEqual([
      'start',
      'loadModel',
      'terminate',
    ]);
  });
});

class FakeHostClient {
  calls = [];
  executeResult;

  constructor({ executeResult = createHostResult() } = {}) {
    this.executeResult = executeResult;
  }

  async start() {
    this.calls.push({ operation: 'start' });
    return { status: 'READY' };
  }

  async loadModel(modelId, revision) {
    this.calls.push({ modelId, operation: 'loadModel', revision });
    return {
      loadedAt: '2026-08-05T02:00:00.000Z',
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
      modelId: STABLE_AUDIO_3_MODEL_ID,
      revision: STABLE_AUDIO_3_MODEL_REVISION,
      status: 'UNLOADED',
      unloadedAt: '2026-08-05T02:00:02.000Z',
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
  return new StableAudio3ProviderWorkerController({
    hostClient,
    now: () => '2026-08-05T02:00:01.000Z',
  });
}

function loadModel(controller) {
  return controller.loadModel({
    modelId: STABLE_AUDIO_3_MODEL_ID,
    revision: STABLE_AUDIO_3_MODEL_REVISION,
  });
}

function createJob() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-instrument-a',
        kind: 'audio',
        path: join(tmpdir(), 'artifact-instrument-a.wav'),
      },
    ],
    jobId: 'job-stable-audio-3-worker-a',
    modelId: STABLE_AUDIO_3_MODEL_ID,
    modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
    output: { kind: 'audio', stagingPath: STAGING_PATH },
    parameters: createParameters(),
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    taskId: STABLE_AUDIO_3_TASK_ID,
  };
}

function createParameters() {
  return {
    channels: 2,
    durationSeconds: 8,
    prompt: 'Warm instrumental arrangement following the source melody',
    sampleRate: 44_100,
    seed: 20_260_805,
    sourceEndSeconds: 8,
    sourceStartSeconds: 0,
    strength: 0.5,
  };
}

function createTextToAudioJob() {
  return {
    inputArtifacts: [],
    jobId: 'job-stable-audio-3-t2a-worker-a',
    modelId: STABLE_AUDIO_3_MODEL_ID,
    modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
    output: { kind: 'audio', stagingPath: STAGING_PATH },
    parameters: createTextToAudioParameters(),
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
  };
}

function createTextToAudioParameters() {
  return {
    channels: 2,
    durationSeconds: 8,
    prompt: 'Warm analog synths with a patient cinematic build',
    sampleRate: 44_100,
    seed: 17,
  };
}

function createHostResult(overrides = {}) {
  return {
    bytesWritten: 1_411_244,
    channels: 2,
    durationSeconds: 8,
    mimeType: 'audio/wav',
    sampleRate: 44_100,
    sha256: OUTPUT_SHA256,
    stagingPath: STAGING_PATH,
    ...overrides,
  };
}
