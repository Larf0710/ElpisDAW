import { doesTickRangeOverlapTrack } from './timelineClipPlacement';
import type { ClipType, ProjectState, Track, TrackType } from './types';
import { TICKS_PER_QUARTER } from './workflow';

export const AUDIO_GENERATION_REGION_BEATS_PER_BAR = 4 as const;
export const AUDIO_GENERATION_REGION_TICKS_PER_BAR =
  TICKS_PER_QUARTER * AUDIO_GENERATION_REGION_BEATS_PER_BAR;
export const AUDIO_GENERATION_REGION_MAX_BARS = 512 as const;
export const AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS =
  AUDIO_GENERATION_REGION_MAX_BARS * AUDIO_GENERATION_REGION_TICKS_PER_BAR;
export const AUDIO_GENERATION_REGION_NEW_TRACK_LEVEL_DB = -6 as const;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 120;
const supportedExistingTrackTypes = new Set<TrackType>([
  'audio',
  'blank',
  'generated_audio',
]);

export type AudioGenerationRegionPlacementRequest =
  | Readonly<{ kind: 'playhead' }>
  | Readonly<{ kind: 'timeline'; startTick: number }>;

export type AudioGenerationRegionOutputTargetRequest =
  | Readonly<{
      kind: 'existing-track';
      trackId: string;
    }>
  | Readonly<{
      kind: 'new-track';
      trackId: string;
      trackName: string;
    }>;

export type AudioGenerationRegionRequest = Readonly<{
  bars: number;
  createdAt: string;
  outputTarget: AudioGenerationRegionOutputTargetRequest;
  placement: AudioGenerationRegionPlacementRequest;
  regionId: string;
  regionName: string;
}>;

export type AudioGenerationRegionPlan = Readonly<{
  createdAt: string;
  durationSeconds: number;
  output: Readonly<{
    clipId: string;
    kind: 'first-clip-take';
    trackId: string;
  }>;
  outputTarget:
    | Readonly<{
        currentTrackType: Extract<TrackType, 'audio' | 'blank' | 'generated_audio'>;
        kind: 'existing-track';
        trackId: string;
        trackName: string;
        trackType: Extract<TrackType, 'audio' | 'generated_audio'>;
      }>
    | Readonly<{
        kind: 'new-track';
        level: typeof AUDIO_GENERATION_REGION_NEW_TRACK_LEVEL_DB;
        parentGroupId: null;
        trackId: string;
        trackName: string;
        trackType: 'generated_audio';
      }>;
  projectContext: Readonly<{
    beatsPerBar: typeof AUDIO_GENERATION_REGION_BEATS_PER_BAR;
    bpm: number;
    key: string;
    ticksPerBeat: typeof TICKS_PER_QUARTER;
  }>;
  region: Readonly<{
    bars: number;
    clipType: Extract<ClipType, 'ai-fill-audio'>;
    endTick: number;
    lengthTicks: number;
    name: string;
    regionId: string;
    startTick: number;
  }>;
  selection: Readonly<{
    clipId: string;
    kind: 'clip';
  }>;
  source: Readonly<{ kind: 'empty' }>;
  timeline: Readonly<{
    extendsTimeline: boolean;
    requiredTotalTicks: number;
  }>;
}>;

export type AudioGenerationRegionPlanResolution =
  | Readonly<{
      canCreate: true;
      plan: AudioGenerationRegionPlan;
    }>
  | Readonly<{
      canCreate: false;
      cause: string;
      message: string;
      reason:
        | 'clip-overlap'
        | 'invalid-request'
        | 'project-invalid'
        | 'region-conflict'
        | 'target-invalid'
        | 'timeline-overflow';
    }>;

export function createAudioGenerationRegionPlan(
  project: ProjectState,
  request: AudioGenerationRegionRequest,
): AudioGenerationRegionPlanResolution {
  const requestFailure = validateRequest(request);

  if (requestFailure) {
    return requestFailure;
  }

  if (
    !Number.isFinite(project.bpm) ||
    project.bpm <= 0 ||
    typeof project.key !== 'string' ||
    !project.key.trim() ||
    project.key.trim() !== project.key ||
    !Number.isSafeInteger(project.totalTicks) ||
    project.totalTicks <= 0 ||
    project.totalTicks > AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS ||
    !Number.isSafeInteger(project.playheadTick) ||
    project.playheadTick < 0 ||
    project.playheadTick > project.totalTicks
  ) {
    return failure(
      'project-invalid',
      'generation-region-project-invalid',
      'Generation Region requires valid Project tempo, key, playhead, and Timeline length.',
    );
  }

  const clipIdMatches = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => clip.id === request.regionId),
  );

  if (clipIdMatches.length > 0) {
    return failure(
      'region-conflict',
      'generation-region-id-conflict',
      `Generation Region ID ${request.regionId} already exists in the Project.`,
    );
  }

  const startTick =
    request.placement.kind === 'playhead'
      ? project.playheadTick
      : request.placement.startTick;

  if (
    !Number.isSafeInteger(startTick) ||
    startTick < 0 ||
    startTick > project.totalTicks
  ) {
    return failure(
      'invalid-request',
      'generation-region-placement-invalid',
      'Generation Region placement must be one valid integer Tick inside the current Timeline.',
    );
  }

  const lengthTicks = request.bars * AUDIO_GENERATION_REGION_TICKS_PER_BAR;
  const endTick = startTick + lengthTicks;

  if (
    !Number.isSafeInteger(lengthTicks) ||
    !Number.isSafeInteger(endTick) ||
    endTick <= startTick ||
    endTick > AUDIO_GENERATION_REGION_MAX_TIMELINE_TICKS
  ) {
    return failure(
      'timeline-overflow',
      'generation-region-timeline-overflow',
      'Generation Region length exceeds the supported Timeline range.',
    );
  }

  const outputTarget = resolveOutputTarget(
    project.tracks,
    request.outputTarget,
    startTick,
    endTick,
  );

  if (!outputTarget.ok) {
    return outputTarget.failure;
  }

  const requiredTotalTicks = Math.max(
    project.totalTicks,
    Math.ceil(endTick / AUDIO_GENERATION_REGION_TICKS_PER_BAR) *
      AUDIO_GENERATION_REGION_TICKS_PER_BAR,
  );

  if (!Number.isSafeInteger(requiredTotalTicks)) {
    return failure(
      'timeline-overflow',
      'generation-region-timeline-overflow',
      'Generation Region would extend the Timeline beyond its supported range.',
    );
  }

  return freezeDeep({
    canCreate: true as const,
    plan: {
      createdAt: request.createdAt,
      durationSeconds:
        (request.bars * AUDIO_GENERATION_REGION_BEATS_PER_BAR * 60) /
        project.bpm,
      output: {
        clipId: request.regionId,
        kind: 'first-clip-take' as const,
        trackId: outputTarget.target.trackId,
      },
      outputTarget: outputTarget.target,
      projectContext: {
        beatsPerBar: AUDIO_GENERATION_REGION_BEATS_PER_BAR,
        bpm: project.bpm,
        key: project.key,
        ticksPerBeat: TICKS_PER_QUARTER,
      },
      region: {
        bars: request.bars,
        clipType: 'ai-fill-audio' as const,
        endTick,
        lengthTicks,
        name: request.regionName,
        regionId: request.regionId,
        startTick,
      },
      selection: {
        clipId: request.regionId,
        kind: 'clip' as const,
      },
      source: { kind: 'empty' as const },
      timeline: {
        extendsTimeline: requiredTotalTicks > project.totalTicks,
        requiredTotalTicks,
      },
    },
  });
}

function validateRequest(
  request: AudioGenerationRegionRequest,
): Extract<AudioGenerationRegionPlanResolution, { canCreate: false }> | undefined {
  if (
    !isIdentifier(request.regionId) ||
    !isTrimmedName(request.regionName) ||
    typeof request.createdAt !== 'string' ||
    !request.createdAt.trim() ||
    request.createdAt.trim() !== request.createdAt ||
    !Number.isFinite(Date.parse(request.createdAt)) ||
    !Number.isSafeInteger(request.bars) ||
    request.bars < 1 ||
    request.bars > AUDIO_GENERATION_REGION_MAX_BARS ||
    (request.placement.kind !== 'playhead' &&
      request.placement.kind !== 'timeline') ||
    (request.outputTarget.kind !== 'existing-track' &&
      request.outputTarget.kind !== 'new-track')
  ) {
    return failure(
      'invalid-request',
      'generation-region-request-invalid',
      `Generation Region requires a unique ID, name, timestamp, placement, output target, and 1 to ${AUDIO_GENERATION_REGION_MAX_BARS} whole Bars.`,
    );
  }

  if (
    !isIdentifier(request.outputTarget.trackId) ||
    (request.outputTarget.kind === 'new-track' &&
      !isTrimmedName(request.outputTarget.trackName))
  ) {
    return failure(
      'invalid-request',
      'generation-region-output-target-invalid',
      'Generation Region output target requires a valid Track ID and new Tracks require a name.',
    );
  }

  return undefined;
}

function resolveOutputTarget(
  tracks: readonly Track[],
  request: AudioGenerationRegionOutputTargetRequest,
  startTick: number,
  endTick: number,
):
  | Readonly<{
      ok: true;
      target: AudioGenerationRegionPlan['outputTarget'];
    }>
  | Readonly<{
      failure: Extract<AudioGenerationRegionPlanResolution, { canCreate: false }>;
      ok: false;
    }> {
  const trackMatches = tracks.filter((track) => track.id === request.trackId);

  if (request.kind === 'new-track') {
    if (trackMatches.length > 0) {
      return {
        failure: failure(
          'target-invalid',
          'generation-region-new-track-id-conflict',
          `Generation Region new Track ID ${request.trackId} already exists.`,
        ),
        ok: false,
      };
    }

    return {
      ok: true,
      target: {
        kind: 'new-track',
        level: AUDIO_GENERATION_REGION_NEW_TRACK_LEVEL_DB,
        parentGroupId: null,
        trackId: request.trackId,
        trackName: request.trackName,
        trackType: 'generated_audio',
      },
    };
  }

  if (trackMatches.length !== 1) {
    return {
      failure: failure(
        'target-invalid',
        'generation-region-track-unavailable',
        `Generation Region existing Track ${request.trackId} must resolve uniquely.`,
      ),
      ok: false,
    };
  }

  const track = trackMatches[0];

  if (!supportedExistingTrackTypes.has(track.type)) {
    return {
      failure: failure(
        'target-invalid',
        'generation-region-track-type-unsupported',
        'Generation Region existing Track must be Blank, Audio, or Generated Audio.',
      ),
      ok: false,
    };
  }

  if (doesTickRangeOverlapTrack(startTick, endTick, track)) {
    return {
      failure: failure(
        'clip-overlap',
        'generation-region-clip-overlap',
        `Generation Region would overlap an existing Clip on ${track.name}.`,
      ),
      ok: false,
    };
  }

  const currentTrackType = track.type as Extract<
    TrackType,
    'audio' | 'blank' | 'generated_audio'
  >;

  return {
    ok: true,
    target: {
      currentTrackType,
      kind: 'existing-track',
      trackId: track.id,
      trackName: track.name,
      trackType:
        currentTrackType === 'blank' ? 'generated_audio' : currentTrackType,
    },
  };
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_NAME_LENGTH &&
    ID_PATTERN.test(value)
  );
}

function isTrimmedName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_NAME_LENGTH &&
    value.trim() === value
  );
}

function failure(
  reason: Extract<
    AudioGenerationRegionPlanResolution,
    { canCreate: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<AudioGenerationRegionPlanResolution, { canCreate: false }> {
  return Object.freeze({
    canCreate: false as const,
    cause,
    message,
    reason,
  });
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(freezeDeep);
    Object.freeze(value);
  }

  return value;
}
