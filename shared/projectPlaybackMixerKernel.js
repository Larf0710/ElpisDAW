import {
  MIXER_DSP_CONTRACT_VERSION_V2,
  MIXER_SOURCE_CHANNELS_MONO,
  MIXER_SOURCE_CHANNELS_STEREO,
  createMixerChannelDspCoefficientsV2,
  decibelsToMixerGain,
} from './mixerDspContract.js';
import {
  MIXER_EFFECTS_SAMPLE_RATE_HZ,
  MIXER_EFFECT_TYPE_COMPRESSOR,
  MIXER_EFFECT_TYPE_ECHO_DELAY,
  MIXER_EFFECT_TYPE_EQUALIZER,
  MIXER_EFFECT_TYPE_LIMITER,
  createMixerEffectSnapshot,
} from './mixerEffectsContract.js';
import {
  createMixerEqualizerProcessor,
  processMixerEqualizerBlock,
} from './mixerEqualizerKernel.js';
import {
  createMixerCompressorProcessor,
  processMixerCompressorBlock,
} from './mixerCompressorKernel.js';
import {
  MIXER_ECHO_DELAY_RUNTIME_BYTES_PER_PROCESSOR,
  createMixerEchoDelayProcessor,
  processMixerEchoDelayBlock,
} from './mixerEchoDelayKernel.js';
import {
  createMixerLimiterProcessor,
  processMixerLimiterBlock,
} from './mixerLimiterKernel.js';
import {
  accumulateMixerSamplePeakBlock,
  createMixerSamplePeakAccumulator,
  resetMixerSamplePeakAccumulator,
} from './mixerMeterContract.js';
import {
  MIXER_METER_TAP_CONTRACT_VERSION,
  createMixerMeterTapSummary,
} from './mixerMeterTapContract.js';

export const PROJECT_PLAYBACK_MIXER_KERNEL_VERSION = 1;
export const PROJECT_PLAYBACK_MIXER_CHANNEL_ORDER = Object.freeze([
  'fader',
  'source-aware-pan',
  'equalizer',
  'compressor',
  'echo-delay',
  'channel-meter',
  'master-sum',
]);
export const PROJECT_PLAYBACK_MIXER_MASTER_ORDER = Object.freeze([
  'master-fader',
  'equalizer',
  'compressor',
  'limiter',
  'master-meter',
  'destination',
]);

const CONFIGURATION_KEYS = Object.freeze([
  'channels',
  'master',
  'meterTapVersion',
  'mixerDspVersion',
  'sampleRateHz',
  'version',
]);
const CHANNEL_KEYS = Object.freeze([
  'faderDb',
  'inputs',
  'inserts',
  'pan',
  'trackId',
]);
const INPUT_KEYS = Object.freeze(['inputIndex', 'sourceChannels']);
const MASTER_KEYS = Object.freeze(['faderDb', 'inserts']);
const PROCESSORS = new WeakSet();

export function createProjectPlaybackMixerKernelConfiguration(value) {
  assertProjectPlaybackMixerKernelConfiguration(value);
  return freezeConfiguration(value);
}

export function assertProjectPlaybackMixerKernelConfiguration(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CONFIGURATION_KEYS) ||
    value.version !== PROJECT_PLAYBACK_MIXER_KERNEL_VERSION ||
    value.sampleRateHz !== MIXER_EFFECTS_SAMPLE_RATE_HZ ||
    value.mixerDspVersion !== MIXER_DSP_CONTRACT_VERSION_V2 ||
    value.meterTapVersion !== MIXER_METER_TAP_CONTRACT_VERSION ||
    !Array.isArray(value.channels) ||
    !isRecord(value.master) ||
    !hasExactKeys(value.master, MASTER_KEYS)
  ) {
    throw new TypeError('Project Playback Mixer kernel configuration is malformed.');
  }

  decibelsToMixerGain(value.master.faderDb);
  assertEffectChain(value.master.inserts, [
    MIXER_EFFECT_TYPE_EQUALIZER,
    MIXER_EFFECT_TYPE_COMPRESSOR,
    MIXER_EFFECT_TYPE_LIMITER,
  ]);

  const trackIds = new Set();
  const inputIndices = new Set();
  for (const channel of value.channels) {
    if (
      !isRecord(channel) ||
      !hasExactKeys(channel, CHANNEL_KEYS) ||
      !isTrimmedText(channel.trackId) ||
      trackIds.has(channel.trackId) ||
      !Array.isArray(channel.inputs) ||
      channel.inputs.length === 0
    ) {
      throw new TypeError('Project Playback Mixer Channel configuration is malformed.');
    }

    trackIds.add(channel.trackId);
    assertEffectChain(channel.inserts, [
      MIXER_EFFECT_TYPE_EQUALIZER,
      MIXER_EFFECT_TYPE_COMPRESSOR,
      MIXER_EFFECT_TYPE_ECHO_DELAY,
    ]);

    for (const input of channel.inputs) {
      if (
        !isRecord(input) ||
        !hasExactKeys(input, INPUT_KEYS) ||
        !Number.isSafeInteger(input.inputIndex) ||
        input.inputIndex < 0 ||
        inputIndices.has(input.inputIndex) ||
        (input.sourceChannels !== MIXER_SOURCE_CHANNELS_MONO &&
          input.sourceChannels !== MIXER_SOURCE_CHANNELS_STEREO)
      ) {
        throw new TypeError('Project Playback Mixer input mapping is malformed.');
      }

      inputIndices.add(input.inputIndex);
      createMixerChannelDspCoefficientsV2(
        channel.faderDb,
        channel.pan,
        input.sourceChannels,
      );
    }
  }

  for (let inputIndex = 0; inputIndex < inputIndices.size; inputIndex += 1) {
    if (!inputIndices.has(inputIndex)) {
      throw new TypeError('Project Playback Mixer input mappings must be contiguous.');
    }
  }
}

export function createProjectPlaybackMixerKernelProcessor(configuration) {
  const frozenConfiguration = createProjectPlaybackMixerKernelConfiguration(
    configuration,
  );
  const channels = frozenConfiguration.channels.map((channel) =>
    createChannelProcessor(channel, frozenConfiguration.sampleRateHz),
  );
  const master = createMasterProcessor(
    frozenConfiguration.master,
    frozenConfiguration.sampleRateHz,
  );
  return freezeProcessor(frozenConfiguration, channels, master);
}

export function processProjectPlaybackMixerKernelBlock(
  processor,
  inputs,
  frameCount,
) {
  assertProcessor(processor);
  assertInputBlocks(processor, inputs, frameCount);

  const masterLeft = new Float32Array(frameCount);
  const masterRight = new Float32Array(frameCount);
  const nextChannels = [];

  for (const channel of processor.channels) {
    const channelLeft = new Float32Array(frameCount);
    const channelRight = new Float32Array(frameCount);

    for (const input of channel.inputs) {
      const inputChannels = inputs[input.inputIndex];
      if (inputChannels.length === 0) {
        continue;
      }

      const leftInput = inputChannels[0];
      const rightInput = input.sourceChannels === MIXER_SOURCE_CHANNELS_MONO
        ? leftInput
        : inputChannels[1];
      for (let frame = 0; frame < frameCount; frame += 1) {
        channelLeft[frame] = Math.fround(
          channelLeft[frame] + leftInput[frame] * input.leftOutputGain,
        );
        channelRight[frame] = Math.fround(
          channelRight[frame] + rightInput[frame] * input.rightOutputGain,
        );
      }
    }

    const equalized = processMixerEqualizerBlock(
      channel.equalizer,
      channelLeft,
      channelRight,
    );
    const compressed = processMixerCompressorBlock(
      channel.compressor,
      equalized.leftSamples,
      equalized.rightSamples,
    );
    const delayed = processMixerEchoDelayBlock(
      channel.delay,
      compressed.leftSamples,
      compressed.rightSamples,
    );
    const meter = accumulateMixerSamplePeakBlock(
      channel.meter,
      delayed.leftSamples,
      delayed.rightSamples,
    );

    for (let frame = 0; frame < frameCount; frame += 1) {
      masterLeft[frame] = Math.fround(masterLeft[frame] + delayed.leftSamples[frame]);
      masterRight[frame] = Math.fround(masterRight[frame] + delayed.rightSamples[frame]);
    }

    nextChannels.push(freezeChannelProcessor({
      ...channel,
      compressor: compressed.processor,
      delay: delayed.processor,
      equalizer: equalized.processor,
      meter,
    }));
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    masterLeft[frame] = Math.fround(masterLeft[frame] * processor.master.faderGain);
    masterRight[frame] = Math.fround(masterRight[frame] * processor.master.faderGain);
  }

  const masterEqualized = processMixerEqualizerBlock(
    processor.master.equalizer,
    masterLeft,
    masterRight,
  );
  const masterCompressed = processMixerCompressorBlock(
    processor.master.compressor,
    masterEqualized.leftSamples,
    masterEqualized.rightSamples,
  );
  const masterLimited = processMixerLimiterBlock(
    processor.master.limiter,
    masterCompressed.leftSamples,
    masterCompressed.rightSamples,
  );
  const masterMeter = accumulateMixerSamplePeakBlock(
    processor.master.meter,
    masterLimited.leftSamples,
    masterLimited.rightSamples,
  );
  const nextMaster = freezeMasterProcessor({
    ...processor.master,
    compressor: masterCompressed.processor,
    equalizer: masterEqualized.processor,
    limiter: masterLimited.processor,
    meter: masterMeter,
  });

  return Object.freeze({
    leftSamples: masterLimited.leftSamples,
    processor: freezeProcessor(processor.configuration, nextChannels, nextMaster),
    rightSamples: masterLimited.rightSamples,
  });
}

export function snapshotProjectPlaybackMixerKernelMeters(processor) {
  assertProcessor(processor);
  return createMixerMeterTapSummary(
    processor.channels.map((channel) => ({
      accumulator: channel.meter,
      trackId: channel.trackId,
    })),
    processor.master.meter,
  );
}

export function resetProjectPlaybackMixerKernelMeters(processor) {
  assertProcessor(processor);
  const channels = processor.channels.map((channel) =>
    freezeChannelProcessor({
      ...channel,
      meter: resetMixerSamplePeakAccumulator(channel.meter),
    }),
  );
  const master = freezeMasterProcessor({
    ...processor.master,
    meter: resetMixerSamplePeakAccumulator(processor.master.meter),
  });
  return freezeProcessor(processor.configuration, channels, master);
}

export function estimateProjectPlaybackMixerKernelRuntimeBytes(configuration) {
  const frozenConfiguration = createProjectPlaybackMixerKernelConfiguration(
    configuration,
  );
  return Object.freeze({
    delayRuntimeBytes:
      frozenConfiguration.channels.length *
      MIXER_ECHO_DELAY_RUNTIME_BYTES_PER_PROCESSOR,
    delayRuntimeBytesPerChannel: MIXER_ECHO_DELAY_RUNTIME_BYTES_PER_PROCESSOR,
    scheduledChannelCount: frozenConfiguration.channels.length,
  });
}

function createChannelProcessor(channel, sampleRateHz) {
  const inputs = Object.freeze(channel.inputs.map((input) => {
    const coefficients = createMixerChannelDspCoefficientsV2(
      channel.faderDb,
      channel.pan,
      input.sourceChannels,
    );
    return Object.freeze({
      inputIndex: input.inputIndex,
      leftOutputGain: coefficients.leftOutputGain,
      rightOutputGain: coefficients.rightOutputGain,
      sourceChannels: input.sourceChannels,
    });
  }));
  return freezeChannelProcessor({
    compressor: createMixerCompressorProcessor(channel.inserts[1], sampleRateHz),
    delay: createMixerEchoDelayProcessor(channel.inserts[2], sampleRateHz),
    equalizer: createMixerEqualizerProcessor(channel.inserts[0], sampleRateHz),
    inputs,
    meter: createMixerSamplePeakAccumulator(),
    trackId: channel.trackId,
  });
}

function createMasterProcessor(master, sampleRateHz) {
  return freezeMasterProcessor({
    compressor: createMixerCompressorProcessor(master.inserts[1], sampleRateHz),
    equalizer: createMixerEqualizerProcessor(master.inserts[0], sampleRateHz),
    faderGain: decibelsToMixerGain(master.faderDb),
    limiter: createMixerLimiterProcessor(master.inserts[2], sampleRateHz),
    meter: createMixerSamplePeakAccumulator(),
  });
}

function freezeConfiguration(value) {
  return Object.freeze({
    channels: Object.freeze(value.channels.map((channel) => Object.freeze({
      faderDb: channel.faderDb,
      inputs: Object.freeze(channel.inputs.map((input) => Object.freeze({
        inputIndex: input.inputIndex,
        sourceChannels: input.sourceChannels,
      }))),
      inserts: Object.freeze(channel.inserts.map((effect) =>
        createMixerEffectSnapshot(effect, value.sampleRateHz))),
      pan: channel.pan,
      trackId: channel.trackId,
    }))),
    master: Object.freeze({
      faderDb: value.master.faderDb,
      inserts: Object.freeze(value.master.inserts.map((effect) =>
        createMixerEffectSnapshot(effect, value.sampleRateHz))),
    }),
    meterTapVersion: value.meterTapVersion,
    mixerDspVersion: value.mixerDspVersion,
    sampleRateHz: value.sampleRateHz,
    version: value.version,
  });
}

function freezeProcessor(configuration, channels, master) {
  const processor = Object.freeze({
    channels: Object.freeze([...channels]),
    configuration,
    inputCount: configuration.channels.reduce(
      (count, channel) => count + channel.inputs.length,
      0,
    ),
    master,
    version: PROJECT_PLAYBACK_MIXER_KERNEL_VERSION,
  });
  PROCESSORS.add(processor);
  return processor;
}

function freezeChannelProcessor(channel) {
  return Object.freeze(channel);
}

function freezeMasterProcessor(master) {
  return Object.freeze(master);
}

function assertProcessor(processor) {
  if (!isRecord(processor) || !PROCESSORS.has(processor)) {
    throw new TypeError('Project Playback Mixer processor state is invalid.');
  }
}

function assertInputBlocks(processor, inputs, frameCount) {
  if (
    !Array.isArray(inputs) ||
    inputs.length !== processor.inputCount ||
    !Number.isSafeInteger(frameCount) ||
    frameCount <= 0
  ) {
    throw new TypeError('Project Playback Mixer input block shape is invalid.');
  }

  const mappings = processor.channels.flatMap((channel) => channel.inputs);
  for (const mapping of mappings) {
    const channels = inputs[mapping.inputIndex];
    if (
      !Array.isArray(channels) ||
      (channels.length !== 0 && channels.length !== mapping.sourceChannels)
    ) {
      throw new TypeError('Project Playback Mixer input channel topology is invalid.');
    }
    for (const samples of channels) {
      if (!isSampleBlock(samples) || samples.length !== frameCount) {
        throw new TypeError('Project Playback Mixer sample block length is invalid.');
      }
      for (let frame = 0; frame < samples.length; frame += 1) {
        if (!Number.isFinite(samples[frame])) {
          throw new RangeError('Project Playback Mixer input samples must be finite.');
        }
      }
    }
  }
}

function assertEffectChain(inserts, expectedTypes) {
  if (!Array.isArray(inserts) || inserts.length !== expectedTypes.length) {
    throw new TypeError('Project Playback Mixer effect chain is incomplete.');
  }
  for (let index = 0; index < expectedTypes.length; index += 1) {
    const effect = createMixerEffectSnapshot(inserts[index]);
    if (effect.effectType !== expectedTypes[index]) {
      throw new TypeError('Project Playback Mixer effect chain order is invalid.');
    }
  }
}

function hasExactKeys(value, keys) {
  const expected = new Set(keys);
  return Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => expected.has(key));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSampleBlock(value) {
  return value instanceof Float32Array || value instanceof Float64Array;
}

function isTrimmedText(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}
