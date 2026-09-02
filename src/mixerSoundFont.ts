import type { Clip, ProjectState, SoundFontAssignment, Track } from './types';

export type MixerSoundFontTargetResolution =
  | Readonly<{
      clip: Clip;
      key: string;
      status: 'READY';
      track: Track;
    }>
  | Readonly<{
      clipCount: number;
      key: string;
      message: string;
      status: 'MULTIPLE';
      track: Track;
    }>
  | Readonly<{
      key: string;
      message: string;
      status: 'UNAVAILABLE';
    }>;

export function resolveMixerSoundFontTarget(
  project: ProjectState,
): MixerSoundFontTargetResolution {
  if (project.selection.items.length !== 1) {
    return unavailable(
      'selection',
      'Select one MIDI Clip or one Track to inspect its SoundFont voice.',
    );
  }

  const selection = project.selection.items[0];

  if (selection.type === 'clip') {
    const matches = project.tracks.flatMap((track) =>
      track.clips
        .filter((clip) => clip.id === selection.id)
        .map((clip) => ({ clip, track })),
    );

    if (matches.length !== 1) {
      return unavailable(
        `clip-stale:${selection.id}`,
        'The selected Clip does not resolve uniquely.',
      );
    }

    return isMidiClip(matches[0].clip)
      ? Object.freeze({
          clip: matches[0].clip,
          key: `clip:${matches[0].clip.id}:${matches[0].clip.version}`,
          status: 'READY' as const,
          track: matches[0].track,
        })
      : unavailable(
          `clip-unsupported:${matches[0].clip.id}`,
          'SoundFont voice selection is available for MIDI Clips only.',
        );
  }

  const track = project.tracks.find((candidate) => candidate.id === selection.id);

  if (!track) {
    return unavailable(
      `track-stale:${selection.id}`,
      'The selected Track no longer exists.',
    );
  }

  const midiClips = track.clips.filter(isMidiClip);

  if (midiClips.length === 1) {
    return Object.freeze({
      clip: midiClips[0],
      key: `track:${track.id}:clip:${midiClips[0].id}:${midiClips[0].version}`,
      status: 'READY' as const,
      track,
    });
  }

  if (midiClips.length > 1) {
    return Object.freeze({
      clipCount: midiClips.length,
      key: `track-multiple:${track.id}:${midiClips.map((clip) => `${clip.id}:${clip.version}`).join(',')}`,
      message:
        'MULTIPLE VOICES: Select one MIDI Clip to preview or change its SoundFont voice.',
      status: 'MULTIPLE' as const,
      track,
    });
  }

  return unavailable(
    `track-unsupported:${track.id}`,
    'The selected Track does not contain a MIDI Clip.',
  );
}

export function areSoundFontAssignmentsEqual(
  left: SoundFontAssignment | undefined,
  right: SoundFontAssignment | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.bank === right.bank &&
      left.program === right.program &&
      left.resource.format === right.resource.format &&
      left.resource.library === right.resource.library &&
      left.resource.relativePath === right.resource.relativePath &&
      left.resource.resourceId === right.resource.resourceId)
  );
}

function isMidiClip(clip: Clip): boolean {
  return clip.type === 'midi-notes' || clip.type === 'edited-midi';
}

function unavailable(key: string, message: string): MixerSoundFontTargetResolution {
  return Object.freeze({ key, message, status: 'UNAVAILABLE' as const });
}
