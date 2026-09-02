import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const healthStart = appSource.indexOf('function createProjectHealth(');
const healthEnd = appSource.indexOf('\nfunction ', healthStart + 1);
const healthSource = appSource.slice(healthStart, healthEnd);

describe('Project Inspector routing label visible contract', () => {
  it('uses the same readable direction arrow as the Routing panel', () => {
    expect(healthStart).toBeGreaterThan(-1);
    expect(healthSource).toContain(
      '`${selectedSourcePatchTab.name} → ${selectedTargetPatchTab.name}`',
    );
    expect(appSource).toContain(
      '{selectedSourcePatchTab.name} → {selectedTargetPatchTab.name}',
    );
  });

  it('keeps the no-selection fallback when a route or endpoint is absent', () => {
    expect(healthSource).toContain(
      'selectedConnection && selectedSourcePatchTab && selectedTargetPatchTab',
    );
    expect(healthSource).toContain(": 'No TabFlow Line Selected'");
  });

  it('renders the health routing label in the Project Inspector', () => {
    expect(appSource).toContain('aria-label="Project Inspector"');
    expect(appSource).toContain('<dd>{health.selectedRoutingName}</dd>');
  });
});
