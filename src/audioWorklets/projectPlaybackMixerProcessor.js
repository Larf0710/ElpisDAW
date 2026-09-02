import {
  PROJECT_PLAYBACK_AUDIO_WORKLET_MAX_PENDING_CYCLES,
  PROJECT_PLAYBACK_AUDIO_WORKLET_MAX_UNACKNOWLEDGED_METERS,
  PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE,
  PROJECT_PLAYBACK_AUDIO_WORKLET_PROCESSOR_NAME,
  PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
  PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION,
  assertProjectPlaybackAudioWorkletConfiguration,
  assertProjectPlaybackAudioWorkletControlMessage,
} from '../../shared/projectPlaybackAudioWorkletProtocol.js';
import {
  createProjectPlaybackMixerKernelProcessor,
  estimateProjectPlaybackMixerKernelRuntimeBytes,
  processProjectPlaybackMixerKernelBlock,
  resetProjectPlaybackMixerKernelMeters,
  snapshotProjectPlaybackMixerKernelMeters,
} from '../../shared/projectPlaybackMixerKernel.js';

class HumStudioProjectPlaybackMixerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.configuration = null;
    this.kernelProcessor = null;
    this.pendingCycles = [];
    this.lastScheduledSequence = 0;
    this.lastMeterPostFrameEnd = null;
    this.meterFrameStart = 0;
    this.meterFrameCount = 0;
    this.unacknowledgedMeters = [];
    this.terminated = false;
    this.port.onmessage = (event) => this.handleMessage(event.data);

    try {
      const configuration = options?.processorOptions?.configuration;
      assertProjectPlaybackAudioWorkletConfiguration(configuration);
      this.configuration = configuration;

      if (sampleRate !== configuration.sampleRateHz) {
        this.post(PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.unsupported, {
          actualSampleRateHz: sampleRate,
          code: 'UNSUPPORTED_SAMPLE_RATE',
          requiredSampleRateHz: configuration.sampleRateHz,
        });
        this.discard();
        this.terminated = true;
        return;
      }

      this.kernelProcessor = createProjectPlaybackMixerKernelProcessor(
        configuration.kernelConfiguration,
      );
      const memory = estimateProjectPlaybackMixerKernelRuntimeBytes(
        configuration.kernelConfiguration,
      );
      this.post(PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.ready, {
        actualSampleRateHz: sampleRate,
        delayRuntimeBytes: memory.delayRuntimeBytes,
        inputCount: this.kernelProcessor.inputCount,
        meterIntervalFrames: configuration.meterIntervalFrames,
      });
    } catch (error) {
      this.postError('INVALID_CONFIGURATION', 'configuration', 0, error);
      this.discard();
      this.terminated = true;
    }
  }

  handleMessage(message) {
    if (this.terminated) {
      return;
    }

    try {
      assertProjectPlaybackAudioWorkletControlMessage(message);
      if (message.sessionId !== this.configuration.sessionId) {
        throw new Error('AudioWorklet control message belongs to another session.');
      }

      if (message.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.scheduleCycle) {
        this.scheduleCycle(message);
        return;
      }

      if (message.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.cancelCycle) {
        this.cancelCycle(message.sequence);
        return;
      }

      if (message.type === PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.acknowledgeMeter) {
        this.acknowledgeMeter(message.cycleSequence, message.frameEnd);
        return;
      }

      this.post(PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.terminated, {
        framePosition: currentFrame,
        pendingCycleCount: this.pendingCycles.length,
      });
      this.discard();
      this.terminated = true;
    } catch (error) {
      this.fail('INVALID_MESSAGE', 'message', currentFrame, error, message?.sequence);
    }
  }

  scheduleCycle(message) {
    const previousCycle = this.pendingCycles.at(-1);
    if (
      message.sequence !== this.lastScheduledSequence + 1 ||
      message.startFrame < currentFrame ||
      this.pendingCycles.length >= PROJECT_PLAYBACK_AUDIO_WORKLET_MAX_PENDING_CYCLES ||
      (previousCycle && message.startFrame < previousCycle.endFrame)
    ) {
      throw new Error('AudioWorklet cycle schedule is stale, out of order, or overlapping.');
    }

    this.lastScheduledSequence = message.sequence;
    this.pendingCycles.push({
      endFrame: message.endFrame,
      sequence: message.sequence,
      startFrame: message.startFrame,
      started: false,
    });
  }

  cancelCycle(sequence) {
    const index = this.pendingCycles.findIndex(
      (cycle) => cycle.sequence === sequence && !cycle.started,
    );
    if (index < 0) {
      throw new Error('AudioWorklet cycle cancellation is stale or already active.');
    }

    this.pendingCycles.splice(index, 1);
    this.post(PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.cycleCanceled, {
      framePosition: currentFrame,
      sequence,
    });
  }

  acknowledgeMeter(cycleSequence, frameEnd) {
    const expected = this.unacknowledgedMeters[0];
    if (
      !expected ||
      expected.cycleSequence !== cycleSequence ||
      expected.frameEnd !== frameEnd
    ) {
      throw new Error('AudioWorklet meter acknowledgement is stale or out of order.');
    }
    this.unacknowledgedMeters.shift();
  }

  process(inputs, outputs) {
    if (this.terminated) {
      return false;
    }

    const output = outputs[0];
    if (!output || output.length !== 2 || output[0].length !== output[1].length) {
      this.fail(
        'INVALID_OUTPUT_TOPOLOGY',
        'processing',
        currentFrame,
        new Error('Project Playback Mixer requires one stereo output.'),
      );
      return false;
    }

    output[0].fill(0);
    output[1].fill(0);
    const blockStart = currentFrame;
    const blockEnd = blockStart + output[0].length;
    let framePosition = blockStart;

    try {
      while (framePosition < blockEnd) {
        const cycle = this.pendingCycles[0];
        if (!cycle) {
          break;
        }

        if (framePosition < cycle.startFrame) {
          framePosition = Math.min(blockEnd, cycle.startFrame);
          continue;
        }

        if (framePosition >= cycle.endFrame) {
          this.completeCycle(cycle);
          continue;
        }

        if (!cycle.started) {
          this.kernelProcessor = createProjectPlaybackMixerKernelProcessor(
            this.configuration.kernelConfiguration,
          );
          cycle.started = true;
          this.meterFrameStart = framePosition;
          this.meterFrameCount = 0;
        }

        const framesUntilMeter =
          this.configuration.meterIntervalFrames - this.meterFrameCount;
        const segmentEnd = Math.min(
          blockEnd,
          cycle.endFrame,
          framePosition + framesUntilMeter,
        );
        const frameCount = segmentEnd - framePosition;
        const blockOffset = framePosition - blockStart;
        const segmentInputs = inputs.map((channels) =>
          channels.map((samples) =>
            samples.subarray(blockOffset, blockOffset + frameCount)),
        );
        const processed = processProjectPlaybackMixerKernelBlock(
          this.kernelProcessor,
          segmentInputs,
          frameCount,
        );
        this.kernelProcessor = processed.processor;
        output[0].set(processed.leftSamples, blockOffset);
        output[1].set(processed.rightSamples, blockOffset);
        framePosition = segmentEnd;
        this.meterFrameCount += frameCount;

        if (this.meterFrameCount === this.configuration.meterIntervalFrames) {
          this.postMeter(cycle.sequence, framePosition);
        }

        if (framePosition === cycle.endFrame) {
          this.completeCycle(cycle);
        }
      }
    } catch (error) {
      this.fail(
        'PROCESSING_FAILURE',
        'processing',
        framePosition,
        error,
        this.pendingCycles[0]?.sequence,
      );
      return false;
    }

    return true;
  }

  postMeter(cycleSequence, frameEnd) {
    if (this.meterFrameCount <= 0) {
      return;
    }
    const cadenceAvailable =
      this.lastMeterPostFrameEnd === null ||
      frameEnd - this.lastMeterPostFrameEnd >=
        this.configuration.meterIntervalFrames;
    if (
      cadenceAvailable &&
      this.unacknowledgedMeters.length <
        PROJECT_PLAYBACK_AUDIO_WORKLET_MAX_UNACKNOWLEDGED_METERS
    ) {
      this.unacknowledgedMeters.push({ cycleSequence, frameEnd });
      this.post(PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.meter, {
        cycleSequence,
        frameEnd,
        frameStart: this.meterFrameStart,
        meterSummary: snapshotProjectPlaybackMixerKernelMeters(
          this.kernelProcessor,
        ),
      });
      this.lastMeterPostFrameEnd = frameEnd;
    }
    this.kernelProcessor = resetProjectPlaybackMixerKernelMeters(
      this.kernelProcessor,
    );
    this.meterFrameStart = frameEnd;
    this.meterFrameCount = 0;
  }

  completeCycle(cycle) {
    if (this.pendingCycles[0] !== cycle) {
      throw new Error('AudioWorklet cycle completion order is invalid.');
    }
    this.postMeter(cycle.sequence, cycle.endFrame);
    this.pendingCycles.shift();
    this.post(PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.cycleComplete, {
      endFrame: cycle.endFrame,
      sequence: cycle.sequence,
      startFrame: cycle.startFrame,
    });
  }

  fail(code, phase, framePosition, error, sequence = null) {
    this.postError(code, phase, framePosition, error, sequence);
    this.discard();
    this.terminated = true;
  }

  postError(code, phase, framePosition, error, sequence = null) {
    this.post(PROJECT_PLAYBACK_AUDIO_WORKLET_MESSAGE.error, {
      code,
      framePosition,
      message: error instanceof Error ? error.message : String(error),
      phase,
      sequence,
    });
  }

  post(type, payload) {
    this.port.postMessage({
      ...payload,
      protocolId: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_ID,
      protocolVersion: PROJECT_PLAYBACK_AUDIO_WORKLET_PROTOCOL_VERSION,
      sessionId: this.configuration?.sessionId ?? 'uninitialized',
      type,
    });
  }

  discard() {
    this.kernelProcessor = null;
    this.pendingCycles = [];
    this.meterFrameCount = 0;
    this.unacknowledgedMeters = [];
  }
}

registerProcessor(
  PROJECT_PLAYBACK_AUDIO_WORKLET_PROCESSOR_NAME,
  HumStudioProjectPlaybackMixerProcessor,
);
