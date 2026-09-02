export const PRINT_MIX_PROTOCOL_VERSION: '1';
export const PRINT_MIX_PLAN_VERSION: 1;
export const PRINT_MIX_OPERATION_ID_PREFIX: 'print-mix-operation-';
export const PRINT_MIX_OPERATION_ID_PATTERN: RegExp;
export const PRINT_MIX_RENDERER_ID: 'humstudio.print-mix.pcm16';
export const PRINT_MIX_RENDERER_VERSION: '1.0.0';
export const PRINT_MIX_NORMALIZE_TARGET_DBFS: -1;
export const PRINT_MIX_NORMALIZE_TARGET_PEAK: number;
export const PRINT_MIX_BITS_PER_SAMPLE: 16;
export const PRINT_MIX_CHANNELS: 2;
export const PRINT_MIX_ENCODING: 'pcm_s16le';
export const PRINT_MIX_EXTENSION: '.wav';
export const PRINT_MIX_MIME_TYPE: 'audio/wav';
export const PRINT_MIX_SAMPLE_RATE: 44_100;
export const PRINT_MIX_CLIENT_TIMEOUT_MS: number;
export const MAX_PRINT_MIX_REQUEST_BYTES: number;
export const PRINT_MIX_WAVE_FORMAT: Readonly<{
  bitsPerSample: 16;
  channels: 2;
  encoding: 'pcm_s16le';
  extension: '.wav';
  mimeType: 'audio/wav';
  sampleRate: 44_100;
}>;

export function isPrintMixOperationId(value: unknown): value is string;
export function createPrintMixArtifactId(
  operationId: string,
): string | undefined;
