export const PROJECT_MIXDOWN_API_PROTOCOL_VERSION_V1: '1';
export const PROJECT_MIXDOWN_API_PROTOCOL_VERSION: '2';
export const PROJECT_MIXDOWN_OPERATION_ID_PREFIX: 'mixdown-operation-';
export const PROJECT_MIXDOWN_OPERATION_ID_PATTERN: RegExp;
export const PROJECT_MIXDOWN_CLIENT_TIMEOUT_MS: number;
export const MAX_PROJECT_MIXDOWN_REQUEST_BYTES: number;

export function isProjectMixdownOperationId(value: unknown): value is string;
export function createProjectMixdownArtifactId(
  operationId: unknown,
): string | undefined;
