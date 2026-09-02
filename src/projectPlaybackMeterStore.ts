import {
  MIXER_METER_CONTRACT_VERSION,
  MIXER_SAMPLE_PEAK_CLIP_THRESHOLD,
  type MixerSamplePeakSnapshot,
} from '../shared/mixerMeterContract.js';
import {
  MIXER_CHANNEL_METER_TAP_POSITION,
  MIXER_MASTER_METER_TAP_POSITION,
  MIXER_METER_TAP_CONTRACT_VERSION,
} from '../shared/mixerMeterTapContract.js';
import type { ProjectPlaybackRuntimeMeterSnapshot } from './projectPlaybackAudioWorkletRuntime';

export type ProjectPlaybackMeterScope = 'channel' | 'master';

export type ProjectPlaybackMeterStore = Readonly<{
  clear: () => void;
  getMeter: (
    scope: ProjectPlaybackMeterScope,
    trackId?: string,
  ) => MixerSamplePeakSnapshot | undefined;
  getSubscriberCount: () => number;
  publish: (snapshot: ProjectPlaybackRuntimeMeterSnapshot) => void;
  subscribe: (
    scope: ProjectPlaybackMeterScope,
    trackId: string | undefined,
    listener: () => void,
  ) => () => void;
}>;

type MeterKey = `channel:${string}` | 'master';

export function createProjectPlaybackMeterStore(): ProjectPlaybackMeterStore {
  let meters = new Map<MeterKey, MixerSamplePeakSnapshot>();
  const listeners = new Map<MeterKey, Set<() => void>>();

  const notifyChangedMeters = (
    previous: ReadonlyMap<MeterKey, MixerSamplePeakSnapshot>,
    next: ReadonlyMap<MeterKey, MixerSamplePeakSnapshot>,
  ) => {
    for (const [key, keyListeners] of listeners) {
      if (areMeterSnapshotsEqual(previous.get(key), next.get(key))) {
        continue;
      }

      for (const listener of [...keyListeners]) {
        listener();
      }
    }
  };

  return Object.freeze({
    clear: () => {
      if (meters.size === 0) {
        return;
      }

      const previous = meters;
      meters = new Map();
      notifyChangedMeters(previous, meters);
    },
    getMeter: (scope, trackId) => meters.get(createMeterKey(scope, trackId)),
    getSubscriberCount: () => {
      let count = 0;

      for (const keyListeners of listeners.values()) {
        count += keyListeners.size;
      }

      return count;
    },
    publish: (snapshot) => {
      if (
        snapshot.version !== 1 ||
        !Object.isFrozen(snapshot) ||
        !Object.isFrozen(snapshot.meterSummary) ||
        snapshot.meterSummary.schemaVersion !== MIXER_METER_TAP_CONTRACT_VERSION ||
        snapshot.meterSummary.samplePeakContractVersion !== MIXER_METER_CONTRACT_VERSION ||
        snapshot.meterSummary.channelTapPosition !== MIXER_CHANNEL_METER_TAP_POSITION ||
        snapshot.meterSummary.masterTapPosition !== MIXER_MASTER_METER_TAP_POSITION ||
        !Object.isFrozen(snapshot.meterSummary.channels)
      ) {
        throw new TypeError(
          'Playback meter store requires one immutable runtime snapshot v1.',
        );
      }

      const next = new Map<MeterKey, MixerSamplePeakSnapshot>();
      assertImmutableMeterSnapshot(snapshot.meterSummary.master);
      next.set('master', snapshot.meterSummary.master);

      for (const channel of snapshot.meterSummary.channels) {
        if (!Object.isFrozen(channel)) {
          throw new TypeError(
            'Playback meter store requires immutable Channel observations.',
          );
        }
        assertImmutableMeterSnapshot(channel.meter);
        const key = createMeterKey('channel', channel.trackId);

        if (next.has(key)) {
          throw new TypeError(
            `Playback meter snapshot duplicates Channel ${channel.trackId}.`,
          );
        }

        next.set(key, channel.meter);
      }

      const previous = meters;
      meters = next;
      notifyChangedMeters(previous, meters);
    },
    subscribe: (scope, trackId, listener) => {
      if (typeof listener !== 'function') {
        throw new TypeError('Playback meter subscriber must be a function.');
      }

      const key = createMeterKey(scope, trackId);
      const keyListeners = listeners.get(key) ?? new Set<() => void>();
      keyListeners.add(listener);
      listeners.set(key, keyListeners);
      let active = true;

      return () => {
        if (!active) {
          return;
        }

        active = false;
        keyListeners.delete(listener);

        if (keyListeners.size === 0) {
          listeners.delete(key);
        }
      };
    },
  });
}

function assertImmutableMeterSnapshot(meter: MixerSamplePeakSnapshot): void {
  if (
    !Object.isFrozen(meter) ||
    !Object.isFrozen(meter.left) ||
    !Object.isFrozen(meter.right) ||
    meter.version !== MIXER_METER_CONTRACT_VERSION ||
    !Number.isSafeInteger(meter.sampleCount) ||
    meter.sampleCount < 0 ||
    !Number.isFinite(meter.left.peak) ||
    meter.left.peak < 0 ||
    !Number.isFinite(meter.right.peak) ||
    meter.right.peak < 0 ||
    meter.left.clipped !== (meter.left.peak > MIXER_SAMPLE_PEAK_CLIP_THRESHOLD) ||
    meter.right.clipped !== (meter.right.peak > MIXER_SAMPLE_PEAK_CLIP_THRESHOLD) ||
    meter.clipped !== (meter.left.clipped || meter.right.clipped)
  ) {
    throw new TypeError(
      'Playback meter store requires an immutable exact sample-peak observation.',
    );
  }
}

function createMeterKey(
  scope: ProjectPlaybackMeterScope,
  trackId?: string,
): MeterKey {
  if (scope === 'master') {
    return 'master';
  }

  if (
    typeof trackId !== 'string' ||
    trackId.length === 0 ||
    trackId.trim() !== trackId
  ) {
    throw new TypeError('Channel meter subscription requires one Track identity.');
  }

  return `channel:${trackId}`;
}

function areMeterSnapshotsEqual(
  left: MixerSamplePeakSnapshot | undefined,
  right: MixerSamplePeakSnapshot | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.left.peak === right.left.peak &&
      left.left.clipped === right.left.clipped &&
      left.right.peak === right.right.peak &&
      left.right.clipped === right.right.clipped)
  );
}
