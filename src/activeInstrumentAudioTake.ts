import { resolveActiveMidiTake } from './activeMidiTake';
import {
  createInstrumentRenderJobRequest,
  INSTRUMENT_RENDER_TASK_ID,
  type InstrumentRenderSoundFontResource,
} from './instrumentRenderContract';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
  SoundFontAssignment,
} from './types';

export type ActiveInstrumentAudioTakeFailureReason =
  | 'active-take-not-audio'
  | 'active-take-not-found'
  | 'active-take-not-selected'
  | 'artifact-invalid'
  | 'artifact-not-audio'
  | 'artifact-not-found'
  | 'clip-not-found'
  | 'file-invalid'
  | 'lineage-invalid'
  | 'source-midi-unavailable'
  | 'source-mismatch'
  | 'target-not-instrument-audio';

export type ActiveInstrumentAudioTakePlan = Readonly<{
  audio: Readonly<{
    channels: 2;
    durationSeconds: number;
    mimeType: 'audio/wav';
  }>;
  descriptor: Readonly<{
    kind: 'generated';
    name: string;
    relativePath: string;
    sizeBytes: number;
    sourceId: string;
  }>;
  file: Readonly<{
    extension: '.wav';
    name: string;
    relativePath: string;
    sizeBytes: number;
  }>;
  midiSource: Readonly<{
    artifactId: string;
    clipId: string;
    clipTakeId: string;
  }>;
  source: Readonly<{
    artifactId: string;
    clipId: string;
    clipTakeId: string;
    sourceJobId: string;
  }>;
}>;

export type ActiveInstrumentAudioTakeResolution =
  | Readonly<{
      canResolve: true;
      plan: ActiveInstrumentAudioTakePlan;
    }>
  | Readonly<{
      canResolve: false;
      message: string;
      reason: ActiveInstrumentAudioTakeFailureReason;
    }>;

export function resolveActiveInstrumentAudioTake(
  project: ProjectState,
  clipId: string,
): ActiveInstrumentAudioTakeResolution {
  const clips = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);

  if (clips.length !== 1) {
    return fail(
      'clip-not-found',
      `Instrument Audio Clip does not resolve uniquely: ${clipId}.`,
    );
  }

  const clip = clips[0];

  if (clip.type !== 'instrument-audio') {
    return fail(
      'target-not-instrument-audio',
      `${clip.name} cannot provide an Instrument Audio Take.`,
    );
  }

  if (!clip.activeClipTakeId) {
    return fail(
      'active-take-not-selected',
      `${clip.name} does not have an Active Instrument Audio Take.`,
    );
  }

  const activeTakes = (clip.clipTakes ?? []).filter(
    (take) => take.clipTakeId === clip.activeClipTakeId,
  );

  if (activeTakes.length !== 1) {
    return fail(
      'active-take-not-found',
      `${clip.name} Active Take does not resolve uniquely.`,
    );
  }

  const activeTake = activeTakes[0];

  if (activeTake.mediaType !== 'audio') {
    return fail(
      'active-take-not-audio',
      `${clip.name} Active Take does not contain audio.`,
    );
  }

  const artifacts = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === activeTake.artifactId,
  );

  if (artifacts.length !== 1) {
    return fail(
      'artifact-not-found',
      `${clip.name} Active Audio Artifact does not resolve uniquely.`,
    );
  }

  const artifact = artifacts[0];

  if (artifact.kind !== 'audio') {
    return fail(
      'artifact-not-audio',
      `${clip.name} Active Take references a non-Audio Artifact.`,
    );
  }

  if (
    artifact.destination === 'recording' ||
    artifact.destination !== 'instrument' ||
    activeTake.sourceType !== 'job' ||
    activeTake.sourceJobId !== artifact.sourceJobId
  ) {
    return fail(
      'source-mismatch',
      `${clip.name} Active Take source does not match its Instrument Audio Artifact.`,
    );
  }

  const generatedArtifact = artifact;
  const generatedTake = activeTake;
  const sourceMidiClipId = clip.sourceClipId;

  if (!sourceMidiClipId) {
    return fail(
      'source-midi-unavailable',
      `${clip.name} does not reference its source MIDI Clip.`,
    );
  }

  const sourceMidiClips = project.tracks
    .flatMap((track) => track.clips)
    .filter((candidate) => candidate.id === sourceMidiClipId);

  if (sourceMidiClips.length !== 1) {
    return fail(
      'source-midi-unavailable',
      `${clip.name} source MIDI Clip does not resolve uniquely.`,
    );
  }

  const midiSource = resolveActiveMidiTake(project, sourceMidiClipId);

  if (!midiSource.canResolve) {
    return fail(
      'source-midi-unavailable',
      `${clip.name} source MIDI is unavailable: ${midiSource.message}`,
    );
  }

  if (
    generatedArtifact.lineage.parentArtifactIds.length !== 1 ||
    generatedArtifact.lineage.parentClipTakeIds.length !== 1 ||
    generatedArtifact.lineage.parentArtifactIds[0] !==
      midiSource.plan.source.artifactId ||
    generatedArtifact.lineage.parentClipTakeIds[0] !==
      midiSource.plan.source.clipTakeId
  ) {
    return fail(
      'lineage-invalid',
      `${clip.name} Instrument Audio Lineage does not match its Active MIDI Take.`,
    );
  }

  if (
    !isValidInstrumentArtifact(
      generatedArtifact,
      midiSource.plan,
      sourceMidiClips[0].soundFont,
    )
  ) {
    return fail(
      'artifact-invalid',
      `${clip.name} Active Instrument Audio Artifact has invalid render metadata.`,
    );
  }

  const file = normalizeInstrumentFile(generatedArtifact);

  if (!file) {
    return fail(
      'file-invalid',
      `${clip.name} Active Instrument Audio file metadata is invalid.`,
    );
  }

  if (
    generatedArtifact.audio.channels !== 2 ||
    generatedArtifact.audio.mimeType !== 'audio/wav' ||
    typeof generatedArtifact.audio.durationSeconds !== 'number' ||
    !Number.isFinite(generatedArtifact.audio.durationSeconds) ||
    generatedArtifact.audio.durationSeconds <= 0
  ) {
    return fail(
      'artifact-invalid',
      `${clip.name} Active Instrument Audio metadata is invalid.`,
    );
  }

  const audio = Object.freeze({
    channels: 2 as const,
    durationSeconds: generatedArtifact.audio.durationSeconds,
    mimeType: 'audio/wav' as const,
  });
  const descriptor = Object.freeze({
    kind: 'generated' as const,
    name: file.name,
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    sourceId: generatedArtifact.artifactId,
  });
  const source = Object.freeze({
    artifactId: generatedArtifact.artifactId,
    clipId: clip.id,
    clipTakeId: generatedTake.clipTakeId,
    sourceJobId: generatedArtifact.sourceJobId,
  });
  const upstreamMidi = Object.freeze({
    artifactId: midiSource.plan.source.artifactId,
    clipId: midiSource.plan.source.clipId,
    clipTakeId: midiSource.plan.source.clipTakeId,
  });

  return Object.freeze({
    canResolve: true,
    plan: Object.freeze({
      audio,
      descriptor,
      file,
      midiSource: upstreamMidi,
      source,
    }),
  });
}

function isValidInstrumentArtifact(
  artifact: GeneratedAudioArtifact,
  plan: Parameters<typeof createInstrumentRenderJobRequest>[0]['plan'],
  assignment: SoundFontAssignment | undefined,
): boolean {
  if (
    artifact.provenance.taskId !== INSTRUMENT_RENDER_TASK_ID ||
    !isRecord(artifact.provenance.parameters)
  ) {
    return false;
  }

  const parameters = artifact.provenance.parameters;
  const preset = isRecord(parameters.preset) ? parameters.preset : undefined;
  const soundFont = isRecord(parameters.soundFont)
    ? parameters.soundFont as InstrumentRenderSoundFontResource
    : undefined;

  if (
    !preset ||
    !doesSoundFontSnapshotMatchAssignment(soundFont, preset, assignment)
  ) {
    return false;
  }

  try {
    const request = createInstrumentRenderJobRequest({
      gainDb: parameters.gainDb as number,
      modelId: artifact.provenance.modelId,
      modelRevision: artifact.provenance.modelRevision,
      plan,
      preset: {
        bank: preset.bank as number,
        program: preset.program as number,
      },
      providerId: artifact.provenance.providerId,
      providerVersion: parameters.providerVersion as string,
      sampleRate: parameters.sampleRate as number,
      ...(soundFont ? { soundFont } : {}),
    });
    const requestParameters = request.parameters;
    const hasSourceMidiIdentity =
      typeof parameters.sourceMidiContentHash === 'string' &&
      Number.isSafeInteger(parameters.sourceMidiRevision);
    const comparableRequestParameters = hasSourceMidiIdentity
      ? requestParameters
      : {
          channels: requestParameters.channels,
          gainDb: requestParameters.gainDb,
          preset: requestParameters.preset,
          providerVersion: requestParameters.providerVersion,
          sampleRate: requestParameters.sampleRate,
        };

    return (
      (hasSourceMidiIdentity || plan.source.revision === 1) &&
      areStringArraysEqual(
        artifact.lineage.parentArtifactIds,
        request.lineage.parentArtifactIds,
      ) &&
      areStringArraysEqual(
        artifact.lineage.parentClipTakeIds,
        request.lineage.parentClipTakeIds,
      ) &&
      areJsonValuesEqual(
        artifact.provenance.parameters,
        comparableRequestParameters,
      )
    );
  } catch {
    return false;
  }
}

function doesSoundFontSnapshotMatchAssignment(
  soundFont: InstrumentRenderSoundFontResource | undefined,
  preset: Record<string, unknown>,
  assignment: SoundFontAssignment | undefined,
): boolean {
  if (!soundFont) {
    return assignment === undefined;
  }

  return Boolean(
    assignment &&
    assignment.bank === preset.bank &&
    assignment.program === preset.program &&
    assignment.resource.format === soundFont.format &&
    assignment.resource.library === soundFont.library &&
    assignment.resource.relativePath === soundFont.relativePath &&
    assignment.resource.resourceId === soundFont.resourceId,
  );
}

function normalizeInstrumentFile(
  artifact: GeneratedAudioArtifact,
): ActiveInstrumentAudioTakePlan['file'] | undefined {
  const file = artifact.file;

  if (
    file.extension !== '.wav' ||
    !isSafeFileName(file.name) ||
    !file.name.toLowerCase().endsWith('.wav') ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes <= 44
  ) {
    return undefined;
  }

  const relativePath = file.relativePath;
  const segments = relativePath.split('/');

  if (
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    /^[a-zA-Z]:/.test(relativePath) ||
    !relativePath.startsWith('renders/instruments/') ||
    relativePath.toLowerCase().endsWith('.partial') ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':'),
    ) ||
    segments[segments.length - 1] !== file.name
  ) {
    return undefined;
  }

  return Object.freeze({
    extension: '.wav' as const,
    name: file.name,
    relativePath,
    sizeBytes: file.sizeBytes,
  });
}

function isSafeFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  );
}

function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => areJsonValuesEqual(value, right[index]))
    );
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        areJsonValuesEqual(left[key], right[key]),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(
  reason: ActiveInstrumentAudioTakeFailureReason,
  message: string,
): ActiveInstrumentAudioTakeResolution {
  return Object.freeze({
    canResolve: false,
    message,
    reason,
  });
}
