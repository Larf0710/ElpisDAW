import type { AutoPatchPatchTabSnapshot } from './autoPatchGraphSnapshot';
import { PATCH_DATA_TYPES } from './patchTabPortContract';
import type { PatchInputBindingKind } from './types';

type SnapshotConnection =
  import('./autoPatchGraphSnapshot').AutoPatchGraphSnapshot['families'][number]['connections'][number];
type SnapshotInputPort =
  AutoPatchPatchTabSnapshot['portContract']['inputs'][number];

export type AutoPatchValidatedPortBinding = Readonly<{
  bindingKinds: readonly PatchInputBindingKind[];
  connectionIds: readonly string[];
  portId: string;
  sourceCount: number;
}>;

export type AutoPatchPortBindingValidationResolution =
  | Readonly<{
      ok: true;
      portBindings: readonly AutoPatchValidatedPortBinding[];
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      reason: 'binding-invalid' | 'cardinality-invalid';
    }>;

export function validateAutoPatchPortBindings(
  patchTab: AutoPatchPatchTabSnapshot,
  incomingConnections: readonly SnapshotConnection[],
  target: Readonly<{
    clipId: string;
    mediaType: 'audio' | 'midi';
  }>,
): AutoPatchPortBindingValidationResolution {
  const inputPortMap = new Map(
    patchTab.portContract.inputs.map((port) => [port.id, port]),
  );

  for (const binding of patchTab.inputBindings) {
    const port = inputPortMap.get(binding.portId);

    if (!port) {
      return failure(
        'binding-invalid',
        'binding-port-missing',
        `PatchTab ${patchTab.id} binding references unavailable Port ${binding.portId}.`,
      );
    }

    if (!port.allowedBindings.includes(binding.kind)) {
      return failure(
        'binding-invalid',
        'binding-kind-disallowed',
        `Port ${binding.portId} does not allow ${binding.kind} binding.`,
      );
    }

    if (
      binding.kind === 'connection' &&
      (new Set(binding.connectionIds).size !== binding.connectionIds.length ||
        binding.connectionIds.some((connectionId) => {
          const connection = incomingConnections.find(
            (candidate) => candidate.id === connectionId,
          );
          return connection?.toPortId !== binding.portId;
        }))
    ) {
      return failure(
        'binding-invalid',
        'connection-binding-mismatch',
        `Port ${binding.portId} contains a stale or duplicate Connection binding.`,
      );
    }

    if (
      binding.kind === 'project-context' &&
      !isNonEmptyTrimmedString(binding.selector)
    ) {
      return failure(
        'binding-invalid',
        'project-context-selector-invalid',
        `Port ${binding.portId} Project context selector is invalid.`,
      );
    }

    if (
      binding.kind === 'timeline-selection' &&
      !doesTargetMatchPort(target.mediaType, port)
    ) {
      return failure(
        'binding-invalid',
        'timeline-selection-type-mismatch',
        `Target Clip ${target.clipId} does not match Port ${binding.portId}.`,
      );
    }
  }

  const portBindings: AutoPatchValidatedPortBinding[] = [];

  for (const port of patchTab.portContract.inputs) {
    const portConnections = incomingConnections.filter(
      (connection) => connection.toPortId === port.id,
    );
    const bindings = patchTab.inputBindings.filter(
      (binding) => binding.portId === port.id,
    );
    const connectionBindings = bindings.filter(
      (binding) => binding.kind === 'connection',
    );
    const declaredConnectionIds = connectionBindings.flatMap(
      (binding) => binding.connectionIds,
    );
    const actualConnectionIds = portConnections.map(
      (connection) => connection.id,
    );

    if (
      (connectionBindings.length > 0 ||
        actualConnectionIds.length > 0) &&
      !areStringSetsEqual(declaredConnectionIds, actualConnectionIds)
    ) {
      return failure(
        'binding-invalid',
        'connection-binding-incomplete',
        `Port ${port.id} Connection bindings do not match the active graph.`,
      );
    }

    const nonConnectionBindings = bindings.filter(
      (binding) => binding.kind !== 'connection',
    );
    const sourceCount =
      actualConnectionIds.length + nonConnectionBindings.length;
    const maximum =
      port.cardinality.max === 'many'
        ? Number.MAX_SAFE_INTEGER
        : port.cardinality.max;

    if (sourceCount < port.cardinality.min || sourceCount > maximum) {
      return failure(
        'cardinality-invalid',
        'port-cardinality-invalid',
        `Port ${port.id} requires ${formatCardinality(port)} but resolves ${sourceCount} source${sourceCount === 1 ? '' : 's'}.`,
      );
    }

    const bindingKinds = new Set<PatchInputBindingKind>();

    if (actualConnectionIds.length > 0) {
      bindingKinds.add('connection');
    }
    nonConnectionBindings.forEach((binding) => {
      bindingKinds.add(binding.kind);
    });
    portBindings.push({
      bindingKinds: [...bindingKinds],
      connectionIds: actualConnectionIds,
      portId: port.id,
      sourceCount,
    });
  }

  return freezeDeep({ ok: true, portBindings });
}

function doesTargetMatchPort(
  mediaType: 'audio' | 'midi',
  port: SnapshotInputPort,
): boolean {
  if (port.domain !== 'artifact') {
    return false;
  }

  const expectedType =
    mediaType === 'audio'
      ? PATCH_DATA_TYPES.audio
      : PATCH_DATA_TYPES.midiNotes;

  return port.accepts.some(
    (accepted) =>
      accepted.id === expectedType.id &&
      accepted.major === expectedType.major,
  );
}

function formatCardinality(port: SnapshotInputPort): string {
  const maximum =
    port.cardinality.max === 'many' ? 'many' : String(port.cardinality.max);
  return `${port.cardinality.min}..${maximum} sources`;
}

function areStringSetsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

function failure(
  reason: 'binding-invalid' | 'cardinality-invalid',
  cause: string,
  message: string,
): AutoPatchPortBindingValidationResolution {
  return freezeDeep({ cause, message, ok: false, reason });
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value
  );
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => {
      freezeDeep(child);
    });
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
}
