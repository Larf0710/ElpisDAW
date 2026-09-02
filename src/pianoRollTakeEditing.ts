import { resolveActiveMidiTake } from './activeMidiTake';
import { normalizeMidiNotes } from './humToMidiContract';
import { createMidiContentHash } from './midiContentHash';
import { createEditedMidiArtifact } from './midiEditArtifact';
import { resolveWholeBarMidiClipLength } from './midiNoteTiming';
import { createMidiArtifactRegistration } from './projectArtifactRegistration';
import type {
  Clip,
  EditedMidiArtifact,
  EditedMidiClipTake,
  ManualMidiArtifact,
  ManualMidiClipTake,
  MidiArtifact,
  MidiClipTake,
  MidiNote,
  ProjectState,
} from './types';
import { TICKS_PER_QUARTER } from './workflow';

export type PianoRollTakeIdentity = Readonly<{
  artifactId: string;
  createdAt: string;
  sourceEditId: string;
}>;

export type SavePianoRollTakeOptions = Readonly<{
  clipId: string;
  identity?: PianoRollTakeIdentity;
  notes: readonly MidiNote[];
}>;

export type SavePianoRollTakeResult =
  | Readonly<{
      canSave: true;
      clipTake: EditedMidiClipTake | ManualMidiClipTake;
      project: ProjectState;
      status: 'CREATED' | 'SAVED' | 'UNCHANGED';
    }>
  | Readonly<{
      canSave: false;
      message: string;
    }>;

export function savePianoRollTake(
  project: ProjectState,
  options: SavePianoRollTakeOptions,
): SavePianoRollTakeResult {
  const clipLengthUpdate = extendPianoRollMidiClipToFitNotes(
    project,
    options.clipId,
    options.notes,
  );
  const source = resolvePianoRollSource(
    clipLengthUpdate.project,
    options.clipId,
  );

  if ('canSave' in source) {
    return source;
  }

  if (
    source.clipTake.sourceType === 'edit' ||
    source.clipTake.sourceType === 'manual'
  ) {
    const result = overwriteEditableMidiTake(
      clipLengthUpdate.project,
      source.clip,
      source.clipTake,
      source.artifact,
      options.notes,
      options.identity?.createdAt ?? new Date().toISOString(),
      options.identity,
    );

    return finalizeClipLengthOnlySave(
      result,
      clipLengthUpdate.didExtend,
      options.clipId,
    );
  }

  if (!options.identity) {
    return {
      canSave: false,
      message: 'Creating an Edited MIDI Take requires a new Take identity.',
    };
  }

  return createEditedTake(
    clipLengthUpdate.project,
    source.clip,
    source.clipTake,
    source.artifact,
    options.notes,
    options.identity,
  );
}

export function createNewPianoRollTake(
  project: ProjectState,
  options: SavePianoRollTakeOptions & Readonly<{ identity: PianoRollTakeIdentity }>,
): SavePianoRollTakeResult {
  const clipLengthUpdate = extendPianoRollMidiClipToFitNotes(
    project,
    options.clipId,
    options.notes,
  );
  const source = resolvePianoRollSource(
    clipLengthUpdate.project,
    options.clipId,
  );

  if ('canSave' in source) {
    return source;
  }

  return createEditedTake(
    clipLengthUpdate.project,
    source.clip,
    source.clipTake,
    source.artifact,
    options.notes,
    options.identity,
  );
}

export function isPianoRollTakeShared(
  project: ProjectState,
  source: Readonly<{ artifactId: string; clipId: string; clipTakeId: string }>,
): boolean {
  return project.tracks.some((track) => track.clips.some((clip) =>
    clip.clipTakes?.some((take) =>
      take.artifactId === source.artifactId &&
      (clip.id !== source.clipId || take.clipTakeId !== source.clipTakeId),
    ),
  ));
}

function createEditedTake(
  project: ProjectState,
  clip: Clip,
  sourceClipTake: MidiClipTake,
  sourceArtifact: MidiArtifact,
  notes: readonly MidiNote[],
  identity: PianoRollTakeIdentity,
): SavePianoRollTakeResult {
  let artifact: EditedMidiArtifact;

  try {
    artifact = createEditedMidiArtifact({
      artifactId: identity.artifactId,
      createdAt: identity.createdAt,
      notes,
      sourceArtifact,
      sourceClipTake,
      sourceEditId: identity.sourceEditId,
    });
  } catch (error) {
    return {
      canSave: false,
      message:
        error instanceof Error
          ? error.message
          : 'Edited MIDI Take creation failed.',
    };
  }

  const registration = createMidiArtifactRegistration(project, artifact, {
    clipId: clip.id,
    label: createEditedTakeLabel(clip),
  });

  if (
    !registration.canRegister ||
    registration.clipTake.sourceType !== 'edit'
  ) {
    return {
      canSave: false,
      message: registration.canRegister
        ? 'Edited MIDI Take registration returned an invalid Take.'
        : registration.message,
    };
  }

  return {
    canSave: true,
    clipTake: registration.clipTake,
    project: registration.project,
    status: 'CREATED',
  };
}

function overwriteEditableMidiTake(
  project: ProjectState,
  clip: Clip,
  clipTake: EditedMidiClipTake | ManualMidiClipTake,
  artifact: MidiArtifact,
  notesValue: readonly MidiNote[],
  updatedAtValue: string,
  identity?: PianoRollTakeIdentity,
): SavePianoRollTakeResult {
  const isMatchingEditableSource =
    (clipTake.sourceType === 'edit' &&
      'sourceEditId' in artifact &&
      clipTake.sourceEditId === artifact.sourceEditId) ||
    (clipTake.sourceType === 'manual' &&
      'sourceManualId' in artifact &&
      clipTake.sourceManualId === artifact.sourceManualId);

  if (!isMatchingEditableSource) {
    return {
      canSave: false,
      message: `${clipTake.label} does not reference a matching editable MIDI Artifact.`,
    };
  }

  let notes: MidiNote[];

  try {
    notes = normalizeMidiNotes(notesValue);
  } catch (error) {
    return {
      canSave: false,
      message:
        error instanceof Error ? error.message : 'Edited MIDI notes are invalid.',
    };
  }

  const updatedAt = normalizeTimestamp(updatedAtValue);

  if (!updatedAt) {
    return {
      canSave: false,
      message: 'Edited MIDI Take save timestamp is invalid.',
    };
  }

  const contentHash = createMidiContentHash({
    bpm: artifact.midi.bpm,
    notes,
    ticksPerQuarter: artifact.midi.ticksPerQuarter,
  });
  const previousHash =
    artifact.contentHash ??
    createMidiContentHash({
      bpm: artifact.midi.bpm,
      notes: artifact.midi.notes,
      ticksPerQuarter: artifact.midi.ticksPerQuarter,
    });

  if (contentHash === previousHash) {
    return {
      canSave: true,
      clipTake: {
        ...clipTake,
        contentHash: previousHash,
        revision: clipTake.revision ?? artifact.revision ?? 1,
        updatedAt: clipTake.updatedAt ?? artifact.updatedAt ?? artifact.createdAt,
      },
      project,
      status: 'UNCHANGED',
    };
  }

  if (isPianoRollTakeShared(project, {
    artifactId: artifact.artifactId,
    clipId: clip.id,
    clipTakeId: clipTake.clipTakeId,
  })) {
    if (!identity) {
      return {
        canSave: false,
        message: 'Saving a shared MIDI Take requires a new Take identity.',
      };
    }

    // Preserve every shared reference, including inactive Takes and their lineage.
    return createEditedTake(project, clip, clipTake, artifact, notes, identity);
  }

  const revision = Math.max(
    artifact.revision ?? 1,
    clipTake.revision ?? 1,
  ) + 1;
  const editableArtifact = artifact as
    | EditedMidiArtifact
    | ManualMidiArtifact;
  const nextArtifact: EditedMidiArtifact | ManualMidiArtifact = {
    ...editableArtifact,
    contentHash,
    midi: {
      ...artifact.midi,
      notes,
    },
    revision,
    updatedAt,
  };
  const nextClipTake: EditedMidiClipTake | ManualMidiClipTake = {
    ...clipTake,
    contentHash,
    revision,
    updatedAt,
  };
  const nextClip: Clip = {
    ...clip,
    clipTakes: (clip.clipTakes ?? []).map((candidate) =>
      candidate.clipTakeId === clipTake.clipTakeId
        ? nextClipTake
        : candidate,
    ),
    version: clip.version + 1,
  };
  const nextProject: ProjectState = {
    ...project,
    artifacts: (project.artifacts ?? []).map((candidate) =>
      candidate.artifactId === artifact.artifactId
        ? nextArtifact
        : candidate,
    ),
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((candidate) =>
        candidate.id === clip.id ? nextClip : candidate,
      ),
    })),
  };

  return {
    canSave: true,
    clipTake: nextClipTake,
    project: nextProject,
    status: 'SAVED',
  };
}

export function getPianoRollClipLengthForNotes(
  currentLengthTicks: number,
  notes: readonly MidiNote[],
): number {
  const resolution = resolveWholeBarMidiClipLength(
    currentLengthTicks,
    notes,
    TICKS_PER_QUARTER,
  );

  return resolution.canResolve
    ? resolution.lengthTicks
    : currentLengthTicks;
}

function extendPianoRollMidiClipToFitNotes(
  project: ProjectState,
  clipId: string,
  notes: readonly MidiNote[],
): Readonly<{ didExtend: boolean; project: ProjectState }> {
  const matchingClips = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);
  const clip = matchingClips.length === 1 ? matchingClips[0] : undefined;

  if (
    !clip ||
    (clip.type !== 'midi-notes' && clip.type !== 'edited-midi')
  ) {
    return { didExtend: false, project };
  }

  const nextLengthTicks = getPianoRollClipLengthForNotes(
    clip.lengthTicks,
    notes,
  );
  const nextProjectEndTick = clip.startTick + nextLengthTicks;

  if (
    nextLengthTicks === clip.lengthTicks ||
    !Number.isSafeInteger(nextProjectEndTick)
  ) {
    return { didExtend: false, project };
  }

  return {
    didExtend: true,
    project: {
      ...project,
      totalTicks: Math.max(project.totalTicks, nextProjectEndTick),
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((candidate) =>
          candidate.id === clip.id
            ? {
                ...candidate,
                lengthTicks: nextLengthTicks,
              }
            : candidate,
        ),
      })),
    },
  };
}

function finalizeClipLengthOnlySave(
  result: SavePianoRollTakeResult,
  didExtend: boolean,
  clipId: string,
): SavePianoRollTakeResult {
  if (!result.canSave || !didExtend || result.status !== 'UNCHANGED') {
    return result;
  }

  return {
    ...result,
    project: {
      ...result.project,
      tracks: result.project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === clipId
            ? {
                ...clip,
                version: clip.version + 1,
              }
            : clip,
        ),
      })),
    },
    status: 'SAVED',
  };
}

function resolvePianoRollSource(
  project: ProjectState,
  clipId: string,
):
  | Readonly<{
      artifact: MidiArtifact;
      canResolve: true;
      clip: Clip;
      clipTake: MidiClipTake;
    }>
  | Readonly<{ canSave: false; message: string }> {
  const resolution = resolveActiveMidiTake(project, clipId);

  if (!resolution.canResolve) {
    return { canSave: false, message: resolution.message };
  }

  const clipMatches = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);
  const artifactMatches = (project.artifacts ?? []).filter(
    (artifact): artifact is MidiArtifact =>
      artifact.artifactId === resolution.plan.source.artifactId &&
      artifact.kind === 'midi',
  );
  const takeMatches = (clipMatches[0]?.clipTakes ?? []).filter(
    (take): take is MidiClipTake =>
      take.clipTakeId === resolution.plan.source.clipTakeId &&
      take.mediaType === 'midi',
  );

  if (
    clipMatches.length !== 1 ||
    artifactMatches.length !== 1 ||
    takeMatches.length !== 1
  ) {
    return {
      canSave: false,
      message: 'Active MIDI Take does not resolve uniquely for Piano Roll editing.',
    };
  }

  return {
    artifact: artifactMatches[0],
    canResolve: true,
    clip: clipMatches[0],
    clipTake: takeMatches[0],
  };
}

function createEditedTakeLabel(clip: Clip): string {
  const takeNumber = (clip.clipTakes?.length ?? 0) + 1;
  return `Edited Take ${String(takeNumber).padStart(2, '0')}`;
}

function normalizeTimestamp(value: string): string | undefined {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
}
