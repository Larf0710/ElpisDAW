import { createHash } from 'node:crypto';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import {
  localEngineLogger,
  toDiagnosticErrorFields,
} from '../diagnosticLogger.mjs';
import { GENERATED_ARTIFACT_DESTINATIONS } from '../generatedArtifactFinalizer.mjs';
import {
  GENERATED_AUDIO_PROJECT_DIRECTORIES,
  MAX_GENERATED_WAV_BYTES,
} from '../generatedAudioReader.mjs';
import { normalizeGeneratedWaveStagingFile } from '../generatedWaveNormalizer.mjs';
import { resolveProjectPath } from '../projectRootAuthority.mjs';
import {
  ACE_STEP_COVER_TASK_ID,
  ACE_STEP_MODEL_ID,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_TASK_ID,
  ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
  validateAceStepParameters,
} from '../providers/aceStepProviderDefinition.mjs';
import { createAceStepProviderWorkerClient } from '../providers/aceStepProviderWorkerClient.mjs';
import {
  ACE_STEP_COVER_GENERATION_INSTRUCTION,
  ACE_STEP_CFG_INTERVAL_END,
  ACE_STEP_CFG_INTERVAL_START,
  ACE_STEP_DCW_ENABLED,
  ACE_STEP_GENERATION_INSTRUCTION,
  ACE_STEP_GUIDANCE_SCALE,
  ACE_STEP_INFERENCE_STEPS,
  ACE_STEP_SHIFT,
  ACE_STEP_TEXT_TO_MUSIC_GENERATION_INSTRUCTION,
  ACE_STEP_USE_ADG,
} from '../providers/aceStepRuntimeProfile.mjs';
import { createAceStepPartialWavPath } from '../providers/aceStepStagingPath.mjs';
import { validateProviderExecutionResult } from '../providers/providerWorkerClient.mjs';
import {
  ACE_STEP_CHANNELS,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_RUNTIME_PROFILE_ID,
  ACE_STEP_SAMPLE_RATE,
} from '../../shared/aceStepProtocol.js';
import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
} from '../../shared/stableAudio3Protocol.js';

const VOCAL_REQUEST_KEYS = Object.freeze([
  'guideSource',
  'inputArtifacts',
  'lineage',
  'modelId',
  'modelRevision',
  'output',
  'parameters',
  'providerId',
  'taskId',
]);
const TEXT_TO_MUSIC_REQUEST_KEYS = Object.freeze(
  VOCAL_REQUEST_KEYS.filter((key) => key !== 'guideSource'),
);
const LYRICS_PROJECT_DIRECTORY = 'renders/ace-step/lyrics';
const MAX_LYRICS_BYTES = 16 * 1024;
const MAX_LYRICS_CHARACTERS = 4_096;
const MAX_WAV_HEADER_BYTES = 1024 * 1024;
const HASH_BUFFER_BYTES = 8 * 1024 * 1024;

export class AceStepJobExecutorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'AceStepJobExecutorError';
  }
}

export class AceStepJobExecutor {
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
      throw new TypeError('AceStepJobExecutor requires a GeneratedArtifactFinalizer.');
    }

    if (!projectRootAuthority || typeof projectRootAuthority.getSnapshot !== 'function') {
      throw new TypeError('AceStepJobExecutor requires a ProjectRootAuthority.');
    }

    if (
      (createWorkerClient !== undefined && typeof createWorkerClient !== 'function') ||
      !isDiagnosticLogger(logger)
    ) {
      throw new TypeError('AceStepJobExecutor worker factory must be a function.');
    }

    this.#createWorkerClient =
      createWorkerClient ?? (() => createAceStepProviderWorkerClient({ logger }));
    this.#generatedArtifactFinalizer = generatedArtifactFinalizer;
    this.#logger = logger;
    this.#projectRootAuthority = projectRootAuthority;
  }

  canHandleRequest(value) {
    return isRecord(value) && value.providerId === ACE_STEP_PROVIDER_ID;
  }

  validateRequest(value) {
    if (!isRecord(value)) {
      throw new AceStepJobExecutorError(
        'ACE_STEP_QUEUE_REQUEST_INVALID',
        'ACE-Step Queue request must contain exactly the supported Job fields.',
      );
    }

    const requestKeys =
      value.taskId === ACE_STEP_TEXT_TO_MUSIC_TASK_ID
        ? TEXT_TO_MUSIC_REQUEST_KEYS
        : VOCAL_REQUEST_KEYS;

    if (!hasExactKeys(value, requestKeys)) {
      throw new AceStepJobExecutorError(
        'ACE_STEP_QUEUE_REQUEST_INVALID',
        'ACE-Step Queue request must contain exactly the supported Job fields.',
      );
    }

    if (
      value.providerId !== ACE_STEP_PROVIDER_ID ||
      value.modelId !== ACE_STEP_MODEL_ID ||
      value.modelRevision !== ACE_STEP_MODEL_REVISION ||
      (value.taskId !== ACE_STEP_TASK_ID &&
        value.taskId !== ACE_STEP_TEXT_TO_MUSIC_TASK_ID &&
        value.taskId !== ACE_STEP_COVER_TASK_ID)
    ) {
      throw new AceStepJobExecutorError(
        'ACE_STEP_QUEUE_REQUEST_UNSUPPORTED',
        'ACE-Step Queue request uses an unsupported Provider, Model, revision, or Task.',
      );
    }

    if (value.taskId === ACE_STEP_TEXT_TO_MUSIC_TASK_ID) {
      const lineage = validateTextToMusicLineage(value.lineage);

      return Object.freeze({
        inputArtifacts: validateTextToMusicInputs(value.inputArtifacts, lineage),
        lineage,
        modelId: ACE_STEP_MODEL_ID,
        modelRevision: ACE_STEP_MODEL_REVISION,
        output: validateOutput(value.output),
        parameters: validateAceStepParameters(value.parameters, value.taskId),
        providerId: ACE_STEP_PROVIDER_ID,
        taskId: ACE_STEP_TEXT_TO_MUSIC_TASK_ID,
      });
    }

    const guideSource = validateGuideSource(value.guideSource, value.taskId);
    const lineage = validateLineage(value.lineage, guideSource);

    return Object.freeze({
      guideSource,
      inputArtifacts: validateInputs(value.inputArtifacts, lineage, guideSource),
      lineage,
      modelId: ACE_STEP_MODEL_ID,
      modelRevision: ACE_STEP_MODEL_REVISION,
      output: validateOutput(value.output),
      parameters: validateAceStepParameters(value.parameters, value.taskId),
      providerId: ACE_STEP_PROVIDER_ID,
      taskId: value.taskId,
    });
  }

  async run(requestValue, { jobId, onPhase, onProgress, signal }) {
    const request = this.validateRequest(requestValue);
    validateExecutionContext(jobId, onPhase, onProgress, signal);

    if (this.#activeExecution) {
      throw new AceStepJobExecutorError(
        'ACE_STEP_EXECUTOR_BUSY',
        `ACE-Step executor is already running ${this.#activeExecution.jobId}.`,
      );
    }

    const workerClient = this.#createWorkerClient();

    if (!isWorkerClient(workerClient)) {
      throw new TypeError('ACE-Step worker factory returned an invalid client.');
    }

    let settleExecution;
    const settlementPromise = new Promise((resolve) => {
      settleExecution = resolve;
    });
    const activeExecution = {
      client: workerClient,
      jobId,
      settleExecution,
      settlementPromise,
      terminationPromise: undefined,
    };
    this.#activeExecution = activeExecution;
    this.#logger.debug('ACE', 'PROVIDER_REQUEST_PREPARED', {
      artifactId: request.guideSource?.artifactId,
      clipTakeId: request.guideSource?.clipTakeId,
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
      const resolvedInputs = await Promise.all(
        request.inputArtifacts.map((artifact) =>
          resolveProjectInput(this.#projectRootAuthority, artifact),
        ),
      );
      for (const inputArtifact of request.inputArtifacts) {
        this.#logger.debug('ACE', 'SOURCE_DESCRIPTOR_RESOLVED', {
          artifactId: inputArtifact.artifactId,
          clipTakeId:
            inputArtifact.artifactId === request.guideSource?.artifactId
              ? request.guideSource?.clipTakeId
              : undefined,
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
          resolvedInputs.map((resolvedInput) => resolvedInput.artifact),
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
      const rawProviderExecution = await workerClient.execute(providerJob, {
        onProgress,
      });
      const providerExecution = validateProviderExecutionResult(
        rawProviderExecution,
        providerJob,
      );
      const providerOutputSha256 = readProviderOutputSha256(rawProviderExecution);
      throwIfAborted(signal);
      await workerClient.unloadModel();
      throwIfAborted(signal);
      await workerClient.close();
      activeExecution.client = undefined;
      throwIfAborted(signal);
      await Promise.all(
        resolvedInputs.map((resolvedInput) =>
          assertInputUnchanged(resolvedInput.artifact.path, resolvedInput.evidence),
        ),
      );
      await assertInternalPartialMissing(reservation.stagingPath);
      this.#logger.debug('ACE', 'OUTPUT_VALIDATION_STARTED', {
        jobId,
        providerId: request.providerId,
        taskId: request.taskId,
      });
      await inspectAndHashStagingOutput(
        reservation.stagingPath,
        providerExecution,
        providerOutputSha256,
        request.parameters.durationSeconds,
      );
      throwIfAborted(signal);
      onPhase('SAVING');
      const outputEvidence = await normalizeGeneratedWaveStagingFile(
        reservation.stagingPath,
        { signal },
      );
      this.#logger.debug('ACE', 'OUTPUT_VALIDATED', {
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
      this.#logger.info('ACE', 'OUTPUT_FINALIZED', {
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
        resolvedInputs.map((resolvedInput) => resolvedInput.evidence),
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
        await rm(createAceStepPartialWavPath(reservation.stagingPath), {
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

    const executionError = signal.aborted
      ? cleanupErrors.length > 0
        ? combineCancellationCleanupErrors(primaryError, cleanupErrors)
        : undefined
      : primaryError || cleanupErrors.length > 0
        ? combineExecutionErrors(primaryError, cleanupErrors)
        : undefined;

    if (this.#activeExecution === activeExecution) {
      this.#activeExecution = undefined;
    }

    activeExecution.settleExecution(
      Object.freeze(executionError ? { error: executionError } : {}),
    );

    if (executionError) {
      this.#logger.error('ACE', 'JOB_FAILED', {
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
      throw new AceStepJobExecutorError(
        'ACE_STEP_EXECUTOR_JOB_MISMATCH',
        `Cannot terminate ${jobId} while ${activeExecution.jobId} is active.`,
      );
    }

    let terminationError;
    this.#logger.info('ACE', 'JOB_CANCEL_REQUESTED', { jobId });

    try {
      await this.#terminateExecution(activeExecution);
    } catch (error) {
      terminationError = error;
    }

    const settlement = await activeExecution.settlementPromise;

    if (terminationError) {
      throw terminationError;
    }

    if (settlement.error) {
      throw settlement.error;
    }
  }

  async shutdown() {
    if (this.#activeExecution) {
      await this.#terminateExecution(this.#activeExecution);
    }
  }

  #terminateExecution(activeExecution) {
    if (!activeExecution.terminationPromise) {
      activeExecution.terminationPromise =
        activeExecution.client?.terminate() ?? Promise.resolve();
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

function validateGuideSource(value, taskId) {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_GUIDE_SOURCE_INVALID',
      'ACE-Step Guide source is invalid.',
    );
  }

  if (taskId === ACE_STEP_COVER_TASK_ID) {
    if (
      !hasExactKeys(value, ['artifactId', 'clipTakeId', 'kind', 'relativePath']) ||
      !isIdentity(value.artifactId) ||
      !isIdentity(value.clipTakeId) ||
      value.kind !== 'active-audio-take' ||
      !isAudioRelativePath(value.relativePath)
    ) {
      throw new AceStepJobExecutorError(
        'ACE_STEP_QUEUE_GUIDE_SOURCE_INVALID',
        'ACE-Step Cover requires one exact Active Audio Take source.',
      );
    }

    return Object.freeze({
      artifactId: value.artifactId,
      clipTakeId: value.clipTakeId,
      kind: 'active-audio-take',
      relativePath: value.relativePath,
    });
  }

  if (value.kind === 'midi-instrument-guide') {
    if (
      !hasExactKeys(value, ['artifactId', 'clipTakeId', 'kind']) ||
      !isIdentity(value.artifactId) ||
      !isIdentity(value.clipTakeId)
    ) {
      throw new AceStepJobExecutorError(
        'ACE_STEP_QUEUE_GUIDE_SOURCE_INVALID',
        'ACE-Step MIDI Instrument Guide source is invalid.',
      );
    }

    return Object.freeze({
      artifactId: value.artifactId,
      clipTakeId: value.clipTakeId,
      kind: 'midi-instrument-guide',
    });
  }

  if (value.kind === 'stable-audio-3-text-to-audio') {
    if (
      !hasExactKeys(value, [
        'artifactId',
        'clipTakeId',
        'kind',
        'modelId',
        'modelRevision',
        'providerId',
        'taskId',
      ]) ||
      !isIdentity(value.artifactId) ||
      !isIdentity(value.clipTakeId) ||
      value.providerId !== STABLE_AUDIO_3_PROVIDER_ID ||
      value.modelId !== STABLE_AUDIO_3_MODEL_ID ||
      value.modelRevision !== STABLE_AUDIO_3_MODEL_REVISION ||
      value.taskId !== STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID
    ) {
      throw new AceStepJobExecutorError(
        'ACE_STEP_QUEUE_GUIDE_SOURCE_INVALID',
        'ACE-Step SA3 Text-to-Audio Guide source is invalid.',
      );
    }

    return Object.freeze({
      artifactId: value.artifactId,
      clipTakeId: value.clipTakeId,
      kind: 'stable-audio-3-text-to-audio',
      modelId: STABLE_AUDIO_3_MODEL_ID,
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      taskId: STABLE_AUDIO_3_TEXT_TO_AUDIO_TASK_ID,
    });
  }

  throw new AceStepJobExecutorError(
    'ACE_STEP_QUEUE_GUIDE_SOURCE_INVALID',
    'ACE-Step Guide source kind is unsupported.',
  );
}

function validateLineage(value, guideSource) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['parentArtifactIds', 'parentClipTakeIds']) ||
    !Array.isArray(value.parentArtifactIds) ||
    value.parentArtifactIds.length !== 2 ||
    !Array.isArray(value.parentClipTakeIds) ||
    value.parentClipTakeIds.length !== 1
  ) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_LINEAGE_INVALID',
      'ACE-Step requires Guide Audio and Lyrics parent Artifacts plus one exact Guide source Clip Take.',
    );
  }

  const parentArtifactIds = value.parentArtifactIds.map((artifactId) =>
    validateIdentity(artifactId, 'parent Artifact'),
  );

  if (parentArtifactIds[0] === parentArtifactIds[1]) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_LINEAGE_INVALID',
      'ACE-Step Guide Audio and Lyrics parent Artifact IDs must be distinct.',
    );
  }

  if (parentArtifactIds[0] !== guideSource.artifactId) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_LINEAGE_INVALID',
      'ACE-Step Guide Audio lineage must match the exact Guide source Artifact.',
    );
  }

  const parentClipTakeId = validateIdentity(
    value.parentClipTakeIds[0],
    'Guide source Clip Take',
  );

  if (parentClipTakeId !== guideSource.clipTakeId) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_LINEAGE_INVALID',
      'ACE-Step lineage must match the exact Guide source Clip Take.',
    );
  }

  return Object.freeze({
    parentArtifactIds: Object.freeze(parentArtifactIds),
    parentClipTakeIds: Object.freeze([parentClipTakeId]),
  });
}

function validateTextToMusicLineage(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['parentArtifactIds', 'parentClipTakeIds']) ||
    !Array.isArray(value.parentArtifactIds) ||
    value.parentArtifactIds.length !== 1 ||
    !Array.isArray(value.parentClipTakeIds) ||
    value.parentClipTakeIds.length !== 0
  ) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_LINEAGE_INVALID',
      'ACE-Step Text to Music requires one Lyrics parent Artifact and no parent Clip Take.',
    );
  }

  return Object.freeze({
    parentArtifactIds: Object.freeze([
      validateIdentity(value.parentArtifactIds[0], 'Lyrics parent Artifact'),
    ]),
    parentClipTakeIds: Object.freeze([]),
  });
}

function validateInputs(value, lineage, guideSource) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !isAudioInputArtifact(value[0]) ||
    !isAudioRelativePath(value[0].relativePath) ||
    !isLyricsInputArtifact(value[1]) ||
    !isLyricsRelativePath(value[1].relativePath)
  ) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_INPUTS_INVALID',
      'ACE-Step requires one allowlisted Project Guide Audio WAV and one renders/ace-step/lyrics UTF-8 text Artifact.',
    );
  }

  const artifactIds = value.map((artifact) =>
    validateIdentity(artifact.artifactId, 'input Artifact'),
  );

  if (artifactIds.some((artifactId, index) => artifactId !== lineage.parentArtifactIds[index])) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_INPUTS_INVALID',
      'ACE-Step input Artifacts must match Guide Audio and Lyrics lineage order.',
    );
  }

  const expectedGuidePath =
    guideSource.kind === 'active-audio-take'
      ? guideSource.relativePath
      : guideSource.kind === 'stable-audio-3-text-to-audio'
      ? `renders/stable-audio-3/${guideSource.artifactId}.wav`
      : `renders/instruments/${guideSource.artifactId}.wav`;

  if (value[0].relativePath !== expectedGuidePath) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_INPUTS_INVALID',
      'ACE-Step Guide Audio path does not match its exact source role and Artifact identity.',
    );
  }

  return Object.freeze(
    value.map((artifact, index) =>
      Object.freeze(index === 0
        ? {
            artifactId: artifactIds[index],
            kind: artifact.kind,
            relativePath: artifact.relativePath,
            sizeBytes: artifact.sizeBytes,
          }
        : {
            artifactId: artifactIds[index],
            kind: artifact.kind,
            relativePath: artifact.relativePath,
          }),
    ),
  );
}

function validateTextToMusicInputs(value, lineage) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !isLyricsInputArtifact(value[0]) ||
    !isLyricsRelativePath(value[0].relativePath)
  ) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_INPUTS_INVALID',
      'ACE-Step Text to Music requires one renders/ace-step/lyrics UTF-8 text Artifact.',
    );
  }

  const artifactId = validateIdentity(value[0].artifactId, 'input Artifact');

  if (artifactId !== lineage.parentArtifactIds[0]) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_INPUTS_INVALID',
      'ACE-Step Text to Music Lyrics input must match its lineage.',
    );
  }

  return Object.freeze([
    Object.freeze({
      artifactId,
      kind: 'lyrics',
      relativePath: value[0].relativePath,
    }),
  ]);
}

function validateOutput(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['artifactKind', 'destination', 'extension']) ||
    value.artifactKind !== 'audio' ||
    value.destination !== ACE_STEP_OUTPUT_DESTINATION ||
    value.extension !== '.wav' ||
    !Object.prototype.hasOwnProperty.call(
      GENERATED_ARTIFACT_DESTINATIONS,
      value.destination,
    )
  ) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_OUTPUT_INVALID',
      'ACE-Step output must be one .wav in the ace-step Project destination.',
    );
  }

  return Object.freeze({
    artifactKind: 'audio',
    destination: ACE_STEP_OUTPUT_DESTINATION,
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
    throw new AceStepJobExecutorError(
      'ACE_STEP_QUEUE_LINEAGE_INVALID',
      `ACE-Step ${label} ID must be non-empty, trimmed, and at most 256 characters.`,
    );
  }

  return value;
}

function isIdentity(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value
  );
}

function isAudioInputArtifact(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['artifactId', 'kind', 'relativePath', 'sizeBytes']) &&
    value.kind === 'audio' &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes > 44 &&
    value.sizeBytes <= MAX_GENERATED_WAV_BYTES
  );
}

function isLyricsInputArtifact(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['artifactId', 'kind', 'relativePath']) &&
    value.kind === 'lyrics'
  );
}

function isAudioRelativePath(value) {
  return (
    isSafeRelativeArtifactPath(value, '.wav') &&
    GENERATED_AUDIO_PROJECT_DIRECTORIES.some(
      (directory) =>
        value.startsWith(`${directory}/`) && value.length > directory.length + 1,
    )
  );
}

function isLyricsRelativePath(value) {
  return (
    isSafeRelativeArtifactPath(value, '.txt') &&
    value.startsWith(`${LYRICS_PROJECT_DIRECTORY}/`) &&
    value.length > LYRICS_PROJECT_DIRECTORY.length + 1
  );
}

function isSafeRelativeArtifactPath(value, extension) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    !value.toLowerCase().endsWith(extension) ||
    value.toLowerCase().includes('.partial.') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value)
  ) {
    return false;
  }

  return value.split('/').every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.includes(':'),
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
    throw new AceStepJobExecutorError(
      'ACE_STEP_EXECUTION_CONTEXT_INVALID',
      'ACE-Step execution context is invalid.',
    );
  }
}

async function resolveProjectInput(projectRootAuthority, inputArtifact) {
  const projectRoot = projectRootAuthority.getSnapshot();

  if (projectRoot.status !== 'READY') {
    throw new AceStepJobExecutorError(
      'PROJECT_ROOT_REQUIRED',
      'Select a Project Root before running ACE-Step.',
    );
  }

  let inputHandle;

  try {
    const requestedPath = resolveProjectPath(
      projectRoot.rootPath,
      inputArtifact.relativePath,
    );
    const requestedStat = await lstat(requestedPath);
    const maximumSize =
      inputArtifact.kind === 'audio' ? MAX_GENERATED_WAV_BYTES : MAX_LYRICS_BYTES;
    const minimumSize = inputArtifact.kind === 'audio' ? 45 : 1;

    if (
      !requestedStat.isFile() ||
      requestedStat.isSymbolicLink() ||
      requestedStat.size < minimumSize ||
      requestedStat.size > maximumSize ||
      (inputArtifact.kind === 'audio' &&
        requestedStat.size !== inputArtifact.sizeBytes)
    ) {
      throw invalidInput(inputArtifact.kind);
    }

    const canonicalPath = await realpath(requestedPath);
    const relativeCanonicalPath = relative(projectRoot.rootPath, canonicalPath);

    if (
      relativeCanonicalPath === '' ||
      relativeCanonicalPath.startsWith('..') ||
      isAbsolute(relativeCanonicalPath)
    ) {
      throw new AceStepJobExecutorError(
        'ACE_STEP_INPUT_OUTSIDE_PROJECT',
        'ACE-Step inputs must remain inside the active Project Root.',
      );
    }

    inputHandle = await open(canonicalPath, 'r');
    const openedStat = await inputHandle.stat();

    if (!openedStat.isFile() || openedStat.size !== requestedStat.size) {
      throw inputChanged();
    }

    if (inputArtifact.kind === 'audio') {
      await validateOpenedWaveInput(inputHandle);
    } else {
      await validateOpenedLyricsInput(inputHandle, openedStat.size);
    }

    const sha256 = await hashOpenFile(inputHandle, openedStat.size);

    if ((await inputHandle.stat()).size !== openedStat.size) {
      throw inputChanged();
    }

    return Object.freeze({
      artifact: Object.freeze({
        artifactId: inputArtifact.artifactId,
        kind: inputArtifact.kind,
        path: canonicalPath,
      }),
      evidence: Object.freeze({
        artifactId: inputArtifact.artifactId,
        kind: inputArtifact.kind,
        sha256,
        sizeBytes: openedStat.size,
      }),
    });
  } catch (error) {
    if (error instanceof AceStepJobExecutorError) {
      throw error;
    }

    throw new AceStepJobExecutorError(
      'ACE_STEP_INPUT_UNAVAILABLE',
      `ACE-Step ${inputArtifact.kind} input is unavailable.`,
      { cause: error },
    );
  } finally {
    await inputHandle?.close().catch(() => undefined);
  }
}

async function validateOpenedWaveInput(inputHandle) {
  const header = Buffer.allocUnsafe(12);
  const { bytesRead } = await inputHandle.read(header, 0, header.length, 0);

  if (
    bytesRead !== header.length ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw invalidInput('audio');
  }
}

async function validateOpenedLyricsInput(inputHandle, sizeBytes) {
  const bytes = Buffer.allocUnsafe(sizeBytes);
  const { bytesRead } = await inputHandle.read(bytes, 0, bytes.length, 0);

  if (
    bytesRead !== bytes.length ||
    (bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf) ||
    bytes.includes(0)
  ) {
    throw invalidInput('lyrics');
  }

  let lyrics;

  try {
    lyrics = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw invalidInput('lyrics', error);
  }

  if (
    lyrics.trim().length === 0 ||
    lyrics.length > MAX_LYRICS_CHARACTERS
  ) {
    throw invalidInput('lyrics');
  }
}

function invalidInput(kind, cause) {
  return new AceStepJobExecutorError(
    'ACE_STEP_INPUT_INVALID',
    kind === 'audio'
      ? 'ACE-Step Guide Audio must be a supported regular Project RIFF/WAVE file.'
      : 'ACE-Step Lyrics must be a regular, non-empty, BOM-less UTF-8 Project text file.',
    cause === undefined ? undefined : { cause },
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
    const sha256 = await hashOpenFile(inputHandle, openedStat.size);

    if (
      !openedStat.isFile() ||
      openedStat.size !== expectedEvidence.sizeBytes ||
      (await inputHandle.stat()).size !== openedStat.size ||
      sha256 !== expectedEvidence.sha256
    ) {
      throw inputChanged();
    }
  } catch (error) {
    if (error instanceof AceStepJobExecutorError) {
      throw error;
    }

    throw inputChanged(error);
  } finally {
    await inputHandle?.close().catch(() => undefined);
  }
}

function inputChanged(cause) {
  return new AceStepJobExecutorError(
    'ACE_STEP_INPUT_CHANGED',
    'ACE-Step Guide Audio or Lyrics changed during execution.',
    cause === undefined ? undefined : { cause },
  );
}

async function hashOpenFile(
  fileHandle,
  sizeBytes,
  createShortReadError = inputChanged,
) {
  const digest = createHash('sha256');
  const hashBuffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let position = 0;

  while (position < sizeBytes) {
    const { bytesRead } = await fileHandle.read(
      hashBuffer,
      0,
      Math.min(hashBuffer.length, sizeBytes - position),
      position,
    );

    if (bytesRead === 0) {
      break;
    }

    digest.update(hashBuffer.subarray(0, bytesRead));
    position += bytesRead;
  }

  if (position !== sizeBytes) {
    throw createShortReadError();
  }

  return digest.digest('hex');
}

async function assertInternalPartialMissing(stagingPath) {
  const partialWavPath = createAceStepPartialWavPath(stagingPath);

  try {
    await lstat(partialWavPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  throw new AceStepJobExecutorError(
    'ACE_STEP_PARTIAL_OUTPUT_RETAINED',
    'ACE-Step Worker retained an internal .partial.wav file.',
  );
}

function readProviderOutputSha256(providerExecution) {
  const sha256 = providerExecution?.artifact?.sha256;

  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_PROVIDER_OUTPUT_EVIDENCE_INVALID',
      'ACE-Step Worker output hash evidence is invalid.',
    );
  }

  return sha256;
}

async function inspectAndHashStagingOutput(
  stagingPath,
  providerExecution,
  providerOutputSha256,
  requestedDurationSeconds,
) {
  const stagingStat = await lstat(stagingPath);

  if (
    !stagingStat.isFile() ||
    stagingStat.isSymbolicLink() ||
    stagingStat.size <= 44 ||
    stagingStat.size > MAX_GENERATED_WAV_BYTES ||
    stagingStat.size !== providerExecution.artifact.bytesWritten
  ) {
    throw new AceStepJobExecutorError(
      'ACE_STEP_STAGING_OUTPUT_MISMATCH',
      'ACE-Step staging output does not match its reported metadata.',
    );
  }

  const stagingHandle = await open(stagingPath, 'r');

  try {
    const openedStat = await stagingHandle.stat();
    const headerLength = Math.min(openedStat.size, MAX_WAV_HEADER_BYTES);
    const header = Buffer.allocUnsafe(headerLength);
    const { bytesRead } = await stagingHandle.read(header, 0, header.length, 0);

    if (bytesRead !== header.length) {
      throw invalidStagingWave();
    }

    const wave = parseWaveHeader(header, openedStat.size);

    if (
      wave.channels !== ACE_STEP_CHANNELS ||
      wave.sampleRate !== ACE_STEP_SAMPLE_RATE ||
      !(
        (wave.formatTag === 1 && wave.bitsPerSample === 16) ||
        (wave.formatTag === 3 && wave.bitsPerSample === 32)
      ) ||
      Math.abs(wave.durationSeconds - providerExecution.artifact.durationSeconds) > 0.1 ||
      Math.abs(wave.durationSeconds - requestedDurationSeconds) > 0.1
    ) {
      throw invalidStagingWave();
    }

    const sha256 = await hashOpenFile(
      stagingHandle,
      openedStat.size,
      stagingOutputChanged,
    );

    if (
      (await stagingHandle.stat()).size !== openedStat.size ||
      sha256 !== providerOutputSha256
    ) {
      throw stagingOutputChanged();
    }

    return Object.freeze({
      bitsPerSample: wave.bitsPerSample,
      channels: wave.channels,
      durationSeconds: wave.durationSeconds,
      formatTag: wave.formatTag,
      sampleRate: wave.sampleRate,
      sha256,
      sizeBytes: openedStat.size,
    });
  } finally {
    await stagingHandle.close().catch(() => undefined);
  }
}

function parseWaveHeader(header, fileSize) {
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
      if (format || chunkSize < 16 || chunkStart + 16 > header.length) {
        throw invalidStagingWave();
      }

      format = {
        bitsPerSample: header.readUInt16LE(chunkStart + 14),
        blockAlign: header.readUInt16LE(chunkStart + 12),
        byteRate: header.readUInt32LE(chunkStart + 8),
        channels: header.readUInt16LE(chunkStart + 2),
        formatTag: header.readUInt16LE(chunkStart),
        sampleRate: header.readUInt32LE(chunkStart + 4),
      };
    } else if (chunkId === 'data') {
      if (dataSize !== undefined) {
        throw invalidStagingWave();
      }
      dataSize = chunkSize;
    }

    if (format && dataSize !== undefined) {
      break;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  const expectedBlockAlign = format
    ? (format.channels * format.bitsPerSample) / 8
    : 0;

  if (
    !format ||
    dataSize === undefined ||
    format.channels <= 0 ||
    format.sampleRate <= 0 ||
    format.bitsPerSample <= 0 ||
    format.blockAlign !== expectedBlockAlign ||
    format.byteRate !== format.sampleRate * format.blockAlign ||
    dataSize === 0 ||
    dataSize % format.blockAlign !== 0
  ) {
    throw invalidStagingWave();
  }

  return Object.freeze({
    bitsPerSample: format.bitsPerSample,
    channels: format.channels,
    durationSeconds: dataSize / format.byteRate,
    formatTag: format.formatTag,
    sampleRate: format.sampleRate,
  });
}

function invalidStagingWave() {
  return new AceStepJobExecutorError(
    'ACE_STEP_STAGING_WAV_INVALID',
    'ACE-Step staging output must be the requested stereo PCM16 or IEEE float32 WAVE file.',
  );
}

function stagingOutputChanged() {
  return new AceStepJobExecutorError(
    'ACE_STEP_STAGING_OUTPUT_CHANGED',
    'ACE-Step staging output changed or does not match Worker hash evidence.',
  );
}

function createCompletedAudioJobResult(
  request,
  providerExecution,
  finalizedArtifact,
  inputEvidence,
  outputEvidence,
) {
  const isTextToMusic = request.taskId === ACE_STEP_TEXT_TO_MUSIC_TASK_ID;
  const isCover = request.taskId === ACE_STEP_COVER_TASK_ID;
  const guideAudioEvidence = isTextToMusic ? undefined : inputEvidence[0];
  const lyricsEvidence = inputEvidence[isTextToMusic ? 0 : 1];
  const taskEvidence = isTextToMusic
    ? {
        bpm: request.parameters.bpm,
        guidanceScale: request.parameters.guidanceScale,
        inferenceSteps: request.parameters.inferenceSteps,
        instruction: ACE_STEP_TEXT_TO_MUSIC_GENERATION_INSTRUCTION,
        instrumental: request.parameters.instrumental,
        keyscale: request.parameters.keyscale,
        lyricsArtifactId: lyricsEvidence.artifactId,
        lyricsSha256: lyricsEvidence.sha256,
        lyricsSizeBytes: lyricsEvidence.sizeBytes,
        timesignature: request.parameters.timesignature,
      }
    : isCover
      ? {
          audioCoverStrength: request.parameters.audioCoverStrength,
          coverNoiseStrength: request.parameters.coverNoiseStrength,
          guideAudioArtifactId: guideAudioEvidence.artifactId,
          guideAudioClipTakeId: request.guideSource.clipTakeId,
          guideAudioRelativePath: request.inputArtifacts[0].relativePath,
          guideAudioSha256: guideAudioEvidence.sha256,
          guideAudioSizeBytes: guideAudioEvidence.sizeBytes,
          guidanceScale: request.parameters.guidanceScale,
          inferenceSteps: request.parameters.inferenceSteps,
          instruction: ACE_STEP_COVER_GENERATION_INSTRUCTION,
          lyricsArtifactId: lyricsEvidence.artifactId,
          lyricsSha256: lyricsEvidence.sha256,
          lyricsSizeBytes: lyricsEvidence.sizeBytes,
        }
      : {
        guideAudioArtifactId: guideAudioEvidence.artifactId,
        guideAudioClipTakeId: request.guideSource.clipTakeId,
        guideAudioRelativePath: request.inputArtifacts[0].relativePath,
        guideAudioSha256: guideAudioEvidence.sha256,
        guideAudioSizeBytes: guideAudioEvidence.sizeBytes,
        guidanceScale: ACE_STEP_GUIDANCE_SCALE,
        inferenceSteps: ACE_STEP_INFERENCE_STEPS,
        instruction: ACE_STEP_GENERATION_INSTRUCTION,
        lyricsArtifactId: lyricsEvidence.artifactId,
        lyricsSha256: lyricsEvidence.sha256,
        lyricsSizeBytes: lyricsEvidence.sizeBytes,
      };

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
        ...taskEvidence,
        cfgIntervalEnd: ACE_STEP_CFG_INTERVAL_END,
        cfgIntervalStart: ACE_STEP_CFG_INTERVAL_START,
        dcwEnabled: ACE_STEP_DCW_ENABLED,
        modelRevision: request.modelRevision,
        outputEncoding:
          outputEvidence.formatTag === 3 ? 'IEEE_FLOAT32' : 'PCM16',
        outputSha256: outputEvidence.sha256,
        runtimeProfileId: ACE_STEP_RUNTIME_PROFILE_ID,
        sampleRate: outputEvidence.sampleRate,
        shift: ACE_STEP_SHIFT,
        thinking: false,
        useAdg: ACE_STEP_USE_ADG,
      }),
      mimeType: providerExecution.artifact.mimeType,
      providerCompletedAt: providerExecution.completedAt,
    }),
  });
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw new AceStepJobExecutorError('JOB_ABORTED', 'ACE-Step Job was aborted.');
  }
}

function combineExecutionErrors(primaryError, cleanupErrors) {
  if (!primaryError && cleanupErrors.length === 1) {
    return cleanupErrors[0];
  }

  if (!primaryError) {
    const error = new AggregateError(cleanupErrors, 'ACE-Step Job cleanup failed.');
    error.code = 'ACE_STEP_JOB_CLEANUP_FAILED';
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

function combineCancellationCleanupErrors(primaryError, cleanupErrors) {
  const errors = primaryError
    ? [primaryError, ...cleanupErrors]
    : cleanupErrors;
  const error = new AggregateError(
    errors,
    'ACE-Step cancellation cleanup failed.',
    primaryError ? { cause: primaryError } : undefined,
  );
  error.code = 'ACE_STEP_CANCELLATION_CLEANUP_FAILED';
  return error;
}

function readErrorCode(error) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'ACE_STEP_JOB_EXECUTION_FAILED';
}

function readErrorMessage(error) {
  return error instanceof Error ? error.message : 'ACE-Step Job failed.';
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
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    return false;
  }
  keys.sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isNodeError(value) {
  return value instanceof Error && 'code' in value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
