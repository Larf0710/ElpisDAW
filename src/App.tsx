import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ChangeEvent as ReactChangeEvent,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from 'react';

import { getPatchTabColorCode } from './patchTabColors';
import { getClipTypeColor } from './clipTypeColors';
import {
  HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH,
} from './defaultSoundFontPreset';
import { resolveTimelineLengthBarsValue } from './timelineLengthBars';
import {
  canJumpToSessionEdit,
  commitSessionEdit,
  createSessionEditHistory,
  getSessionEditFrames,
  jumpSessionEdit,
  redoSessionEdit,
  undoSessionEdit,
  updateSessionEditPresent,
} from './sessionEditHistory';
import type {
  SessionEditCategory,
  SessionEditEntry,
  SessionEditHistory,
} from './sessionEditHistory';
import type { LocalEngineBootstrap } from './localEngineBootstrap';
import { LocalEngineClient } from './localEngineClient';
import type {
  LocalEngineGpuJobProgress,
  LocalEngineGpuJobState,
  LocalEngineProjectFileSave,
  LocalEngineProjectRoot,
  LocalEngineSoundFontPresetCatalogResult,
  LocalEngineSoundFontResource,
} from './localEngineClient';
import {
  runLocalEngineInstrumentRender,
} from './localEngineInstrumentRender';
import {
  createFluidSynthInstrumentRenderPlan,
} from './fluidSynthInstrumentRender';
import {
  INSTRUMENT_BANK_PARAMETER_ID,
  INSTRUMENT_PROGRAM_PARAMETER_ID,
  isInstrumentPresetControlLocked,
  normalizeInstrumentPresetParameters,
  resolveInstrumentPatchTabPreset,
} from './instrumentPatchTab';
import {
  resolveInstrumentSoundFont,
  SOUNDFONT_BANK_PARAMETER_ID,
  SOUNDFONT_PROGRAM_PARAMETER_ID,
  SOUNDFONT_RESOURCE_PARAMETER_ID,
  type InstrumentSoundFontResolution,
} from './soundFontPatchTab';
import {
  createSoundFontPresetKey,
  parseSoundFontPresetKey,
  useSoundFontPresetCatalog,
} from './useSoundFontPresetCatalog';
import { resolveActiveMidiTake } from './activeMidiTake';
import {
  createInstrumentRenderRegistration,
  doesInstrumentRenderJobMatchRequest,
} from './instrumentRenderRegistration';
import { MetronomeRuntime } from './metronomeRuntime';
import { createLocalEngineAvailability } from './localEngineAvailability';
import {
  createInitialLocalEngineConnectionState,
  createLocalEngineConfigurationError,
  LOCAL_ENGINE_HEARTBEAT_INTERVAL_MS,
  reduceLocalEngineHealthResult,
} from './localEngineConnection';
import type { LocalEngineConnectionState } from './localEngineConnection';
import { tabFlowPresets } from './presets';
import {
  PianoRollInteractionSpike,
  type PianoRollSoundFontAuditionRequest,
} from './PianoRollInteractionSpike';
import {
  PianoRollLiveNotePreviewRuntime,
  type PianoRollLiveNotePreviewSelection,
  type PianoRollLiveNotePreviewState,
} from './pianoRollLiveNotePreview';
import {
  MixerEffectsEditor,
  type MixerEffectsEditorCommandOutcome,
} from './MixerEffectsEditor';
import {
  createStudioDockScrollMemory,
  getStudioPageNavigationDestination,
  getStudioPageNavigationScrollTop,
} from './studioWorkspaceNavigation';
import {
  createBrowserTimelineFlipTransitionEnvironment,
  createBrowserTimelineExpandTransitionEnvironment,
  createTimelineFlipTransitionCoordinator,
  createTimelineExpandTransitionCoordinator,
  type TimelineExpandTransitionCoordinator,
  type TimelineFlipTransitionCoordinator,
} from './studioTimelineExpandTransition';
import type {
  PianoRollSoundFontAuditionState,
  PianoRollSoundFontCatalogState,
} from './PianoRollSoundFontControl';
import {
  createNewPianoRollTake,
  savePianoRollTake,
  type PianoRollTakeIdentity,
} from './pianoRollTakeEditing';
import { createManualMidiClip } from './manualMidiClip';
import { createDefaultPatchTabs, createEmptyProject } from './emptyProject';
import {
  createPatchTabTemplateCatalog,
  resolvePatchTabTemplateInstanceIdentity,
} from './stableAudio3PatchTab';
import {
  resolvePatchTabTemplateAvailability,
} from './patchTabTemplateAvailability';
import {
  isPrintMixPatchTab,
} from './printMixPatchTab';
import {
  PrintMixUiController,
  createInitialPrintMixUiState,
  createPrintMixUiPresentation,
  type PrintMixUiResult,
  type PrintMixUiState,
} from './printMixUiController';
import {
  BasicPitchHumToMidiUiController,
  createBasicPitchHumToMidiUiPresentation,
  createInitialBasicPitchHumToMidiUiState,
  type BasicPitchHumToMidiUiResult,
  type BasicPitchHumToMidiUiState,
  type BasicPitchRuntimeUiState,
} from './basicPitchHumToMidiUiController';
import { createStableAudio3AudioToAudioUiPresentation } from './stableAudio3AudioToAudioUi';
import {
  applyStableAudio3TextToAudioManagedPrompt,
  isStableAudio3TextToAudioPatchTab,
  prepareStableAudio3TextToAudioPatchTabRun,
  resolveStableAudio3TextToAudioPatchTabSettings,
  type StableAudio3TextToAudioPatchTabSettingsResolution,
} from './stableAudio3TextToAudioPatchTab';
import { runStableAudio3TextToAudioPlan } from './stableAudio3TextToAudioRunner';
import { settleStableAudio3TextToAudioJobs } from './stableAudio3TextToAudioSettlement';
import {
  isAceStepTextToMusicPatchTab,
  prepareAceStepTextToMusicRun,
  resolveAceStepTextToMusicSettings,
} from './aceStepTextToMusicPatchTab';
import { runAceStepTextToMusicPlan } from './aceStepTextToMusicRunner';
import { settleAceStepTextToMusicJobs } from './aceStepTextToMusicSettlement';
import {
  isAceStepCoverPatchTab,
  prepareAceStepCoverRun,
  preflightAceStepCoverRun,
  resolveAceStepCoverSettings,
} from './aceStepCoverPatchTab';
import { runAceStepCoverPlan } from './aceStepCoverRunner';
import { settleAceStepCoverJobs } from './aceStepCoverSettlement';
import {
  createAceStepTextToAudioVocalTarget,
  createAceStepPatchTabModelSummary,
  isAceStepPatchTab,
  prepareAceStepPatchTabRun,
  resolveAceStepPatchTabSettings,
  type AceStepPatchTabPreparation,
  type AceStepPatchTabSettingsResolution,
} from './aceStepPatchTab';
import {
  ACE_STEP_PRODUCTION_MONITORING_POLICY,
  runAceStepTextToAudioVocalStage,
  runAceStepVocalStage,
  type AceStepVocalStageOptions,
} from './aceStepVocalStage';
import {
  canRequestAceStepVocalCancellation,
  isAceStepVocalUiActive,
  resolveAceStepVocalAction,
  type AceStepVocalUiState,
} from './aceStepVocalCancellation';
import {
  createTimelineClipDropUpdate,
  createTimelineClipMoveUpdate,
  doesTickRangeOverlapTrack,
  getTimelineClipEdgeAutoScrollStep,
} from './timelineClipPlacement';
import {
  applyFlatGroupTrackCopyPlan,
  createCopiedTimelineClip,
  copyOrdinaryTimelineTrack,
  resolveTimelineCopyAvailability,
  type TimelineCopyAvailability,
} from './timelineTrackCopy';
import {
  applyTimelineTreeDeletionPlan,
  applyTrackGroupCollapsedState,
  applyTrackGroupingPlan,
  applyTrackUngroupPlan,
  resolveTimelineTreeDeletion,
  resolveTrackGroupingPlan,
  resolveTrackGroupVisibleRows,
  resolveTrackUngroupPlan,
  type TimelineTreeDeletionImpact,
  type TrackGroupingAvailability,
} from './trackGroupTree';
import { getNearestScrollOffset } from './timelineClipReveal';
import {
  collectReferencedSessionAudioSourceIds,
  reconnectProjectSessionAudioSources,
  SessionAudioSourceRegistry,
} from './sessionAudioSourceRegistry';
import {
  METRONOME_VOLUME_MAX,
  METRONOME_VOLUME_MIN,
  normalizeRecordingSettings,
} from './recordingSettings';
import {
  countInBarOptions,
  createRecordingTimingPlan,
  getRecordingPlayheadTick,
  RECORDING_BPM_MAX,
  RECORDING_BPM_MIN,
} from './recordingTiming';
import type {
  AudioArtifact,
  Clip,
  ClipSourceFileStatus,
  ClipTabFlowApplication,
  ClipType,
  CountInBars,
  ExportManifest,
  GeneratedAudioClipTake,
  MidiNote,
  PatchTab,
  PatchTabParameter,
  ProjectArtifact,
  ProjectState,
  RecordingSettings,
  SelectionItem,
  SelectionState,
  SoundFontAssignment,
  TabFlowConnection,
  TabFlowLine,
  TabFlowPreset,
  Take,
  Track,
  TimelineGridResolution,
} from './types';
import {
  createAudioTimebaseBpmProjectUpdate,
  createFullSourceAudioClipTiming,
  doesAudioClipTimingFitSourceDuration,
  getAudioClipSourceDurationSeconds,
  normalizeClipAudioTimingMetadata,
  secondsToTimelineTicks,
  timelineTicksToSeconds,
} from './audioClipTiming';
import { normalizeLegacyAceStepCoverClipTiming } from './aceStepCoverLegacyTiming';
import {
  AudioClipPlaybackRuntime,
  createAudioPlaybackContentFingerprint,
  createAudioClipPlaybackPlan,
} from './audioClipPlayback';
import { activateClipTake } from './clipTakeActivation';
import { verifyClipTakeActivationAvailability } from './clipTakeActivationAvailability';
import { resolveClipTakeAudioPreview } from './clipTakeAudioPreview';
import {
  createActiveClipTakeRemovalConfirmationCopy,
  planClipTakeRemoval,
} from './clipTakeRemoval';
import {
  classifyAudioFileDeletion,
  reconcileCommittedClipTakeRemoval,
  settleProjectSave,
} from './clipTakeDeletionTransaction';
import { verifyGeneratedAudioArtifactsForCommit } from './generatedAudioCommitAvailability';
import { persistBrowserSave } from './browserSave';
import { TimelineExportUiController } from './timelineExportUiController';
import {
  FinalFilerController,
  resolveFinalFilerAvailability,
  resolveFinalFilerFileName,
  type FinalFilerAvailability,
  type FinalFilerControllerResult,
  type FinalFilerFileNameResolution,
} from './finalFilerController';
import { createFinalFilerBuildIdentitySnapshot } from './finalFilerSourceReport';
import type { AudioClipPlaybackPlan } from './audioClipPlayback';
import {
  InstrumentAudioPreviewRuntime,
  type InstrumentAudioPreviewPlan,
} from './instrumentAudioPreviewRuntime';
import {
  createProjectPlaybackPlan,
} from './projectPlaybackPlan';
import {
  hasRequestedSoundFontMidiClips,
  MidiClipPlaybackCache,
  type MidiClipPlaybackCachePreparation,
} from './midiClipPlaybackCache';
import {
  normalizeProjectMixerState,
  reconcileProjectMixerState,
  toggleProjectMixerChannelMute,
} from './projectMixerState';
import {
  createProjectDirtyStateFingerprint,
  hasProjectDirtyStateDrift,
} from './projectDirtyStateFingerprint';
import {
  createNormalizedProjectLoad,
  createSavedProjectFingerprintAfterLoad,
  type NormalizedProjectLoad,
} from './projectLoadNormalization';
import {
  createCompletedAudioJobRegistration,
  normalizeClipTakeState,
  normalizeProjectArtifacts,
} from './projectArtifactRegistration';
import { createRecordingArtifactRegistration } from './recordingArtifactRegistration';
import { MicrophoneRecordingRuntime } from './microphoneRecordingRuntime';
import { materializePunchAudio } from './punchAudioMaterialization';
import {
  addPunchAttempt,
  createPunchSession,
  getSelectedPunchAttempt,
  resolvePunchTarget,
  selectPunchAttempt,
  togglePunchMarker,
  type PunchSession,
} from './punchSession';
import { createPunchTakeRegistration } from './punchTakeRegistration';
import { createRecordingPlacementPlan } from './recordingPlacement';
import { resolveRecordingTarget } from './recordingTarget';
import type {
  ProjectPlaybackPlan,
} from './projectPlaybackPlan';
import {
  createProjectPlaybackSchedule,
  ProjectPlaybackRuntime,
} from './projectPlaybackRuntime';
import {
  downloadProjectPlaybackDiagnostics,
  recordProjectPlaybackDiagnostic,
  resetProjectPlaybackDiagnostics,
} from './projectPlaybackDiagnostics';
import {
  createProjectPlaybackMeterStore,
  type ProjectPlaybackMeterStore,
} from './projectPlaybackMeterStore';
import {
  executeProjectMixerEffectCommand,
  type ProjectMixerEffectCommand,
} from './projectMixerEffectsCommand';
import {
  collectProjectPlaybackAudioSources,
  createProjectPlaybackSourceAvailabilitySnapshot,
} from './projectPlaybackSources';
import { canReadGeneratedAudioForProjectPlayback } from './projectPlaybackReadiness';
import {
  applyProjectSourceRestoration,
  collectProjectSourceRestorationDescriptors,
} from './projectSourceRestoration';
import {
  applyProjectRootProjectOpen,
  prepareLoadedProjectSourceRestoration,
  prepareProjectRootProjectOpen,
} from './projectRootProjectOpen';
import {
  prepareProjectMixdown,
  resolveClipFilerProductionSettings,
  resolveProjectMixdownDownload,
} from './projectMixdownPreparation';
import {
  canStartProjectMixdown,
  createClipFilerProjectMixdownOwner,
  createMixerProjectMixdownControlModel,
  isProjectMixdownOperationActive,
  isProjectMixdownOwner,
  isProjectMixdownRuntimeActive,
  MIXER_PROJECT_MIXDOWN_OWNER,
  resolveProjectMixdownStartEntry,
  type ProjectMixdownOwner,
  type ProjectMixdownUiState,
} from './projectMixdownUiState';
import {
  recoverProjectMixdownRequest,
  runProjectMixdownRequest,
  type ProjectMixdownRunnerCommand,
  type ProjectMixdownRunnerResult,
  type ProjectMixdownUnknownResult,
} from './projectMixdownRunner';
import { prepareProjectStemPrint } from './projectStemPrintPreparation';
import {
  createProjectStemPrintTargetKey,
  listProjectStemPrintTargetOptions,
  resolveProjectStemPrintSelection,
  toggleProjectStemPrintTarget,
} from './projectStemPrintSelection';
import type { ProjectStemPrintTarget } from './projectStemPrintPlan';
import {
  createMixerProjectStemPrintControlModel,
  isProjectStemPrintOperationActive,
  type ProjectStemPrintUiState,
} from './projectStemPrintUiState';
import {
  recoverProjectStemPrintRequest,
  runProjectStemPrintRequest,
  type ProjectStemPrintRunnerCommand,
  type ProjectStemPrintRunnerResult,
  type ProjectStemPrintUnknownResult,
} from './projectStemPrintRunner';
import {
  createAudioClipLeftTrimUpdate,
  createAudioClipRightTrimUpdate,
} from './audioClipTrim';
import {
  canPreviewMidiClipRightResize,
  createMidiClipRightResizeUpdate,
  isMidiClip,
  resolveMidiClipRightResizeSafety,
} from './midiClipResize';
import { createProjectAudioClipSplitUpdate } from './audioClipSplit';
import { isSourceBackedAudioClip } from './audioClipSource';
import {
  createProjectSoundFontAssignment,
  normalizeSoundFontAssignment,
  updateMidiClipSoundFontAssignment,
} from './soundFontAssignment';
import { resolveGroupPlaybackTrack } from './playbackTarget';
import {
  migrateLegacyTimelinePatchTabs,
  migratePatchTabRoutingContracts,
} from './patchTabFlowMigration';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getConnectionCompatibility,
  getDefaultInputPort,
  getDefaultOutputPort,
  getPatchTabConnectionCompatibility,
  getPatchTabDefinition,
  getPatchTabInputOptions,
  getPatchTabOutputOptions,
  migratePatchTabContract,
} from './patchTabPortContract';
import {
  createRandomStableAudio3Seed,
  STABLE_AUDIO_3_MAX_TAKES,
  STABLE_AUDIO_3_MIN_TAKES,
} from './stableAudio3SeedVariations';
import { synchronizePatchTabConnectionBindings } from './patchTabInputBindings';
import {
  getEnabledTabFlowFamilyCount,
  createTabFlowFamiliesFromConnections,
  getTabFlowFamilyPreflight,
  getTabFlowFamilyLines,
  getTabFlowFamilyRoot,
  getTabFlowLaneViews,
  getTabFlowStructureState,
  normalizeTabFlowFamilies,
  placeConnectionInTabFlowFamily,
  setTabFlowFamilyEnabled,
} from './tabFlowFamilies';
import { resolveAutoPatchTargetClipIds } from './autoPatchTargetResolution';
import type {
  AutoPatchDriverIdentityKind,
  AutoPatchDriverIdentityServices,
} from './autoPatchDriverIdentity';
import {
  createAutoPatchProductionDriverClient,
  runAutoPatchProductionDriver,
} from './autoPatchProductionDriver';
import {
  prepareAutoPatchProductionProgressEnvelope,
  prepareAutoPatchProductionResultEnvelope,
} from './autoPatchProductionEnvelope';
import {
  prepareAutoPatchProductionPersistence,
} from './autoPatchProductionPersistence';
import {
  prepareAutoPatchProductionRun,
} from './autoPatchProductionPreparation';
import {
  isAutoPatchProductionRunHistoryEntry,
  writeAutoPatchRunHistory,
} from './autoPatchRunHistory';
import {
  createAutoPatchProductionUiStateFromEnvelope,
  createBlockedAutoPatchProductionUiState,
  createFailedAutoPatchProductionUiState,
  createIdleAutoPatchProductionUiState,
  createPreparingAutoPatchProductionUiState,
  getAutoPatchProductionUiPresentation,
  isAutoPatchProductionUiActive,
  requestAutoPatchProductionCancellation,
  type AutoPatchProductionUiState,
} from './autoPatchProductionUiState';
import {
  createGenerationHeaderProgress,
  createProductionHeaderProgress,
  type GenerationHeaderProgress,
} from './generationHeaderProgress';
import {
  useGenerationActivityLiveness,
  type GenerationActivityDescriptor,
} from './generationActivityClock';
import {
  resolveTabFlowEngineAvailability,
} from './tabFlowEngineAvailability';
import {
  resolveOneShotGenerationFamily,
  runOneShotGeneration,
} from './oneShotGeneration';
import { normalizeTabFlowStageResultIndex } from './tabFlowStageResultIndex';
import {
  beatsToTicks,
  clampTick,
  createDummyInstrumentRender,
  createRecordingSession,
  formatParameterSnapshotBadge,
  DEFAULT_TIMELINE_GRID_RESOLUTION,
  getTimelineGridResolutionTickStep,
  isTimelineGridResolution,
  isInstrumentPatchTab,
  resolveTimelineTick,
  ticksToBeats,
  TICKS_PER_BEAT,
  timelineGridResolutions,
} from './workflow';
import type { RecordingSession } from './workflow';

type TransportButton = 'REC' | 'PLAY' | 'STOP' | 'LOOP' | 'EXPORT';
type TimelineTransportControl = TransportButton | 'IMPORT';
type TransientButtonFeedback = 'idle' | 'success' | 'error';
type RecordingRuntimePhase =
  | 'IDLE'
  | 'PREPARING'
  | 'COUNT_IN'
  | 'RECORDING'
  | 'SAVING';
type PatchTabParameterValue = string | number;
type PatchPortDirection = 'input' | 'output';
type SelectionMode = 'replace' | 'toggle' | 'range';
type TabFlowConnectionState = 'enabled' | 'disabled' | 'invalid';
type AutoPatchEligibilityStatus = 'ready' | 'applied' | 'disabled' | 'invalid';
type ProjectPlayheadChangeOptions = {
  snapToGrid?: boolean;
};
type ProjectSourceFileLoadMode = 'preserve' | 'json-reload';
type ReadyProjectRoot = Extract<LocalEngineProjectRoot, { status: 'READY' }>;
type ProjectRootUiState =
  | Readonly<{ status: 'UNAVAILABLE' | 'LOADING' | 'SELECTING' | 'UNSET' }>
  | Readonly<{ message: string; status: 'ERROR' }>
  | Readonly<{ projectRoot: ReadyProjectRoot; status: 'READY' }>;
type ProjectFileSaveUiState =
  | Readonly<{ status: 'IDLE' | 'SAVING' }>
  | Readonly<{ savedProject: LocalEngineProjectFileSave; status: 'SAVED' }>
  | Readonly<{ message: string; status: 'ERROR' }>;
type InstrumentRenderUiState = Readonly<{
  jobId?: string;
  message?: string;
  status: 'IDLE' | 'ENQUEUEING' | 'REGISTERED' | 'ERROR' | LocalEngineGpuJobState;
}>;
type StableAudio3TextToAudioUiState = Readonly<{
  jobProgress?: LocalEngineGpuJobProgress;
  jobId?: string;
  message?: string;
  patchTabId?: string;
  takeCount?: number;
  takeNumber?: number;
  status: 'IDLE' | 'ENQUEUEING' | 'ERROR' | LocalEngineGpuJobState;
}>;
type AceStepTextToMusicUiState = StableAudio3TextToAudioUiState;
type AceStepCoverUiState = StableAudio3TextToAudioUiState;
type AceStepUiState = AceStepVocalUiState;
type InstrumentAudioPreviewUiState = Readonly<{
  artifactId?: string;
  clipTakeId?: string;
  message?: string;
  status: 'IDLE' | 'LOADING' | 'PLAYING' | 'ERROR';
  targetClipId?: string;
  targetClipName?: string;
}>;
type ProjectNormalizeOptions = {
  sourceFileLoadMode?: ProjectSourceFileLoadMode;
};
type ActiveAudioPlaybackPlan =
  | { kind: 'clip'; plan: AudioClipPlaybackPlan }
  | { kind: 'project'; plan: ProjectPlaybackPlan };
type TimelineSettingRangeWarning = {
  clampedValue: number;
  label: string;
  max: number;
  min: number;
  suffix?: string;
  value: number;
};

type TimelineStatusDiagnostic = {
  helpText: string;
  message: string;
  tone: 'warning' | 'error';
};

type TimelineStatusFeedback = {
  helpText: string;
  message: string;
  tone: 'error' | 'success' | 'warning';
};

type TimelineRevealRequest = {
  clipId: string;
  requestId: number;
};

function createGenerationActivityDescriptor(
  activityId: string,
  status: string,
  jobProgress?: LocalEngineGpuJobProgress,
  itemNumber?: number,
): GenerationActivityDescriptor {
  return Object.freeze({
    activityId,
    canBecomeStale: status === 'LOADING_MODEL' || status === 'PROCESSING',
    updateToken: JSON.stringify([
      status,
      itemNumber ?? 0,
      jobProgress?.updatedAt ?? '',
    ]),
  });
}

type TimelineClipMovePreview = {
  canMove: boolean;
  clipId: string;
  startTick: number;
};

type TimelineClipMoveCommitOptions = {
  snapToAdjacentOnOverlap?: boolean;
};

type TimelineClipMoveDragState = TimelineClipMovePreview & {
  clientX: number;
  didDrag: boolean;
  initialClientX: number;
  initialScrollLeft: number;
  initialStartTick: number;
  lengthTicks: number;
};

type TimelineClipRightTrimPreview = {
  canTrim: boolean;
  clipId: string;
  endTick: number;
  lengthTicks: number;
};

type TimelineClipRightTrimDragState = TimelineClipRightTrimPreview & {
  clientX: number;
  didDrag: boolean;
  initialClientX: number;
  initialEndTick: number;
  initialScrollLeft: number;
  minimumEndTick: number;
  operation: 'audio-trim' | 'midi-resize';
  startTick: number;
};

type TimelineClipLeftTrimPreview = {
  canTrim: boolean;
  clipId: string;
  lengthTicks: number;
  startTick: number;
};

type TimelineClipLeftTrimDragState = TimelineClipLeftTrimPreview & {
  clientX: number;
  didDrag: boolean;
  endTick: number;
  initialClientX: number;
  initialScrollLeft: number;
  initialStartTick: number;
};

const TIMELINE_BAR_PIXEL_WIDTH = 288;
const TIMELINE_BEATS_PER_BAR = 4;
const TIMELINE_PLAYBACK_FOLLOW_LEFT_RATIO = 0;
const TIMELINE_PLAYBACK_FOLLOW_RIGHT_RATIO = 1;
const TIMELINE_PLAYBACK_FOLLOW_TARGET_RATIO = 0;
const MIN_TIMELINE_BARS = 8;
const MAX_TIMELINE_BARS = 512;
const MAX_TAKE_HISTORY_ENTRIES = 50;
const ROUTE_LINE_REQUIRED_HELP_MESSAGE = 'Create a TabFlow Line with + before routing.';
const AUDIO_IMPORT_DURATION_TIMEOUT_MS = 8000;
const AUDIO_RELINK_DURATION_TOLERANCE_SECONDS = 0.25;

type RoutingFlowRow = {
  line: TabFlowLine;
  rootLine: TabFlowLine;
  connections: TabFlowConnection[];
  displayLabel: string;
  isChild: boolean;
  startIndex: number;
};

type ConnectionDeletionImpact = {
  lineOrder?: number;
  removedConnections: TabFlowConnection[];
  downstreamCount: number;
};

type AutoPatchEligibility = {
  line: TabFlowLine;
  status: AutoPatchEligibilityStatus;
  reason: string;
};

type AutoPatchTargetEligibility = AutoPatchEligibility & {
  clip: Clip;
  track: Track;
};

type AutoPatchHistoryEntry = {
  clipId: string;
  clipName: string;
  trackId: string;
  trackName: string;
  lineOrder?: number;
  lineEnabled?: boolean;
  application: ClipTabFlowApplication;
};

type EditHistoryItem = {
  canJump: boolean;
  category: SessionEditCategory;
  createdAt: string;
  id: string;
  index: number;
  irreversible: boolean;
  isCurrent: boolean;
  isFuture: boolean;
  label: string;
};

type PatchPortSelection = {
  patchTabId: string;
  direction: PatchPortDirection;
  portId?: string;
};

type SelectedClipInfo = {
  clip: Clip;
  track: Track;
};

type WorkspaceState = {
  project: ProjectState;
  selectedPatchTabId: string;
  selectedTabFlowLineId: string;
  activeTransport: TransportButton;
  selectedClipId: string;
  selectedConnectionId: string;
  pendingPortSelection?: PatchPortSelection;
  recordingSession?: RecordingSession;
};

type WorkspaceHistory = SessionEditHistory<WorkspaceState>;

type WorkspaceEditDraft = Readonly<{
  allowDuringPunchSession?: boolean;
  category: SessionEditCategory;
  irreversible?: boolean;
  label: string;
}>;

const patchTabHistoryEditDraft: WorkspaceEditDraft = Object.freeze({
  category: 'routing',
  label: 'Edit PatchTabs',
});

type WorkspaceReplacementOptions = {
  historyLabel?: string;
  reconnectSessionAudioSources?: boolean;
};

type WorkspaceReplacementResult = {
  workspace: WorkspaceState;
  reconnectedSourceCount: number;
};

type DirtyState = 'saved' | 'unsaved' | 'warning' | 'error';

type RoutingIssue = {
  id: string;
  fromName: string;
  toName: string;
  outputType: string;
  inputType: string;
};

type SourceFileIssue = {
  id: string;
  clipId: string;
  clipName: string;
  fileName: string;
  path?: string;
  restorationAuthority: 'project-root' | 'session-file';
  status: ClipSourceFileStatus;
  trackId: string;
  trackName: string;
};

type ProjectHealth = {
  artifactCount: number;
  clipTakeCount: number;
  dirtyState: DirtyState;
  hasUnsavedChanges: boolean;
  patchTabCount: number;
  routingCount: number;
  routingErrorCount: number;
  sourceErrorCount: number;
  sourceIssueCount: number;
  sourceWarningCount: number;
  clipCount: number;
  runHistoryCount: number;
  selectedPatchTabName: string;
  selectedRoutingName: string;
  selectedClipName: string;
  routingIssues: RoutingIssue[];
  sourceIssues: SourceFileIssue[];
};

type ClipLineageEntry = {
  clipId: string;
  name: string;
  type: ClipType | 'missing';
  trackName: string;
  details: string[];
  isCurrent: boolean;
  isMissing: boolean;
};

type TooltipPlacement = 'top' | 'bottom';

type TooltipState = {
  text: string;
  left: number;
  top: number;
  placement: TooltipPlacement;
};

type SafetyConfirmRequest = {
  id: string;
  title: string;
  message: string;
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
};

type SafetyConfirmDraft = Omit<SafetyConfirmRequest, 'id'>;

type HumStudioProjectFile = {
  app: 'HumSTUDIO';
  version: string;
  savedAt: string;
  workspace: WorkspaceState;
};

const transportButtons: TransportButton[] = ['REC', 'PLAY', 'STOP', 'LOOP', 'EXPORT'];
const timelineTransportControls: TimelineTransportControl[] = ['REC', 'PLAY', 'STOP', 'LOOP', 'IMPORT', 'EXPORT'];
const undoHistoryLimit = 80;
const humStudioProjectFileVersion = '0.1.0';
const browserSaveKey = 'humstudio.workspace.v1';
const headerHelpPreviewEventName = 'humstudio-help-preview';
const defaultHeaderHelpMessage = 'Select an item for help. Hover controls to preview actions.';
const keyRootOptions = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];
const keyModeOptions = ['major', 'minor'] as const;

type KeyMode = (typeof keyModeOptions)[number];

type ParsedProjectKey = {
  root: string;
  mode: KeyMode;
};

type TimelineClipClipboard = {
  sourceTrackId: string;
  sourceTrackName: string;
  sourceTrackType: Track['type'];
  startTick: number;
  clips: Clip[];
  copiedAt: string;
};

type TimelineClipCopyAvailability = {
  canCopy: boolean;
  message: string;
  sourceTrack?: Track;
  clipInfos: SelectedClipInfo[];
};

type TimelineClipPasteAvailability = {
  canPaste: boolean;
  message: string;
  targetTrack?: Track;
  startTick: number;
};

type TimelineClipSplitAvailability = {
  canSplit: boolean;
  message: string;
};

type AudioImportMetadata = {
  name: string;
  sourceId: string;
  mimeType?: string;
  sizeBytes: number;
  lastModified: number;
  durationSeconds: number;
};

type AudioImportWorkspaceUpdate =
  | {
      canImport: true;
      clip: Clip;
      extendedToBars?: number;
      track: Track;
      workspace: WorkspaceState;
    }
  | {
      canImport: false;
      reason: 'clip-overlap' | 'timeline-limit';
      message: string;
    };

type SourceRelinkWorkspaceUpdate =
  | {
      canRelink: true;
      clip: Clip;
      relinkedClipCount: number;
      track: Track;
      workspace: WorkspaceState;
    }
  | {
      canRelink: false;
      message: string;
    };

type TimelineContextMenuState = {
  x: number;
  y: number;
  targetTrackId?: string;
  targetClipId?: string;
};

type ClipTakeMenuState = {
  candidateClipTakeId: string;
  clipId: string;
  left: number;
  top: number;
};

type TopDockId = 'main' | 'piano-roll' | 'mixer';

type TopDockDefinition = {
  id: TopDockId;
  label: string;
  title: string;
  help: string;
};

const patchTabTemplates = createPatchTabTemplateCatalog(
  createDefaultPatchTabs(),
);
const topDockDefinitions: TopDockDefinition[] = [
  {
    id: 'main',
    label: 'DOCK 01 MAIN',
    title: 'Main Dock',
    help: 'Main Dock keeps Module Rack, PatchTab Editor, and Routing together with independent scrolling.',
  },
  {
    id: 'piano-roll',
    label: 'DOCK 02 PIANO',
    title: 'Piano Roll',
    help: 'Piano Roll Dock is ready for note editing tools. The dock remains loaded after it is opened.',
  },
  {
    id: 'mixer',
    label: 'DOCK 03 MIXER',
    title: 'Mixer',
    help: 'Mixer Dock is ready for channel, level, pan, and routing controls. The dock remains loaded after it is opened.',
  },
];
const initialWorkspaceState = createInitialWorkspaceState();

export default function App({ engineBootstrap }: { engineBootstrap?: LocalEngineBootstrap }) {
  const [engineConnection, setEngineConnection] = useState(() =>
    createInitialLocalEngineConnectionState(Boolean(engineBootstrap)),
  );
  const [projectRootState, setProjectRootState] = useState<ProjectRootUiState>({
    status: 'UNAVAILABLE',
  });
  const [soundFontCatalogState, setSoundFontCatalogState] =
    useState<PianoRollSoundFontCatalogState>({ status: 'UNAVAILABLE' });
  const [soundFontAuditionState, setSoundFontAuditionState] =
    useState<PianoRollSoundFontAuditionState>({ status: 'IDLE' });
  const [pianoRollLiveNotePreviewState, setPianoRollLiveNotePreviewState] =
    useState<PianoRollLiveNotePreviewState>({ status: 'IDLE' });
  const [projectFileSaveState, setProjectFileSaveState] = useState<ProjectFileSaveUiState>({
    status: 'IDLE',
  });
  const [isProjectRootProjectOpenInProgress, setIsProjectRootProjectOpenInProgress] =
    useState(false);
  const [instrumentRenderState, setInstrumentRenderState] =
    useState<InstrumentRenderUiState>({ status: 'IDLE' });
  const [stableAudio3TextToAudioState, setStableAudio3TextToAudioState] =
    useState<StableAudio3TextToAudioUiState>({ status: 'IDLE' });
  const [aceStepTextToMusicState, setAceStepTextToMusicState] =
    useState<AceStepTextToMusicUiState>({ status: 'IDLE' });
  const [aceStepCoverState, setAceStepCoverState] =
    useState<AceStepCoverUiState>({ status: 'IDLE' });
  const [aceStepState, setAceStepState] =
    useState<AceStepUiState>({ status: 'IDLE' });
  const [projectMixdownState, setProjectMixdownState] =
    useState<ProjectMixdownUiState>({ status: 'IDLE' });
  const [projectStemPrintState, setProjectStemPrintState] =
    useState<ProjectStemPrintUiState>({ status: 'IDLE' });
  const [printMixState, setPrintMixState] = useState<PrintMixUiState>(() =>
    createInitialPrintMixUiState(),
  );
  const [basicPitchHumToMidiState, setBasicPitchHumToMidiState] =
    useState<BasicPitchHumToMidiUiState>(() =>
      createInitialBasicPitchHumToMidiUiState(),
    );
  const [basicPitchRuntimeState, setBasicPitchRuntimeState] =
    useState<BasicPitchRuntimeUiState>({
      message: 'Start Local Engine to inspect the Basic Pitch Runtime.',
      status: 'UNAVAILABLE',
    });
  const [projectStemPrintTargets, setProjectStemPrintTargets] = useState<
    readonly ProjectStemPrintTarget[]
  >([]);
  const [instrumentAudioPreviewState, setInstrumentAudioPreviewState] =
    useState<InstrumentAudioPreviewUiState>({ status: 'IDLE' });
  const [autoPatchProductionState, setAutoPatchProductionState] =
    useState<AutoPatchProductionUiState>(() =>
      createIdleAutoPatchProductionUiState(),
    );
  const [history, setHistory] = useState<WorkspaceHistory>(() => ({
    ...createSessionEditHistory(initialWorkspaceState, {
      category: 'system',
      createdAt: new Date().toISOString(),
      id: 'session-open',
      label: 'Open Project',
    }),
  }));
  const [savedProjectFingerprint, setSavedProjectFingerprint] = useState(() =>
    createDirtyStateFingerprint(initialWorkspaceState.project),
  );
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isFinalFilerOpen, setIsFinalFilerOpen] = useState(false);
  const [isFinalFilerBusy, setIsFinalFilerBusy] = useState(false);
  const [finalFilerFileName, setFinalFilerFileName] = useState('');
  const [finalFilerIncludeSourceReport, setFinalFilerIncludeSourceReport] =
    useState(true);
  const [finalFilerResult, setFinalFilerResult] =
    useState<FinalFilerControllerResult>();
  const [finalFilerEditingTargetKey, setFinalFilerEditingTargetKey] =
    useState('unavailable');
  const [isProjectInspectorOpen, setIsProjectInspectorOpen] = useState(false);
  const [isTakeHistoryOpen, setIsTakeHistoryOpen] = useState(false);
  const [isPresetDrawerOpen, setIsPresetDrawerOpen] = useState(false);
  const [isSafetyModeEnabled, setIsSafetyModeEnabled] = useState(true);
  const [isTimelineExpanded, setIsTimelineExpanded] = useState(false);
  const [isTimelineExpandPending, setIsTimelineExpandPending] = useState(false);
  const [isClipTakeFileDeletionInProgress, setIsClipTakeFileDeletionInProgress] =
    useState(false);
  const [activeTopDockId, setActiveTopDockId] = useState<TopDockId>('main');
  const [loadedTopDockIds, setLoadedTopDockIds] = useState<ReadonlySet<TopDockId>>(
    () => new Set<TopDockId>(['main']),
  );
  const [timelineClipClipboard, setTimelineClipClipboard] = useState<TimelineClipClipboard>();
  const [safetyConfirmRequest, setSafetyConfirmRequest] = useState<SafetyConfirmRequest>();
  const [importError, setImportError] = useState<string>();
  const [timelineStatusFeedback, setTimelineStatusFeedback] = useState<TimelineStatusFeedback>();
  const [isTimelineExportPreparing, setIsTimelineExportPreparing] = useState(false);
  const [timelineRevealRequest, setTimelineRevealRequest] = useState<TimelineRevealRequest>();
  const [headerHelpMessage, setHeaderHelpMessage] = useState(defaultHeaderHelpMessage);
  const [microphoneInputLevel, setMicrophoneInputLevel] = useState(0);
  const [recordingRuntimePhase, setRecordingRuntimePhase] =
    useState<RecordingRuntimePhase>('IDLE');
  const [punchInTick, setPunchInTick] = useState<number>();
  const [punchOutTick, setPunchOutTick] = useState<number>();
  const [punchSession, setPunchSession] = useState<PunchSession>();
  const projectPlaybackMeterStoreRef = useRef<ProjectPlaybackMeterStore | null>(null);
  if (projectPlaybackMeterStoreRef.current === null) {
    projectPlaybackMeterStoreRef.current = createProjectPlaybackMeterStore();
  }
  const projectPlaybackMeterStore = projectPlaybackMeterStoreRef.current;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const sourceRelinkInputRef = useRef<HTMLInputElement>(null);
  const sessionAudioSourcesRef = useRef(new SessionAudioSourceRegistry());
  const audioClipPlaybackRuntimeRef = useRef(new AudioClipPlaybackRuntime());
  const instrumentAudioPreviewRuntimeRef = useRef(new InstrumentAudioPreviewRuntime());
  const soundFontAuditionRuntimeRef = useRef(new InstrumentAudioPreviewRuntime());
  const pianoRollLiveNotePreviewRuntimeRef = useRef(
    new PianoRollLiveNotePreviewRuntime(),
  );
  const projectPlaybackRuntimeRef = useRef(new ProjectPlaybackRuntime());
  const midiClipPlaybackCacheRef = useRef(new MidiClipPlaybackCache());
  const soundFontCatalogStateRef = useRef(soundFontCatalogState);
  soundFontCatalogStateRef.current = soundFontCatalogState;
  const metronomeRuntimeRef = useRef(new MetronomeRuntime());
  const microphoneRecordingRuntimeRef = useRef(new MicrophoneRecordingRuntime());
  const timelineExportUiControllerRef = useRef(new TimelineExportUiController());
  const finalFilerControllerRef = useRef(new FinalFilerController());
  const finalFilerPanelSessionRef = useRef(0);
  const printMixUiControllerRef = useRef(new PrintMixUiController());
  const basicPitchHumToMidiUiControllerRef = useRef(
    new BasicPitchHumToMidiUiController(),
  );
  const basicPitchRuntimeStateRef = useRef(basicPitchRuntimeState);
  basicPitchRuntimeStateRef.current = basicPitchRuntimeState;
  const recordingRuntimePhaseRef = useRef<RecordingRuntimePhase>('IDLE');
  const punchSessionRef = useRef<PunchSession>();
  punchSessionRef.current = punchSession;
  const activeRecordingModeRef = useRef<'normal' | 'punch'>('normal');
  const punchRecordingStartTickRef = useRef<number>();
  const punchRecordingAutoStopRef = useRef(false);
  const recordingOperationIdRef = useRef(0);
  const timelineTransportRequestIdRef = useRef(0);
  const recordingBoundaryTimerRef = useRef<number>();
  const recordingAutoStopReasonRef = useRef<'next-clip' | 'timeline-end'>();
  const stopRecordingRequestRef = useRef<() => void>(() => undefined);
  const stopPunchRecordingRequestRef = useRef<() => void>(() => undefined);
  const pendingSourceRelinkClipIdRef = useRef<string | undefined>(undefined);
  const localEngineClientRef = useRef<LocalEngineClient>();
  const loadedProjectRootInstanceIdRef = useRef<string>();
  const productionEditorRef = useRef<HTMLElement>(null);
  const topDockViewportRef = useRef<HTMLDivElement>(null);
  const timelineExpandTransitionRef = useRef<TimelineExpandTransitionCoordinator>();
  const timelineFlipTransitionRef =
    useRef<TimelineFlipTransitionCoordinator<HTMLElement>>();
  const timelineFlipBeforeTopRef = useRef<number>();
  const topDockScrollMemoryRef = useRef(createStudioDockScrollMemory<TopDockId>());
  const timelinePageAnchorRef = useRef<HTMLElement>(null);
  const authorizedProjectRootPathRef = useRef<string>();
  const projectFileSaveRequestIdRef = useRef(0);
  const projectRootProjectOpenRequestIdRef = useRef(0);
  const projectRootRequestIdRef = useRef(0);
  const clipTakeActivationRequestIdRef = useRef(0);
  const basicPitchRuntimeRequestIdRef = useRef(0);
  const soundFontCatalogRequestIdRef = useRef(0);
  const soundFontPresetCatalogCacheRef = useRef(
    new Map<string, Promise<LocalEngineSoundFontPresetCatalogResult>>(),
  );
  const soundFontAuditionAbortControllerRef = useRef<AbortController>();
  const soundFontAuditionOperationIdRef = useRef(0);
  const midiClipPlaybackPreparationAbortControllerRef = useRef<AbortController>();
  const midiClipPlaybackPreparationOperationIdRef = useRef(0);
  const instrumentRenderRequestIdRef = useRef(0);
  const instrumentRenderInProgressRef = useRef(false);
  const stableAudio3TextToAudioAbortControllerRef = useRef<AbortController>();
  const stableAudio3TextToAudioInProgressRef = useRef(false);
  const stableAudio3TextToAudioRequestIdRef = useRef(0);
  const aceStepTextToMusicAbortControllerRef = useRef<AbortController>();
  const aceStepTextToMusicInProgressRef = useRef(false);
  const aceStepTextToMusicRequestIdRef = useRef(0);
  const aceStepCoverAbortControllerRef = useRef<AbortController>();
  const aceStepCoverInProgressRef = useRef(false);
  const aceStepCoverRequestIdRef = useRef(0);
  const aceStepInProgressRef = useRef(false);
  const aceStepOperationRef = useRef<{
    abortController: AbortController;
    jobId?: string;
    jobState?: LocalEngineGpuJobState;
    patchTabId: string;
    requestId: number;
  }>();
  const aceStepRequestIdRef = useRef(0);
  const projectMixdownAbortControllerRef = useRef<AbortController>();
  const projectMixdownCommandRef = useRef<ProjectMixdownRunnerCommand>();
  const projectMixdownInProgressRef = useRef(false);
  const projectMixdownRequestIdRef = useRef(0);
  const projectMixdownUnknownResultRef = useRef<ProjectMixdownUnknownResult>();
  const projectStemPrintAbortControllerRef = useRef<AbortController>();
  const projectStemPrintCommandRef = useRef<ProjectStemPrintRunnerCommand>();
  const projectStemPrintInProgressRef = useRef(false);
  const projectStemPrintRequestIdRef = useRef(0);
  const projectStemPrintUnknownResultRef = useRef<ProjectStemPrintUnknownResult>();
  const instrumentAudioPreviewOperationIdRef = useRef(0);
  const autoPatchProductionAbortControllerRef = useRef<AbortController>();
  const autoPatchProductionInProgressRef = useRef(false);
  const autoPatchProductionRequestIdRef = useRef(0);
  const clipTakeFileDeletionInProgressRef = useRef(false);
  const timelineStatusFeedbackTimeoutRef = useRef<number>();
  const workspaceEditSequenceRef = useRef(0);
  const updateRecordingRuntimePhase = useCallback((phase: RecordingRuntimePhase) => {
    recordingRuntimePhaseRef.current = phase;
    setRecordingRuntimePhase(phase);
  }, []);
  const clearRecordingBoundaryTimer = useCallback(() => {
    if (recordingBoundaryTimerRef.current !== undefined) {
      window.clearTimeout(recordingBoundaryTimerRef.current);
      recordingBoundaryTimerRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    const scrollCoordinator = createTimelineExpandTransitionCoordinator(
      createBrowserTimelineExpandTransitionEnvironment(window),
    );
    const flipCoordinator = createTimelineFlipTransitionCoordinator(
      createBrowserTimelineFlipTransitionEnvironment(window),
    );
    timelineExpandTransitionRef.current = scrollCoordinator;
    timelineFlipTransitionRef.current = flipCoordinator;

    return () => {
      scrollCoordinator.cancel();
      flipCoordinator.cancel();
      if (timelineExpandTransitionRef.current === scrollCoordinator) {
        timelineExpandTransitionRef.current = undefined;
      }
      if (timelineFlipTransitionRef.current === flipCoordinator) {
        timelineFlipTransitionRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    if (!engineBootstrap) {
      return;
    }

    let client: LocalEngineClient;

    try {
      client = new LocalEngineClient(engineBootstrap);
      localEngineClientRef.current = client;
    } catch (error) {
      setEngineConnection(
        createLocalEngineConfigurationError(
          error instanceof Error ? error.message : 'Local Engine configuration is invalid.',
        ),
      );
      return;
    }

    let isDisposed = false;
    let isChecking = false;

    const checkHealth = async () => {
      if (isDisposed || isChecking) {
        return;
      }

      isChecking = true;

      try {
        const result = await client.checkHealth();

        if (!isDisposed) {
          setEngineConnection((previous) =>
            reduceLocalEngineHealthResult(previous, result, new Date().toISOString()),
          );
        }
      } finally {
        isChecking = false;
      }
    };

    void checkHealth();
    const heartbeatIntervalId = window.setInterval(
      () => void checkHealth(),
      LOCAL_ENGINE_HEARTBEAT_INTERVAL_MS,
    );

    return () => {
      isDisposed = true;
      window.clearInterval(heartbeatIntervalId);

      if (localEngineClientRef.current === client) {
        localEngineClientRef.current = undefined;
      }
    };
  }, [engineBootstrap]);

  useEffect(() => {
    const client = localEngineClientRef.current;
    const instanceId = engineConnection.instanceId;

    if (engineConnection.lifecycle !== 'READY' || !client || !instanceId) {
      loadedProjectRootInstanceIdRef.current = undefined;
      authorizedProjectRootPathRef.current = undefined;
      projectRootProjectOpenRequestIdRef.current += 1;
      setIsProjectRootProjectOpenInProgress(false);
      projectRootRequestIdRef.current += 1;
      setProjectRootState((currentState) =>
        currentState.status === 'UNAVAILABLE' ? currentState : { status: 'UNAVAILABLE' },
      );
      return;
    }

    if (loadedProjectRootInstanceIdRef.current === instanceId) {
      return;
    }

    loadedProjectRootInstanceIdRef.current = instanceId;
    authorizedProjectRootPathRef.current = undefined;
    projectRootProjectOpenRequestIdRef.current += 1;
    setIsProjectRootProjectOpenInProgress(false);
    const requestId = ++projectRootRequestIdRef.current;
    setProjectRootState({ status: 'LOADING' });

    void client.getProjectRoot().then((result) => {
      if (projectRootRequestIdRef.current !== requestId) {
        return;
      }

      setProjectRootState(
        result.ok
          ? createProjectRootUiState(result.projectRoot)
          : { message: result.message, status: 'ERROR' },
      );
    });
  }, [engineConnection.instanceId, engineConnection.lifecycle]);

  useEffect(() => {
    projectFileSaveRequestIdRef.current += 1;
    setProjectFileSaveState({ status: 'IDLE' });
  }, [engineConnection.instanceId, engineConnection.lifecycle]);

  useEffect(() => {
    const client = localEngineClientRef.current;

    if (engineConnection.lifecycle !== 'READY' || !client) {
      basicPitchRuntimeRequestIdRef.current += 1;
      setBasicPitchRuntimeState({
        message: 'Start Local Engine to inspect the Basic Pitch Runtime.',
        status: 'UNAVAILABLE',
      });
      return;
    }

    const requestId = ++basicPitchRuntimeRequestIdRef.current;
    setBasicPitchRuntimeState({ status: 'CHECKING' });

    void client.checkBasicPitchRuntime().then((result) => {
      if (basicPitchRuntimeRequestIdRef.current !== requestId) {
        return;
      }

      setBasicPitchRuntimeState(
        result.ok
          ? result.runtime.status === 'READY'
            ? { status: 'READY' }
            : { message: result.runtime.message, status: 'UNAVAILABLE' }
          : { message: result.message, status: 'UNAVAILABLE' },
      );
    });
  }, [engineConnection.instanceId, engineConnection.lifecycle]);

  useEffect(() => {
    soundFontCatalogRequestIdRef.current += 1;
    setSoundFontCatalogState({ status: 'UNAVAILABLE' });
  }, [
    engineConnection.instanceId,
    engineConnection.lifecycle,
    projectRootState.status === 'READY'
      ? projectRootState.projectRoot.rootPath
      : projectRootState.status,
  ]);

  useEffect(() => {
    instrumentRenderRequestIdRef.current += 1;
    instrumentRenderInProgressRef.current = false;
    stableAudio3TextToAudioAbortControllerRef.current?.abort();
    stableAudio3TextToAudioAbortControllerRef.current = undefined;
    stableAudio3TextToAudioRequestIdRef.current += 1;
    stableAudio3TextToAudioInProgressRef.current = false;
    aceStepTextToMusicAbortControllerRef.current?.abort();
    aceStepTextToMusicAbortControllerRef.current = undefined;
    aceStepTextToMusicRequestIdRef.current += 1;
    aceStepTextToMusicInProgressRef.current = false;
    aceStepCoverAbortControllerRef.current?.abort();
    aceStepCoverAbortControllerRef.current = undefined;
    aceStepCoverRequestIdRef.current += 1;
    aceStepCoverInProgressRef.current = false;
    aceStepOperationRef.current?.abortController.abort();
    aceStepOperationRef.current = undefined;
    aceStepRequestIdRef.current += 1;
    aceStepInProgressRef.current = false;
    projectMixdownAbortControllerRef.current?.abort();
    projectMixdownAbortControllerRef.current = undefined;
    projectMixdownCommandRef.current = undefined;
    projectMixdownInProgressRef.current = false;
    projectMixdownRequestIdRef.current += 1;
    projectMixdownUnknownResultRef.current = undefined;
    projectStemPrintAbortControllerRef.current?.abort();
    projectStemPrintAbortControllerRef.current = undefined;
    projectStemPrintCommandRef.current = undefined;
    projectStemPrintInProgressRef.current = false;
    projectStemPrintRequestIdRef.current += 1;
    projectStemPrintUnknownResultRef.current = undefined;
    setInstrumentRenderState({ status: 'IDLE' });
    setStableAudio3TextToAudioState({ status: 'IDLE' });
    setAceStepTextToMusicState({ status: 'IDLE' });
    setAceStepCoverState({ status: 'IDLE' });
    setAceStepState({ status: 'IDLE' });
    setProjectMixdownState({ status: 'IDLE' });
    setProjectStemPrintState({ status: 'IDLE' });
  }, [engineConnection.instanceId]);

  const workspace = history.present.value;
  const historyRef = useRef(history);
  historyRef.current = history;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const { project } = workspace;
  const audioPlaybackContentFingerprint = useMemo(
    () => createAudioPlaybackContentFingerprint(project.bpm, project.tracks),
    [project.bpm, project.tracks],
  );
  const finalFilerAvailability = useMemo(
    () => resolveFinalFilerAvailability(project),
    [project],
  );
  const finalFilerFileNameResolution = useMemo(
    () => resolveFinalFilerFileName(finalFilerFileName),
    [finalFilerFileName],
  );
  const finalFilerTargetKey = finalFilerAvailability.canExport
    ? [
        finalFilerAvailability.selectedClipId,
        finalFilerAvailability.target.target.artifactId,
        finalFilerAvailability.target.target.clipTakeId,
      ].join(':')
    : 'unavailable';
  const isProjectRootOverwriteProtected =
    projectRootState.status === 'READY' &&
    projectRootState.projectRoot.projectFile.status === 'EXISTS' &&
    authorizedProjectRootPathRef.current !== projectRootState.projectRoot.rootPath;
  const engineAvailability = useMemo(
    () => createLocalEngineAvailability(engineConnection),
    [engineConnection],
  );
  const engineAvailabilityRef = useRef(engineAvailability);
  engineAvailabilityRef.current = engineAvailability;
  const isAutoPatchProductionActive = isAutoPatchProductionUiActive(
    autoPatchProductionState,
  );
  const autoPatchHeaderProgress = createProductionHeaderProgress(
    autoPatchProductionState,
  );
  const aceStepTextToMusicHeaderProgress = createGenerationHeaderProgress({
      itemCount: aceStepTextToMusicState.takeCount,
      itemNumber: aceStepTextToMusicState.takeNumber,
      jobProgress: aceStepTextToMusicState.jobProgress,
      message: aceStepTextToMusicState.message,
      operationLabel: 'ACE T2M',
      status: aceStepTextToMusicState.status,
    });
  const aceStepCoverHeaderProgress = createGenerationHeaderProgress({
      itemCount: aceStepCoverState.takeCount,
      itemNumber: aceStepCoverState.takeNumber,
      jobProgress: aceStepCoverState.jobProgress,
      message: aceStepCoverState.message,
      operationLabel: 'ACE COVER',
      status: aceStepCoverState.status,
    });
  const aceStepVocalHeaderProgress = createGenerationHeaderProgress({
      jobProgress: aceStepState.jobProgress,
      message: aceStepState.message,
      operationLabel: 'ACE VOCALS',
      status: aceStepState.status,
    });
  const stableAudio3TextToAudioHeaderProgress = createGenerationHeaderProgress({
      itemCount: stableAudio3TextToAudioState.takeCount,
      itemNumber: stableAudio3TextToAudioState.takeNumber,
      jobProgress: stableAudio3TextToAudioState.jobProgress,
      message: stableAudio3TextToAudioState.message,
      operationLabel: 'SA3 T2A',
      status: stableAudio3TextToAudioState.status,
    });
  const headerGenerationActivity: GenerationActivityDescriptor | undefined =
    autoPatchHeaderProgress
      ? Object.freeze({
          activityId: 'AUTO PATCH',
          canBecomeStale:
            autoPatchProductionState.status === 'PREPARING' ||
            autoPatchProductionState.status === 'RUNNING',
          updateToken: JSON.stringify([
            autoPatchProductionState.status,
            autoPatchProductionState.activeStageId ?? '',
            autoPatchProductionState.completedStageCount,
            autoPatchProductionState.jobProgress?.updatedAt ?? '',
          ]),
        })
      : aceStepTextToMusicHeaderProgress
        ? createGenerationActivityDescriptor(
            'ACE T2M',
            aceStepTextToMusicState.status,
            aceStepTextToMusicState.jobProgress,
            aceStepTextToMusicState.takeNumber,
          )
        : aceStepCoverHeaderProgress
          ? createGenerationActivityDescriptor(
              'ACE COVER',
              aceStepCoverState.status,
              aceStepCoverState.jobProgress,
              aceStepCoverState.takeNumber,
            )
          : aceStepVocalHeaderProgress
            ? createGenerationActivityDescriptor(
                'ACE VOCALS',
                aceStepState.status,
                aceStepState.jobProgress,
              )
            : stableAudio3TextToAudioHeaderProgress
              ? createGenerationActivityDescriptor(
                  'SA3 T2A',
                  stableAudio3TextToAudioState.status,
                  stableAudio3TextToAudioState.jobProgress,
                  stableAudio3TextToAudioState.takeNumber,
                )
              : undefined;
  const headerGenerationLiveness = useGenerationActivityLiveness(
    headerGenerationActivity,
  );
  const headerGenerationProgress = autoPatchHeaderProgress
    ? createProductionHeaderProgress({
        ...autoPatchProductionState,
        liveness: headerGenerationLiveness,
      })
    : aceStepTextToMusicHeaderProgress
      ? createGenerationHeaderProgress({
          itemCount: aceStepTextToMusicState.takeCount,
          itemNumber: aceStepTextToMusicState.takeNumber,
          jobProgress: aceStepTextToMusicState.jobProgress,
          liveness: headerGenerationLiveness,
          message: aceStepTextToMusicState.message,
          operationLabel: 'ACE T2M',
          status: aceStepTextToMusicState.status,
        })
      : aceStepCoverHeaderProgress
        ? createGenerationHeaderProgress({
            itemCount: aceStepCoverState.takeCount,
            itemNumber: aceStepCoverState.takeNumber,
            jobProgress: aceStepCoverState.jobProgress,
            liveness: headerGenerationLiveness,
            message: aceStepCoverState.message,
            operationLabel: 'ACE COVER',
            status: aceStepCoverState.status,
          })
        : aceStepVocalHeaderProgress
          ? createGenerationHeaderProgress({
              jobProgress: aceStepState.jobProgress,
              liveness: headerGenerationLiveness,
              message: aceStepState.message,
              operationLabel: 'ACE VOCALS',
              status: aceStepState.status,
            })
          : stableAudio3TextToAudioHeaderProgress
            ? createGenerationHeaderProgress({
                itemCount: stableAudio3TextToAudioState.takeCount,
                itemNumber: stableAudio3TextToAudioState.takeNumber,
                jobProgress: stableAudio3TextToAudioState.jobProgress,
                liveness: headerGenerationLiveness,
                message: stableAudio3TextToAudioState.message,
                operationLabel: 'SA3 T2A',
                status: stableAudio3TextToAudioState.status,
              })
            : undefined;
  autoPatchProductionInProgressRef.current = isAutoPatchProductionActive;
  const isEngineProductionEditingLocked =
    engineAvailability.productionEditingLocked;
  const isProductionEditingLocked =
    isEngineProductionEditingLocked ||
    isAutoPatchProductionActive ||
    isClipTakeFileDeletionInProgress;
  const isHeaderEditingLocked =
    isProductionEditingLocked ||
    isStableAudio3TextToAudioUiActive(stableAudio3TextToAudioState);
  const mixerProjectMixdownControl = useMemo(
    () => createMixerProjectMixdownControlModel({
      engineAcceptsNewJobs: engineAvailability.acceptsNewJobs,
      engineAvailabilityMessage: engineAvailability.message,
      hasStemPrintLock:
        isProjectStemPrintOperationActive(projectStemPrintState) ||
        projectStemPrintState.status === 'OUTCOME_UNKNOWN',
      isProjectRootReady: projectRootState.status === 'READY',
      state: projectMixdownState,
    }),
    [
      engineAvailability,
      projectMixdownState,
      projectRootState.status,
      projectStemPrintState,
    ],
  );
  const projectStemPrintTargetCatalog = useMemo(
    () => listProjectStemPrintTargetOptions(project),
    [project],
  );
  const projectStemPrintSelection = useMemo(
    () => resolveProjectStemPrintSelection(project, projectStemPrintTargets),
    [project, projectStemPrintTargets],
  );
  useEffect(() => {
    if (
      isProjectStemPrintOperationActive(projectStemPrintState) ||
      projectStemPrintState.status === 'OUTCOME_UNKNOWN'
    ) {
      return;
    }

    setProjectStemPrintTargets((current) => {
      const availableKeys = new Set(
        projectStemPrintTargetCatalog.canList
          ? projectStemPrintTargetCatalog.options
              .filter((option) => option.canSelect)
              .map((option) => option.key)
          : [],
      );
      const retained = current.filter((target) =>
        availableKeys.has(createProjectStemPrintTargetKey(target)),
      );
      const resolution = resolveProjectStemPrintSelection(project, retained);
      if (!resolution.canResolve) {
        return [];
      }
      const unchanged =
        resolution.targets.length === current.length &&
        resolution.targets.every(
          (target, index) =>
            createProjectStemPrintTargetKey(target) ===
            createProjectStemPrintTargetKey(current[index]),
        );
      return unchanged ? current : [...resolution.targets];
    });
  }, [
    project,
    projectStemPrintState,
    projectStemPrintTargetCatalog,
  ]);
  const mixerProjectStemPrintControl = useMemo(
    () => createMixerProjectStemPrintControlModel({
      engineAcceptsNewJobs: engineAvailability.acceptsNewJobs,
      engineAvailabilityMessage: engineAvailability.message,
      hasRawMixdownLock:
        isProjectMixdownRuntimeActive(projectMixdownState) ||
        projectMixdownState.status === 'MIXDOWN_OUTCOME_UNKNOWN',
      hasSelection:
        projectStemPrintSelection.canResolve &&
        projectStemPrintSelection.targets.length > 0,
      isProjectRootReady: projectRootState.status === 'READY',
      state: projectStemPrintState,
    }),
    [
      engineAvailability,
      projectMixdownState,
      projectRootState.status,
      projectStemPrintSelection,
      projectStemPrintState,
    ],
  );
  const productionEditingLockMessage = isClipTakeFileDeletionInProgress
    ? 'Clip Take file deletion is active. Project editing unlocks when the transaction settles.'
    : isAutoPatchProductionActive
      ? autoPatchProductionState.message
      : engineAvailability.message;
  const retainedSessionAudioSourceIds = useMemo(
    () =>
      collectReferencedSessionAudioSourceIds([
        ...history.past.map((frame) => frame.value.project),
        project,
        ...history.future.map((frame) => frame.value.project),
      ]),
    [history.future, history.past, project],
  );
  const selectedPatchTab = useMemo(
    () => project.patchTabs.find((patchTab) => patchTab.id === workspace.selectedPatchTabId),
    [project.patchTabs, workspace.selectedPatchTabId],
  );
  const selectedPatchTabColor = selectedPatchTab ? getPatchTabColorCode(selectedPatchTab.colorIndex) : undefined;
  const selectedClipInfo = useMemo(
    () => findSelectedClip(project.tracks, workspace.selectedClipId),
    [project.tracks, workspace.selectedClipId],
  );
  const selectedMidiVoiceClipInfo = useMemo(
    () => selectedClipInfo ?? findSingleSelectedMidiClipInfo(project),
    [project, selectedClipInfo],
  );
  const selectedMidiNoteCount = useMemo(() => {
    if (
      selectedMidiVoiceClipInfo?.clip.type !== 'midi-notes' &&
      selectedMidiVoiceClipInfo?.clip.type !== 'edited-midi'
    ) {
      return undefined;
    }

    const resolution = resolveActiveMidiTake(
      project,
      selectedMidiVoiceClipInfo.clip.id,
    );
    return resolution.canResolve
      ? resolution.plan.midi.notes.length
      : undefined;
  }, [project, selectedMidiVoiceClipInfo]);
  const selectedPianoRollClipId = useMemo(() => {
    if (
      project.selection.items.length !== 1 ||
      project.selection.items[0].type !== 'clip'
    ) {
      return '';
    }

    const selectedClipId = project.selection.items[0].id;
    const selectedClip = project.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === selectedClipId);

    return selectedClip?.type === 'midi-notes' ||
      selectedClip?.type === 'edited-midi'
      ? selectedClip.id
      : '';
  }, [project.selection.items, project.tracks]);
  const projectHealth = useMemo(
    () =>
      createProjectHealth(
        project,
        workspace.selectedPatchTabId,
        workspace.selectedConnectionId,
        selectedClipInfo,
        savedProjectFingerprint,
      ),
    [project, savedProjectFingerprint, selectedClipInfo, workspace.selectedConnectionId, workspace.selectedPatchTabId],
  );
  const autoPatchHistoryEntries = useMemo(
    () => getAutoPatchHistoryEntries(project),
    [project],
  );
  const editHistoryItems = useMemo<EditHistoryItem[]>(() => {
    const currentIndex = history.past.length;

    return getSessionEditFrames(history)
      .map((frame, index) => ({
        canJump: canJumpToSessionEdit(history, index),
        category: frame.edit.category,
        createdAt: frame.edit.createdAt,
        id: frame.edit.id,
        index,
        irreversible: frame.edit.irreversible === true,
        isCurrent: index === currentIndex,
        isFuture: index > currentIndex,
        label: frame.edit.label,
      }))
      .filter((item) => item.category !== 'piano-roll');
  }, [history]);
  const timelineStatusDiagnostic = useMemo(() => createTimelineStatusDiagnostic(projectHealth), [projectHealth]);
  const trackGroupingAvailability = useMemo(
    () => resolveTrackGroupingPlan(project.tracks, project.selection),
    [project.selection, project.tracks],
  );
  const requestSafetyConfirm = useCallback((request: SafetyConfirmDraft) => {
    const currentAvailability = engineAvailabilityRef.current;

    if (currentAvailability.productionEditingLocked) {
      setHeaderHelpMessage(currentAvailability.message);
      return;
    }

    setSafetyConfirmRequest({
      ...request,
      id: `safety-confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
  }, []);
  const handleMixerEffectCommand = useCallback(
    (command: ProjectMixerEffectCommand): MixerEffectsEditorCommandOutcome => {
      const currentAvailability = engineAvailabilityRef.current;
      const blockedMessage = clipTakeFileDeletionInProgressRef.current
        ? 'Mixer Effect editing is locked during Clip Take file deletion.'
        : autoPatchProductionInProgressRef.current
          ? 'Mixer Effect editing is locked while Auto Patch production is active.'
          : stableAudio3TextToAudioInProgressRef.current ||
              aceStepTextToMusicInProgressRef.current ||
              aceStepCoverInProgressRef.current
            ? `Mixer Effect editing is locked while ${
                stableAudio3TextToAudioInProgressRef.current
                  ? 'SA3 T2A'
                  : aceStepCoverInProgressRef.current
                    ? 'ACE Cover'
                    : 'ACE T2M'
              } generation is active.`
            : currentAvailability.productionEditingLocked
              ? currentAvailability.message
              : undefined;

      if (blockedMessage) {
        setHeaderHelpMessage(blockedMessage);
        return Object.freeze({
          message: blockedMessage,
          status: 'BLOCKED' as const,
        });
      }

      workspaceEditSequenceRef.current += 1;
      const result = executeProjectMixerEffectCommand(
        historyRef.current,
        command,
        {
          createdAt: new Date().toISOString(),
          editId: `mixer-effect-${Date.now()}-${workspaceEditSequenceRef.current}`,
          historyLimit: undoHistoryLimit,
        },
      );
      const message =
        result.status === 'EXECUTED'
          ? `${result.edit.label}. Active playback keeps its frozen sound; the edit applies on the next playback operation.`
          : result.status === 'NO_OP'
            ? 'Mixer Effect is unchanged. No Undo step was created.'
            : result.message;

      if (result.history !== historyRef.current) {
        historyRef.current = result.history;
        setHistory(result.history);
      }

      setHeaderHelpMessage(message);
      return Object.freeze({ message, status: result.status });
    },
    [],
  );
  const handleRequestMixerEffectReset = useCallback(
    (command: ProjectMixerEffectCommand, description: string) => {
      requestSafetyConfirm({
        title: `Reset ${description}`,
        message: 'Reset this Insert to its exact versioned default and BYPASS state?',
        confirmLabel: 'RESET',
        details: ['One confirmed Reset creates one Undo step.'],
        onConfirm: () => {
          handleMixerEffectCommand(command);
        },
      });
    },
    [handleMixerEffectCommand, requestSafetyConfirm],
  );
  const clearSafetyConfirm = useCallback(() => {
    setSafetyConfirmRequest(undefined);
  }, []);
  const confirmSafetyAction = useCallback(() => {
    const currentAvailability = engineAvailabilityRef.current;

    if (currentAvailability.productionEditingLocked) {
      setSafetyConfirmRequest(undefined);
      setHeaderHelpMessage(currentAvailability.message);
      return;
    }

    const request = safetyConfirmRequest;

    setSafetyConfirmRequest(undefined);
    request?.onConfirm();
  }, [safetyConfirmRequest]);
  const showTimelineStatusFeedback = useCallback((feedback: TimelineStatusFeedback) => {
    setTimelineStatusFeedback(feedback);
    setHeaderHelpMessage(feedback.helpText);

    if (timelineStatusFeedbackTimeoutRef.current !== undefined) {
      window.clearTimeout(timelineStatusFeedbackTimeoutRef.current);
    }

    timelineStatusFeedbackTimeoutRef.current = window.setTimeout(() => {
      setTimelineStatusFeedback(undefined);
      timelineStatusFeedbackTimeoutRef.current = undefined;
    }, 3000);
  }, []);
  const showTimelineSettingRangeWarning = useCallback(
    ({ clampedValue, label, max, min, suffix, value }: TimelineSettingRangeWarning) => {
      const unit = suffix ? ` ${suffix}` : '';
      const helpText = `${label} accepts ${min}-${max}${unit}. ${value} was clamped to ${clampedValue}${unit}.`;

      showTimelineStatusFeedback({ helpText, message: 'RANGE LIMIT', tone: 'warning' });
    },
    [showTimelineStatusFeedback],
  );
  useEffect(() => {
    sessionAudioSourcesRef.current.retain(retainedSessionAudioSourceIds);
  }, [retainedSessionAudioSourceIds]);
  useEffect(() => {
    midiClipPlaybackCacheRef.current.prune(workspaceRef.current.project);
  }, [project.tracks]);

  const updateWorkspaceState = useCallback(
    (
      updater: (workspace: WorkspaceState) => WorkspaceState,
      editDraft?: WorkspaceEditDraft,
    ) => {
      const currentAvailability = engineAvailabilityRef.current;

      if (autoPatchProductionInProgressRef.current) {
        setHeaderHelpMessage(
          'Auto Patch production is active. Wait for the run to finish or cancel it from the status bar.',
        );
        return;
      }

      if (
        stableAudio3TextToAudioInProgressRef.current ||
        aceStepTextToMusicInProgressRef.current ||
        aceStepCoverInProgressRef.current
      ) {
        const generatorLabel = stableAudio3TextToAudioInProgressRef.current
          ? 'SA3 T2A'
          : aceStepCoverInProgressRef.current
            ? 'ACE Cover'
            : 'ACE T2M';
        setHeaderHelpMessage(
          `${generatorLabel} generation is active. Project edits unlock when the Job reaches a terminal state.`,
        );
        return;
      }

      if (currentAvailability.productionEditingLocked) {
        setHeaderHelpMessage(currentAvailability.message);
        return;
      }

      if (clipTakeFileDeletionInProgressRef.current) {
        setHeaderHelpMessage(
          'Wait for the active Clip Take file deletion transaction to finish.',
        );
        return;
      }

      if (
        (punchSessionRef.current?.attempts.length ?? 0) > 0 &&
        editDraft?.allowDuringPunchSession !== true
      ) {
        setHeaderHelpMessage(
          'Project editing is frozen while Punch Attempts are unresolved. KEEP or DISCARD the Punch Session first.',
        );
        return;
      }

      setHistory((currentHistory) => {
        if (clipTakeFileDeletionInProgressRef.current) {
          return currentHistory;
        }

        const currentWorkspace = currentHistory.present.value;
        const nextWorkspace = normalizeWorkspaceState(updater(currentWorkspace));

        if (
          createWorkspaceFingerprint(nextWorkspace) ===
          createWorkspaceFingerprint(currentWorkspace)
        ) {
          return currentHistory;
        }

        workspaceEditSequenceRef.current += 1;
        const resolvedEditDraft =
          editDraft ?? inferWorkspaceEditDraft(currentWorkspace, nextWorkspace);
        const {
          allowDuringPunchSession: _allowDuringPunchSession,
          ...sessionEditDraft
        } = resolvedEditDraft;
        const edit: SessionEditEntry = {
          ...sessionEditDraft,
          createdAt: new Date().toISOString(),
          id: `edit-${Date.now()}-${workspaceEditSequenceRef.current}`,
        };

        return commitSessionEdit(
          currentHistory,
          nextWorkspace,
          edit,
          undoHistoryLimit,
        );
      });
    },
    [],
  );

  const updateWorkspaceViewState = useCallback(
    (updater: (workspace: WorkspaceState) => WorkspaceState) => {
      if (clipTakeFileDeletionInProgressRef.current) {
        setHeaderHelpMessage(
          'Wait for the active Clip Take file deletion transaction to finish.',
        );
        return;
      }

      setHistory((currentHistory) =>
        clipTakeFileDeletionInProgressRef.current
          ? currentHistory
          : updateSessionEditPresent(currentHistory, (currentWorkspace) =>
              normalizeWorkspaceState(updater(currentWorkspace)),
            ),
      );
    },
    [],
  );

  const releaseInstrumentAudioPreview = useCallback(
    (): InstrumentAudioPreviewPlan | undefined => {
      instrumentAudioPreviewOperationIdRef.current += 1;
      return instrumentAudioPreviewRuntimeRef.current.stop();
    },
    [],
  );

  const stopInstrumentAudioPreview = useCallback(
    (showFeedback = true): boolean => {
      const previewPlan = releaseInstrumentAudioPreview();

      if (!previewPlan) {
        return false;
      }

      setInstrumentAudioPreviewState({
        artifactId: previewPlan.artifactId,
        clipTakeId: previewPlan.clipTakeId,
        message: `${previewPlan.clipName} preview stopped.`,
        status: 'IDLE',
        targetClipId: previewPlan.clipId,
        targetClipName: previewPlan.clipName,
      });

      if (showFeedback) {
        setHeaderHelpMessage(
          `${previewPlan.clipName} Take preview stopped. Project data was unchanged.`,
        );
      }

      return true;
    },
    [releaseInstrumentAudioPreview],
  );

  const releaseSoundFontAudition = useCallback(
    (): InstrumentAudioPreviewPlan | undefined => {
      soundFontAuditionOperationIdRef.current += 1;
      const abortController = soundFontAuditionAbortControllerRef.current;
      soundFontAuditionAbortControllerRef.current = undefined;
      abortController?.abort();
      return soundFontAuditionRuntimeRef.current.stop();
    },
    [],
  );

  const stopSoundFontAudition = useCallback(
    (showFeedback = true): boolean => {
      const hadPendingRequest =
        soundFontAuditionAbortControllerRef.current !== undefined;
      const auditionPlan = releaseSoundFontAudition();

      if (!hadPendingRequest && !auditionPlan) {
        return false;
      }

      setSoundFontAuditionState({ status: 'IDLE' });

      if (showFeedback) {
        setHeaderHelpMessage(
          `${auditionPlan?.clipName ?? 'SoundFont'} audition stopped. Project data was unchanged.`,
        );
      }

      return true;
    },
    [releaseSoundFontAudition],
  );

  const stopPianoRollLiveNotePreview = useCallback(
    async (): Promise<boolean> => {
      try {
        await pianoRollLiveNotePreviewRuntimeRef.current.stop(
          setPianoRollLiveNotePreviewState,
        );
        return true;
      } catch (error) {
        setPianoRollLiveNotePreviewState({
          message:
            error instanceof Error
              ? error.message
              : 'Note Preview could not stop cleanly.',
          status: 'ERROR',
        });
        return false;
      }
    },
    [],
  );

  const handlePreparePianoRollLiveNotePreview = useCallback(
    (selection: PianoRollLiveNotePreviewSelection) => {
      const client = localEngineClientRef.current;

      if (
        !client ||
        engineConnection.lifecycle !== 'READY' ||
        projectRootState.status !== 'READY'
      ) {
        setPianoRollLiveNotePreviewState({
          message: 'Start Local Engine and select Project Root for Note Preview.',
          status: 'ERROR',
        });
        return;
      }

      void pianoRollLiveNotePreviewRuntimeRef.current
        .prepare(client, selection, setPianoRollLiveNotePreviewState)
        .catch((error) => {
          setPianoRollLiveNotePreviewState({
            message:
              error instanceof Error
                ? error.message
                : 'Note Preview could not be prepared.',
            status: 'ERROR',
          });
        });
    },
    [engineConnection.lifecycle, projectRootState.status],
  );

  const handleTriggerPianoRollLiveNotePreview = useCallback(
    (pitch: number, velocity: number) => {
      void pianoRollLiveNotePreviewRuntimeRef.current
        .trigger(pitch, velocity, setPianoRollLiveNotePreviewState)
        .catch((error) => {
          setPianoRollLiveNotePreviewState({
            message:
              error instanceof Error
                ? error.message
                : 'Note Preview could not play the selected note.',
            status: 'ERROR',
          });
        });
    },
    [],
  );

  useEffect(() => {
    if (engineConnection.lifecycle !== 'READY') {
      void stopPianoRollLiveNotePreview();
    }
  }, [engineConnection.lifecycle, stopPianoRollLiveNotePreview]);

  useEffect(
    () => () => {
      void pianoRollLiveNotePreviewRuntimeRef.current.stop().catch(() => undefined);
    },
    [],
  );

  const releaseMidiClipPlaybackPreparation = useCallback((): boolean => {
    const abortController =
      midiClipPlaybackPreparationAbortControllerRef.current;

    if (!abortController) {
      return false;
    }

    midiClipPlaybackPreparationOperationIdRef.current += 1;
    midiClipPlaybackPreparationAbortControllerRef.current = undefined;
    abortController.abort();
    return true;
  }, []);

  const stopMidiClipPlaybackPreparation = useCallback(
    (showFeedback = true): boolean => {
      if (!releaseMidiClipPlaybackPreparation()) {
        return false;
      }

      if (showFeedback) {
        showTimelineStatusFeedback({
          helpText:
            'MIDI Clip SoundFont playback preparation was canceled. Project data was unchanged.',
          message: 'PLAYBACK PREPARATION STOPPED',
          tone: 'success',
        });
      }

      return true;
    },
    [releaseMidiClipPlaybackPreparation, showTimelineStatusFeedback],
  );

  const releaseActiveAudioPlayback = useCallback((): ActiveAudioPlaybackPlan | undefined => {
    projectPlaybackMeterStore.clear();
    const clipPlan = audioClipPlaybackRuntimeRef.current.stop();
    const projectPlan = projectPlaybackRuntimeRef.current.stop();

    if (clipPlan) {
      return { kind: 'clip', plan: clipPlan };
    }

    return projectPlan ? { kind: 'project', plan: projectPlan } : undefined;
  }, [projectPlaybackMeterStore]);

  const stopActiveAudioPlayback = useCallback(
    (showFeedback = true): boolean => {
      const playbackPlan = releaseActiveAudioPlayback();

      if (!playbackPlan) {
        return false;
      }

      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        activeTransport: 'STOP',
        project: {
          ...currentWorkspace.project,
          status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
        },
      }));

      if (showFeedback) {
        showTimelineStatusFeedback({
          helpText: `${
            playbackPlan.kind === 'clip' ? playbackPlan.plan.clip.name : 'Track'
          } playback stopped at the current Playhead position.`,
          message: 'PLAYBACK STOPPED',
          tone: 'success',
        });
      }

      return true;
    },
    [releaseActiveAudioPlayback, showTimelineStatusFeedback, updateWorkspaceViewState],
  );

  useEffect(() => {
    if (!engineAvailability.shouldInterruptRuntime) {
      return;
    }

    const interruptedMidiPreparation = releaseMidiClipPlaybackPreparation();
    const interruptedPlayback = releaseActiveAudioPlayback();
    const interruptedPreview = releaseInstrumentAudioPreview();
    const interruptedSoundFontAudition = releaseSoundFontAudition();
    const interruptedMetronome = metronomeRuntimeRef.current.stop();
    const interruptedRecording = recordingRuntimePhaseRef.current !== 'IDLE';
    clearRecordingBoundaryTimer();
    recordingAutoStopReasonRef.current = undefined;
    recordingOperationIdRef.current += 1;
    updateRecordingRuntimePhase('IDLE');
    setMicrophoneInputLevel(0);
    void microphoneRecordingRuntimeRef.current.cancel();
    const interruptedTransport = workspace.activeTransport !== 'STOP';

    if (interruptedPreview) {
      setInstrumentAudioPreviewState({ status: 'IDLE' });
    }

    if (interruptedSoundFontAudition) {
      setSoundFontAuditionState({ status: 'IDLE' });
    }

    if (interruptedPlayback || interruptedTransport || workspace.recordingSession) {
      setHistory((currentHistory) => {
        const currentWorkspace = currentHistory.present.value;
        const shouldResetProjectStatus =
          interruptedPlayback ||
          currentWorkspace.activeTransport !== 'STOP' ||
          Boolean(currentWorkspace.recordingSession);

        return updateSessionEditPresent(currentHistory, () =>
          normalizeWorkspaceState({
              ...currentWorkspace,
              activeTransport: 'STOP',
              recordingSession: undefined,
              project: shouldResetProjectStatus
                ? {
                    ...currentWorkspace.project,
                    status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
                  }
                : currentWorkspace.project,
            }),
        );
      });
    }

    if (
      interruptedPlayback ||
      interruptedMidiPreparation ||
      interruptedPreview ||
      interruptedSoundFontAudition ||
      interruptedMetronome ||
      interruptedRecording
    ) {
      setHeaderHelpMessage('Runtime stopped because the Local Engine connection was lost. Project data was preserved.');
    }
  }, [
    clearRecordingBoundaryTimer,
    engineAvailability.shouldInterruptRuntime,
    releaseActiveAudioPlayback,
    releaseInstrumentAudioPreview,
    releaseMidiClipPlaybackPreparation,
    releaseSoundFontAudition,
    updateRecordingRuntimePhase,
    workspace.activeTransport,
    workspace.recordingSession,
  ]);

  useEffect(() => {
    if (!isHeaderEditingLocked) {
      return;
    }

    setSafetyConfirmRequest(undefined);
    setIsPresetDrawerOpen(false);
    setIsProjectInspectorOpen(false);
    setIsTakeHistoryOpen(false);
  }, [isHeaderEditingLocked]);

  useEffect(() => {
    if (
      !isFinalFilerOpen ||
      isFinalFilerBusy ||
      finalFilerResult ||
      finalFilerEditingTargetKey === finalFilerTargetKey
    ) {
      return;
    }

    setFinalFilerEditingTargetKey(finalFilerTargetKey);
    setFinalFilerFileName(
      finalFilerAvailability.canExport ? finalFilerAvailability.fileName : '',
    );
  }, [
    finalFilerAvailability,
    finalFilerEditingTargetKey,
    finalFilerResult,
    finalFilerTargetKey,
    isFinalFilerBusy,
    isFinalFilerOpen,
  ]);

  useEffect(
    () => () => {
      finalFilerControllerRef.current.cancel();
    },
    [],
  );

  useEffect(() => {
    const productionEditor = productionEditorRef.current;

    if (!productionEditor) {
      return;
    }

    if (isProductionEditingLocked) {
      productionEditor.setAttribute('inert', '');
    } else {
      productionEditor.removeAttribute('inert');
    }
  }, [isProductionEditingLocked]);

  useLayoutEffect(() => {
    if (!isTimelineExpanded) {
      timelineFlipBeforeTopRef.current = undefined;
      timelineFlipTransitionRef.current?.cancel();
      return;
    }

    const beforeTop = timelineFlipBeforeTopRef.current;
    timelineFlipBeforeTopRef.current = undefined;
    const timeline = timelinePageAnchorRef.current;
    const coordinator = timelineFlipTransitionRef.current;

    if (beforeTop === undefined || !timeline || !coordinator) {
      setIsTimelineExpandPending(false);
      return;
    }

    coordinator.play(timeline, beforeTop, () => {
      setIsTimelineExpandPending(false);
    });

    return () => coordinator.cancel();
  }, [isTimelineExpanded]);

  const handleToggleTimelineExpanded = useCallback(() => {
    if (isTimelineExpandPending) {
      return;
    }

    if (isTimelineExpanded) {
      timelineExpandTransitionRef.current?.cancel();
      timelineFlipTransitionRef.current?.cancel();
      timelineFlipBeforeTopRef.current = undefined;
      setIsTimelineExpandPending(false);
      setIsTimelineExpanded(false);
      return;
    }

    const enterSplitWorkspace = () => {
      timelineFlipBeforeTopRef.current =
        timelinePageAnchorRef.current?.getBoundingClientRect().top;
      setIsTimelineExpanded(true);
    };

    const coordinator = timelineExpandTransitionRef.current;
    setIsTimelineExpandPending(true);

    if (!coordinator) {
      enterSplitWorkspace();
      return;
    }

    coordinator.request(enterSplitWorkspace);
  }, [isTimelineExpandPending, isTimelineExpanded]);

  useEffect(() => {
    const handleStudioPageNavigation = (event: KeyboardEvent) => {
      const destination = getStudioPageNavigationDestination(
        event,
        isTimelineExpanded || isTimelineExpandPending,
      );

      if (!destination) {
        return;
      }

      if (destination === 'page-top') {
        event.preventDefault();
        window.scrollTo({
          behavior: 'auto',
          left: window.scrollX,
          top: 0,
        });
        return;
      }

      const anchor = timelinePageAnchorRef.current;

      if (!anchor) {
        return;
      }

      event.preventDefault();
      window.scrollTo({
        behavior: 'auto',
        left: window.scrollX,
        top: getStudioPageNavigationScrollTop(anchor.getBoundingClientRect().top, window.scrollY),
      });
    };

    window.addEventListener('keydown', handleStudioPageNavigation);

    return () => window.removeEventListener('keydown', handleStudioPageNavigation);
  }, [isTimelineExpandPending, isTimelineExpanded]);

  const replaceWorkspaceState = useCallback(
    (
      workspaceState: WorkspaceState,
      options: WorkspaceReplacementOptions = {},
    ): WorkspaceReplacementResult => {
      const currentAvailability = engineAvailabilityRef.current;

      if (autoPatchProductionInProgressRef.current) {
        throw new Error(
          'Auto Patch production is active. Wait for the run to finish or cancel it from the status bar.',
        );
      }

      if (
        stableAudio3TextToAudioInProgressRef.current ||
        aceStepTextToMusicInProgressRef.current ||
        aceStepCoverInProgressRef.current
      ) {
        const generatorLabel = stableAudio3TextToAudioInProgressRef.current
          ? 'SA3 T2A'
          : aceStepCoverInProgressRef.current
            ? 'ACE Cover'
            : 'ACE T2M';
        throw new Error(
          `${generatorLabel} generation is active. Wait for the Job to finish or cancel it from its PatchTab.`,
        );
      }

      if (clipTakeFileDeletionInProgressRef.current) {
        throw new Error(
          'Wait for the active Clip Take file deletion transaction to finish.',
        );
      }

      if (currentAvailability.productionEditingLocked) {
        throw new Error(currentAvailability.message);
      }

      releaseMidiClipPlaybackPreparation();
      releaseActiveAudioPlayback();
      releaseInstrumentAudioPreview();
      midiClipPlaybackCacheRef.current.clear();
      setInstrumentAudioPreviewState({ status: 'IDLE' });
      metronomeRuntimeRef.current.stop();
      clearRecordingBoundaryTimer();
      recordingAutoStopReasonRef.current = undefined;
      recordingOperationIdRef.current += 1;
      updateRecordingRuntimePhase('IDLE');
      setMicrophoneInputLevel(0);
      void microphoneRecordingRuntimeRef.current.cancel();
      const reconnectResult = options.reconnectSessionAudioSources
        ? reconnectProjectSessionAudioSources(workspaceState.project, sessionAudioSourcesRef.current)
        : { project: workspaceState.project, reconnectedSourceCount: 0 };

      if (!options.reconnectSessionAudioSources) {
        sessionAudioSourcesRef.current.clear();
      }

      const nextWorkspace = normalizeWorkspaceState({
        ...workspaceState,
        project: reconnectResult.project,
      });

      workspaceEditSequenceRef.current += 1;
      setHistory(
        createSessionEditHistory(nextWorkspace, {
          category: 'system',
          createdAt: new Date().toISOString(),
          id: `workspace-${Date.now()}-${workspaceEditSequenceRef.current}`,
          label: options.historyLabel ?? 'Open Project',
        }),
      );

      return {
        workspace: nextWorkspace,
        reconnectedSourceCount: reconnectResult.reconnectedSourceCount,
      };
    },
    [
      clearRecordingBoundaryTimer,
      releaseActiveAudioPlayback,
      releaseInstrumentAudioPreview,
      releaseMidiClipPlaybackPreparation,
      updateRecordingRuntimePhase,
    ],
  );

  const replaceLoadedProjectWorkspace = useCallback(
    async (
      projectLoad: NormalizedProjectLoad<WorkspaceState>,
      loadedLabel: 'Browser save restored' | 'Project loaded',
    ): Promise<WorkspaceReplacementResult> => {
      const expectedWorkspace = workspaceRef.current;
      const sourceRestoration = await prepareLoadedProjectSourceRestoration(
        localEngineClientRef.current,
        projectLoad.workspace,
        {
          applyRestoration: (loadedWorkspace, descriptors, restoration) => ({
            ...loadedWorkspace,
            project: applyProjectSourceRestoration(
              loadedWorkspace.project,
              descriptors,
              restoration,
            ),
          }),
          collectDescriptors: (loadedWorkspace) =>
            collectProjectSourceRestorationDescriptors(loadedWorkspace.project),
        },
        {
          engineReadyAndIdle:
            engineConnection.lifecycle === 'READY' &&
            engineConnection.activity === 'IDLE',
          projectRootReady: projectRootState.status === 'READY',
        },
      );

      if (workspaceRef.current !== expectedWorkspace) {
        throw new Error(
          'Workspace changed while the saved Project sources were being restored. Load the Project again.',
        );
      }

      const replacement = replaceWorkspaceState(sourceRestoration.workspace, {
        reconnectSessionAudioSources: true,
      });
      setSavedProjectFingerprint(
        createSavedProjectFingerprintAfterLoad(
          createDirtyStateFingerprint(replacement.workspace.project),
          projectLoad.mixerNormalization,
        ),
      );

      const sessionMessage =
        replacement.reconnectedSourceCount > 0
          ? ` Reconnected ${formatCount(
              replacement.reconnectedSourceCount,
              'session audio source',
            )}.`
          : '';
      const generatedRestorationNeedsAttention =
        sourceRestoration.status === 'PROJECT_ROOT_REQUIRED' ||
        sourceRestoration.status === 'RESTORATION_FAILED' ||
        (sourceRestoration.status === 'RESTORED' &&
          sourceRestoration.availableGeneratedSourceCount <
            sourceRestoration.generatedSourceCount);

      if (
        sourceRestoration.status !== 'NO_GENERATED_SOURCES' ||
        replacement.reconnectedSourceCount > 0
      ) {
        const helpText = `${loadedLabel}. ${sourceRestoration.message}${sessionMessage}`;
        showTimelineStatusFeedback({
          helpText,
          message: generatedRestorationNeedsAttention
            ? 'PROJECT ROOT RESTORE NEEDED'
            : 'SOURCES RESTORED',
          tone: generatedRestorationNeedsAttention ? 'warning' : 'success',
        });
        setHeaderHelpMessage(helpText);
      }

      return replacement;
    },
    [
      engineConnection.activity,
      engineConnection.lifecycle,
      projectRootState.status,
      replaceWorkspaceState,
      showTimelineStatusFeedback,
    ],
  );

  useEffect(() => {
    const handleHelpPreview = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string' && event.detail.length > 0) {
        setHeaderHelpMessage(event.detail);
      }
    };

    window.addEventListener(headerHelpPreviewEventName, handleHelpPreview);

    return () => window.removeEventListener(headerHelpPreviewEventName, handleHelpPreview);
  }, []);

  useEffect(() => {
    return () => {
      if (timelineStatusFeedbackTimeoutRef.current !== undefined) {
        window.clearTimeout(timelineStatusFeedbackTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      autoPatchProductionRequestIdRef.current += 1;
      timelineTransportRequestIdRef.current += 1;
      autoPatchProductionAbortControllerRef.current?.abort();
      autoPatchProductionAbortControllerRef.current = undefined;
      autoPatchProductionInProgressRef.current = false;
      releaseMidiClipPlaybackPreparation();
      midiClipPlaybackCacheRef.current.clear();
      releaseActiveAudioPlayback();
      releaseInstrumentAudioPreview();
      metronomeRuntimeRef.current.stop();
      clearRecordingBoundaryTimer();
      recordingAutoStopReasonRef.current = undefined;
      recordingOperationIdRef.current += 1;
      recordingRuntimePhaseRef.current = 'IDLE';
      void microphoneRecordingRuntimeRef.current.cancel();
    };
  }, [
    clearRecordingBoundaryTimer,
    releaseActiveAudioPlayback,
    releaseInstrumentAudioPreview,
    releaseMidiClipPlaybackPreparation,
  ]);

  useEffect(() => {
    if (
      midiClipPlaybackPreparationAbortControllerRef.current !== undefined ||
      audioClipPlaybackRuntimeRef.current.isPlaying() ||
      projectPlaybackRuntimeRef.current.isPlaying()
    ) {
      recordProjectPlaybackDiagnostic('playback-content-invalidated', {
        bpm: project.bpm,
        trackCount: project.tracks.length,
      });
      stopMidiClipPlaybackPreparation(false);
      stopActiveAudioPlayback(false);
    }
  }, [
    audioPlaybackContentFingerprint,
    project.bpm,
    project.tracks.length,
    stopActiveAudioPlayback,
    stopMidiClipPlaybackPreparation,
  ]);

  useEffect(() => {
    releaseInstrumentAudioPreview();
    setInstrumentAudioPreviewState({ status: 'IDLE' });
  }, [
    engineConnection.instanceId,
    engineConnection.lifecycle,
    project.artifacts,
    project.tracks,
    projectRootState.status,
    releaseInstrumentAudioPreview,
    workspace.activeTransport,
    workspace.selectedClipId,
  ]);

  useEffect(() => {
    if (timelineStatusDiagnostic) {
      setHeaderHelpMessage(timelineStatusDiagnostic.helpText);
    }
  }, [timelineStatusDiagnostic]);

  const handleUndo = useCallback(() => {
    const currentAvailability = engineAvailabilityRef.current;

    if ((punchSessionRef.current?.attempts.length ?? 0) > 0) {
      setHeaderHelpMessage(
        'Undo is locked while Punch Attempts are unresolved. KEEP SELECTED AS NEW TAKE or DISCARD SESSION first.',
      );
      return;
    }

    if (autoPatchProductionInProgressRef.current) {
      setHeaderHelpMessage(
        'Auto Patch production is active. Undo is available after the run reaches a terminal state.',
      );
      return;
    }

    if (
      stableAudio3TextToAudioInProgressRef.current ||
      aceStepTextToMusicInProgressRef.current ||
      aceStepCoverInProgressRef.current
    ) {
      const generatorLabel = stableAudio3TextToAudioInProgressRef.current
        ? 'SA3 T2A'
        : aceStepCoverInProgressRef.current
          ? 'ACE Cover'
          : 'ACE T2M';
      setHeaderHelpMessage(
        `${generatorLabel} generation is active. Undo is available after the Job reaches a terminal state.`,
      );
      return;
    }

    if (clipTakeFileDeletionInProgressRef.current) {
      setHeaderHelpMessage(
        'Wait for the active Clip Take file deletion transaction to finish.',
      );
      return;
    }

    if (currentAvailability.productionEditingLocked) {
      setHeaderHelpMessage(currentAvailability.message);
      return;
    }

    setHistory((currentHistory) => {
      const result = undoSessionEdit(currentHistory);

      if (result.status === 'IRREVERSIBLE_BOUNDARY') {
        setHeaderHelpMessage(
          'Edit History cannot move before a deleted physical Audio file.',
        );
      }

      return result.status === 'MOVED'
        ? updateSessionEditPresent(result.history, (targetWorkspace) =>
            preserveSessionViewState(
              targetWorkspace,
              currentHistory.present.value,
            ),
          )
        : result.history;
    });
  }, []);

  const handleRedo = useCallback(() => {
    const currentAvailability = engineAvailabilityRef.current;

    if ((punchSessionRef.current?.attempts.length ?? 0) > 0) {
      setHeaderHelpMessage(
        'Redo is locked while Punch Attempts are unresolved. KEEP SELECTED AS NEW TAKE or DISCARD SESSION first.',
      );
      return;
    }

    if (autoPatchProductionInProgressRef.current) {
      setHeaderHelpMessage(
        'Auto Patch production is active. Redo is available after the run reaches a terminal state.',
      );
      return;
    }

    if (
      stableAudio3TextToAudioInProgressRef.current ||
      aceStepTextToMusicInProgressRef.current ||
      aceStepCoverInProgressRef.current
    ) {
      const generatorLabel = stableAudio3TextToAudioInProgressRef.current
        ? 'SA3 T2A'
        : aceStepCoverInProgressRef.current
          ? 'ACE Cover'
          : 'ACE T2M';
      setHeaderHelpMessage(
        `${generatorLabel} generation is active. Redo is available after the Job reaches a terminal state.`,
      );
      return;
    }

    if (clipTakeFileDeletionInProgressRef.current) {
      setHeaderHelpMessage(
        'Wait for the active Clip Take file deletion transaction to finish.',
      );
      return;
    }

    if (currentAvailability.productionEditingLocked) {
      setHeaderHelpMessage(currentAvailability.message);
      return;
    }

    setHistory((currentHistory) => {
      const result = redoSessionEdit(currentHistory, undoHistoryLimit);

      if (result.status === 'IRREVERSIBLE_BOUNDARY') {
        setHeaderHelpMessage(
          'Edit History cannot replay a physical Audio file deletion.',
        );
      }

      return result.status === 'MOVED'
        ? updateSessionEditPresent(result.history, (targetWorkspace) =>
            preserveSessionViewState(
              targetWorkspace,
              currentHistory.present.value,
            ),
          )
        : result.history;
    });
  }, []);

  const handleJumpToEditHistory = useCallback((targetIndex: number) => {
    const currentAvailability = engineAvailabilityRef.current;

    if ((punchSessionRef.current?.attempts.length ?? 0) > 0) {
      setHeaderHelpMessage(
        'Edit History is locked while Punch Attempts are unresolved. KEEP or DISCARD the Punch Session first.',
      );
      return;
    }

    if (autoPatchProductionInProgressRef.current) {
      setHeaderHelpMessage(
        'Auto Patch production is active. Edit History unlocks after the run reaches a terminal state.',
      );
      return;
    }

    if (
      stableAudio3TextToAudioInProgressRef.current ||
      aceStepTextToMusicInProgressRef.current ||
      aceStepCoverInProgressRef.current
    ) {
      const generatorLabel = stableAudio3TextToAudioInProgressRef.current
        ? 'SA3 T2A'
        : aceStepCoverInProgressRef.current
          ? 'ACE Cover'
          : 'ACE T2M';
      setHeaderHelpMessage(
        `${generatorLabel} generation is active. Edit History unlocks after the Job reaches a terminal state.`,
      );
      return;
    }

    if (clipTakeFileDeletionInProgressRef.current) {
      setHeaderHelpMessage(
        'Wait for the active Clip Take file deletion transaction to finish.',
      );
      return;
    }

    if (currentAvailability.productionEditingLocked) {
      setHeaderHelpMessage(currentAvailability.message);
      return;
    }

    setHistory((currentHistory) => {
      const result = jumpSessionEdit(currentHistory, targetIndex);

      if (result.status === 'IRREVERSIBLE_BOUNDARY') {
        setHeaderHelpMessage(
          'Edit History cannot cross a physical Audio file deletion checkpoint.',
        );
      }

      return result.status === 'MOVED'
        ? updateSessionEditPresent(result.history, (targetWorkspace) =>
            preserveSessionViewState(
              targetWorkspace,
              currentHistory.present.value,
            ),
          )
        : result.history;
    });
  }, []);

  useEffect(() => {
    if (!isProductionEditingLocked) {
      return;
    }

    const blockProductionShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const hasCommandModifier = event.ctrlKey || event.metaKey;
      const isEmergencySave = hasCommandModifier && key === 's';
      const isBlockedShortcut =
        event.code === 'Space' ||
        event.key === 'Delete' ||
        event.key === 'Backspace' ||
        (hasCommandModifier && (key === 'v' || key === 'y' || key === 'z'));

      if (isEmergencySave || !isBlockedShortcut) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      setHeaderHelpMessage(productionEditingLockMessage);
    };

    window.addEventListener('keydown', blockProductionShortcut, true);

    return () => window.removeEventListener('keydown', blockProductionShortcut, true);
  }, [isProductionEditingLocked, productionEditingLockMessage]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.ctrlKey || event.metaKey) ||
        isEditableEventTarget(event.target) ||
        (event.target instanceof HTMLElement &&
          Boolean(event.target.closest('.piano-roll-spike')))
      ) {
        return;
      }

      if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        handleUndo();
      }

      if (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey)) {
        event.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleRedo, handleUndo]);

  useEffect(() => {
    if (!projectHealth.hasUnsavedChanges) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [projectHealth.hasUnsavedChanges]);

  const handleSelectPatchTab = useCallback(
    (patchTabId: string) => {
      setHeaderHelpMessage(createPatchTabHelpMessage(project.patchTabs.find((patchTab) => patchTab.id === patchTabId)));
      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        selectedPatchTabId: patchTabId,
        project: {
          ...currentWorkspace.project,
          selectedPatchTabId: patchTabId,
        },
      }));
    },
    [project.patchTabs, updateWorkspaceViewState],
  );

  const handleSelectConnection = useCallback(
    (connectionId: string) => {
      setHeaderHelpMessage(createRoutingHelpMessage(project, connectionId));
      updateWorkspaceViewState((currentWorkspace) => {
        const tabFlowLineId = findTabFlowLineIdForConnection(
          getProjectTabFlowLines(currentWorkspace.project),
          connectionId,
        );

        return {
          ...currentWorkspace,
          selectedConnectionId: connectionId,
          selectedTabFlowLineId: tabFlowLineId ?? currentWorkspace.selectedTabFlowLineId,
        };
      });
    },
    [project, updateWorkspaceViewState],
  );

  const handleSelectTabFlowLine = useCallback(
    (tabFlowLineId: string) => {
      const targetLine = getProjectTabFlowLines(project).find((line) => line.id === tabFlowLineId);

      if (targetLine) {
        setHeaderHelpMessage(
          createTabFlowLineSelectionHelpMessage(
            targetLine,
            getTabFlowLineDisplayLabel(project, targetLine.id),
          ),
        );
      }

      updateWorkspaceViewState((currentWorkspace) => {
        const tabFlowLines = getProjectTabFlowLines(currentWorkspace.project);
        const currentLine = tabFlowLines.find((line) => line.id === tabFlowLineId);

        if (!currentLine) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          selectedTabFlowLineId: currentLine.id,
          selectedConnectionId: currentLine.connectionIds[0] ?? '',
        };
      });
    },
    [project, updateWorkspaceViewState],
  );

  const handleAddTabFlowLine = useCallback(() => {
    const nextLineNumber =
      normalizeTabFlowFamilies(getProjectTabFlowLines(project)).filter((line) => !line.attachment)
        .length + 1;

    setHeaderHelpMessage(
      `TabFlow Line ${nextLineNumber} created. It starts ${nextLineNumber === 1 ? 'ON' : 'OFF'} for safe routing.`,
    );
    updateWorkspaceState((currentWorkspace) => {
      const tabFlowLines = getProjectTabFlowLines(currentWorkspace.project);
      const usedLineIds = new Set(tabFlowLines.map((line) => line.id));
      const lineIndex = tabFlowLines.length;
      const tabFlowLine: TabFlowLine = {
        id: createTabFlowLineId(lineIndex, usedLineIds),
        name: createTabFlowLineName(lineIndex),
        order: lineIndex,
        enabled: tabFlowLines.length === 0,
        revision: 1,
        connectionIds: [],
      };

      return {
        ...currentWorkspace,
        selectedTabFlowLineId: tabFlowLine.id,
        selectedConnectionId: '',
        pendingPortSelection: undefined,
        project: {
          ...currentWorkspace.project,
          tabFlowLines: normalizeTabFlowLineOrder([...tabFlowLines, tabFlowLine]),
        },
      };
    });
  }, [project, updateWorkspaceState]);

  const handleDeleteEmptyTabFlowLine = useCallback(
    (tabFlowLineId: string) => {
      const targetLine = getProjectTabFlowLines(project).find((line) => line.id === tabFlowLineId);

      if (!targetLine || targetLine.connectionIds.length > 0 || getProjectTabFlowLines(project).length <= 1) {
        return;
      }

      setHeaderHelpMessage(`TabFlow Line ${targetLine.order + 1} removed.`);
      updateWorkspaceState((currentWorkspace) => {
        const tabFlowLines = getProjectTabFlowLines(currentWorkspace.project);
        const targetLineIndex = tabFlowLines.findIndex((line) => line.id === tabFlowLineId);
        const currentLine = tabFlowLines[targetLineIndex];

        if (!currentLine || currentLine.connectionIds.length > 0 || tabFlowLines.length <= 1) {
          return currentWorkspace;
        }

        const nextTabFlowLines = normalizeTabFlowLineOrder(tabFlowLines.filter((line) => line.id !== tabFlowLineId));
        const fallbackLine =
          nextTabFlowLines[Math.min(targetLineIndex, nextTabFlowLines.length - 1)] ??
          nextTabFlowLines[targetLineIndex - 1];
        const didDeleteSelectedLine = currentWorkspace.selectedTabFlowLineId === tabFlowLineId;
        const selectedTabFlowLineId = didDeleteSelectedLine
          ? fallbackLine?.id ?? ''
          : currentWorkspace.selectedTabFlowLineId;
        const selectedLine = nextTabFlowLines.find((line) => line.id === selectedTabFlowLineId);

        return {
          ...currentWorkspace,
          selectedTabFlowLineId,
          selectedConnectionId: didDeleteSelectedLine ? selectedLine?.connectionIds[0] ?? '' : currentWorkspace.selectedConnectionId,
          pendingPortSelection: undefined,
          project: {
            ...currentWorkspace.project,
            tabFlowLines: nextTabFlowLines,
          },
        };
      });
    },
    [project, updateWorkspaceState],
  );

  const handleSelectClip = useCallback(
    (clipId: string, selectionMode: SelectionMode = 'replace') => {
      const activePunchSession = punchSessionRef.current;

      if (
        (activePunchSession?.attempts.length ?? 0) > 0 &&
        (clipId !== activePunchSession?.clip.id || selectionMode !== 'replace')
      ) {
        setHeaderHelpMessage(
          'Clip selection is frozen while Punch Attempts are unresolved. KEEP or DISCARD the Punch Session first.',
        );
        return;
      }

      setHeaderHelpMessage(createClipHelpMessage(findSelectedClip(project.tracks, clipId)));
      updateWorkspaceViewState((currentWorkspace) => {
        const clipSelectionItem: SelectionItem = { type: 'clip', id: clipId };
        const currentSelection = normalizeSelectionState(currentWorkspace.project.selection, currentWorkspace.project.tracks);
        const currentClipSelection = filterSelectionByType(currentSelection, 'clip');
        const visibleTracks = getVisibleTracks(currentWorkspace.project.tracks);
        const nextSelection =
          selectionMode === 'toggle'
            ? toggleSelectionItem(currentClipSelection, clipSelectionItem)
            : selectionMode === 'range'
              ? createClipRangeSelection(currentClipSelection, clipSelectionItem, visibleTracks)
            : createSingleSelection(clipSelectionItem);

        return {
          ...currentWorkspace,
          selectedClipId: getPreferredSelectedClipId(nextSelection, clipId, currentWorkspace.selectedClipId),
          project: {
            ...currentWorkspace.project,
            selection: nextSelection,
          },
        };
      });
    },
    [project.tracks, updateWorkspaceViewState],
  );

  const handleActivateClipTake = useCallback(
    async (clipId: string, clipTakeId: string) => {
      const activePunchSession = punchSessionRef.current;

      if (
        (activePunchSession?.attempts.length ?? 0) > 0 &&
        (clipId !== activePunchSession?.clip.id ||
          clipTakeId !== activePunchSession?.baseClipTake.clipTakeId)
      ) {
        setHeaderHelpMessage(
          'Base Take is frozen while Punch Attempts are unresolved. KEEP or DISCARD the Punch Session first.',
        );
        return;
      }

      const requestId = ++clipTakeActivationRequestIdRef.current;
      const expectedProject = workspaceRef.current.project;
      const activation = activateClipTake(
        expectedProject,
        clipId,
        clipTakeId,
      );

      if (!activation.canActivate) {
        setHeaderHelpMessage(activation.message);
        return;
      }

      if (activation.status === 'ALREADY_ACTIVE') {
        setHeaderHelpMessage(`${activation.clipTake.label} is already Active.`);
        return;
      }

      const getActivationLockMessage = (): string | undefined => {
        if (autoPatchProductionInProgressRef.current) {
          return 'Auto Patch production is active. Wait for the run to finish or cancel it from the status bar.';
        }

        if (
          stableAudio3TextToAudioInProgressRef.current ||
          aceStepTextToMusicInProgressRef.current ||
          aceStepCoverInProgressRef.current
        ) {
          const generatorLabel = stableAudio3TextToAudioInProgressRef.current
            ? 'SA3 T2A'
            : aceStepCoverInProgressRef.current
              ? 'ACE Cover'
              : 'ACE T2M';
          return `${generatorLabel} generation is active. Project edits unlock when the Job reaches a terminal state.`;
        }

        if (clipTakeFileDeletionInProgressRef.current) {
          return 'Wait for the active Clip Take file deletion transaction to finish.';
        }

        return engineAvailabilityRef.current.productionEditingLocked
          ? engineAvailabilityRef.current.message
          : undefined;
      };
      const initialLockMessage = getActivationLockMessage();

      if (initialLockMessage) {
        setHeaderHelpMessage(initialLockMessage);
        return;
      }

      if (activation.clipTake.mediaType === 'audio') {
        const client = localEngineClientRef.current;
        const artifacts = (expectedProject.artifacts ?? []).filter(
          (artifact): artifact is AudioArtifact =>
            artifact.artifactId === activation.clipTake.artifactId &&
            artifact.kind === 'audio',
        );

        if (artifacts.length !== 1) {
          setHeaderHelpMessage(
            `${activation.clipTake.label} does not resolve to one Audio Artifact. The current Active Take was preserved.`,
          );
          return;
        }

        if (
          !client ||
          engineConnection.lifecycle !== 'READY' ||
          projectRootState.status !== 'READY'
        ) {
          setHeaderHelpMessage(
            'Audio Take activation requires a connected Local Engine and ready Project Root. The current Active Take was preserved.',
          );
          return;
        }

        setHeaderHelpMessage(
          `Verifying ${activation.clipTake.label} in the Project Root before activation.`,
        );
        const availability = await verifyClipTakeActivationAvailability(
          client,
          artifacts[0],
        );

        if (clipTakeActivationRequestIdRef.current !== requestId) {
          return;
        }

        if (!availability.ok) {
          setHeaderHelpMessage(availability.message);
          return;
        }

        const finalLockMessage = getActivationLockMessage();

        if (finalLockMessage) {
          setHeaderHelpMessage(finalLockMessage);
          return;
        }

        if (workspaceRef.current.project !== expectedProject) {
          setHeaderHelpMessage(
            'Audio Take activation was blocked because the Project changed during availability verification. The current Active Take was preserved.',
          );
          return;
        }

        const verifiedActivation = activateClipTake(
          expectedProject,
          clipId,
          clipTakeId,
          { sourceAvailability: availability.evidence },
        );

        if (
          !verifiedActivation.canActivate ||
          verifiedActivation.status !== 'ACTIVATED' ||
          verifiedActivation.clip.sourceFile?.status !== 'available'
        ) {
          setHeaderHelpMessage(
            verifiedActivation.canActivate
              ? `${activation.clipTake.label} availability changed before activation. The current Active Take was preserved.`
              : verifiedActivation.message,
          );
          return;
        }

        updateWorkspaceState(
          (currentWorkspace) => {
            if (currentWorkspace.project !== expectedProject) {
              return currentWorkspace;
            }

            const currentActivation = activateClipTake(
              currentWorkspace.project,
              clipId,
              clipTakeId,
              { sourceAvailability: availability.evidence },
            );

            return currentActivation.canActivate &&
              currentActivation.status === 'ACTIVATED' &&
              currentActivation.clip.sourceFile?.status === 'available'
              ? {
                  ...currentWorkspace,
                  project: currentActivation.project,
                }
              : currentWorkspace;
          },
          {
            category: 'take',
            label: `Activate ${activation.clipTake.label}`,
          },
        );
        setHeaderHelpMessage(
          `${activation.clipTake.label} is Active for ${activation.clip.name}.${
            workspaceRef.current.activeTransport === 'PLAY'
              ? ' Current playback is unchanged; the next playback uses this Take.'
              : ''
          }`,
        );
        return;
      }

      updateWorkspaceState(
        (currentWorkspace) => {
          if (currentWorkspace.project !== expectedProject) {
            return currentWorkspace;
          }

          const currentActivation = activateClipTake(
            currentWorkspace.project,
            clipId,
            clipTakeId,
          );

          return currentActivation.canActivate &&
            currentActivation.status === 'ACTIVATED'
            ? {
                ...currentWorkspace,
                project: currentActivation.project,
              }
            : currentWorkspace;
        },
        {
          category: 'take',
          label: `Activate ${activation.clipTake.label}`,
        },
      );
      setHeaderHelpMessage(
        `${activation.clipTake.label} is Active for ${activation.clip.name}.${
          workspaceRef.current.activeTransport === 'PLAY'
            ? ' Current playback is unchanged; the next playback uses this Take.'
            : ''
        }`,
      );
    },
    [
      engineConnection.lifecycle,
      projectRootState.status,
      updateWorkspaceState,
    ],
  );

  const handleRefreshPianoRollSoundFonts = useCallback(async () => {
    soundFontPresetCatalogCacheRef.current.clear();
    const client = localEngineClientRef.current;

    if (
      !client ||
      engineConnection.lifecycle !== 'READY' ||
      projectRootState.status !== 'READY'
    ) {
      soundFontCatalogRequestIdRef.current += 1;
      setSoundFontCatalogState({ status: 'UNAVAILABLE' });
      setHeaderHelpMessage(
        'SOUNDFONT CATALOG UNAVAILABLE: Start Local Engine and select Project Root.',
      );
      return;
    }

    const requestId = ++soundFontCatalogRequestIdRef.current;
    setSoundFontCatalogState({ status: 'LOADING' });
    setHeaderHelpMessage(
      `Reading built-in and ${projectRootState.projectRoot.rootName}/soundfonts resources.`,
    );
    const result = await client.listSoundFonts();

    if (soundFontCatalogRequestIdRef.current !== requestId) {
      return;
    }

    if (!result.ok) {
      setSoundFontCatalogState({
        message: result.message,
        status: 'ERROR',
      });
      setHeaderHelpMessage(`SOUNDFONT CATALOG ERROR: ${result.message}`);
      return;
    }

    setSoundFontCatalogState({
      catalog: result.catalog,
      status: 'READY',
    });
    setHeaderHelpMessage(
      result.catalog.resources.length > 0
        ? `${formatCount(result.catalog.resources.length, 'SoundFont')} ready for Piano Roll audition.`
        : `Built-in SoundFont is unavailable and no custom .sf2 or .sf3 files were found under ${projectRootState.projectRoot.rootPath}\\soundfonts.`,
    );
  }, [engineConnection.lifecycle, projectRootState]);

  const handleListSoundFontPresets = useCallback(
    (
      resource: LocalEngineSoundFontResource,
    ): Promise<LocalEngineSoundFontPresetCatalogResult> => {
      const client = localEngineClientRef.current;

      if (
        !client ||
        engineConnection.lifecycle !== 'READY' ||
        projectRootState.status !== 'READY'
      ) {
        return Promise.resolve({
          message:
            'SoundFont voices require Local Engine READY and one Project Root.',
          ok: false,
          reason: 'offline',
        });
      }

      const cacheKey = `${projectRootState.projectRoot.rootPath}:${resource.resourceId}:${resource.revisionToken}`;
      const cached = soundFontPresetCatalogCacheRef.current.get(cacheKey);

      if (cached) {
        return cached;
      }

      const request = client
        .listSoundFontPresets({
          soundFont: {
            format: resource.format,
            library: resource.library,
            relativePath: resource.relativePath,
            resourceId: resource.resourceId,
            revisionToken: resource.revisionToken,
          },
        })
        .then((result) => {
          if (!result.ok) {
            soundFontPresetCatalogCacheRef.current.delete(cacheKey);
          }

          return result;
        });

      soundFontPresetCatalogCacheRef.current.set(cacheKey, request);
      return request;
    },
    [engineConnection.lifecycle, projectRootState],
  );

  useEffect(() => {
    if (
      engineConnection.lifecycle === 'READY' &&
      projectRootState.status === 'READY' &&
      soundFontCatalogState.status === 'UNAVAILABLE'
    ) {
      void handleRefreshPianoRollSoundFonts();
    }
  }, [
    engineConnection.lifecycle,
    handleRefreshPianoRollSoundFonts,
    projectRootState.status,
    soundFontCatalogState.status,
  ]);

  useEffect(() => {
    if (
      engineConnection.lifecycle !== 'READY' ||
      projectRootState.status !== 'READY' ||
      soundFontCatalogState.status !== 'READY'
    ) {
      return;
    }

    const builtInResource = soundFontCatalogState.catalog.resources.find(
      (resource) =>
        resource.library === 'builtin' &&
        resource.relativePath === HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH,
    );

    if (!builtInResource) {
      return;
    }

    handlePreparePianoRollLiveNotePreview({
      bank: 0,
      program: 0,
      resource: builtInResource,
    });
  }, [
    engineConnection.lifecycle,
    handlePreparePianoRollLiveNotePreview,
    projectRootState.status,
    soundFontCatalogState,
  ]);

  const handleAuditionPianoRollSoundFont = useCallback(
    (request: PianoRollSoundFontAuditionRequest) => {
      stopSoundFontAudition(false);
      const client = localEngineClientRef.current;

      if (
        !client ||
        engineConnection.lifecycle !== 'READY' ||
        projectRootState.status !== 'READY'
      ) {
        const message =
          'SOUNDFONT AUDITION UNAVAILABLE: Start Local Engine and select Project Root.';
        setSoundFontAuditionState({ message, status: 'ERROR' });
        setHeaderHelpMessage(message);
        return;
      }

      if (recordingRuntimePhaseRef.current !== 'IDLE') {
        const message = 'Stop recording before starting a SoundFont audition.';
        setSoundFontAuditionState({ message, status: 'ERROR' });
        setHeaderHelpMessage(message);
        return;
      }

      if (
        audioClipPlaybackRuntimeRef.current.isPlaying() ||
        projectPlaybackRuntimeRef.current.isPlaying()
      ) {
        const message = 'Stop Timeline playback before starting a SoundFont audition.';
        setSoundFontAuditionState({ message, status: 'ERROR' });
        setHeaderHelpMessage(message);
        return;
      }

      stopInstrumentAudioPreview(false);
      const operationId = ++soundFontAuditionOperationIdRef.current;
      const abortController = new AbortController();
      soundFontAuditionAbortControllerRef.current = abortController;
      const auditionPlan: InstrumentAudioPreviewPlan = {
        artifactId: request.plan.source.artifactId,
        clipId: request.plan.source.clipId,
        clipName: request.clipName,
        clipTakeId: request.plan.source.clipTakeId,
        gainDb: 0,
        sourceId: request.resource.resourceId,
      };
      const renderingMessage =
        `${request.resource.name} / Bank ${request.bank} / Program ${request.program} / Rendering temporary WAV.`;
      setSoundFontAuditionState({
        message: renderingMessage,
        status: 'RENDERING',
      });
      setHeaderHelpMessage(
        `Rendering ${request.clipName} through ${request.resource.name}. Project data will not change.`,
      );

      const wavPromise = client
        .renderSoundFontAudition(
          {
            bank: request.bank,
            midi: {
              bpm: request.plan.midi.bpm,
              notes: request.notes,
              ticksPerQuarter: request.plan.midi.ticksPerQuarter,
            },
            program: request.program,
            soundFont: {
              format: request.resource.format,
              library: request.resource.library,
              relativePath: request.resource.relativePath,
              resourceId: request.resource.resourceId,
              revisionToken: request.resource.revisionToken,
            },
          },
          abortController.signal,
        )
        .then((result) => {
          if (!result.ok) {
            throw new Error(result.message);
          }

          return result.wav;
        })
        .finally(() => {
          if (
            soundFontAuditionAbortControllerRef.current === abortController
          ) {
            soundFontAuditionAbortControllerRef.current = undefined;
          }
        });

      try {
        soundFontAuditionRuntimeRef.current.play(
          wavPromise,
          auditionPlan,
          {
            onComplete: (completedPlan) => {
              if (soundFontAuditionOperationIdRef.current !== operationId) {
                return;
              }

              setSoundFontAuditionState({ status: 'IDLE' });
              setHeaderHelpMessage(
                `${completedPlan.clipName} SoundFont audition complete. Project data was unchanged.`,
              );
            },
            onError: (message, failedPlan) => {
              if (soundFontAuditionOperationIdRef.current !== operationId) {
                return;
              }

              const auditionMessage = message.replace(
                /^Instrument Audio Preview failed: /,
                'SoundFont audition failed: ',
              );
              setSoundFontAuditionState({
                message: auditionMessage,
                status: 'ERROR',
              });
              setHeaderHelpMessage(
                `${failedPlan.clipName}: ${auditionMessage}`,
              );
            },
            onStarted: (startedPlan) => {
              if (soundFontAuditionOperationIdRef.current !== operationId) {
                return;
              }

              const message =
                `${request.resource.name} / Bank ${request.bank} / Program ${request.program} / Playing.`;
              setSoundFontAuditionState({ message, status: 'PLAYING' });
              setHeaderHelpMessage(
                `Auditioning ${startedPlan.clipName} through ${request.resource.name}. Timeline transport is unchanged.`,
              );
            },
          },
        );
      } catch (error) {
        abortController.abort();
        soundFontAuditionAbortControllerRef.current = undefined;
        const message =
          error instanceof Error
            ? `SoundFont audition failed: ${error.message}`
            : 'SoundFont audition failed unexpectedly.';
        setSoundFontAuditionState({ message, status: 'ERROR' });
        setHeaderHelpMessage(message);
      }
    },
    [
      engineConnection.lifecycle,
      projectRootState.status,
      stopInstrumentAudioPreview,
      stopSoundFontAudition,
    ],
  );

  const handleAssignPianoRollSoundFont = useCallback(
    (
      clipId: string,
      assignment: SoundFontAssignment | undefined,
    ) => {
      if (engineAvailability.productionEditingLocked) {
        setHeaderHelpMessage(engineAvailability.message);
        return;
      }

      const update = updateMidiClipSoundFontAssignment(
        project,
        clipId,
        assignment,
      );

      if (!update.canUpdate) {
        setHeaderHelpMessage(`SOUNDFONT ASSIGNMENT FAILED: ${update.message}`);
        return;
      }

      if (update.status === 'UNCHANGED') {
        setHeaderHelpMessage('The selected SoundFont assignment is already active.');
        return;
      }

      const targetClipName = update.clip.name;
      const editLabel =
        update.status === 'CLEARED'
          ? `Clear SoundFont from ${targetClipName}`
          : `Assign ${getFileNameFromPath(
              update.clip.soundFont?.resource.relativePath ?? 'SoundFont',
            )} to ${targetClipName}`;

      updateWorkspaceState(
        (currentWorkspace) => {
          const currentUpdate = updateMidiClipSoundFontAssignment(
            currentWorkspace.project,
            clipId,
            assignment,
          );

          return currentUpdate.canUpdate &&
            currentUpdate.status !== 'UNCHANGED'
            ? {
                ...currentWorkspace,
                project: currentUpdate.project,
              }
            : currentWorkspace;
        },
        {
          category: 'piano-roll',
          label: editLabel,
        },
      );
      setHeaderHelpMessage(
        update.status === 'CLEARED'
          ? `SoundFont assignment cleared from ${targetClipName}.`
          : `${targetClipName}: ${getFileNameFromPath(
              update.clip.soundFont?.resource.relativePath ?? 'SoundFont',
            )}, Bank ${update.clip.soundFont?.bank ?? 0}, Program ${
              update.clip.soundFont?.program ?? 0
            }. Ready for Live Note Preview, Timeline PLAY, and MIDI TO AUDIO.`,
      );
    },
    [engineAvailability, project, updateWorkspaceState],
  );

  const handleSavePianoRollNotes = useCallback(
    (clipId: string, notes: readonly MidiNote[]) => {
      const identity = createPianoRollTakeIdentity();
      const save = savePianoRollTake(project, {
        clipId,
        identity,
        notes,
      });

      if (!save.canSave) {
        setHeaderHelpMessage(`PIANO ROLL SAVE FAILED: ${save.message}`);
        return;
      }

      if (save.status === 'UNCHANGED') {
        return;
      }

      if (save.status === 'CREATED') {
        updateWorkspaceState(
          (currentWorkspace) => {
            const currentSave = savePianoRollTake(currentWorkspace.project, {
              clipId,
              identity,
              notes,
            });

            return currentSave.canSave
              ? {
                  ...currentWorkspace,
                  project: currentSave.project,
                }
              : currentWorkspace;
          },
          {
            category: 'piano-roll',
            label: `Create ${save.clipTake.label}`,
          },
        );
        setHeaderHelpMessage(
          `${save.clipTake.label} created from the protected source Take.`,
        );
        return;
      }

      updateWorkspaceViewState((currentWorkspace) => {
        const currentSave = savePianoRollTake(currentWorkspace.project, {
          clipId,
          identity,
          notes,
        });

        return currentSave.canSave
          ? {
              ...currentWorkspace,
              project: currentSave.project,
            }
          : currentWorkspace;
      });
    },
    [project, updateWorkspaceState, updateWorkspaceViewState],
  );

  const handleCreateNewPianoRollTake = useCallback(
    (clipId: string, notes: readonly MidiNote[]) => {
      const identity = createPianoRollTakeIdentity();
      const creation = createNewPianoRollTake(project, {
        clipId,
        identity,
        notes,
      });

      if (!creation.canSave) {
        setHeaderHelpMessage(`NEW TAKE FAILED: ${creation.message}`);
        return;
      }

      updateWorkspaceState(
        (currentWorkspace) => {
          const currentCreation = createNewPianoRollTake(
            currentWorkspace.project,
            {
              clipId,
              identity,
              notes,
            },
          );

          return currentCreation.canSave
            ? {
                ...currentWorkspace,
                project: currentCreation.project,
              }
            : currentWorkspace;
        },
        {
          category: 'take',
          label: `Create ${creation.clipTake.label}`,
        },
      );
      setHeaderHelpMessage(
        `${creation.clipTake.label} created and set Active.`,
      );
    },
    [project, updateWorkspaceState],
  );

  const handleCreateManualMidiClip = useCallback(() => {
    const createdAt = new Date().toISOString();
    const defaultSoundFontAssignment =
      createBuiltInDefaultSoundFontAssignment(soundFontCatalogState);
    const defaultSoundFontResource =
      soundFontCatalogState.status === 'READY' && defaultSoundFontAssignment
        ? soundFontCatalogState.catalog.resources.find(
            (resource) =>
              resource.resourceId ===
              defaultSoundFontAssignment.resource.resourceId,
          )
        : undefined;
    const preview = createManualMidiClip(project, {
      createdAt,
      startTick: project.playheadTick,
    });

    if (!preview.canCreate) {
      setHeaderHelpMessage(`NEW MIDI FAILED: ${preview.message}`);
      return;
    }

    updateWorkspaceState(
      (currentWorkspace) => {
        const creation = createManualMidiClip(currentWorkspace.project, {
          createdAt,
          startTick: currentWorkspace.project.playheadTick,
        });

        if (!creation.canCreate) {
          return currentWorkspace;
        }

        const soundFontUpdate = defaultSoundFontAssignment
          ? updateMidiClipSoundFontAssignment(
              creation.project,
              creation.clip.id,
              defaultSoundFontAssignment,
            )
          : undefined;
        const nextProject =
          soundFontUpdate?.canUpdate === true
            ? soundFontUpdate.project
            : creation.project;

        return {
          ...currentWorkspace,
          selectedClipId: creation.clip.id,
          project: {
            ...nextProject,
            selection: createSelectionFromItems([
              { type: 'clip', id: creation.clip.id },
            ]),
          },
        };
      },
      {
        category: 'clip',
        label: `Create ${preview.clip.name}`,
      },
    );
    setHeaderHelpMessage(
      `${preview.clip.name} created at the playhead on ${preview.track.name}${
        defaultSoundFontResource
          ? ` with ${defaultSoundFontResource.name}, Bank 0, Program 0.`
          : '.'
      }`,
    );
  }, [project, soundFontCatalogState, updateWorkspaceState]);

  const removeClipTakeFromProject = useCallback(
    (
      clipId: string,
      clipTakeId: string,
      confirmActiveTakeRemoval: boolean,
    ) => {
      const removal = planClipTakeRemoval(project, {
        clipId,
        clipTakeId,
        confirmActiveTakeRemoval,
        mode: 'project-only',
      });

      if (!removal.canRemove) {
        setHeaderHelpMessage(removal.message);
        return;
      }

      stopInstrumentAudioPreview(false);
      updateWorkspaceState(
        (currentWorkspace) => {
          const currentRemoval = planClipTakeRemoval(
            currentWorkspace.project,
            {
              clipId,
              clipTakeId,
              confirmActiveTakeRemoval: true,
              mode: 'project-only',
            },
          );

          return currentRemoval.canRemove
            ? {
                ...currentWorkspace,
                project: currentRemoval.projectAfterRemoval,
              }
            : currentWorkspace;
        },
        {
          category: 'take',
          label: `Remove ${removal.removedClipTake.label} from Project`,
        },
      );
      setHeaderHelpMessage(
        `${removal.removedClipTake.label} removed from Project. The physical file was preserved.`,
      );
    },
    [project, stopInstrumentAudioPreview, updateWorkspaceState],
  );

  const handleRequestRemoveClipTakeFromProject = useCallback(
    (clipId: string, clipTakeId: string) => {
      const removal = planClipTakeRemoval(project, {
        clipId,
        clipTakeId,
        mode: 'project-only',
      });

      if (
        !removal.canRemove &&
        removal.reason !== 'active-take-confirmation-required'
      ) {
        setHeaderHelpMessage(removal.message);
        return;
      }

      if (removal.canRemove) {
        removeClipTakeFromProject(clipId, clipTakeId, false);
        return;
      }

      const confirmedRemoval = planClipTakeRemoval(project, {
        clipId,
        clipTakeId,
        confirmActiveTakeRemoval: true,
        mode: 'project-only',
      });

      if (!confirmedRemoval.canRemove) {
        setHeaderHelpMessage(confirmedRemoval.message);
        return;
      }

      const confirmationCopy =
        createActiveClipTakeRemovalConfirmationCopy(
          confirmedRemoval.removedClipTake,
        );

      requestSafetyConfirm({
        title: 'Remove Active Clip Take',
        message: confirmationCopy.message,
        confirmLabel: 'REMOVE TAKE',
        details: [
          confirmedRemoval.nextActiveClipTakeId
            ? `Next Active Clip Take: ${confirmedRemoval.nextActiveClipTakeId}`
            : 'The Clip will have no Active Take.',
          confirmationCopy.preservationDetail,
        ],
        onConfirm: () =>
          removeClipTakeFromProject(clipId, clipTakeId, true),
      });
    },
    [project, removeClipTakeFromProject, requestSafetyConfirm],
  );

  const deleteClipTakeAndAudioFile = useCallback(
    async (clipId: string, clipTakeId: string) => {
      if (clipTakeFileDeletionInProgressRef.current) {
        setHeaderHelpMessage(
          'A Clip Take file deletion transaction is already active.',
        );
        return;
      }

      const client = localEngineClientRef.current;
      const currentWorkspace = workspaceRef.current;
      const removal = planClipTakeRemoval(currentWorkspace.project, {
        clipId,
        clipTakeId,
        confirmActiveTakeRemoval: true,
        mode: 'project-and-audio-file',
      });

      if (!removal.canRemove || removal.fileAction.action !== 'delete') {
        setHeaderHelpMessage(
          removal.canRemove
            ? 'Clip Take removal did not produce one Audio file deletion action.'
            : removal.message,
        );
        return;
      }

      const descriptor = removal.fileAction.descriptor;

      if (
        !client ||
        engineConnection.lifecycle !== 'READY' ||
        engineConnection.activity !== 'IDLE' ||
        projectRootState.status !== 'READY' ||
        isProjectRootOverwriteProtected ||
        descriptor.extension !== '.wav'
      ) {
        setHeaderHelpMessage(
          isProjectRootOverwriteProtected
            ? 'Existing Project JSON is protected until that Project is loaded or a new Root is selected.'
            : 'Deleting an Audio file requires an idle Engine, a ready Project Root, and a finalized WAV Artifact.',
        );
        return;
      }

      clipTakeFileDeletionInProgressRef.current = true;
      setIsClipTakeFileDeletionInProgress(true);
      stopInstrumentAudioPreview(false);
      const sourceProjectFingerprint = createDirtyStateFingerprint(
        currentWorkspace.project,
      );
      const projectAfterRemoval = removal.projectAfterRemoval;
      const nextWorkspace: WorkspaceState = normalizeWorkspaceState({
        ...currentWorkspace,
        project: projectAfterRemoval,
      });
      const projectFile = createHumStudioProjectFile(nextWorkspace);
      setProjectFileSaveState({ status: 'SAVING' });
      setHeaderHelpMessage(
        `Saving Project removal before deleting ${descriptor.name}.`,
      );

      try {
        const saveResult = await client.saveProjectFile(projectFile);
        const saveSettlement = await settleProjectSave(
          projectFile,
          saveResult,
          () => client.loadProjectFile(),
        );

        if (saveSettlement.status !== 'CONFIRMED') {
          setProjectFileSaveState({
            message: saveSettlement.message,
            status: 'ERROR',
          });
          setHeaderHelpMessage(
            saveSettlement.status === 'RECOVERY_REQUIRED'
              ? `Audio file was preserved. Project removal needs recovery verification: ${saveSettlement.message}`
              : `Audio file was preserved because Project removal was rejected: ${saveSettlement.message}`,
          );
          return;
        }

        const currentProject = workspaceRef.current.project;
        const projectBecameStale = hasProjectDirtyStateDrift(
          sourceProjectFingerprint,
          currentProject,
          getProjectTabFlowLines(currentProject),
        );
        let projectToCommit = projectAfterRemoval;

        if (projectBecameStale) {
          const reconciledRemoval = reconcileCommittedClipTakeRemoval(
            workspaceRef.current.project,
            clipId,
            clipTakeId,
          );

          if (!reconciledRemoval.canReconcile) {
            setProjectFileSaveState({
              message:
                'Project removal was saved, but concurrent Project work could not be reconciled safely.',
              status: 'ERROR',
            });
            setHeaderHelpMessage(
              `Audio file was preserved. Reopen the Project before editing because deletion recovery could not reconcile concurrent work: ${reconciledRemoval.message}`,
            );
            return;
          }

          projectToCommit = reconciledRemoval.projectAfterRemoval;
        }

        const deletionSettlement = projectBecameStale
          ? {
              fileDisposition: 'preserved' as const,
              irreversible: false,
              message:
                'Audio deletion was skipped while concurrent Project work was reconciled.',
            }
          : classifyAudioFileDeletion(
              await client.deleteAudioArtifactFile({
                artifactId: descriptor.artifactId,
                extension: '.wav',
                name: descriptor.name,
                relativePath: descriptor.relativePath,
                sizeBytes: descriptor.sizeBytes,
                storageKind: descriptor.storageKind,
              }),
            );

        workspaceEditSequenceRef.current += 1;
        const edit: SessionEditEntry = {
          category: 'take',
          createdAt: new Date().toISOString(),
          id: `edit-${Date.now()}-${workspaceEditSequenceRef.current}`,
          ...(deletionSettlement.irreversible ? { irreversible: true } : {}),
          label:
            deletionSettlement.fileDisposition === 'deleted'
              ? `Delete ${removal.removedClipTake.label} + Audio File`
              : deletionSettlement.fileDisposition === 'unknown'
                ? `Remove ${removal.removedClipTake.label} (Audio Deletion Outcome Unknown)`
                : `Remove ${removal.removedClipTake.label} from Project`,
        };

        setHistory((currentHistory) => {
          const currentValue = currentHistory.present.value;
          const committedWorkspace = normalizeWorkspaceState({
            ...currentValue,
            project: projectToCommit,
          });

          return commitSessionEdit(
            currentHistory,
            committedWorkspace,
            edit,
            undoHistoryLimit,
          );
        });
        setSavedProjectFingerprint(
          createDirtyStateFingerprint(projectAfterRemoval),
        );
        authorizedProjectRootPathRef.current =
          projectRootState.projectRoot.rootPath;
        setProjectFileSaveState({
          savedProject: saveSettlement.savedProject,
          status: 'SAVED',
        });
        setProjectRootState((currentState) =>
          currentState.status === 'READY' &&
          currentState.projectRoot.rootPath ===
            projectRootState.projectRoot.rootPath
            ? {
                projectRoot: {
                  ...currentState.projectRoot,
                  projectFile: {
                    lastModifiedAt:
                      saveSettlement.savedProject.lastModifiedAt,
                    path: saveSettlement.savedProject.projectFilePath,
                    sizeBytes: saveSettlement.savedProject.bytesWritten,
                    status: 'EXISTS',
                  },
                },
                status: 'READY',
              }
            : currentState,
        );
        setHeaderHelpMessage(
          projectBecameStale
            ? `${removal.removedClipTake.label} was removed from the current Project while concurrent work was preserved. ${descriptor.name} was not deleted. Save Project to persist the newer work.`
            : deletionSettlement.fileDisposition === 'deleted'
              ? `${removal.removedClipTake.label} and ${descriptor.name} were deleted. This is a non-reversible Edit History checkpoint.`
              : deletionSettlement.fileDisposition === 'unknown'
                ? `${removal.removedClipTake.label} was removed from Project. The Engine response was lost, so ${descriptor.name} deletion is unknown and Undo is blocked for safety.`
                : `${removal.removedClipTake.label} was removed from Project, but ${descriptor.name} was preserved: ${deletionSettlement.message}`,
        );
      } finally {
        clipTakeFileDeletionInProgressRef.current = false;
        setIsClipTakeFileDeletionInProgress(false);
      }
    },
    [
      engineConnection.activity,
      engineConnection.lifecycle,
      isProjectRootOverwriteProtected,
      projectRootState,
      stopInstrumentAudioPreview,
    ],
  );

  const handleRequestDeleteClipTakeAndAudioFile = useCallback(
    (clipId: string, clipTakeId: string) => {
      const removal = planClipTakeRemoval(project, {
        clipId,
        clipTakeId,
        confirmActiveTakeRemoval: true,
        mode: 'project-and-audio-file',
      });

      if (!removal.canRemove || removal.fileAction.action !== 'delete') {
        setHeaderHelpMessage(
          removal.canRemove
            ? 'Clip Take removal did not resolve one deletable Audio file.'
            : removal.message,
        );
        return;
      }

      requestSafetyConfirm({
        title: 'Delete Clip Take and Audio File',
        message: `Permanently delete ${removal.removedClipTake.label} and ${removal.fileAction.descriptor.name}?`,
        confirmLabel: 'DELETE FILE',
        details: [
          'Project removal is saved before the physical WAV is deleted.',
          'Undo cannot cross this checkpoint after the WAV is deleted.',
          ...(removal.directDescendantArtifactIds.length > 0
            ? [
                `${removal.directDescendantArtifactIds.length} downstream Artifacts will retain broken lineage references.`,
              ]
            : []),
        ],
        onConfirm: () =>
          void deleteClipTakeAndAudioFile(clipId, clipTakeId),
      });
    },
    [deleteClipTakeAndAudioFile, project, requestSafetyConfirm],
  );

  const handleMoveTimelineClip = useCallback(
    (clipId: string, targetStartTick: number, options: TimelineClipMoveCommitOptions = {}) => {
      const preview = options.snapToAdjacentOnOverlap
        ? createTimelineClipDropUpdate(project.tracks, clipId, targetStartTick, project.totalTicks)
        : createTimelineClipMoveUpdate(project.tracks, clipId, targetStartTick, project.totalTicks);

      if (!preview.canMove) {
        showTimelineStatusFeedback({
          helpText: preview.message,
          message: 'MOVE BLOCKED',
          tone: 'warning',
        });
        return;
      }

      const currentClip = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId);

      if (!currentClip || currentClip.startTick === preview.clip.startTick) {
        return;
      }

      updateWorkspaceState((currentWorkspace) => {
        const result = options.snapToAdjacentOnOverlap
          ? createTimelineClipDropUpdate(
              currentWorkspace.project.tracks,
              clipId,
              targetStartTick,
              currentWorkspace.project.totalTicks,
            )
          : createTimelineClipMoveUpdate(
              currentWorkspace.project.tracks,
              clipId,
              targetStartTick,
              currentWorkspace.project.totalTicks,
            );

        if (!result.canMove) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          selectedClipId: result.clip.id,
          project: {
            ...currentWorkspace.project,
            tracks: result.tracks,
            selection: createSelectionFromItems([{ type: 'clip', id: result.clip.id }]),
          },
        };
      });
      showTimelineStatusFeedback({
        helpText:
          preview.adjustedForOverlap && preview.blockingClip
            ? `${preview.clip.name} snapped next to ${preview.blockingClip.name} at beat ${formatTickBeatPosition(
                preview.clip.startTick,
              )} on ${preview.track.name}.`
            : `${preview.clip.name} moved to beat ${formatTickBeatPosition(preview.clip.startTick)} on ${
                preview.track.name
              }.`,
        message: 'CLIP MOVED',
        tone: 'success',
      });
    },
    [project.totalTicks, project.tracks, showTimelineStatusFeedback, updateWorkspaceState],
  );

  const handleRightTrimTimelineAudioClip = useCallback(
    (clipId: string, targetEndTick: number) => {
      const preview = createAudioClipRightTrimUpdate(
        project.tracks,
        clipId,
        targetEndTick,
        project.totalTicks,
        project.bpm,
      );

      if (!preview.canTrim) {
        showTimelineStatusFeedback({
          helpText: preview.message,
          message: 'TRIM BLOCKED',
          tone: 'warning',
        });
        return;
      }

      const currentClip = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId);

      if (
        !currentClip ||
        (currentClip.lengthTicks === preview.clip.lengthTicks &&
          currentClip.audioTiming?.sourceEndSeconds === preview.clip.audioTiming?.sourceEndSeconds)
      ) {
        return;
      }

      updateWorkspaceState((currentWorkspace) => {
        const result = createAudioClipRightTrimUpdate(
          currentWorkspace.project.tracks,
          clipId,
          targetEndTick,
          currentWorkspace.project.totalTicks,
          currentWorkspace.project.bpm,
        );

        if (!result.canTrim) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          selectedClipId: result.clip.id,
          project: {
            ...currentWorkspace.project,
            tracks: result.tracks,
            selection: createSelectionFromItems([{ type: 'clip', id: result.clip.id }]),
          },
        };
      });
      showTimelineStatusFeedback({
        helpText: `${preview.clip.name} now uses ${formatDurationSeconds(
          getAudioClipSourceDurationSeconds(preview.clip.audioTiming),
        )} of ${preview.clip.sourceFile?.name ?? 'its source'}.`,
        message: 'CLIP TRIMMED',
        tone: 'success',
      });
    },
    [project.bpm, project.totalTicks, project.tracks, showTimelineStatusFeedback, updateWorkspaceState],
  );

  const handleRightResizeTimelineMidiClip = useCallback(
    (clipId: string, targetEndTick: number) => {
      const preview = createMidiClipRightResizeUpdate(
        project,
        clipId,
        targetEndTick,
      );

      if (!preview.canResize) {
        showTimelineStatusFeedback({
          helpText: preview.message,
          message: 'RESIZE BLOCKED',
          tone: 'warning',
        });
        return;
      }

      if (preview.status === 'UNCHANGED') {
        return;
      }

      updateWorkspaceState(
        (currentWorkspace) => {
          const result = createMidiClipRightResizeUpdate(
            currentWorkspace.project,
            clipId,
            targetEndTick,
          );

          if (!result.canResize || result.status === 'UNCHANGED') {
            return currentWorkspace;
          }

          return {
            ...currentWorkspace,
            selectedClipId: result.clip.id,
            project: {
              ...currentWorkspace.project,
              tracks: result.tracks,
              selection: createSelectionFromItems([
                { type: 'clip', id: result.clip.id },
              ]),
            },
          };
        },
        {
          category: 'clip',
          label: `${
            preview.status === 'SHORTENED' ? 'Shorten' : 'Extend'
          } ${preview.clip.name}`,
        },
      );
      const action =
        preview.status === 'SHORTENED' ? 'shortened' : 'extended';
      showTimelineStatusFeedback({
        helpText: `${preview.clip.name} ${action} to ${formatTickBeatLength(
          preview.clip.lengthTicks,
        )} beats.${
          preview.adjustedToNoteBoundary
            ? ' Last note boundary protected.'
            : ''
        } Piano Roll range updated.`,
        message:
          preview.status === 'SHORTENED'
            ? 'MIDI CLIP SHORTENED'
            : 'MIDI CLIP EXTENDED',
        tone: 'success',
      });
    },
    [
      project,
      showTimelineStatusFeedback,
      updateWorkspaceState,
    ],
  );

  const handleLeftTrimTimelineAudioClip = useCallback(
    (clipId: string, targetStartTick: number) => {
      const preview = createAudioClipLeftTrimUpdate(
        project.tracks,
        clipId,
        targetStartTick,
        project.totalTicks,
        project.bpm,
      );

      if (!preview.canTrim) {
        showTimelineStatusFeedback({
          helpText: preview.message,
          message: 'TRIM BLOCKED',
          tone: 'warning',
        });
        return;
      }

      const currentClip = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId);

      if (
        !currentClip ||
        (currentClip.startTick === preview.clip.startTick &&
          currentClip.lengthTicks === preview.clip.lengthTicks &&
          currentClip.audioTiming?.sourceStartSeconds === preview.clip.audioTiming.sourceStartSeconds)
      ) {
        return;
      }

      updateWorkspaceState((currentWorkspace) => {
        const result = createAudioClipLeftTrimUpdate(
          currentWorkspace.project.tracks,
          clipId,
          targetStartTick,
          currentWorkspace.project.totalTicks,
          currentWorkspace.project.bpm,
        );

        if (!result.canTrim) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          selectedClipId: result.clip.id,
          project: {
            ...currentWorkspace.project,
            tracks: result.tracks,
            selection: createSelectionFromItems([{ type: 'clip', id: result.clip.id }]),
          },
        };
      });
      showTimelineStatusFeedback({
        helpText: `${preview.clip.name} now uses ${formatDurationSeconds(
          getAudioClipSourceDurationSeconds(preview.clip.audioTiming),
        )} of ${preview.clip.sourceFile.name}.`,
        message: 'CLIP TRIMMED',
        tone: 'success',
      });
    },
    [project.bpm, project.totalTicks, project.tracks, showTimelineStatusFeedback, updateWorkspaceState],
  );

  const handleSplitTimelineAudioClip = useCallback(
    (clipId: string) => {
      const preview = createProjectAudioClipSplitUpdate(
        project,
        clipId,
        project.playheadTick,
      );

      if (!preview.canSplit) {
        showTimelineStatusFeedback({
          helpText: preview.message,
          message: 'SPLIT BLOCKED',
          tone: 'warning',
        });
        return;
      }

      updateWorkspaceState((currentWorkspace) => {
        const result = createProjectAudioClipSplitUpdate(
          currentWorkspace.project,
          clipId,
          currentWorkspace.project.playheadTick,
        );

        if (!result.canSplit) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          selectedClipId: result.rightClip.id,
          project: {
            ...currentWorkspace.project,
            tracks: result.tracks,
            selection: createSelectionFromItems([{ type: 'clip', id: result.rightClip.id }]),
          },
        };
      });
      showTimelineStatusFeedback({
        helpText: `${preview.leftClip.name} split at beat ${formatTickBeatPosition(
          preview.rightClip.startTick,
        )}. Both clips retain the same source identity.`,
        message: 'CLIP SPLIT',
        tone: 'success',
      });
    },
    [project, showTimelineStatusFeedback, updateWorkspaceState],
  );

  const handleSelectSourceIssue = useCallback(
    (clipId: string) => {
      handleSelectClip(clipId, 'replace');
      setTimelineRevealRequest((currentRequest) => ({
        clipId,
        requestId: (currentRequest?.requestId ?? 0) + 1,
      }));
    },
    [handleSelectClip],
  );

  const handleRequestRelinkSource = useCallback(
    (clipId: string) => {
      handleSelectSourceIssue(clipId);
      const selectedClip = findSelectedClip(
        workspaceRef.current.project.tracks,
        clipId,
      )?.clip;

      if (selectedClip?.sourceFile?.relativePath) {
        showTimelineStatusFeedback({
          helpText:
            'Generated audio is managed by the Project Root. Load the saved Project while the Local Engine is READY / IDLE and the Project Root is ready to restore it.',
          message: 'PROJECT ROOT RESTORE',
          tone: 'warning',
        });
        return;
      }

      pendingSourceRelinkClipIdRef.current = clipId;
      sourceRelinkInputRef.current?.click();
    },
    [handleSelectSourceIssue, showTimelineStatusFeedback],
  );

  const handleSelectTrack = useCallback(
    (trackId: string, selectionMode: SelectionMode = 'replace') => {
      if ((punchSessionRef.current?.attempts.length ?? 0) > 0) {
        setHeaderHelpMessage(
          'Track selection is frozen while Punch Attempts are unresolved. KEEP or DISCARD the Punch Session first.',
        );
        return;
      }

      setHeaderHelpMessage(createTrackHelpMessage(project.tracks.find((track) => track.id === trackId)));
      updateWorkspaceViewState((currentWorkspace) => {
        const trackSelectionItem: SelectionItem = { type: 'track', id: trackId };
        const currentSelection = normalizeSelectionState(currentWorkspace.project.selection, currentWorkspace.project.tracks);
        const currentTrackSelection = filterSelectionByType(currentSelection, 'track');
        const visibleTracks = getVisibleTracks(currentWorkspace.project.tracks);
        const nextSelection =
          selectionMode === 'toggle'
            ? toggleSelectionItem(currentTrackSelection, trackSelectionItem)
            : selectionMode === 'range'
              ? createTrackRangeSelection(currentTrackSelection, trackSelectionItem, visibleTracks)
              : createSingleSelection(trackSelectionItem);

        return {
          ...currentWorkspace,
          selectedClipId: '',
          project: {
            ...currentWorkspace.project,
            selection: nextSelection,
          },
        };
      });
    },
    [project.tracks, updateWorkspaceViewState],
  );

  const handleClearTimelineSelection = useCallback(() => {
    if ((punchSessionRef.current?.attempts.length ?? 0) > 0) {
      setHeaderHelpMessage(
        'Selection is frozen while Punch Attempts are unresolved. KEEP or DISCARD the Punch Session first.',
      );
      return;
    }

    updateWorkspaceViewState((currentWorkspace) => {
      if (currentWorkspace.selectedClipId === '' && currentWorkspace.project.selection.items.length === 0) {
        return currentWorkspace;
      }

      return {
        ...currentWorkspace,
        selectedClipId: '',
        project: {
          ...currentWorkspace.project,
          selection: createSelectionFromItems([]),
        },
      };
    });
    setHeaderHelpMessage('Timeline selection cleared.');
  }, [updateWorkspaceViewState]);

  const handleRenameTrack = useCallback(
    (trackId: string, name: string) => {
      updateWorkspaceState((currentWorkspace) => {
        const currentTrack = currentWorkspace.project.tracks.find((track) => track.id === trackId);
        const nextName = name.trim() || currentTrack?.name;

        if (!currentTrack || !nextName || currentTrack.name === nextName) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          project: {
            ...currentWorkspace.project,
            tracks: currentWorkspace.project.tracks.map((track) =>
              track.id === trackId ? { ...track, name: nextName } : track,
            ),
          },
        };
      });
    },
    [updateWorkspaceState],
  );

  const handleToggleTrackMute = useCallback(
    (trackId: string) => {
      const track = project.tracks.find((candidate) => candidate.id === trackId);

      if (!track) {
        setHeaderHelpMessage('Mute unavailable: the Track no longer exists.');
        return;
      }

      const groupResolution = track.group
        ? resolveGroupPlaybackTrack(track, project.tracks)
        : undefined;
      const muteTarget = groupResolution?.canResolve ? groupResolution.activeTrack : track.group ? undefined : track;

      if (!muteTarget) {
        setHeaderHelpMessage(`Mute unavailable: ${track.name} has no valid active child Track.`);
        return;
      }

      const nextMuted = muteTarget.muted !== true;

      updateWorkspaceState((currentWorkspace) => ({
        ...currentWorkspace,
        project: toggleProjectMixerChannelMute(currentWorkspace.project, muteTarget.id),
      }));
      setHeaderHelpMessage(
        `${track.group ? `${track.name} proxies ${muteTarget.name}. ` : ''}${muteTarget.name} ${
          nextMuted ? 'muted' : 'unmuted'
        }. ALL Playback and Mixdown respect Mute; Selection Playback ignores it. Active playback changes on the next PLAY.`,
      );
    },
    [project.tracks, updateWorkspaceState],
  );

  const handleAddBlankTrack = useCallback(() => {
    const previewTrack = createBlankTimelineTrack(project.tracks);

    updateWorkspaceState((currentWorkspace) => {
      const newTrack = createBlankTimelineTrack(currentWorkspace.project.tracks);

      return {
        ...currentWorkspace,
        selectedClipId: '',
        project: {
          ...currentWorkspace.project,
          tracks: [...currentWorkspace.project.tracks, newTrack],
          selection: createSelectionFromItems([{ type: 'track', id: newTrack.id }]),
        },
      };
    });
    setHeaderHelpMessage(createTrackHelpMessage(previewTrack));
  }, [project.tracks, updateWorkspaceState]);

  const handleCopyTimelineSelection = useCallback(() => {
    const availability = resolveTimelineCopyAvailability(project.tracks, project.selection);

    if (!availability.canCopy) {
      showTimelineStatusFeedback({
        helpText: availability.message,
        message: 'COPY UNAVAILABLE',
        tone: 'warning',
      });
      return;
    }

    const previewResult = copyTimelineSelection(project, availability);

    updateWorkspaceState(
      (currentWorkspace) => {
        const currentAvailability = resolveTimelineCopyAvailability(
          currentWorkspace.project.tracks,
          currentWorkspace.project.selection,
        );
        const copyResult = copyTimelineSelection(
          currentWorkspace.project,
          currentAvailability,
        );

        if (!copyResult) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          selectedClipId: '',
          project: copyResult.project,
        };
      },
      availability.mode === 'group'
        ? {
            category: 'track',
            label: `Copy Group: ${availability.sourceTrack?.name ?? 'Group Track'}`,
          }
        : undefined,
    );

    if (previewResult) {
      const helpText =
        availability.mode === 'clips'
          ? `Copied ${formatCount(availability.clipInfos.length, 'clip')} to ${previewResult.track.name}.`
          : availability.mode === 'group'
            ? `Copied Group ${availability.sourceTrack?.name ?? 'track'} to ${previewResult.track.name}.`
            : `Copied ${availability.sourceTrack?.name ?? 'track'} to ${previewResult.track.name}.`;

      showTimelineStatusFeedback({
        helpText,
        message:
          availability.mode === 'clips'
            ? `${availability.clipInfos.length} ${availability.clipInfos.length === 1 ? 'CLIP' : 'CLIPS'} COPIED`
            : availability.mode === 'group'
              ? 'GROUP COPIED'
              : 'TRACK COPIED',
        tone: 'success',
      });
    }
  }, [project.selection, project.tracks, showTimelineStatusFeedback, updateWorkspaceState]);

  const handleCopySelectedTimelineClips = useCallback(() => {
    const availability = getTimelineClipCopyAvailability(project.tracks, project.selection);

    if (!availability.canCopy || !availability.sourceTrack) {
      setHeaderHelpMessage(availability.message);
      return;
    }

    const clipboard = createTimelineClipClipboard(availability.sourceTrack, availability.clipInfos);
    setTimelineClipClipboard(clipboard);
    setHeaderHelpMessage(`Copied ${formatCount(clipboard.clips.length, 'clip')} from ${clipboard.sourceTrackName}.`);
  }, [project.selection, project.tracks]);

  const handlePasteTimelineClipClipboard = useCallback(
    (targetTrackId?: string) => {
      const availability = getTimelineClipPasteAvailability(
        project,
        project.selection,
        timelineClipClipboard,
        targetTrackId,
      );

      if (!availability.canPaste || !timelineClipClipboard) {
        setHeaderHelpMessage(availability.message);
        return;
      }

      updateWorkspaceState((currentWorkspace) => {
        const pasteResult = pasteTimelineClipClipboard(
          currentWorkspace.project,
          currentWorkspace.project.selection,
          timelineClipClipboard,
          targetTrackId,
        );

        if (!pasteResult) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          selectedClipId: pasteResult.pastedClips[0]?.id ?? '',
          project: {
            ...pasteResult.project,
            selection: createSelectionFromItems(
              pasteResult.pastedClips.map((clip): SelectionItem => ({ type: 'clip', id: clip.id })),
            ),
          },
        };
      });
      setHeaderHelpMessage(
        `Pasted ${formatCount(timelineClipClipboard.clips.length, 'clip')} to ${
          availability.targetTrack?.name ?? 'target track'
        } at beat ${formatTickBeatPosition(
          availability.startTick,
        )}.`,
      );
    },
    [project, timelineClipClipboard, updateWorkspaceState],
  );

  useEffect(() => {
    const handleTimelineClipboardKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || isEditableEventTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === 'c') {
        const hasClipSelection = project.selection.items.some((item) => item.type === 'clip');

        if (hasClipSelection) {
          event.preventDefault();
          handleCopySelectedTimelineClips();
        }
      }

      if (key === 'v') {
        if (timelineClipClipboard) {
          event.preventDefault();
          handlePasteTimelineClipClipboard();
        }
      }
    };

    window.addEventListener('keydown', handleTimelineClipboardKeyDown);

    return () => window.removeEventListener('keydown', handleTimelineClipboardKeyDown);
  }, [
    handleCopySelectedTimelineClips,
    handlePasteTimelineClipClipboard,
    project,
    timelineClipClipboard,
  ]);

  const handleGroupSelectedTracks = useCallback(() => {
    const availability = resolveTrackGroupingPlan(project.tracks, project.selection);

    if (!availability.canGroup) {
      showTimelineStatusFeedback({
        helpText: availability.message,
        message: 'GROUP UNAVAILABLE',
        tone: 'warning',
      });
      return;
    }

    updateWorkspaceState(
      (currentWorkspace) => {
        const application = applyTrackGroupingPlan(
          currentWorkspace.project,
          availability.plan,
        );
        return application.canApply
          ? { ...currentWorkspace, selectedClipId: '', project: application.project }
          : currentWorkspace;
      },
      { category: 'track', label: `Group ${availability.selectedCount} Track roots` },
    );
    showTimelineStatusFeedback({
      helpText: `Grouped ${availability.selectedCount} sibling Track roots.`,
      message: `${availability.selectedCount} TRACKS GROUPED`,
      tone: 'success',
    });
  }, [project.selection, project.tracks, showTimelineStatusFeedback, updateWorkspaceState]);

  const handleToggleTrackGroup = useCallback(
    (trackId: string) => {
      updateWorkspaceState((currentWorkspace) => {
        const application = applyTrackGroupCollapsedState(
          currentWorkspace.project,
          trackId,
        );
        return application.canApply
          ? { ...currentWorkspace, project: application.project }
          : currentWorkspace;
      });
    },
    [updateWorkspaceState],
  );

  const handleUngroupTrack = useCallback(
    (trackId: string) => {
      const planning = resolveTrackUngroupPlan(project.tracks, trackId);
      if (!planning.canUngroup) {
        showTimelineStatusFeedback({
          helpText: planning.message,
          message: 'UNGROUP UNAVAILABLE',
          tone: 'warning',
        });
        return;
      }
      const groupName = project.tracks.find((track) => track.id === trackId)?.name ?? 'Track Group';
      updateWorkspaceState(
        (currentWorkspace) => {
          const application = applyTrackUngroupPlan(
            currentWorkspace.project,
            planning.plan,
          );
          return application.canApply
            ? { ...currentWorkspace, selectedClipId: '', project: application.project }
            : currentWorkspace;
        },
        { category: 'track', label: `Ungroup: ${groupName}` },
      );
      showTimelineStatusFeedback({
        helpText: `Ungrouped ${groupName}. Direct children remain in place.`,
        message: 'TRACKS UNGROUPED',
        tone: 'success',
      });
    },
    [project.tracks, showTimelineStatusFeedback, updateWorkspaceState],
  );

  const handleDeleteTimelineSelection = useCallback((
    deletionPlan: Extract<TimelineTreeDeletionImpact, { canDelete: true }>['plan'],
  ) => {
    updateWorkspaceState((currentWorkspace) => {
      const application = applyTimelineTreeDeletionPlan(
        currentWorkspace.project,
        deletionPlan,
      );

      if (!application.canApply) {
        return currentWorkspace;
      }

      return {
        ...currentWorkspace,
        selectedClipId: '',
        project: application.project,
      };
    });
  }, [updateWorkspaceState]);

  const handleRequestDeleteTimelineSelection = useCallback(() => {
    const deletionImpact = getTimelineDeletionImpact(project.tracks, project.selection);

    if (!deletionImpact.canDelete) {
      showTimelineStatusFeedback({
        helpText: deletionImpact.message,
        message: 'SELECT TO DELETE',
        tone: 'warning',
      });
      return;
    }

    if (!isSafetyModeEnabled) {
      handleDeleteTimelineSelection(deletionImpact.plan);
      return;
    }

    requestSafetyConfirm({
      title: 'Delete Timeline Selection',
      message: 'Delete selected Timeline tracks and clips.',
      details: formatTimelineDeletionDetails(deletionImpact),
      confirmLabel: 'DELETE',
      onConfirm: () => handleDeleteTimelineSelection(deletionImpact.plan),
    });
  }, [
    handleDeleteTimelineSelection,
    isSafetyModeEnabled,
    project.selection,
    project.tracks,
    requestSafetyConfirm,
    showTimelineStatusFeedback,
  ]);

  useEffect(() => {
    const handleTimelineDeleteKeyDown = (event: KeyboardEvent) => {
      if (
        (event.key !== 'Delete' && event.key !== 'Backspace') ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        !project.selection.items.some((item) => item.type === 'clip' || item.type === 'track') ||
        !shouldHandleTimelineDeleteShortcut(event.target)
      ) {
        return;
      }

      event.preventDefault();
      handleRequestDeleteTimelineSelection();
    };

    window.addEventListener('keydown', handleTimelineDeleteKeyDown);

    return () => window.removeEventListener('keydown', handleTimelineDeleteKeyDown);
  }, [handleRequestDeleteTimelineSelection, project.selection.items]);

  useEffect(() => {
    const handleTimelineEscapeKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }

      if (safetyConfirmRequest) {
        event.preventDefault();
        clearSafetyConfirm();
        return;
      }

      if (
        (workspace.selectedClipId === '' && project.selection.items.length === 0) ||
        !shouldHandleTimelineClearSelectionShortcut(event.target)
      ) {
        return;
      }

      event.preventDefault();
      if (event.target instanceof HTMLElement) {
        event.target.blur();
      }
      handleClearTimelineSelection();
    };

    window.addEventListener('keydown', handleTimelineEscapeKeyDown);

    return () => window.removeEventListener('keydown', handleTimelineEscapeKeyDown);
  }, [
    clearSafetyConfirm,
    handleClearTimelineSelection,
    project.selection.items,
    safetyConfirmRequest,
    workspace.selectedClipId,
  ]);

  const handlePlaySelectedAudioClip = useCallback(() => {
    stopInstrumentAudioPreview(false);
    recordProjectPlaybackDiagnostic('legacy-clip-play-entry', {
      bpm: project.bpm,
      playheadTick: project.playheadTick,
      selectedClipId: workspace.selectedClipId,
    });

    if (
      audioClipPlaybackRuntimeRef.current.isPlaying() ||
      projectPlaybackRuntimeRef.current.isPlaying()
    ) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'legacy-playback-already-active',
        message: 'Audio playback is already active. Use STOP before starting again.',
      });
      setHeaderHelpMessage('Audio playback is already active. Use STOP before starting again.');
      return;
    }

    const availability = createAudioClipPlaybackPlan(
      project.tracks,
      workspace.selectedClipId,
      project.playheadTick,
      project.bpm,
    );

    if (!availability.canPlay) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'legacy-clip-plan',
        message: availability.message,
        reason: availability.reason,
      });
      showTimelineStatusFeedback({
        helpText: availability.message,
        message: 'PLAYBACK BLOCKED',
        tone: 'warning',
      });
      return;
    }

    const { plan } = availability;
    const file = sessionAudioSourcesRef.current.get(plan.sourceId);

    if (!file) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'legacy-session-source',
        message: `Playback blocked: ${plan.clip.sourceFile.name} is not available in this session. Relink the source first.`,
        sourceId: plan.sourceId,
      });
      showTimelineStatusFeedback({
        helpText: `Playback blocked: ${plan.clip.sourceFile.name} is not available in this session. Relink the source first.`,
        message: 'PLAYBACK BLOCKED',
        tone: 'warning',
      });
      return;
    }

    try {
      recordProjectPlaybackDiagnostic('legacy-runtime-dispatch', {
        fileName: file.name,
        fileSizeBytes: file.size,
        playbackEndSeconds: plan.playbackEndSeconds,
        playbackStartSeconds: plan.playbackStartSeconds,
        sourceId: plan.sourceId,
      });
      audioClipPlaybackRuntimeRef.current.play(file, plan, project.bpm, {
        onComplete: (completedPlan) => {
          updateWorkspaceViewState((currentWorkspace) => ({
            ...currentWorkspace,
            activeTransport: 'STOP',
            project: {
              ...currentWorkspace.project,
              playheadTick: completedPlan.clipEndTick,
              status: 'READY',
            },
          }));
          showTimelineStatusFeedback({
            helpText: `${completedPlan.clip.name} reached the end of its Clip source range.`,
            message: 'PLAYBACK COMPLETE',
            tone: 'success',
          });
        },
        onError: (message) => {
          updateWorkspaceViewState((currentWorkspace) => ({
            ...currentWorkspace,
            activeTransport: 'STOP',
            project: {
              ...currentWorkspace.project,
              status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
            },
          }));
          showTimelineStatusFeedback({
            helpText: message,
            message: 'PLAYBACK BLOCKED',
            tone: 'warning',
          });
        },
        onProgress: (nextPlayheadTick) => {
          updateWorkspaceViewState((currentWorkspace) =>
            currentWorkspace.project.playheadTick === nextPlayheadTick
              ? currentWorkspace
              : {
                  ...currentWorkspace,
                  project: {
                    ...currentWorkspace.project,
                    playheadTick: nextPlayheadTick,
                  },
                },
          );
        },
      }, { loopEnabled: project.isLooping });

      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        activeTransport: 'PLAY',
        project: {
          ...currentWorkspace.project,
          playheadTick: plan.playbackStartTick,
          status: 'PLAYING',
        },
      }));
      setHeaderHelpMessage(
        `Playing ${plan.clip.name} from ${formatDurationSeconds(plan.playbackStartSeconds)} to ${formatDurationSeconds(
          plan.playbackEndSeconds,
        )}.`,
      );
    } catch (error) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'legacy-runtime-dispatch',
        message: error instanceof Error ? error.message : 'Playback failed unexpectedly.',
      });
      showTimelineStatusFeedback({
        helpText: error instanceof Error ? `Playback failed: ${error.message}` : 'Playback failed unexpectedly.',
        message: 'PLAYBACK BLOCKED',
        tone: 'warning',
      });
    }
  }, [
    project.bpm,
    project.isLooping,
    project.playheadTick,
    project.tracks,
    showTimelineStatusFeedback,
    stopInstrumentAudioPreview,
    updateWorkspaceViewState,
    workspace.selectedClipId,
  ]);

  const handlePlayProjectTarget = useCallback(async () => {
    stopInstrumentAudioPreview(false);
    resetProjectPlaybackDiagnostics({
      activeTransport: workspace.activeTransport,
      artifactCount: project.artifacts?.length ?? 0,
      origin: 'timeline-ui',
      playheadTick: project.playheadTick,
      projectRootStatus: projectRootState.status,
      selectedItems: project.selection.items,
      trackCount: project.tracks.length,
    });

    if (
      audioClipPlaybackRuntimeRef.current.isPlaying() ||
      projectPlaybackRuntimeRef.current.isPlaying()
    ) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'playback-already-active',
        message: 'Audio playback is already active. Use STOP before starting again.',
      });
      setHeaderHelpMessage('Audio playback is already active. Use STOP before starting again.');
      return;
    }

    if (midiClipPlaybackPreparationAbortControllerRef.current) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'midi-cache-preparation-active',
        message: 'MIDI Clip playback preparation is already active. Use STOP before starting again.',
      });
      setHeaderHelpMessage(
        'MIDI Clip playback preparation is already active. Use STOP before starting again.',
      );
      return;
    }

    let midiPlaybackPreparation: MidiClipPlaybackCachePreparation | undefined;

    if (hasRequestedSoundFontMidiClips(project)) {
      const operationId =
        ++midiClipPlaybackPreparationOperationIdRef.current;
      const abortController = new AbortController();
      midiClipPlaybackPreparationAbortControllerRef.current = abortController;
      const projectFingerprint = createDirtyStateFingerprint(project);
      const resources =
        soundFontCatalogState.status === 'READY'
          ? soundFontCatalogState.catalog.resources
          : [];
      setHeaderHelpMessage(
        'Preparing assigned MIDI Clip voices for Timeline playback. Project data remains unchanged.',
      );

      try {
        midiPlaybackPreparation = await midiClipPlaybackCacheRef.current.prepare(
          project,
          resources,
          localEngineClientRef.current,
          abortController.signal,
        );
      } catch (error) {
        if (
          abortController.signal.aborted ||
          operationId !== midiClipPlaybackPreparationOperationIdRef.current
        ) {
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : 'MIDI Clip SoundFont playback preparation failed.';
        recordProjectPlaybackDiagnostic('ui-play-blocked', {
          gate: 'midi-cache-preparation',
          message,
        });
        showTimelineStatusFeedback({
          helpText: message,
          message: 'PLAYBACK LOCKED',
          tone: 'warning',
        });
        return;
      } finally {
        if (
          midiClipPlaybackPreparationAbortControllerRef.current ===
          abortController
        ) {
          midiClipPlaybackPreparationAbortControllerRef.current = undefined;
        }
      }

      if (
        operationId !== midiClipPlaybackPreparationOperationIdRef.current ||
        projectFingerprint !==
          createDirtyStateFingerprint(workspaceRef.current.project)
      ) {
        recordProjectPlaybackDiagnostic('ui-play-blocked', {
          gate: 'midi-cache-project-drift',
          message: 'Project content changed while MIDI Clip playback was being prepared.',
        });
        showTimelineStatusFeedback({
          helpText:
            'Project content changed while MIDI Clip playback was being prepared. Press PLAY again.',
          message: 'PLAYBACK LOCKED',
          tone: 'warning',
        });
        return;
      }

      recordProjectPlaybackDiagnostic('ui-midi-cache-ready', {
        renderedCount: midiPlaybackPreparation.renderedCount,
        reusedCount: midiPlaybackPreparation.reusedCount,
        sourceCount: midiPlaybackPreparation.sources.size,
      });
    }

    const generatedAudioReader = localEngineClientRef.current;
    const canReadGeneratedAudio = canReadGeneratedAudioForProjectPlayback({
      hasGeneratedAudioReader: Boolean(generatedAudioReader),
      projectRootReady: projectRootState.status === 'READY',
    });
    recordProjectPlaybackDiagnostic('ui-source-readiness', {
      canReadGeneratedAudio,
      hasGeneratedAudioReader: Boolean(generatedAudioReader),
      projectRootStatus: projectRootState.status,
    });
    const sourceAvailability = {
      ...createProjectPlaybackSourceAvailabilitySnapshot(
        project,
        sessionAudioSourcesRef.current,
        canReadGeneratedAudio,
      ),
      ...Object.fromEntries(
        [...(midiPlaybackPreparation?.sources.keys() ?? [])].map(
          (sourceId) => [sourceId, 'openable' as const],
        ),
      ),
    };
    const purpose = project.selection.items.length === 0 ? 'all-playback' : 'selection-playback';
    const createPlanAt = (playheadTick: number) =>
      createProjectPlaybackPlan({
        artifacts: project.artifacts,
        bpm: project.bpm,
        mixer: project.mixer,
        midiPlaybackSources: midiPlaybackPreparation?.snapshot,
        playheadTick,
        projectEndTick: project.totalTicks,
        purpose,
        selection: project.selection,
        sourceAvailability,
        tracks: project.tracks,
      });
    const availability = createPlanAt(project.playheadTick);

    if (!availability.canPlay) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'initial-plan',
        message: availability.message,
        reason: availability.reason,
      });
      showTimelineStatusFeedback({
        helpText: availability.message,
        message: 'PLAYBACK LOCKED',
        tone: 'warning',
      });
      return;
    }

    const isLoopAvailable = isProjectPlaybackLoopAvailable(availability.plan);
    const shouldLoop = project.isLooping && isLoopAvailable;
    const isAllPlayback = availability.plan.target.kind === 'all';
    const { startTick: audibleStartTick, endTick: audibleEndTick } =
      availability.plan.audibleRange;
    const isPlayheadInsideAudibleRange =
      project.playheadTick >= audibleStartTick && project.playheadTick < audibleEndTick;
    const activePlanAvailability =
      shouldLoop && isAllPlayback && !isPlayheadInsideAudibleRange
        ? createPlanAt(audibleStartTick)
        : availability;

    if (!activePlanAvailability.canPlay) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'active-plan',
        message: activePlanAvailability.message,
        reason: activePlanAvailability.reason,
      });
      showTimelineStatusFeedback({
        helpText: activePlanAvailability.message,
        message: 'PLAYBACK LOCKED',
        tone: 'warning',
      });
      return;
    }

    const activePlan = activePlanAvailability.plan;
    const scheduleAvailability = createProjectPlaybackSchedule(
      activePlan,
      project.bpm,
      shouldLoop && isAllPlayback
        ? { endTick: activePlan.audibleRange.endTick }
        : undefined,
    );

    if (!scheduleAvailability.canSchedule) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'active-schedule',
        message: scheduleAvailability.message,
        reason: scheduleAvailability.reason,
      });
      showTimelineStatusFeedback({
        helpText: scheduleAvailability.message,
        message: 'PLAYBACK LOCKED',
        tone: 'warning',
      });
      return;
    }

    const loopPlanAvailability = isLoopAvailable
      ? createPlanAt(activePlan.audibleRange.startTick)
      : undefined;

    if (loopPlanAvailability && !loopPlanAvailability.canPlay) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'loop-plan',
        message: loopPlanAvailability.message,
        reason: loopPlanAvailability.reason,
      });
      showTimelineStatusFeedback({
        helpText: loopPlanAvailability.message,
        message: 'PLAYBACK LOCKED',
        tone: 'warning',
      });
      return;
    }

    const loopScheduleAvailability =
      loopPlanAvailability?.canPlay
        ? createProjectPlaybackSchedule(
            loopPlanAvailability.plan,
            project.bpm,
            isAllPlayback
              ? { endTick: loopPlanAvailability.plan.audibleRange.endTick }
              : undefined,
          )
        : undefined;

    if (loopScheduleAvailability && !loopScheduleAvailability.canSchedule) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'loop-schedule',
        message: loopScheduleAvailability.message,
        reason: loopScheduleAvailability.reason,
      });
      showTimelineStatusFeedback({
        helpText: loopScheduleAvailability.message,
        message: 'PLAYBACK LOCKED',
        tone: 'warning',
      });
      return;
    }

    const schedules = [
      scheduleAvailability.schedule,
      ...(loopScheduleAvailability?.canSchedule ? [loopScheduleAvailability.schedule] : []),
    ];
    const audioSources = collectProjectPlaybackAudioSources(
      schedules,
      sessionAudioSourcesRef.current,
      canReadGeneratedAudio ? generatedAudioReader : undefined,
      midiPlaybackPreparation?.sources,
    );

    if (!audioSources.canOpen) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'audio-source-collection',
        message: audioSources.message,
      });
      showTimelineStatusFeedback({
        helpText: audioSources.message,
        message: 'PLAYBACK LOCKED',
        tone: 'warning',
      });
      return;
    }

    const targetLabel = createProjectPlaybackTargetLabel(activePlan, project.tracks);
    const loopSchedule = loopScheduleAvailability?.canSchedule
      ? loopScheduleAvailability.schedule
      : undefined;

    try {
      recordProjectPlaybackDiagnostic('ui-runtime-dispatch', {
        sourceCount: audioSources.sources.size,
        target: activePlan.target,
      });
      projectPlaybackMeterStore.clear();
      projectPlaybackRuntimeRef.current.play(
        audioSources.sources,
        scheduleAvailability.schedule,
        project.bpm,
        {
          onComplete: (completedSchedule) => {
            projectPlaybackMeterStore.clear();
            updateWorkspaceViewState((currentWorkspace) => ({
              ...currentWorkspace,
              activeTransport: 'STOP',
              project: {
                ...currentWorkspace.project,
                playheadTick: completedSchedule.endTick,
                status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
              },
            }));
            showTimelineStatusFeedback({
              helpText: `${targetLabel} reached the end of its frozen Playback Plan.`,
              message: 'PLAYBACK COMPLETE',
              tone: 'success',
            });
          },
          onError: (message) => {
            projectPlaybackMeterStore.clear();
            updateWorkspaceViewState((currentWorkspace) => ({
              ...currentWorkspace,
              activeTransport: 'STOP',
              project: {
                ...currentWorkspace.project,
                status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
              },
            }));
            showTimelineStatusFeedback({
              helpText: message,
              message: 'PLAYBACK BLOCKED',
              tone: 'warning',
            });
          },
          onProgress: (nextPlayheadTick) => {
            updateWorkspaceViewState((currentWorkspace) =>
              currentWorkspace.project.playheadTick === nextPlayheadTick
                ? currentWorkspace
                : {
                    ...currentWorkspace,
                    project: {
                      ...currentWorkspace.project,
                      playheadTick: nextPlayheadTick,
                    },
                  },
            );
          },
          onMeterSnapshot: (snapshot) => {
            projectPlaybackMeterStore.publish(snapshot);
          },
          onStarted: (startedSchedule) => {
            const scheduledClipCount = startedSchedule.tracks.reduce(
              (count, track) => count + track.events.length,
              0,
            );
            const isIncomplete = startedSchedule.plan.isIncomplete;

            updateWorkspaceViewState((currentWorkspace) => ({
              ...currentWorkspace,
              activeTransport: 'PLAY',
              project: {
                ...currentWorkspace.project,
                playheadTick: startedSchedule.startTick,
                status: isIncomplete ? 'PLAYING INCOMPLETE' : 'PLAYING',
              },
            }));
            setHeaderHelpMessage(
              `Playing ${targetLabel}: ${startedSchedule.tracks.length} Tracks, ${scheduledClipCount} playable Clips.`,
            );

            if (isIncomplete) {
              showTimelineStatusFeedback({
                helpText: `${targetLabel} skipped ${formatCount(
                  startedSchedule.plan.missingSourceCount,
                  'source',
                )} that need Relink or session access.`,
                message: 'ALL PLAYBACK — INCOMPLETE',
                tone: 'warning',
              });
            }
          },
        },
        {
          loopEnabled: shouldLoop,
          loopSchedule,
        },
      );

      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        activeTransport: 'PLAY',
        project: {
          ...currentWorkspace.project,
          status: 'PREPARING PLAYBACK',
        },
      }));
      setHeaderHelpMessage(`Preparing ${targetLabel} audio sources for playback.`);
    } catch (error) {
      recordProjectPlaybackDiagnostic('ui-play-blocked', {
        gate: 'runtime-dispatch',
        message: error instanceof Error ? error.message : 'Playback failed unexpectedly.',
      });
      showTimelineStatusFeedback({
        helpText: error instanceof Error ? `Playback failed: ${error.message}` : 'Playback failed unexpectedly.',
        message: 'PLAYBACK BLOCKED',
        tone: 'warning',
      });
    }
  }, [
    project.bpm,
    project.artifacts,
    project.isLooping,
    project.mixer,
    project.playheadTick,
    project.selection,
    project.totalTicks,
    project.tracks,
    projectRootState.status,
    showTimelineStatusFeedback,
    soundFontCatalogState,
    stopInstrumentAudioPreview,
    updateWorkspaceViewState,
    workspace.activeTransport,
  ]);

  const handlePlayCurrentTarget = useCallback(() => {
    const selectedItems = project.selection.items;
    recordProjectPlaybackDiagnostic('ui-play-target-resolution', {
      selectedItems,
      selectedClipId: workspace.selectedClipId,
    });

    if (selectedItems.length === 1 && selectedItems[0].type === 'clip') {
      const selectedClip = project.tracks
        .flatMap((track) => track.clips)
        .find((clip) => clip.id === selectedItems[0].id);
      recordProjectPlaybackDiagnostic('ui-selected-clip-resolved', {
        activeClipTakeId: selectedClip?.activeClipTakeId,
        clipId: selectedClip?.id,
        clipType: selectedClip?.type,
        hasSourceFile: Boolean(selectedClip?.sourceFile),
        isSourceBackedAudioClip: Boolean(
          selectedClip && isSourceBackedAudioClip(selectedClip),
        ),
      });

      if (
        selectedClip &&
        !selectedClip.activeClipTakeId &&
        isSourceBackedAudioClip(selectedClip)
      ) {
        recordProjectPlaybackDiagnostic('ui-play-route-selected', {
          route: 'legacy-session-audio-clip',
        });
        handlePlaySelectedAudioClip();
        return;
      }
    }

    recordProjectPlaybackDiagnostic('ui-play-route-selected', {
      route: 'project-playback',
    });
    void handlePlayProjectTarget();
  }, [
    handlePlayProjectTarget,
    handlePlaySelectedAudioClip,
    project.selection.items,
    project.tracks,
    workspace.selectedClipId,
  ]);

  const handlePreviewClipTake = useCallback((clipId: string, clipTakeId: string) => {
    stopSoundFontAudition(false);
    const activePreview = instrumentAudioPreviewRuntimeRef.current.isActive()
      ? releaseInstrumentAudioPreview()
      : undefined;

    if (
      activePreview?.clipId === clipId &&
      activePreview.clipTakeId === clipTakeId
    ) {
      setInstrumentAudioPreviewState({
        artifactId: activePreview.artifactId,
        clipTakeId: activePreview.clipTakeId,
        message: `${activePreview.clipName} Take preview stopped.`,
        status: 'IDLE',
        targetClipId: activePreview.clipId,
        targetClipName: activePreview.clipName,
      });
      setHeaderHelpMessage(
        `${activePreview.clipName} Take preview stopped. Project data was unchanged.`,
      );
      return;
    }

    const currentAvailability = engineAvailabilityRef.current;
    const currentWorkspace = workspaceRef.current;
    const client = localEngineClientRef.current;

    if (currentAvailability.productionEditingLocked || !client) {
      setInstrumentAudioPreviewState({
        message: currentAvailability.message,
        status: 'ERROR',
      });
      setHeaderHelpMessage(currentAvailability.message);
      return;
    }

    if (projectRootState.status !== 'READY') {
      const message = 'Select a ready Project Root to read the generated WAV.';
      setInstrumentAudioPreviewState({ message, status: 'ERROR' });
      setHeaderHelpMessage(message);
      return;
    }

    if (recordingRuntimePhaseRef.current !== 'IDLE') {
      const message = 'Stop the active recording operation before previewing a Take.';
      setInstrumentAudioPreviewState({ message, status: 'ERROR' });
      setHeaderHelpMessage(message);
      return;
    }

    if (
      audioClipPlaybackRuntimeRef.current.isPlaying() ||
      projectPlaybackRuntimeRef.current.isPlaying()
    ) {
      const message = 'Stop Timeline playback before previewing a Take.';
      setInstrumentAudioPreviewState({ message, status: 'ERROR' });
      setHeaderHelpMessage(message);
      return;
    }

    const resolution = resolveClipTakeAudioPreview(
      currentWorkspace.project,
      clipId,
      clipTakeId,
    );

    if (!resolution.canPreview) {
      setInstrumentAudioPreviewState({
        message: resolution.message,
        status: 'ERROR',
        targetClipId: clipId,
      });
      setHeaderHelpMessage(resolution.message);
      return;
    }

    const operationId = ++instrumentAudioPreviewOperationIdRef.current;
    const previewPlan: InstrumentAudioPreviewPlan = {
      artifactId: resolution.plan.artifact.artifactId,
      clipId: resolution.plan.clip.id,
      clipName: resolution.plan.clip.name,
      clipTakeId: resolution.plan.take.clipTakeId,
      gainDb: resolution.plan.track.level,
      sourceId: resolution.plan.descriptor.sourceId,
    };

    setInstrumentAudioPreviewState({
      artifactId: previewPlan.artifactId,
      clipTakeId: previewPlan.clipTakeId,
      message: `Reading ${resolution.plan.artifact.file.name} from the Project Root.`,
      status: 'LOADING',
      targetClipId: previewPlan.clipId,
      targetClipName: previewPlan.clipName,
    });
    setHeaderHelpMessage(
      `Preparing ${resolution.plan.take.label} preview at ${previewPlan.gainDb} dB Track Gain.`,
    );

    const wavPromise = client
      .readGeneratedAudioWav(resolution.plan.descriptor)
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.message);
        }

        return result.wav;
      });

    try {
      instrumentAudioPreviewRuntimeRef.current.play(
        wavPromise,
        previewPlan,
        {
          onComplete: (completedPlan) => {
            if (instrumentAudioPreviewOperationIdRef.current !== operationId) {
              return;
            }

            setInstrumentAudioPreviewState({
              artifactId: completedPlan.artifactId,
              clipTakeId: completedPlan.clipTakeId,
              message: `${completedPlan.clipName} preview complete.`,
              status: 'IDLE',
              targetClipId: completedPlan.clipId,
              targetClipName: completedPlan.clipName,
            });
            setHeaderHelpMessage(
              `${completedPlan.clipName} Take preview complete. Project data was unchanged.`,
            );
          },
          onError: (message, failedPlan) => {
            if (instrumentAudioPreviewOperationIdRef.current !== operationId) {
              return;
            }

            setInstrumentAudioPreviewState({
              artifactId: failedPlan.artifactId,
              clipTakeId: failedPlan.clipTakeId,
              message,
              status: 'ERROR',
              targetClipId: failedPlan.clipId,
              targetClipName: failedPlan.clipName,
            });
            setHeaderHelpMessage(message);
          },
          onStarted: (startedPlan) => {
            if (instrumentAudioPreviewOperationIdRef.current !== operationId) {
              return;
            }

            setInstrumentAudioPreviewState({
              artifactId: startedPlan.artifactId,
              clipTakeId: startedPlan.clipTakeId,
              message: `${startedPlan.clipName} Take is playing at ${startedPlan.gainDb} dB Track Gain.`,
              status: 'PLAYING',
              targetClipId: startedPlan.clipId,
              targetClipName: startedPlan.clipName,
            });
            setHeaderHelpMessage(
              `Previewing ${startedPlan.clipName} Take. Project data and the Timeline transport are unchanged.`,
            );
          },
        },
      );
    } catch (error) {
      if (instrumentAudioPreviewOperationIdRef.current !== operationId) {
        return;
      }

      const message =
        error instanceof Error
          ? `Instrument Audio Preview failed: ${error.message}`
          : 'Instrument Audio Preview failed unexpectedly.';

      setInstrumentAudioPreviewState({
        artifactId: previewPlan.artifactId,
        clipTakeId: previewPlan.clipTakeId,
        message,
        status: 'ERROR',
        targetClipId: previewPlan.clipId,
        targetClipName: previewPlan.clipName,
      });
      setHeaderHelpMessage(message);
    }
  }, [
    projectRootState.status,
    releaseInstrumentAudioPreview,
    stopSoundFontAudition,
  ]);

  const handleSetPunchMarker = useCallback(
    (marker: 'in' | 'out') => {
      if (recordingRuntimePhaseRef.current !== 'IDLE') {
        setHeaderHelpMessage('Punch IN / OUT is frozen while recording is active.');
        return;
      }

      if ((punchSessionRef.current?.attempts.length ?? 0) > 0) {
        setHeaderHelpMessage(
          'KEEP SELECTED AS NEW TAKE or DISCARD SESSION before changing the Punch range.',
        );
        return;
      }

      const tick = workspaceRef.current.project.playheadTick;
      const toggled = togglePunchMarker(
        { inTick: punchInTick, outTick: punchOutTick },
        marker,
        tick,
      );

      if (toggled.status === 'rejected') {
        setHeaderHelpMessage(
          marker === 'in'
            ? 'PUNCH IN must be before the enabled PUNCH OUT. Move the Playhead earlier and try again.'
            : 'PUNCH OUT must be after the enabled PUNCH IN. Move the Playhead later and try again.',
        );
        return;
      }

      setPunchSession(undefined);
      setPunchInTick(toggled.state.inTick);
      setPunchOutTick(toggled.state.outTick);

      if (toggled.status === 'cleared') {
        setHeaderHelpMessage(
          `PUNCH ${marker.toUpperCase()} cleared. Punch recording is OFF until both markers are enabled.`,
        );
        return;
      }

      if (
        toggled.state.inTick !== undefined &&
        toggled.state.outTick !== undefined
      ) {
        setHeaderHelpMessage(
          `PUNCH ENABLED: IN ${formatTickBeatPosition(toggled.state.inTick)} — OUT ${formatTickBeatPosition(toggled.state.outTick)}.`,
        );
        return;
      }

      setHeaderHelpMessage(
        `PUNCH ${marker.toUpperCase()} enabled at beat ${formatTickBeatPosition(tick)}. Enable the other marker to arm Punch recording.`,
      );
    },
    [punchInTick, punchOutTick],
  );

  const handleSelectPunchAttempt = useCallback((punchAttemptId: string) => {
    setPunchSession((currentSession) =>
      currentSession
        ? selectPunchAttempt(currentSession, punchAttemptId)
        : currentSession,
    );
  }, []);

  const handleDiscardPunchSession = useCallback(() => {
    if (recordingRuntimePhaseRef.current !== 'IDLE') {
      setHeaderHelpMessage('Stop the active Punch recording before discarding its session.');
      return;
    }

    const attemptCount = punchSessionRef.current?.attempts.length ?? 0;
    setPunchSession(undefined);
    setHeaderHelpMessage(
      attemptCount > 0
        ? `PUNCH SESSION DISCARDED: ${attemptCount} temporary Attempt${attemptCount === 1 ? '' : 's'} released. This action is not in Undo History.`
        : 'Punch Session cleared.',
    );
  }, []);

  const handlePreviewPunchAttempt = useCallback(async () => {
    const session = punchSessionRef.current;
    const attempt = session ? getSelectedPunchAttempt(session) : undefined;

    if (!session || !attempt) {
      setHeaderHelpMessage('Select one Punch Attempt before Preview.');
      return;
    }

    if (recordingRuntimePhaseRef.current !== 'IDLE') {
      setHeaderHelpMessage('Stop the active recording before previewing a Punch Attempt.');
      return;
    }

    stopInstrumentAudioPreview(false);
    stopActiveAudioPlayback(false);
    setHeaderHelpMessage('Preparing temporary Punch Attempt preview. Project data is unchanged.');

    try {
      const materialization = await materializePunchAudio(
        session,
        attempt,
        workspaceRef.current.project.bpm,
      );
      const contextTicks = secondsToTimelineTicks(
        1,
        workspaceRef.current.project.bpm,
      );
      const previewStartTick = Math.max(
        session.clip.startTick,
        session.range.inTick - contextTicks,
      );
      const previewEndTick = Math.min(
        session.clip.startTick + session.clip.lengthTicks,
        session.range.outTick + contextTicks,
      );
      const clipTiming = session.clip.audioTiming;

      if (!clipTiming) {
        throw new Error('Punch Base Clip timing is unavailable.');
      }

      const previewPlan: AudioClipPlaybackPlan = {
        clip: {
          ...session.clip,
          audioTiming: clipTiming,
          sourceFile: {
            checkedAt: attempt.createdAt,
            durationSeconds: materialization.durationSeconds,
            mimeType: 'audio/wav',
            name: `${attempt.punchAttemptId}.wav`,
            sizeBytes: materialization.byteLength,
            sourceId: attempt.punchAttemptId,
            status: 'available',
          },
        },
        clipEndTick: previewEndTick,
        clipStartTick: session.clip.startTick,
        playbackEndSeconds:
          clipTiming.sourceStartSeconds +
          timelineTicksToSeconds(
            previewEndTick - session.clip.startTick,
            workspaceRef.current.project.bpm,
          ),
        playbackStartSeconds:
          clipTiming.sourceStartSeconds +
          timelineTicksToSeconds(
            previewStartTick - session.clip.startTick,
            workspaceRef.current.project.bpm,
          ),
        playbackStartTick: previewStartTick,
        sourceId: attempt.punchAttemptId,
      };
      const previewFile = new File(
        [materialization.blob],
        `${attempt.punchAttemptId}.wav`,
        { type: 'audio/wav' },
      );

      audioClipPlaybackRuntimeRef.current.play(
        previewFile,
        previewPlan,
        workspaceRef.current.project.bpm,
        {
          onComplete: (completedPlan) => {
            updateWorkspaceViewState((currentWorkspace) => ({
              ...currentWorkspace,
              activeTransport: 'STOP',
              project: {
                ...currentWorkspace.project,
                playheadTick: completedPlan.clipEndTick,
                status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
              },
            }));
            setHeaderHelpMessage('Punch Attempt preview complete. Project data was unchanged.');
          },
          onError: (message) => {
            updateWorkspaceViewState((currentWorkspace) => ({
              ...currentWorkspace,
              activeTransport: 'STOP',
              project: { ...currentWorkspace.project, status: 'READY' },
            }));
            setHeaderHelpMessage(message);
          },
          onProgress: (playheadTick) =>
            updateWorkspaceViewState((currentWorkspace) => ({
              ...currentWorkspace,
              project: { ...currentWorkspace.project, playheadTick },
            })),
        },
      );
      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        activeTransport: 'PLAY',
        project: {
          ...currentWorkspace.project,
          playheadTick: previewStartTick,
          status: 'PUNCH PREVIEW',
        },
      }));
    } catch (error) {
      setHeaderHelpMessage(
        error instanceof Error
          ? `PUNCH PREVIEW FAILED: ${error.message}`
          : 'PUNCH PREVIEW FAILED unexpectedly.',
      );
    }
  }, [
    stopActiveAudioPlayback,
    stopInstrumentAudioPreview,
    updateWorkspaceViewState,
  ]);

  const handleKeepPunchAttempt = useCallback(async () => {
    const session = punchSessionRef.current;
    const attempt = session ? getSelectedPunchAttempt(session) : undefined;
    const client = localEngineClientRef.current;

    if (!session || !attempt) {
      setHeaderHelpMessage('Select one Punch Attempt before KEEP.');
      return;
    }

    if (
      recordingRuntimePhaseRef.current !== 'IDLE' ||
      !client ||
      projectRootState.status !== 'READY'
    ) {
      setHeaderHelpMessage(
        'KEEP requires an idle recording runtime, connected Local Engine, and writable Project Root.',
      );
      return;
    }

    updateRecordingRuntimePhase('SAVING');
    setHeaderHelpMessage(
      'Materializing one full Punch Take. Temporary Attempts remain recoverable until registration succeeds.',
    );

    try {
      const materialization = await materializePunchAudio(
        session,
        attempt,
        workspaceRef.current.project.bpm,
      );
      const saved = await client.saveRecordingWav(materialization.blob);

      if (!saved.ok) {
        throw new Error(saved.message);
      }

      const registration = createPunchTakeRegistration(
        workspaceRef.current.project,
        session,
        attempt,
        saved.recording,
        materialization,
      );

      if (!registration.canRegister) {
        throw new Error(
          `${registration.message} The completed WAV remains stored at ${saved.recording.file.relativePath}.`,
        );
      }

      const lastModified = Date.parse(saved.recording.createdAt);
      sessionAudioSourcesRef.current.register(
        saved.recording.artifactId,
        new File([materialization.blob], saved.recording.file.name, {
          lastModified: Number.isFinite(lastModified) ? lastModified : Date.now(),
          type: 'audio/wav',
        }),
      );
      updateWorkspaceState(
        (currentWorkspace) => {
          const currentRegistration = createPunchTakeRegistration(
            currentWorkspace.project,
            session,
            attempt,
            saved.recording,
            materialization,
          );

          return currentRegistration.canRegister
            ? {
                ...currentWorkspace,
                activeTransport: 'STOP',
                selectedClipId: currentRegistration.clip.id,
                project: {
                  ...currentRegistration.project,
                  playheadTick: session.range.outTick,
                  selection: createSelectionFromItems([
                    { id: currentRegistration.clip.id, type: 'clip' },
                  ]),
                  status: currentRegistration.project.isLooping ? 'LOOP READY' : 'READY',
                },
              }
            : currentWorkspace;
        },
        {
          allowDuringPunchSession: true,
          category: 'take',
          label: 'Keep Punch Take',
        },
      );
      setPunchSession(undefined);
      setHeaderHelpMessage(
        `${registration.clipTake.label} is now Active on ${registration.clip.name}. Undo removes the Project registration; Redo reuses the same saved WAV.`,
      );
    } catch (error) {
      setHeaderHelpMessage(
        error instanceof Error
          ? `PUNCH KEEP FAILED: ${error.message} Temporary Attempts were preserved.`
          : 'PUNCH KEEP FAILED unexpectedly. Temporary Attempts were preserved.',
      );
    } finally {
      updateRecordingRuntimePhase('IDLE');
    }
  }, [projectRootState.status, updateRecordingRuntimePhase, updateWorkspaceState]);

  const handleStartPunchRecording = useCallback(async () => {
    if (recordingRuntimePhaseRef.current !== 'IDLE') {
      setHeaderHelpMessage('Stop the active recording operation before starting another Punch Attempt.');
      return;
    }

    const currentProject = workspaceRef.current.project;
    const target = resolvePunchTarget(
      currentProject,
      workspaceRef.current.selectedClipId,
      punchInTick,
      punchOutTick,
    );

    if (!target.canStart) {
      showTimelineStatusFeedback({
        helpText: target.message,
        message: 'PUNCH LOCKED',
        tone: 'warning',
      });
      return;
    }

    if (currentProject.playheadTick >= target.range.outTick) {
      showTimelineStatusFeedback({
        helpText: 'Move the Playhead before PUNCH OUT. No recording was started.',
        message: 'PAST PUNCH OUT',
        tone: 'warning',
      });
      return;
    }

    const client = localEngineClientRef.current;

    if (!client || projectRootState.status !== 'READY') {
      showTimelineStatusFeedback({
        helpText: 'Punch recording requires a writable Project Root and connected Local Engine.',
        message: 'PROJECT ROOT REQUIRED',
        tone: 'warning',
      });
      return;
    }

    let session = punchSessionRef.current;
    const sessionMatches = Boolean(
      session &&
        session.clip.id === target.clip.id &&
        session.baseClipTake.clipTakeId === target.baseClipTake.clipTakeId &&
        session.range.inTick === target.range.inTick &&
        session.range.outTick === target.range.outTick,
    );

    if (!sessionMatches) {
      if ((session?.attempts.length ?? 0) > 0) {
        setHeaderHelpMessage(
          'KEEP SELECTED AS NEW TAKE or DISCARD SESSION before changing Clip, Base Take, or Range.',
        );
        return;
      }

      setHeaderHelpMessage('Loading the frozen Base Take for Punch recording.');
      const sessionFile = sessionAudioSourcesRef.current.get(
        target.baseArtifact.artifactId,
      );
      let baseWav: Blob | undefined = sessionFile;

      if (!baseWav) {
        const loaded = await client.readGeneratedAudioWav({
          kind: 'generated',
          name: target.baseArtifact.file.name,
          relativePath: target.baseArtifact.file.relativePath,
          sizeBytes: target.baseArtifact.file.sizeBytes,
          sourceId: target.baseArtifact.artifactId,
        });

        if (!loaded.ok) {
          showTimelineStatusFeedback({
            helpText: loaded.message,
            message: 'BASE TAKE UNAVAILABLE',
            tone: 'warning',
          });
          return;
        }
        baseWav = loaded.wav;
      }

      const createdAt = new Date().toISOString();
      session = createPunchSession(target, baseWav, {
        createdAt,
        punchSessionId: `punch-session-${Date.now()}`,
      });
      setPunchSession(session);
      punchSessionRef.current = session;
    }

    const captureStartTick = Math.max(
      target.range.inTick,
      currentProject.playheadTick,
    );
    const preRollStartTick = Math.max(
      target.clip.startTick,
      Math.min(currentProject.playheadTick, captureStartTick),
    );
    const operationId = ++recordingOperationIdRef.current;
    const runtime = microphoneRecordingRuntimeRef.current;
    const recordingSettings = normalizeRecordingSettings(currentProject.recordingSettings);
    const timingPlan = createRecordingTimingPlan({
      bpm: currentProject.bpm,
      countInBars: recordingSettings.countInBars,
      recordStartTick: preRollStartTick,
    });
    activeRecordingModeRef.current = 'punch';
    punchRecordingStartTickRef.current = captureStartTick;
    punchRecordingAutoStopRef.current = false;
    clearRecordingBoundaryTimer();
    stopActiveAudioPlayback(false);
    stopInstrumentAudioPreview(false);
    updateRecordingRuntimePhase('PREPARING');
    setMicrophoneInputLevel(0);
    updateWorkspaceViewState((currentWorkspace) => ({
      ...currentWorkspace,
      activeTransport: 'REC',
      project: {
        ...currentWorkspace.project,
        playheadTick: preRollStartTick,
        status: 'PUNCH MICROPHONE ACCESS',
      },
    }));

    const failPunch = async (message: string) => {
      if (recordingOperationIdRef.current !== operationId) {
        return;
      }
      recordingOperationIdRef.current += 1;
      metronomeRuntimeRef.current.stop();
      clearRecordingBoundaryTimer();
      audioClipPlaybackRuntimeRef.current.stop();
      await runtime.cancel();
      activeRecordingModeRef.current = 'normal';
      punchRecordingStartTickRef.current = undefined;
      punchRecordingAutoStopRef.current = false;
      updateRecordingRuntimePhase('IDLE');
      setMicrophoneInputLevel(0);
      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        activeTransport: 'STOP',
        project: {
          ...currentWorkspace.project,
          status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
        },
      }));
      setHeaderHelpMessage(message);
    };

    const beginCapture = () => {
      if (
        recordingOperationIdRef.current !== operationId ||
        recordingRuntimePhaseRef.current !== 'COUNT_IN'
      ) {
        return;
      }

      try {
        runtime.beginRecording();
      } catch (error) {
        void failPunch(
          error instanceof Error ? error.message : 'Punch microphone recording could not begin.',
        );
        return;
      }

      updateRecordingRuntimePhase('RECORDING');
      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        activeTransport: 'REC',
        project: {
          ...currentWorkspace.project,
          playheadTick: captureStartTick,
          status: 'PUNCH RECORDING',
        },
      }));
      setHeaderHelpMessage(
        `Recording Punch Attempt ${session!.attempts.length + 1} until PUNCH OUT.`,
      );
      const durationSeconds = timelineTicksToSeconds(
        target.range.outTick - captureStartTick,
        currentProject.bpm,
      );
      recordingBoundaryTimerRef.current = window.setTimeout(() => {
        if (
          recordingOperationIdRef.current !== operationId ||
          recordingRuntimePhaseRef.current !== 'RECORDING'
        ) {
          return;
        }
        recordingBoundaryTimerRef.current = undefined;
        punchRecordingAutoStopRef.current = true;
        stopPunchRecordingRequestRef.current();
      }, Math.max(1, Math.round(durationSeconds * 1_000)));
    };

    const beginPreRollOrCapture = () => {
      if (
        recordingOperationIdRef.current !== operationId ||
        recordingRuntimePhaseRef.current !== 'COUNT_IN'
      ) {
        return;
      }

      if (preRollStartTick >= captureStartTick) {
        beginCapture();
        return;
      }

      const clipTiming = target.clip.audioTiming!;
      const preRollPlan: AudioClipPlaybackPlan = {
        clip: {
          ...target.clip,
          audioTiming: clipTiming,
          sourceFile: {
            ...target.clip.sourceFile!,
            durationSeconds:
              target.clip.sourceFile!.durationSeconds ??
              target.baseArtifact.audio.durationSeconds,
          },
        },
        clipEndTick: captureStartTick,
        clipStartTick: target.clip.startTick,
        playbackEndSeconds:
          clipTiming.sourceStartSeconds +
          timelineTicksToSeconds(
            captureStartTick - target.clip.startTick,
            currentProject.bpm,
          ),
        playbackStartSeconds:
          clipTiming.sourceStartSeconds +
          timelineTicksToSeconds(
            preRollStartTick - target.clip.startTick,
            currentProject.bpm,
          ),
        playbackStartTick: preRollStartTick,
        sourceId: target.baseArtifact.artifactId,
      };
      const baseFile = new File(
        [session!.baseWav],
        target.baseArtifact.file.name,
        { type: 'audio/wav' },
      );

      setHeaderHelpMessage('Punch pre-roll is playing the frozen Base Take.');
      audioClipPlaybackRuntimeRef.current.play(
        baseFile,
        preRollPlan,
        currentProject.bpm,
        {
          onComplete: () => beginCapture(),
          onError: (message) => void failPunch(message),
          onProgress: (playheadTick) =>
            updateWorkspaceViewState((currentWorkspace) => ({
              ...currentWorkspace,
              project: { ...currentWorkspace.project, playheadTick },
            })),
        },
      );
    };

    try {
      const prepared = await runtime.prepare({
        onInputLevel: (level) => setMicrophoneInputLevel(level),
        onRecordingProgress: (elapsedSeconds) => {
          if (
            recordingOperationIdRef.current !== operationId ||
            recordingRuntimePhaseRef.current !== 'RECORDING'
          ) {
            return;
          }
          const nextPlayheadTick = getRecordingPlayheadTick({
            bpm: currentProject.bpm,
            elapsedSeconds,
            maximumEndTick: target.range.outTick,
            startTick: captureStartTick,
          });
          updateWorkspaceViewState((currentWorkspace) => ({
            ...currentWorkspace,
            project: { ...currentWorkspace.project, playheadTick: nextPlayheadTick },
          }));
        },
      });

      if (!prepared || recordingOperationIdRef.current !== operationId) {
        return;
      }
    } catch (error) {
      await failPunch(
        error instanceof Error ? `Microphone access failed: ${error.message}` : 'Microphone access failed.',
      );
      return;
    }

    updateRecordingRuntimePhase('COUNT_IN');
    const needsMetronome =
      recordingSettings.countInBars > 0 || recordingSettings.metronomeEnabled;

    if (!needsMetronome) {
      beginPreRollOrCapture();
      return;
    }

    try {
      metronomeRuntimeRef.current.start(timingPlan, {
        metronomeEnabled: recordingSettings.metronomeEnabled,
        onCountInComplete: () => beginPreRollOrCapture(),
        onError: (message) => void failPunch(message),
        volume: recordingSettings.metronomeVolume,
      });
    } catch (error) {
      await failPunch(error instanceof Error ? error.message : 'Metronome could not start.');
    }
  }, [
    clearRecordingBoundaryTimer,
    projectRootState.status,
    punchInTick,
    punchOutTick,
    showTimelineStatusFeedback,
    stopActiveAudioPlayback,
    stopInstrumentAudioPreview,
    updateRecordingRuntimePhase,
    updateWorkspaceViewState,
  ]);

  const handleStopPunchRecording = useCallback(async () => {
    const phase = recordingRuntimePhaseRef.current;

    if (activeRecordingModeRef.current !== 'punch' || phase === 'IDLE') {
      return;
    }

    if (phase === 'SAVING') {
      setHeaderHelpMessage('Punch Attempt is already being finalized.');
      return;
    }

    const runtime = microphoneRecordingRuntimeRef.current;
    const operationId = recordingOperationIdRef.current;
    const didReachPunchOut = punchRecordingAutoStopRef.current;
    metronomeRuntimeRef.current.stop();
    clearRecordingBoundaryTimer();
    audioClipPlaybackRuntimeRef.current.stop();

    if (phase !== 'RECORDING' || !didReachPunchOut) {
      recordingOperationIdRef.current += 1;
      await runtime.cancel();
      activeRecordingModeRef.current = 'normal';
      punchRecordingStartTickRef.current = undefined;
      punchRecordingAutoStopRef.current = false;
      updateRecordingRuntimePhase('IDLE');
      setMicrophoneInputLevel(0);
      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        activeTransport: 'STOP',
        project: {
          ...currentWorkspace.project,
          status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
        },
      }));
      setHeaderHelpMessage(
        'Punch recording canceled before PUNCH OUT. No temporary Attempt was added.',
      );
      return;
    }

    updateRecordingRuntimePhase('SAVING');

    try {
      const capture = await runtime.finish();
      const session = punchSessionRef.current;
      const capturedStartTick = punchRecordingStartTickRef.current;

      if (
        recordingOperationIdRef.current !== operationId ||
        !session ||
        capturedStartTick === undefined
      ) {
        return;
      }

      const createdAt = new Date().toISOString();
      const attemptNumber = session.attempts.length + 1;
      const nextSession = addPunchAttempt(session, {
        blob: capture.blob,
        capturedStartTick,
        createdAt,
        durationSeconds: capture.durationSeconds,
        ...(capture.inputDeviceId ? { inputDeviceId: capture.inputDeviceId } : {}),
        ...(capture.inputDeviceLabel ? { inputDeviceLabel: capture.inputDeviceLabel } : {}),
        punchAttemptId: `punch-attempt-${Date.now()}-${attemptNumber}`,
        sampleRate: capture.sampleRate,
      });
      setPunchSession(nextSession);
      punchSessionRef.current = nextSession;
      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        activeTransport: 'STOP',
        project: {
          ...currentWorkspace.project,
          playheadTick: nextSession.range.outTick,
          status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
        },
      }));
      setHeaderHelpMessage(
        `PUNCH ATTEMPT ${attemptNumber} stored temporarily. Preview, record another, KEEP, or DISCARD.`,
      );
    } catch (error) {
      setHeaderHelpMessage(
        error instanceof Error
          ? `PUNCH ATTEMPT FAILED: ${error.message}`
          : 'PUNCH ATTEMPT FAILED unexpectedly.',
      );
    } finally {
      activeRecordingModeRef.current = 'normal';
      punchRecordingStartTickRef.current = undefined;
      punchRecordingAutoStopRef.current = false;
      recordingOperationIdRef.current += 1;
      updateRecordingRuntimePhase('IDLE');
      setMicrophoneInputLevel(0);
    }
  }, [
    clearRecordingBoundaryTimer,
    updateRecordingRuntimePhase,
    updateWorkspaceViewState,
  ]);
  stopPunchRecordingRequestRef.current = () => void handleStopPunchRecording();

  const handleStartRecording = useCallback(async () => {
    if (recordingRuntimePhaseRef.current !== 'IDLE') {
      setHeaderHelpMessage('Stop the active recording operation before starting another Take.');
      return;
    }

    if ((punchSessionRef.current?.attempts.length ?? 0) > 0) {
      setHeaderHelpMessage(
        'Normal REC is locked while Punch Attempts are unresolved. Use RECORD ANOTHER, KEEP, or DISCARD.',
      );
      return;
    }

    setPunchSession(undefined);

    activeRecordingModeRef.current = 'normal';

    stopInstrumentAudioPreview(false);

    const client = localEngineClientRef.current;

    if (!client || projectRootState.status !== 'READY') {
      showTimelineStatusFeedback({
        helpText: 'Select a writable Project Root before recording so the WAV Take has a durable destination.',
        message: 'PROJECT ROOT REQUIRED',
        tone: 'warning',
      });
      return;
    }

    const recordingTarget = resolveRecordingTarget(
      project.tracks,
      project.selection,
    );

    if (!recordingTarget.canRecord) {
      showTimelineStatusFeedback({
        helpText: recordingTarget.message,
        message: 'RECORDING TARGET LOCKED',
        tone: 'warning',
      });
      return;
    }

    const selectedTarget = recordingTarget.targetClip;
    const targetClipId = selectedTarget?.id;
    const recordingTrack = recordingTarget.targetTrack;
    const requestedStartTick = selectedTarget?.startTick ?? project.playheadTick;
    const placementPlan = createRecordingPlacementPlan({
      bpm: project.bpm,
      excludedClipId: targetClipId,
      startTick: requestedStartTick,
      totalTicks: project.totalTicks,
      track: recordingTrack,
    });

    if (!placementPlan.canRecord) {
      showTimelineStatusFeedback({
        helpText: placementPlan.message,
        message:
          placementPlan.reason === 'clip-overlap'
            ? 'RECORDING COLLISION'
            : 'RECORDING LOCKED',
        tone: 'warning',
      });
      return;
    }

    const recordingSettings = normalizeRecordingSettings(project.recordingSettings);
    let timingPlan: ReturnType<typeof createRecordingTimingPlan>;

    try {
      timingPlan = createRecordingTimingPlan({
        bpm: project.bpm,
        countInBars: recordingSettings.countInBars,
        recordStartTick: placementPlan.startTick,
      });
    } catch (error) {
      showTimelineStatusFeedback({
        helpText:
          error instanceof Error
            ? error.message
            : 'Recording timing could not be prepared.',
        message: 'RECORDING LOCKED',
        tone: 'warning',
      });
      return;
    }

    const operationId = ++recordingOperationIdRef.current;
    const runtime = microphoneRecordingRuntimeRef.current;

    clearRecordingBoundaryTimer();
    recordingAutoStopReasonRef.current = undefined;
    stopActiveAudioPlayback(false);
    updateRecordingRuntimePhase('PREPARING');
    setMicrophoneInputLevel(0);
    updateWorkspaceViewState((currentWorkspace) => ({
      ...currentWorkspace,
      activeTransport: 'REC',
      recordingSession: undefined,
      project: {
        ...currentWorkspace.project,
        playheadTick: timingPlan.recordStartTick,
        status: 'MICROPHONE ACCESS',
      },
    }));
    setHeaderHelpMessage('Waiting for browser microphone access.');

    const failRecording = async (
      message: string,
      feedbackMessage = 'RECORDING BLOCKED',
    ) => {
      if (recordingOperationIdRef.current !== operationId) {
        return;
      }

      recordingOperationIdRef.current += 1;
      metronomeRuntimeRef.current.stop();
      clearRecordingBoundaryTimer();
      recordingAutoStopReasonRef.current = undefined;
      updateRecordingRuntimePhase('IDLE');
      setMicrophoneInputLevel(0);
      await runtime.cancel();
      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        activeTransport: 'STOP',
        recordingSession: undefined,
        project: {
          ...currentWorkspace.project,
          status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
        },
      }));
      showTimelineStatusFeedback({
        helpText: message,
        message: feedbackMessage,
        tone: 'warning',
      });
    };

    const beginRecording = () => {
      if (
        recordingOperationIdRef.current !== operationId ||
        recordingRuntimePhaseRef.current !== 'COUNT_IN'
      ) {
        return;
      }

      try {
        runtime.beginRecording();
      } catch (error) {
        void failRecording(
          error instanceof Error
            ? error.message
            : 'Microphone recording could not begin.',
        );
        return;
      }

      updateRecordingRuntimePhase('RECORDING');
      updateWorkspaceViewState((currentWorkspace) => {
        if (
          currentWorkspace.activeTransport !== 'REC' ||
          currentWorkspace.recordingSession
        ) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          recordingSession: {
            ...createRecordingSession(
              currentWorkspace.project,
              timingPlan.recordStartTick,
              targetClipId,
              recordingTarget.targetTrackId,
            ),
            maximumEndTick: placementPlan.maximumEndTick,
          },
          project: {
            ...currentWorkspace.project,
            status: 'RECORDING',
          },
        };
      });
      setHeaderHelpMessage(
        targetClipId
          ? 'Recording a new Take for the selected Hum Audio Clip. Press STOP to save it.'
          : 'Recording a new Hum Audio part. Press STOP to save the Take.',
      );
      recordingBoundaryTimerRef.current = window.setTimeout(() => {
        if (
          recordingOperationIdRef.current !== operationId ||
          recordingRuntimePhaseRef.current !== 'RECORDING'
        ) {
          return;
        }

        recordingBoundaryTimerRef.current = undefined;
        recordingAutoStopReasonRef.current = placementPlan.boundaryReason;
        setHeaderHelpMessage(
          placementPlan.boundaryReason === 'next-clip'
            ? 'Recording reached the next Clip boundary and is stopping safely.'
            : 'Recording reached the Timeline end and is stopping safely.',
        );
        stopRecordingRequestRef.current();
      }, Math.max(1, Math.round(placementPlan.maximumDurationSeconds * 1_000)));
    };

    try {
      const prepared = await runtime.prepare({
        onInputLevel: (level) => setMicrophoneInputLevel(level),
        onRecordingProgress: (elapsedSeconds) => {
          if (
            recordingOperationIdRef.current !== operationId ||
            recordingRuntimePhaseRef.current !== 'RECORDING'
          ) {
            return;
          }

          const nextPlayheadTick = getRecordingPlayheadTick({
            bpm: timingPlan.bpm,
            elapsedSeconds,
            maximumEndTick: placementPlan.maximumEndTick,
            startTick: timingPlan.recordStartTick,
          });

          updateWorkspaceViewState((currentWorkspace) =>
            currentWorkspace.project.playheadTick === nextPlayheadTick
              ? currentWorkspace
              : {
                  ...currentWorkspace,
                  project: {
                    ...currentWorkspace.project,
                    playheadTick: nextPlayheadTick,
                  },
                },
          );
        },
      });

      if (
        !prepared ||
        recordingOperationIdRef.current !== operationId
      ) {
        return;
      }
    } catch (error) {
      await failRecording(
        error instanceof Error
          ? `Microphone access failed: ${error.message}`
          : 'Microphone access failed.',
        'MICROPHONE BLOCKED',
      );
      return;
    }

    updateRecordingRuntimePhase('COUNT_IN');
    updateWorkspaceViewState((currentWorkspace) => ({
      ...currentWorkspace,
      project: {
        ...currentWorkspace.project,
        status:
          recordingSettings.countInBars === 0
            ? 'RECORDING READY'
            : `COUNT IN ${recordingSettings.countInBars} BAR${
                recordingSettings.countInBars === 1 ? '' : 'S'
              }`,
      },
    }));

    const needsMetronomeRuntime =
      recordingSettings.countInBars > 0 || recordingSettings.metronomeEnabled;

    if (!needsMetronomeRuntime) {
      beginRecording();
      return;
    }

    try {
      metronomeRuntimeRef.current.start(timingPlan, {
        metronomeEnabled: recordingSettings.metronomeEnabled,
        onCountInComplete: () => beginRecording(),
        onError: (message) => void failRecording(message, 'METRONOME ERROR'),
        volume: recordingSettings.metronomeVolume,
      });
    } catch (error) {
      await failRecording(
        error instanceof Error ? error.message : 'Metronome could not start.',
        'METRONOME ERROR',
      );
      return;
    }

    setHeaderHelpMessage(
      recordingSettings.countInBars === 0
        ? 'Microphone ready. Recording is starting.'
        : `${recordingSettings.countInBars}-bar Count-In started. Recording will begin at the frozen Playhead.`,
    );
  }, [
    clearRecordingBoundaryTimer,
    project.bpm,
    project.playheadTick,
    project.recordingSettings,
    project.selection.items,
    project.totalTicks,
    project.tracks,
    projectRootState.status,
    showTimelineStatusFeedback,
    stopActiveAudioPlayback,
    stopInstrumentAudioPreview,
    updateRecordingRuntimePhase,
    updateWorkspaceViewState,
  ]);

  const handleStopRecording = useCallback(async () => {
    const phase = recordingRuntimePhaseRef.current;

    if (phase === 'IDLE') {
      return;
    }

    if (phase === 'SAVING') {
      setHeaderHelpMessage('The recorded WAV is already being finalized and saved.');
      return;
    }

    const runtime = microphoneRecordingRuntimeRef.current;

    if (phase === 'PREPARING' || phase === 'COUNT_IN') {
      recordingOperationIdRef.current += 1;
      metronomeRuntimeRef.current.stop();
      clearRecordingBoundaryTimer();
      recordingAutoStopReasonRef.current = undefined;
      updateRecordingRuntimePhase('IDLE');
      setMicrophoneInputLevel(0);
      await runtime.cancel();
      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        activeTransport: 'STOP',
        recordingSession: undefined,
        project: {
          ...currentWorkspace.project,
          status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
        },
      }));
      showTimelineStatusFeedback({
        helpText:
          phase === 'PREPARING'
            ? 'Microphone access was canceled before recording began.'
            : 'Count-In canceled before recording began.',
        message: phase === 'PREPARING' ? 'RECORDING CANCELED' : 'COUNT-IN CANCELED',
        tone: 'warning',
      });
      return;
    }

    const operationId = recordingOperationIdRef.current;
    const recordingSession = workspaceRef.current.recordingSession;
    const client = localEngineClientRef.current;
    const autoStopReason = recordingAutoStopReasonRef.current;

    metronomeRuntimeRef.current.stop();
    clearRecordingBoundaryTimer();
    updateRecordingRuntimePhase('SAVING');
    setMicrophoneInputLevel(0);
    updateWorkspaceViewState((currentWorkspace) => ({
      ...currentWorkspace,
      activeTransport: 'STOP',
      project: {
        ...currentWorkspace.project,
        status: 'SAVING RECORDING',
      },
    }));

    const failSaving = (
      message: string,
      feedbackMessage = 'RECORDING SAVE FAILED',
    ) => {
      if (recordingOperationIdRef.current !== operationId) {
        return;
      }

      recordingOperationIdRef.current += 1;
      recordingAutoStopReasonRef.current = undefined;
      updateRecordingRuntimePhase('IDLE');
      setMicrophoneInputLevel(0);
      updateWorkspaceViewState((currentWorkspace) => ({
        ...currentWorkspace,
        activeTransport: 'STOP',
        recordingSession: undefined,
        project: {
          ...currentWorkspace.project,
          status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
        },
      }));
      showTimelineStatusFeedback({
        helpText: message,
        message: feedbackMessage,
        tone: 'warning',
      });
    };

    if (!recordingSession || !client) {
      await runtime.cancel();
      failSaving(
        'Recording stopped without a valid session or Local Engine connection.',
      );
      return;
    }

    let capture: Awaited<ReturnType<MicrophoneRecordingRuntime['finish']>>;

    try {
      capture = await runtime.finish();
    } catch (error) {
      failSaving(
        error instanceof Error
          ? `Recording finalization failed: ${error.message}`
          : 'Recording finalization failed.',
      );
      return;
    }

    if (recordingOperationIdRef.current !== operationId) {
      return;
    }

    const capturedEndTick = getRecordingPlayheadTick({
      bpm: workspaceRef.current.project.bpm,
      elapsedSeconds: capture.durationSeconds,
      maximumEndTick:
        recordingSession.maximumEndTick ?? workspaceRef.current.project.totalTicks,
      startTick: recordingSession.startTick,
    });
    updateWorkspaceViewState((currentWorkspace) => ({
      ...currentWorkspace,
      project: {
        ...currentWorkspace.project,
        playheadTick: capturedEndTick,
      },
    }));

    const saveResult = await client.saveRecordingWav(capture.blob);

    if (recordingOperationIdRef.current !== operationId) {
      return;
    }

    if (!saveResult.ok) {
      failSaving(saveResult.message);
      return;
    }

    const registration = createRecordingArtifactRegistration(
      workspaceRef.current.project,
      saveResult.recording,
      {
        inputDeviceId: capture.inputDeviceId,
        inputDeviceLabel: capture.inputDeviceLabel,
        maximumEndTick: recordingSession.maximumEndTick,
        startTick: recordingSession.startTick,
        targetClipId: recordingSession.targetClipId,
        targetTrackId:
          recordingSession.targetClipId ? undefined : recordingSession.trackId,
      },
    );

    if (!registration.canRegister) {
      failSaving(
        `${registration.message} The WAV remains safely stored in the Project Root recordings folder.`,
        'TAKE REGISTRATION FAILED',
      );
      return;
    }

    const lastModified = Date.parse(saveResult.recording.createdAt);
    const recordingFile = new File(
      [capture.blob],
      saveResult.recording.file.name,
      {
        lastModified: Number.isFinite(lastModified) ? lastModified : Date.now(),
        type: 'audio/wav',
      },
    );

    sessionAudioSourcesRef.current.register(
      saveResult.recording.artifactId,
      recordingFile,
    );
    updateWorkspaceState((currentWorkspace) => {
      const currentRegistration = createRecordingArtifactRegistration(
        currentWorkspace.project,
        saveResult.recording,
        {
          inputDeviceId: capture.inputDeviceId,
          inputDeviceLabel: capture.inputDeviceLabel,
          maximumEndTick: recordingSession.maximumEndTick,
          startTick: recordingSession.startTick,
          targetClipId: recordingSession.targetClipId,
          targetTrackId:
            recordingSession.targetClipId ? undefined : recordingSession.trackId,
        },
      );

      if (!currentRegistration.canRegister) {
        return currentWorkspace;
      }

      const nextPlayheadTick = Math.min(
        currentRegistration.project.totalTicks,
        currentRegistration.clip.startTick + currentRegistration.clip.lengthTicks,
      );

      return {
        ...currentWorkspace,
        activeTransport: 'STOP',
        selectedClipId: currentRegistration.clip.id,
        recordingSession: undefined,
        project: {
          ...currentRegistration.project,
          playheadTick: nextPlayheadTick,
          status: currentRegistration.project.isLooping ? 'LOOP READY' : 'READY',
        },
      };
    });
    recordingOperationIdRef.current += 1;
    recordingAutoStopReasonRef.current = undefined;
    updateRecordingRuntimePhase('IDLE');
    setMicrophoneInputLevel(0);
    showTimelineStatusFeedback({
      helpText: `${registration.clipTake.label} was saved as ${saveResult.recording.file.relativePath} and registered on ${registration.clip.name}.${
        autoStopReason === 'next-clip'
          ? ' Recording stopped at the next Clip boundary.'
          : autoStopReason === 'timeline-end'
            ? ' Recording stopped at the Timeline end.'
            : ''
      }`,
      message: 'RECORDING SAVED',
      tone: 'success',
    });
  }, [
    clearRecordingBoundaryTimer,
    showTimelineStatusFeedback,
    updateRecordingRuntimePhase,
    updateWorkspaceState,
    updateWorkspaceViewState,
  ]);
  stopRecordingRequestRef.current = () => void handleStopRecording();

  const settleProjectMixdownResult = useCallback(
    (
      result: ProjectMixdownRunnerResult,
      owner: ProjectMixdownOwner,
      summary: NonNullable<ProjectMixdownUiState['summary']>,
    ) => {
      if (!result.ok) {
        if (result.status === 'MIXDOWN_OUTCOME_UNKNOWN') {
          projectMixdownUnknownResultRef.current = result;
          setProjectMixdownState({
            message: `${result.message} Use RECOVER with this exact operation before starting another Mixdown.`,
            operationId: result.operationId,
            owner,
            status: 'MIXDOWN_OUTCOME_UNKNOWN',
            summary,
          });
          setHeaderHelpMessage(
            `Project Mixdown outcome is unknown for ${result.operationId}. Do not start a replacement operation; use RECOVER.`,
          );
          return;
        }

        projectMixdownUnknownResultRef.current = undefined;
        projectMixdownCommandRef.current = undefined;

        if (result.status === 'MIXDOWN_CANCELED') {
          setProjectMixdownState({
            message: result.message,
            operationId: result.operationId,
            owner,
            status: 'CANCELED',
            summary,
          });
          setHeaderHelpMessage(result.message);
          return;
        }

        setProjectMixdownState({
          message: result.message,
          ...(result.operationId ? { operationId: result.operationId } : {}),
          owner,
          status: 'ERROR',
          summary,
        });
        setHeaderHelpMessage(result.message);
        return;
      }

      const historyAtCommit = historyRef.current;
      const workspaceAtCommit = historyAtCommit.present.value;

      if (workspaceAtCommit.project !== result.baseProject) {
        const message =
          'Project Mixdown WAV finalized, but registration was blocked because the Project changed before commit.';
        projectMixdownUnknownResultRef.current = undefined;
        projectMixdownCommandRef.current = undefined;
        setProjectMixdownState({
          message,
          operationId: result.request.operationId,
          owner,
          status: 'ERROR',
          summary,
        });
        setHeaderHelpMessage(message);
        return;
      }

      if (result.status === 'MIXDOWN_ALREADY_REGISTERED') {
        const selectedWorkspace = normalizeWorkspaceState({
          ...workspaceAtCommit,
          activeTransport: 'STOP',
          selectedClipId: result.intent.output.clipId,
          ...(owner.kind === 'clip-filer'
            ? { selectedPatchTabId: owner.patchTabId }
            : {}),
          project: {
            ...workspaceAtCommit.project,
            selection: {
              items: [{ id: result.intent.output.clipId, type: 'clip' }],
            },
          },
        });
        const selectedHistory = updateSessionEditPresent(
          historyAtCommit,
          () => selectedWorkspace,
        );
        historyRef.current = selectedHistory;
        workspaceRef.current = selectedWorkspace;
        setHistory(selectedHistory);
      } else {
        workspaceEditSequenceRef.current += 1;
        const committedWorkspace = normalizeWorkspaceState({
          ...workspaceAtCommit,
          activeTransport: 'STOP',
          selectedClipId: result.intent.output.clipId,
          ...(owner.kind === 'clip-filer'
            ? { selectedPatchTabId: owner.patchTabId }
            : {}),
          project: {
            ...result.project,
            selection: {
              items: [{ id: result.intent.output.clipId, type: 'clip' }],
            },
            status: 'MIXDOWN READY',
          },
        });
        const committedHistory = commitSessionEdit(
          historyAtCommit,
          committedWorkspace,
          {
            category: 'track',
            createdAt: new Date().toISOString(),
            id: `edit-${Date.now()}-${workspaceEditSequenceRef.current}`,
            label: `Print ${result.intent.output.clipName}`,
          },
          undoHistoryLimit,
        );
        historyRef.current = committedHistory;
        workspaceRef.current = committedWorkspace;
        setHistory(committedHistory);
      }

      projectMixdownUnknownResultRef.current = undefined;
      projectMixdownCommandRef.current = undefined;
      setProjectMixdownState({
        message: `${result.intent.output.clipName} is registered on muted Track ${result.intent.output.trackName}.`,
        operationId: result.request.operationId,
        owner,
        status: 'REGISTERED',
        summary,
      });
      showTimelineStatusFeedback({
        helpText: owner.kind === 'clip-filer'
          ? `${result.intent.output.clipName} is registered on a muted Raw Mix Track. No playback or audition was started. Select SAVE WAV in Clip Filer to download the finalized file.`
          : `${result.intent.output.clipName} is registered on a muted Raw Mix Track. No playback, audition, or download was started.`,
        message: 'RAW MIX READY',
        tone: 'success',
      });
    },
    [showTimelineStatusFeedback],
  );

  const handleRunProjectMixdown = useCallback(
    async (owner: ProjectMixdownOwner) => {
      const client = localEngineClientRef.current;
      const currentAvailability = engineAvailabilityRef.current;
      const currentWorkspace = workspaceRef.current;

      if (!client || !currentAvailability.acceptsNewJobs) {
        setHeaderHelpMessage(currentAvailability.message);
        return;
      }

      if (projectRootState.status !== 'READY') {
        setHeaderHelpMessage(
          'Project Mixdown requires one ready Project Root before printing audio.',
        );
        return;
      }

      if (projectMixdownInProgressRef.current) {
        setHeaderHelpMessage('One Project Mixdown operation is already active.');
        return;
      }

      if (
        projectStemPrintInProgressRef.current ||
        projectStemPrintUnknownResultRef.current
      ) {
        setHeaderHelpMessage(
          'Stem Print owns the Project render operation lock. Settle or recover it before Mixdown.',
        );
        return;
      }

      if (projectMixdownUnknownResultRef.current) {
        setHeaderHelpMessage(
          'Recover the unknown Project Mixdown operation before starting another one.',
        );
        return;
      }

      const entryResolution = resolveProjectMixdownStartEntry(
        currentWorkspace.project,
        owner,
      );

      if (!entryResolution.canStart) {
        setProjectMixdownState({
          message: entryResolution.message,
          owner,
          status: 'ERROR',
        });
        setHeaderHelpMessage(entryResolution.message);
        return;
      }

      let sourceDescriptors;

      try {
        sourceDescriptors = collectProjectSourceRestorationDescriptors(
          currentWorkspace.project,
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Project source descriptors could not be collected.';
        setProjectMixdownState({ message, owner, status: 'ERROR' });
        setHeaderHelpMessage(message);
        return;
      }

      const requestId = ++projectMixdownRequestIdRef.current;
      const abortController = new AbortController();
      const sourceProjectFingerprint = createDirtyStateFingerprint(
        currentWorkspace.project,
      );
      projectMixdownAbortControllerRef.current = abortController;
      projectMixdownInProgressRef.current = true;
      setProjectMixdownState({
        message: 'Verifying every audible source with the Local Engine.',
        owner,
        status: 'PREPARING',
      });
      setHeaderHelpMessage(
        'Project Mixdown source preflight is active. Project edits remain available, but the source graph must stay unchanged for registration.',
      );

      try {
        const restorationResult = await client.restoreSources(sourceDescriptors);

        if (projectMixdownRequestIdRef.current !== requestId) {
          return;
        }

        if (!restorationResult.ok) {
          setProjectMixdownState({
            message: restorationResult.message,
            owner,
            status: 'ERROR',
          });
          setHeaderHelpMessage(restorationResult.message);
          return;
        }

        if (
          createDirtyStateFingerprint(workspaceRef.current.project) !==
          sourceProjectFingerprint
        ) {
          const message =
            'Project changed during Mixdown source preflight. Run PRINT MIX again from the current Project.';
          setProjectMixdownState({ message, owner, status: 'ERROR' });
          setHeaderHelpMessage(message);
          return;
        }

        const preparation = prepareProjectMixdown(
          workspaceRef.current.project,
          sourceDescriptors,
          restorationResult.restoration,
        );

        if (!preparation.canPrepare) {
          setProjectMixdownState({
            message: preparation.message,
            owner,
            status: 'ERROR',
          });
          setHeaderHelpMessage(preparation.message);
          return;
        }

        const command: ProjectMixdownRunnerCommand = Object.freeze({
          getCurrentProject: () => workspaceRef.current.project,
          intent: preparation.intent,
          request: preparation.request,
        });
        projectMixdownCommandRef.current = command;
        setProjectMixdownState({
          message: `Printing ${preparation.summary.trackCount} audible Tracks to ${preparation.summary.outputClipName}.`,
          operationId: preparation.request.operationId,
          owner,
          status: 'RUNNING',
          summary: preparation.summary,
        });

        const result = await runProjectMixdownRequest(client, command, {
          signal: abortController.signal,
        });

        if (projectMixdownRequestIdRef.current !== requestId) {
          return;
        }

        settleProjectMixdownResult(result, owner, preparation.summary);
      } catch (error) {
        if (projectMixdownRequestIdRef.current === requestId) {
          const message =
            error instanceof Error
              ? error.message
              : 'Project Mixdown failed unexpectedly.';
          projectMixdownCommandRef.current = undefined;
          projectMixdownUnknownResultRef.current = undefined;
          setProjectMixdownState({ message, owner, status: 'ERROR' });
          setHeaderHelpMessage(message);
        }
      } finally {
        if (projectMixdownRequestIdRef.current === requestId) {
          projectMixdownAbortControllerRef.current = undefined;
          projectMixdownInProgressRef.current = false;
        }
      }
    },
    [projectRootState.status, settleProjectMixdownResult],
  );

  const handleRecoverProjectMixdown = useCallback(
    async (owner: ProjectMixdownOwner) => {
      const client = localEngineClientRef.current;
      const currentAvailability = engineAvailabilityRef.current;
      const command = projectMixdownCommandRef.current;
      const unknownResult = projectMixdownUnknownResultRef.current;
      const summary = projectMixdownState.summary;

      if (!client || !currentAvailability.acceptsNewJobs) {
        setHeaderHelpMessage(currentAvailability.message);
        return;
      }

      if (
        projectMixdownInProgressRef.current ||
        projectStemPrintInProgressRef.current ||
        projectStemPrintUnknownResultRef.current ||
        !command ||
        !unknownResult ||
        !summary ||
        !isProjectMixdownOwner(projectMixdownState.owner, owner) ||
        unknownResult.intent !== command.intent ||
        unknownResult.request !== command.request
      ) {
        setHeaderHelpMessage(
          'No exact unknown Project Mixdown operation is available to recover.',
        );
        return;
      }

      const requestId = ++projectMixdownRequestIdRef.current;
      const abortController = new AbortController();
      projectMixdownAbortControllerRef.current = abortController;
      projectMixdownInProgressRef.current = true;
      setProjectMixdownState({
        message: `Recovering exact operation ${unknownResult.operationId}.`,
        operationId: unknownResult.operationId,
        owner,
        status: 'RECOVERING',
        summary,
      });

      try {
        const result = await recoverProjectMixdownRequest(
          client,
          command,
          unknownResult,
          { signal: abortController.signal },
        );

        if (projectMixdownRequestIdRef.current !== requestId) {
          return;
        }

        if (
          !result.ok &&
          (result.status === 'MIXDOWN_CANCELED' ||
            result.status === 'PREFLIGHT_BLOCKED' ||
            result.status === 'RUNNER_FAILED')
        ) {
          setProjectMixdownState({
            message: `${result.message} The original unknown operation remains unresolved; use RECOVER again.`,
            operationId: unknownResult.operationId,
            owner,
            status: 'MIXDOWN_OUTCOME_UNKNOWN',
            summary,
          });
          setHeaderHelpMessage(
            `Project Mixdown ${unknownResult.operationId} remains unresolved. Restore the original Project state if required, then use RECOVER again.`,
          );
          return;
        }

        settleProjectMixdownResult(result, owner, summary);
      } catch (error) {
        if (projectMixdownRequestIdRef.current === requestId) {
          const message =
            error instanceof Error
              ? error.message
              : 'Project Mixdown recovery failed unexpectedly.';
          setProjectMixdownState({
            message,
            operationId: unknownResult.operationId,
            owner,
            status: 'MIXDOWN_OUTCOME_UNKNOWN',
            summary,
          });
          setHeaderHelpMessage(message);
        }
      } finally {
        if (projectMixdownRequestIdRef.current === requestId) {
          projectMixdownAbortControllerRef.current = undefined;
          projectMixdownInProgressRef.current = false;
        }
      }
    },
    [projectMixdownState.owner, projectMixdownState.summary, settleProjectMixdownResult],
  );

  const handleCancelProjectMixdown = useCallback((owner: ProjectMixdownOwner) => {
    if (
      !projectMixdownInProgressRef.current ||
      !projectMixdownAbortControllerRef.current ||
      !isProjectMixdownOwner(projectMixdownState.owner, owner)
    ) {
      setHeaderHelpMessage('No active Project Mixdown operation can be canceled.');
      return;
    }

    projectMixdownAbortControllerRef.current.abort();
    setProjectMixdownState((currentState) => ({
      ...currentState,
      message:
        'Cancel requested. If dispatch already occurred, the outcome becomes unknown and must be recovered.',
      owner,
      status: 'CANCEL_REQUESTED',
    }));
    setHeaderHelpMessage(
      'Project Mixdown cancel requested. Wait for a canceled or unknown-outcome result.',
    );
  }, [projectMixdownState.owner]);

  const settleProjectStemPrintResult = useCallback(
    (
      result: ProjectStemPrintRunnerResult,
      summary: NonNullable<ProjectStemPrintUiState['summary']>,
    ) => {
      if (!result.ok) {
        if (result.status === 'STEM_PRINT_OUTCOME_UNKNOWN') {
          projectStemPrintUnknownResultRef.current = result;
          setProjectStemPrintState({
            message: `${result.message} Use RECOVER with this exact operation before starting another print.`,
            operationId: result.operationId,
            status: 'OUTCOME_UNKNOWN',
            summary,
          });
          setHeaderHelpMessage(
            `Stem Print outcome is unknown for ${result.operationId}. Use RECOVER; do not create a replacement operation.`,
          );
          return;
        }

        projectStemPrintUnknownResultRef.current = undefined;
        projectStemPrintCommandRef.current = undefined;
        setProjectStemPrintState({
          message: result.message,
          ...(result.operationId ? { operationId: result.operationId } : {}),
          status: result.status === 'STEM_PRINT_CANCELED' ? 'CANCELED' : 'ERROR',
          summary,
        });
        setHeaderHelpMessage(result.message);
        return;
      }

      const historyAtCommit = historyRef.current;
      const workspaceAtCommit = historyAtCommit.present.value;

      if (workspaceAtCommit.project !== result.baseProject) {
        const message =
          'Stem Print WAV finalized, but registration was blocked because the Project changed before commit.';
        projectStemPrintUnknownResultRef.current = undefined;
        projectStemPrintCommandRef.current = undefined;
        setProjectStemPrintState({
          message,
          operationId: result.request.operationId,
          status: 'ERROR',
          summary,
        });
        setHeaderHelpMessage(message);
        return;
      }

      const committedWorkspace = normalizeWorkspaceState({
        ...workspaceAtCommit,
        activeTransport: 'STOP',
        selectedClipId: result.intent.output.clipId,
        project: {
          ...result.project,
          selection: {
            items: [{ id: result.intent.output.clipId, type: 'clip' }],
          },
          status: 'STEM PRINT READY',
        },
      });

      if (result.status === 'STEM_PRINT_ALREADY_REGISTERED') {
        const nextHistory = updateSessionEditPresent(
          historyAtCommit,
          () => committedWorkspace,
        );
        historyRef.current = nextHistory;
        workspaceRef.current = committedWorkspace;
        setHistory(nextHistory);
      } else {
        workspaceEditSequenceRef.current += 1;
        const nextHistory = commitSessionEdit(
          historyAtCommit,
          committedWorkspace,
          {
            category: 'track',
            createdAt: new Date().toISOString(),
            id: `edit-${Date.now()}-${workspaceEditSequenceRef.current}`,
            label: `Print ${result.intent.output.clipName}`,
          },
          undoHistoryLimit,
        );
        historyRef.current = nextHistory;
        workspaceRef.current = committedWorkspace;
        setHistory(nextHistory);
      }

      projectStemPrintUnknownResultRef.current = undefined;
      projectStemPrintCommandRef.current = undefined;
      setProjectStemPrintState({
        message: `${result.intent.output.clipName} is registered on muted Track ${result.intent.output.trackName}.`,
        operationId: result.request.operationId,
        status: 'REGISTERED',
        summary,
      });
      showTimelineStatusFeedback({
        helpText: `${result.intent.output.clipName} is registered on a muted Stem Track. No playback, audition, or download was started.`,
        message: 'STEM PRINT READY',
        tone: 'success',
      });
    },
    [showTimelineStatusFeedback],
  );

  const handleRunProjectStemPrint = useCallback(async () => {
    const client = localEngineClientRef.current;
    const availability = engineAvailabilityRef.current;
    const currentWorkspace = workspaceRef.current;

    if (!client || !availability.acceptsNewJobs) {
      setHeaderHelpMessage(availability.message);
      return;
    }
    if (projectRootState.status !== 'READY') {
      setHeaderHelpMessage('Stem Print requires one ready Project Root.');
      return;
    }
    if (
      projectStemPrintInProgressRef.current ||
      projectMixdownInProgressRef.current
    ) {
      setHeaderHelpMessage('One Project render operation is already active.');
      return;
    }
    if (
      projectStemPrintUnknownResultRef.current ||
      projectMixdownUnknownResultRef.current
    ) {
      setHeaderHelpMessage(
        'Recover the exact unknown Project render operation before starting another one.',
      );
      return;
    }

    const selection = resolveProjectStemPrintSelection(
      currentWorkspace.project,
      projectStemPrintTargets,
    );
    if (!selection.canResolve || selection.targets.length === 0) {
      const message = selection.canResolve
        ? 'Select one or more Mixer Channels or Groups for Stem Print.'
        : selection.message;
      setProjectStemPrintState({ message, status: 'ERROR' });
      setHeaderHelpMessage(message);
      return;
    }

    let sourceDescriptors;
    try {
      sourceDescriptors = collectProjectSourceRestorationDescriptors(
        currentWorkspace.project,
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Project source descriptors could not be collected.';
      setProjectStemPrintState({ message, status: 'ERROR' });
      setHeaderHelpMessage(message);
      return;
    }

    const requestId = ++projectStemPrintRequestIdRef.current;
    const abortController = new AbortController();
    const sourceFingerprint = createDirtyStateFingerprint(currentWorkspace.project);
    projectStemPrintAbortControllerRef.current = abortController;
    projectStemPrintInProgressRef.current = true;
    setProjectStemPrintState({
      message: 'Verifying selected Stem sources with the Local Engine.',
      status: 'PREPARING',
    });

    try {
      const restoration = await client.restoreSources(sourceDescriptors);
      if (projectStemPrintRequestIdRef.current !== requestId) return;

      if (!restoration.ok) {
        setProjectStemPrintState({ message: restoration.message, status: 'ERROR' });
        setHeaderHelpMessage(restoration.message);
        return;
      }
      if (
        createDirtyStateFingerprint(workspaceRef.current.project) !==
        sourceFingerprint
      ) {
        const message =
          'Project changed during Stem source preflight. Run STEM PRINT again from the current Project.';
        setProjectStemPrintState({ message, status: 'ERROR' });
        setHeaderHelpMessage(message);
        return;
      }

      const preparation = prepareProjectStemPrint(
        workspaceRef.current.project,
        selection.targets,
        sourceDescriptors,
        restoration.restoration,
      );
      if (!preparation.canPrepare) {
        setProjectStemPrintState({ message: preparation.message, status: 'ERROR' });
        setHeaderHelpMessage(preparation.message);
        return;
      }

      const command: ProjectStemPrintRunnerCommand = Object.freeze({
        getCurrentProject: () => workspaceRef.current.project,
        intent: preparation.intent,
        request: preparation.request,
      });
      projectStemPrintCommandRef.current = command;
      setProjectStemPrintState({
        message: `Printing ${preparation.summary.targetCount} selected Mixer targets to ${preparation.summary.outputClipName}.`,
        operationId: preparation.request.operationId,
        status: 'RUNNING',
        summary: preparation.summary,
      });

      const result = await runProjectStemPrintRequest(client, command, {
        signal: abortController.signal,
      });
      if (projectStemPrintRequestIdRef.current !== requestId) return;
      settleProjectStemPrintResult(result, preparation.summary);
    } catch (error) {
      if (projectStemPrintRequestIdRef.current === requestId) {
        const message = error instanceof Error
          ? error.message
          : 'Project Stem Print failed unexpectedly.';
        projectStemPrintCommandRef.current = undefined;
        projectStemPrintUnknownResultRef.current = undefined;
        setProjectStemPrintState({ message, status: 'ERROR' });
        setHeaderHelpMessage(message);
      }
    } finally {
      if (projectStemPrintRequestIdRef.current === requestId) {
        projectStemPrintAbortControllerRef.current = undefined;
        projectStemPrintInProgressRef.current = false;
      }
    }
  }, [projectRootState.status, projectStemPrintTargets, settleProjectStemPrintResult]);

  const handleRecoverProjectStemPrint = useCallback(async () => {
    const client = localEngineClientRef.current;
    const availability = engineAvailabilityRef.current;
    const command = projectStemPrintCommandRef.current;
    const unknownResult = projectStemPrintUnknownResultRef.current;
    const summary = projectStemPrintState.summary;

    if (!client || !availability.acceptsNewJobs) {
      setHeaderHelpMessage(availability.message);
      return;
    }
    if (
      projectStemPrintInProgressRef.current ||
      projectMixdownInProgressRef.current ||
      !command ||
      !unknownResult ||
      !summary ||
      unknownResult.intent !== command.intent ||
      unknownResult.request !== command.request
    ) {
      setHeaderHelpMessage('No exact unknown Stem Print operation is available to recover.');
      return;
    }

    const requestId = ++projectStemPrintRequestIdRef.current;
    const abortController = new AbortController();
    projectStemPrintAbortControllerRef.current = abortController;
    projectStemPrintInProgressRef.current = true;
    setProjectStemPrintState({
      message: `Recovering exact operation ${unknownResult.operationId}.`,
      operationId: unknownResult.operationId,
      status: 'RECOVERING',
      summary,
    });

    try {
      const result = await recoverProjectStemPrintRequest(
        client,
        command,
        unknownResult,
        { signal: abortController.signal },
      );
      if (projectStemPrintRequestIdRef.current !== requestId) return;

      if (
        !result.ok &&
        ['STEM_PRINT_CANCELED', 'PREFLIGHT_BLOCKED', 'RUNNER_FAILED'].includes(
          result.status,
        )
      ) {
        setProjectStemPrintState({
          message: `${result.message} The original unknown operation remains unresolved; use RECOVER again.`,
          operationId: unknownResult.operationId,
          status: 'OUTCOME_UNKNOWN',
          summary,
        });
        return;
      }
      settleProjectStemPrintResult(result, summary);
    } catch (error) {
      if (projectStemPrintRequestIdRef.current === requestId) {
        const message = error instanceof Error
          ? error.message
          : 'Project Stem Print recovery failed unexpectedly.';
        setProjectStemPrintState({
          message,
          operationId: unknownResult.operationId,
          status: 'OUTCOME_UNKNOWN',
          summary,
        });
        setHeaderHelpMessage(message);
      }
    } finally {
      if (projectStemPrintRequestIdRef.current === requestId) {
        projectStemPrintAbortControllerRef.current = undefined;
        projectStemPrintInProgressRef.current = false;
      }
    }
  }, [projectStemPrintState.summary, settleProjectStemPrintResult]);

  const handleCancelProjectStemPrint = useCallback(() => {
    if (
      !projectStemPrintInProgressRef.current ||
      !projectStemPrintAbortControllerRef.current
    ) {
      setHeaderHelpMessage('No active Stem Print operation can be canceled.');
      return;
    }
    projectStemPrintAbortControllerRef.current.abort();
    setProjectStemPrintState((current) => ({
      ...current,
      message:
        'Cancel requested. If dispatch occurred, the outcome becomes unknown and must be recovered.',
      status: 'CANCEL_REQUESTED',
    }));
  }, []);

  const handleToggleProjectStemPrintTarget = useCallback(
    (target: ProjectStemPrintTarget) => {
      if (
        projectStemPrintInProgressRef.current ||
        projectStemPrintUnknownResultRef.current
      ) {
        setHeaderHelpMessage(
          'Stem targets are frozen until the current operation is settled or recovered.',
        );
        return;
      }
      const resolution = toggleProjectStemPrintTarget(
        workspaceRef.current.project,
        projectStemPrintTargets,
        target,
      );
      if (!resolution.canResolve) {
        setHeaderHelpMessage(resolution.message);
        return;
      }
      setProjectStemPrintTargets(resolution.targets);
      setProjectStemPrintState({ status: 'IDLE' });
      setHeaderHelpMessage(
        resolution.targets.length > 0
          ? `${resolution.targets.length} Stem Print target${resolution.targets.length === 1 ? '' : 's'} selected.`
          : 'Stem Print selection cleared.',
      );
    },
    [projectStemPrintTargets],
  );

  const handleRunClipFilerProjectMixdown = useCallback(
    (patchTabId: string) =>
      void handleRunProjectMixdown(
        createClipFilerProjectMixdownOwner(patchTabId),
      ),
    [handleRunProjectMixdown],
  );
  const handleRecoverClipFilerProjectMixdown = useCallback(
    (patchTabId: string) =>
      void handleRecoverProjectMixdown(
        createClipFilerProjectMixdownOwner(patchTabId),
      ),
    [handleRecoverProjectMixdown],
  );
  const handleCancelClipFilerProjectMixdown = useCallback(
    (patchTabId: string) =>
      handleCancelProjectMixdown(
        createClipFilerProjectMixdownOwner(patchTabId),
      ),
    [handleCancelProjectMixdown],
  );

  const handleSaveProjectMixdownWav = useCallback(
    async (patchTabId: string) => {
      const client = localEngineClientRef.current;
      const currentAvailability = engineAvailabilityRef.current;
      const currentWorkspace = workspaceRef.current;
      const owner = createClipFilerProjectMixdownOwner(patchTabId);
      const patchTab = currentWorkspace.project.patchTabs.find(
        (candidate) => candidate.id === patchTabId,
      );
      const download = resolveProjectMixdownDownload(
        currentWorkspace.project,
        patchTab,
        currentWorkspace.selectedClipId,
      );

      if (!client || currentAvailability.productionEditingLocked) {
        setHeaderHelpMessage(currentAvailability.message);
        return;
      }

      if (projectRootState.status !== 'READY') {
        setHeaderHelpMessage(
          'Select the Project Root that owns this Raw Mix before saving its WAV.',
        );
        return;
      }

      if (projectMixdownInProgressRef.current) {
        setHeaderHelpMessage('Wait for the active Project Mixdown operation to settle.');
        return;
      }

      if (projectMixdownUnknownResultRef.current) {
        setHeaderHelpMessage(
          'Recover the unknown Project Mixdown operation before saving another Raw Mix WAV.',
        );
        return;
      }

      if (!download.canDownload) {
        setProjectMixdownState({
          message: download.message,
          owner,
          status: 'ERROR',
        });
        setHeaderHelpMessage(download.message);
        return;
      }

      setProjectMixdownState({
        message: `Reading finalized ${download.fileName} from the Project Root.`,
        owner,
        status: 'DOWNLOADING',
      });

      const result = await client.readGeneratedAudioWav(download.descriptor);

      if (!result.ok) {
        setProjectMixdownState({
          message: result.message,
          owner,
          status: 'ERROR',
        });
        setHeaderHelpMessage(result.message);
        return;
      }

      const downloadUrl = window.URL.createObjectURL(result.wav);

      try {
        const anchor = document.createElement('a');
        anchor.href = downloadUrl;
        anchor.download = download.fileName;
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        window.setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 0);
      }

      setProjectMixdownState({
        message: `${download.fileName} was verified and sent to the browser download destination.`,
        owner,
        status: 'DOWNLOADED',
      });
      showTimelineStatusFeedback({
        helpText: `${download.fileName} was read from the finalized Project Mixdown artifact. No playback or audition was started.`,
        message: 'WAV SAVED',
        tone: 'success',
      });
    },
    [projectRootState.status, showTimelineStatusFeedback],
  );

  const handleTimelineExport = useCallback(async () => {
    const controller = timelineExportUiControllerRef.current;

    if (controller.isPreparing) {
      const result = await controller.run({
        getProject: () => workspaceRef.current.project,
      });
      showTimelineStatusFeedback(result);
      return;
    }

    const client = localEngineClientRef.current;
    setIsTimelineExportPreparing(true);

    try {
      const result = await controller.run({
        getProject: () => workspaceRef.current.project,
        readGeneratedAudio: client
          ? (descriptor) => client.readGeneratedAudioWav(descriptor)
          : undefined,
      });
      showTimelineStatusFeedback(result);
    } finally {
      setIsTimelineExportPreparing(false);
    }
  }, [showTimelineStatusFeedback]);

  const handleOpenFinalFiler = useCallback(() => {
    const availability = resolveFinalFilerAvailability(
      workspaceRef.current.project,
    );
    const targetKey = availability.canExport
      ? [
          availability.selectedClipId,
          availability.target.target.artifactId,
          availability.target.target.clipTakeId,
        ].join(':')
      : 'unavailable';

    finalFilerPanelSessionRef.current += 1;
    setFinalFilerEditingTargetKey(targetKey);
    setFinalFilerFileName(availability.canExport ? availability.fileName : '');
    setFinalFilerIncludeSourceReport(true);
    setFinalFilerResult(undefined);
    setIsFinalFilerBusy(finalFilerControllerRef.current.isBusy);
    setIsProjectInspectorOpen(false);
    setIsPresetDrawerOpen(false);
    setIsFinalFilerOpen(true);
  }, []);

  const handleCloseFinalFiler = useCallback(() => {
    finalFilerPanelSessionRef.current += 1;
    finalFilerControllerRef.current.cancel();
    setIsFinalFilerOpen(false);
    setIsFinalFilerBusy(false);
    setFinalFilerResult(undefined);
  }, []);

  const handleCancelFinalFiler = useCallback(() => {
    finalFilerControllerRef.current.cancel();
  }, []);

  const handleRunFinalFiler = useCallback(async () => {
    const client = localEngineClientRef.current;

    if (!client || engineConnection.lifecycle !== 'READY') {
      setFinalFilerResult({
        detail: 'Local Engine must be ready to read the registered final WAV.',
        downloadCount: 0,
        message: 'ENGINE UNAVAILABLE',
        status: 'blocked',
      });
      return;
    }

    const panelSession = finalFilerPanelSessionRef.current;
    setFinalFilerResult(undefined);
    setIsFinalFilerBusy(true);

    const result = await finalFilerControllerRef.current.run({
      buildIdentity: createFinalFilerBuildIdentitySnapshot(),
      exportedAtUtc: new Date().toISOString(),
      fileName: finalFilerFileName,
      getProject: () => workspaceRef.current.project,
      includeSourceReport: finalFilerIncludeSourceReport,
      readGeneratedAudio: (descriptor, signal) =>
        client.readGeneratedAudioWav(descriptor, { signal }),
    });

    if (finalFilerPanelSessionRef.current === panelSession) {
      setFinalFilerResult(result);
      setIsFinalFilerBusy(finalFilerControllerRef.current.isBusy);
    }
  }, [
    engineConnection.lifecycle,
    finalFilerFileName,
    finalFilerIncludeSourceReport,
  ]);

  const handleTransport = useCallback(
    (button: TransportButton) => {
      const transportRequestId = ++timelineTransportRequestIdRef.current;

      if (button === 'EXPORT') {
        if (recordingRuntimePhaseRef.current !== 'IDLE') {
          showTimelineStatusFeedback({
            helpText: 'Stop the active Count-In or recording before preparing a Timeline EXPORT.',
            message: 'EXPORT BLOCKED',
            tone: 'warning',
          });
          return;
        }

        void handleTimelineExport();
        return;
      }

      const currentAvailability = engineAvailabilityRef.current;

      if (button === 'PLAY') {
        resetProjectPlaybackDiagnostics({
          activeTransport: workspace.activeTransport,
          engineMessage: currentAvailability.message,
          origin: 'transport-entry',
          productionEditingLocked: currentAvailability.productionEditingLocked,
          recordingRuntimePhase: recordingRuntimePhaseRef.current,
          selectedItems: project.selection.items,
          selectedClipId: workspace.selectedClipId,
        });
      }

      if (currentAvailability.productionEditingLocked) {
        if (button === 'PLAY') {
          recordProjectPlaybackDiagnostic('ui-play-blocked', {
            gate: 'production-editing-lock',
            message: currentAvailability.message,
          });
        }
        setHeaderHelpMessage(currentAvailability.message);
        return;
      }

      if (
        recordingRuntimePhaseRef.current !== 'IDLE' &&
        button !== 'STOP'
      ) {
        if (button === 'PLAY') {
          recordProjectPlaybackDiagnostic('ui-play-blocked', {
            gate: 'recording-runtime',
            message: 'Stop the active Count-In or recording before using another Transport control.',
            recordingRuntimePhase: recordingRuntimePhaseRef.current,
          });
        }
        setHeaderHelpMessage('Stop the active Count-In or recording before using another Transport control.');
        return;
      }

      if (button !== 'PLAY' && button !== 'STOP') {
        stopMidiClipPlaybackPreparation(false);
      }

      if (button === 'LOOP') {
        const isLooping = !project.isLooping;

        audioClipPlaybackRuntimeRef.current.setLoopEnabled(isLooping);
        projectPlaybackRuntimeRef.current.setLoopEnabled(isLooping);
        updateWorkspaceViewState((currentWorkspace) => {
          const isTransportRunning =
            currentWorkspace.activeTransport === 'PLAY' || currentWorkspace.activeTransport === 'REC';

          return {
            ...currentWorkspace,
            activeTransport: isTransportRunning ? currentWorkspace.activeTransport : 'STOP',
            project: {
              ...currentWorkspace.project,
              isLooping,
              status: isTransportRunning ? currentWorkspace.project.status : isLooping ? 'LOOP READY' : 'READY',
            },
          };
        });
        setHeaderHelpMessage(
          isLooping
            ? 'Loop is armed for the frozen playback target range.'
            : 'Loop is off. Playback will stop at the frozen target end.',
        );
        return;
      }

      if (button === 'PLAY') {
        recordProjectPlaybackDiagnostic('transport-play-dispatch', {
          selectedClipId: workspace.selectedClipId,
        });
        stopSoundFontAudition(false);
        void stopPianoRollLiveNotePreview().then((didStopCleanly) => {
          if (
            didStopCleanly &&
            timelineTransportRequestIdRef.current === transportRequestId
          ) {
            handlePlayCurrentTarget();
          }
        });
        return;
      }

      if (
        button === 'STOP' &&
        recordingRuntimePhaseRef.current !== 'IDLE'
      ) {
        if (activeRecordingModeRef.current === 'punch') {
          void handleStopPunchRecording();
        } else {
          void handleStopRecording();
        }
        return;
      }

      if (button === 'STOP' && stopInstrumentAudioPreview()) {
        return;
      }

      if (button === 'STOP' && stopSoundFontAudition()) {
        return;
      }

      if (button === 'STOP' && stopMidiClipPlaybackPreparation()) {
        return;
      }

      if (button === 'STOP' && stopActiveAudioPlayback()) {
        return;
      }

      if (button !== 'STOP') {
        stopActiveAudioPlayback(false);
        stopSoundFontAudition(false);
      }

      if (button === 'REC') {
        void handleStartRecording();
        return;
      }

      if (button === 'STOP') {
        metronomeRuntimeRef.current.stop();
        updateWorkspaceViewState((currentWorkspace) => ({
          ...currentWorkspace,
          activeTransport: 'STOP',
          recordingSession: undefined,
          project: {
            ...currentWorkspace.project,
            status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
          },
        }));
        return;
      }

      updateWorkspaceState((currentWorkspace) => {
        return {
          ...currentWorkspace,
          activeTransport: 'EXPORT',
          project: {
            ...currentWorkspace.project,
            status: 'EXPORT READY',
          },
        };
      });
    },
    [
      handlePlayCurrentTarget,
      handleStartRecording,
      handleStopPunchRecording,
      handleStopRecording,
      handleTimelineExport,
      project.isLooping,
      project.selection.items,
      showTimelineStatusFeedback,
      stopActiveAudioPlayback,
      stopInstrumentAudioPreview,
      stopMidiClipPlaybackPreparation,
      stopPianoRollLiveNotePreview,
      stopSoundFontAudition,
      updateWorkspaceState,
      updateWorkspaceViewState,
      workspace.activeTransport,
      workspace.recordingSession,
    ],
  );

  useEffect(() => {
    const handleTransportSpaceKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== 'Space' ||
        event.repeat ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        safetyConfirmRequest ||
        !shouldHandleTransportSpaceShortcut(event.target)
      ) {
        return;
      }

      event.preventDefault();
      handleTransport(
        audioClipPlaybackRuntimeRef.current.isPlaying() ||
          projectPlaybackRuntimeRef.current.isPlaying() ||
          midiClipPlaybackPreparationAbortControllerRef.current !== undefined ||
          workspace.activeTransport === 'REC'
          ? 'STOP'
          : 'PLAY',
      );
    };

    window.addEventListener('keydown', handleTransportSpaceKeyDown);

    return () => window.removeEventListener('keydown', handleTransportSpaceKeyDown);
  }, [handleTransport, safetyConfirmRequest, workspace.activeTransport]);

  const handleProjectBpmChange = useCallback(
    (bpm: number) => {
      const nextBpm = clampInteger(bpm, RECORDING_BPM_MIN, RECORDING_BPM_MAX);
      const preview = createAudioTimebaseBpmProjectUpdate(project, nextBpm);

      if (!preview.canChange) {
        showTimelineStatusFeedback({
          helpText: preview.message,
          message: 'BPM CHANGE BLOCKED',
          tone: 'warning',
        });
        return false;
      }

      updateWorkspaceState((currentWorkspace) => {
        const result = createAudioTimebaseBpmProjectUpdate(currentWorkspace.project, nextBpm);

        if (!result.canChange || result.project === currentWorkspace.project) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          project: result.project,
        };
      });

      return true;
    },
    [project, showTimelineStatusFeedback, updateWorkspaceState],
  );

  const handleRecordingSettingsChange = useCallback(
    (recordingSettings: RecordingSettings) => {
      updateWorkspaceState((currentWorkspace) => {
        if (currentWorkspace.activeTransport === 'REC') {
          return currentWorkspace;
        }

        const normalizedSettings = normalizeRecordingSettings(recordingSettings);
        const currentSettings = currentWorkspace.project.recordingSettings;

        if (
          normalizedSettings.countInBars === currentSettings.countInBars &&
          normalizedSettings.metronomeEnabled === currentSettings.metronomeEnabled &&
          normalizedSettings.metronomeVolume === currentSettings.metronomeVolume
        ) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          project: {
            ...currentWorkspace.project,
            recordingSettings: normalizedSettings,
          },
        };
      });
    },
    [updateWorkspaceState],
  );

  const handleProjectKeyChange = useCallback(
    (key: string) => {
      updateWorkspaceState((currentWorkspace) => {
        const nextKey = key.trim();

        if (!nextKey || nextKey === currentWorkspace.project.key) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          project: {
            ...currentWorkspace.project,
            key: nextKey,
          },
        };
      });
    },
    [updateWorkspaceState],
  );

  const handleProjectGridResolutionChange = useCallback(
    (gridResolution: TimelineGridResolution) => {
      updateWorkspaceState((currentWorkspace) => {
        if (gridResolution === currentWorkspace.project.gridResolution) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          project: {
            ...currentWorkspace.project,
            gridResolution,
            playheadTick: resolveTimelineTick(
              currentWorkspace.project.playheadTick,
              gridResolution,
              currentWorkspace.project.totalTicks,
            ),
          },
        };
      });
    },
    [updateWorkspaceState],
  );

  const handleProjectTotalBarsChange = useCallback(
    (totalBars: number) => {
      const nextTotalTicks = clampTick(
        barsToTicks(totalBars),
        getMinimumTotalTicks(),
        barsToTicks(MAX_TIMELINE_BARS),
      );
      const latestClipEndTick = getLatestClipEndTick(project.tracks);

      if (nextTotalTicks < latestClipEndTick) {
        const requestedBars = Math.round(ticksToBars(nextTotalTicks));
        const requiredBars = getRequiredTimelineBarsForClips(project.tracks);
        const helpText = `Cannot set Length to ${formatCount(
          requestedBars,
          'bar',
        )}. Existing clips require at least ${formatCount(requiredBars, 'bar')}.`;

        showTimelineStatusFeedback({ helpText, message: 'LENGTH BLOCKED', tone: 'warning' });
        return false;
      }

      updateWorkspaceState((currentWorkspace) => {
        if (nextTotalTicks === currentWorkspace.project.totalTicks) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          project: {
            ...currentWorkspace.project,
            totalTicks: nextTotalTicks,
            playheadTick: resolveTimelineTick(
              currentWorkspace.project.playheadTick,
              currentWorkspace.project.gridResolution,
              nextTotalTicks,
            ),
          },
        };
      });
      return true;
    },
    [project.tracks, showTimelineStatusFeedback, updateWorkspaceState],
  );

  const handleProjectPlayheadChange = useCallback(
    (playheadTick: number, options: ProjectPlayheadChangeOptions = {}) => {
      if (workspace.activeTransport === 'REC') {
        setHeaderHelpMessage('Playhead is frozen while Count-In or recording is active.');
        return;
      }

      stopActiveAudioPlayback(false);
      updateWorkspaceViewState((currentWorkspace) => {
        const shouldSnapToGrid = options.snapToGrid ?? true;
        const nextPlayheadTick = shouldSnapToGrid
          ? resolveTimelineTick(
              playheadTick,
              currentWorkspace.project.gridResolution,
              currentWorkspace.project.totalTicks,
            )
          : clampTick(Math.round(playheadTick), 0, currentWorkspace.project.totalTicks);

        if (nextPlayheadTick === currentWorkspace.project.playheadTick) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          project: {
            ...currentWorkspace.project,
            playheadTick: nextPlayheadTick,
          },
        };
      });
    },
    [stopActiveAudioPlayback, updateWorkspaceViewState, workspace.activeTransport],
  );

  const handleAddPatchTab = useCallback(
    (templateId: string) => {
      const selectedTemplate =
        patchTabTemplates.find((patchTab) => patchTab.id === templateId) ??
        patchTabTemplates[0];
      const availability =
        resolvePatchTabTemplateAvailability(selectedTemplate);

      if (!availability.canCreate) {
        setHeaderHelpMessage(
          availability.message ?? 'This PatchTab is not available.',
        );
        return;
      }

      updateWorkspaceState((currentWorkspace) => {
        const patchTab = createPatchTabFromTemplate(
          selectedTemplate,
          currentWorkspace.project.patchTabs,
        );

        return {
          ...currentWorkspace,
          selectedPatchTabId: patchTab.id,
          project: {
            ...currentWorkspace.project,
            selectedPatchTabId: patchTab.id,
            patchTabs: [...currentWorkspace.project.patchTabs, patchTab],
          },
        };
      }, patchTabHistoryEditDraft);
    },
    [updateWorkspaceState],
  );

  const handleMovePatchTab = useCallback(
    (patchTabId: string, direction: 'up' | 'down') => {
      updateWorkspaceState((currentWorkspace) => {
        const index = currentWorkspace.project.patchTabs.findIndex((patchTab) => patchTab.id === patchTabId);
        const targetIndex = direction === 'up' ? index - 1 : index + 1;

        if (index < 0 || targetIndex < 0 || targetIndex >= currentWorkspace.project.patchTabs.length) {
          return currentWorkspace;
        }

        const patchTabs = [...currentWorkspace.project.patchTabs];
        const [patchTab] = patchTabs.splice(index, 1);
        patchTabs.splice(targetIndex, 0, patchTab);
        const refreshedConnections = refreshTabFlowConnections(
          currentWorkspace.project.connections,
          patchTabs,
        );
        const tabFlowLines = reconcileTabFlowLines(
          refreshedConnections,
          currentWorkspace.project.tabFlowLines,
        );
        const synchronizedPatchTabs = synchronizePatchTabConnectionBindings(
          patchTabs,
          refreshedConnections,
        );
        const connections = synchronizeTabFlowConnectionStates(
          refreshedConnections,
          tabFlowLines,
          synchronizedPatchTabs,
        );

        return {
          ...currentWorkspace,
          project: {
            ...currentWorkspace.project,
            patchTabs: synchronizedPatchTabs,
            connections,
            tabFlowLines,
          },
        };
      }, patchTabHistoryEditDraft);
    },
    [updateWorkspaceState],
  );

  const handleRenamePatchTab = useCallback(
    (patchTabId: string, name: string) => {
      updateWorkspaceState(
        (currentWorkspace) => ({
          ...currentWorkspace,
          project: {
            ...currentWorkspace.project,
            patchTabs: currentWorkspace.project.patchTabs.map((patchTab) =>
              patchTab.id === patchTabId ? { ...patchTab, name } : patchTab,
            ),
          },
        }),
        patchTabHistoryEditDraft,
      );
    },
    [updateWorkspaceState],
  );

  const handleDeletePatchTab = useCallback(
    (patchTabId: string) => {
      const basicPitchController = basicPitchHumToMidiUiControllerRef.current;

      if (
        basicPitchController.hasOwnedOperation(patchTabId) &&
        (basicPitchController.isExecuting ||
          basicPitchController.state.status === 'REGISTRATION_PENDING')
      ) {
        setHeaderHelpMessage(
          'Settle or recover this exact Basic Pitch Job before deleting its Hum to MIDI PatchTab.',
        );
        return;
      }

      basicPitchController.discard(patchTabId);
      updateWorkspaceState((currentWorkspace) => {
        const patchTabs = currentWorkspace.project.patchTabs.filter((patchTab) => patchTab.id !== patchTabId);
        const connections = removePatchTabConnectionsAndDownstream(
          currentWorkspace.project.connections,
          currentWorkspace.project.tabFlowLines,
          patchTabId,
        );
        const tabFlowLines = reconcileTabFlowLines(
          connections,
          pruneEmptiedTabFlowLines(currentWorkspace.project.tabFlowLines, connections),
        );
        const synchronizedPatchTabs = synchronizePatchTabConnectionBindings(
          patchTabs,
          connections,
        );
        const selectedConnectionId = connections.some((connection) => connection.id === currentWorkspace.selectedConnectionId)
          ? currentWorkspace.selectedConnectionId
          : connections[0]?.id ?? '';
        const selectedTabFlowLineId = getPreferredSelectedTabFlowLineId(
          tabFlowLines,
          currentWorkspace.selectedTabFlowLineId,
          selectedConnectionId,
        );
        const selectedPatchTabId =
          currentWorkspace.selectedPatchTabId === patchTabId
            ? patchTabs[0]?.id ?? ''
            : currentWorkspace.selectedPatchTabId;

        return {
          ...currentWorkspace,
          selectedPatchTabId,
          selectedConnectionId,
          selectedTabFlowLineId,
          project: {
            ...currentWorkspace.project,
            selectedPatchTabId,
            patchTabs: synchronizedPatchTabs,
            connections,
            tabFlowLines,
          },
        };
      }, patchTabHistoryEditDraft);
    },
    [updateWorkspaceState],
  );

  const handleRequestDeletePatchTab = useCallback(
    (patchTabId: string) => {
      const patchTab = project.patchTabs.find((candidate) => candidate.id === patchTabId);

      if (!patchTab) {
        return;
      }

      if (
        printMixState.patchTabId === patchTabId &&
        [
          'CANCEL_REQUESTED',
          'OUTCOME_UNKNOWN',
          'PREPARING',
          'RECOVERING',
          'REGISTRATION_PENDING',
          'RUNNING',
        ].includes(printMixState.status)
      ) {
        setHeaderHelpMessage(
          'Settle or recover this exact PRINT MIX operation before deleting its PatchTab.',
        );
        return;
      }

      if (!isSafetyModeEnabled) {
        handleDeletePatchTab(patchTabId);
        return;
      }

      const patchTabMap = new Map(project.patchTabs.map((candidate) => [candidate.id, candidate]));
      const deletionImpact = getPatchTabDeletionImpact(project, patchTabId);
      const routeLabel = deletionImpact.removedConnections.length === 1 ? 'route' : 'routes';

      requestSafetyConfirm({
        title: 'Delete PatchTab',
        message: `Delete ${patchTab.name} and update affected TabFlow routes.`,
        details: [
          `PatchTab: ${patchTab.name}`,
          `${deletionImpact.removedConnections.length} ${routeLabel} will be removed`,
          ...deletionImpact.removedConnections.map((connection) => formatConnectionRouteLabel(connection, patchTabMap)),
        ],
        confirmLabel: 'DELETE',
        onConfirm: () => handleDeletePatchTab(patchTabId),
      });
    },
    [
      handleDeletePatchTab,
      isSafetyModeEnabled,
      printMixState,
      project,
      requestSafetyConfirm,
    ],
  );

  const handleParameterChange = useCallback(
    (patchTabId: string, parameterId: string, value: PatchTabParameterValue) => {
      updateWorkspaceState((currentWorkspace) => {
        let didChange = false;

        const patchTabs = currentWorkspace.project.patchTabs.map((patchTab) => {
          if (patchTab.id !== patchTabId) {
            return patchTab;
          }

          const nextPatchTab = updatePatchTabParameter(patchTab, parameterId, value);
          didChange ||= nextPatchTab !== patchTab;

          return nextPatchTab;
        });

        if (!didChange) {
          return currentWorkspace;
        }

        return {
          ...currentWorkspace,
          project: {
            ...currentWorkspace.project,
            patchTabs,
          },
        };
      });
    },
    [updateWorkspaceState],
  );

  const handleParameterChanges = useCallback(
    (
      patchTabId: string,
      updates: readonly Readonly<{
        parameterId: string;
        value: PatchTabParameterValue;
      }>[],
    ) => {
      updateWorkspaceState((currentWorkspace) => {
        let didChange = false;
        const patchTabs = currentWorkspace.project.patchTabs.map((patchTab) => {
          if (patchTab.id !== patchTabId) {
            return patchTab;
          }

          const nextPatchTab = updates.reduce(
            (currentPatchTab, update) =>
              updatePatchTabParameter(
                currentPatchTab,
                update.parameterId,
                update.value,
              ),
            patchTab,
          );
          didChange ||= nextPatchTab !== patchTab;
          return nextPatchTab;
        });

        return didChange
          ? {
              ...currentWorkspace,
              project: { ...currentWorkspace.project, patchTabs },
            }
          : currentWorkspace;
      });
    },
    [updateWorkspaceState],
  );

  const settlePrintMixUiRegistration = useCallback(
    (result: Extract<PrintMixUiResult, { kind: 'registered' }>) => {
      const historyAtCommit = historyRef.current;
      const workspaceAtCommit = historyAtCommit.present.value;

      if (workspaceAtCommit.project !== result.baseProject) {
        const message =
          'PRINT MIX finalized, but Project registration was interrupted because the Project changed before commit. Recover this exact operation.';
        setPrintMixState({
          mediaType: result.state.mediaType,
          message,
          operationId: result.operationId,
          patchTabId: result.state.patchTabId,
          status: 'REGISTRATION_PENDING',
        });
        setHeaderHelpMessage(message);
        return;
      }

      const committedWorkspace = normalizeWorkspaceState({
        ...workspaceAtCommit,
        activeTransport: 'STOP',
        selectedClipId: result.output.clipId,
        selectedPatchTabId:
          result.state.patchTabId ?? workspaceAtCommit.selectedPatchTabId,
        project: {
          ...result.project,
          selection: {
            items: [{ id: result.output.clipId, type: 'clip' }],
          },
          status: 'PRINT MIX READY',
        },
      });
      let committedHistory: WorkspaceHistory;

      if (result.status === 'ALREADY_REGISTERED') {
        committedHistory = updateSessionEditPresent(
          historyAtCommit,
          () => committedWorkspace,
        );
      } else {
        workspaceEditSequenceRef.current += 1;
        committedHistory = commitSessionEdit(
          historyAtCommit,
          committedWorkspace,
          {
            category: 'track',
            createdAt: new Date().toISOString(),
            id: `edit-${Date.now()}-${workspaceEditSequenceRef.current}`,
            label: `Print ${result.output.clipName}`,
          },
          undoHistoryLimit,
        );
      }

      historyRef.current = committedHistory;
      workspaceRef.current = committedWorkspace;
      setHistory(committedHistory);
      printMixUiControllerRef.current.acknowledgeRegistration(
        result.operationId,
      );
      setPrintMixState(result.state);
      showTimelineStatusFeedback({
        helpText: result.state.message ??
          `${result.output.clipName} registered on muted Track ${result.output.trackName}.`,
        message: result.clippingWarning ? 'CLIPPING WARNING' : 'PRINT MIX READY',
        tone: result.clippingWarning ? 'warning' : 'success',
      });
    },
    [showTimelineStatusFeedback],
  );

  const handleExecutePrintMix = useCallback(
    async (patchTabId: string, recover: boolean) => {
      const controller = printMixUiControllerRef.current;
      const currentAvailability = engineAvailabilityRef.current;
      const client =
        currentAvailability.acceptsNewJobs &&
        projectRootState.status === 'READY'
          ? localEngineClientRef.current
          : undefined;
      const request = {
        client,
        getProject: () => workspaceRef.current.project,
        onState: (state: PrintMixUiState) => {
          setPrintMixState(state);
          if (state.message) {
            setHeaderHelpMessage(state.message);
          }
        },
        patchTabId,
      };
      const result = recover
        ? await controller.recover(request)
        : await controller.run(request);

      if (result.kind === 'registered') {
        settlePrintMixUiRegistration(result);
        return;
      }

      setHeaderHelpMessage(
        result.kind === 'busy'
          ? 'One PRINT MIX operation is already active.'
          : result.kind === 'recovery-required'
            ? 'Recover the exact unresolved PRINT MIX operation before starting another.'
            : result.state.message ?? 'PRINT MIX did not change the Project.',
      );
    },
    [projectRootState.status, settlePrintMixUiRegistration],
  );

  const handleRunPrintMix = useCallback(
    (patchTabId: string) => {
      void handleExecutePrintMix(patchTabId, false);
    },
    [handleExecutePrintMix],
  );

  const handleRecoverPrintMix = useCallback(
    (patchTabId: string) => {
      void handleExecutePrintMix(patchTabId, true);
    },
    [handleExecutePrintMix],
  );

  const handleCancelPrintMix = useCallback(() => {
    if (!printMixUiControllerRef.current.cancel()) {
      setHeaderHelpMessage('No active PRINT MIX operation can be canceled.');
    }
  }, []);

  const settleBasicPitchHumToMidiRegistration = useCallback(
    (result: Extract<BasicPitchHumToMidiUiResult, { kind: 'registered' }>) => {
      const controller = basicPitchHumToMidiUiControllerRef.current;
      const historyAtCommit = historyRef.current;
      const workspaceAtCommit = historyAtCommit.present.value;

      if (workspaceAtCommit.project !== result.baseProject) {
        const message =
          'Basic Pitch completed, but MIDI registration was interrupted because the Project changed before commit. Recover this exact Job.';
        controller.markRegistrationPending(result.jobId, message);
        setBasicPitchHumToMidiState(controller.state);
        setHeaderHelpMessage(message);
        return;
      }

      const committedWorkspace = normalizeWorkspaceState({
        ...workspaceAtCommit,
        activeTransport: 'STOP',
        selectedClipId: result.targetClip.id,
        selectedPatchTabId:
          result.state.patchTabId ?? workspaceAtCommit.selectedPatchTabId,
        project: {
          ...result.project,
          status: 'MIDI READY',
        },
      });
      let committedHistory: WorkspaceHistory;

      if (result.status === 'ALREADY_REGISTERED') {
        committedHistory = updateSessionEditPresent(
          historyAtCommit,
          () => committedWorkspace,
        );
      } else {
        workspaceEditSequenceRef.current += 1;
        committedHistory = commitSessionEdit(
          historyAtCommit,
          committedWorkspace,
          {
            category: result.targetCreated ? 'track' : 'take',
            createdAt: new Date().toISOString(),
            id: `edit-${Date.now()}-${workspaceEditSequenceRef.current}`,
            label: `Convert ${result.sourceClipName} to MIDI`,
          },
          undoHistoryLimit,
        );
      }

      historyRef.current = committedHistory;
      workspaceRef.current = committedWorkspace;
      setHistory(committedHistory);
      controller.acknowledgeRegistration(result.jobId);
      setBasicPitchHumToMidiState(result.state);
      showTimelineStatusFeedback({
        helpText:
          result.state.message ??
          `${result.targetClip.name} registered as the Active Basic Pitch MIDI Take.`,
        message: 'MIDI READY',
        tone: 'success',
      });
    },
    [showTimelineStatusFeedback],
  );

  const handleExecuteBasicPitchHumToMidi = useCallback(
    async (
      patchTabId: string,
      mode: 'recover' | 'retry' | 'run',
    ) => {
      const controller = basicPitchHumToMidiUiControllerRef.current;
      const currentAvailability = engineAvailabilityRef.current;
      const currentRuntime = basicPitchRuntimeStateRef.current;

      if (mode !== 'recover' && currentRuntime.status !== 'READY') {
        setHeaderHelpMessage(
          currentRuntime.status === 'CHECKING'
            ? 'Checking the pinned Basic Pitch Runtime and ONNX model.'
            : currentRuntime.message,
        );
        return;
      }

      const client =
        currentAvailability.acceptsNewJobs &&
        projectRootState.status === 'READY'
          ? localEngineClientRef.current
          : undefined;
      const request = {
        client,
        getProject: () => workspaceRef.current.project,
        onState: (state: BasicPitchHumToMidiUiState) => {
          setBasicPitchHumToMidiState(state);
          if (state.message) {
            setHeaderHelpMessage(state.message);
          }
        },
        patchTabId,
        resolveDefaultSoundFontAssignment: () =>
          createBuiltInDefaultSoundFontAssignment(
            soundFontCatalogStateRef.current,
          ),
      };
      const result =
        mode === 'recover'
          ? await controller.recover(request)
          : mode === 'retry'
            ? await controller.retry(request)
            : await controller.run(request);

      if (result.kind === 'registered') {
        settleBasicPitchHumToMidiRegistration(result);
        return;
      }

      setHeaderHelpMessage(
        result.kind === 'busy'
          ? 'One Hum to MIDI operation is already active.'
          : result.state.message ?? 'Hum to MIDI did not change the Project.',
      );
    },
    [projectRootState.status, settleBasicPitchHumToMidiRegistration],
  );

  const handleRunBasicPitchHumToMidi = useCallback(
    (patchTabId: string) => {
      void handleExecuteBasicPitchHumToMidi(patchTabId, 'run');
    },
    [handleExecuteBasicPitchHumToMidi],
  );

  const handleRetryBasicPitchHumToMidi = useCallback(
    (patchTabId: string) => {
      void handleExecuteBasicPitchHumToMidi(patchTabId, 'retry');
    },
    [handleExecuteBasicPitchHumToMidi],
  );

  const handleRecoverBasicPitchHumToMidi = useCallback(
    (patchTabId: string) => {
      void handleExecuteBasicPitchHumToMidi(patchTabId, 'recover');
    },
    [handleExecuteBasicPitchHumToMidi],
  );

  const handleCancelBasicPitchHumToMidi = useCallback(() => {
    if (!basicPitchHumToMidiUiControllerRef.current.cancel()) {
      setHeaderHelpMessage(
        'Basic Pitch can be canceled only while its exact Job is still queued. Wait for an active Job to settle.',
      );
    }
  }, []);

  const handleConnectPatchTabs = useCallback(
    (
      fromPatchTabId: string,
      toPatchTabId: string,
      fromPortId?: string,
      toPortId?: string,
    ) => {
      const activeTabFlowLine = getProjectTabFlowLines(project).find(
        (line) => line.id === workspace.selectedTabFlowLineId,
      );

      if (!activeTabFlowLine) {
        setHeaderHelpMessage(ROUTE_LINE_REQUIRED_HELP_MESSAGE);
        updateWorkspaceViewState((currentWorkspace) => ({
          ...currentWorkspace,
          pendingPortSelection: undefined,
        }));
        return;
      }

      const fromPatchTab = project.patchTabs.find((patchTab) => patchTab.id === fromPatchTabId);
      const toPatchTab = project.patchTabs.find((patchTab) => patchTab.id === toPatchTabId);
      const resolvedFromPortId = fromPortId ?? getDefaultOutputPort(fromPatchTab)?.id;
      const resolvedToPortId = toPortId ?? getDefaultInputPort(toPatchTab)?.id;
      const targetPort = getPatchTabDefinition(toPatchTab)?.inputs.find(
        (port) => port.id === resolvedToPortId,
      );
      const structureState = getTabFlowStructureState(
        project.connections,
        fromPatchTabId,
        toPatchTabId,
        resolvedToPortId,
        targetPort?.cardinality.max ?? 1,
      );

      if (structureState !== 'available' && structureState !== 'already-connected') {
        setHeaderHelpMessage(createTabFlowStructureBlockedHelpMessage(structureState));
        updateWorkspaceViewState((currentWorkspace) => ({
          ...currentWorkspace,
          pendingPortSelection: undefined,
        }));
        return;
      }

      updateWorkspaceState((currentWorkspace) => {
        if (fromPatchTabId === toPatchTabId) {
          return currentWorkspace;
        }

        const fromPatchTab = currentWorkspace.project.patchTabs.find((patchTab) => patchTab.id === fromPatchTabId);
        const toPatchTab = currentWorkspace.project.patchTabs.find((patchTab) => patchTab.id === toPatchTabId);

        if (!fromPatchTab || !toPatchTab) {
          return currentWorkspace;
        }

        const tabFlowLines = getProjectTabFlowLines(currentWorkspace.project);
        const selectedTabFlowLine =
          tabFlowLines.find(
            (line) => line.id === currentWorkspace.selectedTabFlowLineId,
          ) ?? tabFlowLines[0];

        if (!selectedTabFlowLine) {
          return {
            ...currentWorkspace,
            pendingPortSelection: undefined,
          };
        }

        const existingConnection = currentWorkspace.project.connections.find(
          (candidate) =>
            candidate.fromPatchTabId === fromPatchTabId &&
            candidate.toPatchTabId === toPatchTabId &&
            candidate.fromPortId === resolvedFromPortId &&
            candidate.toPortId === resolvedToPortId,
        );
        const connection = createTabFlowConnection(
          fromPatchTab,
          toPatchTab,
          existingConnection?.order ?? getNextTabFlowConnectionOrder(currentWorkspace.project.connections),
          existingConnection?.id ??
            createTabFlowConnectionId(
              fromPatchTab.id,
              toPatchTab.id,
              new Set(currentWorkspace.project.connections.map((candidate) => candidate.id)),
              selectedTabFlowLine?.id,
            ),
          resolvedFromPortId,
          resolvedToPortId,
        );
        const selectedRootLine = getTabFlowFamilyRoot(tabFlowLines, selectedTabFlowLine.id);
        const lineAwareConnection = {
          ...connection,
          enabled: connection.enabled && (selectedRootLine?.enabled ?? selectedTabFlowLine.enabled),
        };
        const connections = sortTabFlowConnections([
          ...currentWorkspace.project.connections.filter((candidate) => candidate.id !== lineAwareConnection.id),
          lineAwareConnection,
        ]);
        const nextTabFlowLines = placeConnectionInTabFlowFamily(
          tabFlowLines,
          selectedTabFlowLine.id,
          lineAwareConnection,
          connections,
        );
        const patchTabs = synchronizePatchTabConnectionBindings(
          currentWorkspace.project.patchTabs,
          connections,
        );
        const synchronizedConnections = synchronizeTabFlowConnectionStates(
          connections,
          nextTabFlowLines,
          patchTabs,
        );
        const selectedTabFlowLineId =
          findTabFlowLineIdForConnection(nextTabFlowLines, lineAwareConnection.id) ??
          currentWorkspace.selectedTabFlowLineId;

        return {
          ...currentWorkspace,
          selectedConnectionId: lineAwareConnection.id,
          selectedTabFlowLineId,
          pendingPortSelection: undefined,
          project: {
            ...currentWorkspace.project,
            patchTabs,
            connections: synchronizedConnections,
            tabFlowLines: nextTabFlowLines,
          },
        };
      });
    },
    [
      project,
      updateWorkspaceState,
      updateWorkspaceViewState,
      workspace.selectedTabFlowLineId,
    ],
  );

  const handlePatchPortClick = useCallback(
    (patchTabId: string, direction: PatchPortDirection, portId?: string) => {
      updateWorkspaceViewState((currentWorkspace) => {
        const pending = currentWorkspace.pendingPortSelection;

        if (
          !pending ||
          (pending.patchTabId === patchTabId && pending.portId === portId) ||
          pending.direction === direction
        ) {
          return {
            ...currentWorkspace,
            pendingPortSelection: { patchTabId, direction, portId },
          };
        }

        const fromPatchTabId = pending.direction === 'output' ? pending.patchTabId : patchTabId;
        const toPatchTabId = pending.direction === 'input' ? pending.patchTabId : patchTabId;
        const fromPortId = pending.direction === 'output' ? pending.portId : portId;
        const toPortId = pending.direction === 'input' ? pending.portId : portId;

        setTimeout(
          () => handleConnectPatchTabs(fromPatchTabId, toPatchTabId, fromPortId, toPortId),
          0,
        );

        return {
          ...currentWorkspace,
          pendingPortSelection: undefined,
        };
      });
    },
    [handleConnectPatchTabs, updateWorkspaceViewState],
  );

  const handleClearPatchPortSelection = useCallback(() => {
    updateWorkspaceViewState((currentWorkspace) => ({
      ...currentWorkspace,
      pendingPortSelection: undefined,
    }));
  }, [updateWorkspaceViewState]);

  const handleDeleteConnection = useCallback(
    (connectionId: string) => {
      updateWorkspaceState((currentWorkspace) => {
        const connections = removeConnectionAndDownstream(
          currentWorkspace.project.connections,
          currentWorkspace.project.tabFlowLines,
          connectionId,
        );
        const tabFlowLines = reconcileTabFlowLines(
          connections,
          pruneEmptiedTabFlowLines(currentWorkspace.project.tabFlowLines, connections),
        );
        const patchTabs = synchronizePatchTabConnectionBindings(
          currentWorkspace.project.patchTabs,
          connections,
        );
        const selectedConnectionId = connections.some((connection) => connection.id === currentWorkspace.selectedConnectionId)
          ? currentWorkspace.selectedConnectionId
          : connections[0]?.id ?? '';
        const selectedTabFlowLineId = getPreferredSelectedTabFlowLineId(
          tabFlowLines,
          currentWorkspace.selectedTabFlowLineId,
          selectedConnectionId,
        );

        return {
          ...currentWorkspace,
          selectedTabFlowLineId,
          selectedConnectionId,
          project: {
            ...currentWorkspace.project,
            patchTabs,
            connections,
            tabFlowLines,
          },
        };
      });
    },
    [updateWorkspaceState],
  );

  const handleSetTabFlowLineEnabled = useCallback(
    (tabFlowLineId: string, enabled: boolean) => {
      const targetLine = getProjectTabFlowLines(project).find((line) => line.id === tabFlowLineId);

      if (targetLine) {
        setHeaderHelpMessage(
          createTabFlowLineEnabledHelpMessage(
            { ...targetLine, enabled },
            getTabFlowLineDisplayLabel(project, targetLine.id),
          ),
        );
      }

      updateWorkspaceState((currentWorkspace) => {
        const tabFlowLines = getProjectTabFlowLines(currentWorkspace.project);
        const targetLine = tabFlowLines.find((line) => line.id === tabFlowLineId);

        if (!targetLine) {
          return currentWorkspace;
        }

        const familyLines = getTabFlowFamilyLines(tabFlowLines, targetLine.id);
        const connectionIdSet = new Set(familyLines.flatMap((line) => line.connectionIds));
        const nextTabFlowLines = setTabFlowFamilyEnabled(tabFlowLines, targetLine.id, enabled);
        const synchronizedConnectionMap = new Map(
          synchronizeTabFlowConnectionStates(
            currentWorkspace.project.connections,
            nextTabFlowLines,
            currentWorkspace.project.patchTabs,
          ).map((connection) => [connection.id, connection]),
        );
        const connections = currentWorkspace.project.connections.map((connection) =>
          connectionIdSet.has(connection.id)
            ? synchronizedConnectionMap.get(connection.id) ?? connection
            : connection,
        );

        return {
          ...currentWorkspace,
          project: {
            ...currentWorkspace.project,
            connections,
            tabFlowLines: nextTabFlowLines,
          },
        };
      });
    },
    [project, updateWorkspaceState],
  );

  const handleBuildAutoFlow = useCallback(() => {
    updateWorkspaceState((currentWorkspace) => {
      const connections = buildTabFlowConnections(currentWorkspace.project.patchTabs);
      const tabFlowLines = reconcileTabFlowLines(connections, []);
      const patchTabs = synchronizePatchTabConnectionBindings(
        currentWorkspace.project.patchTabs,
        connections,
      );

      return {
        ...currentWorkspace,
        selectedConnectionId: connections[0]?.id ?? '',
        selectedTabFlowLineId: tabFlowLines[0]?.id ?? '',
        project: {
          ...currentWorkspace.project,
          patchTabs,
          connections,
          tabFlowLines,
        },
      };
    });
  }, [updateWorkspaceState]);

  const handleApplyAutoPatchGuard = useCallback(() => {
    const targetClipInfos = getAutoPatchTargetClipInfos(
      project.tracks,
      project.selection,
      selectedClipInfo,
    );
    const preflightBlockReason = getAutoPatchPreflightBlockReason(project, targetClipInfos);

    if (preflightBlockReason) {
      setHeaderHelpMessage(`AUTO PATCH BLOCKED: ${preflightBlockReason}`);
      return;
    }

    updateWorkspaceState((currentWorkspace) => {
      const targetClipInfos = getAutoPatchTargetClipInfos(
        currentWorkspace.project.tracks,
        currentWorkspace.project.selection,
        findSelectedClip(currentWorkspace.project.tracks, currentWorkspace.selectedClipId),
      );
      const targetClipIds = targetClipInfos.map((target) => target.clip.id);

      if (targetClipIds.length === 0) {
        return currentWorkspace;
      }

      const project = applyAutoPatchGuardToClips(currentWorkspace.project, targetClipIds);

      if (project === currentWorkspace.project) {
        return currentWorkspace;
      }

      const take = createAutoPatchDryRunTake(currentWorkspace.project, targetClipInfos);

      return {
        ...currentWorkspace,
        project: take
          ? {
              ...project,
              takes: appendTakeHistoryEntry(project.takes, take),
            }
          : project,
      };
    });
  }, [project, selectedClipInfo, updateWorkspaceState]);

  const runOneShotGenerationFromWorkspace = useCallback(async (
    client: LocalEngineClient,
    currentWorkspace: WorkspaceState,
  ) => {
    const interruptedPlayback = releaseActiveAudioPlayback();
    const interruptedPreview = releaseInstrumentAudioPreview();
    const interruptedAudition = releaseSoundFontAudition();
    metronomeRuntimeRef.current.stop();

    if (interruptedPreview) {
      setInstrumentAudioPreviewState({ status: 'IDLE' });
    }

    if (interruptedAudition) {
      setSoundFontAuditionState({ status: 'IDLE' });
    }

    const shouldStopTransport =
      Boolean(interruptedPlayback) || currentWorkspace.activeTransport !== 'STOP';
    const initialWorkspace = shouldStopTransport
      ? normalizeWorkspaceState({
          ...currentWorkspace,
          activeTransport: 'STOP',
          project: {
            ...currentWorkspace.project,
            status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
          },
        })
      : currentWorkspace;

    if (initialWorkspace !== currentWorkspace) {
      workspaceRef.current = initialWorkspace;
      setHistory((currentHistory) =>
        currentHistory.present.value === currentWorkspace
          ? updateSessionEditPresent(currentHistory, () => initialWorkspace)
          : currentHistory,
      );
    }

    const initialProject = initialWorkspace.project;
    const requestId = ++autoPatchProductionRequestIdRef.current;
    const createdAt = new Date().toISOString();
    const identityToken = `one-shot-${Date.now()}-${requestId}`;
    const abortController = new AbortController();
    autoPatchProductionAbortControllerRef.current = abortController;
    autoPatchProductionInProgressRef.current = true;
    setSafetyConfirmRequest(undefined);
    setAutoPatchProductionState(
      createPreparingAutoPatchProductionUiState(
        'Checking ONE SHOT GENERATION Prompt, Lyrics, routing, and runtime readiness.',
      ),
    );
    setHeaderHelpMessage('Checking ONE SHOT GENERATION.');

    try {
      const result = await runOneShotGeneration(client, initialProject, {
        ace: ACE_STEP_PRODUCTION_MONITORING_POLICY,
        getCurrentProject: () => workspaceRef.current.project,
        historyLimit: undoHistoryLimit,
        identity: {
          createdAt,
          operationId: identityToken,
          requestToken: identityToken,
          vocalClipId: `${identityToken}-vocal-clip`,
          vocalTrackId: `${identityToken}-vocal-track`,
        },
        onProgress: (progress) => {
          if (autoPatchProductionRequestIdRef.current !== requestId) {
            return;
          }

          setAutoPatchProductionState(
            Object.freeze({
              activeStageId: progress.stageId,
              completedStageCount: progress.completedStageCount,
              ...(progress.jobProgress
                ? { jobProgress: progress.jobProgress }
                : {}),
              message: progress.message,
              runId: identityToken,
              stageCount: progress.stageCount,
              status: 'RUNNING' as const,
            }),
          );
          setHeaderHelpMessage(progress.message);
        },
        signal: abortController.signal,
        verifyGeneratedAudio: async (_project, artifact) => {
          const availability = await verifyGeneratedAudioArtifactsForCommit(
            client,
            [artifact],
          );

          if (!availability.ok) {
            throw new Error(availability.message);
          }

          return availability.evidence;
        },
      });

      if (autoPatchProductionRequestIdRef.current !== requestId) {
        return;
      }

      if (
        result.canCommit &&
        result.project !== initialProject &&
        workspaceRef.current.project === initialProject
      ) {
        const selectedClipId =
          result.project.selection.items.length === 1 &&
          result.project.selection.items[0]?.type === 'clip'
            ? result.project.selection.items[0].id
            : initialWorkspace.selectedClipId;
        const nextWorkspace = normalizeWorkspaceState({
          ...workspaceRef.current,
          activeTransport: 'STOP',
          project: result.project,
          selectedClipId,
        });
        workspaceRef.current = nextWorkspace;
        workspaceEditSequenceRef.current += 1;
        setHistory((currentHistory) =>
          currentHistory.present.value.project === initialProject
            ? commitSessionEdit(
                currentHistory,
                nextWorkspace,
                {
                  category: 'auto-patch',
                  createdAt: new Date().toISOString(),
                  id: `edit-${Date.now()}-${workspaceEditSequenceRef.current}`,
                  label: 'Run ONE SHOT GENERATION',
                },
                undoHistoryLimit,
              )
            : currentHistory,
        );
      }

      const status =
        result.status === 'COMPLETED'
          ? 'COMPLETED'
          : result.status === 'PARTIAL'
            ? 'PARTIAL'
            : result.status === 'CANCELED'
              ? 'CANCELED'
              : result.status === 'BLOCKED'
                ? 'BLOCKED'
                : 'FAILED';
      setAutoPatchProductionState(
        Object.freeze({
          completedStageCount: result.completedStageCount,
          message: result.message,
          runId: result.operationId,
          stageCount: 2,
          status,
        }),
      );
      setHeaderHelpMessage(result.message);
    } catch (error) {
      if (autoPatchProductionRequestIdRef.current === requestId) {
        const message =
          error instanceof Error
            ? error.message
            : 'ONE SHOT GENERATION failed unexpectedly.';
        setAutoPatchProductionState(
          createFailedAutoPatchProductionUiState(message, { stageCount: 2 }),
        );
        setHeaderHelpMessage(message);
      }
    } finally {
      if (autoPatchProductionRequestIdRef.current === requestId) {
        autoPatchProductionAbortControllerRef.current = undefined;
        autoPatchProductionInProgressRef.current = false;
      }
    }
  }, [
    releaseActiveAudioPlayback,
    releaseInstrumentAudioPreview,
    releaseSoundFontAudition,
    undoHistoryLimit,
  ]);

  const handleRunAutoPatchProduction = useCallback(async (standalonePatchTabId?: string) => {
    if (autoPatchProductionInProgressRef.current) {
      setHeaderHelpMessage(
        'One Auto Patch production run is already active.',
      );
      return;
    }

    const client = localEngineClientRef.current;
    const currentAvailability = engineAvailabilityRef.current;

    if (!client || !currentAvailability.acceptsNewJobs) {
      const state = createBlockedAutoPatchProductionUiState(
        currentAvailability.message,
      );
      setAutoPatchProductionState(state);
      setHeaderHelpMessage(state.message);
      return;
    }

    if (projectRootState.status !== 'READY') {
      const state = createBlockedAutoPatchProductionUiState(
        'Production Auto Patch requires one ready Project Root.',
      );
      setAutoPatchProductionState(state);
      setHeaderHelpMessage(state.message);
      return;
    }

    if (recordingRuntimePhaseRef.current !== 'IDLE') {
      const state = createBlockedAutoPatchProductionUiState(
        'Stop recording before starting Production Auto Patch.',
      );
      setAutoPatchProductionState(state);
      setHeaderHelpMessage(state.message);
      return;
    }

    const currentWorkspace = workspaceRef.current;

    if (!standalonePatchTabId) {
      const oneShotFamily = resolveOneShotGenerationFamily(
        currentWorkspace.project,
      );

      if (oneShotFamily.canResolve) {
        await runOneShotGenerationFromWorkspace(client, currentWorkspace);
        return;
      }
    }

    if (
      standalonePatchTabId &&
      currentWorkspace.selectedPatchTabId !== standalonePatchTabId
    ) {
      const state = createBlockedAutoPatchProductionUiState(
        'Select the requested Stable Audio 3 PatchTab before starting A2A production.',
      );
      setAutoPatchProductionState(state);
      setHeaderHelpMessage(state.message);
      return;
    }

    const autoPatchFallbackClipId =
      currentWorkspace.selectedClipId ||
      resolveRememberedStableAudio3SourceClipId(currentWorkspace.project);
    const targetResolution = resolveAutoPatchTargetClipIds(
      currentWorkspace.project,
      autoPatchFallbackClipId,
    );

    if (!targetResolution.canResolve) {
      const state = createBlockedAutoPatchProductionUiState(
        targetResolution.message,
      );
      setAutoPatchProductionState(state);
      setHeaderHelpMessage(state.message);
      return;
    }

    const interruptedPlayback = releaseActiveAudioPlayback();
    const interruptedPreview = releaseInstrumentAudioPreview();
    const interruptedAudition = releaseSoundFontAudition();
    metronomeRuntimeRef.current.stop();

    if (interruptedPreview) {
      setInstrumentAudioPreviewState({ status: 'IDLE' });
    }

    if (interruptedAudition) {
      setSoundFontAuditionState({ status: 'IDLE' });
    }

    const shouldStopTransport =
      Boolean(interruptedPlayback) || currentWorkspace.activeTransport !== 'STOP';
    const initialWorkspace = shouldStopTransport
      ? normalizeWorkspaceState({
          ...currentWorkspace,
          activeTransport: 'STOP',
          project: {
            ...currentWorkspace.project,
            status: currentWorkspace.project.isLooping ? 'LOOP READY' : 'READY',
          },
        })
      : currentWorkspace;

    if (initialWorkspace !== currentWorkspace) {
      workspaceRef.current = initialWorkspace;
      setHistory((currentHistory) =>
        currentHistory.present.value === currentWorkspace
          ? updateSessionEditPresent(currentHistory, () => initialWorkspace)
          : currentHistory,
      );
    }

    const initialProject = initialWorkspace.project;
    const requestId = ++autoPatchProductionRequestIdRef.current;
    const abortController = new AbortController();
    autoPatchProductionAbortControllerRef.current = abortController;
    autoPatchProductionInProgressRef.current = true;
    setSafetyConfirmRequest(undefined);
    setAutoPatchProductionState(createPreparingAutoPatchProductionUiState());
    setHeaderHelpMessage(
      `Checking Production Auto Patch for ${targetResolution.targetClipIds.length} target Clip${
        targetResolution.targetClipIds.length === 1 ? '' : 's'
      }.`,
    );

    try {
      const initialAudioAvailability =
        await resolveTabFlowEngineAvailability(
          client,
          initialProject,
          targetResolution.targetClipIds[0],
        );

      if (autoPatchProductionRequestIdRef.current !== requestId) {
        return;
      }

      if (!initialAudioAvailability.ok) {
        const state = createBlockedAutoPatchProductionUiState(
          initialAudioAvailability.message,
        );
        setAutoPatchProductionState(state);
        setHeaderHelpMessage(state.message);
        return;
      }

      const createdAt = new Date().toISOString();
      const preparation = prepareAutoPatchProductionRun(initialProject, {
        createdAt,
        fallbackClipId:
          initialWorkspace.selectedClipId ||
          resolveRememberedStableAudio3SourceClipId(initialProject),
        planId: createAutoPatchProductionId('plan'),
        runId: createAutoPatchProductionId('run'),
        ...(standalonePatchTabId
          ? { standalonePatchTabId }
          : {}),
        verifiedAudioArtifactIds:
          initialAudioAvailability.verifiedAudioArtifactIds,
        verifiedSoundFontResources:
          soundFontCatalogState.status === 'READY'
            ? soundFontCatalogState.catalog.resources
            : [],
      });

      if (!preparation.canRun) {
        const state = createBlockedAutoPatchProductionUiState(
          preparation.message,
        );
        setAutoPatchProductionState(state);
        setHeaderHelpMessage(state.message);
        return;
      }

      const result = await runAutoPatchProductionDriver(
        createAutoPatchProductionDriverClient(client),
        initialProject,
        preparation.coordinator,
        preparation.verifiedSoundFontResources,
        {
          identity: createAutoPatchProductionIdentityServices(),
          onProgress: (coordinator) => {
            const progress = prepareAutoPatchProductionProgressEnvelope(
              preparation.coordinator,
              coordinator,
            );

            if (!progress.ok) {
              throw new Error(progress.message);
            }

            if (autoPatchProductionRequestIdRef.current === requestId) {
              const state = createAutoPatchProductionUiStateFromEnvelope(
                progress.envelope,
              );
              setAutoPatchProductionState(state);
              setHeaderHelpMessage(state.message);
            }
          },
          signal: abortController.signal,
          stableAudio3Runner: {
            onProgress: (progress) => {
              if (autoPatchProductionRequestIdRef.current !== requestId) {
                return;
              }

              setAutoPatchProductionState((current) =>
                Object.freeze({
                  ...current,
                  jobProgress: progress.jobProgress,
                }),
              );
            },
          },
        },
      );

      if (autoPatchProductionRequestIdRef.current !== requestId) {
        return;
      }

      const terminal = prepareAutoPatchProductionResultEnvelope(
        preparation.coordinator,
        result,
      );

      if (!terminal.ok || terminal.envelope.status === 'PROGRESS') {
        const message = terminal.ok
          ? 'Auto Patch returned a progress Envelope at the terminal boundary.'
          : terminal.message;
        const state = createFailedAutoPatchProductionUiState(message);
        setAutoPatchProductionState(state);
        setHeaderHelpMessage(state.message);
        return;
      }

      const resultAudioAvailability = await resolveTabFlowEngineAvailability(
        client,
        result.project,
        targetResolution.targetClipIds[0],
      );

      if (!resultAudioAvailability.ok) {
        const state = createFailedAutoPatchProductionUiState(
          `Auto Patch outputs were not committed because availability verification failed: ${resultAudioAvailability.message}`,
          {
            completedStageCount: terminal.envelope.completedStageCount,
            stageCount: terminal.envelope.stageCount,
          },
        );
        setAutoPatchProductionState(state);
        setHeaderHelpMessage(state.message);
        return;
      }

      const historyRequest = {
        entryId: createAutoPatchProductionId('run-history'),
        name: 'Auto Patch Production',
        recordedAt: new Date().toISOString(),
      };
      const persistence = prepareAutoPatchProductionPersistence(
        initialProject,
        preparation.coordinator,
        result,
        {
          history: historyRequest,
          sourceAvailability: resultAudioAvailability.sourceAvailability,
        },
      );
      let nextProject: ProjectState;

      if (persistence.canCommit) {
        nextProject = persistence.plan.project;
      } else if (terminal.envelope.newlyCompletedStageCount === 0) {
        const history = writeAutoPatchRunHistory(
          initialProject,
          preparation.coordinator,
          result,
          historyRequest,
        );

        if (!history.ok) {
          const state = createFailedAutoPatchProductionUiState(
            history.message,
            {
              completedStageCount: terminal.envelope.completedStageCount,
              stageCount: terminal.envelope.stageCount,
            },
          );
          setAutoPatchProductionState(state);
          setHeaderHelpMessage(state.message);
          return;
        }

        nextProject = history.project;
      } else {
        const state = createFailedAutoPatchProductionUiState(
          persistence.message,
          {
            completedStageCount: terminal.envelope.completedStageCount,
            stageCount: terminal.envelope.stageCount,
          },
        );
        setAutoPatchProductionState(state);
        setHeaderHelpMessage(state.message);
        return;
      }

      if (workspaceRef.current.project !== initialProject) {
        const state = createFailedAutoPatchProductionUiState(
          'Auto Patch results were not committed because the Project changed during the production run.',
          {
            completedStageCount: terminal.envelope.completedStageCount,
            stageCount: terminal.envelope.stageCount,
          },
        );
        setAutoPatchProductionState(state);
        setHeaderHelpMessage(state.message);
        return;
      }

      const nextWorkspace = normalizeWorkspaceState({
        ...workspaceRef.current,
        activeTransport: 'STOP',
        project: nextProject,
      });
      workspaceRef.current = nextWorkspace;
      workspaceEditSequenceRef.current += 1;
      setHistory((currentHistory) =>
        currentHistory.present.value.project === initialProject
          ? commitSessionEdit(
              currentHistory,
              nextWorkspace,
              {
                category: 'auto-patch',
                createdAt: new Date().toISOString(),
                id: `edit-${Date.now()}-${workspaceEditSequenceRef.current}`,
                label: 'Run Auto Patch Production',
              },
              undoHistoryLimit,
            )
          : currentHistory,
      );

      const state = createAutoPatchProductionUiStateFromEnvelope(
        terminal.envelope,
      );
      setAutoPatchProductionState(state);
      setHeaderHelpMessage(state.message);
    } catch (error) {
      if (autoPatchProductionRequestIdRef.current === requestId) {
        const message =
          error instanceof Error
            ? error.message
            : 'Auto Patch production failed unexpectedly.';
        setAutoPatchProductionState((currentState) =>
          createFailedAutoPatchProductionUiState(message, currentState),
        );
        setHeaderHelpMessage(message);
      }
    } finally {
      if (autoPatchProductionRequestIdRef.current === requestId) {
        autoPatchProductionAbortControllerRef.current = undefined;
        autoPatchProductionInProgressRef.current = false;
      }
    }
  }, [
    projectRootState.status,
    releaseActiveAudioPlayback,
    releaseInstrumentAudioPreview,
    releaseSoundFontAudition,
    runOneShotGenerationFromWorkspace,
    soundFontCatalogState,
  ]);

  const handleRunStableAudio3AudioToAudio = useCallback(
    (patchTabId: string) => {
      const run = () => void handleRunAutoPatchProduction(patchTabId);

      if (!isSafetyModeEnabled) {
        run();
        return;
      }

      requestSafetyConfirm({
        title: 'Confirm Stable Audio 3 A2A',
        message:
          'Run Stable Audio 3 audio-to-audio for the selected Audio Clip.',
        details: [
          'Raw Mixdown input creates a new muted SA3 Master Track.',
          'Instrument Audio input creates a non-destructive Stable Audio 3 continuation.',
          'Project JSON remains unsaved until Save Project.',
        ],
        confirmLabel: 'RUN A2A',
        onConfirm: run,
      });
    },
    [
      handleRunAutoPatchProduction,
      isSafetyModeEnabled,
      requestSafetyConfirm,
    ],
  );

  function resolveRememberedStableAudio3SourceClipId(
    project: ProjectState,
  ): string | undefined {
    const remembered = project.patchTabs
      .filter(
        (patchTab) =>
          patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3 &&
          patchTab.generationContinuation?.kind ===
            'stable-audio-3-audio-to-audio',
      )
      .map((patchTab) => patchTab.generationContinuation)
      .filter(
        (
          continuation,
        ): continuation is Extract<
          NonNullable<PatchTab['generationContinuation']>,
          { kind: 'stable-audio-3-audio-to-audio' }
        > => continuation?.kind === 'stable-audio-3-audio-to-audio',
      );

    if (remembered.length !== 1) {
      return undefined;
    }

    const continuation = remembered[0];
    const matches = project.tracks.flatMap((track) =>
      track.clips.filter(
        (clip) =>
          clip.id === continuation.sourceClipId &&
          clip.activeClipTakeId === continuation.sourceClipTakeId,
      ),
    );

    return matches.length === 1 ? continuation.sourceClipId : undefined;
  }

  const handleCancelAutoPatchProduction = useCallback(() => {
    const abortController = autoPatchProductionAbortControllerRef.current;

    if (!abortController || abortController.signal.aborted) {
      return;
    }

    abortController.abort();
    setAutoPatchProductionState((currentState) =>
      requestAutoPatchProductionCancellation(currentState),
    );
    setHeaderHelpMessage(
      'Auto Patch cancel requested. Completed Stage outputs will be preserved.',
    );
  }, []);

  const handleDismissAutoPatchProduction = useCallback(() => {
    setAutoPatchProductionState((currentState) =>
      isAutoPatchProductionUiActive(currentState)
        ? currentState
        : createIdleAutoPatchProductionUiState(),
    );
  }, []);

  const handleRenderInstrument = useCallback(
    async (patchTabId: string) => {
      const client = localEngineClientRef.current;
      const currentWorkspace = workspaceRef.current;
      const source = findSelectedClip(
        currentWorkspace.project.tracks,
        currentWorkspace.selectedClipId,
      ) ?? findSingleSelectedMidiClipInfo(currentWorkspace.project);
      const currentAvailability = engineAvailabilityRef.current;

      if (!client || !currentAvailability.acceptsNewJobs) {
        setHeaderHelpMessage(currentAvailability.message);
        return;
      }

      if (projectRootState.status !== 'READY') {
        setHeaderHelpMessage(
          'MIDI TO AUDIO requires one ready Project Root and SoundFont catalog.',
        );
        return;
      }

      if (
        !source ||
        (source.clip.type !== 'midi-notes' &&
          source.clip.type !== 'edited-midi')
      ) {
        setHeaderHelpMessage(
          'Select one MIDI Clip before applying MIDI TO AUDIO.',
        );
        return;
      }

      const instrumentPatchTab = currentWorkspace.project.patchTabs.find(
        (patchTab) => patchTab.id === patchTabId,
      );

      if (!isInstrumentPatchTab(instrumentPatchTab)) {
        setHeaderHelpMessage('The selected PatchTab is not MIDI TO AUDIO.');
        return;
      }

      if (soundFontCatalogState.status !== 'READY') {
        setHeaderHelpMessage(
          'Wait for the SoundFont catalog, or use RESCAN in the SoundFont PatchTab.',
        );
        return;
      }

      if (instrumentRenderInProgressRef.current) {
        setHeaderHelpMessage(
          'One MIDI TO AUDIO Job is already active. Wait for it to finish.',
        );
        return;
      }

      const planning = createFluidSynthInstrumentRenderPlan(
        currentWorkspace.project,
        source.clip.id,
        soundFontCatalogState.catalog.resources,
        instrumentPatchTab.id,
      );

      if (!planning.canPlan) {
        setHeaderHelpMessage(planning.message);
        return;
      }

      stopActiveAudioPlayback(false);
      stopInstrumentAudioPreview(false);
      stopSoundFontAudition(false);
      const requestId = ++instrumentRenderRequestIdRef.current;
      instrumentRenderInProgressRef.current = true;
      setInstrumentRenderState({ status: 'ENQUEUEING' });
      setHeaderHelpMessage(
        `Enqueueing MIDI TO AUDIO for ${planning.plan.sourceClipName} Active Take.`,
      );

      try {
        const result = await runLocalEngineInstrumentRender(
          client,
          planning.plan.request,
          {
            onProgress: (progress) => {
              if (instrumentRenderRequestIdRef.current !== requestId) {
                return;
              }

              setInstrumentRenderState({
                ...(progress.jobId ? { jobId: progress.jobId } : {}),
                status: progress.state,
              });
              setHeaderHelpMessage(
                progress.jobId
                  ? `MIDI TO AUDIO Job ${progress.jobId}: ${progress.state}.`
                  : `Enqueueing MIDI TO AUDIO for ${planning.plan.sourceClipName} Active Take.`,
              );
            },
          },
        );

        if (instrumentRenderRequestIdRef.current !== requestId) {
          return;
        }

        if (!result.ok) {
          setInstrumentRenderState({
            ...(result.jobId ? { jobId: result.jobId } : {}),
            message: result.message,
            status: 'ERROR',
          });
          setHeaderHelpMessage(result.message);
          return;
        }

        if (engineAvailabilityRef.current.productionEditingLocked) {
          const message =
            'Instrument WAV finalized, but Project registration is locked because the Local Engine connection changed.';
          setInstrumentRenderState({
            jobId: result.job.jobId,
            message,
            status: 'ERROR',
          });
          setHeaderHelpMessage(message);
          return;
        }

        const latestWorkspace = workspaceRef.current;
        const latestSource = findSelectedClip(
          latestWorkspace.project.tracks,
          planning.plan.sourceClipId,
        );
        const latestPatchTab = latestWorkspace.project.patchTabs.find(
          (patchTab) => patchTab.id === patchTabId,
        );

        if (!latestSource || !isInstrumentPatchTab(latestPatchTab)) {
          const message =
            'Instrument WAV finalized, but its MIDI Clip or MIDI TO AUDIO PatchTab no longer exists.';
          setInstrumentRenderState({
            jobId: result.job.jobId,
            message,
            status: 'ERROR',
          });
          setHeaderHelpMessage(message);
          return;
        }

        const latestPlanning = createFluidSynthInstrumentRenderPlan(
          latestWorkspace.project,
          latestSource.clip.id,
          soundFontCatalogState.catalog.resources,
          latestPatchTab.id,
        );

        if (
          !latestPlanning.canPlan ||
          !doesInstrumentRenderJobMatchRequest(
            result.job,
            latestPlanning.plan.request,
          )
        ) {
          const message = latestPlanning.canPlan
            ? 'Instrument WAV finalized, but the MIDI Clip voice or render settings changed while the Job was active.'
            : `Instrument WAV finalized, but the current MIDI TO AUDIO plan is no longer valid: ${latestPlanning.message}`;
          setInstrumentRenderState({
            jobId: result.job.jobId,
            message,
            status: 'ERROR',
          });
          setHeaderHelpMessage(message);
          return;
        }

        const generated = createDummyInstrumentRender(
          latestWorkspace.project,
          latestSource.clip,
          latestPatchTab,
        );
        let registration = createInstrumentRenderRegistration(
          generated.project,
          result.job,
          {
            label: `${latestSource.clip.name} SoundFont Render`,
            sourceClipId: latestSource.clip.id,
            targetClipId: generated.clip.id,
          },
        );

        if (!registration.canRegister) {
          setInstrumentRenderState({
            jobId: result.job.jobId,
            message: registration.message,
            status: 'ERROR',
          });
          setHeaderHelpMessage(registration.message);
          return;
        }

        const availabilityVerification =
          await verifyGeneratedAudioArtifactsForCommit(
            client,
            [registration.artifact],
          );

        if (instrumentRenderRequestIdRef.current !== requestId) {
          return;
        }

        if (!availabilityVerification.ok) {
          const message = `Instrument WAV was not registered because final availability verification failed: ${availabilityVerification.message}`;
          setInstrumentRenderState({
            jobId: result.job.jobId,
            message,
            status: 'ERROR',
          });
          setHeaderHelpMessage(message);
          return;
        }

        if (
          engineAvailabilityRef.current.productionEditingLocked ||
          createDirtyStateFingerprint(workspaceRef.current.project) !==
            createDirtyStateFingerprint(latestWorkspace.project)
        ) {
          const message =
            'Instrument WAV finalized, but Project registration was blocked because the connection or Project changed during availability verification.';
          setInstrumentRenderState({
            jobId: result.job.jobId,
            message,
            status: 'ERROR',
          });
          setHeaderHelpMessage(message);
          return;
        }

        registration = createInstrumentRenderRegistration(
          generated.project,
          result.job,
          {
            label: `${latestSource.clip.name} SoundFont Render`,
            sourceAvailability: availabilityVerification.evidence,
            sourceClipId: latestSource.clip.id,
            targetClipId: generated.clip.id,
          },
        );

        if (!registration.canRegister) {
          setInstrumentRenderState({
            jobId: result.job.jobId,
            message: registration.message,
            status: 'ERROR',
          });
          setHeaderHelpMessage(registration.message);
          return;
        }

        const projectWithTake = appendManualStepTake(
          latestWorkspace.project,
          registration.project,
          latestPatchTab,
          latestSource.clip,
          generated.clip,
        );

        updateWorkspaceState(
          (workspaceAtCommit) => {
            if (
              createDirtyStateFingerprint(workspaceAtCommit.project) !==
              createDirtyStateFingerprint(latestWorkspace.project)
            ) {
              return workspaceAtCommit;
            }

            return {
              ...workspaceAtCommit,
              selectedClipId: generated.clip.id,
              project: {
                ...projectWithTake,
                status: 'AUDIO READY',
              },
            };
          },
          {
            category: 'take',
            label: `Render ${registration.clipTake.label}`,
          },
        );
        setInstrumentRenderState({
          jobId: result.job.jobId,
          status: 'REGISTERED',
        });
        showTimelineStatusFeedback({
          helpText: `${registration.clipTake.label} registered on ${generated.clip.name}. The finalized WAV is ready for playback and downstream A2A.`,
          message: 'INSTRUMENT AUDIO READY',
          tone: 'success',
        });
      } catch (error) {
        if (instrumentRenderRequestIdRef.current === requestId) {
          const message =
            error instanceof Error
              ? error.message
              : 'MIDI TO AUDIO failed unexpectedly.';
          setInstrumentRenderState({ message, status: 'ERROR' });
          setHeaderHelpMessage(message);
        }
      } finally {
        if (instrumentRenderRequestIdRef.current === requestId) {
          instrumentRenderInProgressRef.current = false;
        }
      }
    },
    [
      projectRootState.status,
      showTimelineStatusFeedback,
      soundFontCatalogState,
      stopActiveAudioPlayback,
      stopInstrumentAudioPreview,
      stopSoundFontAudition,
      updateWorkspaceState,
    ],
  );

  const handleGenerateAceStepVocal = useCallback(
    async (patchTabId: string) => {
      const client = localEngineClientRef.current;
      const currentAvailability = engineAvailabilityRef.current;
      const currentWorkspace = workspaceRef.current;

      if (!client || !currentAvailability.acceptsNewJobs) {
        setHeaderHelpMessage(currentAvailability.message);
        return;
      }

      if (projectRootState.status !== 'READY') {
        setHeaderHelpMessage(
          'ACE Vocals requires one ready Project Root before generation.',
        );
        return;
      }

      if (aceStepInProgressRef.current) {
        setHeaderHelpMessage(
          'One ACE Vocals operation is already active. Use its CANCEL action when available, or wait for settlement.',
        );
        return;
      }

      if (aceStepTextToMusicInProgressRef.current) {
        setHeaderHelpMessage(
          'ACE T2M is using the ACE-Step Runtime. Wait for it to finish or cancel it.',
        );
        return;
      }

      if (aceStepCoverInProgressRef.current) {
        setHeaderHelpMessage(
          'ACE Cover is using the ACE-Step Runtime. Wait for it to finish or cancel it.',
        );
        return;
      }

      const patchTab = currentWorkspace.project.patchTabs.find(
        (candidate) => candidate.id === patchTabId,
      );
      const preparation = prepareAceStepPatchTabRun(
        currentWorkspace.project,
        patchTab,
        currentWorkspace.selectedClipId,
      );

      if (!preparation.canPrepare || !patchTab) {
        const message = preparation.canPrepare
          ? 'ACE Vocals PatchTab is unavailable.'
          : preparation.message;
        setAceStepState({ message, patchTabId, status: 'ERROR' });
        setHeaderHelpMessage(message);
        return;
      }

      const requestId = ++aceStepRequestIdRef.current;
      const createdAt = new Date().toISOString();
      const newTargetResolution =
        preparation.mode === 'stable-audio-3-text-to-audio'
          ? createAceStepTextToAudioVocalTarget(
              currentWorkspace.project,
              createStableAudio3TextToAudioRequestToken(requestId),
              createdAt,
            )
          : undefined;

      if (newTargetResolution && !newTargetResolution.canCreate) {
        setAceStepState({
          message: newTargetResolution.message,
          patchTabId,
          status: 'ERROR',
        });
        setHeaderHelpMessage(newTargetResolution.message);
        return;
      }

      const targetName =
        preparation.mode === 'existing-vocal'
          ? preparation.target.targetClipName
          : newTargetResolution?.target.clipName ?? 'ACE Vocal';
      const abortController = new AbortController();
      const projectFingerprint = createDirtyStateFingerprint(
        currentWorkspace.project,
      );
      aceStepInProgressRef.current = true;
      aceStepOperationRef.current = {
        abortController,
        patchTabId,
        requestId,
      };
      setAceStepState({
        message: `Preparing Lyrics and Guide Audio for ${targetName}.`,
        patchTabId,
        status: 'SAVING_LYRICS',
      });
      setHeaderHelpMessage(
        `Preparing ACE Vocals for ${targetName}. Project edits remain available, but registration requires the source graph to remain unchanged.`,
      );

      try {
        const runnerOptions: AceStepVocalStageOptions = {
            ...ACE_STEP_PRODUCTION_MONITORING_POLICY,
            onProgress: (progress) => {
              if (aceStepRequestIdRef.current !== requestId) {
                return;
              }

              const activeOperation = aceStepOperationRef.current;

              if (activeOperation?.requestId === requestId) {
                activeOperation.jobId = progress.jobId;
                activeOperation.jobState =
                  progress.state === 'SAVING_LYRICS' ||
                  progress.state === 'ENQUEUEING'
                    ? undefined
                    : progress.state;
              }

              const cancellationPending =
                abortController.signal.aborted &&
                (progress.state === 'QUEUED' ||
                  progress.state === 'LOADING_MODEL' ||
                  progress.state === 'PROCESSING');
              const progressState = cancellationPending
                ? 'CANCEL_REQUESTED'
                : progress.state;
              const message = cancellationPending
                ? 'Cancellation requested. Waiting for the Local Engine terminal state.'
                : createAceStepProgressMessage(
                    preparation,
                    progress.state,
                    progress.jobId,
                  );
              setAceStepState({
                ...(progress.jobProgress
                  ? { jobProgress: progress.jobProgress }
                  : {}),
                ...(progress.jobId ? { jobId: progress.jobId } : {}),
                message,
                patchTabId,
                status: progressState,
              });
              setHeaderHelpMessage(message);
            },
            signal: abortController.signal,
          };
        const result =
          preparation.mode === 'stable-audio-3-text-to-audio' &&
          newTargetResolution?.canCreate
            ? await runAceStepTextToAudioVocalStage(
                client,
                {
                  caption: preparation.settings.caption,
                  guideClipId: preparation.guide.guideClipId,
                  lyrics: preparation.settings.lyrics,
                  mode: 'stable-audio-3-text-to-audio',
                  project: currentWorkspace.project,
                  seed: preparation.settings.seed,
                  target: newTargetResolution.target,
                  vocalLanguage: preparation.settings.vocalLanguage,
                },
                runnerOptions,
              )
            : preparation.mode === 'existing-vocal'
              ? await runAceStepVocalStage(
                  client,
                  {
                    caption: preparation.settings.caption,
                    guideClipId: preparation.target.guideClipId,
                    label: `${preparation.target.targetClipName} ACE-Step Vocal`,
                    lyrics: preparation.settings.lyrics,
                    midiClipId: preparation.target.midiClipId,
                    project: currentWorkspace.project,
                    seed: preparation.settings.seed,
                    targetClipId: preparation.target.targetClipId,
                    vocalLanguage: preparation.settings.vocalLanguage,
                  },
                  runnerOptions,
                )
              : undefined;

        if (!result) {
          throw new Error('ACE Vocals target preparation did not produce one runnable mode.');
        }

        if (aceStepRequestIdRef.current !== requestId) {
          return;
        }

        if (!result.ok) {
          const wasCanceled = result.status === 'CANCELED';
          setAceStepState({
            ...(result.job?.jobId ? { jobId: result.job.jobId } : {}),
            message: result.message,
            patchTabId,
            status: wasCanceled
              ? 'CANCELED'
              : result.status === 'PENDING'
                ? 'PENDING'
                : 'ERROR',
          });
          setHeaderHelpMessage(result.message);
          return;
        }

        const availabilityVerification =
          await verifyGeneratedAudioArtifactsForCommit(
            client,
            [result.artifact],
          );

        if (aceStepRequestIdRef.current !== requestId) {
          return;
        }

        if (!availabilityVerification.ok) {
          const message = `ACE-Step Vocal WAV was not registered because final availability verification failed: ${availabilityVerification.message}`;
          setAceStepState({
            jobId: result.job.jobId,
            message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(message);
          return;
        }

        const historyAtCommit = historyRef.current;
        const workspaceAtCommit = historyAtCommit.present.value;

        if (
          engineAvailabilityRef.current.productionEditingLocked ||
          createDirtyStateFingerprint(workspaceAtCommit.project) !==
            projectFingerprint
        ) {
          const message =
            'ACE-Step Vocal WAV finalized, but Project registration was blocked because the connection or source graph changed during generation.';
          setAceStepState({
            jobId: result.job.jobId,
            message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(message);
          return;
        }

        let committedProject: ProjectState;
        let committedClipTake: GeneratedAudioClipTake = result.clipTake;
        let selectedClipId = workspaceAtCommit.selectedClipId;
        let historyCategory: SessionEditCategory = 'take';
        let successMessage: string;

        if (
          preparation.mode === 'stable-audio-3-text-to-audio' &&
          newTargetResolution?.canCreate
        ) {
          const activation = activateClipTake(
            result.project,
            newTargetResolution.target.clipId,
            result.clipTake.clipTakeId,
            { sourceAvailability: availabilityVerification.evidence },
          );

          if (
            !activation.canActivate ||
            activation.clipTake.mediaType !== 'audio' ||
            activation.clipTake.sourceType !== 'job' ||
            activation.clipTake.artifactId !== result.artifact.artifactId ||
            activation.clipTake.clipTakeId !== result.clipTake.clipTakeId
          ) {
            const message = activation.canActivate
              ? 'ACE-Step Vocal activation identity changed before Project commit.'
              : activation.message;
            setAceStepState({
              jobId: result.job.jobId,
              message,
              patchTabId,
              status: 'ERROR',
            });
            setHeaderHelpMessage(message);
            return;
          }

          committedClipTake = activation.clipTake;
          selectedClipId = newTargetResolution.target.clipId;
          historyCategory = 'track';
          committedProject = {
            ...activation.project,
            selection: createSelectionFromItems([
              { id: selectedClipId, type: 'clip' },
            ]),
            status: 'VOCAL READY',
          };
          successMessage = `${committedClipTake.label} was registered as the Active Take on new Track ${newTargetResolution.target.trackName}.`;
        } else if (preparation.mode === 'existing-vocal') {
          const registration = createCompletedAudioJobRegistration(
            workspaceAtCommit.project,
            result.job,
            {
              activate: false,
              clipId: preparation.target.targetClipId,
              label: `${preparation.target.targetClipName} ACE-Step Vocal`,
              sourceAvailability: availabilityVerification.evidence,
            },
          );

          if (
            !registration.canRegister ||
            registration.clipTake.mediaType !== 'audio' ||
            registration.clipTake.sourceType !== 'job' ||
            registration.artifact.artifactId !== result.artifact.artifactId ||
            registration.clipTake.clipTakeId !== result.clipTake.clipTakeId
          ) {
            const message = registration.canRegister
              ? 'ACE-Step Vocal registration identity changed before Project commit.'
              : registration.message;
            setAceStepState({
              jobId: result.job.jobId,
              message,
              patchTabId,
              status: 'ERROR',
            });
            setHeaderHelpMessage(message);
            return;
          }

          committedClipTake = registration.clipTake;
          committedProject = {
            ...registration.project,
            status: 'VOCAL READY',
          };
          successMessage = `${committedClipTake.label} was registered as an inactive Take. The existing Active Take was preserved.`;
        } else {
          throw new Error('ACE Vocals settlement mode changed before Project commit.');
        }

        workspaceEditSequenceRef.current += 1;
        const committedWorkspace = normalizeWorkspaceState({
          ...workspaceAtCommit,
          project: committedProject,
          selectedClipId,
        });
        const committedHistory = commitSessionEdit(
          historyAtCommit,
          committedWorkspace,
          {
            category: historyCategory,
            createdAt: new Date().toISOString(),
            id: `edit-${Date.now()}-${workspaceEditSequenceRef.current}`,
            label: `Generate ${committedClipTake.label}`,
          },
          undoHistoryLimit,
        );
        historyRef.current = committedHistory;
        workspaceRef.current = committedHistory.present.value;
        setHistory(committedHistory);
        setAceStepState({
          jobId: result.job.jobId,
          message: successMessage,
          patchTabId,
          status: 'REGISTERED',
        });
        showTimelineStatusFeedback({
          helpText: `${committedClipTake.label} is ready for explicit Take review. No playback or audition was started.`,
          message: 'ACE VOCAL READY',
          tone: 'success',
        });
      } catch (error) {
        if (aceStepRequestIdRef.current === requestId) {
          const message =
            error instanceof Error
              ? error.message
              : 'ACE Vocals failed unexpectedly.';
          setAceStepState({ message, patchTabId, status: 'ERROR' });
          setHeaderHelpMessage(message);
        }
      } finally {
        if (aceStepRequestIdRef.current === requestId) {
          aceStepInProgressRef.current = false;
          if (aceStepOperationRef.current?.requestId === requestId) {
            aceStepOperationRef.current = undefined;
          }
        }
      }
    },
    [projectRootState.status, showTimelineStatusFeedback],
  );

  const handleCancelAceStepVocal = useCallback((patchTabId: string) => {
    const operation = aceStepOperationRef.current;

    if (
      !operation ||
      !aceStepInProgressRef.current ||
      operation.requestId !== aceStepRequestIdRef.current ||
      operation.patchTabId !== patchTabId
    ) {
      setHeaderHelpMessage(
        'ACE Vocals cancellation was blocked because this PatchTab does not own the active Job.',
      );
      return;
    }

    if (operation.abortController.signal.aborted) {
      setHeaderHelpMessage(
        'ACE Vocals cancellation is already pending for the exact active Job.',
      );
      return;
    }

    if (!operation.jobId || !operation.jobState) {
      setHeaderHelpMessage(
        'ACE Vocals is preparing an exact Job identity. Wait for enqueue to settle.',
      );
      return;
    }

    if (operation.jobState === 'SAVING') {
      setHeaderHelpMessage(
        'ACE-Step Job output finalization is already in progress. Wait for completion.',
      );
      return;
    }

    if (
      !canRequestAceStepVocalCancellation(
        {
          jobId: operation.jobId,
          patchTabId: operation.patchTabId,
          status: operation.jobState,
        },
        patchTabId,
      )
    ) {
      setHeaderHelpMessage('The exact ACE Vocals Job is not cancellable now.');
      return;
    }

    operation.abortController.abort();
    setAceStepState({
      jobId: operation.jobId,
      message:
        'Cancellation requested. Waiting for the Local Engine terminal state.',
      patchTabId,
      status: 'CANCEL_REQUESTED',
    });
    setHeaderHelpMessage('ACE Vocals cancellation requested.');
  }, []);

  const handleGenerateAceStepTextToMusic = useCallback(
    async (patchTabId: string) => {
      const client = localEngineClientRef.current;
      const currentAvailability = engineAvailabilityRef.current;
      const currentWorkspace = workspaceRef.current;

      if (!client || !currentAvailability.acceptsNewJobs) {
        setHeaderHelpMessage(currentAvailability.message);
        return;
      }

      if (projectRootState.status !== 'READY') {
        setHeaderHelpMessage('ACE T2M requires one ready Project Root before generation.');
        return;
      }

      if (
        aceStepTextToMusicInProgressRef.current ||
        aceStepCoverInProgressRef.current ||
        aceStepInProgressRef.current ||
        stableAudio3TextToAudioInProgressRef.current
      ) {
        setHeaderHelpMessage('Audio generation is already active. Wait for it to finish or cancel it.');
        return;
      }

      const patchTab = currentWorkspace.project.patchTabs.find(
        (candidate) => candidate.id === patchTabId,
      );
      const settingsResolution = resolveAceStepTextToMusicSettings(
        currentWorkspace.project,
        patchTab,
      );

      if (!settingsResolution.canResolve) {
        setAceStepTextToMusicState({ message: settingsResolution.message, patchTabId, status: 'ERROR' });
        setHeaderHelpMessage(settingsResolution.message);
        return;
      }

      const requestId = ++aceStepTextToMusicRequestIdRef.current;
      const abortController = new AbortController();
      aceStepTextToMusicAbortControllerRef.current = abortController;
      aceStepTextToMusicInProgressRef.current = true;
      setAceStepTextToMusicState({
        message: 'Finalizing the immutable Lyrics snapshot.',
        patchTabId,
        status: 'ENQUEUEING',
      });

      try {
        const lyricsSave = await client.saveAceStepLyrics(
          settingsResolution.settings.lyricsSnapshotText,
        );

        if (aceStepTextToMusicRequestIdRef.current !== requestId) return;

        if (!lyricsSave.ok) {
          setAceStepTextToMusicState({ message: lyricsSave.message, patchTabId, status: 'ERROR' });
          setHeaderHelpMessage(lyricsSave.message);
          return;
        }

        const preparation = prepareAceStepTextToMusicRun(
          currentWorkspace.project,
          patchTab,
          {
            createdAt: new Date().toISOString(),
            lyricsArtifactId: lyricsSave.lyricsSnapshot.artifactId,
            lyricsRelativePath: lyricsSave.lyricsSnapshot.file.relativePath,
            requestToken: `ace-t2m-${requestId}`,
          },
        );

        if (!preparation.canPrepare) {
          setAceStepTextToMusicState({ message: preparation.message, patchTabId, status: 'ERROR' });
          setHeaderHelpMessage(preparation.message);
          return;
        }

        const completedJobs = [];
        let latestJobId: string | undefined;

        for (let planIndex = 0; planIndex < preparation.plans.length; planIndex += 1) {
          const plan = preparation.plans[planIndex];
          const takeNumber = planIndex + 1;
          const result = await runAceStepTextToMusicPlan(client, plan, {
            signal: abortController.signal,
            onProgress: (progress) => {
              if (
                aceStepTextToMusicRequestIdRef.current !== requestId ||
                progress.state === 'COMPLETED' ||
                progress.state === 'CANCELED' ||
                progress.state === 'FAILED' ||
                progress.state === 'INTERRUPTED' ||
                progress.state === 'PAUSED'
              ) return;

              const cancellationPending = abortController.signal.aborted && progress.state !== 'SAVING';
              const progressState = cancellationPending ? 'CANCEL_REQUESTED' : progress.state;
              const message = cancellationPending
                ? 'Cancellation requested. Waiting for the Local Engine terminal state.'
                : progress.jobId
                  ? `ACE T2M Take ${takeNumber}/${preparation.plans.length} / Job ${progress.jobId}: ${formatAceStepTextToMusicStatus(progressState)}.`
                  : `Preparing ACE T2M Take ${takeNumber}/${preparation.plans.length}.`;
              setAceStepTextToMusicState({
                ...(progress.jobProgress
                  ? { jobProgress: progress.jobProgress }
                  : {}),
                ...(progress.jobId ? { jobId: progress.jobId } : {}),
                message,
                patchTabId,
                takeCount: preparation.plans.length,
                takeNumber,
                status: progressState,
              });
              setHeaderHelpMessage(message);
            },
          });

          if (aceStepTextToMusicRequestIdRef.current !== requestId) return;

          if (!result.ok) {
            setAceStepTextToMusicState({
              ...(result.jobId ? { jobId: result.jobId } : {}),
              message: result.message,
              patchTabId,
              status: result.status === 'RUN_CANCELED' ? 'CANCELED' : 'ERROR',
            });
            setHeaderHelpMessage(result.message);
            return;
          }

          latestJobId = result.jobId;
          completedJobs.push(result.job);
        }

        const latestHistory = historyRef.current;
        let settlement = settleAceStepTextToMusicJobs(
          latestHistory,
          preparation.plans,
          completedJobs,
          {
            historyLimit: undoHistoryLimit,
            patchTabId,
            recipeFingerprint: preparation.recipeFingerprint,
            sourceParameterFingerprint: preparation.sourceParameterFingerprint,
            target: preparation.target,
          },
        );

        if (!settlement.settled) {
          setAceStepTextToMusicState({
            ...(latestJobId ? { jobId: latestJobId } : {}),
            message: settlement.message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(settlement.message);
          return;
        }

        const availabilityVerification = await verifyGeneratedAudioArtifactsForCommit(client, settlement.artifacts);
        if (aceStepTextToMusicRequestIdRef.current !== requestId) return;

        if (!availabilityVerification.ok) {
          const message = `ACE T2M outputs were not registered because final availability verification failed: ${availabilityVerification.message}`;
          setAceStepTextToMusicState({ ...(latestJobId ? { jobId: latestJobId } : {}), message, patchTabId, status: 'ERROR' });
          setHeaderHelpMessage(message);
          return;
        }

        const historyAtCommit = historyRef.current;
        if (
          engineAvailabilityRef.current.productionEditingLocked ||
          createDirtyStateFingerprint(historyAtCommit.present.value.project) !==
            createDirtyStateFingerprint(latestHistory.present.value.project)
        ) {
          const message = 'ACE T2M outputs finalized, but registration was blocked because the connection or Project changed during verification.';
          setAceStepTextToMusicState({ ...(latestJobId ? { jobId: latestJobId } : {}), message, patchTabId, status: 'ERROR' });
          setHeaderHelpMessage(message);
          return;
        }

        settlement = settleAceStepTextToMusicJobs(
          historyAtCommit,
          preparation.plans,
          completedJobs,
          {
            historyLimit: undoHistoryLimit,
            patchTabId,
            recipeFingerprint: preparation.recipeFingerprint,
            sourceAvailability: availabilityVerification.evidence,
            sourceParameterFingerprint: preparation.sourceParameterFingerprint,
            target: preparation.target,
          },
        );

        if (!settlement.settled) {
          setAceStepTextToMusicState({
            ...(latestJobId ? { jobId: latestJobId } : {}),
            message: settlement.message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(settlement.message);
          return;
        }

        historyRef.current = settlement.history;
        workspaceRef.current = settlement.workspace;
        setHistory(settlement.history);
        setAceStepTextToMusicState({
          ...(latestJobId ? { jobId: latestJobId } : {}),
          message: `${settlement.clipTakes.length} ${settlement.clipTakes.length === 1 ? '48 kHz Take was' : '48 kHz Takes were'} registered in ${settlement.clip.name}.`,
          patchTabId,
          status: 'COMPLETED',
        });
        showTimelineStatusFeedback({
          helpText:
            preparation.target.kind === 'new'
              ? `${settlement.clip.name} was created with ${settlement.clipTakes.length} 48 kHz ${settlement.clipTakes.length === 1 ? 'Take' : 'Takes'} and selected.`
              : `${settlement.clipTakes.length} 48 kHz ${settlement.clipTakes.length === 1 ? 'Take was' : 'Takes were'} appended to ${settlement.clip.name}.`,
          message: 'ACE T2M READY',
          tone: 'success',
        });
      } catch (error) {
        if (aceStepTextToMusicRequestIdRef.current === requestId) {
          const message = error instanceof Error ? error.message : 'ACE T2M failed unexpectedly.';
          setAceStepTextToMusicState({ message, patchTabId, status: 'ERROR' });
          setHeaderHelpMessage(message);
        }
      } finally {
        if (aceStepTextToMusicRequestIdRef.current === requestId) {
          aceStepTextToMusicAbortControllerRef.current = undefined;
          aceStepTextToMusicInProgressRef.current = false;
        }
      }
    },
    [projectRootState.status, showTimelineStatusFeedback],
  );

  const handleCancelAceStepTextToMusic = useCallback(
    (patchTabId: string) => {
      if (
        !aceStepTextToMusicInProgressRef.current ||
        aceStepTextToMusicState.patchTabId !== patchTabId ||
        aceStepTextToMusicState.status === 'SAVING' ||
        aceStepTextToMusicState.status === 'CANCEL_REQUESTED'
      ) return;

      aceStepTextToMusicAbortControllerRef.current?.abort();
      setAceStepTextToMusicState((currentState) => ({
        ...currentState,
        message: 'Cancellation requested. A finalized SAVING result still wins settlement.',
        status: 'CANCEL_REQUESTED',
      }));
      setHeaderHelpMessage('ACE T2M cancellation requested.');
    },
    [aceStepTextToMusicState.patchTabId, aceStepTextToMusicState.status],
  );

  const handleGenerateAceStepCover = useCallback(
    async (patchTabId: string) => {
      const client = localEngineClientRef.current;
      const currentAvailability = engineAvailabilityRef.current;
      const currentWorkspace = workspaceRef.current;

      if (!client || !currentAvailability.acceptsNewJobs) {
        setHeaderHelpMessage(currentAvailability.message);
        return;
      }

      if (projectRootState.status !== 'READY') {
        setHeaderHelpMessage('ACE Cover requires one ready Project Root before generation.');
        return;
      }

      if (
        aceStepCoverInProgressRef.current ||
        aceStepTextToMusicInProgressRef.current ||
        aceStepInProgressRef.current ||
        stableAudio3TextToAudioInProgressRef.current
      ) {
        setHeaderHelpMessage('Audio generation is already active. Wait for it to finish or cancel it.');
        return;
      }

      const patchTab = currentWorkspace.project.patchTabs.find(
        (candidate) => candidate.id === patchTabId,
      );
      const settingsResolution = resolveAceStepCoverSettings(
        currentWorkspace.project,
        patchTab,
        currentWorkspace.selectedClipId,
      );

      if (!settingsResolution.canResolve) {
        setAceStepCoverState({ message: settingsResolution.message, patchTabId, status: 'ERROR' });
        setHeaderHelpMessage(settingsResolution.message);
        return;
      }

      const requestId = ++aceStepCoverRequestIdRef.current;
      const createdAt = new Date().toISOString();
      const requestToken = `ace-cover-${requestId}`;
      const preflight = preflightAceStepCoverRun(
        currentWorkspace.project,
        patchTab,
        currentWorkspace.selectedClipId,
        { createdAt, requestToken },
      );

      if (!preflight.canPreflight) {
        setAceStepCoverState({ message: preflight.message, patchTabId, status: 'ERROR' });
        setHeaderHelpMessage(preflight.message);
        return;
      }

      const abortController = new AbortController();
      aceStepCoverAbortControllerRef.current = abortController;
      aceStepCoverInProgressRef.current = true;
      setAceStepCoverState({
        message: 'Finalizing the immutable Lyrics snapshot.',
        patchTabId,
        status: 'ENQUEUEING',
      });

      try {
        const lyricsSave = await client.saveAceStepLyrics(
          settingsResolution.settings.lyricsSnapshotText,
        );

        if (aceStepCoverRequestIdRef.current !== requestId) return;

        if (!lyricsSave.ok) {
          setAceStepCoverState({ message: lyricsSave.message, patchTabId, status: 'ERROR' });
          setHeaderHelpMessage(lyricsSave.message);
          return;
        }

        const preparation = prepareAceStepCoverRun(
          currentWorkspace.project,
          patchTab,
          currentWorkspace.selectedClipId,
          {
            createdAt,
            lyricsArtifactId: lyricsSave.lyricsSnapshot.artifactId,
            lyricsRelativePath: lyricsSave.lyricsSnapshot.file.relativePath,
            requestToken,
          },
        );

        if (!preparation.canPrepare) {
          setAceStepCoverState({ message: preparation.message, patchTabId, status: 'ERROR' });
          setHeaderHelpMessage(preparation.message);
          return;
        }

        const completedJobs = [];
        let latestJobId: string | undefined;

        for (let planIndex = 0; planIndex < preparation.plans.length; planIndex += 1) {
          const plan = preparation.plans[planIndex];
          const takeNumber = planIndex + 1;
          const result = await runAceStepCoverPlan(client, plan, {
            signal: abortController.signal,
            onProgress: (progress) => {
              if (
                aceStepCoverRequestIdRef.current !== requestId ||
                progress.state === 'COMPLETED' ||
                progress.state === 'CANCELED' ||
                progress.state === 'FAILED' ||
                progress.state === 'INTERRUPTED' ||
                progress.state === 'PAUSED'
              ) return;

              const cancellationPending = abortController.signal.aborted && progress.state !== 'SAVING';
              const progressState = cancellationPending ? 'CANCEL_REQUESTED' : progress.state;
              const message = cancellationPending
                ? 'Cancellation requested. Waiting for the Local Engine terminal state.'
                : progress.jobId
                  ? `ACE Cover Take ${takeNumber}/${preparation.plans.length} / Job ${progress.jobId}: ${formatAceStepTextToMusicStatus(progressState)}.`
                  : `Preparing ACE Cover Take ${takeNumber}/${preparation.plans.length}.`;
              setAceStepCoverState({
                ...(progress.jobProgress
                  ? { jobProgress: progress.jobProgress }
                  : {}),
                ...(progress.jobId ? { jobId: progress.jobId } : {}),
                message,
                patchTabId,
                takeCount: preparation.plans.length,
                takeNumber,
                status: progressState,
              });
              setHeaderHelpMessage(message);
            },
          });

          if (aceStepCoverRequestIdRef.current !== requestId) return;

          if (!result.ok) {
            setAceStepCoverState({
              ...(result.jobId ? { jobId: result.jobId } : {}),
              message: result.message,
              patchTabId,
              status: result.status === 'RUN_CANCELED' ? 'CANCELED' : 'ERROR',
            });
            setHeaderHelpMessage(result.message);
            return;
          }

          latestJobId = result.jobId;
          completedJobs.push(result.job);
        }

        const latestHistory = historyRef.current;
        let settlement = settleAceStepCoverJobs(
          latestHistory,
          preparation.plans,
          completedJobs,
          {
            historyLimit: undoHistoryLimit,
            patchTabId,
            recipeFingerprint: preparation.recipeFingerprint,
            sourceFingerprint: preparation.sourceFingerprint,
            sourceParameterFingerprint: preparation.sourceParameterFingerprint,
            target: preparation.target,
          },
        );

        if (!settlement.settled) {
          setAceStepCoverState({
            ...(latestJobId ? { jobId: latestJobId } : {}),
            message: settlement.message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(settlement.message);
          return;
        }

        const availabilityVerification = await verifyGeneratedAudioArtifactsForCommit(client, settlement.artifacts);
        if (aceStepCoverRequestIdRef.current !== requestId) return;

        if (!availabilityVerification.ok) {
          const message = `ACE Cover outputs were not registered because final availability verification failed: ${availabilityVerification.message}`;
          setAceStepCoverState({ ...(latestJobId ? { jobId: latestJobId } : {}), message, patchTabId, status: 'ERROR' });
          setHeaderHelpMessage(message);
          return;
        }

        const historyAtCommit = historyRef.current;
        if (
          engineAvailabilityRef.current.productionEditingLocked ||
          createDirtyStateFingerprint(historyAtCommit.present.value.project) !==
            createDirtyStateFingerprint(latestHistory.present.value.project)
        ) {
          const message = 'ACE Cover outputs finalized, but registration was blocked because the connection or Project changed during verification.';
          setAceStepCoverState({ ...(latestJobId ? { jobId: latestJobId } : {}), message, patchTabId, status: 'ERROR' });
          setHeaderHelpMessage(message);
          return;
        }

        settlement = settleAceStepCoverJobs(
          historyAtCommit,
          preparation.plans,
          completedJobs,
          {
            historyLimit: undoHistoryLimit,
            patchTabId,
            recipeFingerprint: preparation.recipeFingerprint,
            sourceAvailability: availabilityVerification.evidence,
            sourceFingerprint: preparation.sourceFingerprint,
            sourceParameterFingerprint: preparation.sourceParameterFingerprint,
            target: preparation.target,
          },
        );

        if (!settlement.settled) {
          setAceStepCoverState({
            ...(latestJobId ? { jobId: latestJobId } : {}),
            message: settlement.message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(settlement.message);
          return;
        }

        historyRef.current = settlement.history;
        workspaceRef.current = settlement.workspace;
        setHistory(settlement.history);
        setAceStepCoverState({
          ...(latestJobId ? { jobId: latestJobId } : {}),
          message: `${settlement.clipTakes.length} ${settlement.clipTakes.length === 1 ? 'stereo 48 kHz Take was' : 'stereo 48 kHz Takes were'} registered in ${settlement.clip.name}.`,
          patchTabId,
          status: 'COMPLETED',
        });
        showTimelineStatusFeedback({
          helpText:
            preparation.target.kind === 'new'
              ? `${settlement.clip.name} was created with ${settlement.clipTakes.length} stereo 48 kHz ${settlement.clipTakes.length === 1 ? 'Take' : 'Takes'} and selected.`
              : `${settlement.clipTakes.length} stereo 48 kHz ${settlement.clipTakes.length === 1 ? 'Take was' : 'Takes were'} appended to ${settlement.clip.name}.`,
          message: 'ACE COVER READY',
          tone: 'success',
        });
      } catch (error) {
        if (aceStepCoverRequestIdRef.current === requestId) {
          const message = error instanceof Error ? error.message : 'ACE Cover failed unexpectedly.';
          setAceStepCoverState({ message, patchTabId, status: 'ERROR' });
          setHeaderHelpMessage(message);
        }
      } finally {
        if (aceStepCoverRequestIdRef.current === requestId) {
          aceStepCoverAbortControllerRef.current = undefined;
          aceStepCoverInProgressRef.current = false;
        }
      }
    },
    [projectRootState.status, showTimelineStatusFeedback],
  );

  const handleCancelAceStepCover = useCallback(
    (patchTabId: string) => {
      if (
        !aceStepCoverInProgressRef.current ||
        aceStepCoverState.patchTabId !== patchTabId ||
        aceStepCoverState.status === 'SAVING' ||
        aceStepCoverState.status === 'CANCEL_REQUESTED'
      ) return;

      aceStepCoverAbortControllerRef.current?.abort();
      setAceStepCoverState((currentState) => ({
        ...currentState,
        message: 'Cancellation requested. A finalized SAVING result still wins settlement.',
        status: 'CANCEL_REQUESTED',
      }));
      setHeaderHelpMessage('ACE Cover cancellation requested.');
    },
    [aceStepCoverState.patchTabId, aceStepCoverState.status],
  );

  const handleGenerateStableAudio3TextToAudio = useCallback(
    async (patchTabId: string) => {
      const client = localEngineClientRef.current;
      const currentAvailability = engineAvailabilityRef.current;
      const currentWorkspace = workspaceRef.current;

      if (!client || !currentAvailability.acceptsNewJobs) {
        setHeaderHelpMessage(currentAvailability.message);
        return;
      }

      if (projectRootState.status !== 'READY') {
        setHeaderHelpMessage(
          'SA3 T2A requires one ready Project Root before generation.',
        );
        return;
      }

      if (stableAudio3TextToAudioInProgressRef.current) {
        setHeaderHelpMessage(
          'One SA3 T2A Job is already active. Wait for it to finish or cancel it.',
        );
        return;
      }

      if (aceStepTextToMusicInProgressRef.current) {
        setHeaderHelpMessage(
          'ACE T2M generation is active. Wait for it to finish or cancel it.',
        );
        return;
      }


      if (aceStepCoverInProgressRef.current) {
        setHeaderHelpMessage(
          'ACE Cover generation is active. Wait for it to finish or cancel it.',
        );
        return;
      }

      const patchTab = currentWorkspace.project.patchTabs.find(
        (candidate) => candidate.id === patchTabId,
      );
      const requestId = ++stableAudio3TextToAudioRequestIdRef.current;
      const createdAt = new Date().toISOString();
      const preparation = prepareStableAudio3TextToAudioPatchTabRun(
        currentWorkspace.project,
        patchTab,
        {
          createdAt,
          requestToken: createStableAudio3TextToAudioRequestToken(requestId),
        },
      );

      if (!preparation.canPrepare) {
        setStableAudio3TextToAudioState({
          message: preparation.message,
          patchTabId,
          status: 'ERROR',
        });
        setHeaderHelpMessage(preparation.message);
        return;
      }

      const abortController = new AbortController();
      stableAudio3TextToAudioAbortControllerRef.current = abortController;
      stableAudio3TextToAudioInProgressRef.current = true;
      setStableAudio3TextToAudioState({
        message: `Preparing ${preparation.plans.length} source-free Stable Audio 3 ${preparation.plans.length === 1 ? 'Job' : 'Jobs'}.`,
        patchTabId,
        status: 'ENQUEUEING',
      });
      setHeaderHelpMessage(
        `Enqueueing ${preparation.plans.length} SA3 T2A ${preparation.plans.length === 1 ? 'Take' : 'Takes'} with captured Timeline context.`,
      );

      try {
        const completedJobs = [];
        let latestJobId: string | undefined;

        for (
          let planIndex = 0;
          planIndex < preparation.plans.length;
          planIndex += 1
        ) {
          const plan = preparation.plans[planIndex];
          const takeNumber = planIndex + 1;
          const result = await runStableAudio3TextToAudioPlan(client, plan, {
            signal: abortController.signal,
            onProgress: (progress) => {
              if (
                stableAudio3TextToAudioRequestIdRef.current !== requestId ||
                progress.state === 'COMPLETED' ||
                progress.state === 'CANCELED' ||
                progress.state === 'FAILED' ||
                progress.state === 'INTERRUPTED' ||
                progress.state === 'PAUSED'
              ) {
                return;
              }

              const cancellationPending =
                abortController.signal.aborted && progress.state !== 'SAVING';
              const progressState = cancellationPending
                ? 'CANCEL_REQUESTED'
                : progress.state;
              const message = cancellationPending
                ? 'Cancellation requested. Waiting for the Local Engine terminal state.'
                : progress.jobId
                  ? `SA3 T2A Take ${takeNumber}/${preparation.plans.length} / Job ${progress.jobId}: ${formatStableAudio3TextToAudioStatus(progressState)}.`
                  : `Preparing SA3 T2A Take ${takeNumber}/${preparation.plans.length}.`;
              setStableAudio3TextToAudioState({
                ...(progress.jobProgress
                  ? { jobProgress: progress.jobProgress }
                  : {}),
                ...(progress.jobId ? { jobId: progress.jobId } : {}),
                message,
                patchTabId,
                takeCount: preparation.plans.length,
                takeNumber,
                status: progressState,
              });
              setHeaderHelpMessage(message);
            },
          });

          if (stableAudio3TextToAudioRequestIdRef.current !== requestId) {
            return;
          }

          if (!result.ok) {
            const wasCanceled =
              result.status === 'JOB_CANCELED' ||
              result.status === 'RUN_CANCELED';
            const message =
              'message' in result
                ? result.message
                : `SA3 T2A Job ${result.jobId} is still pending outside the UI polling window.`;

            setStableAudio3TextToAudioState({
              ...(result.jobId ? { jobId: result.jobId } : {}),
              message,
              patchTabId,
              status: wasCanceled ? 'CANCELED' : 'ERROR',
            });
            setHeaderHelpMessage(message);
            return;
          }

          latestJobId = result.jobId;
          completedJobs.push(result.job);
        }

        const latestHistory = historyRef.current;
        const latestPromptValidation =
          applyStableAudio3TextToAudioManagedPrompt(
            latestHistory.present.value.project,
            patchTabId,
            preparation.sourceParameterFingerprint,
            preparation.managedPrompt,
          );

        if (!latestPromptValidation.applied) {
          setStableAudio3TextToAudioState({
            ...(latestJobId ? { jobId: latestJobId } : {}),
            message: latestPromptValidation.message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(latestPromptValidation.message);
          return;
        }

        let settlement = settleStableAudio3TextToAudioJobs(
          latestHistory,
          preparation.plans,
          completedJobs,
          preparation.target,
          { historyLimit: undoHistoryLimit },
        );

        if (!settlement.settled) {
          setStableAudio3TextToAudioState({
            ...(latestJobId ? { jobId: latestJobId } : {}),
            message: settlement.message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(settlement.message);
          return;
        }

        const availabilityVerification =
          await verifyGeneratedAudioArtifactsForCommit(
            client,
            settlement.artifacts,
          );

        if (stableAudio3TextToAudioRequestIdRef.current !== requestId) {
          return;
        }

        if (!availabilityVerification.ok) {
          const message = `SA3 T2A outputs were not registered because final availability verification failed: ${availabilityVerification.message}`;
          setStableAudio3TextToAudioState({
            ...(latestJobId ? { jobId: latestJobId } : {}),
            message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(message);
          return;
        }

        const historyAtCommit = historyRef.current;

        if (
          engineAvailabilityRef.current.productionEditingLocked ||
          createDirtyStateFingerprint(
            historyAtCommit.present.value.project,
          ) !== createDirtyStateFingerprint(latestHistory.present.value.project)
        ) {
          const message =
            'SA3 T2A outputs finalized, but Project registration was blocked because the connection or Project changed during availability verification.';
          setStableAudio3TextToAudioState({
            ...(latestJobId ? { jobId: latestJobId } : {}),
            message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(message);
          return;
        }

        settlement = settleStableAudio3TextToAudioJobs(
          historyAtCommit,
          preparation.plans,
          completedJobs,
          preparation.target,
          {
            historyLimit: undoHistoryLimit,
            sourceAvailability: availabilityVerification.evidence,
          },
        );

        if (!settlement.settled) {
          setStableAudio3TextToAudioState({
            ...(latestJobId ? { jobId: latestJobId } : {}),
            message: settlement.message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(settlement.message);
          return;
        }

        const managedPromptUpdate = applyStableAudio3TextToAudioManagedPrompt(
          settlement.workspace.project,
          patchTabId,
          preparation.sourceParameterFingerprint,
          preparation.managedPrompt,
          {
            outputClipId: settlement.clip.id,
            recipeFingerprint: preparation.recipeFingerprint,
          },
        );

        if (!managedPromptUpdate.applied) {
          setStableAudio3TextToAudioState({
            ...(latestJobId ? { jobId: latestJobId } : {}),
            message: managedPromptUpdate.message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(managedPromptUpdate.message);
          return;
        }

        const finalHistory = updateSessionEditPresent(
          settlement.history,
          (settledWorkspace) => ({
            ...settledWorkspace,
            project: managedPromptUpdate.project,
          }),
        );
        historyRef.current = finalHistory;
        workspaceRef.current = finalHistory.present.value;
        setHistory(finalHistory);
        setStableAudio3TextToAudioState({
          ...(latestJobId ? { jobId: latestJobId } : {}),
          message: `${settlement.clipTakes.length} ${settlement.clipTakes.length === 1 ? 'Take was' : 'Takes were'} registered in ${settlement.clip.name}.`,
          patchTabId,
          status: 'COMPLETED',
        });
        showTimelineStatusFeedback({
          helpText:
            preparation.target.kind === 'new'
              ? `${settlement.clip.name} was created with ${settlement.clipTakes.length} ${settlement.clipTakes.length === 1 ? 'Take' : 'Takes'} and selected.`
              : `${settlement.clipTakes.length} ${settlement.clipTakes.length === 1 ? 'Take was' : 'Takes were'} appended to ${settlement.clip.name} without changing the current selection.`,
          message: 'SA3 T2A READY',
          tone: 'success',
        });
      } catch (error) {
        if (stableAudio3TextToAudioRequestIdRef.current === requestId) {
          const message =
            error instanceof Error
              ? error.message
              : 'SA3 T2A failed unexpectedly.';
          setStableAudio3TextToAudioState({
            message,
            patchTabId,
            status: 'ERROR',
          });
          setHeaderHelpMessage(message);
        }
      } finally {
        if (stableAudio3TextToAudioRequestIdRef.current === requestId) {
          stableAudio3TextToAudioAbortControllerRef.current = undefined;
          stableAudio3TextToAudioInProgressRef.current = false;
        }
      }
    },
    [projectRootState.status, showTimelineStatusFeedback],
  );

  const handleCancelStableAudio3TextToAudio = useCallback(
    (patchTabId: string) => {
      if (
        !stableAudio3TextToAudioInProgressRef.current ||
        stableAudio3TextToAudioState.patchTabId !== patchTabId ||
        stableAudio3TextToAudioState.status === 'SAVING' ||
        stableAudio3TextToAudioState.status === 'CANCEL_REQUESTED'
      ) {
        return;
      }

      stableAudio3TextToAudioAbortControllerRef.current?.abort();
      setStableAudio3TextToAudioState((currentState) => ({
        ...currentState,
        message:
          'Cancellation requested. A finalized SAVING result still wins settlement.',
        status: 'CANCEL_REQUESTED',
      }));
      setHeaderHelpMessage('SA3 T2A cancellation requested.');
    },
    [stableAudio3TextToAudioState.patchTabId, stableAudio3TextToAudioState.status],
  );

  const handleDownloadProject = useCallback(() => {
    downloadWorkspaceState(workspace);
    setSavedProjectFingerprint(createDirtyStateFingerprint(workspace.project));
  }, [workspace]);

  const handleBrowserSave = useCallback((): boolean => {
    const didSave = persistBrowserSave(
      window.localStorage,
      browserSaveKey,
      JSON.stringify(createHumStudioProjectFile(workspace)),
    );

    if (!didSave) {
      return false;
    }

    setSavedProjectFingerprint(createDirtyStateFingerprint(workspace.project));
    return true;
  }, [workspace]);

  const handleOpenProjectFromRoot = useCallback(async () => {
    const client = localEngineClientRef.current;

    if (
      !client ||
      engineConnection.lifecycle !== 'READY' ||
      engineConnection.activity !== 'IDLE' ||
      projectRootState.status !== 'READY' ||
      projectRootState.projectRoot.projectFile.status !== 'EXISTS' ||
      isProjectRootProjectOpenInProgress
    ) {
      setHeaderHelpMessage(
        'Opening Project from Root requires an idle Engine, a ready Project Root, and an existing Project JSON.',
      );
      return;
    }

    const expectedProjectRoot = projectRootState.projectRoot;

    if (expectedProjectRoot.projectFile.status !== 'EXISTS') {
      return;
    }

    const expectedProjectFilePath = expectedProjectRoot.projectFile.path;
    const requestId = ++projectRootProjectOpenRequestIdRef.current;

    authorizedProjectRootPathRef.current = undefined;
    setIsProjectRootProjectOpenInProgress(true);
    setImportError(undefined);
    setHeaderHelpMessage(`Opening ${expectedProjectRoot.projectFileName} from Project Root.`);

    try {
      const preparation = await prepareProjectRootProjectOpen(
        client,
        workspaceRef.current,
        (projectFile) => parseHumStudioProjectValue(projectFile),
        {
          applyRestoration: (loadedWorkspace, descriptors, restoration) => ({
            ...loadedWorkspace,
            project: applyProjectSourceRestoration(
              loadedWorkspace.project,
              descriptors,
              restoration,
            ),
          }),
          collectDescriptors: (loadedWorkspace) =>
            collectProjectSourceRestorationDescriptors(loadedWorkspace.project),
        },
      );

      if (projectRootProjectOpenRequestIdRef.current !== requestId) {
        return;
      }

      if (!preparation.canOpen) {
        setImportError(preparation.message);
        setHeaderHelpMessage(preparation.message);
        return;
      }

      const opened = applyProjectRootProjectOpen(
        preparation.plan,
        workspaceRef.current,
      );

      if (!opened.opened) {
        setImportError(opened.message);
        setHeaderHelpMessage(opened.message);
        return;
      }

      if (
        opened.loadedProject.projectFilePath !== expectedProjectFilePath ||
        opened.loadedProject.projectFileName !== expectedProjectRoot.projectFileName
      ) {
        const message =
          'Local Engine returned a Project JSON outside the selected Project Root identity. The current Workspace was preserved.';
        setImportError(message);
        setHeaderHelpMessage(message);
        return;
      }

      const replacement = replaceWorkspaceState(opened.workspace, {
        reconnectSessionAudioSources: true,
      });

      authorizedProjectRootPathRef.current = expectedProjectRoot.rootPath;
      setSavedProjectFingerprint(
        createSavedProjectFingerprintAfterLoad(
          createDirtyStateFingerprint(replacement.workspace.project),
          opened.mixerNormalization,
        ),
      );
      setProjectFileSaveState({ status: 'IDLE' });
      setImportError(undefined);
      setHeaderHelpMessage(
        `Project opened from Root: ${opened.loadedProject.projectFileName}. Save to Root is now authorized for this exact Root.`,
      );
    } catch (error) {
      if (projectRootProjectOpenRequestIdRef.current !== requestId) {
        return;
      }

      const message =
        error instanceof Error
          ? `Project Root open failed: ${error.message}`
          : 'Project Root open failed.';
      setImportError(message);
      setHeaderHelpMessage(message);
    } finally {
      if (projectRootProjectOpenRequestIdRef.current === requestId) {
        setIsProjectRootProjectOpenInProgress(false);
      }
    }
  }, [
    engineConnection.activity,
    engineConnection.lifecycle,
    isProjectRootProjectOpenInProgress,
    projectRootState,
    replaceWorkspaceState,
  ]);

  const handleSaveProjectToRoot = useCallback(async () => {
    const client = localEngineClientRef.current;

    if (
      !client ||
      engineConnection.lifecycle !== 'READY' ||
      engineConnection.activity !== 'IDLE' ||
      projectRootState.status !== 'READY' ||
      isProjectRootOverwriteProtected ||
      projectFileSaveState.status === 'SAVING'
    ) {
      setHeaderHelpMessage(
        isProjectRootOverwriteProtected
          ? 'Existing Project JSON is protected until that Project is loaded or a new Root is selected.'
          : 'Project save requires an idle Engine and a ready Project Root.',
      );
      return;
    }

    const requestId = ++projectFileSaveRequestIdRef.current;
    const savedFingerprint = createDirtyStateFingerprint(workspace.project);
    const projectFile = createHumStudioProjectFile(workspace);
    setProjectFileSaveState({ status: 'SAVING' });
    setHeaderHelpMessage(`Saving ${projectRootState.projectRoot.projectFileName} atomically.`);
    const result = await client.saveProjectFile(projectFile);

    if (projectFileSaveRequestIdRef.current !== requestId) {
      return;
    }

    if (!result.ok) {
      setProjectFileSaveState({ message: result.message, status: 'ERROR' });
      setHeaderHelpMessage(result.message);
      return;
    }

    setProjectFileSaveState({ savedProject: result.savedProject, status: 'SAVED' });
    authorizedProjectRootPathRef.current = projectRootState.projectRoot.rootPath;
    setProjectRootState((currentState) =>
      currentState.status === 'READY' &&
      currentState.projectRoot.rootPath === projectRootState.projectRoot.rootPath
        ? {
            projectRoot: {
              ...currentState.projectRoot,
              projectFile: {
                lastModifiedAt: result.savedProject.lastModifiedAt,
                path: result.savedProject.projectFilePath,
                sizeBytes: result.savedProject.bytesWritten,
                status: 'EXISTS',
              },
            },
            status: 'READY',
          }
        : currentState,
    );
    setSavedProjectFingerprint(savedFingerprint);
    setHeaderHelpMessage(
      `Project saved atomically: ${result.savedProject.projectFileName} (${result.savedProject.bytesWritten} bytes).`,
    );
  }, [
    engineConnection.activity,
    engineConnection.lifecycle,
    isProjectRootOverwriteProtected,
    projectFileSaveState.status,
    projectRootState,
    workspace,
  ]);

  const handleSelectProjectRoot = useCallback(async () => {
    const client = localEngineClientRef.current;

    if (
      !client ||
      engineConnection.lifecycle !== 'READY' ||
      engineConnection.activity !== 'IDLE' ||
      projectRootState.status === 'LOADING' ||
      projectRootState.status === 'SELECTING'
    ) {
      setHeaderHelpMessage('Project Root selection requires an idle, ready Local Engine.');
      return;
    }

    projectRootProjectOpenRequestIdRef.current += 1;
    authorizedProjectRootPathRef.current = undefined;
    setIsProjectRootProjectOpenInProgress(false);
    const requestId = ++projectRootRequestIdRef.current;
    setProjectRootState({ status: 'SELECTING' });
    setHeaderHelpMessage('Select one Windows directory as the ElpisDAW Project Root.');
    const result = await client.selectProjectRoot();

    if (projectRootRequestIdRef.current !== requestId) {
      return;
    }

    if (!result.ok) {
      setProjectRootState({ message: result.message, status: 'ERROR' });
      setHeaderHelpMessage(result.message);
      return;
    }

    setProjectRootState(createProjectRootUiState(result.projectRoot));
    if (result.selection === 'SELECTED') {
      setProjectFileSaveState({ status: 'IDLE' });
    }
    setHeaderHelpMessage(
      result.selection === 'CANCELED'
        ? 'Project Root selection was canceled. The previous Root was preserved.'
        : result.projectRoot.status === 'READY'
          ? `Project Root ready: ${result.projectRoot.rootPath}`
          : 'Project Root remains unset.',
    );
  }, [engineConnection.activity, engineConnection.lifecycle, projectRootState.status]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') {
        return;
      }

      event.preventDefault();
      handleBrowserSave();
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleBrowserSave]);

  const handleBrowserRestore = useCallback(async () => {
    const savedProject = window.localStorage.getItem(browserSaveKey);

    if (!savedProject) {
      setImportError('No browser save found.');
      return;
    }

    try {
      const projectLoad = parseHumStudioProjectFile(savedProject);
      await replaceLoadedProjectWorkspace(projectLoad, 'Browser save restored');
      setImportError(undefined);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Browser save could not be restored.');
    }
  }, [replaceLoadedProjectWorkspace]);

  const handleResetWorkspace = useCallback(() => {
    handleCloseFinalFiler();
    const nextWorkspace = createInitialWorkspaceState();
    replaceWorkspaceState(nextWorkspace);
    setSavedProjectFingerprint(createDirtyStateFingerprint(nextWorkspace.project));
    setImportError(undefined);
  }, [handleCloseFinalFiler, replaceWorkspaceState]);

  const applyPreset = useCallback(
    (preset: TabFlowPreset) => {
      const nextWorkspace = createWorkspaceStateFromProject(preset.project);
      replaceWorkspaceState(nextWorkspace);
      setSavedProjectFingerprint(createDirtyStateFingerprint(nextWorkspace.project));
      setIsPresetDrawerOpen(false);
      setImportError(undefined);
    },
    [replaceWorkspaceState],
  );

  const handleLoadPreset = useCallback(
    (preset: TabFlowPreset) => {
      if (!isSafetyModeEnabled) {
        applyPreset(preset);
        return;
      }

      requestSafetyConfirm({
        title: 'Load Preset',
        message: `Load ${preset.name} and replace the current workspace.`,
        details: [
          preset.description,
          preset.intent,
          `${preset.project.patchTabs.length} PatchTabs`,
          `${preset.project.connections.length} routes`,
          `${preset.project.tracks.length} tracks`,
        ],
        confirmLabel: 'LOAD',
        onConfirm: () => applyPreset(preset),
      });
    },
    [applyPreset, isSafetyModeEnabled, requestSafetyConfirm],
  );

  const handleProjectFilePicked = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';

      if (!file) {
        return;
      }

      try {
        const projectLoad = parseHumStudioProjectFile(await file.text());
        await replaceLoadedProjectWorkspace(projectLoad, 'Project loaded');
        setImportError(undefined);
      } catch (error) {
        setImportError(error instanceof Error ? error.message : 'Project file could not be loaded.');
      }
    },
    [replaceLoadedProjectWorkspace],
  );

  const handleAudioFilePicked = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';

      if (!file) {
        return;
      }

      if (!isLikelyAudioFile(file)) {
        setImportError('Import Audio accepts one audio file.');
        return;
      }

      try {
        const durationSeconds = await readAudioFileDurationSeconds(file);
        const metadata = createAudioFileMetadata(file, durationSeconds);
        const preview = createAudioImportWorkspaceUpdate(workspace, metadata);

        if (!preview.canImport) {
          showTimelineStatusFeedback({
            helpText: preview.message,
            message: preview.reason === 'clip-overlap' ? 'IMPORT COLLISION' : 'IMPORT BLOCKED',
            tone: 'warning',
          });
          setImportError(undefined);
          return;
        }

        let importedClipId = preview.clip.id;
        let importedTrackName = preview.track.name;
        let extendedToBars = preview.extendedToBars;

        updateWorkspaceState((currentWorkspace) => {
          const result = createAudioImportWorkspaceUpdate(currentWorkspace, metadata);

          if (!result.canImport) {
            return currentWorkspace;
          }

          importedClipId = result.clip.id;
          importedTrackName = result.track.name;
          extendedToBars = result.extendedToBars;

          return result.workspace;
        });
        sessionAudioSourcesRef.current.register(metadata.sourceId, file);
        setTimelineRevealRequest({ clipId: importedClipId, requestId: Date.now() });
        const extensionMessage = extendedToBars
          ? ` Timeline extended to ${formatCount(extendedToBars, 'bar')}.`
          : '';
        showTimelineStatusFeedback({
          helpText: `Imported ${file.name} to ${importedTrackName} as a metadata-only hum-audio clip.${extensionMessage}`,
          message: 'AUDIO IMPORTED',
          tone: 'success',
        });
        setImportError(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Audio metadata could not be read.';
        setImportError(message);
        setHeaderHelpMessage(message);
      }
    },
    [showTimelineStatusFeedback, updateWorkspaceState, workspace],
  );

  const handleSourceRelinkFilePicked = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';

      const clipId = pendingSourceRelinkClipIdRef.current;
      pendingSourceRelinkClipIdRef.current = undefined;

      if (!file) {
        return;
      }

      if (!clipId) {
        setImportError('Choose a Source Issue before relinking.');
        return;
      }

      if (!isLikelyAudioFile(file)) {
        setImportError('Relink Source accepts one audio file.');
        return;
      }

      try {
        const durationSeconds = await readAudioFileDurationSeconds(file);
        const metadata = createAudioFileMetadata(file, durationSeconds);
        const preview = createSourceRelinkWorkspaceUpdate(workspace, clipId, metadata);

        if (!preview.canRelink) {
          setImportError(preview.message);
          setHeaderHelpMessage(preview.message);
          return;
        }

        updateWorkspaceState((currentWorkspace) => {
          const result = createSourceRelinkWorkspaceUpdate(currentWorkspace, clipId, metadata);

          return result.canRelink ? result.workspace : currentWorkspace;
        });
        sessionAudioSourcesRef.current.register(preview.clip.sourceFile?.sourceId ?? metadata.sourceId, file);
        setTimelineRevealRequest((currentRequest) => ({
          clipId: preview.clip.id,
          requestId: (currentRequest?.requestId ?? 0) + 1,
        }));
        showTimelineStatusFeedback({
          helpText:
            preview.relinkedClipCount > 1
              ? `Relinked ${metadata.name} for ${formatCount(
                  preview.relinkedClipCount,
                  'clip',
                )}. Shared source is available for this session.`
              : `Relinked ${metadata.name} on ${preview.track.name}. Source is available for this session.`,
          message:
            preview.relinkedClipCount > 1
              ? `${preview.relinkedClipCount} CLIPS RELINKED`
              : 'SOURCE RELINKED',
          tone: 'success',
        });
        setImportError(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Source metadata could not be read.';
        setImportError(message);
        setHeaderHelpMessage(message);
      }
    },
    [showTimelineStatusFeedback, updateWorkspaceState, workspace],
  );

  const runMenuAction = useCallback((action: () => void) => {
    action();
    setIsMenuOpen(false);
  }, []);
  const handleSelectTopDock = useCallback((dockId: TopDockId) => {
    const viewport = topDockViewportRef.current;

    if (viewport) {
      topDockScrollMemoryRef.current.remember(activeTopDockId, viewport.scrollTop);
    }

    setActiveTopDockId(dockId);
    setLoadedTopDockIds((currentDockIds) => {
      if (currentDockIds.has(dockId)) {
        return currentDockIds;
      }

      const nextDockIds = new Set(currentDockIds);
      nextDockIds.add(dockId);

      return nextDockIds;
    });

    const nextDock = topDockDefinitions.find((dock) => dock.id === dockId);

    if (nextDock) {
      emitHeaderHelpPreview(nextDock.help);
    }
  }, [activeTopDockId]);

  useEffect(() => {
    const viewport = topDockViewportRef.current;

    if (viewport) {
      viewport.scrollTop = topDockScrollMemoryRef.current.recall(activeTopDockId);
    }
  }, [activeTopDockId]);
  const handleSelectRoutingIssue = useCallback(
    (connectionId: string) => {
      handleSelectTopDock('main');
      const connection = project.connections.find(
        (candidate) => candidate.id === connectionId,
      );

      if (connection) {
        handleSelectPatchTab(connection.toPatchTabId);
      }
      handleSelectConnection(connectionId);
    },
    [
      handleSelectConnection,
      handleSelectPatchTab,
      handleSelectTopDock,
      project.connections,
    ],
  );
  const runProtectedMenuAction = useCallback(
    (action: () => void, confirmRequest: SafetyConfirmDraft) => {
      if ((punchSessionRef.current?.attempts.length ?? 0) > 0) {
        setHeaderHelpMessage(
          'Workspace replacement is locked while Punch Attempts are unresolved. KEEP or DISCARD the Punch Session first.',
        );
        setIsMenuOpen(false);
        return;
      }

      if (isSafetyModeEnabled && projectHealth.hasUnsavedChanges) {
        requestSafetyConfirm(confirmRequest);
      } else {
        action();
      }

      setIsMenuOpen(false);
    },
    [isSafetyModeEnabled, projectHealth.hasUnsavedChanges, requestSafetyConfirm],
  );

  return (
    <div className={`app-shell ${isTimelineExpanded ? 'timeline-workspace-split' : ''}`}>
      <AppHeader
        canOpenProjectFromRoot={
          !isHeaderEditingLocked &&
          engineConnection.lifecycle === 'READY' &&
          engineConnection.activity === 'IDLE' &&
          projectRootState.status === 'READY' &&
          projectRootState.projectRoot.projectFile.status === 'EXISTS' &&
          !isProjectRootProjectOpenInProgress
        }
        canSaveProjectToRoot={
          engineConnection.lifecycle === 'READY' &&
          engineConnection.activity === 'IDLE' &&
          projectRootState.status === 'READY' &&
          !isProjectRootOverwriteProtected &&
          projectFileSaveState.status !== 'SAVING'
        }
        canSelectProjectRoot={
          !isHeaderEditingLocked &&
          engineConnection.lifecycle === 'READY' &&
          engineConnection.activity === 'IDLE' &&
          projectRootState.status !== 'LOADING' &&
          projectRootState.status !== 'SELECTING'
        }
        canRedo={history.future.length > 0 && (punchSession?.attempts.length ?? 0) === 0}
        canUndo={history.past.length > 0 && (punchSession?.attempts.length ?? 0) === 0}
        dirtyState={projectHealth.dirtyState}
        engineConnection={engineConnection}
        generationProgress={headerGenerationProgress}
        hasUnsavedChanges={projectHealth.hasUnsavedChanges}
        helpMessage={headerHelpMessage}
        importError={importError}
        isMenuOpen={isMenuOpen}
        isProjectRootProjectOpenInProgress={isProjectRootProjectOpenInProgress}
        isProductionEditingLocked={isHeaderEditingLocked}
        isProjectRootOverwriteProtected={isProjectRootOverwriteProtected}
        isSafetyModeEnabled={isSafetyModeEnabled}
        onBrowserRestore={() =>
          runProtectedMenuAction(handleBrowserRestore, {
            title: 'Restore Browser Save',
            message: 'This will replace the current unsaved workspace with the browser save.',
            confirmLabel: 'RESTORE',
            details: ['Current unsaved changes will be overwritten.'],
            onConfirm: handleBrowserRestore,
          })
        }
        onBrowserSave={() => runMenuAction(handleBrowserSave)}
        onCloseMenu={() => setIsMenuOpen(false)}
        onDownloadProject={() => runMenuAction(handleDownloadProject)}
        onOpenFinalFiler={() => runMenuAction(handleOpenFinalFiler)}
        onOpenProjectFromRoot={() =>
          runProtectedMenuAction(handleOpenProjectFromRoot, {
            title: 'Open Project from Root',
            message: `Replace the current Workspace with ${
              projectRootState.status === 'READY'
                ? projectRootState.projectRoot.projectFileName
                : 'the Project Root JSON'
            }?`,
            details: [
              'The Project JSON will be read through the Local Engine.',
              'Generated sources will be restored before the Workspace is replaced.',
              'Use Browser Save first if the current Workspace must be recovered afterward.',
            ],
            confirmLabel: 'OPEN',
            onConfirm: handleOpenProjectFromRoot,
          })
        }
        onLoadProject={() =>
          runProtectedMenuAction(
            () => fileInputRef.current?.click(),
            {
              title: 'Load Project File',
              message: 'This will replace the current unsaved workspace after you choose a project file.',
              confirmLabel: 'LOAD',
              details: ['Current unsaved changes will be overwritten.'],
              onConfirm: () => fileInputRef.current?.click(),
            },
          )
        }
        onSaveProjectToRoot={() => runMenuAction(() => void handleSaveProjectToRoot())}
        onSelectProjectRoot={() => runMenuAction(() => void handleSelectProjectRoot())}
        onRedo={() => runMenuAction(handleRedo)}
        onResetWorkspace={() =>
          runProtectedMenuAction(handleResetWorkspace, {
            title: 'Reset Workspace',
            message: 'This will reset ElpisDAW to the starter workspace.',
            confirmLabel: 'RESET',
            details: ['Current unsaved changes will be discarded.'],
            onConfirm: handleResetWorkspace,
          })
        }
        onToggleInspector={() => runMenuAction(() => setIsProjectInspectorOpen((isOpen) => !isOpen))}
        onToggleMenu={() => setIsMenuOpen((isOpen) => !isOpen)}
        onTogglePresetDrawer={() => runMenuAction(() => setIsPresetDrawerOpen((isOpen) => !isOpen))}
        onToggleSafetyMode={() => setIsSafetyModeEnabled((isEnabled) => !isEnabled)}
        onToggleTakeHistory={() => runMenuAction(() => setIsTakeHistoryOpen((isOpen) => !isOpen))}
        onUndo={() => runMenuAction(handleUndo)}
        projectFileSaveState={projectFileSaveState}
        projectRootState={projectRootState}
      />
      {isEngineProductionEditingLocked && !isAutoPatchProductionActive && (
        <EngineProductionLock
          connection={engineConnection}
          message={engineAvailability.message}
          onBrowserSave={handleBrowserSave}
          onDownloadProject={handleDownloadProject}
        />
      )}
      {autoPatchProductionState.status !== 'IDLE' && (
        <AutoPatchProductionStatusBar
          state={autoPatchProductionState}
          onCancel={handleCancelAutoPatchProduction}
          onDismiss={handleDismissAutoPatchProduction}
        />
      )}
      {safetyConfirmRequest && (
        <SafetyConfirmBar
          request={safetyConfirmRequest}
          onCancel={clearSafetyConfirm}
          onConfirm={confirmSafetyAction}
        />
      )}
      <input
        ref={fileInputRef}
        hidden
        disabled={isHeaderEditingLocked}
        accept="application/json,.json"
        type="file"
        onChange={handleProjectFilePicked}
      />
      <input
        ref={audioInputRef}
        hidden
        disabled={isHeaderEditingLocked}
        accept="audio/*"
        type="file"
        onChange={handleAudioFilePicked}
      />
      <input
        ref={sourceRelinkInputRef}
        hidden
        disabled={isHeaderEditingLocked}
        accept="audio/*"
        type="file"
        onChange={handleSourceRelinkFilePicked}
      />
      <main
        ref={productionEditorRef}
        className={`studio-grid ${isTimelineExpanded ? 'timeline-expanded' : ''} ${
          isProductionEditingLocked ? 'production-locked' : ''
        }`}
        aria-disabled={isProductionEditingLocked}
      >
        <TopDock
          activeDockId={activeTopDockId}
          onSelectDock={handleSelectTopDock}
          viewportRef={topDockViewportRef}
        >
          {loadedTopDockIds.has('main') && (
            <div
              className={`top-dock-pane ${activeTopDockId === 'main' ? 'active' : ''}`}
              hidden={activeTopDockId !== 'main'}
            >
              <div className="top-dock-main-grid" aria-label="Main Dock workspace">
                <PatchTabRack
                  patchTabs={project.patchTabs}
                  selectedPatchTabId={workspace.selectedPatchTabId}
                  onAddPatchTab={handleAddPatchTab}
                  onMovePatchTab={handleMovePatchTab}
                  onSelectPatchTab={handleSelectPatchTab}
                />
                <PatchTabDetails
                  aceStepState={aceStepState}
                  aceStepCoverState={aceStepCoverState}
                  aceStepTextToMusicState={aceStepTextToMusicState}
                  autoPatchProductionState={autoPatchProductionState}
                  basicPitchHumToMidiState={basicPitchHumToMidiState}
                  basicPitchRuntimeState={basicPitchRuntimeState}
                  colorCode={selectedPatchTabColor}
                  engineAcceptsNewJobs={engineAvailability.acceptsNewJobs}
                  engineAvailabilityMessage={engineAvailability.message}
                  engineIsReady={engineConnection.lifecycle === 'READY'}
                  instrumentRenderState={instrumentRenderState}
                  isProjectRootReady={projectRootState.status === 'READY'}
                  patchTab={selectedPatchTab}
                  patchTabs={project.patchTabs}
                  pendingPortSelection={workspace.pendingPortSelection}
                  project={project}
                  projectMixdownState={projectMixdownState}
                  printMixState={printMixState}
                  selectedClipInfo={selectedMidiVoiceClipInfo}
                  selectedMidiNoteCount={selectedMidiNoteCount}
                  soundFontCatalogState={soundFontCatalogState}
                  stableAudio3TextToAudioState={stableAudio3TextToAudioState}
                  onCancelAceStepVocal={handleCancelAceStepVocal}
                  onCancelAceStepCover={handleCancelAceStepCover}
                  onCancelAceStepTextToMusic={handleCancelAceStepTextToMusic}
                  onCancelStableAudio3TextToAudio={handleCancelStableAudio3TextToAudio}
                  onCancelBasicPitchHumToMidi={handleCancelBasicPitchHumToMidi}
                  onCancelProjectMixdown={handleCancelClipFilerProjectMixdown}
                  onCancelPrintMix={handleCancelPrintMix}
                  onClearPatchPortSelection={handleClearPatchPortSelection}
                  onConnectPatchTabs={handleConnectPatchTabs}
                  onDeletePatchTab={handleRequestDeletePatchTab}
                  onGenerateStableAudio3TextToAudio={handleGenerateStableAudio3TextToAudio}
                  onGenerateStableAudio3AudioToAudio={handleRunStableAudio3AudioToAudio}
                  onGenerateAceStepVocal={handleGenerateAceStepVocal}
                  onGenerateAceStepCover={handleGenerateAceStepCover}
                  onGenerateAceStepTextToMusic={handleGenerateAceStepTextToMusic}
                  onListSoundFontPresets={handleListSoundFontPresets}
                  onParameterChange={handleParameterChange}
                  onParameterChanges={handleParameterChanges}
                  onPatchPortClick={handlePatchPortClick}
                  onRenderInstrument={handleRenderInstrument}
                  onRefreshSoundFonts={handleRefreshPianoRollSoundFonts}
                  onRecoverProjectMixdown={handleRecoverClipFilerProjectMixdown}
                  onRecoverBasicPitchHumToMidi={handleRecoverBasicPitchHumToMidi}
                  onRecoverPrintMix={handleRecoverPrintMix}
                  onRenamePatchTab={handleRenamePatchTab}
                  onRunProjectMixdown={handleRunClipFilerProjectMixdown}
                  onRetryBasicPitchHumToMidi={handleRetryBasicPitchHumToMidi}
                  onRunBasicPitchHumToMidi={handleRunBasicPitchHumToMidi}
                  onRunPrintMix={handleRunPrintMix}
                  onSaveProjectMixdownWav={handleSaveProjectMixdownWav}
                />
                <RoutingPanel
                  connections={project.connections}
                  isSafetyModeEnabled={isSafetyModeEnabled}
                  patchTabs={project.patchTabs}
                  tabFlowLines={project.tabFlowLines}
                  selectedConnectionId={workspace.selectedConnectionId}
                  selectedPatchTabId={workspace.selectedPatchTabId}
                  selectedTabFlowLineId={workspace.selectedTabFlowLineId}
                  onAddTabFlowLine={handleAddTabFlowLine}
                  onBuildAutoFlow={handleBuildAutoFlow}
                  onDeleteConnection={handleDeleteConnection}
                  onDeleteEmptyTabFlowLine={handleDeleteEmptyTabFlowLine}
                  onRequestSafetyConfirm={requestSafetyConfirm}
                  onSelectConnection={handleSelectConnection}
                  onSelectPatchTab={handleSelectPatchTab}
                  onSelectTabFlowLine={handleSelectTabFlowLine}
                  onSetTabFlowLineEnabled={handleSetTabFlowLineEnabled}
                />
              </div>
            </div>
          )}
          {loadedTopDockIds.has('piano-roll') && (
            <PianoRollInteractionSpike
              hasUnsavedProjectChanges={projectHealth.hasUnsavedChanges}
              isActive={activeTopDockId === 'piano-roll'}
              isTimelinePlaying={workspace.activeTransport === 'PLAY'}
              onAssignSoundFont={handleAssignPianoRollSoundFont}
              onCreateManualMidiClip={handleCreateManualMidiClip}
              onCreateNewTake={handleCreateNewPianoRollTake}
              onListSoundFontPresets={handleListSoundFontPresets}
              onPrepareLiveNotePreview={handlePreparePianoRollLiveNotePreview}
              onRefreshSoundFonts={handleRefreshPianoRollSoundFonts}
              onSaveNotes={handleSavePianoRollNotes}
              onStopLiveNotePreview={stopPianoRollLiveNotePreview}
              onTriggerLiveNotePreview={handleTriggerPianoRollLiveNotePreview}
              pianoRollLiveNotePreviewState={pianoRollLiveNotePreviewState}
              project={project}
              selectedClipId={selectedPianoRollClipId}
              soundFontCatalogState={soundFontCatalogState}
            />
          )}
          {loadedTopDockIds.has('mixer') && (
            <MixerEffectsEditor
              activeTransport={workspace.activeTransport}
              isActive={activeTopDockId === 'mixer'}
              isEditingLocked={isHeaderEditingLocked}
              meterStore={projectPlaybackMeterStore}
              projectMixdownControl={mixerProjectMixdownControl}
              projectStemPrintControl={mixerProjectStemPrintControl}
              projectStemPrintOptions={
                projectStemPrintTargetCatalog.canList
                  ? projectStemPrintTargetCatalog.options
                  : []
              }
              selectedProjectStemPrintTargetKeys={
                projectStemPrintSelection.canResolve
                  ? projectStemPrintSelection.selectedKeys
                  : []
              }
              onCancelProjectMixdown={() =>
                handleCancelProjectMixdown(MIXER_PROJECT_MIXDOWN_OWNER)
              }
              onAssignSoundFont={handleAssignPianoRollSoundFont}
              onCommand={handleMixerEffectCommand}
              onListSoundFontPresets={handleListSoundFontPresets}
              onRecoverProjectMixdown={() =>
                void handleRecoverProjectMixdown(MIXER_PROJECT_MIXDOWN_OWNER)
              }
              onRequestReset={handleRequestMixerEffectReset}
              onRunProjectMixdown={() =>
                void handleRunProjectMixdown(MIXER_PROJECT_MIXDOWN_OWNER)
              }
              onCancelProjectStemPrint={handleCancelProjectStemPrint}
              onRecoverProjectStemPrint={() =>
                void handleRecoverProjectStemPrint()
              }
              onRunProjectStemPrint={() => void handleRunProjectStemPrint()}
              onToggleProjectStemPrintTarget={handleToggleProjectStemPrintTarget}
              onSelectTrack={handleSelectTrack}
              onToggleTrackMute={handleToggleTrackMute}
              project={project}
              soundFontCatalogState={soundFontCatalogState}
            />
          )}
        </TopDock>
        <Timeline
          activeTransport={workspace.activeTransport}
          autoPatchHistoryEntries={autoPatchHistoryEntries}
          autoPatchProductionState={autoPatchProductionState}
          canRunAutoPatchProduction={
            !isAutoPatchProductionActive &&
            engineAvailability.acceptsNewJobs &&
            projectRootState.status === 'READY' &&
            recordingRuntimePhase === 'IDLE'
          }
          editHistoryItems={editHistoryItems}
          isHistoryOpen={isTakeHistoryOpen}
          isSafetyModeEnabled={isSafetyModeEnabled}
          isTimelineExpanded={isTimelineExpanded}
          isTimelineExpandPending={isTimelineExpandPending}
          sectionRef={timelinePageAnchorRef}
          microphoneInputLevel={microphoneInputLevel}
          playheadTick={project.playheadTick}
          project={project}
          punchInTick={punchInTick}
          punchOutTick={punchOutTick}
          punchSession={punchSession}
          recordingRuntimePhase={recordingRuntimePhase}
          selectedClipId={workspace.selectedClipId}
          selectedClipInfo={selectedClipInfo}
          onActivateClipTake={handleActivateClipTake}
          hasSessionAudioSource={(sourceId) => sessionAudioSourcesRef.current.has(sourceId)}
          totalTicks={project.totalTicks}
          timelineClipClipboard={timelineClipClipboard}
          isTimelineExportPreparing={isTimelineExportPreparing}
          timelineStatusDiagnostic={timelineStatusDiagnostic}
          timelineStatusFeedback={timelineStatusFeedback}
          revealRequest={timelineRevealRequest}
          tracks={project.tracks}
          trackGroupingAvailability={trackGroupingAvailability}
          onAddBlankTrack={handleAddBlankTrack}
          onGroupSelectedTracks={handleGroupSelectedTracks}
          onImportAudio={() => audioInputRef.current?.click()}
          onApplyAutoPatchGuard={handleApplyAutoPatchGuard}
          onRunAutoPatchProduction={handleRunAutoPatchProduction}
          onCopySelectedTimelineClips={handleCopySelectedTimelineClips}
          onCopyTimelineSelection={handleCopyTimelineSelection}
          onDeleteTimelineSelection={handleRequestDeleteTimelineSelection}
          onLeftTrimTimelineAudioClip={handleLeftTrimTimelineAudioClip}
          onMoveTimelineClip={handleMoveTimelineClip}
          onJumpToEditHistory={handleJumpToEditHistory}
          onOpenHistory={() => setIsTakeHistoryOpen((isOpen) => !isOpen)}
          onOpenProjectInspector={() => setIsProjectInspectorOpen(true)}
          onPreviewClipTake={handlePreviewClipTake}
          onPreviewPunchAttempt={() => void handlePreviewPunchAttempt()}
          onKeepPunchAttempt={() => void handleKeepPunchAttempt()}
          onDiscardPunchSession={handleDiscardPunchSession}
          onSelectPunchAttempt={handleSelectPunchAttempt}
          onSetPunchMarker={handleSetPunchMarker}
          onStartPunchRecording={() => void handleStartPunchRecording()}
          onRightResizeTimelineMidiClip={handleRightResizeTimelineMidiClip}
          onRightTrimTimelineAudioClip={handleRightTrimTimelineAudioClip}
          onSplitTimelineAudioClip={handleSplitTimelineAudioClip}
          onPasteTimelineClipClipboard={handlePasteTimelineClipClipboard}
          onProjectBpmChange={handleProjectBpmChange}
          onProjectGridResolutionChange={handleProjectGridResolutionChange}
          onProjectKeyChange={handleProjectKeyChange}
          onProjectPlayheadChange={handleProjectPlayheadChange}
          onRecordingSettingsChange={handleRecordingSettingsChange}
          onRequestSafetyConfirm={requestSafetyConfirm}
          onProjectTotalBarsChange={handleProjectTotalBarsChange}
          onTimelineSettingRangeWarning={showTimelineSettingRangeWarning}
          onRenameTrack={handleRenameTrack}
          onSelectAutoPatchHistoryClip={handleSelectSourceIssue}
          onSelectClip={handleSelectClip}
          onSelectTrack={handleSelectTrack}
          onToggleTrackMute={handleToggleTrackMute}
          onToggleTimelineExpanded={handleToggleTimelineExpanded}
          onToggleTrackGroup={handleToggleTrackGroup}
          onTransport={handleTransport}
          onUngroupTrack={handleUngroupTrack}
        />
      </main>
      {isFinalFilerOpen && (
        <FinalFilerPanel
          availability={finalFilerAvailability}
          engineReady={
            Boolean(localEngineClientRef.current) &&
            engineConnection.lifecycle === 'READY'
          }
          fileName={finalFilerFileName}
          fileNameResolution={finalFilerFileNameResolution}
          includeSourceReport={finalFilerIncludeSourceReport}
          isBusy={isFinalFilerBusy}
          result={finalFilerResult}
          onCancel={handleCancelFinalFiler}
          onClose={handleCloseFinalFiler}
          onExport={() => void handleRunFinalFiler()}
          onFileNameChange={(value) => {
            setFinalFilerFileName(value);
            setFinalFilerResult(undefined);
          }}
          onIncludeSourceReportChange={(include) => {
            setFinalFilerIncludeSourceReport(include);
            setFinalFilerResult(undefined);
          }}
        />
      )}
      {isProjectInspectorOpen && (
        <ProjectInspector
          autoPatchHistoryCount={autoPatchHistoryEntries.length}
          editHistoryCount={editHistoryItems.length}
          health={projectHealth}
          instrumentAudioPreviewState={instrumentAudioPreviewState}
          project={project}
          selectedClipInfo={selectedClipInfo}
          onActivateClipTake={handleActivateClipTake}
          onClose={() => {
            stopInstrumentAudioPreview(false);
            setIsProjectInspectorOpen(false);
          }}
          onPreviewClipTake={handlePreviewClipTake}
          onRemoveClipTakeFromProject={
            handleRequestRemoveClipTakeFromProject
          }
          onDeleteClipTakeAndAudioFile={
            handleRequestDeleteClipTakeAndAudioFile
          }
          onRelinkSource={handleRequestRelinkSource}
          onSelectRoutingIssue={handleSelectRoutingIssue}
          onSelectSourceIssue={handleSelectSourceIssue}
        />
      )}
      {isPresetDrawerOpen && (
        <PresetDrawer
          isSafetyModeEnabled={isSafetyModeEnabled}
          presets={tabFlowPresets}
          onClose={() => setIsPresetDrawerOpen(false)}
          onLoadPreset={handleLoadPreset}
        />
      )}
    </div>
  );
}

function TopDock({
  activeDockId,
  children,
  onSelectDock,
  viewportRef,
}: {
  activeDockId: TopDockId;
  children: ReactNode;
  onSelectDock: (dockId: TopDockId) => void;
  viewportRef: RefObject<HTMLDivElement>;
}) {
  const activeDock = topDockDefinitions.find((dock) => dock.id === activeDockId) ?? topDockDefinitions[0];

  return (
    <section className="top-dock" aria-label="TopDock">
      <div className="top-dock-rail" aria-label="TopDock selector">
        <div className="top-dock-buttons" role="list">
          {topDockDefinitions.map((dock) => (
            <HelpHint key={dock.id} text={dock.help}>
              <button
                type="button"
                className={`top-dock-button ${dock.id === activeDock.id ? 'active' : ''}`}
                aria-pressed={dock.id === activeDock.id}
                onClick={() => onSelectDock(dock.id)}
              >
                <span>{dock.label}</span>
              </button>
            </HelpHint>
          ))}
        </div>
      </div>
      <div ref={viewportRef} className="top-dock-viewport">{children}</div>
    </section>
  );
}

function TopDockPlaceholder({
  dockId,
  isActive,
  meter,
  title,
}: {
  dockId: TopDockId;
  isActive: boolean;
  meter: string;
  title: string;
}) {
  return (
    <div className={`top-dock-pane ${isActive ? 'active' : ''}`} hidden={!isActive}>
      <section className="top-dock-placeholder panel" aria-labelledby={`${dockId}-dock-heading`}>
        <PanelHeader eyebrow="Dock" id={`${dockId}-dock-heading`} meter={meter} title={title} />
        <div className="top-dock-placeholder-surface" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      </section>
    </div>
  );
}

function SafetyConfirmBar({
  request,
  onCancel,
  onConfirm,
}: {
  request: SafetyConfirmRequest;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="safety-confirm-shell" role="alertdialog" aria-labelledby={`${request.id}-title`} aria-modal="false">
      <div className="safety-confirm-panel">
        <div className="safety-confirm-led" aria-hidden="true" />
        <div className="safety-confirm-copy">
          <span>Safety Confirm</span>
          <strong id={`${request.id}-title`}>{request.title}</strong>
          <p>{request.message}</p>
          {request.details && request.details.length > 0 && (
            <div className="safety-confirm-details">
              {request.details.map((detail) => (
                <small key={detail}>{detail}</small>
              ))}
            </div>
          )}
        </div>
        <div className="safety-confirm-actions">
          <button type="button" className="safety-confirm-button secondary" onClick={onCancel}>
            {request.cancelLabel ?? 'CANCEL'}
          </button>
          <button type="button" className="safety-confirm-button primary" onClick={onConfirm}>
            {request.confirmLabel ?? 'CONFIRM'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AutoPatchProductionStatusBar({
  state,
  onCancel,
  onDismiss,
}: {
  state: AutoPatchProductionUiState;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const presentation = getAutoPatchProductionUiPresentation(state);

  return (
    <section
      className={`auto-patch-production-status ${presentation.tone}`}
      role="status"
      aria-live="polite"
      aria-label={presentation.statusLabel}
    >
      <span className="auto-patch-production-led" aria-hidden="true" />
      <div className="auto-patch-production-copy">
        <span>Production Auto Patch</span>
        <strong>{presentation.statusLabel}</strong>
        <p>{state.message}</p>
      </div>
      <div className="auto-patch-production-meter" aria-label="Stage progress">
        <strong>{presentation.meterLabel}</strong>
        <small>
          {state.activeStageId
            ? `STAGE ${state.activeStageId}`
            : state.runId
              ? `RUN ${state.runId}`
              : 'PROJECT UNSAVED'}
        </small>
      </div>
      {presentation.canCancel && (
        <button
          type="button"
          className="auto-patch-production-action cancel"
          onClick={onCancel}
        >
          CANCEL
        </button>
      )}
      {presentation.canDismiss && (
        <button
          type="button"
          className="auto-patch-production-action dismiss"
          onClick={onDismiss}
        >
          DISMISS
        </button>
      )}
    </section>
  );
}

function EngineProductionLock({
  connection,
  message,
  onBrowserSave,
  onDownloadProject,
}: {
  connection: LocalEngineConnectionState;
  message: string;
  onBrowserSave: () => boolean;
  onDownloadProject: () => void;
}) {
  const [browserSaveFeedback, setBrowserSaveFeedback] =
    useState<TransientButtonFeedback>('idle');
  const [copyCommandFeedback, setCopyCommandFeedback] =
    useState<TransientButtonFeedback>('idle');
  const browserSaveFeedbackTimerRef = useRef<number>();
  const copyCommandFeedbackTimerRef = useRef<number>();
  const title =
    connection.lifecycle === 'VERSION_MISMATCH'
      ? 'LOCAL ENGINE VERSION MISMATCH'
      : `LOCAL ENGINE ${connection.lifecycle}`;
  const launchGuidance =
    connection.lifecycle === 'STARTING'
      ? 'Health Check is running. Production controls will unlock automatically.'
      : 'Restart ElpisDAW and its visible Engine console with pnpm launch.';
  const showRestartCommand = connection.lifecycle !== 'STARTING';

  useEffect(() => {
    return () => {
      if (browserSaveFeedbackTimerRef.current !== undefined) {
        window.clearTimeout(browserSaveFeedbackTimerRef.current);
      }

      if (copyCommandFeedbackTimerRef.current !== undefined) {
        window.clearTimeout(copyCommandFeedbackTimerRef.current);
      }
    };
  }, []);

  const handleBrowserSaveClick = () => {
    setBrowserSaveFeedback(onBrowserSave() ? 'success' : 'error');

    if (browserSaveFeedbackTimerRef.current !== undefined) {
      window.clearTimeout(browserSaveFeedbackTimerRef.current);
    }

    browserSaveFeedbackTimerRef.current = window.setTimeout(() => {
      setBrowserSaveFeedback('idle');
      browserSaveFeedbackTimerRef.current = undefined;
    }, 1_000);
  };

  const handleCopyLaunchCommand = async () => {
    let nextFeedback: TransientButtonFeedback = 'success';

    try {
      await navigator.clipboard.writeText('pnpm launch');
    } catch {
      nextFeedback = 'error';
    }

    setCopyCommandFeedback(nextFeedback);

    if (copyCommandFeedbackTimerRef.current !== undefined) {
      window.clearTimeout(copyCommandFeedbackTimerRef.current);
    }

    copyCommandFeedbackTimerRef.current = window.setTimeout(() => {
      setCopyCommandFeedback('idle');
      copyCommandFeedbackTimerRef.current = undefined;
    }, 1_000);
  };

  const browserSaveButtonLabel =
    browserSaveFeedback === 'success'
      ? 'SAVED'
      : browserSaveFeedback === 'error'
        ? 'ERROR'
        : 'BROWSER SAVE';
  const copyCommandButtonLabel =
    copyCommandFeedback === 'success'
      ? 'COPIED'
      : copyCommandFeedback === 'error'
        ? 'ERROR'
        : 'COPY COMMAND';

  return (
    <section
      className={`engine-production-lock ${connection.lifecycle.toLowerCase().replace('_', '-')}`}
      data-engine-lock-state={connection.lifecycle}
      role="alert"
      aria-live="assertive"
    >
      <span className="engine-production-lock-led" aria-hidden="true" />
      <div className="engine-production-lock-copy">
        <span>Production Read Only</span>
        <strong>{title}</strong>
        <p>{message}</p>
        <small>{connection.message}</small>
      </div>
      <div className="engine-production-lock-guidance">
        <span>{launchGuidance}</span>
        {showRestartCommand && (
          <>
            <strong>RUN IN POWERSHELL</strong>
            <div className="engine-production-lock-command">
              <code>pnpm launch</code>
              <button
                type="button"
                className={copyCommandFeedback}
                aria-live="polite"
                onClick={() => void handleCopyLaunchCommand()}
              >
                {copyCommandButtonLabel}
              </button>
            </div>
          </>
        )}
        <small>Heartbeat reconnects automatically. Project data remains preserved.</small>
      </div>
      <div className="engine-production-lock-actions" aria-label="Emergency save actions">
        <button type="button" onClick={onDownloadProject}>
          SAVE PROJECT
        </button>
        <button
          type="button"
          className={`engine-browser-save-button ${browserSaveFeedback}`}
          aria-live="polite"
          onClick={handleBrowserSaveClick}
        >
          {browserSaveButtonLabel}
        </button>
      </div>
    </section>
  );
}

function createProjectRootUiState(projectRoot: LocalEngineProjectRoot): ProjectRootUiState {
  if (projectRoot.status === 'READY') {
    return { projectRoot, status: 'READY' };
  }

  return projectRoot.recoveryIssue
    ? { message: projectRoot.recoveryIssue, status: 'ERROR' }
    : { status: 'UNSET' };
}

function formatProjectFileSaveMenuStatus(
  state: ProjectFileSaveUiState,
  hasUnsavedChanges: boolean,
  isOverwriteProtected: boolean,
  projectRootState: ProjectRootUiState,
): string {
  if (projectRootState.status !== 'READY') {
    return 'NO ROOT';
  }

  if (isOverwriteProtected) {
    return 'LOAD FIRST';
  }

  if (state.status === 'SAVING') {
    return 'WRITING';
  }

  if (state.status === 'ERROR') {
    return 'RETRY';
  }

  if (hasUnsavedChanges) {
    return 'UNSAVED';
  }

  return state.status === 'SAVED' ? 'SAVED' : 'READY';
}

function createProjectFileSaveHelpMessage(
  state: ProjectFileSaveUiState,
  isOverwriteProtected: boolean,
  projectRootState: ProjectRootUiState,
): string {
  if (projectRootState.status !== 'READY') {
    return 'Select a Project Root before saving Project JSON through the Local Engine.';
  }

  if (isOverwriteProtected) {
    return 'This Root already contains Project JSON. Load that Project before overwriting it.';
  }

  if (state.status === 'SAVING') {
    return `Writing ${projectRootState.projectRoot.projectFileName} through temporary-file and atomic replacement.`;
  }

  if (state.status === 'ERROR') {
    return `${state.message} The previous Project JSON remains preserved.`;
  }

  return `Save ${projectRootState.projectRoot.projectFileName} atomically under the selected Project Root.`;
}

function formatProjectFileSaveResult(state: ProjectFileSaveUiState): string | undefined {
  if (state.status === 'SAVED') {
    return `Saved ${state.savedProject.projectFileName} · ${state.savedProject.bytesWritten} bytes`;
  }

  return state.status === 'ERROR' ? state.message : undefined;
}

function formatProjectRootMenuStatus(state: ProjectRootUiState): string {
  switch (state.status) {
    case 'READY':
      return 'SET';
    case 'UNSET':
      return 'SELECT';
    case 'SELECTING':
      return 'OPEN';
    case 'LOADING':
      return 'CHECK';
    case 'ERROR':
      return 'RETRY';
    default:
      return 'OFFLINE';
  }
}

function formatProjectRootPath(state: ProjectRootUiState): string {
  switch (state.status) {
    case 'READY':
      return `${state.projectRoot.rootPath} · Project JSON ${state.projectRoot.projectFile.status}`;
    case 'UNSET':
      return 'No Project Root selected.';
    case 'SELECTING':
      return 'Windows folder selection is open.';
    case 'LOADING':
      return 'Reading Project Root from Local Engine.';
    case 'ERROR':
      return state.message;
    default:
      return 'Local Engine connection required.';
  }
}

function createProjectRootHelpMessage(state: ProjectRootUiState): string {
  return state.status === 'READY'
    ? `Project Root: ${state.projectRoot.rootPath}. Choose another Windows directory.`
    : state.status === 'UNSET'
      ? 'Choose one Windows directory for Project JSON and all ElpisDAW-generated files.'
      : state.status === 'ERROR'
        ? `${state.message} Try Project Root selection again.`
        : formatProjectRootPath(state);
}

function AppHeader({
  canOpenProjectFromRoot,
  canSaveProjectToRoot,
  canSelectProjectRoot,
  canRedo,
  canUndo,
  dirtyState,
  engineConnection,
  generationProgress,
  hasUnsavedChanges,
  helpMessage,
  importError,
  isMenuOpen,
  isProjectRootProjectOpenInProgress,
  isProductionEditingLocked,
  isProjectRootOverwriteProtected,
  isSafetyModeEnabled,
  onBrowserRestore,
  onBrowserSave,
  onCloseMenu,
  onDownloadProject,
  onOpenFinalFiler,
  onOpenProjectFromRoot,
  onLoadProject,
  onRedo,
  onResetWorkspace,
  onSaveProjectToRoot,
  onSelectProjectRoot,
  onToggleInspector,
  onToggleMenu,
  onTogglePresetDrawer,
  onToggleSafetyMode,
  onToggleTakeHistory,
  onUndo,
  projectFileSaveState,
  projectRootState,
}: {
  canOpenProjectFromRoot: boolean;
  canSaveProjectToRoot: boolean;
  canSelectProjectRoot: boolean;
  canRedo: boolean;
  canUndo: boolean;
  dirtyState: DirtyState;
  engineConnection: LocalEngineConnectionState;
  generationProgress?: GenerationHeaderProgress;
  hasUnsavedChanges: boolean;
  helpMessage: string;
  importError?: string;
  isMenuOpen: boolean;
  isProjectRootProjectOpenInProgress: boolean;
  isProductionEditingLocked: boolean;
  isProjectRootOverwriteProtected: boolean;
  isSafetyModeEnabled: boolean;
  onBrowserRestore: () => void;
  onBrowserSave: () => void;
  onCloseMenu: () => void;
  onDownloadProject: () => void;
  onOpenFinalFiler: () => void;
  onOpenProjectFromRoot: () => void;
  onLoadProject: () => void;
  onRedo: () => void;
  onResetWorkspace: () => void;
  onSaveProjectToRoot: () => void;
  onSelectProjectRoot: () => void;
  onToggleInspector: () => void;
  onToggleMenu: () => void;
  onTogglePresetDrawer: () => void;
  onToggleSafetyMode: () => void;
  onToggleTakeHistory: () => void;
  onUndo: () => void;
  projectFileSaveState: ProjectFileSaveUiState;
  projectRootState: ProjectRootUiState;
}) {
  const headerMenuRef = useRef<HTMLDivElement>(null);
  const helpMessageRef = useRef<HTMLElement>(null);
  const helpMessageTextRef = useRef<HTMLSpanElement>(null);
  const [helpScrollDistance, setHelpScrollDistance] = useState(0);
  const [playbackTraceLabel, setPlaybackTraceLabel] = useState('TRACE');
  const playbackTraceResetTimeoutRef = useRef<number>();
  const projectFileSaveResult = formatProjectFileSaveResult(projectFileSaveState);
  const headerMessage = generationProgress?.message ?? helpMessage;
  const shouldConfirmReset = isSafetyModeEnabled && hasUnsavedChanges;
  const shouldConfirmOverwrite = isSafetyModeEnabled && hasUnsavedChanges;

  useEffect(() => {
    return () => {
      if (playbackTraceResetTimeoutRef.current !== undefined) {
        window.clearTimeout(playbackTraceResetTimeoutRef.current);
      }
    };
  }, []);

  const handleDownloadPlaybackTrace = () => {
    const result = downloadProjectPlaybackDiagnostics();

    setPlaybackTraceLabel(result.ok ? 'SAVED' : 'ERROR');
    if (playbackTraceResetTimeoutRef.current !== undefined) {
      window.clearTimeout(playbackTraceResetTimeoutRef.current);
    }
    playbackTraceResetTimeoutRef.current = window.setTimeout(() => {
      setPlaybackTraceLabel('TRACE');
      playbackTraceResetTimeoutRef.current = undefined;
    }, 1800);
  };

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && headerMenuRef.current?.contains(event.target)) {
        return;
      }

      onCloseMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditingText =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (event.key === 'Escape' && !isEditingText) {
        onCloseMenu();
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen, onCloseMenu]);

  useEffect(() => {
    const measureHelpOverflow = () => {
      const messageElement = helpMessageRef.current;
      const textElement = helpMessageTextRef.current;

      if (!messageElement || !textElement) {
        setHelpScrollDistance(0);
        return;
      }

      setHelpScrollDistance(Math.max(0, Math.ceil(textElement.scrollWidth - messageElement.clientWidth)));
    };

    setHelpScrollDistance(0);

    const animationFrame = window.requestAnimationFrame(measureHelpOverflow);
    window.addEventListener('resize', measureHelpOverflow);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', measureHelpOverflow);
    };
  }, [headerMessage]);

  return (
    <header className="app-header">
      <div className="brand-block">
        <span className="brand-led" aria-hidden="true" />
        <div className="brand-title-row">
          <h1>
            ElpisDAW <span className="brand-version">V0.1</span>
          </h1>
          <HelpHint text="Download the current Playback diagnostic trace as JSON. Audio content and Project files are not included.">
            <button
              aria-label="Download Playback diagnostic trace"
              className={`playback-trace-button ${playbackTraceLabel.toLowerCase()}`}
              type="button"
              onClick={handleDownloadPlaybackTrace}
            >
              {playbackTraceLabel}
            </button>
          </HelpHint>
        </div>
      </div>
      <div
        className={`header-help-indicator ${generationProgress ? 'progress-active' : ''} ${generationProgress?.isStale ? 'progress-stale' : ''}`}
        role="status"
        aria-live="polite"
      >
        <span>{generationProgress ? 'Progress' : 'Help'}</span>
        <strong
          ref={helpMessageRef}
          className={`header-help-message ${helpScrollDistance > 0 ? 'scrolling' : ''}`}
          style={{ '--help-scroll-distance': `${helpScrollDistance}px` } as CSSProperties}
          aria-label={headerMessage}
        >
          <span key={headerMessage} ref={helpMessageTextRef}>
            {headerMessage}
          </span>
        </strong>
        {generationProgress && (
          <div
            className={`header-generation-progress ${generationProgress.isStale ? 'stale' : ''}`}
            role="progressbar"
            aria-label="AI generation stage progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={generationProgress.percent}
            aria-valuetext={generationProgress.accessiblePhaseLabel}
          >
            <span
              className="header-generation-progress-fill"
              style={{ width: `${generationProgress.percent}%` }}
            />
            <small aria-hidden="true">{generationProgress.phaseLabel}</small>
          </div>
        )}
      </div>
      <div className="header-actions">
        <EngineStatusIndicator connection={engineConnection} />
        <DirtyStateIndicator dirtyState={dirtyState} />
        <div ref={headerMenuRef} className="header-menu">
          <HelpHint text="Open project, Project Root, presets, safety mode, undo, and redo commands.">
            <button
              type="button"
              className={`menu-trigger ${isMenuOpen ? 'active' : ''}`}
              aria-expanded={isMenuOpen}
              aria-label="Open app menu"
              onClick={onToggleMenu}
            >
              <span className="menu-icon" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </button>
          </HelpHint>
          {isMenuOpen && (
            <div className="app-menu" role="menu">
              <button
                type="button"
                className="menu-command final-filer-menu-command"
                {...getHelpPreviewProps('Open final WAV delivery for one registered Raw Mixdown or Stable Audio 3 Master Clip.')}
                onClick={onOpenFinalFiler}
              >
                FINAL FILER <small>DELIVER</small>
              </button>
              <span className="menu-separator" role="separator" />
              {isProductionEditingLocked && (
                <span className="menu-section-label engine-read-only-label">Engine Read Only</span>
              )}
              <span className="menu-section-label">Project</span>
              <button
                type="button"
                className="menu-command"
                {...getHelpPreviewProps('Download the current ElpisDAW workspace as a project JSON file.')}
                onClick={onDownloadProject}
              >
                Export Project JSON <small>FILE</small>
              </button>
              <button
                type="button"
                className={`menu-command ${shouldConfirmOverwrite ? 'needs-confirmation' : ''}`}
                disabled={isProductionEditingLocked}
                {...getHelpPreviewProps('Choose a project JSON file and replace the current workspace.')}
                onClick={onLoadProject}
              >
                Load Project <small>{shouldConfirmOverwrite ? '2 STEP' : 'FILE'}</small>
              </button>
              <button
                type="button"
                className="menu-command"
                aria-keyshortcuts="Control+S Meta+S"
                {...getHelpPreviewProps('Save the current workspace into this browser on this computer. Shortcut: Ctrl+S.')}
                onClick={onBrowserSave}
              >
                Browser Save <small>LOCAL</small>
              </button>
              <button
                type="button"
                className={`menu-command ${shouldConfirmOverwrite ? 'needs-confirmation' : ''}`}
                disabled={isProductionEditingLocked}
                {...getHelpPreviewProps('Restore the workspace from this browser save. Unsaved changes may be overwritten.')}
                onClick={onBrowserRestore}
              >
                Browser Restore <small>{shouldConfirmOverwrite ? '2 STEP' : 'LOCAL'}</small>
              </button>
              <span className="menu-section-label">Storage</span>
              <button
                type="button"
                className="menu-command project-root-command"
                disabled={!canSelectProjectRoot}
                {...getHelpPreviewProps(createProjectRootHelpMessage(projectRootState))}
                onClick={onSelectProjectRoot}
              >
                Project Root <small>{formatProjectRootMenuStatus(projectRootState)}</small>
              </button>
              <span className={`menu-project-root-path ${projectRootState.status.toLowerCase()}`}>
                {formatProjectRootPath(projectRootState)}
              </span>
              <button
                type="button"
                className="menu-command project-file-open-command"
                disabled={!canOpenProjectFromRoot}
                {...getHelpPreviewProps(
                  projectRootState.status !== 'READY'
                    ? 'Select a ready Project Root before opening its Project JSON.'
                    : projectRootState.projectRoot.projectFile.status !== 'EXISTS'
                      ? 'The selected Project Root does not contain Project JSON yet.'
                      : `Open ${projectRootState.projectRoot.projectFileName} through the Local Engine and authorize later saves only for this exact Root.`,
                )}
                onClick={onOpenProjectFromRoot}
              >
                Open from Root{' '}
                <small>
                  {isProjectRootProjectOpenInProgress
                    ? 'OPENING'
                    : isProjectRootOverwriteProtected
                      ? 'REQUIRED'
                      : projectRootState.status === 'READY' &&
                          projectRootState.projectRoot.projectFile.status === 'EXISTS'
                        ? 'READY'
                        : 'NO FILE'}
                </small>
              </button>
              <button
                type="button"
                className={`menu-command project-file-save-command ${projectFileSaveState.status.toLowerCase()}`}
                disabled={!canSaveProjectToRoot}
                {...getHelpPreviewProps(
                  createProjectFileSaveHelpMessage(
                    projectFileSaveState,
                    isProjectRootOverwriteProtected,
                    projectRootState,
                  ),
                )}
                onClick={onSaveProjectToRoot}
              >
                Save to Root{' '}
                <small>
                  {formatProjectFileSaveMenuStatus(
                    projectFileSaveState,
                    hasUnsavedChanges,
                    isProjectRootOverwriteProtected,
                    projectRootState,
                  )}
                </small>
              </button>
              {projectFileSaveResult && (
                <span className={`menu-project-save-result ${projectFileSaveState.status.toLowerCase()}`}>
                  {projectFileSaveResult}
                </span>
              )}
              <span className="menu-section-label">Workspace</span>
              <button
                type="button"
                className="menu-command"
                disabled={isProductionEditingLocked}
                {...getHelpPreviewProps('Open prepared TabFlow workflows.')}
                onClick={onTogglePresetDrawer}
              >
                Presets <small>FLOW</small>
              </button>
              <button
                type="button"
                className="menu-command"
                disabled={isProductionEditingLocked}
                {...getHelpPreviewProps('Open project health, routing, selection, and workspace diagnostics.')}
                onClick={onToggleInspector}
              >
                Project Inspector <small>INFO</small>
              </button>
              <span className="menu-section-label">Safety</span>
              <button
                type="button"
                className={`menu-command safety-toggle ${isSafetyModeEnabled ? 'active' : ''}`}
                aria-pressed={isSafetyModeEnabled}
                disabled={isProductionEditingLocked}
                {...getHelpPreviewProps('Toggle confirmation prompts for destructive or overwrite actions.')}
                onClick={onToggleSafetyMode}
              >
                Safety Mode <small>{isSafetyModeEnabled ? 'ON' : 'OFF'}</small>
              </button>
              <button
                type="button"
                className={`menu-command warning ${shouldConfirmReset ? 'needs-confirmation' : ''}`}
                disabled={isProductionEditingLocked}
                {...getHelpPreviewProps('Reset ElpisDAW to the starter workspace. Safety Mode protects unsaved changes.')}
                onClick={onResetWorkspace}
              >
                Reset Workspace <small>{shouldConfirmReset ? '2 STEP' : 'INIT'}</small>
              </button>
              <span className="menu-section-label">History</span>
              <button
                type="button"
                className="menu-command"
                disabled={isProductionEditingLocked}
                {...getHelpPreviewProps('Open Edit History and Auto Patch History beside the Timeline.')}
                onClick={onToggleTakeHistory}
              >
                History <small>EDIT</small>
              </button>
              <button
                type="button"
                className="menu-command"
                {...getHelpPreviewProps('Undo the last project-changing action. Selection-only moves are not recorded here.')}
                disabled={isProductionEditingLocked || !canUndo}
                onClick={onUndo}
              >
                Undo <small>CTRL Z</small>
              </button>
              <button
                type="button"
                className="menu-command"
                {...getHelpPreviewProps('Redo the last undone project-changing action.')}
                disabled={isProductionEditingLocked || !canRedo}
                onClick={onRedo}
              >
                Redo <small>CTRL Y</small>
              </button>
              {importError && <span className="menu-section-label">{importError}</span>}
              <div className="menu-shortcuts" aria-hidden="true">
                <span className={!isProductionEditingLocked && canUndo ? 'ready' : ''}>Undo</span>
                <span className={!isProductionEditingLocked && canRedo ? 'ready' : ''}>Redo</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function EngineStatusIndicator({ connection }: { connection: LocalEngineConnectionState }) {
  const tone =
    connection.lifecycle === 'READY'
      ? connection.activity === 'BUSY'
        ? 'busy'
        : 'ready'
      : connection.lifecycle === 'STARTING' || connection.lifecycle === 'STOPPING'
        ? 'starting'
        : 'unavailable';
  const label =
    connection.lifecycle === 'VERSION_MISMATCH'
      ? 'ENGINE VERSION'
      : `ENGINE ${connection.lifecycle}`;
  const detail =
    connection.lifecycle === 'READY'
      ? connection.activity
      : connection.lifecycle === 'VERSION_MISMATCH'
        ? 'MISMATCH'
        : connection.lifecycle === 'STARTING'
          ? 'CONNECTING'
          : connection.lifecycle === 'STOPPING'
            ? 'SHUTDOWN'
            : 'CHECK';
  const heartbeatDetail = connection.lastHeartbeatAt
    ? ` Last heartbeat: ${new Date(connection.lastHeartbeatAt).toLocaleTimeString()}.`
    : '';
  const versionDetail = connection.engineVersion ? ` Version: ${connection.engineVersion}.` : '';

  return (
    <div
      className={`engine-status-indicator ${tone}`}
      role="status"
      aria-live="polite"
      title={`${connection.message}${versionDetail}${heartbeatDetail}`}
    >
      <span className="engine-status-led" aria-hidden="true" />
      <strong>{label}</strong>
      <small>{detail}</small>
    </div>
  );
}

function DirtyStateIndicator({ dirtyState }: { dirtyState: DirtyState }) {
  const label =
    dirtyState === 'saved'
      ? 'Saved'
      : dirtyState === 'error'
        ? 'Check'
        : dirtyState === 'warning'
          ? 'Relink'
          : 'Unsaved';
  const detail =
    dirtyState === 'saved'
      ? 'Clean'
      : dirtyState === 'error'
        ? 'Project'
        : dirtyState === 'warning'
          ? 'Source'
          : 'Dirty';

  return (
    <div className={`dirty-state-indicator ${dirtyState}`} role="status" aria-live="polite">
      <span className="dirty-state-led" aria-hidden="true" />
      <strong>{label}</strong>
      <small>{detail}</small>
    </div>
  );
}

function HelpHint({
  children,
  text,
  className,
}: {
  children: ReactNode;
  text: string;
  className?: string;
}) {
  const showHelpPreview = () => emitHeaderHelpPreview(text);

  return (
    <span
      className={`help-hint ${className ?? ''}`}
      onFocus={showHelpPreview}
      onPointerEnter={showHelpPreview}
    >
      {children}
    </span>
  );
}

function emitHeaderHelpPreview(message: string): void {
  window.dispatchEvent(new CustomEvent(headerHelpPreviewEventName, { detail: message }));
}

function getHelpPreviewProps(text: string) {
  return {
    'data-help': text,
    onFocus: () => emitHeaderHelpPreview(text),
    onPointerEnter: () => emitHeaderHelpPreview(text),
  };
}

function PatchTabRack({
  patchTabs,
  selectedPatchTabId,
  onAddPatchTab,
  onMovePatchTab,
  onSelectPatchTab,
}: {
  patchTabs: PatchTab[];
  selectedPatchTabId: string;
  onAddPatchTab: (templateId: string) => void;
  onMovePatchTab: (patchTabId: string, direction: 'up' | 'down') => void;
  onSelectPatchTab: (patchTabId: string) => void;
}) {
  const [selectedTemplateId, setSelectedTemplateId] = useState(patchTabTemplates[0]?.id ?? '');
  const selectedTemplate =
    patchTabTemplates.find((template) => template.id === selectedTemplateId) ??
    patchTabTemplates[0];
  const selectedTemplateAvailability = resolvePatchTabTemplateAvailability(
    selectedTemplate,
  );

  return (
    <section className="panel rack-panel" aria-labelledby="patchtab-rack-heading">
      <PanelHeader eyebrow="PatchTabs" id="patchtab-rack-heading" meter={`${patchTabs.length} slots`} title="Module Rack" />
      <div className="rack-add-row">
        <label>
          <span>Add PatchTab</span>
          <select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}>
            {patchTabTemplates.map((template) => {
              const availability = resolvePatchTabTemplateAvailability(template);

              return (
                <option
                  className={availability.canCreate ? undefined : 'patchtab-template-deferred'}
                  disabled={!availability.canCreate}
                  key={template.id}
                  value={template.id}
                >
                  {availability.label}
                </option>
              );
            })}
          </select>
        </label>
        <button
          type="button"
          className="rack-add-button"
          disabled={!selectedTemplateAvailability.canCreate}
          title={selectedTemplateAvailability.message}
          onClick={() => onAddPatchTab(selectedTemplateId)}
        >
          ADD
        </button>
      </div>
      <div className="patchtab-list">
        {patchTabs.map((patchTab, index) => (
          <PatchTabCard
            key={patchTab.id}
            colorCode={getPatchTabColorCode(patchTab.colorIndex)}
            isSelected={selectedPatchTabId === patchTab.id}
            patchTab={patchTab}
            position={index}
            totalPatchTabs={patchTabs.length}
            onMovePatchTab={onMovePatchTab}
            onSelectPatchTab={onSelectPatchTab}
          />
        ))}
      </div>
    </section>
  );
}

function PatchTabCard({
  colorCode,
  isSelected,
  patchTab,
  position,
  totalPatchTabs,
  onMovePatchTab,
  onSelectPatchTab,
}: {
  colorCode: ReturnType<typeof getPatchTabColorCode>;
  isSelected: boolean;
  patchTab: PatchTab;
  position: number;
  totalPatchTabs: number;
  onMovePatchTab: (patchTabId: string, direction: 'up' | 'down') => void;
  onSelectPatchTab: (patchTabId: string) => void;
}) {
  const style = {
    '--tab-color': colorCode.primaryColor,
    '--tab-color-secondary': colorCode.secondaryColor,
  } as CSSProperties;

  return (
    <div className={`patchtab-card ${isSelected ? 'selected' : ''} ${colorCode.isMultiColor ? 'multi-color' : ''}`} style={style}>
      <button className="patchtab-select" type="button" onClick={() => onSelectPatchTab(patchTab.id)}>
        <span className="patchtab-main">
          <strong>{patchTab.name}</strong>
          <small>
            {patchTab.inputType} to {patchTab.outputType}
          </small>
        </span>
        <span className="patchtab-meta">
          <span className="patchtab-status">{patchTab.status}</span>
        </span>
      </button>
      <div className="patchtab-order-controls" aria-label={`${patchTab.name} order controls`}>
        <button
          type="button"
          className="patchtab-order-button"
          disabled={position === 0}
          aria-label={`Move ${patchTab.name} up`}
          onClick={() => onMovePatchTab(patchTab.id, 'up')}
        >
          ^
        </button>
        <button
          type="button"
          className="patchtab-order-button"
          disabled={position === totalPatchTabs - 1}
          aria-label={`Move ${patchTab.name} down`}
          onClick={() => onMovePatchTab(patchTab.id, 'down')}
        >
          v
        </button>
      </div>
    </div>
  );
}

function PatchTabDetails({
  aceStepState,
  aceStepCoverState,
  aceStepTextToMusicState,
  autoPatchProductionState,
  basicPitchHumToMidiState,
  basicPitchRuntimeState,
  colorCode,
  engineAcceptsNewJobs,
  engineAvailabilityMessage,
  engineIsReady,
  instrumentRenderState,
  isProjectRootReady,
  patchTab,
  patchTabs,
  pendingPortSelection,
  project,
  projectMixdownState,
  printMixState,
  selectedClipInfo,
  selectedMidiNoteCount,
  soundFontCatalogState,
  stableAudio3TextToAudioState,
  onCancelAceStepVocal,
  onCancelAceStepCover,
  onCancelAceStepTextToMusic,
  onCancelStableAudio3TextToAudio,
  onCancelBasicPitchHumToMidi,
  onCancelProjectMixdown,
  onCancelPrintMix,
  onClearPatchPortSelection,
  onConnectPatchTabs,
  onDeletePatchTab,
  onGenerateStableAudio3TextToAudio,
  onGenerateStableAudio3AudioToAudio,
  onGenerateAceStepVocal,
  onGenerateAceStepCover,
  onGenerateAceStepTextToMusic,
  onListSoundFontPresets,
  onParameterChange,
  onParameterChanges,
  onPatchPortClick,
  onRenderInstrument,
  onRefreshSoundFonts,
  onRecoverProjectMixdown,
  onRecoverBasicPitchHumToMidi,
  onRecoverPrintMix,
  onRenamePatchTab,
  onRunProjectMixdown,
  onRetryBasicPitchHumToMidi,
  onRunBasicPitchHumToMidi,
  onRunPrintMix,
  onSaveProjectMixdownWav,
}: {
  aceStepState: AceStepUiState;
  aceStepCoverState: AceStepCoverUiState;
  aceStepTextToMusicState: AceStepTextToMusicUiState;
  autoPatchProductionState: AutoPatchProductionUiState;
  basicPitchHumToMidiState: BasicPitchHumToMidiUiState;
  basicPitchRuntimeState: BasicPitchRuntimeUiState;
  colorCode?: ReturnType<typeof getPatchTabColorCode>;
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  engineIsReady: boolean;
  instrumentRenderState: InstrumentRenderUiState;
  isProjectRootReady: boolean;
  patchTab?: PatchTab;
  patchTabs: PatchTab[];
  pendingPortSelection?: PatchPortSelection;
  project: ProjectState;
  projectMixdownState: ProjectMixdownUiState;
  printMixState: PrintMixUiState;
  selectedClipInfo?: SelectedClipInfo;
  selectedMidiNoteCount?: number;
  soundFontCatalogState: PianoRollSoundFontCatalogState;
  stableAudio3TextToAudioState: StableAudio3TextToAudioUiState;
  onCancelAceStepVocal: (patchTabId: string) => void;
  onCancelAceStepCover: (patchTabId: string) => void;
  onCancelAceStepTextToMusic: (patchTabId: string) => void;
  onCancelStableAudio3TextToAudio: (patchTabId: string) => void;
  onCancelBasicPitchHumToMidi: () => void;
  onCancelProjectMixdown: (patchTabId: string) => void;
  onCancelPrintMix: () => void;
  onClearPatchPortSelection: () => void;
  onConnectPatchTabs: (
    fromPatchTabId: string,
    toPatchTabId: string,
    fromPortId?: string,
    toPortId?: string,
  ) => void;
  onDeletePatchTab: (patchTabId: string) => void;
  onGenerateStableAudio3TextToAudio: (patchTabId: string) => void;
  onGenerateStableAudio3AudioToAudio: (patchTabId: string) => void;
  onGenerateAceStepVocal: (patchTabId: string) => void;
  onGenerateAceStepCover: (patchTabId: string) => void;
  onGenerateAceStepTextToMusic: (patchTabId: string) => void;
  onListSoundFontPresets: (
    resource: LocalEngineSoundFontResource,
  ) => Promise<LocalEngineSoundFontPresetCatalogResult>;
  onParameterChange: (patchTabId: string, parameterId: string, value: PatchTabParameterValue) => void;
  onParameterChanges: (
    patchTabId: string,
    updates: readonly Readonly<{
      parameterId: string;
      value: PatchTabParameterValue;
    }>[],
  ) => void;
  onPatchPortClick: (patchTabId: string, direction: PatchPortDirection, portId?: string) => void;
  onRenderInstrument: (patchTabId: string) => void;
  onRefreshSoundFonts: () => void;
  onRecoverProjectMixdown: (patchTabId: string) => void;
  onRecoverBasicPitchHumToMidi: (patchTabId: string) => void;
  onRecoverPrintMix: (patchTabId: string) => void;
  onRenamePatchTab: (patchTabId: string, name: string) => void;
  onRunProjectMixdown: (patchTabId: string) => void;
  onRetryBasicPitchHumToMidi: (patchTabId: string) => void;
  onRunBasicPitchHumToMidi: (patchTabId: string) => void;
  onRunPrintMix: (patchTabId: string) => void;
  onSaveProjectMixdownWav: (patchTabId: string) => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(patchTab?.name ?? '');
  const [activePortDirection, setActivePortDirection] = useState<PatchPortDirection>();

  useEffect(() => {
    setIsRenaming(false);
    setDraftName(patchTab?.name ?? '');
    setActivePortDirection(undefined);
  }, [patchTab?.id, patchTab?.name]);

  if (!patchTab) {
    return (
      <section className="panel detail-panel" aria-labelledby="selected-patchtab-heading">
        <PanelHeader id="selected-patchtab-heading" meter="empty" reserveEyebrowSpace title="No PatchTab" />
        <div className="empty-panel">
          <strong>No PatchTab selected</strong>
          <span>Add a PatchTab from the Module Rack to rebuild the TabFlow.</span>
        </div>
      </section>
    );
  }

  const style = colorCode
    ? ({
        '--detail-color': colorCode.primaryColor,
        '--detail-secondary-color': colorCode.secondaryColor,
      } as CSSProperties)
    : undefined;
  const otherPatchTabs = patchTabs.filter((candidate) => candidate.id !== patchTab.id);
  const inputPorts = getPatchTabInputOptions(patchTab);
  const outputPorts = getPatchTabOutputOptions(patchTab);
  const sourcePortOptions = otherPatchTabs.flatMap(getPatchTabOutputOptions);
  const targetPortOptions = otherPatchTabs.flatMap(getPatchTabInputOptions);
  const selectedType = selectedClipInfo?.clip.type;
  const canRenderInstrument =
    patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.instrument;
  const canManageSoundFont =
    patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.soundFont;
  const canGenerateStableAudio3AudioToAudio =
    patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3;
  const canGenerateStableAudio3TextToAudio =
    isStableAudio3TextToAudioPatchTab(patchTab);
  const canGenerateAceStepTextToMusic = isAceStepTextToMusicPatchTab(patchTab);
  const canGenerateAceStepCover = isAceStepCoverPatchTab(patchTab);
  const canGenerateAceStepVocal = isAceStepPatchTab(patchTab);
  const canManageBasicPitchHumToMidi =
    patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi;
  const canManageProjectMixdown =
    patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler;
  const canManagePrintMix = isPrintMixPatchTab(patchTab);
  const midiToAudioSourceReady =
    selectedType === 'edited-midi' || selectedType === 'midi-notes';
  const midiToAudioNotesReady = selectedMidiNoteCount !== 0;
  const instrumentSoundFontResolution =
    canRenderInstrument && soundFontCatalogState.status === 'READY'
      ? resolveInstrumentSoundFont(
          patchTabs,
          project.connections,
          patchTab.id,
          selectedClipInfo?.clip.soundFont,
          soundFontCatalogState.catalog.resources,
        )
      : undefined;
  const soundFontReady = instrumentSoundFontResolution?.canResolve === true;
  const builtinInstrumentSoundFont =
    canRenderInstrument && soundFontCatalogState.status === 'READY'
      ? soundFontCatalogState.catalog.resources.find(
          (resource) =>
            resource.library === 'builtin' &&
            resource.relativePath ===
              HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH,
        )
      : undefined;
  const instrumentRenderInProgress =
    instrumentRenderState.status === 'ENQUEUEING' ||
    instrumentRenderState.status === 'QUEUED' ||
    instrumentRenderState.status === 'LOADING_MODEL' ||
    instrumentRenderState.status === 'PROCESSING' ||
    instrumentRenderState.status === 'SAVING' ||
    instrumentRenderState.status === 'CANCEL_REQUESTED';
  const instrumentRenderReady =
    midiToAudioSourceReady &&
    midiToAudioNotesReady &&
    soundFontReady &&
    !instrumentRenderInProgress;
  const stableAudio3AudioToAudioPresentation =
    createStableAudio3AudioToAudioUiPresentation({
      autoPatchState: autoPatchProductionState,
      engineAcceptsNewJobs,
      engineAvailabilityMessage,
      isProjectRootReady,
      ...(selectedClipInfo
        ? {
            source: {
              name: selectedClipInfo.clip.name,
              type: selectedClipInfo.clip.type,
            },
          }
        : {}),
    });
  const portStatus = activePortDirection ? `SELECT ${activePortDirection === 'input' ? 'SOURCE' : 'DESTINATION'}` : 'PORT IDLE';

  const commitRename = () => {
    const nextName = draftName.trim() || patchTab.name;
    onRenamePatchTab(patchTab.id, nextName);
    setDraftName(nextName);
    setIsRenaming(false);
  };

  const cancelRename = () => {
    setDraftName(patchTab.name);
    setIsRenaming(false);
  };

  return (
    <section
      className={`panel detail-panel ${colorCode?.isMultiColor ? 'detail-panel-multi' : ''}`}
      style={style}
      aria-labelledby="selected-patchtab-heading"
    >
      <div className="detail-color-strip" aria-hidden="true" />
      <PanelHeader
        id="selected-patchtab-heading"
        meter={patchTab.status}
        reserveEyebrowSpace
        title={
          <span className="patchtab-title-editor">
            {isRenaming ? (
              <input
                autoFocus
                className="patchtab-title-input"
                type="text"
                aria-label="Rename PatchTab"
                value={draftName}
                onBlur={commitRename}
                onChange={(event) => setDraftName(event.target.value)}
                onFocus={(event) => event.target.select()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    commitRename();
                  }

                  if (event.key === 'Escape') {
                    cancelRename();
                  }
                }}
              />
            ) : (
              <>
                <span className="patchtab-title-text">{patchTab.name}</span>
                <HelpHint text={`Rename ${patchTab.name}. Press Enter to commit or Escape to cancel.`}>
                  <button
                    type="button"
                    className="rename-patchtab-button"
                    aria-label={`Rename ${patchTab.name}`}
                    onClick={() => setIsRenaming(true)}
                  >
                  🖊
                  </button>
                </HelpHint>
              </>
            )}
          </span>
        }
        actions={
          <HelpHint text={`Delete ${patchTab.name}. Connected TabFlow routes and downstream routes are cleaned up with Safety Mode confirmation.`}>
            <button
              type="button"
              className="delete-patchtab-button"
              aria-label={`Delete ${patchTab.name}`}
              onClick={() => onDeletePatchTab(patchTab.id)}
            >
              <span className="trash-icon" aria-hidden="true" />
            </button>
          </HelpHint>
        }
      />
      <p className="patchtab-description">{patchTab.description}</p>
      <div className="io-grid">
        <div className="io-port-stack input">
          {inputPorts.map((inputPort) => {
            const isArmed =
              pendingPortSelection?.patchTabId === patchTab.id &&
              pendingPortSelection.direction === 'input' &&
              pendingPortSelection.portId === inputPort.portId;

            return (
              <label
                key={inputPort.portId}
                className={`io-port input ${isArmed ? 'armed' : ''}`}
                onMouseDown={() => {
                  onPatchPortClick(patchTab.id, 'input', inputPort.portId);
                  setActivePortDirection('input');
                }}
              >
                <span>{inputPorts.length > 1 ? `Input / ${inputPort.portLabel}` : 'Input'}</span>
                <strong>{inputPort.dataCategory.toUpperCase()}</strong>
                <select
                  className="io-port-select"
                  aria-label={`Connect ${patchTab.name} ${inputPort.portLabel} input from`}
                  value=""
                  onBlur={() => {
                    setActivePortDirection(undefined);
                    onClearPatchPortSelection();
                  }}
                  onChange={(event) => {
                    const source = parsePatchPortOptionValue(event.target.value);

                    if (source) {
                      onConnectPatchTabs(
                        source.patchTabId,
                        patchTab.id,
                        source.portId,
                        inputPort.portId,
                      );
                    }
                    setActivePortDirection(undefined);
                  }}
                >
                  <option value="" disabled>
                    Connect input from
                  </option>
                  {sourcePortOptions.map((candidate) => (
                    <option
                      key={`${candidate.patchTabId}:${candidate.portId}`}
                      value={createPatchPortOptionValue(candidate.patchTabId, candidate.portId)}
                    >
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          {inputPorts.length === 0 && <span className="io-port-empty">NO INPUT</span>}
        </div>
        <div className="io-port-stack output">
          {outputPorts.map((outputPort) => {
            const isArmed =
              pendingPortSelection?.patchTabId === patchTab.id &&
              pendingPortSelection.direction === 'output' &&
              pendingPortSelection.portId === outputPort.portId;

            return (
              <label
                key={outputPort.portId}
                className={`io-port output ${isArmed ? 'armed' : ''}`}
                onMouseDown={() => {
                  onPatchPortClick(patchTab.id, 'output', outputPort.portId);
                  setActivePortDirection('output');
                }}
              >
                <span>{outputPorts.length > 1 ? `Output / ${outputPort.portLabel}` : 'Output'}</span>
                <strong>{outputPort.dataCategory.toUpperCase()}</strong>
                <select
                  className="io-port-select"
                  aria-label={`Connect ${patchTab.name} ${outputPort.portLabel} output to`}
                  value=""
                  onBlur={() => {
                    setActivePortDirection(undefined);
                    onClearPatchPortSelection();
                  }}
                  onChange={(event) => {
                    const target = parsePatchPortOptionValue(event.target.value);

                    if (target) {
                      onConnectPatchTabs(
                        patchTab.id,
                        target.patchTabId,
                        outputPort.portId,
                        target.portId,
                      );
                    }
                    setActivePortDirection(undefined);
                  }}
                >
                  <option value="" disabled>
                    Connect output to
                  </option>
                  {targetPortOptions.map((candidate) => (
                    <option
                      key={`${candidate.patchTabId}:${candidate.portId}`}
                      value={createPatchPortOptionValue(candidate.patchTabId, candidate.portId)}
                    >
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          {outputPorts.length === 0 && <span className="io-port-empty">TERMINAL OUTPUT</span>}
        </div>
      </div>
      <div className={`port-status ${pendingPortSelection ? 'armed' : ''}`}>{portStatus}</div>
      {canRenderInstrument && (
        <PatchTabActionCard
          isReady={instrumentRenderReady}
          eyebrow="FluidSynth Render"
          title="Render MIDI to Audio"
          detail={
            instrumentRenderInProgress
              ? `JOB ${instrumentRenderState.status}`
                  : soundFontCatalogState.status !== 'READY'
                  ? 'WAIT FOR SOUNDFONT CATALOG'
                : !midiToAudioSourceReady
                ? 'SELECT MIDI CLIP'
                : !midiToAudioNotesReady
                  ? 'At least one MIDI note is required.'
                  : !soundFontReady
                  ? instrumentSoundFontResolution?.message ?? 'SOUNDFONT UNAVAILABLE'
                  : createClipActionDetail(
                      selectedClipInfo,
                      true,
                      'SELECT MIDI CLIP',
                    )
          }
          buttonLabel={instrumentRenderInProgress ? 'RENDERING' : 'RENDER'}
          onClick={() => onRenderInstrument(patchTab.id)}
        />
      )}
      {canGenerateStableAudio3AudioToAudio && (
        <PatchTabActionCard
          isReady={stableAudio3AudioToAudioPresentation.canRun}
          eyebrow={stableAudio3AudioToAudioPresentation.eyebrow}
          title={stableAudio3AudioToAudioPresentation.title}
          detail={stableAudio3AudioToAudioPresentation.detail}
          buttonLabel={stableAudio3AudioToAudioPresentation.buttonLabel}
          onClick={() =>
            onGenerateStableAudio3AudioToAudio(patchTab.id)
          }
        />
      )}
      {(canGenerateStableAudio3AudioToAudio ||
        canGenerateStableAudio3TextToAudio) && (
        <aside
          className="stable-audio-attribution"
          aria-label="Stable Audio 3 licensing"
        >
          <strong>Powered by Stability AI</strong>
          <span>
            Stable Audio 3 is user-supplied. Separate model terms and use
            restrictions apply. Commercial use requires registration; an
            Enterprise license may be required.
          </span>
          <nav aria-label="Stable Audio 3 legal links">
            <a
              href="https://stability.ai/license"
              target="_blank"
              rel="noreferrer"
            >
              LICENSE
            </a>
            <a
              href="https://stability.ai/community-license"
              target="_blank"
              rel="noreferrer"
            >
              REGISTER
            </a>
            <a
              href="https://stability.ai/use-policy"
              target="_blank"
              rel="noreferrer"
            >
              USE POLICY
            </a>
          </nav>
        </aside>
      )}
      {canRenderInstrument ? (
        <InstrumentPatchTabControls
          activeResolution={instrumentSoundFontResolution}
          catalogState={soundFontCatalogState}
          patchTab={patchTab}
          resource={builtinInstrumentSoundFont}
          onListSoundFontPresets={onListSoundFontPresets}
          onParameterChanges={(updates) =>
            onParameterChanges(patchTab.id, updates)
          }
        />
      ) : canManageSoundFont ? (
        <SoundFontPatchTabControls
          catalogState={soundFontCatalogState}
          patchTab={patchTab}
          onListSoundFontPresets={onListSoundFontPresets}
          onParameterChanges={(updates) =>
            onParameterChanges(patchTab.id, updates)
          }
          onRefresh={onRefreshSoundFonts}
        />
      ) : canGenerateAceStepTextToMusic ? (
        <AceStepTextToMusicControls
          engineAcceptsNewJobs={engineAcceptsNewJobs}
          engineAvailabilityMessage={engineAvailabilityMessage}
          isProjectRootReady={isProjectRootReady}
          patchTab={patchTab}
          project={project}
          state={aceStepTextToMusicState}
          onCancel={() => onCancelAceStepTextToMusic(patchTab.id)}
          onGenerate={() => onGenerateAceStepTextToMusic(patchTab.id)}
          onParameterChange={(parameterId, value) =>
            onParameterChange(patchTab.id, parameterId, value)
          }
        />
      ) : canGenerateAceStepCover ? (
        <AceStepCoverControls
          engineAcceptsNewJobs={engineAcceptsNewJobs}
          engineAvailabilityMessage={engineAvailabilityMessage}
          isProjectRootReady={isProjectRootReady}
          patchTab={patchTab}
          project={project}
          selectedClipId={selectedClipInfo?.clip.id}
          state={aceStepCoverState}
          onCancel={() => onCancelAceStepCover(patchTab.id)}
          onGenerate={() => onGenerateAceStepCover(patchTab.id)}
          onParameterChange={(parameterId, value) =>
            onParameterChange(patchTab.id, parameterId, value)
          }
        />
      ) : canGenerateAceStepVocal ? (
        <AceStepControls
          engineAcceptsNewJobs={engineAcceptsNewJobs}
          engineAvailabilityMessage={engineAvailabilityMessage}
          isProjectRootReady={isProjectRootReady}
          patchTab={patchTab}
          project={project}
          selectedClipId={selectedClipInfo?.clip.id}
          state={aceStepState}
          onCancel={() => onCancelAceStepVocal(patchTab.id)}
          onGenerate={() => onGenerateAceStepVocal(patchTab.id)}
          onParameterChange={(parameterId, value) =>
            onParameterChange(patchTab.id, parameterId, value)
          }
        />
      ) : canGenerateStableAudio3TextToAudio ? (
        <StableAudio3TextToAudioControls
          engineAcceptsNewJobs={engineAcceptsNewJobs}
          engineAvailabilityMessage={engineAvailabilityMessage}
          isProjectRootReady={isProjectRootReady}
          patchTab={patchTab}
          project={project}
          state={stableAudio3TextToAudioState}
          onCancel={() => onCancelStableAudio3TextToAudio(patchTab.id)}
          onGenerate={() => onGenerateStableAudio3TextToAudio(patchTab.id)}
          onParameterChange={(parameterId, value) =>
            onParameterChange(patchTab.id, parameterId, value)
          }
        />
      ) : canManageBasicPitchHumToMidi ? (
        <BasicPitchHumToMidiControls
          basicPitchRuntimeState={basicPitchRuntimeState}
          engineAcceptsNewJobs={engineAcceptsNewJobs}
          engineAvailabilityMessage={engineAvailabilityMessage}
          isProjectRootReady={isProjectRootReady}
          patchTab={patchTab}
          project={project}
          state={basicPitchHumToMidiState}
          onCancel={onCancelBasicPitchHumToMidi}
          onParameterChange={(parameterId, value) =>
            onParameterChange(patchTab.id, parameterId, value)
          }
          onRecover={() => onRecoverBasicPitchHumToMidi(patchTab.id)}
          onRetry={() => onRetryBasicPitchHumToMidi(patchTab.id)}
          onRun={() => onRunBasicPitchHumToMidi(patchTab.id)}
        />
      ) : canManagePrintMix ? (
        <PrintMixControls
          engineAcceptsNewJobs={engineAcceptsNewJobs}
          engineAvailabilityMessage={engineAvailabilityMessage}
          isProjectRootReady={isProjectRootReady}
          patchTab={patchTab}
          project={project}
          state={printMixState}
          onCancel={onCancelPrintMix}
          onParameterChange={(parameterId, value) =>
            onParameterChange(patchTab.id, parameterId, value)
          }
          onRecover={() => onRecoverPrintMix(patchTab.id)}
          onRun={() => onRunPrintMix(patchTab.id)}
        />
      ) : canManageProjectMixdown ? (
        <ClipFilerControls
          engineAcceptsNewJobs={engineAcceptsNewJobs}
          engineAvailabilityMessage={engineAvailabilityMessage}
          engineIsReady={engineIsReady}
          isProjectRootReady={isProjectRootReady}
          patchTab={patchTab}
          project={project}
          selectedClipId={selectedClipInfo?.clip.id}
          state={projectMixdownState}
          onCancel={() => onCancelProjectMixdown(patchTab.id)}
          onParameterChange={(parameterId, value) =>
            onParameterChange(patchTab.id, parameterId, value)
          }
          onRecover={() => onRecoverProjectMixdown(patchTab.id)}
          onRun={() => onRunProjectMixdown(patchTab.id)}
          onSave={() => onSaveProjectMixdownWav(patchTab.id)}
        />
      ) : (
        <div className="parameter-bank">
          {patchTab.parameters.map((parameter) => (
            <ParameterControl
              key={parameter.id}
              parameter={parameter}
              numberAction={
                parameter.id === 'seed' &&
                patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3
                  ? {
                      ariaLabel: `Randomize ${parameter.label}`,
                      label: 'RND',
                      onClick: () =>
                        onParameterChange(
                          patchTab.id,
                          parameter.id,
                          createRandomStableAudio3Seed((values) =>
                            window.crypto.getRandomValues(values),
                          ),
                        ),
                    }
                  : createTimelineLengthNumberAction(
                      parameter,
                      project,
                      (value) =>
                        onParameterChange(patchTab.id, parameter.id, value),
                    )
              }
              onChange={(value) => onParameterChange(patchTab.id, parameter.id, value)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SoundFontPatchTabControls({
  catalogState,
  patchTab,
  onListSoundFontPresets,
  onParameterChanges,
  onRefresh,
}: {
  catalogState: PianoRollSoundFontCatalogState;
  patchTab: PatchTab;
  onListSoundFontPresets: (
    resource: LocalEngineSoundFontResource,
  ) => Promise<LocalEngineSoundFontPresetCatalogResult>;
  onParameterChanges: (updates: readonly PatchTabParameterUpdate[]) => void;
  onRefresh: () => void;
}) {
  const resourceParameter = patchTab.parameters.find(
    (
      parameter,
    ): parameter is Extract<PatchTabParameter, { kind: 'select' }> =>
      parameter.id === SOUNDFONT_RESOURCE_PARAMETER_ID &&
      parameter.kind === 'select',
  );
  const bankParameter = patchTab.parameters.find(
    (
      parameter,
    ): parameter is Extract<PatchTabParameter, { kind: 'number' }> =>
      parameter.id === SOUNDFONT_BANK_PARAMETER_ID &&
      parameter.kind === 'number',
  );
  const programParameter = patchTab.parameters.find(
    (
      parameter,
    ): parameter is Extract<PatchTabParameter, { kind: 'number' }> =>
      parameter.id === SOUNDFONT_PROGRAM_PARAMETER_ID &&
      parameter.kind === 'number',
  );
  const customResources =
    catalogState.status === 'READY'
      ? catalogState.catalog.resources.filter(
          (resource) => resource.library === 'project',
        )
      : [];
  const selectedResource = customResources.find(
    (resource) => resource.relativePath === resourceParameter?.value,
  );
  const usesBuiltInPlaceholder =
    resourceParameter?.value === HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH;
  const savedCustomIsOffline =
    Boolean(resourceParameter) &&
    !usesBuiltInPlaceholder &&
    !selectedResource;
  const hasValidContract = Boolean(
    resourceParameter && bankParameter && programParameter,
  );
  const catalogMessage =
    catalogState.status === 'READY'
      ? selectedResource
        ? `${selectedResource.name} / ${selectedResource.format.toUpperCase()} / CUSTOM READY`
        : savedCustomIsOffline
          ? 'The saved custom SoundFont is offline. Select one verified custom file.'
          : customResources.length > 0
            ? 'Select one custom SoundFont file. Built-in voices are configured in MIDI TO AUDIO.'
            : 'No custom .sf2 or .sf3 files were found under Project Root / soundfonts.'
      : catalogState.status === 'LOADING'
        ? 'Reading custom SoundFonts.'
        : catalogState.status === 'ERROR'
          ? catalogState.message
          : 'Start Local Engine and select Project Root.';
  const catalogLabel =
    catalogState.status === 'LOADING'
      ? 'SCANNING SOUNDFONTS'
      : catalogState.status === 'ERROR'
        ? 'CATALOG ERROR'
        : catalogState.status === 'UNAVAILABLE'
          ? 'CATALOG UNAVAILABLE'
          : selectedResource
            ? 'CUSTOM SOUNDFONT READY'
            : savedCustomIsOffline
              ? 'CUSTOM SOUNDFONT OFFLINE'
              : 'CUSTOM SOUNDFONT UNASSIGNED';

  if (!hasValidContract || !resourceParameter || !bankParameter || !programParameter) {
    return (
      <output className="piano-roll-soundfont-help warning" aria-live="polite">
        <strong>SOUNDFONT CONTRACT ERROR</strong>
        <span>Resource, Bank, and Program parameters are required.</span>
      </output>
    );
  }

  return (
    <div className="soundfont-patchtab-editor">
      <div className="parameter-bank">
        <label className="parameter-row">
          <span>SoundFont</span>
          <select
            aria-label="SoundFont"
            disabled={catalogState.status !== 'READY'}
            value={resourceParameter.value}
            onChange={(event) => {
              onParameterChanges([
                {
                  parameterId: resourceParameter.id,
                  value: event.target.value,
                },
                { parameterId: bankParameter.id, value: 0 },
                { parameterId: programParameter.id, value: 0 },
              ]);
            }}
          >
            <option value={HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH}>
              SELECT CUSTOM SOUNDFONT
            </option>
            {savedCustomIsOffline && (
              <option value={resourceParameter.value} disabled>
                OFFLINE / {resourceParameter.value}
              </option>
            )}
            {customResources.map((resource) => (
              <option key={resource.resourceId} value={resource.relativePath}>
                CUSTOM / {resource.name} / {resource.format.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <SoundFontVoiceEditor
          bankParameter={bankParameter}
          disabled={!selectedResource}
          programParameter={programParameter}
          resource={selectedResource}
          onListSoundFontPresets={onListSoundFontPresets}
          onParameterChanges={onParameterChanges}
        />
      </div>
      <output
        className={`piano-roll-soundfont-help ${
          savedCustomIsOffline ? 'warning' : ''
        }`}
        aria-live="polite"
      >
        <strong>{catalogLabel}</strong>
        <span>{catalogMessage}</span>
      </output>
      <button
        type="button"
        className="patchtab-action-button"
        disabled={catalogState.status === 'LOADING'}
        onClick={onRefresh}
      >
        {catalogState.status === 'LOADING' ? 'SCANNING' : 'RESCAN'}
      </button>
    </div>
  );
}

type PatchTabParameterUpdate = Readonly<{
  parameterId: string;
  value: PatchTabParameterValue;
}>;

function InstrumentPatchTabControls({
  activeResolution,
  catalogState,
  patchTab,
  resource,
  onListSoundFontPresets,
  onParameterChanges,
}: {
  activeResolution?: InstrumentSoundFontResolution;
  catalogState: PianoRollSoundFontCatalogState;
  patchTab: PatchTab;
  resource?: LocalEngineSoundFontResource;
  onListSoundFontPresets: (
    resource: LocalEngineSoundFontResource,
  ) => Promise<LocalEngineSoundFontPresetCatalogResult>;
  onParameterChanges: (updates: readonly PatchTabParameterUpdate[]) => void;
}) {
  const bankParameter = patchTab.parameters.find(
    (
      parameter,
    ): parameter is Extract<PatchTabParameter, { kind: 'number' }> =>
      parameter.id === INSTRUMENT_BANK_PARAMETER_ID &&
      parameter.kind === 'number',
  );
  const programParameter = patchTab.parameters.find(
    (
      parameter,
    ): parameter is Extract<PatchTabParameter, { kind: 'number' }> =>
      parameter.id === INSTRUMENT_PROGRAM_PARAMETER_ID &&
      parameter.kind === 'number',
  );
  const preset = resolveInstrumentPatchTabPreset(patchTab);
  const activeOverride =
    activeResolution?.canResolve === true &&
    isInstrumentPresetControlLocked(activeResolution.selection.source)
      ? activeResolution.selection
      : undefined;
  if (!bankParameter || !programParameter || !preset) {
    return (
      <output className="piano-roll-soundfont-help warning" aria-live="polite">
        <strong>MIDI TO AUDIO CONTRACT ERROR</strong>
        <span>Bank and Program parameters are required.</span>
      </output>
    );
  }

  const displayedResource = activeOverride?.resource ?? resource;
  const displayedBankParameter = activeOverride
    ? { ...bankParameter, value: activeOverride.bank }
    : bankParameter;
  const displayedProgramParameter = activeOverride
    ? { ...programParameter, value: activeOverride.program }
    : programParameter;

  const availabilityMessage =
    catalogState.status === 'LOADING'
      ? 'Reading the built-in SoundFont.'
      : catalogState.status === 'ERROR'
        ? catalogState.message
        : catalogState.status === 'UNAVAILABLE'
          ? 'Start Local Engine and select Project Root.'
          : resource
            ? 'MuseScore General is the MIDI TO AUDIO default sound source.'
            : 'The built-in MuseScore General SoundFont is unavailable.';

  return (
    <div className="soundfont-patchtab-editor">
      <div className="parameter-bank">
        <SoundFontVoiceEditor
          bankParameter={displayedBankParameter}
          disabled={!displayedResource || Boolean(activeOverride)}
          programParameter={displayedProgramParameter}
          resource={displayedResource}
          onListSoundFontPresets={onListSoundFontPresets}
          onParameterChanges={onParameterChanges}
        />
      </div>
      <output
        className={`piano-roll-soundfont-help ${displayedResource ? '' : 'warning'}`}
        aria-live="polite"
      >
        <strong>
          {activeOverride
            ? activeOverride.source === 'connection'
              ? 'CUSTOM SOUNDFONT OVERRIDE'
              : 'MIDI CLIP VOICE OVERRIDE'
            : resource
              ? 'BUILT-IN SOUND READY'
              : 'BUILT-IN SOUND OFFLINE'}
        </strong>
        <span>
          {activeOverride
            ? `${activeOverride.resource.name} / Bank ${activeOverride.bank} / Program ${activeOverride.program} controls the current render.`
            : availabilityMessage}
        </span>
      </output>
    </div>
  );
}

function SoundFontVoiceEditor({
  bankParameter,
  disabled = false,
  programParameter,
  resource,
  onListSoundFontPresets,
  onParameterChanges,
}: {
  bankParameter: Extract<PatchTabParameter, { kind: 'number' }>;
  disabled?: boolean;
  programParameter: Extract<PatchTabParameter, { kind: 'number' }>;
  resource?: LocalEngineSoundFontResource;
  onListSoundFontPresets: (
    resource: LocalEngineSoundFontResource,
  ) => Promise<LocalEngineSoundFontPresetCatalogResult>;
  onParameterChanges: (updates: readonly PatchTabParameterUpdate[]) => void;
}) {
  const presetCatalogState = useSoundFontPresetCatalog(
    resource,
    onListSoundFontPresets,
  );
  const presets =
    presetCatalogState.status === 'READY'
      ? presetCatalogState.catalog.presets
      : [];
  const selectedPreset = presets.find(
    (preset) =>
      preset.bank === bankParameter.value &&
      preset.program === programParameter.value,
  );
  const selectedKey = selectedPreset
    ? createSoundFontPresetKey(selectedPreset.bank, selectedPreset.program)
    : '';
  const voiceStatus = !resource
    ? 'VOICE UNAVAILABLE'
    : presetCatalogState.status === 'LOADING'
      ? 'READING VOICES'
      : presetCatalogState.status === 'ERROR'
        ? 'VOICE CATALOG ERROR'
        : selectedPreset
          ? selectedPreset.name
          : presetCatalogState.status === 'READY'
            ? 'VOICE NOT FOUND'
            : 'VOICE UNAVAILABLE';
  const voiceMessage =
    presetCatalogState.status === 'ERROR'
      ? presetCatalogState.message
      : selectedPreset
        ? `Bank ${selectedPreset.bank} / Program ${selectedPreset.program}`
        : resource && presetCatalogState.status === 'READY'
          ? `No preset named by Bank ${bankParameter.value} / Program ${programParameter.value}.`
          : resource
            ? 'Waiting for the verified SoundFont voice catalog.'
            : 'Select or restore one SoundFont first.';

  return (
    <>
      <label className="parameter-row">
        <span>Sound</span>
        <select
          aria-label="Sound"
          disabled={disabled || presetCatalogState.status !== 'READY'}
          value={selectedKey}
          onChange={(event) => {
            const selection = parseSoundFontPresetKey(event.target.value);

            if (!selection) {
              return;
            }

            onParameterChanges([
              { parameterId: bankParameter.id, value: selection.bank },
              { parameterId: programParameter.id, value: selection.program },
            ]);
          }}
        >
          {!selectedPreset && (
            <option value="">
              B{bankParameter.value} P{programParameter.value} / NOT FOUND
            </option>
          )}
          {presets.map((preset) => (
            <option
              key={createSoundFontPresetKey(preset.bank, preset.program)}
              value={createSoundFontPresetKey(preset.bank, preset.program)}
            >
              {preset.name} / B{preset.bank} P{preset.program}
            </option>
          ))}
        </select>
      </label>
      <NumberParameterControl
        disabled={disabled}
        parameter={bankParameter}
        onChange={(value) =>
          onParameterChanges([{ parameterId: bankParameter.id, value }])
        }
      />
      <NumberParameterControl
        disabled={disabled}
        parameter={programParameter}
        onChange={(value) =>
          onParameterChanges([{ parameterId: programParameter.id, value }])
        }
      />
      <output
        className={`piano-roll-soundfont-help ${
          resource && presetCatalogState.status === 'READY' && selectedPreset
            ? ''
            : 'warning'
        }`}
        aria-live="polite"
      >
        <strong>{voiceStatus}</strong>
        <span>{voiceMessage}</span>
      </output>
    </>
  );
}

function BasicPitchHumToMidiControls({
  basicPitchRuntimeState,
  engineAcceptsNewJobs,
  engineAvailabilityMessage,
  isProjectRootReady,
  patchTab,
  project,
  state,
  onCancel,
  onParameterChange,
  onRecover,
  onRetry,
  onRun,
}: {
  basicPitchRuntimeState: BasicPitchRuntimeUiState;
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  isProjectRootReady: boolean;
  patchTab: PatchTab;
  project: ProjectState;
  state: BasicPitchHumToMidiUiState;
  onCancel: () => void;
  onParameterChange: (parameterId: string, value: PatchTabParameterValue) => void;
  onRecover: () => void;
  onRetry: () => void;
  onRun: () => void;
}) {
  const presentation = createBasicPitchHumToMidiUiPresentation({
    engineAcceptsNewJobs,
    engineAvailabilityMessage,
    isProjectRootReady,
    patchTab,
    project,
    runtime: basicPitchRuntimeState,
    state,
  });
  const handleAction = () => {
    switch (presentation.buttonLabel) {
      case 'CANCEL':
        onCancel();
        return;
      case 'RECOVER':
        onRecover();
        return;
      case 'RETRY':
        onRetry();
        return;
      case 'WAIT':
        return;
      default:
        onRun();
    }
  };

  return (
    <div className="hum-to-midi-editor">
      <fieldset
        className="hum-to-midi-parameter-fieldset"
        disabled={presentation.disableParameters}
        aria-label="Basic Pitch Hum to MIDI controls"
      >
        <div className="parameter-bank">
          {patchTab.parameters.map((parameter) => (
            <ParameterControl
              key={parameter.id}
              parameter={parameter}
              onChange={(value) => onParameterChange(parameter.id, value)}
            />
          ))}
        </div>
      </fieldset>
      <PatchTabActionCard
        ariaBusy={presentation.ariaBusy}
        isReady={presentation.canAct}
        eyebrow={presentation.eyebrow}
        title={presentation.title}
        detail={presentation.detail}
        buttonLabel={presentation.buttonLabel}
        onClick={handleAction}
      />
    </div>
  );
}

function PrintMixControls({
  engineAcceptsNewJobs,
  engineAvailabilityMessage,
  isProjectRootReady,
  patchTab,
  project,
  state,
  onCancel,
  onParameterChange,
  onRecover,
  onRun,
}: {
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  isProjectRootReady: boolean;
  patchTab: PatchTab;
  project: ProjectState;
  state: PrintMixUiState;
  onCancel: () => void;
  onParameterChange: (parameterId: string, value: PatchTabParameterValue) => void;
  onRecover: () => void;
  onRun: () => void;
}) {
  const presentation = createPrintMixUiPresentation({
    engineAcceptsNewJobs,
    engineAvailabilityMessage,
    isProjectRootReady,
    patchTab,
    project,
    state,
  });
  const normalizeParameter = patchTab.parameters.find(
    (
      parameter,
    ): parameter is Extract<PatchTabParameter, { kind: 'select' }> =>
      parameter.id === 'normalize' && parameter.kind === 'select',
  );
  const handleAction = () => {
    if (presentation.buttonLabel === 'CANCEL') {
      onCancel();
      return;
    }

    if (presentation.buttonLabel === 'RECOVER') {
      onRecover();
      return;
    }

    onRun();
  };

  return (
    <>
      {presentation.showNormalize && normalizeParameter ? (
        <div className="parameter-bank" aria-label="Audio PRINT MIX controls">
          <label className="parameter-row">
            <span>NORMALIZE</span>
            <select
              aria-label="PRINT MIX NORMALIZE"
              disabled={
                presentation.ariaBusy || presentation.buttonLabel === 'RECOVER'
              }
              value={normalizeParameter.value}
              onChange={(event) =>
                onParameterChange(normalizeParameter.id, event.target.value)
              }
            >
              {normalizeParameter.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <PatchTabActionCard
        ariaBusy={presentation.ariaBusy}
        isReady={presentation.canAct}
        eyebrow={presentation.eyebrow}
        title={presentation.title}
        detail={presentation.detail}
        buttonLabel={presentation.buttonLabel}
        onClick={handleAction}
      />
    </>
  );
}

function ClipFilerControls({
  engineAcceptsNewJobs,
  engineAvailabilityMessage,
  engineIsReady,
  isProjectRootReady,
  patchTab,
  project,
  selectedClipId,
  state,
  onCancel,
  onParameterChange,
  onRecover,
  onRun,
  onSave,
}: {
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  engineIsReady: boolean;
  isProjectRootReady: boolean;
  patchTab: PatchTab;
  project: ProjectState;
  selectedClipId?: string;
  state: ProjectMixdownUiState;
  onCancel: () => void;
  onParameterChange: (parameterId: string, value: PatchTabParameterValue) => void;
  onRecover: () => void;
  onRun: () => void;
  onSave: () => void;
}) {
  const settings = resolveClipFilerProductionSettings(patchTab);
  const download = resolveProjectMixdownDownload(
    project,
    patchTab,
    selectedClipId,
  );
  const isStateOwner = isProjectMixdownOwner(
    state.owner,
    createClipFilerProjectMixdownOwner(patchTab.id),
  );
  const isAnyOperationActive = isProjectMixdownOperationActive(state);
  const isOperationActive = isStateOwner && isAnyOperationActive;
  const isAnyDownloadActive = state.status === 'DOWNLOADING';
  const isDownloadActive = isStateOwner && isAnyDownloadActive;
  const hasAnyUnknownOutcome = state.status === 'MIXDOWN_OUTCOME_UNKNOWN';
  const hasUnknownOutcome = isStateOwner && hasAnyUnknownOutcome;
  const isAnyRuntimeActive = isProjectMixdownRuntimeActive(state);
  const canPrint =
    settings.canResolve &&
    engineAcceptsNewJobs &&
    isProjectRootReady &&
    canStartProjectMixdown(state);
  const canRecover =
    hasUnknownOutcome &&
    engineAcceptsNewJobs &&
    isProjectRootReady;
  const canSave =
    download.canDownload &&
    engineIsReady &&
    isProjectRootReady &&
    !isAnyRuntimeActive &&
    !hasAnyUnknownOutcome;
  const statusPresentation = createClipFilerStatusPresentation({
    canPrint,
    download,
    engineAcceptsNewJobs,
    engineAvailabilityMessage,
    engineIsReady,
    hasAnyUnknownOutcome,
    isAnyRuntimeActive,
    isProjectRootReady,
    isStateOwner,
    settings,
    state,
  });

  return (
    <div className="clip-filer-editor">
      <fieldset
        className="clip-filer-parameter-fieldset"
        disabled={isOperationActive || hasUnknownOutcome}
      >
        <div className="parameter-bank">
          {patchTab.parameters.map((parameter) => (
            <ParameterControl
              key={parameter.id}
              parameter={parameter}
              onChange={(value) => onParameterChange(parameter.id, value)}
            />
          ))}
        </div>
      </fieldset>
      <div className="clip-filer-contract" aria-label="Project Mixdown contract">
        <div>
          <span>Scope</span>
          <strong>WHOLE PROJECT</strong>
        </div>
        <div>
          <span>Print</span>
          <strong>RAW MIX / WAV</strong>
        </div>
        <div>
          <span>Save</span>
          <strong>{download.canDownload ? download.fileName : 'SELECT RAW MIX'}</strong>
        </div>
        <small>
          PRINT MIX creates a finalized internal WAV and a muted Raw Mix Track.
          SAVE WAV downloads the selected registered Raw Mix.
        </small>
      </div>
      <div className={`clip-filer-runtime ${statusPresentation.tone}`}>
        <div className="clip-filer-status-line">
          <span>Status</span>
          <strong>{statusPresentation.label}</strong>
        </div>
        <p>{statusPresentation.message}</p>
        {isStateOwner && state.summary && (
          <div className="clip-filer-summary" aria-label="Project Mixdown summary">
            <span>{state.summary.trackCount} TRACKS</span>
            <span>{state.summary.sourceCount} SOURCES</span>
            <span>{formatClipFilerDuration(state.summary.durationSeconds)}</span>
          </div>
        )}
        {isStateOwner && state.operationId && (
          <small className="clip-filer-operation-id">
            OP {state.operationId}
          </small>
        )}
        <div className="clip-filer-actions">
          <button
            type="button"
            className="patchtab-action-button clip-filer-action-button"
            disabled={!canPrint}
            onClick={onRun}
          >
            {isOperationActive ? 'PRINTING' : 'PRINT MIX'}
          </button>
          {isOperationActive && (
            <button
              type="button"
              className="patchtab-action-button clip-filer-secondary-button"
              disabled={state.status === 'CANCEL_REQUESTED'}
              onClick={onCancel}
            >
              {state.status === 'CANCEL_REQUESTED' ? 'WAIT' : 'CANCEL'}
            </button>
          )}
          {hasUnknownOutcome && (
            <button
              type="button"
              className="patchtab-action-button clip-filer-recover-button"
              disabled={!canRecover}
              onClick={onRecover}
            >
              RECOVER
            </button>
          )}
          <button
            type="button"
            className="patchtab-action-button clip-filer-save-button"
            disabled={!canSave}
            onClick={onSave}
          >
            {isDownloadActive ? 'SAVING' : 'SAVE WAV'}
          </button>
        </div>
      </div>
    </div>
  );
}

function createClipFilerStatusPresentation(input: Readonly<{
  canPrint: boolean;
  download: ReturnType<typeof resolveProjectMixdownDownload>;
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  engineIsReady: boolean;
  hasAnyUnknownOutcome: boolean;
  isAnyRuntimeActive: boolean;
  isProjectRootReady: boolean;
  isStateOwner: boolean;
  settings: ReturnType<typeof resolveClipFilerProductionSettings>;
  state: ProjectMixdownUiState;
}>): Readonly<{
  label: string;
  message: string;
  tone: 'active' | 'error' | 'ready' | 'success' | 'warning';
}> {
  const hasPriorityRuntimeState =
    input.state.status === 'PREPARING' ||
    input.state.status === 'RUNNING' ||
    input.state.status === 'RECOVERING' ||
    input.state.status === 'CANCEL_REQUESTED' ||
    input.state.status === 'MIXDOWN_OUTCOME_UNKNOWN' ||
    input.state.status === 'DOWNLOADING';

  if (input.isStateOwner && hasPriorityRuntimeState) {
    return createProjectMixdownStatePresentation(input.state);
  }

  if (!input.isStateOwner && input.isAnyRuntimeActive) {
    return {
      label: 'BUSY',
      message: input.state.owner?.kind === 'mixer'
        ? 'Mixer owns the active Project Mixdown operation.'
        : 'Another Clip Filer owns the active Project Mixdown operation.',
      tone: 'active',
    };
  }

  if (!input.isStateOwner && input.hasAnyUnknownOutcome) {
    return {
      label: 'RECOVERY',
      message: input.state.owner?.kind === 'mixer'
        ? 'Mixer owns an unknown Mixdown outcome. Recover it from the Mixer before new output work.'
        : 'Another Clip Filer owns an unknown Mixdown outcome. Recover it before new output work.',
      tone: 'warning',
    };
  }

  if (!input.engineIsReady) {
    return {
      label: 'ENGINE',
      message: input.engineAvailabilityMessage,
      tone: 'error',
    };
  }

  if (!input.isProjectRootReady) {
    return {
      label: 'PROJECT ROOT',
      message: 'Select one ready Project Root before printing or saving audio.',
      tone: 'error',
    };
  }

  if (!input.settings.canResolve) {
    return {
      label: 'SETTINGS',
      message: input.settings.message,
      tone: 'warning',
    };
  }

  if (input.isStateOwner && input.state.status !== 'IDLE') {
    return createProjectMixdownStatePresentation(input.state);
  }

  if (!input.engineAcceptsNewJobs) {
    return {
      label: 'BUSY',
      message: `${input.engineAvailabilityMessage} Existing Raw Mix WAV files may still be saved.`,
      tone: 'warning',
    };
  }

  return {
    label: input.download.canDownload ? 'RAW MIX SELECTED' : 'READY',
    message: input.download.canDownload
      ? `${input.download.fileName} is ready to save, or PRINT MIX can create a new Project snapshot.`
      : input.canPrint
        ? 'Print the audible Project through the current Mixer to a finalized WAV.'
        : input.download.message,
    tone: 'ready',
  };
}

function createProjectMixdownStatePresentation(
  state: ProjectMixdownUiState,
): Readonly<{
  label: string;
  message: string;
  tone: 'active' | 'error' | 'success' | 'warning';
}> {
  const isActive =
    state.status === 'PREPARING' ||
    state.status === 'RUNNING' ||
    state.status === 'RECOVERING' ||
    state.status === 'CANCEL_REQUESTED' ||
    state.status === 'DOWNLOADING';
  const isSuccess =
    state.status === 'REGISTERED' || state.status === 'DOWNLOADED';
  const isWarning =
    state.status === 'MIXDOWN_OUTCOME_UNKNOWN' ||
    state.status === 'CANCELED';

  return {
    label: state.status.replace(/_/g, ' '),
    message: state.message ?? 'Project Mixdown state updated.',
    tone: isActive
      ? 'active'
      : isSuccess
        ? 'success'
        : isWarning
          ? 'warning'
          : 'error',
  };
}

function formatClipFilerDuration(durationSeconds: number): string {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return '--:--';
  }

  const wholeSeconds = Math.round(durationSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function AceStepControls({
  engineAcceptsNewJobs,
  engineAvailabilityMessage,
  isProjectRootReady,
  patchTab,
  project,
  selectedClipId,
  state,
  onCancel,
  onGenerate,
  onParameterChange,
}: {
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  isProjectRootReady: boolean;
  patchTab: PatchTab;
  project: ProjectState;
  selectedClipId?: string;
  state: AceStepUiState;
  onCancel: () => void;
  onGenerate: () => void;
  onParameterChange: (parameterId: string, value: PatchTabParameterValue) => void;
}) {
  const settingsResolution = resolveAceStepPatchTabSettings(patchTab);
  const preparation = prepareAceStepPatchTabRun(
    project,
    patchTab,
    selectedClipId,
  );
  const isAnyRunActive = isAceStepVocalUiActive(state);
  const isStateOwner = state.patchTabId === patchTab.id;
  const isThisRunActive = isAnyRunActive && isStateOwner;
  const canGenerate =
    preparation.canPrepare &&
    engineAcceptsNewJobs &&
    isProjectRootReady &&
    !isAnyRunActive;
  const presentation = createAceStepPresentation({
    canGenerate,
    engineAcceptsNewJobs,
    engineAvailabilityMessage,
    isAnyRunActive,
    isProjectRootReady,
    isStateOwner,
    isThisRunActive,
    preparation,
    settingsResolution,
    state,
  });
  const action = resolveAceStepVocalAction({
    canGenerate,
    patchTabId: patchTab.id,
    state,
  });

  return (
    <div className="sa3-t2a-editor ace-step-editor">
      <fieldset className="sa3-t2a-parameter-fieldset" disabled={isAnyRunActive}>
        <div className="parameter-bank">
          {patchTab.parameters.map((parameter) => (
            <div className="sa3-t2a-parameter-slot" key={parameter.id}>
              <ParameterControl
                parameter={parameter}
                numberAction={
                  parameter.id === 'seed'
                    ? {
                        ariaLabel: `Randomize ${parameter.label}`,
                        label: 'RND',
                        onClick: () =>
                          onParameterChange(
                            parameter.id,
                            createRandomStableAudio3Seed((values) =>
                              window.crypto.getRandomValues(values),
                            ),
                          ),
                      }
                    : undefined
                }
                onChange={(value) => onParameterChange(parameter.id, value)}
              />
            </div>
          ))}
        </div>
      </fieldset>
      <div className="ace-step-contract" aria-label="ACE-Step generation contract">
        <div>
          <span>Task</span>
          <strong>LEGO VOCALS</strong>
        </div>
        <div>
          <span>Guide</span>
          <strong>
            {preparation.canPrepare
              ? `${preparation.mode === 'existing-vocal' ? preparation.target.guideClipName : preparation.guide.guideClipName} / ${formatAceStepDuration(
                  preparation.mode === 'existing-vocal'
                    ? preparation.target.guideDurationSeconds
                    : preparation.guide.guideDurationSeconds,
                )} s`
              : '--'}
          </strong>
        </div>
        <div>
          <span>Target</span>
          <strong>
            {preparation.canPrepare
              ? preparation.mode === 'existing-vocal'
                ? preparation.target.targetClipName
                : 'New ACE Vocal'
              : '--'}
          </strong>
        </div>
        <small>{createAceStepPatchTabModelSummary()}</small>
      </div>
      <div
        className={`sa3-t2a-runtime ace-step-runtime ${presentation.tone}`}
        aria-busy={action.ariaBusy}
      >
        <div className="sa3-t2a-status-line">
          <span>Status</span>
          <strong>{presentation.label}</strong>
        </div>
        <p>{presentation.message}</p>
        <button
          type="button"
          className="patchtab-action-button sa3-t2a-action-button"
          aria-label={`${action.action} ACE Vocals`}
          disabled={action.disabled}
          onClick={action.action === 'CANCEL' ? onCancel : onGenerate}
        >
          {action.action}
        </button>
        {isThisRunActive && action.action === 'WAIT' && (
          <small className="ace-step-no-cancel">
            {state.status === 'CANCEL_REQUESTED'
              ? 'CANCEL PENDING / WAIT FOR ENGINE'
              : state.status === 'SAVING' || state.status === 'COMPLETED'
                ? 'FINALIZING / COMPLETION WINS'
                : 'PREPARING / WAIT FOR JOB ID'}
          </small>
        )}
      </div>
    </div>
  );
}

function createAceStepPresentation(input: Readonly<{
  canGenerate: boolean;
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  isAnyRunActive: boolean;
  isProjectRootReady: boolean;
  isStateOwner: boolean;
  isThisRunActive: boolean;
  preparation: AceStepPatchTabPreparation;
  settingsResolution: AceStepPatchTabSettingsResolution;
  state: AceStepUiState;
}>): Readonly<{
  label: string;
  message: string;
  tone: 'active' | 'error' | 'ready' | 'success' | 'warning';
}> {
  if (input.isThisRunActive) {
    return {
      label: formatAceStepStatus(input.state.status),
      message: input.state.message ?? 'ACE Vocals Job is active.',
      tone: 'active',
    };
  }

  if (input.isAnyRunActive) {
    return {
      label: 'ERROR',
      message: 'Another ACE Vocals PatchTab owns the active Job.',
      tone: 'error',
    };
  }

  if (
    input.isStateOwner &&
    input.state.status === 'CANCELED' &&
    input.state.message
  ) {
    return {
      label: 'CANCELED',
      message: input.state.message,
      tone: 'warning',
    };
  }

  if (!input.engineAcceptsNewJobs) {
    return {
      label: 'ERROR',
      message: input.engineAvailabilityMessage,
      tone: 'error',
    };
  }

  if (!input.isProjectRootReady) {
    return {
      label: 'ERROR',
      message: 'Select one ready Project Root before generation.',
      tone: 'error',
    };
  }

  if (!input.settingsResolution.canResolve) {
    return {
      label: 'INPUT',
      message: input.settingsResolution.message,
      tone: 'warning',
    };
  }

  if (!input.preparation.canPrepare) {
    return {
      label: 'SOURCE',
      message: input.preparation.message,
      tone: 'warning',
    };
  }

  if (
    input.isStateOwner &&
    input.state.status === 'ERROR' &&
    input.state.message
  ) {
    return { label: 'ERROR', message: input.state.message, tone: 'error' };
  }

  if (
    input.isStateOwner &&
    input.state.status === 'PENDING' &&
    input.state.message
  ) {
    return {
      label: 'PENDING',
      message: input.state.message,
      tone: 'warning',
    };
  }

  if (
    input.isStateOwner &&
    input.state.status === 'REGISTERED' &&
    input.state.message
  ) {
    return {
      label: 'READY',
      message: input.state.message,
      tone: 'success',
    };
  }

  return input.preparation.mode === 'existing-vocal'
    ? {
        label: input.canGenerate ? 'READY' : 'ERROR',
        message: `${input.preparation.target.midiClipName} -> ${input.preparation.target.guideClipName} -> ${input.preparation.target.targetClipName}. Output is added as an inactive Take.`,
        tone: input.canGenerate ? 'ready' : 'error',
      }
    : {
        label: input.canGenerate ? 'READY' : 'ERROR',
        message: `${input.preparation.guide.guideClipName} -> New ACE Vocal. The Vocal Track is created only after verified completion.`,
        tone: input.canGenerate ? 'ready' : 'error',
      };
}

function createAceStepProgressMessage(
  preparation: Extract<AceStepPatchTabPreparation, { canPrepare: true }>,
  status: AceStepUiState['status'],
  jobId?: string,
): string {
  switch (status) {
    case 'SAVING_LYRICS':
      return 'Saving one immutable Lyrics snapshot.';
    case 'ENQUEUEING':
      return `Enqueueing ACE Vocals for ${
        preparation.mode === 'existing-vocal'
          ? preparation.target.targetClipName
          : 'a new aligned Vocal Track'
      }.`;
    case 'COMPLETED':
      return `ACE-Step Job ${jobId ?? ''} finalized. Verifying the Vocal WAV before Project registration.`.trim();
    default:
      return jobId
        ? `ACE-Step Job ${jobId}: ${formatAceStepStatus(status)}.`
        : `ACE Vocals: ${formatAceStepStatus(status)}.`;
  }
}

function formatAceStepStatus(status: AceStepUiState['status']): string {
  switch (status) {
    case 'SAVING_LYRICS':
      return 'SAVING LYRICS';
    case 'LOADING_MODEL':
      return 'LOADING MODEL';
    case 'PROCESSING':
      return 'GENERATING';
    case 'COMPLETED':
      return 'VERIFYING';
    case 'FAILED':
    case 'INTERRUPTED':
    case 'PAUSED':
      return 'ERROR';
    case 'CANCELED':
      return 'CANCELED';
    default:
      return status;
  }
}

function formatAceStepDuration(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(2)));
}

function createTimelineLengthNumberAction(
  parameter: PatchTabParameter,
  project: ProjectState,
  onChange: (value: number) => void,
): Readonly<{
  ariaLabel: string;
  label: string;
  onClick: () => void;
}> | undefined {
  if (parameter.id !== 'bars' || parameter.kind !== 'number') {
    return undefined;
  }

  return Object.freeze({
    ariaLabel: `Set ${parameter.label} to Timeline Length`,
    label: 'LENGTH',
    onClick: () =>
      onChange(resolveTimelineLengthBarsValue(project.totalTicks, parameter)),
  });
}

function AceStepTextToMusicControls({
  engineAcceptsNewJobs,
  engineAvailabilityMessage,
  isProjectRootReady,
  patchTab,
  project,
  state,
  onCancel,
  onGenerate,
  onParameterChange,
}: {
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  isProjectRootReady: boolean;
  patchTab: PatchTab;
  project: ProjectState;
  state: AceStepTextToMusicUiState;
  onCancel: () => void;
  onGenerate: () => void;
  onParameterChange: (parameterId: string, value: PatchTabParameterValue) => void;
}) {
  const settings = resolveAceStepTextToMusicSettings(project, patchTab);
  const isAnyRunActive = isAceStepTextToMusicUiActive(state);
  const isThisRunActive = isAnyRunActive && state.patchTabId === patchTab.id;
  const canCancel =
    isThisRunActive &&
    (state.status === 'ENQUEUEING' ||
      state.status === 'QUEUED' ||
      state.status === 'LOADING_MODEL' ||
      state.status === 'PROCESSING');
  const canGenerate =
    settings.canResolve &&
    engineAcceptsNewJobs &&
    isProjectRootReady &&
    !isAnyRunActive;
  let label = canGenerate ? 'READY' : 'ERROR';
  let message = settings.canResolve
    ? `Duration ${formatStableAudio3TextToAudioDuration(settings.settings.durationSeconds)} s / Stereo 48 kHz WAV / Advanced defaults fixed for v0.1.`
    : settings.message;
  let tone: 'active' | 'error' | 'ready' | 'success' | 'warning' = canGenerate
    ? 'ready'
    : 'error';

  if (isThisRunActive) {
    label = formatAceStepTextToMusicStatus(state.status);
    message = state.message ?? 'ACE T2M Job is active.';
    tone = 'active';
  } else if (isAnyRunActive) {
    label = 'ERROR';
    message = 'Another ACE T2M PatchTab owns the active Job.';
    tone = 'error';
  } else if (!engineAcceptsNewJobs) {
    message = engineAvailabilityMessage;
  } else if (!isProjectRootReady) {
    message = 'Select one ready Project Root before generation.';
  } else if (state.patchTabId === patchTab.id && state.status === 'COMPLETED') {
    label = 'COMPLETED';
    message = state.message ?? 'ACE T2M output was registered.';
    tone = 'success';
  } else if (state.patchTabId === patchTab.id && state.status === 'CANCELED') {
    label = 'CANCELED';
    message = state.message ?? 'ACE T2M was canceled.';
    tone = 'warning';
  } else if (state.patchTabId === patchTab.id && state.status === 'ERROR') {
    message = state.message ?? message;
  }

  return (
    <div className="sa3-t2a-editor">
      <fieldset className="sa3-t2a-parameter-fieldset" disabled={isAnyRunActive}>
        <div className="parameter-bank">
          {patchTab.parameters.map((parameter) => (
            <div className="sa3-t2a-parameter-slot" key={parameter.id}>
              <ParameterControl
                parameter={parameter}
                numberAction={
                  parameter.id === 'seed'
                    ? {
                        ariaLabel: `Randomize ${parameter.label}`,
                        label: 'RND',
                        onClick: () =>
                          onParameterChange(
                            parameter.id,
                            createRandomStableAudio3Seed((values) =>
                              window.crypto.getRandomValues(values),
                            ),
                          ),
                      }
                    : createTimelineLengthNumberAction(
                        parameter,
                        project,
                        (value) => onParameterChange(parameter.id, value),
                      )
                }
                onChange={(value) => onParameterChange(parameter.id, value)}
              />
              {parameter.id === 'bars' && (
                <div className="parameter-row sa3-t2a-duration-row">
                  <span>Duration</span>
                  <output>
                    {settings.canResolve
                      ? `${formatStableAudio3TextToAudioDuration(settings.settings.durationSeconds)} s`
                      : '--'}
                  </output>
                </div>
              )}
            </div>
          ))}
        </div>
      </fieldset>
      <div className={`sa3-t2a-runtime ${tone}`}>
        <div className="sa3-t2a-status-line">
          <span>Status</span>
          <strong>{label}</strong>
        </div>
        <p>{message}</p>
        <small>ACE-Step 1.5 Base / Text to Music / 48 kHz</small>
        <button
          type="button"
          className={`patchtab-action-button sa3-t2a-action-button ${canCancel ? 'cancel' : ''}`}
          disabled={isThisRunActive ? !canCancel : !canGenerate}
          onClick={canCancel ? onCancel : onGenerate}
        >
          {isThisRunActive ? (canCancel ? 'CANCEL' : 'WAIT') : 'GENERATE'}
        </button>
      </div>
    </div>
  );
}

function isAceStepTextToMusicUiActive(state: AceStepTextToMusicUiState): boolean {
  return (
    state.status === 'ENQUEUEING' ||
    state.status === 'QUEUED' ||
    state.status === 'LOADING_MODEL' ||
    state.status === 'PROCESSING' ||
    state.status === 'SAVING' ||
    state.status === 'CANCEL_REQUESTED'
  );
}

function AceStepCoverControls({
  engineAcceptsNewJobs,
  engineAvailabilityMessage,
  isProjectRootReady,
  patchTab,
  project,
  selectedClipId,
  state,
  onCancel,
  onGenerate,
  onParameterChange,
}: {
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  isProjectRootReady: boolean;
  patchTab: PatchTab;
  project: ProjectState;
  selectedClipId?: string;
  state: AceStepCoverUiState;
  onCancel: () => void;
  onGenerate: () => void;
  onParameterChange: (parameterId: string, value: PatchTabParameterValue) => void;
}) {
  const settings = resolveAceStepCoverSettings(project, patchTab, selectedClipId);
  const isAnyRunActive = isAceStepCoverUiActive(state);
  const isThisRunActive = isAnyRunActive && state.patchTabId === patchTab.id;
  const canCancel =
    isThisRunActive &&
    (state.status === 'ENQUEUEING' ||
      state.status === 'QUEUED' ||
      state.status === 'LOADING_MODEL' ||
      state.status === 'PROCESSING');
  const canGenerate =
    settings.canResolve &&
    engineAcceptsNewJobs &&
    isProjectRootReady &&
    !isAnyRunActive;
  let label = canGenerate ? 'READY' : 'ERROR';
  let message = settings.canResolve
    ? `${settings.settings.source.name} / ${formatAceStepDuration(settings.settings.source.durationSeconds)} s / Stereo 48 kHz WAV / Advanced defaults fixed for v0.1.`
    : settings.message;
  let tone: 'active' | 'error' | 'ready' | 'success' | 'warning' = canGenerate
    ? 'ready'
    : 'error';

  if (isThisRunActive) {
    label = formatAceStepTextToMusicStatus(state.status);
    message = state.message ?? 'ACE Cover Job is active.';
    tone = 'active';
  } else if (isAnyRunActive) {
    label = 'ERROR';
    message = 'Another ACE Cover PatchTab owns the active Job.';
    tone = 'error';
  } else if (!engineAcceptsNewJobs) {
    message = engineAvailabilityMessage;
  } else if (!isProjectRootReady) {
    message = 'Select one ready Project Root before generation.';
  } else if (state.patchTabId === patchTab.id && state.status === 'COMPLETED') {
    label = 'COMPLETED';
    message = state.message ?? 'ACE Cover output was registered.';
    tone = 'success';
  } else if (state.patchTabId === patchTab.id && state.status === 'CANCELED') {
    label = 'CANCELED';
    message = state.message ?? 'ACE Cover was canceled.';
    tone = 'warning';
  } else if (state.patchTabId === patchTab.id && state.status === 'ERROR') {
    message = state.message ?? message;
  }

  return (
    <div className="sa3-t2a-editor">
      <fieldset className="sa3-t2a-parameter-fieldset" disabled={isAnyRunActive}>
        <div className="parameter-bank">
          {patchTab.parameters.map((parameter) => (
            <div className="sa3-t2a-parameter-slot" key={parameter.id}>
              <ParameterControl
                parameter={parameter}
                numberAction={
                  parameter.id === 'seed'
                    ? {
                        ariaLabel: `Randomize ${parameter.label}`,
                        label: 'RND',
                        onClick: () =>
                          onParameterChange(
                            parameter.id,
                            createRandomStableAudio3Seed((values) =>
                              window.crypto.getRandomValues(values),
                            ),
                          ),
                      }
                    : undefined
                }
                onChange={(value) => onParameterChange(parameter.id, value)}
              />
            </div>
          ))}
        </div>
      </fieldset>
      <div className={`sa3-t2a-runtime ${tone}`}>
        <div className="sa3-t2a-status-line">
          <span>Status</span>
          <strong>{label}</strong>
        </div>
        <p>{message}</p>
        <small>ACE-Step 1.5 Base / Remix Cover / 48 kHz</small>
        <button
          type="button"
          className={`patchtab-action-button sa3-t2a-action-button ${canCancel ? 'cancel' : ''}`}
          disabled={isThisRunActive ? !canCancel : !canGenerate}
          onClick={canCancel ? onCancel : onGenerate}
        >
          {isThisRunActive ? (canCancel ? 'CANCEL' : 'WAIT') : 'GENERATE'}
        </button>
      </div>
    </div>
  );
}

function isAceStepCoverUiActive(state: AceStepCoverUiState): boolean {
  return (
    state.status === 'ENQUEUEING' ||
    state.status === 'QUEUED' ||
    state.status === 'LOADING_MODEL' ||
    state.status === 'PROCESSING' ||
    state.status === 'SAVING' ||
    state.status === 'CANCEL_REQUESTED'
  );
}

function formatAceStepTextToMusicStatus(
  status: AceStepTextToMusicUiState['status'],
): string {
  return status === 'LOADING_MODEL'
    ? 'LOADING MODEL'
    : status === 'CANCEL_REQUESTED'
      ? 'CANCELING'
      : status;
}

function StableAudio3TextToAudioControls({
  engineAcceptsNewJobs,
  engineAvailabilityMessage,
  isProjectRootReady,
  patchTab,
  project,
  state,
  onCancel,
  onGenerate,
  onParameterChange,
}: {
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  isProjectRootReady: boolean;
  patchTab: PatchTab;
  project: ProjectState;
  state: StableAudio3TextToAudioUiState;
  onCancel: () => void;
  onGenerate: () => void;
  onParameterChange: (parameterId: string, value: PatchTabParameterValue) => void;
}) {
  const settingsResolution = resolveStableAudio3TextToAudioPatchTabSettings(
    project,
    patchTab,
  );
  const isAnyRunActive = isStableAudio3TextToAudioUiActive(state);
  const isStateOwner = state.patchTabId === patchTab.id;
  const isThisRunActive = isAnyRunActive && state.patchTabId === patchTab.id;
  const canCancel =
    isThisRunActive &&
    (state.status === 'ENQUEUEING' ||
      state.status === 'QUEUED' ||
      state.status === 'LOADING_MODEL' ||
      state.status === 'PROCESSING');
  const canGenerate =
    settingsResolution.canResolve &&
    engineAcceptsNewJobs &&
    isProjectRootReady &&
    !isAnyRunActive;
  const durationSeconds = settingsResolution.canResolve
    ? settingsResolution.settings.durationSeconds
    : resolveStableAudio3TextToAudioDuration(project, patchTab);
  const presentation = createStableAudio3TextToAudioPresentation({
    canGenerate,
    engineAcceptsNewJobs,
    engineAvailabilityMessage,
    isAnyRunActive,
    isProjectRootReady,
    isStateOwner,
    isThisRunActive,
    settingsResolution,
    state,
  });

  return (
    <div className="sa3-t2a-editor">
      <fieldset className="sa3-t2a-parameter-fieldset" disabled={isAnyRunActive}>
        <div className="parameter-bank">
          {patchTab.parameters.map((parameter) => (
            <div className="sa3-t2a-parameter-slot" key={parameter.id}>
              <ParameterControl
                parameter={parameter}
                numberAction={
                  parameter.id === 'seed'
                    ? {
                        ariaLabel: `Randomize ${parameter.label}`,
                        label: 'RND',
                        onClick: () =>
                          onParameterChange(
                            parameter.id,
                            createRandomStableAudio3Seed((values) =>
                              window.crypto.getRandomValues(values),
                            ),
                          ),
                      }
                    : createTimelineLengthNumberAction(
                        parameter,
                        project,
                        (value) => onParameterChange(parameter.id, value),
                      )
                }
                onChange={(value) => onParameterChange(parameter.id, value)}
              />
              {parameter.id === 'bars' && (
                <div className="parameter-row sa3-t2a-duration-row">
                  <span>Duration</span>
                  <output>
                    {durationSeconds === undefined
                      ? '--'
                      : `${formatStableAudio3TextToAudioDuration(durationSeconds)} s`}
                  </output>
                </div>
              )}
            </div>
          ))}
        </div>
      </fieldset>
      <div className={`sa3-t2a-runtime ${presentation.tone}`}>
        <div className="sa3-t2a-status-line">
          <span>Status</span>
          <strong>{presentation.label}</strong>
        </div>
        <p>{presentation.message}</p>
        <button
          type="button"
          className={`patchtab-action-button sa3-t2a-action-button ${canCancel ? 'cancel' : ''}`}
          disabled={isThisRunActive ? !canCancel : !canGenerate}
          onClick={canCancel ? onCancel : onGenerate}
        >
          {isThisRunActive ? (canCancel ? 'CANCEL' : 'WAIT') : 'GENERATE'}
        </button>
      </div>
    </div>
  );
}

function isStableAudio3TextToAudioUiActive(
  state: StableAudio3TextToAudioUiState,
): boolean {
  return (
    state.status === 'ENQUEUEING' ||
    state.status === 'QUEUED' ||
    state.status === 'LOADING_MODEL' ||
    state.status === 'PROCESSING' ||
    state.status === 'SAVING' ||
    state.status === 'CANCEL_REQUESTED'
  );
}

function createStableAudio3TextToAudioPresentation(input: Readonly<{
  canGenerate: boolean;
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  isAnyRunActive: boolean;
  isProjectRootReady: boolean;
  isStateOwner: boolean;
  isThisRunActive: boolean;
  settingsResolution: StableAudio3TextToAudioPatchTabSettingsResolution;
  state: StableAudio3TextToAudioUiState;
}>): Readonly<{
  label: string;
  message: string;
  tone: 'active' | 'error' | 'ready' | 'success' | 'warning';
}> {
  if (input.isThisRunActive) {
    return {
      label: formatStableAudio3TextToAudioStatus(input.state.status),
      message: input.state.message ?? 'SA3 T2A Job is active.',
      tone: 'active',
    };
  }

  if (input.isAnyRunActive) {
    return {
      label: 'ERROR',
      message: 'Another SA3 T2A PatchTab owns the active Job.',
      tone: 'error',
    };
  }

  if (!input.engineAcceptsNewJobs) {
    return {
      label: 'ERROR',
      message: input.engineAvailabilityMessage,
      tone: 'error',
    };
  }

  if (!input.isProjectRootReady) {
    return {
      label: 'ERROR',
      message: 'Select one ready Project Root before generation.',
      tone: 'error',
    };
  }

  if (!input.settingsResolution.canResolve) {
    return {
      label: 'ERROR',
      message: input.settingsResolution.message,
      tone: 'error',
    };
  }

  if (
    input.isStateOwner &&
    input.state.status === 'ERROR' &&
    input.state.message
  ) {
    return { label: 'ERROR', message: input.state.message, tone: 'error' };
  }

  if (
    input.isStateOwner &&
    input.state.status === 'COMPLETED' &&
    input.state.message
  ) {
    return {
      label: 'COMPLETED',
      message: input.state.message,
      tone: 'success',
    };
  }

  if (
    input.isStateOwner &&
    input.state.status === 'CANCELED' &&
    input.state.message
  ) {
    return {
      label: 'CANCELED',
      message: input.state.message,
      tone: 'warning',
    };
  }

  return {
    label: input.canGenerate ? 'READY' : 'ERROR',
    message: `Duration ${formatStableAudio3TextToAudioDuration(input.settingsResolution.settings.durationSeconds)} s / Current limit ${input.settingsResolution.settings.maxBars} Bars.`,
    tone: input.canGenerate ? 'ready' : 'error',
  };
}

function resolveStableAudio3TextToAudioDuration(
  project: ProjectState,
  patchTab: PatchTab,
): number | undefined {
  const bars = patchTab.parameters.find(
    (parameter) => parameter.id === 'bars' && parameter.kind === 'number',
  );

  return bars?.kind === 'number' &&
    Number.isSafeInteger(bars.value) &&
    bars.value > 0 &&
    Number.isFinite(project.bpm) &&
    project.bpm > 0
    ? (bars.value * 4 * 60) / project.bpm
    : undefined;
}

function formatStableAudio3TextToAudioDuration(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(2)));
}

function formatStableAudio3TextToAudioStatus(
  status: StableAudio3TextToAudioUiState['status'],
): string {
  switch (status) {
    case 'LOADING_MODEL':
      return 'LOADING MODEL';
    case 'PROCESSING':
      return 'GENERATING';
    case 'CANCEL_REQUESTED':
      return 'CANCEL REQUESTED';
    case 'FAILED':
    case 'INTERRUPTED':
    case 'PAUSED':
      return 'ERROR';
    default:
      return status;
  }
}

function createStableAudio3TextToAudioRequestToken(requestId: number): string {
  const randomId =
    typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID().toLowerCase()
      : `${Date.now().toString(36)}-${requestId.toString(36)}`;

  return randomId;
}

function PatchTabActionCard({
  ariaBusy = false,
  buttonLabel,
  detail,
  eyebrow,
  isReady,
  title,
  onClick,
}: {
  ariaBusy?: boolean;
  buttonLabel: string;
  detail: string;
  eyebrow: string;
  isReady: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <div
      className={`patchtab-action-card ${isReady ? 'ready' : ''}`}
      aria-busy={ariaBusy}
    >
      <div>
        <span>{eyebrow}</span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      <HelpHint text={`${title}. ${detail}`}>
        <button
          type="button"
          className="patchtab-action-button"
          aria-label={`${buttonLabel}: ${title}`}
          disabled={!isReady}
          onClick={onClick}
        >
          {buttonLabel}
        </button>
      </HelpHint>
    </div>
  );
}

function ParameterControl({
  numberAction,
  parameter,
  onChange,
}: {
  numberAction?: Readonly<{
    ariaLabel: string;
    label: string;
    onClick: () => void;
  }>;
  parameter: PatchTabParameter;
  onChange: (value: PatchTabParameterValue) => void;
}) {
  if (parameter.kind === 'text') {
    return <TextParameterControl parameter={parameter} onChange={onChange} />;
  }

  if (parameter.kind === 'number') {
    return (
      <NumberParameterControl
        action={numberAction}
        parameter={parameter}
        onChange={onChange}
      />
    );
  }

  if (parameter.kind === 'select') {
    return (
      <label className="parameter-row">
        <span>{parameter.label}</span>
        <select value={parameter.value} onChange={(event) => onChange(event.target.value)}>
          {parameter.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return <SliderParameterControl parameter={parameter} onChange={onChange} />;
}

function TextParameterControl({
  parameter,
  onChange,
}: {
  parameter: Extract<PatchTabParameter, { kind: 'text' }>;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(parameter.value);
  const initialValueRef = useRef(parameter.value);
  const skipNextBlurRef = useRef(false);

  useEffect(() => {
    initialValueRef.current = parameter.value;
    setDraftValue(parameter.value);
  }, [parameter.id, parameter.value]);

  const commitValue = () => {
    const nextValue = draftValue.trim();

    setDraftValue(nextValue);
    initialValueRef.current = nextValue;

    if (nextValue !== parameter.value) {
      onChange(nextValue);
    }
  };

  const cancelEdit = () => {
    skipNextBlurRef.current = true;
    setDraftValue(initialValueRef.current);
  };
  const sharedProps = {
    'aria-label': parameter.label,
    className: 'parameter-text-input',
    maxLength: parameter.maxLength,
    placeholder: parameter.placeholder,
    value: draftValue,
    onBlur: () => {
      if (skipNextBlurRef.current) {
        skipNextBlurRef.current = false;
        return;
      }

      commitValue();
    },
    onChange: (
      event: ReactChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setDraftValue(event.target.value),
    onKeyDown: (
      event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      if (event.key === 'Escape') {
        cancelEdit();
        event.currentTarget.blur();
        return;
      }

      if (
        event.key === 'Enter' &&
        (!parameter.multiline || event.ctrlKey || event.metaKey)
      ) {
        event.preventDefault();
        skipNextBlurRef.current = true;
        commitValue();
        event.currentTarget.blur();
      }
    },
  };

  return (
    <label className="parameter-row parameter-row-text">
      <span>{parameter.label}</span>
      <div className="parameter-text-wrap">
        {parameter.multiline ? (
          <textarea {...sharedProps} rows={5} />
        ) : (
          <input {...sharedProps} type="text" />
        )}
        {parameter.maxLength !== undefined && (
          <small>
            {draftValue.length}/{parameter.maxLength}
          </small>
        )}
      </div>
    </label>
  );
}

function NumberParameterControl({
  action,
  disabled = false,
  parameter,
  onChange,
}: {
  action?: Readonly<{
    ariaLabel: string;
    label: string;
    onClick: () => void;
  }>;
  disabled?: boolean;
  parameter: Extract<PatchTabParameter, { kind: 'number' }>;
  onChange: (value: number) => void;
}) {
  const [draftValue, setDraftValue] = useState(String(parameter.value));
  const initialValueRef = useRef(parameter.value);
  const skipNextBlurRef = useRef(false);

  useEffect(() => {
    initialValueRef.current = parameter.value;
    setDraftValue(String(parameter.value));
  }, [parameter.id, parameter.value]);

  const commitValue = () => {
    const parsedValue = Number(draftValue);

    if (!Number.isFinite(parsedValue)) {
      setDraftValue(String(initialValueRef.current));
      return;
    }

    const nextValue = normalizeParameterNumber(
      parsedValue,
      parameter.min,
      parameter.max,
      parameter.step,
    );

    setDraftValue(String(nextValue));
    initialValueRef.current = nextValue;

    if (nextValue !== parameter.value) {
      onChange(nextValue);
    }
  };

  const cancelEdit = () => {
    skipNextBlurRef.current = true;
    setDraftValue(String(initialValueRef.current));
  };

  return (
    <label className="parameter-row">
      <span>{parameter.label}</span>
      <div className={`parameter-number-wrap ${action ? 'has-action' : ''}`}>
        <input
          aria-label={parameter.label}
          className="parameter-number-input"
          disabled={disabled}
          type="number"
          min={parameter.min}
          max={parameter.max}
          step={parameter.step}
          value={draftValue}
          onBlur={() => {
            if (skipNextBlurRef.current) {
              skipNextBlurRef.current = false;
              return;
            }

            commitValue();
          }}
          onChange={(event) => setDraftValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              skipNextBlurRef.current = true;
              commitValue();
              event.currentTarget.blur();
              return;
            }

            if (event.key === 'Escape') {
              cancelEdit();
              event.currentTarget.blur();
            }
          }}
        />
        {parameter.unit && <span>{parameter.unit}</span>}
        {action && (
          <button
            disabled={disabled}
            type="button"
            className="parameter-number-action"
            aria-label={action.ariaLabel}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        )}
      </div>
    </label>
  );
}

function normalizeParameterNumber(
  value: number,
  min: number,
  max: number,
  step: number,
): number {
  const clampedValue = Math.min(max, Math.max(min, value));

  if (!Number.isFinite(step) || step <= 0) {
    return clampedValue;
  }

  const snappedValue =
    min + Math.round((clampedValue - min) / step) * step;
  const normalizedValue =
    Number.isInteger(min) && Number.isInteger(step)
      ? Math.round(snappedValue)
      : Number(snappedValue.toPrecision(15));

  return Math.min(max, Math.max(min, normalizedValue));
}

function SliderParameterControl({
  parameter,
  onChange,
}: {
  parameter: Extract<PatchTabParameter, { kind: 'slider' }>;
  onChange: (value: number) => void;
}) {
  const [displayValue, setDisplayValue] = useState(parameter.value);
  const isEditingRef = useRef(false);
  const initialValueRef = useRef(parameter.value);
  const skipNextBlurRef = useRef(false);

  useEffect(() => {
    initialValueRef.current = parameter.value;

    if (!isEditingRef.current) {
      setDisplayValue(parameter.value);
    }
  }, [parameter.id, parameter.value]);

  const beginEdit = () => {
    isEditingRef.current = true;
    initialValueRef.current = parameter.value;
  };

  const commitValue = (nextValue: number) => {
    isEditingRef.current = false;
    setDisplayValue(nextValue);

    if (nextValue !== initialValueRef.current) {
      initialValueRef.current = nextValue;
      onChange(nextValue);
    }
  };

  const cancelEdit = () => {
    isEditingRef.current = false;
    skipNextBlurRef.current = true;
    setDisplayValue(initialValueRef.current);
  };

  return (
    <label className="parameter-row">
      <span>{parameter.label}</span>
      <div className="slider-wrap">
        <input
          type="range"
          min={parameter.min}
          max={parameter.max}
          step={parameter.step}
          value={displayValue}
          onBlur={(event) => {
            if (skipNextBlurRef.current) {
              skipNextBlurRef.current = false;
              return;
            }

            if (isEditingRef.current) {
              commitValue(Number(event.currentTarget.value));
            }
          }}
          onChange={(event) => setDisplayValue(Number(event.target.value))}
          onFocus={beginEdit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitValue(Number(event.currentTarget.value));
              event.currentTarget.blur();
            }

            if (event.key === 'Escape') {
              cancelEdit();
              event.currentTarget.blur();
            }
          }}
          onPointerCancel={(event) => commitValue(Number(event.currentTarget.value))}
          onPointerDown={(event) => {
            beginEdit();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => commitValue(Number(event.currentTarget.value))}
        />
        <output>
          {displayValue}
          {parameter.unit ?? ''}
        </output>
      </div>
    </label>
  );
}

function RoutingPanel({
  connections,
  isSafetyModeEnabled,
  patchTabs,
  tabFlowLines,
  selectedConnectionId,
  selectedPatchTabId,
  selectedTabFlowLineId,
  onAddTabFlowLine,
  onBuildAutoFlow,
  onDeleteConnection,
  onDeleteEmptyTabFlowLine,
  onRequestSafetyConfirm,
  onSelectConnection,
  onSelectPatchTab,
  onSelectTabFlowLine,
  onSetTabFlowLineEnabled,
}: {
  connections: TabFlowConnection[];
  isSafetyModeEnabled: boolean;
  patchTabs: PatchTab[];
  tabFlowLines: TabFlowLine[] | undefined;
  selectedConnectionId: string;
  selectedPatchTabId: string;
  selectedTabFlowLineId: string;
  onAddTabFlowLine: () => void;
  onBuildAutoFlow: () => void;
  onDeleteConnection: (connectionId: string) => void;
  onDeleteEmptyTabFlowLine: (tabFlowLineId: string) => void;
  onRequestSafetyConfirm: (request: SafetyConfirmDraft) => void;
  onSelectConnection: (connectionId: string) => void;
  onSelectPatchTab: (patchTabId: string) => void;
  onSelectTabFlowLine: (tabFlowLineId: string) => void;
  onSetTabFlowLineEnabled: (tabFlowLineId: string, enabled: boolean) => void;
}) {
  const patchTabMap = useMemo(() => new Map(patchTabs.map((patchTab) => [patchTab.id, patchTab])), [patchTabs]);
  const selectedConnection = connections.find((connection) => connection.id === selectedConnectionId);
  const selectedSourcePatchTab = selectedConnection ? patchTabMap.get(selectedConnection.fromPatchTabId) : undefined;
  const selectedTargetPatchTab = selectedConnection ? patchTabMap.get(selectedConnection.toPatchTabId) : undefined;
  const selectedConnectionState = selectedConnection ? getTabFlowConnectionState(selectedConnection, patchTabMap) : undefined;
  const selectedCompatibility = selectedConnection
    ? getConnectionCompatibility(selectedConnection, patchTabMap)
    : undefined;
  const routingRows = useMemo(
    () => getRoutingFlowRows(connections, tabFlowLines, patchTabs),
    [connections, patchTabs, tabFlowLines],
  );
  const deletionImpactMap = useMemo(
    () =>
      new Map(
        connections.map((connection) => [
          connection.id,
          getConnectionDeletionImpact(connections, tabFlowLines, connection.id),
        ]),
      ),
    [connections, tabFlowLines],
  );
  const selectedDeletionImpact = selectedConnection ? deletionImpactMap.get(selectedConnection.id) : undefined;
  const routingErrorCount = routingRows.filter((row) => getTabFlowRowState(row, patchTabMap) === 'invalid').length;
  const enabledTabFlowLineCount = getEnabledTabFlowFamilyCount(routingRows.map((row) => row.line));
  const selectedRoutingRow = routingRows.find((row) => row.line.id === selectedTabFlowLineId);
  const selectedRoutingRowState = selectedRoutingRow ? getTabFlowRowState(selectedRoutingRow, patchTabMap) : undefined;
  const handleBuildAutoFlowClick = () => {
    if (!isSafetyModeEnabled) {
      onBuildAutoFlow();
      return;
    }

    const nextConnections = buildTabFlowConnections(patchTabs);
    const nextRoutingRows = getRoutingFlowRows(
      nextConnections,
      reconcileTabFlowLines(nextConnections, []),
      patchTabs,
    );

    onRequestSafetyConfirm({
      title: 'Build Auto Flow',
      message: 'Rebuild TabFlow routes from the current PatchTab order.',
      details: [
        `${connections.length} current routes will be replaced`,
        `${routingRows.length} current TabFlow lines`,
        `${nextConnections.length} rebuilt routes`,
        `${nextRoutingRows.length} rebuilt TabFlow lines`,
      ],
      confirmLabel: 'BUILD',
      onConfirm: onBuildAutoFlow,
    });
  };

  return (
    <section className="panel routing-panel" aria-labelledby="routing-heading">
      <PanelHeader
        eyebrow="TabFlow"
        id="routing-heading"
        meter={routingErrorCount > 0 ? `${routingErrorCount} errors` : `${enabledTabFlowLineCount} on`}
        title="Routing"
      />
      <div className="flow-viewport" aria-label="Routing flow diagram">
        <div className="flow-strip">
          {routingRows.length === 0 ? (
            <div className="flow-add-row centered">
              <HelpHint text="Create the first TabFlow Line. Routing is edited inside one selected line at a time.">
                <button
                  type="button"
                  className="tabflow-line-add-button"
                  aria-label="Add TabFlow line"
                  onClick={onAddTabFlowLine}
                >
                  +
                </button>
              </HelpHint>
            </div>
          ) : (
            <>
              {routingRows.map((row) => {
                const rowState = getTabFlowRowState(row, patchTabMap);
                const tabFlowLineLabel = row.displayLabel;
                const isLineSelected = row.line.id === selectedTabFlowLineId;
                const lineStateClass = row.line.enabled ? 'line-on' : 'line-off';
                const canRemoveEmptyLine = routingRows.length > 1 && !row.isChild;

                return (
                  <div
                    key={row.line.id}
                    className={`flow-row ${getConnectionStateClass(rowState)} ${lineStateClass} ${
                      isLineSelected ? 'selected' : ''
                    } ${row.isChild ? 'child-lane' : 'root-lane'}`}
                    onClick={(event) => {
                      if (event.target instanceof HTMLElement && event.target.closest('button')) {
                        return;
                      }

                      onSelectTabFlowLine(row.line.id);
                    }}
                  >
                    <HelpHint
                      text={createTabFlowLineButtonHelpMessage(tabFlowLineLabel, rowState, row.line.enabled)}
                    >
                      <button
                        type="button"
                        className={`tabflow-line-toggle ${getConnectionStateClass(rowState)} ${lineStateClass} ${
                          isLineSelected ? 'selected' : ''
                        }`}
                        aria-label={`Turn TabFlow line ${tabFlowLineLabel} ${row.line.enabled ? 'off' : 'on'}`}
                        aria-pressed={row.line.enabled}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSetTabFlowLineEnabled(row.line.id, !row.line.enabled);
                        }}
                      >
                        {tabFlowLineLabel}
                      </button>
                    </HelpHint>
                    {row.isChild && (
                      <span
                        className="child-lane-indent"
                        style={
                          {
                            '--child-lane-start': row.startIndex,
                          } as CSSProperties
                        }
                        aria-hidden="true"
                      />
                    )}
                    {row.connections.map((connection, connectionIndex) => {
                      const sourcePatchTab = patchTabMap.get(connection.fromPatchTabId);
                      const targetPatchTab = patchTabMap.get(connection.toPatchTabId);
                      const previousConnection = row.connections[connectionIndex - 1];
                      const shouldRenderSource = !previousConnection || previousConnection.toPatchTabId !== connection.fromPatchTabId;
                      const connectionState = getTabFlowConnectionState(connection, patchTabMap);

                      if (!sourcePatchTab || !targetPatchTab) {
                        return null;
                      }

                      const sourceColor = getPatchTabColorCode(sourcePatchTab.colorIndex);
                      const targetColor = getPatchTabColorCode(targetPatchTab.colorIndex);

                      return (
                        <span key={connection.id} className="flow-link">
                          {shouldRenderSource && (
                            <FlowColorNode
                              colorCode={sourceColor}
                              isSelected={selectedPatchTabId === sourcePatchTab.id}
                              patchTab={sourcePatchTab}
                              onSelectPatchTab={onSelectPatchTab}
                            />
                          )}
                          <button
                            type="button"
                            className={`flow-wire ${getConnectionStateClass(connectionState)} ${
                              selectedConnectionId === connection.id ? 'selected' : ''
                            }`}
                            style={
                              {
                                '--wire-from-color': sourceColor.primaryColor,
                                '--wire-to-color': targetColor.primaryColor,
                              } as CSSProperties
                            }
                            aria-label={`Select routing from ${sourcePatchTab.name} to ${targetPatchTab.name}`}
                            title={`${sourcePatchTab.name} to ${targetPatchTab.name}`}
                            onClick={() => onSelectConnection(connection.id)}
                          />
                          <FlowColorNode
                            colorCode={targetColor}
                            isSelected={selectedPatchTabId === targetPatchTab.id}
                            patchTab={targetPatchTab}
                            onSelectPatchTab={onSelectPatchTab}
                          />
                        </span>
                      );
                    })}
                    {row.connections.length === 0 && (
                      <span className="flow-empty-line-group">
                        <span className="flow-empty-line">EMPTY LINE</span>
                        {canRemoveEmptyLine && (
                          <HelpHint text={`Remove empty TabFlow Line ${tabFlowLineLabel}.`}>
                            <button
                              type="button"
                              className="tabflow-line-remove-button"
                              aria-label={`Remove empty TabFlow line ${tabFlowLineLabel}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                onDeleteEmptyTabFlowLine(row.line.id);
                              }}
                            >
                              -
                            </button>
                          </HelpHint>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
              <div className="flow-add-row below">
                <HelpHint text="Create a new empty TabFlow Line. Use it for a separate route.">
                  <button
                    type="button"
                    className="tabflow-line-add-button"
                    aria-label="Add TabFlow line"
                    onClick={onAddTabFlowLine}
                  >
                    +
                  </button>
                </HelpHint>
              </div>
            </>
          )}
        </div>
      </div>
      <div className={`connection-status-card ${selectedConnectionState ? getConnectionStateClass(selectedConnectionState) : ''}`}>
        <span>
          Selected TabFlow Line
          {selectedRoutingRow ? ` ${selectedRoutingRow.displayLabel}` : ''}
        </span>
        {selectedConnection && selectedSourcePatchTab && selectedTargetPatchTab ? (
          <div className="connection-status-content">
            <strong>
              {selectedSourcePatchTab.name} → {selectedTargetPatchTab.name}
            </strong>
            {selectedRoutingRow && <small>{selectedRoutingRow.line.enabled ? 'ON' : 'OFF'}</small>}
            {selectedRoutingRowState && (
              <small>{selectedRoutingRowState === 'invalid' ? 'TYPE MISMATCH' : selectedRoutingRowState.toUpperCase()}</small>
            )}
            <small>OUT {selectedCompatibility?.outputPort?.label ?? selectedConnection.signalType}</small>
            <small>IN {selectedCompatibility?.inputPort?.label ?? selectedTargetPatchTab.inputType}</small>
            <small>{selectedConnectionState === 'enabled' ? `${selectedConnection.latencyMs} ms` : selectedConnectionState === 'disabled' ? 'OFF' : 'ERR'}</small>
            <small>{selectedConnectionState === 'invalid' ? 'TYPE MISMATCH' : selectedConnectionState === 'disabled' ? 'AUTO OFF' : 'TYPE OK'}</small>
            {selectedDeletionImpact && selectedDeletionImpact.downstreamCount > 0 && (
              <small className="connection-delete-impact">
                DELETE REMOVES {selectedDeletionImpact.removedConnections.length} ROUTES
              </small>
            )}
          </div>
        ) : (
          <div className="connection-status-content">
            <strong>No TabFlow Line Selected</strong>
            <small>{connections.length} routes</small>
          </div>
        )}
        <div className="connection-status-actions">
          <HelpHint text="Rebuild TabFlow routes from the current PatchTab order. Safety Mode previews the replacement first.">
            <button type="button" className="connection-action-button secondary" onClick={handleBuildAutoFlowClick}>
              AUTO FLOW
            </button>
          </HelpHint>
        </div>
      </div>
      <div className="connection-list">
        {connections.map((connection) => {
          const sourcePatchTab = patchTabMap.get(connection.fromPatchTabId);
          const targetPatchTab = patchTabMap.get(connection.toPatchTabId);
          const connectionState = getTabFlowConnectionState(connection, patchTabMap);
          const compatibility = getConnectionCompatibility(
            connection,
            patchTabMap,
          );
          const deletionImpact = deletionImpactMap.get(connection.id);

          return (
            <div
              key={connection.id}
              className={`connection-row ${getConnectionStateClass(connectionState)} ${selectedConnectionId === connection.id ? 'selected' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelectConnection(connection.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  onSelectConnection(connection.id);
                }
              }}
            >
              <span
                className={`connection-light ${getConnectionStateClass(connectionState)}`}
                aria-label={
                  connectionState === 'enabled'
                    ? 'Connection enabled'
                    : connectionState === 'disabled'
                      ? 'Connection disabled'
                      : 'Connection error'
                }
              >
                {connectionState === 'invalid' ? 'X' : ''}
              </span>
              <strong>{sourcePatchTab?.name ?? 'Missing Source'}</strong>
              <span>
                {compatibility.outputPort?.label ?? connection.signalType} to{' '}
                {compatibility.inputPort?.label ?? targetPatchTab?.inputType ?? 'Missing Input'}
              </span>
              <strong>{targetPatchTab?.name ?? 'Missing Target'}</strong>
              <small>{connection.enabled ? `${connection.latencyMs} ms` : 'ERR'}</small>
              <HelpHint text={formatConnectionDeletionTitle(deletionImpact)}>
                <button
                  type="button"
                  className="connection-delete-button"
                  aria-label={formatConnectionDeletionAriaLabel(connection, patchTabMap, deletionImpact)}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (isSafetyModeEnabled && deletionImpact?.downstreamCount) {
                      onRequestSafetyConfirm({
                        title: 'Delete TabFlow Routes',
                        message: formatConnectionDeletionMessage(deletionImpact),
                        details: formatConnectionDeletionDetails(deletionImpact, patchTabMap),
                        confirmLabel: 'DELETE',
                        onConfirm: () => onDeleteConnection(connection.id),
                      });
                      return;
                    }
                    onDeleteConnection(connection.id);
                  }}
                >
                  <span className="trash-icon" aria-hidden="true" />
                </button>
              </HelpHint>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FlowColorNode({
  colorCode,
  isSelected,
  patchTab,
  onSelectPatchTab,
}: {
  colorCode: ReturnType<typeof getPatchTabColorCode>;
  isSelected: boolean;
  patchTab: PatchTab;
  onSelectPatchTab: (patchTabId: string) => void;
}) {
  return (
    <button
      type="button"
      className={`flow-color-node ${isSelected ? 'selected' : ''} ${colorCode.isMultiColor ? 'multi-color' : ''}`}
      style={
        {
          '--tab-color': colorCode.primaryColor,
          '--tab-color-secondary': colorCode.secondaryColor,
        } as CSSProperties
      }
      aria-label={`Select ${patchTab.name}`}
      title={patchTab.name}
      onClick={() => onSelectPatchTab(patchTab.id)}
    />
  );
}

function Timeline({
  activeTransport,
  autoPatchHistoryEntries,
  autoPatchProductionState,
  canRunAutoPatchProduction,
  editHistoryItems,
  isHistoryOpen,
  isSafetyModeEnabled,
  isTimelineExpanded,
  isTimelineExpandPending,
  isTimelineExportPreparing,
  sectionRef,
  microphoneInputLevel,
  playheadTick,
  project,
  punchInTick,
  punchOutTick,
  punchSession,
  recordingRuntimePhase,
  selectedClipId,
  selectedClipInfo,
  hasSessionAudioSource,
  revealRequest,
  timelineStatusDiagnostic,
  timelineStatusFeedback,
  timelineClipClipboard,
  totalTicks,
  tracks,
  trackGroupingAvailability,
  onAddBlankTrack,
  onActivateClipTake,
  onGroupSelectedTracks,
  onImportAudio,
  onApplyAutoPatchGuard,
  onRunAutoPatchProduction,
  onCopySelectedTimelineClips,
  onCopyTimelineSelection,
  onDeleteTimelineSelection,
  onLeftTrimTimelineAudioClip,
  onMoveTimelineClip,
  onJumpToEditHistory,
  onOpenHistory,
  onOpenProjectInspector,
  onPreviewClipTake,
  onPreviewPunchAttempt,
  onKeepPunchAttempt,
  onDiscardPunchSession,
  onSelectPunchAttempt,
  onSetPunchMarker,
  onStartPunchRecording,
  onRightResizeTimelineMidiClip,
  onRightTrimTimelineAudioClip,
  onSplitTimelineAudioClip,
  onPasteTimelineClipClipboard,
  onProjectBpmChange,
  onProjectGridResolutionChange,
  onProjectKeyChange,
  onProjectPlayheadChange,
  onRecordingSettingsChange,
  onRequestSafetyConfirm,
  onProjectTotalBarsChange,
  onTimelineSettingRangeWarning,
  onRenameTrack,
  onSelectAutoPatchHistoryClip,
  onSelectClip,
  onSelectTrack,
  onToggleTrackMute,
  onToggleTimelineExpanded,
  onToggleTrackGroup,
  onTransport,
  onUngroupTrack,
}: {
  activeTransport: TransportButton;
  autoPatchHistoryEntries: AutoPatchHistoryEntry[];
  autoPatchProductionState: AutoPatchProductionUiState;
  canRunAutoPatchProduction: boolean;
  editHistoryItems: EditHistoryItem[];
  isHistoryOpen: boolean;
  isSafetyModeEnabled: boolean;
  isTimelineExpanded: boolean;
  isTimelineExpandPending: boolean;
  isTimelineExportPreparing: boolean;
  sectionRef: RefObject<HTMLElement>;
  microphoneInputLevel: number;
  playheadTick: number;
  project: ProjectState;
  punchInTick?: number;
  punchOutTick?: number;
  punchSession?: PunchSession;
  recordingRuntimePhase: RecordingRuntimePhase;
  selectedClipId: string;
  selectedClipInfo?: SelectedClipInfo;
  hasSessionAudioSource: (sourceId: string | undefined) => boolean;
  revealRequest?: TimelineRevealRequest;
  timelineClipClipboard?: TimelineClipClipboard;
  timelineStatusDiagnostic?: TimelineStatusDiagnostic;
  timelineStatusFeedback?: TimelineStatusFeedback;
  totalTicks: number;
  tracks: Track[];
  trackGroupingAvailability: TrackGroupingAvailability;
  onAddBlankTrack: () => void;
  onActivateClipTake: (clipId: string, clipTakeId: string) => void;
  onGroupSelectedTracks: () => void;
  onImportAudio: () => void;
  onApplyAutoPatchGuard: () => void;
  onRunAutoPatchProduction: () => void;
  onCopySelectedTimelineClips: () => void;
  onCopyTimelineSelection: () => void;
  onDeleteTimelineSelection: () => void;
  onLeftTrimTimelineAudioClip: (clipId: string, targetStartTick: number) => void;
  onMoveTimelineClip: (
    clipId: string,
    targetStartTick: number,
    options?: TimelineClipMoveCommitOptions,
  ) => void;
  onJumpToEditHistory: (targetIndex: number) => void;
  onOpenHistory: () => void;
  onOpenProjectInspector: () => void;
  onPreviewClipTake: (clipId: string, clipTakeId: string) => void;
  onPreviewPunchAttempt: () => void;
  onKeepPunchAttempt: () => void;
  onDiscardPunchSession: () => void;
  onSelectPunchAttempt: (punchAttemptId: string) => void;
  onSetPunchMarker: (marker: 'in' | 'out') => void;
  onStartPunchRecording: () => void;
  onRightResizeTimelineMidiClip: (
    clipId: string,
    targetEndTick: number,
  ) => void;
  onRightTrimTimelineAudioClip: (clipId: string, targetEndTick: number) => void;
  onSplitTimelineAudioClip: (clipId: string) => void;
  onPasteTimelineClipClipboard: (targetTrackId?: string) => void;
  onProjectBpmChange: (bpm: number) => boolean | void;
  onProjectGridResolutionChange: (gridResolution: TimelineGridResolution) => void;
  onProjectKeyChange: (key: string) => void;
  onProjectPlayheadChange: (playheadTick: number, options?: ProjectPlayheadChangeOptions) => void;
  onRecordingSettingsChange: (recordingSettings: RecordingSettings) => void;
  onRequestSafetyConfirm: (request: SafetyConfirmDraft) => void;
  onProjectTotalBarsChange: (totalBars: number) => boolean | void;
  onTimelineSettingRangeWarning: (warning: TimelineSettingRangeWarning) => void;
  onRenameTrack: (trackId: string, name: string) => void;
  onSelectAutoPatchHistoryClip: (clipId: string) => void;
  onSelectClip: (clipId: string, selectionMode?: SelectionMode) => void;
  onSelectTrack: (trackId: string, selectionMode?: SelectionMode) => void;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTimelineExpanded: () => void;
  onToggleTrackGroup: (trackId: string) => void;
  onTransport: (button: TransportButton) => void;
  onUngroupTrack: (trackId: string) => void;
}) {
  const [isLineageFocusEnabled, setIsLineageFocusEnabled] = useState(false);
  const [isClipMoveDragging, setIsClipMoveDragging] = useState(false);
  const [clipMovePreview, setClipMovePreview] = useState<TimelineClipMovePreview>();
  const [isClipLeftTrimDragging, setIsClipLeftTrimDragging] = useState(false);
  const [clipLeftTrimPreview, setClipLeftTrimPreview] = useState<TimelineClipLeftTrimPreview>();
  const [isClipRightTrimDragging, setIsClipRightTrimDragging] = useState(false);
  const [clipRightTrimPreview, setClipRightTrimPreview] = useState<TimelineClipRightTrimPreview>();
  const [isPlayheadDragging, setIsPlayheadDragging] = useState(false);
  const [timelineScrollLeft, setTimelineScrollLeftState] = useState(0);
  const [timelineContextMenu, setTimelineContextMenu] = useState<TimelineContextMenuState>();
  const [clipTakeMenu, setClipTakeMenu] = useState<ClipTakeMenuState>();
  const timelineTrackScrollRef = useRef<HTMLDivElement>(null);
  const timelineRulerScrollRef = useRef<HTMLDivElement>(null);
  const timelineHorizontalScrollRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const playbackFollowSuspendedRef = useRef(false);
  const playheadDragRef = useRef<{
    animationFrameId?: number;
    clientX: number;
  }>();
  const clipMoveDragRef = useRef<TimelineClipMoveDragState>();
  const clipLeftTrimDragRef = useRef<TimelineClipLeftTrimDragState>();
  const clipRightTrimDragRef = useRef<TimelineClipRightTrimDragState>();
  const visibleTrackRows = useMemo(
    () => resolveTrackGroupVisibleRows(tracks),
    [tracks],
  );
  const visibleTracks = useMemo(
    () => visibleTrackRows.rows.map((row) => row.track),
    [visibleTrackRows],
  );
  const clipTakeMenuClip = useMemo(
    () =>
      clipTakeMenu
        ? tracks
            .flatMap((track) => track.clips)
            .find((clip) => clip.id === clipTakeMenu.clipId)
        : undefined,
    [clipTakeMenu, tracks],
  );
  const lineage = useMemo(
    () => (selectedClipInfo ? buildClipLineage(tracks, selectedClipInfo.clip) : []),
    [selectedClipInfo, tracks],
  );
  const lineageMemberIds = useMemo(
    () => new Set(lineage.filter((entry) => !entry.isMissing).map((entry) => entry.clipId)),
    [lineage],
  );
  const lineageSourceIds = useMemo(
    () => new Set(lineage.filter((entry) => !entry.isCurrent && !entry.isMissing).map((entry) => entry.clipId)),
    [lineage],
  );
  const selectedClipIds = useMemo(
    () => new Set(project.selection.items.filter((item) => item.type === 'clip').map((item) => item.id)),
    [project.selection.items],
  );
  const selectedTrackIds = useMemo(
    () => new Set(project.selection.items.filter((item) => item.type === 'track').map((item) => item.id)),
    [project.selection.items],
  );
  const selectedClipInfos = useMemo(
    () => getSelectedClipInfos(tracks, selectedClipIds),
    [selectedClipIds, tracks],
  );
  const sourceIssueClipIds = useMemo(
    () => new Set(getProjectSourceFileIssues(tracks).map((issue) => issue.clipId)),
    [tracks],
  );
  const selectedTrackInfos = useMemo(
    () => visibleTracks.filter((track) => selectedTrackIds.has(track.id)),
    [selectedTrackIds, visibleTracks],
  );
  const canFocusLineage = Boolean(selectedClipInfo);
  const safeTotalTicks = Math.max(1, totalTicks);
  const totalDisplayBars = ticksToBars(safeTotalTicks);
  const autoPatchTargetClipInfos = useMemo(
    () => getAutoPatchTargetClipInfos(project.tracks, project.selection, selectedClipInfo),
    [project.selection, project.tracks, selectedClipInfo],
  );
  const timelineCopyAvailability = useMemo(
    () => resolveTimelineCopyAvailability(project.tracks, project.selection),
    [project.selection, project.tracks],
  );
  const timelineClipCopyAvailability = useMemo(
    () => getTimelineClipCopyAvailability(project.tracks, project.selection),
    [project.selection, project.tracks],
  );
  const contextPasteAvailability = useMemo(
    () =>
      getTimelineClipPasteAvailability(
        project,
        project.selection,
        timelineClipClipboard,
        timelineContextMenu?.targetTrackId,
      ),
    [project, timelineClipClipboard, timelineContextMenu?.targetTrackId],
  );
  const contextSplitAvailability = useMemo<TimelineClipSplitAvailability | undefined>(() => {
    const targetClipId = timelineContextMenu?.targetClipId;

    if (!targetClipId) {
      return undefined;
    }

    const displayTrack = tracks.find((track) => track.id === timelineContextMenu.targetTrackId);

    if (displayTrack?.group) {
      return {
        canSplit: false,
        message: 'Expand the group before splitting its source clip.',
      };
    }

    const preview = createProjectAudioClipSplitUpdate(project, targetClipId, playheadTick, safeTotalTicks);

    return preview.canSplit
      ? {
          canSplit: true,
          message: `Beat ${formatTickBeatPosition(preview.rightClip.startTick)} / source ${formatDurationSeconds(
            preview.leftClip.audioTiming.sourceEndSeconds,
          )}`,
        }
      : {
          canSplit: false,
          message: preview.message,
        };
  }, [playheadTick, project, safeTotalTicks, timelineContextMenu, tracks]);
  const autoPatchTargetEligibilities = useMemo(
    () =>
      autoPatchTargetClipInfos.flatMap((target) =>
        getClipAutoPatchEligibilities(project, target.clip).map((eligibility) => ({
          ...eligibility,
          clip: target.clip,
          track: target.track,
        })),
      ),
    [autoPatchTargetClipInfos, project],
  );
  const autoPatchEligibilities = useMemo(
    () => (selectedClipInfo ? getClipAutoPatchEligibilities(project, selectedClipInfo.clip) : []),
    [project, selectedClipInfo],
  );
  const readyAutoPatchCount = autoPatchTargetEligibilities.filter((eligibility) => eligibility.status === 'ready').length;
  const appliedAutoPatchCount = autoPatchTargetEligibilities.filter((eligibility) => eligibility.status === 'applied').length;
  const invalidAutoPatchCount = autoPatchTargetEligibilities.filter((eligibility) => eligibility.status === 'invalid').length;
  const autoPatchButtonTooltip = useMemo(
    () => formatAutoPatchButtonTooltip(autoPatchTargetEligibilities),
    [autoPatchTargetEligibilities],
  );
  const autoPatchProductionPresentation =
    getAutoPatchProductionUiPresentation(autoPatchProductionState);
  const oneShotGenerationFamily = useMemo(
    () => resolveOneShotGenerationFamily(project),
    [project],
  );
  const canStartAutoPatchProduction =
    canRunAutoPatchProduction &&
    (autoPatchTargetClipInfos.length > 0 ||
      oneShotGenerationFamily.canResolve) &&
    !autoPatchProductionPresentation.active;
  const autoPatchProductionTooltip = autoPatchProductionPresentation.active
    ? autoPatchProductionState.message
    : oneShotGenerationFamily.canResolve
      ? 'Run SA3 T2A, then ACE VOCALS, once from Prompt and Lyrics. Project JSON remains unsaved until Save Project.'
    : autoPatchTargetClipInfos.length === 0
      ? 'Select at least one Clip or Track for Production Auto Patch.'
      : canRunAutoPatchProduction
        ? 'Run the executable Auto Patch Stages. Project JSON remains unsaved until Save Project.'
        : 'Production Auto Patch requires an idle Local Engine, a ready Project Root, and stopped recording.';
  const timelineDeletionImpact = useMemo(
    () => getTimelineDeletionImpact(project.tracks, project.selection),
    [project.selection, project.tracks],
  );
  const canDeleteTimelineSelection = timelineDeletionImpact.canDelete;
  const timelineBarTicks = TICKS_PER_BEAT * 4;
  const timelineLanePixelWidth = Math.max(
    TIMELINE_BAR_PIXEL_WIDTH,
    (safeTotalTicks / timelineBarTicks) * TIMELINE_BAR_PIXEL_WIDTH,
  );
  const timelineBarPixelWidth = (timelineBarTicks / safeTotalTicks) * timelineLanePixelWidth;
  const timelineBeatPixelWidth = (TICKS_PER_BEAT / safeTotalTicks) * timelineLanePixelWidth;
  const timelineGridPixelWidth =
    (getTimelineGridResolutionTickStep(project.gridResolution) / safeTotalTicks) * timelineLanePixelWidth;
  const timelineRulerBars = useMemo(
    () =>
      Array.from({ length: Math.max(1, Math.ceil(safeTotalTicks / timelineBarTicks)) }, (_, index) => ({
        barNumber: index + 1,
        startTick: index * timelineBarTicks,
      })),
    [safeTotalTicks, timelineBarTicks],
  );
  const playheadPixel = (playheadTick / safeTotalTicks) * timelineLanePixelWidth;
  const updateClipMovePreviewFromClientX = useCallback(
    (clientX: number) => {
      const dragState = clipMoveDragRef.current;

      if (!dragState) {
        return;
      }

      if (!dragState.didDrag && Math.abs(clientX - dragState.initialClientX) < 4) {
        return;
      }

      dragState.didDrag = true;
      dragState.clientX = clientX;
      const currentScrollLeft = timelineTrackScrollRef.current?.scrollLeft ?? dragState.initialScrollLeft;
      const dragDistance = clientX - dragState.initialClientX + currentScrollLeft - dragState.initialScrollLeft;
      const deltaTicks = (dragDistance / timelineLanePixelWidth) * safeTotalTicks;
      const snappedStartTick = resolveTimelineTick(
        dragState.initialStartTick + deltaTicks,
        project.gridResolution,
        safeTotalTicks,
      );
      const maxStartTick = Math.max(0, safeTotalTicks - dragState.lengthTicks);
      const startTick = clampTick(snappedStartTick, 0, maxStartTick);
      const preview = createTimelineClipMoveUpdate(tracks, dragState.clipId, startTick, safeTotalTicks);

      dragState.startTick = startTick;
      dragState.canMove = preview.canMove;
      setClipMovePreview({
        canMove: preview.canMove,
        clipId: dragState.clipId,
        startTick,
      });
    },
    [project.gridResolution, safeTotalTicks, timelineLanePixelWidth, tracks],
  );
  const finishClipMoveDrag = useCallback(
    (shouldCommit: boolean) => {
      const dragState = clipMoveDragRef.current;

      if (shouldCommit && dragState?.didDrag) {
        onMoveTimelineClip(dragState.clipId, dragState.startTick, { snapToAdjacentOnOverlap: true });
      }

      clipMoveDragRef.current = undefined;
      setClipMovePreview(undefined);
      setIsClipMoveDragging(false);
    },
    [onMoveTimelineClip],
  );
  const handleClipMovePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, clip: Clip, track: Track) => {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || track.group) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (selectedClipIds.size !== 1 || !selectedClipIds.has(clip.id)) {
        onSelectClip(clip.id, 'replace');
      }

      clipMoveDragRef.current = {
        canMove: true,
        clientX: event.clientX,
        clipId: clip.id,
        didDrag: false,
        initialClientX: event.clientX,
        initialScrollLeft: timelineTrackScrollRef.current?.scrollLeft ?? timelineScrollLeft,
        initialStartTick: clip.startTick,
        lengthTicks: clip.lengthTicks,
        startTick: clip.startTick,
      };
      setClipMovePreview({ canMove: true, clipId: clip.id, startTick: clip.startTick });
      setIsClipMoveDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
    },
    [onSelectClip, selectedClipIds, timelineScrollLeft],
  );
  const handleClipMovePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, clipId: string) => {
      if (clipMoveDragRef.current?.clipId !== clipId) {
        return;
      }

      updateClipMovePreviewFromClientX(event.clientX);
      event.preventDefault();
      event.stopPropagation();
    },
    [updateClipMovePreviewFromClientX],
  );
  const handleClipMovePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, clipId: string, shouldCommit: boolean) => {
      if (clipMoveDragRef.current?.clipId !== clipId) {
        return;
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      event.preventDefault();
      event.stopPropagation();
      finishClipMoveDrag(shouldCommit);
    },
    [finishClipMoveDrag],
  );
  const handleClipMoveKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, clip: Clip, track: Track) => {
      if (track.group || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
        return;
      }

      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const gridStep = getTimelineGridResolutionTickStep(project.gridResolution);
      const maxStartTick = Math.max(0, safeTotalTicks - clip.lengthTicks);
      const startTick = clampTick(clip.startTick + direction * gridStep, 0, maxStartTick);

      event.preventDefault();
      event.stopPropagation();
      onMoveTimelineClip(clip.id, startTick);
    },
    [onMoveTimelineClip, project.gridResolution, safeTotalTicks],
  );
  const updateClipLeftTrimPreviewFromClientX = useCallback(
    (clientX: number) => {
      const dragState = clipLeftTrimDragRef.current;

      if (!dragState) {
        return;
      }

      if (!dragState.didDrag && Math.abs(clientX - dragState.initialClientX) < 4) {
        return;
      }

      dragState.didDrag = true;
      dragState.clientX = clientX;
      const currentScrollLeft = timelineTrackScrollRef.current?.scrollLeft ?? dragState.initialScrollLeft;
      const dragDistance = clientX - dragState.initialClientX + currentScrollLeft - dragState.initialScrollLeft;
      const deltaTicks = (dragDistance / timelineLanePixelWidth) * safeTotalTicks;
      const snappedStartTick = resolveTimelineTick(
        dragState.initialStartTick + deltaTicks,
        project.gridResolution,
        safeTotalTicks,
      );
      const startTick = clampTick(snappedStartTick, 0, dragState.endTick - 1);
      const preview = createAudioClipLeftTrimUpdate(
        tracks,
        dragState.clipId,
        startTick,
        safeTotalTicks,
        project.bpm,
      );

      dragState.startTick = startTick;
      dragState.lengthTicks = dragState.endTick - startTick;
      dragState.canTrim = preview.canTrim;
      setClipLeftTrimPreview({
        canTrim: preview.canTrim,
        clipId: dragState.clipId,
        lengthTicks: dragState.lengthTicks,
        startTick,
      });
    },
    [project.bpm, project.gridResolution, safeTotalTicks, timelineLanePixelWidth, tracks],
  );
  const finishClipLeftTrimDrag = useCallback(
    (shouldCommit: boolean) => {
      const dragState = clipLeftTrimDragRef.current;

      if (shouldCommit && dragState?.didDrag) {
        onLeftTrimTimelineAudioClip(dragState.clipId, dragState.startTick);
      }

      clipLeftTrimDragRef.current = undefined;
      setClipLeftTrimPreview(undefined);
      setIsClipLeftTrimDragging(false);
    },
    [onLeftTrimTimelineAudioClip],
  );
  const handleClipLeftTrimPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, clip: Clip) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (selectedClipIds.size !== 1 || !selectedClipIds.has(clip.id)) {
        onSelectClip(clip.id, 'replace');
      }

      const endTick = clip.startTick + clip.lengthTicks;

      clipLeftTrimDragRef.current = {
        canTrim: true,
        clientX: event.clientX,
        clipId: clip.id,
        didDrag: false,
        endTick,
        initialClientX: event.clientX,
        initialScrollLeft: timelineTrackScrollRef.current?.scrollLeft ?? timelineScrollLeft,
        initialStartTick: clip.startTick,
        lengthTicks: clip.lengthTicks,
        startTick: clip.startTick,
      };
      setClipLeftTrimPreview({
        canTrim: true,
        clipId: clip.id,
        lengthTicks: clip.lengthTicks,
        startTick: clip.startTick,
      });
      setIsClipLeftTrimDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
    },
    [onSelectClip, selectedClipIds, timelineScrollLeft],
  );
  const handleClipLeftTrimPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, clipId: string) => {
      if (clipLeftTrimDragRef.current?.clipId !== clipId) {
        return;
      }

      updateClipLeftTrimPreviewFromClientX(event.clientX);
      event.preventDefault();
      event.stopPropagation();
    },
    [updateClipLeftTrimPreviewFromClientX],
  );
  const handleClipLeftTrimPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, clipId: string, shouldCommit: boolean) => {
      if (clipLeftTrimDragRef.current?.clipId !== clipId) {
        return;
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      event.preventDefault();
      event.stopPropagation();
      finishClipLeftTrimDrag(shouldCommit);
    },
    [finishClipLeftTrimDrag],
  );
  const handleClipLeftTrimKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, clip: Clip) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }

      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const gridStep = getTimelineGridResolutionTickStep(project.gridResolution);
      const endTick = clip.startTick + clip.lengthTicks;
      const targetStartTick = clampTick(clip.startTick + direction * gridStep, 0, endTick - 1);

      event.preventDefault();
      event.stopPropagation();
      onLeftTrimTimelineAudioClip(clip.id, targetStartTick);
    },
    [onLeftTrimTimelineAudioClip, project.gridResolution],
  );
  const updateClipRightTrimPreviewFromClientX = useCallback(
    (clientX: number) => {
      const dragState = clipRightTrimDragRef.current;

      if (!dragState) {
        return;
      }

      if (!dragState.didDrag && Math.abs(clientX - dragState.initialClientX) < 4) {
        return;
      }

      dragState.didDrag = true;
      dragState.clientX = clientX;
      const currentScrollLeft = timelineTrackScrollRef.current?.scrollLeft ?? dragState.initialScrollLeft;
      const dragDistance = clientX - dragState.initialClientX + currentScrollLeft - dragState.initialScrollLeft;
      const deltaTicks = (dragDistance / timelineLanePixelWidth) * safeTotalTicks;
      const snappedEndTick = resolveTimelineTick(
        dragState.initialEndTick + deltaTicks,
        project.gridResolution,
        safeTotalTicks,
      );
      const requestedEndTick = clampTick(
        snappedEndTick,
        dragState.startTick + 1,
        safeTotalTicks,
      );
      const endTick =
        dragState.operation === 'midi-resize'
          ? Math.max(requestedEndTick, dragState.minimumEndTick)
          : requestedEndTick;
      const canApply =
        dragState.operation === 'midi-resize'
          ? canPreviewMidiClipRightResize(
              tracks,
              dragState.clipId,
              endTick,
              safeTotalTicks,
              dragState.minimumEndTick,
            )
          : createAudioClipRightTrimUpdate(
              tracks,
              dragState.clipId,
              endTick,
              safeTotalTicks,
              project.bpm,
            ).canTrim;

      dragState.endTick = endTick;
      dragState.lengthTicks = endTick - dragState.startTick;
      dragState.canTrim = canApply;
      setClipRightTrimPreview({
        canTrim: canApply,
        clipId: dragState.clipId,
        endTick,
        lengthTicks: dragState.lengthTicks,
      });
    },
    [project.bpm, project.gridResolution, safeTotalTicks, timelineLanePixelWidth, tracks],
  );
  const finishClipRightTrimDrag = useCallback(
    (shouldCommit: boolean) => {
      const dragState = clipRightTrimDragRef.current;

      if (shouldCommit && dragState?.didDrag) {
        if (dragState.operation === 'midi-resize') {
          onRightResizeTimelineMidiClip(dragState.clipId, dragState.endTick);
        } else {
          onRightTrimTimelineAudioClip(dragState.clipId, dragState.endTick);
        }
      }

      clipRightTrimDragRef.current = undefined;
      setClipRightTrimPreview(undefined);
      setIsClipRightTrimDragging(false);
    },
    [onRightResizeTimelineMidiClip, onRightTrimTimelineAudioClip],
  );
  const handleClipRightTrimPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, clip: Clip) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (selectedClipIds.size !== 1 || !selectedClipIds.has(clip.id)) {
        onSelectClip(clip.id, 'replace');
      }

      const endTick = clip.startTick + clip.lengthTicks;
      const operation = isMidiClip(clip) ? 'midi-resize' : 'audio-trim';
      const midiSafety =
        operation === 'midi-resize'
          ? resolveMidiClipRightResizeSafety(project, clip.id)
          : undefined;

      clipRightTrimDragRef.current = {
        canTrim: true,
        clientX: event.clientX,
        clipId: clip.id,
        didDrag: false,
        endTick,
        initialClientX: event.clientX,
        initialEndTick: endTick,
        initialScrollLeft: timelineTrackScrollRef.current?.scrollLeft ?? timelineScrollLeft,
        lengthTicks: clip.lengthTicks,
        minimumEndTick:
          midiSafety?.canResolve ? midiSafety.minimumEndTick : endTick,
        operation,
        startTick: clip.startTick,
      };
      setClipRightTrimPreview({ canTrim: true, clipId: clip.id, endTick, lengthTicks: clip.lengthTicks });
      setIsClipRightTrimDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
    },
    [onSelectClip, project, selectedClipIds, timelineScrollLeft],
  );
  const handleClipRightTrimPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, clipId: string) => {
      if (clipRightTrimDragRef.current?.clipId !== clipId) {
        return;
      }

      updateClipRightTrimPreviewFromClientX(event.clientX);
      event.preventDefault();
      event.stopPropagation();
    },
    [updateClipRightTrimPreviewFromClientX],
  );
  const handleClipRightTrimPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, clipId: string, shouldCommit: boolean) => {
      if (clipRightTrimDragRef.current?.clipId !== clipId) {
        return;
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      event.preventDefault();
      event.stopPropagation();
      finishClipRightTrimDrag(shouldCommit);
    },
    [finishClipRightTrimDrag],
  );
  const handleClipRightTrimKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, clip: Clip) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }

      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const gridStep = getTimelineGridResolutionTickStep(project.gridResolution);
      const currentEndTick = clip.startTick + clip.lengthTicks;
      const targetEndTick = clampTick(currentEndTick + direction * gridStep, clip.startTick + 1, safeTotalTicks);

      event.preventDefault();
      event.stopPropagation();
      if (isMidiClip(clip)) {
        onRightResizeTimelineMidiClip(clip.id, targetEndTick);
      } else {
        onRightTrimTimelineAudioClip(clip.id, targetEndTick);
      }
    },
    [
      onRightResizeTimelineMidiClip,
      onRightTrimTimelineAudioClip,
      project.gridResolution,
      safeTotalTicks,
    ],
  );
  const getVisibleTimelineLanePixelWidth = useCallback(() => {
    const horizontalScroll = timelineHorizontalScrollRef.current;

    if (horizontalScroll) {
      return Math.max(1, horizontalScroll.clientWidth);
    }

    const trackScroll = timelineTrackScrollRef.current;
    const timelineBody = timelineBodyRef.current;

    if (!trackScroll || !timelineBody) {
      return timelineLanePixelWidth;
    }

    const labelWidth = parseCssPixelValue(
      getComputedStyle(timelineBody).getPropertyValue('--timeline-label-width'),
      216,
    );

    return Math.max(1, trackScroll.clientWidth - labelWidth);
  }, [timelineLanePixelWidth]);
  const playheadViewportPixel = clampNumber(
    playheadPixel - timelineScrollLeft,
    0,
    getVisibleTimelineLanePixelWidth(),
  );
  const getTimelineLaneClientBounds = useCallback(() => {
    const horizontalScroll = timelineHorizontalScrollRef.current;

    if (horizontalScroll) {
      const rect = horizontalScroll.getBoundingClientRect();

      return { left: rect.left, right: rect.right };
    }

    const trackScroll = timelineTrackScrollRef.current;
    const timelineBody = timelineBodyRef.current;

    if (!trackScroll || !timelineBody) {
      return undefined;
    }

    const labelWidth = parseCssPixelValue(
      getComputedStyle(timelineBody).getPropertyValue('--timeline-label-width'),
      216,
    );
    const rect = trackScroll.getBoundingClientRect();

    return { left: rect.left + labelWidth, right: rect.right };
  }, []);
  const clampClientXToTimelineLane = useCallback(
    (clientX: number) => {
      const bounds = getTimelineLaneClientBounds();

      if (!bounds) {
        return clientX;
      }

      return clampNumber(clientX, bounds.left, bounds.right);
    },
    [getTimelineLaneClientBounds],
  );
  const getMaxTimelineScrollLeft = useCallback(() => {
    const trackScroll = timelineTrackScrollRef.current;
    const timelineBody = timelineBodyRef.current;

    if (!trackScroll || !timelineBody) {
      return 0;
    }

    return Math.max(0, timelineBody.scrollWidth - trackScroll.clientWidth);
  }, []);
  const setTimelineScrollLeft = useCallback(
    (scrollLeft: number) => {
      const nextScrollLeft = Math.min(Math.max(scrollLeft, 0), getMaxTimelineScrollLeft());

      [timelineTrackScrollRef.current, timelineRulerScrollRef.current, timelineHorizontalScrollRef.current].forEach((element) => {
        if (element && Math.abs(element.scrollLeft - nextScrollLeft) > 0.5) {
          element.scrollLeft = nextScrollLeft;
        }
      });
      setTimelineScrollLeftState((currentScrollLeft) =>
        Math.abs(currentScrollLeft - nextScrollLeft) > 0.5 ? nextScrollLeft : currentScrollLeft,
      );
    },
    [getMaxTimelineScrollLeft],
  );
  const revealSelectedClipInTimeline = useCallback(
    (clipId: string) => {
      if (!clipId) {
        return;
      }

      const trackScroll = timelineTrackScrollRef.current;
      const timelineBody = timelineBodyRef.current;

      if (!trackScroll || !timelineBody) {
        return;
      }

      const clipElement = Array.from(timelineBody.querySelectorAll<HTMLElement>('[data-clip-id]')).find(
        (element) => element.dataset.clipId === clipId,
      );

      if (!clipElement) {
        return;
      }

      const clipRect = clipElement.getBoundingClientRect();
      const trackScrollRect = trackScroll.getBoundingClientRect();
      const laneBounds = getTimelineLaneClientBounds();

      trackScroll.scrollTop = getNearestScrollOffset({
        currentOffset: trackScroll.scrollTop,
        maxOffset: Math.max(0, trackScroll.scrollHeight - trackScroll.clientHeight),
        targetEnd: clipRect.bottom,
        targetStart: clipRect.top,
        viewportEnd: trackScrollRect.bottom,
        viewportStart: trackScrollRect.top,
      });

      if (laneBounds) {
        setTimelineScrollLeft(
          getNearestScrollOffset({
            currentOffset: trackScroll.scrollLeft,
            maxOffset: getMaxTimelineScrollLeft(),
            targetEnd: clipRect.right,
            targetStart: clipRect.left,
            viewportEnd: laneBounds.right,
            viewportStart: laneBounds.left,
          }),
        );
      }
    },
    [getMaxTimelineScrollLeft, getTimelineLaneClientBounds, setTimelineScrollLeft],
  );
  const syncTimelineScrollLeft = useCallback((source: 'tracks' | 'ruler' | 'bar') => {
    const trackScroll = timelineTrackScrollRef.current;
    const rulerScroll = timelineRulerScrollRef.current;
    const horizontalScroll = timelineHorizontalScrollRef.current;
    const sourceElement = source === 'tracks' ? trackScroll : source === 'ruler' ? rulerScroll : horizontalScroll;

    if (!sourceElement) {
      return;
    }

    setTimelineScrollLeft(sourceElement.scrollLeft);
  }, [setTimelineScrollLeft]);

  const suspendPlaybackFollow = useCallback(() => {
    if (activeTransport === 'PLAY') {
      playbackFollowSuspendedRef.current = true;
    }
  }, [activeTransport]);

  useEffect(() => {
    if (activeTransport === 'PLAY') {
      playbackFollowSuspendedRef.current = false;
    }
  }, [activeTransport]);

  useEffect(() => {
    if (activeTransport !== 'PLAY' || playbackFollowSuspendedRef.current) {
      return;
    }

    const visibleLaneWidth = getVisibleTimelineLanePixelWidth();
    const currentScrollLeft = timelineTrackScrollRef.current?.scrollLeft ?? timelineScrollLeft;
    const leftFollowBoundary = currentScrollLeft + visibleLaneWidth * TIMELINE_PLAYBACK_FOLLOW_LEFT_RATIO;
    const rightFollowBoundary = currentScrollLeft + visibleLaneWidth * TIMELINE_PLAYBACK_FOLLOW_RIGHT_RATIO;

    if (playheadPixel < leftFollowBoundary || playheadPixel > rightFollowBoundary) {
      setTimelineScrollLeft(playheadPixel - visibleLaneWidth * TIMELINE_PLAYBACK_FOLLOW_TARGET_RATIO);
    }
  }, [
    activeTransport,
    getVisibleTimelineLanePixelWidth,
    playheadPixel,
    setTimelineScrollLeft,
    timelineScrollLeft,
  ]);

  useEffect(() => {
    revealSelectedClipInTimeline(selectedClipId);
  }, [revealSelectedClipInTimeline, selectedClipId]);

  useEffect(() => {
    if (!revealRequest) {
      return;
    }

    revealSelectedClipInTimeline(revealRequest.clipId);
  }, [revealRequest, revealSelectedClipInTimeline]);
  const getPlayheadTickFromClientX = useCallback(
    (clientX: number, options: ProjectPlayheadChangeOptions = {}) => {
      const timelineBody = timelineBodyRef.current;

      if (!timelineBody) {
        return 0;
      }

      const labelWidth = parseCssPixelValue(
        getComputedStyle(timelineBody).getPropertyValue('--timeline-label-width'),
        216,
      );
      const timelineBodyRect = timelineBody.getBoundingClientRect();
      const laneLeft = timelineBodyRect.left + labelWidth;
      const rawTick = ((clientX - laneLeft) / timelineLanePixelWidth) * safeTotalTicks;

      return options.snapToGrid === false
        ? clampTick(Math.round(rawTick), 0, safeTotalTicks)
        : resolveTimelineTick(rawTick, project.gridResolution, safeTotalTicks);
    },
    [project.gridResolution, safeTotalTicks, timelineLanePixelWidth],
  );
  const updatePlayheadFromClientX = useCallback(
    (clientX: number, options: ProjectPlayheadChangeOptions = {}) => {
      onProjectPlayheadChange(
        getPlayheadTickFromClientX(clampClientXToTimelineLane(clientX), options),
        options,
      );
    },
    [clampClientXToTimelineLane, getPlayheadTickFromClientX, onProjectPlayheadChange],
  );
  const runPlayheadDragFrame = useCallback(() => {
    const dragState = playheadDragRef.current;
    const trackScroll = timelineTrackScrollRef.current;
    let isEdgeAutoScrolling = false;

    if (!dragState) {
      return;
    }

    if (trackScroll) {
      const laneBounds = getTimelineLaneClientBounds();
      const leftEdgeStart = laneBounds?.left ?? trackScroll.getBoundingClientRect().left;
      const rightEdgeStart = laneBounds?.right ?? trackScroll.getBoundingClientRect().right;
      const rightEdgeThreshold = 48;
      const leftEdgeAccelerationRange = 48;
      const maxScrollStep = 22;
      let scrollStep = 0;

      if (dragState.clientX <= leftEdgeStart) {
        const distance = Math.min(leftEdgeAccelerationRange, leftEdgeStart - dragState.clientX);
        scrollStep = -Math.max(1, Math.ceil((distance / leftEdgeAccelerationRange) * maxScrollStep));
      } else if (dragState.clientX > rightEdgeStart - rightEdgeThreshold) {
        const distance = Math.min(rightEdgeThreshold, dragState.clientX - (rightEdgeStart - rightEdgeThreshold));
        scrollStep = Math.ceil((distance / rightEdgeThreshold) * maxScrollStep);
      }

      if (scrollStep !== 0) {
        isEdgeAutoScrolling = true;
        setTimelineScrollLeft(trackScroll.scrollLeft + scrollStep);
      }
    }

    updatePlayheadFromClientX(dragState.clientX, isEdgeAutoScrolling ? { snapToGrid: false } : undefined);
    dragState.animationFrameId = window.requestAnimationFrame(runPlayheadDragFrame);
  }, [getTimelineLaneClientBounds, setTimelineScrollLeft, updatePlayheadFromClientX]);
  const stopPlayheadDrag = useCallback(() => {
    const dragState = playheadDragRef.current;

    if (dragState) {
      updatePlayheadFromClientX(dragState.clientX);
    }

    if (dragState?.animationFrameId !== undefined) {
      window.cancelAnimationFrame(dragState.animationFrameId);
    }

    playheadDragRef.current = undefined;
    setIsPlayheadDragging(false);
  }, [updatePlayheadFromClientX]);
  const handlePlayheadPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const previousDragState = playheadDragRef.current;

      if (previousDragState?.animationFrameId !== undefined) {
        window.cancelAnimationFrame(previousDragState.animationFrameId);
      }

      playheadDragRef.current = { clientX: event.clientX };
      updatePlayheadFromClientX(event.clientX);
      setIsPlayheadDragging(true);
      event.currentTarget.focus();
    },
    [updatePlayheadFromClientX],
  );
  const handleTimelineRulerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      updatePlayheadFromClientX(event.clientX);
      event.currentTarget.focus();
    },
    [updatePlayheadFromClientX],
  );
  const handlePlayheadKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const step = event.shiftKey ? TICKS_PER_BEAT * 4 : TICKS_PER_BEAT;
      let nextTick = playheadTick;

      if (event.key === 'ArrowLeft') {
        nextTick -= step;
      } else if (event.key === 'ArrowRight') {
        nextTick += step;
      } else if (event.key === 'Home') {
        nextTick = 0;
      } else if (event.key === 'End') {
        nextTick = safeTotalTicks;
      } else {
        return;
      }

      event.preventDefault();
      onProjectPlayheadChange(clampTick(nextTick, 0, safeTotalTicks));
    },
    [onProjectPlayheadChange, playheadTick, safeTotalTicks],
  );
  const handlePatchCheckButtonClick = () => {
    if (!isSafetyModeEnabled) {
      onApplyAutoPatchGuard();
      return;
    }

    onRequestSafetyConfirm({
      title: 'Confirm Patch Check',
      message: formatAutoPatchConfirmMessage(autoPatchTargetClipInfos),
      details: formatAutoPatchConfirmDetails(autoPatchTargetEligibilities),
      confirmLabel: 'PATCH CHECK',
      onConfirm: onApplyAutoPatchGuard,
    });
  };

  const handleProductionAutoPatchButtonClick = () => {
    if (!isSafetyModeEnabled) {
      onRunAutoPatchProduction();
      return;
    }

    onRequestSafetyConfirm({
      title: 'Confirm Production Auto Patch',
      message: oneShotGenerationFamily.canResolve
        ? 'Run ONE SHOT GENERATION from Prompt and Lyrics.'
        : `Run Production Auto Patch for ${formatCount(
            autoPatchTargetClipInfos.length,
            'target Clip',
          )}.`,
      details: [
        'Project JSON will remain unsaved until Save Project.',
        'Completed Stage outputs are preserved if a later Stage fails or is canceled.',
      ],
      confirmLabel: 'RUN PATCH',
      onConfirm: onRunAutoPatchProduction,
    });
  };

  const openTimelineContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    nextContextMenu: Omit<TimelineContextMenuState, 'x' | 'y'>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setTimelineContextMenu({
      ...nextContextMenu,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const openClipTakeMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    clip: Clip,
  ) => {
    const clipTakes = clip.clipTakes ?? [];

    if (clipTakes.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onSelectClip(clip.id, 'replace');

    if (clipTakeMenu?.clipId === clip.id) {
      setClipTakeMenu(undefined);
      return;
    }

    const triggerBounds = event.currentTarget.getBoundingClientRect();
    const popoverWidth = 292;
    const estimatedHeight = Math.min(330, 150 + clipTakes.length * 43);
    const left = Math.max(
      8,
      Math.min(triggerBounds.left, window.innerWidth - popoverWidth - 8),
    );
    const top =
      triggerBounds.bottom + estimatedHeight + 8 <= window.innerHeight
        ? triggerBounds.bottom + 6
        : Math.max(8, triggerBounds.top - estimatedHeight - 6);
    const currentCandidate =
      clipTakeMenu?.clipId === clip.id
        ? clipTakeMenu.candidateClipTakeId
        : undefined;
    const candidateClipTakeId =
      clipTakes.some((take) => take.clipTakeId === currentCandidate)
        ? currentCandidate!
        : clipTakes.some(
              (take) => take.clipTakeId === clip.activeClipTakeId,
            )
          ? clip.activeClipTakeId!
          : clipTakes[0].clipTakeId;

    setClipTakeMenu({
      candidateClipTakeId,
      clipId: clip.id,
      left,
      top,
    });
  };

  const handleClipTakeBadgeWheel = (
    event: ReactWheelEvent<HTMLButtonElement>,
    clip: Clip,
  ) => {
    const clipTakes = clip.clipTakes ?? [];

    if (
      clipTakes.length < 2 ||
      (document.activeElement !== event.currentTarget &&
        clipTakeMenu?.clipId !== clip.id)
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const currentCandidateId =
      clipTakeMenu?.clipId === clip.id
        ? clipTakeMenu.candidateClipTakeId
        : clip.activeClipTakeId;
    const currentIndex = Math.max(
      0,
      clipTakes.findIndex((take) => take.clipTakeId === currentCandidateId),
    );
    const direction = event.deltaY < 0 ? -1 : 1;
    const nextIndex =
      (currentIndex + direction + clipTakes.length) % clipTakes.length;
    const triggerBounds = event.currentTarget.getBoundingClientRect();
    const popoverWidth = 292;
    const estimatedHeight = Math.min(330, 150 + clipTakes.length * 43);

    onSelectClip(clip.id, 'replace');
    setClipTakeMenu({
      candidateClipTakeId: clipTakes[nextIndex].clipTakeId,
      clipId: clip.id,
      left: Math.max(
        8,
        Math.min(triggerBounds.left, window.innerWidth - popoverWidth - 8),
      ),
      top:
        triggerBounds.bottom + estimatedHeight + 8 <= window.innerHeight
          ? triggerBounds.bottom + 6
          : Math.max(8, triggerBounds.top - estimatedHeight - 6),
    });
  };

  useEffect(() => {
    if (!isClipMoveDragging) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finishClipMoveDrag(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [finishClipMoveDrag, isClipMoveDragging]);

  useEffect(() => {
    if (!isClipLeftTrimDragging) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finishClipLeftTrimDrag(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [finishClipLeftTrimDrag, isClipLeftTrimDragging]);

  useEffect(() => {
    if (!isClipRightTrimDragging) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finishClipRightTrimDrag(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [finishClipRightTrimDrag, isClipRightTrimDragging]);

  useEffect(() => {
    if (!isClipMoveDragging) {
      return undefined;
    }

    let animationFrameId = 0;
    const runClipMoveAutoScrollFrame = () => {
      const dragState = clipMoveDragRef.current;
      const trackScroll = timelineTrackScrollRef.current;

      if (!dragState) {
        return;
      }

      if (dragState.didDrag && trackScroll) {
        const laneBounds = getTimelineLaneClientBounds();

        if (laneBounds) {
          const scrollStep = getTimelineClipEdgeAutoScrollStep(
            dragState.clientX,
            laneBounds.left,
            laneBounds.right,
          );

          if (scrollStep !== 0) {
            const previousScrollLeft = trackScroll.scrollLeft;
            setTimelineScrollLeft(previousScrollLeft + scrollStep);

            if (Math.abs(trackScroll.scrollLeft - previousScrollLeft) > 0.5) {
              updateClipMovePreviewFromClientX(dragState.clientX);
            }
          }
        }
      }

      animationFrameId = window.requestAnimationFrame(runClipMoveAutoScrollFrame);
    };

    animationFrameId = window.requestAnimationFrame(runClipMoveAutoScrollFrame);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [
    getTimelineLaneClientBounds,
    isClipMoveDragging,
    setTimelineScrollLeft,
    updateClipMovePreviewFromClientX,
  ]);

  useEffect(() => {
    if (!isClipLeftTrimDragging) {
      return undefined;
    }

    let animationFrameId = 0;
    const runClipLeftTrimAutoScrollFrame = () => {
      const dragState = clipLeftTrimDragRef.current;
      const trackScroll = timelineTrackScrollRef.current;

      if (!dragState) {
        return;
      }

      if (dragState.didDrag && trackScroll) {
        const laneBounds = getTimelineLaneClientBounds();

        if (laneBounds) {
          const scrollStep = getTimelineClipEdgeAutoScrollStep(
            dragState.clientX,
            laneBounds.left,
            laneBounds.right,
          );

          if (scrollStep !== 0) {
            const previousScrollLeft = trackScroll.scrollLeft;
            setTimelineScrollLeft(previousScrollLeft + scrollStep);

            if (Math.abs(trackScroll.scrollLeft - previousScrollLeft) > 0.5) {
              updateClipLeftTrimPreviewFromClientX(dragState.clientX);
            }
          }
        }
      }

      animationFrameId = window.requestAnimationFrame(runClipLeftTrimAutoScrollFrame);
    };

    animationFrameId = window.requestAnimationFrame(runClipLeftTrimAutoScrollFrame);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [
    getTimelineLaneClientBounds,
    isClipLeftTrimDragging,
    setTimelineScrollLeft,
    updateClipLeftTrimPreviewFromClientX,
  ]);

  useEffect(() => {
    if (!isClipRightTrimDragging) {
      return undefined;
    }

    let animationFrameId = 0;
    const runClipRightTrimAutoScrollFrame = () => {
      const dragState = clipRightTrimDragRef.current;
      const trackScroll = timelineTrackScrollRef.current;

      if (!dragState) {
        return;
      }

      if (dragState.didDrag && trackScroll) {
        const laneBounds = getTimelineLaneClientBounds();

        if (laneBounds) {
          const scrollStep = getTimelineClipEdgeAutoScrollStep(
            dragState.clientX,
            laneBounds.left,
            laneBounds.right,
          );

          if (scrollStep !== 0) {
            const previousScrollLeft = trackScroll.scrollLeft;
            setTimelineScrollLeft(previousScrollLeft + scrollStep);

            if (Math.abs(trackScroll.scrollLeft - previousScrollLeft) > 0.5) {
              updateClipRightTrimPreviewFromClientX(dragState.clientX);
            }
          }
        }
      }

      animationFrameId = window.requestAnimationFrame(runClipRightTrimAutoScrollFrame);
    };

    animationFrameId = window.requestAnimationFrame(runClipRightTrimAutoScrollFrame);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [
    getTimelineLaneClientBounds,
    isClipRightTrimDragging,
    setTimelineScrollLeft,
    updateClipRightTrimPreviewFromClientX,
  ]);

  useEffect(() => {
    if (!isPlayheadDragging) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (playheadDragRef.current) {
        playheadDragRef.current.clientX = event.clientX;
      }

      event.preventDefault();
    };
    const handlePointerEnd = () => stopPlayheadDrag();

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);

    if (playheadDragRef.current && playheadDragRef.current.animationFrameId === undefined) {
      playheadDragRef.current.animationFrameId = window.requestAnimationFrame(runPlayheadDragFrame);
    }

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);

      const dragState = playheadDragRef.current;

      if (dragState?.animationFrameId !== undefined) {
        window.cancelAnimationFrame(dragState.animationFrameId);
      }
    };
  }, [isPlayheadDragging, runPlayheadDragFrame, stopPlayheadDrag]);

  useEffect(() => {
    if (!timelineContextMenu) {
      return;
    }

    const closeContextMenu = () => setTimelineContextMenu(undefined);
    const handleContextMenuKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    };

    window.addEventListener('pointerdown', closeContextMenu);
    window.addEventListener('keydown', handleContextMenuKeyDown);

    return () => {
      window.removeEventListener('pointerdown', closeContextMenu);
      window.removeEventListener('keydown', handleContextMenuKeyDown);
    };
  }, [timelineContextMenu]);

  useEffect(() => {
    if (!clipTakeMenu) {
      return;
    }

    if (!clipTakeMenuClip) {
      setClipTakeMenu(undefined);
      return;
    }

    const closeClipTakeMenu = () => setClipTakeMenu(undefined);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (
        target instanceof Element &&
        target.closest('[data-clip-take-control]')
      ) {
        return;
      }

      closeClipTakeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeClipTakeMenu();
      }
    };
    const handleScroll = (event: Event) => {
      const target = event.target;

      if (
        target instanceof Element &&
        target.closest('[data-clip-take-control]')
      ) {
        return;
      }

      closeClipTakeMenu();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeClipTakeMenu);
    window.addEventListener('scroll', handleScroll, true);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeClipTakeMenu);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [clipTakeMenu, clipTakeMenuClip]);

  const isClipTrimBlockedPreview = Boolean(
    (isClipLeftTrimDragging && clipLeftTrimPreview && !clipLeftTrimPreview.canTrim) ||
      (isClipRightTrimDragging && clipRightTrimPreview && !clipRightTrimPreview.canTrim),
  );
  const isClipOverlapPreview = Boolean(isClipMoveDragging && clipMovePreview && !clipMovePreview.canMove);
  const timelineStatusMessage = isClipTrimBlockedPreview
    ? 'TRIM BLOCKED'
    : isClipOverlapPreview
    ? 'CLIP OVERLAP'
    : isTimelineExportPreparing
    ? 'EXPORT PREPARING'
    : timelineStatusFeedback?.message ?? timelineStatusDiagnostic?.message ?? `STATUS ${project.status}`;
  const timelineStatusTone = isClipTrimBlockedPreview || isClipOverlapPreview
    ? 'warning'
    : isTimelineExportPreparing
    ? 'warning'
    : timelineStatusFeedback?.tone ??
      timelineStatusDiagnostic?.tone ??
      project.status.toLowerCase().replace(/\s+/g, '-');
  const timelineStatusHelpText = isClipTrimBlockedPreview
    ? 'The trim would exceed the source range, overlap another clip, or leave the Timeline.'
    : isClipOverlapPreview
    ? 'The dragged clip overlaps another clip. Move it to a clear position or release to cancel the move.'
    : isTimelineExportPreparing
    ? 'Preparing the exact selected Clip or Track for one external download.'
    : timelineStatusFeedback?.helpText ?? timelineStatusDiagnostic?.helpText;
  const timelineStatusAriaLabel = isClipTrimBlockedPreview
    ? 'Timeline warning TRIM BLOCKED'
    : isClipOverlapPreview
    ? 'Timeline warning CLIP OVERLAP'
    : isTimelineExportPreparing
      ? 'Timeline warning EXPORT PREPARING'
    : timelineStatusFeedback
      ? `Timeline ${timelineStatusFeedback.tone} ${timelineStatusFeedback.message}`
      : timelineStatusDiagnostic
        ? `Timeline ${timelineStatusDiagnostic.tone} ${timelineStatusDiagnostic.message}`
        : `Project status ${project.status}`;

  return (
    <section
      ref={sectionRef}
      className={`panel timeline-panel ${isTimelineExpanded ? 'expanded' : ''}`}
      aria-label="Timeline"
    >
      <HelpHint
        className="timeline-expansion-help"
        text={
          isTimelineExpandPending
            ? 'Moving to the Studio top before expanding the Timeline workspace.'
            : isTimelineExpanded
            ? 'Collapse the Timeline workspace and restore the upper panels.'
            : 'Expand the Timeline workspace by reducing the upper panels.'
        }
      >
        <button
          type="button"
          className="timeline-expansion-handle"
          aria-busy={isTimelineExpandPending}
          aria-label={isTimelineExpandPending
            ? 'Expanding Timeline workspace'
            : isTimelineExpanded
              ? 'Collapse Timeline workspace'
              : 'Expand Timeline workspace'}
          aria-pressed={isTimelineExpanded}
          aria-disabled={isTimelineExpandPending}
          onClick={onToggleTimelineExpanded}
        >
          <span className="timeline-expansion-grip" aria-hidden="true" />
        </button>
      </HelpHint>
      <div className="timeline-header">
        <div className="timeline-status-slot">
          <div className="timeline-status-row">
            <div className="timeline-status-stack">
              <span
                className={`timeline-status-badge ${timelineStatusTone}`}
                aria-label={timelineStatusAriaLabel}
                {...(timelineStatusHelpText ? getHelpPreviewProps(timelineStatusHelpText) : {})}
              >
                {timelineStatusMessage}
              </span>
              <MicrophoneInputMeter
                level={microphoneInputLevel}
                phase={recordingRuntimePhase}
              />
            </div>
            <div className="auto-patch-actions">
              <HelpHint
                className="auto-patch-help patch-check-help"
                text={autoPatchButtonTooltip}
              >
                <span className="auto-patch-action-shell patch-check-shell">
                  <button
                    type="button"
                    className={`timeline-icon-action auto-patch patch-check ${readyAutoPatchCount > 0 ? 'ready' : ''}`}
                    disabled={readyAutoPatchCount === 0}
                    aria-label={
                      readyAutoPatchCount > 0
                        ? isSafetyModeEnabled
                          ? `Preview ${readyAutoPatchCount} Patch Check line ready`
                          : `Mark ${readyAutoPatchCount} Patch Check line ready`
                        : 'No ready Patch Check line'
                    }
                    onClick={handlePatchCheckButtonClick}
                  >
                    <span className="auto-patch-machine-label">PATCH CHECK</span>
                  </button>
                </span>
              </HelpHint>
              <HelpHint
                className="auto-patch-help production"
                text={autoPatchProductionTooltip}
              >
                <span className="auto-patch-action-shell">
                  <button
                    type="button"
                    className={`timeline-icon-action auto-patch production ${
                      canStartAutoPatchProduction ? 'ready' : ''
                    } ${autoPatchProductionPresentation.tone}`}
                    disabled={!canStartAutoPatchProduction}
                    aria-label={
                      canStartAutoPatchProduction
                        ? oneShotGenerationFamily.canResolve
                          ? 'Run ONE SHOT GENERATION from Prompt and Lyrics'
                          : `Run Production Auto Patch for ${formatCount(
                              autoPatchTargetClipInfos.length,
                              'target Clip',
                            )}`
                        : autoPatchProductionTooltip
                    }
                    onClick={handleProductionAutoPatchButtonClick}
                  >
                    <span className="auto-patch-machine-icon" aria-hidden="true" />
                    <span className="auto-patch-machine-label">
                      {autoPatchProductionPresentation.buttonLabel}
                    </span>
                    <span className="auto-patch-machine-meter">
                      {autoPatchProductionPresentation.meterLabel}
                    </span>
                  </button>
                </span>
              </HelpHint>
            </div>
          </div>
        </div>
        <div className="timeline-title-block">
          <div className="timeline-title-row">
            <div className="timeline-workflow-actions">
              <HelpHint text="Create a blank track at the bottom of the Timeline.">
                <button
                  type="button"
                  className="timeline-icon-action add-track"
                  aria-label="Add blank track"
                  onClick={onAddBlankTrack}
                >
                  <span className="add-track-icon" aria-hidden="true" />
                </button>
              </HelpHint>
              <HelpHint text={timelineCopyAvailability.message}>
                <button
                  type="button"
                  className={`timeline-icon-action copy-track ${timelineCopyAvailability.canCopy ? 'ready' : ''}`}
                  disabled={!timelineCopyAvailability.canCopy}
                  aria-label={timelineCopyAvailability.canCopy ? timelineCopyAvailability.message : 'Copy track or clips unavailable'}
                  onClick={onCopyTimelineSelection}
                >
                  <span className="copy-track-icon" aria-hidden="true" />
                </button>
              </HelpHint>
              <HelpHint text={trackGroupingAvailability.message}>
                <button
                  type="button"
                  className={`timeline-icon-action group ${trackGroupingAvailability.canGroup ? '' : 'needs-selection'}`}
                  disabled={trackGroupingAvailability.selectedCount < 2}
                  aria-label={trackGroupingAvailability.message}
                  onClick={onGroupSelectedTracks}
                >
                  G
                </button>
              </HelpHint>
              <HelpHint text="Toggle Focus mode for the selected clip lineage. Matching source and generated clips stay bright.">
                <button
                  type="button"
                  className={`timeline-icon-action focus ${isLineageFocusEnabled ? 'active' : ''}`}
                  disabled={!canFocusLineage}
                  aria-pressed={isLineageFocusEnabled}
                  aria-label="Focus selected lineage"
                  onClick={() => setIsLineageFocusEnabled((isEnabled) => !isEnabled)}
                >
                  F
                </button>
              </HelpHint>
              <HelpHint text="Open Edit History and Auto Patch History beside the Timeline.">
                <button
                  type="button"
                  className={`timeline-icon-action history ${isHistoryOpen ? 'active' : ''}`}
                  aria-pressed={isHistoryOpen}
                  aria-label="Open History"
                  onClick={onOpenHistory}
                >
                  H
                </button>
              </HelpHint>
              <HelpHint
                text={
                  canDeleteTimelineSelection
                    ? `${formatTimelineDeletionTitle(timelineDeletionImpact)}. Safety Mode may ask for confirmation.`
                    : 'Select timeline tracks or clips before using Timeline Delete.'
                }
              >
                <button
                  type="button"
                  className={`timeline-icon-action delete ${canDeleteTimelineSelection ? 'ready' : ''}`}
                  disabled={!canDeleteTimelineSelection}
                  aria-label={
                    canDeleteTimelineSelection
                      ? formatTimelineDeletionTitle(timelineDeletionImpact)
                      : 'Select timeline tracks or clips to delete'
                  }
                  aria-keyshortcuts="Delete Backspace"
                  onClick={onDeleteTimelineSelection}
                >
                  <span className="trash-icon" aria-hidden="true" />
                </button>
              </HelpHint>
            </div>
          </div>
        </div>
        <TimelineTransport
          activeTransport={activeTransport}
          isTimelineExportPreparing={isTimelineExportPreparing}
          project={project}
          punchInTick={punchInTick}
          punchOutTick={punchOutTick}
          punchRangeLocked={(punchSession?.attempts.length ?? 0) > 0}
          recordingRuntimePhase={recordingRuntimePhase}
          onImportAudio={onImportAudio}
          onProjectBpmChange={onProjectBpmChange}
          onProjectGridResolutionChange={onProjectGridResolutionChange}
          onProjectKeyChange={onProjectKeyChange}
          onProjectTotalBarsChange={onProjectTotalBarsChange}
          onRecordingSettingsChange={onRecordingSettingsChange}
          onSetPunchMarker={onSetPunchMarker}
          onTimelineSettingRangeWarning={onTimelineSettingRangeWarning}
          onTransport={onTransport}
          totalDisplayBars={totalDisplayBars}
        />
      </div>
      <div className={`timeline-workspace ${isHistoryOpen ? 'history-open' : ''}`}>
        <div
          className="timeline-main"
          style={
            {
              '--timeline-bar-width': `${timelineBarPixelWidth}px`,
              '--timeline-beat-width': `${timelineBeatPixelWidth}px`,
              '--timeline-grid-width': `${timelineGridPixelWidth}px`,
              '--timeline-lane-width': `${timelineLanePixelWidth}px`,
            } as CSSProperties
          }
        >
          <div
            className={`playhead ${isPlayheadDragging ? 'dragging' : ''}`}
            style={{ left: `calc(var(--timeline-label-width) + ${playheadViewportPixel}px)` }}
          >
            <span className="playhead-line" aria-hidden="true" />
            <button
              type="button"
              className="playhead-handle"
              aria-label={`Timeline playhead at beat ${formatTickBeatPosition(playheadTick)}. Drag to set paste and playback start.`}
              aria-valuemax={safeTotalTicks}
              aria-valuemin={0}
              aria-valuenow={Math.floor(playheadTick)}
              aria-valuetext={`Beat ${formatTickBeatPosition(playheadTick)}`}
              role="slider"
              onKeyDown={handlePlayheadKeyDown}
              onPointerDown={handlePlayheadPointerDown}
            >
              <span className="playhead-grip" aria-hidden="true" />
            </button>
          </div>
          <div
            ref={timelineHorizontalScrollRef}
            className="timeline-horizontal-scroll"
            aria-label="Timeline lane horizontal scroll"
            onPointerDown={suspendPlaybackFollow}
            onScroll={() => syncTimelineScrollLeft('bar')}
            onWheel={suspendPlaybackFollow}
          >
            <div className="timeline-horizontal-scroll-spacer" />
          </div>
          <div
            ref={timelineRulerScrollRef}
            className="timeline-ruler-scroll"
            onPointerDown={suspendPlaybackFollow}
            onScroll={() => syncTimelineScrollLeft('ruler')}
            onWheel={suspendPlaybackFollow}
          >
            <button
              type="button"
              className="timeline-ruler"
              aria-keyshortcuts="ArrowLeft ArrowRight Home End Space"
              aria-label={`Timeline ruler. Playhead at beat ${formatTickBeatPosition(
                playheadTick,
              )}. Click to set playback position.`}
              onKeyDown={handlePlayheadKeyDown}
              onPointerDown={handleTimelineRulerPointerDown}
            >
              {punchInTick !== undefined &&
              punchOutTick !== undefined &&
              punchInTick < punchOutTick ? (
                <span
                  className="punch-ruler-range"
                  aria-hidden="true"
                  style={{
                    left: `${(punchInTick / safeTotalTicks) * 100}%`,
                    width: `${((punchOutTick - punchInTick) / safeTotalTicks) * 100}%`,
                  }}
                />
              ) : null}
              {punchInTick !== undefined ? (
                <span
                  className="punch-ruler-marker punch-in"
                  aria-hidden="true"
                  style={{ left: `${(punchInTick / safeTotalTicks) * 100}%` }}
                >
                  ►
                </span>
              ) : null}
              {punchOutTick !== undefined ? (
                <span
                  className="punch-ruler-marker punch-out"
                  aria-hidden="true"
                  style={{ left: `${(punchOutTick / safeTotalTicks) * 100}%` }}
                >
                  ◄
                </span>
              ) : null}
              {timelineRulerBars.map((bar) => (
                <span
                  key={bar.barNumber}
                  aria-hidden="true"
                  style={{ left: `${(bar.startTick / safeTotalTicks) * 100}%` }}
                >
                  {bar.barNumber}
                </span>
              ))}
            </button>
          </div>
          <div
            ref={timelineTrackScrollRef}
            className="timeline-track-scroll"
            onPointerDown={suspendPlaybackFollow}
            onScroll={() => syncTimelineScrollLeft('tracks')}
            onWheel={suspendPlaybackFollow}
          >
            <div ref={timelineBodyRef} className="timeline-body">
              {visibleTrackRows.rows.map(({ depth, track }) => {
                const groupPlaybackTrack = getGroupPlaybackTrack(track, tracks);
                const muteTarget = track.group ? groupPlaybackTrack : track;
                const isMuted = muteTarget?.muted === true;
                const laneClips = track.group ? (track.group.collapsed ? groupPlaybackTrack?.clips ?? [] : []) : track.clips;
                const shouldShowGroupSummary = Boolean(track.group?.collapsed && laneClips.length === 0);
                const shouldShowGroupInfoBar = Boolean(track.group && !track.group.collapsed);

                return (
                  <div
                    key={track.id}
                    data-track-depth={depth}
                    className={`track-row ${track.group ? 'group-track' : ''} ${track.parentGroupId ? 'child-track' : ''} ${
                      isMuted ? 'muted' : ''
                    }`}
                    style={{ '--track-group-depth': Math.min(depth, 4) } as CSSProperties}
                  >
                    <TrackLabel
                      isMuted={isMuted}
                      isSelected={selectedTrackIds.has(track.id)}
                      muteTargetName={track.group ? muteTarget?.name : undefined}
                      track={track}
                      onRenameTrack={onRenameTrack}
                      onSelectTrack={onSelectTrack}
                      onToggleTrackMute={onToggleTrackMute}
                      onToggleTrackGroup={onToggleTrackGroup}
                      onUngroupTrack={onUngroupTrack}
                    />
                    <div
                      className={`clip-lane ${track.group ? 'group-lane' : ''}`}
                      onContextMenu={(event) => {
                        onSelectTrack(track.id, 'replace');
                        openTimelineContextMenu(event, { targetTrackId: track.id });
                      }}
                    >
                      {shouldShowGroupInfoBar ? (
                        <span className="group-lane-info">{createGroupLaneSummary(track, tracks)}</span>
                      ) : shouldShowGroupSummary ? (
                        <span className="group-lane-summary">{createGroupLaneSummary(track, tracks)}</span>
                      ) : (
                        laneClips.map((clip) => {
                          const isClipSelected = selectedClipIds.has(clip.id) || selectedClipId === clip.id;
                          const movePreview = clipMovePreview?.clipId === clip.id ? clipMovePreview : undefined;
                          const leftTrimPreview =
                            clipLeftTrimPreview?.clipId === clip.id ? clipLeftTrimPreview : undefined;
                          const rightTrimPreview =
                            clipRightTrimPreview?.clipId === clip.id ? clipRightTrimPreview : undefined;
                          const displayedStartTick = leftTrimPreview?.startTick ?? movePreview?.startTick ?? clip.startTick;
                          const displayedLengthTicks =
                            leftTrimPreview?.lengthTicks ?? rightTrimPreview?.lengthTicks ?? clip.lengthTicks;
                          const isClipMovePreview = Boolean(isClipMoveDragging && movePreview);
                          const isClipLeftTrimPreview = Boolean(isClipLeftTrimDragging && leftTrimPreview);
                          const isClipRightTrimPreview = Boolean(isClipRightTrimDragging && rightTrimPreview);
                          const isClipTrimPreview = isClipLeftTrimPreview || isClipRightTrimPreview;
                          const isClipTrimBlocked = Boolean(
                            (isClipLeftTrimPreview && !leftTrimPreview?.canTrim) ||
                              (isClipRightTrimPreview && !rightTrimPreview?.canTrim),
                          );
                          const isSoleSelectedClip =
                            selectedClipIds.size === 1
                              ? selectedClipIds.has(clip.id)
                              : selectedClipIds.size === 0 && selectedClipId === clip.id;
                          const canShowLeftTrimHandle = Boolean(
                            !track.group && isSoleSelectedClip && isSourceBackedAudioClip(clip),
                          );
                          const canShowRightEdgeHandle = Boolean(
                            !track.group &&
                              isSoleSelectedClip &&
                              (isSourceBackedAudioClip(clip) || isMidiClip(clip)),
                          );
                          const isMidiRightResize = isMidiClip(clip);
                          const clipTakes = clip.clipTakes ?? [];
                          const activeClipTakeIndex = Math.max(
                            0,
                            clipTakes.findIndex(
                              (take) =>
                                take.clipTakeId === clip.activeClipTakeId,
                            ),
                          );

                          return (
                            <div
                              key={clip.id}
                              data-clip-id={clip.id}
                              data-start-tick={displayedStartTick}
                              className={`clip-shell ${isClipTrimPreview ? 'trim-dragging' : ''} ${
                                isClipTrimBlocked ? 'trim-blocked' : ''
                              }`}
                              style={
                                {
                                  '--clip-color': getClipTypeColor(clip.type),
                                  left: `${(displayedStartTick / safeTotalTicks) * 100}%`,
                                  width: `${(displayedLengthTicks / safeTotalTicks) * 100}%`,
                                } as CSSProperties
                              }
                            >
                              <button
                                type="button"
                                aria-keyshortcuts={track.group ? undefined : 'ArrowLeft ArrowRight'}
                                className={`clip ${track.group ? 'group-virtual-clip' : 'movable'} ${
                                  isClipSelected ? 'selected' : ''
                                } ${clipTakes.length > 0 ? 'has-takes' : ''} ${
                                  clip.type === 'midi-notes' ||
                                  clip.type === 'edited-midi'
                                    ? 'midi-clip'
                                    : 'audio-clip'
                                } ${lineageSourceIds.has(clip.id) ? 'lineage-source' : ''} ${
                                  sourceIssueClipIds.has(clip.id) ? 'source-offline' : ''
                                } ${
                                  isLineageFocusEnabled && lineageMemberIds.has(clip.id) ? 'lineage-focus-member' : ''
                                } ${
                                  isLineageFocusEnabled && !lineageMemberIds.has(clip.id) ? 'lineage-muted' : ''
                                } ${isClipMovePreview ? 'dragging' : ''} ${
                                  isClipMovePreview && !movePreview?.canMove ? 'move-blocked' : ''
                                }`}
                                aria-pressed={isClipSelected}
                                onClick={(event) =>
                                  onSelectClip(
                                    clip.id,
                                    event.shiftKey
                                      ? 'range'
                                      : event.ctrlKey || event.metaKey
                                        ? 'toggle'
                                        : 'replace',
                                  )
                                }
                                onPointerDown={(event) => handleClipMovePointerDown(event, clip, track)}
                                onPointerMove={(event) => handleClipMovePointerMove(event, clip.id)}
                                onPointerUp={(event) => handleClipMovePointerEnd(event, clip.id, true)}
                                onPointerCancel={(event) => handleClipMovePointerEnd(event, clip.id, false)}
                                onKeyDown={(event) => handleClipMoveKeyDown(event, clip, track)}
                                onContextMenu={(event) => {
                                  if (!isClipSelected) {
                                    onSelectClip(clip.id, 'replace');
                                  }
                                  openTimelineContextMenu(event, { targetClipId: clip.id, targetTrackId: track.id });
                                }}
                              >
                                <span className="clip-header">
                                  <span className="clip-name">{clip.name}</span>
                                </span>
                                <span className="clip-media-body" aria-hidden="true">
                                  <span className="clip-media-grid" />
                                </span>
                              </button>
                              {clipTakes.length > 0 ? (
                                <button
                                  type="button"
                                  className={`clip-take-badge ${
                                    clipTakeMenu?.clipId === clip.id ? 'active' : ''
                                  }`}
                                  data-clip-take-control
                                  aria-expanded={clipTakeMenu?.clipId === clip.id}
                                  aria-haspopup="dialog"
                                  aria-label={`Choose Take for ${clip.name}. Active Take ${
                                    activeClipTakeIndex + 1
                                  } of ${clipTakes.length}.`}
                                  title="Choose Clip Take. Use the wheel while focused to browse candidates."
                                  onClick={(event) =>
                                    openClipTakeMenu(event, clip)
                                  }
                                  onPointerDown={(event) =>
                                    event.stopPropagation()
                                  }
                                  onWheel={(event) =>
                                    handleClipTakeBadgeWheel(event, clip)
                                  }
                                >
                                  <span className="clip-take-badge-wide">
                                    TAKE {activeClipTakeIndex + 1}/{clipTakes.length}
                                  </span>
                                  <span className="clip-take-badge-medium">
                                    T {activeClipTakeIndex + 1}/{clipTakes.length}
                                  </span>
                                  <span className="clip-take-badge-narrow">
                                    T{activeClipTakeIndex + 1}
                                  </span>
                                </button>
                              ) : null}
                              {canShowLeftTrimHandle ? (
                                <button
                                  type="button"
                                  className="clip-trim-handle clip-left-trim-handle"
                                  aria-keyshortcuts="ArrowLeft ArrowRight"
                                  aria-label={`Trim start of ${clip.name}`}
                                  title="Trim audio clip start"
                                  onKeyDown={(event) => handleClipLeftTrimKeyDown(event, clip)}
                                  onPointerDown={(event) => handleClipLeftTrimPointerDown(event, clip)}
                                  onPointerMove={(event) => handleClipLeftTrimPointerMove(event, clip.id)}
                                  onPointerUp={(event) => handleClipLeftTrimPointerEnd(event, clip.id, true)}
                                  onPointerCancel={(event) => handleClipLeftTrimPointerEnd(event, clip.id, false)}
                                >
                                  <span aria-hidden="true" />
                                </button>
                              ) : null}
                              {canShowRightEdgeHandle ? (
                                <button
                                  type="button"
                                  className="clip-trim-handle clip-right-trim-handle"
                                  aria-keyshortcuts="ArrowLeft ArrowRight"
                                  aria-label={
                                    isMidiRightResize
                                      ? `Resize end of ${clip.name}`
                                      : `Trim end of ${clip.name}`
                                  }
                                  title={
                                    isMidiRightResize
                                      ? 'Resize MIDI clip end'
                                      : 'Trim audio clip end'
                                  }
                                  onKeyDown={(event) => handleClipRightTrimKeyDown(event, clip)}
                                  onPointerDown={(event) => handleClipRightTrimPointerDown(event, clip)}
                                  onPointerMove={(event) => handleClipRightTrimPointerMove(event, clip.id)}
                                  onPointerUp={(event) => handleClipRightTrimPointerEnd(event, clip.id, true)}
                                  onPointerCancel={(event) => handleClipRightTrimPointerEnd(event, clip.id, false)}
                                >
                                  <span aria-hidden="true" />
                                </button>
                              ) : null}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        {isHistoryOpen ? (
          <TimelineHistoryPanel
            autoPatchHistoryEntries={autoPatchHistoryEntries}
            editHistoryItems={editHistoryItems}
            selectedClipId={selectedClipInfo?.clip.id}
            onJumpToEditHistory={onJumpToEditHistory}
            onSelectAutoPatchHistoryClip={onSelectAutoPatchHistoryClip}
          />
        ) : null}
      </div>
      {clipTakeMenu && clipTakeMenuClip ? (
        <ClipTakePopover
          clip={clipTakeMenuClip}
          left={clipTakeMenu.left}
          project={project}
          selectedClipTakeId={clipTakeMenu.candidateClipTakeId}
          top={clipTakeMenu.top}
          onActivate={(clipTakeId) => {
            onActivateClipTake(clipTakeMenuClip.id, clipTakeId);
            setClipTakeMenu(undefined);
          }}
          onManage={() => {
            onSelectClip(clipTakeMenuClip.id, 'replace');
            setClipTakeMenu(undefined);
            onOpenProjectInspector();
          }}
          onPreview={(clipTakeId) =>
            onPreviewClipTake(clipTakeMenuClip.id, clipTakeId)
          }
          onSelect={(clipTakeId) =>
            setClipTakeMenu((currentMenu) =>
              currentMenu?.clipId === clipTakeMenuClip.id
                ? {
                    ...currentMenu,
                    candidateClipTakeId: clipTakeId,
                  }
                : currentMenu,
            )
          }
        />
      ) : null}
      {timelineContextMenu && (
        <div
          className="timeline-context-menu"
          role="menu"
          style={{ left: timelineContextMenu.x, top: timelineContextMenu.y } as CSSProperties}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {timelineContextMenu.targetClipId && contextSplitAvailability ? (
            <button
              type="button"
              role="menuitem"
              disabled={!contextSplitAvailability.canSplit}
              onClick={() => {
                if (timelineContextMenu.targetClipId) {
                  onSplitTimelineAudioClip(timelineContextMenu.targetClipId);
                }
                setTimelineContextMenu(undefined);
              }}
            >
              <span>Split at Playhead</span>
              <small>{contextSplitAvailability.message}</small>
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            disabled={!timelineClipCopyAvailability.canCopy}
            onClick={() => {
              onCopySelectedTimelineClips();
              setTimelineContextMenu(undefined);
            }}
          >
            <span>Copy Clips</span>
            <small>{timelineClipCopyAvailability.message}</small>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!contextPasteAvailability.canPaste}
            onClick={() => {
              onPasteTimelineClipClipboard(timelineContextMenu.targetTrackId);
              setTimelineContextMenu(undefined);
            }}
          >
            <span>Paste Clips</span>
            <small>{contextPasteAvailability.message}</small>
          </button>
        </div>
      )}
      <div className="clip-inspector" aria-live="polite">
        {selectedTrackInfos.length > 0 ? (
          <div className="clip-inspector-content">
            <SelectedSummaryPanel>
              <strong>{formatSelectedTrackHeading(selectedTrackInfos)}</strong>
              <ClipInspectorBadge text={formatCount(selectedTrackInfos.length, 'track')} />
              <ClipInspectorBadge text={formatCount(autoPatchTargetClipInfos.length, 'Auto Patch clip')} />
              <ClipInspectorBadge text={formatAutoPatchTargetBadge(autoPatchTargetClipInfos)} />
              <ClipInspectorBadge text={formatTimelineDeletionBadge(timelineDeletionImpact)} />
              {selectedTrackInfos.length === 1 && (
                <>
                  <ClipInspectorBadge text={formatTrackType(selectedTrackInfos[0])} />
                  <ClipInspectorBadge text={formatCount(selectedTrackInfos[0].clips.length, 'direct clip')} />
                  {selectedTrackInfos[0].group && (
                    <>
                      <ClipInspectorBadge text={formatCount(selectedTrackInfos[0].group.childTrackIds.length, 'direct child')} />
                      <ClipInspectorBadge text={selectedTrackInfos[0].group.collapsed ? 'Collapsed' : 'Expanded'} />
                    </>
                  )}
                </>
              )}
            </SelectedSummaryPanel>
          </div>
        ) : selectedClipInfos.length > 1 ? (
          <div className="clip-inspector-content">
            <SelectedSummaryPanel>
              <strong>{formatCount(selectedClipInfos.length, 'Clip')} Selected</strong>
              <ClipInspectorBadge text={formatCount(selectedClipInfos.length, 'clip')} />
              <ClipInspectorBadge text={formatCount(autoPatchTargetClipInfos.length, 'Auto Patch clip')} />
              <ClipInspectorBadge text={formatTimelineDeletionBadge(timelineDeletionImpact)} />
              {selectedClipInfo && <ClipInspectorBadge text={`FOCUS ${selectedClipInfo.clip.name}`} />}
            </SelectedSummaryPanel>
          </div>
        ) : selectedClipInfo ? (
          <div
            className={`clip-inspector-content selected-clip-layout ${lineage.length > 1 ? 'with-lineage' : ''} ${
              autoPatchEligibilities.length > 0 ? 'with-apg' : ''
            }`}
          >
            <SelectedSummaryPanel>
              <strong>{selectedClipInfo.clip.name}</strong>
              <ClipInspectorBadge text={selectedClipInfo.track.name} />
              <ClipInspectorBadge text={`Beat ${formatTickBeatPosition(selectedClipInfo.clip.startTick)}`} />
              <ClipInspectorBadge text={`${formatTickBeatLength(selectedClipInfo.clip.lengthTicks)} beats`} />
              <ClipInspectorBadge text={selectedClipInfo.clip.type} />
              <ClipInspectorBadge text={selectedClipInfo.clip.generatedBy ?? 'Manual'} />
              <ClipInspectorBadge text={`V${selectedClipInfo.clip.version}`} />
              {(selectedClipInfo.clip.clipTakes?.length ?? 0) > 0 && (
                <>
                  <ClipInspectorBadge
                    text={`CLIP TAKES ${selectedClipInfo.clip.clipTakes?.length ?? 0}`}
                  />
                  <ClipInspectorBadge
                    text={`ACTIVE ${getActiveClipTakeLabel(selectedClipInfo.clip)}`}
                  />
                </>
              )}
              {selectedClipInfo.clip.sourceClipId && <ClipInspectorBadge text={`SRC ${selectedClipInfo.clip.sourceClipId}`} />}
              {selectedClipInfo.clip.sourceFile && (
                <>
                  <ClipInspectorBadge text={`FILE ${formatClipSourceFileName(selectedClipInfo.clip)}`} />
                  <ClipInspectorBadge
                    text={formatClipSourceStatusBadge(selectedClipInfo.clip.sourceFile.status)}
                    tone={getClipSourceBadgeTone(selectedClipInfo.clip.sourceFile.status)}
                  />
                  <ClipInspectorBadge
                    text="SOURCE DETAILS"
                    tooltipText={createClipSourceMetadataTooltip(
                      selectedClipInfo.clip,
                      hasSessionAudioSource(selectedClipInfo.clip.sourceFile.sourceId),
                    )}
                    variant="details"
                  />
                </>
              )}
              {selectedClipInfo.clip.parameterSnapshot &&
                Object.entries(selectedClipInfo.clip.parameterSnapshot).map(([label, value]) => (
                  <ClipInspectorBadge key={label} text={formatParameterSnapshotBadge(label, value)} />
                ))}
              {selectedClipInfo.clip.exportManifest && (
                <>
                  <ClipInspectorBadge text={`MANIFEST ${selectedClipInfo.clip.exportManifest.id}`} />
                  <ClipInspectorBadge text={`FILE ${selectedClipInfo.clip.exportManifest.estimatedFileName}`} />
                  <ClipInspectorBadge text={`FORMAT ${selectedClipInfo.clip.exportManifest.format}`} />
                  <ClipInspectorBadge text={`NORMALIZE ${selectedClipInfo.clip.exportManifest.normalize}`} />
                  <ClipInspectorBadge text={`EXPORT ${selectedClipInfo.clip.exportManifest.status}`} />
                </>
              )}
            </SelectedSummaryPanel>
            {selectedClipInfo.clip.type === 'hum-audio' ? (
              <PunchAttemptsPanel
                isRecording={recordingRuntimePhase !== 'IDLE'}
                punchInTick={punchInTick}
                punchOutTick={punchOutTick}
                session={punchSession}
                targetClip={selectedClipInfo.clip}
                onDiscard={onDiscardPunchSession}
                onKeep={onKeepPunchAttempt}
                onPreview={onPreviewPunchAttempt}
                onSelectAttempt={onSelectPunchAttempt}
                onStartRecording={onStartPunchRecording}
              />
            ) : null}
            {lineage.length > 1 && <ClipLineageTrail entries={lineage} onSelectClip={onSelectClip} />}
            <AutoPatchGuardPanel
              eligibilities={autoPatchEligibilities}
            />
          </div>
        ) : (
          <div className="clip-inspector-content">
            <SelectedSummaryPanel>
              <strong>No Selection</strong>
              <ClipInspectorBadge text="Click a timeline clip or track" />
            </SelectedSummaryPanel>
          </div>
        )}
      </div>
    </section>
  );
}

function SelectedSummaryPanel({ children }: { children: ReactNode }) {
  return (
    <div className="selected-summary-panel">
      <span>Selected</span>
      <div className="clip-inspector-summary">{children}</div>
    </div>
  );
}

function PunchAttemptsPanel({
  isRecording,
  punchInTick,
  punchOutTick,
  session,
  targetClip,
  onDiscard,
  onKeep,
  onPreview,
  onSelectAttempt,
  onStartRecording,
}: {
  isRecording: boolean;
  punchInTick?: number;
  punchOutTick?: number;
  session?: PunchSession;
  targetClip: Clip;
  onDiscard: () => void;
  onKeep: () => void;
  onPreview: () => void;
  onSelectAttempt: (punchAttemptId: string) => void;
  onStartRecording: () => void;
}) {
  const attempts = session?.attempts ?? [];
  const hasValidRange =
    punchInTick !== undefined &&
    punchOutTick !== undefined &&
    punchInTick < punchOutTick &&
    punchInTick >= targetClip.startTick &&
    punchOutTick <= targetClip.startTick + targetClip.lengthTicks;
  const selectedAttempt = session ? getSelectedPunchAttempt(session) : undefined;
  const activeTake = (targetClip.clipTakes ?? []).find(
    (take) => take.clipTakeId === targetClip.activeClipTakeId,
  );

  return (
    <section className="punch-attempts-panel" aria-label="Punch Attempts">
      <div className="punch-attempts-heading">
        <div>
          <span>PIPO</span>
          <strong>PUNCH ATTEMPTS</strong>
        </div>
        <small>{attempts.length} TEMP</small>
      </div>
      <div className="punch-session-contract">
        <span>CLIP <strong>{session?.clip.name ?? targetClip.name}</strong></span>
        <span>BASE <strong>{session?.baseClipTake.label ?? activeTake?.label ?? 'NO ACTIVE TAKE'}</strong></span>
        <span>
          RANGE{' '}
          <strong>
            {punchInTick === undefined ? '--' : formatTickBeatPosition(punchInTick)} →{' '}
            {punchOutTick === undefined ? '--' : formatTickBeatPosition(punchOutTick)}
          </strong>
        </span>
      </div>
      {attempts.length > 0 ? (
        <div className="punch-attempt-list" role="radiogroup" aria-label="Temporary Punch Attempts">
          {attempts.map((attempt, index) => (
            <label
              key={attempt.punchAttemptId}
              className={`punch-attempt-row ${
                attempt.punchAttemptId === session?.selectedAttemptId ? 'selected' : ''
              }`}
            >
              <input
                type="radio"
                checked={attempt.punchAttemptId === session?.selectedAttemptId}
                name="punch-attempt"
                onChange={() => onSelectAttempt(attempt.punchAttemptId)}
              />
              <span>
                <strong>ATTEMPT {String(index + 1).padStart(2, '0')}</strong>
                <small>{formatDurationSeconds(attempt.durationSeconds)} / TEMPORARY</small>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="punch-attempt-empty">
          Set IN / OUT on the transport, then record several temporary Attempts.
        </p>
      )}
      <div className="punch-attempt-actions">
        <button
          type="button"
          disabled={!hasValidRange || isRecording}
          onClick={onStartRecording}
        >
          {attempts.length > 0 ? 'RECORD ANOTHER' : 'PUNCH RECORD'}
        </button>
        <button
          type="button"
          disabled={!selectedAttempt || isRecording}
          onClick={onPreview}
        >
          PREVIEW
        </button>
        <button
          type="button"
          className="keep"
          disabled={!selectedAttempt || isRecording}
          onClick={onKeep}
        >
          KEEP SELECTED AS NEW TAKE
        </button>
        <button
          type="button"
          className="discard"
          disabled={attempts.length === 0 || isRecording}
          onClick={onDiscard}
        >
          DISCARD SESSION
        </button>
      </div>
      <small className="punch-attempt-warning">
        KEEP creates one Undo step and releases every temporary Attempt. DISCARD is irreversible.
      </small>
    </section>
  );
}

function ClipTakePopover({
  clip,
  left,
  project,
  selectedClipTakeId,
  top,
  onActivate,
  onManage,
  onPreview,
  onSelect,
}: {
  clip: Clip;
  left: number;
  project: ProjectState;
  selectedClipTakeId: string;
  top: number;
  onActivate: (clipTakeId: string) => void;
  onManage: () => void;
  onPreview: (clipTakeId: string) => void;
  onSelect: (clipTakeId: string) => void;
}) {
  const artifacts = project.artifacts ?? [];
  const clipTakes = clip.clipTakes ?? [];
  const selectedTake =
    clipTakes.find((take) => take.clipTakeId === selectedClipTakeId) ??
    clipTakes[0];
  const isSelectedTakeActive =
    selectedTake?.clipTakeId === clip.activeClipTakeId;

  if (!selectedTake) {
    return null;
  }

  const previewResolution = resolveClipTakeAudioPreview(
    project,
    clip.id,
    selectedTake.clipTakeId,
  );
  const previewControlLabel = previewResolution.canPreview
    ? `Preview ${selectedTake.label}`
    : `Preview unavailable: ${previewResolution.message}`;

  return (
    <section
      className="clip-take-popover"
      data-clip-take-control
      role="dialog"
      aria-label={`${clip.name} Clip Takes`}
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="clip-take-popover-header">
        <div>
          <span>Clip Takes</span>
          <strong>{clip.name}</strong>
        </div>
        <small>{clipTakes.length} TAKES</small>
      </div>
      <div className="clip-take-popover-list" role="listbox" aria-label="Clip Takes">
        {clipTakes.map((take, index) => {
          const isActive = take.clipTakeId === clip.activeClipTakeId;
          const isSelected = take.clipTakeId === selectedTake.clipTakeId;

          return (
            <button
              key={take.clipTakeId}
              type="button"
              className={`clip-take-option ${isActive ? 'active' : ''} ${
                isSelected ? 'selected' : ''
              }`}
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelect(take.clipTakeId)}
            >
              <span className="clip-take-option-led" aria-hidden="true" />
              <span className="clip-take-option-copy">
                <strong>{take.label}</strong>
                <small>
                  TAKE {index + 1} / {take.mediaType.toUpperCase()}
                  {formatClipTakeSeedSuffix(artifacts, take.artifactId)}
                </small>
              </span>
              {isActive ? <span className="clip-take-active-label">ACTIVE</span> : null}
            </button>
          );
        })}
      </div>
      <div className="clip-take-popover-actions">
        <button
          type="button"
          aria-label={previewControlLabel}
          disabled={!previewResolution.canPreview}
          onClick={() => onPreview(selectedTake.clipTakeId)}
          title={previewControlLabel}
        >
          PREVIEW
        </button>
        <button
          type="button"
          disabled={isSelectedTakeActive}
          onClick={() => onActivate(selectedTake.clipTakeId)}
        >
          MAKE ACTIVE
        </button>
        <button type="button" onClick={onManage}>
          MANAGE...
        </button>
      </div>
      <small className="clip-take-popover-note">
        Wheel browsing changes the candidate only. MAKE ACTIVE confirms playback use.
      </small>
    </section>
  );
}

function InspectorEditHistory({
  items,
  onJump,
}: {
  items: EditHistoryItem[];
  onJump: (targetIndex: number) => void;
}) {
  return (
    <section className="inspector-section edit-history-section">
      <div className="edit-history-heading">
        <h3>Edit History</h3>
        <small>{items.length} / {undoHistoryLimit + 1}</small>
      </div>
      <div className="edit-history-list" aria-label="Session Edit History">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`edit-history-row ${item.isCurrent ? 'current' : ''} ${
              item.isFuture ? 'future' : ''
            } ${item.irreversible ? 'irreversible' : ''}`}
            aria-current={item.isCurrent ? 'step' : undefined}
            disabled={!item.isCurrent && !item.canJump}
            onClick={() => onJump(item.index)}
          >
            <span className="edit-history-marker" aria-hidden="true" />
            <span className="edit-history-copy">
              <strong>{item.label}</strong>
              <small>
                {item.category.toUpperCase()} / {formatAutoPatchHistoryTime(item.createdAt)}
              </small>
            </span>
            <span className="edit-history-state">
              {item.irreversible
                ? 'NON-REVERSIBLE'
                : item.isCurrent
                  ? 'CURRENT'
                  : item.isFuture
                    ? 'FUTURE'
                    : ''}
            </span>
          </button>
        ))}
      </div>
      <small className="edit-history-note">
        Session only. Selection, scrolling, Preview, and playback are not recorded.
      </small>
    </section>
  );
}

function AutoPatchHistoryPanel({
  entries,
  selectedClipId,
  onSelectClip,
}: {
  entries: AutoPatchHistoryEntry[];
  selectedClipId?: string;
  onSelectClip: (clipId: string, selectionMode?: SelectionMode) => void;
}) {
  return (
    <section className="auto-patch-history-panel" aria-label="Auto Patch history">
      <div className="auto-patch-history-header">
        <span>Auto Patch History</span>
        <small>{entries.length} marks</small>
      </div>
      {entries.length > 0 ? (
        <div className="auto-patch-history-list">
          {entries.map((entry) => (
            <button
              key={entry.application.runId}
              type="button"
              className={`auto-patch-history-row ${entry.clipId === selectedClipId ? 'selected' : ''}`}
              title={`${entry.clipName} / ${entry.application.tabFlowLineName} R${entry.application.tabFlowLineRevision}`}
              onClick={() => onSelectClip(entry.clipId)}
            >
              <span className="auto-patch-history-clip">{entry.clipName}</span>
              <span className="auto-patch-history-track">{entry.trackName}</span>
              <span className="auto-patch-history-line">{formatAutoPatchHistoryLine(entry)}</span>
              <span className="auto-patch-history-time">{formatAutoPatchHistoryTime(entry.application.appliedAt)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p>No Auto Patch marks yet</p>
      )}
    </section>
  );
}

function AutoPatchGuardPanel({
  eligibilities,
}: {
  eligibilities: AutoPatchEligibility[];
}) {
  if (eligibilities.length === 0) {
    return null;
  }

  return (
    <div className="auto-patch-guard-panel">
      <span>APG</span>
      <div className="auto-patch-guard-lines">
        {eligibilities.map((eligibility) => (
          <small
            key={eligibility.line.id}
            className={`auto-patch-guard-badge ${eligibility.status}`}
            title={eligibility.reason}
          >
            {eligibility.line.order + 1} {eligibility.status.toUpperCase()} R{eligibility.line.revision}: {eligibility.reason}
          </small>
        ))}
      </div>
    </div>
  );
}

function TrackLabel({
  isMuted,
  isSelected,
  muteTargetName,
  track,
  onRenameTrack,
  onSelectTrack,
  onToggleTrackMute,
  onToggleTrackGroup,
  onUngroupTrack,
}: {
  isMuted: boolean;
  isSelected: boolean;
  muteTargetName?: string;
  track: Track;
  onRenameTrack: (trackId: string, name: string) => void;
  onSelectTrack: (trackId: string, selectionMode?: SelectionMode) => void;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackGroup: (trackId: string) => void;
  onUngroupTrack: (trackId: string) => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(track.name);
  const isGroupTrack = Boolean(track.group);
  const trackKindClass = createTrackKindClass(track);

  useEffect(() => {
    if (!isRenaming) {
      setDraftName(track.name);
    }
  }, [isRenaming, track.name]);

  const commitRename = () => {
    const nextName = draftName.trim() || track.name;

    onRenameTrack(track.id, nextName);
    setDraftName(nextName);
    setIsRenaming(false);
  };

  const cancelRename = () => {
    setDraftName(track.name);
    setIsRenaming(false);
  };

  return (
    <div
      className={`track-label ${isSelected ? 'selected' : ''} ${isRenaming ? 'renaming' : ''} ${
        isGroupTrack ? 'grouped' : ''
      } ${track.parentGroupId ? 'child' : ''} ${isMuted ? 'muted' : ''}`}
      data-track-kind={trackKindClass}
    >
      {isRenaming ? (
        <>
          <input
            autoFocus
            className="track-name-input"
            type="text"
            aria-label={`Rename ${track.name}`}
            value={draftName}
            onBlur={commitRename}
            onChange={(event) => setDraftName(event.target.value)}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitRename();
              }

              if (event.key === 'Escape') {
                cancelRename();
              }
            }}
          />
          <span className="track-label-meta">
            {formatTrackMetaLabel(track)}
          </span>
        </>
      ) : (
        <>
          {track.group && (
            <div className="track-group-tools" aria-label={`${track.name} group controls`}>
              <HelpHint text={`Ungroup ${track.name}. Direct child rows move up one hierarchy level.`}>
                <button
                  type="button"
                  className="track-group-badge"
                  aria-label={`Ungroup ${track.name}`}
                  onClick={() => onUngroupTrack(track.id)}
                >
                  G
                </button>
              </HelpHint>
              <HelpHint text={track.group.collapsed ? `Expand ${track.name} to show direct child rows without changing nested Group collapse state.` : `Collapse ${track.name} to show only the resolved playback leaf lane.`}>
                <button
                  type="button"
                  className={`track-layer-button ${track.group.collapsed ? 'collapsed' : 'expanded'}`}
                  aria-label={track.group.collapsed ? `Expand ${track.name}` : `Collapse ${track.name}`}
                  aria-pressed={!track.group.collapsed}
                  onClick={() => onToggleTrackGroup(track.id)}
                >
                  <span className="track-layer-icon" aria-hidden="true" />
                </button>
              </HelpHint>
            </div>
          )}
          <button
            type="button"
            className="track-select-button"
            aria-pressed={isSelected}
            onClick={(event) =>
              onSelectTrack(track.id, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace')
            }
          >
            <strong>{track.name}</strong>
            <span>
              {track.group ? `Group ${track.group.childTrackIds.length} direct ${track.group.childTrackIds.length === 1 ? 'child' : 'children'}` : formatTrackMetaLabel(track)}
              {isMuted ? ' / MUTED' : ''}
            </span>
          </button>
          <div className="track-action-tools" aria-label={`${track.name} track controls`}>
            <HelpHint
              text={
                track.group && !muteTargetName
                  ? `Mute unavailable: ${track.name} has no valid active child Track.`
                  : `${isMuted ? 'Unmute' : 'Mute'} ${track.name}${
                      track.group ? ` via active Track ${muteTargetName}` : ''
                    }. ALL Playback and Mixdown respect Mute; Selection Playback ignores it.`
              }
            >
              <button
                type="button"
                className={`track-mute-button ${isMuted ? 'active' : ''}`}
                aria-label={`${isMuted ? 'Unmute' : 'Mute'} ${track.name}`}
                aria-pressed={isMuted}
                disabled={Boolean(track.group && !muteTargetName)}
                onClick={() => onToggleTrackMute(track.id)}
              >
                M
              </button>
            </HelpHint>
            <HelpHint text={`Rename ${track.name}. Press Enter to commit or Escape to cancel.`}>
              <button
                type="button"
                className="track-rename-button"
                aria-label={`Rename ${track.name}`}
                onClick={() => setIsRenaming(true)}
              />
            </HelpHint>
          </div>
        </>
      )}
    </div>
  );
}

function createTrackKindClass(track: Track): string {
  return track.type.replace(/_/g, '-');
}

function formatTrackMetaLabel(track: Track): string {
  if (track.type === 'blank') {
    return 'No Type';
  }

  return `${track.type} ${track.level} dB`;
}

function TimelineTransport({
  activeTransport,
  isTimelineExportPreparing,
  project,
  punchInTick,
  punchOutTick,
  punchRangeLocked,
  recordingRuntimePhase,
  onImportAudio,
  onProjectBpmChange,
  onProjectGridResolutionChange,
  onProjectKeyChange,
  onProjectTotalBarsChange,
  onRecordingSettingsChange,
  onSetPunchMarker,
  onTimelineSettingRangeWarning,
  onTransport,
  totalDisplayBars,
}: {
  activeTransport: TransportButton;
  isTimelineExportPreparing: boolean;
  project: ProjectState;
  punchInTick?: number;
  punchOutTick?: number;
  punchRangeLocked: boolean;
  recordingRuntimePhase: RecordingRuntimePhase;
  onImportAudio: () => void;
  onProjectBpmChange: (bpm: number) => boolean | void;
  onProjectGridResolutionChange: (gridResolution: TimelineGridResolution) => void;
  onProjectKeyChange: (key: string) => void;
  onProjectTotalBarsChange: (totalBars: number) => boolean | void;
  onRecordingSettingsChange: (recordingSettings: RecordingSettings) => void;
  onSetPunchMarker: (marker: 'in' | 'out') => void;
  onTimelineSettingRangeWarning: (warning: TimelineSettingRangeWarning) => void;
  onTransport: (button: TransportButton) => void;
  totalDisplayBars: number;
}) {
  const selectedClipCount = project.selection.items.filter((item) => item.type === 'clip').length;
  const [selectedTransportControl, setSelectedTransportControl] = useState<TimelineTransportControl>();
  const recordingControlsLocked = recordingRuntimePhase !== 'IDLE';

  useEffect(() => {
    setSelectedTransportControl(undefined);
  }, [project.selection.items]);

  useEffect(() => {
    const clearStopSelectionOutsideButton = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.transport-button.stop')) {
        return;
      }

      setSelectedTransportControl((currentControl) =>
        currentControl === 'STOP' ? undefined : currentControl,
      );
    };

    document.addEventListener('pointerdown', clearStopSelectionOutsideButton);

    return () => document.removeEventListener('pointerdown', clearStopSelectionOutsideButton);
  }, []);

  return (
    <div className="timeline-transport" aria-label="Timeline transport">
      <nav className="transport-controls" aria-label="Transport controls">
        <RecordingSettingsMenu
          disabled={recordingControlsLocked}
          settings={project.recordingSettings}
          onChange={onRecordingSettingsChange}
        />
        <PunchRangeControl
          disabled={recordingControlsLocked || punchRangeLocked}
          inTick={punchInTick}
          outTick={punchOutTick}
          onSetMarker={onSetPunchMarker}
        />
        {timelineTransportControls.map((control) => {
          const isImport = control === 'IMPORT';
          const isExport = control === 'EXPORT';
          const isLoop = control === 'LOOP';
          const isAllPlayback = control === 'PLAY' && project.selection.items.length === 0;
          const isPlayLocked = control === 'PLAY' && selectedClipCount > 1;
          const isLoopAvailable = project.selection.items.length <= 1;
          const isDisabled =
            isPlayLocked ||
            (isLoop && !isLoopAvailable) ||
            (isExport && isTimelineExportPreparing);
          const isActive =
            !isImport &&
            !isDisabled &&
            (control === 'STOP'
              ? selectedTransportControl === 'STOP'
              : isLoop
                ? project.isLooping && isLoopAvailable
                : activeTransport === control);

          return (
            <HelpHint
              key={control}
              text={
                isImport
                  ? 'Import one local audio file as a metadata-only hum-audio clip.'
                  : isExport
                    ? isTimelineExportPreparing
                      ? 'Preparing one exact Timeline EXPORT target.'
                      : 'Save exactly one selected Clip or Track as WAV or MIDI without Project Mixdown.'
                  : isPlayLocked
                    ? 'Play is disabled for multiple selected Clips in v0.1.'
                  : isLoop && !isLoopAvailable
                    ? 'Loop is disabled for multiple Track, Group, or Clip selections in v0.1.'
                  : createTransportHelpMessage(control)
              }
            >
              <button
                aria-label={
                  isExport
                    ? isTimelineExportPreparing
                      ? 'Timeline Export preparing'
                      : 'Export selected Clip or Track'
                    : isAllPlayback
                    ? 'Play all Project Tracks'
                    : isPlayLocked
                      ? 'Play unavailable for multiple selected Clips'
                      : undefined
                }
                className={`transport-button ${control.toLowerCase()} ${isActive ? 'active' : ''}`}
                aria-busy={isExport && isTimelineExportPreparing}
                disabled={isDisabled}
                type="button"
                onClick={() => {
                  setSelectedTransportControl(isImport ? undefined : control);

                  if (isImport) {
                    onImportAudio();
                    return;
                  }

                  onTransport(control);
                }}
              >
                <span className={`transport-label ${isAllPlayback ? 'all-playback' : ''}`}>
                  {isAllPlayback ? 'ALL' : control}
                </span>
                <TransportIcon button={control} />
              </button>
            </HelpHint>
          );
        })}
      </nav>
      <div className="timeline-setting-strip" aria-label="Recording, tempo, and key settings">
        <EditableTimelineSetting
          ariaLabel="Project BPM"
          disabled={recordingControlsLocked}
          helpText={
            recordingControlsLocked
              ? 'Project BPM is frozen while Count-In or recording is active.'
              : 'Project BPM drives Timeline playback, Metronome, and Count-In timing.'
          }
          label="BPM"
          max={RECORDING_BPM_MAX}
          min={RECORDING_BPM_MIN}
          type="number"
          value={project.bpm}
          onCommit={onProjectBpmChange}
          onRangeWarning={onTimelineSettingRangeWarning}
        />
        <ProjectKeySetting
          value={project.key}
          onCommit={onProjectKeyChange}
        />
        <ProjectGridResolutionSetting
          value={project.gridResolution}
          onCommit={onProjectGridResolutionChange}
        />
        <EditableTimelineSetting
          ariaLabel="Timeline length in bars"
          helpText="Length is displayed in bars. ElpisDAW keeps Timeline positions in ticks internally."
          label="Length"
          max={MAX_TIMELINE_BARS}
          min={MIN_TIMELINE_BARS}
          suffix="B"
          type="number"
          value={Math.round(totalDisplayBars)}
          onCommit={onProjectTotalBarsChange}
          onRangeWarning={onTimelineSettingRangeWarning}
        />
      </div>
    </div>
  );
}

function PunchRangeControl({
  disabled,
  inTick,
  outTick,
  onSetMarker,
}: {
  disabled: boolean;
  inTick?: number;
  outTick?: number;
  onSetMarker: (marker: 'in' | 'out') => void;
}) {
  const hasValidRange =
    inTick !== undefined && outTick !== undefined && inTick < outTick;

  return (
    <div
      className={`punch-range-control ${hasValidRange ? 'valid' : ''}`}
      aria-label="Punch In and Punch Out"
    >
      <button
        type="button"
        className={`punch-range-half punch-in ${inTick !== undefined ? 'active' : ''}`}
        disabled={disabled}
        aria-label={inTick === undefined ? 'Set Punch In at Playhead' : 'Clear Punch In'}
        aria-pressed={inTick !== undefined}
        onClick={() => onSetMarker('in')}
      >
        <strong>IN</strong>
        <small>{inTick === undefined ? '--' : formatPunchMarkerPosition(inTick)}</small>
      </button>
      <svg
        className="punch-range-divider"
        viewBox="0 0 54 52"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M27 0 C22 8 22 17 27 26 C32 35 32 44 27 52" />
      </svg>
      <button
        type="button"
        className={`punch-range-half punch-out ${outTick !== undefined ? 'active' : ''}`}
        disabled={disabled}
        aria-label={outTick === undefined ? 'Set Punch Out at Playhead' : 'Clear Punch Out'}
        aria-pressed={outTick !== undefined}
        onClick={() => onSetMarker('out')}
      >
        <strong>OUT</strong>
        <small>{outTick === undefined ? '--' : formatPunchMarkerPosition(outTick)}</small>
      </button>
    </div>
  );
}

function MicrophoneInputMeter({
  level,
  phase,
}: {
  level: number;
  phase: RecordingRuntimePhase;
}) {
  const normalizedLevel = Math.max(
    0,
    Math.min(1, Number.isFinite(level) ? level : 0),
  );
  const levelPercent = Math.round(normalizedLevel * 100);
  const phaseLabel: Record<RecordingRuntimePhase, string> = {
    IDLE: 'IDLE',
    PREPARING: 'WAIT',
    COUNT_IN: 'ARM',
    RECORDING: 'REC',
    SAVING: 'SAVE',
  };

  return (
    <div
      className={`status-microphone-meter phase-${phase.toLowerCase()}`}
      {...getHelpPreviewProps(
        phase === 'IDLE'
          ? 'Microphone Input Level appears after REC obtains browser microphone access.'
          : `Microphone Input Level is ${levelPercent} percent while recording state is ${phaseLabel[phase]}.`,
      )}
    >
      <span className="status-microphone-icon" aria-hidden="true">🎤</span>
      <span
        className="microphone-input-track"
        role="progressbar"
        aria-label="Microphone Input Level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={levelPercent}
      >
        <span
          className="microphone-input-fill"
          style={{ width: `${levelPercent}%` }}
        />
      </span>
      {phase === 'IDLE' ? <strong className="status-microphone-idle">IDLE</strong> : null}
    </div>
  );
}

function RecordingSettingsMenu({
  disabled,
  settings,
  onChange,
}: {
  disabled: boolean;
  settings: RecordingSettings;
  onChange: (settings: RecordingSettings) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOutsideMenu = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) {
        return;
      }

      setIsOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      setIsOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', closeOutsideMenu);
    document.addEventListener('keydown', closeWithEscape);

    return () => {
      document.removeEventListener('pointerdown', closeOutsideMenu);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [isOpen]);

  return (
    <div className={`recording-settings-menu ${isOpen ? 'open' : ''}`} ref={menuRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`transport-button recording-settings-trigger ${isOpen ? 'active' : ''}`}
        aria-controls="timeline-recording-settings"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`${isOpen ? 'Close' : 'Open'} REC MENU`}
        disabled={disabled}
        {...getHelpPreviewProps(
          disabled
            ? 'REC MENU is frozen while Count-In or recording is active.'
            : 'Open Metronome, Count-In, and Click Level settings.',
        )}
        onClick={() => setIsOpen((currentValue) => !currentValue)}
      >
        <span className="recording-settings-trigger-label" aria-hidden="true">
          REC
          <br />
          MENU
        </span>
      </button>
      {isOpen ? (
        <div
          id="timeline-recording-settings"
          className="recording-settings-popover"
          role="dialog"
          aria-label="Recording click settings"
        >
          <div className="recording-settings-popover-header">
            <strong>REC MENU</strong>
            <span>CLICK SETTINGS</span>
          </div>
          <MetronomeToggle
            disabled={disabled}
            enabled={settings.metronomeEnabled}
            onChange={(metronomeEnabled) =>
              onChange({
                ...settings,
                metronomeEnabled,
              })
            }
          />
          <CountInSetting
            countInBars={settings.countInBars}
            disabled={disabled}
            onChange={(countInBars) =>
              onChange({
                ...settings,
                countInBars,
              })
            }
          />
          <MetronomeVolumeSetting
            disabled={disabled}
            value={settings.metronomeVolume}
            onChange={(metronomeVolume) =>
              onChange({
                ...settings,
                metronomeVolume,
              })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function MetronomeToggle({
  disabled,
  enabled,
  onChange,
}: {
  disabled: boolean;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`timeline-setting-field recording-setting-toggle ${enabled ? 'active' : ''}`}
      aria-label={`Metronome ${enabled ? 'On' : 'Off'}`}
      aria-pressed={enabled}
      disabled={disabled}
      {...getHelpPreviewProps(
        disabled
          ? 'Metronome is frozen while Count-In or recording is active.'
          : 'Play metronome clicks during recording. Count-In remains audible when selected.',
      )}
      onClick={() => onChange(!enabled)}
    >
      <span>Metronome</span>
      <strong>{enabled ? 'ON' : 'OFF'}</strong>
    </button>
  );
}

function CountInSetting({
  countInBars,
  disabled,
  onChange,
}: {
  countInBars: CountInBars;
  disabled: boolean;
  onChange: (countInBars: CountInBars) => void;
}) {
  return (
    <label
      className="timeline-setting-field timeline-setting-editable recording-count-in"
      aria-label="Recording Count-In"
      {...getHelpPreviewProps(
        disabled
          ? 'Count-In is frozen while Count-In or recording is active.'
          : 'Choose OFF, 1 bar, or 2 bars before recording.',
      )}
    >
      <span>Count-In</span>
      <select
        aria-label="Recording Count-In"
        className="timeline-setting-select"
        disabled={disabled}
        value={countInBars}
        onChange={(event) => onChange(Number(event.target.value) as CountInBars)}
      >
        {countInBarOptions.map((bars) => (
          <option key={bars} value={bars}>
            {bars === 0 ? 'OFF' : `${bars} BAR${bars === 1 ? '' : 'S'}`}
          </option>
        ))}
      </select>
    </label>
  );
}

function MetronomeVolumeSetting({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (value: number) => void;
  value: number;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  const commitValue = (nextValue: number) => {
    const normalizedValue = clampInteger(
      nextValue,
      METRONOME_VOLUME_MIN,
      METRONOME_VOLUME_MAX,
    );

    setDraftValue(normalizedValue);

    if (normalizedValue !== value) {
      onChange(normalizedValue);
    }
  };

  return (
    <label
      className="timeline-setting-field timeline-setting-editable recording-volume"
      aria-label="Metronome Volume"
      {...getHelpPreviewProps(
        disabled
          ? 'Metronome Volume is frozen while Count-In or recording is active.'
          : `Metronome Volume: ${draftValue}%. Headphones are recommended while recording.`,
      )}
    >
      <span>Click</span>
      <div className="recording-volume-control">
        <input
          aria-label="Metronome Volume"
          disabled={disabled}
          max={METRONOME_VOLUME_MAX}
          min={METRONOME_VOLUME_MIN}
          type="range"
          value={draftValue}
          onBlur={(event) => commitValue(Number(event.currentTarget.value))}
          onChange={(event) => setDraftValue(Number(event.target.value))}
          onKeyUp={(event) => commitValue(Number(event.currentTarget.value))}
          onPointerCancel={(event) => commitValue(Number(event.currentTarget.value))}
          onPointerUp={(event) => commitValue(Number(event.currentTarget.value))}
        />
        <strong>{draftValue}%</strong>
      </div>
    </label>
  );
}

type ProjectGridResolutionSettingProps = {
  value: TimelineGridResolution;
  onCommit: (value: TimelineGridResolution) => void;
};

function ProjectGridResolutionSetting({ value, onCommit }: ProjectGridResolutionSettingProps) {
  const tickStep = getTimelineGridResolutionTickStep(value);

  return (
    <label
      className="timeline-setting-field timeline-setting-editable timeline-setting-grid"
      aria-label="Timeline grid resolution"
      {...getHelpPreviewProps(`Grid ${value} resolves Timeline positions in ${tickStep}-tick steps.`)}
    >
      <span>Grid</span>
      <select
        aria-label="Timeline grid resolution"
        className="timeline-setting-select"
        value={value}
        onChange={(event) => onCommit(event.target.value as TimelineGridResolution)}
      >
        {timelineGridResolutions.map((gridResolution) => (
          <option key={gridResolution} value={gridResolution}>
            {gridResolution}
          </option>
        ))}
      </select>
    </label>
  );
}

type ProjectKeySettingProps = {
  value: string;
  onCommit: (value: string) => void;
};

function ProjectKeySetting({ value, onCommit }: ProjectKeySettingProps) {
  const parsedKey = parseProjectKey(value);

  const handleRootChange = (root: string) => {
    onCommit(formatProjectKey(root, parsedKey.mode));
  };

  const handleModeChange = (mode: KeyMode) => {
    onCommit(formatProjectKey(parsedKey.root, mode));
  };

  return (
    <label className="timeline-setting-field timeline-setting-editable timeline-setting-key" aria-label="Project key">
      <span>Key</span>
      <div className="timeline-setting-select-row">
        <select
          aria-label="Project key root"
          className="timeline-setting-select"
          value={parsedKey.root}
          onChange={(event) => handleRootChange(event.target.value)}
        >
          {keyRootOptions.map((root) => (
            <option key={root} value={root}>
              {root}
            </option>
          ))}
        </select>
        <span className="timeline-key-mode-control">
          <select
            aria-label="Project key mode"
            className="timeline-setting-select timeline-key-mode-select"
            value={parsedKey.mode}
            onChange={(event) => handleModeChange(event.target.value as KeyMode)}
          >
            {keyModeOptions.map((mode) => (
              <option key={mode} value={mode}>
                {mode === 'major' ? 'MAJOR' : 'minor'}
              </option>
            ))}
          </select>
          <strong className="timeline-key-mode-value" aria-hidden="true">
            {parsedKey.mode === 'major' ? 'M' : 'm'}
          </strong>
        </span>
      </div>
    </label>
  );
}

type EditableTimelineSettingProps = {
  ariaLabel: string;
  disabled?: boolean;
  helpText?: string;
  label: string;
  max: number;
  min: number;
  suffix?: string;
  type: 'number';
  value: number;
  onCommit: (value: number) => boolean | void;
  onRangeWarning?: (warning: TimelineSettingRangeWarning) => void;
};

function EditableTimelineSetting(props: EditableTimelineSettingProps) {
  const [draftValue, setDraftValue] = useState(String(props.value));
  const isEditingRef = useRef(false);
  const skipNextBlurRef = useRef(false);
  const trimmedDraftValue = draftValue.trim();
  const parsedDraftValue = Number(trimmedDraftValue);
  const isDraftEmpty = trimmedDraftValue.length === 0;
  const isDraftNumber = !isDraftEmpty && Number.isFinite(parsedDraftValue);
  const isDraftInvalid = isEditingRef.current && !isDraftNumber;
  const isDraftOutOfRange = isDraftNumber && (parsedDraftValue < props.min || parsedDraftValue > props.max);
  const hasInputWarning = isDraftInvalid || isDraftOutOfRange;

  useEffect(() => {
    if (!isEditingRef.current) {
      setDraftValue(String(props.value));
    }
  }, [props.value]);

  const resetDraft = () => {
    setDraftValue(String(props.value));
    isEditingRef.current = false;
  };

  const commitDraft = () => {
    isEditingRef.current = false;

    const nextValue = isDraftNumber ? clampInteger(parsedDraftValue, props.min, props.max) : props.value;

    if (isDraftOutOfRange && isDraftNumber) {
      props.onRangeWarning?.({
        clampedValue: nextValue,
        label: props.label,
        max: props.max,
        min: props.min,
        suffix: props.suffix,
        value: parsedDraftValue,
      });
    }

    if (nextValue !== props.value) {
      const isAccepted = props.onCommit(nextValue);

      setDraftValue(String(isAccepted === false ? props.value : nextValue));
      return;
    }

    setDraftValue(String(nextValue));
  };

  return (
    <label
      className={`timeline-setting-field timeline-setting-editable ${
        props.disabled ? 'disabled' : ''
      } ${hasInputWarning ? 'has-input-warning' : ''}`}
      aria-label={props.ariaLabel}
      {...(props.helpText ? getHelpPreviewProps(props.helpText) : {})}
    >
      <span>{props.label}</span>
      <div className="timeline-setting-input-row">
        <input
          aria-invalid={hasInputWarning || undefined}
          className={`timeline-setting-input ${isDraftInvalid ? 'invalid' : ''} ${
            isDraftOutOfRange ? 'out-of-range' : ''
          }`}
          inputMode="numeric"
          disabled={props.disabled}
          max={props.max}
          min={props.min}
          step={1}
          title={`Enter ${props.min}-${props.max}`}
          type={props.type}
          value={draftValue}
          onBlur={() => {
            if (skipNextBlurRef.current) {
              skipNextBlurRef.current = false;
              return;
            }

            commitDraft();
          }}
          onChange={(event) => setDraftValue(event.target.value)}
          onFocus={(event) => {
            isEditingRef.current = true;
            event.target.select();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitDraft();
              event.currentTarget.blur();
            }

            if (event.key === 'Escape') {
              skipNextBlurRef.current = true;
              resetDraft();
              event.currentTarget.blur();
            }
          }}
          onWheel={(event) => {
            if (document.activeElement === event.currentTarget) {
              event.currentTarget.blur();
            }
          }}
        />
        {props.suffix && <strong>{props.suffix}</strong>}
      </div>
    </label>
  );
}

function TransportIcon({ button }: { button: TimelineTransportControl }) {
  if (button === 'IMPORT' || button === 'EXPORT') {
    return (
      <span className={`transport-icon ${button.toLowerCase()}`} aria-hidden="true">
        {button === 'IMPORT' ? '\u2191' : '\u2193'}
      </span>
    );
  }

  if (button === 'LOOP') {
    return (
      <span className="transport-icon loop" aria-hidden="true">
        {'\u221e'}
      </span>
    );
  }

  return <span className={`transport-icon ${button.toLowerCase()}`} aria-hidden="true" />;
}

function ClipInspectorBadge({
  text,
  tone = 'default',
  tooltipText,
  variant = 'default',
}: {
  text: string;
  tone?: 'default' | 'warning' | 'error';
  tooltipText?: string;
  variant?: 'default' | 'details';
}) {
  const badgeRef = useRef<HTMLElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>();

  const showTooltip = () => {
    const element = badgeRef.current;

    if (!element || (!tooltipText && !isElementOverflowing(element))) {
      setTooltip(undefined);
      return;
    }

    const rect = element.getBoundingClientRect();
    const width = Math.min(420, Math.max(180, window.innerWidth - 24));
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
    const shouldPlaceAbove = rect.bottom > window.innerHeight - 120;
    const top = shouldPlaceAbove ? Math.max(12, rect.top - 8) : Math.min(window.innerHeight - 12, rect.bottom + 8);

    setTooltip({
      text: tooltipText ?? text,
      left,
      top,
      placement: shouldPlaceAbove ? 'top' : 'bottom',
    });
  };

  const hideTooltip = () => setTooltip(undefined);

  return (
    <>
      <small
        ref={badgeRef}
        className={[tone === 'default' ? '' : tone, variant === 'default' ? '' : variant].filter(Boolean).join(' ') || undefined}
        tabIndex={0}
        aria-label={tooltipText ? `${text}. ${tooltipText}` : undefined}
        onBlur={hideTooltip}
        onFocus={showTooltip}
        onPointerEnter={showTooltip}
        onPointerLeave={hideTooltip}
      >
        {text}
      </small>
      {tooltip && (
        <span className={`clip-overflow-tooltip ${tooltip.placement}`} role="tooltip" style={{ left: tooltip.left, top: tooltip.top }}>
          {tooltip.text}
        </span>
      )}
    </>
  );
}

function ClipLineageTrail({
  entries,
  onSelectClip,
}: {
  entries: ClipLineageEntry[];
  onSelectClip: (clipId: string, selectionMode?: SelectionMode) => void;
}) {
  return (
    <div className="clip-lineage" aria-label="Clip lineage">
      <span>Lineage</span>
      <ol>
        {entries.map((entry) => (
          <li key={entry.clipId}>
            <ClipLineageNode entry={entry} onSelectClip={onSelectClip} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function ClipLineageNode({
  entry,
  onSelectClip,
}: {
  entry: ClipLineageEntry;
  onSelectClip: (clipId: string, selectionMode?: SelectionMode) => void;
}) {
  const nodeRef = useRef<HTMLButtonElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>();

  const showTooltip = () => {
    const element = nodeRef.current;

    if (!element || entry.details.length === 0) {
      setTooltip(undefined);
      return;
    }

    const rect = element.getBoundingClientRect();
    const width = Math.min(360, Math.max(200, window.innerWidth - 24));
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
    const shouldPlaceAbove = rect.bottom > window.innerHeight - 150;
    const top = shouldPlaceAbove ? Math.max(12, rect.top - 8) : Math.min(window.innerHeight - 12, rect.bottom + 8);

    setTooltip({
      text: entry.details.join('\n'),
      left,
      top,
      placement: shouldPlaceAbove ? 'top' : 'bottom',
    });
  };

  const hideTooltip = () => setTooltip(undefined);

  return (
    <>
      <button
        ref={nodeRef}
        type="button"
        className={`clip-lineage-node ${entry.isCurrent ? 'current' : ''} ${entry.isMissing ? 'missing' : ''} ${
          entry.details.length > 0 ? 'has-details' : ''
        }`}
        disabled={entry.isMissing}
        onBlur={hideTooltip}
        onClick={() => {
          if (!entry.isMissing) {
            onSelectClip(entry.clipId);
          }
        }}
        onFocus={showTooltip}
        onPointerEnter={showTooltip}
        onPointerLeave={hideTooltip}
      >
        <strong>{entry.name}</strong>
        <span>{entry.isMissing ? 'Missing Source' : `${entry.type} / ${entry.trackName}`}</span>
      </button>
      {tooltip && (
        <span className={`clip-lineage-tooltip ${tooltip.placement}`} role="tooltip" style={{ left: tooltip.left, top: tooltip.top }}>
          {tooltip.text}
        </span>
      )}
    </>
  );
}

function PanelHeader({
  actions,
  color,
  eyebrow,
  id,
  meter,
  reserveEyebrowSpace = false,
  title,
}: {
  actions?: ReactNode;
  color?: string;
  eyebrow?: string;
  id: string;
  meter: string;
  reserveEyebrowSpace?: boolean;
  title: ReactNode;
}) {
  const hasEyebrow = Boolean(eyebrow);
  const shouldRenderEyebrow = hasEyebrow || reserveEyebrowSpace;

  return (
    <div className={`panel-header ${reserveEyebrowSpace ? 'has-reserved-eyebrow' : ''}`}>
      <div>
        {shouldRenderEyebrow && (
          <span className={`panel-eyebrow ${hasEyebrow ? '' : 'is-spacer'}`} aria-hidden={!hasEyebrow}>
            {hasEyebrow ? eyebrow : 'Header'}
          </span>
        )}
        <h2 id={id} style={color ? ({ '--header-color': color } as CSSProperties) : undefined}>
          {title}
        </h2>
      </div>
      <div className={`panel-header-actions ${actions ? 'has-action' : ''}`}>
        <span className="panel-meter">{meter}</span>
        {actions && <span className="panel-action-slot">{actions}</span>}
      </div>
    </div>
  );
}

function FinalFilerPanel({
  availability,
  engineReady,
  fileName,
  fileNameResolution,
  includeSourceReport,
  isBusy,
  result,
  onCancel,
  onClose,
  onExport,
  onFileNameChange,
  onIncludeSourceReportChange,
}: {
  availability: FinalFilerAvailability;
  engineReady: boolean;
  fileName: string;
  fileNameResolution: FinalFilerFileNameResolution;
  includeSourceReport: boolean;
  isBusy: boolean;
  result?: FinalFilerControllerResult;
  onCancel: () => void;
  onClose: () => void;
  onExport: () => void;
  onFileNameChange: (value: string) => void;
  onIncludeSourceReportChange: (include: boolean) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const disabledReason = createFinalFilerDisabledReason({
    availability,
    engineReady,
    fileNameResolution,
    isBusy,
  });
  const status = result
    ? result
    : isBusy
      ? {
          detail: 'Reading and verifying the exact registered WAV before any browser download.',
          message: 'PREPARING DELIVERY',
          status: 'busy' as const,
        }
      : availability.canExport
        ? {
            detail: availability.lineage,
            message: 'SOURCE READY',
            status: 'success' as const,
          }
        : {
            detail: availability.message,
            message: 'SOURCE UNAVAILABLE',
            status: 'blocked' as const,
          };

  useEffect(() => {
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="inspector-layer final-filer-layer">
      <button
        type="button"
        className="inspector-backdrop"
        aria-label="Close FINAL FILER"
        onClick={onClose}
      />
      <aside
        className="project-inspector final-filer-drawer"
        aria-busy={isBusy}
        aria-label="FINAL FILER"
        aria-modal="true"
        role="dialog"
      >
        <div className="inspector-header">
          <div>
            <span className="panel-eyebrow">Delivery</span>
            <h2>FINAL FILER</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="inspector-close-button"
            aria-label="Close FINAL FILER"
            onClick={onClose}
          >
            X
          </button>
        </div>

        <div
          className={`final-filer-status ${status.status}`}
          role="status"
          aria-live="polite"
        >
          <strong>{status.message}</strong>
          <span>{status.detail}</span>
        </div>

        <section className="inspector-section final-filer-section">
          <h3>Delivery Source</h3>
          <dl className="final-filer-source-grid">
            <div>
              <dt>Source</dt>
              <dd>{availability.canExport ? availability.source : 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Readiness</dt>
              <dd>{availability.canExport ? 'Registered / Ready' : 'Blocked'}</dd>
            </div>
            <div className="final-filer-lineage-row">
              <dt>Lineage</dt>
              <dd>
                {availability.canExport
                  ? availability.lineage
                  : availability.message}
              </dd>
            </div>
          </dl>
        </section>

        <section className="inspector-section final-filer-section">
          <h3>File Delivery</h3>
          <label className="final-filer-field" htmlFor="final-filer-file-name">
            <span>File Name</span>
            <input
              id="final-filer-file-name"
              type="text"
              autoComplete="off"
              disabled={isBusy || !availability.canExport}
              maxLength={180}
              value={fileName}
              aria-invalid={!fileNameResolution.valid}
              aria-describedby="final-filer-file-name-help"
              onChange={(event) => onFileNameChange(event.target.value)}
            />
          </label>
          <span
            id="final-filer-file-name-help"
            className={`final-filer-field-help ${
              fileNameResolution.valid ? 'ready' : 'warning'
            }`}
          >
            {fileNameResolution.valid
              ? 'Safe browser filename. The browser chooses the destination folder.'
              : fileNameResolution.message}
          </span>
          <div className="final-filer-destination">
            <span>Destination</span>
            <strong>Browser Downloads</strong>
          </div>
          <label className="final-filer-toggle">
            <input
              type="checkbox"
              checked={includeSourceReport}
              disabled={isBusy}
              onChange={(event) =>
                onIncludeSourceReportChange(event.target.checked)
              }
            />
            <span>Include Source Report</span>
            <strong>{includeSourceReport ? 'ON' : 'OFF'}</strong>
          </label>
        </section>

        <div className="final-filer-actions">
          {isBusy && (
            <button
              type="button"
              className="secondary-button final-filer-cancel-button"
              onClick={onCancel}
            >
              CANCEL
            </button>
          )}
          <button
            type="button"
            className="primary-button final-filer-export-button"
            disabled={Boolean(disabledReason)}
            aria-describedby="final-filer-disabled-reason"
            onClick={onExport}
          >
            {isBusy ? 'PREPARING...' : 'EXPORT WAV'}
          </button>
        </div>
        <p id="final-filer-disabled-reason" className="final-filer-disabled-reason">
          {disabledReason ??
            'External delivery only. Project Tracks, Clips, Takes, Artifacts, Jobs, and dirty state remain unchanged.'}
        </p>
      </aside>
    </div>
  );
}

function createFinalFilerDisabledReason({
  availability,
  engineReady,
  fileNameResolution,
  isBusy,
}: {
  availability: FinalFilerAvailability;
  engineReady: boolean;
  fileNameResolution: FinalFilerFileNameResolution;
  isBusy: boolean;
}): string | undefined {
  if (isBusy) {
    return 'One FINAL FILER export is already active.';
  }

  if (!availability.canExport) {
    return availability.message;
  }

  if (!engineReady) {
    return 'Local Engine must be ready to read the registered final WAV.';
  }

  if (!fileNameResolution.valid) {
    return fileNameResolution.message;
  }

  return undefined;
}

function ProjectInspector({
  autoPatchHistoryCount,
  editHistoryCount,
  health,
  instrumentAudioPreviewState,
  project,
  selectedClipInfo,
  onActivateClipTake,
  onClose,
  onDeleteClipTakeAndAudioFile,
  onPreviewClipTake,
  onRelinkSource,
  onRemoveClipTakeFromProject,
  onSelectRoutingIssue,
  onSelectSourceIssue,
}: {
  autoPatchHistoryCount: number;
  editHistoryCount: number;
  health: ProjectHealth;
  instrumentAudioPreviewState: InstrumentAudioPreviewUiState;
  project: ProjectState;
  selectedClipInfo?: SelectedClipInfo;
  onActivateClipTake: (clipId: string, clipTakeId: string) => void;
  onClose: () => void;
  onDeleteClipTakeAndAudioFile: (clipId: string, clipTakeId: string) => void;
  onPreviewClipTake: (clipId: string, clipTakeId: string) => void;
  onRelinkSource: (clipId: string) => void;
  onRemoveClipTakeFromProject: (clipId: string, clipTakeId: string) => void;
  onSelectRoutingIssue: (connectionId: string) => void;
  onSelectSourceIssue: (clipId: string) => void;
}) {
  return (
    <div className="inspector-layer">
      <button type="button" className="inspector-backdrop" aria-label="Close project inspector" onClick={onClose} />
      <aside className="project-inspector" aria-label="Project Inspector">
        <div className="inspector-header">
          <div>
            <span className="panel-eyebrow">Project</span>
            <h2>Inspector</h2>
          </div>
          <button type="button" className="inspector-close-button" aria-label="Close project inspector" onClick={onClose}>
            X
          </button>
        </div>
        <div className={`inspector-status ${health.dirtyState}`}>
          <span className="dirty-state-led" aria-hidden="true" />
          <div>
            <strong>{formatProjectHealthStatusLabel(health)}</strong>
            <small>{formatProjectHealthStatusDetail(health)}</small>
          </div>
        </div>
        <section className="inspector-section">
          <h3>Project State</h3>
          <dl className="inspector-grid">
            <div>
              <dt>Name</dt>
              <dd>{project.name}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{project.status}</dd>
            </div>
            <div>
              <dt>BPM</dt>
              <dd>{project.bpm}</dd>
            </div>
            <div>
              <dt>Key</dt>
              <dd>{project.key}</dd>
            </div>
            <div>
              <dt>PatchTabs</dt>
              <dd>{health.patchTabCount}</dd>
            </div>
            <div>
              <dt>Clips</dt>
              <dd>{health.clipCount}</dd>
            </div>
            <div>
              <dt>Artifacts</dt>
              <dd>{health.artifactCount}</dd>
            </div>
            <div>
              <dt>Clip Takes</dt>
              <dd>{health.clipTakeCount}</dd>
            </div>
            <div>
              <dt>Run History</dt>
              <dd>{health.runHistoryCount}</dd>
            </div>
            <div>
              <dt>Source Issues</dt>
              <dd>{health.sourceIssueCount}</dd>
            </div>
          </dl>
        </section>
        <section className="inspector-section">
          <h3>Selection</h3>
          <dl className="inspector-list">
            <div>
              <dt>PatchTab</dt>
              <dd>{health.selectedPatchTabName}</dd>
            </div>
            <div>
              <dt>Routing</dt>
              <dd>{health.selectedRoutingName}</dd>
            </div>
            <div>
              <dt>Clip</dt>
              <dd>{health.selectedClipName}</dd>
            </div>
          </dl>
        </section>
        <ClipTakeManagementPanel
          project={project}
          selectedClipInfo={selectedClipInfo}
          state={instrumentAudioPreviewState}
          onActivate={onActivateClipTake}
          onDeleteFile={onDeleteClipTakeAndAudioFile}
          onPreview={onPreviewClipTake}
          onRemove={onRemoveClipTakeFromProject}
        />
        <SessionHistoryPanel
          autoPatchHistoryCount={autoPatchHistoryCount}
          editHistoryCount={editHistoryCount}
          runHistoryCount={health.runHistoryCount}
        />
        <RunHistoryPanel
          project={project}
          onSelectClip={onSelectSourceIssue}
        />
        <section className="inspector-section">
          <h3>Source Issues</h3>
          <div className="inspector-issue-list">
            {health.sourceIssues.length === 0 ? (
              <div className="inspector-empty-state">
                <strong>No Source Issues</strong>
                <small>Timeline clips do not report missing local sources.</small>
              </div>
            ) : (
              health.sourceIssues.map((issue) => (
                <div
                  key={issue.id}
                  className={`inspector-issue source ${issue.status === 'unresolved' ? 'warning' : 'error'}`}
                >
                  <button
                    type="button"
                    className="inspector-issue-main"
                    aria-label={`Select ${issue.clipName} source issue on ${issue.trackName}`}
                    onClick={() => onSelectSourceIssue(issue.clipId)}
                  >
                    <strong>
                      {issue.clipName} / {issue.fileName}
                    </strong>
                    <small>
                      {issue.restorationAuthority === 'project-root'
                        ? 'Project Root source unavailable'
                        : formatClipSourceFileStatus(issue.status)}{' '}
                      on {issue.trackName}
                    </small>
                  </button>
                  <div className="inspector-issue-actions">
                    <button
                      type="button"
                      className="inspector-issue-action"
                      aria-label={
                        issue.restorationAuthority === 'project-root'
                          ? `Show Project Root restoration guidance for ${issue.clipName}`
                          : `Relink source for ${issue.clipName}`
                      }
                      onClick={() => onRelinkSource(issue.clipId)}
                    >
                      {issue.restorationAuthority === 'project-root'
                        ? 'Project Root'
                        : 'Relink'}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
        <section className="inspector-section">
          <h3>Routing Issues</h3>
          <div className="inspector-issue-list">
            {health.routingIssues.length === 0 ? (
              <div className="inspector-empty-state">
                <strong>No Routing Issues</strong>
                <small>All visible connections are type-compatible.</small>
              </div>
            ) : (
              health.routingIssues.map((issue) => (
                <button
                  key={issue.id}
                  type="button"
                  className="inspector-issue routing"
                  aria-label={`Select routing issue from ${issue.fromName} to ${issue.toName}`}
                  onClick={() => onSelectRoutingIssue(issue.id)}
                >
                  <strong>
                    {issue.fromName} to {issue.toName}
                  </strong>
                  <small>
                    {issue.outputType} cannot feed {issue.inputType}
                  </small>
                </button>
              ))
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

function ClipTakeManagementPanel({
  project,
  selectedClipInfo,
  state,
  onActivate,
  onDeleteFile,
  onPreview,
  onRemove,
}: {
  project: ProjectState;
  selectedClipInfo?: SelectedClipInfo;
  state: InstrumentAudioPreviewUiState;
  onActivate: (clipId: string, clipTakeId: string) => void;
  onDeleteFile: (clipId: string, clipTakeId: string) => void;
  onPreview: (clipId: string, clipTakeId: string) => void;
  onRemove: (clipId: string, clipTakeId: string) => void;
}) {
  const artifacts = project.artifacts ?? [];
  const clip = selectedClipInfo?.clip;
  const clipTakes = useMemo(() => clip?.clipTakes ?? [], [clip?.clipTakes]);
  const [selectedClipTakeId, setSelectedClipTakeId] = useState(
    () => clip?.activeClipTakeId ?? clipTakes[0]?.clipTakeId ?? '',
  );

  useEffect(() => {
    setSelectedClipTakeId((currentId) =>
      clipTakes.some((take) => take.clipTakeId === currentId)
        ? currentId
        : clip?.activeClipTakeId ?? clipTakes[0]?.clipTakeId ?? '',
    );
  }, [clip?.activeClipTakeId, clip?.id, clipTakes]);

  const selectedTake =
    clipTakes.find((take) => take.clipTakeId === selectedClipTakeId) ??
    clipTakes[0];
  const previewResolution =
    clip && selectedTake
      ? resolveClipTakeAudioPreview(project, clip.id, selectedTake.clipTakeId)
      : undefined;
  const previewUnavailableMessage =
    previewResolution && !previewResolution.canPreview
      ? previewResolution.message
      : undefined;
  const isPreviewingSelected =
    state.clipTakeId === selectedTake?.clipTakeId &&
    (state.status === 'LOADING' || state.status === 'PLAYING');
  const doesPreviewStateTargetSelected =
    state.clipTakeId === selectedTake?.clipTakeId;
  const status =
    doesPreviewStateTargetSelected && state.status === 'ERROR'
      ? 'ERROR'
      : isPreviewingSelected
        ? state.status
        : previewUnavailableMessage
          ? 'ERROR'
          : selectedTake
            ? 'READY'
            : 'EMPTY';
  const detail =
    state.clipTakeId === selectedTake?.clipTakeId && state.message
      ? state.message
      : previewUnavailableMessage
        ? previewUnavailableMessage
        : selectedTake
          ? `${selectedTake.label} / ${selectedTake.mediaType.toUpperCase()}`
          : clip
            ? 'This Clip does not contain a production Clip Take.'
            : 'Select one Timeline Clip.';
  const canTogglePreview =
    isPreviewingSelected || previewResolution?.canPreview === true;
  const previewControlLabel = isPreviewingSelected
    ? `Stop preview for ${selectedTake?.label ?? 'selected Take'}`
    : previewUnavailableMessage
      ? `Preview unavailable: ${previewUnavailableMessage}`
      : `Preview ${selectedTake?.label ?? 'selected Take'}`;

  return (
    <section className="inspector-section clip-take-management-section">
      <div className="clip-take-management-heading">
        <h3>Clip Takes</h3>
        <small>{clipTakes.length} TAKES</small>
      </div>
      <div
        className={`instrument-audio-preview-status ${status.toLowerCase()}`}
        aria-live="polite"
      >
        <span className="instrument-audio-preview-led" aria-hidden="true" />
        <div>
          <strong>{status}</strong>
          <small>{detail}</small>
        </div>
      </div>
      {clip && clipTakes.length > 0 ? (
        <>
          <div
            className="clip-take-management-list"
            role="listbox"
            aria-label={`${clip.name} Clip Takes`}
          >
            {clipTakes.map((take, index) => {
              const isActive = take.clipTakeId === clip.activeClipTakeId;
              const isSelected = take.clipTakeId === selectedTake?.clipTakeId;

              return (
                <button
                  key={take.clipTakeId}
                  type="button"
                  className={`clip-take-management-row ${isActive ? 'active' : ''} ${
                    isSelected ? 'selected' : ''
                  }`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => setSelectedClipTakeId(take.clipTakeId)}
                >
                  <span className="clip-take-option-led" aria-hidden="true" />
                  <span>
                    <strong>{take.label}</strong>
                    <small>
                      TAKE {index + 1} / {take.mediaType.toUpperCase()}
                      {formatClipTakeSeedSuffix(artifacts, take.artifactId)}
                    </small>
                  </span>
                  {isActive ? <em>ACTIVE</em> : null}
                </button>
              );
            })}
          </div>
          <div className="clip-take-management-actions">
            <button
              type="button"
              aria-label={previewControlLabel}
              disabled={!canTogglePreview}
              onClick={() =>
                selectedTake &&
                onPreview(clip.id, selectedTake.clipTakeId)
              }
              title={previewControlLabel}
            >
              {isPreviewingSelected ? 'STOP PREVIEW' : 'PREVIEW'}
            </button>
            <button
              type="button"
              disabled={
                !selectedTake ||
                selectedTake.clipTakeId === clip.activeClipTakeId
              }
              onClick={() =>
                selectedTake &&
                onActivate(clip.id, selectedTake.clipTakeId)
              }
            >
              MAKE ACTIVE
            </button>
            <button
              type="button"
              className="clip-take-remove-action"
              disabled={!selectedTake}
              onClick={() =>
                selectedTake &&
                onRemove(clip.id, selectedTake.clipTakeId)
              }
            >
              REMOVE FROM PROJECT
            </button>
            <button
              type="button"
              className="clip-take-delete-action"
              disabled={selectedTake?.mediaType !== 'audio'}
              onClick={() =>
                selectedTake &&
                onDeleteFile(clip.id, selectedTake.clipTakeId)
              }
            >
              DELETE TAKE + AUDIO FILE
            </button>
          </div>
        </>
      ) : (
        <div className="inspector-empty-state">
          <strong>No Clip Takes</strong>
          <small>Generate, record, or edit a Take to populate this Clip.</small>
        </div>
      )}
      <small className="instrument-audio-preview-note">
        Preview does not change the Active Take or Edit History.
      </small>
    </section>
  );
}

function formatClipTakeSeedSuffix(
  artifacts: readonly ProjectArtifact[],
  artifactId: string,
): string {
  const artifact = artifacts.find(
    (candidate) => candidate.artifactId === artifactId,
  );

  return artifact &&
    artifact.kind === 'audio' &&
    'provenance' in artifact &&
    Number.isSafeInteger(artifact.provenance.seed)
    ? ` / SEED ${artifact.provenance.seed}`
    : '';
}

function formatProjectHealthStatusLabel(health: ProjectHealth): string {
  if (health.dirtyState === 'warning') {
    return 'NEEDS RELINK';
  }

  return health.dirtyState.toUpperCase();
}

function formatProjectHealthStatusDetail(health: ProjectHealth): string {
  if (health.sourceErrorCount > 0 && health.routingErrorCount > 0) {
    return `${health.sourceErrorCount} source errors / ${health.routingErrorCount} routing issues`;
  }

  if (health.sourceErrorCount > 0) {
    return `${health.sourceErrorCount} source errors`;
  }

  if (health.routingErrorCount > 0) {
    return `${health.routingErrorCount} routing issues`;
  }

  if (health.hasUnsavedChanges) {
    return 'Project changes not saved';
  }

  if (health.sourceWarningCount > 0) {
    return `${health.sourceWarningCount} sources need relink`;
  }

  return 'Project graph stable';
}

function TimelineHistoryPanel({
  autoPatchHistoryEntries,
  editHistoryItems,
  selectedClipId,
  onJumpToEditHistory,
  onSelectAutoPatchHistoryClip,
}: {
  autoPatchHistoryEntries: AutoPatchHistoryEntry[];
  editHistoryItems: EditHistoryItem[];
  selectedClipId?: string;
  onJumpToEditHistory: (targetIndex: number) => void;
  onSelectAutoPatchHistoryClip: (clipId: string) => void;
}) {
  return (
    <aside className="timeline-history-panel" aria-label="Timeline History">
      <InspectorEditHistory
        items={editHistoryItems}
        onJump={onJumpToEditHistory}
      />
      <details className="inspector-section inspector-disclosure">
        <summary>
          <span>Auto Patch History</span>
          <small>{autoPatchHistoryEntries.length} marks</small>
        </summary>
        <AutoPatchHistoryPanel
          entries={autoPatchHistoryEntries}
          selectedClipId={selectedClipId}
          onSelectClip={onSelectAutoPatchHistoryClip}
        />
      </details>
    </aside>
  );
}

function SessionHistoryPanel({
  autoPatchHistoryCount,
  editHistoryCount,
  runHistoryCount,
}: {
  autoPatchHistoryCount: number;
  editHistoryCount: number;
  runHistoryCount: number;
}) {
  return (
    <section className="inspector-section">
      <div className="take-history-heading">
        <h3>Session History</h3>
        <small>SESSION</small>
      </div>
      <dl className="inspector-grid">
        <div>
          <dt>Edits</dt>
          <dd>{editHistoryCount}</dd>
        </div>
        <div>
          <dt>Auto Patch</dt>
          <dd>{autoPatchHistoryCount}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{runHistoryCount}</dd>
        </div>
      </dl>
    </section>
  );
}

function RunHistoryPanel({
  project,
  onSelectClip,
}: {
  project: ProjectState;
  onSelectClip: (clipId: string) => void;
}) {
  const [expandedTakeId, setExpandedTakeId] = useState<string>();
  const visibleTakes = limitTakeHistoryEntries(project.takes).slice().reverse();
  const clipInfoMap = useMemo(
    () => createClipInfoMap(project.tracks),
    [project.tracks],
  );

  return (
    <section className="inspector-section">
      <div className="take-history-heading">
        <h3>Run History</h3>
        <small>Latest {MAX_TAKE_HISTORY_ENTRIES}</small>
      </div>
      <div className="inspector-take-list">
        {visibleTakes.length === 0 ? (
          <div className="inspector-empty-state">
            <strong>No Runs</strong>
            <small>Manual, Patch Check, and Production Auto Patch runs will appear here.</small>
          </div>
        ) : (
          visibleTakes.map((take) => {
            const isExpanded = expandedTakeId === take.id;

            return (
              <div key={take.id} className={`inspector-take ${isExpanded ? 'expanded' : ''}`}>
                <button
                  type="button"
                  className="inspector-take-summary"
                  aria-expanded={isExpanded}
                  onClick={() => setExpandedTakeId((currentTakeId) => (currentTakeId === take.id ? undefined : take.id))}
                >
                  <strong>{take.name}</strong>
                  <small>{formatTakeHistorySummary(take)}</small>
                  <small>{formatAutoPatchHistoryTime(take.createdAt)}</small>
                </button>
                {isExpanded && (
                  <TakeHistoryDetails
                    clipInfoMap={clipInfoMap}
                    take={take}
                    onSelectClip={onSelectClip}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function TakeHistoryDetails({
  clipInfoMap,
  take,
  onSelectClip,
}: {
  clipInfoMap: ReadonlyMap<string, SelectedClipInfo>;
  take: Take;
  onSelectClip: (clipId: string) => void;
}) {
  return (
    <div className="inspector-take-details">
      <dl>
        <div>
          <dt>Mode</dt>
          <dd>{formatTakeExecutionMode(take.executionMode)}</dd>
        </div>
        <div>
          <dt>Selection</dt>
          <dd className="take-id-field">
            <span>{formatSelectionItemsForTake(take.sourceSelection)}</span>
            <TakeClipIdList
              clipInfoMap={clipInfoMap}
              clipIds={getSelectionClipIds(take.sourceSelection)}
              onSelectClip={onSelectClip}
            />
          </dd>
        </div>
        <div>
          <dt>TabFlows</dt>
          <dd>{formatTakeIdList(take.appliedTabFlowIds)}</dd>
        </div>
        <div>
          <dt>Patches</dt>
          <dd>{formatPatchSnapshotsForTake(take)}</dd>
        </div>
        <div>
          <dt>Generated</dt>
          <dd className="take-id-field">
            <span>{formatTakeGeneratedSummary(take)}</span>
            <TakeClipIdList
              clipInfoMap={clipInfoMap}
              clipIds={take.generatedClipIds}
              onSelectClip={onSelectClip}
            />
          </dd>
        </div>
      </dl>
      <div className="inspector-take-log-list">
        {take.logs.length === 0 ? (
          <small>No dry-run logs recorded.</small>
        ) : (
          take.logs.map((log, index) => (
            <small key={`${take.id}-log-${index}`} className={`inspector-take-log ${log.level}`}>
              {log.level.toUpperCase()}: {log.message}
            </small>
          ))
        )}
      </div>
    </div>
  );
}

function TakeClipIdList({
  clipInfoMap,
  clipIds,
  onSelectClip,
}: {
  clipInfoMap: ReadonlyMap<string, SelectedClipInfo>;
  clipIds: string[];
  onSelectClip: (clipId: string) => void;
}) {
  if (clipIds.length === 0) {
    return null;
  }

  return (
    <span className="take-id-list">
      {clipIds.map((clipId) => {
        const clipInfo = clipInfoMap.get(clipId);

        return clipInfo ? (
          <button
            key={clipId}
            type="button"
            className="take-id-button"
            aria-label={`Select ${clipInfo.clip.name} on ${clipInfo.track.name}`}
            title={clipInfo.track.name}
            onClick={() => onSelectClip(clipId)}
          >
            <strong>{clipInfo.clip.name}</strong>
            <small>{clipId}</small>
          </button>
        ) : (
          <span key={clipId} className="take-id-token missing">
            <strong>Missing clip</strong>
            <small>{clipId}</small>
          </span>
        );
      })}
    </span>
  );
}

function PresetDrawer({
  isSafetyModeEnabled,
  presets,
  onClose,
  onLoadPreset,
}: {
  isSafetyModeEnabled: boolean;
  presets: TabFlowPreset[];
  onClose: () => void;
  onLoadPreset: (preset: TabFlowPreset) => void;
}) {
  return (
    <div className="inspector-layer">
      <button type="button" className="inspector-backdrop" aria-label="Close presets" onClick={onClose} />
      <aside className="project-inspector preset-drawer" aria-label="TabFlow Presets">
        <div className="inspector-header">
          <div>
            <span className="panel-eyebrow">TabFlow</span>
            <h2>Presets</h2>
          </div>
          <button type="button" className="inspector-close-button" aria-label="Close presets" onClick={onClose}>
            X
          </button>
        </div>
        <section className="inspector-section preset-note">
          <h3>Preset Library</h3>
          <p>Load a stable starter workflow with PatchTabs and connections. Some presets require you to supply Timeline material.</p>
        </section>
        <div className="preset-list" aria-label="Available TabFlow presets">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="preset-card"
              onClick={() => onLoadPreset(preset)}
            >
              <span className="preset-card-header">
                <strong>{preset.name}</strong>
                <small>{isSafetyModeEnabled ? '2 STEP' : `${preset.project.patchTabs.length} tabs`}</small>
              </span>
              <span className="preset-description">{preset.description}</span>
              <span className="preset-intent">{preset.intent}</span>
              <span className="preset-flow-preview" aria-hidden="true">
                {preset.project.patchTabs.map((patchTab) => {
                  const colorCode = getPatchTabColorCode(patchTab.colorIndex);

                  return (
                    <span
                      key={patchTab.id}
                      className={`preset-color-chip ${colorCode.isMultiColor ? 'multi-color' : ''}`}
                      title={patchTab.name}
                      style={
                        {
                          '--tab-color': colorCode.primaryColor,
                          '--tab-color-secondary': colorCode.secondaryColor,
                        } as CSSProperties
                      }
                    />
                  );
                })}
              </span>
              <span className="preset-meta">
                <small>{preset.project.connections.length} routes</small>
                <small>{preset.project.tracks.length} tracks</small>
                <small>{preset.project.bpm} BPM</small>
                <small>{preset.project.key}</small>
              </span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

function createTimelineStatusDiagnostic(health: ProjectHealth): TimelineStatusDiagnostic | undefined {
  const sourceErrors = health.sourceIssues.filter((issue) => issue.status !== 'unresolved');
  const sourceWarnings = health.sourceIssues.filter((issue) => issue.status === 'unresolved');

  if (sourceErrors.length > 0 && health.routingIssues.length > 0) {
    return {
      message: 'PROJECT CHECK',
      helpText: `${formatCount(sourceErrors.length, 'source error')} and ${formatCount(
        health.routingIssues.length,
        'routing issue',
      )} found. Open Project Inspector for details.`,
      tone: 'error',
    };
  }

  if (sourceErrors.length > 0) {
    return {
      message: 'SOURCE OFFLINE',
      helpText: createSourceIssueHelpMessage(sourceErrors) ?? 'Timeline source files are offline.',
      tone: 'error',
    };
  }

  if (health.routingIssues.length > 0) {
    return {
      message: 'ROUTING ERROR',
      helpText: `${formatCount(health.routingIssues.length, 'routing issue')} found. Open Project Inspector for details.`,
      tone: 'error',
    };
  }

  if (sourceWarnings.length > 0) {
    return {
      message: 'SOURCE NEEDS RELINK',
      helpText: createSourceIssueHelpMessage(sourceWarnings) ?? 'Timeline source files need relink.',
      tone: 'warning',
    };
  }

  return undefined;
}

function createSourceIssueHelpMessage(sourceIssues: SourceFileIssue[]): string | undefined {
  if (sourceIssues.length === 0) {
    return undefined;
  }

  const firstIssue = sourceIssues[0];

  if (firstIssue.status === 'unresolved') {
    return firstIssue.restorationAuthority === 'project-root'
      ? `${formatCount(sourceIssues.length, 'source issue')}: ${firstIssue.clipName} requires Project Root source restoration.`
      : `${formatCount(sourceIssues.length, 'source issue')}: ${firstIssue.clipName} remembers ${firstIssue.fileName}. Relink it to use audio data in this session.`;
  }

  return `${formatCount(sourceIssues.length, 'source issue')}: ${firstIssue.clipName} needs ${firstIssue.fileName}. ${formatClipSourceFileStatus(firstIssue.status)}.`;
}

function getProjectSourceFileIssues(tracks: Track[]): SourceFileIssue[] {
  return tracks.flatMap((track) =>
    track.group
      ? []
      : track.clips.flatMap((clip) => {
          const issue = getClipSourceFileIssue(track, clip);

          return issue ? [issue] : [];
        }),
  );
}

function getClipSourceFileIssue(track: Track, clip: Clip): SourceFileIssue | undefined {
  const sourceFile = clip.sourceFile;

  if (!sourceFile || sourceFile.status === 'available') {
    return undefined;
  }

  return {
    id: `${track.id}:${clip.id}:${sourceFile.status}`,
    clipId: clip.id,
    clipName: clip.name,
    fileName: formatClipSourceFileName(clip),
    path: sourceFile.relativePath ?? sourceFile.path ?? sourceFile.lastKnownPath,
    restorationAuthority: sourceFile.relativePath
      ? 'project-root'
      : 'session-file',
    status: sourceFile.status,
    trackId: track.id,
    trackName: track.name,
  };
}

function formatClipSourceFileName(clip: Clip): string {
  const sourceFile = clip.sourceFile;

  if (!sourceFile) {
    return 'No Source File';
  }

  return (
    sourceFile.name ||
    getFileNameFromPath(sourceFile.relativePath ?? sourceFile.path ?? sourceFile.lastKnownPath ?? '') ||
    'Unknown Source'
  );
}

function formatClipSourceFileStatus(status: ClipSourceFileStatus): string {
  if (status === 'missing') {
    return 'Source missing';
  }

  if (status === 'moved') {
    return 'Source moved';
  }

  if (status === 'unresolved') {
    return 'Source needs relink';
  }

  return 'Source available';
}

function formatClipSourceStatusBadge(status: ClipSourceFileStatus): string {
  if (status === 'missing') {
    return 'SOURCE MISSING';
  }

  if (status === 'moved') {
    return 'SOURCE MOVED';
  }

  if (status === 'unresolved') {
    return 'SOURCE NEEDS RELINK';
  }

  return 'SOURCE AVAILABLE';
}

function getClipSourceBadgeTone(status: ClipSourceFileStatus): 'default' | 'warning' | 'error' {
  if (status === 'available') {
    return 'default';
  }

  return status === 'unresolved' ? 'warning' : 'error';
}

function createClipSourceMetadataDetails(
  clip: Clip,
  sourceFile: NonNullable<Clip['sourceFile']>,
  hasSessionAccess: boolean,
): Array<{ label: string; value: string }> {
  const details = [
    { label: 'File Name', value: formatClipSourceFileName(clip) },
    { label: 'Clip Type', value: clip.type },
    { label: 'Source Status', value: formatClipSourceStatusBadge(sourceFile.status) },
    {
      label: 'Source Policy',
      value: sourceFile.relativePath ? 'Project Root managed' : 'Session File',
    },
    { label: 'Session Access', value: hasSessionAccess ? 'Ready' : 'Not held' },
  ];

  if (isFinitePositiveNumber(sourceFile.durationSeconds)) {
    details.push({ label: 'Duration', value: formatDurationSeconds(sourceFile.durationSeconds) });
  }

  if (clip.audioTiming) {
    details.push(
      { label: 'Time Base', value: 'Absolute seconds' },
      {
        label: 'Source Range',
        value: `${clip.audioTiming.sourceStartSeconds.toFixed(2)}-${clip.audioTiming.sourceEndSeconds.toFixed(2)} sec`,
      },
      {
        label: 'Used Duration',
        value: formatDurationSeconds(getAudioClipSourceDurationSeconds(clip.audioTiming)),
      },
    );
  }

  if (isFiniteNonNegativeNumber(sourceFile.sizeBytes)) {
    details.push({ label: 'File Size', value: formatFileSize(sourceFile.sizeBytes) });
  }

  if (sourceFile.mimeType) {
    details.push({ label: 'MIME Type', value: sourceFile.mimeType });
  }

  if (isFiniteNonNegativeNumber(sourceFile.lastModified)) {
    details.push({ label: 'Last Modified', value: formatTimestamp(sourceFile.lastModified) });
  }

  if (sourceFile.relativePath) {
    details.push({ label: 'Managed Path', value: sourceFile.relativePath });
  }

  return details;
}

function createClipSourceMetadataTooltip(clip: Clip, hasSessionAccess: boolean): string {
  const sourceFile = clip.sourceFile;

  if (!sourceFile) {
    return '';
  }

  const lines = createClipSourceMetadataDetails(clip, sourceFile, hasSessionAccess).map(
    ({ label, value }) => `${label}: ${value}`,
  );

  if (sourceFile.status === 'unresolved') {
    lines.push(
      '',
      sourceFile.relativePath
        ? 'Restore this generated source from the Project Root with a ready Local Engine.'
        : 'Relink this local source to use its audio data in the current session.',
    );
  }

  return lines.join('\n');
}

function formatDurationSeconds(durationSeconds: number): string {
  return `${durationSeconds.toFixed(durationSeconds >= 10 ? 1 : 2)} sec`;
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = sizeBytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function getFileNameFromPath(path: string): string {
  const normalizedPath = path.trim();

  if (!normalizedPath) {
    return '';
  }

  return normalizedPath.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function createProjectHealth(
  project: ProjectState,
  selectedPatchTabId: string,
  selectedConnectionId: string,
  selectedClipInfo: SelectedClipInfo | undefined,
  savedProjectFingerprint: string,
): ProjectHealth {
  const patchTabMap = new Map(project.patchTabs.map((patchTab) => [patchTab.id, patchTab]));
  const routingIssues = project.connections.flatMap((connection) => {
    if (getTabFlowConnectionState(connection, patchTabMap) !== 'invalid') {
      return [];
    }

    const sourcePatchTab = patchTabMap.get(connection.fromPatchTabId);
    const targetPatchTab = patchTabMap.get(connection.toPatchTabId);

    return [
      {
        id: connection.id,
        fromName: sourcePatchTab?.name ?? 'Missing Source',
        toName: targetPatchTab?.name ?? 'Missing Target',
        outputType: connection.signalType,
        inputType: targetPatchTab?.inputType ?? 'Missing Input',
      },
    ];
  });
  const selectedPatchTab = patchTabMap.get(selectedPatchTabId);
  const selectedConnection = project.connections.find((connection) => connection.id === selectedConnectionId);
  const selectedSourcePatchTab = selectedConnection ? patchTabMap.get(selectedConnection.fromPatchTabId) : undefined;
  const selectedTargetPatchTab = selectedConnection ? patchTabMap.get(selectedConnection.toPatchTabId) : undefined;
  const projectFingerprint = createDirtyStateFingerprint(project);
  const sourceIssues = getProjectSourceFileIssues(project.tracks);
  const sourceErrorCount = sourceIssues.filter((issue) => issue.status !== 'unresolved').length;
  const sourceWarningCount = sourceIssues.length - sourceErrorCount;
  const hasUnsavedChanges = projectFingerprint !== savedProjectFingerprint;

  return {
    dirtyState:
      routingIssues.length > 0 || sourceErrorCount > 0
        ? 'error'
        : hasUnsavedChanges
          ? 'unsaved'
          : sourceWarningCount > 0
            ? 'warning'
            : 'saved',
    hasUnsavedChanges,
    patchTabCount: project.patchTabs.length,
    routingCount: project.connections.length,
    routingErrorCount: routingIssues.length,
    sourceErrorCount,
    sourceIssueCount: sourceIssues.length,
    sourceWarningCount,
    clipCount: project.tracks.reduce((count, track) => count + track.clips.length, 0),
    artifactCount: project.artifacts?.length ?? 0,
    clipTakeCount: project.tracks.reduce(
      (count, track) =>
        count +
        track.clips.reduce(
          (clipCount, clip) => clipCount + (clip.clipTakes?.length ?? 0),
          0,
        ),
      0,
    ),
    runHistoryCount: project.takes.length,
    selectedPatchTabName: selectedPatchTab?.name ?? 'No PatchTab Selected',
    selectedRoutingName:
      selectedConnection && selectedSourcePatchTab && selectedTargetPatchTab
        ? `${selectedSourcePatchTab.name} → ${selectedTargetPatchTab.name}`
        : 'No TabFlow Line Selected',
    selectedClipName: selectedClipInfo ? `${selectedClipInfo.clip.name} (${selectedClipInfo.clip.type})` : 'No Clip Selected',
    routingIssues,
    sourceIssues,
  };
}

function inferWorkspaceEditDraft(
  previousWorkspace: WorkspaceState,
  nextWorkspace: WorkspaceState,
): WorkspaceEditDraft {
  const previousProject = previousWorkspace.project;
  const nextProject = nextWorkspace.project;
  const previousClips = previousProject.tracks.flatMap((track) => track.clips);
  const nextClips = nextProject.tracks.flatMap((track) => track.clips);
  const previousClipsById = new Map(
    previousClips.map((clip) => [clip.id, clip]),
  );

  for (const nextClip of nextClips) {
    const previousClip = previousClipsById.get(nextClip.id);

    if (
      previousClip &&
      previousClip.activeClipTakeId !== nextClip.activeClipTakeId
    ) {
      const activeTake = nextClip.clipTakes?.find(
        (take) => take.clipTakeId === nextClip.activeClipTakeId,
      );

      return {
        category: 'take',
        label: activeTake
          ? `Activate ${activeTake.label}`
          : `Change Active Take: ${nextClip.name}`,
      };
    }
  }

  const previousAutoPatchCount = previousClips.reduce(
    (count, clip) => count + (clip.appliedTabFlows?.length ?? 0),
    0,
  );
  const nextAutoPatchCount = nextClips.reduce(
    (count, clip) => count + (clip.appliedTabFlows?.length ?? 0),
    0,
  );

  if (nextAutoPatchCount !== previousAutoPatchCount) {
    return {
      category: 'auto-patch',
      label: 'Apply Auto Patch',
    };
  }

  if (nextProject.tracks.length !== previousProject.tracks.length) {
    return {
      category: 'track',
      label:
        nextProject.tracks.length > previousProject.tracks.length
          ? 'Add or Group Track'
          : 'Remove or Ungroup Track',
    };
  }

  if (nextClips.length !== previousClips.length) {
    return {
      category: 'clip',
      label:
        nextClips.length > previousClips.length
          ? 'Add, Paste, or Split Clip'
          : 'Delete Clip',
    };
  }

  for (const nextClip of nextClips) {
    const previousClip = previousClipsById.get(nextClip.id);

    if (!previousClip) {
      continue;
    }

    if (previousClip.startTick !== nextClip.startTick) {
      return { category: 'clip', label: `Move Clip: ${nextClip.name}` };
    }

    if (
      previousClip.lengthTicks !== nextClip.lengthTicks ||
      previousClip.audioTiming?.sourceStartSeconds !==
        nextClip.audioTiming?.sourceStartSeconds ||
      previousClip.audioTiming?.sourceEndSeconds !==
        nextClip.audioTiming?.sourceEndSeconds
    ) {
      return { category: 'clip', label: `Trim Clip: ${nextClip.name}` };
    }

    if (previousClip.name !== nextClip.name) {
      return { category: 'clip', label: `Rename Clip: ${nextClip.name}` };
    }

    if (
      previousClip.clipTakes?.length !== nextClip.clipTakes?.length ||
      previousClip.version !== nextClip.version
    ) {
      return { category: 'take', label: `Update Takes: ${nextClip.name}` };
    }
  }

  const previousTracksById = new Map(
    previousProject.tracks.map((track) => [track.id, track]),
  );

  for (const nextTrack of nextProject.tracks) {
    const previousTrack = previousTracksById.get(nextTrack.id);

    if (!previousTrack) {
      continue;
    }

    if (previousTrack.name !== nextTrack.name) {
      return { category: 'track', label: `Rename Track: ${nextTrack.name}` };
    }

    if (previousTrack.muted !== nextTrack.muted) {
      return {
        category: 'track',
        label: `${nextTrack.muted ? 'Mute' : 'Unmute'} Track: ${nextTrack.name}`,
      };
    }

    if (previousTrack.group?.collapsed !== nextTrack.group?.collapsed) {
      return {
        category: 'track',
        label: `${nextTrack.group?.collapsed ? 'Collapse' : 'Expand'} Track Group`,
      };
    }
  }

  if (previousProject.bpm !== nextProject.bpm) {
    return { category: 'project', label: `Change BPM to ${nextProject.bpm}` };
  }

  if (previousProject.key !== nextProject.key) {
    return { category: 'project', label: `Change Key to ${nextProject.key}` };
  }

  if (previousProject.gridResolution !== nextProject.gridResolution) {
    return {
      category: 'project',
      label: `Change Grid to ${nextProject.gridResolution}`,
    };
  }

  if (previousProject.totalTicks !== nextProject.totalTicks) {
    return { category: 'project', label: 'Change Project Length' };
  }

  if (
    previousProject.connections !== nextProject.connections ||
    previousProject.tabFlowLines !== nextProject.tabFlowLines
  ) {
    return { category: 'routing', label: 'Edit TabFlow Routing' };
  }

  if (previousProject.patchTabs !== nextProject.patchTabs) {
    return { category: 'routing', label: 'Edit PatchTabs' };
  }

  if (previousProject.artifacts !== nextProject.artifacts) {
    return { category: 'take', label: 'Register Project Artifact' };
  }

  if (
    previousProject.tabFlowStageResults !==
    nextProject.tabFlowStageResults
  ) {
    return { category: 'take', label: 'Update TabFlow Result Index' };
  }

  return { category: 'project', label: 'Edit Project' };
}

function createDirtyStateFingerprint(project: ProjectState): string {
  return createProjectDirtyStateFingerprint(project, getProjectTabFlowLines(project));
}

function createWorkspaceFingerprint(workspace: WorkspaceState): string {
  return JSON.stringify(workspace);
}

function createInitialWorkspaceState(): WorkspaceState {
  const project = createEmptyProject();

  return createWorkspaceStateFromProject({
    ...project,
    tabFlowLines: reconcileTabFlowLines(project.connections, []),
  });
}

function createWorkspaceStateFromProject(project: ProjectState, options: ProjectNormalizeOptions = {}): WorkspaceState {
  return createWorkspaceStateFromProjectLoad(project, options).workspace;
}

function createWorkspaceStateFromProjectLoad(
  project: ProjectState,
  options: ProjectNormalizeOptions = {},
): NormalizedProjectLoad<WorkspaceState> {
  const projectLoad = cloneProjectStateWithNormalization(project, options);
  const clonedProject = projectLoad.workspace;

  return createNormalizedProjectLoad(
    normalizeWorkspaceState({
      project: clonedProject,
      selectedPatchTabId: clonedProject.selectedPatchTabId || clonedProject.patchTabs[0]?.id || '',
      selectedTabFlowLineId: clonedProject.tabFlowLines?.[0]?.id ?? '',
      activeTransport: 'STOP',
      selectedClipId: clonedProject.tracks[0]?.clips[0]?.id ?? '',
      selectedConnectionId: clonedProject.connections[0]?.id ?? '',
      pendingPortSelection: undefined,
      recordingSession: undefined,
    }),
    projectLoad.mixerNormalization,
  );
}

function normalizeWorkspaceState(workspace: WorkspaceState): WorkspaceState {
  workspace = {
    ...workspace,
    project: reconcileProjectMixerState(workspace.project),
  };
  const selection = normalizeSelectionState(workspace.project.selection, workspace.project.tracks);
  const tabFlowLines = normalizeTabFlowLines(workspace.project.tabFlowLines, workspace.project.connections);
  const firstSelectedClipId = selection.items.find((item) => item.type === 'clip')?.id;
  const selectedPatchTabId = workspace.project.patchTabs.some((patchTab) => patchTab.id === workspace.selectedPatchTabId)
    ? workspace.selectedPatchTabId
    : workspace.project.patchTabs[0]?.id ?? '';
  const baseSelectedConnectionId = workspace.project.connections.some((connection) => connection.id === workspace.selectedConnectionId)
    ? workspace.selectedConnectionId
    : workspace.project.connections[0]?.id ?? '';
  const selectedTabFlowLineId = getPreferredSelectedTabFlowLineId(
    tabFlowLines,
    workspace.selectedTabFlowLineId,
    baseSelectedConnectionId,
  );
  const selectedTabFlowLine = tabFlowLines.find((line) => line.id === selectedTabFlowLineId);
  const selectedConnectionId =
    selectedTabFlowLine && !selectedTabFlowLine.connectionIds.includes(baseSelectedConnectionId)
      ? selectedTabFlowLine.connectionIds[0] ?? ''
      : baseSelectedConnectionId;
  const selectedClipId = findSelectedClip(workspace.project.tracks, workspace.selectedClipId)
    ? workspace.selectedClipId
    : firstSelectedClipId && findSelectedClip(workspace.project.tracks, firstSelectedClipId)
      ? firstSelectedClipId
      : workspace.selectedClipId
        ? workspace.project.tracks[0]?.clips[0]?.id ?? ''
        : '';
  const pendingPortSelection =
    workspace.pendingPortSelection &&
    workspace.project.patchTabs.some((patchTab) => patchTab.id === workspace.pendingPortSelection?.patchTabId)
      ? workspace.pendingPortSelection
      : undefined;
  const recordingSession =
    workspace.activeTransport === 'REC' && workspace.recordingSession
      ? {
          ...workspace.recordingSession,
          trackId: workspace.recordingSession.trackId || 'hum-audio',
          startTick: clampTick(workspace.recordingSession.startTick, 0, Math.max(0, workspace.project.totalTicks - 1)),
        }
      : undefined;

  return {
    ...workspace,
    project: {
      ...workspace.project,
      selection,
      selectedPatchTabId,
      tabFlowLines,
    },
    selectedPatchTabId,
    selectedTabFlowLineId,
    selectedConnectionId,
    selectedClipId,
    pendingPortSelection,
    recordingSession,
  };
}

function preserveSessionViewState(
  targetWorkspace: WorkspaceState,
  currentWorkspace: WorkspaceState,
): WorkspaceState {
  return normalizeWorkspaceState({
    ...targetWorkspace,
    selectedPatchTabId: currentWorkspace.selectedPatchTabId,
    selectedTabFlowLineId: currentWorkspace.selectedTabFlowLineId,
    activeTransport: currentWorkspace.activeTransport,
    selectedClipId: currentWorkspace.selectedClipId,
    selectedConnectionId: currentWorkspace.selectedConnectionId,
    pendingPortSelection: currentWorkspace.pendingPortSelection,
    recordingSession: currentWorkspace.recordingSession,
    project: {
      ...targetWorkspace.project,
      status: currentWorkspace.project.status,
      isLooping: currentWorkspace.project.isLooping,
      selectedPatchTabId: currentWorkspace.project.selectedPatchTabId,
      selection: currentWorkspace.project.selection,
      playheadTick: currentWorkspace.project.playheadTick,
    },
  });
}

function createHumStudioProjectFile(workspace: WorkspaceState): HumStudioProjectFile {
  const isRuntimeTransportActive =
    workspace.activeTransport === 'PLAY' || workspace.activeTransport === 'REC';

  return {
    app: 'HumSTUDIO',
    version: humStudioProjectFileVersion,
    savedAt: new Date().toISOString(),
    workspace: normalizeWorkspaceState({
      ...workspace,
      activeTransport: isRuntimeTransportActive ? 'STOP' : workspace.activeTransport,
      pendingPortSelection: undefined,
      recordingSession: undefined,
      project: isRuntimeTransportActive
        ? {
            ...workspace.project,
            status: 'READY',
          }
        : workspace.project,
    }),
  };
}

function downloadWorkspaceState(workspace: WorkspaceState): void {
  const projectFile = createHumStudioProjectFile(workspace);
  const blob = new Blob([JSON.stringify(projectFile, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = `elpisdaw-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function parseHumStudioProjectFile(rawText: string): NormalizedProjectLoad<WorkspaceState> {
  const trimmedText = rawText.trim();

  if (!trimmedText) {
    throw new Error('Project file is empty.');
  }

  let parsedValue: unknown;

  try {
    parsedValue = JSON.parse(trimmedText);
  } catch {
    throw new Error('Project file is not valid JSON.');
  }

  return parseHumStudioProjectValue(parsedValue);
}

function parseHumStudioProjectValue(parsedValue: unknown): NormalizedProjectLoad<WorkspaceState> {
  if (isRecord(parsedValue) && parsedValue.app === 'HumSTUDIO' && isRecord(parsedValue.workspace)) {
    return workspaceStateFromUnknown(parsedValue.workspace, { sourceFileLoadMode: 'json-reload' });
  }

  if (isRecord(parsedValue) && parsedValue.app === 'HumSTUDIO') {
    throw new Error('ElpisDAW project workspace is missing or invalid.');
  }

  if (isRecord(parsedValue) && 'app' in parsedValue && parsedValue.app !== 'HumSTUDIO') {
    throw new Error('This JSON belongs to another app, not ElpisDAW.');
  }

  if (isRecord(parsedValue) && isRecord(parsedValue.project)) {
    return workspaceStateFromUnknown(parsedValue, { sourceFileLoadMode: 'json-reload' });
  }

  if (isProjectStateLike(parsedValue)) {
    return createWorkspaceStateFromProjectLoad(parsedValue, { sourceFileLoadMode: 'json-reload' });
  }

  throw new Error('This JSON does not look like an ElpisDAW project file.');
}

function workspaceStateFromUnknown(
  value: Record<string, unknown>,
  options: ProjectNormalizeOptions = {},
): NormalizedProjectLoad<WorkspaceState> {
  const projectValue = value.project;

  if (!isProjectStateLike(projectValue)) {
    throw new Error('Project data is missing or invalid.');
  }

  const projectLoad = cloneProjectStateWithNormalization(projectValue, options);
  const project = projectLoad.workspace;
  const restoredProject = isTransientProjectStatus(project.status)
    ? { ...project, status: 'READY' }
    : project;

  return createNormalizedProjectLoad(
    normalizeWorkspaceState({
      project: restoredProject,
      selectedPatchTabId: typeof value.selectedPatchTabId === 'string' ? value.selectedPatchTabId : project.selectedPatchTabId,
      selectedTabFlowLineId: typeof value.selectedTabFlowLineId === 'string' ? value.selectedTabFlowLineId : '',
      activeTransport:
        isTransportButton(value.activeTransport) &&
        value.activeTransport !== 'PLAY' &&
        value.activeTransport !== 'REC'
          ? value.activeTransport
          : 'STOP',
      selectedClipId: typeof value.selectedClipId === 'string' ? value.selectedClipId : project.tracks[0]?.clips[0]?.id ?? '',
      selectedConnectionId:
        typeof value.selectedConnectionId === 'string' ? value.selectedConnectionId : project.connections[0]?.id ?? '',
      pendingPortSelection: isPatchPortSelection(value.pendingPortSelection) ? value.pendingPortSelection : undefined,
      recordingSession: normalizeRecordingSession(value.recordingSession),
    }),
    projectLoad.mixerNormalization,
  );
}

function isTransientProjectStatus(status: string): boolean {
  return (
    status === 'PLAYING' ||
    status === 'RECORDING' ||
    status.startsWith('COUNT IN')
  );
}

function cloneProjectState(project: ProjectState, options: ProjectNormalizeOptions = {}): ProjectState {
  return cloneProjectStateWithNormalization(project, options).workspace;
}

function cloneProjectStateWithNormalization(
  project: ProjectState,
  options: ProjectNormalizeOptions = {},
): NormalizedProjectLoad<ProjectState> {
  const projectRecord = project as ProjectState & Record<string, unknown>;
  const migratedPatchTabFlow = migrateLegacyTimelinePatchTabs(project.patchTabs, project.connections);
  const normalizedConnections = sortTabFlowConnections(
    migratedPatchTabFlow.connections.map((connection, index) => normalizeTabFlowConnection(connection, index)),
  );
  const routingContractMigration = migratePatchTabRoutingContracts(
    migratedPatchTabFlow.patchTabs,
    normalizedConnections,
    normalizeTabFlowLines(project.tabFlowLines, normalizedConnections),
  );
  const tabFlowLines = routingContractMigration.tabFlowLines;
  const connections = synchronizeTabFlowConnectionStates(
    sortTabFlowConnections(routingContractMigration.connections),
    tabFlowLines,
    routingContractMigration.patchTabs,
  );
  const synchronizedPatchTabs = synchronizePatchTabConnectionBindings(
    routingContractMigration.patchTabs,
    connections,
  );
  const tracks = project.tracks.map((track, index) => {
    const clips = track.clips.map((clip) => normalizeClipMetadata(clip, track, project.bpm, options));

    return {
      ...track,
      name: normalizeTrackName(track.name, index),
      type: normalizeTrackType(track.type, clips),
      parentGroupId: typeof track.parentGroupId === 'string' ? track.parentGroupId : track.parentGroupId ?? null,
      group: normalizeTrackGroupData(track.group),
      clips,
    };
  });
  const artifacts = normalizeProjectArtifacts(projectRecord.artifacts);
  const timingNormalizedTracks = normalizeLegacyAceStepCoverClipTiming(
    tracks,
    artifacts,
    project.bpm,
  );
  const mixerNormalization = normalizeProjectMixerState(
    timingNormalizedTracks,
    projectRecord.mixer,
  );
  const totalTicks = normalizeTickValue(projectRecord.totalTicks, projectRecord.totalBeats, beatsToTicks(64));
  const playheadTick = clampTick(normalizeTickValue(projectRecord.playheadTick, projectRecord.playheadBeat, 0), 0, totalTicks);
  const {
    artifacts: _projectArtifacts,
    mixer: _projectMixer,
    tabFlowStageResults: _tabFlowStageResults,
    totalBeats: _legacyTotalBeats,
    playheadBeat: _legacyPlayheadBeat,
    ...projectWithoutLegacyTimeline
  } = projectRecord;
  const tabFlowStageResults = normalizeTabFlowStageResultIndex(
    projectRecord.tabFlowStageResults,
  );

  const normalizedProject: ProjectState = {
    ...projectWithoutLegacyTimeline,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(tabFlowStageResults.length > 0 ? { tabFlowStageResults } : {}),
    totalTicks,
    playheadTick,
    gridResolution: normalizeTimelineGridResolution(projectRecord.gridResolution),
    recordingSettings: normalizeRecordingSettings(projectRecord.recordingSettings),
    patchTabs: synchronizedPatchTabs.map((patchTab) => ({
      ...patchTab,
      generationContinuation: normalizePatchTabGenerationContinuation(
        patchTab.generationContinuation,
      ),
      inputTypes: patchTab.inputTypes ? [...patchTab.inputTypes] : undefined,
      outputTypes: patchTab.outputTypes ? [...patchTab.outputTypes] : undefined,
      inputBindings: patchTab.inputBindings?.map((binding) =>
        binding.kind === 'connection'
          ? { ...binding, connectionIds: [...binding.connectionIds] }
          : { ...binding },
      ),
      portContractSnapshot: patchTab.portContractSnapshot
        ? {
            ...patchTab.portContractSnapshot,
            inputs: patchTab.portContractSnapshot.inputs.map((port) => ({
              ...port,
              accepts: port.accepts.map((acceptedType) => ({ ...acceptedType })),
              allowedBindings: [...port.allowedBindings],
              cardinality: { ...port.cardinality },
              preferredRoles: port.preferredRoles ? [...port.preferredRoles] : undefined,
              requiredCapabilities: port.requiredCapabilities
                ? [...port.requiredCapabilities]
                : undefined,
            })),
            outputs: patchTab.portContractSnapshot.outputs.map((port) => ({
              ...port,
              produces: { ...port.produces },
              capabilities: port.capabilities ? [...port.capabilities] : undefined,
            })),
          }
        : undefined,
      parameters: normalizePatchTabParameters(patchTab),
    })),
    connections,
    tabFlowLines,
    tracks: mixerNormalization.tracks,
    mixer: mixerNormalization.mixer,
    selection: normalizeSelectionState(project.selection, mixerNormalization.tracks),
    takes: normalizeTakes(project.takes),
  };

  return createNormalizedProjectLoad(
    normalizedProject,
    mixerNormalization.metadata,
  );
}

function normalizePatchTabGenerationContinuation(
  value: unknown,
): PatchTab['generationContinuation'] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('kind' in value) ||
    !('outputClipId' in value) ||
    !('recipeFingerprint' in value) ||
    (value.kind !== 'ace-step-cover' &&
      value.kind !== 'ace-step-text-to-music' &&
      value.kind !== 'stable-audio-3-text-to-audio' &&
      value.kind !== 'stable-audio-3-audio-to-audio') ||
    typeof value.outputClipId !== 'string' ||
    value.outputClipId.length === 0 ||
    value.outputClipId.trim() !== value.outputClipId ||
    typeof value.recipeFingerprint !== 'string' ||
    value.recipeFingerprint.length === 0
  ) {
    return undefined;
  }

  if (
    value.kind === 'stable-audio-3-audio-to-audio' ||
    value.kind === 'ace-step-cover'
  ) {
    if (
      !('sourceClipId' in value) ||
      !('sourceClipTakeId' in value) ||
      typeof value.sourceClipId !== 'string' ||
      value.sourceClipId.length === 0 ||
      value.sourceClipId.trim() !== value.sourceClipId ||
      typeof value.sourceClipTakeId !== 'string' ||
      value.sourceClipTakeId.length === 0 ||
      value.sourceClipTakeId.trim() !== value.sourceClipTakeId
    ) {
      return undefined;
    }

    return {
      kind: value.kind,
      outputClipId: value.outputClipId,
      recipeFingerprint: value.recipeFingerprint,
      sourceClipId: value.sourceClipId,
      sourceClipTakeId: value.sourceClipTakeId,
    };
  }

  return {
    kind: value.kind,
    outputClipId: value.outputClipId,
    recipeFingerprint: value.recipeFingerprint,
  };
}

function normalizePatchTabParameters(patchTab: PatchTab): PatchTabParameter[] {
  const parameters =
    patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.instrument
      ? normalizeInstrumentPresetParameters(patchTab.parameters)
      : patchTab.parameters.map((parameter) =>
          parameter.kind === 'select'
            ? {
                ...parameter,
                options: [...parameter.options],
              }
            : { ...parameter },
        );
  const needsStableAudio3Takes =
    (patchTab.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3 ||
      patchTab.nodeTypeId ===
        BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio) &&
    !parameters.some((parameter) => parameter.id === 'takes');

  if (!needsStableAudio3Takes) {
    return parameters;
  }

  const seedIndex = parameters.findIndex(
    (parameter) => parameter.id === 'seed',
  );
  const takesParameter: PatchTabParameter = {
    id: 'takes',
    kind: 'number',
    label: 'Takes',
    max: STABLE_AUDIO_3_MAX_TAKES,
    min: STABLE_AUDIO_3_MIN_TAKES,
    step: 1,
    value: 1,
  };

  if (seedIndex < 0) {
    return [...parameters, takesParameter];
  }

  return [
    ...parameters.slice(0, seedIndex + 1),
    takesParameter,
    ...parameters.slice(seedIndex + 1),
  ];
}

function normalizeTrackName(name: unknown, trackIndex: number): string {
  const trimmedName = typeof name === 'string' ? name.trim() : '';

  return trimmedName || createDefaultTrackName(trackIndex);
}

function createDefaultTrackName(trackIndex: number): string {
  return `TRACK ${String(trackIndex + 1).padStart(2, '0')}`;
}

function normalizeTrackType(trackType: unknown, clips: Clip[]): Track['type'] {
  const validTrackTypes = new Set<Track['type']>([
    'blank',
    'audio',
    'midi',
    'arrangement',
    'master',
    'generated_audio',
    'vocal',
    'drum',
    'bass',
    'chord',
    'melody',
    'fx',
    'group',
  ]);

  if (typeof trackType === 'string' && validTrackTypes.has(trackType as Track['type'])) {
    const normalizedType = trackType as Track['type'];

    return normalizedType === 'blank' && clips.length > 0 ? getTrackTypeForClipType(clips[0].type) : normalizedType;
  }

  return clips.length > 0 ? getTrackTypeForClipType(clips[0].type) : 'blank';
}

function createBlankTimelineTrack(tracks: Track[]): Track {
  return {
    id: createUniqueTrackId(tracks, 'track'),
    name: createNextDefaultTrackName(tracks),
    type: 'blank',
    level: 0,
    clips: [],
    parentGroupId: null,
  };
}

function createNextDefaultTrackName(tracks: Track[]): string {
  const usedTrackNames = new Set(tracks.map((track) => track.name));
  let trackNumber = tracks.length + 1;
  let trackName = createDefaultTrackName(trackNumber - 1);

  while (usedTrackNames.has(trackName)) {
    trackNumber += 1;
    trackName = createDefaultTrackName(trackNumber - 1);
  }

  return trackName;
}

function isLikelyAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) {
    return true;
  }

  return /\.(aac|aif|aiff|flac|m4a|mp3|ogg|opus|wav|webm)$/i.test(file.name);
}

function createAudioFileMetadata(file: File, durationSeconds: number): AudioImportMetadata {
  return {
    name: file.name,
    sourceId: createAudioSourceId(file),
    mimeType: file.type,
    sizeBytes: file.size,
    lastModified: file.lastModified,
    durationSeconds,
  };
}

function createAudioSourceId(file: File): string {
  const fileName = sanitizeIdPart(file.name.replace(/\.[^.]+$/, '')) || 'audio';
  const uniqueId =
    typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return `audio-source-${fileName}-${uniqueId}`;
}

function createPianoRollTakeIdentity(): PianoRollTakeIdentity {
  const uniqueId =
    typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const createdAt = new Date().toISOString();

  return {
    artifactId: `artifact-midi-edit-${uniqueId}`,
    createdAt,
    sourceEditId: `midi-edit-${uniqueId}`,
  };
}

function createAutoPatchProductionIdentityServices(): AutoPatchDriverIdentityServices {
  return Object.freeze({
    allocateId: (kind: AutoPatchDriverIdentityKind) =>
      createAutoPatchProductionId(kind),
    clock: () => new Date().toISOString(),
  });
}

function createAutoPatchProductionId(kind: string): string {
  const uniqueId =
    typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return `auto-patch-${kind}-${uniqueId}`;
}

function createProjectPlaybackTargetLabel(
  plan: ProjectPlaybackPlan,
  tracks: readonly Track[],
): string {
  if (plan.target.kind === 'all') {
    return 'All Project Tracks';
  }

  if (plan.target.kind === 'tracks') {
    return `${plan.target.trackIds.length} selected Tracks`;
  }

  if (plan.target.kind === 'groups') {
    return `${plan.target.groupTrackIds.length} selected Groups`;
  }

  const targetTrackId =
    plan.target.kind === 'group'
      ? plan.target.groupTrackId
      : plan.target.kind === 'track'
        ? plan.target.trackId
        : plan.tracks[0]?.trackId;
  const track = tracks.find((candidate) => candidate.id === targetTrackId);

  return track?.name ?? (plan.target.kind === 'group' ? 'Selected Group' : 'Selected Track');
}

function isProjectPlaybackLoopAvailable(plan: ProjectPlaybackPlan): boolean {
  return (
    plan.target.kind === 'all' ||
    plan.target.kind === 'track' ||
    plan.target.kind === 'group'
  );
}

function readAudioFileDurationSeconds(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const objectUrl = URL.createObjectURL(file);
    let didSettle = false;
    const timeoutId = window.setTimeout(() => {
      settle(() => reject(new Error('Audio metadata timed out. Try a shorter or supported audio file.')));
    }, AUDIO_IMPORT_DURATION_TIMEOUT_MS);

    const settle = (callback: () => void) => {
      if (didSettle) {
        return;
      }

      didSettle = true;
      window.clearTimeout(timeoutId);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(objectUrl);
      callback();
    };

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const durationSeconds = audio.duration;

      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        settle(() => reject(new Error('Audio duration could not be read. Import needs duration for Timeline placement.')));
        return;
      }

      settle(() => resolve(durationSeconds));
    };
    audio.onerror = () => {
      settle(() => reject(new Error('Audio metadata could not be read. Import supports browser-readable audio files only.')));
    };
    audio.src = objectUrl;
  });
}

function createAudioImportWorkspaceUpdate(
  workspace: WorkspaceState,
  metadata: AudioImportMetadata,
): AudioImportWorkspaceUpdate {
  const durationTicks = secondsToTimelineTicks(metadata.durationSeconds, workspace.project.bpm);
  const startTick = resolveTimelineTick(
    workspace.project.playheadTick,
    workspace.project.gridResolution,
    workspace.project.totalTicks,
  );
  const endTick = startTick + durationTicks;
  const maxTotalTicks = barsToTicks(MAX_TIMELINE_BARS);

  if (endTick > maxTotalTicks) {
    return {
      canImport: false,
      reason: 'timeline-limit',
      message: `Import blocked: ${metadata.name} would exceed the maximum Timeline length of ${MAX_TIMELINE_BARS} bars. Move the playhead earlier or choose shorter audio.`,
    };
  }

  const requiredTotalTicks = barsToTicks(Math.ceil(ticksToBars(endTick)));
  const nextTotalTicks = Math.max(workspace.project.totalTicks, requiredTotalTicks);
  const extendedToBars =
    nextTotalTicks > workspace.project.totalTicks ? Math.round(ticksToBars(nextTotalTicks)) : undefined;

  const { tracks, track } = ensureAudioImportTrack(workspace.project.tracks, workspace.project.selection);

  if (doesTickRangeOverlapTrack(startTick, endTick, track)) {
    return {
      canImport: false,
      reason: 'clip-overlap',
      message: `Import blocked: ${metadata.name} would overlap a clip on ${track.name}. Move the playhead or select another audio track.`,
    };
  }

  const usedClipIds = new Set(tracks.flatMap((candidate) => candidate.clips.map((clip) => clip.id)));
  const clip = createImportedAudioClip(workspace.project, track, metadata, startTick, durationTicks, usedClipIds);
  const resolvedTrack: Track = { ...track, type: 'audio' };
  const nextTracks = tracks.map((candidate) =>
    candidate.id === resolvedTrack.id
      ? {
          ...resolvedTrack,
          clips: [...candidate.clips, clip],
        }
      : candidate,
  );

  return {
    canImport: true,
    clip,
    extendedToBars,
    track: resolvedTrack,
    workspace: {
      ...workspace,
      selectedClipId: clip.id,
      project: {
        ...workspace.project,
        totalTicks: nextTotalTicks,
        playheadTick: Math.min(nextTotalTicks, endTick),
        tracks: nextTracks,
        selection: createSelectionFromItems([{ type: 'clip', id: clip.id }]),
      },
    },
  };
}

function ensureAudioImportTrack(
  tracks: Track[],
  selection: SelectionState,
): { tracks: Track[]; track: Track } {
  const selectedTrackIds = selection.items.filter((item) => item.type === 'track').map((item) => item.id);
  const selectedTrack = selectedTrackIds.length === 1 ? tracks.find((track) => track.id === selectedTrackIds[0]) : undefined;
  const targetTrack =
    (selectedTrack && isAudioImportTrackCandidate(selectedTrack) ? selectedTrack : undefined) ??
    tracks.find((track) => track.id === 'hum-audio' && isAudioImportTrackCandidate(track)) ??
    tracks.find((track) => track.type === 'audio' && isAudioImportTrackCandidate(track)) ??
    tracks.find((track) => track.type === 'blank' && isAudioImportTrackCandidate(track));

  if (targetTrack) {
    return { tracks, track: targetTrack };
  }

  const track = createAudioImportTrack(tracks);

  return { tracks: [track, ...tracks], track };
}

function isAudioImportTrackCandidate(track: Track): boolean {
  return !track.group && (track.type === 'audio' || track.type === 'blank');
}

function createAudioImportTrack(tracks: Track[]): Track {
  return {
    id: tracks.some((track) => track.id === 'hum-audio') ? createUniqueTrackId(tracks, 'hum-audio') : 'hum-audio',
    name: createUniqueTrackName(tracks, 'Hum Audio'),
    type: 'audio',
    level: -8,
    clips: [],
    parentGroupId: null,
  };
}

function createUniqueTrackName(tracks: Track[], baseName: string): string {
  const usedTrackNames = new Set(tracks.map((track) => track.name));

  if (!usedTrackNames.has(baseName)) {
    return baseName;
  }

  let trackNumber = 2;
  let trackName = `${baseName} ${trackNumber}`;

  while (usedTrackNames.has(trackName)) {
    trackNumber += 1;
    trackName = `${baseName} ${trackNumber}`;
  }

  return trackName;
}

function createImportedAudioClip(
  project: ProjectState,
  track: Track,
  metadata: AudioImportMetadata,
  startTick: number,
  lengthTicks: number,
  usedClipIds: Set<string>,
): Clip {
  const importedAt = new Date().toISOString();
  const fileBaseName = metadata.name.replace(/\.[^.]+$/, '').trim() || 'Imported Audio';

  return {
    id: createUniqueClipId(usedClipIds, `clip-import-${fileBaseName}`),
    type: 'hum-audio',
    name: fileBaseName,
    startTick,
    lengthTicks,
    color: getClipTypeColor('hum-audio'),
    generatedBy: 'Audio Import',
    sourceFile: {
      name: metadata.name,
      status: 'available',
      sourceId: metadata.sourceId,
      checkedAt: importedAt,
      ...(metadata.mimeType ? { mimeType: metadata.mimeType } : {}),
      sizeBytes: metadata.sizeBytes,
      lastModified: metadata.lastModified,
      durationSeconds: metadata.durationSeconds,
    },
    audioTiming: createFullSourceAudioClipTiming(metadata.durationSeconds),
    createdAt: importedAt,
    version: 1,
  };
}

function createSourceRelinkWorkspaceUpdate(
  workspace: WorkspaceState,
  clipId: string,
  metadata: AudioImportMetadata,
): SourceRelinkWorkspaceUpdate {
  const selectedClipInfo = findSelectedClip(workspace.project.tracks, clipId);

  if (!selectedClipInfo) {
    return {
      canRelink: false,
      message: 'Relink blocked: source clip was not found.',
    };
  }

  const { clip, track } = selectedClipInfo;

  if (!clip.sourceFile) {
    return {
      canRelink: false,
      message: `Relink blocked: ${clip.name} has no source metadata.`,
    };
  }

  const relinkTargets = getSourceRelinkTargets(workspace.project.tracks, selectedClipInfo);

  for (const target of relinkTargets) {
    const mismatchMessage = validateRelinkSourceMetadata(target.clip, metadata);

    if (mismatchMessage) {
      const isSelectedClip = target.track.id === track.id && target.clip.id === clip.id;

      return {
        canRelink: false,
        message: isSelectedClip
          ? mismatchMessage
          : `Relink blocked: shared source metadata conflicts on ${target.clip.name}. ${mismatchMessage.replace(
              /^Relink blocked:\s*/,
              '',
            )}`,
      };
    }
  }

  const relinkedAt = new Date().toISOString();
  const sourceId = clip.sourceFile.sourceId?.trim() || metadata.sourceId;
  const targetClips = new Set(relinkTargets.map((target) => target.clip));
  let nextClip = clip;
  let nextTrack = track;
  const nextTracks = workspace.project.tracks.map((candidate) => {
    let didRelinkClip = false;
    const clips = candidate.clips.map((candidateClip) => {
      if (!targetClips.has(candidateClip) || !candidateClip.sourceFile) {
        return candidateClip;
      }

      didRelinkClip = true;
      const relinkedClip: Clip = {
        ...candidateClip,
        sourceFile: {
          ...candidateClip.sourceFile,
          name: metadata.name,
          status: 'available',
          sourceId,
          checkedAt: relinkedAt,
          ...(metadata.mimeType ? { mimeType: metadata.mimeType } : {}),
          sizeBytes: metadata.sizeBytes,
          lastModified: metadata.lastModified,
          durationSeconds: metadata.durationSeconds,
        },
      };

      if (candidate.id === track.id && candidateClip.id === clip.id) {
        nextClip = relinkedClip;
      }

      return relinkedClip;
    });

    if (!didRelinkClip) {
      return candidate;
    }

    const relinkedTrack = {
      ...candidate,
      clips,
    };

    if (candidate.id === track.id) {
      nextTrack = relinkedTrack;
    }

    return relinkedTrack;
  });

  return {
    canRelink: true,
    clip: nextClip,
    relinkedClipCount: relinkTargets.length,
    track: nextTrack,
    workspace: {
      ...workspace,
      selectedClipId: nextClip.id,
      project: {
        ...workspace.project,
        tracks: nextTracks,
        selection: createSelectionFromItems([{ type: 'clip', id: nextClip.id }]),
      },
    },
  };
}

function getSourceRelinkTargets(tracks: Track[], selectedClipInfo: SelectedClipInfo): SelectedClipInfo[] {
  const sourceId = selectedClipInfo.clip.sourceFile?.sourceId?.trim();

  if (!sourceId) {
    return [selectedClipInfo];
  }

  return tracks.flatMap((track) =>
    track.clips
      .filter((clip) => clip.sourceFile?.sourceId?.trim() === sourceId)
      .map((clip) => ({ clip, track })),
  );
}

function validateRelinkSourceMetadata(clip: Clip, metadata: AudioImportMetadata): string | undefined {
  const sourceFile = clip.sourceFile;

  if (!sourceFile) {
    return `Relink blocked: ${clip.name} has no source metadata.`;
  }

  if (sourceFile.name.trim() && sourceFile.name !== metadata.name) {
    return `Relink blocked: expected ${sourceFile.name}, but selected ${metadata.name}.`;
  }

  if (isFiniteNonNegativeNumber(sourceFile.sizeBytes) && sourceFile.sizeBytes !== metadata.sizeBytes) {
    return `Relink blocked: ${metadata.name} file size does not match the saved source metadata.`;
  }

  if (
    clip.audioTiming &&
    !doesAudioClipTimingFitSourceDuration(clip.audioTiming, metadata.durationSeconds)
  ) {
    return `Relink blocked: ${metadata.name} is shorter than the source range used by ${clip.name}.`;
  }

  if (
    isFinitePositiveNumber(sourceFile.durationSeconds) &&
    Math.abs(sourceFile.durationSeconds - metadata.durationSeconds) > AUDIO_RELINK_DURATION_TOLERANCE_SECONDS
  ) {
    return `Relink blocked: ${metadata.name} duration does not match the saved source metadata.`;
  }

  return undefined;
}

function copyTimelineSelection(
  project: ProjectState,
  availability: TimelineCopyAvailability,
): { project: ProjectState; track: Track } | undefined {
  if (
    availability.mode === 'group' &&
    availability.canCopy &&
    availability.groupPlan
  ) {
    const groupCopy = applyFlatGroupTrackCopyPlan(
      project,
      availability.groupPlan,
    );

    return groupCopy.canCopy
      ? { project: groupCopy.project, track: groupCopy.clonedGroupTrack }
      : undefined;
  }

  const trackCopy = copyTimelineSelectionToTrack(
    project.tracks,
    availability,
  );

  return trackCopy
    ? {
        project: {
          ...project,
          selection: createSelectionFromItems([
            { type: 'track', id: trackCopy.track.id },
          ]),
          tracks: trackCopy.tracks,
        },
        track: trackCopy.track,
      }
    : undefined;
}

function copyTimelineSelectionToTrack(
  tracks: Track[],
  availability: TimelineCopyAvailability,
): { tracks: Track[]; track: Track } | undefined {
  if (!availability.canCopy || !availability.sourceTrack) {
    return undefined;
  }

  const copyResult = copyOrdinaryTimelineTrack(
    tracks,
    availability.sourceTrack.id,
    availability.mode === 'clips'
      ? availability.clipInfos.map((clipInfo) => clipInfo.clip.id)
      : undefined,
  );

  return copyResult.canCopy
    ? { track: copyResult.track, tracks: copyResult.tracks }
    : undefined;
}

function createUniqueTrackId(tracks: Track[], baseId: string): string {
  const usedTrackIds = new Set(tracks.map((track) => track.id));
  const safeBaseId = sanitizeIdPart(baseId) || 'track';
  let trackNumber = tracks.length + 1;
  let trackId = `${safeBaseId}-${String(trackNumber).padStart(2, '0')}`;

  while (usedTrackIds.has(trackId)) {
    trackNumber += 1;
    trackId = `${safeBaseId}-${String(trackNumber).padStart(2, '0')}`;
  }

  return trackId;
}

function createUniqueClipId(usedClipIds: Set<string>, baseId: string): string {
  const safeBaseId = sanitizeIdPart(baseId) || 'clip-copy';
  let clipNumber = 1;
  let clipId = `${safeBaseId}-${clipNumber}`;

  while (usedClipIds.has(clipId)) {
    clipNumber += 1;
    clipId = `${safeBaseId}-${clipNumber}`;
  }

  return clipId;
}

function getTimelineClipCopyAvailability(tracks: Track[], selection: SelectionState): TimelineClipCopyAvailability {
  const normalizedSelection = normalizeSelectionState(selection, tracks);
  const selectedClipIds = new Set(normalizedSelection.items.filter((item) => item.type === 'clip').map((item) => item.id));
  const clipInfos = getSelectedClipInfos(tracks, selectedClipIds);

  if (clipInfos.length === 0) {
    return {
      canCopy: false,
      message: 'Select one or more clips on the same track before copying.',
      clipInfos,
    };
  }

  const sourceTrack = clipInfos[0].track;
  const isSingleSourceTrack = clipInfos.every((clipInfo) => clipInfo.track.id === sourceTrack.id);

  if (!isSingleSourceTrack) {
    return {
      canCopy: false,
      message: 'Copy supports clips from one source track at a time.',
      clipInfos,
    };
  }

  return {
    canCopy: true,
    sourceTrack,
    message: `Copy ${formatCount(clipInfos.length, 'clip')} from ${sourceTrack.name}.`,
    clipInfos,
  };
}

function createTimelineClipClipboard(sourceTrack: Track, clipInfos: SelectedClipInfo[]): TimelineClipClipboard {
  const clips = clipInfos
    .map((clipInfo) => cloneTimelineClipboardClip(clipInfo.clip))
    .sort((left, right) => left.startTick - right.startTick);
  const startTick = Math.min(...clips.map((clip) => clip.startTick));
  const sourceTrackType = getEffectiveTimelineTrackType(sourceTrack, clips);

  return {
    sourceTrackId: sourceTrack.id,
    sourceTrackName: sourceTrack.name,
    sourceTrackType,
    startTick,
    clips,
    copiedAt: new Date().toISOString(),
  };
}

function cloneTimelineClipboardClip(clip: Clip): Clip {
  return {
    ...clip,
    parameterSnapshot: clip.parameterSnapshot ? { ...clip.parameterSnapshot } : undefined,
    soundFont: cloneSoundFontAssignment(clip.soundFont),
    exportManifest: clip.exportManifest ? { ...clip.exportManifest } : undefined,
    appliedTabFlows: clip.appliedTabFlows?.map((application) => ({
      ...application,
      sourceConnectionIds: [...application.sourceConnectionIds],
    })),
  };
}

function getTimelineClipPasteAvailability(
  project: ProjectState,
  selection: SelectionState,
  clipboard: TimelineClipClipboard | undefined,
  targetTrackId?: string,
): TimelineClipPasteAvailability {
  const startTick = resolveTimelineTick(project.playheadTick, project.gridResolution, project.totalTicks);

  if (!clipboard || clipboard.clips.length === 0) {
    return {
      canPaste: false,
      message: 'Copy Timeline clips before pasting.',
      startTick,
    };
  }

  const targetTrack =
    getTimelinePasteTargetTrack(project.tracks, selection, targetTrackId) ??
    project.tracks.find((track) => track.id === clipboard.sourceTrackId);

  if (!targetTrack) {
    return {
      canPaste: false,
      message: 'Select one target track before pasting.',
      startTick,
    };
  }

  if (targetTrack.group) {
    return {
      canPaste: false,
      message: 'Paste to a normal track, not a group track.',
      targetTrack,
      startTick,
    };
  }

  if (!canPasteTimelineClipboardToTrack(clipboard, targetTrack)) {
    return {
      canPaste: false,
      message: `Paste needs a ${formatTrackTypeName(clipboard.sourceTrackType)} track.`,
      targetTrack,
      startTick,
    };
  }

  const endTick = getTimelineClipboardEndTick(clipboard, startTick);

  if (endTick > project.totalTicks) {
    return {
      canPaste: false,
      message: 'Paste would exceed the Timeline length.',
      targetTrack,
      startTick,
    };
  }

  if (doesTimelineClipboardOverlapTrack(clipboard, targetTrack, startTick)) {
    return {
      canPaste: false,
      message: `Paste would overlap clips on ${targetTrack.name}.`,
      targetTrack,
      startTick,
    };
  }

  return {
    canPaste: true,
    message: `Paste ${formatCount(clipboard.clips.length, 'clip')} to ${targetTrack.name} at beat ${formatTickBeatPosition(
      startTick,
    )}.`,
    targetTrack,
    startTick,
  };
}

function pasteTimelineClipClipboard(
  project: ProjectState,
  selection: SelectionState,
  clipboard: TimelineClipClipboard,
  targetTrackId?: string,
): { project: ProjectState; pastedClips: Clip[] } | undefined {
  const availability = getTimelineClipPasteAvailability(project, selection, clipboard, targetTrackId);

  if (!availability.canPaste || !availability.targetTrack) {
    return undefined;
  }

  const pastedClips = createPastedTimelineClips(clipboard, project.tracks, availability.startTick);
  const targetTrackIdToUpdate = availability.targetTrack.id;
  const resolvedTargetTrackType =
    availability.targetTrack.type === 'blank' ? clipboard.sourceTrackType : availability.targetTrack.type;

  return {
    pastedClips,
    project: {
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === targetTrackIdToUpdate
          ? {
              ...track,
              type: resolvedTargetTrackType,
              clips: [...track.clips, ...pastedClips].sort((left, right) => left.startTick - right.startTick),
            }
          : track,
      ),
    },
  };
}

function createPastedTimelineClips(clipboard: TimelineClipClipboard, tracks: Track[], targetStartTick: number): Clip[] {
  const usedClipIds = new Set(tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  const usedClipTakeIds = new Set(tracks.flatMap((track) => track.clips.flatMap(
    (clip) => clip.clipTakes?.map((take) => take.clipTakeId) ?? [],
  )));
  const createdAt = new Date().toISOString();

  return clipboard.clips.map((clip) => ({
    ...createCopiedTimelineClip(clip, usedClipIds, createdAt, usedClipTakeIds),
    startTick: targetStartTick + (clip.startTick - clipboard.startTick),
  }));
}

function getTimelinePasteTargetTrack(
  tracks: Track[],
  selection: SelectionState,
  targetTrackId?: string,
): Track | undefined {
  if (targetTrackId) {
    return tracks.find((track) => track.id === targetTrackId);
  }

  const selectedTrackIds = new Set(
    normalizeSelectionState(selection, tracks).items.filter((item) => item.type === 'track').map((item) => item.id),
  );
  const selectedTracks = getVisibleTracks(tracks).filter((track) => selectedTrackIds.has(track.id));

  return selectedTracks.length === 1 ? selectedTracks[0] : undefined;
}

function getTimelineClipboardEndTick(clipboard: TimelineClipClipboard, targetStartTick: number): number {
  return Math.max(
    ...clipboard.clips.map((clip) => targetStartTick + (clip.startTick - clipboard.startTick) + clip.lengthTicks),
  );
}

function doesTimelineClipboardOverlapTrack(
  clipboard: TimelineClipClipboard,
  targetTrack: Track,
  targetStartTick: number,
): boolean {
  return clipboard.clips.some((clip) => {
    const pastedStartTick = targetStartTick + (clip.startTick - clipboard.startTick);
    const pastedEndTick = pastedStartTick + clip.lengthTicks;

    return doesTickRangeOverlapTrack(pastedStartTick, pastedEndTick, targetTrack);
  });
}

function canPasteTimelineClipboardToTrack(clipboard: TimelineClipClipboard, targetTrack: Track): boolean {
  return targetTrack.type === 'blank' || targetTrack.type === clipboard.sourceTrackType;
}

function getEffectiveTimelineTrackType(track: Track, clips = track.clips): Track['type'] {
  if (track.type !== 'blank') {
    return track.type;
  }

  return clips[0] ? getTrackTypeForClipType(clips[0].type) : 'blank';
}

function getTrackTypeForClipType(clipType: ClipType): Track['type'] {
  if (clipType === 'midi-notes' || clipType === 'edited-midi') {
    return 'midi';
  }

  if (clipType === 'arrangement') {
    return 'arrangement';
  }

  if (clipType === 'master') {
    return 'master';
  }

  return 'audio';
}

function formatTrackTypeName(trackType: Track['type']): string {
  if (trackType === 'blank') {
    return 'NO TYPE';
  }

  return trackType.replace(/[_-]+/g, ' ').toUpperCase();
}

function getVisibleTracks(tracks: Track[]): Track[] {
  return resolveTrackGroupVisibleRows(tracks).rows.map((row) => row.track);
}

function getTimelineDeletionImpact(
  tracks: Track[],
  selection: SelectionState,
): TimelineTreeDeletionImpact {
  return resolveTimelineTreeDeletion(tracks, selection);
}

function formatTimelineDeletionTitle(
  deletionImpact: Extract<TimelineTreeDeletionImpact, { canDelete: true }>,
): string {
  const parts = [];

  if (deletionImpact.tracks.length > 0) {
    parts.push(`${deletionImpact.tracks.length} ${deletionImpact.tracks.length === 1 ? 'track' : 'tracks'}`);
  }

  if (deletionImpact.looseClips.length > 0) {
    parts.push(`${deletionImpact.looseClips.length} ${deletionImpact.looseClips.length === 1 ? 'clip' : 'clips'}`);
  }

  return `Delete selected ${parts.join(' and ')}`;
}

function formatTimelineDeletionDetails(
  deletionImpact: Extract<TimelineTreeDeletionImpact, { canDelete: true }>,
): string[] {
  return [
    `${deletionImpact.tracks.length} ${deletionImpact.tracks.length === 1 ? 'track' : 'tracks'} selected`,
    `${deletionImpact.removedClipCount} ${deletionImpact.removedClipCount === 1 ? 'clip' : 'clips'} will be removed`,
    ...deletionImpact.tracks.map((track) => `Track: ${track.name}`),
    ...deletionImpact.looseClips.map((clip) => `Clip: ${clip.name}`),
  ];
}

function formatTimelineDeletionBadge(
  deletionImpact: TimelineTreeDeletionImpact,
): string {
  const deleteTargets = [
    deletionImpact.trackIds.length > 0 ? formatCount(deletionImpact.trackIds.length, 'track') : '',
    deletionImpact.removedClipCount > 0 ? formatCount(deletionImpact.removedClipCount, 'clip') : '',
  ].filter(Boolean);

  return deleteTargets.length > 0 ? `Delete ${deleteTargets.join(' / ')}` : 'Delete none';
}

function formatAutoPatchTargetBadge(targets: SelectedClipInfo[]): string {
  if (targets.length === 0) {
    return 'Targets: none';
  }

  const visibleTargetNames = targets.slice(0, 3).map((target) => target.clip.name);
  const remainingCount = targets.length - visibleTargetNames.length;
  const suffix = remainingCount > 0 ? ` +${remainingCount} more` : '';

  return `Targets: ${visibleTargetNames.join(', ')}${suffix}`;
}

function getSelectedClipInfos(tracks: Track[], selectedClipIds: Set<string>): SelectedClipInfo[] {
  if (selectedClipIds.size === 0) {
    return [];
  }

  return tracks.flatMap((track) =>
    track.clips.filter((clip) => selectedClipIds.has(clip.id)).map((clip) => ({ clip, track })),
  );
}

function formatSelectedTrackHeading(tracks: Track[]): string {
  if (tracks.length === 1) {
    return tracks[0].name;
  }

  return `${formatCount(tracks.length, 'Track')} Selected`;
}

function formatTrackType(track: Track): string {
  if (track.type === 'blank') {
    return 'NO TYPE';
  }

  return track.group ? 'GROUP TRACK' : track.type.replace(/[_-]+/g, ' ').toUpperCase();
}

function createPatchTabHelpMessage(patchTab: PatchTab | undefined): string {
  if (!patchTab) {
    return defaultHeaderHelpMessage;
  }

  return `Selected PatchTab: ${patchTab.name} (${patchTab.inputType} -> ${patchTab.outputType})`;
}

function createRoutingHelpMessage(project: ProjectState, connectionId: string): string {
  const connection = project.connections.find((candidate) => candidate.id === connectionId);

  if (!connection) {
    return 'Selected Routing: choose a TabFlow wire.';
  }

  const patchTabMap = new Map(project.patchTabs.map((patchTab) => [patchTab.id, patchTab]));
  const sourcePatchTab = patchTabMap.get(connection.fromPatchTabId);
  const targetPatchTab = patchTabMap.get(connection.toPatchTabId);

  return `Selected Routing: ${sourcePatchTab?.name ?? 'Missing Source'} -> ${targetPatchTab?.name ?? 'Missing Target'}`;
}

function createClipHelpMessage(selectedClipInfo: SelectedClipInfo | undefined): string {
  if (!selectedClipInfo) {
    return 'Selected Clip';
  }

  const sourceIssue = getClipSourceFileIssue(selectedClipInfo.track, selectedClipInfo.clip);

  if (sourceIssue) {
    if (sourceIssue.status === 'unresolved') {
      return sourceIssue.restorationAuthority === 'project-root'
        ? `Selected Clip: ${selectedClipInfo.clip.name}. Generated source requires Project Root restoration: ${sourceIssue.fileName}.`
        : `Selected Clip: ${selectedClipInfo.clip.name}. Source needs relink: ${sourceIssue.fileName}. Relink it to use audio data in this session.`;
    }

    return `Selected Clip: ${selectedClipInfo.clip.name}. ${formatClipSourceFileStatus(sourceIssue.status)}: ${sourceIssue.fileName}.`;
  }

  return `Selected Clip: ${selectedClipInfo.clip.name} (${selectedClipInfo.clip.type})`;
}

function getActiveClipTakeLabel(clip: Clip): string {
  const activeClipTake = clip.clipTakes?.find(
    (clipTake) => clipTake.clipTakeId === clip.activeClipTakeId,
  );

  return activeClipTake?.label ?? 'MISSING';
}

function createTrackHelpMessage(track: Track | undefined): string {
  if (!track) {
    return 'Selected Track';
  }

  if (track.group) {
    return `Selected Group: ${track.name} (${formatCount(track.group.childTrackIds.length, 'direct child')})`;
  }

  return `Selected Track: ${track.name} (${formatCount(track.clips.length, 'clip')})`;
}

function createTransportHelpMessage(button: TransportButton): string {
  if (button === 'REC') {
    return 'Record microphone audio as a durable WAV Take in the selected Project Root.';
  }

  if (button === 'PLAY') {
    return 'Play the selected imported or relinked audio Clip from the Playhead, or restart it from the Clip start.';
  }

  if (button === 'STOP') {
    return 'Stop current audio playback or finalize and save the current recording.';
  }

  if (button === 'LOOP') {
    return 'Loop the selected imported or relinked audio Clip source range during playback.';
  }

  return 'Mark the current arrangement as ready for export workflow checks.';
}

function createTabFlowLineButtonHelpMessage(
  lineLabel: string,
  state: TabFlowConnectionState,
  isLineOn: boolean,
): string {
  const stateLabel = isLineOn ? 'ON' : 'OFF';
  const issueText =
    state === 'invalid' ? ' This line has an incompatible route and cannot run until routing is fixed.' : '';

  return `Turn TabFlow Line ${lineLabel} ${isLineOn ? 'OFF' : 'ON'}. It is currently ${stateLabel}.${issueText}`;
}

function createTabFlowLineSelectionHelpMessage(line: TabFlowLine, lineLabel: string): string {
  return `TabFlow Line ${lineLabel} selected for route editing. Use the line number button to turn its Flow Family ${
    line.enabled ? 'OFF' : 'ON'
  }.`;
}

function createTabFlowLineEnabledHelpMessage(line: TabFlowLine, lineLabel: string): string {
  return line.enabled
    ? `TabFlow Line ${lineLabel} Flow Family is ON. Auto Patch can use every lane in this family.`
    : `TabFlow Line ${lineLabel} Flow Family is OFF. Auto Patch will skip every lane in this family.`;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function shouldHandleTransportSpaceShortcut(target: EventTarget | null): boolean {
  if (hasBlockingGlobalShortcutLayer()) {
    return false;
  }

  if (!(target instanceof HTMLElement) || isEditableEventTarget(target)) {
    return !(target instanceof HTMLElement);
  }

  const interactiveTarget = target.closest('button, a[href], [role="button"], [role="slider"]');

  return !interactiveTarget || interactiveTarget.matches('.clip, .playhead-handle, .timeline-ruler');
}

function shouldHandleTimelineDeleteShortcut(target: EventTarget | null): boolean {
  return (
    !hasBlockingGlobalShortcutLayer() &&
    target instanceof HTMLElement &&
    !isEditableEventTarget(target) &&
    Boolean(target.closest('.timeline-panel'))
  );
}

function shouldHandleTimelineClearSelectionShortcut(target: EventTarget | null): boolean {
  return (
    !hasBlockingGlobalShortcutLayer() &&
    !document.querySelector('.clip.dragging, .clip-shell.trim-dragging, .playhead.dragging') &&
    target instanceof HTMLElement &&
    !isEditableEventTarget(target) &&
    Boolean(target.closest('.timeline-panel'))
  );
}

function hasBlockingGlobalShortcutLayer(): boolean {
  return Boolean(document.querySelector('[role="menu"], [role="alertdialog"]'));
}

function createSelectionFromItems(items: SelectionItem[]): SelectionState {
  const [anchorItem] = items;
  const lastSelectedItem = items[items.length - 1];

  return {
    items,
    anchorItem,
    lastSelectedItem,
  };
}

function getGroupPlaybackTrack(track: Track, tracks: Track[]): Track | undefined {
  if (!track.group) {
    return undefined;
  }

  const resolution = resolveGroupPlaybackTrack(track, tracks);

  return resolution.canResolve ? resolution.activeTrack : undefined;
}

function createGroupLaneSummary(track: Track, tracks: Track[]): string {
  if (!track.group) {
    return '';
  }

  const activeTrack = getGroupPlaybackTrack(track, tracks);
  const childCount = track.group.childTrackIds.length;
  const childLabel = childCount === 1 ? 'direct child' : 'direct children';

  return `${childCount} ${childLabel} / Playback leaf: ${activeTrack?.name ?? 'Unavailable'}`;
}

function normalizeTabFlowConnection(connection: TabFlowConnection, index: number): TabFlowConnection {
  return {
    ...connection,
    order: Number.isFinite(connection.order) ? connection.order : index,
    enabled: connection.enabled ?? true,
  };
}

function normalizeTabFlowLines(
  tabFlowLines: TabFlowLine[] | undefined,
  connections: TabFlowConnection[],
): TabFlowLine[] {
  return reconcileTabFlowLines(connections, tabFlowLines);
}

function normalizeTrackGroupData(group: Track['group']): Track['group'] {
  if (!group || !Array.isArray(group.childTrackIds) || typeof group.activePlaybackTrackId !== 'string') {
    return undefined;
  }

  return {
    childTrackIds: group.childTrackIds.filter((trackId) => typeof trackId === 'string'),
    collapsed: Boolean(group.collapsed),
    playbackMode: 'bottom_child',
    activePlaybackTrackId: group.activePlaybackTrackId,
  };
}

function normalizeSelectionState(selection: SelectionState | undefined, tracks: Track[]): SelectionState {
  const availableTrackIds = new Set(tracks.map((track) => track.id));
  const availableClipIds = new Set(tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  const items = Array.isArray(selection?.items)
    ? selection.items.filter((item) => isValidSelectionItem(item, availableTrackIds, availableClipIds))
    : [];
  const anchorItem = isValidSelectionItem(selection?.anchorItem, availableTrackIds, availableClipIds)
    ? { ...selection.anchorItem }
    : undefined;
  const lastSelectedItem = isValidSelectionItem(selection?.lastSelectedItem, availableTrackIds, availableClipIds)
    ? { ...selection.lastSelectedItem }
    : undefined;

  return {
    items: items.map((item) => ({ ...item })),
    anchorItem,
    lastSelectedItem,
  };
}

function createSingleSelection(item: SelectionItem): SelectionState {
  return {
    items: [item],
    anchorItem: item,
    lastSelectedItem: item,
  };
}

function filterSelectionByType(selection: SelectionState, type: SelectionItem['type']): SelectionState {
  const items = selection.items.filter((item) => item.type === type);
  const anchorItem = selection.anchorItem?.type === type ? selection.anchorItem : items[0];
  const lastSelectedItem =
    selection.lastSelectedItem?.type === type ? selection.lastSelectedItem : items[items.length - 1];

  return {
    items,
    anchorItem,
    lastSelectedItem,
  };
}

function toggleSelectionItem(selection: SelectionState, item: SelectionItem): SelectionState {
  const itemIndex = selection.items.findIndex((candidate) => areSelectionItemsEqual(candidate, item));

  if (itemIndex >= 0) {
    if (selection.items.length <= 1) {
      return createSingleSelection(item);
    }

    const items = selection.items.filter((_, index) => index !== itemIndex);
    const anchorItem = items.some((candidate) => areSelectionItemsEqual(candidate, selection.anchorItem))
      ? selection.anchorItem
      : items[0];

    return {
      items,
      anchorItem,
      lastSelectedItem: items[items.length - 1],
    };
  }

  return {
    items: [...selection.items, item],
    anchorItem: selection.anchorItem ?? item,
    lastSelectedItem: item,
  };
}

function createClipRangeSelection(selection: SelectionState, item: SelectionItem, tracks: Track[]): SelectionState {
  if (item.type !== 'clip' || selection.anchorItem?.type !== 'clip') {
    return createSingleSelection(item);
  }

  const anchorPosition = findClipPosition(tracks, selection.anchorItem.id);
  const targetPosition = findClipPosition(tracks, item.id);

  if (!anchorPosition || !targetPosition) {
    return createSingleSelection(item);
  }

  const firstTrackIndex = Math.min(anchorPosition.trackIndex, targetPosition.trackIndex);
  const lastTrackIndex = Math.max(anchorPosition.trackIndex, targetPosition.trackIndex);
  const firstTick = Math.min(getClipCenterTick(anchorPosition.clip), getClipCenterTick(targetPosition.clip));
  const lastTick = Math.max(getClipCenterTick(anchorPosition.clip), getClipCenterTick(targetPosition.clip));
  const items = tracks
    .slice(firstTrackIndex, lastTrackIndex + 1)
    .flatMap((track) =>
      track.clips
        .filter((clip) => isClipCenterInTickRange(clip, firstTick, lastTick))
        .map((clip): SelectionItem => ({ type: 'clip', id: clip.id })),
    );

  return {
    items: items.length > 0 ? items : [item],
    anchorItem: selection.anchorItem,
    lastSelectedItem: item,
  };
}

function createTrackRangeSelection(selection: SelectionState, item: SelectionItem, tracks: Track[]): SelectionState {
  if (item.type !== 'track' || selection.anchorItem?.type !== 'track') {
    return createSingleSelection(item);
  }

  const anchorTrackIndex = tracks.findIndex((track) => track.id === selection.anchorItem?.id);
  const targetTrackIndex = tracks.findIndex((track) => track.id === item.id);

  if (anchorTrackIndex < 0 || targetTrackIndex < 0) {
    return createSingleSelection(item);
  }

  const firstTrackIndex = Math.min(anchorTrackIndex, targetTrackIndex);
  const lastTrackIndex = Math.max(anchorTrackIndex, targetTrackIndex);
  const items = tracks
    .slice(firstTrackIndex, lastTrackIndex + 1)
    .map((track): SelectionItem => ({ type: 'track', id: track.id }));

  return {
    items,
    anchorItem: selection.anchorItem,
    lastSelectedItem: item,
  };
}

function getPreferredSelectedClipId(selection: SelectionState, preferredClipId: string, currentClipId: string): string {
  const clipItems = selection.items.filter((item) => item.type === 'clip');

  if (clipItems.some((item) => item.id === preferredClipId)) {
    return preferredClipId;
  }

  if (clipItems.some((item) => item.id === currentClipId)) {
    return currentClipId;
  }

  return clipItems[0]?.id ?? preferredClipId;
}

function areSelectionItemsEqual(left: SelectionItem | null | undefined, right: SelectionItem | null | undefined): boolean {
  return Boolean(left && right && left.type === right.type && left.id === right.id);
}

function findClipPosition(tracks: Track[], clipId: string): { clip: Clip; trackIndex: number } | undefined {
  for (const [trackIndex, track] of tracks.entries()) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);

    if (clip) {
      return { clip, trackIndex };
    }
  }

  return undefined;
}

function getClipCenterTick(clip: Clip): number {
  return clip.startTick + clip.lengthTicks / 2;
}

function isClipCenterInTickRange(clip: Clip, firstTick: number, lastTick: number): boolean {
  const centerTick = getClipCenterTick(clip);

  return centerTick >= firstTick && centerTick <= lastTick;
}

function normalizeTakes(takes: Take[] | undefined): Take[] {
  const normalizedTakes = Array.isArray(takes)
    ? takes.map((take) => ({
        ...take,
        executionMode: normalizeTakeExecutionMode(take.executionMode),
        sourceSelection: Array.isArray(take.sourceSelection)
          ? take.sourceSelection.filter((item): item is SelectionItem => isSelectionItem(item)).map((item) => ({ ...item }))
          : [],
        appliedTabFlowIds: Array.isArray(take.appliedTabFlowIds) ? [...take.appliedTabFlowIds] : [],
        appliedPatchIds: Array.isArray(take.appliedPatchIds) ? [...take.appliedPatchIds] : [],
        tabFlowSnapshots: Array.isArray(take.tabFlowSnapshots)
          ? take.tabFlowSnapshots.map((snapshot) => ({ ...snapshot }))
          : [],
        patchSnapshots: Array.isArray(take.patchSnapshots) ? take.patchSnapshots.map((snapshot) => ({ ...snapshot })) : [],
        routingSnapshots: Array.isArray(take.routingSnapshots)
          ? take.routingSnapshots.map((snapshot) => ({ ...snapshot }))
          : [],
        generatedClipIds: Array.isArray(take.generatedClipIds) ? [...take.generatedClipIds] : [],
        generatedTrackIds: Array.isArray(take.generatedTrackIds) ? [...take.generatedTrackIds] : [],
        logs: Array.isArray(take.logs) ? take.logs.map((log) => ({ ...log })) : [],
      }))
    : [];

  return limitTakeHistoryEntries(normalizedTakes);
}

function normalizeTakeExecutionMode(executionMode: unknown): Take['executionMode'] {
  if (executionMode === 'auto_take' || executionMode === 'auto_patch') {
    return 'auto_patch';
  }

  if (executionMode === 'single_take' || executionMode === 'manual_step' || executionMode === 'dry_run') {
    return executionMode;
  }

  return 'dry_run';
}

function isValidSelectionItem(
  item: unknown,
  availableTrackIds: Set<string>,
  availableClipIds: Set<string>,
): item is SelectionItem {
  if (!isSelectionItem(item)) {
    return false;
  }

  return item.type === 'track' ? availableTrackIds.has(item.id) : availableClipIds.has(item.id);
}

function isSelectionItem(item: unknown): item is SelectionItem {
  return (
    isRecord(item) &&
    typeof item.id === 'string' &&
    (item.type === 'clip' || item.type === 'track')
  );
}

function normalizeClipMetadata(
  clip: Clip,
  track: Track,
  projectBpm: number,
  options: ProjectNormalizeOptions = {},
): Clip {
  const clipRecord = clip as Clip & Record<string, unknown>;
  const {
    activeClipTakeId: _activeClipTakeId,
    clipTakes: _clipTakes,
    soundFont: _soundFont,
    startBeat: _legacyStartBeat,
    lengthBeats: _legacyLengthBeats,
    ...clipWithoutLegacyTimeline
  } = clipRecord;
  const sourceFile = normalizeClipSourceFile(clip.sourceFile, options);
  const audioTiming = normalizeClipAudioTimingMetadata(clipRecord, sourceFile);
  const clipTakeState = normalizeClipTakeState(
    clipRecord.clipTakes,
    clipRecord.activeClipTakeId,
  );
  const lengthTicks = audioTiming
    ? secondsToTimelineTicks(getAudioClipSourceDurationSeconds(audioTiming), projectBpm)
    : Math.max(1, normalizeTickValue(clipRecord.lengthTicks, clipRecord.lengthBeats, TICKS_PER_BEAT));
  const type = clip.type ?? inferClipType(track);

  return {
    ...clipWithoutLegacyTimeline,
    color: getClipTypeColor(type),
    startTick: normalizeTickValue(clipRecord.startTick, clipRecord.startBeat, 0),
    lengthTicks,
    type,
    generatedBy: clip.generatedBy ?? inferClipGenerator(track),
    sourceFile,
    audioTiming,
    ...clipTakeState,
    exportManifest: normalizeExportManifest(clip.exportManifest),
    appliedTabFlows: normalizeClipTabFlowApplications(clip.appliedTabFlows),
    soundFont: normalizeSoundFontAssignment(clipRecord.soundFont),
    createdAt: clip.createdAt ?? '2026-06-24T00:00:00.000Z',
    version: clip.version ?? 1,
  };
}

function cloneSoundFontAssignment(
  assignment: SoundFontAssignment | undefined,
): SoundFontAssignment | undefined {
  return assignment
    ? {
        ...assignment,
        resource: { ...assignment.resource },
      }
    : undefined;
}

function createBuiltInDefaultSoundFontAssignment(
  catalogState: PianoRollSoundFontCatalogState,
): SoundFontAssignment | undefined {
  if (catalogState.status !== 'READY') {
    return undefined;
  }

  const resource = catalogState.catalog.resources.find(
    (candidate) =>
      candidate.library === 'builtin' &&
      candidate.relativePath === HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH,
  );

  return resource
    ? createProjectSoundFontAssignment(
        {
          format: resource.format,
          library: resource.library,
          relativePath: resource.relativePath,
          resourceId: resource.resourceId,
        },
        { bank: 0, program: 0 },
      )
    : undefined;
}

function normalizeClipSourceFile(sourceFile: Clip['sourceFile'], options: ProjectNormalizeOptions = {}): Clip['sourceFile'] {
  if (!sourceFile || !isRecord(sourceFile)) {
    return undefined;
  }

  const path = typeof sourceFile.path === 'string' ? sourceFile.path.trim() : '';
  const lastKnownPath = typeof sourceFile.lastKnownPath === 'string' ? sourceFile.lastKnownPath.trim() : '';
  const relativePath = typeof sourceFile.relativePath === 'string' ? sourceFile.relativePath.trim() : '';
  const sourceId = typeof sourceFile.sourceId === 'string' ? sourceFile.sourceId.trim() : '';
  const name =
    typeof sourceFile.name === 'string'
      ? sourceFile.name.trim()
      : getFileNameFromPath(relativePath || path || lastKnownPath);

  if (!name && !relativePath && !path && !lastKnownPath) {
    return undefined;
  }

  return {
    name: name || 'Unknown Source',
    status:
      options.sourceFileLoadMode === 'json-reload'
        ? normalizeReloadedClipSourceFileStatus(sourceFile.status)
        : normalizeClipSourceFileStatus(sourceFile.status),
    ...(path ? { path } : {}),
    ...(lastKnownPath ? { lastKnownPath } : {}),
    ...(relativePath ? { relativePath } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(typeof sourceFile.checkedAt === 'string' ? { checkedAt: sourceFile.checkedAt } : {}),
    ...(typeof sourceFile.mimeType === 'string' && sourceFile.mimeType.trim()
      ? { mimeType: sourceFile.mimeType.trim() }
      : {}),
    ...(isFiniteNonNegativeNumber(sourceFile.sizeBytes) ? { sizeBytes: sourceFile.sizeBytes } : {}),
    ...(isFiniteNonNegativeNumber(sourceFile.lastModified) ? { lastModified: sourceFile.lastModified } : {}),
    ...(isFinitePositiveNumber(sourceFile.durationSeconds) ? { durationSeconds: sourceFile.durationSeconds } : {}),
  };
}

function normalizeClipSourceFileStatus(status: unknown): ClipSourceFileStatus {
  return status === 'available' || status === 'missing' || status === 'moved' || status === 'unresolved'
    ? status
    : 'unresolved';
}

function normalizeReloadedClipSourceFileStatus(status: unknown): ClipSourceFileStatus {
  return status === 'available' ? 'unresolved' : normalizeClipSourceFileStatus(status);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeExportManifest(exportManifest: Clip['exportManifest']): Clip['exportManifest'] {
  if (!exportManifest || !isRecord(exportManifest)) {
    return undefined;
  }

  const manifestRecord = exportManifest as ExportManifest & Record<string, unknown>;
  const {
    durationBeats: _legacyDurationBeats,
    ...manifestWithoutLegacyTimeline
  } = manifestRecord;

  return {
    ...manifestWithoutLegacyTimeline,
    durationTicks: normalizeTickValue(manifestRecord.durationTicks, manifestRecord.durationBeats, TICKS_PER_BEAT),
  };
}

function normalizeTickValue(tickValue: unknown, legacyBeatValue: unknown, fallbackTickValue: number): number {
  if (typeof tickValue === 'number' && Number.isFinite(tickValue)) {
    return Math.max(0, Math.round(tickValue));
  }

  if (typeof legacyBeatValue === 'number' && Number.isFinite(legacyBeatValue)) {
    return Math.max(0, beatsToTicks(legacyBeatValue));
  }

  return fallbackTickValue;
}

function normalizeTimelineGridResolution(value: unknown): TimelineGridResolution {
  return isTimelineGridResolution(value) ? value : DEFAULT_TIMELINE_GRID_RESOLUTION;
}

function normalizeClipTabFlowApplications(clipApplications: Clip['appliedTabFlows']): Clip['appliedTabFlows'] {
  if (!Array.isArray(clipApplications)) {
    return [];
  }

  return clipApplications.flatMap((application) => {
    if (!isRecord(application)) {
      return [];
    }

    const tabFlowLineId = typeof application.tabFlowLineId === 'string' ? application.tabFlowLineId : '';
    const tabFlowLineRevision =
      typeof application.tabFlowLineRevision === 'number' && Number.isFinite(application.tabFlowLineRevision)
        ? application.tabFlowLineRevision
        : 1;

    if (!tabFlowLineId) {
      return [];
    }

    return [
      {
        runId: typeof application.runId === 'string' ? application.runId : createAutoPatchRunId('clip', tabFlowLineId, tabFlowLineRevision),
        tabFlowLineId,
        tabFlowLineName: typeof application.tabFlowLineName === 'string' ? application.tabFlowLineName : tabFlowLineId,
        tabFlowLineRevision,
        sourceConnectionIds: Array.isArray(application.sourceConnectionIds)
          ? application.sourceConnectionIds.filter((connectionId): connectionId is string => typeof connectionId === 'string')
          : [],
        appliedAt: typeof application.appliedAt === 'string' ? application.appliedAt : '2026-06-24T00:00:00.000Z',
      },
    ];
  });
}

function getClipAutoPatchEligibilities(project: ProjectState, clip: Clip): AutoPatchEligibility[] {
  const patchTabMap = new Map(project.patchTabs.map((patchTab) => [patchTab.id, patchTab]));
  const appliedKeySet = new Set(
    (clip.appliedTabFlows ?? []).map((application) =>
      createAutoPatchApplicationKey(application.tabFlowLineId, application.tabFlowLineRevision),
    ),
  );

  return getRoutingFlowRows(project.connections, project.tabFlowLines, project.patchTabs).map((row) => {
    const rowState = getTabFlowRowState(row, patchTabMap);
    const applicationKey = createAutoPatchApplicationKey(row.line.id, row.line.revision);

    if (row.line.enabled && row.connections.length === 0) {
      return { line: row.line, status: 'invalid', reason: 'empty ON line' };
    }

    if (rowState === 'invalid') {
      return { line: row.line, status: 'invalid', reason: 'type mismatch' };
    }

    if (rowState === 'disabled') {
      return { line: row.line, status: 'disabled', reason: 'line off' };
    }

    if (appliedKeySet.has(applicationKey)) {
      return { line: row.line, status: 'applied', reason: 'already marked' };
    }

    return { line: row.line, status: 'ready', reason: 'will mark' };
  });
}

function getAutoPatchPreflightBlockReason(
  project: ProjectState,
  targetClipInfos: SelectedClipInfo[],
): string | undefined {
  if (targetClipInfos.length === 0) {
    return 'select at least one clip or track';
  }

  const blockedFamily = getTabFlowFamilyPreflight(
    getProjectTabFlowLines(project),
    project.connections,
    project.patchTabs,
  ).find((preflight) => preflight.status === 'blocked');

  if (blockedFamily) {
    return `Line ${blockedFamily.rootLine.order + 1}: ${blockedFamily.reason}`;
  }

  return undefined;
}

function getAutoPatchTargetClipInfos(
  tracks: Track[],
  selection: SelectionState,
  fallbackSelectedClipInfo: SelectedClipInfo | undefined,
): SelectedClipInfo[] {
  const resolution = resolveAutoPatchTargetClipIds(
    { tracks, selection },
    fallbackSelectedClipInfo?.clip.id,
  );

  if (!resolution.canResolve) {
    return [];
  }

  const clipInfoById = new Map(
    tracks.flatMap((track) =>
      track.clips.map((clip) => [clip.id, { clip, track }] as const),
    ),
  );

  return resolution.targetClipIds
    .map((clipId) => clipInfoById.get(clipId))
    .filter((target): target is SelectedClipInfo => target !== undefined);
}

function applyAutoPatchGuardToClip(project: ProjectState, clipId: string): ProjectState {
  const selectedClipInfo = findSelectedClip(project.tracks, clipId);

  if (!selectedClipInfo) {
    return project;
  }

  const readyEligibilities = getClipAutoPatchEligibilities(project, selectedClipInfo.clip).filter(
    (eligibility) => eligibility.status === 'ready',
  );

  if (readyEligibilities.length === 0) {
    return project;
  }

  const appliedAt = new Date().toISOString();
  const nextApplications = [
    ...(selectedClipInfo.clip.appliedTabFlows ?? []),
    ...readyEligibilities.map((eligibility) => ({
      runId: createAutoPatchRunId(selectedClipInfo.clip.id, eligibility.line.id, eligibility.line.revision, appliedAt),
      tabFlowLineId: eligibility.line.id,
      tabFlowLineName: eligibility.line.name,
      tabFlowLineRevision: eligibility.line.revision,
      sourceConnectionIds: [...eligibility.line.connectionIds],
      appliedAt,
    })),
  ];

  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.id === selectedClipInfo.track.id
        ? {
            ...track,
            clips: track.clips.map((clip) =>
              clip.id === selectedClipInfo.clip.id ? { ...clip, appliedTabFlows: nextApplications } : clip,
            ),
          }
        : track,
    ),
  };
}

function applyAutoPatchGuardToClips(project: ProjectState, clipIds: string[]): ProjectState {
  return clipIds.reduce((nextProject, clipId) => applyAutoPatchGuardToClip(nextProject, clipId), project);
}

function createAutoPatchDryRunTake(project: ProjectState, targetClipInfos: SelectedClipInfo[]): Take | undefined {
  const readyEligibilities = targetClipInfos.flatMap((target) =>
    getClipAutoPatchEligibilities(project, target.clip)
      .filter((eligibility) => eligibility.status === 'ready')
      .map((eligibility) => ({
        ...eligibility,
        clip: target.clip,
        track: target.track,
      })),
  );

  if (readyEligibilities.length === 0) {
    return undefined;
  }

  const createdAt = new Date().toISOString();
  const readyClipIds = new Set(readyEligibilities.map((eligibility) => eligibility.clip.id));
  const tabFlowLineMap = new Map<string, TabFlowLine>();
  readyEligibilities.forEach((eligibility) => {
    tabFlowLineMap.set(eligibility.line.id, eligibility.line);
  });

  const tabFlowSnapshots = getTabFlowLaneViews(
    getProjectTabFlowLines(project),
    project.connections,
    project.patchTabs,
  )
    .filter((view) => tabFlowLineMap.has(view.line.id))
    .map((view) => ({
      line: view.line,
      view,
    }))
    .map(({ line, view }) => ({
      id: line.id,
      name: line.name,
      enabled: line.enabled,
      order: line.order,
      revision: line.revision,
      connectionIds: [...line.connectionIds],
      familyId: view.familyId,
      parentLineId: line.attachment?.parentLineId,
      displayLabel: view.displayLabel,
    }));
  const appliedTabFlowIds = tabFlowSnapshots.map((snapshot) => snapshot.id);
  const appliedConnectionIds = new Set(tabFlowSnapshots.flatMap((snapshot) => snapshot.connectionIds));
  const routingSnapshots = sortTabFlowConnections(
    project.connections.filter((connection) => appliedConnectionIds.has(connection.id)),
  ).map((connection) => ({
    connectionId: connection.id,
    fromPatchTabId: connection.fromPatchTabId,
    toPatchTabId: connection.toPatchTabId,
    fromPortId: connection.fromPortId,
    toPortId: connection.toPortId,
    activation: connection.activation,
    enabled: connection.enabled,
    order: connection.order,
  }));
  const appliedPatchIds = new Set(
    routingSnapshots.flatMap((snapshot) => [snapshot.fromPatchTabId, snapshot.toPatchTabId]),
  );
  const patchSnapshots = project.patchTabs
    .filter((patchTab) => appliedPatchIds.has(patchTab.id))
    .map((patchTab) => ({
      id: patchTab.id,
      name: patchTab.name,
      inputType: patchTab.inputType,
      outputType: patchTab.outputType,
    }));
  const sourceSelection = getAutoPatchTakeSourceSelection(project, targetClipInfos);
  const takeNumber = getNextTakeNumber(project.takes, 'auto_patch');

  return {
    id: createAutoPatchTakeId(project.takes, takeNumber, createdAt),
    name: `Auto Patch Take ${String(takeNumber).padStart(2, '0')}`,
    executionMode: 'auto_patch',
    sourceSelection,
    appliedTabFlowIds,
    appliedPatchIds: [...appliedPatchIds],
    tabFlowSnapshots,
    patchSnapshots,
    routingSnapshots,
    generatedClipIds: [],
    generatedTrackIds: [],
    logs: [
      {
        level: 'info',
        message: 'Dry Run Auto Patch completed.',
        createdAt,
      },
      {
        level: 'info',
        message: `Marked ${formatCount(readyClipIds.size, 'clip')} with ${formatCount(
          appliedTabFlowIds.length,
          'TabFlow line',
        )}.`,
        createdAt,
      },
    ],
    createdAt,
  };
}

function getAutoPatchTakeSourceSelection(project: ProjectState, targetClipInfos: SelectedClipInfo[]): SelectionItem[] {
  const normalizedSelection = normalizeSelectionState(project.selection, project.tracks);

  if (normalizedSelection.items.length > 0) {
    return normalizedSelection.items.map((item) => ({ ...item }));
  }

  const clipIds = new Set<string>();

  return targetClipInfos.flatMap((target): SelectionItem[] => {
    if (clipIds.has(target.clip.id)) {
      return [];
    }

    clipIds.add(target.clip.id);
    return [{ type: 'clip', id: target.clip.id }];
  });
}

function appendManualStepTake(
  previousProject: ProjectState,
  nextProject: ProjectState,
  patchTab: PatchTab,
  sourceClip: Clip,
  generatedClip: Clip,
): ProjectState {
  const take = createManualStepTake(
    previousProject,
    patchTab,
    sourceClip,
    generatedClip,
    getGeneratedTrackIds(previousProject.tracks, nextProject.tracks),
  );

  return {
    ...nextProject,
    takes: appendTakeHistoryEntry(nextProject.takes, take),
  };
}

function createManualStepTake(
  project: ProjectState,
  patchTab: PatchTab,
  sourceClip: Clip,
  generatedClip: Clip,
  generatedTrackIds: string[],
): Take {
  const createdAt = generatedClip.createdAt;
  const takeNumber = getNextTakeNumber(project.takes, 'manual_step');

  return {
    id: createManualStepTakeId(project.takes, takeNumber, createdAt),
    name: `Manual Step ${String(takeNumber).padStart(2, '0')}`,
    executionMode: 'manual_step',
    sourceSelection: [{ type: 'clip', id: sourceClip.id }],
    appliedTabFlowIds: [],
    appliedPatchIds: [patchTab.id],
    tabFlowSnapshots: [],
    patchSnapshots: [
      {
        id: patchTab.id,
        name: patchTab.name,
        inputType: patchTab.inputType,
        outputType: patchTab.outputType,
      },
    ],
    routingSnapshots: [],
    generatedClipIds: [generatedClip.id],
    generatedTrackIds,
    logs: [
      {
        level: 'info',
        message: `Applied ${patchTab.name} to ${sourceClip.name}.`,
        createdAt,
      },
      {
        level: 'info',
        message: `Created ${generatedClip.name}.`,
        createdAt,
      },
    ],
    createdAt,
  };
}

function getGeneratedTrackIds(previousTracks: Track[], nextTracks: Track[]): string[] {
  const previousTrackIds = new Set(previousTracks.map((track) => track.id));

  return nextTracks.filter((track) => !previousTrackIds.has(track.id)).map((track) => track.id);
}

function appendTakeHistoryEntry(takes: Take[], take: Take): Take[] {
  return limitTakeHistoryEntries([...takes, take]);
}

function limitTakeHistoryEntries(takes: Take[]): Take[] {
  return takes.slice(-MAX_TAKE_HISTORY_ENTRIES);
}

function getNextTakeNumber(takes: Take[], executionMode: Take['executionMode']): number {
  return takes.filter((take) => take.executionMode === executionMode).length + 1;
}

function createAutoPatchTakeId(takes: Take[], takeNumber: number, createdAt: string): string {
  const usedTakeIds = new Set(takes.map((take) => take.id));
  const timestamp = createdAt.replace(/\D/g, '');
  const baseId = `take-auto-patch-${String(takeNumber).padStart(2, '0')}-${timestamp}`;
  let id = baseId;
  let suffix = 2;

  while (usedTakeIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return id;
}

function createManualStepTakeId(takes: Take[], takeNumber: number, createdAt: string): string {
  const usedTakeIds = new Set(takes.map((take) => take.id));
  const timestamp = createdAt.replace(/\D/g, '');
  const baseId = `take-manual-step-${String(takeNumber).padStart(2, '0')}-${timestamp}`;
  let id = baseId;
  let suffix = 2;

  while (usedTakeIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return id;
}

function getAutoPatchHistoryEntries(project: ProjectState): AutoPatchHistoryEntry[] {
  const tabFlowLineMap = new Map((project.tabFlowLines ?? []).map((line) => [line.id, line]));

  return project.tracks
    .flatMap((track) =>
      track.clips.flatMap((clip) =>
        (clip.appliedTabFlows ?? []).map((application) => {
          const line = tabFlowLineMap.get(application.tabFlowLineId);

          return {
            clipId: clip.id,
            clipName: clip.name,
            trackId: track.id,
            trackName: track.name,
            lineOrder: line?.order,
            lineEnabled: line?.enabled,
            application,
          };
        }),
      ),
    )
    .sort(compareAutoPatchHistoryEntries);
}

function compareAutoPatchHistoryEntries(firstEntry: AutoPatchHistoryEntry, secondEntry: AutoPatchHistoryEntry): number {
  const firstTime = Date.parse(firstEntry.application.appliedAt);
  const secondTime = Date.parse(secondEntry.application.appliedAt);

  if (Number.isFinite(firstTime) && Number.isFinite(secondTime) && firstTime !== secondTime) {
    return secondTime - firstTime;
  }

  return secondEntry.application.runId.localeCompare(firstEntry.application.runId);
}

function formatAutoPatchHistoryLine(entry: AutoPatchHistoryEntry): string {
  const lineLabel = typeof entry.lineOrder === 'number' ? `Line ${entry.lineOrder + 1}` : entry.application.tabFlowLineName;
  const enabledLabel = entry.lineEnabled === false ? ' OFF' : '';

  return `${lineLabel} R${entry.application.tabFlowLineRevision}${enabledLabel}`;
}

function formatAutoPatchHistoryTime(appliedAt: string): string {
  const time = Date.parse(appliedAt);

  if (!Number.isFinite(time)) {
    return appliedAt;
  }

  const date = new Date(time);

  return `${date.getFullYear()}-${formatTwoDigit(date.getMonth() + 1)}-${formatTwoDigit(date.getDate())} ${formatTwoDigit(
    date.getHours(),
  )}:${formatTwoDigit(date.getMinutes())}`;
}

function formatTakeHistorySummary(take: Take): string {
  if (isAutoPatchProductionRunHistoryEntry(take)) {
    return `${formatCount(take.sourceSelection.length, 'target')} / ${formatCount(
      take.autoPatchProduction.stages.length,
      'Stage',
    )} / production ${take.autoPatchProduction.resultStatus.toLowerCase()}`;
  }

  if (take.executionMode === 'auto_patch') {
    return `${formatCount(take.sourceSelection.length, 'target')} / ${formatCount(
      take.appliedTabFlowIds.length,
      'TabFlow line',
    )} / patch check`;
  }

  if (take.executionMode === 'single_take') {
    return `${formatCount(take.sourceSelection.length, 'target')} / ${formatCount(take.appliedPatchIds.length, 'Patch')} / dry run`;
  }

  if (take.executionMode === 'manual_step') {
    return `${formatCount(take.sourceSelection.length, 'target')} / ${formatCount(
      take.appliedPatchIds.length,
      'Patch',
    )} / generated ${formatTakeGeneratedSummary(take)}`;
  }

  return `${formatCount(take.sourceSelection.length, 'target')} / dry run`;
}

function formatTakeExecutionMode(executionMode: Take['executionMode']): string {
  if (executionMode === 'auto_patch') {
    return 'AUTO PATCH';
  }

  if (executionMode === 'single_take') {
    return 'SINGLE TAKE';
  }

  if (executionMode === 'manual_step') {
    return 'MANUAL STEP';
  }

  return 'DRY RUN';
}

function formatSelectionItemsForTake(items: SelectionItem[]): string {
  if (items.length === 0) {
    return 'NONE';
  }

  const visibleItems = items.slice(0, 4).map((item) => `${item.type.toUpperCase()} ${item.id}`);
  const remainingCount = items.length - visibleItems.length;

  return `${visibleItems.join(', ')}${remainingCount > 0 ? ` +${remainingCount} more` : ''}`;
}

function getSelectionClipIds(items: SelectionItem[]): string[] {
  return items.filter((item) => item.type === 'clip').map((item) => item.id);
}

function createClipInfoMap(tracks: Track[]): Map<string, SelectedClipInfo> {
  const clipInfoMap = new Map<string, SelectedClipInfo>();

  tracks.forEach((track) => {
    track.clips.forEach((clip) => {
      clipInfoMap.set(clip.id, { clip, track });
    });
  });

  return clipInfoMap;
}

function formatTakeIdList(ids: string[]): string {
  if (ids.length === 0) {
    return 'NONE';
  }

  const visibleIds = ids.slice(0, 4);
  const remainingCount = ids.length - visibleIds.length;

  return `${visibleIds.join(', ')}${remainingCount > 0 ? ` +${remainingCount} more` : ''}`;
}

function formatPatchSnapshotsForTake(take: Take): string {
  if (take.patchSnapshots.length === 0) {
    return formatTakeIdList(take.appliedPatchIds);
  }

  const visiblePatchNames = take.patchSnapshots.slice(0, 4).map((patch) => patch.name);
  const remainingCount = take.patchSnapshots.length - visiblePatchNames.length;

  return `${visiblePatchNames.join(', ')}${remainingCount > 0 ? ` +${remainingCount} more` : ''}`;
}

function formatTakeGeneratedSummary(take: Take): string {
  const generatedCounts = [
    take.generatedClipIds.length > 0 ? formatCount(take.generatedClipIds.length, 'clip') : '',
    take.generatedTrackIds.length > 0 ? formatCount(take.generatedTrackIds.length, 'track') : '',
  ].filter(Boolean);

  return generatedCounts.length > 0 ? generatedCounts.join(' / ') : 'NONE';
}

function formatTwoDigit(value: number): string {
  return String(value).padStart(2, '0');
}

function formatAutoPatchButtonTooltip(eligibilities: AutoPatchEligibility[]): string {
  if (eligibilities.length === 0) {
    return 'No Auto Patch target. Select clips or tracks to inspect Auto Patch lines.';
  }

  const readyLines = formatAutoPatchTooltipGroup(eligibilities, 'ready');
  const appliedLines = formatAutoPatchTooltipGroup(eligibilities, 'applied');
  const disabledLines = formatAutoPatchTooltipGroup(eligibilities, 'disabled');
  const invalidLines = formatAutoPatchTooltipGroup(eligibilities, 'invalid');
  const tooltipLines = [
    readyLines ? `Ready: ${readyLines}` : 'Ready: none',
    appliedLines ? `Applied: ${appliedLines}` : 'Applied: none',
    disabledLines ? `Disabled: ${disabledLines}` : 'Disabled: none',
    invalidLines ? `Invalid: ${invalidLines}` : 'Invalid: none',
  ];

  return tooltipLines.join('\n');
}

function formatAutoPatchConfirmDetails(eligibilities: AutoPatchEligibility[]): string[] {
  if (eligibilities.length === 0) {
    return ['No Auto Patch lines available.'];
  }

  return eligibilities.map((eligibility) => {
    const targetLabel = isAutoPatchTargetEligibility(eligibility) ? `${eligibility.clip.name}: ` : '';
    const lineLabel = `${targetLabel}Line ${eligibility.line.order + 1} R${eligibility.line.revision}`;

    return `${lineLabel}: ${eligibility.status.toUpperCase()} - ${eligibility.reason}`;
  });
}

function formatAutoPatchConfirmMessage(targets: SelectedClipInfo[]): string {
  if (targets.length === 0) {
    return 'Select clips or tracks before running Auto Patch.';
  }

  if (targets.length === 1) {
    return `Mark ready TabFlow lines for ${targets[0].clip.name}.`;
  }

  return `Mark ready TabFlow lines for ${targets.length} selected clips.`;
}

function formatAutoPatchTooltipGroup(
  eligibilities: AutoPatchEligibility[],
  status: AutoPatchEligibilityStatus,
): string {
  return eligibilities
    .filter((eligibility) => eligibility.status === status)
    .map((eligibility) => {
      const targetLabel = isAutoPatchTargetEligibility(eligibility) ? `${eligibility.clip.name} ` : '';
      const lineLabel = `${targetLabel}Line ${eligibility.line.order + 1} R${eligibility.line.revision}`;

      return status === 'invalid' ? `${lineLabel} (${eligibility.reason})` : lineLabel;
    })
    .join(', ');
}

function isAutoPatchTargetEligibility(eligibility: AutoPatchEligibility): eligibility is AutoPatchTargetEligibility {
  return 'clip' in eligibility && 'track' in eligibility;
}

function createAutoPatchApplicationKey(tabFlowLineId: string, tabFlowLineRevision: number): string {
  return `${tabFlowLineId}@${tabFlowLineRevision}`;
}

function createAutoPatchRunId(
  clipId: string,
  tabFlowLineId: string,
  tabFlowLineRevision: number,
  appliedAt = new Date().toISOString(),
): string {
  return `auto-patch-${sanitizeIdPart(clipId)}-${sanitizeIdPart(tabFlowLineId)}-r${tabFlowLineRevision}-${appliedAt.replace(
    /\D/g,
    '',
  )}`;
}

function sanitizeIdPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function inferClipType(track: Track): ClipType {
  if (track.id === 'hum-audio') return 'hum-audio';
  if (track.id === 'midi-notes') return 'midi-notes';
  if (track.id === 'edited-midi') return 'edited-midi';
  if (track.id === 'instrument-audio') return 'instrument-audio';
  if (track.id === 'arrangement') return 'arrangement';
  if (track.id === 'vocal-audio') return 'vocal-audio';
  if (track.id === 'ai-fill-audio') return 'ai-fill-audio';

  return 'master';
}

function inferClipGenerator(track: Track): string {
  if (track.id === 'hum-audio') return 'Microphone Recording';
  if (track.id === 'midi-notes') return 'Hum to MIDI';
  if (track.id === 'edited-midi') return 'MIDI Edit';
  if (track.id === 'instrument-audio') return 'Instrument';
  if (track.id === 'arrangement') return 'Timeline';
  if (track.id === 'vocal-audio') return 'Vocal Record';
  if (track.id === 'ai-fill-audio') return 'AI Fill';

  return 'Timeline';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isProjectStateLike(value: unknown): value is ProjectState {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.bpm === 'number' &&
    typeof value.key === 'string' &&
    typeof value.status === 'string' &&
    Array.isArray(value.patchTabs) &&
    Array.isArray(value.connections) &&
    Array.isArray(value.tracks)
  );
}

function isTransportButton(value: unknown): value is TransportButton {
  return transportButtons.includes(value as TransportButton);
}

function isPatchPortSelection(value: unknown): value is PatchPortSelection {
  return (
    isRecord(value) &&
    typeof value.patchTabId === 'string' &&
    (value.direction === 'input' || value.direction === 'output') &&
    (value.portId === undefined || typeof value.portId === 'string')
  );
}

function normalizeRecordingSession(value: unknown): RecordingSession | undefined {
  if (
    !isRecord(value) ||
    typeof value.trackId !== 'string' ||
    typeof value.startedAt !== 'string'
  ) {
    return undefined;
  }

  return {
    trackId: value.trackId,
    startTick: normalizeTickValue(value.startTick, value.startBeat, 0),
    startedAt: value.startedAt,
  };
}

function findSelectedClip(tracks: Track[], clipId: string): SelectedClipInfo | undefined {
  for (const track of tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);

    if (clip) {
      return { clip, track };
    }
  }

  return undefined;
}

function findSingleSelectedMidiClipInfo(
  project: ProjectState,
): SelectedClipInfo | undefined {
  if (
    project.selection.items.length !== 1 ||
    project.selection.items[0].type !== 'track'
  ) {
    return undefined;
  }

  const track = project.tracks.find(
    (candidate) => candidate.id === project.selection.items[0].id,
  );
  const midiClips = track?.clips.filter(
    (clip) => clip.type === 'midi-notes' || clip.type === 'edited-midi',
  );

  return track && midiClips?.length === 1
    ? { clip: midiClips[0], track }
    : undefined;
}

function buildClipLineage(tracks: Track[], clip: Clip): ClipLineageEntry[] {
  const clipMap = new Map<string, SelectedClipInfo>();

  tracks.forEach((track) => {
    track.clips.forEach((trackClip) => {
      clipMap.set(trackClip.id, { clip: trackClip, track });
    });
  });

  const lineage: ClipLineageEntry[] = [];
  const seenClipIds = new Set<string>();
  let currentClip: Clip | undefined = clip;

  while (currentClip && !seenClipIds.has(currentClip.id)) {
    seenClipIds.add(currentClip.id);
    const currentInfo = clipMap.get(currentClip.id);

    lineage.push({
      clipId: currentClip.id,
      name: currentClip.name,
      type: currentClip.type,
      trackName: currentInfo?.track.name ?? 'Unknown Track',
      details: createClipLineageDetails(currentClip),
      isCurrent: currentClip.id === clip.id,
      isMissing: false,
    });

    if (!currentClip.sourceClipId) {
      break;
    }

    const sourceInfo = clipMap.get(currentClip.sourceClipId);

    if (!sourceInfo) {
      lineage.push({
        clipId: currentClip.sourceClipId,
        name: currentClip.sourceClipId,
        type: 'missing',
        trackName: 'Missing Source',
        details: [],
        isCurrent: false,
        isMissing: true,
      });
      break;
    }

    currentClip = sourceInfo.clip;
  }

  return lineage.reverse();
}

function createClipLineageDetails(clip: Clip): string[] {
  const details: string[] = [];

  if (clip.generatedBy) {
    details.push(`Generated by: ${clip.generatedBy}`);
  }

  if (clip.parameterSnapshot) {
    Object.entries(clip.parameterSnapshot).forEach(([label, value]) => {
      details.push(formatParameterSnapshotBadge(label, value));
    });
  }

  if (clip.exportManifest) {
    details.push(`File: ${clip.exportManifest.estimatedFileName}`);
    details.push(`Format: ${clip.exportManifest.format}`);
    details.push(`Normalize: ${clip.exportManifest.normalize}`);
    details.push(`Status: ${clip.exportManifest.status}`);
  }

  return details;
}

function updatePatchTabParameter(
  patchTab: PatchTab,
  parameterId: string,
  value: PatchTabParameterValue,
): PatchTab {
  let didChange = false;
  const parameters = patchTab.parameters.map((parameter) => {
    if (parameter.id !== parameterId) {
      return parameter;
    }

    if (
      (parameter.kind === 'slider' || parameter.kind === 'number') &&
      typeof value === 'number'
    ) {
      if (parameter.value === value) {
        return parameter;
      }

      didChange = true;
      return { ...parameter, value };
    }

    if (
      (parameter.kind === 'select' || parameter.kind === 'text') &&
      typeof value === 'string'
    ) {
      if (parameter.value === value) {
        return parameter;
      }

      didChange = true;
      return { ...parameter, value };
    }

    return parameter;
  });

  return didChange ? { ...patchTab, parameters } : patchTab;
}

function createPatchTabFromTemplate(template: PatchTab, patchTabs: PatchTab[]): PatchTab {
  const contractedTemplate = migratePatchTabContract(template);
  const identity = resolvePatchTabTemplateInstanceIdentity(
    template,
    patchTabs,
  );

  return {
    ...contractedTemplate,
    ...identity,
    colorIndex: getNextPatchTabColorIndex(patchTabs),
    inputBindings: contractedTemplate.inputBindings?.map((binding) =>
      binding.kind === 'connection'
        ? { ...binding, connectionIds: [...binding.connectionIds] }
        : { ...binding },
    ),
    parameters: template.parameters.map((parameter) =>
      parameter.kind === 'select'
        ? {
            ...parameter,
            options: [...parameter.options],
          }
        : { ...parameter },
    ),
  };
}

function getNextPatchTabColorIndex(patchTabs: PatchTab[]): number {
  return Math.max(-1, ...patchTabs.map((patchTab) => patchTab.colorIndex)) + 1;
}

function buildTabFlowConnections(patchTabs: PatchTab[]): TabFlowConnection[] {
  const connections: TabFlowConnection[] = [];
  const claimedSingleInputPorts = new Set<string>();

  patchTabs.forEach((sourcePatchTab, sourceIndex) => {
    const sourceDefinition = getPatchTabDefinition(sourcePatchTab);

    if (!sourceDefinition) {
      return;
    }

    for (const targetPatchTab of patchTabs.slice(sourceIndex + 1)) {
      const targetDefinition = getPatchTabDefinition(targetPatchTab);

      if (!targetDefinition) {
        continue;
      }

      const compatiblePorts = sourceDefinition.outputs.flatMap((outputPort) =>
        targetDefinition.inputs.flatMap((inputPort) => {
          const claimKey = `${targetPatchTab.id}:${inputPort.id}`;

          if (
            inputPort.cardinality.max === 1 &&
            claimedSingleInputPorts.has(claimKey)
          ) {
            return [];
          }

          return getPatchTabConnectionCompatibility(
            sourcePatchTab,
            targetPatchTab,
            outputPort.id,
            inputPort.id,
          ).state === 'compatible'
            ? [{ inputPort, outputPort }]
            : [];
        }),
      );
      const ports = compatiblePorts[0];

      if (!ports) {
        continue;
      }

      const order = connections.length;
      connections.push(
        createTabFlowConnection(
          sourcePatchTab,
          targetPatchTab,
          order,
          `connection-${sourcePatchTab.id}-${targetPatchTab.id}`,
          ports.outputPort.id,
          ports.inputPort.id,
        ),
      );

      if (ports.inputPort.cardinality.max === 1) {
        claimedSingleInputPorts.add(`${targetPatchTab.id}:${ports.inputPort.id}`);
      }
      break;
    }
  });

  return connections;
}

function refreshTabFlowConnections(connections: TabFlowConnection[], patchTabs: PatchTab[]): TabFlowConnection[] {
  const patchTabMap = new Map(patchTabs.map((patchTab) => [patchTab.id, patchTab]));

  return sortTabFlowConnections(connections).flatMap((connection, index) => {
    const sourcePatchTab = patchTabMap.get(connection.fromPatchTabId);
    const targetPatchTab = patchTabMap.get(connection.toPatchTabId);

    if (!sourcePatchTab || !targetPatchTab) {
      return [];
    }

    const refreshedConnection = createTabFlowConnection(
      sourcePatchTab,
      targetPatchTab,
      connection.order ?? index,
      connection.id,
      connection.fromPortId,
      connection.toPortId,
    );

    return [
      {
        ...refreshedConnection,
        id: connection.id,
        enabled: connection.enabled && refreshedConnection.enabled,
        createdOrder: connection.createdOrder ?? refreshedConnection.createdOrder,
      },
    ];
  });
}

function reconcileTabFlowLines(
  connections: TabFlowConnection[],
  previousTabFlowLines: TabFlowLine[] | undefined,
): TabFlowLine[] {
  const previousLines = Array.isArray(previousTabFlowLines) ? previousTabFlowLines : [];
  const sortedConnections = sortTabFlowConnections(connections);

  if (previousLines.length === 0) {
    return normalizeTabFlowLineOrder(
      createTabFlowFamiliesFromConnections(sortedConnections),
    );
  }

  const connectionMap = new Map(sortedConnections.map((connection) => [connection.id, connection]));
  const usedConnectionIds = new Set<string>();
  const usedLineIds = new Set<string>();
  const preservedLines = previousLines.flatMap((line, index) => {
    const connectionIds = line.connectionIds.filter((connectionId, connectionIndex, lineConnectionIds) => {
      if (!connectionMap.has(connectionId) || usedConnectionIds.has(connectionId)) {
        return false;
      }

      return lineConnectionIds.indexOf(connectionId) === connectionIndex;
    });

    connectionIds.forEach((connectionId) => usedConnectionIds.add(connectionId));

    const lineId =
      line.id && !usedLineIds.has(line.id) ? line.id : createTabFlowLineId(index, usedLineIds);
    const didConnectionSetChange = !areStringArraysEqual(line.connectionIds, connectionIds);

    usedLineIds.add(lineId);

    return [
      {
        ...line,
        id: lineId,
        name: line.name || createTabFlowLineName(index),
        order: line.order,
        enabled: line.enabled,
        revision: Math.max(1, line.revision ?? 1) + (didConnectionSetChange ? 1 : 0),
        connectionIds,
      },
    ];
  });

  const orphanConnections = sortedConnections.filter((connection) => !usedConnectionIds.has(connection.id));

  if (orphanConnections.length === 0) {
    return normalizeTabFlowLineOrder(preservedLines);
  }

  return normalizeTabFlowLineOrder([
    ...preservedLines,
    ...createTabFlowLinesFromRows(buildRoutingFlowRows(orphanConnections), [], preservedLines.length, usedLineIds),
  ]);
}

function createTabFlowLinesFromRows(
  rows: TabFlowConnection[][],
  previousLines: TabFlowLine[],
  startIndex = 0,
  usedLineIds = new Set<string>(),
): TabFlowLine[] {
  const previousLineBySignature = new Map(
    previousLines.map((line) => [createTabFlowLineSignature(line.connectionIds), line]),
  );
  const previousLineByFirstConnection = new Map(
    previousLines.flatMap((line) => (line.connectionIds[0] ? [[line.connectionIds[0], line] as const] : [])),
  );

  return rows.map((rowConnections, rowIndex) => {
    const index = startIndex + rowIndex;
    const connectionIds = rowConnections.map((connection) => connection.id);
    const signature = createTabFlowLineSignature(connectionIds);
    const previousLine =
      previousLineBySignature.get(signature) ??
      previousLineByFirstConnection.get(connectionIds[0]) ??
      previousLines[rowIndex];
    const lineId =
      previousLine?.id && !usedLineIds.has(previousLine.id)
        ? previousLine.id
        : createTabFlowLineId(index, usedLineIds);
    const didConnectionSetChange =
      previousLine !== undefined && !areStringArraysEqual(previousLine.connectionIds, connectionIds);

    usedLineIds.add(lineId);

    return {
      id: lineId,
      name: createTabFlowLineName(index),
      order: index,
      enabled: previousLine?.enabled ?? rowConnections.some((connection) => connection.enabled),
      revision: Math.max(1, previousLine?.revision ?? 1) + (didConnectionSetChange ? 1 : 0),
      connectionIds,
    };
  });
}

function normalizeTabFlowLineOrder(tabFlowLines: TabFlowLine[]): TabFlowLine[] {
  return normalizeTabFlowFamilies(
    tabFlowLines.map((line, index) => ({
      ...line,
      name: line.name || createTabFlowLineName(index),
    })),
  );
}

function pruneEmptiedTabFlowLines(
  tabFlowLines: TabFlowLine[] | undefined,
  connections: TabFlowConnection[],
): TabFlowLine[] | undefined {
  if (!Array.isArray(tabFlowLines)) {
    return tabFlowLines;
  }

  const connectionIds = new Set(connections.map((connection) => connection.id));

  return tabFlowLines.filter(
    (line) => line.connectionIds.length === 0 || line.connectionIds.some((connectionId) => connectionIds.has(connectionId)),
  );
}

function getProjectTabFlowLines(project: ProjectState): TabFlowLine[] {
  return normalizeTabFlowLines(project.tabFlowLines, project.connections);
}

function findTabFlowLineIdForConnection(tabFlowLines: TabFlowLine[], connectionId: string): string | undefined {
  return tabFlowLines.find((line) => line.connectionIds.includes(connectionId))?.id;
}

function getPreferredSelectedTabFlowLineId(
  tabFlowLines: TabFlowLine[],
  preferredTabFlowLineId: string | undefined,
  selectedConnectionId: string,
): string {
  if (preferredTabFlowLineId && tabFlowLines.some((line) => line.id === preferredTabFlowLineId)) {
    return preferredTabFlowLineId;
  }

  return findTabFlowLineIdForConnection(tabFlowLines, selectedConnectionId) ?? tabFlowLines[0]?.id ?? '';
}

function getRoutingFlowRows(
  connections: TabFlowConnection[],
  tabFlowLines: TabFlowLine[] | undefined,
  patchTabs: PatchTab[] = [],
): RoutingFlowRow[] {
  const connectionMap = new Map(connections.map((connection) => [connection.id, connection]));
  const normalizedTabFlowLines = normalizeTabFlowLines(tabFlowLines, connections);

  return getTabFlowLaneViews(normalizedTabFlowLines, connections, patchTabs).map((laneView) => {
    const { line } = laneView;
    const lineConnections = line.connectionIds.flatMap((connectionId) => {
      const connection = connectionMap.get(connectionId);
      return connection ? [connection] : [];
    });

    return {
      line,
      rootLine: laneView.rootLine,
      connections: lineConnections,
      displayLabel: laneView.displayLabel,
      isChild: laneView.isChild,
      startIndex: laneView.startIndex,
    };
  });
}

function getTabFlowLineDisplayLabel(project: ProjectState, lineId: string): string {
  const tabFlowLines = getProjectTabFlowLines(project);
  const view = getTabFlowLaneViews(
    tabFlowLines,
    project.connections,
    project.patchTabs,
  ).find((candidate) => candidate.line.id === lineId);
  const line = tabFlowLines.find((candidate) => candidate.id === lineId);

  return view?.displayLabel ?? String((line?.order ?? 0) + 1);
}

function synchronizeTabFlowConnectionStates(
  connections: TabFlowConnection[],
  tabFlowLines: TabFlowLine[],
  patchTabs: PatchTab[],
): TabFlowConnection[] {
  const normalizedLines = normalizeTabFlowFamilies(tabFlowLines);
  const patchTabMap = new Map(patchTabs.map((patchTab) => [patchTab.id, patchTab]));
  const lineByConnectionId = new Map<string, TabFlowLine>();

  normalizedLines.forEach((line) => {
    line.connectionIds.forEach((connectionId) => lineByConnectionId.set(connectionId, line));
  });

  return connections.map((connection) => {
    const line = lineByConnectionId.get(connection.id);
    const rootLine = line ? getTabFlowFamilyRoot(normalizedLines, line.id) : undefined;
    const isCompatible = getConnectionCompatibility(connection, patchTabMap).state === 'compatible';
    const enabled = isCompatible && (rootLine?.enabled ?? line?.enabled ?? connection.enabled);
    const activation = isCompatible ? (enabled ? 'on' : 'off') : 'draft';

    return connection.enabled === enabled && connection.activation === activation
      ? connection
      : { ...connection, enabled, activation };
  });
}

function createTabFlowStructureBlockedHelpMessage(
  state: ReturnType<typeof getTabFlowStructureState>,
): string {
  if (state === 'self-link') {
    return 'ROUTE BLOCKED: A PatchTab cannot connect to itself.';
  }

  if (state === 'loop-blocked') {
    return 'ROUTE BLOCKED: This connection would create a TabFlow loop.';
  }

  if (state === 'input-full') {
    return 'ROUTE BLOCKED: The selected Input port has reached its connection limit.';
  }

  return 'ROUTE BLOCKED: This connection is already present.';
}

function createPatchPortOptionValue(patchTabId: string, portId: string): string {
  return `${encodeURIComponent(patchTabId)}::${encodeURIComponent(portId)}`;
}

function parsePatchPortOptionValue(
  value: string,
): { patchTabId: string; portId: string } | undefined {
  const [patchTabId, portId, extra] = value.split('::');

  if (!patchTabId || !portId || extra !== undefined) {
    return undefined;
  }

  return {
    patchTabId: decodeURIComponent(patchTabId),
    portId: decodeURIComponent(portId),
  };
}

function removeConnectionAndDownstream(
  connections: TabFlowConnection[],
  tabFlowLines: TabFlowLine[] | undefined,
  connectionId: string,
): TabFlowConnection[] {
  const deletionImpact = getConnectionDeletionImpact(connections, tabFlowLines, connectionId);
  const removedConnectionIds = new Set(deletionImpact.removedConnections.map((connection) => connection.id));

  return connections.filter((connection) => !removedConnectionIds.has(connection.id));
}

function getConnectionDeletionImpact(
  connections: TabFlowConnection[],
  tabFlowLines: TabFlowLine[] | undefined,
  connectionId: string,
): ConnectionDeletionImpact {
  const connectionMap = new Map(connections.map((connection) => [connection.id, connection]));
  const line = normalizeTabFlowLines(tabFlowLines, connections).find((candidate) =>
    candidate.connectionIds.includes(connectionId),
  );

  if (!line) {
    const connection = connectionMap.get(connectionId);

    return {
      removedConnections: connection ? [connection] : [],
      downstreamCount: 0,
    };
  }

  const startIndex = line.connectionIds.indexOf(connectionId);
  const removedConnections = line.connectionIds.slice(startIndex).flatMap((removedConnectionId) => {
    const connection = connectionMap.get(removedConnectionId);
    return connection ? [connection] : [];
  });

  return {
    lineOrder: line.order,
    removedConnections,
    downstreamCount: Math.max(0, removedConnections.length - 1),
  };
}

function formatConnectionDeletionTitle(deletionImpact: ConnectionDeletionImpact | undefined): string {
  if (!deletionImpact || deletionImpact.downstreamCount === 0) {
    return 'Remove connection';
  }

  return `Remove this route and ${deletionImpact.downstreamCount} downstream route${deletionImpact.downstreamCount === 1 ? '' : 's'}`;
}

function formatConnectionDeletionAriaLabel(
  connection: TabFlowConnection,
  patchTabMap: Map<string, PatchTab>,
  deletionImpact: ConnectionDeletionImpact | undefined,
): string {
  const label = formatConnectionDeletionTitle(deletionImpact);

  return `${label}: ${formatConnectionRouteLabel(connection, patchTabMap)}`;
}

function formatConnectionDeletionMessage(deletionImpact: ConnectionDeletionImpact): string {
  const lineLabel = typeof deletionImpact.lineOrder === 'number' ? `TabFlow line ${deletionImpact.lineOrder + 1}` : 'this TabFlow line';

  return `Deleting this route will also remove downstream routes from ${lineLabel}.`;
}

function formatConnectionDeletionDetails(
  deletionImpact: ConnectionDeletionImpact,
  patchTabMap: Map<string, PatchTab>,
): string[] {
  return deletionImpact.removedConnections.map((connection) => formatConnectionRouteLabel(connection, patchTabMap));
}

function formatConnectionRouteLabel(
  connection: TabFlowConnection,
  patchTabMap: Map<string, PatchTab>,
): string {
  const sourceName = patchTabMap.get(connection.fromPatchTabId)?.name ?? 'Missing Source';
  const targetName = patchTabMap.get(connection.toPatchTabId)?.name ?? 'Missing Target';

  return `${sourceName} -> ${targetName}`;
}

function getPatchTabDeletionImpact(
  project: ProjectState,
  patchTabId: string,
): {
  removedConnections: TabFlowConnection[];
} {
  const nextConnections = removePatchTabConnectionsAndDownstream(project.connections, project.tabFlowLines, patchTabId);
  const nextConnectionIds = new Set(nextConnections.map((connection) => connection.id));

  return {
    removedConnections: project.connections.filter((connection) => !nextConnectionIds.has(connection.id)),
  };
}

function removePatchTabConnectionsAndDownstream(
  connections: TabFlowConnection[],
  tabFlowLines: TabFlowLine[] | undefined,
  patchTabId: string,
): TabFlowConnection[] {
  const connectionMap = new Map(connections.map((connection) => [connection.id, connection]));
  const removedConnectionIds = new Set<string>();

  normalizeTabFlowLines(tabFlowLines, connections).forEach((line) => {
    const firstAffectedIndex = line.connectionIds.findIndex((connectionId) => {
      const connection = connectionMap.get(connectionId);
      return connection?.fromPatchTabId === patchTabId || connection?.toPatchTabId === patchTabId;
    });

    if (firstAffectedIndex >= 0) {
      line.connectionIds.slice(firstAffectedIndex).forEach((connectionId) => removedConnectionIds.add(connectionId));
    }
  });

  return connections.filter(
    (connection) =>
      !removedConnectionIds.has(connection.id) &&
      connection.fromPatchTabId !== patchTabId &&
      connection.toPatchTabId !== patchTabId,
  );
}

function buildRoutingFlowRows(connections: TabFlowConnection[]): TabFlowConnection[][] {
  const rows: TabFlowConnection[][] = [];
  const rowByPatchTab = new Map<string, number>();
  const sourceUseCount = new Map<string, number>();

  sortTabFlowConnections(connections).forEach((connection) => {
    const existingRowIndex = rowByPatchTab.get(connection.fromPatchTabId);
    const usageCount = sourceUseCount.get(connection.fromPatchTabId) ?? 0;
    const rowIndex = usageCount === 0 ? existingRowIndex ?? rows.length : rows.length;

    sourceUseCount.set(connection.fromPatchTabId, usageCount + 1);
    rows[rowIndex] = rows[rowIndex] ?? [];
    rows[rowIndex].push(connection);

    if (!rowByPatchTab.has(connection.fromPatchTabId)) {
      rowByPatchTab.set(connection.fromPatchTabId, rowIndex);
    }

    rowByPatchTab.set(connection.toPatchTabId, rowIndex);
  });

  return rows.filter((row) => row.length > 0);
}

function sortTabFlowConnections(connections: TabFlowConnection[]): TabFlowConnection[] {
  return [...connections].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function getNextTabFlowConnectionOrder(connections: TabFlowConnection[]): number {
  return Math.max(-1, ...connections.map((connection) => connection.order)) + 1;
}

function createTabFlowLineId(index: number, usedLineIds: Set<string>): string {
  let lineNumber = index + 1;
  let lineId = `tabflow-line-${String(lineNumber).padStart(2, '0')}`;

  while (usedLineIds.has(lineId)) {
    lineNumber += 1;
    lineId = `tabflow-line-${String(lineNumber).padStart(2, '0')}`;
  }

  return lineId;
}

function createTabFlowLineName(index: number): string {
  return `TabFlow Line ${index + 1}`;
}

function createTabFlowLineSignature(connectionIds: string[]): string {
  return connectionIds.join('>');
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function createTabFlowConnectionId(
  fromPatchTabId: string,
  toPatchTabId: string,
  usedConnectionIds: Set<string>,
  preferredScopeId?: string,
): string {
  const baseId = `connection-${fromPatchTabId}-${toPatchTabId}`;

  if (!usedConnectionIds.has(baseId)) {
    return baseId;
  }

  const scopedBaseId = preferredScopeId ? `${baseId}-${preferredScopeId}` : baseId;

  if (!usedConnectionIds.has(scopedBaseId)) {
    return scopedBaseId;
  }

  let connectionNumber = 2;
  let connectionId = `${scopedBaseId}-${String(connectionNumber).padStart(2, '0')}`;

  while (usedConnectionIds.has(connectionId)) {
    connectionNumber += 1;
    connectionId = `${scopedBaseId}-${String(connectionNumber).padStart(2, '0')}`;
  }

  return connectionId;
}

function createTabFlowConnection(
  fromPatchTab: PatchTab,
  toPatchTab: PatchTab,
  order = 0,
  connectionId = `connection-${fromPatchTab.id}-${toPatchTab.id}`,
  fromPortId = getDefaultOutputPort(fromPatchTab)?.id,
  toPortId = getDefaultInputPort(toPatchTab)?.id,
): TabFlowConnection {
  const compatibility = getPatchTabConnectionCompatibility(
    fromPatchTab,
    toPatchTab,
    fromPortId,
    toPortId,
  );
  const isCompatible = compatibility.state === 'compatible';

  return {
    id: connectionId,
    fromPatchTabId: fromPatchTab.id,
    toPatchTabId: toPatchTab.id,
    ...(fromPortId ? { fromPortId } : {}),
    ...(toPortId ? { toPortId } : {}),
    activation: isCompatible ? 'on' : 'draft',
    createdOrder: order,
    signalType: compatibility.outputPort?.label ?? fromPatchTab.outputType,
    order,
    latencyMs: isCompatible
      ? getMockLatencyMs(compatibility.outputPort?.dataCategory ?? fromPatchTab.outputType)
      : 0,
    enabled: isCompatible,
  };
}

function getTabFlowConnectionState(
  connection: TabFlowConnection,
  patchTabMap: Map<string, PatchTab>,
): TabFlowConnectionState {
  if (connection.activation === 'draft' || !isTabFlowConnectionCompatible(connection, patchTabMap)) {
    return 'invalid';
  }

  return connection.enabled ? 'enabled' : 'disabled';
}

function getTabFlowRowState(row: RoutingFlowRow, patchTabMap: Map<string, PatchTab>): TabFlowConnectionState {
  if (row.connections.length === 0) {
    return row.line.enabled ? 'enabled' : 'disabled';
  }

  const rowStates = row.connections.map((connection) => getTabFlowConnectionState(connection, patchTabMap));

  if (rowStates.some((connectionState) => connectionState === 'invalid')) {
    return 'invalid';
  }

  return row.line.enabled && rowStates.some((connectionState) => connectionState === 'enabled') ? 'enabled' : 'disabled';
}

function getConnectionStateClass(connectionState: TabFlowConnectionState): string {
  if (connectionState === 'invalid') {
    return 'broken';
  }

  return connectionState === 'enabled' ? 'valid' : 'disabled';
}

function isTabFlowConnectionCompatible(connection: TabFlowConnection, patchTabMap: Map<string, PatchTab>): boolean {
  return getConnectionCompatibility(connection, patchTabMap).state === 'compatible';
}

function getMockLatencyMs(signalType: string): number {
  return (
    {
      'Hum Audio': 8,
      'MIDI Notes': 2,
      'Edited MIDI': 1,
      'Instrument Audio': 4,
      Arrangement: 0,
    }[signalType] ?? 3
  );
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseCssPixelValue(value: string, fallback: number): number {
  const parsedValue = Number.parseFloat(value);

  return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

function parseProjectKey(key: string): ParsedProjectKey {
  const [rootCandidate, modeCandidate] = key.trim().split(/\s+/);
  const root = keyRootOptions.find((option) => option.toLowerCase() === rootCandidate?.toLowerCase()) ?? 'C';
  const mode = modeCandidate?.toLowerCase() === 'major' ? 'major' : 'minor';

  return { root, mode };
}

function formatProjectKey(root: string, mode: KeyMode): string {
  return `${root} ${mode}`;
}

function getMinimumTotalTicks(): number {
  return barsToTicks(MIN_TIMELINE_BARS);
}

function getLatestClipEndTick(tracks: Track[]): number {
  return tracks.reduce((latestEndTick, track) => {
    if (track.group || track.type === 'group') {
      return latestEndTick;
    }

    return track.clips.reduce(
      (latestTrackEndTick, clip) => Math.max(latestTrackEndTick, clip.startTick + clip.lengthTicks),
      latestEndTick,
    );
  }, 0);
}

function getRequiredTimelineBarsForClips(tracks: Track[]): number {
  return Math.max(MIN_TIMELINE_BARS, Math.ceil(ticksToBars(getLatestClipEndTick(tracks))));
}

function barsToTicks(bars: number): number {
  return beatsToTicks(bars * TIMELINE_BEATS_PER_BAR);
}

function ticksToBars(ticks: number): number {
  return ticksToBeats(ticks) / TIMELINE_BEATS_PER_BAR;
}

function formatTickBeatPosition(tick: number): string {
  return formatBeatDecimal(ticksToBeats(tick) + 1);
}

function formatPunchMarkerPosition(tick: number): string {
  return String(Math.floor(ticksToBeats(tick) + 1));
}

function formatTickBeatLength(ticks: number): string {
  return formatBeatDecimal(ticksToBeats(ticks));
}

function formatBeatDecimal(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function createClipActionDetail(
  selectedClipInfo: SelectedClipInfo | undefined,
  isReady: boolean,
  emptyLabel: string,
): string {
  if (!selectedClipInfo) {
    return emptyLabel;
  }

  return isReady ? `READY: ${selectedClipInfo.clip.name}` : `SELECT SOURCE, CURRENT: ${selectedClipInfo.clip.type}`;
}

function isElementOverflowing(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
}
