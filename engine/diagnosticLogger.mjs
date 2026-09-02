import { posix, win32 } from 'node:path';

export const DIAGNOSTIC_LOG_LEVELS = Object.freeze([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
]);

export const DIAGNOSTIC_LOG_SUBSYSTEMS = Object.freeze([
  'ENGINE',
  'QUEUE',
  'WORKER',
  'BASIC_PITCH',
  'FLUIDSYNTH',
  'SA3',
  'ACE',
  'ARTIFACT',
  'SOURCE',
  'EXPORT',
  'PLAYBACK',
]);

const LOG_LEVEL_PRIORITY = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  off: Number.POSITIVE_INFINITY,
});
const LOG_EVENT_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_FIELD_TEXT_LENGTH = 320;
const FIELD_ORDER = Object.freeze([
  'operationId',
  'jobId',
  'providerId',
  'taskId',
  'clipId',
  'clipTakeId',
  'artifactId',
  'sourceId',
  'workerId',
  'requestId',
  'reservationId',
  'modelId',
  'modelRevision',
  'operation',
  'phase',
  'progressAccuracy',
  'progressPercent',
  'currentStep',
  'totalSteps',
  'fromState',
  'toState',
  'state',
  'status',
  'attempt',
  'destination',
  'relativePath',
  'sizeBytes',
  'bytesWritten',
  'durationSeconds',
  'elapsedSeconds',
  'lastUpdateAgeSeconds',
  'channels',
  'sampleRate',
  'sourceCount',
  'availableCount',
  'unavailableCount',
  'queueDepth',
  'activeJobId',
  'instanceId',
  'port',
  'protocolVersion',
  'compatibility',
  'exitCode',
  'signal',
  'reason',
  'errorCode',
]);
const ALLOWED_FIELDS = new Set(FIELD_ORDER);
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(authorization|bearer|credential|launch[_-]?token|password|secret|token)\s*[:=]\s*[^\s,;]+/gi;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /[a-zA-Z]:[\\/].*$/;
const POSIX_PRIVATE_PATH_PATTERN = /\/(?:Users|home|mnt|opt|private|tmp|var)\/.*$/;

export function resolveDiagnosticLogLevel(environment = process.env) {
  const configured = environment?.HUMSTUDIO_LOG_LEVEL?.trim().toLowerCase();

  if (configured === 'off' || DIAGNOSTIC_LOG_LEVELS.includes(configured)) {
    return configured;
  }

  return environment?.NODE_ENV === 'test' ? 'off' : 'info';
}

export function createDiagnosticLogger({
  environment = process.env,
  level = resolveDiagnosticLogLevel(environment),
  now = () => new Date().toISOString(),
  sink = writeConsoleLine,
} = {}) {
  const normalizedLevel = normalizeLogLevel(level);

  if (typeof now !== 'function' || typeof sink !== 'function') {
    throw new TypeError('Diagnostic logger now and sink options must be functions.');
  }

  const emit = (entryLevel, subsystem, event, fields = {}) => {
    try {
      if (
        !isLogLevelEnabled(entryLevel, normalizedLevel) ||
        !DIAGNOSTIC_LOG_SUBSYSTEMS.includes(subsystem) ||
        typeof event !== 'string' ||
        !LOG_EVENT_PATTERN.test(event)
      ) {
        return false;
      }

      const timestamp = normalizeTimestamp(now());
      const sanitizedFields = sanitizeDiagnosticFields(fields);
      const entry = Object.freeze({
        event,
        fields: sanitizedFields,
        level: entryLevel.toUpperCase(),
        subsystem,
        timestamp,
      });
      sink(formatDiagnosticLogEntry(entry), entry);
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    debug: (subsystem, event, fields) => emit('debug', subsystem, event, fields),
    error: (subsystem, event, fields) => emit('error', subsystem, event, fields),
    getLevel: () => normalizedLevel,
    info: (subsystem, event, fields) => emit('info', subsystem, event, fields),
    isEnabled: (entryLevel) => isLogLevelEnabled(entryLevel, normalizedLevel),
    trace: (subsystem, event, fields) => emit('trace', subsystem, event, fields),
    warn: (subsystem, event, fields) => emit('warn', subsystem, event, fields),
  });
}

export function formatDiagnosticLogEntry(entry) {
  const fieldText = FIELD_ORDER.flatMap((field) =>
    Object.prototype.hasOwnProperty.call(entry.fields, field)
      ? [`${field}=${formatFieldValue(entry.fields[field])}`]
      : [],
  ).join(' ');

  return `[${entry.timestamp}] [${entry.level}] [${entry.subsystem}] event=${entry.event}${
    fieldText ? ` ${fieldText}` : ''
  }`;
}

export function toDiagnosticErrorFields(error) {
  return Object.freeze({
    errorCode:
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'UNEXPECTED_ERROR',
    reason: error instanceof Error ? error.message : String(error),
  });
}

export const localEngineLogger = createDiagnosticLogger();

function sanitizeDiagnosticFields(value) {
  if (!isRecord(value)) {
    return Object.freeze({});
  }

  const entries = [];

  for (const field of FIELD_ORDER) {
    if (!ALLOWED_FIELDS.has(field) || !Object.prototype.hasOwnProperty.call(value, field)) {
      continue;
    }

    const sanitized = sanitizeFieldValue(field, value[field]);

    if (sanitized !== undefined) {
      entries.push([field, sanitized]);
    }
  }

  return Object.freeze(Object.fromEntries(entries));
}

function sanitizeFieldValue(field, value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  if (field === 'relativePath') {
    const normalizedPath = value.trim().replace(/\\/g, '/');

    if (
      !normalizedPath ||
      win32.isAbsolute(normalizedPath) ||
      posix.isAbsolute(normalizedPath) ||
      normalizedPath.split('/').includes('..')
    ) {
      return '[redacted-path]';
    }

    return limitText(normalizedPath);
  }

  return limitText(redactSensitiveText(value));
}

function redactSensitiveText(value) {
  const singleLine = value.replace(/[\r\n\t]+/g, ' ').trim();
  const withoutSecrets = singleLine.replace(
    SENSITIVE_ASSIGNMENT_PATTERN,
    (_match, label) => `${label}=[redacted]`,
  );

  return withoutSecrets
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, '[redacted-path]')
    .replace(POSIX_PRIVATE_PATH_PATTERN, '[redacted-path]');
}

function limitText(value) {
  return value.length <= MAX_FIELD_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_FIELD_TEXT_LENGTH - 1)}…`;
}

function formatFieldValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return /^[A-Za-z0-9._:@/+\-[\]]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

function normalizeTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? value
    : new Date().toISOString();
}

function normalizeLogLevel(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';

  return normalized === 'off' || DIAGNOSTIC_LOG_LEVELS.includes(normalized)
    ? normalized
    : 'info';
}

function isLogLevelEnabled(entryLevel, configuredLevel) {
  return (
    Object.prototype.hasOwnProperty.call(LOG_LEVEL_PRIORITY, entryLevel) &&
    LOG_LEVEL_PRIORITY[entryLevel] >= LOG_LEVEL_PRIORITY[configuredLevel]
  );
}

function writeConsoleLine(line, entry) {
  const stream = entry.level === 'WARN' || entry.level === 'ERROR'
    ? process.stderr
    : process.stdout;
  stream.write(`${line}\n`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
