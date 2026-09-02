import { createMidiContentHash } from './midiContentHash';
import { createMidiArtifactRegistration } from './projectArtifactRegistration';
import { getClipTypeColor } from './clipTypeColors';
import {
  RECORDING_BPM_MAX,
  RECORDING_BPM_MIN,
} from './recordingTiming';
import type {
  Clip,
  ManualMidiArtifact,
  ManualMidiClipTake,
  ProjectState,
  Track,
} from './types';
import { TICKS_PER_QUARTER } from './workflow';

export const MANUAL_MIDI_BEATS_PER_BAR = 4;
export const MANUAL_MIDI_DEFAULT_BARS = 4;
export const MANUAL_MIDI_DEFAULT_LENGTH_TICKS =
  TICKS_PER_QUARTER *
  MANUAL_MIDI_BEATS_PER_BAR *
  MANUAL_MIDI_DEFAULT_BARS;

const MANUAL_MIDI_EDITOR_ID = 'piano-roll';
const MANUAL_MIDI_EDITOR_VERSION = '1';
const MANUAL_MIDI_TASK_ID = 'manual-midi';

export type CreateManualMidiClipResult =
  | Readonly<{
      artifact: ManualMidiArtifact;
      canCreate: true;
      clip: Clip;
      clipTake: ManualMidiClipTake;
      project: ProjectState;
      track: Track;
    }>
  | Readonly<{
      canCreate: false;
      message: string;
    }>;

export function createManualMidiClip(
  project: ProjectState,
  options: Readonly<{
    createdAt: string;
    startTick: number;
  }>,
): CreateManualMidiClipResult {
  const createdAt = normalizeTimestamp(options.createdAt);

  if (!createdAt) {
    return {
      canCreate: false,
      message: 'Manual MIDI Clip creation requires a valid timestamp.',
    };
  }

  if (
    !Number.isSafeInteger(options.startTick) ||
    options.startTick < 0 ||
    options.startTick > project.totalTicks
  ) {
    return {
      canCreate: false,
      message: 'Manual MIDI Clip start tick is outside the Project.',
    };
  }

  if (
    typeof project.bpm !== 'number' ||
    !Number.isFinite(project.bpm) ||
    project.bpm < RECORDING_BPM_MIN ||
    project.bpm > RECORDING_BPM_MAX
  ) {
    return {
      canCreate: false,
      message: 'Manual MIDI Clip creation requires valid Project timing.',
    };
  }

  const identity = createManualMidiIdentity(project);
  const midi = {
    bpm: project.bpm,
    notes: [],
    ticksPerQuarter: TICKS_PER_QUARTER,
  };
  const artifact: ManualMidiArtifact = {
    artifactId: identity.artifactId,
    contentHash: createMidiContentHash(midi),
    createdAt,
    kind: 'midi',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    manualProvenance: {
      editorId: MANUAL_MIDI_EDITOR_ID,
      editorVersion: MANUAL_MIDI_EDITOR_VERSION,
      taskId: MANUAL_MIDI_TASK_ID,
    },
    midi,
    revision: 1,
    sourceManualId: identity.sourceManualId,
    updatedAt: createdAt,
  };
  const clip: Clip = {
    color: getClipTypeColor('midi-notes'),
    createdAt,
    id: identity.clipId,
    lengthTicks: MANUAL_MIDI_DEFAULT_LENGTH_TICKS,
    name: `MIDI Clip ${identity.displayNumber}`,
    startTick: options.startTick,
    type: 'midi-notes',
    version: 1,
  };
  const track: Track = {
    clips: [clip],
    id: identity.trackId,
    level: -6,
    name: `MIDI ${identity.displayNumber}`,
    parentGroupId: null,
    type: 'midi',
  };
  const projectWithTarget: ProjectState = {
    ...project,
    totalTicks: Math.max(
      project.totalTicks,
      clip.startTick + clip.lengthTicks,
    ),
    tracks: [...project.tracks, track],
  };
  const registration = createMidiArtifactRegistration(
    projectWithTarget,
    artifact,
    {
      clipId: clip.id,
      label: `Manual Take ${identity.displayNumber}`,
    },
  );

  if (
    !registration.canRegister ||
    registration.clipTake.sourceType !== 'manual' ||
    !('sourceManualId' in registration.artifact)
  ) {
    return {
      canCreate: false,
      message: registration.canRegister
        ? 'Manual MIDI Clip registration returned an invalid Take.'
        : registration.message,
    };
  }

  const createdTrack = registration.project.tracks.find(
    (candidate) => candidate.id === track.id,
  );
  const createdClip = createdTrack?.clips.find(
    (candidate) => candidate.id === clip.id,
  );

  if (!createdTrack || !createdClip) {
    return {
      canCreate: false,
      message: 'Manual MIDI Clip registration lost its target Track or Clip.',
    };
  }

  return {
    artifact: registration.artifact,
    canCreate: true,
    clip: createdClip,
    clipTake: registration.clipTake,
    project: registration.project,
    track: createdTrack,
  };
}

function createManualMidiIdentity(project: ProjectState): Readonly<{
  artifactId: string;
  clipId: string;
  displayNumber: string;
  sourceManualId: string;
  trackId: string;
}> {
  const artifactIds = new Set(
    (project.artifacts ?? []).map((artifact) => artifact.artifactId),
  );
  const clipIds = new Set(
    project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  const sourceManualIds = new Set(
    (project.artifacts ?? [])
      .filter(
        (artifact): artifact is ManualMidiArtifact =>
          artifact.kind === 'midi' && 'sourceManualId' in artifact,
      )
      .map((artifact) => artifact.sourceManualId),
  );
  const trackIds = new Set(project.tracks.map((track) => track.id));

  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const artifactId = `artifact-manual-midi-${index}`;
    const clipId = `clip-manual-midi-${index}`;
    const sourceManualId = `manual-midi-${index}`;
    const trackId = `track-manual-midi-${index}`;

    if (
      !artifactIds.has(artifactId) &&
      !clipIds.has(clipId) &&
      !sourceManualIds.has(sourceManualId) &&
      !trackIds.has(trackId)
    ) {
      return {
        artifactId,
        clipId,
        displayNumber: String(index).padStart(2, '0'),
        sourceManualId,
        trackId,
      };
    }
  }

  throw new Error('Unable to allocate a unique Manual MIDI identity.');
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
}
