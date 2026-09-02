import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import {
  PRINT_MIX_BITS_PER_SAMPLE,
  PRINT_MIX_CHANNELS,
  PRINT_MIX_EXTENSION,
  PRINT_MIX_MIME_TYPE,
  PRINT_MIX_NORMALIZE_TARGET_DBFS,
  PRINT_MIX_NORMALIZE_TARGET_PEAK,
  PRINT_MIX_PLAN_VERSION,
  PRINT_MIX_PROTOCOL_VERSION,
  PRINT_MIX_RENDERER_ID,
  PRINT_MIX_RENDERER_VERSION,
  PRINT_MIX_SAMPLE_RATE,
  createPrintMixArtifactId,
  isPrintMixOperationId,
} from '../shared/printMixProtocol.js';
import {
  renderPrintMixPcm,
  validatePrintMixAudioPlan,
} from './printMixPcmRenderer.mjs';

const KNOWN_UNCOMMITTED_FINALIZATION_FAILURE_CODES = new Set([
  'ARTIFACT_DESTINATION_EXISTS',
  'ARTIFACT_RESERVATION_BUSY',
  'ARTIFACT_RESERVATION_INVALID',
  'ARTIFACT_RESERVATION_NOT_FOUND',
  'ARTIFACT_STAGING_EMPTY',
  'ARTIFACT_STAGING_INVALID',
  'ARTIFACT_STAGING_MISSING',
]);

export class PrintMixServiceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'PrintMixServiceError';
  }
}

export class PrintMixService {
  #active = false;
  #generatedArtifactFinalizer;
  #generatedAudioReader;
  #renderer;

  constructor({
    generatedArtifactFinalizer,
    generatedAudioReader,
    renderer = { render: renderPrintMixPcm },
  }) {
    if (
      !generatedArtifactFinalizer ||
      typeof generatedArtifactFinalizer.reserve !== 'function' ||
      typeof generatedArtifactFinalizer.finalize !== 'function' ||
      typeof generatedArtifactFinalizer.discard !== 'function'
    ) {
      throw new TypeError('PrintMixService requires a GeneratedArtifactFinalizer.');
    }
    if (
      !generatedAudioReader ||
      typeof generatedAudioReader.readWav !== 'function'
    ) {
      throw new TypeError('PrintMixService requires a GeneratedAudioReader.');
    }
    if (!renderer || typeof renderer.render !== 'function') {
      throw new TypeError('PrintMixService requires a PRINT MIX renderer.');
    }

    this.#generatedArtifactFinalizer = generatedArtifactFinalizer;
    this.#generatedAudioReader = generatedAudioReader;
    this.#renderer = renderer;
  }

  async renderAndSave(planValue, options = {}) {
    const plan = freezeRecursively(
      validatePrintMixAudioPlan(structuredClone(planValue)),
    );
    const artifactId = createPrintMixArtifactId(plan.operationId);

    if (
      !artifactId ||
      !isRecord(options) ||
      Object.keys(options).some((key) => key !== 'signal') ||
      (options.signal !== undefined &&
        (!isRecord(options.signal) || typeof options.signal.aborted !== 'boolean'))
    ) {
      throw new PrintMixServiceError(
        'PRINT_MIX_EXECUTION_INVALID',
        'Audio PRINT MIX execution identity is invalid.',
      );
    }

    if (this.#active) {
      throw new PrintMixServiceError(
        'PRINT_MIX_SERVICE_BUSY',
        'Another Audio PRINT MIX operation is active.',
      );
    }

    this.#active = true;
    let reservation;
    let finalized = false;
    let primaryError;
    let result;

    try {
      throwIfAborted(options.signal);
      reservation = await this.#generatedArtifactFinalizer.reserve({
        artifactId,
        destination: 'print-mix',
        extension: '.wav',
      });
      const sourceBytes = await this.#readSources(plan.sources, options.signal);
      throwIfAborted(options.signal);
      const rendered = await this.#renderer.render(plan, sourceBytes, {});
      validateRenderedResult(rendered, plan);
      throwIfAborted(options.signal);
      await writeFile(reservation.stagingPath, rendered.bytes, { flag: 'r+' });
      throwIfAborted(options.signal);
      const artifact = await this.#finalize(reservation);
      finalized = true;
      try {
        result = createCompletedResult(plan, rendered, artifact);
      } catch (error) {
        throw new PrintMixServiceError(
          'PRINT_MIX_OUTCOME_UNKNOWN',
          'Audio PRINT MIX finalized, but its completed outcome could not be verified; recover with the same operationId.',
          { cause: error },
        );
      }
    } catch (error) {
      primaryError = error;
    }

    const cleanupErrors = [];

    if (reservation && !finalized) {
      try {
        await this.#generatedArtifactFinalizer.discard(
          reservation.reservationId,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    this.#active = false;

    if (primaryError || cleanupErrors.length > 0) {
      if (
        primaryError?.code === 'PRINT_MIX_OUTCOME_UNKNOWN' &&
        cleanupErrors.length > 0
      ) {
        throw new PrintMixServiceError(
          'PRINT_MIX_OUTCOME_UNKNOWN',
          'Audio PRINT MIX finalization outcome is unknown; recover with the same operationId.',
          {
            cause: new AggregateError(
              [primaryError, ...cleanupErrors],
              'Unknown PRINT MIX finalization also prevented staging cleanup.',
            ),
          },
        );
      }
      if (primaryError && cleanupErrors.length === 0) {
        throw primaryError;
      }
      throw new AggregateError(
        [primaryError, ...cleanupErrors].filter(Boolean),
        'Audio PRINT MIX failed and cleanup was incomplete.',
      );
    }

    return result;
  }

  async #readSources(descriptors, signal) {
    const sourceBytes = new Map();

    for (const descriptor of descriptors) {
      throwIfAborted(signal);
      const result = await this.#generatedAudioReader.readWav(descriptor);

      if (
        !Buffer.isBuffer(result?.bytes) ||
        result.bytes.byteLength !== descriptor.sizeBytes ||
        result.contentLength !== result.bytes.byteLength ||
        result.contentType !== 'audio/wav'
      ) {
        throw new PrintMixServiceError(
          'PRINT_MIX_SOURCE_READ_INVALID',
          `Audio PRINT MIX source ${descriptor.sourceId} returned invalid bytes.`,
        );
      }

      sourceBytes.set(descriptor.sourceId, result.bytes);
    }

    return sourceBytes;
  }

  async #finalize(reservation) {
    try {
      return await this.#generatedArtifactFinalizer.finalize(
        reservation.reservationId,
      );
    } catch (error) {
      if (!KNOWN_UNCOMMITTED_FINALIZATION_FAILURE_CODES.has(error?.code)) {
        throw new PrintMixServiceError(
          'PRINT_MIX_OUTCOME_UNKNOWN',
          'Audio PRINT MIX finalization outcome is unknown; recover with the same operationId.',
          { cause: error },
        );
      }
      throw error;
    }
  }
}

export class PrintMixOperationCoordinator {
  #accepting = true;
  #activeOperation;
  #onActiveChange;
  #operations = new Map();
  #service;

  constructor({ onActiveChange = () => undefined, service }) {
    if (!service || typeof service.renderAndSave !== 'function') {
      throw new TypeError('PrintMixOperationCoordinator requires a PrintMixService.');
    }
    if (typeof onActiveChange !== 'function') {
      throw new TypeError('PRINT MIX activity callback must be a function.');
    }
    this.#onActiveChange = onActiveChange;
    this.#service = service;
  }

  async execute(
    requestValue,
    { abortController = new AbortController(), getBlockingOperation } = {},
  ) {
    const request = snapshotRequest(requestValue);
    const canonicalPlanJson = JSON.stringify(request.plan);
    const existing = this.#operations.get(request.operationId);

    if (existing) {
      if (existing.canonicalPlanJson !== canonicalPlanJson) {
        throw new PrintMixServiceError(
          'PRINT_MIX_OPERATION_CONFLICT',
          'PRINT MIX operationId is already bound to a different immutable Plan.',
        );
      }
      return existing.promise;
    }

    if (!this.#accepting) {
      throw new PrintMixServiceError(
        'ENGINE_CLOSING',
        'Local Engine is closing and cannot start Audio PRINT MIX.',
      );
    }

    if (this.#activeOperation) {
      throw new PrintMixServiceError(
        'PRINT_MIX_OPERATION_BUSY',
        'Another PRINT MIX operation is active.',
      );
    }

    if (
      getBlockingOperation !== undefined &&
      typeof getBlockingOperation !== 'function'
    ) {
      throw new TypeError('PRINT MIX blocking-operation reader must be a function.');
    }
    if (getBlockingOperation?.()) {
      throw new PrintMixServiceError(
        'ENGINE_OPERATION_ACTIVE',
        'Local Engine is busy with another operation.',
      );
    }
    validateAbortController(abortController);

    const operation = {
      abortController,
      canonicalPlanJson,
      operationId: request.operationId,
      promise: undefined,
    };
    this.#activeOperation = operation;
    this.#onActiveChange(true, operation.operationId);
    const promise = this.#service
      .renderAndSave(request.plan, { signal: abortController.signal })
      .then((result) => {
        let completedResult;

        try {
          completedResult = snapshotCompletedResult(result, request.plan);
        } catch (error) {
          throw new PrintMixServiceError(
            'PRINT_MIX_OUTCOME_UNKNOWN',
            'Audio PRINT MIX completed, but its public outcome could not be verified; recover with the same operationId.',
            { cause: error },
          );
        }

        return freezeRecursively({
          operationId: request.operationId,
          protocolVersion: PRINT_MIX_PROTOCOL_VERSION,
          result: completedResult,
        });
      })
      .catch((error) => {
        if (error?.code !== 'PRINT_MIX_OUTCOME_UNKNOWN') {
          this.#operations.delete(request.operationId);
        }
        throw error;
      })
      .finally(() => {
        if (this.#activeOperation === operation) {
          this.#activeOperation = undefined;
          this.#onActiveChange(false, operation.operationId);
        }
      });

    operation.promise = promise;
    this.#operations.set(request.operationId, operation);
    return promise;
  }

  async shutdown() {
    this.#accepting = false;
    const activeOperation = this.#activeOperation;

    if (!activeOperation) {
      return;
    }

    activeOperation.abortController.abort();

    try {
      await activeOperation.promise;
    } catch {
      // The exact operation outcome remains fixed in memory until process exit.
    }
  }
}

function validateAbortController(value) {
  if (
    !value ||
    typeof value.abort !== 'function' ||
    !value.signal ||
    typeof value.signal.aborted !== 'boolean'
  ) {
    throw new TypeError('Audio PRINT MIX requires one AbortController.');
  }
}

function snapshotRequest(value) {
  if (
    !hasExactKeys(value, ['operationId', 'plan', 'protocolVersion']) ||
    value.protocolVersion !== PRINT_MIX_PROTOCOL_VERSION ||
    !isPrintMixOperationId(value.operationId)
  ) {
    throw requestInvalid();
  }

  let plan;

  try {
    plan = validatePrintMixAudioPlan(structuredClone(value.plan));
  } catch {
    throw requestInvalid();
  }

  if (plan.operationId !== value.operationId) {
    throw requestInvalid();
  }

  return freezeRecursively({
    operationId: value.operationId,
    plan,
    protocolVersion: PRINT_MIX_PROTOCOL_VERSION,
  });
}

function requestInvalid() {
  return new PrintMixServiceError(
    'PRINT_MIX_REQUEST_INVALID',
    'Audio PRINT MIX Request is invalid.',
  );
}

function validateRenderedResult(value, plan) {
  const frameCount = Math.round(plan.durationSeconds * PRINT_MIX_SAMPLE_RATE);

  if (
    !isRecord(value) ||
    !Buffer.isBuffer(value.bytes) ||
    value.bitsPerSample !== PRINT_MIX_BITS_PER_SAMPLE ||
    value.channels !== PRINT_MIX_CHANNELS ||
    value.durationSeconds !== frameCount / PRINT_MIX_SAMPLE_RATE ||
    value.frameCount !== frameCount ||
    value.bytes.byteLength !== 44 + frameCount * 4 ||
    value.mimeType !== PRINT_MIX_MIME_TYPE ||
    value.sampleRate !== PRINT_MIX_SAMPLE_RATE ||
    value.sourceCount !== plan.sources.length ||
    value.normalize !== plan.normalize ||
    value.targetPeakDbfs !== PRINT_MIX_NORMALIZE_TARGET_DBFS ||
    !hasValidCompletedLevels(value, plan.normalize)
  ) {
    throw new PrintMixServiceError(
      'PRINT_MIX_RENDER_RESULT_INVALID',
      'Audio PRINT MIX renderer returned invalid output.',
    );
  }
}

function snapshotCompletedResult(value, plan) {
  const artifactId = createPrintMixArtifactId(plan.operationId);
  const frameCount = Math.round(plan.durationSeconds * PRINT_MIX_SAMPLE_RATE);
  const sizeBytes = 44 + frameCount * 4;
  const planSha256 = createHash('sha256')
    .update(JSON.stringify(plan))
    .digest('hex');
  const artifact = value?.artifact;
  const file = artifact?.file;
  const provenance = artifact?.provenance;
  const printMix = value?.printMix;

  if (
    !artifactId ||
    !hasExactKeys(value, ['artifact', 'printMix', 'status']) ||
    value.status !== 'COMPLETED' ||
    !hasExactKeys(artifact, [
      'artifactId',
      'createdAt',
      'destination',
      'file',
      'kind',
      'provenance',
    ]) ||
    artifact.artifactId !== artifactId ||
    !isIsoTimestamp(artifact.createdAt) ||
    artifact.destination !== 'print-mix' ||
    artifact.kind !== 'audio' ||
    !hasExactKeys(file, ['extension', 'name', 'relativePath', 'sizeBytes']) ||
    file.extension !== PRINT_MIX_EXTENSION ||
    file.name !== `${artifactId}${PRINT_MIX_EXTENSION}` ||
    file.relativePath !== `print-mixes/${file.name}` ||
    file.sizeBytes !== sizeBytes ||
    !hasExactKeys(provenance, [
      'planSha256',
      'planVersion',
      'rendererId',
      'rendererVersion',
    ]) ||
    provenance.planSha256 !== planSha256 ||
    provenance.planVersion !== PRINT_MIX_PLAN_VERSION ||
    provenance.rendererId !== PRINT_MIX_RENDERER_ID ||
    provenance.rendererVersion !== PRINT_MIX_RENDERER_VERSION ||
    !hasExactKeys(printMix, [
      'appliedGain',
      'bitsPerSample',
      'bytesWritten',
      'channels',
      'clippingWarning',
      'durationSeconds',
      'frameCount',
      'mediaType',
      'mimeType',
      'normalize',
      'outputPeak',
      'preNormalizationPeak',
      'sampleRate',
      'sourceCount',
      'targetPeakDbfs',
    ]) ||
    printMix.bitsPerSample !== PRINT_MIX_BITS_PER_SAMPLE ||
    printMix.bytesWritten !== sizeBytes ||
    printMix.channels !== PRINT_MIX_CHANNELS ||
    printMix.durationSeconds !== frameCount / PRINT_MIX_SAMPLE_RATE ||
    printMix.frameCount !== frameCount ||
    printMix.mediaType !== 'audio' ||
    printMix.mimeType !== PRINT_MIX_MIME_TYPE ||
    printMix.normalize !== plan.normalize ||
    printMix.sampleRate !== PRINT_MIX_SAMPLE_RATE ||
    printMix.sourceCount !== plan.sources.length ||
    printMix.targetPeakDbfs !== PRINT_MIX_NORMALIZE_TARGET_DBFS ||
    !hasValidCompletedLevels(printMix, plan.normalize)
  ) {
    throw new PrintMixServiceError(
      'PRINT_MIX_COMPLETED_RESULT_INVALID',
      'Audio PRINT MIX completed with invalid Engine metadata.',
    );
  }

  return freezeRecursively(structuredClone(value));
}

function hasValidCompletedLevels(value, normalize) {
  if (
    !isFiniteNonNegative(value.preNormalizationPeak) ||
    !isFiniteNonNegative(value.outputPeak) ||
    !isFiniteNonNegative(value.appliedGain) ||
    typeof value.clippingWarning !== 'boolean'
  ) {
    return false;
  }

  if (normalize) {
    const expectedGain = value.preNormalizationPeak === 0
      ? 1
      : PRINT_MIX_NORMALIZE_TARGET_PEAK / value.preNormalizationPeak;
    const expectedPeak = value.preNormalizationPeak === 0
      ? 0
      : PRINT_MIX_NORMALIZE_TARGET_PEAK;
    return value.clippingWarning === false &&
      nearlyEqual(value.appliedGain, expectedGain) &&
      nearlyEqual(value.outputPeak, expectedPeak);
  }

  return value.appliedGain === 1 &&
    value.outputPeak === value.preNormalizationPeak &&
    value.clippingWarning === (value.preNormalizationPeak > 1);
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function isIsoTimestamp(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function createCompletedResult(plan, rendered, artifact) {
  const artifactId = createPrintMixArtifactId(plan.operationId);
  const canonicalPlanJson = JSON.stringify(plan);
  const planSha256 = createHash('sha256')
    .update(canonicalPlanJson)
    .digest('hex');

  if (
    !artifactId ||
    artifact?.status !== 'FINALIZED' ||
    artifact.artifactId !== artifactId ||
    artifact.destination !== 'print-mix' ||
    artifact.file?.extension !== '.wav' ||
    artifact.file.name !== `${artifactId}.wav` ||
    artifact.file.relativePath !== `print-mixes/${artifact.file.name}` ||
    artifact.file.sizeBytes !== rendered.bytes.byteLength ||
    typeof artifact.finalizedAt !== 'string'
  ) {
    throw new PrintMixServiceError(
      'PRINT_MIX_FINALIZED_ARTIFACT_INVALID',
      'Audio PRINT MIX finalized Artifact metadata is invalid.',
    );
  }

  return freezeRecursively({
    artifact: {
      artifactId,
      createdAt: artifact.finalizedAt,
      destination: 'print-mix',
      file: { ...artifact.file },
      kind: 'audio',
      provenance: {
        planSha256,
        planVersion: PRINT_MIX_PLAN_VERSION,
        rendererId: PRINT_MIX_RENDERER_ID,
        rendererVersion: PRINT_MIX_RENDERER_VERSION,
      },
    },
    printMix: {
      appliedGain: rendered.appliedGain,
      bitsPerSample: rendered.bitsPerSample,
      bytesWritten: rendered.bytes.byteLength,
      channels: rendered.channels,
      clippingWarning: rendered.clippingWarning,
      durationSeconds: rendered.durationSeconds,
      frameCount: rendered.frameCount,
      mediaType: 'audio',
      mimeType: rendered.mimeType,
      normalize: rendered.normalize,
      outputPeak: rendered.outputPeak,
      preNormalizationPeak: rendered.preNormalizationPeak,
      sampleRate: rendered.sampleRate,
      sourceCount: rendered.sourceCount,
      targetPeakDbfs: rendered.targetPeakDbfs,
    },
    status: 'COMPLETED',
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new PrintMixServiceError(
      'PRINT_MIX_ABORTED',
      'Audio PRINT MIX was canceled before finalization completed.',
    );
  }
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeRecursively(value) {
  if (Array.isArray(value)) {
    value.forEach(freezeRecursively);
  } else if (isRecord(value)) {
    Object.values(value).forEach(freezeRecursively);
  }
  return typeof value === 'object' && value !== null ? Object.freeze(value) : value;
}
