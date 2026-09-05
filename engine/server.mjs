import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCAL_ENGINE_ACE_STEP_LYRICS_PATH,
  LOCAL_ENGINE_AUDIO_FILES_PATH,
  LOCAL_ENGINE_BASIC_PITCH_RUNTIME_PATH,
  LOCAL_ENGINE_DEFAULT_PORT,
  LOCAL_ENGINE_DEFAULT_UI_ORIGIN,
  LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH,
  LOCAL_ENGINE_GENERATED_AUDIO_PATH,
  LOCAL_ENGINE_HEALTH_PATH,
  LOCAL_ENGINE_HOST,
  LOCAL_ENGINE_JOBS_PATH,
  LOCAL_ENGINE_PRINT_MIXES_PATH,
  LOCAL_ENGINE_PROJECT_FILE_PATH,
  LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH,
  LOCAL_ENGINE_PROJECT_STEM_PRINTS_PATH,
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
  MAX_PROJECT_MIXDOWN_REQUEST_BYTES,
} from '../shared/projectMixdownApiProtocol.js';
import {
  MAX_PROJECT_STEM_PRINT_REQUEST_BYTES,
} from '../shared/projectStemPrintApiProtocol.js';
import {
  MAX_PRINT_MIX_REQUEST_BYTES,
} from '../shared/printMixProtocol.js';
import {
  AceStepLyricsArtifactWriter,
  AceStepLyricsValidationError,
  MAX_ACE_STEP_LYRICS_REQUEST_BYTES,
} from './aceStepLyricsArtifactWriter.mjs';
import {
  AudioArtifactFileDeleter,
  AudioArtifactFileDeletionError,
  MAX_AUDIO_FILE_DELETE_REQUEST_BYTES,
} from './audioArtifactFileDeleter.mjs';
import {
  GeneratedAudioReader,
  GeneratedAudioReadError,
  MAX_GENERATED_AUDIO_AVAILABILITY_REQUEST_BYTES,
  MAX_GENERATED_AUDIO_READ_REQUEST_BYTES,
} from './generatedAudioReader.mjs';
import {
  AtomicProjectFileStore,
  MAX_PROJECT_FILE_BYTES,
  ProjectFileNotFoundError,
  ProjectFileReadError,
  ProjectFileTooLargeError,
  ProjectFileValidationError,
  ProjectRootRequiredError,
} from './atomicProjectFileStore.mjs';
import {
  ProjectRootAuthority,
  resolveDefaultProjectRootStateFilePath,
  resolveProjectPath,
} from './projectRootAuthority.mjs';
import {
  createDefaultSoundFontBuiltinDefinition,
} from './defaultSoundFontProvisioner.mjs';
import {
  GeneratedArtifactFinalizationError,
  GeneratedArtifactFinalizer,
} from './generatedArtifactFinalizer.mjs';
import {
  localEngineLogger,
  toDiagnosticErrorFields,
} from './diagnosticLogger.mjs';
import {
  ProjectMixdownOperationCoordinator,
  ProjectMixdownOperationError,
} from './projectMixdownOperationCoordinator.mjs';
import { ProjectMixdownService } from './projectMixdownService.mjs';
import { ProjectMixdownWorkerClient } from './projectMixdownWorkerClient.mjs';
import {
  PrintMixOperationCoordinator,
  PrintMixService,
} from './printMixService.mjs';
import { GpuJobQueue, GpuJobQueueError } from './jobs/gpuJobQueue.mjs';
import {
  AceStepJobExecutor,
  AceStepJobExecutorError,
} from './jobs/aceStepJobExecutor.mjs';
import {
  BasicPitchJobExecutor,
  BasicPitchJobExecutorError,
} from './jobs/basicPitchJobExecutor.mjs';
import {
  FluidSynthJobExecutor,
  FluidSynthJobExecutorError,
} from './jobs/fluidSynthJobExecutor.mjs';
import { JobRecordValidationError } from './jobs/jobRecord.mjs';
import {
  MockProviderJobExecutor,
  MockProviderJobExecutorError,
} from './jobs/mockProviderJobExecutor.mjs';
import {
  RoutedJobExecutor,
  RoutedJobExecutorError,
} from './jobs/routedJobExecutor.mjs';
import {
  StableAudio3JobExecutor,
  StableAudio3JobExecutorError,
} from './jobs/stableAudio3JobExecutor.mjs';
import { ProviderContractValidationError } from './providers/providerContract.mjs';
import { BasicPitchRuntimeInspector } from './providers/basicPitchRuntimeInspector.mjs';
import {
  MAX_RECORDING_WAV_BYTES,
  RecordingArtifactWriter,
  RecordingWavValidationError,
} from './recordingArtifactWriter.mjs';
import {
  MAX_SOURCE_RESTORE_REQUEST_BYTES,
  SourceRestorationService,
  SourceRestorationValidationError,
} from './sourceRestorationService.mjs';
import {
  SoundFontCatalog,
  SoundFontCatalogError,
} from './soundFontCatalog.mjs';
import {
  MAX_SOUNDFONT_AUDITION_REQUEST_BYTES,
  SoundFontAuditionError,
  SoundFontAuditionService,
} from './soundFontAuditionService.mjs';
import { FluidSynthRuntimeError } from './fluidSynthRuntime.mjs';
import { FluidSynthLiveHostRuntimeError } from './fluidSynthLiveHostRuntime.mjs';
import {
  MAX_SOUNDFONT_LIVE_PREVIEW_REQUEST_BYTES,
  SoundFontLivePreviewError,
  SoundFontLivePreviewService,
} from './soundFontLivePreviewService.mjs';
import {
  MAX_SOUNDFONT_PRESET_CATALOG_REQUEST_BYTES,
  SoundFontPresetCatalogError,
  SoundFontPresetCatalogService,
} from './soundFontPresetCatalogService.mjs';
import { ProductionUiFileServer } from './productionUiFileServer.mjs';
import { selectWindowsProjectRoot } from './windowsDirectoryPicker.mjs';

const MINIMUM_TOKEN_LENGTH = 32;
const MAX_JOB_REQUEST_BYTES = 65_536;
const ROOT_BLOCKING_JOB_STATES = new Set([
  'QUEUED',
  'LOADING_MODEL',
  'PROCESSING',
  'SAVING',
  'CANCEL_REQUESTED',
]);
export async function startLocalEngineServer({
  aceStepJobExecutor,
  aceStepLyricsArtifactWriter,
  allowedOrigin = LOCAL_ENGINE_DEFAULT_UI_ORIGIN,
  audioArtifactFileDeleter,
  basicPitchJobExecutor,
  basicPitchRuntimeInspector,
  builtinSoundFonts = [],
  port = LOCAL_ENGINE_DEFAULT_PORT,
  generatedAudioReader,
  generatedArtifactFinalizer,
  gpuJobQueue,
  fluidSynthJobExecutor,
  mockProviderJobExecutor,
  projectRootAuthority = new ProjectRootAuthority({
    stateFilePath: resolveDefaultProjectRootStateFilePath(),
  }),
  projectFileStore,
  printMixService,
  projectMixdownService,
  projectMixdownWorkerClient,
  uiRootPath,
  recordingArtifactWriter,
  selectProjectRoot = selectWindowsProjectRoot,
  soundFontAuditionService,
  soundFontCatalog,
  soundFontLivePreviewService,
  soundFontPresetCatalogService,
  sourceRestorationService,
  stableAudio3JobExecutor,
  token,
} = {}) {
  const validatedOrigin = validateAllowedOrigin(allowedOrigin);
  const validatedPort = validatePort(port);
  const validatedToken = validateToken(token);
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const engineState = { activity: 'IDLE', activeOperation: undefined, isClosing: false };
  const resolvedAudioArtifactFileDeleter =
    audioArtifactFileDeleter ??
    new AudioArtifactFileDeleter({ projectRootAuthority });
  const resolvedBasicPitchRuntimeInspector =
    basicPitchRuntimeInspector ?? new BasicPitchRuntimeInspector();
  const resolvedProjectFileStore =
    projectFileStore ?? new AtomicProjectFileStore({ projectRootAuthority });
  const resolvedGeneratedArtifactFinalizer =
    generatedArtifactFinalizer ?? new GeneratedArtifactFinalizer({ projectRootAuthority });
  const resolvedAceStepLyricsArtifactWriter =
    aceStepLyricsArtifactWriter ??
    new AceStepLyricsArtifactWriter({
      generatedArtifactFinalizer: resolvedGeneratedArtifactFinalizer,
    });
  const resolvedGeneratedAudioReader =
    generatedAudioReader ?? new GeneratedAudioReader({ projectRootAuthority });
  const resolvedProjectMixdownService =
    projectMixdownService ??
    new ProjectMixdownService({
      generatedArtifactFinalizer: resolvedGeneratedArtifactFinalizer,
      generatedAudioReader: resolvedGeneratedAudioReader,
      mixdownRenderer:
        projectMixdownWorkerClient ?? new ProjectMixdownWorkerClient(),
    });
  const resolvedPrintMixService =
    printMixService ??
    new PrintMixService({
      generatedArtifactFinalizer: resolvedGeneratedArtifactFinalizer,
      generatedAudioReader: resolvedGeneratedAudioReader,
    });
  const resolvedRecordingArtifactWriter =
    recordingArtifactWriter ??
    new RecordingArtifactWriter({
      generatedArtifactFinalizer: resolvedGeneratedArtifactFinalizer,
    });
  const resolvedSourceRestorationService =
    sourceRestorationService ?? new SourceRestorationService({ projectRootAuthority });
  const resolvedSoundFontCatalog =
    soundFontCatalog ??
    new SoundFontCatalog({ builtinSoundFonts, projectRootAuthority });
  const resolvedSoundFontAuditionService =
    soundFontAuditionService ??
    new SoundFontAuditionService({
      soundFontCatalog: resolvedSoundFontCatalog,
    });
  const resolvedSoundFontLivePreviewService =
    soundFontLivePreviewService ??
    new SoundFontLivePreviewService({
      soundFontCatalog: resolvedSoundFontCatalog,
    });
  const resolvedSoundFontPresetCatalogService =
    soundFontPresetCatalogService ??
    new SoundFontPresetCatalogService({
      soundFontCatalog: resolvedSoundFontCatalog,
    });
  const resolvedGpuJobQueue =
    gpuJobQueue ??
    new GpuJobQueue({
      executor: new RoutedJobExecutor({
        executors: [
          aceStepJobExecutor ??
            new AceStepJobExecutor({
              generatedArtifactFinalizer: resolvedGeneratedArtifactFinalizer,
              projectRootAuthority,
            }),
          mockProviderJobExecutor ??
            new MockProviderJobExecutor({
              generatedArtifactFinalizer: resolvedGeneratedArtifactFinalizer,
              projectRootAuthority,
            }),
          basicPitchJobExecutor ??
            new BasicPitchJobExecutor({ projectRootAuthority }),
          fluidSynthJobExecutor ??
            new FluidSynthJobExecutor({
              generatedArtifactFinalizer: resolvedGeneratedArtifactFinalizer,
              soundFontAuditionService: resolvedSoundFontAuditionService,
            }),
          stableAudio3JobExecutor ??
            new StableAudio3JobExecutor({
              generatedArtifactFinalizer: resolvedGeneratedArtifactFinalizer,
              projectRootAuthority,
            }),
        ],
      }),
    });
  const projectMixdownOperations = new ProjectMixdownOperationCoordinator({
    onActiveChange: (isActive, _operationId, operationKind) => {
      if (isActive) {
        engineState.activity = 'BUSY';
        engineState.activeOperation = operationKind === 'stem-print'
          ? 'PROJECT_STEM_PRINT'
          : 'PROJECT_MIXDOWN';
      } else if (
        engineState.activeOperation === 'PROJECT_MIXDOWN' ||
        engineState.activeOperation === 'PROJECT_STEM_PRINT'
      ) {
        engineState.activity = 'IDLE';
        engineState.activeOperation = undefined;
      }
    },
    projectMixdownService: resolvedProjectMixdownService,
  });
  const printMixOperations = new PrintMixOperationCoordinator({
    onActiveChange: (isActive) => {
      if (isActive) {
        engineState.activity = 'BUSY';
        engineState.activeOperation = 'PRINT_MIX';
      } else if (engineState.activeOperation === 'PRINT_MIX') {
        engineState.activity = 'IDLE';
        engineState.activeOperation = undefined;
      }
    },
    service: resolvedPrintMixService,
  });
  const productionUiFileServer =
    uiRootPath === undefined
      ? undefined
      : await ProductionUiFileServer.create({ rootPath: uiRootPath });

  await projectRootAuthority.restore();

  const requestContext = {
    allowedOrigin: validatedOrigin,
    aceStepLyricsArtifactWriter: resolvedAceStepLyricsArtifactWriter,
    audioArtifactFileDeleter: resolvedAudioArtifactFileDeleter,
    basicPitchRuntimeInspector: resolvedBasicPitchRuntimeInspector,
    engineState,
    generatedAudioReader: resolvedGeneratedAudioReader,
    instanceId,
    projectFileStore: resolvedProjectFileStore,
    printMixOperations,
    productionUiFileServer,
    projectMixdownOperations,
    generatedArtifactFinalizer: resolvedGeneratedArtifactFinalizer,
    gpuJobQueue: resolvedGpuJobQueue,
    projectRootAuthority,
    recordingArtifactWriter: resolvedRecordingArtifactWriter,
    selectProjectRoot,
    soundFontAuditionService: resolvedSoundFontAuditionService,
    soundFontCatalog: resolvedSoundFontCatalog,
    soundFontLivePreviewService: resolvedSoundFontLivePreviewService,
    soundFontPresetCatalogService: resolvedSoundFontPresetCatalogService,
    sourceRestorationService: resolvedSourceRestorationService,
    startedAt,
    token: validatedToken,
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, requestContext).catch((error) => {
      localEngineLogger.error('ENGINE', 'REQUEST_FAILED', {
        ...toDiagnosticErrorFields(error),
      });
      if (!response.writableEnded) {
        sendJson(response, 500, {
          code: 'ENGINE_REQUEST_FAILED',
          message: error instanceof Error ? error.message : 'Local Engine request failed.',
        });
      }
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      rejectListen(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolveListen();
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(validatedPort, LOCAL_ENGINE_HOST);
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Local Engine failed to resolve its loopback address.');
  }

  localEngineLogger.info('ENGINE', 'ENGINE_READY', {
    instanceId,
    port: address.port,
    protocolVersion: LOCAL_ENGINE_PROTOCOL_VERSION,
    status: 'READY',
  });

  let closePromise;
  const close = () => {
    if (!closePromise) {
      engineState.isClosing = true;
      localEngineLogger.info('ENGINE', 'ENGINE_STOPPING', {
        instanceId,
        port: address.port,
        status: 'STOPPING',
      });
      closePromise = closeLocalEngine(
        server,
        printMixOperations,
        projectMixdownOperations,
        resolvedGpuJobQueue,
        resolvedBasicPitchRuntimeInspector,
        resolvedGeneratedArtifactFinalizer,
        resolvedSoundFontAuditionService,
        resolvedSoundFontLivePreviewService,
      ).then(
        () => {
          localEngineLogger.info('ENGINE', 'ENGINE_STOPPED', {
            instanceId,
            port: address.port,
            status: 'STOPPED',
          });
        },
        (error) => {
          localEngineLogger.error('ENGINE', 'ENGINE_STOP_FAILED', {
            ...toDiagnosticErrorFields(error),
            instanceId,
            port: address.port,
          });
          throw error;
        },
      );
    }

    return closePromise;
  };
  const runGeneratedArtifactAction = (action) => {
    if (engineState.isClosing) {
      return Promise.reject(new Error('Local Engine is closing and cannot accept generated files.'));
    }

    return action();
  };
  const runJobAction = (action) => {
    if (engineState.isClosing) {
      throw new Error('Local Engine is closing and cannot accept GPU Job actions.');
    }

    return action();
  };

  return Object.freeze({
    generatedArtifacts: Object.freeze({
      discard: (reservationId) =>
        runGeneratedArtifactAction(() => resolvedGeneratedArtifactFinalizer.discard(reservationId)),
      finalize: (reservationId) =>
        runGeneratedArtifactAction(() => resolvedGeneratedArtifactFinalizer.finalize(reservationId)),
      getActiveReservationCount: () =>
        resolvedGeneratedArtifactFinalizer.getActiveReservationCount(),
      reserve: (options) =>
        runGeneratedArtifactAction(() => resolvedGeneratedArtifactFinalizer.reserve(options)),
    }),
    baseUrl: `http://${LOCAL_ENGINE_HOST}:${address.port}`,
    instanceId,
    jobs: Object.freeze({
      enqueue: (request) => runJobAction(() => resolvedGpuJobQueue.enqueue(request)),
      getJob: (jobId) => resolvedGpuJobQueue.getJob(jobId),
      getSnapshot: () => resolvedGpuJobQueue.getSnapshot(),
      removeQueued: (jobId) =>
        runJobAction(() => resolvedGpuJobQueue.removeQueued(jobId)),
      requestCancel: (jobId) =>
        runJobAction(() => resolvedGpuJobQueue.requestCancel(jobId)),
      retry: (jobId) => runJobAction(() => resolvedGpuJobQueue.retry(jobId)),
    }),
    port: address.port,
    close,
    getProjectRootSnapshot: () => projectRootAuthority.getSnapshot(),
  });
}

async function handleRequest(request, response, context) {
  const requestOrigin = readHeader(request.headers.origin);

  if (requestOrigin && requestOrigin !== context.allowedOrigin) {
    sendJson(response, 403, { code: 'ORIGIN_REJECTED', message: 'UI origin is not allowed.' });
    return;
  }

  if (requestOrigin) {
    applyCorsHeaders(response, context.allowedOrigin);
  }

  const requestUrl = new URL(request.url ?? '/', `http://${LOCAL_ENGINE_HOST}`);
  const jobRoute = matchJobRoute(requestUrl.pathname);
  const isSupportedPath =
    requestUrl.pathname === LOCAL_ENGINE_HEALTH_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_ACE_STEP_LYRICS_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_AUDIO_FILES_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_BASIC_PITCH_RUNTIME_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_GENERATED_AUDIO_PATH ||
    jobRoute !== undefined ||
    requestUrl.pathname === LOCAL_ENGINE_PROJECT_FILE_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_PRINT_MIXES_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_PROJECT_STEM_PRINTS_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_PROJECT_ROOT_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_RECORDINGS_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_SOUNDFONT_AUDITION_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_SOUNDFONT_LIVE_PREVIEW_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_SOUNDFONT_PRESETS_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_SOUNDFONTS_PATH ||
    requestUrl.pathname === LOCAL_ENGINE_SOURCE_RESTORE_PATH;

  if (!isSupportedPath) {
    if (
      context.productionUiFileServer &&
      !requestUrl.pathname.startsWith('/api/')
    ) {
      await context.productionUiFileServer.serve(request, response, requestUrl);
      return;
    }

    sendJson(response, 404, { code: 'NOT_FOUND', message: 'Local Engine endpoint not found.' });
    return;
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestToken = readHeader(request.headers[LOCAL_ENGINE_TOKEN_HEADER]);

  if (!tokensMatch(requestToken, context.token)) {
    sendJson(response, 401, { code: 'UNAUTHORIZED', message: 'A valid launch token is required.' });
    return;
  }

  if (context.engineState.isClosing && request.method !== 'GET') {
    sendJson(response, 503, {
      code: 'ENGINE_CLOSING',
      message: 'Local Engine is closing and cannot accept mutations.',
    });
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_HEALTH_PATH) {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'GET, OPTIONS', 'Use GET for Health Check.');
      return;
    }

    sendJson(response, 200, {
      activity: getEngineActivity(context),
      engineVersion: LOCAL_ENGINE_VERSION,
      instanceId: context.instanceId,
      lifecycle: context.engineState.isClosing ? 'STOPPING' : 'READY',
      protocolVersion: LOCAL_ENGINE_PROTOCOL_VERSION,
      startedAt: context.startedAt,
    });
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_BASIC_PITCH_RUNTIME_PATH) {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(
        response,
        'GET, OPTIONS',
        'Use GET to inspect the Basic Pitch Runtime.',
      );
      return;
    }

    sendJson(response, 200, {
      runtime: await context.basicPitchRuntimeInspector.inspect(),
    });
    return;
  }

  if (jobRoute) {
    await handleJobRequest(request, response, context, jobRoute);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_ACE_STEP_LYRICS_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(
        response,
        'POST, OPTIONS',
        'Use POST to save one immutable ACE-Step Lyrics snapshot.',
      );
      return;
    }

    await handleAceStepLyricsSave(request, response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_AUDIO_FILES_PATH) {
    if (request.method !== 'DELETE') {
      sendMethodNotAllowed(
        response,
        'DELETE, OPTIONS',
        'Use DELETE to remove one validated Audio Artifact file.',
      );
      return;
    }

    await handleAudioArtifactFileDeletion(request, response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_GENERATED_AUDIO_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(
        response,
        'POST, OPTIONS',
        'Use POST to read generated WAV audio.',
      );
      return;
    }

    await handleGeneratedAudioRead(request, response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(
        response,
        'POST, OPTIONS',
        'Use POST to verify generated WAV availability.',
      );
      return;
    }

    await handleGeneratedAudioAvailability(request, response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_PROJECT_ROOT_PATH) {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'GET, OPTIONS', 'Use GET to inspect Project Root.');
      return;
    }

    sendJson(response, 200, context.projectRootAuthority.getSnapshot());
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_SOUNDFONTS_PATH) {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(
        response,
        'GET, OPTIONS',
        'Use GET to list built-in and custom SoundFonts.',
      );
      return;
    }

    await handleSoundFontCatalogRequest(response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_SOUNDFONT_AUDITION_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(
        response,
        'POST, OPTIONS',
        'Use POST to render a temporary SoundFont audition.',
      );
      return;
    }

    await handleSoundFontAudition(request, response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_SOUNDFONT_PRESETS_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(
        response,
        'POST, OPTIONS',
        'Use POST to list presets from one verified SoundFont.',
      );
      return;
    }

    await handleSoundFontPresetCatalog(request, response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_SOUNDFONT_LIVE_PREVIEW_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(
        response,
        'POST, OPTIONS',
        'Use POST to control SoundFont Live Preview.',
      );
      return;
    }

    await handleSoundFontLivePreview(request, response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_PROJECT_FILE_PATH) {
    if (request.method === 'GET') {
      await handleProjectFileLoad(response, context);
    } else if (request.method === 'PUT') {
      await handleProjectFileSave(request, response, context);
    } else {
      sendMethodNotAllowed(
        response,
        'GET, PUT, OPTIONS',
        'Use GET to open or PUT to save the current Project JSON.',
      );
    }
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_PRINT_MIXES_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(
        response,
        'POST, OPTIONS',
        'Use POST to start or recover one Audio PRINT MIX operation.',
      );
      return;
    }

    await handlePrintMix(request, response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(
        response,
        'POST, OPTIONS',
        'Use POST to start or recover one Project Mixdown operation.',
      );
      return;
    }

    await handleProjectMixdown(request, response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_PROJECT_STEM_PRINTS_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(
        response,
        'POST, OPTIONS',
        'Use POST to start or recover one Project Stem Print operation.',
      );
      return;
    }

    await handleProjectStemPrint(request, response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_RECORDINGS_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'POST, OPTIONS', 'Use POST to save a recording WAV.');
      return;
    }

    await handleRecordingUpload(request, response, context);
    return;
  }

  if (requestUrl.pathname === LOCAL_ENGINE_SOURCE_RESTORE_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'POST, OPTIONS', 'Use POST to restore source availability.');
      return;
    }

    await handleSourceRestoration(request, response, context);
    return;
  }

  if (request.method !== 'POST') {
    sendMethodNotAllowed(response, 'POST, OPTIONS', 'Use POST to select Project Root.');
    return;
  }

  await handleProjectRootSelection(response, context);
}

async function handlePrintMix(request, response, context) {
  const contentType = readHeader(request.headers['content-type'])
    .split(';', 1)[0]
    .toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'PRINT_MIX_CONTENT_TYPE_REQUIRED',
      message: 'Audio PRINT MIX requires Content-Type: application/json.',
    });
    return;
  }

  const abortController = new AbortController();
  const handleRequestAbort = () => abortController.abort();
  const handleResponseClose = () => {
    if (!response.writableEnded) {
      abortController.abort();
    }
  };

  request.once('aborted', handleRequestAbort);
  response.once('close', handleResponseClose);

  try {
    const body = await readJsonRequestBody(
      request,
      MAX_PRINT_MIX_REQUEST_BYTES,
      'Audio PRINT MIX JSON',
    );
    const operation = await context.printMixOperations.execute(body, {
      abortController,
      getBlockingOperation: () => {
        if (context.engineState.activeOperation) {
          return context.engineState.activeOperation;
        }

        return hasRootBlockingGpuJobs(context.gpuJobQueue.getSnapshot())
          ? 'GPU_JOB_QUEUE'
          : undefined;
      },
    });

    if (!response.destroyed && !response.writableEnded) {
      sendJson(response, 200, operation);
    }
  } catch (error) {
    if (response.destroyed || response.writableEnded) {
      return;
    }

    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {
        code: 'PRINT_MIX_REQUEST_TOO_LARGE',
        message: error.message,
      });
    } else if (error instanceof RequestBodyJsonError) {
      sendJson(response, 400, {
        code: 'PRINT_MIX_REQUEST_INVALID',
        message: error.message,
      });
    } else {
      sendPrintMixError(response, error);
    }
  } finally {
    request.off('aborted', handleRequestAbort);
    response.off('close', handleResponseClose);
  }
}

const PRINT_MIX_ERROR_RESPONSES = Object.freeze({
  ARTIFACT_DESTINATION_EXISTS: [409, 'Audio PRINT MIX destination already exists.'],
  ARTIFACT_RESERVATION_BUSY: [409, 'Audio PRINT MIX staging reservation is busy.'],
  ARTIFACT_STAGING_EMPTY: [500, 'Audio PRINT MIX staging output is empty.'],
  ARTIFACT_STAGING_INVALID: [500, 'Audio PRINT MIX staging output is invalid.'],
  ARTIFACT_STAGING_MISSING: [500, 'Audio PRINT MIX staging output is missing.'],
  ENGINE_CLOSING: [503, 'Local Engine is closing and cannot start Audio PRINT MIX.'],
  ENGINE_OPERATION_ACTIVE: [409, 'Local Engine is busy with another operation.'],
  GENERATED_AUDIO_METADATA_MISMATCH: [409, 'A PRINT MIX source no longer matches the Plan.'],
  GENERATED_AUDIO_NOT_FOUND: [404, 'A required PRINT MIX source is unavailable.'],
  GENERATED_AUDIO_OUTSIDE_PROJECT_ROOT: [403, 'A PRINT MIX source is outside Project Root authority.'],
  GENERATED_AUDIO_REQUEST_INVALID: [400, 'A PRINT MIX source descriptor is invalid.'],
  GENERATED_AUDIO_UNOPENABLE: [409, 'A required PRINT MIX source could not be opened.'],
  GENERATED_AUDIO_WAV_INVALID: [422, 'A PRINT MIX source WAV is invalid.'],
  PRINT_MIX_ABORTED: [409, 'Audio PRINT MIX was canceled before finalization completed.'],
  PRINT_MIX_EXECUTION_INVALID: [400, 'Audio PRINT MIX execution identity is invalid.'],
  PRINT_MIX_FINALIZED_ARTIFACT_INVALID: [502, 'Audio PRINT MIX finalized metadata is invalid.'],
  PRINT_MIX_OPERATION_BUSY: [409, 'Another PRINT MIX operation is active.'],
  PRINT_MIX_OPERATION_CONFLICT: [409, 'PRINT MIX operationId is already bound to a different immutable Plan.'],
  PRINT_MIX_OUTCOME_UNKNOWN: [409, 'Audio PRINT MIX outcome is unknown; recover with the same operationId.'],
  PRINT_MIX_PLAN_INVALID: [400, 'Audio PRINT MIX Plan is invalid.'],
  PRINT_MIX_RENDER_RESULT_INVALID: [502, 'Audio PRINT MIX renderer returned an invalid result.'],
  PRINT_MIX_REQUEST_INVALID: [400, 'Audio PRINT MIX Request is invalid.'],
  PRINT_MIX_SERVICE_BUSY: [409, 'Audio PRINT MIX service is busy.'],
  PRINT_MIX_SOURCE_INVALID: [422, 'Audio PRINT MIX source bytes do not match the Plan.'],
  PRINT_MIX_SOURCE_READ_INVALID: [422, 'Audio PRINT MIX source could not be read safely.'],
  PRINT_MIX_SOURCE_WAV_INVALID: [422, 'Audio PRINT MIX source WAV is unsupported or malformed.'],
  PROJECT_ROOT_REQUIRED: [409, 'Select a Project Root before starting Audio PRINT MIX.'],
});

function sendPrintMixError(response, error) {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const mapped = code ? PRINT_MIX_ERROR_RESPONSES[code] : undefined;

  if (mapped) {
    sendJson(response, mapped[0], { code, message: mapped[1] });
    return;
  }

  sendJson(response, 500, {
    code: 'PRINT_MIX_FAILED',
    message: 'Audio PRINT MIX failed.',
  });
}

async function handleProjectMixdown(request, response, context) {
  const contentType = readHeader(request.headers['content-type'])
    .split(';', 1)[0]
    .toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'PROJECT_MIXDOWN_CONTENT_TYPE_REQUIRED',
      message: 'Project Mixdown requires Content-Type: application/json.',
    });
    return;
  }

  const abortController = new AbortController();
  const handleRequestAbort = () => abortController.abort();
  const handleResponseClose = () => {
    if (!response.writableEnded) {
      abortController.abort();
    }
  };

  request.once('aborted', handleRequestAbort);
  response.once('close', handleResponseClose);

  try {
    const body = await readJsonRequestBody(
      request,
      MAX_PROJECT_MIXDOWN_REQUEST_BYTES,
      'Project Mixdown JSON',
    );
    const operation = await context.projectMixdownOperations.execute(body, {
      abortController,
      getBlockingOperation: () => {
        if (context.engineState.activeOperation) {
          return context.engineState.activeOperation;
        }

        return hasRootBlockingGpuJobs(context.gpuJobQueue.getSnapshot())
          ? 'GPU_JOB_QUEUE'
          : undefined;
      },
    });

    if (!response.destroyed && !response.writableEnded) {
      sendJson(response, 200, operation);
    }
  } catch (error) {
    if (response.destroyed || response.writableEnded) {
      return;
    }

    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {
        code: 'PROJECT_MIXDOWN_REQUEST_TOO_LARGE',
        message: error.message,
      });
    } else if (error instanceof RequestBodyJsonError) {
      sendJson(response, 400, {
        code: 'PROJECT_MIXDOWN_REQUEST_INVALID',
        message: error.message,
      });
    } else if (error instanceof ProjectMixdownOperationError) {
      sendJson(response, error.statusCode, {
        code: error.code,
        message: error.message,
      });
    } else {
      sendJson(response, 500, {
        code: 'PROJECT_MIXDOWN_FAILED',
        message: 'Project Mixdown failed.',
      });
    }
  } finally {
    request.off('aborted', handleRequestAbort);
    response.off('close', handleResponseClose);
  }
}

async function handleProjectStemPrint(request, response, context) {
  const contentType = readHeader(request.headers['content-type'])
    .split(';', 1)[0]
    .toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'PROJECT_STEM_PRINT_CONTENT_TYPE_REQUIRED',
      message: 'Project Stem Print requires Content-Type: application/json.',
    });
    return;
  }

  const abortController = new AbortController();
  const handleRequestAbort = () => abortController.abort();
  const handleResponseClose = () => {
    if (!response.writableEnded) {
      abortController.abort();
    }
  };

  request.once('aborted', handleRequestAbort);
  response.once('close', handleResponseClose);

  try {
    const body = await readJsonRequestBody(
      request,
      MAX_PROJECT_STEM_PRINT_REQUEST_BYTES,
      'Project Stem Print JSON',
    );
    const operation = await context.projectMixdownOperations.executeStemPrint(
      body,
      {
        abortController,
        getBlockingOperation: () => {
          if (context.engineState.activeOperation) {
            return context.engineState.activeOperation;
          }

          return hasRootBlockingGpuJobs(context.gpuJobQueue.getSnapshot())
            ? 'GPU_JOB_QUEUE'
            : undefined;
        },
      },
    );

    if (!response.destroyed && !response.writableEnded) {
      sendJson(response, 200, operation);
    }
  } catch (error) {
    if (response.destroyed || response.writableEnded) {
      return;
    }

    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {
        code: 'PROJECT_STEM_PRINT_REQUEST_TOO_LARGE',
        message: error.message,
      });
    } else if (error instanceof RequestBodyJsonError) {
      sendJson(response, 400, {
        code: 'PROJECT_STEM_PRINT_REQUEST_INVALID',
        message: error.message,
      });
    } else if (error instanceof ProjectMixdownOperationError) {
      sendJson(response, error.statusCode, {
        code: error.code,
        message: error.message,
      });
    } else {
      sendJson(response, 500, {
        code: 'PROJECT_STEM_PRINT_FAILED',
        message: 'Project Stem Print failed.',
      });
    }
  } finally {
    request.off('aborted', handleRequestAbort);
    response.off('close', handleResponseClose);
  }
}

async function handleJobRequest(request, response, context, route) {
  if (route.kind === 'collection') {
    if (request.method === 'GET') {
      sendJson(response, 200, context.gpuJobQueue.getSnapshot());
      return;
    }

    if (request.method !== 'POST') {
      sendMethodNotAllowed(
        response,
        'GET, POST, OPTIONS',
        'Use GET to inspect Jobs or POST to enqueue a Job.',
      );
      return;
    }

    await handleJobEnqueue(request, response, context);
    return;
  }

  if (route.kind === 'item') {
    if (request.method !== 'DELETE') {
      sendMethodNotAllowed(
        response,
        'DELETE, OPTIONS',
        'Use DELETE to remove a waiting GPU Job.',
      );
      return;
    }

    try {
      const removedJob = context.gpuJobQueue.removeQueued(route.jobId);
      sendJson(response, 200, { removedJob });
    } catch (error) {
      sendGpuJobError(response, error, 'GPU Job removal failed.');
    }
    return;
  }

  if (request.method !== 'POST') {
    sendMethodNotAllowed(response, 'POST, OPTIONS', `Use POST to ${route.action} a GPU Job.`);
    return;
  }

  try {
    const job =
      route.action === 'cancel'
        ? await context.gpuJobQueue.requestCancel(route.jobId)
        : context.gpuJobQueue.retry(route.jobId);
    sendJson(response, 200, { job });
  } catch (error) {
    sendGpuJobError(response, error, `GPU Job ${route.action} failed.`);
  }
}

async function handleJobEnqueue(request, response, context) {
  if (context.engineState.activeOperation) {
    sendJson(response, 409, {
      code: 'ENGINE_OPERATION_ACTIVE',
      message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
    });
    return;
  }

  if (context.projectRootAuthority.getSnapshot().status !== 'READY') {
    sendJson(response, 409, {
      code: 'PROJECT_ROOT_REQUIRED',
      message: 'Select Project Root before enqueueing a GPU Job.',
    });
    return;
  }

  const contentType = readHeader(request.headers['content-type']).split(';', 1)[0].toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'JOB_REQUEST_CONTENT_TYPE_REQUIRED',
      message: 'GPU Job enqueue requires Content-Type: application/json.',
    });
    return;
  }

  try {
    const body = await readJsonRequestBody(request, MAX_JOB_REQUEST_BYTES, 'GPU Job JSON');

    if (!isRecord(body) || !Object.hasOwn(body, 'request')) {
      throw new JobRecordValidationError(
        'JOB_REQUEST_INVALID',
        'GPU Job request body must be an object containing request.',
      );
    }

    if (context.engineState.activeOperation) {
      sendJson(response, 409, {
        code: 'ENGINE_OPERATION_ACTIVE',
        message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
      });
      return;
    }

    const job = context.gpuJobQueue.enqueue(body.request);
    sendJson(response, 202, { job });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, { code: 'JOB_REQUEST_TOO_LARGE', message: error.message });
    } else if (
      error instanceof RequestBodyJsonError ||
      error instanceof JobRecordValidationError ||
      error instanceof AceStepJobExecutorError ||
      error instanceof BasicPitchJobExecutorError ||
      error instanceof FluidSynthJobExecutorError ||
      error instanceof MockProviderJobExecutorError ||
      error instanceof ProviderContractValidationError ||
      error instanceof RoutedJobExecutorError ||
      error instanceof StableAudio3JobExecutorError
    ) {
      sendJson(response, 400, { code: 'JOB_REQUEST_INVALID', message: error.message });
    } else {
      sendGpuJobError(response, error, 'GPU Job enqueue failed.');
    }
  }
}

function sendGpuJobError(response, error, fallbackMessage) {
  if (error instanceof GpuJobQueueError) {
    sendJson(response, error.code === 'JOB_NOT_FOUND' ? 404 : 409, {
      code: error.code,
      message: error.message,
    });
    return;
  }

  sendJson(response, 500, {
    code: 'GPU_JOB_OPERATION_FAILED',
    message: error instanceof Error ? error.message : fallbackMessage,
  });
}

async function handleProjectRootSelection(response, context) {
  if (context.engineState.activeOperation) {
    sendJson(response, 409, {
      code: 'ENGINE_OPERATION_ACTIVE',
      message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
    });
    return;
  }

  if (hasRootBlockingGpuJobs(context.gpuJobQueue.getSnapshot())) {
    sendJson(response, 409, {
      code: 'GPU_JOB_QUEUE_ACTIVE',
      message: 'Finish or remove pending GPU Jobs before changing Project Root.',
    });
    return;
  }

  if (context.generatedArtifactFinalizer.hasActiveWork()) {
    sendJson(response, 409, {
      code: 'ARTIFACT_STAGING_ACTIVE',
      message: 'Discard or finalize staged generated files before changing Project Root.',
    });
    return;
  }

  context.engineState.activity = 'BUSY';
  context.engineState.activeOperation = 'PROJECT_ROOT_SELECTION';

  try {
    const selectedPath = await context.selectProjectRoot();

    if (!selectedPath) {
      sendJson(response, 200, {
        ...context.projectRootAuthority.getSnapshot(),
        selection: 'CANCELED',
      });
      return;
    }

    const projectRoot = await context.projectRootAuthority.configure(selectedPath);
    sendJson(response, 200, { ...projectRoot, selection: 'SELECTED' });
  } catch (error) {
    sendJson(response, 500, {
      code: 'PROJECT_ROOT_SELECTION_FAILED',
      message: error instanceof Error ? error.message : 'Project Root selection failed.',
    });
  } finally {
    context.engineState.activity = 'IDLE';
    context.engineState.activeOperation = undefined;
  }
}

async function handleProjectFileSave(request, response, context) {
  if (context.engineState.activeOperation) {
    sendJson(response, 409, {
      code: 'ENGINE_OPERATION_ACTIVE',
      message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
    });
    return;
  }

  const contentType = readHeader(request.headers['content-type']).split(';', 1)[0].toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'PROJECT_FILE_CONTENT_TYPE_REQUIRED',
      message: 'Project save requires Content-Type: application/json.',
    });
    return;
  }

  context.engineState.activity = 'BUSY';
  context.engineState.activeOperation = 'PROJECT_SAVE';

  try {
    const projectFile = await readJsonRequestBody(request, MAX_PROJECT_FILE_BYTES, 'Project JSON');
    const savedProject = await context.projectFileStore.save(projectFile);
    sendJson(response, 200, savedProject);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, { code: 'PROJECT_FILE_TOO_LARGE', message: error.message });
    } else if (error instanceof RequestBodyJsonError || error instanceof ProjectFileValidationError) {
      sendJson(response, 400, { code: 'PROJECT_FILE_INVALID', message: error.message });
    } else if (error instanceof ProjectRootRequiredError) {
      sendJson(response, 409, { code: 'PROJECT_ROOT_REQUIRED', message: error.message });
    } else {
      sendJson(response, 500, {
        code: 'PROJECT_FILE_SAVE_FAILED',
        message: error instanceof Error ? error.message : 'Project JSON save failed.',
      });
    }
  } finally {
    context.engineState.activity = 'IDLE';
    context.engineState.activeOperation = undefined;
  }
}

async function handleProjectFileLoad(response, context) {
  if (context.engineState.activeOperation) {
    sendJson(response, 409, {
      code: 'ENGINE_OPERATION_ACTIVE',
      message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
    });
    return;
  }

  context.engineState.activity = 'BUSY';
  context.engineState.activeOperation = 'PROJECT_OPEN';

  try {
    const loadedProject = await context.projectFileStore.load();
    sendJson(response, 200, loadedProject);
  } catch (error) {
    if (error instanceof ProjectFileNotFoundError) {
      sendJson(response, 404, { code: 'PROJECT_FILE_NOT_FOUND', message: error.message });
    } else if (error instanceof ProjectFileTooLargeError) {
      sendJson(response, 413, { code: 'PROJECT_FILE_TOO_LARGE', message: error.message });
    } else if (error instanceof ProjectFileValidationError) {
      sendJson(response, 400, { code: 'PROJECT_FILE_INVALID', message: error.message });
    } else if (error instanceof ProjectRootRequiredError) {
      sendJson(response, 409, { code: 'PROJECT_ROOT_REQUIRED', message: error.message });
    } else if (error instanceof ProjectFileReadError) {
      sendJson(response, 500, { code: 'PROJECT_FILE_READ_FAILED', message: error.message });
    } else {
      sendJson(response, 500, {
        code: 'PROJECT_FILE_READ_FAILED',
        message: error instanceof Error ? error.message : 'Project JSON open failed.',
      });
    }
  } finally {
    context.engineState.activity = 'IDLE';
    context.engineState.activeOperation = undefined;
  }
}

async function handleAceStepLyricsSave(request, response, context) {
  if (context.engineState.activeOperation) {
    sendJson(response, 409, {
      code: 'ENGINE_OPERATION_ACTIVE',
      message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
    });
    return;
  }

  const contentType = readHeader(request.headers['content-type'])
    .split(';', 1)[0]
    .toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'ACE_STEP_LYRICS_CONTENT_TYPE_REQUIRED',
      message: 'ACE-Step Lyrics save requires Content-Type: application/json.',
    });
    return;
  }

  context.engineState.activity = 'BUSY';
  context.engineState.activeOperation = 'ACE_STEP_LYRICS_SAVE';

  try {
    const body = await readJsonRequestBody(
      request,
      MAX_ACE_STEP_LYRICS_REQUEST_BYTES,
      'ACE-Step Lyrics JSON',
    );

    if (
      !isRecord(body) ||
      Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, 'lyrics')
    ) {
      throw new AceStepLyricsValidationError(
        'ACE_STEP_LYRICS_REQUEST_INVALID',
        'ACE-Step Lyrics request must contain exactly lyrics.',
      );
    }

    const lyricsSnapshot = await context.aceStepLyricsArtifactWriter.saveLyrics(
      body.lyrics,
    );
    sendJson(response, 201, lyricsSnapshot);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {
        code: 'ACE_STEP_LYRICS_TOO_LARGE',
        message: error.message,
      });
    } else if (
      error instanceof RequestBodyJsonError ||
      error instanceof AceStepLyricsValidationError
    ) {
      sendJson(response, 400, {
        code: 'ACE_STEP_LYRICS_INVALID',
        message: error.message,
      });
    } else if (
      error instanceof GeneratedArtifactFinalizationError &&
      error.code === 'PROJECT_ROOT_REQUIRED'
    ) {
      sendJson(response, 409, { code: error.code, message: error.message });
    } else {
      sendJson(response, 500, {
        code: 'ACE_STEP_LYRICS_SAVE_FAILED',
        message:
          error instanceof Error
            ? error.message
            : 'ACE-Step Lyrics save failed.',
      });
    }
  } finally {
    context.engineState.activity = 'IDLE';
    context.engineState.activeOperation = undefined;
  }
}

async function handleRecordingUpload(request, response, context) {
  if (context.engineState.activeOperation) {
    sendJson(response, 409, {
      code: 'ENGINE_OPERATION_ACTIVE',
      message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
    });
    return;
  }

  const contentType = readHeader(request.headers['content-type']).split(';', 1)[0].toLowerCase();

  if (contentType !== 'audio/wav') {
    sendJson(response, 415, {
      code: 'RECORDING_CONTENT_TYPE_REQUIRED',
      message: 'Recording save requires Content-Type: audio/wav.',
    });
    return;
  }

  context.engineState.activity = 'BUSY';
  context.engineState.activeOperation = 'RECORDING_SAVE';

  try {
    const wavBytes = await readBinaryRequestBody(
      request,
      MAX_RECORDING_WAV_BYTES,
      'Recording WAV',
    );
    const recording = await context.recordingArtifactWriter.saveWav(wavBytes);
    sendJson(response, 201, recording);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, { code: 'RECORDING_TOO_LARGE', message: error.message });
    } else if (
      error instanceof RequestBodyBinaryError ||
      error instanceof RecordingWavValidationError
    ) {
      sendJson(response, 400, { code: 'RECORDING_INVALID', message: error.message });
    } else if (
      error instanceof GeneratedArtifactFinalizationError &&
      error.code === 'PROJECT_ROOT_REQUIRED'
    ) {
      sendJson(response, 409, { code: error.code, message: error.message });
    } else {
      sendJson(response, 500, {
        code: 'RECORDING_SAVE_FAILED',
        message: error instanceof Error ? error.message : 'Recording WAV save failed.',
      });
    }
  } finally {
    context.engineState.activity = 'IDLE';
    context.engineState.activeOperation = undefined;
  }
}

async function handleSourceRestoration(request, response, context) {
  if (context.engineState.activeOperation) {
    sendJson(response, 409, {
      code: 'ENGINE_OPERATION_ACTIVE',
      message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
    });
    return;
  }

  const contentType = readHeader(request.headers['content-type']).split(';', 1)[0].toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'SOURCE_RESTORE_CONTENT_TYPE_REQUIRED',
      message: 'Source restoration requires Content-Type: application/json.',
    });
    return;
  }

  context.engineState.activity = 'BUSY';
  context.engineState.activeOperation = 'SOURCE_RESTORE';

  try {
    const body = await readJsonRequestBody(
      request,
      MAX_SOURCE_RESTORE_REQUEST_BYTES,
      'Source restoration JSON',
    );

    if (!isRecord(body)) {
      throw new SourceRestorationValidationError(
        'Source restoration request body must be an object.',
      );
    }

    const restoration = await context.sourceRestorationService.restore(body.sources);
    sendJson(response, 200, restoration);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, { code: 'SOURCE_RESTORE_TOO_LARGE', message: error.message });
    } else if (
      error instanceof RequestBodyJsonError ||
      error instanceof SourceRestorationValidationError
    ) {
      sendJson(response, 400, { code: 'SOURCE_RESTORE_INVALID', message: error.message });
    } else {
      sendJson(response, 500, {
        code: 'SOURCE_RESTORE_FAILED',
        message: error instanceof Error ? error.message : 'Source restoration failed.',
      });
    }
  } finally {
    context.engineState.activity = 'IDLE';
    context.engineState.activeOperation = undefined;
  }
}

async function handleGeneratedAudioRead(request, response, context) {
  if (context.engineState.activeOperation) {
    sendJson(response, 409, {
      code: 'ENGINE_OPERATION_ACTIVE',
      message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
    });
    return;
  }

  const contentType = readHeader(request.headers['content-type']).split(';', 1)[0].toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'GENERATED_AUDIO_CONTENT_TYPE_REQUIRED',
      message: 'Generated audio read requires Content-Type: application/json.',
    });
    return;
  }

  context.engineState.activity = 'BUSY';
  context.engineState.activeOperation = 'GENERATED_AUDIO_READ';

  try {
    const body = await readJsonRequestBody(
      request,
      MAX_GENERATED_AUDIO_READ_REQUEST_BYTES,
      'Generated audio JSON',
    );

    if (!isRecord(body) || !Object.hasOwn(body, 'source')) {
      throw new GeneratedAudioReadError(
        'GENERATED_AUDIO_REQUEST_INVALID',
        'Generated audio request body must be an object containing source.',
      );
    }

    const generatedAudio = await context.generatedAudioReader.readWav(body.source);
    sendWav(response, generatedAudio);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {
        code: 'GENERATED_AUDIO_REQUEST_TOO_LARGE',
        message: error.message,
      });
    } else if (error instanceof RequestBodyJsonError) {
      sendJson(response, 400, {
        code: 'GENERATED_AUDIO_REQUEST_INVALID',
        message: error.message,
      });
    } else if (error instanceof GeneratedAudioReadError) {
      sendGeneratedAudioReadError(response, error);
    } else {
      sendJson(response, 500, {
        code: 'GENERATED_AUDIO_READ_FAILED',
        message: 'Generated audio read failed.',
      });
    }
  } finally {
    context.engineState.activity = 'IDLE';
    context.engineState.activeOperation = undefined;
  }
}

async function handleGeneratedAudioAvailability(request, response, context) {
  if (context.engineState.activeOperation) {
    sendJson(response, 409, {
      code: 'ENGINE_OPERATION_ACTIVE',
      message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
    });
    return;
  }

  const contentType = readHeader(request.headers['content-type']).split(';', 1)[0].toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'GENERATED_AUDIO_AVAILABILITY_CONTENT_TYPE_REQUIRED',
      message: 'Generated audio availability requires Content-Type: application/json.',
    });
    return;
  }

  context.engineState.activity = 'BUSY';
  context.engineState.activeOperation = 'GENERATED_AUDIO_AVAILABILITY';

  try {
    const body = await readJsonRequestBody(
      request,
      MAX_GENERATED_AUDIO_AVAILABILITY_REQUEST_BYTES,
      'Generated audio availability JSON',
    );

    if (!isRecord(body) || !Object.hasOwn(body, 'sources')) {
      throw new GeneratedAudioReadError(
        'GENERATED_AUDIO_REQUEST_INVALID',
        'Generated audio availability body must be an object containing sources.',
      );
    }

    const availableSourceIds =
      await context.generatedAudioReader.findAvailableWavSourceIds(body.sources);
    sendJson(response, 200, { availableSourceIds });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {
        code: 'GENERATED_AUDIO_AVAILABILITY_REQUEST_TOO_LARGE',
        message: error.message,
      });
    } else if (error instanceof RequestBodyJsonError) {
      sendJson(response, 400, {
        code: 'GENERATED_AUDIO_REQUEST_INVALID',
        message: error.message,
      });
    } else if (error instanceof GeneratedAudioReadError) {
      sendGeneratedAudioReadError(response, error);
    } else {
      sendJson(response, 500, {
        code: 'GENERATED_AUDIO_AVAILABILITY_FAILED',
        message: 'Generated audio availability check failed.',
      });
    }
  } finally {
    context.engineState.activity = 'IDLE';
    context.engineState.activeOperation = undefined;
  }
}

async function handleAudioArtifactFileDeletion(request, response, context) {
  if (context.engineState.activeOperation) {
    sendJson(response, 409, {
      code: 'ENGINE_OPERATION_ACTIVE',
      message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
    });
    return;
  }

  const contentType = readHeader(request.headers['content-type']).split(';', 1)[0].toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'AUDIO_FILE_DELETE_CONTENT_TYPE_REQUIRED',
      message: 'Audio file deletion requires Content-Type: application/json.',
    });
    return;
  }

  context.engineState.activity = 'BUSY';
  context.engineState.activeOperation = 'AUDIO_FILE_DELETE';

  try {
    const body = await readJsonRequestBody(
      request,
      MAX_AUDIO_FILE_DELETE_REQUEST_BYTES,
      'Audio file deletion JSON',
    );

    if (!isRecord(body) || !Object.hasOwn(body, 'file')) {
      throw new AudioArtifactFileDeletionError(
        'AUDIO_FILE_DELETE_REQUEST_INVALID',
        'Audio file deletion request body must be an object containing file.',
      );
    }

    const deletedFile = await context.audioArtifactFileDeleter.deleteWav(body.file);
    sendJson(response, 200, { deletedFile });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {
        code: 'AUDIO_FILE_DELETE_REQUEST_TOO_LARGE',
        message: error.message,
      });
    } else if (error instanceof RequestBodyJsonError) {
      sendJson(response, 400, {
        code: 'AUDIO_FILE_DELETE_REQUEST_INVALID',
        message: error.message,
      });
    } else if (error instanceof AudioArtifactFileDeletionError) {
      sendAudioArtifactFileDeletionError(response, error);
    } else {
      sendJson(response, 500, {
        code: 'AUDIO_FILE_DELETE_FAILED',
        message: 'Audio Artifact file deletion failed.',
      });
    }
  } finally {
    context.engineState.activity = 'IDLE';
    context.engineState.activeOperation = undefined;
  }
}

function sendAudioArtifactFileDeletionError(response, error) {
  const statusCode =
    error.code === 'AUDIO_FILE_DELETE_REQUEST_INVALID'
      ? 400
      : error.code === 'AUDIO_FILE_DELETE_NOT_FOUND'
        ? 404
        : error.code === 'AUDIO_FILE_DELETE_OUTSIDE_PROJECT_ROOT'
          ? 403
          : error.code === 'AUDIO_FILE_DELETE_WAV_INVALID'
            ? 422
            : error.code === 'AUDIO_FILE_DELETE_FAILED'
              ? 500
              : 409;

  sendJson(response, statusCode, {
    code: error.code,
    message: error.message,
  });
}

function sendGeneratedAudioReadError(response, error) {
  const statusCode =
    error.code === 'GENERATED_AUDIO_REQUEST_INVALID'
      ? 400
      : error.code === 'GENERATED_AUDIO_NOT_FOUND'
        ? 404
        : error.code === 'GENERATED_AUDIO_OUTSIDE_PROJECT_ROOT'
          ? 403
          : error.code === 'GENERATED_AUDIO_WAV_INVALID'
            ? 422
            : 409;

  sendJson(response, statusCode, {
    code: error.code,
    message: error.message,
  });
}

class RequestBodyTooLargeError extends Error {}

class RequestBodyJsonError extends Error {}

class RequestBodyBinaryError extends Error {}

async function readJsonRequestBody(request, maximumBytes, label) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > maximumBytes) {
      throw new RequestBodyTooLargeError(`${label} exceeds the ${maximumBytes} byte limit.`);
    }

    chunks.push(buffer);
  }

  if (totalBytes === 0) {
    throw new RequestBodyJsonError(`${label} request body is empty.`);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestBodyJsonError(`${label} request body is not valid JSON.`);
  }
}

async function readBinaryRequestBody(request, maximumBytes, label) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > maximumBytes) {
      throw new RequestBodyTooLargeError(`${label} exceeds the ${maximumBytes} byte limit.`);
    }

    chunks.push(buffer);
  }

  if (totalBytes === 0) {
    throw new RequestBodyBinaryError(`${label} request body is empty.`);
  }

  return Buffer.concat(chunks);
}

function matchJobRoute(pathname) {
  if (pathname === LOCAL_ENGINE_JOBS_PATH) {
    return Object.freeze({ kind: 'collection' });
  }

  if (!pathname.startsWith(`${LOCAL_ENGINE_JOBS_PATH}/`)) {
    return undefined;
  }

  const segments = pathname.slice(LOCAL_ENGINE_JOBS_PATH.length + 1).split('/');
  const jobId = segments[0];

  if (!/^job-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(jobId)) {
    return undefined;
  }

  if (segments.length === 1) {
    return Object.freeze({ jobId, kind: 'item' });
  }

  if (
    segments.length === 2 &&
    (segments[1] === 'cancel' || segments[1] === 'retry')
  ) {
    return Object.freeze({ action: segments[1], jobId, kind: 'action' });
  }

  return undefined;
}

async function handleSoundFontAudition(request, response, context) {
  if (context.engineState.activeOperation) {
    sendJson(response, 409, {
      code: 'ENGINE_OPERATION_ACTIVE',
      message: `Local Engine is busy with ${context.engineState.activeOperation}.`,
    });
    return;
  }

  const contentType = readHeader(request.headers['content-type']).split(';', 1)[0].toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'SOUNDFONT_AUDITION_CONTENT_TYPE_REQUIRED',
      message: 'SoundFont audition requires Content-Type: application/json.',
    });
    return;
  }

  const abortController = new AbortController();
  const handleRequestAbort = () => abortController.abort();
  const handleResponseClose = () => {
    if (!response.writableEnded) {
      abortController.abort();
    }
  };
  request.once('aborted', handleRequestAbort);
  response.once('close', handleResponseClose);
  context.engineState.activity = 'BUSY';
  context.engineState.activeOperation = 'SOUNDFONT_AUDITION';

  try {
    const body = await readJsonRequestBody(
      request,
      MAX_SOUNDFONT_AUDITION_REQUEST_BYTES,
      'SoundFont audition JSON',
    );
    const audition = await context.soundFontAuditionService.render(body, {
      signal: abortController.signal,
    });

    if (!response.destroyed && !response.writableEnded) {
      sendWav(response, audition);
    }
  } catch (error) {
    if (response.destroyed || response.writableEnded) {
      return;
    }

    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {
        code: 'SOUNDFONT_AUDITION_REQUEST_TOO_LARGE',
        message: error.message,
      });
    } else if (error instanceof RequestBodyJsonError) {
      sendJson(response, 400, {
        code: 'SOUNDFONT_AUDITION_REQUEST_INVALID',
        message: error.message,
      });
    } else if (
      error instanceof SoundFontAuditionError ||
      error instanceof FluidSynthRuntimeError
    ) {
      sendSoundFontAuditionError(response, error);
    } else {
      sendJson(response, 500, {
        code: 'SOUNDFONT_AUDITION_FAILED',
        message: 'SoundFont audition failed.',
      });
    }
  } finally {
    request.off('aborted', handleRequestAbort);
    response.off('close', handleResponseClose);
    context.engineState.activity = 'IDLE';
    context.engineState.activeOperation = undefined;
  }
}

function sendSoundFontAuditionError(response, error) {
  const statusCode =
    error.code === 'SOUNDFONT_AUDITION_REQUEST_INVALID' ||
    error.code === 'SOUNDFONT_REQUEST_INVALID'
      ? 400
      : error.code === 'SOUNDFONT_OFFLINE'
        ? 404
        : error.code === 'FLUIDSYNTH_RUNTIME_UNAVAILABLE' ||
            error.code === 'FLUIDSYNTH_VERSION_MISMATCH'
          ? 503
          : error.code === 'FLUIDSYNTH_RENDER_TIMEOUT'
            ? 504
            : error.code === 'FLUIDSYNTH_RENDER_FAILED' ||
                error.code === 'SOUNDFONT_AUDITION_WAV_INVALID'
              ? 422
              : 409;

  sendJson(response, statusCode, {
    code: error.code,
    message: error.message,
  });
}

async function handleSoundFontPresetCatalog(request, response, context) {
  const contentType = readHeader(request.headers['content-type'])
    .split(';', 1)[0]
    .toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'SOUNDFONT_PRESET_CATALOG_CONTENT_TYPE_REQUIRED',
      message: 'SoundFont preset catalog requires Content-Type: application/json.',
    });
    return;
  }

  try {
    const body = await readJsonRequestBody(
      request,
      MAX_SOUNDFONT_PRESET_CATALOG_REQUEST_BYTES,
      'SoundFont preset catalog JSON',
    );
    sendJson(
      response,
      200,
      await context.soundFontPresetCatalogService.list(body),
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {
        code: 'SOUNDFONT_PRESET_CATALOG_REQUEST_TOO_LARGE',
        message: error.message,
      });
      return;
    }

    if (error instanceof RequestBodyJsonError) {
      sendJson(response, 400, {
        code: 'SOUNDFONT_PRESET_CATALOG_REQUEST_INVALID',
        message: error.message,
      });
      return;
    }

    if (
      error instanceof SoundFontPresetCatalogError ||
      error instanceof FluidSynthRuntimeError
    ) {
      sendSoundFontPresetCatalogError(response, error);
      return;
    }

    sendJson(response, 500, {
      code: 'SOUNDFONT_PRESET_CATALOG_FAILED',
      message: 'SoundFont preset catalog failed.',
    });
  }
}

function sendSoundFontPresetCatalogError(response, error) {
  const statusCode =
    error.code === 'SOUNDFONT_PRESET_CATALOG_REQUEST_INVALID' ||
    error.code === 'SOUNDFONT_REQUEST_INVALID' ||
    error.code === 'FLUIDSYNTH_PRESET_CATALOG_REQUEST_INVALID'
      ? 400
      : error.code === 'SOUNDFONT_OFFLINE'
        ? 404
        : error.code === 'FLUIDSYNTH_RUNTIME_UNAVAILABLE' ||
            error.code === 'FLUIDSYNTH_VERSION_MISMATCH'
          ? 503
          : error.code === 'FLUIDSYNTH_PRESET_CATALOG_TIMEOUT'
            ? 504
            : error.code === 'FLUIDSYNTH_PRESET_CATALOG_FAILED' ||
                error.code === 'FLUIDSYNTH_PRESET_CATALOG_INVALID'
              ? 422
              : 409;

  sendJson(response, statusCode, {
    code: error.code,
    message: error.message,
  });
}

async function handleSoundFontLivePreview(request, response, context) {
  const contentType = readHeader(request.headers['content-type'])
    .split(';', 1)[0]
    .toLowerCase();

  if (contentType !== 'application/json') {
    sendJson(response, 415, {
      code: 'SOUNDFONT_LIVE_PREVIEW_CONTENT_TYPE_REQUIRED',
      message: 'SoundFont Live Preview requires Content-Type: application/json.',
    });
    return;
  }

  try {
    const body = await readJsonRequestBody(
      request,
      MAX_SOUNDFONT_LIVE_PREVIEW_REQUEST_BYTES,
      'SoundFont Live Preview JSON',
    );
    const result = body?.action === 'prepare'
      ? await context.soundFontLivePreviewService.prepare(body)
      : body?.action === 'trigger'
        ? context.soundFontLivePreviewService.trigger(body)
        : body?.action === 'stop'
          ? await context.soundFontLivePreviewService.stop(body)
          : (() => {
              throw new SoundFontLivePreviewError(
                'SOUNDFONT_LIVE_PREVIEW_REQUEST_INVALID',
                'SoundFont Live Preview action is invalid.',
              );
            })();
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {
        code: 'SOUNDFONT_LIVE_PREVIEW_REQUEST_TOO_LARGE',
        message: error.message,
      });
      return;
    }

    if (error instanceof RequestBodyJsonError) {
      sendJson(response, 400, {
        code: 'SOUNDFONT_LIVE_PREVIEW_REQUEST_INVALID',
        message: error.message,
      });
      return;
    }

    if (
      error instanceof SoundFontLivePreviewError ||
      error instanceof FluidSynthLiveHostRuntimeError
    ) {
      sendSoundFontLivePreviewError(response, error);
      return;
    }

    sendJson(response, 500, {
      code: 'SOUNDFONT_LIVE_PREVIEW_FAILED',
      message: 'SoundFont Live Preview failed.',
    });
  }
}

function sendSoundFontLivePreviewError(response, error) {
  const statusCode =
    error.code === 'SOUNDFONT_LIVE_PREVIEW_REQUEST_INVALID' ||
    error.code === 'SOUNDFONT_REQUEST_INVALID' ||
    error.code === 'FLUIDSYNTH_LIVE_HOST_REQUEST_INVALID'
      ? 400
      : error.code === 'SOUNDFONT_OFFLINE'
        ? 404
        : error.code === 'FLUIDSYNTH_LIVE_HOST_UNAVAILABLE' ||
            error.code === 'FLUIDSYNTH_LIVE_HOST_START_FAILED'
          ? 503
          : error.code === 'FLUIDSYNTH_LIVE_HOST_START_TIMEOUT'
            ? 504
            : 409;

  sendJson(response, statusCode, {
    code: error.code,
    message: error.message,
  });
}

async function handleSoundFontCatalogRequest(response, context) {
  try {
    sendJson(response, 200, await context.soundFontCatalog.list());
  } catch (error) {
    if (!(error instanceof SoundFontCatalogError)) {
      throw error;
    }

    const statusCode =
      error.code === 'PROJECT_ROOT_REQUIRED'
        ? 409
        : error.code === 'SOUNDFONT_CATALOG_LIMIT_EXCEEDED'
          ? 413
          : error.code === 'SOUNDFONT_DIRECTORY_UNSAFE'
            ? 409
            : 500;

    sendJson(response, statusCode, {
      code: error.code,
      message: error.message,
    });
  }
}

function getEngineActivity(context) {
  if (context.engineState.activity === 'BUSY') {
    return 'BUSY';
  }

  return context.gpuJobQueue.getSnapshot().activeJobId ? 'BUSY' : 'IDLE';
}

function hasRootBlockingGpuJobs(snapshot) {
  return (
    Boolean(snapshot.activeJobId) ||
    snapshot.jobs.some((job) => ROOT_BLOCKING_JOB_STATES.has(job.state))
  );
}

function applyCorsHeaders(response, allowedOrigin) {
  response.setHeader('Access-Control-Allow-Headers', `Content-Type, ${LOCAL_ENGINE_TOKEN_HEADER}`);
  response.setHeader('Access-Control-Allow-Methods', 'DELETE, GET, POST, PUT, OPTIONS');
  response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  response.setHeader('Access-Control-Max-Age', '600');
  response.setHeader('Vary', 'Origin');
}

function sendMethodNotAllowed(response, allow, message) {
  response.setHeader('Allow', allow);
  sendJson(response, 405, { code: 'METHOD_NOT_ALLOWED', message });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function sendWav(response, generatedAudio) {
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': generatedAudio.contentLength,
    'Content-Type': generatedAudio.contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(generatedAudio.bytes);
}

function readHeader(value) {
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? '';
  }

  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokensMatch(receivedToken, expectedToken) {
  const received = Buffer.from(receivedToken);
  const expected = Buffer.from(expectedToken);

  return received.length === expected.length && timingSafeEqual(received, expected);
}

function validateAllowedOrigin(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Local Engine allowedOrigin must be a string.');
  }

  const origin = new URL(value);

  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== LOCAL_ENGINE_HOST ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(`Local Engine UI origin must be an http://${LOCAL_ENGINE_HOST} origin.`);
  }

  return origin.origin;
}

function validatePort(value) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('Local Engine port must be an integer from 0 to 65535.');
  }

  return port;
}

function validateToken(value) {
  if (typeof value !== 'string' || value.length < MINIMUM_TOKEN_LENGTH) {
    throw new Error(`Local Engine launch token must contain at least ${MINIMUM_TOKEN_LENGTH} characters.`);
  }

  return value;
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function closeLocalEngine(
  server,
  printMixOperations,
  projectMixdownOperations,
  gpuJobQueue,
  basicPitchRuntimeInspector,
  generatedArtifactFinalizer,
  soundFontAuditionService,
  soundFontLivePreviewService,
) {
  const errors = [];

  for (const action of [
    () => printMixOperations.shutdown(),
    () => projectMixdownOperations.shutdown(),
    () => soundFontAuditionService.shutdown(),
    () => soundFontLivePreviewService.shutdown(),
    () => gpuJobQueue.shutdown(),
    () => basicPitchRuntimeInspector.shutdown(),
    () => generatedArtifactFinalizer.discardAll(),
    () => closeServer(server),
  ]) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, 'Local Engine shutdown encountered multiple errors.');
  }
}

function isDirectExecution() {
  const entryPath = process.argv[1];

  return typeof entryPath === 'string' && resolve(entryPath) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  const token = process.env.HUMSTUDIO_ENGINE_TOKEN?.trim() || randomBytes(32).toString('hex');
  const port = process.env.HUMSTUDIO_ENGINE_PORT || LOCAL_ENGINE_DEFAULT_PORT;
  const uiRootPath = process.env.HUMSTUDIO_UI_ROOT?.trim() || undefined;
  const allowedOrigin =
    process.env.HUMSTUDIO_UI_ORIGIN ||
    (uiRootPath ? `http://${LOCAL_ENGINE_HOST}:${port}` : LOCAL_ENGINE_DEFAULT_UI_ORIGIN);

  try {
    const builtinSoundFont = await createDefaultSoundFontBuiltinDefinition();
    const engine = await startLocalEngineServer({
      allowedOrigin,
      builtinSoundFonts: [builtinSoundFont],
      port,
      token,
      uiRootPath,
    });
    const projectRoot = engine.getProjectRootSnapshot();

    process.stdout.write(
      [
        `ElpisDAW Local Engine ${LOCAL_ENGINE_VERSION}`,
        `Listening: ${engine.baseUrl}`,
        `Protocol: v${LOCAL_ENGINE_PROTOCOL_VERSION}`,
        `Log Level: ${localEngineLogger.getLevel().toUpperCase()} (HUMSTUDIO_LOG_LEVEL)`,
        'Work Log: QUEUED -> MODEL LOAD -> GENERATION -> OUTPUT SAVE -> COMPLETE',
        `UI Origin: ${allowedOrigin}`,
        `Production UI: ${uiRootPath ? engine.baseUrl : 'disabled'}`,
        projectRoot.status === 'READY'
          ? `Project Root: ${projectRoot.rootPath}`
          : `Project Root: not selected${projectRoot.recoveryIssue ? ` (${projectRoot.recoveryIssue})` : ''}`,
        'Launch Token: active in process memory only.',
        'Press Ctrl+C to stop.',
      ].join('\n') + '\n',
    );

    const stop = async () => {
      await engine.close();
      process.exit(0);
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    localEngineLogger.error('ENGINE', 'ENGINE_START_FAILED', {
      ...toDiagnosticErrorFields(error),
    });
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
