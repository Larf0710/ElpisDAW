import type { TimelineGridResolution } from './types';
import { isTimelineGridResolution } from './workflow';

type AutoPatchMidiEditProductionParameter =
  | Readonly<{
      id: string;
      kind: 'number' | 'slider' | 'text';
    }>
  | Readonly<{
      id: string;
      kind: 'select';
      options: readonly string[];
      value: string;
    }>;

export type AutoPatchMidiEditProductionCapabilityResolution =
  | Readonly<{
      productionReady: true;
      gridResolution: TimelineGridResolution;
    }>
  | Readonly<{
      productionReady: false;
      cause: string;
      message: string;
      reason: 'parameter-invalid' | 'parameter-unsupported';
    }>;

export function resolveAutoPatchMidiEditProductionCapability(
  parameters: readonly AutoPatchMidiEditProductionParameter[],
): AutoPatchMidiEditProductionCapabilityResolution {
  if (
    parameters.some((parameter) => parameter.id !== 'quantize')
  ) {
    return failure(
      'parameter-unsupported',
      'midi-edit-parameter-unsupported',
      'Basic Quantize does not support additional MIDI Edit parameters.',
    );
  }

  if (parameters.length !== 1) {
    return failure(
      'parameter-invalid',
      'midi-edit-quantize-parameter-invalid',
      'Basic Quantize requires exactly one Quantize parameter.',
    );
  }

  const parameter = parameters[0];

  if (
    parameter.kind !== 'select' ||
    !isTimelineGridResolution(parameter.value) ||
    !parameter.options.includes(parameter.value)
  ) {
    return failure(
      'parameter-invalid',
      'midi-edit-quantize-parameter-invalid',
      'Quantize must select a supported grid value from its declared options.',
    );
  }

  return Object.freeze({
    productionReady: true as const,
    gridResolution: parameter.value,
  });
}

function failure(
  reason: Extract<
    AutoPatchMidiEditProductionCapabilityResolution,
    { productionReady: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchMidiEditProductionCapabilityResolution,
  { productionReady: false }
> {
  return Object.freeze({
    productionReady: false,
    cause,
    message,
    reason,
  });
}
