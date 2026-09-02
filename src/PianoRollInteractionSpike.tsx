import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';

import {
  resolveActiveMidiTake,
  type ActiveMidiTakePlan,
} from './activeMidiTake';
import { createMidiContentHash } from './midiContentHash';
import { isPianoRollTakeShared } from './pianoRollTakeEditing';
import {
  addMidiNote,
  deleteMidiNotes,
  hasMidiNoteAtPosition,
  moveMidiNote,
  moveMidiNotesBy,
  resizeMidiNoteEnd,
  resizeMidiNoteEndsBy,
  snapMidiTick,
} from './midiNoteEditing';
import {
  PianoRollSoundFontControl,
  type PianoRollSoundFontCatalogState,
} from './PianoRollSoundFontControl';
import type {
  LocalEngineSoundFontPresetCatalogResult,
  LocalEngineSoundFontResource,
} from './localEngineClient';
import { getPreferredSoundFontResource } from './defaultSoundFontPreset';
import type {
  PianoRollLiveNotePreviewSelection,
  PianoRollLiveNotePreviewState,
} from './pianoRollLiveNotePreview';
import {
  createPianoRollMarqueeRect,
  createPianoRollNoteRect,
  getMidiNoteName,
  getPianoRollClipEndX,
  getPianoRollContentWidthForClip,
  getPianoRollDirectDrawLengthTicks,
  getPianoRollGridStepTicks,
  getPianoRollNoteIdsInMarquee,
  getPianoRollOctaveScrollTop,
  getPianoRollRowHeight,
  isBlackMidiPitch,
  midiPitchToPianoRollY,
  midiTickToPianoRollX,
  pianoRollPixelDeltaToSemitones,
  pianoRollPixelDeltaToTicks,
  pianoRollXToMidiTick,
  pianoRollYToMidiPitch,
  resolvePianoRollMarqueeSelection,
  togglePianoRollNoteSelection,
  PIANO_ROLL_GRID_DENOMINATORS,
  PIANO_ROLL_QUARTER_WIDTH_PX,
  PIANO_ROLL_ROW_HEIGHT_PX,
  PIANO_ROLL_TOTAL_PITCHES,
  type PianoRollGridDenominator,
  type PianoRollMarqueeRect,
} from './pianoRollGeometry';
import {
  getPianoRollLinkedPageScrollLeft,
  resolvePianoRollLinkedPlayhead,
} from './pianoRollLink';
import type { MidiNote, ProjectState, SoundFontAssignment } from './types';

const POINTER_DRAG_THRESHOLD_PX = 4;
const PIANO_ROLL_HISTORY_LIMIT = 80;
const MIDI_PITCHES_DESCENDING = Array.from(
  { length: PIANO_ROLL_TOTAL_PITCHES },
  (_, index) => 127 - index,
);

type PianoRollInteractionMode = 'move' | 'resize';

export type PianoRollHistoryCommand = 'redo' | 'undo';

export function resolvePianoRollHistoryShortcut({
  altKey,
  ctrlKey,
  defaultPrevented,
  key,
  metaKey,
  repeat,
  shiftKey,
  target,
}: Readonly<{
  altKey: boolean;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  key: string;
  metaKey: boolean;
  repeat: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}>): PianoRollHistoryCommand | undefined {
  if (defaultPrevented || repeat || altKey || !(ctrlKey || metaKey)) {
    return undefined;
  }

  const closest = (
    target as { closest?: (selector: string) => unknown } | null
  )?.closest;

  if (
    typeof closest === 'function' &&
    closest.call(
      target,
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    )
  ) {
    return undefined;
  }

  const normalizedKey = key.toLowerCase();

  if (normalizedKey === 'z') {
    return shiftKey ? 'redo' : 'undo';
  }

  return normalizedKey === 'y' ? 'redo' : undefined;
}

type PianoRollInsertCursor = Readonly<{
  lengthTicks: number;
  pitch: number;
  startTick: number;
  velocity: number;
}>;

type PianoRollNotePointerSession = {
  captureTarget: HTMLElement;
  didDrag: boolean;
  kind: 'note';
  mode: PianoRollInteractionMode;
  noteId: string;
  originalNote: MidiNote;
  originalNotes: readonly MidiNote[];
  pointerId: number;
  selectedNoteIds: readonly string[];
  startClientX: number;
  startClientY: number;
};

type PianoRollInsertPointerSession = {
  captureTarget: HTMLElement;
  kind: 'insert';
  noteId: string;
  originalNotes: readonly MidiNote[];
  pitch: number;
  pointerId: number;
  startTick: number;
};

type PianoRollPanPointerSession = {
  captureTarget: HTMLElement;
  kind: 'pan';
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
};

type PianoRollMarqueePointerSession = {
  anchorX: number;
  anchorY: number;
  captureTarget: HTMLElement;
  currentSelectedNoteIds: readonly string[];
  isAdditive: boolean;
  kind: 'marquee';
  originalSelectedNoteIds: readonly string[];
  pointerId: number;
};

type PianoRollPointerSession =
  | PianoRollInsertPointerSession
  | PianoRollMarqueePointerSession
  | PianoRollNotePointerSession
  | PianoRollPanPointerSession;

type PianoRollEditSession = Readonly<{
  clipId: string;
  contentHash: string;
  future: readonly (readonly MidiNote[])[];
  notes: readonly MidiNote[];
  past: readonly (readonly MidiNote[])[];
  pendingSaveHash?: string;
  pendingSourceChange?: 'auto-copy' | 'reset';
  sourceKey: string;
}>;

export type PianoRollSoundFontAuditionRequest = Readonly<{
  bank: number;
  clipName: string;
  notes: readonly MidiNote[];
  plan: ActiveMidiTakePlan;
  program: number;
  resource: LocalEngineSoundFontResource;
  sourceKey: string;
}>;

export function PianoRollInteractionSpike({
  hasUnsavedProjectChanges,
  isActive,
  isTimelinePlaying,
  onCreateManualMidiClip,
  onCreateNewTake,
  onAssignSoundFont,
  onListSoundFontPresets,
  onPrepareLiveNotePreview,
  onRefreshSoundFonts,
  onSaveNotes,
  onStopLiveNotePreview,
  onTriggerLiveNotePreview,
  pianoRollLiveNotePreviewState,
  project,
  selectedClipId,
  soundFontCatalogState,
}: {
  hasUnsavedProjectChanges: boolean;
  isActive: boolean;
  isTimelinePlaying: boolean;
  onCreateManualMidiClip: () => void;
  onCreateNewTake: (clipId: string, notes: readonly MidiNote[]) => void;
  onAssignSoundFont: (
    clipId: string,
    assignment: SoundFontAssignment | undefined,
  ) => void;
  onListSoundFontPresets: (
    resource: LocalEngineSoundFontResource,
  ) => Promise<LocalEngineSoundFontPresetCatalogResult>;
  onPrepareLiveNotePreview: (
    selection: PianoRollLiveNotePreviewSelection,
  ) => void;
  onRefreshSoundFonts: () => void;
  onSaveNotes: (clipId: string, notes: readonly MidiNote[]) => void;
  onStopLiveNotePreview: () => void;
  onTriggerLiveNotePreview: (pitch: number, velocity: number) => void;
  pianoRollLiveNotePreviewState: PianoRollLiveNotePreviewState;
  project: ProjectState;
  selectedClipId: string;
  soundFontCatalogState: PianoRollSoundFontCatalogState;
}) {
  const [isTimelineLinked, setIsTimelineLinked] = useState(false);
  const [editSessions, setEditSessions] = useState<
    Readonly<Record<string, PianoRollEditSession>>
  >({});
  const resolution =
    selectedClipId === ''
      ? undefined
      : resolveActiveMidiTake(project, selectedClipId);
  const resolvedPlan =
    resolution?.canResolve === true ? resolution.plan : undefined;
  const resolvedSourceKey = resolvedPlan
    ? [
        resolvedPlan.source.clipId,
        resolvedPlan.source.clipTakeId,
        resolvedPlan.source.artifactId,
      ].join(':')
    : '';
  const storedSession =
    resolvedPlan === undefined
      ? undefined
      : editSessions[resolvedSourceKey] ??
        Object.values(editSessions).find(
          (session) =>
            session.clipId === resolvedPlan.source.clipId &&
            session.pendingSourceChange === 'auto-copy',
        );
  const editSession = resolvedPlan
    ? reconcilePianoRollEditSession(
        storedSession,
        resolvedPlan,
        resolvedSourceKey,
      )
    : undefined;

  useEffect(() => {
    if (!resolvedPlan || !editSession) {
      return;
    }

    if (storedSession === editSession) {
      return;
    }

    setEditSessions((currentSessions) => {
      const nextSessions = {
        ...currentSessions,
        [resolvedSourceKey]: editSession,
      };

      if (
        storedSession &&
        storedSession.sourceKey !== resolvedSourceKey &&
        storedSession.pendingSourceChange === 'auto-copy'
      ) {
        delete nextSessions[storedSession.sourceKey];
      }

      return nextSessions;
    });
  }, [
    editSession,
    resolvedPlan,
    resolvedSourceKey,
    storedSession,
  ]);

  if (selectedClipId === '') {
    return (
      <PianoRollMessage
        actionLabel="NEW MIDI"
        isActive={isActive}
        message="Create a four-bar Manual MIDI Clip at the Timeline playhead. It expands by whole bars when notes cross the end."
        onAction={onCreateManualMidiClip}
        status="NO MIDI CLIP"
      />
    );
  }

  if (!resolution?.canResolve) {
    return (
      <PianoRollMessage
        isActive={isActive}
        message={resolution?.message ?? 'MIDI Take is unavailable.'}
        status="MIDI TAKE UNAVAILABLE"
      />
    );
  }

  const selectedClip = project.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === selectedClipId);
  const clipName = selectedClip?.name ?? selectedClipId;
  if (!editSession) {
    return null;
  }

  return (
    <ResolvedPianoRollInteractionSpike
      clipLengthTicks={selectedClip?.lengthTicks ?? 1}
      clipName={clipName}
      clipStartTick={selectedClip?.startTick ?? 0}
      editSession={editSession}
      hasUnsavedProjectChanges={hasUnsavedProjectChanges}
      isActive={isActive}
      isSourceShared={isPianoRollTakeShared(project, resolution.plan.source)}
      isTimelineLinked={isTimelineLinked}
      isTimelinePlaying={isTimelinePlaying}
      onListSoundFontPresets={onListSoundFontPresets}
      onPrepareLiveNotePreview={onPrepareLiveNotePreview}
      soundFontAssignment={selectedClip?.soundFont}
      soundFontCatalogState={soundFontCatalogState}
      onAssignSoundFont={(assignment) =>
        onAssignSoundFont(resolution.plan.source.clipId, assignment)
      }
      onCreateNewTake={(notes) => {
        setEditSessions((currentSessions) => ({
          ...currentSessions,
          [resolvedSourceKey]: {
            ...editSession,
            pendingSourceChange: 'reset',
          },
        }));
        onCreateNewTake(resolution.plan.source.clipId, notes);
      }}
      onRefreshSoundFonts={onRefreshSoundFonts}
      onSaveNotes={onSaveNotes}
      onStopLiveNotePreview={onStopLiveNotePreview}
      onTriggerLiveNotePreview={onTriggerLiveNotePreview}
      onSessionChange={(nextSession) =>
        setEditSessions((currentSessions) => ({
          ...currentSessions,
          [resolvedSourceKey]: nextSession,
        }))
      }
      onTimelineLinkChange={setIsTimelineLinked}
      plan={resolution.plan}
      playheadTick={project.playheadTick}
      pianoRollLiveNotePreviewState={pianoRollLiveNotePreviewState}
      sourceKey={resolvedSourceKey}
    />
  );
}

function ResolvedPianoRollInteractionSpike({
  clipLengthTicks,
  clipName,
  clipStartTick,
  editSession,
  hasUnsavedProjectChanges,
  isActive,
  isSourceShared,
  isTimelineLinked,
  isTimelinePlaying,
  onAssignSoundFont,
  onCreateNewTake,
  onPrepareLiveNotePreview,
  onListSoundFontPresets,
  onRefreshSoundFonts,
  onSaveNotes,
  onSessionChange,
  onStopLiveNotePreview,
  onTimelineLinkChange,
  onTriggerLiveNotePreview,
  pianoRollLiveNotePreviewState,
  plan,
  playheadTick,
  sourceKey,
  soundFontAssignment,
  soundFontCatalogState,
}: {
  clipLengthTicks: number;
  clipName: string;
  clipStartTick: number;
  editSession: PianoRollEditSession;
  hasUnsavedProjectChanges: boolean;
  isActive: boolean;
  isSourceShared: boolean;
  isTimelineLinked: boolean;
  isTimelinePlaying: boolean;
  onAssignSoundFont: (assignment: SoundFontAssignment | undefined) => void;
  onListSoundFontPresets: (
    resource: LocalEngineSoundFontResource,
  ) => Promise<LocalEngineSoundFontPresetCatalogResult>;
  onCreateNewTake: (notes: readonly MidiNote[]) => void;
  onPrepareLiveNotePreview: (
    selection: PianoRollLiveNotePreviewSelection,
  ) => void;
  onRefreshSoundFonts: () => void;
  onSaveNotes: (clipId: string, notes: readonly MidiNote[]) => void;
  onSessionChange: (session: PianoRollEditSession) => void;
  onStopLiveNotePreview: () => void;
  onTimelineLinkChange: (isLinked: boolean) => void;
  onTriggerLiveNotePreview: (pitch: number, velocity: number) => void;
  pianoRollLiveNotePreviewState: PianoRollLiveNotePreviewState;
  plan: ActiveMidiTakePlan;
  playheadTick: number;
  sourceKey: string;
  soundFontAssignment?: SoundFontAssignment;
  soundFontCatalogState: PianoRollSoundFontCatalogState;
}) {
  const [previewNotes, setPreviewNotes] = useState<readonly MidiNote[]>();
  const [selectedNoteId, setSelectedNoteId] = useState<string>();
  const [selectedNoteIds, setSelectedNoteIds] = useState<readonly string[]>([]);
  const [activeGestureNoteId, setActiveGestureNoteId] = useState<string>();
  const [insertCursor, setInsertCursor] = useState<PianoRollInsertCursor>();
  const [insertGhostNote, setInsertGhostNote] = useState<MidiNote>();
  const [marqueeRect, setMarqueeRect] = useState<PianoRollMarqueeRect>();
  const [isGridHoverActive, setIsGridHoverActive] = useState(false);
  const [isGridKeyboardFocused, setIsGridKeyboardFocused] = useState(false);
  const [isHandScrolling, setIsHandScrolling] = useState(false);
  const [gridDenominator, setGridDenominator] =
    useState<PianoRollGridDenominator>(16);
  const [isLiveNotePreviewEnabled, setIsLiveNotePreviewEnabled] = useState(true);
  const pointerSessionRef = useRef<PianoRollPointerSession>();
  const previewNotesRef = useRef<readonly MidiNote[]>();
  const insertGhostNoteRef = useRef<MidiNote>();
  const pendingFocusNoteIdRef = useRef<string>();
  const keyboardRef = useRef<HTMLDivElement>(null);
  const noteGridRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const hasInitializedViewportRef = useRef(false);
  const [rowHeight, setRowHeight] = useState(PIANO_ROLL_ROW_HEIGHT_PX);
  const notes = previewNotes ?? editSession.notes;
  const contentNotes = insertGhostNote
    ? [...notes, insertGhostNote]
    : notes;
  const ticksPerQuarter = plan.midi.ticksPerQuarter;
  const soundFontResources =
    soundFontCatalogState.status === 'READY'
      ? soundFontCatalogState.catalog.resources
      : [];
  const assignedSoundFontResource = soundFontAssignment
    ? soundFontResources.find(
        (resource) =>
          resource.library === soundFontAssignment.resource.library &&
          resource.resourceId === soundFontAssignment.resource.resourceId,
      )
    : undefined;
  const liveNotePreviewResource = soundFontAssignment
    ? assignedSoundFontResource
    : getPreferredSoundFontResource(soundFontResources);
  const liveNotePreviewSelection = liveNotePreviewResource
    ? {
        bank: soundFontAssignment?.bank ?? 0,
        program: soundFontAssignment?.program ?? 0,
        resource: liveNotePreviewResource,
      }
    : undefined;
  const gridStepTicks = getPianoRollGridStepTicks(
    ticksPerQuarter,
    gridDenominator,
  );
  const contentWidth = getPianoRollContentWidthForClip(
    contentNotes,
    ticksPerQuarter,
    clipLengthTicks,
  );
  const clipEndX = getPianoRollClipEndX(
    clipLengthTicks,
    ticksPerQuarter,
  );
  const linkedPlayhead = useMemo(
    () =>
      resolvePianoRollLinkedPlayhead({
        clipLengthTicks,
        clipStartTick,
        playheadTick,
        ticksPerQuarter,
      }),
    [
      clipLengthTicks,
      clipStartTick,
      playheadTick,
      ticksPerQuarter,
    ],
  );
  const selectedNoteIdSet = useMemo(
    () => new Set(selectedNoteIds),
    [selectedNoteIds],
  );
  const selectedNotes = useMemo(
    () => notes.filter((note) => selectedNoteIdSet.has(note.id)),
    [notes, selectedNoteIdSet],
  );
  const activeSelectedNoteIds = useMemo(
    () => selectedNotes.map((note) => note.id),
    [selectedNotes],
  );
  const selectedNote = useMemo(
    () =>
      notes.find((note) => note.id === selectedNoteId) ?? selectedNotes[0],
    [notes, selectedNoteId, selectedNotes],
  );
  const pitchSurfaceHeight = PIANO_ROLL_TOTAL_PITCHES * rowHeight;
  const keyboardStyle = {
    '--piano-roll-row-height': `${rowHeight}px`,
    height: `${pitchSurfaceHeight}px`,
  } as CSSProperties;
  const surfaceStyle = {
    '--piano-roll-grid-step-width': `${
      (PIANO_ROLL_QUARTER_WIDTH_PX * gridStepTicks) / ticksPerQuarter
    }px`,
    '--piano-roll-quarter-width': `${PIANO_ROLL_QUARTER_WIDTH_PX}px`,
    '--piano-roll-row-height': `${rowHeight}px`,
    height: `${pitchSurfaceHeight}px`,
    width: `${contentWidth}px`,
  } as CSSProperties;
  const syncKeyboardScroll = (scrollTop: number) => {
    if (keyboardRef.current) {
      keyboardRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
  };

  useEffect(() => {
    const session = pointerSessionRef.current;
    const shouldPreserveSelection =
      editSession.pendingSourceChange === 'auto-copy';

    if (session?.captureTarget.hasPointerCapture(session.pointerId)) {
      session.captureTarget.releasePointerCapture(session.pointerId);
    }

    pointerSessionRef.current = undefined;
    previewNotesRef.current = undefined;
    insertGhostNoteRef.current = undefined;
    setPreviewNotes(undefined);
    setInsertGhostNote(undefined);
    setMarqueeRect(undefined);
    setIsGridHoverActive(false);
    setIsGridKeyboardFocused(false);
    setIsHandScrolling(false);
    if (!shouldPreserveSelection) {
      pendingFocusNoteIdRef.current = undefined;
      setSelectedNoteId(undefined);
      setSelectedNoteIds([]);
      setInsertCursor(undefined);
      hasInitializedViewportRef.current = false;
    }
    setActiveGestureNoteId(undefined);
  }, [sourceKey]);

  useEffect(() => {
    const pendingNoteId = pendingFocusNoteIdRef.current;

    if (!pendingNoteId || selectedNoteId !== pendingNoteId) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const noteButton = Array.from(
        noteGridRef.current?.querySelectorAll<HTMLButtonElement>(
          '[data-note-id]',
        ) ?? [],
      ).find((button) => button.dataset.noteId === pendingNoteId);

      if (noteButton) {
        pendingFocusNoteIdRef.current = undefined;
        noteButton.focus();
      }
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [editSession.notes, selectedNoteId]);

  useEffect(() => {
    if (
      !isActive ||
      isTimelinePlaying ||
      !isLiveNotePreviewEnabled ||
      !liveNotePreviewSelection
    ) {
      return;
    }

    onPrepareLiveNotePreview(liveNotePreviewSelection);
    return onStopLiveNotePreview;
  }, [
    isActive,
    isLiveNotePreviewEnabled,
    isTimelinePlaying,
    liveNotePreviewSelection?.bank,
    liveNotePreviewSelection?.program,
    liveNotePreviewSelection?.resource.library,
    liveNotePreviewSelection?.resource.resourceId,
    liveNotePreviewSelection?.resource.revisionToken,
    onPrepareLiveNotePreview,
    onStopLiveNotePreview,
    sourceKey,
  ]);

  const triggerLiveNotePreview = (pitch: number, velocity = 100) => {
    if (
      isActive &&
      !isTimelinePlaying &&
      isLiveNotePreviewEnabled &&
      liveNotePreviewSelection
    ) {
      onPrepareLiveNotePreview(liveNotePreviewSelection);
      onTriggerLiveNotePreview(pitch, velocity);
    }
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const updateRowHeight = () => {
      if (viewport.clientHeight <= 0) {
        return;
      }

      const nextRowHeight = getPianoRollRowHeight(viewport.clientHeight);
      setRowHeight((currentRowHeight) =>
        Math.abs(currentRowHeight - nextRowHeight) < 0.01
          ? currentRowHeight
          : nextRowHeight,
      );
    };

    updateRowHeight();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver(updateRowHeight);
    resizeObserver.observe(viewport);

    return () => resizeObserver.disconnect();
  }, [isActive]);

  useEffect(() => {
    if (!isActive || hasInitializedViewportRef.current) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      const initialNotes = plan.midi.notes;

      if (
        !viewport ||
        viewport.clientHeight <= 0 ||
        viewport.clientWidth <= 0
      ) {
        return;
      }

      const pitches =
        initialNotes.length > 0
          ? initialNotes.map((note) => note.pitch)
          : [60];
      const centerPitch =
        (Math.min(...pitches) + Math.max(...pitches)) / 2;
      const firstStartTick =
        initialNotes.length > 0
          ? Math.min(...initialNotes.map((note) => note.startTick))
          : 0;
      viewport.scrollTop = Math.max(
        0,
        midiPitchToPianoRollY(Math.round(centerPitch), rowHeight) -
          viewport.clientHeight / 2 +
          rowHeight / 2,
      );
      syncKeyboardScroll(viewport.scrollTop);
      viewport.scrollLeft =
        isTimelineLinked && isTimelinePlaying && linkedPlayhead
          ? getPianoRollLinkedPageScrollLeft({
              contentWidth,
              currentScrollLeft: viewport.scrollLeft,
              keyboardWidth: 0,
              playheadX: linkedPlayhead.x,
              viewportWidth: viewport.clientWidth,
            })
          : Math.max(
              0,
              midiTickToPianoRollX(firstStartTick, ticksPerQuarter) -
                PIANO_ROLL_QUARTER_WIDTH_PX,
            );
      hasInitializedViewportRef.current = true;
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    contentWidth,
    isActive,
    isTimelineLinked,
    isTimelinePlaying,
    linkedPlayhead,
    plan.midi.notes,
    rowHeight,
    sourceKey,
    ticksPerQuarter,
  ]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;

    if (
      !isActive ||
      !isTimelineLinked ||
      !isTimelinePlaying ||
      !linkedPlayhead ||
      !viewport ||
      viewport.clientWidth <= 0
    ) {
      return;
    }

    const nextScrollLeft = getPianoRollLinkedPageScrollLeft({
      contentWidth,
      currentScrollLeft: viewport.scrollLeft,
      keyboardWidth: 0,
      playheadX: linkedPlayhead.x,
      viewportWidth: viewport.clientWidth,
    });

    if (Math.abs(viewport.scrollLeft - nextScrollLeft) > 0.5) {
      viewport.scrollLeft = nextScrollLeft;
    }
  }, [
    contentWidth,
    isActive,
    isTimelineLinked,
    isTimelinePlaying,
    linkedPlayhead,
  ]);

  const createSessionWithNotes = (
    nextNotes: readonly MidiNote[],
    history: Pick<PianoRollEditSession, 'future' | 'past'>,
  ): PianoRollEditSession => {
    const contentHash = createMidiContentHash({
      bpm: plan.midi.bpm,
      notes: nextNotes,
      ticksPerQuarter,
    });

    return {
      clipId: plan.source.clipId,
      contentHash,
      future: history.future,
      notes: nextNotes,
      past: history.past,
      pendingSaveHash: contentHash,
      pendingSourceChange:
        plan.source.sourceType === 'job' || isSourceShared ? 'auto-copy' : undefined,
      sourceKey,
    };
  };

  const saveSession = (nextSession: PianoRollEditSession) => {
    onSessionChange(nextSession);
    onSaveNotes(plan.source.clipId, nextSession.notes);
  };

  const commitNotes = (
    nextNotes: readonly MidiNote[],
    previousNotes: readonly MidiNote[] = editSession.notes,
  ) => {
    const contentHash = createMidiContentHash({
      bpm: plan.midi.bpm,
      notes: nextNotes,
      ticksPerQuarter,
    });

    if (contentHash === editSession.contentHash) {
      return;
    }

    saveSession(
      createSessionWithNotes(nextNotes, {
        future: [],
        past: [...editSession.past, previousNotes].slice(
          -PIANO_ROLL_HISTORY_LIMIT,
        ),
      }),
    );
  };

  const undo = () => {
    const previousNotes = editSession.past[editSession.past.length - 1];

    if (!previousNotes) {
      return;
    }

    saveSession(
      createSessionWithNotes(previousNotes, {
        future: [editSession.notes, ...editSession.future].slice(
          0,
          PIANO_ROLL_HISTORY_LIMIT,
        ),
        past: editSession.past.slice(0, -1),
      }),
    );
  };

  const redo = () => {
    const nextNotes = editSession.future[0];

    if (!nextNotes) {
      return;
    }

    saveSession(
      createSessionWithNotes(nextNotes, {
        future: editSession.future.slice(1),
        past: [...editSession.past, editSession.notes].slice(
          -PIANO_ROLL_HISTORY_LIMIT,
        ),
      }),
    );
  };

  const handleHistoryShortcut = (
    event: ReactKeyboardEvent<HTMLElement>,
  ) => {
    const command = resolvePianoRollHistoryShortcut(event);

    if (!command) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (command === 'undo') {
      undo();
      return;
    }

    redo();
  };

  const updateInsertGhost = (note: MidiNote | undefined) => {
    insertGhostNoteRef.current = note;
    setInsertGhostNote(note);
  };

  const createContentPointFromClientPosition = (
    clientX: number,
    clientY: number,
  ): Readonly<{ x: number; y: number }> | undefined => {
    const noteGrid = noteGridRef.current;

    if (!noteGrid) {
      return undefined;
    }

    const rect = noteGrid.getBoundingClientRect();

    return {
      x: Math.min(Math.max(0, clientX - rect.left), contentWidth),
      y: Math.min(
        Math.max(0, clientY - rect.top),
        pitchSurfaceHeight,
      ),
    };
  };

  const createCursorFromClientPosition = (
    clientX: number,
    clientY: number,
  ): PianoRollInsertCursor | undefined => {
    const contentPoint = createContentPointFromClientPosition(clientX, clientY);

    if (!contentPoint) {
      return undefined;
    }

    return {
      lengthTicks: gridStepTicks,
      pitch: pianoRollYToMidiPitch(contentPoint.y, rowHeight),
      startTick: snapMidiTick(
        pianoRollXToMidiTick(contentPoint.x, ticksPerQuarter),
        gridStepTicks,
      ),
      velocity: 100,
    };
  };

  const isClientPositionInsideNoteGrid = (
    clientX: number,
    clientY: number,
  ): boolean => {
    const rect = noteGridRef.current?.getBoundingClientRect();

    return Boolean(
      rect &&
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom,
    );
  };

  const createCursorFromViewport = (): PianoRollInsertCursor => {
    const viewport = viewportRef.current;
    const contentX = Math.max(
      0,
      (viewport?.scrollLeft ?? 0) + PIANO_ROLL_QUARTER_WIDTH_PX,
    );
    const contentY = Math.max(
      0,
      (viewport?.scrollTop ?? 0) + (viewport?.clientHeight ?? 0) / 2,
    );

    return {
      lengthTicks: gridStepTicks,
      pitch: pianoRollYToMidiPitch(contentY, rowHeight),
      startTick: snapMidiTick(
        pianoRollXToMidiTick(contentX, ticksPerQuarter),
        gridStepTicks,
      ),
      velocity: 100,
    };
  };

  const createGhostForCursor = (
    cursor: PianoRollInsertCursor,
    originalNotes: readonly MidiNote[],
    noteId = insertGhostNoteRef.current?.id ??
      createUniquePianoRollNoteId(originalNotes),
  ): MidiNote | undefined => {
    if (hasMidiNoteAtPosition(originalNotes, cursor)) {
      return undefined;
    }

    return {
      id: noteId,
      lengthTicks: cursor.lengthTicks,
      pitch: cursor.pitch,
      startTick: cursor.startTick,
      velocity: cursor.velocity,
    };
  };

  const focusNoteAfterRender = (noteId: string) => {
    pendingFocusNoteIdRef.current = noteId;
    setSelectedNoteId(noteId);
    setSelectedNoteIds([noteId]);
  };

  const selectNoteAtCursor = (
    cursor: PianoRollInsertCursor,
    originalNotes: readonly MidiNote[],
  ) => {
    const existingNote = originalNotes.find(
      (note) =>
        note.pitch === cursor.pitch && note.startTick === cursor.startTick,
    );

    if (existingNote) {
      focusNoteAfterRender(existingNote.id);
    }

    updateInsertGhost(undefined);
  };

  const commitInsert = (
    cursor: PianoRollInsertCursor,
    originalNotes: readonly MidiNote[],
    noteId = insertGhostNoteRef.current?.id ??
      createUniquePianoRollNoteId(originalNotes),
  ) => {
    if (hasMidiNoteAtPosition(originalNotes, cursor)) {
      selectNoteAtCursor(cursor, originalNotes);
      return;
    }

    const insertedNote: MidiNote = {
      id: noteId,
      lengthTicks: cursor.lengthTicks,
      pitch: cursor.pitch,
      startTick: cursor.startTick,
      velocity: cursor.velocity,
    };
    const nextNotes = addMidiNote(originalNotes, insertedNote, {
      gridStepTicks,
    });

    setInsertCursor(cursor);
    setIsGridHoverActive(false);
    updateInsertGhost(undefined);
    focusNoteAfterRender(insertedNote.id);
    commitNotes(nextNotes, originalNotes);
    triggerLiveNotePreview(insertedNote.pitch, insertedNote.velocity);
  };

  const toggleNoteSelection = (noteId: string) => {
    const nextSelectedNoteIds = togglePianoRollNoteSelection(
      activeSelectedNoteIds,
      noteId,
    );

    setSelectedNoteIds(nextSelectedNoteIds);
    setSelectedNoteId(
      nextSelectedNoteIds.includes(noteId)
        ? noteId
        : nextSelectedNoteIds[0],
    );
  };

  const beginPointerInteraction = (
    event: ReactPointerEvent<HTMLElement>,
    note: MidiNote,
    mode: PianoRollInteractionMode = 'move',
  ) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }

    const noteButton =
      event.currentTarget instanceof HTMLButtonElement
        ? event.currentTarget
        : event.currentTarget.closest('button');

    if (!(noteButton instanceof HTMLButtonElement)) {
      return;
    }

    const captureTarget = viewportRef.current;

    if (!captureTarget) {
      return;
    }

    if (event.ctrlKey) {
      event.preventDefault();
      setIsGridHoverActive(false);
      noteButton.focus();
      toggleNoteSelection(note.id);
      return;
    }

    const interactionSelectedNoteIds =
      selectedNoteIdSet.has(note.id) && activeSelectedNoteIds.length > 0
        ? activeSelectedNoteIds
        : [note.id];

    event.preventDefault();
    setIsGridHoverActive(false);
    noteButton.focus();
    captureTarget.setPointerCapture(event.pointerId);
    pointerSessionRef.current = {
      captureTarget,
      didDrag: false,
      kind: 'note',
      mode,
      noteId: note.id,
      originalNote: note,
      originalNotes: notes,
      pointerId: event.pointerId,
      selectedNoteIds: interactionSelectedNoteIds,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    setSelectedNoteId(note.id);
    setSelectedNoteIds(interactionSelectedNoteIds);
  };

  const beginViewportModifierInteraction = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (
      !event.altKey ||
      event.button !== 0 ||
      !event.isPrimary ||
      pointerSessionRef.current
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setIsGridHoverActive(false);
    setIsHandScrolling(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerSessionRef.current = {
      captureTarget: event.currentTarget,
      kind: 'pan',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: event.currentTarget.scrollLeft,
      startScrollTop: event.currentTarget.scrollTop,
    };
  };

  const beginGridPointerInteraction = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (
      event.target !== event.currentTarget ||
      event.button !== 0 ||
      !event.isPrimary
    ) {
      return;
    }

    if (event.ctrlKey) {
      const contentPoint = createContentPointFromClientPosition(
        event.clientX,
        event.clientY,
      );
      const captureTarget = viewportRef.current;

      if (!contentPoint || !captureTarget) {
        return;
      }

      event.preventDefault();
      event.currentTarget.focus();
      setSelectedNoteId(undefined);
      setSelectedNoteIds([]);
      setInsertCursor(undefined);
      setIsGridHoverActive(false);
      setMarqueeRect(
        createPianoRollMarqueeRect(
          contentPoint.x,
          contentPoint.y,
          contentPoint.x,
          contentPoint.y,
        ),
      );
      captureTarget.setPointerCapture(event.pointerId);
      pointerSessionRef.current = {
        anchorX: contentPoint.x,
        anchorY: contentPoint.y,
        captureTarget,
        currentSelectedNoteIds: [],
        isAdditive: event.shiftKey,
        kind: 'marquee',
        originalSelectedNoteIds: activeSelectedNoteIds,
        pointerId: event.pointerId,
      };
      return;
    }

    const cursor = createCursorFromClientPosition(
      event.clientX,
      event.clientY,
    );

    if (!cursor) {
      return;
    }

    event.preventDefault();
    event.currentTarget.focus();
    setSelectedNoteId(undefined);
    setSelectedNoteIds([]);
    setInsertCursor(cursor);
    setIsGridHoverActive(false);

    if (hasMidiNoteAtPosition(editSession.notes, cursor)) {
      selectNoteAtCursor(cursor, editSession.notes);
      return;
    }

    const captureTarget = viewportRef.current;

    if (!captureTarget) {
      return;
    }

    const noteId = createUniquePianoRollNoteId(editSession.notes);
    const ghost = createGhostForCursor(cursor, editSession.notes, noteId);

    if (!ghost) {
      selectNoteAtCursor(cursor, editSession.notes);
      return;
    }

    captureTarget.setPointerCapture(event.pointerId);
    pointerSessionRef.current = {
      captureTarget,
      kind: 'insert',
      noteId,
      originalNotes: editSession.notes,
      pitch: cursor.pitch,
      pointerId: event.pointerId,
      startTick: cursor.startTick,
    };
    updateInsertGhost(ghost);
  };

  const updateHoverCursor = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const target = event.target instanceof Element ? event.target : undefined;

    if (
      event.buttons !== 0 ||
      target?.closest('[data-note-id]') ||
      !isClientPositionInsideNoteGrid(event.clientX, event.clientY)
    ) {
      setIsGridHoverActive(false);
      return;
    }

    const cursor = createCursorFromClientPosition(
      event.clientX,
      event.clientY,
    );

    if (!cursor) {
      setIsGridHoverActive(false);
      return;
    }

    setInsertCursor((currentCursor) =>
      currentCursor &&
      currentCursor.lengthTicks === cursor.lengthTicks &&
      currentCursor.pitch === cursor.pitch &&
      currentCursor.startTick === cursor.startTick &&
      currentCursor.velocity === cursor.velocity
        ? currentCursor
        : cursor,
    );
    setIsGridHoverActive(true);
  };

  const updatePointerInteraction = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const session = pointerSessionRef.current;

    if (!session) {
      updateHoverCursor(event);
      return;
    }

    if (session.pointerId !== event.pointerId) {
      return;
    }

    if (session.kind === 'pan') {
      const viewport = session.captureTarget;

      viewport.scrollLeft =
        session.startScrollLeft - (event.clientX - session.startClientX);
      viewport.scrollTop =
        session.startScrollTop - (event.clientY - session.startClientY);
      syncKeyboardScroll(viewport.scrollTop);
      return;
    }

    if (session.kind === 'marquee') {
      const contentPoint = createContentPointFromClientPosition(
        event.clientX,
        event.clientY,
      );

      if (!contentPoint) {
        return;
      }

      const nextMarqueeRect = createPianoRollMarqueeRect(
        session.anchorX,
        session.anchorY,
        contentPoint.x,
        contentPoint.y,
      );
      const intersectingNoteIds = getPianoRollNoteIdsInMarquee(
        editSession.notes,
        nextMarqueeRect,
        ticksPerQuarter,
        rowHeight,
      );
      const nextSelectedNoteIds = resolvePianoRollMarqueeSelection(
        session.originalSelectedNoteIds,
        intersectingNoteIds,
        session.isAdditive,
      );

      session.currentSelectedNoteIds = nextSelectedNoteIds;
      setMarqueeRect(nextMarqueeRect);
      setSelectedNoteIds(nextSelectedNoteIds);
      setSelectedNoteId(nextSelectedNoteIds[0]);
      return;
    }

    if (session.kind === 'insert') {
      const currentCursor = createCursorFromClientPosition(
        event.clientX,
        event.clientY,
      );

      if (!currentCursor) {
        return;
      }

      const lengthTicks = getPianoRollDirectDrawLengthTicks(
        session.startTick,
        currentCursor.startTick,
        gridStepTicks,
      );
      const cursor: PianoRollInsertCursor = {
        lengthTicks,
        pitch: session.pitch,
        startTick: session.startTick,
        velocity: 100,
      };
      const ghost = createGhostForCursor(
        cursor,
        session.originalNotes,
        session.noteId,
      );

      setInsertCursor(cursor);
      updateInsertGhost(ghost);
      return;
    }

    const deltaX = event.clientX - session.startClientX;
    const deltaY = event.clientY - session.startClientY;

    if (
      !session.didDrag &&
      Math.hypot(deltaX, deltaY) < POINTER_DRAG_THRESHOLD_PX
    ) {
      return;
    }

    if (!session.didDrag) {
      session.didDrag = true;
      setActiveGestureNoteId(session.noteId);
    }

    const deltaTicks = pianoRollPixelDeltaToTicks(
      deltaX,
      ticksPerQuarter,
    );

    if (session.mode === 'resize') {
      const nextNotes =
        session.selectedNoteIds.length > 1
          ? resizeMidiNoteEndsBy(
              session.originalNotes,
              session.selectedNoteIds,
              deltaTicks,
              { gridStepTicks },
            )
          : resizeMidiNoteEnd(
              session.originalNotes,
              session.noteId,
              session.originalNote.startTick +
                session.originalNote.lengthTicks +
                deltaTicks,
              { gridStepTicks },
            );
      previewNotesRef.current = nextNotes;
      setPreviewNotes(nextNotes);
      return;
    }

    const deltaPitch = pianoRollPixelDeltaToSemitones(deltaY, rowHeight);
    const nextNotes =
      session.selectedNoteIds.length > 1
        ? moveMidiNotesBy(
            session.originalNotes,
            session.selectedNoteIds,
            {
              pitchDelta: deltaPitch,
              tickDelta: deltaTicks,
            },
            { gridStepTicks },
          )
        : moveMidiNote(
            session.originalNotes,
            session.noteId,
            {
              pitch: session.originalNote.pitch + deltaPitch,
              startTick: session.originalNote.startTick + deltaTicks,
            },
            { gridStepTicks },
          );
    previewNotesRef.current = nextNotes;
    setPreviewNotes(nextNotes);
  };

  const finishPointerInteraction = (pointerId: number) => {
    const session = pointerSessionRef.current;

    if (!session || session.pointerId !== pointerId) {
      return;
    }

    pointerSessionRef.current = undefined;

    if (session.captureTarget.hasPointerCapture(pointerId)) {
      session.captureTarget.releasePointerCapture(pointerId);
    }

    if (session.kind === 'pan') {
      setIsHandScrolling(false);
      return;
    }

    if (session.kind === 'marquee') {
      setMarqueeRect(undefined);
      const primaryNoteId = session.currentSelectedNoteIds[0];

      if (primaryNoteId) {
        window.requestAnimationFrame(() => {
          const primaryNoteButton = noteGridRef.current?.querySelector<
            HTMLButtonElement
          >(`[data-note-id="${CSS.escape(primaryNoteId)}"]`);
          primaryNoteButton?.focus();
        });
      }
      return;
    }

    if (session.kind === 'insert') {
      const ghost = insertGhostNoteRef.current;

      if (ghost) {
        commitInsert(
          {
            lengthTicks: ghost.lengthTicks,
            pitch: ghost.pitch,
            startTick: ghost.startTick,
            velocity: ghost.velocity,
          },
          session.originalNotes,
          session.noteId,
        );
      } else {
        updateInsertGhost(undefined);
      }
      return;
    }

    setActiveGestureNoteId(undefined);
    const nextNotes = previewNotesRef.current;
    previewNotesRef.current = undefined;
    setPreviewNotes(undefined);

    if (session.didDrag && nextNotes) {
      commitNotes(nextNotes, session.originalNotes);
      const movedNote = nextNotes.find((note) => note.id === session.noteId);

      if (movedNote && movedNote.pitch !== session.originalNote.pitch) {
        triggerLiveNotePreview(movedNote.pitch, movedNote.velocity);
      }
    }
  };

  const cancelPointerInteraction = (pointerId?: number) => {
    const session = pointerSessionRef.current;

    if (!session || (pointerId !== undefined && session.pointerId !== pointerId)) {
      return false;
    }

    pointerSessionRef.current = undefined;
    previewNotesRef.current = undefined;
    setPreviewNotes(undefined);
    setActiveGestureNoteId(undefined);

    if (session.kind === 'pan') {
      setIsHandScrolling(false);
    } else if (session.kind === 'marquee') {
      setMarqueeRect(undefined);
      setSelectedNoteIds(session.originalSelectedNoteIds);
      setSelectedNoteId(session.originalSelectedNoteIds[0]);
    } else if (session.kind === 'insert') {
      setIsGridHoverActive(false);
      updateInsertGhost(undefined);
    }

    if (session.captureTarget.hasPointerCapture(session.pointerId)) {
      session.captureTarget.releasePointerCapture(session.pointerId);
    }

    return true;
  };

  const setCursorPosition = (cursor: PianoRollInsertCursor) => {
    setInsertCursor(cursor);
    setIsGridHoverActive(false);
  };

  const deleteNote = (noteId: string) => {
    const note = editSession.notes.find((candidate) => candidate.id === noteId);

    if (!note) {
      return;
    }

    const noteIdsToDelete =
      selectedNoteIdSet.has(noteId) && activeSelectedNoteIds.length > 0
        ? activeSelectedNoteIds
        : [noteId];

    cancelPointerInteraction();
    setSelectedNoteId(undefined);
    setSelectedNoteIds([]);
    setIsGridHoverActive(false);
    updateInsertGhost(undefined);
    setInsertCursor({
      lengthTicks: gridStepTicks,
      pitch: note.pitch,
      startTick: note.startTick,
      velocity: 100,
    });
    commitNotes(deleteMidiNotes(editSession.notes, noteIdsToDelete));
    window.requestAnimationFrame(() => noteGridRef.current?.focus());
  };

  const clearAllNotes = () => {
    if (editSession.notes.length === 0) {
      return;
    }

    cancelPointerInteraction();
    setSelectedNoteId(undefined);
    setSelectedNoteIds([]);
    setIsGridHoverActive(false);
    updateInsertGhost(undefined);
    setInsertCursor(undefined);
    commitNotes([]);
    window.requestAnimationFrame(() => noteGridRef.current?.focus());
  };

  const handleGridKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.target !== event.currentTarget) {
      return;
    }

    if (event.key === 'Escape') {
      if (!cancelPointerInteraction()) {
        setSelectedNoteId(undefined);
        setSelectedNoteIds([]);
        setInsertCursor(undefined);
      }
      setIsGridHoverActive(false);
      event.preventDefault();
      return;
    }

    if (
      event.key === 'Enter' ||
      event.key === 'Insert' ||
      event.key.toLowerCase() === 'i'
    ) {
      if (!event.repeat) {
        const cursor = insertCursor ?? createCursorFromViewport();
        commitInsert(cursor, editSession.notes);
      }
      event.preventDefault();
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      const selectedNoteIdToDelete = activeSelectedNoteIds[0];

      if (selectedNoteIdToDelete) {
        deleteNote(selectedNoteIdToDelete);
      }
      event.preventDefault();
      return;
    }

    if (
      event.key !== 'ArrowUp' &&
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight'
    ) {
      return;
    }

    event.preventDefault();
    const cursor = insertCursor ?? createCursorFromViewport();
    let nextCursor = cursor;

    if (
      event.shiftKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      nextCursor = {
        ...cursor,
        lengthTicks: Math.max(
          gridStepTicks,
          cursor.lengthTicks + direction * gridStepTicks,
        ),
      };
    } else {
      const pitchDelta =
        event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
      const tickDelta =
        event.key === 'ArrowLeft'
          ? -gridStepTicks
          : event.key === 'ArrowRight'
            ? gridStepTicks
            : 0;
      nextCursor = {
        ...cursor,
        pitch: Math.min(Math.max(cursor.pitch + pitchDelta, 0), 127),
        startTick: Math.max(0, cursor.startTick + tickDelta),
      };
    }

    setSelectedNoteId(undefined);
    setSelectedNoteIds([]);
    setCursorPosition(nextCursor);
  };

  const handleNoteKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    noteId: string,
  ) => {
    if (event.key === 'Escape') {
      if (!cancelPointerInteraction()) {
        setSelectedNoteId(undefined);
        setSelectedNoteIds([]);
        setInsertCursor(undefined);
        window.requestAnimationFrame(() => noteGridRef.current?.focus());
      }
      event.preventDefault();
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      if (event.ctrlKey) {
        toggleNoteSelection(noteId);
      } else {
        if (!selectedNoteIdSet.has(noteId)) {
          setSelectedNoteIds([noteId]);
        }
        setSelectedNoteId(noteId);
      }
      event.preventDefault();
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selectedNoteIdSet.has(noteId)) {
        deleteNote(noteId);
      }
      event.preventDefault();
      return;
    }

    if (
      event.key !== 'ArrowUp' &&
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight'
    ) {
      return;
    }

    event.preventDefault();
    const keyboardSelectedNoteIds =
      selectedNoteIdSet.has(noteId) && activeSelectedNoteIds.length > 0
        ? activeSelectedNoteIds
        : [noteId];
    setSelectedNoteId(noteId);
    setSelectedNoteIds(keyboardSelectedNoteIds);
    const currentNote = editSession.notes.find((note) => note.id === noteId);

    if (!currentNote) {
      return;
    }

    let nextNotes: readonly MidiNote[];

    if (
      event.shiftKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      nextNotes =
        keyboardSelectedNoteIds.length > 1
          ? resizeMidiNoteEndsBy(
              editSession.notes,
              keyboardSelectedNoteIds,
              direction * gridStepTicks,
              { gridStepTicks },
            )
          : resizeMidiNoteEnd(
              editSession.notes,
              noteId,
              currentNote.startTick +
                currentNote.lengthTicks +
                direction * gridStepTicks,
              { gridStepTicks },
            );
    } else {
      const pitchDelta =
        event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
      const tickDelta =
        event.key === 'ArrowLeft'
          ? -gridStepTicks
          : event.key === 'ArrowRight'
            ? gridStepTicks
            : 0;

      nextNotes =
        keyboardSelectedNoteIds.length > 1
          ? moveMidiNotesBy(
              editSession.notes,
              keyboardSelectedNoteIds,
              { pitchDelta, tickDelta },
              { gridStepTicks },
            )
          : moveMidiNote(
              editSession.notes,
              noteId,
              {
                pitch: currentNote.pitch + pitchDelta,
                startTick: currentNote.startTick + tickDelta,
              },
              { gridStepTicks },
            );
    }

    commitNotes(nextNotes);

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const movedNote = nextNotes.find((note) => note.id === noteId);

      if (movedNote && movedNote.pitch !== currentNote.pitch) {
        triggerLiveNotePreview(movedNote.pitch, movedNote.velocity);
      }
    }
  };

  const takeStatus =
    plan.source.sourceType === 'job'
      ? {
          detail: 'SOURCE PROTECTED',
          label: 'GENERATED TAKE',
          value: 'READ ONLY',
        }
      : {
          detail: hasUnsavedProjectChanges
            ? 'PROJECT UNSAVED'
            : 'PROJECT SAVED',
          label: `EDITED TAKE / REV ${plan.source.revision}`,
          value: 'AUTO-SAVED',
        };

  const scrollViewportByOctave = (direction: 'down' | 'up') => {
    const viewport = viewportRef.current;

    if (!viewport || viewport.clientHeight <= 0) {
      return;
    }

    viewport.scrollTop = getPianoRollOctaveScrollTop({
      currentScrollTop: viewport.scrollTop,
      direction,
      rowHeight,
      viewportHeight: viewport.clientHeight,
    });
    syncKeyboardScroll(viewport.scrollTop);
  };

  const scrollViewportFromKeyboard = (
    event: ReactWheelEvent<HTMLDivElement>,
  ) => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    event.preventDefault();
    viewport.scrollTop += event.deltaY;
    viewport.scrollLeft += event.deltaX;
    syncKeyboardScroll(viewport.scrollTop);
  };

  const selectGridDenominator = (
    nextDenominator: PianoRollGridDenominator,
  ) => {
    if (nextDenominator === gridDenominator) {
      return;
    }

    cancelPointerInteraction();
    const nextGridStepTicks = getPianoRollGridStepTicks(
      ticksPerQuarter,
      nextDenominator,
    );

    setGridDenominator(nextDenominator);
    setIsGridHoverActive(false);
    updateInsertGhost(undefined);
    setInsertCursor((currentCursor) =>
      currentCursor
        ? {
            ...currentCursor,
            lengthTicks: nextGridStepTicks,
            startTick: snapMidiTick(
              currentCursor.startTick,
              nextGridStepTicks,
            ),
          }
        : undefined,
    );
  };

  const noteModuleState = selectedNote ? 'selected' : 'cursor';
  const noteReadout =
    selectedNotes.length > 1 && selectedNote
      ? `${selectedNotes.length} NOTES / ${getMidiNoteName(selectedNote.pitch)} / ST ${selectedNote.startTick} / LEN ${selectedNote.lengthTicks}`
      : selectedNote
        ? `${getMidiNoteName(selectedNote.pitch)} / ST ${selectedNote.startTick} / LEN ${selectedNote.lengthTicks} / VEL ${selectedNote.velocity}`
        : insertCursor
          ? `${getMidiNoteName(insertCursor.pitch)} / ST ${insertCursor.startTick} / LEN ${insertCursor.lengthTicks / gridStepTicks}/${gridDenominator} / VEL ${insertCursor.velocity}`
          : 'HOVER GRID TO INSERT';
  const cursorRect =
    insertCursor &&
    !insertGhostNote &&
    !marqueeRect &&
    !isHandScrolling &&
    (isGridHoverActive || isGridKeyboardFocused)
      ? createPianoRollNoteRect(
          {
            id: 'piano-roll-insert-cursor',
            lengthTicks: insertCursor.lengthTicks,
            pitch: insertCursor.pitch,
            startTick: insertCursor.startTick,
            velocity: insertCursor.velocity,
          },
          ticksPerQuarter,
          rowHeight,
        )
      : undefined;
  const ghostRect = insertGhostNote
    ? createPianoRollNoteRect(insertGhostNote, ticksPerQuarter, rowHeight)
    : undefined;

  return (
    <div
      className={`top-dock-pane ${isActive ? 'active' : ''}`}
      data-piano-roll-source={sourceKey}
      hidden={!isActive}
    >
      <section
        className="piano-roll-spike panel"
        aria-labelledby="piano-roll-spike-heading"
        onKeyDownCapture={handleHistoryShortcut}
      >
        <header className="piano-roll-spike-header">
          <div className="piano-roll-spike-title">
            <span>D02 / MIDI</span>
            <h2 id="piano-roll-spike-heading">Piano Roll</h2>
          </div>
          <div className="piano-roll-spike-source" title={plan.source.clipTakeId}>
            <span>SRC</span>
            <strong>{clipName}</strong>
            <small>
              {plan.source.label} • {notes.length} NOTES • SNAP 1/
              {gridDenominator}
            </small>
          </div>
          <div className="piano-roll-spike-local-status">
            <span>{takeStatus.label}</span>
            <div className="piano-roll-spike-status-row">
              <strong>{takeStatus.value}</strong>
              <small>{takeStatus.detail}</small>
            </div>
          </div>
          <div
            className="piano-roll-spike-actions"
            aria-label="Piano Roll edit actions"
          >
            <button
              type="button"
              disabled={editSession.past.length === 0}
              onClick={undo}
              title="Undo the last Piano Roll note edit"
              aria-keyshortcuts="Control+Z Meta+Z"
            >
              UNDO
            </button>
            <button
              type="button"
              disabled={editSession.future.length === 0}
              onClick={redo}
              title="Redo the last Piano Roll note edit"
              aria-keyshortcuts="Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z"
            >
              REDO
            </button>
            <button
              type="button"
              className="piano-roll-clear-all-button"
              disabled={editSession.notes.length === 0}
              onClick={clearAllNotes}
              title="Clear all Piano Roll notes. Use Undo to restore them."
            >
              CLEAR ALL
            </button>
            <button
              type="button"
              onClick={() => onCreateNewTake(editSession.notes)}
              title="Save the current notes as another MIDI Take"
            >
              NEW TAKE
            </button>
            <button
              type="button"
              disabled={!liveNotePreviewResource}
              aria-pressed={isLiveNotePreviewEnabled}
              onClick={() => {
                setIsLiveNotePreviewEnabled((currentValue) => {
                  if (currentValue) {
                    onStopLiveNotePreview();
                  }
                  return !currentValue;
                });
              }}
              title={
                pianoRollLiveNotePreviewState.status === 'ERROR' ||
                pianoRollLiveNotePreviewState.status === 'PREPARING'
                  ? pianoRollLiveNotePreviewState.message
                  : 'Play the selected SoundFont when notes are placed, selected, or transposed'
              }
            >
              {pianoRollLiveNotePreviewState.status === 'PREPARING'
                ? 'PREVIEW...'
                : isLiveNotePreviewEnabled
                  ? 'PREVIEW ON'
                  : 'PREVIEW OFF'}
            </button>
            <PianoRollSoundFontControl
              assignment={soundFontAssignment}
              catalogState={soundFontCatalogState}
              clipName={clipName}
              onAssign={onAssignSoundFont}
              onListSoundFontPresets={onListSoundFontPresets}
              onRefresh={onRefreshSoundFonts}
            />
          </div>
          <div
            className={`piano-roll-note-module ${noteModuleState}`}
            aria-label="Piano Roll contextual note controls"
          >
            <output
              className="piano-roll-spike-readout"
              aria-live="polite"
              aria-label="Piano Roll note readout"
            >
              {noteReadout}
            </output>
            <label className="piano-roll-grid-control">
              <span>GRID</span>
              <select
                value={gridDenominator}
                onChange={(event) => {
                  const nextDenominator =
                    PIANO_ROLL_GRID_DENOMINATORS.find(
                      (denominator) =>
                        denominator === Number(event.currentTarget.value),
                    );

                  if (nextDenominator !== undefined) {
                    selectGridDenominator(nextDenominator);
                  }
                }}
                aria-label="Piano Roll grid resolution"
                title="Select the Piano Roll note grid resolution"
              >
                {PIANO_ROLL_GRID_DENOMINATORS.map((denominator) => (
                  <option key={denominator} value={denominator}>
                    1/{denominator}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>
        <div className="piano-roll-spike-workspace">
          <aside
            className="piano-roll-function-rail"
            aria-label="Piano Roll function controls"
          >
            <div className="piano-roll-function-heading" aria-hidden="true">
              <span>FUNCTION</span>
              <strong>VIEW</strong>
            </div>
            <button
              type="button"
              className={`piano-roll-function-button piano-roll-link-toggle ${
                isTimelineLinked ? 'active' : ''
              }`}
              aria-label={`Timeline link ${
                isTimelineLinked ? 'on' : 'off'
              }`}
              aria-pressed={isTimelineLinked}
              onClick={() => onTimelineLinkChange(!isTimelineLinked)}
              title="Link the Piano Roll playhead to the Timeline without sharing zoom"
            >
              <span className="piano-roll-function-glyph" aria-hidden="true">
                &lt;&gt;
              </span>
              <strong>LINK</strong>
              <small>{isTimelineLinked ? 'ON' : 'OFF'}</small>
            </button>
            <button
              type="button"
              className="piano-roll-function-button"
              aria-label="Scroll Piano Roll up one octave"
              onClick={() => scrollViewportByOctave('up')}
              title="Move the Piano Roll view up by 12 semitones"
            >
              <span className="piano-roll-function-glyph" aria-hidden="true">
                ▲
              </span>
              <strong>OCT UP</strong>
              <small>+12</small>
            </button>
            <button
              type="button"
              className="piano-roll-function-button"
              aria-label="Scroll Piano Roll down one octave"
              onClick={() => scrollViewportByOctave('down')}
              title="Move the Piano Roll view down by 12 semitones"
            >
              <span className="piano-roll-function-glyph" aria-hidden="true">
                ▼
              </span>
              <strong>OCT DOWN</strong>
              <small>-12</small>
            </button>
          </aside>
          <div className="piano-roll-editor">
            <div
              className="piano-roll-keyboard-viewport"
              aria-hidden="true"
              onWheel={scrollViewportFromKeyboard}
            >
              <div
                ref={keyboardRef}
                className="piano-roll-keyboard"
                style={keyboardStyle}
              >
                {MIDI_PITCHES_DESCENDING.map((pitch) => (
                  <div
                    key={pitch}
                    className={`piano-roll-key ${
                      isBlackMidiPitch(pitch) ? 'black' : 'white'
                    } ${pitch % 12 === 0 ? 'octave' : ''}`}
                  >
                    {pitch % 12 === 0 ? (
                      <span>{getMidiNoteName(pitch)}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            <div
              ref={viewportRef}
              className={`piano-roll-spike-viewport ${
                isHandScrolling ? 'hand-scrolling' : ''
              }`}
              aria-label="Piano Roll note grid. Alt drag to scroll. Control click a note to toggle selection. Control drag empty grid to replace selection. Control Shift drag to add notes."
              onLostPointerCapture={(event) =>
                cancelPointerInteraction(event.pointerId)
              }
              onPointerCancel={(event) =>
                cancelPointerInteraction(event.pointerId)
              }
              onPointerLeave={() => setIsGridHoverActive(false)}
              onPointerMove={updatePointerInteraction}
              onPointerDownCapture={beginViewportModifierInteraction}
              onPointerUp={(event) =>
                finishPointerInteraction(event.pointerId)
              }
              onScroll={(event) =>
                syncKeyboardScroll(event.currentTarget.scrollTop)
              }
            >
              <div className="piano-roll-spike-surface" style={surfaceStyle}>
                <div
                  ref={noteGridRef}
                  className="piano-roll-note-grid"
                  role="group"
                  tabIndex={0}
                  aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Enter I Insert Escape"
                  aria-label={`${clipName} Active MIDI Take, ${notes.length} notes, Clip end tick ${clipLengthTicks}`}
                  onBlur={(event) => {
                    if (event.target === event.currentTarget) {
                      setIsGridKeyboardFocused(false);
                    }
                  }}
                  onContextMenu={(event) => event.preventDefault()}
                  onFocus={(event) => {
                    if (event.target === event.currentTarget) {
                      setIsGridKeyboardFocused(true);
                    }
                  }}
                  onKeyDown={handleGridKeyDown}
                  onPointerDown={beginGridPointerInteraction}
                >
                  {MIDI_PITCHES_DESCENDING.map((pitch) => (
                    <span
                      key={pitch}
                      className={`piano-roll-pitch-lane ${
                        isBlackMidiPitch(pitch) ? 'black' : 'white'
                      } ${pitch % 12 === 0 ? 'octave' : ''}`}
                      style={{
                        top: `${midiPitchToPianoRollY(pitch, rowHeight)}px`,
                      }}
                      aria-hidden="true"
                    />
                  ))}
                  <div
                    className="piano-roll-clip-end-marker"
                    style={{ left: `${clipEndX}px` }}
                    aria-hidden="true"
                  >
                    <span>CLIP END</span>
                  </div>
                  {isTimelineLinked && linkedPlayhead ? (
                    <div
                      className="piano-roll-linked-playhead"
                      style={{ left: `${linkedPlayhead.x}px` }}
                      aria-hidden="true"
                    >
                      <span>PLAY</span>
                    </div>
                  ) : null}
                  {cursorRect ? (
                    <div
                      className="piano-roll-insert-cursor"
                      style={{
                        height: `${cursorRect.height}px`,
                        left: `${cursorRect.left}px`,
                        top: `${cursorRect.top}px`,
                        width: `${cursorRect.width}px`,
                      }}
                      aria-hidden="true"
                    />
                  ) : null}
                  {insertGhostNote && ghostRect ? (
                    <div
                      className="piano-roll-insert-ghost"
                      style={{
                        height: `${ghostRect.height}px`,
                        left: `${ghostRect.left}px`,
                        top: `${ghostRect.top}px`,
                        width: `${ghostRect.width}px`,
                      }}
                      aria-hidden="true"
                    >
                      <span>{getMidiNoteName(insertGhostNote.pitch)}</span>
                    </div>
                  ) : null}
                  {marqueeRect ? (
                    <div
                      className="piano-roll-selection-marquee"
                      style={{
                        height: `${marqueeRect.height}px`,
                        left: `${marqueeRect.left}px`,
                        top: `${marqueeRect.top}px`,
                        width: `${marqueeRect.width}px`,
                      }}
                      aria-hidden="true"
                    />
                  ) : null}
                  {notes.map((note) => {
                    const rect = createPianoRollNoteRect(
                      note,
                      ticksPerQuarter,
                      rowHeight,
                    );
                    const isSelected = selectedNoteIdSet.has(note.id);
                    const isGestureActive =
                      activeGestureNoteId !== undefined && isSelected;
                    const noteName = getMidiNoteName(note.pitch);

                    return (
                      <button
                        key={note.id}
                        type="button"
                        className={`piano-roll-note ${
                          isSelected ? 'selected' : ''
                        } ${isGestureActive ? 'gesture-active' : ''}`}
                        style={{
                          height: `${rect.height}px`,
                          left: `${rect.left}px`,
                          top: `${rect.top}px`,
                          width: `${rect.width}px`,
                        }}
                        aria-label={`${noteName}, pitch ${note.pitch}, start tick ${note.startTick}, duration ${note.lengthTicks} ticks`}
                        aria-pressed={isSelected}
                        aria-keyshortcuts="Control+Enter Control+Space ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Delete Backspace Escape"
                        data-note-id={note.id}
                        title={`${noteName} · ST ${note.startTick} · LEN ${note.lengthTicks} · ${
                          isSelected && selectedNotes.length > 1
                            ? 'RIGHT CLICK DELETE SELECTION'
                            : 'RIGHT CLICK DELETE'
                        }`}
                        onContextMenu={(event) => {
                          if (event.button !== 2) {
                            return;
                          }

                          event.preventDefault();
                          deleteNote(note.id);
                        }}
                        onKeyDown={(event) => handleNoteKeyDown(event, note.id)}
                        onPointerDown={(event) => {
                          triggerLiveNotePreview(note.pitch, note.velocity);
                          const mode =
                            event.target instanceof Element &&
                            event.target.closest(
                              '[data-piano-roll-resize-handle]',
                            )
                              ? 'resize'
                              : 'move';
                          beginPointerInteraction(event, note, mode);
                        }}
                      >
                        <span
                          className="piano-roll-note-label"
                          aria-hidden="true"
                        >
                          {noteName}
                        </span>
                        <span
                          className="piano-roll-resize-handle"
                          data-piano-roll-resize-handle
                          aria-hidden="true"
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function PianoRollMessage({
  actionLabel,
  isActive,
  message,
  onAction,
  status,
}: {
  actionLabel?: string;
  isActive: boolean;
  message: string;
  onAction?: () => void;
  status: string;
}) {
  return (
    <div
      className={`top-dock-pane ${isActive ? 'active' : ''}`}
      hidden={!isActive}
    >
      <section
        className="piano-roll-spike piano-roll-spike-empty panel"
        aria-labelledby="piano-roll-spike-heading"
      >
        <header className="piano-roll-spike-header">
          <div className="piano-roll-spike-title">
            <span>D02 / MIDI</span>
            <h2 id="piano-roll-spike-heading">Piano Roll</h2>
          </div>
          <div className="piano-roll-spike-local-status">
            <span>TAKE STATUS</span>
            <strong>NO ACTIVE TAKE</strong>
          </div>
        </header>
        <div className="piano-roll-spike-empty-display">
          <span className="piano-roll-spike-empty-led" aria-hidden="true" />
          <div>
            <div role="status">
              <strong>{status}</strong>
              <p>{message}</p>
            </div>
            {actionLabel && onAction ? (
              <button
                type="button"
                className="piano-roll-spike-empty-action"
                onClick={onAction}
              >
                {actionLabel}
              </button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function createUniquePianoRollNoteId(
  notes: readonly MidiNote[],
): string {
  const existingIds = new Set(notes.map((note) => note.id));
  let noteId: string;

  do {
    const uniquePart =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2)}`;
    noteId = `manual-note-${uniquePart}`;
  } while (existingIds.has(noteId));

  return noteId;
}

function createInitialPianoRollEditSession(
  plan: ActiveMidiTakePlan,
  sourceKey: string,
): PianoRollEditSession {
  return {
    clipId: plan.source.clipId,
    contentHash: plan.source.contentHash,
    future: [],
    notes: plan.midi.notes,
    past: [],
    sourceKey,
  };
}

function reconcilePianoRollEditSession(
  storedSession: PianoRollEditSession | undefined,
  plan: ActiveMidiTakePlan,
  sourceKey: string,
): PianoRollEditSession {
  if (!storedSession) {
    return createInitialPianoRollEditSession(plan, sourceKey);
  }

  if (storedSession.sourceKey === sourceKey) {
    if (storedSession.contentHash === plan.source.contentHash) {
      if (
        storedSession.pendingSaveHash === undefined &&
        storedSession.pendingSourceChange === undefined
      ) {
        return storedSession;
      }

      return {
        ...storedSession,
        pendingSaveHash: undefined,
        pendingSourceChange: undefined,
      };
    }

    if (storedSession.pendingSaveHash === storedSession.contentHash) {
      return storedSession;
    }

    return createInitialPianoRollEditSession(plan, sourceKey);
  }

  if (
    storedSession.pendingSourceChange === 'auto-copy' &&
    storedSession.contentHash === plan.source.contentHash
  ) {
    return {
      ...storedSession,
      pendingSaveHash: undefined,
      sourceKey,
    };
  }

  return createInitialPianoRollEditSession(plan, sourceKey);
}
