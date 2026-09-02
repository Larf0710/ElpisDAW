import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
} from './mockProviderDefinition.mjs';
import {
  ProviderWorkerClient,
  ProviderWorkerError,
  validateProviderExecutionResult,
} from './providerWorkerClient.mjs';

const runningClients = new Set();
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all([...runningClients].map((client) => client.terminate()));
  runningClients.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('ProviderWorkerClient', () => {
  it('runs the isolated Mock Provider through load, execute, finalize, unload, and shutdown', async () => {
    const { finalizer, rootPath } = await createReadyFinalizer();
    const reservation = await finalizer.reserve({ destination: 'instrument', extension: '.wav' });
    const client = await startClient();
    const provider = client.getProviderDescriptor();

    expect(provider).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({ taskId: MOCK_PROVIDER_TASK_ID }),
        expect.objectContaining({ taskId: MOCK_HUM_TO_MIDI_TASK_ID }),
        expect.objectContaining({ taskId: MOCK_INSTRUMENT_RENDER_TASK_ID }),
      ]),
      providerId: MOCK_PROVIDER_ID,
      runtime: { compatibility: 'COMPATIBLE', profile: 'mock-cpu' },
    });
    await expect(
      client.loadModel(MOCK_PROVIDER_MODEL_ID, MOCK_PROVIDER_MODEL_REVISION),
    ).resolves.toMatchObject({ status: 'LOADED' });

    const progress = [];
    const execution = await client.execute(createMockJob(reservation.stagingPath), {
      onProgress: (update) => progress.push(update),
    });
    const stagedBytes = await readFile(reservation.stagingPath);

    expect(execution).toMatchObject({
      artifact: {
        bytesWritten: stagedBytes.length,
        channels: 1,
        mimeType: 'audio/wav',
      },
      metadata: {
        modelId: MOCK_PROVIDER_MODEL_ID,
        modelRevision: MOCK_PROVIDER_MODEL_REVISION,
        providerId: MOCK_PROVIDER_ID,
        taskId: MOCK_PROVIDER_TASK_ID,
      },
      status: 'COMPLETED',
    });
    expect(stagedBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(stagedBytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(progress).toEqual([
      { accuracy: 'MEASURED', currentStep: 1, percent: 100, totalSteps: 1 },
    ]);
    expect(Object.isFrozen(progress[0])).toBe(true);

    const finalized = await finalizer.finalize(reservation.reservationId);
    const finalPath = join(rootPath, ...finalized.file.relativePath.split('/'));
    await expect(readFile(finalPath)).resolves.toEqual(stagedBytes);
    expect(finalized.file.sizeBytes).toBe(execution.artifact.bytesWritten);

    await expect(client.unloadModel()).resolves.toMatchObject({ status: 'UNLOADED' });
    await client.close();
    runningClients.delete(client);
    expect(client.isRunning()).toBe(false);
  });

  it('returns validated inline MIDI without creating a staging file', async () => {
    const inputDirectory = await createTemporaryDirectory();
    const inputPath = join(inputDirectory, 'recording.wav');
    await writeFile(inputPath, createPcmWav());
    const client = await startClient();

    await client.loadModel(
      MOCK_HUM_TO_MIDI_MODEL_ID,
      MOCK_HUM_TO_MIDI_MODEL_REVISION,
    );
    const execution = await client.execute(createHumToMidiJob(inputPath));

    expect(execution).toMatchObject({
      artifact: {
        bpm: 120,
        kind: 'midi',
        ticksPerQuarter: 960,
      },
      metadata: {
        modelId: MOCK_HUM_TO_MIDI_MODEL_ID,
        providerId: MOCK_PROVIDER_ID,
        taskId: MOCK_HUM_TO_MIDI_TASK_ID,
      },
      status: 'COMPLETED',
    });
    expect(execution.artifact.notes).toHaveLength(4);
    expect(Object.isFrozen(execution.artifact.notes)).toBe(true);
    await client.unloadModel();
  });

  it('renders validated inline MIDI to a staged stereo WAV', async () => {
    const { finalizer } = await createReadyFinalizer();
    const reservation = await finalizer.reserve({
      destination: 'instrument',
      extension: '.wav',
    });
    const client = await startClient();

    await client.loadModel(
      MOCK_INSTRUMENT_RENDER_MODEL_ID,
      MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
    );
    const execution = await client.execute(
      createInstrumentRenderJob(reservation.stagingPath),
    );
    const stagedBytes = await readFile(reservation.stagingPath);

    expect(execution).toMatchObject({
      artifact: {
        bytesWritten: stagedBytes.length,
        channels: 2,
        mimeType: 'audio/wav',
      },
      metadata: {
        modelId: MOCK_INSTRUMENT_RENDER_MODEL_ID,
        modelRevision: MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
        providerId: MOCK_PROVIDER_ID,
        taskId: MOCK_INSTRUMENT_RENDER_TASK_ID,
      },
      status: 'COMPLETED',
    });
    expect(execution.metadata.seed).toBeUndefined();
    expect(stagedBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(stagedBytes.readUInt16LE(22)).toBe(2);
    expect(stagedBytes.readUInt32LE(24)).toBe(8_000);
    await client.unloadModel();
    await finalizer.discard(reservation.reservationId);
  });

  it('preserves valid optional audio hash evidence and rejects malformed evidence', () => {
    const job = createMockJob(join(tmpdir(), 'provider-hash.partial'));
    const sha256 = 'a'.repeat(64);
    const result = {
      artifact: {
        bytesWritten: 48,
        channels: 1,
        durationSeconds: 0.1,
        mimeType: 'audio/wav',
        sha256,
        stagingPath: job.output.stagingPath,
      },
      completedAt: '2026-08-17T00:00:00.000Z',
      jobId: job.jobId,
      metadata: {
        modelId: job.modelId,
        modelRevision: job.modelRevision,
        providerId: job.providerId,
        seed: job.parameters.seed,
        taskId: job.taskId,
      },
      status: 'COMPLETED',
    };

    expect(validateProviderExecutionResult(result, job).artifact.sha256).toBe(
      sha256,
    );
    expect(() =>
      validateProviderExecutionResult(
        {
          ...result,
          artifact: { ...result.artifact, sha256: sha256.toUpperCase() },
        },
        job,
      ),
    ).toThrow('invalid audio result');
  });

  it('requires an explicit Model load and leaves failed staging output empty', async () => {
    const { finalizer } = await createReadyFinalizer();
    const reservation = await finalizer.reserve({ destination: 'export', extension: '.wav' });
    const client = await startClient();

    await expect(client.execute(createMockJob(reservation.stagingPath))).rejects.toMatchObject({
      code: 'MODEL_NOT_LOADED',
    });
    await expect(stat(reservation.stagingPath)).resolves.toMatchObject({ size: 0 });
    await expect(finalizer.finalize(reservation.reservationId)).rejects.toMatchObject({
      code: 'ARTIFACT_STAGING_EMPTY',
    });
    await finalizer.discard(reservation.reservationId);
  });

  it('does not fail completed execution when a progress observer throws', async () => {
    const { finalizer } = await createReadyFinalizer();
    const reservation = await finalizer.reserve({ destination: 'export', extension: '.wav' });
    const client = await startClient();
    await client.loadModel(MOCK_PROVIDER_MODEL_ID, MOCK_PROVIDER_MODEL_REVISION);

    await expect(
      client.execute(createMockJob(reservation.stagingPath), {
        onProgress: () => {
          throw new Error('Observer failed.');
        },
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED' });

    await client.unloadModel();
    await finalizer.discard(reservation.reservationId);
  });

  it('reports task-specific validation errors without corrupting the Worker or staging file', async () => {
    const { finalizer } = await createReadyFinalizer();
    const reservation = await finalizer.reserve({ destination: 'mixdown', extension: '.wav' });
    const client = await startClient();
    await client.loadModel(MOCK_PROVIDER_MODEL_ID, MOCK_PROVIDER_MODEL_REVISION);
    const invalidJob = {
      ...createMockJob(reservation.stagingPath),
      parameters: {
        durationSeconds: 0.1,
        frequencyHz: 440,
        sampleRate: 8_000,
        seed: -1,
      },
    };

    await expect(client.execute(invalidJob)).rejects.toMatchObject({
      code: 'MOCK_JOB_PARAMETERS_INVALID',
    });
    await expect(stat(reservation.stagingPath)).resolves.toMatchObject({ size: 0 });
    await expect(client.unloadModel()).resolves.toMatchObject({ status: 'UNLOADED' });
    await finalizer.discard(reservation.reservationId);
  });

  it('rejects unsupported Jobs before sending them to the Worker', async () => {
    const client = await startClient();
    const unsupportedJob = {
      ...createMockJob(join(tmpdir(), 'unsupported.partial')),
      taskId: 'vocal-generation',
    };

    await expect(client.execute(unsupportedJob)).rejects.toBeInstanceOf(ProviderWorkerError);
    await expect(client.execute(unsupportedJob)).rejects.toMatchObject({ code: 'JOB_UNSUPPORTED' });
  });

  it('can terminate the isolated Worker and rejects operations before startup', async () => {
    const client = new ProviderWorkerClient();

    await expect(client.loadModel(MOCK_PROVIDER_MODEL_ID, MOCK_PROVIDER_MODEL_REVISION)).rejects.toMatchObject({
      code: 'WORKER_NOT_STARTED',
    });
    await client.start();
    runningClients.add(client);
    expect(client.isRunning()).toBe(true);
    await client.terminate();
    runningClients.delete(client);
    expect(client.isRunning()).toBe(false);
    await expect(client.close()).resolves.toBeUndefined();
  });
});

function createMockJob(stagingPath) {
  return {
    inputArtifacts: [],
    jobId: 'job-mock-a',
    modelId: MOCK_PROVIDER_MODEL_ID,
    modelRevision: MOCK_PROVIDER_MODEL_REVISION,
    output: { kind: 'audio', stagingPath },
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

function createHumToMidiJob(inputPath) {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-recording-a',
        kind: 'audio',
        path: inputPath,
      },
    ],
    jobId: 'job-mock-midi-a',
    modelId: MOCK_HUM_TO_MIDI_MODEL_ID,
    modelRevision: MOCK_HUM_TO_MIDI_MODEL_REVISION,
    output: { kind: 'midi' },
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

function createInstrumentRenderJob(stagingPath) {
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
    jobId: 'job-mock-instrument-a',
    modelId: MOCK_INSTRUMENT_RENDER_MODEL_ID,
    modelRevision: MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
    output: { kind: 'audio', stagingPath },
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

async function createReadyFinalizer() {
  const selectedPath = await createTemporaryDirectory();
  const authority = new ProjectRootAuthority();
  const projectRoot = await authority.configure(selectedPath);
  return {
    finalizer: new GeneratedArtifactFinalizer({ projectRootAuthority: authority }),
    rootPath: projectRoot.rootPath,
  };
}

async function startClient() {
  const client = new ProviderWorkerClient();
  runningClients.add(client);
  await client.start();
  return client;
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-provider-worker-'));
  temporaryDirectories.add(directory);
  return directory;
}
