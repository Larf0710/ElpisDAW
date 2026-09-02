import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const appSource = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');
const orchestrationSource = await readFile(
  new URL('./oneShotGeneration.ts', import.meta.url),
  'utf8',
);
const aceStageSource = await readFile(
  new URL('./aceStepVocalStage.ts', import.meta.url),
  'utf8',
);
const presetSource = await readFile(new URL('./presets.ts', import.meta.url), 'utf8');

describe('ONE SHOT GENERATION visible contract', () => {
  it('presents Prompt and Lyrics as the source-free production prerequisite', () => {
    expect(presetSource).toContain("name: 'ONE SHOT GENERATION'");
    expect(presetSource).toContain(
      'Write a backing Prompt and Lyrics, then Production Auto Patch runs SA3 T2A and ACE VOCALS once',
    );
    expect(presetSource).not.toContain(
      'select a prepared MIDI Clip with an assigned Project SoundFont',
    );
  });

  it('delegates the exact family before Timeline target selection', () => {
    const familyResolutionIndex = appSource.indexOf(
      'const oneShotFamily = resolveOneShotGenerationFamily',
    );
    const familyRunIndex = appSource.indexOf(
      'await runOneShotGenerationFromWorkspace(client, currentWorkspace)',
    );
    const timelineTargetIndex = appSource.indexOf(
      'const targetResolution = resolveAutoPatchTargetClipIds',
      familyRunIndex,
    );

    expect(familyResolutionIndex).toBeGreaterThan(-1);
    expect(familyRunIndex).toBeGreaterThan(familyResolutionIndex);
    expect(timelineTargetIndex).toBeGreaterThan(familyRunIndex);
    expect(appSource).toContain(
      "'Run ONE SHOT GENERATION from Prompt and Lyrics.'",
    );
    expect(appSource).toContain(
      "'Run ONE SHOT GENERATION from Prompt and Lyrics'",
    );
  });

  it('uses one existing Auto Patch action and does not add mix or export authority', () => {
    expect(appSource).toContain('runOneShotGeneration(client, initialProject');
    expect(appSource).toContain("label: 'Run ONE SHOT GENERATION'");
    expect(orchestrationSource).toContain('runStableAudio3TextToAudioPlan');
    expect(orchestrationSource).toContain('runAceStepTextToAudioVocalStage');
    expect(orchestrationSource).not.toMatch(
      /runProjectMixdownRequest|runPrintMix|StemPrint|FinalFiler|TimelineExport/,
    );
  });

  it('uses the standalone production ACE monitoring policy for ONE SHOT', () => {
    expect(aceStageSource).toContain(
      'export const ACE_STEP_PRODUCTION_MONITORING_POLICY',
    );
    expect(aceStageSource).toContain('maxPollAttempts: 3_600');
    expect(aceStageSource).toContain('pollIntervalMs: 500');
    expect(appSource).toContain('ace: ACE_STEP_PRODUCTION_MONITORING_POLICY');
    expect(appSource).toContain('...ACE_STEP_PRODUCTION_MONITORING_POLICY');
    expect(appSource).not.toContain('maxPollAttempts: 3_600');
    expect(appSource).not.toContain('pollIntervalMs: 500');
  });
});
