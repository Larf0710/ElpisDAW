import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { resolveProjectPath } from '../projectRootAuthority.mjs';
import {
  BASIC_PITCH_MODEL_ID,
  BASIC_PITCH_MODEL_REVISION,
  BASIC_PITCH_PROVIDER_ID,
  BASIC_PITCH_TASK_ID,
  validateBasicPitchParameters,
} from '../providers/basicPitchProviderDefinition.mjs';
import { createBasicPitchProviderWorkerClient } from '../providers/basicPitchProviderWorkerClient.mjs';
import { validateProviderExecutionResult } from '../providers/providerWorkerClient.mjs';

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

export class BasicPitchJobExecutorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'BasicPitchJobExecutorError';
  }
}

export class BasicPitchJobExecutor {
  #activeExecution;
  #createWorkerClient;
  #projectRootAuthority;

  constructor({
    createWorkerClient = createBasicPitchProviderWorkerClient,
    projectRootAuthority,
  }) {
    if (!projectRootAuthority || typeof projectRootAuthority.getSnapshot !== 'function') {
      throw new TypeError('BasicPitchJobExecutor requires a ProjectRootAuthority.');
    }

    if (typeof createWorkerClient !== 'function') {
      throw new TypeError('BasicPitchJobExecutor worker factory must be a function.');
    }

    this.#createWorkerClient = createWorkerClient;
    this.#projectRootAuthority = projectRootAuthority;
  }

  canHandleRequest(value) {
    return isRecord(value) && value.providerId === BASIC_PITCH_PROVIDER_ID;
  }

  validateRequest(value) {
    if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) {
      throw new BasicPitchJobExecutorError(
        'BASIC_PITCH_QUEUE_REQUEST_INVALID',
        'Basic Pitch Queue request must contain exactly the supported Job fields.',
      );
    }

    if (
      value.providerId !== BASIC_PITCH_PROVIDER_ID ||
      value.modelId !== BASIC_PITCH_MODEL_ID ||
      value.modelRevision !== BASIC_PITCH_MODEL_REVISION ||
      value.taskId !== BASIC_PITCH_TASK_ID
    ) {
      throw new BasicPitchJobExecutorError(
        'BASIC_PITCH_QUEUE_REQUEST_UNSUPPORTED',
        'Basic Pitch Queue request uses an unsupported Provider, Model, revision, or Task.',
      );
    }

    const lineage = validateLineage(value.lineage);
    const inputArtifacts = validateInputs(value.inputArtifacts, lineage);

    return Object.freeze({
      inputArtifacts,
      lineage,
      modelId: BASIC_PITCH_MODEL_ID,
      modelRevision: BASIC_PITCH_MODEL_REVISION,
      output: validateOutput(value.output),
      parameters: validateBasicPitchParameters(value.parameters),
      providerId: BASIC_PITCH_PROVIDER_ID,
      taskId: BASIC_PITCH_TASK_ID,
    });
  }

  async run(requestValue, { jobId, onPhase, signal }) {
    const request = this.validateRequest(requestValue);
    validateExecutionContext(jobId, onPhase, signal);

    if (this.#activeExecution) {
      throw new BasicPitchJobExecutorError(
        'BASIC_PITCH_EXECUTOR_BUSY',
        `Basic Pitch executor is already running ${this.#activeExecution.jobId}.`,
      );
    }

    const workerClient = this.#createWorkerClient();

    if (!isWorkerClient(workerClient)) {
      throw new TypeError('Basic Pitch worker factory returned an invalid client.');
    }

    const activeExecution = {
      client: workerClient,
      jobId,
      terminationPromise: undefined,
    };
    this.#activeExecution = activeExecution;
    let result;
    let primaryError;

    try {
      throwIfAborted(signal);
      const inputArtifact = await resolveRecordingInput(
        this.#projectRootAuthority,
        request.inputArtifacts[0],
      );
      const providerJob = Object.freeze({
        inputArtifacts: Object.freeze([inputArtifact]),
        jobId,
        modelId: request.modelId,
        modelRevision: request.modelRevision,
        output: Object.freeze({ kind: 'midi' }),
        parameters: request.parameters,
        providerId: request.providerId,
        taskId: request.taskId,
      });

      throwIfAborted(signal);
      await workerClient.start();
      throwIfAborted(signal);
      await workerClient.loadModel(request.modelId, request.modelRevision);
      throwIfAborted(signal);
      onPhase('PROCESSING');

      const providerExecution = validateProviderExecutionResult(
        await workerClient.execute(providerJob),
        providerJob,
      );
      throwIfAborted(signal);
      await workerClient.unloadModel();
      throwIfAborted(signal);
      await workerClient.close();
      activeExecution.client = undefined;
      throwIfAborted(signal);
      onPhase('SAVING');
      result = createCompletedMidiJobResult(request, providerExecution, jobId);
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

    if (this.#activeExecution === activeExecution) {
      this.#activeExecution = undefined;
    }

    if (primaryError || cleanupErrors.length > 0) {
      throw combineExecutionErrors(primaryError, cleanupErrors);
    }

    return result;
  }

  async cancel(jobId) {
    const activeExecution = this.#activeExecution;

    if (!activeExecution) {
      return;
    }

    if (activeExecution.jobId !== jobId) {
      throw new BasicPitchJobExecutorError(
        'BASIC_PITCH_EXECUTOR_JOB_MISMATCH',
        `Cannot cancel ${jobId} while ${activeExecution.jobId} is active.`,
      );
    }

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

function validateLineage(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['parentArtifactIds', 'parentClipTakeIds']) ||
    !Array.isArray(value.parentArtifactIds) ||
    value.parentArtifactIds.length !== 1 ||
    !Array.isArray(value.parentClipTakeIds) ||
    value.parentClipTakeIds.length !== 1
  ) {
    throw new BasicPitchJobExecutorError(
      'BASIC_PITCH_QUEUE_LINEAGE_INVALID',
      'Basic Pitch requires exactly one parent Recording Artifact and one parent Clip Take.',
    );
  }

  const artifactId = validateIdentity(value.parentArtifactIds[0], 'parent Artifact');
  const clipTakeId = validateIdentity(value.parentClipTakeIds[0], 'parent Clip Take');

  return Object.freeze({
    parentArtifactIds: Object.freeze([artifactId]),
    parentClipTakeIds: Object.freeze([clipTakeId]),
  });
}

function validateInputs(value, lineage) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !isRecord(value[0]) ||
    !hasExactKeys(value[0], ['artifactId', 'kind', 'relativePath']) ||
    value[0].kind !== 'audio' ||
    !isRecordingRelativePath(value[0].relativePath)
  ) {
    throw new BasicPitchJobExecutorError(
      'BASIC_PITCH_QUEUE_INPUTS_INVALID',
      'Basic Pitch requires exactly one Project recording WAV input.',
    );
  }

  const artifactId = validateIdentity(value[0].artifactId, 'input Artifact');

  if (artifactId !== lineage.parentArtifactIds[0]) {
    throw new BasicPitchJobExecutorError(
      'BASIC_PITCH_QUEUE_INPUTS_INVALID',
      'Basic Pitch input Artifact must match the single parent Artifact lineage.',
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
  if (!isRecord(value) || !hasExactKeys(value, ['artifactKind']) || value.artifactKind !== 'midi') {
    throw new BasicPitchJobExecutorError(
      'BASIC_PITCH_QUEUE_OUTPUT_INVALID',
      'Basic Pitch output must request exactly one inline MIDI Artifact.',
    );
  }

  return Object.freeze({ artifactKind: 'midi' });
}

function validateIdentity(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    throw new BasicPitchJobExecutorError(
      'BASIC_PITCH_QUEUE_LINEAGE_INVALID',
      `Basic Pitch ${label} ID must be non-empty, trimmed, and at most 256 characters.`,
    );
  }

  return value;
}

function isRecordingRelativePath(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('recordings/') ||
    !value.toLowerCase().endsWith('.wav') ||
    value.includes('\\') ||
    isAbsolute(value)
  ) {
    return false;
  }

  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.includes(':'),
  );
}

function validateExecutionContext(jobId, onPhase, signal) {
  if (
    typeof jobId !== 'string' ||
    jobId.length === 0 ||
    typeof onPhase !== 'function' ||
    !signal ||
    typeof signal.aborted !== 'boolean'
  ) {
    throw new BasicPitchJobExecutorError(
      'BASIC_PITCH_EXECUTION_CONTEXT_INVALID',
      'Basic Pitch execution context is invalid.',
    );
  }
}

async function resolveRecordingInput(projectRootAuthority, inputArtifact) {
  const projectRoot = projectRootAuthority.getSnapshot();

  if (projectRoot.status !== 'READY') {
    throw new BasicPitchJobExecutorError(
      'PROJECT_ROOT_REQUIRED',
      'Select a Project Root before running Basic Pitch Hum-to-MIDI.',
    );
  }

  try {
    const requestedPath = resolveProjectPath(
      projectRoot.rootPath,
      inputArtifact.relativePath,
    );
    const requestedStat = await lstat(requestedPath);

    if (
      !requestedStat.isFile() ||
      requestedStat.isSymbolicLink() ||
      requestedStat.size <= 44
    ) {
      throw new BasicPitchJobExecutorError(
        'BASIC_PITCH_INPUT_INVALID',
        'Basic Pitch input must be a non-empty regular recording file.',
      );
    }

    const canonicalPath = await realpath(requestedPath);
    const relativeCanonicalPath = relative(projectRoot.rootPath, canonicalPath);

    if (
      relativeCanonicalPath === '' ||
      relativeCanonicalPath.startsWith('..') ||
      isAbsolute(relativeCanonicalPath)
    ) {
      throw new BasicPitchJobExecutorError(
        'BASIC_PITCH_INPUT_OUTSIDE_PROJECT',
        'Basic Pitch input must remain inside the active Project Root.',
      );
    }

    return Object.freeze({
      artifactId: inputArtifact.artifactId,
      kind: 'audio',
      path: canonicalPath,
    });
  } catch (error) {
    if (error instanceof BasicPitchJobExecutorError) {
      throw error;
    }

    throw new BasicPitchJobExecutorError(
      'BASIC_PITCH_INPUT_UNAVAILABLE',
      'Basic Pitch input recording is unavailable.',
      { cause: error },
    );
  }
}

function createCompletedMidiJobResult(request, providerExecution, jobId) {
  return Object.freeze({
    artifact: Object.freeze({
      artifactId: `artifact-${jobId}`,
      createdAt: providerExecution.completedAt,
      kind: 'midi',
      lineage: request.lineage,
      midi: Object.freeze({
        bpm: providerExecution.artifact.bpm,
        notes: providerExecution.artifact.notes,
        ticksPerQuarter: providerExecution.artifact.ticksPerQuarter,
      }),
      provenance: Object.freeze({
        modelId: request.modelId,
        modelRevision: request.modelRevision,
        parameters: request.parameters,
        providerId: request.providerId,
        taskId: request.taskId,
      }),
      sourceJobId: jobId,
    }),
    transcription: Object.freeze({
      noteCount: providerExecution.artifact.notes.length,
      providerCompletedAt: providerExecution.completedAt,
    }),
  });
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw new BasicPitchJobExecutorError('JOB_ABORTED', 'Basic Pitch Job was aborted.');
  }
}

function combineExecutionErrors(primaryError, cleanupErrors) {
  if (!primaryError && cleanupErrors.length === 1) {
    return cleanupErrors[0];
  }

  if (!primaryError) {
    const error = new AggregateError(cleanupErrors, 'Basic Pitch Job cleanup failed.');
    error.code = 'BASIC_PITCH_JOB_CLEANUP_FAILED';
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
    : 'BASIC_PITCH_JOB_EXECUTION_FAILED';
}

function readErrorMessage(error) {
  return error instanceof Error ? error.message : 'Basic Pitch Job failed.';
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
