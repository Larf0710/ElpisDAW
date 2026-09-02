import { describe, expect, it } from 'vitest';

import {
  MIXER_COMPRESSOR_ALGORITHM_ID,
  MIXER_COMPRESSOR_ALGORITHM_VERSION,
  MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
  MIXER_COMPRESSOR_PARAMETER_SPECS,
  MIXER_ECHO_DELAY_ALGORITHM_ID,
  MIXER_ECHO_DELAY_ALGORITHM_VERSION,
  MIXER_ECHO_DELAY_DEFAULT_PARAMETERS,
  MIXER_ECHO_DELAY_PARAMETER_SPECS,
  MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT,
  MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT_VERSION,
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_DENORMAL_THRESHOLD,
  MIXER_EFFECTS_SAMPLE_RATE_HZ,
  MIXER_EFFECT_TYPE_COMPRESSOR,
  MIXER_EFFECT_TYPE_ECHO_DELAY,
  MIXER_EFFECT_TYPE_EQUALIZER,
  MIXER_EFFECT_TYPE_LIMITER,
  MIXER_EQUALIZER_ALGORITHM_ID,
  MIXER_EQUALIZER_ALGORITHM_VERSION,
  MIXER_EQUALIZER_DEFAULT_PARAMETERS,
  MIXER_EQUALIZER_PARAMETER_SPECS,
  MIXER_EQUALIZER_SHELF_SLOPE,
  MIXER_EQUALIZER_STAGE_ORDER,
  MIXER_LIMITER_ALGORITHM_ID,
  MIXER_LIMITER_ALGORITHM_VERSION,
  MIXER_LIMITER_DEFAULT_PARAMETERS,
  MIXER_LIMITER_PARAMETER_SPECS,
  MIXER_LIMITER_TOPOLOGY_INVARIANT,
  MIXER_LIMITER_TOPOLOGY_INVARIANT_VERSION,
  createDefaultMixerCompressorEffect,
  createDefaultMixerEchoDelayEffect,
  createDefaultMixerEqualizerEffect,
  createDefaultMixerLimiterEffect,
  createMixerCompressorEffect,
  createMixerEchoDelayEffect,
  createMixerEffectSnapshot,
  createMixerEqualizerEffect,
  createMixerLimiterEffect,
  type MixerCompressorParameterName,
  type MixerCompressorParameters,
  type MixerEchoDelayParameterName,
  type MixerEchoDelayParameters,
  type MixerEqualizerParameterName,
  type MixerEqualizerParameters,
  type MixerLimiterParameterName,
  type MixerLimiterParameters,
} from './mixerEffectsContract.js';

const PARAMETER_NAMES: readonly MixerEqualizerParameterName[] = [
  'highFrequencyHz',
  'highGainDb',
  'lowFrequencyHz',
  'lowGainDb',
  'midFrequencyHz',
  'midGainDb',
  'midQ',
];

const COMPRESSOR_PARAMETER_NAMES: readonly MixerCompressorParameterName[] = [
  'attackMs',
  'kneeDb',
  'makeupGainDb',
  'ratio',
  'releaseMs',
  'thresholdDb',
];

const LIMITER_PARAMETER_NAMES: readonly MixerLimiterParameterName[] = [
  'ceilingDb',
  'releaseMs',
];

const ECHO_DELAY_PARAMETER_NAMES: readonly MixerEchoDelayParameterName[] = [
  'delayTimeMs',
  'dry',
  'feedback',
  'wet',
];

function parameters(
  overrides: Partial<MixerEqualizerParameters> = {},
): MixerEqualizerParameters {
  return {
    ...MIXER_EQUALIZER_DEFAULT_PARAMETERS,
    ...overrides,
  };
}

function compressorParameters(
  overrides: Partial<MixerCompressorParameters> = {},
): MixerCompressorParameters {
  return {
    ...MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
    ...overrides,
  };
}

function limiterParameters(
  overrides: Partial<MixerLimiterParameters> = {},
): MixerLimiterParameters {
  return {
    ...MIXER_LIMITER_DEFAULT_PARAMETERS,
    ...overrides,
  };
}

function echoDelayParameters(
  overrides: Partial<MixerEchoDelayParameters> = {},
): MixerEchoDelayParameters {
  return {
    ...MIXER_ECHO_DELAY_DEFAULT_PARAMETERS,
    ...overrides,
  };
}

describe('Mixer Effects Contract v1', () => {
  it('defines the exact default Equalizer identity as immutable BYPASS state', () => {
    const effect = createDefaultMixerEqualizerEffect();

    expect(MIXER_EFFECTS_CONTRACT_VERSION).toBe(1);
    expect(MIXER_EFFECTS_SAMPLE_RATE_HZ).toBe(44_100);
    expect(MIXER_EFFECTS_DENORMAL_THRESHOLD).toBe(1e-20);
    expect(MIXER_EQUALIZER_SHELF_SLOPE).toBe(1);
    expect(MIXER_EQUALIZER_STAGE_ORDER).toEqual([
      'low-shelf',
      'peaking-mid',
      'high-shelf',
    ]);
    expect(Object.isFrozen(MIXER_EQUALIZER_STAGE_ORDER)).toBe(true);
    expect(Object.keys(effect).sort()).toEqual([
      'algorithmId',
      'algorithmVersion',
      'bypass',
      'effectType',
      'parameters',
    ]);
    expect(effect).toEqual({
      effectType: MIXER_EFFECT_TYPE_EQUALIZER,
      algorithmId: MIXER_EQUALIZER_ALGORITHM_ID,
      algorithmVersion: MIXER_EQUALIZER_ALGORITHM_VERSION,
      bypass: true,
      parameters: {
        highFrequencyHz: 8_000,
        highGainDb: 0,
        lowFrequencyHz: 120,
        lowGainDb: 0,
        midFrequencyHz: 1_000,
        midGainDb: 0,
        midQ: 1,
      },
    });
    expect(Object.isFrozen(effect)).toBe(true);
    expect(Object.isFrozen(effect.parameters)).toBe(true);
    expect(Object.isFrozen(MIXER_EQUALIZER_DEFAULT_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(MIXER_EQUALIZER_PARAMETER_SPECS)).toBe(true);
  });

  it('copies caller parameters into a deeply immutable operation snapshot', () => {
    const callerParameters = parameters({ lowGainDb: 6 });
    const effect = createMixerEqualizerEffect(callerParameters, false);
    const snapshot = createMixerEffectSnapshot(effect);

    (callerParameters as { lowGainDb: number }).lowGainDb = -6;

    expect(effect.parameters.lowGainDb).toBe(6);
    expect(snapshot).not.toBe(effect);
    expect(snapshot.parameters).not.toBe(effect.parameters);
    expect(snapshot).toEqual(effect);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.parameters)).toBe(true);
  });

  it('publishes the approved legal ranges and accepts every boundary', () => {
    expect(MIXER_EQUALIZER_PARAMETER_SPECS).toEqual({
      highFrequencyHz: { defaultValue: 8_000, maximum: 16_000, minimum: 2_000 },
      highGainDb: { defaultValue: 0, maximum: 12, minimum: -12 },
      lowFrequencyHz: { defaultValue: 120, maximum: 400, minimum: 40 },
      lowGainDb: { defaultValue: 0, maximum: 12, minimum: -12 },
      midFrequencyHz: { defaultValue: 1_000, maximum: 8_000, minimum: 200 },
      midGainDb: { defaultValue: 0, maximum: 12, minimum: -12 },
      midQ: { defaultValue: 1, maximum: 4, minimum: 0.25 },
    });

    const legalBoundaries: readonly MixerEqualizerParameters[] = [
      parameters({ lowGainDb: -12 }),
      parameters({ lowGainDb: 12 }),
      parameters({ lowFrequencyHz: 40 }),
      parameters({ lowFrequencyHz: 400 }),
      parameters({ midGainDb: -12 }),
      parameters({ midGainDb: 12 }),
      parameters({ midFrequencyHz: 200 }),
      parameters({ midFrequencyHz: 8_000, highFrequencyHz: 16_000 }),
      parameters({ midQ: 0.25 }),
      parameters({ midQ: 4 }),
      parameters({ highGainDb: -12 }),
      parameters({ highGainDb: 12 }),
      parameters({ highFrequencyHz: 2_000 }),
      parameters({ highFrequencyHz: 16_000 }),
    ];

    for (const boundary of legalBoundaries) {
      expect(() => createMixerEqualizerEffect(boundary, false)).not.toThrow();
    }
  });

  it.each([
    ['lowGainDb', -12.000_001],
    ['lowGainDb', 12.000_001],
    ['lowFrequencyHz', 39.999_999],
    ['lowFrequencyHz', 400.000_001],
    ['midGainDb', -12.000_001],
    ['midGainDb', 12.000_001],
    ['midFrequencyHz', 199.999_999],
    ['midFrequencyHz', 8_000.000_001],
    ['midQ', 0.249_999],
    ['midQ', 4.000_001],
    ['highGainDb', -12.000_001],
    ['highGainDb', 12.000_001],
    ['highFrequencyHz', 1_999.999_999],
    ['highFrequencyHz', 16_000.000_001],
  ] as const)('rejects %s just outside its legal range', (key, value) => {
    const safeOrdering =
      key === 'midFrequencyHz'
        ? { highFrequencyHz: 16_000 }
        : {};

    expect(() =>
      createMixerEqualizerEffect(
        parameters({ ...safeOrdering, [key]: value }),
        false,
      ),
    ).toThrow(RangeError);
  });

  it('rejects unordered frequencies and unsupported sample rates', () => {
    expect(() =>
      createMixerEqualizerEffect(
        parameters({ lowFrequencyHz: 200, midFrequencyHz: 200 }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      createMixerEqualizerEffect(
        parameters({ midFrequencyHz: 2_000, highFrequencyHz: 2_000 }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      createMixerEqualizerEffect(
        parameters({ lowFrequencyHz: 300, midFrequencyHz: 250 }),
      ),
    ).toThrow(RangeError);

    const effect = createDefaultMixerEqualizerEffect();
    expect(() => createMixerEffectSnapshot(effect, 48_000)).toThrow(RangeError);
    expect(() => createMixerEffectSnapshot(effect, 44_099)).toThrow(RangeError);
    expect(() => createMixerEffectSnapshot(effect, Number.NaN)).toThrow(
      RangeError,
    );
  });

  it('rejects incomplete, extra, unsupported, and confused identity shapes', () => {
    const effect = createDefaultMixerEqualizerEffect();

    expect(() =>
      createMixerEffectSnapshot({ ...effect, extra: true } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({
        ...effect,
        algorithmId: 'humstudio.equalizer.unknown',
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({ ...effect, algorithmVersion: 2 } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({ ...effect, bypass: 'false' } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEqualizerEffect(
        { ...MIXER_EQUALIZER_DEFAULT_PARAMETERS, midQ: undefined } as never,
      ),
    ).toThrow(RangeError);
    expect(() =>
      createMixerEqualizerEffect({
        ...MIXER_EQUALIZER_DEFAULT_PARAMETERS,
        extra: 1,
      } as never),
    ).toThrow(TypeError);
  });

  it('rejects every non-finite Equalizer parameter', () => {
    for (const key of PARAMETER_NAMES) {
      expect(() =>
        createMixerEqualizerEffect(
          parameters({ [key]: Number.NaN }),
          false,
        ),
      ).toThrow(RangeError);
      expect(() =>
        createMixerEqualizerEffect(
          parameters({ [key]: Number.POSITIVE_INFINITY }),
          false,
        ),
      ).toThrow(RangeError);
      expect(() =>
        createMixerEqualizerEffect(
          parameters({ [key]: Number.NEGATIVE_INFINITY }),
          false,
        ),
      ).toThrow(RangeError);
    }
  });
});

describe('Mixer Compressor Effects Contract v1', () => {
  it('defines the exact immutable default linked-peak Compressor identity', () => {
    const effect = createDefaultMixerCompressorEffect();

    expect(Object.keys(effect).sort()).toEqual([
      'algorithmId',
      'algorithmVersion',
      'bypass',
      'effectType',
      'parameters',
    ]);
    expect(effect).toEqual({
      effectType: MIXER_EFFECT_TYPE_COMPRESSOR,
      algorithmId: MIXER_COMPRESSOR_ALGORITHM_ID,
      algorithmVersion: MIXER_COMPRESSOR_ALGORITHM_VERSION,
      bypass: true,
      parameters: {
        attackMs: 10,
        kneeDb: 6,
        makeupGainDb: 0,
        ratio: 4,
        releaseMs: 100,
        thresholdDb: -18,
      },
    });
    expect(Object.isFrozen(effect)).toBe(true);
    expect(Object.isFrozen(effect.parameters)).toBe(true);
    expect(Object.isFrozen(MIXER_COMPRESSOR_DEFAULT_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(MIXER_COMPRESSOR_PARAMETER_SPECS)).toBe(true);
  });

  it('copies Compressor parameters into a deeply immutable operation snapshot', () => {
    const callerParameters = compressorParameters({ ratio: 8 });
    const effect = createMixerCompressorEffect(callerParameters, false);
    const snapshot = createMixerEffectSnapshot(effect);

    (callerParameters as { ratio: number }).ratio = 2;

    expect(effect.parameters.ratio).toBe(8);
    expect(snapshot).not.toBe(effect);
    expect(snapshot.parameters).not.toBe(effect.parameters);
    expect(snapshot).toEqual(effect);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.parameters)).toBe(true);
  });

  it('publishes every approved Compressor range and accepts each boundary', () => {
    expect(MIXER_COMPRESSOR_PARAMETER_SPECS).toEqual({
      attackMs: { defaultValue: 10, maximum: 100, minimum: 0.1 },
      kneeDb: { defaultValue: 6, maximum: 24, minimum: 0 },
      makeupGainDb: { defaultValue: 0, maximum: 24, minimum: -24 },
      ratio: { defaultValue: 4, maximum: 20, minimum: 1 },
      releaseMs: { defaultValue: 100, maximum: 1_000, minimum: 10 },
      thresholdDb: { defaultValue: -18, maximum: 0, minimum: -60 },
    });

    const legalBoundaries: readonly MixerCompressorParameters[] = [
      compressorParameters({ thresholdDb: -60 }),
      compressorParameters({ thresholdDb: 0 }),
      compressorParameters({ ratio: 1 }),
      compressorParameters({ ratio: 20 }),
      compressorParameters({ kneeDb: 0 }),
      compressorParameters({ kneeDb: 24 }),
      compressorParameters({ attackMs: 0.1 }),
      compressorParameters({ attackMs: 100 }),
      compressorParameters({ releaseMs: 10 }),
      compressorParameters({ releaseMs: 1_000 }),
      compressorParameters({ makeupGainDb: -24 }),
      compressorParameters({ makeupGainDb: 24 }),
    ];

    for (const boundary of legalBoundaries) {
      expect(() => createMixerCompressorEffect(boundary, false)).not.toThrow();
    }
  });

  it.each([
    ['thresholdDb', -60.000_001],
    ['thresholdDb', 0.000_001],
    ['ratio', 0.999_999],
    ['ratio', 20.000_001],
    ['kneeDb', -0.000_001],
    ['kneeDb', 24.000_001],
    ['attackMs', 0.099_999],
    ['attackMs', 100.000_001],
    ['releaseMs', 9.999_999],
    ['releaseMs', 1_000.000_001],
    ['makeupGainDb', -24.000_001],
    ['makeupGainDb', 24.000_001],
  ] as const)('rejects Compressor %s just outside its range', (key, value) => {
    expect(() =>
      createMixerCompressorEffect(
        compressorParameters({ [key]: value }),
        false,
      ),
    ).toThrow(RangeError);
  });

  it('rejects confused identity, exact-key, type, version, and sample-rate shapes', () => {
    const effect = createDefaultMixerCompressorEffect();

    expect(() => createMixerEffectSnapshot(effect, 48_000)).toThrow(RangeError);
    expect(() => createMixerEffectSnapshot(effect, Number.NaN)).toThrow(
      RangeError,
    );
    expect(() =>
      createMixerEffectSnapshot({ ...effect, extra: true } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({
        ...effect,
        effectType: MIXER_EFFECT_TYPE_EQUALIZER,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({
        ...effect,
        algorithmId: MIXER_EQUALIZER_ALGORITHM_ID,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({ ...effect, algorithmVersion: 2 } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerCompressorEffect(effect.parameters, 'false' as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerCompressorEffect({
        ...MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
        extra: 1,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerCompressorEffect({
        ...MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
        ratio: undefined,
      } as never),
    ).toThrow(RangeError);
  });

  it('rejects every non-finite Compressor parameter', () => {
    for (const key of COMPRESSOR_PARAMETER_NAMES) {
      for (const value of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]) {
        expect(() =>
          createMixerCompressorEffect(
            compressorParameters({ [key]: value }),
            false,
          ),
        ).toThrow(RangeError);
      }
    }
  });

  it('preserves the Equalizer API and snapshot behavior unchanged', () => {
    const effect = createMixerEqualizerEffect(
      { ...MIXER_EQUALIZER_DEFAULT_PARAMETERS, midGainDb: 3 },
      false,
    );
    const snapshot = createMixerEffectSnapshot(effect);

    expect(effect.effectType).toBe(MIXER_EFFECT_TYPE_EQUALIZER);
    expect(snapshot).toEqual(effect);
    expect(Object.keys(snapshot.parameters).sort()).toEqual(
      [...PARAMETER_NAMES].sort(),
    );
  });
});

describe('Mixer Limiter Effects Contract v1', () => {
  it('defines the exact immutable default identity and topology invariant', () => {
    const effect = createDefaultMixerLimiterEffect();

    expect(effect).toEqual({
      effectType: MIXER_EFFECT_TYPE_LIMITER,
      algorithmId: MIXER_LIMITER_ALGORITHM_ID,
      algorithmVersion: MIXER_LIMITER_ALGORITHM_VERSION,
      bypass: true,
      parameters: {
        ceilingDb: -0.3,
        releaseMs: 100,
      },
    });
    expect(Object.keys(effect).sort()).toEqual([
      'algorithmId',
      'algorithmVersion',
      'bypass',
      'effectType',
      'parameters',
    ]);
    expect(MIXER_LIMITER_TOPOLOGY_INVARIANT_VERSION).toBe(1);
    expect(MIXER_LIMITER_TOPOLOGY_INVARIANT).toEqual({
      effectType: MIXER_EFFECT_TYPE_LIMITER,
      enabledChainPosition: 'last',
      insertTarget: 'master',
      version: MIXER_LIMITER_TOPOLOGY_INVARIANT_VERSION,
    });
    expect(Object.isFrozen(effect)).toBe(true);
    expect(Object.isFrozen(effect.parameters)).toBe(true);
    expect(Object.isFrozen(MIXER_LIMITER_DEFAULT_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(MIXER_LIMITER_PARAMETER_SPECS)).toBe(true);
    expect(Object.isFrozen(MIXER_LIMITER_TOPOLOGY_INVARIANT)).toBe(true);
  });

  it('copies Limiter parameters into a deeply immutable operation snapshot', () => {
    const callerParameters = limiterParameters({ ceilingDb: -6 });
    const effect = createMixerLimiterEffect(callerParameters, false);
    const snapshot = createMixerEffectSnapshot(effect);

    (callerParameters as { ceilingDb: number }).ceilingDb = -3;

    expect(effect.parameters.ceilingDb).toBe(-6);
    expect(snapshot).not.toBe(effect);
    expect(snapshot.parameters).not.toBe(effect.parameters);
    expect(snapshot).toEqual(effect);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.parameters)).toBe(true);
  });

  it('publishes and accepts every approved Limiter parameter boundary', () => {
    expect(MIXER_LIMITER_PARAMETER_SPECS).toEqual({
      ceilingDb: { defaultValue: -0.3, maximum: 0, minimum: -12 },
      releaseMs: { defaultValue: 100, maximum: 1_000, minimum: 10 },
    });

    for (const boundary of [
      limiterParameters({ ceilingDb: -12 }),
      limiterParameters({ ceilingDb: 0 }),
      limiterParameters({ releaseMs: 10 }),
      limiterParameters({ releaseMs: 1_000 }),
    ]) {
      expect(() => createMixerLimiterEffect(boundary, false)).not.toThrow();
    }
  });

  it.each([
    ['ceilingDb', -12.000_001],
    ['ceilingDb', 0.000_001],
    ['releaseMs', 9.999_999],
    ['releaseMs', 1_000.000_001],
  ] as const)('rejects Limiter %s just outside its range', (key, value) => {
    expect(() =>
      createMixerLimiterEffect(limiterParameters({ [key]: value }), false),
    ).toThrow(RangeError);
  });

  it('rejects exact-key, type, version, sample-rate, and confused union shapes', () => {
    const effect = createDefaultMixerLimiterEffect();

    expect(() => createMixerEffectSnapshot(effect, 48_000)).toThrow(RangeError);
    expect(() => createMixerEffectSnapshot(effect, Number.NaN)).toThrow(
      RangeError,
    );
    expect(() =>
      createMixerEffectSnapshot({ ...effect, extra: true } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({
        ...effect,
        effectType: MIXER_EFFECT_TYPE_COMPRESSOR,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({
        ...effect,
        algorithmId: MIXER_COMPRESSOR_ALGORITHM_ID,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({ ...effect, algorithmVersion: 2 } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerLimiterEffect(effect.parameters, 'false' as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerLimiterEffect({
        ...MIXER_LIMITER_DEFAULT_PARAMETERS,
        extra: 1,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerLimiterEffect({
        ...MIXER_LIMITER_DEFAULT_PARAMETERS,
        ceilingDb: undefined,
      } as never),
    ).toThrow(RangeError);
    expect(() =>
      createMixerLimiterEffect({
        ...MIXER_LIMITER_DEFAULT_PARAMETERS,
        releaseMs: '100',
      } as never),
    ).toThrow(RangeError);
  });

  it('rejects every non-finite Limiter parameter', () => {
    for (const key of LIMITER_PARAMETER_NAMES) {
      for (const value of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]) {
        expect(() =>
          createMixerLimiterEffect(
            limiterParameters({ [key]: value }),
            false,
          ),
        ).toThrow(RangeError);
      }
    }
  });

  it('preserves Equalizer and Compressor snapshots and exact state keys', () => {
    const equalizer = createDefaultMixerEqualizerEffect();
    const compressor = createDefaultMixerCompressorEffect();

    expect(createMixerEffectSnapshot(equalizer)).toEqual(equalizer);
    expect(createMixerEffectSnapshot(compressor)).toEqual(compressor);
    expect(Object.keys(createDefaultMixerLimiterEffect()).sort()).toEqual(
      Object.keys(equalizer).sort(),
    );
  });
});

describe('Mixer Echo/Delay Effects Contract v1', () => {
  it('defines the exact immutable default identity and topology intent', () => {
    const effect = createDefaultMixerEchoDelayEffect();

    expect(effect).toEqual({
      effectType: MIXER_EFFECT_TYPE_ECHO_DELAY,
      algorithmId: MIXER_ECHO_DELAY_ALGORITHM_ID,
      algorithmVersion: MIXER_ECHO_DELAY_ALGORITHM_VERSION,
      bypass: true,
      parameters: {
        delayTimeMs: 250,
        dry: 1,
        feedback: 0.3,
        wet: 0.25,
      },
    });
    expect(Object.keys(effect).sort()).toEqual([
      'algorithmId',
      'algorithmVersion',
      'bypass',
      'effectType',
      'parameters',
    ]);
    expect(MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT_VERSION).toBe(1);
    expect(MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT).toEqual({
      effectType: MIXER_EFFECT_TYPE_ECHO_DELAY,
      enabledChainPosition: 'after-compressor',
      insertTarget: 'channel',
      version: MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT_VERSION,
    });
    expect(Object.isFrozen(effect)).toBe(true);
    expect(Object.isFrozen(effect.parameters)).toBe(true);
    expect(Object.isFrozen(MIXER_ECHO_DELAY_DEFAULT_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(MIXER_ECHO_DELAY_PARAMETER_SPECS)).toBe(true);
    expect(Object.isFrozen(MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT)).toBe(true);
  });

  it('copies parameters into a deeply immutable operation snapshot', () => {
    const callerParameters = echoDelayParameters({ delayTimeMs: 500 });
    const effect = createMixerEchoDelayEffect(callerParameters, false);
    const snapshot = createMixerEffectSnapshot(effect);

    (callerParameters as { delayTimeMs: number }).delayTimeMs = 750;

    expect(effect.parameters.delayTimeMs).toBe(500);
    expect(snapshot).not.toBe(effect);
    expect(snapshot.parameters).not.toBe(effect.parameters);
    expect(snapshot).toEqual(effect);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.parameters)).toBe(true);
  });

  it('publishes and accepts every approved parameter boundary', () => {
    expect(MIXER_ECHO_DELAY_PARAMETER_SPECS).toEqual({
      delayTimeMs: { defaultValue: 250, maximum: 2_000, minimum: 10 },
      dry: { defaultValue: 1, maximum: 1, minimum: 0 },
      feedback: { defaultValue: 0.3, maximum: 0.95, minimum: 0 },
      wet: { defaultValue: 0.25, maximum: 1, minimum: 0 },
    });

    for (const boundary of [
      echoDelayParameters({ delayTimeMs: 10 }),
      echoDelayParameters({ delayTimeMs: 2_000 }),
      echoDelayParameters({ feedback: 0 }),
      echoDelayParameters({ feedback: 0.95 }),
      echoDelayParameters({ wet: 0 }),
      echoDelayParameters({ wet: 1 }),
      echoDelayParameters({ dry: 0 }),
      echoDelayParameters({ dry: 1 }),
    ]) {
      expect(() => createMixerEchoDelayEffect(boundary, false)).not.toThrow();
    }
  });

  it.each([
    ['delayTimeMs', 9.999_999],
    ['delayTimeMs', 2_000.000_001],
    ['feedback', -0.000_001],
    ['feedback', 0.950_001],
    ['wet', -0.000_001],
    ['wet', 1.000_001],
    ['dry', -0.000_001],
    ['dry', 1.000_001],
  ] as const)('rejects Echo/Delay %s just outside its range', (key, value) => {
    expect(() =>
      createMixerEchoDelayEffect(
        echoDelayParameters({ [key]: value }),
        false,
      ),
    ).toThrow(RangeError);
  });

  it('rejects exact-key, type, version, sample-rate, and confused union shapes', () => {
    const effect = createDefaultMixerEchoDelayEffect();

    expect(() => createMixerEffectSnapshot(effect, 48_000)).toThrow(RangeError);
    expect(() => createMixerEffectSnapshot(effect, Number.NaN)).toThrow(
      RangeError,
    );
    expect(() =>
      createMixerEffectSnapshot({ ...effect, extra: true } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({
        ...effect,
        effectType: MIXER_EFFECT_TYPE_LIMITER,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({
        ...effect,
        algorithmId: MIXER_LIMITER_ALGORITHM_ID,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEffectSnapshot({ ...effect, algorithmVersion: 2 } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEchoDelayEffect(effect.parameters, 'false' as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEchoDelayEffect({
        ...MIXER_ECHO_DELAY_DEFAULT_PARAMETERS,
        extra: 1,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      createMixerEchoDelayEffect({
        ...MIXER_ECHO_DELAY_DEFAULT_PARAMETERS,
        wet: undefined,
      } as never),
    ).toThrow(RangeError);
    expect(() =>
      createMixerEchoDelayEffect({
        ...MIXER_ECHO_DELAY_DEFAULT_PARAMETERS,
        dry: '1',
      } as never),
    ).toThrow(RangeError);
  });

  it('rejects every non-finite parameter and preserves prior effect snapshots', () => {
    for (const key of ECHO_DELAY_PARAMETER_NAMES) {
      for (const value of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]) {
        expect(() =>
          createMixerEchoDelayEffect(
            echoDelayParameters({ [key]: value }),
            false,
          ),
        ).toThrow(RangeError);
      }
    }

    const equalizer = createDefaultMixerEqualizerEffect();
    const compressor = createDefaultMixerCompressorEffect();
    const limiter = createDefaultMixerLimiterEffect();
    expect(createMixerEffectSnapshot(equalizer)).toEqual(equalizer);
    expect(createMixerEffectSnapshot(compressor)).toEqual(compressor);
    expect(createMixerEffectSnapshot(limiter)).toEqual(limiter);
  });
});
