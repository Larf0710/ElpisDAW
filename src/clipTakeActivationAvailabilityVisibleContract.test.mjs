import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const handlerStart = appSource.indexOf('const handleActivateClipTake = useCallback(');
const handlerEnd = appSource.indexOf(
  '\n\n  const handleRefreshPianoRollSoundFonts = useCallback(',
  handlerStart,
);

describe('Clip Take activation availability visible contract', () => {
  it('verifies an Audio Take before activation and forwards exact evidence', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);

    const source = appSource.slice(handlerStart, handlerEnd);

    expect(source).toContain('async (clipId: string, clipTakeId: string) =>');
    expect(source).toContain('verifyClipTakeActivationAvailability(');
    expect(source).toContain('{ sourceAvailability: availability.evidence }');
    expect(source).toContain(
      "verifiedActivation.clip.sourceFile?.status !== 'available'",
    );
    expect(source).toContain(
      "currentActivation.clip.sourceFile?.status === 'available'",
    );
  });

  it('preserves the current Take when availability, Project, or Engine validation fails', () => {
    const source = appSource.slice(handlerStart, handlerEnd);

    expect(source).toContain(
      'clipTakeActivationRequestIdRef.current !== requestId',
    );
    expect(source).toContain(
      'workspaceRef.current.project !== expectedProject',
    );
    expect(source).toContain(
      'engineAvailabilityRef.current.productionEditingLocked',
    );
    expect(source).toContain('The current Active Take was preserved.');
  });
});
