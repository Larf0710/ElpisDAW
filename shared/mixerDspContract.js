export const MIXER_DSP_CONTRACT_VERSION_V1 = 1;
export const MIXER_DSP_CONTRACT_VERSION_V2 = 2;
// Retained v1 callers use this stable alias; effects-capable paths select v2 explicitly.
export const MIXER_DSP_CONTRACT_VERSION = MIXER_DSP_CONTRACT_VERSION_V1;
export const MIXER_RENDER_SNAPSHOT_VERSION = 1;
export const MIXER_PAN_MIN = -1;
export const MIXER_PAN_MAX = 1;
export const MIXER_SOURCE_CHANNELS_MONO = 1;
export const MIXER_SOURCE_CHANNELS_STEREO = 2;

/**
 * Version 1 Pan law:
 * - mono uses equal-power panning from left to right;
 * - stereo uses channel-preserving equal-power balance without crossfeed.
 *
 * The returned gains are applied after the Channel Fader and before the
 * stereo Master sum. They do not normalize the Master sum.
 */
export function createMixerPanCoefficients(pan, sourceChannels) {
  return createVersionedMixerPanCoefficients(
    pan,
    sourceChannels,
    MIXER_DSP_CONTRACT_VERSION_V1,
  );
}

export function createMixerPanCoefficientsV2(pan, sourceChannels) {
  return createVersionedMixerPanCoefficients(
    pan,
    sourceChannels,
    MIXER_DSP_CONTRACT_VERSION_V2,
  );
}

function createVersionedMixerPanCoefficients(pan, sourceChannels, version) {
  assertMixerPan(pan);

  if (
    sourceChannels !== MIXER_SOURCE_CHANNELS_MONO &&
    sourceChannels !== MIXER_SOURCE_CHANNELS_STEREO
  ) {
    throw new RangeError('Mixer source channels must be mono or stereo.');
  }

  if (sourceChannels === MIXER_SOURCE_CHANNELS_MONO) {
    if (pan === MIXER_PAN_MIN) {
      return freezeCoefficients('mono-equal-power', 1, 0, version);
    }

    if (pan === 0) {
      return freezeCoefficients(
        'mono-equal-power',
        Math.SQRT1_2,
        Math.SQRT1_2,
        version,
      );
    }

    if (pan === MIXER_PAN_MAX) {
      return freezeCoefficients('mono-equal-power', 0, 1, version);
    }

    const angle = ((pan + 1) * Math.PI) / 4;
    return freezeCoefficients(
      'mono-equal-power',
      Math.cos(angle),
      Math.sin(angle),
      version,
    );
  }

  if (pan === MIXER_PAN_MIN) {
    return freezeCoefficients('stereo-balance', 1, 0, version);
  }

  if (pan === 0) {
    return freezeCoefficients('stereo-balance', 1, 1, version);
  }

  if (pan === MIXER_PAN_MAX) {
    return freezeCoefficients('stereo-balance', 0, 1, version);
  }

  return pan < 0
    ? freezeCoefficients(
        'stereo-balance',
        1,
        Math.cos((-pan * Math.PI) / 2),
        version,
      )
    : freezeCoefficients(
        'stereo-balance',
        Math.cos((pan * Math.PI) / 2),
        1,
        version,
      );
}

export function createMixerChannelDspCoefficients(
  faderDb,
  pan,
  sourceChannels,
) {
  return createVersionedMixerChannelDspCoefficients(
    faderDb,
    pan,
    sourceChannels,
    MIXER_DSP_CONTRACT_VERSION_V1,
  );
}

export function createMixerChannelDspCoefficientsV2(
  faderDb,
  pan,
  sourceChannels,
) {
  return createVersionedMixerChannelDspCoefficients(
    faderDb,
    pan,
    sourceChannels,
    MIXER_DSP_CONTRACT_VERSION_V2,
  );
}

function createVersionedMixerChannelDspCoefficients(
  faderDb,
  pan,
  sourceChannels,
  version,
) {
  const faderGain = decibelsToMixerGain(faderDb);
  const panCoefficients = createVersionedMixerPanCoefficients(
    pan,
    sourceChannels,
    version,
  );

  return Object.freeze({
    faderGain,
    leftOutputGain: faderGain * panCoefficients.leftGain,
    panLeftGain: panCoefficients.leftGain,
    panMode: panCoefficients.mode,
    panRightGain: panCoefficients.rightGain,
    rightOutputGain: faderGain * panCoefficients.rightGain,
    version,
  });
}

export function decibelsToMixerGain(decibels) {
  if (!Number.isFinite(decibels)) {
    throw new RangeError('Mixer gain must be a finite decibel value.');
  }

  const gain = 10 ** (decibels / 20);

  if (!Number.isFinite(gain) || gain <= 0) {
    throw new RangeError('Mixer gain cannot be represented as a finite value.');
  }

  return gain;
}

export function assertMixerPan(pan) {
  if (
    !Number.isFinite(pan) ||
    pan < MIXER_PAN_MIN ||
    pan > MIXER_PAN_MAX
  ) {
    throw new RangeError('Mixer Pan must be a finite value from -1 through 1.');
  }
}

function freezeCoefficients(mode, leftGain, rightGain, version) {
  return Object.freeze({
    leftGain,
    mode,
    rightGain,
    version,
  });
}
