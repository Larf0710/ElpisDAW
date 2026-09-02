import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
  MIXER_ECHO_DELAY_DEFAULT_PARAMETERS,
  MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT,
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EQUALIZER_DEFAULT_PARAMETERS,
  MIXER_LIMITER_DEFAULT_PARAMETERS,
  createMixerCompressorEffect,
  createMixerEchoDelayEffect,
  createMixerEqualizerEffect,
  createMixerLimiterEffect,
} from './mixerEffectsContract.js';
import {
  createMixerCompressorProcessor,
  processMixerCompressorBlock,
} from './mixerCompressorKernel.js';
import {
  MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES,
  MIXER_ECHO_DELAY_COEFFICIENT_VERSION,
  MIXER_ECHO_DELAY_FAILURE_RULE_VERSION,
  MIXER_ECHO_DELAY_INTERPOLATION_GUARD_SAMPLES,
  MIXER_ECHO_DELAY_INTERPOLATION_VERSION,
  MIXER_ECHO_DELAY_MAX_DELAY_SAMPLES,
  MIXER_ECHO_DELAY_PROCESSOR_STATE_VERSION,
  MIXER_ECHO_DELAY_RUNTIME_BYTES_PER_PROCESSOR,
  createMixerEchoDelayProcessor,
  processMixerEchoDelayBlock,
  resetMixerEchoDelayProcessor,
  type MixerEchoDelayProcessor,
} from './mixerEchoDelayKernel.js';
import {
  createMixerEqualizerProcessor,
  processMixerEqualizerBlock,
} from './mixerEqualizerKernel.js';
import {
  createMixerLimiterProcessor,
  processMixerLimiterBlock,
} from './mixerLimiterKernel.js';

function enabledEffect(
  overrides: Partial<typeof MIXER_ECHO_DELAY_DEFAULT_PARAMETERS> = {},
) {
  return createMixerEchoDelayEffect(
    { ...MIXER_ECHO_DELAY_DEFAULT_PARAMETERS, ...overrides },
    false,
  );
}

function frozenProcessor(
  processor: MixerEchoDelayProcessor,
  overrides: Partial<MixerEchoDelayProcessor>,
): MixerEchoDelayProcessor {
  return Object.freeze({
    ...processor,
    ...overrides,
  }) as MixerEchoDelayProcessor;
}

function processInPartitions(
  leftSamples: Float32Array,
  rightSamples: Float32Array,
  partitionSizes: readonly number[],
) {
  let processor = createMixerEchoDelayProcessor(
    enabledEffect({ delayTimeMs: 10.5, dry: 0.75, feedback: 0.5, wet: 0.6 }),
  );
  const leftOutput = new Float32Array(leftSamples.length);
  const rightOutput = new Float32Array(rightSamples.length);
  let offset = 0;

  for (const size of partitionSizes) {
    const end = Math.min(offset + size, leftSamples.length);
    const result = processMixerEchoDelayBlock(
      processor,
      leftSamples.subarray(offset, end),
      rightSamples.subarray(offset, end),
    );
    leftOutput.set(result.leftSamples, offset);
    rightOutput.set(result.rightSamples, offset);
    processor = result.processor;
    offset = end;
  }

  if (offset < leftSamples.length) {
    const result = processMixerEchoDelayBlock(
      processor,
      leftSamples.subarray(offset),
      rightSamples.subarray(offset),
    );
    leftOutput.set(result.leftSamples, offset);
    rightOutput.set(result.rightSamples, offset);
    processor = result.processor;
  }

  return { leftOutput, processor, rightOutput };
}

describe('Mixer stereo feedback Echo/Delay kernel v1', () => {
  it('creates immutable versioned coefficients, zero state, and bounded private storage', () => {
    const processor = createMixerEchoDelayProcessor(enabledEffect());

    expect(processor.contractVersion).toBe(MIXER_EFFECTS_CONTRACT_VERSION);
    expect(processor.coefficients).toEqual({
      bufferCapacitySamples: 88_201,
      delayFraction: 0,
      delaySamples: 11_025,
      delayWholeSamples: 11_025,
      dry: 1,
      feedback: 0.30000001192092896,
      newerWeight: 1,
      version: MIXER_ECHO_DELAY_COEFFICIENT_VERSION,
      wet: 0.25,
    });
    expect(processor.state).toEqual({
      version: MIXER_ECHO_DELAY_PROCESSOR_STATE_VERSION,
      writeIndex: 0,
    });
    expect(MIXER_ECHO_DELAY_INTERPOLATION_VERSION).toBe(1);
    expect(MIXER_ECHO_DELAY_FAILURE_RULE_VERSION).toBe(1);
    expect(MIXER_ECHO_DELAY_MAX_DELAY_SAMPLES).toBe(88_200);
    expect(MIXER_ECHO_DELAY_INTERPOLATION_GUARD_SAMPLES).toBe(1);
    expect(MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES).toBe(88_201);
    expect(MIXER_ECHO_DELAY_RUNTIME_BYTES_PER_PROCESSOR).toBe(705_608);
    expect(MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT).toEqual({
      effectType: 'echo-delay',
      enabledChainPosition: 'after-compressor',
      insertTarget: 'channel',
      version: 1,
    });
    expect(Object.isFrozen(processor)).toBe(true);
    expect(Object.isFrozen(processor.coefficients)).toBe(true);
    expect(Object.isFrozen(processor.effect)).toBe(true);
    expect(Object.isFrozen(processor.effect.parameters)).toBe(true);
    expect(Object.isFrozen(processor.state)).toBe(true);
    expect(Object.keys(processor.state).sort()).toEqual([
      'version',
      'writeIndex',
    ]);
  });

  it('rejects unsupported sample rates and non-Echo/Delay identities', () => {
    expect(() =>
      createMixerEchoDelayProcessor(enabledEffect(), 48_000),
    ).toThrow(RangeError);
    expect(() =>
      createMixerEchoDelayProcessor(enabledEffect(), Number.NaN),
    ).toThrow(RangeError);
    expect(() =>
      createMixerEchoDelayProcessor(
        createMixerLimiterEffect(MIXER_LIMITER_DEFAULT_PARAMETERS, false) as never,
      ),
    ).toThrow(TypeError);
  });

  it('keeps silence at zero with independent stereo state', () => {
    const result = processMixerEchoDelayBlock(
      createMixerEchoDelayProcessor(enabledEffect()),
      new Float32Array(2_000),
      new Float32Array(2_000),
    );

    expect(result.leftSamples.every((sample) => sample === 0)).toBe(true);
    expect(result.rightSamples.every((sample) => sample === 0)).toBe(true);
    expect(result.processor.state.writeIndex).toBe(2_000);
  });

  it('places integer-delay impulses and feedback repeats at exact frames', () => {
    const length = 1_324;
    const left = new Float32Array(length);
    left[0] = 1;
    const result = processMixerEchoDelayBlock(
      createMixerEchoDelayProcessor(
        enabledEffect({
          delayTimeMs: 10,
          dry: 0,
          feedback: 0.5,
          wet: 1,
        }),
      ),
      left,
      new Float32Array(length),
    );

    expect(result.leftSamples[0]).toBe(0);
    expect(result.leftSamples[440]).toBe(0);
    expect(result.leftSamples[441]).toBe(1);
    expect(result.leftSamples[442]).toBe(0);
    expect(result.leftSamples[882]).toBe(0.5);
    expect(result.leftSamples[1_323]).toBe(0.25);
    expect(result.rightSamples.every((sample) => sample === 0)).toBe(true);
  });

  it('matches an independently derived fractional-delay impulse reference', () => {
    const length = 466;
    const left = new Float32Array(length);
    left[0] = 1;
    const result = processMixerEchoDelayBlock(
      createMixerEchoDelayProcessor(
        enabledEffect({
          delayTimeMs: 10.5,
          dry: 0,
          feedback: 0,
          wet: 1,
        }),
      ),
      left,
      new Float32Array(length),
    );

    // 10.5 ms at 44.1 kHz becomes Float32 463.04998779296875 samples.
    // An impulse therefore contributes 0.95001220703125 at frame 463 and
    // 0.04998779296875 at frame 464 under linear interpolation.
    expect(result.processor.coefficients.delaySamples).toBe(
      463.04998779296875,
    );
    expect(result.processor.coefficients.delayFraction).toBe(
      0.04998779296875,
    );
    expect(result.leftSamples[462]).toBe(0);
    expect(result.leftSamples[463]).toBe(0.95001220703125);
    expect(result.leftSamples[464]).toBe(0.04998779296875);
    expect(result.leftSamples[465]).toBe(0);
  });

  it('keeps left and right rings independent with no crossfeed', () => {
    const length = 900;
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    left[0] = 1;
    right[1] = -0.5;
    const result = processMixerEchoDelayBlock(
      createMixerEchoDelayProcessor(
        enabledEffect({ delayTimeMs: 10, dry: 0, feedback: 0, wet: 1 }),
      ),
      left,
      right,
    );

    expect(result.leftSamples[441]).toBe(1);
    expect(result.leftSamples[442]).toBe(0);
    expect(result.rightSamples[441]).toBe(0);
    expect(result.rightSamples[442]).toBe(-0.5);
  });

  it.each([
    [0, 0, 0, 0],
    [1, 0, 2, 0],
    [0, 1, 0, 2],
    [1, 1, 2, 2],
  ] as const)(
    'applies dry=%s wet=%s without hidden normalization',
    (dry, wet, expectedDirect, expectedEcho) => {
      const length = 442;
      const left = new Float32Array(length);
      left[0] = 2;
      const result = processMixerEchoDelayBlock(
        createMixerEchoDelayProcessor(
          enabledEffect({
            delayTimeMs: 10,
            dry,
            feedback: 0,
            wet,
          }),
        ),
        left,
        new Float32Array(length),
      );

      expect(result.leftSamples[0]).toBe(expectedDirect);
      expect(result.leftSamples[441]).toBe(expectedEcho);
    },
  );

  it('does not clamp finite over-full-scale dry plus wet output', () => {
    const length = 442;
    const left = new Float32Array(length);
    left[0] = 2;
    left[441] = 2;
    const result = processMixerEchoDelayBlock(
      createMixerEchoDelayProcessor(
        enabledEffect({ delayTimeMs: 10, dry: 1, feedback: 0, wet: 1 }),
      ),
      left,
      new Float32Array(length),
    );

    expect(result.leftSamples[0]).toBe(2);
    expect(result.leftSamples[441]).toBe(4);
  });

  it('supports the minimum and maximum delays and crosses the ring boundary', () => {
    const minimum = new Float32Array(442);
    minimum[0] = 1;
    const minimumResult = processMixerEchoDelayBlock(
      createMixerEchoDelayProcessor(
        enabledEffect({ delayTimeMs: 10, dry: 0, feedback: 0, wet: 1 }),
      ),
      minimum,
      new Float32Array(minimum.length),
    );
    expect(minimumResult.leftSamples[441]).toBe(1);

    const maximum = new Float32Array(
      MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES + 2,
    );
    maximum[0] = 1;
    const maximumResult = processMixerEchoDelayBlock(
      createMixerEchoDelayProcessor(
        enabledEffect({ delayTimeMs: 2_000, dry: 0, feedback: 0, wet: 1 }),
      ),
      maximum,
      new Float32Array(maximum.length),
    );
    expect(maximumResult.processor.coefficients.delaySamples).toBe(88_200);
    expect(maximumResult.leftSamples[88_199]).toBe(0);
    expect(maximumResult.leftSamples[88_200]).toBe(1);
    expect(maximumResult.processor.state.writeIndex).toBe(2);
  });

  it('has zero dry latency and truncates pending tail on reset or operation end', () => {
    const first = new Float32Array(100);
    first[0] = 1;
    const initialProcessor = createMixerEchoDelayProcessor(
      enabledEffect({ delayTimeMs: 10, dry: 1, feedback: 0.5, wet: 1 }),
    );
    const direct = processMixerEchoDelayBlock(
      initialProcessor,
      first,
      new Float32Array(first.length),
    );
    expect(direct.leftSamples[0]).toBe(1);
    expect(direct.leftSamples.length).toBe(100);

    const reset = resetMixerEchoDelayProcessor(direct.processor);
    const afterReset = processMixerEchoDelayBlock(
      reset,
      new Float32Array(500),
      new Float32Array(500),
    );
    expect(afterReset.leftSamples.every((sample) => sample === 0)).toBe(true);
    expect(afterReset.rightSamples.every((sample) => sample === 0)).toBe(true);
  });

  it('keeps BYPASS sample-transparent without state or ownership advance', () => {
    const processor = createMixerEchoDelayProcessor(
      createMixerEchoDelayEffect(MIXER_ECHO_DELAY_DEFAULT_PARAMETERS, true),
    );
    const left = new Float64Array([0, 1, -2, 3]);
    const right = new Float32Array([4, -5, 6, -7]);
    const first = processMixerEchoDelayBlock(processor, left, right);
    const second = processMixerEchoDelayBlock(processor, left, right);

    expect(first.leftSamples).toBe(left);
    expect(first.rightSamples).toBe(right);
    expect(first.processor).toBe(processor);
    expect(second.processor).toBe(processor);
    expect(processor.state.writeIndex).toBe(0);
  });

  it('is deterministic across reset, repeated runs, and valid partitions', () => {
    const length = 2_000;
    const left = Float32Array.from(
      { length },
      (_, index) => Math.fround(((index * 17) % 29 - 14) / 16),
    );
    const right = Float32Array.from(
      { length },
      (_, index) => Math.fround(((index * 11) % 23 - 11) / 12),
    );
    const single = processInPartitions(left, right, [length]);
    const partitioned = processInPartitions(
      left,
      right,
      [1, 127, 335, 1, 463, 256, 817],
    );
    const repeated = processInPartitions(left, right, [length]);

    expect(partitioned.leftOutput).toEqual(single.leftOutput);
    expect(partitioned.rightOutput).toEqual(single.rightOutput);
    expect(partitioned.processor.state).toEqual(single.processor.state);
    expect(repeated.leftOutput).toEqual(single.leftOutput);
    expect(repeated.rightOutput).toEqual(single.rightOutput);

    const reset = resetMixerEchoDelayProcessor(single.processor);
    const resetResult = processMixerEchoDelayBlock(reset, left, right);
    expect(resetResult.leftSamples).toEqual(single.leftOutput);
    expect(resetResult.rightSamples).toEqual(single.rightOutput);
  });

  it('remains partition-invariant across one delay length and a full ring wrap', () => {
    const length = MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES + 500;
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    for (let index = 0; index < length; index += 997) {
      left[index] = Math.fround((index % 7) / 3 - 1);
      right[index] = Math.fround(1 - (index % 11) / 5);
    }

    const single = processInPartitions(left, right, [length]);
    const partitioned = processInPartitions(left, right, [
      441,
      22,
      10_000,
      33_333,
      44_405,
      500,
    ]);

    expect(partitioned.leftOutput).toEqual(single.leftOutput);
    expect(partitioned.rightOutput).toEqual(single.rightOutput);
    expect(partitioned.processor.state).toEqual(single.processor.state);
  });

  it('validates whole blocks atomically and rejects malformed public state', () => {
    const processor = createMixerEchoDelayProcessor(enabledEffect());
    const fresh = createMixerEchoDelayProcessor(enabledEffect());

    expect(() =>
      processMixerEchoDelayBlock(processor, [1, Number.NaN], [0, 0]),
    ).toThrow(RangeError);
    const afterRejected = processMixerEchoDelayBlock(processor, [1, 0], [0, 0]);
    const freshResult = processMixerEchoDelayBlock(fresh, [1, 0], [0, 0]);
    expect(afterRejected.leftSamples).toEqual(freshResult.leftSamples);
    expect(afterRejected.processor.state).toEqual(freshResult.processor.state);

    const base = createMixerEchoDelayProcessor(enabledEffect());
    for (const invalidState of [
      Object.freeze({ version: 1, writeIndex: -1 }),
      Object.freeze({ version: 1, writeIndex: 88_201 }),
      Object.freeze({ version: 1, writeIndex: Number.NaN }),
      Object.freeze({ version: 2, writeIndex: 0 }),
      Object.freeze({ extra: 0, version: 1, writeIndex: 0 }),
    ]) {
      expect(() =>
        processMixerEchoDelayBlock(
          frozenProcessor(base, { state: invalidState } as never),
          [0],
          [0],
        ),
      ).toThrow(TypeError);
    }

    const confusedCoefficients = Object.freeze({
      ...base.coefficients,
      delayFraction: 0.5,
      newerWeight: 0.5,
    });
    const confusedProcessor = frozenProcessor(base, {
      coefficients: confusedCoefficients,
    } as never);
    expect(() =>
      processMixerEchoDelayBlock(confusedProcessor, [0], [0]),
    ).toThrow(TypeError);
    expect(() => resetMixerEchoDelayProcessor(confusedProcessor)).toThrow(
      TypeError,
    );

    expect(() =>
      processMixerEchoDelayBlock(base, [0, 0], [0, Number.POSITIVE_INFINITY]),
    ).toThrow(RangeError);
    expect(() => processMixerEchoDelayBlock(base, [0], [0, 1])).toThrow(
      TypeError,
    );
  });

  it('invalidates partial runtime on unexpected overflow and requires reset', () => {
    const largestFiniteFloat32 = 3.4028234663852886e38;
    const left = new Float32Array(442);
    left[0] = largestFiniteFloat32;
    left[441] = largestFiniteFloat32;
    const processor = createMixerEchoDelayProcessor(
      enabledEffect({ delayTimeMs: 10, dry: 0, feedback: 0.95, wet: 1 }),
    );

    expect(() =>
      processMixerEchoDelayBlock(processor, left, new Float32Array(left.length)),
    ).toThrow(RangeError);
    expect(() => processMixerEchoDelayBlock(processor, [0], [0])).toThrow(
      TypeError,
    );

    const reset = resetMixerEchoDelayProcessor(processor);
    const recovered = processMixerEchoDelayBlock(reset, [0], [0]);
    expect(Array.from(recovered.leftSamples)).toEqual([0]);
    expect(Array.from(recovered.rightSamples)).toEqual([0]);
  });

  it('prevents runtime aliases and rejects reuse of consumed processors', () => {
    const processor = createMixerEchoDelayProcessor(enabledEffect());
    expect('leftBuffer' in processor.state).toBe(false);
    expect('rightBuffer' in processor.state).toBe(false);
    expect(() =>
      ((processor.state as { writeIndex: number }).writeIndex = 10),
    ).toThrow(TypeError);

    const result = processMixerEchoDelayBlock(processor, [1], [0]);
    expect(result.processor).not.toBe(processor);
    expect(() => processMixerEchoDelayBlock(processor, [0], [0])).toThrow(
      TypeError,
    );
    expect(() =>
      processMixerEchoDelayBlock(
        Object.freeze({ ...result.processor }) as MixerEchoDelayProcessor,
        [0],
        [0],
      ),
    ).toThrow(TypeError);
  });

  it('matches independent integer-delay dry/wet/feedback golden landmarks', () => {
    const length = 883;
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    left[0] = 1;
    left[1] = -0.5;
    left[2] = 0.25;
    right[0] = -0.25;
    right[1] = 0.75;
    const result = processMixerEchoDelayBlock(
      createMixerEchoDelayProcessor(
        enabledEffect({
          delayTimeMs: 10,
          dry: 0.75,
          feedback: 0.25,
          wet: 0.5,
        }),
      ),
      left,
      right,
    );

    // These landmarks follow directly from a 441-frame integer delay:
    // direct = 0.75 * input, first echo = 0.5 * input, and the second
    // echo = 0.5 * 0.25 * input. They do not reproduce ring-index formulas.
    expect([
      result.leftSamples[0],
      result.leftSamples[1],
      result.leftSamples[2],
      result.leftSamples[441],
      result.leftSamples[442],
      result.leftSamples[443],
      result.leftSamples[882],
    ]).toEqual([0.75, -0.375, 0.1875, 0.5, -0.25, 0.125, 0.125]);
    expect([
      result.rightSamples[0],
      result.rightSamples[1],
      result.rightSamples[441],
      result.rightSamples[442],
      result.rightSamples[882],
    ]).toEqual([-0.1875, 0.5625, -0.125, 0.375, -0.03125]);
  });

  it('keeps declarations, readonly exports, and environment-neutral imports aligned', () => {
    const declarationSource = readFileSync(
      new URL('./mixerEchoDelayKernel.d.ts', import.meta.url),
      'utf8',
    );
    const contractDeclarationSource = readFileSync(
      new URL('./mixerEffectsContract.d.ts', import.meta.url),
      'utf8',
    );
    const runtimeSource = readFileSync(
      new URL('./mixerEchoDelayKernel.js', import.meta.url),
      'utf8',
    );
    const forbiddenRuntimeDependency =
      /(?:from\s+['"]node:|require\s*\(|\bwindow\b|\bdocument\b|\bAudioContext\b|\bAudioWorkletNode\b|\bAnalyserNode\b|\bBuffer\b)/;

    expect(declarationSource).toContain(
      'MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES: 88_201',
    );
    expect(declarationSource).toContain(
      'MIXER_ECHO_DELAY_RUNTIME_BYTES_PER_PROCESSOR: 705_608',
    );
    expect(declarationSource).toContain(
      'export function createMixerEchoDelayProcessor',
    );
    expect(declarationSource).toContain(
      'export function processMixerEchoDelayBlock',
    );
    expect(declarationSource).toContain(
      'export function resetMixerEchoDelayProcessor',
    );
    expect(declarationSource.match(/Readonly</g)?.length).toBeGreaterThanOrEqual(4);
    expect(contractDeclarationSource).toContain(
      "MIXER_EFFECT_TYPE_ECHO_DELAY: 'echo-delay'",
    );
    expect(contractDeclarationSource).toContain(
      "'humstudio.echo-delay.stereo-feedback.v1'",
    );
    expect(runtimeSource).not.toMatch(forbiddenRuntimeDependency);
    expect(runtimeSource.match(/from\s+['"][^'"]+['"]/g)).toEqual([
      "from './mixerEffectsContract.js'",
    ]);
    const processingLoop = runtimeSource.slice(
      runtimeSource.indexOf('for (let index = 0; index < leftSamples.length'),
      runtimeSource.indexOf('} catch (error)'),
    );
    expect(processingLoop).not.toContain('new ');
  });

  it('preserves committed Equalizer, Compressor, and Limiter golden outputs', () => {
    const equalizerImpulse = new Float64Array([1, 0, 0, 0]);
    const equalizer = processMixerEqualizerBlock(
      createMixerEqualizerProcessor(
        createMixerEqualizerEffect(
          { ...MIXER_EQUALIZER_DEFAULT_PARAMETERS, lowGainDb: 6 },
          false,
        ),
      ),
      equalizerImpulse,
      new Float64Array(equalizerImpulse.length),
    );
    expect(Array.from(equalizer.leftSamples)).toEqual([
      1.0042049884796143,
      0.008426356129348278,
      0.008457980118691921,
      0.008487233892083168,
    ]);

    const compressor = processMixerCompressorBlock(
      createMixerCompressorProcessor(
        createMixerCompressorEffect(
          MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
          false,
        ),
      ),
      [0, 0.125, -0.25, 0.5],
      [0, -0.5, 0.125, 0],
    );
    expect(Array.from(compressor.leftSamples)).toEqual([
      0,
      0.12470748275518417,
      -0.24912579357624054,
      0.49708956480026245,
    ]);

    const limiter = processMixerLimiterBlock(
      createMixerLimiterProcessor(
        createMixerLimiterEffect(MIXER_LIMITER_DEFAULT_PARAMETERS, false),
      ),
      [0, 0.5, 1, 2],
      [0, -0.25, -1.5, 0.25],
    );
    expect(Array.from(limiter.leftSamples)).toEqual([
      0,
      0.5,
      0.6440339088439941,
      0.9660508632659912,
    ]);
    expect(Array.from(limiter.rightSamples)).toEqual([
      0,
      -0.25,
      -0.9660508632659912,
      0.1207563579082489,
    ]);
  });
});
