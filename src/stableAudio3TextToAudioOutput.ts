import {
  createAudioGenerationRegionPlan,
  type AudioGenerationRegionPlan,
  type AudioGenerationRegionPlanResolution,
} from './audioGenerationRegion';
import type { ProjectState } from './types';

export const STABLE_AUDIO_3_TEXT_TO_AUDIO_GENERATION_POSITIONS = [
  'playhead',
  'timeline-start',
] as const;

export type StableAudio3TextToAudioGenerationPosition =
  (typeof STABLE_AUDIO_3_TEXT_TO_AUDIO_GENERATION_POSITIONS)[number];

export type StableAudio3TextToAudioOutputRequest = Readonly<{
  bars: number;
  createdAt: string;
  generationPosition: StableAudio3TextToAudioGenerationPosition;
  outputClipId: string;
  outputClipName: string;
  outputTrackId: string;
  outputTrackName: string;
}>;

export type StableAudio3TextToAudioOutputPlan = Readonly<{
  generationPosition: Readonly<{
    capturedPlayheadTick: number;
    choice: StableAudio3TextToAudioGenerationPosition;
    resolvedStartTick: number;
  }>;
  generationRegion: AudioGenerationRegionPlan;
  materialization: Readonly<{
    kind: 'after-generation-success';
  }>;
}>;

export type StableAudio3TextToAudioOutputPlanResolution =
  | Readonly<{
      canPlan: true;
      plan: StableAudio3TextToAudioOutputPlan;
    }>
  | Readonly<{
      canPlan: false;
      cause: string;
      message: string;
      reason: Extract<
        AudioGenerationRegionPlanResolution,
        { canCreate: false }
      >['reason'];
    }>;

export function createStableAudio3TextToAudioOutputPlan(
  project: ProjectState,
  request: StableAudio3TextToAudioOutputRequest,
): StableAudio3TextToAudioOutputPlanResolution {
  if (!isGenerationPosition(request.generationPosition)) {
    return Object.freeze({
      canPlan: false as const,
      cause: 'stable-audio-3-t2a-generation-position-invalid',
      message:
        'SA3 T2A Generation Position must be Playhead or Timeline Start.',
      reason: 'invalid-request' as const,
    });
  }

  const generationRegionResolution = createAudioGenerationRegionPlan(project, {
    bars: request.bars,
    createdAt: request.createdAt,
    outputTarget: {
      kind: 'new-track',
      trackId: request.outputTrackId,
      trackName: request.outputTrackName,
    },
    placement:
      request.generationPosition === 'playhead'
        ? { kind: 'playhead' }
        : { kind: 'timeline', startTick: 0 },
    regionId: request.outputClipId,
    regionName: request.outputClipName,
  });

  if (!generationRegionResolution.canCreate) {
    return Object.freeze({
      canPlan: false as const,
      cause: generationRegionResolution.cause,
      message: generationRegionResolution.message,
      reason: generationRegionResolution.reason,
    });
  }

  return freezeDeep({
    canPlan: true as const,
    plan: {
      generationPosition: {
        capturedPlayheadTick: project.playheadTick,
        choice: request.generationPosition,
        resolvedStartTick: generationRegionResolution.plan.region.startTick,
      },
      generationRegion: generationRegionResolution.plan,
      materialization: {
        kind: 'after-generation-success' as const,
      },
    },
  });
}

function isGenerationPosition(
  value: unknown,
): value is StableAudio3TextToAudioGenerationPosition {
  return (
    value === STABLE_AUDIO_3_TEXT_TO_AUDIO_GENERATION_POSITIONS[0] ||
    value === STABLE_AUDIO_3_TEXT_TO_AUDIO_GENERATION_POSITIONS[1]
  );
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(freezeDeep);
    Object.freeze(value);
  }

  return value;
}
