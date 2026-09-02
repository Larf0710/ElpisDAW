import { describe, expect, it } from 'vitest';

import {
  createIdleAutoPatchProductionUiState,
  createPreparingAutoPatchProductionUiState,
} from './autoPatchProductionUiState';
import { createStableAudio3AudioToAudioUiPresentation } from './stableAudio3AudioToAudioUi';

describe('Stable Audio 3 A2A UI presentation', () => {
  it('offers a truthful SA3 Master action for a ready Raw Mixdown', () => {
    expect(
      createStableAudio3AudioToAudioUiPresentation({
        autoPatchState: createIdleAutoPatchProductionUiState(),
        engineAcceptsNewJobs: true,
        engineAvailabilityMessage: 'Engine ready.',
        isProjectRootReady: true,
        source: { name: 'Raw Mix 03', type: 'mixdown' },
      }),
    ).toEqual({
      buttonLabel: 'RUN A2A',
      canRun: true,
      detail: 'Raw Mix 03 / NEW MUTED MASTER TRACK',
      eyebrow: 'Stable Audio 3 A2A',
      title: 'Create SA3 Master',
    });
  });

  it('supports Instrument Audio without calling it a Master operation', () => {
    expect(
      createStableAudio3AudioToAudioUiPresentation({
        autoPatchState: createIdleAutoPatchProductionUiState(),
        engineAcceptsNewJobs: true,
        engineAvailabilityMessage: 'Engine ready.',
        isProjectRootReady: true,
        source: { name: 'Piano Render', type: 'instrument-audio' },
      }),
    ).toMatchObject({
      canRun: true,
      detail: 'Piano Render',
      title: 'Transform Selected Audio',
    });
  });

  it('blocks unsupported sources, missing Project Root, Engine lock, and active production honestly', () => {
    const idle = createIdleAutoPatchProductionUiState();

    expect(
      createStableAudio3AudioToAudioUiPresentation({
        autoPatchState: idle,
        engineAcceptsNewJobs: true,
        engineAvailabilityMessage: 'Engine ready.',
        isProjectRootReady: true,
        source: { name: 'Master 01', type: 'master' },
      }),
    ).toMatchObject({
      canRun: false,
      detail: 'SELECT RAW MIX OR INSTRUMENT AUDIO',
    });
    expect(
      createStableAudio3AudioToAudioUiPresentation({
        autoPatchState: idle,
        engineAcceptsNewJobs: true,
        engineAvailabilityMessage: 'Engine ready.',
        isProjectRootReady: false,
        source: { name: 'Raw Mix 01', type: 'mixdown' },
      }),
    ).toMatchObject({ canRun: false, detail: 'SELECT PROJECT ROOT' });
    expect(
      createStableAudio3AudioToAudioUiPresentation({
        autoPatchState: idle,
        engineAcceptsNewJobs: false,
        engineAvailabilityMessage: 'Engine busy.',
        isProjectRootReady: true,
        source: { name: 'Raw Mix 01', type: 'mixdown' },
      }),
    ).toMatchObject({ canRun: false, detail: 'Engine busy.' });

    const preparing = createPreparingAutoPatchProductionUiState(
      'Checking exact source identity.',
    );
    expect(
      createStableAudio3AudioToAudioUiPresentation({
        autoPatchState: preparing,
        engineAcceptsNewJobs: true,
        engineAvailabilityMessage: 'Engine ready.',
        isProjectRootReady: true,
        source: { name: 'Raw Mix 01', type: 'mixdown' },
      }),
    ).toMatchObject({
      canRun: false,
      detail: 'Checking exact source identity.',
    });
  });
});
