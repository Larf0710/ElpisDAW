import {
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_DENORMAL_THRESHOLD,
  MIXER_EFFECTS_SAMPLE_RATE_HZ,
  MIXER_EFFECT_TYPE_LIMITER,
  MIXER_LIMITER_ALGORITHM_ID,
  MIXER_LIMITER_ALGORITHM_VERSION,
  assertMixerEffectState,
  createMixerEffectSnapshot,
} from './mixerEffectsContract.js';

export const MIXER_LIMITER_COEFFICIENT_VERSION = 1;
export const MIXER_LIMITER_PROCESSOR_STATE_VERSION = 1;
export const MIXER_LIMITER_CEILING_GUARD_VERSION = 1;

const COEFFICIENT_KEYS = Object.freeze([
  'ceilingLinear',
  'release',
  'version',
]);
const STATE_KEYS = Object.freeze(['reductionDb', 'version']);

/**
 * Creates one immutable stereo-linked zero-lookahead sample-peak Limiter
 * operation. Version 1 constructs ceilingLinear in double precision from
 * 10 ** (ceilingDb / 20), constructs release from
 * exp(-1 / (releaseSeconds * sampleRateHz)), and rounds each once with
 * Math.fround.
 */
export function createMixerLimiterProcessor(
  effect,
  sampleRateHz = MIXER_EFFECTS_SAMPLE_RATE_HZ,
) {
  const effectSnapshot = createMixerEffectSnapshot(effect, sampleRateHz);
  assertLimiterEffect(effectSnapshot);
  const coefficients = Object.freeze({
    ceilingLinear: createCeilingLinear(
      effectSnapshot.parameters.ceilingDb,
    ),
    release: createReleaseCoefficient(
      effectSnapshot.parameters.releaseMs,
      sampleRateHz,
    ),
    version: MIXER_LIMITER_COEFFICIENT_VERSION,
  });

  return freezeProcessor(
    effectSnapshot,
    sampleRateHz,
    coefficients,
    freezeState(0),
  );
}

/**
 * Processes a stereo-linked zero-lookahead sample-peak Limiter with no RMS,
 * true-peak analysis, oversampling, lookahead, latency, normalization, tail,
 * or downstream PCM clamp. Each input sample first becomes a Float32 stage
 * value. Detector dB, target reduction, released reduction state, linear gain,
 * candidate output, and returned output use the version 1 Float32 boundaries.
 *
 * More attenuation adopts the target reduction immediately. Movement toward
 * less attenuation uses release * previous + (1 - release) * target and rounds
 * once after the complete expression. One shared gain is applied to both
 * channels.
 *
 * Ceiling Guard v1 replaces only a candidate whose signed magnitude is above
 * the configured Float32 ceilingLinear with that signed ceiling. It cannot act
 * below the configured ceiling and exists solely to prevent Float32 rounding
 * overshoot after the shared gain multiplication.
 *
 * The complete processor and both input blocks are validated before local DSP
 * state is advanced. Processor snapshots are immutable, so a later numeric
 * failure cannot mutate or partially advance the supplied processor.
 */
export function processMixerLimiterBlock(
  processor,
  leftSamples,
  rightSamples,
) {
  assertProcessor(processor);
  assertSampleBlocks(leftSamples, rightSamples);
  assertFiniteFloat32StageInputs(leftSamples, rightSamples);

  if (processor.effect.bypass) {
    return Object.freeze({
      leftSamples,
      processor,
      rightSamples,
    });
  }

  const leftOutput = new Float32Array(leftSamples.length);
  const rightOutput = new Float32Array(rightSamples.length);
  let reductionDb = canonicalStateValue(processor.state.reductionDb);
  const { ceilingLinear, release } = processor.coefficients;
  const { ceilingDb } = processor.effect.parameters;

  for (let index = 0; index < leftSamples.length; index += 1) {
    const leftInput = Math.fround(leftSamples[index]);
    const rightInput = Math.fround(rightSamples[index]);
    const detectorLevel = Math.fround(
      Math.max(Math.abs(leftInput), Math.abs(rightInput)),
    );
    const targetReductionDb = createTargetReductionDb(
      detectorLevel,
      ceilingDb,
    );
    const nextReductionDb =
      targetReductionDb < reductionDb
        ? targetReductionDb
        : Math.fround(
            release * reductionDb +
              (1 - release) * targetReductionDb,
          );

    if (!Number.isFinite(nextReductionDb) || nextReductionDb > 0) {
      throw new RangeError(
        'Mixer Limiter processing produced invalid reduction state.',
      );
    }
    reductionDb = canonicalStateValue(nextReductionDb);

    const linearGain = Math.fround(10 ** (reductionDb / 20));
    const leftCandidate = Math.fround(leftInput * linearGain);
    const rightCandidate = Math.fround(rightInput * linearGain);

    if (
      !Number.isFinite(linearGain) ||
      linearGain < 0 ||
      linearGain > 1 ||
      !Number.isFinite(leftCandidate) ||
      !Number.isFinite(rightCandidate)
    ) {
      throw new RangeError(
        'Mixer Limiter processing produced non-finite output.',
      );
    }

    leftOutput[index] = applySignedCeilingGuard(
      leftCandidate,
      ceilingLinear,
    );
    rightOutput[index] = applySignedCeilingGuard(
      rightCandidate,
      ceilingLinear,
    );
  }

  return Object.freeze({
    leftSamples: leftOutput,
    processor: freezeProcessor(
      processor.effect,
      processor.sampleRateHz,
      processor.coefficients,
      freezeState(reductionDb),
    ),
    rightSamples: rightOutput,
  });
}

export function resetMixerLimiterProcessor(processor) {
  assertProcessor(processor);
  return freezeProcessor(
    processor.effect,
    processor.sampleRateHz,
    processor.coefficients,
    freezeState(0),
  );
}

function createCeilingLinear(ceilingDb) {
  const ceilingLinear = Math.fround(10 ** (ceilingDb / 20));
  if (
    !Number.isFinite(ceilingLinear) ||
    ceilingLinear <= 0 ||
    ceilingLinear > 1
  ) {
    throw new RangeError('Mixer Limiter ceiling construction failed.');
  }
  return ceilingLinear;
}

function createReleaseCoefficient(releaseMs, sampleRateHz) {
  const releaseSeconds = releaseMs / 1_000;
  const coefficient = Math.fround(
    Math.exp(-1 / (releaseSeconds * sampleRateHz)),
  );
  if (
    !Number.isFinite(coefficient) ||
    coefficient <= 0 ||
    coefficient >= 1
  ) {
    throw new RangeError('Mixer Limiter release construction failed.');
  }
  return coefficient;
}

function createTargetReductionDb(detectorLevel, ceilingDb) {
  if (detectorLevel === 0) {
    return 0;
  }

  const detectorDb = Math.fround(20 * Math.log10(detectorLevel));
  const targetReductionDb = Math.fround(
    Math.min(0, ceilingDb - detectorDb),
  );
  if (!Number.isFinite(targetReductionDb) || targetReductionDb > 0) {
    throw new RangeError(
      'Mixer Limiter target reduction must be finite and non-positive.',
    );
  }
  return targetReductionDb;
}

function applySignedCeilingGuard(sample, ceilingLinear) {
  if (sample > ceilingLinear) {
    return ceilingLinear;
  }
  if (sample < -ceilingLinear) {
    return -ceilingLinear;
  }
  return sample;
}

function canonicalStateValue(value) {
  const rounded = Math.fround(value);
  return Math.abs(rounded) < MIXER_EFFECTS_DENORMAL_THRESHOLD ? 0 : rounded;
}

function freezeState(reductionDb) {
  return Object.freeze({
    reductionDb,
    version: MIXER_LIMITER_PROCESSOR_STATE_VERSION,
  });
}

function freezeProcessor(effect, sampleRateHz, coefficients, state) {
  return Object.freeze({
    coefficients,
    contractVersion: MIXER_EFFECTS_CONTRACT_VERSION,
    effect,
    sampleRateHz,
    state,
  });
}

function assertProcessor(processor) {
  if (
    !isFrozenRecord(processor) ||
    !hasExactKeys(processor, [
      'coefficients',
      'contractVersion',
      'effect',
      'sampleRateHz',
      'state',
    ]) ||
    processor.contractVersion !== MIXER_EFFECTS_CONTRACT_VERSION ||
    processor.sampleRateHz !== MIXER_EFFECTS_SAMPLE_RATE_HZ
  ) {
    throw new TypeError('Mixer Limiter processor is invalid.');
  }

  assertLimiterEffect(processor.effect);
  if (
    !isFrozenRecord(processor.effect) ||
    !isFrozenRecord(processor.effect.parameters)
  ) {
    throw new TypeError('Mixer Limiter processor effect is invalid.');
  }
  assertCoefficients(processor.coefficients);
  assertState(processor.state);
}

function assertLimiterEffect(effect) {
  assertMixerEffectState(effect, MIXER_EFFECTS_SAMPLE_RATE_HZ);
  if (
    effect.effectType !== MIXER_EFFECT_TYPE_LIMITER ||
    effect.algorithmId !== MIXER_LIMITER_ALGORITHM_ID ||
    effect.algorithmVersion !== MIXER_LIMITER_ALGORITHM_VERSION
  ) {
    throw new TypeError('Mixer Limiter effect identity is invalid.');
  }
}

function assertCoefficients(coefficients) {
  if (
    !isFrozenRecord(coefficients) ||
    !hasExactKeys(coefficients, COEFFICIENT_KEYS) ||
    coefficients.version !== MIXER_LIMITER_COEFFICIENT_VERSION ||
    !Number.isFinite(coefficients.ceilingLinear) ||
    Math.fround(coefficients.ceilingLinear) !== coefficients.ceilingLinear ||
    coefficients.ceilingLinear <= 0 ||
    coefficients.ceilingLinear > 1 ||
    !Number.isFinite(coefficients.release) ||
    Math.fround(coefficients.release) !== coefficients.release ||
    coefficients.release <= 0 ||
    coefficients.release >= 1
  ) {
    throw new TypeError('Mixer Limiter coefficients are invalid.');
  }
}

function assertState(state) {
  if (
    !isFrozenRecord(state) ||
    !hasExactKeys(state, STATE_KEYS) ||
    state.version !== MIXER_LIMITER_PROCESSOR_STATE_VERSION ||
    !Number.isFinite(state.reductionDb) ||
    Math.fround(state.reductionDb) !== state.reductionDb ||
    state.reductionDb > 0 ||
    (state.reductionDb !== 0 &&
      Math.abs(state.reductionDb) < MIXER_EFFECTS_DENORMAL_THRESHOLD)
  ) {
    throw new TypeError('Mixer Limiter processor state is invalid.');
  }
}

function assertSampleBlocks(leftSamples, rightSamples) {
  if (
    !isSampleBlock(leftSamples) ||
    !isSampleBlock(rightSamples) ||
    leftSamples.length !== rightSamples.length
  ) {
    throw new TypeError(
      'Mixer Limiter sample blocks must be equal-length numeric arrays.',
    );
  }
}

function assertFiniteFloat32StageInputs(leftSamples, rightSamples) {
  for (let index = 0; index < leftSamples.length; index += 1) {
    const leftSample = leftSamples[index];
    const rightSample = rightSamples[index];
    if (
      !Number.isFinite(leftSample) ||
      !Number.isFinite(rightSample) ||
      !Number.isFinite(Math.fround(leftSample)) ||
      !Number.isFinite(Math.fround(rightSample))
    ) {
      throw new RangeError(
        'Mixer Limiter input samples must be finite Float32 stage values.',
      );
    }
  }
}

function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value);
  const expectedKeys = new Set(keys);
  return (
    actualKeys.length === keys.length &&
    actualKeys.every((key) => expectedKeys.has(key))
  );
}

function isFrozenRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.isFrozen(value)
  );
}

function isSampleBlock(value) {
  return (
    Array.isArray(value) ||
    value instanceof Float32Array ||
    value instanceof Float64Array
  );
}
