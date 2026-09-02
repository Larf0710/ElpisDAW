import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_DENORMAL_THRESHOLD,
  MIXER_EQUALIZER_DEFAULT_PARAMETERS,
  createMixerCompressorEffect,
  createMixerEqualizerEffect,
} from './mixerEffectsContract.js';
import {
  MIXER_COMPRESSOR_COEFFICIENT_VERSION,
  MIXER_COMPRESSOR_PROCESSOR_STATE_VERSION,
  createMixerCompressorProcessor,
  processMixerCompressorBlock,
  resetMixerCompressorProcessor,
  type MixerCompressorProcessor,
} from './mixerCompressorKernel.js';
import {
  createMixerEqualizerProcessor,
  processMixerEqualizerBlock,
} from './mixerEqualizerKernel.js';

function enabledEffect(
  overrides: Partial<typeof MIXER_COMPRESSOR_DEFAULT_PARAMETERS> = {},
) {
  return createMixerCompressorEffect(
    { ...MIXER_COMPRESSOR_DEFAULT_PARAMETERS, ...overrides },
    false,
  );
}

function freezeProcessor(
  processor: MixerCompressorProcessor,
  overrides: Partial<MixerCompressorProcessor>,
): MixerCompressorProcessor {
  return Object.freeze({
    ...processor,
    ...overrides,
  }) as MixerCompressorProcessor;
}

function processSingleLevel(
  level: number,
  overrides: Partial<typeof MIXER_COMPRESSOR_DEFAULT_PARAMETERS>,
) {
  return processMixerCompressorBlock(
    createMixerCompressorProcessor(enabledEffect(overrides)),
    [level],
    [0],
  );
}

function adjacentPositiveFloat32(value: number, direction: -1 | 1) {
  const float = new Float32Array([value]);
  const bits = new Uint32Array(float.buffer);
  bits[0] += direction;
  return float[0];
}

describe('Mixer linked-peak Compressor kernel v1', () => {
  it('creates deeply immutable versioned coefficients and zero reduction state', () => {
    const processor = createMixerCompressorProcessor(enabledEffect());

    expect(processor.contractVersion).toBe(MIXER_EFFECTS_CONTRACT_VERSION);
    expect(processor.coefficients).toEqual({
      attack: 0.9977350234985352,
      release: 0.9997732639312744,
      version: MIXER_COMPRESSOR_COEFFICIENT_VERSION,
    });
    expect(processor.state).toEqual({
      reductionDb: 0,
      version: MIXER_COMPRESSOR_PROCESSOR_STATE_VERSION,
    });
    expect(Object.isFrozen(processor)).toBe(true);
    expect(Object.isFrozen(processor.effect)).toBe(true);
    expect(Object.isFrozen(processor.effect.parameters)).toBe(true);
    expect(Object.isFrozen(processor.coefficients)).toBe(true);
    expect(Object.isFrozen(processor.state)).toBe(true);
    expect(Math.fround(processor.coefficients.attack)).toBe(
      processor.coefficients.attack,
    );
    expect(Math.fround(processor.coefficients.release)).toBe(
      processor.coefficients.release,
    );
  });

  it('locks coefficient construction at every time-range boundary', () => {
    const fastestAttack = createMixerCompressorProcessor(
      enabledEffect({ attackMs: 0.1 }),
    );
    const slowestAttack = createMixerCompressorProcessor(
      enabledEffect({ attackMs: 100 }),
    );
    const fastestRelease = createMixerCompressorProcessor(
      enabledEffect({ releaseMs: 10 }),
    );
    const slowestRelease = createMixerCompressorProcessor(
      enabledEffect({ releaseMs: 1_000 }),
    );

    expect(fastestAttack.coefficients.attack).toBe(0.7971141338348389);
    expect(slowestAttack.coefficients.attack).toBe(0.9997732639312744);
    expect(fastestRelease.coefficients.release).toBe(0.9977350234985352);
    expect(slowestRelease.coefficients.release).toBe(0.9999773502349854);
  });

  it('preserves silence, signed samples, and unity transfer when ratio is one', () => {
    const processor = createMixerCompressorProcessor(
      enabledEffect({ ratio: 1, thresholdDb: -60, kneeDb: 24 }),
    );
    const left = new Float64Array([0, -0, 0.25, -0.5, 1]);
    const right = new Float64Array([-1, 0.5, -0.25, 0, -0]);
    const result = processMixerCompressorBlock(processor, left, right);

    expect(Array.from(result.leftSamples)).toEqual([0, -0, 0.25, -0.5, 1]);
    expect(Array.from(result.rightSamples)).toEqual([-1, 0.5, -0.25, 0, -0]);
    expect(Object.is(result.leftSamples[1], -0)).toBe(true);
    expect(Object.is(result.rightSamples[4], -0)).toBe(true);
    expect(result.processor.state.reductionDb).toBe(0);

    const silence = processMixerCompressorBlock(
      createMixerCompressorProcessor(enabledEffect()),
      new Float32Array(16),
      new Float32Array(16),
    );
    expect(Array.from(silence.leftSamples)).toEqual(new Array(16).fill(0));
    expect(Array.from(silence.rightSamples)).toEqual(new Array(16).fill(0));
    expect(silence.processor.state.reductionDb).toBe(0);
  });

  it('uses a hard-knee threshold boundary with no attenuation at equality', () => {
    const parameters = {
      attackMs: 0.1,
      kneeDb: 0,
      ratio: 4,
      thresholdDb: 0,
    };
    const atThreshold = processSingleLevel(1, parameters);
    const aboveThreshold = processSingleLevel(1.25, parameters);

    expect(atThreshold.processor.state.reductionDb).toBe(0);
    expect(atThreshold.leftSamples[0]).toBe(1);
    expect(aboveThreshold.processor.state.reductionDb).toBeLessThan(0);
    expect(aboveThreshold.leftSamples[0]).toBeLessThan(1.25);
  });

  it('keeps the quadratic soft knee continuous at lower, center, and upper boundaries', () => {
    const thresholdDb = Math.fround(20 * Math.log10(0.5));
    const parameters = {
      kneeDb: -2 * thresholdDb,
      ratio: 4,
      thresholdDb,
    };
    const lowerBelow = processSingleLevel(
      adjacentPositiveFloat32(0.25, -1),
      parameters,
    );
    const lower = processSingleLevel(0.25, parameters);
    const lowerAbove = processSingleLevel(
      adjacentPositiveFloat32(0.25, 1),
      parameters,
    );
    const center = processSingleLevel(0.5, parameters);
    const upperBelow = processSingleLevel(
      adjacentPositiveFloat32(1, -1),
      parameters,
    );
    const upper = processSingleLevel(1, parameters);
    const upperAbove = processSingleLevel(
      adjacentPositiveFloat32(1, 1),
      parameters,
    );

    expect(lowerBelow.processor.state.reductionDb).toBe(0);
    expect(lower.processor.state.reductionDb).toBe(0);
    expect(lowerAbove.processor.state.reductionDb).toBe(
      -6.41542423378162e-17,
    );
    expect(center.processor.state.reductionDb).toBe(
      -0.0025568469427525997,
    );
    expect(upper.processor.state.reductionDb).toBe(
      -0.010227387771010399,
    );
    expect(
      Math.abs(
        upper.processor.state.reductionDb -
          upperBelow.processor.state.reductionDb,
      ),
    ).toBeLessThan(2e-9);
    expect(
      Math.abs(
        upperAbove.processor.state.reductionDb -
          upper.processor.state.reductionDb,
      ),
    ).toBeLessThan(2e-9);
  });

  it('selects attack toward more attenuation and release toward less attenuation', () => {
    const processor = createMixerCompressorProcessor(enabledEffect());
    const firstAttack = processMixerCompressorBlock(processor, [1], [0]);
    const secondAttack = processMixerCompressorBlock(
      firstAttack.processor,
      [1],
      [0],
    );
    const release = processMixerCompressorBlock(
      secondAttack.processor,
      [0],
      [0],
    );

    expect(processor.coefficients.attack).toBeLessThan(
      processor.coefficients.release,
    );
    expect(firstAttack.processor.state.reductionDb).toBeLessThan(0);
    expect(secondAttack.processor.state.reductionDb).toBeLessThan(
      firstAttack.processor.state.reductionDb,
    );
    expect(release.processor.state.reductionDb).toBeGreaterThan(
      secondAttack.processor.state.reductionDb,
    );
    expect(release.processor.state.reductionDb).toBeLessThan(0);
  });

  it('links the detector and gain across stereo without channel-independent gain', () => {
    const leftDriven = processMixerCompressorBlock(
      createMixerCompressorProcessor(
        enabledEffect({ attackMs: 0.1, kneeDb: 0, thresholdDb: -24 }),
      ),
      [1],
      [0.25],
    );
    const rightDriven = processMixerCompressorBlock(
      createMixerCompressorProcessor(
        enabledEffect({ attackMs: 0.1, kneeDb: 0, thresholdDb: -24 }),
      ),
      [0],
      [1],
    );

    expect(leftDriven.leftSamples[0]).toBeLessThan(1);
    expect(leftDriven.rightSamples[0]).toBe(
      Math.fround(leftDriven.leftSamples[0] * 0.25),
    );
    expect(rightDriven.leftSamples[0]).toBe(0);
    expect(rightDriven.rightSamples[0]).toBe(leftDriven.leftSamples[0]);
    expect(rightDriven.processor.state).toEqual(leftDriven.processor.state);
  });

  it('applies makeup gain without clipping, clamping, or hidden normalization', () => {
    const result = processMixerCompressorBlock(
      createMixerCompressorProcessor(
        enabledEffect({ makeupGainDb: 24, ratio: 1 }),
      ),
      [0.5],
      [-0.5],
    );
    const expectedGain = Math.fround(10 ** (24 / 20));

    expect(result.leftSamples[0]).toBe(Math.fround(0.5 * expectedGain));
    expect(result.rightSamples[0]).toBe(Math.fround(-0.5 * expectedGain));
    expect(result.leftSamples[0]).toBeGreaterThan(1);
    expect(result.rightSamples[0]).toBeLessThan(-1);
  });

  it('keeps BYPASS byte-transparent and cannot advance processor state', () => {
    const processor = createMixerCompressorProcessor(
      createMixerCompressorEffect(
        { ...MIXER_COMPRESSOR_DEFAULT_PARAMETERS, makeupGainDb: 24 },
        true,
      ),
    );
    const left = new Float32Array([0, -0, 0.25, -0.5, 1]);
    const right = new Float64Array([1, -1, 0.125, -0.25, 0]);
    const leftBytes = new Uint8Array(left.buffer.slice(0));
    const rightBytes = new Uint8Array(right.buffer.slice(0));
    const result = processMixerCompressorBlock(processor, left, right);

    expect(result.leftSamples).toBe(left);
    expect(result.rightSamples).toBe(right);
    expect(result.processor).toBe(processor);
    expect(new Uint8Array(left.buffer)).toEqual(leftBytes);
    expect(new Uint8Array(right.buffer)).toEqual(rightBytes);
    expect(result.processor.state.reductionDb).toBe(0);
  });

  it('is invariant to valid block partitioning', () => {
    const effect = enabledEffect({
      attackMs: 3,
      kneeDb: 8,
      makeupGainDb: 2,
      ratio: 6,
      releaseMs: 250,
      thresholdDb: -20,
    });
    const left = [0.25, -0.5, 0.75, -1, 0.125, 0.5, -0.25];
    const right = [-0.125, 0.25, -0.375, 0.5, -0.75, 1, 0.125];
    const single = processMixerCompressorBlock(
      createMixerCompressorProcessor(effect),
      left,
      right,
    );

    let partitionedProcessor = createMixerCompressorProcessor(effect);
    const partitionedLeft: number[] = [];
    const partitionedRight: number[] = [];
    for (const [start, end] of [
      [0, 1],
      [1, 4],
      [4, 5],
      [5, 7],
    ] as const) {
      const block = processMixerCompressorBlock(
        partitionedProcessor,
        left.slice(start, end),
        right.slice(start, end),
      );
      partitionedLeft.push(...block.leftSamples);
      partitionedRight.push(...block.rightSamples);
      partitionedProcessor = block.processor;
    }

    expect(partitionedLeft).toEqual(Array.from(single.leftSamples));
    expect(partitionedRight).toEqual(Array.from(single.rightSamples));
    expect(partitionedProcessor.state).toEqual(single.processor.state);
  });

  it('produces identical repeated runs and deterministic reset with no tail', () => {
    const effect = enabledEffect({ ratio: 10, thresholdDb: -24 });
    const left = new Float64Array([1, 0.5, -0.25, 0, 0.125]);
    const right = new Float64Array([-0.5, 0.25, 1, -1, 0]);
    const first = processMixerCompressorBlock(
      createMixerCompressorProcessor(effect),
      left,
      right,
    );
    const second = processMixerCompressorBlock(
      createMixerCompressorProcessor(effect),
      left,
      right,
    );

    expect(Array.from(second.leftSamples)).toEqual(Array.from(first.leftSamples));
    expect(Array.from(second.rightSamples)).toEqual(
      Array.from(first.rightSamples),
    );
    expect(second.processor.state).toEqual(first.processor.state);
    expect(resetMixerCompressorProcessor(first.processor)).toEqual(
      createMixerCompressorProcessor(effect),
    );
  });

  it('rejects whole invalid blocks and malformed state atomically', () => {
    const processor = createMixerCompressorProcessor(enabledEffect());
    const originalState = processor.state;

    expect(() =>
      processMixerCompressorBlock(processor, [1, Number.NaN], [0, 0]),
    ).toThrow(RangeError);
    expect(() =>
      processMixerCompressorBlock(
        processor,
        [0, 0],
        [0, Number.POSITIVE_INFINITY],
      ),
    ).toThrow(RangeError);
    expect(() =>
      processMixerCompressorBlock(processor, [Number.MAX_VALUE], [0]),
    ).toThrow(RangeError);
    expect(processor.state).toBe(originalState);
    expect(processor.state.reductionDb).toBe(0);

    for (const reductionDb of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1,
      -1e-21,
    ]) {
      const invalidState = Object.freeze({
        reductionDb,
        version: MIXER_COMPRESSOR_PROCESSOR_STATE_VERSION,
      });
      expect(() =>
        processMixerCompressorBlock(
          freezeProcessor(processor, { state: invalidState } as never),
          [0],
          [0],
        ),
      ).toThrow(TypeError);
    }

    for (const invalidState of [
      Object.freeze({ reductionDb: 0, version: 2 }),
      Object.freeze({ extra: 0, reductionDb: 0, version: 1 }),
    ]) {
      expect(() =>
        processMixerCompressorBlock(
          freezeProcessor(processor, { state: invalidState } as never),
          [0],
          [0],
        ),
      ).toThrow(TypeError);
    }

    const invalidCoefficients = Object.freeze({
      ...processor.coefficients,
      attack: Number.POSITIVE_INFINITY,
    });
    expect(() =>
      processMixerCompressorBlock(
        freezeProcessor(processor, {
          coefficients: invalidCoefficients,
        } as never),
        [0],
        [0],
      ),
    ).toThrow(TypeError);

    expect(() =>
      createMixerCompressorProcessor(
        createMixerEqualizerEffect(
          MIXER_EQUALIZER_DEFAULT_PARAMETERS,
          false,
        ) as never,
      ),
    ).toThrow(TypeError);
  });

  it('canonicalizes released persistent state below the denormal threshold', () => {
    const processor = createMixerCompressorProcessor(enabledEffect());
    const nearThresholdState = Object.freeze({
      reductionDb: Math.fround(-1.0000001e-20),
      version: MIXER_COMPRESSOR_PROCESSOR_STATE_VERSION,
    });
    expect(Math.abs(nearThresholdState.reductionDb)).toBeGreaterThanOrEqual(
      MIXER_EFFECTS_DENORMAL_THRESHOLD,
    );

    const result = processMixerCompressorBlock(
      freezeProcessor(processor, { state: nearThresholdState }),
      [0],
      [0],
    );
    expect(result.processor.state.reductionDb).toBe(0);
    expect(Object.is(result.processor.state.reductionDb, -0)).toBe(false);
  });

  it.each([
    [
      'default soft-knee linked peak',
      MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
      [0, 0.125, -0.25, 0.5, 1, -1, 0.25, 0],
      [0, -0.5, 0.125, 0, -0.75, 0.5, -0.25, 0],
      [
        0, 0.12470748275518417, -0.24912579357624054, 0.49708956480026245,
        0.9906985759735107, -0.9872379899024963, 0.2465292066335678, 0,
      ],
      [
        0, -0.4988299310207367, 0.12456289678812027, 0,
        -0.7430239319801331, 0.49361899495124817, -0.2465292066335678, 0,
      ],
      -0.12140484899282455,
    ],
    [
      'hard-knee fast attack with makeup',
      {
        ...MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
        attackMs: 1,
        kneeDb: 0,
        makeupGainDb: 3,
        ratio: 8,
        releaseMs: 250,
        thresholdDb: -12,
      },
      [0.1, -0.2, 0.4, -0.8, 1.2, -0.6, 0.3, 0],
      [-0.05, 0.1, -0.9, 0.2, -0.4, 1.1, -0.2, 0],
      [
        0.1412537544965744, -0.2825075089931488, 0.551044762134552,
        -1.0779311656951904, 1.5697036981582642, -0.7637528777122498,
        0.38143742084503174, 0,
      ],
      [
        -0.0706268772482872, 0.1412537544965744, -1.239850640296936,
        0.2694827914237976, -0.5232345461845398, 1.400213599205017,
        -0.2542916238307953, 0,
      ],
      -0.9138765931129456,
    ],
  ] as const)(
    'matches the independent Float32 transfer/smoothing reference for %s',
    (
      _name,
      parameters,
      left,
      right,
      expectedLeft,
      expectedRight,
      expectedState,
    ) => {
      // These fixed vectors were independently reproduced with .NET Math and
      // System.Single at the documented stage boundaries. They are regression
      // data rather than a second implementation of the kernel equations.
      const result = processMixerCompressorBlock(
        createMixerCompressorProcessor(
          createMixerCompressorEffect(parameters, false),
        ),
        left,
        right,
      );

      expect(Array.from(result.leftSamples)).toEqual(expectedLeft);
      expect(Array.from(result.rightSamples)).toEqual(expectedRight);
      expect(result.processor.state.reductionDb).toBe(expectedState);
    },
  );

  it('keeps declaration exports, readonly shapes, and runtime exports aligned', () => {
    const declarationSource = readFileSync(
      new URL('./mixerCompressorKernel.d.ts', import.meta.url),
      'utf8',
    );
    const contractDeclarationSource = readFileSync(
      new URL('./mixerEffectsContract.d.ts', import.meta.url),
      'utf8',
    );

    expect(declarationSource).toMatch(
      /MIXER_COMPRESSOR_COEFFICIENT_VERSION: 1/,
    );
    expect(declarationSource).toMatch(
      /MIXER_COMPRESSOR_PROCESSOR_STATE_VERSION: 1/,
    );
    expect(declarationSource).toContain(
      'export function createMixerCompressorProcessor',
    );
    expect(declarationSource).toContain(
      'export function processMixerCompressorBlock',
    );
    expect(declarationSource).toContain(
      'export function resetMixerCompressorProcessor',
    );
    expect(
      declarationSource.match(/Readonly</g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(contractDeclarationSource).toContain(
      "MIXER_EFFECT_TYPE_COMPRESSOR: 'compressor'",
    );
    expect(contractDeclarationSource).toContain(
      "'humstudio.compressor.linked-peak.v1'",
    );
  });

  it('imports without browser globals, Node APIs, or Web Audio built-ins', () => {
    const source = readFileSync(
      new URL('./mixerCompressorKernel.js', import.meta.url),
      'utf8',
    );
    const forbiddenRuntimeDependency =
      /(?:from\s+['"]node:|require\s*\(|\bwindow\b|\bdocument\b|\bAudioContext\b|\bAudioWorkletNode\b|\bAnalyserNode\b|\bBuffer\b)/;

    expect(source).not.toMatch(forbiddenRuntimeDependency);
    expect(source.match(/from\s+['"][^'"]+['"]/g)).toEqual([
      "from './mixerEffectsContract.js'",
    ]);
  });

  it('preserves the committed Equalizer contract and impulse output', () => {
    const impulse = new Float64Array([1, 0, 0, 0]);
    const result = processMixerEqualizerBlock(
      createMixerEqualizerProcessor(
        createMixerEqualizerEffect(
          { ...MIXER_EQUALIZER_DEFAULT_PARAMETERS, lowGainDb: 6 },
          false,
        ),
      ),
      impulse,
      new Float64Array(impulse.length),
    );

    expect(Array.from(result.leftSamples)).toEqual([
      1.0042049884796143,
      0.008426356129348278,
      0.008457980118691921,
      0.008487233892083168,
    ]);
    expect(Array.from(result.rightSamples)).toEqual([0, 0, 0, 0]);
  });
});
