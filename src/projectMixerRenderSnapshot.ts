import {
  normalizeProjectMixerState,
  PROJECT_MIXER_MASTER_BUS_ID,
} from './projectMixerState';
import {
  MIXER_EFFECT_TYPE_COMPRESSOR,
  MIXER_EFFECT_TYPE_ECHO_DELAY,
  MIXER_EFFECT_TYPE_EQUALIZER,
  MIXER_EFFECT_TYPE_LIMITER,
  assertMixerEffectState,
  createMixerEffectSnapshot,
} from '../shared/mixerEffectsContract.js';
import {
  MIXER_RENDER_SNAPSHOT_VERSION,
  assertMixerPan,
  decibelsToMixerGain,
} from '../shared/mixerDspContract.js';
import type {
  MixerChannelStateV1,
  MixerChannelStateV2,
  MixerMasterStateV1,
  MixerMasterStateV2,
  ProjectMixerState,
  ProjectMixerStateV1,
  Track,
} from './types';

export const PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V1 =
  MIXER_RENDER_SNAPSHOT_VERSION;
export const PROJECT_MIXER_RENDER_SNAPSHOT_VERSION =
  PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V1;
export const PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2 = 2 as const;

export const PROJECT_MIXER_EFFECTS_EXECUTION_UNAVAILABLE =
  'EFFECTS_EXECUTION_UNAVAILABLE' as const;

export class ProjectMixerEffectsExecutionUnavailableError extends Error {
  readonly code = PROJECT_MIXER_EFFECTS_EXECUTION_UNAVAILABLE;

  constructor() {
    super(
      'Mixer effects execution is unavailable in the retained v1 compatibility snapshot path.',
    );
    this.name = 'ProjectMixerEffectsExecutionUnavailableError';
  }
}

export type MixerRenderChannelSnapshotV1 = Readonly<
  Pick<
    MixerChannelStateV1,
    | 'faderDb'
    | 'inserts'
    | 'muted'
    | 'outputBusId'
    | 'pan'
    | 'solo'
    | 'trackId'
  >
>;

export type MixerRenderMasterSnapshotV1 = Readonly<
  Pick<MixerMasterStateV1, 'busId' | 'faderDb' | 'inserts'>
>;

export type ProjectMixerRenderSnapshotV1 = Readonly<{
  channels: readonly MixerRenderChannelSnapshotV1[];
  master: MixerRenderMasterSnapshotV1;
  schemaVersion: typeof PROJECT_MIXER_RENDER_SNAPSHOT_VERSION;
}>;

export type ProjectMixerRenderSnapshot = ProjectMixerRenderSnapshotV1;

export type MixerRenderChannelSnapshotV2 = Readonly<
  Pick<
    MixerChannelStateV2,
    | 'faderDb'
    | 'inserts'
    | 'muted'
    | 'outputBusId'
    | 'pan'
    | 'solo'
    | 'trackId'
  >
>;

export type MixerRenderMasterSnapshotV2 = Readonly<
  Pick<MixerMasterStateV2, 'busId' | 'faderDb' | 'inserts'>
>;

export type ProjectMixerRenderSnapshotV2 = Readonly<{
  channels: readonly MixerRenderChannelSnapshotV2[];
  master: MixerRenderMasterSnapshotV2;
  schemaVersion: typeof PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2;
}>;

type ProjectMixerRenderSnapshotInput = Readonly<{
  mixer?: ProjectMixerState | ProjectMixerStateV1;
  tracks: readonly Track[];
}>;

/**
 * Compatibility builder for production Playback and Mixdown v1 consumers.
 * It emits retained empty Inserts only while every validated v2 effect is bypassed.
 */
export function createProjectMixerRenderSnapshot(
  input: ProjectMixerRenderSnapshotInput,
): ProjectMixerRenderSnapshot {
  const normalized = normalizeProjectMixerState(input.tracks, input.mixer);
  assertEffectsExecutionCanRemainBypassed(normalized.mixer);
  const channels = Object.freeze(
    normalized.mixer.channels.map((channel) =>
      Object.freeze({
        faderDb: channel.faderDb,
        inserts: Object.freeze([]) as MixerChannelStateV1['inserts'],
        muted: channel.muted,
        outputBusId: channel.outputBusId,
        pan: channel.pan,
        solo: channel.solo,
        trackId: channel.trackId,
      }),
    ),
  );
  const master = Object.freeze({
    busId: normalized.mixer.master.busId,
    faderDb: normalized.mixer.master.faderDb,
    inserts: Object.freeze([]) as MixerMasterStateV1['inserts'],
  });

  const snapshot = Object.freeze({
    channels,
    master,
    schemaVersion: PROJECT_MIXER_RENDER_SNAPSHOT_VERSION,
  });

  assertProjectMixerRenderSnapshot(snapshot);
  return snapshot;
}

export function createProjectMixerRenderSnapshotV2(
  input: ProjectMixerRenderSnapshotInput,
): ProjectMixerRenderSnapshotV2 {
  const normalized = normalizeProjectMixerState(input.tracks, input.mixer);
  const channels = Object.freeze(
    normalized.mixer.channels.map((channel) =>
      Object.freeze({
        faderDb: channel.faderDb,
        inserts: Object.freeze([
          createMixerEffectSnapshot(channel.inserts[0]),
          createMixerEffectSnapshot(channel.inserts[1]),
          createMixerEffectSnapshot(channel.inserts[2]),
        ]) as MixerChannelStateV2['inserts'],
        muted: channel.muted,
        outputBusId: channel.outputBusId,
        pan: channel.pan,
        solo: channel.solo,
        trackId: channel.trackId,
      }),
    ),
  );
  const master = Object.freeze({
    busId: normalized.mixer.master.busId,
    faderDb: normalized.mixer.master.faderDb,
    inserts: Object.freeze([
      createMixerEffectSnapshot(normalized.mixer.master.inserts[0]),
      createMixerEffectSnapshot(normalized.mixer.master.inserts[1]),
      createMixerEffectSnapshot(normalized.mixer.master.inserts[2]),
    ]) as MixerMasterStateV2['inserts'],
  });
  const snapshot = Object.freeze({
    channels,
    master,
    schemaVersion: PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2,
  });

  assertProjectMixerRenderSnapshotV2(snapshot);
  return snapshot;
}

export function assertProjectMixerRenderSnapshot(
  value: unknown,
): asserts value is ProjectMixerRenderSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['channels', 'master', 'schemaVersion'])) {
    throw new TypeError('Mixer Render Snapshot shape is invalid.');
  }

  if (
    value.schemaVersion !== PROJECT_MIXER_RENDER_SNAPSHOT_VERSION ||
    !Array.isArray(value.channels) ||
    !isRecord(value.master)
  ) {
    throw new TypeError('Mixer Render Snapshot version or structure is invalid.');
  }

  const trackIds = new Set<string>();

  for (const channel of value.channels) {
    if (
      !isRecord(channel) ||
      !hasExactKeys(channel, [
        'faderDb',
        'inserts',
        'muted',
        'outputBusId',
        'pan',
        'solo',
        'trackId',
      ]) ||
      !isTrimmedText(channel.trackId) ||
      trackIds.has(channel.trackId) ||
      typeof channel.faderDb !== 'number' ||
      typeof channel.pan !== 'number' ||
      channel.outputBusId !== PROJECT_MIXER_MASTER_BUS_ID ||
      typeof channel.muted !== 'boolean' ||
      typeof channel.solo !== 'boolean' ||
      !Array.isArray(channel.inserts) ||
      channel.inserts.length !== 0
    ) {
      throw new TypeError('Mixer Render Snapshot Channel is invalid.');
    }

    decibelsToMixerGain(channel.faderDb);
    assertMixerPan(channel.pan);
    trackIds.add(channel.trackId);
  }

  if (
    !hasExactKeys(value.master, ['busId', 'faderDb', 'inserts']) ||
    value.master.busId !== PROJECT_MIXER_MASTER_BUS_ID ||
    typeof value.master.faderDb !== 'number' ||
    !Array.isArray(value.master.inserts) ||
    value.master.inserts.length !== 0
  ) {
    throw new TypeError('Mixer Render Snapshot Master state is invalid.');
  }

  decibelsToMixerGain(value.master.faderDb);
}

export function assertProjectMixerRenderSnapshotV2(
  value: unknown,
): asserts value is ProjectMixerRenderSnapshotV2 {
  if (!isRecord(value) || !hasExactKeys(value, ['channels', 'master', 'schemaVersion'])) {
    throw new TypeError('Mixer Render Snapshot v2 shape is invalid.');
  }

  if (
    value.schemaVersion !== PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2 ||
    !Array.isArray(value.channels) ||
    !isRecord(value.master)
  ) {
    throw new TypeError('Mixer Render Snapshot v2 version or structure is invalid.');
  }

  const trackIds = new Set<string>();

  for (const channel of value.channels) {
    if (
      !isRecord(channel) ||
      !hasExactKeys(channel, [
        'faderDb',
        'inserts',
        'muted',
        'outputBusId',
        'pan',
        'solo',
        'trackId',
      ]) ||
      !isTrimmedText(channel.trackId) ||
      trackIds.has(channel.trackId) ||
      typeof channel.faderDb !== 'number' ||
      typeof channel.pan !== 'number' ||
      channel.outputBusId !== PROJECT_MIXER_MASTER_BUS_ID ||
      typeof channel.muted !== 'boolean' ||
      typeof channel.solo !== 'boolean'
    ) {
      throw new TypeError('Mixer Render Snapshot v2 Channel is invalid.');
    }

    assertChannelInsertSnapshot(channel.inserts);
    decibelsToMixerGain(channel.faderDb);
    assertMixerPan(channel.pan);
    trackIds.add(channel.trackId);
  }

  if (
    !hasExactKeys(value.master, ['busId', 'faderDb', 'inserts']) ||
    value.master.busId !== PROJECT_MIXER_MASTER_BUS_ID ||
    typeof value.master.faderDb !== 'number'
  ) {
    throw new TypeError('Mixer Render Snapshot v2 Master state is invalid.');
  }

  assertMasterInsertSnapshot(value.master.inserts);
  decibelsToMixerGain(value.master.faderDb);
}

function assertEffectsExecutionCanRemainBypassed(mixer: ProjectMixerState): void {
  const hasEnabledEffect =
    mixer.channels.some((channel) =>
      channel.inserts.some((effect) => !effect.bypass),
    ) || mixer.master.inserts.some((effect) => !effect.bypass);

  if (hasEnabledEffect) {
    throw new ProjectMixerEffectsExecutionUnavailableError();
  }
}

function assertChannelInsertSnapshot(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError('Mixer Render Snapshot v2 Channel Inserts are invalid.');
  }

  value.forEach((effect) => assertMixerEffectState(effect));

  if (
    value[0].effectType !== MIXER_EFFECT_TYPE_EQUALIZER ||
    value[1].effectType !== MIXER_EFFECT_TYPE_COMPRESSOR ||
    value[2].effectType !== MIXER_EFFECT_TYPE_ECHO_DELAY
  ) {
    throw new TypeError('Mixer Render Snapshot v2 Channel Insert order is invalid.');
  }
}

function assertMasterInsertSnapshot(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError('Mixer Render Snapshot v2 Master Inserts are invalid.');
  }

  value.forEach((effect) => assertMixerEffectState(effect));

  if (
    value[0].effectType !== MIXER_EFFECT_TYPE_EQUALIZER ||
    value[1].effectType !== MIXER_EFFECT_TYPE_COMPRESSOR ||
    value[2].effectType !== MIXER_EFFECT_TYPE_LIMITER
  ) {
    throw new TypeError('Mixer Render Snapshot v2 Master Insert order is invalid.');
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTrimmedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value
  );
}
