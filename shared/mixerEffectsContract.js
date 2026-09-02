export const MIXER_EFFECTS_CONTRACT_VERSION = 1;
export const MIXER_EFFECTS_SAMPLE_RATE_HZ = 44_100;
export const MIXER_EFFECTS_DENORMAL_THRESHOLD = 1e-20;

export const MIXER_EFFECT_TYPE_EQUALIZER = 'equalizer';
export const MIXER_EQUALIZER_ALGORITHM_ID =
  'humstudio.equalizer.3band-tdf2.v1';
export const MIXER_EQUALIZER_ALGORITHM_VERSION = 1;
export const MIXER_EQUALIZER_SHELF_SLOPE = 1;
export const MIXER_EQUALIZER_STAGE_ORDER = Object.freeze([
  'low-shelf',
  'peaking-mid',
  'high-shelf',
]);

export const MIXER_EFFECT_TYPE_COMPRESSOR = 'compressor';
export const MIXER_COMPRESSOR_ALGORITHM_ID =
  'humstudio.compressor.linked-peak.v1';
export const MIXER_COMPRESSOR_ALGORITHM_VERSION = 1;

export const MIXER_EFFECT_TYPE_LIMITER = 'limiter';
export const MIXER_LIMITER_ALGORITHM_ID =
  'humstudio.limiter.linked-sample-peak.v1';
export const MIXER_LIMITER_ALGORITHM_VERSION = 1;
export const MIXER_LIMITER_TOPOLOGY_INVARIANT_VERSION = 1;
export const MIXER_LIMITER_TOPOLOGY_INVARIANT = Object.freeze({
  effectType: MIXER_EFFECT_TYPE_LIMITER,
  enabledChainPosition: 'last',
  insertTarget: 'master',
  version: MIXER_LIMITER_TOPOLOGY_INVARIANT_VERSION,
});

export const MIXER_EFFECT_TYPE_ECHO_DELAY = 'echo-delay';
export const MIXER_ECHO_DELAY_ALGORITHM_ID =
  'humstudio.echo-delay.stereo-feedback.v1';
export const MIXER_ECHO_DELAY_ALGORITHM_VERSION = 1;
export const MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT_VERSION = 1;
export const MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT = Object.freeze({
  effectType: MIXER_EFFECT_TYPE_ECHO_DELAY,
  enabledChainPosition: 'after-compressor',
  insertTarget: 'channel',
  version: MIXER_ECHO_DELAY_TOPOLOGY_INVARIANT_VERSION,
});

const EQUALIZER_PARAMETER_KEYS = Object.freeze([
  'highFrequencyHz',
  'highGainDb',
  'lowFrequencyHz',
  'lowGainDb',
  'midFrequencyHz',
  'midGainDb',
  'midQ',
]);

const COMPRESSOR_PARAMETER_KEYS = Object.freeze([
  'attackMs',
  'kneeDb',
  'makeupGainDb',
  'ratio',
  'releaseMs',
  'thresholdDb',
]);

const LIMITER_PARAMETER_KEYS = Object.freeze([
  'ceilingDb',
  'releaseMs',
]);

const ECHO_DELAY_PARAMETER_KEYS = Object.freeze([
  'delayTimeMs',
  'dry',
  'feedback',
  'wet',
]);

export const MIXER_EQUALIZER_PARAMETER_SPECS = Object.freeze({
  highFrequencyHz: freezeParameterSpec(2_000, 16_000, 8_000),
  highGainDb: freezeParameterSpec(-12, 12, 0),
  lowFrequencyHz: freezeParameterSpec(40, 400, 120),
  lowGainDb: freezeParameterSpec(-12, 12, 0),
  midFrequencyHz: freezeParameterSpec(200, 8_000, 1_000),
  midGainDb: freezeParameterSpec(-12, 12, 0),
  midQ: freezeParameterSpec(0.25, 4, 1),
});

export const MIXER_EQUALIZER_DEFAULT_PARAMETERS = freezeEqualizerParameters({
  highFrequencyHz: MIXER_EQUALIZER_PARAMETER_SPECS.highFrequencyHz.defaultValue,
  highGainDb: MIXER_EQUALIZER_PARAMETER_SPECS.highGainDb.defaultValue,
  lowFrequencyHz: MIXER_EQUALIZER_PARAMETER_SPECS.lowFrequencyHz.defaultValue,
  lowGainDb: MIXER_EQUALIZER_PARAMETER_SPECS.lowGainDb.defaultValue,
  midFrequencyHz: MIXER_EQUALIZER_PARAMETER_SPECS.midFrequencyHz.defaultValue,
  midGainDb: MIXER_EQUALIZER_PARAMETER_SPECS.midGainDb.defaultValue,
  midQ: MIXER_EQUALIZER_PARAMETER_SPECS.midQ.defaultValue,
});

export const MIXER_COMPRESSOR_PARAMETER_SPECS = Object.freeze({
  attackMs: freezeParameterSpec(0.1, 100, 10),
  kneeDb: freezeParameterSpec(0, 24, 6),
  makeupGainDb: freezeParameterSpec(-24, 24, 0),
  ratio: freezeParameterSpec(1, 20, 4),
  releaseMs: freezeParameterSpec(10, 1_000, 100),
  thresholdDb: freezeParameterSpec(-60, 0, -18),
});

export const MIXER_COMPRESSOR_DEFAULT_PARAMETERS =
  freezeCompressorParameters({
    attackMs: MIXER_COMPRESSOR_PARAMETER_SPECS.attackMs.defaultValue,
    kneeDb: MIXER_COMPRESSOR_PARAMETER_SPECS.kneeDb.defaultValue,
    makeupGainDb:
      MIXER_COMPRESSOR_PARAMETER_SPECS.makeupGainDb.defaultValue,
    ratio: MIXER_COMPRESSOR_PARAMETER_SPECS.ratio.defaultValue,
    releaseMs: MIXER_COMPRESSOR_PARAMETER_SPECS.releaseMs.defaultValue,
    thresholdDb: MIXER_COMPRESSOR_PARAMETER_SPECS.thresholdDb.defaultValue,
  });

export const MIXER_LIMITER_PARAMETER_SPECS = Object.freeze({
  ceilingDb: freezeParameterSpec(-12, 0, -0.3),
  releaseMs: freezeParameterSpec(10, 1_000, 100),
});

export const MIXER_LIMITER_DEFAULT_PARAMETERS = freezeLimiterParameters({
  ceilingDb: MIXER_LIMITER_PARAMETER_SPECS.ceilingDb.defaultValue,
  releaseMs: MIXER_LIMITER_PARAMETER_SPECS.releaseMs.defaultValue,
});

export const MIXER_ECHO_DELAY_PARAMETER_SPECS = Object.freeze({
  delayTimeMs: freezeParameterSpec(10, 2_000, 250),
  dry: freezeParameterSpec(0, 1, 1),
  feedback: freezeParameterSpec(0, 0.95, 0.3),
  wet: freezeParameterSpec(0, 1, 0.25),
});

export const MIXER_ECHO_DELAY_DEFAULT_PARAMETERS =
  freezeEchoDelayParameters({
    delayTimeMs: MIXER_ECHO_DELAY_PARAMETER_SPECS.delayTimeMs.defaultValue,
    dry: MIXER_ECHO_DELAY_PARAMETER_SPECS.dry.defaultValue,
    feedback: MIXER_ECHO_DELAY_PARAMETER_SPECS.feedback.defaultValue,
    wet: MIXER_ECHO_DELAY_PARAMETER_SPECS.wet.defaultValue,
  });

/**
 * Effects Contract v1 supports exact Equalizer, Compressor, Limiter, and
 * Echo/Delay identity shapes. Parameters are copied into an immutable
 * operation snapshot. A new snapshot and processor are required for parameter
 * changes, play/render start, seek, or restart; v1 has no automation or live
 * parameter smoothing. Topology invariants describe future fixed product
 * chains but this shared contract does not wire or enforce those chains.
 */
export function createMixerEqualizerEffect(
  parameters = MIXER_EQUALIZER_DEFAULT_PARAMETERS,
  bypass = true,
) {
  if (typeof bypass !== 'boolean') {
    throw new TypeError('Mixer effect bypass must be a boolean.');
  }

  assertMixerEqualizerParameters(parameters, MIXER_EFFECTS_SAMPLE_RATE_HZ);

  return Object.freeze({
    effectType: MIXER_EFFECT_TYPE_EQUALIZER,
    algorithmId: MIXER_EQUALIZER_ALGORITHM_ID,
    algorithmVersion: MIXER_EQUALIZER_ALGORITHM_VERSION,
    bypass,
    parameters: freezeEqualizerParameters(parameters),
  });
}

export function createDefaultMixerEqualizerEffect() {
  return createMixerEqualizerEffect();
}

export function createMixerCompressorEffect(
  parameters = MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
  bypass = true,
) {
  if (typeof bypass !== 'boolean') {
    throw new TypeError('Mixer effect bypass must be a boolean.');
  }

  assertMixerCompressorParameters(parameters, MIXER_EFFECTS_SAMPLE_RATE_HZ);

  return Object.freeze({
    effectType: MIXER_EFFECT_TYPE_COMPRESSOR,
    algorithmId: MIXER_COMPRESSOR_ALGORITHM_ID,
    algorithmVersion: MIXER_COMPRESSOR_ALGORITHM_VERSION,
    bypass,
    parameters: freezeCompressorParameters(parameters),
  });
}

export function createDefaultMixerCompressorEffect() {
  return createMixerCompressorEffect();
}

export function createMixerLimiterEffect(
  parameters = MIXER_LIMITER_DEFAULT_PARAMETERS,
  bypass = true,
) {
  if (typeof bypass !== 'boolean') {
    throw new TypeError('Mixer effect bypass must be a boolean.');
  }

  assertMixerLimiterParameters(parameters, MIXER_EFFECTS_SAMPLE_RATE_HZ);

  return Object.freeze({
    effectType: MIXER_EFFECT_TYPE_LIMITER,
    algorithmId: MIXER_LIMITER_ALGORITHM_ID,
    algorithmVersion: MIXER_LIMITER_ALGORITHM_VERSION,
    bypass,
    parameters: freezeLimiterParameters(parameters),
  });
}

export function createDefaultMixerLimiterEffect() {
  return createMixerLimiterEffect();
}

export function createMixerEchoDelayEffect(
  parameters = MIXER_ECHO_DELAY_DEFAULT_PARAMETERS,
  bypass = true,
) {
  if (typeof bypass !== 'boolean') {
    throw new TypeError('Mixer effect bypass must be a boolean.');
  }

  assertMixerEchoDelayParameters(parameters, MIXER_EFFECTS_SAMPLE_RATE_HZ);

  return Object.freeze({
    effectType: MIXER_EFFECT_TYPE_ECHO_DELAY,
    algorithmId: MIXER_ECHO_DELAY_ALGORITHM_ID,
    algorithmVersion: MIXER_ECHO_DELAY_ALGORITHM_VERSION,
    bypass,
    parameters: freezeEchoDelayParameters(parameters),
  });
}

export function createDefaultMixerEchoDelayEffect() {
  return createMixerEchoDelayEffect();
}

export function createMixerEffectSnapshot(
  effect,
  sampleRateHz = MIXER_EFFECTS_SAMPLE_RATE_HZ,
) {
  assertMixerEffectState(effect, sampleRateHz);

  const parameters = freezeEffectParameters(effect);

  return Object.freeze({
    effectType: effect.effectType,
    algorithmId: effect.algorithmId,
    algorithmVersion: effect.algorithmVersion,
    bypass: effect.bypass,
    parameters,
  });
}

export function assertMixerEffectState(
  effect,
  sampleRateHz = MIXER_EFFECTS_SAMPLE_RATE_HZ,
) {
  assertMixerEffectsSampleRate(sampleRateHz);

  if (
    !isRecord(effect) ||
    !hasExactKeys(effect, [
      'effectType',
      'algorithmId',
      'algorithmVersion',
      'bypass',
      'parameters',
    ])
  ) {
    throw new TypeError('Mixer effect identity is unsupported or malformed.');
  }

  if (typeof effect.bypass !== 'boolean') {
    throw new TypeError('Mixer effect bypass must be a boolean.');
  }

  if (
    effect.effectType === MIXER_EFFECT_TYPE_EQUALIZER &&
    effect.algorithmId === MIXER_EQUALIZER_ALGORITHM_ID &&
    effect.algorithmVersion === MIXER_EQUALIZER_ALGORITHM_VERSION
  ) {
    assertMixerEqualizerParameters(effect.parameters, sampleRateHz);
    return;
  }

  if (
    effect.effectType === MIXER_EFFECT_TYPE_COMPRESSOR &&
    effect.algorithmId === MIXER_COMPRESSOR_ALGORITHM_ID &&
    effect.algorithmVersion === MIXER_COMPRESSOR_ALGORITHM_VERSION
  ) {
    assertMixerCompressorParameters(effect.parameters, sampleRateHz);
    return;
  }

  if (
    effect.effectType === MIXER_EFFECT_TYPE_LIMITER &&
    effect.algorithmId === MIXER_LIMITER_ALGORITHM_ID &&
    effect.algorithmVersion === MIXER_LIMITER_ALGORITHM_VERSION
  ) {
    assertMixerLimiterParameters(effect.parameters, sampleRateHz);
    return;
  }

  if (
    effect.effectType === MIXER_EFFECT_TYPE_ECHO_DELAY &&
    effect.algorithmId === MIXER_ECHO_DELAY_ALGORITHM_ID &&
    effect.algorithmVersion === MIXER_ECHO_DELAY_ALGORITHM_VERSION
  ) {
    assertMixerEchoDelayParameters(effect.parameters, sampleRateHz);
    return;
  }

  throw new TypeError('Mixer effect identity is unsupported or malformed.');
}

export function assertMixerEffectsSampleRate(sampleRateHz) {
  if (sampleRateHz !== MIXER_EFFECTS_SAMPLE_RATE_HZ) {
    throw new RangeError(
      `Mixer Effects Contract v1 requires ${MIXER_EFFECTS_SAMPLE_RATE_HZ} Hz.`,
    );
  }
}

export function assertMixerEqualizerParameters(
  parameters,
  sampleRateHz = MIXER_EFFECTS_SAMPLE_RATE_HZ,
) {
  assertMixerEffectsSampleRate(sampleRateHz);

  if (
    !isRecord(parameters) ||
    !hasExactKeys(parameters, EQUALIZER_PARAMETER_KEYS)
  ) {
    throw new TypeError('Mixer Equalizer parameters are incomplete or malformed.');
  }

  for (const key of EQUALIZER_PARAMETER_KEYS) {
    const value = parameters[key];
    const spec = MIXER_EQUALIZER_PARAMETER_SPECS[key];

    if (
      !Number.isFinite(value) ||
      value < spec.minimum ||
      value > spec.maximum
    ) {
      throw new RangeError(
        `Mixer Equalizer ${key} must be finite and within its legal range.`,
      );
    }
  }

  if (
    !(
      parameters.lowFrequencyHz < parameters.midFrequencyHz &&
      parameters.midFrequencyHz < parameters.highFrequencyHz
    )
  ) {
    throw new RangeError(
      'Mixer Equalizer frequencies must be strictly ordered low, mid, then high.',
    );
  }

  if (parameters.highFrequencyHz > 0.45 * sampleRateHz) {
    throw new RangeError(
      'Mixer Equalizer highFrequencyHz must not exceed 0.45 times the sample rate.',
    );
  }
}

export function assertMixerCompressorParameters(
  parameters,
  sampleRateHz = MIXER_EFFECTS_SAMPLE_RATE_HZ,
) {
  assertMixerEffectsSampleRate(sampleRateHz);

  if (
    !isRecord(parameters) ||
    !hasExactKeys(parameters, COMPRESSOR_PARAMETER_KEYS)
  ) {
    throw new TypeError(
      'Mixer Compressor parameters are incomplete or malformed.',
    );
  }

  for (const key of COMPRESSOR_PARAMETER_KEYS) {
    const value = parameters[key];
    const spec = MIXER_COMPRESSOR_PARAMETER_SPECS[key];

    if (
      !Number.isFinite(value) ||
      value < spec.minimum ||
      value > spec.maximum
    ) {
      throw new RangeError(
        `Mixer Compressor ${key} must be finite and within its legal range.`,
      );
    }
  }
}

export function assertMixerLimiterParameters(
  parameters,
  sampleRateHz = MIXER_EFFECTS_SAMPLE_RATE_HZ,
) {
  assertMixerEffectsSampleRate(sampleRateHz);

  if (
    !isRecord(parameters) ||
    !hasExactKeys(parameters, LIMITER_PARAMETER_KEYS)
  ) {
    throw new TypeError(
      'Mixer Limiter parameters are incomplete or malformed.',
    );
  }

  for (const key of LIMITER_PARAMETER_KEYS) {
    const value = parameters[key];
    const spec = MIXER_LIMITER_PARAMETER_SPECS[key];

    if (
      !Number.isFinite(value) ||
      value < spec.minimum ||
      value > spec.maximum
    ) {
      throw new RangeError(
        `Mixer Limiter ${key} must be finite and within its legal range.`,
      );
    }
  }
}

export function assertMixerEchoDelayParameters(
  parameters,
  sampleRateHz = MIXER_EFFECTS_SAMPLE_RATE_HZ,
) {
  assertMixerEffectsSampleRate(sampleRateHz);

  if (
    !isRecord(parameters) ||
    !hasExactKeys(parameters, ECHO_DELAY_PARAMETER_KEYS)
  ) {
    throw new TypeError(
      'Mixer Echo/Delay parameters are incomplete or malformed.',
    );
  }

  for (const key of ECHO_DELAY_PARAMETER_KEYS) {
    const value = parameters[key];
    const spec = MIXER_ECHO_DELAY_PARAMETER_SPECS[key];

    if (
      !Number.isFinite(value) ||
      value < spec.minimum ||
      value > spec.maximum
    ) {
      throw new RangeError(
        `Mixer Echo/Delay ${key} must be finite and within its legal range.`,
      );
    }
  }
}

function freezeEffectParameters(effect) {
  if (effect.effectType === MIXER_EFFECT_TYPE_EQUALIZER) {
    return freezeEqualizerParameters(effect.parameters);
  }
  if (effect.effectType === MIXER_EFFECT_TYPE_COMPRESSOR) {
    return freezeCompressorParameters(effect.parameters);
  }
  if (effect.effectType === MIXER_EFFECT_TYPE_LIMITER) {
    return freezeLimiterParameters(effect.parameters);
  }
  if (effect.effectType === MIXER_EFFECT_TYPE_ECHO_DELAY) {
    return freezeEchoDelayParameters(effect.parameters);
  }

  throw new TypeError('Mixer effect identity is unsupported or malformed.');
}

function freezeEqualizerParameters(parameters) {
  return Object.freeze({
    highFrequencyHz: parameters.highFrequencyHz,
    highGainDb: parameters.highGainDb,
    lowFrequencyHz: parameters.lowFrequencyHz,
    lowGainDb: parameters.lowGainDb,
    midFrequencyHz: parameters.midFrequencyHz,
    midGainDb: parameters.midGainDb,
    midQ: parameters.midQ,
  });
}

function freezeCompressorParameters(parameters) {
  return Object.freeze({
    attackMs: parameters.attackMs,
    kneeDb: parameters.kneeDb,
    makeupGainDb: parameters.makeupGainDb,
    ratio: parameters.ratio,
    releaseMs: parameters.releaseMs,
    thresholdDb: parameters.thresholdDb,
  });
}

function freezeLimiterParameters(parameters) {
  return Object.freeze({
    ceilingDb: parameters.ceilingDb,
    releaseMs: parameters.releaseMs,
  });
}

function freezeEchoDelayParameters(parameters) {
  return Object.freeze({
    delayTimeMs: parameters.delayTimeMs,
    dry: parameters.dry,
    feedback: parameters.feedback,
    wet: parameters.wet,
  });
}

function freezeParameterSpec(minimum, maximum, defaultValue) {
  return Object.freeze({ defaultValue, maximum, minimum });
}

function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value);
  const expectedKeys = new Set(keys);
  return (
    actualKeys.length === keys.length &&
    actualKeys.every((key) => expectedKeys.has(key))
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
