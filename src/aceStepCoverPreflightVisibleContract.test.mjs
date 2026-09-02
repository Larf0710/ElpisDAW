import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const handlerStart = appSource.indexOf('const handleGenerateAceStepCover = useCallback(');
const handlerEnd = appSource.indexOf(
  '\n\n  const handleCancelAceStepCover = useCallback(',
  handlerStart,
);

describe('ACE Cover preflight visible contract', () => {
  it('completes local validation before saving the immutable Lyrics snapshot', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);

    const source = appSource.slice(handlerStart, handlerEnd);
    const preflightIndex = source.indexOf('preflightAceStepCoverRun(');
    const lyricsSaveIndex = source.indexOf('client.saveAceStepLyrics(');

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(lyricsSaveIndex).toBeGreaterThan(preflightIndex);
  });
});
