import {
  MIXER_METER_CONTRACT_VERSION,
  snapshotMixerSamplePeak,
} from './mixerMeterContract.js';

export const MIXER_METER_TAP_CONTRACT_VERSION = 2;
export const MIXER_CHANNEL_METER_TAP_POSITION =
  'post-channel-effects-pre-master-sum';
export const MIXER_MASTER_METER_TAP_POSITION =
  'post-master-effects-pre-pcm-clamp';

/**
 * Meter Tap Contract v2 freezes routing semantics around the existing exact
 * Sample Peak Contract v1. Observations are session-only render summaries and
 * never become Plan, operation, Artifact, or settlement identity.
 */
export function createMixerMeterTapSummary(channelAccumulators, masterAccumulator) {
  if (!Array.isArray(channelAccumulators)) {
    throw new TypeError('Mixer meter Channel accumulators must be an array.');
  }

  const trackIds = new Set();
  const channels = Object.freeze(
    channelAccumulators.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ['accumulator', 'trackId']) ||
        !isTrimmedText(entry.trackId) ||
        trackIds.has(entry.trackId)
      ) {
        throw new TypeError('Mixer meter Channel tap entry is invalid.');
      }

      trackIds.add(entry.trackId);
      return Object.freeze({
        meter: snapshotMixerSamplePeak(entry.accumulator),
        trackId: entry.trackId,
      });
    }),
  );

  return Object.freeze({
    channelTapPosition: MIXER_CHANNEL_METER_TAP_POSITION,
    channels,
    master: snapshotMixerSamplePeak(masterAccumulator),
    masterTapPosition: MIXER_MASTER_METER_TAP_POSITION,
    samplePeakContractVersion: MIXER_METER_CONTRACT_VERSION,
    schemaVersion: MIXER_METER_TAP_CONTRACT_VERSION,
  });
}

function hasExactKeys(value, keys) {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function isTrimmedText(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
