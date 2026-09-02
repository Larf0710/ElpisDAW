import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const handlerStart = appSource.indexOf(
  'const handleRequestRemoveClipTakeFromProject',
);
const handlerEnd = appSource.indexOf(
  '\n\n  const deleteClipTakeAndAudioFile',
  handlerStart,
);
const handlerSource = appSource.slice(handlerStart, handlerEnd);

describe('Active Clip Take removal confirmation visible contract', () => {
  it('uses media-aware confirmation copy for the selected Take', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(appSource).toContain(
      "createActiveClipTakeRemovalConfirmationCopy,",
    );
    expect(handlerSource).toContain(
      'createActiveClipTakeRemovalConfirmationCopy(',
    );
    expect(handlerSource).toContain('confirmedRemoval.removedClipTake,');
    expect(handlerSource).toContain('message: confirmationCopy.message');
    expect(handlerSource).toContain('confirmationCopy.preservationDetail');
  });

  it('does not hard-code Audio preservation copy in the UI handler', () => {
    expect(handlerSource).not.toContain(
      "'The physical Audio file will be preserved.'",
    );
  });
});
