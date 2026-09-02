import type {
  LocalEngineGeneratedAudioDescriptor,
  LocalEngineGeneratedAudioReadResult,
} from './localEngineClient';
import type { ProjectState } from './types';
import {
  encodeTimelineExportAudio,
  encodeTimelineExportMidi,
  TimelineExportEncodingError,
} from './timelineExportEncoding';
import {
  createCanonicalTimelineExportPlanJson,
  createTimelineExportPlan,
  type TimelineExportPlan,
  type TimelineExportTarget,
} from './timelineExportPlan';

export type TimelineExportGeneratedAudioReader = (
  descriptor: LocalEngineGeneratedAudioDescriptor,
) => Promise<LocalEngineGeneratedAudioReadResult>;

export type TimelineExportDownloadDescriptor = Readonly<{
  blob: Blob;
  byteLength: number;
  contentSha256: string;
  fileName: string;
  format: 'MIDI' | 'WAV';
  kind: 'timeline-export';
  mediaType: 'audio' | 'midi';
  mimeType: 'audio/midi' | 'audio/wav';
  planSha256: string;
  target: TimelineExportTarget;
  timeline: Readonly<{
    durationTicks: number;
    endTick: number;
    originTick: number;
  }>;
  warning?: Readonly<{
    clipping: true;
    peak: number;
  }>;
}>;

export type TimelineExportDownloadResolution =
  | Readonly<{
      canDownload: true;
      download: TimelineExportDownloadDescriptor;
    }>
  | Readonly<{
      canDownload: false;
      message: string;
      reason:
        | 'audio-reader-required'
        | 'encoding-failed'
        | 'plan-invalid'
        | 'plan-stale'
        | 'source-read-failed';
    }>;

export async function createTimelineExportDownload(
  project: ProjectState,
  plan: TimelineExportPlan,
  readGeneratedAudio?: TimelineExportGeneratedAudioReader,
): Promise<TimelineExportDownloadResolution> {
  const canonicalPlan = createCanonicalTimelineExportPlanJson(plan);

  if (
    !canonicalPlan ||
    plan.purpose !== 'timeline-export' ||
    !isRecursivelyFrozen(plan)
  ) {
    return fail('plan-invalid', 'Timeline EXPORT Plan is malformed.');
  }

  const currentResolution = createTimelineExportPlan(project);

  if (!currentResolution.canExport) {
    return fail(
      'plan-stale',
      `Timeline EXPORT target is no longer valid: ${currentResolution.message}`,
    );
  }

  const currentCanonical = createCanonicalTimelineExportPlanJson(
    currentResolution.plan,
  );

  if (!currentCanonical || canonicalPlan !== currentCanonical) {
    return fail(
      'plan-stale',
      'Timeline EXPORT Project, selection, target, or Active Take changed after planning.',
    );
  }

  try {
    const planSha256 = await createSha256(
      new TextEncoder().encode(canonicalPlan),
    );

    if (!doesProjectStillMatchPlan(project, canonicalPlan)) {
      return fail(
        'plan-stale',
        'Timeline EXPORT Project or selection changed during export preparation.',
      );
    }

    if (plan.mediaType === 'midi') {
      const encoded = encodeTimelineExportMidi(plan);
      const contentSha256 = await createBlobSha256(encoded.blob);

      if (!doesProjectStillMatchPlan(project, canonicalPlan)) {
        return fail(
          'plan-stale',
          'Timeline EXPORT Project or selection changed during MIDI encoding.',
        );
      }

      return success(
        plan,
        encoded.blob,
        contentSha256,
        planSha256,
      );
    }

    if (!readGeneratedAudio) {
      return fail(
        'audio-reader-required',
        'Timeline Audio EXPORT requires the authenticated generated-audio reader.',
      );
    }

    const sourceBytes = new Map<string, Uint8Array>();

    for (const descriptor of plan.sources) {
      let result: LocalEngineGeneratedAudioReadResult;

      try {
        result = await readGeneratedAudio(descriptor);
      } catch (error) {
        return fail(
          'source-read-failed',
          error instanceof Error
            ? error.message
            : 'Timeline Audio EXPORT source read failed.',
        );
      }

      if (
        !result.ok ||
        result.wav.type.split(';', 1)[0].toLowerCase() !== 'audio/wav' ||
        result.wav.size !== descriptor.sizeBytes
      ) {
        return fail(
          'source-read-failed',
          result.ok
            ? `Timeline Audio EXPORT source ${descriptor.sourceId} is stale.`
            : result.message,
        );
      }

      sourceBytes.set(
        descriptor.sourceId,
        new Uint8Array(await result.wav.arrayBuffer()),
      );
    }

    const encoded = encodeTimelineExportAudio(plan, sourceBytes);
    const contentSha256 = await createBlobSha256(encoded.blob);

    if (!doesProjectStillMatchPlan(project, canonicalPlan)) {
      return fail(
        'plan-stale',
        'Timeline EXPORT Project or selection changed during Audio encoding.',
      );
    }

    const warning = encoded.clippingWarning
      ? Object.freeze({ clipping: true as const, peak: encoded.preEncodingPeak })
      : undefined;
    return success(
      plan,
      encoded.blob,
      contentSha256,
      planSha256,
      warning,
    );
  } catch (error) {
    return fail(
      'encoding-failed',
      error instanceof TimelineExportEncodingError
        ? error.message
        : 'Timeline EXPORT could not encode a deterministic output.',
    );
  }
}

function doesProjectStillMatchPlan(
  project: ProjectState,
  canonicalPlan: string,
): boolean {
  const resolution = createTimelineExportPlan(project);
  return (
    resolution.canExport &&
    createCanonicalTimelineExportPlanJson(resolution.plan) === canonicalPlan
  );
}

function isRecursivelyFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  return (
    Object.isFrozen(value) &&
    Object.values(value).every(isRecursivelyFrozen)
  );
}

function success(
  plan: TimelineExportPlan,
  blob: Blob,
  contentSha256: string,
  planSha256: string,
  warning?: TimelineExportDownloadDescriptor['warning'],
): Extract<TimelineExportDownloadResolution, { canDownload: true }> {
  const download = Object.freeze({
    blob,
    byteLength: blob.size,
    contentSha256,
    fileName: plan.fileName,
    format: plan.mediaType === 'audio' ? ('WAV' as const) : ('MIDI' as const),
    kind: 'timeline-export' as const,
    mediaType: plan.mediaType,
    mimeType:
      plan.mediaType === 'audio'
        ? ('audio/wav' as const)
        : ('audio/midi' as const),
    planSha256,
    target: plan.target,
    timeline: Object.freeze({
      durationTicks: plan.durationTicks,
      endTick: plan.endTick,
      originTick: plan.originTick,
    }),
    ...(warning ? { warning } : {}),
  });

  return Object.freeze({ canDownload: true as const, download });
}

async function createSha256(bytes: Uint8Array): Promise<string> {
  const snapshot = bytes.slice();
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    snapshot.buffer,
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

async function createBlobSha256(blob: Blob): Promise<string> {
  return createSha256(new Uint8Array(await blob.arrayBuffer()));
}

function fail(
  reason: Extract<
    TimelineExportDownloadResolution,
    { canDownload: false }
  >['reason'],
  message: string,
): Extract<TimelineExportDownloadResolution, { canDownload: false }> {
  return Object.freeze({ canDownload: false as const, message, reason });
}
