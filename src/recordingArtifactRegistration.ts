import { parseLocalEngineRecordingArtifact } from './localEngineClient';
import type { LocalEngineRecordingArtifact } from './localEngineClient';
import { getClipTypeColor } from './clipTypeColors';
import type {
  Clip,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
  Track,
} from './types';
import {
  clampTick,
  TICKS_PER_BEAT,
} from './workflow';

const MICROPHONE_RECORDING_GENERATOR = 'Microphone Recording';

export type RecordingArtifactRegistrationOptions = Readonly<{
  inputDeviceId?: string;
  inputDeviceLabel?: string;
  maximumEndTick?: number;
  startTick: number;
  targetClipId?: string;
  targetTrackId?: string;
}>;

export type RecordingArtifactRegistrationFailureReason =
  | 'artifact-conflict'
  | 'clip-not-found'
  | 'recording-invalid'
  | 'target-not-hum-audio'
  | 'target-not-recordable-track'
  | 'track-not-found';

export type RecordingArtifactRegistrationUpdate =
  | Readonly<{
      artifact: RecordingAudioArtifact;
      canRegister: true;
      clip: Clip;
      clipTake: RecordingAudioClipTake;
      project: ProjectState;
      status: 'ALREADY_REGISTERED' | 'REGISTERED';
    }>
  | Readonly<{
      canRegister: false;
      message: string;
      reason: RecordingArtifactRegistrationFailureReason;
    }>;

export function createRecordingArtifactRegistration(
  project: ProjectState,
  recordingValue: LocalEngineRecordingArtifact,
  options: RecordingArtifactRegistrationOptions,
): RecordingArtifactRegistrationUpdate {
  const recording = parseLocalEngineRecordingArtifact(recordingValue);

  if (
    !recording ||
    recording.audio.channels !== 1 ||
    !Number.isFinite(options.startTick)
  ) {
    return {
      canRegister: false,
      message: 'Recording registration requires valid finalized WAV metadata and a finite start tick.',
      reason: 'recording-invalid',
    };
  }

  if (
    options.maximumEndTick !== undefined &&
    (!Number.isSafeInteger(options.maximumEndTick) ||
      options.maximumEndTick <= options.startTick)
  ) {
    return {
      canRegister: false,
      message: 'Recording registration requires a maximum end tick after the recording start.',
      reason: 'recording-invalid',
    };
  }

  const requestedTarget = options.targetClipId
    ? findClip(project, options.targetClipId)
    : undefined;

  if (options.targetClipId && !requestedTarget) {
    return {
      canRegister: false,
      message: `Recording target Clip was not found: ${options.targetClipId}.`,
      reason: 'clip-not-found',
    };
  }

  if (requestedTarget && requestedTarget.clip.type !== 'hum-audio') {
    return {
      canRegister: false,
      message: `${requestedTarget.clip.name} cannot receive a Recording Take.`,
      reason: 'target-not-hum-audio',
    };
  }

  const requestedTrackIndex =
    options.targetTrackId && !requestedTarget
      ? project.tracks.findIndex((track) => track.id === options.targetTrackId)
      : -1;
  const canCreateDefaultHumTrack =
    options.targetTrackId === 'hum-audio' && requestedTrackIndex < 0;
  const requestedTrack =
    requestedTrackIndex >= 0 ? project.tracks[requestedTrackIndex] : undefined;

  if (
    options.targetTrackId &&
    !requestedTarget &&
    requestedTrackIndex < 0 &&
    !canCreateDefaultHumTrack
  ) {
    return {
      canRegister: false,
      message: `Recording target Track was not found: ${options.targetTrackId}.`,
      reason: 'track-not-found',
    };
  }

  if (
    requestedTrack &&
    (requestedTrack.group ||
      (requestedTrack.type !== 'audio' && requestedTrack.type !== 'blank'))
  ) {
    return {
      canRegister: false,
      message: `${requestedTrack.name} cannot receive a microphone Recording Clip.`,
      reason: 'target-not-recordable-track',
    };
  }

  const artifact = createProjectRecordingArtifact(recording, options);
  const artifacts = project.artifacts ?? [];
  const existingArtifact = artifacts.find(
    (candidate) => candidate.artifactId === artifact.artifactId,
  );
  const existingTakeLocations = findRecordingTakeLocations(project, artifact.artifactId);

  if (
    existingArtifact?.kind === 'audio' &&
    existingArtifact.destination === 'recording' &&
    existingArtifact.capture.source === 'microphone' &&
    JSON.stringify(existingArtifact) === JSON.stringify(artifact) &&
    existingTakeLocations.length === 1 &&
    (!requestedTarget ||
      existingTakeLocations[0].clip.id === requestedTarget.clip.id) &&
    (!requestedTrack ||
      existingTakeLocations[0].trackIndex === requestedTrackIndex)
  ) {
    const existing = existingTakeLocations[0];

    return {
      artifact: existingArtifact as RecordingAudioArtifact,
      canRegister: true,
      clip: existing.clip,
      clipTake: existing.clipTake,
      project,
      status: 'ALREADY_REGISTERED',
    };
  }

  if (existingArtifact || existingTakeLocations.length > 0) {
    return {
      canRegister: false,
      message: `Recording Artifact ${artifact.artifactId} is already registered elsewhere or with different metadata.`,
      reason: 'artifact-conflict',
    };
  }

  if (requestedTarget) {
    return registerTakeOnExistingClip(
      project,
      artifacts,
      artifact,
      requestedTarget,
      options.maximumEndTick,
    );
  }

  return registerTakeOnNewClip(
    project,
    artifacts,
    artifact,
    options.startTick,
    options.maximumEndTick,
    options.targetTrackId,
  );
}

function registerTakeOnExistingClip(
  project: ProjectState,
  artifacts: NonNullable<ProjectState['artifacts']>,
  artifact: RecordingAudioArtifact,
  target: ClipLocation,
  maximumEndTick?: number,
): RecordingArtifactRegistrationUpdate {
  const clipTake = createRecordingClipTake(artifact, target.clip);
  const nextClip = applyActiveRecordingTake(
    project,
    target.clip,
    artifact,
    clipTake,
    maximumEndTick,
  );
  const nextProject: ProjectState = {
    ...project,
    artifacts: [...artifacts, artifact],
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

  return {
    artifact,
    canRegister: true,
    clip: nextClip,
    clipTake,
    project: nextProject,
    status: 'REGISTERED',
  };
}

function registerTakeOnNewClip(
  project: ProjectState,
  artifacts: NonNullable<ProjectState['artifacts']>,
  artifact: RecordingAudioArtifact,
  requestedStartTick: number,
  maximumEndTick?: number,
  targetTrackId?: string,
): RecordingArtifactRegistrationUpdate {
  const tracks =
    targetTrackId && targetTrackId !== 'hum-audio'
      ? project.tracks
      : ensureHumAudioTrack(project.tracks);
  const trackIndex = tracks.findIndex(
    (track) => track.id === (targetTrackId ?? 'hum-audio'),
  );
  const track = tracks[trackIndex];
  const clip = createRecordingClip(
    project,
    track,
    artifact,
    requestedStartTick,
    maximumEndTick,
  );
  const clipTake = createRecordingClipTake(artifact, clip);
  const nextClip = applyActiveRecordingTake(
    project,
    clip,
    artifact,
    clipTake,
    maximumEndTick,
  );
  const nextProject: ProjectState = {
    ...project,
    artifacts: [...artifacts, artifact],
    tracks: tracks.map((candidate, candidateIndex) =>
      candidateIndex === trackIndex
        ? {
            ...candidate,
            clips: [...candidate.clips, nextClip],
            type: candidate.type === 'blank' ? 'audio' : candidate.type,
          }
        : candidate,
    ),
  };

  return {
    artifact,
    canRegister: true,
    clip: nextClip,
    clipTake,
    project: nextProject,
    status: 'REGISTERED',
  };
}

function createProjectRecordingArtifact(
  recording: LocalEngineRecordingArtifact,
  options: RecordingArtifactRegistrationOptions,
): RecordingAudioArtifact {
  const inputDeviceId = normalizeCaptureText(options.inputDeviceId, 512);
  const inputDeviceLabel = normalizeCaptureText(options.inputDeviceLabel, 256);

  return {
    artifactId: recording.artifactId,
    audio: { ...recording.audio, channels: 1 },
    capture: {
      ...(inputDeviceId ? { inputDeviceId } : {}),
      ...(inputDeviceLabel ? { inputDeviceLabel } : {}),
      source: 'microphone',
    },
    createdAt: recording.createdAt,
    destination: 'recording',
    file: { ...recording.file },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
  };
}

function createRecordingClip(
  project: ProjectState,
  track: Track,
  artifact: RecordingAudioArtifact,
  requestedStartTick: number,
  maximumEndTick?: number,
): Clip {
  const safeTotalTicks = Math.max(1, project.totalTicks);
  const startTick = clampTick(Math.round(requestedStartTick), 0, safeTotalTicks - 1);
  const partNumber =
    track.clips.filter((candidate) => candidate.type === 'hum-audio').length + 1;

  return {
    id: `clip-recording-${artifact.artifactId}`,
    type: 'hum-audio',
    name: `Hum Part ${String(partNumber).padStart(2, '0')}`,
    startTick,
    lengthTicks: resolveRecordingLengthTicks(
      project,
      startTick,
      artifact,
      maximumEndTick,
    ),
    color: getClipTypeColor('hum-audio'),
    generatedBy: MICROPHONE_RECORDING_GENERATOR,
    createdAt: artifact.createdAt,
    version: 0,
  };
}

function applyActiveRecordingTake(
  project: ProjectState,
  clip: Clip,
  artifact: RecordingAudioArtifact,
  clipTake: RecordingAudioClipTake,
  maximumEndTick?: number,
): Clip {
  const lengthTicks = resolveRecordingLengthTicks(
    project,
    clip.startTick,
    artifact,
    maximumEndTick,
  );
  const ticksPerSecond = (project.bpm * TICKS_PER_BEAT) / 60;
  const sourceEndSeconds = Math.min(
    artifact.audio.durationSeconds,
    lengthTicks / ticksPerSecond,
  );

  return {
    ...clip,
    activeClipTakeId: clipTake.clipTakeId,
    audioTiming: {
      timeBase: 'absolute-seconds',
      sourceStartSeconds: 0,
      sourceEndSeconds,
    },
    clipTakes: [...(clip.clipTakes ?? []), clipTake],
    lengthTicks,
    sourceFile: {
      checkedAt: artifact.createdAt,
      durationSeconds: artifact.audio.durationSeconds,
      mimeType: artifact.audio.mimeType,
      name: artifact.file.name,
      relativePath: artifact.file.relativePath,
      sizeBytes: artifact.file.sizeBytes,
      sourceId: artifact.artifactId,
      status: 'available',
    },
    version: clip.version + 1,
  };
}

function createRecordingClipTake(
  artifact: RecordingAudioArtifact,
  clip: Clip,
): RecordingAudioClipTake {
  const takeNumber = (clip.clipTakes?.length ?? 0) + 1;

  return {
    artifactId: artifact.artifactId,
    clipTakeId: `clip-take-${artifact.artifactId}`,
    createdAt: artifact.createdAt,
    label: `Recording Take ${String(takeNumber).padStart(2, '0')}`,
    mediaType: 'audio',
    sourceType: 'recording',
  };
}

function resolveRecordingLengthTicks(
  project: ProjectState,
  startTick: number,
  artifact: RecordingAudioArtifact,
  maximumEndTick?: number,
): number {
  const ticksPerSecond = (project.bpm * TICKS_PER_BEAT) / 60;
  const durationTicks = Math.max(
    1,
    Math.round(artifact.audio.durationSeconds * ticksPerSecond),
  );
  const availableEndTick = Math.min(
    project.totalTicks,
    maximumEndTick ?? project.totalTicks,
  );

  return Math.max(
    1,
    Math.min(durationTicks, Math.max(1, availableEndTick - startTick)),
  );
}

function ensureHumAudioTrack(tracks: Track[]): Track[] {
  if (tracks.some((track) => track.id === 'hum-audio')) {
    return tracks;
  }

  return [
    {
      id: 'hum-audio',
      name: 'Hum Audio',
      type: 'audio',
      level: -8,
      clips: [],
    },
    ...tracks,
  ];
}

type ClipLocation = Readonly<{
  clip: Clip;
  clipIndex: number;
  trackIndex: number;
}>;

type RecordingTakeLocation = ClipLocation &
  Readonly<{
    clipTake: RecordingAudioClipTake;
  }>;

function findClip(project: ProjectState, clipId: string): ClipLocation | undefined {
  for (const [trackIndex, track] of project.tracks.entries()) {
    const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);

    if (clipIndex >= 0) {
      return { clip: track.clips[clipIndex], clipIndex, trackIndex };
    }
  }

  return undefined;
}

function findRecordingTakeLocations(
  project: ProjectState,
  artifactId: string,
): RecordingTakeLocation[] {
  const locations: RecordingTakeLocation[] = [];

  project.tracks.forEach((track, trackIndex) => {
    track.clips.forEach((clip, clipIndex) => {
      for (const clipTake of clip.clipTakes ?? []) {
        if (
          clipTake.sourceType === 'recording' &&
          clipTake.artifactId === artifactId
        ) {
          locations.push({ clip, clipIndex, clipTake, trackIndex });
        }
      }
    });
  });

  return locations;
}

function normalizeCaptureText(
  value: string | undefined,
  maximumLength: number,
): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maximumLength) : undefined;
}
