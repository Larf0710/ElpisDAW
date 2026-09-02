import { createHash } from 'node:crypto';
import { request as createHttpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
import { createPrintMixRequest } from '../src/printMixOperation.ts';
import { createPrintMixPlan } from '../src/printMixPlan.ts';
import {
  PRINT_MIX_TEST_OPERATION_ID,
  PRINT_MIX_TEST_OPERATION_ID_2,
  createPrintMixAudioProject,
  createPrintMixMidiProject,
} from '../src/printMixTestFixture.ts';
import { createOutputWave, writeOutputBlock } from './projectPcmMixdownRenderer.mjs';
import { ProjectRootAuthority } from './projectRootAuthority.mjs';
import { startLocalEngineServer } from './server.mjs';

const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';
const LAUNCH_TOKEN = 'test-launch-token-that-is-at-least-32-characters';
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

describe('Audio PRINT MIX API', () => {
  it('requires authentication, JSON, and one exact Audio request envelope', async () => {
    const service = new ImmediatePrintMixService();
    const engine = await startTestEngine({ printMixService: service });
    const request = createAudioRequest();
    const unauthenticated = await fetch(
      `${engine.baseUrl}${LOCAL_ENGINE_PRINT_MIXES_PATH}`,
      {
        body: JSON.stringify(request),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    const wrongContentType = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PRINT_MIXES_PATH,
      { body: JSON.stringify(request), method: 'POST' },
    );
    const malformedJson = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PRINT_MIXES_PATH,
      {
        body: '{',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    const missingProtocol = await postPrintMix(engine, {
      operationId: request.operationId,
      plan: request.plan,
    });
    const unexpectedEnvelopeField = await postPrintMix(engine, {
      ...request,
      unexpectedEnvelopeField: true,
    });
    const midiRequest = await postPrintMix(engine, createMidiRequest());

    expect(unauthenticated.status).toBe(401);
    expect(wrongContentType.status).toBe(415);
    expect(malformedJson.status).toBe(400);
    expect(missingProtocol.status).toBe(400);
    await expect(missingProtocol.json()).resolves.toEqual({
      code: 'PRINT_MIX_REQUEST_INVALID',
      message: 'Audio PRINT MIX Request is invalid.',
    });
    expect(unexpectedEnvelopeField.status).toBe(400);
    await expect(unexpectedEnvelopeField.json()).resolves.toEqual({
      code: 'PRINT_MIX_REQUEST_INVALID',
      message: 'Audio PRINT MIX Request is invalid.',
    });
    expect(midiRequest.status).toBe(400);
    expect(service.calls).toBe(0);
  });

  it.each([
    [
      'Plan root',
      (request) => { request.plan.unexpectedPlanField = true; },
    ],
    [
      'format',
      (request) => { request.plan.format.unexpectedFormatField = true; },
    ],
    [
      'source descriptor',
      (request) => { request.plan.sources[0].unexpectedSourceField = true; },
    ],
    [
      'event',
      (request) => { request.plan.events[0].unexpectedEventField = true; },
    ],
    [
      'source Lineage',
      (request) => {
        request.plan.sourceLineage[0].unexpectedLineageField = true;
      },
    ],
  ])(
    'rejects an unexpected %s property before creating an operation receipt',
    async (_label, mutate) => {
      const service = new ImmediatePrintMixService();
      const engine = await startTestEngine({ printMixService: service });
      const invalidRequest = structuredClone(createAudioRequest());
      mutate(invalidRequest);
      const invalidResponse = await postPrintMix(engine, invalidRequest);

      expect(invalidResponse.status).toBe(400);
      await expect(invalidResponse.json()).resolves.toEqual({
        code: 'PRINT_MIX_REQUEST_INVALID',
        message: 'Audio PRINT MIX Request is invalid.',
      });
      expect(service.calls).toBe(0);

      const validResponse = await postPrintMix(engine, createAudioRequest());
      expect(validResponse.status).toBe(200);
      expect(service.calls).toBe(1);
    },
  );

  it('rejects a prototype-like own key without mutating the object prototype', async () => {
    const service = new ImmediatePrintMixService();
    const engine = await startTestEngine({ printMixService: service });
    const invalidRequest = structuredClone(createAudioRequest());
    Object.defineProperty(invalidRequest.plan.events[0], '__proto__', {
      configurable: true,
      enumerable: true,
      value: { printMixPolluted: true },
    });

    expect(Object.prototype).not.toHaveProperty('printMixPolluted');
    const invalidResponse = await postPrintMix(engine, invalidRequest);

    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toEqual({
      code: 'PRINT_MIX_REQUEST_INVALID',
      message: 'Audio PRINT MIX Request is invalid.',
    });
    expect(service.calls).toBe(0);
    expect(Object.prototype).not.toHaveProperty('printMixPolluted');

    const validResponse = await postPrintMix(engine, createAudioRequest());
    expect(validResponse.status).toBe(200);
    expect(service.calls).toBe(1);
  });

  it('deduplicates concurrent and completed same-operation recovery', async () => {
    const service = new BlockingPrintMixService();
    const engine = await startTestEngine({ printMixService: service });
    const request = createAudioRequest();
    const first = postPrintMix(engine, request);
    await service.waitUntilStarted();
    const concurrentRecovery = postPrintMix(engine, request);
    const changedPlan = structuredClone(request);
    changedPlan.plan.normalize = !changedPlan.plan.normalize;
    const conflict = await postPrintMix(engine, changedPlan);
    const busy = await postPrintMix(
      engine,
      createAudioRequest(PRINT_MIX_TEST_OPERATION_ID_2),
    );

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'PRINT_MIX_OPERATION_CONFLICT',
    });
    expect(busy.status).toBe(409);
    await expect(busy.json()).resolves.toMatchObject({
      code: 'PRINT_MIX_OPERATION_BUSY',
    });
    service.complete();
    const [firstResponse, concurrentResponse] = await Promise.all([
      first,
      concurrentRecovery,
    ]);
    const firstBody = await firstResponse.json();
    const concurrentBody = await concurrentResponse.json();
    const recoveredResponse = await postPrintMix(engine, request);

    expect(firstResponse.status).toBe(200);
    expect(concurrentResponse.status).toBe(200);
    expect(recoveredResponse.status).toBe(200);
    expect(concurrentBody).toEqual(firstBody);
    await expect(recoveredResponse.json()).resolves.toEqual(firstBody);
    expect(service.calls).toBe(1);
  });

  it('retains Engine-reported unknown outcome under the same operationId', async () => {
    const service = new FailingPrintMixService('PRINT_MIX_OUTCOME_UNKNOWN');
    const engine = await startTestEngine({ printMixService: service });
    const request = createAudioRequest();
    const first = await postPrintMix(engine, request);
    const recovered = await postPrintMix(engine, request);

    expect(first.status).toBe(409);
    expect(recovered.status).toBe(409);
    await expect(first.json()).resolves.toEqual({
      code: 'PRINT_MIX_OUTCOME_UNKNOWN',
      message: 'Audio PRINT MIX outcome is unknown; recover with the same operationId.',
    });
    await expect(recovered.json()).resolves.toMatchObject({
      code: 'PRINT_MIX_OUTCOME_UNKNOWN',
    });
    expect(service.calls).toBe(1);
  });

  it('rejects unsafe or colliding service outcomes without exposing internal details', async () => {
    const unsafeService = new ImmediatePrintMixService({ unsafePath: true });
    const unsafeEngine = await startTestEngine({ printMixService: unsafeService });
    const unsafe = await postPrintMix(unsafeEngine, createAudioRequest());
    const collisionService = new FailingPrintMixService(
      'ARTIFACT_DESTINATION_EXISTS',
      'D:\\private\\print-mixes\\collision.wav',
    );
    const collisionEngine = await startTestEngine({
      printMixService: collisionService,
    });
    const collision = await postPrintMix(
      collisionEngine,
      createAudioRequest(),
    );
    const wrongNamespaceService = new ImmediatePrintMixService({
      relativePathPrefix: 'mixdowns',
    });
    const wrongNamespaceEngine = await startTestEngine({
      printMixService: wrongNamespaceService,
    });
    const wrongNamespace = await postPrintMix(
      wrongNamespaceEngine,
      createAudioRequest(),
    );

    expect(unsafe.status).toBe(409);
    await expect(unsafe.json()).resolves.toEqual({
      code: 'PRINT_MIX_OUTCOME_UNKNOWN',
      message: 'Audio PRINT MIX outcome is unknown; recover with the same operationId.',
    });
    expect(collision.status).toBe(409);
    await expect(collision.json()).resolves.toEqual({
      code: 'ARTIFACT_DESTINATION_EXISTS',
      message: 'Audio PRINT MIX destination already exists.',
    });
    expect(wrongNamespace.status).toBe(409);
    await expect(wrongNamespace.json()).resolves.toMatchObject({
      code: 'PRINT_MIX_OUTCOME_UNKNOWN',
    });
    expect(JSON.stringify(await postPrintMixBody(unsafeEngine))).not.toContain('D:\\');
    expect(unsafeService.calls).toBe(1);
  });

  it('uses production generated-audio reads and finalizes only print-mixes metadata', async () => {
    const rootPath = await createTemporaryDirectory();
    const projectRootAuthority = new ProjectRootAuthority();
    await projectRootAuthority.configure(rootPath);
    const request = createAudioRequest();
    const wave = createWave(0.25);

    for (const source of request.plan.sources) {
      const sourcePath = join(rootPath, ...source.relativePath.split('/'));
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, wave, { flag: 'wx' });
    }

    const engine = await startTestEngine({ projectRootAuthority });
    const response = await postPrintMix(engine, request);
    const body = await response.json();
    const outputFiles = await readdir(join(rootPath, 'print-mixes'));

    expect(response.status).toBe(200);
    expect(outputFiles).toEqual([
      `${createPrintMixArtifactId(request.operationId)}.wav`,
    ]);
    expect(body).toMatchObject({
      operationId: request.operationId,
      protocolVersion: PRINT_MIX_PROTOCOL_VERSION,
      result: {
        artifact: {
          destination: 'print-mix',
          file: { relativePath: `print-mixes/${outputFiles[0]}` },
        },
        status: 'COMPLETED',
      },
    });
    expect(JSON.stringify(body)).not.toContain(rootPath);
    expect(JSON.stringify(body)).not.toContain('absolutePath');
    const bytes = await readFile(join(rootPath, 'print-mixes', outputFiles[0]));
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  });

  it.each([
    ['absolute path', 'D:/private/source.wav', 'source.wav'],
    ['traversal', '../private/source.wav', 'source.wav'],
    ['backslash', 'renders\\instruments\\source.wav', 'source.wav'],
    ['wrong extension', 'renders/instruments/source.mp3', 'source.mp3'],
  ])('rejects %s source descriptors before filesystem access', async (_label, relativePath, name) => {
    const engine = await startTestEngine();
    const request = structuredClone(createAudioRequest());
    request.plan.sources[0].relativePath = relativePath;
    request.plan.sources[0].name = name;
    const response = await postPrintMix(engine, request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: 'PRINT_MIX_REQUEST_INVALID',
      message: 'Audio PRINT MIX Request is invalid.',
    });
  });

  it('aborts before finalization on disconnect but preserves a completed boundary', async () => {
    const abortingService = new AbortAwarePrintMixService();
    const abortingEngine = await startTestEngine({
      printMixService: abortingService,
    });
    const request = createAudioRequest();
    const disconnected = beginSocketRequest(abortingEngine, request);
    await abortingService.waitUntilStarted();
    disconnected.destroy();
    await abortingService.waitUntilAborted();

    expect(abortingService.finalized).toBe(false);

    const finalizedService = new BlockingPrintMixService();
    const finalizedEngine = await startTestEngine({
      printMixService: finalizedService,
    });
    const finalizedSocket = beginSocketRequest(finalizedEngine, request);
    await finalizedService.waitUntilStarted();
    finalizedSocket.destroy();
    finalizedService.complete();
    await finalizedService.waitUntilCompleted();
    const recovery = await postPrintMix(finalizedEngine, request);

    expect(recovery.status).toBe(200);
    expect(finalizedService.calls).toBe(1);
  });
});

class ImmediatePrintMixService {
  calls = 0;
  #relativePathPrefix;
  #unsafePath;

  constructor({ relativePathPrefix = 'print-mixes', unsafePath = false } = {}) {
    this.#relativePathPrefix = relativePathPrefix;
    this.#unsafePath = unsafePath;
  }

  async renderAndSave(plan) {
    this.calls += 1;
    const result = createCompletedResult(plan);
    const withDestination = this.#relativePathPrefix === 'print-mixes'
      ? result
      : {
          ...result,
          artifact: {
            ...result.artifact,
            file: {
              ...result.artifact.file,
              relativePath: `${this.#relativePathPrefix}/${result.artifact.file.name}`,
            },
          },
        };
    return this.#unsafePath
      ? {
          ...withDestination,
          artifact: {
            ...withDestination.artifact,
            absolutePath: 'D:\\private\\print-mix.wav',
          },
        }
      : withDestination;
  }
}

class BlockingPrintMixService extends ImmediatePrintMixService {
  #complete;
  #completed;
  #started;
  #waitForCompletion = new Promise((resolve) => {
    this.#complete = resolve;
  });
  #waitForCompleted = new Promise((resolve) => {
    this.#completed = resolve;
  });
  #waitForStart = new Promise((resolve) => {
    this.#started = resolve;
  });

  async renderAndSave(plan) {
    this.calls += 1;
    this.#started();
    await this.#waitForCompletion;
    const result = createCompletedResult(plan);
    this.#completed();
    return result;
  }

  complete() {
    this.#complete();
  }

  waitUntilCompleted() {
    return this.#waitForCompleted;
  }

  waitUntilStarted() {
    return this.#waitForStart;
  }
}

class AbortAwarePrintMixService {
  calls = 0;
  finalized = false;
  #aborted;
  #started;
  #waitForAbort = new Promise((resolve) => {
    this.#aborted = resolve;
  });
  #waitForStart = new Promise((resolve) => {
    this.#started = resolve;
  });

  async renderAndSave(_plan, { signal }) {
    this.calls += 1;
    this.#started();
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    }
    this.#aborted();
    throw Object.assign(new Error('aborted before finalization'), {
      code: 'PRINT_MIX_ABORTED',
    });
  }

  waitUntilAborted() {
    return this.#waitForAbort;
  }

  waitUntilStarted() {
    return this.#waitForStart;
  }
}

class FailingPrintMixService {
  calls = 0;
  #code;
  #message;

  constructor(code, message = 'Internal details must remain private.') {
    this.#code = code;
    this.#message = message;
  }

  async renderAndSave() {
    this.calls += 1;
    throw Object.assign(new Error(this.#message), { code: this.#code });
  }
}

function createAudioRequest(operationId = PRINT_MIX_TEST_OPERATION_ID) {
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

function createMidiRequest() {
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

function createCompletedResult(plan) {
  const artifactId = createPrintMixArtifactId(plan.operationId);
  const frameCount = Math.round(plan.durationSeconds * PRINT_MIX_SAMPLE_RATE);
  const sizeBytes = 44 + frameCount * 4;
  return {
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
        planSha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
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
      normalize: plan.normalize,
      outputPeak: 0,
      preNormalizationPeak: 0,
      sampleRate: PRINT_MIX_SAMPLE_RATE,
      sourceCount: plan.sources.length,
      targetPeakDbfs: PRINT_MIX_NORMALIZE_TARGET_DBFS,
    },
    status: 'COMPLETED',
  };
}

async function startTestEngine(overrides = {}) {
  const engine = await startLocalEngineServer({
    allowedOrigin: ALLOWED_ORIGIN,
    port: 0,
    token: LAUNCH_TOKEN,
    ...overrides,
  });
  runningEngines.add(engine);
  return engine;
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-print-mix-api-'));
  temporaryDirectories.add(directory);
  return directory;
}

function postPrintMix(engine, body) {
  return authenticatedRequest(engine, LOCAL_ENGINE_PRINT_MIXES_PATH, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
}

async function postPrintMixBody(engine) {
  const response = await postPrintMix(engine, createAudioRequest());
  return response.json();
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

function beginSocketRequest(engine, body) {
  const url = new URL(LOCAL_ENGINE_PRINT_MIXES_PATH, engine.baseUrl);
  const requestBody = JSON.stringify(body);
  let clientRequest;
  const completed = new Promise((resolve) => {
    clientRequest = createHttpRequest(
      url,
      {
        headers: {
          'Content-Length': Buffer.byteLength(requestBody),
          'Content-Type': 'application/json',
          Origin: ALLOWED_ORIGIN,
          [LOCAL_ENGINE_TOKEN_HEADER]: LAUNCH_TOKEN,
        },
        method: 'POST',
      },
      (response) => {
        response.resume();
        response.once('close', resolve);
        response.once('end', resolve);
      },
    );
    clientRequest.once('error', resolve);
    clientRequest.once('close', resolve);
    clientRequest.end(requestBody);
  });
  return {
    completed,
    destroy: () => clientRequest.destroy(),
  };
}

function createWave(sample) {
  const frameCount = 22_050;
  const bytes = createOutputWave(frameCount);
  const left = new Float64Array(frameCount).fill(sample);
  const right = new Float64Array(frameCount).fill(sample);
  writeOutputBlock(bytes, 0, left, right);
  return bytes;
}
