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
    expect(appSource).toContain('Choose model storage — no download starts here');
    expect(appSource).toContain('USE PORTABLE STORAGE');
    expect(appSource).toContain('CHOOSE ANOTHER FOLDER');
    expect(appSource).toContain("? 'CHANGE'");
    expect(appSource).toContain('user-installed Stable Audio 3');
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

  it('makes manual Provider installation explicit and links only to official guidance', () => {
    expect(appSource).toContain(
      'It does not download or install models or Provider runtimes.',
    );
    expect(appSource).toContain('aria-label="Manual AI Provider setup links"');
    expect(appSource).toContain(
      'https://github.com/Larf0710/ElpisDAW/blob/main/docs/ElpisDAW_LLM_User_Guide.md#install-optional-ai-providers-manually',
    );
    expect(appSource).toContain(
      'https://github.com/ace-step/ACE-Step-1.5/blob/v0.1.8/docs/en/INSTALL.md',
    );
    expect(appSource).toContain(
      'https://huggingface.co/stabilityai/stable-audio-3-medium',
    );
    expect(stylesSource).toContain('.resource-storage-setup-links');
  });
});
