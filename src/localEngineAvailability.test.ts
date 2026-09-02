import { describe, expect, it } from 'vitest';

import type { EngineActivityState, EngineLifecycleState } from './localEngineClient';
import { createLocalEngineAvailability } from './localEngineAvailability';
import type { LocalEngineConnectionState } from './localEngineConnection';

describe('Local Engine availability policy', () => {
  it('keeps Project editing available while a READY Engine is idle or busy', () => {
    expect(createLocalEngineAvailability(createConnection('READY', 'IDLE'))).toMatchObject({
      acceptsNewJobs: true,
      productionEditingLocked: false,
      shouldInterruptRuntime: false,
    });
    expect(createLocalEngineAvailability(createConnection('READY', 'BUSY'))).toMatchObject({
      acceptsNewJobs: false,
      productionEditingLocked: false,
      shouldInterruptRuntime: false,
    });
  });

  it.each(['STARTING', 'STOPPING'] satisfies EngineLifecycleState[])(
    'locks production controls without treating %s as a disconnect',
    (lifecycle) => {
      expect(createLocalEngineAvailability(createConnection(lifecycle))).toMatchObject({
        acceptsNewJobs: false,
        productionEditingLocked: true,
        shouldInterruptRuntime: false,
      });
    },
  );

  it.each(['OFFLINE', 'ERROR', 'VERSION_MISMATCH'] satisfies EngineLifecycleState[])(
    'locks production state and interrupts runtime for %s',
    (lifecycle) => {
      expect(createLocalEngineAvailability(createConnection(lifecycle))).toMatchObject({
        acceptsNewJobs: false,
        productionEditingLocked: true,
        shouldInterruptRuntime: true,
      });
    },
  );
});

function createConnection(
  lifecycle: EngineLifecycleState,
  activity: EngineActivityState = 'IDLE',
): LocalEngineConnectionState {
  return {
    activity,
    connected: lifecycle === 'READY',
    consecutiveFailures: 0,
    lifecycle,
    message: lifecycle,
  };
}
