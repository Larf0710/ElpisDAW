import { createHash } from 'node:crypto';

import {
  PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
  createProjectMixdownArtifactId,
  isProjectMixdownOperationId,
} from '../shared/projectMixdownApiProtocol.js';
import {
  PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
  createProjectStemPrintArtifactId,
  isProjectStemPrintOperationId,
} from '../shared/projectStemPrintApiProtocol.js';
import {
  PROJECT_STEM_PRINT_PLAN_VERSION,
} from '../shared/projectStemPrintProtocol.js';
import { createCanonicalProjectRenderPlanJson } from '../shared/projectRenderPlanIdentity.js';
import {
  PROJECT_MIXDOWN_RENDERER_ID,
  PROJECT_MIXDOWN_RENDERER_VERSION,
  RAW_MIXDOWN_BITS_PER_SAMPLE,
  RAW_MIXDOWN_CHANNELS,
  RAW_MIXDOWN_MIME_TYPE,
  RAW_MIXDOWN_PLAN_VERSION,
  RAW_MIXDOWN_SAMPLE_RATE,
} from '../shared/rawMixdownProtocol.js';
import {
  validateProjectPcmMixdownPlan,
} from './projectPcmMixdownRenderer.mjs';
import { parseProjectStemPrintPlan } from './projectStemPrintPlanProtocol.mjs';

const STATUS_BY_ERROR_CODE = Object.freeze({
  ARTIFACT_DESTINATION_ESCAPE: 500,
  ARTIFACT_DESTINATION_EXISTS: 409,
  ARTIFACT_ID_INVALID: 500,
  ARTIFACT_RESERVATION_BUSY: 409,
  ARTIFACT_STAGING_EMPTY: 500,
  ARTIFACT_STAGING_INVALID: 500,
  ARTIFACT_STAGING_MISSING: 500,
  GENERATED_AUDIO_METADATA_MISMATCH: 409,
  GENERATED_AUDIO_NOT_FOUND: 404,
  GENERATED_AUDIO_OUTSIDE_PROJECT_ROOT: 403,
  GENERATED_AUDIO_REQUEST_INVALID: 400,
  GENERATED_AUDIO_UNOPENABLE: 409,
  GENERATED_AUDIO_WAV_INVALID: 422,
  MIXDOWN_ABORTED: 409,
  MIXDOWN_CLEANUP_FAILED: 500,
  MIXDOWN_EXTERNAL_SOURCE_CHANGED: 409,
  MIXDOWN_EXTERNAL_SOURCE_METADATA_MISMATCH: 409,
  MIXDOWN_EXTERNAL_SOURCE_NOT_FOUND: 404,
  MIXDOWN_EXTERNAL_SOURCE_UNOPENABLE: 409,
  MIXDOWN_GENERATED_SOURCE_READ_INVALID: 422,
  MIXDOWN_FAILED: 500,
  MIXDOWN_DSP_STATE_INVALID: 422,
  MIXDOWN_METER_STATE_INVALID: 422,
  MIXDOWN_OUTPUT_TOO_LARGE: 413,
  MIXDOWN_PLAN_INVALID: 400,
  MIXDOWN_REQUEST_INVALID: 400,
  MIXDOWN_SERVICE_BUSY: 409,
  MIXDOWN_SOURCE_BUDGET_EXCEEDED: 413,
  MIXDOWN_SOURCE_RANGE_INVALID: 422,
  MIXDOWN_SOURCE_SET_INVALID: 422,
  MIXDOWN_SOURCE_SIZE_MISMATCH: 409,
  MIXDOWN_SOURCE_WAV_INVALID: 422,
  MIXDOWN_WORKER_BUSY: 409,
  MIXDOWN_WORKER_EXITED: 502,
  MIXDOWN_WORKER_FAILED: 502,
  MIXDOWN_WORKER_RENDER_FAILED: 422,
  MIXDOWN_WORKER_REQUEST_INVALID: 500,
  MIXDOWN_WORKER_RESPONSE_INVALID: 502,
  MIXDOWN_WORKER_SEND_FAILED: 502,
  MIXDOWN_WORKER_TERMINATION_FAILED: 500,
  MIXDOWN_WORKER_TIMEOUT: 504,
  PROJECT_ROOT_REQUIRED: 409,
  STEM_PRINT_OUTCOME_UNKNOWN: 409,
  STEM_PRINT_PLAN_IDENTITY_INVALID: 400,
  STEM_PRINT_PLAN_INVALID: 400,
  STEM_PRINT_RENDERER_UNAVAILABLE: 500,
  STEM_PRINT_RENDER_RESULT_INVALID: 502,
});

const MESSAGE_BY_ERROR_CODE = Object.freeze({
  ARTIFACT_DESTINATION_ESCAPE: 'Project Mixdown destination is outside Project Root authority.',
  ARTIFACT_DESTINATION_EXISTS: 'Project Mixdown destination already exists.',
  ARTIFACT_ID_INVALID: 'Project Mixdown output identity is invalid.',
  ARTIFACT_RESERVATION_BUSY: 'Project Mixdown staging reservation is busy.',
  ARTIFACT_STAGING_EMPTY: 'Project Mixdown staging output is empty.',
  ARTIFACT_STAGING_INVALID: 'Project Mixdown staging output is invalid.',
  ARTIFACT_STAGING_MISSING: 'Project Mixdown staging output is missing.',
  GENERATED_AUDIO_METADATA_MISMATCH: 'A generated Mixdown source no longer matches the Plan.',
  GENERATED_AUDIO_NOT_FOUND: 'A required generated Mixdown source is unavailable.',
  GENERATED_AUDIO_OUTSIDE_PROJECT_ROOT: 'A generated Mixdown source is outside Project Root authority.',
  GENERATED_AUDIO_REQUEST_INVALID: 'A generated Mixdown source descriptor is invalid.',
  GENERATED_AUDIO_UNOPENABLE: 'A required generated Mixdown source could not be opened.',
  GENERATED_AUDIO_WAV_INVALID: 'A generated Mixdown source WAV is invalid.',
  MIXDOWN_ABORTED: 'Project Mixdown was canceled before finalization completed.',
  MIXDOWN_CLEANUP_FAILED: 'Project Mixdown staging cleanup failed.',
  MIXDOWN_EXTERNAL_SOURCE_CHANGED: 'An external Mixdown source changed while it was read.',
  MIXDOWN_EXTERNAL_SOURCE_METADATA_MISMATCH: 'An external Mixdown source no longer matches the Plan.',
  MIXDOWN_EXTERNAL_SOURCE_NOT_FOUND: 'A required external Mixdown source is unavailable.',
  MIXDOWN_EXTERNAL_SOURCE_UNOPENABLE: 'A required external Mixdown source could not be opened.',
  MIXDOWN_GENERATED_SOURCE_READ_INVALID: 'A generated Mixdown source could not be read safely.',
  MIXDOWN_FAILED: 'Project Mixdown failed.',
  MIXDOWN_DSP_STATE_INVALID: 'Project Mixdown DSP state or output is invalid.',
  MIXDOWN_METER_STATE_INVALID: 'Project Mixdown meter state is invalid.',
  MIXDOWN_OUTPUT_TOO_LARGE: 'Project Mixdown output exceeds the Engine memory limit.',
  MIXDOWN_PLAN_INVALID: 'Project Mixdown Plan is invalid.',
  MIXDOWN_REQUEST_INVALID: 'Project Mixdown request is invalid.',
  MIXDOWN_SERVICE_BUSY: 'Project Mixdown service is busy.',
  MIXDOWN_SOURCE_BUDGET_EXCEEDED: 'Project Mixdown sources exceed the Engine memory limit.',
  MIXDOWN_SOURCE_RANGE_INVALID: 'A Mixdown event exceeds its source Audio range.',
  MIXDOWN_SOURCE_SET_INVALID: 'Project Mixdown source bytes do not match the Plan.',
  MIXDOWN_SOURCE_SIZE_MISMATCH: 'A Mixdown source size no longer matches the Plan.',
  MIXDOWN_SOURCE_WAV_INVALID: 'A Mixdown source WAV is unsupported or malformed.',
  MIXDOWN_WORKER_BUSY: 'Project Mixdown Worker is busy.',
  MIXDOWN_WORKER_EXITED: 'Project Mixdown Worker exited before completion.',
  MIXDOWN_WORKER_FAILED: 'Project Mixdown Worker failed.',
  MIXDOWN_WORKER_RENDER_FAILED: 'Project Mixdown rendering failed.',
  MIXDOWN_WORKER_REQUEST_INVALID: 'Project Mixdown Worker request was invalid.',
  MIXDOWN_WORKER_RESPONSE_INVALID: 'Project Mixdown Worker returned an invalid response.',
  MIXDOWN_WORKER_SEND_FAILED: 'Project Mixdown Worker could not receive the render request.',
  MIXDOWN_WORKER_TERMINATION_FAILED: 'Project Mixdown Worker could not terminate cleanly.',
  MIXDOWN_WORKER_TIMEOUT: 'Project Mixdown Worker timed out.',
  PROJECT_ROOT_REQUIRED: 'Select a Project Root before starting Project Mixdown.',
  STEM_PRINT_OUTCOME_UNKNOWN: 'Project Stem Print outcome is unknown; recover with the same operationId.',
  STEM_PRINT_PLAN_IDENTITY_INVALID: 'Project Stem Print Plan identity is invalid.',
  STEM_PRINT_PLAN_INVALID: 'Project Stem Print Plan is invalid.',
  STEM_PRINT_RENDERER_UNAVAILABLE: 'Project Stem Print Worker is unavailable.',
  STEM_PRINT_RENDER_RESULT_INVALID: 'Project Stem Print Worker returned an invalid result.',
});

export class ProjectMixdownOperationError extends Error {
  constructor(code, message, statusCode, options) {
    super(message, options);
    this.code = code;
    this.name = 'ProjectMixdownOperationError';
    this.statusCode = statusCode;
  }
}

export class ProjectMixdownOperationCoordinator {
  #accepting = true;
  #activeOperation;
  #onActiveChange;
  #operations = new Map();
  #projectMixdownService;

  constructor({ onActiveChange = () => undefined, projectMixdownService }) {
    if (
      !projectMixdownService ||
      typeof projectMixdownService.renderAndSave !== 'function'
    ) {
      throw new TypeError(
        'ProjectMixdownOperationCoordinator requires a ProjectMixdownService.',
      );
    }

    if (typeof onActiveChange !== 'function') {
      throw new TypeError('Project Mixdown activity callback must be a function.');
    }

    this.#onActiveChange = onActiveChange;
    this.#projectMixdownService = projectMixdownService;
  }

  getActiveOperationId() {
    return this.#activeOperation?.operationId;
  }

  async execute(requestValue, { abortController, getBlockingOperation } = {}) {
    const request = parseRequestEnvelope(requestValue);
    return this.#executeRequest(request, 'mixdown', {
      abortController,
      getBlockingOperation,
    });
  }

  async executeStemPrint(
    requestValue,
    { abortController, getBlockingOperation } = {},
  ) {
    const request = parseStemPrintRequestEnvelope(requestValue);
    return this.#executeRequest(request, 'stem-print', {
      abortController,
      getBlockingOperation,
    });
  }

  async #executeRequest(
    request,
    operationKind,
    { abortController, getBlockingOperation },
  ) {
    const existing = this.#operations.get(request.operationId);

    if (existing) {
      if (
        existing.operationKind !== operationKind ||
        existing.canonicalPlan !== request.canonicalPlan
      ) {
        throw operationConflict(operationKind);
      }

      return existing.promise;
    }

    if (!this.#accepting) {
      throw new ProjectMixdownOperationError(
        'ENGINE_CLOSING',
        `Local Engine is closing and cannot start ${operationLabel(operationKind)}.`,
        503,
      );
    }

    if (this.#activeOperation) {
      throw busy(operationKind);
    }

    const blockingOperation = getBlockingOperation?.();

    if (blockingOperation) {
      throw new ProjectMixdownOperationError(
        'ENGINE_OPERATION_ACTIVE',
        'Local Engine is busy with another operation.',
        409,
      );
    }

    validateAbortController(abortController);
    const artifactId = operationKind === 'stem-print'
      ? createProjectStemPrintArtifactId(request.operationId)
      : createProjectMixdownArtifactId(request.operationId);

    if (!artifactId) {
      throw requestInvalid(
        `${operationLabel(operationKind)} output identity is invalid.`,
        undefined,
        operationKind,
      );
    }

    const operation = {
      abortController,
      artifactId,
      canonicalPlan: request.canonicalPlan,
      operationKind,
      operationId: request.operationId,
      plan: request.plan,
      promise: undefined,
    };
    this.#activeOperation = operation;
    this.#onActiveChange(
      true,
      operation.operationId,
      operation.operationKind,
    );
    operation.promise = this.#run(operation);
    this.#operations.set(operation.operationId, operation);
    return operation.promise;
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
      // The operation outcome remains recoverable in memory until process exit.
    }
  }

  async #run(operation) {
    try {
      const options = {
        artifactId: operation.artifactId,
        signal: operation.abortController.signal,
      };
      const result = operation.operationKind === 'stem-print'
        ? await this.#projectMixdownService.renderStemPrintAndSave(
            operation.plan,
            options,
          )
        : await this.#projectMixdownService.renderAndSave(
            operation.plan,
            options,
          );
      return operation.operationKind === 'stem-print'
        ? createPublicStemPrintOperationResult(
            operation.operationId,
            operation.artifactId,
            operation.canonicalPlan,
            result,
          )
        : createPublicOperationResult(
            operation.operationId,
            operation.artifactId,
            operation.canonicalPlan,
            result,
          );
    } catch (error) {
      throw sanitizeExecutionError(error, operation.operationKind);
    } finally {
      if (this.#activeOperation === operation) {
        this.#activeOperation = undefined;
        this.#onActiveChange(
          false,
          operation.operationId,
          operation.operationKind,
        );
      }
    }
  }
}

function parseRequestEnvelope(value) {
  requireExactKeys(
    value,
    ['operationId', 'plan', 'protocolVersion'],
    'Project Mixdown request envelope',
  );

  if (
    value.protocolVersion !== PROJECT_MIXDOWN_API_PROTOCOL_VERSION ||
    !isProjectMixdownOperationId(value.operationId)
  ) {
    throw requestInvalid(
      'Project Mixdown request protocolVersion or operationId is invalid.',
    );
  }

  let plan;

  try {
    plan = structuredClone(value.plan);
    validateProjectPcmMixdownPlan(plan);
  } catch (error) {
    throw requestInvalid('Project Mixdown request Plan is invalid.', error);
  }

  return Object.freeze({
    canonicalPlan: canonicalJson(plan),
    operationId: value.operationId,
    plan: freezeRecursively(plan),
  });
}

function parseStemPrintRequestEnvelope(value) {
  requireExactKeys(
    value,
    ['operationId', 'plan', 'protocolVersion'],
    'Project Stem Print request envelope',
    'stem-print',
  );

  if (
    value.protocolVersion !== PROJECT_STEM_PRINT_API_PROTOCOL_VERSION ||
    !isProjectStemPrintOperationId(value.operationId)
  ) {
    throw requestInvalid(
      'Project Stem Print request protocolVersion or operationId is invalid.',
      undefined,
      'stem-print',
    );
  }

  let plan;

  try {
    plan = parseProjectStemPrintPlan(value.plan);
  } catch (error) {
    throw requestInvalid(
      'Project Stem Print request Plan is invalid.',
      error,
      'stem-print',
    );
  }

  const canonicalPlan = createCanonicalProjectRenderPlanJson(plan);

  if (canonicalPlan === undefined) {
    throw requestInvalid(
      'Project Stem Print request Plan identity is invalid.',
      undefined,
      'stem-print',
    );
  }

  return Object.freeze({
    canonicalPlan,
    operationId: value.operationId,
    plan,
  });
}

function createPublicOperationResult(
  operationId,
  expectedArtifactId,
  expectedCanonicalPlan,
  value,
) {
  if (
    !isRecord(value) ||
    value.status !== 'COMPLETED' ||
    !isRecord(value.artifact) ||
    !isRecord(value.artifact.file) ||
    !isRecord(value.artifact.provenance) ||
    !isRecord(value.mixdown)
  ) {
    throw new ProjectMixdownOperationError(
      'PROJECT_MIXDOWN_RESULT_INVALID',
      'Project Mixdown completed with invalid Engine metadata.',
      500,
    );
  }

  const { artifact, mixdown } = value;
  const file = artifact.file;
  const provenance = artifact.provenance;

  if (
    artifact.artifactId !== expectedArtifactId ||
    !isArtifactId(artifact.artifactId) ||
    !isIsoDate(artifact.createdAt) ||
    artifact.destination !== 'mixdown' ||
    artifact.kind !== 'audio' ||
    file.extension !== '.wav' ||
    file.name !== `${artifact.artifactId}.wav` ||
    file.relativePath !== `mixdowns/${file.name}` ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes <= 44 ||
    !isRecord(provenance.plan) ||
    canonicalJson(provenance.plan) !== expectedCanonicalPlan ||
    provenance.planVersion !== RAW_MIXDOWN_PLAN_VERSION ||
    provenance.rendererId !== PROJECT_MIXDOWN_RENDERER_ID ||
    provenance.rendererVersion !== PROJECT_MIXDOWN_RENDERER_VERSION ||
    !Array.isArray(provenance.sourceIds) ||
    provenance.sourceIds.length === 0 ||
    !provenance.sourceIds.every(isTrimmedText) ||
    mixdown.bitsPerSample !== RAW_MIXDOWN_BITS_PER_SAMPLE ||
    mixdown.bytesWritten !== file.sizeBytes ||
    mixdown.channels !== RAW_MIXDOWN_CHANNELS ||
    !Number.isFinite(mixdown.durationSeconds) ||
    mixdown.durationSeconds <= 0 ||
    !Number.isSafeInteger(mixdown.frameCount) ||
    mixdown.frameCount <= 0 ||
    mixdown.durationSeconds !== mixdown.frameCount / RAW_MIXDOWN_SAMPLE_RATE ||
    mixdown.mimeType !== RAW_MIXDOWN_MIME_TYPE ||
    mixdown.sampleRate !== RAW_MIXDOWN_SAMPLE_RATE ||
    !Number.isSafeInteger(mixdown.sourceCount) ||
    mixdown.sourceCount !== provenance.sourceIds.length ||
    !Number.isSafeInteger(mixdown.trackCount) ||
    mixdown.trackCount <= 0
  ) {
    throw new ProjectMixdownOperationError(
      'PROJECT_MIXDOWN_RESULT_INVALID',
      'Project Mixdown completed with invalid Engine metadata.',
      500,
    );
  }

  return Object.freeze({
    operationId,
    protocolVersion: PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
    result: Object.freeze({
      artifact: Object.freeze({
        artifactId: artifact.artifactId,
        createdAt: artifact.createdAt,
        destination: 'mixdown',
        file: Object.freeze({
          extension: '.wav',
          name: file.name,
          relativePath: file.relativePath,
          sizeBytes: file.sizeBytes,
        }),
        kind: 'audio',
        provenance: Object.freeze({
          planVersion: provenance.planVersion,
          rendererId: provenance.rendererId,
          rendererVersion: provenance.rendererVersion,
        }),
      }),
      mixdown: Object.freeze({
        bitsPerSample: mixdown.bitsPerSample,
        bytesWritten: mixdown.bytesWritten,
        channels: mixdown.channels,
        durationSeconds: mixdown.durationSeconds,
        frameCount: mixdown.frameCount,
        mimeType: mixdown.mimeType,
        sampleRate: mixdown.sampleRate,
        sourceCount: mixdown.sourceCount,
        trackCount: mixdown.trackCount,
      }),
      status: 'COMPLETED',
    }),
  });
}

function createPublicStemPrintOperationResult(
  operationId,
  expectedArtifactId,
  expectedCanonicalPlan,
  value,
) {
  if (
    !isRecord(value) ||
    value.status !== 'COMPLETED' ||
    !isRecord(value.artifact) ||
    !isRecord(value.artifact.file) ||
    !isRecord(value.artifact.provenance) ||
    !isRecord(value.stemPrint)
  ) {
    throw invalidStemPrintResult();
  }

  const { artifact, stemPrint } = value;
  const { file, provenance } = artifact;
  const expectedPlanSha256 = createHash('sha256')
    .update(expectedCanonicalPlan)
    .digest('hex');

  if (
    artifact.artifactId !== expectedArtifactId ||
    !isArtifactId(artifact.artifactId) ||
    !isIsoDate(artifact.createdAt) ||
    artifact.destination !== 'stem-print' ||
    artifact.kind !== 'audio' ||
    file.extension !== '.wav' ||
    file.name !== `${artifact.artifactId}.wav` ||
    file.relativePath !== `stem-prints/${file.name}` ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes <= 44 ||
    !isRecord(provenance.plan) ||
    createCanonicalProjectRenderPlanJson(provenance.plan) !==
      expectedCanonicalPlan ||
    provenance.canonicalPlanJson !== expectedCanonicalPlan ||
    provenance.planSha256 !== expectedPlanSha256 ||
    provenance.planVersion !== PROJECT_STEM_PRINT_PLAN_VERSION ||
    provenance.rendererId !== PROJECT_MIXDOWN_RENDERER_ID ||
    provenance.rendererVersion !== PROJECT_MIXDOWN_RENDERER_VERSION ||
    !Array.isArray(provenance.selectedTargets) ||
    createCanonicalProjectRenderPlanJson(provenance.selectedTargets) !==
      createCanonicalProjectRenderPlanJson(provenance.plan.selectedTargets) ||
    !Array.isArray(provenance.sourceIds) ||
    provenance.sourceIds.length === 0 ||
    !provenance.sourceIds.every(isTrimmedText) ||
    canonicalJson(provenance.sourceIds) !==
      canonicalJson(provenance.plan.sources.map((source) => source.sourceId)) ||
    stemPrint.bitsPerSample !== RAW_MIXDOWN_BITS_PER_SAMPLE ||
    stemPrint.bytesWritten !== file.sizeBytes ||
    stemPrint.channels !== RAW_MIXDOWN_CHANNELS ||
    !Number.isFinite(stemPrint.durationSeconds) ||
    stemPrint.durationSeconds <= 0 ||
    !Number.isSafeInteger(stemPrint.frameCount) ||
    stemPrint.frameCount <= 0 ||
    stemPrint.durationSeconds !==
      stemPrint.frameCount / RAW_MIXDOWN_SAMPLE_RATE ||
    stemPrint.mimeType !== RAW_MIXDOWN_MIME_TYPE ||
    stemPrint.sampleRate !== RAW_MIXDOWN_SAMPLE_RATE ||
    stemPrint.sourceCount !== provenance.sourceIds.length ||
    stemPrint.targetCount !== provenance.selectedTargets.length ||
    stemPrint.trackCount !== provenance.plan.tracks.length
  ) {
    throw invalidStemPrintResult();
  }

  return Object.freeze({
    operationId,
    protocolVersion: PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
    result: Object.freeze({
      artifact: Object.freeze({
        artifactId: artifact.artifactId,
        createdAt: artifact.createdAt,
        destination: 'stem-print',
        file: Object.freeze({
          extension: '.wav',
          name: file.name,
          relativePath: file.relativePath,
          sizeBytes: file.sizeBytes,
        }),
        kind: 'audio',
        provenance: Object.freeze({
          planSha256: provenance.planSha256,
          planVersion: provenance.planVersion,
          rendererId: provenance.rendererId,
          rendererVersion: provenance.rendererVersion,
          selectedTargets: freezeRecursively(
            structuredClone(provenance.selectedTargets),
          ),
        }),
      }),
      status: 'COMPLETED',
      stemPrint: Object.freeze({
        bitsPerSample: stemPrint.bitsPerSample,
        bytesWritten: stemPrint.bytesWritten,
        channels: stemPrint.channels,
        durationSeconds: stemPrint.durationSeconds,
        frameCount: stemPrint.frameCount,
        mimeType: stemPrint.mimeType,
        sampleRate: stemPrint.sampleRate,
        sourceCount: stemPrint.sourceCount,
        targetCount: stemPrint.targetCount,
        trackCount: stemPrint.trackCount,
      }),
    }),
  });
}

function invalidStemPrintResult() {
  return new ProjectMixdownOperationError(
    'PROJECT_STEM_PRINT_RESULT_INVALID',
    'Project Stem Print completed with invalid Engine metadata.',
    500,
  );
}

function sanitizeExecutionError(error, operationKind = 'mixdown') {
  if (error instanceof ProjectMixdownOperationError) {
    return error;
  }

  const reportedCode = isRecord(error) && typeof error.code === 'string'
    ? error.code
    : operationKind === 'stem-print'
      ? 'PROJECT_STEM_PRINT_FAILED'
      : 'PROJECT_MIXDOWN_FAILED';
  const code = Object.hasOwn(STATUS_BY_ERROR_CODE, reportedCode)
    ? reportedCode
    : operationKind === 'stem-print'
      ? 'PROJECT_STEM_PRINT_FAILED'
      : 'PROJECT_MIXDOWN_FAILED';
  const statusCode = STATUS_BY_ERROR_CODE[code] ?? 500;
  const message = MESSAGE_BY_ERROR_CODE[code] ??
    `${operationLabel(operationKind)} failed.`;

  return new ProjectMixdownOperationError(code, message, statusCode, {
    cause: error,
  });
}

function requestInvalid(message, cause, operationKind = 'mixdown') {
  return new ProjectMixdownOperationError(
    operationKind === 'stem-print'
      ? 'PROJECT_STEM_PRINT_REQUEST_INVALID'
      : 'PROJECT_MIXDOWN_REQUEST_INVALID',
    message,
    400,
    cause === undefined ? undefined : { cause },
  );
}

function busy(operationKind = 'mixdown') {
  return new ProjectMixdownOperationError(
    operationKind === 'stem-print'
      ? 'PROJECT_STEM_PRINT_BUSY'
      : 'PROJECT_MIXDOWN_BUSY',
    `Another ${operationLabel(operationKind)} operation is active.`,
    409,
  );
}

function operationConflict(operationKind) {
  return new ProjectMixdownOperationError(
    operationKind === 'stem-print'
      ? 'PROJECT_STEM_PRINT_OPERATION_CONFLICT'
      : 'PROJECT_MIXDOWN_OPERATION_CONFLICT',
    `${operationLabel(operationKind)} operationId is already bound to a different Plan.`,
    409,
  );
}

function operationLabel(operationKind) {
  return operationKind === 'stem-print'
    ? 'Project Stem Print'
    : 'Project Mixdown';
}

function validateAbortController(value) {
  if (
    !isRecord(value) ||
    typeof value.abort !== 'function' ||
    !isRecord(value.signal) ||
    typeof value.signal.aborted !== 'boolean'
  ) {
    throw new TypeError('Project Mixdown requires one AbortController.');
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function freezeRecursively(value) {
  if (Array.isArray(value)) {
    value.forEach(freezeRecursively);
  } else if (isRecord(value)) {
    Object.values(value).forEach(freezeRecursively);
  }

  return Object.freeze(value);
}

function requireExactKeys(
  value,
  expectedKeys,
  label,
  operationKind = 'mixdown',
) {
  if (!isRecord(value)) {
    throw requestInvalid(
      `${label} must be an object.`,
      undefined,
      operationKind,
    );
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw requestInvalid(
      `${label} keys are invalid.`,
      undefined,
      operationKind,
    );
  }
}

function isIsoDate(value) {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isArtifactId(value) {
  return (
    typeof value === 'string' &&
    /^artifact-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function isTrimmedText(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
