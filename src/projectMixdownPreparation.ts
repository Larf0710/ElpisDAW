import type {
  LocalEngineGeneratedAudioDescriptor,
  LocalEngineSourceDescriptor,
  LocalEngineSourceRestoration,
} from './localEngineClient';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import {
  createProjectMixdownApiRequest,
  type ProjectMixdownApiRequest,
} from './projectMixdownApi';
import {
  createProjectMixdownPlan,
  type ProjectMixdownPlan,
} from './projectMixdownPlan';
import {
  createProjectMixdownRegistrationIntent,
  type ProjectMixdownRegistrationIntent,
} from './projectMixdownRegistration';
import {
  createProjectPlaybackPlan,
  type SourceAvailabilitySnapshot,
} from './projectPlaybackPlan';
import { createProjectPlaybackSchedule } from './projectPlaybackRuntime';
import type { PatchTab, ProjectState } from './types';
import { isExportPatchTab } from './workflow';

export type ClipFilerProductionSettingsResolution =
  | Readonly<{
      canResolve: true;
      settings: Readonly<{ format: 'WAV'; normalize: 'Off' }>;
    }>
  | Readonly<{
      canResolve: false;
      cause:
        | 'clip-filer-invalid'
        | 'format-unsupported'
        | 'normalize-unsupported'
        | 'parameters-invalid';
      message: string;
    }>;

export type ProjectMixdownPreparation =
  | Readonly<{
      canPrepare: true;
      intent: ProjectMixdownRegistrationIntent;
      plan: ProjectMixdownPlan;
      request: ProjectMixdownApiRequest;
      summary: Readonly<{
        durationSeconds: number;
        outputClipName: string;
        sourceCount: number;
        trackCount: number;
      }>;
    }>
  | Readonly<{
      canPrepare: false;
      cause:
        | 'intent-unavailable'
        | 'mixdown-plan-unavailable'
        | 'playback-plan-unavailable'
        | 'request-invalid'
        | 'source-descriptor-unavailable';
      message: string;
    }>;

export type ProjectMixdownDownloadResolution =
  | Readonly<{
      canDownload: true;
      descriptor: LocalEngineGeneratedAudioDescriptor;
      fileName: string;
    }>
  | Readonly<{
      canDownload: false;
      cause:
        | 'active-take-unavailable'
        | 'clip-filer-settings-invalid'
        | 'mixdown-source-invalid'
        | 'target-invalid';
      message: string;
    }>;

export function resolveClipFilerProductionSettings(
  patchTab: PatchTab | undefined,
): ClipFilerProductionSettingsResolution {
  if (!patchTab || !isExportPatchTab(patchTab)) {
    return settingsFailure(
      'clip-filer-invalid',
      'Project Mixdown requires one Clip Filer PatchTab.',
    );
  }

  const format = resolveUniqueSelectValue(patchTab, 'format');
  const normalize = resolveUniqueSelectValue(patchTab, 'normalize');

  if (!format || !normalize) {
    return settingsFailure(
      'parameters-invalid',
      'Clip Filer requires one Format and Normalize setting.',
    );
  }

  if (format !== 'WAV') {
    return settingsFailure(
      'format-unsupported',
      'Production Mixdown currently supports WAV only. Select WAV in Clip Filer.',
    );
  }

  if (normalize !== 'Off') {
    return settingsFailure(
      'normalize-unsupported',
      'Set Normalize to Off. Raw Mixdown preserves the exact Mixer output.',
    );
  }

  return Object.freeze({
    canResolve: true as const,
    settings: Object.freeze({ format: 'WAV' as const, normalize: 'Off' as const }),
  });
}

export function prepareProjectMixdown(
  project: ProjectState,
  sourceDescriptors: readonly LocalEngineSourceDescriptor[],
  restoration: LocalEngineSourceRestoration,
  operationId?: string,
): ProjectMixdownPreparation {
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
    selection: project.selection,
    sourceAvailability,
    tracks: project.tracks,
  } as const;
  const playbackPlanning = createProjectPlaybackPlan({
    ...planningInput,
    purpose: 'mixdown',
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
    scheduling.schedule.tracks.flatMap((track) =>
      track.events.map((event) => event.sourceId),
    ),
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
      'Mixdown blocked: every audible source must have one exact Engine-readable descriptor.',
    );
  }

  const mixdownPlanning = createProjectMixdownPlan({
    ...planningInput,
    sourceDescriptors: exactSourceDescriptors,
  });

  if (!mixdownPlanning.canCreate) {
    return preparationFailure(
      'mixdown-plan-unavailable',
      mixdownPlanning.message,
    );
  }

  let request: ProjectMixdownApiRequest;

  try {
    request = createProjectMixdownApiRequest(
      mixdownPlanning.plan,
      operationId,
    );
  } catch (error) {
    return preparationFailure(
      'request-invalid',
      error instanceof Error
        ? error.message
        : 'Project Mixdown Request could not be created.',
    );
  }

  const intentResolution = createProjectMixdownRegistrationIntent(
    project,
    request,
    mixdownPlanning.mixerSnapshot,
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
    plan: mixdownPlanning.plan,
    request,
    summary: Object.freeze({
      durationSeconds: mixdownPlanning.plan.durationSeconds,
      outputClipName: intentResolution.intent.output.clipName,
      sourceCount: mixdownPlanning.plan.sources.length,
      trackCount: mixdownPlanning.plan.tracks.length,
    }),
  });
}

export function resolveProjectMixdownDownload(
  project: ProjectState,
  patchTab: PatchTab | undefined,
  selectedClipId: string | undefined,
): ProjectMixdownDownloadResolution {
  const settings = resolveClipFilerProductionSettings(patchTab);

  if (!settings.canResolve) {
    return downloadFailure('clip-filer-settings-invalid', settings.message);
  }

  const selectedClips = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => clip.id === selectedClipId),
  );
  const selectedClip = selectedClips.length === 1 ? selectedClips[0] : undefined;

  if (!selectedClip || selectedClip.type !== 'mixdown') {
    return downloadFailure(
      'target-invalid',
      'Select one registered Raw Mix Clip before saving its WAV.',
    );
  }

  const activeSource = resolveActiveAudioTakeSource(project, selectedClip.id);

  if (!activeSource.canResolve) {
    return downloadFailure('active-take-unavailable', activeSource.message);
  }

  const activeTake = (selectedClip.clipTakes ?? []).find(
    (clipTake) => clipTake.clipTakeId === selectedClip.activeClipTakeId,
  );
  const matchingArtifacts = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === activeSource.plan.source.artifactId,
  );
  const artifact = matchingArtifacts.length === 1 ? matchingArtifacts[0] : undefined;

  if (
    !activeTake ||
    activeTake.sourceType !== 'mixdown' ||
    !('sourceOperationId' in activeTake) ||
    !artifact ||
    artifact.kind !== 'audio' ||
    artifact.destination !== 'mixdown' ||
    !('mixdownProvenance' in artifact) ||
    !('sourceOperationId' in artifact) ||
    activeTake.sourceOperationId !== artifact.sourceOperationId
  ) {
    return downloadFailure(
      'mixdown-source-invalid',
      'Selected Raw Mix is not backed by one registered Project Mixdown operation.',
    );
  }

  const descriptor = activeSource.plan.descriptor;

  if (
    descriptor.kind !== 'generated' ||
    !descriptor.relativePath.startsWith('mixdowns/') ||
    descriptor.name !== `${descriptor.sourceId}.wav` ||
    descriptor.sizeBytes === undefined
  ) {
    return downloadFailure(
      'mixdown-source-invalid',
      'Selected Raw Mix does not resolve to one finalized Project Mixdown WAV.',
    );
  }

  return Object.freeze({
    canDownload: true as const,
    descriptor: Object.freeze({
      kind: 'generated' as const,
      name: descriptor.name,
      relativePath: descriptor.relativePath,
      sizeBytes: descriptor.sizeBytes,
      sourceId: descriptor.sourceId,
    }),
    fileName: `${sanitizeFileName(project.name)}-${sanitizeFileName(selectedClip.name)}.wav`,
  });
}

function resolveUniqueSelectValue(
  patchTab: PatchTab,
  parameterId: string,
): string | undefined {
  const matches = patchTab.parameters.filter(
    (parameter) =>
      parameter.id === parameterId &&
      parameter.kind === 'select',
  );
  const match = matches.length === 1 ? matches[0] : undefined;

  return match && typeof match.value === 'string' ? match.value : undefined;
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);

  return sanitized || 'ElpisDAW';
}

function settingsFailure(
  cause: Extract<
    ClipFilerProductionSettingsResolution,
    { canResolve: false }
  >['cause'],
  message: string,
): Extract<ClipFilerProductionSettingsResolution, { canResolve: false }> {
  return Object.freeze({ canResolve: false as const, cause, message });
}

function preparationFailure(
  cause: Extract<ProjectMixdownPreparation, { canPrepare: false }>['cause'],
  message: string,
): Extract<ProjectMixdownPreparation, { canPrepare: false }> {
  return Object.freeze({ canPrepare: false as const, cause, message });
}

function downloadFailure(
  cause: Extract<ProjectMixdownDownloadResolution, { canDownload: false }>['cause'],
  message: string,
): Extract<ProjectMixdownDownloadResolution, { canDownload: false }> {
  return Object.freeze({ canDownload: false as const, cause, message });
}
