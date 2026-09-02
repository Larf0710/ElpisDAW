import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import type { LocalEngineGeneratedAudioDescriptor } from './localEngineClient';
import type {
  LocalEngineBasicPitchHumToMidiJobRequest,
  LocalEngineGpuJobRecord,
  LocalEngineMockHumToMidiJobRequest,
} from './localEngineJobs';
import { getClipTypeColor } from './clipTypeColors';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import { createMidiArtifactRegistration } from './projectArtifactRegistration';
import type {
  Clip,
  MidiArtifact,
  MidiClipTake,
  PatchTab,
  ProjectArtifact,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
  SelectionItem,
  SoundFontAssignment,
  Track,
} from './types';
import { isHumToMidiPatchTab, TICKS_PER_QUARTER } from './workflow';

export type MockHumToMidiGenerationPlan = Readonly<{
  converterPatchTabId: string;
  request: LocalEngineMockHumToMidiJobRequest;
  source: Readonly<{
    artifactId: string;
    clipId: string;
    clipTakeId: string;
    descriptor: LocalEngineGeneratedAudioDescriptor;
  }>;
}>;

export type BasicPitchHumToMidiGenerationPlan = Readonly<{
  converterPatchTabId: string;
  parameterSnapshot: Readonly<{
    noteRange: 'Bass' | 'Lead' | 'Vocal';
    sensitivity: number;
  }>;
  request: LocalEngineBasicPitchHumToMidiJobRequest;
  source: Readonly<{
    artifactId: string;
    clipId: string;
    clipName: string;
    clipTakeId: string;
    descriptor: LocalEngineGeneratedAudioDescriptor;
  }>;
}>;

export type BasicPitchHumToMidiPlanningResult =
  | Readonly<{
      canPlan: true;
      plan: BasicPitchHumToMidiGenerationPlan;
    }>
  | Readonly<{
      canPlan: false;
      message: string;
      reason:
        | 'converter-invalid'
        | 'parameters-invalid'
        | 'selection-invalid'
        | 'source-invalid';
    }>;

export type BasicPitchHumToMidiParameterResolution =
  | Readonly<{
      canResolve: true;
      parameters: Readonly<{
        frameThreshold: number;
        maximumFrequencyHz: number;
        melodiaTrick: boolean;
        minimumFrequencyHz: number;
        minimumNoteLengthMs: number;
        multiplePitchBends: false;
        onsetThreshold: number;
      }>;
      snapshot: BasicPitchHumToMidiGenerationPlan['parameterSnapshot'];
    }>
  | Readonly<{
      canResolve: false;
      message: string;
    }>;

export type MockHumToMidiGenerationPlanningResult =
  | Readonly<{
      canPlan: true;
      plan: MockHumToMidiGenerationPlan;
    }>
  | Readonly<{
      canPlan: false;
      message: string;
      reason: 'converter-invalid' | 'source-invalid';
    }>;

export type CompletedMockHumToMidiRegistrationResult =
  | Readonly<{
      artifact: MidiArtifact;
      canRegister: true;
      clipTake: MidiClipTake;
      project: ProjectState;
      status: 'ALREADY_REGISTERED' | 'REGISTERED';
      targetClip: Clip;
      targetCreated: boolean;
    }>
  | Readonly<{
      canRegister: false;
      message: string;
      reason:
        | 'job-invalid'
        | 'registration-failed'
        | 'source-stale'
        | 'target-conflict';
    }>;

export type CompletedBasicPitchHumToMidiRegistrationResult =
  CompletedMockHumToMidiRegistrationResult;

type MockHumToMidiGenerationPlanOptions = Readonly<{
  converterPatchTabId: string;
  seed: number;
  sourceClipId: string;
}>;

type CompletedMockHumToMidiRegistrationOptions = Readonly<{
  createdAt: string;
  defaultSoundFontAssignment?: SoundFontAssignment;
  job: LocalEngineGpuJobRecord;
  plan: MockHumToMidiGenerationPlan;
}>;

type BasicPitchHumToMidiGenerationPlanOptions = Readonly<{
  converterPatchTabId: string;
}>;

type CompletedBasicPitchHumToMidiRegistrationOptions = Readonly<{
  createdAt: string;
  defaultSoundFontAssignment?: SoundFontAssignment;
  job: LocalEngineGpuJobRecord;
  plan: BasicPitchHumToMidiGenerationPlan;
}>;

type HumToMidiTargetPlan = Readonly<{
  converterPatchTabId: string;
  source: Readonly<{
    clipId: string;
  }>;
}>;

type HumToMidiRequest =
  | LocalEngineBasicPitchHumToMidiJobRequest
  | LocalEngineMockHumToMidiJobRequest;

type HumToMidiRegistrationPlan = HumToMidiTargetPlan &
  Readonly<{
    request: HumToMidiRequest;
    source: Readonly<{
      clipId: string;
      descriptor: LocalEngineGeneratedAudioDescriptor;
    }>;
  }>;

type MidiTargetResolution =
  | Readonly<{
      canResolve: true;
      project: ProjectState;
      targetClipId: string;
      targetCreated: boolean;
    }>
  | Readonly<{
      canResolve: false;
      message: string;
    }>;

const BASIC_PITCH_PROVIDER_ID = 'local-basic-pitch' as const;
const BASIC_PITCH_MODEL_ID = 'basic-pitch-icassp-2022' as const;
const BASIC_PITCH_MODEL_REVISION = '0.4.0-onnx' as const;
const BASIC_PITCH_TASK_ID = 'hum-to-midi' as const;
const BASIC_PITCH_FRAME_THRESHOLD = 0.3;
const BASIC_PITCH_MINIMUM_NOTE_LENGTH_MS = 127.7;
const BASIC_PITCH_NOTE_RANGES = Object.freeze({
  Bass: Object.freeze({ maximumFrequencyHz: 392, minimumFrequencyHz: 40 }),
  Vocal: Object.freeze({ maximumFrequencyHz: 1_100, minimumFrequencyHz: 80 }),
  Lead: Object.freeze({ maximumFrequencyHz: 2_000, minimumFrequencyHz: 150 }),
} satisfies Record<
  BasicPitchHumToMidiGenerationPlan['parameterSnapshot']['noteRange'],
  Readonly<{ maximumFrequencyHz: number; minimumFrequencyHz: number }>
>);

export function resolveBasicPitchHumToMidiParameters(
  patchTab: PatchTab,
): BasicPitchHumToMidiParameterResolution {
  if (
    patchTab.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi ||
    patchTab.nodeVersion !== '1.0.0' ||
    !isHumToMidiPatchTab(patchTab)
  ) {
    return parameterFailure(
      'Hum to MIDI requires the exact built-in PatchTab contract.',
    );
  }

  if (patchTab.parameters.length !== 2) {
    return parameterFailure(
      'Hum to MIDI requires exactly Pitch Sensitivity and Note Range.',
    );
  }

  const sensitivityMatches = patchTab.parameters.filter(
    (parameter) => parameter.id === 'sensitivity',
  );
  const rangeMatches = patchTab.parameters.filter(
    (parameter) => parameter.id === 'note-range',
  );
  const sensitivity = sensitivityMatches[0];
  const noteRange = rangeMatches[0];

  if (
    sensitivityMatches.length !== 1 ||
    sensitivity?.kind !== 'slider' ||
    sensitivity.label !== 'Pitch Sensitivity' ||
    sensitivity.min !== 0 ||
    sensitivity.max !== 100 ||
    sensitivity.step !== 1 ||
    sensitivity.unit !== '%' ||
    !Number.isSafeInteger(sensitivity.value) ||
    sensitivity.value < 0 ||
    sensitivity.value > 100
  ) {
    return parameterFailure(
      'Pitch Sensitivity must be one exact integer slider value from 0 through 100.',
    );
  }

  if (
    rangeMatches.length !== 1 ||
    noteRange?.kind !== 'select' ||
    noteRange.label !== 'Note Range' ||
    !areJsonValuesEqual(noteRange.options, ['Bass', 'Vocal', 'Lead']) ||
    !Object.prototype.hasOwnProperty.call(
      BASIC_PITCH_NOTE_RANGES,
      noteRange.value,
    )
  ) {
    return parameterFailure(
      'Note Range must be exactly Bass, Vocal, or Lead.',
    );
  }

  const range = noteRange.value as keyof typeof BASIC_PITCH_NOTE_RANGES;
  const frequency = BASIC_PITCH_NOTE_RANGES[range];
  const onsetThreshold = Number(
    (0.8 - sensitivity.value * 0.006).toFixed(6),
  );

  return Object.freeze({
    canResolve: true as const,
    parameters: Object.freeze({
      frameThreshold: BASIC_PITCH_FRAME_THRESHOLD,
      maximumFrequencyHz: frequency.maximumFrequencyHz,
      melodiaTrick: true,
      minimumFrequencyHz: frequency.minimumFrequencyHz,
      minimumNoteLengthMs: BASIC_PITCH_MINIMUM_NOTE_LENGTH_MS,
      multiplePitchBends: false as const,
      onsetThreshold,
    }),
    snapshot: Object.freeze({
      noteRange: range,
      sensitivity: sensitivity.value,
    }),
  });
}

export function createBasicPitchHumToMidiGenerationPlan(
  project: ProjectState,
  options: BasicPitchHumToMidiGenerationPlanOptions,
): BasicPitchHumToMidiPlanningResult {
  const converterPatchTabs = project.patchTabs.filter(
    (patchTab) => patchTab.id === options.converterPatchTabId,
  );
  const converterPatchTab = converterPatchTabs[0];

  if (
    converterPatchTabs.length !== 1 ||
    !converterPatchTab ||
    converterPatchTab.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi ||
    converterPatchTab.nodeVersion !== '1.0.0' ||
    !isHumToMidiPatchTab(converterPatchTab)
  ) {
    return planningFailure(
      'converter-invalid',
      `Hum to MIDI PatchTab does not resolve uniquely: ${options.converterPatchTabId}.`,
    );
  }

  const parameters = resolveBasicPitchHumToMidiParameters(converterPatchTab);

  if (!parameters.canResolve) {
    return planningFailure('parameters-invalid', parameters.message);
  }

  if (
    project.selection.items.length !== 1 ||
    project.selection.items[0]?.type !== 'clip'
  ) {
    return planningFailure(
      'selection-invalid',
      'Select exactly one Hum Audio Clip to convert.',
    );
  }

  const sourceClipId = project.selection.items[0].id;
  const sourceClips = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === sourceClipId);
  const sourceClip = sourceClips[0];

  if (sourceClips.length !== 1 || sourceClip.type !== 'hum-audio') {
    return planningFailure(
      'source-invalid',
      'The selected Clip must resolve to one Hum Audio recording.',
    );
  }

  const sourceResolution = resolveActiveAudioTakeSource(project, sourceClipId);

  if (!sourceResolution.canResolve) {
    return planningFailure('source-invalid', sourceResolution.message);
  }

  const recording = resolveCanonicalRecordingSource(
    project,
    sourceResolution.plan.source.artifactId,
    sourceResolution.plan.source.clipTakeId,
  );

  if (!recording) {
    return planningFailure(
      'source-invalid',
      'Hum to MIDI requires one canonical active microphone Recording Take and Artifact.',
    );
  }

  if (!Number.isFinite(project.bpm) || project.bpm < 40 || project.bpm > 240) {
    return planningFailure(
      'source-invalid',
      'Hum to MIDI requires Project BPM from 40 through 240.',
    );
  }

  const { clip, descriptor, source } = sourceResolution.plan;
  const request = freezeBasicPitchHumToMidiRequest({
    inputArtifacts: [
      {
        artifactId: source.artifactId,
        kind: 'audio',
        relativePath: descriptor.relativePath,
      },
    ],
    lineage: {
      parentArtifactIds: [source.artifactId],
      parentClipTakeIds: [source.clipTakeId],
    },
    modelId: BASIC_PITCH_MODEL_ID,
    modelRevision: BASIC_PITCH_MODEL_REVISION,
    output: { artifactKind: 'midi' },
    parameters: {
      ...parameters.parameters,
      projectBpm: project.bpm,
      sourceEndSeconds: clip.audioTiming.sourceEndSeconds,
      sourceStartSeconds: clip.audioTiming.sourceStartSeconds,
      ticksPerQuarter: TICKS_PER_QUARTER,
    },
    providerId: BASIC_PITCH_PROVIDER_ID,
    taskId: BASIC_PITCH_TASK_ID,
  });

  return Object.freeze({
    canPlan: true as const,
    plan: Object.freeze({
      converterPatchTabId: converterPatchTab.id,
      parameterSnapshot: parameters.snapshot,
      request,
      source: Object.freeze({
        artifactId: source.artifactId,
        clipId: source.clipId,
        clipName: clip.name,
        clipTakeId: source.clipTakeId,
        descriptor,
      }),
    }),
  });
}

export function createMockHumToMidiGenerationPlan(
  project: ProjectState,
  options: MockHumToMidiGenerationPlanOptions,
): MockHumToMidiGenerationPlanningResult {
  const converterPatchTabs = project.patchTabs.filter(
    (patchTab) => patchTab.id === options.converterPatchTabId,
  );
  const converterPatchTab = converterPatchTabs[0];

  if (
    converterPatchTabs.length !== 1 ||
    !isHumToMidiPatchTab(converterPatchTab)
  ) {
    return {
      canPlan: false,
      message: `Hum-to-MIDI converter does not resolve uniquely: ${options.converterPatchTabId}.`,
      reason: 'converter-invalid',
    };
  }

  const sourceClips = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === options.sourceClipId);
  const sourceClip = sourceClips[0];

  if (sourceClips.length !== 1 || sourceClip.type !== 'hum-audio') {
    return {
      canPlan: false,
      message: `Hum Audio source does not resolve uniquely: ${options.sourceClipId}.`,
      reason: 'source-invalid',
    };
  }

  if (!Number.isSafeInteger(options.seed) || options.seed < 0) {
    return {
      canPlan: false,
      message: 'Hum-to-MIDI seed must be a non-negative safe integer.',
      reason: 'source-invalid',
    };
  }

  const sourceResolution = resolveActiveAudioTakeSource(
    project,
    options.sourceClipId,
  );

  if (!sourceResolution.canResolve) {
    return {
      canPlan: false,
      message: sourceResolution.message,
      reason: 'source-invalid',
    };
  }

  const { clip, descriptor, source } = sourceResolution.plan;
  const request = freezeMockHumToMidiRequest({
    inputArtifacts: [
      {
        artifactId: source.artifactId,
        kind: 'audio',
        relativePath: descriptor.relativePath,
      },
    ],
    lineage: {
      parentArtifactIds: [source.artifactId],
      parentClipTakeIds: [source.clipTakeId],
    },
    modelId: 'mock-hum-to-midi-v1',
    modelRevision: '1',
    output: {
      artifactKind: 'midi',
    },
    parameters: {
      projectBpm: project.bpm,
      seed: options.seed,
      sourceEndSeconds: clip.audioTiming.sourceEndSeconds,
      sourceStartSeconds: clip.audioTiming.sourceStartSeconds,
      ticksPerQuarter: TICKS_PER_QUARTER,
    },
    providerId: 'mock-provider',
    taskId: 'hum-to-midi',
  });

  return {
    canPlan: true,
    plan: Object.freeze({
      converterPatchTabId: converterPatchTab.id,
      request,
      source: Object.freeze({
        artifactId: source.artifactId,
        clipId: source.clipId,
        clipTakeId: source.clipTakeId,
        descriptor,
      }),
    }),
  };
}

export function createCompletedMockHumToMidiRegistration(
  project: ProjectState,
  {
    createdAt,
    defaultSoundFontAssignment,
    job,
    plan,
  }: CompletedMockHumToMidiRegistrationOptions,
): CompletedMockHumToMidiRegistrationResult {
  return createCompletedHumToMidiRegistration(project, {
    createdAt,
    defaultSoundFontAssignment,
    job,
    plan,
    replan: (currentProject) => {
      const latestPlan = createMockHumToMidiGenerationPlan(currentProject, {
        converterPatchTabId: plan.converterPatchTabId,
        seed: plan.request.parameters.seed,
        sourceClipId: plan.source.clipId,
      });

      return latestPlan.canPlan ? latestPlan.plan : undefined;
    },
  });
}

export function createCompletedBasicPitchHumToMidiRegistration(
  project: ProjectState,
  {
    createdAt,
    defaultSoundFontAssignment,
    job,
    plan,
  }: CompletedBasicPitchHumToMidiRegistrationOptions,
): CompletedBasicPitchHumToMidiRegistrationResult {
  return createCompletedHumToMidiRegistration(project, {
    createdAt,
    defaultSoundFontAssignment,
    job,
    plan,
    replan: (currentProject) => {
      const revalidationProject = createBasicPitchRevalidationProject(
        currentProject,
        plan,
        job,
      );
      const latestPlan = createBasicPitchHumToMidiGenerationPlan(
        revalidationProject,
        { converterPatchTabId: plan.converterPatchTabId },
      );

      return latestPlan.canPlan ? latestPlan.plan : undefined;
    },
  });
}

function createBasicPitchRevalidationProject(
  project: ProjectState,
  plan: BasicPitchHumToMidiGenerationPlan,
  job: LocalEngineGpuJobRecord,
): ProjectState {
  const selectedItem = project.selection.items[0];

  if (
    project.selection.items.length !== 1 ||
    selectedItem?.type !== 'clip'
  ) {
    return project;
  }

  const selectedTargets = project.tracks
    .flatMap((track) => track.clips)
    .filter(
      (clip) =>
        clip.id === selectedItem.id &&
        clip.type === 'midi-notes' &&
        clip.sourceClipId === plan.source.clipId,
    );
  const selectedTarget = selectedTargets[0];
  const activeTakes = (selectedTarget?.clipTakes ?? []).filter(
    (take) =>
      take.mediaType === 'midi' &&
      take.clipTakeId === selectedTarget?.activeClipTakeId &&
      'sourceJobId' in take &&
      take.sourceJobId === job.jobId,
  );
  const registeredArtifacts = (project.artifacts ?? []).filter(
    (artifact) =>
      artifact.kind === 'midi' &&
      'sourceJobId' in artifact &&
      artifact.sourceJobId === job.jobId &&
      activeTakes[0]?.artifactId === artifact.artifactId &&
      doesMidiArtifactMatchCompletedJob(artifact, job, plan.request),
  );

  if (
    selectedTargets.length !== 1 ||
    activeTakes.length !== 1 ||
    registeredArtifacts.length !== 1
  ) {
    return project;
  }

  const sourceSelection: SelectionItem = {
    id: plan.source.clipId,
    type: 'clip',
  };

  return {
    ...project,
    selection: {
      anchorItem: sourceSelection,
      items: [sourceSelection],
      lastSelectedItem: sourceSelection,
    },
  };
}

function createCompletedHumToMidiRegistration(
  project: ProjectState,
  {
    createdAt,
    defaultSoundFontAssignment,
    job,
    plan,
    replan,
  }: Readonly<{
    createdAt: string;
    defaultSoundFontAssignment?: SoundFontAssignment;
    job: LocalEngineGpuJobRecord;
    plan: HumToMidiRegistrationPlan;
    replan: (project: ProjectState) => HumToMidiRegistrationPlan | undefined;
  }>,
): CompletedMockHumToMidiRegistrationResult {
  if (
    job.state !== 'COMPLETED' ||
    job.jobId.length === 0 ||
    job.modelId !== plan.request.modelId ||
    job.modelRevision !== plan.request.modelRevision ||
    job.providerId !== plan.request.providerId ||
    job.taskId !== plan.request.taskId ||
    !areJsonValuesEqual(job.request, plan.request)
  ) {
    return {
      canRegister: false,
      message: 'Completed Hum-to-MIDI Job does not match the planned request.',
      reason: 'job-invalid',
    };
  }

  const latestPlan = replan(project);

  if (
    !latestPlan ||
    !areJsonValuesEqual(latestPlan.request, plan.request) ||
    !areJsonValuesEqual(latestPlan.source.descriptor, plan.source.descriptor)
  ) {
    return {
      canRegister: false,
      message:
        'MIDI Artifact finalized, but the source Take, file metadata, timing, or Project BPM changed.',
      reason: 'source-stale',
    };
  }

  const artifactValue = isRecord(job.result)
    ? job.result.artifact
    : undefined;

  if (artifactValue === undefined) {
    return {
      canRegister: false,
      message: `Hum-to-MIDI Job ${job.jobId} did not return an inline MIDI Artifact.`,
      reason: 'job-invalid',
    };
  }

  const targetResolution = resolveOrCreateMidiTarget(
    project,
    latestPlan,
    createdAt,
    defaultSoundFontAssignment,
  );

  if (!targetResolution.canResolve) {
    return {
      canRegister: false,
      message: targetResolution.message,
      reason: 'target-conflict',
    };
  }

  const registration = createMidiArtifactRegistration(
    targetResolution.project,
    artifactValue,
    { clipId: targetResolution.targetClipId },
  );

  if (!registration.canRegister) {
    return {
      canRegister: false,
      message: registration.message,
      reason: 'registration-failed',
    };
  }

  if (
    !doesMidiArtifactMatchCompletedJob(
      registration.artifact,
      job,
      plan.request,
    )
  ) {
    return {
      canRegister: false,
      message: `Hum-to-MIDI Job ${job.jobId} returned Artifact metadata that does not match its request.`,
      reason: 'job-invalid',
    };
  }

  const selectedItem: SelectionItem = {
    id: targetResolution.targetClipId,
    type: 'clip',
  };
  const nextProject: ProjectState = {
    ...registration.project,
    selection: {
      anchorItem: selectedItem,
      items: [selectedItem],
      lastSelectedItem: selectedItem,
    },
    status: 'MIDI READY',
  };
  const targetClip = findClip(nextProject, targetResolution.targetClipId);

  if (!targetClip) {
    return {
      canRegister: false,
      message: 'Registered MIDI target disappeared from the Project transaction.',
      reason: 'registration-failed',
    };
  }

  return {
    artifact: registration.artifact,
    canRegister: true,
    clipTake: registration.clipTake,
    project: nextProject,
    status: registration.status,
    targetClip,
    targetCreated: targetResolution.targetCreated,
  };
}

function resolveOrCreateMidiTarget(
  project: ProjectState,
  plan: HumToMidiTargetPlan,
  createdAt: string,
  defaultSoundFontAssignment?: SoundFontAssignment,
): MidiTargetResolution {
  const sourceClip = findClip(project, plan.source.clipId);
  const converterPatchTab = project.patchTabs.find(
    (patchTab) => patchTab.id === plan.converterPatchTabId,
  );

  if (
    !sourceClip ||
    sourceClip.type !== 'hum-audio' ||
    !isHumToMidiPatchTab(converterPatchTab)
  ) {
    return {
      canResolve: false,
      message: 'Hum-to-MIDI source or converter disappeared before registration.',
    };
  }

  const matchingTargets = project.tracks.flatMap((track) =>
    track.clips
      .filter(
        (clip) =>
          clip.type === 'midi-notes' &&
          clip.sourceClipId === sourceClip.id,
      )
      .map((clip) => ({ clip, track })),
  );

  if (matchingTargets.length > 1) {
    return {
      canResolve: false,
      message: `${sourceClip.name} resolves to multiple MIDI Clips. Merge or remove the duplicate targets before converting again.`,
    };
  }

  const existingTarget = matchingTargets[0];

  if (existingTarget) {
    return existingTarget.track.type === 'midi'
      ? {
          canResolve: true,
          project,
          targetClipId: existingTarget.clip.id,
          targetCreated: false,
        }
      : {
          canResolve: false,
          message: `${existingTarget.clip.name} is not stored on a MIDI Track.`,
        };
  }

  if (!isTimestamp(createdAt)) {
    return {
      canResolve: false,
      message: 'MIDI Clip creation requires a valid timestamp.',
    };
  }

  const midiTracks = project.tracks.filter(
    (track) => track.id === 'midi-notes',
  );

  if (
    midiTracks.length > 1 ||
    (midiTracks.length === 1 && midiTracks[0].type !== 'midi')
  ) {
    return {
      canResolve: false,
      message: 'The MIDI Notes Track does not resolve to one valid MIDI Track.',
    };
  }

  const targetClip = createMidiTargetClip(
    project,
    sourceClip,
    converterPatchTab,
    createdAt,
    defaultSoundFontAssignment,
  );
  const existingMidiTrack = midiTracks[0];

  if (existingMidiTrack) {
    return {
      canResolve: true,
      project: {
        ...project,
        tracks: project.tracks.map((track) =>
          track === existingMidiTrack
            ? { ...track, clips: [...track.clips, targetClip] }
            : track,
        ),
      },
      targetClipId: targetClip.id,
      targetCreated: true,
    };
  }

  const midiTrack: Track = {
    clips: [targetClip],
    id: 'midi-notes',
    level: -6,
    muted: true,
    name: 'MIDI Notes',
    type: 'midi',
  };
  const sourceTrackIndex = project.tracks.findIndex((track) =>
    track.clips.some((clip) => clip.id === sourceClip.id),
  );
  const insertionIndex =
    sourceTrackIndex < 0 ? 0 : sourceTrackIndex + 1;

  return {
    canResolve: true,
    project: {
      ...project,
      tracks: [
        ...project.tracks.slice(0, insertionIndex),
        midiTrack,
        ...project.tracks.slice(insertionIndex),
      ],
    },
    targetClipId: targetClip.id,
    targetCreated: true,
  };
}

function createMidiTargetClip(
  project: ProjectState,
  sourceClip: Clip,
  converterPatchTab: PatchTab,
  createdAt: string,
  defaultSoundFontAssignment?: SoundFontAssignment,
): Clip {
  return {
    color: getClipTypeColor('midi-notes'),
    createdAt: new Date(createdAt).toISOString(),
    generatedBy: converterPatchTab.name,
    id: createUniqueMidiClipId(project, sourceClip.id),
    lengthTicks: sourceClip.lengthTicks,
    name: `MIDI ${sourceClip.name}`.slice(0, 128),
    sourceClipId: sourceClip.id,
    ...(defaultSoundFontAssignment
      ? {
          soundFont: {
            ...defaultSoundFontAssignment,
            resource: { ...defaultSoundFontAssignment.resource },
          },
        }
      : {}),
    startTick: sourceClip.startTick,
    type: 'midi-notes',
    version: 1,
  };
}

function createUniqueMidiClipId(
  project: ProjectState,
  sourceClipId: string,
): string {
  const existingIds = new Set(
    project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  const sourcePart =
    sourceClipId
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'source';
  const baseId = `clip-midi-${sourcePart}`;

  if (!existingIds.has(baseId)) {
    return baseId;
  }

  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;

    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to allocate a unique MIDI Clip ID.');
}

function findClip(project: ProjectState, clipId: string): Clip | undefined {
  const matches = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);

  return matches.length === 1 ? matches[0] : undefined;
}

function doesMidiArtifactMatchCompletedJob(
  artifact: MidiArtifact,
  job: LocalEngineGpuJobRecord,
  request: HumToMidiRequest,
): boolean {
  return (
    'sourceJobId' in artifact &&
    artifact.sourceJobId === job.jobId &&
    artifact.midi.bpm === request.parameters.projectBpm &&
    artifact.midi.ticksPerQuarter === request.parameters.ticksPerQuarter &&
    artifact.provenance.modelId === request.modelId &&
    artifact.provenance.modelRevision === request.modelRevision &&
    artifact.provenance.providerId === request.providerId &&
    artifact.provenance.taskId === request.taskId &&
    areJsonValuesEqual(artifact.lineage, request.lineage) &&
    areJsonValuesEqual(artifact.provenance.parameters, request.parameters)
  );
}

function freezeMockHumToMidiRequest(
  request: LocalEngineMockHumToMidiJobRequest,
): LocalEngineMockHumToMidiJobRequest {
  const inputArtifact = Object.freeze({ ...request.inputArtifacts[0] });
  const parentArtifactIds = Object.freeze(
    [...request.lineage.parentArtifactIds],
  ) as readonly [string];
  const parentClipTakeIds = Object.freeze(
    [...request.lineage.parentClipTakeIds],
  ) as readonly [string];

  return Object.freeze({
    ...request,
    inputArtifacts: Object.freeze([inputArtifact]) as readonly [
      typeof inputArtifact,
    ],
    lineage: Object.freeze({
      parentArtifactIds,
      parentClipTakeIds,
    }),
    output: Object.freeze({ ...request.output }),
    parameters: Object.freeze({ ...request.parameters }),
  });
}

function freezeBasicPitchHumToMidiRequest(
  request: LocalEngineBasicPitchHumToMidiJobRequest,
): LocalEngineBasicPitchHumToMidiJobRequest {
  const inputArtifact = Object.freeze({ ...request.inputArtifacts[0] });
  const parentArtifactIds = Object.freeze(
    [...request.lineage.parentArtifactIds],
  ) as readonly [string];
  const parentClipTakeIds = Object.freeze(
    [...request.lineage.parentClipTakeIds],
  ) as readonly [string];

  return Object.freeze({
    ...request,
    inputArtifacts: Object.freeze([inputArtifact]) as readonly [
      typeof inputArtifact,
    ],
    lineage: Object.freeze({
      parentArtifactIds,
      parentClipTakeIds,
    }),
    output: Object.freeze({ ...request.output }),
    parameters: Object.freeze({ ...request.parameters }),
  });
}

function resolveCanonicalRecordingSource(
  project: ProjectState,
  artifactId: string,
  clipTakeId: string,
): Readonly<{
  artifact: RecordingAudioArtifact;
  take: RecordingAudioClipTake;
}> | undefined {
  const artifacts = (project.artifacts ?? []).filter(
    (artifact) => artifact.artifactId === artifactId,
  );
  const takes = project.tracks
    .flatMap((track) => track.clips)
    .flatMap((clip) => clip.clipTakes ?? [])
    .filter((take) => take.clipTakeId === clipTakeId);
  const artifact = artifacts[0];
  const take = takes[0];

  if (
    artifacts.length !== 1 ||
    !isMicrophoneRecordingArtifact(artifact) ||
    artifact.file.extension !== '.wav' ||
    artifact.file.name !== `${artifact.artifactId}.wav` ||
    artifact.file.relativePath !== `recordings/${artifact.file.name}` ||
    artifact.lineage.parentArtifactIds.length !== 0 ||
    artifact.lineage.parentClipTakeIds.length !== 0 ||
    takes.length !== 1 ||
    take?.mediaType !== 'audio' ||
    take.sourceType !== 'recording' ||
    take.artifactId !== artifact.artifactId
  ) {
    return undefined;
  }

  return Object.freeze({ artifact, take });
}

function isMicrophoneRecordingArtifact(
  artifact: ProjectArtifact | undefined,
): artifact is RecordingAudioArtifact {
  return Boolean(
    artifact &&
      artifact.kind === 'audio' &&
      artifact.destination === 'recording' &&
      artifact.capture.source === 'microphone',
  );
}

function planningFailure(
  reason: Extract<BasicPitchHumToMidiPlanningResult, { canPlan: false }>['reason'],
  message: string,
): Extract<BasicPitchHumToMidiPlanningResult, { canPlan: false }> {
  return Object.freeze({ canPlan: false as const, message, reason });
}

function parameterFailure(
  message: string,
): Extract<BasicPitchHumToMidiParameterResolution, { canResolve: false }> {
  return Object.freeze({ canResolve: false as const, message });
}

export function createBasicPitchHumToMidiPlanKey(
  plan: BasicPitchHumToMidiGenerationPlan,
): string {
  return stableJson({
    converterPatchTabId: plan.converterPatchTabId,
    parameterSnapshot: plan.parameterSnapshot,
    request: plan.request,
    source: plan.source,
  });
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function isTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
