import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import {
  PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
  PROJECT_MIXDOWN_API_PROTOCOL_VERSION_V1,
  isProjectMixdownOperationId,
} from '../shared/projectMixdownApiProtocol.js';
import {
  PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
  createProjectStemPrintArtifactId,
  isProjectStemPrintOperationId,
} from '../shared/projectStemPrintApiProtocol.js';
import {
  PROJECT_STEM_PRINT_PLAN_VERSION,
} from '../shared/projectStemPrintProtocol.js';
import {
  PROJECT_MIXDOWN_RENDERER_ID,
  PROJECT_MIXDOWN_RENDERER_VERSION,
  RAW_MIXDOWN_BITS_PER_SAMPLE,
  RAW_MIXDOWN_CHANNELS,
  RAW_MIXDOWN_MIME_TYPE,
  RAW_MIXDOWN_PLAN_VERSION,
  RAW_MIXDOWN_PLAN_VERSION_V1,
  RAW_MIXDOWN_PLAN_VERSION_V2,
  RAW_MIXDOWN_SAMPLE_RATE,
} from '../shared/rawMixdownProtocol.js';
import {
  MIXER_DSP_CONTRACT_VERSION_V1,
  MIXER_DSP_CONTRACT_VERSION_V2,
  MIXER_RENDER_SNAPSHOT_VERSION,
  decibelsToMixerGain,
} from '../shared/mixerDspContract.js';
import { MIXER_EFFECTS_CONTRACT_VERSION } from '../shared/mixerEffectsContract.js';
import { MIXER_METER_TAP_CONTRACT_VERSION } from '../shared/mixerMeterTapContract.js';
import { doesClipTakeMatchArtifact } from './clipTakeActivation';
import { createSynchronizedClipSourceFile } from './clipSourceSynchronization';
import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import {
  HUM_TO_MIDI_TASK_ID,
  normalizeMidiNotes,
} from './humToMidiContract';
import { createMidiContentHash } from './midiContentHash';
import {
  parsePrintMixArtifact,
  parsePrintMixClipTake,
} from './printMixArtifactContract';
import { MIDI_EDIT_TASK_ID } from './midiEditArtifact';
import {
  createCanonicalProjectMixdownPlanJson,
  createCanonicalProjectStemPrintPlanJson,
} from './projectMixdownPlanIdentity';
import type { ProjectStemPrintPlan } from './projectStemPrintPlan';
import {
  PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2,
  assertProjectMixerRenderSnapshotV2,
} from './projectMixerRenderSnapshot';
import type {
  ArtifactLineage,
  ArtifactProvenance,
  AudioArtifact,
  AudioArtifactMetadata,
  Clip,
  ClipTake,
  EditedMidiArtifact,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  GeneratedMidiArtifact,
  ManualMidiArtifact,
  MidiArtifact,
  MidiClipTake,
  ProjectArtifact,
  ProjectJsonValue,
  ProjectMixdownAudioArtifact,
  ProjectMixdownAudioClipTake,
  ProjectStemPrintAudioArtifact,
  ProjectStemPrintAudioClipTake,
  ProjectState,
  PunchAudioArtifact,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';
import {
  RECORDING_BPM_MAX,
  RECORDING_BPM_MIN,
} from './recordingTiming';
import { TICKS_PER_QUARTER } from './workflow';

const MANUAL_MIDI_TASK_ID = 'manual-midi' as const;

export type CompletedAudioJobRegistrationOptions = Readonly<{
  activate?: boolean;
  clipId: string;
  label?: string;
  sourceAvailability?: GeneratedAudioCommitAvailabilityEvidence;
}>;

export type ProjectArtifactRegistrationFailureReason =
  | 'artifact-conflict'
  | 'clip-not-found'
  | 'job-not-completed'
  | 'job-result-invalid'
  | 'target-not-audio';

export type ProjectArtifactRegistrationUpdate =
  | Readonly<{
      artifact: AudioArtifact;
      canRegister: true;
      clipTake: ClipTake;
      project: ProjectState;
      status: 'ALREADY_REGISTERED' | 'REGISTERED';
    }>
  | Readonly<{
      canRegister: false;
      message: string;
      reason: ProjectArtifactRegistrationFailureReason;
    }>;

export type MidiArtifactRegistrationOptions = Readonly<{
  activate?: boolean;
  clipId: string;
  label?: string;
}>;

export type MidiArtifactRegistrationFailureReason =
  | 'artifact-conflict'
  | 'artifact-invalid'
  | 'clip-not-found'
  | 'source-lineage-invalid'
  | 'target-not-midi';

export type MidiArtifactRegistrationUpdate =
  | Readonly<{
      artifact: MidiArtifact;
      canRegister: true;
      clipTake: MidiClipTake;
      project: ProjectState;
      status: 'ALREADY_REGISTERED' | 'REGISTERED';
    }>
  | Readonly<{
      canRegister: false;
      message: string;
      reason: MidiArtifactRegistrationFailureReason;
    }>;

const audioClipTypes = new Set<Clip['type']>([
  'hum-audio',
  'instrument-audio',
  'arrangement',
  'vocal-audio',
  'ai-fill-audio',
  'mixdown',
  'master',
]);
const midiClipTypes = new Set<Clip['type']>(['midi-notes', 'edited-midi']);
const generatedArtifactDestinations = new Set<GeneratedAudioArtifact['destination']>([
  'ace-step',
  'export',
  'instrument',
  'mixdown',
  'stable-audio-3',
]);
const generatedArtifactDirectories: Readonly<
  Record<GeneratedAudioArtifact['destination'], string>
> = Object.freeze({
  'ace-step': 'renders/ace-step',
  export: 'exports',
  instrument: 'renders/instruments',
  mixdown: 'mixdowns',
  'stable-audio-3': 'renders/stable-audio-3',
});
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTIFACT_EXTENSION_PATTERN = /^\.[a-z0-9]{1,10}$/;
const MAX_JSON_DEPTH = 16;

export function createCompletedAudioJobRegistration(
  project: ProjectState,
  job: LocalEngineGpuJobRecord,
  options: CompletedAudioJobRegistrationOptions,
): ProjectArtifactRegistrationUpdate {
  if (job.state !== 'COMPLETED') {
    return {
      canRegister: false,
      message: `Artifact registration requires a COMPLETED Job, not ${job.state}.`,
      reason: 'job-not-completed',
    };
  }

  const artifact = parseCompletedAudioArtifact(job);

  if (!artifact) {
    return {
      canRegister: false,
      message: 'Completed Job result does not contain a valid finalized Audio Artifact.',
      reason: 'job-result-invalid',
    };
  }

  const target = findClip(project, options.clipId);

  if (!target) {
    return {
      canRegister: false,
      message: `Clip Take registration target was not found: ${options.clipId}.`,
      reason: 'clip-not-found',
    };
  }

  if (!audioClipTypes.has(target.clip.type)) {
    return {
      canRegister: false,
      message: `${target.clip.name} cannot receive an Audio Clip Take.`,
      reason: 'target-not-audio',
    };
  }

  const artifacts = project.artifacts ?? [];
  const existingArtifact = artifacts.find(
    (candidate) => candidate.artifactId === artifact.artifactId,
  );
  const existingTake = (target.clip.clipTakes ?? []).find(
    (candidate) =>
      candidate.artifactId === artifact.artifactId &&
      candidate.sourceType === 'job' &&
      candidate.sourceJobId === job.jobId,
  );
  const matchingTakeCount = project.tracks.reduce(
    (count, track) =>
      count +
      track.clips.reduce(
        (clipCount, clip) =>
          clipCount +
          (clip.clipTakes ?? []).filter(
            (take) =>
              take.artifactId === artifact.artifactId ||
              (take.sourceType === 'job' && take.sourceJobId === job.jobId),
          ).length,
        0,
      ),
    0,
  );

  if (
    existingArtifact?.kind === 'audio' &&
    'sourceJobId' in existingArtifact &&
    existingArtifact.sourceJobId === job.jobId &&
    JSON.stringify(existingArtifact) === JSON.stringify(artifact) &&
    existingTake &&
    existingTake.clipTakeId === createClipTakeId(artifact.artifactId) &&
    matchingTakeCount === 1
  ) {
    return {
      artifact: existingArtifact,
      canRegister: true,
      clipTake: existingTake,
      project,
      status: 'ALREADY_REGISTERED',
    };
  }

  if (
    existingArtifact ||
    matchingTakeCount > 0
  ) {
    return {
      canRegister: false,
      message: `Job ${job.jobId} or Artifact ${artifact.artifactId} is already registered elsewhere.`,
      reason: 'artifact-conflict',
    };
  }

  const clipTake = createClipTake(
    artifact,
    job.jobId,
    normalizeTakeLabel(options.label, target.clip),
  );
  const clipTakes = [...(target.clip.clipTakes ?? []), clipTake];
  const activeClipTakeId =
    options.activate === false && target.clip.activeClipTakeId
      ? target.clip.activeClipTakeId
      : clipTake.clipTakeId;
  const activeClipTake = clipTakes.find(
    (candidate) => candidate.clipTakeId === activeClipTakeId,
  );
  const nextArtifacts = [...artifacts, artifact];
  const activeAudioArtifacts = activeClipTake
    ? nextArtifacts.filter(
        (candidate): candidate is AudioArtifact =>
          candidate.kind === 'audio' &&
          candidate.artifactId === activeClipTake.artifactId &&
          doesClipTakeMatchArtifact(activeClipTake, candidate),
      )
    : [];

  if (
    activeClipTake?.mediaType === 'audio' &&
    activeAudioArtifacts.length !== 1
  ) {
    return {
      canRegister: false,
      message: 'Active Audio Take does not resolve to one matching Project Artifact.',
      reason: 'artifact-conflict',
    };
  }

  const nextSourceFile =
    activeClipTake?.mediaType === 'audio' && activeAudioArtifacts[0]
      ? createSynchronizedClipSourceFile(
          activeAudioArtifacts[0],
          target.clip.sourceFile,
          options.sourceAvailability,
        )
      : target.clip.sourceFile;
  const nextClip: Clip = {
    ...target.clip,
    activeClipTakeId,
    clipTakes,
    ...(nextSourceFile ? { sourceFile: nextSourceFile } : {}),
    version: target.clip.version + 1,
  };
  const nextProject: ProjectState = {
    ...project,
    artifacts: nextArtifacts,
    tracks: project.tracks.map((track, trackIndex) =>
      trackIndex === target.trackIndex
        ? {
            ...track,
            clips: track.clips.map((clip, clipIndex) =>
              clipIndex === target.clipIndex ? nextClip : clip,
            ),
          }
        : track,
    ),
  };

  return {
    artifact,
    canRegister: true,
    clipTake,
    project: nextProject,
    status: 'REGISTERED',
  };
}

export function createMidiArtifactRegistration(
  project: ProjectState,
  artifactValue: unknown,
  options: MidiArtifactRegistrationOptions,
): MidiArtifactRegistrationUpdate {
  const artifact = parseMidiArtifact(artifactValue);

  if (!artifact) {
    return {
      canRegister: false,
      message: 'MIDI Artifact registration requires a valid inline MIDI Artifact.',
      reason: 'artifact-invalid',
    };
  }

  const target = findClip(project, options.clipId);

  if (!target) {
    return {
      canRegister: false,
      message: `MIDI Clip Take registration target was not found: ${options.clipId}.`,
      reason: 'clip-not-found',
    };
  }

  if (!midiClipTypes.has(target.clip.type)) {
    return {
      canRegister: false,
      message: `${target.clip.name} cannot receive a MIDI Clip Take.`,
      reason: 'target-not-midi',
    };
  }

  if (!hasValidMidiSourceLineage(project, artifact, target.clip)) {
    return {
      canRegister: false,
      message: 'sourceJobId' in artifact
        ? 'Generated MIDI Artifact lineage must resolve to one Audio Artifact and its Audio Clip Take.'
        : 'sourceManualId' in artifact
          ? 'Manual MIDI Artifact lineage must be an empty root.'
          : 'Edited MIDI Artifact lineage must resolve to one MIDI Artifact and its MIDI Clip Take.',
      reason: 'source-lineage-invalid',
    };
  }

  const artifacts = project.artifacts ?? [];
  const sourceIdentity = getMidiArtifactSourceIdentity(artifact);
  const existingArtifact = artifacts.find(
    (candidate) => candidate.artifactId === artifact.artifactId,
  );
  const existingTake = (target.clip.clipTakes ?? []).find(
    (candidate): candidate is MidiClipTake =>
      candidate.mediaType === 'midi' &&
      candidate.artifactId === artifact.artifactId &&
      doesMidiTakeMatchSource(candidate, sourceIdentity),
  );
  const matchingTakeCount = countArtifactOrSourceClipTakes(
    project,
    artifact.artifactId,
    sourceIdentity,
  );

  if (
    existingArtifact?.kind === 'midi' &&
    JSON.stringify(existingArtifact) === JSON.stringify(artifact) &&
    existingTake &&
    existingTake.clipTakeId === createClipTakeId(artifact.artifactId) &&
    matchingTakeCount === 1
  ) {
    return {
      artifact: existingArtifact,
      canRegister: true,
      clipTake: existingTake,
      project,
      status: 'ALREADY_REGISTERED',
    };
  }

  if (existingArtifact || matchingTakeCount > 0) {
    return {
      canRegister: false,
      message: `${formatMidiSourceLabel(sourceIdentity)} or Artifact ${artifact.artifactId} is already registered elsewhere.`,
      reason: 'artifact-conflict',
    };
  }

  const clipTake = createMidiClipTake(
    artifact,
    normalizeMidiTakeLabel(options.label, target.clip),
  );
  const nextClip: Clip = {
    ...target.clip,
    activeClipTakeId:
      options.activate === false && target.clip.activeClipTakeId
        ? target.clip.activeClipTakeId
        : clipTake.clipTakeId,
    clipTakes: [...(target.clip.clipTakes ?? []), clipTake],
    version: target.clip.version + 1,
  };
  const nextProject: ProjectState = {
    ...project,
    artifacts: [...artifacts, artifact],
    tracks: project.tracks.map((track, trackIndex) =>
      trackIndex === target.trackIndex
        ? {
            ...track,
            clips: track.clips.map((clip, clipIndex) =>
              clipIndex === target.clipIndex ? nextClip : clip,
            ),
          }
        : track,
    ),
  };

  return {
    artifact,
    canRegister: true,
    clipTake,
    project: nextProject,
    status: 'REGISTERED',
  };
}

export function normalizeProjectArtifacts(value: unknown): ProjectArtifact[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const artifacts: ProjectArtifact[] = [];
  const artifactIds = new Set<string>();
  const sourceJobIds = new Set<string>();
  const sourceEditIds = new Set<string>();
  const sourceManualIds = new Set<string>();
  const sourceOperationIds = new Set<string>();

  for (const candidate of value) {
    const artifact = parseProjectArtifact(candidate);
    const sourceJobId = getProjectArtifactSourceJobId(artifact);
    const sourceEditId =
      artifact?.kind === 'midi' && 'sourceEditId' in artifact
        ? artifact.sourceEditId
        : undefined;
    const sourceManualId =
      artifact?.kind === 'midi' && 'sourceManualId' in artifact
        ? artifact.sourceManualId
        : undefined;
    const sourceOperationId =
      artifact && 'sourceOperationId' in artifact
        ? artifact.sourceOperationId
        : undefined;

    if (
      !artifact ||
      artifactIds.has(artifact.artifactId) ||
      (sourceJobId !== undefined && sourceJobIds.has(sourceJobId)) ||
      (sourceEditId !== undefined && sourceEditIds.has(sourceEditId)) ||
      (sourceManualId !== undefined && sourceManualIds.has(sourceManualId)) ||
      (sourceOperationId !== undefined &&
        sourceOperationIds.has(sourceOperationId))
    ) {
      continue;
    }

    artifacts.push(artifact);
    artifactIds.add(artifact.artifactId);

    if (sourceJobId !== undefined) {
      sourceJobIds.add(sourceJobId);
    }
    if (sourceEditId !== undefined) {
      sourceEditIds.add(sourceEditId);
    }
    if (sourceManualId !== undefined) {
      sourceManualIds.add(sourceManualId);
    }
    if (sourceOperationId !== undefined) {
      sourceOperationIds.add(sourceOperationId);
    }
  }

  return artifacts;
}

export function normalizeClipTakeState(
  clipTakesValue: unknown,
  activeClipTakeIdValue: unknown,
): Partial<Pick<Clip, 'activeClipTakeId' | 'clipTakes'>> {
  if (!Array.isArray(clipTakesValue)) {
    return {};
  }

  const clipTakes: ClipTake[] = [];
  const clipTakeIds = new Set<string>();
  const artifactIds = new Set<string>();
  const sourceJobIds = new Set<string>();
  const sourceEditIds = new Set<string>();
  const sourceManualIds = new Set<string>();
  const sourceOperationIds = new Set<string>();

  for (const candidate of clipTakesValue) {
    const clipTake = parseClipTake(candidate);
    const sourceJobId =
      clipTake?.sourceType === 'job' ? clipTake.sourceJobId : undefined;
    const sourceEditId =
      clipTake?.sourceType === 'edit' ? clipTake.sourceEditId : undefined;
    const sourceManualId =
      clipTake?.sourceType === 'manual'
        ? clipTake.sourceManualId
        : undefined;
    const sourceOperationId =
      clipTake?.sourceType === 'mixdown' ||
      clipTake?.sourceType === 'stem-print' ||
      clipTake?.sourceType === 'print-mix'
        ? clipTake.sourceOperationId
        : undefined;

    if (
      !clipTake ||
      clipTakeIds.has(clipTake.clipTakeId) ||
      artifactIds.has(clipTake.artifactId) ||
      (sourceJobId !== undefined && sourceJobIds.has(sourceJobId)) ||
      (sourceEditId !== undefined && sourceEditIds.has(sourceEditId)) ||
      (sourceManualId !== undefined && sourceManualIds.has(sourceManualId)) ||
      (sourceOperationId !== undefined &&
        sourceOperationIds.has(sourceOperationId))
    ) {
      continue;
    }

    clipTakes.push(clipTake);
    clipTakeIds.add(clipTake.clipTakeId);
    artifactIds.add(clipTake.artifactId);

    if (sourceJobId !== undefined) {
      sourceJobIds.add(sourceJobId);
    }
    if (sourceEditId !== undefined) {
      sourceEditIds.add(sourceEditId);
    }
    if (sourceManualId !== undefined) {
      sourceManualIds.add(sourceManualId);
    }
    if (sourceOperationId !== undefined) {
      sourceOperationIds.add(sourceOperationId);
    }
  }

  if (clipTakes.length === 0) {
    return {};
  }

  const requestedActiveId =
    typeof activeClipTakeIdValue === 'string' ? activeClipTakeIdValue : '';

  if (requestedActiveId && !clipTakeIds.has(requestedActiveId)) {
    return { clipTakes };
  }

  const activeClipTakeId =
    requestedActiveId || clipTakes[clipTakes.length - 1]?.clipTakeId;

  return {
    activeClipTakeId,
    clipTakes,
  };
}

function parseCompletedAudioArtifact(
  job: LocalEngineGpuJobRecord,
): GeneratedAudioArtifact | undefined {
  if (!isRecord(job.result)) {
    return undefined;
  }

  const artifactValue = job.result.artifact;
  const generationValue = job.result.generation;

  if (!isRecord(artifactValue) || !isRecord(generationValue)) {
    return undefined;
  }

  const artifact = parseAudioArtifact({
    ...artifactValue,
    audio: {
      channels: generationValue.channels,
      durationSeconds: generationValue.durationSeconds,
      mimeType: generationValue.mimeType,
    },
    sourceJobId: job.jobId,
  });

  if (
    !artifact ||
    !('sourceJobId' in artifact) ||
    !doesGeneratedArtifactFileMatchIdentity(artifact) ||
    artifact.provenance.modelId !== job.modelId ||
    artifact.provenance.modelRevision !== job.modelRevision ||
    artifact.provenance.providerId !== job.providerId ||
    artifact.provenance.taskId !== job.taskId ||
    artifact.file.sizeBytes !== generationValue.bytesWritten ||
    !isTimestamp(generationValue.providerCompletedAt) ||
    !doesArtifactMatchJobRequest(artifact, job)
  ) {
    return undefined;
  }

  return artifact;
}

function doesGeneratedArtifactFileMatchIdentity(
  artifact: GeneratedAudioArtifact,
): boolean {
  const expectedName = `${artifact.artifactId}.wav`;

  return (
    artifact.file.extension === '.wav' &&
    artifact.file.name === expectedName &&
    artifact.file.relativePath ===
      `${generatedArtifactDirectories[artifact.destination]}/${expectedName}`
  );
}

function parseProjectArtifact(value: unknown): ProjectArtifact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value.kind === 'midi'
    ? parseMidiArtifact(value)
    : parseAudioArtifact(value);
}

function parseMidiArtifact(value: unknown): MidiArtifact | undefined {
  if (
    !isRecord(value) ||
    !isId(value.artifactId) ||
    !isTimestamp(value.createdAt) ||
    value.kind !== 'midi' ||
    !isRecord(value.lineage) ||
    !isRecord(value.midi)
  ) {
    return undefined;
  }

  const lineage = parseArtifactLineage(value.lineage);

  if (
    !lineage ||
    !isFiniteNumberInRange(
      value.midi.bpm,
      RECORDING_BPM_MIN,
      RECORDING_BPM_MAX,
    ) ||
    value.midi.ticksPerQuarter !== TICKS_PER_QUARTER
  ) {
    return undefined;
  }

  let notes: MidiArtifact['midi']['notes'];

  try {
    notes = normalizeMidiNotes(value.midi.notes);
  } catch {
    return undefined;
  }

  const baseArtifact = {
    artifactId: value.artifactId,
    createdAt: value.createdAt,
    kind: 'midi' as const,
    lineage,
    midi: {
      bpm: value.midi.bpm,
      notes,
      ticksPerQuarter: TICKS_PER_QUARTER,
    },
  };

  if (value.sourceOperationId !== undefined) {
    const artifact = parsePrintMixArtifact(value);
    return artifact?.kind === 'midi' ? artifact : undefined;
  }

  if (
    lineage.parentArtifactIds.length === 1 &&
    lineage.parentClipTakeIds.length === 1 &&
    isId(value.sourceJobId) &&
    value.sourceEditId === undefined &&
    value.sourceManualId === undefined &&
    value.editProvenance === undefined &&
    value.manualProvenance === undefined &&
    isRecord(value.provenance)
  ) {
    const provenance = parseArtifactProvenance(value.provenance);

    return provenance?.taskId === HUM_TO_MIDI_TASK_ID
      ? {
          ...baseArtifact,
          provenance,
          sourceJobId: value.sourceJobId,
        }
      : undefined;
  }

  if (
    lineage.parentArtifactIds.length === 1 &&
    lineage.parentClipTakeIds.length === 1 &&
    isId(value.sourceEditId) &&
    value.sourceJobId === undefined &&
    value.sourceManualId === undefined &&
    value.provenance === undefined &&
    value.manualProvenance === undefined &&
    isRecord(value.editProvenance)
  ) {
    const editProvenance = parseMidiEditProvenance(value.editProvenance);
    const contentHash = createMidiContentHash(baseArtifact.midi);
    const revision =
      Number.isSafeInteger(value.revision) && (value.revision as number) >= 1
        ? (value.revision as number)
        : 1;
    const updatedAt = isTimestamp(value.updatedAt)
      ? (value.updatedAt as string)
      : value.createdAt;

    return editProvenance
      ? {
          ...baseArtifact,
          contentHash,
          editProvenance,
          revision,
          sourceEditId: value.sourceEditId,
          updatedAt,
        }
      : undefined;
  }

  if (
    lineage.parentArtifactIds.length === 0 &&
    lineage.parentClipTakeIds.length === 0 &&
    isId(value.sourceManualId) &&
    value.sourceJobId === undefined &&
    value.sourceEditId === undefined &&
    value.provenance === undefined &&
    value.editProvenance === undefined &&
    isRecord(value.manualProvenance)
  ) {
    const manualProvenance = parseManualMidiProvenance(
      value.manualProvenance,
    );
    const contentHash = createMidiContentHash(baseArtifact.midi);
    const revision =
      Number.isSafeInteger(value.revision) && (value.revision as number) >= 1
        ? (value.revision as number)
        : 1;
    const updatedAt = isTimestamp(value.updatedAt)
      ? (value.updatedAt as string)
      : value.createdAt;

    return manualProvenance
      ? {
          ...baseArtifact,
          contentHash,
          manualProvenance,
          revision,
          sourceManualId: value.sourceManualId,
          updatedAt,
        }
      : undefined;
  }

  return undefined;
}

function parseAudioArtifact(value: unknown): AudioArtifact | undefined {
  if (
    !isRecord(value) ||
    !isId(value.artifactId) ||
    !isRecord(value.audio) ||
    !isTimestamp(value.createdAt) ||
    typeof value.destination !== 'string' ||
    !isRecord(value.file) ||
    value.kind !== 'audio' ||
    !isRecord(value.lineage)
  ) {
    return undefined;
  }

  if (value.destination === 'recording') {
    return isRecord(value.capture) && value.capture.source === 'punch'
      ? parsePunchAudioArtifact(value)
      : parseRecordingAudioArtifact(value);
  }

  if (value.destination === 'stem-print') {
    return parseProjectStemPrintAudioArtifact(value);
  }

  if (value.destination === 'print-mix') {
    const artifact = parsePrintMixArtifact(value);
    return artifact?.kind === 'audio' ? artifact : undefined;
  }

  if (
    value.sourceOperationId !== undefined ||
    value.mixdownProvenance !== undefined
  ) {
    return parseProjectMixdownAudioArtifact(value);
  }

  if (
    !generatedArtifactDestinations.has(
      value.destination as GeneratedAudioArtifact['destination'],
    ) ||
    !isRecord(value.provenance) ||
    !isId(value.sourceJobId)
  ) {
    return undefined;
  }

  const audio = parseAudioMetadata(value.audio);
  const file = parseArtifactFile(value.file);
  const lineage = parseArtifactLineage(value.lineage);
  const provenance = parseArtifactProvenance(value.provenance);

  if (!audio || !file || !lineage || !provenance) {
    return undefined;
  }

  return {
    artifactId: value.artifactId,
    audio,
    createdAt: value.createdAt,
    destination: value.destination as GeneratedAudioArtifact['destination'],
    file,
    kind: 'audio',
    lineage,
    provenance,
    sourceJobId: value.sourceJobId,
  };
}

function parseProjectMixdownAudioArtifact(
  value: Record<string, unknown>,
): ProjectMixdownAudioArtifact | undefined {
  if (
    !hasExactKeys(value, [
      'artifactId',
      'audio',
      'createdAt',
      'destination',
      'file',
      'kind',
      'lineage',
      'mixdownProvenance',
      'sourceOperationId',
    ]) ||
    value.destination !== 'mixdown' ||
    !isProjectMixdownOperationId(value.sourceOperationId) ||
    !isRecord(value.audio) ||
    !hasExactKeys(value.audio, [
      'bitsPerSample',
      'channels',
      'durationSeconds',
      'frameCount',
      'mimeType',
      'sampleRate',
    ]) ||
    value.audio.bitsPerSample !== RAW_MIXDOWN_BITS_PER_SAMPLE ||
    value.audio.channels !== RAW_MIXDOWN_CHANNELS ||
    !Number.isSafeInteger(value.audio.frameCount) ||
    (value.audio.frameCount as number) <= 0 ||
    value.audio.durationSeconds !==
      (value.audio.frameCount as number) / RAW_MIXDOWN_SAMPLE_RATE ||
    value.audio.mimeType !== RAW_MIXDOWN_MIME_TYPE ||
    value.audio.sampleRate !== RAW_MIXDOWN_SAMPLE_RATE ||
    !isRecord(value.file) ||
    !hasExactKeys(value.file, [
      'extension',
      'name',
      'relativePath',
      'sizeBytes',
    ]) ||
    !isRecord(value.lineage) ||
    !hasExactKeys(value.lineage, [
      'parentArtifactIds',
      'parentClipTakeIds',
    ]) ||
    !isRecord(value.mixdownProvenance) ||
    !isSupportedMixdownProvenanceIdentity(value.mixdownProvenance)
  ) {
    return undefined;
  }

  const audio = parseAudioMetadata(value.audio);
  const file = parseArtifactFile(value.file);
  const lineage = parseArtifactLineage(value.lineage);
  const inputClipIds = parseUniqueTrimmedTexts(
    value.mixdownProvenance.inputClipIds,
  );
  const inputSourceIds = parseUniqueTrimmedTexts(
    value.mixdownProvenance.inputSourceIds,
  );
  const inputTrackIds = parseUniqueTrimmedTexts(
    value.mixdownProvenance.inputTrackIds,
  );
  const frameCount = value.audio.frameCount as number;
  const planVersion = value.mixdownProvenance.planVersion as 1 | 2 | 3;
  const canonicalPlanJson = parseCanonicalProjectMixdownPlanJson(
    value.mixdownProvenance.canonicalPlanJson,
  );

  if (
    !audio ||
    !file ||
    !lineage ||
    !canonicalPlanJson ||
    !inputClipIds?.length ||
    !inputSourceIds?.length ||
    !inputTrackIds?.length ||
    !doesCanonicalMixdownPlanMatch(
      canonicalPlanJson,
      planVersion,
      frameCount,
      inputClipIds,
      inputSourceIds,
      inputTrackIds,
    ) ||
    file.extension !== '.wav' ||
    file.name !== `${value.artifactId}.wav` ||
    file.relativePath !== `mixdowns/${file.name}` ||
    file.sizeBytes !== 44 + frameCount * 4
  ) {
    return undefined;
  }

  const provenanceBase = {
    canonicalPlanJson,
    inputClipIds,
    inputSourceIds,
    inputTrackIds,
    rendererId: value.mixdownProvenance.rendererId as string,
    rendererVersion: value.mixdownProvenance.rendererVersion as string,
  };
  const mixdownProvenance: ProjectMixdownAudioArtifact['mixdownProvenance'] =
    planVersion === RAW_MIXDOWN_PLAN_VERSION
      ? {
          ...provenanceBase,
          operationProtocolVersion: PROJECT_MIXDOWN_API_PROTOCOL_VERSION,
          planVersion: RAW_MIXDOWN_PLAN_VERSION,
          schemaVersion: 2,
        }
      : {
          ...provenanceBase,
          operationProtocolVersion: PROJECT_MIXDOWN_API_PROTOCOL_VERSION_V1,
          planVersion,
        };

  return {
    artifactId: value.artifactId as string,
    audio: {
      ...audio,
      bitsPerSample: RAW_MIXDOWN_BITS_PER_SAMPLE,
      channels: RAW_MIXDOWN_CHANNELS,
      frameCount,
      mimeType: RAW_MIXDOWN_MIME_TYPE,
      sampleRate: RAW_MIXDOWN_SAMPLE_RATE,
    },
    createdAt: value.createdAt as string,
    destination: 'mixdown',
    file,
    kind: 'audio',
    lineage,
    mixdownProvenance,
    sourceOperationId: value.sourceOperationId,
  };
}

function parseProjectStemPrintAudioArtifact(
  value: Record<string, unknown>,
): ProjectStemPrintAudioArtifact | undefined {
  if (
    !hasExactKeys(value, [
      'artifactId',
      'audio',
      'createdAt',
      'destination',
      'file',
      'kind',
      'lineage',
      'sourceOperationId',
      'stemPrintProvenance',
    ]) ||
    value.destination !== 'stem-print' ||
    !isProjectStemPrintOperationId(value.sourceOperationId) ||
    value.artifactId !== createProjectStemPrintArtifactId(value.sourceOperationId) ||
    !isRecord(value.audio) ||
    !hasExactKeys(value.audio, [
      'bitsPerSample',
      'channels',
      'durationSeconds',
      'frameCount',
      'mimeType',
      'sampleRate',
    ]) ||
    value.audio.bitsPerSample !== RAW_MIXDOWN_BITS_PER_SAMPLE ||
    value.audio.channels !== RAW_MIXDOWN_CHANNELS ||
    !Number.isSafeInteger(value.audio.frameCount) ||
    (value.audio.frameCount as number) <= 0 ||
    value.audio.durationSeconds !==
      (value.audio.frameCount as number) / RAW_MIXDOWN_SAMPLE_RATE ||
    value.audio.mimeType !== RAW_MIXDOWN_MIME_TYPE ||
    value.audio.sampleRate !== RAW_MIXDOWN_SAMPLE_RATE ||
    !isRecord(value.file) ||
    !hasExactKeys(value.file, ['extension', 'name', 'relativePath', 'sizeBytes']) ||
    !isRecord(value.lineage) ||
    !hasExactKeys(value.lineage, ['parentArtifactIds', 'parentClipTakeIds']) ||
    !isRecord(value.stemPrintProvenance) ||
    !hasExactKeys(value.stemPrintProvenance, [
      'canonicalPlanJson',
      'inputClipIds',
      'inputSourceIds',
      'inputTrackIds',
      'operationProtocolVersion',
      'planSha256',
      'planVersion',
      'rendererId',
      'rendererVersion',
      'schemaVersion',
      'selectedTargets',
    ]) ||
    value.stemPrintProvenance.operationProtocolVersion !==
      PROJECT_STEM_PRINT_API_PROTOCOL_VERSION ||
    value.stemPrintProvenance.planVersion !== PROJECT_STEM_PRINT_PLAN_VERSION ||
    value.stemPrintProvenance.rendererId !== PROJECT_MIXDOWN_RENDERER_ID ||
    value.stemPrintProvenance.rendererVersion !== PROJECT_MIXDOWN_RENDERER_VERSION ||
    value.stemPrintProvenance.schemaVersion !== 1 ||
    typeof value.stemPrintProvenance.planSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.stemPrintProvenance.planSha256)
  ) {
    return undefined;
  }

  const audio = parseAudioMetadata(value.audio);
  const file = parseArtifactFile(value.file);
  const lineage = parseArtifactLineage(value.lineage);
  const inputClipIds = parseUniqueTrimmedTexts(
    value.stemPrintProvenance.inputClipIds,
  );
  const inputSourceIds = parseUniqueTrimmedTexts(
    value.stemPrintProvenance.inputSourceIds,
  );
  const inputTrackIds = parseUniqueTrimmedTexts(
    value.stemPrintProvenance.inputTrackIds,
  );
  const selectedTargets = parseStemPrintTargets(
    value.stemPrintProvenance.selectedTargets,
  );
  const canonicalPlanJson = parseCanonicalProjectStemPrintPlanJson(
    value.stemPrintProvenance.canonicalPlanJson,
  );
  const frameCount = value.audio.frameCount as number;

  if (
    !audio ||
    !file ||
    !lineage ||
    !canonicalPlanJson ||
    !inputClipIds?.length ||
    !inputSourceIds?.length ||
    !inputTrackIds?.length ||
    !selectedTargets?.length ||
    !doesCanonicalStemPrintPlanMatch(
      canonicalPlanJson,
      frameCount,
      inputClipIds,
      inputSourceIds,
      inputTrackIds,
      selectedTargets,
    ) ||
    file.extension !== '.wav' ||
    file.name !== `${value.artifactId}.wav` ||
    file.relativePath !== `stem-prints/${file.name}` ||
    file.sizeBytes !== 44 + frameCount * 4
  ) {
    return undefined;
  }

  return {
    artifactId: value.artifactId as string,
    audio: {
      ...audio,
      bitsPerSample: RAW_MIXDOWN_BITS_PER_SAMPLE,
      channels: RAW_MIXDOWN_CHANNELS,
      frameCount,
      mimeType: RAW_MIXDOWN_MIME_TYPE,
      sampleRate: RAW_MIXDOWN_SAMPLE_RATE,
    },
    createdAt: value.createdAt as string,
    destination: 'stem-print',
    file,
    kind: 'audio',
    lineage,
    sourceOperationId: value.sourceOperationId,
    stemPrintProvenance: {
      canonicalPlanJson,
      inputClipIds,
      inputSourceIds,
      inputTrackIds,
      operationProtocolVersion: PROJECT_STEM_PRINT_API_PROTOCOL_VERSION,
      planSha256: value.stemPrintProvenance.planSha256,
      planVersion: PROJECT_STEM_PRINT_PLAN_VERSION,
      rendererId: PROJECT_MIXDOWN_RENDERER_ID,
      rendererVersion: PROJECT_MIXDOWN_RENDERER_VERSION,
      schemaVersion: 1,
      selectedTargets,
    },
  };
}

function isSupportedMixdownProvenanceIdentity(
  value: Record<string, unknown>,
): boolean {
  const legacyKeys = [
    'canonicalPlanJson',
    'inputClipIds',
    'inputSourceIds',
    'inputTrackIds',
    'operationProtocolVersion',
    'planVersion',
    'rendererId',
    'rendererVersion',
  ];
  const currentKeys = [...legacyKeys, 'schemaVersion'];

  if (
    hasExactKeys(value, legacyKeys) &&
    value.operationProtocolVersion === PROJECT_MIXDOWN_API_PROTOCOL_VERSION_V1 &&
    (value.planVersion === RAW_MIXDOWN_PLAN_VERSION_V1 ||
      value.planVersion === RAW_MIXDOWN_PLAN_VERSION_V2)
  ) {
    return isId(value.rendererId) && isRendererVersion(value.rendererVersion);
  }

  return (
    hasExactKeys(value, currentKeys) &&
    value.schemaVersion === 2 &&
    value.operationProtocolVersion === PROJECT_MIXDOWN_API_PROTOCOL_VERSION &&
    value.planVersion === RAW_MIXDOWN_PLAN_VERSION &&
    value.rendererId === PROJECT_MIXDOWN_RENDERER_ID &&
    value.rendererVersion === PROJECT_MIXDOWN_RENDERER_VERSION
  );
}

function parseRecordingAudioArtifact(
  value: Record<string, unknown>,
): RecordingAudioArtifact | undefined {
  if (
    !isRecord(value.audio) ||
    !isRecord(value.capture) ||
    value.capture.source !== 'microphone' ||
    (value.capture.inputDeviceId !== undefined &&
      !isOptionalCaptureText(value.capture.inputDeviceId, 512)) ||
    (value.capture.inputDeviceLabel !== undefined &&
      !isOptionalCaptureText(value.capture.inputDeviceLabel, 256)) ||
    value.audio.bitsPerSample !== 16 ||
    value.audio.channels !== 1 ||
    value.audio.mimeType !== 'audio/wav' ||
    !Number.isSafeInteger(value.audio.sampleRate) ||
    (value.audio.sampleRate as number) < 8_000 ||
    (value.audio.sampleRate as number) > 192_000 ||
    value.provenance !== undefined ||
    value.sourceJobId !== undefined
  ) {
    return undefined;
  }

  const audio = parseAudioMetadata(value.audio);
  const file = isRecord(value.file) ? parseArtifactFile(value.file) : undefined;
  const lineage = isRecord(value.lineage)
    ? parseArtifactLineage(value.lineage)
    : undefined;

  if (
    !audio ||
    !file ||
    !lineage ||
    file.extension !== '.wav' ||
    file.name !== `${value.artifactId}.wav` ||
    file.relativePath !== `recordings/${file.name}`
  ) {
    return undefined;
  }

  return {
    artifactId: value.artifactId as string,
    audio: {
      ...audio,
      bitsPerSample: 16,
      channels: 1,
      mimeType: 'audio/wav',
      sampleRate: value.audio.sampleRate as number,
    },
    capture: {
      ...(value.capture.inputDeviceId !== undefined
        ? { inputDeviceId: value.capture.inputDeviceId as string }
        : {}),
      ...(value.capture.inputDeviceLabel !== undefined
        ? { inputDeviceLabel: value.capture.inputDeviceLabel as string }
        : {}),
      source: 'microphone',
    },
    createdAt: value.createdAt as string,
    destination: 'recording',
    file,
    kind: 'audio',
    lineage,
  };
}

function parsePunchAudioArtifact(
  value: Record<string, unknown>,
): PunchAudioArtifact | undefined {
  if (
    !isRecord(value.audio) ||
    !isRecord(value.capture) ||
    value.capture.source !== 'punch' ||
    (value.capture.inputDeviceId !== undefined &&
      !isOptionalCaptureText(value.capture.inputDeviceId, 512)) ||
    (value.capture.inputDeviceLabel !== undefined &&
      !isOptionalCaptureText(value.capture.inputDeviceLabel, 256)) ||
    value.audio.bitsPerSample !== 16 ||
    (value.audio.channels !== 1 && value.audio.channels !== 2) ||
    value.audio.mimeType !== 'audio/wav' ||
    !Number.isSafeInteger(value.audio.sampleRate) ||
    (value.audio.sampleRate as number) < 8_000 ||
    (value.audio.sampleRate as number) > 192_000 ||
    !isRecord(value.punch) ||
    !hasExactKeys(value.punch, [
      'baseArtifactId',
      'baseClipTakeId',
      'clipId',
      'punchInTick',
      'punchOutTick',
      'rendererId',
      'rendererVersion',
      'schemaVersion',
    ]) ||
    !isId(value.punch.baseArtifactId) ||
    !isId(value.punch.baseClipTakeId) ||
    !isId(value.punch.clipId) ||
    !Number.isSafeInteger(value.punch.punchInTick) ||
    !Number.isSafeInteger(value.punch.punchOutTick) ||
    (value.punch.punchInTick as number) < 0 ||
    (value.punch.punchOutTick as number) <=
      (value.punch.punchInTick as number) ||
    value.punch.rendererId !== 'humstudio.pipo.pcm16' ||
    value.punch.rendererVersion !== '1.0.0' ||
    value.punch.schemaVersion !== 1 ||
    value.provenance !== undefined ||
    value.sourceJobId !== undefined
  ) {
    return undefined;
  }

  const audio = parseAudioMetadata(value.audio);
  const file = isRecord(value.file) ? parseArtifactFile(value.file) : undefined;
  const lineage = isRecord(value.lineage)
    ? parseArtifactLineage(value.lineage)
    : undefined;

  if (
    !audio ||
    !file ||
    !lineage ||
    lineage.parentArtifactIds.length !== 1 ||
    lineage.parentArtifactIds[0] !== value.punch.baseArtifactId ||
    lineage.parentClipTakeIds.length !== 1 ||
    lineage.parentClipTakeIds[0] !== value.punch.baseClipTakeId ||
    file.extension !== '.wav' ||
    file.name !== `${value.artifactId}.wav` ||
    file.relativePath !== `recordings/${file.name}`
  ) {
    return undefined;
  }

  return {
    artifactId: value.artifactId as string,
    audio: {
      ...audio,
      bitsPerSample: 16,
      channels: value.audio.channels as 1 | 2,
      mimeType: 'audio/wav',
      sampleRate: value.audio.sampleRate as number,
    },
    capture: {
      ...(value.capture.inputDeviceId !== undefined
        ? { inputDeviceId: value.capture.inputDeviceId as string }
        : {}),
      ...(value.capture.inputDeviceLabel !== undefined
        ? { inputDeviceLabel: value.capture.inputDeviceLabel as string }
        : {}),
      source: 'punch',
    },
    createdAt: value.createdAt as string,
    destination: 'recording',
    file,
    kind: 'audio',
    lineage,
    punch: {
      baseArtifactId: value.punch.baseArtifactId as string,
      baseClipTakeId: value.punch.baseClipTakeId as string,
      clipId: value.punch.clipId as string,
      punchInTick: value.punch.punchInTick as number,
      punchOutTick: value.punch.punchOutTick as number,
      rendererId: 'humstudio.pipo.pcm16',
      rendererVersion: '1.0.0',
      schemaVersion: 1,
    },
  };
}

function parseAudioMetadata(
  value: Record<string, unknown>,
): AudioArtifactMetadata | undefined {
  if (
    !Number.isSafeInteger(value.channels) ||
    (value.channels as number) < 1 ||
    !isFinitePositiveNumber(value.durationSeconds) ||
    typeof value.mimeType !== 'string' ||
    !value.mimeType.startsWith('audio/')
  ) {
    return undefined;
  }

  return {
    channels: value.channels as number,
    durationSeconds: value.durationSeconds,
    mimeType: value.mimeType,
  };
}

function parseArtifactFile(value: Record<string, unknown>): AudioArtifact['file'] | undefined {
  if (
    typeof value.extension !== 'string' ||
    !ARTIFACT_EXTENSION_PATTERN.test(value.extension) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    value.name.includes('/') ||
    value.name.includes('\\') ||
    !value.name.endsWith(value.extension) ||
    typeof value.relativePath !== 'string' ||
    !isSafeRelativePath(value.relativePath) ||
    !value.relativePath.endsWith(`/${value.name}`) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) <= 0
  ) {
    return undefined;
  }

  return {
    extension: value.extension,
    name: value.name,
    relativePath: value.relativePath,
    sizeBytes: value.sizeBytes as number,
  };
}

function parseArtifactLineage(value: Record<string, unknown>): ArtifactLineage | undefined {
  const parentArtifactIds = parseUniqueIds(value.parentArtifactIds);
  const parentClipTakeIds = parseUniqueIds(value.parentClipTakeIds);

  return parentArtifactIds && parentClipTakeIds
    ? { parentArtifactIds, parentClipTakeIds }
    : undefined;
}

function parseArtifactProvenance(
  value: Record<string, unknown>,
): ArtifactProvenance | undefined {
  if (
    !isId(value.modelId) ||
    typeof value.modelRevision !== 'string' ||
    value.modelRevision.length === 0 ||
    !isRecord(value.parameters) ||
    !isId(value.providerId) ||
    !isId(value.taskId) ||
    (value.seed !== undefined && !Number.isSafeInteger(value.seed))
  ) {
    return undefined;
  }

  const parameters = cloneJsonObject(value.parameters);

  if (!parameters) {
    return undefined;
  }

  return {
    modelId: value.modelId,
    modelRevision: value.modelRevision,
    parameters,
    providerId: value.providerId,
    ...(value.seed !== undefined ? { seed: value.seed as number } : {}),
    taskId: value.taskId,
  };
}

function parseMidiEditProvenance(
  value: Record<string, unknown>,
): EditedMidiArtifact['editProvenance'] | undefined {
  if (
    !isId(value.editorId) ||
    typeof value.editorVersion !== 'string' ||
    value.editorVersion.length === 0 ||
    value.editorVersion.length > 128 ||
    value.editorVersion.trim() !== value.editorVersion ||
    value.taskId !== MIDI_EDIT_TASK_ID
  ) {
    return undefined;
  }

  return {
    editorId: value.editorId,
    editorVersion: value.editorVersion,
    taskId: MIDI_EDIT_TASK_ID,
  };
}

function parseManualMidiProvenance(
  value: Record<string, unknown>,
): ManualMidiArtifact['manualProvenance'] | undefined {
  if (
    !isId(value.editorId) ||
    typeof value.editorVersion !== 'string' ||
    value.editorVersion.length === 0 ||
    value.editorVersion.length > 128 ||
    value.editorVersion.trim() !== value.editorVersion ||
    value.taskId !== MANUAL_MIDI_TASK_ID
  ) {
    return undefined;
  }

  return {
    editorId: value.editorId,
    editorVersion: value.editorVersion,
    taskId: MANUAL_MIDI_TASK_ID,
  };
}

function parseClipTake(value: unknown): ClipTake | undefined {
  if (
    !isRecord(value) ||
    !isId(value.artifactId) ||
    !isId(value.clipTakeId) ||
    !isTimestamp(value.createdAt) ||
    typeof value.label !== 'string' ||
    value.label.length === 0 ||
    value.label.length > 128 ||
    value.label.trim() !== value.label
  ) {
    return undefined;
  }

  if (value.sourceType === 'print-mix') {
    return parsePrintMixClipTake(value);
  }

  if (value.mediaType === 'midi') {
    if (
      value.sourceType === 'job' &&
      isId(value.sourceJobId) &&
      value.sourceEditId === undefined &&
      value.sourceManualId === undefined
    ) {
      return {
        artifactId: value.artifactId,
        clipTakeId: value.clipTakeId,
        createdAt: value.createdAt,
        label: value.label,
        mediaType: 'midi',
        sourceJobId: value.sourceJobId,
        sourceType: 'job',
      };
    }

    if (
      value.sourceType === 'edit' &&
      isId(value.sourceEditId) &&
      value.sourceJobId === undefined &&
      value.sourceManualId === undefined
    ) {
      const editState =
        typeof value.contentHash === 'string' &&
        Number.isSafeInteger(value.revision) &&
        (value.revision as number) >= 1 &&
        isTimestamp(value.updatedAt)
          ? {
              contentHash: value.contentHash,
              revision: value.revision as number,
              updatedAt: value.updatedAt as string,
            }
          : {};
      return {
        artifactId: value.artifactId,
        clipTakeId: value.clipTakeId,
        createdAt: value.createdAt,
        ...editState,
        label: value.label,
        mediaType: 'midi',
        sourceEditId: value.sourceEditId,
        sourceType: 'edit',
      };
    }

    if (
      value.sourceType === 'manual' &&
      isId(value.sourceManualId) &&
      value.sourceJobId === undefined &&
      value.sourceEditId === undefined &&
      typeof value.contentHash === 'string' &&
      Number.isSafeInteger(value.revision) &&
      (value.revision as number) >= 1 &&
      isTimestamp(value.updatedAt)
    ) {
      return {
        artifactId: value.artifactId,
        clipTakeId: value.clipTakeId,
        contentHash: value.contentHash,
        createdAt: value.createdAt,
        label: value.label,
        mediaType: 'midi',
        revision: value.revision as number,
        sourceManualId: value.sourceManualId,
        sourceType: 'manual',
        updatedAt: value.updatedAt,
      };
    }

    return undefined;
  }

  if (value.mediaType !== 'audio') {
    return undefined;
  }

  if (value.sourceType === 'recording') {
    if (
      value.sourceJobId !== undefined ||
      value.sourceOperationId !== undefined
    ) {
      return undefined;
    }

    const recordingTake: RecordingAudioClipTake = {
      artifactId: value.artifactId,
      clipTakeId: value.clipTakeId,
      createdAt: value.createdAt,
      label: value.label,
      mediaType: 'audio',
      sourceType: 'recording',
    };
    return recordingTake;
  }

  if (value.sourceType === 'mixdown') {
    if (
      !isProjectMixdownOperationId(value.sourceOperationId) ||
      value.sourceJobId !== undefined
    ) {
      return undefined;
    }

    const mixdownTake: ProjectMixdownAudioClipTake = {
      artifactId: value.artifactId,
      clipTakeId: value.clipTakeId,
      createdAt: value.createdAt,
      label: value.label,
      mediaType: 'audio',
      sourceOperationId: value.sourceOperationId,
      sourceType: 'mixdown',
    };
    return mixdownTake;
  }

  if (value.sourceType === 'stem-print') {
    if (
      !isProjectStemPrintOperationId(value.sourceOperationId) ||
      value.sourceJobId !== undefined
    ) {
      return undefined;
    }

    const stemPrintTake: ProjectStemPrintAudioClipTake = {
      artifactId: value.artifactId,
      clipTakeId: value.clipTakeId,
      createdAt: value.createdAt,
      label: value.label,
      mediaType: 'audio',
      sourceOperationId: value.sourceOperationId,
      sourceType: 'stem-print',
    };
    return stemPrintTake;
  }

  if (
    (value.sourceType !== undefined && value.sourceType !== 'job') ||
    !isId(value.sourceJobId) ||
    value.sourceOperationId !== undefined
  ) {
    return undefined;
  }

  return {
    artifactId: value.artifactId,
    clipTakeId: value.clipTakeId,
    createdAt: value.createdAt,
    label: value.label,
    mediaType: 'audio',
    sourceType: 'job',
    sourceJobId: value.sourceJobId,
  };
}

function createClipTake(
  artifact: AudioArtifact,
  sourceJobId: string,
  label: string,
): GeneratedAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: createClipTakeId(artifact.artifactId),
    createdAt: artifact.createdAt,
    label,
    mediaType: 'audio',
    sourceType: 'job',
    sourceJobId,
  };
}

function createMidiClipTake(
  artifact: MidiArtifact,
  label: string,
): MidiClipTake {
  const baseTake = {
    artifactId: artifact.artifactId,
    clipTakeId: createClipTakeId(artifact.artifactId),
    createdAt: artifact.createdAt,
    label,
    mediaType: 'midi' as const,
  };

  if ('sourceJobId' in artifact) {
    return {
      ...baseTake,
      sourceJobId: artifact.sourceJobId,
      sourceType: 'job',
    };
  }

  if ('sourceManualId' in artifact) {
    return {
      ...baseTake,
      contentHash: artifact.contentHash,
      revision: artifact.revision,
      sourceManualId: artifact.sourceManualId,
      sourceType: 'manual',
      updatedAt: artifact.updatedAt,
    };
  }

  if ('sourceOperationId' in artifact) {
    return {
      ...baseTake,
      contentHash: artifact.contentHash,
      sourceOperationId: artifact.sourceOperationId,
      sourceType: 'print-mix',
    };
  }

  return {
    ...baseTake,
    contentHash: artifact.contentHash,
    revision: artifact.revision ?? 1,
    sourceEditId: artifact.sourceEditId,
    sourceType: 'edit',
    updatedAt: artifact.updatedAt ?? artifact.createdAt,
  };
}

function createClipTakeId(artifactId: string): string {
  return `clip-take-${artifactId}`;
}

function normalizeTakeLabel(value: string | undefined, clip: Clip): string {
  const requestedLabel = value?.trim();

  if (requestedLabel) {
    return requestedLabel.slice(0, 128);
  }

  const takeNumber = (clip.clipTakes?.length ?? 0) + 1;
  return `Generated Take ${String(takeNumber).padStart(2, '0')}`;
}

function normalizeMidiTakeLabel(value: string | undefined, clip: Clip): string {
  const requestedLabel = value?.trim();

  if (requestedLabel) {
    return requestedLabel.slice(0, 128);
  }

  const takeNumber =
    (clip.clipTakes?.filter((take) => take.mediaType === 'midi').length ?? 0) + 1;
  return `MIDI Take ${String(takeNumber).padStart(2, '0')}`;
}

function hasValidMidiSourceLineage(
  project: ProjectState,
  artifact: MidiArtifact,
  targetClip: Clip,
): boolean {
  if ('sourceJobId' in artifact) {
    return hasValidGeneratedMidiSourceLineage(project, artifact, targetClip);
  }

  if ('sourceManualId' in artifact) {
    return (
      artifact.lineage.parentArtifactIds.length === 0 &&
      artifact.lineage.parentClipTakeIds.length === 0
    );
  }

  if ('sourceOperationId' in artifact) {
    return false;
  }

  return hasValidEditedMidiSourceLineage(project, artifact, targetClip);
}

function hasValidGeneratedMidiSourceLineage(
  project: ProjectState,
  artifact: GeneratedMidiArtifact,
  targetClip: Clip,
): boolean {
  const [parentArtifactId] = artifact.lineage.parentArtifactIds;
  const [parentClipTakeId] = artifact.lineage.parentClipTakeIds;
  const parentArtifact = project.artifacts?.find(
    (candidate) =>
      candidate.artifactId === parentArtifactId && candidate.kind === 'audio',
  );

  if (!parentArtifact) {
    return false;
  }

  const sourceClip = project.tracks
    .flatMap((track) => track.clips)
    .find((clip) =>
      clip.clipTakes?.some(
        (take) =>
          take.clipTakeId === parentClipTakeId &&
          take.artifactId === parentArtifactId &&
          take.mediaType === 'audio',
      ),
    );

  return Boolean(
    sourceClip &&
      (!targetClip.sourceClipId || targetClip.sourceClipId === sourceClip.id),
  );
}

function hasValidEditedMidiSourceLineage(
  project: ProjectState,
  artifact: EditedMidiArtifact,
  targetClip: Clip,
): boolean {
  const [parentArtifactId] = artifact.lineage.parentArtifactIds;
  const [parentClipTakeId] = artifact.lineage.parentClipTakeIds;
  const parentArtifact = project.artifacts?.find(
    (candidate) =>
      candidate.artifactId === parentArtifactId && candidate.kind === 'midi',
  );

  if (!parentArtifact) {
    return false;
  }

  const sourceClip = project.tracks
    .flatMap((track) => track.clips)
    .find((clip) =>
      clip.clipTakes?.some(
        (take) =>
          take.clipTakeId === parentClipTakeId &&
          take.artifactId === parentArtifactId &&
          take.mediaType === 'midi',
      ),
    );

  return Boolean(
    sourceClip &&
      (targetClip.id === sourceClip.id ||
        targetClip.sourceClipId === sourceClip.id),
  );
}

type MidiArtifactSourceIdentity =
  | Readonly<{ sourceId: string; sourceType: 'edit' }>
  | Readonly<{ sourceId: string; sourceType: 'job' }>
  | Readonly<{ sourceId: string; sourceType: 'manual' }>
  | Readonly<{ sourceId: string; sourceType: 'print-mix' }>;

function getMidiArtifactSourceIdentity(
  artifact: MidiArtifact,
): MidiArtifactSourceIdentity {
  if ('sourceJobId' in artifact) {
    return { sourceId: artifact.sourceJobId, sourceType: 'job' };
  }

  if ('sourceOperationId' in artifact) {
    return {
      sourceId: artifact.sourceOperationId,
      sourceType: 'print-mix',
    };
  }

  return 'sourceManualId' in artifact
    ? { sourceId: artifact.sourceManualId, sourceType: 'manual' }
    : { sourceId: artifact.sourceEditId, sourceType: 'edit' };
}

function doesMidiTakeMatchSource(
  take: MidiClipTake,
  source: MidiArtifactSourceIdentity,
): boolean {
  if (source.sourceType === 'job') {
    return take.sourceType === 'job' && take.sourceJobId === source.sourceId;
  }

  if (source.sourceType === 'print-mix') {
    return (
      take.sourceType === 'print-mix' &&
      take.sourceOperationId === source.sourceId
    );
  }

  return source.sourceType === 'manual'
    ? take.sourceType === 'manual' &&
        take.sourceManualId === source.sourceId
    : take.sourceType === 'edit' && take.sourceEditId === source.sourceId;
}

function formatMidiSourceLabel(source: MidiArtifactSourceIdentity): string {
  const sourceLabel =
    source.sourceType === 'job'
      ? 'Job'
      : source.sourceType === 'manual'
        ? 'Manual MIDI'
        : source.sourceType === 'print-mix'
          ? 'PRINT MIX Operation'
          : 'Edit';
  return `${sourceLabel} ${source.sourceId}`;
}

function countArtifactOrSourceClipTakes(
  project: ProjectState,
  artifactId: string,
  source: MidiArtifactSourceIdentity,
): number {
  return project.tracks.reduce(
    (count, track) =>
      count +
      track.clips.reduce(
          (clipCount, clip) =>
          clipCount +
          (clip.clipTakes ?? []).filter(
            (take) =>
              take.artifactId === artifactId ||
              (take.mediaType === 'midi' &&
                doesMidiTakeMatchSource(take, source)),
          ).length,
        0,
      ),
    0,
  );
}

function getProjectArtifactSourceJobId(
  artifact: ProjectArtifact | undefined,
): string | undefined {
  if (!artifact) {
    return undefined;
  }

  if (artifact.kind === 'audio') {
    return 'sourceJobId' in artifact ? artifact.sourceJobId : undefined;
  }

  return 'sourceJobId' in artifact ? artifact.sourceJobId : undefined;
}

function doesArtifactMatchJobRequest(
  artifact: GeneratedAudioArtifact,
  job: LocalEngineGpuJobRecord,
): boolean {
  const lineage = isRecord(job.request.lineage)
    ? parseArtifactLineage(job.request.lineage)
    : undefined;
  const output = isRecord(job.request.output) ? job.request.output : undefined;
  const parameters = isRecord(job.request.parameters)
    ? cloneJsonObject(job.request.parameters)
    : undefined;

  return Boolean(
    lineage &&
      output &&
      parameters &&
      output.artifactKind === artifact.kind &&
      output.destination === artifact.destination &&
      output.extension === artifact.file.extension &&
      JSON.stringify(lineage) === JSON.stringify(artifact.lineage) &&
      JSON.stringify(parameters) === JSON.stringify(artifact.provenance.parameters) &&
      (parameters.seed === undefined || parameters.seed === artifact.provenance.seed),
  );
}

function isOptionalCaptureText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value
  );
}

function findClip(
  project: ProjectState,
  clipId: string,
): { clip: Clip; clipIndex: number; trackIndex: number } | undefined {
  for (const [trackIndex, track] of project.tracks.entries()) {
    const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);

    if (clipIndex >= 0) {
      return { clip: track.clips[clipIndex], clipIndex, trackIndex };
    }
  }

  return undefined;
}

function parseUniqueIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(isId)) {
    return undefined;
  }

  const ids = [...value];
  return new Set(ids).size === ids.length ? ids : undefined;
}

function parseUniqueTrimmedTexts(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every(
      (candidate) =>
        typeof candidate === 'string' &&
        candidate.length > 0 &&
        candidate.length <= 1_024 &&
        candidate.trim() === candidate,
    )
  ) {
    return undefined;
  }

  const texts = [...value] as string[];
  return new Set(texts).size === texts.length ? texts : undefined;
}

function parseCanonicalProjectMixdownPlanJson(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  try {
    return createCanonicalProjectMixdownPlanJson(JSON.parse(value)) === value
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function parseCanonicalProjectStemPrintPlanJson(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  try {
    return createCanonicalProjectStemPrintPlanJson(
      JSON.parse(value) as ProjectStemPrintPlan,
    ) === value
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function parseStemPrintTargets(
  value: unknown,
): ProjectStemPrintAudioArtifact['stemPrintProvenance']['selectedTargets'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const targets: ProjectStemPrintAudioArtifact['stemPrintProvenance']['selectedTargets'] = [];
  const resolvedTrackIds = new Set<string>();

  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !isId(candidate.resolvedTrackId) ||
      resolvedTrackIds.has(candidate.resolvedTrackId)
    ) {
      return undefined;
    }

    if (
      candidate.kind === 'channel' &&
      hasExactKeys(candidate, ['kind', 'resolvedTrackId', 'trackId']) &&
      isId(candidate.trackId) &&
      candidate.trackId === candidate.resolvedTrackId
    ) {
      targets.push({
        kind: 'channel',
        resolvedTrackId: candidate.resolvedTrackId,
        trackId: candidate.trackId,
      });
    } else if (
      candidate.kind === 'group' &&
      hasExactKeys(candidate, ['groupTrackId', 'kind', 'resolvedTrackId']) &&
      isId(candidate.groupTrackId)
    ) {
      targets.push({
        groupTrackId: candidate.groupTrackId,
        kind: 'group',
        resolvedTrackId: candidate.resolvedTrackId,
      });
    } else {
      return undefined;
    }

    resolvedTrackIds.add(candidate.resolvedTrackId);
  }

  return targets.length > 0 ? targets : undefined;
}

function doesCanonicalStemPrintPlanMatch(
  canonicalPlanJson: string,
  frameCount: number,
  inputClipIds: readonly string[],
  inputSourceIds: readonly string[],
  inputTrackIds: readonly string[],
  selectedTargets: ProjectStemPrintAudioArtifact['stemPrintProvenance']['selectedTargets'],
): boolean {
  let plan: unknown;

  try {
    plan = JSON.parse(canonicalPlanJson);
  } catch {
    return false;
  }

  if (
    !isRecord(plan) ||
    plan.version !== PROJECT_STEM_PRINT_PLAN_VERSION ||
    plan.purpose !== 'stem-print' ||
    plan.startTick !== 0 ||
    !isFinitePositiveNumber(plan.durationSeconds) ||
    Math.round(plan.durationSeconds * RAW_MIXDOWN_SAMPLE_RATE) !== frameCount ||
    !Array.isArray(plan.sources) ||
    !Array.isArray(plan.tracks) ||
    !Array.isArray(plan.selectedTargets)
  ) {
    return false;
  }

  const sourceIds = parseUniqueTrimmedTexts(
    plan.sources.map((source) => isRecord(source) ? source.sourceId : undefined),
  );
  const trackIds = parseUniqueTrimmedTexts(
    plan.tracks.map((track) => isRecord(track) ? track.trackId : undefined),
  );
  const clipIds = parseUniqueTrimmedTexts(
    plan.tracks.flatMap((track) =>
      isRecord(track) && Array.isArray(track.events)
        ? track.events.map((event) => isRecord(event) ? event.clipId : undefined)
        : [undefined],
    ),
  );

  return Boolean(
    sourceIds?.length &&
    trackIds?.length &&
    clipIds?.length &&
    JSON.stringify(sourceIds) === JSON.stringify(inputSourceIds) &&
    JSON.stringify(trackIds) === JSON.stringify(inputTrackIds) &&
    JSON.stringify(clipIds) === JSON.stringify(inputClipIds) &&
    JSON.stringify(plan.selectedTargets) === JSON.stringify(selectedTargets)
  );
}

function doesCanonicalMixdownPlanMatch(
  canonicalPlanJson: string,
  planVersion: 1 | 2 | 3,
  frameCount: number,
  inputClipIds: readonly string[],
  inputSourceIds: readonly string[],
  inputTrackIds: readonly string[],
): boolean {
  let plan: unknown;

  try {
    plan = JSON.parse(canonicalPlanJson);
  } catch {
    return false;
  }

  if (
    !isRecord(plan) ||
    plan.version !== planVersion ||
    plan.purpose !== 'mixdown' ||
    plan.startTick !== 0 ||
    !isFinitePositiveNumber(plan.durationSeconds) ||
    Math.round(plan.durationSeconds * RAW_MIXDOWN_SAMPLE_RATE) !== frameCount ||
    !Array.isArray(plan.sources) ||
    !Array.isArray(plan.tracks) ||
    !doesMixdownPlanDspShapeMatch(plan, planVersion)
  ) {
    return false;
  }

  const sourceIds = parseUniqueTrimmedTexts(
    plan.sources.map((source) =>
      isRecord(source) ? source.sourceId : undefined,
    ),
  );
  const trackIds = parseUniqueTrimmedTexts(
    plan.tracks.map((track) =>
      isRecord(track) ? track.trackId : undefined,
    ),
  );
  const clipIds = parseUniqueTrimmedTexts(
    plan.tracks.flatMap((track) =>
      isRecord(track) && Array.isArray(track.events)
        ? track.events.map((event) =>
            isRecord(event) ? event.clipId : undefined,
          )
        : [undefined],
    ),
  );

  return Boolean(
    sourceIds?.length &&
      trackIds?.length &&
      clipIds?.length &&
      JSON.stringify(sourceIds) === JSON.stringify(inputSourceIds) &&
      JSON.stringify(trackIds) === JSON.stringify(inputTrackIds) &&
      JSON.stringify(clipIds) === JSON.stringify(inputClipIds),
  );
}

function doesMixdownPlanDspShapeMatch(
  plan: Record<string, unknown>,
  planVersion: 1 | 2 | 3,
): boolean {
  const commonKeys = [
    'bpm',
    'durationSeconds',
    'endTick',
    'format',
    'purpose',
    'sources',
    'startTick',
    'tracks',
    'version',
  ];

  if (!Array.isArray(plan.tracks)) {
    return false;
  }

  if (planVersion === RAW_MIXDOWN_PLAN_VERSION_V1) {
    return (
      hasExactKeys(plan, commonKeys) &&
      plan.tracks.every((track) => {
        if (!isRecord(track)) {
          return false;
        }

        const trackKeys =
          track.groupTrackId === undefined
            ? ['events', 'gainDb', 'trackId']
            : ['events', 'gainDb', 'groupTrackId', 'trackId'];
        return hasExactKeys(track, trackKeys) && Number.isFinite(track.gainDb);
      })
    );
  }

  if (planVersion === RAW_MIXDOWN_PLAN_VERSION_V2) {
    return (
      hasExactKeys(plan, [
        ...commonKeys,
        'masterFaderDb',
        'mixerDspVersion',
        'mixerSnapshotVersion',
      ]) &&
      plan.mixerDspVersion === MIXER_DSP_CONTRACT_VERSION_V1 &&
      plan.mixerSnapshotVersion === MIXER_RENDER_SNAPSHOT_VERSION &&
      isRepresentableMixerFader(plan.masterFaderDb) &&
      plan.tracks.every((track) => {
        if (!isRecord(track)) {
          return false;
        }

        const trackKeys =
          track.groupTrackId === undefined
            ? ['events', 'gainDb', 'pan', 'trackId']
            : ['events', 'gainDb', 'groupTrackId', 'pan', 'trackId'];
        return (
          hasExactKeys(track, trackKeys) &&
          isRepresentableMixerFader(track.gainDb) &&
          Number.isFinite(track.pan) &&
          (track.pan as number) >= -1 &&
          (track.pan as number) <= 1
        );
      })
    );
  }

  if (
    !hasExactKeys(plan, [
      ...commonKeys,
      'effectsContractVersion',
      'masterFaderDb',
      'meterTapVersion',
      'mixerDspVersion',
      'mixerSnapshot',
      'mixerSnapshotVersion',
    ]) ||
    plan.effectsContractVersion !== MIXER_EFFECTS_CONTRACT_VERSION ||
    plan.meterTapVersion !== MIXER_METER_TAP_CONTRACT_VERSION ||
    plan.mixerDspVersion !== MIXER_DSP_CONTRACT_VERSION_V2 ||
    plan.mixerSnapshotVersion !== PROJECT_MIXER_RENDER_SNAPSHOT_VERSION_V2 ||
    !isRepresentableMixerFader(plan.masterFaderDb)
  ) {
    return false;
  }

  try {
    assertProjectMixerRenderSnapshotV2(plan.mixerSnapshot);
  } catch {
    return false;
  }

  if (
    plan.mixerSnapshot.master.faderDb !== plan.masterFaderDb ||
    plan.mixerSnapshot.schemaVersion !== plan.mixerSnapshotVersion
  ) {
    return false;
  }

  const channels = new Map(
    plan.mixerSnapshot.channels.map((channel) => [channel.trackId, channel]),
  );

  return (
    hasExactKeys(plan, [
      ...commonKeys,
      'effectsContractVersion',
      'masterFaderDb',
      'meterTapVersion',
      'mixerDspVersion',
      'mixerSnapshot',
      'mixerSnapshotVersion',
    ]) &&
    plan.tracks.every((track) => {
      if (!isRecord(track)) {
        return false;
      }

      const trackKeys =
        track.groupTrackId === undefined
          ? ['events', 'gainDb', 'pan', 'trackId']
          : ['events', 'gainDb', 'groupTrackId', 'pan', 'trackId'];
      return (
        hasExactKeys(track, trackKeys) &&
        isRepresentableMixerFader(track.gainDb) &&
        Number.isFinite(track.pan) &&
        (track.pan as number) >= -1 &&
        (track.pan as number) <= 1 &&
        channels.get(track.trackId as string)?.faderDb === track.gainDb &&
        channels.get(track.trackId as string)?.pan === track.pan
      );
    })
  );
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, ProjectJsonValue> | undefined {
  const cloned = cloneJsonValue(value);
  return isRecord(cloned) ? (cloned as Record<string, ProjectJsonValue>) : undefined;
}

function cloneJsonValue(value: unknown, depth = 0): ProjectJsonValue | undefined {
  if (depth > MAX_JSON_DEPTH) {
    return undefined;
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const entries = value.map((entry) => cloneJsonValue(entry, depth + 1));
    return entries.some((entry) => entry === undefined)
      ? undefined
      : (entries as ProjectJsonValue[]);
  }

  if (isRecord(value)) {
    const entries: [string, ProjectJsonValue][] = [];

    for (const [key, entry] of Object.entries(value)) {
      const cloned = cloneJsonValue(entry, depth + 1);

      if (cloned === undefined) {
        return undefined;
      }

      entries.push([key, cloned]);
    }

    return Object.fromEntries(entries);
  }

  return undefined;
}

function isSafeRelativePath(value: string): boolean {
  const segments = value.split('/');

  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes(':'),
    )
  );
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isRendererVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRepresentableMixerFader(value: unknown): value is number {
  if (typeof value !== 'number') {
    return false;
  }

  try {
    decibelsToMixerGain(value);
    return true;
  } catch {
    return false;
  }
}

function isFiniteNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
