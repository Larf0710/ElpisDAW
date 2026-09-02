import type {
  EngineActivityState,
  EngineLifecycleState,
  LocalEngineHealthResult,
} from './localEngineClient';

export type LocalEngineConnectionState = Readonly<{
  activity: EngineActivityState;
  connected: boolean;
  consecutiveFailures: number;
  engineVersion?: string;
  instanceId?: string;
  lastHeartbeatAt?: string;
  lifecycle: EngineLifecycleState;
  message: string;
}>;

export const LOCAL_ENGINE_HEARTBEAT_INTERVAL_MS = 2_000;
export const LOCAL_ENGINE_HEARTBEAT_FAILURE_THRESHOLD = 2;

export function createInitialLocalEngineConnectionState(
  hasBootstrap: boolean,
): LocalEngineConnectionState {
  return Object.freeze({
    activity: 'IDLE',
    connected: false,
    consecutiveFailures: 0,
    lifecycle: hasBootstrap ? 'STARTING' : 'OFFLINE',
    message: hasBootstrap
      ? 'Connecting to the Local Engine.'
      : 'Launch ElpisDAW with the Local Engine Launcher.',
  });
}

export function createLocalEngineConfigurationError(message: string): LocalEngineConnectionState {
  return Object.freeze({
    ...createInitialLocalEngineConnectionState(true),
    lifecycle: 'ERROR',
    message,
  });
}

export function reduceLocalEngineHealthResult(
  previous: LocalEngineConnectionState,
  result: LocalEngineHealthResult,
  checkedAt: string,
  failureThreshold = LOCAL_ENGINE_HEARTBEAT_FAILURE_THRESHOLD,
): LocalEngineConnectionState {
  if (result.ok) {
    return Object.freeze({
      activity: result.health.activity,
      connected: true,
      consecutiveFailures: 0,
      engineVersion: result.health.engineVersion,
      instanceId: result.health.instanceId,
      lastHeartbeatAt: checkedAt,
      lifecycle: result.health.lifecycle,
      message:
        result.health.lifecycle === 'READY'
          ? `Local Engine ${result.health.engineVersion} is ready.`
          : `Local Engine reports ${result.health.lifecycle}.`,
    });
  }

  const consecutiveFailures = previous.consecutiveFailures + 1;

  if (result.reason === 'version-mismatch') {
    return Object.freeze({
      ...previous,
      connected: false,
      consecutiveFailures,
      lifecycle: 'VERSION_MISMATCH',
      message: result.message,
    });
  }

  if (result.reason === 'unauthorized' || result.reason === 'invalid-response' || result.reason === 'http-error') {
    return Object.freeze({
      ...previous,
      connected: false,
      consecutiveFailures,
      lifecycle: 'ERROR',
      message: result.message,
    });
  }

  if (consecutiveFailures < failureThreshold) {
    return Object.freeze({
      ...previous,
      consecutiveFailures,
      message: `Heartbeat missed: ${result.message}`,
    });
  }

  return Object.freeze({
    ...previous,
    connected: false,
    consecutiveFailures,
    lifecycle: 'OFFLINE',
    message: result.message,
  });
}
