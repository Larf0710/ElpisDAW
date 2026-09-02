import { describe, expect, it } from 'vitest';

import {
  AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS,
  AUDIO_GENERATION_REGION_TICKS_PER_BAR,
  createAudioGenerationRegionPlan,
  type AudioGenerationRegionRequest,
} from './audioGenerationRegion';
import type { Clip, ProjectState, Track } from './types';

describe('Audio Generation Region contract', () => {
  it('plans an empty playhead Region on one existing Blank Track', () => {
    const project = createProject({
      playheadTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR,
    });
    const result = createAudioGenerationRegionPlan(project, createRequest());

    expect(result).toEqual({
      canCreate: true,
      plan: {
        createdAt: '2026-08-05T14:00:00.000Z',
        durationSeconds: 16,
        output: {
          clipId: 'generation-region-1',
          kind: 'first-clip-take',
          trackId: 'track-output',
        },
        outputTarget: {
          currentTrackType: 'blank',
          kind: 'existing-track',
          trackId: 'track-output',
          trackName: 'Generated Audio',
          trackType: 'generated_audio',
        },
        projectContext: {
          beatsPerBar: 4,
          bpm: 120,
          key: 'C',
          ticksPerBeat: 960,
        },
        region: {
          bars: 8,
          clipType: 'ai-fill-audio',
          endTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 9,
          lengthTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 8,
          name: 'SA3 T2A Region',
          regionId: 'generation-region-1',
          startTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR,
        },
        selection: {
          clipId: 'generation-region-1',
          kind: 'clip',
        },
        source: { kind: 'empty' },
        timeline: {
          extendsTimeline: false,
          requiredTotalTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 16,
        },
      },
    });
    expect(Object.isFrozen(result)).toBe(true);

    if (result.canCreate) {
      expect(Object.isFrozen(result.plan)).toBe(true);
      expect(Object.isFrozen(result.plan.outputTarget)).toBe(true);
      expect(Object.isFrozen(result.plan.region)).toBe(true);
    }
  });

  it('plans a reserved Generated Audio Track and whole-Bar Timeline extension', () => {
    const project = createProject({ bpm: 90 });
    const result = createAudioGenerationRegionPlan(
      project,
      createRequest({
        bars: 2,
        outputTarget: {
          kind: 'new-track',
          trackId: 'track-sa3-t2a',
          trackName: 'SA3 T2A',
        },
        placement: {
          kind: 'timeline',
          startTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 15 + 960,
        },
      }),
    );

    expect(result).toMatchObject({
      canCreate: true,
      plan: {
        durationSeconds: 16 / 3,
        outputTarget: {
          kind: 'new-track',
          level: -6,
          parentGroupId: null,
          trackId: 'track-sa3-t2a',
          trackName: 'SA3 T2A',
          trackType: 'generated_audio',
        },
        region: {
          endTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 17 + 960,
          startTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 15 + 960,
        },
        timeline: {
          extendsTimeline: true,
          requiredTotalTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 18,
        },
      },
    });
  });

  it('keeps Bar length in Ticks while current Tempo determines exact seconds', () => {
    const slow = createAudioGenerationRegionPlan(
      createProject({ bpm: 60 }),
      createRequest({ bars: 4 }),
    );
    const fast = createAudioGenerationRegionPlan(
      createProject({ bpm: 120 }),
      createRequest({ bars: 4 }),
    );

    expect(slow).toMatchObject({
      canCreate: true,
      plan: {
        durationSeconds: 16,
        region: { lengthTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 4 },
      },
    });
    expect(fast).toMatchObject({
      canCreate: true,
      plan: {
        durationSeconds: 8,
        region: { lengthTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 4 },
      },
    });
  });

  it('rejects overlap without mutating the Project', () => {
    const blockingClip = createClip({
      lengthTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 2,
      startTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR,
    });
    const project = createProject({
      playheadTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR,
      tracks: [createTrack({ clips: [blockingClip], type: 'audio' })],
    });
    const snapshot = JSON.stringify(project);

    expect(
      createAudioGenerationRegionPlan(project, createRequest()),
    ).toMatchObject({
      canCreate: false,
      cause: 'generation-region-clip-overlap',
      reason: 'clip-overlap',
    });
    expect(JSON.stringify(project)).toBe(snapshot);
  });

  it('rejects unsupported, missing, ambiguous, and conflicting Track targets', () => {
    expect(
      createAudioGenerationRegionPlan(
        createProject({ tracks: [createTrack({ type: 'midi' })] }),
        createRequest(),
      ),
    ).toMatchObject({
      canCreate: false,
      cause: 'generation-region-track-type-unsupported',
      reason: 'target-invalid',
    });
    expect(
      createAudioGenerationRegionPlan(
        createProject(),
        createRequest({
          outputTarget: { kind: 'existing-track', trackId: 'track-missing' },
        }),
      ),
    ).toMatchObject({
      canCreate: false,
      cause: 'generation-region-track-unavailable',
    });
    expect(
      createAudioGenerationRegionPlan(
        createProject({
          tracks: [createTrack(), createTrack({ name: 'Duplicate Track' })],
        }),
        createRequest(),
      ),
    ).toMatchObject({
      canCreate: false,
      cause: 'generation-region-track-unavailable',
    });
    expect(
      createAudioGenerationRegionPlan(
        createProject(),
        createRequest({
          outputTarget: {
            kind: 'new-track',
            trackId: 'track-output',
            trackName: 'SA3 T2A',
          },
        }),
      ),
    ).toMatchObject({
      canCreate: false,
      cause: 'generation-region-new-track-id-conflict',
    });
  });

  it('rejects duplicate Region identity and invalid request or Project values', () => {
    expect(
      createAudioGenerationRegionPlan(
        createProject({
          tracks: [
            createTrack({
              clips: [createClip({ id: 'generation-region-1' })],
            }),
          ],
        }),
        createRequest(),
      ),
    ).toMatchObject({
      canCreate: false,
      cause: 'generation-region-id-conflict',
      reason: 'region-conflict',
    });
    expect(
      createAudioGenerationRegionPlan(
        createProject(),
        createRequest({ bars: 0 }),
      ),
    ).toMatchObject({
      canCreate: false,
      cause: 'generation-region-request-invalid',
      reason: 'invalid-request',
    });
    expect(
      createAudioGenerationRegionPlan(
        createProject({ bpm: 0 }),
        createRequest(),
      ),
    ).toMatchObject({
      canCreate: false,
      cause: 'generation-region-project-invalid',
      reason: 'project-invalid',
    });
    expect(
      createAudioGenerationRegionPlan(
        createProject(),
        createRequest({
          placement: { kind: 'timeline', startTick: 61_441 },
        }),
      ),
    ).toMatchObject({
      canCreate: false,
      cause: 'generation-region-placement-invalid',
      reason: 'invalid-request',
    });
    expect(
      createAudioGenerationRegionPlan(
        createProject({
          playheadTick: AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS,
          totalTicks: AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS,
        }),
        createRequest({ bars: 1 }),
      ),
    ).toMatchObject({
      canCreate: false,
      cause: 'generation-region-timeline-overflow',
      reason: 'timeline-overflow',
    });
  });
});

function createRequest(
  overrides: Partial<AudioGenerationRegionRequest> = {},
): AudioGenerationRegionRequest {
  return {
    bars: 8,
    createdAt: '2026-08-05T14:00:00.000Z',
    outputTarget: { kind: 'existing-track', trackId: 'track-output' },
    placement: { kind: 'playhead' },
    regionId: 'generation-region-1',
    regionName: 'SA3 T2A Region',
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
    name: 'Generation Region Test',
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
    tracks: [createTrack()],
    ...overrides,
  };
}

function createTrack(overrides: Partial<Track> = {}): Track {
  return {
    clips: [],
    id: 'track-output',
    level: 0,
    name: 'Generated Audio',
    type: 'blank',
    ...overrides,
  };
}

function createClip(overrides: Partial<Clip> = {}): Clip {
  return {
    color: '#ff4d5d',
    createdAt: '2026-08-05T13:00:00.000Z',
    id: 'existing-clip',
    lengthTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR,
    name: 'Existing Clip',
    startTick: 0,
    type: 'ai-fill-audio',
    version: 1,
    ...overrides,
  };
}
