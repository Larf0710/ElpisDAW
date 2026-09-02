import { describe, expect, it, vi } from 'vitest';

import { createEmptyProject } from './emptyProject';
import type { LocalEngineSoundFontResource } from './localEngineClient';
import { createManualMidiClip } from './manualMidiClip';
import { MidiClipPlaybackCache } from './midiClipPlaybackCache';
import { savePianoRollTake } from './pianoRollTakeEditing';
import type { ProjectState } from './types';

const resource: LocalEngineSoundFontResource = Object.freeze({
  format: 'sf3',
  lastModifiedAt: '2026-08-23T00:00:00.000Z',
  library: 'builtin',
  name: 'MuseScore General',
  relativePath: 'soundfonts/MuseScore_General.sf3',
  resourceId: `soundfont-${'a'.repeat(32)}`,
  revisionToken: 'b'.repeat(64),
  sizeBytes: 1024,
  status: 'AVAILABLE',
});

describe('MidiClipPlaybackCache', () => {
  it('renders an assigned MIDI Clip once and reuses the session cache', async () => {
    const project = createAssignedMidiProject();
    const wav = createPcm16Wave(48_000, 48_000);
    const renderer = {
      renderSoundFontAudition: vi.fn(async () => ({
        ok: true as const,
        wav,
      })),
    };
    const cache = new MidiClipPlaybackCache();
    const first = await cache.prepare(project, [resource], renderer);
    const second = await cache.prepare(project, [resource], renderer);

    expect(renderer.renderSoundFontAudition).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ renderedCount: 1, reusedCount: 0 });
    expect(second).toMatchObject({ renderedCount: 0, reusedCount: 1 });
    expect(renderer.renderSoundFontAudition).toHaveBeenCalledWith(
      expect.objectContaining({
        bank: 0,
        midi: expect.objectContaining({ bpm: 120 }),
        program: 0,
      }),
      undefined,
    );

    const clipSnapshot = first.snapshot['clip-manual-midi-1'];
    expect(clipSnapshot).toMatchObject({
      lengthTicks: 960,
      status: 'READY',
    });

    if (clipSnapshot?.status === 'READY') {
      expect(first.sources.get(clipSnapshot.sourceId)).toMatchObject({
        data: wav,
        kind: 'midi-cache',
      });
    }
  });

  it('invalidates the cached render when Project BPM or Clip voice changes', async () => {
    const project = createAssignedMidiProject();
    const renderer = {
      renderSoundFontAudition: vi.fn(async () => ({
        ok: true as const,
        wav: createPcm16Wave(48_000, 48_000),
      })),
    };
    const cache = new MidiClipPlaybackCache();

    await cache.prepare(project, [resource], renderer);
    await cache.prepare({ ...project, bpm: 140 }, [resource], renderer);
    const changedVoice = updateClip(project, (clip) => ({
      ...clip,
      soundFont: clip.soundFont
        ? { ...clip.soundFont, program: 40 }
        : undefined,
    }));
    await cache.prepare(changedVoice, [resource], renderer);

    expect(renderer.renderSoundFontAudition).toHaveBeenCalledTimes(3);
  });

  it('releases cached blobs when cleared or when their Clip leaves the Project', async () => {
    const project = createAssignedMidiProject();
    const renderer = {
      renderSoundFontAudition: vi.fn(async () => ({
        ok: true as const,
        wav: createPcm16Wave(48_000, 48_000),
      })),
    };
    const cache = new MidiClipPlaybackCache();

    await cache.prepare(project, [resource], renderer);
    cache.clear();
    await cache.prepare(project, [resource], renderer);
    cache.prune(createEmptyProject());
    await cache.prepare(project, [resource], renderer);

    expect(renderer.renderSoundFontAudition).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the assigned SoundFont is offline', async () => {
    const project = createAssignedMidiProject();
    const renderer = {
      renderSoundFontAudition: vi.fn(),
    };
    const result = await new MidiClipPlaybackCache().prepare(
      project,
      [],
      renderer,
    );

    expect(renderer.renderSoundFontAudition).not.toHaveBeenCalled();
    expect(result.snapshot['clip-manual-midi-1']).toMatchObject({
      message: expect.stringContaining('offline'),
      status: 'UNAVAILABLE',
    });
    expect(result.sources.size).toBe(0);
  });
});

function createAssignedMidiProject(): ProjectState {
  const created = createManualMidiClip(createEmptyProject(), {
    createdAt: '2026-08-23T00:00:00.000Z',
    startTick: 0,
  });

  if (!created.canCreate) {
    throw new Error(created.message);
  }

  const saved = savePianoRollTake(created.project, {
    clipId: created.clip.id,
    notes: [
      {
        id: 'note-a',
        lengthTicks: 960,
        pitch: 60,
        startTick: 0,
        velocity: 100,
      },
    ],
  });

  if (!saved.canSave) {
    throw new Error(saved.message);
  }

  const assigned = updateClip(saved.project, (clip) => ({
    ...clip,
    soundFont: {
      bank: 0,
      program: 0,
      resource: {
        format: resource.format,
        library: resource.library,
        relativePath: resource.relativePath,
        resourceId: resource.resourceId,
      },
    },
  }));

  return {
    ...assigned,
    selection: { items: [{ id: created.clip.id, type: 'clip' }] },
  };
}

function updateClip(
  project: ProjectState,
  update: (clip: ProjectState['tracks'][number]['clips'][number]) => ProjectState['tracks'][number]['clips'][number],
): ProjectState {
  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.id === 'clip-manual-midi-1' ? update(clip) : clip,
      ),
    })),
  };
}

function createPcm16Wave(sampleRate: number, frameCount: number): Blob {
  const bytes = new Uint8Array(44 + frameCount * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, frameCount * 2, true);
  return new Blob([bytes], { type: 'audio/wav' });
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
