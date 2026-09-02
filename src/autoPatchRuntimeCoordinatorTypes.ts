import type {
  AutoPatchExecutionFrontier,
  AutoPatchExecutionFrontierRequest,
  AutoPatchExecutionFrontierStage,
  AutoPatchRuntimeTargetSnapshot,
} from './autoPatchExecutionFrontier';
import type {
  AutoPatchStageExecutionProfile,
  AutoPatchValidatedPreflight,
} from './autoPatchStagePreflight';
import type {
  TabFlowStageArtifactInput,
  TabFlowStageResourceInput,
} from './tabFlowChangedStage';
import type {
  CompletedTabFlowStageResultRecord,
  PatchTabParameter,
  TabFlowStageResultScope,
} from './types';

export type AutoPatchExecuteFrontierStage = Extract<
  AutoPatchExecutionFrontierStage,
  { action: 'execute' }
>;

export type AutoPatchRuntimeAttemptRecord =
  | Readonly<{
      attemptId: string;
      fingerprint: string;
      scope: TabFlowStageResultScope;
      startedAt: string;
      state: 'RUNNING';
    }>
  | Readonly<{
      attemptId: string;
      fingerprint: string;
      finishedAt: string;
      resultId: string;
      scope: TabFlowStageResultScope;
      startedAt: string;
      state: 'COMPLETED';
    }>
  | Readonly<{
      attemptId: string;
      cause: string;
      failedAt: string;
      fingerprint: string;
      message: string;
      scope: TabFlowStageResultScope;
      startedAt: string;
      state: 'FAILED';
    }>;

export type AutoPatchRuntimeFailure = Readonly<{
  attemptId: string;
  cause: string;
  failedAt: string;
  message: string;
  scope: TabFlowStageResultScope;
}>;

export type AutoPatchRuntimeCoordinatorBase = Readonly<{
  attempts: readonly AutoPatchRuntimeAttemptRecord[];
  createdAt: string;
  frontier: AutoPatchExecutionFrontier;
  runId: string;
  runtimeTargets: readonly AutoPatchRuntimeTargetSnapshot[];
  stageResults: readonly CompletedTabFlowStageResultRecord[];
  updatedAt: string;
  validatedPreflight: AutoPatchValidatedPreflight;
}>;

export type AutoPatchRuntimeCoordinator =
  | (AutoPatchRuntimeCoordinatorBase &
      Readonly<{
        activeAttempt: null;
        activeStage: AutoPatchExecuteFrontierStage;
        failure: null;
        status: 'READY';
      }>)
  | (AutoPatchRuntimeCoordinatorBase &
      Readonly<{
        activeAttempt: Extract<
          AutoPatchRuntimeAttemptRecord,
          { state: 'RUNNING' }
        >;
        activeStage: AutoPatchExecuteFrontierStage;
        failure: null;
        status: 'RUNNING';
      }>)
  | (AutoPatchRuntimeCoordinatorBase &
      Readonly<{
        activeAttempt: null;
        activeStage: null;
        failure: null;
        status: 'COMPLETED';
      }>)
  | (AutoPatchRuntimeCoordinatorBase &
      Readonly<{
        activeAttempt: null;
        activeStage: null;
        failure: AutoPatchRuntimeFailure;
        status: 'FAILED';
      }>);

export type AutoPatchReadyRuntimeCoordinator = Extract<
  AutoPatchRuntimeCoordinator,
  { status: 'READY' }
>;

export type AutoPatchRuntimeStageDispatch = Readonly<{
  artifactInputs: readonly TabFlowStageArtifactInput[];
  attemptId: string;
  execution: AutoPatchStageExecutionProfile;
  fingerprint: string;
  node: Readonly<{
    nodeTypeId: string;
    nodeVersion: string;
    parameters: readonly DeepReadonly<PatchTabParameter>[];
    patchTabId: string;
  }>;
  resourceInputs: readonly TabFlowStageResourceInput[];
  runId: string;
  scope: TabFlowStageResultScope;
  startedAt: string;
}>;

export type AutoPatchRuntimeCoordinatorResolution =
  | Readonly<{
      coordinator: AutoPatchRuntimeCoordinator;
      dispatch?: AutoPatchRuntimeStageDispatch;
      ok: true;
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      reason:
        | 'invalid-request'
        | 'invalid-transition'
        | 'frontier-rejected'
        | 'result-invalid';
    }>;

export type CreateAutoPatchRuntimeCoordinatorRequest =
  AutoPatchExecutionFrontierRequest &
    Readonly<{
      createdAt: string;
      runId: string;
    }>;

export type BeginAutoPatchRuntimeStageRequest = Readonly<{
  attemptId: string;
  startedAt: string;
}>;

export type CompleteAutoPatchRuntimeStageRequest = Readonly<{
  attemptId: string;
  result: CompletedTabFlowStageResultRecord;
  runtimeTarget: AutoPatchRuntimeTargetSnapshot;
}>;

export type FailAutoPatchRuntimeStageRequest = Readonly<{
  attemptId: string;
  cause: string;
  failedAt: string;
  message: string;
}>;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;
