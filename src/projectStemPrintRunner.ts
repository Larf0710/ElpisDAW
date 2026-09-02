import {
  PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
  isProjectStemPrintOperationId,
} from '../shared/projectStemPrintApiProtocol.js';
import {
  verifyGeneratedAudioArtifactsForCommit,
  type GeneratedAudioCommitAvailabilityResult,
} from './generatedAudioCommitAvailability';
import type {
  LocalEngineClient,
  LocalEngineProjectStemPrintResult,
} from './localEngineClient';
import type {
  ProjectStemPrintApiOperation,
  ProjectStemPrintApiRequest,
} from './projectStemPrintApi';
import { createCanonicalProjectStemPrintPlanJson } from './projectMixdownPlanIdentity';
import {
  createProjectStemPrintArtifactCandidate,
  createProjectStemPrintTrackRegistration,
  type ProjectStemPrintRegistrationFailureReason,
} from './projectStemPrintRegistration';
import {
  preflightProjectStemPrintRegistration,
  type ProjectStemPrintRegistrationIntent,
} from './projectStemPrintRegistrationIntent';
import type {
  ProjectState,
  ProjectStemPrintAudioArtifact,
  ProjectStemPrintAudioClipTake,
} from './types';

export type ProjectStemPrintRunnerClient = Pick<
  LocalEngineClient,
  | 'checkGeneratedAudioAvailability'
  | 'recoverProjectStemPrint'
  | 'runProjectStemPrint'
>;

export type ProjectStemPrintRunnerCommand = Readonly<{
  getCurrentProject: () => ProjectState;
  intent: ProjectStemPrintRegistrationIntent;
  request: ProjectStemPrintApiRequest;
}>;

export type ProjectStemPrintRunnerOptions = Readonly<{
  clock?: () => Date;
  signal?: AbortSignal;
}>;

export type ProjectStemPrintUnknownOutcome = Extract<
  LocalEngineProjectStemPrintResult,
  { outcome: 'unknown' }
>;

type AvailabilityFailure = Extract<
  GeneratedAudioCommitAvailabilityResult,
  { ok: false }
>;

export type ProjectStemPrintRunnerResult =
  | Readonly<{
      artifact: ProjectStemPrintAudioArtifact;
      baseProject: ProjectState;
      clipTake: ProjectStemPrintAudioClipTake;
      intent: ProjectStemPrintRegistrationIntent;
      ok: true;
      operation: ProjectStemPrintApiOperation;
      project: ProjectState;
      request: ProjectStemPrintApiRequest;
      status: 'STEM_PRINT_ALREADY_REGISTERED' | 'STEM_PRINT_REGISTERED';
    }>
  | Readonly<{
      intent: ProjectStemPrintRegistrationIntent;
      message: string;
      ok: false;
      operationId: string;
      reason: 'canceled-before-dispatch';
      request: ProjectStemPrintApiRequest;
      status: 'STEM_PRINT_CANCELED';
    }>
  | Readonly<{
      cause: ProjectStemPrintUnknownOutcome['cause'];
      intent: ProjectStemPrintRegistrationIntent;
      message: string;
      ok: false;
      operationId: string;
      reason: 'unknown-outcome';
      request: ProjectStemPrintApiRequest;
      status: 'STEM_PRINT_OUTCOME_UNKNOWN';
      unknownOutcome: ProjectStemPrintUnknownOutcome;
    }>
  | Readonly<{
      code: string;
      engineStatus: number;
      intent: ProjectStemPrintRegistrationIntent;
      message: string;
      ok: false;
      operationId: string;
      reason: 'engine-rejected';
      request: ProjectStemPrintApiRequest;
      status: 'STEM_PRINT_REJECTED';
    }>
  | Readonly<{
      availabilityReason?: AvailabilityFailure['reason'];
      engineStatus?: number;
      intent: ProjectStemPrintRegistrationIntent;
      message: string;
      ok: false;
      operation: ProjectStemPrintApiOperation;
      operationId: string;
      reason: 'availability-verification-failed' | 'registration-rejected';
      registrationReason?: ProjectStemPrintRegistrationFailureReason;
      request: ProjectStemPrintApiRequest;
      status: 'REGISTRATION_BLOCKED';
    }>
  | Readonly<{
      intent: ProjectStemPrintRegistrationIntent;
      message: string;
      ok: false;
      operationId: string;
      reason: 'preflight-rejected';
      registrationReason: ProjectStemPrintRegistrationFailureReason;
      request: ProjectStemPrintApiRequest;
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
      request?: ProjectStemPrintApiRequest;
      status: 'RUNNER_FAILED';
    }>;

export type ProjectStemPrintUnknownResult = Extract<
  ProjectStemPrintRunnerResult,
  { status: 'STEM_PRINT_OUTCOME_UNKNOWN' }
>;

export async function runProjectStemPrintRequest(
  client: ProjectStemPrintRunnerClient,
  command: ProjectStemPrintRunnerCommand,
  options: ProjectStemPrintRunnerOptions = {},
): Promise<ProjectStemPrintRunnerResult> {
  const invalid = validateCommand(command);
  if (invalid) return invalid;

  const preflight = evaluateDispatchPreflight(command);
  if (preflight) return preflight;

  let result: LocalEngineProjectStemPrintResult;
  try {
    result = await client.runProjectStemPrint(command.request, options.signal);
  } catch (error) {
    return runnerFailed(
      'client-exception',
      'project-stem-print-run-exception',
      errorMessage(error, 'Project Stem Print request threw an exception.'),
      command.request,
    );
  }

  return resolveEngineResult(client, command, result, options);
}

export async function recoverProjectStemPrintRequest(
  client: ProjectStemPrintRunnerClient,
  command: ProjectStemPrintRunnerCommand,
  unknownResult: ProjectStemPrintUnknownResult,
  options: ProjectStemPrintRunnerOptions = {},
): Promise<ProjectStemPrintRunnerResult> {
  const invalid = validateCommand(command);
  if (invalid) return invalid;

  if (
    unknownResult.request !== command.request ||
    unknownResult.intent !== command.intent ||
    unknownResult.operationId !== command.request.operationId ||
    !doesUnknownOutcomeMatchRequest(unknownResult.unknownOutcome, command.request)
  ) {
    return runnerFailed(
      'recovery-operation-mismatch',
      'project-stem-print-recovery-operation-mismatch',
      'Project Stem Print recovery must reuse the original Request, intent, and operationId.',
      command.request,
    );
  }

  const preflight = evaluateDispatchPreflight(command);
  if (preflight) return preflight;

  let result: LocalEngineProjectStemPrintResult;
  try {
    result = await client.recoverProjectStemPrint(
      command.request,
      unknownResult.unknownOutcome,
      options.signal,
    );
  } catch (error) {
    return runnerFailed(
      'client-exception',
      'project-stem-print-recovery-exception',
      errorMessage(error, 'Project Stem Print recovery threw an exception.'),
      command.request,
    );
  }

  return resolveEngineResult(client, command, result, options);
}

async function resolveEngineResult(
  client: ProjectStemPrintRunnerClient,
  command: ProjectStemPrintRunnerCommand,
  result: LocalEngineProjectStemPrintResult,
  options: ProjectStemPrintRunnerOptions,
): Promise<ProjectStemPrintRunnerResult> {
  if (result.ok) {
    return settleCompletedOperation(client, command, result.operation, options);
  }

  if (result.outcome === 'unknown') {
    if (!doesUnknownOutcomeMatchRequest(result, command.request)) {
      return runnerFailed(
        'client-response-invalid',
        'project-stem-print-unknown-outcome-invalid',
        'Project Stem Print returned unknown-outcome evidence for a different operation.',
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
      status: 'STEM_PRINT_OUTCOME_UNKNOWN' as const,
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
      status: 'STEM_PRINT_CANCELED' as const,
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
    status: 'STEM_PRINT_REJECTED' as const,
  });
}

async function settleCompletedOperation(
  client: ProjectStemPrintRunnerClient,
  command: ProjectStemPrintRunnerCommand,
  operation: ProjectStemPrintApiOperation,
  options: ProjectStemPrintRunnerOptions,
): Promise<ProjectStemPrintRunnerResult> {
  const current = resolveCurrentProject(command);
  if (!current.ok) return current.result;

  let candidate: Awaited<ReturnType<typeof createProjectStemPrintArtifactCandidate>>;
  try {
    candidate = await createProjectStemPrintArtifactCandidate(
      current.project,
      command.request,
      operation,
      command.intent,
    );
  } catch (error) {
    return runnerFailed(
      'registration-evaluation-failed',
      'project-stem-print-candidate-exception',
      errorMessage(error, 'Stem Print registration evaluation threw an exception.'),
      command.request,
    );
  }

  if (!candidate.canPrepare) {
    return registrationBlocked(command, operation, candidate);
  }

  if (candidate.status === 'ALREADY_REGISTERED') {
    return completeRegistration(command, operation, current.project);
  }

  let availability: GeneratedAudioCommitAvailabilityResult;
  try {
    availability = await verifyGeneratedAudioArtifactsForCommit(
      client,
      [candidate.artifact],
      options.clock,
    );
  } catch (error) {
    return runnerFailed(
      'registration-evaluation-failed',
      'project-stem-print-availability-exception',
      errorMessage(error, 'Stem Print availability verification threw an exception.'),
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
  if (!latest.ok) return latest.result;

  let registration: Awaited<ReturnType<typeof createProjectStemPrintTrackRegistration>>;
  try {
    registration = await createProjectStemPrintTrackRegistration(
      latest.project,
      command.request,
      operation,
      { intent: command.intent, sourceAvailability: availability.evidence },
    );
  } catch (error) {
    return runnerFailed(
      'registration-evaluation-failed',
      'project-stem-print-registration-exception',
      errorMessage(error, 'Stem Print registration threw an exception.'),
      command.request,
    );
  }

  return registration.canRegister
    ? registrationCompleted(command, operation, latest.project, registration)
    : registrationBlocked(command, operation, registration);
}

async function completeRegistration(
  command: ProjectStemPrintRunnerCommand,
  operation: ProjectStemPrintApiOperation,
  project: ProjectState,
): Promise<ProjectStemPrintRunnerResult> {
  try {
    const registration = await createProjectStemPrintTrackRegistration(
      project,
      command.request,
      operation,
      { intent: command.intent },
    );
    return registration.canRegister
      ? registrationCompleted(command, operation, project, registration)
      : registrationBlocked(command, operation, registration);
  } catch (error) {
    return runnerFailed(
      'registration-evaluation-failed',
      'project-stem-print-registration-recovery-exception',
      errorMessage(error, 'Stem Print registration recovery threw an exception.'),
      command.request,
    );
  }
}

function registrationCompleted(
  command: ProjectStemPrintRunnerCommand,
  operation: ProjectStemPrintApiOperation,
  baseProject: ProjectState,
  registration: Extract<
    Awaited<ReturnType<typeof createProjectStemPrintTrackRegistration>>,
    { canRegister: true }
  >,
): ProjectStemPrintRunnerResult {
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
        ? ('STEM_PRINT_REGISTERED' as const)
        : ('STEM_PRINT_ALREADY_REGISTERED' as const),
  });
}

function registrationBlocked(
  command: ProjectStemPrintRunnerCommand,
  operation: ProjectStemPrintApiOperation,
  failure: Readonly<{
    message: string;
    reason: ProjectStemPrintRegistrationFailureReason;
  }>,
): ProjectStemPrintRunnerResult {
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
  command: ProjectStemPrintRunnerCommand,
): ProjectStemPrintRunnerResult | undefined {
  const current = resolveCurrentProject(command);
  if (!current.ok) return current.result;

  try {
    const preflight = preflightProjectStemPrintRegistration(
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
      'project-stem-print-preflight-exception',
      errorMessage(error, 'Stem Print preflight threw an exception.'),
      command.request,
    );
  }
}

function resolveCurrentProject(
  command: ProjectStemPrintRunnerCommand,
):
  | Readonly<{ ok: true; project: ProjectState }>
  | Readonly<{ ok: false; result: ProjectStemPrintRunnerResult }> {
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
        'project-stem-print-current-project-unavailable',
        errorMessage(error, 'Current Project could not be resolved.'),
        command.request,
      ),
    });
  }
}

function validateCommand(
  command: ProjectStemPrintRunnerCommand,
): Extract<ProjectStemPrintRunnerResult, { status: 'RUNNER_FAILED' }> | undefined {
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
      'project-stem-print-runner-command-invalid',
      'Project Stem Print Runner requires one immutable Request, registration intent, and Project resolver.',
      command?.request,
    );
  }
  return undefined;
}

function isImmutableRequest(value: unknown): value is ProjectStemPrintApiRequest {
  return (
    hasExactKeys(value, ['operationId', 'plan', 'protocolVersion']) &&
    value.protocolVersion === PROJECT_STEM_PRINT_API_PROTOCOL_VERSION &&
    isProjectStemPrintOperationId(value.operationId) &&
    createCanonicalProjectStemPrintPlanJson(
      value.plan as ProjectStemPrintApiRequest['plan'],
    ) !== undefined &&
    isDeeplyFrozen(value)
  );
}

function doesUnknownOutcomeMatchRequest(
  value: unknown,
  request: ProjectStemPrintApiRequest,
): value is ProjectStemPrintUnknownOutcome {
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
  if (typeof value !== 'object' || value === null) return true;
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
  reason: Extract<ProjectStemPrintRunnerResult, { status: 'RUNNER_FAILED' }>['reason'],
  cause: string,
  message: string,
  request?: ProjectStemPrintApiRequest,
): Extract<ProjectStemPrintRunnerResult, { status: 'RUNNER_FAILED' }> {
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
