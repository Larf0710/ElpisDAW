import { RAW_MIXDOWN_PLAN_VERSION } from '../shared/rawMixdownProtocol.js';
import { renderProjectPcmMixdown } from './projectPcmMixdownRenderer.mjs';
import { parseProjectStemPrintPlan } from './projectStemPrintPlanProtocol.mjs';

export function adaptProjectStemPrintPlanToRawMixdown(planValue) {
  const plan = parseProjectStemPrintPlan(planValue);

  return Object.freeze({
    bpm: plan.bpm,
    durationSeconds: plan.durationSeconds,
    effectsContractVersion: plan.effectsContractVersion,
    endTick: plan.endTick,
    format: plan.format,
    masterFaderDb: plan.masterFaderDb,
    meterTapVersion: plan.meterTapVersion,
    mixerDspVersion: plan.mixerDspVersion,
    mixerSnapshot: plan.mixerSnapshot,
    mixerSnapshotVersion: plan.mixerSnapshotVersion,
    purpose: 'mixdown',
    sources: plan.sources,
    startTick: plan.startTick,
    tracks: plan.tracks,
    version: RAW_MIXDOWN_PLAN_VERSION,
  });
}

export function renderProjectPcmStemPrint(
  planValue,
  sourceBytesValue,
  options = {},
) {
  return renderProjectPcmMixdown(
    adaptProjectStemPrintPlanToRawMixdown(planValue),
    sourceBytesValue,
    options,
  );
}
