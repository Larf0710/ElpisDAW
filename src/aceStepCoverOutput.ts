import {
  ACE_STEP_MAX_DURATION_SECONDS,
  ACE_STEP_MIN_DURATION_SECONDS,
} from '../shared/aceStepProtocol.js';
import {
  AUDIO_DURATION_EPSILON_SECONDS,
  secondsToTimelineTicks,
} from './audioClipTiming';
import {
  AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS,
  AUDIO_GENERATION_REGION_NEW_TRACK_LEVEL_DB,
} from './audioGenerationRegion';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { getClipTypeColor } from './clipTypeColors';
import type { Clip, ProjectState, SelectionItem, Track } from './types';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type AceStepCoverOutputRequest = Readonly<{
  createdAt: string;
  outputClipId: string;
  outputClipName: string;
  outputTrackId: string;
  outputTrackName: string;
  sourceClipId: string;
}>;

export type AceStepCoverOutputPlan = Readonly<{
  createdAt: string;
  durationSeconds: number;
  output: Readonly<{
    clipId: string;
    clipName: string;
    lengthTicks: number;
    startTick: number;
    trackId: string;
    trackName: string;
  }>;
  source: Readonly<{
    artifactId: string;
    clipId: string;
    clipTakeId: string;
    relativePath: string;
    sizeBytes: number;
  }>;
  timeline: Readonly<{
    requiredTotalTicks: number;
  }>;
}>;

export type AceStepCoverOutputResolution =
  | Readonly<{ canPlan: true; plan: AceStepCoverOutputPlan }>
  | Readonly<{ canPlan: false; cause: string; message: string }>;

export type AceStepCoverOutputApplication =
  | Readonly<{
      applied: true;
      clip: Clip;
      project: ProjectState;
      track: Track;
    }>
  | Readonly<{
      applied: false;
      cause: string;
      message: string;
      project: ProjectState;
    }>;

export function createAceStepCoverOutputPlan(
  project: ProjectState,
  request: AceStepCoverOutputRequest,
): AceStepCoverOutputResolution {
  if (
    !isIdentity(request.outputClipId) ||
    !isIdentity(request.outputTrackId) ||
    !isIdentity(request.sourceClipId) ||
    !isName(request.outputClipName) ||
    !isName(request.outputTrackName) ||
    !isTimestamp(request.createdAt) ||
    !Number.isFinite(project.bpm) ||
    project.bpm <= 0 ||
    !Number.isSafeInteger(project.totalTicks) ||
    project.totalTicks <= 0 ||
    project.totalTicks > AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS
  ) {
    return failure(
      'ace-step-cover-output-request-invalid',
      'ACE Cover requires valid source, output identities, timestamp, Tempo, and Timeline context.',
    );
  }

  if (
    project.tracks.some((track) => track.id === request.outputTrackId) ||
    project.tracks.some((track) =>
      track.clips.some((clip) => clip.id === request.outputClipId),
    )
  ) {
    return failure(
      'ace-step-cover-output-id-conflict',
      'ACE Cover output Track or Clip identity already exists.',
    );
  }

  const sourceResolution = resolveActiveAudioTakeSource(project, request.sourceClipId);

  if (!sourceResolution.canResolve) {
    return failure(
      `ace-step-cover-source-${sourceResolution.reason}`,
      sourceResolution.message,
    );
  }

  const source = sourceResolution.plan;
  const durationSeconds = source.clip.sourceFile.durationSeconds;
  const expectedLengthTicks = secondsToTimelineTicks(durationSeconds, project.bpm);
  const timing = source.clip.audioTiming;

  if (
    durationSeconds < ACE_STEP_MIN_DURATION_SECONDS ||
    durationSeconds > ACE_STEP_MAX_DURATION_SECONDS
  ) {
    return failure(
      'ace-step-cover-source-duration-invalid',
      `ACE Cover requires a ${ACE_STEP_MIN_DURATION_SECONDS}-${ACE_STEP_MAX_DURATION_SECONDS} second Active Take.`,
    );
  }

  if (
    timing.sourceStartSeconds !== 0 ||
    Math.abs(timing.sourceEndSeconds - durationSeconds) >
      AUDIO_DURATION_EPSILON_SECONDS ||
    source.clip.lengthTicks !== expectedLengthTicks
  ) {
    return failure(
      'ace-step-cover-source-trimmed',
      'ACE Cover v0.1 requires one full, untrimmed Active Take. Bounce or select a full-length Clip before Remix.',
    );
  }

  const startTick = source.clip.startTick;
  const endTick = startTick + expectedLengthTicks;

  if (
    !Number.isSafeInteger(startTick) ||
    startTick < 0 ||
    !Number.isSafeInteger(endTick) ||
    endTick > project.totalTicks ||
    endTick > AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS
  ) {
    return failure(
      'ace-step-cover-source-placement-invalid',
      'ACE Cover source placement does not fit the supported Timeline.',
    );
  }

  return freezeDeep({
    canPlan: true as const,
    plan: {
      createdAt: request.createdAt,
      durationSeconds,
      output: {
        clipId: request.outputClipId,
        clipName: request.outputClipName,
        lengthTicks: expectedLengthTicks,
        startTick,
        trackId: request.outputTrackId,
        trackName: request.outputTrackName,
      },
      source: {
        artifactId: source.source.artifactId,
        clipId: source.source.clipId,
        clipTakeId: source.source.clipTakeId,
        relativePath: source.descriptor.relativePath,
        sizeBytes: source.descriptor.sizeBytes,
      },
      timeline: {
        requiredTotalTicks: project.totalTicks,
      },
    },
  });
}

export function applyAceStepCoverOutputPlan(
  project: ProjectState,
  plan: AceStepCoverOutputPlan,
): AceStepCoverOutputApplication {
  const validation = createAceStepCoverOutputPlan(project, {
    createdAt: plan.createdAt,
    outputClipId: plan.output.clipId,
    outputClipName: plan.output.clipName,
    outputTrackId: plan.output.trackId,
    outputTrackName: plan.output.trackName,
    sourceClipId: plan.source.clipId,
  });

  if (!validation.canPlan || JSON.stringify(validation.plan) !== JSON.stringify(plan)) {
    return Object.freeze({
      applied: false as const,
      cause: validation.canPlan
        ? 'ace-step-cover-output-plan-stale'
        : validation.cause,
      message: validation.canPlan
        ? 'ACE Cover output plan changed after preparation.'
        : validation.message,
      project,
    });
  }

  const clip: Clip = {
    color: getClipTypeColor('ai-fill-audio'),
    createdAt: plan.createdAt,
    generatedBy: 'ACE Cover',
    id: plan.output.clipId,
    lengthTicks: plan.output.lengthTicks,
    name: plan.output.clipName,
    sourceClipId: plan.source.clipId,
    startTick: plan.output.startTick,
    type: 'ai-fill-audio',
    version: 1,
  };
  const track: Track = {
    clips: [clip],
    id: plan.output.trackId,
    level: AUDIO_GENERATION_REGION_NEW_TRACK_LEVEL_DB,
    name: plan.output.trackName,
    parentGroupId: null,
    type: 'generated_audio',
  };
  const selectionItem: SelectionItem = { id: clip.id, type: 'clip' };
  const nextProject: ProjectState = {
    ...project,
    selection: {
      anchorItem: selectionItem,
      items: [selectionItem],
      lastSelectedItem: selectionItem,
    },
    tracks: [...project.tracks, track],
  };

  return Object.freeze({
    applied: true as const,
    clip,
    project: nextProject,
    track,
  });
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 120 &&
    value.trim() === value
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !Number.isNaN(Date.parse(value))
  );
}

function failure(cause: string, message: string): Extract<
  AceStepCoverOutputResolution,
  { canPlan: false }
> {
  return Object.freeze({ canPlan: false as const, cause, message });
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(freezeDeep);
    Object.freeze(value);
  }

  return value;
}
