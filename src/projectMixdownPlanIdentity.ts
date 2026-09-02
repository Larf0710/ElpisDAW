import { createCanonicalProjectRenderPlanJson as createSharedCanonicalProjectRenderPlanJson } from '../shared/projectRenderPlanIdentity.js';
import type { ProjectStemPrintPlan } from './projectStemPrintPlan';

export function createCanonicalProjectMixdownPlanJson(
  value: unknown,
): string | undefined {
  return createCanonicalProjectRenderPlanJson(value);
}

export function createCanonicalProjectStemPrintPlanJson(
  value: ProjectStemPrintPlan,
): string | undefined {
  return createCanonicalProjectRenderPlanJson(value);
}

export function createCanonicalProjectRenderPlanJson(
  value: unknown,
): string | undefined {
  return createSharedCanonicalProjectRenderPlanJson(value);
}
