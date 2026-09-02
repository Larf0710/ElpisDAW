import {
  doesClipSupportTakeMedia,
  doesClipTakeMatchArtifact,
} from './clipTakeActivation';
import {
  AUDIO_DURATION_EPSILON_SECONDS,
  secondsToTimelineTicks,
} from './audioClipTiming';
import type { SourceBackedAudioClip } from './audioClipSource';
import { createLocalEngineGeneratedAudioDescriptor } from './generatedAudioDescriptor';
import type { LocalEngineGeneratedAudioDescriptor } from './localEngineClient';
import type {
  AudioArtifact,
  AudioClipTake,
  Clip,
  ProjectArtifact,
  Track,
} from './types';

export type ActiveAudioTakeSourceFailureReason =
  | 'active-take-not-audio'
  | 'active-take-not-found'
  | 'active-take-not-selected'
  | 'artifact-invalid'
  | 'clip-not-audio'
  | 'clip-not-found'
  | 'file-invalid'
  | 'timing-invalid';

export type ActiveAudioTakeSourcePlan = Readonly<{
  clip: SourceBackedAudioClip;
  descriptor: LocalEngineGeneratedAudioDescriptor;
  source: Readonly<{
    artifactId: string;
    clipId: string;
    clipTakeId: string;
  }>;
}>;

export type ActiveAudioTakeSourceResolution =
  | Readonly<{
      canResolve: true;
      plan: ActiveAudioTakeSourcePlan;
    }>
  | Readonly<{
      canResolve: false;
      message: string;
      reason: ActiveAudioTakeSourceFailureReason;
    }>;

type ProjectAudioSourceState = Readonly<{
  artifacts?: readonly ProjectArtifact[];
  bpm: number;
  tracks: readonly Track[];
}>;

export function resolveActiveAudioTakeSource(
  project: ProjectAudioSourceState,
  clipId: string,
): ActiveAudioTakeSourceResolution {
  const clips = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);

  if (clips.length !== 1) {
    return fail(
      'clip-not-found',
      `Audio Clip does not resolve uniquely: ${clipId}.`,
    );
  }

  const clip = clips[0];

  if (!doesClipSupportTakeMedia(clip, 'audio')) {
    return fail(
      'clip-not-audio',
      `${clip.name} cannot provide an Active Audio Take.`,
    );
  }

  if (!clip.activeClipTakeId) {
    return fail(
      'active-take-not-selected',
      `${clip.name} does not have an Active Audio Take.`,
    );
  }

  const activeTakes = project.tracks
    .flatMap((track) => track.clips)
    .flatMap((candidate) => candidate.clipTakes ?? [])
    .filter((clipTake) => clipTake.clipTakeId === clip.activeClipTakeId);

  if (
    activeTakes.length !== 1 ||
    !(clip.clipTakes ?? []).includes(activeTakes[0])
  ) {
    return fail(
      'active-take-not-found',
      `${clip.name} Active Take does not resolve uniquely.`,
    );
  }

  const activeTake = activeTakes[0];

  if (activeTake.mediaType !== 'audio') {
    return fail(
      'active-take-not-audio',
      `${clip.name} Active Take does not contain audio.`,
    );
  }

  const artifacts = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === activeTake.artifactId,
  );

  if (
    artifacts.length !== 1 ||
    artifacts[0].kind !== 'audio' ||
    !doesClipTakeMatchArtifact(activeTake, artifacts[0])
  ) {
    return fail(
      'artifact-invalid',
      `${clip.name} Active Take does not resolve to one matching Audio Artifact.`,
    );
  }

  const artifact = artifacts[0];

  if (
    !Number.isSafeInteger(artifact.audio.channels) ||
    artifact.audio.channels <= 0 ||
    artifact.audio.mimeType !== 'audio/wav' ||
    !isFinitePositiveNumber(artifact.audio.durationSeconds)
  ) {
    return fail(
      'artifact-invalid',
      `${clip.name} Active Audio Artifact metadata is invalid.`,
    );
  }

  const descriptor = createLocalEngineGeneratedAudioDescriptor(artifact);

  if (!descriptor) {
    return fail(
      'file-invalid',
      `${clip.name} Active Audio file metadata is invalid.`,
    );
  }

  const sourceClip = createSourceBackedClip(
    project,
    clip,
    activeTake,
    artifact,
  );

  if (!sourceClip) {
    return fail(
      'timing-invalid',
      `${clip.name} Active Audio timing is invalid.`,
    );
  }

  const source = Object.freeze({
    artifactId: artifact.artifactId,
    clipId: clip.id,
    clipTakeId: activeTake.clipTakeId,
  });

  return Object.freeze({
    canResolve: true,
    plan: Object.freeze({
      clip: sourceClip,
      descriptor,
      source,
    }),
  });
}

function createSourceBackedClip(
  project: ProjectAudioSourceState,
  clip: Clip,
  activeTake: AudioClipTake,
  artifact: AudioArtifact,
): SourceBackedAudioClip | undefined {
  if (
    !Number.isFinite(project.bpm) ||
    project.bpm <= 0 ||
    !Number.isFinite(clip.lengthTicks) ||
    clip.lengthTicks <= 0
  ) {
    return undefined;
  }

  const audioTiming = clip.audioTiming ?? {
    sourceEndSeconds: artifact.audio.durationSeconds,
    sourceStartSeconds: 0,
    timeBase: 'absolute-seconds' as const,
  };

  if (
    audioTiming.timeBase !== 'absolute-seconds' ||
    !isFiniteNonNegativeNumber(audioTiming.sourceStartSeconds) ||
    !isFinitePositiveNumber(audioTiming.sourceEndSeconds) ||
    audioTiming.sourceEndSeconds <= audioTiming.sourceStartSeconds ||
    audioTiming.sourceEndSeconds >
      artifact.audio.durationSeconds + AUDIO_DURATION_EPSILON_SECONDS
  ) {
    return undefined;
  }

  const maximumLengthTicks = Math.max(
    1,
    secondsToTimelineTicks(
      audioTiming.sourceEndSeconds - audioTiming.sourceStartSeconds,
      project.bpm,
    ),
  );

  return {
    ...clip,
    activeClipTakeId: activeTake.clipTakeId,
    audioTiming,
    lengthTicks: Math.min(Math.round(clip.lengthTicks), maximumLengthTicks),
    sourceFile: {
      durationSeconds: artifact.audio.durationSeconds,
      mimeType: artifact.audio.mimeType,
      name: artifact.file.name,
      relativePath: artifact.file.relativePath,
      sizeBytes: artifact.file.sizeBytes,
      sourceId: artifact.artifactId,
      status: 'available',
    },
  };
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function fail(
  reason: ActiveAudioTakeSourceFailureReason,
  message: string,
): ActiveAudioTakeSourceResolution {
  return Object.freeze({
    canResolve: false,
    message,
    reason,
  });
}
