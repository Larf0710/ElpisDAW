import { describe, expect, it } from 'vitest';

import {
  createDefaultRecordingSettings,
  normalizeRecordingSettings,
} from './recordingSettings';

describe('Recording settings', () => {
  it('creates the v0.1 hardware-style defaults', () => {
    expect(createDefaultRecordingSettings()).toEqual({
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 60,
    });
  });

  it('normalizes saved settings and clamps Metronome Volume', () => {
    expect(
      normalizeRecordingSettings({
        countInBars: 2,
        metronomeEnabled: false,
        metronomeVolume: 180.6,
      }),
    ).toEqual({
      countInBars: 2,
      metronomeEnabled: false,
      metronomeVolume: 100,
    });
    expect(
      normalizeRecordingSettings({
        countInBars: 0,
        metronomeEnabled: true,
        metronomeVolume: -12,
      }),
    ).toEqual({
      countInBars: 0,
      metronomeEnabled: true,
      metronomeVolume: 0,
    });
  });

  it('repairs missing or invalid legacy values with defaults', () => {
    expect(normalizeRecordingSettings(undefined)).toEqual(
      createDefaultRecordingSettings(),
    );
    expect(
      normalizeRecordingSettings({
        countInBars: 4,
        metronomeEnabled: 'yes',
        metronomeVolume: Number.NaN,
      }),
    ).toEqual(createDefaultRecordingSettings());
  });
});
