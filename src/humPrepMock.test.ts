import { describe, expect, it } from 'vitest';

import { tabFlowPresets } from './presets';
import { sampleProject } from './sampleProject';
import type { PatchTab } from './types';
import { createRecordingSession, isHumPrepPatchTab } from './workflow';

describe('historical Hum Prep mock compatibility', () => {
  it('keeps historical Hum Prep distinguishable without publishing it in the fresh project', () => {
    const historicalHumPrep = createHistoricalHumPrep();

    expect(isHumPrepPatchTab(historicalHumPrep)).toBe(true);
    expect(sampleProject.patchTabs.some(isHumPrepPatchTab)).toBe(false);
    expect(sampleProject.patchTabs.some((patchTab) => patchTab.inputType === 'Microphone')).toBe(false);
  });

  it('keeps bundled Basic Pitch presets free of the retired mock-only node', () => {
    const humPresetProjects = tabFlowPresets
      .filter((preset) => preset.project.patchTabs.some((patchTab) => patchTab.outputType === 'MIDI Notes'))
      .map((preset) => preset.project);

    expect(humPresetProjects).toHaveLength(2);
    expect(humPresetProjects.every((project) => !project.patchTabs.some(isHumPrepPatchTab))).toBe(true);
  });

  it('keeps recording sessions independent from PatchTabs', () => {
    expect(createRecordingSession(sampleProject)).not.toHaveProperty('sourcePatchTabId');
  });
});

function createHistoricalHumPrep(): PatchTab {
  return {
    id: 'historical-hum-prep',
    name: 'Hum Prep',
    colorIndex: 0,
    inputType: 'Hum Audio',
    outputType: 'Hum Audio',
    status: 'idle',
    description: 'Historical mock-only Hum Prep.',
    parameters: [],
  };
}
