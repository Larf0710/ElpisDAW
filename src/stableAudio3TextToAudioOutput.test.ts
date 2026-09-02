import { describe, expect, it } from 'vitest';

import { AUDIO_GENERATION_REGION_TICKS_PER_BAR } from './audioGenerationRegion';
import {
  createStableAudio3TextToAudioOutputPlan,
  type StableAudio3TextToAudioOutputRequest,
} from './stableAudio3TextToAudioOutput';
import type { ProjectState, Track } from './types';

describe('Stable Audio 3 text-to-audio output contract', () => {
  it('captures the execution Playhead and reserves a new Generated Audio Track', () => {
    const project = createProject({
      playheadTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 3,
    });
    const snapshot = JSON.stringify(project);
    const result = createStableAudio3TextToAudioOutputPlan(
      project,
      createRequest({ generationPosition: 'playhead' }),
    );

    expect(result).toEqual({
      canPlan: true,
      plan: {
        generationPosition: {
          capturedPlayheadTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 3,
          choice: 'playhead',
          resolvedStartTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 3,
        },
        generationRegion: expect.objectContaining({
          output: {
            clipId: 'sa3-t2a-clip-1',
            kind: 'first-clip-take',
            trackId: 'sa3-t2a-track-1',
          },
          outputTarget: {
            kind: 'new-track',
            level: -6,
            parentGroupId: null,
            trackId: 'sa3-t2a-track-1',
            trackName: 'SA3 T2A',
            trackType: 'generated_audio',
          },
          region: expect.objectContaining({
            endTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 11,
            startTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 3,
          }),
          source: { kind: 'empty' },
        }),
        materialization: {
          kind: 'after-generation-success',
        },
      },
    });
    expect(JSON.stringify(project)).toBe(snapshot);
    expect(Object.isFrozen(result)).toBe(true);

    if (result.canPlan) {
      expect(Object.isFrozen(result.plan)).toBe(true);
      expect(Object.isFrozen(result.plan.generationPosition)).toBe(true);
      expect(Object.isFrozen(result.plan.materialization)).toBe(true);
    }
  });

  it('resolves Timeline Start to Tick 0 independently of the current Playhead', () => {
    const result = createStableAudio3TextToAudioOutputPlan(
      createProject({
        playheadTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 7,
      }),
      createRequest({ generationPosition: 'timeline-start' }),
    );

    expect(result).toMatchObject({
      canPlan: true,
      plan: {
        generationPosition: {
          capturedPlayheadTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 7,
          choice: 'timeline-start',
          resolvedStartTick: 0,
        },
        generationRegion: {
          outputTarget: {
            kind: 'new-track',
            trackType: 'generated_audio',
          },
          region: {
            startTick: 0,
          },
        },
      },
    });
  });

  it('blocks identity conflicts instead of falling back to an existing Track', () => {
    const result = createStableAudio3TextToAudioOutputPlan(
      createProject({
        tracks: [createTrack({ id: 'sa3-t2a-track-1' })],
      }),
      createRequest(),
    );

    expect(result).toEqual({
      canPlan: false,
      cause: 'generation-region-new-track-id-conflict',
      message:
        'Generation Region new Track ID sa3-t2a-track-1 already exists.',
      reason: 'target-invalid',
    });
  });

  it('rejects an unsupported runtime Generation Position', () => {
    const request = {
      ...createRequest(),
      generationPosition: 'selected-track',
    } as unknown as StableAudio3TextToAudioOutputRequest;

    expect(
      createStableAudio3TextToAudioOutputPlan(createProject(), request),
    ).toEqual({
      canPlan: false,
      cause: 'stable-audio-3-t2a-generation-position-invalid',
      message: 'SA3 T2A Generation Position must be Playhead or Timeline Start.',
      reason: 'invalid-request',
    });
  });
});

function createRequest(
  overrides: Partial<StableAudio3TextToAudioOutputRequest> = {},
): StableAudio3TextToAudioOutputRequest {
  return {
    bars: 8,
    createdAt: '2026-08-05T14:30:00.000Z',
    generationPosition: 'playhead',
    outputClipId: 'sa3-t2a-clip-1',
    outputClipName: 'SA3 T2A Clip',
    outputTrackId: 'sa3-t2a-track-1',
    outputTrackName: 'SA3 T2A',
    ...overrides,
  };
}

function createProject(
  overrides: Partial<ProjectState> & { tracks?: Track[] } = {},
): ProjectState {
  return {
    artifacts: [],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'SA3 T2A Output Test',
    patchTabs: [],
    playheadTick: 0,
    recordingSettings: {
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: '',
    selection: { items: [] },
    status: 'READY',
    tabFlowLines: [],
    tabFlowStageResults: [],
    takes: [],
    totalTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 16,
    tracks: [],
    ...overrides,
  };
}

function createTrack(overrides: Partial<Track> = {}): Track {
  return {
    clips: [],
    id: 'existing-track',
    level: 0,
    name: 'Existing Track',
    type: 'audio',
    ...overrides,
  };
}
