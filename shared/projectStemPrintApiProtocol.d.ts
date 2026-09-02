export const PROJECT_STEM_PRINT_API_PROTOCOL_VERSION: '1';
export const PROJECT_STEM_PRINT_OPERATION_ID_PREFIX: 'stem-print-operation-';
export const PROJECT_STEM_PRINT_OPERATION_ID_PATTERN: RegExp;
export const MAX_PROJECT_STEM_PRINT_REQUEST_BYTES: number;

export function isProjectStemPrintOperationId(value: unknown): value is string;
export function createProjectStemPrintArtifactId(
  operationId: string,
): string | undefined;
