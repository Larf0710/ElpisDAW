import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { doesClipSupportTakeMedia } from './clipTakeActivation';
import type {
  LocalEngineRestoredSource,
  LocalEngineSourceDescriptor,
  LocalEngineSourceRestoration,
} from './localEngineClient';
import type {
  Clip,
  ClipSourceFile,
  ClipSourceFileStatus,
  ProjectState,
} from './types';

export function collectProjectSourceRestorationDescriptors(
  project: ProjectState,
): readonly LocalEngineSourceDescriptor[] {
  const descriptorsById = new Map<string, LocalEngineSourceDescriptor>();

  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const descriptor = resolveClipRestorableSource(project, clip)?.descriptor;

      if (!descriptor) {
        continue;
      }

      const existing = descriptorsById.get(descriptor.sourceId);
      descriptorsById.set(
        descriptor.sourceId,
        existing ? mergeSourceDescriptors(existing, descriptor) : descriptor,
      );
    }
  }

  return Object.freeze([...descriptorsById.values()]);
}

export function applyProjectSourceRestoration(
  project: ProjectState,
  descriptors: readonly LocalEngineSourceDescriptor[],
  restoration: LocalEngineSourceRestoration,
): ProjectState {
  const restoredSources = validateRestoration(descriptors, restoration);
  let didUpdateProject = false;
  const tracks = project.tracks.map((track) => {
    let didUpdateTrack = false;
    const clips = track.clips.map((clip) => {
      const restorableSource = resolveClipRestorableSource(project, clip);
      const restoredSource = restorableSource
        ? restoredSources.get(restorableSource.descriptor.sourceId)
        : undefined;

      if (!restorableSource || !restoredSource) {
        return clip;
      }

      didUpdateProject = true;
      didUpdateTrack = true;

      return {
        ...clip,
        sourceFile: applyRestoredSource(
          restorableSource.sourceFile,
          restoredSource,
          restoration.checkedAt,
        ),
      };
    });

    return didUpdateTrack ? { ...track, clips } : track;
  });

  return didUpdateProject ? { ...project, tracks } : project;
}

function resolveClipRestorableSource(
  project: ProjectState,
  clip: Clip,
):
  | Readonly<{
      descriptor: LocalEngineSourceDescriptor;
      sourceFile: ClipSourceFile;
    }>
  | undefined {
  if (clip.activeClipTakeId) {
    if (!doesClipSupportTakeMedia(clip, 'audio')) {
      return undefined;
    }

    const resolution = resolveActiveAudioTakeSource(project, clip.id);

    if (!resolution.canResolve) {
      throw new Error(
        `Active source metadata is invalid for ${clip.id}: ${resolution.message}`,
      );
    }

    return Object.freeze({
      descriptor: resolution.plan.descriptor,
      sourceFile: resolution.plan.clip.sourceFile,
    });
  }

  const descriptor = createSourceDescriptor(clip.sourceFile);

  return descriptor && clip.sourceFile
    ? Object.freeze({ descriptor, sourceFile: clip.sourceFile })
    : undefined;
}

function createSourceDescriptor(
  sourceFile: ClipSourceFile | undefined,
): LocalEngineSourceDescriptor | undefined {
  const sourceId = sourceFile?.sourceId?.trim();

  if (!sourceFile || !sourceId) {
    return undefined;
  }

  const metadata = createSourceMetadata(sourceFile, sourceId);
  const relativePath = sourceFile.relativePath?.trim();

  if (relativePath) {
    return Object.freeze({
      kind: 'generated' as const,
      relativePath,
      sourceId,
      ...metadata,
    });
  }

  const path = sourceFile.path?.trim() || sourceFile.lastKnownPath?.trim();

  if (!path) {
    return undefined;
  }

  return Object.freeze({
    kind: 'external' as const,
    path,
    sourceId,
    ...metadata,
  });
}

function createSourceMetadata(
  sourceFile: ClipSourceFile,
  sourceId: string,
): Pick<LocalEngineSourceDescriptor, 'lastModified' | 'name' | 'sizeBytes'> {
  const name = sourceFile.name.trim();
  const sizeBytes = validateOptionalFileInteger(
    sourceFile.sizeBytes,
    sourceId,
    'sizeBytes',
  );
  const lastModified = validateOptionalFileInteger(
    sourceFile.lastModified,
    sourceId,
    'lastModified',
  );

  return {
    ...(name ? { name } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
  };
}

function validateOptionalFileInteger(
  value: number | undefined,
  sourceId: string,
  field: 'lastModified' | 'sizeBytes',
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Source ${sourceId} ${field} must be a non-negative safe integer.`,
    );
  }

  return value;
}

function mergeSourceDescriptors(
  left: LocalEngineSourceDescriptor,
  right: LocalEngineSourceDescriptor,
): LocalEngineSourceDescriptor {
  if (
    left.kind !== right.kind ||
    (left.kind === 'generated' &&
      (right.kind !== 'generated' || left.relativePath !== right.relativePath)) ||
    (left.kind === 'external' &&
      (right.kind !== 'external' || left.path !== right.path))
  ) {
    throw new Error(
      `Source ${left.sourceId} has conflicting storage descriptors.`,
    );
  }

  const metadata = {
    name: mergeOptionalMetadata(left.sourceId, 'name', left.name, right.name),
    sizeBytes: mergeOptionalMetadata(
      left.sourceId,
      'sizeBytes',
      left.sizeBytes,
      right.sizeBytes,
    ),
    lastModified: mergeOptionalMetadata(
      left.sourceId,
      'lastModified',
      left.lastModified,
      right.lastModified,
    ),
  };

  return Object.freeze(
    left.kind === 'generated'
      ? {
          kind: 'generated' as const,
          relativePath: left.relativePath,
          sourceId: left.sourceId,
          ...(metadata.name !== undefined ? { name: metadata.name } : {}),
          ...(metadata.sizeBytes !== undefined
            ? { sizeBytes: metadata.sizeBytes }
            : {}),
          ...(metadata.lastModified !== undefined
            ? { lastModified: metadata.lastModified }
            : {}),
        }
      : {
          kind: 'external' as const,
          path: left.path,
          sourceId: left.sourceId,
          ...(metadata.name !== undefined ? { name: metadata.name } : {}),
          ...(metadata.sizeBytes !== undefined
            ? { sizeBytes: metadata.sizeBytes }
            : {}),
          ...(metadata.lastModified !== undefined
            ? { lastModified: metadata.lastModified }
            : {}),
        },
  );
}

function mergeOptionalMetadata<T extends number | string>(
  sourceId: string,
  field: string,
  left: T | undefined,
  right: T | undefined,
): T | undefined {
  if (left !== undefined && right !== undefined && left !== right) {
    throw new Error(`Source ${sourceId} has conflicting ${field} metadata.`);
  }

  return left ?? right;
}

function validateRestoration(
  descriptors: readonly LocalEngineSourceDescriptor[],
  restoration: LocalEngineSourceRestoration,
): ReadonlyMap<string, LocalEngineRestoredSource> {
  if (
    typeof restoration.checkedAt !== 'string' ||
    Number.isNaN(Date.parse(restoration.checkedAt))
  ) {
    throw new Error('Source restoration checkedAt is invalid.');
  }

  const descriptorsById = new Map(
    descriptors.map((descriptor) => [descriptor.sourceId, descriptor]),
  );
  const restoredSources = new Map<string, LocalEngineRestoredSource>();

  if (descriptorsById.size !== descriptors.length) {
    throw new Error('Source restoration descriptors contain duplicate source ids.');
  }

  for (const restoredSource of restoration.sources) {
    const descriptor = descriptorsById.get(restoredSource.sourceId);

    if (
      !descriptor ||
      restoredSources.has(restoredSource.sourceId) ||
      !sourceResultMatchesDescriptor(restoredSource, descriptor)
    ) {
      throw new Error(
        `Source restoration returned an unexpected result for ${restoredSource.sourceId}.`,
      );
    }

    if (restoration.availability[restoredSource.sourceId] !== restoredSource.state) {
      throw new Error(
        `Source restoration availability disagrees for ${restoredSource.sourceId}.`,
      );
    }

    restoredSources.set(restoredSource.sourceId, restoredSource);
  }

  if (
    restoredSources.size !== descriptors.length ||
    Object.keys(restoration.availability).length !== descriptors.length
  ) {
    throw new Error('Source restoration did not return one result per descriptor.');
  }

  for (const sourceId of Object.keys(restoration.availability)) {
    if (!descriptorsById.has(sourceId)) {
      throw new Error(`Source restoration returned unexpected availability for ${sourceId}.`);
    }
  }

  return restoredSources;
}

function sourceResultMatchesDescriptor(
  restoredSource: LocalEngineRestoredSource,
  descriptor: LocalEngineSourceDescriptor,
): boolean {
  return (
    restoredSource.kind === descriptor.kind &&
    (descriptor.kind === 'generated'
      ? restoredSource.relativePath === descriptor.relativePath
      : restoredSource.path === descriptor.path)
  );
}

function applyRestoredSource(
  sourceFile: ClipSourceFile,
  restoredSource: LocalEngineRestoredSource,
  checkedAt: string,
): ClipSourceFile {
  const status = toClipSourceFileStatus(restoredSource);
  const availableMetadata =
    restoredSource.state === 'available' && restoredSource.actual
      ? {
          lastModified: restoredSource.actual.lastModified,
          name: restoredSource.actual.name,
          sizeBytes: restoredSource.actual.sizeBytes,
        }
      : {};
  const resolvedExternalPath =
    restoredSource.kind === 'external' &&
    restoredSource.state === 'available' &&
    restoredSource.resolvedPath
      ? { path: restoredSource.resolvedPath }
      : {};

  return {
    ...sourceFile,
    ...availableMetadata,
    ...resolvedExternalPath,
    checkedAt,
    status,
  };
}

function toClipSourceFileStatus(
  restoredSource: LocalEngineRestoredSource,
): ClipSourceFileStatus {
  if (restoredSource.state === 'available') {
    return 'available';
  }

  if (restoredSource.state === 'missing') {
    return 'missing';
  }

  return 'unresolved';
}
