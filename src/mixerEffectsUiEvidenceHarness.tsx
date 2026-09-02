import { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';

import {
  accumulateMixerSamplePeakBlock,
  createMixerSamplePeakAccumulator,
} from '../shared/mixerMeterContract.js';
import { createMixerMeterTapSummary } from '../shared/mixerMeterTapContract.js';
import { MixerEffectsEditor } from './MixerEffectsEditor';
import { createMixerProjectMixdownControlModel } from './projectMixdownUiState';
import {
  listProjectStemPrintTargetOptions,
  resolveProjectStemPrintSelection,
  toggleProjectStemPrintTarget,
} from './projectStemPrintSelection';
import type { ProjectStemPrintTarget } from './projectStemPrintPlan';
import { createMixerProjectStemPrintControlModel } from './projectStemPrintUiState';
import type { MixerEffectsEditorCommandOutcome } from './MixerEffectsEditor';
import {
  executeProjectMixerEffectCommand,
  type ProjectMixerEffectCommand,
} from './projectMixerEffectsCommand';
import {
  normalizeProjectMixerState,
  toggleProjectMixerChannelMute,
} from './projectMixerState';
import { createProjectPlaybackMeterStore } from './projectPlaybackMeterStore';
import { sampleProject } from './sampleProject';
import {
  createSessionEditHistory,
  redoSessionEdit,
  undoSessionEdit,
  updateSessionEditPresent,
  type SessionEditHistory,
} from './sessionEditHistory';
import type { ProjectState, Track } from './types';
import './styles.css';
import './mixerEffectsUiEvidenceHarness.css';

type HarnessWorkspace = Readonly<{ project: ProjectState }>;
type HarnessTarget = 'channel' | 'empty' | 'group' | 'master';
type HarnessRoutingScenario = 'normal' | 'muted' | 'offline' | 'solo';

const groupTrack: Track = {
  clips: [],
  group: {
    activePlaybackTrackId: 'hum-audio',
    childTrackIds: ['hum-audio'],
    collapsed: false,
    playbackMode: 'bottom_child',
  },
  id: 'ui-evidence-group',
  level: -8,
  name: 'Vocal Group',
  type: 'group',
};

function MixerEffectsUiEvidenceHarness() {
  const [history, setHistory] = useState(() => createHarnessHistory());
  const historyRef = useRef(history);
  historyRef.current = history;
  const [target, setTarget] = useState<HarnessTarget>('channel');
  const [routingScenario, setRoutingScenario] = useState<HarnessRoutingScenario>('normal');
  const [meterActive, setMeterActive] = useState(true);
  const [meterStore] = useState(createProjectPlaybackMeterStore);
  const [stemTargets, setStemTargets] = useState<readonly ProjectStemPrintTarget[]>([]);
  const editSequenceRef = useRef(0);

  useEffect(() => {
    if (meterActive) {
      meterStore.publish(fakeMeterSnapshot);
    } else {
      meterStore.clear();
    }

    return () => meterStore.clear();
  }, [meterActive, meterStore]);

  const selectTrack = (selectedTrackId: string) => {
    const nextTarget: HarnessTarget = selectedTrackId === 'master'
      ? 'master'
      : selectedTrackId === groupTrack.id
        ? 'group'
        : 'channel';
    setTarget(nextTarget);
    setHistory((currentHistory) => {
      const nextHistory = updateSessionEditPresent(currentHistory, (workspace) => ({
        project: {
          ...workspace.project,
          selection: {
            items: [{ id: selectedTrackId, type: 'track' as const }],
          },
        },
      }));
      historyRef.current = nextHistory;
      return nextHistory;
    });
  };

  const toggleTrackMute = (trackId: string) => {
    setHistory((currentHistory) => {
      const nextHistory = updateSessionEditPresent(currentHistory, (workspace) => ({
        project: toggleProjectMixerChannelMute(workspace.project, trackId),
      }));
      historyRef.current = nextHistory;
      return nextHistory;
    });
  };

  const selectTarget = (nextTarget: HarnessTarget) => {
    if (nextTarget === 'empty') {
      setTarget(nextTarget);
      setHistory((currentHistory) => {
        const nextHistory = updateSessionEditPresent(currentHistory, (workspace) => ({
          project: {
            ...workspace.project,
            selection: { items: [] },
          },
        }));
        historyRef.current = nextHistory;
        return nextHistory;
      });
      return;
    }

    selectTrack(
      nextTarget === 'channel'
        ? 'hum-audio'
        : nextTarget === 'master'
          ? 'master'
          : groupTrack.id,
    );
  };

  const runCommand = (
    command: ProjectMixerEffectCommand,
  ): MixerEffectsEditorCommandOutcome => {
    editSequenceRef.current += 1;
    const result = executeProjectMixerEffectCommand(
      historyRef.current,
      command,
      {
        createdAt: new Date().toISOString(),
        editId: `ui-evidence-${editSequenceRef.current}`,
        historyLimit: 80,
      },
    );
    historyRef.current = result.history;
    setHistory(result.history);
    return {
      message:
        result.status === 'EXECUTED'
          ? `${result.edit.label}. Evidence harness command executed.`
          : result.status === 'NO_OP'
            ? 'No change. No Undo step was created.'
            : result.message,
      status: result.status,
    };
  };

  const selectRoutingScenario = (scenario: HarnessRoutingScenario) => {
    setRoutingScenario(scenario);
    setHistory((currentHistory) => {
      const project = currentHistory.present.value.project;
      const nextHistory = updateSessionEditPresent(currentHistory, (workspace) => ({
        project: {
          ...workspace.project,
          mixer: project.mixer && {
            ...project.mixer,
            channels: Object.freeze(project.mixer.channels.map((channel) => Object.freeze({
              ...channel,
              muted: scenario === 'muted' && channel.trackId === 'hum-audio',
              solo: scenario === 'solo' && channel.trackId === 'midi-notes',
            }))),
          },
          tracks: project.tracks.map((track) => track.id === 'hum-audio'
            ? {
                ...track,
                clips: track.clips.map((clip, index) => scenario === 'offline' && index === 0
                  ? {
                      ...clip,
                      sourceFile: {
                        ...(clip.sourceFile ?? { name: 'mixer-console-offline-evidence.wav' }),
                        status: 'missing' as const,
                      },
                    }
                  : clip.sourceFile
                    ? {
                        ...clip,
                        sourceFile: { ...clip.sourceFile, status: 'available' as const },
                      }
                    : clip),
              }
            : track),
        },
      }));
      historyRef.current = nextHistory;
      return nextHistory;
    });
  };

  const moveHistory = (direction: 'redo' | 'undo') => {
    const result = direction === 'undo'
      ? undoSessionEdit(historyRef.current)
      : redoSessionEdit(historyRef.current, 80);
    historyRef.current = result.history;
    setHistory(result.history);
  };
  const targetCatalog = listProjectStemPrintTargetOptions(
    history.present.value.project,
  );
  const stemSelection = resolveProjectStemPrintSelection(
    history.present.value.project,
    stemTargets,
  );
  const toggleStemTarget = (stemTarget: ProjectStemPrintTarget) => {
    const next = toggleProjectStemPrintTarget(
      history.present.value.project,
      stemTargets,
      stemTarget,
    );
    if (next.canResolve) setStemTargets(next.targets);
  };

  return (
    <main className="mixer-ui-evidence-shell">
      <nav className="mixer-ui-evidence-controls" aria-label="UI evidence scenarios">
        <strong>NON-AUDIO UI EVIDENCE</strong>
        {(['channel', 'master', 'group', 'empty'] as const).map((candidate) => (
          <button
            type="button"
            aria-pressed={target === candidate}
            data-mixer-selection-target="true"
            key={candidate}
            onClick={() => selectTarget(candidate)}
          >
            {candidate.toUpperCase()}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={meterActive}
          onClick={() => setMeterActive((active) => !active)}
        >
          {meterActive ? 'METER ACTIVE' : 'METER UNAVAILABLE'}
        </button>
        {(['normal', 'muted', 'solo', 'offline'] as const).map((scenario) => (
          <button
            type="button"
            aria-pressed={routingScenario === scenario}
            key={scenario}
            onClick={() => selectRoutingScenario(scenario)}
          >
            {scenario.toUpperCase()}
          </button>
        ))}
        <button
          type="button"
          disabled={history.past.length === 0}
          onClick={() => moveHistory('undo')}
        >
          UNDO {history.past.length}
        </button>
        <button
          type="button"
          disabled={history.future.length === 0}
          onClick={() => moveHistory('redo')}
        >
          REDO {history.future.length}
        </button>
      </nav>
      <MixerEffectsEditor
        activeTransport={meterActive ? 'PLAY' : 'STOP'}
        isActive
        isEditingLocked={false}
        meterStore={meterStore}
        projectMixdownControl={createMixerProjectMixdownControlModel({
          engineAcceptsNewJobs: true,
          engineAvailabilityMessage: 'Ready.',
          isProjectRootReady: true,
          state: { status: 'IDLE' },
        })}
        projectStemPrintControl={createMixerProjectStemPrintControlModel({
          engineAcceptsNewJobs: true,
          engineAvailabilityMessage: 'Ready.',
          hasRawMixdownLock: false,
          hasSelection: stemSelection.canResolve && stemSelection.targets.length > 0,
          isProjectRootReady: true,
          state: { status: 'IDLE' },
        })}
        projectStemPrintOptions={targetCatalog.canList ? targetCatalog.options : []}
        selectedProjectStemPrintTargetKeys={
          stemSelection.canResolve ? stemSelection.selectedKeys : []
        }
        onCancelProjectMixdown={() => undefined}
        onCommand={runCommand}
        onRecoverProjectMixdown={() => undefined}
        onRequestReset={(command) => runCommand(command)}
        onRunProjectMixdown={() => undefined}
        onToggleProjectStemPrintTarget={toggleStemTarget}
        onSelectTrack={selectTrack}
        onToggleTrackMute={toggleTrackMute}
        project={history.present.value.project}
      />
    </main>
  );
}

function createHarnessHistory(): SessionEditHistory<HarnessWorkspace> {
  const tracks = [
    groupTrack,
    ...sampleProject.tracks.map((track) => ({
      ...track,
      parentGroupId: track.id === 'hum-audio' ? groupTrack.id : track.parentGroupId,
      clips: track.clips.map((clip) => ({ ...clip })),
    })),
    ...Array.from({ length: 12 }, (_, index): Track => ({
      clips: [],
      id: `console-evidence-${String(index + 1).padStart(2, '0')}`,
      level: -3 - index,
      name: `Console Track ${String(index + 1).padStart(2, '0')}`,
      type: index % 2 === 0 ? 'audio' : 'midi',
    })),
  ];
  const normalization = normalizeProjectMixerState(tracks, undefined);
  const project: ProjectState = {
    ...sampleProject,
    mixer: normalization.mixer,
    selection: { items: [{ id: 'hum-audio', type: 'track' }] },
    tracks: normalization.tracks,
  };

  return createSessionEditHistory(
    { project },
    {
      category: 'system',
      createdAt: '2026-08-11T09:00:00.000Z',
      id: 'ui-evidence-open',
      label: 'Open UI Evidence Harness',
    },
  );
}

const fakeMeterSnapshot = Object.freeze({
  cycleSequence: 1,
  frameEnd: 4,
  frameStart: 0,
  meterSummary: createMixerMeterTapSummary(
    [
      {
        accumulator: accumulateMixerSamplePeakBlock(
          createMixerSamplePeakAccumulator(),
          [0.18, -0.74, 0.96, 0.42],
          [0.21, 0.55, -1.08, 0.31],
        ),
        trackId: 'hum-audio',
      },
    ],
    accumulateMixerSamplePeakBlock(
      createMixerSamplePeakAccumulator(),
      [0.24, -0.83, 1, 0.48],
      [0.27, 0.63, -0.91, 0.36],
    ),
  ),
  sessionId: 'mixer-effects-ui-evidence',
  version: 1 as const,
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <MixerEffectsUiEvidenceHarness />,
);
