import type {
  AutoPatchRuntimeCoordinator,
  AutoPatchRuntimeCoordinatorResolution,
  AutoPatchRuntimeStageDispatch,
  BeginAutoPatchRuntimeStageRequest,
} from './autoPatchRuntimeCoordinatorTypes';
import type {
  PatchTabParameter,
  TabFlowStageResultScope,
} from './types';

export type AutoPatchRuntimeStageDispatchResolution =
  | Readonly<{
      dispatch: AutoPatchRuntimeStageDispatch;
      ok: true;
    }>
  | Extract<
      AutoPatchRuntimeCoordinatorResolution,
      { ok: false }
    >;

export function createAutoPatchRuntimeStageDispatch(
  coordinator: Extract<
    AutoPatchRuntimeCoordinator,
    { status: 'READY' }
  >,
  request: BeginAutoPatchRuntimeStageRequest,
): AutoPatchRuntimeStageDispatchResolution {
  const scope = coordinator.activeStage.scope;
  const validatedStage = coordinator.validatedPreflight.stages.find(
    (stage) => areScopesEqual(stage.scope, scope),
  );
  const family =
    coordinator.validatedPreflight.plan.graphSnapshot.families.find(
      (candidate) => candidate.familyId === scope.familyId,
    );
  const patchTab = family?.patchTabs.find(
    (candidate) => candidate.id === scope.stageId,
  );

  if (!validatedStage || !patchTab) {
    return Object.freeze({
      cause: 'stage-dispatch-context-missing',
      message: `Stage ${scope.stageId} is missing its immutable dispatch context.`,
      ok: false,
      reason: 'frontier-rejected',
    });
  }

  return freezeDeep({
    dispatch: {
      artifactInputs: coordinator.activeStage.artifactInputs,
      attemptId: request.attemptId,
      execution: validatedStage.execution,
      fingerprint: coordinator.activeStage.fingerprint,
      node: {
        nodeTypeId: patchTab.nodeTypeId,
        nodeVersion: patchTab.nodeVersion,
        parameters: patchTab.parameters.map(cloneParameter),
        patchTabId: patchTab.id,
      },
      resourceInputs: validatedStage.resourceInputs,
      runId: coordinator.runId,
      scope: { ...scope },
      startedAt: request.startedAt,
    },
    ok: true,
  });
}

function cloneParameter(
  parameter: DeepReadonly<PatchTabParameter>,
): PatchTabParameter {
  return parameter.kind === 'select'
    ? { ...parameter, options: [...parameter.options] }
    : { ...parameter };
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

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => {
      freezeDeep(child);
    });
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
}
