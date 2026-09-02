import {
  MIXER_EFFECT_TYPE_COMPRESSOR,
  MIXER_EFFECT_TYPE_ECHO_DELAY,
  MIXER_EFFECT_TYPE_EQUALIZER,
  MIXER_EFFECT_TYPE_LIMITER,
  createDefaultMixerCompressorEffect,
  createDefaultMixerEchoDelayEffect,
  createDefaultMixerEqualizerEffect,
  createDefaultMixerLimiterEffect,
  createMixerEffectSnapshot,
  type MixerCompressorEffect,
  type MixerEchoDelayEffect,
  type MixerEffectState,
  type MixerEqualizerEffect,
  type MixerLimiterEffect,
} from '../shared/mixerEffectsContract.js';
import type {
  MixerChannelInsertChainV2,
  MixerChannelStateV1,
  MixerChannelStateV2,
  MixerMasterInsertChainV2,
  ProjectMixerState,
  ProjectMixerStateV1,
  ProjectMixerStateV2,
  ProjectState,
  Track,
} from './types';
import { isGroupTrack, resolveGroupPlaybackTrack } from './playbackTarget';

export const PROJECT_MIXER_STATE_VERSION_V1 = 1 as const;
export const PROJECT_MIXER_STATE_VERSION = 2 as const;
export const PROJECT_MIXER_MASTER_BUS_ID = 'stereo-master' as const;

export type ProjectMixerStateErrorCode =
  | 'MIXER_STATE_INVALID'
  | 'MIXER_STATE_VERSION_UNSUPPORTED';

export class ProjectMixerStateError extends Error {
  readonly code: ProjectMixerStateErrorCode;

  constructor(code: ProjectMixerStateErrorCode, message: string) {
    super(message);
    this.name = 'ProjectMixerStateError';
    this.code = code;
  }
}

export type ProjectMixerStateNormalizationMetadata = Readonly<{
  migrated: boolean;
  source: 'legacy-no-mixer' | 'mixer-state-v1' | 'mixer-state-v2';
}>;

export type ProjectMixerStateNormalization = Readonly<{
  metadata: ProjectMixerStateNormalizationMetadata;
  mixer: ProjectMixerStateV2;
  tracks: Track[];
}>;

export function normalizeProjectMixerState(
  tracks: readonly Track[],
  value: unknown,
): ProjectMixerStateNormalization {
  assertUniqueTrackIds(tracks);

  const normalized = normalizeMixerValue(tracks, value);

  return Object.freeze({
    metadata: normalized.metadata,
    mixer: normalized.mixer,
    tracks: synchronizeLegacyTrackMixFields(tracks, normalized.mixer),
  });
}

export function reconcileProjectMixerState(project: ProjectState): ProjectState {
  assertUniqueTrackIds(project.tracks);

  if (project.mixer === undefined) {
    const normalization = normalizeProjectMixerState(project.tracks, undefined);

    return {
      ...project,
      mixer: normalization.mixer,
      tracks: normalization.tracks,
    };
  }

  const currentMixer = parseProjectMixerStateV2Shape(project.mixer);
  const currentChannels = new Map(
    currentMixer.channels.map((channel) => [channel.trackId, channel]),
  );
  const channels = Object.freeze(
    project.tracks.filter(isMixerEligibleTrack).map(
      (track) => currentChannels.get(track.id) ?? createDefaultMixerChannel(track),
    ),
  );
  const mixer = freezeMixerState(channels, currentMixer.master);

  return {
    ...project,
    mixer,
    tracks: synchronizeLegacyTrackMixFields(project.tracks, mixer),
  };
}

/** Group containers proxy their active child and never own persistent Mixer Channels. */
export function isMixerEligibleTrack(track: Track): boolean {
  return !isGroupTrack(track);
}

export function createDefaultMixerChannelInsertChain(): MixerChannelInsertChainV2 {
  return Object.freeze([
    createDefaultMixerEqualizerEffect(),
    createDefaultMixerCompressorEffect(),
    createDefaultMixerEchoDelayEffect(),
  ]);
}

export function createDefaultMixerMasterInsertChain(): MixerMasterInsertChainV2 {
  return Object.freeze([
    createDefaultMixerEqualizerEffect(),
    createDefaultMixerCompressorEffect(),
    createDefaultMixerLimiterEffect(),
  ]);
}

export function setProjectMixerChannelMuted(
  project: ProjectState,
  trackId: string,
  muted: boolean,
): ProjectState {
  const normalizedProject = reconcileProjectMixerState(project);
  const mixer = normalizedProject.mixer;

  if (!mixer) {
    throw new ProjectMixerStateError(
      'MIXER_STATE_INVALID',
      'Mixer state could not be established.',
    );
  }

  let found = false;
  const channels = Object.freeze(
    mixer.channels.map((channel) => {
      if (channel.trackId !== trackId) {
        return channel;
      }

      found = true;
      return channel.muted === muted
        ? channel
        : Object.freeze({ ...channel, muted });
    }),
  );

  if (!found) {
    throw new ProjectMixerStateError(
      'MIXER_STATE_INVALID',
      `Mixer Channel is missing for Track ${trackId}.`,
    );
  }

  const nextMixer = freezeMixerState(channels, mixer.master);

  return {
    ...normalizedProject,
    mixer: nextMixer,
    tracks: synchronizeLegacyTrackMixFields(normalizedProject.tracks, nextMixer),
  };
}

export function toggleProjectMixerChannelMute(
  project: ProjectState,
  trackId: string,
): ProjectState {
  const normalizedProject = reconcileProjectMixerState(project);
  const channel = normalizedProject.mixer?.channels.find(
    (candidate) => candidate.trackId === trackId,
  );

  if (!channel) {
    throw new ProjectMixerStateError(
      'MIXER_STATE_INVALID',
      `Mixer Channel is missing for Track ${trackId}.`,
    );
  }

  return setProjectMixerChannelMuted(normalizedProject, trackId, !channel.muted);
}

function normalizeMixerValue(
  tracks: readonly Track[],
  value: unknown,
): Readonly<{
  metadata: ProjectMixerStateNormalizationMetadata;
  mixer: ProjectMixerStateV2;
}> {
  if (value === undefined) {
    return Object.freeze({
      metadata: Object.freeze({
        migrated: true,
        source: 'legacy-no-mixer' as const,
      }),
      mixer: createDefaultMixerState(tracks),
    });
  }

  if (!isRecord(value)) {
    throw invalidMixerState('Mixer state must be an object.');
  }

  if (value.schemaVersion === PROJECT_MIXER_STATE_VERSION_V1) {
    const legacyMixer = migrateR61GeneratedGroupChannels(
      tracks,
      parseProjectMixerStateV1Shape(value),
    );

    return Object.freeze({
      metadata: Object.freeze({
        migrated: true,
        source: 'mixer-state-v1' as const,
      }),
      mixer: migrateProjectMixerStateV1(legacyMixer),
    });
  }

  if (value.schemaVersion === PROJECT_MIXER_STATE_VERSION) {
    const mixer = parseProjectMixerStateV2Shape(value);
    assertExactV2TrackCoverage(tracks, mixer);

    return Object.freeze({
      metadata: Object.freeze({
        migrated: false,
        source: 'mixer-state-v2' as const,
      }),
      mixer,
    });
  }

  throw new ProjectMixerStateError(
    'MIXER_STATE_VERSION_UNSUPPORTED',
    'Mixer state version is not supported.',
  );
}

function createDefaultMixerState(tracks: readonly Track[]): ProjectMixerStateV2 {
  return freezeMixerState(
    Object.freeze(
      tracks.filter(isMixerEligibleTrack).map(createDefaultMixerChannel),
    ),
    Object.freeze({
      busId: PROJECT_MIXER_MASTER_BUS_ID,
      faderDb: 0,
      inserts: createDefaultMixerMasterInsertChain(),
    }),
  );
}

function createDefaultMixerChannel(track: Track): MixerChannelStateV2 {
  return Object.freeze({
    trackId: track.id,
    faderDb: Number.isFinite(track.level) ? track.level : 0,
    pan: 0,
    muted: track.muted === true,
    solo: false,
    inserts: createDefaultMixerChannelInsertChain(),
    outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
  });
}

function migrateProjectMixerStateV1(
  mixer: ProjectMixerStateV1,
): ProjectMixerStateV2 {
  const channels = Object.freeze(
    mixer.channels.map((channel) =>
      Object.freeze({
        ...channel,
        inserts: createDefaultMixerChannelInsertChain(),
      }),
    ),
  );
  const master = Object.freeze({
    ...mixer.master,
    inserts: createDefaultMixerMasterInsertChain(),
  });

  return freezeMixerState(channels, master);
}

function migrateR61GeneratedGroupChannels(
  tracks: readonly Track[],
  mixer: ProjectMixerStateV1,
): ProjectMixerStateV1 {
  const trackById = new Map(tracks.map((track) => [track.id, track]));

  if (mixer.channels.some((channel) => !trackById.has(channel.trackId))) {
    throw invalidMixerState('Mixer state contains a Channel for an unknown Track.');
  }

  const eligibleTracks = tracks.filter(isMixerEligibleTrack);
  const channelByTrackId = new Map(
    mixer.channels.map((channel) => [channel.trackId, channel]),
  );

  for (const track of eligibleTracks) {
    if (!channelByTrackId.has(track.id)) {
      throw invalidMixerState(`Mixer Channel is missing for Track ${track.id}.`);
    }
  }

  const eligibleChannels = mixer.channels.filter((channel) =>
    isMixerEligibleTrack(trackById.get(channel.trackId)!),
  );

  if (eligibleChannels.length !== eligibleTracks.length) {
    throw invalidMixerState(
      'Mixer state must contain exactly one Channel for every Mixer-eligible Project Track.',
    );
  }

  return Object.freeze({
    ...mixer,
    channels: Object.freeze(
      eligibleTracks.map((track) => channelByTrackId.get(track.id)!),
    ),
  });
}

function assertExactV2TrackCoverage(
  tracks: readonly Track[],
  mixer: ProjectMixerStateV2,
): void {
  const eligibleTrackIds = tracks
    .filter(isMixerEligibleTrack)
    .map((track) => track.id);
  const trackById = new Map(tracks.map((track) => [track.id, track]));

  for (const channel of mixer.channels) {
    const track = trackById.get(channel.trackId);

    if (!track) {
      throw invalidMixerState('Mixer state contains a Channel for an unknown Track.');
    }

    if (!isMixerEligibleTrack(track)) {
      throw invalidMixerState('Mixer State v2 cannot persist a Group Channel.');
    }
  }

  if (
    mixer.channels.length !== eligibleTrackIds.length ||
    mixer.channels.some(
      (channel, index) => channel.trackId !== eligibleTrackIds[index],
    )
  ) {
    throw invalidMixerState(
      'Mixer State v2 Channels must match Mixer-eligible Project Track order exactly.',
    );
  }
}

function parseProjectMixerStateV1Shape(value: unknown): ProjectMixerStateV1 {
  if (!isRecord(value)) {
    throw invalidMixerState('Mixer state must be an object.');
  }

  if (value.schemaVersion !== PROJECT_MIXER_STATE_VERSION_V1) {
    throw new ProjectMixerStateError(
      'MIXER_STATE_VERSION_UNSUPPORTED',
      'Mixer state version is not supported.',
    );
  }

  assertExactKeys(value, ['schemaVersion', 'channels', 'master'], 'Mixer state');

  if (!Array.isArray(value.channels)) {
    throw invalidMixerState('Mixer Channels must be an array.');
  }

  const channels = Object.freeze(value.channels.map(parseMixerChannelV1));
  assertUniqueChannelTrackIds(channels);

  return Object.freeze({
    schemaVersion: PROJECT_MIXER_STATE_VERSION_V1,
    channels,
    master: parseMasterStateV1(value.master),
  });
}

function parseProjectMixerStateV2Shape(value: unknown): ProjectMixerStateV2 {
  if (!isRecord(value)) {
    throw invalidMixerState('Mixer state must be an object.');
  }

  if (value.schemaVersion !== PROJECT_MIXER_STATE_VERSION) {
    throw new ProjectMixerStateError(
      'MIXER_STATE_VERSION_UNSUPPORTED',
      'Mixer state version is not supported.',
    );
  }

  assertExactKeys(value, ['schemaVersion', 'channels', 'master'], 'Mixer state');

  if (!Array.isArray(value.channels)) {
    throw invalidMixerState('Mixer Channels must be an array.');
  }

  const channels = Object.freeze(value.channels.map(parseMixerChannelV2));
  assertUniqueChannelTrackIds(channels);

  return freezeMixerState(channels, parseMasterStateV2(value.master));
}

function parseMixerChannelV1(value: unknown, index: number): MixerChannelStateV1 {
  const record = parseMixerChannelBase(value, index);
  assertEmptyInsertChain(record.inserts, `Mixer Channel ${index + 1}`);

  return Object.freeze({
    trackId: record.trackId as string,
    faderDb: record.faderDb as number,
    pan: record.pan as number,
    muted: record.muted as boolean,
    solo: record.solo as boolean,
    inserts: Object.freeze([]) as MixerChannelStateV1['inserts'],
    outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
  });
}

function parseMixerChannelV2(value: unknown, index: number): MixerChannelStateV2 {
  const record = parseMixerChannelBase(value, index);

  return Object.freeze({
    trackId: record.trackId as string,
    faderDb: record.faderDb as number,
    pan: record.pan as number,
    muted: record.muted as boolean,
    solo: record.solo as boolean,
    inserts: parseChannelInsertChain(
      record.inserts,
      `Mixer Channel ${index + 1}`,
    ),
    outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
  });
}

function parseMixerChannelBase(
  value: unknown,
  index: number,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidMixerState(`Mixer Channel ${index + 1} must be an object.`);
  }

  assertExactKeys(
    value,
    ['trackId', 'faderDb', 'pan', 'muted', 'solo', 'inserts', 'outputBusId'],
    `Mixer Channel ${index + 1}`,
  );

  if (
    typeof value.trackId !== 'string' ||
    value.trackId.length === 0 ||
    value.trackId.trim() !== value.trackId
  ) {
    throw invalidMixerState(`Mixer Channel ${index + 1} Track identity is invalid.`);
  }

  assertFiniteNumber(value.faderDb, `Mixer Channel ${index + 1} Fader`);
  assertPan(value.pan, `Mixer Channel ${index + 1} Pan`);

  if (typeof value.muted !== 'boolean' || typeof value.solo !== 'boolean') {
    throw invalidMixerState(`Mixer Channel ${index + 1} Mute/Solo state is invalid.`);
  }

  if (value.outputBusId !== PROJECT_MIXER_MASTER_BUS_ID) {
    throw invalidMixerState(
      `Mixer Channel ${index + 1} must route to the stereo Master Bus.`,
    );
  }

  return value;
}

function parseMasterStateV1(value: unknown): ProjectMixerStateV1['master'] {
  const record = parseMasterStateBase(value);
  assertEmptyInsertChain(record.inserts, 'Mixer Master');

  return Object.freeze({
    busId: PROJECT_MIXER_MASTER_BUS_ID,
    faderDb: record.faderDb as number,
    inserts: Object.freeze([]) as ProjectMixerStateV1['master']['inserts'],
  });
}

function parseMasterStateV2(value: unknown): ProjectMixerStateV2['master'] {
  const record = parseMasterStateBase(value);

  return Object.freeze({
    busId: PROJECT_MIXER_MASTER_BUS_ID,
    faderDb: record.faderDb as number,
    inserts: parseMasterInsertChain(record.inserts, 'Mixer Master'),
  });
}

function parseMasterStateBase(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidMixerState('Mixer Master state must be an object.');
  }

  assertExactKeys(value, ['busId', 'faderDb', 'inserts'], 'Mixer Master state');

  if (value.busId !== PROJECT_MIXER_MASTER_BUS_ID) {
    throw invalidMixerState('Mixer Master Bus identity is invalid.');
  }

  assertFiniteNumber(value.faderDb, 'Mixer Master Fader');
  return value;
}

function parseChannelInsertChain(
  value: unknown,
  label: string,
): MixerChannelInsertChainV2 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw invalidMixerState(
      `${label} must contain exactly Equalizer, Compressor, and Echo/Delay Inserts.`,
    );
  }

  return Object.freeze([
    parseEqualizerEffect(value[0], `${label} Equalizer`),
    parseCompressorEffect(value[1], `${label} Compressor`),
    parseEchoDelayEffect(value[2], `${label} Echo/Delay`),
  ]);
}

function parseMasterInsertChain(
  value: unknown,
  label: string,
): MixerMasterInsertChainV2 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw invalidMixerState(
      `${label} must contain exactly Equalizer, Compressor, and Limiter Inserts.`,
    );
  }

  return Object.freeze([
    parseEqualizerEffect(value[0], `${label} Equalizer`),
    parseCompressorEffect(value[1], `${label} Compressor`),
    parseLimiterEffect(value[2], `${label} Limiter`),
  ]);
}

function parseEqualizerEffect(value: unknown, label: string): MixerEqualizerEffect {
  const effect = parseEffect(value, label);

  if (effect.effectType !== MIXER_EFFECT_TYPE_EQUALIZER) {
    throw invalidMixerState(`${label} identity or chain position is invalid.`);
  }

  return effect;
}

function parseCompressorEffect(value: unknown, label: string): MixerCompressorEffect {
  const effect = parseEffect(value, label);

  if (effect.effectType !== MIXER_EFFECT_TYPE_COMPRESSOR) {
    throw invalidMixerState(`${label} identity or chain position is invalid.`);
  }

  return effect;
}

function parseEchoDelayEffect(value: unknown, label: string): MixerEchoDelayEffect {
  const effect = parseEffect(value, label);

  if (effect.effectType !== MIXER_EFFECT_TYPE_ECHO_DELAY) {
    throw invalidMixerState(`${label} identity or chain position is invalid.`);
  }

  return effect;
}

function parseLimiterEffect(value: unknown, label: string): MixerLimiterEffect {
  const effect = parseEffect(value, label);

  if (effect.effectType !== MIXER_EFFECT_TYPE_LIMITER) {
    throw invalidMixerState(`${label} identity or chain position is invalid.`);
  }

  return effect;
}

function parseEffect(value: unknown, label: string): MixerEffectState {
  try {
    return createMixerEffectSnapshot(value as MixerEffectState);
  } catch (error) {
    throw invalidMixerState(
      `${label} is invalid: ${
        error instanceof Error ? error.message : 'unsupported effect state'
      }`,
    );
  }
}

function freezeMixerState(
  channels: readonly MixerChannelStateV2[],
  master: ProjectMixerStateV2['master'],
): ProjectMixerStateV2 {
  return Object.freeze({
    schemaVersion: PROJECT_MIXER_STATE_VERSION,
    channels: Object.freeze([...channels]),
    master,
  });
}

function synchronizeLegacyTrackMixFields(
  tracks: readonly Track[],
  mixer: ProjectMixerState,
): Track[] {
  const channelByTrackId = new Map(
    mixer.channels.map((channel) => [channel.trackId, channel]),
  );

  return tracks.map((track) => {
    if (!isMixerEligibleTrack(track)) {
      const resolution = resolveGroupPlaybackTrack(track, tracks);

      if (!resolution.canResolve) {
        return track;
      }

      const activeChannel = channelByTrackId.get(resolution.activeTrack.id);

      if (!activeChannel) {
        throw invalidMixerState(
          `Mixer Channel is missing for active Group child ${resolution.activeTrack.id}.`,
        );
      }

      return {
        ...track,
        level: activeChannel.faderDb,
        muted: activeChannel.muted,
      };
    }

    const channel = channelByTrackId.get(track.id);

    if (!channel) {
      throw invalidMixerState(`Mixer Channel is missing for Track ${track.id}.`);
    }

    return {
      ...track,
      level: channel.faderDb,
      muted: channel.muted,
    };
  });
}

function assertUniqueTrackIds(tracks: readonly Track[]): void {
  const trackIds = new Set<string>();

  for (const track of tracks) {
    if (
      typeof track.id !== 'string' ||
      track.id.length === 0 ||
      track.id.trim() !== track.id
    ) {
      throw invalidMixerState('Every Project Track must have a valid identity.');
    }

    if (trackIds.has(track.id)) {
      throw invalidMixerState(`Project Track identity is duplicated: ${track.id}.`);
    }
    trackIds.add(track.id);
  }
}

function assertUniqueChannelTrackIds(
  channels: readonly Readonly<{ trackId: string }>[],
): void {
  const channelTrackIds = new Set<string>();

  for (const channel of channels) {
    if (channelTrackIds.has(channel.trackId)) {
      throw invalidMixerState(`Mixer Channel is duplicated for Track ${channel.trackId}.`);
    }
    channelTrackIds.add(channel.trackId);
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidMixerState(`${label} must be a finite number.`);
  }
}

function assertPan(value: unknown, label: string): asserts value is number {
  assertFiniteNumber(value, label);

  if (value < -1 || value > 1) {
    throw invalidMixerState(`${label} must be between -1 and 1.`);
  }
}

function assertEmptyInsertChain(value: unknown, label: string): asserts value is [] {
  if (!Array.isArray(value) || value.length !== 0) {
    throw invalidMixerState(`${label} Mixer State v1 Inserts must be empty.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expectedKeys = new Set(keys);

  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !expectedKeys.has(key))
  ) {
    throw invalidMixerState(`${label} contains unsupported fields.`);
  }
}

function invalidMixerState(message: string): ProjectMixerStateError {
  return new ProjectMixerStateError('MIXER_STATE_INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
