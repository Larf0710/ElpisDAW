import { describe, expect, it } from 'vitest';

import {
  PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
  PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION_V2,
} from '../engine/projectMixdownWorkerProtocol.mjs';
import { PROJECT_MIXDOWN_API_PROTOCOL_VERSION } from '../shared/projectMixdownApiProtocol.js';
import {
  PROJECT_MIXDOWN_RENDERER_VERSION,
  RAW_MIXDOWN_PLAN_VERSION,
} from '../shared/rawMixdownProtocol.js';
import { MIXER_DSP_CONTRACT_VERSION_V2 } from '../shared/mixerDspContract.js';
import { MIXER_EFFECTS_CONTRACT_VERSION } from '../shared/mixerEffectsContract.js';
import { MIXER_METER_TAP_CONTRACT_VERSION } from '../shared/mixerMeterTapContract.js';
import {
  PROJECT_MIXER_RENDER_SNAPSHOT_VERSION,
  PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2,
} from './projectMixerRenderSnapshot';

describe('Offline Effects protocol boundary', () => {
  it('advances offline execution while keeping the Playback compatibility Snapshot on v1', () => {
    expect(RAW_MIXDOWN_PLAN_VERSION).toBe(3);
    expect(PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION_V2).toBe('2');
    expect(PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION).toBe('3');
    expect(PROJECT_MIXDOWN_API_PROTOCOL_VERSION).toBe('2');
    expect(PROJECT_MIXDOWN_RENDERER_VERSION).toBe('0.2.0');
    expect(MIXER_EFFECTS_CONTRACT_VERSION).toBe(1);
    expect(MIXER_DSP_CONTRACT_VERSION_V2).toBe(2);
    expect(MIXER_METER_TAP_CONTRACT_VERSION).toBe(2);
    expect(PROJECT_MIXER_RENDER_SNAPSHOT_VERSION).toBe(1);
    expect(PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2).toBe(2);
  });
});
