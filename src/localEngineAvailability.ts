import type { LocalEngineConnectionState } from './localEngineConnection';

export type LocalEngineAvailability = Readonly<{
  acceptsNewJobs: boolean;
  message: string;
  productionEditingLocked: boolean;
  shouldInterruptRuntime: boolean;
}>;

export function createLocalEngineAvailability(
  connection: LocalEngineConnectionState,
): LocalEngineAvailability {
  if (connection.lifecycle === 'READY') {
    return Object.freeze({
      acceptsNewJobs: connection.activity === 'IDLE',
      message:
        connection.activity === 'IDLE'
          ? 'Local Engine is ready.'
          : 'Local Engine is busy. Non-conflicting Project editing remains available.',
      productionEditingLocked: false,
      shouldInterruptRuntime: false,
    });
  }

  const shouldInterruptRuntime =
    connection.lifecycle === 'OFFLINE' ||
    connection.lifecycle === 'ERROR' ||
    connection.lifecycle === 'VERSION_MISMATCH';

  return Object.freeze({
    acceptsNewJobs: false,
    message: createUnavailableMessage(connection.lifecycle),
    productionEditingLocked: true,
    shouldInterruptRuntime,
  });
}

function createUnavailableMessage(lifecycle: LocalEngineConnectionState['lifecycle']): string {
  switch (lifecycle) {
    case 'STARTING':
      return 'Production controls will unlock when the Local Engine reports READY.';
    case 'STOPPING':
      return 'The Local Engine is stopping and cannot accept new production work.';
    case 'VERSION_MISMATCH':
      return 'The Local Engine protocol does not match this ElpisDAW UI.';
    case 'ERROR':
      return 'The Local Engine reported an error. Production state is read-only.';
    default:
      return 'The Local Engine is offline. Production state is read-only.';
  }
}
