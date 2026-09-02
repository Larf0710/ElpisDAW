import { HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH } from './defaultSoundFontPreset';
import type { LocalEngineSoundFontResource } from './localEngineClient';
import { resolveInstrumentPatchTabPreset } from './instrumentPatchTab';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import type {
  PatchTab,
  SoundFontAssignment,
} from './types';

export const SOUNDFONT_RESOURCE_PARAMETER_ID = 'soundfont-resource';
export const SOUNDFONT_BANK_PARAMETER_ID = 'bank';
export const SOUNDFONT_PROGRAM_PARAMETER_ID = 'program';
export const SOUNDFONT_OUTPUT_PORT_ID = 'soundfont-out';
export const INSTRUMENT_SOUNDFONT_INPUT_PORT_ID = 'soundfont-in';

type SoundFontPatchTabLike = Readonly<{
  id: string;
  nodeTypeId?: string;
  parameters: readonly Readonly<{
    id: string;
    kind: string;
    value: string | number;
  }>[];
}>;

type SoundFontConnectionLike = Readonly<{
  activation?: 'on' | 'off' | 'draft';
  enabled: boolean;
  fromPatchTabId: string;
  fromPortId?: string;
  toPatchTabId: string;
  toPortId?: string;
}>;

export type ResolvedInstrumentSoundFont = Readonly<{
  bank: number;
  program: number;
  resource: LocalEngineSoundFontResource;
  source: 'builtin-default' | 'connection' | 'clip';
}>;

export type InstrumentSoundFontResolution =
  | Readonly<{
      canResolve: true;
      selection: ResolvedInstrumentSoundFont;
    }>
  | Readonly<{
      canResolve: false;
      message: string;
      reason:
        | 'soundfont-connection-invalid'
        | 'instrument-preset-invalid'
        | 'soundfont-offline'
        | 'soundfont-unassigned';
    }>;

export function createSoundFontPatchTab(
  id = 'soundfont',
  colorIndex = 2,
): PatchTab {
  return {
    id,
    name: 'SoundFont',
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.soundFont,
    nodeVersion: '1.0.0',
    colorIndex,
    inputType: 'SoundFont Set',
    outputType: 'SoundFont Resource',
    status: 'ready',
    description:
      'Selects one verified custom SoundFont file and voice for connected MIDI TO AUDIO stages.',
    parameters: [
      {
        id: SOUNDFONT_RESOURCE_PARAMETER_ID,
        label: 'SoundFont',
        kind: 'select',
        value: HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH,
        options: [HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH],
      },
      {
        id: SOUNDFONT_BANK_PARAMETER_ID,
        label: 'Bank',
        kind: 'number',
        min: 0,
        max: 16_383,
        step: 1,
        value: 0,
      },
      {
        id: SOUNDFONT_PROGRAM_PARAMETER_ID,
        label: 'Program',
        kind: 'number',
        min: 0,
        max: 127,
        step: 1,
        value: 0,
      },
    ],
  };
}

export function isSoundFontPatchTab(
  patchTab: Pick<PatchTab, 'nodeTypeId'> | undefined,
): boolean {
  return patchTab?.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.soundFont;
}

export function resolveInstrumentSoundFont(
  patchTabs: readonly SoundFontPatchTabLike[],
  connections: readonly SoundFontConnectionLike[],
  instrumentPatchTabId: string,
  clipAssignment: SoundFontAssignment | undefined,
  resources: readonly LocalEngineSoundFontResource[],
): InstrumentSoundFontResolution {
  const instrumentPatchTabs = patchTabs.filter(
    (patchTab) => patchTab.id === instrumentPatchTabId,
  );
  const incomingConnections = connections.filter(
    (connection) =>
      connection.toPatchTabId === instrumentPatchTabId &&
      connection.toPortId === INSTRUMENT_SOUNDFONT_INPUT_PORT_ID &&
      connection.enabled &&
      connection.activation !== 'off' &&
      connection.activation !== 'draft',
  );

  if (clipAssignment) {
    const matches = resources.filter(
      (resource) =>
        resource.resourceId === clipAssignment.resource.resourceId &&
        resource.library === clipAssignment.resource.library &&
        resource.format === clipAssignment.resource.format &&
        resource.relativePath === clipAssignment.resource.relativePath,
    );

    if (matches.length !== 1) {
      return failure(
        'soundfont-offline',
        'The MIDI Clip SoundFont is offline. Refresh the SoundFont catalog.',
      );
    }

    return success(
      matches[0],
      clipAssignment.bank,
      clipAssignment.program,
      'clip',
    );
  }

  if (incomingConnections.length > 0) {
    if (incomingConnections.length !== 1) {
      return failure(
        'soundfont-connection-invalid',
        'MIDI TO AUDIO requires exactly one enabled SoundFont connection.',
      );
    }

    const connection = incomingConnections[0];
    const sourceMatches = patchTabs.filter(
      (patchTab) => patchTab.id === connection.fromPatchTabId,
    );

    if (
      connection.fromPortId !== SOUNDFONT_OUTPUT_PORT_ID ||
      sourceMatches.length !== 1 ||
      !isSoundFontPatchTab(sourceMatches[0])
    ) {
      return failure(
        'soundfont-connection-invalid',
        'The connected SoundFont source is missing or has an invalid port contract.',
      );
    }

    const settings = resolveSoundFontPatchTabSettings(sourceMatches[0]);

    if (!settings) {
      return failure(
        'soundfont-connection-invalid',
        'The connected SoundFont PatchTab has invalid resource, Bank, or Program settings.',
      );
    }

    const matches = resources.filter(
      (resource) => resource.relativePath === settings.relativePath,
    );

    if (matches.length !== 1) {
      return failure(
        'soundfont-offline',
        'The connected SoundFont is offline. Refresh the SoundFont catalog.',
      );
    }

    if (matches[0].library === 'project') {
      return success(matches[0], settings.bank, settings.program, 'connection');
    }
  }

  const builtinDefaults = resources.filter(
    (resource) =>
      resource.library === 'builtin' &&
      resource.relativePath === HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH,
  );

  if (builtinDefaults.length !== 1) {
    return failure(
      'soundfont-unassigned',
      'The built-in SoundFont is unavailable. Connect a custom SoundFont or refresh the catalog.',
    );
  }

  const instrumentPreset =
    instrumentPatchTabs.length === 0
      ? Object.freeze({ bank: 0, program: 0 })
      : instrumentPatchTabs.length === 1
        ? resolveInstrumentPatchTabPreset(instrumentPatchTabs[0] as PatchTab)
        : undefined;

  if (!instrumentPreset) {
    return failure(
      'instrument-preset-invalid',
      'MIDI TO AUDIO has invalid Bank or Program settings.',
    );
  }

  return success(
    builtinDefaults[0],
    instrumentPreset.bank,
    instrumentPreset.program,
    'builtin-default',
  );
}

export function resolveSoundFontPatchTabSettings(
  patchTab: SoundFontPatchTabLike,
): Readonly<{ bank: number; program: number; relativePath: string }> | undefined {
  if (!isSoundFontPatchTab(patchTab)) {
    return undefined;
  }

  const relativePath = patchTab.parameters.find(
    (parameter) =>
      parameter.id === SOUNDFONT_RESOURCE_PARAMETER_ID &&
      parameter.kind === 'select',
  )?.value;
  const bank = patchTab.parameters.find(
    (parameter) =>
      parameter.id === SOUNDFONT_BANK_PARAMETER_ID &&
      parameter.kind === 'number',
  )?.value;
  const program = patchTab.parameters.find(
    (parameter) =>
      parameter.id === SOUNDFONT_PROGRAM_PARAMETER_ID &&
      parameter.kind === 'number',
  )?.value;

  if (
    typeof relativePath !== 'string' ||
    !relativePath.trim() ||
    relativePath.trim() !== relativePath ||
    typeof bank !== 'number' ||
    !Number.isSafeInteger(bank) ||
    bank < 0 ||
    bank > 16_383 ||
    typeof program !== 'number' ||
    !Number.isSafeInteger(program) ||
    program < 0 ||
    program > 127
  ) {
    return undefined;
  }

  return { bank, program, relativePath };
}

function success(
  resource: LocalEngineSoundFontResource,
  bank: number,
  program: number,
  source: ResolvedInstrumentSoundFont['source'],
): InstrumentSoundFontResolution {
  return Object.freeze({
    canResolve: true,
    selection: Object.freeze({ bank, program, resource, source }),
  });
}

function failure(
  reason: Extract<InstrumentSoundFontResolution, { canResolve: false }>['reason'],
  message: string,
): InstrumentSoundFontResolution {
  return Object.freeze({ canResolve: false, message, reason });
}
