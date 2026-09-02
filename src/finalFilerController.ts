import {
  downloadFinalFilerFilesInBrowser,
  type FinalFilerDownloadFile,
} from './finalFilerBrowserDownload';
import {
  resolveFinalFilerExportTarget,
  type FinalFilerExportTarget,
} from './finalFilerExportTarget';
import type {
  LocalEngineGeneratedAudioDescriptor,
  LocalEngineGeneratedAudioReadResult,
} from './localEngineClient';
import { createProjectDirtyStateFingerprint } from './projectDirtyStateFingerprint';
import {
  createFinalFilerSourceReport,
  parseFinalFilerWavMetadata,
  sha256Blob,
  type FinalFilerBuildIdentity,
  type FinalFilerSourceReport,
  type FinalFilerSourceReportRequest,
  type FinalFilerWavMetadata,
} from './finalFilerSourceReport';
import type { ProjectState } from './types';

export type FinalFilerAvailability =
  | Readonly<{
      canExport: true;
      fileName: string;
      lineage: string;
      selectedClipId: string;
      source: 'Raw Mix' | 'Stable Audio 3 Master';
      target: FinalFilerExportTarget;
    }>
  | Readonly<{
      canExport: false;
      message: string;
    }>;

export type FinalFilerFileNameResolution =
  | Readonly<{ fileName: string; valid: true }>
  | Readonly<{ message: string; valid: false }>;

export type FinalFilerOperationSnapshot = Readonly<{
  descriptor: LocalEngineGeneratedAudioDescriptor;
  exportedAtUtc: string;
  fileName: string;
  includeSourceReport: boolean;
  operationId: string;
  projectFingerprint: string;
  selectedClipId: string;
  target: FinalFilerExportTarget;
}>;

export type FinalFilerControllerResult = Readonly<{
  detail: string;
  downloadCount: 0 | 1 | 2;
  message: string;
  operationId?: string;
  status: 'blocked' | 'busy' | 'canceled' | 'failed' | 'interrupted' | 'success';
}>;

export type FinalFilerRunRequest = Readonly<{
  buildIdentity: FinalFilerBuildIdentity;
  exportedAtUtc: string;
  fileName: string;
  getProject: () => ProjectState;
  includeSourceReport: boolean;
  readGeneratedAudio: (
    descriptor: LocalEngineGeneratedAudioDescriptor,
    signal: AbortSignal,
  ) => Promise<LocalEngineGeneratedAudioReadResult>;
}>;

type FinalFilerControllerOptions = Readonly<{
  createOperationId?: () => string;
  createSourceReport?: (
    request: FinalFilerSourceReportRequest,
  ) => Promise<FinalFilerSourceReport>;
  downloadFiles?: (files: readonly FinalFilerDownloadFile[]) => void;
  hashWav?: (wav: Blob) => Promise<string>;
  parseWav?: (wav: Blob) => Promise<FinalFilerWavMetadata>;
}>;

type ActiveFinalFilerOperation = Readonly<{
  abortController: AbortController;
  snapshot: FinalFilerOperationSnapshot;
}>;

export class FinalFilerController {
  readonly #createOperationId: () => string;
  readonly #createSourceReport: (
    request: FinalFilerSourceReportRequest,
  ) => Promise<FinalFilerSourceReport>;
  readonly #downloadFiles: (files: readonly FinalFilerDownloadFile[]) => void;
  readonly #hashWav: (wav: Blob) => Promise<string>;
  readonly #parseWav: (wav: Blob) => Promise<FinalFilerWavMetadata>;
  #active: ActiveFinalFilerOperation | undefined;

  constructor(options: FinalFilerControllerOptions = {}) {
    this.#createOperationId = options.createOperationId ?? createOperationId;
    this.#createSourceReport =
      options.createSourceReport ?? createFinalFilerSourceReport;
    this.#downloadFiles =
      options.downloadFiles ?? downloadFinalFilerFilesInBrowser;
    this.#hashWav = options.hashWav ?? sha256Blob;
    this.#parseWav = options.parseWav ?? parseFinalFilerWavMetadata;
  }

  get activeSnapshot(): FinalFilerOperationSnapshot | undefined {
    return this.#active?.snapshot;
  }

  get isBusy(): boolean {
    return Boolean(this.#active);
  }

  cancel(): boolean {
    if (!this.#active) {
      return false;
    }

    this.#active.abortController.abort();
    return true;
  }

  async run(request: FinalFilerRunRequest): Promise<FinalFilerControllerResult> {
    if (this.#active) {
      return result('busy', 'EXPORT BUSY', 'One FINAL FILER export is already active.');
    }

    const project = request.getProject();
    const availability = resolveFinalFilerAvailability(project);

    if (!availability.canExport) {
      return result('blocked', 'SOURCE UNAVAILABLE', availability.message);
    }

    const fileName = resolveFinalFilerFileName(request.fileName);

    if (!fileName.valid) {
      return result('blocked', 'FILE NAME INVALID', fileName.message);
    }

    const operationId = this.#createOperationId();

    if (!isSafeOperationId(operationId)) {
      return result(
        'failed',
        'EXPORT FAILED',
        'FINAL FILER could not create a safe operation identity.',
      );
    }

    const abortController = new AbortController();
    const snapshot = deepFreezeClone<FinalFilerOperationSnapshot>({
      descriptor: availability.target.descriptor,
      exportedAtUtc: request.exportedAtUtc,
      fileName: fileName.fileName,
      includeSourceReport: request.includeSourceReport,
      operationId,
      projectFingerprint: availability.target.projectFingerprint,
      selectedClipId: availability.selectedClipId,
      target: availability.target,
    });
    const active = Object.freeze({ abortController, snapshot });
    this.#active = active;

    try {
      if (!revalidateSnapshot(request.getProject(), snapshot)) {
        return interrupted(operationId);
      }

      const read = await request.readGeneratedAudio(
        snapshot.descriptor,
        abortController.signal,
      );

      if (abortController.signal.aborted) {
        return canceled(operationId);
      }

      if (!read.ok) {
        return result(
          read.reason === 'canceled' ? 'canceled' : 'failed',
          read.reason === 'canceled' ? 'EXPORT CANCELED' : 'EXPORT FAILED',
          read.reason === 'canceled'
            ? 'FINAL FILER canceled before any browser download.'
            : 'FINAL FILER could not read the registered WAV.',
          operationId,
        );
      }

      if (
        read.wav.type.split(';', 1)[0].toLowerCase() !== 'audio/wav' ||
        read.wav.size !== snapshot.descriptor.sizeBytes
      ) {
        return result(
          'failed',
          'EXPORT FAILED',
          'FINAL FILER received WAV data that did not match the registered descriptor.',
          operationId,
        );
      }

      const [wavMetadata, mediaSha256] = await Promise.all([
        this.#parseWav(read.wav),
        this.#hashWav(read.wav),
      ]);

      if (abortController.signal.aborted) {
        return canceled(operationId);
      }

      const files: FinalFilerDownloadFile[] = [
        Object.freeze({
          blob: read.wav,
          fileName: snapshot.fileName,
          kind: 'wav' as const,
        }),
      ];

      if (snapshot.includeSourceReport) {
        const report = await this.#createSourceReport({
          buildIdentity: request.buildIdentity,
          exportedAtUtc: snapshot.exportedAtUtc,
          fileName: snapshot.fileName,
          mediaSha256,
          project,
          target: snapshot.target,
          wavMetadata,
        });
        files.push(
          Object.freeze({
            blob: new Blob([report.text], { type: 'text/plain;charset=utf-8' }),
            fileName: report.fileName,
            kind: 'source-report' as const,
          }),
        );
      }

      if (abortController.signal.aborted) {
        return canceled(operationId);
      }

      if (!revalidateSnapshot(request.getProject(), snapshot)) {
        return interrupted(operationId);
      }

      this.#downloadFiles(Object.freeze(files));

      return result(
        'success',
        'EXPORT COMPLETE',
        snapshot.includeSourceReport
          ? 'The verified WAV and Source Report were sent to the browser download destination.'
          : 'The verified WAV was sent to the browser download destination.',
        operationId,
        snapshot.includeSourceReport ? 2 : 1,
      );
    } catch {
      if (abortController.signal.aborted) {
        return canceled(operationId);
      }

      return result(
        'failed',
        'EXPORT FAILED',
        'FINAL FILER could not prepare all requested delivery files.',
        operationId,
      );
    } finally {
      if (this.#active === active) {
        this.#active = undefined;
      }
    }
  }
}

export function resolveFinalFilerAvailability(
  project: ProjectState,
): FinalFilerAvailability {
  if (project.selection.items.length !== 1) {
    return Object.freeze({
      canExport: false as const,
      message:
        project.selection.items.length > 1
          ? 'Select one registered Raw Mixdown or Stable Audio 3 Master Clip. Multiple selections are not a delivery target.'
          : 'Select one registered Raw Mixdown or Stable Audio 3 Master Clip. If none exists, create MIXDOWN in Mixer first.',
    });
  }

  const [selection] = project.selection.items;

  if (!selection || selection.type !== 'clip') {
    return Object.freeze({
      canExport: false as const,
      message: 'FINAL FILER requires one registered final Audio Clip, not a Track. Create MIXDOWN in Mixer first if no final Clip exists.',
    });
  }

  const resolution = resolveFinalFilerExportTarget(project, selection.id);

  if (!resolution.canExport) {
    return Object.freeze({
      canExport: false as const,
      message:
        resolution.cause === 'target-invalid'
          ? `${resolution.message} Create MIXDOWN in Mixer first, then select its Raw Mixdown Clip.`
          : resolution.message,
    });
  }

  const isRawMix = resolution.exportTarget.target.kind === 'raw-mixdown';

  return Object.freeze({
    canExport: true as const,
    fileName: resolution.exportTarget.fileName,
    lineage: isRawMix
      ? 'Canonical Raw Mixdown registration is ready.'
      : 'Stable Audio 3 Master and its Raw Mixdown parent lineage are ready.',
    selectedClipId: selection.id,
    source: isRawMix ? ('Raw Mix' as const) : ('Stable Audio 3 Master' as const),
    target: resolution.exportTarget,
  });
}

export function resolveFinalFilerFileName(
  value: string,
): FinalFilerFileNameResolution {
  if (!value || value.trim() !== value) {
    return invalidFileName('Enter a file name without leading or trailing spaces.');
  }

  if (value.length > 180) {
    return invalidFileName('File Name must be 180 characters or fewer.');
  }

  if (
    /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) ||
    value.endsWith('.') ||
    value.endsWith(' ')
  ) {
    return invalidFileName('File Name contains characters that are not safe for browser delivery.');
  }

  if (!value.endsWith('.wav')) {
    return invalidFileName('File Name must end with .wav.');
  }

  const stem = value.slice(0, -4);

  if (
    !stem ||
    stem === '.' ||
    stem === '..' ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(stem)
  ) {
    return invalidFileName('File Name uses a reserved or empty device name.');
  }

  return Object.freeze({ fileName: value, valid: true as const });
}

function revalidateSnapshot(
  project: ProjectState,
  snapshot: FinalFilerOperationSnapshot,
): boolean {
  if (
    createProjectDirtyStateFingerprint(project) !== snapshot.projectFingerprint ||
    project.selection.items.length !== 1 ||
    project.selection.items[0]?.type !== 'clip' ||
    project.selection.items[0].id !== snapshot.selectedClipId
  ) {
    return false;
  }

  const resolution = resolveFinalFilerExportTarget(project, snapshot.selectedClipId);

  return (
    resolution.canExport &&
    JSON.stringify(resolution.exportTarget) === JSON.stringify(snapshot.target)
  );
}

function createOperationId(): string {
  return `final-filer:${globalThis.crypto.randomUUID()}`;
}

function isSafeOperationId(value: string): boolean {
  return (
    value.startsWith('final-filer:') &&
    value.length <= 128 &&
    /^[a-z0-9:-]+$/i.test(value)
  );
}

function invalidFileName(message: string): FinalFilerFileNameResolution {
  return Object.freeze({ message, valid: false as const });
}

function interrupted(operationId: string): FinalFilerControllerResult {
  return result(
    'interrupted',
    'EXPORT INTERRUPTED',
    'Project, selection, or final-source identity changed. No browser download was started.',
    operationId,
  );
}

function canceled(operationId: string): FinalFilerControllerResult {
  return result(
    'canceled',
    'EXPORT CANCELED',
    'FINAL FILER canceled before any browser download.',
    operationId,
  );
}

function result(
  status: FinalFilerControllerResult['status'],
  message: string,
  detail: string,
  operationId?: string,
  downloadCount: FinalFilerControllerResult['downloadCount'] = 0,
): FinalFilerControllerResult {
  return Object.freeze({ detail, downloadCount, message, operationId, status });
}

function deepFreezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }

  return value;
}
