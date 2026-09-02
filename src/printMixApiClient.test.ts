import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_ENGINE_PRINT_MIXES_PATH,
  LOCAL_ENGINE_TOKEN_HEADER,
} from '../shared/localEngineProtocol.js';
import {
  PRINT_MIX_BITS_PER_SAMPLE,
  PRINT_MIX_CHANNELS,
  PRINT_MIX_MIME_TYPE,
  PRINT_MIX_NORMALIZE_TARGET_DBFS,
  PRINT_MIX_PLAN_VERSION,
  PRINT_MIX_PROTOCOL_VERSION,
  PRINT_MIX_RENDERER_ID,
  PRINT_MIX_RENDERER_VERSION,
  PRINT_MIX_SAMPLE_RATE,
  createPrintMixArtifactId,
} from '../shared/printMixProtocol.js';
import { LocalEngineClient } from './localEngineClient';
import {
  createPrintMixPlanSha256,
  createPrintMixRequest,
  type PrintMixRequest,
} from './printMixOperation';
import { createPrintMixPlan } from './printMixPlan';
import {
  PRINT_MIX_TEST_OPERATION_ID,
  PRINT_MIX_TEST_OPERATION_ID_2,
  createPrintMixAudioProject,
  createPrintMixMidiProject,
} from './printMixTestFixture';

const baseUrl = 'http://127.0.0.1:43120';
const launchToken = 'test-launch-token-that-is-at-least-32-characters';

describe('LocalEngineClient Audio PRINT MIX', () => {
  it('posts one exact authenticated request and validates a frozen result', async () => {
    const request = createAudioRequest();
    const body = await createSuccessBody(request);
    const fetchImpl = vi.fn(async () => Response.json(body));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    const result = await client.runPrintMix(request);

    expect(result).toMatchObject({
      ok: true,
      operation: {
        operationId: request.operationId,
        protocolVersion: PRINT_MIX_PROTOCOL_VERSION,
        result: { status: 'COMPLETED' },
      },
    });
    expect(result.ok && Object.isFrozen(result.operation)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_PRINT_MIXES_PATH}`,
      expect.objectContaining({
        body: JSON.stringify(request),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks pre-dispatch cancellation and MIDI Plans without sending a request', async () => {
    const fetchImpl = vi.fn();
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.runPrintMix(createAudioRequest(), controller.signal),
    ).resolves.toEqual({
      message: 'Audio PRINT MIX was canceled before dispatch.',
      ok: false,
      outcome: 'not-dispatched',
      reason: 'canceled',
    });
    await expect(client.runPrintMix(createMidiRequest())).rejects.toThrow(
      'requires an Audio Plan',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies timeout, cancellation, offline, and invalid success after dispatch as unknown', async () => {
    const request = createAudioRequest();
    const timeoutFetch = createAbortableFetch();
    const timeoutClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: timeoutFetch,
      printMixTimeoutMs: 5,
      token: launchToken,
    });
    const cancelFetch = createAbortableFetch();
    const cancelClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: cancelFetch,
      token: launchToken,
    });
    const controller = new AbortController();
    const cancelResult = cancelClient.runPrintMix(request, controller.signal);
    controller.abort();
    const offlineClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
      token: launchToken,
    });
    const invalidClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: vi.fn(async () => Response.json({ status: 'COMPLETED' })),
      token: launchToken,
    });

    await expect(timeoutClient.runPrintMix(request)).resolves.toMatchObject({
      cause: 'timeout',
      operationId: request.operationId,
      outcome: 'unknown',
    });
    await expect(cancelResult).resolves.toMatchObject({
      cause: 'canceled',
      operationId: request.operationId,
      outcome: 'unknown',
    });
    await expect(offlineClient.runPrintMix(request)).resolves.toMatchObject({
      cause: 'offline',
      outcome: 'unknown',
    });
    await expect(invalidClient.runPrintMix(request)).resolves.toMatchObject({
      cause: 'invalid-response',
      outcome: 'unknown',
    });
  });

  it('treats Engine-reported finalization uncertainty as recoverable unknown outcome', async () => {
    const request = createAudioRequest();
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: vi.fn(async () =>
        Response.json(
          {
            code: 'PRINT_MIX_OUTCOME_UNKNOWN',
            message: 'Audio PRINT MIX outcome is unknown; recover with the same operationId.',
          },
          { status: 409 },
        ),
      ),
      token: launchToken,
    });

    await expect(client.runPrintMix(request)).resolves.toEqual({
      cause: 'engine-reported',
      message: 'Audio PRINT MIX outcome is unknown; recover with the same operationId.',
      ok: false,
      operationId: request.operationId,
      outcome: 'unknown',
      reason: 'unknown-outcome',
      status: 409,
    });
  });

  it('keeps explicit Engine rejection confirmed and rejects unsafe success metadata', async () => {
    const request = createAudioRequest();
    const rejectedClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: vi.fn(async () =>
        Response.json(
          { code: 'PRINT_MIX_PLAN_INVALID', message: 'Audio PRINT MIX Plan is invalid.' },
          { status: 400 },
        ),
      ),
      token: launchToken,
    });
    const unsafeBody = await createSuccessBody(request);
    const unsafeClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: vi.fn(async () =>
        Response.json({
          ...unsafeBody,
          result: {
            ...unsafeBody.result,
            artifact: {
              ...unsafeBody.result.artifact,
              absolutePath: 'D:\\private\\print-mix.wav',
            },
          },
        }),
      ),
      token: launchToken,
    });

    await expect(rejectedClient.runPrintMix(request)).resolves.toEqual({
      code: 'PRINT_MIX_PLAN_INVALID',
      message: 'Audio PRINT MIX Plan is invalid.',
      ok: false,
      outcome: 'confirmed',
      reason: 'rejected',
      status: 400,
    });
    await expect(unsafeClient.runPrintMix(request)).resolves.toMatchObject({
      cause: 'invalid-response',
      outcome: 'unknown',
    });
  });

  it('recovers only by resending the exact original operation', async () => {
    const request = createAudioRequest();
    const body = await createSuccessBody(request);
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(Response.json(body));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const unknown = await client.runPrintMix(request);

    if (unknown.ok || unknown.outcome !== 'unknown') {
      throw new Error('Expected an unknown Audio PRINT MIX outcome.');
    }

    await expect(client.recoverPrintMix(request, unknown)).resolves.toMatchObject({
      ok: true,
      operation: { operationId: request.operationId },
    });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify(request),
      method: 'POST',
    });
    await expect(
      client.recoverPrintMix(request, {
        ...unknown,
        operationId: PRINT_MIX_TEST_OPERATION_ID_2,
      }),
    ).rejects.toThrow('reuse the unknown operationId');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

function createAudioRequest(
  operationId = PRINT_MIX_TEST_OPERATION_ID,
): PrintMixRequest {
  const project = createPrintMixAudioProject();
  const resolution = createPrintMixPlan(
    project,
    'print-mix',
    project.selection,
    operationId,
  );

  if (!resolution.canCreate || resolution.plan.mediaType !== 'audio') {
    throw new Error('Missing Audio PRINT MIX fixture.');
  }

  return createPrintMixRequest(resolution.plan);
}

function createMidiRequest(): PrintMixRequest {
  const project = createPrintMixMidiProject();
  const resolution = createPrintMixPlan(
    project,
    'print-mix',
    project.selection,
    PRINT_MIX_TEST_OPERATION_ID,
  );

  if (!resolution.canCreate || resolution.plan.mediaType !== 'midi') {
    throw new Error('Missing MIDI PRINT MIX fixture.');
  }

  return createPrintMixRequest(resolution.plan);
}

async function createSuccessBody(request: PrintMixRequest) {
  if (request.plan.mediaType !== 'audio') {
    throw new Error('Success fixture requires Audio PRINT MIX.');
  }

  const artifactId = createPrintMixArtifactId(request.operationId);
  const frameCount = Math.round(
    request.plan.durationSeconds * PRINT_MIX_SAMPLE_RATE,
  );
  const sizeBytes = 44 + frameCount * 4;

  if (!artifactId) {
    throw new Error('Missing PRINT MIX Artifact fixture identity.');
  }

  return {
    operationId: request.operationId,
    protocolVersion: PRINT_MIX_PROTOCOL_VERSION,
    result: {
      artifact: {
        artifactId,
        createdAt: '2026-08-16T01:00:00.000Z',
        destination: 'print-mix',
        file: {
          extension: '.wav',
          name: `${artifactId}.wav`,
          relativePath: `print-mixes/${artifactId}.wav`,
          sizeBytes,
        },
        kind: 'audio',
        provenance: {
          planSha256: await createPrintMixPlanSha256(request.plan),
          planVersion: PRINT_MIX_PLAN_VERSION,
          rendererId: PRINT_MIX_RENDERER_ID,
          rendererVersion: PRINT_MIX_RENDERER_VERSION,
        },
      },
      printMix: {
        appliedGain: 1,
        bitsPerSample: PRINT_MIX_BITS_PER_SAMPLE,
        bytesWritten: sizeBytes,
        channels: PRINT_MIX_CHANNELS,
        clippingWarning: false,
        durationSeconds: frameCount / PRINT_MIX_SAMPLE_RATE,
        frameCount,
        mediaType: 'audio',
        mimeType: PRINT_MIX_MIME_TYPE,
        normalize: request.plan.normalize,
        outputPeak: 0,
        preNormalizationPeak: 0,
        sampleRate: PRINT_MIX_SAMPLE_RATE,
        sourceCount: request.plan.sources.length,
        targetPeakDbfs: PRINT_MIX_NORMALIZE_TARGET_DBFS,
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
            const error = new Error('Audio PRINT MIX request aborted.');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
  );
}
