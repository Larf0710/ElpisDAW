import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const pianoRollSource = readFileSync(
  new URL('./PianoRollInteractionSpike.tsx', import.meta.url),
  'utf8',
);

function getRuleBodies(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return [
    ...styles.matchAll(
      new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`, 'g'),
    ),
  ].map(
    (match) => match[1],
  );
}

describe('Studio layout visual contract', () => {
  it('reserves page and Top Dock scrollbar gutters across Timeline expansion', () => {
    const rootRule = getRuleBodies(':root')[0];
    const dockViewportRule = getRuleBodies('.top-dock-viewport')[0];

    expect(rootRule).toMatch(/overflow-y:\s*auto;/);
    expect(rootRule).toMatch(/scrollbar-gutter:\s*stable;/);
    expect(dockViewportRule).toMatch(/scrollbar-gutter:\s*stable;/);
    expect(dockViewportRule).toMatch(/scrollbar-width:\s*thin;/);
    expect(dockViewportRule).toMatch(/overscroll-behavior-x:\s*contain;/);
    expect(dockViewportRule).toMatch(/overscroll-behavior-y:\s*auto;/);
  });

  it('uses automatic stable-gutter scrollbars with outward vertical chaining', () => {
    const panelRule = getRuleBodies('.panel').find((rule) =>
      rule.includes('padding: 16px;'),
    );
    const pianoViewportRule = getRuleBodies('.piano-roll-spike-viewport')[0];
    const timelineTrackRule = getRuleBodies('.timeline-track-scroll')[0];
    const timelineHistoryRule = getRuleBodies('.timeline-history-panel')[0];

    for (const rule of [panelRule, timelineTrackRule]) {
      expect(rule).toMatch(/overflow-y:\s*auto;/);
      expect(rule).toMatch(/scrollbar-gutter:\s*stable;/);
    }

    for (const rule of [
      panelRule,
      pianoViewportRule,
      timelineTrackRule,
      timelineHistoryRule,
    ]) {
      expect(rule).toMatch(/overscroll-behavior-x:\s*contain;/);
      expect(rule).toMatch(/overscroll-behavior-y:\s*auto;/);
      expect(rule).not.toMatch(/overscroll-behavior:\s*contain;/);
    }
  });

  it('scrolls the Piano Function View without exposing a scrollbar', () => {
    const studioGridRule = getRuleBodies('.studio-grid')[0];
    const workspaceRule = getRuleBodies('.piano-roll-spike-workspace')[0];
    const functionRailRule = getRuleBodies('.piano-roll-function-rail')[0];
    const hiddenScrollbarRule = getRuleBodies(
      '.piano-roll-function-rail::-webkit-scrollbar',
    )[0];

    expect(studioGridRule).toMatch(/--piano-roll-function-rail-width:\s*118px;/);
    expect(workspaceRule).toMatch(
      /grid-template-columns:\s*var\(--piano-roll-function-rail-width\) minmax\(0, 1fr\);/,
    );
    expect(functionRailRule).toMatch(/overflow-x:\s*hidden;/);
    expect(functionRailRule).toMatch(/overflow-y:\s*auto;/);
    expect(functionRailRule).toMatch(/scrollbar-width:\s*none;/);
    expect(hiddenScrollbarRule).toMatch(/display:\s*none;/);
  });

  it('compacts only the ready Piano header and keeps its saved status inline', () => {
    const pianoPanelRule = getRuleBodies('.piano-roll-spike.panel')[0];
    const pianoHeaderRule = getRuleBodies('.piano-roll-spike-header')[0];
    const pianoActionsRule = getRuleBodies('.piano-roll-spike-actions')[0];
    const readyPianoRule = styles.match(
      /@media \(min-width: 1141px\) \{[\s\S]*?\.piano-roll-spike:not\(\.piano-roll-spike-empty\)\s*\{([\s\S]*?)\n  \}/,
    )?.[1];
    const workspaceRule = getRuleBodies('.piano-roll-spike-workspace')[0];
    const statusRowRule = getRuleBodies('.piano-roll-spike-status-row')[0];
    const readyNoteModuleRule = styles.match(
      /\.piano-roll-spike:not\(\.piano-roll-spike-empty\) \.piano-roll-note-module\s*\{([\s\S]*?)\n  \}/,
    )?.[1];
    const readyHeaderRule = styles.match(
      /\.piano-roll-spike:not\(\.piano-roll-spike-empty\) \.piano-roll-spike-header\s*\{([\s\S]*?)\n  \}/,
    )?.[1];

    expect(pianoRollSource).toMatch(
      /className="piano-roll-spike-status-row"[\s\S]*?<strong>\{takeStatus\.value\}<\/strong>[\s\S]*?<small>\{takeStatus\.detail\}<\/small>/,
    );
    expect(pianoPanelRule).toMatch(
      /--piano-roll-header-module-min-height:\s*48px;/,
    );
    expect(pianoPanelRule).toMatch(
      /--piano-roll-ready-header-row-height:\s*51px;/,
    );
    expect(pianoPanelRule).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\);/);
    expect(readyPianoRule).toMatch(
      /--piano-roll-header-module-min-height:\s*40px;/,
    );
    expect(readyHeaderRule).toMatch(
      /min-height:\s*var\(--piano-roll-ready-header-row-height\);/,
    );
    expect(readyNoteModuleRule).toMatch(/padding:\s*1px 5px;/);
    expect(pianoHeaderRule).toMatch(/minmax\(96px,\s*0\.38fr\)/);
    expect(pianoActionsRule.match(/minmax\(0,/g)).toHaveLength(6);
    expect(pianoRollSource).toMatch(
      /className="piano-roll-clear-all-button"[\s\S]*?disabled=\{editSession\.notes\.length === 0\}[\s\S]*?onClick=\{clearAllNotes\}[\s\S]*?CLEAR ALL/,
    );
    expect(pianoRollSource).toMatch(
      /const clearAllNotes = \(\) => \{[\s\S]*?commitNotes\(\[\]\);/,
    );
    expect(pianoRollSource).toMatch(
      /const triggerLiveNotePreview = [\s\S]*?onPrepareLiveNotePreview\(liveNotePreviewSelection\);[\s\S]*?onTriggerLiveNotePreview\(pitch, velocity\);/,
    );
    expect(statusRowRule).toMatch(/display:\s*flex;/);
    expect(statusRowRule).toMatch(/white-space:\s*nowrap;/);
    expect(workspaceRule).toMatch(/min-height:\s*0;/);
  });

  it('keeps the exact outer, row, and column spacing', () => {
    const appShellRules = [...styles.matchAll(/\.app-shell\s*\{([\s\S]*?)\n\}/g)].map(
      (match) => match[1],
    );
    const studioGridRule = getRuleBodies('.studio-grid')[0];

    expect(appShellRules).toHaveLength(2);
    expect(appShellRules[0]).toMatch(/padding:\s*9px;/);
    expect(appShellRules[1]).toMatch(/padding:\s*9px;/);
    expect(studioGridRule).toBeDefined();
    expect(studioGridRule).toMatch(/row-gap:\s*6px;/);
    expect(studioGridRule).toMatch(/column-gap:\s*9px;/);
  });

  it('gives the normal Timeline one viewport minus the outer inset', () => {
    const timelineRule = getRuleBodies('.timeline-panel').find((rule) =>
      rule.includes('height: clamp(640px, calc(100dvh - 18px), 1040px);'),
    );
    const normalGridRule = getRuleBodies('.studio-grid:not(.timeline-expanded)')[0];

    expect(timelineRule).toBeDefined();
    expect(timelineRule).toMatch(
      /height:\s*clamp\(640px, calc\(100dvh - 18px\), 1040px\);/,
    );
    expect(timelineRule).toMatch(
      /min-height:\s*clamp\(640px, calc\(100dvh - 18px\), 1040px\);/,
    );
    expect(timelineRule).toMatch(
      /max-height:\s*clamp\(640px, calc\(100dvh - 18px\), 1040px\);/,
    );
    expect(normalGridRule).toMatch(
      /100dvh - 18px - clamp\(640px, calc\(100dvh - 18px\), 1040px\)/,
    );
  });

  it('reassigns only the Timeline bottom inset to its flexible track workspace', () => {
    const panelRule = getRuleBodies('.panel').find((rule) =>
      rule.includes('padding: 16px;'),
    );
    const timelineRule = getRuleBodies('.timeline-panel').find((rule) =>
      rule.includes('height: clamp(640px, calc(100dvh - 18px), 1040px);'),
    );
    const workspaceRule = getRuleBodies('.timeline-workspace')[0];
    const mainRule = getRuleBodies('.timeline-main')[0];
    const inspectorRule = getRuleBodies('.clip-inspector')[0];

    expect(panelRule).toMatch(/padding:\s*16px;/);
    expect(timelineRule).toMatch(/padding-bottom:\s*8px;/);
    expect(workspaceRule).toMatch(/flex:\s*1 1 auto;/);
    expect(mainRule).toMatch(/grid-template-rows:\s*auto auto minmax\(0, 1fr\);/);
    expect(inspectorRule).toMatch(/margin-top:\s*14px;/);
    expect(inspectorRule).toMatch(/padding:\s*10px 12px;/);
  });

  it('uses one normal Top Dock height contract for MAIN, PIANO ROLL, and MIXER', () => {
    const studioGridRule = getRuleBodies('.studio-grid')[0];
    const normalDockViewportRule = getRuleBodies(
      '.studio-grid:not(.timeline-expanded) .top-dock-viewport',
    )[0];
    const mainPanelRule = styles.match(
      /(?:^|\r?\n)\.rack-panel,\r?\n\.detail-panel,\r?\n\.routing-panel\s*\{([\s\S]*?)\r?\n\}/,
    )?.[1];
    const pianoPanelRule = getRuleBodies('.piano-roll-spike.panel')[0];
    const mixerPanelRule = getRuleBodies('.mixer-effects-panel.panel')[0];
    const mixerLevelRule = getRuleBodies('.mixer-console-level-section')[0];

    expect(studioGridRule).toMatch(
      /--top-dock-content-height:\s*clamp\(484px, calc\(54dvh \+ 164px\), 754px\);/,
    );
    expect(normalDockViewportRule).toMatch(
      /height:\s*calc\(var\(--top-dock-content-height\) \+ 13px\);/,
    );
    expect(normalDockViewportRule).toMatch(/overflow-y:\s*auto;/);

    for (const panelRule of [mainPanelRule, pianoPanelRule, mixerPanelRule]) {
      expect(panelRule).toMatch(/height:\s*var\(--top-dock-content-height\);/);
      expect(panelRule).toMatch(/min-height:\s*var\(--top-dock-content-height\);/);
      expect(panelRule).toMatch(/max-height:\s*var\(--top-dock-content-height\);/);
    }

    expect(mixerPanelRule).not.toMatch(/677px/);
    expect(mixerPanelRule).toMatch(/--mixer-console-overview-min-height:\s*313px;/);
    expect(mixerPanelRule).toMatch(/--mixer-console-overview-max-height:\s*313px;/);
    expect(mixerLevelRule).toMatch(/height:\s*196px;/);
    expect(mixerLevelRule).toMatch(/min-height:\s*196px;/);
    expect(mixerLevelRule).toMatch(/max-height:\s*196px;/);
    expect(mixerLevelRule).toMatch(/align-self:\s*start;/);
  });

  it('keeps expanded Studio content inside one viewport with independent Dock scrolling', () => {
    const splitShellRule = getRuleBodies('.app-shell.timeline-workspace-split')[0];
    const expandedGridRule = getRuleBodies('.studio-grid.timeline-expanded')[0];
    const expandedDockViewportRule = getRuleBodies(
      '.studio-grid.timeline-expanded .top-dock-viewport',
    )[0];
    const expandedTimelineRule = getRuleBodies(
      '.studio-grid.timeline-expanded .timeline-panel',
    )[0];

    expect(splitShellRule).toMatch(/height:\s*100dvh;/);
    expect(splitShellRule).toMatch(/overflow:\s*hidden;/);
    expect(expandedGridRule).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\);/);
    expect(expandedGridRule).toMatch(/overflow:\s*hidden;/);
    expect(expandedDockViewportRule).toMatch(
      /height:\s*calc\(clamp\(180px, 28vh, 300px\) \+ 13px\);/,
    );
    expect(expandedDockViewportRule).toMatch(/overflow-y:\s*auto;/);
    expect(expandedTimelineRule).toMatch(/height:\s*100%;/);
    expect(expandedTimelineRule).toMatch(/min-height:\s*0;/);
    expect(expandedTimelineRule).toMatch(/max-height:\s*none;/);
  });

  it('preserves MAIN and PIANO while keeping MIXER dimensions mode-invariant', () => {
    const expandedMainRule = styles.match(
      /\.studio-grid\.timeline-expanded \.rack-panel,[\s\S]*?\.routing-panel\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    const expandedPianoRule = getRuleBodies(
      '.studio-grid.timeline-expanded .piano-roll-spike',
    )[0];
    const mixerPanelRule = getRuleBodies('.mixer-effects-panel.panel')[0];

    expect(expandedMainRule).toMatch(/height:\s*clamp\(180px, 28vh, 300px\);/);
    expect(expandedPianoRule).toMatch(/height:\s*clamp\(180px, 28vh, 300px\);/);
    expect(styles).not.toMatch(/\.studio-grid\.timeline-expanded \.mixer-effects-panel\s*\{/);
    expect(styles).not.toMatch(/\.studio-grid\.timeline-expanded \.mixer-console-level-section\s*\{/);
    expect(mixerPanelRule).toMatch(
      /grid-template-rows:\s*auto auto minmax\(0, 1fr\);/,
    );
    expect(getRuleBodies('.mixer-effect-center-column')[0]).toMatch(
      /grid-template-rows:\s*minmax\(0, 1fr\) auto;/,
    );
  });
});
