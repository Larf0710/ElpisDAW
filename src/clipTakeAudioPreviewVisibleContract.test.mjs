import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

function readComponentSource(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  return appSource.slice(start, end);
}

describe('Clip Take Audio Preview visible availability contract', () => {
  it('disables unavailable Take preview in the Timeline popover with an accessible reason', () => {
    const source = readComponentSource(
      'function ClipTakePopover(',
      '\n\nfunction InspectorEditHistory(',
    );

    expect(source).toContain('resolveClipTakeAudioPreview(');
    expect(source).toContain('disabled={!previewResolution.canPreview}');
    expect(source).toContain('aria-label={previewControlLabel}');
    expect(source).toContain('title={previewControlLabel}');
    expect(source).toContain('`Preview unavailable: ${previewResolution.message}`');
  });

  it('disables unavailable Take preview in Project Inspector while preserving Stop Preview', () => {
    const source = readComponentSource(
      'function ClipTakeManagementPanel(',
      '\n\nfunction SessionHistoryPanel(',
    );

    expect(source).toContain('resolveClipTakeAudioPreview(');
    expect(source).toContain(
      'isPreviewingSelected || previewResolution?.canPreview === true',
    );
    expect(source).toContain('disabled={!canTogglePreview}');
    expect(source).toContain('aria-label={previewControlLabel}');
    expect(source).toContain('title={previewControlLabel}');
    expect(source).toContain("previewUnavailableMessage\n          ? 'ERROR'");
  });
});
