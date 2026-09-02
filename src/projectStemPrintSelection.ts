import { isGroupTrack, resolveGroupPlaybackTrack } from './playbackTarget';
import { reconcileProjectMixerState } from './projectMixerState';
import type { ProjectStemPrintTarget } from './projectStemPrintPlan';
import type { ProjectState } from './types';

export type ProjectStemPrintTargetOption = Readonly<{
  canSelect: boolean;
  key: string;
  kind: ProjectStemPrintTarget['kind'];
  label: string;
  message: string;
  resolvedTrackId?: string;
  target: ProjectStemPrintTarget;
}>;

export type ProjectStemPrintTargetCatalog =
  | Readonly<{
      canList: true;
      options: readonly ProjectStemPrintTargetOption[];
    }>
  | Readonly<{
      canList: false;
      message: string;
      options: readonly [];
    }>;

export type ProjectStemPrintSelectionResolution =
  | Readonly<{
      canResolve: true;
      selectedKeys: readonly string[];
      targets: readonly ProjectStemPrintTarget[];
    }>
  | Readonly<{
      canResolve: false;
      message: string;
      reason:
        | 'mixer-invalid'
        | 'resolved-channel-duplicated'
        | 'target-duplicated'
        | 'target-unavailable';
    }>;

export function createProjectStemPrintTargetKey(
  target: ProjectStemPrintTarget,
): string {
  return target.kind === 'channel'
    ? `channel:${target.trackId}`
    : `group:${target.groupTrackId}`;
}

export function listProjectStemPrintTargetOptions(
  project: ProjectState,
): ProjectStemPrintTargetCatalog {
  let normalized: ProjectState;

  try {
    normalized = reconcileProjectMixerState(project);
  } catch {
    return Object.freeze({
      canList: false as const,
      message: 'Stem Print targets are unavailable because Mixer state is invalid.',
      options: Object.freeze([]) as readonly [],
    });
  }

  const tracksById = new Map(normalized.tracks.map((track) => [track.id, track]));
  const channelOptions = (normalized.mixer?.channels ?? []).flatMap((channel) => {
    const track = tracksById.get(channel.trackId);
    if (track?.type === 'master') {
      return [];
    }
    const target = Object.freeze({
      kind: 'channel' as const,
      trackId: channel.trackId,
    });
    return [Object.freeze({
      canSelect: track !== undefined && !isGroupTrack(track),
      key: createProjectStemPrintTargetKey(target),
      kind: 'channel' as const,
      label: track?.name ?? channel.trackId,
      message: track
        ? `Print Mixer Channel ${track.name}.`
        : `Mixer Channel ${channel.trackId} has no Project Track.`,
      ...(track && !isGroupTrack(track)
        ? { resolvedTrackId: track.id }
        : {}),
      target,
    })];
  });
  const groupOptions = normalized.tracks
    .filter(isGroupTrack)
    .map((group) => {
      const target = Object.freeze({
        groupTrackId: group.id,
        kind: 'group' as const,
      });
      const resolution = resolveGroupPlaybackTrack(group, normalized.tracks);
      return Object.freeze({
        canSelect: resolution.canResolve,
        key: createProjectStemPrintTargetKey(target),
        kind: 'group' as const,
        label: group.name,
        message: resolution.canResolve
          ? `Print Group ${group.name} through active Channel ${resolution.activeTrack.name}.`
          : resolution.message,
        ...(resolution.canResolve
          ? { resolvedTrackId: resolution.activeTrack.id }
          : {}),
        target,
      });
    });

  return Object.freeze({
    canList: true as const,
    options: Object.freeze([...channelOptions, ...groupOptions]),
  });
}

export function resolveProjectStemPrintSelection(
  project: ProjectState,
  targets: readonly ProjectStemPrintTarget[],
): ProjectStemPrintSelectionResolution {
  const catalog = listProjectStemPrintTargetOptions(project);

  if (!catalog.canList) {
    return Object.freeze({
      canResolve: false as const,
      message: catalog.message,
      reason: 'mixer-invalid' as const,
    });
  }

  const optionsByKey = new Map(catalog.options.map((option) => [option.key, option]));
  const selectedKeys = targets.map(createProjectStemPrintTargetKey);

  if (new Set(selectedKeys).size !== selectedKeys.length) {
    return selectionFailure(
      'target-duplicated',
      'A Stem Print target cannot be selected more than once.',
    );
  }

  const selectedOptions: ProjectStemPrintTargetOption[] = [];
  for (const key of selectedKeys) {
    const option = optionsByKey.get(key);
    if (!option?.canSelect || !option.resolvedTrackId) {
      return selectionFailure(
        'target-unavailable',
        `Stem Print target ${key} is unavailable.`,
      );
    }
    selectedOptions.push(option);
  }

  const resolvedTrackIds = selectedOptions.map((option) => option.resolvedTrackId);
  if (new Set(resolvedTrackIds).size !== resolvedTrackIds.length) {
    return selectionFailure(
      'resolved-channel-duplicated',
      'Selected Stem Print targets resolve to the same Mixer Channel.',
    );
  }

  const selectedKeySet = new Set(selectedKeys);
  const canonicalOptions = catalog.options.filter((option) =>
    selectedKeySet.has(option.key),
  );
  return Object.freeze({
    canResolve: true as const,
    selectedKeys: Object.freeze(canonicalOptions.map((option) => option.key)),
    targets: Object.freeze(canonicalOptions.map((option) => option.target)),
  });
}

export function toggleProjectStemPrintTarget(
  project: ProjectState,
  targets: readonly ProjectStemPrintTarget[],
  target: ProjectStemPrintTarget,
): ProjectStemPrintSelectionResolution {
  const targetKey = createProjectStemPrintTargetKey(target);
  const retained = targets.filter(
    (candidate) => createProjectStemPrintTargetKey(candidate) !== targetKey,
  );
  const nextTargets = retained.length === targets.length
    ? [...retained, target]
    : retained;
  return resolveProjectStemPrintSelection(project, nextTargets);
}

function selectionFailure(
  reason: Extract<ProjectStemPrintSelectionResolution, { canResolve: false }>['reason'],
  message: string,
): Extract<ProjectStemPrintSelectionResolution, { canResolve: false }> {
  return Object.freeze({ canResolve: false as const, message, reason });
}
