import { describe, expect, it } from 'vitest';

import {
  createMixerCompressorEffect,
  createMixerLimiterEffect,
} from '../shared/mixerEffectsContract.js';
import {
  createTestRawMixdownPlanV3,
  createTestStemPrintPlanV1,
} from './projectMixdownTestFixtures.mjs';
import { renderProjectPcmMixdown } from './projectPcmMixdownRenderer.mjs';
import {
  adaptProjectStemPrintPlanToRawMixdown,
  renderProjectPcmStemPrint,
} from './projectPcmStemPrintRenderer.mjs';

const SAMPLE_RATE = 44_100;
const TICKS_PER_BEAT = 960;
const TEST_BPM = (60 * SAMPLE_RATE) / TICKS_PER_BEAT;

describe('Project PCM Stem Print renderer adapter', () => {
  it.each([
    ['Channel', undefined],
    ['Group', 'group-1'],
  ])('renders deterministic %s Stem WAV bytes and metadata', (_label, groupTrackId) => {
    const source = createPcm16Wave([4_000, -2_000, 1_000, 500]);
    const plan = createStemPlan({ groupTrackId, source });
    const sources = new Map([['source-1', source]]);

    const first = renderProjectPcmStemPrint(plan, sources);
    const second = renderProjectPcmStemPrint(plan, sources);

    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first).toMatchObject({
      bitsPerSample: 16,
      channels: 2,
      durationSeconds: 4 / SAMPLE_RATE,
      frameCount: 4,
      mimeType: 'audio/wav',
      sampleRate: SAMPLE_RATE,
    });
    expect(readOutputFrame(first.bytes, 0)).toEqual([2_828, 2_828]);
  });

  it('renders only the explicitly planned schedules in a multi-target submix', () => {
    const firstSource = createPcm16Wave([4_000]);
    const secondSource = createPcm16Wave([2_000]);
    const tracks = [
      createTrack('track-1', 'source-1', 1),
      createTrack('track-2', 'source-2', 1, 'group-2'),
    ];
    const plan = createTestStemPrintPlanV1({
      bpm: TEST_BPM,
      durationSeconds: 1 / SAMPLE_RATE,
      endTick: 1,
      selectedTargets: [
        channelTarget('track-1'),
        groupTarget('group-2', 'track-2'),
      ],
      sources: [
        generatedDescriptor('source-1', firstSource),
        generatedDescriptor('source-2', secondSource),
      ],
      tracks,
    });
    const unrelated = createTestRawMixdownPlanV3({
      bpm: TEST_BPM,
      durationSeconds: 1 / SAMPLE_RATE,
      endTick: 1,
      sources: [generatedDescriptor('unused', firstSource)],
      tracks: [createTrack('track-unused', 'unused', 1)],
    }).mixerSnapshot.channels[0];
    plan.mixerSnapshot.channels.push(unrelated);

    const result = renderProjectPcmStemPrint(
      plan,
      new Map([
        ['source-1', firstSource],
        ['source-2', secondSource],
      ]),
    );

    expect(readOutputFrame(result.bytes, 0)).toEqual([4_243, 4_243]);
  });

  it('uses the exact existing Channel and Master DSP chain', () => {
    const source = createPcm16Wave([18_000, -12_000, 6_000, -3_000]);
    const stemPlan = createStemPlan({ source });
    stemPlan.mixerSnapshot.channels[0].inserts[1] =
      createMixerCompressorEffect({
        attackMs: 0.1,
        kneeDb: 0,
        makeupGainDb: 1,
        ratio: 6,
        releaseMs: 10,
        thresholdDb: -24,
      }, false);
    stemPlan.mixerSnapshot.master.inserts[2] = createMixerLimiterEffect({
      ceilingDb: -6,
      releaseMs: 10,
    }, false);
    const rawPlan = adaptProjectStemPrintPlanToRawMixdown(stemPlan);
    const sources = new Map([['source-1', source]]);

    const stem = renderProjectPcmStemPrint(stemPlan, sources, {
      blockFrameCount: 2,
    });
    const raw = renderProjectPcmMixdown(rawPlan, sources, {
      blockFrameCount: 2,
    });

    expect(stem.bytes.equals(raw.bytes)).toBe(true);
    expect(stem.meterSummary).toEqual(raw.meterSummary);
    expect(stem).toMatchObject({
      durationSeconds: raw.durationSeconds,
      frameCount: raw.frameCount,
    });
  });

  it.each([
    ['wrong purpose', (plan) => { plan.purpose = 'mixdown'; }],
    ['wrong version', (plan) => { plan.version = 2; }],
    ['malformed shape', (plan) => { plan.extra = true; }],
  ])('rejects a %s before adapting to the render core', (_label, corrupt) => {
    const source = createPcm16Wave([0]);
    const plan = createStemPlan({ source });
    corrupt(plan);

    expect(() => renderProjectPcmStemPrint(
      plan,
      new Map([['source-1', source]]),
    )).toThrow(expect.objectContaining({ code: 'STEM_PRINT_PLAN_INVALID' }));
  });

  it.each([
    ['missing', () => new Map()],
    ['extra', (source) => new Map([
      ['source-1', source],
      ['unexpected', source],
    ])],
  ])('rejects an exact source Map with %s bytes', (_label, createSources) => {
    const source = createPcm16Wave([0]);

    expect(() => renderProjectPcmStemPrint(
      createStemPlan({ source }),
      createSources(source),
    )).toThrow(expect.objectContaining({ code: 'MIXDOWN_SOURCE_SET_INVALID' }));
  });
});

function createStemPlan({ groupTrackId, source }) {
  const track = createTrack('track-1', 'source-1', 4, groupTrackId);
  return createTestStemPrintPlanV1({
    bpm: TEST_BPM,
    durationSeconds: 4 / SAMPLE_RATE,
    endTick: 4,
    selectedTargets: groupTrackId
      ? [groupTarget(groupTrackId, track.trackId)]
      : [channelTarget(track.trackId)],
    sources: [generatedDescriptor('source-1', source)],
    tracks: [track],
  });
}

function createTrack(trackId, sourceId, frameCount, groupTrackId) {
  return {
    events: [{
      clipId: `clip-${trackId}`,
      clipName: `clip-${trackId}`,
      durationSeconds: frameCount / SAMPLE_RATE,
      sourceId,
      sourceStartSeconds: 0,
      startOffsetSeconds: 0,
      timelineEndTick: frameCount,
      timelineStartTick: 0,
    }],
    gainDb: 0,
    ...(groupTrackId ? { groupTrackId } : {}),
    pan: 0,
    trackId,
  };
}

function channelTarget(trackId) {
  return { kind: 'channel', resolvedTrackId: trackId, trackId };
}

function groupTarget(groupTrackId, resolvedTrackId) {
  return { groupTrackId, kind: 'group', resolvedTrackId };
}

function generatedDescriptor(sourceId, bytes) {
  return {
    kind: 'generated',
    name: `${sourceId}.wav`,
    relativePath: `renders/instruments/${sourceId}.wav`,
    sizeBytes: bytes.byteLength,
    sourceId,
  };
}

function createPcm16Wave(samples) {
  const dataByteLength = samples.length * 2;
  const bytes = Buffer.alloc(44 + dataByteLength);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataByteLength, 40);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, 44 + index * 2));
  return bytes;
}

function readOutputFrame(bytes, frame) {
  return [
    bytes.readInt16LE(44 + frame * 4),
    bytes.readInt16LE(46 + frame * 4),
  ];
}
