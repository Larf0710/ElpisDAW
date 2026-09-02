import {
  advanceAutoPatchDriverClock,
  createAutoPatchDriverIdentityLedger,
  reserveAutoPatchDriverStageAttempt,
  type AutoPatchDriverIdentityLedger,
  type AutoPatchDriverIdentityServices,
} from './autoPatchDriverIdentity';
import { orchestrateAutoPatchMidiEditStage } from './autoPatchMidiEditStageOrchestrator';
import { orchestrateAutoPatchStableAudio3Stage } from './autoPatchStableAudio3StageOrchestrator';
import {
  validateAutoPatchProductionCapabilityPreflight,
  type AutoPatchProductionCapabilityPreflightResolution,
} from './autoPatchProductionCapabilityPreflight';
import type {
  AutoPatchReadyRuntimeCoordinator,
  AutoPatchRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';
import { orchestrateAutoPatchRuntimeStage } from './autoPatchStageOrchestrator';
import type {
  AutoPatchStageRunnerClient,
  AutoPatchStageRunnerOptions,
} from './autoPatchStageRunner';
import type {
  StableAudio3StageRunnerClient,
  StableAudio3StageRunnerOptions,
} from './stableAudio3StageRunner';
import type {
  LocalEngineClient,
  LocalEngineSoundFontResource,
} from './localEngineClient';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import type { ProjectState, TabFlowStageResultScope } from './types';

export type AutoPatchProductionDriverClient = AutoPatchStageRunnerClient &
  StableAudio3StageRunnerClient &
  Readonly<{ saveProjectFile?: never }>;

export type AutoPatchProductionDriverClientSource =
  AutoPatchStageRunnerClient &
    StableAudio3StageRunnerClient &
    Partial<Pick<LocalEngineClient, 'saveProjectFile'>>;

export function createAutoPatchProductionDriverClient(
  client: AutoPatchProductionDriverClientSource,
): AutoPatchProductionDriverClient {
  return Object.freeze({
    cancelJob: client.cancelJob.bind(client),
    enqueueInstrumentRenderJob:
      client.enqueueInstrumentRenderJob.bind(client),
    enqueueStableAudio3Job:
      client.enqueueStableAudio3Job.bind(client),
    getJobs: client.getJobs.bind(client),
    removeQueuedJob: client.removeQueuedJob.bind(client),
  });
}

export type AutoPatchProductionDriverOptions = Readonly<{
  identity: AutoPatchDriverIdentityServices;
  instrumentLabel?: string;
  instrumentRunner?: Omit<AutoPatchStageRunnerOptions, 'signal'>;
  midiEditLabel?: string;
  onProgress?: (coordinator: AutoPatchReadyRuntimeCoordinator) => void;
  signal?: AbortSignal;
  stableAudio3Label?: string;
  stableAudio3Runner?: Omit<
    StableAudio3StageRunnerOptions,
    'maxPollAttempts' | 'pollUntilTerminal' | 'signal'
  >;
}>;

export type AutoPatchProductionDriverResult =
  | Readonly<{
      coordinator: Extract<
        AutoPatchRuntimeCoordinator,
        { status: 'COMPLETED' }
      >;
      ledger: AutoPatchDriverIdentityLedger;
      ok: true;
      project: ProjectState;
      status: 'COMPLETED';
    }>
  | Readonly<{
      cause: string;
      coordinator: AutoPatchRuntimeCoordinator;
      ledger: AutoPatchDriverIdentityLedger;
      message: string;
      ok: false;
      project: ProjectState;
      reason: 'stage-failed';
      scope: TabFlowStageResultScope;
      status: 'FAILED';
    }>
  | Readonly<{
      cause: string;
      coordinator: AutoPatchRuntimeCoordinator;
      ledger: AutoPatchDriverIdentityLedger;
      message: string;
      ok: false;
      project: ProjectState;
      reason: 'run-canceled';
      scope?: TabFlowStageResultScope;
      status: 'CANCELED';
    }>
  | Readonly<{
      cause: string;
      coordinator: AutoPatchRuntimeCoordinator;
      ledger?: AutoPatchDriverIdentityLedger;
      message: string;
      ok: false;
      project: ProjectState;
      reason:
        | 'driver-invariant'
        | 'driver-preparation-failed'
        | Extract<
            AutoPatchProductionCapabilityPreflightResolution,
            { canStart: false }
          >['reason'];
      scope?: TabFlowStageResultScope;
      status: 'BLOCKED';
    }>;

export async function runAutoPatchProductionDriver(
  client: AutoPatchProductionDriverClient,
  project: ProjectState,
  coordinator: AutoPatchReadyRuntimeCoordinator,
  verifiedSoundFontResources: readonly LocalEngineSoundFontResource[],
  options: AutoPatchProductionDriverOptions,
): Promise<AutoPatchProductionDriverResult> {
  const capability = validateAutoPatchProductionCapabilityPreflight(
    project,
    coordinator,
  );

  if (!capability.canStart) {
    return Object.freeze({
      cause: capability.cause,
      coordinator: capability.coordinator,
      message: capability.message,
      ok: false,
      project: capability.project,
      reason: capability.reason,
      ...(capability.scope ? { scope: capability.scope } : {}),
      status: 'BLOCKED' as const,
    });
  }

  let currentProject = capability.project;
  let currentCoordinator: AutoPatchRuntimeCoordinator =
    capability.coordinator;
  let ledger = createAutoPatchDriverIdentityLedger(
    capability.coordinator,
  );
  const initialCancellation = cancelIfRequested(
    options.signal,
    currentProject,
    currentCoordinator,
    ledger,
    currentCoordinator.activeStage.scope,
  );

  if (initialCancellation) {
    return initialCancellation;
  }

  for (
    let stageIndex = 0;
    stageIndex < capability.stageScopes.length;
    stageIndex += 1
  ) {
    if (currentCoordinator.status !== 'READY') {
      return blockedInvariant(
        currentProject,
        currentCoordinator,
        ledger,
        'production-driver-coordinator-not-ready',
        'Auto Patch production Driver did not receive a READY Coordinator from the previous Stage.',
      );
    }

    const expectedScope = capability.stageScopes[stageIndex];
    const allocationCancellation = cancelIfRequested(
      options.signal,
      currentProject,
      currentCoordinator,
      ledger,
      currentCoordinator.activeStage.scope,
    );

    if (allocationCancellation) {
      return allocationCancellation;
    }

    if (
      !areStageScopesEqual(
        currentCoordinator.activeStage.scope,
        expectedScope,
      )
    ) {
      return blockedInvariant(
        currentProject,
        currentCoordinator,
        ledger,
        'production-driver-stage-order-mismatch',
        'Auto Patch production Driver active Stage does not match the immutable capability order.',
        currentCoordinator.activeStage.scope,
      );
    }

    const progressFailure = notifyProgress(
      options.onProgress,
      currentProject,
      currentCoordinator,
      ledger,
    );

    if (progressFailure) {
      return progressFailure;
    }

    const attemptResolution = reserveAutoPatchDriverStageAttempt(
      ledger,
      currentCoordinator,
      options.identity,
    );

    if (!attemptResolution.ok) {
      return Object.freeze({
        cause: attemptResolution.cause,
        coordinator: currentCoordinator,
        ledger: attemptResolution.ledger,
        message: attemptResolution.message,
        ok: false,
        project: currentProject,
        reason: 'driver-preparation-failed' as const,
        scope: Object.freeze({ ...currentCoordinator.activeStage.scope }),
        status: 'BLOCKED' as const,
      });
    }

    ledger = attemptResolution.ledger;

    const attempt = attemptResolution.attempt;
    const dispatchCancellation = cancelIfRequested(
      options.signal,
      currentProject,
      currentCoordinator,
      ledger,
      attempt.dispatch.scope,
    );

    if (dispatchCancellation) {
      return dispatchCancellation;
    }

    let stageLedger = ledger;
    const now = () => {
      const clockResolution = advanceAutoPatchDriverClock(
        stageLedger,
        attempt.startedAt,
        options.identity.clock,
      );

      if (!clockResolution.ok) {
        throw new Error(
          `${clockResolution.cause}: ${clockResolution.message}`,
        );
      }

      stageLedger = clockResolution.ledger;
      return clockResolution.timestamp;
    };

    if (
      attempt.dispatch.node.nodeTypeId ===
      BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit
    ) {
      if (
        attempt.outputReservation.nodeTypeId !==
        BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit
      ) {
        return blockedInvariant(
          currentProject,
          currentCoordinator,
          ledger,
          'production-driver-output-reservation-mismatch',
          'Auto Patch MIDI Edit Stage did not receive its required output identity reservation.',
          attempt.dispatch.scope,
        );
      }

      const result = orchestrateAutoPatchMidiEditStage(
        currentProject,
        currentCoordinator,
        {
          artifactId: attempt.outputReservation.artifactId,
          attemptId: attempt.attemptId,
          ...(options.midiEditLabel
            ? { label: options.midiEditLabel }
            : {}),
          now,
          resultId: attempt.outputReservation.resultId,
          sourceEditId: attempt.outputReservation.sourceEditId,
          startedAt: attempt.startedAt,
        },
      );

      ledger = stageLedger;

      if (!result.ok) {
        return failedStage(
          result.project,
          result.coordinator,
          ledger,
          result.cause,
          result.message,
          attempt.dispatch.scope,
        );
      }

      currentProject = result.project;
      currentCoordinator = result.coordinator;
      const completionCancellation = cancelIfRequested(
        options.signal,
        currentProject,
        currentCoordinator,
        ledger,
        currentCoordinator.status === 'READY'
          ? currentCoordinator.activeStage.scope
          : undefined,
      );

      if (completionCancellation) {
        return completionCancellation;
      }

      continue;
    }

    if (
      attempt.dispatch.node.nodeTypeId ===
      BUILTIN_PATCH_TAB_TYPE_IDS.instrument
    ) {
      if (
        attempt.outputReservation.nodeTypeId !==
        BUILTIN_PATCH_TAB_TYPE_IDS.instrument
      ) {
        return blockedInvariant(
          currentProject,
          currentCoordinator,
          ledger,
          'production-driver-output-reservation-mismatch',
          'Auto Patch Instrument Stage did not receive its required output identity reservation.',
          attempt.dispatch.scope,
        );
      }

      const result = await orchestrateAutoPatchRuntimeStage(
        client,
        currentProject,
        currentCoordinator,
        verifiedSoundFontResources,
        {
          attemptId: attempt.attemptId,
          ...(options.instrumentLabel
            ? { label: options.instrumentLabel }
            : {}),
          now,
          outputClipId: attempt.outputReservation.outputClipId,
          resultId: attempt.outputReservation.resultId,
          ...createInstrumentRunnerOption(options),
          startedAt: attempt.startedAt,
        },
      );

      ledger = stageLedger;

      if (!result.ok) {
        if (result.cause === 'stage-run-canceled') {
          return canceledRun(
            result.project,
            result.coordinator,
            ledger,
            result.cause,
            result.message,
            attempt.dispatch.scope,
          );
        }

        return failedStage(
          result.project,
          result.coordinator,
          ledger,
          result.cause,
          result.message,
          attempt.dispatch.scope,
        );
      }

      currentProject = result.project;
      currentCoordinator = result.coordinator;
      const completionCancellation = cancelIfRequested(
        options.signal,
        currentProject,
        currentCoordinator,
        ledger,
        currentCoordinator.status === 'READY'
          ? currentCoordinator.activeStage.scope
          : undefined,
      );

      if (completionCancellation) {
        return completionCancellation;
      }

      continue;
    }

    if (
      attempt.dispatch.node.nodeTypeId ===
      BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3
    ) {
      if (
        attempt.outputReservation.nodeTypeId !==
        BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3
      ) {
        return blockedInvariant(
          currentProject,
          currentCoordinator,
          ledger,
          'production-driver-output-reservation-mismatch',
          'Auto Patch Stable Audio 3 Stage did not receive its required output identity reservation.',
          attempt.dispatch.scope,
        );
      }

      const result = await orchestrateAutoPatchStableAudio3Stage(
        client,
        currentProject,
        currentCoordinator,
        {
          attemptId: attempt.attemptId,
          ...(options.stableAudio3Label
            ? { label: options.stableAudio3Label }
            : {}),
          now,
          resultId: attempt.outputReservation.resultId,
          ...createStableAudio3RunnerOption(options),
          startedAt: attempt.startedAt,
        },
      );

      ledger = stageLedger;

      if (!result.ok) {
        if (result.status === 'STAGE_CANCELED') {
          return canceledRun(
            result.project,
            result.coordinator,
            ledger,
            result.cause,
            result.message,
            attempt.dispatch.scope,
          );
        }

        return failedStage(
          result.project,
          result.coordinator,
          ledger,
          result.cause,
          result.message,
          attempt.dispatch.scope,
        );
      }

      currentProject = result.project;
      currentCoordinator = result.coordinator;
      const completionCancellation = cancelIfRequested(
        options.signal,
        currentProject,
        currentCoordinator,
        ledger,
        currentCoordinator.status === 'READY'
          ? currentCoordinator.activeStage.scope
          : undefined,
      );

      if (completionCancellation) {
        return completionCancellation;
      }

      continue;
    }

    return blockedInvariant(
      currentProject,
      currentCoordinator,
      ledger,
      'production-driver-stage-unsupported',
      `Auto Patch production Driver cannot dispatch node type ${attempt.dispatch.node.nodeTypeId}.`,
      attempt.dispatch.scope,
    );
  }

  if (currentCoordinator.status !== 'COMPLETED') {
    return blockedInvariant(
      currentProject,
      currentCoordinator,
      ledger,
      'production-driver-completion-incomplete',
      'Auto Patch production Driver exhausted the immutable Stage order before the Coordinator completed.',
    );
  }

  return Object.freeze({
    coordinator: currentCoordinator,
    ledger,
    ok: true as const,
    project: currentProject,
    status: 'COMPLETED' as const,
  });
}

function notifyProgress(
  onProgress: AutoPatchProductionDriverOptions['onProgress'],
  project: ProjectState,
  coordinator: AutoPatchReadyRuntimeCoordinator,
  ledger: AutoPatchDriverIdentityLedger,
): Extract<AutoPatchProductionDriverResult, { status: 'BLOCKED' }> | undefined {
  if (!onProgress) {
    return undefined;
  }

  try {
    onProgress(coordinator);
    return undefined;
  } catch (error) {
    return blockedInvariant(
      project,
      coordinator,
      ledger,
      'production-driver-progress-observer-failed',
      error instanceof Error
        ? `Auto Patch progress observer failed: ${error.message}`
        : 'Auto Patch progress observer failed.',
      coordinator.activeStage.scope,
    );
  }
}

function createInstrumentRunnerOption(
  options: AutoPatchProductionDriverOptions,
): Readonly<{ runner: AutoPatchStageRunnerOptions }> | Readonly<{}> {
  if (!options.instrumentRunner && !options.signal) {
    return Object.freeze({});
  }

  return Object.freeze({
    runner: Object.freeze({
      ...(options.instrumentRunner?.maxPollAttempts !== undefined
        ? { maxPollAttempts: options.instrumentRunner.maxPollAttempts }
        : {}),
      ...(options.instrumentRunner?.onProgress
        ? { onProgress: options.instrumentRunner.onProgress }
        : {}),
      ...(options.instrumentRunner?.pollIntervalMs !== undefined
        ? { pollIntervalMs: options.instrumentRunner.pollIntervalMs }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.instrumentRunner?.wait
        ? { wait: options.instrumentRunner.wait }
        : {}),
    }),
  });
}

function createStableAudio3RunnerOption(
  options: AutoPatchProductionDriverOptions,
):
  | Readonly<{
      runner: Omit<
        StableAudio3StageRunnerOptions,
        'maxPollAttempts' | 'pollUntilTerminal'
      >;
    }>
  | Readonly<{}> {
  if (!options.stableAudio3Runner && !options.signal) {
    return Object.freeze({});
  }

  return Object.freeze({
    runner: Object.freeze({
      ...(options.stableAudio3Runner?.onProgress
        ? { onProgress: options.stableAudio3Runner.onProgress }
        : {}),
      ...(options.stableAudio3Runner?.pollIntervalMs !== undefined
        ? { pollIntervalMs: options.stableAudio3Runner.pollIntervalMs }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.stableAudio3Runner?.wait
        ? { wait: options.stableAudio3Runner.wait }
        : {}),
    }),
  });
}

function cancelIfRequested(
  signal: AbortSignal | undefined,
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  ledger: AutoPatchDriverIdentityLedger,
  scope?: TabFlowStageResultScope,
): Extract<
  AutoPatchProductionDriverResult,
  { status: 'CANCELED' }
> | undefined {
  return signal?.aborted
    ? canceledRun(
        project,
        coordinator,
        ledger,
        'abort-signal',
        'Auto Patch production run was canceled.',
        scope,
      )
    : undefined;
}

function canceledRun(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  ledger: AutoPatchDriverIdentityLedger,
  cause: string,
  message: string,
  scope?: TabFlowStageResultScope,
): Extract<
  AutoPatchProductionDriverResult,
  { status: 'CANCELED' }
> {
  return Object.freeze({
    cause,
    coordinator,
    ledger,
    message,
    ok: false,
    project,
    reason: 'run-canceled' as const,
    ...(scope ? { scope: Object.freeze({ ...scope }) } : {}),
    status: 'CANCELED' as const,
  });
}

function failedStage(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  ledger: AutoPatchDriverIdentityLedger,
  cause: string,
  message: string,
  scope: TabFlowStageResultScope,
): Extract<AutoPatchProductionDriverResult, { status: 'FAILED' }> {
  return Object.freeze({
    cause,
    coordinator,
    ledger,
    message,
    ok: false,
    project,
    reason: 'stage-failed' as const,
    scope: Object.freeze({ ...scope }),
    status: 'FAILED' as const,
  });
}

function blockedInvariant(
  project: ProjectState,
  coordinator: AutoPatchRuntimeCoordinator,
  ledger: AutoPatchDriverIdentityLedger,
  cause: string,
  message: string,
  scope?: TabFlowStageResultScope,
): Extract<AutoPatchProductionDriverResult, { status: 'BLOCKED' }> {
  return Object.freeze({
    cause,
    coordinator,
    ledger,
    message,
    ok: false,
    project,
    reason: 'driver-invariant' as const,
    ...(scope ? { scope: Object.freeze({ ...scope }) } : {}),
    status: 'BLOCKED' as const,
  });
}

function areStageScopesEqual(
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
