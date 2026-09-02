import { describe, expect, it, vi } from 'vitest';

import {
  encodeTimelineExportAudio,
  encodeTimelineExportMidi,
  TimelineExportEncodingError,
} from './timelineExportEncoding';
import { createTimelineExportDownload } from './timelineExportDownload';
import { createTimelineExportPlan } from './timelineExportPlan';
import {
  PRINT_MIX_TEST_SOURCE_FRAMES,
  createPrintMixAudioProject,
  createPrintMixMidiProject,
} from './printMixTestFixture';
import type { ProjectState } from './types';

describe('createTimelineExportDownload', () => {
  it('encodes only one Audio Clip effective segment without unrelated head silence', async () => {
    const project = createPrintMixAudioProject();
    const clip = project.tracks[0].clips[0];
    clip.audioTiming = {
      sourceEndSeconds: 0.5,
      sourceStartSeconds: 0.25,
      timeBase: 'absolute-seconds',
    };
    clip.lengthTicks = 480;
    project.selection = { items: [{ id: clip.id, type: 'clip' }] };
    const plan = requireAudioPlan(project);
    const source = createWave((frame) =>
      frame < PRINT_MIX_TEST_SOURCE_FRAMES / 2 ? 0.1 : 0.5,
    );
    const before = structuredClone(project);
    const result = await createTimelineExportDownload(
      project,
      plan,
      async () => ({
        ok: true,
        wav: createWaveBlob(source),
      }),
    );

    expect(result).toMatchObject({
      canDownload: true,
      download: {
        byteLength: 44 + 12_000 * 4,
        format: 'WAV',
        kind: 'timeline-export',
        mediaType: 'audio',
        mimeType: 'audio/wav',
        timeline: { durationTicks: 480, originTick: 960 },
      },
    });
    if (!result.canDownload) {
      throw new Error(result.message);
    }
    const bytes = new Uint8Array(await result.download.blob.arrayBuffer());
    expect(readStereoSample(bytes, 0)[0]).toBeCloseTo(0.5, 4);
    expect(result.download).not.toHaveProperty('warning');
    expect(result.download).not.toHaveProperty('artifactId');
    expect(result.download).not.toHaveProperty('destination');
    expect(Object.isFrozen(result.download)).toBe(true);
    expect(Object.isFrozen(result.download.timeline)).toBe(true);
    expect(project).toEqual(before);
  });

  it('encodes an Audio Track from tick 0, preserves silence and overlap, and warns without normalizing', async () => {
    const project = createAudioTrackProject();
    const plan = requireAudioPlan(project);
    const source = createWave(() => 0.75);
    const reader = vi.fn(async () => ({
      ok: true as const,
      wav: createWaveBlob(source),
    }));
    const result = await createTimelineExportDownload(project, plan, reader);

    expect(result).toMatchObject({
      canDownload: true,
      download: {
        byteLength: 44 + 48_000 * 4,
        warning: { clipping: true, peak: expect.any(Number) },
      },
    });
    if (!result.canDownload) {
      throw new Error(result.message);
    }
    const bytes = new Uint8Array(await result.download.blob.arrayBuffer());
    expect(reader).toHaveBeenCalledTimes(2);
    expect(readStereoSample(bytes, 0)).toEqual([0, 0]);
    expect(readStereoSample(bytes, 24_000)[0]).toBe(1);
    expect(result.download.warning?.peak).toBeCloseTo(1.5, 3);
    expect(result.download).not.toHaveProperty('normalize');
    expect(result.download.timeline).toEqual({
      durationTicks: 1_920,
      endTick: 1_920,
      originTick: 0,
    });
  });

  it('keeps a silent Audio Clip silent with finite deterministic metadata', async () => {
    const project = createPrintMixAudioProject();
    project.selection = { items: [{ id: 'audio-clip-1', type: 'clip' }] };
    const plan = requireAudioPlan(project);
    const source = createWave(() => 0);
    const encoded = encodeTimelineExportAudio(
      plan,
      new Map([[plan.sources[0].sourceId, source]]),
    );

    expect(encoded).toMatchObject({
      clippingWarning: false,
      preEncodingPeak: 0,
      sourceCount: 1,
    });
    expect(Number.isFinite(encoded.durationSeconds)).toBe(true);
    expect(Object.isFrozen(encoded)).toBe(true);
    expect(Object.isFrozen(encoded.blob)).toBe(true);
    const bytes = new Uint8Array(await encoded.blob.arrayBuffer());
    expect(readStereoSample(bytes, 0)).toEqual([0, 0]);
    expect(readStereoSample(bytes, encoded.frameCount - 1)).toEqual([0, 0]);
  });

  it('encodes a legacy ACE IEEE float32 WAV into the 48 kHz PCM16 target', async () => {
    const project = createPrintMixAudioProject();
    project.selection = { items: [{ id: 'audio-clip-1', type: 'clip' }] };
    const source = createFloatWave((frame) =>
      frame < 12_000 ? 0.25 : -0.5,
    );
    const artifact = project.artifacts?.[0];
    if (!artifact || artifact.kind !== 'audio' || !project.artifacts) {
      throw new Error('Expected the selected Audio Artifact fixture.');
    }
    project.artifacts[0] = {
      ...artifact,
      file: { ...artifact.file, sizeBytes: source.byteLength },
    };
    const plan = requireAudioPlan(project);
    const encoded = encodeTimelineExportAudio(
      plan,
      new Map([[plan.sources[0].sourceId, source]]),
    );
    const bytes = new Uint8Array(await encoded.blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(encoded).toMatchObject({
      bitsPerSample: 16,
      channels: 2,
      sampleRate: 48_000,
    });
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(readStereoSample(bytes, 0)[0]).toBeCloseTo(0.25, 4);
    expect(readStereoSample(bytes, 0)[1]).toBeCloseTo(0.25, 4);
    expect(readStereoSample(bytes, encoded.frameCount - 1)[0]).toBeCloseTo(-0.5, 4);
    expect(readStereoSample(bytes, encoded.frameCount - 1)[1]).toBeCloseTo(-0.5, 4);
  });

  it('fails closed on missing reader, stale source bytes, read failure, and Project drift', async () => {
    const project = createPrintMixAudioProject();
    project.selection = { items: [{ id: 'audio-clip-1', type: 'clip' }] };
    const plan = requireAudioPlan(project);
    const before = structuredClone(project);

    expect(await createTimelineExportDownload(project, plan)).toMatchObject({
      canDownload: false,
      reason: 'audio-reader-required',
    });
    expect(
      await createTimelineExportDownload(project, plan, async () => ({
        message: 'Unavailable',
        ok: false,
        reason: 'offline',
      })),
    ).toMatchObject({ canDownload: false, reason: 'source-read-failed' });
    expect(
      await createTimelineExportDownload(project, plan, async () => ({
        ok: true,
        wav: new Blob([new Uint8Array(44)], { type: 'audio/wav' }),
      })),
    ).toMatchObject({ canDownload: false, reason: 'source-read-failed' });
    const malformed = createWave(() => 0.25);
    malformed[0] = 0;
    expect(
      await createTimelineExportDownload(project, plan, async () => ({
        ok: true,
        wav: createWaveBlob(malformed),
      })),
    ).toMatchObject({ canDownload: false, reason: 'encoding-failed' });

    project.selection = { items: [{ id: 'audio-clip-2', type: 'clip' }] };
    const reader = vi.fn();
    expect(
      await createTimelineExportDownload(project, plan, reader),
    ).toMatchObject({ canDownload: false, reason: 'plan-stale' });
    expect(reader).not.toHaveBeenCalled();
    project.selection = before.selection;
    expect(project).toEqual(before);
  });

  it('rejects mutable or forged Plans and Project drift during an authenticated source read', async () => {
    const project = createPrintMixAudioProject();
    project.selection = { items: [{ id: 'audio-clip-1', type: 'clip' }] };
    const plan = requireAudioPlan(project);
    const mutablePlan = structuredClone(plan);

    expect(
      await createTimelineExportDownload(project, mutablePlan, vi.fn()),
    ).toMatchObject({ canDownload: false, reason: 'plan-invalid' });

    const source = createWave(() => 0.25);
    const result = await createTimelineExportDownload(
      project,
      plan,
      async () => {
        project.selection = { items: [{ id: 'audio-clip-2', type: 'clip' }] };
        return { ok: true, wav: createWaveBlob(source) };
      },
    );

    expect(result).toMatchObject({
      canDownload: false,
      reason: 'plan-stale',
    });
  });

  it('encodes a deterministic MIDI Clip SMF with duplicate Notes, relative origin, and no timbre events', async () => {
    const project = createPrintMixMidiProject();
    project.selection = { items: [{ id: 'midi-clip-1', type: 'clip' }] };
    const plan = requireMidiPlan(project);
    const first = await createTimelineExportDownload(project, plan);
    const second = await createTimelineExportDownload(project, plan);

    expect(first).toMatchObject({
      canDownload: true,
      download: {
        fileName: 'ElpisDAW-MIDI One.mid',
        format: 'MIDI',
        kind: 'timeline-export',
        mediaType: 'midi',
        mimeType: 'audio/midi',
        timeline: { durationTicks: 960, originTick: 960 },
      },
    });
    if (!first.canDownload || !second.canDownload) {
      throw new Error('Missing MIDI Clip download.');
    }
    const bytes = new Uint8Array(await first.download.blob.arrayBuffer());
    const events = parseMidiEvents(bytes);
    expect(readAscii(bytes, 0, 4)).toBe('MThd');
    expect(readAscii(bytes, 14, 4)).toBe('MTrk');
    expect(events.filter((event) => event.status === 0x90)).toEqual([
      { data: [60, 91], status: 0x90, tick: 0 },
      { data: [60, 91], status: 0x90, tick: 0 },
    ]);
    expect(events.filter((event) => event.status === 0x80)).toHaveLength(2);
    expect(events[events.length - 1]).toEqual({
      data: [],
      status: 0xff2f,
      tick: 960,
    });
    expect(events.some((event) => event.status === 0xb0)).toBe(false);
    expect(events.some((event) => event.status === 0xc0)).toBe(false);
    expect(first.download.contentSha256).toBe(second.download.contentSha256);
    expect(first.download.planSha256).toBe(second.download.planSha256);
  });

  it('encodes one MIDI Track with Project-head silence, gaps/overlaps, and exact last extent', async () => {
    const project = createMidiTrackProject();
    const plan = requireMidiPlan(project);
    const result = await createTimelineExportDownload(project, plan);

    if (!result.canDownload) {
      throw new Error(result.message);
    }
    const bytes = new Uint8Array(await result.download.blob.arrayBuffer());
    const events = parseMidiEvents(bytes);
    expect(events.filter((event) => event.status === 0x90)).toEqual([
      { data: [60, 91], status: 0x90, tick: 960 },
      { data: [60, 91], status: 0x90, tick: 960 },
      { data: [67, 73], status: 0x90, tick: 1_440 },
    ]);
    expect(events[events.length - 1]).toEqual({
      data: [],
      status: 0xff2f,
      tick: 2_400,
    });
    expect(result.download.timeline).toEqual({
      durationTicks: 2_400,
      endTick: 2_400,
      originTick: 0,
    });
    expect(JSON.stringify(result.download)).not.toMatch(
      /artifactId|destination|print-mix|stem-print|stable-audio-3|instrument/i,
    );
  });

  it('rejects malformed MIDI encoding input explicitly', () => {
    const project = createPrintMixMidiProject();
    project.selection = { items: [{ id: 'midi-clip-1', type: 'clip' }] };
    const plan = requireMidiPlan(project);
    const malformed = {
      ...structuredClone(plan),
      durationTicks: 100,
    };

    expect(() => encodeTimelineExportMidi(malformed)).toThrow(
      TimelineExportEncodingError,
    );
  });
});

function requireAudioPlan(project: ProjectState) {
  const result = createTimelineExportPlan(project);
  if (!result.canExport || result.plan.mediaType !== 'audio') {
    throw new Error(result.canExport ? 'Expected Audio plan.' : result.message);
  }
  return result.plan;
}

function requireMidiPlan(project: ProjectState) {
  const result = createTimelineExportPlan(project);
  if (!result.canExport || result.plan.mediaType !== 'midi') {
    throw new Error(result.canExport ? 'Expected MIDI plan.' : result.message);
  }
  return result.plan;
}

function createAudioTrackProject(): ProjectState {
  const project = createPrintMixAudioProject();
  const secondClip = project.tracks[1].clips[0];
  project.tracks[0].clips[0].startTick = 960;
  secondClip.startTick = 960;
  project.tracks[0].clips.push(secondClip);
  project.tracks[1].clips = [];
  project.selection = { items: [{ id: 'audio-track-1', type: 'track' }] };
  return project;
}

function createMidiTrackProject(): ProjectState {
  const project = createPrintMixMidiProject();
  const secondClip = project.tracks[1].clips[0];
  secondClip.startTick = 1_440;
  project.tracks[0].clips.push(secondClip);
  project.tracks[1].clips = [];
  project.selection = { items: [{ id: 'midi-track-1', type: 'track' }] };
  return project;
}

function createWave(sampleAtFrame: (frame: number) => number): Uint8Array {
  const dataByteLength = PRINT_MIX_TEST_SOURCE_FRAMES * 4;
  const bytes = new Uint8Array(44 + dataByteLength);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44_100, true);
  view.setUint32(28, 176_400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  for (let frame = 0; frame < PRINT_MIX_TEST_SOURCE_FRAMES; frame += 1) {
    const sample = Math.max(-1, Math.min(1, sampleAtFrame(frame)));
    const pcm = Math.round(sample * (sample < 0 ? 32_768 : 32_767));
    view.setInt16(44 + frame * 4, pcm, true);
    view.setInt16(46 + frame * 4, pcm, true);
  }
  return bytes;
}

function createFloatWave(sampleAtFrame: (frame: number) => number): Uint8Array {
  const frameCount = 48_000;
  const dataByteLength = frameCount * 8;
  const bytes = new Uint8Array(44 + dataByteLength);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 48_000 * 8, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = sampleAtFrame(frame);
    view.setFloat32(44 + frame * 8, sample, true);
    view.setFloat32(48 + frame * 8, sample, true);
  }
  return bytes;
}

function createWaveBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'audio/wav' });
}

function readStereoSample(bytes: Uint8Array, frame: number): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [
    normalizePcm(view.getInt16(44 + frame * 4, true)),
    normalizePcm(view.getInt16(46 + frame * 4, true)),
  ];
}

function normalizePcm(value: number): number {
  return value < 0 ? value / 32_768 : value / 32_767;
}

type ParsedMidiEvent = {
  data: number[];
  status: number;
  tick: number;
};

function parseMidiEvents(bytes: Uint8Array): ParsedMidiEvent[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trackLength = view.getUint32(18, false);
  const trackEnd = 22 + trackLength;
  const events: ParsedMidiEvent[] = [];
  let offset = 22;
  let tick = 0;

  while (offset < trackEnd) {
    const delta = readVariableLength(bytes, offset);
    offset = delta.nextOffset;
    tick += delta.value;
    const status = bytes[offset];
    offset += 1;

    if (status === 0xff) {
      const metaType = bytes[offset];
      offset += 1;
      const length = readVariableLength(bytes, offset);
      offset = length.nextOffset;
      const data = Array.from(bytes.slice(offset, offset + length.value));
      offset += length.value;
      events.push({ data, status: 0xff00 | metaType, tick });
    } else {
      const dataLength = status >= 0xc0 && status <= 0xdf ? 1 : 2;
      const data = Array.from(bytes.slice(offset, offset + dataLength));
      offset += dataLength;
      events.push({ data, status, tick });
    }
  }
  return events;
}

function readVariableLength(
  bytes: Uint8Array,
  startOffset: number,
): { nextOffset: number; value: number } {
  let offset = startOffset;
  let value = 0;
  let byte: number;
  do {
    byte = bytes[offset];
    offset += 1;
    value = (value << 7) | (byte & 0x7f);
  } while ((byte & 0x80) !== 0);
  return { nextOffset: offset, value };
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
