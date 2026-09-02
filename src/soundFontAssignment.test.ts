import { describe, expect, it } from 'vitest';

import {
  createProjectSoundFontAssignment,
  normalizeSoundFontAssignment,
  SOUNDFONT_BANK_MAX,
  SOUNDFONT_PROGRAM_MAX,
  updateMidiClipSoundFontAssignment,
} from './soundFontAssignment';
import { sampleProject } from './sampleProject';
import type { ProjectState } from './types';

const resource = {
  format: 'sf2' as const,
  library: 'project' as const,
  relativePath: 'soundfonts/Keys/Electric Piano.sf2',
  resourceId: `soundfont-${'a'.repeat(32)}`,
};

describe('SoundFont assignment', () => {
  it('creates a Clip-level Project SoundFont assignment with safe defaults', () => {
    expect(createProjectSoundFontAssignment(resource)).toEqual({
      bank: 0,
      program: 0,
      resource,
    });
    expect(createProjectSoundFontAssignment(resource, { bank: 128, program: 24 })).toEqual({
      bank: 128,
      program: 24,
      resource,
    });
  });

  it('normalizes valid Project JSON without preserving unknown fields', () => {
    expect(
      normalizeSoundFontAssignment({
        bank: SOUNDFONT_BANK_MAX,
        ignored: 'value',
        program: SOUNDFONT_PROGRAM_MAX,
        resource: { ...resource, ignored: 'value' },
      }),
    ).toEqual({
      bank: SOUNDFONT_BANK_MAX,
      program: SOUNDFONT_PROGRAM_MAX,
      resource,
    });
  });

  it('migrates the former Project copy of MuseScore General to the built-in library', () => {
    expect(
      normalizeSoundFontAssignment({
        bank: 0,
        program: 0,
        resource: {
          format: 'sf3',
          library: 'project',
          relativePath: 'soundfonts/HumStudio Default/MuseScore_General.sf3',
          resourceId: `soundfont-${'b'.repeat(32)}`,
        },
      }),
    ).toMatchObject({
      resource: { library: 'builtin' },
    });
  });

  it('rejects invalid ranges, absolute paths, traversal, and format mismatches', () => {
    const invalidAssignments = [
      { bank: -1, program: 0, resource },
      { bank: SOUNDFONT_BANK_MAX + 1, program: 0, resource },
      { bank: 0, program: SOUNDFONT_PROGRAM_MAX + 1, resource },
      {
        bank: 0,
        program: 0,
        resource: { ...resource, relativePath: 'D:/SoundFonts/Keys.sf2' },
      },
      {
        bank: 0,
        program: 0,
        resource: { ...resource, relativePath: 'soundfonts/../Keys.sf2' },
      },
      {
        bank: 0,
        program: 0,
        resource: { ...resource, format: 'sf3' },
      },
    ];

    invalidAssignments.forEach((assignment) => {
      expect(normalizeSoundFontAssignment(assignment)).toBeUndefined();
    });
  });

  it('updates and clears one MIDI Clip assignment without changing another Clip', () => {
    const project = cloneProject();
    const assignment = createProjectSoundFontAssignment(resource, {
      bank: 128,
      program: 24,
    });
    const update = updateMidiClipSoundFontAssignment(
      project,
      'clip-midi-1',
      assignment,
    );

    expect(update).toMatchObject({
      canUpdate: true,
      clip: {
        id: 'clip-midi-1',
        soundFont: assignment,
        version: 2,
      },
      status: 'UPDATED',
    });

    if (!update.canUpdate) {
      throw new Error(update.message);
    }

    expect(update.project).not.toBe(project);
    expect(findClip(update.project, 'clip-midi-2').soundFont).toBeUndefined();
    const unchanged = updateMidiClipSoundFontAssignment(
      update.project,
      'clip-midi-1',
      assignment,
    );
    expect(unchanged).toMatchObject({ status: 'UNCHANGED' });

    const cleared = updateMidiClipSoundFontAssignment(
      update.project,
      'clip-midi-1',
      undefined,
    );
    expect(cleared).toMatchObject({
      canUpdate: true,
      clip: { id: 'clip-midi-1', version: 3 },
      status: 'CLEARED',
    });

    if (cleared.canUpdate) {
      expect(cleared.clip).not.toHaveProperty('soundFont');
    }
  });

  it('rejects missing, duplicated, non-MIDI, and invalid assignment targets', () => {
    const duplicate = cloneProject();
    duplicate.tracks[0].clips.push({
      ...findClip(duplicate, 'clip-midi-1'),
    });

    expect(
      updateMidiClipSoundFontAssignment(cloneProject(), 'missing', {
        bank: 0,
        program: 0,
        resource,
      }),
    ).toMatchObject({ canUpdate: false, reason: 'clip-not-found' });
    expect(
      updateMidiClipSoundFontAssignment(duplicate, 'clip-midi-1', {
        bank: 0,
        program: 0,
        resource,
      }),
    ).toMatchObject({ canUpdate: false, reason: 'clip-not-found' });
    expect(
      updateMidiClipSoundFontAssignment(cloneProject(), 'clip-hum-1', {
        bank: 0,
        program: 0,
        resource,
      }),
    ).toMatchObject({ canUpdate: false, reason: 'target-not-midi' });
    expect(
      updateMidiClipSoundFontAssignment(cloneProject(), 'clip-midi-1', {
        bank: -1,
        program: 0,
        resource,
      }),
    ).toMatchObject({ canUpdate: false, reason: 'invalid-assignment' });
  });
});

function cloneProject(): ProjectState {
  return JSON.parse(JSON.stringify(sampleProject)) as ProjectState;
}

function findClip(project: ProjectState, clipId: string) {
  const matches = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);

  if (matches.length !== 1) {
    throw new Error(`Expected one Clip: ${clipId}.`);
  }

  return matches[0];
}
