import { parseProviderProgress } from '../providers/providerProgress.mjs';

export const GPU_JOB_STATES = Object.freeze([
  'QUEUED',
  'LOADING_MODEL',
  'PROCESSING',
  'SAVING',
  'COMPLETED',
  'CANCEL_REQUESTED',
  'CANCELED',
  'FAILED',
  'INTERRUPTED',
  'PAUSED',
]);

export const ACTIVE_GPU_JOB_STATES = Object.freeze([
  'LOADING_MODEL',
  'PROCESSING',
  'SAVING',
  'CANCEL_REQUESTED',
]);

export const TERMINAL_GPU_JOB_STATES = Object.freeze(['COMPLETED', 'CANCELED']);

const ALLOWED_TRANSITIONS = Object.freeze({
  QUEUED: Object.freeze(['LOADING_MODEL', 'PAUSED']),
  LOADING_MODEL: Object.freeze([
    'PROCESSING',
    'CANCEL_REQUESTED',
    'FAILED',
    'INTERRUPTED',
  ]),
  PROCESSING: Object.freeze(['SAVING', 'CANCEL_REQUESTED', 'FAILED', 'INTERRUPTED']),
  SAVING: Object.freeze(['COMPLETED', 'FAILED']),
  COMPLETED: Object.freeze([]),
  CANCEL_REQUESTED: Object.freeze(['CANCELED', 'FAILED', 'INTERRUPTED']),
  CANCELED: Object.freeze([]),
  FAILED: Object.freeze(['QUEUED']),
  INTERRUPTED: Object.freeze(['QUEUED', 'CANCELED']),
  PAUSED: Object.freeze(['QUEUED', 'CANCELED']),
});

const JOB_ID_PATTERN = /^job-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_JSON_DEPTH = 16;

export class JobRecordValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'JobRecordValidationError';
  }
}

export function createQueuedJobRecord({ jobId, request, timestamp = new Date().toISOString() }) {
  validateTimestamp(timestamp, 'Job creation timestamp');

  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRecordValidationError(
      'JOB_ID_INVALID',
      'Job ID must start with job- and use lowercase letters, numbers, and hyphens.',
    );
  }

  const frozenRequest = freezeJsonObject(request, 'Job request');
  const providerId = validateIdentity(frozenRequest.providerId, 'Job Provider ID');
  const modelId = validateIdentity(frozenRequest.modelId, 'Job Model ID');
  const modelRevision = validateIdentity(frozenRequest.modelRevision, 'Job Model revision');
  const taskId = validateIdentity(frozenRequest.taskId, 'Job Task ID');
  const history = Object.freeze([
    Object.freeze({ attempt: 1, at: timestamp, state: 'QUEUED' }),
  ]);

  return Object.freeze({
    attempt: 1,
    createdAt: timestamp,
    history,
    jobId,
    modelId,
    modelRevision,
    providerId,
    request: frozenRequest,
    state: 'QUEUED',
    taskId,
    updatedAt: timestamp,
  });
}

export function transitionJobRecord(
  record,
  nextState,
  { error, incrementAttempt = false, result, timestamp = new Date().toISOString() } = {},
) {
  validateJobRecord(record);
  validateTimestamp(timestamp, 'Job transition timestamp');

  if (Date.parse(timestamp) < Date.parse(record.updatedAt)) {
    throw new JobRecordValidationError(
      'JOB_TIMESTAMP_INVALID',
      'Job transition timestamp cannot move backward.',
    );
  }

  if (!GPU_JOB_STATES.includes(nextState)) {
    throw new JobRecordValidationError(
      'JOB_STATE_INVALID',
      `Unknown GPU Job state: ${String(nextState)}.`,
    );
  }

  if (!ALLOWED_TRANSITIONS[record.state].includes(nextState)) {
    throw new JobRecordValidationError(
      'JOB_TRANSITION_INVALID',
      `GPU Job cannot transition from ${record.state} to ${nextState}.`,
    );
  }

  if (nextState === 'FAILED' && error === undefined) {
    throw new JobRecordValidationError(
      'JOB_ERROR_REQUIRED',
      'A failed GPU Job requires an error.',
    );
  }

  if (nextState === 'COMPLETED' && result === undefined) {
    throw new JobRecordValidationError(
      'JOB_RESULT_REQUIRED',
      'A completed GPU Job requires a result.',
    );
  }

  if (incrementAttempt && nextState !== 'QUEUED') {
    throw new JobRecordValidationError(
      'JOB_ATTEMPT_INVALID',
      'GPU Job attempt may increase only when returning to QUEUED.',
    );
  }

  const attempt = record.attempt + (incrementAttempt ? 1 : 0);
  const history = Object.freeze([
    ...record.history,
    Object.freeze({ attempt, at: timestamp, state: nextState }),
  ]);
  const nextRecord = {
    attempt,
    createdAt: record.createdAt,
    history,
    jobId: record.jobId,
    modelId: record.modelId,
    modelRevision: record.modelRevision,
    providerId: record.providerId,
    request: record.request,
    state: nextState,
    taskId: record.taskId,
    updatedAt: timestamp,
  };

  if (nextState !== 'QUEUED') {
    if (record.startedAt || nextState === 'LOADING_MODEL') {
      nextRecord.startedAt = record.startedAt ?? timestamp;
    }

    if (record.cancelRequestedAt || nextState === 'CANCEL_REQUESTED') {
      nextRecord.cancelRequestedAt = record.cancelRequestedAt ?? timestamp;
    }
  }

  if (nextState === 'FAILED') {
    nextRecord.error = freezeJobError(error);
    nextRecord.finishedAt = timestamp;
  } else if (nextState === 'COMPLETED') {
    nextRecord.finishedAt = timestamp;
    nextRecord.result = freezeJsonValue(result, 'Job result');
  } else if (nextState === 'CANCELED') {
    nextRecord.finishedAt = timestamp;
  } else if (nextState === 'INTERRUPTED') {
    nextRecord.finishedAt = timestamp;
  }

  return Object.freeze(nextRecord);
}

export function updateJobProgress(
  record,
  progressValue,
  timestamp = new Date().toISOString(),
) {
  validateJobRecord(record);
  validateTimestamp(timestamp, 'Job progress timestamp');

  if (record.state !== 'PROCESSING') {
    throw new JobRecordValidationError(
      'JOB_PROGRESS_STATE_INVALID',
      'GPU Job progress may be recorded only while PROCESSING.',
    );
  }

  const progress = parseProviderProgress(progressValue);

  if (!progress) {
    throw new JobRecordValidationError(
      'JOB_PROGRESS_INVALID',
      'GPU Job progress is invalid.',
    );
  }

  if (Date.parse(timestamp) < Date.parse(record.updatedAt)) {
    throw new JobRecordValidationError(
      'JOB_TIMESTAMP_INVALID',
      'Job progress timestamp cannot precede the current state.',
    );
  }

  const previous = record.progress;

  if (previous) {
    if (
      previous.accuracy !== progress.accuracy ||
      progress.percent < previous.percent ||
      (progress.accuracy === 'MEASURED' &&
        (progress.totalSteps !== previous.totalSteps ||
          progress.currentStep < previous.currentStep))
    ) {
      throw new JobRecordValidationError(
        'JOB_PROGRESS_REGRESSION',
        'GPU Job progress cannot move backward or change its measurement contract.',
      );
    }

    if (
      progress.percent === previous.percent &&
      (progress.accuracy === 'ESTIMATED' ||
        progress.currentStep === previous.currentStep)
    ) {
      return record;
    }
  }

  return Object.freeze({
    ...record,
    progress: Object.freeze({ ...progress, updatedAt: timestamp }),
  });
}

export function isActiveGpuJobState(state) {
  return ACTIVE_GPU_JOB_STATES.includes(state);
}

function validateJobRecord(record) {
  if (
    !isRecord(record) ||
    typeof record.jobId !== 'string' ||
    !GPU_JOB_STATES.includes(record.state) ||
    !Array.isArray(record.history) ||
    !Number.isSafeInteger(record.attempt) ||
    record.attempt < 1
  ) {
    throw new JobRecordValidationError('JOB_RECORD_INVALID', 'JobRecord is invalid.');
  }
}

function freezeJobError(value) {
  const message = value instanceof Error ? value.message : String(value);
  const code =
    value instanceof Error && 'code' in value && typeof value.code === 'string'
      ? value.code
      : 'JOB_EXECUTION_FAILED';

  return Object.freeze({ code, message });
}

function validateIdentity(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new JobRecordValidationError('JOB_REQUEST_INVALID', `${label} is required.`);
  }

  return value;
}

function validateTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new JobRecordValidationError('JOB_TIMESTAMP_INVALID', `${label} is invalid.`);
  }
}

function freezeJsonObject(value, label) {
  if (!isRecord(value)) {
    throw new JobRecordValidationError('JOB_JSON_INVALID', `${label} must be an object.`);
  }

  return freezeJsonValue(value, label);
}

function freezeJsonValue(value, label, depth = 0, ancestors = new Set()) {
  if (depth > MAX_JSON_DEPTH) {
    throw new JobRecordValidationError(
      'JOB_JSON_INVALID',
      `${label} exceeds the supported nesting depth.`,
    );
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new JobRecordValidationError(
        'JOB_JSON_INVALID',
        `${label} contains a non-finite number.`,
      );
    }

    return value;
  }

  if (Array.isArray(value) || isRecord(value)) {
    if (ancestors.has(value)) {
      throw new JobRecordValidationError('JOB_JSON_INVALID', `${label} contains a cycle.`);
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value);

    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((item, index) =>
          freezeJsonValue(item, `${label}[${index}]`, depth + 1, nextAncestors),
        ),
      );
    }

    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          freezeJsonValue(item, `${label}.${key}`, depth + 1, nextAncestors),
        ]),
      ),
    );
  }

  throw new JobRecordValidationError('JOB_JSON_INVALID', `${label} contains a non-JSON value.`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
