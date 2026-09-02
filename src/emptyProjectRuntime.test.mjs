import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('empty production Project runtime', () => {
  it('keeps startup and reset paths independent from sampleProject', () => {
    expect(appSource).toContain(
      "import { createDefaultPatchTabs, createEmptyProject } from './emptyProject';",
    );
    expect(appSource).not.toContain("from './sampleProject'");
    expect(appSource).toMatch(
      /function createInitialWorkspaceState\(\): WorkspaceState \{[\s\S]*const project = createEmptyProject\(\)/,
    );
    expect(appSource).toMatch(
      /const handleResetWorkspace = useCallback\(\(\) => \{[\s\S]*createInitialWorkspaceState\(\)/,
    );
  });
});
