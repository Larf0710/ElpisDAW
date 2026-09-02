import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
  getPatchTabDefinition,
} from './patchTabPortContract';
import type { PatchTab } from './types';

export const PRINT_MIX_NODE_VERSION = '1.0.0' as const;
export const PRINT_MIX_NORMALIZE_PARAMETER_ID = 'normalize' as const;
export const PRINT_MIX_NORMALIZE_ON = 'On' as const;
export const PRINT_MIX_NORMALIZE_OFF = 'Off' as const;

export function createPrintMixPatchTab(
  id: string,
  colorIndex: number,
): PatchTab {
  if (!isTrimmedText(id) || !Number.isSafeInteger(colorIndex) || colorIndex < 0) {
    throw new Error('PRINT MIX PatchTab identity is invalid.');
  }

  const definition = getPatchTabDefinition({
    id,
    name: 'PRINT MIX',
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.printMix,
    nodeVersion: PRINT_MIX_NODE_VERSION,
    colorIndex,
    inputType: 'Audio or MIDI Clips',
    outputType: 'Printed Clip',
    status: 'ready',
    description: '',
    parameters: [],
  });

  if (!definition) {
    throw new Error('PRINT MIX PatchTab contract is unavailable.');
  }

  return freezeRecursively({
    id,
    name: 'PRINT MIX',
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.printMix,
    nodeVersion: PRINT_MIX_NODE_VERSION,
    portContractSnapshot: structuredClone(definition),
    inputBindings: [
      {
        portId: 'media-in',
        kind: 'timeline-selection',
        selectionKind: 'clip',
      },
    ],
    colorIndex,
    inputType: 'Audio or MIDI Clips',
    outputType: 'Printed Clip',
    status: 'ready',
    description: 'Combines selected same-media Clips over their bounded Timeline span.',
    parameters: [
      {
        id: PRINT_MIX_NORMALIZE_PARAMETER_ID,
        label: 'Normalize',
        kind: 'select',
        value: PRINT_MIX_NORMALIZE_ON,
        options: [PRINT_MIX_NORMALIZE_ON, PRINT_MIX_NORMALIZE_OFF],
      },
    ],
  });
}

export function isPrintMixPatchTab(patchTab: PatchTab | undefined): boolean {
  if (
    !patchTab ||
    patchTab.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.printMix ||
    patchTab.nodeVersion !== PRINT_MIX_NODE_VERSION
  ) {
    return false;
  }

  const definition = getPatchTabDefinition(patchTab);
  const builtinDefinition = getBuiltinPatchTabDefinitions().find(
    (candidate) =>
      candidate.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.printMix,
  );
  return Boolean(
    definition &&
      builtinDefinition &&
      definition.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.printMix &&
      definition.nodeVersion === PRINT_MIX_NODE_VERSION &&
      areJsonValuesEquivalent(definition, builtinDefinition),
  );
}

export function resolvePrintMixNormalize(
  patchTab: PatchTab,
): boolean | undefined {
  if (!isPrintMixPatchTab(patchTab)) {
    return undefined;
  }

  const parameters = patchTab.parameters.filter(
    (parameter) => parameter.id === PRINT_MIX_NORMALIZE_PARAMETER_ID,
  );

  if (
    parameters.length !== 1 ||
    parameters[0].kind !== 'select' ||
    parameters[0].options.length !== 2 ||
    parameters[0].options[0] !== PRINT_MIX_NORMALIZE_ON ||
    parameters[0].options[1] !== PRINT_MIX_NORMALIZE_OFF
  ) {
    return undefined;
  }

  return parameters[0].value === PRINT_MIX_NORMALIZE_ON
    ? true
    : parameters[0].value === PRINT_MIX_NORMALIZE_OFF
      ? false
      : undefined;
}

function isTrimmedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function areJsonValuesEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        areJsonValuesEquivalent(value, right[index]),
      );
  }
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        areJsonValuesEquivalent(leftRecord[key], rightRecord[key]),
    );
}

function freezeRecursively<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(freezeRecursively);
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeRecursively);
  }
  return typeof value === 'object' && value !== null ? Object.freeze(value) : value;
}
