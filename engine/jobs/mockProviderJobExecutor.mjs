import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { GENERATED_ARTIFACT_DESTINATIONS } from '../generatedArtifactFinalizer.mjs';
import { resolveProjectPath } from '../projectRootAuthority.mjs';
import {
  MOCK_HUM_TO_MIDI_MODEL_ID,
  MOCK_HUM_TO_MIDI_MODEL_REVISION,
  MOCK_HUM_TO_MIDI_TASK_ID,
  MOCK_HUM_TO_MIDI_TICKS_PER_QUARTER,
  MOCK_INSTRUMENT_RENDER_MODEL_ID,
  MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
  MOCK_INSTRUMENT_RENDER_TASK_ID,
  MOCK_PROVIDER_ID,
  MOCK_PROVIDER_MODEL_ID,
  MOCK_PROVIDER_MODEL_REVISION,
  MOCK_PROVIDER_TASK_ID,
  validateMockHumToMidiParameters,
  validateMockInstrumentRenderMidi,
  validateMockInstrumentRenderParameters,
  validateMockProviderParameters,
} from '../providers/mockProviderDefinition.mjs';
import { ProviderWorkerClient } from '../providers/providerWorkerClient.mjs';

export class MockProviderJobExecutorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'MockProviderJobExecutorError';
  }
}

export class MockProviderJobExecutor {
  #activeExecution;
  #createWorkerClient;
  #generatedArtifactFinalizer;
  #projectRootAuthority;

  constructor({
    createWorkerClient = () => new ProviderWorkerClient(),
    generatedArtifactFinalizer,
    projectRootAuthority,
  }) {
    if (
      !generatedArtifactFinalizer ||
      typeof generatedArtifactFinalizer.reserve !== 'function' ||
      typeof generatedArtifactFinalizer.finalize !== 'function' ||
      typeof generatedArtifactFinalizer.discard !== 'function'
    ) {
      throw new TypeError('MockProviderJobExecutor requires a GeneratedArtifactFinalizer.');
    }

    if (!projectRootAuthority || typeof projectRootAuthority.getSnapshot !== 'function') {
      throw new TypeError('MockProviderJobExecutor requires a ProjectRootAuthority.');
    }

    if (typeof createWorkerClient !== 'function') {
      throw new TypeError('MockProviderJobExecutor worker factory must be a function.');
    }

    this.#createWorkerClient = createWorkerClient;
    this.#generatedArtifactFinalizer = generatedArtifactFinalizer;
    this.#projectRootAuthority = projectRootAuthority;
  }

  canHandleRequest(value) {
    return isRecord(value) && value.providerId === MOCK_PROVIDER_ID;
  }

  validateRequest(value) {
    if (!isRecord(value)) {
      throw new MockProviderJobExecutorError(
        'MOCK_QUEUE_REQUEST_INVALID',
        'Mock Provider Queue request must be an object.',
      );
    }

    const isMockAudioJob =
      value.providerId === MOCK_PROVIDER_ID &&
      value.modelId === MOCK_PROVIDER_MODEL_ID &&
      value.modelRevision === MOCK_PROVIDER_MODEL_REVISION &&
      value.taskId === MOCK_PROVIDER_TASK_ID;
    const isMockHumToMidiJob =
      value.providerId === MOCK_PROVIDER_ID &&
      value.modelId === MOCK_HUM_TO_MIDI_MODEL_ID &&
      value.modelRevision === MOCK_HUM_TO_MIDI_MODEL_REVISION &&
      value.taskId === MOCK_HUM_TO_MIDI_TASK_ID;
    const isMockInstrumentRenderJob =
      value.providerId === MOCK_PROVIDER_ID &&
      value.modelId === MOCK_INSTRUMENT_RENDER_MODEL_ID &&
      value.modelRevision === MOCK_INSTRUMENT_RENDER_MODEL_REVISION &&
      value.taskId === MOCK_INSTRUMENT_RENDER_TASK_ID;

    if (!isMockAudioJob && !isMockHumToMidiJob && !isMockInstrumentRenderJob) {
      throw new MockProviderJobExecutorError(
        'MOCK_QUEUE_REQUEST_UNSUPPORTED',
        'Mock Provider Queue request uses an unsupported Provider, Model, revision, or Task.',
      );
    }

    const lineage = validateArtifactLineage(value.lineage);

    if (isMockAudioJob) {
      if (!Array.isArray(value.inputArtifacts) || value.inputArtifacts.length !== 0) {
        throw new MockProviderJobExecutorError(
          'MOCK_QUEUE_INPUTS_INVALID',
          'Mock audio generation does not accept input artifacts.',
        );
      }

      return Object.freeze({
        inputArtifacts: Object.freeze([]),
        lineage,
        modelId: MOCK_PROVIDER_MODEL_ID,
        modelRevision: MOCK_PROVIDER_MODEL_REVISION,
        output: validateAudioQueueOutput(value.output),
        parameters: validateMockProviderParameters(value.parameters),
        providerId: MOCK_PROVIDER_ID,
        taskId: MOCK_PROVIDER_TASK_ID,
      });
    }

    if (isMockInstrumentRenderJob) {
      const inputArtifacts = validateInstrumentRenderInputs(
        value.inputArtifacts,
        lineage,
      );

      return Object.freeze({
        inputArtifacts,
        lineage,
        modelId: MOCK_INSTRUMENT_RENDER_MODEL_ID,
        modelRevision: MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
        output: validateInstrumentRenderOutput(value.output),
        parameters: validateMockInstrumentRenderParameters(value.parameters),
        providerId: MOCK_PROVIDER_ID,
        taskId: MOCK_INSTRUMENT_RENDER_TASK_ID,
      });
    }

    const inputArtifacts = validateHumToMidiInputs(value.inputArtifacts, lineage);

    return Object.freeze({
      inputArtifacts,
      lineage,
      modelId: MOCK_HUM_TO_MIDI_MODEL_ID,
      modelRevision: MOCK_HUM_TO_MIDI_MODEL_REVISION,
      output: validateMidiQueueOutput(value.output),
      parameters: validateMockHumToMidiParameters(value.parameters),
      providerId: MOCK_PROVIDER_ID,
      taskId: MOCK_HUM_TO_MIDI_TASK_ID,
    });
  }

  async run(requestValue, { jobId, onPhase, signal }) {
    const request = this.validateRequest(requestValue);
    validateExecutionContext(jobId, onPhase, signal);

    if (this.#activeExecution) {
      throw new MockProviderJobExecutorError(
        'MOCK_EXECUTOR_BUSY',
        `Mock Provider executor is already running ${this.#activeExecution.jobId}.`,
      );
    }

    const workerClient = this.#createWorkerClient();

    if (!isWorkerClient(workerClient)) {
      throw new TypeError('Mock Provider worker factory returned an invalid client.');
    }

    const activeExecution = {
      client: workerClient,
      jobId,
      terminationPromise: undefined,
    };
    this.#activeExecution = activeExecution;
    let finalized = false;
    let reservation;
    let result;
    let primaryError;

    try {
      throwIfAborted(signal);
      const providerInputArtifacts =
        request.output.artifactKind === 'midi'
          ? Object.freeze([
              await resolveHumToMidiInput(
                this.#projectRootAuthority,
                request.inputArtifacts[0],
              ),
            ])
          : request.inputArtifacts;
      throwIfAborted(signal);
      await workerClient.start();
      throwIfAborted(signal);
      await workerClient.loadModel(request.modelId, request.modelRevision);
      throwIfAborted(signal);

      if (request.output.artifactKind === 'audio') {
        reservation = await this.#generatedArtifactFinalizer.reserve({
          destination: request.output.destination,
          extension: request.output.extension,
        });
      }

      throwIfAborted(signal);
      onPhase('PROCESSING');

      const providerExecution = await workerClient.execute({
        inputArtifacts: providerInputArtifacts,
        jobId,
        modelId: request.modelId,
        modelRevision: request.modelRevision,
        output:
          request.output.artifactKind === 'audio'
            ? {
                kind: 'audio',
                stagingPath: reservation.stagingPath,
              }
            : { kind: 'midi' },
        parameters: request.parameters,
        providerId: request.providerId,
        taskId: request.taskId,
      });
      throwIfAborted(signal);
      await workerClient.unloadModel();
      throwIfAborted(signal);
      await workerClient.close();
      activeExecution.client = undefined;
      throwIfAborted(signal);

      if (request.output.artifactKind === 'audio') {
        await assertStagingOutput(
          reservation.stagingPath,
          providerExecution.artifact.bytesWritten,
        );
        onPhase('SAVING');
        const finalizedArtifact = await this.#generatedArtifactFinalizer.finalize(
          reservation.reservationId,
        );
        finalized = true;
        result = createCompletedAudioJobResult(
          request,
          providerExecution,
          finalizedArtifact,
        );
      } else {
        onPhase('SAVING');
        result = createCompletedMidiJobResult(request, providerExecution, jobId);
      }
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
        await this.#generatedArtifactFinalizer.discard(reservation.reservationId);
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
      throw new MockProviderJobExecutorError(
        'MOCK_EXECUTOR_JOB_MISMATCH',
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

function validateAudioQueueOutput(value) {
  if (
    !isRecord(value) ||
    value.artifactKind !== 'audio' ||
    value.extension !== '.wav' ||
    typeof value.destination !== 'string' ||
    !Object.prototype.hasOwnProperty.call(GENERATED_ARTIFACT_DESTINATIONS, value.destination)
  ) {
    throw new MockProviderJobExecutorError(
      'MOCK_QUEUE_OUTPUT_INVALID',
      'Mock output requires audio, .wav, and an explicit supported Project destination.',
    );
  }

  return Object.freeze({
    artifactKind: 'audio',
    destination: value.destination,
    extension: '.wav',
  });
}

function validateMidiQueueOutput(value) {
  if (
    !isRecord(value) ||
    value.artifactKind !== 'midi' ||
    Object.keys(value).length !== 1
  ) {
    throw new MockProviderJobExecutorError(
      'MOCK_QUEUE_OUTPUT_INVALID',
      'Mock Hum-to-MIDI output must request one inline MIDI Artifact.',
    );
  }

  return Object.freeze({ artifactKind: 'midi' });
}

function validateInstrumentRenderOutput(value) {
  const output = validateAudioQueueOutput(value);

  if (output.destination !== 'instrument') {
    throw new MockProviderJobExecutorError(
      'MOCK_QUEUE_OUTPUT_INVALID',
      'Mock Instrument Render output destination must be instrument.',
    );
  }

  return output;
}

function validateHumToMidiInputs(value, lineage) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !isRecord(value[0]) ||
    value[0].kind !== 'audio' ||
    typeof value[0].artifactId !== 'string' ||
    value[0].artifactId.length === 0 ||
    value[0].artifactId.trim() !== value[0].artifactId ||
    !isRecordingRelativePath(value[0].relativePath) ||
    lineage.parentArtifactIds.length !== 1 ||
    lineage.parentArtifactIds[0] !== value[0].artifactId ||
    lineage.parentClipTakeIds.length !== 1
  ) {
    throw new MockProviderJobExecutorError(
      'MOCK_QUEUE_INPUTS_INVALID',
      'Mock Hum-to-MIDI requires one Project recording input whose Artifact and Clip Take match lineage.',
    );
  }

  return Object.freeze([
    Object.freeze({
      artifactId: value[0].artifactId,
      kind: 'audio',
      relativePath: value[0].relativePath,
    }),
  ]);
}

function validateInstrumentRenderInputs(value, lineage) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !isRecord(value[0]) ||
    value[0].kind !== 'midi' ||
    typeof value[0].artifactId !== 'string' ||
    value[0].artifactId.length === 0 ||
    value[0].artifactId.trim() !== value[0].artifactId ||
    value[0].path !== undefined ||
    lineage.parentArtifactIds.length !== 1 ||
    lineage.parentArtifactIds[0] !== value[0].artifactId ||
    lineage.parentClipTakeIds.length !== 1
  ) {
    throw new MockProviderJobExecutorError(
      'MOCK_QUEUE_INPUTS_INVALID',
      'Mock Instrument Render requires one inline MIDI input whose Artifact and Clip Take match Lineage.',
    );
  }

  const midi = validateMockInstrumentRenderMidi(value[0].midi);

  return Object.freeze([
    Object.freeze({
      artifactId: value[0].artifactId,
      kind: 'midi',
      midi,
    }),
  ]);
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

function validateArtifactLineage(value) {
  if (
    !isRecord(value) ||
    !Array.isArray(value.parentArtifactIds) ||
    !Array.isArray(value.parentClipTakeIds)
  ) {
    throw new MockProviderJobExecutorError(
      'MOCK_QUEUE_LINEAGE_INVALID',
      'Artifact lineage requires parentArtifactIds and parentClipTakeIds arrays.',
    );
  }

  return Object.freeze({
    parentArtifactIds: validateUniqueIds(value.parentArtifactIds, 'parent Artifact'),
    parentClipTakeIds: validateUniqueIds(value.parentClipTakeIds, 'parent Clip Take'),
  });
}

function validateUniqueIds(values, label) {
  if (
    !values.every(
      (value) => typeof value === 'string' && value.length > 0 && value.trim() === value,
    ) ||
    new Set(values).size !== values.length
  ) {
    throw new MockProviderJobExecutorError(
      'MOCK_QUEUE_LINEAGE_INVALID',
      `Mock Job ${label} IDs must be non-empty, trimmed, and unique.`,
    );
  }

  return Object.freeze([...values]);
}

function validateExecutionContext(jobId, onPhase, signal) {
  if (
    typeof jobId !== 'string' ||
    jobId.length === 0 ||
    typeof onPhase !== 'function' ||
    !signal ||
    typeof signal.aborted !== 'boolean'
  ) {
    throw new MockProviderJobExecutorError(
      'MOCK_EXECUTION_CONTEXT_INVALID',
      'Mock Provider execution context is invalid.',
    );
  }
}

async function assertStagingOutput(stagingPath, reportedBytes) {
  const stagingStat = await lstat(stagingPath);

  if (
    !stagingStat.isFile() ||
    stagingStat.isSymbolicLink() ||
    stagingStat.size <= 44 ||
    stagingStat.size !== reportedBytes
  ) {
    throw new MockProviderJobExecutorError(
      'MOCK_STAGING_OUTPUT_MISMATCH',
      'Mock Provider staging output does not match its reported Artifact metadata.',
    );
  }
}

async function resolveHumToMidiInput(projectRootAuthority, inputArtifact) {
  const projectRoot = projectRootAuthority.getSnapshot();

  if (projectRoot.status !== 'READY') {
    throw new MockProviderJobExecutorError(
      'PROJECT_ROOT_REQUIRED',
      'Select a Project Root before running Mock Hum-to-MIDI.',
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
      throw new MockProviderJobExecutorError(
        'MOCK_HUM_TO_MIDI_INPUT_INVALID',
        'Mock Hum-to-MIDI input must be a non-empty regular recording file.',
      );
    }

    const canonicalPath = await realpath(requestedPath);
    const relativeCanonicalPath = relative(projectRoot.rootPath, canonicalPath);

    if (
      relativeCanonicalPath === '' ||
      relativeCanonicalPath.startsWith('..') ||
      isAbsolute(relativeCanonicalPath)
    ) {
      throw new MockProviderJobExecutorError(
        'MOCK_HUM_TO_MIDI_INPUT_OUTSIDE_PROJECT',
        'Mock Hum-to-MIDI input must remain inside the active Project Root.',
      );
    }

    return Object.freeze({
      artifactId: inputArtifact.artifactId,
      kind: 'audio',
      path: canonicalPath,
    });
  } catch (error) {
    if (error instanceof MockProviderJobExecutorError) {
      throw error;
    }

    throw new MockProviderJobExecutorError(
      'MOCK_HUM_TO_MIDI_INPUT_UNAVAILABLE',
      'Mock Hum-to-MIDI input recording is unavailable.',
      { cause: error },
    );
  }
}

function createCompletedAudioJobResult(request, providerExecution, finalizedArtifact) {
  const hasSeed = Object.prototype.hasOwnProperty.call(request.parameters, 'seed');

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
        ...(hasSeed ? { seed: request.parameters.seed } : {}),
        taskId: request.taskId,
      }),
    }),
    generation: Object.freeze({
      bytesWritten: providerExecution.artifact.bytesWritten,
      channels: providerExecution.artifact.channels,
      durationSeconds: providerExecution.artifact.durationSeconds,
      mimeType: providerExecution.artifact.mimeType,
      providerCompletedAt: providerExecution.completedAt,
    }),
  });
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
    throw new MockProviderJobExecutorError('JOB_ABORTED', 'Mock Provider Job was aborted.');
  }
}

function combineExecutionErrors(primaryError, cleanupErrors) {
  if (!primaryError && cleanupErrors.length === 1) {
    return cleanupErrors[0];
  }

  if (!primaryError) {
    const error = new AggregateError(cleanupErrors, 'Mock Provider Job cleanup failed.');
    error.code = 'MOCK_JOB_CLEANUP_FAILED';
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
    : 'MOCK_JOB_EXECUTION_FAILED';
}

function readErrorMessage(error) {
  return error instanceof Error ? error.message : 'Mock Provider Job failed.';
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
