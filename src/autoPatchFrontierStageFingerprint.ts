import type { AutoPatchPatchTabSnapshot } from './autoPatchGraphSnapshot';
import type { AutoPatchValidatedStage } from './autoPatchStagePreflight';
import {
  createTabFlowStageFingerprint,
  type TabFlowChangedStageReason,
  type TabFlowStageArtifactInput,
} from './tabFlowChangedStage';
import {
  lookupReusableTabFlowStageResult,
  type TabFlowStageResultAvailability,
} from './tabFlowReusableResult';
import type {
  CompletedTabFlowStageResultRecord,
  ProjectJsonValue,
  TabFlowStageResultScope,
} from './types';

export type AutoPatchStageFingerprintResolution =
  | Readonly<{
      fingerprint: string;
      ok: true;
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
    }>;

export function createAutoPatchStageFingerprintSnapshot(
  patchTab: AutoPatchPatchTabSnapshot,
  validatedStage: AutoPatchValidatedStage,
  artifactInputs: readonly TabFlowStageArtifactInput[],
  projectContext: Readonly<Record<string, ProjectJsonValue>>,
): AutoPatchStageFingerprintResolution {
  const parameterResolution = normalizeStageParameters(patchTab);

  if (!parameterResolution.ok) {
    return parameterResolution;
  }

  return Object.freeze({
    fingerprint: createTabFlowStageFingerprint({
      artifactInputs,
      node: {
        nodeTypeId: patchTab.nodeTypeId,
        nodeVersion: patchTab.nodeVersion,
        parameters: parameterResolution.parameters,
        patchTabId: patchTab.id,
      },
      projectContext,
      ...(validatedStage.execution.kind === 'provider'
        ? {
            provider: {
              modelId: validatedStage.execution.modelId,
              modelRevision: validatedStage.execution.modelRevision,
              providerId: validatedStage.execution.providerId,
              providerRevision:
                validatedStage.execution.providerRevision,
              taskId: validatedStage.execution.taskId,
            },
          }
        : {}),
      resourceInputs: validatedStage.resourceInputs,
    }),
    ok: true,
  });
}

export function getAutoPatchChangedStageReason(
  scope: TabFlowStageResultScope,
  fingerprint: string,
  stageResults: readonly CompletedTabFlowStageResultRecord[],
  availability: TabFlowStageResultAvailability,
): Exclude<TabFlowChangedStageReason, 'upstream-changed'> {
  const matchingScopeResults = stageResults.filter((result) =>
    areScopesEqual(result.scope, scope),
  );
  const hasExactResult = matchingScopeResults.some(
    (result) => result.fingerprint === fingerprint,
  );

  if (hasExactResult) {
    return 'missing-result';
  }

  const hasAvailableStaleResult = matchingScopeResults.some((result) =>
    Boolean(
      lookupReusableTabFlowStageResult(
        { fingerprint: result.fingerprint, scope },
        stageResults,
        availability,
      ).matchedResult,
    ),
  );

  return hasAvailableStaleResult
    ? 'fingerprint-changed'
    : 'missing-result';
}

function normalizeStageParameters(
  patchTab: AutoPatchPatchTabSnapshot,
):
  | Readonly<{
      ok: true;
      parameters: Readonly<Record<string, string | number>>;
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
    }> {
  const parameters: Record<string, string | number> = {};

  for (const parameter of patchTab.parameters) {
    if (
      typeof parameter.id !== 'string' ||
      parameter.id.length === 0 ||
      parameter.id.trim() !== parameter.id ||
      Object.prototype.hasOwnProperty.call(parameters, parameter.id) ||
      (typeof parameter.value === 'number' &&
        !Number.isFinite(parameter.value)) ||
      (typeof parameter.value === 'string' &&
        (parameter.value.length === 0 ||
          parameter.value.trim() !== parameter.value))
    ) {
      return Object.freeze({
        cause: 'stage-parameter-invalid',
        message: `Stage ${patchTab.id} contains an invalid or duplicate parameter.`,
        ok: false,
      });
    }

    parameters[parameter.id] = parameter.value;
  }

  return Object.freeze({
    ok: true,
    parameters: Object.freeze(parameters),
  });
}

function areScopesEqual(
  left: TabFlowStageResultScope,
  right: TabFlowStageResultScope,
): boolean {
  return (
    left.familyId === right.familyId &&
    left.familyRevision === right.familyRevision &&
    left.stageId === right.stageId &&
    left.targetClipId === right.targetClipId
  );
}
