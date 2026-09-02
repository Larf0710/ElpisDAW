import { describe, expect, it } from 'vitest';

import {
  MAX_PROJECT_STEM_PRINT_REQUEST_BYTES,
  PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
  PROJECT_STEM_PRINT_OPERATION_ID_PREFIX,
  createProjectStemPrintArtifactId,
  isProjectStemPrintOperationId,
} from './projectStemPrintApiProtocol.js';
import { MAX_PROJECT_MIXDOWN_REQUEST_BYTES } from './projectMixdownApiProtocol.js';

describe('Project Stem Print API protocol', () => {
  it('pins one exact operation identity and shared request budget', () => {
    const operationId =
      'stem-print-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    expect(PROJECT_STEM_PRINT_API_PROTOCOL_VERSION).toBe('1');
    expect(PROJECT_STEM_PRINT_OPERATION_ID_PREFIX).toBe(
      'stem-print-operation-',
    );
    expect(MAX_PROJECT_STEM_PRINT_REQUEST_BYTES).toBe(
      MAX_PROJECT_MIXDOWN_REQUEST_BYTES,
    );
    expect(isProjectStemPrintOperationId(operationId)).toBe(true);
    expect(createProjectStemPrintArtifactId(operationId)).toBe(
      'artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(isProjectStemPrintOperationId(
      'mixdown-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    )).toBe(false);
  });
});
