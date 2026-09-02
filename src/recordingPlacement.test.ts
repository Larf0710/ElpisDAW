import { describe, expect, it } from 'vitest';

import { createRecordingPlacementPlan } from './recordingPlacement';
import type { Track } from './types';

const humTrack: Track = {
  id: 'hum-audio',
  name: 'Hum Audio',
  type: 'audio',
  level: -8,
  clips: [
    {
      id: 'clip-a',
      type: 'hum-audio',
      name: 'Part A',
      startTick: 960,
      lengthTicks: 1_920,
      color: '#f00',
      generatedBy: 'Microphone Recording',
      createdAt: '2026-07-24T00:00:00.000Z',
      version: 1,
    },
    {
      id: 'clip-b',
      type: 'hum-audio',
      name: 'Part B',
      startTick: 4_800,
      lengthTicks: 960,
      color: '#f00',
      generatedBy: 'Microphone Recording',
      createdAt: '2026-07-24T00:00:01.000Z',
      version: 1,
    },
  ],
};

describe('createRecordingPlacementPlan', () => {
  it('blocks recording when the Playhead is inside an existing Clip', () => {
    expect(
      createRecordingPlacementPlan({
        bpm: 120,
        startTick: 1_920,
        totalTicks: 7_680,
        track: humTrack,
      }),
    ).toMatchObject({
      blockingClip: { id: 'clip-a' },
      canRecord: false,
      reason: 'clip-overlap',
    });
  });

  it('allows recording directly after a Clip and stops at the next Clip boundary', () => {
    expect(
      createRecordingPlacementPlan({
        bpm: 120,
        startTick: 2_880,
        totalTicks: 7_680,
        track: humTrack,
      }),
    ).toEqual({
      boundaryReason: 'next-clip',
      canRecord: true,
      maximumDurationSeconds: 1,
      maximumEndTick: 4_800,
      startTick: 2_880,
    });
  });

  it('excludes the selected target Clip when recording a replacement Take', () => {
    expect(
      createRecordingPlacementPlan({
        bpm: 120,
        excludedClipId: 'clip-a',
        startTick: 960,
        totalTicks: 7_680,
        track: humTrack,
      }),
    ).toMatchObject({
      boundaryReason: 'next-clip',
      canRecord: true,
      maximumEndTick: 4_800,
      startTick: 960,
    });
  });

  it('uses the Timeline end when no later Clip exists', () => {
    expect(
      createRecordingPlacementPlan({
        bpm: 60,
        startTick: 5_760,
        totalTicks: 7_680,
        track: humTrack,
      }),
    ).toEqual({
      boundaryReason: 'timeline-end',
      canRecord: true,
      maximumDurationSeconds: 2,
      maximumEndTick: 7_680,
      startTick: 5_760,
    });
  });

  it('blocks recording at the Timeline end', () => {
    expect(
      createRecordingPlacementPlan({
        bpm: 120,
        startTick: 7_680,
        totalTicks: 7_680,
        track: humTrack,
      }),
    ).toMatchObject({
      canRecord: false,
      reason: 'timeline-end',
    });
  });

  it('blocks a gap that is too short to capture a stable audio buffer', () => {
    expect(
      createRecordingPlacementPlan({
        bpm: 120,
        startTick: 4_799,
        totalTicks: 7_680,
        track: humTrack,
      }),
    ).toMatchObject({
      canRecord: false,
      reason: 'insufficient-space',
    });
  });
});
