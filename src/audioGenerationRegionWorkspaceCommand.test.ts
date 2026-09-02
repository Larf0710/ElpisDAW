import { describe, expect, it } from 'vitest';

import {
  AUDIO_GENERATION_REGION_TICKS_PER_BAR,
  createAudioGenerationRegionPlan,
  type AudioGenerationRegionPlan,
  type AudioGenerationRegionRequest,
} from './audioGenerationRegion';
import {
  executeAudioGenerationRegionWorkspaceCommand,
  type AudioGenerationRegionWorkspaceCommandRequest,
} from './audioGenerationRegionWorkspaceCommand';
import {
  createSessionEditHistory,
  redoSessionEdit,
  undoSessionEdit,
  type SessionEditHistory,
} from './sessionEditHistory';
import type { ProjectState, Track } from './types';

type TestWorkspace = {
  project: ProjectState;
  selectedClipId: string;
  sentinel: string;
};

describe('Audio Generation Region Workspace command', () => {
  it('commits one selected Region as an undoable Clip edit', () => {
    const project = createProject();
    const history = createHistory(project);
    const plan = requirePlan(project);
    const result = executeAudioGenerationRegionWorkspaceCommand(
      history,
      plan,
      createCommandRequest(),
    );

    expect(result).toMatchObject({
      clip: { id: 'generation-region-1' },
      edit: {
        category: 'clip',
        createdAt: '2026-08-05T14:00:01.000Z',
        id: 'edit-generation-region-1',
        label: 'Create SA3 T2A Region',
      },
      executed: true,
      history: {
        future: [],
        past: [{ edit: { id: 'edit-initial' } }],
        present: {
          edit: { id: 'edit-generation-region-1' },
          value: {
            selectedClipId: 'generation-region-1',
            sentinel: 'preserved',
          },
        },
      },
      status: 'EXECUTED',
      track: { id: 'track-output', type: 'generated_audio' },
      workspace: {
        project: {
          selection: {
            items: [{ id: 'generation-region-1', type: 'clip' }],
          },
        },
        selectedClipId: 'generation-region-1',
        sentinel: 'preserved',
      },
    });
    expect(history.present.value.project).toBe(project);
    expect(history.future).toHaveLength(0);
    expect(history.past).toHaveLength(0);

    if (result.executed) {
      expect(result.history.present.value).toBe(result.workspace);
      expect(result.history.past[0]).toBe(history.present);
    }
  });

  it('restores the exact Workspace through Undo and Redo', () => {
    const project = createProject();
    const history = createHistory(project);
    const result = executeAudioGenerationRegionWorkspaceCommand(
      history,
      requirePlan(project),
      createCommandRequest(),
    );

    if (!result.executed) {
      throw new Error(result.message);
    }

    const undone = undoSessionEdit(result.history);

    expect(undone.status).toBe('MOVED');
    expect(undone.history.present.value).toBe(history.present.value);
    expect(undone.history.present.value.selectedClipId).toBe('');
    expect(
      undone.history.present.value.project.tracks[0].clips,
    ).toHaveLength(0);

    const redone = redoSessionEdit(undone.history, 80);

    expect(redone.status).toBe('MOVED');
    expect(redone.history.present.value).toBe(result.workspace);
    expect(redone.history.present.value.selectedClipId).toBe(
      'generation-region-1',
    );
    expect(redone.history.present.value.project.tracks[0].clips).toHaveLength(
      1,
    );
  });

  it('blocks a stale current Workspace without adding an Edit frame', () => {
    const project = createProject();
    const plan = requirePlan(project);
    const staleHistory = createHistory({ ...project, bpm: 90 });
    const result = executeAudioGenerationRegionWorkspaceCommand(
      staleHistory,
      plan,
      createCommandRequest(),
    );

    expect(result).toMatchObject({
      cause: 'generation-region-application-plan-stale',
      executed: false,
      history: staleHistory,
      reason: 'project-stale',
      status: 'BLOCKED',
      workspace: staleHistory.present.value,
    });
    expect(result.history).toBe(staleHistory);
  });

  it('blocks invalid or duplicate Edit metadata without applying the plan', () => {
    const project = createProject();
    const history = createHistory(project);
    const plan = requirePlan(project);
    const requests: Array<
      readonly [Partial<AudioGenerationRegionWorkspaceCommandRequest>, string]
    > = [
      [
        { createdAt: '' },
        'generation-region-command-timestamp-invalid',
      ],
      [
        { editId: 'edit-initial' },
        'generation-region-command-edit-id-conflict',
      ],
      [
        { historyLimit: 0 },
        'generation-region-command-history-limit-invalid',
      ],
    ];

    for (const [overrides, cause] of requests) {
      const result = executeAudioGenerationRegionWorkspaceCommand(
        history,
        plan,
        createCommandRequest(overrides),
      );

      expect(result).toMatchObject({
        cause,
        executed: false,
        history,
        reason: 'command-invalid',
        status: 'BLOCKED',
        workspace: history.present.value,
      });
      expect(result.history).toBe(history);
    }

    expect(project.tracks[0].clips).toHaveLength(0);
  });
});

function createHistory(
  project: ProjectState,
): SessionEditHistory<TestWorkspace> {
  return createSessionEditHistory(
    {
      project,
      selectedClipId: '',
      sentinel: 'preserved',
    },
    {
      category: 'system',
      createdAt: '2026-08-05T13:59:59.000Z',
      id: 'edit-initial',
      label: 'Initial Workspace',
    },
  );
}

function createCommandRequest(
  overrides: Partial<AudioGenerationRegionWorkspaceCommandRequest> = {},
): AudioGenerationRegionWorkspaceCommandRequest {
  return {
    createdAt: '2026-08-05T14:00:01.000Z',
    editId: 'edit-generation-region-1',
    historyLimit: 80,
    ...overrides,
  };
}

function requirePlan(
  project: ProjectState,
  request: AudioGenerationRegionRequest = createRegionRequest(),
): AudioGenerationRegionPlan {
  const result = createAudioGenerationRegionPlan(project, request);

  if (!result.canCreate) {
    throw new Error(result.message);
  }

  return result.plan;
}

function createRegionRequest(): AudioGenerationRegionRequest {
  return {
    bars: 8,
    createdAt: '2026-08-05T14:00:00.000Z',
    outputTarget: { kind: 'existing-track', trackId: 'track-output' },
    placement: { kind: 'playhead' },
    regionId: 'generation-region-1',
    regionName: 'SA3 T2A Region',
  };
}

function createProject(): ProjectState {
  return {
    artifacts: [],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'Generation Region Workspace Command Test',
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
  };
}

function createTrack(): Track {
  return {
    clips: [],
    id: 'track-output',
    level: 0,
    name: 'Generated Audio',
    type: 'blank',
  };
}
