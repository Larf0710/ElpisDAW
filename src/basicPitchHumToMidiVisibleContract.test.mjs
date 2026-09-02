import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const controllerSource = readFileSync(
  new URL('./basicPitchHumToMidiUiController.ts', import.meta.url),
  'utf8',
);
const runnerSource = readFileSync(
  new URL('./localEngineHumToMidiGeneration.ts', import.meta.url),
  'utf8',
);
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('visible Basic Pitch Hum to MIDI contract', () => {
  it('wires the built-in Hum to MIDI PatchTab to production controller boundaries', () => {
    expect(appSource).toContain('new BasicPitchHumToMidiUiController()');
    expect(appSource).toContain('<BasicPitchHumToMidiControls');
    expect(appSource).toContain('handleRunBasicPitchHumToMidi');
    expect(appSource).toContain('handleRetryBasicPitchHumToMidi');
    expect(appSource).toContain('handleRecoverBasicPitchHumToMidi');
    expect(appSource).toContain('handleCancelBasicPitchHumToMidi');
    expect(appSource).toContain(
      'patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi',
    );
  });

  it('keeps mock planning and enqueue unreachable from the product App path', () => {
    expect(appSource).not.toContain('createMockHumToMidiGenerationPlan');
    expect(appSource).not.toContain('runLocalEngineHumToMidiGeneration');
    expect(appSource).not.toContain('enqueueMockHumToMidiJob');
    expect(controllerSource).not.toContain('enqueueMockHumToMidiJob');
    expect(runnerSource).toContain('client.enqueueBasicPitchHumToMidiJob(request)');
  });

  it('renders only the two settled controls and one accessible action surface', () => {
    expect(appSource).toContain('aria-label="Basic Pitch Hum to MIDI controls"');
    expect(appSource).toMatch(
      /function BasicPitchHumToMidiControls[\s\S]*patchTab\.parameters\.map[\s\S]*<PatchTabActionCard/,
    );
    expect(controllerSource).toContain("buttonLabel: 'CONVERT'");
    expect(controllerSource).toContain("buttonLabel: 'CANCEL'");
    expect(controllerSource).toContain("buttonLabel: 'WAIT'");
    expect(controllerSource).toContain("buttonLabel: 'RETRY'");
    expect(controllerSource).toContain("buttonLabel: 'RECOVER'");
    expect(controllerSource).toContain("title: 'Transcribe Hum Audio'");
    expect(stylesSource).toContain('.hum-to-midi-editor');
    expect(stylesSource).toContain('.hum-to-midi-parameter-fieldset:disabled');
  });

  it('routes successful settlement through edit history and keeps deletion recovery-safe', () => {
    expect(appSource).toContain("label: `Convert ${result.sourceClipName} to MIDI`");
    expect(appSource).toContain(
      "category: result.targetCreated ? 'track' : 'take'",
    );
    expect(appSource).toContain(
      'basicPitchController.state.status === \'REGISTRATION_PENDING\'',
    );
    expect(appSource).toContain('controller.acknowledgeRegistration(result.jobId)');
  });

  it('assigns the built-in default SoundFont to newly generated MIDI Clips', () => {
    expect(appSource).toContain(
      'createBuiltInDefaultSoundFontAssignment(soundFontCatalogState)',
    );
    expect(appSource).toContain('resolveDefaultSoundFontAssignment: () =>');
    expect(controllerSource).toContain(
      'request.resolveDefaultSoundFontAssignment?.()',
    );
  });

  it('requires the Engine-inspected Runtime before presenting conversion readiness', () => {
    expect(appSource).toContain('client.checkBasicPitchRuntime()');
    expect(appSource).toContain("currentRuntime.status !== 'READY'");
    expect(controllerSource).toContain("input.runtime.status === 'READY'");
    expect(controllerSource).toContain('BASIC PITCH RUNTIME UNAVAILABLE');
  });
});
