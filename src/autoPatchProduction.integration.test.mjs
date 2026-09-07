import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GeneratedArtifactFinalizer } from '../engine/generatedArtifactFinalizer.mjs';
import { FluidSynthJobExecutor } from '../engine/jobs/fluidSynthJobExecutor.mjs';
import { StableAudio3JobExecutor } from '../engine/jobs/stableAudio3JobExecutor.mjs';
import { ProjectRootAuthority } from '../engine/projectRootAuthority.mjs';
import { startLocalEngineServer } from '../engine/server.mjs';
import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_SAMPLE_RATE,
} from '../shared/stableAudio3Protocol.js';
import {
  createAutoPatchProductionDriverClient,
  runAutoPatchProductionDriver,
} from './autoPatchProductionDriver.ts';
import { prepareAutoPatchProductionPersistence } from './autoPatchProductionPersistence.ts';
import { prepareAutoPatchProductionRun } from './autoPatchProductionPreparation.ts';
import { createProductionProject } from './autoPatchProductionPreparation.testFixture.ts';
import { commitAutoPatchProject } from './autoPatchProjectCommit.ts';
import { LocalEngineClient } from './localEngineClient.ts';

const launchToken = 'autopatch-integration-token-at-least-32-characters';
const wrongLaunchToken = 'wrong-autopatch-integration-token-32-characters';
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

describe('Auto Patch production Local Engine integration', () => {
  it('runs and persists the authenticated three-Stage route for recovery', async () => {
    const projectRoot = await createTemporaryDirectory();
    const firstRuntime = await startRuntime(projectRoot);
    const unauthorizedClient = new LocalEngineClient({
      baseUrl: firstRuntime.engine.baseUrl,
      token: wrongLaunchToken,
    });

    await expect(unauthorizedClient.getJobs()).resolves.toMatchObject({
      ok: false,
      reason: 'unauthorized',
      status: 401,
    });
    await expect(firstRuntime.client.selectProjectRoot()).resolves.toMatchObject({
      ok: true,
      selection: 'SELECTED',
    });

    await writeFile(
      join(projectRoot, 'soundfonts', 'Integration Piano.sf2'),
      Buffer.from('HumStudio integration SoundFont fixture', 'utf8'),
    );
    const catalog = await firstRuntime.client.listSoundFonts();

    if (!catalog.ok) {
      throw new Error(catalog.message);
    }

    expect(catalog.catalog).toMatchObject({
      issues: [],
      resources: [
        {
          format: 'sf2',
          relativePath: 'soundfonts/Integration Piano.sf2',
          status: 'AVAILABLE',
        },
      ],
    });

    const soundFont = catalog.catalog.resources[0];
    const initialProject = createProductionProject({
      includeStableAudio3: true,
      midiNotes: [
        {
          id: 'note-autopatch-integration-c4',
          lengthTicks: 960,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
      ],
      soundFont,
      stableAudio3DurationSeconds: 1,
    });
    const preparation = prepareAutoPatchProductionRun(initialProject, {
      createdAt: new Date().toISOString(),
      planId: 'plan-autopatch-engine-integration',
      runId: 'run-autopatch-engine-integration',
      verifiedAudioArtifactIds: [],
      verifiedSoundFontResources: catalog.catalog.resources,
    });

    expect(preparation).toMatchObject({
      canRun: true,
      stageCount: 3,
      status: 'RUN_READY',
    });

    if (!preparation.canRun) {
      throw new Error(preparation.message);
    }

    const result = await runAutoPatchProductionDriver(
      createAutoPatchProductionDriverClient(firstRuntime.client),
      initialProject,
      preparation.coordinator,
      preparation.verifiedSoundFontResources,
      {
        identity: createIdentityServices(),
        instrumentRunner: createFastRunnerOptions(),
        stableAudio3Runner: createFastRunnerOptions(),
      },
    );

    if (!result.ok) {
      throw new Error(`${result.status} ${result.cause}: ${result.message}`);
    }

    expect(result).toMatchObject({
      coordinator: {
        attempts: [
          { state: 'COMPLETED' },
          { state: 'COMPLETED' },
          { state: 'COMPLETED' },
        ],
        status: 'COMPLETED',
      },
      status: 'COMPLETED',
    });
    expect(
      new Set(
        result.project.tabFlowStageResults.map(
          (stageResult) => stageResult.scope.stageId,
        ),
      ),
    ).toEqual(new Set(['midi-edit', 'instrument', 'stable-audio-3']));

    const instrumentResult = requireStageResult(result.project, 'instrument');
    const stableAudio3Result = requireStageResult(
      result.project,
      'stable-audio-3',
    );
    const instrumentArtifactId = instrumentResult.outputArtifactIds[0];
    const stableAudio3ArtifactId = stableAudio3Result.outputArtifactIds[0];
    const instrumentArtifact = requireArtifact(
      result.project,
      instrumentArtifactId,
    );
    const stableAudio3Artifact = requireArtifact(
      result.project,
      stableAudio3ArtifactId,
    );
    const completedResultIds = result.coordinator.attempts.map(
      (attempt) => attempt.resultId,
    );
    const generatedAudioSources = [instrumentArtifact, stableAudio3Artifact].map(
      (artifact) => ({
        kind: 'generated',
        name: artifact.file.name,
        relativePath: artifact.file.relativePath,
        sizeBytes: artifact.file.sizeBytes,
        sourceId: artifact.artifactId,
      }),
    );
    const jobs = await firstRuntime.client.getJobs();

    expect(jobs).toMatchObject({
      ok: true,
      snapshot: {
        jobs: [
          { providerId: 'local-fluidsynth', state: 'COMPLETED' },
          { providerId: 'local-stable-audio-3', state: 'COMPLETED' },
        ],
      },
    });
    expect(firstRuntime.instrumentRenders).toHaveLength(1);
    expect(firstRuntime.stableAudio3Worker.calls).toEqual([
      'start',
      'load',
      'execute',
      'unload',
      'close',
    ]);
    expect(firstRuntime.stableAudio3Worker.executions).toHaveLength(1);
    const stableAudio3Input =
      firstRuntime.stableAudio3Worker.executions[0].inputArtifacts[0];

    expect(stableAudio3Input).toMatchObject({
      artifactId: instrumentArtifactId,
      kind: 'audio',
    });
    expect((await realpath(stableAudio3Input.path)).toLowerCase()).toBe(
      (
        await realpath(
          join(projectRoot, ...instrumentArtifact.file.relativePath.split('/')),
        )
      ).toLowerCase(),
    );
    expect(stableAudio3Artifact.lineage).toEqual({
      parentArtifactIds: [instrumentArtifactId],
      parentClipTakeIds: instrumentResult.outputClipTakeIds,
    });

    const outputClip = result.project.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.type === 'instrument-audio');

    expect(outputClip).toMatchObject({
      activeClipTakeId: instrumentResult.outputClipTakeIds[0],
      clipTakes: expect.arrayContaining([
        expect.objectContaining({ artifactId: instrumentArtifactId }),
        expect.objectContaining({ artifactId: stableAudio3ArtifactId }),
      ]),
    });

    const availability = await firstRuntime.client.checkGeneratedAudioAvailability(
      generatedAudioSources,
    );

    if (!availability.ok) {
      throw new Error(availability.message);
    }

    expect(new Set(availability.availableSourceIds)).toEqual(
      new Set([instrumentArtifactId, stableAudio3ArtifactId]),
    );

    for (const artifact of [instrumentArtifact, stableAudio3Artifact]) {
      await expect(
        access(join(projectRoot, ...artifact.file.relativePath.split('/'))),
      ).resolves.toBeUndefined();
    }

    const persistence = prepareAutoPatchProductionPersistence(
      initialProject,
      preparation.coordinator,
      result,
      {
        history: {
          entryId: 'history-autopatch-engine-integration',
          name: 'Auto Patch Engine Integration',
          recordedAt: new Date().toISOString(),
        },
        sourceAvailability: {
          availableArtifactIds: availability.availableSourceIds,
          checkedAt: new Date().toISOString(),
        },
      },
    );

    expect(persistence).toMatchObject({
      canCommit: true,
      historyEntry: {
        autoPatchProduction: {
          attempts: [
            { state: 'COMPLETED' },
            { state: 'COMPLETED' },
            { state: 'COMPLETED' },
          ],
          completedResultIds,
          resultStatus: 'COMPLETED',
        },
      },
      plan: { commitKind: 'COMPLETED' },
      status: 'COMMIT_READY',
    });

    if (!persistence.canCommit) {
      throw new Error(persistence.message);
    }

    const savedAt = new Date().toISOString();
    const projectFile = {
      app: 'HumSTUDIO',
      savedAt,
      version: '0.1.0',
      workspace: { project: persistence.project },
    };
    const committed = await commitAutoPatchProject(
      firstRuntime.client,
      persistence.plan,
      {
        currentProject: persistence.project,
        materializeProjectFile: () => projectFile,
      },
    );

    expect(committed).toMatchObject({ ok: true, status: 'COMMITTED' });

    if (!committed.ok) {
      throw new Error(committed.message);
    }

    await expect(access(committed.savedProject.projectFilePath)).resolves.toBeUndefined();

    await firstRuntime.engine.close();
    runningEngines.delete(firstRuntime.engine);

    const recoveredRuntime = await startRuntime(projectRoot);
    await expect(recoveredRuntime.client.selectProjectRoot()).resolves.toMatchObject({
      ok: true,
      selection: 'SELECTED',
    });
    const loaded = await recoveredRuntime.client.loadProjectFile();

    if (!loaded.ok) {
      throw new Error(loaded.message);
    }

    const recoveredProject = loaded.loadedProject.projectFile.workspace.project;

    expect(recoveredProject).toEqual(
      JSON.parse(JSON.stringify(persistence.project)),
    );
    expect(recoveredProject.takes).toEqual([
      expect.objectContaining({
        autoPatchProduction: expect.objectContaining({
          completedResultIds,
          generatedArtifactIds: expect.arrayContaining([
            instrumentArtifactId,
            stableAudio3ArtifactId,
          ]),
          resultStatus: 'COMPLETED',
          runId: preparation.coordinator.runId,
        }),
        id: 'history-autopatch-engine-integration',
      }),
    ]);

    const recoveredAvailability =
      await recoveredRuntime.client.checkGeneratedAudioAvailability(
        generatedAudioSources,
      );

    expect(recoveredAvailability).toEqual({
      availableSourceIds: availability.availableSourceIds,
      ok: true,
    });

    const recoveredCatalog = await recoveredRuntime.client.listSoundFonts();

    if (!recoveredCatalog.ok) {
      throw new Error(recoveredCatalog.message);
    }

    expect(
      prepareAutoPatchProductionRun(recoveredProject, {
        createdAt: new Date().toISOString(),
        planId: 'plan-autopatch-engine-recovery',
        runId: 'run-autopatch-engine-recovery',
        verifiedAudioArtifactIds: recoveredAvailability.ok
          ? recoveredAvailability.availableSourceIds
          : [],
        verifiedSoundFontResources: recoveredCatalog.catalog.resources,
      }),
    ).toMatchObject({
      canRun: true,
      stageCount: 3,
      status: 'RUN_READY',
    });
  });
});

async function startRuntime(projectRoot) {
  const projectRootAuthority = new ProjectRootAuthority();
  const generatedArtifactFinalizer = new GeneratedArtifactFinalizer({
    projectRootAuthority,
  });
  const stableAudio3Worker = new SuccessfulStableAudio3WorkerClient();
  const instrumentRenders = [];
  const fluidSynthJobExecutor = new FluidSynthJobExecutor({
    generatedArtifactFinalizer,
    soundFontAuditionService: {
      render: async (request, options) => {
        instrumentRenders.push({ options, request });
        const bytes = createPcmWav({
          channels: 2,
          durationSeconds: 0.1,
          sampleRate: options.sampleRate,
        });
        return {
          bytes,
          contentLength: bytes.length,
          contentType: 'audio/wav',
        };
      },
    },
  });
  const stableAudio3JobExecutor = new StableAudio3JobExecutor({
    createWorkerClient: () => stableAudio3Worker,
    generatedArtifactFinalizer,
    projectRootAuthority,
  });
  const engine = await startLocalEngineServer({
    fluidSynthJobExecutor,
    generatedArtifactFinalizer,
    port: 0,
    projectRootAuthority,
    selectProjectRoot: async () => projectRoot,
    stableAudio3JobExecutor,
    token: launchToken,
  });
  runningEngines.add(engine);

  return {
    client: new LocalEngineClient({
      baseUrl: engine.baseUrl,
      token: launchToken,
    }),
    engine,
    instrumentRenders,
    stableAudio3Worker,
  };
}

class SuccessfulStableAudio3WorkerClient {
  calls = [];
  executions = [];

  async start() {
    this.calls.push('start');
  }

  async loadModel() {
    this.calls.push('load');
  }

  async execute(job) {
    this.calls.push('execute');
    this.executions.push(job);
    const wav = createPcmWav({
      channels: STABLE_AUDIO_3_CHANNELS,
      durationSeconds: job.parameters.durationSeconds,
      sampleRate: STABLE_AUDIO_3_SAMPLE_RATE,
    });
    await writeFile(job.output.stagingPath, wav);
    return {
      artifact: {
        bytesWritten: wav.length,
        channels: STABLE_AUDIO_3_CHANNELS,
        durationSeconds: job.parameters.durationSeconds,
        mimeType: 'audio/wav',
        stagingPath: job.output.stagingPath,
      },
      completedAt: new Date().toISOString(),
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

  async unloadModel() {
    this.calls.push('unload');
  }

  async close() {
    this.calls.push('close');
  }

  async terminate() {
    this.calls.push('terminate');
  }
}

function createIdentityServices() {
  const indexes = new Map();

  return Object.freeze({
    allocateId: (kind) => {
      const index = (indexes.get(kind) ?? 0) + 1;
      indexes.set(kind, index);
      return `${kind}-integration-${index}`;
    },
    clock: () => new Date().toISOString(),
  });
}

function createFastRunnerOptions() {
  return Object.freeze({
    pollIntervalMs: 1,
    wait: async (delayMs) =>
      new Promise((resolve) => setTimeout(resolve, Math.max(1, delayMs))),
  });
}

function requireStageResult(project, stageId) {
  const result = project.tabFlowStageResults?.find(
    (candidate) => candidate.scope.stageId === stageId,
  );

  if (!result) {
    throw new Error(`Missing ${stageId} Stage Result.`);
  }

  return result;
}

function requireArtifact(project, artifactId) {
  const artifact = project.artifacts?.find(
    (candidate) => candidate.artifactId === artifactId,
  );

  if (!artifact || artifact.kind !== 'audio') {
    throw new Error(`Missing Audio Artifact ${artifactId}.`);
  }

  return artifact;
}

function createPcmWav({ channels, durationSeconds, sampleRate }) {
  const bytesPerSample = 2;
  const frameCount = Math.max(1, Math.round(durationSeconds * sampleRate));
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
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataByteLength, 40);

  return wav;
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(
    join(tmpdir(), 'humstudio-autopatch-integration-'),
  );
  temporaryDirectories.add(directory);
  return directory;
}
