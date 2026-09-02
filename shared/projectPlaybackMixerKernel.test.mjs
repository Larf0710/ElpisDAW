import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createProjectPlaybackAudioWorkletProofCase,
  listProjectPlaybackAudioWorkletProofCases,
} from './projectPlaybackAudioWorkletCases.js';
import {
  PROJECT_PLAYBACK_MIXER_CHANNEL_ORDER,
  PROJECT_PLAYBACK_MIXER_MASTER_ORDER,
  createProjectPlaybackMixerKernelProcessor,
  estimateProjectPlaybackMixerKernelRuntimeBytes,
  processProjectPlaybackMixerKernelBlock,
  snapshotProjectPlaybackMixerKernelMeters,
} from './projectPlaybackMixerKernel.js';

const GOLDEN_HASHES = Object.freeze({
  'bypass-transparency': '55cb79e9f0f51e549f42292b16879b175177332b70669f7e81fc4d33bbbc8d90',
  'channel-equalizer-mono-pan': 'fb715f83e88417fa1315dbbfc24498460f72be080a6b113d872f9cb6524acee0',
  'channel-eq-compressor-delay-order': '9c6822bf633ab9e37f0f6402ead987b4a219def3b4a4b4a6d7b04abdf986cc3b',
  'independent-two-channel-state': '11ca04349646e279f0ea3302543660017e05d3a132fdcb158bda718135dd71f2',
  'overlapping-sources-one-channel': 'e5e9cbb214300889fc334d4ce8cd67537f5002f274d02d258f0b8354bdc0fbdb',
  'master-eq-compressor-limiter-order': 'f441a513dc78798259feeb675d420013bab9519876607128c0df30952b7d3a5b',
  'master-only-silence': 'd5fe696dc1aa5c0a800bf800ce8fc6e26ab622c7dd7de4b9fd0c304fe4036256',
  'delay-silence-meter-cadence-stop': '7ce7b4e485042c47ceb7ce317dc9fc8797b66bed1a19ed331b083b9c44345d63',
});

describe('Project Playback Mixer shared kernel', () => {
  it('freezes the exact Channel and Master topology', () => {
    expect(PROJECT_PLAYBACK_MIXER_CHANNEL_ORDER).toEqual([
      'fader',
      'source-aware-pan',
      'equalizer',
      'compressor',
      'echo-delay',
      'channel-meter',
      'master-sum',
    ]);
    expect(PROJECT_PLAYBACK_MIXER_MASTER_ORDER).toEqual([
      'master-fader',
      'equalizer',
      'compressor',
      'limiter',
      'master-meter',
      'destination',
    ]);
  });

  it('matches the browser-proven golden output for every deterministic case', () => {
    for (const definition of listProjectPlaybackAudioWorkletProofCases()) {
      const proofCase = createProjectPlaybackAudioWorkletProofCase(definition.id);
      const rendered = renderCase(proofCase, [128]);
      expect(hashStereo(rendered.left, rendered.right), definition.id).toBe(
        GOLDEN_HASHES[definition.id],
      );
      const partitioned = renderCase(proofCase, [37, 91, 13, 255, 64, 7, 173]);
      expect(partitioned.left, definition.id).toEqual(rendered.left);
      expect(partitioned.right, definition.id).toEqual(rendered.right);
    }
  });

  it('keeps BYPASS transparent and meters exact full-scale and over-scale samples', () => {
    const proofCase = createProjectPlaybackAudioWorkletProofCase('bypass-transparency');
    const rendered = renderCase(proofCase, [128]);
    expect(rendered.left).toEqual(proofCase.sources[0].channels[0]);
    expect(rendered.right).toEqual(proofCase.sources[0].channels[1]);
    expect(rendered.meter.channels[0].meter).toMatchObject({
      clipped: true,
      left: { clipped: true, peak: 1.25 },
      right: { clipped: true, peak: 1.5 },
      sampleCount: proofCase.frameCount,
    });
    expect(rendered.meter.master).toEqual(rendered.meter.channels[0].meter);
  });

  it('rejects an entire non-finite block before processor state can advance', () => {
    const proofCase = createProjectPlaybackAudioWorkletProofCase(
      'channel-equalizer-mono-pan',
    );
    const processor = createProjectPlaybackMixerKernelProcessor(proofCase.configuration);
    const invalid = createInputBlock(proofCase, 0, 128);
    invalid[0][0][70] = Number.NaN;
    expect(() =>
      processProjectPlaybackMixerKernelBlock(processor, invalid, 128),
    ).toThrow(/finite/);

    const valid = createInputBlock(proofCase, 0, 128);
    const afterRejection = processProjectPlaybackMixerKernelBlock(processor, valid, 128);
    const fresh = processProjectPlaybackMixerKernelBlock(
      createProjectPlaybackMixerKernelProcessor(proofCase.configuration),
      valid,
      128,
    );
    expect(afterRejection.leftSamples).toEqual(fresh.leftSamples);
    expect(afterRejection.rightSamples).toEqual(fresh.rightSamples);
  });

  it('reports bounded independently-owned Delay memory per scheduled Channel', () => {
    const proofCase = createProjectPlaybackAudioWorkletProofCase(
      'independent-two-channel-state',
    );
    expect(estimateProjectPlaybackMixerKernelRuntimeBytes(proofCase.configuration)).toEqual({
      delayRuntimeBytes: 1_411_216,
      delayRuntimeBytesPerChannel: 705_608,
      scheduledChannelCount: 2,
    });
  });
});

function renderCase(proofCase, partitionPattern) {
  let processor = createProjectPlaybackMixerKernelProcessor(proofCase.configuration);
  const left = new Float32Array(proofCase.frameCount);
  const right = new Float32Array(proofCase.frameCount);
  let frameStart = 0;
  let patternIndex = 0;
  while (frameStart < proofCase.frameCount) {
    const frameCount = Math.min(
      proofCase.frameCount - frameStart,
      partitionPattern[patternIndex % partitionPattern.length],
    );
    const result = processProjectPlaybackMixerKernelBlock(
      processor,
      createInputBlock(proofCase, frameStart, frameCount),
      frameCount,
    );
    processor = result.processor;
    left.set(result.leftSamples, frameStart);
    right.set(result.rightSamples, frameStart);
    frameStart += frameCount;
    patternIndex += 1;
  }
  return {
    left,
    meter: snapshotProjectPlaybackMixerKernelMeters(processor),
    right,
  };
}

function createInputBlock(proofCase, frameStart, frameCount) {
  const inputCount = proofCase.configuration.channels.reduce(
    (count, channel) => count + channel.inputs.length,
    0,
  );
  const inputs = Array.from({ length: inputCount }, () => []);
  for (const source of proofCase.sources) {
    if (frameStart >= source.channels[0].length) {
      continue;
    }
    const sourceBlock = source.channels.map((samples) => {
      const block = new Float32Array(frameCount);
      block.set(samples.subarray(frameStart, frameStart + frameCount));
      return block;
    });
    if (inputs[source.inputIndex].length === 0) {
      inputs[source.inputIndex] = sourceBlock;
      continue;
    }
    for (let channel = 0; channel < sourceBlock.length; channel += 1) {
      for (let frame = 0; frame < frameCount; frame += 1) {
        inputs[source.inputIndex][channel][frame] = Math.fround(
          inputs[source.inputIndex][channel][frame] + sourceBlock[channel][frame],
        );
      }
    }
  }
  return inputs;
}

function hashStereo(left, right) {
  const hash = createHash('sha256');
  hash.update(Buffer.from(left.buffer, left.byteOffset, left.byteLength));
  hash.update(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
  return hash.digest('hex');
}
