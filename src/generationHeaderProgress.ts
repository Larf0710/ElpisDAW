import type { LocalEngineGpuJobProgress } from './localEngineJobs';
import {
  formatGenerationElapsedTime,
  type GenerationActivityLiveness,
} from './generationActivityClock';

export type GenerationHeaderProgress = Readonly<{
  accessiblePhaseLabel: string;
  isStale: boolean;
  message: string;
  percent: number;
  phaseLabel: string;
}>;

export type GenerationJobProgressInput = Readonly<{
  itemCount?: number;
  itemNumber?: number;
  jobProgress?: LocalEngineGpuJobProgress;
  liveness?: GenerationActivityLiveness;
  message?: string;
  operationLabel: string;
  status: string;
}>;

export type ProductionProgressInput = Readonly<{
  completedStageCount: number;
  message: string;
  jobProgress?: LocalEngineGpuJobProgress;
  liveness?: GenerationActivityLiveness;
  stageCount: number;
  status: string;
}>;

const GENERATION_PHASES: Readonly<Record<string, Readonly<{
  percent: number;
  phaseLabel: string;
}>>> = Object.freeze({
  SAVING_LYRICS: Object.freeze({ percent: 8, phaseLabel: 'PREPARING INPUT' }),
  ENQUEUEING: Object.freeze({ percent: 12, phaseLabel: 'PREPARING JOB' }),
  QUEUED: Object.freeze({ percent: 20, phaseLabel: 'QUEUED' }),
  LOADING_MODEL: Object.freeze({ percent: 40, phaseLabel: 'LOADING MODEL' }),
  PROCESSING: Object.freeze({ percent: 68, phaseLabel: 'GENERATING' }),
  SAVING: Object.freeze({ percent: 90, phaseLabel: 'SAVING OUTPUT' }),
  CANCEL_REQUESTED: Object.freeze({ percent: 90, phaseLabel: 'CANCELING' }),
});

export function createGenerationHeaderProgress(
  input: GenerationJobProgressInput,
): GenerationHeaderProgress | undefined {
  const phase = resolveGenerationPhase(input.status, input.jobProgress);

  if (!phase) {
    return undefined;
  }

  const hasBatchProgress =
    Number.isSafeInteger(input.itemCount) &&
    Number.isSafeInteger(input.itemNumber) &&
    (input.itemCount as number) > 1 &&
    (input.itemNumber as number) >= 1 &&
    (input.itemNumber as number) <= (input.itemCount as number);
  const percent = hasBatchProgress
    ? Math.round(
        (((input.itemNumber as number) - 1 + phase.percent / 100) /
          (input.itemCount as number)) *
          100,
      )
    : phase.percent;

  return Object.freeze({
    accessiblePhaseLabel: input.liveness?.isStale
      ? 'Still working. The generation operation remains active.'
      : phase.phaseLabel,
    isStale: Boolean(input.liveness?.isStale),
    message: `${input.operationLabel} · ${input.message ?? phase.phaseLabel}`,
    percent,
    phaseLabel: formatPhaseLabel(phase.phaseLabel, input.liveness),
  });
}

function resolveGenerationPhase(
  status: string,
  progress: LocalEngineGpuJobProgress | undefined,
): Readonly<{ percent: number; phaseLabel: string }> | undefined {
  if (status !== 'PROCESSING' || !progress) {
    return GENERATION_PHASES[status];
  }

  return Object.freeze({
    percent: Math.round(40 + progress.percent * 0.5),
    phaseLabel:
      progress.accuracy === 'MEASURED'
        ? `STEP ${progress.currentStep}/${progress.totalSteps} · ${progress.percent}%`
        : `GENERATING · ${progress.percent}% EST.`,
  });
}

export function createProductionHeaderProgress(
  input: ProductionProgressInput,
): GenerationHeaderProgress | undefined {
  if (input.status === 'PREPARING') {
    return Object.freeze({
      accessiblePhaseLabel: input.liveness?.isStale
        ? 'Still working. The generation operation remains active.'
        : 'PREFLIGHT',
      isStale: Boolean(input.liveness?.isStale),
      message: `AI PRODUCTION · ${input.message}`,
      percent: 10,
      phaseLabel: formatPhaseLabel('PREFLIGHT', input.liveness),
    });
  }

  if (input.status !== 'RUNNING' && input.status !== 'CANCEL_REQUESTED') {
    return undefined;
  }

  const stageCount = Math.max(1, input.stageCount);
  const completedStageCount = Math.min(
    stageCount,
    Math.max(0, input.completedStageCount),
  );
  const currentStageProgress = input.jobProgress
    ? input.jobProgress.percent / 100
    : 0.5;
  const stageProgress = (
    completedStageCount +
    (completedStageCount < stageCount ? currentStageProgress : 0)
  ) / stageCount;

  const phaseLabel = input.status === 'CANCEL_REQUESTED'
    ? 'CANCELING'
    : input.jobProgress?.accuracy === 'MEASURED'
      ? `STEP ${input.jobProgress.currentStep}/${input.jobProgress.totalSteps} · ${input.jobProgress.percent}%`
      : input.jobProgress
        ? `STAGE ${Math.min(stageCount, completedStageCount + 1)}/${stageCount} · ${input.jobProgress.percent}% EST.`
        : `STAGE ${Math.min(stageCount, completedStageCount + 1)}/${stageCount}`;

  return Object.freeze({
    accessiblePhaseLabel: input.liveness?.isStale
      ? 'Still working. The generation operation remains active.'
      : phaseLabel,
    isStale: Boolean(input.liveness?.isStale),
    message: `AI PRODUCTION · ${input.message}`,
    percent: input.status === 'CANCEL_REQUESTED'
      ? Math.min(92, Math.max(18, Math.round(15 + stageProgress * 75)))
      : Math.min(90, Math.max(15, Math.round(15 + stageProgress * 75))),
    phaseLabel: formatPhaseLabel(phaseLabel, input.liveness),
  });
}

function formatPhaseLabel(
  phaseLabel: string,
  liveness: GenerationActivityLiveness | undefined,
): string {
  if (!liveness) {
    return phaseLabel;
  }

  if (liveness.isStale) {
    return `STILL WORKING · LAST UPDATE ${formatGenerationElapsedTime(liveness.lastUpdateAgeSeconds)}`;
  }

  return `${phaseLabel} · ELAPSED ${formatGenerationElapsedTime(liveness.elapsedSeconds)}`;
}
