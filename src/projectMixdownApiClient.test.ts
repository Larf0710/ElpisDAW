import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH,
  LOCAL_ENGINE_TOKEN_HEADER,
} from '../shared/localEngineProtocol.js';
import {
  PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
} from '../shared/projectMixdownApiProtocol.js';
import { LocalEngineClient } from './localEngineClient';
import {
  createProjectMixdownApiRequest,
  type ProjectMixdownApiRequest,
} from './projectMixdownApi';
import type { ProjectMixdownPlan } from './projectMixdownPlan';
import { createTestProjectMixdownPlanV3 } from './projectMixdownTestFixtures';

const baseUrl = 'http://127.0.0.1:43120';
const launchToken = 'test-launch-token-that-is-at-least-32-characters';
const operationId = 'mixdown-operation-10000000-0000-4000-8000-000000000001';

describe('LocalEngineClient Project Mixdown', () => {
  it('snapshots and freezes the Plan under one client-generated operationId', () => {
    const plan = createPlan();
    const request = createProjectMixdownApiRequest(plan, operationId);
    const mutablePlan = plan as { bpm: number };
    mutablePlan.bpm = 121;

    expect(request.plan.bpm).toBe(120);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.plan)).toBe(true);
    expect(Object.isFrozen(request.plan.tracks[0]?.events[0])).toBe(true);
  });

  it('sends one exact authenticated operation envelope and validates the safe result', async () => {
    const request = createRequest();
    const fetchImpl = vi.fn(async () => Response.json(createSuccessBody()));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.runProjectMixdown(request)).resolves.toMatchObject({
      ok: true,
      operation: {
        operationId,
        protocolVersion: PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
        result: { status: 'COMPLETED' },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH}`,
      expect.objectContaining({
        body: JSON.stringify(request),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('classifies a pre-dispatch abort as canceled without sending a POST', async () => {
    const fetchImpl = vi.fn(async () => Response.json(createSuccessBody()));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.runProjectMixdown(createRequest(), controller.signal),
    ).resolves.toEqual({
      message: 'Project Mixdown was canceled before dispatch.',
      ok: false,
      outcome: 'not-dispatched',
      reason: 'canceled',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves post-dispatch user cancellation as an unknown outcome', async () => {
    const fetchImpl = createAbortableFetch();
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const controller = new AbortController();
    const resultPromise = client.runProjectMixdown(createRequest(), controller.signal);
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({
      cause: 'canceled',
      ok: false,
      operationId,
      outcome: 'unknown',
      reason: 'unknown-outcome',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the dedicated Mixdown timeout and distinguishes timeout from cancellation', async () => {
    const fetchImpl = createAbortableFetch();
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl,
      projectMixdownTimeoutMs: 5,
      timeoutMs: 1,
      token: launchToken,
    });

    await expect(client.runProjectMixdown(createRequest())).resolves.toMatchObject({
      cause: 'timeout',
      ok: false,
      operationId,
      outcome: 'unknown',
      reason: 'unknown-outcome',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps timeout truth when response headers arrive but the body is lost', async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        ({
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  const error = new Error('Response body aborted.');
                  error.name = 'AbortError';
                  reject(error);
                },
                { once: true },
              );
            }),
          ok: true,
          status: 200,
        }) as Response,
    );
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl,
      projectMixdownTimeoutMs: 5,
      token: launchToken,
    });

    await expect(client.runProjectMixdown(createRequest())).resolves.toMatchObject({
      cause: 'timeout',
      outcome: 'unknown',
      reason: 'unknown-outcome',
      status: 200,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves offline and invalid post-dispatch responses as unknown outcomes without retrying', async () => {
    const offlineFetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const invalidFetch = vi.fn(async () => Response.json({ status: 'COMPLETED' }));
    const offlineClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: offlineFetch,
      token: launchToken,
    });
    const invalidClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: invalidFetch,
      token: launchToken,
    });

    await expect(offlineClient.runProjectMixdown(createRequest())).resolves.toMatchObject({
      cause: 'offline',
      outcome: 'unknown',
      reason: 'unknown-outcome',
    });
    await expect(invalidClient.runProjectMixdown(createRequest())).resolves.toMatchObject({
      cause: 'invalid-response',
      outcome: 'unknown',
      reason: 'unknown-outcome',
    });
    expect(offlineFetch).toHaveBeenCalledTimes(1);
    expect(invalidFetch).toHaveBeenCalledTimes(1);
  });

  it('treats a structured rejection as a confirmed outcome', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          code: 'PROJECT_MIXDOWN_BUSY',
          message: 'Another Project Mixdown operation is active.',
        },
        { status: 409 },
      ),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.runProjectMixdown(createRequest())).resolves.toEqual({
      code: 'PROJECT_MIXDOWN_BUSY',
      message: 'Another Project Mixdown operation is active.',
      ok: false,
      outcome: 'confirmed',
      reason: 'rejected',
      status: 409,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('recovers an unknown outcome only with the original request', async () => {
    const request = createRequest();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json(createSuccessBody()));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const unknownOutcome = await client.runProjectMixdown(request);

    expect(unknownOutcome).toMatchObject({
      operationId,
      outcome: 'unknown',
    });

    if (unknownOutcome.ok || unknownOutcome.outcome !== 'unknown') {
      throw new Error('Expected an unknown Project Mixdown outcome.');
    }

    await expect(
      client.recoverProjectMixdown(request, unknownOutcome),
    ).resolves.toMatchObject({
      ok: true,
      operation: { operationId },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify(request),
      method: 'POST',
    });
  });

  it('rejects a success response that adds an absolute filesystem path', async () => {
    const success = createSuccessBody();
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json({
          ...success,
          result: {
            ...success.result,
            artifact: {
              ...success.result.artifact,
              absolutePath: 'D:\\Music\\mixdown.wav',
            },
          },
        }),
      token: launchToken,
    });

    await expect(client.runProjectMixdown(createRequest())).resolves.toMatchObject({
      cause: 'invalid-response',
      outcome: 'unknown',
      reason: 'unknown-outcome',
    });
  });

  it('refuses recovery with a different operationId before dispatch', async () => {
    const request = createRequest();
    const fetchImpl = vi.fn(async () => Response.json(createSuccessBody()));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(
      client.recoverProjectMixdown(
        request,
        unknownOutcomeFor(
          'mixdown-operation-20000000-0000-4000-8000-000000000002',
        ),
      ),
    ).rejects.toThrow('reuse the unknown operationId');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function createRequest(): ProjectMixdownApiRequest {
  return createProjectMixdownApiRequest(createPlan(), operationId);
}

function createPlan(): ProjectMixdownPlan {
  const durationSeconds = 1 / 44_100;
  return createTestProjectMixdownPlanV3({
    bpm: 120,
    durationSeconds,
    endTick: 960,
    sources: [
      {
        kind: 'generated',
        name: 'source-1.wav',
        relativePath: 'renders/stable-audio-3/source-1.wav',
        sizeBytes: 46,
        sourceId: 'source-1',
      },
    ],
    tracks: [
      {
        events: [
          {
            clipId: 'clip-1',
            clipName: 'Source Clip',
            durationSeconds,
            sourceId: 'source-1',
            sourceStartSeconds: 0,
            startOffsetSeconds: 0,
            timelineEndTick: 960,
            timelineStartTick: 0,
          },
        ],
        gainDb: 0,
        pan: 0,
        trackId: 'track-1',
      },
    ],
  });
}

function createSuccessBody() {
  return {
    operationId,
    protocolVersion: PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
    result: {
      artifact: {
        artifactId: 'artifact-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        createdAt: '2026-08-08T00:00:00.000Z',
        destination: 'mixdown',
        file: {
          extension: '.wav',
          name: 'artifact-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.wav',
          relativePath:
            'mixdowns/artifact-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.wav',
          sizeBytes: 48,
        },
        kind: 'audio',
        provenance: {
          planVersion: 3,
          rendererId: 'humstudio-pcm-mixdown',
          rendererVersion: '0.2.0',
        },
      },
      mixdown: {
        bitsPerSample: 16,
        bytesWritten: 48,
        channels: 2,
        durationSeconds: 1 / 44_100,
        frameCount: 1,
        mimeType: 'audio/wav',
        sampleRate: 44_100,
        sourceCount: 1,
        trackCount: 1,
      },
      status: 'COMPLETED',
    },
  };
}

function createAbortableFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            const error = new Error('Project Mixdown request aborted.');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
  );
}

function unknownOutcomeFor(recoveryOperationId: string) {
  return {
    cause: 'offline' as const,
    message: 'Response delivery was lost.',
    ok: false as const,
    operationId: recoveryOperationId,
    outcome: 'unknown' as const,
    reason: 'unknown-outcome' as const,
  };
}
