import { describe, expect, it } from 'vitest';

import { createEmptyProject } from './emptyProject';
import { createManualMidiClip } from './manualMidiClip';
import { resolveMixerSoundFontTarget } from './mixerSoundFont';

describe('Mixer SoundFont target resolution', () => {
  it('resolves one selected MIDI Clip and its owning Track', () => {
    const created = createManualMidiClip(createEmptyProject(), {
      createdAt: '2026-08-23T00:00:00.000Z',
      startTick: 0,
    });
    expect(created.canCreate).toBe(true);
    if (!created.canCreate) {
      return;
    }
    const project = {
      ...created.project,
      selection: { items: [{ id: created.clip.id, type: 'clip' as const }] },
    };

    expect(resolveMixerSoundFontTarget(project)).toMatchObject({
      clip: { id: created.clip.id },
      status: 'READY',
      track: { id: created.track.id },
    });
  });

  it('resolves a Track only when it contains one MIDI Clip', () => {
    const created = createManualMidiClip(createEmptyProject(), {
      createdAt: '2026-08-23T00:00:00.000Z',
      startTick: 0,
    });
    expect(created.canCreate).toBe(true);
    if (!created.canCreate) {
      return;
    }
    const selectedTrackProject = {
      ...created.project,
      selection: { items: [{ id: created.track.id, type: 'track' as const }] },
    };
    expect(resolveMixerSoundFontTarget(selectedTrackProject).status).toBe('READY');

    const twoClipProject = {
      ...selectedTrackProject,
      tracks: selectedTrackProject.tracks.map((track) =>
        track.id === created.track.id
          ? {
              ...track,
              clips: [
                ...track.clips,
                { ...track.clips[0], id: 'manual-midi-clip-2', version: 1 },
              ],
            }
          : track,
      ),
    };
    expect(resolveMixerSoundFontTarget(twoClipProject)).toMatchObject({
      clipCount: 2,
      status: 'MULTIPLE',
    });
  });
});
