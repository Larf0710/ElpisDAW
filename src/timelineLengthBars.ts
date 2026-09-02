import { ticksToBeats } from './workflow';
import type { PatchTabParameter } from './types';

type NumberParameter = Extract<PatchTabParameter, { kind: 'number' }>;

export function resolveTimelineLengthBarsValue(
  totalTicks: number,
  parameter: Pick<NumberParameter, 'max' | 'min' | 'step'>,
): number {
  const bars = ticksToBeats(totalTicks) / 4;
  const clampedValue = Math.min(parameter.max, Math.max(parameter.min, bars));

  if (!Number.isFinite(parameter.step) || parameter.step <= 0) {
    return clampedValue;
  }

  const snappedValue =
    parameter.min +
    Math.round((clampedValue - parameter.min) / parameter.step) * parameter.step;
  const normalizedValue =
    Number.isInteger(parameter.min) && Number.isInteger(parameter.step)
      ? Math.round(snappedValue)
      : Number(snappedValue.toPrecision(15));

  return Math.min(parameter.max, Math.max(parameter.min, normalizedValue));
}
