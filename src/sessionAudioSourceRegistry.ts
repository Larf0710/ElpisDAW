import type { ClipSourceFile, ProjectState } from './types';

export class SessionAudioSourceRegistry {
  private readonly filesBySourceId = new Map<string, File>();

  register(sourceId: string, file: File): void {
    const normalizedSourceId = sourceId.trim();

    if (!normalizedSourceId) {
      throw new Error('Session audio source needs a source id.');
    }

    this.filesBySourceId.set(normalizedSourceId, file);
  }

  get(sourceId: string | undefined): File | undefined {
    const normalizedSourceId = sourceId?.trim();

    return normalizedSourceId ? this.filesBySourceId.get(normalizedSourceId) : undefined;
  }

  has(sourceId: string | undefined): boolean {
    return this.get(sourceId) !== undefined;
  }

  retain(sourceIds: ReadonlySet<string>): void {
    for (const sourceId of this.filesBySourceId.keys()) {
      if (!sourceIds.has(sourceId)) {
        this.filesBySourceId.delete(sourceId);
      }
    }
  }

  clear(): void {
    this.filesBySourceId.clear();
  }
}

export function collectReferencedSessionAudioSourceIds(
  projects: readonly ProjectState[],
): ReadonlySet<string> {
  const sourceIds = new Set<string>();

  for (const project of projects) {
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        const sourceId = clip.sourceFile?.sourceId?.trim();

        if (sourceId) {
          sourceIds.add(sourceId);
        }
      }
    }
  }

  return sourceIds;
}

export function reconnectProjectSessionAudioSources(
  project: ProjectState,
  registry: SessionAudioSourceRegistry,
): { project: ProjectState; reconnectedSourceCount: number } {
  const sourceFilesById = new Map<string, ClipSourceFile[]>();

  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const sourceId = clip.sourceFile?.sourceId?.trim();

      if (!sourceId || !clip.sourceFile) {
        continue;
      }

      sourceFilesById.set(sourceId, [...(sourceFilesById.get(sourceId) ?? []), clip.sourceFile]);
    }
  }

  const reconnectableSourceIds = new Set<string>();

  for (const [sourceId, sourceFiles] of sourceFilesById) {
    const file = registry.get(sourceId);

    if (
      file &&
      sourceFiles.every(
        (sourceFile) =>
          sourceFile.status === 'unresolved' && doesSessionAudioSourceMatchMetadata(file, sourceFile),
      )
    ) {
      reconnectableSourceIds.add(sourceId);
    }
  }

  registry.retain(reconnectableSourceIds);

  if (reconnectableSourceIds.size === 0) {
    return { project, reconnectedSourceCount: 0 };
  }

  const checkedAt = new Date().toISOString();
  const tracks = project.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      const sourceId = clip.sourceFile?.sourceId?.trim();

      if (!sourceId || !clip.sourceFile || !reconnectableSourceIds.has(sourceId)) {
        return clip;
      }

      return {
        ...clip,
        sourceFile: {
          ...clip.sourceFile,
          status: 'available' as const,
          checkedAt,
        },
      };
    }),
  }));

  return {
    project: { ...project, tracks },
    reconnectedSourceCount: reconnectableSourceIds.size,
  };
}

function doesSessionAudioSourceMatchMetadata(file: File, sourceFile: ClipSourceFile): boolean {
  if (sourceFile.name.trim() && file.name !== sourceFile.name) {
    return false;
  }

  if (sourceFile.sizeBytes !== undefined && file.size !== sourceFile.sizeBytes) {
    return false;
  }

  if (sourceFile.lastModified !== undefined && file.lastModified !== sourceFile.lastModified) {
    return false;
  }

  if (sourceFile.mimeType && file.type && file.type !== sourceFile.mimeType) {
    return false;
  }

  return true;
}
