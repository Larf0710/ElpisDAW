import { doesClipTakeMatchArtifact } from './clipTakeActivation';
import { normalizeMidiNotes } from './humToMidiContract';
import { createMidiContentHash } from './midiContentHash';
import {
  RECORDING_BPM_MAX,
  RECORDING_BPM_MIN,
} from './recordingTiming';
import type {
  Clip,
  ClipTake,
  MidiArtifact,
  MidiClipTake,
  MidiNote,
  ProjectArtifact,
  ProjectState,
} from './types';
import { TICKS_PER_QUARTER } from './workflow';

export type ActiveMidiTakeFailureReason =
  | 'active-take-not-found'
  | 'active-take-not-midi'
  | 'active-take-not-selected'
  | 'artifact-not-found'
  | 'artifact-not-midi'
  | 'clip-not-found'
  | 'lineage-invalid'
  | 'midi-invalid'
  | 'source-mismatch'
  | 'target-not-midi';

export type ActiveMidiTakePlan = Readonly<{
  midi: Readonly<{
    bpm: number;
    notes: readonly MidiNote[];
    ticksPerQuarter: typeof TICKS_PER_QUARTER;
  }>;
  source: Readonly<{
    artifactId: string;
    clipId: string;
    clipTakeId: string;
    contentHash: string;
    label: string;
    revision: number;
    sourceType: MidiClipTake['sourceType'];
  }>;
}>;

export type ActiveMidiTakeResolution =
  | Readonly<{
      canResolve: true;
      plan: ActiveMidiTakePlan;
    }>
  | Readonly<{
      canResolve: false;
      message: string;
      reason: ActiveMidiTakeFailureReason;
    }>;

const MIDI_CLIP_TYPES = new Set<Clip['type']>([
  'edited-midi',
  'midi-notes',
]);

export function resolveActiveMidiTake(
  project: ProjectState,
  clipId: string,
): ActiveMidiTakeResolution {
  const clip = findUniqueClip(project, clipId);

  if (!clip) {
    return fail('clip-not-found', `MIDI Clip was not found: ${clipId}.`);
  }

  if (!MIDI_CLIP_TYPES.has(clip.type)) {
    return fail(
      'target-not-midi',
      `${clip.name} cannot provide MIDI for Instrument Render.`,
    );
  }

  if (!clip.activeClipTakeId) {
    return fail(
      'active-take-not-selected',
      `${clip.name} does not have an Active MIDI Take.`,
    );
  }

  const matchingTakes = (clip.clipTakes ?? []).filter(
    (take) => take.clipTakeId === clip.activeClipTakeId,
  );

  if (matchingTakes.length !== 1) {
    return fail(
      'active-take-not-found',
      `${clip.name} Active Take does not resolve uniquely.`,
    );
  }

  const activeTake = matchingTakes[0];

  if (activeTake.mediaType !== 'midi') {
    return fail(
      'active-take-not-midi',
      `${clip.name} Active Take does not contain MIDI.`,
    );
  }

  const matchingArtifacts = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === activeTake.artifactId,
  );

  if (matchingArtifacts.length !== 1) {
    return fail(
      'artifact-not-found',
      `${clip.name} Active MIDI Artifact does not resolve uniquely.`,
    );
  }

  const activeArtifact = matchingArtifacts[0];

  if (activeArtifact.kind !== 'midi') {
    return fail(
      'artifact-not-midi',
      `${clip.name} Active Take references a non-MIDI Artifact.`,
    );
  }

  if (!doesClipTakeMatchArtifact(activeTake, activeArtifact)) {
    return fail(
      'source-mismatch',
      `${clip.name} Active Take source does not match its MIDI Artifact.`,
    );
  }

  if (!hasValidMidiLineage(project, activeArtifact, new Set<string>())) {
    return fail(
      'lineage-invalid',
      `${clip.name} Active MIDI Take has incomplete or circular Lineage.`,
    );
  }

  let notes: MidiNote[];

  try {
    notes = normalizeMidiNotes(activeArtifact.midi.notes);
  } catch {
    return fail(
      'midi-invalid',
      `${clip.name} Active MIDI Take contains invalid notes.`,
    );
  }

  if (
    activeArtifact.midi.ticksPerQuarter !== TICKS_PER_QUARTER ||
    typeof activeArtifact.midi.bpm !== 'number' ||
    !Number.isFinite(activeArtifact.midi.bpm) ||
    activeArtifact.midi.bpm < RECORDING_BPM_MIN ||
    activeArtifact.midi.bpm > RECORDING_BPM_MAX
  ) {
    return fail(
      'midi-invalid',
      `${clip.name} Active MIDI Take has invalid timing metadata.`,
    );
  }

  const midi = Object.freeze({
    bpm: activeArtifact.midi.bpm,
    notes,
    ticksPerQuarter: TICKS_PER_QUARTER,
  });
  const source = Object.freeze({
    artifactId: activeArtifact.artifactId,
    clipId: clip.id,
    clipTakeId: activeTake.clipTakeId,
    contentHash:
      'contentHash' in activeArtifact &&
      typeof activeArtifact.contentHash === 'string'
        ? activeArtifact.contentHash
        : createMidiContentHash(midi),
    label: activeTake.label,
    revision:
      activeTake.sourceType === 'edit' || activeTake.sourceType === 'manual'
        ? Math.max(
            activeTake.revision ?? 1,
            'revision' in activeArtifact
              ? activeArtifact.revision ?? 1
              : 1,
          )
        : 1,
    sourceType: activeTake.sourceType,
  });

  return Object.freeze({
    canResolve: true,
    plan: Object.freeze({ midi, source }),
  });
}

function hasValidMidiLineage(
  project: ProjectState,
  artifact: MidiArtifact,
  visitedArtifactIds: Set<string>,
): boolean {
  if (visitedArtifactIds.has(artifact.artifactId)) {
    return false;
  }

  const nextVisitedArtifactIds = new Set(visitedArtifactIds);
  nextVisitedArtifactIds.add(artifact.artifactId);

  if ('sourceManualId' in artifact) {
    return (
      artifact.lineage.parentArtifactIds.length === 0 &&
      artifact.lineage.parentClipTakeIds.length === 0
    );
  }

  if ('sourceOperationId' in artifact && 'printMixProvenance' in artifact) {
    if (
      artifact.lineage.parentArtifactIds.length < 2 ||
      artifact.lineage.parentArtifactIds.length !==
        artifact.lineage.parentClipTakeIds.length
    ) {
      return false;
    }

    return artifact.lineage.parentArtifactIds.every(
      (parentArtifactId, index) => {
        const parentArtifact = findUniqueArtifact(project, parentArtifactId);
        const parentTake = findUniqueTake(
          project,
          artifact.lineage.parentClipTakeIds[index],
        );

        return Boolean(
          parentArtifact?.kind === 'midi' &&
            parentTake?.mediaType === 'midi' &&
            parentTake.artifactId === parentArtifact.artifactId &&
            doesClipTakeMatchArtifact(parentTake, parentArtifact) &&
            hasValidMidiLineage(
              project,
              parentArtifact,
              nextVisitedArtifactIds,
            ),
        );
      },
    );
  }

  if (
    artifact.lineage.parentArtifactIds.length !== 1 ||
    artifact.lineage.parentClipTakeIds.length !== 1
  ) {
    return false;
  }

  const parentArtifact = findUniqueArtifact(
    project,
    artifact.lineage.parentArtifactIds[0],
  );
  const parentTake = findUniqueTake(
    project,
    artifact.lineage.parentClipTakeIds[0],
  );

  if (
    !parentArtifact ||
    !parentTake ||
    parentTake.artifactId !== parentArtifact.artifactId
  ) {
    return false;
  }

  if ('sourceJobId' in artifact) {
    return (
      parentArtifact.kind === 'audio' &&
      parentTake.mediaType === 'audio' &&
      doesClipTakeMatchArtifact(parentTake, parentArtifact)
    );
  }

  return (
    parentArtifact.kind === 'midi' &&
    parentTake.mediaType === 'midi' &&
    doesClipTakeMatchArtifact(parentTake, parentArtifact) &&
    hasValidMidiLineage(
      project,
      parentArtifact,
      nextVisitedArtifactIds,
    )
  );
}

function findUniqueClip(
  project: ProjectState,
  clipId: string,
): Clip | undefined {
  const clips = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);

  return clips.length === 1 ? clips[0] : undefined;
}

function findUniqueArtifact(
  project: ProjectState,
  artifactId: string,
): ProjectArtifact | undefined {
  const artifacts = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === artifactId,
  );

  return artifacts.length === 1 ? artifacts[0] : undefined;
}

function findUniqueTake(
  project: ProjectState,
  clipTakeId: string,
): ClipTake | undefined {
  const takes = project.tracks
    .flatMap((track) => track.clips)
    .flatMap((clip) => clip.clipTakes ?? [])
    .filter((take) => take.clipTakeId === clipTakeId);

  return takes.length === 1 ? takes[0] : undefined;
}

function fail(
  reason: ActiveMidiTakeFailureReason,
  message: string,
): ActiveMidiTakeResolution {
  return Object.freeze({
    canResolve: false,
    message,
    reason,
  });
}
