import type { FinalFilerExportTarget } from './finalFilerExportTarget';
import type {
  GeneratedAudioArtifact,
  ProjectArtifact,
  ProjectJsonValue,
  ProjectMixdownAudioArtifact,
  ProjectState,
} from './types';

export type FinalFilerBuildIdentity = Readonly<{
  gitCommit?: string;
  version?: string;
}>;

export type FinalFilerWavMetadata = Readonly<{
  bitsPerSample: number;
  channels: number;
  dataBytes: number;
  durationSeconds: number;
  frameCount: number;
  sampleRate: number;
}>;

export type FinalFilerSourceReport = Readonly<{
  body: string;
  fileName: string;
  integritySha256: string;
  text: string;
}>;

export type FinalFilerSourceReportRequest = Readonly<{
  buildIdentity: FinalFilerBuildIdentity;
  exportedAtUtc: string;
  fileName: string;
  hashText?: (value: string) => Promise<string>;
  mediaSha256: string;
  project: ProjectState;
  target: FinalFilerExportTarget;
  wavMetadata: FinalFilerWavMetadata;
}>;

const unavailable = 'Unavailable';

export function createFinalFilerBuildIdentitySnapshot(): FinalFilerBuildIdentity {
  return Object.freeze({
    gitCommit: readBuildValue(import.meta.env.VITE_HUMSTUDIO_GIT_COMMIT),
    version: readBuildValue(import.meta.env.VITE_HUMSTUDIO_VERSION),
  });
}

export async function parseFinalFilerWavMetadata(
  wav: Blob,
): Promise<FinalFilerWavMetadata> {
  if (wav.type.split(';', 1)[0].toLowerCase() !== 'audio/wav') {
    throw new Error('FINAL FILER received a non-WAV media response.');
  }

  const bytes = new Uint8Array(await wav.arrayBuffer());

  if (
    bytes.byteLength < 44 ||
    readAscii(bytes, 0, 4) !== 'RIFF' ||
    readAscii(bytes, 8, 4) !== 'WAVE'
  ) {
    throw new Error('FINAL FILER received an invalid WAV container.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format: Readonly<{
    audioFormat: number;
    bitsPerSample: number;
    blockAlign: number;
    channels: number;
    sampleRate: number;
  }> | undefined;
  let dataBytes: number | undefined;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd > bytes.byteLength) {
      throw new Error('FINAL FILER received a truncated WAV chunk.');
    }

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      format = Object.freeze({
        audioFormat: view.getUint16(chunkStart, true),
        bitsPerSample: view.getUint16(chunkStart + 14, true),
        blockAlign: view.getUint16(chunkStart + 12, true),
        channels: view.getUint16(chunkStart + 2, true),
        sampleRate: view.getUint32(chunkStart + 4, true),
      });
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (
    !format ||
    dataBytes === undefined ||
    format.audioFormat !== 1 ||
    !Number.isInteger(format.channels) ||
    format.channels < 1 ||
    !Number.isInteger(format.sampleRate) ||
    format.sampleRate < 1 ||
    !Number.isInteger(format.bitsPerSample) ||
    format.bitsPerSample < 1 ||
    !Number.isInteger(format.blockAlign) ||
    format.blockAlign < 1 ||
    dataBytes % format.blockAlign !== 0
  ) {
    throw new Error('FINAL FILER received unsupported WAV metadata.');
  }

  const frameCount = dataBytes / format.blockAlign;

  return Object.freeze({
    bitsPerSample: format.bitsPerSample,
    channels: format.channels,
    dataBytes,
    durationSeconds: frameCount / format.sampleRate,
    frameCount,
    sampleRate: format.sampleRate,
  });
}

export async function createFinalFilerSourceReport(
  request: FinalFilerSourceReportRequest,
): Promise<FinalFilerSourceReport> {
  const exportedAtUtc = normalizeUtcTimestamp(request.exportedAtUtc);
  const artifact = findUniqueArtifact(request.project, request.target.target.artifactId);
  const rawArtifact = findUniqueArtifact(
    request.project,
    request.target.target.rawMixdown.artifactId,
  );

  if (!artifact || !rawArtifact || !isRawMixdownArtifact(rawArtifact)) {
    throw new Error('FINAL FILER report provenance is unavailable.');
  }

  const lines = [
    'ElpisDAW FINAL FILER Source Report',
    'Report Format: 1',
    `Exported At UTC: ${exportedAtUtc}`,
    `ElpisDAW Version: ${safeValue(request.buildIdentity.version)}`,
    `Git Commit: ${safeValue(request.buildIdentity.gitCommit)}`,
    `Final Source Class: ${
      request.target.target.kind === 'raw-mixdown'
        ? 'Raw Mix'
        : 'Stable Audio 3 Master'
    }`,
    `Artifact ID: ${safeValue(request.target.target.artifactId)}`,
    `Clip ID: ${safeValue(request.target.target.clipId)}`,
    `Clip Take ID: ${safeValue(request.target.target.clipTakeId)}`,
    `Job ID: ${
      request.target.target.kind === 'stable-audio-3-master'
        ? safeValue(request.target.target.jobId)
        : unavailable
    }`,
    `Operation ID: ${
      request.target.target.kind === 'raw-mixdown'
        ? safeValue(request.target.target.rawMixdown.operationId)
        : unavailable
    }`,
    `Parent Raw Mix Artifact ID: ${safeValue(request.target.target.rawMixdown.artifactId)}`,
    `Parent Raw Mix Clip ID: ${safeValue(request.target.target.rawMixdown.clipId)}`,
    `Parent Raw Mix Clip Take ID: ${safeValue(request.target.target.rawMixdown.clipTakeId)}`,
    `Parent Raw Mix Operation ID: ${safeValue(request.target.target.rawMixdown.operationId)}`,
    `Renderer ID: ${safeValue(rawArtifact.mixdownProvenance.rendererId)}`,
    `Renderer Version: ${safeValue(rawArtifact.mixdownProvenance.rendererVersion)}`,
    `SoundFont Identity: ${unavailable}`,
  ];

  if (
    request.target.target.kind === 'stable-audio-3-master' &&
    isGeneratedAudioArtifact(artifact)
  ) {
    lines.push(
      `Stable Audio 3 Provider: ${safeValue(artifact.provenance.providerId)}`,
      `Stable Audio 3 Model: ${safeValue(artifact.provenance.modelId)}`,
      `Stable Audio 3 Revision: ${safeValue(artifact.provenance.modelRevision)}`,
      `Stable Audio 3 Task: ${safeValue(artifact.provenance.taskId)}`,
      `Stable Audio 3 Seed: ${
        artifact.provenance.seed === undefined
          ? unavailable
          : String(artifact.provenance.seed)
      }`,
      `Stable Audio 3 Parameters: ${safeJson(artifact.provenance.parameters)}`,
    );
  } else {
    lines.push(
      `Stable Audio 3 Provider: ${unavailable}`,
      `Stable Audio 3 Model: ${unavailable}`,
      `Stable Audio 3 Revision: ${unavailable}`,
      `Stable Audio 3 Task: ${unavailable}`,
      `Stable Audio 3 Seed: ${unavailable}`,
      `Stable Audio 3 Parameters: ${unavailable}`,
    );
  }

  lines.push(
    `WAV Channels: ${request.wavMetadata.channels}`,
    `WAV Sample Rate: ${request.wavMetadata.sampleRate}`,
    `WAV Bits Per Sample: ${request.wavMetadata.bitsPerSample}`,
    `WAV Frame Count: ${request.wavMetadata.frameCount}`,
    `WAV Data Bytes: ${request.wavMetadata.dataBytes}`,
    `WAV Duration Seconds: ${formatNumber(request.wavMetadata.durationSeconds)}`,
    `WAV Media SHA-256: ${normalizeSha256(request.mediaSha256)}`,
  );

  const body = `${lines.join('\n')}\n`;
  const integritySha256 = normalizeSha256(
    await (request.hashText ?? sha256Text)(body),
  );
  const text = `${body}Integrity Hash: SHA-256 ${integritySha256}\n`;

  return Object.freeze({
    body,
    fileName: createSourceReportFileName(request.fileName),
    integritySha256,
    text,
  });
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  return sha256Bytes(bytes);
}

export async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

function createSourceReportFileName(wavFileName: string): string {
  return `${wavFileName.slice(0, -4)}-source-report.txt`;
}

async function sha256Bytes(value: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const hash = await globalThis.crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(bytes).buffer,
  );

  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function findUniqueArtifact(
  project: ProjectState,
  artifactId: string,
): ProjectArtifact | undefined {
  const matches = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === artifactId,
  );

  return matches.length === 1 ? matches[0] : undefined;
}

function isRawMixdownArtifact(
  artifact: ProjectArtifact,
): artifact is ProjectMixdownAudioArtifact {
  return (
    artifact.kind === 'audio' &&
    artifact.destination === 'mixdown' &&
    'mixdownProvenance' in artifact
  );
}

function isGeneratedAudioArtifact(
  artifact: ProjectArtifact,
): artifact is GeneratedAudioArtifact {
  return artifact.kind === 'audio' && 'provenance' in artifact;
}

function normalizeUtcTimestamp(value: string): string {
  const parsed = new Date(value);

  if (!value || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error('FINAL FILER export time must be an exact UTC timestamp.');
  }

  return value;
}

function normalizeSha256(value: string): string {
  const normalized = value.toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('FINAL FILER received an invalid SHA-256 value.');
  }

  return normalized;
}

function readBuildValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    ? value
    : undefined;
}

function safeValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) {
    return unavailable;
  }

  if (
    /[\u0000-\u001f\u007f]/.test(value) ||
    /(?:^|\s)(?:[a-z]:[\\/]|\\\\|\/(?:users|home|var|tmp)\/)/i.test(value) ||
    /(?:bearer\s+[a-z0-9._~-]+|(?:token|secret|password|authorization)\s*[=:])/i.test(value)
  ) {
    return unavailable;
  }

  return value;
}

function safeJson(value: Record<string, ProjectJsonValue>): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: ProjectJsonValue): ProjectJsonValue {
  if (typeof value === 'string') {
    return safeValue(value);
  }

  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }

  return value;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('FINAL FILER received invalid WAV metadata.');
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(9).replace(/0+$/, '');
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
