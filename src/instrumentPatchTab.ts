import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import type { PatchTab, PatchTabParameter } from './types';

export const INSTRUMENT_BANK_PARAMETER_ID = 'bank';
export const INSTRUMENT_PROGRAM_PARAMETER_ID = 'program';

export type InstrumentSoundFontSource =
  | 'builtin-default'
  | 'connection'
  | 'clip';

const retiredInstrumentParameterIds = new Set([
  'patch',
  'brightness',
  'drive',
]);

export function createInstrumentPresetParameters(): PatchTabParameter[] {
  return [
    {
      id: INSTRUMENT_BANK_PARAMETER_ID,
      kind: 'number',
      label: 'Bank',
      max: 16_383,
      min: 0,
      step: 1,
      value: 0,
    },
    {
      id: INSTRUMENT_PROGRAM_PARAMETER_ID,
      kind: 'number',
      label: 'Program',
      max: 127,
      min: 0,
      step: 1,
      value: 0,
    },
  ];
}

export function normalizeInstrumentPresetParameters(
  parameters: readonly PatchTabParameter[],
): PatchTabParameter[] {
  const normalized = parameters
    .filter((parameter) => !retiredInstrumentParameterIds.has(parameter.id))
    .map(cloneParameter);

  for (const requiredParameter of createInstrumentPresetParameters()) {
    if (!normalized.some((parameter) => parameter.id === requiredParameter.id)) {
      normalized.push(requiredParameter);
    }
  }

  return normalized;
}

export function resolveInstrumentPatchTabPreset(
  patchTab: Pick<PatchTab, 'nodeTypeId' | 'parameters'> | undefined,
): Readonly<{ bank: number; program: number }> | undefined {
  if (patchTab?.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.instrument) {
    return undefined;
  }

  const bankParameter = patchTab.parameters.find(
    (parameter) => parameter.id === INSTRUMENT_BANK_PARAMETER_ID,
  );
  const programParameter = patchTab.parameters.find(
    (parameter) => parameter.id === INSTRUMENT_PROGRAM_PARAMETER_ID,
  );

  if (!bankParameter && !programParameter) {
    return Object.freeze({ bank: 0, program: 0 });
  }

  const bank = bankParameter?.kind === 'number' ? bankParameter.value : undefined;
  const program =
    programParameter?.kind === 'number' ? programParameter.value : undefined;

  if (
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

  return Object.freeze({ bank, program });
}

export function isInstrumentPresetControlLocked(
  source: InstrumentSoundFontSource | undefined,
): boolean {
  return source === 'connection' || source === 'clip';
}

function cloneParameter(parameter: PatchTabParameter): PatchTabParameter {
  return parameter.kind === 'select'
    ? { ...parameter, options: [...parameter.options] }
    : { ...parameter };
}
