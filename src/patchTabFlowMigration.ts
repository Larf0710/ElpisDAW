import {
  migratePatchTabContract,
  migrateTabFlowConnectionPorts,
} from './patchTabPortContract';
import { normalizeTabFlowFamilies } from './tabFlowFamilies';
import type { PatchTab, PatchTabParameter, TabFlowConnection, TabFlowLine } from './types';

export type PatchTabFlowMigrationResult = {
  patchTabs: PatchTab[];
  connections: TabFlowConnection[];
};

export type PatchTabRoutingContractMigrationResult = PatchTabFlowMigrationResult & {
  tabFlowLines: TabFlowLine[];
};

export function migratePatchTabRoutingContracts(
  patchTabs: PatchTab[],
  connections: TabFlowConnection[],
  tabFlowLines: TabFlowLine[],
): PatchTabRoutingContractMigrationResult {
  const migratedPatchTabs = patchTabs.map(migratePatchTabContract);
  const migratedConnections = connections.map((connection) =>
    migrateTabFlowConnectionPorts(connection, migratedPatchTabs),
  );

  return {
    patchTabs: migratedPatchTabs,
    connections: migratedConnections,
    tabFlowLines: normalizeTabFlowFamilies(tabFlowLines),
  };
}

export function migrateLegacyTimelinePatchTabs(
  patchTabs: PatchTab[],
  connections: TabFlowConnection[],
): PatchTabFlowMigrationResult {
  const patchTabMap = new Map(patchTabs.map((patchTab) => [patchTab.id, patchTab]));
  const legacyTimelinePatchTabs = patchTabs.filter(isLegacyTimelineMockPatchTab);

  if (legacyTimelinePatchTabs.length === 0) {
    return {
      patchTabs: patchTabs.map(migrateLegacyClipFiler),
      connections,
    };
  }

  const legacyTimelineIds = new Set(legacyTimelinePatchTabs.map((patchTab) => patchTab.id));
  const migratedSwingByMidiEditId = collectMigratedSwingValues(
    legacyTimelinePatchTabs,
    patchTabMap,
    connections,
  );
  const migratedPatchTabs = patchTabs
    .filter((patchTab) => !legacyTimelineIds.has(patchTab.id))
    .map((patchTab) =>
      migrateMidiEditSwing(
        migrateLegacyClipFiler(patchTab),
        migratedSwingByMidiEditId.get(patchTab.id),
      ),
    );
  const migratedConnections = bridgeLegacyTimelineConnections(
    connections,
    legacyTimelineIds,
    patchTabMap,
  );

  return {
    patchTabs: migratedPatchTabs,
    connections: migratedConnections,
  };
}

export function isLegacyTimelineMockPatchTab(patchTab: PatchTab): boolean {
  return (
    patchTab.outputType === 'Arrangement' &&
    patchTab.parameters.some((parameter) => parameter.id === 'snap') &&
    patchTab.parameters.some((parameter) => parameter.id === 'swing')
  );
}

function migrateLegacyClipFiler(patchTab: PatchTab): PatchTab {
  const isLegacyExportFlow =
    patchTab.inputType === 'Arrangement' && patchTab.outputType === 'Mixdown';
  const isClipFilerFlow =
    patchTab.inputType === 'Selected Clip' && patchTab.outputType === 'Export File';

  if (!isLegacyExportFlow && !isClipFilerFlow) {
    return patchTab;
  }

  const normalizedName = patchTab.name.trim().toLowerCase();
  const name =
    normalizedName === 'export' || normalizedName === 'export profile'
      ? 'Clip Filer'
      : patchTab.name;

  if (!isLegacyExportFlow) {
    return name === patchTab.name ? patchTab : { ...patchTab, name };
  }

  return {
    ...patchTab,
    name,
    inputType: 'Selected Clip',
    outputType: 'Export File',
    description: 'Prints the audible Project through the Mixer to a finalized Raw Mix WAV, then saves a selected registered Raw Mix.',
  };
}

function collectMigratedSwingValues(
  legacyTimelinePatchTabs: PatchTab[],
  patchTabMap: ReadonlyMap<string, PatchTab>,
  connections: TabFlowConnection[],
): Map<string, number> {
  const swingByMidiEditId = new Map<string, number>();

  legacyTimelinePatchTabs.forEach((timelinePatchTab) => {
    const swingParameter = timelinePatchTab.parameters.find(
      (parameter): parameter is Extract<PatchTabParameter, { kind: 'slider' }> =>
        parameter.id === 'swing' && parameter.kind === 'slider',
    );
    const upstreamMidiEdit = findUpstreamMidiEditPatchTab(
      timelinePatchTab.id,
      patchTabMap,
      connections,
    );

    if (swingParameter && upstreamMidiEdit && !swingByMidiEditId.has(upstreamMidiEdit.id)) {
      swingByMidiEditId.set(upstreamMidiEdit.id, swingParameter.value);
    }
  });

  return swingByMidiEditId;
}

function findUpstreamMidiEditPatchTab(
  startPatchTabId: string,
  patchTabMap: ReadonlyMap<string, PatchTab>,
  connections: TabFlowConnection[],
): PatchTab | undefined {
  const incomingByTarget = new Map<string, TabFlowConnection[]>();

  connections.forEach((connection) => {
    const incoming = incomingByTarget.get(connection.toPatchTabId) ?? [];
    incoming.push(connection);
    incomingByTarget.set(connection.toPatchTabId, incoming);
  });

  const pendingPatchTabIds = [startPatchTabId];
  const visitedPatchTabIds = new Set<string>();

  while (pendingPatchTabIds.length > 0) {
    const patchTabId = pendingPatchTabIds.shift();

    if (!patchTabId || visitedPatchTabIds.has(patchTabId)) {
      continue;
    }

    visitedPatchTabIds.add(patchTabId);

    for (const connection of incomingByTarget.get(patchTabId) ?? []) {
      const upstreamPatchTab = patchTabMap.get(connection.fromPatchTabId);

      if (!upstreamPatchTab) {
        continue;
      }

      if (upstreamPatchTab.inputType === 'MIDI Notes' && upstreamPatchTab.outputType === 'Edited MIDI') {
        return upstreamPatchTab;
      }

      pendingPatchTabIds.push(upstreamPatchTab.id);
    }
  }

  return undefined;
}

function migrateMidiEditSwing(patchTab: PatchTab, migratedSwingValue: number | undefined): PatchTab {
  if (
    migratedSwingValue === undefined ||
    patchTab.inputType !== 'MIDI Notes' ||
    patchTab.outputType !== 'Edited MIDI' ||
    patchTab.parameters.some((parameter) => parameter.id === 'swing')
  ) {
    return patchTab;
  }

  const swingParameter: PatchTabParameter = {
    id: 'swing',
    label: 'Swing',
    kind: 'slider',
    min: 0,
    max: 75,
    step: 1,
    value: migratedSwingValue,
    unit: '%',
  };
  const quantizeIndex = patchTab.parameters.findIndex((parameter) => parameter.id === 'quantize');
  const parameters = [...patchTab.parameters];

  parameters.splice(quantizeIndex >= 0 ? quantizeIndex + 1 : parameters.length, 0, swingParameter);

  return {
    ...patchTab,
    parameters,
  };
}

function bridgeLegacyTimelineConnections(
  connections: TabFlowConnection[],
  legacyTimelineIds: ReadonlySet<string>,
  patchTabMap: ReadonlyMap<string, PatchTab>,
): TabFlowConnection[] {
  const retainedConnections = connections.filter(
    (connection) =>
      !legacyTimelineIds.has(connection.fromPatchTabId) &&
      !legacyTimelineIds.has(connection.toPatchTabId),
  );
  const usedConnectionIds = new Set(retainedConnections.map((connection) => connection.id));
  const bridges: TabFlowConnection[] = [];

  legacyTimelineIds.forEach((timelinePatchTabId) => {
    const incomingConnections = connections.filter(
      (connection) => connection.toPatchTabId === timelinePatchTabId,
    );
    const outgoingConnections = connections.filter(
      (connection) => connection.fromPatchTabId === timelinePatchTabId,
    );

    incomingConnections.forEach((incomingConnection, incomingIndex) => {
      const sourcePatchTab = patchTabMap.get(incomingConnection.fromPatchTabId);

      if (!sourcePatchTab) {
        return;
      }

      outgoingConnections.forEach((outgoingConnection, outgoingIndex) => {
        const preferredId =
          incomingIndex === 0 && outgoingIndex === 0
            ? outgoingConnection.id
            : `${outgoingConnection.id}-timeline-bridge-${incomingIndex + 1}-${outgoingIndex + 1}`;
        const connectionId = createUniqueConnectionId(preferredId, usedConnectionIds);

        usedConnectionIds.add(connectionId);
        bridges.push({
          ...outgoingConnection,
          id: connectionId,
          fromPatchTabId: incomingConnection.fromPatchTabId,
          signalType: sourcePatchTab.outputType,
          order: Math.min(incomingConnection.order, outgoingConnection.order),
          latencyMs: incomingConnection.latencyMs,
          enabled: incomingConnection.enabled && outgoingConnection.enabled,
        });
      });
    });
  });

  return [...retainedConnections, ...bridges];
}

function createUniqueConnectionId(preferredId: string, usedConnectionIds: ReadonlySet<string>): string {
  if (!usedConnectionIds.has(preferredId)) {
    return preferredId;
  }

  let suffix = 2;
  let candidateId = `${preferredId}-${suffix}`;

  while (usedConnectionIds.has(candidateId)) {
    suffix += 1;
    candidateId = `${preferredId}-${suffix}`;
  }

  return candidateId;
}
