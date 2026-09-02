import { describe, expect, it, vi } from 'vitest';

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
} from '../shared/localEngineProtocol.js';
import {
  LocalEngineClient,
  parseLocalEngineAceStepLyricsSnapshot,
  parseLocalEngineHealth,
  parseLocalEngineRecordingArtifact,
  parseLocalEngineSoundFontCatalog,
  parseLocalEngineSoundFontPresetCatalog,
  type LocalEngineAceStepJobRequest,
  type LocalEngineBasicPitchHumToMidiJobRequest,
  type LocalEngineInstrumentRenderJobRequest,
  type LocalEngineMockHumToMidiJobRequest,
  type LocalEngineMockJobRequest,
  type LocalEngineSoundFontResource,
  type LocalEngineStableAudio3JobRequest,
} from './localEngineClient';
import { createInstrumentRenderJobRequest } from './instrumentRenderContract';

const baseUrl = 'http://127.0.0.1:43120';
const launchToken = 'test-launch-token-that-is-at-least-32-characters';

describe('LocalEngineClient', () => {
  it('requests the versioned Health endpoint with the in-memory launch token', async () => {
    const fetchImpl = vi.fn(async () => createHealthResponse());
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const result = await client.checkHealth();

    expect(result).toMatchObject({
      health: {
        activity: 'IDLE',
        lifecycle: 'READY',
        protocolVersion: LOCAL_ENGINE_PROTOCOL_VERSION,
      },
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_HEALTH_PATH}`,
      expect.objectContaining({
        headers: { [LOCAL_ENGINE_TOKEN_HEADER]: launchToken },
        method: 'GET',
      }),
    );
  });

  it('reports a protocol version mismatch without treating the Engine as READY', async () => {
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () => createHealthResponse({ protocolVersion: '999' }),
      token: launchToken,
    });

    await expect(client.checkHealth()).resolves.toMatchObject({
      ok: false,
      reason: 'version-mismatch',
    });
  });

  it('reports unauthorized and invalid responses explicitly', async () => {
    const unauthorizedClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () => new Response('{}', { status: 401 }),
      token: launchToken,
    });
    const invalidClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () => Response.json({ lifecycle: 'READY' }),
      token: launchToken,
    });

    await expect(unauthorizedClient.checkHealth()).resolves.toMatchObject({
      ok: false,
      reason: 'unauthorized',
    });
    await expect(invalidClient.checkHealth()).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
  });

  it('reports a bounded Health Check timeout', async () => {
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('Health Check aborted.');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      timeoutMs: 5,
      token: launchToken,
    });

    await expect(client.checkHealth()).resolves.toMatchObject({
      ok: false,
      reason: 'timeout',
    });
  });

  it('reads and validates the pinned Basic Pitch Runtime inspection', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        runtime: {
          modelId: 'basic-pitch-icassp-2022',
          modelRevision: '0.4.0-onnx',
          profileId: 'windows-x64-python-3-10-onnx-cpu',
          providerVersion: '0.4.0',
          status: 'READY',
        },
      }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.checkBasicPitchRuntime()).resolves.toMatchObject({
      ok: true,
      runtime: { status: 'READY' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_BASIC_PITCH_RUNTIME_PATH}`,
      expect.objectContaining({
        headers: { [LOCAL_ENGINE_TOKEN_HEADER]: launchToken },
        method: 'GET',
      }),
    );
  });

  it('accepts a sanitized unavailable Basic Pitch Runtime result and rejects malformed readiness', async () => {
    const unavailableClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json({
          runtime: {
            code: 'BASIC_PITCH_RUNTIME_UNAVAILABLE',
            message: 'Basic Pitch Runtime is unavailable.',
            status: 'UNAVAILABLE',
          },
        }),
      token: launchToken,
    });
    const invalidClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json({
          runtime: {
            modelId: 'wrong-model',
            modelRevision: '0.4.0-onnx',
            profileId: 'windows-x64-python-3-10-onnx-cpu',
            providerVersion: '0.4.0',
            status: 'READY',
          },
        }),
      token: launchToken,
    });

    await expect(unavailableClient.checkBasicPitchRuntime()).resolves.toMatchObject({
      ok: true,
      runtime: { status: 'UNAVAILABLE' },
    });
    await expect(invalidClient.checkBasicPitchRuntime()).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
  });

  it('reads and validates the Engine-owned GPU Job snapshot', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        acceptingJobs: true,
        jobs: [createGpuJobRecord()],
      }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.getJobs()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        acceptingJobs: true,
        jobs: [expect.objectContaining({ jobId: 'job-client-test', state: 'QUEUED' })],
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_JOBS_PATH}`,
      expect.objectContaining({
        headers: { [LOCAL_ENGINE_TOKEN_HEADER]: launchToken },
        method: 'GET',
      }),
    );
  });

  it('enqueues a typed Mock Provider request through the authenticated Job API', async () => {
    const request = createMockJobRequest();
    const fetchImpl = vi.fn(async () => Response.json({ job: createGpuJobRecord() }, { status: 202 }));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.enqueueMockJob(request)).resolves.toMatchObject({
      job: { providerId: 'mock-provider', state: 'QUEUED' },
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_JOBS_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({ request }),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('enqueues a typed Mock Hum-to-MIDI request through the same Job API', async () => {
    const request = createMockHumToMidiJobRequest();
    const fetchImpl = vi.fn(async () =>
      Response.json({ job: createGpuJobRecord(request) }, { status: 202 }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.enqueueMockHumToMidiJob(request)).resolves.toMatchObject({
      job: {
        modelId: 'mock-hum-to-midi-v1',
        state: 'QUEUED',
        taskId: 'hum-to-midi',
      },
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_JOBS_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({ request }),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('enqueues a typed Basic Pitch Hum-to-MIDI request without changing the Mock workflow', async () => {
    const request = createBasicPitchHumToMidiJobRequest();
    const fetchImpl = vi.fn(async () =>
      Response.json({ job: createGpuJobRecord(request) }, { status: 202 }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.enqueueBasicPitchHumToMidiJob(request)).resolves.toMatchObject({
      job: {
        modelId: 'basic-pitch-icassp-2022',
        providerId: 'local-basic-pitch',
        state: 'QUEUED',
        taskId: 'hum-to-midi',
      },
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_JOBS_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({ request }),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('enqueues a typed Mock Instrument Render request through the same Job API', async () => {
    const request = createMockInstrumentRenderJobRequest();
    const fetchImpl = vi.fn(async () =>
      Response.json({ job: createGpuJobRecord(request) }, { status: 202 }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(
      client.enqueueInstrumentRenderJob(request),
    ).resolves.toMatchObject({
      job: {
        modelId: 'mock-soundfont-v1',
        state: 'QUEUED',
        taskId: 'midi-to-audio',
      },
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_JOBS_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({ request }),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('transports a typed Stable Audio 3 request without claiming Runtime support', async () => {
    const request = createStableAudio3JobRequest();
    const fetchImpl = vi.fn(async () =>
      Response.json({ job: createGpuJobRecord(request) }, { status: 202 }),
    );
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl,
      token: launchToken,
    });

    await expect(client.enqueueStableAudio3Job(request)).resolves.toMatchObject({
      job: {
        modelId: 'stable-audio-3-medium',
        providerId: 'local-stable-audio-3',
        state: 'QUEUED',
        taskId: 'audio-to-audio',
      },
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_JOBS_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({ request }),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('uses explicit Job action and waiting-removal endpoints', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      Response.json(
        init?.method === 'DELETE'
          ? { removedJob: createGpuJobRecord() }
          : { job: createGpuJobRecord() },
      ),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.cancelJob('job-client-test')).resolves.toMatchObject({ ok: true });
    await expect(client.retryJob('job-client-test')).resolves.toMatchObject({ ok: true });
    await expect(client.removeQueuedJob('job-client-test')).resolves.toMatchObject({ ok: true });

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${baseUrl}${LOCAL_ENGINE_JOBS_PATH}/job-client-test/cancel`, 'POST'],
      [`${baseUrl}${LOCAL_ENGINE_JOBS_PATH}/job-client-test/retry`, 'POST'],
      [`${baseUrl}${LOCAL_ENGINE_JOBS_PATH}/job-client-test`, 'DELETE'],
    ]);
  });

  it('rejects malformed Job history and invalid client-side Job IDs', async () => {
    const malformed = createGpuJobRecord();
    malformed.history[0].state = 'COMPLETED';
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () => Response.json({ acceptingJobs: true, jobs: [malformed] }),
      token: launchToken,
    });

    await expect(client.getJobs()).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
    await expect(client.cancelJob('../job-client-test')).rejects.toThrow('GPU Job ID');
  });

  it('binds the default browser fetch to its global execution context', async () => {
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }

      return Promise.resolve(createHealthResponse());
    });
    vi.stubGlobal('fetch', browserFetch);

    try {
      const client = new LocalEngineClient({ baseUrl, token: launchToken });

      await expect(client.checkHealth()).resolves.toMatchObject({ ok: true });
      expect(browserFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads the current Project Root through the authenticated Engine protocol', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        configuredAt: '2026-07-23T00:00:00.000Z',
        directories: ['recordings', 'renders/instruments'],
        projectFile: { status: 'MISSING' },
        projectFileName: 'MySong.humstudio.json',
        rootName: 'MySong',
        rootPath: 'D:\\Music Projects\\MySong',
        status: 'READY',
      }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.getProjectRoot()).resolves.toMatchObject({
      ok: true,
      projectRoot: { rootName: 'MySong', status: 'READY' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_PROJECT_ROOT_PATH}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('requests Engine-owned Project Root selection and preserves cancellation', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ selection: 'CANCELED', status: 'UNSET' }));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.selectProjectRoot()).resolves.toEqual({
      ok: true,
      projectRoot: { status: 'UNSET' },
      selection: 'CANCELED',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects malformed Project Root responses', async () => {
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () => Response.json({ rootPath: 'D:\\Music', status: 'READY' }),
      token: launchToken,
    });

    await expect(client.getProjectRoot()).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
  });

  it('lists and validates the Project SoundFont catalog', async () => {
    const catalog = createSoundFontCatalog();
    const fetchImpl = vi.fn(async () => Response.json(catalog));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.listSoundFonts()).resolves.toEqual({
      catalog,
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_SOUNDFONTS_PATH}`,
      expect.objectContaining({
        headers: { [LOCAL_ENGINE_TOKEN_HEADER]: launchToken },
        method: 'GET',
      }),
    );
  });

  it('rejects malformed or duplicated SoundFont catalog resources', async () => {
    const malformed = createSoundFontCatalog();
    malformed.resources.push({
      ...malformed.resources[0],
      relativePath: '../outside.sf2',
    });
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () => Response.json(malformed),
      token: launchToken,
    });
    const duplicate = createSoundFontCatalog();
    duplicate.resources.push({ ...duplicate.resources[0] });

    await expect(client.listSoundFonts()).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
    expect(parseLocalEngineSoundFontCatalog(duplicate)).toBeUndefined();
  });

  it('lists and validates presets from one verified SoundFont resource', async () => {
    const resource = createSoundFontCatalog()
      .resources[0] as LocalEngineSoundFontResource;
    const catalog = {
      presets: [
        { bank: 0, name: 'Grand Piano', program: 0 },
        { bank: 0, name: 'Nylon String Guitar', program: 24 },
      ],
      resourceId: resource.resourceId,
      revisionToken: resource.revisionToken,
    };
    const fetchImpl = vi.fn(async () => Response.json(catalog));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(
      client.listSoundFontPresets({
        soundFont: {
          format: resource.format,
          library: resource.library,
          relativePath: resource.relativePath,
          resourceId: resource.resourceId,
          revisionToken: resource.revisionToken,
        },
      }),
    ).resolves.toEqual({ catalog, ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_SOUNDFONT_PRESETS_PATH}`,
      expect.objectContaining({
        body: expect.any(String),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        }),
        method: 'POST',
      }),
    );

    expect(
      parseLocalEngineSoundFontPresetCatalog({
        ...catalog,
        presets: [...catalog.presets, { ...catalog.presets[0] }],
      }),
    ).toBeUndefined();
  });

  it('renders and validates a SoundFont audition WAV through the authenticated Engine endpoint', async () => {
    const wav = createGeneratedWav();
    const resource = createSoundFontCatalog().resources[0];
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
        library: 'project',
        relativePath: resource.relativePath,
        resourceId: resource.resourceId,
        revisionToken: resource.revisionToken,
      },
    } as const;
    const fetchImpl = vi.fn(async () =>
      new Response(wav.buffer as ArrayBuffer, {
        headers: { 'Content-Type': 'audio/wav' },
      }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.renderSoundFontAudition(request)).resolves.toMatchObject({
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_SOUNDFONT_AUDITION_PATH}`,
      expect.objectContaining({
        body: JSON.stringify(request),
        headers: {
          Accept: 'audio/wav',
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('does not start a SoundFont audition after external cancellation', async () => {
    const fetchImpl = vi.fn();
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      client.renderSoundFontAudition(
        {
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
            library: 'project',
            relativePath: 'soundfonts/Keys.sf2',
            resourceId: `soundfont-${'a'.repeat(32)}`,
            revisionToken: 'b'.repeat(64),
          },
        },
        abortController.signal,
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'canceled',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('saves Project JSON through the authenticated Engine endpoint', async () => {
    const projectFile = {
      app: 'HumSTUDIO',
      savedAt: '2026-07-23T00:00:00.000Z',
      version: '0.1.0',
      workspace: { project: { name: 'Client Song' } },
    };
    const fetchImpl = vi.fn(async () =>
      Response.json({
        bytesWritten: 512,
        lastModifiedAt: '2026-07-23T00:00:01.000Z',
        projectFileName: 'Client Song.humstudio.json',
        projectFilePath: 'D:\\Music Projects\\Client Song\\Client Song.humstudio.json',
        savedAt: projectFile.savedAt,
        status: 'SAVED',
      }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.saveProjectFile(projectFile)).resolves.toMatchObject({
      ok: true,
      savedProject: { bytesWritten: 512, status: 'SAVED' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_PROJECT_FILE_PATH}`,
      expect.objectContaining({
        body: JSON.stringify(projectFile),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'PUT',
      }),
    );
  });

  it('loads Project JSON through the authenticated Engine endpoint', async () => {
    const projectFile = {
      app: 'HumSTUDIO',
      savedAt: '2026-07-23T00:00:00.000Z',
      version: '0.1.0',
      workspace: { project: { name: 'Client Song' } },
    };
    const fetchImpl = vi.fn(async () =>
      Response.json({
        bytesRead: 512,
        lastModifiedAt: '2026-07-23T00:00:01.000Z',
        projectFile,
        projectFileName: 'Client Song.humstudio.json',
        projectFilePath: 'D:\\Music Projects\\Client Song\\Client Song.humstudio.json',
        savedAt: projectFile.savedAt,
        status: 'LOADED',
      }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.loadProjectFile()).resolves.toMatchObject({
      loadedProject: {
        bytesRead: 512,
        projectFile,
        status: 'LOADED',
      },
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_PROJECT_FILE_PATH}`,
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'GET',
      }),
    );
  });

  it('rejects a malformed Project open response before exposing Project data', async () => {
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json({
          bytesRead: 512,
          lastModifiedAt: '2026-07-23T00:00:01.000Z',
          projectFile: {
            app: 'HumSTUDIO',
            savedAt: '2026-07-23T00:00:00.000Z',
            version: '0.1.0',
            workspace: {},
          },
          projectFileName: 'Client Song.humstudio.json',
          projectFilePath: 'D:\\Music Projects\\Client Song\\Client Song.humstudio.json',
          savedAt: '2026-07-23T00:00:02.000Z',
          status: 'LOADED',
        }),
      token: launchToken,
    });

    await expect(client.loadProjectFile()).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
  });

  it('surfaces the Engine Project save error message', async () => {
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json(
          { code: 'PROJECT_ROOT_REQUIRED', message: 'Select a Project Root first.' },
          { status: 409 },
        ),
      token: launchToken,
    });

    await expect(client.saveProjectFile({})).resolves.toMatchObject({
      message: 'Select a Project Root first.',
      ok: false,
      reason: 'http-error',
      status: 409,
    });
  });

  it('saves ACE-Step Lyrics and validates the finalized snapshot response', async () => {
    const lyricsSnapshot = createAceStepLyricsSnapshot();
    const fetchImpl = vi.fn(async () =>
      Response.json(lyricsSnapshot, { status: 201 }),
    );
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl,
      token: launchToken,
    });
    const lyrics = '[Verse]\nMorning light across the room\n';

    await expect(client.saveAceStepLyrics(lyrics)).resolves.toEqual({
      lyricsSnapshot,
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_ACE_STEP_LYRICS_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({ lyrics }),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('controls SoundFont Live Preview through the authenticated Engine endpoint', async () => {
    const sessionId = '12345678-1234-4abc-8def-1234567890ab';
    const fetchImpl = vi.fn(async () =>
      Response.json({
        bank: 0,
        program: 0,
        resourceId: `soundfont-${'a'.repeat(32)}`,
        sessionId,
        status: 'READY',
      }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const request = {
      action: 'prepare' as const,
      bank: 0,
      program: 0,
      soundFont: {
        format: 'sf3' as const,
        library: 'builtin' as const,
        relativePath: 'soundfonts/HumStudio Default/MuseScore_General.sf3',
        resourceId: `soundfont-${'a'.repeat(32)}`,
        revisionToken: 'b'.repeat(64),
      },
    };

    await expect(client.controlSoundFontLivePreview(request)).resolves.toMatchObject({
      ok: true,
      snapshot: { sessionId, status: 'READY' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_SOUNDFONT_LIVE_PREVIEW_PATH}`,
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

  it('transports one exact typed ACE-Step request', async () => {
    const request = createAceStepJobRequestInputFixture();
    const fetchImpl = vi.fn(async () =>
      Response.json({ job: createGpuJobRecord(request) }, { status: 202 }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.enqueueAceStepJob(request)).resolves.toMatchObject({
      job: {
        modelId: 'acestep-v15-base',
        providerId: 'local-ace-step',
        state: 'QUEUED',
        taskId: 'guide-audio-to-vocals',
      },
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_JOBS_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({ request }),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('rejects malformed ACE-Step Lyrics responses without inventing a snapshot', async () => {
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json({
          ...createAceStepLyricsSnapshot(),
          sha256: 'invalid',
        }),
      token: launchToken,
    });

    await expect(client.saveAceStepLyrics('[Verse]\nHello')).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
    expect(
      parseLocalEngineAceStepLyricsSnapshot({
        ...createAceStepLyricsSnapshot(),
        file: {
          ...createAceStepLyricsSnapshot().file,
          relativePath: 'renders/ace-step/lyrics/../outside.txt',
        },
      }),
    ).toBeUndefined();
  });

  it('surfaces ACE-Step Lyrics persistence errors', async () => {
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json(
          { code: 'PROJECT_ROOT_REQUIRED', message: 'Select Project Root first.' },
          { status: 409 },
        ),
      token: launchToken,
    });

    await expect(client.saveAceStepLyrics('[Verse]\nHello')).resolves.toMatchObject({
      message: 'Select Project Root first.',
      ok: false,
      reason: 'http-error',
      status: 409,
    });
  });

  it('uploads a recording WAV and validates the finalized Engine response', async () => {
    const recordingResponse = createRecordingArtifact();
    const fetchImpl = vi.fn(async () => Response.json(recordingResponse, { status: 201 }));
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const wav = new Blob([new Uint8Array(48)], { type: 'audio/wav' });

    await expect(client.saveRecordingWav(wav)).resolves.toEqual({
      ok: true,
      recording: recordingResponse,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_RECORDINGS_PATH}`,
      expect.objectContaining({
        body: wav,
        headers: {
          'Content-Type': 'audio/wav',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('rejects invalid recording input and malformed Engine recording responses', async () => {
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json({
          ...createRecordingArtifact(),
          destination: 'instrument',
        }),
      token: launchToken,
    });

    await expect(
      client.saveRecordingWav(new Blob(['audio'], { type: 'audio/webm' })),
    ).rejects.toThrow('audio/wav Blob');
    await expect(
      client.saveRecordingWav(new Blob([new Uint8Array(48)], { type: 'audio/wav' })),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
  });

  it('surfaces Engine recording persistence errors without inventing an Artifact', async () => {
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json(
          { code: 'PROJECT_ROOT_REQUIRED', message: 'Select Project Root first.' },
          { status: 409 },
        ),
      token: launchToken,
    });

    await expect(
      client.saveRecordingWav(new Blob([new Uint8Array(48)], { type: 'audio/wav' })),
    ).resolves.toMatchObject({
      message: 'Select Project Root first.',
      ok: false,
      reason: 'http-error',
      status: 409,
    });
  });

  it('restores source availability through the authenticated Engine endpoint', async () => {
    const sources = [
      {
        kind: 'generated',
        lastModified: 1_784_770_000_000,
        name: 'take-a.wav',
        relativePath: 'recordings/take-a.wav',
        sizeBytes: 512,
        sourceId: 'source-generated-a',
      },
    ] as const;
    const fetchImpl = vi.fn(async () =>
      Response.json({
        availability: { 'source-generated-a': 'available' },
        checkedAt: '2026-07-23T00:00:01.000Z',
        sources: [
          {
            actual: {
              lastModified: 1_784_770_000_000,
              name: 'take-a.wav',
              sizeBytes: 512,
            },
            kind: 'generated',
            reason: 'available',
            relativePath: 'recordings/take-a.wav',
            resolvedPath: 'D:\\Music Projects\\MySong\\recordings\\take-a.wav',
            sourceId: 'source-generated-a',
            state: 'available',
          },
        ],
      }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.restoreSources(sources)).resolves.toMatchObject({
      ok: true,
      restoration: {
        availability: { 'source-generated-a': 'available' },
        sources: [expect.objectContaining({ state: 'available' })],
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_SOURCE_RESTORE_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({ sources }),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('rejects source restoration responses whose availability map disagrees with sources', async () => {
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json({
          availability: { 'source-a': 'available' },
          checkedAt: '2026-07-23T00:00:01.000Z',
          sources: [
            {
              kind: 'generated',
              reason: 'missing',
              relativePath: 'recordings/missing.wav',
              sourceId: 'source-a',
              state: 'missing',
            },
          ],
        }),
      token: launchToken,
    });

    await expect(client.restoreSources([])).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
  });

  it('reads and validates generated WAV bytes through the authenticated Engine endpoint', async () => {
    const source = createGeneratedAudioDescriptor();
    const wav = createGeneratedWav();
    const fetchImpl = vi.fn(async () =>
      new Response(wav.buffer as ArrayBuffer, {
        headers: { 'Content-Type': 'audio/wav' },
      }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const result = await client.readGeneratedAudioWav(source);

    expect(result).toMatchObject({ ok: true });

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(new Uint8Array(await result.wav.arrayBuffer())).toEqual(wav);
    expect(result.wav.type).toBe('audio/wav');
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_GENERATED_AUDIO_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({ source }),
        headers: {
          Accept: 'audio/wav',
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('passes an external cancellation signal to generated WAV reads and classifies it as canceled', async () => {
    const source = createGeneratedAudioDescriptor();
    const external = new AbortController();
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Canceled.', 'AbortError')),
            { once: true },
          );
        }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const read = client.readGeneratedAudioWav(source, { signal: external.signal });

    external.abort();

    await expect(read).resolves.toMatchObject({
      message: 'Local Engine generated audio read was canceled.',
      ok: false,
      reason: 'canceled',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns structured failures for rejected or malformed generated WAV responses', async () => {
    const source = createGeneratedAudioDescriptor();
    const wav = createGeneratedWav();
    const unauthorizedClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () => new Response('{}', { status: 401 }),
      token: launchToken,
    });
    const wrongTypeClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        new Response(wav.buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      token: launchToken,
    });
    const invalidWavClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        new Response(new ArrayBuffer(wav.length), {
          headers: { 'Content-Type': 'audio/wav' },
        }),
      token: launchToken,
    });
    const mismatchClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json(
          {
            code: 'GENERATED_AUDIO_METADATA_MISMATCH',
            message: 'Generated audio no longer matches its Project descriptor.',
          },
          { status: 409 },
        ),
      token: launchToken,
    });

    await expect(
      unauthorizedClient.readGeneratedAudioWav(source),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'unauthorized',
      status: 401,
    });
    await expect(wrongTypeClient.readGeneratedAudioWav(source)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
    await expect(invalidWavClient.readGeneratedAudioWav(source)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
    await expect(mismatchClient.readGeneratedAudioWav(source)).resolves.toMatchObject({
      message: 'Generated audio no longer matches its Project descriptor.',
      ok: false,
      reason: 'http-error',
      status: 409,
    });
  });

  it('checks generated audio availability through the authenticated Engine endpoint', async () => {
    const sources = [
      createGeneratedAudioDescriptor(),
      {
        ...createGeneratedAudioDescriptor(),
        name: 'missing.wav',
        relativePath: 'renders/instruments/missing.wav',
        sourceId: 'artifact-missing',
      },
    ];
    const fetchImpl = vi.fn(async () =>
      Response.json({
        availableSourceIds: ['artifact-instrument-a'],
      }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });
    const result = await client.checkGeneratedAudioAvailability(sources);

    expect(result).toEqual({
      availableSourceIds: ['artifact-instrument-a'],
      ok: true,
    });

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(Object.isFrozen(result.availableSourceIds)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({ sources }),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'POST',
      }),
    );
  });

  it('rejects unauthorized, mistyped, duplicate, and unrequested availability responses', async () => {
    const source = createGeneratedAudioDescriptor();
    const unauthorizedClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () => new Response('{}', { status: 401 }),
      token: launchToken,
    });
    const wrongTypeClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ availableSourceIds: [source.sourceId] }),
          { headers: { 'Content-Type': 'text/plain' } },
        ),
      token: launchToken,
    });
    const duplicateClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json({
          availableSourceIds: [source.sourceId, source.sourceId],
        }),
      token: launchToken,
    });
    const unrequestedClient = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json({ availableSourceIds: ['artifact-unrequested'] }),
      token: launchToken,
    });

    await expect(
      unauthorizedClient.checkGeneratedAudioAvailability([source]),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'unauthorized',
      status: 401,
    });
    await expect(
      wrongTypeClient.checkGeneratedAudioAvailability([source]),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
    await expect(
      duplicateClient.checkGeneratedAudioAvailability([source]),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
    await expect(
      unrequestedClient.checkGeneratedAudioAvailability([source]),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
  });

  it('deletes an Audio Artifact file through the authenticated Engine endpoint', async () => {
    const file = createAudioFileDeletionDescriptor();
    const fetchImpl = vi.fn(async () =>
      Response.json({
        deletedFile: {
          ...file,
          status: 'DELETED',
        },
      }),
    );
    const client = new LocalEngineClient({ baseUrl, fetchImpl, token: launchToken });

    await expect(client.deleteAudioArtifactFile(file)).resolves.toEqual({
      deletedFile: {
        ...file,
        status: 'DELETED',
      },
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}${LOCAL_ENGINE_AUDIO_FILES_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({ file }),
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: launchToken,
        },
        method: 'DELETE',
      }),
    );
  });

  it('rejects mismatched Audio Artifact file deletion responses', async () => {
    const file = createAudioFileDeletionDescriptor();
    const client = new LocalEngineClient({
      baseUrl,
      fetchImpl: async () =>
        Response.json({
          deletedFile: {
            ...file,
            artifactId: 'artifact-wrong',
            status: 'DELETED',
          },
        }),
      token: launchToken,
    });

    await expect(client.deleteAudioArtifactFile(file)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response',
    });
  });

  it('rejects non-loopback endpoints and weak launch tokens', () => {
    expect(() => new LocalEngineClient({ baseUrl: 'http://localhost:43120', token: launchToken })).toThrow(
      '127.0.0.1',
    );
    expect(() => new LocalEngineClient({ baseUrl, token: 'too-short' })).toThrow('32 characters');
  });
});

describe('parseLocalEngineHealth', () => {
  it('rejects unknown lifecycle or activity states', () => {
    expect(parseLocalEngineHealth(createHealthBody({ lifecycle: 'BUSY' }))).toBeUndefined();
    expect(parseLocalEngineHealth(createHealthBody({ activity: 'PROCESSING' }))).toBeUndefined();
  });
});

describe('parseLocalEngineRecordingArtifact', () => {
  it('rejects unsafe or inconsistent recording paths', () => {
    expect(
      parseLocalEngineRecordingArtifact({
        ...createRecordingArtifact(),
        file: {
        ...createRecordingArtifact().file,
          relativePath: 'recordings/../outside/artifact-recording-a.wav',
        },
      }),
    ).toBeUndefined();
  });
});

function createHealthResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json(createHealthBody(overrides));
}

function createSoundFontCatalog() {
  return {
    directory: 'soundfonts',
    issues: [],
    resources: [
      {
        format: 'sf2',
        lastModifiedAt: '2026-07-28T00:00:00.000Z',
        library: 'project',
        name: 'Electric Piano.sf2',
        relativePath: 'soundfonts/Electric Piano.sf2',
        resourceId: `soundfont-${'a'.repeat(32)}`,
        revisionToken: 'b'.repeat(64),
        sizeBytes: 1_024,
        status: 'AVAILABLE',
      },
    ],
    scannedAt: '2026-07-28T00:00:01.000Z',
    supportedFormats: ['sf2', 'sf3'],
  };
}

function createAceStepLyricsSnapshot() {
  const artifactId = 'artifact-12345678-1234-4abc-8def-1234567890ab';

  return {
    artifactId,
    createdAt: '2026-08-12T13:00:00.000Z',
    destination: 'ace-step-lyrics' as const,
    file: {
      extension: '.txt' as const,
      name: `${artifactId}.txt`,
      relativePath: `renders/ace-step/lyrics/${artifactId}.txt`,
      sizeBytes: 38,
    },
    kind: 'lyrics' as const,
    sha256: 'a'.repeat(64),
    status: 'FINALIZED' as const,
  };
}

function createRecordingArtifact() {
  return {
    artifactId: 'artifact-recording-a',
    audio: {
      bitsPerSample: 16 as const,
      channels: 1 as const,
      durationSeconds: 1,
      mimeType: 'audio/wav' as const,
      sampleRate: 48_000,
    },
    createdAt: '2026-07-23T00:00:00.000Z',
    destination: 'recording' as const,
    file: {
      extension: '.wav' as const,
      name: 'artifact-recording-a.wav',
      relativePath: 'recordings/artifact-recording-a.wav',
      sizeBytes: 96_044,
    },
    kind: 'audio' as const,
    status: 'FINALIZED' as const,
  };
}

function createGeneratedAudioDescriptor() {
  return {
    kind: 'generated' as const,
    name: 'instrument-a.wav',
    relativePath: 'renders/instruments/instrument-a.wav',
    sizeBytes: createGeneratedWav().length,
    sourceId: 'artifact-instrument-a',
  };
}

function createAudioFileDeletionDescriptor() {
  return {
    artifactId: 'artifact-delete-client',
    extension: '.wav' as const,
    name: 'delete-client.wav',
    relativePath: 'renders/instruments/delete-client.wav',
    sizeBytes: 512,
    storageKind: 'generated' as const,
  };
}

function createGeneratedWav(): Uint8Array {
  const wav = new Uint8Array(48);
  const view = new DataView(wav.buffer);
  wav.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, wav.length - 8, true);
  wav.set([0x57, 0x41, 0x56, 0x45], 8);
  wav.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wav.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, 4, true);

  return wav;
}

function createHealthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activity: 'IDLE',
    engineVersion: '0.1.0',
    instanceId: 'engine-instance-a',
    lifecycle: 'READY',
    protocolVersion: LOCAL_ENGINE_PROTOCOL_VERSION,
    startedAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

function createMockJobRequest(): LocalEngineMockJobRequest {
  return {
    inputArtifacts: [],
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    modelId: 'mock-audio-v1',
    modelRevision: '1',
    output: {
      artifactKind: 'audio',
      destination: 'instrument',
      extension: '.wav',
    },
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

function createMockHumToMidiJobRequest(): LocalEngineMockHumToMidiJobRequest {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-recording-a',
        kind: 'audio',
        relativePath: 'recordings/artifact-recording-a.wav',
      },
    ],
    lineage: {
      parentArtifactIds: ['artifact-recording-a'],
      parentClipTakeIds: ['clip-take-recording-a'],
    },
    modelId: 'mock-hum-to-midi-v1',
    modelRevision: '1',
    output: {
      artifactKind: 'midi',
    },
    parameters: {
      projectBpm: 120,
      seed: 7,
      sourceEndSeconds: 2,
      sourceStartSeconds: 0,
      ticksPerQuarter: 960,
    },
    providerId: 'mock-provider',
    taskId: 'hum-to-midi',
  };
}

function createBasicPitchHumToMidiJobRequest(): LocalEngineBasicPitchHumToMidiJobRequest {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-recording-a',
        kind: 'audio',
        relativePath: 'recordings/artifact-recording-a.wav',
      },
    ],
    lineage: {
      parentArtifactIds: ['artifact-recording-a'],
      parentClipTakeIds: ['clip-take-recording-a'],
    },
    modelId: 'basic-pitch-icassp-2022',
    modelRevision: '0.4.0-onnx',
    output: {
      artifactKind: 'midi',
    },
    parameters: {
      frameThreshold: 0.3,
      maximumFrequencyHz: 1_100,
      melodiaTrick: true,
      minimumFrequencyHz: 80,
      minimumNoteLengthMs: 127.7,
      multiplePitchBends: false,
      onsetThreshold: 0.5,
      projectBpm: 120,
      sourceEndSeconds: 2,
      sourceStartSeconds: 0,
      ticksPerQuarter: 960,
    },
    providerId: 'local-basic-pitch',
    taskId: 'hum-to-midi',
  };
}

function createMockInstrumentRenderJobRequest(): LocalEngineInstrumentRenderJobRequest {
  return createInstrumentRenderJobRequest({
    gainDb: -3,
    modelId: 'mock-soundfont-v1',
    modelRevision: '1',
    plan: {
      midi: {
        bpm: 120,
        notes: [
          {
            id: 'note-a',
            lengthTicks: 960,
            pitch: 60,
            startTick: 0,
            velocity: 100,
          },
        ],
        ticksPerQuarter: 960,
      },
      source: {
        artifactId: 'artifact-midi-a',
        clipId: 'clip-midi-a',
        clipTakeId: 'clip-take-midi-a',
        contentHash: 'test-midi-content-hash',
        label: 'Generated Take 01',
        revision: 1,
        sourceType: 'job',
      },
    },
    preset: {
      bank: 0,
      program: 24,
    },
    providerId: 'mock-provider',
    providerVersion: '1',
    sampleRate: 8_000,
  });
}

function createStableAudio3JobRequest(): LocalEngineStableAudio3JobRequest {
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
    modelId: 'stable-audio-3-medium',
    modelRevision: 'a'.repeat(40),
    output: {
      artifactKind: 'audio',
      destination: 'stable-audio-3',
      extension: '.wav',
    },
    parameters: {
      channels: 2,
      durationSeconds: 12,
      prompt: 'Warm electric bass with a tight pocket',
      sampleRate: 44_100,
      seed: 7,
      sourceEndSeconds: 12,
      sourceStartSeconds: 0,
      strength: 0.4,
    },
    providerId: 'local-stable-audio-3',
    taskId: 'audio-to-audio',
  };
}

function createAceStepJobRequestInputFixture(): LocalEngineAceStepJobRequest {
  const lyricsArtifactId = 'artifact-12345678-1234-4abc-8def-1234567890ab';

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
        artifactId: lyricsArtifactId,
        kind: 'lyrics',
        relativePath: `renders/ace-step/lyrics/${lyricsArtifactId}.txt`,
      },
    ],
    lineage: {
      parentArtifactIds: ['artifact-guide-a', lyricsArtifactId],
      parentClipTakeIds: ['clip-take-midi-a'],
    },
    modelId: 'acestep-v15-base',
    modelRevision: 'e432212fec32b8965a14ffa57ae653438d6abd14',
    output: {
      artifactKind: 'audio',
      destination: 'ace-step',
      extension: '.wav',
    },
    parameters: {
      audioFormat: 'wav',
      batchSize: 1,
      caption: 'Warm intimate lead vocal following the corrected melody',
      channels: 2,
      durationSeconds: 10,
      sampleRate: 48_000,
      seed: 1_370_421,
      targetTrack: 'vocals',
      taskType: 'lego',
      thinking: false,
      vocalLanguage: 'en',
    },
    providerId: 'local-ace-step',
    taskId: 'guide-audio-to-vocals',
  };
}

function createGpuJobRecord(
  request:
    | LocalEngineMockJobRequest
    | LocalEngineMockHumToMidiJobRequest
    | LocalEngineBasicPitchHumToMidiJobRequest
    | LocalEngineInstrumentRenderJobRequest
    | LocalEngineAceStepJobRequest
    | LocalEngineStableAudio3JobRequest = createMockJobRequest(),
) {
  const timestamp = '2026-07-23T00:00:00.000Z';
  return {
    attempt: 1,
    createdAt: timestamp,
    history: [{ attempt: 1, at: timestamp, state: 'QUEUED' }],
    jobId: 'job-client-test',
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    providerId: request.providerId,
    request,
    state: 'QUEUED',
    taskId: request.taskId,
    updatedAt: timestamp,
  };
}
