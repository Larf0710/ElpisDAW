import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const diagnosticsSource = readFileSync(
  new URL('./projectPlaybackDiagnostics.ts', import.meta.url),
  'utf8',
);
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('visible Playback TRACE contract', () => {
  it('places the official TRACE control beside the ElpisDAW version', () => {
    const brandStart = appSource.indexOf('<div className="brand-title-row">');
    const version = appSource.indexOf('className="brand-version"', brandStart);
    const traceButton = appSource.indexOf('className={`playback-trace-button', version);
    const brandEnd = appSource.indexOf('</div>', traceButton);

    expect(brandStart).toBeGreaterThan(-1);
    expect(version).toBeGreaterThan(brandStart);
    expect(traceButton).toBeGreaterThan(version);
    expect(brandEnd).toBeGreaterThan(traceButton);
    expect(stylesSource).toContain('.playback-trace-button');
  });

  it('keeps TRACE available outside development builds and excludes media payloads', () => {
    expect(diagnosticsSource).not.toContain('import.meta.env.DEV');
    expect(diagnosticsSource).toContain("import.meta.env.MODE !== 'test'");
    expect(diagnosticsSource).toContain('MAX_DIAGNOSTIC_RECORDS = 200');
    expect(diagnosticsSource).not.toMatch(/arrayBuffer|base64|audioData|channelData/);
    expect(appSource).toContain(
      'Audio content and Project files are not included.',
    );
  });
});
