import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_DENORMAL_THRESHOLD,
  MIXER_EQUALIZER_DEFAULT_PARAMETERS,
  MIXER_LIMITER_DEFAULT_PARAMETERS,
  MIXER_LIMITER_TOPOLOGY_INVARIANT,
  createMixerCompressorEffect,
  createMixerEqualizerEffect,
  createMixerLimiterEffect,
} from './mixerEffectsContract.js';
import {
  createMixerCompressorProcessor,
  processMixerCompressorBlock,
} from './mixerCompressorKernel.js';
import {
  createMixerEqualizerProcessor,
  processMixerEqualizerBlock,
} from './mixerEqualizerKernel.js';
import {
  MIXER_LIMITER_CEILING_GUARD_VERSION,
  MIXER_LIMITER_COEFFICIENT_VERSION,
  MIXER_LIMITER_PROCESSOR_STATE_VERSION,
  createMixerLimiterProcessor,
  processMixerLimiterBlock,
  resetMixerLimiterProcessor,
  type MixerLimiterProcessor,
} from './mixerLimiterKernel.js';

function enabledEffect(
  overrides: Partial<typeof MIXER_LIMITER_DEFAULT_PARAMETERS> = {},
) {
  return createMixerLimiterEffect(
    { ...MIXER_LIMITER_DEFAULT_PARAMETERS, ...overrides },
    false,
  );
}

function freezeProcessor(
  processor: MixerLimiterProcessor,
  overrides: Partial<MixerLimiterProcessor>,
): MixerLimiterProcessor {
  return Object.freeze({
    ...processor,
    ...overrides,
  }) as MixerLimiterProcessor;
}

function adjacentPositiveFloat32(value: number, direction: -1 | 1) {
  const float = new Float32Array([value]);
  const bits = new Uint32Array(float.buffer);
  bits[0] += direction;
  return float[0];
}

describe('Mixer linked sample-peak Limiter kernel v1', () => {
  it('creates deeply immutable versioned coefficients and zero state', () => {
    const processor = createMixerLimiterProcessor(enabledEffect());

    expect(processor.contractVersion).toBe(MIXER_EFFECTS_CONTRACT_VERSION);
    expect(processor.coefficients).toEqual({
      ceilingLinear: 0.9660508632659912,
      release: 0.9997732639312744,
      version: MIXER_LIMITER_COEFFICIENT_VERSION,
    });
    expect(processor.state).toEqual({
      reductionDb: 0,
      version: MIXER_LIMITER_PROCESSOR_STATE_VERSION,
    });
    expect(MIXER_LIMITER_CEILING_GUARD_VERSION).toBe(1);
    expect(MIXER_LIMITER_TOPOLOGY_INVARIANT).toEqual({
      effectType: 'limiter',
      enabledChainPosition: 'last',
      insertTarget: 'master',
      version: 1,
    });
    expect(Object.isFrozen(processor)).toBe(true);
    expect(Object.isFrozen(processor.effect)).toBe(true);
    expect(Object.isFrozen(processor.effect.parameters)).toBe(true);
    expect(Object.isFrozen(processor.coefficients)).toBe(true);
    expect(Object.isFrozen(processor.state)).toBe(true);
  });

  it('locks ceiling and release construction at every legal boundary', () => {
    const zeroCeiling = createMixerLimiterProcessor(
      enabledEffect({ ceilingDb: 0 }),
    );
    const minimumCeiling = createMixerLimiterProcessor(
      enabledEffect({ ceilingDb: -12 }),
    );
    const fastestRelease = createMixerLimiterProcessor(
      enabledEffect({ releaseMs: 10 }),
    );
    const slowestRelease = createMixerLimiterProcessor(
      enabledEffect({ releaseMs: 1_000 }),
    );

    expect(zeroCeiling.coefficients.ceilingLinear).toBe(1);
    expect(minimumCeiling.coefficients.ceilingLinear).toBe(
      0.25118863582611084,
    );
    expect(fastestRelease.coefficients.release).toBe(0.9977350234985352);
    expect(slowestRelease.coefficients.release).toBe(0.9999773502349854);
    for (const value of [
      zeroCeiling.coefficients.ceilingLinear,
      minimumCeiling.coefficients.ceilingLinear,
      fastestRelease.coefficients.release,
      slowestRelease.coefficients.release,
    ]) {
      expect(Math.fround(value)).toBe(value);
    }
  });

  it('preserves silence, signs, and below-ceiling samples from zero state', () => {
    const processor = createMixerLimiterProcessor(enabledEffect());
    const left = new Float32Array([0, -0, 0.25, -0.5, 0.75]);
    const right = new Float32Array([-0, 0, -0.125, 0.5, -0.75]);
    const result = processMixerLimiterBlock(processor, left, right);

    expect(Array.from(result.leftSamples)).toEqual(Array.from(left));
    expect(Array.from(result.rightSamples)).toEqual(Array.from(right));
    expect(Object.is(result.leftSamples[1], -0)).toBe(true);
    expect(Object.is(result.rightSamples[0], -0)).toBe(true);
    expect(result.processor.state.reductionDb).toBe(0);

    const silence = processMixerLimiterBlock(
      processor,
      new Float32Array(16),
      new Float32Array(16),
    );
    expect(Array.from(silence.leftSamples)).toEqual(new Array(16).fill(0));
    expect(Array.from(silence.rightSamples)).toEqual(new Array(16).fill(0));
    expect(silence.processor.state.reductionDb).toBe(0);
  });

  it.each([0, -0.3, -12])(
    'distinguishes exact ceiling from the next Float32 above at %s dB',
    (ceilingDb) => {
      const exactProcessor = createMixerLimiterProcessor(
        enabledEffect({ ceilingDb }),
      );
      const ceiling = exactProcessor.coefficients.ceilingLinear;
      const justAbove = adjacentPositiveFloat32(ceiling, 1);
      const exact = processMixerLimiterBlock(
        exactProcessor,
        [ceiling],
        [-ceiling],
      );
      const above = processMixerLimiterBlock(
        createMixerLimiterProcessor(enabledEffect({ ceilingDb })),
        [justAbove],
        [-justAbove],
      );

      expect(exact.leftSamples[0]).toBe(ceiling);
      expect(exact.rightSamples[0]).toBe(-ceiling);
      expect(exact.processor.state.reductionDb).toBe(0);
      expect(above.processor.state.reductionDb).toBeLessThan(0);
      expect(Math.abs(above.leftSamples[0])).toBeLessThanOrEqual(ceiling);
      expect(Math.abs(above.rightSamples[0])).toBeLessThanOrEqual(ceiling);
    },
  );

  it('attacks on the first transient and applies one linked stereo gain', () => {
    const leftOnly = processMixerLimiterBlock(
      createMixerLimiterProcessor(enabledEffect()),
      [2],
      [0],
    );
    const linked = processMixerLimiterBlock(
      createMixerLimiterProcessor(enabledEffect()),
      [2],
      [0.5],
    );
    const ceiling = linked.processor.coefficients.ceilingLinear;

    expect(leftOnly.leftSamples[0]).toBe(ceiling);
    expect(leftOnly.rightSamples[0]).toBe(0);
    expect(leftOnly.processor.state.reductionDb).toBe(
      -6.3206000328063965,
    );
    expect(linked.leftSamples[0]).toBe(ceiling);
    expect(linked.rightSamples[0]).toBe(
      Math.fround(linked.leftSamples[0] * 0.25),
    );
    expect(linked.processor.state).toEqual(leftOnly.processor.state);
  });

  it('releases only toward less attenuation and re-attacks on a later transient', () => {
    const firstTransient = processMixerLimiterBlock(
      createMixerLimiterProcessor(enabledEffect()),
      [2],
      [0],
    );
    const firstRelease = processMixerLimiterBlock(
      firstTransient.processor,
      [0.25],
      [0],
    );
    const releaseRun = processMixerLimiterBlock(
      firstRelease.processor,
      new Float32Array(5_000),
      new Float32Array(5_000),
    );
    const repeatedTransient = processMixerLimiterBlock(
      releaseRun.processor,
      [10],
      [0],
    );
    const freshTransient = processMixerLimiterBlock(
      createMixerLimiterProcessor(enabledEffect()),
      [10],
      [0],
    );

    expect(firstRelease.processor.state.reductionDb).toBeGreaterThan(
      firstTransient.processor.state.reductionDb,
    );
    expect(firstRelease.processor.state.reductionDb).toBeLessThan(0);
    expect(firstRelease.leftSamples[0]).toBeLessThan(0.25);
    expect(releaseRun.processor.state.reductionDb).toBeGreaterThan(
      firstRelease.processor.state.reductionDb,
    );
    expect(repeatedTransient.processor.state).toEqual(
      freshTransient.processor.state,
    );
    expect(repeatedTransient.leftSamples[0]).toBe(
      freshTransient.leftSamples[0],
    );
  });

  it('never exceeds each versioned ceiling for representative and extreme inputs', () => {
    const largestFloat32 = 3.4028234663852886e38;

    for (const ceilingDb of [0, -0.3, -12]) {
      const base = createMixerLimiterProcessor(enabledEffect({ ceilingDb }));
      const ceiling = base.coefficients.ceilingLinear;
      const values = [
        ceiling,
        adjacentPositiveFloat32(ceiling, 1),
        1,
        2,
        10,
        100,
        1e10,
        largestFloat32,
      ];

      for (const value of values) {
        const result = processMixerLimiterBlock(
          createMixerLimiterProcessor(enabledEffect({ ceilingDb })),
          [value],
          [-value],
        );
        expect(Number.isFinite(result.leftSamples[0])).toBe(true);
        expect(Number.isFinite(result.rightSamples[0])).toBe(true);
        expect(Math.abs(result.leftSamples[0])).toBeLessThanOrEqual(ceiling);
        expect(Math.abs(result.rightSamples[0])).toBeLessThanOrEqual(ceiling);
      }
    }

    const guardedDefault = processMixerLimiterBlock(
      createMixerLimiterProcessor(enabledEffect()),
      [10],
      [-10],
    );
    expect(guardedDefault.leftSamples[0]).toBe(
      guardedDefault.processor.coefficients.ceilingLinear,
    );
    expect(guardedDefault.rightSamples[0]).toBe(
      -guardedDefault.processor.coefficients.ceilingLinear,
    );
  });

  it('cannot apply the ceiling guard or hidden normalization below ceiling', () => {
    const processor = createMixerLimiterProcessor(
      enabledEffect({ ceilingDb: 0 }),
    );
    const left = new Float32Array([0.1, -0.25, 0.5, -0.75, 1]);
    const right = new Float32Array([-0.1, 0.25, -0.5, 0.75, -1]);
    const result = processMixerLimiterBlock(processor, left, right);

    expect(Array.from(result.leftSamples)).toEqual(Array.from(left));
    expect(Array.from(result.rightSamples)).toEqual(Array.from(right));
    expect(result.processor.state.reductionDb).toBe(0);
  });

  it('keeps BYPASS byte-transparent and cannot advance state', () => {
    const processor = createMixerLimiterProcessor(
      createMixerLimiterEffect(
        { ...MIXER_LIMITER_DEFAULT_PARAMETERS, ceilingDb: -12 },
        true,
      ),
    );
    const left = new Float32Array([0, -0, 1, -2, 10]);
    const right = new Float64Array([10, -10, 0.125, -0.25, 0]);
    const leftBytes = new Uint8Array(left.buffer.slice(0));
    const rightBytes = new Uint8Array(right.buffer.slice(0));
    const result = processMixerLimiterBlock(processor, left, right);

    expect(result.leftSamples).toBe(left);
    expect(result.rightSamples).toBe(right);
    expect(result.processor).toBe(processor);
    expect(new Uint8Array(left.buffer)).toEqual(leftBytes);
    expect(new Uint8Array(right.buffer)).toEqual(rightBytes);
    expect(result.processor.state.reductionDb).toBe(0);
  });

  it('produces identical repeated runs and deterministic reset with no tail', () => {
    const effect = enabledEffect({ ceilingDb: -6, releaseMs: 250 });
    const left = new Float64Array([1, 0.5, -2, 0, 0.125]);
    const right = new Float64Array([-0.5, 0.25, 1.5, -1, 0]);
    const first = processMixerLimiterBlock(
      createMixerLimiterProcessor(effect),
      left,
      right,
    );
    const second = processMixerLimiterBlock(
      createMixerLimiterProcessor(effect),
      left,
      right,
    );

    expect(Array.from(second.leftSamples)).toEqual(Array.from(first.leftSamples));
    expect(Array.from(second.rightSamples)).toEqual(
      Array.from(first.rightSamples),
    );
    expect(second.processor.state).toEqual(first.processor.state);
    expect(resetMixerLimiterProcessor(first.processor)).toEqual(
      createMixerLimiterProcessor(effect),
    );
  });

  it('is invariant to valid ordered block partitioning', () => {
    const effect = enabledEffect({ ceilingDb: -3, releaseMs: 75 });
    const left = [0.25, -0.5, 1, -2, 0.125, 0.5, -1.5];
    const right = [-0.125, 0.25, -0.75, 0.5, -1, 2, 0.125];
    const single = processMixerLimiterBlock(
      createMixerLimiterProcessor(effect),
      left,
      right,
    );

    let partitionedProcessor = createMixerLimiterProcessor(effect);
    const partitionedLeft: number[] = [];
    const partitionedRight: number[] = [];
    for (const [start, end] of [
      [0, 1],
      [1, 4],
      [4, 5],
      [5, 7],
    ] as const) {
      const block = processMixerLimiterBlock(
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

  it('rejects invalid blocks, coefficients, identity, and state atomically', () => {
    const processor = createMixerLimiterProcessor(enabledEffect());
    const originalState = processor.state;

    expect(() =>
      processMixerLimiterBlock(processor, [1, Number.NaN], [0, 0]),
    ).toThrow(RangeError);
    expect(() =>
      processMixerLimiterBlock(
        processor,
        [0, 0],
        [0, Number.POSITIVE_INFINITY],
      ),
    ).toThrow(RangeError);
    expect(() =>
      processMixerLimiterBlock(processor, [Number.MAX_VALUE], [0]),
    ).toThrow(RangeError);
    expect(() => processMixerLimiterBlock(processor, [0], [0, 1])).toThrow(
      TypeError,
    );
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
        version: MIXER_LIMITER_PROCESSOR_STATE_VERSION,
      });
      expect(() =>
        processMixerLimiterBlock(
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
        processMixerLimiterBlock(
          freezeProcessor(processor, { state: invalidState } as never),
          [0],
          [0],
        ),
      ).toThrow(TypeError);
    }

    for (const invalidCoefficients of [
      Object.freeze({
        ...processor.coefficients,
        ceilingLinear: 1.0000001192092896,
      }),
      Object.freeze({
        ...processor.coefficients,
        release: Number.POSITIVE_INFINITY,
      }),
    ]) {
      expect(() =>
        processMixerLimiterBlock(
          freezeProcessor(processor, {
            coefficients: invalidCoefficients,
          } as never),
          [0],
          [0],
        ),
      ).toThrow(TypeError);
    }

    expect(() =>
      createMixerLimiterProcessor(
        createMixerCompressorEffect(
          MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
          false,
        ) as never,
      ),
    ).toThrow(TypeError);
  });

  it('canonicalizes released persistent state below threshold to positive zero', () => {
    const processor = createMixerLimiterProcessor(enabledEffect());
    const nearThresholdState = Object.freeze({
      reductionDb: Math.fround(-1.0000001e-20),
      version: MIXER_LIMITER_PROCESSOR_STATE_VERSION,
    });
    expect(Math.abs(nearThresholdState.reductionDb)).toBeGreaterThanOrEqual(
      MIXER_EFFECTS_DENORMAL_THRESHOLD,
    );

    const result = processMixerLimiterBlock(
      freezeProcessor(processor, { state: nearThresholdState }),
      [0],
      [0],
    );
    expect(result.processor.state.reductionDb).toBe(0);
    expect(Object.is(result.processor.state.reductionDb, -0)).toBe(false);
  });

  it.each([
    [
      'default ceiling with linked attack and release',
      MIXER_LIMITER_DEFAULT_PARAMETERS,
      [0, 0.5, 1, 2, 0.5, 0.25, 1.5, 0],
      [0, -0.25, -1.5, 0.25, -0.5, 0, 0.75, 0],
      [
        0, 0.5, 0.6440339088439941, 0.9660508632659912,
        0.24155256152153015, 0.12079620361328125, 0.7248244881629944, 0,
      ],
      [
        0, -0.25, -0.9660508632659912, 0.1207563579082489,
        -0.24155256152153015, 0, 0.3624122440814972, 0,
      ],
      -6.315735816955566,
    ],
    [
      'minimum ceiling with fast release and repeated transient',
      { ceilingDb: -12, releaseMs: 10 },
      [0.1, -0.25, 0.5, -1, 0.1, 0.1, 0.8, 0],
      [-0.05, 0.125, -0.75, 0.25, -0.1, 0, 0.4, 0],
      [
        0.10000000149011612, -0.25, 0.16745908558368683,
        -0.25118863582611084, 0.02519758976995945,
        0.02527638152241707, 0.20231039822101593, 0,
      ],
      [
        -0.05000000074505806, 0.125, -0.25118863582611084,
        0.06279715895652771, -0.02519758976995945, 0,
        0.10115519911050797, 0,
      ],
      -11.914388656616211,
    ],
  ] as const)(
    'matches the independent Float32 detector/attack/release reference for %s',
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
      // System.Single at the documented boundaries. They are regression data,
      // not a second implementation of the Limiter equations.
      const result = processMixerLimiterBlock(
        createMixerLimiterProcessor(
          createMixerLimiterEffect(parameters, false),
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
      new URL('./mixerLimiterKernel.d.ts', import.meta.url),
      'utf8',
    );
    const contractDeclarationSource = readFileSync(
      new URL('./mixerEffectsContract.d.ts', import.meta.url),
      'utf8',
    );

    expect(declarationSource).toContain(
      'MIXER_LIMITER_COEFFICIENT_VERSION: 1',
    );
    expect(declarationSource).toContain(
      'MIXER_LIMITER_PROCESSOR_STATE_VERSION: 1',
    );
    expect(declarationSource).toContain(
      'MIXER_LIMITER_CEILING_GUARD_VERSION: 1',
    );
    expect(declarationSource).toContain(
      'export function createMixerLimiterProcessor',
    );
    expect(declarationSource).toContain(
      'export function processMixerLimiterBlock',
    );
    expect(declarationSource).toContain(
      'export function resetMixerLimiterProcessor',
    );
    expect(
      declarationSource.match(/Readonly</g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(contractDeclarationSource).toContain(
      "MIXER_EFFECT_TYPE_LIMITER: 'limiter'",
    );
    expect(contractDeclarationSource).toContain(
      "'humstudio.limiter.linked-sample-peak.v1'",
    );
  });

  it('imports without browser globals, Node APIs, or Web Audio built-ins', () => {
    const source = readFileSync(
      new URL('./mixerLimiterKernel.js', import.meta.url),
      'utf8',
    );
    const forbiddenRuntimeDependency =
      /(?:from\s+['"]node:|require\s*\(|\bwindow\b|\bdocument\b|\bAudioContext\b|\bAudioWorkletNode\b|\bAnalyserNode\b|\bBuffer\b)/;

    expect(source).not.toMatch(forbiddenRuntimeDependency);
    expect(source.match(/from\s+['"][^'"]+['"]/g)).toEqual([
      "from './mixerEffectsContract.js'",
    ]);
  });

  it('preserves committed Equalizer and Compressor golden outputs', () => {
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
    expect(Array.from(compressor.rightSamples)).toEqual([
      0,
      -0.4988299310207367,
      0.12456289678812027,
      0,
    ]);
  });
});
