import {
  RAW_MIXDOWN_BITS_PER_SAMPLE,
  RAW_MIXDOWN_CHANNELS,
  RAW_MIXDOWN_ENCODING,
  RAW_MIXDOWN_EXTENSION,
  RAW_MIXDOWN_MIME_TYPE,
  RAW_MIXDOWN_PLAN_VERSION,
  RAW_MIXDOWN_SAMPLE_RATE,
} from '../shared/rawMixdownProtocol.js';
import {
  MIXER_EFFECTS_CONTRACT_VERSION,
  MIXER_EFFECT_TYPE_COMPRESSOR,
  MIXER_EFFECT_TYPE_ECHO_DELAY,
  MIXER_EFFECT_TYPE_EQUALIZER,
  MIXER_EFFECT_TYPE_LIMITER,
  assertMixerEffectState,
} from '../shared/mixerEffectsContract.js';
import {
  MIXER_DSP_CONTRACT_VERSION_V2,
  assertMixerPan,
  createMixerChannelDspCoefficientsV2,
  decibelsToMixerGain,
} from '../shared/mixerDspContract.js';
import {
  createMixerEqualizerProcessor,
  processMixerEqualizerBlock,
} from '../shared/mixerEqualizerKernel.js';
import {
  createMixerCompressorProcessor,
  processMixerCompressorBlock,
} from '../shared/mixerCompressorKernel.js';
import {
  createMixerLimiterProcessor,
  processMixerLimiterBlock,
} from '../shared/mixerLimiterKernel.js';
import {
  createMixerEchoDelayProcessor,
  processMixerEchoDelayBlock,
} from '../shared/mixerEchoDelayKernel.js';
import {
  accumulateMixerSamplePeakBlock,
  createMixerSamplePeakAccumulator,
} from '../shared/mixerMeterContract.js';
import {
  MIXER_METER_TAP_CONTRACT_VERSION,
  createMixerMeterTapSummary,
} from '../shared/mixerMeterTapContract.js';

const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const PCM_WAVE_HEADER_BYTES = 44;
const OUTPUT_BLOCK_FRAMES = 16_384;
const MIXER_RENDER_SNAPSHOT_VERSION_V2 = 2;
const MIXER_MASTER_BUS_ID = 'stereo-master';
const MAX_RIFF_SIZE = 0xffff_ffff;
// This pure renderer returns one Buffer. A future streaming finalizer can lift this memory guard.
const MAX_IN_MEMORY_OUTPUT_BYTES = 256 * 1024 * 1024;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 192_000;
const PROJECT_TIMELINE_TICKS_PER_BEAT = 960;
const OUTPUT_FRAME_TIMING_TOLERANCE_SECONDS =
  0.5 / RAW_MIXDOWN_SAMPLE_RATE;
// Match only the planner's accepted source-duration clipping at a source boundary.
const SOURCE_DURATION_CLIP_TOLERANCE_SECONDS = 0.01;

export class ProjectPcmMixdownRenderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ProjectPcmMixdownRenderError';
  }
}

export function validateProjectPcmMixdownPlan(planValue) {
  return validatePlan(planValue);
}

export function renderProjectPcmMixdown(
  planValue,
  sourceBytesValue,
  options = {},
) {
  const plan = validateProjectPcmMixdownPlan(planValue);
  const sources = validateSources(plan.sources, sourceBytesValue);
  const outputBlockFrames = validateRenderOptions(options);
  const outputFrameCount = secondsToFrameCount(
    plan.durationSeconds,
    RAW_MIXDOWN_SAMPLE_RATE,
    'Mixdown duration',
  );
  const outputBytes = createOutputWave(outputFrameCount);
  const runtimeEvents = createRuntimeEvents(plan, sources, outputFrameCount);
  const runtime = createMixerRuntime(plan, outputBlockFrames);
  const bypassCompatibility = areAllEffectsBypassed(plan.mixerSnapshot);

  for (
    let blockStartFrame = 0;
    blockStartFrame < outputFrameCount;
    blockStartFrame += outputBlockFrames
  ) {
    const blockFrameCount = Math.min(
      outputBlockFrames,
      outputFrameCount - blockStartFrame,
    );
    const left = runtime.master.left.subarray(0, blockFrameCount);
    const right = runtime.master.right.subarray(0, blockFrameCount);
    left.fill(0);
    right.fill(0);
    const blockEndFrame = blockStartFrame + blockFrameCount;
    prepareChannelInputBlocks(runtime.channels, blockFrameCount);

    for (const event of runtimeEvents) {
      const overlapStartFrame = Math.max(blockStartFrame, event.startFrame);
      const overlapEndFrame = Math.min(blockEndFrame, event.endFrame);

      if (overlapEndFrame <= overlapStartFrame) {
        continue;
      }

      const channel = runtime.channelByTrackId.get(event.trackId);

      if (!channel) {
        throw failure(
          'MIXDOWN_DSP_STATE_INVALID',
          `Mixdown Channel runtime ${event.trackId} is unavailable.`,
        );
      }

      mixEventRange(
        event,
        overlapStartFrame,
        overlapEndFrame,
        blockStartFrame,
        bypassCompatibility ? left : undefined,
        bypassCompatibility ? right : undefined,
        channel.inputLeft,
        channel.inputRight,
      );
    }

    for (const channel of runtime.channels) {
      const processed = processChannelBlock(channel, blockFrameCount);
      channel.meter = accumulateMixerSamplePeakBlock(
        channel.meter,
        processed.leftSamples,
        processed.rightSamples,
      );

      if (!bypassCompatibility) {
        sumStereoBlock(left, right, processed.leftSamples, processed.rightSamples);
      }
    }

    applyGainToStereoBlock(left, right, runtime.master.gain);
    const processedMaster = processMasterBlock(runtime.master, left, right);
    runtime.master.meter = accumulateMixerSamplePeakBlock(
      runtime.master.meter,
      processedMaster.leftSamples,
      processedMaster.rightSamples,
    );

    writeOutputBlock(
      outputBytes,
      blockStartFrame,
      processedMaster.leftSamples,
      processedMaster.rightSamples,
    );
  }

  return Object.freeze({
    bitsPerSample: RAW_MIXDOWN_BITS_PER_SAMPLE,
    bytes: outputBytes,
    channels: RAW_MIXDOWN_CHANNELS,
    durationSeconds: outputFrameCount / RAW_MIXDOWN_SAMPLE_RATE,
    frameCount: outputFrameCount,
    // Session-only observation: Worker/API boundaries intentionally do not forward it.
    meterSummary: createMeterSummary(runtime),
    mimeType: RAW_MIXDOWN_MIME_TYPE,
    sampleRate: RAW_MIXDOWN_SAMPLE_RATE,
  });
}

function validatePlan(value) {
  requireExactKeys(
    value,
    [
      'bpm',
      'durationSeconds',
      'endTick',
      'effectsContractVersion',
      'format',
      'masterFaderDb',
      'meterTapVersion',
      'mixerDspVersion',
      'mixerSnapshot',
      'mixerSnapshotVersion',
      'purpose',
      'sources',
      'startTick',
      'tracks',
      'version',
    ],
    'Mixdown Plan',
  );

  if (
    value.version !== RAW_MIXDOWN_PLAN_VERSION ||
    value.effectsContractVersion !== MIXER_EFFECTS_CONTRACT_VERSION ||
    value.meterTapVersion !== MIXER_METER_TAP_CONTRACT_VERSION ||
    value.mixerDspVersion !== MIXER_DSP_CONTRACT_VERSION_V2 ||
    value.mixerSnapshotVersion !== MIXER_RENDER_SNAPSHOT_VERSION_V2 ||
    value.purpose !== 'mixdown' ||
    value.startTick !== 0 ||
    !isPositiveFinite(value.bpm) ||
    !isPositiveFinite(value.durationSeconds) ||
    !Number.isSafeInteger(value.endTick) ||
    value.endTick <= 0 ||
    !isRepresentableMixerFader(value.masterFaderDb)
  ) {
    throw planInvalid('Mixdown Plan identity or timing is invalid.');
  }

  if (
    !matchesOutputFrameTimelineTiming(
      value.durationSeconds,
      value.endTick - value.startTick,
      value.bpm,
    )
  ) {
    throw planInvalid('Mixdown Plan duration contradicts its Timeline range.');
  }

  validateOutputFormat(value.format);
  validateMixerSnapshot(value.mixerSnapshot);

  if (
    value.mixerSnapshot.schemaVersion !== value.mixerSnapshotVersion ||
    value.mixerSnapshot.master.faderDb !== value.masterFaderDb
  ) {
    throw planInvalid('Mixdown Plan contradicts its Mixer Render Snapshot.');
  }

  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw planInvalid('Mixdown Plan must contain at least one source descriptor.');
  }

  validatePlanSourceDescriptors(value.sources);

  if (!Array.isArray(value.tracks) || value.tracks.length === 0) {
    throw planInvalid('Mixdown Plan must contain at least one scheduled Track.');
  }

  validateTrackSchedules(value.tracks, value);
  return value;
}

function validatePlanSourceDescriptors(descriptors) {
  const sourceIds = new Set();

  for (const descriptor of descriptors) {
    validateSourceDescriptor(descriptor);

    if (sourceIds.has(descriptor.sourceId)) {
      throw planInvalid('Mixdown source descriptor IDs must be unique.');
    }

    sourceIds.add(descriptor.sourceId);
  }
}

function validateOutputFormat(value) {
  requireExactKeys(
    value,
    [
      'bitsPerSample',
      'channels',
      'encoding',
      'extension',
      'mimeType',
      'sampleRate',
    ],
    'Mixdown output format',
  );

  if (
    value.bitsPerSample !== RAW_MIXDOWN_BITS_PER_SAMPLE ||
    value.channels !== RAW_MIXDOWN_CHANNELS ||
    value.encoding !== RAW_MIXDOWN_ENCODING ||
    value.extension !== RAW_MIXDOWN_EXTENSION ||
    value.mimeType !== RAW_MIXDOWN_MIME_TYPE ||
    value.sampleRate !== RAW_MIXDOWN_SAMPLE_RATE
  ) {
    throw planInvalid('Mixdown output format does not match the Engine contract.');
  }
}

function validateMixerSnapshot(value) {
  requireExactKeys(
    value,
    ['channels', 'master', 'schemaVersion'],
    'Mixer Render Snapshot v2',
  );

  if (
    value.schemaVersion !== MIXER_RENDER_SNAPSHOT_VERSION_V2 ||
    !Array.isArray(value.channels) ||
    !isRecord(value.master)
  ) {
    throw planInvalid('Mixer Render Snapshot v2 structure is invalid.');
  }

  const trackIds = new Set();

  for (const channel of value.channels) {
    requireExactKeys(
      channel,
      [
        'faderDb',
        'inserts',
        'muted',
        'outputBusId',
        'pan',
        'solo',
        'trackId',
      ],
      'Mixer Render Snapshot v2 Channel',
    );

    if (
      !isTrimmedText(channel.trackId) ||
      trackIds.has(channel.trackId) ||
      channel.outputBusId !== MIXER_MASTER_BUS_ID ||
      typeof channel.muted !== 'boolean' ||
      typeof channel.solo !== 'boolean'
    ) {
      throw planInvalid('Mixer Render Snapshot v2 Channel identity is invalid.');
    }

    validateEffectChain(
      channel.inserts,
      [
        MIXER_EFFECT_TYPE_EQUALIZER,
        MIXER_EFFECT_TYPE_COMPRESSOR,
        MIXER_EFFECT_TYPE_ECHO_DELAY,
      ],
      'Channel',
    );

    if (!isRepresentableMixerFader(channel.faderDb)) {
      throw planInvalid('Mixer Render Snapshot v2 Channel Fader is invalid.');
    }

    try {
      assertMixerPan(channel.pan);
    } catch {
      throw planInvalid('Mixer Render Snapshot v2 Channel Pan is invalid.');
    }

    trackIds.add(channel.trackId);
  }

  requireExactKeys(
    value.master,
    ['busId', 'faderDb', 'inserts'],
    'Mixer Render Snapshot v2 Master',
  );

  if (
    value.master.busId !== MIXER_MASTER_BUS_ID ||
    !isRepresentableMixerFader(value.master.faderDb)
  ) {
    throw planInvalid('Mixer Render Snapshot v2 Master identity is invalid.');
  }

  validateEffectChain(
    value.master.inserts,
    [
      MIXER_EFFECT_TYPE_EQUALIZER,
      MIXER_EFFECT_TYPE_COMPRESSOR,
      MIXER_EFFECT_TYPE_LIMITER,
    ],
    'Master',
  );
}

function validateEffectChain(value, effectTypes, target) {
  if (!Array.isArray(value) || value.length !== effectTypes.length) {
    throw planInvalid(`Mixer Render Snapshot v2 ${target} Inserts are invalid.`);
  }

  value.forEach((effect, index) => {
    try {
      assertMixerEffectState(effect, RAW_MIXDOWN_SAMPLE_RATE);
    } catch {
      throw planInvalid(
        `Mixer Render Snapshot v2 ${target} effect state is invalid.`,
      );
    }

    if (effect.effectType !== effectTypes[index]) {
      throw planInvalid(
        `Mixer Render Snapshot v2 ${target} effect order is invalid.`,
      );
    }
  });
}

function validateTrackSchedules(tracks, plan) {
  const seenTrackIds = new Set();
  const seenClipIds = new Set();
  const snapshotChannels = new Map(
    plan.mixerSnapshot.channels.map((channel) => [channel.trackId, channel]),
  );
  const hasSolo = plan.mixerSnapshot.channels.some((channel) => channel.solo);

  for (const track of tracks) {
    const expectedTrackKeys = track?.groupTrackId === undefined
      ? ['events', 'gainDb', 'pan', 'trackId']
      : ['events', 'gainDb', 'groupTrackId', 'pan', 'trackId'];
    requireExactKeys(track, expectedTrackKeys, 'Mixdown Track schedule');

    const snapshotChannel = snapshotChannels.get(track?.trackId);

    if (
      !isTrimmedText(track.trackId) ||
      seenTrackIds.has(track.trackId) ||
      (track.groupTrackId !== undefined && !isTrimmedText(track.groupTrackId)) ||
      !isRepresentableMixerFader(track.gainDb) ||
      !Number.isFinite(track.pan) ||
      track.pan < -1 ||
      track.pan > 1 ||
      !Array.isArray(track.events) ||
      track.events.length === 0
    ) {
      throw planInvalid('Mixdown Track schedule is invalid.');
    }

    if (
      !snapshotChannel ||
      snapshotChannel.muted ||
      (hasSolo && !snapshotChannel.solo) ||
      snapshotChannel.faderDb !== track.gainDb ||
      snapshotChannel.pan !== track.pan
    ) {
      throw planInvalid('Mixdown Track schedule contradicts its Mixer Channel.');
    }

    seenTrackIds.add(track.trackId);
    let previousStartTick = -1;

    for (const event of track.events) {
      requireExactKeys(
        event,
        [
          'clipId',
          'clipName',
          'durationSeconds',
          'sourceId',
          'sourceStartSeconds',
          'startOffsetSeconds',
          'timelineEndTick',
          'timelineStartTick',
        ],
        'Mixdown event',
      );

      if (
        !isTrimmedText(event.clipId) ||
        seenClipIds.has(event.clipId) ||
        !isTrimmedText(event.clipName) ||
        !isTrimmedText(event.sourceId) ||
        !isPositiveFinite(event.durationSeconds) ||
        !isNonNegativeFinite(event.sourceStartSeconds) ||
        !isNonNegativeFinite(event.startOffsetSeconds) ||
        !Number.isSafeInteger(event.timelineStartTick) ||
        !Number.isSafeInteger(event.timelineEndTick) ||
        event.timelineStartTick < 0 ||
        event.timelineStartTick < previousStartTick ||
        event.timelineEndTick <= event.timelineStartTick ||
        event.timelineEndTick > plan.endTick ||
        event.startOffsetSeconds + event.durationSeconds >
          plan.durationSeconds + 1 / RAW_MIXDOWN_SAMPLE_RATE ||
        !matchesOutputFrameTimelineTiming(
          event.startOffsetSeconds,
          event.timelineStartTick - plan.startTick,
          plan.bpm,
        ) ||
        !matchesTimelineDurationOrSourceClip(
          event.durationSeconds,
          event.timelineEndTick - event.timelineStartTick,
          plan.bpm,
        )
      ) {
        throw planInvalid('Mixdown event timing or identity is invalid.');
      }

      seenClipIds.add(event.clipId);
      previousStartTick = event.timelineStartTick;
    }
  }
}

function matchesOutputFrameTimelineTiming(seconds, ticks, bpm) {
  const timelineSeconds =
    (ticks * 60) / (bpm * PROJECT_TIMELINE_TICKS_PER_BEAT);
  return (
    Number.isFinite(timelineSeconds) &&
    Math.abs(seconds - timelineSeconds) <=
      OUTPUT_FRAME_TIMING_TOLERANCE_SECONDS &&
    Math.round(seconds * RAW_MIXDOWN_SAMPLE_RATE) ===
      Math.round(timelineSeconds * RAW_MIXDOWN_SAMPLE_RATE)
  );
}

function matchesTimelineDurationOrSourceClip(seconds, ticks, bpm) {
  // Absolute source endpoints can fall between Timeline ticks in either direction.
  // Accept the same nearest-tick representation used by the Project Clip.
  const sourceLengthTicks = Math.max(
    1,
    Math.round((seconds * bpm * PROJECT_TIMELINE_TICKS_PER_BEAT) / 60),
  );
  if (sourceLengthTicks === ticks || matchesOutputFrameTimelineTiming(seconds, ticks, bpm)) {
    return true;
  }

  const timelineSeconds =
    (ticks * 60) / (bpm * PROJECT_TIMELINE_TICKS_PER_BEAT);
  const clippedDurationSeconds = timelineSeconds - seconds;
  return (
    Number.isFinite(timelineSeconds) &&
    clippedDurationSeconds > 0 &&
    clippedDurationSeconds <= SOURCE_DURATION_CLIP_TOLERANCE_SECONDS
  );
}

function validateSources(descriptors, sourceBytesValue) {
  if (!(sourceBytesValue instanceof Map)) {
    throw sourceSetInvalid('Mixdown source bytes must be provided as one exact Map.');
  }

  if (sourceBytesValue.size !== descriptors.length) {
    throw sourceSetInvalid('Mixdown source byte entries do not match the Plan.');
  }

  const sources = new Map();

  for (const descriptor of descriptors) {
    validateSourceDescriptor(descriptor);

    if (sources.has(descriptor.sourceId) || !sourceBytesValue.has(descriptor.sourceId)) {
      throw sourceSetInvalid('Mixdown source descriptors are duplicated or unavailable.');
    }

    const bytes = toBuffer(sourceBytesValue.get(descriptor.sourceId));

    if (bytes.byteLength !== descriptor.sizeBytes) {
      throw failure(
        'MIXDOWN_SOURCE_SIZE_MISMATCH',
        `Mixdown source ${descriptor.sourceId} size does not match its frozen descriptor.`,
      );
    }

    sources.set(descriptor.sourceId, inspectPcm16Wave(bytes, descriptor.sourceId));
  }

  for (const sourceId of sourceBytesValue.keys()) {
    if (!sources.has(sourceId)) {
      throw sourceSetInvalid('Mixdown source byte entries contain an unexpected source.');
    }
  }

  return sources;
}

function validateSourceDescriptor(value) {
  if (value?.kind === 'generated') {
    requireExactKeys(
      value,
      ['kind', 'name', 'relativePath', 'sizeBytes', 'sourceId'],
      'Generated Mixdown source descriptor',
    );

    if (
      !isTrimmedText(value.sourceId) ||
      value.name !== `${value.sourceId}.wav` ||
      !isTrimmedText(value.relativePath) ||
      value.relativePath.includes('\\') ||
      value.relativePath.split('/').some(
        (segment) => segment === '' || segment === '.' || segment === '..',
      ) ||
      !isValidSourceSize(value.sizeBytes)
    ) {
      throw planInvalid('Generated Mixdown source descriptor is invalid.');
    }

    return;
  }

  if (value?.kind === 'external') {
    requireExactKeys(
      value,
      ['kind', 'lastModified', 'name', 'path', 'sizeBytes', 'sourceId'],
      'External Mixdown source descriptor',
    );

    if (
      !isTrimmedText(value.sourceId) ||
      !isTrimmedText(value.name) ||
      !isAbsoluteWindowsPath(value.path) ||
      !Number.isSafeInteger(value.lastModified) ||
      value.lastModified < 0 ||
      !isValidSourceSize(value.sizeBytes)
    ) {
      throw planInvalid('External Mixdown source descriptor is invalid.');
    }

    return;
  }

  throw planInvalid('Mixdown source descriptor kind is invalid.');
}

export function inspectPcm16Wave(bytes, sourceId) {
  if (
    bytes.byteLength < PCM_WAVE_HEADER_BYTES ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.readUInt32LE(4) + 8 !== bytes.byteLength
  ) {
    throw waveInvalid(sourceId, 'is not one complete RIFF/WAVE file');
  }

  let data;
  let format;
  let offset = RIFF_HEADER_BYTES;

  while (offset + CHUNK_HEADER_BYTES <= bytes.byteLength) {
    const chunkId = bytes.toString('ascii', offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + CHUNK_HEADER_BYTES;
    const paddedChunkEnd = chunkDataOffset + chunkSize + (chunkSize % 2);

    if (paddedChunkEnd > bytes.byteLength) {
      throw waveInvalid(sourceId, 'contains an incomplete WAVE chunk');
    }

    if (chunkId === 'fmt ') {
      if (format !== undefined || chunkSize < 16) {
        throw waveInvalid(sourceId, 'contains an invalid WAVE format chunk');
      }

      format = parsePcm16Format(bytes, chunkDataOffset, sourceId);
    } else if (chunkId === 'data') {
      if (data !== undefined || chunkSize === 0) {
        throw waveInvalid(sourceId, 'contains an invalid WAVE data chunk');
      }

      data = Object.freeze({
        byteLength: chunkSize,
        offset: chunkDataOffset,
      });
    }

    offset = paddedChunkEnd;
  }

  if (
    offset !== bytes.byteLength ||
    format === undefined ||
    data === undefined ||
    data.byteLength % format.blockAlign !== 0
  ) {
    throw waveInvalid(sourceId, 'has incomplete or inconsistent WAVE data');
  }

  const frameCount = data.byteLength / format.blockAlign;

  return Object.freeze({
    ...format,
    bytes,
    dataOffset: data.offset,
    durationSeconds: frameCount / format.sampleRate,
    frameCount,
    sourceId,
  });
}

function parsePcm16Format(bytes, offset, sourceId) {
  const audioFormat = bytes.readUInt16LE(offset);
  const channels = bytes.readUInt16LE(offset + 2);
  const sampleRate = bytes.readUInt32LE(offset + 4);
  const byteRate = bytes.readUInt32LE(offset + 8);
  const blockAlign = bytes.readUInt16LE(offset + 12);
  const bitsPerSample = bytes.readUInt16LE(offset + 14);
  const expectedBlockAlign = channels * 2;

  if (
    audioFormat !== 1 ||
    (channels !== 1 && channels !== 2) ||
    sampleRate < MIN_SAMPLE_RATE ||
    sampleRate > MAX_SAMPLE_RATE ||
    bitsPerSample !== 16 ||
    blockAlign !== expectedBlockAlign ||
    byteRate !== sampleRate * expectedBlockAlign
  ) {
    throw waveInvalid(
      sourceId,
      'must use mono or stereo uncompressed 16-bit PCM from 8 kHz through 192 kHz',
    );
  }

  return Object.freeze({
    blockAlign,
    channels,
    sampleRate,
  });
}

function createRuntimeEvents(plan, sources, outputFrameCount) {
  const requiredSourceIds = new Set();
  const events = [];

  for (const track of plan.tracks) {
    for (const event of track.events) {
      const source = sources.get(event.sourceId);

      if (!source) {
        throw sourceSetInvalid(
          `Mixdown event references unavailable source ${event.sourceId}.`,
        );
      }

      requiredSourceIds.add(event.sourceId);
      validateSourceRange(event, source);
      const channelDsp = createMixerChannelDspCoefficientsV2(
        track.gainDb,
        track.pan,
        source.channels,
      );
      const startFrame = secondsToFrameCount(
        event.startOffsetSeconds,
        RAW_MIXDOWN_SAMPLE_RATE,
        'Mixdown event start',
        true,
      );
      const durationFrames = secondsToFrameCount(
        event.durationSeconds,
        RAW_MIXDOWN_SAMPLE_RATE,
        'Mixdown event duration',
      );

      events.push(Object.freeze({
        endFrame: Math.min(outputFrameCount, startFrame + durationFrames),
        leftGain: channelDsp.leftOutputGain,
        rightGain: channelDsp.rightOutputGain,
        source,
        sourceStartFrame: event.sourceStartSeconds * source.sampleRate,
        startFrame,
        trackId: track.trackId,
      }));
    }
  }

  if (requiredSourceIds.size !== sources.size) {
    throw sourceSetInvalid('Mixdown Plan contains an unused source descriptor.');
  }

  return Object.freeze(events);
}

function validateSourceRange(event, source) {
  const requestedEndSeconds = event.sourceStartSeconds + event.durationSeconds;
  const toleranceSeconds = 1 / source.sampleRate;

  if (
    event.sourceStartSeconds >= source.durationSeconds ||
    requestedEndSeconds > source.durationSeconds + toleranceSeconds
  ) {
    throw failure(
      'MIXDOWN_SOURCE_RANGE_INVALID',
      `Mixdown event ${event.clipId} exceeds source ${event.sourceId}.`,
    );
  }
}

function mixEventRange(
  event,
  overlapStartFrame,
  overlapEndFrame,
  blockStartFrame,
  masterLeft,
  masterRight,
  channelLeft,
  channelRight,
) {
  const sourceFrameStep = event.source.sampleRate / RAW_MIXDOWN_SAMPLE_RATE;

  for (let outputFrame = overlapStartFrame; outputFrame < overlapEndFrame; outputFrame += 1) {
    const sourceFrame =
      event.sourceStartFrame +
      (outputFrame - event.startFrame) * sourceFrameStep;
    const sourceLeft = readInterpolatedSample(event.source, sourceFrame, 0);
    const sourceRight = event.source.channels === 1
      ? sourceLeft
      : readInterpolatedSample(event.source, sourceFrame, 1);
    const blockFrame = outputFrame - blockStartFrame;
    const outputLeft = sourceLeft * event.leftGain;
    const outputRight = sourceRight * event.rightGain;
    if (masterLeft && masterRight) {
      masterLeft[blockFrame] += outputLeft;
      masterRight[blockFrame] += outputRight;
    }
    channelLeft[blockFrame] += outputLeft;
    channelRight[blockFrame] += outputRight;
  }
}

function createMixerRuntime(plan, blockFrameCount) {
  try {
    const channels = plan.mixerSnapshot.channels.map((channel) => ({
      compressor: createMixerCompressorProcessor(
        channel.inserts[1],
        RAW_MIXDOWN_SAMPLE_RATE,
      ),
      delay: createMixerEchoDelayProcessor(
        channel.inserts[2],
        RAW_MIXDOWN_SAMPLE_RATE,
      ),
      equalizer: createMixerEqualizerProcessor(
        channel.inserts[0],
        RAW_MIXDOWN_SAMPLE_RATE,
      ),
      inputLeft: new Float64Array(blockFrameCount),
      inputRight: new Float64Array(blockFrameCount),
      meter: createMixerSamplePeakAccumulator(),
      trackId: channel.trackId,
    }));
    const channelByTrackId = new Map(
      channels.map((channel) => [channel.trackId, channel]),
    );
    const master = {
      compressor: createMixerCompressorProcessor(
        plan.mixerSnapshot.master.inserts[1],
        RAW_MIXDOWN_SAMPLE_RATE,
      ),
      equalizer: createMixerEqualizerProcessor(
        plan.mixerSnapshot.master.inserts[0],
        RAW_MIXDOWN_SAMPLE_RATE,
      ),
      gain: decibelsToMixerGain(plan.mixerSnapshot.master.faderDb),
      left: new Float64Array(blockFrameCount),
      limiter: createMixerLimiterProcessor(
        plan.mixerSnapshot.master.inserts[2],
        RAW_MIXDOWN_SAMPLE_RATE,
      ),
      meter: createMixerSamplePeakAccumulator(),
      right: new Float64Array(blockFrameCount),
    };

    return { channelByTrackId, channels, master };
  } catch {
    throw planInvalid('Mixdown effect processor configuration is invalid.');
  }
}

function prepareChannelInputBlocks(channels, blockFrameCount) {
  for (const channel of channels) {
    channel.inputLeft.fill(0, 0, blockFrameCount);
    channel.inputRight.fill(0, 0, blockFrameCount);
  }
}

function processChannelBlock(channel, blockFrameCount) {
  const inputLeft = channel.inputLeft.subarray(0, blockFrameCount);
  const inputRight = channel.inputRight.subarray(0, blockFrameCount);

  try {
    const equalized = processMixerEqualizerBlock(
      channel.equalizer,
      inputLeft,
      inputRight,
    );
    channel.equalizer = equalized.processor;
    const compressed = processMixerCompressorBlock(
      channel.compressor,
      equalized.leftSamples,
      equalized.rightSamples,
    );
    channel.compressor = compressed.processor;
    const delayed = processMixerEchoDelayBlock(
      channel.delay,
      compressed.leftSamples,
      compressed.rightSamples,
    );
    channel.delay = delayed.processor;
    assertFiniteStereoBlock(delayed.leftSamples, delayed.rightSamples);
    return delayed;
  } catch (error) {
    if (error instanceof ProjectPcmMixdownRenderError) {
      throw error;
    }

    throw failure(
      'MIXDOWN_DSP_STATE_INVALID',
      `Mixdown Channel ${channel.trackId} effects processing failed.`,
    );
  }
}

function processMasterBlock(master, left, right) {
  try {
    const equalized = processMixerEqualizerBlock(
      master.equalizer,
      left,
      right,
    );
    master.equalizer = equalized.processor;
    const compressed = processMixerCompressorBlock(
      master.compressor,
      equalized.leftSamples,
      equalized.rightSamples,
    );
    master.compressor = compressed.processor;
    const limited = processMixerLimiterBlock(
      master.limiter,
      compressed.leftSamples,
      compressed.rightSamples,
    );
    master.limiter = limited.processor;
    assertFiniteStereoBlock(limited.leftSamples, limited.rightSamples);
    return limited;
  } catch (error) {
    if (error instanceof ProjectPcmMixdownRenderError) {
      throw error;
    }

    throw failure(
      'MIXDOWN_DSP_STATE_INVALID',
      'Mixdown Master effects processing failed.',
    );
  }
}

function sumStereoBlock(targetLeft, targetRight, sourceLeft, sourceRight) {
  for (let index = 0; index < targetLeft.length; index += 1) {
    const left = targetLeft[index] + sourceLeft[index];
    const right = targetRight[index] + sourceRight[index];

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      throw failure(
        'MIXDOWN_DSP_STATE_INVALID',
        'Mixdown Master sum produced non-finite samples.',
      );
    }

    targetLeft[index] = left;
    targetRight[index] = right;
  }
}

function applyGainToStereoBlock(left, right, gain) {
  for (let index = 0; index < left.length; index += 1) {
    const outputLeft = left[index] * gain;
    const outputRight = right[index] * gain;

    if (!Number.isFinite(outputLeft) || !Number.isFinite(outputRight)) {
      throw failure(
        'MIXDOWN_DSP_STATE_INVALID',
        'Mixdown Master Fader produced non-finite samples.',
      );
    }

    left[index] = outputLeft;
    right[index] = outputRight;
  }
}

function assertFiniteStereoBlock(left, right) {
  if (left.length !== right.length) {
    throw new TypeError('Mixer effects output blocks have different lengths.');
  }

  for (let index = 0; index < left.length; index += 1) {
    if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) {
      throw new RangeError('Mixer effects output samples must be finite.');
    }
  }
}

function areAllEffectsBypassed(snapshot) {
  return (
    snapshot.channels.every((channel) =>
      channel.inserts.every((effect) => effect.bypass),
    ) && snapshot.master.inserts.every((effect) => effect.bypass)
  );
}

function createMeterSummary(runtime) {
  try {
    return createMixerMeterTapSummary(
      runtime.channels.map((channel) => ({
        accumulator: channel.meter,
        trackId: channel.trackId,
      })),
      runtime.master.meter,
    );
  } catch {
    throw failure(
      'MIXDOWN_METER_STATE_INVALID',
      'Mixdown meter summary state is invalid.',
    );
  }
}

export function readInterpolatedSample(source, framePosition, channel) {
  const lowerFrame = Math.min(
    source.frameCount - 1,
    Math.max(0, Math.floor(framePosition)),
  );
  const upperFrame = Math.min(source.frameCount - 1, lowerFrame + 1);
  const fraction = Math.min(1, Math.max(0, framePosition - lowerFrame));
  const lower = readPcm16Sample(source, lowerFrame, channel);
  const upper = readPcm16Sample(source, upperFrame, channel);
  return lower + (upper - lower) * fraction;
}

function readPcm16Sample(source, frame, channel) {
  const value = source.bytes.readInt16LE(
    source.dataOffset + frame * source.blockAlign + channel * 2,
  );
  return value < 0 ? value / 32_768 : value / 32_767;
}

export function createOutputWave(frameCount) {
  const blockAlign = RAW_MIXDOWN_CHANNELS * (RAW_MIXDOWN_BITS_PER_SAMPLE / 8);
  const dataByteLength = frameCount * blockAlign;

  if (
    !Number.isSafeInteger(dataByteLength) ||
    dataByteLength <= 0 ||
    dataByteLength > MAX_IN_MEMORY_OUTPUT_BYTES ||
    dataByteLength + 36 > MAX_RIFF_SIZE
  ) {
    throw failure(
      'MIXDOWN_OUTPUT_TOO_LARGE',
      'Mixdown output exceeds the RIFF/WAVE size limit.',
    );
  }

  let bytes;

  try {
    bytes = Buffer.alloc(PCM_WAVE_HEADER_BYTES + dataByteLength);
  } catch {
    throw failure(
      'MIXDOWN_OUTPUT_TOO_LARGE',
      'Mixdown output could not be allocated safely.',
    );
  }

  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(RAW_MIXDOWN_CHANNELS, 22);
  bytes.writeUInt32LE(RAW_MIXDOWN_SAMPLE_RATE, 24);
  bytes.writeUInt32LE(RAW_MIXDOWN_SAMPLE_RATE * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(RAW_MIXDOWN_BITS_PER_SAMPLE, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataByteLength, 40);
  return bytes;
}

export function writeOutputBlock(bytes, blockStartFrame, left, right) {
  for (let frame = 0; frame < left.length; frame += 1) {
    const outputOffset = PCM_WAVE_HEADER_BYTES + (blockStartFrame + frame) * 4;
    bytes.writeInt16LE(floatToPcm16(left[frame]), outputOffset);
    bytes.writeInt16LE(floatToPcm16(right[frame]), outputOffset + 2);
  }
}

function floatToPcm16(value) {
  if (value <= -1) {
    return -32_768;
  }

  if (value >= 1) {
    return 32_767;
  }

  return Math.round(value * (value < 0 ? 32_768 : 32_767));
}

function secondsToFrameCount(seconds, sampleRate, label, allowZero = false) {
  const frameCount = Math.round(seconds * sampleRate);

  if (
    !Number.isSafeInteger(frameCount) ||
    frameCount < 0 ||
    (!allowZero && frameCount === 0)
  ) {
    throw planInvalid(`${label} cannot be represented as PCM frames.`);
  }

  return frameCount;
}

function validateRenderOptions(value) {
  requireExactOptionKeys(value, ['blockFrameCount'], 'Mixdown render options');
  const blockFrameCount = value.blockFrameCount ?? OUTPUT_BLOCK_FRAMES;

  if (
    !Number.isSafeInteger(blockFrameCount) ||
    blockFrameCount <= 0 ||
    blockFrameCount > OUTPUT_BLOCK_FRAMES
  ) {
    throw new RangeError(
      `Mixdown render blockFrameCount must be from 1 through ${OUTPUT_BLOCK_FRAMES}.`,
    );
  }

  return blockFrameCount;
}

function requireExactOptionKeys(value, supportedKeys, label) {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }

  const actualKeys = Object.keys(value);
  if (actualKeys.some((key) => !supportedKeys.includes(key))) {
    throw new TypeError(`${label} keys are invalid.`);
  }
}

function isRepresentableMixerFader(value) {
  try {
    decibelsToMixerGain(value);
    return true;
  } catch {
    return false;
  }
}

function requireExactKeys(value, expectedKeys, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw planInvalid(`${label} must be an object.`);
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw planInvalid(`${label} keys are invalid.`);
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  throw sourceSetInvalid('Mixdown source must be provided as binary bytes.');
}

function isValidSourceSize(value) {
  return Number.isSafeInteger(value) && value >= PCM_WAVE_HEADER_BYTES;
}

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}

function isTrimmedText(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isAbsoluteWindowsPath(value) {
  return (
    isTrimmedText(value) &&
    (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value))
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function planInvalid(message) {
  return failure('MIXDOWN_PLAN_INVALID', message);
}

function sourceSetInvalid(message) {
  return failure('MIXDOWN_SOURCE_SET_INVALID', message);
}

function waveInvalid(sourceId, detail) {
  return failure(
    'MIXDOWN_SOURCE_WAV_INVALID',
    `Mixdown source ${sourceId} ${detail}.`,
  );
}

function failure(code, message) {
  return new ProjectPcmMixdownRenderError(code, message);
}
