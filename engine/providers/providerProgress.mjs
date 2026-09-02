export const PROVIDER_PROGRESS_ACCURACIES = Object.freeze([
  'MEASURED',
  'ESTIMATED',
]);

export function parseProviderProgress(value) {
  if (
    !isRecord(value) ||
    !PROVIDER_PROGRESS_ACCURACIES.includes(value.accuracy) ||
    !Number.isSafeInteger(value.percent) ||
    value.percent < 0 ||
    value.percent > 100
  ) {
    return undefined;
  }

  if (value.accuracy === 'ESTIMATED') {
    if (value.currentStep !== undefined || value.totalSteps !== undefined) {
      return undefined;
    }

    return Object.freeze({
      accuracy: 'ESTIMATED',
      percent: value.percent,
    });
  }

  if (
    !Number.isSafeInteger(value.currentStep) ||
    value.currentStep < 1 ||
    !Number.isSafeInteger(value.totalSteps) ||
    value.totalSteps < 1 ||
    value.currentStep > value.totalSteps
  ) {
    return undefined;
  }

  return Object.freeze({
    accuracy: 'MEASURED',
    currentStep: value.currentStep,
    percent: value.percent,
    totalSteps: value.totalSteps,
  });
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
