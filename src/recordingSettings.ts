import type { CountInBars, RecordingSettings } from './types';

export const DEFAULT_COUNT_IN_BARS: CountInBars = 1;
export const DEFAULT_METRONOME_VOLUME = 60;
export const METRONOME_VOLUME_MIN = 0;
export const METRONOME_VOLUME_MAX = 100;

export function createDefaultRecordingSettings(): RecordingSettings {
  return {
    countInBars: DEFAULT_COUNT_IN_BARS,
    metronomeEnabled: true,
    metronomeVolume: DEFAULT_METRONOME_VOLUME,
  };
}

export function normalizeRecordingSettings(value: unknown): RecordingSettings {
  if (!isRecord(value)) {
    return createDefaultRecordingSettings();
  }

  return {
    countInBars: normalizeCountInBars(value.countInBars),
    metronomeEnabled:
      typeof value.metronomeEnabled === 'boolean' ? value.metronomeEnabled : true,
    metronomeVolume: normalizeMetronomeVolume(value.metronomeVolume),
  };
}

function normalizeCountInBars(value: unknown): CountInBars {
  return value === 0 || value === 1 || value === 2 ? value : DEFAULT_COUNT_IN_BARS;
}

function normalizeMetronomeVolume(value: unknown): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_METRONOME_VOLUME;
  }

  return Math.min(
    METRONOME_VOLUME_MAX,
    Math.max(METRONOME_VOLUME_MIN, Math.round(value as number)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
