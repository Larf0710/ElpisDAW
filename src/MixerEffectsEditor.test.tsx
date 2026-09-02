import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  accumulateMixerSamplePeakBlock,
  createMixerSamplePeakAccumulator,
} from '../shared/mixerMeterContract.js';
import { createMixerMeterTapSummary } from '../shared/mixerMeterTapContract.js';
import {
  MixerEffectsEditor,
  runMixerTrackMuteAction,
} from './MixerEffectsEditor';
import {
  normalizeProjectMixerState,
  toggleProjectMixerChannelMute,
} from './projectMixerState';
import {
  createMixerProjectMixdownControlModel,
  MIXER_PROJECT_MIXDOWN_OWNER,
  type MixerProjectMixdownControlModel,
} from './projectMixdownUiState';
import { createProjectPlaybackMeterStore } from './projectPlaybackMeterStore';
import { createMixerProjectStemPrintControlModel } from './projectStemPrintUiState';
import { sampleProject } from './sampleProject';
import type { ProjectState } from './types';

describe('MixerEffectsEditor', () => {
  it('renders a compact accessible Channel editor with fixed Insert order and exact control names', () => {
    const markup = renderEditor(createProject('hum-audio'));

    expect(markup).toContain('aria-label="Channel Mixer Effects for Hum Audio"');
    expect(markup).toContain('Hum Audio');
    expect(markup).toMatch(/Equalizer Insert, bypassed[\s\S]*Compressor Insert, bypassed[\s\S]*Echo \/ Delay Insert, bypassed/);
    expect(markup).toContain('aria-label="Hum Audio Equalizer Bypass"');
    expect(markup).toContain('aria-label="Reset Hum Audio Equalizer"');
    expect(markup).toContain('aria-label="Hum Audio Equalizer Low Gain slider"');
    expect(markup).toContain('aria-label="Hum Audio Equalizer Low Gain value"');
    expect(markup).toContain('METER OFFLINE');
    expect(markup).toContain('NO DATA');
    expect(markup).not.toContain('CONSOLE OVERVIEW');
    expect(markup).not.toContain('SELECT A STRIP FOR EFFECT DETAILS');
    expect(markup).toContain('Project Channel strips in Timeline order');
    expect(markup).toContain('Fixed Master strip');
    expect(markup).not.toContain('Master Raw Mix print controls');
    expect(markup.match(/MIXDOWN/g)).toHaveLength(2);
    expect(markup).toMatch(/mixer-project-mixdown-band[\s\S]*MIXDOWN[\s\S]*mixer-project-mixdown-status[\s\S]*READY/);
    expect(markup).toContain('Hum Audio vertical Volume fader slot');
    expect(markup).toContain('aria-label="Mute Hum Audio Track"');
    expect(markup).toContain('aria-label="Hum Audio Track on"');
    expect(markup).toMatch(/mixer-console-channel-mute-row[\s\S]*>MUTE<\/button>[\s\S]*>ON<\/span>/);
    expect(markup).toMatch(/mixer-console-master[\s\S]*Master Peak Hold controls[\s\S]*Reset Master Peak Hold[\s\S]*Master exact meter/);
    expect(markup).not.toContain('has-group-path');
    expect(markup).toMatch(/aria-label="Exact Playback meters"[\s\S]*EXACT PEAK[\s\S]*HUM MIX FX[\s\S]*ALL BYPASSED/);
    expect(markup).toMatch(/mixer-effect-center-column[\s\S]*mixer-effect-editor[\s\S]*mixer-effects-status-line[\s\S]*aria-label="Exact Playback meters"/);
    expect(markup).toMatch(/mixer-project-mixdown-band[\s\S]*mixer-meter-block-header[\s\S]*EXACT PEAK[\s\S]*mixer-meter-groups/);
    expect(markup).not.toContain('class="mixer-effects-header"');
    expect(markup).not.toContain('Yamaha');
    expect(markup).not.toContain('QY70');
  });

  it('renders a distinct Master context with Limiter structurally last', () => {
    const markup = renderEditor(createProject('master'));

    expect(markup).toContain('aria-label="Master bus Mixer Effects for Master"');
    expect(markup).toMatch(/Equalizer Insert, bypassed[\s\S]*Compressor Insert, bypassed[\s\S]*Limiter Insert, bypassed/);
    expect(markup).toContain('EQ → COMP → LIMITER · LIMITER LAST');
    expect(markup).not.toContain('Echo / Delay Insert');
  });

  it('renders an honest empty state for Group or missing selection', () => {
    const markup = renderEditor(createProject());

    expect(markup).toContain('aria-label="Mixer Effects, no editable Channel selected"');
    expect(markup).toContain('No editable Channel');
    expect(markup).toContain('Select one Channel or the Master track');
    expect(markup).not.toContain('0.000');
    expect(markup).not.toContain('class="mixer-effects-header"');
  });

  it('shows one Clip-scoped SoundFont menu and visible voice indicator for a selected MIDI Clip', () => {
    const project = createProject();
    project.selection = { items: [{ id: 'clip-midi-1', type: 'clip' }] };
    const markup = renderEditor(project);

    expect(markup).toContain('aria-label="Mixer SoundFont menu"');
    expect(markup).toContain('aria-label="Mixer SoundFont voice indicator"');
    expect(markup).toContain('aria-label="Mixer SoundFont"');
    expect(markup).toContain('aria-label="Mixer Sound"');
    expect(markup).toContain('aria-label="Mixer SoundFont Bank"');
    expect(markup).toContain('aria-label="Mixer SoundFont Program"');
    expect(markup).not.toContain('APPLY TO MIDI TO AUDIO');
    expect(markup).not.toContain('>AUDITION</button>');
    expect(markup).not.toContain('>CLEAR</button>');
    expect(markup).not.toContain('>REFRESH</button>');
    expect(markup).toContain('Converted Motif');
  });

  it('relocates the truthful enabled-effect count into the Exact Playback block', () => {
    const project = createProject('hum-audio');
    const mixer = project.mixer!;
    const channels = mixer.channels.map((channel) => channel.trackId === 'hum-audio'
      ? Object.freeze({
          ...channel,
          inserts: Object.freeze([
            Object.freeze({ ...channel.inserts[0], bypass: false }),
            channel.inserts[1],
            channel.inserts[2],
          ]) as typeof channel.inserts,
        })
      : channel);
    const markup = renderEditor({
      ...project,
      mixer: Object.freeze({ ...mixer, channels: Object.freeze(channels) }),
    });

    expect(markup).toMatch(/aria-label="Exact Playback meters"[\s\S]*HUM MIX FX[\s\S]*1 ACTIVE/);
    expect(markup).toContain('aria-label="Mixer Effects state 1 ACTIVE"');
  });

  it('keeps muted, Solo-excluded, and offline Channels visible, selectable, and meter-honest', () => {
    const project = createProject('hum-audio');
    const mixer = project.mixer!;
    const channels = mixer.channels.map((channel) => channel.trackId === 'hum-audio'
      ? Object.freeze({ ...channel, muted: true })
      : Object.freeze({ ...channel, solo: channel.trackId === 'midi-notes' }));
    const tracks = project.tracks.map((track) => track.id === 'hum-audio'
      ? {
          ...track,
          clips: track.clips.map((clip, index) => index === 0 && clip.sourceFile
            ? { ...clip, sourceFile: { ...clip.sourceFile, status: 'missing' as const } }
            : clip),
        }
      : track);
    const markup = renderEditor({
      ...project,
      mixer: Object.freeze({ ...mixer, channels: Object.freeze(channels) }),
      tracks,
    }, createMeterSnapshot(), 'PLAY');

    expect(markup).toContain('Open Hum Audio Channel details');
    expect(markup).toContain('aria-label="Unmute Hum Audio Track"');
    expect(markup).toContain('aria-label="Hum Audio Track muted"');
    expect(markup).toContain('Hum Audio Mute on');
    expect(markup).toContain('MUTED');
    expect(markup).toContain('Channel METER MUTED');
    expect(markup).toContain('SOLO EXCLUDED');
    expect(markup).not.toContain('Hum Audio exact L peak 1');
  });

  it('routes Mixer Mute through the canonical Track mutation and reflects Timeline-originated state', () => {
    let project = createProject('hum-audio');

    runMixerTrackMuteAction((trackId) => {
      project = toggleProjectMixerChannelMute(project, trackId);
    }, 'hum-audio');

    const mixerChannel = project.mixer?.channels.find(
      (channel) => channel.trackId === 'hum-audio',
    );
    const timelineTrack = project.tracks.find((track) => track.id === 'hum-audio');
    const markup = renderEditor(project);

    expect(mixerChannel?.muted).toBe(true);
    expect(timelineTrack?.muted).toBe(true);
    expect(markup).toContain('aria-label="Unmute Hum Audio Track"');
    expect(markup).toContain('aria-label="Hum Audio Track muted"');
  });

  it('makes a valid Group proxy explicit without rendering a fake Group strip', () => {
    const base = createProject();
    const groupId = 'group-vocals';
    const group = {
      clips: [],
      group: {
        activePlaybackTrackId: 'hum-audio',
        childTrackIds: ['hum-audio'],
        collapsed: false,
        playbackMode: 'bottom_child' as const,
      },
      id: groupId,
      level: 0,
      name: 'Vocals Group',
      type: 'group' as const,
    };
    const tracks = base.tracks.flatMap((track) => track.id === 'hum-audio'
      ? [{ ...track, parentGroupId: groupId }, group]
      : [track]);
    const normalized = normalizeProjectMixerState(tracks, base.mixer);
    const markup = renderEditor({
      ...base,
      mixer: normalized.mixer,
      selection: { items: [{ id: groupId, type: 'track' }] },
      tracks: normalized.tracks,
    });

    expect(markup).toContain('GROUP PROXY');
    expect(markup).toMatch(/Vocals Group<\/strong><b[^>]*>&gt;<\/b><strong>Hum Audio/);
    expect(markup).toContain('Hum Audio Group path Vocals Group');
    expect(markup).toMatch(
      /mixer-console-strip mixer-console-channel[^\"]*has-group-path/,
    );
    expect(markup).not.toContain('Open Vocals Group Channel details');
    expect(markup).toContain('Hum Audio Equalizer Bypass');
  });

  it('renders exact injected peaks and clip semantics without audio or persistence data', () => {
    const markup = renderEditor(
      createProject('hum-audio'),
      createMeterSnapshot(),
      'PLAY',
    );

    expect(markup).toContain('EXACT PEAK');
    expect(markup).toContain('L exact sample peak 1');
    expect(markup).toContain('R exact sample peak 1.0001, clipped');
    expect(markup).toContain('1.000');
    expect(markup).toContain('CLIP');
    expect(markup).toContain('PEAK HOLD');
    expect(markup).toContain('NO CLIP');
    expect(markup).toContain('RESET PEAK');
    expect(markup).toContain('FROZEN PLAYBACK');
    expect(markup).toContain('Changes apply on the next playback operation.');
    expect(markup).not.toContain('sessionId');
    expect(markup).not.toContain('ui-meter-session');
  });

  it('disables editing controls without hiding inspectable Mixer state', () => {
    const markup = renderEditor(createProject('hum-audio'), undefined, 'STOP', true);

    expect(markup).toContain('Hum Audio Equalizer Insert, bypassed');
    expect(markup).toContain('aria-label="Hum Audio Equalizer Bypass" aria-pressed="true" disabled=""');
    expect(markup).toContain('aria-label="Reset Hum Audio Equalizer" disabled=""');
  });

  it('keeps Mixer Mixdown available with zero Clip Filer PatchTabs', () => {
    const project = { ...createProject('master'), patchTabs: [] };
    const markup = renderEditor(project);

    expect(markup).toContain('aria-label="Mixer Project Mixdown controls"');
    expect(markup).toContain('aria-label="MIXDOWN from Mixer"');
    expect(markup).not.toContain('Master Raw Mix print controls');
    expect(markup).not.toContain('SAVE WAV');
  });

  it('renders accessible multi-target Stem Print controls beside the existing Mixdown', () => {
    const project = createProject('hum-audio');
    const markup = renderToStaticMarkup(
      <MixerEffectsEditor
        activeTransport="STOP"
        isActive
        isEditingLocked={false}
        meterStore={createProjectPlaybackMeterStore()}
        projectMixdownControl={createMixerControl({ status: 'IDLE' })}
        projectStemPrintControl={createMixerProjectStemPrintControlModel({
          engineAcceptsNewJobs: true,
          engineAvailabilityMessage: 'Ready.',
          hasRawMixdownLock: false,
          hasSelection: true,
          isProjectRootReady: true,
          state: { status: 'IDLE' },
        })}
        projectStemPrintOptions={[
          {
            canSelect: true,
            key: 'channel:hum-audio',
            kind: 'channel',
            label: 'Hum Audio',
            message: 'Print Mixer Channel Hum Audio.',
            resolvedTrackId: 'hum-audio',
            target: { kind: 'channel', trackId: 'hum-audio' },
          },
          {
            canSelect: true,
            key: 'group:group-a',
            kind: 'group',
            label: 'Group A',
            message: 'Print Group A.',
            resolvedTrackId: 'midi-notes',
            target: { groupTrackId: 'group-a', kind: 'group' },
          },
        ]}
        selectedProjectStemPrintTargetKeys={['channel:hum-audio']}
        onCancelProjectMixdown={() => undefined}
        onCommand={() => ({ message: 'Executed.', status: 'EXECUTED' })}
        onRecoverProjectMixdown={() => undefined}
        onRequestReset={() => undefined}
        onRunProjectMixdown={() => undefined}
        onSelectTrack={() => undefined}
        onToggleTrackMute={() => undefined}
        project={project}
      />,
    );

    expect(markup).toContain('aria-label="Mixer Stem Print controls"');
    expect(markup).toContain('aria-label="STEM PRINT from Mixer"');
    expect(markup).toContain('aria-label="Remove channel Hum Audio from Stem Print"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Add group Group A from Stem Print"');
    expect(markup).toMatch(/mixer-project-mixdown-band[\s\S]*MIXDOWN[\s\S]*mixer-project-stem-print[\s\S]*STEM PRINT/);
  });

  it('shows contextual cancel and exact recovery controls for Mixer-owned operations', () => {
    const runningMarkup = renderEditor(
      createProject('master'),
      undefined,
      'STOP',
      false,
      createMixerControl({
        operationId: 'mixdown-operation-1',
        owner: MIXER_PROJECT_MIXDOWN_OWNER,
        status: 'RUNNING',
      }),
    );
    const unknownMarkup = renderEditor(
      createProject('master'),
      undefined,
      'STOP',
      false,
      createMixerControl({
        operationId: 'mixdown-operation-1',
        owner: MIXER_PROJECT_MIXDOWN_OWNER,
        status: 'MIXDOWN_OUTCOME_UNKNOWN',
      }),
    );

    expect(runningMarkup).toContain('>RUNNING</strong>');
    expect(runningMarkup).toContain('>CANCEL</button>');
    expect(runningMarkup).toContain('OP mixdown-operation-1');
    expect(unknownMarkup).toContain('>OUTCOME UNKNOWN</strong>');
    expect(unknownMarkup).toContain('>RECOVER</button>');
    expect(unknownMarkup).toContain('OP mixdown-operation-1');
  });
});

function renderEditor(
  project: ProjectState,
  meterSnapshot?: ReturnType<typeof createMeterSnapshot>,
  activeTransport: 'PLAY' | 'STOP' = 'STOP',
  isEditingLocked = false,
  projectMixdownControl: MixerProjectMixdownControlModel = createMixerControl({
    status: 'IDLE',
  }),
): string {
  const meterStore = createProjectPlaybackMeterStore();
  if (meterSnapshot) {
    meterStore.publish(meterSnapshot);
  }

  return renderToStaticMarkup(
    <MixerEffectsEditor
      activeTransport={activeTransport}
      isActive
      isEditingLocked={isEditingLocked}
      meterStore={meterStore}
      projectMixdownControl={projectMixdownControl}
      onCancelProjectMixdown={() => undefined}
      onCommand={() => ({ message: 'Executed.', status: 'EXECUTED' })}
      onRecoverProjectMixdown={() => undefined}
      onRequestReset={() => undefined}
      onRunProjectMixdown={() => undefined}
      onSelectTrack={() => undefined}
      onToggleTrackMute={() => undefined}
      project={project}
    />,
  );
}

function createMixerControl(
  state: Parameters<typeof createMixerProjectMixdownControlModel>[0]['state'],
): MixerProjectMixdownControlModel {
  return createMixerProjectMixdownControlModel({
    engineAcceptsNewJobs: true,
    engineAvailabilityMessage: 'Ready.',
    isProjectRootReady: true,
    state,
  });
}

function createProject(selectedTrackId?: string): ProjectState {
  const tracks = sampleProject.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => ({ ...clip })),
  }));
  const normalization = normalizeProjectMixerState(tracks, undefined);

  return {
    ...sampleProject,
    mixer: normalization.mixer,
    selection: {
      items: selectedTrackId
        ? [{ id: selectedTrackId, type: 'track' as const }]
        : [],
    },
    tracks: normalization.tracks,
  };
}

function createMeterSnapshot() {
  return Object.freeze({
    cycleSequence: 1,
    frameEnd: 1,
    frameStart: 0,
    meterSummary: createMixerMeterTapSummary(
      [
        {
          accumulator: accumulateMixerSamplePeakBlock(
            createMixerSamplePeakAccumulator(),
            [1],
            [1.0001],
          ),
          trackId: 'hum-audio',
        },
      ],
      accumulateMixerSamplePeakBlock(
        createMixerSamplePeakAccumulator(),
        [0.8],
        [0.7],
      ),
    ),
    sessionId: 'ui-meter-session',
    version: 1 as const,
  });
}
