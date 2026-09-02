import { randomUUID } from 'node:crypto';

import { GENERATION_LIVENESS_INTERVAL_MS } from '../../shared/generationLivenessProtocol.js';
import { localEngineLogger } from '../diagnosticLogger.mjs';
import {
  createQueuedJobRecord,
  isActiveGpuJobState,
  transitionJobRecord,
  updateJobProgress,
} from './jobRecord.mjs';

export class GpuJobQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'GpuJobQueueError';
  }
}

export class GpuJobQueue {
  #acceptingJobs = true;
  #activeExecution;
  #clearInterval;
  #createJobId;
  #executor;
  #heartbeatIntervalMs;
  #heartbeatTimer;
  #idleWaiters = new Set();
  #jobOrder = [];
  #jobs = new Map();
  #logger;
  #now;
  #schedulePending = false;
  #setInterval;
  #shutdownPromise;

  constructor({
    clearIntervalFn = globalThis.clearInterval,
    createJobId = () => `job-${randomUUID()}`,
    executor,
    heartbeatIntervalMs = GENERATION_LIVENESS_INTERVAL_MS,
    logger = localEngineLogger,
    now = () => new Date().toISOString(),
    setIntervalFn = globalThis.setInterval,
  }) {
    if (
      !executor ||
      typeof executor.validateRequest !== 'function' ||
      typeof executor.run !== 'function' ||
      typeof executor.cancel !== 'function' ||
      typeof executor.shutdown !== 'function'
    ) {
      throw new TypeError(
        'GpuJobQueue requires an executor with validateRequest, run, cancel, and shutdown.',
      );
    }

    if (
      typeof clearIntervalFn !== 'function' ||
      typeof createJobId !== 'function' ||
      !Number.isFinite(heartbeatIntervalMs) ||
      heartbeatIntervalMs <= 0 ||
      typeof now !== 'function' ||
      typeof setIntervalFn !== 'function'
    ) {
      throw new TypeError('GpuJobQueue timing and ID options are invalid.');
    }

    if (!isDiagnosticLogger(logger)) {
      throw new TypeError('GpuJobQueue requires a diagnostic logger.');
    }

    this.#clearInterval = clearIntervalFn;
    this.#createJobId = createJobId;
    this.#executor = executor;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    this.#logger = logger;
    this.#now = now;
    this.#setInterval = setIntervalFn;
  }

  enqueue(request) {
    this.#requireAcceptingJobs();
    const normalizedRequest = this.#executor.validateRequest(request);

    if (isPromiseLike(normalizedRequest)) {
      throw new GpuJobQueueError(
        'JOB_REQUEST_VALIDATION_ASYNC',
        'GPU Job request validation must be synchronous.',
      );
    }

    const jobId = this.#createJobId();

    if (this.#jobs.has(jobId)) {
      throw new GpuJobQueueError('JOB_ID_DUPLICATE', `GPU Job ID already exists: ${jobId}.`);
    }

    const record = createQueuedJobRecord({
      jobId,
      request: normalizedRequest,
      timestamp: this.#timestamp(),
    });
    this.#jobs.set(jobId, record);
    this.#jobOrder.push(jobId);
    this.#logger.info('QUEUE', 'JOB_ENQUEUED', {
      ...createJobLogFields(record),
      phase: 'QUEUED',
      queueDepth: this.#countQueuedJobs(),
    });
    this.#schedule();
    return record;
  }

  getJob(jobId) {
    return this.#jobs.get(jobId);
  }

  getSnapshot() {
    return Object.freeze({
      acceptingJobs: this.#acceptingJobs,
      activeJobId: this.#activeExecution?.jobId,
      jobs: Object.freeze(
        this.#jobOrder.flatMap((jobId) => {
          const record = this.#jobs.get(jobId);
          return record ? [record] : [];
        }),
      ),
    });
  }

  removeQueued(jobId) {
    const record = this.#requireJob(jobId);

    if (record.state !== 'QUEUED') {
      throw new GpuJobQueueError(
        'JOB_NOT_REMOVABLE',
        'Only a waiting QUEUED Job may be removed immediately.',
      );
    }

    this.#jobs.delete(jobId);
    this.#jobOrder = this.#jobOrder.filter((candidate) => candidate !== jobId);
    this.#logger.info('QUEUE', 'JOB_REMOVED', createJobLogFields(record));
    this.#resolveIdleWaiters();
    return record;
  }

  async requestCancel(jobId) {
    const record = this.#requireJob(jobId);

    if (record.state === 'CANCEL_REQUESTED') {
      return record;
    }

    if (record.state === 'SAVING') {
      throw new GpuJobQueueError(
        'JOB_CANCEL_TOO_LATE',
        'GPU Job output finalization is already in progress and cannot be canceled safely.',
      );
    }

    if (record.state !== 'LOADING_MODEL' && record.state !== 'PROCESSING') {
      throw new GpuJobQueueError(
        'JOB_NOT_CANCELABLE',
        'Only a loading or processing GPU Job may request cancellation.',
      );
    }

    const activeExecution = this.#activeExecution;

    if (!activeExecution || activeExecution.jobId !== jobId) {
      throw new GpuJobQueueError(
        'JOB_EXECUTION_MISSING',
        'Active GPU Job execution could not be found.',
      );
    }

    const canceledRecord = this.#transition(jobId, 'CANCEL_REQUESTED');
    activeExecution.abortController.abort();
    const cancellationPromise = Promise.resolve(this.#executor.cancel(jobId));
    activeExecution.cancellationPromise = cancellationPromise;
    await cancellationPromise;
    return canceledRecord;
  }

  retry(jobId) {
    this.#requireAcceptingJobs();
    const record = this.#requireJob(jobId);

    if (record.state !== 'FAILED') {
      throw new GpuJobQueueError('JOB_NOT_RETRYABLE', 'Only a FAILED GPU Job may be retried.');
    }

    const retried = this.#transition(jobId, 'QUEUED', { incrementAttempt: true });
    this.#schedule();
    return retried;
  }

  resume(jobId) {
    this.#requireAcceptingJobs();
    const record = this.#requireJob(jobId);

    if (record.state !== 'PAUSED' && record.state !== 'INTERRUPTED') {
      throw new GpuJobQueueError(
        'JOB_NOT_RESUMABLE',
        'Only a PAUSED or INTERRUPTED GPU Job may be resumed.',
      );
    }

    const resumed = this.#transition(jobId, 'QUEUED', {
      incrementAttempt: record.state === 'INTERRUPTED',
    });
    this.#schedule();
    return resumed;
  }

  cancelStopped(jobId) {
    const record = this.#requireJob(jobId);

    if (record.state !== 'PAUSED' && record.state !== 'INTERRUPTED') {
      throw new GpuJobQueueError(
        'JOB_NOT_STOPPED',
        'Only a PAUSED or INTERRUPTED GPU Job may be canceled without execution.',
      );
    }

    return this.#transition(jobId, 'CANCELED');
  }

  waitForIdle() {
    if (this.#isIdle()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.#idleWaiters.add(resolve);
    });
  }

  shutdown() {
    if (!this.#shutdownPromise) {
      this.#shutdownPromise = this.#performShutdown();
    }

    return this.#shutdownPromise;
  }

  async #performShutdown() {
    this.#acceptingJobs = false;
    this.#logger.info('QUEUE', 'QUEUE_SHUTDOWN_STARTED', {
      activeJobId: this.#activeExecution?.jobId,
      queueDepth: this.#countQueuedJobs(),
    });

    for (const jobId of this.#jobOrder) {
      if (this.#jobs.get(jobId)?.state === 'QUEUED') {
        this.#transition(jobId, 'PAUSED');
      }
    }

    const activeExecution = this.#activeExecution;

    if (activeExecution) {
      const activeRecord = this.#jobs.get(activeExecution.jobId);

      if (activeRecord?.state === 'SAVING') {
        await activeExecution.promise;
        await this.#executor.shutdown();
      } else {
        activeExecution.interruptionRequested = true;
        activeExecution.abortController.abort();
        await this.#executor.shutdown();
        await activeExecution.promise;
      }
    } else {
      await this.#executor.shutdown();
    }

    this.#resolveIdleWaiters();
    this.#logger.info('QUEUE', 'QUEUE_SHUTDOWN_COMPLETED', {
      queueDepth: this.#countQueuedJobs(),
    });
  }

  #schedule() {
    if (!this.#acceptingJobs || this.#activeExecution || this.#schedulePending) {
      return;
    }

    this.#schedulePending = true;
    queueMicrotask(() => {
      this.#schedulePending = false;
      this.#startNext();
    });
  }

  #startNext() {
    if (!this.#acceptingJobs || this.#activeExecution) {
      this.#resolveIdleWaiters();
      return;
    }

    const jobId = this.#jobOrder.find((candidate) => this.#jobs.get(candidate)?.state === 'QUEUED');

    if (!jobId) {
      this.#resolveIdleWaiters();
      return;
    }

    const abortController = new AbortController();
    const activeExecution = {
      abortController,
      cancellationPromise: undefined,
      interruptionRequested: false,
      jobId,
      promise: undefined,
    };
    this.#activeExecution = activeExecution;
    this.#transition(jobId, 'LOADING_MODEL');
    this.#startHeartbeat();
    activeExecution.promise = this.#execute(activeExecution);
    void activeExecution.promise;
  }

  async #execute(activeExecution) {
    const { jobId } = activeExecution;

    try {
      const record = this.#requireJob(jobId);
      const result = await this.#executor.run(record.request, {
        jobId,
        onPhase: (phase) => this.#reportPhase(jobId, phase),
        onProgress: (progress) => this.#reportProgress(jobId, progress),
        signal: activeExecution.abortController.signal,
      });
      const current = this.#requireJob(jobId);

      if (activeExecution.interruptionRequested) {
        this.#transition(jobId, 'INTERRUPTED');
      } else if (current.state === 'CANCEL_REQUESTED') {
        await this.#settleCancellation(jobId, activeExecution);
      } else if (current.state === 'SAVING') {
        this.#transition(jobId, 'COMPLETED', { result });
      } else {
        throw new GpuJobQueueError(
          'EXECUTOR_PROTOCOL_INVALID',
          `GPU Job executor completed while Job state was ${current.state}.`,
        );
      }
    } catch (error) {
      const current = this.#jobs.get(jobId);

      if (current) {
        if (activeExecution.interruptionRequested && isActiveGpuJobState(current.state)) {
          this.#transition(jobId, 'INTERRUPTED');
        } else if (current.state === 'CANCEL_REQUESTED') {
          await this.#settleCancellation(jobId, activeExecution);
        } else if (
          current.state === 'LOADING_MODEL' ||
          current.state === 'PROCESSING' ||
          current.state === 'SAVING'
        ) {
          this.#transition(jobId, 'FAILED', { error });
        }
      }
    } finally {
      this.#stopHeartbeat();

      if (this.#activeExecution === activeExecution) {
        this.#activeExecution = undefined;
      }

      this.#resolveIdleWaiters();
      this.#schedule();
    }
  }

  #reportPhase(jobId, phase) {
    const current = this.#requireJob(jobId);

    if (current.state === 'CANCEL_REQUESTED' || this.#activeExecution?.interruptionRequested) {
      return current;
    }

    if (phase === 'PROCESSING' && current.state === 'LOADING_MODEL') {
      return this.#transition(jobId, 'PROCESSING');
    }

    if (phase === 'SAVING' && current.state === 'PROCESSING') {
      return this.#transition(jobId, 'SAVING');
    }

    throw new GpuJobQueueError(
      'EXECUTOR_PHASE_INVALID',
      `GPU Job executor cannot report ${String(phase)} from ${current.state}.`,
    );
  }

  #reportProgress(jobId, progress) {
    const current = this.#requireJob(jobId);

    if (
      current.state !== 'PROCESSING' ||
      this.#activeExecution?.interruptionRequested
    ) {
      return current;
    }

    try {
      const next = updateJobProgress(current, progress, this.#timestamp());

      if (next === current) {
        return current;
      }

      this.#jobs.set(jobId, next);
      this.#logger.info('QUEUE', 'JOB_PROGRESS', {
        ...createJobLogFields(next),
        ...(next.progress.accuracy === 'MEASURED'
          ? {
              currentStep: next.progress.currentStep,
              totalSteps: next.progress.totalSteps,
            }
          : {}),
        phase: 'GENERATION',
        progressAccuracy: next.progress.accuracy,
        progressPercent: next.progress.percent,
      });
      return next;
    } catch (error) {
      this.#logger.warn('QUEUE', 'JOB_PROGRESS_IGNORED', {
        ...createJobLogFields(current),
        errorCode:
          error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'JOB_PROGRESS_INVALID',
        phase: 'GENERATION',
      });
      return current;
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();

    try {
      this.#heartbeatTimer = this.#setInterval(
        () => this.#emitHeartbeat(),
        this.#heartbeatIntervalMs,
      );
      this.#heartbeatTimer?.unref?.();
    } catch {
      this.#heartbeatTimer = undefined;
      this.#logger.warn('QUEUE', 'JOB_HEARTBEAT_TIMER_FAILED', {
        activeJobId: this.#activeExecution?.jobId,
        errorCode: 'JOB_HEARTBEAT_TIMER_FAILED',
      });
    }
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer === undefined) {
      return;
    }

    try {
      this.#clearInterval(this.#heartbeatTimer);
    } catch {
      // Liveness diagnostics must never alter Job settlement.
    }

    this.#heartbeatTimer = undefined;
  }

  #emitHeartbeat() {
    try {
      const jobId = this.#activeExecution?.jobId;
      const record = jobId ? this.#jobs.get(jobId) : undefined;

      if (!record || !isActiveGpuJobState(record.state)) {
        return;
      }

      const observedAtMs = Date.parse(this.#timestamp());
      const startedAtMs = Date.parse(record.startedAt ?? record.createdAt);
      const lastUpdateAtMs = Date.parse(
        record.progress?.updatedAt ?? record.updatedAt,
      );
      const elapsedSeconds = elapsedWholeSeconds(startedAtMs, observedAtMs);
      const lastUpdateAgeSeconds = elapsedWholeSeconds(
        lastUpdateAtMs,
        observedAtMs,
      );

      this.#logger.info('QUEUE', 'JOB_HEARTBEAT', {
        ...createJobLogFields(record),
        ...(record.progress?.accuracy === 'MEASURED'
          ? {
              currentStep: record.progress.currentStep,
              totalSteps: record.progress.totalSteps,
            }
          : {}),
        ...(record.progress
          ? {
              progressAccuracy: record.progress.accuracy,
              progressPercent: record.progress.percent,
            }
          : {}),
        elapsedSeconds,
        lastUpdateAgeSeconds,
        phase: createHeartbeatPhase(record.state),
      });
    } catch {
      this.#logger.warn('QUEUE', 'JOB_HEARTBEAT_IGNORED', {
        activeJobId: this.#activeExecution?.jobId,
        errorCode: 'JOB_HEARTBEAT_INVALID',
      });
    }
  }

  async #settleCancellation(jobId, activeExecution) {
    try {
      if (!activeExecution.cancellationPromise) {
        throw new GpuJobQueueError(
          'JOB_CANCELLATION_MISSING',
          'GPU Job cancellation settlement could not be found.',
        );
      }

      await activeExecution.cancellationPromise;
      this.#transition(jobId, 'CANCELED');
    } catch (error) {
      this.#transition(jobId, 'FAILED', { error });
    }
  }

  #transition(jobId, nextState, options) {
    const current = this.#requireJob(jobId);
    const next = transitionJobRecord(current, nextState, {
      ...options,
      timestamp: this.#timestamp(),
    });
    this.#jobs.set(jobId, next);
    this.#logger.trace('QUEUE', 'JOB_STATE_TRANSITION', {
      ...createJobLogFields(next),
      fromState: current.state,
      toState: next.state,
    });
    logJobLifecycleEvent(this.#logger, current, next);
    return next;
  }

  #requireJob(jobId) {
    const record = this.#jobs.get(jobId);

    if (!record) {
      throw new GpuJobQueueError('JOB_NOT_FOUND', `GPU Job was not found: ${String(jobId)}.`);
    }

    return record;
  }

  #requireAcceptingJobs() {
    if (!this.#acceptingJobs) {
      throw new GpuJobQueueError(
        'QUEUE_STOPPED',
        'GPU Job Queue is stopped and requires explicit restoration in a new Engine session.',
      );
    }
  }

  #timestamp() {
    return this.#now();
  }

  #isIdle() {
    return (
      !this.#activeExecution &&
      !this.#jobOrder.some((jobId) => this.#jobs.get(jobId)?.state === 'QUEUED')
    );
  }

  #countQueuedJobs() {
    return this.#jobOrder.filter(
      (jobId) => this.#jobs.get(jobId)?.state === 'QUEUED',
    ).length;
  }

  #resolveIdleWaiters() {
    if (!this.#isIdle()) {
      return;
    }

    for (const resolve of this.#idleWaiters) {
      resolve();
    }

    this.#idleWaiters.clear();
  }
}

function logJobLifecycleEvent(logger, current, next) {
  const fields = createJobLogFields(next);

  switch (next.state) {
    case 'QUEUED':
      if (next.attempt > current.attempt) {
        logger.info('QUEUE', 'JOB_REQUEUED', fields);
      }
      return;
    case 'LOADING_MODEL':
      logger.info('QUEUE', 'JOB_STARTED', { ...fields, phase: 'MODEL LOAD' });
      return;
    case 'PROCESSING':
      logger.info('QUEUE', 'JOB_PROCESSING', { ...fields, phase: 'GENERATION' });
      return;
    case 'SAVING':
      logger.info('QUEUE', 'JOB_SAVING', { ...fields, phase: 'OUTPUT SAVE' });
      return;
    case 'COMPLETED':
      logger.info('QUEUE', 'JOB_COMPLETED', { ...fields, phase: 'COMPLETE' });
      return;
    case 'CANCEL_REQUESTED':
      logger.info('QUEUE', 'JOB_CANCEL_REQUESTED', fields);
      return;
    case 'CANCELED':
      logger.info('QUEUE', 'JOB_CANCELED', fields);
      return;
    case 'FAILED':
      logger.error('QUEUE', 'JOB_FAILED', {
        ...fields,
        errorCode: next.error?.code,
        reason: next.error?.message,
      });
      return;
    case 'INTERRUPTED':
      logger.warn('QUEUE', 'JOB_INTERRUPTED', fields);
      return;
    case 'PAUSED':
      logger.warn('QUEUE', 'JOB_PAUSED', fields);
  }
}

function createJobLogFields(record) {
  return {
    attempt: record.attempt,
    jobId: record.jobId,
    providerId: record.providerId,
    state: record.state,
    taskId: record.taskId,
  };
}

function createHeartbeatPhase(state) {
  switch (state) {
    case 'LOADING_MODEL':
      return 'MODEL LOAD';
    case 'PROCESSING':
      return 'GENERATION';
    case 'SAVING':
      return 'OUTPUT SAVE';
    case 'CANCEL_REQUESTED':
      return 'CANCELING';
    default:
      return state;
  }
}

function elapsedWholeSeconds(startedAtMs, observedAtMs) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(observedAtMs)) {
    throw new TypeError('GPU Job heartbeat timestamps are invalid.');
  }

  return Math.max(0, Math.floor((observedAtMs - startedAtMs) / 1_000));
}

function isDiagnosticLogger(value) {
  return (
    value &&
    typeof value.info === 'function' &&
    typeof value.trace === 'function' &&
    typeof value.warn === 'function' &&
    typeof value.error === 'function'
  );
}

function isPromiseLike(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}
