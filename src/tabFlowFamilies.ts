import {
  getConnectionCompatibility,
  getPatchTabDefinition,
} from './patchTabPortContract';
import type { PatchTab, TabFlowConnection, TabFlowLine, TabFlowLineAttachment } from './types';

export type TabFlowLaneView = {
  line: TabFlowLine;
  rootLine: TabFlowLine;
  familyId: string;
  rootNumber: number;
  laneIndex: number;
  displayLabel: string;
  isChild: boolean;
  junctionIndex: number;
  startIndex: number;
};

export type TabFlowStructureState =
  | 'available'
  | 'already-connected'
  | 'input-full'
  | 'self-link'
  | 'loop-blocked';

export type TabFlowFamilyPreflight = {
  rootLine: TabFlowLine;
  status: 'ready' | 'off' | 'blocked';
  reason: string;
};

export function normalizeTabFlowFamilies(tabFlowLines: TabFlowLine[]): TabFlowLine[] {
  const lineMap = new Map(tabFlowLines.map((line) => [line.id, line]));
  const validParentIdByChildId = new Map<string, string>();

  tabFlowLines.forEach((line) => {
    const parentLine = line.attachment ? lineMap.get(line.attachment.parentLineId) : undefined;

    if (
      line.attachment &&
      parentLine &&
      parentLine.id !== line.id &&
      !parentLine.attachment &&
      !wouldCreateLineParentCycle(line.id, parentLine.id, lineMap)
    ) {
      validParentIdByChildId.set(line.id, parentLine.id);
    }
  });

  const roots = tabFlowLines
    .filter((line) => !validParentIdByChildId.has(line.id))
    .sort(compareLineOrder);
  const rootOrderById = new Map(roots.map((line, index) => [line.id, index]));
  const normalizedRoots = roots.map((rootLine, rootIndex) => ({
    ...rootLine,
    order: rootIndex,
    familyId: rootLine.id,
    attachment: undefined,
    childOrder: undefined,
  }));
  const normalizedRootMap = new Map(normalizedRoots.map((line) => [line.id, line]));
  const childrenByParentId = new Map<string, TabFlowLine[]>();

  tabFlowLines.forEach((line) => {
    const parentLineId = validParentIdByChildId.get(line.id);

    if (!parentLineId) {
      return;
    }

    const children = childrenByParentId.get(parentLineId) ?? [];
    children.push(line);
    childrenByParentId.set(parentLineId, children);
  });

  const result: TabFlowLine[] = [];

  normalizedRoots.forEach((rootLine) => {
    result.push(rootLine);
    const children = (childrenByParentId.get(rootLine.id) ?? []).sort(compareChildOrder);

    children.forEach((childLine, childIndex) => {
      result.push({
        ...childLine,
        order: rootOrderById.get(rootLine.id) ?? rootLine.order,
        enabled: rootLine.enabled,
        familyId: rootLine.id,
        attachment: childLine.attachment
          ? {
              ...childLine.attachment,
              parentLineId: rootLine.id,
            }
          : undefined,
        childOrder: childIndex,
      });
    });
  });

  // This guard makes invalid orphan attachments safe even when their original
  // parent disappeared during a legacy load.
  return result.map((line) => {
    const rootLine = normalizedRootMap.get(line.id);
    return rootLine ?? line;
  });
}

export function getTabFlowLaneViews(
  tabFlowLines: TabFlowLine[],
  connections: TabFlowConnection[],
  patchTabs: PatchTab[],
): TabFlowLaneView[] {
  const normalizedLines = normalizeTabFlowFamilies(tabFlowLines);
  const connectionMap = new Map(connections.map((connection) => [connection.id, connection]));
  const patchTabMap = new Map(patchTabs.map((patchTab) => [patchTab.id, patchTab]));
  const roots = normalizedLines.filter((line) => !line.attachment).sort(compareLineOrder);
  const childrenByParentId = new Map<string, TabFlowLine[]>();

  normalizedLines.forEach((line) => {
    const parentLineId = line.attachment?.parentLineId;

    if (!parentLineId) {
      return;
    }

    const children = childrenByParentId.get(parentLineId) ?? [];
    children.push(line);
    childrenByParentId.set(parentLineId, children);
  });

  return roots.flatMap((rootLine, rootIndex) => {
    const parentSequence = getLinePatchTabSequence(rootLine, connectionMap);
    const children = (childrenByParentId.get(rootLine.id) ?? [])
      .map((line) => ({
        line,
        junctionIndex: getJunctionIndex(line, parentSequence),
        portIndex: getJunctionPortIndex(line, patchTabMap),
      }))
      .sort(
        (left, right) =>
          left.junctionIndex - right.junctionIndex ||
          left.portIndex - right.portIndex ||
          compareChildOrder(left.line, right.line),
      );
    const hasChildren = children.length > 0;
    const rootNumber = rootIndex + 1;
    const rootView: TabFlowLaneView = {
      line: rootLine,
      rootLine,
      familyId: rootLine.id,
      rootNumber,
      laneIndex: 0,
      displayLabel: hasChildren ? `${rootNumber}a` : String(rootNumber),
      isChild: false,
      junctionIndex: -1,
      startIndex: 0,
    };

    return [
      rootView,
      ...children.map(({ line, junctionIndex }, childIndex): TabFlowLaneView => ({
        line,
        rootLine,
        familyId: rootLine.id,
        rootNumber,
        laneIndex: childIndex + 1,
        displayLabel: `${rootNumber}${toLaneSuffix(childIndex + 1)}`,
        isChild: true,
        junctionIndex,
        startIndex: getLaneStartIndex(line, junctionIndex),
      })),
    ];
  });
}

export function getTabFlowFamilyRoot(tabFlowLines: TabFlowLine[], lineId: string): TabFlowLine | undefined {
  const normalizedLines = normalizeTabFlowFamilies(tabFlowLines);
  const line = normalizedLines.find((candidate) => candidate.id === lineId);
  const rootLineId = line?.attachment?.parentLineId ?? line?.id;

  return normalizedLines.find((candidate) => candidate.id === rootLineId && !candidate.attachment);
}

export function getTabFlowFamilyLines(tabFlowLines: TabFlowLine[], lineId: string): TabFlowLine[] {
  const normalizedLines = normalizeTabFlowFamilies(tabFlowLines);
  const rootLine = getTabFlowFamilyRoot(normalizedLines, lineId);

  if (!rootLine) {
    return [];
  }

  return normalizedLines.filter(
    (line) => line.id === rootLine.id || line.attachment?.parentLineId === rootLine.id,
  );
}

export function getEnabledTabFlowFamilyCount(tabFlowLines: TabFlowLine[]): number {
  return normalizeTabFlowFamilies(tabFlowLines).filter((line) => !line.attachment && line.enabled).length;
}

export function getTabFlowFamilyPreflight(
  tabFlowLines: TabFlowLine[],
  connections: TabFlowConnection[],
  patchTabs: PatchTab[],
): TabFlowFamilyPreflight[] {
  const normalizedLines = normalizeTabFlowFamilies(tabFlowLines);
  const connectionMap = new Map(connections.map((connection) => [connection.id, connection]));
  const patchTabMap = new Map(patchTabs.map((patchTab) => [patchTab.id, patchTab]));

  return normalizedLines
    .filter((line) => !line.attachment)
    .sort(compareLineOrder)
    .map((rootLine) => {
      if (!rootLine.enabled) {
        return { rootLine, status: 'off', reason: 'Flow Family is OFF' };
      }

      const familyLines = getTabFlowFamilyLines(normalizedLines, rootLine.id);
      const emptyLine = familyLines.find((line) => line.connectionIds.length === 0);

      if (emptyLine) {
        return {
          rootLine,
          status: 'blocked',
          reason: emptyLine.id === rootLine.id ? 'Root lane is empty' : 'Child lane is empty',
        };
      }

      for (const line of familyLines) {
        for (const connectionId of line.connectionIds) {
          const connection = connectionMap.get(connectionId);

          if (!connection) {
            return { rootLine, status: 'blocked', reason: 'Connection is missing' };
          }

          const compatibility = getConnectionCompatibility(connection, patchTabMap);

          if (connection.activation === 'draft' || compatibility.state !== 'compatible') {
            return {
              rootLine,
              status: 'blocked',
              reason: compatibility.state === 'compatible' ? 'Draft connection' : compatibility.reason,
            };
          }

          if (!connection.enabled || connection.activation === 'off') {
            return { rootLine, status: 'blocked', reason: 'ON family contains an OFF connection' };
          }
        }
      }

      return { rootLine, status: 'ready', reason: 'All lanes passed preflight' };
    });
}

export function createTabFlowFamiliesFromConnections(
  connections: readonly TabFlowConnection[],
): TabFlowLine[] {
  const sortedConnections = [...connections].sort(
    (left, right) =>
      (left.createdOrder ?? left.order) -
        (right.createdOrder ?? right.order) ||
      left.id.localeCompare(right.id),
  );
  let lines: TabFlowLine[] = [];

  sortedConnections.forEach((connection) => {
    lines = placeConnectionInTabFlowFamily(
      lines,
      lines[0]?.id ?? '',
      connection,
      sortedConnections,
    );
  });

  return normalizeTabFlowFamilies(lines);
}

export function setTabFlowFamilyEnabled(
  tabFlowLines: TabFlowLine[],
  lineId: string,
  enabled: boolean,
): TabFlowLine[] {
  const normalizedLines = normalizeTabFlowFamilies(tabFlowLines);
  const rootLine = getTabFlowFamilyRoot(normalizedLines, lineId);

  if (!rootLine) {
    return normalizedLines;
  }

  return normalizedLines.map((line) =>
    line.id === rootLine.id || line.attachment?.parentLineId === rootLine.id ? { ...line, enabled } : line,
  );
}

export function createTabFlowChildLine(
  rootLine: TabFlowLine,
  childLineId: string,
  connectionIds: string[],
  attachment: Omit<TabFlowLineAttachment, 'parentLineId'>,
  childOrder: number,
): TabFlowLine {
  return {
    id: childLineId,
    name: `${rootLine.name} Child`,
    order: rootLine.order,
    enabled: rootLine.enabled,
    revision: 1,
    connectionIds,
    familyId: rootLine.id,
    attachment: {
      ...attachment,
      parentLineId: rootLine.id,
    },
    childOrder,
  };
}

export function mergeTabFlowFamilies(
  tabFlowLines: TabFlowLine[],
  sourceLineId: string,
  targetLineId: string,
  attachment: Omit<TabFlowLineAttachment, 'parentLineId'>,
): TabFlowLine[] {
  const normalizedLines = normalizeTabFlowFamilies(tabFlowLines);
  const sourceRoot = getTabFlowFamilyRoot(normalizedLines, sourceLineId);
  const targetRoot = getTabFlowFamilyRoot(normalizedLines, targetLineId);

  if (!sourceRoot || !targetRoot || sourceRoot.id === targetRoot.id) {
    return normalizedLines;
  }

  const targetChildren = normalizedLines.filter((line) => line.attachment?.parentLineId === targetRoot.id);
  const sourceFamilyIds = new Set(
    normalizedLines
      .filter((line) => line.id === sourceRoot.id || line.attachment?.parentLineId === sourceRoot.id)
      .map((line) => line.id),
  );
  const mergedEnabled = sourceRoot.enabled && targetRoot.enabled;
  let nextChildOrder = targetChildren.length;

  const mergedLines = normalizedLines.map((line) => {
    if (line.id === targetRoot.id || line.attachment?.parentLineId === targetRoot.id) {
      return { ...line, enabled: mergedEnabled };
    }

    if (!sourceFamilyIds.has(line.id)) {
      return line;
    }

    const nextAttachment =
      line.id === sourceRoot.id
        ? {
            ...attachment,
            parentLineId: targetRoot.id,
          }
        : {
            ...(line.attachment ?? attachment),
            parentLineId: targetRoot.id,
          };
    const nextLine = {
      ...line,
      enabled: mergedEnabled,
      familyId: targetRoot.id,
      attachment: nextAttachment,
      childOrder: nextChildOrder,
    };
    nextChildOrder += 1;
    return nextLine;
  });

  return normalizeTabFlowFamilies(
    mergedLines.map((line) =>
      line.id === targetRoot.id
        ? {
            ...line,
            enabled: mergedEnabled,
            revision: Math.max(1, line.revision) + 1,
          }
        : line,
    ),
  );
}

export function detachTabFlowChildLine(tabFlowLines: TabFlowLine[], childLineId: string): TabFlowLine[] {
  const normalizedLines = normalizeTabFlowFamilies(tabFlowLines);
  const childLine = normalizedLines.find((line) => line.id === childLineId && line.attachment);

  if (!childLine) {
    return normalizedLines;
  }

  const detachedLines = normalizedLines.map((line) =>
    line.id === childLine.id
      ? {
          ...line,
          enabled: false,
          familyId: line.id,
          attachment: undefined,
          childOrder: undefined,
          revision: Math.max(1, line.revision) + 1,
        }
      : line,
  );

  return normalizeTabFlowFamilies(detachedLines);
}

export function getTabFlowStructureState(
  connections: TabFlowConnection[],
  fromPatchTabId: string,
  toPatchTabId: string,
  toPortId?: string,
  maxInputConnections: number | 'many' = 1,
): TabFlowStructureState {
  if (fromPatchTabId === toPatchTabId) {
    return 'self-link';
  }

  if (
    connections.some(
      (connection) =>
        connection.fromPatchTabId === fromPatchTabId &&
        connection.toPatchTabId === toPatchTabId &&
        (toPortId === undefined || connection.toPortId === toPortId),
    )
  ) {
    return 'already-connected';
  }

  const activeConnections = connections.filter((connection) => connection.activation !== 'draft');

  if (wouldCreateTabFlowCycle(activeConnections, fromPatchTabId, toPatchTabId)) {
    return 'loop-blocked';
  }

  if (maxInputConnections !== 'many') {
    const inputConnectionCount = activeConnections.filter(
      (connection) =>
        connection.toPatchTabId === toPatchTabId && (toPortId === undefined || connection.toPortId === toPortId),
    ).length;

    if (inputConnectionCount >= maxInputConnections) {
      return 'input-full';
    }
  }

  return 'available';
}

export function placeConnectionInTabFlowFamily(
  tabFlowLines: TabFlowLine[],
  selectedLineId: string,
  connection: TabFlowConnection,
  connections: TabFlowConnection[],
): TabFlowLine[] {
  const normalizedLines = normalizeTabFlowFamilies(tabFlowLines);
  const connectionMap = new Map(connections.map((candidate) => [candidate.id, candidate]));
  const linesWithoutConnection = normalizedLines.map((line) => ({
    ...line,
    connectionIds: line.connectionIds.filter((connectionId) => connectionId !== connection.id),
  }));
  const sourceLine = findPreferredLineContainingPatchTab(
    linesWithoutConnection,
    connectionMap,
    connection.fromPatchTabId,
    'source',
  );
  const targetLine = findPreferredLineContainingPatchTab(
    linesWithoutConnection,
    connectionMap,
    connection.toPatchTabId,
    'target',
  );

  if (sourceLine && targetLine) {
    const sourceRoot = getTabFlowFamilyRoot(linesWithoutConnection, sourceLine.id);
    const targetRoot = getTabFlowFamilyRoot(linesWithoutConnection, targetLine.id);

    if (sourceRoot && targetRoot && sourceRoot.id !== targetRoot.id) {
      const withMergeConnection = appendConnectionToLine(linesWithoutConnection, sourceLine.id, connection.id);

      return mergeTabFlowFamilies(withMergeConnection, sourceRoot.id, targetRoot.id, {
        patchTabId: connection.toPatchTabId,
        portId: connection.toPortId,
        kind: 'merge-into',
      });
    }
  }

  if (sourceLine) {
    const sourceSequence = getLinePatchTabSequence(sourceLine, connectionMap);

    if (sourceSequence[sourceSequence.length - 1] === connection.fromPatchTabId) {
      return normalizeTabFlowFamilies(
        appendConnectionToLine(linesWithoutConnection, sourceLine.id, connection.id),
      );
    }

    const sourceRoot = getTabFlowFamilyRoot(linesWithoutConnection, sourceLine.id);

    if (sourceRoot) {
      return normalizeTabFlowFamilies([
        ...bumpRootRevision(linesWithoutConnection, sourceRoot.id),
        createTabFlowChildLine(
          sourceRoot,
          createUniqueChildLineId(linesWithoutConnection, sourceRoot.id),
          [connection.id],
          {
            patchTabId: connection.fromPatchTabId,
            portId: connection.fromPortId,
            kind: 'branch-from',
          },
          getTabFlowFamilyLines(linesWithoutConnection, sourceRoot.id).length - 1,
        ),
      ]);
    }
  }

  if (targetLine) {
    const targetSequence = getLinePatchTabSequence(targetLine, connectionMap);

    if (targetSequence[0] === connection.toPatchTabId) {
      return normalizeTabFlowFamilies(
        prependConnectionToLine(linesWithoutConnection, targetLine.id, connection.id),
      );
    }

    const targetRoot = getTabFlowFamilyRoot(linesWithoutConnection, targetLine.id);

    if (targetRoot) {
      return normalizeTabFlowFamilies([
        ...bumpRootRevision(linesWithoutConnection, targetRoot.id),
        createTabFlowChildLine(
          targetRoot,
          createUniqueChildLineId(linesWithoutConnection, targetRoot.id),
          [connection.id],
          {
            patchTabId: connection.toPatchTabId,
            portId: connection.toPortId,
            kind: 'merge-into',
          },
          getTabFlowFamilyLines(linesWithoutConnection, targetRoot.id).length - 1,
        ),
      ]);
    }
  }

  const selectedLine =
    linesWithoutConnection.find((line) => line.id === selectedLineId) ??
    linesWithoutConnection.find((line) => !line.attachment) ??
    linesWithoutConnection[0];

  if (selectedLine) {
    return normalizeTabFlowFamilies(
      appendConnectionToLine(linesWithoutConnection, selectedLine.id, connection.id),
    );
  }

  return normalizeTabFlowFamilies([
    {
      id: 'tabflow-line-01',
      name: 'TabFlow Line 1',
      order: 0,
      enabled: connection.enabled,
      revision: 1,
      connectionIds: [connection.id],
    },
  ]);
}

export function wouldCreateTabFlowCycle(
  connections: TabFlowConnection[],
  fromPatchTabId: string,
  toPatchTabId: string,
): boolean {
  if (fromPatchTabId === toPatchTabId) {
    return true;
  }

  const targetsBySource = new Map<string, string[]>();

  connections.forEach((connection) => {
    const targets = targetsBySource.get(connection.fromPatchTabId) ?? [];
    targets.push(connection.toPatchTabId);
    targetsBySource.set(connection.fromPatchTabId, targets);
  });

  const pending = [toPatchTabId];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const patchTabId = pending.pop();

    if (!patchTabId || visited.has(patchTabId)) {
      continue;
    }

    if (patchTabId === fromPatchTabId) {
      return true;
    }

    visited.add(patchTabId);
    pending.push(...(targetsBySource.get(patchTabId) ?? []));
  }

  return false;
}

function getLinePatchTabSequence(
  line: TabFlowLine,
  connectionMap: Map<string, TabFlowConnection>,
): string[] {
  const lineConnections = line.connectionIds.flatMap((connectionId) => {
    const connection = connectionMap.get(connectionId);
    return connection ? [connection] : [];
  });

  if (lineConnections.length === 0) {
    return [];
  }

  const sequence = [lineConnections[0].fromPatchTabId];
  lineConnections.forEach((connection) => {
    if (sequence[sequence.length - 1] !== connection.fromPatchTabId) {
      sequence.push(connection.fromPatchTabId);
    }
    sequence.push(connection.toPatchTabId);
  });

  return [...new Set(sequence)];
}

function findPreferredLineContainingPatchTab(
  tabFlowLines: TabFlowLine[],
  connectionMap: Map<string, TabFlowConnection>,
  patchTabId: string,
  preference: 'source' | 'target',
): TabFlowLine | undefined {
  const candidates = tabFlowLines.filter((line) =>
    getLinePatchTabSequence(line, connectionMap).includes(patchTabId),
  );

  return (
    candidates.find((line) => {
      const sequence = getLinePatchTabSequence(line, connectionMap);
      return preference === 'source'
        ? sequence[sequence.length - 1] === patchTabId
        : sequence[0] === patchTabId;
    }) ?? candidates[0]
  );
}

function appendConnectionToLine(
  tabFlowLines: TabFlowLine[],
  lineId: string,
  connectionId: string,
): TabFlowLine[] {
  return tabFlowLines.map((line) =>
    line.id === lineId
      ? {
          ...line,
          connectionIds: [...line.connectionIds, connectionId],
          revision: Math.max(1, line.revision) + 1,
        }
      : line,
  );
}

function prependConnectionToLine(
  tabFlowLines: TabFlowLine[],
  lineId: string,
  connectionId: string,
): TabFlowLine[] {
  return tabFlowLines.map((line) =>
    line.id === lineId
      ? {
          ...line,
          connectionIds: [connectionId, ...line.connectionIds],
          revision: Math.max(1, line.revision) + 1,
        }
      : line,
  );
}

function createUniqueChildLineId(tabFlowLines: TabFlowLine[], rootLineId: string): string {
  const usedLineIds = new Set(tabFlowLines.map((line) => line.id));
  let childNumber = 1;
  let lineId = `${rootLineId}-child-${String(childNumber).padStart(2, '0')}`;

  while (usedLineIds.has(lineId)) {
    childNumber += 1;
    lineId = `${rootLineId}-child-${String(childNumber).padStart(2, '0')}`;
  }

  return lineId;
}

function bumpRootRevision(tabFlowLines: TabFlowLine[], rootLineId: string): TabFlowLine[] {
  return tabFlowLines.map((line) =>
    line.id === rootLineId
      ? { ...line, revision: Math.max(1, line.revision) + 1 }
      : line,
  );
}

function getJunctionIndex(line: TabFlowLine, parentSequence: string[]): number {
  const patchTabId = line.attachment?.patchTabId;
  const junctionIndex = patchTabId ? parentSequence.indexOf(patchTabId) : -1;

  return junctionIndex >= 0 ? junctionIndex : Number.MAX_SAFE_INTEGER;
}

function getLaneStartIndex(line: TabFlowLine, junctionIndex: number): number {
  if (junctionIndex === Number.MAX_SAFE_INTEGER) {
    return 0;
  }

  return line.attachment?.kind === 'merge-into'
    ? Math.max(0, junctionIndex - line.connectionIds.length)
    : Math.max(0, junctionIndex);
}

function getJunctionPortIndex(line: TabFlowLine, patchTabMap: Map<string, PatchTab>): number {
  const attachment = line.attachment;

  if (!attachment?.portId) {
    return Number.MAX_SAFE_INTEGER;
  }

  const patchTab = patchTabMap.get(attachment.patchTabId);
  const definition = getPatchTabDefinition(patchTab);
  const ports = attachment.kind === 'branch-from' ? definition?.outputs : definition?.inputs;
  const portIndex = ports?.findIndex((port) => port.id === attachment.portId) ?? -1;

  return portIndex >= 0 ? portIndex : Number.MAX_SAFE_INTEGER;
}

function wouldCreateLineParentCycle(
  childLineId: string,
  parentLineId: string,
  lineMap: Map<string, TabFlowLine>,
): boolean {
  const visited = new Set<string>([childLineId]);
  let currentLineId: string | undefined = parentLineId;

  while (currentLineId) {
    if (visited.has(currentLineId)) {
      return true;
    }

    visited.add(currentLineId);
    currentLineId = lineMap.get(currentLineId)?.attachment?.parentLineId;
  }

  return false;
}

function compareLineOrder(left: TabFlowLine, right: TabFlowLine): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

function compareChildOrder(left: TabFlowLine, right: TabFlowLine): number {
  return (
    (left.childOrder ?? left.order) - (right.childOrder ?? right.order) ||
    left.id.localeCompare(right.id)
  );
}

function toLaneSuffix(index: number): string {
  let value = index;
  let suffix = '';

  while (value >= 0) {
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26) - 1;
  }

  return suffix;
}
