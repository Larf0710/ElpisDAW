import { describe, expect, it } from 'vitest';

import {
  AUDIO_GENERATION_REGION_TICKS_PER_BAR,
  createAudioGenerationRegionPlan,
  type AudioGenerationRegionPlan,
  type AudioGenerationRegionRequest,
} from './audioGenerationRegion';
import { applyAudioGenerationRegionPlan } from './audioGenerationRegionApplication';
import type { Clip, ProjectState, Track } from './types';

describe('Audio Generation Region Project application', () => {
  it('persists and selects one empty Region on an existing Blank Track', () => {
    const project = createProject({
      playheadTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR,
    });
    const snapshot = JSON.stringify(project);
    const plan = requirePlan(project);
    const planSnapshot = JSON.stringify(plan);
    const result = applyAudioGenerationRegionPlan(project, plan);

    expect(result).toMatchObject({
      applied: true,
      clip: {
        color: '#ff4d5d',
        createdAt: '2026-08-05T14:00:00.000Z',
        generatedBy: 'Generation Region',
        id: 'generation-region-1',
        lengthTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 8,
        name: 'SA3 T2A Region',
        startTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR,
        type: 'ai-fill-audio',
        version: 1,
      },
      project: {
        selection: {
          anchorItem: { id: 'generation-region-1', type: 'clip' },
          items: [{ id: 'generation-region-1', type: 'clip' }],
          lastSelectedItem: { id: 'generation-region-1', type: 'clip' },
        },
      },
      status: 'APPLIED',
      track: {
        id: 'track-output',
        type: 'generated_audio',
      },
    });
    expect(JSON.stringify(project)).toBe(snapshot);
    expect(JSON.stringify(plan)).toBe(planSnapshot);

    if (result.applied) {
      expect(result.project).not.toBe(project);
      expect(result.project.tracks[0]).not.toBe(project.tracks[0]);
      expect(result.clip).not.toHaveProperty('activeClipTakeId');
      expect(result.clip).not.toHaveProperty('clipTakes');
      expect(result.clip).not.toHaveProperty('sourceFile');
      expect(
        JSON.parse(JSON.stringify(result.project)).tracks[0].clips[0],
      ).toEqual(result.clip);
    }
  });

  it(
    'preserves an existing Audio Track type and unrelated Project references',
    () => {
      const unrelatedTrack = createTrack({
        id: 'track-midi',
        name: 'MIDI',
        type: 'midi',
      });
      const project = createProject({
        tracks: [createTrack({ type: 'audio' }), unrelatedTrack],
      });
      const result = applyAudioGenerationRegionPlan(
        project,
        requirePlan(project),
      );

      expect(result).toMatchObject({
        applied: true,
        track: {
          id: 'track-output',
          type: 'audio',
        },
      });

      if (result.applied) {
        expect(result.project.tracks[1]).toBe(unrelatedTrack);
        expect(result.project.patchTabs).toBe(project.patchTabs);
        expect(result.project.takes).toBe(project.takes);
      }
    },
  );

  it('adds the planned Generated Audio Track and extends by whole Bars', () => {
    const project = createProject({ bpm: 90 });
    const plan = requirePlan(
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
    const result = applyAudioGenerationRegionPlan(project, plan);

    expect(result).toMatchObject({
      applied: true,
      project: {
        totalTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 18,
      },
      track: {
        clips: [{ id: 'generation-region-1' }],
        id: 'track-sa3-t2a',
        level: -6,
        name: 'SA3 T2A',
        parentGroupId: null,
        type: 'generated_audio',
      },
    });
  });

  it('blocks a plan after its Project context or target becomes stale', () => {
    const project = createProject();
    const plan = requirePlan(project);
    const tempoChanged = { ...project, bpm: 90 };
    const targetChanged = createProject({
      tracks: [
        createTrack({
          clips: [
            createClip({
              lengthTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR,
            }),
          ],
        }),
      ],
    });

    expect(applyAudioGenerationRegionPlan(tempoChanged, plan)).toMatchObject({
      applied: false,
      cause: 'generation-region-application-plan-stale',
      project: tempoChanged,
      reason: 'project-stale',
      status: 'BLOCKED',
    });
    expect(applyAudioGenerationRegionPlan(targetChanged, plan)).toMatchObject({
      applied: false,
      cause: 'generation-region-clip-overlap',
      project: targetChanged,
      reason: 'project-stale',
    });
  });

  it('blocks repeat application and a modified plan without mutation', () => {
    const project = createProject();
    const plan = requirePlan(project);
    const first = applyAudioGenerationRegionPlan(project, plan);

    expect(first.applied).toBe(true);

    if (!first.applied) {
      return;
    }

    const appliedSnapshot = JSON.stringify(first.project);
    const modifiedPlan: AudioGenerationRegionPlan = {
      ...plan,
      durationSeconds: plan.durationSeconds + 1,
    };

    expect(
      applyAudioGenerationRegionPlan(first.project, plan),
    ).toMatchObject({
      applied: false,
      cause: 'generation-region-id-conflict',
      project: first.project,
      reason: 'project-stale',
    });
    expect(
      applyAudioGenerationRegionPlan(project, modifiedPlan),
    ).toMatchObject({
      applied: false,
      cause: 'generation-region-application-plan-stale',
      project,
      reason: 'project-stale',
    });
    expect(JSON.stringify(first.project)).toBe(appliedSnapshot);
    expect(JSON.stringify(project)).toBe(JSON.stringify(createProject()));
  });
});

function requirePlan(
  project: ProjectState,
  request: AudioGenerationRegionRequest = createRequest(),
): AudioGenerationRegionPlan {
  const result = createAudioGenerationRegionPlan(project, request);

  if (!result.canCreate) {
    throw new Error(result.message);
  }

  return result.plan;
}

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
    name: 'Generation Region Application Test',
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
