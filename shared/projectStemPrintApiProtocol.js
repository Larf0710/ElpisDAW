import { MAX_PROJECT_MIXDOWN_REQUEST_BYTES } from './projectMixdownApiProtocol.js';

export const PROJECT_STEM_PRINT_API_PROTOCOL_VERSION = '1';
export const PROJECT_STEM_PRINT_OPERATION_ID_PREFIX = 'stem-print-operation-';
export const PROJECT_STEM_PRINT_OPERATION_ID_PATTERN =
  /^stem-print-operation-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_PROJECT_STEM_PRINT_REQUEST_BYTES =
  MAX_PROJECT_MIXDOWN_REQUEST_BYTES;

export function isProjectStemPrintOperationId(value) {
  return (
    typeof value === 'string' &&
    PROJECT_STEM_PRINT_OPERATION_ID_PATTERN.test(value)
  );
}

export function createProjectStemPrintArtifactId(operationId) {
  return isProjectStemPrintOperationId(operationId)
    ? `artifact-${operationId.slice(PROJECT_STEM_PRINT_OPERATION_ID_PREFIX.length)}`
    : undefined;
}
