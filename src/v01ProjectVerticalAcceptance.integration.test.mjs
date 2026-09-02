import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GeneratedArtifactFinalizer } from '../engine/generatedArtifactFinalizer.mjs';
import { AceStepJobExecutor } from '../engine/jobs/aceStepJobExecutor.mjs';
import { BasicPitchJobExecutor } from '../engine/jobs/basicPitchJobExecutor.mjs';
import { FluidSynthJobExecutor } from '../engine/jobs/fluidSynthJobExecutor.mjs';
import { StableAudio3JobExecutor } from '../engine/jobs/stableAudio3JobExecutor.mjs';
import { ProjectRootAuthority } from '../engine/projectRootAuthority.mjs';
import {
  BASIC_PITCH_MODEL_ID,
  BASIC_PITCH_MODEL_REVISION,
  BASIC_PITCH_PROVIDER_ID,
  BASIC_PITCH_TASK_ID,
} from '../engine/providers/basicPitchProviderDefinition.mjs';
import { startLocalEngineServer } from '../engine/server.mjs';
import {
  ACE_STEP_CHANNELS,
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_SAMPLE_RATE,
  ACE_STEP_TASK_ID,
} from '../shared/aceStepProtocol.js';
import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TASK_ID,
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_SAMPLE_RATE,
} from '../shared/stableAudio3Protocol.js';
import { HUMSTUDIO_AUDIO_FORMAT } from '../shared/humStudioAudioFormat.js';
import {
  createAutoPatchProductionDriverClient,
  runAutoPatchProductionDriver,
} from './autoPatchProductionDriver.ts';
import { prepareAutoPatchProductionPersistence } from './autoPatchProductionPersistence.ts';
import { prepareAutoPatchProductionRun } from './autoPatchProductionPreparation.ts';
import { createProductionProject } from './autoPatchProductionPreparation.testFixture.ts';
import { commitAutoPatchProject } from './autoPatchProjectCommit.ts';
import {
  resolveAceStepVocalTarget,
  runAceStepVocalStage,
} from './aceStepVocalStage.ts';
import { activateClipTake } from './clipTakeActivation.ts';
import { downloadFinalFilerFilesInBrowser } from './finalFilerBrowserDownload.ts';
import {
  FinalFilerController,
  resolveFinalFilerAvailability,
} from './finalFilerController.ts';
import { resolveFinalFilerExportTarget } from './finalFilerExportTarget.ts';
import {
  parseFinalFilerWavMetadata,
  sha256Blob,
  sha256Text,
} from './finalFilerSourceReport.ts';
import { LocalEngineClient } from './localEngineClient.ts';
import { createMidiArtifactRegistration } from './projectArtifactRegistration.ts';
import { prepareProjectMixdown } from './projectMixdownPreparation.ts';
import { createCanonicalProjectMixdownPlanJson } from './projectMixdownPlanIdentity.ts';
import { runProjectMixdownRequest } from './projectMixdownRunner.ts';
import { createProjectDirtyStateFingerprint } from './projectDirtyStateFingerprint.ts';
import {
  reconcileProjectMixerState,
  setProjectMixerChannelMuted,
} from './projectMixerState.ts';
import {
  applyProjectSourceRestoration,
  collectProjectSourceRestorationDescriptors,
} from './projectSourceRestoration.ts';
import { createRecordingArtifactRegistration } from './recordingArtifactRegistration.ts';
import { runStableAudio3AudioToAudioBatch } from './stableAudio3AudioToAudioBatch.ts';
import { resolveStableAudio3AudioToAudioContinuation } from './stableAudio3AudioToAudioContinuation.ts';
import { createStableAudio3StageAdapterPlan } from './stableAudio3StageAdapter.ts';

const launchToken = 'v01-vertical-acceptance-token-at-least-32-characters';
const wrongLaunchToken = 'wrong-v01-vertical-acceptance-token-32-chars';
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

describe('HumStudio v0.1 single-Project vertical acceptance', () => {
  it('persists and recovers one Recording through Auto Patch, ACE Vocals, Raw Mix, SA3 Master, and FINAL FILER', async () => {
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
      join(projectRoot, 'soundfonts', 'Vertical Acceptance Piano.sf2'),
      Buffer.from('HumStudio v0.1 vertical acceptance SoundFont', 'utf8'),
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
          relativePath: 'soundfonts/Vertical Acceptance Piano.sf2',
          status: 'AVAILABLE',
        },
      ],
    });

    const soundFont = catalog.catalog.resources[0];
    const initialProject = createProductionProject({
      includeStableAudio3: true,
      midiNotes: [
        {
          id: 'note-v01-source-c4',
          lengthTicks: 960,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
      ],
      soundFont,
      stableAudio3DurationSeconds: 1,
    });
    // The deterministic instrument provider below returns a full 10-second WAV.
    // Reserve enough Timeline space to retain that source rather than clipping it.
    initialProject.totalTicks = 30_720;
    const midiClipId = requireSelectedClipId(initialProject);
    const saveRecording = await firstRuntime.client.saveRecordingWav(
      createPcmWavBlob({ durationSeconds: 1 }),
    );

    if (!saveRecording.ok) {
      throw new Error(saveRecording.message);
    }

    const recordingRegistration = createRecordingArtifactRegistration(
      initialProject,
      saveRecording.recording,
      {
        inputDeviceLabel: 'Deterministic Vertical Acceptance Fixture',
        startTick: 0,
        targetTrackId: 'hum-audio',
      },
    );

    expect(recordingRegistration).toMatchObject({
      canRegister: true,
      clipTake: {
        artifactId: saveRecording.recording.artifactId,
        sourceType: 'recording',
      },
      status: 'REGISTERED',
    });

    if (!recordingRegistration.canRegister) {
      throw new Error(recordingRegistration.message);
    }

    const recordingRetry = createRecordingArtifactRegistration(
      recordingRegistration.project,
      saveRecording.recording,
      {
        inputDeviceLabel: 'Deterministic Vertical Acceptance Fixture',
        startTick: 0,
        targetTrackId: 'hum-audio',
      },
    );

    expect(recordingRetry).toMatchObject({
      canRegister: true,
      status: 'ALREADY_REGISTERED',
    });
    if (!recordingRetry.canRegister) {
      throw new Error(recordingRetry.message);
    }
    expect(recordingRetry.project).toBe(recordingRegistration.project);

    const basicPitchRequest = createBasicPitchRequest(
      recordingRegistration.artifact,
      recordingRegistration.clipTake,
    );
    const basicPitchEnqueue =
      await firstRuntime.client.enqueueBasicPitchHumToMidiJob(
        basicPitchRequest,
      );

    expect(basicPitchEnqueue).toMatchObject({
      job: {
        modelId: BASIC_PITCH_MODEL_ID,
        modelRevision: BASIC_PITCH_MODEL_REVISION,
        providerId: BASIC_PITCH_PROVIDER_ID,
        state: 'QUEUED',
        taskId: BASIC_PITCH_TASK_ID,
      },
      ok: true,
    });

    if (!basicPitchEnqueue.ok) {
      throw new Error(basicPitchEnqueue.message);
    }

    const completedBasicPitchJob = await waitForCompletedJob(
      firstRuntime.client,
      basicPitchEnqueue.job.jobId,
    );
    const projectBeforeRejectedRegistration = clone(
      recordingRegistration.project,
    );
    const staleBasicPitchArtifact = {
      ...completedBasicPitchJob.result.artifact,
      lineage: {
        parentArtifactIds: [recordingRegistration.artifact.artifactId],
        parentClipTakeIds: ['clip-take-stale-cross-stage'],
      },
    };
    const rejectedRegistration = createMidiArtifactRegistration(
      recordingRegistration.project,
      staleBasicPitchArtifact,
      { clipId: midiClipId, label: 'Rejected Basic Pitch Take' },
    );

    expect(rejectedRegistration).toMatchObject({
      canRegister: false,
      reason: 'source-lineage-invalid',
    });
    expect(recordingRegistration.project).toEqual(
      projectBeforeRejectedRegistration,
    );
    const jobsAfterRejectedRegistration = await firstRuntime.client.getJobs();

    expect(jobsAfterRejectedRegistration).toMatchObject({
      ok: true,
      snapshot: {
        jobs: [
          {
            jobId: completedBasicPitchJob.jobId,
            providerId: BASIC_PITCH_PROVIDER_ID,
            state: 'COMPLETED',
          },
        ],
      },
    });
    expect(firstRuntime.instrumentRenders).toHaveLength(0);
    expect(firstRuntime.stableAudio3Workers).toHaveLength(0);

    const midiRegistration = createMidiArtifactRegistration(
      recordingRegistration.project,
      completedBasicPitchJob.result.artifact,
      { clipId: midiClipId, label: 'Basic Pitch Vertical Take' },
    );

    expect(midiRegistration).toMatchObject({
      artifact: {
        kind: 'midi',
        lineage: {
          parentArtifactIds: [recordingRegistration.artifact.artifactId],
          parentClipTakeIds: [recordingRegistration.clipTake.clipTakeId],
        },
        provenance: {
          modelId: BASIC_PITCH_MODEL_ID,
          modelRevision: BASIC_PITCH_MODEL_REVISION,
          providerId: BASIC_PITCH_PROVIDER_ID,
          taskId: BASIC_PITCH_TASK_ID,
        },
        sourceJobId: completedBasicPitchJob.jobId,
      },
      canRegister: true,
      clipTake: {
        mediaType: 'midi',
        sourceJobId: completedBasicPitchJob.jobId,
      },
      status: 'REGISTERED',
    });

    if (!midiRegistration.canRegister) {
      throw new Error(midiRegistration.message);
    }

    const midiRetry = createMidiArtifactRegistration(
      midiRegistration.project,
      completedBasicPitchJob.result.artifact,
      { clipId: midiClipId, label: 'Basic Pitch Vertical Take' },
    );

    expect(midiRetry).toMatchObject({
      canRegister: true,
      status: 'ALREADY_REGISTERED',
    });
    if (!midiRetry.canRegister) {
      throw new Error(midiRetry.message);
    }
    expect(midiRetry.project).toBe(midiRegistration.project);

    const preparation = prepareAutoPatchProductionRun(
      midiRegistration.project,
      {
        createdAt: new Date().toISOString(),
        planId: 'plan-v01-vertical-acceptance',
        runId: 'run-v01-vertical-acceptance',
        verifiedAudioArtifactIds: [],
        verifiedSoundFontResources: catalog.catalog.resources,
      },
    );

    if (!preparation.canRun) {
      throw new Error(
        `${preparation.reason} ${preparation.cause}: ${preparation.message}`,
      );
    }

    expect(preparation).toMatchObject({
      canRun: true,
      stageCount: 3,
      status: 'RUN_READY',
    });

    const result = await runAutoPatchProductionDriver(
      createAutoPatchProductionDriverClient(firstRuntime.client),
      midiRegistration.project,
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

    const midiEditResult = requireStageResult(result.project, 'midi-edit');
    const instrumentResult = requireStageResult(result.project, 'instrument');
    const stableAudio3Result = requireStageResult(
      result.project,
      'stable-audio-3',
    );
    const midiEditArtifact = requireArtifact(
      result.project,
      midiEditResult.outputArtifactIds[0],
      'midi',
    );
    const instrumentArtifact = requireArtifact(
      result.project,
      instrumentResult.outputArtifactIds[0],
      'audio',
    );
    const stableAudio3Artifact = requireArtifact(
      result.project,
      stableAudio3Result.outputArtifactIds[0],
      'audio',
    );
    expect(result.project.tracks.flatMap((track) => track.clips).find((clip) =>
      clip.activeClipTakeId === instrumentResult.outputClipTakeIds[0],
    )).toMatchObject({
      lengthTicks: 19_200,
      audioTiming: {
        timeBase: 'absolute-seconds',
        sourceStartSeconds: 0,
        sourceEndSeconds: 10,
      },
    });

    expect(midiEditArtifact.lineage).toEqual({
      parentArtifactIds: [midiRegistration.artifact.artifactId],
      parentClipTakeIds: [midiRegistration.clipTake.clipTakeId],
    });
    expect(instrumentArtifact.lineage).toEqual({
      parentArtifactIds: [midiEditArtifact.artifactId],
      parentClipTakeIds: midiEditResult.outputClipTakeIds,
    });
    expect(stableAudio3Artifact.lineage).toEqual({
      parentArtifactIds: [instrumentArtifact.artifactId],
      parentClipTakeIds: instrumentResult.outputClipTakeIds,
    });
    expect(firstRuntime.basicPitchWorkers).toHaveLength(1);
    expect(firstRuntime.basicPitchWorkers[0].calls).toEqual([
      'start',
      'load',
      'execute',
      'unload',
      'close',
    ]);
    expect(firstRuntime.instrumentRenders).toHaveLength(1);
    expect(firstRuntime.stableAudio3Workers).toHaveLength(1);
    expect(firstRuntime.stableAudio3Workers[0].calls).toEqual([
      'start',
      'load',
      'execute',
      'unload',
      'close',
    ]);

    assertUniqueProjectIdentities(result.project);

    const jobs = await firstRuntime.client.getJobs();

    if (!jobs.ok) {
      throw new Error(jobs.message);
    }

    expect(jobs.snapshot.jobs).toHaveLength(3);
    expect(
      jobs.snapshot.jobs.map((job) => [job.providerId, job.state]),
    ).toEqual(
      expect.arrayContaining([
        [BASIC_PITCH_PROVIDER_ID, 'COMPLETED'],
        ['local-fluidsynth', 'COMPLETED'],
        ['local-stable-audio-3', 'COMPLETED'],
      ]),
    );
    expect(new Set(jobs.snapshot.jobs.map((job) => job.jobId)).size).toBe(3);

    const generatedAudioSources = [instrumentArtifact, stableAudio3Artifact].map(
      (artifact) => ({
        kind: 'generated',
        name: artifact.file.name,
        relativePath: artifact.file.relativePath,
        sizeBytes: artifact.file.sizeBytes,
        sourceId: artifact.artifactId,
      }),
    );
    const availability =
      await firstRuntime.client.checkGeneratedAudioAvailability(
        generatedAudioSources,
      );

    expect(availability).toMatchObject({ ok: true });
    if (!availability.ok) {
      throw new Error(availability.message);
    }
    expect(new Set(availability.availableSourceIds)).toEqual(
      new Set([instrumentArtifact.artifactId, stableAudio3Artifact.artifactId]),
    );

    for (const artifact of [
      recordingRegistration.artifact,
      instrumentArtifact,
      stableAudio3Artifact,
    ]) {
      await expect(
        access(join(projectRoot, ...artifact.file.relativePath.split('/'))),
      ).resolves.toBeUndefined();
    }

    const acceptanceTimelineStart = Date.now();
    const acceptanceTimestamp = (secondsFromStart) =>
      new Date(acceptanceTimelineStart + secondsFromStart * 1_000).toISOString();
    const persistence = prepareAutoPatchProductionPersistence(
      midiRegistration.project,
      preparation.coordinator,
      result,
      {
        history: {
          entryId: 'history-v01-vertical-acceptance',
          name: 'v0.1 Vertical Acceptance',
          recordedAt: acceptanceTimestamp(0),
        },
        sourceAvailability: {
          availableArtifactIds: availability.availableSourceIds,
          checkedAt: acceptanceTimestamp(1),
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
          resultStatus: 'COMPLETED',
          runId: preparation.coordinator.runId,
        },
      },
      status: 'COMMIT_READY',
    });

    if (!persistence.canCommit) {
      throw new Error(persistence.message);
    }

    const projectFile = {
      app: 'HumSTUDIO',
      savedAt: acceptanceTimestamp(1),
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
    await expect(
      access(committed.savedProject.projectFilePath),
    ).resolves.toBeUndefined();

    const guideClip = requireClipByTakeId(
      persistence.project,
      instrumentResult.outputClipTakeIds[0],
    );
    const vocalFixture = addExistingVocalTarget(
      persistence.project,
      guideClip.id,
      recordingRegistration.artifact,
    );

    expect(
      resolveAceStepVocalTarget(
        vocalFixture.project,
        vocalFixture.targetClip.id,
      ),
    ).toMatchObject({
      canResolve: true,
      guideClipId: guideClip.id,
      midiClipId,
      targetClipId: vocalFixture.targetClip.id,
    });

    const lyricsFilesBeforeRejection = await listProjectDirectory(
      projectRoot,
      'renders/ace-step/lyrics',
    );
    const jobsBeforeRejection = await firstRuntime.client.getJobs();

    if (!jobsBeforeRejection.ok) {
      throw new Error(jobsBeforeRejection.message);
    }

    const staleProject = replaceClip(vocalFixture.project, {
      ...vocalFixture.targetClip,
      sourceClipId: 'clip-v01-stale-guide',
    });
    const staleProjectSnapshot = clone(staleProject);
    const rejectedAce = await runAceStepVocalStage(
      firstRuntime.client,
      createAceStageInput(staleProject, {
        guideClipId: guideClip.id,
        midiClipId,
        targetClipId: vocalFixture.targetClip.id,
      }),
      createFastRunnerOptions(),
    );

    expect(rejectedAce).toMatchObject({
      ok: false,
      reason: 'input-invalid',
      status: 'FAILED',
    });
    expect(rejectedAce.project).toBe(staleProject);
    expect(staleProject).toEqual(staleProjectSnapshot);
    expect(firstRuntime.aceStepWorkers).toHaveLength(0);
    expect(
      await listProjectDirectory(projectRoot, 'renders/ace-step/lyrics'),
    ).toEqual(lyricsFilesBeforeRejection);

    const jobsAfterRejection = await firstRuntime.client.getJobs();

    expect(jobsAfterRejection).toEqual(jobsBeforeRejection);
    for (const artifact of [instrumentArtifact, stableAudio3Artifact]) {
      await expect(
        access(join(projectRoot, ...artifact.file.relativePath.split('/'))),
      ).resolves.toBeUndefined();
    }

    const aceProgress = [];
    const aceResult = await runAceStepVocalStage(
      firstRuntime.client,
      createAceStageInput(vocalFixture.project, {
        guideClipId: guideClip.id,
        midiClipId,
        targetClipId: vocalFixture.targetClip.id,
      }),
      {
        ...createFastRunnerOptions(),
        onProgress: (progress) => aceProgress.push(progress),
      },
    );

    if (!aceResult.ok) {
      throw new Error(`${aceResult.status} ${aceResult.reason}: ${aceResult.message}`);
    }

    expect(aceResult).toMatchObject({
      artifact: {
        destination: ACE_STEP_OUTPUT_DESTINATION,
        kind: 'audio',
        provenance: {
          modelId: ACE_STEP_MODEL_ID,
          modelRevision: ACE_STEP_MODEL_REVISION,
          providerId: ACE_STEP_PROVIDER_ID,
          taskId: ACE_STEP_TASK_ID,
        },
      },
      clipTake: {
        mediaType: 'audio',
        sourceJobId: aceResult.job.jobId,
        sourceType: 'job',
      },
      job: {
        modelId: ACE_STEP_MODEL_ID,
        modelRevision: ACE_STEP_MODEL_REVISION,
        providerId: ACE_STEP_PROVIDER_ID,
        state: 'COMPLETED',
        taskId: ACE_STEP_TASK_ID,
      },
      ok: true,
      status: 'COMPLETED',
    });
    expect(aceResult.job.request).toEqual(aceResult.request);
    expect(aceResult.artifact.lineage).toEqual(aceResult.request.lineage);
    expect(aceResult.request.lineage).toEqual({
      parentArtifactIds: [
        instrumentArtifact.artifactId,
        aceResult.lyricsSnapshot.artifactId,
      ],
      parentClipTakeIds: midiEditResult.outputClipTakeIds,
    });
    expect(aceResult.job.result.generation).toMatchObject({
      channels: ACE_STEP_CHANNELS,
      durationSeconds: 10,
      evidence: {
        guideAudioArtifactId: instrumentArtifact.artifactId,
        lyricsArtifactId: aceResult.lyricsSnapshot.artifactId,
        sampleRate: ACE_STEP_SAMPLE_RATE,
      },
      mimeType: 'audio/wav',
    });
    expect(
      aceProgress.map((progress) => progress.state),
    ).toEqual(
      expect.arrayContaining([
        'SAVING_LYRICS',
        'ENQUEUEING',
        'QUEUED',
        'PROCESSING',
        'COMPLETED',
      ]),
    );
    expect(firstRuntime.aceStepWorkers).toHaveLength(1);
    expect(firstRuntime.aceStepWorkers[0].calls).toEqual([
      'start',
      'load',
      'execute',
      'unload',
      'close',
    ]);

    const registeredVocalClip = requireClip(
      aceResult.project,
      vocalFixture.targetClip.id,
    );
    const generatedVocalTakes = (registeredVocalClip.clipTakes ?? []).filter(
      (take) => take.artifactId === aceResult.artifact.artifactId,
    );

    expect(generatedVocalTakes).toEqual([aceResult.clipTake]);
    expect(registeredVocalClip.activeClipTakeId).toBe(
      vocalFixture.existingTake.clipTakeId,
    );
    expect(registeredVocalClip.sourceFile?.sourceId).toBe(
      recordingRegistration.artifact.artifactId,
    );
    expect(registeredVocalClip.clipTakes).toHaveLength(2);
    assertUniqueProjectIdentities(aceResult.project);

    await expect(
      access(
        join(
          projectRoot,
          ...aceResult.lyricsSnapshot.file.relativePath.split('/'),
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(
      access(join(projectRoot, ...aceResult.artifact.file.relativePath.split('/'))),
    ).resolves.toBeUndefined();

    const jobsAfterAce = await firstRuntime.client.getJobs();

    if (!jobsAfterAce.ok) {
      throw new Error(jobsAfterAce.message);
    }

    expect(jobsAfterAce.snapshot.jobs).toHaveLength(4);
    expect(
      jobsAfterAce.snapshot.jobs.map((job) => [job.providerId, job.state]),
    ).toEqual(
      expect.arrayContaining([
        [BASIC_PITCH_PROVIDER_ID, 'COMPLETED'],
        ['local-fluidsynth', 'COMPLETED'],
        ['local-stable-audio-3', 'COMPLETED'],
        [ACE_STEP_PROVIDER_ID, 'COMPLETED'],
      ]),
    );
    expect(new Set(jobsAfterAce.snapshot.jobs.map((job) => job.jobId)).size).toBe(4);

    const allGeneratedAudioSources = [
      ...generatedAudioSources,
      {
        kind: 'generated',
        name: aceResult.artifact.file.name,
        relativePath: aceResult.artifact.file.relativePath,
        sizeBytes: aceResult.artifact.file.sizeBytes,
        sourceId: aceResult.artifact.artifactId,
      },
    ];
    const aceAvailability =
      await firstRuntime.client.checkGeneratedAudioAvailability(
        allGeneratedAudioSources,
      );

    if (!aceAvailability.ok) {
      throw new Error(aceAvailability.message);
    }

    expect(new Set(aceAvailability.availableSourceIds)).toEqual(
      new Set([
        instrumentArtifact.artifactId,
        stableAudio3Artifact.artifactId,
        aceResult.artifact.artifactId,
      ]),
    );

    const vocalActivation = activateClipTake(
      aceResult.project,
      vocalFixture.targetClip.id,
      aceResult.clipTake.clipTakeId,
    );

    if (!vocalActivation.canActivate) {
      throw new Error(vocalActivation.message);
    }

    expect(vocalActivation).toMatchObject({
      canActivate: true,
      clipTake: { artifactId: aceResult.artifact.artifactId },
      status: 'ACTIVATED',
    });

    const guideTrack = requireTrackByClipId(
      vocalActivation.project,
      guideClip.id,
    );
    const mixdownBaseProject = setProjectMixerChannelMuted(
      reconcileProjectMixerState(vocalActivation.project),
      guideTrack.id,
      false,
    );
    const mixdownBaseSnapshot = clone(mixdownBaseProject);
    const sourceDescriptors = collectProjectSourceRestorationDescriptors(
      mixdownBaseProject,
    );

    expect(sourceDescriptors.length).toBeGreaterThan(0);
    expect(new Set(sourceDescriptors.map((source) => source.sourceId)).size).toBe(
      sourceDescriptors.length,
    );
    expect(
      sourceDescriptors.map((source) => source.sourceId),
    ).toContain(aceResult.artifact.artifactId);

    const mixdownFilesBeforeRejection = await listProjectDirectory(
      projectRoot,
      'mixdowns',
    );
    const staleSourceDescriptors = sourceDescriptors.map((descriptor) =>
      descriptor.sourceId === aceResult.artifact.artifactId
        ? Object.freeze({
            ...descriptor,
            sizeBytes: (descriptor.sizeBytes ?? 0) + 1,
          })
        : descriptor,
    );
    const staleRestorationResult =
      await firstRuntime.client.restoreSources(staleSourceDescriptors);

    if (!staleRestorationResult.ok) {
      throw new Error(staleRestorationResult.message);
    }

    expect(
      staleRestorationResult.restoration.sources.find(
        (source) => source.sourceId === aceResult.artifact.artifactId,
      ),
    ).toMatchObject({
      reason: 'metadata-mismatch',
      state: 'unresolved',
    });

    const staleMixdownPreparation = prepareProjectMixdown(
      mixdownBaseProject,
      staleSourceDescriptors,
      staleRestorationResult.restoration,
      'mixdown-operation-00000000-0000-4000-8000-000000000001',
    );

    expect(staleMixdownPreparation).toMatchObject({
      canPrepare: false,
      cause: 'playback-plan-unavailable',
    });
    expect(mixdownBaseProject).toEqual(mixdownBaseSnapshot);
    expect(
      (mixdownBaseProject.artifacts ?? []).some(
        (artifact) =>
          artifact.kind === 'audio' && artifact.destination === 'mixdown',
      ),
    ).toBe(false);
    expect(
      mixdownBaseProject.tracks.some((track) =>
        track.clips.some((clip) => clip.type === 'mixdown'),
      ),
    ).toBe(false);
    expect(await listProjectDirectory(projectRoot, 'mixdowns')).toEqual(
      mixdownFilesBeforeRejection,
    );
    expect(firstRuntime.aceStepWorkers).toHaveLength(1);
    expect(firstRuntime.basicPitchWorkers).toHaveLength(1);
    expect(firstRuntime.instrumentRenders).toHaveLength(1);
    expect(firstRuntime.stableAudio3Workers).toHaveLength(1);

    const jobsAfterStaleMixdown = await firstRuntime.client.getJobs();

    if (!jobsAfterStaleMixdown.ok) {
      throw new Error(jobsAfterStaleMixdown.message);
    }

    expect(jobsAfterStaleMixdown.snapshot.jobs).toEqual(
      jobsAfterAce.snapshot.jobs,
    );
    for (const artifact of [
      instrumentArtifact,
      stableAudio3Artifact,
      aceResult.artifact,
    ]) {
      await expect(
        access(join(projectRoot, ...artifact.file.relativePath.split('/'))),
      ).resolves.toBeUndefined();
    }

    const restorationResult =
      await firstRuntime.client.restoreSources(sourceDescriptors);

    if (!restorationResult.ok) {
      throw new Error(restorationResult.message);
    }

    expect(restorationResult.restoration.sources).toHaveLength(
      sourceDescriptors.length,
    );
    expect(
      restorationResult.restoration.sources.every(
        (source) => source.state === 'available',
      ),
    ).toBe(true);
    expect(restorationResult.restoration.availability).toEqual(
      Object.fromEntries(
        sourceDescriptors.map((descriptor) => [
          descriptor.sourceId,
          'available',
        ]),
      ),
    );

    const mixdownPreparation = prepareProjectMixdown(
      mixdownBaseProject,
      sourceDescriptors,
      restorationResult.restoration,
      'mixdown-operation-00000000-0000-4000-8000-000000000002',
    );

    if (!mixdownPreparation.canPrepare) {
      throw new Error(mixdownPreparation.message);
    }

    expect(mixdownPreparation).toMatchObject({
      canPrepare: true,
      request: {
        operationId:
          'mixdown-operation-00000000-0000-4000-8000-000000000002',
      },
      summary: {
        outputClipName: 'Raw Mix 01',
      },
    });
    expect(Object.isFrozen(mixdownPreparation.plan)).toBe(true);
    expect(Object.isFrozen(mixdownPreparation.request)).toBe(true);
    expect(Object.isFrozen(mixdownPreparation.intent)).toBe(true);
    expect(mixdownPreparation.plan.purpose).toBe('mixdown');
    expect(mixdownPreparation.plan.startTick).toBe(0);
    expect(mixdownPreparation.plan.durationSeconds).toBeGreaterThan(0);

    const plannedEvents = mixdownPreparation.plan.tracks.flatMap(
      (track) => track.events,
    );
    const plannedSourceIds = unique(
      plannedEvents.map((event) => event.sourceId),
    );
    const plannedClipIds = unique(plannedEvents.map((event) => event.clipId));
    const plannedTrackIds = mixdownPreparation.plan.tracks.map(
      (track) => track.trackId,
    );

    expect(plannedSourceIds).toContain(aceResult.artifact.artifactId);
    expect(mixdownPreparation.plan.sources.map((source) => source.sourceId)).toEqual(
      plannedSourceIds,
    );
    expect(new Set(plannedTrackIds).size).toBe(plannedTrackIds.length);
    expect(
      mixdownPreparation.plan.mixerSnapshot.channels.map(
        (channel) => channel.trackId,
      ),
    ).toEqual(
      mixdownBaseProject.mixer.channels.map((channel) => channel.trackId),
    );
    expect(mixdownPreparation.plan.mixerSnapshot.master).toEqual(
      mixdownBaseProject.mixer.master,
    );
    expect(mixdownPreparation.plan.masterFaderDb).toBe(
      mixdownBaseProject.mixer.master.faderDb,
    );
    expect(plannedTrackIds).not.toContain(mixdownPreparation.intent.output.trackId);
    expect(plannedClipIds).not.toContain(mixdownPreparation.intent.output.clipId);

    let currentMixdownProject = mixdownBaseProject;
    const mixdownCommand = Object.freeze({
      getCurrentProject: () => currentMixdownProject,
      intent: mixdownPreparation.intent,
      request: mixdownPreparation.request,
    });
    const mixdownResult = await runProjectMixdownRequest(
      firstRuntime.client,
      mixdownCommand,
    );

    if (!mixdownResult.ok) {
      throw new Error(`${mixdownResult.status}: ${mixdownResult.message}`);
    }

    expect(mixdownResult).toMatchObject({
      artifact: {
        destination: 'mixdown',
        kind: 'audio',
        mixdownProvenance: {
          operationProtocolVersion: mixdownPreparation.request.protocolVersion,
          planVersion: mixdownPreparation.plan.version,
          schemaVersion: 2,
        },
        sourceOperationId: mixdownPreparation.request.operationId,
      },
      clipTake: {
        mediaType: 'audio',
        sourceOperationId: mixdownPreparation.request.operationId,
        sourceType: 'mixdown',
      },
      ok: true,
      operation: {
        operationId: mixdownPreparation.request.operationId,
        result: { status: 'COMPLETED' },
      },
      status: 'MIXDOWN_REGISTERED',
    });
    expect(mixdownResult.baseProject).toBe(mixdownBaseProject);
    expect(mixdownResult.operation.operationId).toBe(
      mixdownPreparation.request.operationId,
    );
    expect(mixdownResult.request).toBe(mixdownPreparation.request);
    expect(mixdownResult.intent).toBe(mixdownPreparation.intent);
    expect(mixdownResult.artifact.audio).toEqual({
      bitsPerSample: mixdownResult.operation.result.mixdown.bitsPerSample,
      channels: mixdownResult.operation.result.mixdown.channels,
      durationSeconds: mixdownResult.operation.result.mixdown.durationSeconds,
      frameCount: mixdownResult.operation.result.mixdown.frameCount,
      mimeType: mixdownResult.operation.result.mixdown.mimeType,
      sampleRate: mixdownResult.operation.result.mixdown.sampleRate,
    });
    expect(mixdownResult.artifact.mixdownProvenance.canonicalPlanJson).toBe(
      createCanonicalProjectMixdownPlanJson(mixdownPreparation.plan),
    );
    expect(mixdownResult.artifact.mixdownProvenance.inputTrackIds).toEqual(
      plannedTrackIds,
    );
    expect(mixdownResult.artifact.mixdownProvenance.inputClipIds).toEqual(
      plannedClipIds,
    );
    expect(mixdownResult.artifact.mixdownProvenance.inputSourceIds).toEqual(
      plannedSourceIds,
    );
    expect(new Set(mixdownResult.artifact.lineage.parentArtifactIds)).toEqual(
      new Set(plannedSourceIds),
    );

    const rawMixTrack = requireTrackByClipId(
      mixdownResult.project,
      mixdownPreparation.intent.output.clipId,
    );
    const rawMixClip = requireClip(
      mixdownResult.project,
      mixdownPreparation.intent.output.clipId,
    );

    expect(rawMixTrack).toMatchObject({
      id: mixdownPreparation.intent.output.trackId,
      muted: true,
      name: 'Raw Mix 01',
      type: 'audio',
    });
    expect(rawMixClip).toMatchObject({
      activeClipTakeId: mixdownResult.clipTake.clipTakeId,
      clipTakes: [mixdownResult.clipTake],
      id: mixdownPreparation.intent.output.clipId,
      type: 'mixdown',
    });
    expect(
      mixdownResult.project.tracks.slice(0, mixdownBaseProject.tracks.length),
    ).toEqual(mixdownBaseProject.tracks);
    expect(
      (mixdownResult.project.artifacts ?? []).slice(
        0,
        mixdownBaseProject.artifacts?.length ?? 0,
      ),
    ).toEqual(mixdownBaseProject.artifacts);
    assertUniqueProjectIdentities(mixdownResult.project);

    const rawMixPath = join(
      projectRoot,
      ...mixdownResult.artifact.file.relativePath.split('/'),
    );
    await expect(access(rawMixPath)).resolves.toBeUndefined();
    const rawMixStatBeforeRetry = await stat(rawMixPath);
    const mixdownFilesAfterFirstRun = await listProjectDirectory(
      projectRoot,
      'mixdowns',
    );

    expect(mixdownFilesAfterFirstRun).toEqual([
      mixdownResult.artifact.file.name,
    ]);

    currentMixdownProject = mixdownResult.project;
    const repeatedMixdown = await runProjectMixdownRequest(
      firstRuntime.client,
      mixdownCommand,
    );

    if (!repeatedMixdown.ok) {
      throw new Error(`${repeatedMixdown.status}: ${repeatedMixdown.message}`);
    }

    expect(repeatedMixdown).toMatchObject({
      artifact: { artifactId: mixdownResult.artifact.artifactId },
      clipTake: { clipTakeId: mixdownResult.clipTake.clipTakeId },
      operation: { operationId: mixdownResult.operation.operationId },
      project: mixdownResult.project,
      status: 'MIXDOWN_ALREADY_REGISTERED',
    });
    expect(repeatedMixdown.project).toBe(mixdownResult.project);
    expect(await listProjectDirectory(projectRoot, 'mixdowns')).toEqual(
      mixdownFilesAfterFirstRun,
    );
    const rawMixStatAfterRetry = await stat(rawMixPath);
    expect(rawMixStatAfterRetry.size).toBe(rawMixStatBeforeRetry.size);
    expect(rawMixStatAfterRetry.mtimeMs).toBe(rawMixStatBeforeRetry.mtimeMs);

    const rawMixSource = {
      kind: 'generated',
      name: mixdownResult.artifact.file.name,
      relativePath: mixdownResult.artifact.file.relativePath,
      sizeBytes: mixdownResult.artifact.file.sizeBytes,
      sourceId: mixdownResult.artifact.artifactId,
    };
    const rawMixAvailability =
      await firstRuntime.client.checkGeneratedAudioAvailability([rawMixSource]);

    expect(rawMixAvailability).toMatchObject({
      availableSourceIds: [mixdownResult.artifact.artifactId],
      ok: true,
    });

    const jobsAfterMixdown = await firstRuntime.client.getJobs();

    if (!jobsAfterMixdown.ok) {
      throw new Error(jobsAfterMixdown.message);
    }

    expect(jobsAfterMixdown.snapshot.jobs).toEqual(jobsAfterAce.snapshot.jobs);

    const allFinalGeneratedAudioSources = [
      ...allGeneratedAudioSources,
      rawMixSource,
    ];

    const finalProjectFile = {
      ...projectFile,
      savedAt: acceptanceTimestamp(2),
      workspace: { project: mixdownResult.project },
    };
    const finalSave = await firstRuntime.client.saveProjectFile(finalProjectFile);

    expect(finalSave).toMatchObject({ ok: true });
    if (!finalSave.ok) {
      throw new Error(finalSave.message);
    }
    await expect(access(finalSave.savedProject.projectFilePath)).resolves.toBeUndefined();

    await firstRuntime.engine.close();
    runningEngines.delete(firstRuntime.engine);

    const recoveredRuntime = await startRuntime(projectRoot);

    await expect(
      recoveredRuntime.client.selectProjectRoot(),
    ).resolves.toMatchObject({ ok: true, selection: 'SELECTED' });
    const loaded = await recoveredRuntime.client.loadProjectFile();

    if (!loaded.ok) {
      throw new Error(loaded.message);
    }

    const recoveredProject = loaded.loadedProject.projectFile.workspace.project;

    expect(recoveredProject).toEqual(clone(mixdownResult.project));
    assertUniqueProjectIdentities(recoveredProject);
    expect(recoveredProject.takes).toEqual([
      expect.objectContaining({
        autoPatchProduction: expect.objectContaining({
          generatedArtifactIds: expect.arrayContaining([
            instrumentArtifact.artifactId,
            stableAudio3Artifact.artifactId,
          ]),
          resultStatus: 'COMPLETED',
          runId: preparation.coordinator.runId,
        }),
        id: 'history-v01-vertical-acceptance',
      }),
    ]);

    const recoveredRecordingArtifact = requireArtifact(
      recoveredProject,
      recordingRegistration.artifact.artifactId,
      'audio',
    );
    const recoveredBasicPitchArtifact = requireArtifact(
      recoveredProject,
      midiRegistration.artifact.artifactId,
      'midi',
    );
    expect(recoveredBasicPitchArtifact.lineage).toEqual({
      parentArtifactIds: [recoveredRecordingArtifact.artifactId],
      parentClipTakeIds: [recordingRegistration.clipTake.clipTakeId],
    });

    const recoveredAvailability =
      await recoveredRuntime.client.checkGeneratedAudioAvailability(
        allFinalGeneratedAudioSources,
      );
    expect(recoveredAvailability).toMatchObject({ ok: true });
    if (!recoveredAvailability.ok) {
      throw new Error(recoveredAvailability.message);
    }
    expect(new Set(recoveredAvailability.availableSourceIds)).toEqual(
      new Set([
        ...aceAvailability.availableSourceIds,
        mixdownResult.artifact.artifactId,
      ]),
    );

    const recoveredVocalClip = requireClip(
      recoveredProject,
      vocalFixture.targetClip.id,
    );
    expect(recoveredVocalClip.activeClipTakeId).toBe(
      aceResult.clipTake.clipTakeId,
    );
    expect(recoveredVocalClip.clipTakes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: aceResult.artifact.artifactId,
          clipTakeId: aceResult.clipTake.clipTakeId,
          sourceJobId: aceResult.job.jobId,
          sourceType: 'job',
        }),
      ]),
    );
    expect(
      requireArtifact(
        recoveredProject,
        aceResult.artifact.artifactId,
        'audio',
      ),
    ).toEqual(aceResult.artifact);
    expect(
      resolveAceStepVocalTarget(recoveredProject, recoveredVocalClip.id),
    ).toMatchObject({
      canResolve: true,
      guideClipId: guideClip.id,
      midiClipId,
      targetClipId: recoveredVocalClip.id,
    });

    const recoveredRawMixClip = requireClip(
      recoveredProject,
      mixdownPreparation.intent.output.clipId,
    );
    const recoveredRawMixArtifact = requireArtifact(
      recoveredProject,
      mixdownResult.artifact.artifactId,
      'audio',
    );

    expect(recoveredRawMixClip).toEqual(rawMixClip);
    expect(recoveredRawMixArtifact).toEqual(mixdownResult.artifact);
    expect(recoveredProject.mixer).toEqual(mixdownResult.project.mixer);

    const sa3MasterPatchTab = requireProjectPatchTab(
      recoveredProject,
      'stable-audio-3',
    );
    const sa3MasterDispatch = createSa3MasterDispatch(
      recoveredRawMixArtifact,
      recoveredRawMixClip,
      sa3MasterPatchTab.id,
    );
    const sa3MasterAdapterPlan = createStableAudio3StageAdapterPlan(
      sa3MasterDispatch,
      recoveredProject,
      createStableAudio3RuntimeProfile(),
    );

    expect(sa3MasterAdapterPlan).toMatchObject({
      canPlan: true,
      plan: {
        request: {
          inputArtifacts: [
            {
              artifactId: mixdownResult.artifact.artifactId,
              kind: 'audio',
            },
          ],
        },
        sourceClipId: recoveredRawMixClip.id,
      },
    });
    if (!sa3MasterAdapterPlan.canPlan) {
      throw new Error(sa3MasterAdapterPlan.message);
    }
    expect(Object.isFrozen(sa3MasterAdapterPlan.plan)).toBe(true);
    expect(sa3MasterAdapterPlan.plan.request).toMatchObject({
      inputArtifacts: [
        {
          artifactId: recoveredRawMixArtifact.artifactId,
          kind: 'audio',
          relativePath: recoveredRawMixArtifact.file.relativePath,
        },
      ],
      lineage: {
        parentArtifactIds: [recoveredRawMixArtifact.artifactId],
        parentClipTakeIds: [mixdownResult.clipTake.clipTakeId],
      },
      modelId: STABLE_AUDIO_3_MODEL_ID,
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      output: { destination: 'stable-audio-3' },
      parameters: {
        durationSeconds: recoveredRawMixArtifact.audio.durationSeconds,
        prompt: 'Polished cohesive master with preserved song structure',
        seed: 91,
        strength: 0.4,
      },
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      taskId: STABLE_AUDIO_3_TASK_ID,
    });

    const sa3MasterContinuation =
      resolveStableAudio3AudioToAudioContinuation(
        recoveredProject,
        sa3MasterPatchTab,
        sa3MasterDispatch,
      );

    expect(sa3MasterContinuation).toMatchObject({
      ok: true,
      plan: {
        outputTarget: {
          kind: 'new',
          clipId: 'sa3-master-clip-attempt-v01-sa3-master-next',
          trackId: 'sa3-master-track-attempt-v01-sa3-master-next',
        },
        sourceClipId: recoveredRawMixClip.id,
        sourceClipTakeId: mixdownResult.clipTake.clipTakeId,
      },
    });
    if (!sa3MasterContinuation.ok) {
      throw new Error(sa3MasterContinuation.message);
    }

    const jobsBeforeSa3Master = await recoveredRuntime.client.getJobs();
    if (!jobsBeforeSa3Master.ok) {
      throw new Error(jobsBeforeSa3Master.message);
    }
    expect(jobsBeforeSa3Master.snapshot.jobs).toEqual([]);
    expect(jobsAfterAce.snapshot.jobs).toHaveLength(4);
    expect(new Set(jobsAfterAce.snapshot.jobs.map((job) => job.jobId)).size).toBe(4);
    expect(jobsAfterAce.snapshot.jobs.every((job) => job.state === 'COMPLETED')).toBe(true);

    const stableAudio3FilesBeforeRejection = await listProjectDirectory(
      projectRoot,
      'renders/stable-audio-3',
    );
    const projectBeforeSa3MasterRejection = clone(recoveredProject);
    const staleSa3MasterProject = clone(recoveredProject);
    const staleRawMixClip = requireClip(
      staleSa3MasterProject,
      recoveredRawMixClip.id,
    );
    staleRawMixClip.activeClipTakeId = 'stale-raw-mix-active-take';
    const staleSa3MasterPatchTab = requireProjectPatchTab(
      staleSa3MasterProject,
      sa3MasterPatchTab.id,
    );
    const staleContinuation = resolveStableAudio3AudioToAudioContinuation(
      staleSa3MasterProject,
      staleSa3MasterPatchTab,
      sa3MasterDispatch,
    );
    const staleAdapter = createStableAudio3StageAdapterPlan(
      sa3MasterDispatch,
      staleSa3MasterProject,
      createStableAudio3RuntimeProfile(),
    );

    expect(staleContinuation).toMatchObject({
      cause: 'stable-audio-3-a2a-source-stale',
      ok: false,
    });
    expect(staleAdapter).toMatchObject({
      canPlan: false,
      reason: 'source-audio-unavailable',
    });
    expect(recoveredProject).toEqual(projectBeforeSa3MasterRejection);
    expect(
      await listProjectDirectory(projectRoot, 'renders/stable-audio-3'),
    ).toEqual(stableAudio3FilesBeforeRejection);
    expect(recoveredRuntime.stableAudio3Workers).toHaveLength(0);
    expect(recoveredRuntime.generatedArtifactFinalizer.getActiveReservationCount()).toBe(0);
    const jobsAfterSa3MasterRejection = await recoveredRuntime.client.getJobs();
    if (!jobsAfterSa3MasterRejection.ok) {
      throw new Error(jobsAfterSa3MasterRejection.message);
    }
    expect(jobsAfterSa3MasterRejection.snapshot.jobs).toEqual(
      jobsBeforeSa3Master.snapshot.jobs,
    );
    for (const source of allFinalGeneratedAudioSources) {
      await expect(
        access(join(projectRoot, ...source.relativePath.split('/'))),
      ).resolves.toBeUndefined();
    }

    const sa3MasterResult = await runStableAudio3AudioToAudioBatch(
      recoveredRuntime.client,
      recoveredProject,
      sa3MasterDispatch,
      sa3MasterContinuation.plan,
      createStableAudio3RuntimeProfile(),
      {
        label: 'SA3 Master Take 01',
        resultId: 'result-v01-sa3-master',
        runner: createFastRunnerOptions(),
      },
    );

    if (!sa3MasterResult.ok) {
      throw new Error(`${sa3MasterResult.cause}: ${sa3MasterResult.message}`);
    }

    expect(sa3MasterResult).toMatchObject({
      outputClipId: 'sa3-master-clip-attempt-v01-sa3-master-next',
      result: {
        fingerprint: sa3MasterDispatch.fingerprint,
        resultId: 'result-v01-sa3-master',
        scope: sa3MasterDispatch.scope,
        state: 'COMPLETED',
      },
      status: 'STAGE_COMPLETED',
    });
    expect(sa3MasterResult.plans).toHaveLength(1);
    expect(sa3MasterResult.plans[0]).toEqual(sa3MasterAdapterPlan.plan);
    expect(sa3MasterResult.jobs).toHaveLength(1);
    expect(sa3MasterResult.artifacts).toHaveLength(1);
    expect(sa3MasterResult.clipTakes).toHaveLength(1);

    const sa3MasterJob = sa3MasterResult.jobs[0];
    const sa3MasterArtifact = sa3MasterResult.artifacts[0];
    const sa3MasterTake = sa3MasterResult.clipTakes[0];
    const sa3MasterClip = requireClip(
      sa3MasterResult.project,
      sa3MasterResult.outputClipId,
    );
    const sa3MasterTrack = requireTrackByClipId(
      sa3MasterResult.project,
      sa3MasterResult.outputClipId,
    );

    expect(sa3MasterJob).toMatchObject({
      modelId: STABLE_AUDIO_3_MODEL_ID,
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      request: sa3MasterAdapterPlan.plan.request,
      state: 'COMPLETED',
      taskId: STABLE_AUDIO_3_TASK_ID,
    });
    expect(sa3MasterArtifact).toMatchObject({
      artifactId: sa3MasterJob.result.artifact.artifactId,
      audio: {
        channels: STABLE_AUDIO_3_CHANNELS,
        durationSeconds: recoveredRawMixArtifact.audio.durationSeconds,
        mimeType: 'audio/wav',
      },
      destination: 'stable-audio-3',
      lineage: {
        parentArtifactIds: [recoveredRawMixArtifact.artifactId],
        parentClipTakeIds: [mixdownResult.clipTake.clipTakeId],
      },
      provenance: {
        modelId: STABLE_AUDIO_3_MODEL_ID,
        modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
        providerId: STABLE_AUDIO_3_PROVIDER_ID,
        seed: 91,
        taskId: STABLE_AUDIO_3_TASK_ID,
      },
      sourceJobId: sa3MasterJob.jobId,
    });
    expect(sa3MasterTake).toMatchObject({
      artifactId: sa3MasterArtifact.artifactId,
      label: 'SA3 Master Take 01',
      mediaType: 'audio',
      sourceJobId: sa3MasterJob.jobId,
      sourceType: 'job',
    });
    expect(sa3MasterTrack).toMatchObject({
      id: 'sa3-master-track-attempt-v01-sa3-master-next',
      muted: true,
      name: 'SA3 Master',
      type: 'audio',
    });
    expect(sa3MasterClip).toMatchObject({
      activeClipTakeId: sa3MasterTake.clipTakeId,
      clipTakes: [sa3MasterTake],
      id: 'sa3-master-clip-attempt-v01-sa3-master-next',
      name: 'SA3 Master',
      sourceClipId: recoveredRawMixClip.id,
      type: 'master',
    });
    expect(
      requireClip(sa3MasterResult.project, recoveredRawMixClip.id),
    ).toEqual(recoveredRawMixClip);
    expect(
      requireTrackByClipId(sa3MasterResult.project, recoveredRawMixClip.id),
    ).toEqual(requireTrackByClipId(recoveredProject, recoveredRawMixClip.id));
    expect(
      requireArtifact(
        sa3MasterResult.project,
        recoveredRawMixArtifact.artifactId,
        'audio',
      ),
    ).toEqual(recoveredRawMixArtifact);
    expect(
      (sa3MasterResult.project.artifacts ?? []).slice(
        0,
        recoveredProject.artifacts?.length ?? 0,
      ),
    ).toEqual(recoveredProject.artifacts);
    expect(
      sa3MasterResult.project.tracks.slice(0, recoveredProject.tracks.length),
    ).toEqual(recoveredProject.tracks);
    expect(
      requireProjectPatchTab(
        sa3MasterResult.project,
        sa3MasterPatchTab.id,
      ).generationContinuation,
    ).toMatchObject({
      kind: 'stable-audio-3-audio-to-audio',
      outputClipId: sa3MasterClip.id,
      sourceClipId: recoveredRawMixClip.id,
      sourceClipTakeId: mixdownResult.clipTake.clipTakeId,
    });
    expect(sa3MasterResult.project.tabFlowStageResults).toEqual(
      expect.arrayContaining([sa3MasterResult.result]),
    );
    assertUniqueProjectIdentities(sa3MasterResult.project);

    expect(recoveredRuntime.stableAudio3Workers).toHaveLength(1);
    expect(recoveredRuntime.stableAudio3Workers[0].calls).toEqual([
      'start',
      'load',
      'execute',
      'unload',
      'close',
    ]);
    expect(recoveredRuntime.stableAudio3Workers[0].jobs).toHaveLength(1);
    expect(recoveredRuntime.stableAudio3Workers[0].jobs[0]).toMatchObject({
      inputArtifacts: [
        {
          artifactId: recoveredRawMixArtifact.artifactId,
          kind: 'audio',
        },
      ],
      parameters: sa3MasterAdapterPlan.plan.request.parameters,
      taskId: STABLE_AUDIO_3_TASK_ID,
    });
    expect(
      (
        await realpath(
          recoveredRuntime.stableAudio3Workers[0].jobs[0].inputArtifacts[0]
            .path,
        )
      ).toLowerCase(),
    ).toBe((await realpath(rawMixPath)).toLowerCase());
    expect(recoveredRuntime.basicPitchWorkers).toHaveLength(0);
    expect(recoveredRuntime.aceStepWorkers).toHaveLength(0);
    expect(recoveredRuntime.instrumentRenders).toHaveLength(0);
    expect(recoveredRuntime.generatedArtifactFinalizer.getActiveReservationCount()).toBe(0);

    const jobsAfterSa3Master = await recoveredRuntime.client.getJobs();
    if (!jobsAfterSa3Master.ok) {
      throw new Error(jobsAfterSa3Master.message);
    }
    expect(jobsAfterSa3Master.snapshot.jobs).toHaveLength(1);
    expect(jobsAfterSa3Master.snapshot.jobs.every((job) => job.state === 'COMPLETED')).toBe(true);
    expect(
      jobsAfterSa3Master.snapshot.jobs.filter(
        (job) => job.jobId === sa3MasterJob.jobId,
      ),
    ).toEqual([sa3MasterJob]);
    const allExternalGenerationJobs = [
      ...jobsAfterAce.snapshot.jobs,
      ...jobsAfterSa3Master.snapshot.jobs,
    ];
    expect(allExternalGenerationJobs).toHaveLength(5);
    expect(new Set(allExternalGenerationJobs.map((job) => job.jobId)).size).toBe(5);
    expect(allExternalGenerationJobs.every((job) => job.state === 'COMPLETED')).toBe(true);

    const sa3MasterPath = join(
      projectRoot,
      ...sa3MasterArtifact.file.relativePath.split('/'),
    );
    const sa3MasterBytes = await readFile(sa3MasterPath);
    const sa3MasterStat = await stat(sa3MasterPath);
    expect(sa3MasterStat.size).toBe(sa3MasterArtifact.file.sizeBytes);
    expect(sa3MasterBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(sa3MasterBytes.readUInt16LE(22)).toBe(
      HUMSTUDIO_AUDIO_FORMAT.channels,
    );
    expect(sa3MasterBytes.readUInt32LE(24)).toBe(
      HUMSTUDIO_AUDIO_FORMAT.sampleRate,
    );
    expect(sa3MasterJob.result.generation).toMatchObject({
      bytesWritten: sa3MasterBytes.length,
      channels: HUMSTUDIO_AUDIO_FORMAT.channels,
      durationSeconds: recoveredRawMixArtifact.audio.durationSeconds,
      evidence: {
        inputArtifactId: recoveredRawMixArtifact.artifactId,
        inputSizeBytes: recoveredRawMixArtifact.file.sizeBytes,
        outputSha256: sha256(sa3MasterBytes),
      },
      mimeType: 'audio/wav',
    });
    const sa3MasterWorkerJob = recoveredRuntime.stableAudio3Workers[0].jobs[0];
    expect(sa3MasterWorkerJob.output.stagingPath).not.toBe(sa3MasterPath);
    await expect(access(sa3MasterWorkerJob.output.stagingPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await listProjectDirectory(projectRoot, 'renders/stable-audio-3'),
    ).toEqual(
      [...stableAudio3FilesBeforeRejection, sa3MasterArtifact.file.name].sort(),
    );

    const sa3MasterSource = {
      kind: 'generated',
      name: sa3MasterArtifact.file.name,
      relativePath: sa3MasterArtifact.file.relativePath,
      sizeBytes: sa3MasterArtifact.file.sizeBytes,
      sourceId: sa3MasterArtifact.artifactId,
    };
    const finalGeneratedAudioSources = [
      ...allFinalGeneratedAudioSources,
      sa3MasterSource,
    ];
    const sa3MasterAvailability =
      await recoveredRuntime.client.checkGeneratedAudioAvailability(
        finalGeneratedAudioSources,
      );
    expect(sa3MasterAvailability).toMatchObject({ ok: true });
    if (!sa3MasterAvailability.ok) {
      throw new Error(sa3MasterAvailability.message);
    }
    expect(new Set(sa3MasterAvailability.availableSourceIds)).toEqual(
      new Set(finalGeneratedAudioSources.map((source) => source.sourceId)),
    );

    const sa3MasterProjectFile = {
      ...projectFile,
      savedAt: acceptanceTimestamp(62),
      workspace: { project: sa3MasterResult.project },
    };
    const sa3MasterSave =
      await recoveredRuntime.client.saveProjectFile(sa3MasterProjectFile);
    if (!sa3MasterSave.ok) {
      throw new Error(sa3MasterSave.message);
    }
    await expect(
      access(sa3MasterSave.savedProject.projectFilePath),
    ).resolves.toBeUndefined();

    await recoveredRuntime.engine.close();
    runningEngines.delete(recoveredRuntime.engine);

    const finalRuntime = await startRuntime(projectRoot);
    await expect(finalRuntime.client.selectProjectRoot()).resolves.toMatchObject({
      ok: true,
      selection: 'SELECTED',
    });
    const finalLoad = await finalRuntime.client.loadProjectFile();
    if (!finalLoad.ok) {
      throw new Error(finalLoad.message);
    }
    const finalRecoveredProject =
      finalLoad.loadedProject.projectFile.workspace.project;

    expect(finalRecoveredProject).toEqual(clone(sa3MasterResult.project));
    assertUniqueProjectIdentities(finalRecoveredProject);
    expect(
      requireArtifact(
        finalRecoveredProject,
        sa3MasterArtifact.artifactId,
        'audio',
      ),
    ).toEqual(sa3MasterArtifact);
    expect(
      requireClip(finalRecoveredProject, sa3MasterClip.id),
    ).toEqual(sa3MasterClip);
    expect(
      requireTrackByClipId(finalRecoveredProject, sa3MasterClip.id),
    ).toEqual(sa3MasterTrack);
    expect(
      requireClip(finalRecoveredProject, recoveredRawMixClip.id),
    ).toEqual(recoveredRawMixClip);
    expect(
      requireArtifact(
        finalRecoveredProject,
        recoveredRawMixArtifact.artifactId,
        'audio',
      ),
    ).toEqual(recoveredRawMixArtifact);
    expect(
      requireProjectPatchTab(
        finalRecoveredProject,
        sa3MasterPatchTab.id,
      ).generationContinuation,
    ).toEqual(
      requireProjectPatchTab(
        sa3MasterResult.project,
        sa3MasterPatchTab.id,
      ).generationContinuation,
    );
    expect(finalRecoveredProject.tabFlowStageResults).toEqual(
      expect.arrayContaining([sa3MasterResult.result]),
    );

    const finalAvailability =
      await finalRuntime.client.checkGeneratedAudioAvailability(
        finalGeneratedAudioSources,
      );
    expect(finalAvailability).toMatchObject({ ok: true });
    if (!finalAvailability.ok) {
      throw new Error(finalAvailability.message);
    }
    expect(new Set(finalAvailability.availableSourceIds)).toEqual(
      new Set(finalGeneratedAudioSources.map((source) => source.sourceId)),
    );

    const finalSourceDescriptors = collectProjectSourceRestorationDescriptors(
      finalRecoveredProject,
    );
    const finalSourceRestoration =
      await finalRuntime.client.restoreSources(finalSourceDescriptors);
    if (!finalSourceRestoration.ok) {
      throw new Error(finalSourceRestoration.message);
    }
    expect(
      Object.values(finalSourceRestoration.restoration.availability).every(
        (state) => state === 'available',
      ),
    ).toBe(true);
    const availableFinalProject = applyProjectSourceRestoration(
      finalRecoveredProject,
      finalSourceDescriptors,
      finalSourceRestoration.restoration,
    );

    const finalJobs = await finalRuntime.client.getJobs();
    if (!finalJobs.ok) {
      throw new Error(finalJobs.message);
    }
    expect(finalJobs.snapshot.jobs).toEqual([]);
    const recoveredSourceJobIds = (finalRecoveredProject.artifacts ?? [])
      .flatMap((artifact) =>
        'sourceJobId' in artifact ? [artifact.sourceJobId] : [],
      );
    expect(new Set(recoveredSourceJobIds)).toEqual(
      new Set(allExternalGenerationJobs.map((job) => job.jobId)),
    );

    const finalFilerTarget = resolveFinalFilerExportTarget(
      availableFinalProject,
      sa3MasterClip.id,
    );
    if (!finalFilerTarget.canExport) {
      throw new Error(`${finalFilerTarget.cause}: ${finalFilerTarget.message}`);
    }
    expect(finalFilerTarget).toMatchObject({
      canExport: true,
      exportTarget: {
        descriptor: {
          relativePath: sa3MasterArtifact.file.relativePath,
          sizeBytes: sa3MasterArtifact.file.sizeBytes,
          sourceId: sa3MasterArtifact.artifactId,
        },
        format: 'WAV',
        target: {
          kind: 'stable-audio-3-master',
          rawMixdown: {
            artifactId: recoveredRawMixArtifact.artifactId,
            clipTakeId: mixdownResult.clipTake.clipTakeId,
          },
        },
      },
    });

    const selectedFinalProject = Object.freeze({
      ...availableFinalProject,
      selection: Object.freeze({
        items: Object.freeze([
          Object.freeze({ id: sa3MasterClip.id, type: 'clip' }),
        ]),
      }),
    });
    const finalFilerAvailability = resolveFinalFilerAvailability(
      selectedFinalProject,
    );

    expect(finalFilerAvailability).toMatchObject({
      canExport: true,
      fileName: finalFilerTarget.exportTarget.fileName,
      selectedClipId: sa3MasterClip.id,
      source: 'Stable Audio 3 Master',
      target: finalFilerTarget.exportTarget,
    });
    if (!finalFilerAvailability.canExport) {
      throw new Error(finalFilerAvailability.message);
    }

    const finalFilerBuildIdentity = Object.freeze({
      gitCommit: '42dc03bd09c173e1864e01c1e5a196aee60e8683',
      version: '0.1.0',
    });
    const finalFilerExportedAtUtc = acceptanceTimestamp(110);
    const finalFilerProjectBefore = clone(selectedFinalProject);
    const finalFilerFingerprintBefore =
      createProjectDirtyStateFingerprint(selectedFinalProject);
    const savedProjectPath = sa3MasterSave.savedProject.projectFilePath;
    const savedProjectBytesBefore = await readFile(savedProjectPath);
    const savedProjectStatBefore = await stat(savedProjectPath);
    const projectFilesBeforeFinalFiler = await snapshotProjectFiles(projectRoot);
    const physicalSa3MasterBytes = await readFile(sa3MasterPath);
    let currentFinalFilerProject = selectedFinalProject;

    const interruptedBrowser = createFinalFilerBrowserHarness();
    const interruptedPayloads = [];
    const interruptedController = new FinalFilerController({
      createOperationId: () => 'final-filer:v01-interrupted',
      downloadFiles: (files) => {
        interruptedPayloads.push(files);
        downloadFinalFilerFilesInBrowser(
          files,
          interruptedBrowser.environment,
        );
      },
    });
    let interruptedRead;
    const interruptedResult = await interruptedController.run({
      buildIdentity: finalFilerBuildIdentity,
      exportedAtUtc: finalFilerExportedAtUtc,
      fileName: finalFilerAvailability.fileName,
      getProject: () => currentFinalFilerProject,
      includeSourceReport: true,
      readGeneratedAudio: async (descriptor, signal) => {
        interruptedRead = await finalRuntime.client.readGeneratedAudioWav(
          descriptor,
          { signal },
        );
        if (interruptedRead.ok) {
          currentFinalFilerProject = Object.freeze({
            ...selectedFinalProject,
            selection: Object.freeze({ items: Object.freeze([]) }),
          });
        }
        return interruptedRead;
      },
    });

    expect(interruptedRead).toMatchObject({ ok: true });
    expect(interruptedResult).toMatchObject({
      downloadCount: 0,
      message: 'EXPORT INTERRUPTED',
      operationId: 'final-filer:v01-interrupted',
      status: 'interrupted',
    });
    expect(interruptedController.isBusy).toBe(false);
    expect(interruptedPayloads).toEqual([]);
    expect(interruptedBrowser.objectUrls).toEqual([]);
    expect(interruptedBrowser.anchors).toEqual([]);
    expect(interruptedBrowser.cleanups).toEqual([]);
    expect(selectedFinalProject).toEqual(finalFilerProjectBefore);

    currentFinalFilerProject = selectedFinalProject;
    const successBrowser = createFinalFilerBrowserHarness();
    const successPayloads = [];
    const successController = new FinalFilerController({
      createOperationId: () => 'final-filer:v01-success',
      downloadFiles: (files) => {
        successPayloads.push(files);
        downloadFinalFilerFilesInBrowser(files, successBrowser.environment);
      },
    });
    let releaseSuccessfulRead;
    const successfulReadGate = new Promise((resolve) => {
      releaseSuccessfulRead = resolve;
    });
    let signalSuccessfulReadReady;
    const successfulReadReady = new Promise((resolve) => {
      signalSuccessfulReadReady = resolve;
    });
    let successfulRead;
    let successfulReadDescriptor;
    let successfulReadSignal;
    const successfulRun = successController.run({
      buildIdentity: finalFilerBuildIdentity,
      exportedAtUtc: finalFilerExportedAtUtc,
      fileName: finalFilerAvailability.fileName,
      getProject: () => currentFinalFilerProject,
      includeSourceReport: true,
      readGeneratedAudio: async (descriptor, signal) => {
        successfulReadDescriptor = descriptor;
        successfulReadSignal = signal;
        successfulRead = await finalRuntime.client.readGeneratedAudioWav(
          descriptor,
          { signal },
        );
        signalSuccessfulReadReady();
        await successfulReadGate;
        return successfulRead;
      },
    });

    await successfulReadReady;
    expect(successfulRead).toMatchObject({ ok: true });
    expect(successfulReadDescriptor).toEqual(finalFilerAvailability.target.descriptor);
    expect(successfulReadSignal).toBeInstanceOf(AbortSignal);
    expect(successfulReadSignal.aborted).toBe(false);
    expect(successController.isBusy).toBe(true);
    expect(successController.activeSnapshot).toMatchObject({
      descriptor: finalFilerAvailability.target.descriptor,
      exportedAtUtc: finalFilerExportedAtUtc,
      fileName: finalFilerAvailability.fileName,
      includeSourceReport: true,
      operationId: 'final-filer:v01-success',
      projectFingerprint: finalFilerAvailability.target.projectFingerprint,
      selectedClipId: sa3MasterClip.id,
      target: finalFilerAvailability.target,
    });
    expect(Object.isFrozen(successController.activeSnapshot)).toBe(true);
    expect(Object.isFrozen(successController.activeSnapshot.descriptor)).toBe(true);
    expect(Object.isFrozen(successController.activeSnapshot.target)).toBe(true);
    releaseSuccessfulRead();

    const successfulResult = await successfulRun;
    expect(successfulResult).toEqual({
      detail:
        'The verified WAV and Source Report were sent to the browser download destination.',
      downloadCount: 2,
      message: 'EXPORT COMPLETE',
      operationId: 'final-filer:v01-success',
      status: 'success',
    });
    expect(successController.isBusy).toBe(false);
    expect(successController.activeSnapshot).toBeUndefined();
    expect(successPayloads).toHaveLength(1);
    expect(Object.isFrozen(successPayloads[0])).toBe(true);
    expect(successPayloads[0]).toHaveLength(2);

    const [wavDownload, reportDownload] = successPayloads[0];
    expect(wavDownload).toMatchObject({
      fileName: finalFilerAvailability.fileName,
      kind: 'wav',
    });
    expect(reportDownload).toMatchObject({
      fileName: `${finalFilerAvailability.fileName.slice(0, -4)}-source-report.txt`,
      kind: 'source-report',
    });
    expect(wavDownload.blob).toBe(successfulRead.wav);
    expect(wavDownload.blob.type).toBe('audio/wav');
    expect(wavDownload.blob.size).toBe(physicalSa3MasterBytes.length);
    expect(
      Buffer.from(await wavDownload.blob.arrayBuffer()).equals(
        physicalSa3MasterBytes,
      ),
    ).toBe(true);
    expect(physicalSa3MasterBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(physicalSa3MasterBytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(reportDownload.blob.type).toBe('text/plain;charset=utf-8');

    const finalWavMetadata = await parseFinalFilerWavMetadata(
      wavDownload.blob,
    );
    const finalMediaSha256 = await sha256Blob(wavDownload.blob);
    expect(finalWavMetadata).toEqual({
      bitsPerSample: 16,
      channels: STABLE_AUDIO_3_CHANNELS,
      dataBytes: physicalSa3MasterBytes.length - 44,
      durationSeconds: recoveredRawMixArtifact.audio.durationSeconds,
      frameCount:
        (physicalSa3MasterBytes.length - 44) /
        (HUMSTUDIO_AUDIO_FORMAT.channels * 2),
      sampleRate: HUMSTUDIO_AUDIO_FORMAT.sampleRate,
    });
    expect(finalMediaSha256).toBe(sha256(physicalSa3MasterBytes));

    const sourceReportText = await reportDownload.blob.text();
    const expectedSa3Parameters = JSON.stringify(
      Object.fromEntries(
        Object.entries(sa3MasterArtifact.provenance.parameters).sort(
          ([left], [right]) => left.localeCompare(right),
        ),
      ),
    );
    expect(sourceReportText.startsWith('ElpisDAW FINAL FILER Source Report\n')).toBe(true);
    expect(sourceReportText).toContain('Report Format: 1');
    expect(sourceReportText).toContain(
      `Exported At UTC: ${finalFilerExportedAtUtc}`,
    );
    expect(sourceReportText).toContain('ElpisDAW Version: 0.1.0');
    expect(sourceReportText).toContain(
      'Git Commit: 42dc03bd09c173e1864e01c1e5a196aee60e8683',
    );
    expect(sourceReportText).toContain(
      'Final Source Class: Stable Audio 3 Master',
    );
    expect(sourceReportText).toContain(
      `Artifact ID: ${sa3MasterArtifact.artifactId}`,
    );
    expect(sourceReportText).toContain(`Clip ID: ${sa3MasterClip.id}`);
    expect(sourceReportText).toContain(
      `Clip Take ID: ${sa3MasterTake.clipTakeId}`,
    );
    expect(sourceReportText).toContain(`Job ID: ${sa3MasterJob.jobId}`);
    expect(sourceReportText).toContain(
      `Parent Raw Mix Artifact ID: ${recoveredRawMixArtifact.artifactId}`,
    );
    expect(sourceReportText).toContain(
      `Parent Raw Mix Clip ID: ${recoveredRawMixClip.id}`,
    );
    expect(sourceReportText).toContain(
      `Parent Raw Mix Clip Take ID: ${mixdownResult.clipTake.clipTakeId}`,
    );
    expect(sourceReportText).toContain(
      `Parent Raw Mix Operation ID: ${recoveredRawMixArtifact.sourceOperationId}`,
    );
    expect(sourceReportText).toContain(
      `Renderer ID: ${recoveredRawMixArtifact.mixdownProvenance.rendererId}`,
    );
    expect(sourceReportText).toContain(
      `Renderer Version: ${recoveredRawMixArtifact.mixdownProvenance.rendererVersion}`,
    );
    expect(sourceReportText).toContain(
      `Stable Audio 3 Provider: ${STABLE_AUDIO_3_PROVIDER_ID}`,
    );
    expect(sourceReportText).toContain(
      `Stable Audio 3 Model: ${STABLE_AUDIO_3_MODEL_ID}`,
    );
    expect(sourceReportText).toContain(
      `Stable Audio 3 Revision: ${STABLE_AUDIO_3_MODEL_REVISION}`,
    );
    expect(sourceReportText).toContain(
      `Stable Audio 3 Task: ${STABLE_AUDIO_3_TASK_ID}`,
    );
    expect(sourceReportText).toContain('Stable Audio 3 Seed: 91');
    expect(sourceReportText).toContain(
      `Stable Audio 3 Parameters: ${expectedSa3Parameters}`,
    );
    expect(sourceReportText).toContain(
      `WAV Channels: ${finalWavMetadata.channels}`,
    );
    expect(sourceReportText).toContain(
      `WAV Sample Rate: ${finalWavMetadata.sampleRate}`,
    );
    expect(sourceReportText).toContain(
      `WAV Bits Per Sample: ${finalWavMetadata.bitsPerSample}`,
    );
    expect(sourceReportText).toContain(
      `WAV Frame Count: ${finalWavMetadata.frameCount}`,
    );
    expect(sourceReportText).toContain(
      `WAV Data Bytes: ${finalWavMetadata.dataBytes}`,
    );
    expect(sourceReportText).toContain(
      `WAV Media SHA-256: ${finalMediaSha256}`,
    );
    expect(sourceReportText).toContain(
      `WAV Duration Seconds: ${finalWavMetadata.durationSeconds}`,
    );
    expect(sourceReportText).not.toContain('\uFFFD');
    const integrityPrefix = 'Integrity Hash: SHA-256 ';
    const integrityOffset = sourceReportText.lastIndexOf(integrityPrefix);
    expect(integrityOffset).toBeGreaterThan(0);
    const sourceReportBody = sourceReportText.slice(0, integrityOffset);
    const integritySha256 = sourceReportText
      .slice(integrityOffset + integrityPrefix.length)
      .trim();
    expect(integritySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(integritySha256).toBe(await sha256Text(sourceReportBody));
    expect(sourceReportText.toLowerCase()).not.toContain(
      projectRoot.toLowerCase(),
    );
    expect(sourceReportText).not.toContain(launchToken);
    expect(sourceReportText).not.toContain(wrongLaunchToken);
    expect(sourceReportText).not.toMatch(
      /(?:bearer\s+[a-z0-9._~-]+|token=|secret=|password=)/i,
    );

    expect(successBrowser.objectUrls).toEqual([
      'blob:final-filer-1',
      'blob:final-filer-2',
    ]);
    expect(successBrowser.blobs).toEqual([
      wavDownload.blob,
      reportDownload.blob,
    ]);
    expect(successBrowser.anchors).toHaveLength(2);
    expect(successBrowser.anchors.map((anchor) => anchor.download)).toEqual([
      wavDownload.fileName,
      reportDownload.fileName,
    ]);
    expect(successBrowser.anchors.map((anchor) => anchor.href)).toEqual(
      successBrowser.objectUrls,
    );
    expect(successBrowser.anchors.every((anchor) => anchor.hidden)).toBe(true);
    expect(successBrowser.anchors.map((anchor) => anchor.clickCount)).toEqual([
      1,
      1,
    ]);
    expect(successBrowser.anchors.map((anchor) => anchor.removeCount)).toEqual([
      1,
      1,
    ]);
    expect(successBrowser.appendedAnchors).toEqual(successBrowser.anchors);
    expect(successBrowser.cleanups).toHaveLength(2);
    expect(successBrowser.revokedObjectUrls).toEqual([]);
    successBrowser.runCleanups();
    expect(successBrowser.cleanups).toEqual([]);
    expect(successBrowser.revokedObjectUrls).toEqual(
      successBrowser.objectUrls,
    );

    expect(currentFinalFilerProject).toBe(selectedFinalProject);
    expect(selectedFinalProject).toEqual(finalFilerProjectBefore);
    expect(createProjectDirtyStateFingerprint(selectedFinalProject)).toBe(
      finalFilerFingerprintBefore,
    );
    expect(selectedFinalProject.selection).toEqual({
      items: [{ id: sa3MasterClip.id, type: 'clip' }],
    });
    expect(await readFile(savedProjectPath)).toEqual(savedProjectBytesBefore);
    const savedProjectStatAfter = await stat(savedProjectPath);
    expect(savedProjectStatAfter.size).toBe(savedProjectStatBefore.size);
    expect(savedProjectStatAfter.mtimeMs).toBe(savedProjectStatBefore.mtimeMs);
    expect(await snapshotProjectFiles(projectRoot)).toEqual(
      projectFilesBeforeFinalFiler,
    );
    const jobsAfterFinalFiler = await finalRuntime.client.getJobs();
    if (!jobsAfterFinalFiler.ok) {
      throw new Error(jobsAfterFinalFiler.message);
    }
    expect(jobsAfterFinalFiler.snapshot).toEqual(finalJobs.snapshot);
    expect(finalRuntime.basicPitchWorkers).toHaveLength(0);
    expect(finalRuntime.aceStepWorkers).toHaveLength(0);
    expect(finalRuntime.stableAudio3Workers).toHaveLength(0);
    expect(finalRuntime.instrumentRenders).toHaveLength(0);
    expect(
      finalRuntime.generatedArtifactFinalizer.getActiveReservationCount(),
    ).toBe(0);
  });
});

async function startRuntime(projectRoot) {
  const projectRootAuthority = new ProjectRootAuthority();
  const generatedArtifactFinalizer = new GeneratedArtifactFinalizer({
    projectRootAuthority,
  });
  const aceStepWorkers = [];
  const basicPitchWorkers = [];
  const stableAudio3Workers = [];
  const instrumentRenders = [];
  const aceStepJobExecutor = new AceStepJobExecutor({
    createWorkerClient: () => {
      const worker = new SuccessfulAceStepWorkerClient();
      aceStepWorkers.push(worker);
      return worker;
    },
    generatedArtifactFinalizer,
    projectRootAuthority,
  });
  const basicPitchJobExecutor = new BasicPitchJobExecutor({
    createWorkerClient: () => {
      const worker = new SuccessfulBasicPitchWorkerClient();
      basicPitchWorkers.push(worker);
      return worker;
    },
    projectRootAuthority,
  });
  const fluidSynthJobExecutor = new FluidSynthJobExecutor({
    generatedArtifactFinalizer,
    soundFontAuditionService: {
      render: async (request, options) => {
        instrumentRenders.push({ options, request });
        const bytes = createPcmWav({
          channels: 2,
          durationSeconds: 10,
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
    createWorkerClient: () => {
      const worker = new SuccessfulStableAudio3WorkerClient();
      stableAudio3Workers.push(worker);
      return worker;
    },
    generatedArtifactFinalizer,
    projectRootAuthority,
  });
  const engine = await startLocalEngineServer({
    aceStepJobExecutor,
    basicPitchJobExecutor,
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
    aceStepWorkers,
    basicPitchWorkers,
    client: new LocalEngineClient({
      baseUrl: engine.baseUrl,
      token: launchToken,
    }),
    engine,
    generatedArtifactFinalizer,
    instrumentRenders,
    stableAudio3Workers,
  };
}

class SuccessfulBasicPitchWorkerClient {
  calls = [];

  async start() {
    this.calls.push('start');
  }

  async loadModel() {
    this.calls.push('load');
  }

  async execute(job) {
    this.calls.push('execute');
    return {
      artifact: {
        bpm: job.parameters.projectBpm,
        kind: 'midi',
        notes: [
          {
            confidence: 0.96,
            id: 'note-v01-basic-pitch-a4',
            lengthTicks: 960,
            pitch: 69,
            startTick: 0,
            velocity: 112,
          },
          {
            confidence: 0.91,
            id: 'note-v01-basic-pitch-c5',
            lengthTicks: 480,
            pitch: 72,
            startTick: 960,
            velocity: 104,
          },
        ],
        ticksPerQuarter: job.parameters.ticksPerQuarter,
      },
      completedAt: '2026-08-17T08:30:01.000Z',
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
    this.calls.push('terminate');
  }
}

class SuccessfulAceStepWorkerClient {
  calls = [];

  async start() {
    this.calls.push('start');
  }

  async loadModel() {
    this.calls.push('load');
  }

  async execute(job) {
    this.calls.push('execute');
    const wav = createPcmWav({
      channels: ACE_STEP_CHANNELS,
      durationSeconds: job.parameters.durationSeconds,
      sampleRate: ACE_STEP_SAMPLE_RATE,
    });
    await writeFile(job.output.stagingPath, wav);
    return {
      artifact: {
        bytesWritten: wav.length,
        channels: ACE_STEP_CHANNELS,
        durationSeconds: job.parameters.durationSeconds,
        mimeType: 'audio/wav',
        sampleRate: ACE_STEP_SAMPLE_RATE,
        sha256: sha256(wav),
        stagingPath: job.output.stagingPath,
      },
      completedAt: '2026-08-17T08:30:08.000Z',
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

class SuccessfulStableAudio3WorkerClient {
  calls = [];
  jobs = [];

  async start() {
    this.calls.push('start');
  }

  async loadModel() {
    this.calls.push('load');
  }

  async execute(job) {
    this.calls.push('execute');
    this.jobs.push(job);
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
      completedAt: '2026-08-17T08:30:05.000Z',
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

function createBasicPitchRequest(recordingArtifact, recordingTake) {
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
      sourceEndSeconds: recordingArtifact.audio.durationSeconds,
      sourceStartSeconds: 0,
      ticksPerQuarter: 960,
    },
    providerId: BASIC_PITCH_PROVIDER_ID,
    taskId: BASIC_PITCH_TASK_ID,
  };
}

async function waitForCompletedJob(client, jobId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await client.getJobs();

    if (!result.ok) {
      throw new Error(result.message);
    }

    const job = result.snapshot.jobs.find(
      (candidate) => candidate.jobId === jobId,
    );

    if (job?.state === 'COMPLETED') {
      return job;
    }

    if (job?.state === 'FAILED') {
      throw new Error(job.error?.message ?? 'GPU Job failed without an error.');
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`GPU Job ${jobId} did not complete.`);
}

function createIdentityServices() {
  const indexes = new Map();

  return Object.freeze({
    allocateId: (kind) => {
      const index = (indexes.get(kind) ?? 0) + 1;
      indexes.set(kind, index);
      return `${kind}-v01-vertical-${index}`;
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

function createAceStageInput(
  project,
  { guideClipId, midiClipId, targetClipId },
) {
  return {
    caption: 'Clear close vocal following the deterministic guide melody',
    guideClipId,
    label: 'ACE Vertical Vocal Take',
    lyrics: '[Verse]\nOne project carries every line\nThe guide and voice remain aligned',
    midiClipId,
    project,
    seed: 1_370_421,
    targetClipId,
    vocalLanguage: 'en',
  };
}

function createSa3MasterDispatch(artifact, clip, patchTabId) {
  const activeTake = (clip.clipTakes ?? []).find(
    (take) => take.clipTakeId === clip.activeClipTakeId,
  );

  if (!activeTake || activeTake.artifactId !== artifact.artifactId) {
    throw new Error('Raw Mixdown requires one exact Active Take for SA3 planning.');
  }

  return Object.freeze({
    attemptId: 'attempt-v01-sa3-master-next',
    execution: Object.freeze({
      modelId: STABLE_AUDIO_3_MODEL_ID,
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      taskId: STABLE_AUDIO_3_TASK_ID,
    }),
    fingerprint: 'fingerprint-v01-sa3-master-next',
    parameters: Object.freeze({
      durationSeconds: artifact.audio.durationSeconds,
      prompt: 'Polished cohesive master with preserved song structure',
      seed: 91,
      strength: 0.4,
      takes: 1,
    }),
    runId: 'run-v01-sa3-master-next',
    scope: Object.freeze({
      familyId: 'family-v01-sa3-master-next',
      familyRevision: 1,
      stageId: patchTabId,
      targetClipId: clip.id,
    }),
    source: Object.freeze({
      artifactId: artifact.artifactId,
      clipId: clip.id,
      clipTakeId: activeTake.clipTakeId,
    }),
    startedAt: '2026-08-17T08:31:00.000Z',
  });
}

function createStableAudio3RuntimeProfile() {
  return Object.freeze({
    model: Object.freeze({
      compatibility: 'PARTIAL_SUPPORT',
      modelId: STABLE_AUDIO_3_MODEL_ID,
      revision: STABLE_AUDIO_3_MODEL_REVISION,
    }),
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    providerVersion: '0.1.0',
    runtime: Object.freeze({
      compatibility: 'COMPATIBLE',
      profileId: 'windows-target-verified-test',
    }),
    supportsCancellation: true,
    taskId: STABLE_AUDIO_3_TASK_ID,
  });
}

function addExistingVocalTarget(project, guideClipId, recordingArtifact) {
  const guideClip = requireClip(project, guideClipId);
  const targetClipId = 'clip-v01-vocal-target';
  const existingTake = {
    artifactId: recordingArtifact.artifactId,
    clipTakeId: 'clip-take-v01-existing-vocal',
    createdAt: recordingArtifact.createdAt,
    label: 'Existing Vocal Take',
    mediaType: 'audio',
    sourceType: 'recording',
  };
  const targetClip = {
    activeClipTakeId: existingTake.clipTakeId,
    audioTiming: {
      sourceEndSeconds: recordingArtifact.audio.durationSeconds,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    },
    clipTakes: [existingTake],
    color: '#d8899b',
    createdAt: '2026-08-17T08:30:07.000Z',
    id: targetClipId,
    lengthTicks: guideClip.lengthTicks,
    name: 'Vocal Target',
    sourceClipId: guideClipId,
    sourceFile: {
      checkedAt: recordingArtifact.createdAt,
      durationSeconds: recordingArtifact.audio.durationSeconds,
      mimeType: recordingArtifact.audio.mimeType,
      name: recordingArtifact.file.name,
      relativePath: recordingArtifact.file.relativePath,
      sizeBytes: recordingArtifact.file.sizeBytes,
      sourceId: recordingArtifact.artifactId,
      status: 'available',
    },
    startTick: guideClip.startTick,
    type: 'vocal-audio',
    version: 1,
  };
  const locations = project.tracks
    .map((track, trackIndex) => ({ track, trackIndex }))
    .filter(({ track }) => track.clips.some((clip) => clip.id === guideClipId));

  if (
    locations.length !== 1 ||
    project.tracks.some((track) =>
      track.clips.some((clip) => clip.id === targetClipId),
    )
  ) {
    throw new Error('Vertical acceptance Vocal target identity is ambiguous.');
  }

  return {
    existingTake,
    project: {
      ...project,
      tracks: project.tracks.map((track, trackIndex) =>
        trackIndex === locations[0].trackIndex
          ? { ...track, clips: [...track.clips, targetClip] }
          : track,
      ),
    },
    targetClip,
  };
}

function replaceClip(project, replacement) {
  const matches = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => clip.id === replacement.id),
  );

  if (matches.length !== 1) {
    throw new Error(`Expected one Clip ${replacement.id} for replacement.`);
  }

  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.id === replacement.id ? replacement : clip,
      ),
    })),
  };
}

function requireClip(project, clipId) {
  const clips = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => clip.id === clipId),
  );

  if (clips.length !== 1) {
    throw new Error(`Expected one Clip ${clipId}.`);
  }

  return clips[0];
}

function requireClipByTakeId(project, clipTakeId) {
  const clips = project.tracks.flatMap((track) =>
    track.clips.filter((clip) =>
      (clip.clipTakes ?? []).some(
        (take) => take.clipTakeId === clipTakeId,
      ),
    ),
  );

  if (clips.length !== 1) {
    throw new Error(`Expected one Clip containing Take ${clipTakeId}.`);
  }

  return clips[0];
}

function requireTrackByClipId(project, clipId) {
  const tracks = project.tracks.filter((track) =>
    track.clips.some((clip) => clip.id === clipId),
  );

  if (tracks.length !== 1) {
    throw new Error(`Expected one Track containing Clip ${clipId}.`);
  }

  return tracks[0];
}

function requireProjectPatchTab(project, patchTabId) {
  const patchTabs = project.patchTabs.filter(
    (patchTab) => patchTab.id === patchTabId,
  );

  if (patchTabs.length !== 1) {
    throw new Error(`Expected one Project PatchTab ${patchTabId}.`);
  }

  return patchTabs[0];
}

function unique(values) {
  return [...new Set(values)];
}

async function listProjectDirectory(projectRoot, relativePath) {
  try {
    return (await readdir(join(projectRoot, ...relativePath.split('/')))).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function requireSelectedClipId(project) {
  const selected = project.selection.items;

  if (selected.length !== 1 || selected[0].type !== 'clip') {
    throw new Error('Vertical acceptance Project requires one selected MIDI Clip.');
  }

  return selected[0].id;
}

function requireStageResult(project, stageId) {
  const results = (project.tabFlowStageResults ?? []).filter(
    (candidate) => candidate.scope.stageId === stageId,
  );

  if (results.length !== 1) {
    throw new Error(`Expected one ${stageId} Stage Result.`);
  }

  return results[0];
}

function requireArtifact(project, artifactId, kind) {
  const artifacts = (project.artifacts ?? []).filter(
    (candidate) => candidate.artifactId === artifactId,
  );

  if (artifacts.length !== 1 || artifacts[0].kind !== kind) {
    throw new Error(`Expected one ${kind} Artifact ${artifactId}.`);
  }

  return artifacts[0];
}

function assertUniqueProjectIdentities(project) {
  const trackIds = project.tracks.map((track) => track.id);
  const clipIds = project.tracks.flatMap((track) =>
    track.clips.map((clip) => clip.id),
  );
  const artifactIds = (project.artifacts ?? []).map(
    (artifact) => artifact.artifactId,
  );
  const clipTakeIds = project.tracks.flatMap((track) =>
    track.clips.flatMap((clip) =>
      (clip.clipTakes ?? []).map((take) => take.clipTakeId),
    ),
  );
  const stageResultIds = (project.tabFlowStageResults ?? []).map(
    (stageResult) => stageResult.resultId,
  );
  const historyIds = project.takes.map((take) => take.id);

  expect(new Set(trackIds).size).toBe(trackIds.length);
  expect(new Set(clipIds).size).toBe(clipIds.length);
  expect(new Set(artifactIds).size).toBe(artifactIds.length);
  expect(new Set(clipTakeIds).size).toBe(clipTakeIds.length);
  expect(new Set(stageResultIds).size).toBe(stageResultIds.length);
  expect(new Set(historyIds).size).toBe(historyIds.length);

  for (const result of project.tabFlowStageResults ?? []) {
    for (const artifactId of result.outputArtifactIds) {
      expect(artifactIds.filter((id) => id === artifactId)).toHaveLength(1);
    }
    for (const clipTakeId of result.outputClipTakeIds) {
      expect(clipTakeIds.filter((id) => id === clipTakeId)).toHaveLength(1);
    }
  }
}

function createPcmWavBlob({ durationSeconds, sampleRate = 8_000 }) {
  return new Blob(
    [createPcmWav({ channels: 1, durationSeconds, sampleRate })],
    { type: 'audio/wav' },
  );
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFinalFilerBrowserHarness() {
  const anchors = [];
  const appendedAnchors = [];
  const blobs = [];
  const cleanups = [];
  const objectUrls = [];
  const revokedObjectUrls = [];
  const environment = Object.freeze({
    appendAnchor: (anchor) => {
      appendedAnchors.push(anchor);
    },
    createAnchor: () => {
      const anchor = {
        clickCount: 0,
        download: '',
        hidden: false,
        href: '',
        removeCount: 0,
        click() {
          this.clickCount += 1;
        },
        remove() {
          this.removeCount += 1;
        },
      };
      anchors.push(anchor);
      return anchor;
    },
    createObjectUrl: (blob) => {
      blobs.push(blob);
      const objectUrl = `blob:final-filer-${objectUrls.length + 1}`;
      objectUrls.push(objectUrl);
      return objectUrl;
    },
    revokeObjectUrl: (objectUrl) => {
      revokedObjectUrls.push(objectUrl);
    },
    scheduleCleanup: (cleanup) => {
      cleanups.push(cleanup);
    },
  });

  return {
    anchors,
    appendedAnchors,
    blobs,
    cleanups,
    environment,
    objectUrls,
    revokedObjectUrls,
    runCleanups: () => {
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
    },
  };
}

async function snapshotProjectFiles(projectRoot) {
  const files = [];

  async function visit(relativeDirectory) {
    const directory = join(projectRoot, ...relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = [...relativeDirectory, entry.name];
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile()) {
        const metadata = await stat(join(projectRoot, ...relativePath));
        files.push({
          mtimeMs: metadata.mtimeMs,
          relativePath: relativePath.join('/'),
          size: metadata.size,
        });
      }
    }
  }

  await visit([]);
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(
    join(tmpdir(), 'humstudio-v01-vertical-acceptance-'),
  );
  temporaryDirectories.add(directory);
  return directory;
}
