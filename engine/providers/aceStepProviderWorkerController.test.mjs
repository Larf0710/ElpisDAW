import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACE_STEP_MODEL_ID,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_TASK_ID,
} from './aceStepProviderDefinition.mjs';
import {
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_RUNTIME_PROFILE_ID,
} from './aceStepRuntimeProfile.mjs';
import {
  AceStepProviderWorkerController,
  AceStepProviderWorkerError,
} from './aceStepProviderWorkerController.mjs';

const STAGING_PATH = join(tmpdir(), 'ace-step-worker-output.wav.partial');
const OUTPUT_SHA256 = 'a'.repeat(64);

describe('AceStepProviderWorkerController', () => {
  it('publishes the compatible executable descriptor without starting Python', () => {
    const hostClient = new FakeHostClient();
    const controller = createController(hostClient);

    expect(controller.inspect()).toMatchObject({
      models: [{ compatibility: 'COMPATIBLE', modelId: ACE_STEP_MODEL_ID }],
      providerId: ACE_STEP_PROVIDER_ID,
      runtime: {
        compatibility: 'COMPATIBLE',
        profile: ACE_STEP_RUNTIME_PROFILE_ID,
      },
    });
    expect(hostClient.calls).toEqual([]);
  });

  it('loads once and returns validated immutable staged output metadata', async () => {
    const hostClient = new FakeHostClient();
    const controller = createController(hostClient);

    await loadModel(controller);
    await loadModel(controller);
    const result = await controller.execute(createJob());

    expect(result).toEqual({
      artifact: {
        bytesWritten: 3_840_088,
        channels: 2,
        durationSeconds: 10,
        mimeType: 'audio/wav',
        sampleRate: 48_000,
        sha256: OUTPUT_SHA256,
        stagingPath: STAGING_PATH,
      },
      completedAt: '2026-08-12T12:00:01.000Z',
      jobId: 'job-ace-step-worker-a',
      metadata: {
        modelId: ACE_STEP_MODEL_ID,
        modelRevision: ACE_STEP_MODEL_REVISION,
        parameters: createParameters(),
        providerId: ACE_STEP_PROVIDER_ID,
        seed: 1_370_421,
        taskId: ACE_STEP_TASK_ID,
      },
      status: 'COMPLETED',
    });
    expect(hostClient.calls.map(({ operation }) => operation)).toEqual([
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
  });

  it('requires exact Model load before execution', async () => {
    const controller = createController(new FakeHostClient());

    await expect(controller.execute(createJob())).rejects.toMatchObject({
      code: 'MODEL_NOT_LOADED',
    });
    await expect(
      controller.loadModel({ modelId: ACE_STEP_MODEL_ID, revision: 'floating-main' }),
    ).rejects.toMatchObject({ code: 'MODEL_INCOMPATIBLE' });
  });

  it('rejects invalid Jobs before crossing the Python boundary', async () => {
    const hostClient = new FakeHostClient();
    const controller = createController(hostClient);
    await loadModel(controller);

    await expect(
      controller.execute({
        ...createJob(),
        parameters: { ...createParameters(), thinking: true },
      }),
    ).rejects.toMatchObject({ code: 'ACE_STEP_PARAMETERS_INVALID' });
    expect(hostClient.calls.filter(({ operation }) => operation === 'execute')).toEqual([]);
  });

  it('rejects mismatched Python output metadata', async () => {
    const controller = createController(
      new FakeHostClient({ executeResult: createHostResult({ channels: 1 }) }),
    );
    await loadModel(controller);

    await expect(controller.execute(createJob())).rejects.toBeInstanceOf(
      AceStepProviderWorkerError,
    );
    await expect(controller.execute(createJob())).rejects.toMatchObject({
      code: 'ACE_STEP_HOST_RESPONSE_INVALID',
    });
  });

  it('unloads, shuts down, and hard-terminates the Python host explicitly', async () => {
    const lifecycleClient = new FakeHostClient();
    const lifecycleController = createController(lifecycleClient);
    await loadModel(lifecycleController);
    await lifecycleController.unloadModel();
    await lifecycleController.shutdown();

    const terminationClient = new FakeHostClient();
    const terminationController = createController(terminationClient);
    await loadModel(terminationController);
    await terminationController.terminate();
    await expect(terminationController.execute(createJob())).rejects.toMatchObject({
      code: 'MODEL_NOT_LOADED',
    });

    expect(lifecycleClient.calls.map(({ operation }) => operation)).toEqual([
      'start',
      'loadModel',
      'unloadModel',
      'shutdown',
    ]);
    expect(terminationClient.calls.map(({ operation }) => operation)).toEqual([
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
      loadedAt: '2026-08-12T12:00:00.000Z',
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
      modelId: ACE_STEP_MODEL_ID,
      revision: ACE_STEP_MODEL_REVISION,
      status: 'UNLOADED',
      unloadedAt: '2026-08-12T12:00:02.000Z',
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
  return new AceStepProviderWorkerController({
    hostClient,
    now: () => '2026-08-12T12:00:01.000Z',
  });
}

function loadModel(controller) {
  return controller.loadModel({
    modelId: ACE_STEP_MODEL_ID,
    revision: ACE_STEP_MODEL_REVISION,
  });
}

function createJob() {
  return {
    inputArtifacts: [
      { artifactId: 'artifact-guide-a', kind: 'audio', path: join(tmpdir(), 'guide.wav') },
      { artifactId: 'artifact-lyrics-a', kind: 'lyrics', path: join(tmpdir(), 'lyrics.txt') },
    ],
    jobId: 'job-ace-step-worker-a',
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    output: { kind: 'audio', stagingPath: STAGING_PATH },
    parameters: createParameters(),
    providerId: ACE_STEP_PROVIDER_ID,
    taskId: ACE_STEP_TASK_ID,
  };
}

function createParameters() {
  return {
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
  };
}

function createHostResult(overrides = {}) {
  return {
    bytesWritten: 3_840_088,
    channels: 2,
    durationSeconds: 10,
    mimeType: 'audio/wav',
    sampleRate: 48_000,
    sha256: OUTPUT_SHA256,
    stagingPath: STAGING_PATH,
    ...overrides,
  };
}
