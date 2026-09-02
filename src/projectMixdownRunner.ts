import {
  PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
  isProjectMixdownOperationId,
} from '../shared/projectMixdownApiProtocol.js';
import {
  verifyGeneratedAudioArtifactsForCommit,
  type GeneratedAudioCommitAvailabilityResult,
} from './generatedAudioCommitAvailability';
import type {
  LocalEngineClient,
  LocalEngineProjectMixdownResult,
} from './localEngineClient';
import type {
  ProjectMixdownApiOperation,
  ProjectMixdownApiRequest,
} from './projectMixdownApi';
import { createCanonicalProjectMixdownPlanJson } from './projectMixdownPlanIdentity';
import {
  createProjectMixdownTrackArtifactCandidate,
  createProjectMixdownTrackRegistration,
  preflightProjectMixdownRegistration,
  type ProjectMixdownRegistrationIntent,
  type ProjectMixdownRegistrationFailureReason,
} from './projectMixdownRegistration';
import type {
  ProjectMixdownAudioArtifact,
  ProjectMixdownAudioClipTake,
  ProjectState,
} from './types';

export type ProjectMixdownRunnerClient = Pick<
  LocalEngineClient,
  | 'checkGeneratedAudioAvailability'
  | 'recoverProjectMixdown'
  | 'runProjectMixdown'
>;

export type ProjectMixdownRunnerCommand = Readonly<{
  getCurrentProject: () => ProjectState;
  intent: ProjectMixdownRegistrationIntent;
  request: ProjectMixdownApiRequest;
}>;

export type ProjectMixdownRunnerOptions = Readonly<{
  clock?: () => Date;
  signal?: AbortSignal;
}>;

export type ProjectMixdownUnknownOutcome = Extract<
  LocalEngineProjectMixdownResult,
  { outcome: 'unknown' }
>;

type AvailabilityFailure = Extract<
  GeneratedAudioCommitAvailabilityResult,
  { ok: false }
>;

export type ProjectMixdownRunnerResult =
  | Readonly<{
      artifact: ProjectMixdownAudioArtifact;
      baseProject: ProjectState;
      clipTake: ProjectMixdownAudioClipTake;
      intent: ProjectMixdownRegistrationIntent;
      ok: true;
      operation: ProjectMixdownApiOperation;
      project: ProjectState;
      request: ProjectMixdownApiRequest;
      status: 'MIXDOWN_ALREADY_REGISTERED' | 'MIXDOWN_REGISTERED';
    }>
  | Readonly<{
      message: string;
      intent: ProjectMixdownRegistrationIntent;
      ok: false;
      operationId: string;
      reason: 'canceled-before-dispatch';
      request: ProjectMixdownApiRequest;
      status: 'MIXDOWN_CANCELED';
    }>
  | Readonly<{
      cause: ProjectMixdownUnknownOutcome['cause'];
      intent: ProjectMixdownRegistrationIntent;
      message: string;
      ok: false;
      operationId: string;
      reason: 'unknown-outcome';
      request: ProjectMixdownApiRequest;
      status: 'MIXDOWN_OUTCOME_UNKNOWN';
      unknownOutcome: ProjectMixdownUnknownOutcome;
    }>
  | Readonly<{
      code: string;
      engineStatus: number;
      intent: ProjectMixdownRegistrationIntent;
      message: string;
      ok: false;
      operationId: string;
      reason: 'engine-rejected';
      request: ProjectMixdownApiRequest;
      status: 'MIXDOWN_REJECTED';
    }>
  | Readonly<{
      message: string;
      intent: ProjectMixdownRegistrationIntent;
      ok: false;
      operation: ProjectMixdownApiOperation;
      operationId: string;
      reason: 'registration-rejected';
      registrationReason: ProjectMixdownRegistrationFailureReason;
      request: ProjectMixdownApiRequest;
      status: 'REGISTRATION_BLOCKED';
    }>
  | Readonly<{
      availabilityReason: AvailabilityFailure['reason'];
      engineStatus?: number;
      intent: ProjectMixdownRegistrationIntent;
      message: string;
      ok: false;
      operation: ProjectMixdownApiOperation;
      operationId: string;
      reason: 'availability-verification-failed';
      request: ProjectMixdownApiRequest;
      status: 'REGISTRATION_BLOCKED';
    }>
  | Readonly<{
      intent: ProjectMixdownRegistrationIntent;
      message: string;
      ok: false;
      operationId: string;
      reason: 'preflight-rejected';
      registrationReason: ProjectMixdownRegistrationFailureReason;
      request: ProjectMixdownApiRequest;
      status: 'PREFLIGHT_BLOCKED';
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
      operationId?: string;
      reason:
        | 'client-exception'
        | 'client-response-invalid'
        | 'project-resolution-failed'
        | 'recovery-operation-mismatch'
        | 'registration-evaluation-failed'
        | 'request-invalid';
      request?: ProjectMixdownApiRequest;
      status: 'RUNNER_FAILED';
    }>;

export type ProjectMixdownUnknownResult = Extract<
  ProjectMixdownRunnerResult,
  { status: 'MIXDOWN_OUTCOME_UNKNOWN' }
>;

export async function runProjectMixdownRequest(
  client: ProjectMixdownRunnerClient,
  command: ProjectMixdownRunnerCommand,
  options: ProjectMixdownRunnerOptions = {},
): Promise<ProjectMixdownRunnerResult> {
  const invalid = validateCommand(command);

  if (invalid) {
    return invalid;
  }

  const preflight = evaluateDispatchPreflight(command);

  if (preflight) {
    return preflight;
  }

  let result: LocalEngineProjectMixdownResult;

  try {
    result = await client.runProjectMixdown(command.request, options.signal);
  } catch (error) {
    return runnerFailed(
      'client-exception',
      'project-mixdown-run-exception',
      errorMessage(error, 'Project Mixdown request threw an exception.'),
      command.request,
    );
  }

  return resolveEngineResult(client, command, result, options);
}

export async function recoverProjectMixdownRequest(
  client: ProjectMixdownRunnerClient,
  command: ProjectMixdownRunnerCommand,
  unknownResult: ProjectMixdownUnknownResult,
  options: ProjectMixdownRunnerOptions = {},
): Promise<ProjectMixdownRunnerResult> {
  const invalid = validateCommand(command);

  if (invalid) {
    return invalid;
  }

  if (
    unknownResult.request !== command.request ||
    unknownResult.intent !== command.intent ||
    unknownResult.operationId !== command.request.operationId ||
    !doesUnknownOutcomeMatchRequest(
      unknownResult.unknownOutcome,
      command.request,
    )
  ) {
    return runnerFailed(
      'recovery-operation-mismatch',
      'project-mixdown-recovery-operation-mismatch',
      'Project Mixdown recovery must reuse the original unknown operationId.',
      command.request,
    );
  }

  const preflight = evaluateDispatchPreflight(command);

  if (preflight) {
    return preflight;
  }

  let result: LocalEngineProjectMixdownResult;

  try {
    result = await client.recoverProjectMixdown(
      command.request,
      unknownResult.unknownOutcome,
      options.signal,
    );
  } catch (error) {
    return runnerFailed(
      'client-exception',
      'project-mixdown-recovery-exception',
      errorMessage(error, 'Project Mixdown recovery threw an exception.'),
      command.request,
    );
  }

  return resolveEngineResult(client, command, result, options);
}

async function resolveEngineResult(
  client: ProjectMixdownRunnerClient,
  command: ProjectMixdownRunnerCommand,
  result: LocalEngineProjectMixdownResult,
  options: ProjectMixdownRunnerOptions,
): Promise<ProjectMixdownRunnerResult> {
  if (result.ok) {
    return settleCompletedOperation(client, command, result.operation, options);
  }

  if (result.outcome === 'unknown') {
    if (!doesUnknownOutcomeMatchRequest(result, command.request)) {
      return runnerFailed(
        'client-response-invalid',
        'project-mixdown-unknown-outcome-invalid',
        'Project Mixdown returned unknown-outcome evidence for a different operation.',
        command.request,
      );
    }

    const unknownOutcome = Object.freeze({ ...result });

    return Object.freeze({
      cause: unknownOutcome.cause,
      intent: command.intent,
      message: unknownOutcome.message,
      ok: false as const,
      operationId: unknownOutcome.operationId,
      reason: 'unknown-outcome' as const,
      request: command.request,
      status: 'MIXDOWN_OUTCOME_UNKNOWN' as const,
      unknownOutcome,
    });
  }

  if (result.outcome === 'not-dispatched') {
    return Object.freeze({
      intent: command.intent,
      message: result.message,
      ok: false as const,
      operationId: command.request.operationId,
      reason: 'canceled-before-dispatch' as const,
      request: command.request,
      status: 'MIXDOWN_CANCELED' as const,
    });
  }

  return Object.freeze({
    code: result.code,
    engineStatus: result.status,
    intent: command.intent,
    message: result.message,
    ok: false as const,
    operationId: command.request.operationId,
    reason: 'engine-rejected' as const,
    request: command.request,
    status: 'MIXDOWN_REJECTED' as const,
  });
}

async function settleCompletedOperation(
  client: ProjectMixdownRunnerClient,
  command: ProjectMixdownRunnerCommand,
  operation: ProjectMixdownApiOperation,
  options: ProjectMixdownRunnerOptions,
): Promise<ProjectMixdownRunnerResult> {
  const initial = evaluateRegistration(command, operation);

  if (!initial.ok) {
    return initial.result;
  }

  if (initial.candidate.status === 'ALREADY_REGISTERED') {
    return completeRegistration(command, operation, initial.project);
  }

  let availability: GeneratedAudioCommitAvailabilityResult;

  try {
    availability = await verifyGeneratedAudioArtifactsForCommit(
      client,
      [initial.candidate.artifact],
      options.clock,
    );
  } catch (error) {
    return runnerFailed(
      'registration-evaluation-failed',
      'project-mixdown-availability-exception',
      errorMessage(
        error,
        'Raw Mixdown availability verification threw an exception.',
      ),
      command.request,
    );
  }

  if (!availability.ok) {
    return Object.freeze({
      availabilityReason: availability.reason,
      ...(availability.status !== undefined
        ? { engineStatus: availability.status }
        : {}),
      intent: command.intent,
      message: availability.message,
      ok: false as const,
      operation,
      operationId: command.request.operationId,
      reason: 'availability-verification-failed' as const,
      request: command.request,
      status: 'REGISTRATION_BLOCKED' as const,
    });
  }

  const latest = resolveCurrentProject(command);

  if (!latest.ok) {
    return latest.result;
  }

  let registration: ReturnType<typeof createProjectMixdownTrackRegistration>;

  try {
    registration = createProjectMixdownTrackRegistration(
      latest.project,
      command.request,
      operation,
      {
        intent: command.intent,
        sourceAvailability: availability.evidence,
      },
    );
  } catch (error) {
    return runnerFailed(
      'registration-evaluation-failed',
      'project-mixdown-registration-exception',
      errorMessage(error, 'Raw Mixdown registration threw an exception.'),
      command.request,
    );
  }

  return registration.canRegister
    ? registrationCompleted(
        command,
        operation,
        latest.project,
        registration,
      )
    : registrationBlocked(command, operation, registration);
}

function evaluateRegistration(
  command: ProjectMixdownRunnerCommand,
  operation: ProjectMixdownApiOperation,
):
  | Readonly<{
      candidate: Extract<
        ReturnType<typeof createProjectMixdownTrackArtifactCandidate>,
        { canPrepare: true }
      >;
      ok: true;
      project: ProjectState;
    }>
  | Readonly<{ ok: false; result: ProjectMixdownRunnerResult }> {
  const current = resolveCurrentProject(command);

  if (!current.ok) {
    return current;
  }

  let candidate: ReturnType<typeof createProjectMixdownTrackArtifactCandidate>;

  try {
    candidate = createProjectMixdownTrackArtifactCandidate(
      current.project,
      command.request,
      operation,
      command.intent,
    );
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      result: runnerFailed(
        'registration-evaluation-failed',
        'project-mixdown-candidate-exception',
        errorMessage(error, 'Raw Mixdown registration evaluation threw an exception.'),
        command.request,
      ),
    });
  }

  return candidate.canPrepare
    ? Object.freeze({ candidate, ok: true as const, project: current.project })
    : Object.freeze({
        ok: false as const,
        result: registrationBlocked(command, operation, candidate),
      });
}

function completeRegistration(
  command: ProjectMixdownRunnerCommand,
  operation: ProjectMixdownApiOperation,
  project: ProjectState,
): ProjectMixdownRunnerResult {
  let registration: ReturnType<typeof createProjectMixdownTrackRegistration>;

  try {
    registration = createProjectMixdownTrackRegistration(
      project,
      command.request,
      operation,
      { intent: command.intent },
    );
  } catch (error) {
    return runnerFailed(
      'registration-evaluation-failed',
      'project-mixdown-registration-recovery-exception',
      errorMessage(error, 'Raw Mixdown registration recovery threw an exception.'),
      command.request,
    );
  }

  return registration.canRegister
    ? registrationCompleted(
        command,
        operation,
        project,
        registration,
      )
    : registrationBlocked(command, operation, registration);
}

function registrationCompleted(
  command: ProjectMixdownRunnerCommand,
  operation: ProjectMixdownApiOperation,
  baseProject: ProjectState,
  registration: Extract<
    ReturnType<typeof createProjectMixdownTrackRegistration>,
    { canRegister: true }
  >,
): ProjectMixdownRunnerResult {
  return Object.freeze({
    artifact: registration.artifact,
    baseProject,
    clipTake: registration.clipTake,
    intent: command.intent,
    ok: true as const,
    operation,
    project: registration.project,
    request: command.request,
    status:
      registration.status === 'REGISTERED'
        ? ('MIXDOWN_REGISTERED' as const)
        : ('MIXDOWN_ALREADY_REGISTERED' as const),
  });
}

function registrationBlocked(
  command: ProjectMixdownRunnerCommand,
  operation: ProjectMixdownApiOperation,
  failure: Readonly<{
    message: string;
    reason: ProjectMixdownRegistrationFailureReason;
  }>,
): ProjectMixdownRunnerResult {
  return Object.freeze({
    intent: command.intent,
    message: failure.message,
    ok: false as const,
    operation,
    operationId: command.request.operationId,
    reason: 'registration-rejected' as const,
    registrationReason: failure.reason,
    request: command.request,
    status: 'REGISTRATION_BLOCKED' as const,
  });
}

function evaluateDispatchPreflight(
  command: ProjectMixdownRunnerCommand,
): ProjectMixdownRunnerResult | undefined {
  const current = resolveCurrentProject(command);

  if (!current.ok) {
    return current.result;
  }

  try {
    const preflight = preflightProjectMixdownRegistration(
      current.project,
      command.request,
      command.intent,
    );

    return preflight.canDispatch
      ? undefined
      : Object.freeze({
          intent: command.intent,
          message: preflight.message,
          ok: false as const,
          operationId: command.request.operationId,
          reason: 'preflight-rejected' as const,
          registrationReason: preflight.reason,
          request: command.request,
          status: 'PREFLIGHT_BLOCKED' as const,
        });
  } catch (error) {
    return runnerFailed(
      'registration-evaluation-failed',
      'project-mixdown-preflight-exception',
      errorMessage(error, 'Raw Mixdown preflight threw an exception.'),
      command.request,
    );
  }
}

function resolveCurrentProject(
  command: ProjectMixdownRunnerCommand,
):
  | Readonly<{ ok: true; project: ProjectState }>
  | Readonly<{ ok: false; result: ProjectMixdownRunnerResult }> {
  try {
    const project = command.getCurrentProject();

    if (!project || typeof project !== 'object') {
      throw new Error('Current Project is unavailable.');
    }

    return Object.freeze({ ok: true as const, project });
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      result: runnerFailed(
        'project-resolution-failed',
        'project-mixdown-current-project-unavailable',
        errorMessage(error, 'Current Project could not be resolved.'),
        command.request,
      ),
    });
  }
}

function validateCommand(
  command: ProjectMixdownRunnerCommand,
): Extract<ProjectMixdownRunnerResult, { status: 'RUNNER_FAILED' }> | undefined {
  if (
    !command ||
    typeof command !== 'object' ||
    typeof command.getCurrentProject !== 'function' ||
    !command.intent ||
    !isDeeplyFrozen(command.intent) ||
    !isImmutableRequest(command.request)
  ) {
    return runnerFailed(
      'request-invalid',
      'project-mixdown-runner-command-invalid',
      'Project Mixdown Runner requires one immutable Request, registration intent, and Project resolver.',
      command?.request,
    );
  }

  return undefined;
}

function isImmutableRequest(
  value: unknown,
): value is ProjectMixdownApiRequest {
  return (
    hasExactKeys(value, ['operationId', 'plan', 'protocolVersion']) &&
    value.protocolVersion === PROJECT_MIXDOWN_API_PROTOCOL_VERSION &&
    isProjectMixdownOperationId(value.operationId) &&
    createCanonicalProjectMixdownPlanJson(value.plan) !== undefined &&
    isDeeplyFrozen(value)
  );
}

function doesUnknownOutcomeMatchRequest(
  value: unknown,
  request: ProjectMixdownApiRequest,
): value is ProjectMixdownUnknownOutcome {
  return (
    hasExactKeys(value, [
      'cause',
      'message',
      'ok',
      'operationId',
      'outcome',
      'reason',
      ...(hasOwn(value, 'status') ? ['status'] : []),
    ]) &&
    value.ok === false &&
    value.outcome === 'unknown' &&
    value.reason === 'unknown-outcome' &&
    value.operationId === request.operationId &&
    ['canceled', 'invalid-response', 'offline', 'timeout'].includes(
      String(value.cause),
    ) &&
    typeof value.message === 'string' &&
    (!hasOwn(value, 'status') ||
      (Number.isInteger(value.status) && (value.status as number) >= 100))
  );
}

function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return true;
  }

  return (
    Object.isFrozen(value) &&
    Object.values(value).every((entry) => isDeeplyFrozen(entry))
  );
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function hasOwn(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function runnerFailed(
  reason: Extract<
    ProjectMixdownRunnerResult,
    { status: 'RUNNER_FAILED' }
  >['reason'],
  cause: string,
  message: string,
  request?: ProjectMixdownApiRequest,
): Extract<ProjectMixdownRunnerResult, { status: 'RUNNER_FAILED' }> {
  return Object.freeze({
    cause,
    message,
    ok: false as const,
    ...(request ? { operationId: request.operationId, request } : {}),
    reason,
    status: 'RUNNER_FAILED' as const,
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
