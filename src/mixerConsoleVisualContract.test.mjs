import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const mixerStyles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const mixerSource = readFileSync(
  new URL('./MixerEffectsEditor.tsx', import.meta.url),
  'utf8',
);
const soundFontMenuSource = readFileSync(
  new URL('./MixerSoundFontMenu.tsx', import.meta.url),
  'utf8',
);

describe('Mixer Console visual proportion contract', () => {
  it('keeps fixed console and Volume indicator heights with compact effect targets', () => {
    const consoleMinHeight = readCssPixelToken(
      '--mixer-console-overview-min-height',
    );
    const consoleMaxHeight = readCssPixelToken(
      '--mixer-console-overview-max-height',
    );
    const meterIndicatorMinHeight = readCssPixelToken(
      '--mixer-console-meter-indicator-min-height',
    );
    const effectActionMinHeight = readCssPixelToken(
      '--mixer-effect-action-min-height',
    );

    const levelRule = readCssRule('.mixer-console-level-section');

    expect(consoleMinHeight).toBe(313);
    expect(consoleMaxHeight).toBe(313);
    expect(meterIndicatorMinHeight).toBeGreaterThanOrEqual(58);
    expect(meterIndicatorMinHeight).toBeLessThanOrEqual(68);
    expect(effectActionMinHeight).toBeGreaterThanOrEqual(32);
    expect(levelRule).toMatch(/height:\s*196px;/);
    expect(levelRule).toMatch(/min-height:\s*196px;/);
    expect(levelRule).toMatch(/max-height:\s*196px;/);
  });

  it('assigns explicit Channel and Master rows without optional-content auto-placement', () => {
    const stripRule = readCssRule('.mixer-console-strip');
    const channelRule = readCssRule('.mixer-console-channel .mixer-console-strip-select');
    const groupedChannelRule = readCssRule('.mixer-console-channel.has-group-path .mixer-console-strip-select');
    const masterRule = readCssRule('.mixer-console-master .mixer-console-strip-select');
    const masterDockRule = readCssRule('.mixer-console-master-dock');
    const levelRule = readCssRule('.mixer-console-level-section');
    const channelBankRule = readCssRule('.mixer-console-channel-bank');

    expect(channelRule).toMatch(/grid-template-areas:[\s\S]*"order"[\s\S]*"name"[\s\S]*"routing"[\s\S]*"level"[\s\S]*"controls"[\s\S]*"inserts"/);
    expect(groupedChannelRule).toMatch(/grid-template-areas:[\s\S]*"order"[\s\S]*"group"[\s\S]*"name"[\s\S]*"routing"[\s\S]*"level"[\s\S]*"controls"[\s\S]*"inserts"/);
    expect(masterRule).toMatch(/grid-template-areas:[\s\S]*"order"[\s\S]*"name"[\s\S]*"\."[\s\S]*"level"[\s\S]*"master-label"[\s\S]*"inserts"/);
    expect(masterRule).toMatch(/grid-template-rows:\s*auto auto 8px minmax\(72px, 1fr\) auto auto;/);
    expect(stripRule).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\);/);
    expect(stripRule).toMatch(/height:\s*100%;/);
    expect(masterDockRule).not.toMatch(/grid-template-rows:/);
    expect(masterDockRule).toMatch(/padding:\s*5px 0 5px 7px;/);
    expect(levelRule).toMatch(/grid-area:\s*level;/);
    expect(levelRule).toMatch(/align-self:\s*start;/);
    expect(channelBankRule).toMatch(/height:\s*100%;/);
    expect(channelBankRule).toMatch(/min-height:\s*0;/);
  });

  it('removes the redundant selected-target header and keeps compact meter status styling', () => {
    expect(mixerStyles).not.toContain('.mixer-effects-header');
    expect(mixerStyles).not.toContain('.mixer-effects-lcd');
    expect(mixerStyles).toMatch(/\.mixer-meter-block-header\s*\{/);
    expect(mixerStyles).toMatch(/\.mixer-meter-effects-status\s*\{/);
  });

  it('keeps the compact SoundFont row left of the full-height Mixer utility column', () => {
    const editablePanelRule = readCssRule('.mixer-effects-panel.has-editable-strip');
    const soundFontRule = readCssRule('.mixer-soundfont-menu');
    const soundFontLabelRule = readCssRule('.mixer-soundfont-controls label');
    const workspaceRule = readCssRule('.mixer-effects-workspace');
    const workspaceSoundFontRule = readCssRule('.mixer-effects-workspace > .mixer-soundfont-menu');
    const workspaceMeterRule = readCssRule('.mixer-effects-workspace > .mixer-meter-block');

    expect(editablePanelRule).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\);/);
    expect(soundFontRule).toMatch(
      /grid-template-columns:\s*110px minmax\(420px, 1fr\) minmax\(170px, 0\.34fr\);/,
    );
    expect(soundFontRule).toMatch(/padding:\s*4px 5px;/);
    expect(soundFontLabelRule).toMatch(/grid-template-rows:\s*auto 25px;/);
    expect(workspaceRule).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\);/);
    expect(workspaceSoundFontRule).toMatch(/grid-column:\s*1 \/ 3;/);
    expect(workspaceSoundFontRule).toMatch(/grid-row:\s*1;/);
    expect(workspaceMeterRule).toMatch(/grid-column:\s*3;/);
    expect(workspaceMeterRule).toMatch(/grid-row:\s*1 \/ 3;/);
    expect(mixerStyles).not.toContain('.mixer-soundfont-actions');
    expect(soundFontMenuSource).toContain('AUTO APPLY');
    expect(soundFontMenuSource).not.toContain('APPLY TO MIDI TO AUDIO');
    expect(soundFontMenuSource).not.toContain('AUDITION');
    expect(soundFontMenuSource).not.toContain('CLEAR');
    expect(soundFontMenuSource).not.toContain('REFRESH');

    const workspaceStart = mixerSource.indexOf('<div className="mixer-effects-workspace">');
    const soundFontMenu = mixerSource.indexOf('<MixerSoundFontMenu', workspaceStart);
    const insertRack = mixerSource.indexOf('className="mixer-insert-rack"', workspaceStart);

    expect(workspaceStart).toBeGreaterThan(-1);
    expect(soundFontMenu).toBeGreaterThan(workspaceStart);
    expect(soundFontMenu).toBeLessThan(insertRack);
  });

  it('keeps the Master utility first and scopes the lower footer and Mixdown band to their columns', () => {
    const overviewRule = readCssRule('.mixer-console-overview');
    const centerColumnRule = readCssRule('.mixer-effect-center-column');
    const mixdownBandRule = readCssRule('.mixer-project-mixdown-band');
    const stemBandRule = readCssRule('.mixer-project-stem-print-band');
    const stemTargetsRule = readCssRule('.mixer-project-stem-targets');
    const meterBlockRule = readLastCssRule('.mixer-meter-block');

    expect(overviewRule).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\);/);
    expect(overviewRule).toMatch(/gap:\s*0;/);
    expect(centerColumnRule).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\) auto;/);
    expect(mixdownBandRule).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(mixdownBandRule).toMatch(/width:\s*100%;/);
    expect(stemBandRule).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(stemTargetsRule).toMatch(/overflow-x:\s*auto;/);
    expect(meterBlockRule).toMatch(/grid-template-rows:\s*auto auto auto minmax\(0, 1fr\);/);

    const stripStart = mixerSource.indexOf('function MixerConsoleStrip');
    const peakHold = mixerSource.indexOf('<MixerMasterPeakHoldControls', stripStart);
    const stripSelector = mixerSource.indexOf('className="mixer-console-strip-select"', stripStart);
    const mixdownBlock = mixerSource.indexOf('function MixerEffectsMeterBlock');
    const mixdownBand = mixerSource.indexOf('<MixerProjectMixdownBand', mixdownBlock);
    const stemPrint = mixerSource.indexOf('<MixerProjectStemPrintControls', mixdownBlock);
    const exactPeak = mixerSource.indexOf('EXACT PEAK', mixdownBlock);

    expect(peakHold).toBeGreaterThan(stripStart);
    expect(peakHold).toBeLessThan(stripSelector);
    expect(mixdownBand).toBeGreaterThan(mixdownBlock);
    expect(mixdownBand).toBeLessThan(exactPeak);
    expect(stemPrint).toBeGreaterThan(mixdownBand);
    expect(stemPrint).toBeLessThan(exactPeak);
  });
});

function readCssPixelToken(name) {
  const match = mixerStyles.match(new RegExp(`${name}:\\s*(\\d+)px`));
  if (!match) {
    throw new Error(`Missing Mixer CSS sizing token ${name}.`);
  }

  return Number(match[1]);
}

function readCssRule(selector) {
  return readCssRules(selector)[0];
}

function readLastCssRule(selector) {
  return readCssRules(selector).at(-1);
}

function readCssRules(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = Array.from(
    mixerStyles.matchAll(
      new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`, 'g'),
    ),
  );

  if (matches.length === 0) {
    throw new Error(`Missing Mixer CSS rule ${selector}.`);
  }

  return matches.map((match) => match[1]);
}
