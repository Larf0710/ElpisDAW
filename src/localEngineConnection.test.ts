import { describe, expect, it } from 'vitest';

import {
  createInitialLocalEngineConnectionState,
  reduceLocalEngineHealthResult,
} from './localEngineConnection';

describe('Local Engine connection state', () => {
  it('starts offline without Launcher bootstrap and starts connecting with it', () => {
    expect(createInitialLocalEngineConnectionState(false)).toMatchObject({
      connected: false,
      lifecycle: 'OFFLINE',
    });
    expect(createInitialLocalEngineConnectionState(true)).toMatchObject({
      connected: false,
      lifecycle: 'STARTING',
    });
  });

  it('moves to the Engine lifecycle after a successful heartbeat', () => {
    const next = reduceLocalEngineHealthResult(
      createInitialLocalEngineConnectionState(true),
      {
        ok: true,
        health: {
          activity: 'IDLE',
          engineVersion: '0.1.0',
          instanceId: 'engine-a',
          lifecycle: 'READY',
          protocolVersion: '1',
          startedAt: '2026-07-23T00:00:00.000Z',
        },
      },
      '2026-07-23T00:00:02.000Z',
    );

    expect(next).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
      engineVersion: '0.1.0',
      lastHeartbeatAt: '2026-07-23T00:00:02.000Z',
      lifecycle: 'READY',
    });
  });

  it('tolerates one missed heartbeat and becomes offline after the second', () => {
    const ready = reduceLocalEngineHealthResult(
      createInitialLocalEngineConnectionState(true),
      {
        ok: true,
        health: {
          activity: 'IDLE',
          engineVersion: '0.1.0',
          instanceId: 'engine-a',
          lifecycle: 'READY',
          protocolVersion: '1',
          startedAt: '2026-07-23T00:00:00.000Z',
        },
      },
      '2026-07-23T00:00:02.000Z',
    );
    const firstMiss = reduceLocalEngineHealthResult(
      ready,
      { message: 'Local Engine is unreachable.', ok: false, reason: 'offline' },
      '2026-07-23T00:00:04.000Z',
    );
    const secondMiss = reduceLocalEngineHealthResult(
      firstMiss,
      { message: 'Local Engine is unreachable.', ok: false, reason: 'offline' },
      '2026-07-23T00:00:06.000Z',
    );

    expect(firstMiss).toMatchObject({ connected: true, consecutiveFailures: 1, lifecycle: 'READY' });
    expect(secondMiss).toMatchObject({ connected: false, consecutiveFailures: 2, lifecycle: 'OFFLINE' });
  });

  it('reports authentication and version failures immediately', () => {
    const starting = createInitialLocalEngineConnectionState(true);

    expect(
      reduceLocalEngineHealthResult(
        starting,
        { message: 'Rejected.', ok: false, reason: 'unauthorized' },
        '2026-07-23T00:00:01.000Z',
      ),
    ).toMatchObject({ connected: false, lifecycle: 'ERROR' });
    expect(
      reduceLocalEngineHealthResult(
        starting,
        { message: 'Mismatch.', ok: false, reason: 'version-mismatch' },
        '2026-07-23T00:00:01.000Z',
      ),
    ).toMatchObject({ connected: false, lifecycle: 'VERSION_MISMATCH' });
  });
});
