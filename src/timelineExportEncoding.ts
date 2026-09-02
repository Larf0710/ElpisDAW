import {
  TIMELINE_EXPORT_AUDIO_FORMAT,
  TIMELINE_EXPORT_MIDI_FORMAT,
} from '../shared/timelineExportProtocol.js';
import type {
  TimelineExportAudioPlan,
  TimelineExportMidiPlan,
} from './timelineExportPlan';

const PCM_WAVE_HEADER_BYTES = 44;
const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_MIDI_TICK = 0x0fff_ffff;
const DEFAULT_BLOCK_FRAMES = 16_384;

export class TimelineExportEncodingError extends Error {
  constructor(
    readonly code:
      | 'TIMELINE_EXPORT_AUDIO_PLAN_INVALID'
      | 'TIMELINE_EXPORT_AUDIO_SOURCE_INVALID'
      | 'TIMELINE_EXPORT_MIDI_PLAN_INVALID'
      | 'TIMELINE_EXPORT_OUTPUT_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'TimelineExportEncodingError';
  }
}

export type TimelineExportAudioEncoding = Readonly<{
  bitsPerSample: 16;
  blob: Blob;
  byteLength: number;
  channels: 2;
  clippingWarning: boolean;
  durationSeconds: number;
  frameCount: number;
  mimeType: 'audio/wav';
  preEncodingPeak: number;
  sampleRate: 48_000;
  sourceCount: number;
}>;

export type TimelineExportMidiEncoding = Readonly<{
  blob: Blob;
  byteLength: number;
  durationTicks: number;
  fileFormat: 0;
  mimeType: 'audio/midi';
  noteCount: number;
  trackCount: 1;
}>;

export type InspectedPcm16Wave = Readonly<{
  bitsPerSample: 16;
  blockAlign: number;
  bytes: Uint8Array;
  channels: 1 | 2;
  dataOffset: number;
  durationSeconds: number;
  formatTag: 1;
  frameCount: number;
  sampleRate: number;
  sourceId: string;
  view: DataView;
}>;

export type InspectedUncompressedWave = Readonly<{
  bitsPerSample: 16 | 32;
  blockAlign: number;
  bytes: Uint8Array;
  channels: 1 | 2;
  dataOffset: number;
  durationSeconds: number;
  formatTag: 1 | 3;
  frameCount: number;
  sampleRate: number;
  sourceId: string;
  view: DataView;
}>;

export function encodeTimelineExportAudio(
  plan: TimelineExportAudioPlan,
  sourceBytes: ReadonlyMap<string, Uint8Array>,
): TimelineExportAudioEncoding {
  if (
    plan.purpose !== 'timeline-export' ||
    plan.mediaType !== 'audio' ||
    plan.format.bitsPerSample !== TIMELINE_EXPORT_AUDIO_FORMAT.bitsPerSample ||
    plan.format.channels !== TIMELINE_EXPORT_AUDIO_FORMAT.channels ||
    plan.format.mimeType !== TIMELINE_EXPORT_AUDIO_FORMAT.mimeType ||
    plan.format.sampleRate !== TIMELINE_EXPORT_AUDIO_FORMAT.sampleRate ||
    !isPositiveFinite(plan.durationSeconds) ||
    plan.events.length === 0 ||
    plan.sources.length === 0
  ) {
    throw new TimelineExportEncodingError(
      'TIMELINE_EXPORT_AUDIO_PLAN_INVALID',
      'Timeline Audio Export Plan is invalid.',
    );
  }

  if (sourceBytes.size !== plan.sources.length) {
    throw sourceInvalid('Timeline Audio Export requires one exact source byte map.');
  }

  const inspectedSources = new Map<string, InspectedUncompressedWave>();

  for (const descriptor of plan.sources) {
    const bytes = sourceBytes.get(descriptor.sourceId);

    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== descriptor.sizeBytes ||
      inspectedSources.has(descriptor.sourceId)
    ) {
      throw sourceInvalid(
        `Timeline Audio Export source ${descriptor.sourceId} is missing or stale.`,
      );
    }

    inspectedSources.set(
      descriptor.sourceId,
      inspectUncompressedWave(bytes, descriptor.sourceId),
    );
  }

  const outputFrameCount = Math.round(
    plan.durationSeconds * TIMELINE_EXPORT_AUDIO_FORMAT.sampleRate,
  );
  const bytes = createStereoPcm16Wave(outputFrameCount);
  const outputView = createView(bytes);
  const runtimeEvents = plan.events.map((event) => {
    const source = inspectedSources.get(event.sourceId);
    const requestedEndSeconds = event.sourceStartSeconds + event.durationSeconds;

    if (
      !source ||
      event.sourceStartSeconds < 0 ||
      event.startOffsetSeconds < 0 ||
      event.sourceStartSeconds >= source.durationSeconds ||
      requestedEndSeconds > source.durationSeconds + 1 / source.sampleRate
    ) {
      throw sourceInvalid(
        `Timeline Audio Export event ${event.clipId} exceeds its frozen source.`,
      );
    }

    const startFrame = Math.round(
      event.startOffsetSeconds * TIMELINE_EXPORT_AUDIO_FORMAT.sampleRate,
    );
    const durationFrames = Math.round(
      event.durationSeconds * TIMELINE_EXPORT_AUDIO_FORMAT.sampleRate,
    );

    if (
      durationFrames <= 0 ||
      startFrame < 0 ||
      startFrame + durationFrames > outputFrameCount
    ) {
      throw new TimelineExportEncodingError(
        'TIMELINE_EXPORT_AUDIO_PLAN_INVALID',
        `Timeline Audio Export event ${event.clipId} placement is invalid.`,
      );
    }

    return Object.freeze({
      endFrame: startFrame + durationFrames,
      source,
      sourceStartFrame: event.sourceStartSeconds * source.sampleRate,
      startFrame,
    });
  });
  const leftBlock = new Float64Array(DEFAULT_BLOCK_FRAMES);
  const rightBlock = new Float64Array(DEFAULT_BLOCK_FRAMES);
  let preEncodingPeak = 0;

  for (
    let blockStartFrame = 0;
    blockStartFrame < outputFrameCount;
    blockStartFrame += DEFAULT_BLOCK_FRAMES
  ) {
    const frameCount = Math.min(
      DEFAULT_BLOCK_FRAMES,
      outputFrameCount - blockStartFrame,
    );
    const left = leftBlock.subarray(0, frameCount);
    const right = rightBlock.subarray(0, frameCount);
    left.fill(0);
    right.fill(0);
    const blockEndFrame = blockStartFrame + frameCount;

    for (const event of runtimeEvents) {
      const overlapStart = Math.max(blockStartFrame, event.startFrame);
      const overlapEnd = Math.min(blockEndFrame, event.endFrame);

      for (let outputFrame = overlapStart; outputFrame < overlapEnd; outputFrame += 1) {
        const sourceFrame =
          event.sourceStartFrame +
          (outputFrame - event.startFrame) *
            (event.source.sampleRate / TIMELINE_EXPORT_AUDIO_FORMAT.sampleRate);
        const sourceLeft = readInterpolatedUncompressedWaveSample(
          event.source,
          sourceFrame,
          0,
        );
        const sourceRight =
          event.source.channels === 1
            ? sourceLeft
            : readInterpolatedUncompressedWaveSample(
                event.source,
                sourceFrame,
                1,
              );
        const blockFrame = outputFrame - blockStartFrame;
        left[blockFrame] += sourceLeft;
        right[blockFrame] += sourceRight;
      }
    }

    for (let frame = 0; frame < frameCount; frame += 1) {
      preEncodingPeak = Math.max(
        preEncodingPeak,
        Math.abs(left[frame]),
        Math.abs(right[frame]),
      );
      const byteOffset = PCM_WAVE_HEADER_BYTES + (blockStartFrame + frame) * 4;
      outputView.setInt16(byteOffset, floatToPcm16(left[frame]), true);
      outputView.setInt16(byteOffset + 2, floatToPcm16(right[frame]), true);
    }
  }

  return Object.freeze({
    bitsPerSample: 16 as const,
    blob: createImmutableBlob(bytes, 'audio/wav'),
    byteLength: bytes.byteLength,
    channels: 2 as const,
    clippingWarning: preEncodingPeak > 1,
    durationSeconds:
      outputFrameCount / TIMELINE_EXPORT_AUDIO_FORMAT.sampleRate,
    frameCount: outputFrameCount,
    mimeType: 'audio/wav' as const,
    preEncodingPeak,
    sampleRate: TIMELINE_EXPORT_AUDIO_FORMAT.sampleRate,
    sourceCount: plan.sources.length,
  });
}

export function encodeTimelineExportMidi(
  plan: TimelineExportMidiPlan,
): TimelineExportMidiEncoding {
  if (
    plan.purpose !== 'timeline-export' ||
    plan.mediaType !== 'midi' ||
    plan.format.fileFormat !== TIMELINE_EXPORT_MIDI_FORMAT.fileFormat ||
    plan.format.mimeType !== TIMELINE_EXPORT_MIDI_FORMAT.mimeType ||
    plan.format.trackCount !== TIMELINE_EXPORT_MIDI_FORMAT.trackCount ||
    !Number.isSafeInteger(plan.durationTicks) ||
    plan.durationTicks <= 0 ||
    plan.durationTicks > MAX_MIDI_TICK ||
    !Number.isSafeInteger(plan.ticksPerQuarter) ||
    plan.ticksPerQuarter <= 0 ||
    plan.ticksPerQuarter > 0x7fff ||
    !isPositiveFinite(plan.bpm) ||
    plan.notes.length === 0
  ) {
    throw midiInvalid('Timeline MIDI Export Plan is invalid.');
  }

  const tempoMicroseconds = Math.round(60_000_000 / plan.bpm);

  if (tempoMicroseconds <= 0 || tempoMicroseconds > 0xff_ffff) {
    throw midiInvalid('Timeline MIDI Export tempo is not representable.');
  }

  const events: Array<{
    data: Uint8Array;
    order: number;
    sequence: number;
    tick: number;
  }> = [
    {
      data: Uint8Array.of(
        0xff,
        0x51,
        0x03,
        (tempoMicroseconds >> 16) & 0xff,
        (tempoMicroseconds >> 8) & 0xff,
        tempoMicroseconds & 0xff,
      ),
      order: 0,
      sequence: 0,
      tick: 0,
    },
  ];

  plan.notes.forEach((note, index) => {
    if (
      !Number.isSafeInteger(note.pitch) ||
      note.pitch < 0 ||
      note.pitch > 127 ||
      !Number.isSafeInteger(note.velocity) ||
      note.velocity < 1 ||
      note.velocity > 127 ||
      !Number.isSafeInteger(note.startTick) ||
      note.startTick < 0 ||
      !Number.isSafeInteger(note.lengthTicks) ||
      note.lengthTicks <= 0 ||
      note.startTick + note.lengthTicks > plan.durationTicks
    ) {
      throw midiInvalid(`Timeline MIDI Export note ${index + 1} is invalid.`);
    }

    events.push(
      {
        data: Uint8Array.of(0x80, note.pitch, 0),
        order: 1,
        sequence: index,
        tick: note.startTick + note.lengthTicks,
      },
      {
        data: Uint8Array.of(0x90, note.pitch, note.velocity),
        order: 2,
        sequence: index,
        tick: note.startTick,
      },
    );
  });
  events.push({
    data: Uint8Array.of(0xff, 0x2f, 0x00),
    order: 3,
    sequence: events.length,
    tick: plan.durationTicks,
  });
  events.sort(
    (left, right) =>
      left.tick - right.tick ||
      left.order - right.order ||
      left.sequence - right.sequence,
  );

  const trackParts: Uint8Array[] = [];
  let previousTick = 0;

  for (const event of events) {
    trackParts.push(encodeVariableLengthQuantity(event.tick - previousTick));
    trackParts.push(event.data);
    previousTick = event.tick;
  }

  const track = concatenate(trackParts);
  const header = new Uint8Array(14);
  writeAscii(header, 0, 'MThd');
  const headerView = createView(header);
  headerView.setUint32(4, 6, false);
  headerView.setUint16(8, 0, false);
  headerView.setUint16(10, 1, false);
  headerView.setUint16(12, plan.ticksPerQuarter, false);
  const trackHeader = new Uint8Array(8);
  writeAscii(trackHeader, 0, 'MTrk');
  createView(trackHeader).setUint32(4, track.byteLength, false);
  const bytes = concatenate([header, trackHeader, track]);

  return Object.freeze({
    blob: createImmutableBlob(bytes, 'audio/midi'),
    byteLength: bytes.byteLength,
    durationTicks: plan.durationTicks,
    fileFormat: 0 as const,
    mimeType: 'audio/midi' as const,
    noteCount: plan.notes.length,
    trackCount: 1 as const,
  });
}

export function inspectPcm16Wave(
  bytes: Uint8Array,
  sourceId: string,
): InspectedPcm16Wave {
  const source = inspectUncompressedWave(bytes, sourceId);

  if (source.formatTag !== 1 || source.bitsPerSample !== 16) {
    throw sourceInvalid(`${sourceId} must be mono or stereo uncompressed PCM16 WAV.`);
  }

  return source as InspectedPcm16Wave;
}

export function inspectUncompressedWave(
  bytes: Uint8Array,
  sourceId: string,
): InspectedUncompressedWave {
  const view = createView(bytes);

  if (
    bytes.byteLength < PCM_WAVE_HEADER_BYTES ||
    readAscii(bytes, 0, 4) !== 'RIFF' ||
    readAscii(bytes, 8, 4) !== 'WAVE' ||
    view.getUint32(4, true) + 8 !== bytes.byteLength
  ) {
    throw sourceInvalid(`${sourceId} is not one complete RIFF/WAVE file.`);
  }

  let data: { byteLength: number; offset: number } | undefined;
  let format:
    | {
        bitsPerSample: 16 | 32;
        blockAlign: number;
        channels: 1 | 2;
        formatTag: 1 | 3;
        sampleRate: number;
      }
    | undefined;
  let offset = RIFF_HEADER_BYTES;

  while (offset + CHUNK_HEADER_BYTES <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + CHUNK_HEADER_BYTES;
    const paddedChunkEnd = chunkDataOffset + chunkSize + (chunkSize % 2);

    if (paddedChunkEnd > bytes.byteLength) {
      throw sourceInvalid(`${sourceId} contains an incomplete WAVE chunk.`);
    }

    if (chunkId === 'fmt ') {
      if (format || chunkSize < 16) {
        throw sourceInvalid(`${sourceId} contains an invalid WAVE format chunk.`);
      }

      const formatTag = view.getUint16(chunkDataOffset, true);
      const channels = view.getUint16(chunkDataOffset + 2, true);
      const sampleRate = view.getUint32(chunkDataOffset + 4, true);
      const byteRate = view.getUint32(chunkDataOffset + 8, true);
      const blockAlign = view.getUint16(chunkDataOffset + 12, true);
      const bitsPerSample = view.getUint16(chunkDataOffset + 14, true);

      if (
        (channels !== 1 && channels !== 2) ||
        sampleRate < 8_000 ||
        sampleRate > 192_000 ||
        !(
          (formatTag === 1 && bitsPerSample === 16) ||
          (formatTag === 3 && bitsPerSample === 32)
        ) ||
        blockAlign !== channels * (bitsPerSample / 8) ||
        byteRate !== sampleRate * blockAlign
      ) {
        throw sourceInvalid(
          `${sourceId} must be mono or stereo uncompressed PCM16 or IEEE float32 WAV.`,
        );
      }

      format = {
        bitsPerSample: bitsPerSample as 16 | 32,
        blockAlign,
        channels: channels as 1 | 2,
        formatTag: formatTag as 1 | 3,
        sampleRate,
      };
    } else if (chunkId === 'data') {
      if (data || chunkSize === 0) {
        throw sourceInvalid(`${sourceId} contains an invalid WAVE data chunk.`);
      }
      data = { byteLength: chunkSize, offset: chunkDataOffset };
    }

    offset = paddedChunkEnd;
  }

  if (
    offset !== bytes.byteLength ||
    !format ||
    !data ||
    data.byteLength % format.blockAlign !== 0
  ) {
    throw sourceInvalid(`${sourceId} has inconsistent WAVE data.`);
  }

  const frameCount = data.byteLength / format.blockAlign;
  return Object.freeze({
    ...format,
    bytes,
    dataOffset: data.offset,
    durationSeconds: frameCount / format.sampleRate,
    frameCount,
    sourceId,
    view,
  });
}

function createStereoPcm16Wave(frameCount: number): Uint8Array {
  const dataByteLength = frameCount * 4;

  if (
    !Number.isSafeInteger(dataByteLength) ||
    dataByteLength <= 0 ||
    dataByteLength > MAX_OUTPUT_BYTES ||
    dataByteLength + 36 > 0xffff_ffff
  ) {
    throw new TimelineExportEncodingError(
      'TIMELINE_EXPORT_OUTPUT_TOO_LARGE',
      'Timeline Audio Export exceeds the safe WAV output size.',
    );
  }

  let bytes: Uint8Array;

  try {
    bytes = new Uint8Array(PCM_WAVE_HEADER_BYTES + dataByteLength);
  } catch {
    throw new TimelineExportEncodingError(
      'TIMELINE_EXPORT_OUTPUT_TOO_LARGE',
      'Timeline Audio Export could not allocate its WAV output.',
    );
  }

  const view = createView(bytes);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, TIMELINE_EXPORT_AUDIO_FORMAT.sampleRate, true);
  view.setUint32(28, TIMELINE_EXPORT_AUDIO_FORMAT.sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataByteLength, true);
  return bytes;
}

export function readInterpolatedUncompressedWaveSample(
  source: InspectedUncompressedWave,
  framePosition: number,
  channel: number,
): number {
  const lowerFrame = Math.min(
    source.frameCount - 1,
    Math.max(0, Math.floor(framePosition)),
  );
  const upperFrame = Math.min(source.frameCount - 1, lowerFrame + 1);
  const fraction = Math.min(1, Math.max(0, framePosition - lowerFrame));
  const lower = readUncompressedSample(source, lowerFrame, channel);
  const upper = readUncompressedSample(source, upperFrame, channel);
  return lower + (upper - lower) * fraction;
}

function readUncompressedSample(
  source: InspectedUncompressedWave,
  frame: number,
  channel: number,
): number {
  if (source.formatTag === 3) {
    const value = source.view.getFloat32(
      source.dataOffset + frame * source.blockAlign + channel * 4,
      true,
    );

    if (!Number.isFinite(value)) {
      throw sourceInvalid(`${source.sourceId} contains a non-finite float sample.`);
    }

    return value;
  }

  const value = source.view.getInt16(
    source.dataOffset + frame * source.blockAlign + channel * 2,
    true,
  );
  return value < 0 ? value / 32_768 : value / 32_767;
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

function encodeVariableLengthQuantity(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MIDI_TICK) {
    throw midiInvalid('Timeline MIDI Export delta tick is invalid.');
  }

  const bytes = [value & 0x7f];
  let remaining = value >> 7;

  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining >>= 7;
  }

  return Uint8Array.from(bytes);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function createView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function createImmutableBlob(
  bytes: Uint8Array,
  mimeType: 'audio/midi' | 'audio/wav',
): Blob {
  return Object.freeze(
    new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType }),
  );
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index]);
  }
  return value;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function sourceInvalid(message: string): TimelineExportEncodingError {
  return new TimelineExportEncodingError(
    'TIMELINE_EXPORT_AUDIO_SOURCE_INVALID',
    message,
  );
}

function midiInvalid(message: string): TimelineExportEncodingError {
  return new TimelineExportEncodingError(
    'TIMELINE_EXPORT_MIDI_PLAN_INVALID',
    message,
  );
}
