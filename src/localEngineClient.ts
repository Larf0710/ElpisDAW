import {
  LOCAL_ENGINE_ACE_STEP_LYRICS_PATH,
  LOCAL_ENGINE_AUDIO_FILES_PATH,
  LOCAL_ENGINE_BASIC_PITCH_RUNTIME_PATH,
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
} from '../shared/localEngineProtocol.js';
import {
  PROJECT_MIXDOWN_CLIENT_TIMEOUT_MS,
} from '../shared/projectMixdownApiProtocol.js';
import {
  PRINT_MIX_CLIENT_TIMEOUT_MS,
} from '../shared/printMixProtocol.js';
import {
  isLocalEngineJobId,
  parseLocalEngineGpuJobRecord,
  parseLocalEngineGpuJobSnapshot,
} from './localEngineJobs';
import type {
  LocalEngineAceStepJobRequest,
  LocalEngineBasicPitchHumToMidiJobRequest,
  LocalEngineGpuJobProgress,
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobSnapshot,
  LocalEngineInstrumentRenderJobRequest,
  LocalEngineMockHumToMidiJobRequest,
  LocalEngineMockJobRequest,
  LocalEngineStableAudio3JobRequest,
} from './localEngineJobs';
import type { MidiNote, SoundFontFormat } from './types';
import {
  parseProjectMixdownApiOperation,
  type ProjectMixdownApiOperation,
  type ProjectMixdownApiRequest,
} from './projectMixdownApi';
import {
  createProjectStemPrintPlanSha256,
  parseProjectStemPrintApiOperation,
  type ProjectStemPrintApiOperation,
  type ProjectStemPrintApiRequest,
} from './projectStemPrintApi';
import {
  parsePrintMixOperation,
  type PrintMixOperation,
  type PrintMixRequest,
} from './printMixOperation';

export type {
  ProjectMixdownApiCompletedResult,
  ProjectMixdownApiOperation,
  ProjectMixdownApiRequest,
} from './projectMixdownApi';

export type {
  ProjectStemPrintApiCompletedResult,
  ProjectStemPrintApiOperation,
  ProjectStemPrintApiRequest,
} from './projectStemPrintApi';

export type {
  PrintMixAudioCompletedResult,
  PrintMixOperation,
  PrintMixRequest,
} from './printMixOperation';

export type {
  LocalEngineAceStepJobRequest,
  LocalEngineBasicPitchHumToMidiJobRequest,
  LocalEngineGpuJobProgress,
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobSnapshot,
  LocalEngineGpuJobState,
  LocalEngineInstrumentRenderJobRequest,
  LocalEngineMockHumToMidiJobRequest,
  LocalEngineMockJobRequest,
  LocalEngineStableAudio3JobRequest,
} from './localEngineJobs';

export type EngineLifecycleState =
  | 'STARTING'
  | 'READY'
  | 'STOPPING'
  | 'OFFLINE'
  | 'ERROR'
  | 'VERSION_MISMATCH';

export type EngineActivityState = 'IDLE' | 'BUSY';

export type LocalEngineHealth = Readonly<{
  activity: EngineActivityState;
  engineVersion: string;
  instanceId: string;
  lifecycle: EngineLifecycleState;
  protocolVersion: string;
  startedAt: string;
}>;

export type LocalEngineHealthFailureReason =
  | 'canceled'
  | 'http-error'
  | 'invalid-response'
  | 'offline'
  | 'timeout'
  | 'unauthorized'
  | 'version-mismatch';

export type LocalEngineHealthResult =
  | { ok: true; health: LocalEngineHealth }
  | {
      ok: false;
      message: string;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    };

export type LocalEngineProjectRoot =
  | Readonly<{ recoveryIssue?: string; status: 'UNSET' }>
  | Readonly<{
      configuredAt: string;
      directories: readonly string[];
      projectFile:
        | Readonly<{ status: 'MISSING' }>
        | Readonly<{
            lastModifiedAt: string;
            path: string;
            sizeBytes: number;
            status: 'EXISTS';
          }>;
      projectFileName: string;
      rootName: string;
      rootPath: string;
      status: 'READY';
    }>;

export type LocalEngineProjectRootSelection = 'CANCELED' | 'SELECTED';

export type LocalEngineProjectRootResult =
  | {
      ok: true;
      projectRoot: LocalEngineProjectRoot;
      selection?: LocalEngineProjectRootSelection;
    }
  | {
      ok: false;
      message: string;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    };

export type LocalEngineSoundFontIssueReason =
  | 'DEPTH_LIMIT'
  | 'OUTSIDE_CATALOG'
  | 'SYMBOLIC_LINK'
  | 'UNAVAILABLE'
  | 'UNREADABLE';

export type LocalEngineSoundFontResource = Readonly<{
  format: SoundFontFormat;
  lastModifiedAt: string;
  library: 'builtin' | 'project';
  name: string;
  relativePath: string;
  resourceId: string;
  revisionToken: string;
  sizeBytes: number;
  status: 'AVAILABLE';
}>;

export type LocalEngineSoundFontCatalog = Readonly<{
  directory: 'soundfonts';
  issues: readonly Readonly<{
    reason: LocalEngineSoundFontIssueReason;
    relativePath: string;
  }>[];
  resources: readonly LocalEngineSoundFontResource[];
  scannedAt: string;
  supportedFormats: readonly ['sf2', 'sf3'];
}>;

export type LocalEngineSoundFontCatalogResult =
  | { catalog: LocalEngineSoundFontCatalog; ok: true }
  | {
      ok: false;
      message: string;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    };

export type LocalEngineSoundFontAuditionRequest = Readonly<{
  bank: number;
  midi: Readonly<{
    bpm: number;
    notes: readonly MidiNote[];
    ticksPerQuarter: number;
  }>;
  program: number;
  soundFont: Readonly<{
    format: SoundFontFormat;
    library: 'builtin' | 'project';
    relativePath: string;
    resourceId: string;
    revisionToken: string;
  }>;
}>;

export type LocalEngineSoundFontAuditionResult =
  | { ok: true; wav: Blob }
  | {
      ok: false;
      message: string;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    };

export type LocalEngineProjectFileSave = Readonly<{
  bytesWritten: number;
  lastModifiedAt: string;
  projectFileName: string;
  projectFilePath: string;
  savedAt: string;
  status: 'SAVED';
}>;

export type LocalEngineProjectFileSaveResult =
  | { ok: true; savedProject: LocalEngineProjectFileSave }
  | {
      ok: false;
      message: string;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    };

export type LocalEngineProjectFileLoad = Readonly<{
  bytesRead: number;
  lastModifiedAt: string;
  projectFile: Readonly<Record<string, unknown>>;
  projectFileName: string;
  projectFilePath: string;
  savedAt: string;
  status: 'LOADED';
}>;

export type LocalEngineProjectFileLoadResult =
  | { loadedProject: LocalEngineProjectFileLoad; ok: true }
  | {
      ok: false;
      message: string;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    };

export type LocalEngineBasicPitchRuntime =
  | Readonly<{
      modelId: 'basic-pitch-icassp-2022';
      modelRevision: '0.4.0-onnx';
      profileId: 'windows-x64-python-3-10-onnx-cpu';
      providerVersion: '0.4.0';
      status: 'READY';
    }>
  | Readonly<{
      code: string;
      message: string;
      status: 'UNAVAILABLE';
    }>;

export type LocalEngineBasicPitchRuntimeResult =
  | Readonly<{ ok: true; runtime: LocalEngineBasicPitchRuntime }>
  | LocalEngineRequestFailure;

export type LocalEngineSoundFontPreset = Readonly<{
  bank: number;
  name: string;
  program: number;
}>;

export type LocalEngineSoundFontPresetCatalog = Readonly<{
  presets: readonly LocalEngineSoundFontPreset[];
  resourceId: string;
  revisionToken: string;
}>;

export type LocalEngineSoundFontPresetCatalogRequest = Readonly<{
  soundFont: Readonly<{
    format: SoundFontFormat;
    library: 'builtin' | 'project';
    relativePath: string;
    resourceId: string;
    revisionToken: string;
  }>;
}>;

export type LocalEngineSoundFontPresetCatalogResult =
  | { catalog: LocalEngineSoundFontPresetCatalog; ok: true }
  | {
      ok: false;
      message: string;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    };

export type LocalEngineSoundFontLivePreviewRequest =
  | Readonly<{
      action: 'prepare';
      bank: number;
      gain?: number;
      program: number;
      sampleRate?: number;
      soundFont: LocalEngineSoundFontAuditionRequest['soundFont'];
    }>
  | Readonly<{
      action: 'trigger';
      durationMs: number;
      pitch: number;
      sessionId: string;
      velocity: number;
    }>
  | Readonly<{
      action: 'stop';
      sessionId?: string;
    }>;

export type LocalEngineSoundFontLivePreviewSnapshot =
  | Readonly<{
      bank: number;
      program: number;
      resourceId: string;
      sessionId: string;
      status: 'READY';
    }>
  | Readonly<{
      pitch: number;
      sessionId: string;
      status: 'TRIGGERED';
    }>
  | Readonly<{ status: 'STOPPED' }>;

export type LocalEngineSoundFontLivePreviewResult =
  | { ok: true; snapshot: LocalEngineSoundFontLivePreviewSnapshot }
  | LocalEngineRequestFailure;

export type LocalEngineAceStepLyricsSnapshot = Readonly<{
  artifactId: string;
  createdAt: string;
  destination: 'ace-step-lyrics';
  file: Readonly<{
    extension: '.txt';
    name: string;
    relativePath: string;
    sizeBytes: number;
  }>;
  kind: 'lyrics';
  sha256: string;
  status: 'FINALIZED';
}>;

export type LocalEngineAceStepLyricsSaveResult =
  | { lyricsSnapshot: LocalEngineAceStepLyricsSnapshot; ok: true }
  | {
      ok: false;
      message: string;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    };

export type LocalEngineRecordingArtifact = Readonly<{
  artifactId: string;
  audio: Readonly<{
    bitsPerSample: 16;
    channels: 1 | 2;
    durationSeconds: number;
    mimeType: 'audio/wav';
    sampleRate: number;
  }>;
  createdAt: string;
  destination: 'recording';
  file: Readonly<{
    extension: '.wav';
    name: string;
    relativePath: string;
    sizeBytes: number;
  }>;
  kind: 'audio';
  status: 'FINALIZED';
}>;

export type LocalEngineRecordingSaveResult =
  | { ok: true; recording: LocalEngineRecordingArtifact }
  | {
      ok: false;
      message: string;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    };

export type LocalEngineSourceAvailability =
  | 'available'
  | 'unresolved'
  | 'missing'
  | 'unopenable';

export type LocalEngineSourceDescriptor =
  | Readonly<{
      kind: 'generated';
      lastModified?: number;
      name?: string;
      relativePath: string;
      sizeBytes?: number;
      sourceId: string;
    }>
  | Readonly<{
      kind: 'external';
      lastModified?: number;
      name?: string;
      path: string;
      sizeBytes?: number;
      sourceId: string;
    }>;

export type LocalEngineGeneratedAudioDescriptor = Readonly<{
  kind: 'generated';
  name: string;
  relativePath: string;
  sizeBytes: number;
  sourceId: string;
}>;

export type LocalEngineGeneratedAudioReadResult =
  | { ok: true; wav: Blob }
  | {
      ok: false;
      message: string;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    };

export type LocalEngineGeneratedAudioAvailabilityResult =
  | {
      availableSourceIds: readonly string[];
      ok: true;
    }
  | LocalEngineRequestFailure;

export type LocalEngineAudioFileDeletionDescriptor = Readonly<{
  artifactId: string;
  extension: '.wav';
  name: string;
  relativePath: string;
  sizeBytes: number;
  storageKind: 'generated' | 'recording';
}>;

export type LocalEngineDeletedAudioFile =
  LocalEngineAudioFileDeletionDescriptor &
    Readonly<{ status: 'DELETED' }>;

export type LocalEngineAudioFileDeletionResult =
  | { deletedFile: LocalEngineDeletedAudioFile; ok: true }
  | LocalEngineRequestFailure;

export type LocalEngineRestoredSource = Readonly<{
  actual?: Readonly<{
    lastModified: number;
    name: string;
    sizeBytes: number;
  }>;
  kind: LocalEngineSourceDescriptor['kind'];
  path?: string;
  reason:
    | 'available'
    | 'metadata-mismatch'
    | 'missing'
    | 'outside-project-root'
    | 'project-root-required'
    | 'unopenable';
  relativePath?: string;
  resolvedPath?: string;
  sourceId: string;
  state: LocalEngineSourceAvailability;
}>;

export type LocalEngineSourceRestoration = Readonly<{
  availability: Readonly<Record<string, LocalEngineSourceAvailability>>;
  checkedAt: string;
  sources: readonly LocalEngineRestoredSource[];
}>;

export type LocalEngineSourceRestorationResult =
  | { ok: true; restoration: LocalEngineSourceRestoration }
  | {
      ok: false;
      message: string;
      reason: LocalEngineHealthFailureReason;
      status?: number;
    };

export type LocalEngineGpuJobResult =
  | { ok: true; job: LocalEngineGpuJobRecord }
  | LocalEngineRequestFailure;

export type LocalEngineGpuJobSnapshotResult =
  | { ok: true; snapshot: LocalEngineGpuJobSnapshot }
  | LocalEngineRequestFailure;

export type LocalEngineGpuJobRemovalResult =
  | { ok: true; removedJob: LocalEngineGpuJobRecord }
  | LocalEngineRequestFailure;

export type LocalEngineProjectRenderUnknownCause =
  | 'canceled'
  | 'engine-reported'
  | 'invalid-response'
  | 'offline'
  | 'timeout';

export type LocalEngineProjectRenderResult<Operation> =
  | { ok: true; operation: Operation }
  | {
      message: string;
      ok: false;
      outcome: 'not-dispatched';
      reason: 'canceled';
    }
  | {
      code: string;
      message: string;
      ok: false;
      outcome: 'confirmed';
      reason: 'rejected';
      status: number;
    }
  | {
      cause: LocalEngineProjectRenderUnknownCause;
      message: string;
      ok: false;
      operationId: string;
      outcome: 'unknown';
      reason: 'unknown-outcome';
      status?: number;
    };

export type LocalEngineGeneratedAudioReadOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type LocalEngineProjectMixdownUnknownCause =
  LocalEngineProjectRenderUnknownCause;

export type LocalEngineProjectMixdownResult =
  LocalEngineProjectRenderResult<ProjectMixdownApiOperation>;

export type LocalEngineProjectStemPrintResult =
  LocalEngineProjectRenderResult<ProjectStemPrintApiOperation>;

export type LocalEnginePrintMixResult =
  LocalEngineProjectRenderResult<PrintMixOperation>;

type LocalEngineRequestFailure = {
  ok: false;
  message: string;
  reason: LocalEngineHealthFailureReason;
  status?: number;
};

type LocalEngineFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type LocalEngineClientOptions = Readonly<{
  baseUrl: string;
  fetchImpl?: LocalEngineFetch;
  printMixTimeoutMs?: number;
  projectMixdownTimeoutMs?: number;
  timeoutMs?: number;
  token: string;
}>;

const validLifecycleStates = new Set<EngineLifecycleState>([
  'STARTING',
  'READY',
  'STOPPING',
  'OFFLINE',
  'ERROR',
  'VERSION_MISMATCH',
]);
const validActivityStates = new Set<EngineActivityState>(['IDLE', 'BUSY']);
const validSourceAvailabilityStates = new Set<LocalEngineSourceAvailability>([
  'available',
  'unresolved',
  'missing',
  'unopenable',
]);
const validSoundFontIssueReasons = new Set<LocalEngineSoundFontIssueReason>([
  'DEPTH_LIMIT',
  'OUTSIDE_CATALOG',
  'SYMBOLIC_LINK',
  'UNAVAILABLE',
  'UNREADABLE',
]);

export class LocalEngineClient {
  readonly #aceStepLyricsUrl: string;
  readonly #audioFilesUrl: string;
  readonly #basicPitchRuntimeUrl: string;
  readonly #fetch: LocalEngineFetch;
  readonly #generatedAudioAvailabilityUrl: string;
  readonly #generatedAudioUrl: string;
  readonly #healthUrl: string;
  readonly #jobsUrl: string;
  readonly #projectFileUrl: string;
  readonly #printMixesUrl: string;
  readonly #printMixTimeoutMs: number;
  readonly #projectMixdownsUrl: string;
  readonly #projectMixdownTimeoutMs: number;
  readonly #projectStemPrintsUrl: string;
  readonly #recordingsUrl: string;
  readonly #soundFontAuditionUrl: string;
  readonly #soundFontLivePreviewUrl: string;
  readonly #soundFontPresetsUrl: string;
  readonly #soundFontsUrl: string;
  readonly #projectRootSelectUrl: string;
  readonly #projectRootUrl: string;
  readonly #sourceRestoreUrl: string;
  readonly #timeoutMs: number;
  readonly #token: string;

  constructor({
    baseUrl,
    fetchImpl,
    printMixTimeoutMs = PRINT_MIX_CLIENT_TIMEOUT_MS,
    projectMixdownTimeoutMs = PROJECT_MIXDOWN_CLIENT_TIMEOUT_MS,
    timeoutMs = 2_000,
    token,
  }: LocalEngineClientOptions) {
    const engineOrigin = createEngineOrigin(baseUrl);
    this.#aceStepLyricsUrl = new URL(
      LOCAL_ENGINE_ACE_STEP_LYRICS_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#audioFilesUrl = new URL(
      LOCAL_ENGINE_AUDIO_FILES_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#basicPitchRuntimeUrl = new URL(
      LOCAL_ENGINE_BASIC_PITCH_RUNTIME_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#generatedAudioUrl = new URL(
      LOCAL_ENGINE_GENERATED_AUDIO_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#generatedAudioAvailabilityUrl = new URL(
      LOCAL_ENGINE_GENERATED_AUDIO_AVAILABILITY_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#healthUrl = new URL(LOCAL_ENGINE_HEALTH_PATH, `${engineOrigin}/`).toString();
    this.#jobsUrl = new URL(LOCAL_ENGINE_JOBS_PATH, `${engineOrigin}/`).toString();
    this.#projectFileUrl = new URL(LOCAL_ENGINE_PROJECT_FILE_PATH, `${engineOrigin}/`).toString();
    this.#printMixesUrl = new URL(
      LOCAL_ENGINE_PRINT_MIXES_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#projectMixdownsUrl = new URL(
      LOCAL_ENGINE_PROJECT_MIXDOWNS_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#projectStemPrintsUrl = new URL(
      LOCAL_ENGINE_PROJECT_STEM_PRINTS_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#recordingsUrl = new URL(LOCAL_ENGINE_RECORDINGS_PATH, `${engineOrigin}/`).toString();
    this.#soundFontAuditionUrl = new URL(
      LOCAL_ENGINE_SOUNDFONT_AUDITION_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#soundFontLivePreviewUrl = new URL(
      LOCAL_ENGINE_SOUNDFONT_LIVE_PREVIEW_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#soundFontPresetsUrl = new URL(
      LOCAL_ENGINE_SOUNDFONT_PRESETS_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#soundFontsUrl = new URL(LOCAL_ENGINE_SOUNDFONTS_PATH, `${engineOrigin}/`).toString();
    this.#projectRootUrl = new URL(LOCAL_ENGINE_PROJECT_ROOT_PATH, `${engineOrigin}/`).toString();
    this.#projectRootSelectUrl = new URL(
      LOCAL_ENGINE_PROJECT_ROOT_SELECT_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#sourceRestoreUrl = new URL(
      LOCAL_ENGINE_SOURCE_RESTORE_PATH,
      `${engineOrigin}/`,
    ).toString();
    this.#token = validateLaunchToken(token);
    this.#printMixTimeoutMs = validateTimeout(printMixTimeoutMs);
    this.#projectMixdownTimeoutMs = validateTimeout(projectMixdownTimeoutMs);
    this.#timeoutMs = validateTimeout(timeoutMs);
    this.#fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async checkHealth(): Promise<LocalEngineHealthResult> {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(this.#healthUrl, {
        cache: 'no-store',
        headers: { [LOCAL_ENGINE_TOKEN_HEADER]: this.#token },
        method: 'GET',
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          message: 'Local Engine rejected the launch token.',
          ok: false,
          reason: 'unauthorized',
          status: response.status,
        };
      }

      if (!response.ok) {
        return {
          message: `Local Engine Health Check failed with HTTP ${response.status}.`,
          ok: false,
          reason: 'http-error',
          status: response.status,
        };
      }

      const health = parseLocalEngineHealth(await response.json());

      if (!health) {
        return {
          message: 'Local Engine returned an invalid Health response.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      if (health.protocolVersion !== LOCAL_ENGINE_PROTOCOL_VERSION) {
        return {
          message: `Local Engine protocol v${health.protocolVersion} does not match UI protocol v${LOCAL_ENGINE_PROTOCOL_VERSION}.`,
          ok: false,
          reason: 'version-mismatch',
        };
      }

      return { health, ok: true };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          message: `Local Engine Health Check timed out after ${this.#timeoutMs} ms.`,
          ok: false,
          reason: 'timeout',
        };
      }

      return {
        message: error instanceof Error ? error.message : 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      };
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  async getProjectRoot(): Promise<LocalEngineProjectRootResult> {
    return this.#requestProjectRoot(this.#projectRootUrl, 'GET', this.#timeoutMs, false);
  }

  async checkBasicPitchRuntime(): Promise<LocalEngineBasicPitchRuntimeResult> {
    const result = await this.#requestJsonApi(
      this.#basicPitchRuntimeUrl,
      { method: 'GET' },
      parseBasicPitchRuntimeEnvelope,
      'Basic Pitch Runtime inspection',
      180_000,
    );
    return result.ok ? { ok: true, runtime: result.value } : result;
  }

  async runProjectMixdown(
    request: ProjectMixdownApiRequest,
    signal?: AbortSignal,
  ): Promise<LocalEngineProjectMixdownResult> {
    return this.#requestProjectMixdown(request, signal);
  }

  async runPrintMix(
    request: PrintMixRequest,
    signal?: AbortSignal,
  ): Promise<LocalEnginePrintMixResult> {
    if (request.plan.mediaType !== 'audio') {
      throw new TypeError('Local Engine Audio PRINT MIX requires an Audio Plan.');
    }

    return this.#requestProjectRenderOperation(
      request,
      this.#printMixesUrl,
      'Audio PRINT MIX',
      (value) => parsePrintMixOperation(value, request),
      signal,
      this.#printMixTimeoutMs,
      'PRINT_MIX_OUTCOME_UNKNOWN',
    );
  }

  async recoverPrintMix(
    request: PrintMixRequest,
    unknownOutcome: Extract<LocalEnginePrintMixResult, { outcome: 'unknown' }>,
    signal?: AbortSignal,
  ): Promise<LocalEnginePrintMixResult> {
    if (unknownOutcome.operationId !== request.operationId) {
      throw new Error('PRINT MIX recovery must reuse the unknown operationId.');
    }

    return this.runPrintMix(request, signal);
  }

  async recoverProjectMixdown(
    request: ProjectMixdownApiRequest,
    unknownOutcome: Extract<
      LocalEngineProjectMixdownResult,
      { outcome: 'unknown' }
    >,
    signal?: AbortSignal,
  ): Promise<LocalEngineProjectMixdownResult> {
    if (unknownOutcome.operationId !== request.operationId) {
      throw new Error(
        'Project Mixdown recovery must reuse the unknown operationId.',
      );
    }

    return this.#requestProjectMixdown(request, signal);
  }

  async runProjectStemPrint(
    request: ProjectStemPrintApiRequest,
    signal?: AbortSignal,
  ): Promise<LocalEngineProjectStemPrintResult> {
    if (signal?.aborted) {
      return {
        message: 'Project Stem Print was canceled before dispatch.',
        ok: false,
        outcome: 'not-dispatched',
        reason: 'canceled',
      };
    }

    const planSha256 = await createProjectStemPrintPlanSha256(request.plan);
    return this.#requestProjectRenderOperation(
      request,
      this.#projectStemPrintsUrl,
      'Project Stem Print',
      (value) => parseProjectStemPrintApiOperation(
        value,
        request,
        planSha256,
      ),
      signal,
    );
  }

  async recoverProjectStemPrint(
    request: ProjectStemPrintApiRequest,
    unknownOutcome: Extract<
      LocalEngineProjectStemPrintResult,
      { outcome: 'unknown' }
    >,
    signal?: AbortSignal,
  ): Promise<LocalEngineProjectStemPrintResult> {
    if (unknownOutcome.operationId !== request.operationId) {
      throw new Error(
        'Project Stem Print recovery must reuse the unknown operationId.',
      );
    }

    return this.runProjectStemPrint(request, signal);
  }

  async listSoundFonts(): Promise<LocalEngineSoundFontCatalogResult> {
    const result = await this.#requestJsonApi(
      this.#soundFontsUrl,
      { method: 'GET' },
      parseLocalEngineSoundFontCatalog,
      'SoundFont catalog',
    );
    return result.ok ? { catalog: result.value, ok: true } : result;
  }

  async listSoundFontPresets(
    request: LocalEngineSoundFontPresetCatalogRequest,
  ): Promise<LocalEngineSoundFontPresetCatalogResult> {
    const result = await this.#requestJsonApi(
      this.#soundFontPresetsUrl,
      {
        body: JSON.stringify(request),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
      parseLocalEngineSoundFontPresetCatalog,
      'SoundFont preset catalog',
      35_000,
    );
    return result.ok ? { catalog: result.value, ok: true } : result;
  }

  async renderSoundFontAudition(
    request: LocalEngineSoundFontAuditionRequest,
    signal?: AbortSignal,
  ): Promise<LocalEngineSoundFontAuditionResult> {
    if (signal?.aborted) {
      return {
        message: 'SoundFont audition was canceled.',
        ok: false,
        reason: 'canceled',
      };
    }

    const controller = new AbortController();
    const timeoutMs = 60_000;
    let didTimeOut = false;
    const handleExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', handleExternalAbort, { once: true });
    const timeoutId = globalThis.setTimeout(() => {
      didTimeOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.#fetch(this.#soundFontAuditionUrl, {
        body: JSON.stringify(request),
        cache: 'no-store',
        headers: {
          Accept: 'audio/wav',
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: this.#token,
        },
        method: 'POST',
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          message: 'Local Engine rejected the launch token.',
          ok: false,
          reason: 'unauthorized',
          status: response.status,
        };
      }

      if (!response.ok) {
        return {
          message:
            (await readEngineErrorBody(response)) ??
            `Local Engine SoundFont audition failed with HTTP ${response.status}.`,
          ok: false,
          reason: 'http-error',
          status: response.status,
        };
      }

      const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase();

      if (contentType !== 'audio/wav') {
        return {
          message: 'Local Engine returned SoundFont audition audio with an invalid Content-Type.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      const wav = await response.blob();

      if (
        wav.type.split(';', 1)[0].toLowerCase() !== 'audio/wav' ||
        wav.size < 44 ||
        !(await isRiffWavBlob(wav))
      ) {
        return {
          message: 'Local Engine returned an invalid SoundFont audition WAV.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      return { ok: true, wav };
    } catch (error) {
      if (isAbortError(error)) {
        return signal?.aborted && !didTimeOut
          ? {
              message: 'SoundFont audition was canceled.',
              ok: false,
              reason: 'canceled',
            }
          : {
              message: `Local Engine SoundFont audition timed out after ${timeoutMs} ms.`,
              ok: false,
              reason: 'timeout',
            };
      }

      return {
        message: error instanceof Error ? error.message : 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      };
    } finally {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleExternalAbort);
    }
  }

  async getJobs(): Promise<LocalEngineGpuJobSnapshotResult> {
    const result = await this.#requestJsonApi(
      this.#jobsUrl,
      { method: 'GET' },
      parseLocalEngineGpuJobSnapshot,
      'GPU Job snapshot',
    );
    return result.ok ? { ok: true, snapshot: result.value } : result;
  }

  async enqueueMockJob(request: LocalEngineMockJobRequest): Promise<LocalEngineGpuJobResult> {
    const result = await this.#requestJsonApi(
      this.#jobsUrl,
      {
        body: JSON.stringify({ request }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
      (value) => parseJobEnvelope(value, 'job'),
      'GPU Job enqueue',
    );
    return result.ok ? { job: result.value, ok: true } : result;
  }

  async enqueueMockHumToMidiJob(
    request: LocalEngineMockHumToMidiJobRequest,
  ): Promise<LocalEngineGpuJobResult> {
    const result = await this.#requestJsonApi(
      this.#jobsUrl,
      {
        body: JSON.stringify({ request }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
      (value) => parseJobEnvelope(value, 'job'),
      'Hum-to-MIDI Job enqueue',
    );
    return result.ok ? { job: result.value, ok: true } : result;
  }

  async enqueueBasicPitchHumToMidiJob(
    request: LocalEngineBasicPitchHumToMidiJobRequest,
  ): Promise<LocalEngineGpuJobResult> {
    const result = await this.#requestJsonApi(
      this.#jobsUrl,
      {
        body: JSON.stringify({ request }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
      (value) => parseJobEnvelope(value, 'job'),
      'Basic Pitch Hum-to-MIDI Job enqueue',
    );
    return result.ok ? { job: result.value, ok: true } : result;
  }

  async enqueueInstrumentRenderJob(
    request: LocalEngineInstrumentRenderJobRequest,
  ): Promise<LocalEngineGpuJobResult> {
    const result = await this.#requestJsonApi(
      this.#jobsUrl,
      {
        body: JSON.stringify({ request }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
      (value) => parseJobEnvelope(value, 'job'),
      'Instrument Render Job enqueue',
    );
    return result.ok ? { job: result.value, ok: true } : result;
  }

  async controlSoundFontLivePreview(
    request: LocalEngineSoundFontLivePreviewRequest,
  ): Promise<LocalEngineSoundFontLivePreviewResult> {
    const result = await this.#requestJsonApi(
      this.#soundFontLivePreviewUrl,
      {
        body: JSON.stringify(request),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
      parseLocalEngineSoundFontLivePreviewSnapshot,
      'SoundFont Live Preview',
    );
    return result.ok ? { ok: true, snapshot: result.value } : result;
  }

  async enqueueAceStepJob(
    request: LocalEngineAceStepJobRequest,
  ): Promise<LocalEngineGpuJobResult> {
    const result = await this.#requestJsonApi(
      this.#jobsUrl,
      {
        body: JSON.stringify({ request }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
      (value) => parseJobEnvelope(value, 'job'),
      'ACE-Step Job enqueue',
    );
    return result.ok ? { job: result.value, ok: true } : result;
  }

  async enqueueStableAudio3Job(
    request: LocalEngineStableAudio3JobRequest,
  ): Promise<LocalEngineGpuJobResult> {
    const result = await this.#requestJsonApi(
      this.#jobsUrl,
      {
        body: JSON.stringify({ request }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
      (value) => parseJobEnvelope(value, 'job'),
      'Stable Audio 3 Job enqueue',
    );
    return result.ok ? { job: result.value, ok: true } : result;
  }

  async cancelJob(jobId: string): Promise<LocalEngineGpuJobResult> {
    return this.#requestJobOperation(jobId, 'cancel');
  }

  async retryJob(jobId: string): Promise<LocalEngineGpuJobResult> {
    return this.#requestJobOperation(jobId, 'retry');
  }

  async removeQueuedJob(jobId: string): Promise<LocalEngineGpuJobRemovalResult> {
    const result = await this.#requestJsonApi(
      this.#createJobUrl(jobId),
      { method: 'DELETE' },
      (value) => parseJobEnvelope(value, 'removedJob'),
      'GPU Job removal',
    );
    return result.ok ? { ok: true, removedJob: result.value } : result;
  }

  async selectProjectRoot(): Promise<LocalEngineProjectRootResult> {
    return this.#requestProjectRoot(this.#projectRootSelectUrl, 'POST', 10 * 60_000, true);
  }

  async loadProjectFile(): Promise<LocalEngineProjectFileLoadResult> {
    const result = await this.#requestJsonApi(
      this.#projectFileUrl,
      {
        headers: { Accept: 'application/json' },
        method: 'GET',
      },
      parseLocalEngineProjectFileLoad,
      'Project open',
    );

    return result.ok ? { loadedProject: result.value, ok: true } : result;
  }

  async saveProjectFile(projectFile: unknown): Promise<LocalEngineProjectFileSaveResult> {
    const controller = new AbortController();
    const timeoutMs = 10_000;
    const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#fetch(this.#projectFileUrl, {
        body: JSON.stringify(projectFile),
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: this.#token,
        },
        method: 'PUT',
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          message: 'Local Engine rejected the launch token.',
          ok: false,
          reason: 'unauthorized',
          status: response.status,
        };
      }

      if (!response.ok) {
        const errorBody = await readEngineErrorBody(response);

        return {
          message: errorBody ?? `Local Engine Project save failed with HTTP ${response.status}.`,
          ok: false,
          reason: 'http-error',
          status: response.status,
        };
      }

      const savedProject = parseLocalEngineProjectFileSave(await response.json());

      if (!savedProject) {
        return {
          message: 'Local Engine returned an invalid Project save response.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      return { ok: true, savedProject };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          message: `Local Engine Project save timed out after ${timeoutMs} ms.`,
          ok: false,
          reason: 'timeout',
        };
      }

      return {
        message: error instanceof Error ? error.message : 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      };
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  async saveAceStepLyrics(
    lyrics: string,
  ): Promise<LocalEngineAceStepLyricsSaveResult> {
    if (typeof lyrics !== 'string') {
      throw new TypeError('ACE-Step Lyrics save requires a string.');
    }

    const controller = new AbortController();
    const timeoutMs = 10_000;
    const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#fetch(this.#aceStepLyricsUrl, {
        body: JSON.stringify({ lyrics }),
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: this.#token,
        },
        method: 'POST',
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          message: 'Local Engine rejected the launch token.',
          ok: false,
          reason: 'unauthorized',
          status: response.status,
        };
      }

      if (!response.ok) {
        const errorBody = await readEngineErrorBody(response);

        return {
          message:
            errorBody ??
            `Local Engine ACE-Step Lyrics save failed with HTTP ${response.status}.`,
          ok: false,
          reason: 'http-error',
          status: response.status,
        };
      }

      const lyricsSnapshot = parseLocalEngineAceStepLyricsSnapshot(
        await response.json(),
      );

      if (!lyricsSnapshot) {
        return {
          message: 'Local Engine returned an invalid ACE-Step Lyrics snapshot.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      return { lyricsSnapshot, ok: true };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          message: `Local Engine ACE-Step Lyrics save timed out after ${timeoutMs} ms.`,
          ok: false,
          reason: 'timeout',
        };
      }

      return {
        message:
          error instanceof Error
            ? error.message
            : 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      };
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  async saveRecordingWav(recordingWav: Blob): Promise<LocalEngineRecordingSaveResult> {
    if (!(recordingWav instanceof Blob) || recordingWav.type !== 'audio/wav') {
      throw new TypeError('Recording upload requires an audio/wav Blob.');
    }

    const controller = new AbortController();
    const timeoutMs = 60_000;
    const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#fetch(this.#recordingsUrl, {
        body: recordingWav,
        cache: 'no-store',
        headers: {
          'Content-Type': 'audio/wav',
          [LOCAL_ENGINE_TOKEN_HEADER]: this.#token,
        },
        method: 'POST',
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          message: 'Local Engine rejected the launch token.',
          ok: false,
          reason: 'unauthorized',
          status: response.status,
        };
      }

      if (!response.ok) {
        const errorBody = await readEngineErrorBody(response);

        return {
          message:
            errorBody ??
            `Local Engine recording save failed with HTTP ${response.status}.`,
          ok: false,
          reason: 'http-error',
          status: response.status,
        };
      }

      const recording = parseLocalEngineRecordingArtifact(await response.json());

      if (!recording) {
        return {
          message: 'Local Engine returned an invalid recording save response.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      return { ok: true, recording };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          message: `Local Engine recording save timed out after ${timeoutMs} ms.`,
          ok: false,
          reason: 'timeout',
        };
      }

      return {
        message: error instanceof Error ? error.message : 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      };
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  async restoreSources(
    sources: readonly LocalEngineSourceDescriptor[],
  ): Promise<LocalEngineSourceRestorationResult> {
    const controller = new AbortController();
    const timeoutMs = 10_000;
    const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#fetch(this.#sourceRestoreUrl, {
        body: JSON.stringify({ sources }),
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: this.#token,
        },
        method: 'POST',
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          message: 'Local Engine rejected the launch token.',
          ok: false,
          reason: 'unauthorized',
          status: response.status,
        };
      }

      if (!response.ok) {
        const errorBody = await readEngineErrorBody(response);

        return {
          message: errorBody ?? `Local Engine source restoration failed with HTTP ${response.status}.`,
          ok: false,
          reason: 'http-error',
          status: response.status,
        };
      }

      const restoration = parseLocalEngineSourceRestoration(await response.json());

      if (!restoration) {
        return {
          message: 'Local Engine returned an invalid source restoration response.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      return { ok: true, restoration };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          message: `Local Engine source restoration timed out after ${timeoutMs} ms.`,
          ok: false,
          reason: 'timeout',
        };
      }

      return {
        message: error instanceof Error ? error.message : 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      };
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  async readGeneratedAudioWav(
    source: LocalEngineGeneratedAudioDescriptor,
    options: LocalEngineGeneratedAudioReadOptions = {},
  ): Promise<LocalEngineGeneratedAudioReadResult> {
    const controller = new AbortController();
    const timeoutMs = 60_000;
    let didTimeout = false;
    const timeoutId = globalThis.setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);
    const handleExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', handleExternalAbort, { once: true });

    if (options.signal?.aborted) {
      controller.abort();
    }

    try {
      const response = await this.#fetch(this.#generatedAudioUrl, {
        body: JSON.stringify({ source }),
        cache: 'no-store',
        headers: {
          Accept: 'audio/wav',
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: this.#token,
        },
        method: 'POST',
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          message: 'Local Engine rejected the launch token.',
          ok: false,
          reason: 'unauthorized',
          status: response.status,
        };
      }

      if (!response.ok) {
        const errorBody = await readEngineErrorBody(response);

        return {
          message:
            errorBody ??
            `Local Engine generated audio read failed with HTTP ${response.status}.`,
          ok: false,
          reason: 'http-error',
          status: response.status,
        };
      }

      const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase();

      if (contentType !== 'audio/wav') {
        return {
          message: 'Local Engine returned generated audio with an invalid Content-Type.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      const wav = await response.blob();

      if (
        wav.type.split(';', 1)[0].toLowerCase() !== 'audio/wav' ||
        wav.size !== source.sizeBytes ||
        !(await isRiffWavBlob(wav))
      ) {
        return {
          message: 'Local Engine returned an invalid generated WAV response.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      return { ok: true, wav };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          message: didTimeout
            ? `Local Engine generated audio read timed out after ${timeoutMs} ms.`
            : 'Local Engine generated audio read was canceled.',
          ok: false,
          reason: didTimeout ? 'timeout' : 'canceled',
        };
      }

      return {
        message: error instanceof Error ? error.message : 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      };
    } finally {
      globalThis.clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', handleExternalAbort);
    }
  }

  async checkGeneratedAudioAvailability(
    sources: readonly LocalEngineGeneratedAudioDescriptor[],
  ): Promise<LocalEngineGeneratedAudioAvailabilityResult> {
    const controller = new AbortController();
    const timeoutMs = 10_000;
    const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#fetch(this.#generatedAudioAvailabilityUrl, {
        body: JSON.stringify({ sources }),
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: this.#token,
        },
        method: 'POST',
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          message: 'Local Engine rejected the launch token.',
          ok: false,
          reason: 'unauthorized',
          status: response.status,
        };
      }

      if (!response.ok) {
        const errorBody = await readEngineErrorBody(response);

        return {
          message:
            errorBody ??
            `Local Engine generated audio availability failed with HTTP ${response.status}.`,
          ok: false,
          reason: 'http-error',
          status: response.status,
        };
      }

      const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase();

      if (contentType !== 'application/json') {
        return {
          message: 'Local Engine returned generated audio availability with an invalid Content-Type.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      const availableSourceIds = parseGeneratedAudioAvailability(
        await response.json(),
        sources,
      );

      if (!availableSourceIds) {
        return {
          message: 'Local Engine returned an invalid generated audio availability response.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      return { availableSourceIds, ok: true };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          message: `Local Engine generated audio availability timed out after ${timeoutMs} ms.`,
          ok: false,
          reason: 'timeout',
        };
      }

      return {
        message: error instanceof Error ? error.message : 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      };
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  async deleteAudioArtifactFile(
    file: LocalEngineAudioFileDeletionDescriptor,
  ): Promise<LocalEngineAudioFileDeletionResult> {
    const controller = new AbortController();
    const timeoutMs = 10_000;
    const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#fetch(this.#audioFilesUrl, {
        body: JSON.stringify({ file }),
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: this.#token,
        },
        method: 'DELETE',
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          message: 'Local Engine rejected the launch token.',
          ok: false,
          reason: 'unauthorized',
          status: response.status,
        };
      }

      if (!response.ok) {
        const errorBody = await readEngineErrorBody(response);

        return {
          message:
            errorBody ??
            `Local Engine Audio Artifact file deletion failed with HTTP ${response.status}.`,
          ok: false,
          reason: 'http-error',
          status: response.status,
        };
      }

      const body: unknown = await response.json();
      const deletedFile =
        isRecord(body) && 'deletedFile' in body
          ? parseLocalEngineDeletedAudioFile(body.deletedFile, file)
          : undefined;

      if (!deletedFile) {
        return {
          message: 'Local Engine returned an invalid Audio Artifact file deletion response.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      return { deletedFile, ok: true };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          message: `Local Engine Audio Artifact file deletion timed out after ${timeoutMs} ms.`,
          ok: false,
          reason: 'timeout',
        };
      }

      return {
        message: error instanceof Error ? error.message : 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      };
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  async #requestProjectRoot(
    url: string,
    method: 'GET' | 'POST',
    timeoutMs: number,
    expectsSelection: boolean,
  ): Promise<LocalEngineProjectRootResult> {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#fetch(url, {
        cache: 'no-store',
        headers: { [LOCAL_ENGINE_TOKEN_HEADER]: this.#token },
        method,
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          message: 'Local Engine rejected the launch token.',
          ok: false,
          reason: 'unauthorized',
          status: response.status,
        };
      }

      if (!response.ok) {
        return {
          message: `Local Engine Project Root request failed with HTTP ${response.status}.`,
          ok: false,
          reason: 'http-error',
          status: response.status,
        };
      }

      const body: unknown = await response.json();
      const projectRoot = parseLocalEngineProjectRoot(body);
      const selection = parseProjectRootSelection(body);

      if (!projectRoot || (expectsSelection && !selection)) {
        return {
          message: 'Local Engine returned an invalid Project Root response.',
          ok: false,
          reason: 'invalid-response',
        };
      }

      return { ok: true, projectRoot, ...(selection ? { selection } : {}) };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          message: 'Local Engine Project Root request timed out.',
          ok: false,
          reason: 'timeout',
        };
      }

      return {
        message: error instanceof Error ? error.message : 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      };
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  async #requestJobOperation(
    jobId: string,
    action: 'cancel' | 'retry',
  ): Promise<LocalEngineGpuJobResult> {
    const result = await this.#requestJsonApi(
      `${this.#createJobUrl(jobId)}/${action}`,
      { method: 'POST' },
      (value) => parseJobEnvelope(value, 'job'),
      `GPU Job ${action}`,
    );
    return result.ok ? { job: result.value, ok: true } : result;
  }

  async #requestProjectMixdown(
    request: ProjectMixdownApiRequest,
    signal?: AbortSignal,
  ): Promise<LocalEngineProjectMixdownResult> {
    return this.#requestProjectRenderOperation(
      request,
      this.#projectMixdownsUrl,
      'Project Mixdown',
      (value) => parseProjectMixdownApiOperation(value, request.operationId),
      signal,
    );
  }

  async #requestProjectRenderOperation<
    Request extends Readonly<{ operationId: string }>,
    Operation,
  >(
    request: Request,
    url: string,
    label: 'Audio PRINT MIX' | 'Project Mixdown' | 'Project Stem Print',
    parseOperation: (
      value: unknown,
    ) => Operation | undefined | Promise<Operation | undefined>,
    signal?: AbortSignal,
    timeoutMs = this.#projectMixdownTimeoutMs,
    unknownResponseCode?: string,
  ): Promise<LocalEngineProjectRenderResult<Operation>> {
    if (signal?.aborted) {
      return {
        message: `${label} was canceled before dispatch.`,
        ok: false,
        outcome: 'not-dispatched',
        reason: 'canceled',
      };
    }

    const controller = new AbortController();
    let didTimeOut = false;
    const handleExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', handleExternalAbort, { once: true });
    const timeoutId = globalThis.setTimeout(() => {
      didTimeOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.#fetch(url, {
        body: JSON.stringify(request),
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          [LOCAL_ENGINE_TOKEN_HEADER]: this.#token,
        },
        method: 'POST',
        signal: controller.signal,
      });
      let body: unknown;

      try {
        body = await response.json();
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          return unknownProjectRenderOutcome(
            request.operationId,
            didTimeOut ? 'timeout' : 'canceled',
            didTimeOut
              ? `Local Engine ${label} timed out after ${timeoutMs} ms.`
              : `${label} response was lost after cancellation was requested.`,
            response.status,
          );
        }

        return unknownProjectRenderOutcome(
          request.operationId,
          'invalid-response',
          `Local Engine returned an unreadable ${label} response.`,
          response.status,
        );
      }

      if (!response.ok) {
        const rejection = parseStructuredEngineRejection(body);

        if (
          unknownResponseCode !== undefined &&
          rejection?.code === unknownResponseCode
        ) {
          return unknownProjectRenderOutcome(
            request.operationId,
            'engine-reported',
            rejection.message,
            response.status,
          );
        }

        return rejection
          ? {
              code: rejection.code,
              message: rejection.message,
              ok: false,
              outcome: 'confirmed',
              reason: 'rejected',
              status: response.status,
            }
          : unknownProjectRenderOutcome(
              request.operationId,
              'invalid-response',
              `Local Engine returned an invalid ${label} rejection.`,
              response.status,
            );
      }

      const operation = await parseOperation(body);

      return operation
        ? { ok: true, operation }
        : unknownProjectRenderOutcome(
            request.operationId,
            'invalid-response',
            `Local Engine returned an invalid ${label} success response.`,
            response.status,
          );
    } catch (error) {
      if (isAbortError(error)) {
        return unknownProjectRenderOutcome(
          request.operationId,
          didTimeOut ? 'timeout' : 'canceled',
          didTimeOut
            ? `Local Engine ${label} timed out after ${timeoutMs} ms.`
            : `${label} response was lost after cancellation was requested.`,
        );
      }

      return unknownProjectRenderOutcome(
        request.operationId,
        'offline',
        error instanceof Error
          ? error.message
          : `Local Engine became unreachable during ${label}.`,
      );
    } finally {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleExternalAbort);
    }
  }

  async #requestJsonApi<T>(
    url: string,
    init: Pick<RequestInit, 'body' | 'headers' | 'method'>,
    parse: (value: unknown) => T | undefined,
    label: string,
    timeoutMs = 10_000,
  ): Promise<{ ok: true; value: T } | LocalEngineRequestFailure> {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#fetch(url, {
        ...init,
        cache: 'no-store',
        headers: {
          ...init.headers,
          [LOCAL_ENGINE_TOKEN_HEADER]: this.#token,
        },
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          message: 'Local Engine rejected the launch token.',
          ok: false,
          reason: 'unauthorized',
          status: response.status,
        };
      }

      if (!response.ok) {
        return {
          message:
            (await readEngineErrorBody(response)) ??
            `Local Engine ${label} failed with HTTP ${response.status}.`,
          ok: false,
          reason: 'http-error',
          status: response.status,
        };
      }

      const parsed = parse(await response.json());

      if (!parsed) {
        return {
          message: `Local Engine returned an invalid ${label} response.`,
          ok: false,
          reason: 'invalid-response',
        };
      }

      return { ok: true, value: parsed };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          message: `Local Engine ${label} timed out after ${timeoutMs} ms.`,
          ok: false,
          reason: 'timeout',
        };
      }

      return {
        message: error instanceof Error ? error.message : 'Local Engine is unreachable.',
        ok: false,
        reason: 'offline',
      };
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  #createJobUrl(jobId: string): string {
    if (!isLocalEngineJobId(jobId)) {
      throw new Error('GPU Job ID must start with job- and use lowercase letters, numbers, and hyphens.');
    }

    return `${this.#jobsUrl}/${jobId}`;
  }
}

export function parseLocalEngineHealth(value: unknown): LocalEngineHealth | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value.activity !== 'string' ||
    !validActivityStates.has(value.activity as EngineActivityState) ||
    typeof value.engineVersion !== 'string' ||
    typeof value.instanceId !== 'string' ||
    typeof value.lifecycle !== 'string' ||
    !validLifecycleStates.has(value.lifecycle as EngineLifecycleState) ||
    typeof value.protocolVersion !== 'string' ||
    typeof value.startedAt !== 'string' ||
    Number.isNaN(Date.parse(value.startedAt))
  ) {
    return undefined;
  }

  return Object.freeze({
    activity: value.activity as EngineActivityState,
    engineVersion: value.engineVersion,
    instanceId: value.instanceId,
    lifecycle: value.lifecycle as EngineLifecycleState,
    protocolVersion: value.protocolVersion,
    startedAt: value.startedAt,
  });
}

export function parseLocalEngineProjectRoot(value: unknown): LocalEngineProjectRoot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.status === 'UNSET') {
    if (value.recoveryIssue !== undefined && typeof value.recoveryIssue !== 'string') {
      return undefined;
    }

    return Object.freeze({
      ...(value.recoveryIssue ? { recoveryIssue: value.recoveryIssue } : {}),
      status: 'UNSET',
    });
  }

  const projectFile = isRecord(value.projectFile)
    ? parseLocalEngineProjectFileStatus(value.projectFile)
    : undefined;

  if (
    value.status !== 'READY' ||
    typeof value.configuredAt !== 'string' ||
    Number.isNaN(Date.parse(value.configuredAt)) ||
    !Array.isArray(value.directories) ||
    value.directories.length === 0 ||
    !value.directories.every((directory) => typeof directory === 'string' && directory.length > 0) ||
    !projectFile ||
    typeof value.projectFileName !== 'string' ||
    value.projectFileName.length === 0 ||
    typeof value.rootName !== 'string' ||
    value.rootName.length === 0 ||
    typeof value.rootPath !== 'string' ||
    value.rootPath.length === 0
  ) {
    return undefined;
  }

  return Object.freeze({
    configuredAt: value.configuredAt,
    directories: Object.freeze([...value.directories]) as readonly string[],
    projectFile,
    projectFileName: value.projectFileName,
    rootName: value.rootName,
    rootPath: value.rootPath,
    status: 'READY',
  });
}

export function parseLocalEngineSoundFontCatalog(
  value: unknown,
): LocalEngineSoundFontCatalog | undefined {
  if (
    !isRecord(value) ||
    value.directory !== 'soundfonts' ||
    typeof value.scannedAt !== 'string' ||
    Number.isNaN(Date.parse(value.scannedAt)) ||
    !Array.isArray(value.supportedFormats) ||
    value.supportedFormats.length !== 2 ||
    value.supportedFormats[0] !== 'sf2' ||
    value.supportedFormats[1] !== 'sf3' ||
    !Array.isArray(value.resources) ||
    !Array.isArray(value.issues)
  ) {
    return undefined;
  }

  const resources = value.resources.map(parseLocalEngineSoundFontResource);
  const issues = value.issues.map(parseLocalEngineSoundFontIssue);

  if (
    resources.some((resource) => !resource) ||
    issues.some((issue) => !issue) ||
    hasDuplicateValues(
      resources.map((resource) => resource?.resourceId),
    ) ||
    hasDuplicateValues(
      resources.map((resource) => resource?.relativePath),
    )
  ) {
    return undefined;
  }

  return Object.freeze({
    directory: 'soundfonts',
    issues: Object.freeze(
      issues as Readonly<{
        reason: LocalEngineSoundFontIssueReason;
        relativePath: string;
      }>[],
    ),
    resources: Object.freeze(resources as LocalEngineSoundFontResource[]),
    scannedAt: value.scannedAt,
    supportedFormats: Object.freeze(['sf2', 'sf3'] as const),
  });
}

export function parseLocalEngineSoundFontPresetCatalog(
  value: unknown,
): LocalEngineSoundFontPresetCatalog | undefined {
  if (
    !isRecord(value) ||
    typeof value.resourceId !== 'string' ||
    !/^soundfont-[a-f0-9]{32}$/u.test(value.resourceId) ||
    typeof value.revisionToken !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.revisionToken) ||
    !Array.isArray(value.presets)
  ) {
    return undefined;
  }

  const presets = value.presets.map(parseLocalEngineSoundFontPreset);

  if (
    presets.length === 0 ||
    presets.some((preset) => !preset) ||
    hasDuplicateValues(
      presets.map((preset) =>
        preset ? `${preset.bank}:${preset.program}` : undefined,
      ),
    )
  ) {
    return undefined;
  }

  return Object.freeze({
    presets: Object.freeze(presets as LocalEngineSoundFontPreset[]),
    resourceId: value.resourceId,
    revisionToken: value.revisionToken,
  });
}

export function parseLocalEngineSoundFontLivePreviewSnapshot(
  value: unknown,
): LocalEngineSoundFontLivePreviewSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.status === 'STOPPED') {
    return Object.freeze({ status: 'STOPPED' });
  }

  if (
    typeof value.sessionId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(value.sessionId)
  ) {
    return undefined;
  }

  if (
    value.status === 'TRIGGERED' &&
    typeof value.pitch === 'number' &&
    Number.isInteger(value.pitch) &&
    value.pitch >= 0 &&
    value.pitch <= 127
  ) {
    return Object.freeze({
      pitch: value.pitch,
      sessionId: value.sessionId,
      status: 'TRIGGERED',
    });
  }

  if (
    value.status === 'READY' &&
    typeof value.bank === 'number' &&
    Number.isInteger(value.bank) &&
    value.bank >= 0 &&
    value.bank <= 16_383 &&
    typeof value.program === 'number' &&
    Number.isInteger(value.program) &&
    value.program >= 0 &&
    value.program <= 127 &&
    typeof value.resourceId === 'string' &&
    /^soundfont-[a-f0-9]{32}$/.test(value.resourceId)
  ) {
    return Object.freeze({
      bank: value.bank,
      program: value.program,
      resourceId: value.resourceId,
      sessionId: value.sessionId,
      status: 'READY',
    });
  }

  return undefined;
}

function parseLocalEngineSoundFontResource(
  value: unknown,
): LocalEngineSoundFontResource | undefined {
  if (
    !isRecord(value) ||
    (value.format !== 'sf2' && value.format !== 'sf3') ||
    typeof value.lastModifiedAt !== 'string' ||
    Number.isNaN(Date.parse(value.lastModifiedAt)) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    (value.library !== 'builtin' && value.library !== 'project') ||
    typeof value.relativePath !== 'string' ||
    !isNormalizedSoundFontRelativePath(value.relativePath) ||
    value.relativePath.split('/').pop() !== value.name ||
    !value.relativePath.toLowerCase().endsWith(`.${value.format}`) ||
    typeof value.resourceId !== 'string' ||
    !/^soundfont-[a-f0-9]{32}$/.test(value.resourceId) ||
    typeof value.revisionToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.revisionToken) ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    value.status !== 'AVAILABLE'
  ) {
    return undefined;
  }

  return Object.freeze({
    format: value.format,
    lastModifiedAt: value.lastModifiedAt,
    library: value.library,
    name: value.name,
    relativePath: value.relativePath,
    resourceId: value.resourceId,
    revisionToken: value.revisionToken,
    sizeBytes: value.sizeBytes,
    status: 'AVAILABLE',
  });
}

function parseLocalEngineSoundFontIssue(
  value: unknown,
):
  | Readonly<{
      reason: LocalEngineSoundFontIssueReason;
      relativePath: string;
    }>
  | undefined {
  if (
    !isRecord(value) ||
    typeof value.reason !== 'string' ||
    !validSoundFontIssueReasons.has(value.reason as LocalEngineSoundFontIssueReason) ||
    typeof value.relativePath !== 'string' ||
    !isNormalizedSoundFontRelativePath(value.relativePath)
  ) {
    return undefined;
  }

  return Object.freeze({
    reason: value.reason as LocalEngineSoundFontIssueReason,
    relativePath: value.relativePath,
  });
}

function isNormalizedSoundFontRelativePath(value: string): boolean {
  const segments = value.split('/');
  return (
    value.startsWith('soundfonts/') &&
    !value.includes('\\') &&
    segments.length > 1 &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function hasDuplicateValues(values: readonly (string | undefined)[]): boolean {
  const definedValues = values.filter((value): value is string => value !== undefined);
  return new Set(definedValues).size !== definedValues.length;
}

function parseLocalEngineProjectFileStatus(
  value: Record<string, unknown>,
): Extract<LocalEngineProjectRoot, { status: 'READY' }>['projectFile'] | undefined {
  if (value.status === 'MISSING') {
    return Object.freeze({ status: 'MISSING' });
  }

  if (
    value.status !== 'EXISTS' ||
    typeof value.lastModifiedAt !== 'string' ||
    Number.isNaN(Date.parse(value.lastModifiedAt)) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isInteger(value.sizeBytes) ||
    value.sizeBytes < 0
  ) {
    return undefined;
  }

  return Object.freeze({
    lastModifiedAt: value.lastModifiedAt,
    path: value.path,
    sizeBytes: value.sizeBytes,
    status: 'EXISTS',
  });
}

export function parseLocalEngineProjectFileSave(
  value: unknown,
): LocalEngineProjectFileSave | undefined {
  if (
    !isRecord(value) ||
    value.status !== 'SAVED' ||
    typeof value.bytesWritten !== 'number' ||
    !Number.isInteger(value.bytesWritten) ||
    value.bytesWritten <= 0 ||
    typeof value.lastModifiedAt !== 'string' ||
    Number.isNaN(Date.parse(value.lastModifiedAt)) ||
    typeof value.projectFileName !== 'string' ||
    value.projectFileName.length === 0 ||
    typeof value.projectFilePath !== 'string' ||
    value.projectFilePath.length === 0 ||
    typeof value.savedAt !== 'string' ||
    Number.isNaN(Date.parse(value.savedAt))
  ) {
    return undefined;
  }

  return Object.freeze({
    bytesWritten: value.bytesWritten,
    lastModifiedAt: value.lastModifiedAt,
    projectFileName: value.projectFileName,
    projectFilePath: value.projectFilePath,
    savedAt: value.savedAt,
    status: 'SAVED',
  });
}

export function parseLocalEngineProjectFileLoad(
  value: unknown,
): LocalEngineProjectFileLoad | undefined {
  if (
    !isRecord(value) ||
    value.status !== 'LOADED' ||
    typeof value.bytesRead !== 'number' ||
    !Number.isInteger(value.bytesRead) ||
    value.bytesRead <= 0 ||
    typeof value.lastModifiedAt !== 'string' ||
    Number.isNaN(Date.parse(value.lastModifiedAt)) ||
    typeof value.projectFileName !== 'string' ||
    value.projectFileName.length === 0 ||
    typeof value.projectFilePath !== 'string' ||
    value.projectFilePath.length === 0 ||
    typeof value.savedAt !== 'string' ||
    Number.isNaN(Date.parse(value.savedAt)) ||
    !isRecord(value.projectFile) ||
    value.projectFile.app !== 'HumSTUDIO' ||
    typeof value.projectFile.version !== 'string' ||
    value.projectFile.version.length === 0 ||
    value.projectFile.savedAt !== value.savedAt ||
    !isRecord(value.projectFile.workspace)
  ) {
    return undefined;
  }

  return Object.freeze({
    bytesRead: value.bytesRead,
    lastModifiedAt: value.lastModifiedAt,
    projectFile: Object.freeze({ ...value.projectFile }),
    projectFileName: value.projectFileName,
    projectFilePath: value.projectFilePath,
    savedAt: value.savedAt,
    status: 'LOADED',
  });
}

export function parseLocalEngineAceStepLyricsSnapshot(
  value: unknown,
): LocalEngineAceStepLyricsSnapshot | undefined {
  if (
    !isRecord(value) ||
    typeof value.artifactId !== 'string' ||
    !/^artifact-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.artifactId,
    ) ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    value.destination !== 'ace-step-lyrics' ||
    !isRecord(value.file) ||
    value.file.extension !== '.txt' ||
    typeof value.file.name !== 'string' ||
    value.file.name !== `${value.artifactId}.txt` ||
    typeof value.file.relativePath !== 'string' ||
    value.file.relativePath !== `renders/ace-step/lyrics/${value.file.name}` ||
    typeof value.file.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.file.sizeBytes) ||
    value.file.sizeBytes <= 0 ||
    value.file.sizeBytes > 16 * 1024 ||
    value.kind !== 'lyrics' ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.status !== 'FINALIZED'
  ) {
    return undefined;
  }

  return Object.freeze({
    artifactId: value.artifactId,
    createdAt: value.createdAt,
    destination: 'ace-step-lyrics',
    file: Object.freeze({
      extension: '.txt',
      name: value.file.name,
      relativePath: value.file.relativePath,
      sizeBytes: value.file.sizeBytes,
    }),
    kind: 'lyrics',
    sha256: value.sha256,
    status: 'FINALIZED',
  });
}

function parseLocalEngineSoundFontPreset(
  value: unknown,
): LocalEngineSoundFontPreset | undefined {
  if (
    !isRecord(value) ||
    typeof value.bank !== 'number' ||
    !Number.isSafeInteger(value.bank) ||
    value.bank < 0 ||
    value.bank > 16_383 ||
    typeof value.program !== 'number' ||
    !Number.isSafeInteger(value.program) ||
    value.program < 0 ||
    value.program > 127 ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value.name)
  ) {
    return undefined;
  }

  return Object.freeze({
    bank: value.bank,
    name: value.name,
    program: value.program,
  });
}

export function parseLocalEngineRecordingArtifact(
  value: unknown,
): LocalEngineRecordingArtifact | undefined {
  if (
    !isRecord(value) ||
    typeof value.artifactId !== 'string' ||
    value.artifactId.length === 0 ||
    !isRecord(value.audio) ||
    value.audio.bitsPerSample !== 16 ||
    (value.audio.channels !== 1 && value.audio.channels !== 2) ||
    typeof value.audio.durationSeconds !== 'number' ||
    !Number.isFinite(value.audio.durationSeconds) ||
    value.audio.durationSeconds <= 0 ||
    value.audio.mimeType !== 'audio/wav' ||
    typeof value.audio.sampleRate !== 'number' ||
    !Number.isSafeInteger(value.audio.sampleRate) ||
    value.audio.sampleRate < 8_000 ||
    value.audio.sampleRate > 192_000 ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    value.destination !== 'recording' ||
    !isRecord(value.file) ||
    value.file.extension !== '.wav' ||
    typeof value.file.name !== 'string' ||
    value.file.name.length === 0 ||
    value.file.name !== `${value.artifactId}.wav` ||
    typeof value.file.relativePath !== 'string' ||
    value.file.relativePath !== `recordings/${value.file.name}` ||
    typeof value.file.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.file.sizeBytes) ||
    value.file.sizeBytes <= 44 ||
    value.kind !== 'audio' ||
    value.status !== 'FINALIZED'
  ) {
    return undefined;
  }

  return Object.freeze({
    artifactId: value.artifactId,
    audio: Object.freeze({
      bitsPerSample: 16,
      channels: value.audio.channels,
      durationSeconds: value.audio.durationSeconds,
      mimeType: 'audio/wav',
      sampleRate: value.audio.sampleRate,
    }),
    createdAt: value.createdAt,
    destination: 'recording',
    file: Object.freeze({
      extension: '.wav',
      name: value.file.name,
      relativePath: value.file.relativePath,
      sizeBytes: value.file.sizeBytes,
    }),
    kind: 'audio',
    status: 'FINALIZED',
  });
}

function parseLocalEngineDeletedAudioFile(
  value: unknown,
  expected: LocalEngineAudioFileDeletionDescriptor,
): LocalEngineDeletedAudioFile | undefined {
  if (
    !isRecord(value) ||
    value.status !== 'DELETED' ||
    value.artifactId !== expected.artifactId ||
    value.extension !== '.wav' ||
    value.extension !== expected.extension ||
    value.name !== expected.name ||
    value.relativePath !== expected.relativePath ||
    value.sizeBytes !== expected.sizeBytes ||
    value.storageKind !== expected.storageKind
  ) {
    return undefined;
  }

  return Object.freeze({
    artifactId: expected.artifactId,
    extension: '.wav',
    name: expected.name,
    relativePath: expected.relativePath,
    sizeBytes: expected.sizeBytes,
    status: 'DELETED',
    storageKind: expected.storageKind,
  });
}

function parseGeneratedAudioAvailability(
  value: unknown,
  requestedSources: readonly LocalEngineGeneratedAudioDescriptor[],
): readonly string[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.availableSourceIds)) {
    return undefined;
  }

  const requestedSourceIds = new Set(
    requestedSources.map((source) => source.sourceId),
  );
  const availableSourceIds = value.availableSourceIds;

  if (
    availableSourceIds.some(
      (sourceId) =>
        typeof sourceId !== 'string' ||
        sourceId.length === 0 ||
        sourceId.trim() !== sourceId ||
        !requestedSourceIds.has(sourceId),
    ) ||
    new Set(availableSourceIds).size !== availableSourceIds.length
  ) {
    return undefined;
  }

  return Object.freeze([...availableSourceIds]);
}

export function parseLocalEngineSourceRestoration(
  value: unknown,
): LocalEngineSourceRestoration | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.availability) ||
    typeof value.checkedAt !== 'string' ||
    Number.isNaN(Date.parse(value.checkedAt)) ||
    !Array.isArray(value.sources)
  ) {
    return undefined;
  }

  const parsedSources: LocalEngineRestoredSource[] = [];
  const sourcesById = new Map<string, LocalEngineRestoredSource>();

  for (const source of value.sources) {
    const parsedSource = parseLocalEngineRestoredSource(source);

    if (!parsedSource || sourcesById.has(parsedSource.sourceId)) {
      return undefined;
    }

    parsedSources.push(parsedSource);
    sourcesById.set(parsedSource.sourceId, parsedSource);
  }

  const availabilityEntries = Object.entries(value.availability);

  if (availabilityEntries.length !== parsedSources.length) {
    return undefined;
  }

  for (const [sourceId, state] of availabilityEntries) {
    const source = sourcesById.get(sourceId);

    if (
      !source ||
      typeof state !== 'string' ||
      !validSourceAvailabilityStates.has(state as LocalEngineSourceAvailability) ||
      source.state !== state
    ) {
      return undefined;
    }
  }

  return Object.freeze({
    availability: Object.freeze(
      Object.fromEntries(availabilityEntries) as Record<string, LocalEngineSourceAvailability>,
    ),
    checkedAt: value.checkedAt,
    sources: Object.freeze(parsedSources),
  });
}

function parseLocalEngineRestoredSource(value: unknown): LocalEngineRestoredSource | undefined {
  if (
    !isRecord(value) ||
    (value.kind !== 'generated' && value.kind !== 'external') ||
    typeof value.sourceId !== 'string' ||
    value.sourceId.length === 0 ||
    typeof value.state !== 'string' ||
    !validSourceAvailabilityStates.has(value.state as LocalEngineSourceAvailability) ||
    typeof value.reason !== 'string' ||
    !sourceReasonMatchesState(value.reason, value.state as LocalEngineSourceAvailability)
  ) {
    return undefined;
  }

  if (
    (value.kind === 'generated' &&
      (typeof value.relativePath !== 'string' || value.relativePath.length === 0)) ||
    (value.kind === 'external' && (typeof value.path !== 'string' || value.path.length === 0))
  ) {
    return undefined;
  }

  const actual = value.actual === undefined ? undefined : parseLocalEngineSourceActual(value.actual);

  if (value.actual !== undefined && !actual) {
    return undefined;
  }

  const requiresActual = value.state === 'available' || value.reason === 'metadata-mismatch';
  const requiresResolvedPath = value.state === 'available';

  if (
    requiresActual !== Boolean(actual) ||
    requiresResolvedPath !==
      (typeof value.resolvedPath === 'string' && value.resolvedPath.length > 0)
  ) {
    return undefined;
  }

  return Object.freeze({
    ...(actual ? { actual } : {}),
    kind: value.kind,
    ...(value.kind === 'generated'
      ? { relativePath: value.relativePath as string }
      : { path: value.path as string }),
    reason: value.reason as LocalEngineRestoredSource['reason'],
    ...(requiresResolvedPath ? { resolvedPath: value.resolvedPath as string } : {}),
    sourceId: value.sourceId,
    state: value.state as LocalEngineSourceAvailability,
  });
}

function parseLocalEngineSourceActual(
  value: unknown,
): NonNullable<LocalEngineRestoredSource['actual']> | undefined {
  if (
    !isRecord(value) ||
    typeof value.lastModified !== 'number' ||
    !Number.isSafeInteger(value.lastModified) ||
    value.lastModified < 0 ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0
  ) {
    return undefined;
  }

  return Object.freeze({
    lastModified: value.lastModified,
    name: value.name,
    sizeBytes: value.sizeBytes,
  });
}

function sourceReasonMatchesState(
  reason: string,
  state: LocalEngineSourceAvailability,
): reason is LocalEngineRestoredSource['reason'] {
  return (
    (state === 'available' && reason === 'available') ||
    (state === 'missing' && reason === 'missing') ||
    (state === 'unresolved' &&
      (reason === 'metadata-mismatch' || reason === 'project-root-required')) ||
    (state === 'unopenable' &&
      (reason === 'unopenable' || reason === 'outside-project-root'))
  );
}

function createEngineOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);

  if (
    url.protocol !== 'http:' ||
    url.hostname !== LOCAL_ENGINE_HOST ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Local Engine base URL must be an http://${LOCAL_ENGINE_HOST} origin.`);
  }

  return url.origin;
}

function parseProjectRootSelection(value: unknown): LocalEngineProjectRootSelection | undefined {
  return isRecord(value) && (value.selection === 'CANCELED' || value.selection === 'SELECTED')
    ? value.selection
    : undefined;
}

function parseJobEnvelope(
  value: unknown,
  key: 'job' | 'removedJob',
): LocalEngineGpuJobRecord | undefined {
  return isRecord(value) ? parseLocalEngineGpuJobRecord(value[key]) : undefined;
}

async function readEngineErrorBody(response: Response): Promise<string | undefined> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) && typeof value.message === 'string' && value.message.length > 0
      ? value.message
      : undefined;
  } catch {
    return undefined;
  }
}

function parseBasicPitchRuntimeEnvelope(
  value: unknown,
): LocalEngineBasicPitchRuntime | undefined {
  if (!isRecord(value) || !isRecord(value.runtime)) {
    return undefined;
  }

  const runtime = value.runtime;

  if (
    runtime.status === 'READY' &&
    runtime.modelId === 'basic-pitch-icassp-2022' &&
    runtime.modelRevision === '0.4.0-onnx' &&
    runtime.profileId === 'windows-x64-python-3-10-onnx-cpu' &&
    runtime.providerVersion === '0.4.0'
  ) {
    return Object.freeze({
      modelId: runtime.modelId,
      modelRevision: runtime.modelRevision,
      profileId: runtime.profileId,
      providerVersion: runtime.providerVersion,
      status: runtime.status,
    });
  }

  if (
    runtime.status === 'UNAVAILABLE' &&
    typeof runtime.code === 'string' &&
    runtime.code.length > 0 &&
    typeof runtime.message === 'string' &&
    runtime.message.length > 0
  ) {
    return Object.freeze({
      code: runtime.code,
      message: runtime.message,
      status: runtime.status,
    });
  }

  return undefined;
}

function parseStructuredEngineRejection(
  value: unknown,
): Readonly<{ code: string; message: string }> | undefined {
  if (
    !isRecord(value) ||
    typeof value.code !== 'string' ||
    value.code.length === 0 ||
    typeof value.message !== 'string' ||
    value.message.length === 0
  ) {
    return undefined;
  }

  return Object.freeze({ code: value.code, message: value.message });
}

function unknownProjectRenderOutcome<Operation>(
  operationId: string,
  cause: LocalEngineProjectRenderUnknownCause,
  message: string,
  status?: number,
): Extract<LocalEngineProjectRenderResult<Operation>, { outcome: 'unknown' }> {
  return {
    cause,
    message,
    ok: false,
    operationId,
    outcome: 'unknown',
    reason: 'unknown-outcome',
    ...(status === undefined ? {} : { status }),
  };
}

function validateLaunchToken(token: string): string {
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error('Local Engine launch token must contain at least 32 characters.');
  }

  return token;
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Local Engine timeout must be greater than zero.');
  }

  return timeoutMs;
}

async function isRiffWavBlob(value: Blob): Promise<boolean> {
  if (value.size < 12) {
    return false;
  }

  const header = new Uint8Array(await value.slice(0, 12).arrayBuffer());

  return (
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x41 &&
    header[10] === 0x56 &&
    header[11] === 0x45
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(value: unknown): boolean {
  return isRecord(value) && value.name === 'AbortError';
}
