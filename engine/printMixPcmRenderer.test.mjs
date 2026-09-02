import { describe, expect, it } from 'vitest';

import {
  PRINT_MIX_NORMALIZE_TARGET_PEAK,
  PRINT_MIX_WAVE_FORMAT,
} from '../shared/printMixProtocol.js';
import {
  PrintMixPcmRenderError,
  renderPrintMixPcm,
} from './printMixPcmRenderer.mjs';
import {
  createOutputWave,
  writeOutputBlock,
} from './projectPcmMixdownRenderer.mjs';

const OPERATION_ID =
  'print-mix-operation-11111111-1111-4111-8111-111111111111';
const SOURCE_FRAMES = 22_050;

describe('renderPrintMixPcm', () => {
  it('preserves bounded Timeline silence and sums overlaps before one whole-result normalization', () => {
    const gapPlan = createPlan({ durationTicks: 2_880, secondStartSeconds: 1 });
    const sources = new Map([
      ['artifact-source-1', createWave(0.25)],
      ['artifact-source-2', createWave(0.25)],
    ]);
    const gap = renderPrintMixPcm(gapPlan, sources, { blockFrameCount: 2_048 });

    expect(readStereoSample(gap.bytes, 0)[0]).toBeCloseTo(
      PRINT_MIX_NORMALIZE_TARGET_PEAK,
      4,
    );
    expect(readStereoSample(gap.bytes, Math.round(0.75 * 44_100))).toEqual([
      0,
      0,
    ]);
    expect(readStereoSample(gap.bytes, 44_100)[0]).toBeCloseTo(
      PRINT_MIX_NORMALIZE_TARGET_PEAK,
      4,
    );

    const overlapPlan = createPlan({
      durationTicks: 960,
      secondStartSeconds: 0,
    });
    const overlap = renderPrintMixPcm(overlapPlan, sources);

    expect(overlap.preNormalizationPeak).toBeCloseTo(0.5, 4);
    expect(overlap.appliedGain).toBeCloseTo(
      PRINT_MIX_NORMALIZE_TARGET_PEAK / overlap.preNormalizationPeak,
      10,
    );
    expect(overlap.outputPeak).toBeCloseTo(
      PRINT_MIX_NORMALIZE_TARGET_PEAK,
      10,
    );
    expect(overlap.clippingWarning).toBe(false);
  });

  it('does not normalize individual sources and exposes deterministic clipping warning when Normalize is Off', () => {
    const plan = createPlan({
      durationTicks: 960,
      normalize: false,
      secondStartSeconds: 0,
    });
    const result = renderPrintMixPcm(
      plan,
      new Map([
        ['artifact-source-1', createWave(0.75)],
        ['artifact-source-2', createWave(0.75)],
      ]),
    );

    expect(result.appliedGain).toBe(1);
    expect(result.preNormalizationPeak).toBeGreaterThan(1);
    expect(result.outputPeak).toBe(result.preNormalizationPeak);
    expect(result.clippingWarning).toBe(true);
    expect(readStereoSample(result.bytes, 0)[0]).toBe(1);
  });

  it('keeps silent input silent with finite normalization metadata', () => {
    const plan = createPlan({ durationTicks: 960, secondStartSeconds: 0 });
    const result = renderPrintMixPcm(
      plan,
      new Map([
        ['artifact-source-1', createWave(0)],
        ['artifact-source-2', createWave(0)],
      ]),
    );

    expect(result).toMatchObject({
      appliedGain: 1,
      clippingWarning: false,
      outputPeak: 0,
      preNormalizationPeak: 0,
    });
    expect(Number.isFinite(result.appliedGain)).toBe(true);
    expect(readStereoSample(result.bytes, 100)).toEqual([0, 0]);
  });

  it('fails closed on missing, stale, partial, unexpected, or unsupported source bytes', () => {
    const plan = createPlan({ durationTicks: 960, secondStartSeconds: 0 });
    const valid = createWave(0.1);

    for (const sources of [
      new Map([['artifact-source-1', valid]]),
      new Map([
        ['artifact-source-1', valid],
        ['artifact-source-2', valid.subarray(0, valid.length - 2)],
      ]),
      new Map([
        ['artifact-source-1', valid],
        ['artifact-source-2', Buffer.alloc(valid.length)],
      ]),
      new Map([
        ['artifact-source-1', valid],
        ['artifact-source-2', valid],
        ['unexpected', valid],
      ]),
    ]) {
      expect(() => renderPrintMixPcm(plan, sources)).toThrow(
        PrintMixPcmRenderError,
      );
    }
  });
});

function createPlan({ durationTicks, normalize = true, secondStartSeconds }) {
  const durationSeconds = durationTicks / 1_920;
  const endTick = durationTicks;
  const descriptors = [1, 2].map((index) => ({
    kind: 'generated',
    name: `artifact-source-${index}.wav`,
    relativePath: `renders/instruments/artifact-source-${index}.wav`,
    sizeBytes: 44 + SOURCE_FRAMES * 4,
    sourceId: `artifact-source-${index}`,
  }));

  return {
    bpm: 120,
    durationSeconds,
    durationTicks,
    endTick,
    events: [
      {
        clipId: 'clip-1',
        durationSeconds: 0.5,
        sourceId: 'artifact-source-1',
        sourceStartSeconds: 0,
        startOffsetSeconds: 0,
      },
      {
        clipId: 'clip-2',
        durationSeconds: 0.5,
        sourceId: 'artifact-source-2',
        sourceStartSeconds: 0,
        startOffsetSeconds: secondStartSeconds,
      },
    ],
    format: { ...PRINT_MIX_WAVE_FORMAT },
    mediaType: 'audio',
    normalize,
    operationId: OPERATION_ID,
    patchTabId: 'print-mix',
    purpose: 'print-mix',
    selectedClipIds: ['clip-1', 'clip-2'],
    sourceLineage: [
      {
        artifactId: 'artifact-source-1',
        clipId: 'clip-1',
        clipTakeId: 'clip-take-source-1',
      },
      {
        artifactId: 'artifact-source-2',
        clipId: 'clip-2',
        clipTakeId: 'clip-take-source-2',
      },
    ],
    sources: descriptors,
    startTick: 0,
    targetPeakDbfs: -1,
    ticksPerQuarter: 960,
    version: 1,
  };
}

function createWave(sample) {
  const bytes = createOutputWave(SOURCE_FRAMES);
  const left = new Float64Array(SOURCE_FRAMES).fill(sample);
  const right = new Float64Array(SOURCE_FRAMES).fill(sample);
  writeOutputBlock(bytes, 0, left, right);
  return bytes;
}

function readStereoSample(bytes, frame) {
  const offset = 44 + frame * 4;
  return [
    normalizePcm(bytes.readInt16LE(offset)),
    normalizePcm(bytes.readInt16LE(offset + 2)),
  ];
}

function normalizePcm(value) {
  return value < 0 ? value / 32_768 : value / 32_767;
}
