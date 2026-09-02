import {
  PRINT_MIX_BITS_PER_SAMPLE,
  PRINT_MIX_CHANNELS,
  PRINT_MIX_MIME_TYPE,
  PRINT_MIX_NORMALIZE_TARGET_DBFS,
  PRINT_MIX_NORMALIZE_TARGET_PEAK,
  PRINT_MIX_PLAN_VERSION,
  PRINT_MIX_SAMPLE_RATE,
  PRINT_MIX_WAVE_FORMAT,
  isPrintMixOperationId,
} from '../shared/printMixProtocol.js';
import {
  createOutputWave,
  inspectPcm16Wave,
  readInterpolatedSample,
  writeOutputBlock,
} from './projectPcmMixdownRenderer.mjs';

const DEFAULT_BLOCK_FRAMES = 16_384;
const MAX_BLOCK_FRAMES = 1_048_576;
const TIMELINE_TICKS_PER_QUARTER = 960;
const FRAME_TIMING_TOLERANCE_SECONDS = 0.5 / PRINT_MIX_SAMPLE_RATE;

export class PrintMixPcmRenderError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'PrintMixPcmRenderError';
  }
}

export function validatePrintMixAudioPlan(value) {
  requireExactKeys(
    value,
    [
      'bpm',
      'durationSeconds',
      'durationTicks',
      'endTick',
      'events',
      'format',
      'mediaType',
      'normalize',
      'operationId',
      'patchTabId',
      'purpose',
      'selectedClipIds',
      'sourceLineage',
      'sources',
      'startTick',
      'targetPeakDbfs',
      'ticksPerQuarter',
      'version',
    ],
    'Audio PRINT MIX Plan',
  );
  requireExactKeys(
    value.format,
    [
      'bitsPerSample',
      'channels',
      'encoding',
      'extension',
      'mimeType',
      'sampleRate',
    ],
    'Audio PRINT MIX format',
  );

  if (
    value.version !== PRINT_MIX_PLAN_VERSION ||
    value.purpose !== 'print-mix' ||
    value.mediaType !== 'audio' ||
    !isPrintMixOperationId(value.operationId) ||
    !isTrimmedText(value.patchTabId) ||
    !isPositiveFinite(value.bpm) ||
    value.ticksPerQuarter !== TIMELINE_TICKS_PER_QUARTER ||
    !Number.isSafeInteger(value.startTick) ||
    value.startTick < 0 ||
    !Number.isSafeInteger(value.endTick) ||
    value.endTick <= value.startTick ||
    value.durationTicks !== value.endTick - value.startTick ||
    !isPositiveFinite(value.durationSeconds) ||
    typeof value.normalize !== 'boolean' ||
    value.targetPeakDbfs !== PRINT_MIX_NORMALIZE_TARGET_DBFS ||
    JSON.stringify(value.format) !== JSON.stringify(PRINT_MIX_WAVE_FORMAT)
  ) {
    throw planInvalid('Audio PRINT MIX Plan identity or format is invalid.');
  }

  const timelineDurationSeconds =
    (value.durationTicks * 60) /
    (value.bpm * TIMELINE_TICKS_PER_QUARTER);

  if (
    Math.abs(value.durationSeconds - timelineDurationSeconds) >
      FRAME_TIMING_TOLERANCE_SECONDS ||
    Math.round(value.durationSeconds * PRINT_MIX_SAMPLE_RATE) !==
      Math.round(timelineDurationSeconds * PRINT_MIX_SAMPLE_RATE)
  ) {
    throw planInvalid('Audio PRINT MIX duration contradicts its Timeline span.');
  }

  const selectedClipIds = validateUniqueTextArray(
    value.selectedClipIds,
    'Audio PRINT MIX selected Clip IDs',
  );

  if (selectedClipIds.length < 2) {
    throw planInvalid('Audio PRINT MIX requires at least two selected Clips.');
  }

  validateLineage(value.sourceLineage, selectedClipIds);
  const sourceIds = validateSources(value.sources);
  validateEvents(value.events, selectedClipIds, sourceIds, value.durationSeconds);
  return value;
}

export function renderPrintMixPcm(
  planValue,
  sourceBytesValue,
  options = {},
) {
  const plan = validatePrintMixAudioPlan(planValue);
  const sources = inspectSources(plan.sources, sourceBytesValue);
  const events = createRuntimeEvents(plan, sources);
  const outputFrameCount = Math.round(
    plan.durationSeconds * PRINT_MIX_SAMPLE_RATE,
  );
  const blockFrameCount = validateOptions(options);
  const preNormalizationPeak = scanPeak(
    events,
    outputFrameCount,
    blockFrameCount,
  );
  const appliedGain =
    plan.normalize && preNormalizationPeak > 0
      ? PRINT_MIX_NORMALIZE_TARGET_PEAK / preNormalizationPeak
      : 1;
  const bytes = createOutputWave(outputFrameCount);

  writeRenderedWave(
    bytes,
    events,
    outputFrameCount,
    blockFrameCount,
    appliedGain,
  );

  const outputPeak = preNormalizationPeak * appliedGain;

  return Object.freeze({
    appliedGain,
    bitsPerSample: PRINT_MIX_BITS_PER_SAMPLE,
    bytes,
    channels: PRINT_MIX_CHANNELS,
    clippingWarning: !plan.normalize && preNormalizationPeak > 1,
    durationSeconds: outputFrameCount / PRINT_MIX_SAMPLE_RATE,
    frameCount: outputFrameCount,
    mimeType: PRINT_MIX_MIME_TYPE,
    normalize: plan.normalize,
    outputPeak,
    preNormalizationPeak,
    sampleRate: PRINT_MIX_SAMPLE_RATE,
    sourceCount: plan.sources.length,
    targetPeakDbfs: PRINT_MIX_NORMALIZE_TARGET_DBFS,
  });
}

function validateLineage(value, selectedClipIds) {
  if (!Array.isArray(value) || value.length !== selectedClipIds.length) {
    throw planInvalid('Audio PRINT MIX source Lineage is incomplete.');
  }

  const clipIds = [];
  const clipTakeIds = new Set();

  for (const item of value) {
    requireExactKeys(
      item,
      ['artifactId', 'clipId', 'clipTakeId'],
      'Audio PRINT MIX source Lineage item',
    );

    if (
      !isTrimmedText(item.artifactId) ||
      !isTrimmedText(item.clipId) ||
      !isTrimmedText(item.clipTakeId) ||
      clipTakeIds.has(item.clipTakeId)
    ) {
      throw planInvalid('Audio PRINT MIX source Lineage identity is invalid.');
    }

    clipIds.push(item.clipId);
    clipTakeIds.add(item.clipTakeId);
  }

  if (!arraysEqual(clipIds, selectedClipIds)) {
    throw planInvalid('Audio PRINT MIX source Lineage does not match selection.');
  }
}

function validateSources(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw planInvalid('Audio PRINT MIX sources are unavailable.');
  }

  const sourceIds = new Set();

  for (const descriptor of value) {
    requireExactKeys(
      descriptor,
      ['kind', 'name', 'relativePath', 'sizeBytes', 'sourceId'],
      'Audio PRINT MIX source descriptor',
    );

    if (
      descriptor.kind !== 'generated' ||
      !isTrimmedText(descriptor.sourceId) ||
      sourceIds.has(descriptor.sourceId) ||
      descriptor.name !== `${descriptor.sourceId}.wav` ||
      !isNormalizedRelativeWavPath(descriptor.relativePath, descriptor.name) ||
      !Number.isSafeInteger(descriptor.sizeBytes) ||
      descriptor.sizeBytes <= 44
    ) {
      throw planInvalid('Audio PRINT MIX source descriptor is invalid.');
    }

    sourceIds.add(descriptor.sourceId);
  }

  return sourceIds;
}

function validateEvents(value, selectedClipIds, sourceIds, durationSeconds) {
  if (!Array.isArray(value) || value.length !== selectedClipIds.length) {
    throw planInvalid('Audio PRINT MIX events are incomplete.');
  }

  const eventClipIds = [];
  const usedSourceIds = new Set();

  for (const event of value) {
    requireExactKeys(
      event,
      [
        'clipId',
        'durationSeconds',
        'sourceId',
        'sourceStartSeconds',
        'startOffsetSeconds',
      ],
      'Audio PRINT MIX event',
    );

    if (
      !isTrimmedText(event.clipId) ||
      !sourceIds.has(event.sourceId) ||
      !isNonNegativeFinite(event.sourceStartSeconds) ||
      !isNonNegativeFinite(event.startOffsetSeconds) ||
      !isPositiveFinite(event.durationSeconds) ||
      event.startOffsetSeconds + event.durationSeconds >
        durationSeconds + FRAME_TIMING_TOLERANCE_SECONDS
    ) {
      throw planInvalid('Audio PRINT MIX event is invalid.');
    }

    eventClipIds.push(event.clipId);
    usedSourceIds.add(event.sourceId);
  }

  if (
    !arraysEqual(eventClipIds, selectedClipIds) ||
    usedSourceIds.size !== sourceIds.size
  ) {
    throw planInvalid('Audio PRINT MIX events do not match selection or sources.');
  }
}

function inspectSources(descriptors, sourceBytesValue) {
  if (!(sourceBytesValue instanceof Map) || sourceBytesValue.size !== descriptors.length) {
    throw sourceInvalid('Audio PRINT MIX requires one exact source byte Map.');
  }

  const sources = new Map();

  for (const descriptor of descriptors) {
    if (!sourceBytesValue.has(descriptor.sourceId)) {
      throw sourceInvalid('Audio PRINT MIX source bytes are missing.');
    }

    const bytes = sourceBytesValue.get(descriptor.sourceId);

    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== descriptor.sizeBytes) {
      throw sourceInvalid(
        `Audio PRINT MIX source ${descriptor.sourceId} size is stale.`,
      );
    }

    try {
      sources.set(
        descriptor.sourceId,
        inspectPcm16Wave(bytes, descriptor.sourceId),
      );
    } catch (error) {
      throw new PrintMixPcmRenderError(
        'PRINT_MIX_SOURCE_WAV_INVALID',
        `Audio PRINT MIX source ${descriptor.sourceId} is not supported PCM16 WAV.`,
        { cause: error },
      );
    }
  }

  return sources;
}

function createRuntimeEvents(plan, sources) {
  return Object.freeze(
    plan.events.map((event) => {
      const source = sources.get(event.sourceId);
      const requestedEndSeconds =
        event.sourceStartSeconds + event.durationSeconds;

      if (
        !source ||
        event.sourceStartSeconds >= source.durationSeconds ||
        requestedEndSeconds > source.durationSeconds + 1 / source.sampleRate
      ) {
        throw sourceInvalid(
          `Audio PRINT MIX event ${event.clipId} exceeds its frozen source.`,
        );
      }

      const startFrame = Math.round(
        event.startOffsetSeconds * PRINT_MIX_SAMPLE_RATE,
      );
      const durationFrames = Math.round(
        event.durationSeconds * PRINT_MIX_SAMPLE_RATE,
      );

      return Object.freeze({
        endFrame: startFrame + durationFrames,
        source,
        sourceStartFrame: event.sourceStartSeconds * source.sampleRate,
        startFrame,
      });
    }),
  );
}

function scanPeak(events, outputFrameCount, blockFrameCount) {
  let peak = 0;

  visitBlocks(events, outputFrameCount, blockFrameCount, (left, right) => {
    for (let frame = 0; frame < left.length; frame += 1) {
      peak = Math.max(peak, Math.abs(left[frame]), Math.abs(right[frame]));
    }
  });

  return peak;
}

function writeRenderedWave(
  bytes,
  events,
  outputFrameCount,
  blockFrameCount,
  gain,
) {
  visitBlocks(
    events,
    outputFrameCount,
    blockFrameCount,
    (left, right, blockStartFrame) => {
      for (let frame = 0; frame < left.length; frame += 1) {
        left[frame] *= gain;
        right[frame] *= gain;
      }
      writeOutputBlock(bytes, blockStartFrame, left, right);
    },
  );
}

function visitBlocks(events, outputFrameCount, blockFrameCount, visitor) {
  const leftBlock = new Float64Array(blockFrameCount);
  const rightBlock = new Float64Array(blockFrameCount);

  for (
    let blockStartFrame = 0;
    blockStartFrame < outputFrameCount;
    blockStartFrame += blockFrameCount
  ) {
    const frameCount = Math.min(
      blockFrameCount,
      outputFrameCount - blockStartFrame,
    );
    const left = leftBlock.subarray(0, frameCount);
    const right = rightBlock.subarray(0, frameCount);
    left.fill(0);
    right.fill(0);
    const blockEndFrame = blockStartFrame + frameCount;

    for (const event of events) {
      const overlapStart = Math.max(blockStartFrame, event.startFrame);
      const overlapEnd = Math.min(blockEndFrame, event.endFrame);

      for (let outputFrame = overlapStart; outputFrame < overlapEnd; outputFrame += 1) {
        const sourceFrame =
          event.sourceStartFrame +
          (outputFrame - event.startFrame) *
            (event.source.sampleRate / PRINT_MIX_SAMPLE_RATE);
        const sourceLeft = readInterpolatedSample(event.source, sourceFrame, 0);
        const sourceRight =
          event.source.channels === 1
            ? sourceLeft
            : readInterpolatedSample(event.source, sourceFrame, 1);
        const blockFrame = outputFrame - blockStartFrame;

        left[blockFrame] += sourceLeft;
        right[blockFrame] += sourceRight;
      }
    }

    visitor(left, right, blockStartFrame);
  }
}

function validateOptions(value) {
  if (!isRecord(value)) {
    throw new PrintMixPcmRenderError(
      'PRINT_MIX_OPTIONS_INVALID',
      'Audio PRINT MIX render options must be an object.',
    );
  }

  const keys = Object.keys(value);

  if (keys.some((key) => key !== 'blockFrameCount')) {
    throw new PrintMixPcmRenderError(
      'PRINT_MIX_OPTIONS_INVALID',
      'Audio PRINT MIX render options contain unsupported fields.',
    );
  }

  const blockFrameCount = value.blockFrameCount ?? DEFAULT_BLOCK_FRAMES;

  if (
    !Number.isSafeInteger(blockFrameCount) ||
    blockFrameCount <= 0 ||
    blockFrameCount > MAX_BLOCK_FRAMES
  ) {
    throw new PrintMixPcmRenderError(
      'PRINT_MIX_OPTIONS_INVALID',
      'Audio PRINT MIX blockFrameCount is invalid.',
    );
  }

  return blockFrameCount;
}

function validateUniqueTextArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((item) => !isTrimmedText(item)) ||
    new Set(value).size !== value.length
  ) {
    throw planInvalid(`${label} must be unique non-empty text.`);
  }
  return value;
}

function isNormalizedRelativeWavPath(value, fileName) {
  if (!isTrimmedText(value) || value.includes('\\') || !value.endsWith('.wav')) {
    return false;
  }
  const segments = value.split('/');
  return (
    segments.length >= 2 &&
    segments[segments.length - 1] === fileName &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes(':'),
    )
  );
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) {
    throw planInvalid(`${label} must be an object.`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    !actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  ) {
    throw planInvalid(`${label} fields are invalid.`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTrimmedText(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function planInvalid(message) {
  return new PrintMixPcmRenderError('PRINT_MIX_PLAN_INVALID', message);
}

function sourceInvalid(message) {
  return new PrintMixPcmRenderError('PRINT_MIX_SOURCE_INVALID', message);
}
