import { request as createHttpRequest } from 'node:http';
import {
  access,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeneratedArtifactFinalizer } from './generatedArtifactFinalizer.mjs';
import { ProjectRootAuthority } from './projectRootAuthority.mjs';
import { startLocalEngineServer } from './server.mjs';
import { createTestRawMixdownPlanV3 } from './projectMixdownTestFixtures.mjs';
import {
  LOCAL_ENGINE_HEALTH_PATH,
  LOCAL_ENGINE_JOBS_PATH,
  LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH,
  LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
  LOCAL_ENGINE_TOKEN_HEADER,
} from '../shared/localEngineProtocol.js';
import {
  PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
  createProjectMixdownArtifactId,
} from '../shared/projectMixdownApiProtocol.js';

const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';
const LAUNCH_TOKEN = 'test-launch-token-that-is-at-least-32-characters';
const OPERATION_ID = 'mixdown-operation-10000000-0000-4000-8000-000000000001';
const SECOND_OPERATION_ID = 'mixdown-operation-20000000-0000-4000-8000-000000000002';
const OUTPUT_ARTIFACT_ID = createProjectMixdownArtifactId(OPERATION_ID);
const SAMPLE_RATE = 44_100;
const TEST_TIMELINE_TICKS_PER_BEAT = 960;
// Keep compact one-frame API fixtures coherent with integer Timeline ticks.
const TEST_BPM =
  (60 * SAMPLE_RATE) / TEST_TIMELINE_TICKS_PER_BEAT;
const CONFLICT_TEST_BPM = TEST_BPM + 1;
const runningEngines = new Set();
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.allSettled([...runningEngines].map((engine) => engine.close()));
  runningEngines.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('Project Mixdown API', () => {
  it('requires authentication and one exact versioned request envelope', async () => {
    const service = new ImmediateMixdownService();
    const engine = await startTestEngine({ projectMixdownService: service });
    const unauthenticated = await fetch(
      `${engine.baseUrl}${LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH}`,
      {
        body: JSON.stringify(createEnvelope()),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    const wrongContentType = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH,
      { body: JSON.stringify(createEnvelope()), method: 'POST' },
    );
    const malformedJson = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH,
      {
        body: '{',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    const malformedEnvelope = await postMixdown(engine, {
      operationId: OPERATION_ID,
      plan: createPlan(),
    });

    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(wrongContentType.status).toBe(415);
    expect(malformedJson.status).toBe(400);
    expect(malformedEnvelope.status).toBe(400);
    await expect(malformedEnvelope.json()).resolves.toEqual({
      code: 'PROJECT_MIXDOWN_REQUEST_INVALID',
      message: 'Project Mixdown request envelope keys are invalid.',
    });
    expect(service.calls).toBe(0);
  });

  it('runs the composed Service and WorkerClient and returns only safe finalized metadata', async () => {
    const { engine, plan, rootPath } = await startReadyEngineWithRenderer();
    const response = await postMixdown(engine, createEnvelope({ plan }));
    const body = await response.json();
    const mixdownFiles = await readdir(join(rootPath, 'mixdowns'));

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      operationId: OPERATION_ID,
      result: {
        artifact: {
          file: {
            name: mixdownFiles[0],
            relativePath: `mixdowns/${mixdownFiles[0]}`,
          },
        },
        status: 'COMPLETED',
      },
    });
    expect(mixdownFiles).toHaveLength(1);
    expect(mixdownFiles[0]).toBe(`${OUTPUT_ARTIFACT_ID}.wav`);
    await expect(access(join(rootPath, 'mixdowns', mixdownFiles[0]))).resolves.toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(rootPath);
    expect(body.result).not.toHaveProperty('meterSummary');
    expect(body.result.mixdown).not.toHaveProperty('meterSummary');
    expect(body.result.artifact.provenance).not.toHaveProperty('meterSummary');
    expect(await findPartialFiles(join(rootPath, 'mixdowns'))).toEqual([]);
  });

  it('returns the same completed outcome for the same operationId and canonical Plan', async () => {
    const service = new ImmediateMixdownService();
    const engine = await startTestEngine({ projectMixdownService: service });
    const firstEnvelope = createEnvelope();
    const reorderedPlan = reorderPlanKeys(createPlan());
    const firstResponse = await postMixdown(engine, firstEnvelope);
    const recoveredResponse = await postMixdown(
      engine,
      createEnvelope({ plan: reorderedPlan }),
    );
    const firstBody = await firstResponse.json();
    const recoveredBody = await recoveredResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(recoveredResponse.status).toBe(200);
    expect(recoveredBody).toEqual(firstBody);
    expect(service.calls).toBe(1);
    expect(JSON.stringify(firstBody)).not.toContain('C:\\');
    expect(firstBody).toMatchObject({
      operationId: OPERATION_ID,
      protocolVersion: PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
      result: {
        artifact: {
          file: {
            relativePath:
              `mixdowns/${OUTPUT_ARTIFACT_ID}.wav`,
          },
        },
        status: 'COMPLETED',
      },
    });
    expect(firstBody.result.artifact.provenance).not.toHaveProperty('plan');
    expect(firstBody.result.artifact.provenance).not.toHaveProperty('sourceIds');
  });

  it('rejects a completed Service result that substitutes the operation-owned Artifact identity', async () => {
    const service = {
      async renderAndSave(plan) {
        return createCompletedServiceResult(
          plan,
          'artifact-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        );
      },
    };
    const engine = await startTestEngine({ projectMixdownService: service });
    const response = await postMixdown(engine, createEnvelope());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: 'PROJECT_MIXDOWN_RESULT_INVALID',
      message: 'Project Mixdown completed with invalid Engine metadata.',
    });
  });

  it('rejects a reused operationId when an effect changes the canonical Plan', async () => {
    const service = new ImmediateMixdownService();
    const engine = await startTestEngine({ projectMixdownService: service });
    await postMixdown(engine, createEnvelope());
    const changedEffectsPlan = structuredClone(createPlan());
    changedEffectsPlan.mixerSnapshot.channels[0].inserts[0] = {
      ...changedEffectsPlan.mixerSnapshot.channels[0].inserts[0],
      bypass: false,
    };
    const conflictResponse = await postMixdown(
      engine,
      createEnvelope({ plan: changedEffectsPlan }),
    );

    expect(conflictResponse.status).toBe(409);
    await expect(conflictResponse.json()).resolves.toEqual({
      code: 'PROJECT_MIXDOWN_OPERATION_CONFLICT',
      message: 'Project Mixdown operationId is already bound to a different Plan.',
    });
    expect(service.calls).toBe(1);
  });

  it('recovers the active same operation before rejecting a new operation as busy', async () => {
    const service = new BlockingCompletionService();
    const engine = await startTestEngine({ projectMixdownService: service });
    const firstRequest = postMixdown(engine, createEnvelope());
    await service.waitUntilStarted();
    const recoveryRequest = postMixdown(engine, createEnvelope());
    const conflictResponse = await postMixdown(
      engine,
      createEnvelope({ plan: createPlan({ bpm: CONFLICT_TEST_BPM }) }),
    );
    const busyResponse = await postMixdown(
      engine,
      createEnvelope({ operationId: SECOND_OPERATION_ID }),
    );

    expect(conflictResponse.status).toBe(409);
    await expect(conflictResponse.json()).resolves.toMatchObject({
      code: 'PROJECT_MIXDOWN_OPERATION_CONFLICT',
    });
    expect(busyResponse.status).toBe(409);
    await expect(busyResponse.json()).resolves.toMatchObject({
      code: 'PROJECT_MIXDOWN_BUSY',
    });
    service.complete();
    const [firstResponse, recoveryResponse] = await Promise.all([
      firstRequest,
      recoveryRequest,
    ]);

    expect(firstResponse.status).toBe(200);
    expect(recoveryResponse.status).toBe(200);
    expect(service.calls).toBe(1);
  });

  it('rejects a delayed Job enqueue when Project Mixdown becomes active during body read', async () => {
    const rootPath = await createTemporaryDirectory();
    const projectRootAuthority = new ProjectRootAuthority();
    await projectRootAuthority.configure(rootPath);
    const service = new BlockingCompletionService();
    const gpuJobQueue = createObservableIdleGpuJobQueue();
    const engine = await startTestEngine({
      gpuJobQueue,
      projectMixdownService: service,
      projectRootAuthority,
    });
    const jobBody = JSON.stringify({ request: {} });
    const slowJob = beginPartialAuthenticatedJsonRequest(
      engine,
      LOCAL_ENGINE_JOBS_PATH,
      jobBody,
      '{"request":'.length,
    );
    try {
      await waitForTestEvent(
        slowJob.waitUntilPrefixSent(),
        'delayed Job request prefix',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      const mixdownRequest = postMixdown(engine, createEnvelope());
      await waitForTestEvent(
        service.waitUntilStarted(),
        'Project Mixdown service start',
      );
      await waitForEngineActivity(engine, 'BUSY');
      slowJob.finish();
      const jobResponse = await waitForTestEvent(
        slowJob.response,
        'delayed Job response',
      );

      expect(jobResponse.status).toBe(409);
      expect(JSON.parse(jobResponse.body)).toEqual({
        code: 'ENGINE_OPERATION_ACTIVE',
        message: 'Local Engine is busy with PROJECT_MIXDOWN.',
      });
      expect(gpuJobQueue.enqueue).not.toHaveBeenCalled();
      expect(gpuJobQueue.getSnapshot()).toEqual({
        activeJobId: undefined,
        jobs: [],
      });
      expect(service.calls).toBe(1);
      expect(service.active).toBe(true);
      await expect(readEngineActivity(engine)).resolves.toBe('BUSY');

      service.complete();
      const mixdownResponse = await mixdownRequest;

      expect(mixdownResponse.status).toBe(200);
      await expect(mixdownResponse.json()).resolves.toMatchObject({
        operationId: OPERATION_ID,
        result: { status: 'COMPLETED' },
      });
      await waitForEngineActivity(engine, 'IDLE');
      expect(service.active).toBe(false);
    } finally {
      slowJob.destroy();
      service.complete();
    }
  });

  it('returns a bounded timeout response for a Worker timeout', async () => {
    const service = new FailingMixdownService('MIXDOWN_WORKER_TIMEOUT');
    const engine = await startTestEngine({ projectMixdownService: service });
    const response = await postMixdown(engine, createEnvelope());
    const recoveredResponse = await postMixdown(engine, createEnvelope());

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      code: 'MIXDOWN_WORKER_TIMEOUT',
      message: 'Project Mixdown Worker timed out.',
    });
    expect(recoveredResponse.status).toBe(504);
    await expect(recoveredResponse.json()).resolves.toEqual({
      code: 'MIXDOWN_WORKER_TIMEOUT',
      message: 'Project Mixdown Worker timed out.',
    });
    expect(service.calls).toBe(1);
  });

  it('sanitizes unknown internal errors without exposing filesystem details', async () => {
    const engine = await startTestEngine({
      projectMixdownService: new FailingMixdownService('D:\\private\\mixdown'),
    });
    const response = await postMixdown(engine, createEnvelope());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: 'PROJECT_MIXDOWN_FAILED',
      message: 'Project Mixdown failed.',
    });
  });

  it('aborts Worker rendering on disconnect and removes its staging reservation', async () => {
    const renderer = new BlockingRenderer();
    const { engine, finalizer, plan, rootPath } =
      await startReadyEngineWithRenderer(renderer);
    const socketRequest = beginSocketRequest(engine, createEnvelope({ plan }));
    await renderer.waitUntilStarted();
    socketRequest.destroy();
    await renderer.waitUntilAborted();
    await waitForEngineActivity(engine, 'IDLE');

    expect(finalizer.getActiveReservationCount()).toBe(0);
    expect(await readdir(join(rootPath, 'mixdowns'))).toEqual([]);
    expect(await findPartialFiles(join(rootPath, 'mixdowns'))).toEqual([]);
  });

  it('cleans staging when the client disconnects after rendering but before finalization', async () => {
    const rootPath = await createTemporaryDirectory();
    const service = new BeforeFinalizationService(rootPath);
    const engine = await startTestEngine({ projectMixdownService: service });
    const socketRequest = beginSocketRequest(engine, createEnvelope());
    await service.waitUntilRendered();
    socketRequest.destroy();
    await service.waitUntilCleaned();
    await waitForEngineActivity(engine, 'IDLE');

    expect(await readdir(rootPath)).toEqual([]);
    expect(await findPartialFiles(rootPath)).toEqual([]);
  });

  it('keeps an atomically finalized WAV after socket loss and recovers without another render', async () => {
    const rootPath = await createTemporaryDirectory();
    const service = new FinalizedThenBlockedService(rootPath);
    const engine = await startTestEngine({ projectMixdownService: service });
    const envelope = createEnvelope();
    const socketRequest = beginSocketRequest(engine, envelope);
    await service.waitUntilFinalized();
    socketRequest.destroy();
    await service.waitUntilDisconnected();
    service.releaseResponse();
    await service.waitUntilSettled();
    await waitForEngineActivity(engine, 'IDLE');
    const recoveryResponse = await postMixdown(engine, envelope);
    const recoveryBody = await recoveryResponse.json();

    expect(recoveryResponse.status).toBe(200);
    expect(recoveryBody.operationId).toBe(OPERATION_ID);
    expect(service.calls).toBe(1);
    expect(await readdir(rootPath)).toEqual([
      `${OUTPUT_ARTIFACT_ID}.wav`,
    ]);
    expect(await findPartialFiles(rootPath)).toEqual([]);
  });

  it('aborts and awaits active rendering before shutdown discards remaining staging', async () => {
    const renderer = new BlockingRenderer({ holdAfterAbort: true });
    const { engine, finalizer, plan, rootPath } =
      await startReadyEngineWithRenderer(renderer);
    const socketRequest = beginSocketRequest(engine, createEnvelope({ plan }));
    await renderer.waitUntilStarted();
    let closeSettled = false;
    const closing = engine.close().finally(() => {
      closeSettled = true;
    });
    await renderer.waitUntilAborted();

    expect(closeSettled).toBe(false);
    expect(finalizer.getActiveReservationCount()).toBe(1);
    renderer.releaseAbort();
    await closing;
    runningEngines.delete(engine);
    await socketRequest.completed;

    expect(finalizer.getActiveReservationCount()).toBe(0);
    expect(await readdir(join(rootPath, 'mixdowns'))).toEqual([]);
    expect(await findPartialFiles(join(rootPath, 'mixdowns'))).toEqual([]);
  });
});

class ImmediateMixdownService {
  calls = 0;

  async renderAndSave(plan, { artifactId }) {
    this.calls += 1;
    return createCompletedServiceResult(plan, artifactId);
  }
}

class FailingMixdownService {
  calls = 0;
  #code;

  constructor(code) {
    this.#code = code;
  }

  async renderAndSave() {
    this.calls += 1;
    throw Object.assign(new Error('Internal error details must not cross the API.'), {
      code: this.#code,
    });
  }
}

class BlockingCompletionService extends ImmediateMixdownService {
  active = false;
  #complete;
  #started;
  #waitForCompletion = new Promise((resolve) => {
    this.#complete = resolve;
  });
  #waitForStart = new Promise((resolve) => {
    this.#started = resolve;
  });

  async renderAndSave(plan, { artifactId }) {
    this.calls += 1;
    this.active = true;
    this.#started();
    await this.#waitForCompletion;
    this.active = false;
    return createCompletedServiceResult(plan, artifactId);
  }

  complete() {
    this.#complete();
  }

  waitUntilStarted() {
    return this.#waitForStart;
  }
}

class BlockingRenderer {
  #abortObserved;
  #holdAfterAbort;
  #releaseAbort;
  #started;
  #waitForAbort = new Promise((resolve) => {
    this.#abortObserved = resolve;
  });
  #waitForAbortRelease;
  #waitForStart = new Promise((resolve) => {
    this.#started = resolve;
  });

  constructor({ holdAfterAbort = false } = {}) {
    this.#holdAfterAbort = holdAfterAbort;
    this.#waitForAbortRelease = new Promise((resolve) => {
      this.#releaseAbort = resolve;
    });
  }

  async render(_plan, _sourceBytes, { signal }) {
    this.#started();

    if (!signal.aborted) {
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
    }

    this.#abortObserved();

    if (this.#holdAfterAbort) {
      await this.#waitForAbortRelease;
    }

    throw Object.assign(new Error('Project Mixdown was aborted.'), {
      code: 'MIXDOWN_ABORTED',
    });
  }

  releaseAbort() {
    this.#releaseAbort();
  }

  waitUntilAborted() {
    return this.#waitForAbort;
  }

  waitUntilStarted() {
    return this.#waitForStart;
  }
}

class BeforeFinalizationService {
  #cleaned;
  #rendered;
  #rootPath;
  #waitForCleaned = new Promise((resolve) => {
    this.#cleaned = resolve;
  });
  #waitForRendered = new Promise((resolve) => {
    this.#rendered = resolve;
  });

  constructor(rootPath) {
    this.#rootPath = rootPath;
  }

  async renderAndSave(_plan, { signal }) {
    const stagingPath = join(this.#rootPath, '.artifact-before-finalization.partial');
    await writeFile(stagingPath, 'rendered staging bytes');
    this.#rendered();

    if (!signal.aborted) {
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
    }

    await rm(stagingPath, { force: true });
    this.#cleaned();
    throw Object.assign(new Error('Project Mixdown was aborted.'), {
      code: 'MIXDOWN_ABORTED',
    });
  }

  waitUntilCleaned() {
    return this.#waitForCleaned;
  }

  waitUntilRendered() {
    return this.#waitForRendered;
  }
}

class FinalizedThenBlockedService {
  calls = 0;
  #disconnected;
  #finalized;
  #release;
  #rootPath;
  #settled;
  #waitForDisconnect = new Promise((resolve) => {
    this.#disconnected = resolve;
  });
  #waitForFinalization = new Promise((resolve) => {
    this.#finalized = resolve;
  });
  #waitForRelease = new Promise((resolve) => {
    this.#release = resolve;
  });
  #waitForSettlement = new Promise((resolve) => {
    this.#settled = resolve;
  });

  constructor(rootPath) {
    this.#rootPath = rootPath;
  }

  async renderAndSave(plan, { artifactId, signal }) {
    this.calls += 1;
    await writeFile(
      join(
        this.#rootPath,
        `${artifactId}.wav`,
      ),
      'finalized wav bytes',
    );
    this.#finalized();

    if (signal.aborted) {
      this.#disconnected();
    } else {
      signal.addEventListener('abort', this.#disconnected, { once: true });
    }

    await this.#waitForRelease;
    const result = createCompletedServiceResult(plan, artifactId);
    this.#settled();
    return result;
  }

  releaseResponse() {
    this.#release();
  }

  waitUntilDisconnected() {
    return this.#waitForDisconnect;
  }

  waitUntilFinalized() {
    return this.#waitForFinalization;
  }

  waitUntilSettled() {
    return this.#waitForSettlement;
  }
}

async function startTestEngine(overrides = {}) {
  const engine = await startLocalEngineServer({
    allowedOrigin: ALLOWED_ORIGIN,
    port: 0,
    projectRootAuthority: new ProjectRootAuthority(),
    token: LAUNCH_TOKEN,
    ...overrides,
  });
  runningEngines.add(engine);
  return engine;
}

async function startReadyEngineWithRenderer(renderer) {
  const rootPath = await createTemporaryDirectory();
  const projectRootAuthority = new ProjectRootAuthority();
  const finalizer = new GeneratedArtifactFinalizer({ projectRootAuthority });
  const engine = await startTestEngine({
    generatedArtifactFinalizer: finalizer,
    projectMixdownWorkerClient: renderer,
    projectRootAuthority,
    selectProjectRoot: async () => rootPath,
  });
  const selection = await authenticatedRequest(
    engine,
    LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
    { method: 'POST' },
  );

  if (!selection.ok) {
    throw new Error('Project Root selection failed in Project Mixdown test.');
  }

  const wav = createPcm16Wave();
  await writeFile(join(rootPath, 'renders', 'stable-audio-3', 'source-1.wav'), wav);
  return {
    engine,
    finalizer,
    plan: createPlan({ sourceSize: wav.byteLength }),
    rootPath,
  };
}

function createEnvelope({ operationId = OPERATION_ID, plan = createPlan() } = {}) {
  return {
    operationId,
    plan,
    protocolVersion: PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
  };
}

function createPlan({ bpm = TEST_BPM, sourceSize = 46 } = {}) {
  const durationSeconds = 1 / SAMPLE_RATE;
  const endTick = secondsToTestTimelineTicks(durationSeconds, bpm);
  return createTestRawMixdownPlanV3({
    bpm,
    durationSeconds,
    endTick,
    sources: [
      {
        kind: 'generated',
        name: 'source-1.wav',
        relativePath: 'renders/stable-audio-3/source-1.wav',
        sizeBytes: sourceSize,
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
            timelineEndTick: endTick,
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

function secondsToTestTimelineTicks(seconds, bpm) {
  return Math.max(
    1,
    Math.round(
      (seconds * bpm * TEST_TIMELINE_TICKS_PER_BEAT) / 60,
    ),
  );
}

function reorderPlanKeys(plan) {
  return {
    tracks: plan.tracks,
    startTick: plan.startTick,
    sources: plan.sources,
    purpose: plan.purpose,
    mixerSnapshotVersion: plan.mixerSnapshotVersion,
    mixerSnapshot: plan.mixerSnapshot,
    mixerDspVersion: plan.mixerDspVersion,
    meterTapVersion: plan.meterTapVersion,
    masterFaderDb: plan.masterFaderDb,
    format: plan.format,
    effectsContractVersion: plan.effectsContractVersion,
    endTick: plan.endTick,
    durationSeconds: plan.durationSeconds,
    bpm: plan.bpm,
    version: plan.version,
  };
}

function createCompletedServiceResult(plan, artifactId = OUTPUT_ARTIFACT_ID) {
  const sizeBytes = 48;
  return {
    artifact: {
      artifactId,
      createdAt: '2026-08-08T00:00:00.000Z',
      destination: 'mixdown',
      file: {
        extension: '.wav',
        name: `${artifactId}.wav`,
        relativePath: `mixdowns/${artifactId}.wav`,
        sizeBytes,
      },
      kind: 'audio',
      provenance: {
        plan,
        planVersion: 3,
        rendererId: 'humstudio-pcm-mixdown',
        rendererVersion: '0.2.0',
        sourceIds: ['source-1'],
      },
    },
    mixdown: {
      bitsPerSample: 16,
      bytesWritten: sizeBytes,
      channels: 2,
      durationSeconds: 1 / SAMPLE_RATE,
      frameCount: 1,
      mimeType: 'audio/wav',
      sampleRate: SAMPLE_RATE,
      sourceCount: 1,
      trackCount: 1,
    },
    status: 'COMPLETED',
  };
}

function createPcm16Wave() {
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(2, 40);
  return bytes;
}

function postMixdown(engine, envelope) {
  return authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH, {
    body: JSON.stringify(envelope),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
}

function authenticatedRequest(engine, path, init = {}) {
  return fetch(`${engine.baseUrl}${path}`, {
    ...init,
    headers: {
      Origin: ALLOWED_ORIGIN,
      [LOCAL_ENGINE_TOKEN_HEADER]: LAUNCH_TOKEN,
      ...init.headers,
    },
  });
}

function beginSocketRequest(engine, envelope) {
  const url = new URL(LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH, engine.baseUrl);
  const body = JSON.stringify(envelope);
  let clientRequest;
  const completed = new Promise((resolve) => {
    clientRequest = createHttpRequest(
      url,
      {
        headers: {
          'Content-Length': Buffer.byteLength(body),
          'Content-Type': 'application/json',
          Origin: ALLOWED_ORIGIN,
          [LOCAL_ENGINE_TOKEN_HEADER]: LAUNCH_TOKEN,
        },
        method: 'POST',
      },
      (response) => {
        response.resume();
        response.once('end', resolve);
        response.once('close', resolve);
      },
    );
    clientRequest.once('error', resolve);
    clientRequest.once('close', resolve);
    clientRequest.end(body);
  });

  return {
    completed,
    destroy: () => clientRequest.destroy(),
  };
}

function beginPartialAuthenticatedJsonRequest(
  engine,
  path,
  body,
  prefixLength,
) {
  const url = new URL(path, engine.baseUrl);
  let clientRequest;
  let markPrefixSent;
  const prefixSent = new Promise((resolve) => {
    markPrefixSent = resolve;
  });
  const response = new Promise((resolve) => {
    clientRequest = createHttpRequest(
      url,
      {
        headers: {
          'Content-Length': Buffer.byteLength(body),
          'Content-Type': 'application/json',
          Origin: ALLOWED_ORIGIN,
          [LOCAL_ENGINE_TOKEN_HEADER]: LAUNCH_TOKEN,
        },
        method: 'POST',
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            status: incoming.statusCode,
          });
        });
      },
    );
    clientRequest.once('error', (error) => {
      resolve({ body: '', error, status: undefined });
    });
    clientRequest.write(body.slice(0, prefixLength), markPrefixSent);
  });

  return {
    destroy: () => clientRequest.destroy(),
    finish: () => clientRequest.end(body.slice(prefixLength)),
    response,
    waitUntilPrefixSent: () => prefixSent,
  };
}

function createObservableIdleGpuJobQueue() {
  return {
    enqueue: vi.fn(),
    getSnapshot: () => ({ activeJobId: undefined, jobs: [] }),
    shutdown: async () => undefined,
  };
}

async function readEngineActivity(engine) {
  const response = await authenticatedRequest(engine, LOCAL_ENGINE_HEALTH_PATH);
  const health = await response.json();
  return health.activity;
}

async function waitForTestEvent(promise, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}.`)),
      2_000,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForEngineActivity(engine, activity) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await authenticatedRequest(engine, LOCAL_ENGINE_HEALTH_PATH);
    const health = await response.json();

    if (health.activity === activity) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Local Engine did not reach ${activity}.`);
}

async function findPartialFiles(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith('.partial'));
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-mixdown-api-'));
  temporaryDirectories.add(directory);
  return directory;
}
