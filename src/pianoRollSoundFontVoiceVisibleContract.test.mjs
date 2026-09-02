import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const controlSource = readFileSync(
  new URL('./PianoRollSoundFontControl.tsx', import.meta.url),
  'utf8',
);
const editorSource = readFileSync(
  new URL('./PianoRollInteractionSpike.tsx', import.meta.url),
  'utf8',
);
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('visible Piano Roll SoundFont voice contract', () => {
  it('threads the real preset catalog into the Piano Roll SoundFont menu', () => {
    expect(appSource).toContain(
      'onListSoundFontPresets={handleListSoundFontPresets}',
    );
    expect(editorSource).toContain(
      'onListSoundFontPresets={onListSoundFontPresets}',
    );
    expect(controlSource).toContain('useSoundFontPresetCatalog(');
  });

  it('shows the applied or preview voice name with Bank and Program', () => {
    expect(controlSource).toContain(
      'aria-label="Piano Roll SoundFont voice indicator"',
    );
    expect(controlSource).toContain('displayedPreset?.name');
    expect(controlSource).toContain('APPLIED');
    expect(controlSource).toContain('PREVIEW');
    expect(stylesSource).toContain('.piano-roll-soundfont-voice-indicator');
  });

  it('applies SoundFont selections immediately without legacy action buttons', () => {
    expect(controlSource).toContain('aria-label="Piano Roll SoundFont Sound"');
    expect(controlSource).toContain('assignVoice(');
    expect(controlSource).toContain('Use Undo to restore it.');
    expect(controlSource).not.toContain('piano-roll-soundfont-panel-actions');
    expect(controlSource).not.toContain('AUDITION');
    expect(controlSource).not.toContain('>APPLY<');
    expect(controlSource).not.toContain('>CLEAR<');
    expect(controlSource).not.toContain('>REFRESH<');
  });

  it('warms the built-in voice asynchronously and assigns it to new MIDI Clips', () => {
    expect(appSource).toContain('handlePreparePianoRollLiveNotePreview({');
    expect(appSource).toContain(
      "resource.relativePath === HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH",
    );
    expect(appSource).toContain('const defaultSoundFontAssignment =');
    expect(appSource).toContain(
      'updateMidiClipSoundFontAssignment(\n              creation.project,',
    );
  });

  it('closes the warmed Live Host before Timeline playback starts', () => {
    const playStart = appSource.indexOf("if (button === 'PLAY') {");
    const playEnd = appSource.indexOf("if (button === 'STOP'", playStart);
    const playSource = appSource.slice(playStart, playEnd);
    const stopIndex = playSource.indexOf(
      'stopPianoRollLiveNotePreview().then((didStopCleanly) =>',
    );
    const playbackIndex = playSource.indexOf('handlePlayCurrentTarget();');

    expect(stopIndex).toBeGreaterThan(-1);
    expect(playbackIndex).toBeGreaterThan(stopIndex);
    expect(playSource).toContain('didStopCleanly &&');
    expect(playSource).toContain(
      'timelineTransportRequestIdRef.current === transportRequestId',
    );
  });
});
