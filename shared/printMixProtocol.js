export const PRINT_MIX_PROTOCOL_VERSION = '1';
export const PRINT_MIX_PLAN_VERSION = 1;
export const PRINT_MIX_OPERATION_ID_PREFIX = 'print-mix-operation-';
export const PRINT_MIX_OPERATION_ID_PATTERN =
  /^print-mix-operation-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PRINT_MIX_RENDERER_ID = 'humstudio.print-mix.pcm16';
export const PRINT_MIX_RENDERER_VERSION = '1.0.0';
export const PRINT_MIX_NORMALIZE_TARGET_DBFS = -1;
export const PRINT_MIX_NORMALIZE_TARGET_PEAK =
  10 ** (PRINT_MIX_NORMALIZE_TARGET_DBFS / 20);
export const PRINT_MIX_BITS_PER_SAMPLE = 16;
export const PRINT_MIX_CHANNELS = 2;
export const PRINT_MIX_ENCODING = 'pcm_s16le';
export const PRINT_MIX_EXTENSION = '.wav';
export const PRINT_MIX_MIME_TYPE = 'audio/wav';
export const PRINT_MIX_SAMPLE_RATE = 44_100;
export const PRINT_MIX_CLIENT_TIMEOUT_MS = 32 * 60 * 1_000;
export const MAX_PRINT_MIX_REQUEST_BYTES = 4 * 1024 * 1024;

export const PRINT_MIX_WAVE_FORMAT = Object.freeze({
  bitsPerSample: PRINT_MIX_BITS_PER_SAMPLE,
  channels: PRINT_MIX_CHANNELS,
  encoding: PRINT_MIX_ENCODING,
  extension: PRINT_MIX_EXTENSION,
  mimeType: PRINT_MIX_MIME_TYPE,
  sampleRate: PRINT_MIX_SAMPLE_RATE,
});

export function isPrintMixOperationId(value) {
  return (
    typeof value === 'string' &&
    PRINT_MIX_OPERATION_ID_PATTERN.test(value)
  );
}

export function createPrintMixArtifactId(operationId) {
  return isPrintMixOperationId(operationId)
    ? `artifact-${operationId.slice(PRINT_MIX_OPERATION_ID_PREFIX.length)}`
    : undefined;
}
