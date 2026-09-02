import { describe, expect, it } from 'vitest';

import {
  MIXER_DSP_CONTRACT_VERSION,
  MIXER_DSP_CONTRACT_VERSION_V2,
  createMixerChannelDspCoefficients,
  createMixerChannelDspCoefficientsV2,
  createMixerPanCoefficients,
  createMixerPanCoefficientsV2,
  decibelsToMixerGain,
} from './mixerDspContract.js';

describe('Mixer DSP contract v1', () => {
  it('uses deterministic equal-power coefficients for mono Pan', () => {
    expect(createMixerPanCoefficients(-1, 1)).toEqual({
      leftGain: 1,
      mode: 'mono-equal-power',
      rightGain: 0,
      version: MIXER_DSP_CONTRACT_VERSION,
    });
    expect(createMixerPanCoefficients(0, 1)).toEqual({
      leftGain: Math.SQRT1_2,
      mode: 'mono-equal-power',
      rightGain: Math.SQRT1_2,
      version: MIXER_DSP_CONTRACT_VERSION,
    });
    expect(createMixerPanCoefficients(1, 1)).toEqual({
      leftGain: 0,
      mode: 'mono-equal-power',
      rightGain: 1,
      version: MIXER_DSP_CONTRACT_VERSION,
    });

    const intermediate = createMixerPanCoefficients(-0.5, 1);
    expect(intermediate.leftGain).toBeCloseTo(0.9238795325, 10);
    expect(intermediate.rightGain).toBeCloseTo(0.3826834324, 10);
  });

  it('uses channel-preserving equal-power balance for stereo Pan', () => {
    expect(createMixerPanCoefficients(-1, 2)).toMatchObject({
      leftGain: 1,
      mode: 'stereo-balance',
      rightGain: 0,
    });
    expect(createMixerPanCoefficients(0, 2)).toMatchObject({
      leftGain: 1,
      mode: 'stereo-balance',
      rightGain: 1,
    });
    expect(createMixerPanCoefficients(1, 2)).toMatchObject({
      leftGain: 0,
      mode: 'stereo-balance',
      rightGain: 1,
    });

    const intermediate = createMixerPanCoefficients(0.5, 2);
    expect(intermediate.leftGain).toBeCloseTo(Math.SQRT1_2, 12);
    expect(intermediate.rightGain).toBe(1);
  });

  it('rejects malformed Pan, channel, and gain state', () => {
    expect(() => createMixerPanCoefficients(Number.NaN, 1)).toThrow(RangeError);
    expect(() => createMixerPanCoefficients(1.01, 2)).toThrow(RangeError);
    expect(() => createMixerPanCoefficients(0, 3 as 1)).toThrow(RangeError);
    expect(() => decibelsToMixerGain(Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
    expect(() => decibelsToMixerGain(-Number.MAX_VALUE)).toThrow(RangeError);
  });

  it('converts finite Channel and Master faders without hidden normalization', () => {
    expect(decibelsToMixerGain(0)).toBe(1);
    expect(decibelsToMixerGain(-6.020599913279624)).toBeCloseTo(0.5, 12);
    expect(decibelsToMixerGain(6.020599913279624)).toBeCloseTo(2, 12);

    expect(
      createMixerChannelDspCoefficients(
        -6.020599913279624,
        0.5,
        1,
      ),
    ).toMatchObject({
      faderGain: 0.5,
      panMode: 'mono-equal-power',
      version: MIXER_DSP_CONTRACT_VERSION,
    });
    const channel = createMixerChannelDspCoefficients(
      -6.020599913279624,
      0.5,
      1,
    );
    expect(channel.leftOutputGain).toBeCloseTo(0.1913417162, 10);
    expect(channel.rightOutputGain).toBeCloseTo(0.4619397663, 10);
  });
});

describe('Mixer DSP contract v2 offline effects routing', () => {
  it('versions the retained Pan and Fader formulas without changing coefficients', () => {
    for (const sourceChannels of [1, 2] as const) {
      for (const pan of [-1, -0.5, 0, 0.5, 1]) {
        const legacy = createMixerPanCoefficients(pan, sourceChannels);
        const current = createMixerPanCoefficientsV2(pan, sourceChannels);

        expect(current).toEqual({
          ...legacy,
          version: MIXER_DSP_CONTRACT_VERSION_V2,
        });
        expect(Object.isFrozen(current)).toBe(true);
      }
    }

    const legacy = createMixerChannelDspCoefficients(-4.5, 0.25, 2);
    const current = createMixerChannelDspCoefficientsV2(-4.5, 0.25, 2);
    expect(current).toEqual({
      ...legacy,
      version: MIXER_DSP_CONTRACT_VERSION_V2,
    });
    expect(Object.isFrozen(current)).toBe(true);
  });
});
