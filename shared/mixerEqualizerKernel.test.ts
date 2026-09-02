import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_DENORMAL_THRESHOLD,
  MIXER_EQUALIZER_DEFAULT_PARAMETERS,
  createMixerEqualizerEffect,
} from './mixerEffectsContract.js';
import {
  MIXER_EQUALIZER_COEFFICIENT_VERSION,
  MIXER_EQUALIZER_PROCESSOR_STATE_VERSION,
  createMixerEqualizerProcessor,
  processMixerEqualizerBlock,
  resetMixerEqualizerProcessor,
  type MixerEqualizerProcessor,
} from './mixerEqualizerKernel.js';

function enabledEffect(
  overrides: Partial<typeof MIXER_EQUALIZER_DEFAULT_PARAMETERS> = {},
) {
  return createMixerEqualizerEffect(
    { ...MIXER_EQUALIZER_DEFAULT_PARAMETERS, ...overrides },
    false,
  );
}

function processorStateValues(processor: MixerEqualizerProcessor) {
  return [
    processor.state.left.lowShelf.z1,
    processor.state.left.lowShelf.z2,
    processor.state.left.midPeaking.z1,
    processor.state.left.midPeaking.z2,
    processor.state.left.highShelf.z1,
    processor.state.left.highShelf.z2,
    processor.state.right.lowShelf.z1,
    processor.state.right.lowShelf.z2,
    processor.state.right.midPeaking.z1,
    processor.state.right.midPeaking.z2,
    processor.state.right.highShelf.z1,
    processor.state.right.highShelf.z2,
  ];
}

function freezeInvalidProcessor(
  processor: MixerEqualizerProcessor,
  overrides: Partial<MixerEqualizerProcessor>,
): MixerEqualizerProcessor {
  return Object.freeze({ ...processor, ...overrides }) as MixerEqualizerProcessor;
}

describe('Mixer Equalizer 3-band TDF2 kernel v1', () => {
  it('creates deeply immutable, explicitly versioned coefficient and state snapshots', () => {
    const processor = createMixerEqualizerProcessor(enabledEffect());

    expect(processor.contractVersion).toBe(MIXER_EFFECTS_CONTRACT_VERSION);
    expect(processor.coefficients.version).toBe(
      MIXER_EQUALIZER_COEFFICIENT_VERSION,
    );
    expect(processor.state.version).toBe(
      MIXER_EQUALIZER_PROCESSOR_STATE_VERSION,
    );
    expect(Object.isFrozen(processor)).toBe(true);
    expect(Object.isFrozen(processor.coefficients)).toBe(true);
    expect(Object.isFrozen(processor.coefficients.lowShelf)).toBe(true);
    expect(Object.isFrozen(processor.coefficients.midPeaking)).toBe(true);
    expect(Object.isFrozen(processor.coefficients.highShelf)).toBe(true);
    expect(Object.isFrozen(processor.state)).toBe(true);
    expect(Object.isFrozen(processor.state.left)).toBe(true);
    expect(Object.isFrozen(processor.state.left.lowShelf)).toBe(true);
    expect(processorStateValues(processor)).toEqual(new Array(12).fill(0));
  });

  it('locks Float32 coefficient construction for the three fixed stages', () => {
    const processor = createMixerEqualizerProcessor(
      enabledEffect({
        lowGainDb: 5,
        midGainDb: -4,
        midQ: 1.5,
        highGainDb: 3,
      }),
    );

    expect(processor.coefficients).toEqual({
      highShelf: {
        a1: -0.4134937822818756,
        a2: 0.20196087658405304,
        b0: 1.241824984550476,
        b1: -0.7467116117477417,
        b2: 0.29335373640060425,
        version: MIXER_EQUALIZER_COEFFICIENT_VERSION,
      },
      lowShelf: {
        a1: -1.979062557220459,
        a2: 0.9792794585227966,
        b0: 1.00349760055542,
        b1: -1.9789780378341675,
        b2: 0.9758662581443787,
        version: MIXER_EQUALIZER_COEFFICIENT_VERSION,
      },
      midPeaking: {
        a1: -1.8684028387069702,
        a2: 0.8875283002853394,
        b0: 0.9792465567588806,
        b1: -1.8684028387069702,
        b2: 0.9082817435264587,
        version: MIXER_EQUALIZER_COEFFICIENT_VERSION,
      },
      version: MIXER_EQUALIZER_COEFFICIENT_VERSION,
    });

    for (const stage of [
      processor.coefficients.lowShelf,
      processor.coefficients.midPeaking,
      processor.coefficients.highShelf,
    ]) {
      for (const coefficient of [
        stage.a1,
        stage.a2,
        stage.b0,
        stage.b1,
        stage.b2,
      ]) {
        expect(Number.isFinite(coefficient)).toBe(true);
        expect(Math.fround(coefficient)).toBe(coefficient);
      }
    }
  });

  it('keeps BYPASS byte-transparent and does not advance processor state', () => {
    const effect = createMixerEqualizerEffect(
      { ...MIXER_EQUALIZER_DEFAULT_PARAMETERS, midGainDb: 12 },
      true,
    );
    const processor = createMixerEqualizerProcessor(effect);
    const left = new Float32Array([0, -0, 0.25, -0.5, 1]);
    const right = new Float64Array([1, -1, 0.125, -0.25, 0]);
    const leftBytes = new Uint8Array(left.buffer.slice(0));
    const rightBytes = new Uint8Array(right.buffer.slice(0));
    const result = processMixerEqualizerBlock(processor, left, right);

    expect(result.leftSamples).toBe(left);
    expect(result.rightSamples).toBe(right);
    expect(result.processor).toBe(processor);
    expect(new Uint8Array(left.buffer)).toEqual(leftBytes);
    expect(new Uint8Array(right.buffer)).toEqual(rightBytes);
    expect(processorStateValues(result.processor)).toEqual(new Array(12).fill(0));
  });

  it('preserves silence and processes stereo channels independently', () => {
    const processor = createMixerEqualizerProcessor(
      enabledEffect({ lowGainDb: 6, midGainDb: -3, highGainDb: 4 }),
    );
    const silence = processMixerEqualizerBlock(
      processor,
      new Float32Array(8),
      new Float32Array(8),
    );

    expect(Array.from(silence.leftSamples)).toEqual(new Array(8).fill(0));
    expect(Array.from(silence.rightSamples)).toEqual(new Array(8).fill(0));
    expect(processorStateValues(silence.processor)).toEqual(
      new Array(12).fill(0),
    );

    const independent = processMixerEqualizerBlock(
      processor,
      new Float64Array([1, 0, 0, 0]),
      new Float64Array(4),
    );
    expect(Array.from(independent.leftSamples).some((sample) => sample !== 0)).toBe(
      true,
    );
    expect(Array.from(independent.rightSamples)).toEqual(new Array(4).fill(0));
    expect(processorStateValues(independent.processor).slice(6)).toEqual(
      new Array(6).fill(0),
    );
  });

  it('is invariant to valid processing-block partitioning', () => {
    const effect = enabledEffect({
      lowGainDb: 5,
      midGainDb: -4,
      highGainDb: 3,
      midQ: 1.5,
    });
    const left = [0.25, -0.5, 0.75, -1, 0.125, 0.5, -0.25];
    const right = [-0.125, 0.25, -0.375, 0.5, -0.75, 1, 0.125];
    const single = processMixerEqualizerBlock(
      createMixerEqualizerProcessor(effect),
      left,
      right,
    );

    let partitionedProcessor = createMixerEqualizerProcessor(effect);
    const partitionedLeft: number[] = [];
    const partitionedRight: number[] = [];
    for (const [start, end] of [
      [0, 1],
      [1, 4],
      [4, 5],
      [5, 7],
    ] as const) {
      const block = processMixerEqualizerBlock(
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

  it('produces identical output and state for repeated runs and deterministic reset', () => {
    const effect = enabledEffect({ midGainDb: 9, midQ: 2.5 });
    const left = new Float64Array([1, 0.5, -0.25, 0, 0.125]);
    const right = new Float64Array([-0.5, 0.25, 1, -1, 0]);
    const first = processMixerEqualizerBlock(
      createMixerEqualizerProcessor(effect),
      left,
      right,
    );
    const second = processMixerEqualizerBlock(
      createMixerEqualizerProcessor(effect),
      left,
      right,
    );

    expect(Array.from(second.leftSamples)).toEqual(Array.from(first.leftSamples));
    expect(Array.from(second.rightSamples)).toEqual(
      Array.from(first.rightSamples),
    );
    expect(second.processor.state).toEqual(first.processor.state);
    expect(resetMixerEqualizerProcessor(first.processor)).toEqual(
      createMixerEqualizerProcessor(effect),
    );
  });

  it('zeros processor denormals below the versioned threshold', () => {
    const result = processMixerEqualizerBlock(
      createMixerEqualizerProcessor(enabledEffect({ lowGainDb: 12 })),
      [MIXER_EFFECTS_DENORMAL_THRESHOLD / 10],
      [-MIXER_EFFECTS_DENORMAL_THRESHOLD / 10],
    );

    expect(processorStateValues(result.processor)).toEqual(new Array(12).fill(0));
  });

  it('fails closed on non-finite input, coefficient, or processor state', () => {
    const processor = createMixerEqualizerProcessor(enabledEffect());

    expect(() => processMixerEqualizerBlock(processor, [Number.NaN], [0])).toThrow(
      RangeError,
    );
    expect(() =>
      processMixerEqualizerBlock(processor, [0], [Number.POSITIVE_INFINITY]),
    ).toThrow(RangeError);
    expect(() =>
      processMixerEqualizerBlock(processor, [Number.MAX_VALUE], [0]),
    ).toThrow(RangeError);

    const invalidLowShelf = Object.freeze({
      ...processor.coefficients.lowShelf,
      b0: Number.POSITIVE_INFINITY,
    });
    const invalidCoefficients = Object.freeze({
      ...processor.coefficients,
      lowShelf: invalidLowShelf,
    });
    expect(() =>
      processMixerEqualizerBlock(
        freezeInvalidProcessor(processor, {
          coefficients: invalidCoefficients,
        } as never),
        [0],
        [0],
      ),
    ).toThrow(TypeError);

    const invalidBiquadState = Object.freeze({
      ...processor.state.left.lowShelf,
      z1: Number.NaN,
    });
    const invalidLeftState = Object.freeze({
      ...processor.state.left,
      lowShelf: invalidBiquadState,
    });
    const invalidState = Object.freeze({
      ...processor.state,
      left: invalidLeftState,
    });
    expect(() =>
      processMixerEqualizerBlock(
        freezeInvalidProcessor(processor, { state: invalidState } as never),
        [0],
        [0],
      ),
    ).toThrow(TypeError);
  });

  it.each([
    [
      'low boost',
      { lowGainDb: 6 },
      [
        1.0042049884796143, 0.008426356129348278, 0.008457980118691921,
        0.008487233892083168, 0.008514159359037876, 0.008538798429071903,
        0.008561192080378532, 0.008581381291151047,
      ],
    ],
    [
      'low cut',
      { lowGainDb: -6 },
      [
        0.9958126544952393, -0.008355936035513878, -0.008317260071635246,
        -0.00827629305422306, -0.008233116939663887, -0.008187811821699142,
        -0.00814045686274767, -0.00809112936258316,
      ],
    ],
    [
      'mid boost',
      { midGainDb: 6 },
      [
        1.0476300716400146, 0.08978226780891418, 0.0785374864935875,
        0.0668535828590393, 0.05499803274869919, 0.04321601986885071,
        0.03172784298658371, 0.020727045834064484,
      ],
    ],
    [
      'mid cut',
      { midGainDb: -6 },
      [
        0.9545354247093201, -0.08180399984121323, -0.06454789638519287,
        -0.0492485873401165, -0.03583114594221115, -0.024199647828936577,
        -0.01424275990575552, -0.005838600918650627,
      ],
    ],
    [
      'high boost',
      { highGainDb: 6 },
      [
        1.5417791604995728, -0.5778730511665344, -0.07786612212657928,
        0.08477361500263214, 0.04153283312916756, -0.0029196233954280615,
        -0.008784431032836437, -0.002223779447376728,
      ],
    ],
    [
      'high cut',
      { highGainDb: -6 },
      [
        0.6486012935638428, 0.24310173094272614, 0.1238737627863884,
        0.02304377593100071, -0.015945810824632645, -0.016944438219070435,
        -0.007604425307363272, -0.0008947825990617275,
      ],
    ],
  ] as const)(
    'matches the independent RBJ/TDF2 impulse reference for %s',
    (_name, overrides, expected) => {
      // These fixed vectors were independently checked against the RBJ Audio
      // EQ Cookbook transfer equations and the v1 Float32 TDF2 boundaries.
      // They are regression data, not a second copy of the kernel formulas.
      const impulse = new Float64Array([1, 0, 0, 0, 0, 0, 0, 0]);
      const result = processMixerEqualizerBlock(
        createMixerEqualizerProcessor(enabledEffect(overrides)),
        impulse,
        new Float64Array(impulse.length),
      );

      expect(Array.from(result.leftSamples)).toEqual(expected);
      expect(Array.from(result.rightSamples)).toEqual(new Array(8).fill(0));
      expect(result.leftSamples).toHaveLength(impulse.length);
      expect(result.leftSamples[0]).not.toBe(0);
    },
  );

  it('locks the low-shelf to mid-peak to high-shelf cascade contract', () => {
    const impulse = new Float64Array([1, 0, 0, 0, 0, 0, 0, 0]);
    const result = processMixerEqualizerBlock(
      createMixerEqualizerProcessor(
        enabledEffect({
          lowGainDb: 5,
          midGainDb: -4,
          midQ: 1.5,
          highGainDb: 3,
        }),
      ),
      impulse,
      new Float64Array(impulse.length),
    );

    expect(Array.from(result.leftSamples)).toEqual([
      1.2203060388565063, -0.26898422837257385, -0.07873330265283585,
      0.005715243984013796, 0.0063245054334402084, -0.006493535824120045,
      -0.008121294900774956, -0.0026511296164244413,
    ]);
  });

  it('imports without browser globals, Node APIs, or Web Audio built-ins', () => {
    const contractSource = readFileSync(
      new URL('./mixerEffectsContract.js', import.meta.url),
      'utf8',
    );
    const kernelSource = readFileSync(
      new URL('./mixerEqualizerKernel.js', import.meta.url),
      'utf8',
    );
    const forbiddenRuntimeDependency =
      /(?:from\s+['"]node:|require\s*\(|\bwindow\b|\bdocument\b|\bAudioContext\b|\bAudioWorkletNode\b|\bAnalyserNode\b|\bBuffer\b)/;

    for (const source of [contractSource, kernelSource]) {
      expect(source).not.toMatch(forbiddenRuntimeDependency);
    }
    expect(contractSource).not.toMatch(/^\s*import\s/m);
    expect(kernelSource.match(/from\s+['"][^'"]+['"]/g)).toEqual([
      "from './mixerEffectsContract.js'",
    ]);
  });
});
