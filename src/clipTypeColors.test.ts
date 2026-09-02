import { describe, expect, it } from 'vitest';

import {
  ARRANGEMENT_CLIP_COLOR,
  AUDIO_CLIP_COLOR,
  CLIP_TYPE_COLORS,
  MASTER_CLIP_COLOR,
  MIDI_CLIP_COLOR,
  getClipTypeColor,
} from './clipTypeColors';
import { tabFlowPresets } from './presets';
import { sampleProject } from './sampleProject';

describe('Clip type colors', () => {
  it('assigns one fixed color to every supported Clip type', () => {
    expect(CLIP_TYPE_COLORS).toEqual({
      'ai-fill-audio': AUDIO_CLIP_COLOR,
      arrangement: ARRANGEMENT_CLIP_COLOR,
      'edited-midi': MIDI_CLIP_COLOR,
      'hum-audio': AUDIO_CLIP_COLOR,
      'instrument-audio': AUDIO_CLIP_COLOR,
      master: MASTER_CLIP_COLOR,
      'midi-notes': MIDI_CLIP_COLOR,
      mixdown: MASTER_CLIP_COLOR,
      'vocal-audio': AUDIO_CLIP_COLOR,
    });
  });

  it('uses red for Audio, blue for MIDI, amber for Arrangement, and white for Master output', () => {
    expect(getClipTypeColor('hum-audio')).toBe('#ff4d5d');
    expect(getClipTypeColor('midi-notes')).toBe('#4d6dff');
    expect(getClipTypeColor('arrangement')).toBe('#ffb000');
    expect(getClipTypeColor('mixdown')).toBe('#f5f7ff');
  });

  it('keeps built-in Project Clips on their authoritative type colors', () => {
    const projects = [
      sampleProject,
      ...tabFlowPresets.map((preset) => preset.project),
    ];

    for (const project of projects) {
      for (const clip of project.tracks.flatMap((track) => track.clips)) {
        expect(clip.color, `${project.name}: ${clip.name}`).toBe(
          getClipTypeColor(clip.type),
        );
      }
    }
  });
});
