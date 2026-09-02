export const PROJECT_MIXDOWN_API_PROTOCOL_VERSION_V1 = '1';
export const PROJECT_MIXDOWN_API_PROTOCOL_VERSION = '2';
export const PROJECT_MIXDOWN_OPERATION_ID_PREFIX = 'mixdown-operation-';
export const PROJECT_MIXDOWN_OPERATION_ID_PATTERN =
  /^mixdown-operation-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PROJECT_MIXDOWN_CLIENT_TIMEOUT_MS = 32 * 60 * 1_000;
export const MAX_PROJECT_MIXDOWN_REQUEST_BYTES = 4 * 1024 * 1024;

export function isProjectMixdownOperationId(value) {
  return (
    typeof value === 'string' &&
    PROJECT_MIXDOWN_OPERATION_ID_PATTERN.test(value)
  );
}

export function createProjectMixdownArtifactId(operationId) {
  return isProjectMixdownOperationId(operationId)
    ? `artifact-${operationId.slice(PROJECT_MIXDOWN_OPERATION_ID_PREFIX.length)}`
    : undefined;
}
