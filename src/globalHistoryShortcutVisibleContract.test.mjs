import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('global Project History shortcut visible contract', () => {
  const effectStart = appSource.indexOf("window.addEventListener('keydown', handleKeyDown)");
  const effectSource = appSource.slice(appSource.lastIndexOf('useEffect(() => {', effectStart), effectStart);

  it('leaves Undo and Redo to editable form fields', () => {
    expect(effectStart).toBeGreaterThan(-1);
    expect(effectSource).toContain('isEditableEventTarget(event.target)');
    expect(appSource).toContain(
      "target.closest('input, textarea, select, [contenteditable=\"true\"]')",
    );
  });

  it('keeps Project History shortcuts on non-editable surfaces', () => {
    expect(effectSource).toContain("event.key.toLowerCase() === 'z'");
    expect(effectSource).toContain('handleUndo()');
    expect(effectSource).toContain('handleRedo()');
    expect(effectSource).toContain("event.target.closest('.piano-roll-spike')");
  });
});
