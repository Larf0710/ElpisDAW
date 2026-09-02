import { createHash } from 'node:crypto';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import {
  localEngineLogger,
  toDiagnosticErrorFields,
} from '../diagnosticLogger.mjs';
import { GENERATED_ARTIFACT_DESTINATIONS } from '../generatedArtifactFinalizer.mjs';
import { normalizeGeneratedWaveStagingFile } from '../generatedWaveNormalizer.mjs';
import {
  GENERATED_AUDIO_PROJECT_DIRECTORIES,
  MAX_GENERATED_WAV_BYTES,
} from '../generatedAudioReader.mjs';
import { resolveProjectPath } from '../projectRootAuthority.mjs';
import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TASK_ID,
  validateStableAudio3Parameters,
  validateStableAudio3TextToAudioParameters,
} from '../providers/stableAudio3ProviderDefinition.mjs';
import { createStableAudio3ProviderWorkerClient } from '../providers/stableAudio3ProviderWorkerClient.mjs';
import {
  STABLE_AUDIO_3_CFG_SCALE,
  STABLE_AUDIO_3_CHUNKED_DECODE,
  STABLE_AUDIO_3_INFERENCE_STEPS,
} from '../providers/stableAudio3RuntimeProfile.mjs';
import { createStableAudio3PartialWavPath } from '../providers/stableAudio3StagingPath.mjs';
import { validateProviderExecutionResult } from '../providers/providerWorkerClient.mjs';
import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_OUTPUT_DESTINATION,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
  STABLE_AUDIO_3_SAMPLE_RATE,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../../shared/stableAudio3Protocol.js';

const REQUEST_KEYS = Object.freeze([
  'inputArtifacts',
  'lineage',
  'modelId',
  'modelRevision',
  'output',
  'parameters',
  'providerId',
  'taskId',
]);
const MAX_STAGING_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_WAV_HEADER_BYTES = 1024 * 1024;
const HASH_BUFFER_BYTES = 8 * 1024 * 1024;

export class StableAudio3JobExecutorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'StableAudio3JobExecutorError';
  }
}

export class StableAudio3JobExecutor {
  #activeExecution;
  #createWorkerClient;
  #generatedArtifactFinalizer;
  #logger;
  #projectRootAuthority;

  constructor({
    createWorkerClient,
    generatedArtifactFinalizer,
    logger = localEngineLogger,
    projectRootAuthority,
  }) {
    if (
      !generatedArtifactFinalizer ||
      typeof generatedArtifactFinalizer.reserve !== 'function' ||
      typeof generatedArtifactFinalizer.finalize !== 'function' ||
      typeof generatedArtifactFinalizer.discard !== 'function'
    ) {
      throw new TypeError('StableAudio3JobExecutor requires a GeneratedArtifactFinalizer.');
    }

    if (!projectRootAuthority || typeof projectRootAuthority.getSnapshot !== 'function') {
      throw new TypeError('StableAudio3JobExecutor requires a ProjectRootAuthority.');
    }

    if (
      (createWorkerClient !== undefined && typeof createWorkerClient !== 'function') ||
      !isDiagnosticLogger(logger)
    ) {
      throw new TypeError('StableAudio3JobExecutor worker factory must be a function.');
    }

    this.#createWorkerClient =
      createWorkerClient ?? (() => createStableAudio3ProviderWorkerClient({ logger }));
    this.#generatedArtifactFinalizer = generatedArtifactFinalizer;
    this.#logger = logger;
    this.#projectRootAuthority = projectRootAuthority;
  }

  canHandleRequest(value) {
    return isRecord(value) && value.providerId === STABLE_AUDIO_3_PROVIDER_ID;
  }

  validateRequest(value) {
    if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) {
      throw new StableAudio3JobExecutorError(
        'STABLE_AUDIO_3_QUEUE_REQUEST_INVALID',
        'Stable Audio 3 Queue request must contain exactly the supported Job fields.',
      );
    }

    if (
      value.providerId !== STABLE_AUDIO_3_PROVIDER_ID ||
      value.modelId !== STABLE_AUDIO_3_MODEL_ID ||
      value.modelRevision !== STABLE_AUDIO_3_MODEL_REVISION ||
      (value.taskId !== STABLE_AUDIO_3_TASK_ID &&
        value.taskId !== STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID)
    ) {
      throw new StableAudio3JobExecutorError(
        'STABLE_AUDIO_3_QUEUE_REQUEST_UNSUPPORTED',
        'Stable Audio 3 Queue request uses an unsupported Provider, Model, revision, or Task.',
      );
    }

    const lineage = validateLineage(value.lineage, value.taskId);
    const inputArtifacts = validateInputs(
      value.inputArtifacts,
      lineage,
      value.taskId,
    );
    const parameters =
      value.taskId === STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID
        ? validateStableAudio3TextToAudioParameters(value.parameters)
        : validateStableAudio3Parameters(value.parameters);

    return Object.freeze({
      inputArtifacts,
      lineage,
      modelId: STABLE_AUDIO_3_MODEL_ID,
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      output: validateOutput(value.output),
      parameters,
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      taskId: value.taskId,
    });
  }

  async run(requestValue, { jobId, onPhase, onProgress, signal }) {
    const request = this.validateRequest(requestValue);
    validateExecutionContext(jobId, onPhase, onProgress, signal);

    if (this.#activeExecution) {
      throw new StableAudio3JobExecutorError(
        'STABLE_AUDIO_3_EXECUTOR_BUSY',
        `Stable Audio 3 executor is already running ${this.#activeExecution.jobId}.`,
      );
    }

    const workerClient = this.#createWorkerClient();

    if (!isWorkerClient(workerClient)) {
      throw new TypeError('Stable Audio 3 worker factory returned an invalid client.');
    }

    const activeExecution = {
      client: workerClient,
      jobId,
      terminationPromise: undefined,
    };
    this.#activeExecution = activeExecution;
    this.#logger.debug('SA3', 'PROVIDER_REQUEST_PREPARED', {
      jobId,
      modelId: request.modelId,
      modelRevision: request.modelRevision,
      providerId: request.providerId,
      taskId: request.taskId,
    });
    let finalized = false;
    let reservation;
    let result;
    let primaryError;

    try {
      throwIfAborted(signal);
      let resolvedInput;

      if (request.taskId === STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID) {
        requireProjectRootReady(this.#projectRootAuthority);
      } else {
        resolvedInput = await resolveAudioInput(
          this.#projectRootAuthority,
          request.inputArtifacts[0],
        );
        this.#logger.debug('SA3', 'SOURCE_DESCRIPTOR_RESOLVED', {
          artifactId: request.inputArtifacts[0].artifactId,
          clipTakeId: request.lineage.parentClipTakeIds[0],
          jobId,
          providerId: request.providerId,
          taskId: request.taskId,
        });
      }
      throwIfAborted(signal);
      await workerClient.start();
      throwIfAborted(signal);
      await workerClient.loadModel(request.modelId, request.modelRevision);
      throwIfAborted(signal);
      reservation = await this.#generatedArtifactFinalizer.reserve({
        destination: request.output.destination,
        extension: request.output.extension,
      });
      const providerJob = Object.freeze({
        inputArtifacts: Object.freeze(
          resolvedInput ? [resolvedInput.artifact] : [],
        ),
        jobId,
        modelId: request.modelId,
        modelRevision: request.modelRevision,
        output: Object.freeze({
          kind: 'audio',
          stagingPath: reservation.stagingPath,
        }),
        parameters: request.parameters,
        providerId: request.providerId,
        taskId: request.taskId,
      });

      throwIfAborted(signal);
      onPhase('PROCESSING');
      const providerExecution = validateProviderExecutionResult(
        await workerClient.execute(providerJob, { onProgress }),
        providerJob,
      );
      throwIfAborted(signal);
      await workerClient.unloadModel();
      throwIfAborted(signal);
      await workerClient.close();
      activeExecution.client = undefined;
      throwIfAborted(signal);
      if (resolvedInput) {
        await assertInputUnchanged(
          resolvedInput.artifact.path,
          resolvedInput.evidence,
        );
      }
      await assertInternalPartialMissing(reservation.stagingPath);
      this.#logger.debug('SA3', 'OUTPUT_VALIDATION_STARTED', {
        jobId,
        providerId: request.providerId,
        taskId: request.taskId,
      });
      await inspectAndHashStagingOutput(
        reservation.stagingPath,
        providerExecution,
        request.parameters.durationSeconds,
      );
      throwIfAborted(signal);
      onPhase('SAVING');
      const outputEvidence = await normalizeGeneratedWaveStagingFile(
        reservation.stagingPath,
        { signal },
      );
      this.#logger.debug('SA3', 'OUTPUT_VALIDATED', {
        channels: outputEvidence.channels,
        jobId,
        providerId: request.providerId,
        sampleRate: outputEvidence.sampleRate,
        sizeBytes: outputEvidence.sizeBytes,
        taskId: request.taskId,
      });
      throwIfAborted(signal);
      const finalizedArtifact = await this.#generatedArtifactFinalizer.finalize(
        reservation.reservationId,
      );
      finalized = true;
      this.#logger.info('SA3', 'OUTPUT_FINALIZED', {
        artifactId: finalizedArtifact.artifactId,
        jobId,
        providerId: request.providerId,
        relativePath: finalizedArtifact.file.relativePath,
        sizeBytes: finalizedArtifact.file.sizeBytes,
        taskId: request.taskId,
      });
      result = createCompletedAudioJobResult(
        request,
        providerExecution,
        finalizedArtifact,
        resolvedInput?.evidence,
        outputEvidence,
      );
    } catch (error) {
      primaryError = error;
    }

    const cleanupErrors = [];

    if (activeExecution.client) {
      try {
        await this.#terminateExecution(activeExecution);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (reservation && !finalized) {
      try {
        await rm(createStableAudio3PartialWavPath(reservation.stagingPath), {
          force: true,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        await this.#generatedArtifactFinalizer.discard(reservation.reservationId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (this.#activeExecution === activeExecution) {
      this.#activeExecution = undefined;
    }

    if (primaryError || cleanupErrors.length > 0) {
      const executionError = combineExecutionErrors(primaryError, cleanupErrors);
      this.#logger.error('SA3', 'JOB_FAILED', {
        ...toDiagnosticErrorFields(executionError),
        jobId,
        providerId: request.providerId,
        taskId: request.taskId,
      });
      throw executionError;
    }

    return result;
  }

  async cancel(jobId) {
    const activeExecution = this.#activeExecution;

    if (!activeExecution) {
      return;
    }

    if (activeExecution.jobId !== jobId) {
      throw new StableAudio3JobExecutorError(
        'STABLE_AUDIO_3_EXECUTOR_JOB_MISMATCH',
        `Cannot cancel ${jobId} while ${activeExecution.jobId} is active.`,
      );
    }

    this.#logger.info('SA3', 'JOB_CANCEL_REQUESTED', { jobId });
    await this.#terminateExecution(activeExecution);
  }

  async shutdown() {
    if (this.#activeExecution) {
      await this.#terminateExecution(this.#activeExecution);
    }
  }

  #terminateExecution(activeExecution) {
    if (!activeExecution.terminationPromise) {
      activeExecution.terminationPromise = activeExecution.client?.terminate() ?? Promise.resolve();
    }

    return activeExecution.terminationPromise;
  }
}

function isDiagnosticLogger(value) {
  return (
    value &&
    typeof value.debug === 'function' &&
    typeof value.info === 'function' &&
    typeof value.error === 'function'
  );
}

function validateLineage(value, taskId) {
  if (taskId === STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID) {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['parentArtifactIds', 'parentClipTakeIds']) ||
      !Array.isArray(value.parentArtifactIds) ||
      value.parentArtifactIds.length !== 0 ||
      !Array.isArray(value.parentClipTakeIds) ||
      value.parentClipTakeIds.length !== 0
    ) {
      throw new StableAudio3JobExecutorError(
        'STABLE_AUDIO_3_QUEUE_LINEAGE_INVALID',
        'Stable Audio 3 Text-to-Audio requires empty parent Artifact and Clip Take lineage.',
      );
    }

    return Object.freeze({
      parentArtifactIds: Object.freeze([]),
      parentClipTakeIds: Object.freeze([]),
    });
  }

  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['parentArtifactIds', 'parentClipTakeIds']) ||
    !Array.isArray(value.parentArtifactIds) ||
    value.parentArtifactIds.length !== 1 ||
    !Array.isArray(value.parentClipTakeIds) ||
    value.parentClipTakeIds.length !== 1
  ) {
    throw new StableAudio3JobExecutorError(
      'STABLE_AUDIO_3_QUEUE_LINEAGE_INVALID',
      'Stable Audio 3 requires exactly one parent Audio Artifact and one parent Clip Take.',
    );
  }

  return Object.freeze({
    parentArtifactIds: Object.freeze([
      validateIdentity(value.parentArtifactIds[0], 'parent Artifact'),
    ]),
    parentClipTakeIds: Object.freeze([
      validateIdentity(value.parentClipTakeIds[0], 'parent Clip Take'),
    ]),
  });
}

function validateInputs(value, lineage, taskId) {
  if (taskId === STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID) {
    if (!Array.isArray(value) || value.length !== 0) {
      throw new StableAudio3JobExecutorError(
        'STABLE_AUDIO_3_QUEUE_INPUTS_INVALID',
        'Stable Audio 3 Text-to-Audio requires no input Artifacts.',
      );
    }

    return Object.freeze([]);
  }

  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !isRecord(value[0]) ||
    !hasExactKeys(value[0], ['artifactId', 'kind', 'relativePath']) ||
    value[0].kind !== 'audio' ||
    !isAudioRelativePath(value[0].relativePath)
  ) {
    throw new StableAudio3JobExecutorError(
      'STABLE_AUDIO_3_QUEUE_INPUTS_INVALID',
      'Stable Audio 3 requires exactly one allowlisted Project WAV input.',
    );
  }

  const artifactId = validateIdentity(value[0].artifactId, 'input Artifact');

  if (artifactId !== lineage.parentArtifactIds[0]) {
    throw new StableAudio3JobExecutorError(
      'STABLE_AUDIO_3_QUEUE_INPUTS_INVALID',
      'Stable Audio 3 input Artifact must match the single parent Artifact lineage.',
    );
  }

  return Object.freeze([
    Object.freeze({
      artifactId,
      kind: 'audio',
      relativePath: value[0].relativePath,
    }),
  ]);
}

function validateOutput(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['artifactKind', 'destination', 'extension']) ||
    value.artifactKind !== 'audio' ||
    value.destination !== STABLE_AUDIO_3_OUTPUT_DESTINATION ||
    value.extension !== '.wav' ||
    !Object.prototype.hasOwnProperty.call(
      GENERATED_ARTIFACT_DESTINATIONS,
      value.destination,
    )
  ) {
    throw new StableAudio3JobExecutorError(
      'STABLE_AUDIO_3_QUEUE_OUTPUT_INVALID',
      'Stable Audio 3 output must be one .wav in the stable-audio-3 Project destination.',
    );
  }

  return Object.freeze({
    artifactKind: 'audio',
    destination: STABLE_AUDIO_3_OUTPUT_DESTINATION,
    extension: '.wav',
  });
}

function validateIdentity(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    throw new StableAudio3JobExecutorError(
      'STABLE_AUDIO_3_QUEUE_LINEAGE_INVALID',
      `Stable Audio 3 ${label} ID must be non-empty, trimmed, and at most 256 characters.`,
    );
  }

  return value;
}

function isAudioRelativePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    !value.toLowerCase().endsWith('.wav') ||
    value.toLowerCase().includes('.partial.') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value)
  ) {
    return false;
  }

  const segments = value.split('/');

  return (
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes(':'),
    ) &&
    GENERATED_AUDIO_PROJECT_DIRECTORIES.some(
      (directory) =>
        value.startsWith(`${directory}/`) && value.length > directory.length + 1,
    )
  );
}

function validateExecutionContext(jobId, onPhase, onProgress, signal) {
  if (
    typeof jobId !== 'string' ||
    jobId.length === 0 ||
    typeof onPhase !== 'function' ||
    (onProgress !== undefined && typeof onProgress !== 'function') ||
    !signal ||
    typeof signal.aborted !== 'boolean'
  ) {
    throw new StableAudio3JobExecutorError(
      'STABLE_AUDIO_3_EXECUTION_CONTEXT_INVALID',
      'Stable Audio 3 execution context is invalid.',
    );
  }
}

async function resolveAudioInput(projectRootAuthority, inputArtifact) {
  const projectRoot = projectRootAuthority.getSnapshot();

  if (projectRoot.status !== 'READY') {
    throw new StableAudio3JobExecutorError(
      'PROJECT_ROOT_REQUIRED',
      'Select a Project Root before running Stable Audio 3.',
    );
  }

  let inputHandle;

  try {
    const requestedPath = resolveProjectPath(
      projectRoot.rootPath,
      inputArtifact.relativePath,
    );
    const requestedStat = await lstat(requestedPath);

    if (
      !requestedStat.isFile() ||
      requestedStat.isSymbolicLink() ||
      requestedStat.size <= 44 ||
      requestedStat.size > MAX_GENERATED_WAV_BYTES
    ) {
      throw new StableAudio3JobExecutorError(
        'STABLE_AUDIO_3_INPUT_INVALID',
        'Stable Audio 3 input must be a supported regular Project WAV file.',
      );
    }

    const canonicalPath = await realpath(requestedPath);
    const relativeCanonicalPath = relative(projectRoot.rootPath, canonicalPath);

    if (
      relativeCanonicalPath === '' ||
      relativeCanonicalPath.startsWith('..') ||
      isAbsolute(relativeCanonicalPath)
    ) {
      throw new StableAudio3JobExecutorError(
        'STABLE_AUDIO_3_INPUT_OUTSIDE_PROJECT',
        'Stable Audio 3 input must remain inside the active Project Root.',
      );
    }

    inputHandle = await open(canonicalPath, 'r');
    const header = Buffer.allocUnsafe(12);
    const { bytesRead } = await inputHandle.read(header, 0, header.length, 0);
    const openedStat = await inputHandle.stat();

    if (
      bytesRead !== header.length ||
      header.toString('ascii', 0, 4) !== 'RIFF' ||
      header.toString('ascii', 8, 12) !== 'WAVE' ||
      !openedStat.isFile() ||
      openedStat.size !== requestedStat.size
    ) {
      throw new StableAudio3JobExecutorError(
        'STABLE_AUDIO_3_INPUT_INVALID',
        'Stable Audio 3 input must be a stable RIFF/WAVE file.',
      );
    }

    const digest = createHash('sha256');
    const hashBuffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;

    while (position < openedStat.size) {
      const { bytesRead: hashBytesRead } = await inputHandle.read(
        hashBuffer,
        0,
        Math.min(hashBuffer.length, openedStat.size - position),
        position,
      );

      if (hashBytesRead === 0) {
        break;
      }

      digest.update(hashBuffer.subarray(0, hashBytesRead));
      position += hashBytesRead;
    }

    if (position !== openedStat.size || (await inputHandle.stat()).size !== openedStat.size) {
      throw new StableAudio3JobExecutorError(
        'STABLE_AUDIO_3_INPUT_CHANGED',
        'Stable Audio 3 input changed during authorization.',
      );
    }

    return Object.freeze({
      artifact: Object.freeze({
        artifactId: inputArtifact.artifactId,
        kind: 'audio',
        path: canonicalPath,
      }),
      evidence: Object.freeze({
        artifactId: inputArtifact.artifactId,
        sha256: digest.digest('hex'),
        sizeBytes: openedStat.size,
      }),
    });
  } catch (error) {
    if (error instanceof StableAudio3JobExecutorError) {
      throw error;
    }

    throw new StableAudio3JobExecutorError(
      'STABLE_AUDIO_3_INPUT_UNAVAILABLE',
      'Stable Audio 3 input audio is unavailable.',
      { cause: error },
    );
  } finally {
    await inputHandle?.close().catch(() => undefined);
  }
}

function requireProjectRootReady(projectRootAuthority) {
  if (projectRootAuthority.getSnapshot().status !== 'READY') {
    throw new StableAudio3JobExecutorError(
      'PROJECT_ROOT_REQUIRED',
      'Select a Project Root before running Stable Audio 3.',
    );
  }
}

async function assertInternalPartialMissing(stagingPath) {
  const partialWavPath = createStableAudio3PartialWavPath(stagingPath);

  try {
    await lstat(partialWavPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  throw new StableAudio3JobExecutorError(
    'STABLE_AUDIO_3_PARTIAL_OUTPUT_RETAINED',
    'Stable Audio 3 Worker retained an internal .partial.wav file.',
  );
}

async function assertInputUnchanged(inputPath, expectedEvidence) {
  let inputHandle;

  try {
    const inputStat = await lstat(inputPath);

    if (
      !inputStat.isFile() ||
      inputStat.isSymbolicLink() ||
      inputStat.size !== expectedEvidence.sizeBytes
    ) {
      throw inputChanged();
    }

    inputHandle = await open(inputPath, 'r');
    const openedStat = await inputHandle.stat();
    const digest = createHash('sha256');
    const hashBuffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;

    while (position < openedStat.size) {
      const { bytesRead } = await inputHandle.read(
        hashBuffer,
        0,
        Math.min(hashBuffer.length, openedStat.size - position),
        position,
      );

      if (bytesRead === 0) {
        break;
      }

      digest.update(hashBuffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    if (
      !openedStat.isFile() ||
      openedStat.size !== expectedEvidence.sizeBytes ||
      position !== openedStat.size ||
      (await inputHandle.stat()).size !== openedStat.size ||
      digest.digest('hex') !== expectedEvidence.sha256
    ) {
      throw inputChanged();
    }
  } catch (error) {
    if (error instanceof StableAudio3JobExecutorError) {
      throw error;
    }

    throw inputChanged(error);
  } finally {
    await inputHandle?.close().catch(() => undefined);
  }
}

function inputChanged(cause) {
  return new StableAudio3JobExecutorError(
    'STABLE_AUDIO_3_INPUT_CHANGED',
    'Stable Audio 3 input changed during execution.',
    cause === undefined ? undefined : { cause },
  );
}

async function inspectAndHashStagingOutput(
  stagingPath,
  providerExecution,
  requestedDurationSeconds,
) {
  const stagingStat = await lstat(stagingPath);

  if (
    !stagingStat.isFile() ||
    stagingStat.isSymbolicLink() ||
    stagingStat.size <= 44 ||
    stagingStat.size > MAX_STAGING_OUTPUT_BYTES ||
    stagingStat.size !== providerExecution.artifact.bytesWritten
  ) {
    throw new StableAudio3JobExecutorError(
      'STABLE_AUDIO_3_STAGING_OUTPUT_MISMATCH',
      'Stable Audio 3 staging output does not match its reported metadata.',
    );
  }

  const stagingHandle = await open(stagingPath, 'r');

  try {
    const openedStat = await stagingHandle.stat();
    const headerLength = Math.min(openedStat.size, MAX_WAV_HEADER_BYTES);
    const header = Buffer.allocUnsafe(headerLength);
    const headerRead = await stagingHandle.read(header, 0, header.length, 0);

    if (headerRead.bytesRead !== header.length) {
      throw invalidStagingWave();
    }

    const wave = parsePcmWaveHeader(header, openedStat.size);
    const expectedDuration = providerExecution.artifact.durationSeconds;

    if (
      wave.channels !== STABLE_AUDIO_3_CHANNELS ||
      wave.sampleRate !== STABLE_AUDIO_3_SAMPLE_RATE ||
      wave.bitsPerSample !== 16 ||
      Math.abs(wave.durationSeconds - expectedDuration) > 1 / STABLE_AUDIO_3_SAMPLE_RATE ||
      Math.abs(wave.durationSeconds - requestedDurationSeconds) >
        1 / STABLE_AUDIO_3_SAMPLE_RATE
    ) {
      throw invalidStagingWave();
    }

    const digest = createHash('sha256');
    const hashBuffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;

    while (position < openedStat.size) {
      const { bytesRead } = await stagingHandle.read(
        hashBuffer,
        0,
        Math.min(hashBuffer.length, openedStat.size - position),
        position,
      );

      if (bytesRead === 0) {
        break;
      }

      digest.update(hashBuffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    if (position !== openedStat.size || (await stagingHandle.stat()).size !== openedStat.size) {
      throw new StableAudio3JobExecutorError(
        'STABLE_AUDIO_3_STAGING_OUTPUT_CHANGED',
        'Stable Audio 3 staging output changed during verification.',
      );
    }

    return Object.freeze({
      channels: wave.channels,
      durationSeconds: wave.durationSeconds,
      sampleRate: wave.sampleRate,
      sha256: digest.digest('hex'),
      sizeBytes: openedStat.size,
    });
  } finally {
    await stagingHandle.close().catch(() => undefined);
  }
}

function parsePcmWaveHeader(header, fileSize) {
  if (
    header.length < 44 ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE' ||
    header.readUInt32LE(4) + 8 !== fileSize
  ) {
    throw invalidStagingWave();
  }

  let dataSize;
  let format;
  let offset = 12;

  while (offset + 8 <= header.length) {
    const chunkId = header.toString('ascii', offset, offset + 4);
    const chunkSize = header.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd > fileSize || chunkStart > header.length) {
      throw invalidStagingWave();
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || chunkStart + 16 > header.length) {
        throw invalidStagingWave();
      }

      format = {
        audioFormat: header.readUInt16LE(chunkStart),
        bitsPerSample: header.readUInt16LE(chunkStart + 14),
        blockAlign: header.readUInt16LE(chunkStart + 12),
        channels: header.readUInt16LE(chunkStart + 2),
        sampleRate: header.readUInt32LE(chunkStart + 4),
      };
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    }

    if (format && dataSize !== undefined) {
      break;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (
    !format ||
    dataSize === undefined ||
    format.audioFormat !== 1 ||
    format.channels <= 0 ||
    format.sampleRate <= 0 ||
    format.bitsPerSample <= 0 ||
    format.blockAlign !== (format.channels * format.bitsPerSample) / 8 ||
    dataSize === 0 ||
    dataSize % format.blockAlign !== 0
  ) {
    throw invalidStagingWave();
  }

  return Object.freeze({
    bitsPerSample: format.bitsPerSample,
    channels: format.channels,
    durationSeconds: dataSize / format.blockAlign / format.sampleRate,
    sampleRate: format.sampleRate,
  });
}

function invalidStagingWave() {
  return new StableAudio3JobExecutorError(
    'STABLE_AUDIO_3_STAGING_WAV_INVALID',
    'Stable Audio 3 staging output must be the requested stereo PCM WAVE file.',
  );
}

function createCompletedAudioJobResult(
  request,
  providerExecution,
  finalizedArtifact,
  inputEvidence,
  outputEvidence,
) {
  return Object.freeze({
    artifact: Object.freeze({
      artifactId: finalizedArtifact.artifactId,
      createdAt: finalizedArtifact.finalizedAt,
      destination: finalizedArtifact.destination,
      file: finalizedArtifact.file,
      kind: request.output.artifactKind,
      lineage: request.lineage,
      provenance: Object.freeze({
        modelId: request.modelId,
        modelRevision: request.modelRevision,
        parameters: request.parameters,
        providerId: request.providerId,
        seed: request.parameters.seed,
        taskId: request.taskId,
      }),
    }),
    generation: Object.freeze({
      bytesWritten: outputEvidence.sizeBytes,
      channels: outputEvidence.channels,
      durationSeconds: outputEvidence.durationSeconds,
      evidence: Object.freeze({
        cfgScale: STABLE_AUDIO_3_CFG_SCALE,
        chunkedDecode: STABLE_AUDIO_3_CHUNKED_DECODE,
        inferenceSteps: STABLE_AUDIO_3_INFERENCE_STEPS,
        ...(inputEvidence
          ? {
              inputArtifactId: inputEvidence.artifactId,
              inputSha256: inputEvidence.sha256,
              inputSizeBytes: inputEvidence.sizeBytes,
            }
          : {}),
        modelRevision: request.modelRevision,
        outputSha256: outputEvidence.sha256,
        runtimeProfileId: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
        sampleRate: outputEvidence.sampleRate,
      }),
      mimeType: providerExecution.artifact.mimeType,
      providerCompletedAt: providerExecution.completedAt,
    }),
  });
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw new StableAudio3JobExecutorError(
      'JOB_ABORTED',
      'Stable Audio 3 Job was aborted.',
    );
  }
}

function combineExecutionErrors(primaryError, cleanupErrors) {
  if (!primaryError && cleanupErrors.length === 1) {
    return cleanupErrors[0];
  }

  if (!primaryError) {
    const error = new AggregateError(
      cleanupErrors,
      'Stable Audio 3 Job cleanup failed.',
    );
    error.code = 'STABLE_AUDIO_3_JOB_CLEANUP_FAILED';
    return error;
  }

  if (cleanupErrors.length === 0) {
    return primaryError;
  }

  const error = new AggregateError(
    [primaryError, ...cleanupErrors],
    `${readErrorMessage(primaryError)} Cleanup also failed.`,
    { cause: primaryError },
  );
  error.code = readErrorCode(primaryError);
  return error;
}

function readErrorCode(error) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'STABLE_AUDIO_3_JOB_EXECUTION_FAILED';
}

function readErrorMessage(error) {
  return error instanceof Error ? error.message : 'Stable Audio 3 Job failed.';
}

function isWorkerClient(value) {
  return (
    value &&
    typeof value.start === 'function' &&
    typeof value.loadModel === 'function' &&
    typeof value.execute === 'function' &&
    typeof value.unloadModel === 'function' &&
    typeof value.close === 'function' &&
    typeof value.terminate === 'function'
  );
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isNodeError(value) {
  return value instanceof Error && 'code' in value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
