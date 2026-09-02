import {
  createAudioGenerationRegionPlan,
  type AudioGenerationRegionPlan,
  type AudioGenerationRegionRequest,
} from './audioGenerationRegion';
import { getClipTypeColor } from './clipTypeColors';
import type {
  Clip,
  ProjectState,
  SelectionItem,
  SelectionState,
  Track,
} from './types';

const AUDIO_GENERATION_REGION_CREATOR = 'Generation Region';

export type AudioGenerationRegionApplicationResult =
  | Readonly<{
      applied: true;
      clip: Clip;
      project: ProjectState;
      status: 'APPLIED';
      track: Track;
    }>
  | Readonly<{
      applied: false;
      cause: string;
      message: string;
      project: ProjectState;
      reason: 'plan-invalid' | 'project-stale';
      status: 'BLOCKED';
    }>;

export function applyAudioGenerationRegionPlan(
  project: ProjectState,
  plan: AudioGenerationRegionPlan,
): AudioGenerationRegionApplicationResult {
  const validation = createAudioGenerationRegionPlan(
    project,
    createRequestFromPlan(plan),
  );

  if (!validation.canCreate) {
    return blocked(
      project,
      'project-stale',
      validation.cause,
      `Generation Region plan no longer matches the current Project: ${validation.message}`,
    );
  }

  if (!arePlansEqual(plan, validation.plan)) {
    return blocked(
      project,
      'project-stale',
      'generation-region-application-plan-stale',
      'Generation Region plan changed after validation and must be prepared again.',
    );
  }

  const clip: Clip = {
    color: getClipTypeColor(plan.region.clipType),
    createdAt: plan.createdAt,
    generatedBy: AUDIO_GENERATION_REGION_CREATOR,
    id: plan.region.regionId,
    lengthTicks: plan.region.lengthTicks,
    name: plan.region.name,
    startTick: plan.region.startTick,
    type: plan.region.clipType,
    version: 1,
  };
  let tracks: Track[];

  if (plan.outputTarget.kind === 'new-track') {
    tracks = [
      ...project.tracks,
      {
        clips: [clip],
        id: plan.outputTarget.trackId,
        level: plan.outputTarget.level,
        name: plan.outputTarget.trackName,
        parentGroupId: plan.outputTarget.parentGroupId,
        type: plan.outputTarget.trackType,
      },
    ];
  } else {
    tracks = project.tracks.map((track) =>
      track.id === plan.outputTarget.trackId
        ? {
            ...track,
            clips: [...track.clips, clip],
            type: plan.outputTarget.trackType,
          }
        : track,
    );
  }

  const selection = createClipSelection(plan.selection.clipId);
  const nextProject: ProjectState = {
    ...project,
    selection,
    totalTicks: plan.timeline.requiredTotalTicks,
    tracks,
  };
  const targetTrack = nextProject.tracks.find(
    (track) => track.id === plan.outputTarget.trackId,
  );

  if (!targetTrack) {
    return blocked(
      project,
      'plan-invalid',
      'generation-region-application-target-missing',
      'Generation Region application did not create its planned target Track.',
    );
  }

  return Object.freeze({
    applied: true as const,
    clip,
    project: nextProject,
    status: 'APPLIED' as const,
    track: targetTrack,
  });
}

function createRequestFromPlan(
  plan: AudioGenerationRegionPlan,
): AudioGenerationRegionRequest {
  return {
    bars: plan.region.bars,
    createdAt: plan.createdAt,
    outputTarget:
      plan.outputTarget.kind === 'new-track'
        ? {
            kind: 'new-track',
            trackId: plan.outputTarget.trackId,
            trackName: plan.outputTarget.trackName,
          }
        : {
            kind: 'existing-track',
            trackId: plan.outputTarget.trackId,
          },
    placement: {
      kind: 'timeline',
      startTick: plan.region.startTick,
    },
    regionId: plan.region.regionId,
    regionName: plan.region.name,
  };
}

function createClipSelection(clipId: string): SelectionState {
  const item: SelectionItem = { id: clipId, type: 'clip' };

  return {
    anchorItem: item,
    items: [item],
    lastSelectedItem: item,
  };
}

function arePlansEqual(
  left: AudioGenerationRegionPlan,
  right: AudioGenerationRegionPlan,
): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function blocked(
  project: ProjectState,
  reason: Extract<
    AudioGenerationRegionApplicationResult,
    { applied: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<AudioGenerationRegionApplicationResult, { applied: false }> {
  return Object.freeze({
    applied: false as const,
    cause,
    message,
    project,
    reason,
    status: 'BLOCKED' as const,
  });
}
