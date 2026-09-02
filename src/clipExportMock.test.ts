import { describe, expect, it } from 'vitest';

import { sampleProject } from './sampleProject';
import type { PatchTab } from './types';
import { createDummyClipExport } from './workflow';

describe('selected Clip export mock', () => {
  it('creates a standalone mock export from only the selected Clip duration', () => {
    const sourceClip = sampleProject.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === 'clip-inst-1');
    const clipFiler: PatchTab = {
      id: 'historical-clip-filer',
      name: 'Clip Filer',
      colorIndex: 4,
      inputType: 'Selected Clip',
      outputType: 'Export File',
      status: 'ready',
      description: 'Historical selected Clip export settings.',
      parameters: [],
    };

    expect(sourceClip).toBeDefined();

    const result = createDummyClipExport(sampleProject, sourceClip!, clipFiler);

    expect(result.clip).toEqual(
      expect.objectContaining({
        type: 'mixdown',
        startTick: 0,
        lengthTicks: sourceClip!.lengthTicks,
        sourceClipId: sourceClip!.id,
        generatedBy: 'Clip Filer',
      }),
    );
    expect(result.clip.exportManifest).toEqual(
      expect.objectContaining({
        sourceClipId: sourceClip!.id,
        durationTicks: sourceClip!.lengthTicks,
        estimatedFileName: expect.stringContaining('-export-'),
        status: 'mock-ready',
      }),
    );
  });
});
