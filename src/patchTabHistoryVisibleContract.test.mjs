import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('PatchTab Edit History visible contract', () => {
  it.each([
    ['handleAddPatchTab', 'handleMovePatchTab'],
    ['handleMovePatchTab', 'handleRenamePatchTab'],
    ['handleRenamePatchTab', 'handleDeletePatchTab'],
    ['handleDeletePatchTab', 'handleRequestDeletePatchTab'],
  ])('labels %s commits as PatchTab edits', (handlerName, nextHandlerName) => {
    const handlerStart = appSource.indexOf(`const ${handlerName}`);
    const handlerEnd = appSource.indexOf(`const ${nextHandlerName}`, handlerStart);
    const handlerSource = appSource.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handlerSource).toContain('patchTabHistoryEditDraft');
  });

  it('keeps the explicit user-facing PatchTab history label', () => {
    expect(appSource).toContain("label: 'Edit PatchTabs'");
  });
});
