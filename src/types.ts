import type {
  MixerCompressorEffect,
  MixerEchoDelayEffect,
  MixerEqualizerEffect,
  MixerLimiterEffect,
} from '../shared/mixerEffectsContract.js';

export type PatchTabStatus = 'ready' | 'armed' | 'processing' | 'idle' | 'bypassed';

export type PatchPortDomain = 'artifact' | 'resource' | 'project-source';

export type PatchPortDataCategory =
  | 'audio'
  | 'midi'
  | 'lyrics'
  | 'stem-set'
  | 'metadata'
  | 'model'
  | 'file'
  | 'track'
  | 'group'
  | 'range'
  | 'control';

export type PatchPortDataTypeRef = {
  id: string;
  major: number;
};

export type PatchInputBindingKind = 'connection' | 'timeline-selection' | 'project-context' | 'timeline-range';

export type PatchPortCardinality = {
  min: number;
  max: number | 'many';
};

export type PatchInputPortContract = {
  id: string;
  label: string;
  domain: PatchPortDomain;
  dataCategory: PatchPortDataCategory;
  accepts: PatchPortDataTypeRef[];
  requiredCapabilities?: string[];
  preferredRoles?: string[];
  allowedBindings: PatchInputBindingKind[];
  cardinality: PatchPortCardinality;
};

export type PatchOutputPortContract = {
  id: string;
  label: string;
  domain: PatchPortDomain;
  dataCategory: PatchPortDataCategory;
  produces: PatchPortDataTypeRef;
  role?: string;
  capabilities?: string[];
  fanOut: 'one' | 'many';
};

export type PatchTabNodeCategory =
  | 'process'
  | 'convert'
  | 'edit'
  | 'instrument'
  | 'generate'
  | 'loader'
  | 'mix'
  | 'utility';

export type PatchTabDefinition = {
  schemaVersion: 1;
  nodeTypeId: string;
  nodeVersion: string;
  defaultName: string;
  nodeCategory: PatchTabNodeCategory;
  inputs: PatchInputPortContract[];
  outputs: PatchOutputPortContract[];
};

export type PatchTabInputBinding =
  | {
      portId: string;
      kind: 'connection';
      connectionIds: string[];
    }
  | {
      portId: string;
      kind: 'timeline-selection';
      selectionKind: 'clip';
    }
  | {
      portId: string;
      kind: 'project-context';
      selector: string;
    }
  | {
      portId: string;
      kind: 'timeline-range';
      source: 'selected' | 'fixed';
    };

export type PatchTab = {
  id: string;
  name: string;
  nodeTypeId?: string;
  nodeVersion?: string;
  portContractSnapshot?: PatchTabDefinition;
  inputBindings?: PatchTabInputBinding[];
  colorIndex: number;
  inputType: string;
  outputType: string;
  inputTypes?: WorkflowInputType[];
  outputTypes?: WorkflowOutputType[];
  status: PatchTabStatus;
  description: string;
  parameters: PatchTabParameter[];
  generationContinuation?:
    | {
        kind: 'ace-step-cover';
        outputClipId: string;
        recipeFingerprint: string;
        sourceClipId: string;
        sourceClipTakeId: string;
      }
    | {
        kind: 'ace-step-text-to-music';
        outputClipId: string;
        recipeFingerprint: string;
      }
    | {
        kind: 'stable-audio-3-text-to-audio';
        outputClipId: string;
        recipeFingerprint: string;
      }
    | {
        kind: 'stable-audio-3-audio-to-audio';
        outputClipId: string;
        recipeFingerprint: string;
        sourceClipId: string;
        sourceClipTakeId: string;
      };
};

export type PatchTabParameter =
  | {
      id: string;
      label: string;
      kind: 'slider';
      min: number;
      max: number;
      step: number;
      value: number;
      unit?: string;
    }
  | {
      id: string;
      label: string;
      kind: 'number';
      min: number;
      max: number;
      step: number;
      value: number;
      unit?: string;
    }
  | {
      id: string;
      label: string;
      kind: 'select';
      value: string;
      options: string[];
    }
  | {
      id: string;
      label: string;
      kind: 'text';
      value: string;
      maxLength?: number;
      multiline?: boolean;
      placeholder?: string;
    };

export type TabFlowConnection = {
  id: string;
  fromPatchTabId: string;
  toPatchTabId: string;
  fromPortId?: string;
  toPortId?: string;
  activation?: 'on' | 'off' | 'draft';
  createdOrder?: number;
  signalType: string;
  order: number;
  latencyMs: number;
  enabled: boolean;
};

export type TabFlowLineAttachment = {
  parentLineId: string;
  patchTabId: string;
  portId?: string;
  kind: 'branch-from' | 'merge-into';
};

export type TabFlowLine = {
  id: string;
  name: string;
  order: number;
  enabled: boolean;
  revision: number;
  connectionIds: string[];
  familyId?: string;
  attachment?: TabFlowLineAttachment;
  childOrder?: number;
};

export type ClipType =
  | 'hum-audio'
  | 'midi-notes'
  | 'edited-midi'
  | 'instrument-audio'
  | 'arrangement'
  | 'vocal-audio'
  | 'ai-fill-audio'
  | 'mixdown'
  | 'master';

export type ClipParameterSnapshot = Record<string, string | number>;

export type ClipSourceFileStatus = 'available' | 'missing' | 'moved' | 'unresolved';

export type ClipSourceFile = {
  name: string;
  status: ClipSourceFileStatus;
  sourceId?: string;
  path?: string;
  lastKnownPath?: string;
  relativePath?: string;
  checkedAt?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
  durationSeconds?: number;
};

export type AudioClipTiming = {
  timeBase: 'absolute-seconds';
  sourceStartSeconds: number;
  sourceEndSeconds: number;
};

export type ProjectJsonValue =
  | boolean
  | number
  | string
  | null
  | ProjectJsonValue[]
  | { [key: string]: ProjectJsonValue };

export type ArtifactLineage = {
  parentArtifactIds: string[];
  parentClipTakeIds: string[];
};

export type ArtifactFile = {
  extension: string;
  name: string;
  relativePath: string;
  sizeBytes: number;
};

export type ArtifactProvenance = {
  modelId: string;
  modelRevision: string;
  parameters: Record<string, ProjectJsonValue>;
  providerId: string;
  seed?: number;
  taskId: string;
};

export type AudioArtifactMetadata = {
  channels: number;
  durationSeconds: number;
  mimeType: string;
};

type BaseAudioArtifact = {
  artifactId: string;
  audio: AudioArtifactMetadata;
  createdAt: string;
  file: ArtifactFile;
  kind: 'audio';
  lineage: ArtifactLineage;
};

export type GeneratedAudioArtifact = BaseAudioArtifact & {
  destination: 'ace-step' | 'export' | 'instrument' | 'mixdown' | 'stable-audio-3';
  provenance: ArtifactProvenance;
  sourceJobId: string;
};

export type ProjectMixdownAudioArtifact = BaseAudioArtifact & {
  audio: AudioArtifactMetadata & {
    bitsPerSample: 16;
    channels: 2;
    frameCount: number;
    mimeType: 'audio/wav';
    sampleRate: 44_100;
  };
  destination: 'mixdown';
  mixdownProvenance:
    | {
        canonicalPlanJson: string;
        inputClipIds: string[];
        inputSourceIds: string[];
        inputTrackIds: string[];
        operationProtocolVersion: '1';
        planVersion: 1 | 2;
        rendererId: string;
        rendererVersion: string;
      }
    | {
        canonicalPlanJson: string;
        inputClipIds: string[];
        inputSourceIds: string[];
        inputTrackIds: string[];
        operationProtocolVersion: '2';
        planVersion: 3;
        rendererId: string;
        rendererVersion: string;
        schemaVersion: 2;
      };
  sourceOperationId: string;
};

export type ProjectStemPrintAudioArtifact = BaseAudioArtifact & {
  audio: AudioArtifactMetadata & {
    bitsPerSample: 16;
    channels: 2;
    frameCount: number;
    mimeType: 'audio/wav';
    sampleRate: 44_100;
  };
  destination: 'stem-print';
  sourceOperationId: string;
  stemPrintProvenance: {
    canonicalPlanJson: string;
    inputClipIds: string[];
    inputSourceIds: string[];
    inputTrackIds: string[];
    operationProtocolVersion: '1';
    planSha256: string;
    planVersion: 1;
    rendererId: string;
    rendererVersion: string;
    schemaVersion: 1;
    selectedTargets: Array<
      | {
          kind: 'channel';
          resolvedTrackId: string;
          trackId: string;
        }
      | {
          groupTrackId: string;
          kind: 'group';
          resolvedTrackId: string;
        }
    >;
  };
};

export type PrintMixProvenance = {
  canonicalPlanJson: string;
  inputClipIds: string[];
  inputSourceIds: string[];
  operationProtocolVersion: '1';
  planSha256: string;
  planVersion: 1;
  schemaVersion: 1;
};

export type PrintMixAudioArtifact = BaseAudioArtifact & {
  audio: AudioArtifactMetadata & {
    bitsPerSample: 16;
    channels: 2;
    frameCount: number;
    mimeType: 'audio/wav';
    sampleRate: 44_100;
  };
  destination: 'print-mix';
  printMixProvenance: PrintMixProvenance & {
    appliedGain: number;
    clippingWarning: boolean;
    normalize: boolean;
    outputPeak: number;
    preNormalizationPeak: number;
    rendererId: 'humstudio.print-mix.pcm16';
    rendererVersion: '1.0.0';
    targetPeakDbfs: -1;
  };
  sourceOperationId: string;
};

export type RecordingAudioArtifact = BaseAudioArtifact & {
  audio: AudioArtifactMetadata & {
    bitsPerSample: 16;
    channels: 1;
    mimeType: 'audio/wav';
    sampleRate: number;
  };
  capture: {
    inputDeviceId?: string;
    inputDeviceLabel?: string;
    source: 'microphone';
  };
  destination: 'recording';
};

export type PunchAudioArtifact = BaseAudioArtifact & {
  audio: AudioArtifactMetadata & {
    bitsPerSample: 16;
    channels: 1 | 2;
    mimeType: 'audio/wav';
    sampleRate: number;
  };
  capture: {
    inputDeviceId?: string;
    inputDeviceLabel?: string;
    source: 'punch';
  };
  destination: 'recording';
  punch: {
    baseArtifactId: string;
    baseClipTakeId: string;
    clipId: string;
    punchInTick: number;
    punchOutTick: number;
    rendererId: 'humstudio.pipo.pcm16';
    rendererVersion: '1.0.0';
    schemaVersion: 1;
  };
};

export type AudioArtifact =
  | GeneratedAudioArtifact
  | PunchAudioArtifact
  | ProjectMixdownAudioArtifact
  | ProjectStemPrintAudioArtifact
  | PrintMixAudioArtifact
  | RecordingAudioArtifact;

export type MidiNote = {
  id: string;
  pitch: number;
  startTick: number;
  lengthTicks: number;
  velocity: number;
  confidence?: number;
};

type BaseMidiArtifact = {
  artifactId: string;
  createdAt: string;
  kind: 'midi';
  lineage: ArtifactLineage;
  midi: {
    bpm: number;
    notes: MidiNote[];
    ticksPerQuarter: number;
  };
};

export type GeneratedMidiArtifact = BaseMidiArtifact & {
  provenance: ArtifactProvenance;
  sourceJobId: string;
};

export type EditedMidiArtifact = BaseMidiArtifact & {
  contentHash?: string;
  editProvenance: {
    editorId: string;
    editorVersion: string;
    taskId: 'midi-edit';
  };
  revision?: number;
  sourceEditId: string;
  updatedAt?: string;
};

export type ManualMidiArtifact = BaseMidiArtifact & {
  contentHash: string;
  manualProvenance: {
    editorId: string;
    editorVersion: string;
    taskId: 'manual-midi';
  };
  revision: number;
  sourceManualId: string;
  updatedAt: string;
};

export type PrintMixMidiArtifact = BaseMidiArtifact & {
  contentHash: string;
  printMixProvenance: PrintMixProvenance;
  sourceOperationId: string;
};

export type MidiArtifact =
  | GeneratedMidiArtifact
  | EditedMidiArtifact
  | ManualMidiArtifact
  | PrintMixMidiArtifact;

export type ProjectArtifact = AudioArtifact | MidiArtifact;

type BaseAudioClipTake = {
  artifactId: string;
  clipTakeId: string;
  createdAt: string;
  label: string;
  mediaType: 'audio';
};

export type GeneratedAudioClipTake = BaseAudioClipTake & {
  sourceType: 'job';
  sourceJobId: string;
};

export type RecordingAudioClipTake = BaseAudioClipTake & {
  sourceType: 'recording';
};

export type ProjectMixdownAudioClipTake = BaseAudioClipTake & {
  sourceOperationId: string;
  sourceType: 'mixdown';
};

export type ProjectStemPrintAudioClipTake = BaseAudioClipTake & {
  sourceOperationId: string;
  sourceType: 'stem-print';
};

export type PrintMixAudioClipTake = BaseAudioClipTake & {
  sourceOperationId: string;
  sourceType: 'print-mix';
};

export type AudioClipTake =
  | GeneratedAudioClipTake
  | ProjectMixdownAudioClipTake
  | ProjectStemPrintAudioClipTake
  | PrintMixAudioClipTake
  | RecordingAudioClipTake;

type BaseMidiClipTake = {
  artifactId: string;
  clipTakeId: string;
  createdAt: string;
  label: string;
  mediaType: 'midi';
};

export type GeneratedMidiClipTake = BaseMidiClipTake & {
  sourceJobId: string;
  sourceType: 'job';
};

export type EditedMidiClipTake = BaseMidiClipTake & {
  contentHash?: string;
  revision?: number;
  sourceEditId: string;
  sourceType: 'edit';
  updatedAt?: string;
};

export type ManualMidiClipTake = BaseMidiClipTake & {
  contentHash: string;
  revision: number;
  sourceManualId: string;
  sourceType: 'manual';
  updatedAt: string;
};

export type PrintMixMidiClipTake = BaseMidiClipTake & {
  contentHash: string;
  sourceOperationId: string;
  sourceType: 'print-mix';
};

export type MidiClipTake =
  | GeneratedMidiClipTake
  | EditedMidiClipTake
  | ManualMidiClipTake
  | PrintMixMidiClipTake;

export type ClipTake = AudioClipTake | MidiClipTake;

export type ExportManifest = {
  id: string;
  targetClipId: string;
  sourceClipId: string;
  format: string;
  normalize: string;
  durationTicks: number;
  estimatedFileName: string;
  status: 'mock-ready';
  createdAt: string;
  version: number;
};

export type ClipTabFlowApplication = {
  runId: string;
  tabFlowLineId: string;
  tabFlowLineName: string;
  tabFlowLineRevision: number;
  sourceConnectionIds: string[];
  appliedAt: string;
};

export type SoundFontFormat = 'sf2' | 'sf3';
export type SoundFontLibrary = 'builtin' | 'project';

export type ProjectSoundFontResourceReference = {
  format: SoundFontFormat;
  library: SoundFontLibrary;
  relativePath: string;
  resourceId: string;
};

export type SoundFontAssignment = {
  bank: number;
  program: number;
  resource: ProjectSoundFontResourceReference;
};

export type Clip = {
  id: string;
  type: ClipType;
  name: string;
  startTick: number;
  lengthTicks: number;
  color: string;
  sourceClipId?: string;
  sourceFile?: ClipSourceFile;
  audioTiming?: AudioClipTiming;
  activeClipTakeId?: string;
  clipTakes?: ClipTake[];
  generatedBy?: string;
  parameterSnapshot?: ClipParameterSnapshot;
  exportManifest?: ExportManifest;
  appliedTabFlows?: ClipTabFlowApplication[];
  soundFont?: SoundFontAssignment;
  createdAt: string;
  version: number;
};

export type Track = {
  id: string;
  name: string;
  type: TrackType;
  /** Compatibility projection of this Track's Channel or a Group's active child Channel Fader. */
  level: number;
  /** Compatibility projection of this Track's Channel or a Group's active child Channel Mute. */
  muted?: boolean;
  clips: Clip[];
  parentGroupId?: string | null;
  group?: TrackGroupData;
};

export type TrackType =
  | 'blank'
  | 'audio'
  | 'midi'
  | 'arrangement'
  | 'master'
  | 'generated_audio'
  | 'vocal'
  | 'drum'
  | 'bass'
  | 'chord'
  | 'melody'
  | 'fx'
  | 'group';

export type TrackGroupData = {
  childTrackIds: string[];
  collapsed: boolean;
  playbackMode: 'bottom_child';
  activePlaybackTrackId: string;
};

/** R6.1 retained history reserves empty ordered Inserts in Mixer State v1. */
export type MixerInsertChainV1 = readonly [];

export type MixerChannelStateV1 = Readonly<{
  trackId: string;
  faderDb: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  inserts: MixerInsertChainV1;
  outputBusId: 'stereo-master';
}>;

export type MixerMasterStateV1 = Readonly<{
  busId: 'stereo-master';
  faderDb: number;
  inserts: MixerInsertChainV1;
}>;

export type ProjectMixerStateV1 = Readonly<{
  schemaVersion: 1;
  channels: readonly MixerChannelStateV1[];
  master: MixerMasterStateV1;
}>;

export type MixerChannelInsertChainV2 = readonly [
  MixerEqualizerEffect,
  MixerCompressorEffect,
  MixerEchoDelayEffect,
];

export type MixerMasterInsertChainV2 = readonly [
  MixerEqualizerEffect,
  MixerCompressorEffect,
  MixerLimiterEffect,
];

export type MixerChannelStateV2 = Readonly<{
  trackId: string;
  faderDb: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  inserts: MixerChannelInsertChainV2;
  outputBusId: 'stereo-master';
}>;

export type MixerMasterStateV2 = Readonly<{
  busId: 'stereo-master';
  faderDb: number;
  inserts: MixerMasterInsertChainV2;
}>;

export type ProjectMixerStateV2 = Readonly<{
  schemaVersion: 2;
  channels: readonly MixerChannelStateV2[];
  master: MixerMasterStateV2;
}>;

/** Normalized runtime and newly persisted Projects always use Mixer State v2. */
export type ProjectMixerState = ProjectMixerStateV2;

export type WorkflowInputType = 'audio_clip' | 'midi_clip' | 'track' | 'group_track' | 'selected_range';

export type WorkflowOutputType = 'midi_clip' | 'audio_clip' | 'generated_track' | 'take' | 'log';

export type TimelineGridResolution = '1/8' | '1/16' | '1/32' | '1/64';

export type CountInBars = 0 | 1 | 2;

export type RecordingSettings = {
  countInBars: CountInBars;
  metronomeEnabled: boolean;
  metronomeVolume: number;
};

export type SelectionItem = { type: 'clip'; id: string } | { type: 'track'; id: string };

export type SelectionState = {
  items: SelectionItem[];
  anchorItem?: SelectionItem | null;
  lastSelectedItem?: SelectionItem | null;
};

export type TakeExecutionMode = 'auto_patch' | 'single_take' | 'manual_step' | 'dry_run';

export type TakeLogEntry = {
  level: 'info' | 'warning' | 'error';
  message: string;
  createdAt: string;
};

export type TabFlowSnapshot = {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  revision: number;
  connectionIds: string[];
  familyId?: string;
  parentLineId?: string;
  displayLabel?: string;
};

export type PatchSnapshot = {
  id: string;
  name: string;
  inputType: string;
  outputType: string;
};

export type RoutingSnapshot = {
  connectionId: string;
  fromPatchTabId: string;
  toPatchTabId: string;
  fromPortId?: string;
  toPortId?: string;
  activation?: 'on' | 'off' | 'draft';
  enabled: boolean;
  order: number;
};

export type TabFlowStageResultScope = Readonly<{
  familyId: string;
  familyRevision: number;
  stageId: string;
  targetClipId: string;
}>;

export type TabFlowStageResultRecord = Readonly<{
  fingerprint: string;
  finishedAt: string;
  outputArtifactIds: readonly string[];
  outputClipTakeIds: readonly string[];
  resultId: string;
  scope: TabFlowStageResultScope;
  state: 'COMPLETED' | 'FAILED' | 'PARTIAL';
}>;

export type CompletedTabFlowStageResultRecord = Omit<
  TabFlowStageResultRecord,
  'state'
> &
  Readonly<{ state: 'COMPLETED' }>;

export type RunHistoryEntry = {
  id: string;
  name: string;
  executionMode: TakeExecutionMode;
  sourceSelection: SelectionItem[];
  appliedTabFlowIds: string[];
  appliedPatchIds: string[];
  tabFlowSnapshots: TabFlowSnapshot[];
  patchSnapshots: PatchSnapshot[];
  routingSnapshots: RoutingSnapshot[];
  generatedClipIds: string[];
  generatedTrackIds: string[];
  logs: TakeLogEntry[];
  createdAt: string;
};

export type Take = RunHistoryEntry;

export type ProjectState = {
  name: string;
  bpm: number;
  key: string;
  status: string;
  isLooping: boolean;
  selectedPatchTabId: string;
  patchTabs: PatchTab[];
  connections: TabFlowConnection[];
  tabFlowLines?: TabFlowLine[];
  tabFlowStageResults?: readonly CompletedTabFlowStageResultRecord[];
  tracks: Track[];
  /** Present after Project normalization; optional only for legacy Project input. */
  mixer?: ProjectMixerState;
  artifacts?: ProjectArtifact[];
  selection: SelectionState;
  takes: RunHistoryEntry[];
  playheadTick: number;
  totalTicks: number;
  gridResolution: TimelineGridResolution;
  recordingSettings: RecordingSettings;
};

export type TabFlowPreset = {
  id: string;
  name: string;
  description: string;
  intent: string;
  project: ProjectState;
};
