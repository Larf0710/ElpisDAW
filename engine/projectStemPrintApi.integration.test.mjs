import { createHash } from 'node:crypto';
import { request as createHttpRequest } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LOCAL_ENGINE_HEALTH_PATH,
  LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH,
  LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
  LOCAL_ENGINE_PROJECT_STEM_PRINTS_PATH,
  LOCAL_ENGINE_TOKEN_HEADER,
} from '../shared/localEngineProtocol.js';
import {
  PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
} from '../shared/projectMixdownApiProtocol.js';
import {
  PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
  createProjectStemPrintArtifactId,
} from '../shared/projectStemPrintApiProtocol.js';
import { createCanonicalProjectRenderPlanJson } from '../shared/projectRenderPlanIdentity.js';
import { GeneratedArtifactFinalizer } from './generatedArtifactFinalizer.mjs';
import {
  createTestRawMixdownPlanV3,
  createTestStemPrintPlanV1,
} from './projectMixdownTestFixtures.mjs';
import { ProjectMixdownWorkerClient } from './projectMixdownWorkerClient.mjs';
import { ProjectRootAuthority } from './projectRootAuthority.mjs';
import { startLocalEngineServer } from './server.mjs';

const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';
const LAUNCH_TOKEN = 'stem-print-test-token-that-is-at-least-32-characters';
const OPERATION_ID =
  'stem-print-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_OPERATION_ID =
  'stem-print-operation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RAW_OPERATION_ID =
  'mixdown-operation-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ARTIFACT_ID = createProjectStemPrintArtifactId(OPERATION_ID);
const SAMPLE_RATE = 44_100;
const TICKS_PER_BEAT = 960;
const TEST_BPM = (60 * SAMPLE_RATE) / TICKS_PER_BEAT;
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

describe('Project Stem Print API', () => {
  it('requires authentication and one exact versioned envelope', async () => {
    const service = new ImmediateStemPrintService();
    const engine = await startTestEngine({ projectMixdownService: service });
    const unauthenticated = await fetch(
      `${engine.baseUrl}${LOCAL_ENGINE_PROJECT_STEM_PRINTS_PATH}`,
      {
        body: JSON.stringify(createEnvelope()),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    const invalid = await postStemPrint(engine, {
      operationId: OPERATION_ID,
      plan: createPlan(),
    });

    expect(unauthenticated.status).toBe(401);
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      code: 'PROJECT_STEM_PRINT_REQUEST_INVALID',
      message: 'Project Stem Print request envelope keys are invalid.',
    });
    expect(service.stemCalls).toBe(0);
  });

  it('runs the composed service and returns only safe finalized metadata', async () => {
    const rootPath = await createTemporaryDirectory();
    const projectRootAuthority = new ProjectRootAuthority();
    const finalizer = new GeneratedArtifactFinalizer({ projectRootAuthority });
    const engine = await startTestEngine({
      generatedArtifactFinalizer: finalizer,
      projectMixdownWorkerClient: new ProjectMixdownWorkerClient({
        renderTimeoutMs: 5_000,
      }),
      projectRootAuthority,
      selectProjectRoot: async () => rootPath,
    });
    const selection = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
      { method: 'POST' },
    );
    expect(selection.status).toBe(200);
    const source = createPcm16Wave();
    await writeFile(
      join(rootPath, 'renders', 'stable-audio-3', 'source-1.wav'),
      source,
    );

    const response = await postStemPrint(
      engine,
      createEnvelope({ plan: createPlan(source.byteLength) }),
    );
    const body = await response.json();
    const outputPath = join(rootPath, 'stem-prints', `${ARTIFACT_ID}.wav`);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      operationId: OPERATION_ID,
      protocolVersion: PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
      result: {
        artifact: {
          artifactId: ARTIFACT_ID,
          destination: 'stem-print',
          file: { relativePath: `stem-prints/${ARTIFACT_ID}.wav` },
          provenance: {
            planVersion: 1,
            rendererId: 'humstudio-pcm-mixdown',
            rendererVersion: '0.2.0',
            selectedTargets: [channelTarget('track-1')],
          },
        },
        status: 'COMPLETED',
        stemPrint: { frameCount: 1, targetCount: 1, trackCount: 1 },
      },
    });
    expect((await readFile(outputPath)).toString('ascii', 0, 4)).toBe('RIFF');
    expect(JSON.stringify(body)).not.toContain(rootPath);
    expect(body.result.artifact.provenance).not.toHaveProperty('plan');
    expect(body.result.artifact.provenance).not.toHaveProperty(
      'canonicalPlanJson',
    );
    expect(await readdir(join(rootPath, 'stem-prints'))).toEqual([
      `${ARTIFACT_ID}.wav`,
    ]);
  });

  it('recovers the same canonical operation once and rejects identity conflicts', async () => {
    const service = new ImmediateStemPrintService();
    const engine = await startTestEngine({ projectMixdownService: service });
    const first = await postStemPrint(engine, createEnvelope());
    const recovered = await postStemPrint(
      engine,
      createEnvelope({ plan: reorderPlanKeys(createPlan()) }),
    );
    const changed = structuredClone(createPlan());
    changed.mixerSnapshot.channels[0].inserts[0] = {
      ...changed.mixerSnapshot.channels[0].inserts[0],
      bypass: false,
    };
    const conflict = await postStemPrint(
      engine,
      createEnvelope({ plan: changed }),
    );

    expect(first.status).toBe(200);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual(await first.json());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'PROJECT_STEM_PRINT_OPERATION_CONFLICT',
    });
    expect(service.stemCalls).toBe(1);
  });

  it('shares one active lock with Raw Mixdown', async () => {
    const service = new BlockingStemPrintService();
    const engine = await startTestEngine({ projectMixdownService: service });
    const stemRequest = postStemPrint(engine, createEnvelope());
    await service.waitUntilStarted();
    const rawResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH,
      {
        body: JSON.stringify({
          operationId: RAW_OPERATION_ID,
          plan: createRawPlan(),
          protocolVersion: PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(rawResponse.status).toBe(409);
    await expect(rawResponse.json()).resolves.toMatchObject({
      code: 'PROJECT_MIXDOWN_BUSY',
    });
    service.complete();
    expect((await stemRequest).status).toBe(200);
  });

  it('aborts the exact Stem Print operation when its client disconnects', async () => {
    const service = new AbortAwareStemPrintService();
    const engine = await startTestEngine({ projectMixdownService: service });
    const socketRequest = beginStemSocketRequest(engine, createEnvelope());
    await service.waitUntilStarted();
    socketRequest.destroy();
    await service.waitUntilAborted();
    await waitForEngineActivity(engine, 'IDLE');

    expect(service.stemCalls).toBe(1);
    await socketRequest.completed;
  });

  it('recovers one unknown outcome without starting a replacement operation', async () => {
    const service = new FailingStemPrintService('STEM_PRINT_OUTCOME_UNKNOWN');
    const engine = await startTestEngine({ projectMixdownService: service });
    const first = await postStemPrint(engine, createEnvelope());
    const recovered = await postStemPrint(engine, createEnvelope());

    expect(first.status).toBe(409);
    expect(recovered.status).toBe(409);
    await expect(first.json()).resolves.toEqual({
      code: 'STEM_PRINT_OUTCOME_UNKNOWN',
      message: 'Project Stem Print outcome is unknown; recover with the same operationId.',
    });
    await expect(recovered.json()).resolves.toEqual({
      code: 'STEM_PRINT_OUTCOME_UNKNOWN',
      message: 'Project Stem Print outcome is unknown; recover with the same operationId.',
    });
    expect(service.stemCalls).toBe(1);
  });

  it('rejects a replacement operation while one Stem Print is active', async () => {
    const service = new BlockingStemPrintService();
    const engine = await startTestEngine({ projectMixdownService: service });
    const first = postStemPrint(engine, createEnvelope());
    await service.waitUntilStarted();
    const busy = await postStemPrint(
      engine,
      createEnvelope({ operationId: SECOND_OPERATION_ID }),
    );

    expect(busy.status).toBe(409);
    await expect(busy.json()).resolves.toMatchObject({
      code: 'PROJECT_STEM_PRINT_BUSY',
    });
    service.complete();
    expect((await first).status).toBe(200);
  });
});

class ImmediateStemPrintService {
  stemCalls = 0;

  async renderAndSave() {
    throw new Error('Raw Mixdown must not run in this fixture.');
  }

  async renderStemPrintAndSave(plan, { artifactId }) {
    this.stemCalls += 1;
    return createCompletedStemPrintResult(plan, artifactId);
  }
}

class BlockingStemPrintService extends ImmediateStemPrintService {
  #complete;
  #started;
  #waitForCompletion = new Promise((resolve) => { this.#complete = resolve; });
  #waitForStart = new Promise((resolve) => { this.#started = resolve; });

  async renderStemPrintAndSave(plan, options) {
    this.stemCalls += 1;
    this.#started();
    await this.#waitForCompletion;
    return createCompletedStemPrintResult(plan, options.artifactId);
  }

  complete() {
    this.#complete();
  }

  waitUntilStarted() {
    return this.#waitForStart;
  }
}

class AbortAwareStemPrintService extends ImmediateStemPrintService {
  #aborted;
  #started;
  #waitForAbort = new Promise((resolve) => {
    this.#aborted = resolve;
  });
  #waitForStart = new Promise((resolve) => {
    this.#started = resolve;
  });

  async renderStemPrintAndSave(_plan, { signal }) {
    this.stemCalls += 1;
    this.#started();
    if (!signal.aborted) {
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
    }
    this.#aborted();
    throw Object.assign(new Error('Private abort detail.'), {
      code: 'STEM_PRINT_ABORTED',
    });
  }

  waitUntilAborted() {
    return this.#waitForAbort;
  }

  waitUntilStarted() {
    return this.#waitForStart;
  }
}

class FailingStemPrintService extends ImmediateStemPrintService {
  #code;

  constructor(code) {
    super();
    this.#code = code;
  }

  async renderStemPrintAndSave() {
    this.stemCalls += 1;
    throw Object.assign(new Error('Private failure detail.'), { code: this.#code });
  }
}

function createCompletedStemPrintResult(plan, artifactId = ARTIFACT_ID) {
  const canonicalPlanJson = createCanonicalProjectRenderPlanJson(plan);
  const sizeBytes = 48;
  return {
    artifact: {
      artifactId,
      createdAt: '2026-08-13T00:00:00.000Z',
      destination: 'stem-print',
      file: {
        extension: '.wav',
        name: `${artifactId}.wav`,
        relativePath: `stem-prints/${artifactId}.wav`,
        sizeBytes,
      },
      kind: 'audio',
      provenance: {
        canonicalPlanJson,
        plan,
        planSha256: createHash('sha256').update(canonicalPlanJson).digest('hex'),
        planVersion: 1,
        rendererId: 'humstudio-pcm-mixdown',
        rendererVersion: '0.2.0',
        selectedTargets: plan.selectedTargets,
        sourceIds: plan.sources.map((source) => source.sourceId),
      },
    },
    status: 'COMPLETED',
    stemPrint: {
      bitsPerSample: 16,
      bytesWritten: sizeBytes,
      channels: 2,
      durationSeconds: 1 / SAMPLE_RATE,
      frameCount: 1,
      mimeType: 'audio/wav',
      sampleRate: SAMPLE_RATE,
      sourceCount: 1,
      targetCount: 1,
      trackCount: 1,
    },
  };
}

function createEnvelope({ operationId = OPERATION_ID, plan = createPlan() } = {}) {
  return {
    operationId,
    plan,
    protocolVersion: PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
  };
}

function createPlan(sourceSize = 46) {
  const track = {
    events: [{
      clipId: 'clip-1',
      clipName: 'Source Clip',
      durationSeconds: 1 / SAMPLE_RATE,
      sourceId: 'source-1',
      sourceStartSeconds: 0,
      startOffsetSeconds: 0,
      timelineEndTick: 1,
      timelineStartTick: 0,
    }],
    gainDb: 0,
    pan: 0,
    trackId: 'track-1',
  };
  return createTestStemPrintPlanV1({
    bpm: TEST_BPM,
    durationSeconds: 1 / SAMPLE_RATE,
    endTick: 1,
    selectedTargets: [channelTarget(track.trackId)],
    sources: [{
      kind: 'generated',
      name: 'source-1.wav',
      relativePath: 'renders/stable-audio-3/source-1.wav',
      sizeBytes: sourceSize,
      sourceId: 'source-1',
    }],
    tracks: [track],
  });
}

function createRawPlan(sourceSize = 46) {
  const stemPlan = createPlan(sourceSize);
  return createTestRawMixdownPlanV3({
    bpm: stemPlan.bpm,
    durationSeconds: stemPlan.durationSeconds,
    endTick: stemPlan.endTick,
    masterFaderDb: stemPlan.masterFaderDb,
    sources: stemPlan.sources,
    tracks: stemPlan.tracks,
  });
}

function channelTarget(trackId) {
  return { kind: 'channel', resolvedTrackId: trackId, trackId };
}

function reorderPlanKeys(plan) {
  return Object.fromEntries(Object.entries(plan).reverse());
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

function postStemPrint(engine, envelope) {
  return authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_STEM_PRINTS_PATH, {
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

function beginStemSocketRequest(engine, envelope) {
  const url = new URL(LOCAL_ENGINE_PROJECT_STEM_PRINTS_PATH, engine.baseUrl);
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

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-stem-print-api-'));
  temporaryDirectories.add(directory);
  return directory;
}
