import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GeneratedArtifactFinalizer } from '../generatedArtifactFinalizer.mjs';
import { ProjectRootAuthority } from '../projectRootAuthority.mjs';
import {
  ACE_STEP_COVER_TASK_ID,
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_RUNTIME_PROFILE_ID,
  ACE_STEP_TASK_ID,
  ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
} from '../../shared/aceStepProtocol.js';
import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../../shared/stableAudio3Protocol.js';
import { GpuJobQueue } from './gpuJobQueue.mjs';
import {
  AceStepJobExecutor,
  AceStepJobExecutorError,
} from './aceStepJobExecutor.mjs';

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

describe('AceStepJobExecutor', () => {
  it('validates immutable Guide Audio, Lyrics, and corrected MIDI lineage', async () => {
    const { executor } = await createReadyExecutor();
    const request = executor.validateRequest(createRequest());

    expect(request).toMatchObject({
      guideSource: {
        artifactId: 'artifact-guide-a',
        clipTakeId: 'clip-take-midi-a',
        kind: 'midi-instrument-guide',
      },
      inputArtifacts: [
        {
          artifactId: 'artifact-guide-a',
          kind: 'audio',
          relativePath: 'renders/instruments/artifact-guide-a.wav',
          sizeBytes: 1_920_044,
        },
        {
          artifactId: 'artifact-lyrics-a',
          kind: 'lyrics',
          relativePath: 'renders/ace-step/lyrics/artifact-lyrics-a.txt',
        },
      ],
      lineage: {
        parentArtifactIds: ['artifact-guide-a', 'artifact-lyrics-a'],
        parentClipTakeIds: ['clip-take-midi-a'],
      },
      modelId: ACE_STEP_MODEL_ID,
      modelRevision: ACE_STEP_MODEL_REVISION,
      output: {
        artifactKind: 'audio',
        destination: ACE_STEP_OUTPUT_DESTINATION,
        extension: '.wav',
      },
      providerId: ACE_STEP_PROVIDER_ID,
      taskId: ACE_STEP_TASK_ID,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.inputArtifacts)).toBe(true);
    expect(Object.isFrozen(request.lineage.parentArtifactIds)).toBe(true);
    expect(Object.isFrozen(request.parameters)).toBe(true);
    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        inputArtifacts: [
          createRequest().inputArtifacts[0],
          {
            artifactId: 'artifact-lyrics-a',
            kind: 'lyrics',
            relativePath: 'renders/ace-step/../outside.txt',
          },
        ],
      }),
    ).toThrow('renders/ace-step/lyrics');
    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        lineage: {
          parentArtifactIds: ['artifact-lyrics-a', 'artifact-guide-a'],
          parentClipTakeIds: ['clip-take-midi-a'],
        },
      }),
    ).toThrow('exact Guide source Artifact');
  });

  it('accepts only the exact SA3 T2A Guide source shape and allowlisted path', async () => {
    const { executor } = await createReadyExecutor();
    const request = createTextToAudioGuideRequest();

    expect(executor.validateRequest(request)).toMatchObject({
      guideSource: {
        artifactId: 'artifact-sa3-t2a-a',
        clipTakeId: 'clip-take-sa3-t2a-a',
        kind: 'stable-audio-3-text-to-audio',
        modelId: STABLE_AUDIO_3_MODEL_ID,
        modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
        providerId: STABLE_AUDIO_3_PROVIDER_ID,
        taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
      },
      inputArtifacts: [
        {
          artifactId: 'artifact-sa3-t2a-a',
          kind: 'audio',
          relativePath:
            'renders/stable-audio-3/artifact-sa3-t2a-a.wav',
          sizeBytes: 1_920_044,
        },
        {
          artifactId: 'artifact-lyrics-a',
          kind: 'lyrics',
          relativePath: 'renders/ace-step/lyrics/artifact-lyrics-a.txt',
        },
      ],
      lineage: { parentClipTakeIds: ['clip-take-sa3-t2a-a'] },
    });
    expect(() =>
      executor.validateRequest({
        ...request,
        guideSource: { ...request.guideSource, unexpected: true },
      }),
    ).toThrow('SA3 Text-to-Audio Guide source is invalid');
    expect(() =>
      executor.validateRequest({
        ...request,
        inputArtifacts: [
          {
            ...request.inputArtifacts[0],
            relativePath: 'renders/instruments/artifact-sa3-t2a-a.wav',
          },
          request.inputArtifacts[1],
        ],
      }),
    ).toThrow('exact source role');
    expect(() =>
      executor.validateRequest({
        ...request,
        guideSource: {
          ...request.guideSource,
          taskId: 'audio-to-audio',
        },
      }),
    ).toThrow('SA3 Text-to-Audio Guide source is invalid');

    const dangerousGuideSource = { ...request.guideSource };
    Object.defineProperty(dangerousGuideSource, '__proto__', {
      enumerable: false,
      value: { polluted: true },
    });
    expect(() =>
      executor.validateRequest({ ...request, guideSource: dangerousGuideSource }),
    ).toThrow('SA3 Text-to-Audio Guide source is invalid');
    expect({}.polluted).toBeUndefined();
  });

  it('validates source-free Text to Music with one Lyrics input and 48 kHz output', async () => {
    const { executor } = await createReadyExecutor();
    const request = executor.validateRequest(createTextToMusicRequest());

    expect(request).toMatchObject({
      inputArtifacts: [
        {
          artifactId: 'artifact-lyrics-t2m-a',
          kind: 'lyrics',
          relativePath: 'renders/ace-step/lyrics/artifact-lyrics-t2m-a.txt',
        },
      ],
      lineage: {
        parentArtifactIds: ['artifact-lyrics-t2m-a'],
        parentClipTakeIds: [],
      },
      parameters: {
        channels: 2,
        sampleRate: 48_000,
        taskType: 'text2music',
      },
      taskId: ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
    });
    expect(request).not.toHaveProperty('guideSource');
    expect(() =>
      executor.validateRequest({
        ...createTextToMusicRequest(),
        guideSource: createRequest().guideSource,
      }),
    ).toThrow('exactly the supported Job fields');
    expect(() =>
      executor.validateRequest({
        ...createTextToMusicRequest(),
        parameters: {
          ...createTextToMusicRequest().parameters,
          sampleRate: 44_100,
        },
      }),
    ).toThrow('48000 Hz');
  });

  it('validates Cover against one exact Active Audio Take path and pinned Remix controls', async () => {
    const { executor } = await createReadyExecutor();
    const request = executor.validateRequest(createCoverRequest());

    expect(request).toMatchObject({
      guideSource: {
        artifactId: 'artifact-cover-source-a',
        clipTakeId: 'clip-take-cover-source-a',
        kind: 'active-audio-take',
        relativePath: 'recordings/artifact-cover-source-a.wav',
      },
      parameters: {
        audioCoverStrength: 0.2,
        coverNoiseStrength: 0,
        sampleRate: 48_000,
        taskType: 'cover',
      },
      taskId: ACE_STEP_COVER_TASK_ID,
    });
    expect(() =>
      executor.validateRequest({
        ...createCoverRequest(),
        guideSource: {
          ...createCoverRequest().guideSource,
          relativePath: 'recordings/other.wav',
        },
      }),
    ).toThrow('path does not match');
  });

  it('finalizes one Project Vocal WAV with immutable evidence through Queue', async () => {
    const workerClient = new SuccessfulWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    const inputs = await writeInputs(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();
    const completed = queue.getJob(queued.jobId);
    const files = await readdir(join(rootPath, 'renders', 'ace-step'));

    expect(completed).toMatchObject({
      result: {
        artifact: {
          destination: ACE_STEP_OUTPUT_DESTINATION,
          kind: 'audio',
          lineage: {
            parentArtifactIds: ['artifact-guide-a', 'artifact-lyrics-a'],
            parentClipTakeIds: ['clip-take-midi-a'],
          },
          provenance: {
            modelId: ACE_STEP_MODEL_ID,
            modelRevision: ACE_STEP_MODEL_REVISION,
            providerId: ACE_STEP_PROVIDER_ID,
            seed: 1_370_421,
            taskId: ACE_STEP_TASK_ID,
          },
        },
        generation: {
          channels: 2,
          durationSeconds: 10,
          evidence: {
            guideAudioArtifactId: 'artifact-guide-a',
            cfgIntervalEnd: 1,
            cfgIntervalStart: 0,
            dcwEnabled: false,
            guidanceScale: 8,
            inferenceSteps: 64,
            lyricsArtifactId: 'artifact-lyrics-a',
            modelRevision: ACE_STEP_MODEL_REVISION,
            outputEncoding: 'PCM16',
            runtimeProfileId: ACE_STEP_RUNTIME_PROFILE_ID,
            sampleRate: 48_000,
            shift: 3,
            thinking: false,
            useAdg: true,
          },
          mimeType: 'audio/wav',
          providerCompletedAt: '2026-08-12T12:34:56.000Z',
        },
      },
      state: 'COMPLETED',
    });
    expect(files).toHaveLength(2);
    expect(files).toEqual(
      expect.arrayContaining(['lyrics', completed.result.artifact.file.name]),
    );
    expect(completed.result.artifact.file.name).not.toContain('.partial');

    const finalPath = join(
      rootPath,
      ...completed.result.artifact.file.relativePath.split('/'),
    );
    const finalBytes = await readFile(finalPath);
    const outputSha256 = sha256(finalBytes);

    expect(finalBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(finalBytes.readUInt16LE(20)).toBe(1);
    expect(completed.result.generation.bytesWritten).toBe(finalBytes.length);
    expect(completed.result.generation.evidence.guideAudioSha256).toBe(
      sha256(inputs.guideAudio),
    );
    expect(completed.result.generation.evidence.guideAudioSizeBytes).toBe(
      inputs.guideAudio.length,
    );
    expect(completed.result.generation.evidence.guideAudioArtifactId).toBe(
      'artifact-guide-a',
    );
    expect(completed.result.generation.evidence.guideAudioClipTakeId).toBe(
      'clip-take-midi-a',
    );
    expect(completed.result.generation.evidence.guideAudioRelativePath).toBe(
      'renders/instruments/artifact-guide-a.wav',
    );
    expect(completed.result.generation.evidence.lyricsSha256).toBe(
      sha256(inputs.lyrics),
    );
    expect(completed.result.generation.evidence.lyricsSizeBytes).toBe(
      inputs.lyrics.length,
    );
    expect(completed.result.generation.evidence.outputSha256).toBe(outputSha256);
    expect(workerClient.executedJob.inputArtifacts).toHaveLength(2);
    expect(workerClient.executedJob.inputArtifacts[0].path).toBe(
      join(rootPath, 'renders', 'instruments', 'artifact-guide-a.wav'),
    );
    expect(workerClient.executedJob.inputArtifacts[1].path).toBe(
      join(rootPath, 'renders', 'ace-step', 'lyrics', 'artifact-lyrics-a.txt'),
    );
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('carries exact finalized SA3 Guide identity and file evidence through completion', async () => {
    const workerClient = new SuccessfulWorkerClient();
    const { executor, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    const inputs = await writeInputs(rootPath, {
      guideRelativePath:
        'renders/stable-audio-3/artifact-sa3-t2a-a.wav',
    });
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createTextToAudioGuideRequest());

    await queue.waitForIdle();
    const completed = queue.getJob(queued.jobId);

    expect(completed).toMatchObject({
      result: {
        generation: {
          evidence: {
            guideAudioArtifactId: 'artifact-sa3-t2a-a',
            guideAudioClipTakeId: 'clip-take-sa3-t2a-a',
            guideAudioRelativePath:
              'renders/stable-audio-3/artifact-sa3-t2a-a.wav',
            guideAudioSha256: sha256(inputs.guideAudio),
            guideAudioSizeBytes: inputs.guideAudio.length,
          },
        },
      },
      state: 'COMPLETED',
    });
    expect(workerClient.executedJob.inputArtifacts[0].path).toBe(
      join(
        rootPath,
        'renders',
        'stable-audio-3',
        'artifact-sa3-t2a-a.wav',
      ),
    );
  });

  it('fails before starting a Worker when either Project input is unavailable', async () => {
    const workerClient = new SuccessfulWorkerClient();
    const { executor, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await mkdir(join(rootPath, 'renders', 'ace-step', 'lyrics'), { recursive: true });
    await writeFile(
      join(rootPath, 'renders', 'ace-step', 'lyrics', 'artifact-lyrics-a.txt'),
      '[Verse]\nMissing guide audio',
      'utf8',
    );
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: { code: 'ACE_STEP_INPUT_UNAVAILABLE' },
      state: 'FAILED',
    });
    expect(workerClient.calls).toEqual([]);
    expect(workerClient.terminateCalls).toBe(1);
  });

  it('fails before starting a Worker when Guide Audio size evidence changed', async () => {
    const workerClient = new SuccessfulWorkerClient();
    const { executor, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeInputs(rootPath);

    await expect(
      executor.run(
        {
          ...createRequest(),
          inputArtifacts: [
            { ...createRequest().inputArtifacts[0], sizeBytes: 1_920_045 },
            createRequest().inputArtifacts[1],
          ],
        },
        {
          jobId: 'job-guide-size-mismatch',
          onPhase: () => undefined,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'ACE_STEP_INPUT_INVALID' });

    expect(workerClient.calls).not.toContain('start');
  });

  it('rejects Worker hash mismatch and discards the staged output', async () => {
    const workerClient = new MismatchedHashWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeInputs(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: { code: 'ACE_STEP_STAGING_OUTPUT_CHANGED' },
      state: 'FAILED',
    });
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(listAceStepOutputs(rootPath)).resolves.toEqual([]);
  });

  it('rejects invalid physical WAV output and discards the staged output', async () => {
    const workerClient = new InvalidWaveWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeInputs(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: { code: 'ACE_STEP_STAGING_WAV_INVALID' },
      state: 'FAILED',
    });
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(listAceStepOutputs(rootPath)).resolves.toEqual([]);
  });

  it('rejects generation when Lyrics change after authorization', async () => {
    const workerClient = new MutatingLyricsWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeInputs(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: { code: 'ACE_STEP_INPUT_CHANGED' },
      state: 'FAILED',
    });
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(listAceStepOutputs(rootPath)).resolves.toEqual([]);
  });

  it('discards reservation and internal partial output after Worker failure', async () => {
    const workerClient = new FailingWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeInputs(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: { code: 'ACE_STEP_INFERENCE_FAILED' },
      state: 'FAILED',
    });
    expect(workerClient.terminateCalls).toBe(1);
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(listAceStepOutputs(rootPath)).resolves.toEqual([]);
  });

  it('hard-cancels the exact active ACE Job, cleans staging, and accepts a later Job', async () => {
    const blockingWorker = new BlockingWorkerClient();
    const succeedingWorker = new SuccessfulWorkerClient();
    let workerNumber = 0;
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () =>
        workerNumber++ === 0 ? blockingWorker : succeedingWorker,
    });
    await writeInputs(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const canceled = queue.enqueue(createRequest());
    await blockingWorker.waitUntilStarted();

    await expect(executor.cancel('job-wrong-owner')).rejects.toMatchObject({
      code: 'ACE_STEP_EXECUTOR_JOB_MISMATCH',
    });
    expect(blockingWorker.terminateCalls).toBe(0);

    await queue.requestCancel(canceled.jobId);
    await queue.waitForIdle();

    expect(queue.getJob(canceled.jobId)?.state).toBe('CANCELED');
    expect(blockingWorker.terminateCalls).toBe(1);
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(listAceStepOutputs(rootPath)).resolves.toEqual([]);

    const subsequent = queue.enqueue(createRequest());
    await queue.waitForIdle();

    expect(queue.getJob(subsequent.jobId)?.state).toBe('COMPLETED');
    expect(succeedingWorker.calls).toContain('execute');
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('reports hard-cancel cleanup failure as FAILED without retaining staged output', async () => {
    const workerClient = new CleanupFailingWorkerClient();
    const { executor, finalizer, rootPath } = await createReadyExecutor({
      createWorkerClient: () => workerClient,
    });
    await writeInputs(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const job = queue.enqueue(createRequest());
    await workerClient.waitUntilStarted();

    await expect(queue.requestCancel(job.jobId)).rejects.toMatchObject({
      code: 'ACE_STEP_WORKER_TERMINATION_FAILED',
    });
    await queue.waitForIdle();

    expect(queue.getJob(job.jobId)).toMatchObject({
      error: { code: 'ACE_STEP_WORKER_TERMINATION_FAILED' },
      state: 'FAILED',
    });
    expect(workerClient.terminateCalls).toBe(1);
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(listAceStepOutputs(rootPath)).resolves.toEqual([]);
  });

  it('rejects cancellation during SAVING and preserves the finalized success', async () => {
    let gatedFinalizer;
    const { finalizer, rootPath, executor } = await createReadyExecutor({
      createWorkerClient: () => new SuccessfulWorkerClient(),
      createFinalizer: (baseFinalizer) => {
        gatedFinalizer = new GatedFinalizer(baseFinalizer);
        return gatedFinalizer;
      },
    });
    await writeInputs(rootPath);
    const queue = trackQueue(new GpuJobQueue({ executor }));
    const job = queue.enqueue(createRequest());
    await gatedFinalizer.waitUntilFinalizeStarted();

    expect(queue.getJob(job.jobId)?.state).toBe('SAVING');
    await expect(queue.requestCancel(job.jobId)).rejects.toMatchObject({
      code: 'JOB_CANCEL_TOO_LATE',
    });

    gatedFinalizer.release();
    await queue.waitForIdle();

    expect(queue.getJob(job.jobId)?.state).toBe('COMPLETED');
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(listAceStepOutputs(rootPath)).resolves.toHaveLength(1);
  });

  it('requires explicit Project Root and Artifact finalization authorities', () => {
    expect(
      () =>
        new AceStepJobExecutor({
          generatedArtifactFinalizer: undefined,
          projectRootAuthority: undefined,
        }),
    ).toThrow(TypeError);
    expect(AceStepJobExecutorError.prototype).toBeInstanceOf(Error);
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
    const wav = createFloat32Wav({
      channels: 2,
      durationSeconds: job.parameters.durationSeconds,
      sampleRate: 48_000,
    });
    await writeFile(job.output.stagingPath, wav);
    return createProviderResult(job, wav);
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

class MismatchedHashWorkerClient extends SuccessfulWorkerClient {
  async execute(job) {
    const result = await super.execute(job);
    return {
      ...result,
      artifact: {
        ...result.artifact,
        sha256: '0'.repeat(64),
      },
    };
  }
}

class InvalidWaveWorkerClient extends SuccessfulWorkerClient {
  async execute(job) {
    this.calls.push('execute');
    const invalidBytes = Buffer.alloc(128, 1);
    await writeFile(job.output.stagingPath, invalidBytes);
    return createProviderResult(job, invalidBytes);
  }
}

class MutatingLyricsWorkerClient extends SuccessfulWorkerClient {
  async execute(job) {
    const result = await super.execute(job);
    await writeFile(job.inputArtifacts[1].path, '[Verse]\nChanged lyrics', 'utf8');
    return result;
  }
}

class FailingWorkerClient extends SuccessfulWorkerClient {
  async execute(job) {
    this.calls.push('execute');
    await writeFile(`${job.output.stagingPath}.wav`, 'incomplete', 'utf8');
    throw Object.assign(new Error('ACE-Step inference failed.'), {
      code: 'ACE_STEP_INFERENCE_FAILED',
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
    this.executedJob = job;
    await writeFile(`${job.output.stagingPath}.wav`, 'partial audio', 'utf8');
    this.#resolveStarted();
    this.#execution = new Promise((_, reject) => {
      this.#rejectExecution = reject;
    });
    return this.#execution;
  }

  async terminate() {
    this.terminateCalls += 1;
    this.#rejectExecution?.(
      Object.assign(new Error('ACE-Step Worker was terminated.'), {
        code: 'WORKER_TERMINATED',
      }),
    );
    await this.#execution?.catch(() => undefined);
  }

  waitUntilStarted() {
    return this.#started;
  }
}

class CleanupFailingWorkerClient extends BlockingWorkerClient {
  async terminate() {
    await super.terminate();
    throw Object.assign(new Error('ACE-Step Worker termination failed.'), {
      code: 'ACE_STEP_WORKER_TERMINATION_FAILED',
    });
  }
}

class GatedFinalizer {
  #baseFinalizer;
  #releaseFinalize;
  #resolveFinalizeStarted;
  #finalizeStarted = new Promise((resolve) => {
    this.#resolveFinalizeStarted = resolve;
  });
  #finalizeGate = new Promise((resolve) => {
    this.#releaseFinalize = resolve;
  });

  constructor(baseFinalizer) {
    this.#baseFinalizer = baseFinalizer;
  }

  reserve(options) {
    return this.#baseFinalizer.reserve(options);
  }

  discard(reservationId) {
    return this.#baseFinalizer.discard(reservationId);
  }

  getActiveReservationCount() {
    return this.#baseFinalizer.getActiveReservationCount();
  }

  async finalize(reservationId) {
    this.#resolveFinalizeStarted();
    await this.#finalizeGate;
    return this.#baseFinalizer.finalize(reservationId);
  }

  release() {
    this.#releaseFinalize();
  }

  waitUntilFinalizeStarted() {
    return this.#finalizeStarted;
  }
}

function createProviderResult(job, wav) {
  return {
    artifact: {
      bytesWritten: wav.length,
      channels: 2,
      durationSeconds: job.parameters.durationSeconds,
      mimeType: 'audio/wav',
      sampleRate: 48_000,
      sha256: sha256(wav),
      stagingPath: job.output.stagingPath,
    },
    completedAt: '2026-08-12T12:34:56.000Z',
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

async function createReadyExecutor({ createFinalizer, createWorkerClient } = {}) {
  const selectedPath = await createTemporaryDirectory();
  const authority = new ProjectRootAuthority();
  const projectRoot = await authority.configure(selectedPath);
  const baseFinalizer = new GeneratedArtifactFinalizer({
    projectRootAuthority: authority,
  });
  const finalizer = createFinalizer
    ? createFinalizer(baseFinalizer)
    : baseFinalizer;
  const executor = new AceStepJobExecutor({
    ...(createWorkerClient ? { createWorkerClient } : {}),
    generatedArtifactFinalizer: finalizer,
    projectRootAuthority: authority,
  });
  return { executor, finalizer, rootPath: projectRoot.rootPath };
}

function createRequest() {
  return {
    guideSource: {
      artifactId: 'artifact-guide-a',
      clipTakeId: 'clip-take-midi-a',
      kind: 'midi-instrument-guide',
    },
    inputArtifacts: [
      {
        artifactId: 'artifact-guide-a',
        kind: 'audio',
        relativePath: 'renders/instruments/artifact-guide-a.wav',
        sizeBytes: 1_920_044,
      },
      {
        artifactId: 'artifact-lyrics-a',
        kind: 'lyrics',
        relativePath: 'renders/ace-step/lyrics/artifact-lyrics-a.txt',
      },
    ],
    lineage: {
      parentArtifactIds: ['artifact-guide-a', 'artifact-lyrics-a'],
      parentClipTakeIds: ['clip-take-midi-a'],
    },
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    output: {
      artifactKind: 'audio',
      destination: ACE_STEP_OUTPUT_DESTINATION,
      extension: '.wav',
    },
    parameters: {
      audioFormat: 'wav',
      batchSize: 1,
      caption: 'Warm intimate lead vocal following the corrected melody',
      channels: 2,
      durationSeconds: 10,
      sampleRate: 48_000,
      seed: 1_370_421,
      targetTrack: 'vocals',
      taskType: 'lego',
      thinking: false,
      vocalLanguage: 'en',
    },
    providerId: ACE_STEP_PROVIDER_ID,
    taskId: ACE_STEP_TASK_ID,
  };
}

function createTextToAudioGuideRequest() {
  const request = createRequest();
  return {
    ...request,
    guideSource: {
      artifactId: 'artifact-sa3-t2a-a',
      clipTakeId: 'clip-take-sa3-t2a-a',
      kind: 'stable-audio-3-text-to-audio',
      modelId: STABLE_AUDIO_3_MODEL_ID,
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
    },
    inputArtifacts: [
      {
        artifactId: 'artifact-sa3-t2a-a',
        kind: 'audio',
        relativePath: 'renders/stable-audio-3/artifact-sa3-t2a-a.wav',
        sizeBytes: 1_920_044,
      },
      request.inputArtifacts[1],
    ],
    lineage: {
      parentArtifactIds: [
        'artifact-sa3-t2a-a',
        'artifact-lyrics-a',
      ],
      parentClipTakeIds: ['clip-take-sa3-t2a-a'],
    },
  };
}

function createTextToMusicRequest() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-lyrics-t2m-a',
        kind: 'lyrics',
        relativePath: 'renders/ace-step/lyrics/artifact-lyrics-t2m-a.txt',
      },
    ],
    lineage: {
      parentArtifactIds: ['artifact-lyrics-t2m-a'],
      parentClipTakeIds: [],
    },
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    output: {
      artifactKind: 'audio',
      destination: ACE_STEP_OUTPUT_DESTINATION,
      extension: '.wav',
    },
    parameters: {
      audioFormat: 'wav',
      batchSize: 1,
      bpm: 120,
      caption: 'Dreamy synth pop with a wide chorus',
      channels: 2,
      durationSeconds: 16,
      guidanceScale: 8,
      inferenceSteps: 64,
      instrumental: false,
      keyscale: 'C major',
      sampleRate: 48_000,
      seed: 42,
      taskType: 'text2music',
      thinking: false,
      timesignature: '4/4',
      vocalLanguage: 'ja',
    },
    providerId: ACE_STEP_PROVIDER_ID,
    taskId: ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
  };
}

function createCoverRequest() {
  const request = createRequest();
  return {
    ...request,
    guideSource: {
      artifactId: 'artifact-cover-source-a',
      clipTakeId: 'clip-take-cover-source-a',
      kind: 'active-audio-take',
      relativePath: 'recordings/artifact-cover-source-a.wav',
    },
    inputArtifacts: [
      {
        artifactId: 'artifact-cover-source-a',
        kind: 'audio',
        relativePath: 'recordings/artifact-cover-source-a.wav',
        sizeBytes: 1_920_044,
      },
      request.inputArtifacts[1],
    ],
    lineage: {
      parentArtifactIds: ['artifact-cover-source-a', 'artifact-lyrics-a'],
      parentClipTakeIds: ['clip-take-cover-source-a'],
    },
    parameters: {
      audioCoverStrength: 0.2,
      audioFormat: 'wav',
      batchSize: 1,
      caption: 'Dreamy chamber pop reinterpretation',
      channels: 2,
      coverNoiseStrength: 0,
      durationSeconds: 10,
      guidanceScale: 8,
      inferenceSteps: 64,
      instrumental: false,
      sampleRate: 48_000,
      seed: 42,
      taskType: 'cover',
      thinking: false,
      vocalLanguage: 'ja',
    },
    taskId: ACE_STEP_COVER_TASK_ID,
  };
}

async function writeInputs(
  rootPath,
  {
    guideRelativePath = 'renders/instruments/artifact-guide-a.wav',
  } = {},
) {
  const guideAudio = createPcm16Wav({
    channels: 2,
    durationSeconds: 10,
    sampleRate: 48_000,
  });
  const lyrics = Buffer.from(
    '[Verse]\nMorning light across the room\nA quiet pulse becomes a tune\n',
    'utf8',
  );
  await mkdir(join(rootPath, 'renders', 'ace-step', 'lyrics'), { recursive: true });
  const guidePath = join(rootPath, ...guideRelativePath.split('/'));
  await mkdir(dirname(guidePath), { recursive: true });
  await writeFile(guidePath, guideAudio);
  await writeFile(
    join(rootPath, 'renders', 'ace-step', 'lyrics', 'artifact-lyrics-a.txt'),
    lyrics,
  );
  return { guideAudio, lyrics };
}

async function listAceStepOutputs(rootPath) {
  const entries = await readdir(join(rootPath, 'renders', 'ace-step'));
  return entries.filter((entry) => entry !== 'lyrics');
}

function createPcm16Wav({ channels, durationSeconds, sampleRate }) {
  return createWav({
    bitsPerSample: 16,
    channels,
    durationSeconds,
    formatTag: 1,
    sampleRate,
  });
}

function createFloat32Wav({ channels, durationSeconds, sampleRate }) {
  return createWav({
    bitsPerSample: 32,
    channels,
    durationSeconds,
    formatTag: 3,
    sampleRate,
  });
}

function createWav({
  bitsPerSample,
  channels,
  durationSeconds,
  formatTag,
  sampleRate,
}) {
  const frameCount = Math.max(1, Math.round(sampleRate * durationSeconds));
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataByteLength = frameCount * blockAlign;
  const wav = Buffer.alloc(44 + dataByteLength);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(formatTag, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * blockAlign, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataByteLength, 40);

  if (formatTag === 3) {
    wav.writeFloatLE(0.25, 44);
  } else {
    wav.writeInt16LE(8_192, 44);
  }

  return wav;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function trackQueue(queue) {
  runningQueues.add(queue);
  return queue;
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-ace-step-job-'));
  temporaryDirectories.add(directory);
  return directory;
}
