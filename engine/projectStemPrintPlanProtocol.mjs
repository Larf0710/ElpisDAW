import {
  PROJECT_STEM_PRINT_PLAN_VERSION,
  PROJECT_STEM_PRINT_PURPOSE,
} from '../shared/projectStemPrintProtocol.js';
import { RAW_MIXDOWN_PLAN_VERSION } from '../shared/rawMixdownProtocol.js';
import { GENERATED_AUDIO_PROJECT_DIRECTORIES } from './generatedAudioReader.mjs';
import { validateProjectPcmMixdownPlan } from './projectPcmMixdownRenderer.mjs';

const STEM_PRINT_PLAN_KEYS = Object.freeze([
  'audibleRange',
  'bpm',
  'durationSeconds',
  'effectsContractVersion',
  'endTick',
  'format',
  'masterFaderDb',
  'meterTapVersion',
  'mixerDspVersion',
  'mixerSnapshot',
  'mixerSnapshotVersion',
  'purpose',
  'selectedTargets',
  'sources',
  'startTick',
  'tracks',
  'version',
]);

export class ProjectStemPrintPlanProtocolError extends Error {
  constructor(message) {
    super(message);
    this.code = 'STEM_PRINT_PLAN_INVALID';
    this.name = 'ProjectStemPrintPlanProtocolError';
  }
}

export function parseProjectStemPrintPlan(value) {
  requireExactKeys(value, STEM_PRINT_PLAN_KEYS, 'Stem Print Plan');

  if (
    value.version !== PROJECT_STEM_PRINT_PLAN_VERSION ||
    value.purpose !== PROJECT_STEM_PRINT_PURPOSE
  ) {
    throw invalid('Stem Print Plan purpose or version is unsupported.');
  }

  validateAudibleRange(value.audibleRange, value);

  try {
    validateProjectPcmMixdownPlan(createRawMixdownValidationAdapter(value));
  } catch {
    throw invalid('Stem Print Plan render fields are invalid or unsupported.');
  }

  validateSelectedTargets(value.selectedTargets, value);
  validateExactSourceSchedule(value.sources, value.tracks);
  validateAudibleScheduleRange(value.audibleRange, value.tracks);

  return cloneAndFreeze(value);
}

function createRawMixdownValidationAdapter(value) {
  return {
    bpm: value.bpm,
    durationSeconds: value.durationSeconds,
    effectsContractVersion: value.effectsContractVersion,
    endTick: value.endTick,
    format: value.format,
    masterFaderDb: value.masterFaderDb,
    meterTapVersion: value.meterTapVersion,
    mixerDspVersion: value.mixerDspVersion,
    mixerSnapshot: value.mixerSnapshot,
    mixerSnapshotVersion: value.mixerSnapshotVersion,
    purpose: 'mixdown',
    sources: value.sources,
    startTick: value.startTick,
    tracks: value.tracks,
    version: RAW_MIXDOWN_PLAN_VERSION,
  };
}

function validateAudibleRange(value, plan) {
  requireExactKeys(value, ['endTick', 'startTick'], 'Stem Print audible range');

  if (
    !Number.isSafeInteger(value.startTick) ||
    !Number.isSafeInteger(value.endTick) ||
    value.startTick < plan.startTick ||
    value.endTick <= value.startTick ||
    value.endTick > plan.endTick
  ) {
    throw invalid('Stem Print audible range is invalid.');
  }
}

function validateSelectedTargets(targets, plan) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw invalid('Stem Print Plan must contain selected targets.');
  }

  const channels = new Map(
    plan.mixerSnapshot.channels.map((channel) => [channel.trackId, channel]),
  );
  const targetByResolvedTrackId = new Map();
  const selectedKeys = new Set();
  const groupTrackIds = new Set();

  for (const target of targets) {
    if (target?.kind === 'channel') {
      requireExactKeys(
        target,
        ['kind', 'resolvedTrackId', 'trackId'],
        'Stem Print Channel target',
      );

      if (
        !isTrimmedText(target.trackId) ||
        target.resolvedTrackId !== target.trackId
      ) {
        throw invalid('Stem Print Channel target identity is invalid.');
      }

      validateUniqueTarget(
        target,
        `channel:${target.trackId}`,
        channels,
        selectedKeys,
        targetByResolvedTrackId,
      );
      continue;
    }

    if (target?.kind === 'group') {
      requireExactKeys(
        target,
        ['groupTrackId', 'kind', 'resolvedTrackId'],
        'Stem Print Group target',
      );

      if (
        !isTrimmedText(target.groupTrackId) ||
        !isTrimmedText(target.resolvedTrackId) ||
        target.groupTrackId === target.resolvedTrackId ||
        channels.has(target.groupTrackId) ||
        groupTrackIds.has(target.groupTrackId)
      ) {
        throw invalid('Stem Print Group target lineage is invalid.');
      }

      groupTrackIds.add(target.groupTrackId);
      validateUniqueTarget(
        target,
        `group:${target.groupTrackId}`,
        channels,
        selectedKeys,
        targetByResolvedTrackId,
      );
      continue;
    }

    throw invalid('Stem Print target kind is unsupported.');
  }

  let previousTargetIndex = -1;

  for (const track of plan.tracks) {
    const target = targetByResolvedTrackId.get(track.trackId);

    if (
      !target ||
      (target.kind === 'channel' && track.groupTrackId !== undefined) ||
      (target.kind === 'group' && track.groupTrackId !== target.groupTrackId)
    ) {
      throw invalid('Stem Print Track schedule contradicts selected target lineage.');
    }

    const targetIndex = targets.indexOf(target);

    if (targetIndex <= previousTargetIndex) {
      throw invalid('Stem Print Track schedule order contradicts selected targets.');
    }

    previousTargetIndex = targetIndex;
  }
}

function validateUniqueTarget(
  target,
  selectedKey,
  channels,
  selectedKeys,
  targetByResolvedTrackId,
) {
  if (
    !isTrimmedText(target.resolvedTrackId) ||
    selectedKeys.has(selectedKey) ||
    targetByResolvedTrackId.has(target.resolvedTrackId) ||
    !channels.has(target.resolvedTrackId)
  ) {
    throw invalid('Stem Print selected target set is invalid or duplicated.');
  }

  selectedKeys.add(selectedKey);
  targetByResolvedTrackId.set(target.resolvedTrackId, target);
}

function validateExactSourceSchedule(sources, tracks) {
  sources.forEach(validateExactStemSourceDescriptor);
  const descriptorSourceIds = sources.map((source) => source.sourceId);
  const scheduledSourceIds = [];
  const seenSourceIds = new Set();

  for (const track of tracks) {
    let previousEvent;

    for (const event of track.events) {
      if (
        previousEvent &&
        previousEvent.timelineStartTick === event.timelineStartTick &&
        previousEvent.clipId > event.clipId
      ) {
        throw invalid('Stem Print event order is not canonical.');
      }

      previousEvent = event;

      if (!seenSourceIds.has(event.sourceId)) {
        seenSourceIds.add(event.sourceId);
        scheduledSourceIds.push(event.sourceId);
      }
    }
  }

  if (
    descriptorSourceIds.length !== scheduledSourceIds.length ||
    descriptorSourceIds.some(
      (sourceId, index) => sourceId !== scheduledSourceIds[index],
    )
  ) {
    throw invalid('Stem Print source descriptors do not match scheduled sources exactly.');
  }
}

function validateExactStemSourceDescriptor(source) {
  if (source.kind !== 'generated') {
    return;
  }

  const segments = source.relativePath.split('/');

  if (
    /^[a-zA-Z]:/.test(source.relativePath) ||
    segments.some((segment) => segment.includes(':')) ||
    segments[segments.length - 1] !== source.name ||
    source.relativePath.toLowerCase().endsWith('.partial') ||
    !source.relativePath.endsWith('.wav') ||
    !GENERATED_AUDIO_PROJECT_DIRECTORIES.some(
      (directory) =>
        source.relativePath.startsWith(`${directory}/`) &&
        source.relativePath.length > directory.length + 1,
    )
  ) {
    throw invalid('Stem Print generated source descriptor path is invalid.');
  }
}

function validateAudibleScheduleRange(audibleRange, tracks) {
  const events = tracks.flatMap((track) => track.events);
  const startTick = Math.min(...events.map((event) => event.timelineStartTick));
  const endTick = Math.max(...events.map((event) => event.timelineEndTick));

  if (
    audibleRange.startTick !== startTick ||
    audibleRange.endTick !== endTick
  ) {
    throw invalid('Stem Print audible range contradicts its scheduled events.');
  }
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreeze));
  }

  if (isRecord(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, cloneAndFreeze(entry)]),
      ),
    );
  }

  return value;
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) {
    throw invalid(`${label} must be an object.`);
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw invalid(`${label} keys are invalid.`);
  }
}

function isTrimmedText(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message) {
  return new ProjectStemPrintPlanProtocolError(message);
}
