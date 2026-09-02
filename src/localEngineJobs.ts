import type { AceStepJobRequest } from './aceStepJobContract';
import type { AceStepTextToMusicJobRequest } from './aceStepTextToMusicJobContract';
import type { AceStepCoverJobRequest } from './aceStepCoverJobContract';
import type { InstrumentRenderJobRequest } from './instrumentRenderContract';
import type { StableAudio3JobRequest } from './stableAudio3JobContract';
import type { StableAudio3TextToAudioJobRequest } from './stableAudio3TextToAudioJobContract';

export const LOCAL_ENGINE_GPU_JOB_STATES = [
  'QUEUED',
  'LOADING_MODEL',
  'PROCESSING',
  'SAVING',
  'COMPLETED',
  'CANCEL_REQUESTED',
  'CANCELED',
  'FAILED',
  'INTERRUPTED',
  'PAUSED',
] as const;

export type LocalEngineGpuJobState = (typeof LOCAL_ENGINE_GPU_JOB_STATES)[number];

export type LocalEngineGpuJobProgress = Readonly<
  | {
      accuracy: 'ESTIMATED';
      percent: number;
      updatedAt: string;
    }
  | {
      accuracy: 'MEASURED';
      currentStep: number;
      percent: number;
      totalSteps: number;
      updatedAt: string;
    }
>;

export type LocalEngineJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly LocalEngineJsonValue[]
  | Readonly<{ [key: string]: LocalEngineJsonValue }>;

export type LocalEngineMockJobRequest = Readonly<{
  inputArtifacts: readonly [];
  lineage: Readonly<{
    parentArtifactIds: readonly string[];
    parentClipTakeIds: readonly string[];
  }>;
  modelId: 'mock-audio-v1';
  modelRevision: '1';
  output: Readonly<{
    artifactKind: 'audio';
    destination: 'ace-step' | 'export' | 'instrument' | 'mixdown' | 'stable-audio-3';
    extension: '.wav';
  }>;
  parameters: Readonly<{
    durationSeconds: number;
    frequencyHz: number;
    sampleRate: number;
    seed: number;
  }>;
  providerId: 'mock-provider';
  taskId: 'mock-audio-generation';
}>;

export type LocalEngineMockHumToMidiJobRequest = Readonly<{
  inputArtifacts: readonly [
    Readonly<{
      artifactId: string;
      kind: 'audio';
      relativePath: string;
    }>,
  ];
  lineage: Readonly<{
    parentArtifactIds: readonly [string];
    parentClipTakeIds: readonly [string];
  }>;
  modelId: 'mock-hum-to-midi-v1';
  modelRevision: '1';
  output: Readonly<{
    artifactKind: 'midi';
  }>;
  parameters: Readonly<{
    projectBpm: number;
    seed: number;
    sourceEndSeconds: number;
    sourceStartSeconds: number;
    ticksPerQuarter: 960;
  }>;
  providerId: 'mock-provider';
  taskId: 'hum-to-midi';
}>;

export type LocalEngineBasicPitchHumToMidiJobRequest = Readonly<{
  inputArtifacts: readonly [
    Readonly<{
      artifactId: string;
      kind: 'audio';
      relativePath: string;
    }>,
  ];
  lineage: Readonly<{
    parentArtifactIds: readonly [string];
    parentClipTakeIds: readonly [string];
  }>;
  modelId: 'basic-pitch-icassp-2022';
  modelRevision: '0.4.0-onnx';
  output: Readonly<{
    artifactKind: 'midi';
  }>;
  parameters: Readonly<{
    frameThreshold: number;
    maximumFrequencyHz: number;
    melodiaTrick: boolean;
    minimumFrequencyHz: number;
    minimumNoteLengthMs: number;
    multiplePitchBends: false;
    onsetThreshold: number;
    projectBpm: number;
    sourceEndSeconds: number;
    sourceStartSeconds: number;
    ticksPerQuarter: 960;
  }>;
  providerId: 'local-basic-pitch';
  taskId: 'hum-to-midi';
}>;

export type LocalEngineInstrumentRenderJobRequest =
  InstrumentRenderJobRequest;

export type LocalEngineAceStepJobRequest =
  | AceStepJobRequest
  | AceStepCoverJobRequest
  | AceStepTextToMusicJobRequest;

export type LocalEngineStableAudio3JobRequest =
  | StableAudio3JobRequest
  | StableAudio3TextToAudioJobRequest;

export type LocalEngineGpuJobRecord = Readonly<{
  attempt: number;
  cancelRequestedAt?: string;
  createdAt: string;
  error?: Readonly<{ code: string; message: string }>;
  finishedAt?: string;
  history: readonly Readonly<{
    attempt: number;
    at: string;
    state: LocalEngineGpuJobState;
  }>[];
  jobId: string;
  modelId: string;
  modelRevision: string;
  providerId: string;
  progress?: LocalEngineGpuJobProgress;
  request: Readonly<{ [key: string]: LocalEngineJsonValue }>;
  result?: LocalEngineJsonValue;
  startedAt?: string;
  state: LocalEngineGpuJobState;
  taskId: string;
  updatedAt: string;
}>;

export type LocalEngineGpuJobSnapshot = Readonly<{
  acceptingJobs: boolean;
  activeJobId?: string;
  jobs: readonly LocalEngineGpuJobRecord[];
}>;

const validJobStates = new Set<string>(LOCAL_ENGINE_GPU_JOB_STATES);
const activeJobStates = new Set<LocalEngineGpuJobState>([
  'LOADING_MODEL',
  'PROCESSING',
  'SAVING',
  'CANCEL_REQUESTED',
]);
const finishedJobStates = new Set<LocalEngineGpuJobState>([
  'COMPLETED',
  'CANCELED',
  'FAILED',
  'INTERRUPTED',
]);
const JOB_ID_PATTERN = /^job-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_JSON_DEPTH = 16;

export function isLocalEngineJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value);
}

export function parseLocalEngineGpuJobRecord(
  value: unknown,
): LocalEngineGpuJobRecord | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    !isTimestamp(value.createdAt) ||
    !Array.isArray(value.history) ||
    value.history.length === 0 ||
    typeof value.jobId !== 'string' ||
    !isLocalEngineJobId(value.jobId) ||
    !isIdentity(value.modelId) ||
    !isIdentity(value.modelRevision) ||
    !isIdentity(value.providerId) ||
    !isRecord(value.request) ||
    !isJobState(value.state) ||
    !isIdentity(value.taskId) ||
    !isTimestamp(value.updatedAt)
  ) {
    return undefined;
  }

  const request = parseJsonValue(value.request);

  if (
    !isRecord(request) ||
    request.modelId !== value.modelId ||
    request.modelRevision !== value.modelRevision ||
    request.providerId !== value.providerId ||
    request.taskId !== value.taskId
  ) {
    return undefined;
  }

  const history = [];
  let previousAt = value.createdAt;

  for (const entry of value.history) {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.attempt) ||
      (entry.attempt as number) < 1 ||
      !isTimestamp(entry.at) ||
      Date.parse(entry.at) < Date.parse(previousAt) ||
      !isJobState(entry.state)
    ) {
      return undefined;
    }

    history.push(
      Object.freeze({
        attempt: entry.attempt as number,
        at: entry.at,
        state: entry.state,
      }),
    );
    previousAt = entry.at;
  }

  const lastHistory = history[history.length - 1];

  if (
    !lastHistory ||
    lastHistory.at !== value.updatedAt ||
    lastHistory.attempt !== value.attempt ||
    lastHistory.state !== value.state
  ) {
    return undefined;
  }

  const startedAt = parseOptionalTimestamp(value.startedAt);
  const cancelRequestedAt = parseOptionalTimestamp(value.cancelRequestedAt);
  const finishedAt = parseOptionalTimestamp(value.finishedAt);

  if (
    startedAt === false ||
    cancelRequestedAt === false ||
    finishedAt === false ||
    finishedJobStates.has(value.state) !== Boolean(finishedAt)
  ) {
    return undefined;
  }

  const error = parseJobError(value.error);

  if (
    (value.error !== undefined && !error) ||
    (value.state === 'FAILED') !== Boolean(error)
  ) {
    return undefined;
  }

  const result = value.result === undefined ? undefined : parseJsonValue(value.result);

  if (
    (value.result !== undefined && result === undefined) ||
    (value.state === 'COMPLETED') !== (value.result !== undefined)
  ) {
    return undefined;
  }

  const progress = parseJobProgress(value.progress);

  if (
    (value.progress !== undefined && !progress) ||
    (progress !== undefined &&
      (value.state !== 'PROCESSING' ||
        Date.parse(progress.updatedAt) < Date.parse(value.updatedAt)))
  ) {
    return undefined;
  }

  return Object.freeze({
    attempt: value.attempt as number,
    ...(cancelRequestedAt ? { cancelRequestedAt } : {}),
    createdAt: value.createdAt,
    ...(error ? { error } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    history: Object.freeze(history),
    jobId: value.jobId,
    modelId: value.modelId,
    modelRevision: value.modelRevision,
    providerId: value.providerId,
    ...(progress ? { progress } : {}),
    request,
    ...(result !== undefined ? { result } : {}),
    ...(startedAt ? { startedAt } : {}),
    state: value.state,
    taskId: value.taskId,
    updatedAt: value.updatedAt,
  });
}

function parseJobProgress(value: unknown): LocalEngineGpuJobProgress | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !isRecord(value) ||
    (value.accuracy !== 'MEASURED' && value.accuracy !== 'ESTIMATED') ||
    !Number.isSafeInteger(value.percent) ||
    (value.percent as number) < 0 ||
    (value.percent as number) > 100 ||
    !isTimestamp(value.updatedAt)
  ) {
    return undefined;
  }

  if (value.accuracy === 'ESTIMATED') {
    if (value.currentStep !== undefined || value.totalSteps !== undefined) {
      return undefined;
    }

    return Object.freeze({
      accuracy: 'ESTIMATED',
      percent: value.percent as number,
      updatedAt: value.updatedAt,
    });
  }

  if (
    !Number.isSafeInteger(value.currentStep) ||
    (value.currentStep as number) < 1 ||
    !Number.isSafeInteger(value.totalSteps) ||
    (value.totalSteps as number) < 1 ||
    (value.currentStep as number) > (value.totalSteps as number)
  ) {
    return undefined;
  }

  return Object.freeze({
    accuracy: 'MEASURED',
    currentStep: value.currentStep as number,
    percent: value.percent as number,
    totalSteps: value.totalSteps as number,
    updatedAt: value.updatedAt,
  });
}

export function parseLocalEngineGpuJobSnapshot(
  value: unknown,
): LocalEngineGpuJobSnapshot | undefined {
  if (!isRecord(value) || typeof value.acceptingJobs !== 'boolean' || !Array.isArray(value.jobs)) {
    return undefined;
  }

  if (
    value.activeJobId !== undefined &&
    (typeof value.activeJobId !== 'string' || !isLocalEngineJobId(value.activeJobId))
  ) {
    return undefined;
  }

  const jobs: LocalEngineGpuJobRecord[] = [];
  const jobIds = new Set<string>();

  for (const candidate of value.jobs) {
    const job = parseLocalEngineGpuJobRecord(candidate);

    if (!job || jobIds.has(job.jobId)) {
      return undefined;
    }

    jobs.push(job);
    jobIds.add(job.jobId);
  }

  if (value.activeJobId !== undefined) {
    const activeJob = jobs.find((job) => job.jobId === value.activeJobId);

    if (!activeJob || !activeJobStates.has(activeJob.state)) {
      return undefined;
    }
  }

  return Object.freeze({
    acceptingJobs: value.acceptingJobs,
    ...(value.activeJobId ? { activeJobId: value.activeJobId } : {}),
    jobs: Object.freeze(jobs),
  });
}

function parseJobError(value: unknown): LocalEngineGpuJobRecord['error'] | undefined {
  if (value === undefined) {
    return undefined;
  }

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

function parseOptionalTimestamp(value: unknown): string | false | undefined {
  if (value === undefined) {
    return undefined;
  }

  return isTimestamp(value) ? value : false;
}

function parseJsonValue(value: unknown, depth = 0): LocalEngineJsonValue | undefined {
  if (depth > MAX_JSON_DEPTH) {
    return undefined;
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const parsed = value.map((entry) => parseJsonValue(entry, depth + 1));
    return parsed.some((entry) => entry === undefined)
      ? undefined
      : Object.freeze(parsed as LocalEngineJsonValue[]);
  }

  if (isRecord(value)) {
    const entries: [string, LocalEngineJsonValue][] = [];

    for (const [key, entry] of Object.entries(value)) {
      const parsed = parseJsonValue(entry, depth + 1);

      if (parsed === undefined) {
        return undefined;
      }

      entries.push([key, parsed]);
    }

    return Object.freeze(Object.fromEntries(entries));
  }

  return undefined;
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isJobState(value: unknown): value is LocalEngineGpuJobState {
  return typeof value === 'string' && validJobStates.has(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
