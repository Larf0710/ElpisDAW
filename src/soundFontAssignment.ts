import type {
  Clip,
  ProjectState,
  ProjectSoundFontResourceReference,
  SoundFontAssignment,
  SoundFontFormat,
} from './types';
import { HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH } from './defaultSoundFontPreset';

export const SOUNDFONT_BANK_MIN = 0;
export const SOUNDFONT_BANK_MAX = 16_383;
export const SOUNDFONT_PROGRAM_MIN = 0;
export const SOUNDFONT_PROGRAM_MAX = 127;

export type SoundFontAssignmentUpdateResult =
  | Readonly<{
      canUpdate: true;
      clip: Clip;
      project: ProjectState;
      status: 'CLEARED' | 'UNCHANGED' | 'UPDATED';
    }>
  | Readonly<{
      canUpdate: false;
      message: string;
      reason: 'clip-not-found' | 'invalid-assignment' | 'target-not-midi';
    }>;

export function createProjectSoundFontAssignment(
  resource: ProjectSoundFontResourceReference,
  { bank = 0, program = 0 }: Readonly<{ bank?: number; program?: number }> = {},
): SoundFontAssignment {
  const assignment = normalizeSoundFontAssignment({ bank, program, resource });

  if (!assignment) {
    throw new Error('SoundFont assignment is invalid.');
  }

  return assignment;
}

export function updateMidiClipSoundFontAssignment(
  project: ProjectState,
  clipId: string,
  assignment: unknown,
): SoundFontAssignmentUpdateResult {
  const target = findUniqueClip(project, clipId);

  if (!target) {
    return failUpdate(
      'clip-not-found',
      `SoundFont assignment target does not resolve uniquely: ${clipId}.`,
    );
  }

  if (target.clip.type !== 'midi-notes' && target.clip.type !== 'edited-midi') {
    return failUpdate(
      'target-not-midi',
      `${target.clip.name} is not a MIDI Clip.`,
    );
  }

  const normalizedAssignment =
    assignment === undefined
      ? undefined
      : normalizeSoundFontAssignment(assignment);

  if (assignment !== undefined && !normalizedAssignment) {
    return failUpdate(
      'invalid-assignment',
      'SoundFont assignment must reference one valid SoundFont, Bank, and Program.',
    );
  }

  if (areSoundFontAssignmentsEqual(target.clip.soundFont, normalizedAssignment)) {
    return Object.freeze({
      canUpdate: true,
      clip: target.clip,
      project,
      status: 'UNCHANGED' as const,
    });
  }

  const nextClip: Clip = normalizedAssignment
    ? {
        ...target.clip,
        soundFont: normalizedAssignment,
        version: target.clip.version + 1,
      }
    : removeSoundFontAssignment(target.clip);
  const nextProject: ProjectState = {
    ...project,
    tracks: project.tracks.map((track, trackIndex) =>
      trackIndex === target.trackIndex
        ? {
            ...track,
            clips: track.clips.map((clip, clipIndex) =>
              clipIndex === target.clipIndex ? nextClip : clip,
            ),
          }
        : track,
    ),
  };

  return Object.freeze({
    canUpdate: true,
    clip: nextClip,
    project: nextProject,
    status: normalizedAssignment ? 'UPDATED' as const : 'CLEARED' as const,
  });
}

export function normalizeSoundFontAssignment(value: unknown): SoundFontAssignment | undefined {
  if (!isRecord(value) || !isIntegerInRange(value.bank, SOUNDFONT_BANK_MIN, SOUNDFONT_BANK_MAX)) {
    return undefined;
  }

  if (!isIntegerInRange(value.program, SOUNDFONT_PROGRAM_MIN, SOUNDFONT_PROGRAM_MAX)) {
    return undefined;
  }

  const resource = normalizeProjectSoundFontResource(value.resource);

  if (!resource) {
    return undefined;
  }

  return {
    bank: value.bank,
    program: value.program,
    resource,
  };
}

function findUniqueClip(
  project: ProjectState,
  clipId: string,
):
  | Readonly<{
      clip: Clip;
      clipIndex: number;
      trackIndex: number;
    }>
  | undefined {
  const matches: {
    clip: Clip;
    clipIndex: number;
    trackIndex: number;
  }[] = [];

  project.tracks.forEach((track, trackIndex) => {
    track.clips.forEach((clip, clipIndex) => {
      if (clip.id === clipId) {
        matches.push({ clip, clipIndex, trackIndex });
      }
    });
  });

  return matches.length === 1 ? matches[0] : undefined;
}

function removeSoundFontAssignment(clip: Clip): Clip {
  const { soundFont: _soundFont, ...clipWithoutSoundFont } = clip;
  return {
    ...clipWithoutSoundFont,
    version: clip.version + 1,
  };
}

function areSoundFontAssignmentsEqual(
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

function failUpdate(
  reason: Extract<SoundFontAssignmentUpdateResult, { canUpdate: false }>['reason'],
  message: string,
): SoundFontAssignmentUpdateResult {
  return Object.freeze({
    canUpdate: false,
    message,
    reason,
  });
}

function normalizeProjectSoundFontResource(
  value: unknown,
): ProjectSoundFontResourceReference | undefined {
  if (
    !isRecord(value) ||
    (value.library !== 'builtin' && value.library !== 'project') ||
    (value.format !== 'sf2' && value.format !== 'sf3') ||
    typeof value.resourceId !== 'string' ||
    !/^soundfont-[a-f0-9]{32}$/.test(value.resourceId) ||
    typeof value.relativePath !== 'string' ||
    !isNormalizedProjectSoundFontPath(value.relativePath, value.format)
  ) {
    return undefined;
  }

  const library =
    value.relativePath === HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH
      ? 'builtin'
      : value.library;

  if (
    library === 'builtin' &&
    value.relativePath !== HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH
  ) {
    return undefined;
  }

  return {
    format: value.format,
    library,
    relativePath: value.relativePath,
    resourceId: value.resourceId,
  };
}

function isNormalizedProjectSoundFontPath(
  value: string,
  format: SoundFontFormat,
): boolean {
  const segments = value.split('/');
  return (
    value.startsWith('soundfonts/') &&
    value.toLowerCase().endsWith(`.${format}`) &&
    !value.includes('\\') &&
    segments.length > 1 &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
