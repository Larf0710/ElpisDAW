import { MAX_PROJECT_MIXDOWN_REQUEST_BYTES } from './projectMixdownApiProtocol.js';

const MAX_CANONICAL_JSON_DEPTH = 32;

export function createCanonicalProjectRenderPlanJson(value) {
  const canonical = canonicalJson(value, 0);

  return canonical !== undefined &&
    new TextEncoder().encode(canonical).byteLength <=
      MAX_PROJECT_MIXDOWN_REQUEST_BYTES
    ? canonical
    : undefined;
}

function canonicalJson(value, depth) {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalJson(entry, depth + 1));
    return entries.some((entry) => entry === undefined)
      ? undefined
      : `[${entries.join(',')}]`;
  }

  if (isRecord(value)) {
    const entries = [];

    for (const key of Object.keys(value).sort()) {
      const entry = canonicalJson(value[key], depth + 1);

      if (entry === undefined) {
        return undefined;
      }

      entries.push(`${JSON.stringify(key)}:${entry}`);
    }

    return `{${entries.join(',')}}`;
  }

  return value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
    ? JSON.stringify(value)
    : undefined;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
