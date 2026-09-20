import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function normalizeSource(text) {
  return text.replace(/\r\n?/g, '\n');
}

const appSource = normalizeSource(
  readFileSync(new URL('./App.tsx', import.meta.url), 'utf8'),
);
const stylesSource = normalizeSource(
  readFileSync(new URL('./styles.css', import.meta.url), 'utf8'),
);

describe('visible resource storage policy', () => {
  it('offers portable-first storage with an external-folder alternative', () => {
    expect(appSource).toContain('Keep models portable or choose another folder');
    expect(appSource).toContain('USE PORTABLE STORAGE');
    expect(appSource).toContain('CHOOSE ANOTHER FOLDER');
    expect(appSource).toContain("? 'CHANGE'");
    expect(appSource).toContain('Stable Audio 3, ACE-Step, and future LoRAs');
    expect(appSource).toContain('CONTINUE CORE ONLY');
    expect(appSource).toContain('does not move existing model or LoRA files');
    expect(appSource).toContain('className="resource-storage-current-library"');
    expect(stylesSource).toMatch(
      /\.resource-storage-current-library\s*\{[^}]*overflow-wrap:\s*anywhere;/,
    );
  });

  it('presents managed resources as update-safe portable data', () => {
    expect(appSource).toContain("['SoundFonts', storage.fixedResources.soundFonts.path]");
    expect(appSource).toContain("['FluidSynth', storage.fixedResources.fluidSynthRuntime.path]");
    expect(appSource).toContain("['Basic Pitch', storage.fixedResources.basicPitchRuntime.path]");
    expect(appSource).toContain("['Default AI models', storage.portableAiModelLibraryPath]");
    expect(appSource).toContain('Portable data — kept across app updates');
    expect(appSource).toContain('outside the application manifest');
    expect(stylesSource).toContain('.resource-storage-setup-panel');
    expect(stylesSource).toContain('.resource-storage-reminder');
  });
});
