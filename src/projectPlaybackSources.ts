import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import type {
  LocalEngineClient,
  LocalEngineGeneratedAudioDescriptor,
} from './localEngineClient';
import type { SourceAvailabilitySnapshot } from './projectPlaybackPlan';
import type {
  ProjectPlaybackAudioSource,
  ProjectPlaybackSchedule,
} from './projectPlaybackRuntime';
import type { SessionAudioSourceRegistry } from './sessionAudioSourceRegistry';
import type { ProjectState } from './types';

type ProjectAudioSourceState = Pick<
  ProjectState,
  'artifacts' | 'bpm' | 'tracks'
>;

type GeneratedAudioReader = Pick<LocalEngineClient, 'readGeneratedAudioWav'>;

export type ProjectPlaybackAudioSourceCollection =
  | Readonly<{
      canOpen: true;
      sources: ReadonlyMap<string, ProjectPlaybackAudioSource>;
    }>
  | Readonly<{
      canOpen: false;
      message: string;
    }>;

export function createProjectPlaybackSourceAvailabilitySnapshot(
  project: ProjectAudioSourceState,
  registry: SessionAudioSourceRegistry,
  canReadGeneratedAudio: boolean,
): SourceAvailabilitySnapshot {
  const snapshot: Record<string, 'openable' | 'unknown'> = {};

  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.activeClipTakeId) {
        const activeSource = resolveActiveAudioTakeSource(project, clip.id);

        if (activeSource.canResolve) {
          snapshot[activeSource.plan.descriptor.sourceId] =
            canReadGeneratedAudio ? 'openable' : 'unknown';
        }

        continue;
      }

      const sourceId = clip.sourceFile?.sourceId?.trim();

      if (sourceId) {
        snapshot[sourceId] = registry.has(sourceId)
          ? 'openable'
          : 'unknown';
      }
    }
  }

  return Object.freeze(snapshot);
}

export function collectProjectPlaybackAudioSources(
  schedules: readonly ProjectPlaybackSchedule[],
  registry: SessionAudioSourceRegistry,
  generatedAudioReader?: GeneratedAudioReader,
  ephemeralSources: ReadonlyMap<string, ProjectPlaybackAudioSource> = new Map(),
): ProjectPlaybackAudioSourceCollection {
  const generatedSources = collectGeneratedSources(schedules);

  if (!generatedSources.canCollect) {
    return {
      canOpen: false,
      message: generatedSources.message,
    };
  }

  const sources = new Map<string, ProjectPlaybackAudioSource>();

  for (const event of schedules.flatMap((schedule) =>
    schedule.tracks.flatMap((track) => track.events),
  )) {
    if (sources.has(event.sourceId)) {
      continue;
    }

    const ephemeralSource = ephemeralSources.get(event.sourceId);

    if (ephemeralSource) {
      sources.set(event.sourceId, ephemeralSource);
      continue;
    }

    const generatedSource = generatedSources.descriptors.get(event.sourceId);

    if (generatedSource) {
      if (!generatedAudioReader) {
        return {
          canOpen: false,
          message: `Playback locked: ${event.clipName} requires Local Engine access to its Active Take.`,
        };
      }

      sources.set(event.sourceId, {
        data: readGeneratedSource(generatedAudioReader, generatedSource),
        kind: 'generated',
        name: generatedSource.name,
      });
      continue;
    }

    const file = registry.get(event.sourceId);

    if (!file) {
      return {
        canOpen: false,
        message: `Playback locked: ${event.clipName} is not available in this session. Relink the source first.`,
      };
    }

    sources.set(event.sourceId, {
      data: file,
      kind: 'session',
      name: file.name,
    });
  }

  return {
    canOpen: true,
    sources,
  };
}

function collectGeneratedSources(
  schedules: readonly ProjectPlaybackSchedule[],
):
  | Readonly<{
      canCollect: true;
      descriptors: ReadonlyMap<string, LocalEngineGeneratedAudioDescriptor>;
    }>
  | Readonly<{
      canCollect: false;
      message: string;
    }> {
  const descriptors = new Map<string, LocalEngineGeneratedAudioDescriptor>();

  for (const descriptor of schedules.flatMap(
    (schedule) => schedule.plan.generatedSources,
  )) {
    const existing = descriptors.get(descriptor.sourceId);

    if (existing && !areGeneratedSourcesEqual(existing, descriptor)) {
      return {
        canCollect: false,
        message: `Playback locked: generated source ${descriptor.sourceId} has conflicting descriptors.`,
      };
    }

    descriptors.set(descriptor.sourceId, descriptor);
  }

  return {
    canCollect: true,
    descriptors,
  };
}

async function readGeneratedSource(
  reader: GeneratedAudioReader,
  descriptor: LocalEngineGeneratedAudioDescriptor,
): Promise<Blob> {
  const result = await reader.readGeneratedAudioWav(descriptor);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.wav;
}

function areGeneratedSourcesEqual(
  left: LocalEngineGeneratedAudioDescriptor,
  right: LocalEngineGeneratedAudioDescriptor,
): boolean {
  return (
    left.kind === right.kind &&
    left.name === right.name &&
    left.relativePath === right.relativePath &&
    left.sizeBytes === right.sizeBytes &&
    left.sourceId === right.sourceId
  );
}
