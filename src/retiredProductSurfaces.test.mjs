import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const mainDockSource = appSource.slice(
  appSource.indexOf('className="top-dock-main-grid"'),
  appSource.indexOf("loadedTopDockIds.has('piano-roll')"),
);

describe('retired product surfaces', () => {
  it('removes mock and dummy controls while keeping mock-backed Hum conversion unreachable', () => {
    [
      'Mock Audio Prep',
      'MOCKUP ONLY / DSP COMMIT NOT IMPLEMENTED',
      'Dummy Conversion',
      'Dummy Processing',
      'Local Engine Mock Job',
      'GENERATE MOCK TAKE',
      'GPU JOB RUNNING',
      'Reset Demo',
      'demo workspace',
      'timeline mock data',
      'eyebrow="Basic Pitch"',
      'title="Convert Hum to MIDI"',
      'onConvertSelectedHumToMidi',
      'runLocalEngineHumToMidiGeneration',
      'createMockHumToMidiGenerationPlan',
    ].forEach((label) => expect(appSource).not.toContain(label));

    expect(appSource).toContain('Reset Workspace');
    expect(appSource).toContain('title="Render MIDI to Audio"');
  });

  it('restores the standalone Routing panel and the three-surface Main Dock', () => {
    expect(mainDockSource).toContain('<RoutingPanel');
    expect(appSource).toContain('function RoutingPanel');
    expect(appSource).toContain('aria-label="Routing flow diagram"');
    expect(appSource).toContain('eyebrow="TabFlow"');
    expect(appSource).toContain('title="Routing"');
    expect(stylesSource).toMatch(
      /\.top-dock-main-grid\s*\{[\s\S]*grid-template-areas:\s*"rack detail routing"/,
    );
  });

  it('keeps PatchTab port controls without a competing compact connection editor', () => {
    expect(appSource).not.toContain('<PatchTabConnectionList');
    expect(appSource).not.toContain('function PatchTabConnectionList');
    expect(stylesSource).not.toContain('.patchtab-connections');
    expect(appSource).toMatch(
      /aria-label=\{`Connect \$\{patchTab\.name\} \$\{inputPort\.portLabel\} input from`\}/,
    );
    expect(appSource).toMatch(
      /aria-label=\{`Connect \$\{patchTab\.name\} \$\{outputPort\.portLabel\} output to`\}/,
    );
  });

  it('keeps route selection, unlocked line controls, Auto Flow, and safe disconnection', () => {
    expect(appSource).toContain('aria-label={`Turn TabFlow line ${tabFlowLineLabel}');
    expect(appSource).toContain('AUTO FLOW');
    expect(appSource).toContain('className="connection-delete-button"');
    expect(appSource).toMatch(/role="button"[\s\S]*tabIndex=\{0\}[\s\S]*event\.key === 'Enter'/);
    expect(appSource).not.toContain('isRouteEditingLocked');
    expect(appSource).not.toContain('onRouteEditLockedAttempt');
    expect(appSource).toMatch(
      /isSafetyModeEnabled && deletionImpact\?\.downstreamCount[\s\S]*onRequestSafetyConfirm/,
    );
    expect(appSource).toMatch(/removeConnectionAndDownstream\([\s\S]*pruneEmptiedTabFlowLines/);
    expect(stylesSource).toMatch(
      /\.connection-row\s*\{[\s\S]*grid-template-columns:\s*14px minmax\(0, 1fr\) minmax\(0, 1\.15fr\) minmax\(0, 1fr\) 48px 30px/,
    );
  });

  it('keeps route mutations structurally fail-closed and requires an explicit selected TabFlow line', () => {
    expect(appSource).toMatch(
      /getTabFlowStructureState\([\s\S]*createTabFlowStructureBlockedHelpMessage/,
    );
    expect(appSource).toMatch(
      /if \(!activeTabFlowLine\) \{[\s\S]*ROUTE_LINE_REQUIRED_HELP_MESSAGE/,
    );
    expect(appSource).not.toMatch(/existingTabFlowLines\[0\] \?\? \{/);
    expect(appSource).toContain("'--child-lane-start': row.startIndex");
    expect(stylesSource).toContain('var(--child-lane-start) * 50px');
  });

  it('redirects Inspector route issues to the affected PatchTab context', () => {
    expect(appSource).toMatch(
      /const handleSelectRoutingIssue[\s\S]*handleSelectPatchTab\(connection\.toPatchTabId\)[\s\S]*handleSelectConnection\(connectionId\)/,
    );
  });
});
