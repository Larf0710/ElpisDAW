import type { ClipType } from './types';

export const AUDIO_CLIP_COLOR = '#ff4d5d';
export const MIDI_CLIP_COLOR = '#4d6dff';
export const ARRANGEMENT_CLIP_COLOR = '#ffb000';
export const MASTER_CLIP_COLOR = '#f5f7ff';

export const CLIP_TYPE_COLORS = {
  'ai-fill-audio': AUDIO_CLIP_COLOR,
  arrangement: ARRANGEMENT_CLIP_COLOR,
  'edited-midi': MIDI_CLIP_COLOR,
  'hum-audio': AUDIO_CLIP_COLOR,
  'instrument-audio': AUDIO_CLIP_COLOR,
  master: MASTER_CLIP_COLOR,
  'midi-notes': MIDI_CLIP_COLOR,
  mixdown: MASTER_CLIP_COLOR,
  'vocal-audio': AUDIO_CLIP_COLOR,
} as const satisfies Readonly<Record<ClipType, string>>;

export function getClipTypeColor(type: ClipType): string {
  return CLIP_TYPE_COLORS[type];
}
