import type {
  LocalEngineSourceDescriptor,
  LocalEngineSourceRestoration,
} from './localEngineClient';
import {
  createProjectStemPrintApiRequest,
  type ProjectStemPrintApiRequest,
} from './projectStemPrintApi';
import { collectRequiredProjectRenderSourceIds } from './projectMixdownPlan';
import {
  createProjectExplicitMixdownPlaybackPlan,
  type SourceAvailabilitySnapshot,
} from './projectPlaybackPlan';
import { createProjectPlaybackSchedule } from './projectPlaybackRuntime';
import {
  createProjectStemPrintRegistrationIntent,
  type ProjectStemPrintRegistrationIntent,
} from './projectStemPrintRegistrationIntent';
import {
  createProjectStemPrintPlan,
  resolveProjectStemPrintTargets,
  type ProjectStemPrintPlan,
  type ProjectStemPrintTarget,
} from './projectStemPrintPlan';
import type { ProjectState } from './types';

export type ProjectStemPrintPreparation =
  | Readonly<{
      canPrepare: true;
      intent: ProjectStemPrintRegistrationIntent;
      plan: ProjectStemPrintPlan;
      request: ProjectStemPrintApiRequest;
      summary: Readonly<{
        durationSeconds: number;
        outputClipName: string;
        sourceCount: number;
        targetCount: number;
        trackCount: number;
      }>;
    }>
  | Readonly<{
      canPrepare: false;
      cause:
        | 'intent-unavailable'
        | 'playback-plan-unavailable'
        | 'request-invalid'
        | 'source-descriptor-unavailable'
        | 'stem-print-plan-unavailable'
        | 'target-selection-invalid';
      message: string;
    }>;

export function prepareProjectStemPrint(
  project: ProjectState,
  targets: readonly ProjectStemPrintTarget[],
  sourceDescriptors: readonly LocalEngineSourceDescriptor[],
  restoration: LocalEngineSourceRestoration,
  operationId?: string,
): ProjectStemPrintPreparation {
  const targetResolution = resolveProjectStemPrintTargets(targets, project.tracks);

  if (!targetResolution.canCreate) {
    return preparationFailure(
      'target-selection-invalid',
      targetResolution.message,
    );
  }

  const sourceAvailability: SourceAvailabilitySnapshot = Object.freeze(
    Object.fromEntries(
      sourceDescriptors.map((descriptor) => [
        descriptor.sourceId,
        restoration.availability[descriptor.sourceId] === 'available'
          ? 'openable'
          : 'unopenable',
      ] as const),
    ) as Record<string, 'openable' | 'unopenable'>,
  );
  const planningInput = {
    artifacts: project.artifacts,
    bpm: project.bpm,
    mixer: project.mixer,
    playheadTick: project.playheadTick,
    projectEndTick: project.totalTicks,
    sourceAvailability,
    tracks: project.tracks,
  } as const;
  const playbackPlanning = createProjectExplicitMixdownPlaybackPlan({
    ...planningInput,
    targetReferences: targetResolution.value.references,
  });

  if (!playbackPlanning.canPlay) {
    return preparationFailure(
      'playback-plan-unavailable',
      playbackPlanning.message,
    );
  }

  const scheduling = createProjectPlaybackSchedule(
    playbackPlanning.plan,
    project.bpm,
  );

  if (!scheduling.canSchedule) {
    return preparationFailure(
      'playback-plan-unavailable',
      scheduling.message,
    );
  }

  const requiredSourceIds = new Set(
    collectRequiredProjectRenderSourceIds(scheduling.schedule.tracks),
  );
  const descriptorCounts = new Map<string, number>();
  for (const descriptor of sourceDescriptors) {
    descriptorCounts.set(
      descriptor.sourceId,
      (descriptorCounts.get(descriptor.sourceId) ?? 0) + 1,
    );
  }
  const exactSourceDescriptors = sourceDescriptors.filter((descriptor) =>
    requiredSourceIds.has(descriptor.sourceId),
  );

  if (
    exactSourceDescriptors.length !== requiredSourceIds.size ||
    [...requiredSourceIds].some(
      (sourceId) => descriptorCounts.get(sourceId) !== 1,
    )
  ) {
    return preparationFailure(
      'source-descriptor-unavailable',
      'Stem Print blocked: every selected audible source must have one exact Engine-readable descriptor.',
    );
  }

  const planning = createProjectStemPrintPlan({
    ...planningInput,
    sourceDescriptors: exactSourceDescriptors,
    targets,
  });

  if (!planning.canCreate) {
    return preparationFailure(
      'stem-print-plan-unavailable',
      planning.message,
    );
  }

  let request: ProjectStemPrintApiRequest;
  try {
    request = createProjectStemPrintApiRequest(planning.plan, operationId);
  } catch (error) {
    return preparationFailure(
      'request-invalid',
      error instanceof Error
        ? error.message
        : 'Project Stem Print Request could not be created.',
    );
  }

  const intentResolution = createProjectStemPrintRegistrationIntent(
    project,
    request,
    planning.mixerSnapshot,
  );

  if (!intentResolution.canCreate) {
    return preparationFailure(
      'intent-unavailable',
      intentResolution.message,
    );
  }

  return Object.freeze({
    canPrepare: true as const,
    intent: intentResolution.intent,
    plan: planning.plan,
    request,
    summary: Object.freeze({
      durationSeconds: planning.plan.durationSeconds,
      outputClipName: intentResolution.intent.output.clipName,
      sourceCount: planning.plan.sources.length,
      targetCount: planning.plan.selectedTargets.length,
      trackCount: planning.plan.tracks.length,
    }),
  });
}

function preparationFailure(
  cause: Extract<ProjectStemPrintPreparation, { canPrepare: false }>['cause'],
  message: string,
): Extract<ProjectStemPrintPreparation, { canPrepare: false }> {
  return Object.freeze({ canPrepare: false as const, cause, message });
}
