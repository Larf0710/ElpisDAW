import { timelineTicksToSeconds } from './audioClipTiming';
import {
  inspectUncompressedWave,
  readInterpolatedUncompressedWaveSample,
} from './timelineExportEncoding';
import type { PunchAttempt, PunchSession } from './punchSession';

export const MAX_PUNCH_OUTPUT_BYTES = 128 * 1024 * 1024;
const PCM_WAVE_HEADER_BYTES = 44;
const PUNCH_EDGE_FADE_SECONDS = 0.005;

export class PunchAudioMaterializationError extends Error {
  constructor(
    readonly code:
      | 'PUNCH_ATTEMPT_INVALID'
      | 'PUNCH_BASE_INVALID'
      | 'PUNCH_OUTPUT_TOO_LARGE'
      | 'PUNCH_RANGE_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'PunchAudioMaterializationError';
  }
}

export type PunchAudioMaterialization = Readonly<{
  bitsPerSample: 16;
  blob: Blob;
  byteLength: number;
  channels: 1 | 2;
  durationSeconds: number;
  frameCount: number;
  mimeType: 'audio/wav';
  sampleRate: number;
}>;

export async function materializePunchAudio(
  session: PunchSession,
  attempt: PunchAttempt,
  bpm: number,
): Promise<PunchAudioMaterialization> {
  if (!session.attempts.includes(attempt)) {
    throw new PunchAudioMaterializationError(
      'PUNCH_ATTEMPT_INVALID',
      'Punch materialization requires an Attempt from the frozen session.',
    );
  }

  const [baseBuffer, attemptBuffer] = await Promise.all([
    session.baseWav.arrayBuffer(),
    attempt.blob.arrayBuffer(),
  ]);
  let base;
  let punch;

  try {
    base = inspectUncompressedWave(
      new Uint8Array(baseBuffer),
      session.baseArtifact.artifactId,
    );
  } catch (error) {
    throw new PunchAudioMaterializationError(
      'PUNCH_BASE_INVALID',
      error instanceof Error ? error.message : 'Base Take WAV is invalid.',
    );
  }

  try {
    punch = inspectUncompressedWave(
      new Uint8Array(attemptBuffer),
      attempt.punchAttemptId,
    );
  } catch (error) {
    throw new PunchAudioMaterializationError(
      'PUNCH_ATTEMPT_INVALID',
      error instanceof Error ? error.message : 'Punch Attempt WAV is invalid.',
    );
  }

  const clipTiming = session.clip.audioTiming;

  if (!clipTiming || !Number.isFinite(bpm) || bpm <= 0) {
    throw new PunchAudioMaterializationError(
      'PUNCH_RANGE_INVALID',
      'Punch materialization requires valid Clip timing and Project BPM.',
    );
  }

  const sourcePunchStartSeconds =
    clipTiming.sourceStartSeconds +
    timelineTicksToSeconds(
      attempt.capturedStartTick - session.clip.startTick,
      bpm,
    );
  const sourcePunchEndSeconds =
    clipTiming.sourceStartSeconds +
    timelineTicksToSeconds(
      session.range.outTick - session.clip.startTick,
      bpm,
    );

  if (
    sourcePunchStartSeconds < clipTiming.sourceStartSeconds ||
    sourcePunchEndSeconds <= sourcePunchStartSeconds ||
    sourcePunchEndSeconds > clipTiming.sourceEndSeconds + 1 / base.sampleRate ||
    clipTiming.sourceEndSeconds > base.durationSeconds + 1 / base.sampleRate
  ) {
    throw new PunchAudioMaterializationError(
      'PUNCH_RANGE_INVALID',
      'Punch range does not fit the frozen Base Take source timing.',
    );
  }

  const dataByteLength = base.frameCount * base.channels * 2;
  const byteLength = PCM_WAVE_HEADER_BYTES + dataByteLength;

  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength <= PCM_WAVE_HEADER_BYTES ||
    byteLength > MAX_PUNCH_OUTPUT_BYTES ||
    dataByteLength + 36 > 0xffff_ffff
  ) {
    throw new PunchAudioMaterializationError(
      'PUNCH_OUTPUT_TOO_LARGE',
      `Completed Punch Take exceeds the ${MAX_PUNCH_OUTPUT_BYTES} byte safety limit.`,
    );
  }

  let bytes: Uint8Array;

  try {
    bytes = createPcm16Wave(base.frameCount, base.channels, base.sampleRate);
  } catch {
    throw new PunchAudioMaterializationError(
      'PUNCH_OUTPUT_TOO_LARGE',
      'Completed Punch Take could not allocate its WAV output.',
    );
  }

  const outputView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const startFrame = Math.max(
    0,
    Math.min(base.frameCount - 1, Math.round(sourcePunchStartSeconds * base.sampleRate)),
  );
  const endFrame = Math.max(
    startFrame + 1,
    Math.min(base.frameCount, Math.round(sourcePunchEndSeconds * base.sampleRate)),
  );
  const replacementFrameCount = endFrame - startFrame;
  const fadeFrameCount = Math.max(
    1,
    Math.min(
      Math.round(PUNCH_EDGE_FADE_SECONDS * base.sampleRate),
      Math.floor(replacementFrameCount / 2),
    ),
  );

  for (let frame = 0; frame < base.frameCount; frame += 1) {
    for (let channel = 0; channel < base.channels; channel += 1) {
      const baseSample = readInterpolatedUncompressedWaveSample(base, frame, channel);
      let outputSample = baseSample;

      if (frame >= startFrame && frame < endFrame) {
        const replacementFrame = frame - startFrame;
        const attemptFramePosition =
          replacementFrameCount <= 1
            ? 0
            : (replacementFrame / (replacementFrameCount - 1)) *
              Math.max(0, punch.frameCount - 1);
        const attemptSample = readAttemptSample(punch, attemptFramePosition, channel);
        const fadeIn = Math.min(1, replacementFrame / fadeFrameCount);
        const fadeOut = Math.min(
          1,
          (replacementFrameCount - 1 - replacementFrame) / fadeFrameCount,
        );
        const punchMix = Math.max(0, Math.min(fadeIn, fadeOut));
        outputSample = baseSample + (attemptSample - baseSample) * punchMix;
      }

      outputView.setInt16(
        PCM_WAVE_HEADER_BYTES +
          (frame * base.channels + channel) * 2,
        floatToPcm16(outputSample),
        true,
      );
    }
  }

  return Object.freeze({
    bitsPerSample: 16 as const,
    blob: new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }),
    byteLength: bytes.byteLength,
    channels: base.channels,
    durationSeconds: base.frameCount / base.sampleRate,
    frameCount: base.frameCount,
    mimeType: 'audio/wav' as const,
    sampleRate: base.sampleRate,
  });
}

function readAttemptSample(
  attempt: ReturnType<typeof inspectUncompressedWave>,
  framePosition: number,
  outputChannel: number,
): number {
  if (attempt.channels === 1) {
    return readInterpolatedUncompressedWaveSample(attempt, framePosition, 0);
  }

  if (outputChannel < attempt.channels) {
    return readInterpolatedUncompressedWaveSample(
      attempt,
      framePosition,
      outputChannel,
    );
  }

  const left = readInterpolatedUncompressedWaveSample(attempt, framePosition, 0);
  const right = readInterpolatedUncompressedWaveSample(attempt, framePosition, 1);
  return (left + right) / 2;
}

function createPcm16Wave(
  frameCount: number,
  channels: 1 | 2,
  sampleRate: number,
): Uint8Array {
  const blockAlign = channels * 2;
  const dataByteLength = frameCount * blockAlign;
  const bytes = new Uint8Array(PCM_WAVE_HEADER_BYTES + dataByteLength);
  const view = new DataView(bytes.buffer);

  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataByteLength, true);
  return bytes;
}

function floatToPcm16(value: number): number {
  if (value <= -1) {
    return -32_768;
  }
  if (value >= 1) {
    return 32_767;
  }
  return Math.round(value * (value < 0 ? 32_768 : 32_767));
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
