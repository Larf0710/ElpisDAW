import {
  MIXER_COMPRESSOR_ALGORITHM_ID,
  MIXER_COMPRESSOR_ALGORITHM_VERSION,
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_DENORMAL_THRESHOLD,
  MIXER_EFFECTS_SAMPLE_RATE_HZ,
  MIXER_EFFECT_TYPE_COMPRESSOR,
  assertMixerEffectState,
  createMixerEffectSnapshot,
} from './mixerEffectsContract.js';

export const MIXER_COMPRESSOR_COEFFICIENT_VERSION = 1;
export const MIXER_COMPRESSOR_PROCESSOR_STATE_VERSION = 1;

const COEFFICIENT_KEYS = Object.freeze([
  'attack',
  'release',
  'version',
]);
const STATE_KEYS = Object.freeze(['reductionDb', 'version']);

/**
 * Creates one immutable stereo-linked peak Compressor operation. Version 1
 * constructs each one-pole coefficient in double precision from
 * exp(-1 / (timeSeconds * sampleRateHz)), then rounds it once with Math.fround.
 */
export function createMixerCompressorProcessor(
  effect,
  sampleRateHz = MIXER_EFFECTS_SAMPLE_RATE_HZ,
) {
  const effectSnapshot = createMixerEffectSnapshot(effect, sampleRateHz);
  assertCompressorEffect(effectSnapshot);
  const coefficients = Object.freeze({
    attack: createTimeCoefficient(
      effectSnapshot.parameters.attackMs,
      sampleRateHz,
    ),
    release: createTimeCoefficient(
      effectSnapshot.parameters.releaseMs,
      sampleRateHz,
    ),
    version: MIXER_COMPRESSOR_COEFFICIENT_VERSION,
  });

  return freezeProcessor(
    effectSnapshot,
    sampleRateHz,
    coefficients,
    freezeState(0),
  );
}

/**
 * Processes a feed-forward stereo-linked sample-peak Compressor with no
 * lookahead, latency, normalization, or output clamp. Each input sample first
 * becomes a Float32 stage value. Detector dB, static target reduction,
 * smoothed reduction state, combined gain dB, linear gain, and output samples
 * are each rounded at their documented stage boundary with Math.fround.
 *
 * Persistent reduction state is non-positive dB. Attack is selected while the
 * target moves toward more attenuation; release is selected while it moves
 * toward less attenuation. The state equation is rounded once after the full
 * coefficient * previous + (1 - coefficient) * target expression.
 *
 * The complete processor and both input blocks are validated before local DSP
 * state is advanced. Processor snapshots are immutable, so any later numeric
 * failure throws without returning partially advanced state or output.
 */
export function processMixerCompressorBlock(
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
  const { attack, release } = processor.coefficients;
  const parameters = processor.effect.parameters;

  for (let index = 0; index < leftSamples.length; index += 1) {
    const leftInput = Math.fround(leftSamples[index]);
    const rightInput = Math.fround(rightSamples[index]);
    const detectorLevel = Math.fround(
      Math.max(Math.abs(leftInput), Math.abs(rightInput)),
    );
    const targetReductionDb = createTargetReductionDb(
      detectorLevel,
      parameters,
    );
    const coefficient =
      targetReductionDb < reductionDb ? attack : release;
    const nextReductionDb = Math.fround(
      coefficient * reductionDb +
        (1 - coefficient) * targetReductionDb,
    );

    if (!Number.isFinite(nextReductionDb) || nextReductionDb > 0) {
      throw new RangeError(
        'Mixer Compressor processing produced invalid reduction state.',
      );
    }
    reductionDb = canonicalStateValue(nextReductionDb);

    const combinedGainDb = Math.fround(
      reductionDb + parameters.makeupGainDb,
    );
    const linearGain = Math.fround(10 ** (combinedGainDb / 20));
    const leftSample = Math.fround(leftInput * linearGain);
    const rightSample = Math.fround(rightInput * linearGain);

    if (
      !Number.isFinite(combinedGainDb) ||
      !Number.isFinite(linearGain) ||
      !Number.isFinite(leftSample) ||
      !Number.isFinite(rightSample)
    ) {
      throw new RangeError(
        'Mixer Compressor processing produced non-finite output.',
      );
    }

    leftOutput[index] = leftSample;
    rightOutput[index] = rightSample;
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

export function resetMixerCompressorProcessor(processor) {
  assertProcessor(processor);
  return freezeProcessor(
    processor.effect,
    processor.sampleRateHz,
    processor.coefficients,
    freezeState(0),
  );
}

function createTimeCoefficient(timeMs, sampleRateHz) {
  const timeSeconds = timeMs / 1_000;
  const coefficient = Math.fround(
    Math.exp(-1 / (timeSeconds * sampleRateHz)),
  );

  if (
    !Number.isFinite(coefficient) ||
    coefficient <= 0 ||
    coefficient >= 1
  ) {
    throw new RangeError('Mixer Compressor coefficient construction failed.');
  }

  return coefficient;
}

function createTargetReductionDb(detectorLevel, parameters) {
  if (detectorLevel === 0) {
    return 0;
  }

  const detectorDb = Math.fround(20 * Math.log10(detectorLevel));
  if (!Number.isFinite(detectorDb)) {
    throw new RangeError('Mixer Compressor detector produced non-finite dB.');
  }

  const slopeChange = 1 / parameters.ratio - 1;
  const distanceFromThreshold = detectorDb - parameters.thresholdDb;

  if (parameters.kneeDb === 0) {
    return detectorDb <= parameters.thresholdDb
      ? 0
      : finiteReduction(
          slopeChange * distanceFromThreshold,
        );
  }

  const halfKneeDb = parameters.kneeDb / 2;
  if (detectorDb < parameters.thresholdDb - halfKneeDb) {
    return 0;
  }
  if (detectorDb > parameters.thresholdDb + halfKneeDb) {
    return finiteReduction(slopeChange * distanceFromThreshold);
  }

  const kneePosition =
    detectorDb - parameters.thresholdDb + halfKneeDb;
  return finiteReduction(
    (slopeChange * kneePosition * kneePosition) /
      (2 * parameters.kneeDb),
  );
}

function finiteReduction(value) {
  const reductionDb = Math.fround(value);
  if (!Number.isFinite(reductionDb) || reductionDb > 0) {
    throw new RangeError('Mixer Compressor target reduction must be finite.');
  }
  return reductionDb;
}

function canonicalStateValue(value) {
  const rounded = Math.fround(value);
  return Math.abs(rounded) < MIXER_EFFECTS_DENORMAL_THRESHOLD ? 0 : rounded;
}

function freezeState(reductionDb) {
  return Object.freeze({
    reductionDb,
    version: MIXER_COMPRESSOR_PROCESSOR_STATE_VERSION,
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
    throw new TypeError('Mixer Compressor processor is invalid.');
  }

  assertCompressorEffect(processor.effect);
  if (
    !isFrozenRecord(processor.effect) ||
    !isFrozenRecord(processor.effect.parameters)
  ) {
    throw new TypeError('Mixer Compressor processor effect is invalid.');
  }
  assertCoefficients(processor.coefficients);
  assertState(processor.state);
}

function assertCompressorEffect(effect) {
  assertMixerEffectState(effect, MIXER_EFFECTS_SAMPLE_RATE_HZ);
  if (
    effect.effectType !== MIXER_EFFECT_TYPE_COMPRESSOR ||
    effect.algorithmId !== MIXER_COMPRESSOR_ALGORITHM_ID ||
    effect.algorithmVersion !== MIXER_COMPRESSOR_ALGORITHM_VERSION
  ) {
    throw new TypeError('Mixer Compressor effect identity is invalid.');
  }
}

function assertCoefficients(coefficients) {
  if (
    !isFrozenRecord(coefficients) ||
    !hasExactKeys(coefficients, COEFFICIENT_KEYS) ||
    coefficients.version !== MIXER_COMPRESSOR_COEFFICIENT_VERSION ||
    ![coefficients.attack, coefficients.release].every(
      (value) =>
        Number.isFinite(value) &&
        Math.fround(value) === value &&
        value > 0 &&
        value < 1,
    )
  ) {
    throw new TypeError('Mixer Compressor coefficients are invalid.');
  }
}

function assertState(state) {
  if (
    !isFrozenRecord(state) ||
    !hasExactKeys(state, STATE_KEYS) ||
    state.version !== MIXER_COMPRESSOR_PROCESSOR_STATE_VERSION ||
    !Number.isFinite(state.reductionDb) ||
    Math.fround(state.reductionDb) !== state.reductionDb ||
    state.reductionDb > 0 ||
    (state.reductionDb !== 0 &&
      Math.abs(state.reductionDb) < MIXER_EFFECTS_DENORMAL_THRESHOLD)
  ) {
    throw new TypeError('Mixer Compressor processor state is invalid.');
  }
}

function assertSampleBlocks(leftSamples, rightSamples) {
  if (
    !isSampleBlock(leftSamples) ||
    !isSampleBlock(rightSamples) ||
    leftSamples.length !== rightSamples.length
  ) {
    throw new TypeError(
      'Mixer Compressor sample blocks must be equal-length numeric arrays.',
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
        'Mixer Compressor input samples must be finite Float32 stage values.',
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
