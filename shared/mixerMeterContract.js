export const MIXER_METER_CONTRACT_VERSION = 1;
export const MIXER_SAMPLE_PEAK_CLIP_THRESHOLD = 1;

/**
 * Version 1 measures independent left/right absolute sample peaks.
 * A finite magnitude greater than 1 clips; exactly 1 is full scale only.
 * Accumulators are immutable so block partitioning cannot hide state changes.
 */
export function createMixerSamplePeakAccumulator() {
  return freezeAccumulator(0, 0, 0);
}

export function accumulateMixerSamplePeakBlock(
  accumulator,
  leftSamples,
  rightSamples,
  scale = 1,
) {
  assertAccumulator(accumulator);
  assertSampleBlocks(leftSamples, rightSamples);

  if (!Number.isFinite(scale)) {
    throw new RangeError('Mixer meter scale must be finite.');
  }

  const sampleCount = accumulator.sampleCount + leftSamples.length;

  if (!Number.isSafeInteger(sampleCount)) {
    throw new RangeError('Mixer meter sample count exceeds the safe integer range.');
  }

  let leftPeak = accumulator.leftPeak;
  let rightPeak = accumulator.rightPeak;

  for (let index = 0; index < leftSamples.length; index += 1) {
    const leftSample = leftSamples[index];
    const rightSample = rightSamples[index];

    if (!Number.isFinite(leftSample) || !Number.isFinite(rightSample)) {
      throw new RangeError('Mixer meter input samples must be finite.');
    }

    const scaledLeft = leftSample * scale;
    const scaledRight = rightSample * scale;

    if (!Number.isFinite(scaledLeft) || !Number.isFinite(scaledRight)) {
      throw new RangeError('Mixer meter scaled samples must be finite.');
    }

    leftPeak = Math.max(leftPeak, Math.abs(scaledLeft));
    rightPeak = Math.max(rightPeak, Math.abs(scaledRight));
  }

  return freezeAccumulator(leftPeak, rightPeak, sampleCount);
}

export function resetMixerSamplePeakAccumulator(accumulator) {
  assertAccumulator(accumulator);
  return createMixerSamplePeakAccumulator();
}

export function snapshotMixerSamplePeak(accumulator) {
  assertAccumulator(accumulator);
  const leftClipped = accumulator.leftPeak > MIXER_SAMPLE_PEAK_CLIP_THRESHOLD;
  const rightClipped = accumulator.rightPeak > MIXER_SAMPLE_PEAK_CLIP_THRESHOLD;

  return Object.freeze({
    clipped: leftClipped || rightClipped,
    left: Object.freeze({
      clipped: leftClipped,
      peak: accumulator.leftPeak,
    }),
    right: Object.freeze({
      clipped: rightClipped,
      peak: accumulator.rightPeak,
    }),
    sampleCount: accumulator.sampleCount,
    version: MIXER_METER_CONTRACT_VERSION,
  });
}

function assertAccumulator(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['leftPeak', 'rightPeak', 'sampleCount', 'version']) ||
    value.version !== MIXER_METER_CONTRACT_VERSION ||
    !Number.isFinite(value.leftPeak) ||
    value.leftPeak < 0 ||
    !Number.isFinite(value.rightPeak) ||
    value.rightPeak < 0 ||
    !Number.isSafeInteger(value.sampleCount) ||
    value.sampleCount < 0 ||
    (value.sampleCount === 0 &&
      (value.leftPeak !== 0 || value.rightPeak !== 0))
  ) {
    throw new TypeError('Mixer sample-peak accumulator state is invalid.');
  }
}

function assertSampleBlocks(leftSamples, rightSamples) {
  if (
    !isSampleBlock(leftSamples) ||
    !isSampleBlock(rightSamples) ||
    leftSamples.length !== rightSamples.length
  ) {
    throw new TypeError('Mixer meter sample blocks must be equal-length numeric arrays.');
  }
}

function freezeAccumulator(leftPeak, rightPeak, sampleCount) {
  return Object.freeze({
    leftPeak,
    rightPeak,
    sampleCount,
    version: MIXER_METER_CONTRACT_VERSION,
  });
}

function hasExactKeys(value, keys) {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function isSampleBlock(value) {
  return (
    Array.isArray(value) ||
    value instanceof Float32Array ||
    value instanceof Float64Array
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
