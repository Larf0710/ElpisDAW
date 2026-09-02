import { describe, expect, it } from 'vitest';

import { resolveRecordingTarget } from './recordingTarget';
import type { SelectionState, Track } from './types';

const humClip = {
  id: 'hum-clip',
  type: 'hum-audio' as const,
  name: 'Hum Part',
  startTick: 960,
  lengthTicks: 1_920,
  color: '#f00',
  generatedBy: 'Microphone Recording',
  createdAt: '2026-07-24T00:00:00.000Z',
  version: 1,
};
const tracks: Track[] = [
  {
    id: 'hum-audio',
    name: 'Hum Audio',
    type: 'audio',
    level: -8,
    clips: [humClip],
  },
  {
    id: 'track-2',
    name: 'Track 2',
    type: 'blank',
    level: 0,
    clips: [],
  },
  {
    id: 'midi-track',
    name: 'MIDI',
    type: 'midi',
    level: 0,
    clips: [],
  },
];

describe('resolveRecordingTarget', () => {
  it('uses the default Hum Audio Track when selection is empty', () => {
    expect(resolveRecordingTarget(tracks, selection())).toMatchObject({
      canRecord: true,
      targetTrack: { id: 'hum-audio' },
      targetTrackId: 'hum-audio',
    });
  });

  it('uses one selected blank Track for a new recording Clip', () => {
    expect(
      resolveRecordingTarget(tracks, selection({ type: 'track', id: 'track-2' })),
    ).toMatchObject({
      canRecord: true,
      targetTrack: { id: 'track-2' },
      targetTrackId: 'track-2',
    });
  });

  it('uses one selected Hum Audio Clip as the replacement Take target', () => {
    expect(
      resolveRecordingTarget(tracks, selection({ type: 'clip', id: 'hum-clip' })),
    ).toMatchObject({
      canRecord: true,
      targetClip: { id: 'hum-clip' },
      targetTrack: { id: 'hum-audio' },
    });
  });

  it('blocks non-Audio Tracks and ambiguous multi-selection', () => {
    expect(
      resolveRecordingTarget(tracks, selection({ type: 'track', id: 'midi-track' })),
    ).toMatchObject({
      canRecord: false,
      reason: 'track-not-recordable',
    });
    expect(
      resolveRecordingTarget(
        tracks,
        selection(
          { type: 'track', id: 'hum-audio' },
          { type: 'track', id: 'track-2' },
        ),
      ),
    ).toMatchObject({
      canRecord: false,
      reason: 'multiple-selection',
    });
  });

  it('reserves the canonical Hum Audio ID when the default Track is absent', () => {
    expect(resolveRecordingTarget([], selection())).toEqual({
      canRecord: true,
      targetTrack: undefined,
      targetTrackId: 'hum-audio',
    });
  });
});

function selection(
  ...items: SelectionState['items']
): SelectionState {
  const lastItem = items.length > 0 ? items[items.length - 1] : null;

  return {
    items,
    anchorItem: lastItem,
    lastSelectedItem: lastItem,
  };
}
