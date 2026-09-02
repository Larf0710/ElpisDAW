import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BasicPitchJobExecutor } from '../engine/jobs/basicPitchJobExecutor.mjs';
import { ProjectRootAuthority } from '../engine/projectRootAuthority.mjs';
import { startLocalEngineServer } from '../engine/server.mjs';
import { LocalEngineClient } from './localEngineClient.ts';
import { resolveActiveMidiTake } from './activeMidiTake.ts';
import { createInstrumentRenderJobRequest } from './instrumentRenderContract.ts';
import { createInstrumentRenderRegistration } from './instrumentRenderRegistration.ts';
import { verifyGeneratedAudioArtifactsForCommit } from './generatedAudioCommitAvailability.ts';
import {
  createCompletedAudioJobRegistration,
  createMidiArtifactRegistration,
} from './projectArtifactRegistration.ts';
import { createRecordingArtifactRegistration } from './recordingArtifactRegistration.ts';
import { sampleProject } from './sampleProject.ts';

const launchToken = 'registration-integration-token-at-least-32-characters';
const runningEngines = new Set();
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all([...runningEngines].map((engine) => engine.close()));
  runningEngines.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('Completed Job Artifact registration integration', () => {
  it('registers the real Mock Provider output only after Engine completion', async () => {
    const projectRoot = await createTemporaryDirectory();
    const engine = await startLocalEngineServer({
      port: 0,
      projectRootAuthority: new ProjectRootAuthority(),
      selectProjectRoot: async () => projectRoot,
      token: launchToken,
    });
    runningEngines.add(engine);
    const client = new LocalEngineClient({
      baseUrl: engine.baseUrl,
      token: launchToken,
    });

    await expect(client.selectProjectRoot()).resolves.toMatchObject({
      ok: true,
      selection: 'SELECTED',
    });
    const enqueue = await client.enqueueMockJob(createMockJobRequest());

    expect(enqueue).toMatchObject({ job: { state: 'QUEUED' }, ok: true });

    if (!enqueue.ok) {
      throw new Error(enqueue.message);
    }

    const completedJob = await waitForCompletedJob(client, enqueue.job.jobId);
    const project = cloneSampleProject();
    const provisionalRegistration = createCompletedAudioJobRegistration(
      project,
      completedJob,
      { clipId: 'clip-inst-1', label: 'Mock Provider Take' },
    );

    if (!provisionalRegistration.canRegister) {
      throw new Error(provisionalRegistration.message);
    }

    const availability = await verifyGeneratedAudioArtifactsForCommit(
      client,
      [provisionalRegistration.artifact],
    );

    expect(availability).toMatchObject({ ok: true });

    if (!availability.ok) {
      throw new Error(availability.message);
    }

    const registration = createCompletedAudioJobRegistration(
      project,
      completedJob,
      {
        clipId: 'clip-inst-1',
        label: 'Mock Provider Take',
        sourceAvailability: availability.evidence,
      },
    );

    expect(registration).toMatchObject({
      canRegister: true,
      clipTake: { label: 'Mock Provider Take', sourceJobId: completedJob.jobId },
      status: 'REGISTERED',
    });

    if (!registration.canRegister) {
      throw new Error(registration.message);
    }

    expect(findProjectClip(registration.project, 'clip-inst-1').sourceFile).toMatchObject({
      sourceId: provisionalRegistration.artifact.artifactId,
      status: 'available',
    });

    await expect(
      access(
        join(
          projectRoot,
          ...registration.artifact.file.relativePath.split('/'),
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('fails commit availability after finalized Mock output deletion or size drift', async () => {
    const projectRoot = await createTemporaryDirectory();
    const engine = await startLocalEngineServer({
      port: 0,
      projectRootAuthority: new ProjectRootAuthority(),
      selectProjectRoot: async () => projectRoot,
      token: launchToken,
    });
    runningEngines.add(engine);
    const client = new LocalEngineClient({
      baseUrl: engine.baseUrl,
      token: launchToken,
    });

    await client.selectProjectRoot();
    const enqueue = await client.enqueueMockJob(createMockJobRequest());

    if (!enqueue.ok) {
      throw new Error(enqueue.message);
    }

    const completedJob = await waitForCompletedJob(client, enqueue.job.jobId);
    const project = cloneSampleProject();
    const registration = createCompletedAudioJobRegistration(
      project,
      completedJob,
      { clipId: 'clip-inst-1' },
    );

    if (!registration.canRegister) {
      throw new Error(registration.message);
    }

    const outputPath = join(
      projectRoot,
      ...registration.artifact.file.relativePath.split('/'),
    );
    await rm(outputPath);

    await expect(
      verifyGeneratedAudioArtifactsForCommit(client, [registration.artifact]),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'artifact-unavailable',
    });

    await writeFile(
      outputPath,
      Buffer.alloc(registration.artifact.file.sizeBytes + 1),
    );

    await expect(
      verifyGeneratedAudioArtifactsForCommit(client, [registration.artifact]),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'artifact-unavailable',
    });
    expect(project.artifacts).toBeUndefined();
    expect(findProjectClip(project, 'clip-inst-1').clipTakes).toBeUndefined();
  });
});

describe('Recording Artifact registration integration', () => {
  it('persists an uploaded WAV and registers it as one active Recording Take', async () => {
    const projectRoot = await createTemporaryDirectory();
    const engine = await startLocalEngineServer({
      port: 0,
      projectRootAuthority: new ProjectRootAuthority(),
      selectProjectRoot: async () => projectRoot,
      token: launchToken,
    });
    runningEngines.add(engine);
    const client = new LocalEngineClient({
      baseUrl: engine.baseUrl,
      token: launchToken,
    });

    await expect(client.selectProjectRoot()).resolves.toMatchObject({
      ok: true,
      selection: 'SELECTED',
    });
    const save = await client.saveRecordingWav(createPcmWavBlob());

    expect(save).toMatchObject({
      ok: true,
      recording: {
        destination: 'recording',
        file: { relativePath: expect.stringMatching(/^recordings\//) },
      },
    });

    if (!save.ok) {
      throw new Error(save.message);
    }

    const registration = createRecordingArtifactRegistration(
      cloneSampleProject(),
      save.recording,
      {
        inputDeviceLabel: 'Integration Test Microphone',
        startTick: 1_920,
      },
    );

    expect(registration).toMatchObject({
      canRegister: true,
      clip: {
        sourceFile: {
          relativePath: save.recording.file.relativePath,
          sourceId: save.recording.artifactId,
          status: 'available',
        },
      },
      clipTake: {
        artifactId: save.recording.artifactId,
        sourceType: 'recording',
      },
      status: 'REGISTERED',
    });

    if (!registration.canRegister) {
      throw new Error(registration.message);
    }

    await expect(
      access(
        join(
          projectRoot,
          ...registration.artifact.file.relativePath.split('/'),
        ),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('Hum-to-MIDI Artifact registration integration', () => {
  it('converts one saved Recording Take through Engine and registers one MIDI Take', async () => {
    const projectRoot = await createTemporaryDirectory();
    const engine = await startLocalEngineServer({
      port: 0,
      projectRootAuthority: new ProjectRootAuthority(),
      selectProjectRoot: async () => projectRoot,
      token: launchToken,
    });
    runningEngines.add(engine);
    const client = new LocalEngineClient({
      baseUrl: engine.baseUrl,
      token: launchToken,
    });

    await expect(client.selectProjectRoot()).resolves.toMatchObject({
      ok: true,
      selection: 'SELECTED',
    });
    const save = await client.saveRecordingWav(
      createPcmWavBlob({ durationSeconds: 2 }),
    );

    if (!save.ok) {
      throw new Error(save.message);
    }

    const recordingRegistration = createRecordingArtifactRegistration(
      cloneSampleProject(),
      save.recording,
      {
        inputDeviceLabel: 'Integration Test Microphone',
        startTick: 1_920,
        targetClipId: 'clip-hum-1',
      },
    );

    if (!recordingRegistration.canRegister) {
      throw new Error(recordingRegistration.message);
    }

    const enqueue = await client.enqueueMockHumToMidiJob(
      createMockHumToMidiJobRequest(
        recordingRegistration.artifact,
        recordingRegistration.clipTake,
      ),
    );

    expect(enqueue).toMatchObject({
      job: {
        modelId: 'mock-hum-to-midi-v1',
        state: 'QUEUED',
        taskId: 'hum-to-midi',
      },
      ok: true,
    });

    if (!enqueue.ok) {
      throw new Error(enqueue.message);
    }

    const completedJob = await waitForCompletedJob(client, enqueue.job.jobId);
    const midiRegistration = createMidiArtifactRegistration(
      recordingRegistration.project,
      completedJob.result.artifact,
      {
        clipId: 'clip-midi-1',
        label: 'Engine MIDI Take',
      },
    );

    expect(midiRegistration).toMatchObject({
      artifact: {
        kind: 'midi',
        lineage: {
          parentArtifactIds: [recordingRegistration.artifact.artifactId],
          parentClipTakeIds: [recordingRegistration.clipTake.clipTakeId],
        },
        midi: {
          bpm: 120,
          notes: expect.arrayContaining([
            expect.objectContaining({ pitch: 67, startTick: 0 }),
          ]),
          ticksPerQuarter: 960,
        },
        sourceJobId: completedJob.jobId,
      },
      canRegister: true,
      clipTake: {
        label: 'Engine MIDI Take',
        mediaType: 'midi',
        sourceJobId: completedJob.jobId,
      },
      status: 'REGISTERED',
    });

    if (!midiRegistration.canRegister) {
      throw new Error(midiRegistration.message);
    }

    expect(midiRegistration.artifact.midi.notes).toHaveLength(4);
  });

  it('routes one exact Recording Take through Basic Pitch and registers only its valid MIDI Artifact', async () => {
    const projectRoot = await createTemporaryDirectory();
    const projectRootAuthority = new ProjectRootAuthority();
    const basicPitchJobExecutor = new BasicPitchJobExecutor({
      createWorkerClient: () => new IntegrationBasicPitchWorkerClient(),
      projectRootAuthority,
    });
    const engine = await startLocalEngineServer({
      basicPitchJobExecutor,
      port: 0,
      projectRootAuthority,
      selectProjectRoot: async () => projectRoot,
      token: launchToken,
    });
    runningEngines.add(engine);
    const client = new LocalEngineClient({
      baseUrl: engine.baseUrl,
      token: launchToken,
    });

    await expect(client.selectProjectRoot()).resolves.toMatchObject({
      ok: true,
      selection: 'SELECTED',
    });
    const save = await client.saveRecordingWav(
      createPcmWavBlob({ durationSeconds: 2 }),
    );

    if (!save.ok) {
      throw new Error(save.message);
    }

    const recordingRegistration = createRecordingArtifactRegistration(
      cloneSampleProject(),
      save.recording,
      {
        inputDeviceLabel: 'Integration Test Microphone',
        startTick: 1_920,
        targetClipId: 'clip-hum-1',
      },
    );

    if (!recordingRegistration.canRegister) {
      throw new Error(recordingRegistration.message);
    }

    const request = createBasicPitchHumToMidiJobRequest(
      recordingRegistration.artifact,
      recordingRegistration.clipTake,
    );
    const enqueue = await client.enqueueBasicPitchHumToMidiJob(request);

    expect(enqueue).toMatchObject({
      job: {
        modelId: 'basic-pitch-icassp-2022',
        providerId: 'local-basic-pitch',
        state: 'QUEUED',
        taskId: 'hum-to-midi',
      },
      ok: true,
    });

    if (!enqueue.ok) {
      throw new Error(enqueue.message);
    }

    const completedJob = await waitForCompletedJob(client, enqueue.job.jobId);
    const completedArtifact = completedJob.result.artifact;
    const staleLineageRegistration = createMidiArtifactRegistration(
      recordingRegistration.project,
      {
        ...completedArtifact,
        lineage: {
          parentArtifactIds: [recordingRegistration.artifact.artifactId],
          parentClipTakeIds: ['clip-take-stale'],
        },
      },
      { clipId: 'clip-midi-1' },
    );
    const midiRegistration = createMidiArtifactRegistration(
      recordingRegistration.project,
      completedArtifact,
      {
        clipId: 'clip-midi-1',
        label: 'Basic Pitch MIDI Take',
      },
    );

    expect(staleLineageRegistration).toMatchObject({
      canRegister: false,
      reason: 'source-lineage-invalid',
    });
    expect(midiRegistration).toMatchObject({
      artifact: {
        kind: 'midi',
        lineage: {
          parentArtifactIds: [recordingRegistration.artifact.artifactId],
          parentClipTakeIds: [recordingRegistration.clipTake.clipTakeId],
        },
        midi: {
          bpm: 120,
          notes: [
            expect.objectContaining({
              confidence: 0.92,
              pitch: 69,
              startTick: 0,
            }),
          ],
          ticksPerQuarter: 960,
        },
        provenance: {
          modelId: 'basic-pitch-icassp-2022',
          modelRevision: '0.4.0-onnx',
          parameters: request.parameters,
          providerId: 'local-basic-pitch',
          taskId: 'hum-to-midi',
        },
        sourceJobId: completedJob.jobId,
      },
      canRegister: true,
      clipTake: {
        label: 'Basic Pitch MIDI Take',
        mediaType: 'midi',
        sourceJobId: completedJob.jobId,
      },
      status: 'REGISTERED',
    });
  });
});

describe('Instrument Render Artifact registration integration', () => {
  it('renders the Active MIDI Take and registers one Instrument Audio Take', async () => {
    const projectRoot = await createTemporaryDirectory();
    const engine = await startLocalEngineServer({
      port: 0,
      projectRootAuthority: new ProjectRootAuthority(),
      selectProjectRoot: async () => projectRoot,
      token: launchToken,
    });
    runningEngines.add(engine);
    const client = new LocalEngineClient({
      baseUrl: engine.baseUrl,
      token: launchToken,
    });

    await expect(client.selectProjectRoot()).resolves.toMatchObject({
      ok: true,
      selection: 'SELECTED',
    });
    const save = await client.saveRecordingWav(
      createPcmWavBlob({ durationSeconds: 2 }),
    );

    if (!save.ok) {
      throw new Error(save.message);
    }

    const recordingRegistration = createRecordingArtifactRegistration(
      cloneSampleProject(),
      save.recording,
      {
        startTick: 1_920,
        targetClipId: 'clip-hum-1',
      },
    );

    if (!recordingRegistration.canRegister) {
      throw new Error(recordingRegistration.message);
    }

    const midiEnqueue = await client.enqueueMockHumToMidiJob(
      createMockHumToMidiJobRequest(
        recordingRegistration.artifact,
        recordingRegistration.clipTake,
      ),
    );

    if (!midiEnqueue.ok) {
      throw new Error(midiEnqueue.message);
    }

    const completedMidiJob = await waitForCompletedJob(
      client,
      midiEnqueue.job.jobId,
    );
    const midiRegistration = createMidiArtifactRegistration(
      recordingRegistration.project,
      completedMidiJob.result.artifact,
      {
        clipId: 'clip-midi-1',
        label: 'Engine MIDI Take',
      },
    );

    if (!midiRegistration.canRegister) {
      throw new Error(midiRegistration.message);
    }

    const source = resolveActiveMidiTake(
      midiRegistration.project,
      'clip-midi-1',
    );

    if (!source.canResolve) {
      throw new Error(source.message);
    }

    const renderEnqueue = await client.enqueueInstrumentRenderJob(
      createInstrumentRenderJobRequest({
        gainDb: -3,
        modelId: 'mock-soundfont-v1',
        modelRevision: '1',
        plan: source.plan,
        preset: {
          bank: 0,
          program: 24,
        },
        providerId: 'mock-provider',
        providerVersion: '1',
        sampleRate: 8_000,
      }),
    );

    expect(renderEnqueue).toMatchObject({
      job: {
        modelId: 'mock-soundfont-v1',
        state: 'QUEUED',
        taskId: 'midi-to-audio',
      },
      ok: true,
    });

    if (!renderEnqueue.ok) {
      throw new Error(renderEnqueue.message);
    }

    const completedRenderJob = await waitForCompletedJob(
      client,
      renderEnqueue.job.jobId,
    );
    const registration = createInstrumentRenderRegistration(
      midiRegistration.project,
      completedRenderJob,
      {
        label: 'SoundFont Render 01',
        sourceClipId: 'clip-midi-1',
        targetClipId: 'clip-inst-1',
      },
    );

    expect(registration).toMatchObject({
      artifact: {
        audio: {
          channels: 2,
          mimeType: 'audio/wav',
        },
        destination: 'instrument',
        lineage: {
          parentArtifactIds: [midiRegistration.artifact.artifactId],
          parentClipTakeIds: [midiRegistration.clipTake.clipTakeId],
        },
        provenance: {
          parameters: {
            gainDb: -3,
            preset: {
              bank: 0,
              program: 24,
            },
            providerVersion: '1',
          },
          taskId: 'midi-to-audio',
        },
        sourceJobId: completedRenderJob.jobId,
      },
      canRegister: true,
      clipTake: {
        label: 'SoundFont Render 01',
        mediaType: 'audio',
        sourceJobId: completedRenderJob.jobId,
        sourceType: 'job',
      },
      status: 'REGISTERED',
    });

    if (!registration.canRegister) {
      throw new Error(registration.message);
    }

    const targetClip = registration.project.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === 'clip-inst-1');

    expect(targetClip?.activeClipTakeId).toBe(
      registration.clipTake.clipTakeId,
    );
    await expect(
      access(
        join(
          projectRoot,
          ...registration.artifact.file.relativePath.split('/'),
        ),
      ),
    ).resolves.toBeUndefined();
  });
});

async function waitForCompletedJob(client, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.getJobs();

    if (!result.ok) {
      throw new Error(result.message);
    }

    const job = result.snapshot.jobs.find((candidate) => candidate.jobId === jobId);

    if (job?.state === 'COMPLETED') {
      return job;
    }

    if (job?.state === 'FAILED') {
      throw new Error(job.error?.message ?? 'GPU Job failed without an error message.');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('GPU Job did not complete before the integration test timeout.');
}

function createMockJobRequest() {
  return {
    inputArtifacts: [],
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    modelId: 'mock-audio-v1',
    modelRevision: '1',
    output: {
      artifactKind: 'audio',
      destination: 'instrument',
      extension: '.wav',
    },
    parameters: {
      durationSeconds: 0.1,
      frequencyHz: 440,
      sampleRate: 8_000,
      seed: 11,
    },
    providerId: 'mock-provider',
    taskId: 'mock-audio-generation',
  };
}

function createMockHumToMidiJobRequest(recordingArtifact, recordingTake) {
  return {
    inputArtifacts: [
      {
        artifactId: recordingArtifact.artifactId,
        kind: 'audio',
        relativePath: recordingArtifact.file.relativePath,
      },
    ],
    lineage: {
      parentArtifactIds: [recordingArtifact.artifactId],
      parentClipTakeIds: [recordingTake.clipTakeId],
    },
    modelId: 'mock-hum-to-midi-v1',
    modelRevision: '1',
    output: {
      artifactKind: 'midi',
    },
    parameters: {
      projectBpm: 120,
      seed: 7,
      sourceEndSeconds: recordingArtifact.audio.durationSeconds,
      sourceStartSeconds: 0,
      ticksPerQuarter: 960,
    },
    providerId: 'mock-provider',
    taskId: 'hum-to-midi',
  };
}

function createBasicPitchHumToMidiJobRequest(recordingArtifact, recordingTake) {
  return {
    inputArtifacts: [
      {
        artifactId: recordingArtifact.artifactId,
        kind: 'audio',
        relativePath: recordingArtifact.file.relativePath,
      },
    ],
    lineage: {
      parentArtifactIds: [recordingArtifact.artifactId],
      parentClipTakeIds: [recordingTake.clipTakeId],
    },
    modelId: 'basic-pitch-icassp-2022',
    modelRevision: '0.4.0-onnx',
    output: {
      artifactKind: 'midi',
    },
    parameters: {
      frameThreshold: 0.3,
      maximumFrequencyHz: 1_100,
      melodiaTrick: true,
      minimumFrequencyHz: 80,
      minimumNoteLengthMs: 127.7,
      multiplePitchBends: false,
      onsetThreshold: 0.5,
      projectBpm: 120,
      sourceEndSeconds: recordingArtifact.audio.durationSeconds,
      sourceStartSeconds: 0,
      ticksPerQuarter: 960,
    },
    providerId: 'local-basic-pitch',
    taskId: 'hum-to-midi',
  };
}

class IntegrationBasicPitchWorkerClient {
  async start() {}

  async loadModel() {}

  async execute(job) {
    return {
      artifact: {
        bpm: job.parameters.projectBpm,
        kind: 'midi',
        notes: [
          {
            confidence: 0.92,
            id: 'note-basic-pitch-integration-a',
            lengthTicks: 960,
            pitch: 69,
            startTick: 0,
            velocity: 111,
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

  async unloadModel() {}

  async close() {}

  async terminate() {}
}

function createPcmWavBlob({ durationSeconds = 0.1, sampleRate = 8_000 } = {}) {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataByteLength = frameCount * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataByteLength);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataByteLength, 40);

  return new Blob([wav], { type: 'audio/wav' });
}

function cloneSampleProject() {
  return JSON.parse(JSON.stringify(sampleProject));
}

function findProjectClip(project, clipId) {
  const clips = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);

  if (clips.length !== 1) {
    throw new Error(`Expected one Project Clip: ${clipId}.`);
  }

  return clips[0];
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-registration-integration-'));
  temporaryDirectories.add(directory);
  return directory;
}
