import { describe, expect, it } from 'vitest';

import {
  createDiagnosticLogger,
  resolveDiagnosticLogLevel,
  toDiagnosticErrorFields,
} from './diagnosticLogger.mjs';

const FIXED_TIME = '2026-08-19T13:20:31.442Z';

function captureLogger(level = 'info') {
  const entries = [];
  const lines = [];
  const logger = createDiagnosticLogger({
    level,
    now: () => FIXED_TIME,
    sink: (line, entry) => {
      lines.push(line);
      entries.push(entry);
    },
  });

  return { entries, lines, logger };
}

describe('Local Engine diagnostic logger', () => {
  it('defaults to INFO while allowing an explicit environment level', () => {
    expect(resolveDiagnosticLogLevel({})).toBe('info');
    expect(resolveDiagnosticLogLevel({ HUMSTUDIO_LOG_LEVEL: 'TRACE' })).toBe('trace');
    expect(resolveDiagnosticLogLevel({ HUMSTUDIO_LOG_LEVEL: 'invalid' })).toBe('info');
    expect(resolveDiagnosticLogLevel({ NODE_ENV: 'test' })).toBe('off');
  });

  it('filters DEBUG and TRACE below their configured levels', () => {
    const info = captureLogger('info');

    expect(info.logger.trace('QUEUE', 'JOB_STATE_TRANSITION')).toBe(false);
    expect(info.logger.debug('QUEUE', 'REQUEST_VALIDATED')).toBe(false);
    expect(info.logger.info('QUEUE', 'JOB_ENQUEUED', { jobId: 'job-123' })).toBe(true);
    expect(info.lines).toHaveLength(1);

    const trace = captureLogger('trace');
    expect(trace.logger.trace('WORKER', 'WORKER_MESSAGE_SENT')).toBe(true);
    expect(trace.logger.debug('WORKER', 'PROVIDER_REQUEST_PREPARED')).toBe(true);
    expect(trace.lines).toHaveLength(2);
  });

  it('uses stable formatting and omits unavailable optional fields', () => {
    const { entries, lines, logger } = captureLogger();

    logger.info('ACE', 'JOB_STARTED', {
      jobId: 'job-456',
      operationId: 'op-123',
      providerId: 'ace-step',
      taskId: undefined,
    });

    expect(lines).toEqual([
      '[2026-08-19T13:20:31.442Z] [INFO] [ACE] event=JOB_STARTED operationId=op-123 jobId=job-456 providerId=ace-step',
    ]);
    expect(entries[0].fields).not.toHaveProperty('taskId');
  });

  it('renders safe generation progress fields for the Engine console', () => {
    const { lines, logger } = captureLogger();

    logger.info('QUEUE', 'JOB_PROGRESS', {
      currentStep: 4,
      jobId: 'job-456',
      phase: 'GENERATION',
      progressAccuracy: 'MEASURED',
      progressPercent: 50,
      totalSteps: 8,
    });

    expect(lines[0]).toContain(
      'phase=GENERATION progressAccuracy=MEASURED progressPercent=50 currentStep=4 totalSteps=8',
    );
  });

  it('renders bounded Job heartbeat timing without accepting arbitrary fields', () => {
    const { entries, lines, logger } = captureLogger();

    logger.info('QUEUE', 'JOB_HEARTBEAT', {
      elapsedSeconds: 62,
      jobId: 'job-456',
      lastUpdateAgeSeconds: 31,
      phase: 'GENERATION',
      prompt: 'private prompt body',
      state: 'PROCESSING',
    });

    expect(lines[0]).toContain(
      'phase=GENERATION state=PROCESSING elapsedSeconds=62 lastUpdateAgeSeconds=31',
    );
    expect(entries[0].fields).not.toHaveProperty('prompt');
  });

  it('drops unknown payloads and sanitizes secrets and absolute paths', () => {
    const { entries, lines, logger } = captureLogger('trace');

    logger.error('ACE', 'PROVIDER_FAILED', {
      errorCode: 'PROVIDER_OUTPUT_INVALID',
      launchToken: 'secret-launch-token',
      prompt: 'private prompt body',
      reason: 'token=abc123 failed at D:\\Users\\Master\\private.wav',
      relativePath: 'D:\\Users\\Master\\private.wav',
    });

    expect(lines[0]).toContain('token=[redacted]');
    expect(lines[0]).toContain('[redacted-path]');
    expect(lines[0]).not.toContain('abc123');
    expect(lines[0]).not.toContain('private.wav');
    expect(entries[0].fields).not.toHaveProperty('launchToken');
    expect(entries[0].fields).not.toHaveProperty('prompt');
  });

  it('normalizes Error identity without exposing stack traces', () => {
    const error = Object.assign(new Error('Provider failed.'), {
      code: 'PROVIDER_FAILED',
    });

    expect(toDiagnosticErrorFields(error)).toEqual({
      errorCode: 'PROVIDER_FAILED',
      reason: 'Provider failed.',
    });
    expect(toDiagnosticErrorFields(error)).not.toHaveProperty('stack');
  });
});
