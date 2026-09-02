import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  LOCAL_ENGINE_PROJECT_STEM_PRINTS_PATH,
  LOCAL_ENGINE_TOKEN_HEADER,
} from '../shared/localEngineProtocol.js';
import {
  PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
} from '../shared/projectStemPrintApiProtocol.js';
import { LocalEngineClient } from './localEngineClient';
import {
  createProjectStemPrintApiRequest,
  createProjectStemPrintPlanSha256,
  type ProjectStemPrintApiRequest,
} from './projectStemPrintApi';
import type { ProjectStemPrintPlan } from './projectStemPrintPlan';
import { createTestProjectMixdownPlanV3 } from './projectMixdownTestFixtures';

const baseUrl = 'http://127.0.0.1:43120';
const launchToken = 'test-launch-token-that-is-at-least-32-characters';
const operationId =
  'stem-print-operation-10000000-0000-4000-8000-000000000001';
const artifactId = 'artifact-10000000-0000-4000-8000-000000000001';
let expectedPlanSha256 = '';

beforeAll(async () => {
  expectedPlanSha256 = await createProjectStemPrintPlanSha256(createPlan());
});

describe('LocalEngineClient Project Stem Print', () => {
  it('snapshots and freezes one exact Plan under a Stem operationId', () => {
    const plan = createPlan();
    const request = createProjectStemPrintApiRequest(plan, operationId);
    (plan as { bpm: number }).bpm = 121;

    expect(request.plan.bpm).toBe(120);
    expect(request.protocolVersion).toBe(
      PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
    );
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.plan)).toBe(true);
    expect(Object.isFrozen(request.plan.selectedTargets[0])).toBe(true);
    expect(() => createProjectStemPrintApiRequest(
      createPlan(),
      'mixdown-operation-10000000-0000-4000-8000-000000000001',
    )).toThrow('operationId is invalid');
  });

  it('sends one authenticated envelope and validates exact output lineage', async () => {
    const request = createRequest();
    const fetchImpl = vi.fn(async () => Response.json(createSuccessBody()));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.runProjectStemPrint(request)).resolves.toMatchObject({
      ok: true,
      operation: {
        operationId,
        protocolVersion: PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
        result: {
          artifact: {
            artifactId,
            provenance: {
              selectedTargets: request.plan.selectedTargets,
            },
          },
          status: 'COMPLETED',
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_PROJECT_STEM_PRINTS_PATH}`,
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

  it('rejects path, Plan identity, target, and count drift as unknown outcomes', async () => {
    const request = createRequest();
    const extraPath = createSuccessBody();
    const planIdentityDrift = createSuccessBody();
    const targetDrift = createSuccessBody();
    const countDrift = createSuccessBody();
    Object.assign(extraPath.result.artifact, {
      absolutePath: 'D:\\Music\\stem.wav',
    });
    planIdentityDrift.result.artifact.provenance.planSha256 = 'b'.repeat(64);
    targetDrift.result.artifact.provenance.selectedTargets[0] = {
      kind: 'channel',
      resolvedTrackId: 'track-other',
      trackId: 'track-other',
    };
    countDrift.result.stemPrint.targetCount = 2;

    for (const body of [
      extraPath,
      planIdentityDrift,
      targetDrift,
      countDrift,
    ]) {
      const client = new LocalEngineClient({
        baseUrl,
        fetchImpl: async () => Response.json(body),
        token: launchToken,
      });
      await expect(client.runProjectStemPrint(request)).resolves.toMatchObject({
        cause: 'invalid-response',
        operationId,
        outcome: 'unknown',
        reason: 'unknown-outcome',
      });
    }
  });

  it('does not dispatch a request canceled before the POST', async () => {
    const fetchImpl = vi.fn(async () => Response.json(createSuccessBody()));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.runProjectStemPrint(createRequest(), controller.signal),
    ).resolves.toEqual({
      message: 'Project Stem Print was canceled before dispatch.',
      ok: false,
      outcome: 'not-dispatched',
      reason: 'canceled',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps post-dispatch cancellation and timeout as unknown outcomes', async () => {
    const canceledFetch = createAbortableFetch();
    const timeoutFetch = createAbortableFetch();
    const canceledClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: canceledFetch,
      token: launchToken,
    });
    const timeoutClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: timeoutFetch,
      projectMixdownTimeoutMs: 5,
      token: launchToken,
    });
    const controller = new AbortController();
    const canceled = canceledClient.runProjectStemPrint(
      createRequest(),
      controller.signal,
    );
    await vi.waitFor(() => expect(canceledFetch).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(canceled).resolves.toMatchObject({
      cause: 'canceled',
      operationId,
      outcome: 'unknown',
    });
    await expect(
      timeoutClient.runProjectStemPrint(createRequest()),
    ).resolves.toMatchObject({
      cause: 'timeout',
      operationId,
      outcome: 'unknown',
    });
  });

  it('treats structured rejection as confirmed and unreadable rejection as unknown', async () => {
    const confirmedClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () => Response.json(
        {
          code: 'PROJECT_STEM_PRINT_BUSY',
          message: 'Another Project Stem Print operation is active.',
        },
        { status: 409 },
      ),
      token: launchToken,
    });
    const unknownClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () => Response.json({}, { status: 500 }),
      token: launchToken,
    });

    await expect(
      confirmedClient.runProjectStemPrint(createRequest()),
    ).resolves.toEqual({
      code: 'PROJECT_STEM_PRINT_BUSY',
      message: 'Another Project Stem Print operation is active.',
      ok: false,
      outcome: 'confirmed',
      reason: 'rejected',
      status: 409,
    });
    await expect(
      unknownClient.runProjectStemPrint(createRequest()),
    ).resolves.toMatchObject({
      cause: 'invalid-response',
      outcome: 'unknown',
    });
  });

  it('recovers only with the original operationId and exact request', async () => {
    const request = createRequest();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json(createSuccessBody()));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const unknownOutcome = await client.runProjectStemPrint(request);

    if (unknownOutcome.ok || unknownOutcome.outcome !== 'unknown') {
      throw new Error('Expected an unknown Project Stem Print outcome.');
    }

    await expect(
      client.recoverProjectStemPrint(request, unknownOutcome),
    ).resolves.toMatchObject({
      ok: true,
      operation: { operationId },
    });
    await expect(
      client.recoverProjectStemPrint(
        request,
        { ...unknownOutcome, operationId: `${operationId.slice(0, -1)}2` },
      ),
    ).rejects.toThrow('reuse the unknown operationId');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

function createRequest(): ProjectStemPrintApiRequest {
  return createProjectStemPrintApiRequest(createPlan(), operationId);
}

function createPlan(): ProjectStemPrintPlan {
  const durationSeconds = 1 / 44_100;
  const track = {
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
  };
  const raw = createTestProjectMixdownPlanV3({
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
    tracks: [track],
  });

  return {
    ...raw,
    audibleRange: { endTick: 960, startTick: 0 },
    purpose: 'stem-print',
    selectedTargets: [
      { kind: 'channel', resolvedTrackId: 'track-1', trackId: 'track-1' },
    ],
    version: 1,
  };
}

function createSuccessBody() {
  return {
    operationId,
    protocolVersion: PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
    result: {
      artifact: {
        artifactId,
        createdAt: '2026-08-13T00:00:00.000Z',
        destination: 'stem-print',
        file: {
          extension: '.wav',
          name: `${artifactId}.wav`,
          relativePath: `stem-prints/${artifactId}.wav`,
          sizeBytes: 48,
        },
        kind: 'audio',
        provenance: {
          planSha256: expectedPlanSha256,
          planVersion: 1,
          rendererId: 'humstudio-pcm-mixdown',
          rendererVersion: '0.2.0',
          selectedTargets: [
            {
              kind: 'channel',
              resolvedTrackId: 'track-1',
              trackId: 'track-1',
            },
          ],
        },
      },
      status: 'COMPLETED',
      stemPrint: {
        bitsPerSample: 16,
        bytesWritten: 48,
        channels: 2,
        durationSeconds: 1 / 44_100,
        frameCount: 1,
        mimeType: 'audio/wav',
        sampleRate: 44_100,
        sourceCount: 1,
        targetCount: 1,
        trackCount: 1,
      },
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
            const error = new Error('Project Stem Print request aborted.');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
  );
}
