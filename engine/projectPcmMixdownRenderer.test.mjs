import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  RAW_MIXDOWN_WAVE_FORMAT,
} from '../shared/rawMixdownProtocol.js';
import {
  createDefaultMixerCompressorEffect,
  createDefaultMixerEchoDelayEffect,
  createDefaultMixerEqualizerEffect,
  createDefaultMixerLimiterEffect,
} from '../shared/mixerEffectsContract.js';
import {
  ProjectPcmMixdownRenderError,
  renderProjectPcmMixdown,
  validateProjectPcmMixdownPlan,
} from './projectPcmMixdownRenderer.mjs';

const OUTPUT_SAMPLE_RATE = 44_100;
const TEST_TIMELINE_TICKS_PER_BEAT = 960;
// Keep compact frame-level renderer fixtures coherent with integer Timeline ticks.
const TEST_BPM =
  (60 * OUTPUT_SAMPLE_RATE) / TEST_TIMELINE_TICKS_PER_BEAT;

describe('renderProjectPcmMixdown', () => {
  it('resamples mono PCM to the canonical stereo 44.1 kHz output', () => {
    const source = createPcm16Wave({
      frames: [[0], [32_767], [0]],
      sampleRate: 48_000,
    });
    const durationSeconds = 3 / 48_000;
    const plan = createPlan({
      durationSeconds,
      sources: [generatedDescriptor('mono-source', source)],
      tracks: [
        createTrack({
          events: [createEvent({ durationSeconds, sourceId: 'mono-source' })],
        }),
      ],
    });

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['mono-source', source]]),
    );

    expect(result).toMatchObject({
      bitsPerSample: 16,
      channels: 2,
      frameCount: 3,
      mimeType: 'audio/wav',
      sampleRate: OUTPUT_SAMPLE_RATE,
    });
    expect(inspectOutputHeader(result.bytes)).toEqual({
      bitsPerSample: 16,
      channels: 2,
      dataByteLength: 12,
      frameCount: 3,
      sampleRate: OUTPUT_SAMPLE_RATE,
    });
    expect(readOutputFrames(result.bytes)).toEqual([
      [0, 0],
      [21_121, 21_121],
      [0, 0],
    ]);
  });

  it('applies the versioned equal-power mono Pan law at center, edges, and an intermediate value', () => {
    const source = createPcm16Wave({ frames: [[10_000]] });
    const durationSeconds = 1 / OUTPUT_SAMPLE_RATE;
    const renderPan = (pan) =>
      readOutputFrame(
        renderProjectPcmMixdown(
          createPlan({
            durationSeconds,
            sources: [generatedDescriptor('mono-pan-source', source)],
            tracks: [
              createTrack({
                events: [
                  createEvent({
                    durationSeconds,
                    sourceId: 'mono-pan-source',
                  }),
                ],
                pan,
              }),
            ],
          }),
          new Map([['mono-pan-source', source]]),
        ).bytes,
        0,
      );

    expect(renderPan(-1)).toEqual([10_000, 0]);
    expect(renderPan(0)).toEqual([7_071, 7_071]);
    expect(renderPan(1)).toEqual([0, 10_000]);
    expect(renderPan(0.5)).toEqual([3_827, 9_239]);
  });

  it('applies channel-preserving stereo balance and the Master Fader after summing', () => {
    const source = createPcm16Wave({ frames: [[8_000, -4_000]] });
    const durationSeconds = 1 / OUTPUT_SAMPLE_RATE;
    const renderPan = (pan, masterFaderDb = 0) => {
      const plan = createPlan({
        durationSeconds,
        sources: [generatedDescriptor('stereo-pan-source', source)],
        tracks: [
          createTrack({
            events: [
              createEvent({
                durationSeconds,
                sourceId: 'stereo-pan-source',
              }),
            ],
            pan,
          }),
        ],
      });
      plan.masterFaderDb = masterFaderDb;
      plan.mixerSnapshot.master.faderDb = masterFaderDb;
      return readOutputFrame(
        renderProjectPcmMixdown(
          plan,
          new Map([['stereo-pan-source', source]]),
        ).bytes,
        0,
      );
    };

    expect(renderPan(-1)).toEqual([8_000, 0]);
    expect(renderPan(0)).toEqual([8_000, -4_000]);
    expect(renderPan(1)).toEqual([0, -4_000]);
    expect(renderPan(0.5)).toEqual([5_657, -4_000]);
    expect(renderPan(0, -6.020599913279624)).toEqual([4_000, -2_000]);
  });

  it('measures post-Pan Channels and the post-Fader Master without changing WAV bytes', () => {
    const source = createPcm16Wave({ frames: [[32_767, -32_768]] });
    const durationSeconds = 1 / OUTPUT_SAMPLE_RATE;
    const plan = createPlan({
      durationSeconds,
      sources: [generatedDescriptor('meter-source', source)],
      tracks: [
        createTrack({
          events: [
            createEvent({ durationSeconds, sourceId: 'meter-source' }),
          ],
          trackId: 'track-a',
        }),
        createTrack({
          events: [
            createEvent({
              clipId: 'clip-b',
              durationSeconds,
              sourceId: 'meter-source',
            }),
          ],
          trackId: 'track-b',
        }),
      ],
    });
    plan.masterFaderDb = -6.020599913279624;
    plan.mixerSnapshot.master.faderDb = -6.020599913279624;

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['meter-source', source]]),
    );
    const fullScaleMeter = {
      clipped: false,
      left: { clipped: false, peak: 1 },
      right: { clipped: false, peak: 1 },
      sampleCount: 1,
      version: 1,
    };

    expect(result.bytes).toEqual(
      createPcm16Wave({ frames: [[32_767, -32_768]] }),
    );
    expect(result.meterSummary).toEqual({
      channels: [
        { meter: fullScaleMeter, trackId: 'track-a' },
        { meter: fullScaleMeter, trackId: 'track-b' },
      ],
      master: fullScaleMeter,
      channelTapPosition: 'post-channel-effects-pre-master-sum',
      masterTapPosition: 'post-master-effects-pre-pcm-clamp',
      samplePeakContractVersion: 1,
      schemaVersion: 2,
    });
    expect(Object.isFrozen(result.meterSummary)).toBe(true);
    expect(Object.isFrozen(result.meterSummary.channels)).toBe(true);
    expect(Object.isFrozen(result.meterSummary.channels[0])).toBe(true);
    expect(Object.isFrozen(result.meterSummary.channels[0].meter)).toBe(true);
    expect(Object.isFrozen(result.meterSummary.master.left)).toBe(true);
  });

  it('places overlapping events on the timeline and applies Track Gain', () => {
    const first = createPcm16Wave({ frames: [[16_384], [16_384], [16_384]] });
    const second = createPcm16Wave({ frames: [[16_384], [16_384]] });
    const plan = createPlan({
      durationSeconds: 3 / OUTPUT_SAMPLE_RATE,
      sources: [
        generatedDescriptor('first-source', first),
        externalDescriptor('second-source', second),
      ],
      tracks: [
        createTrack({
          events: [
            createEvent({
              durationSeconds: 3 / OUTPUT_SAMPLE_RATE,
              sourceId: 'first-source',
            }),
          ],
          trackId: 'track-first',
        }),
        createTrack({
          events: [
            createEvent({
              clipId: 'clip-second',
              durationSeconds: 2 / OUTPUT_SAMPLE_RATE,
              sourceId: 'second-source',
              startOffsetSeconds: 1 / OUTPUT_SAMPLE_RATE,
            }),
          ],
          gainDb: -6.020599913279624,
          trackId: 'track-second',
        }),
      ],
    });

    const result = renderProjectPcmMixdown(
      plan,
      new Map([
        ['first-source', first],
        ['second-source', second],
      ]),
    );

    expect(readOutputFrames(result.bytes)).toEqual([
      [11_585, 11_585],
      [17_378, 17_378],
      [17_378, 17_378],
    ]);
  });

  it('renders continuously across internal output block boundaries', () => {
    const frameCount = 16_386;
    const source = createPcm16Wave({
      frames: Array.from({ length: frameCount }, () => [7_000]),
    });
    const durationSeconds = frameCount / OUTPUT_SAMPLE_RATE;
    const plan = createPlan({
      durationSeconds,
      sources: [generatedDescriptor('long-source', source)],
      tracks: [
        createTrack({
          events: [createEvent({ durationSeconds, sourceId: 'long-source' })],
        }),
      ],
    });

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['long-source', source]]),
    );

    expect(readOutputFrame(result.bytes, 16_383)).toEqual([4_950, 4_950]);
    expect(readOutputFrame(result.bytes, 16_384)).toEqual([4_950, 4_950]);
    expect(readOutputFrame(result.bytes, 16_385)).toEqual([4_950, 4_950]);
    expect(result.meterSummary.channels[0].meter.sampleCount).toBe(frameCount);
    expect(result.meterSummary.master.sampleCount).toBe(frameCount);
  });

  it('renders only the frozen source range for a cropped event', () => {
    const source = createPcm16Wave({
      frames: [[1_000], [2_000], [3_000], [4_000]],
    });
    const durationSeconds = 2 / OUTPUT_SAMPLE_RATE;
    const plan = createPlan({
      durationSeconds,
      sources: [generatedDescriptor('cropped-source', source)],
      tracks: [
        createTrack({
          events: [
            createEvent({
              durationSeconds,
              sourceId: 'cropped-source',
              sourceStartSeconds: 2 / OUTPUT_SAMPLE_RATE,
            }),
          ],
        }),
      ],
    });

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['cropped-source', source]]),
    );

    expect(readOutputFrames(result.bytes)).toEqual([
      [2_121, 2_121],
      [2_828, 2_828],
    ]);
  });

  it('sums without hidden normalization and hard-clamps peaks instead of wrapping PCM16 samples', () => {
    const source = createPcm16Wave({ frames: [[30_000, -30_000]] });
    const eventDuration = 1 / OUTPUT_SAMPLE_RATE;
    const plan = createPlan({
      durationSeconds: eventDuration,
      sources: [generatedDescriptor('peak-source', source)],
      tracks: [
        createTrack({
          events: [createEvent({ durationSeconds: eventDuration, sourceId: 'peak-source' })],
          trackId: 'track-a',
        }),
        createTrack({
          events: [
            createEvent({
              clipId: 'clip-b',
              durationSeconds: eventDuration,
              sourceId: 'peak-source',
            }),
          ],
          trackId: 'track-b',
        }),
      ],
    });

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['peak-source', source]]),
    );

    expect(readOutputFrames(result.bytes)).toEqual([[32_767, -32_768]]);
    expect(result.meterSummary.channels).toEqual([
      {
        meter: {
          clipped: false,
          left: {
            clipped: false,
            peak: 30_000 / 32_767,
          },
          right: {
            clipped: false,
            peak: 30_000 / 32_768,
          },
          sampleCount: 1,
          version: 1,
        },
        trackId: 'track-a',
      },
      {
        meter: {
          clipped: false,
          left: {
            clipped: false,
            peak: 30_000 / 32_767,
          },
          right: {
            clipped: false,
            peak: 30_000 / 32_768,
          },
          sampleCount: 1,
          version: 1,
        },
        trackId: 'track-b',
      },
    ]);
    expect(result.meterSummary.master).toEqual({
      clipped: true,
      left: { clipped: true, peak: 60_000 / 32_767 },
      right: { clipped: true, peak: 60_000 / 32_768 },
      sampleCount: 1,
      version: 1,
    });
  });

  it('measures overlapping events after their Channel sum and before the Master', () => {
    const source = createPcm16Wave({ frames: [[20_000, -16_000]] });
    const durationSeconds = 1 / OUTPUT_SAMPLE_RATE;
    const plan = createPlan({
      durationSeconds,
      sources: [generatedDescriptor('overlap-source', source)],
      tracks: [
        createTrack({
          events: [
            createEvent({ durationSeconds, sourceId: 'overlap-source' }),
            createEvent({
              clipId: 'overlap-clip-b',
              durationSeconds,
              sourceId: 'overlap-source',
            }),
          ],
          trackId: 'overlap-track',
        }),
      ],
    });

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['overlap-source', source]]),
    );

    expect(readOutputFrames(result.bytes)).toEqual([[32_767, -32_000]]);
    expect(result.meterSummary.channels[0]).toEqual({
      meter: {
        clipped: true,
        left: { clipped: true, peak: 40_000 / 32_767 },
        right: { clipped: false, peak: 32_000 / 32_768 },
        sampleCount: 1,
        version: 1,
      },
      trackId: 'overlap-track',
    });
    expect(result.meterSummary.master).toEqual(
      result.meterSummary.channels[0].meter,
    );
  });

  it('preserves the retained Plan v2 WAV bytes when every v3 effect is BYPASS', () => {
    const source = createPcm16Wave({
      frames: [
        [12_345, -23_456],
        [-30_000, 8_000],
        [1_234, -5_678],
        [32_767, -32_768],
      ],
    });
    const durationSeconds = 4 / OUTPUT_SAMPLE_RATE;
    const plan = createPlan({
      durationSeconds,
      sources: [generatedDescriptor('bypass-source', source)],
      tracks: [
        createTrack({
          events: [createEvent({ durationSeconds, sourceId: 'bypass-source' })],
          gainDb: -2.5,
          pan: 0.375,
        }),
      ],
    });
    plan.masterFaderDb = -1.25;
    plan.mixerSnapshot.master.faderDb = -1.25;

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['bypass-source', source]]),
    );

    expect(createHash('sha256').update(result.bytes).digest('hex')).toBe(
      '212f314f7026b02bd7d12b909924262bbc5d9decf3dbb7cb0a51dc43841852a1',
    );
  });

  it('renders a deterministic Channel Equalizer golden vector', () => {
    const source = createPcm16Wave({
      frames: [
        [20_000, -10_000],
        [-15_000, 7_500],
        [10_000, -5_000],
        [-5_000, 2_500],
        [0, 0],
        [3_000, -1_500],
      ],
    });
    const durationSeconds = 6 / OUTPUT_SAMPLE_RATE;
    const plan = createPlan({
      durationSeconds,
      sources: [generatedDescriptor('eq-source', source)],
      tracks: [
        createTrack({
          events: [createEvent({ durationSeconds, sourceId: 'eq-source' })],
        }),
      ],
    });
    enableChannelEffect(plan, 'track-1', 0, {
      highGainDb: 5,
      lowGainDb: 8,
      midGainDb: -4,
      midQ: 1.5,
    });

    const first = renderProjectPcmMixdown(
      plan,
      new Map([['eq-source', source]]),
      { blockFrameCount: 2 },
    );
    const second = renderProjectPcmMixdown(
      plan,
      new Map([['eq-source', source]]),
      { blockFrameCount: 5 },
    );

    expect(readOutputFrames(first.bytes)).toEqual([
      [28_254, -14_127],
      [-30_825, 15_412],
      [19_474, -9_737],
      [-9_538, 4_769],
      [1_272, -636],
      [4_691, -2_346],
    ]);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.meterSummary).toEqual(second.meterSummary);
  });

  it('runs Channel Equalizer then Compressor then Delay through silence and truncates at render end', () => {
    const source = createPcm16Wave({ frames: [[32_767, 16_384]] });
    const renderFrameCount = 448;
    const plan = createPlan({
      durationSeconds: renderFrameCount / OUTPUT_SAMPLE_RATE,
      sources: [generatedDescriptor('chain-source', source)],
      tracks: [
        createTrack({
          events: [
            createEvent({
              durationSeconds: 1 / OUTPUT_SAMPLE_RATE,
              sourceId: 'chain-source',
            }),
          ],
        }),
      ],
    });
    enableChannelEffect(plan, 'track-1', 0, {
      lowGainDb: 12,
      midGainDb: -6,
    });
    enableChannelEffect(plan, 'track-1', 1, {
      attackMs: 0.1,
      kneeDb: 0,
      ratio: 10,
      thresholdDb: -24,
    });
    enableChannelEffect(plan, 'track-1', 2, {
      delayTimeMs: 10,
      dry: 0,
      feedback: 0.5,
      wet: 1,
    });

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['chain-source', source]]),
      { blockFrameCount: 37 },
    );

    expect(readOutputFrames(result.bytes).slice(439, 448)).toEqual([
      [0, 0],
      [0, 0],
      [19_179, 9_590],
      [-1_317, -659],
      [-996, -498],
      [-708, -354],
      [-453, -227],
      [-230, -115],
      [-37, -18],
    ]);
    expect(readOutputFrame(result.bytes, 0)).toEqual([0, 0]);
    expect(result.frameCount).toBe(renderFrameCount);
  });

  it('keeps Channel effect state independent and invariant across ring-wrap block partitions', () => {
    const source = createPcm16Wave({ frames: [[24_000, -12_000]] });
    const renderFrameCount = 88_203;
    const plan = createPlan({
      durationSeconds: renderFrameCount / OUTPUT_SAMPLE_RATE,
      sources: [generatedDescriptor('delay-source', source)],
      tracks: [
        createTrack({
          events: [
            createEvent({
              durationSeconds: 1 / OUTPUT_SAMPLE_RATE,
              sourceId: 'delay-source',
            }),
          ],
          trackId: 'track-a',
        }),
        createTrack({
          events: [
            createEvent({
              clipId: 'clip-b',
              durationSeconds: 1 / OUTPUT_SAMPLE_RATE,
              sourceId: 'delay-source',
              startOffsetSeconds: 1 / OUTPUT_SAMPLE_RATE,
            }),
          ],
          trackId: 'track-b',
        }),
      ],
    });
    for (const trackId of ['track-a', 'track-b']) {
      enableChannelEffect(plan, trackId, 2, {
        delayTimeMs: 2_000,
        dry: 0,
        feedback: 0.95,
        wet: 1,
      });
    }

    const first = renderProjectPcmMixdown(
      plan,
      new Map([['delay-source', source]]),
      { blockFrameCount: 257 },
    );
    const second = renderProjectPcmMixdown(
      plan,
      new Map([['delay-source', source]]),
      { blockFrameCount: 16_384 },
    );

    expect(first.bytes).toEqual(second.bytes);
    expect(first.meterSummary).toEqual(second.meterSummary);
    expect(readOutputFrame(first.bytes, 88_199)).toEqual([0, 0]);
    expect(readOutputFrame(first.bytes, 88_200)).toEqual([24_000, -12_000]);
    expect(readOutputFrame(first.bytes, 88_201)).toEqual([24_000, -12_000]);
    expect(readOutputFrame(first.bytes, 88_202)).toEqual([0, 0]);
  });

  it('runs the Master Equalizer, Compressor, and structurally-last Limiter before metering and PCM clamp', () => {
    const source = createPcm16Wave({
      frames: [
        [32_767, -32_768],
        [24_000, -12_000],
        [16_000, -8_000],
        [8_000, -4_000],
      ],
    });
    const durationSeconds = 4 / OUTPUT_SAMPLE_RATE;
    const plan = createPlan({
      durationSeconds,
      sources: [generatedDescriptor('master-source', source)],
      tracks: [
        createTrack({
          events: [createEvent({ durationSeconds, sourceId: 'master-source' })],
          trackId: 'track-a',
        }),
        createTrack({
          events: [
            createEvent({
              clipId: 'clip-b',
              durationSeconds,
              sourceId: 'master-source',
            }),
          ],
          trackId: 'track-b',
        }),
      ],
    });
    enableMasterEffect(plan, 0, { highGainDb: 6, lowGainDb: 3 });
    enableMasterEffect(plan, 1, {
      attackMs: 0.1,
      kneeDb: 0,
      ratio: 8,
      thresholdDb: -18,
    });
    enableMasterEffect(plan, 2, { ceilingDb: -6, releaseMs: 50 });

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['master-source', source]]),
      { blockFrameCount: 1 },
    );

    expect(readOutputFrames(result.bytes)).toEqual([
      [16_422, -16_423],
      [4_528, 55],
      [1_949, -698],
      [987, -825],
    ]);
    expect(result.meterSummary.master.left.peak).toBeLessThanOrEqual(
      10 ** (-6 / 20),
    );
    expect(result.meterSummary.master.right.peak).toBeLessThanOrEqual(
      10 ** (-6 / 20),
    );
    expect(result.meterSummary.master.clipped).toBe(false);
  });

  it.each([
    ['effect identity', (plan) => { plan.mixerSnapshot.channels[0].inserts[0].algorithmVersion = 2; }],
    ['effect parameter', (plan) => { plan.mixerSnapshot.channels[0].inserts[1].parameters.ratio = Number.NaN; }],
    ['effect shape', (plan) => { plan.mixerSnapshot.master.inserts[2].unexpected = true; }],
  ])('rejects malformed %s before rendering', (_label, mutate) => {
    const source = createPcm16Wave({ frames: [[1_000]] });
    const plan = structuredClone(createSingleSourcePlan(source));
    mutate(plan);

    expectRenderError(
      () => renderProjectPcmMixdown(plan, new Map([['source-1', source]])),
      'MIXDOWN_PLAN_INVALID',
    );
  });

  it('accepts padded non-audio chunks without relying on a fixed 44-byte header', () => {
    const source = createPcm16Wave({
      extraChunks: [{ id: 'JUNK', bytes: Buffer.from([1, 2, 3]) }],
      frames: [[1_234]],
    });
    const durationSeconds = 1 / OUTPUT_SAMPLE_RATE;
    const plan = createPlan({
      durationSeconds,
      sources: [generatedDescriptor('chunked-source', source)],
      tracks: [
        createTrack({
          events: [createEvent({ durationSeconds, sourceId: 'chunked-source' })],
        }),
      ],
    });

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['chunked-source', source]]),
    );

    expect(readOutputFrames(result.bytes)).toEqual([[873, 873]]);
  });

  it('rejects malformed and unsupported source WAV files', () => {
    const valid = createPcm16Wave({ frames: [[0]] });
    const malformed = Buffer.from(valid);
    malformed.writeUInt32LE(malformed.byteLength - 9, 4);
    const unsupported = Buffer.from(valid);
    unsupported.writeUInt16LE(3, 20);

    expectRenderError(
      () => renderSingleSource(malformed),
      'MIXDOWN_SOURCE_WAV_INVALID',
    );
    expectRenderError(
      () => renderSingleSource(unsupported),
      'MIXDOWN_SOURCE_WAV_INVALID',
    );
  });

  it('rejects missing, extra, mismatched, and unused source byte authority', () => {
    const source = createPcm16Wave({ frames: [[0]] });
    const plan = createSingleSourcePlan(source);

    expectRenderError(
      () => renderProjectPcmMixdown(plan, new Map()),
      'MIXDOWN_SOURCE_SET_INVALID',
    );
    expectRenderError(
      () => renderProjectPcmMixdown(
        plan,
        new Map([
          ['source-1', source],
          ['unexpected', source],
        ]),
      ),
      'MIXDOWN_SOURCE_SET_INVALID',
    );

    const mismatchedPlan = structuredClone(plan);
    mismatchedPlan.sources[0].sizeBytes += 2;
    expectRenderError(
      () => renderProjectPcmMixdown(
        mismatchedPlan,
        new Map([['source-1', source]]),
      ),
      'MIXDOWN_SOURCE_SIZE_MISMATCH',
    );

    const unusedPlan = structuredClone(plan);
    unusedPlan.sources.push(generatedDescriptor('unused-source', source));
    expectRenderError(
      () => renderProjectPcmMixdown(
        unusedPlan,
        new Map([
          ['source-1', source],
          ['unused-source', source],
        ]),
      ),
      'MIXDOWN_SOURCE_SET_INVALID',
    );
  });

  it('rejects tampered Plan keys, output format, and source ranges', () => {
    const source = createPcm16Wave({ frames: [[0]] });
    const bytes = new Map([['source-1', source]]);
    const extraKeyPlan = { ...createSingleSourcePlan(source), selectedClipId: 'clip-1' };
    const wrongFormatPlan = structuredClone(createSingleSourcePlan(source));
    wrongFormatPlan.format.sampleRate = 48_000;
    const excessiveRangePlan = structuredClone(createSingleSourcePlan(source));
    excessiveRangePlan.tracks[0].events[0].sourceStartSeconds = 1;

    expectRenderError(
      () => renderProjectPcmMixdown(extraKeyPlan, bytes),
      'MIXDOWN_PLAN_INVALID',
    );
    expectRenderError(
      () => renderProjectPcmMixdown(wrongFormatPlan, bytes),
      'MIXDOWN_PLAN_INVALID',
    );
    expectRenderError(
      () => renderProjectPcmMixdown(excessiveRangePlan, bytes),
      'MIXDOWN_SOURCE_RANGE_INVALID',
    );
  });

  it.each([
    ['legacy Plan version', (plan) => { plan.version = 1; }],
    ['unsupported DSP version', (plan) => { plan.mixerDspVersion = 1; }],
    ['missing Master Fader', (plan) => { delete plan.masterFaderDb; }],
    ['non-finite Master Fader', (plan) => { plan.masterFaderDb = Number.NaN; }],
    ['underflowed Master Fader', (plan) => { plan.masterFaderDb = -Number.MAX_VALUE; }],
    ['missing Track Pan', (plan) => { delete plan.tracks[0].pan; }],
    ['non-finite Track Pan', (plan) => { plan.tracks[0].pan = Number.POSITIVE_INFINITY; }],
    ['out-of-domain Track Pan', (plan) => { plan.tracks[0].pan = 1.01; }],
    ['underflowed Track Fader', (plan) => { plan.tracks[0].gainDb = -Number.MAX_VALUE; }],
  ])('rejects %s instead of reinterpreting incomplete Mixer DSP state', (_label, mutate) => {
    const source = createPcm16Wave({ frames: [[0]] });
    const plan = createSingleSourcePlan(source);
    mutate(plan);

    expectRenderError(
      () => renderProjectPcmMixdown(plan, new Map([['source-1', source]])),
      'MIXDOWN_PLAN_INVALID',
    );
  });

  it.each([
    [
      'Plan duration',
      (plan) => {
        plan.durationSeconds = 1.5;
      },
    ],
    [
      'event start offset',
      (plan) => {
        plan.tracks[0].events[0].startOffsetSeconds = 0.5;
      },
    ],
    [
      'event duration',
      (plan) => {
        plan.tracks[0].events[0].durationSeconds = 0.5;
      },
    ],
  ])('rejects %s that contradicts BPM and Timeline ticks', (_label, mutate) => {
    const source = createPcm16Wave({ frames: [[0]] });
    const plan = createPlan({
      durationSeconds: 2,
      sources: [generatedDescriptor('source-1', source)],
      tracks: [
        createTrack({
          events: [createEvent({ durationSeconds: 1, sourceId: 'source-1' })],
        }),
      ],
    });
    mutate(plan);

    expectRenderError(
      () => renderProjectPcmMixdown(
        plan,
        new Map([['source-1', source]]),
      ),
      'MIXDOWN_PLAN_INVALID',
    );
  });

  it('rejects a 9 ms event placement contradiction at Timeline Tick zero', () => {
    const source = createPcm16Wave({ frames: [[0]] });
    const plan = createPlan({
      durationSeconds: 1,
      sources: [generatedDescriptor('source-1', source)],
      tracks: [
        createTrack({
          events: [
            createEvent({ durationSeconds: 0.5, sourceId: 'source-1' }),
          ],
        }),
      ],
    });
    plan.tracks[0].events[0].startOffsetSeconds = 0.009;

    expectRenderError(
      () => validateProjectPcmMixdownPlan(plan),
      'MIXDOWN_PLAN_INVALID',
    );
  });

  it('accepts only numerical event placement drift that resolves to the same output frame', () => {
    const source = createPcm16Wave({ frames: [[0]] });
    const plan = createPlan({
      durationSeconds: 1,
      sources: [generatedDescriptor('source-1', source)],
      tracks: [
        createTrack({
          events: [
            createEvent({ durationSeconds: 0.5, sourceId: 'source-1' }),
          ],
        }),
      ],
    });
    plan.tracks[0].events[0].startOffsetSeconds =
      0.49 / OUTPUT_SAMPLE_RATE;

    expect(validateProjectPcmMixdownPlan(plan)).toBe(plan);

    plan.tracks[0].events[0].startOffsetSeconds =
      0.51 / OUTPUT_SAMPLE_RATE;
    expectRenderError(
      () => validateProjectPcmMixdownPlan(plan),
      'MIXDOWN_PLAN_INVALID',
    );
  });

  it('uses output-frame precision for Plan duration coherence', () => {
    const source = createPcm16Wave({ frames: [[0]] });
    const plan = createPlan({
      durationSeconds: 2,
      sources: [generatedDescriptor('source-1', source)],
      tracks: [
        createTrack({
          events: [createEvent({ durationSeconds: 1, sourceId: 'source-1' })],
        }),
      ],
    });
    plan.durationSeconds = 2 + 0.49 / OUTPUT_SAMPLE_RATE;

    expect(validateProjectPcmMixdownPlan(plan)).toBe(plan);

    plan.durationSeconds = 2 + 0.51 / OUTPUT_SAMPLE_RATE;
    expectRenderError(
      () => validateProjectPcmMixdownPlan(plan),
      'MIXDOWN_PLAN_INVALID',
    );
  });

  it('retains only bounded source-duration clipping for event duration', () => {
    const sourceFrameCount = 441;
    const timelineFrameCount = 662;
    const source = createPcm16Wave({
      frames: Array.from({ length: sourceFrameCount }, () => [1_000]),
    });
    const sourceDurationSeconds = sourceFrameCount / OUTPUT_SAMPLE_RATE;
    const timelineDurationSeconds = timelineFrameCount / OUTPUT_SAMPLE_RATE;
    const plan = createPlan({
      durationSeconds: timelineDurationSeconds,
      sources: [generatedDescriptor('source-1', source)],
      tracks: [
        createTrack({
          events: [
            createEvent({
              durationSeconds: sourceDurationSeconds,
              sourceId: 'source-1',
            }),
          ],
        }),
      ],
    });
    plan.tracks[0].events[0].timelineEndTick = plan.endTick;

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['source-1', source]]),
    );

    expect(result.frameCount).toBe(timelineFrameCount);
    expect(readOutputFrame(result.bytes, sourceFrameCount - 1)).toEqual([
      707,
      707,
    ]);
    expect(readOutputFrame(result.bytes, sourceFrameCount)).toEqual([0, 0]);

    plan.tracks[0].events[0].durationSeconds =
      timelineDurationSeconds - 0.0101;
    expectRenderError(
      () => validateProjectPcmMixdownPlan(plan),
      'MIXDOWN_PLAN_INVALID',
    );
  });

  it.each([72_005, 72_013])('retains %i source frames across rounded Timeline endpoints', (frameCount) => {
    const source = createPcm16Wave({
      frames: Array.from({ length: frameCount }, () => [1_000, -1_000]),
      sampleRate: 48_000,
    });
    const durationSeconds = frameCount / 48_000;
    const plan = createPlan({
      durationSeconds: 2,
      sources: [generatedDescriptor('source-1', source)],
      tracks: [createTrack({
        events: [createEvent({ durationSeconds, sourceId: 'source-1' })],
      })],
    });
    plan.bpm = 120;
    plan.endTick = 3840;
    const event = plan.tracks[0].events[0];
    event.timelineEndTick = Math.round(durationSeconds * 1920);

    const result = renderProjectPcmMixdown(plan, new Map([['source-1', source]]));
    const renderedFrames = Math.round(durationSeconds * OUTPUT_SAMPLE_RATE);
    expect(readOutputFrame(result.bytes, renderedFrames - 1)).toEqual([1_000, -1_000]);
    expect(readOutputFrame(result.bytes, renderedFrames)).toEqual([0, 0]);

    event.durationSeconds = (event.timelineEndTick + 0.51) / 1920;
    expectRenderError(
      () => validateProjectPcmMixdownPlan(plan),
      'MIXDOWN_PLAN_INVALID',
    );
  });

  it('accepts fractional resampling timing that resolves to the same output frame', () => {
    const source = createPcm16Wave({ frames: [[1_000]], sampleRate: 48_000 });
    const durationSeconds = 1 / 48_000;
    const plan = createSingleSourcePlan(source, durationSeconds);

    const result = renderProjectPcmMixdown(
      plan,
      new Map([['source-1', source]]),
    );

    expect(result.frameCount).toBe(1);
    expect(readOutputFrames(result.bytes)).toEqual([[707, 707]]);
  });

  it('rejects output that exceeds the bounded in-memory renderer', () => {
    const source = createPcm16Wave({ frames: [[0]] });
    const plan = createSingleSourcePlan(source);
    plan.durationSeconds = 2_000;
    plan.endTick = secondsToTestTimelineTicks(plan.durationSeconds);

    expectRenderError(
      () => renderProjectPcmMixdown(
        plan,
        new Map([['source-1', source]]),
      ),
      'MIXDOWN_OUTPUT_TOO_LARGE',
    );
  });

  it('is deterministic and does not mutate Plan or source bytes', () => {
    const source = createPcm16Wave({ frames: [[-10_000], [10_000]] });
    const sourceBefore = Buffer.from(source);
    const plan = createSingleSourcePlan(source, 2 / OUTPUT_SAMPLE_RATE);
    const planBefore = structuredClone(plan);
    const sourceMap = new Map([['source-1', new Uint8Array(source)]]);

    const first = renderProjectPcmMixdown(plan, sourceMap);
    const second = renderProjectPcmMixdown(plan, sourceMap);

    expect(first.bytes).toEqual(second.bytes);
    expect(plan).toEqual(planBefore);
    expect(source).toEqual(sourceBefore);
  });
});

function renderSingleSource(source) {
  return renderProjectPcmMixdown(
    createSingleSourcePlan(source),
    new Map([['source-1', source]]),
  );
}

function createSingleSourcePlan(source, durationSeconds = 1 / OUTPUT_SAMPLE_RATE) {
  return createPlan({
    durationSeconds,
    sources: [generatedDescriptor('source-1', source)],
    tracks: [
      createTrack({
        events: [createEvent({ durationSeconds, sourceId: 'source-1' })],
      }),
    ],
  });
}

function createPlan({ durationSeconds, sources, tracks }) {
  const mixerSnapshot = createMixerSnapshot(tracks);
  return {
    bpm: TEST_BPM,
    durationSeconds,
    endTick: secondsToTestTimelineTicks(durationSeconds),
    effectsContractVersion: 1,
    format: { ...RAW_MIXDOWN_WAVE_FORMAT },
    masterFaderDb: 0,
    meterTapVersion: 2,
    mixerDspVersion: 2,
    mixerSnapshot,
    mixerSnapshotVersion: 2,
    purpose: 'mixdown',
    sources,
    startTick: 0,
    tracks,
    version: 3,
  };
}

function createMixerSnapshot(tracks) {
  return {
    channels: tracks.map((track) => ({
      faderDb: track.gainDb,
      inserts: [
        createDefaultMixerEqualizerEffect(),
        createDefaultMixerCompressorEffect(),
        createDefaultMixerEchoDelayEffect(),
      ],
      muted: false,
      outputBusId: 'stereo-master',
      pan: track.pan,
      solo: false,
      trackId: track.trackId,
    })),
    master: {
      busId: 'stereo-master',
      faderDb: 0,
      inserts: [
        createDefaultMixerEqualizerEffect(),
        createDefaultMixerCompressorEffect(),
        createDefaultMixerLimiterEffect(),
      ],
    },
    schemaVersion: 2,
  };
}

function enableChannelEffect(plan, trackId, insertIndex, parameterOverrides) {
  const channel = plan.mixerSnapshot.channels.find(
    (candidate) => candidate.trackId === trackId,
  );
  const effect = channel?.inserts[insertIndex];

  if (!channel || !effect) {
    throw new Error(`Test Channel effect ${trackId}/${insertIndex} is missing.`);
  }

  channel.inserts[insertIndex] = {
    ...effect,
    bypass: false,
    parameters: { ...effect.parameters, ...parameterOverrides },
  };
}

function enableMasterEffect(plan, insertIndex, parameterOverrides) {
  const effect = plan.mixerSnapshot.master.inserts[insertIndex];

  if (!effect) {
    throw new Error(`Test Master effect ${insertIndex} is missing.`);
  }

  plan.mixerSnapshot.master.inserts[insertIndex] = {
    ...effect,
    bypass: false,
    parameters: { ...effect.parameters, ...parameterOverrides },
  };
}

function createTrack({ events, gainDb = 0, pan = 0, trackId = 'track-1' }) {
  return {
    events,
    gainDb,
    pan,
    trackId,
  };
}

function createEvent({
  clipId = 'clip-1',
  durationSeconds,
  sourceId,
  sourceStartSeconds = 0,
  startOffsetSeconds = 0,
}) {
  const timelineStartTick = secondsToTestTimelineTicks(
    startOffsetSeconds,
    true,
  );
  return {
    clipId,
    clipName: clipId,
    durationSeconds,
    sourceId,
    sourceStartSeconds,
    startOffsetSeconds,
    timelineEndTick:
      timelineStartTick + secondsToTestTimelineTicks(durationSeconds),
    timelineStartTick,
  };
}

function secondsToTestTimelineTicks(seconds, allowZero = false) {
  const ticks = Math.round(
    (seconds * TEST_BPM * TEST_TIMELINE_TICKS_PER_BEAT) / 60,
  );
  return allowZero ? Math.max(0, ticks) : Math.max(1, ticks);
}

function generatedDescriptor(sourceId, bytes) {
  return {
    kind: 'generated',
    name: `${sourceId}.wav`,
    relativePath: `stable-audio-3/${sourceId}.wav`,
    sizeBytes: bytes.byteLength,
    sourceId,
  };
}

function externalDescriptor(sourceId, bytes) {
  return {
    kind: 'external',
    lastModified: 1_786_150_800_000,
    name: `${sourceId}.wav`,
    path: `D:\\Audio\\${sourceId}.wav`,
    sizeBytes: bytes.byteLength,
    sourceId,
  };
}

function createPcm16Wave({
  extraChunks = [],
  frames,
  sampleRate = OUTPUT_SAMPLE_RATE,
} = {}) {
  const channels = frames[0]?.length ?? 1;
  const data = Buffer.alloc(frames.length * channels * 2);

  frames.forEach((frame, frameIndex) => {
    if (frame.length !== channels) {
      throw new Error('Test PCM frames must use one consistent channel count.');
    }

    frame.forEach((sample, channel) => {
      data.writeInt16LE(sample, (frameIndex * channels + channel) * 2);
    });
  });

  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(channels, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(sampleRate * channels * 2, 8);
  format.writeUInt16LE(channels * 2, 12);
  format.writeUInt16LE(16, 14);
  const chunks = [
    ...extraChunks.map((chunk) => createChunk(chunk.id, chunk.bytes)),
    createChunk('fmt ', format),
    createChunk('data', data),
  ];
  const wave = Buffer.concat([
    Buffer.from('RIFF\0\0\0\0WAVE', 'binary'),
    ...chunks,
  ]);
  wave.writeUInt32LE(wave.byteLength - 8, 4);
  return wave;
}

function createChunk(id, data) {
  const chunk = Buffer.alloc(8 + data.byteLength + (data.byteLength % 2));
  chunk.write(id, 0, 'ascii');
  chunk.writeUInt32LE(data.byteLength, 4);
  data.copy(chunk, 8);
  return chunk;
}

function inspectOutputHeader(bytes) {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
  expect(bytes.readUInt32LE(4) + 8).toBe(bytes.byteLength);
  const channels = bytes.readUInt16LE(22);
  const bitsPerSample = bytes.readUInt16LE(34);
  const dataByteLength = bytes.readUInt32LE(40);
  return {
    bitsPerSample,
    channels,
    dataByteLength,
    frameCount: dataByteLength / (channels * (bitsPerSample / 8)),
    sampleRate: bytes.readUInt32LE(24),
  };
}

function readOutputFrames(bytes) {
  const { frameCount } = inspectOutputHeader(bytes);
  return Array.from({ length: frameCount }, (_, frame) =>
    readOutputFrame(bytes, frame),
  );
}

function readOutputFrame(bytes, frame) {
  return [
    bytes.readInt16LE(44 + frame * 4),
    bytes.readInt16LE(46 + frame * 4),
  ];
}

function expectRenderError(callback, code) {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectPcmMixdownRenderError);
    expect(error).toMatchObject({ code });
    return;
  }

  throw new Error(`Expected Mixdown render failure ${code}.`);
}
