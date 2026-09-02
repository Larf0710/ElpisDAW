import {
  MIXER_EFFECTS_SAMPLE_RATE_HZ,
  MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
  MIXER_ECHO_DELAY_DEFAULT_PARAMETERS,
  MIXER_EQUALIZER_DEFAULT_PARAMETERS,
  MIXER_LIMITER_DEFAULT_PARAMETERS,
  createDefaultMixerCompressorEffect,
  createDefaultMixerEchoDelayEffect,
  createDefaultMixerEqualizerEffect,
  createDefaultMixerLimiterEffect,
  createMixerCompressorEffect,
  createMixerEchoDelayEffect,
  createMixerEqualizerEffect,
  createMixerLimiterEffect,
} from './mixerEffectsContract.js';
import { MIXER_DSP_CONTRACT_VERSION_V2 } from './mixerDspContract.js';
import { MIXER_METER_TAP_CONTRACT_VERSION } from './mixerMeterTapContract.js';
import {
  PROJECT_PLAYBACK_MIXER_KERNEL_VERSION,
  createProjectPlaybackMixerKernelConfiguration,
} from './projectPlaybackMixerKernel.js';

export const PROJECT_PLAYBACK_AUDIO_WORKLET_PROOF_TOLERANCE = 1e-6;

const CASES = Object.freeze([
  Object.freeze({ frameCount: 385, id: 'bypass-transparency' }),
  Object.freeze({ frameCount: 513, id: 'channel-equalizer-mono-pan' }),
  Object.freeze({ frameCount: 1_153, id: 'channel-eq-compressor-delay-order' }),
  Object.freeze({ frameCount: 1_024, id: 'independent-two-channel-state' }),
  Object.freeze({ frameCount: 641, id: 'overlapping-sources-one-channel' }),
  Object.freeze({ frameCount: 769, id: 'master-eq-compressor-limiter-order' }),
  Object.freeze({ frameCount: 257, id: 'master-only-silence' }),
  Object.freeze({ frameCount: 5_000, id: 'delay-silence-meter-cadence-stop' }),
]);

export function listProjectPlaybackAudioWorkletProofCases() {
  return CASES;
}

export function createProjectPlaybackAudioWorkletProofCase(id) {
  switch (id) {
    case 'bypass-transparency':
      return createBypassCase();
    case 'channel-equalizer-mono-pan':
      return createChannelEqualizerCase();
    case 'channel-eq-compressor-delay-order':
      return createChannelChainCase();
    case 'independent-two-channel-state':
      return createIndependentChannelsCase();
    case 'overlapping-sources-one-channel':
      return createOverlappingSourcesCase();
    case 'master-eq-compressor-limiter-order':
      return createMasterChainCase();
    case 'master-only-silence':
      return createMasterOnlySilenceCase();
    case 'delay-silence-meter-cadence-stop':
      return createDelaySilenceCase();
    default:
      throw new RangeError(`Unknown Project Playback AudioWorklet proof case: ${id}`);
  }
}

function createBypassCase() {
  const frameCount = 385;
  return createCase(
    'bypass-transparency',
    frameCount,
    [createStereoSource(0, frameCount, (frame) => ({
      left: frame === 7 ? 1.25 : Math.sin(frame * 0.071) * 0.65,
      right: frame === 11 ? -1.5 : Math.cos(frame * 0.043) * 0.45,
    }))],
    [createChannel('track-a', 0, 0, [{ inputIndex: 0, sourceChannels: 2 }])],
    createMaster(),
  );
}

function createChannelEqualizerCase() {
  const frameCount = 513;
  const equalizer = createMixerEqualizerEffect({
    ...MIXER_EQUALIZER_DEFAULT_PARAMETERS,
    highGainDb: -4,
    lowGainDb: 6,
    midFrequencyHz: 1_400,
    midGainDb: 3,
    midQ: 0.75,
  }, false);
  return createCase(
    'channel-equalizer-mono-pan',
    frameCount,
    [createMonoSource(0, frameCount, (frame) =>
      Math.sin(frame * 0.093) * 0.7 + Math.cos(frame * 0.017) * 0.2)],
    [createChannel(
      'track-a',
      -3,
      -0.35,
      [{ inputIndex: 0, sourceChannels: 1 }],
      [equalizer, createDefaultMixerCompressorEffect(), createDefaultMixerEchoDelayEffect()],
    )],
    createMaster(-1.5),
  );
}

function createChannelChainCase() {
  const frameCount = 1_153;
  const equalizer = createMixerEqualizerEffect({
    ...MIXER_EQUALIZER_DEFAULT_PARAMETERS,
    lowGainDb: 8,
    midFrequencyHz: 900,
    midGainDb: -5,
  }, false);
  const compressor = createMixerCompressorEffect({
    ...MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
    attackMs: 0.1,
    kneeDb: 0,
    ratio: 8,
    releaseMs: 25,
    thresholdDb: -24,
  }, false);
  const delay = createMixerEchoDelayEffect({
    ...MIXER_ECHO_DELAY_DEFAULT_PARAMETERS,
    delayTimeMs: 10,
    dry: 1,
    feedback: 0.4,
    wet: 0.6,
  }, false);
  return createCase(
    'channel-eq-compressor-delay-order',
    frameCount,
    [createStereoSource(0, 620, (frame) => ({
      left: frame === 0 ? 1.4 : Math.sin(frame * 0.121) * 0.8,
      right: frame === 3 ? -1.1 : Math.cos(frame * 0.089) * 0.5,
    }))],
    [createChannel(
      'track-a',
      -2,
      0.2,
      [{ inputIndex: 0, sourceChannels: 2 }],
      [equalizer, compressor, delay],
    )],
    createMaster(),
  );
}

function createIndependentChannelsCase() {
  const frameCount = 1_024;
  const delay = createMixerEchoDelayEffect({
    ...MIXER_ECHO_DELAY_DEFAULT_PARAMETERS,
    delayTimeMs: 10,
    dry: 0,
    feedback: 0.5,
    wet: 1,
  }, false);
  return createCase(
    'independent-two-channel-state',
    frameCount,
    [
      createMonoSource(0, 64, (frame) => frame === 0 ? 1 : 0),
      createStereoSource(1, 700, (frame) => ({
        left: 0,
        right: frame === 220 ? -0.75 : 0,
      })),
    ],
    [
      createChannel(
        'track-left',
        0,
        -1,
        [{ inputIndex: 0, sourceChannels: 1 }],
        [createDefaultMixerEqualizerEffect(), createDefaultMixerCompressorEffect(), delay],
      ),
      createChannel(
        'track-right',
        0,
        0,
        [{ inputIndex: 1, sourceChannels: 2 }],
        [createDefaultMixerEqualizerEffect(), createDefaultMixerCompressorEffect(), delay],
      ),
    ],
    createMaster(),
  );
}

function createMasterChainCase() {
  const frameCount = 769;
  const equalizer = createMixerEqualizerEffect({
    ...MIXER_EQUALIZER_DEFAULT_PARAMETERS,
    highGainDb: 5,
    lowGainDb: -3,
    midGainDb: 4,
  }, false);
  const compressor = createMixerCompressorEffect({
    ...MIXER_COMPRESSOR_DEFAULT_PARAMETERS,
    attackMs: 0.1,
    kneeDb: 3,
    ratio: 6,
    releaseMs: 30,
    thresholdDb: -18,
  }, false);
  const limiter = createMixerLimiterEffect({
    ...MIXER_LIMITER_DEFAULT_PARAMETERS,
    ceilingDb: -3,
    releaseMs: 20,
  }, false);
  return createCase(
    'master-eq-compressor-limiter-order',
    frameCount,
    [
      createStereoSource(0, frameCount, (frame) => ({
        left: Math.sin(frame * 0.077) * 1.4,
        right: Math.cos(frame * 0.061) * 1.1,
      })),
      createMonoSource(1, frameCount, (frame) => Math.sin(frame * 0.031) * 0.9),
    ],
    [
      createChannel('track-a', 0, 0, [{ inputIndex: 0, sourceChannels: 2 }]),
      createChannel('track-b', -1, 0.45, [{ inputIndex: 1, sourceChannels: 1 }]),
    ],
    createMaster(-0.75, [equalizer, compressor, limiter]),
  );
}

function createOverlappingSourcesCase() {
  const frameCount = 641;
  return createCase(
    'overlapping-sources-one-channel',
    frameCount,
    [
      createStereoSource(0, frameCount, (frame) => ({
        left: Math.sin(frame * 0.041) * 0.4,
        right: Math.cos(frame * 0.037) * 0.35,
      })),
      createStereoSource(0, 300, (frame) => ({
        left: frame === 12 ? 0.75 : Math.cos(frame * 0.083) * 0.2,
        right: frame === 25 ? -0.7 : Math.sin(frame * 0.067) * 0.25,
      })),
    ],
    [createChannel('track-overlap', -1, 0.3, [
      { inputIndex: 0, sourceChannels: 2 },
    ])],
    createMaster(-2),
  );
}

function createDelaySilenceCase() {
  const frameCount = 5_000;
  const delay = createMixerEchoDelayEffect({
    ...MIXER_ECHO_DELAY_DEFAULT_PARAMETERS,
    delayTimeMs: 10.5,
    dry: 0.5,
    feedback: 0.65,
    wet: 0.75,
  }, false);
  return createCase(
    'delay-silence-meter-cadence-stop',
    frameCount,
    [createStereoSource(0, 300, (frame) => ({
      left: frame === 0 ? 1.2 : 0,
      right: frame === 100 ? -1.15 : 0,
    }))],
    [createChannel(
      'track-delay',
      0,
      0,
      [{ inputIndex: 0, sourceChannels: 2 }],
      [createDefaultMixerEqualizerEffect(), createDefaultMixerCompressorEffect(), delay],
    )],
    createMaster(),
  );
}

function createMasterOnlySilenceCase() {
  const frameCount = 257;
  const equalizer = createMixerEqualizerEffect({
    ...MIXER_EQUALIZER_DEFAULT_PARAMETERS,
    midGainDb: 6,
  }, false);
  return createCase(
    'master-only-silence',
    frameCount,
    [],
    [],
    createMaster(0, [
      equalizer,
      createDefaultMixerCompressorEffect(),
      createDefaultMixerLimiterEffect(),
    ]),
  );
}

function createCase(id, frameCount, sources, channels, master) {
  return {
    configuration: createProjectPlaybackMixerKernelConfiguration({
      channels,
      master,
      meterTapVersion: MIXER_METER_TAP_CONTRACT_VERSION,
      mixerDspVersion: MIXER_DSP_CONTRACT_VERSION_V2,
      sampleRateHz: MIXER_EFFECTS_SAMPLE_RATE_HZ,
      version: PROJECT_PLAYBACK_MIXER_KERNEL_VERSION,
    }),
    frameCount,
    id,
    sources,
  };
}

function createChannel(trackId, faderDb, pan, inputs, inserts = undefined) {
  return {
    faderDb,
    inputs,
    inserts: inserts ?? [
      createDefaultMixerEqualizerEffect(),
      createDefaultMixerCompressorEffect(),
      createDefaultMixerEchoDelayEffect(),
    ],
    pan,
    trackId,
  };
}

function createMaster(faderDb = 0, inserts = undefined) {
  return {
    faderDb,
    inserts: inserts ?? [
      createDefaultMixerEqualizerEffect(),
      createDefaultMixerCompressorEffect(),
      createDefaultMixerLimiterEffect(),
    ],
  };
}

function createMonoSource(inputIndex, frameCount, sampleAt) {
  const channel = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    channel[frame] = Math.fround(sampleAt(frame));
  }
  return { channels: [channel], inputIndex };
}

function createStereoSource(inputIndex, frameCount, sampleAt) {
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = sampleAt(frame);
    left[frame] = Math.fround(sample.left);
    right[frame] = Math.fround(sample.right);
  }
  return { channels: [left, right], inputIndex };
}
