import { createHash } from 'node:crypto';
import { open, realpath, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { PROJECT_STEM_PRINT_PLAN_VERSION } from '../shared/projectStemPrintProtocol.js';
import { createCanonicalProjectRenderPlanJson } from '../shared/projectRenderPlanIdentity.js';
import {
  PROJECT_MIXDOWN_RENDERER_ID,
  PROJECT_MIXDOWN_RENDERER_VERSION,
  RAW_MIXDOWN_BITS_PER_SAMPLE,
  RAW_MIXDOWN_CHANNELS,
  RAW_MIXDOWN_MIME_TYPE,
  RAW_MIXDOWN_SAMPLE_RATE,
} from '../shared/rawMixdownProtocol.js';

import {
  validateProjectPcmMixdownPlan,
} from './projectPcmMixdownRenderer.mjs';
import { parseProjectStemPrintPlan } from './projectStemPrintPlanProtocol.mjs';

export {
  PROJECT_MIXDOWN_RENDERER_ID,
  PROJECT_MIXDOWN_RENDERER_VERSION,
};
export const MAX_PROJECT_MIXDOWN_SOURCE_BYTES = 512 * 1024 * 1024;
const ARTIFACT_ID_PATTERN =
  /^artifact-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KNOWN_UNCOMMITTED_FINALIZATION_FAILURE_CODES = new Set([
  'ARTIFACT_DESTINATION_EXISTS',
  'ARTIFACT_RESERVATION_BUSY',
  'ARTIFACT_RESERVATION_INVALID',
  'ARTIFACT_RESERVATION_NOT_FOUND',
  'ARTIFACT_STAGING_EMPTY',
  'ARTIFACT_STAGING_INVALID',
  'ARTIFACT_STAGING_MISSING',
]);

export class ProjectMixdownServiceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'ProjectMixdownServiceError';
  }
}

export class ProjectMixdownService {
  #active = false;
  #generatedArtifactFinalizer;
  #generatedAudioReader;
  #mixdownRenderer;

  constructor({
    generatedArtifactFinalizer,
    generatedAudioReader,
    mixdownRenderer,
  }) {
    if (
      !generatedArtifactFinalizer ||
      typeof generatedArtifactFinalizer.reserve !== 'function' ||
      typeof generatedArtifactFinalizer.finalize !== 'function' ||
      typeof generatedArtifactFinalizer.discard !== 'function'
    ) {
      throw new TypeError(
        'ProjectMixdownService requires a GeneratedArtifactFinalizer.',
      );
    }

    if (
      !generatedAudioReader ||
      typeof generatedAudioReader.readWav !== 'function'
    ) {
      throw new TypeError('ProjectMixdownService requires a GeneratedAudioReader.');
    }

    if (!mixdownRenderer || typeof mixdownRenderer.render !== 'function') {
      throw new TypeError('ProjectMixdownService requires a Mixdown renderer.');
    }

    this.#generatedArtifactFinalizer = generatedArtifactFinalizer;
    this.#generatedAudioReader = generatedAudioReader;
    this.#mixdownRenderer = mixdownRenderer;
  }

  async renderAndSave(planValue, options = {}) {
    return this.#renderAndSave(planValue, options, 'mixdown');
  }

  async renderStemPrintAndSave(planValue, options = {}) {
    if (typeof this.#mixdownRenderer.renderStemPrint !== 'function') {
      throw new ProjectMixdownServiceError(
        'STEM_PRINT_RENDERER_UNAVAILABLE',
        'Project Stem Print requires a compatible Worker renderer.',
      );
    }

    return this.#renderAndSave(planValue, options, 'stem-print');
  }

  async #renderAndSave(planValue, options, operation) {
    const execution = validateExecutionOptions(options);
    const { artifactId, signal } = execution;

    if (this.#active) {
      throw new ProjectMixdownServiceError(
        'MIXDOWN_SERVICE_BUSY',
        'A Project Mixdown is already active.',
      );
    }

    this.#active = true;
    let finalized = false;
    let primaryError;
    let reservation;
    let result;

    try {
      throwIfAborted(signal);
      const plan = snapshotAndValidatePlan(planValue, operation);
      const stemIdentity = operation === 'stem-print'
        ? createStemPrintIdentity(plan)
        : undefined;
      validateSourceMemoryBudget(plan.sources);
      reservation = await this.#generatedArtifactFinalizer.reserve({
        ...(artifactId ? { artifactId } : {}),
        destination: operation,
        extension: '.wav',
      });
      throwIfAborted(signal);
      const sourceBytes = await this.#readSources(plan.sources, signal);
      throwIfAborted(signal);
      const rendered = operation === 'stem-print'
        ? await this.#mixdownRenderer.renderStemPrint(plan, sourceBytes, {
            signal,
          })
        : await this.#mixdownRenderer.render(plan, sourceBytes, { signal });
      if (operation === 'stem-print') {
        validateStemPrintRenderResult(rendered);
      }
      throwIfAborted(signal);
      await writeFile(reservation.stagingPath, rendered.bytes, { flag: 'r+' });
      throwIfAborted(signal);
      const artifact = await this.#finalizeReservation(reservation, operation);
      if (operation === 'stem-print') {
        validateStemPrintFinalizedArtifact(artifact, reservation, rendered);
      }
      finalized = true;
      result = operation === 'stem-print'
        ? createCompletedStemPrintResult(
            plan,
            rendered,
            artifact,
            stemIdentity,
          )
        : createCompletedResult(plan, rendered, artifact);
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
      throw combineErrors(primaryError, cleanupErrors);
    }

    return result;
  }

  async #finalizeReservation(reservation, operation) {
    try {
      return await this.#generatedArtifactFinalizer.finalize(
        reservation.reservationId,
      );
    } catch (error) {
      if (
        operation === 'stem-print' &&
        !isKnownUncommittedFinalizationFailure(error)
      ) {
        throw new ProjectMixdownServiceError(
          'STEM_PRINT_OUTCOME_UNKNOWN',
          'Project Stem Print finalization outcome is unknown.',
          { cause: error },
        );
      }

      throw error;
    }
  }

  async #readSources(descriptors, signal) {
    const sourceBytes = new Map();

    for (const descriptor of descriptors) {
      throwIfAborted(signal);
      const bytes = descriptor.kind === 'generated'
        ? await this.#readGeneratedSource(descriptor)
        : await readExternalSource(descriptor);
      throwIfAborted(signal);
      sourceBytes.set(descriptor.sourceId, bytes);
    }

    return sourceBytes;
  }

  async #readGeneratedSource(descriptor) {
    const result = await this.#generatedAudioReader.readWav(descriptor);

    if (
      !Buffer.isBuffer(result?.bytes) ||
      result.bytes.byteLength !== descriptor.sizeBytes ||
      result.contentLength !== result.bytes.byteLength ||
      result.contentType !== 'audio/wav'
    ) {
      throw new ProjectMixdownServiceError(
        'MIXDOWN_GENERATED_SOURCE_READ_INVALID',
        `Generated Mixdown source ${descriptor.sourceId} returned invalid bytes.`,
      );
    }

    return result.bytes;
  }
}

function snapshotAndValidatePlan(value, operation) {
  if (operation === 'stem-print') {
    return parseProjectStemPrintPlan(value);
  }

  let snapshot;

  try {
    snapshot = structuredClone(value);
  } catch (error) {
    throw new ProjectMixdownServiceError(
      'MIXDOWN_REQUEST_INVALID',
      'Project Mixdown Plan could not be snapshotted safely.',
      { cause: error },
    );
  }

  return freezePlanSnapshot(validateProjectPcmMixdownPlan(snapshot));
}

function createStemPrintIdentity(plan) {
  const canonicalPlanJson = createCanonicalProjectRenderPlanJson(plan);

  if (canonicalPlanJson === undefined) {
    throw new ProjectMixdownServiceError(
      'STEM_PRINT_PLAN_IDENTITY_INVALID',
      'Project Stem Print Plan cannot be represented by the canonical identity contract.',
    );
  }

  return Object.freeze({
    canonicalPlanJson,
    planSha256: createHash('sha256').update(canonicalPlanJson).digest('hex'),
  });
}

function freezePlanSnapshot(plan) {
  return freezeRecursively(plan);
}

function freezeRecursively(value) {
  if (Array.isArray(value)) {
    value.forEach(freezeRecursively);
  } else if (isRecord(value)) {
    Object.values(value).forEach(freezeRecursively);
  }

  return typeof value === 'object' && value !== null
    ? Object.freeze(value)
    : value;
}

function validateSourceMemoryBudget(descriptors) {
  let totalBytes = 0;

  for (const descriptor of descriptors) {
    totalBytes += descriptor.sizeBytes;

    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_PROJECT_MIXDOWN_SOURCE_BYTES
    ) {
      throw new ProjectMixdownServiceError(
        'MIXDOWN_SOURCE_BUDGET_EXCEEDED',
        'Project Mixdown source bytes exceed the in-memory Engine limit.',
      );
    }
  }
}

async function readExternalSource(descriptor) {
  let canonicalPath;

  try {
    canonicalPath = await realpath(descriptor.path);
  } catch (error) {
    throw mapExternalOpenError(error, descriptor.sourceId);
  }

  let sourceHandle;

  try {
    sourceHandle = await open(canonicalPath, 'r');
    const initialStat = await sourceHandle.stat();

    if (!initialStat.isFile()) {
      throw externalSourceError(
        'MIXDOWN_EXTERNAL_SOURCE_UNOPENABLE',
        descriptor.sourceId,
        'is not a regular file',
      );
    }

    if (
      basename(canonicalPath) !== descriptor.name ||
      initialStat.size !== descriptor.sizeBytes ||
      Math.round(initialStat.mtimeMs) !== descriptor.lastModified
    ) {
      throw externalSourceError(
        'MIXDOWN_EXTERNAL_SOURCE_METADATA_MISMATCH',
        descriptor.sourceId,
        'no longer matches its frozen descriptor',
      );
    }

    const bytes = Buffer.allocUnsafe(initialStat.size);
    let totalBytesRead = 0;

    while (totalBytesRead < bytes.byteLength) {
      const { bytesRead } = await sourceHandle.read(
        bytes,
        totalBytesRead,
        bytes.byteLength - totalBytesRead,
        totalBytesRead,
      );

      if (bytesRead === 0) {
        break;
      }

      totalBytesRead += bytesRead;
    }

    const finalStat = await sourceHandle.stat();

    if (
      totalBytesRead !== initialStat.size ||
      finalStat.size !== initialStat.size ||
      finalStat.mtimeMs !== initialStat.mtimeMs ||
      finalStat.ctimeMs !== initialStat.ctimeMs
    ) {
      throw externalSourceError(
        'MIXDOWN_EXTERNAL_SOURCE_CHANGED',
        descriptor.sourceId,
        'changed while it was being read',
      );
    }

    return bytes;
  } catch (error) {
    if (error instanceof ProjectMixdownServiceError) {
      throw error;
    }

    throw mapExternalOpenError(error, descriptor.sourceId);
  } finally {
    await sourceHandle?.close().catch(() => undefined);
  }
}

function validateExecutionOptions(value) {
  if (!isRecord(value)) {
    throw new ProjectMixdownServiceError(
      'MIXDOWN_EXECUTION_CONTEXT_INVALID',
      'Project Mixdown execution options must be an object.',
    );
  }

  if (
    value.artifactId !== undefined &&
    (typeof value.artifactId !== 'string' ||
      !ARTIFACT_ID_PATTERN.test(value.artifactId))
  ) {
    throw new ProjectMixdownServiceError(
      'MIXDOWN_EXECUTION_CONTEXT_INVALID',
      'Project Mixdown output Artifact identity is invalid.',
    );
  }

  if (
    value.signal !== undefined &&
    (!isRecord(value.signal) || typeof value.signal.aborted !== 'boolean')
  ) {
    throw new ProjectMixdownServiceError(
      'MIXDOWN_EXECUTION_CONTEXT_INVALID',
      'Project Mixdown signal is invalid.',
    );
  }

  return Object.freeze({
    ...(value.artifactId ? { artifactId: value.artifactId } : {}),
    ...(value.signal ? { signal: value.signal } : {}),
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new ProjectMixdownServiceError(
      'MIXDOWN_ABORTED',
      'Project Mixdown was aborted.',
    );
  }
}

function createCompletedResult(plan, rendered, artifact) {
  return Object.freeze({
    artifact: Object.freeze({
      artifactId: artifact.artifactId,
      createdAt: artifact.finalizedAt,
      destination: 'mixdown',
      file: artifact.file,
      kind: 'audio',
      provenance: Object.freeze({
        plan,
        planVersion: plan.version,
        rendererId: PROJECT_MIXDOWN_RENDERER_ID,
        rendererVersion: PROJECT_MIXDOWN_RENDERER_VERSION,
        sourceIds: Object.freeze(plan.sources.map((source) => source.sourceId)),
      }),
    }),
    mixdown: Object.freeze({
      bitsPerSample: rendered.bitsPerSample,
      bytesWritten: artifact.file.sizeBytes,
      channels: rendered.channels,
      durationSeconds: rendered.durationSeconds,
      frameCount: rendered.frameCount,
      mimeType: rendered.mimeType,
      sampleRate: rendered.sampleRate,
      sourceCount: plan.sources.length,
      trackCount: plan.tracks.length,
    }),
    status: 'COMPLETED',
  });
}

function createCompletedStemPrintResult(plan, rendered, artifact, identity) {
  return Object.freeze({
    artifact: Object.freeze({
      artifactId: artifact.artifactId,
      createdAt: artifact.finalizedAt,
      destination: 'stem-print',
      file: artifact.file,
      kind: 'audio',
      provenance: Object.freeze({
        canonicalPlanJson: identity.canonicalPlanJson,
        plan,
        planSha256: identity.planSha256,
        planVersion: PROJECT_STEM_PRINT_PLAN_VERSION,
        rendererId: PROJECT_MIXDOWN_RENDERER_ID,
        rendererVersion: PROJECT_MIXDOWN_RENDERER_VERSION,
        selectedTargets: plan.selectedTargets,
        sourceIds: Object.freeze(plan.sources.map((source) => source.sourceId)),
      }),
    }),
    status: 'COMPLETED',
    stemPrint: Object.freeze({
      bitsPerSample: rendered.bitsPerSample,
      bytesWritten: artifact.file.sizeBytes,
      channels: rendered.channels,
      durationSeconds: rendered.durationSeconds,
      frameCount: rendered.frameCount,
      mimeType: rendered.mimeType,
      sampleRate: rendered.sampleRate,
      sourceCount: plan.sources.length,
      targetCount: plan.selectedTargets.length,
      trackCount: plan.tracks.length,
    }),
  });
}

function validateStemPrintRenderResult(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'bitsPerSample',
      'bytes',
      'channels',
      'durationSeconds',
      'frameCount',
      'mimeType',
      'sampleRate',
    ]) ||
    value.bitsPerSample !== RAW_MIXDOWN_BITS_PER_SAMPLE ||
    !Buffer.isBuffer(value.bytes) ||
    value.channels !== RAW_MIXDOWN_CHANNELS ||
    !Number.isFinite(value.durationSeconds) ||
    value.durationSeconds <= 0 ||
    !Number.isSafeInteger(value.frameCount) ||
    value.frameCount <= 0 ||
    value.durationSeconds !== value.frameCount / RAW_MIXDOWN_SAMPLE_RATE ||
    value.mimeType !== RAW_MIXDOWN_MIME_TYPE ||
    value.sampleRate !== RAW_MIXDOWN_SAMPLE_RATE ||
    value.bytes.byteLength !==
      44 +
        value.frameCount *
          RAW_MIXDOWN_CHANNELS *
          (RAW_MIXDOWN_BITS_PER_SAMPLE / 8)
  ) {
    throw new ProjectMixdownServiceError(
      'STEM_PRINT_RENDER_RESULT_INVALID',
      'Project Stem Print Worker returned invalid render metadata.',
    );
  }
}

function validateStemPrintFinalizedArtifact(value, reservation, rendered) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifactId',
      'destination',
      'file',
      'finalizedAt',
      'reservationId',
      'status',
    ]) ||
    value.artifactId !== reservation.artifactId ||
    value.destination !== 'stem-print' ||
    typeof value.finalizedAt !== 'string' ||
    Number.isNaN(Date.parse(value.finalizedAt)) ||
    value.reservationId !== reservation.reservationId ||
    value.status !== 'FINALIZED' ||
    !isRecord(value.file) ||
    !hasExactKeys(value.file, [
      'extension',
      'name',
      'relativePath',
      'sizeBytes',
    ]) ||
    value.file.extension !== '.wav' ||
    value.file.name !== `${reservation.artifactId}.wav` ||
    value.file.relativePath !== reservation.finalRelativePath ||
    value.file.sizeBytes !== rendered.bytes.byteLength
  ) {
    throw new ProjectMixdownServiceError(
      'STEM_PRINT_OUTCOME_UNKNOWN',
      'Project Stem Print finalized with an invalid or unverifiable response.',
    );
  }
}

function isKnownUncommittedFinalizationFailure(error) {
  return (
    isRecord(error) &&
    typeof error.code === 'string' &&
    KNOWN_UNCOMMITTED_FINALIZATION_FAILURE_CODES.has(error.code)
  );
}

function hasExactKeys(value, expectedKeys) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function mapExternalOpenError(error, sourceId) {
  if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
    return externalSourceError(
      'MIXDOWN_EXTERNAL_SOURCE_NOT_FOUND',
      sourceId,
      'is unavailable',
    );
  }

  return externalSourceError(
    'MIXDOWN_EXTERNAL_SOURCE_UNOPENABLE',
    sourceId,
    'could not be opened',
    error,
  );
}

function externalSourceError(code, sourceId, detail, cause) {
  return new ProjectMixdownServiceError(
    code,
    `External Mixdown source ${sourceId} ${detail}.`,
    cause === undefined ? undefined : { cause },
  );
}

function combineErrors(primaryError, cleanupErrors) {
  if (!primaryError && cleanupErrors.length === 1) {
    return cleanupErrors[0];
  }

  if (!primaryError) {
    return Object.assign(
      new AggregateError(cleanupErrors, 'Project Mixdown cleanup failed.'),
      { code: 'MIXDOWN_CLEANUP_FAILED' },
    );
  }

  if (cleanupErrors.length === 0) {
    return primaryError;
  }

  return Object.assign(
    new AggregateError(
      [primaryError, ...cleanupErrors],
      `${primaryError instanceof Error ? primaryError.message : 'Project Mixdown failed.'} Cleanup also failed.`,
      { cause: primaryError },
    ),
    {
      code:
        primaryError instanceof Error &&
        'code' in primaryError &&
        typeof primaryError.code === 'string'
          ? primaryError.code
          : 'MIXDOWN_FAILED',
    },
  );
}

function isNodeError(value) {
  return value instanceof Error && 'code' in value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
