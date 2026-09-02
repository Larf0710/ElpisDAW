import {
  MIXER_COMPRESSOR_PARAMETER_SPECS,
  MIXER_ECHO_DELAY_PARAMETER_SPECS,
  MIXER_EFFECT_TYPE_COMPRESSOR,
  MIXER_EFFECT_TYPE_ECHO_DELAY,
  MIXER_EFFECT_TYPE_EQUALIZER,
  MIXER_EFFECT_TYPE_LIMITER,
  MIXER_EQUALIZER_PARAMETER_SPECS,
  MIXER_LIMITER_PARAMETER_SPECS,
  createMixerCompressorEffect,
  createMixerEchoDelayEffect,
  createMixerEqualizerEffect,
  createMixerLimiterEffect,
  type MixerEffectParameterSpec,
  type MixerEffectState,
} from '../shared/mixerEffectsContract.js';
import type { MixerSamplePeakSnapshot } from '../shared/mixerMeterContract.js';
import type {
  ProjectMixerEffectCommand,
  ProjectMixerEffectTarget,
} from './projectMixerEffectsCommand';
import type { ProjectPlaybackRuntimeMeterSnapshot } from './projectPlaybackAudioWorkletRuntime';
import { isMixerEligibleTrack } from './projectMixerState';
import { isGroupTrack, resolveGroupPlaybackTrack } from './playbackTarget';
import type { ProjectState, Track } from './types';

export const MIXER_EFFECTS_UI_PRESENTATION_VERSION = 1 as const;

export type MixerEffectUiParameterPresentation = Readonly<{
  decimals: number;
  fineStep: number;
  group: string;
  label: string;
  name: string;
  spec: MixerEffectParameterSpec;
  step: number;
  unit: '' | 'dB' | 'Hz' | 'ms' | 'x';
}>;

export type MixerEffectUiPresentation = Readonly<{
  effectType: MixerEffectState['effectType'];
  label: string;
  parameters: readonly MixerEffectUiParameterPresentation[];
  shortLabel: string;
}>;

export type MixerEffectsUiReadyStrip = Readonly<{
  effects: readonly MixerEffectState[];
  key: string;
  name: string;
  proxy?: Readonly<{
    groupName: string;
    groupTrackId: string;
    targetName: string;
    targetTrackId: string;
  }>;
  scope: 'channel' | 'master';
  status: 'READY';
  track?: Track;
  trackId?: string;
}>;

export type MixerEffectsUiStripResolution =
  | MixerEffectsUiReadyStrip
  | Readonly<{
      key: string;
      message: string;
      status: 'EMPTY';
    }>;

export type MixerEffectsUiMeterChannel = Readonly<{
  label: 'Channel' | 'Master';
  meter: MixerSamplePeakSnapshot;
}>;

export type MixerEffectsUiMeterPresentation =
  | Readonly<{
      channels: readonly MixerEffectsUiMeterChannel[];
      source: 'exact-runtime';
      status: 'AVAILABLE';
    }>
  | Readonly<{
      message: string;
      status: 'UNAVAILABLE';
    }>;

export type MixerMeterBarPresentation = Readonly<{
  clipped: boolean;
  fillRatio: number;
  measurementPeak: number;
}>;

export type MixerEffectsConsoleChannelStrip = Readonly<{
  audibility: 'AUDIBLE' | 'MUTED' | 'SOLO_EXCLUDED';
  effects: readonly MixerEffectState[];
  faderDb: number;
  groupPath: readonly Readonly<{ id: string; name: string }>[];
  key: string;
  muted: boolean;
  name: string;
  sourceStatus: 'AVAILABLE' | 'SOURCE_OFFLINE';
  pan: number;
  scope: 'channel';
  selected: boolean;
  solo: boolean;
  trackId: string;
}>;

export type MixerEffectsConsoleMasterStrip = Readonly<{
  effects: readonly MixerEffectState[];
  faderDb: number;
  key: 'master';
  name: string;
  scope: 'master';
  selected: boolean;
  trackId?: string;
}>;

export type MixerEffectsConsoleResolution =
  | Readonly<{
      channels: readonly MixerEffectsConsoleChannelStrip[];
      master: MixerEffectsConsoleMasterStrip;
      selectedGroupProxy?: Readonly<{
        groupName: string;
        groupTrackId: string;
        targetName: string;
        targetTrackId: string;
      }>;
      status: 'READY';
    }>
  | Readonly<{
      message: string;
      status: 'UNAVAILABLE';
    }>;

export type MixerEffectParameterDraftResult =
  | Readonly<{ status: 'INVALID'; message: string }>
  | Readonly<{ status: 'NO_OP'; value: number }>
  | Readonly<{ status: 'VALID'; value: number }>;

const parameter = (
  name: string,
  label: string,
  group: string,
  unit: MixerEffectUiParameterPresentation['unit'],
  step: number,
  fineStep: number,
  decimals: number,
  spec: MixerEffectParameterSpec,
): MixerEffectUiParameterPresentation =>
  Object.freeze({ decimals, fineStep, group, label, name, spec, step, unit });

export const MIXER_EFFECT_UI_PRESENTATIONS: readonly MixerEffectUiPresentation[] =
  Object.freeze([
    Object.freeze({
      effectType: MIXER_EFFECT_TYPE_EQUALIZER,
      label: 'Equalizer',
      shortLabel: 'EQ',
      parameters: Object.freeze([
        parameter('lowGainDb', 'Low Gain', 'Low Shelf', 'dB', 0.1, 0.01, 2, MIXER_EQUALIZER_PARAMETER_SPECS.lowGainDb),
        parameter('lowFrequencyHz', 'Low Frequency', 'Low Shelf', 'Hz', 1, 0.1, 1, MIXER_EQUALIZER_PARAMETER_SPECS.lowFrequencyHz),
        parameter('midGainDb', 'Mid Gain', 'Mid Peak', 'dB', 0.1, 0.01, 2, MIXER_EQUALIZER_PARAMETER_SPECS.midGainDb),
        parameter('midFrequencyHz', 'Mid Frequency', 'Mid Peak', 'Hz', 1, 0.1, 1, MIXER_EQUALIZER_PARAMETER_SPECS.midFrequencyHz),
        parameter('midQ', 'Mid Q', 'Mid Peak', '', 0.01, 0.001, 3, MIXER_EQUALIZER_PARAMETER_SPECS.midQ),
        parameter('highGainDb', 'High Gain', 'High Shelf', 'dB', 0.1, 0.01, 2, MIXER_EQUALIZER_PARAMETER_SPECS.highGainDb),
        parameter('highFrequencyHz', 'High Frequency', 'High Shelf', 'Hz', 1, 0.1, 1, MIXER_EQUALIZER_PARAMETER_SPECS.highFrequencyHz),
      ]),
    }),
    Object.freeze({
      effectType: MIXER_EFFECT_TYPE_COMPRESSOR,
      label: 'Compressor',
      shortLabel: 'COMP',
      parameters: Object.freeze([
        parameter('thresholdDb', 'Threshold', 'Level', 'dB', 0.1, 0.01, 2, MIXER_COMPRESSOR_PARAMETER_SPECS.thresholdDb),
        parameter('ratio', 'Ratio', 'Level', 'x', 0.1, 0.01, 2, MIXER_COMPRESSOR_PARAMETER_SPECS.ratio),
        parameter('kneeDb', 'Knee', 'Level', 'dB', 0.1, 0.01, 2, MIXER_COMPRESSOR_PARAMETER_SPECS.kneeDb),
        parameter('attackMs', 'Attack', 'Timing', 'ms', 0.1, 0.01, 2, MIXER_COMPRESSOR_PARAMETER_SPECS.attackMs),
        parameter('releaseMs', 'Release', 'Timing', 'ms', 1, 0.1, 1, MIXER_COMPRESSOR_PARAMETER_SPECS.releaseMs),
        parameter('makeupGainDb', 'Makeup Gain', 'Output', 'dB', 0.1, 0.01, 2, MIXER_COMPRESSOR_PARAMETER_SPECS.makeupGainDb),
      ]),
    }),
    Object.freeze({
      effectType: MIXER_EFFECT_TYPE_ECHO_DELAY,
      label: 'Echo / Delay',
      shortLabel: 'DELAY',
      parameters: Object.freeze([
        parameter('delayTimeMs', 'Delay Time', 'Time', 'ms', 1, 0.1, 1, MIXER_ECHO_DELAY_PARAMETER_SPECS.delayTimeMs),
        parameter('feedback', 'Feedback', 'Repeats', '', 0.01, 0.001, 3, MIXER_ECHO_DELAY_PARAMETER_SPECS.feedback),
        parameter('wet', 'Wet', 'Mix', '', 0.01, 0.001, 3, MIXER_ECHO_DELAY_PARAMETER_SPECS.wet),
        parameter('dry', 'Dry', 'Mix', '', 0.01, 0.001, 3, MIXER_ECHO_DELAY_PARAMETER_SPECS.dry),
      ]),
    }),
    Object.freeze({
      effectType: MIXER_EFFECT_TYPE_LIMITER,
      label: 'Limiter',
      shortLabel: 'LIMITER',
      parameters: Object.freeze([
        parameter('ceilingDb', 'Ceiling', 'Output', 'dB', 0.1, 0.01, 2, MIXER_LIMITER_PARAMETER_SPECS.ceilingDb),
        parameter('releaseMs', 'Release', 'Timing', 'ms', 1, 0.1, 1, MIXER_LIMITER_PARAMETER_SPECS.releaseMs),
      ]),
    }),
  ]);

export function getMixerEffectUiPresentation(
  effectType: MixerEffectState['effectType'],
): MixerEffectUiPresentation {
  const presentation = MIXER_EFFECT_UI_PRESENTATIONS.find(
    (candidate) => candidate.effectType === effectType,
  );

  if (!presentation) {
    throw new TypeError(`Mixer Effect presentation is unavailable for ${effectType}.`);
  }

  return presentation;
}

export function resolveMixerEffectsConsole(
  project: ProjectState,
): MixerEffectsConsoleResolution {
  if (!project.mixer || project.mixer.schemaVersion !== 2) {
    return Object.freeze({
      message: 'Mixer Console is unavailable because the Project Mixer state is invalid.',
      status: 'UNAVAILABLE' as const,
    });
  }

  const selectedTrack = resolveSingleSelectedMixerTrack(project);
  const selectedTrackId = selectedTrack?.id;
  const selectedGroupResolution = selectedTrack && isGroupTrack(selectedTrack)
    ? resolveGroupPlaybackTrack(selectedTrack, project.tracks)
    : undefined;
  const selectedChannelTrackId = selectedGroupResolution?.canResolve
    ? selectedGroupResolution.activeTrack.id
    : selectedTrackId;
  const channelsByTrackId = new Map(
    project.mixer.channels.map((channel) => [channel.trackId, channel]),
  );
  const channelTracks = project.tracks.filter(
    (track) => isMixerEligibleTrack(track) && track.type !== 'master',
  );
  const masterTracks = project.tracks.filter(
    (track) => isMixerEligibleTrack(track) && track.type === 'master',
  );
  const anyChannelSoloed = project.mixer.channels.some((channel) => channel.solo);

  if (masterTracks.length > 1) {
    return Object.freeze({
      message: 'Mixer Console requires one unambiguous Master track.',
      status: 'UNAVAILABLE' as const,
    });
  }

  const channels: MixerEffectsConsoleChannelStrip[] = [];

  for (const track of channelTracks) {
    const channel = channelsByTrackId.get(track.id);

    if (!channel) {
      return Object.freeze({
        message: `Mixer Console Channel is missing for ${track.name}.`,
        status: 'UNAVAILABLE' as const,
      });
    }

    channels.push(
      Object.freeze({
        effects: channel.inserts,
        audibility: channel.muted
          ? 'MUTED' as const
          : anyChannelSoloed && !channel.solo
            ? 'SOLO_EXCLUDED' as const
            : 'AUDIBLE' as const,
        faderDb: channel.faderDb,
        groupPath: createMixerConsoleGroupPath(track, project.tracks),
        key: `channel:${track.id}`,
        muted: channel.muted,
        name: track.name,
        pan: channel.pan,
        scope: 'channel' as const,
        selected: selectedChannelTrackId === track.id,
        solo: channel.solo,
        sourceStatus: hasOfflineTrackSource(track)
          ? 'SOURCE_OFFLINE' as const
          : 'AVAILABLE' as const,
        trackId: track.id,
      }),
    );
  }

  const masterTrack = masterTracks[0];

  return Object.freeze({
    channels: Object.freeze(channels),
    master: Object.freeze({
      effects: project.mixer.master.inserts,
      faderDb: project.mixer.master.faderDb,
      key: 'master' as const,
      name: masterTrack?.name || 'Master',
      scope: 'master' as const,
      selected: masterTrack ? selectedTrackId === masterTrack.id : false,
      trackId: masterTrack?.id,
    }),
    selectedGroupProxy: selectedTrack && selectedGroupResolution?.canResolve
      ? Object.freeze({
          groupName: selectedTrack.name,
          groupTrackId: selectedTrack.id,
          targetName: selectedGroupResolution.activeTrack.name,
          targetTrackId: selectedGroupResolution.activeTrack.id,
        })
      : undefined,
    status: 'READY' as const,
  });
}

export function formatMixerConsoleFaderValue(faderDb: number): string {
  if (!Number.isFinite(faderDb)) {
    throw new TypeError('Mixer Console Fader display requires a finite value.');
  }

  return `${faderDb.toFixed(1)} dB`;
}

export function formatMixerConsolePanValue(pan: number): string {
  if (!Number.isFinite(pan) || pan < -1 || pan > 1) {
    throw new TypeError('Mixer Console Pan display requires a value in [-1, 1].');
  }

  if (Object.is(pan, 0) || Math.abs(pan) < 0.0005) {
    return 'C';
  }

  return `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`;
}

export function resolveMixerEffectsUiStrip(
  project: ProjectState,
): MixerEffectsUiStripResolution {
  const selection =
    project.selection.items.length === 1
      ? project.selection.items[0]
      : undefined;
  if (
    selection?.type === 'track' &&
    !project.tracks.some((track) => track.id === selection.id)
  ) {
    return Object.freeze({
      key: `stale:${selection.id}`,
      message: 'The selected Mixer target is stale. Select an available Track.',
      status: 'EMPTY' as const,
    });
  }

  const track = resolveSingleSelectedMixerTrack(project);

  if (!track) {
    return Object.freeze({
      key: 'empty-selection',
      message:
        'Select one Channel or the Master track to edit its fixed Insert chain; one MIDI Clip also opens its Channel.',
      status: 'EMPTY' as const,
    });
  }

  if (!project.mixer || project.mixer.schemaVersion !== 2) {
    return Object.freeze({
      key: `mixer-unavailable:${track.id}`,
      message: 'Mixer Effects are unavailable because the Project Mixer state is invalid.',
      status: 'EMPTY' as const,
    });
  }

  if (track.type === 'master') {
    return Object.freeze({
      effects: project.mixer.master.inserts,
      key: 'master',
      name: track.name || 'Master',
      scope: 'master' as const,
      status: 'READY' as const,
      track,
    });
  }

  let targetTrack = track;
  let proxy: MixerEffectsUiReadyStrip['proxy'];

  if (isGroupTrack(track)) {
    const resolution = resolveGroupPlaybackTrack(track, project.tracks);

    if (!resolution.canResolve) {
      return Object.freeze({
        key: `group-unavailable:${track.id}`,
        message: `${track.name} has no valid active eligible child Channel.`,
        status: 'EMPTY' as const,
      });
    }

    targetTrack = resolution.activeTrack;
    proxy = Object.freeze({
      groupName: track.name,
      groupTrackId: track.id,
      targetName: targetTrack.name,
      targetTrackId: targetTrack.id,
    });
  }

  const matchingChannels = project.mixer.channels.filter(
    (channel) => channel.trackId === targetTrack.id,
  );

  if (matchingChannels.length !== 1) {
    return Object.freeze({
      key: `channel-unavailable:${targetTrack.id}`,
      message: 'The selected Channel does not have one valid Mixer strip.',
      status: 'EMPTY' as const,
    });
  }

  return Object.freeze({
    effects: matchingChannels[0].inserts,
    key: proxy
      ? `group-proxy:${proxy.groupTrackId}:${targetTrack.id}`
      : `channel:${targetTrack.id}`,
    name: targetTrack.name,
    proxy,
    scope: 'channel' as const,
    status: 'READY' as const,
    track: targetTrack,
    trackId: targetTrack.id,
  });
}

function resolveSingleSelectedMixerTrack(project: ProjectState): Track | undefined {
  if (project.selection.items.length !== 1) {
    return undefined;
  }

  const selection = project.selection.items[0];

  if (selection.type === 'track') {
    return project.tracks.find((track) => track.id === selection.id);
  }

  const matches = project.tracks.filter((track) =>
    track.clips.some((clip) => clip.id === selection.id),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function createMixerConsoleGroupPath(
  track: Track,
  tracks: readonly Track[],
): readonly Readonly<{ id: string; name: string }>[] {
  const tracksById = new Map(tracks.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>([track.id]);
  const path: Readonly<{ id: string; name: string }>[] = [];
  let parentGroupId = track.parentGroupId ?? undefined;

  while (parentGroupId) {
    if (visited.has(parentGroupId)) {
      break;
    }
    visited.add(parentGroupId);
    const parent = tracksById.get(parentGroupId);

    if (!parent || !isGroupTrack(parent)) {
      break;
    }

    path.unshift(Object.freeze({ id: parent.id, name: parent.name }));
    parentGroupId = parent.parentGroupId ?? undefined;
  }

  return Object.freeze(path);
}

function hasOfflineTrackSource(track: Track): boolean {
  return track.clips.some(
    (clip) => clip.sourceFile && clip.sourceFile.status !== 'available',
  );
}

export function createMixerEffectUiTarget(
  strip: MixerEffectsUiReadyStrip,
  effect: MixerEffectState,
): ProjectMixerEffectTarget {
  const identity = {
    algorithmId: effect.algorithmId,
    algorithmVersion: effect.algorithmVersion,
    effectType: effect.effectType,
  };

  return strip.scope === 'channel'
    ? Object.freeze({ ...identity, scope: 'channel' as const, trackId: strip.trackId! }) as ProjectMixerEffectTarget
    : Object.freeze({ ...identity, scope: 'master' as const }) as ProjectMixerEffectTarget;
}

export function createMixerEffectBypassUiCommand(
  strip: MixerEffectsUiReadyStrip,
  effect: MixerEffectState,
  bypass: boolean,
): ProjectMixerEffectCommand {
  return Object.freeze({
    bypass,
    target: createMixerEffectUiTarget(strip, effect),
    type: 'set-bypass' as const,
  });
}

export function createMixerEffectResetUiCommand(
  strip: MixerEffectsUiReadyStrip,
  effect: MixerEffectState,
): ProjectMixerEffectCommand {
  return Object.freeze({
    target: createMixerEffectUiTarget(strip, effect),
    type: 'reset' as const,
  });
}

export function createMixerEffectParameterUiCommand(
  strip: MixerEffectsUiReadyStrip,
  effect: MixerEffectState,
  parameterName: string,
  value: number,
): ProjectMixerEffectCommand {
  const target = createMixerEffectUiTarget(strip, effect);

  switch (effect.effectType) {
    case MIXER_EFFECT_TYPE_EQUALIZER:
      return Object.freeze({
        parameter: parameterName as keyof typeof effect.parameters,
        target: target as Extract<typeof target, { effectType: 'equalizer' }>,
        type: 'set-parameter' as const,
        value,
      });
    case MIXER_EFFECT_TYPE_COMPRESSOR:
      return Object.freeze({
        parameter: parameterName as keyof typeof effect.parameters,
        target: target as Extract<typeof target, { effectType: 'compressor' }>,
        type: 'set-parameter' as const,
        value,
      });
    case MIXER_EFFECT_TYPE_ECHO_DELAY:
      return Object.freeze({
        parameter: parameterName as keyof typeof effect.parameters,
        target: target as Extract<typeof target, { effectType: 'echo-delay' }>,
        type: 'set-parameter' as const,
        value,
      });
    case MIXER_EFFECT_TYPE_LIMITER:
      return Object.freeze({
        parameter: parameterName as keyof typeof effect.parameters,
        target: target as Extract<typeof target, { effectType: 'limiter' }>,
        type: 'set-parameter' as const,
        value,
      });
  }
}

export function parseMixerEffectParameterDraft(
  effect: MixerEffectState,
  presentation: MixerEffectUiParameterPresentation,
  text: string,
): MixerEffectParameterDraftResult {
  const trimmed = text.trim();

  if (
    !trimmed ||
    !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)
  ) {
    return Object.freeze({
      message: `${presentation.label} requires a finite numeric value.`,
      status: 'INVALID' as const,
    });
  }

  const value = Number(trimmed);

  if (!Number.isFinite(value)) {
    return Object.freeze({
      message: `${presentation.label} requires a finite numeric value.`,
      status: 'INVALID' as const,
    });
  }

  try {
    validateEffectParameterValue(effect, presentation.name, value);
  } catch {
    return Object.freeze({
      message: `${presentation.label} is invalid for the current ${getMixerEffectUiPresentation(effect.effectType).label} settings.`,
      status: 'INVALID' as const,
    });
  }

  const currentValue = effect.parameters[
    presentation.name as keyof typeof effect.parameters
  ];

  return Object.freeze({
    status: currentValue === value ? 'NO_OP' as const : 'VALID' as const,
    value,
  });
}

export function formatMixerEffectParameterValue(
  value: number,
  presentation: MixerEffectUiParameterPresentation,
): string {
  return value.toFixed(presentation.decimals);
}

export function stepMixerEffectParameterValue(
  currentValue: number,
  presentation: MixerEffectUiParameterPresentation,
  key: string,
  fine: boolean,
): number {
  if (!Number.isFinite(currentValue)) {
    throw new TypeError('Mixer Effect keyboard editing requires a finite value.');
  }

  if (key === 'Home') {
    return presentation.spec.minimum;
  }

  if (key === 'End') {
    return presentation.spec.maximum;
  }

  const direction =
    key === 'ArrowDown' || key === 'ArrowLeft' || key === 'PageDown'
      ? -1
      : key === 'ArrowUp' || key === 'ArrowRight' || key === 'PageUp'
        ? 1
        : 0;

  if (direction === 0) {
    return currentValue;
  }

  const multiplier = key === 'PageDown' || key === 'PageUp' ? 10 : 1;
  const step = fine ? presentation.fineStep : presentation.step;
  const precision = Math.max(presentation.decimals + (fine ? 1 : 0), 6);
  const scale = 10 ** precision;
  const stepped = Math.round(
    (currentValue + direction * step * multiplier) * scale,
  ) / scale;

  return Math.min(
    presentation.spec.maximum,
    Math.max(presentation.spec.minimum, stepped),
  );
}

export function createMixerEffectsUiMeterPresentation(
  strip: MixerEffectsUiReadyStrip,
  snapshot: ProjectPlaybackRuntimeMeterSnapshot | undefined,
  playbackActive: boolean,
): MixerEffectsUiMeterPresentation {
  if (!playbackActive || !snapshot) {
    return Object.freeze({
      message: 'Exact Playback meter unavailable.',
      status: 'UNAVAILABLE' as const,
    });
  }

  if (strip.scope === 'master') {
    return Object.freeze({
      channels: Object.freeze([
        Object.freeze({ label: 'Master' as const, meter: snapshot.meterSummary.master }),
      ]),
      source: 'exact-runtime' as const,
      status: 'AVAILABLE' as const,
    });
  }

  const channelMatches = snapshot.meterSummary.channels.filter(
    (channel) => channel.trackId === strip.trackId,
  );

  if (channelMatches.length !== 1) {
    return Object.freeze({
      message: 'Exact meter data is unavailable for the selected Channel.',
      status: 'UNAVAILABLE' as const,
    });
  }

  return Object.freeze({
    channels: Object.freeze([
      Object.freeze({ label: 'Channel' as const, meter: channelMatches[0].meter }),
      Object.freeze({ label: 'Master' as const, meter: snapshot.meterSummary.master }),
    ]),
    source: 'exact-runtime' as const,
    status: 'AVAILABLE' as const,
  });
}

export function createMixerMeterBarPresentation(
  peak: number,
  clipped: boolean,
): MixerMeterBarPresentation {
  if (!Number.isFinite(peak) || peak < 0 || typeof clipped !== 'boolean') {
    throw new TypeError('Mixer meter presentation requires one finite absolute peak.');
  }

  return Object.freeze({
    clipped,
    fillRatio: Math.min(1, peak),
    measurementPeak: peak,
  });
}

function validateEffectParameterValue(
  effect: MixerEffectState,
  parameterName: string,
  value: number,
): void {
  if (!Object.prototype.hasOwnProperty.call(effect.parameters, parameterName)) {
    throw new TypeError('Mixer Effect parameter is unsupported.');
  }

  const parameters = { ...effect.parameters, [parameterName]: value };

  switch (effect.effectType) {
    case MIXER_EFFECT_TYPE_EQUALIZER:
      createMixerEqualizerEffect(
        parameters as unknown as typeof effect.parameters,
        effect.bypass,
      );
      return;
    case MIXER_EFFECT_TYPE_COMPRESSOR:
      createMixerCompressorEffect(
        parameters as unknown as typeof effect.parameters,
        effect.bypass,
      );
      return;
    case MIXER_EFFECT_TYPE_ECHO_DELAY:
      createMixerEchoDelayEffect(
        parameters as unknown as typeof effect.parameters,
        effect.bypass,
      );
      return;
    case MIXER_EFFECT_TYPE_LIMITER:
      createMixerLimiterEffect(
        parameters as unknown as typeof effect.parameters,
        effect.bypass,
      );
  }
}
