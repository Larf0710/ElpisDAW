import {
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_DENORMAL_THRESHOLD,
  MIXER_EFFECTS_SAMPLE_RATE_HZ,
  MIXER_EQUALIZER_ALGORITHM_ID,
  MIXER_EQUALIZER_ALGORITHM_VERSION,
  MIXER_EQUALIZER_SHELF_SLOPE,
  assertMixerEffectState,
  createMixerEffectSnapshot,
} from './mixerEffectsContract.js';

export const MIXER_EQUALIZER_COEFFICIENT_VERSION = 1;
export const MIXER_EQUALIZER_PROCESSOR_STATE_VERSION = 1;

const BIQUAD_COEFFICIENT_KEYS = Object.freeze([
  'a1',
  'a2',
  'b0',
  'b1',
  'b2',
  'version',
]);
const BIQUAD_STATE_KEYS = Object.freeze(['z1', 'z2']);
const CHANNEL_STATE_KEYS = Object.freeze([
  'highShelf',
  'lowShelf',
  'midPeaking',
]);

/**
 * Creates the complete immutable configuration and zeroed persistent state for
 * one Equalizer operation. Coefficients are constructed in double precision,
 * normalized by a0, then rounded once with Math.fround for v1 reproducibility.
 */
export function createMixerEqualizerProcessor(
  effect,
  sampleRateHz = MIXER_EFFECTS_SAMPLE_RATE_HZ,
) {
  const effectSnapshot = createMixerEffectSnapshot(effect, sampleRateHz);
  const coefficients = createMixerEqualizerCoefficients(
    effectSnapshot.parameters,
    sampleRateHz,
  );

  return freezeProcessor(
    effectSnapshot,
    sampleRateHz,
    coefficients,
    createZeroProcessorState(),
  );
}

/**
 * Processes low shelf -> peaking mid -> high shelf in stereo-independent TDF2.
 * Every stage output and persistent state value is rounded with Math.fround.
 * Persistent magnitudes below 1e-20 are canonicalized to positive zero.
 *
 * Bypass validates samples but returns the original sample blocks and the same
 * processor reference, so it is sample-transparent and cannot advance state.
 * The enabled kernel has zero algorithmic latency. Ending an operation simply
 * discards its processor; v1 exposes no tail-drain behavior.
 */
export function processMixerEqualizerBlock(
  processor,
  leftSamples,
  rightSamples,
) {
  assertProcessor(processor);
  assertSampleBlocks(leftSamples, rightSamples);
  assertFiniteSamples(leftSamples, rightSamples);

  if (processor.effect.bypass) {
    return Object.freeze({
      leftSamples,
      processor,
      rightSamples,
    });
  }

  const leftState = createMutableChannelState(processor.state.left);
  const rightState = createMutableChannelState(processor.state.right);
  const leftOutput = new Float32Array(leftSamples.length);
  const rightOutput = new Float32Array(rightSamples.length);
  const { lowShelf, midPeaking, highShelf } = processor.coefficients;

  for (let index = 0; index < leftSamples.length; index += 1) {
    let leftSample = processBiquadSample(
      leftSamples[index],
      lowShelf,
      leftState,
      0,
    );
    leftSample = processBiquadSample(
      leftSample,
      midPeaking,
      leftState,
      2,
    );
    leftSample = processBiquadSample(
      leftSample,
      highShelf,
      leftState,
      4,
    );

    let rightSample = processBiquadSample(
      rightSamples[index],
      lowShelf,
      rightState,
      0,
    );
    rightSample = processBiquadSample(
      rightSample,
      midPeaking,
      rightState,
      2,
    );
    rightSample = processBiquadSample(
      rightSample,
      highShelf,
      rightState,
      4,
    );

    leftOutput[index] = leftSample;
    rightOutput[index] = rightSample;
  }

  const nextProcessor = freezeProcessor(
    processor.effect,
    processor.sampleRateHz,
    processor.coefficients,
    freezeProcessorState(leftState, rightState),
  );

  return Object.freeze({
    leftSamples: leftOutput,
    processor: nextProcessor,
    rightSamples: rightOutput,
  });
}

export function resetMixerEqualizerProcessor(processor) {
  assertProcessor(processor);
  return freezeProcessor(
    processor.effect,
    processor.sampleRateHz,
    processor.coefficients,
    createZeroProcessorState(),
  );
}

function createMixerEqualizerCoefficients(parameters, sampleRateHz) {
  const lowShelf = createShelfCoefficients(
    'low',
    parameters.lowGainDb,
    parameters.lowFrequencyHz,
    sampleRateHz,
  );
  const midPeaking = createPeakingCoefficients(
    parameters.midGainDb,
    parameters.midFrequencyHz,
    parameters.midQ,
    sampleRateHz,
  );
  const highShelf = createShelfCoefficients(
    'high',
    parameters.highGainDb,
    parameters.highFrequencyHz,
    sampleRateHz,
  );

  return Object.freeze({
    highShelf,
    lowShelf,
    midPeaking,
    version: MIXER_EQUALIZER_COEFFICIENT_VERSION,
  });
}

function createShelfCoefficients(mode, gainDb, frequencyHz, sampleRateHz) {
  const amplitude = 10 ** (gainDb / 40);
  const omega = (2 * Math.PI * frequencyHz) / sampleRateHz;
  const cosine = Math.cos(omega);
  const sine = Math.sin(omega);
  const alpha =
    (sine / 2) *
    Math.sqrt(
      (amplitude + 1 / amplitude) *
        (1 / MIXER_EQUALIZER_SHELF_SLOPE - 1) +
        2,
    );
  const beta = 2 * Math.sqrt(amplitude) * alpha;

  if (mode === 'low') {
    return normalizeCoefficients(
      amplitude * ((amplitude + 1) - (amplitude - 1) * cosine + beta),
      2 * amplitude * ((amplitude - 1) - (amplitude + 1) * cosine),
      amplitude * ((amplitude + 1) - (amplitude - 1) * cosine - beta),
      (amplitude + 1) + (amplitude - 1) * cosine + beta,
      -2 * ((amplitude - 1) + (amplitude + 1) * cosine),
      (amplitude + 1) + (amplitude - 1) * cosine - beta,
    );
  }

  return normalizeCoefficients(
    amplitude * ((amplitude + 1) + (amplitude - 1) * cosine + beta),
    -2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cosine),
    amplitude * ((amplitude + 1) + (amplitude - 1) * cosine - beta),
    (amplitude + 1) - (amplitude - 1) * cosine + beta,
    2 * ((amplitude - 1) - (amplitude + 1) * cosine),
    (amplitude + 1) - (amplitude - 1) * cosine - beta,
  );
}

function createPeakingCoefficients(gainDb, frequencyHz, q, sampleRateHz) {
  const amplitude = 10 ** (gainDb / 40);
  const omega = (2 * Math.PI * frequencyHz) / sampleRateHz;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);

  return normalizeCoefficients(
    1 + alpha * amplitude,
    -2 * cosine,
    1 - alpha * amplitude,
    1 + alpha / amplitude,
    -2 * cosine,
    1 - alpha / amplitude,
  );
}

function normalizeCoefficients(b0, b1, b2, a0, a1, a2) {
  if (
    ![b0, b1, b2, a0, a1, a2].every(Number.isFinite) ||
    a0 === 0
  ) {
    throw new RangeError('Mixer Equalizer coefficient construction failed.');
  }

  const coefficients = {
    a1: Math.fround(a1 / a0),
    a2: Math.fround(a2 / a0),
    b0: Math.fround(b0 / a0),
    b1: Math.fround(b1 / a0),
    b2: Math.fround(b2 / a0),
    version: MIXER_EQUALIZER_COEFFICIENT_VERSION,
  };

  if (
    ![
      coefficients.a1,
      coefficients.a2,
      coefficients.b0,
      coefficients.b1,
      coefficients.b2,
    ].every(Number.isFinite)
  ) {
    throw new RangeError('Mixer Equalizer normalized coefficients must be finite.');
  }

  return Object.freeze(coefficients);
}

function processBiquadSample(input, coefficients, state, offset) {
  const output = Math.fround(coefficients.b0 * input + state[offset]);
  const nextZ1 = Math.fround(
    coefficients.b1 * input - coefficients.a1 * output + state[offset + 1],
  );
  const nextZ2 = Math.fround(
    coefficients.b2 * input - coefficients.a2 * output,
  );

  if (
    !Number.isFinite(output) ||
    !Number.isFinite(nextZ1) ||
    !Number.isFinite(nextZ2)
  ) {
    throw new RangeError('Mixer Equalizer processing produced non-finite state.');
  }

  state[offset] = zeroDenormal(nextZ1);
  state[offset + 1] = zeroDenormal(nextZ2);
  return output;
}

function zeroDenormal(value) {
  return Math.abs(value) < MIXER_EFFECTS_DENORMAL_THRESHOLD ? 0 : value;
}

function createMutableChannelState(channelState) {
  return new Float32Array([
    canonicalStateValue(channelState.lowShelf.z1),
    canonicalStateValue(channelState.lowShelf.z2),
    canonicalStateValue(channelState.midPeaking.z1),
    canonicalStateValue(channelState.midPeaking.z2),
    canonicalStateValue(channelState.highShelf.z1),
    canonicalStateValue(channelState.highShelf.z2),
  ]);
}

function canonicalStateValue(value) {
  return zeroDenormal(Math.fround(value));
}

function createZeroProcessorState() {
  return freezeProcessorState(new Float32Array(6), new Float32Array(6));
}

function freezeProcessorState(leftState, rightState) {
  return Object.freeze({
    left: freezeChannelState(leftState),
    right: freezeChannelState(rightState),
    version: MIXER_EQUALIZER_PROCESSOR_STATE_VERSION,
  });
}

function freezeChannelState(state) {
  return Object.freeze({
    highShelf: freezeBiquadState(state[4], state[5]),
    lowShelf: freezeBiquadState(state[0], state[1]),
    midPeaking: freezeBiquadState(state[2], state[3]),
  });
}

function freezeBiquadState(z1, z2) {
  return Object.freeze({ z1, z2 });
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
    throw new TypeError('Mixer Equalizer processor is invalid.');
  }

  assertMixerEffectState(processor.effect, processor.sampleRateHz);
  if (
    processor.effect.algorithmId !== MIXER_EQUALIZER_ALGORITHM_ID ||
    processor.effect.algorithmVersion !== MIXER_EQUALIZER_ALGORITHM_VERSION ||
    !isFrozenRecord(processor.effect) ||
    !isFrozenRecord(processor.effect.parameters)
  ) {
    throw new TypeError('Mixer Equalizer processor effect is invalid.');
  }

  assertCoefficientSet(processor.coefficients);
  assertProcessorState(processor.state);
}

function assertCoefficientSet(coefficients) {
  if (
    !isFrozenRecord(coefficients) ||
    !hasExactKeys(coefficients, [
      'highShelf',
      'lowShelf',
      'midPeaking',
      'version',
    ]) ||
    coefficients.version !== MIXER_EQUALIZER_COEFFICIENT_VERSION
  ) {
    throw new TypeError('Mixer Equalizer coefficient set is invalid.');
  }

  assertBiquadCoefficients(coefficients.lowShelf);
  assertBiquadCoefficients(coefficients.midPeaking);
  assertBiquadCoefficients(coefficients.highShelf);
}

function assertBiquadCoefficients(coefficients) {
  if (
    !isFrozenRecord(coefficients) ||
    !hasExactKeys(coefficients, BIQUAD_COEFFICIENT_KEYS) ||
    coefficients.version !== MIXER_EQUALIZER_COEFFICIENT_VERSION ||
    ![
      coefficients.a1,
      coefficients.a2,
      coefficients.b0,
      coefficients.b1,
      coefficients.b2,
    ].every((value) => Number.isFinite(value) && Math.fround(value) === value)
  ) {
    throw new TypeError('Mixer Equalizer biquad coefficients are invalid.');
  }
}

function assertProcessorState(state) {
  if (
    !isFrozenRecord(state) ||
    !hasExactKeys(state, ['left', 'right', 'version']) ||
    state.version !== MIXER_EQUALIZER_PROCESSOR_STATE_VERSION
  ) {
    throw new TypeError('Mixer Equalizer processor state is invalid.');
  }

  assertChannelState(state.left);
  assertChannelState(state.right);
}

function assertChannelState(channelState) {
  if (
    !isFrozenRecord(channelState) ||
    !hasExactKeys(channelState, CHANNEL_STATE_KEYS)
  ) {
    throw new TypeError('Mixer Equalizer channel state is invalid.');
  }

  assertBiquadState(channelState.lowShelf);
  assertBiquadState(channelState.midPeaking);
  assertBiquadState(channelState.highShelf);
}

function assertBiquadState(state) {
  if (
    !isFrozenRecord(state) ||
    !hasExactKeys(state, BIQUAD_STATE_KEYS) ||
    ![state.z1, state.z2].every(
      (value) =>
        Number.isFinite(value) &&
        Math.fround(value) === value &&
        (value === 0 || Math.abs(value) >= MIXER_EFFECTS_DENORMAL_THRESHOLD),
    )
  ) {
    throw new TypeError('Mixer Equalizer biquad state is invalid.');
  }
}

function assertSampleBlocks(leftSamples, rightSamples) {
  if (
    !isSampleBlock(leftSamples) ||
    !isSampleBlock(rightSamples) ||
    leftSamples.length !== rightSamples.length
  ) {
    throw new TypeError(
      'Mixer Equalizer sample blocks must be equal-length numeric arrays.',
    );
  }
}

function assertFiniteSamples(leftSamples, rightSamples) {
  for (let index = 0; index < leftSamples.length; index += 1) {
    if (
      !Number.isFinite(leftSamples[index]) ||
      !Number.isFinite(rightSamples[index])
    ) {
      throw new RangeError('Mixer Equalizer input samples must be finite.');
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
