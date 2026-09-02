import {
  MIXER_ECHO_DELAY_ALGORITHM_ID,
  MIXER_ECHO_DELAY_ALGORITHM_VERSION,
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECTS_SAMPLE_RATE_HZ,
  MIXER_EFFECT_TYPE_ECHO_DELAY,
  assertMixerEffectState,
  createMixerEffectSnapshot,
} from './mixerEffectsContract.js';

export const MIXER_ECHO_DELAY_COEFFICIENT_VERSION = 1;
export const MIXER_ECHO_DELAY_PROCESSOR_STATE_VERSION = 1;
export const MIXER_ECHO_DELAY_INTERPOLATION_VERSION = 1;
export const MIXER_ECHO_DELAY_FAILURE_RULE_VERSION = 1;
export const MIXER_ECHO_DELAY_MAX_DELAY_SAMPLES = 88_200;
export const MIXER_ECHO_DELAY_INTERPOLATION_GUARD_SAMPLES = 1;
export const MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES =
  MIXER_ECHO_DELAY_MAX_DELAY_SAMPLES +
  MIXER_ECHO_DELAY_INTERPOLATION_GUARD_SAMPLES;
export const MIXER_ECHO_DELAY_RUNTIME_BYTES_PER_PROCESSOR =
  MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES * Float32Array.BYTES_PER_ELEMENT * 2;

const COEFFICIENT_KEYS = Object.freeze([
  'bufferCapacitySamples',
  'delayFraction',
  'delaySamples',
  'delayWholeSamples',
  'dry',
  'feedback',
  'newerWeight',
  'version',
  'wet',
]);
const STATE_KEYS = Object.freeze(['version', 'writeIndex']);
const PROCESSOR_RUNTIME = new WeakMap();

/**
 * Creates one Echo/Delay operation with two private zero-filled Float32 ring
 * buffers. Version 1 derives delaySamples as
 * Math.fround(delayTimeMs * sampleRateHz / 1000). The fractional coefficient,
 * its complementary newer-sample weight, feedback, wet, and dry are rounded
 * once with Math.fround and then remain fixed for the operation.
 *
 * Runtime storage is 88,201 samples per channel: the 88,200-sample maximum
 * delay plus one linear-interpolation guard. The two rings occupy exactly
 * 705,608 bytes. They are held in a private WeakMap and are never exposed.
 */
export function createMixerEchoDelayProcessor(
  effect,
  sampleRateHz = MIXER_EFFECTS_SAMPLE_RATE_HZ,
) {
  const effectSnapshot = createMixerEffectSnapshot(effect, sampleRateHz);
  assertEchoDelayEffect(effectSnapshot);
  const coefficients = createCoefficients(
    effectSnapshot.parameters,
    sampleRateHz,
  );
  return createProcessorWithFreshRuntime(
    effectSnapshot,
    sampleRateHz,
    coefficients,
  );
}

/**
 * Processes independent left and right feedback-delay rings with no crossfeed,
 * modulation, filtering, normalization, clamp, lookahead, or automatic tail
 * extension. The dry path has zero algorithmic latency.
 *
 * For delaySamples = whole + fraction, the delayed sample is the Float32 sum
 * of the newer stored sample times Math.fround(1 - fraction) and the adjacent
 * older stored sample times fraction. The interpolated delay, feedback write,
 * dry contribution, wet contribution, output, and persistent ring write are
 * each rounded at the explicit Math.fround boundaries below.
 *
 * Large ring state uses linear ownership to avoid copying 705,608 bytes for
 * every block. A successful non-empty enabled call consumes the supplied
 * processor and transfers its private rings to the returned processor. Reusing
 * the consumed processor fails closed. Bypass and empty blocks do not consume
 * or advance it.
 *
 * Failure Rule v1 validates the complete public processor and both input blocks
 * before mutation. If an unexpected non-finite intermediate is encountered,
 * the private runtime is marked invalid and cannot process again; reset creates
 * a new zero-filled operation. This avoids both partial continuation and an
 * O(maxDelayBuffer) transactional copy per block.
 */
export function processMixerEchoDelayBlock(
  processor,
  leftSamples,
  rightSamples,
) {
  assertProcessorShape(processor);
  const runtime = getUsableRuntime(processor);
  assertSampleBlocks(leftSamples, rightSamples);
  assertFiniteFloat32StageInputs(leftSamples, rightSamples);

  if (processor.effect.bypass) {
    return Object.freeze({ leftSamples, processor, rightSamples });
  }

  const leftOutput = new Float32Array(leftSamples.length);
  const rightOutput = new Float32Array(rightSamples.length);
  if (leftSamples.length === 0) {
    return Object.freeze({
      leftSamples: leftOutput,
      processor,
      rightSamples: rightOutput,
    });
  }

  let writeIndex = processor.state.writeIndex;
  const { coefficients } = processor;
  const leftFrame = new Float32Array(2);
  const rightFrame = new Float32Array(2);

  try {
    for (let index = 0; index < leftSamples.length; index += 1) {
      const leftInput = Math.fround(leftSamples[index]);
      const rightInput = Math.fround(rightSamples[index]);
      calculateChannelFrame(
        leftInput,
        runtime.leftBuffer,
        writeIndex,
        coefficients,
        leftFrame,
      );
      calculateChannelFrame(
        rightInput,
        runtime.rightBuffer,
        writeIndex,
        coefficients,
        rightFrame,
      );

      runtime.leftBuffer[writeIndex] = leftFrame[0];
      runtime.rightBuffer[writeIndex] = rightFrame[0];
      leftOutput[index] = leftFrame[1];
      rightOutput[index] = rightFrame[1];
      writeIndex += 1;
      if (writeIndex === MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES) {
        writeIndex = 0;
      }
    }
  } catch (error) {
    runtime.status = 'invalid';
    throw error;
  }

  runtime.status = 'consumed';
  const nextProcessor = freezeProcessor(
    processor.effect,
    processor.sampleRateHz,
    processor.coefficients,
    freezeState(writeIndex),
  );
  PROCESSOR_RUNTIME.set(nextProcessor, {
    leftBuffer: runtime.leftBuffer,
    rightBuffer: runtime.rightBuffer,
    status: 'usable',
  });

  return Object.freeze({
    leftSamples: leftOutput,
    processor: nextProcessor,
    rightSamples: rightOutput,
  });
}

/**
 * Starts a fresh zero-filled operation with the same immutable effect and
 * coefficients. It is valid for a usable, consumed, or failure-invalidated
 * structurally valid processor. Discarding a processor at stop, seek, cancel,
 * failure, or render end truncates all pending echoes; v1 has no tail drain.
 */
export function resetMixerEchoDelayProcessor(processor) {
  assertProcessorShape(processor);
  return createProcessorWithFreshRuntime(
    processor.effect,
    processor.sampleRateHz,
    processor.coefficients,
  );
}

function createProcessorWithFreshRuntime(effect, sampleRateHz, coefficients) {
  const processor = freezeProcessor(
    effect,
    sampleRateHz,
    coefficients,
    freezeState(0),
  );
  PROCESSOR_RUNTIME.set(processor, {
    leftBuffer: new Float32Array(MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES),
    rightBuffer: new Float32Array(MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES),
    status: 'usable',
  });
  return processor;
}

function createCoefficients(parameters, sampleRateHz) {
  const delaySamples = Math.fround(
    (parameters.delayTimeMs * sampleRateHz) / 1_000,
  );
  const delayWholeSamples = Math.floor(delaySamples);
  const delayFraction = Math.fround(delaySamples - delayWholeSamples);
  const coefficients = {
    bufferCapacitySamples: MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES,
    delayFraction,
    delaySamples,
    delayWholeSamples,
    dry: Math.fround(parameters.dry),
    feedback: Math.fround(parameters.feedback),
    newerWeight: Math.fround(1 - delayFraction),
    version: MIXER_ECHO_DELAY_COEFFICIENT_VERSION,
    wet: Math.fround(parameters.wet),
  };
  const frozenCoefficients = Object.freeze(coefficients);
  assertCoefficients(frozenCoefficients, parameters, sampleRateHz);
  return frozenCoefficients;
}

function calculateChannelFrame(
  input,
  buffer,
  writeIndex,
  coefficients,
  frame,
) {
  const newerIndex = wrapReadIndex(
    writeIndex - coefficients.delayWholeSamples,
  );
  const olderIndex = newerIndex === 0
    ? MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES - 1
    : newerIndex - 1;
  const newerStored = buffer[newerIndex];
  const olderStored = buffer[olderIndex];
  const newerContribution = Math.fround(
    newerStored * coefficients.newerWeight,
  );
  const olderContribution = Math.fround(
    olderStored * coefficients.delayFraction,
  );
  const delayed = Math.fround(newerContribution + olderContribution);
  const feedbackContribution = Math.fround(
    coefficients.feedback * delayed,
  );
  const bufferWrite = Math.fround(input + feedbackContribution);
  const dryContribution = Math.fround(coefficients.dry * input);
  const wetContribution = Math.fround(coefficients.wet * delayed);
  const output = Math.fround(dryContribution + wetContribution);

  if (
    !Number.isFinite(newerStored) ||
    !Number.isFinite(olderStored) ||
    !Number.isFinite(newerContribution) ||
    !Number.isFinite(olderContribution) ||
    !Number.isFinite(delayed) ||
    !Number.isFinite(feedbackContribution) ||
    !Number.isFinite(bufferWrite) ||
    !Number.isFinite(dryContribution) ||
    !Number.isFinite(wetContribution) ||
    !Number.isFinite(output)
  ) {
    throw new RangeError(
      'Mixer Echo/Delay processing produced non-finite runtime state.',
    );
  }

  frame[0] = bufferWrite;
  frame[1] = output;
}

function wrapReadIndex(index) {
  return index < 0
    ? index + MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES
    : index;
}

function freezeState(writeIndex) {
  return Object.freeze({
    version: MIXER_ECHO_DELAY_PROCESSOR_STATE_VERSION,
    writeIndex,
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

function getUsableRuntime(processor) {
  const runtime = PROCESSOR_RUNTIME.get(processor);
  if (
    runtime === undefined ||
    runtime.status !== 'usable' ||
    !(runtime.leftBuffer instanceof Float32Array) ||
    !(runtime.rightBuffer instanceof Float32Array) ||
    runtime.leftBuffer.length !== MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES ||
    runtime.rightBuffer.length !== MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES
  ) {
    throw new TypeError(
      'Mixer Echo/Delay processor runtime is unavailable or invalidated.',
    );
  }
  return runtime;
}

function assertProcessorShape(processor) {
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
    throw new TypeError('Mixer Echo/Delay processor is invalid.');
  }

  assertEchoDelayEffect(processor.effect);
  if (
    !isFrozenRecord(processor.effect) ||
    !isFrozenRecord(processor.effect.parameters)
  ) {
    throw new TypeError('Mixer Echo/Delay processor effect is invalid.');
  }
  assertCoefficients(
    processor.coefficients,
    processor.effect.parameters,
    processor.sampleRateHz,
  );
  assertState(processor.state);
}

function assertEchoDelayEffect(effect) {
  assertMixerEffectState(effect, MIXER_EFFECTS_SAMPLE_RATE_HZ);
  if (
    effect.effectType !== MIXER_EFFECT_TYPE_ECHO_DELAY ||
    effect.algorithmId !== MIXER_ECHO_DELAY_ALGORITHM_ID ||
    effect.algorithmVersion !== MIXER_ECHO_DELAY_ALGORITHM_VERSION
  ) {
    throw new TypeError('Mixer Echo/Delay effect identity is invalid.');
  }
}

function assertCoefficients(coefficients, parameters, sampleRateHz) {
  const expectedDelaySamples = Math.fround(
    (parameters.delayTimeMs * sampleRateHz) / 1_000,
  );
  const expectedDelayWholeSamples = Math.floor(expectedDelaySamples);
  const expectedDelayFraction = Math.fround(
    expectedDelaySamples - expectedDelayWholeSamples,
  );
  if (
    !isFrozenRecord(coefficients) ||
    !hasExactKeys(coefficients, COEFFICIENT_KEYS) ||
    coefficients.version !== MIXER_ECHO_DELAY_COEFFICIENT_VERSION ||
    coefficients.bufferCapacitySamples !==
      MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES ||
    coefficients.delaySamples !== expectedDelaySamples ||
    coefficients.delayWholeSamples !== expectedDelayWholeSamples ||
    coefficients.delayFraction !== expectedDelayFraction ||
    coefficients.newerWeight !== Math.fround(1 - expectedDelayFraction) ||
    coefficients.feedback !== Math.fround(parameters.feedback) ||
    coefficients.wet !== Math.fround(parameters.wet) ||
    coefficients.dry !== Math.fround(parameters.dry) ||
    coefficients.delayWholeSamples !== Math.floor(coefficients.delaySamples) ||
    coefficients.delayWholeSamples < 1 ||
    coefficients.delayWholeSamples > MIXER_ECHO_DELAY_MAX_DELAY_SAMPLES ||
    !isFloat32Within(coefficients.delaySamples, 441, 88_200) ||
    !isFloat32Within(coefficients.delayFraction, 0, 1, false) ||
    !isFloat32Within(coefficients.newerWeight, 0, 1) ||
    Math.fround(1 - coefficients.delayFraction) !== coefficients.newerWeight ||
    !isFloat32Within(coefficients.feedback, 0, 0.95) ||
    !isFloat32Within(coefficients.wet, 0, 1) ||
    !isFloat32Within(coefficients.dry, 0, 1)
  ) {
    throw new TypeError('Mixer Echo/Delay coefficients are invalid.');
  }
}

function assertState(state) {
  if (
    !isFrozenRecord(state) ||
    !hasExactKeys(state, STATE_KEYS) ||
    state.version !== MIXER_ECHO_DELAY_PROCESSOR_STATE_VERSION ||
    !Number.isInteger(state.writeIndex) ||
    state.writeIndex < 0 ||
    state.writeIndex >= MIXER_ECHO_DELAY_BUFFER_CAPACITY_SAMPLES
  ) {
    throw new TypeError('Mixer Echo/Delay processor state is invalid.');
  }
}

function assertSampleBlocks(leftSamples, rightSamples) {
  if (
    !isSampleBlock(leftSamples) ||
    !isSampleBlock(rightSamples) ||
    leftSamples.length !== rightSamples.length
  ) {
    throw new TypeError(
      'Mixer Echo/Delay sample blocks must be equal-length numeric arrays.',
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
        'Mixer Echo/Delay input samples must be finite Float32 stage values.',
      );
    }
  }
}

function isFloat32Within(value, minimum, maximum, inclusiveMaximum = true) {
  return (
    Number.isFinite(value) &&
    Math.fround(value) === value &&
    value >= minimum &&
    (inclusiveMaximum ? value <= maximum : value < maximum)
  );
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
