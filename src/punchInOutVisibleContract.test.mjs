import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Punch In / Punch Out visible contract', () => {
  it('keeps the split range control, ruler markers, and temporary Attempt actions visible', async () => {
    const [appSource, styles] = await Promise.all([
      readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./styles.css', import.meta.url), 'utf8'),
    ]);

    expect(appSource).toContain("'Set Punch In at Playhead' : 'Clear Punch In'");
    expect(appSource).toContain("'Set Punch Out at Playhead' : 'Clear Punch Out'");
    expect(appSource).toContain('aria-pressed={inTick !== undefined}');
    expect(appSource).toContain('aria-pressed={outTick !== undefined}');
    expect(appSource).toContain("inTick !== undefined ? 'active' : ''");
    expect(appSource).toContain("outTick !== undefined ? 'active' : ''");
    expect(appSource).toContain(
      "inTick === undefined ? '--' : formatPunchMarkerPosition(inTick)",
    );
    expect(appSource).toContain(
      "outTick === undefined ? '--' : formatPunchMarkerPosition(outTick)",
    );
    expect(appSource).toContain(
      'return String(Math.floor(ticksToBeats(tick) + 1));',
    );
    expect(appSource).toContain('PUNCH ATTEMPTS');
    expect(appSource).toContain('KEEP SELECTED AS NEW TAKE');
    expect(appSource).toContain('DISCARD SESSION');
    expect(appSource).toContain('className="punch-ruler-marker punch-in"');
    expect(appSource).toContain('className="punch-ruler-marker punch-out"');
    expect(styles).toMatch(
      /\.timeline-transport \.transport-controls\s*\{[^}]*repeat\(8, 54px\)/s,
    );
    expect(styles).toContain('.punch-ruler-range');
    expect(styles).toContain('.punch-attempts-panel');
    expect(styles).toContain('.punch-range-half.active');
    expect(styles).toContain('clip-path: path(');
    expect(styles).toMatch(/\.punch-range-half\.active,[^{]*\{[^}]*color: #160d05;/s);
    expect(styles).toMatch(/\.punch-range-half\.active,[^{]*\{[^}]*background: #e78938;/s);
    expect(styles).toMatch(
      /\.punch-range-control\s*\{[^}]*border: 1px solid #3c4652;[^}]*linear-gradient\(180deg, #282f37, #101317 58%, #090b0e\)/s,
    );
    expect(styles).toMatch(
      /\.punch-range-half small\s*\{[^}]*font-size: 0\.56rem;[^}]*font-weight: 800;/s,
    );
    expect(styles).toMatch(/\.transport-icon\.loop\s*\{[^}]*color: #b884ff;/s);
    expect(styles).toMatch(
      /\.punch-range-control\.valid \.punch-range-divider path\s*\{[^}]*stroke: rgba\(10, 8, 6, 0\.94\);/s,
    );
    expect(styles).toMatch(/\.punch-ruler-marker\s*\{[^}]*font-size: 1rem;/s);
  });

  it('keeps PATCH CHECK compact and text-only', async () => {
    const [appSource, styles] = await Promise.all([
      readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./styles.css', import.meta.url), 'utf8'),
    ]);
    const patchCheckButton = appSource.match(
      /className=\{`timeline-icon-action auto-patch patch-check[\s\S]*?<\/button>/,
    )?.[0];

    expect(patchCheckButton).toBeDefined();
    expect(patchCheckButton).toContain('>PATCH CHECK</span>');
    expect(patchCheckButton).not.toContain('auto-patch-machine-icon');
    expect(patchCheckButton).not.toContain('auto-patch-machine-meter');
    expect(styles).toMatch(
      /\.timeline-icon-action\.auto-patch\.patch-check\s*\{[^}]*width: 54px;[^}]*height: 52px;/s,
    );
  });
});
