import {
  doesClipSupportTakeMedia,
  doesClipTakeMatchArtifact,
} from './clipTakeActivation';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getPatchTabConnectionCompatibility,
  getPatchTabDefinition,
} from './patchTabPortContract';
import {
  getTabFlowFamilyLines,
  getTabFlowFamilyPreflight,
} from './tabFlowFamilies';
import { createMidiContentHash } from './midiContentHash';
import type {
  Clip,
  ClipTake,
  ClipType,
  PatchTab,
  PatchTabDefinition,
  PatchTabInputBinding,
  PatchTabParameter,
  ProjectArtifact,
  ProjectState,
  SoundFontAssignment,
  TabFlowConnection,
  TabFlowLine,
} from './types';

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type AutoPatchGraphSnapshotRequest = Readonly<{
  snapshotId: string;
  createdAt: string;
  targetClipIds: readonly string[];
}>;

export type AutoPatchActiveTakeSnapshot = Readonly<{
  artifactId: string;
  artifactCreatedAt: string;
  clipTakeId: string;
  clipTakeCreatedAt: string;
  mediaType: ClipTake['mediaType'];
  sourceType: ClipTake['sourceType'];
  contentHash?: string;
  revision?: number;
}>;

export type AutoPatchSoundFontSnapshot = DeepReadonly<SoundFontAssignment>;

export type AutoPatchTargetSnapshot = Readonly<{
  activeTake: AutoPatchActiveTakeSnapshot;
  clipId: string;
  clipType: ClipType;
  clipVersion: number;
  lengthTicks: number;
  soundFont?: AutoPatchSoundFontSnapshot;
  startTick: number;
  trackId: string;
}>;

export type AutoPatchPatchTabSnapshot = Readonly<{
  id: string;
  inputBindings: readonly DeepReadonly<PatchTabInputBinding>[];
  name: string;
  nodeTypeId: string;
  nodeVersion: string;
  parameters: readonly DeepReadonly<PatchTabParameter>[];
  portContract: DeepReadonly<PatchTabDefinition>;
}>;

export type AutoPatchFamilyGraphSnapshot = Readonly<{
  connectionOrder: readonly string[];
  connections: readonly DeepReadonly<TabFlowConnection>[];
  familyId: string;
  familyRevision: number;
  lineOrder: readonly string[];
  lines: readonly DeepReadonly<TabFlowLine>[];
  order: number;
  patchTabOrder: readonly string[];
  patchTabs: readonly AutoPatchPatchTabSnapshot[];
}>;

export type AutoPatchGraphSnapshot = Readonly<{
  createdAt: string;
  families: readonly AutoPatchFamilyGraphSnapshot[];
  familyOrder: readonly string[];
  projectContext: Readonly<{
    bpm: number;
    key: string;
  }>;
  snapshotId: string;
  targetClipIds: readonly string[];
  targets: readonly AutoPatchTargetSnapshot[];
}>;

export type AutoPatchGraphSnapshotFailureReason =
  | 'invalid-request'
  | 'project-invalid'
  | 'target-not-found'
  | 'target-ambiguous'
  | 'active-take-required'
  | 'active-take-invalid'
  | 'artifact-invalid'
  | 'no-enabled-family'
  | 'family-blocked'
  | 'graph-invalid'
  | 'contract-unavailable';

export type AutoPatchGraphSnapshotResolution =
  | Readonly<{
      canBuild: true;
      snapshot: AutoPatchGraphSnapshot;
    }>
  | Readonly<{
      canBuild: false;
      reason: AutoPatchGraphSnapshotFailureReason;
      message: string;
      familyId?: string;
    }>;

type FamilyBuildResolution =
  | Readonly<{
      canBuild: true;
      snapshot: AutoPatchFamilyGraphSnapshot;
    }>
  | Readonly<{
      canBuild: false;
      reason: 'graph-invalid' | 'contract-unavailable';
      message: string;
    }>;

export function createAutoPatchGraphSnapshot(
  project: ProjectState,
  request: AutoPatchGraphSnapshotRequest,
): AutoPatchGraphSnapshotResolution {
  const requestFailure = validateRequest(project, request);

  if (requestFailure) {
    return requestFailure;
  }

  const projectFailure = validateProjectIdentity(project);

  if (projectFailure) {
    return projectFailure;
  }

  const targetResolution = buildTargetSnapshots(project, request.targetClipIds);

  if (!targetResolution.canBuild) {
    return targetResolution;
  }

  const preflight = getTabFlowFamilyPreflight(
    project.tabFlowLines ?? [],
    project.connections,
    project.patchTabs,
  );
  const blockedFamily = preflight.find((family) => family.status === 'blocked');

  if (blockedFamily) {
    return failure(
      'family-blocked',
      `Flow Family ${blockedFamily.rootLine.id} is blocked: ${blockedFamily.reason}`,
      blockedFamily.rootLine.id,
    );
  }

  const readyFamilies = preflight.filter((family) => family.status === 'ready');

  const connectionMap = new Map(
    project.connections.map((connection) => [connection.id, connection]),
  );
  const patchTabMap = new Map(
    project.patchTabs.map((patchTab) => [patchTab.id, patchTab]),
  );
  const patchTabOrder = new Map(
    project.patchTabs.map((patchTab, index) => [patchTab.id, index]),
  );
  const claimedConnectionIds = new Set<string>();
  const families: AutoPatchFamilyGraphSnapshot[] = [];

  for (const family of readyFamilies) {
    const familyLines = getTabFlowFamilyLines(
      project.tabFlowLines ?? [],
      family.rootLine.id,
    );
    const familyResolution = buildFamilySnapshot(
      familyLines,
      connectionMap,
      patchTabMap,
      patchTabOrder,
    );

    if (!familyResolution.canBuild) {
      return failure(
        familyResolution.reason,
        familyResolution.message,
        family.rootLine.id,
      );
    }

    const reusedConnectionId =
      familyResolution.snapshot.connectionOrder.find((connectionId) =>
        claimedConnectionIds.has(connectionId),
      );

    if (reusedConnectionId) {
      return failure(
        'graph-invalid',
        `Connection ${reusedConnectionId} belongs to more than one ON Flow Family.`,
        family.rootLine.id,
      );
    }

    familyResolution.snapshot.connectionOrder.forEach((connectionId) => {
      claimedConnectionIds.add(connectionId);
    });
    families.push(familyResolution.snapshot);
  }

  const standaloneFamilies = buildStandaloneStableAudio3Families(
    project,
    patchTabOrder,
  );
  const familyIds = new Set(families.map((family) => family.familyId));

  for (const standaloneFamily of standaloneFamilies) {
    if (familyIds.has(standaloneFamily.familyId)) {
      return failure(
        'graph-invalid',
        `Standalone Stable Audio 3 Family ${standaloneFamily.familyId} conflicts with an existing Flow Family.`,
        standaloneFamily.familyId,
      );
    }

    familyIds.add(standaloneFamily.familyId);
    families.push(standaloneFamily);
  }

  if (families.length === 0) {
    return failure(
      'no-enabled-family',
      'Auto Patch requires at least one ON Flow Family or explicitly Timeline-bound standalone Stable Audio 3 Stage.',
    );
  }

  return freezeDeep({
    canBuild: true,
    snapshot: {
      createdAt: request.createdAt,
      families,
      familyOrder: families.map((family) => family.familyId),
      projectContext: {
        bpm: project.bpm,
        key: project.key,
      },
      snapshotId: request.snapshotId,
      targetClipIds: [...request.targetClipIds],
      targets: targetResolution.targets,
    },
  });
}

function buildStandaloneStableAudio3Families(
  project: ProjectState,
  projectPatchTabOrder: ReadonlyMap<string, number>,
): AutoPatchFamilyGraphSnapshot[] {
  const connectedPatchTabIds = new Set(
    project.connections.flatMap((connection) => [
      connection.fromPatchTabId,
      connection.toPatchTabId,
    ]),
  );

  return project.patchTabs
    .filter(
      (patchTab) =>
        patchTab.status === 'ready' &&
        patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3 &&
        !connectedPatchTabIds.has(patchTab.id) &&
        hasExactTimelineAudioBinding(patchTab),
    )
    .sort(
      (left, right) =>
        (projectPatchTabOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (projectPatchTabOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id),
    )
    .map((patchTab, index) => {
      const definition = getPatchTabDefinition(patchTab);

      if (!definition) {
        throw new Error(
          `Standalone Stable Audio 3 PatchTab ${patchTab.id} lost its built-in contract.`,
        );
      }

      return freezeDeep({
        connectionOrder: [],
        connections: [],
        familyId: createStandaloneStableAudio3FamilyId(patchTab.id),
        familyRevision: 1,
        lineOrder: [],
        lines: [],
        order: project.patchTabs.length + index,
        patchTabOrder: [patchTab.id],
        patchTabs: [createPatchTabSnapshot(patchTab, definition)],
      });
    });
}

function hasExactTimelineAudioBinding(patchTab: PatchTab): boolean {
  const bindings = patchTab.inputBindings ?? [];

  return (
    bindings.length === 1 &&
    bindings[0]?.kind === 'timeline-selection' &&
    bindings[0].portId === 'audio-in' &&
    bindings[0].selectionKind === 'clip'
  );
}

export function createStandaloneStableAudio3FamilyId(
  patchTabId: string,
): string {
  return `standalone-stable-audio-3:${patchTabId}`;
}

function validateRequest(
  project: ProjectState,
  request: AutoPatchGraphSnapshotRequest,
): AutoPatchGraphSnapshotResolution | undefined {
  if (!request.snapshotId.trim()) {
    return failure('invalid-request', 'Snapshot ID is required.');
  }

  if (!request.createdAt.trim() || !Number.isFinite(Date.parse(request.createdAt))) {
    return failure('invalid-request', 'Snapshot createdAt must be a valid timestamp.');
  }

  if (request.targetClipIds.length === 0) {
    return failure('invalid-request', 'At least one resolved target Clip ID is required.');
  }

  if (
    request.targetClipIds.some((clipId) => !clipId.trim()) ||
    new Set(request.targetClipIds).size !== request.targetClipIds.length
  ) {
    return failure(
      'invalid-request',
      'Resolved target Clip IDs must be non-empty and unique.',
    );
  }

  if (!Number.isFinite(project.bpm) || project.bpm <= 0 || !project.key.trim()) {
    return failure(
      'project-invalid',
      'Project tempo and key must be valid before Auto Patch can run.',
    );
  }

  return undefined;
}

function validateProjectIdentity(
  project: ProjectState,
): AutoPatchGraphSnapshotResolution | undefined {
  const duplicateTrackId = findDuplicateId(project.tracks.map((track) => track.id));

  if (duplicateTrackId) {
    return failure(
      'project-invalid',
      `Project contains duplicate Track ID ${duplicateTrackId}.`,
    );
  }

  const duplicatePatchTabId = findDuplicateId(
    project.patchTabs.map((patchTab) => patchTab.id),
  );

  if (duplicatePatchTabId) {
    return failure(
      'project-invalid',
      `Project contains duplicate PatchTab ID ${duplicatePatchTabId}.`,
    );
  }

  const duplicateConnectionId = findDuplicateId(
    project.connections.map((connection) => connection.id),
  );

  if (duplicateConnectionId) {
    return failure(
      'project-invalid',
      `Project contains duplicate Connection ID ${duplicateConnectionId}.`,
    );
  }

  const duplicateLineId = findDuplicateId(
    (project.tabFlowLines ?? []).map((line) => line.id),
  );

  if (duplicateLineId) {
    return failure(
      'project-invalid',
      `Project contains duplicate TabFlow Line ID ${duplicateLineId}.`,
    );
  }

  const duplicateArtifactId = findDuplicateId(
    (project.artifacts ?? []).map((artifact) => artifact.artifactId),
  );

  if (duplicateArtifactId) {
    return failure(
      'project-invalid',
      `Project contains duplicate Artifact ID ${duplicateArtifactId}.`,
    );
  }

  return undefined;
}

function buildTargetSnapshots(
  project: ProjectState,
  targetClipIds: readonly string[],
):
  | Readonly<{ canBuild: true; targets: readonly AutoPatchTargetSnapshot[] }>
  | Exclude<AutoPatchGraphSnapshotResolution, Readonly<{ canBuild: true }>> {
  const targets: AutoPatchTargetSnapshot[] = [];

  for (const targetClipId of targetClipIds) {
    const clipMatches = project.tracks.flatMap((track) =>
      track.clips
        .filter((clip) => clip.id === targetClipId)
        .map((clip) => ({ clip, trackId: track.id })),
    );

    if (clipMatches.length === 0) {
      return failure(
        'target-not-found',
        `Target Clip ${targetClipId} does not exist.`,
      );
    }

    if (clipMatches.length !== 1) {
      return failure(
        'target-ambiguous',
        `Target Clip ID ${targetClipId} is not unique in the Project.`,
      );
    }

    const { clip, trackId } = clipMatches[0];
    const activeTakeResolution = buildActiveTakeSnapshot(project, clip);

    if (!activeTakeResolution.canBuild) {
      return activeTakeResolution;
    }

    targets.push({
      activeTake: activeTakeResolution.activeTake,
      clipId: clip.id,
      clipType: clip.type,
      clipVersion: clip.version,
      lengthTicks: clip.lengthTicks,
      ...(clip.soundFont
        ? { soundFont: cloneSoundFontAssignment(clip.soundFont) }
        : {}),
      startTick: clip.startTick,
      trackId,
    });
  }

  return freezeDeep({ canBuild: true, targets });
}

function buildActiveTakeSnapshot(
  project: ProjectState,
  clip: Clip,
):
  | Readonly<{ canBuild: true; activeTake: AutoPatchActiveTakeSnapshot }>
  | Exclude<AutoPatchGraphSnapshotResolution, Readonly<{ canBuild: true }>> {
  if (!clip.activeClipTakeId) {
    return failure(
      'active-take-required',
      `Target Clip ${clip.id} does not have an Active Take.`,
    );
  }

  const activeTakes = (clip.clipTakes ?? []).filter(
    (clipTake) => clipTake.clipTakeId === clip.activeClipTakeId,
  );
  const projectTakeMatches = project.tracks.flatMap((track) =>
    track.clips.flatMap((candidateClip) =>
      (candidateClip.clipTakes ?? []).filter(
        (clipTake) => clipTake.clipTakeId === clip.activeClipTakeId,
      ),
    ),
  );

  if (activeTakes.length !== 1 || projectTakeMatches.length !== 1) {
    return failure(
      'active-take-invalid',
      `Target Clip ${clip.id} does not resolve to one Project-unique Active Take.`,
    );
  }

  const activeTake = activeTakes[0];

  if (!doesClipSupportTakeMedia(clip, activeTake.mediaType)) {
    return failure(
      'active-take-invalid',
      `Active Take ${activeTake.clipTakeId} is not compatible with Clip ${clip.id}.`,
    );
  }

  const artifacts = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === activeTake.artifactId,
  );

  if (
    artifacts.length !== 1 ||
    !doesClipTakeMatchArtifact(activeTake, artifacts[0])
  ) {
    return failure(
      'artifact-invalid',
      `Active Take ${activeTake.clipTakeId} does not resolve to one matching Artifact.`,
    );
  }

  const artifact = artifacts[0];
  const midiIdentity =
    artifact.kind === 'midi'
      ? getMidiArtifactIdentity(artifact, activeTake)
      : undefined;

  return freezeDeep({
    canBuild: true,
    activeTake: {
      artifactId: artifact.artifactId,
      artifactCreatedAt: artifact.createdAt,
      clipTakeId: activeTake.clipTakeId,
      clipTakeCreatedAt: activeTake.createdAt,
      mediaType: activeTake.mediaType,
      sourceType: activeTake.sourceType,
      ...(midiIdentity?.contentHash !== undefined
        ? { contentHash: midiIdentity.contentHash }
        : {}),
      ...(midiIdentity?.revision !== undefined
        ? { revision: midiIdentity.revision }
        : {}),
    },
  });
}

function buildFamilySnapshot(
  familyLines: TabFlowLine[],
  connectionMap: Map<string, TabFlowConnection>,
  patchTabMap: Map<string, PatchTab>,
  projectPatchTabOrder: Map<string, number>,
): FamilyBuildResolution {
  const rootLine = familyLines.find((line) => !line.attachment);

  if (!rootLine || familyLines.length === 0) {
    return {
      canBuild: false,
      reason: 'graph-invalid',
      message: 'Flow Family root is missing.',
    };
  }

  if (
    familyLines.some(
      (line) =>
        !Number.isSafeInteger(line.revision) ||
        line.revision < 1 ||
        !line.id.trim(),
    )
  ) {
    return {
      canBuild: false,
      reason: 'graph-invalid',
      message: `Flow Family ${rootLine.id} contains an invalid Line revision or ID.`,
    };
  }

  const lineOrder = familyLines.map((line) => line.id);
  const connectionOrderFromLines = familyLines.flatMap(
    (line) => line.connectionIds,
  );
  const duplicateFamilyConnectionId = findDuplicateId(connectionOrderFromLines);

  if (duplicateFamilyConnectionId) {
    return {
      canBuild: false,
      reason: 'graph-invalid',
      message: `Connection ${duplicateFamilyConnectionId} appears more than once in Flow Family ${rootLine.id}.`,
    };
  }

  const sourceConnections = connectionOrderFromLines.map((connectionId) =>
    connectionMap.get(connectionId),
  );

  if (sourceConnections.some((connection) => !connection)) {
    return {
      canBuild: false,
      reason: 'graph-invalid',
      message: `Flow Family ${rootLine.id} references a missing Connection.`,
    };
  }

  const connections = sourceConnections as TabFlowConnection[];
  const patchTabIds = new Set<string>();

  connections.forEach((connection) => {
    patchTabIds.add(connection.fromPatchTabId);
    patchTabIds.add(connection.toPatchTabId);
  });

  const topologicalOrder = getTopologicalPatchTabOrder(
    patchTabIds,
    connections,
    projectPatchTabOrder,
  );

  if (!topologicalOrder) {
    return {
      canBuild: false,
      reason: 'graph-invalid',
      message: `Flow Family ${rootLine.id} contains a PatchTab cycle.`,
    };
  }

  const patchTabs: AutoPatchPatchTabSnapshot[] = [];

  for (const patchTabId of topologicalOrder) {
    const patchTab = patchTabMap.get(patchTabId);
    const definition = getPatchTabDefinition(patchTab);

    if (!patchTab || !definition) {
      return {
        canBuild: false,
        reason: 'contract-unavailable',
        message: `PatchTab ${patchTabId} does not have an executable Port Contract.`,
      };
    }

    patchTabs.push(createPatchTabSnapshot(patchTab, definition));
  }

  const normalizedConnections: TabFlowConnection[] = [];

  for (const connection of connections) {
    const compatibility = getPatchTabConnectionCompatibility(
      patchTabMap.get(connection.fromPatchTabId),
      patchTabMap.get(connection.toPatchTabId),
      connection.fromPortId,
      connection.toPortId,
    );

    if (
      compatibility.state !== 'compatible' ||
      !compatibility.outputPort ||
      !compatibility.inputPort
    ) {
      return {
        canBuild: false,
        reason: 'contract-unavailable',
        message: `Connection ${connection.id} cannot resolve exact input and output Ports.`,
      };
    }

    normalizedConnections.push({
      ...connection,
      activation: connection.activation ?? 'on',
      createdOrder: connection.createdOrder ?? connection.order,
      fromPortId: compatibility.outputPort.id,
      toPortId: compatibility.inputPort.id,
    });
  }

  const topologicalIndex = new Map(
    topologicalOrder.map((patchTabId, index) => [patchTabId, index]),
  );
  normalizedConnections.sort(
    (left, right) =>
      (topologicalIndex.get(left.fromPatchTabId) ?? Number.MAX_SAFE_INTEGER) -
        (topologicalIndex.get(right.fromPatchTabId) ?? Number.MAX_SAFE_INTEGER) ||
      (topologicalIndex.get(left.toPatchTabId) ?? Number.MAX_SAFE_INTEGER) -
        (topologicalIndex.get(right.toPatchTabId) ?? Number.MAX_SAFE_INTEGER) ||
      (left.createdOrder ?? left.order) - (right.createdOrder ?? right.order) ||
      left.id.localeCompare(right.id),
  );

  const nodeIds = new Set(topologicalOrder);

  for (const line of familyLines) {
    const attachment = line.attachment;

    if (!attachment) {
      continue;
    }

    if (!nodeIds.has(attachment.patchTabId)) {
      return {
        canBuild: false,
        reason: 'graph-invalid',
        message: `Line ${line.id} attaches to a PatchTab outside Flow Family ${rootLine.id}.`,
      };
    }

    if (attachment.portId) {
      const definition = getPatchTabDefinition(
        patchTabMap.get(attachment.patchTabId),
      );
      const ports =
        attachment.kind === 'branch-from'
          ? definition?.outputs
          : definition?.inputs;

      if (!ports?.some((port) => port.id === attachment.portId)) {
        return {
          canBuild: false,
          reason: 'contract-unavailable',
          message: `Line ${line.id} references an unavailable attachment Port.`,
        };
      }
    }
  }

  return freezeDeep({
    canBuild: true,
    snapshot: {
      connectionOrder: normalizedConnections.map(
        (connection) => connection.id,
      ),
      connections: normalizedConnections.map(cloneConnection),
      familyId: rootLine.id,
      familyRevision: rootLine.revision,
      lineOrder,
      lines: familyLines.map(cloneLine),
      order: rootLine.order,
      patchTabOrder: topologicalOrder,
      patchTabs,
    },
  });
}

function getTopologicalPatchTabOrder(
  patchTabIds: Set<string>,
  connections: TabFlowConnection[],
  projectPatchTabOrder: Map<string, number>,
): string[] | undefined {
  const indegree = new Map<string, number>();
  const outgoingConnections = new Map<string, TabFlowConnection[]>();

  patchTabIds.forEach((patchTabId) => {
    indegree.set(patchTabId, 0);
    outgoingConnections.set(patchTabId, []);
  });

  connections.forEach((connection) => {
    indegree.set(
      connection.toPatchTabId,
      (indegree.get(connection.toPatchTabId) ?? 0) + 1,
    );
    outgoingConnections
      .get(connection.fromPatchTabId)
      ?.push(connection);
  });

  const comparePatchTabs = (left: string, right: string) =>
    (projectPatchTabOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (projectPatchTabOrder.get(right) ?? Number.MAX_SAFE_INTEGER) ||
    left.localeCompare(right);
  const available = [...patchTabIds]
    .filter((patchTabId) => indegree.get(patchTabId) === 0)
    .sort(comparePatchTabs);
  const result: string[] = [];

  while (available.length > 0) {
    const patchTabId = available.shift();

    if (!patchTabId) {
      break;
    }

    result.push(patchTabId);
    const outgoing = [...(outgoingConnections.get(patchTabId) ?? [])].sort(
      (left, right) =>
        (left.createdOrder ?? left.order) -
          (right.createdOrder ?? right.order) ||
        left.id.localeCompare(right.id),
    );

    outgoing.forEach((connection) => {
      const nextIndegree =
        (indegree.get(connection.toPatchTabId) ?? 0) - 1;
      indegree.set(connection.toPatchTabId, nextIndegree);

      if (nextIndegree === 0) {
        available.push(connection.toPatchTabId);
        available.sort(comparePatchTabs);
      }
    });
  }

  return result.length === patchTabIds.size ? result : undefined;
}

function getMidiArtifactIdentity(
  artifact: Extract<ProjectArtifact, { kind: 'midi' }>,
  activeTake: ClipTake,
): Readonly<{ contentHash?: string; revision?: number }> {
  const artifactContentHash =
    'contentHash' in artifact ? artifact.contentHash : undefined;
  const takeContentHash =
    'contentHash' in activeTake ? activeTake.contentHash : undefined;
  const artifactRevision =
    'revision' in artifact ? artifact.revision : undefined;
  const takeRevision =
    'revision' in activeTake ? activeTake.revision : undefined;
  let contentHash = artifactContentHash ?? takeContentHash;

  if (contentHash === undefined) {
    try {
      contentHash = createMidiContentHash(artifact.midi);
    } catch {
      contentHash = undefined;
    }
  }

  return {
    ...(contentHash !== undefined
      ? { contentHash }
      : {}),
    revision: artifactRevision ?? takeRevision ?? 1,
  };
}

function clonePatchTabDefinition(
  definition: PatchTabDefinition,
): PatchTabDefinition {
  return {
    ...definition,
    inputs: definition.inputs.map((input) => ({
      ...input,
      accepts: input.accepts.map((type) => ({ ...type })),
      ...(input.requiredCapabilities
        ? { requiredCapabilities: [...input.requiredCapabilities] }
        : {}),
      ...(input.preferredRoles
        ? { preferredRoles: [...input.preferredRoles] }
        : {}),
      allowedBindings: [...input.allowedBindings],
      cardinality: { ...input.cardinality },
    })),
    outputs: definition.outputs.map((output) => ({
      ...output,
      produces: { ...output.produces },
      ...(output.capabilities
        ? { capabilities: [...output.capabilities] }
        : {}),
    })),
  };
}

function createPatchTabSnapshot(
  patchTab: PatchTab,
  definition: PatchTabDefinition,
): AutoPatchPatchTabSnapshot {
  return {
    id: patchTab.id,
    inputBindings: (patchTab.inputBindings ?? []).map(cloneInputBinding),
    name: patchTab.name,
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
    parameters: patchTab.parameters.map(cloneParameter),
    portContract: clonePatchTabDefinition(definition),
  };
}

function cloneInputBinding(
  binding: PatchTabInputBinding,
): PatchTabInputBinding {
  return binding.kind === 'connection'
    ? { ...binding, connectionIds: [...binding.connectionIds] }
    : { ...binding };
}

function cloneParameter(parameter: PatchTabParameter): PatchTabParameter {
  return parameter.kind === 'select'
    ? { ...parameter, options: [...parameter.options] }
    : { ...parameter };
}

function cloneConnection(
  connection: TabFlowConnection,
): TabFlowConnection {
  return { ...connection };
}

function cloneLine(line: TabFlowLine): TabFlowLine {
  return {
    ...line,
    connectionIds: [...line.connectionIds],
    ...(line.attachment
      ? { attachment: { ...line.attachment } }
      : { attachment: undefined }),
  };
}

function cloneSoundFontAssignment(
  soundFont: SoundFontAssignment,
): SoundFontAssignment {
  return {
    ...soundFont,
    resource: { ...soundFont.resource },
  };
}

function findDuplicateId(ids: readonly string[]): string | undefined {
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) {
      return id;
    }

    seen.add(id);
  }

  return undefined;
}

function failure(
  reason: AutoPatchGraphSnapshotFailureReason,
  message: string,
  familyId?: string,
): Exclude<AutoPatchGraphSnapshotResolution, Readonly<{ canBuild: true }>> {
  return freezeDeep({
    canBuild: false,
    reason,
    message,
    ...(familyId ? { familyId } : {}),
  });
}

function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => {
      freezeDeep(child);
    });
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
}
