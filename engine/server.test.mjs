import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startLocalEngineServer } from './server.mjs';
import { GeneratedArtifactFinalizer } from './generatedArtifactFinalizer.mjs';
import { AceStepJobExecutor } from './jobs/aceStepJobExecutor.mjs';
import { GpuJobQueueError } from './jobs/gpuJobQueue.mjs';
import { StableAudio3JobExecutor } from './jobs/stableAudio3JobExecutor.mjs';
import { ProjectRootAuthority } from './projectRootAuthority.mjs';
import {
  LOCAL_ENGINE_ACE_STEP_LYRICS_PATH,
  LOCAL_ENGINE_AUDIO_FILES_PATH,
  LOCAL_ENGINE_BASIC_PITCH_RUNTIME_PATH,
  LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH,
  LOCAL_ENGINE_GENERATED_AUDIO_PATH,
  LOCAL_ENGINE_HEALTH_PATH,
  LOCAL_ENGINE_JOBS_PATH,
  LOCAL_ENGINE_PROJECT_FILE_PATH,
  LOCAL_ENGINE_PROJECT_ROOT_PATH,
  LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
  LOCAL_ENGINE_PROTOCOL_VERSION,
  LOCAL_ENGINE_RECORDINGS_PATH,
  LOCAL_ENGINE_SOUNDFONT_AUDITION_PATH,
  LOCAL_ENGINE_SOUNDFONT_LIVE_PREVIEW_PATH,
  LOCAL_ENGINE_SOUNDFONT_PRESETS_PATH,
  LOCAL_ENGINE_SOUNDFONTS_PATH,
  LOCAL_ENGINE_SOURCE_RESTORE_PATH,
  LOCAL_ENGINE_TOKEN_HEADER,
  LOCAL_ENGINE_VERSION,
} from '../shared/localEngineProtocol.js';
import {
  ACE_STEP_CHANNELS,
  ACE_STEP_MODEL_ID,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_SAMPLE_RATE,
  ACE_STEP_TASK_ID,
} from '../shared/aceStepProtocol.js';
import {
  STABLE_AUDIO_3_CHANNELS,
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_OUTPUT_DESTINATION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_SAMPLE_RATE,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const launchToken = 'test-launch-token-that-is-at-least-32-characters';
const runningEngines = new Set();
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all([...runningEngines].map((engine) => engine.close()));
  runningEngines.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('Local Engine Health Check', () => {
  it('serves an authenticated versioned Health response on loopback', async () => {
    const engine = await startTestEngine();
    const response = await fetch(`${engine.baseUrl}${LOCAL_ENGINE_HEALTH_PATH}`, {
      headers: {
        Origin: allowedOrigin,
        [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(allowedOrigin);
    expect(body).toMatchObject({
      activity: 'IDLE',
      engineVersion: LOCAL_ENGINE_VERSION,
      instanceId: engine.instanceId,
      lifecycle: 'READY',
      protocolVersion: LOCAL_ENGINE_PROTOCOL_VERSION,
    });
    expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false);
  });

  it('serves the Engine-inspected Basic Pitch Runtime state without enqueueing a Job', async () => {
    const basicPitchRuntimeInspector = {
      inspect: vi.fn(async () => ({
        modelId: 'basic-pitch-icassp-2022',
        modelRevision: '0.4.0-onnx',
        profileId: 'windows-x64-python-3-10-onnx-cpu',
        providerVersion: '0.4.0',
        status: 'READY',
      })),
      shutdown: vi.fn(async () => undefined),
    };
    const engine = await startTestEngine({ basicPitchRuntimeInspector });
    const response = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_BASIC_PITCH_RUNTIME_PATH,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runtime: { status: 'READY' },
    });
    expect(basicPitchRuntimeInspector.inspect).toHaveBeenCalledOnce();
  });

  it('rejects requests without the per-launch token', async () => {
    const engine = await startTestEngine();
    const response = await fetch(`${engine.baseUrl}${LOCAL_ENGINE_HEALTH_PATH}`, {
      headers: { Origin: allowedOrigin },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects a browser request from an unapproved UI origin', async () => {
    const engine = await startTestEngine();
    const response = await fetch(`${engine.baseUrl}${LOCAL_ENGINE_HEALTH_PATH}`, {
      headers: {
        Origin: 'http://127.0.0.1:9999',
        [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
      },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(await response.json()).toMatchObject({ code: 'ORIGIN_REJECTED' });
  });

  it('supports an origin-validated CORS preflight without exposing the token', async () => {
    const engine = await startTestEngine();
    const response = await fetch(`${engine.baseUrl}${LOCAL_ENGINE_HEALTH_PATH}`, {
      headers: {
        'Access-Control-Request-Headers': LOCAL_ENGINE_TOKEN_HEADER,
        'Access-Control-Request-Method': 'GET',
        Origin: allowedOrigin,
      },
      method: 'OPTIONS',
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(allowedOrigin);
    expect(response.headers.get('access-control-allow-headers')).toBe(
      `Content-Type, ${LOCAL_ENGINE_TOKEN_HEADER}`,
    );
    expect(response.headers.get('access-control-allow-methods')).toBe(
      'DELETE, GET, POST, PUT, OPTIONS',
    );
    expect(await response.text()).toBe('');
  });

  it('selects and prepares Project Root through Engine-owned file authority', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    const initialResponse = await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_PATH);

    expect(initialResponse.status).toBe(200);
    expect(await initialResponse.json()).toEqual({ status: 'UNSET' });

    const selectResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
      { method: 'POST' },
    );
    const selectedRoot = await selectResponse.json();

    expect(selectResponse.status).toBe(200);
    expect(selectedRoot).toMatchObject({
      rootPath: await realpath(selectedPath),
      selection: 'SELECTED',
      status: 'READY',
    });
    await expect(stat(join(selectedPath, 'renders', 'stable-audio-3'))).resolves.toMatchObject({});
    await expect(stat(join(selectedPath, 'soundfonts'))).resolves.toMatchObject({});

    const currentResponse = await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_PATH);
    await expect(currentResponse.json()).resolves.toMatchObject({
      rootPath: await realpath(selectedPath),
      status: 'READY',
    });
  });

  it('lists supported Project SoundFonts only after Project Root is ready', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    const rootRequiredResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_SOUNDFONTS_PATH,
    );

    expect(rootRequiredResponse.status).toBe(409);
    await expect(rootRequiredResponse.json()).resolves.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });

    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, { method: 'POST' });
    await writeFile(join(selectedPath, 'soundfonts', 'Keys.sf2'), 'sf2');
    await writeFile(join(selectedPath, 'soundfonts', 'Pad.SF3'), 'sf3');
    await writeFile(join(selectedPath, 'soundfonts', 'notes.txt'), 'ignored');
    const listResponse = await authenticatedRequest(engine, LOCAL_ENGINE_SOUNDFONTS_PATH);
    const catalog = await listResponse.json();

    expect(listResponse.status).toBe(200);
    expect(catalog).toMatchObject({
      directory: 'soundfonts',
      resources: [
        { format: 'sf2', relativePath: 'soundfonts/Keys.sf2' },
        { format: 'sf3', relativePath: 'soundfonts/Pad.SF3' },
      ],
      supportedFormats: ['sf2', 'sf3'],
    });
    expect(JSON.stringify(catalog)).not.toContain(selectedPath);

    const methodResponse = await authenticatedRequest(engine, LOCAL_ENGINE_SOUNDFONTS_PATH, {
      method: 'POST',
    });
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get('allow')).toBe('GET, OPTIONS');
  });

  it('returns temporary SoundFont audition WAV without registering Project data', async () => {
    const wav = createPcmWav();
    const renderedRequests = [];
    const soundFontAuditionService = {
      render: async (request) => {
        renderedRequests.push(request);
        return {
          bytes: wav,
          contentLength: wav.length,
          contentType: 'audio/wav',
        };
      },
      shutdown: async () => undefined,
    };
    const engine = await startTestEngine({ soundFontAuditionService });
    const request = {
      bank: 0,
      midi: {
        bpm: 120,
        notes: [
          {
            id: 'note-1',
            lengthTicks: 960,
            pitch: 60,
            startTick: 0,
            velocity: 100,
          },
        ],
        ticksPerQuarter: 960,
      },
      program: 0,
      soundFont: {
        format: 'sf2',
        relativePath: 'soundfonts/Keys.sf2',
        resourceId: `soundfont-${'a'.repeat(32)}`,
        revisionToken: 'b'.repeat(64),
      },
    };
    const response = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_SOUNDFONT_AUDITION_PATH,
      {
        body: JSON.stringify(request),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(wav);
    expect(renderedRequests).toEqual([request]);

    const methodResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_SOUNDFONT_AUDITION_PATH,
    );
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get('allow')).toBe('POST, OPTIONS');
  });

  it('treats a canceled Project Root picker as a non-destructive result', async () => {
    const engine = await startTestEngine({ selectProjectRoot: async () => undefined });
    const response = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ selection: 'CANCELED', status: 'UNSET' });
  });

  it('saves Project JSON atomically only after a Project Root is ready', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    const projectFile = createProjectFile();
    const unauthenticatedResponse = await fetch(
      `${engine.baseUrl}${LOCAL_ENGINE_PROJECT_FILE_PATH}`,
      { headers: { Origin: allowedOrigin } },
    );
    const readRootRequiredResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_FILE_PATH,
    );
    const rootRequiredResponse = await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_FILE_PATH, {
      body: JSON.stringify(projectFile),
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
    });

    expect(unauthenticatedResponse.status).toBe(401);
    expect(readRootRequiredResponse.status).toBe(409);
    expect(rootRequiredResponse.status).toBe(409);
    await expect(rootRequiredResponse.json()).resolves.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });

    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, { method: 'POST' });
    const missingResponse = await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_FILE_PATH);

    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toMatchObject({
      code: 'PROJECT_FILE_NOT_FOUND',
    });

    const saveResponse = await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_FILE_PATH, {
      body: JSON.stringify(projectFile),
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
    });
    const savedProject = await saveResponse.json();

    expect(saveResponse.status).toBe(200);
    expect(savedProject).toMatchObject({
      projectFileName: `${join(selectedPath).split(/[\\/]/).pop()}.humstudio.json`,
      savedAt: projectFile.savedAt,
      status: 'SAVED',
    });
    await expect(readFile(savedProject.projectFilePath, 'utf8')).resolves.toBe(
      `${JSON.stringify(projectFile, null, 2)}\n`,
    );

    const loadResponse = await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_FILE_PATH);
    const loadedProject = await loadResponse.json();

    expect(loadResponse.status).toBe(200);
    expect(loadedProject).toMatchObject({
      bytesRead: Buffer.byteLength(`${JSON.stringify(projectFile, null, 2)}\n`, 'utf8'),
      projectFile,
      projectFileName: savedProject.projectFileName,
      projectFilePath: savedProject.projectFilePath,
      savedAt: projectFile.savedAt,
      status: 'LOADED',
    });

    const methodResponse = await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_FILE_PATH, {
      method: 'POST',
    });
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get('allow')).toBe('GET, PUT, OPTIONS');
  });

  it('rejects malformed Project save requests without creating a Project file', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, { method: 'POST' });
    const response = await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_FILE_PATH, {
      body: JSON.stringify({ app: 'AnotherApp' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'PROJECT_FILE_INVALID' });
  });

  it('rejects malformed Project JSON read from the active Root', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    const selectionResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
      { method: 'POST' },
    );
    const projectRoot = await selectionResponse.json();

    await writeFile(
      join(projectRoot.rootPath, projectRoot.projectFileName),
      '{broken',
      'utf8',
    );
    const response = await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_FILE_PATH);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'PROJECT_FILE_INVALID' });
  });

  it('saves one immutable ACE-Step Lyrics snapshot under the Project Root', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({
      selectProjectRoot: async () => selectedPath,
    });
    const lyrics = '[Verse]\nMorning light across the room\nA quiet pulse becomes a tune\n';
    const rootRequiredResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_ACE_STEP_LYRICS_PATH,
      {
        body: JSON.stringify({ lyrics }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(rootRequiredResponse.status).toBe(409);
    await expect(rootRequiredResponse.json()).resolves.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });

    await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
      { method: 'POST' },
    );
    const saveResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_ACE_STEP_LYRICS_PATH,
      {
        body: JSON.stringify({ lyrics }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    const snapshot = await saveResponse.json();
    const lyricsBytes = Buffer.from(lyrics, 'utf8');

    expect(saveResponse.status).toBe(201);
    expect(snapshot).toMatchObject({
      destination: 'ace-step-lyrics',
      file: {
        extension: '.txt',
        relativePath: expect.stringMatching(
          /^renders\/ace-step\/lyrics\/artifact-[0-9a-f-]+\.txt$/,
        ),
        sizeBytes: lyricsBytes.length,
      },
      kind: 'lyrics',
      sha256: createHash('sha256').update(lyricsBytes).digest('hex'),
      status: 'FINALIZED',
    });
    await expect(
      readFile(join(selectedPath, ...snapshot.file.relativePath.split('/'))),
    ).resolves.toEqual(lyricsBytes);
    await expect(
      readdir(join(selectedPath, 'renders', 'ace-step', 'lyrics')),
    ).resolves.toEqual([snapshot.file.name]);
  });

  it('routes one verified SoundFont preset catalog request', async () => {
    const calls = [];
    const soundFontPresetCatalogService = {
      list: async (request) => {
        calls.push(request);
        return {
          presets: [{ bank: 0, name: 'Grand Piano', program: 0 }],
          resourceId: request.soundFont.resourceId,
          revisionToken: request.soundFont.revisionToken,
        };
      },
    };
    const engine = await startTestEngine({ soundFontPresetCatalogService });
    const request = {
      soundFont: {
        format: 'sf3',
        library: 'builtin',
        relativePath: 'soundfonts/HumStudio Default/MuseScore_General.sf3',
        resourceId: `soundfont-${'a'.repeat(32)}`,
        revisionToken: 'b'.repeat(64),
      },
    };
    const response = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_SOUNDFONT_PRESETS_PATH,
      {
        body: JSON.stringify(request),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      presets: [{ bank: 0, name: 'Grand Piano', program: 0 }],
      resourceId: request.soundFont.resourceId,
      revisionToken: request.soundFont.revisionToken,
    });
    expect(calls).toEqual([request]);

    const methodResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_SOUNDFONT_PRESETS_PATH,
    );
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get('allow')).toBe('POST, OPTIONS');
  });

  it('routes prepare, trigger, and stop commands to SoundFont Live Preview', async () => {
    const calls = [];
    const sessionId = '12345678-1234-4abc-8def-1234567890ab';
    const soundFontLivePreviewService = {
      prepare: async (request) => {
        calls.push(request);
        return {
          bank: request.bank,
          program: request.program,
          resourceId: request.soundFont.resourceId,
          sessionId,
          status: 'READY',
        };
      },
      shutdown: async () => undefined,
      stop: async (request) => {
        calls.push(request);
        return { status: 'STOPPED' };
      },
      trigger: (request) => {
        calls.push(request);
        return { pitch: request.pitch, sessionId, status: 'TRIGGERED' };
      },
    };
    const engine = await startTestEngine({ soundFontLivePreviewService });
    const soundFont = {
      format: 'sf3',
      library: 'builtin',
      relativePath: 'soundfonts/HumStudio Default/MuseScore_General.sf3',
      resourceId: `soundfont-${'a'.repeat(32)}`,
      revisionToken: 'b'.repeat(64),
    };
    const requests = [
      { action: 'prepare', bank: 0, program: 0, soundFont },
      { action: 'trigger', durationMs: 320, pitch: 60, sessionId, velocity: 100 },
      { action: 'stop', sessionId },
    ];

    for (const request of requests) {
      const response = await authenticatedRequest(
        engine,
        LOCAL_ENGINE_SOUNDFONT_LIVE_PREVIEW_PATH,
        {
          body: JSON.stringify(request),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      expect(response.status).toBe(200);
    }

    expect(calls).toEqual(requests);
  });

  it('rejects invalid ACE-Step Lyrics requests without retaining a snapshot', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({
      selectProjectRoot: async () => selectedPath,
    });
    await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
      { method: 'POST' },
    );
    const wrongTypeResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_ACE_STEP_LYRICS_PATH,
      {
        body: JSON.stringify({ lyrics: '[Verse]\nHello' }),
        headers: { 'Content-Type': 'text/plain' },
        method: 'POST',
      },
    );
    const invalidResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_ACE_STEP_LYRICS_PATH,
      {
        body: JSON.stringify({ lyrics: '   ', extra: true }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(wrongTypeResponse.status).toBe(415);
    await expect(wrongTypeResponse.json()).resolves.toMatchObject({
      code: 'ACE_STEP_LYRICS_CONTENT_TYPE_REQUIRED',
    });
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      code: 'ACE_STEP_LYRICS_INVALID',
    });
    await expect(
      readdir(join(selectedPath, 'renders', 'ace-step', 'lyrics')),
    ).resolves.toEqual([]);
  });

  it('saves a validated recording WAV under the Engine-owned Project Root', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    const wav = createPcmWav({ durationSeconds: 0.25, sampleRate: 8_000 });
    const rootRequiredResponse = await authenticatedRequest(engine, LOCAL_ENGINE_RECORDINGS_PATH, {
      body: wav,
      headers: { 'Content-Type': 'audio/wav' },
      method: 'POST',
    });

    expect(rootRequiredResponse.status).toBe(409);
    await expect(rootRequiredResponse.json()).resolves.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });

    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, { method: 'POST' });
    const saveResponse = await authenticatedRequest(engine, LOCAL_ENGINE_RECORDINGS_PATH, {
      body: wav,
      headers: { 'Content-Type': 'audio/wav' },
      method: 'POST',
    });
    const recording = await saveResponse.json();

    expect(saveResponse.status).toBe(201);
    expect(recording).toMatchObject({
      audio: {
        bitsPerSample: 16,
        channels: 1,
        durationSeconds: 0.25,
        mimeType: 'audio/wav',
        sampleRate: 8_000,
      },
      destination: 'recording',
      file: {
        extension: '.wav',
        relativePath: expect.stringMatching(/^recordings\/artifact-[0-9a-f-]+\.wav$/),
        sizeBytes: wav.length,
      },
      kind: 'audio',
      status: 'FINALIZED',
    });
    await expect(
      readFile(join(selectedPath, ...recording.file.relativePath.split('/'))),
    ).resolves.toEqual(wav);
    expect(
      (await readdir(join(selectedPath, 'recordings'))).some((name) =>
        name.endsWith('.partial'),
      ),
    ).toBe(false);
  });

  it('rejects invalid recording content without leaving a Project file', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, { method: 'POST' });
    const wrongTypeResponse = await authenticatedRequest(engine, LOCAL_ENGINE_RECORDINGS_PATH, {
      body: createPcmWav(),
      headers: { 'Content-Type': 'application/octet-stream' },
      method: 'POST',
    });
    const invalidWavResponse = await authenticatedRequest(engine, LOCAL_ENGINE_RECORDINGS_PATH, {
      body: Buffer.from('not a WAV'),
      headers: { 'Content-Type': 'audio/wav' },
      method: 'POST',
    });

    expect(wrongTypeResponse.status).toBe(415);
    await expect(wrongTypeResponse.json()).resolves.toMatchObject({
      code: 'RECORDING_CONTENT_TYPE_REQUIRED',
    });
    expect(invalidWavResponse.status).toBe(400);
    await expect(invalidWavResponse.json()).resolves.toMatchObject({
      code: 'RECORDING_INVALID',
    });
    await expect(readdir(join(selectedPath, 'recordings'))).resolves.toEqual([]);
  });

  it('restores generated and external source availability through the authenticated protocol', async () => {
    const selectedPath = await createTemporaryDirectory();
    const externalDirectory = await createTemporaryDirectory();
    const generatedPath = join(selectedPath, 'recordings', 'source-generated.wav');
    const externalPath = join(externalDirectory, 'external.wav');
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, { method: 'POST' });
    await writeFile(generatedPath, 'generated audio', 'utf8');
    await writeFile(externalPath, 'external audio', 'utf8');
    const generatedStat = await stat(generatedPath);
    const response = await authenticatedRequest(engine, LOCAL_ENGINE_SOURCE_RESTORE_PATH, {
      body: JSON.stringify({
        sources: [
          {
            kind: 'generated',
            lastModified: Math.round(generatedStat.mtimeMs),
            name: 'source-generated.wav',
            relativePath: 'recordings/source-generated.wav',
            sizeBytes: generatedStat.size,
            sourceId: 'source-generated',
          },
          { kind: 'external', path: externalPath, sourceId: 'source-external' },
          {
            kind: 'generated',
            name: 'source-missing.wav',
            relativePath: 'recordings/source-missing.wav',
            sourceId: 'source-missing',
          },
        ],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.availability).toEqual({
      'source-external': 'available',
      'source-generated': 'available',
      'source-missing': 'missing',
    });
    expect(body.sources).toEqual([
      expect.objectContaining({ sourceId: 'source-generated', state: 'available' }),
      expect.objectContaining({ sourceId: 'source-external', state: 'available' }),
      expect.objectContaining({ sourceId: 'source-missing', state: 'missing' }),
    ]);
  });

  it('rejects malformed source restoration requests before filesystem inspection', async () => {
    const engine = await startTestEngine();
    const response = await authenticatedRequest(engine, LOCAL_ENGINE_SOURCE_RESTORE_PATH, {
      body: JSON.stringify({
        sources: [
          {
            kind: 'generated',
            relativePath: '../outside.wav',
            sourceId: 'source-invalid',
          },
        ],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'SOURCE_RESTORE_INVALID' });
  });

  it('returns authenticated generated WAV bytes without exposing the Project path', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    const wav = createPcmWav();
    const source = {
      kind: 'generated',
      name: 'artifact-instrument-a.wav',
      relativePath: 'renders/instruments/artifact-instrument-a.wav',
      sizeBytes: wav.length,
      sourceId: 'artifact-instrument-a',
    };
    const rootRequiredResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_PATH,
      {
        body: JSON.stringify({ source }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(rootRequiredResponse.status).toBe(409);
    await expect(rootRequiredResponse.json()).resolves.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });

    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, {
      method: 'POST',
    });
    await writeFile(
      join(selectedPath, ...source.relativePath.split('/')),
      wav,
    );
    const unauthorizedResponse = await fetch(
      `${engine.baseUrl}${LOCAL_ENGINE_GENERATED_AUDIO_PATH}`,
      {
        body: JSON.stringify({ source }),
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
        },
        method: 'POST',
      },
    );
    const response = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_PATH,
      {
        body: JSON.stringify({ source }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(unauthorizedResponse.status).toBe(401);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('content-length')).toBe(String(wav.length));
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...response.headers.values()].join('\n')).not.toContain(selectedPath);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(wav);
  });

  it('rejects invalid generated audio methods, bodies, paths, and file metadata', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    const methodResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_PATH,
    );
    const contentTypeResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_PATH,
      {
        body: '{}',
        headers: { 'Content-Type': 'text/plain' },
        method: 'POST',
      },
    );
    const bodyResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_PATH,
      {
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(methodResponse.status).toBe(405);
    expect(contentTypeResponse.status).toBe(415);
    expect(bodyResponse.status).toBe(400);

    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, {
      method: 'POST',
    });
    const wav = createPcmWav();
    const missingSource = {
      kind: 'generated',
      name: 'artifact-missing.wav',
      relativePath: 'renders/instruments/artifact-missing.wav',
      sizeBytes: wav.length,
      sourceId: 'artifact-missing',
    };
    const traversalResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_PATH,
      {
        body: JSON.stringify({
          source: {
            ...missingSource,
            relativePath: 'renders/instruments/../artifact-missing.wav',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    const missingResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_PATH,
      {
        body: JSON.stringify({ source: missingSource }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    const identityMismatchResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_PATH,
      {
        body: JSON.stringify({
          source: {
            ...missingSource,
            sourceId: 'artifact-decoy',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    await writeFile(
      join(selectedPath, 'renders', 'instruments', 'artifact-mismatch.wav'),
      wav,
    );
    const mismatchResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_PATH,
      {
        body: JSON.stringify({
          source: {
            ...missingSource,
            name: 'artifact-mismatch.wav',
            relativePath: 'renders/instruments/artifact-mismatch.wav',
            sizeBytes: wav.length + 1,
            sourceId: 'artifact-mismatch',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(traversalResponse.status).toBe(400);
    await expect(traversalResponse.json()).resolves.toMatchObject({
      code: 'GENERATED_AUDIO_REQUEST_INVALID',
    });
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toMatchObject({
      code: 'GENERATED_AUDIO_NOT_FOUND',
    });
    expect(identityMismatchResponse.status).toBe(400);
    await expect(identityMismatchResponse.json()).resolves.toMatchObject({
      code: 'GENERATED_AUDIO_REQUEST_INVALID',
    });
    expect(mismatchResponse.status).toBe(409);
    await expect(mismatchResponse.json()).resolves.toMatchObject({
      code: 'GENERATED_AUDIO_METADATA_MISMATCH',
    });
  });

  it('returns only authenticated and verified generated WAV availability', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    const wav = createPcmWav();
    const availableSource = {
      kind: 'generated',
      name: 'artifact-available.wav',
      relativePath: 'renders/instruments/artifact-available.wav',
      sizeBytes: wav.length,
      sourceId: 'artifact-available',
    };
    const missingSource = {
      ...availableSource,
      name: 'artifact-missing.wav',
      relativePath: 'renders/instruments/artifact-missing.wav',
      sourceId: 'artifact-missing',
    };
    const invalidSource = {
      ...availableSource,
      name: 'artifact-invalid.wav',
      relativePath: 'renders/instruments/artifact-invalid.wav',
      sourceId: 'artifact-invalid',
    };
    const rootRequiredResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH,
      {
        body: JSON.stringify({ sources: [] }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(rootRequiredResponse.status).toBe(409);
    await expect(rootRequiredResponse.json()).resolves.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });

    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, {
      method: 'POST',
    });
    await writeFile(
      join(selectedPath, ...availableSource.relativePath.split('/')),
      wav,
    );
    await writeFile(
      join(selectedPath, ...invalidSource.relativePath.split('/')),
      Buffer.alloc(wav.length),
    );

    const unauthorizedResponse = await fetch(
      `${engine.baseUrl}${LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH}`,
      {
        body: JSON.stringify({
          sources: [availableSource, missingSource, invalidSource],
        }),
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
        },
        method: 'POST',
      },
    );
    const response = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH,
      {
        body: JSON.stringify({
          sources: [missingSource, availableSource, invalidSource],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(unauthorizedResponse.status).toBe(401);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    const responseText = await response.text();
    expect(responseText).not.toContain(selectedPath);
    expect(JSON.parse(responseText)).toEqual({
      availableSourceIds: ['artifact-available'],
    });
  });

  it('rejects invalid generated WAV availability requests', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, {
      method: 'POST',
    });
    const source = {
      kind: 'generated',
      name: 'artifact-duplicate.wav',
      relativePath: 'renders/instruments/artifact-duplicate.wav',
      sizeBytes: createPcmWav().length,
      sourceId: 'artifact-duplicate',
    };
    const methodResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH,
    );
    const contentTypeResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH,
      {
        body: '{}',
        headers: { 'Content-Type': 'text/plain' },
        method: 'POST',
      },
    );
    const bodyResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH,
      {
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    const duplicateResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH,
      {
        body: JSON.stringify({ sources: [source, { ...source }] }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(methodResponse.status).toBe(405);
    expect(contentTypeResponse.status).toBe(415);
    expect(bodyResponse.status).toBe(400);
    expect(duplicateResponse.status).toBe(400);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      code: 'GENERATED_AUDIO_REQUEST_INVALID',
    });
  });

  it('authenticates, enqueues, and completes a Mock Provider Job through the versioned API', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    const unauthorizedResponse = await fetch(`${engine.baseUrl}${LOCAL_ENGINE_JOBS_PATH}`);
    const rootRequiredResponse = await authenticatedRequest(engine, LOCAL_ENGINE_JOBS_PATH, {
      body: JSON.stringify({ request: createMockJobRequest() }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(unauthorizedResponse.status).toBe(401);
    expect(rootRequiredResponse.status).toBe(409);
    await expect(rootRequiredResponse.json()).resolves.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });

    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, { method: 'POST' });
    const invalidResponse = await authenticatedRequest(engine, LOCAL_ENGINE_JOBS_PATH, {
      body: JSON.stringify({
        request: { ...createMockJobRequest(), providerId: 'unknown-provider' },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const enqueueResponse = await authenticatedRequest(engine, LOCAL_ENGINE_JOBS_PATH, {
      body: JSON.stringify({ request: createMockJobRequest() }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const enqueued = await enqueueResponse.json();

    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({ code: 'JOB_REQUEST_INVALID' });
    expect(enqueueResponse.status).toBe(202);
    expect(enqueued.job).toMatchObject({
      providerId: 'mock-provider',
      state: 'QUEUED',
      taskId: 'mock-audio-generation',
    });

    const completed = await waitForJobState(engine, enqueued.job.jobId, 'COMPLETED');
    const relativePath = completed.result.artifact.file.relativePath;

    await expect(access(join(selectedPath, ...relativePath.split('/')))).resolves.toBeUndefined();
    await expect(readdir(join(selectedPath, 'renders', 'instruments'))).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.partial$/)]),
    );
  });

  it('rejects invalid Stable Audio 3 transport before Queue allocation', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({
      selectProjectRoot: async () => selectedPath,
    });

    await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
      { method: 'POST' },
    );
    const response = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_JOBS_PATH,
      {
        body: JSON.stringify({
          request: {
            ...createStableAudio3JobRequest(),
            modelRevision: 'invalid-revision',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: 'JOB_REQUEST_INVALID',
      message:
        'Stable Audio 3 Queue request uses an unsupported Provider, Model, revision, or Task.',
    });

    const snapshotResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_JOBS_PATH,
    );
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      jobs: [],
    });
  });

  it('rejects invalid ACE-Step transport before Queue allocation', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({
      selectProjectRoot: async () => selectedPath,
    });
    await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
      { method: 'POST' },
    );
    const response = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_JOBS_PATH,
      {
        body: JSON.stringify({
          request: {
            ...createAceStepJobRequest(),
            modelRevision: 'invalid-revision',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    const responseBody = await response.json();
    expect({ body: responseBody, status: response.status }).toEqual({
      body: {
        code: 'JOB_REQUEST_INVALID',
        message:
          'ACE-Step Queue request uses an unsupported Provider, Model, revision, or Task.',
      },
      status: 400,
    });

    const snapshotResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_JOBS_PATH,
    );
    await expect(snapshotResponse.json()).resolves.toMatchObject({ jobs: [] });

    const validRequest = createAceStepJobRequest();
    const nestedShapeResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_JOBS_PATH,
      {
        body: JSON.stringify({
          request: {
            ...validRequest,
            guideSource: {
              ...validRequest.guideSource,
              unexpected: true,
            },
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    expect(nestedShapeResponse.status).toBe(400);
    await expect(nestedShapeResponse.json()).resolves.toMatchObject({
      code: 'JOB_REQUEST_INVALID',
    });
    const finalSnapshotResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_JOBS_PATH,
    );
    await expect(finalSnapshotResponse.json()).resolves.toMatchObject({ jobs: [] });
  });

  it('rejects a decoy generated source ID through the authenticated restoration route', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, { method: 'POST' });
    const canonicalPath = join(selectedPath, 'recordings', 'artifact-real.wav');
    await writeFile(canonicalPath, 'generated audio', 'utf8');
    const canonicalStat = await stat(canonicalPath);
    const response = await authenticatedRequest(engine, LOCAL_ENGINE_SOURCE_RESTORE_PATH, {
      body: JSON.stringify({
        sources: [
          {
            kind: 'generated',
            name: 'artifact-real.wav',
            relativePath: 'recordings/artifact-real.wav',
            sizeBytes: canonicalStat.size,
            sourceId: 'artifact-decoy',
          },
        ],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'SOURCE_RESTORE_INVALID' });
  });

  it('authenticates, routes, and completes Stable Audio 3 through the versioned API', async () => {
    const workerClient = new SuccessfulStableAudio3WorkerClient();
    const { engine, selectedPath } = await startReadyStableAudio3Engine(workerClient);
    const enqueueResponse = await authenticatedRequest(engine, LOCAL_ENGINE_JOBS_PATH, {
      body: JSON.stringify({ request: createStableAudio3JobRequest() }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const enqueued = await enqueueResponse.json();

    expect(enqueueResponse.status).toBe(202);
    expect(enqueued.job).toMatchObject({
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      state: 'QUEUED',
      taskId: STABLE_AUDIO_3_TASK_ID,
    });

    const completed = await waitForJobState(engine, enqueued.job.jobId, 'COMPLETED');
    const relativePath = completed.result.artifact.file.relativePath;

    expect(completed).toMatchObject({
      result: {
        artifact: {
          destination: STABLE_AUDIO_3_OUTPUT_DESTINATION,
          lineage: {
            parentArtifactIds: ['artifact-instrument-a'],
            parentClipTakeIds: ['clip-take-instrument-a'],
          },
        },
        generation: {
          channels: STABLE_AUDIO_3_CHANNELS,
          durationSeconds: 0.1,
          mimeType: 'audio/wav',
        },
      },
      state: 'COMPLETED',
    });
    await expect(access(join(selectedPath, ...relativePath.split('/')))).resolves.toBeUndefined();
    await expect(readdir(join(selectedPath, 'renders', 'stable-audio-3'))).resolves.toEqual([
      completed.result.artifact.file.name,
    ]);
    expect(workerClient.calls).toEqual([
      'start',
      `load:${STABLE_AUDIO_3_MODEL_ID}@${STABLE_AUDIO_3_MODEL_REVISION}`,
      'execute',
      'unload',
      'close',
    ]);
  });

  it('authenticates, routes, and completes ACE-Step through the versioned API', async () => {
    const workerClient = new SuccessfulAceStepWorkerClient();
    const { engine, selectedPath } = await startReadyAceStepEngine(workerClient);
    const enqueueResponse = await authenticatedRequest(engine, LOCAL_ENGINE_JOBS_PATH, {
      body: JSON.stringify({ request: createAceStepJobRequest() }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const enqueued = await enqueueResponse.json();

    expect(enqueueResponse.status).toBe(202);
    expect(enqueued.job).toMatchObject({
      modelRevision: ACE_STEP_MODEL_REVISION,
      providerId: ACE_STEP_PROVIDER_ID,
      state: 'QUEUED',
      taskId: ACE_STEP_TASK_ID,
    });

    const completed = await waitForJobState(engine, enqueued.job.jobId, 'COMPLETED');
    const relativePath = completed.result.artifact.file.relativePath;

    expect(completed).toMatchObject({
      result: {
        artifact: {
          destination: ACE_STEP_OUTPUT_DESTINATION,
          lineage: {
            parentArtifactIds: ['artifact-guide-a', 'artifact-lyrics-a'],
            parentClipTakeIds: ['clip-take-midi-a'],
          },
        },
        generation: {
          channels: ACE_STEP_CHANNELS,
          durationSeconds: 10,
          evidence: {
            guideAudioArtifactId: 'artifact-guide-a',
            lyricsArtifactId: 'artifact-lyrics-a',
            outputEncoding: 'PCM16',
          },
          mimeType: 'audio/wav',
        },
      },
      state: 'COMPLETED',
    });
    await expect(access(join(selectedPath, ...relativePath.split('/')))).resolves.toBeUndefined();
    const aceStepEntries = await readdir(join(selectedPath, 'renders', 'ace-step'));
    expect(aceStepEntries).toEqual(
      expect.arrayContaining(['lyrics', completed.result.artifact.file.name]),
    );
    expect(workerClient.calls).toEqual([
      'start',
      `load:${ACE_STEP_MODEL_ID}@${ACE_STEP_MODEL_REVISION}`,
      'execute',
      'unload',
      'close',
    ]);
  });

  it('reports Stable Audio 3 Worker failures without retaining staging files', async () => {
    const workerClient = new FailingStableAudio3WorkerClient();
    const { engine, finalizer, selectedPath } = await startReadyStableAudio3Engine(workerClient);
    const enqueueResponse = await authenticatedRequest(engine, LOCAL_ENGINE_JOBS_PATH, {
      body: JSON.stringify({ request: createStableAudio3JobRequest() }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const enqueued = await enqueueResponse.json();
    const failed = await waitForJobState(engine, enqueued.job.jobId, 'FAILED');

    expect(enqueueResponse.status).toBe(202);
    expect(failed).toMatchObject({
      error: { code: 'STABLE_AUDIO_3_INFERENCE_FAILED' },
      state: 'FAILED',
    });
    expect(workerClient.terminateCalls).toBe(1);
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(readdir(join(selectedPath, 'renders', 'stable-audio-3'))).resolves.toEqual([]);
  });

  it('cancels the exact active Stable Audio 3 Job through the authenticated API', async () => {
    const workerClient = new BlockingStableAudio3WorkerClient();
    const { engine, finalizer, selectedPath } = await startReadyStableAudio3Engine(workerClient);
    const enqueueResponse = await authenticatedRequest(engine, LOCAL_ENGINE_JOBS_PATH, {
      body: JSON.stringify({ request: createStableAudio3JobRequest() }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const enqueued = await enqueueResponse.json();

    await workerClient.waitUntilStarted();
    const cancelResponse = await authenticatedRequest(
      engine,
      `${LOCAL_ENGINE_JOBS_PATH}/${enqueued.job.jobId}/cancel`,
      { method: 'POST' },
    );
    const cancelBody = await cancelResponse.json();
    const canceled = await waitForJobState(engine, enqueued.job.jobId, 'CANCELED');

    expect(enqueueResponse.status).toBe(202);
    expect(cancelResponse.status).toBe(200);
    expect(cancelBody.job).toMatchObject({
      jobId: enqueued.job.jobId,
      state: 'CANCEL_REQUESTED',
    });
    expect(canceled.state).toBe('CANCELED');
    expect(workerClient.terminateCalls).toBe(1);
    expect(finalizer.getActiveReservationCount()).toBe(0);
    await expect(readdir(join(selectedPath, 'renders', 'stable-audio-3'))).resolves.toEqual([]);
  });

  it('routes cancel, retry, and waiting removal to the Engine-owned Queue', async () => {
    const calls = [];
    const record = createFakeJobRecord('job-route-test');
    const gpuJobQueue = createFakeGpuJobQueue({
      removeQueued: (jobId) => {
        calls.push(`remove:${jobId}`);
        return record;
      },
      requestCancel: async (jobId) => {
        calls.push(`cancel:${jobId}`);
        return record;
      },
      retry: (jobId) => {
        calls.push(`retry:${jobId}`);
        return record;
      },
    });
    const engine = await startTestEngine({ gpuJobQueue });

    for (const [path, method] of [
      [`${LOCAL_ENGINE_JOBS_PATH}/job-route-test/cancel`, 'POST'],
      [`${LOCAL_ENGINE_JOBS_PATH}/job-route-test/retry`, 'POST'],
      [`${LOCAL_ENGINE_JOBS_PATH}/job-route-test`, 'DELETE'],
    ]) {
      const response = await authenticatedRequest(engine, path, { method });
      expect(response.status).toBe(200);
    }

    expect(calls).toEqual([
      'cancel:job-route-test',
      'retry:job-route-test',
      'remove:job-route-test',
    ]);
  });

  it('maps Queue errors without leaking them as generic Engine failures', async () => {
    const gpuJobQueue = createFakeGpuJobQueue({
      requestCancel: async (jobId) => {
        throw new GpuJobQueueError('JOB_NOT_FOUND', `GPU Job was not found: ${jobId}.`);
      },
    });
    const engine = await startTestEngine({ gpuJobQueue });
    const response = await authenticatedRequest(
      engine,
      `${LOCAL_ENGINE_JOBS_PATH}/job-missing/cancel`,
      { method: 'POST' },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: 'JOB_NOT_FOUND',
      message: 'GPU Job was not found: job-missing.',
    });
  });

  it('reports BUSY Health while the Queue has an active GPU Job', async () => {
    const activeJob = { ...createFakeJobRecord('job-health-busy'), state: 'PROCESSING' };
    const engine = await startTestEngine({
      gpuJobQueue: createFakeGpuJobQueue({
        getSnapshot: () => ({
          acceptingJobs: true,
          activeJobId: activeJob.jobId,
          jobs: [activeJob],
        }),
      }),
    });
    const response = await authenticatedRequest(engine, LOCAL_ENGINE_HEALTH_PATH);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ activity: 'BUSY' });
  });

  it('blocks Project Root changes while the GPU Queue has pending work', async () => {
    const record = createFakeJobRecord('job-root-block');
    let selectionCalls = 0;
    const engine = await startTestEngine({
      gpuJobQueue: createFakeGpuJobQueue({
        getSnapshot: () => ({
          acceptingJobs: true,
          jobs: [record],
        }),
      }),
      selectProjectRoot: async () => {
        selectionCalls += 1;
        return createTemporaryDirectory();
      },
    });
    const response = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
      { method: 'POST' },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'GPU_JOB_QUEUE_ACTIVE' });
    expect(selectionCalls).toBe(0);
  });

  it('shuts down the Queue before discarding staged Artifacts', async () => {
    const shutdownOrder = [];
    const gpuJobQueue = createFakeGpuJobQueue({
      shutdown: async () => {
        shutdownOrder.push('queue');
      },
    });
    const generatedArtifactFinalizer = {
      discard: async () => undefined,
      discardAll: async () => {
        shutdownOrder.push('staging');
      },
      finalize: async () => undefined,
      getActiveReservationCount: () => 0,
      hasActiveWork: () => false,
      reserve: async () => undefined,
    };
    const engine = await startTestEngine({ generatedArtifactFinalizer, gpuJobQueue });

    await engine.close();
    runningEngines.delete(engine);

    expect(shutdownOrder).toEqual(['queue', 'staging']);
  });

  it('restores the persisted Project Root when a new Engine instance starts', async () => {
    const selectedPath = await createTemporaryDirectory();
    const stateDirectory = await createTemporaryDirectory();
    const stateFilePath = join(stateDirectory, 'engine-state', 'project-root.json');
    const firstEngine = await startTestEngine({
      projectRootAuthority: new ProjectRootAuthority({ stateFilePath }),
      selectProjectRoot: async () => selectedPath,
    });
    await authenticatedRequest(firstEngine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, { method: 'POST' });
    await firstEngine.close();
    runningEngines.delete(firstEngine);

    const restartedEngine = await startTestEngine({
      projectRootAuthority: new ProjectRootAuthority({ stateFilePath }),
    });
    const response = await authenticatedRequest(restartedEngine, LOCAL_ENGINE_PROJECT_ROOT_PATH);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rootPath: await realpath(selectedPath),
      status: 'READY',
    });
  });

  it('exposes generated-file finalization to future Engine Jobs without registering a Take', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });

    await expect(
      engine.generatedArtifacts.reserve({ destination: 'instrument', extension: '.wav' }),
    ).rejects.toMatchObject({ code: 'PROJECT_ROOT_REQUIRED' });
    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, { method: 'POST' });
    const reservation = await engine.generatedArtifacts.reserve({
      destination: 'instrument',
      extension: '.wav',
    });
    await writeFile(reservation.stagingPath, 'completed generated audio', 'utf8');
    const finalized = await engine.generatedArtifacts.finalize(reservation.reservationId);

    expect(finalized).toMatchObject({
      destination: 'instrument',
      status: 'FINALIZED',
    });
    await expect(
      readFile(join(selectedPath, ...finalized.file.relativePath.split('/')), 'utf8'),
    ).resolves.toBe('completed generated audio');
    expect(engine.generatedArtifacts.getActiveReservationCount()).toBe(0);
  });

  it('blocks Root changes while staging exists and discards staging during Engine shutdown', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({ selectProjectRoot: async () => selectedPath });
    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, { method: 'POST' });
    const reservation = await engine.generatedArtifacts.reserve({
      destination: 'stable-audio-3',
      extension: '.wav',
    });
    const rootChangeResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
      { method: 'POST' },
    );

    expect(rootChangeResponse.status).toBe(409);
    await expect(rootChangeResponse.json()).resolves.toMatchObject({
      code: 'ARTIFACT_STAGING_ACTIVE',
    });

    await engine.close();
    runningEngines.delete(engine);
    await expect(access(reservation.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      engine.generatedArtifacts.reserve({ destination: 'export', extension: '.wav' }),
    ).rejects.toThrow('closing');
    await expect(engine.close()).resolves.toBeUndefined();
  });
});

describe('Local Engine Audio Artifact file deletion', () => {
  it('deletes one authenticated validated WAV without exposing its absolute path', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({
      selectProjectRoot: async () => selectedPath,
    });
    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, {
      method: 'POST',
    });
    const wav = createPcmWav();
    const file = {
      artifactId: 'artifact-delete-route',
      extension: '.wav',
      name: 'artifact-delete-route.wav',
      relativePath: 'renders/instruments/artifact-delete-route.wav',
      sizeBytes: wav.length,
      storageKind: 'generated',
    };
    const absolutePath = join(
      selectedPath,
      ...file.relativePath.split('/'),
    );
    await writeFile(absolutePath, wav);

    const response = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_AUDIO_FILES_PATH,
      {
        body: JSON.stringify({ file }),
        headers: { 'Content-Type': 'application/json' },
        method: 'DELETE',
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      deletedFile: {
        ...file,
        status: 'DELETED',
      },
    });
    expect(JSON.stringify(body)).not.toContain(selectedPath);
    await expect(access(absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid methods, content types, paths, and changed metadata', async () => {
    const selectedPath = await createTemporaryDirectory();
    const engine = await startTestEngine({
      selectProjectRoot: async () => selectedPath,
    });
    const methodResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_AUDIO_FILES_PATH,
    );
    const contentTypeResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_AUDIO_FILES_PATH,
      {
        body: '{}',
        headers: { 'Content-Type': 'text/plain' },
        method: 'DELETE',
      },
    );

    expect(methodResponse.status).toBe(405);
    expect(contentTypeResponse.status).toBe(415);

    await authenticatedRequest(engine, LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH, {
      method: 'POST',
    });
    const wav = createPcmWav();
    const file = {
      artifactId: 'artifact-preserved-route',
      extension: '.wav',
      name: 'artifact-preserved-route.wav',
      relativePath: 'renders/instruments/artifact-preserved-route.wav',
      sizeBytes: wav.length,
      storageKind: 'generated',
    };
    const absolutePath = join(
      selectedPath,
      ...file.relativePath.split('/'),
    );
    await writeFile(absolutePath, wav);
    const traversalResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_AUDIO_FILES_PATH,
      {
        body: JSON.stringify({
          file: {
            ...file,
            relativePath: 'renders/instruments/../artifact-preserved-route.wav',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'DELETE',
      },
    );
    const mismatchResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_AUDIO_FILES_PATH,
      {
        body: JSON.stringify({
          file: {
            ...file,
            sizeBytes: file.sizeBytes + 1,
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'DELETE',
      },
    );
    const identityMismatchResponse = await authenticatedRequest(
      engine,
      LOCAL_ENGINE_AUDIO_FILES_PATH,
      {
        body: JSON.stringify({
          file: {
            ...file,
            artifactId: 'artifact-decoy-route',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'DELETE',
      },
    );

    expect(traversalResponse.status).toBe(400);
    expect(mismatchResponse.status).toBe(409);
    expect(identityMismatchResponse.status).toBe(400);
    await expect(access(absolutePath)).resolves.toBeUndefined();
  });
});

describe('Production UI integration', () => {
  it('serves a built UI without a token while keeping API routes authenticated', async () => {
    const uiRootPath = await createTemporaryDirectory();
    await mkdir(join(uiRootPath, 'assets'), { recursive: true });
    await writeFile(
      join(uiRootPath, 'index.html'),
      '<!doctype html><html><head><title>ElpisDAW</title></head></html>\n',
      'utf8',
    );
    await writeFile(join(uiRootPath, 'assets', 'app.js'), 'export {};\n', 'utf8');
    const engine = await startTestEngine({ uiRootPath });
    const documentResponse = await fetch(`${engine.baseUrl}/`);
    const assetResponse = await fetch(`${engine.baseUrl}/assets/app.js`);
    const unauthenticatedApiResponse = await fetch(
      `${engine.baseUrl}${LOCAL_ENGINE_HEALTH_PATH}`,
      { headers: { Origin: allowedOrigin } },
    );
    const unknownApiResponse = await fetch(`${engine.baseUrl}/api/v1/not-real`);

    expect(documentResponse.status).toBe(200);
    await expect(documentResponse.text()).resolves.toContain('<title>ElpisDAW</title>');
    expect(assetResponse.status).toBe(200);
    await expect(assetResponse.text()).resolves.toBe('export {};\n');
    expect(unauthenticatedApiResponse.status).toBe(401);
    await expect(unauthenticatedApiResponse.json()).resolves.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(unknownApiResponse.status).toBe(404);
    await expect(unknownApiResponse.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps development mode API-only when no production UI root is configured', async () => {
    const engine = await startTestEngine();
    const response = await fetch(`${engine.baseUrl}/`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });
  });
});

async function startTestEngine(overrides = {}) {
  const engine = await startLocalEngineServer({
    allowedOrigin,
    port: 0,
    projectRootAuthority: new ProjectRootAuthority(),
    token: launchToken,
    ...overrides,
  });
  runningEngines.add(engine);
  return engine;
}

async function startReadyAceStepEngine(workerClient) {
  const selectedPath = await createTemporaryDirectory();
  const projectRootAuthority = new ProjectRootAuthority();
  const finalizer = new GeneratedArtifactFinalizer({
    projectRootAuthority,
  });
  const aceStepJobExecutor = new AceStepJobExecutor({
    createWorkerClient: () => workerClient,
    generatedArtifactFinalizer: finalizer,
    projectRootAuthority,
  });
  const engine = await startTestEngine({
    aceStepJobExecutor,
    generatedArtifactFinalizer: finalizer,
    projectRootAuthority,
    selectProjectRoot: async () => selectedPath,
  });
  const selectionResponse = await authenticatedRequest(
    engine,
    LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
    { method: 'POST' },
  );

  if (!selectionResponse.ok) {
    throw new Error('ACE-Step test Project Root selection failed.');
  }

  await mkdir(join(selectedPath, 'renders', 'ace-step', 'lyrics'), {
    recursive: true,
  });
  await writeFile(
    join(selectedPath, 'renders', 'instruments', 'artifact-guide-a.wav'),
    createPcmWav({
      channels: ACE_STEP_CHANNELS,
      durationSeconds: 10,
      sampleRate: ACE_STEP_SAMPLE_RATE,
    }),
  );
  await writeFile(
    join(selectedPath, 'renders', 'ace-step', 'lyrics', 'artifact-lyrics-a.txt'),
    '[Verse]\nMorning light across the room\nA quiet pulse becomes a tune\n',
    'utf8',
  );

  return { engine, finalizer, selectedPath };
}

async function startReadyStableAudio3Engine(workerClient) {
  const selectedPath = await createTemporaryDirectory();
  const projectRootAuthority = new ProjectRootAuthority();
  const finalizer = new GeneratedArtifactFinalizer({
    projectRootAuthority,
  });
  const stableAudio3JobExecutor = new StableAudio3JobExecutor({
    createWorkerClient: () => workerClient,
    generatedArtifactFinalizer: finalizer,
    projectRootAuthority,
  });
  const engine = await startTestEngine({
    generatedArtifactFinalizer: finalizer,
    projectRootAuthority,
    selectProjectRoot: async () => selectedPath,
    stableAudio3JobExecutor,
  });
  const selectionResponse = await authenticatedRequest(
    engine,
    LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
    { method: 'POST' },
  );

  if (!selectionResponse.ok) {
    throw new Error('Stable Audio 3 test Project Root selection failed.');
  }

  await writeFile(
    join(selectedPath, 'renders', 'instruments', 'artifact-instrument-a.wav'),
    createPcmWav(),
  );

  return { engine, finalizer, selectedPath };
}

class SuccessfulAceStepWorkerClient {
  calls = [];
  terminateCalls = 0;

  async start() {
    this.calls.push('start');
  }

  async loadModel(modelId, modelRevision) {
    this.calls.push(`load:${modelId}@${modelRevision}`);
  }

  async execute(job) {
    this.calls.push('execute');
    const wav = createFloat32Wav({
      channels: ACE_STEP_CHANNELS,
      durationSeconds: job.parameters.durationSeconds,
      sampleRate: ACE_STEP_SAMPLE_RATE,
    });
    await writeFile(job.output.stagingPath, wav);
    return createAceStepProviderResult(job, wav);
  }

  async unloadModel() {
    this.calls.push('unload');
  }

  async close() {
    this.calls.push('close');
  }

  async terminate() {
    this.terminateCalls += 1;
  }
}

class SuccessfulStableAudio3WorkerClient {
  calls = [];
  terminateCalls = 0;

  async start() {
    this.calls.push('start');
  }

  async loadModel(modelId, modelRevision) {
    this.calls.push(`load:${modelId}@${modelRevision}`);
  }

  async execute(job) {
    this.calls.push('execute');
    const wav = createPcmWav({
      channels: STABLE_AUDIO_3_CHANNELS,
      durationSeconds: job.parameters.durationSeconds,
      sampleRate: STABLE_AUDIO_3_SAMPLE_RATE,
    });
    await writeFile(job.output.stagingPath, wav);
    return createStableAudio3ProviderResult(job, wav.length);
  }

  async unloadModel() {
    this.calls.push('unload');
  }

  async close() {
    this.calls.push('close');
  }

  async terminate() {
    this.terminateCalls += 1;
  }
}

class FailingStableAudio3WorkerClient extends SuccessfulStableAudio3WorkerClient {
  async execute(job) {
    this.calls.push('execute');
    await writeFile(`${job.output.stagingPath}.wav`, 'incomplete', 'utf8');
    throw Object.assign(new Error('Stable Audio 3 inference failed.'), {
      code: 'STABLE_AUDIO_3_INFERENCE_FAILED',
    });
  }
}

class BlockingStableAudio3WorkerClient extends SuccessfulStableAudio3WorkerClient {
  #execution;
  #rejectExecution;
  #resolveStarted;
  #started = new Promise((resolve) => {
    this.#resolveStarted = resolve;
  });

  async execute(job) {
    this.calls.push('execute');
    await writeFile(`${job.output.stagingPath}.wav`, 'incomplete', 'utf8');
    this.#resolveStarted();
    this.#execution = new Promise((_resolve, reject) => {
      this.#rejectExecution = reject;
    });
    return this.#execution;
  }

  async terminate() {
    this.terminateCalls += 1;
    this.#rejectExecution?.(
      Object.assign(new Error('Stable Audio 3 Worker terminated.'), {
        code: 'WORKER_TERMINATED',
      }),
    );
    await this.#execution?.catch(() => undefined);
  }

  waitUntilStarted() {
    return this.#started;
  }
}

function createAceStepProviderResult(job, wav) {
  return {
    artifact: {
      bytesWritten: wav.length,
      channels: ACE_STEP_CHANNELS,
      durationSeconds: job.parameters.durationSeconds,
      mimeType: 'audio/wav',
      sampleRate: ACE_STEP_SAMPLE_RATE,
      sha256: createHash('sha256').update(wav).digest('hex'),
      stagingPath: job.output.stagingPath,
    },
    completedAt: '2026-08-12T12:34:56.000Z',
    jobId: job.jobId,
    metadata: {
      modelId: job.modelId,
      modelRevision: job.modelRevision,
      parameters: job.parameters,
      providerId: job.providerId,
      seed: job.parameters.seed,
      taskId: job.taskId,
    },
    status: 'COMPLETED',
  };
}

function createStableAudio3ProviderResult(job, bytesWritten) {
  return {
    artifact: {
      bytesWritten,
      channels: STABLE_AUDIO_3_CHANNELS,
      durationSeconds: job.parameters.durationSeconds,
      mimeType: 'audio/wav',
      stagingPath: job.output.stagingPath,
    },
    completedAt: '2026-08-05T03:00:00.000Z',
    jobId: job.jobId,
    metadata: {
      modelId: job.modelId,
      modelRevision: job.modelRevision,
      parameters: job.parameters,
      providerId: job.providerId,
      seed: job.parameters.seed,
      taskId: job.taskId,
    },
    status: 'COMPLETED',
  };
}

function createProjectFile() {
  return {
    app: 'HumSTUDIO',
    savedAt: '2026-07-23T00:00:00.000Z',
    version: '0.1.0',
    workspace: { project: { name: 'Server Song' } },
  };
}

function createMockJobRequest() {
  return {
    inputArtifacts: [],
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    modelId: 'mock-audio-v1',
    modelRevision: '1',
    output: { artifactKind: 'audio', destination: 'instrument', extension: '.wav' },
    parameters: {
      durationSeconds: 0.1,
      frequencyHz: 440,
      sampleRate: 8_000,
      seed: 7,
    },
    providerId: 'mock-provider',
    taskId: 'mock-audio-generation',
  };
}

function createAceStepJobRequest() {
  return {
    guideSource: {
      artifactId: 'artifact-guide-a',
      clipTakeId: 'clip-take-midi-a',
      kind: 'midi-instrument-guide',
    },
    inputArtifacts: [
      {
        artifactId: 'artifact-guide-a',
        kind: 'audio',
        relativePath: 'renders/instruments/artifact-guide-a.wav',
        sizeBytes: 1_920_044,
      },
      {
        artifactId: 'artifact-lyrics-a',
        kind: 'lyrics',
        relativePath: 'renders/ace-step/lyrics/artifact-lyrics-a.txt',
      },
    ],
    lineage: {
      parentArtifactIds: ['artifact-guide-a', 'artifact-lyrics-a'],
      parentClipTakeIds: ['clip-take-midi-a'],
    },
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    output: {
      artifactKind: 'audio',
      destination: ACE_STEP_OUTPUT_DESTINATION,
      extension: '.wav',
    },
    parameters: {
      audioFormat: 'wav',
      batchSize: 1,
      caption: 'Warm intimate lead vocal following the corrected melody',
      channels: ACE_STEP_CHANNELS,
      durationSeconds: 10,
      sampleRate: ACE_STEP_SAMPLE_RATE,
      seed: 1_370_421,
      targetTrack: 'vocals',
      taskType: 'lego',
      thinking: false,
      vocalLanguage: 'en',
    },
    providerId: ACE_STEP_PROVIDER_ID,
    taskId: ACE_STEP_TASK_ID,
  };
}

function createStableAudio3JobRequest() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-instrument-a',
        kind: 'audio',
        relativePath: 'renders/instruments/artifact-instrument-a.wav',
      },
    ],
    lineage: {
      parentArtifactIds: ['artifact-instrument-a'],
      parentClipTakeIds: ['clip-take-instrument-a'],
    },
    modelId: STABLE_AUDIO_3_MODEL_ID,
    modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
    output: {
      artifactKind: 'audio',
      destination: STABLE_AUDIO_3_OUTPUT_DESTINATION,
      extension: '.wav',
    },
    parameters: {
      channels: STABLE_AUDIO_3_CHANNELS,
      durationSeconds: 0.1,
      prompt: 'Warm electric bass with a tight pocket',
      sampleRate: STABLE_AUDIO_3_SAMPLE_RATE,
      seed: 7,
      sourceEndSeconds: 0.1,
      sourceStartSeconds: 0,
      strength: 0.4,
    },
    providerId: STABLE_AUDIO_3_PROVIDER_ID,
    taskId: STABLE_AUDIO_3_TASK_ID,
  };
}

function createFloat32Wav({ channels, durationSeconds, sampleRate }) {
  const bitsPerSample = 32;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataByteLength = frameCount * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataByteLength);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataByteLength, 40);
  wav.writeFloatLE(0.25, 44);

  return wav;
}

function createPcmWav({ channels = 1, durationSeconds = 0.1, sampleRate = 8_000 } = {}) {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataByteLength = frameCount * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataByteLength);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataByteLength, 40);

  return wav;
}

function createFakeJobRecord(jobId) {
  const timestamp = '2026-07-23T00:00:00.000Z';
  return Object.freeze({
    attempt: 1,
    createdAt: timestamp,
    history: Object.freeze([
      Object.freeze({ attempt: 1, at: timestamp, state: 'QUEUED' }),
    ]),
    jobId,
    modelId: 'mock-audio-v1',
    modelRevision: '1',
    providerId: 'mock-provider',
    request: Object.freeze(createMockJobRequest()),
    state: 'QUEUED',
    taskId: 'mock-audio-generation',
    updatedAt: timestamp,
  });
}

function createFakeGpuJobQueue(overrides = {}) {
  return {
    enqueue: () => createFakeJobRecord('job-enqueued-test'),
    getJob: () => undefined,
    getSnapshot: () => ({ acceptingJobs: true, jobs: [] }),
    removeQueued: () => createFakeJobRecord('job-removed-test'),
    requestCancel: async () => createFakeJobRecord('job-canceled-test'),
    retry: () => createFakeJobRecord('job-retried-test'),
    shutdown: async () => undefined,
    ...overrides,
  };
}

async function waitForJobState(engine, jobId, expectedState) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await authenticatedRequest(engine, LOCAL_ENGINE_JOBS_PATH);
    const snapshot = await response.json();
    const job = snapshot.jobs.find((candidate) => candidate.jobId === jobId);

    if (job?.state === expectedState) {
      return job;
    }

    if (job?.state === 'FAILED' && expectedState !== 'FAILED') {
      throw new Error(`GPU Job failed during test: ${job.error?.message ?? 'unknown error'}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`GPU Job did not reach ${expectedState}.`);
}

function authenticatedRequest(engine, path, init = {}) {
  return fetch(`${engine.baseUrl}${path}`, {
    ...init,
    headers: {
      Origin: allowedOrigin,
      [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
      ...init.headers,
    },
  });
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-server-root-'));
  temporaryDirectories.add(directory);
  return directory;
}
