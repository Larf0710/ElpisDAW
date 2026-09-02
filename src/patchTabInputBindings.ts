import {
  getDefaultInputPort,
  getPatchTabDefinition,
} from './patchTabPortContract';
import type {
  PatchTab,
  PatchTabInputBinding,
  TabFlowConnection,
} from './types';

export function synchronizePatchTabConnectionBindings(
  patchTabs: readonly PatchTab[],
  connections: readonly TabFlowConnection[],
): PatchTab[] {
  const patchTabMap = new Map(
    patchTabs.map((patchTab) => [patchTab.id, patchTab]),
  );
  const incomingConnectionIds = new Map<string, Map<string, string[]>>();

  [...connections]
    .sort(compareConnections)
    .forEach((connection) => {
      if (connection.activation === 'draft') {
        return;
      }

      const targetPatchTab = patchTabMap.get(connection.toPatchTabId);
      const targetPortId =
        connection.toPortId ?? getDefaultInputPort(targetPatchTab)?.id;
      const targetDefinition = getPatchTabDefinition(targetPatchTab);

      if (
        !targetPatchTab ||
        !targetPortId ||
        !targetDefinition?.inputs.some((port) => port.id === targetPortId)
      ) {
        return;
      }

      const portMap =
        incomingConnectionIds.get(targetPatchTab.id) ??
        new Map<string, string[]>();
      const connectionIds = portMap.get(targetPortId) ?? [];

      if (!connectionIds.includes(connection.id)) {
        connectionIds.push(connection.id);
      }

      portMap.set(targetPortId, connectionIds);
      incomingConnectionIds.set(targetPatchTab.id, portMap);
    });

  return patchTabs.map((patchTab) => {
    const definition = getPatchTabDefinition(patchTab);

    if (!definition) {
      return patchTab;
    }

    const incomingByPort = incomingConnectionIds.get(patchTab.id);
    const nextBindings = (patchTab.inputBindings ?? []).filter(
      (binding) =>
        binding.kind !== 'connection' && !incomingByPort?.has(binding.portId),
    );

    definition.inputs.forEach((port) => {
      const connectionIds = incomingByPort?.get(port.id);

      if (!connectionIds || connectionIds.length === 0) {
        return;
      }

      nextBindings.push({
        portId: port.id,
        kind: 'connection',
        connectionIds: [...connectionIds],
      });
    });

    if (areBindingsEqual(patchTab.inputBindings, nextBindings)) {
      return patchTab;
    }

    return {
      ...patchTab,
      inputBindings: nextBindings,
    };
  });
}

function compareConnections(
  left: TabFlowConnection,
  right: TabFlowConnection,
): number {
  return (
    (left.createdOrder ?? left.order) - (right.createdOrder ?? right.order) ||
    left.id.localeCompare(right.id)
  );
}

function areBindingsEqual(
  current: readonly PatchTabInputBinding[] | undefined,
  next: readonly PatchTabInputBinding[],
): boolean {
  if ((!current || current.length === 0) && next.length === 0) {
    return true;
  }

  if (!current || current.length !== next.length) {
    return false;
  }

  return current.every((binding, index) => {
    const candidate = next[index];

    if (
      binding.portId !== candidate?.portId ||
      binding.kind !== candidate.kind
    ) {
      return false;
    }

    return binding.kind !== 'connection' || candidate.kind !== 'connection'
      ? JSON.stringify(binding) === JSON.stringify(candidate)
      : binding.connectionIds.length === candidate.connectionIds.length &&
          binding.connectionIds.every(
            (connectionId, connectionIndex) =>
              connectionId === candidate.connectionIds[connectionIndex],
          );
  });
}
