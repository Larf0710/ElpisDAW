import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('visible FINAL FILER contract', () => {
  it('places FINAL FILER first in the hamburger menu followed immediately by a separator', () => {
    const menuStart = appSource.indexOf('className="app-menu"');
    const finalFiler = appSource.indexOf('FINAL FILER <small>DELIVER</small>', menuStart);
    const separator = appSource.indexOf('className="menu-separator" role="separator"', finalFiler);
    const projectSection = appSource.indexOf('<span className="menu-section-label">Project</span>', menuStart);

    expect(menuStart).toBeGreaterThan(-1);
    expect(finalFiler).toBeGreaterThan(menuStart);
    expect(separator).toBeGreaterThan(finalFiler);
    expect(projectSection).toBeGreaterThan(separator);
    expect(appSource.slice(finalFiler, separator)).not.toContain('menu-command');
  });

  it('renders the settled right-side delivery fields and accessible busy/cancel controls', () => {
    expect(appSource).toContain('className="project-inspector final-filer-drawer"');
    expect(appSource).toContain('aria-label="FINAL FILER"');
    expect(appSource).toContain('aria-modal="true"');
    expect(appSource).toContain('aria-busy={isBusy}');
    expect(appSource).toContain('<dt>Source</dt>');
    expect(appSource).toContain('<dt>Readiness</dt>');
    expect(appSource).toContain('<dt>Lineage</dt>');
    expect(appSource).toContain('<span>File Name</span>');
    expect(appSource).toContain('<span>Destination</span>');
    expect(appSource).toContain('<strong>Browser Downloads</strong>');
    expect(appSource).toContain('<span>Include Source Report</span>');
    expect(appSource).toContain("useState(true);");
    expect(appSource).toContain("{isBusy ? 'PREPARING...' : 'EXPORT WAV'}");
    expect(appSource).toContain('CANCEL');
    expect(appSource).toContain("event.key === 'Escape'");
  });

  it('uses a production controller instead of historical Clip Filer PatchTab state', () => {
    expect(appSource).toContain('new FinalFilerController()');
    expect(appSource).toContain('resolveFinalFilerAvailability(project)');
    expect(appSource).toContain('client.readGeneratedAudioWav(descriptor, { signal })');
    expect(appSource).not.toContain('resolveClipFilerFinalExportTarget(');
    expect(appSource).not.toMatch(/FINAL FILER[\s\S]{0,600}humstudio\.patch\.clip-filer/);
  });

  it('keeps the drawer bounded in the existing Inspector visual language', () => {
    expect(stylesSource).toContain('.final-filer-drawer');
    expect(stylesSource).toContain('width: min(430px, calc(100vw - 28px));');
    expect(stylesSource).toContain('max-height: calc(100vh - 86px);');
    expect(stylesSource).toContain('overflow-y: auto;');
    expect(stylesSource).toContain('.final-filer-actions button:disabled');
    expect(stylesSource).toContain('.final-filer-field input:focus-visible');
  });
});
