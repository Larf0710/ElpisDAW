import { describe, expect, it } from 'vitest';

import {
  MIXER_COMPRESSOR_PARAMETER_SPECS,
  MIXER_ECHO_DELAY_PARAMETER_SPECS,
  MIXER_EFFECT_TYPE_COMPRESSOR,
  MIXER_EFFECT_TYPE_ECHO_DELAY,
  MIXER_EFFECT_TYPE_EQUALIZER,
  MIXER_EFFECT_TYPE_LIMITER,
  MIXER_EQUALIZER_PARAMETER_SPECS,
  MIXER_LIMITER_PARAMETER_SPECS,
  type MixerEffectState,
} from '../shared/mixerEffectsContract.js';
import {
  accumulateMixerSamplePeakBlock,
  createMixerSamplePeakAccumulator,
} from '../shared/mixerMeterContract.js';
import { createMixerMeterTapSummary } from '../shared/mixerMeterTapContract.js';
import { executeProjectMixerEffectCommand } from './projectMixerEffectsCommand';
import { normalizeProjectMixerState, reconcileProjectMixerState } from './projectMixerState';
import { sampleProject } from './sampleProject';
import { createSessionEditHistory } from './sessionEditHistory';
import type { ProjectState, Track } from './types';
import {
  MIXER_EFFECTS_UI_PRESENTATION_VERSION,
  MIXER_EFFECT_UI_PRESENTATIONS,
  createMixerEffectBypassUiCommand,
  createMixerEffectParameterUiCommand,
  createMixerEffectResetUiCommand,
  createMixerEffectsUiMeterPresentation,
  createMixerMeterBarPresentation,
  getMixerEffectUiPresentation,
  parseMixerEffectParameterDraft,
  resolveMixerEffectsConsole,
  resolveMixerEffectsUiStrip,
  stepMixerEffectParameterValue,
} from './mixerEffectsUiModel';

describe('Mixer Effects UI model', () => {
  it('publishes one immutable v1 presentation for every fixed effect and all 19 parameters', () => {
    expect(MIXER_EFFECTS_UI_PRESENTATION_VERSION).toBe(1);
    expect(MIXER_EFFECT_UI_PRESENTATIONS.map((effect) => effect.effectType)).toEqual([
      MIXER_EFFECT_TYPE_EQUALIZER,
      MIXER_EFFECT_TYPE_COMPRESSOR,
      MIXER_EFFECT_TYPE_ECHO_DELAY,
      MIXER_EFFECT_TYPE_LIMITER,
    ]);
    expect(
      MIXER_EFFECT_UI_PRESENTATIONS.flatMap((effect) => effect.parameters),
    ).toHaveLength(19);
    expect(Object.isFrozen(MIXER_EFFECT_UI_PRESENTATIONS)).toBe(true);
    expect(
      MIXER_EFFECT_UI_PRESENTATIONS.every(
        (effect) =>
          Object.isFrozen(effect) &&
          Object.isFrozen(effect.parameters) &&
          effect.parameters.every(Object.isFrozen),
      ),
    ).toBe(true);
  });

  it('uses the committed Effects Contract objects as range truth', () => {
    const equalizer = getMixerEffectUiPresentation(MIXER_EFFECT_TYPE_EQUALIZER);
    const compressor = getMixerEffectUiPresentation(MIXER_EFFECT_TYPE_COMPRESSOR);
    const delay = getMixerEffectUiPresentation(MIXER_EFFECT_TYPE_ECHO_DELAY);
    const limiter = getMixerEffectUiPresentation(MIXER_EFFECT_TYPE_LIMITER);

    expect(equalizer.parameters.find((parameter) => parameter.name === 'lowGainDb')?.spec)
      .toBe(MIXER_EQUALIZER_PARAMETER_SPECS.lowGainDb);
    expect(compressor.parameters.find((parameter) => parameter.name === 'thresholdDb')?.spec)
      .toBe(MIXER_COMPRESSOR_PARAMETER_SPECS.thresholdDb);
    expect(delay.parameters.find((parameter) => parameter.name === 'delayTimeMs')?.spec)
      .toBe(MIXER_ECHO_DELAY_PARAMETER_SPECS.delayTimeMs);
    expect(limiter.parameters.find((parameter) => parameter.name === 'ceilingDb')?.spec)
      .toBe(MIXER_LIMITER_PARAMETER_SPECS.ceilingDb);
  });

  it('resolves one selected Channel and preserves its fixed Insert order', () => {
    const project = createProject('hum-audio');
    const strip = resolveMixerEffectsUiStrip(project);

    expect(strip.status).toBe('READY');
    if (strip.status !== 'READY') {
      return;
    }

    expect(strip.scope).toBe('channel');
    expect(strip.trackId).toBe('hum-audio');
    expect(strip.effects.map((effect) => effect.effectType)).toEqual([
      MIXER_EFFECT_TYPE_EQUALIZER,
      MIXER_EFFECT_TYPE_COMPRESSOR,
      MIXER_EFFECT_TYPE_ECHO_DELAY,
    ]);
  });

  it('opens the owning Mixer Channel when one Timeline Clip is selected', () => {
    const project = createProject();
    project.selection = {
      items: [{ id: 'clip-midi-1', type: 'clip' }],
    };

    expect(resolveMixerEffectsUiStrip(project)).toMatchObject({
      scope: 'channel',
      status: 'READY',
      trackId: 'midi-notes',
    });
    const console = resolveMixerEffectsConsole(project);
    expect(console.status).toBe('READY');
    if (console.status === 'READY') {
      expect(
        console.channels.find((channel) => channel.trackId === 'midi-notes'),
      ).toMatchObject({ selected: true });
    }
  });

  it('maps the selected Master track to the Master bus fixed Insert order', () => {
    const strip = resolveMixerEffectsUiStrip(createProject('master'));

    expect(strip.status).toBe('READY');
    if (strip.status !== 'READY') {
      return;
    }

    expect(strip.scope).toBe('master');
    expect(strip.effects.map((effect) => effect.effectType)).toEqual([
      MIXER_EFFECT_TYPE_EQUALIZER,
      MIXER_EFFECT_TYPE_COMPRESSOR,
      MIXER_EFFECT_TYPE_LIMITER,
    ]);
  });

  it('derives Console Channels from Project order with stable identities and a fixed separate Master', () => {
    const project = createProject('hum-audio');
    const resolution = resolveMixerEffectsConsole(project);

    expect(resolution.status).toBe('READY');
    if (resolution.status !== 'READY') {
      return;
    }

    const expectedChannelIds = project.tracks
      .filter((track) => !track.group && track.type !== 'group' && track.type !== 'master')
      .map((track) => track.id);
    expect(resolution.channels.map((channel) => channel.trackId)).toEqual(expectedChannelIds);
    expect(resolution.channels.map((channel) => channel.key)).toEqual(
      expectedChannelIds.map((trackId) => `channel:${trackId}`),
    );
    expect(resolution.master.trackId).toBe('master');
    expect(resolution.master.key).toBe('master');
    expect(resolution.channels.some((channel) => channel.trackId === 'master')).toBe(false);
  });

  it('opens legacy no-Mixer Projects through the existing v2 migration without a second strip model', () => {
    const tracks = sampleProject.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => ({ ...clip })),
    }));
    const normalization = normalizeProjectMixerState(tracks, undefined);
    const resolution = resolveMixerEffectsConsole({
      ...sampleProject,
      mixer: normalization.mixer,
      tracks: normalization.tracks,
    });

    expect(normalization.metadata).toEqual({
      migrated: true,
      source: 'legacy-no-mixer',
    });
    expect(resolution.status).toBe('READY');
    if (resolution.status === 'READY') {
      expect(resolution.channels.map((channel) => channel.trackId)).toEqual(
        normalization.tracks
          .filter((track) => !track.group && track.type !== 'group' && track.type !== 'master')
          .map((track) => track.id),
      );
    }
  });

  it.each([16, 32, 64, 128])(
    'derives all %i eligible Channels without truncating, merging, or duplicating identity',
    (channelCount) => {
      const project = createLargeConsoleProject(channelCount);
      const resolution = resolveMixerEffectsConsole(project);

      expect(resolution.status).toBe('READY');
      if (resolution.status !== 'READY') {
        return;
      }

      expect(resolution.channels).toHaveLength(channelCount);
      expect(new Set(resolution.channels.map((channel) => channel.trackId)).size).toBe(channelCount);
      expect(resolution.channels[0].trackId).toBe('stress-track-001');
      expect(resolution.channels[resolution.channels.length - 1]?.trackId).toBe(
        `stress-track-${String(channelCount).padStart(3, '0')}`,
      );
      expect(Object.isFrozen(resolution.channels)).toBe(true);
    },
  );

  it('keeps muted, Solo-excluded, and offline Channels visible with truthful state', () => {
    const project = createProject('hum-audio');
    const mixer = project.mixer!;
    const channels = mixer.channels.map((channel) => channel.trackId === 'hum-audio'
      ? Object.freeze({ ...channel, muted: true })
      : channel.trackId === 'midi-notes'
        ? Object.freeze({ ...channel, solo: true })
        : channel);
    const tracks = project.tracks.map((track) => track.id === 'hum-audio'
      ? {
          ...track,
          clips: track.clips.length > 0
            ? track.clips.map((clip, index) => index === 0
              ? {
                  ...clip,
                  sourceFile: {
                    ...(clip.sourceFile ?? { name: 'offline.wav' }),
                    status: 'missing' as const,
                  },
                }
              : clip)
            : track.clips,
        }
      : track);
    const resolution = resolveMixerEffectsConsole({
      ...project,
      mixer: Object.freeze({ ...mixer, channels: Object.freeze(channels) }),
      tracks,
    });

    expect(resolution.status).toBe('READY');
    if (resolution.status !== 'READY') {
      return;
    }
    expect(resolution.channels).toHaveLength(
      project.tracks.filter((track) => track.type !== 'master' && !track.group).length,
    );
    expect(resolution.channels.find((channel) => channel.trackId === 'hum-audio')).toMatchObject({
      audibility: 'MUTED',
      selected: true,
      sourceStatus: 'SOURCE_OFFLINE',
    });
    expect(resolution.channels.find((channel) => channel.trackId === 'midi-notes')).toMatchObject({
      audibility: 'AUDIBLE',
      solo: true,
    });
    expect(resolution.channels.find((channel) =>
      channel.trackId !== 'hum-audio' && channel.trackId !== 'midi-notes'))
      .toMatchObject({ audibility: 'SOLO_EXCLUDED' });

    const mutedProject = {
      ...project,
      mixer: Object.freeze({ ...mixer, channels: Object.freeze(channels) }),
      tracks,
    };
    const mutedEditor = resolveMixerEffectsUiStrip(mutedProject);
    expect(mutedEditor).toMatchObject({ status: 'READY', trackId: 'hum-audio' });
    if (mutedEditor.status === 'READY') {
      const result = executeProjectMixerEffectCommand(
        createHistory(mutedProject),
        createMixerEffectBypassUiCommand(mutedEditor, mutedEditor.effects[0], false),
        {
          createdAt: '2026-08-11T10:00:00.000Z',
          editId: 'muted-channel-effect-edit',
          historyLimit: 80,
        },
      );
      expect(result.status).toBe('EXECUTED');
    }
    expect(resolveMixerEffectsConsole(
      JSON.parse(JSON.stringify(mutedProject)) as ProjectState,
    )).toEqual(resolution);

    const reconnectedProject = {
      ...mutedProject,
      tracks: mutedProject.tracks.map((track) => track.id === 'hum-audio'
        ? {
            ...track,
            clips: track.clips.map((clip) => clip.sourceFile
              ? { ...clip, sourceFile: { ...clip.sourceFile, status: 'available' as const } }
              : clip),
          }
        : track),
    };
    const reconnected = resolveMixerEffectsConsole(reconnectedProject);
    expect(reconnected.status).toBe('READY');
    if (reconnected.status === 'READY') {
      expect(reconnected.channels.find((channel) => channel.trackId === 'hum-audio')).toMatchObject({
        key: 'channel:hum-audio',
        sourceStatus: 'AVAILABLE',
      });
    }
  });

  it('flattens nested Group containers into leaf strips with compact hierarchy metadata', () => {
    const base = createProject();
    const leaf = base.tracks.find((track) => track.id === 'hum-audio')!;
    const outerGroup: Track = {
      clips: [],
      group: {
        activePlaybackTrackId: 'inner-group',
        childTrackIds: ['inner-group'],
        collapsed: false,
        playbackMode: 'bottom_child',
      },
      id: 'outer-group',
      level: 0,
      name: 'Outer Group',
      type: 'group',
    };
    const innerGroup: Track = {
      clips: [],
      group: {
        activePlaybackTrackId: leaf.id,
        childTrackIds: [leaf.id],
        collapsed: false,
        playbackMode: 'bottom_child',
      },
      id: 'inner-group',
      level: 0,
      name: 'Inner Group',
      parentGroupId: outerGroup.id,
      type: 'group',
    };
    const tracks = [
      { ...leaf, parentGroupId: innerGroup.id },
      innerGroup,
      outerGroup,
      ...base.tracks.filter((track) => track.id !== leaf.id),
    ];
    const normalized = normalizeProjectMixerState(tracks, undefined);
    const project = {
      ...base,
      mixer: normalized.mixer,
      selection: { items: [{ id: innerGroup.id, type: 'track' as const }] },
      tracks: normalized.tracks,
    };
    const resolution = resolveMixerEffectsConsole(project);
    const editor = resolveMixerEffectsUiStrip(project);

    expect(resolution.status).toBe('READY');
    if (resolution.status !== 'READY') {
      return;
    }
    const leafStrip = resolution.channels.find((channel) => channel.trackId === leaf.id);
    expect(leafStrip?.groupPath.map((group) => group.name)).toEqual([
      'Outer Group',
      'Inner Group',
    ]);
    expect(resolution.channels.some((channel) => channel.trackId === outerGroup.id)).toBe(false);
    expect(resolution.channels.some((channel) => channel.trackId === innerGroup.id)).toBe(false);
    expect(resolution.selectedGroupProxy).toMatchObject({
      groupTrackId: innerGroup.id,
      targetTrackId: leaf.id,
    });
    expect(editor).toMatchObject({
      proxy: { groupTrackId: innerGroup.id, targetTrackId: leaf.id },
      status: 'READY',
      trackId: leaf.id,
    });
  });

  it('updates an explicit Group proxy deterministically when its bottom eligible child changes', () => {
    const base = createProject();
    const first = base.tracks.find((track) => track.id === 'hum-audio')!;
    const second = base.tracks.find((track) => track.id === 'midi-notes')!;
    const createGroupedProject = (childTrackIds: string[]) => {
      const group: Track = {
        clips: [],
        group: {
          activePlaybackTrackId: childTrackIds[childTrackIds.length - 1] ?? '',
          childTrackIds,
          collapsed: false,
          playbackMode: 'bottom_child',
        },
        id: 'proxy-group',
        level: 0,
        name: 'Proxy Group',
        type: 'group',
      };
      const groupedTracks = childTrackIds.map((trackId) => {
        const sourceTrack = trackId === first.id ? first : second;
        return { ...sourceTrack, parentGroupId: group.id };
      });
      const tracks = [
        ...groupedTracks,
        group,
        ...base.tracks.filter((track) =>
          track.id !== first.id && track.id !== second.id),
      ];
      const normalized = normalizeProjectMixerState(tracks, undefined);
      return {
        ...base,
        mixer: normalized.mixer,
        selection: { items: [{ id: group.id, type: 'track' as const }] },
        tracks: normalized.tracks,
      };
    };

    expect(resolveMixerEffectsUiStrip(
      createGroupedProject([first.id, second.id]),
    )).toMatchObject({ trackId: second.id });
    expect(resolveMixerEffectsUiStrip(
      createGroupedProject([second.id, first.id]),
    )).toMatchObject({ trackId: first.id });
    expect(resolveMixerEffectsUiStrip(
      createGroupedProject([first.id]),
    )).toMatchObject({ trackId: first.id });
    expect(resolveMixerEffectsUiStrip(
      createGroupedProject([first.id, second.id]),
    )).toMatchObject({ trackId: second.id });
  });

  it('reconciles add, reorder, remove, Undo restoration, and exact saved-state reopen without stale retargeting', () => {
    const base = createProject('hum-audio');
    const added: Track = {
      clips: [],
      id: 'new-midi-track',
      level: -6,
      name: 'New MIDI Track',
      type: 'midi',
    };
    const withAdded = reconcileProjectMixerState({
      ...base,
      tracks: [added, ...base.tracks],
    });
    const addedResolution = resolveMixerEffectsConsole(withAdded);
    expect(addedResolution.status).toBe('READY');
    if (addedResolution.status !== 'READY') {
      return;
    }
    expect(addedResolution.channels[0].trackId).toBe(added.id);
    expect(addedResolution.channels.find((channel) => channel.trackId === added.id)?.effects.every(
      (effect) => effect.bypass,
    )).toBe(true);

    const withoutSelected = reconcileProjectMixerState({
      ...withAdded,
      selection: { items: [{ id: added.id, type: 'track' }] },
      tracks: withAdded.tracks.filter((track) => track.id !== added.id),
    });
    const removedResolution = resolveMixerEffectsConsole(withoutSelected);
    expect(removedResolution.status).toBe('READY');
    if (removedResolution.status === 'READY') {
      expect(removedResolution.channels.some((channel) => channel.trackId === added.id)).toBe(false);
      expect(removedResolution.channels.some((channel) => channel.selected)).toBe(false);
    }
    expect(resolveMixerEffectsUiStrip(withoutSelected)).toMatchObject({ status: 'EMPTY' });

    const undoResolution = resolveMixerEffectsConsole(withAdded);
    expect(undoResolution.status).toBe('READY');
    if (undoResolution.status === 'READY') {
      expect(undoResolution.channels[0].trackId).toBe(added.id);
    }

    const reopened = JSON.parse(JSON.stringify(withAdded)) as ProjectState;
    expect(resolveMixerEffectsConsole(reopened)).toEqual(addedResolution);
  });

  it('returns accessible non-destructive empty states for none, multiple, stale, and Group targets', () => {
    const project = createProject();
    expect(resolveMixerEffectsUiStrip(project)).toMatchObject({
      status: 'EMPTY',
      message: expect.stringContaining('Select one Channel'),
    });
    expect(
      resolveMixerEffectsUiStrip({
        ...project,
        selection: {
          items: [
            { id: 'hum-audio', type: 'track' },
            { id: 'midi-notes', type: 'track' },
          ],
        },
      }),
    ).toMatchObject({ status: 'EMPTY' });
    expect(
      resolveMixerEffectsUiStrip({
        ...project,
        selection: { items: [{ id: 'missing', type: 'track' }] },
      }),
    ).toMatchObject({ status: 'EMPTY', message: expect.stringContaining('stale') });

    const group: Track = {
      clips: [],
      group: {
        activePlaybackTrackId: 'hum-audio',
        childTrackIds: ['hum-audio'],
        collapsed: false,
        playbackMode: 'bottom_child',
      },
      id: 'group-1',
      level: -8,
      name: 'Vocals Group',
      type: 'group',
    };
    expect(
      resolveMixerEffectsUiStrip({
        ...project,
        selection: { items: [{ id: group.id, type: 'track' }] },
        tracks: [group, ...project.tracks],
      }),
    ).toMatchObject({
      status: 'EMPTY',
      message: expect.stringContaining('no valid active eligible child'),
    });
  });

  it('builds exact Channel and Master BYPASS commands that create one existing-history edit', () => {
    for (const trackId of ['hum-audio', 'master']) {
      const project = createProject(trackId);
      const strip = resolveMixerEffectsUiStrip(project);
      expect(strip.status).toBe('READY');
      if (strip.status !== 'READY') {
        continue;
      }

      for (const effect of strip.effects) {
        const history = createHistory(project);
        const command = createMixerEffectBypassUiCommand(strip, effect, false);
        const result = executeProjectMixerEffectCommand(history, command, {
          createdAt: '2026-08-11T09:00:00.000Z',
          editId: `ui-bypass-${trackId}-${effect.effectType}`,
          historyLimit: 80,
        });

        expect(result.status).toBe('EXECUTED');
        expect(result.history.past).toHaveLength(1);
        expect(command.target.scope).toBe(strip.scope);
        if (command.target.scope === 'channel') {
          expect(command.target.trackId).toBe(trackId);
        }
      }
    }
  });

  it('builds exact parameter and Reset commands without broad patch payloads', () => {
    const project = createProject('hum-audio');
    const strip = resolveMixerEffectsUiStrip(project);
    expect(strip.status).toBe('READY');
    if (strip.status !== 'READY') {
      return;
    }

    const equalizer = strip.effects[0];
    const parameterCommand = createMixerEffectParameterUiCommand(
      strip,
      equalizer,
      'lowGainDb',
      2.5,
    );
    const resetCommand = createMixerEffectResetUiCommand(strip, equalizer);

    expect(parameterCommand).toEqual({
      parameter: 'lowGainDb',
      target: {
        algorithmId: equalizer.algorithmId,
        algorithmVersion: equalizer.algorithmVersion,
        effectType: equalizer.effectType,
        scope: 'channel',
        trackId: 'hum-audio',
      },
      type: 'set-parameter',
      value: 2.5,
    });
    expect(Object.keys(parameterCommand)).toEqual([
      'parameter',
      'target',
      'type',
      'value',
    ]);
    expect(resetCommand).toEqual({
      target: parameterCommand.target,
      type: 'reset',
    });
  });

  it('accepts valid numeric drafts, preserves no-op semantics, and rejects invalid text without clamping', () => {
    const strip = resolveMixerEffectsUiStrip(createProject('hum-audio'));
    expect(strip.status).toBe('READY');
    if (strip.status !== 'READY') {
      return;
    }
    const effect = strip.effects[0];
    const presentation = getMixerEffectUiPresentation(effect.effectType).parameters[0];

    expect(parseMixerEffectParameterDraft(effect, presentation, '2.5')).toEqual({
      status: 'VALID',
      value: 2.5,
    });
    expect(parseMixerEffectParameterDraft(effect, presentation, '0')).toEqual({
      status: 'NO_OP',
      value: 0,
    });
    expect(parseMixerEffectParameterDraft(effect, presentation, '')).toMatchObject({
      status: 'INVALID',
    });
    expect(parseMixerEffectParameterDraft(effect, presentation, '0x10')).toMatchObject({
      status: 'INVALID',
    });
    expect(parseMixerEffectParameterDraft(effect, presentation, 'Infinity')).toMatchObject({
      status: 'INVALID',
    });
    expect(parseMixerEffectParameterDraft(effect, presentation, '12.01')).toMatchObject({
      status: 'INVALID',
    });
  });

  it('reuses the Equalizer factory to reject invalid cross-parameter frequency ordering', () => {
    const strip = resolveMixerEffectsUiStrip(createProject('hum-audio'));
    expect(strip.status).toBe('READY');
    if (strip.status !== 'READY') {
      return;
    }
    const equalizer = strip.effects[0];
    const lowFrequency = getMixerEffectUiPresentation(
      MIXER_EFFECT_TYPE_EQUALIZER,
    ).parameters.find((parameter) => parameter.name === 'lowFrequencyHz')!;

    expect(
      parseMixerEffectParameterDraft(equalizer, lowFrequency, '1000'),
    ).toMatchObject({ status: 'INVALID' });
  });

  it('steps keyboard edits deterministically with Shift fine control and legal bounds', () => {
    const gain = getMixerEffectUiPresentation(
      MIXER_EFFECT_TYPE_EQUALIZER,
    ).parameters.find((parameter) => parameter.name === 'lowGainDb')!;

    expect(stepMixerEffectParameterValue(0, gain, 'ArrowRight', false)).toBe(0.1);
    expect(stepMixerEffectParameterValue(0, gain, 'ArrowRight', true)).toBe(0.01);
    expect(stepMixerEffectParameterValue(0, gain, 'PageDown', false)).toBe(-1);
    expect(stepMixerEffectParameterValue(0, gain, 'Home', false)).toBe(-12);
    expect(stepMixerEffectParameterValue(0, gain, 'End', false)).toBe(12);
    expect(stepMixerEffectParameterValue(12, gain, 'ArrowRight', false)).toBe(12);
  });

  it('maps exact Channel and Master samples without inventing unavailable zeroes', () => {
    const channelStrip = resolveMixerEffectsUiStrip(createProject('hum-audio'));
    expect(channelStrip.status).toBe('READY');
    if (channelStrip.status !== 'READY') {
      return;
    }
    const snapshot = createMeterSnapshot();

    expect(
      createMixerEffectsUiMeterPresentation(channelStrip, undefined, true),
    ).toEqual({
      message: 'Exact Playback meter unavailable.',
      status: 'UNAVAILABLE',
    });
    expect(
      createMixerEffectsUiMeterPresentation(channelStrip, snapshot, false),
    ).toMatchObject({ status: 'UNAVAILABLE' });

    const available = createMixerEffectsUiMeterPresentation(
      channelStrip,
      snapshot,
      true,
    );
    expect(available.status).toBe('AVAILABLE');
    if (available.status !== 'AVAILABLE') {
      return;
    }
    expect(available.channels.map((channel) => channel.label)).toEqual([
      'Channel',
      'Master',
    ]);
    expect(available.channels[0].meter.left).toEqual({
      clipped: false,
      peak: 1,
    });
    expect(available.channels[0].meter.right).toEqual({
      clipped: true,
      peak: 1.0001,
    });
  });

  it('shows only the exact Master meter for the Master target', () => {
    const strip = resolveMixerEffectsUiStrip(createProject('master'));
    expect(strip.status).toBe('READY');
    if (strip.status !== 'READY') {
      return;
    }
    const presentation = createMixerEffectsUiMeterPresentation(
      strip,
      createMeterSnapshot(),
      true,
    );
    expect(presentation.status).toBe('AVAILABLE');
    if (presentation.status === 'AVAILABLE') {
      expect(presentation.channels.map((channel) => channel.label)).toEqual([
        'Master',
      ]);
    }
  });

  it('keeps exact measurement separate from the visually capped meter fill', () => {
    expect(createMixerMeterBarPresentation(1, false)).toEqual({
      clipped: false,
      fillRatio: 1,
      measurementPeak: 1,
    });
    expect(createMixerMeterBarPresentation(1.25, true)).toEqual({
      clipped: true,
      fillRatio: 1,
      measurementPeak: 1.25,
    });
    expect(() => createMixerMeterBarPresentation(Number.NaN, false)).toThrow();
  });

  it('does not place meter observations in Project serialization or command identity', () => {
    const project = createProject('hum-audio');
    const before = JSON.stringify(project);
    const strip = resolveMixerEffectsUiStrip(project);
    expect(strip.status).toBe('READY');
    if (strip.status !== 'READY') {
      return;
    }

    createMixerEffectsUiMeterPresentation(strip, createMeterSnapshot(), true);
    const command = createMixerEffectBypassUiCommand(strip, strip.effects[0], false);

    expect(JSON.stringify(project)).toBe(before);
    expect(JSON.stringify(project)).not.toContain('meterSummary');
    expect(JSON.stringify(command)).not.toContain('meterSummary');
    expect(JSON.stringify(command)).not.toContain('sessionId');
  });
});

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

function createLargeConsoleProject(channelCount: number): ProjectState {
  const master = sampleProject.tracks.find((track) => track.type === 'master');
  if (!master) {
    throw new Error('Sample Project Master track is required.');
  }
  const tracks: Track[] = [
    ...Array.from({ length: channelCount }, (_, index): Track => ({
      clips: [],
      id: `stress-track-${String(index + 1).padStart(3, '0')}`,
      level: -index / 2,
      name: `Stress Track ${String(index + 1).padStart(3, '0')}`,
      type: index % 2 === 0 ? 'audio' : 'midi',
    })),
    { ...master, clips: master.clips.map((clip) => ({ ...clip })) },
  ];
  const normalization = normalizeProjectMixerState(tracks, undefined);

  return {
    ...sampleProject,
    mixer: normalization.mixer,
    selection: { items: [] },
    tracks: normalization.tracks,
  };
}

function createHistory(project: ProjectState) {
  return createSessionEditHistory(
    { project },
    {
      category: 'system',
      createdAt: '2026-08-11T08:00:00.000Z',
      id: 'open',
      label: 'Open Project',
    },
  );
}

function createMeterSnapshot() {
  const channelAccumulator = accumulateMixerSamplePeakBlock(
    createMixerSamplePeakAccumulator(),
    [1],
    [1.0001],
  );
  const masterAccumulator = accumulateMixerSamplePeakBlock(
    createMixerSamplePeakAccumulator(),
    [0.75],
    [-0.5],
  );

  return Object.freeze({
    cycleSequence: 1,
    frameEnd: 1,
    frameStart: 0,
    meterSummary: createMixerMeterTapSummary(
      [{ accumulator: channelAccumulator, trackId: 'hum-audio' }],
      masterAccumulator,
    ),
    sessionId: 'ui-meter-session',
    version: 1 as const,
  });
}
